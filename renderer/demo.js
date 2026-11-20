/* Sample data on a 56 second loop, so every state and animation can be seen without real tasks running. */
(function (global) {
  'use strict';

  const LOOP = 56;
  const MIN = 60;

  const STEPS_A = ['Reading OrderStore.cs', 'Searching for "SaveAsync"', 'Checking database writes', 'Reading the v2 importer', 'Comparing old and new output'];
  const STEPS_T = ['Running dotnet test', 'Running dotnet test (41 passed)', 'Running dotnet test (87 passed)', 'Reading the test report'];
  const STEPS_C = ['Finding files **/*Importer*.cs', 'Searching for "LegacyImporter"', 'Reading Startup.cs', 'Listing call sites'];
  const STEPS_MAIN = ['Waiting for 3 agents', 'Reading agent results', 'Editing OrderImporter.cs', 'Running the build'];
  const STEPS_B = ['Running a search query', 'Reading 2,140 results', 'Grouping by region', 'Writing the summary sheet'];

  const IDLE = [
    ['Wiki update', 25], ['Price list check', 48], ['Slow page check', 95], ['Kickoff notes', 130], ['Data export', 190],
    ['Vendor review', 260], ['Release notes', 380], ['Test data setup', 1300], ['Invoice query', 1500]
  ];

  const pick = (list, t, every) => list[Math.floor(t / every) % list.length];

  function snapshot(now, frozenT) {
    const loopMs = LOOP * 1000;
    const base = frozenT != null ? now - frozenT * 1000 : Math.floor(now / loopMs) * loopMs;
    const t = (now - base) / 1000;
    const at = (sec) => base + sec * 1000;

    const agent = (id, name, type, startSec, endSec, steps, tools) => {
      if (t < startSec) return null;
      const done = t >= endSec;
      return {
        id, name, type, state: done ? 'done' : 'running',
        step: done ? `Finished, ${tools} tool calls` : pick(steps, t, 3),
        startedAt: at(startSec), endedAt: done ? at(endSec) : null,
        etaAt: done ? null : at(endSec + 2), tools
      };
    };

    const agentsA = [
      agent('a1', 'Find duplicate orders', 'Explore', -4.6 * MIN, -1.4 * MIN, STEPS_C, 38),
      agent('a2', 'Check v2 store writes', 'general-purpose', -2.7 * MIN, 15, STEPS_A, 24),
      agent('a3', 'Run importer unit tests', 'general-purpose', -1.1 * MIN, 27, STEPS_T, 9),
      agent('a4', 'List callers of old importer', 'Explore', 5, 21, STEPS_C, 12)
    ].filter(Boolean);

    const aDone = t >= 36;
    const taskA = {
      id: 'demo-a', name: 'Order importer v2', project: 'shop-backend', cwd: '',
      state: aDone ? 'done' : 'running',
      startedAt: at(-9.5 * MIN), etaAt: aDone ? null : at(38), etaSource: 'history',
      step: t >= 27 ? pick(STEPS_MAIN.slice(1), t, 3) : STEPS_MAIN[0],
      finishedAt: aDone ? at(36) : null, tookMs: aDone ? (9.5 * MIN + 36) * 1000 : null,
      agents: aDone ? [] : agentsA, agentsTotal: agentsA.length, agentsDone: agentsA.filter((a) => a.state === 'done').length
    };

    const bWaiting = t >= 17 && t < 29;
    const taskB = {
      id: 'demo-b', name: 'Failed payments review', project: 'Reports', cwd: '',
      state: bWaiting ? 'waiting' : 'running',
      waitingFor: bWaiting ? 'Permission needed to run a command' : null,
      startedAt: at(-3 * MIN), etaAt: bWaiting ? null : at(2.4 * MIN), etaSource: 'claude',
      step: pick(STEPS_B, t, 4), agents: [], agentsTotal: 0, agentsDone: 0
    };

    const taskC = {
      id: 'demo-c', name: 'Sprint stats', project: 'Reports', cwd: '', state: 'done',
      finishedAt: at(-2 * MIN), tookMs: 6 * MIN * 1000, agents: [], agentsTotal: 2, agentsDone: 2
    };

    const idle = IDLE.map(([name, mins], i) => ({
      id: 'demo-i' + i, name, project: i % 2 ? 'Reports' : 'shop-backend', cwd: '', state: 'idle',
      idleSince: at(-mins * MIN), agents: [], agentsTotal: 0, agentsDone: 0
    }));

    return { now, demo: true, tasks: [taskB, taskA, taskC, ...idle] };
  }

  global.StickyDemo = { snapshot, LOOP };
})(window);
