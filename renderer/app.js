/* Sticky renderer: turns a snapshot of tasks into the animated note. Runs in Electron and, with demo data, in a plain browser. */
(function () {
  'use strict';

  const api = window.sticky || null;
  const params = new URLSearchParams(location.search);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  const ICON = {
    pin: '<svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M8 3h8l-1 7 3 4H6l3-4z"/></svg>',
    min: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    open: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>'
  };

  const MAX_AGENTS = 5;
  const S = {
    snap: null, first: true, dragging: false,
    settings: { theme: 'auto', alwaysOnTop: true, collapsed: false, demo: false },
    frozenT: params.has('t') ? Number(params.get('t')) : null,
    prev: new Map(), hidden: new Set(), expanded: new Set(), idleOpen: false,
    celebrateUntil: 0, celebrateName: ''
  };

  /* ---------- formatting ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  function fmtDur(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h) return `${h}h ${pad(m)}m`;
    if (m) return `${m}m ${pad(s)}s`;
    return `${s}s`;
  }
  function fmtWords(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} sec`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  }
  function fmtLeft(ms) {
    if (ms <= 0) return 'any moment';
    const s = ms / 1000;
    if (s < 45) return '<1 min left';
    const m = Math.round(s / 60);
    if (m < 60) return `~${m} min left`;
    const h = Math.floor(m / 60);
    return m % 60 ? `~${h} h ${m % 60} min left` : `~${h} h left`;
  }
  function fmtClock(ms, withSec) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: withSec ? '2-digit' : undefined, hour12: true });
  }
  function ago(ms) {
    const s = ms / 1000;
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }
  function idleFor(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `idle ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `idle ${h} h`;
    return `idle ${Math.round(h / 24)} d`;
  }
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function setText(node, text, anim) {
    if (node._t === text) return false;
    const firstTime = node._t === undefined;
    node._t = text;
    node.textContent = text;
    if (anim && !firstTime && !S.first) {
      node.classList.remove(anim);
      void node.offsetWidth;
      node.classList.add(anim);
    }
    return true;
  }
  function setAttr(node, name, value) {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  /* ---------- keyed list with enter / leave / reorder animation ---------- */
  function enter(node) {
    node.classList.add('enter', 'anim');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      node.classList.remove('enter');
      setTimeout(() => node.classList.remove('anim'), 460);
    }));
  }
  function leave(node) {
    node._leaving = true;
    node.classList.add('anim', 'leave');
    setTimeout(() => node.remove(), 440);
  }
  function syncList(container, items, create, update, ctx) {
    const live = new Map();
    const before = [];
    for (const node of Array.from(container.children)) {
      if (node._leaving) continue;
      live.set(node.dataset.key, node);
      before.push(node.dataset.key);
    }
    const kept = items.map((i) => String(i.id)).filter((k) => live.has(k));
    const reordered = kept.join('|') !== before.filter((k) => kept.includes(k)).join('|');
    const tops = new Map();
    if (reordered && !reduced) for (const node of live.values()) tops.set(node, node.getBoundingClientRect().top);

    let cursor = container.firstElementChild;
    for (const item of items) {
      const key = String(item.id);
      let node = live.get(key);
      if (node) live.delete(key);
      else {
        node = create(item, ctx);
        node.dataset.key = key;
        if (!S.first) enter(node);
      }
      update(node, item, ctx);
      while (cursor && cursor._leaving) cursor = cursor.nextElementSibling;
      if (node === cursor) cursor = cursor.nextElementSibling;
      else container.insertBefore(node, cursor);
    }
    for (const node of live.values()) leave(node);
    for (const [node, top] of tops) {
      if (node._leaving || !node.isConnected) continue;
      const dy = top - node.getBoundingClientRect().top;
      if (Math.abs(dy) > 2) node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 440, easing: 'cubic-bezier(.2,.9,.3,1.1)' });
    }
  }

  /* ---------- skeleton ---------- */
  function build() {
    window.Puff.installDefs();
    const sec = (key, label) => `
      <div class="sec empty" data-sec="${key}"><div class="sec-inner">
        <div class="sec-h"><span>${label}</span><span class="count" id="cnt-${key}">0</span></div>
        <div class="list" id="list-${key}"></div>
      </div></div>`;
    $('#root').innerHTML = `
      <div class="sticky" id="sticky" data-mode="full">
        <div class="full-view">
          <header class="stage" id="stage">
            <span class="bokeh b1"></span><span class="bokeh b2"></span><span class="bokeh b3"></span>
            ${window.Puff.hero('idle')}
            <div class="stage-text"><div class="headline" id="headline"></div><div class="subline" id="subline"></div></div>
            <div class="stage-btns">
              <button class="ibtn" id="btn-pin" title="Keep on top" aria-label="Keep on top" aria-pressed="true">${ICON.pin}</button>
              <button class="ibtn" id="btn-min" title="Collapse to small bar" aria-label="Collapse to small bar">${ICON.min}</button>
              <button class="ibtn" id="btn-more" title="Menu" aria-label="Menu">${ICON.more}</button>
            </div>
          </header>
          <section class="stats">
            <div class="stat"><b id="st-run">0</b><span>Tasks running</span></div>
            <div class="stat"><b id="st-agents">0</b><span>Agents working</span></div>
            <div class="stat hot"><b id="st-eta">-</b><span>All done by (est.)</span></div>
          </section>
          <div class="scroll" id="scroll">
            ${sec('waiting', 'Needs you')}
            ${sec('running', 'Running now')}
            ${sec('done', 'Just finished')}
            <div class="sec empty" data-sec="idle"><div class="sec-inner">
              <div class="sec-h"><button class="sec-toggle" id="idle-toggle" aria-expanded="false"><span>Idle sessions</span><span class="count" id="cnt-idle">0</span>${ICON.chev}</button></div>
              <div class="idle-list" id="idle-wrap"><div><div class="list" id="list-idle"></div></div></div>
            </div></div>
            <div class="empty-note" id="empty" hidden>No Claude sessions are open right now.</div>
          </div>
          <footer class="foot"><i></i><span id="foot"></span></footer>
        </div>
        <div class="pill-view" id="pillview">
          <div class="p-face">${window.Puff.mini('sleep')}</div>
          <div class="p-text"><div class="p-title" id="p-title"></div><div class="p-sub" id="p-sub"></div></div>
          <button class="ibtn" id="btn-exp" title="Expand" aria-label="Expand">${ICON.expand}</button>
        </div>
        <div class="grip l" data-edge="left" title="Drag to resize. Double-click to reset."></div>
        <div class="grip r" data-edge="right" title="Drag to resize. Double-click to reset."></div>
      </div>`;
  }

  /* ---------- task cards ---------- */
  function openTask(id) { if (api) api.openTask(id); }

  function createTask(task) {
    const row = el('div', 'row');
    const inner = el('div', 'row-inner');
    const card = el('article', 'card task');
    card.innerHTML = `
      <div class="t-head"><span class="pulse"><i></i></span><div class="t-title"></div><span class="pill"></span>
        <button class="cbtn" title="Open this chat in VS Code" aria-label="Open this chat in VS Code">${ICON.open}</button></div>
      <div class="t-sub"><span class="proj"></span><span class="verb"></span><span class="num timer"></span></div>
      <div class="t-step"><span class="dots"><i></i><i></i><i></i></span><span class="step-text"></span></div>
      <div class="wait-box" hidden><span class="wait-text"></span><button class="btn">Open chat</button></div>
      <div class="bar"><i></i></div>
      <div class="t-meta"><span class="agents-count"></span><span class="src"></span></div>
      <div class="agents" hidden><div class="agents-list"></div><button class="more" hidden></button></div>`;
    inner.appendChild(card);
    row.appendChild(inner);
    const q = (s) => $(s, card);
    row._r = {
      card, title: q('.t-title'), pill: q('.pill'), proj: q('.proj'), verb: q('.verb'), timer: q('.timer'),
      step: q('.t-step'), stepText: q('.step-text'), wait: q('.wait-box'), waitText: q('.wait-text'),
      bar: q('.bar'), fill: q('.bar > i'), meta: q('.t-meta'), count: q('.agents-count'), src: q('.src'),
      agents: q('.agents'), agentsList: q('.agents-list'), more: q('.more')
    };
    const id = task.id;
    q('.cbtn').addEventListener('click', (e) => { e.stopPropagation(); openTask(id); });
    q('.btn').addEventListener('click', (e) => { e.stopPropagation(); openTask(id); });
    card.addEventListener('click', () => openTask(id));
    row._r.more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
      render();
    });
    return row;
  }

  function orderAgents(agents) {
    const rank = { running: 0, done: 1, stopped: 2 };
    return agents.slice().sort((a, b) => (rank[a.state] - rank[b.state]) ||
      (a.state === 'running' ? a.startedAt - b.startedAt : (b.endedAt || 0) - (a.endedAt || 0)));
  }

  function updateTask(row, task, ctx) {
    const r = row._r;
    const t = ctx.t;
    const waiting = task.state === 'waiting';
    r.card.classList.toggle('waiting', waiting);
    setText(r.title, task.name);
    if (task.prompt) setAttr(r.title, 'title', task.prompt);
    setText(r.proj, task.project ? task.project + ' · ' : '');
    setText(r.verb, waiting ? 'waiting, started ' : 'running ');
    setText(r.timer, waiting ? fmtDur(t - task.startedAt) + ' ago' : fmtDur(t - task.startedAt));

    r.wait.hidden = !waiting;
    r.step.hidden = r.bar.hidden = r.meta.hidden = waiting;
    if (waiting) {
      setText(r.pill, 'Needs you', 'pop');
      setText(r.waitText, cap(task.waitingFor) || 'Waiting for your input');
    } else {
      const left = task.etaAt ? task.etaAt - t : null;
      const over = left == null || left <= 0;
      setText(r.pill, left == null ? (task.overrun ? 'running long' : 'working') : fmtLeft(left), 'pop');
      setText(r.stepText, task.step || 'Working', 'swap');
      r.bar.classList.toggle('over', over);
      if (!over) {
        const elapsed = Math.max(0, t - task.startedAt);
        const p = Math.min(0.97, Math.max(0.04, elapsed / (elapsed + left)));
        r.fill.style.width = (p * 100).toFixed(1) + '%';
      }
      const total = task.agentsTotal || 0;
      setText(r.count, total ? `${task.agentsDone || 0} of ${total} agents done` : 'No agents, main chat only');
      setText(r.src, task.etaSource === 'claude' ? 'Claude’s own estimate'
        : task.etaSource === 'history' && !over ? 'estimate from past runs'
        : over && task.overrun ? 'taking longer than usual' : '');
    }

    const all = orderAgents(task.agents || []);
    const expanded = S.expanded.has(task.id);
    const shown = all.length > MAX_AGENTS && !expanded ? all.slice(0, MAX_AGENTS - 1) : all;
    r.agents.hidden = all.length === 0;
    syncList(r.agentsList, shown, createAgent, updateAgent, ctx);
    r.more.hidden = all.length <= MAX_AGENTS;
    if (!r.more.hidden) setText(r.more, expanded ? 'Show fewer' : `+${all.length - shown.length} more agents`);
  }

  function typeKey(type) {
    const k = String(type || '').toLowerCase();
    if (k === 'general-purpose' || k === 'claude') return 'general';
    if (k === 'explore') return 'explore';
    if (k === 'plan') return 'plan';
    if (k === 'fork') return 'fork';
    return 'other';
  }

  function createAgent() {
    const row = el('div', 'row tight');
    const inner = el('div', 'row-inner');
    const a = el('div', 'agent');
    a.innerHTML = `
      <div class="av">${window.Puff.mini('run')}<span class="badge">${ICON.check}</span></div>
      <div class="a-text"><div class="a-name"></div><div class="a-step"></div></div>
      <div class="a-side"><div class="a-state"></div><div class="a-time num"></div></div>`;
    inner.appendChild(a);
    row.appendChild(inner);
    row._r = { a, av: $('.av', a), mini: $('.mini', a), name: $('.a-name', a), step: $('.a-step', a), state: $('.a-state', a), time: $('.a-time', a) };
    return row;
  }

  function updateAgent(row, agent, ctx) {
    const r = row._r;
    for (const s of ['running', 'done', 'stopped']) r.a.classList.toggle(s, agent.state === s);
    setAttr(r.av, 'data-type', typeKey(agent.type));
    setAttr(r.mini, 'data-state', agent.state === 'running' ? 'run' : agent.state === 'done' ? 'done' : 'sleep');
    setText(r.name, agent.name || 'Agent');
    setAttr(r.name, 'title', `${agent.name || 'Agent'} (${agent.type || 'agent'})`);
    setText(r.step, agent.step || (agent.state === 'running' ? 'Working' : ''), 'swap');
    const left = agent.state === 'running' && agent.etaAt ? agent.etaAt - ctx.t : 0;
    setText(r.state, agent.state === 'running' ? (left > 0 ? fmtLeft(left) : 'Running') : agent.state === 'done' ? 'Done' : 'Stopped');
    const end = agent.state === 'running' ? ctx.t : (agent.endedAt || ctx.t);
    setText(r.time, agent.startedAt ? fmtDur(end - agent.startedAt) : '');
  }

  function createDone(task) {
    const row = el('div', 'row');
    const inner = el('div', 'row-inner');
    const card = el('article', 'card done-card');
    card.innerHTML = `
      <div class="tick">${ICON.check}</div>
      <div class="d-text"><div class="t-title"></div><div class="d-sub"></div></div>
      <span class="d-ago"></span>
      <button class="cbtn" title="Dismiss" aria-label="Dismiss">${ICON.close}</button>`;
    inner.appendChild(card);
    row.appendChild(inner);
    row._r = { title: $('.t-title', card), sub: $('.d-sub', card), ago: $('.d-ago', card) };
    const id = task.id;
    card.addEventListener('click', () => openTask(id));
    $('.cbtn', card).addEventListener('click', (e) => {
      e.stopPropagation();
      S.hidden.add(id);
      if (api) api.dismiss(id);
      render();
    });
    return row;
  }

  function updateDone(row, task, ctx) {
    const r = row._r;
    setText(r.title, task.name);
    setText(r.sub, 'Reply ready' + (task.tookMs ? ` · took ${fmtWords(task.tookMs)}` : ''));
    setText(r.ago, task.finishedAt ? ago(ctx.t - task.finishedAt) : '');
  }

  function createIdle(task) {
    const row = el('div', 'row tight');
    const inner = el('div', 'row-inner');
    const d = el('div', 'idle-row');
    d.innerHTML = `<div class="av">${window.Puff.mini('sleep')}</div><span class="i-name"></span><span class="i-ago"></span>`;
    inner.appendChild(d);
    row.appendChild(inner);
    row._r = { name: $('.i-name', d), ago: $('.i-ago', d) };
    const id = task.id;
    d.addEventListener('click', () => openTask(id));
    return row;
  }

  function updateIdle(row, task, ctx) {
    setText(row._r.name, task.name);
    setAttr(row._r.name, 'title', task.project ? `${task.name} (${task.project})` : task.name);
    setText(row._r.ago, task.idleSince ? idleFor(ctx.t - task.idleSince) : 'idle');
  }

  /* ---------- top level render ---------- */
  function now() { return Date.now(); }

  function allDoneAt(running) {
    if (!running.length) return null;
    let max = 0;
    for (const k of running) { if (!k.etaAt) return null; max = Math.max(max, k.etaAt); }
    return max;
  }

  function celebrate(task, t) {
    S.celebrateUntil = t + 7000;
    S.celebrateName = task.name;
    const anchor = $('#sticky').dataset.mode === 'pill' ? $('.p-face') : $('.stage .mascot');
    const b = anchor.getBoundingClientRect();
    confetti(b.left + b.width / 2, b.top + b.height * 0.4);
  }

  function render() {
    const snap = S.snap;
    if (!snap) return;
    const t = S.settings.demo ? snap.now : now();
    const ctx = { t };
    const g = { waiting: [], running: [], done: [], idle: [] };
    const seen = new Set();
    for (const k of snap.tasks) {
      seen.add(k.id);
      const state = k.state === 'done' && S.hidden.has(k.id) ? 'idle' : k.state;
      if (k.state !== 'done') S.hidden.delete(k.id);
      const prev = S.prev.get(k.id);
      if (!S.first && (prev === 'running' || prev === 'waiting') && state === 'done') celebrate(k, t);
      S.prev.set(k.id, state);
      (g[state] || g.idle).push(k);
    }
    for (const id of Array.from(S.prev.keys())) if (!seen.has(id)) S.prev.delete(id);

    /* stage */
    const agentsWorking = g.running.reduce((n, k) => n + (k.agents || []).filter((a) => a.state === 'running').length, 0);
    const eta = allDoneAt(g.running);
    let mood, head, sub;
    if (g.waiting.length) {
      mood = 'wait'; head = 'Claude needs you';
      sub = `${g.waiting[0].name}: ${(g.waiting[0].waitingFor || 'waiting for your input').toLowerCase()}`;
    } else if (t < S.celebrateUntil) {
      mood = 'done'; head = 'Done!'; sub = `${S.celebrateName} is finished`;
    } else if (g.running.length) {
      mood = 'work'; head = plural(g.running.length, 'task running', 'tasks running');
      sub = eta ? `${fmtLeft(eta - t)} · done by ${fmtClock(eta)}` : (agentsWorking ? `${plural(agentsWorking, 'agent', 'agents')} working` : 'Working on it');
    } else if (g.done.length) {
      mood = 'calm'; head = plural(g.done.length, 'reply ready', 'replies ready');
      sub = g.done.map((k) => k.name).slice(0, 2).join(', ');
    } else {
      mood = 'idle'; head = 'All quiet';
      sub = snap.tasks.length ? `${plural(g.idle.length, 'session', 'sessions')} idle` : 'No Claude sessions open';
    }
    setAttr($('.stage .mascot'), 'data-state', mood);
    setText($('#headline'), head, 'swap');
    setText($('#subline'), sub, 'swap');

    /* stats */
    setText($('#st-run'), String(g.running.length), 'pop');
    setText($('#st-agents'), String(agentsWorking), 'pop');
    setText($('#st-eta'), eta ? fmtClock(eta) : '–', 'pop');

    /* lists */
    const lists = [['waiting', createTask, updateTask], ['running', createTask, updateTask], ['done', createDone, updateDone], ['idle', createIdle, updateIdle]];
    for (const [key, create, update] of lists) {
      $(`.sec[data-sec="${key}"]`).classList.toggle('empty', g[key].length === 0);
      setText($(`#cnt-${key}`), String(g[key].length));
      syncList($(`#list-${key}`), g[key], create, update, ctx);
    }
    $('#empty').hidden = snap.tasks.length > 0;

    /* collapsed pill */
    const pillState = g.waiting.length ? 'alert' : t < S.celebrateUntil ? 'done' : g.running.length ? 'run' : g.done.length ? 'done' : 'sleep';
    setAttr($('.p-face .mini'), 'data-state', pillState);
    setText($('#p-title'), g.waiting.length ? 'Claude needs you' : g.running.length ? plural(g.running.length, 'task running', 'tasks running') : g.done.length ? plural(g.done.length, 'reply ready', 'replies ready') : 'All quiet', 'swap');
    setText($('#p-sub'), g.waiting.length ? g.waiting[0].name
      : g.running.length ? [agentsWorking ? plural(agentsWorking, 'agent', 'agents') : null, eta ? fmtLeft(eta - t) : 'working'].filter(Boolean).join(' · ')
      : g.done.length ? g.done[0].name : `${plural(g.idle.length, 'session', 'sessions')} idle`);

    setText($('#foot'), S.settings.demo ? 'Demo data, not your real tasks' : `Live · updated ${fmtClock(snap.now, true)}`);
    S.first = false;
  }

  /* ---------- confetti ---------- */
  let confettiRaf = 0;
  function confetti(x, y) {
    if (reduced) return;
    const canvas = $('#confetti');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#4F8BFF', '#8A6BFF', '#FFC94D', '#FF7FA4', '#2FBF68', '#FF9A4D'];
    const parts = Array.from({ length: 110 }, () => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const v = 5 + Math.random() * 9;
      return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 5 + Math.random() * 5, h: 3 + Math.random() * 4, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.5, color: colors[(Math.random() * colors.length) | 0], round: Math.random() < 0.3 };
    });
    const t0 = performance.now();
    cancelAnimationFrame(confettiRaf);
    const frame = (ts) => {
      const age = (ts - t0) / 1000;
      c.clearRect(0, 0, innerWidth, innerHeight);
      if (age > 2.6) return;
      for (const p of parts) {
        p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        c.save();
        c.globalAlpha = Math.max(0, 1 - Math.max(0, age - 1.5) / 1.1);
        c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.color;
        if (p.round) { c.beginPath(); c.arc(0, 0, p.h, 0, 6.3); c.fill(); } else c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        c.restore();
      }
      confettiRaf = requestAnimationFrame(frame);
    };
    confettiRaf = requestAnimationFrame(frame);
  }

  /* ---------- collapse / expand ---------- */
  function setMode(pill, animate) {
    const sticky = $('#sticky');
    if ((sticky.dataset.mode === 'pill') === pill) return;
    if (!animate || reduced) {
      sticky.dataset.mode = pill ? 'pill' : 'full';
      sticky.style.height = '';
      return;
    }
    // Heights are read from the computed style: that is the note's own unit, whatever its scale.
    if (pill) {
      sticky.style.height = getComputedStyle(sticky).height;
      void sticky.offsetHeight;
      sticky.dataset.mode = 'pill';
      sticky.style.height = '64px';
    } else {
      sticky.style.transition = 'none';
      sticky.dataset.mode = 'full';
      sticky.style.height = '';
      const target = getComputedStyle(sticky).height;
      sticky.dataset.mode = 'pill';
      sticky.style.height = '64px';
      void sticky.offsetHeight;
      sticky.style.transition = '';
      sticky.dataset.mode = 'full';
      sticky.style.height = target;
      setTimeout(() => { if (sticky.dataset.mode === 'full') sticky.style.height = ''; }, 540);
    }
  }

  function applySettings(animate) {
    document.documentElement.dataset.theme = S.settings.theme || 'auto';
    setAttr($('#btn-pin'), 'aria-pressed', S.settings.alwaysOnTop ? 'true' : 'false');
    setMode(!!S.settings.collapsed, animate);
  }

  function setSetting(key, value) {
    S.settings[key] = value;
    applySettings(true);
    if (api) api.set(key, value);
  }

  /* ---------- window dragging and click-through ---------- */
  function draggable(handle, onClick) {
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      start = { x: e.screenX, y: e.screenY };
      S.dragging = true;
      handle.setPointerCapture(e.pointerId);
      if (api) api.dragStart();
    });
    const end = (e) => {
      if (!start) return;
      const moved = Math.hypot(e.screenX - start.x, e.screenY - start.y) > 4;
      start = null;
      S.dragging = false;
      if (api) api.dragEnd();
      if (!moved && onClick) onClick();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function wire() {
    $('#btn-pin').addEventListener('click', () => setSetting('alwaysOnTop', !S.settings.alwaysOnTop));
    $('#btn-min').addEventListener('click', () => setSetting('collapsed', true));
    $('#btn-exp').addEventListener('click', () => setSetting('collapsed', false));
    $('#btn-more').addEventListener('click', () => { if (api) api.menu(); else setSetting('theme', S.settings.theme === 'dark' ? 'light' : 'dark'); });
    $('#idle-toggle').addEventListener('click', () => {
      S.idleOpen = !S.idleOpen;
      $('#idle-toggle').setAttribute('aria-expanded', String(S.idleOpen));
      $('#idle-wrap').classList.toggle('open', S.idleOpen);
    });
    draggable($('#stage'));
    draggable($('#pillview'), () => setSetting('collapsed', false));
    for (const grip of document.querySelectorAll('.grip')) {
      const sticky = $('#sticky');
      const stop = () => {
        if (!S.dragging) return;
        S.dragging = false;
        sticky.classList.remove('resizing');
        if (api) api.resizeEnd();
      };
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !api) return;
        S.dragging = true;
        grip.setPointerCapture(e.pointerId);
        sticky.classList.add('resizing');
        api.resizeStart(grip.dataset.edge, parseFloat(getComputedStyle(sticky).height) * (S.zoom || 1));
      });
      grip.addEventListener('pointerup', stop);
      grip.addEventListener('pointercancel', stop);
      grip.addEventListener('dblclick', () => { if (api) api.resetSize(); });
    }
    document.addEventListener('visibilitychange', () => document.body.classList.toggle('paused', document.hidden));

    if (api) {
      let inside = null;
      const setInside = (v) => { if (v !== inside) { inside = v; api.ignoreMouse(!v); } };
      window.addEventListener('mousemove', (e) => {
        if (S.dragging) return;
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        setInside(!!(hit && hit.closest('#sticky')));
      });
      document.addEventListener('mouseleave', () => { if (!S.dragging) setInside(false); });
    }
  }

  async function sendIcons() {
    const draw = (svg, size) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, 0, 0, size, size);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const P = window.Puff;
    const [app256, tray, trayBusy, trayWait, trayDone] = await Promise.all([
      draw(P.iconSvg(256), 256), draw(P.iconSvg(64), 64), draw(P.iconSvg(64, '#3B82F6'), 64),
      draw(P.iconSvg(64, '#F59E0B'), 64), draw(P.iconSvg(64, '#22A857'), 64)
    ]);
    api.icons({ app256, tray, trayBusy, trayWait, trayDone });
  }

  function tick() {
    if (S.settings.demo) S.snap = window.StickyDemo.snapshot(Date.now(), S.frozenT);
    render();
  }

  function start() {
    build();
    wire();
    if (!api || params.get('preview') === '1') document.documentElement.classList.add('preview');
    Object.assign(S.settings, {
      theme: params.get('theme') || 'auto',
      collapsed: params.get('collapsed') === '1',
      demo: !api || params.get('demo') === '1'
    });
    applySettings(false);
    if (!api) document.documentElement.style.setProperty('--max-h', Math.max(320, innerHeight - 60) + 'px');

    if (api) {
      api.onSnapshot((snap) => { if (!S.settings.demo) { S.snap = snap; render(); } });
      api.onSettings((settings) => {
        const demoChanged = !!settings.demo !== !!S.settings.demo;
        Object.assign(S.settings, settings);
        if (demoChanged) { S.prev.clear(); S.celebrateUntil = 0; if (!S.settings.demo) S.snap = null; }
        applySettings(true);
        tick();
      });
      api.onLayout((layout) => {
        // layout sizes are in screen units; inside the scaled note they are divided by the scale
        const z = layout.zoom || 1;
        const sticky = $('#sticky');
        S.zoom = z;
        document.documentElement.style.setProperty('--z', String(z));
        document.documentElement.style.setProperty('--max-h', (layout.maxHeight / z) + 'px');
        sticky.classList.toggle('sized', !!layout.height);
        if (layout.height) sticky.style.setProperty('--h', (layout.height / z) + 'px');
        $('#root').dataset.anchor = layout.anchor;
        sticky.classList.toggle('compact', (layout.height || layout.maxHeight) / z < 700);
      });
      api.ready();
      sendIcons();
    }
    tick();
    setInterval(tick, 1000);
  }

  start();
})();
