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
data.materials.find(item => item.itemId === '30011').purpose = '已热加载的材料用途 B';
const synthetic = structuredClone(data.operators.find(o => o.rarity === 6 && o.modules?.length));
synthetic.operatorId = 'fixture_resource_B'; synthetic.name = '资源测试干员 B'; synthetic.gender = '资源 B 元数据';
for (const [index, skill] of synthetic.skills.entries()) {
  const details = data.skillDetails[skill.skillId];
  skill.skillId = `fixture_skill_B_${index}`; skill.operatorId = synthetic.operatorId;
  data.skillDetails[skill.skillId] = structuredClone(details);
}
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
let holdManifest=true, releaseManifest;
let manifestRequests = 0, packageRequests = 0;
const server = createServer((request, response) => {
  if (request.url === '/manifest') { response.writeHead(302, { Location: '/channel' }); response.end(); }
  else if (request.url === '/channel') {
    manifestRequests++;
    const reply=()=>{response.setHeader('Content-Type', 'application/json');response.end(JSON.stringify(servedManifest));};
    if(holdManifest)releaseManifest=reply;else reply();
  }
  else if (request.url === '/package') { packageRequests++; response.writeHead(302, { Location: '/payload' }); response.end(); }
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
await writeFile(path.join(userData, 'credentials.bin'), 'unrelated fixture credentials');
await writeFile(path.join(userData, 'user-plans.json'), '{"fixture":"preserve me"}');
const protectedFiles = ['account-cache.json', 'settings.json', 'credentials.bin', 'user-plans.json'];
const protectedBytes = await Promise.all(protectedFiles.map(name => readFile(path.join(userData, name))));
let child, socket, cdpId = 0, childOutput = '';
const pending = new Map();
const diagnostics = [];
const imageResponses = [];
const networkFailures = [];

async function start() {
  const port = await new Promise(resolve => { const portServer = createPortServer(); portServer.listen(0, '127.0.0.1', () => { const value = portServer.address().port; portServer.close(() => resolve(value)); }); });
  const env = { ...process.env, ATR_QA_PORT: String(port), ATR_USER_DATA: userData, ATR_RESOURCE_CHECK_SECONDS: '2', ATR_RESOURCE_MANIFEST_URL: `${base}/manifest` };
  delete env.ATR_QA_HIDDEN; // Real screenshot / lazy-image verification requires a visible window.
  child = spawn(process.env.ATR_QA_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','debug/训练室.exe'), [], { cwd: root, env, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { childOutput = (childOutput + chunk).slice(-6000); });
  let target;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Native app exited: ${childOutput}`);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('renderer/index.html')); } catch {}
    if (target) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!target) throw new Error(`Native app startup timeout: ${childOutput}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') diagnostics.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) networkFailures.push(message.params.args.map(a=>a.value ?? a.description));
    if (message.method === 'Network.loadingFailed') networkFailures.push(message.params);
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes(`http://atr-resource.localhost/${versionB}/images/avatar/002_amiya.png`)) imageResponses.push(message.params);
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
async function waitChecks(count) {
  for (let i = 0; i < 300; i++) {
    if (manifestRequests >= count) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Periodic resource checks did not run');
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
  for(let i=0;i<100&&!releaseManifest;i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(releaseManifest,'Automatic startup check did not reach the test server');
  results.stateDuringDownload = await evaluate(`Promise.race([api.getState().then(s=>s.gameData.version),new Promise(r=>setTimeout(()=>r(false),3000))])`);
  assert.equal(results.stateDuringDownload, versionA, 'Slow resource network must not block application IPC');
  results.singleFlight = await evaluate(`api.updateGameData().then(()=>false,e=>e.message)`);
  assert.match(results.singleFlight, /后台检查或更新/);
  results.imagesDuringDownload=await evaluate(`Promise.race([(async()=>{const image=new Image();image.src=state.resourceAssetBase+'avatar/002_amiya.png';await image.decode();return image.naturalWidth>0;})(),new Promise(r=>setTimeout(()=>r(false),3000))])`);
  releaseManifest();holdManifest=false;releaseManifest=undefined;
  assert.equal(results.imagesDuringDownload,true,'Resource HTTP requests must not block the image protocol');
  await waitFor(`resourceUpdateState?.phase === 'current'`);
  const firstChecks = manifestRequests;
  await waitChecks(firstChecks + 2);
  assert.equal(packageRequests, 0, 'Unchanged resources must never download the package');
  results.unchangedChecks = manifestRequests;
  await evaluate(`page = 'operators'; render()`);
  await waitFor(`document.querySelector('.operator-row h3')`);
  results.initial = await evaluate(`({version: state.gameData.version, amiya: state.gameData.operators.find(o=>o.operatorId==='002_amiya').name})`);
  await writeFile(path.join(output, 'resource-A.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  servedManifest = { ...remote, package: { ...remote.package, sha256: '0'.repeat(64) } };
  await waitFor(`resourceUpdateState?.phase === 'error' && resourceUpdateState.message.includes('SHA-256')`);
  results.badChecksum = await evaluate(`resourceUpdateState.message`);
  assert.match(results.badChecksum, /SHA-256/); assert.equal(await evaluate('api.getState().then(s=>s.gameData.version)'), versionA);
  servedManifest = { ...remote, schemaVersion: 99 };
  const beforeIncompatible = packageRequests;
  await waitFor(`resourceUpdateState?.phase === 'error' && resourceUpdateState.message.includes('升级应用')`);
  results.incompatible = await evaluate(`resourceUpdateState.message`);
  assert.equal(packageRequests, beforeIncompatible, 'Incompatible resources must be rejected before downloading');
  assert.match(results.incompatible, /升级应用/); assert.equal(await evaluate('api.getState().then(s=>s.gameData.version)'), versionA);
  servedManifest = remote; interruptDownload = true;
  await waitFor(`resourceUpdateState?.phase === 'error' && !resourceUpdateState.message.includes('升级应用')`);
  results.networkFailure = await evaluate(`resourceUpdateState.message`);
  assert.ok(results.networkFailure); interruptDownload = false;
  await evaluate(`materialMap(); ownedOperatorRows()`);
  await evaluate(`page = 'operators'; render(); showModal('<h2>登录流程保持打开</h2>'); cancelLogin = () => { window.loginWasCancelled = true; };`);
  await waitFor(`state.gameData.version === ${JSON.stringify(versionB)}`);
  assert.equal(await evaluate(`modal.open && !window.loginWasCancelled`), true, 'Automatic resources must not cancel login');
  await evaluate(`cancelLogin = null; closeModal()`);
  results.automaticRuntimeUpdate = true;
  assert.equal(await evaluate(`materialMap().get('30011').purpose`), '已热加载的材料用途 B');
  await evaluate(`page = 'operators'; render()`);
  await waitFor(`document.querySelector('#content').innerText.includes('阿米娅 · 资源 B') && document.querySelector('#content').innerText.includes('资源测试干员 B')`);
  await evaluate(`[...document.querySelectorAll('.operator-avatar')].find(i=>i.src.includes('/avatar/002_amiya.png')).scrollIntoView()`);
  await waitFor(`Boolean([...document.querySelectorAll('.operator-avatar')].find(i => i.src.includes('/avatar/002_amiya.png'))?.naturalWidth)`);
  results.updated = await evaluate(`({ version: state.gameData.version, avatar: [...document.querySelectorAll('.operator-avatar')].find(i=>i.src.includes('/avatar/002_amiya.png')).src,
    synthetic: state.gameData.operators.find(o=>o.operatorId==='fixture_resource_B'), statistics: state.statistics })`);
  assert.ok(results.updated.avatar.startsWith(`http://atr-resource.localhost/${versionB}/`), results.updated.avatar);
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
  const installedDownloads = packageRequests;
  const installedChecks = manifestRequests;
  await waitChecks(installedChecks + 2);
  await waitFor(`resourceUpdateState?.phase === 'current'`);
  assert.equal(await evaluate(`api.updateGameData().then(s=>s.gameData.version)`), versionB);
  assert.equal(packageRequests, installedDownloads, 'Installed version must not be downloaded again');
  for (const [i, name] of protectedFiles.entries()) assert.deepEqual(await readFile(path.join(userData, name)), protectedBytes[i], `${name} changed`);
  results.userDataPreserved = true;
  await stop();
  await start(); assert.equal(await evaluate('state.gameData.version'), versionB); results.restart = versionB;
  await waitFor(`resourceUpdateState?.phase === 'current'`);
  assert.equal(packageRequests, installedDownloads);
  await stop();
  // Crash recovery at the uncommitted switch boundary; the fixture models bytes left by abrupt exit.
  await writeFile(path.join(userData, 'game-data.transaction.json'), JSON.stringify({ from: versionA, to: versionB }));
  holdManifest = true;
  await start(); assert.equal(await evaluate('state.gameData.version'), versionA); results.interruptedSwitchRecovery = versionA;
  for(let i=0;i<100&&!releaseManifest;i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(releaseManifest);
  await evaluate(`page = 'inventory'; inventorySearch = '固源岩'; render(); document.querySelector('[data-inventory-search]').focus(); document.querySelector('[data-inventory-search]').setSelectionRange(1, 2)`);
  releaseManifest(); holdManifest = false; releaseManifest = undefined;
  await waitFor(`state.gameData.version === ${JSON.stringify(versionB)}`);
  assert.deepEqual(await evaluate(`({search:inventorySearch,focus:document.activeElement.hasAttribute('data-inventory-search'),selection:document.activeElement.selectionStart})`), {search:'固源岩',focus:true,selection:1});
  results.automaticStartupUpdate = true;
  results.focusAndFiltersPreserved = true;
  await stop();
  await writeFile(path.join(userData, 'game-data.transaction.json'), JSON.stringify({ from: versionA, to: versionB }));
  holdManifest = true;
  await start();
  for(let i=0;i<100&&!releaseManifest;i++)await new Promise(r=>setTimeout(r,50));
  assert.ok(releaseManifest);
  await evaluate(`showCandidate(currentMasteryCandidates()[0])`);
  assert.equal(await evaluate(`modal.open`), true);
  releaseManifest(); holdManifest = false; releaseManifest = undefined;
  await waitFor(`state.gameData.version === ${JSON.stringify(versionB)}`);
  assert.equal(await evaluate(`modal.open && [...modalContent.querySelectorAll('img')].every(img => img.src.startsWith(state.resourceAssetBase))`), true, 'Open resource details must reload without showing old images');
  results.openPlanHotReloaded = true;
  assert.deepEqual(diagnostics, []);
  results.pass = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ pass: true, versionA, versionB, imageBChecksum: results.imageBChecksum, report: path.join(output, 'report.json') }));
} finally {
  await stop(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await rm(runtime, { recursive: true, force: true, maxRetries:10, retryDelay:200 });
}
