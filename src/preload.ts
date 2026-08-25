import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('trainingRoom', {
  getState: () => invoke('app:get-state'),
  startQrLogin: () => invoke('auth:start-qr'),
  finishQrLogin: (scanId: string) => invoke('auth:finish-qr', scanId),
  getBindings: () => invoke('auth:get-bindings'),
  logout: () => invoke('auth:logout'),
  refreshAccount: (uid?: string) => invoke('account:refresh', uid),
  updateGameData: () => invoke('game:update'),
  updateSettings: (settings: unknown) => invoke('settings:update', settings),
  clearCache: () => invoke('cache:clear'),
  materialDetail: (itemId: string) => invoke('material:detail', itemId),
  onStateChanged: (callback: () => void) => ipcRenderer.on('app:state-changed', callback),
});
