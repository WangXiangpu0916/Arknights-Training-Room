export type MasteryLevel = 0 | 1 | 2 | 3;

export interface MaterialAmount {
  itemId: string;
  quantity: number;
}

export interface Recipe {
  productItemId: string;
  outputQuantity: number;
  ingredients: MaterialAmount[];
}

export interface Material {
  itemId: string;
  name: string;
  rarity: number;
  type: number;
  recipe?: Recipe;
}

export interface SkillDefinition {
  skillId: string;
  operatorId: string;
  index: number;
  name: string;
  requirements: Record<1 | 2 | 3, MaterialAmount[]>;
}

export interface OperatorDefinition {
  operatorId: string;
  name: string;
  rarity: number;
  profession: string;
  subProfession: string;
  searchPinyin?: string;
  searchPinyinInitials?: string;
  implementationDate?: string;
  gender?: string;
  position?: string;
  obtainMethods?: string[];
  races?: string[];
  birthPlaces?: string[];
  organizations?: string[];
  teams?: string[];
  birthdayMonth?: number;
  skills: SkillDefinition[];
}

export interface OwnedSkill {
  skillId: string;
  masteryLevel: MasteryLevel;
}

export interface OwnedOperator {
  operatorId: string;
  level: number;
  elitePhase: number;
  skillLevel: number;
  skills: OwnedSkill[];
}

export interface AccountSnapshot {
  uid: string;
  nickname?: string;
  syncedAt: string;
  operators: OwnedOperator[];
  inventory: Record<string, number>;
}

export interface Settings {
  unlimitedItemIds: string[];
  continuousSort: 'forward' | 'reverse';
  selectedUid?: string;
  autoRefresh: boolean;
}

export interface CraftStep {
  itemId: string;
  requested: number;
  fromInventory: number;
  crafted: number;
  batches: number;
  outputQuantity: number;
  ingredients: MaterialAmount[];
  children: CraftStep[];
  unlimitedRoots: string[];
}

export interface CraftResult {
  feasible: boolean;
  remainingInventory: Record<string, number>;
  steps: CraftStep[];
  unlimitedRoots: string[];
  error?: string;
}

export interface MasteryStagePlan {
  from: MasteryLevel;
  to: MasteryLevel;
  requirements: MaterialAmount[];
  craft: CraftResult;
}

export interface MasteryCandidate {
  operator: OperatorDefinition;
  skill: SkillDefinition;
  from: MasteryLevel;
  to: MasteryLevel;
  stages: MasteryStagePlan[];
  usesUnlimited: boolean;
  unlimitedRoots: string[];
  remainingInventory: Record<string, number>;
}

export interface GameData {
  version: string;
  updatedAt: string;
  sourceCommit?: string;
  operators: OperatorDefinition[];
  materials: Material[];
}
