import {
  GameData,
  MasteryCandidate,
  MasteryLevel,
  MasteryStagePlan,
  OwnedOperator,
  OperatorDefinition,
} from '../domain/types';
import { CraftingEngine } from './crafting';

const SINGLE_ORDER: Record<number, number> = { 2: 0, 1: 1, 0: 2 };
const CONTINUOUS_FORWARD = ['0-3', '1-3', '0-2'];

export class MasteryPlanner {
  private readonly definitions = new Map<string, OperatorDefinition>();
  private readonly recipes;

  constructor(private readonly gameData: GameData) {
    for (const operator of gameData.operators) this.definitions.set(operator.operatorId, operator);
    this.recipes = gameData.materials.flatMap(x => (x.recipe ? [x.recipe] : []));
  }

  singleStage(
    ownedOperators: OwnedOperator[],
    inventory: Record<string, number>,
    unlimitedIds: string[],
  ): MasteryCandidate[] {
    const candidates: MasteryCandidate[] = [];
    const plannedEngine = new CraftingEngine(this.recipes, new Set(unlimitedIds));
    const finiteEngine = unlimitedIds.length ? new CraftingEngine(this.recipes) : plannedEngine;
    for (const owned of ownedOperators) {
      if (!this.canMaster(owned)) continue;
      const definition = this.definitions.get(owned.operatorId);
      if (!definition) continue;
      for (const ownedSkill of owned.skills) {
        if (ownedSkill.masteryLevel >= 3) continue;
        const skill = definition.skills.find(x => x.skillId === ownedSkill.skillId);
        if (!skill) continue;
        const from = ownedSkill.masteryLevel;
        const to = (from + 1) as MasteryLevel;
        const candidate = this.stageCandidate(definition, skill, from, to, inventory, plannedEngine, finiteEngine, unlimitedIds.length > 0);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates.sort((a, b) =>
      SINGLE_ORDER[a.from] - SINGLE_ORDER[b.from]
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      || a.skill.index - b.skill.index,
    );
  }

  continuous(
    ownedOperators: OwnedOperator[],
    inventory: Record<string, number>,
    unlimitedIds: string[],
  ): MasteryCandidate[] {
    const candidates: MasteryCandidate[] = [];
    const plannedEngine = new CraftingEngine(this.recipes, new Set(unlimitedIds));
    const finiteEngine = unlimitedIds.length ? new CraftingEngine(this.recipes) : plannedEngine;
    for (const owned of ownedOperators) {
      if (!this.canMaster(owned)) continue;
      const definition = this.definitions.get(owned.operatorId);
      if (!definition) continue;
      for (const ownedSkill of owned.skills) {
        if (ownedSkill.masteryLevel >= 3) continue;
        const skill = definition.skills.find(x => x.skillId === ownedSkill.skillId);
        if (!skill) continue;

        let planningInventory = { ...inventory };
        const stages: MasteryStagePlan[] = [];
        const roots = new Set<string>();
        let current = ownedSkill.masteryLevel;
        while (current < 3) {
          const next = (current + 1) as MasteryLevel;
          const requirements = skill.requirements[next as 1 | 2 | 3] ?? [];
          const run = plannedEngine.fulfill(planningInventory, requirements);
          if (!run.feasible) break;
          stages.push({ from: current, to: next, requirements, craft: run });
          planningInventory = run.remainingInventory;
          for (const root of run.unlimitedRoots) roots.add(root);
          current = next;
        }
        if (current - ownedSkill.masteryLevel < 2) continue;

        const finiteEnd = unlimitedIds.length
          ? this.continuousEnd(ownedSkill.masteryLevel, skill.requirements, inventory, finiteEngine)
          : current;
        candidates.push({
          operator: definition,
          skill,
          from: ownedSkill.masteryLevel,
          to: current,
          stages,
          usesUnlimited: current > finiteEnd,
          unlimitedRoots: current > finiteEnd ? [...roots].sort() : [],
          remainingInventory: planningInventory,
        });
      }
    }

    return candidates.sort((a, b) =>
      CONTINUOUS_FORWARD.indexOf(`${a.from}-${a.to}`) - CONTINUOUS_FORWARD.indexOf(`${b.from}-${b.to}`)
      || b.operator.rarity - a.operator.rarity
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      || a.skill.index - b.skill.index,
    );
  }

  private stageCandidate(
    operator: OperatorDefinition,
    skill: OperatorDefinition['skills'][number],
    from: MasteryLevel,
    to: MasteryLevel,
    inventory: Record<string, number>,
    plannedEngine: CraftingEngine,
    finiteEngine: CraftingEngine,
    compareFinite: boolean,
  ): MasteryCandidate | null {
    const requirements = skill.requirements[to as 1 | 2 | 3] ?? [];
    const craft = plannedEngine.fulfill(inventory, requirements);
    if (!craft.feasible) return null;
    const finite = compareFinite ? finiteEngine.fulfill(inventory, requirements) : craft;
    const usesUnlimited = compareFinite && !finite.feasible;
    const effectiveCraft = usesUnlimited ? craft : finite;
    return {
      operator,
      skill,
      from,
      to,
      stages: [{ from, to, requirements, craft: effectiveCraft }],
      usesUnlimited,
      unlimitedRoots: usesUnlimited ? craft.unlimitedRoots : [],
      remainingInventory: effectiveCraft.remainingInventory,
    };
  }

  private continuousEnd(
    from: MasteryLevel,
    requirements: OperatorDefinition['skills'][number]['requirements'],
    inventory: Record<string, number>,
    engine: CraftingEngine,
  ): MasteryLevel {
    let current = from;
    let planningInventory = { ...inventory };
    while (current < 3) {
      const next = (current + 1) as MasteryLevel;
      const result = engine.fulfill(planningInventory, requirements[next as 1 | 2 | 3] ?? []);
      if (!result.feasible) break;
      planningInventory = result.remainingInventory;
      current = next;
    }
    return current;
  }

  private canMaster(operator: OwnedOperator): boolean {
    return operator.elitePhase >= 2 && operator.skillLevel >= 7;
  }
}
