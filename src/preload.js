const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  fetchStats: (options = {}) => ipcRenderer.invoke('stats:fetch', options),
  getConfig: () => ipcRenderer.invoke('config:get'),
  getEditableConfig: () => ipcRenderer.invoke('config:edit'),
  updateConfig: (payload) => ipcRenderer.invoke('config:update', payload),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});

