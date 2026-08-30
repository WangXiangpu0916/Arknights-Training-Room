import assert from 'node:assert/strict';
import test from 'node:test';
import { GameData, OperatorDefinition, OwnedOperator } from '../src/domain/types';
import { directCraftableQuantity } from '../src/engine/crafting';
import { ModulePlanner } from '../src/engine/module';
import { PromotionPlanner } from '../src/engine/promotion';

const operator: OperatorDefinition = {
  operatorId: 'op', name: '测试干员', rarity: 6, profession: '术师', subProfession: '中坚术师',
  tags: ['远程位', '输出'], skills: [],
  promotionRequirements: {
    1: [{ itemId: 'A', quantity: 2 }],
    2: [{ itemId: 'B', quantity: 3 }],
  },
  modules: [
    { moduleId: 'mod-x', name: '模组 X', requirements: { 1: [{ itemId: 'A', quantity: 2 }], 2: [{ itemId: 'B', quantity: 2 }], 3: [{ itemId: 'C', quantity: 2 }] } },
    { moduleId: 'mod-y', name: '模组 Y', requirements: { 1: [{ itemId: 'A', quantity: 1 }], 2: [], 3: [] } },
  ],
};
const gameData: GameData = {
  version: 'test', updatedAt: new Date(0).toISOString(), operators: [operator],
  materials: ['A', 'B', 'C'].map(itemId => ({ itemId, name: itemId, rarity: 1, type: 0 })),
};
const owned = (patch: Partial<OwnedOperator> = {}): OwnedOperator => ({
  operatorId: 'op', elitePhase: 0, level: 1, skillLevel: 1, skills: [], modules: [], ...patch,
});

test('精英化规划覆盖 E0→E1、E1→E2、材料不足和已 E2', () => {
  const planner = new PromotionPlanner(gameData);
  assert.deepEqual(planner.candidates([owned({ level: 50 })], { A: 2 }).map(item => [item.from, item.to]), [[0, 1]]);
  assert.equal(planner.candidates([owned({ level: 49 })], { A: 2 }).length, 0);
  assert.equal(planner.candidates([owned({ level: 50 })], { A: 1 }).length, 0);
  assert.deepEqual(planner.candidates([owned({ elitePhase: 1, level: 80 })], { B: 3 }).map(item => [item.from, item.to]), [[1, 2]]);
  assert.equal(planner.candidates([owned({ elitePhase: 1, level: 79 })], { B: 3 }).length, 0);
  assert.equal(planner.candidates([owned({ elitePhase: 1, level: 80 })], { B: 2 }).length, 0);
  assert.equal(planner.candidates([owned({ elitePhase: 2 })], { A: 99, B: 99 }).length, 0);
});

test('模组规划覆盖无模组、单/多模组、等级门槛、材料和当前等级', () => {
  const planner = new ModulePlanner(gameData);
  assert.equal(planner.candidates([owned({ elitePhase: 1, level: 90 })], { A: 99 }).length, 0);
  assert.equal(planner.candidates([owned({ elitePhase: 2, level: 59 })], { A: 99 }).length, 0);
  assert.deepEqual(planner.candidates([owned({ elitePhase: 2, level: 60 })], { A: 2 }).map(item => item.module.moduleId), ['mod-x', 'mod-y']);
  assert.deepEqual(planner.candidates([owned({ elitePhase: 2, level: 60, modules: [{ moduleId: 'mod-x', level: 1 }] })], { B: 2 }).map(item => [item.module.moduleId, item.from, item.to]), [['mod-x', 1, 2]]);
  assert.equal(planner.candidates([owned({ elitePhase: 2, level: 60, modules: [{ moduleId: 'mod-x', level: 3 }, { moduleId: 'mod-y', level: 3 }] })], { A: 99, B: 99, C: 99 }).length, 0);
  assert.equal(new ModulePlanner({ ...gameData, operators: [{ ...operator, modules: [] }] }).candidates([owned({ elitePhase: 2, level: 60 })], { A: 99 }).length, 0);
});

test('直接可合成数量覆盖无配方、恰好一次、多次、多产物和瓶颈', () => {
  const recipe = { productItemId: 'P', outputQuantity: 1, ingredients: [{ itemId: 'A', quantity: 2 }, { itemId: 'B', quantity: 3 }] };
  assert.equal(directCraftableQuantity({ A: 99, B: 99 }), 0);
  assert.equal(directCraftableQuantity({ A: 2, B: 3 }, recipe), 1);
  assert.equal(directCraftableQuantity({ A: 8, B: 10 }, recipe), 3);
  assert.equal(directCraftableQuantity({ A: 99, B: 2 }, recipe), 0);
  assert.equal(directCraftableQuantity({ A: 6, B: 9 }, { ...recipe, outputQuantity: 2 }), 6);
});
