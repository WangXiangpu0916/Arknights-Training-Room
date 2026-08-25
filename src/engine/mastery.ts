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
const CONTINUOUS_FORWARD = ['0-3', '1-3', '2-3', '0-2', '1-2', '0-1'];

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
        const candidate = this.stageCandidate(definition, skill, from, to, inventory, unlimitedIds);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates.sort((a, b) =>
      SINGLE_ORDER[a.from] - SINGLE_ORDER[b.from]
      || a.operator.name.localeCompare(b.operator.name, 'zh-CN')
      || a.skill.index - b.skill.index,
    );
  }

  continuous(
    ownedOperators: OwnedOperator[],
    inventory: Record<string, number>,
    unlimitedIds: string[],
    order: 'forward' | 'reverse',
  ): MasteryCandidate[] {
    const candidates: MasteryCandidate[] = [];
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
          const run = new CraftingEngine(this.recipes, new Set(unlimitedIds)).fulfill(
            planningInventory,
            requirements,
          );
          if (!run.feasible) break;
          stages.push({ from: current, to: next, requirements, craft: run });
          planningInventory = run.remainingInventory;
          for (const root of run.unlimitedRoots) roots.add(root);
          current = next;
        }
        if (!stages.length) continue;

        const finiteEnd = this.continuousEnd(ownedSkill.masteryLevel, skill.requirements, inventory, []);
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

    const ranks = order === 'forward' ? CONTINUOUS_FORWARD : [...CONTINUOUS_FORWARD].reverse();
    return candidates.sort((a, b) =>
      ranks.indexOf(`${a.from}-${a.to}`) - ranks.indexOf(`${b.from}-${b.to}`)
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
    unlimitedIds: string[],
  ): MasteryCandidate | null {
    const requirements = skill.requirements[to as 1 | 2 | 3] ?? [];
    const craft = new CraftingEngine(this.recipes, new Set(unlimitedIds)).fulfill(inventory, requirements);
    if (!craft.feasible) return null;
    const finite = new CraftingEngine(this.recipes).fulfill(inventory, requirements);
    const usesUnlimited = !finite.feasible;
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
    unlimitedIds: string[],
  ): MasteryLevel {
    let current = from;
    let planningInventory = { ...inventory };
    while (current < 3) {
      const next = (current + 1) as MasteryLevel;
      const result = new CraftingEngine(this.recipes, new Set(unlimitedIds)).fulfill(
        planningInventory,
        requirements[next as 1 | 2 | 3] ?? [],
      );
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
