const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eastmoneyApi', {
  fetchKLines: (code, period, options) => ipcRenderer.invoke('eastmoney:fetchKLines', code, period, options),
});

contextBridge.exposeInMainWorld('appUpdateApi', {
  getCurrentVersion: () => ipcRenderer.invoke('app:getVersion'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});

contextBridge.exposeInMainWorld('appStorageApi', {
  bootstrap: (storage) => ipcRenderer.invoke('app-storage:bootstrap', storage),
  save: (storage) => ipcRenderer.invoke('app-storage:save', storage),
});
