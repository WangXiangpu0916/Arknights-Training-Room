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

async function loadJson(name) {
  return JSON.parse(await readFile(path.join(root, 'resources', 'game-data', name), 'utf8'));
}

async function loadGameData() {
  const [
    characters,
    cultivate,
    items,
    characterNames,
    materialNames,
    skillNames,
    moduleNames,
    subProfessionNames,
    operatorMetadata,
    materialMetadata,
    moduleMetadata,
    progression,
    metadata,
  ] = await Promise.all([
    loadJson('character.json'),
    loadJson('cultivate.json'),
    loadJson('item.json'),
    loadJson('character-cn.json'),
    loadJson('material-cn.json'),
    loadJson('skill-cn.json'),
    loadJson('uniequip-cn.json'),
    loadJson('subprofession-cn.json'),
    loadJson('operator-metadata.json'),
    loadJson('material-metadata.json'),
    loadJson('uniequip-metadata.json'),
    loadJson('progression.json'),
    loadJson('data-version.json'),
  ]);
  const { professionFromToolboxId } = await import('../dist/src/domain/professions.js');
  const amounts = value => Object.entries(value).map(([itemId, quantity]) => ({ itemId, quantity }));
  const materials = Object.entries(items).map(([itemId, item]) => ({
    itemId,
    name: materialNames[itemId] ?? `未知材料 ${itemId}`,
    rarity: item.rare,
    type: item.type,
    purpose: materialMetadata[itemId]?.purpose ?? '',
    description: materialMetadata[itemId]?.description ?? '',
    recipe: item.formula && Object.keys(item.formula).length
      ? {
          productItemId: itemId,
          outputQuantity: item.type === 1 && (item.rare === 3 || item.rare === 4) ? 2 : 1,
          ingredients: amounts(item.formula),
        }
      : undefined,
  }));
  materials.push({ itemId: progression.lmdItemId, name: '龙门币', rarity: 1, type: 4 });
  const operators = [];
  for (const [operatorId, character] of Object.entries(characters)) {
    const raw = cultivate[operatorId] ?? {};
    if (!characterNames[operatorId]) continue;
    const profile = operatorMetadata[operatorId] ?? {};
    const hasE1Data = Boolean(raw.evolve?.[0] && Object.keys(raw.evolve[0]).length);
    const hasE2Data = Boolean(raw.evolve?.[1] && Object.keys(raw.evolve[1]).length);
    operators.push({
      operatorId,
      name: characterNames[operatorId],
      rarity: character.star,
      profession: professionFromToolboxId(character.profession),
      subProfession: subProfessionNames[operatorId] ?? '未知分支',
      searchPinyin: profile.pinyin ?? '',
      searchPinyinInitials: profile.pinyinInitials ?? '',
      implementationDate: profile.implementationDate,
      gender: profile.gender ?? '',
      position: profile.position ?? '',
      obtainMethods: profile.obtainMethods ?? [],
      races: profile.races ?? [],
      birthPlaces: profile.birthPlaces ?? [],
      organizations: profile.organizations ?? [],
      teams: profile.teams ?? [],
      birthdayMonth: profile.birthdayMonth,
      tags: profile.tags ?? [],
      maxElitePhase: hasE2Data ? 2 : hasE1Data || character.star === 3 ? 1 : 0,
      promotionRequirements: {
        1: amounts(raw.evolve?.[0] ?? {}),
        2: amounts(raw.evolve?.[1] ?? {}),
      },
      modules: (raw.uniequip ?? []).map(module => ({
        moduleId: module.id,
        name: moduleNames[module.id] ?? module.id,
        typeIcon: moduleMetadata[module.id]?.typeIcon ?? '',
        typeLabel: moduleMetadata[module.id]?.typeLabel ?? '特殊模组',
        requirements: moduleMetadata[module.id]?.requirements ?? {
          1: amounts(module.cost[0] ?? {}),
          2: amounts(module.cost[1] ?? {}),
          3: amounts(module.cost[2] ?? {}),
        },
      })),
      skills: (raw.skills?.elite ?? []).map((skill, index) => ({
        skillId: skill.name,
        operatorId,
        index: index + 1,
        name: skillNames[skill.name] ?? `技能 ${index + 1}`,
        requirements: {
          1: amounts(skill.cost[0] ?? {}),
          2: amounts(skill.cost[1] ?? {}),
          3: amounts(skill.cost[2] ?? {}),
        },
      })),
    });
  }
  return {
    version: metadata.version,
    updatedAt: metadata.updatedAt,
    sourceCommit: metadata.sourceCommit,
    operators,
    materials,
    progression,
  };
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
