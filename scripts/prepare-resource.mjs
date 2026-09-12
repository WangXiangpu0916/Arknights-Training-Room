import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pinyin } from 'pinyin-pro';
import { officialMetadata } from './resource-metadata.mjs';
import { lockInputs } from './lock-resource-inputs.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const output = path.resolve(option('--output', 'output/resource-input'));
const relative = path.relative(process.cwd(), output);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Prepared inputs must stay within a named workspace subdirectory');
const seed = path.resolve('resources');
const baseline = option('--baseline', undefined);
const baselineManifest = baseline ? await readFile(path.join(baseline, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => undefined) : undefined;
const seedInputHashes = JSON.parse(await readFile(path.join(seed, 'resource-inputs.json'), 'utf8'));
const seedDigest = createHash('sha256').update(JSON.stringify(seedInputHashes)).digest('hex');
const moduleIcons = JSON.parse(await readFile(path.join(seed, 'module-icons.lock.json'), 'utf8'));
const moduleSource = { repository: 'https://torappu.prts.wiki/assets/uniequip_type', dataVersion: `sha256:${createHash('sha256').update(JSON.stringify(moduleIcons)).digest('hex')}` };
const dependencies = [
  { repository: 'arkntools/arknights-toolbox-data', branch: 'main', paths: ['assets/data', 'assets/locales/cn', 'assets/img/avatar', 'assets/img/item', 'assets/img/skill'] },
  { repository: 'Kengxxiao/ArknightsGameData', branch: 'master', paths: ['zh_CN/gamedata/excel/character_table.json', 'zh_CN/gamedata/excel/uniequip_table.json', 'zh_CN/gamedata/excel/gamedata_const.json', 'zh_CN/gamedata/excel/item_table.json'] },
];
// Resolve ALL revisions first. Every later download / checkout uses these exact SHAs.
for (const dependency of dependencies) {
  dependency.commit = execFileSync('gh', ['api', `repos/${dependency.repository}/commits/${dependency.branch}`, '--jq', '.sha'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^[a-f0-9]{40}$/.test(dependency.commit)) throw new Error('Upstream commit resolution failed');
}
await mkdir(output, { recursive: true });
await rm(path.join(output, 'unchanged'), { force: true });
if (args.includes('--skip-unchanged') && baselineManifest
  && dependencies.every(d => baselineManifest.sources.some(s => s.repository === `https://github.com/${d.repository}` && s.commit === d.commit))
  && baselineManifest.sources.some(s => s.dataVersion === `seed-sha256:${seedDigest}`)) {
  await writeFile(path.join(output, 'unchanged'), 'All fixed upstream and seed inputs unchanged');
  console.log('Upstream / seed commits unchanged; no resource publication needed.'); process.exit(0);
}
await writeFile(path.join(output, 'upstream-lock.json'), JSON.stringify(dependencies, null, 2));
const checkouts = path.join(output, 'checkouts');
await rm(checkouts, { recursive: true, force: true });
await mkdir(checkouts, { recursive: true });
const run = promisify(execFile);
const github = async endpoint => {
  let failure;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return JSON.parse((await run('gh', ['api', endpoint], { encoding: 'utf8', windowsHide: true, maxBuffer: 30 * 1024 * 1024, timeout: 60_000 })).stdout); }
    catch (error) { failure = error; }
  }
  throw failure;
};
const gitHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
// GitHub's Git tree/blob API gives content-addressed downloads without requiring Git on builder hosts.
for (const dependency of dependencies) {
  const tree = await github(`repos/${dependency.repository}/git/trees/${dependency.commit}?recursive=1`);
  if (tree.truncated) throw new Error('Upstream tree truncated; refusing an incomplete build');
  dependency.tree = new Map(tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
}
async function acquire(dependency, remote, destination, cached) {
  const blob = dependency.tree.get(remote);
  if (!blob) throw new Error(`Pinned upstream is missing ${remote}`);
  let bytes = cached ? await readFile(cached).catch(() => undefined) : undefined;
  if (!bytes || gitHash(bytes) !== blob) {
    const cache = path.join(output, 'blob-cache', blob);
    bytes = await readFile(cache).catch(() => undefined);
    if (!bytes || gitHash(bytes) !== blob) {
      const result = await github(`repos/${dependency.repository}/git/blobs/${blob}`);
      if (result.encoding !== 'base64') throw new Error('Unsupported Git blob encoding');
      bytes = Buffer.from(result.content, 'base64');
      if (gitHash(bytes) !== blob) throw new Error(`Git blob checksum mismatch: ${remote}`);
      await mkdir(path.dirname(cache), { recursive: true }); await writeFile(cache, bytes);
    }
  }
  await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
}
const input = path.join(output, 'input');
await rm(input, { recursive: true, force: true });
await cp(seed, input, { recursive: true });
for (const [id, pin] of Object.entries(moduleIcons)) {
  let bytes = await readFile(path.join(seed, 'images/module/type', `${id}.png`)).catch(() => undefined);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Pinned module icon download failed: ${id}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error(`Pinned module icon changed: ${id}`);
  await writeFile(path.join(input, 'images/module/type', `${id}.png`), bytes);
}
const toolbox = path.join(checkouts, '0/assets');
const official = path.join(checkouts, '1/zh_CN/gamedata/excel');
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const save = async (name, value) => writeFile(path.join(input, 'game-data', name), JSON.stringify(value, null, 2));
for (const [remote, local] of [
  ['data/character.json', 'character.json'], ['data/cultivate.json', 'cultivate.json'], ['data/item.json', 'item.json'],
  ['locales/cn/character.json', 'character-cn.json'], ['locales/cn/material.json', 'material-cn.json'],
  ['locales/cn/skill.json', 'skill-cn.json'], ['locales/cn/uniequip.json', 'uniequip-cn.json'],
]) await acquire(dependencies[0], `assets/${remote}`, path.join(input, 'game-data', local), path.join(seed, 'game-data', local));
for (const name of ['character_table.json', 'uniequip_table.json', 'gamedata_const.json', 'item_table.json'])
  await acquire(dependencies[1], `zh_CN/gamedata/excel/${name}`, path.join(official, name));
const characterInput = await json(path.join(input, 'game-data/character.json'));
const cultivateInput = await json(path.join(input, 'game-data/cultivate.json'));
const imageJobs = [
  ...Object.keys(characterInput).filter(id => cultivateInput[id]).map(id => ['avatar', id]),
  ...[...new Set([...Object.keys(await json(path.join(input, 'game-data/item.json'))), '4001', '2001', '2002', '2003', '2004'])].map(id => ['item', id]),
  ...[...new Set(Object.values(cultivateInput).flatMap(o => (o.skills?.elite ?? []).map(s => s.name)))].map(id => ['skill', id]),
];
let nextJob = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (nextJob < imageJobs.length) {
    const [type, id] = imageJobs[nextJob++];
    if (type === 'skill' && !dependencies[0].tree.has(`assets/img/skill/${id}.png`)) {
      // PRTS icons already vendored in the pinned seed remain valid when toolbox omits an icon.
      console.log(`Skill icon retained from fixed seed / placeholder: ${id}`);
      continue;
    }
    const cached = baseline ? path.join(baseline, 'images', type, `${id}.png`) : path.join(seed, 'images', type, `${id}.png`);
    await acquire(dependencies[0], `assets/img/${type}/${id}.png`, path.join(input, 'images', type, `${id}.png`), cached);
    if (nextJob % 100 === 0) console.log(`Pinned image inputs: ${nextJob}/${imageJobs.length}`);
  }
}));
const [moduleData, constants, items, chars, moduleNames, names, metadata, branches, materialMetadata] = await Promise.all([
  json(path.join(official, 'uniequip_table.json')), json(path.join(official, 'gamedata_const.json')),
  json(path.join(official, 'item_table.json')), json(path.join(official, 'character_table.json')),
  json(path.join(input, 'game-data/uniequip-cn.json')), json(path.join(input, 'game-data/character-cn.json')),
  json(path.join(input, 'game-data/operator-metadata.json')), json(path.join(input, 'game-data/subprofession-cn.json')),
  json(path.join(input, 'game-data/material-metadata.json')),
]);
const branchesById = new Map();
for (const [key, char] of Object.entries(chars)) if (branches[key.replace(/^char_/, '')]) branchesById.set(char.subProfessionId, branches[key.replace(/^char_/, '')]);
for (const [key, char] of Object.entries(chars)) {
  const id = key.replace(/^char_/, '');
  if (!names[id]) continue;
  const syllables = pinyin(names[id], { toneType: 'none', type: 'array' }).map(v => v.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
  metadata[id] = { ...metadata[id], name: names[id], pinyin: syllables.join(''), pinyinInitials: syllables.map(v => v[0]).join(''),
    position: char.position === 'MELEE' ? '近战位' : '远程位', tags: char.tagList ?? [] };
  branches[id] = branchesById.get(char.subProfessionId) ?? branches[id] ?? '未知分支';
}
for (const [id, item] of Object.entries(items.items)) {
  materialMetadata[id] = { purpose: item.usage ?? '', description: item.description ?? '' };
}
const converted = officialMetadata(moduleData, constants, items, moduleNames);
await save('operator-metadata.json', metadata); await save('subprofession-cn.json', branches);
await save('material-metadata.json', materialMetadata); await save('uniequip-metadata.json', converted.moduleMetadata);
await save('progression.json', converted.progression);
await save('data-version.json', { version: dependencies[0].commit, sourceCommit: dependencies[0].commit, updatedAt: new Date().toISOString() });
const seedConfig = await json(path.join(seed, 'resource-build.json'));
const version = option('--version', `${new Date().toISOString().slice(0, 10).replaceAll('-', '.')}.${Date.now()}`);
const config = { resourceVersion: version, buildTime: new Date().toISOString(), minAppVersion: seedConfig.minAppVersion,
  sources: [...dependencies.map(d => ({ repository: `https://github.com/${d.repository}`, commit: d.commit })), moduleSource,
    seedConfig.sources.find(s => s.repository === 'https://github.com/WangXiangpu0916/Arknights-Training-Room')] };
await writeFile(path.join(input, 'resource-build.json'), JSON.stringify(config, null, 2));
const digest = await lockInputs(input);
config.sources.at(-1).dataVersion = `seed-sha256:${seedDigest}`;
await writeFile(path.join(input, 'resource-build.json'), JSON.stringify(config, null, 2));
await rm(checkouts, { recursive: true, force: true });
console.log(JSON.stringify({ input, resourceVersion: version, sources: config.sources }));
