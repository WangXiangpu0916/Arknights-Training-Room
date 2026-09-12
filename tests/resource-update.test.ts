import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ToolboxGameDataProvider } from '../src/data/game-data-provider';
import { ResourceManifest, SnapshotManifest, compareAppVersions } from '../src/resources/schema';
import { loadSnapshot, sha256, validateGameData, validateManifest, safeResourcePath } from '../src/resources/validation';
import { AppService } from '../src/app-service';
import { buildResource } from '../src/resources/builder';

export async function fixture(directory: string, version = '2026.09.12.1') {
  const png = await readFile('resources/images/item/30011.png');
  const materials = Array.from({ length: 30 }, (_, i) => ({ itemId: `item_${i}`, name: `材料 ${i}`, rarity: 1, type: 1 }));
  const cost = [{ itemId: 'item_0', quantity: 1 }];
  const levels = { 1: cost, 2: cost, 3: cost };
  const operators = Array.from({ length: 100 }, (_, i) => ({
    operatorId: `op_${i}`, name: `干员 ${i}`, rarity: i === 0 ? 6 : 1, profession: '近卫', subProfession: '领主',
    maxElitePhase: i === 0 ? 2 as const : 0 as const, promotionRequirements: { 1: i === 0 ? cost : [], 2: i === 0 ? cost : [] },
    skills: i === 0 ? [{ skillId: 'skill_0', operatorId: 'op_0', index: 1, name: '技能', requirements: levels }] : [],
    modules: i === 0 ? [{ moduleId: 'module_0', name: '模组', typeIcon: 'lord-x', typeLabel: 'X 型模组', requirements: levels }] : [],
  }));
  const data = { version, updatedAt: '2026-09-12T00:00:00.000Z', operators, materials,
    progression: { characterExpMap: Array.from({ length: 3 }, () => Array(90).fill(100)),
      characterUpgradeCostMap: Array.from({ length: 3 }, () => Array(89).fill(100)), evolveGoldCost: Array.from({ length: 6 }, () => [100, 100]),
      expItems: { item_1: 200 }, lmdItemId: 'item_0' } };
  const files: Record<string, Buffer> = { 'data/game.json': Buffer.from(JSON.stringify(data)),
    'images/skill/placeholder.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),
    'images/skill/skill_0.png': png, 'images/profession-hd/近卫.png': png, 'images/module/type/lord-x.png': png };
  for (const op of operators) files[`images/avatar/${op.operatorId}.png`] = png;
  for (const item of materials) files[`images/item/${item.itemId}.png`] = png;
  for (const i of [0, 1, 2, 3]) {
    files[`images/mastery/m${i}.png`] = png; files[`images/mastery/专精_${i}_角标.png`] = png;
    if (i < 3) files[`images/elite/e${i}.png`] = png;
    if (i > 0) files[`images/module/stage/${i}.png`] = png;
  }
  const manifest: SnapshotManifest = { resourceVersion: version, schemaVersion: 1, buildTime: data.updatedAt, minAppVersion: '0.0.20-beta.14',
    sources: [{ repository: 'https://github.com/example/game', commit: 'a'.repeat(40) }], files: {}, fallbacks: { skills: [] } };
  for (const [name, bytes] of Object.entries(files)) {
    manifest.files[name] = { size: bytes.length, sha256: sha256(bytes) };
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { manifest, files, data };
}

function packageFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const bytes = gzipSync(JSON.stringify({ format: 'training-room-resource-1', manifest: f.manifest,
    files: Object.fromEntries(Object.entries(f.files).map(([k, v]) => [k, v.toString('base64')])) }));
  const manifest: ResourceManifest = { ...f.manifest, package: { url: 'http://127.0.0.1/package', size: bytes.length, sha256: sha256(bytes) } };
  return { manifest, bytes };
}

test('完整资源更新 A→B、单次并发下载、旧版本图片、重启及非法路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-'));
  try {
    const a = await fixture(path.join(root, 'bundled'));
    const b = await fixture(path.join(root, 'new'), '2026.09.12.2');
    const remote = packageFixture(b); let requests = 0, activations = 0;
    const store = { gameDataDir: path.join(root, 'game-data'), log: async () => {} };
    const options = { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14', allowLoopback: true,
      manifestUrl: 'http://127.0.0.1/manifest', fetch: (async url => {
        requests++; return new Response(String(url).endsWith('/manifest') ? JSON.stringify(remote.manifest) : remote.bytes);
      }) as typeof fetch };
    const provider = new ToolboxGameDataProvider(store, options);
    assert.equal((await provider.initialize()).version, a.data.version);
    const activate = async () => { activations++; };
    const [next, concurrent] = await Promise.all([provider.update(activate), provider.update(activate)]);
    assert.strictEqual(next, concurrent); assert.equal(next.version, b.data.version); assert.equal(requests, 2); assert.equal(activations, 1);
    assert.ok(provider.assetPath(a.data.version, 'images/avatar/op_0.png')?.includes('.backup'));
    assert.ok(provider.assetPath(b.data.version, 'images/avatar/op_0.png'));
    assert.equal(provider.assetPath(b.data.version, 'images/../data/game.json'), undefined);
    assert.equal(provider.assetPath(b.data.version, 'images/not-listed.png'), undefined);
    assert.equal((await new ToolboxGameDataProvider(store, options).initialize()).version, b.data.version);
    await provider.update(activate); assert.equal(requests, 3, '已是最新时只获取 manifest');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failure injection：坏包、非法清单、兼容性、丢失 JSON / 图片、错误引用及网络中断均保留 A', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-fail-'));
  try {
    await fixture(path.join(root, 'bundled'));
    const scenarios = ['checksum', 'broken-package', 'invalid-manifest', 'schema', 'min-app', 'missing-json', 'missing-json-payload', 'missing-image', 'reference', 'network', 'interrupted-body', 'reload'];
    for (const scenario of scenarios) await t.test(scenario, async () => {
      const b = await fixture(path.join(root, `fixture-${scenario}`), '2026.09.12.2');
      if (scenario === 'missing-json') { delete b.files['data/game.json']; delete b.manifest.files['data/game.json']; }
      if (scenario === 'missing-json-payload') delete b.files['data/game.json'];
      if (scenario === 'missing-image') { delete b.files['images/avatar/op_0.png']; delete b.manifest.files['images/avatar/op_0.png']; }
      if (scenario === 'reference') {
        b.data.operators[0].skills[0].requirements[1][0].itemId = 'unknown';
        b.files['data/game.json'] = Buffer.from(JSON.stringify(b.data));
        b.manifest.files['data/game.json'] = { size: b.files['data/game.json'].length, sha256: sha256(b.files['data/game.json']) };
      }
      const remote = packageFixture(b);
      if (scenario === 'checksum') remote.manifest.package.sha256 = '0'.repeat(64);
      if (scenario === 'broken-package') { remote.bytes = Buffer.from('broken gzip'); remote.manifest.package.size = remote.bytes.length; remote.manifest.package.sha256 = sha256(remote.bytes); }
      if (scenario === 'invalid-manifest') remote.manifest.resourceVersion = 'invalid';
      if (scenario === 'schema') remote.manifest.schemaVersion = 99;
      if (scenario === 'min-app') remote.manifest.minAppVersion = '9.0.0';
      const store = { gameDataDir: path.join(root, `cache-${scenario}`), log: async () => {} };
      const options = { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14', allowLoopback: true, manifestUrl: 'http://127.0.0.1/manifest',
        fetch: (async url => {
          if (scenario === 'network') throw new Error('network interruption');
          if (String(url).endsWith('/manifest')) return new Response(JSON.stringify(remote.manifest));
          if (scenario === 'interrupted-body') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('connection reset')); } }));
          return new Response(remote.bytes);
        }) as typeof fetch };
      const provider = new ToolboxGameDataProvider(store, options);
      await provider.initialize(); let active = '2026.09.12.1';
      await assert.rejects(provider.update(async data => { active = data.version; if (scenario === 'reload' && active.endsWith('.2')) throw new Error('rebuild failed'); }));
      assert.equal(active, '2026.09.12.1');
      assert.equal((await provider.load()).version, '2026.09.12.1');
      assert.equal((await new ToolboxGameDataProvider(store, options).initialize()).version, '2026.09.12.1');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('未提交事务重启时恢复 A；残留下载不被加载；缓存损坏恢复备份', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-recover-'));
  try {
    await fixture(path.join(root, 'bundled'));
    const store = { gameDataDir: path.join(root, 'game-data'), log: async () => {} };
    const options = { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14' };
    await cp(options.bundledDirectory, `${store.gameDataDir}.backup`, { recursive: true });
    await fixture(store.gameDataDir, '2026.09.12.2');
    await fixture(`${store.gameDataDir}.next`, '2026.09.12.3');
    await writeFile(`${store.gameDataDir}.transaction.json`, '{}');
    assert.equal((await new ToolboxGameDataProvider(store, options).initialize()).version, '2026.09.12.1');
    await cp(store.gameDataDir, `${store.gameDataDir}.backup`, { recursive: true });
    await writeFile(path.join(store.gameDataDir, 'data/game.json'), 'broken');
    assert.equal((await new ToolboxGameDataProvider(store, options).initialize()).version, '2026.09.12.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('validation gate：sanity、成本、曲线、Windows 路径和版本排序', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-schema-'));
  try {
    const f = await fixture(root);
    const broken = structuredClone(f.data); broken.operators = broken.operators.slice(0, 90);
    assert.throws(() => validateGameData(broken, f.manifest, f.data), /过少|sanity/);
    const previous = structuredClone(f.data);
    previous.operators.push(...previous.operators.slice(1, 22));
    assert.throws(() => validateGameData(f.data, f.manifest, previous), /sanity/);
    assert.throws(() => validateManifest({ ...f.manifest, schemaVersion: 2 }, '0.0.20-beta.14', false), /升级应用/);
    for (const name of ['images/../escape.png', 'images/CON.png', 'images/a:stream.png', 'images/a\\b.png', '/images/x.png']) assert.throws(() => safeResourcePath(name));
    assert.equal(compareAppVersions('0.0.20-beta.15', '0.0.20-beta.14'), 1);
    assert.equal(compareAppVersions('0.0.20', '0.0.20-beta.15'), 1);
    assert.equal(compareAppVersions('0.0.20-beta.2', '0.0.20-beta.10'), -1);
    await loadSnapshot(root, '0.0.20-beta.14');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Builder 发布门禁：固定输入的字节变化必须拒绝构建', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-build-'));
  try {
    const input = path.join(root, 'input'); await mkdir(path.join(input, 'game-data'), { recursive: true });
    await writeFile(path.join(input, 'game-data/character.json'), '{}');
    await writeFile(path.join(input, 'resource-inputs.json'), JSON.stringify({ 'game-data/character.json': '0'.repeat(64) }));
    await assert.rejects(buildResource({ input, output: path.join(root, 'output'), resourceVersion: '2026.09.12.1',
      buildTime: '2026-09-12T00:00:00.000Z', minAppVersion: '0.0.20-beta.14', packageUrl: 'https://example.com/package',
      sources: [{ repository: 'https://github.com/example/game', commit: 'a'.repeat(40) }] }), /固定输入校验失败/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IPC barrier：资源事务完成前，账号和统计读取不得越过安全点', async () => {
  const service = Object.create(AppService.prototype) as AppService;
  (service as any).operationQueue = Promise.resolve();
  const events: string[] = []; let release!: () => void;
  const first = service.exclusive(async () => { events.push('prepare'); await new Promise<void>(r => release = r); events.push('commit'); });
  const read = service.exclusive(() => events.push('state'));
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, ['prepare']); release(); await Promise.all([first, read]);
  assert.deepEqual(events, ['prepare', 'commit', 'state']);
});

test('供应链：生产路径拒绝 HTTP、外部资源包和恶意重定向', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-trust-'));
  try {
    await fixture(path.join(root, 'bundled'));
    const b = await fixture(path.join(root, 'b'), '2026.09.12.2');
    const remote = packageFixture(b); remote.manifest.package.url = 'https://evil.example/resource';
    const store = { gameDataDir: path.join(root, 'cache'), log: async () => {} };
    const provider = new ToolboxGameDataProvider(store, { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14',
      fetch: (async () => new Response(JSON.stringify(remote.manifest))) as typeof fetch });
    await provider.initialize();
    await assert.rejects(provider.update(async () => {}), /未受信任/);
    remote.manifest.package.url = 'http://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resource/resource.atr.gz';
    await assert.rejects(provider.update(async () => {}), /HTTPS/);
    const redirected = new ToolboxGameDataProvider(store, { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14',
      fetch: (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/resource' } })) as typeof fetch });
    await redirected.initialize();
    await assert.rejects(redirected.update(async () => {}), /未受信任/);
    assert.equal((await provider.load()).version, '2026.09.12.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实进程退出注入：切换后尚未提交时终止进程，重新启动恢复 A', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-exit-'));
  let worker: ReturnType<typeof spawn> | undefined;
  const server = createServer();
  try {
    await fixture(path.join(root, 'bundled'));
    const b = packageFixture(await fixture(path.join(root, 'b'), '2026.09.12.2'));
    server.on('request', (req, res) => { res.end(req.url === '/manifest' ? JSON.stringify(b.manifest) : b.bytes); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    b.manifest.package.url = `http://127.0.0.1:${port}/package`;
    const providerFile = path.resolve('dist/src/data/game-data-provider.js');
    const source = `const {ToolboxGameDataProvider}=require(process.argv[1]); const fs=require('fs'); const path=require('path'); const root=process.argv[2];
      const p=new ToolboxGameDataProvider({gameDataDir:path.join(root,'cache'),log:async()=>{}},{bundledDirectory:path.join(root,'bundled'),appVersion:'0.0.20-beta.14',allowLoopback:true,manifestUrl:process.argv[3]});
      p.initialize().then(()=>p.update(async data=>{fs.writeFileSync(path.join(root,'at-switch'),data.version);await new Promise(()=>{setInterval(()=>{},1000)});})).catch(e=>{console.error(e);process.exit(1)});`;
    worker = spawn(process.execPath, ['-e', source, providerFile, root, `http://127.0.0.1:${port}/manifest`], { stdio: 'pipe', windowsHide: true });
    let workerError = ''; worker.stderr?.on('data', bytes => workerError += bytes);
    let switched = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await readFile(path.join(root, 'at-switch'), 'utf8').catch(() => '') === '2026.09.12.2') { switched = true; break; }
      if (worker.exitCode !== null) throw new Error(workerError || 'Worker exited before resource switch');
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(switched, workerError);
    const exited = new Promise<void>(r => worker!.once('exit', () => r())); worker.kill(); await exited;
    const recovered = new ToolboxGameDataProvider({ gameDataDir: path.join(root, 'cache'), log: async () => {} }, { bundledDirectory: path.join(root, 'bundled'), appVersion: '0.0.20-beta.14' });
    assert.equal((await recovered.initialize()).version, '2026.09.12.1');
  } finally {
    if (worker?.exitCode === null) worker.kill();
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
