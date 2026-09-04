import { GameData, ModuleCandidate, OwnedOperator } from '../domain/types';
import { CraftingEngine } from './crafting';
import { fulfillStages, totalRequirements } from './planning';

const unlockLevelByRarity: Record<number, number> = { 4: 40, 5: 50, 6: 60 };

export class ModulePlanner {
  private readonly definitions;
  private readonly recipes;

  constructor(gameData: GameData) {
    this.definitions = new Map(gameData.operators.map(operator => [operator.operatorId, operator]));
    this.recipes = gameData.materials.flatMap(material => material.recipe ? [material.recipe] : []);
  }

  candidates(ownedOperators: OwnedOperator[], inventory: Record<string, number>): ModuleCandidate[] {
    return this.singleStage(ownedOperators, inventory, []);
  }

  singleStage(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[]): ModuleCandidate[] {
    return this.plan(ownedOperators, inventory, unlimitedIds, false);
  }

  continuous(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[]): ModuleCandidate[] {
    return this.plan(ownedOperators, inventory, unlimitedIds, true);
  }

  private plan(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[], continuous: boolean): ModuleCandidate[] {
    const candidates: ModuleCandidate[] = [];
    const plannedEngine = new CraftingEngine(this.recipes, new Set(unlimitedIds));
    const finiteEngine = unlimitedIds.length ? new CraftingEngine(this.recipes) : plannedEngine;
    for (const owned of ownedOperators) {
      const operator = this.definitions.get(owned.operatorId);
      if (!operator || owned.elitePhase < 2 || owned.level < (unlockLevelByRarity[operator.rarity] ?? Infinity)) continue;
      for (const module of operator.modules ?? []) {
        const from = Math.max(0, Math.min(3, owned.modules?.find(item => item.moduleId === module.moduleId)?.level ?? 0));
        if (from >= 3) continue;
        const requested = [];
        for (let level = from + 1; level <= (continuous ? 3 : from + 1); level++) {
          const requirements = module.requirements[level as 1 | 2 | 3] ?? [];
          if (!requirements.length) break;
          requested.push({ from: level - 1, to: level, requirements });
        }
        const planned = fulfillStages(plannedEngine, inventory, requested);
        if (!planned.length || (continuous && planned.length < 2)) continue;
        const finite = unlimitedIds.length ? fulfillStages(finiteEngine, inventory, requested) : planned;
        const stages = (planned.length > finite.length ? planned : finite).slice(0, planned.length);
        const usesUnlimited = planned.length > finite.length;
        const last = stages.at(-1)!;
        candidates.push({
          operator, currentLevel: owned.level, module, from, to: last.to, stages,
          requirements: totalRequirements(stages),
          craft: last.craft,
          usesUnlimited,
          unlimitedRoots: usesUnlimited ? [...new Set(stages.flatMap(stage => stage.craft.unlimitedRoots))].sort() : [],
          remainingInventory: last.craft.remainingInventory,
        });
      }
    }
    return candidates.sort((a, b) => b.from - a.from
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      || a.module.name.localeCompare(b.module.name, 'zh-CN'));
  }
}
