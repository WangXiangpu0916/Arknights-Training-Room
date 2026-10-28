import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolboxResourceConverter } from '../src/resources/converter';
import { validateGameData } from '../src/resources/validation';
import { readFile } from 'node:fs/promises';
import { MasteryPlanner, ModulePlanner, buildAccountStatistics } from './native-core';
const details = require('../renderer/skill-details.js');
const filters = require('../renderer/operator-filter.js');
const converted = new ToolboxResourceConverter().convert('resources/game-data');

test('阿米娅三形态合为一名干员，七个技能及三个模组完整参与展示与规划', async () => {
  const game = await converted;
  const amiya = game.operators.find(op => op.operatorId === '002_amiya')!;
  const skillIds = ['skcom_magic_rage_3', 'skchr_amiya_2', 'skchr_amiya_3',
    'skchr_amiya2_1', 'skchr_amiya2_2', 'skchr_amiya3_1', 'skchr_amiya3_2'];
  assert.deepEqual(amiya.skills.map(skill => skill.skillId), skillIds);
  assert.deepEqual(amiya.skills.map(skill => skill.index), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(amiya.skills.every(skill => skill.operatorId === amiya.operatorId));
  assert.ok(!game.operators.some(op => /_amiya\d+$/.test(op.operatorId)), '形态不能重复计为独立干员');
  assert.deepEqual(amiya.modules!.map(module => module.moduleId), ['uniequip_002_amiya', 'uniequip_002_amiya2', 'uniequip_002_amiya3']);
  const owned = { operatorId: amiya.operatorId, elitePhase: 2, level: 80, skillLevel: 7,
    skills: skillIds.map(skillId => ({ skillId, masteryLevel: 0 as const })), modules: [] };
  const inventory = Object.fromEntries(game.materials.map(item => [item.itemId, 999999]));
  assert.deepEqual(new Set(new MasteryPlanner(game).singleStage([owned], inventory).map(plan => plan.skill.skillId)), new Set(skillIds));
  assert.equal(new ModulePlanner(game).singleStage([owned], inventory).length, 3);
  const stats = buildAccountStatistics(game, { uid: 'amiya-test', syncedAt: '2026-10-28', operators: [owned], inventory });
  assert.equal(stats.scopes.owned.mastery.total, 7);
  const source = JSON.parse(await readFile('resources/game-data/skill-details.json', 'utf8'));
  for (const [index, skill] of amiya.skills.entries()) {
    const form = index < 3 ? '002_amiya' : index < 5 ? '1001_amiya2' : '1037_amiya3';
    assert.deepEqual(skill.requirements, source.operators[form].skills.find((s: any) => s.skillId === skill.skillId).requirements);
    assert.equal(game.skillDetails![skill.skillId].length, 10);
    assert.equal(details.progress(amiya, owned, skill).current, 7);
    await readFile(`resources/images/skill/${skill.skillId}.png`);
  }
});

test('三星技能有图标、七级效果和六档公共升级材料，七级为 MAX', async () => {
  const game = await converted;
  const fang = game.operators.find(op => op.operatorId === '123_fang')!;
  assert.equal(fang.skills.length, 1);
  const skill = fang.skills[0];
  assert.equal(skill.maxLevel, 7);
  assert.equal(game.skillDetails![skill.skillId][6].spCost, 25);
  assert.match(game.skillDetails![skill.skillId][6].description, /6点部署费用/);
  await readFile(`resources/images/skill/${skill.skillId}.png`);
  for (let level = 1; level <= 7; level++) {
    const progress = details.progress(fang, { skillLevel: level, skills: [] }, skill);
    assert.equal(progress.current, level);
    assert.equal(progress.next, level === 7 ? null : level + 1);
    assert.deepEqual(progress.requirements, level === 7 ? null : fang.skillLevelRequirements![level - 1]);
  }
  assert.deepEqual(fang.skillLevelRequirements![0], [{ itemId: '3301', quantity: 1 }]);
  assert.deepEqual(fang.skillLevelRequirements![5], [{ itemId: '3303', quantity: 2 }, { itemId: '30053', quantity: 2 }]);
  assert.ok(game.operators.filter(op => op.rarity === 3).every(op => op.skills.length && op.skills.every(s => s.maxLevel === 7)));
  assert.deepEqual(new MasteryPlanner(game).singleStage([{operatorId: fang.operatorId, level: 90, elitePhase: 2, skillLevel: 7,
    skills: [{skillId: skill.skillId, masteryLevel: 0}]}], {}), [], '异常账号等级也不能让无专精技能产生免费专精候选');
});

test('公共技能等级与各自专精等级独立，材料始终只对应下一档', async () => {
  const game = await converted;
  const op = game.operators.find(op => op.operatorId === '172_svrash')!;
  const owned = { skillLevel: 7, skills: op.skills.map((s, i) => ({ skillId: s.skillId, masteryLevel: i })) };
  assert.deepEqual(op.skills.map(s => details.progress(op, owned, s).current), [7, 8, 9]);
  const skill = op.skills[2];
  for (let mastery = 0; mastery <= 3; mastery++) {
    owned.skills[2].masteryLevel = mastery;
    const progress = details.progress(op, owned, skill);
    assert.equal(progress.current, 7 + mastery);
    assert.deepEqual(progress.requirements, mastery === 3 ? null : skill.requirements[(mastery + 1) as 1 | 2 | 3]);
  }
  owned.skillLevel = 6;
  assert.deepEqual(op.skills.map(s => details.progress(op, owned, s).current), [6, 6, 6]);
  const level7 = game.skillDetails![skill.skillId][6], m3 = game.skillDetails![skill.skillId][9];
  assert.match(level7.description, /攻击力\+140%/);
  assert.match(level7.description, /防御力-70%/);
  assert.match(m3.description, /攻击力\+200%/);
  assert.equal(level7.duration, 26);
  assert.equal(m3.duration, 30);
  assert.equal(level7.initialSp, 60);
  assert.equal(m3.initialSp, 75);
});

test('浮窗默认下方、空间不足时上方，左右边界与长内容限制', () => {
  const view = { width: 1000, height: 800 }, card = { right: 970 };
  const below = details.position({ top: 100, bottom: 172 }, card, 400, 250, view);
  assert.deepEqual(below, { left: 570, top: 180, maxHeight: 608, placement: 'below' });
  const above = details.position({ top: 650, bottom: 722 }, card, 400, 250, view);
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 392);
  const long = details.position({ top: 400, bottom: 472 }, { right: 1500 }, 400, 2000, view);
  assert.equal(long.left, 588);
  assert.equal(long.top, 12);
  assert.equal(long.maxHeight, 380);
  assert.equal(details.position({ top: 10, bottom: 82 }, { right: 200 }, 296, 200, {width: 320, height: 500}).left, 12);
});

test('新资源中的克莱门莎按真实日期参与正序和倒序，未知日期置底', async () => {
  const game = await converted;
  const newer = game.operators.find(op => op.operatorId === '4231_clemnt')!;
  assert.ok(newer);
  assert.equal(newer.implementationDate, '2026-10-09T12:00:00+08:00');
  const older = game.operators.find(op => op.operatorId === '123_fang')!;
  const rows = [newer, older, { ...older, operatorId: 'unknown', name: '未知', implementationDate: undefined }].map(definition => ({ definition, owned: {} }));
  assert.deepEqual(filters.sortRows(rows, 'implementation-desc').map((r: any) => r.definition.name), [newer.name, older.name, '未知']);
  assert.deepEqual(filters.sortRows(rows, 'implementation-asc').map((r: any) => r.definition.name), [older.name, newer.name, '未知']);
});

test('所有技能等级均已解析，拒绝缺材料、非法数值或不完整更新', async () => {
  const game = await converted;
  const manifest = { resourceVersion: game.version, buildTime: game.updatedAt } as any;
  validateGameData(game, manifest);
  for (const levels of Object.values(game.skillDetails!)) for (const level of levels) assert.doesNotMatch(level.description, /\{[^{}]+\}|<[@$]/);
  const broken = structuredClone(game);
  delete broken.skillDetails;
  assert.throws(() => validateGameData(broken, manifest, game), /缺少技能详情/);
  const fang = game.operators.find(op => op.operatorId === '123_fang')!;
  const invalid = structuredClone(game);
  invalid.skillDetails![fang.skills[0].skillId][0].spCost = -1;
  assert.throws(() => validateGameData(invalid, manifest), /spCost/);
  const missing = structuredClone(game);
  missing.operators.find(op => op.operatorId === fang.operatorId)!.skillLevelRequirements = [];
  assert.throws(() => validateGameData(missing, manifest), /普通材料/);
});
