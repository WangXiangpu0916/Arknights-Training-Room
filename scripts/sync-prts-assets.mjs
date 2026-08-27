import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const api = 'https://prts.wiki/api.php';
const headers = { 'User-Agent': 'Arknights-Training-Room/1.0' };
const imageRoot = path.join('resources', 'images');
const skillDir = path.join(imageRoot, 'skill');
const masteryDir = path.join(imageRoot, 'mastery');
const masteryTitles = [0, 1, 2, 3].map(level => `文件:专精 ${level} 大图.png`);

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

const skillNames = JSON.parse(await readFile(path.join('resources', 'game-data', 'skill-cn.json'), 'utf8'));
const cultivate = JSON.parse(await readFile(path.join('resources', 'game-data', 'cultivate.json'), 'utf8'));
const skillIds = [...new Set(Object.values(cultivate).flatMap(operator =>
  (operator.skills?.elite ?? []).map(skill => skill.name),
))].sort();
const titles = [
  ...masteryTitles,
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
for (const [level, title] of masteryTitles.entries()) {
  const image = images.get(title);
  if (!image) throw new Error(`PRTS 缺少必需素材：${title}`);
  const localPath = path.join(masteryDir, `m${level}.png`);
  await download(image.url, localPath);
  mastery[level] = manifestEntry(title, image, localPath);
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
  `${JSON.stringify({ source: 'https://prts.wiki', syncedAt: new Date().toISOString(), mastery, skills, missing }, null, 2)}\n`,
  'utf8',
);
console.log(`PRTS 素材同步完成：职业分支 ${Object.keys(subProfessions).length}，专精 ${Object.keys(mastery).length}，技能 ${Object.keys(skills).length}，缺失 ${missing.length}`);
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
