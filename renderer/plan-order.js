// Keep the existing Chromium Intl collation for names; the native core computes plans.
(function (root) {
  function presentPlans(state) {
    const operator = (a, b) => b.operator.rarity - a.operator.rarity || a.operator.name.localeCompare(b.operator.name, 'zh-CN');
    for (const key of ['single', 'singleReal']) state[key].sort((a,b) => ({2:0,1:1,0:2}[a.from]-{2:0,1:1,0:2}[b.from]) || operator(a,b) || a.skill.index-b.skill.index);
    for (const key of ['continuous', 'continuousReal']) state[key].sort((a,b) => ['0-3','1-3','0-2'].indexOf(`${a.from}-${a.to}`)-['0-3','1-3','0-2'].indexOf(`${b.from}-${b.to}`) || operator(a,b) || a.skill.index-b.skill.index);
    for (const key of ['single','continuous','singleReal','continuousReal']) {
      state.promotions[key].sort((a,b) => b.to-a.to || operator(a,b));
      state.modules[key].sort((a,b) => b.from-a.from || operator(a,b) || a.module.name.localeCompare(b.module.name,'zh-CN'));
    }
    return state;
  }
  if (typeof module === 'object' && module.exports) module.exports = presentPlans;
  else root.presentPlans = presentPlans;
})(globalThis);
