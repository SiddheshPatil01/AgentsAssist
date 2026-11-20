'use strict';
/* The only bridge between the sticky page and the app. The page gets these calls and nothing else. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sticky', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, settings) => cb(settings)),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, layout) => cb(layout)),
  ready: () => ipcRenderer.send('ready'),
  ignoreMouse: (ignore) => ipcRenderer.send('ignore-mouse', !!ignore),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  resizeStart: (edge, noteHeight) => ipcRenderer.send('resize-start', edge === 'left' ? 'left' : 'right', Number(noteHeight) || 0),
  resizeEnd: () => ipcRenderer.send('resize-end'),
  resetSize: () => ipcRenderer.send('reset-size'),
  openTask: (id) => ipcRenderer.send('open-task', String(id)),
  dismiss: (id) => ipcRenderer.send('dismiss', String(id)),
  set: (key, value) => ipcRenderer.send('set', String(key), value),
  menu: () => ipcRenderer.send('menu'),
  icons: (icons) => ipcRenderer.send('icons', icons)
});
