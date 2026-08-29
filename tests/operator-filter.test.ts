import assert from 'node:assert/strict';
import test from 'node:test';

const OperatorFilters = require('../renderer/operator-filter.js') as {
  createState: () => any;
  matchesSearch: (operator: any, query: string) => boolean;
  filterRows: (rows: any[], state: any) => any[];
  hasActive: (state: any) => boolean;
  reset: (state: any) => void;
};

const operators = [
  {
    operatorId: '002_amiya', name: '阿米娅', rarity: 5, searchPinyin: 'amiya', searchPinyinInitials: 'amy',
    gender: '女', position: '远程位', profession: '术师', subProfession: '中坚术师',
    obtainMethods: ['主线剧情'], races: ['卡特斯', '奇美拉'], birthPlaces: ['雷姆必拓'],
    organizations: ['罗德岛'], teams: [], birthdayMonth: 12,
  },
  {
    operatorId: '4132_ascln', name: '阿斯卡纶', rarity: 6, searchPinyin: 'asikalun', searchPinyinInitials: 'askl',
    gender: '女', position: '近战位', profession: '特种', subProfession: '伏击客',
    obtainMethods: ['标准寻访'], races: ['萨卡兹'], birthPlaces: ['卡兹戴尔'],
    organizations: ['罗德岛', 'S.W.E.E.P.'], teams: [], birthdayMonth: 2,
  },
  {
    operatorId: '180_amgoat', name: '艾雅法拉', rarity: 6, searchPinyin: 'aiyafala', searchPinyinInitials: 'ayfl',
    gender: '女', position: '远程位', profession: '术师', subProfession: '中坚术师',
    obtainMethods: ['中坚寻访'], races: ['卡普里尼'], birthPlaces: ['莱塔尼亚'],
    organizations: ['莱塔尼亚'], teams: [], birthdayMonth: 10,
  },
];
const rows = operators.map((definition, index) => ({ definition, owned: { operatorId: definition.operatorId, index } }));

test('中文、完整拼音、首字母和大小写均可搜索', () => {
  assert.equal(OperatorFilters.matchesSearch(operators[0], '阿米娅'), true);
  for (const query of ['a', 'A', 'as', 'asi', 'askl']) {
    assert.equal(OperatorFilters.matchesSearch(operators[1], query), true, query);
  }
  assert.equal(OperatorFilters.matchesSearch(operators[2], 'ayfl'), true);
});

test('同维度 OR、不同维度 AND，且只筛选传入的已持有集合', () => {
  const state = OperatorFilters.createState();
  state.selected.rarity.add('5');
  state.selected.rarity.add('6');
  state.selected.position.add('近战位');
  assert.deepEqual(OperatorFilters.filterRows(rows, state).map(row => row.definition.name), ['阿斯卡纶']);
  state.search = 'ami';
  assert.deepEqual(OperatorFilters.filterRows(rows, state), []);
});

test('多值资料可命中，清除筛选后恢复全部', () => {
  const state = OperatorFilters.createState();
  state.selected.organizations.add('S.W.E.E.P.');
  state.selected.birthdayMonth.add('2');
  assert.deepEqual(OperatorFilters.filterRows(rows, state).map(row => row.definition.name), ['阿斯卡纶']);
  assert.equal(OperatorFilters.hasActive(state), true);
  OperatorFilters.reset(state);
  assert.equal(OperatorFilters.hasActive(state), false);
  assert.equal(OperatorFilters.filterRows(rows, state).length, rows.length);
});
