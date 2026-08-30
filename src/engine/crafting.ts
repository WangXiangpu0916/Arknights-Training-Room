import {
  CraftResult,
  CraftStep,
  MaterialAmount,
  Recipe,
} from '../domain/types';

type Inventory = Record<string, number>;

export function directCraftableQuantity(inventory: Inventory, recipe?: Recipe): number {
  if (!recipe?.ingredients.length || !Number.isSafeInteger(recipe.outputQuantity) || recipe.outputQuantity <= 0) return 0;
  const batches = Math.min(...recipe.ingredients.map(ingredient => {
    if (!Number.isSafeInteger(ingredient.quantity) || ingredient.quantity <= 0) return 0;
    return Math.floor(Math.max(0, inventory[ingredient.itemId] ?? 0) / ingredient.quantity);
  }));
  return Math.max(0, batches) * recipe.outputQuantity;
}

interface MutableRun {
  inventory: Inventory;
  roots: Set<string>;
}

export class CraftingEngine {
  private readonly recipes = new Map<string, Recipe>();
  private readonly unlimitedMemo = new Map<string, Set<string> | null>();

  constructor(recipes: Recipe[], private readonly unlimited: Set<string> = new Set()) {
    for (const recipe of recipes) this.recipes.set(recipe.productItemId, recipe);
  }

  fulfill(inventory: Inventory, requirements: MaterialAmount[]): CraftResult {
    const run: MutableRun = { inventory: { ...inventory }, roots: new Set() };
    const steps: CraftStep[] = [];

    for (const requirement of [...requirements].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      if (!Number.isSafeInteger(requirement.quantity) || requirement.quantity < 0) {
        return this.failure(inventory, steps, `材料 ${requirement.itemId} 数量无效`);
      }
      const snapshot = { ...run.inventory };
      const rootsSnapshot = new Set(run.roots);
      try {
        steps.push(this.ensure(run, requirement.itemId, requirement.quantity, new Set()));
      } catch (error) {
        run.inventory = snapshot;
        run.roots = rootsSnapshot;
        return this.failure(inventory, steps, (error as Error).message);
      }
    }

    return {
      feasible: true,
      remainingInventory: run.inventory,
      steps,
      unlimitedRoots: [...run.roots].sort(),
    };
  }

  private ensure(run: MutableRun, itemId: string, quantity: number, visiting: Set<string>): CraftStep {
    const infiniteRoots = this.getUnlimitedRoots(itemId, new Set());
    if (infiniteRoots) {
      for (const root of infiniteRoots) run.roots.add(root);
      return {
        itemId,
        requested: quantity,
        fromInventory: 0,
        crafted: 0,
        batches: 0,
        outputQuantity: 1,
        ingredients: [],
        children: [],
        unlimitedRoots: [...infiniteRoots].sort(),
      };
    }

    const available = Math.max(0, run.inventory[itemId] ?? 0);
    const fromInventory = Math.min(available, quantity);
    run.inventory[itemId] = available - fromInventory;
    const shortage = quantity - fromInventory;
    if (shortage === 0) {
      return {
        itemId,
        requested: quantity,
        fromInventory,
        crafted: 0,
        batches: 0,
        outputQuantity: 1,
        ingredients: [],
        children: [],
        unlimitedRoots: [],
      };
    }

    const recipe = this.recipes.get(itemId);
    if (!recipe) throw new Error(`${itemId} 库存不足且无法加工`);
    if (visiting.has(itemId)) throw new Error(`加工配方存在循环依赖：${itemId}`);
    if (!Number.isSafeInteger(recipe.outputQuantity) || recipe.outputQuantity <= 0) {
      throw new Error(`${itemId} 的配方产量无效`);
    }

    const batches = Math.ceil(shortage / recipe.outputQuantity);
    const nextVisiting = new Set(visiting).add(itemId);
    const children = recipe.ingredients.map(ingredient =>
      this.ensure(run, ingredient.itemId, ingredient.quantity * batches, nextVisiting),
    );
    const produced = batches * recipe.outputQuantity;
    run.inventory[itemId] = (run.inventory[itemId] ?? 0) + produced - shortage;

    return {
      itemId,
      requested: quantity,
      fromInventory,
      crafted: produced,
      batches,
      outputQuantity: recipe.outputQuantity,
      ingredients: recipe.ingredients.map(x => ({
        itemId: x.itemId,
        quantity: x.quantity * batches,
      })),
      children,
      unlimitedRoots: [...new Set(children.flatMap(x => x.unlimitedRoots))].sort(),
    };
  }

  private getUnlimitedRoots(itemId: string, visiting: Set<string>): Set<string> | null {
    if (this.unlimited.has(itemId)) return new Set([itemId]);
    if (this.unlimitedMemo.has(itemId)) return this.unlimitedMemo.get(itemId)!;
    if (visiting.has(itemId)) return null;
    const recipe = this.recipes.get(itemId);
    if (!recipe || recipe.ingredients.length === 0) {
      this.unlimitedMemo.set(itemId, null);
      return null;
    }

    const roots = new Set<string>();
    const nextVisiting = new Set(visiting).add(itemId);
    for (const ingredient of recipe.ingredients) {
      const ingredientRoots = this.getUnlimitedRoots(ingredient.itemId, nextVisiting);
      if (!ingredientRoots) {
        this.unlimitedMemo.set(itemId, null);
        return null;
      }
      for (const root of ingredientRoots) roots.add(root);
    }
    this.unlimitedMemo.set(itemId, roots);
    return roots;
  }

  private failure(inventory: Inventory, steps: CraftStep[], error: string): CraftResult {
    return {
      feasible: false,
      remainingInventory: { ...inventory },
      steps,
      unlimitedRoots: [],
      error,
    };
  }
}
