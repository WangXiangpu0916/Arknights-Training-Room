import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pinyin } from 'pinyin-pro';

const api = 'https://prts.wiki/api.php';
const headers = { 'User-Agent': 'Arknights-Training-Room/1.0' };
const metadataParams = {
  action: 'cargoquery',
  format: 'json',
  tables: 'chara=c,char_obtain=o,chara_extra_info=e',
  fields: [
    'c.charId', 'c.cn', 'c.position', 'c.nation', 'c.org', 'c.team',
    'o.obtainMethod', 'o.cnOnlineTime', 'e.sex', 'e.birthPlace', 'e.dateOfBirth', 'e.race',
  ].join(','),
  join_on: 'c._pageName=o._pageName,c._pageName=e._pageName',
  limit: '500',
};

const metadataRows = [];
for (let offset = 0; ; offset += 500) {
  const metadataUrl = new URL(api);
  metadataUrl.search = new URLSearchParams({ ...metadataParams, offset: String(offset) });
  const response = await request(metadataUrl);
  if (!response.ok) throw new Error(`PRTS 干员资料请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`PRTS 干员资料请求失败：${payload.error.info}`);
  const rows = payload.cargoquery ?? [];
  metadataRows.push(...rows);
  if (rows.length < 500) break;
}

const characterNames = JSON.parse(await readFile(path.join('resources', 'game-data', 'character-cn.json'), 'utf8'));
export const operatorMetadata = {};
for (const { title } of metadataRows) {
  const operatorId = String(title.charId ?? '').replace(/^char_/, '');
  if (!operatorId) continue;
  const name = characterNames[operatorId] ?? title.cn ?? '';
  const syllables = pinyin(name, { toneType: 'none', type: 'array' })
    .map(value => value.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  operatorMetadata[operatorId] = {
    name: title.cn ?? name,
    pinyin: syllables.join(''),
    pinyinInitials: syllables.map(value => value[0]).join(''),
    implementationDate: normalizeDateTime(title.cnOnlineTime),
    gender: title.sex ?? '',
    position: title.position ?? '',
    obtainMethods: splitWords(title.obtainMethod),
    races: splitSlashValues(title.race),
    birthPlaces: scalarValues(title.birthPlace),
    organizations: uniqueValues(title.nation, title.org),
    teams: scalarValues(title.team),
    birthdayMonth: parseBirthdayMonth(title.dateOfBirth),
  };
}

await writeFile(
  path.join('resources', 'game-data', 'operator-metadata.json'),
  `${JSON.stringify(operatorMetadata, null, 2)}\n`,
  'utf8',
);
console.log(`PRTS 干员资料同步完成：${Object.keys(operatorMetadata).length}`);

async function request(url) {
  let error;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await fetch(url, { headers });
    } catch (value) {
      error = value;
      if (attempt < 8) await new Promise(resolve => setTimeout(resolve, attempt * 400));
    }
  }
  throw error;
}

function splitWords(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean);
}

function splitSlashValues(value) {
  return String(value ?? '').split(/[\/|／]+/).map(item => item.trim()).filter(Boolean);
}

function scalarValues(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? [normalized] : [];
}

function uniqueValues(...values) {
  return [...new Set(values.flatMap(scalarValues))];
}

function parseBirthdayMonth(value) {
  const match = String(value ?? '').match(/^(1[0-2]|[1-9])月/);
  return match ? Number(match[1]) : undefined;
}

function normalizeDateTime(value) {
  const normalized = String(value ?? '').trim().replace(' ', 'T');
  if (!normalized) return undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized)
    ? normalized
    : undefined;
}
