import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const samples = Math.max(3, Number(process.env.ATR_PERF_SAMPLES) || 7);
const outputPath = process.env.ATR_PERF_OUTPUT
  || path.join(root, 'output', 'performance', 'latest.json');

function measure(label, owned, planner, continuous, unlimited) {
 const executable=path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','release/examples/domain-check.exe');
 const result=spawnSync(executable,[],{input:JSON.stringify({kind:'benchmark',game:gameData,account:{operators:owned,inventory:richInventory},planner,continuous,unlimited,samples}),encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
 if(result.status!==0)throw result.error || new Error(result.stderr);
 return {label,...JSON.parse(result.stdout)};
}

async function loadGameData() {
  return JSON.parse(await readFile(path.join(root, 'dist/resource/snapshot/data/game.json'), 'utf8'));
}

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

const benchmarks = [];
benchmarks.push(await measure('mastery.single.real', masteryOwned, 'mastery', false, []));
benchmarks.push(await measure('mastery.continuous.real', masteryOwned, 'mastery', true, []));
benchmarks.push(await measure('mastery.single.unlimited', masteryOwned, 'mastery', false, unlimitedIds));
benchmarks.push(await measure('mastery.continuous.unlimited', masteryOwned, 'mastery', true, unlimitedIds));
benchmarks.push(await measure('promotion.single.real', promotionOwned, 'promotion', false, []));
benchmarks.push(await measure('promotion.continuous.real', promotionOwned, 'promotion', true, []));
benchmarks.push(await measure('module.single.real', moduleOwned, 'module', false, []));
benchmarks.push(await measure('module.continuous.real', moduleOwned, 'module', true, []));

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
