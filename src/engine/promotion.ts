import { GameData, OwnedOperator, PromotionCandidate, PromotionStagePlan } from '../domain/types';
import { CraftingEngine } from './crafting';
import { fulfillStages, mergeRequirements, totalRequirements } from './planning';

const promotionLevel: Record<number, Partial<Record<1 | 2, number>>> = {
  3: { 1: 40 },
  4: { 1: 45, 2: 60 },
  5: { 1: 50, 2: 70 },
  6: { 1: 50, 2: 80 },
};

export class PromotionPlanner {
  private readonly definitions;
  private readonly recipes;

  constructor(private readonly gameData: GameData) {
    this.definitions = new Map(gameData.operators.map(operator => [operator.operatorId, operator]));
    this.recipes = gameData.materials.flatMap(material => material.recipe ? [material.recipe] : []);
  }

  candidates(ownedOperators: OwnedOperator[], inventory: Record<string, number>): PromotionCandidate[] {
    return this.singleStage(ownedOperators, inventory, []);
  }

  singleStage(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[]): PromotionCandidate[] {
    return this.plan(ownedOperators, inventory, unlimitedIds, false);
  }

  continuous(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[]): PromotionCandidate[] {
    return this.plan(ownedOperators, inventory, unlimitedIds, true);
  }

  private plan(ownedOperators: OwnedOperator[], inventory: Record<string, number>, unlimitedIds: string[], continuous: boolean): PromotionCandidate[] {
    const candidates: PromotionCandidate[] = [];
    const plannedEngine = new CraftingEngine(this.recipes, new Set(unlimitedIds));
    const finiteEngine = unlimitedIds.length ? new CraftingEngine(this.recipes) : plannedEngine;
    const experienceAvailable = Object.entries(this.gameData.progression.expItems)
      .reduce((sum, [itemId, value]) => sum + (inventory[itemId] ?? 0) * value, 0);
    for (const owned of ownedOperators) {
      if (owned.elitePhase >= 2) continue;
      const operator = this.definitions.get(owned.operatorId);
      if (!operator) continue;
      const requested: Array<Omit<PromotionStagePlan, 'craft'>> = [];
      let experienceRequired = 0;
      for (let from = owned.elitePhase; from < (continuous ? 2 : owned.elitePhase + 1); from++) {
        const to = from + 1;
        const maxLevel = promotionLevel[operator.rarity]?.[to as 1 | 2];
        const promotion = operator.promotionRequirements?.[to as 1 | 2];
        if (!maxLevel || !promotion?.length) break;
        const level = from === owned.elitePhase ? owned.level : 1;
        const progress = from === owned.elitePhase ? owned.experience ?? 0 : 0;
        const levelExperience = Math.max(0, this.sumCurve(this.gameData.progression.characterExpMap[from], level, maxLevel) - progress);
        const levelLmd = this.sumCurve(this.gameData.progression.characterUpgradeCostMap[from], level, maxLevel);
        const promotionLmd = this.gameData.progression.evolveGoldCost[operator.rarity - 1]?.[to - 1] ?? 0;
        if (experienceRequired + levelExperience > experienceAvailable) break;
        experienceRequired += levelExperience;
        requested.push({
          from,
          to,
          experienceRequired: levelExperience,
          requirements: mergeRequirements(promotion, [{ itemId: this.gameData.progression.lmdItemId, quantity: levelLmd + promotionLmd }]),
        });
      }
      const planned = fulfillStages(plannedEngine, inventory, requested);
      if (!planned.length || (continuous && planned.length < 2)) continue;
      const finite = unlimitedIds.length ? fulfillStages(finiteEngine, inventory, requested) : planned;
      const stages = (planned.length > finite.length ? planned : finite).slice(0, planned.length);
      const usesUnlimited = planned.length > finite.length;
      const last = stages.at(-1)!;
      candidates.push({
        operator,
        currentLevel: owned.level,
        from: owned.elitePhase,
        to: last.to,
        stages,
        requirements: totalRequirements(stages),
        craft: last.craft,
        experienceRequired: stages.reduce((sum, stage) => sum + stage.experienceRequired, 0),
        experienceAvailable,
        usesUnlimited,
        unlimitedRoots: usesUnlimited ? [...new Set(stages.flatMap(stage => stage.craft.unlimitedRoots))].sort() : [],
        remainingInventory: last.craft.remainingInventory,
      });
    }
    return candidates.sort((a, b) => b.to - a.to
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN'));
  }

  private sumCurve(curve: number[] | undefined, fromLevel: number, toLevel: number): number {
    return (curve ?? []).slice(Math.max(0, fromLevel - 1), Math.max(0, toLevel - 1))
      .filter(value => value >= 0)
      .reduce((sum, value) => sum + value, 0);
  }
}
