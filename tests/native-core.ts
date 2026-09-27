// Run the original behavioral test cases against the real, Tauri-independent Rust core.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GameData, Recipe, MaterialAmount, CraftResult, OwnedOperator, MasteryCandidate, PromotionCandidate, ModuleCandidate, AccountSnapshot, AccountStatistics } from '../src/domain/types';
const present = require('../../renderer/plan-order.js');
export function native<T = any>(input: unknown): T {
  const target = process.env.CARGO_TARGET_DIR || 'src-tauri/target';
  const executable = process.env.ATR_DOMAIN_EXECUTABLE || path.join(target, 'debug/examples/domain-check.exe');
  const result = spawnSync(executable, [], { input: JSON.stringify(input), encoding:'utf8', maxBuffer:256*1024*1024, windowsHide:true });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
  return JSON.parse(result.stdout);
}
export class CraftingEngine {
  constructor(private recipes:Recipe[], private unlimited = new Set<string>()) {}
  fulfill(inventory:Record<string,number>, requirements:MaterialAmount[], processUnlimited = true):CraftResult {
    return native({kind:'craft',recipes:this.recipes,unlimited:[...this.unlimited],inventory,requirements,processUnlimited});
  }
}
class Planner<T> {
  constructor(private game:GameData, private kind:'mastery'|'promotions'|'modules') {}
  private plans(operators:OwnedOperator[], inventory:Record<string,number>, unlimited:string[], mode:'single'|'continuous'):T[] {
    const result = present(native({game:this.game,account:{operators,inventory},unlimited}));
    return (this.kind === 'mastery' ? result : result[this.kind])[mode];
  }
  singleStage(operators:OwnedOperator[], inventory:Record<string,number>, unlimited:string[] = []):T[] { return this.plans(operators,inventory,unlimited,'single'); }
  continuous(operators:OwnedOperator[], inventory:Record<string,number>, unlimited:string[] = []):T[] { return this.plans(operators,inventory,unlimited,'continuous'); }
  candidates(operators:OwnedOperator[], inventory:Record<string,number>):T[] { return this.singleStage(operators,inventory); }
}
export class MasteryPlanner extends Planner<MasteryCandidate> { constructor(game:GameData) { super(game,'mastery'); } }
export class PromotionPlanner extends Planner<PromotionCandidate> { constructor(game:GameData) { super(game,'promotions'); } }
export class ModulePlanner extends Planner<ModuleCandidate> { constructor(game:GameData) { super(game,'modules'); } }
export function recursiveCraftableQuantity(inventory:Record<string,number>, recipe:Recipe|undefined, recipes:Recipe[]):number { return native({kind:'quantity',recipes,inventory,itemId:recipe?.productItemId}); }
export function masteryMaterialIds(game:GameData):Set<string> { return new Set(native({kind:'groups',game}).mastery); }
export function unlimitedMaterialGroups(game:GameData) {
  const result = native({kind:'groups',game});
  return {blue:new Set<string>(result.blue),skillSummaries:new Set<string>(result.skillSummaries),allowed:new Set<string>([...result.blue,...result.skillSummaries])};
}
export function buildAccountStatistics(game:GameData, account?:AccountSnapshot):AccountStatistics { return native({kind:'statistics',game,account}); }
