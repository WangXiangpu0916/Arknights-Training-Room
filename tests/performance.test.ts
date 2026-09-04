import assert from 'node:assert/strict';
import test from 'node:test';
import { AppService } from '../src/app-service';
import { CraftingEngine } from '../src/engine/crafting';
import { Recipe } from '../src/domain/types';

test('AppService 合并并发 state 计算、复用结果并在状态变化后失效', async () => {
  const service = Object.create(AppService.prototype) as any;
  service.stateRevision = 0;
  let builds = 0;
  service.buildState = async () => {
    builds += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { build: builds };
  };

  const [first, concurrent] = await Promise.all([service.state(), service.state()]);
  assert.equal(builds, 1);
  assert.strictEqual(first, concurrent);
  assert.strictEqual(await service.state(), first);
  assert.equal(builds, 1);

  service.credentialsChanged();
  const refreshed = await service.state();
  assert.equal(builds, 2);
  assert.notStrictEqual(refreshed, first);
});

test('CraftingEngine 实例可跨多次规划安全复用且不保留库存状态', () => {
  const recipes: Recipe[] = [
    { productItemId: 'B', outputQuantity: 1, ingredients: [{ itemId: 'A', quantity: 2 }] },
  ];
  const reused = new CraftingEngine(recipes);
  const first = reused.fulfill({ A: 4 }, [{ itemId: 'B', quantity: 1 }]);
  const second = reused.fulfill({ A: 4 }, [{ itemId: 'B', quantity: 1 }]);
  const fresh = new CraftingEngine(recipes).fulfill({ A: 4 }, [{ itemId: 'B', quantity: 1 }]);

  assert.deepEqual(second, first);
  assert.deepEqual(second, fresh);
});
