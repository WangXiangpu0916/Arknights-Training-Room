import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountSnapshot,
  CompletionStatistic,
  GameData,
  MasteryLevel,
  OperatorDefinition,
} from '../src/domain/types';
import { buildAccountStatistics } from '../src/engine/statistics';

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
  assert.deepEqual([statistics.ownership.completed, statistics.ownership.total], [3, 5]);
  assert.deepEqual([statistics.scopes.all.mastery.completed, statistics.scopes.all.mastery.total], [2, 4]);
  assert.deepEqual([statistics.scopes.owned.mastery.completed, statistics.scopes.owned.mastery.total], [2, 3]);
  assert.deepEqual([statistics.scopes.all.moduleUnlocked.completed, statistics.scopes.all.moduleUnlocked.total], [2, 4]);
  assert.deepEqual([statistics.scopes.all.moduleStage3.completed, statistics.scopes.all.moduleStage3.total], [1, 4]);
  assert.deepEqual([statistics.scopes.owned.moduleUnlocked.completed, statistics.scopes.owned.moduleUnlocked.total], [2, 3]);
});

test('精英化完成度按真实上限且 E2 同时完成 E1', () => {
  const statistics = buildAccountStatistics(gameData, account);
  assert.deepEqual([statistics.scopes.all.elite1.completed, statistics.scopes.all.elite1.total], [2, 4]);
  assert.deepEqual([statistics.scopes.all.elite2.completed, statistics.scopes.all.elite2.total], [1, 3]);
  assert.deepEqual([statistics.scopes.owned.elite1.completed, statistics.scopes.owned.elite1.total], [2, 2]);
  assert.deepEqual([statistics.scopes.owned.elite2.completed, statistics.scopes.owned.elite2.total], [1, 2]);
  assert.deepEqual(statistics.eliteDistribution, { 0: 1, 1: 1, 2: 1 });
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

test('未持有干员不会被计入当前 E0 分布', () => {
  const statistics = buildAccountStatistics(gameData, { ...account, operators: [account.operators[0]] });
  assert.deepEqual(statistics.eliteDistribution, { 0: 0, 1: 0, 2: 1 });
});
