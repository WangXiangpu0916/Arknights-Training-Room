import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { operatorMetadata } from './sync-prts-metadata.mjs';

const api = 'https://prts.wiki/api.php';
const headers = { 'User-Agent': 'Arknights-Training-Room/1.0' };
const imageRoot = path.join('resources', 'images');
const skillDir = path.join(imageRoot, 'skill');
const masteryDir = path.join(imageRoot, 'mastery');
const eliteDir = path.join(imageRoot, 'elite');
const professionDir = path.join(imageRoot, 'profession');
const masteryTitles = [0, 1, 2, 3].map(level => `文件:专精 ${level} 大图.png`);
const masteryBadgeTitles = [0, 1, 2, 3].map(level => `文件:专精_${level}_角标.png`);
const eliteTitles = [0, 1, 2].map(level => `文件:精英 ${level} 大图.png`);
const professions = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const professionTitles = professions.map(name => `文件:图标 职业 ${name}.png`);

const branchUrl = new URL(api);
branchUrl.search = new URLSearchParams({
  action: 'cargoquery',
  format: 'json',
  tables: 'chara',
  fields: 'charId,subProfession',
  limit: '500',
});
const branchResponse = await request(branchUrl);
if (!branchResponse.ok) throw new Error(`PRTS 职业分支请求失败：HTTP ${branchResponse.status}`);
const branchPayload = await branchResponse.json();
const subProfessions = Object.fromEntries((branchPayload.cargoquery ?? []).map(({ title }) => [
  title.charId.replace(/^char_/, ''),
  title.subProfession,
]));
await writeFile(
  path.join('resources', 'game-data', 'subprofession-cn.json'),
  `${JSON.stringify(subProfessions, null, 2)}\n`,
  'utf8',
);

await mkdir(skillDir, { recursive: true });
await mkdir(masteryDir, { recursive: true });
await mkdir(eliteDir, { recursive: true });
await mkdir(professionDir, { recursive: true });

const skillNames = JSON.parse(await readFile(path.join('resources', 'game-data', 'skill-cn.json'), 'utf8'));
const cultivate = JSON.parse(await readFile(path.join('resources', 'game-data', 'cultivate.json'), 'utf8'));
const skillIds = [...new Set(Object.values(cultivate).flatMap(operator =>
  (operator.skills?.elite ?? []).map(skill => skill.name),
))].sort();
const titles = [
  ...masteryTitles,
  ...masteryBadgeTitles,
  ...eliteTitles,
  ...professionTitles,
  ...new Set(skillIds.map(id => `文件:技能 ${skillNames[id]}.png`)),
];

const images = new Map();
for (let index = 0; index < titles.length; index += 50) {
  const url = new URL(api);
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    prop: 'imageinfo',
    iiprop: 'url|mime|size|sha1',
    titles: titles.slice(index, index + 50).join('|'),
  });
  const response = await request(url);
  if (!response.ok) throw new Error(`PRTS API 请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  for (const page of payload.query?.pages ?? []) {
    const image = page.imageinfo?.[0];
    if (image?.mime === 'image/png') images.set(page.title, image);
  }
}

const mastery = {};
const masteryBadges = {};
const elite = {};
const profession = {};
for (const [level, title] of masteryTitles.entries()) {
  const image = images.get(title);
  if (!image) throw new Error(`PRTS 缺少必需素材：${title}`);
  const localPath = path.join(masteryDir, `m${level}.png`);
  await download(image.url, localPath);
  mastery[level] = manifestEntry(title, image, localPath);
}
for (const [level, title] of masteryBadgeTitles.entries()) {
  const image = images.get(title);
  const localPath = path.join(masteryDir, `专精_${level}_角标.png`);
  if (!image) {
    const cached = await readFile(localPath).catch(() => null);
    if (!cached || !isPng(cached)) throw new Error(`PRTS 缺少必需素材：${title}`);
    masteryBadges[level] = { prtsTitle: title, localPath: localPath.replaceAll('\\', '/'), cached: true };
    continue;
  }
  await download(image.url, localPath);
  masteryBadges[level] = manifestEntry(title, image, localPath);
}
for (const [level, title] of eliteTitles.entries()) {
  const image = images.get(title);
  if (!image) throw new Error(`PRTS 缺少必需素材：${title}`);
  const localPath = path.join(eliteDir, `e${level}.png`);
  await download(image.url, localPath);
  elite[level] = manifestEntry(title, image, localPath);
}
for (const [index, title] of professionTitles.entries()) {
  const image = images.get(title);
  if (!image) throw new Error(`PRTS 缺少必需素材：${title}`);
  const name = professions[index];
  const localPath = path.join(professionDir, `${name}.png`);
  await download(image.url, localPath);
  profession[name] = manifestEntry(title, image, localPath);
}

const skills = {};
const missing = [];
let nextSkill = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (nextSkill < skillIds.length) {
    const skillId = skillIds[nextSkill++];
    const title = `文件:技能 ${skillNames[skillId]}.png`;
    const image = images.get(title);
    if (!image) {
      missing.push({ skillId, name: skillNames[skillId] });
      continue;
    }
    const localPath = path.join(skillDir, `${skillId}.png`);
    await download(image.url, localPath);
    skills[skillId] = { name: skillNames[skillId], ...manifestEntry(title, image, localPath) };
  }
}));

await writeFile(
  path.join(imageRoot, 'prts-assets.json'),
  `${JSON.stringify({ source: 'https://prts.wiki', syncedAt: new Date().toISOString(), mastery, masteryBadges, elite, profession, skills, missing }, null, 2)}\n`,
  'utf8',
);
console.log(`PRTS 素材同步完成：干员资料 ${Object.keys(operatorMetadata).length}，职业分支 ${Object.keys(subProfessions).length}，专精 ${Object.keys(mastery).length}，角标 ${Object.keys(masteryBadges).length}，精英 ${Object.keys(elite).length}，职业 ${Object.keys(profession).length}，技能 ${Object.keys(skills).length}，缺失 ${missing.length}`);
if (missing.length) console.log(missing.map(item => `${item.skillId} ${item.name}`).join('\n'));

async function download(url, target) {
  const cached = await readFile(target).catch(() => null);
  if (cached && isPng(cached)) return;
  const response = await request(url);
  if (!response.ok) throw new Error(`素材下载失败：${url}（HTTP ${response.status}）`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!isPng(body)) throw new Error(`素材不是有效 PNG：${url}`);
  await writeFile(target, body);
}

function isPng(value) {
  return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function request(url) {
  let error;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(url, { headers });
    } catch (value) {
      error = value;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw error;
}

function manifestEntry(title, image, localPath) {
  return {
    prtsTitle: title,
    sourceUrl: image.url,
    localPath: localPath.replaceAll('\\', '/'),
    width: image.width,
    height: image.height,
    sha1: image.sha1,
  };
}
