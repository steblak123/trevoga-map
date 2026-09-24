const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('bridge', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  getState: () => ipcRenderer.invoke('get-state'),
  getMapData: () => ipcRenderer.invoke('map-data'),
  onSettings: on('settings'),
  onState: on('state'),
  onOverlay: on('overlay'),
  openSettings: () => ipcRenderer.send('open-settings'),
  testAlert: () => ipcRenderer.send('test-alert'),
  hideOverlay: () => ipcRenderer.send('overlay-hide'),
  overlayIgnore: (v) => ipcRenderer.send('overlay-ignore', v),
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  contextMenu: () => ipcRenderer.send('context-menu'),
  dragStart: () => ipcRenderer.send('drag-start'),
  resizeStart: () => ipcRenderer.send('resize-start'),
});
