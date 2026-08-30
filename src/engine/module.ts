import { GameData, ModuleCandidate, OwnedOperator } from '../domain/types';
import { CraftingEngine } from './crafting';

const unlockLevelByRarity: Record<number, number> = { 4: 40, 5: 50, 6: 60 };

export class ModulePlanner {
  private readonly definitions;
  private readonly recipes;

  constructor(gameData: GameData) {
    this.definitions = new Map(gameData.operators.map(operator => [operator.operatorId, operator]));
    this.recipes = gameData.materials.flatMap(material => material.recipe ? [material.recipe] : []);
  }

  candidates(ownedOperators: OwnedOperator[], inventory: Record<string, number>): ModuleCandidate[] {
    const candidates: ModuleCandidate[] = [];
    for (const owned of ownedOperators) {
      const operator = this.definitions.get(owned.operatorId);
      if (!operator || owned.elitePhase < 2 || owned.level < (unlockLevelByRarity[operator.rarity] ?? Infinity)) continue;
      for (const module of operator.modules ?? []) {
        const from = Math.max(0, Math.min(3, owned.modules?.find(item => item.moduleId === module.moduleId)?.level ?? 0));
        if (from >= 3) continue;
        const to = from + 1;
        const requirements = module.requirements[to as 1 | 2 | 3] ?? [];
        if (!requirements.length) continue;
        const craft = new CraftingEngine(this.recipes).fulfill(inventory, requirements);
        if (craft.feasible) candidates.push({ operator, module, from, to, requirements, craft });
      }
    }
    return candidates.sort((a, b) => b.from - a.from
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      || a.module.name.localeCompare(b.module.name, 'zh-CN'));
  }
}
