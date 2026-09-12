import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AppService } from './app-service';
import { LocalStore } from './data/local-store';

let mainWindow: BrowserWindow | null = null;
let service: AppService;
const FIXED_WINDOW_WIDTH = 1360;
const FIXED_WINDOW_HEIGHT = 800;
const qaEnvironmentEnabled = !app.isPackaged;

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

if (qaEnvironmentEnabled && process.env.ATR_USER_DATA) app.setPath('userData', process.env.ATR_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'atr-resource', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function notifyStateChanged(): void {
  mainWindow?.webContents.send('app:state-changed');
}

function setUpdateState(patch: Partial<UpdateState>): UpdateState {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send('update:state-changed', updateState);
  return updateState;
}

function friendlyUpdateError(error: unknown, action = '检查更新'): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\b404\b|not found/i.test(detail)) return `${action}失败：GitHub 发布源当前不可用（HTTP 404），请稍后重试。`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(detail)) {
    return `${action}失败：无法连接 GitHub，请检查网络后重试。`;
  }
  return `${action}失败：暂时无法获取版本信息，请稍后重试。`;
}

function reportUpdateError(event: string, error: unknown, action: string): UpdateState {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  void service?.store.log(event, detail);
  return setUpdateState({ phase: 'error', message: friendlyUpdateError(error, action) });
}

function applyTheme(theme: 'system' | 'black' | 'light'): void {
  nativeTheme.themeSource = theme === 'black' ? 'dark' : theme;
  mainWindow?.webContents.send('theme:changed', { theme, dark: nativeTheme.shouldUseDarkColors });
}

function configureUpdater(): void {
  if (!updateSupported) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = true;
  autoUpdater.channel = 'beta'; // Skip non-semver resource releases in the shared repository.
  autoUpdater.on('checking-for-update', () => setUpdateState({ phase: 'checking', message: '正在检查 GitHub Releases…' }));
  autoUpdater.on('update-not-available', () => setUpdateState({ phase: 'current', message: '当前已是最新测试版本。', availableVersion: undefined, progress: undefined }));
  autoUpdater.on('update-available', info => setUpdateState({ phase: 'available', message: `发现新测试版本 v${info.version}，可选择下载更新。`, availableVersion: info.version, progress: undefined }));
  autoUpdater.on('download-progress', progress => setUpdateState({ phase: 'downloading', message: `正在下载 v${updateState.availableVersion ?? ''}…`, progress: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', info => setUpdateState({ phase: 'ready', message: `v${info.version} 已下载，重启应用即可安装。`, availableVersion: info.version, progress: 100 }));
  autoUpdater.on('error', error => reportUpdateError('auto-update-error', error, '更新'));
}

function registerIpc(): void {
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
  const secureHandle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      const frameUrl = event.senderFrame?.url ?? '';
      const trustedUrl = frameUrl === rendererUrl
        || frameUrl.startsWith(`${rendererUrl}?`)
        || frameUrl.startsWith(`${rendererUrl}#`);
      if (!mainWindow
        || event.sender !== mainWindow.webContents
        || event.senderFrame !== event.sender.mainFrame
        || !trustedUrl) {
        throw new Error('拒绝来自非应用主窗口的 IPC 请求');
      }
      return service.exclusive(() => listener(event, ...args));
    });
  };
  const requiredText = (value: unknown, label: string, maxLength: number): string => {
    if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
      throw new Error(`${label}格式无效`);
    }
    return value;
  };

  secureHandle('app:get-state', () => service.state());
  secureHandle('auth:start-qr', async () => {
    await service.store.log('qr-login-start');
    return service.skland.startQrLogin();
  });
  secureHandle('auth:finish-qr', async (_event, scanId: unknown) => {
    const bindings = await service.skland.finishQrLogin(requiredText(scanId, '扫码标识', 128));
    service.credentialsChanged();
    await service.store.log('qr-login-success');
    notifyStateChanged();
    return bindings;
  });
  secureHandle('auth:get-bindings', () => service.skland.getBindings());
  secureHandle('auth:logout', async () => {
    return service.logout();
  });
  secureHandle('account:refresh', async (_event, uid?: unknown) => {
    return service.refreshAccount(uid === undefined ? undefined : requiredText(uid, '角色 UID', 64));
  });
  secureHandle('game:update', async () => {
    const next = await service.updateGameData();
    notifyStateChanged();
    return next;
  });
  secureHandle('settings:update', async (_event, settings) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('设置内容格式无效');
    }
    const result = await service.updateSettings(settings);
    applyTheme(result.settings.theme);
    return result;
  });
  secureHandle('cache:clear', async () => {
    return service.clearCache();
  });
  secureHandle('material:detail', (_event, itemId: unknown) => service.materialDetail(requiredText(itemId, '材料标识', 128)));
  secureHandle('update:get-state', () => updateState);
  secureHandle('update:check', async () => {
    if (!updateSupported) return updateState;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      reportUpdateError('update-check-failure', error, '检查更新');
    }
    return updateState;
  });
  secureHandle('update:download', async () => {
    if (!updateSupported || updateState.phase !== 'available') return updateState;
    try {
      setUpdateState({ phase: 'downloading', message: `正在下载 v${updateState.availableVersion ?? ''}…`, progress: 0 });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      reportUpdateError('update-download-failure', error, '下载更新');
    }
    return updateState;
  });
  secureHandle('update:install', () => {
    if (!updateSupported || updateState.phase !== 'ready') return updateState;
    setUpdateState({ phase: 'installing', message: '正在重启并安装更新…' });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return updateState;
  });
}

async function createWindow(theme: 'system' | 'black' | 'light'): Promise<void> {
  const screenshotEnabled = qaEnvironmentEnabled && Boolean(process.env.ATR_SCREENSHOT);
  const width = screenshotEnabled ? Number(process.env.ATR_WINDOW_WIDTH) || FIXED_WINDOW_WIDTH : FIXED_WINDOW_WIDTH;
  const height = screenshotEnabled ? Number(process.env.ATR_WINDOW_HEIGHT) || FIXED_WINDOW_HEIGHT : FIXED_WINDOW_HEIGHT;
  const backgroundColor = theme === 'light'
    ? '#dfe7ed'
    : theme === 'black' || nativeTheme.shouldUseDarkColors ? '#0f0f0f' : '#dfe7ed';
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
    backgroundColor,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: qaEnvironmentEnabled,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => {
    if (!qaEnvironmentEnabled || !process.env.ATR_QA_HIDDEN) mainWindow?.show();
  });
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { theme },
  });
  if (qaEnvironmentEnabled && process.env.ATR_WINDOW_POLICY_REPORT) {
    await writeFile(process.env.ATR_WINDOW_POLICY_REPORT, JSON.stringify({
      bounds: mainWindow.getBounds(),
      backgroundColor: mainWindow.getBackgroundColor(),
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
  if (screenshotEnabled && process.env.ATR_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 700));
    if (process.env.ATR_SCREENSHOT_PAGE) {
      await mainWindow.webContents.executeJavaScript(
        `page = ${JSON.stringify(process.env.ATR_SCREENSHOT_PAGE)}; render()`,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (process.env.ATR_SCREENSHOT_INVENTORY_ITEM) {
      const inventoryItem = JSON.stringify(process.env.ATR_SCREENSHOT_INVENTORY_ITEM);
      await mainWindow.webContents.executeJavaScript(
        `[...document.querySelectorAll('[data-inventory-item]')].find(element => element.dataset.inventoryItem === ${inventoryItem})?.click()`,
      );
      await new Promise(resolve => setTimeout(resolve, Number(process.env.ATR_SCREENSHOT_DELAY) || 1200));
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
    if (process.env.ATR_SCREENSHOT_OPERATOR_FILTER) {
      const operatorFilter = JSON.stringify(process.env.ATR_SCREENSHOT_OPERATOR_FILTER);
      await mainWindow.webContents.executeJavaScript(
        `(() => {
          const region = [...document.querySelectorAll('[data-operator-filter-region]')]
            .find(element => element.dataset.operatorFilterRegion === ${operatorFilter});
          if (!region) return;
          region.classList.add('open');
          region.querySelector('[data-operator-filter-panel]').hidden = false;
          region.querySelector('[data-operator-panel-trigger]').setAttribute('aria-expanded', 'true');
        })()`,
      );
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
  service = new AppService(new LocalStore(), {
    bundledDirectory: app.isPackaged ? path.join(process.resourcesPath, 'training-room-resource') : process.env.ATR_RESOURCE_BUNDLED_DIR || path.join(app.getAppPath(), 'dist', 'resource', 'snapshot'),
    appVersion: app.getVersion(),
    // Electron networking respects the desktop's proxy configuration.
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, init),
    ...(qaEnvironmentEnabled && process.env.ATR_RESOURCE_MANIFEST_URL ? {
      manifestUrl: process.env.ATR_RESOURCE_MANIFEST_URL,
      allowLoopback: true,
    } : {}),
  });
  await service.initialize();
  protocol.handle('atr-resource', async request => {
    try {
      const url = new URL(request.url);
      return await service.exclusive(async () => {
        const [version, ...segments] = url.pathname.slice(1).split('/');
        const file = url.hostname === 'snapshot' ? service.gameProvider.assetPath(version, decodeURIComponent(segments.join('/'))) : undefined;
        if (qaEnvironmentEnabled && process.env.ATR_RESOURCE_TRACE) console.log('ATR-RESOURCE', request.url, file ?? 'NOT_FOUND');
        if (!file) return new Response('Resource not found', { status: 404 });
        const bytes = await readFile(file);
        return new Response(bytes, { headers: { 'Content-Type': file.endsWith('.svg') ? 'image/svg+xml' : 'image/png', 'Cache-Control': 'no-store' } });
      });
    } catch (error) {
      if (qaEnvironmentEnabled && process.env.ATR_RESOURCE_TRACE) console.error('ATR-RESOURCE-ERROR', error);
      return new Response('Invalid resource path', { status: 400 });
    }
  });
  const startup = await service.startupContext();
  applyTheme(startup.theme);
  configureUpdater();
  registerIpc();
  await createWindow(startup.theme);
  if (startup.loggedIn && startup.hasAccount && startup.autoRefresh) {
    service.exclusive(() => service.refreshAccount()).then(notifyStateChanged).catch(() => notifyStateChanged());
  }
});

app.on('window-all-closed', () => app.quit());
