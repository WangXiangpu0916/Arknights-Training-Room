import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  AccountSnapshot,
  CompletionStatistic,
  GameData,
  MasteryLevel,
  OperatorDefinition,
} from '../src/domain/types';
import { buildAccountStatistics, native } from './native-core';
import { ToolboxResourceConverter } from '../src/resources/converter';
import { validateGameData } from '../src/resources/validation';

const requirement = { 1: [{ itemId: 'a', quantity: 1 }], 2: [{ itemId: 'b', quantity: 1 }], 3: [{ itemId: 'c', quantity: 1 }] };
const operator = (
  operatorId: string,
  rarity: number,
  maxElitePhase: 0 | 1 | 2,
  skills = 0,
  modules = 0,
): OperatorDefinition => ({
  operatorId,
  name: operatorId,
  rarity,
  profession: '近卫',
  subProfession: '测试',
  maxElitePhase,
  skills: Array.from({ length: skills }, (_, index) => ({
    skillId: `${operatorId}-s${index + 1}`,
    operatorId,
    index: index + 1,
    name: `技能${index + 1}`,
    requirements: requirement,
  })),
  modules: Array.from({ length: modules }, (_, index) => ({
    moduleId: `${operatorId}-m${index + 1}`,
    name: `模组${index + 1}`,
    typeIcon: `x-${index}`,
    typeLabel: '测试模组',
    requirements: requirement,
  })),
});

const operators = [
  operator('six', 6, 2, 2, 2),
  operator('five', 5, 2, 1, 1),
  operator('four', 4, 2, 1, 1),
  operator('three', 3, 1),
  operator('two', 2, 0),
  operator('one', 1, 0),
];
const gameData: GameData = {
  version: 'test',
  updatedAt: '2026-09-02T00:00:00Z',
  operators,
  materials: [],
  progression: { characterExpMap: [], characterUpgradeCostMap: [], evolveGoldCost: [], expItems: {}, lmdItemId: '4001' },
};
const skills = (operatorId: string, levels: MasteryLevel[]) => levels.map((masteryLevel, index) => ({
  skillId: `${operatorId}-s${index + 1}`,
  masteryLevel,
}));
const account: AccountSnapshot = {
  uid: 'test',
  syncedAt: '2026-09-02T00:00:00Z',
  inventory: {},
  operators: [
    { operatorId: 'six', elitePhase: 2, level: 90, skillLevel: 7, skills: skills('six', [3, 2]), modules: [{ moduleId: 'six-m1', level: 1 }, { moduleId: 'six-m2', level: 3 }] },
    { operatorId: 'four', elitePhase: 1, level: 60, skillLevel: 7, skills: skills('four', [3]), modules: [] },
    { operatorId: 'two', elitePhase: 0, level: 30, skillLevel: 4, skills: [] },
  ],
};

test('统计统一应用全部已实装与仅已持有范围', () => {
  const statistics = buildAccountStatistics(gameData, account);
  assert.deepEqual([statistics.ownership.completed, statistics.ownership.total], [3, 6]);
  assert.deepEqual([statistics.scopes.all.mastery.completed, statistics.scopes.all.mastery.total], [2, 4]);
  assert.deepEqual([statistics.scopes.owned.mastery.completed, statistics.scopes.owned.mastery.total], [2, 3]);
  assert.deepEqual([statistics.scopes.all.moduleUnlocked.completed, statistics.scopes.all.moduleUnlocked.total], [2, 4]);
  assert.deepEqual([statistics.scopes.all.moduleStage3.completed, statistics.scopes.all.moduleStage3.total], [1, 4]);
  assert.deepEqual([statistics.scopes.owned.moduleUnlocked.completed, statistics.scopes.owned.moduleUnlocked.total], [2, 3]);
});

test('资源转换保留没有培养表的低星，统计与界面按同一资源动态汇总', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atr-statistics-'));
  try {
    await cp('resources/game-data', directory, { recursive: true });
    const read = async (name: string) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    const characters = await read('character.json');
    const names = await read('character-cn.json');
    const cultivate = await read('cultivate.json');
    // A future resource adds another low-star operator without any cultivation record.
    characters['test_low'] = { star: 1, profession: 1 };
    names['test_low'] = '新增一星';
    characters['test_announced'] = { star: 6, profession: 1 };
    names['test_announced'] = '未实装六星';
    await writeFile(path.join(directory, 'character.json'), JSON.stringify(characters));
    await writeFile(path.join(directory, 'character-cn.json'), JSON.stringify(names));
    const game = await new ToolboxResourceConverter().convert(directory);
    const low = game.operators.filter(op => op.rarity <= 2);
    assert.equal(low.length, Object.values(characters).filter((op: any) => op.star <= 2).length);
    assert.ok(!game.operators.some(op => op.operatorId === 'test_announced'));
    assert.ok(game.operators.some(op => op.operatorId === 'test_low'));
    for (const op of low) {
      assert.equal(cultivate[op.operatorId], undefined);
      assert.equal(op.maxElitePhase, 0);
      assert.deepEqual(op.skills, []);
      assert.deepEqual(op.promotionRequirements, { 1: [], 2: [] });
    }
    const renderer = await readFile('renderer/app.js', 'utf8');
    const context = vm.createContext({ esc: (value: string) => value });
    vm.runInContext(renderer.slice(renderer.indexOf('function percentage('), renderer.indexOf('function renderDashboard(')), context);
    const samples = [undefined, account, {
      ...account,
      operators: game.operators.map(op => ({ operatorId: op.operatorId, elitePhase: op.maxElitePhase!, level: 30, skillLevel: 1, skills: [] })),
    }];
    for (const sample of samples) {
      const statistics = buildAccountStatistics(game, sample);
      assert.equal(statistics.ownership.total, game.operators.length);
      assert.equal(statistics.ownership.completed, game.operators.filter(op => sample?.operators.some(owned => owned.operatorId === op.operatorId)).length);
      for (const scope of Object.values(statistics.scopes)) {
        for (const key of ['mastery', 'elite1', 'elite2'] as const) {
          assert.equal(scope[key].byRarity[1], undefined);
          assert.equal(scope[key].byRarity[2], undefined);
        }
      }
      const values: CompletionStatistic[] = [statistics.ownership, ...Object.values(statistics.scopes).flatMap(scope => Object.values(scope))];
      for (const value of values) {
        assert.equal(Object.values(value.byRarity).reduce((sum, item) => sum + item.total, 0), value.total);
        assert.equal(Object.values(value.byRarity).reduce((sum, item) => sum + item.completed, 0), value.completed);
        for (const count of [value, ...Object.values(value.byRarity)]) {
          assert.ok(count.completed <= count.total);
          const rate = count.total ? Math.round(count.completed / count.total * 100) : 0;
          assert.equal(context.percentage(count), rate);
          assert.ok(context.statisticLine('测试', count, 'stat-child').includes(`<span class="stat-rate">${rate}%</span>`));
        }
      }
      Object.assign(context, { state: { account: sample || account, statistics }, statisticsScope: 'all', content: { innerHTML: '' }, banners: () => '', bindActions: () => {} });
      context.renderStatistics();
      const ownership = context.content.innerHTML.split('<h2>技能专精</h2>')[0];
      for (const rarity of [1, 2, 3, 4, 5, 6]) assert.ok(ownership.includes(`>${rarity} 星</span>`));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('精英化完成度按真实上限且 E2 同时完成 E1', () => {
  const statistics = buildAccountStatistics(gameData, account);
  assert.deepEqual([statistics.scopes.all.elite1.completed, statistics.scopes.all.elite1.total], [2, 4]);
  assert.deepEqual([statistics.scopes.all.elite2.completed, statistics.scopes.all.elite2.total], [1, 3]);
  assert.deepEqual([statistics.scopes.owned.elite1.completed, statistics.scopes.owned.elite1.total], [2, 2]);
  assert.deepEqual([statistics.scopes.owned.elite2.completed, statistics.scopes.owned.elite2.total], [1, 2]);
});

test('特勤干员计入持有和培养完成度，但不会生成零材料培养规划', async () => {
  const { specialOperators } = require('../../scripts/resource-metadata.mjs');
  const character = { isNotObtainable: false, spTargetType: 'ROGUE', phases: [{}, {}, {}], skills: [{ skillId: 's', levelUpCostCond: [{}, {}, {}] }] };
  assert.deepEqual(Object.keys(specialOperators({
    char_special: character,
    char_unavailable: { ...character, isNotObtainable: true },
    char_normal: { ...character, spTargetType: 'NONE' },
    char_regular_costs: { ...character, phases: [{}, { evolveCost: [{ id: 'a', count: 1 }] }] },
  }, { equipDict: {} })), ['special']);
  const game = await new ToolboxResourceConverter().convert('resources/game-data');
  const specials = game.operators.filter(op => op.specialTraining);
  const source = JSON.parse(await readFile('resources/game-data/special-operators.json', 'utf8'));
  assert.deepEqual(specials.map(op => op.operatorId).sort(), Object.keys(source).sort());
  assert.ok(specials.length > 0);
  const manifest = { resourceVersion: game.version, buildTime: game.updatedAt } as any;
  validateGameData(game, manifest);
  const broken = structuredClone(game);
  delete broken.operators.find(op => op.specialTraining)!.specialTraining;
  assert.throws(() => validateGameData(broken, manifest), /消耗为空/);
  for (const op of specials) {
    for (const masteryLevel of [0, 3] as const) {
      const owned = { ...account, operators: [{ operatorId: op.operatorId, elitePhase: 2, level: 90, skillLevel: 7,
        skills: op.skills.map(skill => ({ skillId: skill.skillId, masteryLevel })), modules: op.modules!.map(module => ({ moduleId: module.moduleId, level: masteryLevel })) }] };
      const result = native({ game: { ...game, operators: [op] }, account: owned });
      const statistics = result.statistics;
      assert.deepEqual(statistics.ownership.byRarity[op.rarity], { completed: 1, total: 1 });
      for (const scope of Object.values(statistics.scopes) as any[]) {
        assert.deepEqual([scope.mastery.completed, scope.mastery.total], [masteryLevel === 3 ? op.skills.length : 0, op.skills.length]);
        assert.deepEqual([scope.moduleStage3.completed, scope.moduleStage3.total], [masteryLevel === 3 ? op.modules!.length : 0, op.modules!.length]);
        for (const key of ['elite1', 'elite2']) assert.deepEqual([scope[key].completed, scope[key].total], [1, 1]);
      }
      for (const plans of [result, result.promotions, result.modules]) {
        for (const key of ['single', 'continuous', 'singleReal', 'continuousReal']) assert.deepEqual(plans[key], []);
      }
    }
  }
});

test('星级子统计严格汇总到主统计且完成数不超过总数', () => {
  const statistics = buildAccountStatistics(gameData, account);
  const values: CompletionStatistic[] = [
    statistics.ownership,
    ...Object.values(statistics.scopes).flatMap(scope => Object.values(scope)),
  ];
  for (const value of values) {
    assert.ok(value.completed <= value.total);
    assert.equal(Object.values(value.byRarity).reduce((sum, item) => sum + item.completed, 0), value.completed);
    assert.equal(Object.values(value.byRarity).reduce((sum, item) => sum + item.total, 0), value.total);
  }
});
