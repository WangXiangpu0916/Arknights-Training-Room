import assert from 'node:assert/strict';
import test from 'node:test';

const OperatorFilters = require('../renderer/operator-filter.js') as {
  createState: () => any;
  matchesSearch: (operator: any, query: string) => boolean;
  filterRows: (rows: any[], state: any) => any[];
  sortRows: (rows: any[], mode: string) => any[];
  SORT_MODES: string[];
  nextSort: (mode: string, property: string) => string;
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
const training = [{ elitePhase: 1, level: 70 }, { elitePhase: 2, level: 90 }, { elitePhase: 2, level: 90 }];
const rows = operators.map((definition, index) => ({ definition, owned: { operatorId: definition.operatorId, ...training[index] } }));

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

test('保留默认培养倒序及全部原有排序依据，培养升序反转完整规则', () => {
  assert.equal(OperatorFilters.createState().sort, 'training-desc');
  const expected = {
    'training-desc': ['艾雅法拉', '阿斯卡纶', '阿米娅'],
    'training-asc': ['阿米娅', '阿斯卡纶', '艾雅法拉'],
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

test('全部排序属性重复点击交替方向，切换属性一律从升序开始', () => {
  const properties = [...new Set(OperatorFilters.SORT_MODES.map(mode => mode.split('-')[0]))];
  assert.equal(properties.length, 6);
  for (const property of properties) {
    for (const previous of OperatorFilters.SORT_MODES) {
      let mode = OperatorFilters.nextSort(previous, property);
      assert.equal(mode, `${property}-${previous === `${property}-asc` ? 'desc' : 'asc'}`);
      for (let i = 0; i < 4; i += 1) {
        const next = OperatorFilters.nextSort(mode, property);
        assert.notEqual(next, mode);
        assert.ok(OperatorFilters.SORT_MODES.includes(next));
        mode = next;
      }
    }
  }
});

function sortRow(id: string, owned: Record<string, unknown>) {
  return { definition: { ...operators[0], operatorId: id, name: `干员${id}` }, owned: { operatorId: id, ...owned } };
}
const ids = (rows: any[]) => rows.map(row => row.definition.operatorId);

test('获取时间仅使用实际秒级记录，同秒按 ID 稳定排序，缺失或非法记录双向置后', () => {
  const known = [sortRow('z', { gainTime: 1600000000 }), sortRow('a', { gainTime: 1700000000 }), sortRow('b', { gainTime: 1700000000 })];
  const missing = [undefined, null, 0, -1, NaN, Infinity, '1700000000', 1.5].map((gainTime, i) => sortRow(`missing${i}`, { gainTime }));
  const input = [...missing, ...known].reverse();
  const before = structuredClone(input);
  for (const [mode, expected] of [
    ['acquisition-asc', ['z', 'a', 'b', ...ids(missing)]],
    ['acquisition-desc', ['a', 'b', 'z', ...ids(missing)]],
  ] as const) {
    assert.deepEqual(ids(OperatorFilters.sortRows(input, mode)), expected);
    assert.deepEqual(ids(OperatorFilters.sortRows([...input].reverse(), mode)), expected);
  }
  assert.deepEqual(input, before);
});

function skillRow(id: string, rank: number, levels: number[]) {
  return sortRow(id, { skillLevel: rank, skills: levels.map((masteryLevel, i) => ({ skillId: `skill${i}`, masteryLevel })) });
}

test('技能等级依次比较 Rank、专精总和、降序分布及 ID，倒序完整反转', () => {
  const expected = [
    skillRow('rank1', 1, []), skillRow('rank6', 6, [3, 3, 3]),
    skillRow('zero', 7, [0, 0, 0]), skillRow('sum2', 7, [2, 0, 0]),
    skillRow('spread', 7, [1, 1, 1]), skillRow('mixed', 7, [2, 1, 0]),
    skillRow('concentrated-a', 7, [3, 0, 0]), skillRow('concentrated-b', 7, [0, 3, 0]),
    skillRow('sum4', 7, [3, 1, 0]),
    skillRow('sum7-third-low', 7, [3, 2, 1, 1]), skillRow('sum7-third-high', 7, [3, 2, 2, 0]),
    skillRow('sum7-second-high', 7, [3, 3, 1, 0]), skillRow('sum9', 7, [3, 3, 3]),
  ];
  const input = [...expected.slice(4), ...expected.slice(0, 4)].reverse();
  const before = structuredClone(input);
  assert.deepEqual(ids(OperatorFilters.sortRows(input, 'skill-asc')), ids(expected));
  assert.deepEqual(ids(OperatorFilters.sortRows(input, 'skill-desc')), ids(expected).reverse());
  assert.deepEqual(input, before);
});

test('技能缺失按 Rank 1/未专精处理，不同技能数量补零比较，不修改原始技能顺序', () => {
  const expected = [sortRow('a', {}), skillRow('b', 1, [0]), skillRow('c', 1, [0, 0, 0]),
    skillRow('d', NaN, [NaN, -1, 4]), skillRow('e', 7, [3]), skillRow('f', 7, [0, 3, 0, 0, 0])];
  assert.deepEqual(ids(OperatorFilters.sortRows([...expected].reverse(), 'skill-asc')), ids(expected));
  assert.deepEqual(ids(OperatorFilters.sortRows(expected, 'skill-desc')), ids(expected).reverse());
  assert.deepEqual(OperatorFilters.sortRows([], 'skill-asc'), []);
});

test('所有排序与搜索、多维筛选组合后保持结果集合与账号数据不变', () => {
  const state = OperatorFilters.createState();
  state.search = 'a';
  state.selected.rarity.add('6');
  const before = structuredClone(rows);
  const filtered = OperatorFilters.filterRows(rows, state);
  for (const mode of OperatorFilters.SORT_MODES) {
    const sorted = OperatorFilters.sortRows(filtered, mode);
    assert.deepEqual(new Set(ids(sorted)), new Set(['4132_ascln', '180_amgoat']));
    assert.deepEqual(OperatorFilters.sortRows([...filtered].reverse(), mode), sorted, mode);
  }
  assert.deepEqual(rows, before);
});
