import { GameData, OwnedOperator, PromotionCandidate } from '../domain/types';
import { CraftingEngine } from './crafting';

const promotionLevel: Record<number, Partial<Record<1 | 2, number>>> = {
  3: { 1: 40 },
  4: { 1: 45, 2: 60 },
  5: { 1: 50, 2: 70 },
  6: { 1: 50, 2: 80 },
};

export class PromotionPlanner {
  private readonly definitions;
  private readonly recipes;

  constructor(gameData: GameData) {
    this.definitions = new Map(gameData.operators.map(operator => [operator.operatorId, operator]));
    this.recipes = gameData.materials.flatMap(material => material.recipe ? [material.recipe] : []);
  }

  candidates(ownedOperators: OwnedOperator[], inventory: Record<string, number>): PromotionCandidate[] {
    const candidates: PromotionCandidate[] = [];
    for (const owned of ownedOperators) {
      if (owned.elitePhase >= 2) continue;
      const operator = this.definitions.get(owned.operatorId);
      if (!operator) continue;
      const to = owned.elitePhase + 1;
      if (owned.level < (promotionLevel[operator.rarity]?.[to as 1 | 2] ?? Infinity)) continue;
      const requirements = operator.promotionRequirements?.[to as 1 | 2];
      if (!requirements?.length) continue;
      const craft = new CraftingEngine(this.recipes).fulfill(inventory, requirements);
      if (craft.feasible) candidates.push({ operator, from: owned.elitePhase, to, requirements, craft });
    }
    return candidates.sort((a, b) => b.to - a.to
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN'));
  }
}
