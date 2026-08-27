import { GameData } from './types';

export function masteryMaterialIds(gameData: GameData): Set<string> {
  const recipes = new Map(
    gameData.materials.flatMap(material => material.recipe ? [[material.itemId, material.recipe] as const] : []),
  );
  const result = new Set<string>();
  const pending = gameData.operators.flatMap(operator =>
    operator.skills.flatMap(skill => Object.values(skill.requirements).flatMap(requirement =>
      requirement.map(material => material.itemId),
    )),
  );

  while (pending.length) {
    const itemId = pending.pop()!;
    if (result.has(itemId)) continue;
    result.add(itemId);
    for (const ingredient of recipes.get(itemId)?.ingredients ?? []) pending.push(ingredient.itemId);
  }
  return result;
}

export function unlimitedMaterialGroups(gameData: GameData): {
  blue: Set<string>;
  skillSummaries: Set<string>;
  allowed: Set<string>;
} {
  const mastery = masteryMaterialIds(gameData);
  const blue = new Set(gameData.materials
    .filter(material => material.rarity === 3
      && mastery.has(material.itemId)
      && material.type !== 3)
    .map(material => material.itemId));
  const skillSummaries = new Set(gameData.materials
    .filter(material => material.type === 3)
    .map(material => material.itemId));
  return { blue, skillSummaries, allowed: new Set([...blue, ...skillSummaries]) };
}
