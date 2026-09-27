import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SnapshotManifest, compareAppVersions } from '../src/resources/schema';
import { loadSnapshot, sha256, validateGameData, validateManifest, safeResourcePath } from '../src/resources/validation';
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
