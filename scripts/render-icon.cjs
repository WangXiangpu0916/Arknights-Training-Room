const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 512, height: 512, frame: false, show: false, transparent: true });
  await window.loadFile(path.join(process.cwd(), 'build', 'icon.svg'));
  await writeFile(path.join(process.cwd(), 'build', 'icon.png'), (await window.capturePage()).toPNG());
  app.quit();
});
