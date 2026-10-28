// Desktop contract; UI rendering and interactions remain in app.js.
(() => {
  const invoke = async (action, payload = {}) => {
    try { return await window.__TAURI__.core.invoke('training_room', { request: { action, ...payload } }); }
    catch (error) { throw new Error(typeof error === 'string' ? error : error.message || String(error)); }
  };
  const state = (action, payload) => invoke(action, payload).then(window.presentPlans);
  // IndexedDB keeps the complete last view without localStorage's size limit or JSON parsing on startup.
  const database = new Promise(resolve => {
    try {
      const request = indexedDB.open('training-room-startup', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = request.onblocked = () => {
        request.onsuccess = () => request.result.close();
        resolve(null);
      };
    } catch { resolve(null); }
  });
  const getCachedState = async () => {
    try {
      const db = await database;
      if (!db || !window.__ATR_STARTUP__) return null;
      const cached = await new Promise((resolve, reject) => {
        const request = db.transaction('state').objectStore('state').get('last');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!cached?.account || cached.startupCacheKey !== window.__ATR_STARTUP__.cacheKey) return null;
      return { ...cached, revision: -1, usingCache: true, lastError: '', resourceUpdate: window.__ATR_STARTUP__.resourceUpdate };
    } catch { return null; }
  };
  let savedRevision = -1;
  const cacheState = async next => {
    // Let the new view render before the structured clone is written to disk.
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const db = await database;
      if (!db || next.revision < 0 || next.revision < savedRevision) return false;
      savedRevision = next.revision;
      return await new Promise(resolve => {
        const transaction = db.transaction('state', 'readwrite');
        const store = transaction.objectStore('state');
        if (next.account) store.put(next, 'last');
        else store.delete('last');
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => resolve(false);
      });
    } catch { return false; }
  };
  const subscriptions = [];
  const listen = (event, callback) => {
    const subscription = window.__TAURI__.event.listen(event, value => callback(value.payload));
    subscriptions.push(subscription);
    return () => subscription.then(unlisten => unlisten());
  };
  window.addEventListener('beforeunload', () => subscriptions.forEach(p => p.then(unlisten => unlisten())), { once: true });
  window.trainingRoom = {
    getCachedState,
    cacheState,
    initialUpdateState: window.__ATR_STARTUP__?.updateState,
    getState: () => state('getState'),
    startQrLogin: () => invoke('startQrLogin'),
    finishQrLogin: scanId => invoke('finishQrLogin', { scanId }),
    cancelQrLogin: () => invoke('cancelQrLogin'),
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
    onResourceStateChanged: callback => listen('resource:state-changed', callback),
  };
})();
