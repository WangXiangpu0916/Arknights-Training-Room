import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { AppService } from './app-service';
import { LocalStore } from './data/local-store';

let mainWindow: BrowserWindow | null = null;
let service: AppService;

if (process.env.ATR_USER_DATA) app.setPath('userData', process.env.ATR_USER_DATA);

function notifyStateChanged(): void {
  mainWindow?.webContents.send('app:state-changed');
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
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    title: '明日方舟专精规划',
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  if (process.env.ATR_SCREENSHOT) {
    await new Promise(resolve => setTimeout(resolve, 700));
    if (process.env.ATR_SCREENSHOT_PAGE) {
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('[data-page="${process.env.ATR_SCREENSHOT_PAGE}"]')?.click()`,
      );
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    await writeFile(process.env.ATR_SCREENSHOT, (await mainWindow.capturePage()).toPNG());
    app.quit();
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('io.github.arknights.trainingroom');
  service = new AppService(new LocalStore());
  await service.initialize();
  registerIpc();
  await createWindow();
  const state = await service.state();
  if (state.loggedIn && state.account && state.settings.autoRefresh) {
    service.refreshAccount().then(notifyStateChanged).catch(() => notifyStateChanged());
  }
});

app.on('window-all-closed', () => app.quit());
