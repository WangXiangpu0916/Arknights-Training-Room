import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import presentPlans from '../renderer/plan-order.js';
import { spawnSync } from 'node:child_process';

// Whole-result compatibility, including nested crafting trees and inventory.
const game = JSON.parse(await readFile('dist/resource/snapshot/data/game.json', 'utf8'));
const account = JSON.parse(await readFile('qa-fixture/account-cache.json', 'utf8'));
const settings = JSON.parse(await readFile('qa-fixture/settings.json', 'utf8'));
const fixturePath = 'tests/fixtures/domain-compatibility.json';
const canonical = value => JSON.stringify(value, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const cases = [
  { name: 'empty', account: null, unlimited: [] },
  { name: 'fixture-real', account, unlimited: [] },
  { name: 'fixture-unlimited', account, unlimited: settings.unlimitedItemIds },
  ...[0, 1, 2].flatMap(phase => [0, 1, 2, 3].map(level => ({
    name: `all-e${phase}-m${level}`,
    account: { ...account, operators: game.operators.map(o => ({ operatorId: o.operatorId, elitePhase: phase,
      level: phase === 2 ? 90 : 1, experience: 0, skillLevel: 7,
      skills: o.skills.map(s => ({ skillId: s.skillId, masteryLevel: level })),
      modules: (o.modules ?? []).map(m => ({ moduleId: m.moduleId, level })),
    })), inventory: Object.fromEntries(game.materials.map(m => [m.itemId, m.itemId === game.progression.lmdItemId ? 999999999 : 999999])) },
    unlimited: [],
  }))),
];
for (const phase of [0, 2]) for (const quantity of [0, 1, 3, 17]) for (const unlimited of [[], game.materials.filter(m => m.rarity === 3 || m.type === 3).map(m => m.itemId)]) {
  cases.push({name:`scarce-e${phase}-q${quantity}-${unlimited.length ? 'unlimited' : 'real'}`,
    account:{...cases.find(c=>c.name === `all-e${phase}-m0`).account,
      inventory:Object.fromEntries(game.materials.map(m=>[m.itemId,m.itemId==='4001'?quantity*10000:quantity]))}, unlimited});
}
const expected = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(hash(game), expected.gameSha256, 'Resource snapshot changed; review compatibility fixture before updating it');
for (const item of cases) {
  const child = spawnSync(process.env.ATR_DOMAIN_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','debug/examples/domain-check.exe'), [], {
    input:JSON.stringify({game,...item}), encoding:'utf8', maxBuffer:256*1024*1024, windowsHide:true,
  });
  assert.equal(child.status,0,child.stderr);
  const result = presentPlans(JSON.parse(child.stdout));
  assert.equal(result.training, null, 'Legacy fixtures have no active training');
  delete result.training; // Compare the unchanged planning contract before training was added.
  const digest = hash(result);
  assert.equal(digest,expected.cases.find(c=>c.name===item.name)?.sha256,item.name);
  console.log(item.name + ': ' + digest);
}
