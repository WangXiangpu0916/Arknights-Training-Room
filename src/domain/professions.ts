export const PRTS_PROFESSIONS = [
  '先锋',
  '近卫',
  '重装',
  '狙击',
  '术师',
  '医疗',
  '辅助',
  '特种',
] as const;

const TOOLBOX_PROFESSION_NAMES: Record<number, string> = {
  1: '近卫',
  2: '狙击',
  3: '重装',
  4: '医疗',
  5: '辅助',
  6: '术师',
  7: '特种',
  8: '先锋',
};

export function professionFromToolboxId(id: number): string {
  return TOOLBOX_PROFESSION_NAMES[id] ?? '未知职业';
}
