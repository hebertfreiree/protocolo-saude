const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  clearSlotState: (slotId) => ipcRenderer.invoke('slot:clear-state', slotId),
  testSlot: (slotId) => ipcRenderer.invoke('account:test', slotId),
  startDisplay: (cfg) => ipcRenderer.invoke('app:start-display', cfg),
  openSetup: () => ipcRenderer.invoke('app:open-setup'),
  exit: () => ipcRenderer.invoke('app:exit'),
  toggleFullscreen: () => ipcRenderer.invoke('display:toggle-fullscreen'),
  oauthGetCfg: () => ipcRenderer.invoke('oauth:get-cfg'),
  oauthSaveCfg: (cfg) => ipcRenderer.invoke('oauth:save-cfg', cfg),
  oauthLogin: (slotId) => ipcRenderer.invoke('oauth:login', slotId),
  oauthLogout: (slotId) => ipcRenderer.invoke('oauth:logout', slotId),
  oauthStatus: (slotId) => ipcRenderer.invoke('oauth:status', slotId),
  studioImport: (slotId) => ipcRenderer.invoke('studio:import', slotId),
  studioStatus: (slotId) => ipcRenderer.invoke('studio:status', slotId),
  studioClear: (slotId) => ipcRenderer.invoke('studio:clear', slotId),
  onCountsUpdate: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on('counts-update', listener);
    return () => ipcRenderer.removeListener('counts-update', listener);
  }
});
