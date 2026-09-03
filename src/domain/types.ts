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
  purpose?: string;
  description?: string;
  recipe?: Recipe;
}

export interface ModuleDefinition {
  moduleId: string;
  name: string;
  typeIcon: string;
  typeLabel: string;
  requirements: Record<1 | 2 | 3, MaterialAmount[]>;
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
  tags?: string[];
  maxElitePhase?: 0 | 1 | 2;
  promotionRequirements?: Partial<Record<1 | 2, MaterialAmount[]>>;
  modules?: ModuleDefinition[];
  skills: SkillDefinition[];
}

export interface OwnedSkill {
  skillId: string;
  masteryLevel: MasteryLevel;
}

export interface OwnedOperator {
  operatorId: string;
  level: number;
  experience?: number;
  elitePhase: number;
  skillLevel: number;
  skills: OwnedSkill[];
  modules?: Array<{ moduleId: string; level: number }>;
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
  selectedUid?: string;
  autoRefresh: boolean;
  theme: 'system' | 'black' | 'light';
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

export interface PromotionCandidate {
  operator: OperatorDefinition;
  currentLevel: number;
  from: number;
  to: number;
  stages: PromotionStagePlan[];
  requirements: MaterialAmount[];
  craft: CraftResult;
  experienceRequired: number;
  experienceAvailable: number;
  usesUnlimited: boolean;
  unlimitedRoots: string[];
  remainingInventory: Record<string, number>;
}

export interface ModuleCandidate {
  operator: OperatorDefinition;
  currentLevel: number;
  module: ModuleDefinition;
  from: number;
  to: number;
  stages: PlanStage[];
  requirements: MaterialAmount[];
  craft: CraftResult;
  usesUnlimited: boolean;
  unlimitedRoots: string[];
  remainingInventory: Record<string, number>;
}

export interface PlanStage {
  from: number;
  to: number;
  requirements: MaterialAmount[];
  craft: CraftResult;
}

export interface PromotionStagePlan extends PlanStage {
  experienceRequired: number;
}

export interface ProgressionData {
  characterExpMap: number[][];
  characterUpgradeCostMap: number[][];
  evolveGoldCost: number[][];
  expItems: Record<string, number>;
  lmdItemId: string;
}

export interface GameData {
  version: string;
  updatedAt: string;
  sourceCommit?: string;
  operators: OperatorDefinition[];
  materials: Material[];
  progression: ProgressionData;
}

export interface CompletionCount {
  completed: number;
  total: number;
}

export interface CompletionStatistic extends CompletionCount {
  byRarity: Record<number, CompletionCount>;
}

export interface TrainingStatisticsScope {
  mastery: CompletionStatistic;
  moduleUnlocked: CompletionStatistic;
  moduleStage3: CompletionStatistic;
  elite1: CompletionStatistic;
  elite2: CompletionStatistic;
}

export interface AccountStatistics {
  ownership: CompletionStatistic;
  scopes: {
    all: TrainingStatisticsScope;
    owned: TrainingStatisticsScope;
  };
}
