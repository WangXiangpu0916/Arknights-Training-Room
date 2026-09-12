import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const samples = Math.max(3, Number(process.env.ATR_PERF_SAMPLES) || 7);
const outputPath = process.env.ATR_PERF_OUTPUT
  || path.join(root, 'output', 'performance', 'latest.json');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(label, task, count = samples) {
  await task();
  const timings = [];
  let value;
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    value = await task();
    timings.push(performance.now() - started);
  }
  return {
    label,
    medianMs: Number(median(timings).toFixed(3)),
    minMs: Number(Math.min(...timings).toFixed(3)),
    maxMs: Number(Math.max(...timings).toFixed(3)),
    samples: timings.map(value => Number(value.toFixed(3))),
    resultCount: Array.isArray(value) ? value.length : undefined,
  };
}

async function loadGameData() {
  return JSON.parse(await readFile(path.join(root, 'dist/resource/snapshot/data/game.json'), 'utf8'));
}

const [{ MasteryPlanner }, { PromotionPlanner }, { ModulePlanner }] = await Promise.all([
  import('../dist/src/engine/mastery.js'),
  import('../dist/src/engine/promotion.js'),
  import('../dist/src/engine/module.js'),
]);
const fixtureAccount = JSON.parse(await readFile(path.join(root, 'qa-fixture', 'account-cache.json'), 'utf8'));
const fixtureSettings = JSON.parse(await readFile(path.join(root, 'qa-fixture', 'settings.json'), 'utf8'));
const loadStarted = performance.now();
const gameData = await loadGameData();
const initializeMs = performance.now() - loadStarted;
const richInventory = Object.fromEntries(gameData.materials.map(material => [material.itemId, 999_999]));
for (const itemId of Object.keys(gameData.progression.expItems)) richInventory[itemId] = 999_999;
richInventory[gameData.progression.lmdItemId] = 999_999_999;

const masteryOwned = gameData.operators.map(operator => ({
  operatorId: operator.operatorId,
  level: 90,
  elitePhase: 2,
  skillLevel: 7,
  skills: operator.skills.map(skill => ({ skillId: skill.skillId, masteryLevel: 0 })),
  modules: [],
}));
const promotionOwned = gameData.operators.map(operator => ({
  operatorId: operator.operatorId,
  level: 1,
  elitePhase: 0,
  experience: 0,
  skillLevel: 1,
  skills: [],
  modules: [],
}));
const moduleOwned = gameData.operators.map(operator => ({
  operatorId: operator.operatorId,
  level: 90,
  elitePhase: 2,
  skillLevel: 7,
  skills: [],
  modules: (operator.modules ?? []).map(module => ({ moduleId: module.moduleId, level: 0 })),
}));
const unlimitedIds = fixtureSettings.unlimitedItemIds ?? [];
const mastery = new MasteryPlanner(gameData);
const promotion = new PromotionPlanner(gameData);
const modules = new ModulePlanner(gameData);

const benchmarks = [];
benchmarks.push(await measure('mastery.single.real', () => mastery.singleStage(masteryOwned, richInventory, [])));
benchmarks.push(await measure('mastery.continuous.real', () => mastery.continuous(masteryOwned, richInventory, [])));
benchmarks.push(await measure('mastery.single.unlimited', () => mastery.singleStage(masteryOwned, richInventory, unlimitedIds)));
benchmarks.push(await measure('mastery.continuous.unlimited', () => mastery.continuous(masteryOwned, richInventory, unlimitedIds)));
benchmarks.push(await measure('promotion.single.real', () => promotion.singleStage(promotionOwned, richInventory, [])));
benchmarks.push(await measure('promotion.continuous.real', () => promotion.continuous(promotionOwned, richInventory, [])));
benchmarks.push(await measure('module.single.real', () => modules.singleStage(moduleOwned, richInventory, [])));
benchmarks.push(await measure('module.continuous.real', () => modules.continuous(moduleOwned, richInventory, [])));

const report = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  samples,
  fixture: {
    operators: fixtureAccount.operators.length,
    gameOperators: gameData.operators.length,
    materials: gameData.materials.length,
    unlimitedItems: unlimitedIds.length,
  },
  initializeMs: Number(initializeMs.toFixed(3)),
  benchmarks,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
