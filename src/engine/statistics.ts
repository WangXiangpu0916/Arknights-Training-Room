import {
  AccountSnapshot,
  AccountStatistics,
  CompletionStatistic,
  GameData,
  OperatorDefinition,
  OwnedOperator,
  TrainingStatisticsScope,
} from '../domain/types';

interface StatisticItem {
  rarity: number;
  completed: boolean;
}

function completionStatistic(items: StatisticItem[]): CompletionStatistic {
  const byRarity: CompletionStatistic['byRarity'] = {};
  for (const item of items) {
    const bucket = byRarity[item.rarity] ??= { completed: 0, total: 0 };
    bucket.total += 1;
    if (item.completed) bucket.completed += 1;
  }
  const statistic = {
    completed: items.filter(item => item.completed).length,
    total: items.length,
    byRarity,
  };
  validateStatistic(statistic);
  return statistic;
}

function validateStatistic(statistic: CompletionStatistic): void {
  const groups = Object.values(statistic.byRarity);
  const completed = groups.reduce((sum, group) => sum + group.completed, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  if (statistic.completed > statistic.total || groups.some(group => group.completed > group.total)) {
    throw new Error('统计数据无效：完成数量大于有效总量');
  }
  if (completed !== statistic.completed || total !== statistic.total) {
    throw new Error('统计数据无效：星级子统计与总统计不一致');
  }
}

function supportsMastery(skill: OperatorDefinition['skills'][number]): boolean {
  return ([1, 2, 3] as const).every(level => Boolean(skill.requirements[level]?.length));
}

function maxElitePhase(operator: OperatorDefinition): number {
  if (operator.maxElitePhase !== undefined) return operator.maxElitePhase;
  if (operator.promotionRequirements?.[2]?.length) return 2;
  if (operator.promotionRequirements?.[1]?.length) return 1;
  if (operator.rarity >= 4) return 2;
  if (operator.rarity === 3) return 1;
  return 0;
}

function scopeStatistics(
  operators: OperatorDefinition[],
  ownedById: Map<string, OwnedOperator>,
): TrainingStatisticsScope {
  const mastery = operators.flatMap(operator => operator.skills
    .filter(supportsMastery)
    .map(skill => ({
      rarity: operator.rarity,
      completed: (ownedById.get(operator.operatorId)?.skills
        .find(owned => owned.skillId === skill.skillId)?.masteryLevel ?? 0) >= 3,
    })));
  const modules = operators.flatMap(operator => (operator.modules ?? []).map(module => ({
    rarity: operator.rarity,
    level: ownedById.get(operator.operatorId)?.modules
      ?.find(owned => owned.moduleId === module.moduleId)?.level ?? 0,
  })));
  const eliteItems = (target: 1 | 2) => operators
    .filter(operator => maxElitePhase(operator) >= target)
    .map(operator => ({
      rarity: operator.rarity,
      completed: (ownedById.get(operator.operatorId)?.elitePhase ?? 0) >= target,
    }));

  return {
    mastery: completionStatistic(mastery),
    moduleUnlocked: completionStatistic(modules.map(module => ({
      rarity: module.rarity,
      completed: module.level >= 1,
    }))),
    moduleStage3: completionStatistic(modules.map(module => ({
      rarity: module.rarity,
      completed: module.level >= 3,
    }))),
    elite1: completionStatistic(eliteItems(1)),
    elite2: completionStatistic(eliteItems(2)),
  };
}

export function buildAccountStatistics(gameData: GameData, account: AccountSnapshot | null): AccountStatistics {
  const ownedOperators = account?.operators ?? [];
  const ownedById = new Map(ownedOperators.map(operator => [operator.operatorId, operator]));
  const allOperators = gameData.operators;
  const ownedDefinitions = allOperators.filter(operator => ownedById.has(operator.operatorId));

  return {
    ownership: completionStatistic(allOperators.map(operator => ({
      rarity: operator.rarity,
      completed: ownedById.has(operator.operatorId),
    }))),
    scopes: {
      all: scopeStatistics(allOperators, ownedById),
      owned: scopeStatistics(ownedDefinitions, ownedById),
    },
  };
}
