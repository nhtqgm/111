const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eastmoneyApi', {
  fetchKLines: (code, period) => ipcRenderer.invoke('eastmoney:fetchKLines', code, period),
});
