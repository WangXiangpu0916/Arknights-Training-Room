// Desktop contract; UI rendering and interactions remain in app.js.
(() => {
  const invoke = async (action, payload = {}) => {
    try { return await window.__TAURI__.core.invoke('training_room', { request: { action, ...payload } }); }
    catch (error) { throw new Error(typeof error === 'string' ? error : error.message || String(error)); }
  };
  const state = (action, payload) => invoke(action, payload).then(window.presentPlans);
  const subscriptions = [];
  const listen = (event, callback) => {
    const subscription = window.__TAURI__.event.listen(event, value => callback(value.payload));
    subscriptions.push(subscription);
    return () => subscription.then(unlisten => unlisten());
  };
  window.addEventListener('beforeunload', () => subscriptions.forEach(p => p.then(unlisten => unlisten())), { once: true });
  window.trainingRoom = {
    getState: () => state('getState'),
    startQrLogin: () => invoke('startQrLogin'),
    finishQrLogin: scanId => invoke('finishQrLogin', { scanId }),
    getBindings: () => invoke('getBindings'),
    logout: () => state('logout'),
    refreshAccount: uid => state('refreshAccount', { uid }),
    updateGameData: () => state('updateGameData'),
    updateSettings: settings => state('updateSettings', { settings }),
    clearCache: () => state('clearCache'),
    materialDetail: itemId => invoke('materialDetail', { itemId }),
    getUpdateState: () => invoke('getUpdateState'),
    checkForUpdates: () => invoke('checkForUpdates'),
    downloadUpdate: () => invoke('downloadUpdate'),
    installUpdate: () => invoke('installUpdate'),
    onStateChanged: callback => listen('app:state-changed', callback),
    onUpdateStateChanged: callback => listen('update:state-changed', callback),
  };
})();
