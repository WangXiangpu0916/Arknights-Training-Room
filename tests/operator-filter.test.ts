import assert from 'node:assert/strict';
import test from 'node:test';

const OperatorFilters = require('../renderer/operator-filter.js') as {
  createState: () => any;
  matchesSearch: (operator: any, query: string) => boolean;
  filterRows: (rows: any[], state: any) => any[];
  sortRows: (rows: any[], mode: string) => any[];
  dimensionValues: (operator: any, key: string) => string[];
  valuesForRows: (rows: any[], key: string) => string[];
  hasActive: (state: any) => boolean;
  reset: (state: any) => void;
};

const operators = [
  {
    operatorId: '002_amiya', name: '阿米娅', rarity: 5, implementationDate: '2019-04-30T10:00:00', searchPinyin: 'amiya', searchPinyinInitials: 'amy',
    gender: '女', position: '远程位', profession: '术师', subProfession: '中坚术师',
    obtainMethods: ['主线剧情'], races: ['卡特斯', '奇美拉'], birthPlaces: ['雷姆必拓'],
    organizations: ['罗德岛'], teams: [], birthdayMonth: 12,
  },
  {
    operatorId: '4132_ascln', name: '阿斯卡纶', rarity: 6, implementationDate: '2024-10-09T16:00:00', searchPinyin: 'asikalun', searchPinyinInitials: 'askl',
    gender: '女', position: '近战位', profession: '特种', subProfession: '伏击客',
    obtainMethods: ['标准寻访'], races: ['萨卡兹'], birthPlaces: ['卡兹戴尔'],
    organizations: ['罗德岛', 'S.W.E.E.P.'], teams: [], birthdayMonth: 2,
  },
  {
    operatorId: '180_amgoat', name: '艾雅法拉', rarity: 6, implementationDate: '2019-04-30T10:00:00', searchPinyin: 'aiyafala', searchPinyinInitials: 'ayfl',
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
  assert.equal(OperatorFilters.matchesSearch(operators[0], "Ā-MÍ YĀ"), true);
});

test('拼音只接受完整拼音或首字母前缀，禁止中间 substring', () => {
  const cases = [
    { name: '缄默德克萨斯', searchPinyin: 'jianmodekesasi', searchPinyinInitials: 'jmdkss', expected: false },
    { name: '帕拉斯', searchPinyin: 'palasi', searchPinyinInitials: 'pls', expected: false },
    { name: '奥斯塔', searchPinyin: 'aosita', searchPinyinInitials: 'ast', expected: true },
  ];
  for (const item of cases) assert.equal(OperatorFilters.matchesSearch(item, 'as'), item.expected, item.name);
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

test('特殊档案文本按语义归类，不会污染原始 metadata', () => {
  const special = {
    gender: '断罪', obtainMethods: ['记录修复奖励', '无'],
    races: ['未知（疑似黎博利）', '矮人（自称）'],
    birthPlaces: ['因经纪公司要求不公开'],
  };
  assert.deepEqual(OperatorFilters.dimensionValues(special, 'gender'), ['其他']);
  assert.deepEqual(OperatorFilters.dimensionValues(special, 'obtainMethods'), ['活动获得', '其他']);
  assert.deepEqual(OperatorFilters.dimensionValues(special, 'races'), ['未知', '其他']);
  assert.deepEqual(OperatorFilters.dimensionValues(special, 'birthPlaces'), ['未公开/不公开']);
  assert.equal(special.gender, '断罪');
});

test('六种排序只改变顺序，不改变行集合', () => {
  const expected = {
    'implementation-asc': ['阿米娅', '艾雅法拉', '阿斯卡纶'],
    'implementation-desc': ['阿斯卡纶', '阿米娅', '艾雅法拉'],
    'name-asc': ['阿米娅', '阿斯卡纶', '艾雅法拉'],
    'name-desc': ['艾雅法拉', '阿斯卡纶', '阿米娅'],
    'rarity-asc': ['阿米娅', '艾雅法拉', '阿斯卡纶'],
    'rarity-desc': ['艾雅法拉', '阿斯卡纶', '阿米娅'],
  };
  for (const [mode, names] of Object.entries(expected)) {
    const sorted = OperatorFilters.sortRows(rows, mode);
    assert.deepEqual(sorted.map(row => row.definition.name), names, mode);
    assert.deepEqual(new Set(sorted), new Set(rows), `${mode} row set`);
  }
});
