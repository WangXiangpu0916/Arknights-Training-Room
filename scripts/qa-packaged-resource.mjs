import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const executable = path.join(root, 'release/win-unpacked/训练室.exe');
const expectedApp = JSON.parse(await readFile('package.json', 'utf8')).version;
let bundled = JSON.parse(await readFile('release/win-unpacked/resources/training-room-resource/manifest.json', 'utf8'));
const runtime = await mkdtemp(path.join(tmpdir(), 'atr-packaged-resource-'));
const output = path.join(root, 'output/packaged-resource-qa');
await mkdir(output, { recursive: true });
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${runtime}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { childOutput = `${childOutput}${bytes}`.slice(-6000); });
let socket; let serial = 0;
const pending = new Map();
const responses = new Map();
const exceptions = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30_000);
  pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
  return value.result.value;
};
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
try {
  let target;
  const deadline = Date.now() + 60_000;
  while (!target && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited: ${childOutput}`);
    target = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).then(t => t.find(t => t.type === 'page')).catch(() => undefined);
    if (!target) await pause();
  }
  assert.ok(target, `Packaged app never opened: ${childOutput}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id);
      message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
    }
    if (message.method === 'Network.responseReceived') responses.set(message.params.response.url, message.params.requestId);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await send('Runtime.enable'); await send('Network.enable');
  while (!(await evaluate(`Boolean(typeof api !== 'undefined' && typeof state !== 'undefined' && state?.gameData)`)) && Date.now() < deadline) await pause();
  let current = await evaluate(`api.getState()`);
  const update = await evaluate(`api.getUpdateState()`);
  assert.equal(update.currentVersion, expectedApp);
  assert.equal(current.gameData.version, bundled.resourceVersion);
  const initialVersion = current.gameData.version;
  let added;
  if (process.argv.includes('--update')) {
    const remote = JSON.parse(await readFile('output/resource-baseline/manifest.json', 'utf8'));
    const oldIds = new Set(current.gameData.operators.map(o => o.operatorId));
    await evaluate(`document.querySelector('.nav[data-page="settings"]').click()`);
    await evaluate(`document.querySelector('[data-action="update-game"]').click()`);
    const updateDeadline = Date.now() + 180_000;
    while (await evaluate('state.gameData.version') !== remote.resourceVersion && Date.now() < updateDeadline) {
      const error = await evaluate(`document.querySelector('#toast').textContent`);
      if (error.includes('Error invoking')) throw new Error(error);
      await pause();
    }
    assert.equal(await evaluate('state.gameData.version'), remote.resourceVersion);
    current = await evaluate('api.getState()');
    added = current.gameData.operators.find(o => !oldIds.has(o.operatorId));
    bundled = remote;
  }
  await evaluate(`document.querySelector('.nav[data-page="settings"]').click()`);
  const imageId = added?.operatorId ?? '002_amiya';
  const asset = `${current.resourceAssetBase}avatar/${imageId}.png`;
  await evaluate(`(async () => { const image = new Image(); image.src = ${JSON.stringify(asset)}; await image.decode(); return image.naturalWidth; })()`);
  const requestId = responses.get(asset);
  assert.ok(requestId, 'Packaged custom resource protocol did not return an image');
  const response = await send('Network.getResponseBody', { requestId });
  const imageBytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
  const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
  assert.equal(imageSha256, bundled.files[`images/avatar/${imageId}.png`].sha256);
  assert.deepEqual(exceptions, []);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, 'settings.png'), Buffer.from(screenshot.data, 'base64'));
  const report = { pass: true, appVersion: expectedApp, initialVersion, resourceVersion: current.gameData.version, network: process.argv.includes('--update') ? 'production-https' : 'bundled', addedOperator: added?.name, operators: current.gameData.operators.length, imageSha256 };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  socket?.close();
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(runtime, { recursive: true, force: true });
}
