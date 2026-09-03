const api = window.trainingRoom;
const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
let state;
let updateState;
let page = 'dashboard';
let mode = 'single';
let dashboardFilters = { search: '', profession: '', rarity: '', mastery: '', unlimited: 'real' };
const plannerFilters = {
  promotion: { search: '', profession: '', rarity: '', level: '', continuous: false, unlimited: 'real' },
  module: { search: '', profession: '', rarity: '', level: '', continuous: false, unlimited: 'real' },
};
let inventorySearch = '';
let inventorySelectedId = null;
let inventoryDetailRequest = 0;
let statisticsScope = 'all';
let cacheNoticeTimer = null;
let activeCacheNoticeKey = '';
let dismissedCacheNoticeKey = '';
const operatorFilters = OperatorFilters.createState();
let operatorSearchComposing = false;

const professions = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const commonOperatorFilterGroups = [
  ['profession', '职业'],
  ['subProfession', '职业分支'],
  ['rarity', '稀有度', value => `${value}★`, true],
  ['position', '位置'],
  ['gender', '性别'],
  ['obtainMethods', '获得方式'],
];
const moreOperatorFilterGroups = [
  ['organizations', '势力 / 组织'],
  ['birthPlaces', '出身地'],
  ['races', '种族'],
  ['teams', '团队'],
  ['birthdayMonth', '生日月份', value => `${value} 月`],
];
const operatorSortModes = [
  ['training-desc', '培养状态'],
  ['implementation-asc', '实装顺序'],
  ['implementation-desc', '实装倒序'],
  ['name-asc', '名称升序'],
  ['name-desc', '名称降序'],
  ['rarity-asc', '稀有度升序'],
  ['rarity-desc', '稀有度降序'],
];
const inventorySectionLabels = {
  materials: '常规材料',
  chips: '职业芯片',
  skills: '技巧概要',
};
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未';
const avatar = id => `../../resources/images/avatar/${encodeURIComponent(id)}.png`;
const itemIcon = id => `../../resources/images/item/${encodeURIComponent(id)}.png`;
const skillIcon = id => `../../resources/images/skill/${encodeURIComponent(id)}.png`;
const masteryIcon = level => `../../resources/images/mastery/m${level}.png`;
const masteryBadge = level => `../../resources/images/mastery/${encodeURIComponent(`专精_${level}_角标.png`)}`;
const eliteIcon = level => `../../resources/images/elite/e${Number(level)}.png`;
const professionIcon = name => `../../resources/images/profession-hd/${encodeURIComponent(name)}.png`;
const moduleTypeIcon = typeIcon => `../../resources/images/module/type/${encodeURIComponent(String(typeIcon).toLowerCase())}.png`;
const moduleStageIcons = Object.freeze({
  1: '../../resources/images/module/stage/1.png',
  2: '../../resources/images/module/stage/2.png',
  3: '../../resources/images/module/stage/3.png',
});
const moduleTypeCode = typeIcon => String(typeIcon || '').toUpperCase();
const operatorLevelBadge = (level, elitePhase) => {
  const value = Math.max(1, Math.min(90, Number(level) || 1));
  const phase = Math.max(0, Math.min(2, Number(elitePhase) || 0));
  return `<span class="operator-level-badge digits-${String(value).length}" role="img" aria-label="当前精英 ${phase}，等级 ${value}"><span class="operator-current-elite"><img src="${eliteIcon(phase)}" alt="" aria-hidden="true"></span><strong><small>Lv.</small>${value}</strong></span>`;
};
const moduleStage = (level, compact = false) => Number(level) === 0
  ? `<span class="module-uninstalled${compact ? ' compact' : ''}">未装配</span>`
  : `<span class="module-stage-icon${compact ? ' compact' : ''}"><img src="${moduleStageIcons[Number(level)]}" alt="模组阶段 ${Number(level)}"></span>`;
const moduleStageTransition = (from, to, compact = false) => `<div class="module-stage-transition${compact ? ' compact' : ''}" aria-label="模组从${Number(from) === 0 ? '未装配' : `阶段 ${Number(from)}`}升级到阶段 ${Number(to)}">${moduleStage(from, compact)}<span class="stage-arrow">→</span>${moduleStage(to, compact)}</div>`;
const skillPlaceholder = '../../resources/images/skill/placeholder.svg';
const materialMap = () => new Map(state.gameData.materials.map(x => [x.itemId, x]));
const showToast = message => {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3200);
};

async function loadState() {
  [state, updateState] = await Promise.all([api.getState(), api.getUpdateState()]);
  render();
}

function setBusy(button, busy, text = '处理中…') {
  if (!button) return;
  if (busy) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.label || button.textContent;
}

function render() {
  document.documentElement.dataset.theme = state?.settings?.theme || 'system';
  updateChrome();
  renderDataNotice();
  if (page === 'dashboard') renderDashboard();
  if (page === 'promotion') renderPromotionPlanner();
  if (page === 'modules') renderModulePlanner();
  if (page === 'statistics') renderStatistics();
  if (page === 'operators') renderOperators();
  if (page === 'inventory') renderInventory();
  if (page === 'settings') renderSettings();
}

function updateChrome() {
  const titles = {
    dashboard: ['当前可以专精', '基于真实仓库与加工站配方的确定性计算'],
    promotion: ['精英化规划', '当前干员状态与真实仓库可满足的晋升'],
    modules: ['模组规划', '已持有干员的模组开启与升级材料就绪情况'],
    statistics: ['统计', '当前账号相对于已实装游戏内容的持有与培养完成度'],
    operators: ['干员', '已持有干员的培养与专精状态'],
    inventory: ['仓库', '真实库存、无限供应状态与加工关系'],
    settings: ['设置', '账号、游戏数据与本地缓存'],
  };
  document.querySelector('#page-title').textContent = titles[page][0];
  document.querySelector('#page-subtitle').textContent = titles[page][1];
  document.querySelectorAll('.nav').forEach(x => x.classList.toggle('active', x.dataset.page === page));
  const badge = document.querySelector('#sync-badge');
  badge.textContent = state.account ? `最后同步 ${fmtTime(state.account.syncedAt)}` : '尚未同步账号';
  badge.className = 'sync-status';
  document.querySelector('#sidebar-status').innerHTML = state.account
    ? `<strong>${esc(state.account.nickname || `UID ${state.account.uid}`)}</strong>${state.usingCache ? '当前使用缓存数据<br>' : ''}${esc(fmtTime(state.gameData.updatedAt))}`
    : `<strong>尚未连接账号</strong>${esc(fmtTime(state.gameData.updatedAt))}`;
  document.querySelector('#refresh-button').disabled = !state.loggedIn;
}

function renderPromotionPlanner() {
  if (!state.account) return renderDashboard();
  const list = currentPlanCandidates('promotion');
  content.innerHTML = `${banners()}${plannerControls('promotion')}
    <div class="result-summary">找到 ${list.length} 个当前可精英化干员</div>
    ${list.length ? `<div class="cards planner-cards">${list.map(promotionCard).join('')}</div>` : '<div class="empty"><div><h2>当前筛选下没有可执行的精英化</h2><p>经验、龙门币、材料或精英阶段条件尚未满足。</p></div></div>'}`;
  bindActions();
}

function promotionCard(candidate) {
  return `<article class="candidate plan-card promotion-plan-card rarity-${candidate.operator.rarity}" data-plan-kind="promotion" data-plan-key="${esc(candidate.operator.operatorId)}" role="button" tabindex="0">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details"><div class="candidate-heading"><div class="candidate-identity"><h3>${esc(candidate.operator.name)}</h3><span class="identity-separator">|</span><span>${esc(candidate.operator.profession)}</span><span class="identity-separator">|</span><span>${esc(candidate.operator.subProfession)}</span></div></div>
        <div class="candidate-visuals"><div class="promotion-card-progress"><div class="elite-transition elite-card-transition"><img src="${eliteIcon(candidate.from)}" alt="精英 ${candidate.from}"><span>→</span><img src="${eliteIcon(candidate.to)}" alt="精英 ${candidate.to}"></div></div>${operatorLevelBadge(candidate.currentLevel, candidate.from)}</div></div>
    </div>
  </article>`;
}

function renderModulePlanner() {
  if (!state.account) return renderDashboard();
  const list = currentPlanCandidates('module');
  content.innerHTML = `${banners()}${plannerControls('module')}<div class="result-summary">找到 ${list.length} 个当前可开启或升级模组</div>
    ${list.length ? `<div class="cards planner-cards module-planner-cards">${list.map(moduleCard).join('')}</div>` : '<div class="empty"><div><h2>当前筛选下没有可规划的模组</h2><p>无模组、等级门槛不足、材料不足或所有模组均已 3 级。</p></div></div>'}`;
  bindActions();
}

function moduleCard(candidate) {
  return `<article class="candidate plan-card module-plan-card rarity-${candidate.operator.rarity}" data-plan-kind="module" data-plan-key="${esc(candidate.operator.operatorId)}:${esc(candidate.module.moduleId)}" role="button" tabindex="0">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details"><div class="candidate-heading"><div class="candidate-identity"><h3>${esc(candidate.operator.name)}</h3><span class="identity-separator">|</span><span>${esc(candidate.operator.profession)}</span><span class="identity-separator">|</span><span>${esc(candidate.operator.subProfession)}</span></div></div>
        <div class="candidate-visuals">${moduleStageTransition(candidate.from, candidate.to)}
          <div class="plan-target module-target"><span class="module-type-icon"><img src="${moduleTypeIcon(candidate.module.typeIcon)}" alt="${esc(moduleTypeCode(candidate.module.typeIcon))} 模组类型图标" loading="lazy" decoding="async" data-img-fallback></span><strong class="module-type-code">${esc(moduleTypeCode(candidate.module.typeIcon))}</strong><div class="module-name" title="${esc(candidate.module.name)}"><small>${esc(candidate.module.name)}</small></div></div></div></div>
    </div>
  </article>`;
}

function plannerControls(kind) {
  const filters = plannerFilters[kind];
  const currentLabel = kind === 'promotion' ? '全部当前精英阶段' : '全部当前模组等级';
  const levels = kind === 'promotion' ? [[0, '精英 0'], [1, '精英 1']] : [[0, '未装配'], [1, '阶段 1'], [2, '阶段 2']];
  return `<div class="dashboard-layout planner-layout"><div class="filters dashboard-filters planner-filters">
    <input data-planner-filter="search" data-planner-kind="${kind}" value="${esc(filters.search)}" placeholder="${kind === 'promotion' ? '搜索干员' : '搜索干员或模组'}">
    ${plannerSelect(kind, 'profession', '全部职业', professions.map(name => [name, name]))}
    ${plannerSelect(kind, 'rarity', '全部星级', [[6, '六星'], [5, '五星'], [4, '四星'], [3, '三星']])}
    ${plannerSelect(kind, 'level', currentLabel, levels)}
  </div><div class="dashboard-mode-row">
    <label class="dashboard-mode-toggle"><span>连续规划模式</span><span class="switch"><input type="checkbox" data-planner-toggle="continuous" data-planner-kind="${kind}" ${filters.continuous ? 'checked' : ''}><span></span></span></label>
    <label class="dashboard-mode-toggle"><span>使用无限池材料</span><span class="switch"><input type="checkbox" data-planner-toggle="unlimited" data-planner-kind="${kind}" ${filters.unlimited === 'with' ? 'checked' : ''}><span></span></span></label>
  </div></div>`;
}

function plannerSelect(kind, name, placeholder, options) {
  return `<select data-planner-filter="${name}" data-planner-kind="${kind}"><option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${esc(value)}" ${String(plannerFilters[kind][name]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function currentPlanCandidates(kind) {
  const filters = plannerFilters[kind];
  const source = state[kind === 'promotion' ? 'promotions' : 'modules'];
  const key = `${filters.continuous ? 'continuous' : 'single'}${filters.unlimited === 'real' ? 'Real' : ''}`;
  return (source?.[key] || []).filter(candidate => {
    const searchable = kind === 'promotion' ? candidate.operator.name : `${candidate.operator.name}${candidate.module.name}${candidate.module.typeLabel}${candidate.module.typeIcon}${moduleTypeCode(candidate.module.typeIcon)}`;
    return (!filters.search || searchable.includes(filters.search))
      && (!filters.profession || candidate.operator.profession === filters.profession)
      && (!filters.rarity || String(candidate.operator.rarity) === filters.rarity)
      && (!filters.level || String(candidate.from) === filters.level);
  });
}

function banners() {
  const reauthenticate = state.lastError?.includes('重新认证') ? ' <button class="link-button" data-action="login">立即重新认证</button>' : '';
  return state.lastError ? `<div class="error-banner">上次刷新失败：${esc(state.lastError)}。已保留旧数据。${reauthenticate}</div>` : '';
}

function clearCacheNoticeTimer() {
  if (cacheNoticeTimer !== null) clearTimeout(cacheNoticeTimer);
  cacheNoticeTimer = null;
}

function dismissCacheNotice(key) {
  if (key !== activeCacheNoticeKey) return;
  dismissedCacheNoticeKey = key;
  clearCacheNoticeTimer();
  const region = document.querySelector('#data-notice-region');
  region.classList.remove('show');
  region.replaceChildren();
}

function renderDataNotice() {
  const region = document.querySelector('#data-notice-region');
  const key = state?.usingCache && state.account ? `cache:${state.account.syncedAt}` : '';
  if (!key || dismissedCacheNoticeKey === key) {
    clearCacheNoticeTimer();
    activeCacheNoticeKey = key;
    region.classList.remove('show');
    region.replaceChildren();
    return;
  }
  if (activeCacheNoticeKey === key && region.firstElementChild) return;
  clearCacheNoticeTimer();
  activeCacheNoticeKey = key;
  region.innerHTML = `<div class="data-notice cache-notice" role="status"><span>当前使用缓存数据 · 最后同步：${esc(fmtTime(state.account.syncedAt))}</span><button type="button" aria-label="关闭缓存数据提示" data-close-cache-notice>×</button></div>`;
  region.classList.add('show');
  region.querySelector('[data-close-cache-notice]').addEventListener('click', () => dismissCacheNotice(key), { once: true });
  cacheNoticeTimer = setTimeout(() => dismissCacheNotice(key), 5000);
}

function percentage(statistic) {
  return statistic.total ? Math.round(statistic.completed / statistic.total * 100) : 0;
}

function statisticLine(label, statistic, kind) {
  const rate = percentage(statistic);
  return `<div class="stat-line ${kind}"><span class="stat-label">${esc(label)}</span><progress class="stat-progress" max="${Math.max(1, statistic.total)}" value="${statistic.completed}" aria-label="${esc(label)}完成率 ${rate}%"></progress><strong class="stat-count">${statistic.completed} <small>/ ${statistic.total}</small></strong><span class="stat-rate">${rate}%</span></div>`;
}

function statisticGroup(label, statistic, rarities) {
  const breakdown = rarities
    .map(rarity => [rarity, statistic.byRarity[rarity]])
    .filter(([, value]) => value?.total)
    .map(([rarity, value]) => statisticLine(`${rarity} 星`, value, 'stat-child'))
    .join('');
  return `<div class="stat-group">
    ${statisticLine(label, statistic, 'stat-total')}
    <div class="stat-breakdown">${breakdown || '<p>当前统计范围内没有有效对象。</p>'}</div>
  </div>`;
}

function renderStatistics() {
  if (!state.account) return renderDashboard();
  const statistics = state.statistics;
  const scoped = statistics.scopes[statisticsScope];
  content.innerHTML = `${banners()}<div class="statistics-page">
    <div class="statistics-toolbar"><span>统计范围</span><div class="segmented statistics-scope" role="group" aria-label="统计范围">
      <button type="button" data-statistics-scope="all" class="${statisticsScope === 'all' ? 'active' : ''}" aria-pressed="${statisticsScope === 'all'}">全部已实装</button>
      <button type="button" data-statistics-scope="owned" class="${statisticsScope === 'owned' ? 'active' : ''}" aria-pressed="${statisticsScope === 'owned'}">仅已持有</button>
    </div></div>
    <section class="statistics-section"><div class="statistics-heading"><h2>干员持有</h2></div><div class="statistics-list">
      ${statisticGroup('总持有进度', statistics.ownership, [6, 5, 4, 3, 2, 1])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>技能专精</h2></div><div class="statistics-list">
      ${statisticGroup('专精三级技能总进度', scoped.mastery, [6, 5, 4])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>模组</h2></div><div class="statistics-list">
      ${statisticGroup('模组解锁总进度', scoped.moduleUnlocked, [6, 5, 4])}
      ${statisticGroup('三级模组总进度', scoped.moduleStage3, [6, 5, 4])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>精英化</h2></div><div class="statistics-list">
      ${statisticGroup('精英阶段1及以上总进度', scoped.elite1, [6, 5, 4, 3])}
      ${statisticGroup('精英阶段2总进度', scoped.elite2, [6, 5, 4])}
    </div></section>
  </div>`;
  bindActions();
}

function renderDashboard() {
  if (!state.account) {
    content.innerHTML = `${banners()}<div class="empty"><div><h2>连接森空岛后开始规划</h2><p>应用会读取仓库、已持有干员和每个技能的当前专精等级。</p><button class="primary" data-action="login">使用森空岛 App 扫码连接</button></div></div>`;
    bindActions();
    return;
  }
  const source = currentMasteryCandidates();
  const list = source.filter(candidate => {
    return (!dashboardFilters.search || `${candidate.operator.name}${candidate.skill.name}`.includes(dashboardFilters.search))
      && (!dashboardFilters.profession || candidate.operator.profession === dashboardFilters.profession)
      && (!dashboardFilters.rarity || String(candidate.operator.rarity) === dashboardFilters.rarity)
      && (!dashboardFilters.mastery || String(candidate.from) === dashboardFilters.mastery);
  });
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const skillSummariesUnlimited = state.skillSummaryItemIds.some(id => unlimited.has(id));
  content.innerHTML = `${banners()}<div class="dashboard-layout">
    <div class="filters dashboard-filters">
      <input data-dashboard-filter="search" value="${esc(dashboardFilters.search)}" placeholder="搜索干员或技能">
      ${select('profession', '全部职业', professions.map(name => [name, name]))}
      ${select('rarity', '全部星级', [[6,'六星'],[5,'五星'],[4,'四星']])}
      ${select('mastery', '全部当前等级', mode === 'continuous' ? [[0,'M0'],[1,'M1']] : [[0,'M0'],[1,'M1'],[2,'M2']])}
    </div>
    <div class="dashboard-mode-row">
      <label class="dashboard-mode-toggle"><span>连续专精模式</span><span class="switch"><input type="checkbox" data-continuous-mode ${mode === 'continuous' ? 'checked' : ''}><span></span></span></label>
      <label class="dashboard-mode-toggle"><span>技巧概要视为无限</span><span class="switch"><input type="checkbox" data-unlimited-summaries ${skillSummariesUnlimited ? 'checked' : ''}><span></span></span></label>
      <label class="dashboard-mode-toggle"><span>使用无限池材料</span><span class="switch"><input type="checkbox" data-unlimited-materials ${dashboardFilters.unlimited === 'with' ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="result-summary">找到 ${list.length} 个当前可行候选</div>
    ${list.length ? `<div class="cards">${list.map(candidateCard).join('')}</div>` : `<div class="empty"><div><h2>当前筛选下没有可行专精</h2><p>仓库、专精状态或无限供应设置变化后会自动重新计算。</p></div></div>`}</div>`;
  bindActions();
}

function currentMasteryCandidates() {
  if (dashboardFilters.unlimited === 'real') return mode === 'single' ? state.singleReal : state.continuousReal;
  return mode === 'single' ? state.single : state.continuous;
}

function select(name, placeholder, options) {
  return `<select data-dashboard-filter="${name}"><option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${esc(value)}" ${String(dashboardFilters[name]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function candidateCard(candidate, index) {
  return `<article class="candidate rarity-${candidate.operator.rarity}" data-candidate="${mode}:${index}" data-key="${esc(candidate.operator.operatorId)}:${esc(candidate.skill.skillId)}" role="button" tabindex="0" aria-label="查看${esc(candidate.operator.name)}的${esc(candidate.skill.name)}专精材料">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details">
        <div class="candidate-heading"><div class="candidate-identity"><h3>${esc(candidate.operator.name)}</h3><span class="identity-separator">|</span><span>${esc(candidate.operator.profession)}</span><span class="identity-separator">|</span><span>${esc(candidate.operator.subProfession)}</span></div></div>
        <div class="candidate-visuals">
          <div class="mastery-line" aria-label="M${candidate.from} 到 M${candidate.to}">
            <img class="mastery-icon" src="${masteryIcon(candidate.from)}" alt="M${candidate.from}">
            <span class="arrow" aria-hidden="true">→</span>
            <img class="mastery-icon" src="${masteryIcon(candidate.to)}" alt="M${candidate.to}">
          </div>
          <div class="skill-info">
            <img class="skill-icon" src="${skillIcon(candidate.skill.skillId)}" alt="${esc(candidate.skill.name)}技能图标" data-img-fallback="skill">
            <div class="skill-copy" title="${esc(candidate.skill.name)}"><strong>${esc(candidate.skill.name)}</strong></div>
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

function renderOperators() {
  if (!state.account) return renderDashboard();
  const rows = ownedOperatorRows();
  content.innerHTML = `${banners()}<section class="operator-filter-section" aria-label="干员搜索和筛选">
    <input class="operator-search" data-operator-search value="${esc(operatorFilters.search)}" placeholder="搜索已持有干员" autocomplete="off" spellcheck="false">
    ${operatorFilterRegion('common', '筛选', commonOperatorFilterGroups, rows)}
    ${operatorFilterRegion('more', '更多筛选', moreOperatorFilterGroups, rows)}
    <div class="operator-sort-row" role="group" aria-label="排序方式">
      <span class="operator-sort-label">排序方式</span>
      ${operatorSortModes.map(([value, label]) => `<button type="button" class="operator-sort-option ${operatorFilters.sort === value ? 'active' : ''}" data-operator-sort="${value}" aria-pressed="${operatorFilters.sort === value}">${label}</button>`).join('')}
      <button class="operator-reset" type="button" data-operator-reset ${OperatorFilters.hasActive(operatorFilters) ? '' : 'disabled'}>清除全部筛选</button>
    </div>
  </section>
  <div class="operator-result-summary result-summary" data-operator-result-summary aria-live="polite"></div>
  <div class="operator-list" data-operator-list></div>`;
  updateOperatorResults(rows);
  bindOperatorActions(rows);
  bindActions();
}

function ownedOperatorRows() {
  const defs = new Map(state.gameData.operators.map(operator => [operator.operatorId, operator]));
  return state.account.operators
    .map(owned => ({ owned, definition: defs.get(owned.operatorId) }))
    .filter(row => row.definition);
}

function operatorFilterRegion(id, label, groups, rows) {
  return `<section class="operator-filter-region" data-operator-filter-region="${id}">
    <button class="operator-filter-trigger" type="button" data-operator-panel-trigger aria-expanded="false">${label}<span data-operator-region-count="${id}"></span><span aria-hidden="true">▾</span></button>
    <div class="operator-filter-panel" data-operator-filter-panel hidden>
      ${groups.map(([key, groupLabel, format = value => value, descending = false]) => operatorFilterGroup(key, groupLabel, rows, format, descending)).join('')}
    </div>
  </section>`;
}

function operatorFilterGroup(key, label, rows, format = value => value, descending = false) {
  const selected = operatorFilters.selected[key];
  const values = OperatorFilters.valuesForRows(rows, key);
  if (descending) values.reverse();
  return `<div class="operator-filter-group" data-operator-filter-group="${key}" role="group" aria-label="${esc(label)}">
    <div class="operator-filter-group-heading"><strong>${esc(label)}</strong><span data-operator-filter-count="${key}"></span></div>
    <div class="operator-filter-options">
      <button type="button" class="operator-filter-action" data-operator-filter-action="all" data-filter-key="${key}">全选</button>
      <button type="button" class="operator-filter-action" data-operator-filter-action="clear" data-filter-key="${key}">清除</button>
      ${values.length ? values.map(value => `<button type="button" class="operator-filter-option ${selected.has(value) ? 'active' : ''}" data-operator-filter-option data-filter-key="${key}" value="${esc(value)}" aria-pressed="${selected.has(value)}">${esc(format(value))}</button>`).join('') : '<span class="operator-filter-empty">暂无资料</span>'}
    </div>
  </div>`;
}

function updateOperatorResults(allRows = ownedOperatorRows()) {
  const filteredRows = OperatorFilters.filterRows(allRows, operatorFilters);
  const rows = OperatorFilters.sortRows(filteredRows, operatorFilters.sort);
  const summary = content.querySelector('[data-operator-result-summary]');
  const list = content.querySelector('[data-operator-list]');
  if (!summary || !list) return;
  summary.textContent = `已持有总数 ${allRows.length} · 当前显示 ${rows.length}`;
  list.innerHTML = rows.length ? operatorRowsHtml(rows) : '<div class="empty"><div><h2>当前搜索和筛选下没有干员</h2><p>调整条件或清除筛选后再试。</p></div></div>';
  bindImageFallbacks(list);
}

function operatorRowsHtml(rows) {
  const available = new Map(currentMasteryCandidates().map(candidate => [
    `${candidate.operator.operatorId}\u0000${candidate.skill.skillId}`,
    candidate,
  ]));
  return rows.map(({ owned, definition }) => `<article class="operator-row rarity-${definition.rarity}">
    <img class="operator-avatar" src="${avatar(definition.operatorId)}" alt="${esc(definition.name)}头像" data-img-fallback>
    <div class="operator-info">
      <div class="operator-identity"><h3>${esc(definition.name)}</h3><span>${esc(definition.profession)} <i>|</i> ${esc(definition.subProfession)}</span></div>
      <div class="operator-status"><span class="rarity-badge rarity-${definition.rarity}">${definition.rarity}★</span><span><img src="${eliteIcon(owned.elitePhase)}" alt="">精英 ${owned.elitePhase} · Lv.${owned.level}</span><span class="rank-badge">Rank ${owned.skillLevel}</span></div>
      <div class="operator-tags">${[definition.position, ...(definition.tags || [])].filter(Boolean).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
    </div>
    <div class="operator-skills ${definition.skills.length > 3 ? 'many-skills' : ''}" aria-label="${esc(definition.name)}技能专精状态">${[...definition.skills].sort((a, b) => a.index - b.index).map(skill => {
      const ownedSkill = owned.skills.find(item => item.skillId === skill.skillId);
      const candidate = available.get(`${definition.operatorId}\u0000${skill.skillId}`);
      const masteryLevel = ownedSkill?.masteryLevel ?? 0;
      const status = candidate ? `当前可升级到 M${candidate.to}` : masteryLevel === 3 ? '已完成专精' : '当前不可升级';
      return `<div class="operator-skill ${candidate ? 'can-upgrade' : ''}" data-operator-skill="${esc(`${definition.operatorId}:${skill.skillId}`)}" title="${esc(`第${skill.index}技能 · ${skill.name} · M${masteryLevel} · ${status}`)}" aria-label="${esc(`${skill.name}，当前 M${masteryLevel}，${status}`)}">
        <img class="operator-skill-icon" src="${skillIcon(skill.skillId)}" alt="${esc(skill.name)}技能图标" data-img-fallback="skill">
        <span class="mastery-badge" aria-hidden="true"><img class="operator-skill-mastery" src="${masteryBadge(masteryLevel)}" alt=""></span>
      </div>`;
    }).join('')}</div>
    <div class="operator-watermark" aria-hidden="true"><img src="${professionIcon(definition.profession)}" alt=""></div>
  </article>`).join('');
}

function bindOperatorActions(rows) {
  const search = content.querySelector('[data-operator-search]');
  search.addEventListener('compositionstart', () => { operatorSearchComposing = true; });
  search.addEventListener('compositionend', event => {
    operatorSearchComposing = false;
    operatorFilters.search = event.target.value;
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  });
  search.addEventListener('input', event => {
    operatorFilters.search = event.target.value;
    if (operatorSearchComposing || event.isComposing) return;
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  });
  content.querySelectorAll('[data-operator-filter-option]').forEach(button => button.addEventListener('click', event => {
    const selected = operatorFilters.selected[event.currentTarget.dataset.filterKey];
    selected.has(event.currentTarget.value) ? selected.delete(event.currentTarget.value) : selected.add(event.currentTarget.value);
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  }));
  content.querySelectorAll('[data-operator-filter-action]').forEach(button => button.addEventListener('click', event => {
    const key = event.currentTarget.dataset.filterKey;
    const selected = operatorFilters.selected[key];
    selected.clear();
    if (event.currentTarget.dataset.operatorFilterAction === 'all') {
      content.querySelectorAll(`[data-operator-filter-option][data-filter-key="${key}"]`).forEach(option => selected.add(option.value));
    }
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  }));
  content.querySelectorAll('[data-operator-sort]').forEach(button => button.addEventListener('click', event => {
    operatorFilters.sort = event.currentTarget.dataset.operatorSort;
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  }));
  bindOperatorFilterPanels();
  content.querySelector('[data-operator-reset]').addEventListener('click', () => {
    OperatorFilters.reset(operatorFilters);
    search.value = '';
    updateOperatorResults(rows);
    updateOperatorFilterControls();
    search.focus();
  });
}

function bindOperatorFilterPanels() {
  content.querySelectorAll('[data-operator-filter-region]').forEach(region => {
    const panel = region.querySelector('[data-operator-filter-panel]');
    const trigger = region.querySelector('[data-operator-panel-trigger]');
    const setOpen = open => {
      region.classList.toggle('open', open);
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
    };
    trigger.addEventListener('click', () => setOpen(!region.classList.contains('open')));
  });
}

function updateOperatorFilterControls() {
  for (const key of OperatorFilters.DIMENSIONS) {
    const count = operatorFilters.selected[key].size;
    const counter = content.querySelector(`[data-operator-filter-count="${key}"]`);
    const group = content.querySelector(`[data-operator-filter-group="${key}"]`);
    group?.classList.toggle('has-value', Boolean(count));
    if (counter) counter.textContent = count ? `已选 ${count}` : '';
    content.querySelectorAll(`[data-operator-filter-option][data-filter-key="${key}"]`).forEach(button => {
      const active = operatorFilters.selected[key].has(button.value);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  for (const [id, groups] of [['common', commonOperatorFilterGroups], ['more', moreOperatorFilterGroups]]) {
    const count = groups.reduce((sum, [key]) => sum + operatorFilters.selected[key].size, 0);
    const counter = content.querySelector(`[data-operator-region-count="${id}"]`);
    if (counter) counter.textContent = count ? ` · 已选 ${count}` : '';
  }
  const active = OperatorFilters.hasActive(operatorFilters);
  const reset = content.querySelector('[data-operator-reset]');
  if (reset) reset.disabled = !active;
  content.querySelectorAll('[data-operator-sort]').forEach(button => {
    const selected = button.dataset.operatorSort === operatorFilters.sort;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function inventorySections(query = inventorySearch) {
  return InventoryCatalog.buildSections(state.gameData.materials, query);
}

function inventoryVisibleIds(sections) {
  return new Set(['materials', 'chips', 'skills'].flatMap(key => sections[key].map(item => item.itemId)));
}

function firstInventoryItemId(sections) {
  for (const key of ['materials', 'chips', 'skills']) {
    if (sections[key].length) return sections[key][0].itemId;
  }
  return null;
}

function syncInventorySelection(sections) {
  const visible = inventoryVisibleIds(sections);
  if (!inventorySelectedId || !visible.has(inventorySelectedId)) inventorySelectedId = firstInventoryItemId(sections);
}

function formatInventoryQty(quantity) {
  const value = Number(quantity) || 0;
  return value >= 10000 ? `${Math.round(value / 1000) / 10}万` : String(value);
}

function renderInventoryIconCell(item, selectedId) {
  const quantity = state.account.inventory[item.itemId] ?? 0;
  const selected = item.itemId === selectedId;
  return `<button type="button" class="inventory-icon-cell${selected ? ' selected' : ''}" data-inventory-item="${esc(item.itemId)}" title="${esc(item.name)}" aria-pressed="${selected}">
    <span class="inventory-icon-frame">
      <img class="inventory-icon-image" src="${itemIcon(item.itemId)}" alt="" data-img-fallback>
      <span class="inventory-icon-qty">${formatInventoryQty(quantity)}</span>
    </span>
  </button>`;
}

function splitMaterialRows(rows) {
  const pinnedSet = new Set(InventoryCatalog.pinnedMaterialIds);
  const pinned = [];
  const rest = [];
  for (const item of rows) {
    if (pinnedSet.has(item.itemId)) pinned.push(item);
    else rest.push(item);
  }
  return { pinned, rest };
}

function renderMaterialsSectionHtml(rows, selectedId) {
  const { pinned, rest } = splitMaterialRows(rows);
  const pinnedHtml = pinned.length
    ? `<div class="inventory-icon-grid inventory-icon-grid-pinned">${pinned.map(item => renderInventoryIconCell(item, selectedId)).join('')}</div>`
    : '';
  const restHtml = rest.length
    ? `<div class="inventory-icon-grid">${rest.map(item => renderInventoryIconCell(item, selectedId)).join('')}</div>`
    : '';
  return `<div class="inventory-material-grids">${pinnedHtml}${restHtml}</div>`;
}

function renderInventoryListHtml(sections, selectedId) {
  return ['materials', 'chips', 'skills'].flatMap(key => {
    const rows = sections[key];
    if (!rows.length) return [];
    const gridHtml = key === 'materials'
      ? renderMaterialsSectionHtml(rows, selectedId)
      : `<div class="inventory-icon-grid" data-inventory-section="${key}">${rows.map(item => renderInventoryIconCell(item, selectedId)).join('')}</div>`;
    return [`<section class="inventory-section">
      <h3 class="inventory-section-title">${inventorySectionLabels[key]}</h3>
      ${gridHtml}
    </section>`];
  }).join('');
}

function renderInventoryDetailEmpty() {
  return `<div class="inventory-detail-empty">
    <p class="inventory-detail-empty-title">选择材料</p>
    <p class="operator-meta">点击左侧图标查看材料详情、无限供应设置与合成配方。</p>
  </div>`;
}

function renderInventoryDetailLoading(itemId) {
  const item = materialMap().get(itemId);
  if (!item) return renderInventoryDetailEmpty();
  const quantity = state.account.inventory[itemId] ?? 0;
  return `<div class="inventory-detail-body">
    <div class="inventory-detail-header">
      <span class="inventory-detail-icon"><img src="${itemIcon(itemId)}" alt="" data-img-fallback></span>
      <h2 class="inventory-detail-name">${esc(item.name)}</h2>
    </div>
    <dl class="inventory-detail-meta">
      <div class="inventory-detail-row"><dt>当前数量</dt><dd>${quantity}</dd></div>
    </dl>
    <p class="operator-meta inventory-detail-loading">正在加载配方…</p>
  </div>`;
}

function renderRecipeVisual(material, inventory) {
  if (!material.recipe?.ingredients.length) return '<p class="operator-meta">暂无合成配方</p>';
  const materials = materialMap();
  const ingredientCount = material.recipe.ingredients.length;
  const ingredients = material.recipe.ingredients.map(ingredient => {
    const owned = inventory[ingredient.itemId] ?? 0;
    const insufficient = owned < ingredient.quantity;
    const source = materials.get(ingredient.itemId);
    return `<div class="recipe-ingredient${insufficient ? ' insufficient' : ''}">
      <div class="recipe-ingredient-icon">
        <img src="${itemIcon(ingredient.itemId)}" alt="" data-img-fallback>
      </div>
      <span class="recipe-ingredient-count">${owned} / ${ingredient.quantity}</span>
      <span class="recipe-ingredient-name">${esc(source?.name || ingredient.itemId)}</span>
    </div>`;
  }).join('');
  return `<div class="recipe-visual"><div class="recipe-ingredients" data-count="${ingredientCount}">${ingredients}</div></div>`;
}

function renderInventoryDetailContent(itemId, detail) {
  const unlimitedEligible = new Set(state.unlimitedEligibleItemIds);
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const quantity = state.account.inventory[itemId] ?? 0;
  const unlimitedHtml = unlimitedEligible.has(itemId)
    ? `<div class="inventory-detail-block">
      <div class="inventory-detail-row inventory-detail-unlimited-row">
        <span>无限供应</span>
        <label class="switch"><input type="checkbox" data-inventory-unlimited="${esc(itemId)}" ${unlimited.has(itemId) ? 'checked' : ''}><span></span></label>
      </div>
      <p class="inventory-detail-hint">开启后，规划计算中将该材料视为无限可用。</p>
    </div>`
    : '';
  return `<div class="inventory-detail-body">
    <div class="inventory-detail-header">
      <span class="inventory-detail-icon"><img src="${itemIcon(itemId)}" alt="" data-img-fallback></span>
      <h2 class="inventory-detail-name">${esc(detail.material.name)}</h2>
      ${Number(detail.craftable) > 0 ? `<span class="craftable-badge">可合成 × ${detail.craftable}</span>` : ''}
    </div>
    <dl class="inventory-detail-meta">
      <div class="inventory-detail-row"><dt>当前数量</dt><dd>${quantity}</dd></div>
    </dl>
    ${unlimitedHtml}
    <section class="inventory-detail-block">
      <h3 class="inventory-detail-subtitle">合成配方</h3>
      ${renderRecipeVisual(detail.material, state.account.inventory)}
    </section>
    <section class="inventory-detail-block inventory-copy-block">
      <h3 class="inventory-detail-subtitle">用途</h3>
      <p>${esc(detail.material.purpose || '暂无资料')}</p>
    </section>
    <section class="inventory-detail-block inventory-copy-block">
      <h3 class="inventory-detail-subtitle">描述</h3>
      <p>${esc(detail.material.description || '暂无资料')}</p>
    </section>
  </div>`;
}

function renderInventory() {
  if (!state.account) return renderDashboard();
  const query = inventorySearch;
  const sections = inventorySections(query);
  syncInventorySelection(sections);
  content.innerHTML = `${banners()}<div class="inventory-layout">
    <div class="inventory-main">
      <div class="inventory-toolbar">
        <input data-inventory-search value="${esc(query)}" placeholder="搜索材料">
      </div>
      <div class="inventory-page" data-inventory-list>
        ${renderInventoryListHtml(sections, inventorySelectedId)}
      </div>
    </div>
    <aside class="inventory-detail" data-inventory-detail aria-label="材料详情">
      ${inventorySelectedId ? renderInventoryDetailLoading(inventorySelectedId) : renderInventoryDetailEmpty()}
    </aside>
  </div>`;
  bindActions();
  if (inventorySelectedId) loadInventoryDetail(inventorySelectedId);
}

async function loadInventoryDetail(itemId) {
  const panel = document.querySelector('[data-inventory-detail]');
  if (!panel || inventorySelectedId !== itemId) return;
  panel.innerHTML = renderInventoryDetailLoading(itemId);
  bindImageFallbacks(panel);
  const requestId = ++inventoryDetailRequest;
  try {
    const detail = await api.materialDetail(itemId);
    if (requestId !== inventoryDetailRequest || inventorySelectedId !== itemId) return;
    panel.innerHTML = renderInventoryDetailContent(itemId, detail);
    bindInventoryDetailActions(panel);
    bindImageFallbacks(panel);
  } catch (error) {
    if (requestId !== inventoryDetailRequest || inventorySelectedId !== itemId) return;
    panel.innerHTML = `${renderInventoryDetailLoading(itemId)}<p class="error-banner" style="margin-top:12px">${esc(error.message || String(error))}</p>`;
    bindImageFallbacks(panel);
  }
}

function selectInventoryItem(itemId) {
  if (inventorySelectedId === itemId) return;
  inventorySelectedId = itemId;
  document.querySelectorAll('[data-inventory-item]').forEach(button => {
    const selected = button.dataset.inventoryItem === itemId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  loadInventoryDetail(itemId);
}

function renderSettings() {
  const updateActions = {
    idle: '<button class="secondary" data-action="check-update">检查更新</button>',
    unsupported: '<button class="secondary" disabled>安装版可用</button>',
    checking: '<button class="secondary" disabled>检查中…</button>',
    current: '<button class="secondary" data-action="check-update">再次检查</button>',
    available: `<button class="primary" data-action="download-update">下载 v${esc(updateState.availableVersion)}</button>`,
    downloading: `<button class="secondary" disabled>下载中 ${Math.round(updateState.progress || 0)}%</button>`,
    ready: '<button class="primary" data-action="install-update">重启并更新</button>',
    installing: '<button class="secondary" disabled>正在安装…</button>',
    error: '<button class="secondary" data-action="check-update">重新检查</button>',
  };
  content.innerHTML = `${banners()}<div class="settings-list">
    <section class="setting-row"><div><h3>森空岛账号</h3><p>${state.loggedIn ? `已连接${state.account ? ` · UID ${esc(state.account.uid)}` : ''}` : '未连接。凭据使用 Windows DPAPI 加密保存。'}</p></div><div>${state.loggedIn ? '<button class="secondary" data-action="login">重新认证</button> <button class="danger" data-action="logout">退出 / 删除认证</button>' : '<button class="primary" data-action="login">扫码连接</button>'}</div></section>
    <section class="setting-row"><div><h3>游戏数据</h3><p>最后更新：${esc(fmtTime(state.gameData.updatedAt))}<br>版本：${esc(state.gameData.version)}</p></div><button class="secondary" data-action="update-game">检查并更新</button></section>
    <section class="setting-row"><div><h3>主题</h3><p>跟随系统会使用 Electron 原生系统主题状态并实时响应切换。</p></div><div class="radio-stack theme-options"><label><input type="radio" name="theme" value="system" ${state.settings.theme === 'system' ? 'checked' : ''}> 跟随系统</label><label><input type="radio" name="theme" value="dark" ${state.settings.theme === 'dark' ? 'checked' : ''}> 深蓝色</label><label><input type="radio" name="theme" value="black" ${state.settings.theme === 'black' ? 'checked' : ''}> 黑色</label><label><input type="radio" name="theme" value="light" ${state.settings.theme === 'light' ? 'checked' : ''}> 浅色</label></div></section>
    <section class="setting-row"><div><h3>启动时自动刷新</h3><p>先显示缓存结果，再在后台同步森空岛。</p></div><label class="switch"><input type="checkbox" data-auto-refresh ${state.settings.autoRefresh ? 'checked' : ''}><span></span></label></section>
    <section class="setting-row update-row"><div><h3>应用更新</h3><p>当前版本 v${esc(updateState.currentVersion)}<br><span class="update-message ${updateState.phase === 'error' ? 'error' : ''}">${esc(updateState.message)}</span></p>${updateState.phase === 'downloading' ? `<div class="update-progress"><span style="width:${Math.max(0, Math.min(100, updateState.progress || 0))}%"></span></div>` : ''}</div><div>${updateActions[updateState.phase] || updateActions.idle}</div></section>
    <section class="setting-row"><div><h3>缓存</h3><p>清除最近一次账号快照；不会删除登录凭据或内置游戏数据。</p></div><button class="danger" data-action="clear-cache">清理账号缓存</button></section>
  </div>`;
  bindActions();
}

function bindActions() {
  document.querySelectorAll('[data-statistics-scope]').forEach(button => button.addEventListener('click', event => {
    statisticsScope = event.currentTarget.dataset.statisticsScope;
    renderStatistics();
  }));
  document.querySelectorAll('[data-planner-filter]').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', event => {
    const kind = event.target.dataset.plannerKind;
    plannerFilters[kind][event.target.dataset.plannerFilter] = event.target.value;
    kind === 'promotion' ? renderPromotionPlanner() : renderModulePlanner();
  }));
  document.querySelectorAll('[data-planner-toggle]').forEach(input => input.addEventListener('change', event => {
    const kind = event.target.dataset.plannerKind;
    const key = event.target.dataset.plannerToggle;
    plannerFilters[kind][key] = key === 'continuous' ? event.target.checked : event.target.checked ? 'with' : 'real';
    kind === 'promotion' ? renderPromotionPlanner() : renderModulePlanner();
  }));
  document.querySelector('[data-continuous-mode]')?.addEventListener('change', event => {
    mode = event.target.checked ? 'continuous' : 'single';
    if (mode === 'continuous' && dashboardFilters.mastery === '2') dashboardFilters.mastery = '';
    renderDashboard();
  });
  document.querySelector('[data-unlimited-materials]')?.addEventListener('change', event => {
    dashboardFilters.unlimited = event.target.checked ? 'with' : 'real';
    renderDashboard();
  });
  document.querySelectorAll('[data-dashboard-filter]').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', event => {
    dashboardFilters[event.target.dataset.dashboardFilter] = event.target.value;
    renderDashboard();
  }));
  document.querySelector('[data-inventory-search]')?.addEventListener('input', event => {
    inventorySearch = event.target.value;
    const sections = inventorySections();
    syncInventorySelection(sections);
    const list = content.querySelector('[data-inventory-list]');
    const panel = content.querySelector('[data-inventory-detail]');
    if (!list || !panel) return;
    list.innerHTML = renderInventoryListHtml(sections, inventorySelectedId);
    bindInventoryGridActions(list);
    bindImageFallbacks(list);
    if (inventorySelectedId) loadInventoryDetail(inventorySelectedId);
    else panel.innerHTML = renderInventoryDetailEmpty();
  });
  const openCandidate = card => {
    const [candidateMode] = card.dataset.candidate.split(':');
    const [operatorId, skillId] = card.dataset.key.split(':');
    const candidate = state[candidateMode].find(x => x.operator.operatorId === operatorId && x.skill.skillId === skillId);
    if (candidate) showCandidate(candidate);
  };
  document.querySelectorAll('[data-candidate]').forEach(card => {
    card.addEventListener('click', () => openCandidate(card));
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openCandidate(card);
    });
  });
  const openPlan = card => {
    const key = card.dataset.planKey;
    const candidate = card.dataset.planKind === 'promotion'
      ? currentPlanCandidates('promotion').find(item => item.operator.operatorId === key)
      : currentPlanCandidates('module').find(item => `${item.operator.operatorId}:${item.module.moduleId}` === key);
    if (candidate) showPlanCandidate(candidate, card.dataset.planKind);
  };
  document.querySelectorAll('[data-plan-kind]').forEach(card => {
    card.addEventListener('click', () => openPlan(card));
    card.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openPlan(card);
    });
  });
  bindInventoryGridActions();
  bindInventoryDetailActions();
  document.querySelector('[data-unlimited-summaries]')?.addEventListener('change', async event => {
    const ids = new Set(state.settings.unlimitedItemIds);
    for (const id of state.skillSummaryItemIds) event.target.checked ? ids.add(id) : ids.delete(id);
    state = await api.updateSettings({ unlimitedItemIds: [...ids] });
    render();
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
  document.querySelectorAll('input[name="theme"]').forEach(input => input.addEventListener('change', async () => { state = await api.updateSettings({ theme: input.value }); render(); }));
  document.querySelector('[data-auto-refresh]')?.addEventListener('change', async event => { state = await api.updateSettings({ autoRefresh: event.target.checked }); render(); });
  bindImageFallbacks();
}

function bindInventoryGridActions(root = document) {
  root.querySelectorAll('[data-inventory-item]:not([data-inventory-bound])').forEach(button => {
    button.dataset.inventoryBound = 'true';
    button.addEventListener('click', () => selectInventoryItem(button.dataset.inventoryItem));
  });
}

function bindInventoryDetailActions(root = document) {
  root.querySelectorAll('[data-inventory-unlimited]:not([data-inventory-unlimited-bound])').forEach(input => {
    input.dataset.inventoryUnlimitedBound = 'true';
    input.addEventListener('change', async () => {
      const ids = new Set(state.settings.unlimitedItemIds);
      input.checked ? ids.add(input.dataset.inventoryUnlimited) : ids.delete(input.dataset.inventoryUnlimited);
      state = await api.updateSettings({ unlimitedItemIds: [...ids] });
      if (page === 'inventory' && inventorySelectedId) loadInventoryDetail(inventorySelectedId);
      else render();
    });
  });
}

function bindImageFallbacks(root = document) {
  root.querySelectorAll('[data-img-fallback]:not([data-fallback-bound])').forEach(img => {
    img.dataset.fallbackBound = 'true';
    img.addEventListener('error', () => {
    if (img.dataset.imgFallback === 'skill') {
      img.src = skillPlaceholder;
      img.classList.add('missing');
      return;
    }
    img.style.visibility = 'hidden';
    }, { once: true });
  });
}

async function handleAction(action, button) {
  try {
    setBusy(button, true);
    if (action === 'login') await beginLogin();
    if (action === 'logout') state = await api.logout();
    if (action === 'update-game') { state = await api.updateGameData(); showToast('游戏数据已更新'); }
    if (action === 'check-update') updateState = await api.checkForUpdates();
    if (action === 'download-update') updateState = await api.downloadUpdate();
    if (action === 'install-update') updateState = await api.installUpdate();
    if (action === 'clear-cache' && confirm('确定清除账号缓存？登录凭据和无限材料设置会保留。')) state = await api.clearCache();
    render();
  } catch (error) {
    showToast(error.message || String(error));
  } finally {
    setBusy(button, false);
  }
}

async function beginLogin() {
  const qr = await api.startQrLogin();
  showModal(`<div class="qr-wrap"><h2>使用森空岛 App 扫码</h2><img src="${qr.qrCode}" alt="森空岛登录二维码"><p>二维码有效期约 2 分钟。扫码确认后应用会自动继续。</p><span class="badge warn">正在等待扫码确认…</span></div>`);
  const bindings = await api.finishQrLogin(qr.scanId);
  if (!bindings.length) throw new Error('登录成功，但没有找到绑定的明日方舟角色');
  const selected = bindings.find(x => x.isDefault) || bindings[0];
  modalContent.innerHTML = `<h2>选择游戏角色</h2><p>已安全保存认证信息。请选择要同步的角色。</p><select id="binding-select">${bindings.map(x => `<option value="${esc(x.uid)}" ${x.uid === selected.uid ? 'selected' : ''}>${esc(x.nickName || x.uid)} · ${esc(x.channelName || '')}</option>`).join('')}</select><p style="margin-top:16px"><button class="primary" id="binding-confirm">同步并进入首页</button></p>`;
  await new Promise(resolve => document.querySelector('#binding-confirm').addEventListener('click', resolve, { once: true }));
  const uid = document.querySelector('#binding-select').value;
  modal.classList.add('hidden');
  state = await api.refreshAccount(uid);
  page = 'dashboard';
  showToast('账号数据同步完成');
}

function showCandidate(candidate) {
  const materials = materialMap();
  const totals = new Map();
  candidate.stages.forEach(stage => stage.requirements.forEach(x => totals.set(x.itemId, (totals.get(x.itemId) || 0) + x.quantity)));
  showModal(`<h2>${esc(candidate.operator.name)} · S${candidate.skill.index} ${esc(candidate.skill.name)}</h2>
    <p>当前 M${candidate.from} → 可达到 M${candidate.to} ${candidate.usesUnlimited ? `<span class="badge blue">依赖无限：${candidate.unlimitedRoots.map(id => esc(materials.get(id)?.name || id)).join('、')}</span>` : '<span class="badge ok">仅真实仓库</span>'}</p>
    ${candidate.stages.map(stage => `<section class="stage-block"><h3>M${stage.from} → M${stage.to}</h3>${stage.requirements.map(requirement => {
      const step = stage.craft.steps.find(x => x.itemId === requirement.itemId);
      return `<div class="material-line"><span>${esc(materials.get(requirement.itemId)?.name || requirement.itemId)} ×${requirement.quantity}</span><span>实际 ${state.account.inventory[requirement.itemId] ?? 0}</span><span class="${step?.batches ? 'infinity' : 'success'}">${step?.unlimitedRoots.length ? '∞ 供应' : step?.batches ? `加工 ${step.batches} 次` : '满足'}</span></div>${step ? craftTree(step, materials) : ''}`;
    }).join('')}</section>`).join('')}
    ${candidate.stages.length > 1 ? `<section class="stage-block"><h3>连续专精总材料</h3>${[...totals].map(([id, quantity]) => `<div class="material-line"><span>${esc(materials.get(id)?.name || id)}</span><strong>×${quantity}</strong><span></span></div>`).join('')}</section>` : ''}`);
}

function showPlanCandidate(candidate, kind) {
  const materials = materialMap();
  const title = kind === 'promotion'
    ? `${candidate.operator.name} · 精英 ${candidate.from} → 精英 ${candidate.to}`
    : `${candidate.operator.name} · ${candidate.module.name} · ${candidate.module.typeLabel}`;
  const transition = kind === 'promotion'
    ? `<div class="elite-transition modal-transition"><img src="${eliteIcon(candidate.from)}" alt="精英 ${candidate.from}"><span>→</span><img src="${eliteIcon(candidate.to)}" alt="精英 ${candidate.to}"></div>`
    : `<div class="module-modal-heading"><div class="module-modal-type"><span class="module-type-icon"><img src="${moduleTypeIcon(candidate.module.typeIcon)}" alt="${esc(moduleTypeCode(candidate.module.typeIcon))} 模组类型图标"></span><strong>${esc(moduleTypeCode(candidate.module.typeIcon))}</strong><small>${esc(candidate.module.name)}</small></div>${moduleStageTransition(candidate.from, candidate.to)}</div>`;
  const stages = candidate.stages.map(stage => `<section class="stage-block"><h3${kind === 'module' ? ' class="module-stage-heading"' : ''}>${kind === 'promotion' ? `精英 ${stage.from} → 精英 ${stage.to}` : moduleStageTransition(stage.from, stage.to, true)}</h3>
    ${kind === 'promotion' && stage.experienceRequired ? `<div class="material-line"><span>干员经验</span><strong>${stage.experienceRequired.toLocaleString('zh-CN')}</strong><span>库存折算 ${candidate.experienceAvailable.toLocaleString('zh-CN')}</span></div>` : ''}
    ${stage.requirements.map(requirement => {
      const step = stage.craft.steps.find(item => item.itemId === requirement.itemId);
      return `<div class="material-line"><span>${esc(materials.get(requirement.itemId)?.name || requirement.itemId)} ×${requirement.quantity}</span><span>实际 ${state.account.inventory[requirement.itemId] ?? 0}</span><span class="${step?.unlimitedRoots.length || step?.batches ? 'infinity' : 'success'}">${step?.unlimitedRoots.length ? '∞ 供应' : step?.batches ? `加工 ${step.batches} 次` : '满足'}</span></div>${step ? craftTree(step, materials) : ''}`;
    }).join('')}</section>`).join('');
  const totals = candidate.stages.length > 1 ? `<section class="stage-block"><h3>连续规划总计</h3>${kind === 'promotion' && candidate.experienceRequired ? `<div class="material-line"><span>干员经验</span><strong>${candidate.experienceRequired.toLocaleString('zh-CN')}</strong><span></span></div>` : ''}${candidate.requirements.map(requirement => `<div class="material-line"><span>${esc(materials.get(requirement.itemId)?.name || requirement.itemId)}</span><strong>×${requirement.quantity}</strong><span></span></div>`).join('')}</section>` : '';
  showModal(`<h2>${esc(title)}</h2>${transition}${candidate.usesUnlimited ? `<p><span class="badge blue">依赖无限：${candidate.unlimitedRoots.map(id => esc(materials.get(id)?.name || id)).join('、')}</span></p>` : ''}${stages}${totals}${kind === 'module' && candidate.from === 0 ? '<p class="planner-note">材料与等级门槛已满足；首次开启前仍需在游戏内完成该模组任务。</p>' : ''}`);
}

function craftTree(step, materials) {
  if (!step.batches && !step.unlimitedRoots.length) return '';
  if (step.unlimitedRoots.length && !step.batches) return `<div class="craft-tree">${esc(materials.get(step.itemId)?.name || step.itemId)} 由无限供应链满足</div>`;
  return `<div class="craft-tree">加工 ${esc(materials.get(step.itemId)?.name || step.itemId)}：${step.batches} 次，产出 ${step.crafted}${step.children.map(child => `<div>${esc(materials.get(child.itemId)?.name || child.itemId)} ×${child.requested}${craftTree(child, materials)}</div>`).join('')}</div>`;
}

function showModal(html) { modalContent.innerHTML = html; modal.classList.remove('hidden'); }

document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => {
  page = button.dataset.page;
  document.querySelector('main').scrollTop = 0;
  render();
}));
document.querySelector('#refresh-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  try { setBusy(button, true, '同步中…'); state = await api.refreshAccount(); showToast('账号数据已刷新'); render(); }
  catch (error) { showToast(error.message || String(error)); state = await api.getState(); render(); }
  finally { setBusy(button, false); }
});
document.querySelectorAll('[data-close-modal]').forEach(x => x.addEventListener('click', () => modal.classList.add('hidden')));
api.onStateChanged(loadState);
api.onUpdateStateChanged(next => { updateState = next; if (page === 'settings') renderSettings(); });
window.addEventListener('beforeunload', clearCacheNoticeTimer);
loadState().catch(error => { content.innerHTML = `<div class="error-banner">应用初始化失败：${esc(error.message || error)}</div>`; });
