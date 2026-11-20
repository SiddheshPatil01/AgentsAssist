'use strict';
/*
 * Reads Claude Code's own files under ~/.claude (read-only, never writes there) and turns them into
 * a snapshot of tasks (sessions) and their agents.
 *
 *   sessions/<pid>.json                                   one per open session: name, cwd, status busy | idle | waiting
 *   projects/<project>/<sessionId>.jsonl                  the session transcript
 *   projects/<project>/<sessionId>/subagents/agent-*.jsonl (+ .meta.json)   one per agent
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const SEC = 1000;
const MIN = 60 * SEC;
const DONE_KEEP = 15 * MIN;        // how long a finished task stays under "Just finished"
const AGENT_STALE = 30 * MIN;      // an unfinished agent silent for this long is shown as stopped
const FIRST_READ_CAP = 48 * 1024 * 1024;
const CHUNK = 1 << 20;
const DEFAULT_TURN = 3 * MIN;
const DEFAULT_AGENT = 3 * MIN;
const HISTORY_FILES = 30;          // past transcripts sampled for turn lengths
const HISTORY_CAP = 8 * 1024 * 1024;
const MAX_SANE = 6 * 60 * MIN;

const byNumber = (a, b) => a - b;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function baseName(p) {
  return p ? String(p).split(/[\\/]/).pop() : 'a file';
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* What a tool call is doing, in plain words. */
function toolLabel(name, input) {
  const d = input || {};
  switch (name) {
    case 'Bash':
    case 'PowerShell': return clip(d.description || d.command || 'Running a command', 80);
    case 'Read': return 'Reading ' + baseName(d.file_path);
    case 'Write': return 'Writing ' + baseName(d.file_path);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return 'Editing ' + baseName(d.file_path || d.notebook_path);
    case 'Grep': return 'Searching for "' + clip(d.pattern, 32) + '"';
    case 'Glob': return 'Finding files ' + clip(d.pattern, 40);
    case 'Agent':
    case 'Task': return 'Running agent: ' + clip(d.description || 'sub-task', 50);
    case 'WebSearch': return 'Searching the web: ' + clip(d.query, 40);
    case 'WebFetch': return 'Reading a web page';
    case 'Skill': return 'Using skill ' + clip(d.skill, 30);
    case 'TodoWrite': return 'Updating the to-do list';
    case 'AskUserQuestion': return 'Asking you a question';
    case 'Artifact': return 'Publishing a page';
    case 'Workflow': return 'Running a workflow';
    case 'ToolSearch': return 'Looking up a tool';
    default:
      if (name && name.startsWith('mcp__')) return 'Using ' + clip(name.split('__').slice(1).join(' ').replace(/_/g, ' '), 50);
      return clip(d.description || name || 'Working', 80);
  }
}

/* Claude often says how long the rest will take ("about 5 minutes"). Returns that in ms, or null. */
const ETA_RE = /(?:about|around|roughly|approx(?:imately)?\.?|~|≈|eta:?|another|within|under)\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;
function statedMs(text) {
  let match;
  let last = null;
  ETA_RE.lastIndex = 0;
  while ((match = ETA_RE.exec(text))) last = match;
  if (!last) return null;
  const amount = Number(last[2] || last[1]);
  const unit = last[3].toLowerCase();
  const ms = amount * (unit.startsWith('s') ? SEC : unit.startsWith('m') ? MIN : 60 * MIN);
  return ms > 0 && ms <= MAX_SANE ? ms : null;
}

/* Total duration to expect, given how long it has run so far: the median of past runs that lasted longer than this. */
function estimate(elapsed, samples, fallback) {
  if (!samples || samples.length < 4) return elapsed < fallback ? { total: fallback, over: false } : { total: 0, over: true };
  let lo = 0;
  while (lo < samples.length && samples[lo] <= elapsed) lo++;
  const rest = samples.length - lo;
  if (rest <= 0) return { total: 0, over: true };
  return { total: samples[lo + Math.floor(rest / 2)], over: false };
}

/* Follows a growing .jsonl file, handing over only the lines added since the last read. */
class Tail {
  constructor(file, cap) {
    this.file = file;
    this.cap = cap || FIRST_READ_CAP;
    this.offset = 0;
    this.rest = '';
    this.decoder = new StringDecoder('utf8');
    this.started = false;
    this.skipFirst = false;
    this.mtimeMs = 0;
  }

  async read(onLine) {
    let stat;
    try { stat = await fsp.stat(this.file); } catch { return false; }
    this.mtimeMs = stat.mtimeMs;
    if (stat.size < this.offset) {
      this.offset = 0;
      this.rest = '';
      this.decoder = new StringDecoder('utf8');
    }
    if (!this.started) {
      this.started = true;
      if (stat.size > this.cap) {
        this.offset = stat.size - this.cap;
        this.skipFirst = true;
      }
    }
    if (stat.size === this.offset) return true;
    const handle = await fsp.open(this.file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      while (this.offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const lines = (this.rest + this.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        this.rest = lines.pop();
        for (const line of lines) {
          if (this.skipFirst) { this.skipFirst = false; continue; }
          if (line.length > 2) onLine(line);
        }
      }
    } finally {
      await handle.close();
    }
    return true;
  }
}

/* Tracks which tool calls are still open, so we can say what is happening right now. */
class Activity {
  constructor() {
    this.pending = new Map();
    this.lastKind = null;
    this.toolCount = 0;
    this.firstTs = 0;
    this.lastTs = 0;
  }

  noteAssistant(o, onText) {
    const content = o.message && o.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'tool_use') {
        this.pending.set(block.id, toolLabel(block.name, block.input));
        this.toolCount++;
        this.lastKind = 'tool';
      } else if (block.type === 'text' && block.text && block.text.trim()) {
        this.lastKind = 'text';
        if (onText) onText(block.text);
      } else if (block.type === 'thinking') {
        this.lastKind = 'thinking';
      }
    }
  }

  noteResults(content) {
    let any = false;
    for (const block of content) {
      if (block && block.type === 'tool_result') {
        this.pending.delete(block.tool_use_id);
        any = true;
      }
    }
    if (any) this.lastKind = 'result';
    return any;
  }

  get step() {
    if (this.pending.size) {
      let last = '';
      for (const label of this.pending.values()) last = label;
      return this.pending.size > 1 ? `${last} (+${this.pending.size - 1} more)` : last;
    }
    return this.lastKind === 'text' ? 'Writing the reply' : 'Thinking';
  }
}

class SessionLog extends Activity {
  constructor(file) {
    super();
    this.tail = new Tail(file);
    this.title = null;
    this.lastPrompt = null;
    this.turnOpen = false;
    this.turnStart = 0;
    this.lastTurn = null;
    this.turns = [];
    this.stated = null;
  }

  line(line) {
    if (line.startsWith('{"type":"ai-title"')) {
      const o = parse(line);
      if (o && o.aiTitle) this.title = o.aiTitle;
      return;
    }
    if (line.startsWith('{"type":"last-prompt"')) {
      const o = parse(line);
      if (o && o.lastPrompt) this.lastPrompt = o.lastPrompt;
      return;
    }
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    const o = parse(line);
    if (!o || o.isSidechain || !o.message) return;
    const ts = Date.parse(o.timestamp) || 0;
    if (!ts) return;
    if (o.type === 'user') this.user(o, ts);
    else if (o.type === 'assistant') this.assistant(o, ts);
  }

  user(o, ts) {
    const content = o.message.content;
    if (Array.isArray(content) && this.noteResults(content)) { this.lastTs = ts; return; }
    if (o.isMeta) return;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '';
    if (/^\s*\[Request interrupted/.test(text)) { this.closeTurn(ts); return; }
    if (!this.turnOpen || ts - this.lastTs > 30 * MIN) this.openTurn(ts);
    this.lastKind = 'prompt';
    this.lastTs = ts;
  }

  // A turn is only opened by a prompt: the last message of a turn is written as several lines, each marked end_turn.
  assistant(o, ts) {
    this.noteAssistant(o, (text) => {
      const ms = statedMs(text);
      if (ms) this.stated = { at: ts, ms };
    });
    this.lastTs = ts;
    if (o.message.stop_reason === 'end_turn') this.closeTurn(ts);
  }

  openTurn(ts) {
    this.turnOpen = true;
    this.turnStart = ts;
    this.stated = null;
    this.pending.clear();
    this.toolCount = 0;
  }

  closeTurn(ts) {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.lastTurn = { start: this.turnStart, end: ts };
    const took = ts - this.turnStart;
    if (took > 2 * SEC && took < MAX_SANE) this.turns.push(took);
    this.pending.clear();
  }
}

class AgentLog extends Activity {
  constructor(file) {
    super();
    this.tail = new Tail(file);
    this.ended = false;
    this.firstPrompt = null;
  }

  line(line) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
    const o = parse(line);
    if (!o || !o.message) return;
    const ts = Date.parse(o.timestamp) || 0;
    if (!ts) return;
    if (!this.firstTs) this.firstTs = ts;
    this.lastTs = ts;
    if (o.type === 'user') {
      const content = o.message.content;
      if (Array.isArray(content)) this.noteResults(content);
      if (!this.firstPrompt) {
        const text = typeof content === 'string' ? content : ((Array.isArray(content) && content.find((b) => b && b.type === 'text')) || {}).text;
        if (text) this.firstPrompt = clip(text, 60);
      }
      this.ended = false;
    } else if (o.type === 'assistant') {
      this.noteAssistant(o);
      this.ended = o.message.stop_reason === 'end_turn';
    }
  }
}

/* How long past agents and past turns took. Feeds the time-left estimate. */
class History {
  constructor() {
    this.byType = new Map();
    this.all = [];
    this.turns = [];
    this.seen = new Set();
    this.done = Promise.all([this.scan().catch(() => {}), this.scanTurns().catch(() => {})]);
  }

  /* Turn lengths (prompt to final reply) from the most recent transcripts, read with cheap string checks only. */
  async scanTurns() {
    const files = [];
    let projects;
    try { projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, project.name);
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        try { files.push({ file: path.join(dir, name), mtime: (await fsp.stat(path.join(dir, name))).mtimeMs }); } catch { /* gone */ }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const stamp = /"timestamp":"([0-9T:.\-]+Z)"/;
    for (const { file } of files.slice(0, HISTORY_FILES)) {
      let open = false;
      let start = 0;
      let last = 0;
      const found = [];
      await new Tail(file, HISTORY_CAP).read((line) => {
        if (line.includes('"isSidechain":true')) return;
        const assistant = line.includes('"role":"assistant"');
        if (!assistant && !line.includes('"type":"user"')) return;
        const m = stamp.exec(line);
        const ts = m ? Date.parse(m[1]) : 0;
        if (!ts) return;
        if (assistant) {
          if (open && line.includes('"stop_reason":"end_turn"')) { open = false; found.push(ts - start); }
        } else if (!line.includes('"type":"tool_result"') && !line.includes('"isMeta":true')) {
          if (line.includes('[Request interrupted')) { open = false; return; }
          if (!open || ts - last > 30 * MIN) { open = true; start = ts; }
        }
        last = ts;
      }).catch(() => {});
      for (const took of found) if (took > 2 * SEC && took < MAX_SANE) this.turns.push(took);
      this.turns.sort(byNumber);
    }
  }

  add(type, ms) {
    if (!(ms > 2 * SEC && ms < MAX_SANE)) return;
    const key = String(type || 'agent');
    if (!this.byType.has(key)) this.byType.set(key, []);
    this.byType.get(key).push(ms);
    this.byType.get(key).sort(byNumber);
    this.all.push(ms);
    this.all.sort(byNumber);
  }

  samples(type) {
    const own = this.byType.get(String(type || 'agent'));
    return own && own.length >= 4 ? own : this.all;
  }

  async scan() {
    const now = Date.now();
    let projects;
    try { projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(PROJECTS_DIR, project.name);
      let sessions;
      try { sessions = await fsp.readdir(projectDir, { withFileTypes: true }); } catch { continue; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const dir = path.join(projectDir, session.name, 'subagents');
        let files;
        try { files = await fsp.readdir(dir); } catch { continue; }
        for (const name of files) {
          const m = /^agent-(.+)\.jsonl$/.exec(name);
          if (!m) continue;
          const file = path.join(dir, name);
          try {
            const stat = await fsp.stat(file);
            if (now - stat.mtimeMs < 2 * MIN) continue;
            const span = await edgeTimestamps(file, stat.size);
            if (!span) continue;
            const meta = (await readJson(path.join(dir, `agent-${m[1]}.meta.json`))) || {};
            this.seen.add(file);
            this.add(meta.agentType, span.last - span.first);
          } catch { /* unreadable file: skip */ }
        }
      }
    }
  }
}

/* First and last timestamp in a transcript without parsing the whole file. */
async function edgeTimestamps(file, size) {
  const span = 32 * 1024;
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(span, size));
    await handle.read(head, 0, head.length, 0);
    const tail = Buffer.alloc(Math.min(span, size));
    await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length));
    const re = /"timestamp":"([0-9T:.\-]+Z)"/g;
    const first = re.exec(head.toString('utf8'));
    let last = null;
    let m;
    const tailText = tail.toString('utf8');
    re.lastIndex = 0;
    while ((m = re.exec(tailText))) last = m;
    if (!first || !last) return null;
    return { first: Date.parse(first[1]), last: Date.parse(last[1]) };
  } finally {
    await handle.close();
  }
}

async function tailTitle(file) {
  try {
    const stat = await fsp.stat(file);
    const length = Math.min(256 * 1024, stat.size);
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      const re = /"aiTitle":"((?:[^"\\]|\\.)*)"/g;
      let m;
      let last = null;
      const text = buffer.toString('utf8');
      while ((m = re.exec(text))) last = m;
      return last ? JSON.parse(`"${last[1]}"`) : null;
    } finally {
      await handle.close();
    }
  } catch { return null; }
}

class Collector {
  constructor() {
    this.state = new Map();
    this.history = new History();
    this.polls = 0;
  }

  dismiss(id) {
    const st = this.state.get(id);
    if (st) st.dismissed = true;
  }

  cwdOf(id) {
    const st = this.state.get(id);
    return st ? st.cwd : null;
  }

  async readSessions() {
    let names;
    try { names = await fsp.readdir(SESSIONS_DIR); } catch { return []; }
    const latest = new Map();
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const s = await readJson(path.join(SESSIONS_DIR, name));
      if (!s || !s.sessionId || !s.pid || s.spare || !alive(s.pid)) continue;
      const other = latest.get(s.sessionId);
      if (!other || (s.updatedAt || 0) > (other.updatedAt || 0)) latest.set(s.sessionId, s);
    }
    return Array.from(latest.values());
  }

  async findTranscript(s, st) {
    if (st.transcript) return st.transcript;
    if (st.lookups && this.polls - st.lookups < 8) return null;
    st.lookups = this.polls;
    const dirs = [path.join(PROJECTS_DIR, String(s.cwd || '').replace(/[^A-Za-z0-9]/g, '-'))];
    try { for (const d of await fsp.readdir(PROJECTS_DIR)) dirs.push(path.join(PROJECTS_DIR, d)); } catch { /* no projects yet */ }
    for (const dir of dirs) {
      const file = path.join(dir, s.sessionId + '.jsonl');
      try { await fsp.access(file); st.transcript = file; return file; } catch { /* try the next folder */ }
    }
    return null;
  }

  turnSamples(log) {
    const own = log ? log.turns.slice().sort(byNumber) : [];
    return own.length >= 8 ? own : this.history.turns;
  }

  async readAgents(s, st, since, now) {
    if (!st.transcript) return [];
    const dir = path.join(path.dirname(st.transcript), s.sessionId, 'subagents');
    let names;
    try { names = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const id = m[1];
      let ag = st.agents.get(id);
      if (ag && ag.skip) continue;
      const file = path.join(dir, name);
      if (!ag) {
        let stat;
        try { stat = await fsp.stat(file); } catch { continue; }
        if (stat.mtimeMs < since - 5 * SEC) { st.agents.set(id, { skip: true }); continue; }
        ag = { file, log: new AgentLog(file), meta: {}, metaFile: path.join(dir, `agent-${id}.meta.json`) };
        st.agents.set(id, ag);
      }
      await ag.log.tail.read((line) => ag.log.line(line));
      if (!ag.meta.finished) ag.meta = (await readJson(ag.metaFile)) || ag.meta;
      if (!ag.log.firstTs) continue;

      const finished = ag.meta.finished === true || ag.log.ended;
      const lastSeen = Math.max(ag.log.lastTs, ag.log.tail.mtimeMs);
      if (finished && lastSeen < since - 5 * SEC) { st.agents.set(id, { skip: true }); continue; }

      const type = ag.meta.agentType || 'agent';
      const state = finished ? 'done' : now - lastSeen < AGENT_STALE ? 'running' : 'stopped';
      const startedAt = ag.log.firstTs;
      const endedAt = finished ? ag.log.lastTs : null;
      let etaAt = null;
      if (state === 'running') {
        const est = estimate(now - startedAt, this.history.samples(type), DEFAULT_AGENT);
        if (!est.over) etaAt = startedAt + est.total;
      }
      if (finished && !this.history.seen.has(file)) {
        this.history.seen.add(file);
        this.history.add(type, endedAt - startedAt);
      }
      const tools = ag.log.toolCount;
      out.push({
        id, type, state, startedAt, endedAt, etaAt, tools,
        name: clip(ag.meta.description || ag.log.firstPrompt || 'Agent', 70),
        step: state === 'running' ? ag.log.step : finished ? `Finished, ${tools} tool call${tools === 1 ? '' : 's'}` : 'Stopped'
      });
    }
    return out;
  }

  async buildTask(s, now, events) {
    const id = s.sessionId;
    let st = this.state.get(id);
    if (!st) {
      st = { agents: new Map(), idlePolls: 0, prev: undefined };
      this.state.set(id, st);
    }
    st.cwd = s.cwd;

    const raw = s.status === 'busy' ? 'running' : s.status === 'waiting' ? 'waiting' : 'idle';
    const active = raw !== 'idle';
    const changedAt = s.statusUpdatedAt || s.updatedAt || s.startedAt || now;
    const recent = !active && now - changedAt < DONE_KEEP;

    if ((active || recent) && !st.log) {
      const file = await this.findTranscript(s, st);
      if (file) st.log = new SessionLog(file);
    }
    if (st.log) await st.log.tail.read((line) => st.log.line(line));
    const log = st.log;

    if (!active && !log && st.tailTitle === undefined && s.nameSource === 'derived') {
      const file = await this.findTranscript(s, st);
      st.tailTitle = file ? await tailTitle(file) : undefined;
      if (file && st.tailTitle === undefined) st.tailTitle = null;
    }
    const name = (s.name && s.nameSource !== 'derived' && s.name) || (log && log.title) || st.tailTitle || s.name || path.basename(s.cwd || '') || 'Claude session';

    // One idle reading right after work is held back: a short gap between two turns is not a "finished".
    const wasActive = st.prev === 'running' || st.prev === 'waiting';
    let state;
    if (active) { state = raw; st.idlePolls = 0; }
    else if (wasActive && ++st.idlePolls < 2) state = st.prev;
    else state = 'idle';

    const task = {
      id, pid: s.pid, name: clip(name, 80), project: path.basename(s.cwd || ''), cwd: s.cwd || '',
      prompt: log && log.lastPrompt ? clip(log.lastPrompt, 200) : null,
      agents: [], agentsTotal: 0, agentsDone: 0
    };

    if (state === 'idle' && wasActive) {
      const turn = log && log.lastTurn;
      st.tookMs = turn && turn.end >= (st.startedAt || 0) ? turn.end - turn.start : st.startedAt ? now - st.startedAt : null;
      st.doneAt = now;
      st.dismissed = false;
      events.push({ type: 'finished', id, name: task.name, tookMs: st.tookMs });
    } else if (state === 'idle' && st.prev === undefined && recent) {
      const turn = log && log.lastTurn;
      if (turn && Math.abs(turn.end - changedAt) < 2 * MIN) {
        st.doneAt = changedAt;
        st.tookMs = turn.end - turn.start;
      }
    }
    if (state === 'waiting' && st.prev !== 'waiting' && st.prev !== undefined) {
      events.push({ type: 'waiting', id, name: task.name, waitingFor: s.waitingFor || null });
    }

    if (state !== 'idle') {
      st.doneAt = null;
      const startedAt = log && log.turnOpen ? log.turnStart : wasActive && st.startedAt ? st.startedAt : changedAt;
      st.startedAt = startedAt;
      const agents = await this.readAgents(s, st, startedAt, now);
      const running = agents.filter((a) => a.state === 'running');
      st.agentsTotal = agents.length;
      st.agentsDone = agents.filter((a) => a.state === 'done').length;

      let etaAt = null;
      let etaSource = null;
      let overrun = false;
      if (state === 'running') {
        const stated = log && log.stated;
        if (stated && stated.at >= startedAt && stated.at + stated.ms > now) {
          etaAt = stated.at + stated.ms;
          etaSource = 'claude';
        } else if (running.length) {
          if (running.every((a) => a.etaAt)) {
            etaAt = Math.max(...running.map((a) => a.etaAt)) + 20 * SEC;
            etaSource = 'history';
          } else overrun = true;
        } else {
          const est = estimate(now - startedAt, this.turnSamples(log), DEFAULT_TURN);
          if (est.over) overrun = true;
          else { etaAt = startedAt + est.total; etaSource = 'history'; }
        }
        if (etaAt && etaAt <= now) { etaAt = null; overrun = true; }
      }
      Object.assign(task, {
        state, startedAt, etaAt, etaSource, overrun,
        waitingFor: state === 'waiting' ? (s.waitingFor || 'input needed') : null,
        step: log ? log.step : 'Working',
        agents, agentsTotal: st.agentsTotal, agentsDone: st.agentsDone
      });
    } else if (st.doneAt && !st.dismissed && now - st.doneAt < DONE_KEEP) {
      Object.assign(task, { state: 'done', finishedAt: st.doneAt, tookMs: st.tookMs, agentsTotal: st.agentsTotal || 0, agentsDone: st.agentsDone || 0 });
    } else {
      Object.assign(task, { state: 'idle', idleSince: changedAt });
    }
    st.prev = state;
    return task;
  }

  async poll() {
    const now = Date.now();
    this.polls++;
    const events = [];
    const tasks = [];
    const seen = new Set();
    for (const s of await this.readSessions()) {
      seen.add(s.sessionId);
      try { tasks.push(await this.buildTask(s, now, events)); } catch { /* one unreadable session must not hide the rest */ }
    }
    for (const id of Array.from(this.state.keys())) if (!seen.has(id)) this.state.delete(id);

    const rank = { waiting: 0, running: 1, done: 2, idle: 3 };
    tasks.sort((a, b) => {
      if (a.state !== b.state) return rank[a.state] - rank[b.state];
      if (a.state === 'running') return (a.etaAt || Infinity) - (b.etaAt || Infinity);
      if (a.state === 'waiting') return a.startedAt - b.startedAt;
      if (a.state === 'done') return b.finishedAt - a.finishedAt;
      return (b.idleSince || 0) - (a.idleSince || 0);
    });
    return { now, tasks, events: this.polls > 1 ? events : [] };
  }
}

module.exports = { Collector, statedMs, estimate, toolLabel };

/* `node collector.js` prints what the sticky would show right now. */
if (require.main === module) {
  (async () => {
    const collector = new Collector();
    await collector.history.done;
    await collector.poll();
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const snap = await collector.poll();
    const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-US') : '-');
    const turns = collector.history.turns;
    console.log(`history: ${collector.history.all.length} past agent runs, types: ${Array.from(collector.history.byType, ([k, v]) => `${k}=${v.length}`).join(', ')}`);
    console.log(`history: ${turns.length} past turns, median ${turns.length ? Math.round(turns[turns.length >> 1] / 1000) : 0}s, longest ${turns.length ? Math.round(turns[turns.length - 1] / 60000) : 0} min`);
    for (const t of snap.tasks) {
      console.log(`[${t.state.padEnd(7)}] ${t.name}  (${t.project})` +
        (t.state === 'running' || t.state === 'waiting' ? `  started ${clock(t.startedAt)}  eta ${clock(t.etaAt)} (${t.etaSource || (t.overrun ? 'overrun' : 'none')})  step: ${t.step}` : '') +
        (t.state === 'done' ? `  finished ${clock(t.finishedAt)} took ${t.tookMs ? Math.round(t.tookMs / 1000) + 's' : '?'}` : '') +
        (t.state === 'idle' ? `  idle since ${clock(t.idleSince)}` : ''));
      for (const a of t.agents) console.log(`      - ${a.state.padEnd(7)} ${a.type.padEnd(16)} ${a.name} | ${a.step} | eta ${clock(a.etaAt)}`);
    }
  })();
}
