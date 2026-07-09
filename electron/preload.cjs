const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eastmoneyApi', {
  fetchKLines: (code, period) => ipcRenderer.invoke('eastmoney:fetchKLines', code, period),
});

contextBridge.exposeInMainWorld('appUpdateApi', {
  getCurrentVersion: () => ipcRenderer.invoke('app:getVersion'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
