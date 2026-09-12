import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pinyin } from 'pinyin-pro';
import { officialMetadata } from './resource-metadata.mjs';

const api = 'https://prts.wiki/api.php';
const headers = { 'User-Agent': 'Arknights-Training-Room/1.0' };
const metadataParams = {
  action: 'cargoquery',
  format: 'json',
  tables: 'chara=c,char_obtain=o,chara_extra_info=e',
  fields: [
    'c.charId', 'c.cn', 'c.position', 'c.tag', 'c.nation', 'c.org', 'c.team',
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
    tags: splitWords(title.tag),
  };
}

await writeFile(
  path.join('resources', 'game-data', 'operator-metadata.json'),
  `${JSON.stringify(operatorMetadata, null, 2)}\n`,
  'utf8',
);
console.log(`PRTS 干员资料同步完成：${Object.keys(operatorMetadata).length}`);

const itemRows = [];
for (let offset = 0; ; offset += 500) {
  const url = new URL(api);
  url.search = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    tables: 'item',
    fields: 'itemId,purpose,description',
    limit: '500',
    offset: String(offset),
  });
  const response = await request(url);
  if (!response.ok) throw new Error(`PRTS 材料资料请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`PRTS 材料资料请求失败：${payload.error.info}`);
  const rows = payload.cargoquery ?? [];
  itemRows.push(...rows);
  if (rows.length < 500) break;
}

const knownMaterialIds = new Set(Object.keys(JSON.parse(
  await readFile(path.join('resources', 'game-data', 'material-cn.json'), 'utf8'),
)));
const materialMetadata = {};
for (const { title } of itemRows) {
  const itemId = String(title.itemId ?? '').trim();
  if (!knownMaterialIds.has(itemId)) continue;
  materialMetadata[itemId] = {
    purpose: plainText(title.purpose),
    description: plainText(title.description),
  };
}
await writeFile(
  path.join('resources', 'game-data', 'material-metadata.json'),
  `${JSON.stringify(materialMetadata, null, 2)}\n`,
  'utf8',
);

const moduleResponse = await request(
  'https://raw.githubusercontent.com/arkntools/arknights-toolbox-data/master/assets/locales/cn/uniequip.json',
);
if (!moduleResponse.ok) throw new Error(`模组名称请求失败：HTTP ${moduleResponse.status}`);
const moduleNames = await moduleResponse.json();
await writeFile(
  path.join('resources', 'game-data', 'uniequip-cn.json'),
  `${JSON.stringify(moduleNames, null, 2)}\n`,
  'utf8',
);

const officialRoot = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel';
const [moduleDataResponse, constantsResponse, itemsResponse] = await Promise.all([
  request(`${officialRoot}/uniequip_table.json`),
  request(`${officialRoot}/gamedata_const.json`),
  request(`${officialRoot}/item_table.json`),
]);
for (const [label, response] of [['模组', moduleDataResponse], ['成长常量', constantsResponse], ['物品', itemsResponse]]) {
  if (!response.ok) throw new Error(`${label}数据请求失败：HTTP ${response.status}`);
}
const [moduleData, constants, officialItems] = await Promise.all([
  moduleDataResponse.json(), constantsResponse.json(), itemsResponse.json(),
]);
const { moduleMetadata, progression } = officialMetadata(moduleData, constants, officialItems, moduleNames);
await writeFile(
  path.join('resources', 'game-data', 'uniequip-metadata.json'),
  `${JSON.stringify(moduleMetadata, null, 2)}\n`,
  'utf8',
);
await writeFile(
  path.join('resources', 'game-data', 'progression.json'),
  `${JSON.stringify(progression, null, 2)}\n`,
  'utf8',
);
console.log(`PRTS 材料资料同步完成：${Object.keys(materialMetadata).length}；模组名称 ${Object.keys(moduleNames).length}；模组类型 ${Object.keys(moduleMetadata).length}`);

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

function plainText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[(?:[^|\]]+\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/{{[^{}]*}}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}
