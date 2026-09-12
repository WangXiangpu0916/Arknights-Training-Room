import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { packSnapshot } = require('../dist/src/resources/package.js');
const { loadSnapshot, sha256 } = require('../dist/src/resources/validation.js');

const root = process.cwd();
const runtime = await mkdtemp(path.join(tmpdir(), 'atr-resource-e2e-'));
const output = path.join(root, 'output/resource-qa');
await mkdir(output, { recursive: true });
const a = path.join(root, 'dist/resource/snapshot');
const b = path.join(runtime, 'b');
await cp(a, b, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(b, 'manifest.json'), 'utf8'));
const data = JSON.parse(await readFile(path.join(b, 'data/game.json'), 'utf8'));
const versionA = manifest.resourceVersion;
const versionB = versionA.split('.').slice(0, 3).join('.') + '.' + (Number(versionA.split('.')[3]) + 1);
manifest.resourceVersion = data.version = versionB;
manifest.buildTime = data.updatedAt = new Date().toISOString();
data.operators.find(o => o.operatorId === '002_amiya').name = '阿米娅 · 资源 B';
const synthetic = structuredClone(data.operators.find(o => o.rarity === 6 && o.modules?.length));
synthetic.operatorId = 'fixture_resource_B'; synthetic.name = '资源测试干员 B'; synthetic.gender = '资源 B 元数据';
for (const [index, skill] of synthetic.skills.entries()) { skill.skillId = `fixture_skill_B_${index}`; skill.operatorId = synthetic.operatorId; }
for (const [index, mod] of synthetic.modules.entries()) mod.moduleId = `fixture_module_B_${index}`;
data.operators.push(synthetic);
data.materials.push({ itemId: 'fixture_item_B', name: '资源测试材料 B', rarity: 3, type: 2, purpose: '仅测试资源更新' });
const changedAssets = {
  'images/avatar/002_amiya.png': await readFile(path.join(a, 'images/avatar/003_kalts.png')),
  'images/avatar/fixture_resource_B.png': await readFile(path.join(a, `images/avatar/${data.operators.find(o => o.rarity === 6 && o.modules?.length).operatorId}.png`)),
  'images/item/fixture_item_B.png': await readFile(path.join(a, 'images/item/30011.png')),
};
for (const skill of synthetic.skills) changedAssets[`images/skill/${skill.skillId}.png`] = await readFile(path.join(a, 'images/skill', `${data.operators.find(o => o.rarity === 6 && o.modules?.length).skills[skill.index - 1].skillId}.png`));
for (const [name, bytes] of Object.entries(changedAssets)) {
  await mkdir(path.dirname(path.join(b, name)), { recursive: true });
  await writeFile(path.join(b, name), bytes); manifest.files[name] = { size: bytes.length, sha256: sha256(bytes) };
}
const gameBytes = Buffer.from(JSON.stringify(data));
await writeFile(path.join(b, 'data/game.json'), gameBytes);
manifest.files['data/game.json'] = { size: gameBytes.length, sha256: sha256(gameBytes) };
await writeFile(path.join(b, 'manifest.json'), JSON.stringify(manifest));
await loadSnapshot(b, JSON.parse(await readFile('package.json', 'utf8')).version);
const packageBytes = await packSnapshot(b, manifest);
let servedManifest;
let interruptDownload = false;
const server = createServer((request, response) => {
  if (request.url === '/manifest') { response.writeHead(302, { Location: '/channel' }); response.end(); }
  else if (request.url === '/channel') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(servedManifest)); }
  else if (request.url === '/package') { response.writeHead(302, { Location: '/payload' }); response.end(); }
  else if (interruptDownload) { response.writeHead(200, { 'Content-Length': packageBytes.length }); response.write(packageBytes.subarray(0, 100)); response.destroy(); }
  else response.end(packageBytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const remote = { ...manifest, package: { url: `${base}/package`, size: packageBytes.length, sha256: sha256(packageBytes) } };
servedManifest = { ...remote, resourceVersion: versionA };
const userData = path.join(runtime, 'user-data'); await mkdir(userData, { recursive: true });
await cp('qa-fixture/settings.json', path.join(userData, 'settings.json'));
const account = JSON.parse(await readFile('qa-fixture/account-cache.json', 'utf8'));
if (!account.operators.some(o => o.operatorId === '002_amiya')) account.operators.push({ operatorId: '002_amiya', level: 80, elitePhase: 2, skillLevel: 7,
  skills: data.operators.find(o => o.operatorId === '002_amiya').skills.map(s => ({ skillId: s.skillId, masteryLevel: 0 })) });
account.operators.push({ operatorId: synthetic.operatorId, level: 90, elitePhase: 2, skillLevel: 7,
  skills: synthetic.skills.map(s => ({ skillId: s.skillId, masteryLevel: 0 })) });
account.inventory.fixture_item_B = 123;
await writeFile(path.join(userData, 'account-cache.json'), JSON.stringify(account));
let child, socket, cdpId = 0, childOutput = '';
const pending = new Map();
const diagnostics = [];
const imageResponses = [];
const networkFailures = [];

async function start() {
  const port = await new Promise(resolve => { const portServer = createPortServer(); portServer.listen(0, '127.0.0.1', () => { const value = portServer.address().port; portServer.close(() => resolve(value)); }); });
  const env = { ...process.env, ATR_USER_DATA: userData, ATR_RESOURCE_TRACE: '1', ATR_RESOURCE_MANIFEST_URL: `${base}/manifest` };
  delete env.ATR_QA_HIDDEN; // Real screenshot / lazy-image verification requires a visible window.
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [`--remote-debugging-port=${port}`, '.'], { cwd: root, env, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-6000); });
  let target;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited: ${childOutput}`);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('renderer/index.html')); } catch {}
    if (target) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!target) throw new Error(`Electron startup timeout: ${childOutput}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') diagnostics.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) networkFailures.push(message.params.args.map(a=>a.value ?? a.description));
    if (message.method === 'Network.loadingFailed') networkFailures.push(message.params);
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes(`atr-resource://snapshot/${versionB}/images/avatar/002_amiya.png`)) imageResponses.push(message.params);
    const task = pending.get(message.id);
    if (task) { pending.delete(message.id); message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result); }
  });
  await send('Runtime.enable'); await send('Network.enable');
  await waitFor(`typeof state !== 'undefined' && Boolean(state?.gameData)`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}\n${childOutput}`)); }, 120_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Renderer did not reach ${expression}\n${await evaluate("JSON.stringify({base:state.resourceAssetBase,images:[...document.querySelectorAll('.operator-avatar')].map(i=>({src:i.src,raw:i.getAttribute('src'),width:i.naturalWidth}))})")}\n${JSON.stringify(networkFailures)}\n${childOutput}`);
}
async function stop(force = false) {
  socket?.close();
  if (child?.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  }
}
const results = {};
try {
  await start();
  assert.equal(await evaluate('state.gameData.version'), versionA);
  await evaluate(`page = 'operators'; render()`);
  await waitFor(`document.querySelector('.operator-row h3')`);
  results.initial = await evaluate(`({version: state.gameData.version, amiya: state.gameData.operators.find(o=>o.operatorId==='002_amiya').name})`);
  await writeFile(path.join(output, 'resource-A.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  servedManifest = { ...remote, package: { ...remote.package, sha256: '0'.repeat(64) } };
  results.badChecksum = await evaluate(`api.updateGameData().then(()=>false, e=>String(e.message))`);
  assert.match(results.badChecksum, /SHA-256/); assert.equal(await evaluate('api.getState().then(s=>s.gameData.version)'), versionA);
  servedManifest = { ...remote, schemaVersion: 99 };
  results.incompatible = await evaluate(`api.updateGameData().then(()=>false, e=>String(e.message))`);
  assert.match(results.incompatible, /升级应用/); assert.equal(await evaluate('api.getState().then(s=>s.gameData.version)'), versionA);
  servedManifest = remote; interruptDownload = true;
  results.networkFailure = await evaluate(`api.updateGameData().then(()=>false, e=>String(e.message))`);
  assert.ok(results.networkFailure); interruptDownload = false;
  await evaluate(`page = 'settings'; render(); document.querySelector('[data-action="update-game"]').click()`);
  await waitFor(`state.gameData.version === ${JSON.stringify(versionB)} && document.querySelector('#content').innerText.includes(${JSON.stringify(versionB)})`);
  await evaluate(`page = 'operators'; render()`);
  await waitFor(`document.querySelector('#content').innerText.includes('阿米娅 · 资源 B') && document.querySelector('#content').innerText.includes('资源测试干员 B')`);
  await evaluate(`[...document.querySelectorAll('.operator-avatar')].find(i=>i.src.includes('/avatar/002_amiya.png')).scrollIntoView()`);
  await waitFor(`Boolean([...document.querySelectorAll('.operator-avatar')].find(i => i.src.includes('/avatar/002_amiya.png'))?.naturalWidth)`);
  results.updated = await evaluate(`({ version: state.gameData.version, avatar: [...document.querySelectorAll('.operator-avatar')].find(i=>i.src.includes('/avatar/002_amiya.png')).src,
    synthetic: state.gameData.operators.find(o=>o.operatorId==='fixture_resource_B'), statistics: state.statistics })`);
  assert.ok(results.updated.avatar.startsWith(`atr-resource://snapshot/${versionB}/`), results.updated.avatar);
  assert.equal(results.updated.synthetic.gender, '资源 B 元数据');
  assert.ok(results.updated.synthetic.modules.length);
  assert.ok(imageResponses.length, 'New version image was requested through the resource protocol');
  const body = await send('Network.getResponseBody', { requestId: imageResponses.at(-1).requestId });
  const imageBytes = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
  assert.equal(sha256(imageBytes), manifest.files['images/avatar/002_amiya.png'].sha256, 'Renderer actually downloaded image B');
  results.imageBChecksum = sha256(imageBytes);
  await writeFile(path.join(output, 'resource-B.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`page = 'inventory'; render()`);
  await waitFor(`document.querySelector('[data-inventory-item="fixture_item_B"]')`);
  await evaluate(`document.querySelector('[data-inventory-item="fixture_item_B"]').click()`);
  await waitFor(`document.querySelector('.inventory-detail-name')?.textContent === '资源测试材料 B'`);
  results.inventory = await evaluate(`state.gameData.materials.find(m=>m.itemId==='fixture_item_B')`);
  await stop();
  await start(); assert.equal(await evaluate('state.gameData.version'), versionB); results.restart = versionB;
  await stop();
  // Crash recovery at the uncommitted switch boundary; the fixture models bytes left by abrupt exit.
  await writeFile(path.join(userData, 'game-data.transaction.json'), JSON.stringify({ from: versionA, to: versionB }));
  await start(); assert.equal(await evaluate('state.gameData.version'), versionA); results.interruptedSwitchRecovery = versionA;
  assert.deepEqual(diagnostics, []);
  results.pass = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ pass: true, versionA, versionB, imageBChecksum: results.imageBChecksum, report: path.join(output, 'report.json') }));
} finally {
  await stop(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await rm(runtime, { recursive: true, force: true });
}
