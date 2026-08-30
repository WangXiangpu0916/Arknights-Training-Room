(function exposeOperatorFilters(root) {
  const DIMENSIONS = [
    'rarity', 'gender', 'position', 'obtainMethods', 'profession', 'subProfession',
    'races', 'birthPlaces', 'organizations', 'teams', 'birthdayMonth',
  ];

  const SORT_MODES = [
    'training-desc', 'implementation-asc', 'implementation-desc', 'name-asc', 'name-desc',
    'rarity-asc', 'rarity-desc',
  ];
  const PROFESSION_ORDER = new Map(['近卫', '狙击', '重装', '医疗', '辅助', '术师', '特种', '先锋']
    .map((name, index) => [name, index]));

  const VALUE_ALIASES = {
    obtainMethods: new Map([
      ['记录修复奖励', '活动获得'],
      ['无', '其他'],
    ]),
    races: new Map([
      ['不明', '未知'],
      ['未知（疑似黎博利）', '未知'],
      ['因经纪公司要求不公开', '未公开/不公开'],
      ['矮人（自称）', '其他'],
      ['半身人（自称）', '其他'],
      ['长身人（自称）', '其他'],
    ]),
    birthPlaces: new Map([
      ['不明', '未知'],
      ['因经纪公司要求不公开', '未公开/不公开'],
      ['未公开', '未公开/不公开'],
      ['汐斯塔（独立城邦）', '汐斯塔'],
      ['阿戈尔地区', '伊比利亚'],
      ['东国', '东'],
      ['东方大陆（自称）', '其他'],
      ['伊兹甘达（自称）', '其他'],
      ['北方大陆（自称）', '其他'],
    ]),
  };

  function createState() {
    return {
      search: '',
      sort: 'training-desc',
      selected: Object.fromEntries(DIMENSIONS.map(key => [key, new Set()])),
    };
  }

  function normalizeSearch(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  function matchesSearch(operator, query) {
    const normalized = normalizeSearch(query);
    if (!normalized) return true;
    if (normalizeSearch(operator.name).includes(normalized)) return true;
    return normalizeSearch(operator.searchPinyin).startsWith(normalized)
      || normalizeSearch(operator.searchPinyinInitials).startsWith(normalized);
  }

  function normalizeDimensionValue(key, value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return '';
    if (key === 'gender') return normalized === '男' || normalized === '女' ? normalized : '其他';
    return VALUE_ALIASES[key]?.get(normalized) ?? normalized;
  }

  function dimensionValues(operator, key) {
    if (key === 'rarity') return [String(operator.rarity)];
    if (key === 'birthdayMonth') return operator.birthdayMonth ? [String(operator.birthdayMonth)] : [];
    const value = operator[key];
    const rawValues = Array.isArray(value) ? value : value ? [value] : [];
    return [...new Set(rawValues.map(item => normalizeDimensionValue(key, item)).filter(Boolean))];
  }

  function matches(operator, state) {
    if (!matchesSearch(operator, state.search)) return false;
    return DIMENSIONS.every(key => {
      const selected = state.selected[key];
      if (!selected?.size) return true;
      return dimensionValues(operator, key).some(value => selected.has(value));
    });
  }

  function filterRows(rows, state) {
    return rows.filter(row => matches(row.definition, state));
  }

  function compareImplementation(a, b, direction = 1) {
    const aDate = Date.parse(a.definition.implementationDate ?? '');
    const bDate = Date.parse(b.definition.implementationDate ?? '');
    const aMissing = Number.isNaN(aDate);
    const bMissing = Number.isNaN(bDate);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    return aMissing ? 0 : (aDate - bDate) * direction;
  }

  function compareIdentity(a, b) {
    return a.definition.name.localeCompare(b.definition.name, 'zh-CN')
      || a.definition.operatorId.localeCompare(b.definition.operatorId);
  }

  function compareTraining(a, b) {
    return (b.owned.elitePhase ?? 0) - (a.owned.elitePhase ?? 0)
      || (b.owned.level ?? 0) - (a.owned.level ?? 0)
      || (PROFESSION_ORDER.get(a.definition.profession) ?? 99) - (PROFESSION_ORDER.get(b.definition.profession) ?? 99)
      || String(a.definition.searchPinyin ?? '').localeCompare(String(b.definition.searchPinyin ?? ''), 'en')
      || compareIdentity(a, b);
  }

  function sortRows(rows, mode) {
    const selectedMode = SORT_MODES.includes(mode) ? mode : SORT_MODES[0];
    return [...rows].sort((a, b) => {
      if (selectedMode === 'training-desc') return compareTraining(a, b);
      if (selectedMode === 'implementation-asc') return compareImplementation(a, b) || compareIdentity(a, b);
      if (selectedMode === 'implementation-desc') return compareImplementation(a, b, -1) || compareIdentity(a, b);
      if (selectedMode === 'name-asc') return compareIdentity(a, b);
      if (selectedMode === 'name-desc') return compareIdentity(b, a);
      if (selectedMode === 'rarity-asc') return a.definition.rarity - b.definition.rarity
        || compareImplementation(a, b) || compareIdentity(a, b);
      return b.definition.rarity - a.definition.rarity
        || compareImplementation(a, b) || compareIdentity(a, b);
    });
  }

  function hasActive(state) {
    return Boolean(state.search || DIMENSIONS.some(key => state.selected[key]?.size));
  }

  function reset(state) {
    state.search = '';
    for (const key of DIMENSIONS) state.selected[key].clear();
  }

  function valuesForRows(rows, key) {
    return [...new Set(rows.flatMap(row => dimensionValues(row.definition, key)))]
      .sort((a, b) => key === 'rarity' || key === 'birthdayMonth'
        ? Number(a) - Number(b)
        : a.localeCompare(b, 'zh-CN'));
  }

  const exported = {
    DIMENSIONS, SORT_MODES, createState, normalizeSearch, matchesSearch,
    normalizeDimensionValue, dimensionValues, matches, filterRows, sortRows,
    hasActive, reset, valuesForRows,
  };
  root.OperatorFilters = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window === 'undefined' ? globalThis : window);
