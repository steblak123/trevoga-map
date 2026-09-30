const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('bridge', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  getState: () => ipcRenderer.invoke('get-state'),
  getMapData: () => ipcRenderer.invoke('map-data'),
  getSysItems: () => ipcRenderer.invoke('sys-items'),
  onSettings: on('settings'),
  onState: on('state'),
  onOverlay: on('overlay'),
  onSys: on('sys'),
  openSettings: () => ipcRenderer.send('open-settings'),
  wantHistory: (uid) => ipcRenderer.send('want-history', uid),
  testAlert: () => ipcRenderer.send('test-alert'),
  hideOverlay: () => ipcRenderer.send('overlay-hide'),
  overlaySize: (size) => ipcRenderer.send('overlay-size', size),
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  dragStart: () => ipcRenderer.send('drag-start'),
  resizeStart: () => ipcRenderer.send('resize-start'),
  fitHeight: (h) => ipcRenderer.send('fit-height', h),
});
