import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const InventoryCatalog = require('../renderer/inventory-catalog.js') as {
  buildSections: (materials: Array<{ itemId: string; name: string; rarity: number }>, query?: string) => {
    materials: Array<{ itemId: string; name: string; rarity: number }>;
    chips: Array<{ itemId: string; name: string; rarity: number }>;
    skills: Array<{ itemId: string; name: string; rarity: number }>;
  };
  classifyItem: (item: { itemId: string }) => string | null;
};

const items = JSON.parse(readFileSync('resources/game-data/item.json', 'utf8')) as Record<string, { rare: number }>;
const names = JSON.parse(readFileSync('resources/game-data/material-cn.json', 'utf8')) as Record<string, string>;
const materials = Object.entries(items).map(([itemId, item]) => ({
  itemId,
  name: names[itemId] ?? itemId,
  rarity: item.rare,
}));

test('仓库分类排除模组并按三类拆分', () => {
  const sections = InventoryCatalog.buildSections(materials);
  assert.equal(sections.materials.length, 61);
  assert.equal(sections.chips.length, 25);
  assert.equal(sections.skills.length, 3);
  assert.equal(materials.length - 61 - 25 - 3, 3);
  for (const id of ['mod_unlock_token', 'mod_update_token_1', 'mod_update_token_2']) {
    assert.equal(InventoryCatalog.classifyItem({ itemId: id }), null);
  }
});

test('常规材料置顶与品质倒序', () => {
  const { materials: rows } = InventoryCatalog.buildSections(materials);
  assert.deepEqual(rows.slice(0, 4).map(item => item.itemId), ['30103', '30093', '30083', '30073']);
  for (let index = 4; index < rows.length - 1; index += 1) {
    const current = rows[index];
    const next = rows[index + 1];
    assert.ok(current.rarity > next.rarity || (current.rarity === next.rarity && current.name.localeCompare(next.name, 'zh-CN') <= 0));
  }
});

test('职业芯片按等级与职业顺序排列', () => {
  const { chips } = InventoryCatalog.buildSections(materials);
  assert.deepEqual(chips.slice(0, 8).map(item => item.itemId), [
    '3213', '3223', '3233', '3243', '3253', '3263', '3273', '3283',
  ]);
  assert.deepEqual(chips.slice(8, 16).map(item => item.itemId), [
    '3212', '3222', '3232', '3242', '3252', '3262', '3272', '3282',
  ]);
  assert.deepEqual(chips.slice(16, 24).map(item => item.itemId), [
    '3211', '3221', '3231', '3241', '3251', '3261', '3271', '3281',
  ]);
  assert.equal(chips.at(-1)?.itemId, '32001');
});

test('技巧概要固定卷3到卷1', () => {
  const { skills } = InventoryCatalog.buildSections(materials);
  assert.deepEqual(skills.map(item => item.itemId), ['3303', '3302', '3301']);
});

test('搜索保持分类结构', () => {
  const chipSearch = InventoryCatalog.buildSections(materials, '芯片');
  assert.equal(chipSearch.materials.length, 0);
  assert.ok(chipSearch.chips.length > 0);
  assert.equal(chipSearch.skills.length, 0);
  const stoneSearch = InventoryCatalog.buildSections(materials, '研磨石');
  assert.equal(stoneSearch.materials.length, 2);
  assert.equal(stoneSearch.chips.length, 0);
  assert.equal(stoneSearch.skills.length, 0);
});
