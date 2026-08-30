import { CraftResult, MaterialAmount, PlanStage, Recipe } from '../domain/types';
import { CraftingEngine } from './crafting';

export interface RequestedStage {
  from: number;
  to: number;
  requirements: MaterialAmount[];
}

export function fulfillStages<T extends RequestedStage>(
  recipes: Recipe[],
  inventory: Record<string, number>,
  stages: T[],
  unlimitedIds: string[] = [],
): Array<T & { craft: CraftResult }> {
  const planned: Array<T & { craft: CraftResult }> = [];
  let remaining = { ...inventory };
  for (const stage of stages) {
    const craft = new CraftingEngine(recipes, new Set(unlimitedIds)).fulfill(remaining, stage.requirements);
    if (!craft.feasible) break;
    planned.push({ ...stage, craft });
    remaining = craft.remainingInventory;
  }
  return planned;
}

export function totalRequirements(stages: Pick<PlanStage, 'requirements'>[]): MaterialAmount[] {
  const totals = new Map<string, number>();
  for (const stage of stages) {
    for (const item of stage.requirements) totals.set(item.itemId, (totals.get(item.itemId) ?? 0) + item.quantity);
  }
  return [...totals].map(([itemId, quantity]) => ({ itemId, quantity }));
}

export function mergeRequirements(...groups: MaterialAmount[][]): MaterialAmount[] {
  return totalRequirements(groups.map(requirements => ({ requirements })));
}
