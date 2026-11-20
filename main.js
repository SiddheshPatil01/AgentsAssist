'use strict';
/* Claude Tasks sticky: a frameless always-on-top note fed by collector.js, plus a tray icon and notifications. */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Collector } = require('./collector');

const argv = process.argv.slice(1);
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const SHOT = argValue('shot');            // debug aid: save a picture of the window to this file, then quit

const NOTE_W = 380;                       // note width at 100% size
const MARGIN = 24;                        // clear space on each side for the shadow and confetti
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.5;
const MIN_H = 160;
const POLL_MS = 1500;
const THEMES = ['auto', 'light', 'dark'];
const APP_ID = app.isPackaged ? 'com.claude.tasks.sticky' : process.execPath;

let win = null;
let tray = null;
let trayKey = '';
let collector = null;
let settings = null;
let lastSnap = null;
let winSize = { width: NOTE_W + MARGIN * 2, height: 800 };
let dragTimer = null;
let resizeLive = null;
let pollBusy = false;
const icons = {};

/* ---------- settings ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const icoFile = () => path.join(app.getPath('userData'), 'icon.ico');

function loadSettings() {
  const loaded = { alwaysOnTop: true, collapsed: false, theme: 'auto', notifications: true, demo: false, x: null, y: null, zoom: 1, h: null };
  try { Object.assign(loaded, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch { /* first run */ }
  if (argv.includes('--demo')) loaded.demo = true;
  if (argValue('zoom')) loaded.zoom = Number(argValue('zoom'));
  if (THEMES.includes(argValue('theme'))) loaded.theme = argValue('theme');
  if (argValue('collapsed')) loaded.collapsed = argValue('collapsed') === '1';
  return loaded;
}

function saveSettings() {
  if (SHOT) return;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch { /* settings are a convenience; never crash over them */ }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendSettings() {
  send('settings', { theme: settings.theme, alwaysOnTop: !!settings.alwaysOnTop, collapsed: !!settings.collapsed, demo: !!settings.demo });
}

function applySetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'alwaysOnTop' && win) win.setAlwaysOnTop(!!value, 'floating');
  sendSettings();
}

/* ---------- window ---------- */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
// The note's scale: 1 = 380 wide. The window is always exactly the note plus its margins.
const zoom = () => clamp(Number(settings && settings.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
const widthFor = (z) => Math.round(NOTE_W * z + MARGIN * 2);

function defaultCorner() {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - widthFor(zoom()) - 4, y: area.y + 4 };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  winSize = { width: widthFor(zoom()), height: Math.min(area.height, 1200) };
  let spot = Number.isFinite(settings.x) && Number.isFinite(settings.y) ? { x: settings.x, y: settings.y } : defaultCorner();
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return spot.x + winSize.width > a.x + 60 && spot.x < a.x + a.width - 60 && spot.y >= a.y - 12 && spot.y < a.y + a.height - 80;
  });
  if (!onScreen) spot = defaultCorner();

  win = new BrowserWindow({
    x: spot.x, y: spot.y, width: winSize.width, height: winSize.height,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: !!settings.alwaysOnTop, title: 'Claude Tasks',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false
    }
  });
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  // The window is taller than the note. Clicks pass through until the page says the mouse is over the note.
  win.setIgnoreMouseEvents(true, { forward: true });

  const query = {};
  if (argValue('t')) query.t = argValue('t');
  if (argv.includes('--preview')) query.preview = '1';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (SHOT) {
    // invisible and click-through while pictures are taken, so it never gets in the way on screen
    win.setOpacity(0);
    win.webContents.once('did-finish-load', () => runShot().catch((e) => console.error(String(e))).finally(() => app.quit()));
  }
}

/*
 * Picture helper, used for the images in the README. `--shot=<file.png>` saves the note and quits.
 *   --demo --t=12          sample data frozen at second 12 of its 56 second loop
 *   --demo --at=37         sample data running: take the picture at that second of the loop
 *   --frames=48 --fps=8    save a numbered series (file-000.png ...) of the whole window, for an animation
 *   --preview              a wallpaper behind the note instead of a see-through background
 */
async function runShot() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (argValue('at')) {
    const loop = 56000;
    let wait = (Number(argValue('at')) * 1000 - (Date.now() % loop) + loop) % loop;
    if (wait < 4000) wait += loop;      // the page must first see the task running, or nothing "finishes"
    await sleep(wait);
  } else {
    await sleep(Number(argValue('delay')) || 4000);
  }

  const frames = Number(argValue('frames')) || 0;
  if (frames) {
    // Frames are kept in memory and written afterwards: saving inside the loop is too slow to keep the pace.
    const gap = 1000 / (Number(argValue('fps')) || 8);
    const shots = [];
    const zero = Date.now();
    for (let i = 0; i < frames; i++) {
      const started = Date.now();
      shots.push({ at: started - zero, image: (await win.webContents.capturePage()).resize({ width: Number(argValue('width')) || 432 }) });
      await sleep(Math.max(0, gap - (Date.now() - started)));
    }
    shots.forEach((shot, i) => fs.writeFileSync(SHOT.replace(/\.png$/i, `-${String(i).padStart(3, '0')}.png`), shot.image.toPNG()));
    fs.writeFileSync(SHOT.replace(/\.png$/i, '-times.json'), JSON.stringify(shots.map((shot) => shot.at)));
    return;
  }

  // one picture, cut to the note plus room for its shadow
  const r = await win.webContents.executeJavaScript(`(() => { const r = document.getElementById('sticky').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const size = win.getContentBounds();
  const x = Math.max(0, Math.floor(r.x - 22));
  const y = Math.max(0, Math.floor(r.y - 10));
  const rect = { x, y, width: Math.min(size.width - x, Math.ceil(r.width + 44)), height: Math.min(size.height - y, Math.ceil(r.height + 46)) };
  fs.writeFileSync(SHOT, (await win.webContents.capturePage(rect)).toPNG());
}

// Sizes are sent in screen units; the page divides by the scale itself.
function sendLayout(live) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const maxHeight = Math.round(Math.max(MIN_H, Math.min(b.height - 40, area.y + area.height - b.y - 30)));
  const height = live ? live.h : settings.h;
  send('layout', {
    zoom: live ? live.zoom : zoom(),
    maxHeight,
    height: Number.isFinite(height) && height > 0 ? Math.min(Math.round(height), maxHeight) : null,
    anchor: b.x + b.width / 2 > area.x + area.width / 2 ? 'right' : 'left'
  });
}

// Scale and height chosen from the menu or a reset. The note keeps the screen side it sits on.
function applySize(z, h) {
  if (!win) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const width = widthFor(clamp(z, MIN_ZOOM, MAX_ZOOM));
  const onRight = b.x + b.width / 2 > area.x + area.width / 2;
  // winSize, not b.width: Windows reports the window a few pixels wider than asked, which would creep the note sideways
  const x = onRight ? b.x + winSize.width - width : b.x;
  winSize.width = width;
  win.setBounds({ x, y: b.y, width, height: winSize.height });
  settings.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
  settings.h = h;
  settings.x = x;
  settings.y = b.y;
  saveSettings();
  sendLayout();
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
}

function resetPosition() {
  if (!win) return;
  const spot = defaultCorner();
  win.setBounds({ x: spot.x, y: spot.y, width: winSize.width, height: winSize.height });
  settings.x = spot.x;
  settings.y = spot.y;
  saveSettings();
  sendLayout();
  win.showInactive();
}

/* ---------- menu, tray, notifications ---------- */
const loginArgs = () => ({ path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide sticky' : 'Show sticky', click: toggleVisible },
    { type: 'separator' },
    { label: 'Always on top', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (item) => applySetting('alwaysOnTop', item.checked) },
    { label: 'Small bar', type: 'checkbox', checked: !!settings.collapsed, click: (item) => applySetting('collapsed', item.checked) },
    {
      label: 'Theme',
      submenu: THEMES.map((theme) => ({
        label: theme === 'auto' ? 'Same as Windows' : theme === 'light' ? 'Light' : 'Dark',
        type: 'radio', checked: settings.theme === theme, click: () => applySetting('theme', theme)
      }))
    },
    {
      label: 'Size',
      submenu: [
        ...[['Small', 0.75], ['Normal', 1], ['Large', 1.25]].map(([label, z]) => ({
          label, type: 'radio', checked: Math.abs(zoom() - z) < 0.01, click: () => applySize(z, null)
        })),
        { type: 'separator' },
        { label: 'Or drag a bottom corner of the note', enabled: false }
      ]
    },
    { label: 'Notifications', type: 'checkbox', checked: settings.notifications !== false, click: (item) => applySetting('notifications', item.checked) },
    {
      label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(loginArgs()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginArgs() })
    },
    { type: 'separator' },
    { label: 'Demo mode (sample data)', type: 'checkbox', checked: !!settings.demo, click: (item) => applySetting('demo', item.checked) },
    { label: 'Move back to the corner', click: resetPosition },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function createTray() {
  tray = new Tray(icons.tray);
  tray.setToolTip('Claude Tasks');
  tray.on('click', toggleVisible);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

function updateTray(snap) {
  if (!tray || settings.demo) return;
  const count = (state) => snap.tasks.filter((t) => t.state === state).length;
  const waiting = count('waiting');
  const running = count('running');
  const done = count('done');
  const key = waiting ? 'trayWait' : running ? 'trayBusy' : done ? 'trayDone' : 'tray';
  if (key !== trayKey && icons[key]) { tray.setImage(icons[key]); trayKey = key; }
  tray.setToolTip(waiting ? `Claude needs you (${waiting})`
    : running ? `${running} task${running === 1 ? '' : 's'} running`
    : done ? `${done} repl${done === 1 ? 'y' : 'ies'} ready` : 'Claude Tasks: all quiet');
}

function words(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function notify(event) {
  if (settings.demo || settings.notifications === false || !Notification.isSupported()) return;
  const finished = event.type === 'finished';
  const note = new Notification({
    title: finished ? `${event.name} is done` : `${event.name} needs you`,
    body: finished ? (event.tookMs ? `Took ${words(event.tookMs)}. The reply is ready.` : 'The reply is ready.') : (event.waitingFor || 'Waiting for your input'),
    icon: icons.app || undefined
  });
  note.on('click', () => openChat(String(event.id)));
  note.show();
}

/* ---------- actions ---------- */
// Brings the VS Code window of that folder to the front. Returns true when VS Code was asked to do it.
function openInEditor(cwd) {
  if (!cwd) return false;
  try { if (!fs.statSync(cwd).isDirectory()) return false; } catch { return false; }
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe')
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) { shell.openPath(cwd); return false; }
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [cwd], { detached: true, stdio: 'ignore', env }).unref();
  return true;
}

// Opens one chat. The Claude extension's own link shows the tab of that session if it is open, else resumes it.
// The link goes to whichever VS Code window is in front, so the right window is brought forward first.
function openChat(id) {
  const cwd = collector.cwdOf(id);
  if (!cwd) return;
  const fronted = openInEditor(cwd);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  setTimeout(() => {
    shell.openExternal(`vscode://anthropic.claude-code/open?session=${id}`).catch(() => {});
  }, fronted ? 900 : 0);
}

function writeIco(png) {
  // A .ico file may simply wrap one 256px PNG.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  fs.mkdirSync(path.dirname(icoFile()), { recursive: true });
  fs.writeFileSync(icoFile(), Buffer.concat([header, png]));
}

// Made once each. The Start Menu one is also what lets Windows show this app's notifications.
function ensureShortcut() {
  if (process.platform !== 'win32' || SHOT || app.isPackaged) return;
  const links = {
    shortcutMade: path.join(app.getPath('desktop'), 'Claude Tasks.lnk'),
    startMenuMade: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Tasks.lnk')
  };
  for (const [flag, link] of Object.entries(links)) {
    if (settings[flag]) continue;
    const made = shell.writeShortcutLink(link, 'create', {
      target: process.execPath, args: `"${app.getAppPath()}"`, cwd: app.getAppPath(),
      description: 'Running Claude Code tasks and agents', icon: icoFile(), iconIndex: 0, appUserModelId: APP_ID
    });
    if (made) { settings[flag] = true; saveSettings(); }
  }
}

/* ---------- data loop ---------- */
async function poll() {
  if (pollBusy || !collector) return;
  pollBusy = true;
  try {
    const snap = await collector.poll();
    lastSnap = snap;
    send('snapshot', snap);
    for (const event of snap.events) notify(event);
    updateTray(snap);
  } catch (e) {
    console.error('[main:poll]', e && e.message);
  } finally {
    pollBusy = false;
  }
}

/* ---------- messages from the page ---------- */
function wireIpc() {
  ipcMain.on('ready', () => {
    sendSettings();
    sendLayout();
    if (lastSnap) send('snapshot', lastSnap);
  });
  ipcMain.on('ignore-mouse', (_e, ignore) => {
    if (win && !dragTimer && !SHOT) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });
  ipcMain.on('drag-start', () => {
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const startedAt = Date.now();
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (Date.now() - startedAt > 60000) { clearInterval(dragTimer); dragTimer = null; return; }
      const p = screen.getCursorScreenPoint();
      win.setBounds({ x: b.x + p.x - cursor.x, y: b.y + p.y - cursor.y, width: winSize.width, height: winSize.height });
    }, 12);
  });
  ipcMain.on('drag-end', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    if (!win) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(b.x, area.x - 20), area.x + area.width - winSize.width + 20);
    const y = Math.min(Math.max(b.y, area.y - 8), area.y + area.height - 120);
    win.setBounds({ x, y, width: winSize.width, height: winSize.height });
    settings.x = x;
    settings.y = y;
    saveSettings();
    sendLayout();
  });
  // Dragging a bottom corner: sideways changes the scale of the whole note, up / down changes its height.
  ipcMain.on('resize-start', (_e, edge, noteHeight) => {
    if (!win) return;
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const startW = NOTE_W * zoom();
    const startWin = winSize.width;
    const startH = Number(noteHeight) || MIN_H;
    const maxH = Math.max(MIN_H, area.y + area.height - b.y - 30);
    const startedAt = Date.now();
    resizeLive = { zoom: zoom(), h: settings.h };
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (Date.now() - startedAt > 60000) { clearInterval(dragTimer); dragTimer = null; return; }
      const p = screen.getCursorScreenPoint();
      const dx = (p.x - cursor.x) * (edge === 'left' ? -1 : 1);
      const dy = p.y - cursor.y;
      const z = Math.round(clamp((startW + dx) / NOTE_W, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
      // The height stays automatic unless the corner is really pulled up or down.
      const h = settings.h || Math.abs(dy) > 12 ? Math.round(clamp(startH + dy, MIN_H, maxH)) : null;
      if (z === resizeLive.zoom && h === resizeLive.h) return;
      resizeLive = { zoom: z, h };
      const width = widthFor(z);
      winSize.width = width;
      win.setBounds({ x: edge === 'left' ? b.x + startWin - width : b.x, y: b.y, width, height: winSize.height });
      sendLayout(resizeLive);
    }, 12);
  });
  ipcMain.on('resize-end', () => {
    clearInterval(dragTimer);
    dragTimer = null;
    if (!win || !resizeLive) return;
    const b = win.getBounds();
    settings.zoom = resizeLive.zoom;
    settings.h = resizeLive.h;
    settings.x = b.x;
    settings.y = b.y;
    resizeLive = null;
    saveSettings();
    sendLayout();
  });
  ipcMain.on('reset-size', () => applySize(1, null));
  ipcMain.on('open-task', (_e, id) => openChat(String(id)));
  ipcMain.on('dismiss', (_e, id) => collector.dismiss(String(id)));
  ipcMain.on('set', (_e, key, value) => {
    if (key === 'alwaysOnTop' || key === 'collapsed') applySetting(key, !!value);
    else if (key === 'theme' && THEMES.includes(value)) applySetting(key, value);
  });
  ipcMain.on('menu', () => buildMenu().popup({ window: win }));
  ipcMain.on('icons', (_e, data) => {
    if (!data || typeof data !== 'object') return;
    const isPng = (v) => typeof v === 'string' && v.startsWith('data:image/png;base64,');
    for (const key of ['tray', 'trayBusy', 'trayWait', 'trayDone']) {
      if (isPng(data[key])) icons[key] = nativeImage.createFromDataURL(data[key]).resize({ width: 32, height: 32, quality: 'best' });
    }
    if (isPng(data.app256)) {
      icons.app = nativeImage.createFromDataURL(data.app256);
      try { writeIco(Buffer.from(data.app256.split(',')[1], 'base64')); } catch { /* icon file is optional */ }
    }
    if (!tray && icons.tray && !SHOT) createTray();
    try { ensureShortcut(); } catch { /* shortcut is optional */ }
  });
}

/* ---------- start ---------- */
if (SHOT) app.setPath('userData', path.join(app.getPath('temp'), 'claude-sticky-shot'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  app.on('second-instance', () => { if (win) win.showInactive(); });
  app.on('window-all-closed', () => { /* keep living in the tray */ });
  app.whenReady().then(() => {
    settings = loadSettings();
    collector = new Collector();
    wireIpc();
    createWindow();
    screen.on('display-metrics-changed', sendLayout);
    poll();
    setInterval(poll, POLL_MS);
  });
}
