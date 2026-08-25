import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameData,
  MasteryLevel,
  Material,
  OperatorDefinition,
  OwnedOperator,
  Recipe,
} from '../src/domain/types';
import { CraftingEngine } from '../src/engine/crafting';
import { MasteryPlanner } from '../src/engine/mastery';

const recipes: Recipe[] = [
  { productItemId: 'B', outputQuantity: 1, ingredients: [{ itemId: 'A', quantity: 3 }] },
  { productItemId: 'C', outputQuantity: 1, ingredients: [{ itemId: 'B', quantity: 2 }] },
  { productItemId: 'D', outputQuantity: 1, ingredients: [{ itemId: 'A', quantity: 2 }] },
  {
    productItemId: 'E',
    outputQuantity: 1,
    ingredients: [{ itemId: 'B', quantity: 2 }, { itemId: 'X', quantity: 1 }],
  },
  { productItemId: 'PAIR', outputQuantity: 2, ingredients: [{ itemId: 'A', quantity: 3 }] },
];

const makeEngine = (unlimited: string[] = []) => new CraftingEngine(recipes, new Set(unlimited));

const operator: OperatorDefinition = {
  operatorId: 'op',
  name: '测试干员',
  rarity: 6,
  profession: 1,
  skills: [1, 2, 3].map(index => ({
    skillId: `skill_${index}`,
    operatorId: 'op',
    index,
    name: `技能${index}`,
    requirements: {
      1: [{ itemId: 'A', quantity: 2 }],
      2: [{ itemId: 'B', quantity: 1 }],
      3: [{ itemId: 'C', quantity: 1 }],
    },
  })),
};

const materials: Material[] = ['A', 'B', 'C', 'D', 'E', 'X', 'PAIR'].map(itemId => ({
  itemId,
  name: itemId,
  rarity: 1,
  type: 0,
  recipe: recipes.find(x => x.productItemId === itemId),
}));

const gameData: GameData = {
  version: 'test',
  updatedAt: '2026-08-25T00:00:00Z',
  operators: [operator],
  materials,
};

function owned(levels: MasteryLevel[], overrides: Partial<OwnedOperator> = {}): OwnedOperator {
  return {
    operatorId: 'op',
    level: 90,
    elitePhase: 2,
    skillLevel: 7,
    skills: levels.map((masteryLevel, i) => ({ skillId: `skill_${i + 1}`, masteryLevel })),
    ...overrides,
  };
}

test('Case 1: 直接库存完全足够', () => {
  const result = makeEngine().fulfill({ A: 5 }, [{ itemId: 'A', quantity: 4 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.remainingInventory.A, 1);
});

test('Case 2: 高级材料不足时由低级材料补足', () => {
  const result = makeEngine().fulfill({ B: 1, A: 6 }, [{ itemId: 'B', quantity: 3 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.remainingInventory.A, 0);
});

test('Case 3: 多层递归合成', () => {
  const result = makeEngine().fulfill({ A: 6 }, [{ itemId: 'C', quantity: 1 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.steps[0].children[0].itemId, 'B');
});

test('Case 4: 两种高级材料争抢同一种低级材料', () => {
  const result = makeEngine().fulfill({ A: 4 }, [
    { itemId: 'B', quantity: 1 },
    { itemId: 'D', quantity: 1 },
  ]);
  assert.equal(result.feasible, false);
});

test('整数加工次数与多产物余量', () => {
  const result = makeEngine().fulfill({ A: 6 }, [{ itemId: 'PAIR', quantity: 3 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.remainingInventory.PAIR, 1);
});

test('循环配方不会产生 false positive', () => {
  const cycle = new CraftingEngine([
    { productItemId: 'Y', outputQuantity: 1, ingredients: [{ itemId: 'Z', quantity: 1 }] },
    { productItemId: 'Z', outputQuantity: 1, ingredients: [{ itemId: 'Y', quantity: 1 }] },
  ]);
  assert.equal(cycle.fulfill({}, [{ itemId: 'Y', quantity: 1 }]).feasible, false);
});

test('Case 5: 单阶段 M2 → M3 可行', () => {
  const result = new MasteryPlanner(gameData).singleStage([owned([2])], { A: 6 }, []);
  assert.equal(result[0].from, 2);
  assert.equal(result[0].to, 3);
});

test('Case 6: 仅 M0 → M1 连续可行', () => {
  const result = new MasteryPlanner(gameData).continuous([owned([0])], { A: 2 }, [], 'forward');
  assert.deepEqual([result[0].from, result[0].to], [0, 1]);
});

test('Case 7: M0 → M3 全部连续可行且顺序扣除', () => {
  const result = new MasteryPlanner(gameData).continuous([owned([0])], { A: 11 }, [], 'forward');
  assert.deepEqual([result[0].from, result[0].to], [0, 3]);
  assert.equal(result[0].stages.length, 3);
  assert.equal(result[0].remainingInventory.A, 0);
});

test('Case 8: M1 → M3 连续可行', () => {
  const result = new MasteryPlanner(gameData).continuous([owned([1])], { A: 12 }, [], 'forward');
  assert.deepEqual([result[0].from, result[0].to], [1, 3]);
});

test('Case 9: 无限原料直接满足需求', () => {
  const result = makeEngine(['A']).fulfill({}, [{ itemId: 'A', quantity: 999 }]);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.unlimitedRoots, ['A']);
});

test('Case 10: 无限原料参与有限高级材料合成', () => {
  const result = makeEngine(['A']).fulfill({}, [{ itemId: 'B', quantity: 3 }]);
  assert.equal(result.feasible, true);
  assert.deepEqual(result.unlimitedRoots, ['A']);
});

test('Case 11: 所有输入无限时产物无限', () => {
  const result = makeEngine(['A']).fulfill({}, [{ itemId: 'C', quantity: 1000 }]);
  assert.equal(result.feasible, true);
  assert.equal(result.steps[0].batches, 0);
});

test('Case 12: 部分输入无限、部分有限仍受有限材料约束', () => {
  assert.equal(makeEngine(['A']).fulfill({ X: 1 }, [{ itemId: 'E', quantity: 2 }]).feasible, false);
  assert.equal(makeEngine(['A']).fulfill({ X: 2 }, [{ itemId: 'E', quantity: 2 }]).feasible, true);
});

test('Case 13: 两个候选基于同一初始仓库独立计算', () => {
  const result = new MasteryPlanner(gameData).singleStage([owned([0, 0])], { A: 2 }, []);
  assert.equal(result.length, 2);
});

test('Case 14: 单阶段固定排序', () => {
  const result = new MasteryPlanner(gameData).singleStage([owned([0, 2, 1])], { A: 20 }, []);
  assert.deepEqual(result.map(x => `${x.from}-${x.to}`), ['2-3', '1-2', '0-1']);
});

test('Case 15: 连续排序 A', () => {
  const definitions: OperatorDefinition[] = [[0, 3], [1, 3], [2, 3], [0, 2], [1, 2], [0, 1]].map(
    ([from, to], i) => ({
      ...operator,
      operatorId: `op${i}`,
      name: `干员${i}`,
      skills: [{
        ...operator.skills[0],
        operatorId: `op${i}`,
        skillId: `s${i}`,
        requirements: {
          1: [{ itemId: `R${i}1`, quantity: 1 }],
          2: [{ itemId: `R${i}2`, quantity: 1 }],
          3: [{ itemId: `R${i}3`, quantity: 1 }],
        },
      }],
    }),
  );
  const ownedOps = definitions.map((d, i) => ({
    ...owned([0]),
    operatorId: d.operatorId,
    skills: [{ skillId: `s${i}`, masteryLevel: [0, 1, 2, 0, 1, 0][i] as MasteryLevel }],
  }));
  const inventory: Record<string, number> = {};
  const ends = [3, 3, 3, 2, 2, 1];
  definitions.forEach((_, i) => {
    for (let level = ([0, 1, 2, 0, 1, 0][i] + 1); level <= ends[i]; level++) inventory[`R${i}${level}`] = 1;
  });
  const planner = new MasteryPlanner({ ...gameData, operators: definitions, materials: [] });
  const forward = planner.continuous(ownedOps, inventory, [], 'forward');
  assert.deepEqual(forward.map(x => `${x.from}-${x.to}`), ['0-3', '1-3', '2-3', '0-2', '1-2', '0-1']);

  const reverse = planner.continuous(ownedOps, inventory, [], 'reverse');
  assert.deepEqual(reverse.map(x => `${x.from}-${x.to}`), ['0-1', '1-2', '0-2', '2-3', '1-3', '0-3']);
});

test('Case 17: M3 技能不进入候选', () => {
  const planner = new MasteryPlanner(gameData);
  assert.equal(planner.singleStage([owned([3])], { A: 999 }, []).length, 0);
  assert.equal(planner.continuous([owned([3])], { A: 999 }, [], 'forward').length, 0);
});

test('专精前置条件：精二且技能 Rank 7', () => {
  const planner = new MasteryPlanner(gameData);
  assert.equal(planner.singleStage([owned([0], { elitePhase: 1 })], { A: 2 }, []).length, 0);
  assert.equal(planner.singleStage([owned([0], { skillLevel: 6 })], { A: 2 }, []).length, 0);
});

test('Case 18: 仓库刷新后重新计算得到不同结果', () => {
  const planner = new MasteryPlanner(gameData);
  assert.equal(planner.singleStage([owned([0])], { A: 1 }, []).length, 0);
  assert.equal(planner.singleStage([owned([0])], { A: 2 }, []).length, 1);
});
