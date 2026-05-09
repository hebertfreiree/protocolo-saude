const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  loginAccount: (slotId, platform) => ipcRenderer.invoke('account:login', slotId, platform),
  logoutAccount: (slotId) => ipcRenderer.invoke('account:logout', slotId),
  startDisplay: (cfg) => ipcRenderer.invoke('app:start-display', cfg),
  openSetup: () => ipcRenderer.invoke('app:open-setup'),
  exit: () => ipcRenderer.invoke('app:exit'),
  toggleFullscreen: () => ipcRenderer.invoke('display:toggle-fullscreen'),
  getDebug: () => ipcRenderer.invoke('display:get-debug'),
  onCountsUpdate: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('counts-update', listener);
    return () => ipcRenderer.removeListener('counts-update', listener);
  }
});
