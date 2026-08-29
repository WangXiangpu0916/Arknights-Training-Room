import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { AppService } from './app-service';
import { LocalStore } from './data/local-store';

let mainWindow: BrowserWindow | null = null;
let service: AppService;
const FIXED_WINDOW_WIDTH = 1530;
const FIXED_WINDOW_HEIGHT = 800;

type UpdatePhase = 'idle' | 'unsupported' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
type UpdateState = {
  currentVersion: string;
  supported: boolean;
  phase: UpdatePhase;
  message: string;
  availableVersion?: string;
  progress?: number;
};

const updateSupported = app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
let updateState: UpdateState = {
  currentVersion: app.getVersion(),
  supported: updateSupported,
  phase: updateSupported ? 'idle' : 'unsupported',
  message: updateSupported ? '可从 GitHub Releases 检查新的测试版本。' : '自动更新仅支持 Windows 安装版。',
};

if (process.env.ATR_USER_DATA) app.setPath('userData', process.env.ATR_USER_DATA);

function notifyStateChanged(): void {
  mainWindow?.webContents.send('app:state-changed');
}

function setUpdateState(patch: Partial<UpdateState>): UpdateState {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send('update:state-changed', updateState);
  return updateState;
}

function configureUpdater(): void {
  if (!updateSupported) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.on('checking-for-update', () => setUpdateState({ phase: 'checking', message: '正在检查 GitHub Releases…' }));
  autoUpdater.on('update-not-available', () => setUpdateState({ phase: 'current', message: '当前已是最新测试版本。', availableVersion: undefined, progress: undefined }));
  autoUpdater.on('update-available', info => setUpdateState({ phase: 'available', message: `发现新测试版本 v${info.version}，可选择下载更新。`, availableVersion: info.version, progress: undefined }));
  autoUpdater.on('download-progress', progress => setUpdateState({ phase: 'downloading', message: `正在下载 v${updateState.availableVersion ?? ''}…`, progress: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', info => setUpdateState({ phase: 'ready', message: `v${info.version} 已下载，重启应用即可安装。`, availableVersion: info.version, progress: 100 }));
  autoUpdater.on('error', error => setUpdateState({ phase: 'error', message: `更新失败：${error.message}` }));
}

function registerIpc(): void {
  ipcMain.handle('app:get-state', () => service.state());
  ipcMain.handle('auth:start-qr', async () => {
    await service.store.log('qr-login-start');
    return service.skland.startQrLogin();
  });
  ipcMain.handle('auth:finish-qr', async (_event, scanId: string) => {
    const bindings = await service.skland.finishQrLogin(scanId);
    await service.store.log('qr-login-success');
    notifyStateChanged();
    return bindings;
  });
  ipcMain.handle('auth:get-bindings', () => service.skland.getBindings());
  ipcMain.handle('auth:logout', async () => {
    const result = await service.logout();
    notifyStateChanged();
    return result;
  });
  ipcMain.handle('account:refresh', async (_event, uid?: string) => {
    const result = await service.refreshAccount(uid);
    notifyStateChanged();
    return result;
  });
  ipcMain.handle('game:update', async () => {
    const result = await service.updateGameData();
    notifyStateChanged();
    return result;
  });
  ipcMain.handle('settings:update', async (_event, settings) => {
    const result = await service.updateSettings(settings);
    notifyStateChanged();
    return result;
  });
  ipcMain.handle('cache:clear', async () => {
    const result = await service.clearCache();
    notifyStateChanged();
    return result;
  });
  ipcMain.handle('material:detail', (_event, itemId: string) => service.materialDetail(itemId));
  ipcMain.handle('update:get-state', () => updateState);
  ipcMain.handle('update:check', async () => {
    if (!updateSupported) return updateState;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      setUpdateState({ phase: 'error', message: `检查更新失败：${error instanceof Error ? error.message : String(error)}` });
    }
    return updateState;
  });
  ipcMain.handle('update:download', async () => {
    if (!updateSupported || updateState.phase !== 'available') return updateState;
    try {
      setUpdateState({ phase: 'downloading', message: `正在下载 v${updateState.availableVersion ?? ''}…`, progress: 0 });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      setUpdateState({ phase: 'error', message: `下载更新失败：${error instanceof Error ? error.message : String(error)}` });
    }
    return updateState;
  });
  ipcMain.handle('update:install', () => {
    if (!updateSupported || updateState.phase !== 'ready') return updateState;
    setUpdateState({ phase: 'installing', message: '正在重启并安装更新…' });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return updateState;
  });
}

async function createWindow(): Promise<void> {
  const width = process.env.ATR_SCREENSHOT ? Number(process.env.ATR_WINDOW_WIDTH) || FIXED_WINDOW_WIDTH : FIXED_WINDOW_WIDTH;
  const height = process.env.ATR_SCREENSHOT ? Number(process.env.ATR_WINDOW_HEIGHT) || FIXED_WINDOW_HEIGHT : FIXED_WINDOW_HEIGHT;
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: width,
    maxWidth: width,
    minHeight: height,
    maxHeight: height,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    title: '训练室',
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#101317',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.ATR_WINDOW_POLICY_REPORT) {
    await writeFile(process.env.ATR_WINDOW_POLICY_REPORT, JSON.stringify({
      bounds: mainWindow.getBounds(),
      minimumSize: mainWindow.getMinimumSize(),
      maximumSize: mainWindow.getMaximumSize(),
      resizable: mainWindow.isResizable(),
      maximizable: mainWindow.isMaximizable(),
      minimizable: mainWindow.isMinimizable(),
      movable: mainWindow.isMovable(),
      closable: mainWindow.isClosable(),
      fullscreenable: mainWindow.isFullScreenable(),
    }, null, 2));
  }
  mainWindow.once('ready-to-show', () => {
    if (!process.env.ATR_QA_HIDDEN) mainWindow?.show();
  });
  if (process.env.ATR_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 700));
    if (process.env.ATR_SCREENSHOT_PAGE) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('[data-page="${process.env.ATR_SCREENSHOT_PAGE}"]')?.click()`,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (process.env.ATR_SCREENSHOT_MODE) {
      const continuous = process.env.ATR_SCREENSHOT_MODE === 'continuous';
      await mainWindow.webContents.executeJavaScript(
        `(() => { const input = document.querySelector('[data-continuous-mode]'); if (input && input.checked !== ${continuous}) input.click(); })()`,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (process.env.ATR_SCREENSHOT_SCROLL) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('main')?.scrollTo({ top: document.querySelector('main').scrollHeight, behavior: 'instant' })`,
      );
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (process.env.ATR_SCREENSHOT_CANDIDATE === 'hover') {
      const point = await mainWindow.webContents.executeJavaScript(
        `(() => { const rect = document.querySelector('.candidate')?.getBoundingClientRect(); return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null; })()`,
      );
      if (point) mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (process.env.ATR_SCREENSHOT_CANDIDATE === 'open') {
      await mainWindow.webContents.executeJavaScript(`document.querySelector('.candidate')?.click()`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (process.env.ATR_SCREENSHOT_DELAY) {
      await new Promise(resolve => setTimeout(resolve, Number(process.env.ATR_SCREENSHOT_DELAY)));
    }
    await writeFile(process.env.ATR_SCREENSHOT, (await mainWindow.capturePage()).toPNG());
    app.quit();
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.arknights.trainingroom');
  service = new AppService(new LocalStore());
  await service.initialize();
  configureUpdater();
  registerIpc();
  await createWindow();
  const state = await service.state();
  if (state.loggedIn && state.account && state.settings.autoRefresh) {
    service.refreshAccount().then(notifyStateChanged).catch(() => notifyStateChanged());
  }
});

app.on('window-all-closed', () => app.quit());
