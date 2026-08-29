(function exposeOperatorFilters(root) {
  const DIMENSIONS = [
    'rarity', 'gender', 'position', 'obtainMethods', 'profession', 'subProfession',
    'races', 'birthPlaces', 'organizations', 'teams', 'birthdayMonth',
  ];

  function createState() {
    return {
      search: '',
      moreExpanded: false,
      selected: Object.fromEntries(DIMENSIONS.map(key => [key, new Set()])),
    };
  }

  function normalizeSearch(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s'\-·•_]/g, '');
  }

  function matchesSearch(operator, query) {
    const normalized = normalizeSearch(query);
    if (!normalized) return true;
    return [operator.name, operator.searchPinyin, operator.searchPinyinInitials]
      .some(value => normalizeSearch(value).includes(normalized));
  }

  function dimensionValues(operator, key) {
    if (key === 'rarity') return [String(operator.rarity)];
    if (key === 'birthdayMonth') return operator.birthdayMonth ? [String(operator.birthdayMonth)] : [];
    const value = operator[key];
    if (Array.isArray(value)) return value.map(String);
    return value ? [String(value)] : [];
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

  const exported = { DIMENSIONS, createState, normalizeSearch, matchesSearch, matches, filterRows, hasActive, reset, valuesForRows };
  root.OperatorFilters = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof window === 'undefined' ? globalThis : window);
