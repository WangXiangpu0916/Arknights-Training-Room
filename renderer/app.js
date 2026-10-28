const api = window.trainingRoom;
const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
let state;
let updateState;
let resourceUpdateState;
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
const operatorFilters = OperatorFilters.createState();
let operatorSearchComposing = false;
let stateLoadPromise = null;
let stateLoadQueued = false;
let toastTimer = null;
let cachedMaterialMap = null;
let cachedOperatorDefinitions = null;
let cachedOperatorRows = null;
let cachedMasterySource = null;
let cachedMasteryAvailable = null;
let modalTrigger = null;
let refreshResourceModal = null;
let loginAttempt = 0;
let cancelLogin = null;
let settingsSaving = false;
let accountRefreshing = false;
let skillPopover = null;
let skillPopoverFrame = null;

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
// [property, label, ascending label, descending label]
const operatorSortModes = [
  ['training', '培养状态', '从低到高', '从高到低'],
  ['implementation', '实装时间', '从早到晚', '从晚到早'],
  ['name', '名称', 'A → Z', 'Z → A'],
  ['rarity', '稀有度', '从低到高', '从高到低'],
  ['acquisition', '获取时间', '从早到晚', '从晚到早'],
  ['skill', '技能等级', '从低到高', '从高到低'],
];
const chevronIcon = className => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>`;
const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const inventorySectionLabels = {
  materials: '常规材料',
  chips: '职业芯片',
  skills: '技巧概要',
};
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未';
const resourceImage = name => `${state.resourceAssetBase}${name}`;
const avatar = id => resourceImage(`avatar/${encodeURIComponent(id)}.png`);
const itemIcon = id => resourceImage(`item/${encodeURIComponent(id)}.png`);
const skillIcon = id => resourceImage(`skill/${encodeURIComponent(id)}.png`);
const masteryIcon = level => resourceImage(`mastery/m${level}.png`);
const masteryName = level => ['未专精', '专精一级', '专精二级', '专精三级'][level];
const masteryBadge = level => resourceImage(`mastery/${encodeURIComponent(`专精_${level}_角标.png`)}`);
const eliteIcon = level => resourceImage(`elite/e${Number(level)}.png`);
const professionIcon = name => resourceImage(`profession-hd/${encodeURIComponent(name)}.png`);
const moduleTypeIcon = typeIcon => resourceImage(`module/type/${encodeURIComponent(String(typeIcon).toLowerCase())}.png`);
const moduleTypeCode = typeIcon => String(typeIcon || '').toUpperCase();
const operatorLevelBadge = (level, elitePhase) => {
  const value = Math.max(1, Math.min(90, Number(level) || 1));
  const phase = Math.max(0, Math.min(2, Number(elitePhase) || 0));
  return `<span class="operator-level-badge digits-${String(value).length}" role="img" aria-label="当前精英 ${phase}，等级 ${value}"><span class="operator-current-elite"><img src="${eliteIcon(phase)}" alt="" aria-hidden="true"></span><strong><small>Lv.</small>${value}</strong></span>`;
};
const moduleStage = (level, compact = false) => Number(level) === 0
  ? `<span class="module-uninstalled${compact ? ' compact' : ''}">未装配</span>`
  : `<span class="module-stage-icon${compact ? ' compact' : ''}"><img src="${resourceImage(`module/stage/${Number(level)}.png`)}" alt="模组阶段 ${Number(level)}"></span>`;
const moduleStageTransition = (from, to, compact = false) => `<div class="module-stage-transition${compact ? ' compact' : ''}" aria-label="模组从${Number(from) === 0 ? '未装配' : `阶段 ${Number(from)}`}升级到阶段 ${Number(to)}">${moduleStage(from, compact)}<span class="stage-arrow">→</span>${moduleStage(to, compact)}</div>`;
const skillPlaceholder = () => resourceImage('skill/placeholder.svg');
const materialMap = () => cachedMaterialMap ??= new Map(state.gameData.materials.map(x => [x.itemId, x]));
const operatorDefinitions = () => cachedOperatorDefinitions ??= new Map(state.gameData.operators.map(x => [x.operatorId, x]));
const compactNumber = value => {
  const number = Number(value) || 0;
  return number >= 10000 ? `${Math.round(number / 1000) / 10}万` : String(number);
};
// Planner searches share the operator page matcher (name, full pinyin, initials) and also accept page-specific text.
function matchesPlannerSearch(operator, query, extraTexts = [], extraPrefixes = []) {
  if (!query) return true;
  if (OperatorFilters.matchesSearch(operatorDefinitions().get(operator.operatorId) || operator, query)) return true;
  const normalized = OperatorFilters.normalizeSearch(query);
  if (!normalized) return false;
  return extraTexts.some(text => OperatorFilters.normalizeSearch(text).includes(normalized))
    || extraPrefixes.some(text => OperatorFilters.normalizeSearch(text).startsWith(normalized));
}
const setState = next => {
  if (state && next.revision < state.revision) return;
  closeSkillPopover();
  const resourcesChanged = state && state.gameData.version !== next.gameData.version;
  if (resourcesChanged) inventoryDetailRequest++;
  state = next;
  resourceUpdateState = next.resourceUpdate;
  cachedMaterialMap = null;
  cachedOperatorDefinitions = null;
  cachedOperatorRows = null;
  cachedMasterySource = null;
  cachedMasteryAvailable = null;
  if (resourcesChanged || modal.open) refreshResourceModal?.();
  if (next.revision >= 0) void api.cacheState(next);
};
const showToast = (message, kind = 'success') => {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toastTimer = null;
  }, kind === 'error' ? 7000 : 3200);
};

async function loadState() {
  if (stateLoadPromise) {
    stateLoadQueued = true;
    return stateLoadPromise;
  }
  stateLoadPromise = (async () => {
    do {
      stateLoadQueued = false;
      const [nextState, nextUpdateState] = await Promise.all([api.getState(), api.getUpdateState()]);
      const resourcesChanged = state && state.gameData.version !== nextState.gameData.version;
      const preserveView = resourcesChanged || state?.revision === -1;
      const focused = document.activeElement;
      const focusSelector = preserveView && content.contains(focused)
        ? [...focused.attributes].filter(a => a.name.startsWith('data-') || ['id', 'name', 'type'].includes(a.name) || focused.type === 'radio' && a.name === 'value').map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : '';
      const selection = focused.selectionStart != null ? [focused.selectionStart, focused.selectionEnd] : null;
      const scrollTop = document.querySelector('main').scrollTop;
      setState(nextState);
      updateState = nextUpdateState;
      resourceUpdateState = nextState.resourceUpdate;
      render();
      if (preserveView) {
        const replacement = focusSelector ? content.querySelector(focusSelector) : null;
        replacement?.focus({ preventScroll: true });
        if (selection) replacement?.setSelectionRange?.(...selection);
        document.querySelector('main').scrollTop = scrollTop;
      }
    } while (stateLoadQueued);
  })();
  try {
    await stateLoadPromise;
  } finally {
    stateLoadPromise = null;
  }
}

function setBusy(button, busy, text = '处理中…') {
  if (!button) return;
  if (busy) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? text : button.dataset.label || button.textContent;
}

function render() {
  closeSkillPopover();
  document.documentElement.dataset.theme = state?.settings?.theme || 'system';
  updateChrome();
  if (page === 'dashboard') renderDashboard();
  if (page === 'promotion') renderPromotionPlanner();
  if (page === 'modules') renderModulePlanner();
  if (page === 'statistics') renderStatistics();
  if (page === 'operators') renderOperators();
  if (page === 'inventory') renderInventory();
  if (page === 'settings') renderSettings();
}

function updateChrome() {
  const main = document.querySelector('main');
  main.dataset.page = page;
  document.querySelectorAll('.nav').forEach(x => {
    x.classList.toggle('active', x.dataset.page === page);
    if (x.dataset.page === page) {
      x.setAttribute('aria-current', 'page');
      main.setAttribute('aria-label', x.textContent.trim());
    }
    else x.removeAttribute('aria-current');
  });
  const status = document.querySelector('#sidebar-status');
  status.classList.toggle('offline', !state.account);
  status.innerHTML = state.account
    ? `<strong>${esc(state.account.nickname || `UID ${state.account.uid}`)}</strong><span>${accountRefreshing ? '正在同步…' : `同步于 ${esc(fmtTime(state.account.syncedAt))}`}</span>${state.usingCache && !accountRefreshing ? '<em>缓存数据</em>' : ''}`
    : '<strong>尚未连接账号</strong><span>在设置中扫码连接</span>';
}

function renderPromotionPlanner(resultsOnly = false) {
  if (!state.account) return renderDashboard();
  const list = currentPlanCandidates('promotion');
  renderPlanningResults(`${resultSummary(list.length, '个当前可精英化干员', plannerFilters.promotion)}
    ${list.length ? `<div class="cards planner-cards">${list.map(promotionCard).join('')}</div>` : '<div class="empty"><div><h2>当前筛选下没有可执行的精英化</h2><p>可先清除筛选，再检查经验、龙门币与材料是否充足。</p></div></div>'}`, plannerControls('promotion'), resultsOnly);
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

function renderModulePlanner(resultsOnly = false) {
  if (!state.account) return renderDashboard();
  const list = currentPlanCandidates('module');
  renderPlanningResults(`${resultSummary(list.length, '个当前可开启或升级模组', plannerFilters.module)}
    ${list.length ? `<div class="cards planner-cards module-planner-cards">${list.map(moduleCard).join('')}</div>` : '<div class="empty"><div><h2>当前筛选下没有可规划的模组</h2><p>可先清除筛选，再检查模组等级、干员等级与材料条件。</p></div></div>'}`, plannerControls('module'), resultsOnly);
}

function resultSummary(count, label, filters) {
  const active = ['search', 'profession', 'rarity', 'mastery', 'level'].some(key => filters[key]);
  return `<div class="result-summary"><span role="status">找到 ${count} ${label}</span>${active ? '<button class="link-button" data-reset-planner>清除筛选</button>' : ''}</div>`;
}

function renderPlanningResults(html, controls, resultsOnly) {
  if (resultsOnly) {
    content.querySelector('[data-planning-results]').innerHTML = html;
    bindCandidateActions();
    bindImageFallbacks();
  } else {
    content.innerHTML = `${banners()}${controls}<div data-planning-results>${html}</div>`;
    bindActions();
  }
}

function moduleCard(candidate) {
  return `<article class="candidate plan-card module-plan-card rarity-${candidate.operator.rarity}" data-plan-kind="module" data-plan-key="${esc(candidate.operator.operatorId)}:${esc(candidate.module.moduleId)}" role="button" tabindex="0">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details"><div class="candidate-heading"><div class="candidate-identity"><h3>${esc(candidate.operator.name)}</h3><span class="identity-separator">|</span><span>${esc(candidate.operator.profession)}</span><span class="identity-separator">|</span><span>${esc(candidate.operator.subProfession)}</span></div></div>
        <div class="candidate-visuals">${moduleStageTransition(candidate.from, candidate.to)}
          <div class="plan-target module-target"><span class="module-type-icon"><img src="${moduleTypeIcon(candidate.module.typeIcon)}" alt="${esc(moduleTypeCode(candidate.module.typeIcon))} 模组类型图标" loading="lazy" decoding="async" data-img-fallback></span><div class="module-target-copy" title="${esc(moduleTypeCode(candidate.module.typeIcon))} · ${esc(candidate.module.name)}"><strong class="module-type-code">${esc(moduleTypeCode(candidate.module.typeIcon))}</strong></div></div></div></div>
    </div>
  </article>`;
}

function plannerControls(kind) {
  const filters = plannerFilters[kind];
  const currentLabel = kind === 'promotion' ? '全部当前阶段' : '全部当前等级';
  const levels = kind === 'promotion' ? [[0, '精英 0'], [1, '精英 1']] : [[0, '未装配'], [1, '阶段 1'], [2, '阶段 2']];
  const placeholder = kind === 'promotion' ? '搜索干员，支持拼音首字母' : '搜索干员或模组，支持拼音首字母';
  return `<div class="dashboard-layout planner-layout"><div class="filters dashboard-filters planner-filters">
    <input type="search" class="search-input" aria-label="${placeholder}" data-planner-filter="search" data-planner-kind="${kind}" value="${esc(filters.search)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">
    ${plannerSelect(kind, 'profession', '全部职业', professions.map(name => [name, name]))}
    ${plannerSelect(kind, 'rarity', '全部星级', [[6, '六星'], [5, '五星'], [4, '四星'], [3, '三星']])}
    ${plannerSelect(kind, 'level', currentLabel, levels)}
  </div><div class="dashboard-mode-row">
    <label class="dashboard-mode-toggle"><span>连续规划模式</span><span class="switch"><input type="checkbox" data-planner-toggle="continuous" data-planner-kind="${kind}" ${filters.continuous ? 'checked' : ''}><span></span></span></label>
    <label class="dashboard-mode-toggle"><span>使用无限池材料</span><span class="switch"><input type="checkbox" data-planner-toggle="unlimited" data-planner-kind="${kind}" ${filters.unlimited === 'with' ? 'checked' : ''}><span></span></span></label>
  </div></div>`;
}

function plannerSelect(kind, name, placeholder, options) {
  return `<select aria-label="${placeholder}" data-planner-filter="${name}" data-planner-kind="${kind}"><option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${esc(value)}" ${String(plannerFilters[kind][name]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function currentPlanCandidates(kind) {
  const filters = plannerFilters[kind];
  const source = state[kind === 'promotion' ? 'promotions' : 'modules'];
  const key = `${filters.continuous ? 'continuous' : 'single'}${filters.unlimited === 'real' ? 'Real' : ''}`;
  return (source?.[key] || []).filter(candidate => {
    const extra = kind === 'promotion' ? [] : [candidate.module.name, candidate.module.typeLabel];
    const prefixes = kind === 'promotion' ? [] : [moduleTypeCode(candidate.module.typeIcon)];
    return matchesPlannerSearch(candidate.operator, filters.search, extra, prefixes)
      && (!filters.profession || candidate.operator.profession === filters.profession)
      && (!filters.rarity || String(candidate.operator.rarity) === filters.rarity)
      && (!filters.level || String(candidate.from) === filters.level);
  });
}

function banners() {
  const reauthenticate = state.lastError?.includes('重新认证') ? ' <button class="link-button" data-action="login">立即重新认证</button>' : '';
  return state.lastError ? `<div class="error-banner">上次刷新失败：${esc(state.lastError)}。已保留旧数据。${reauthenticate}</div>` : '';
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
  const tile = (label, statistic) => `<div class="statistics-tile"><span>${esc(label)}</span><strong>${percentage(statistic)}<small>%</small></strong><progress class="stat-progress" max="${Math.max(1, statistic.total)}" value="${statistic.completed}" aria-hidden="true"></progress><em>${statistic.completed} / ${statistic.total}</em></div>`;
  content.innerHTML = `${banners()}<div class="statistics-page">
    <div class="statistics-toolbar"><p>干员持有始终按全部已实装干员计算；统计范围影响精英化、专精与模组。</p><div class="segmented statistics-scope" role="group" aria-label="统计范围">
      <button type="button" data-statistics-scope="all" class="${statisticsScope === 'all' ? 'active' : ''}" aria-pressed="${statisticsScope === 'all'}">全部已实装</button>
      <button type="button" data-statistics-scope="owned" class="${statisticsScope === 'owned' ? 'active' : ''}" aria-pressed="${statisticsScope === 'owned'}">仅已持有</button>
    </div></div>
    <div class="statistics-overview">
      ${tile('干员持有', statistics.ownership)}
      ${tile('精英阶段 2', scoped.elite2)}
      ${tile('专精三级技能', scoped.mastery)}
      ${tile('三级模组', scoped.moduleStage3)}
    </div>
    <section class="statistics-section"><div class="statistics-heading"><h2>干员持有</h2></div><div class="statistics-list">
      ${statisticGroup('总持有进度', statistics.ownership, [6, 5, 4, 3, 2, 1])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>精英化</h2></div><div class="statistics-list">
      ${statisticGroup('精英阶段1及以上总进度', scoped.elite1, [6, 5, 4, 3])}
      ${statisticGroup('精英阶段2总进度', scoped.elite2, [6, 5, 4])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>技能专精</h2></div><div class="statistics-list">
      ${statisticGroup('专精三级技能总进度', scoped.mastery, [6, 5, 4])}
    </div></section>
    <section class="statistics-section"><div class="statistics-heading"><h2>模组</h2></div><div class="statistics-list">
      ${statisticGroup('模组解锁总进度', scoped.moduleUnlocked, [6, 5, 4])}
      ${statisticGroup('三级模组总进度', scoped.moduleStage3, [6, 5, 4])}
    </div></section>
  </div>`;
  bindActions();
}

function renderDashboard(resultsOnly = false) {
  if (!state.account) {
    content.innerHTML = `${banners()}<div class="empty"><div><h2>连接森空岛后开始规划</h2><p>应用会读取仓库、已持有干员和每个技能的当前专精等级。</p><button class="primary" data-action="login">使用森空岛 App 扫码连接</button></div></div>`;
    bindActions();
    return;
  }
  const source = currentMasteryCandidates();
  const list = source.filter(candidate => {
    if (state.training?.operator.operatorId === candidate.operator.operatorId && state.training.skill.skillId === candidate.skill.skillId) return false;
    return matchesPlannerSearch(candidate.operator, dashboardFilters.search, [candidate.skill.name])
      && (!dashboardFilters.profession || candidate.operator.profession === dashboardFilters.profession)
      && (!dashboardFilters.rarity || String(candidate.operator.rarity) === dashboardFilters.rarity)
      && (!dashboardFilters.mastery || String(candidate.from) === dashboardFilters.mastery);
  });
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const skillSummariesUnlimited = state.skillSummaryItemIds.some(id => unlimited.has(id));
  const controls = `<div class="dashboard-layout">
    <div class="filters dashboard-filters">
      <input type="search" class="search-input" aria-label="搜索干员或技能，支持拼音首字母" data-dashboard-filter="search" value="${esc(dashboardFilters.search)}" placeholder="搜索干员或技能，支持拼音首字母" autocomplete="off" spellcheck="false">
      ${select('profession', '全部职业', professions.map(name => [name, name]))}
      ${select('rarity', '全部星级', [[6,'六星'],[5,'五星'],[4,'四星']])}
      ${select('mastery', '全部当前等级', (mode === 'continuous' ? [0, 1] : [0, 1, 2]).map(level => [level, masteryName(level)]))}
    </div>
    <div class="dashboard-mode-row">
      <label class="dashboard-mode-toggle"><span>连续专精模式</span><span class="switch"><input type="checkbox" data-continuous-mode ${mode === 'continuous' ? 'checked' : ''}><span></span></span></label>
      <label class="dashboard-mode-toggle"><span>技巧概要视为无限</span><span class="switch"><input type="checkbox" data-unlimited-summaries ${skillSummariesUnlimited ? 'checked' : ''}><span></span></span></label>
      <label class="dashboard-mode-toggle"><span>使用无限池材料</span><span class="switch"><input type="checkbox" data-unlimited-materials ${dashboardFilters.unlimited === 'with' ? 'checked' : ''}><span></span></span></label>
    </div></div>`;
  renderPlanningResults(`${trainingSection()}${resultSummary(list.length, '个当前可行候选', dashboardFilters)}
    ${list.length ? `<div class="cards">${list.map(candidateCard).join('')}</div>` : `<div class="empty"><div><h2>当前筛选下没有可行专精</h2><p>可先清除筛选，再检查仓库材料和当前专精等级。</p></div></div>`}`, controls, resultsOnly);
}

function trainingSection() {
  const training = state.training;
  if (!training) return '';
  const { operator, skill, from, to } = training;
  const next = trainingCandidate();
  const level = (value, role) => `<span class="training-level ${role}"><img src="${masteryIcon(value)}" alt=""><span><small>${role === 'from' ? '当前' : '目标'}</small><strong>${masteryName(value)}</strong></span></span>`;
  return `<section class="training-strip rarity-${operator.rarity}" aria-label="训练室当前专精任务">
    <div class="training-watermark" aria-hidden="true"><img src="${professionIcon(operator.profession)}" alt=""></div>
    <div class="training-operator">
      <img class="training-avatar" src="${avatar(operator.operatorId)}" alt="${esc(operator.name)}头像" data-img-fallback>
      <div class="training-identity">
        <span class="training-label"><span class="training-pulse" aria-hidden="true"></span>训练室 · 正在专精</span>
        <h3>${esc(operator.name)}</h3>
        <span class="operator-meta"><span class="training-stars" aria-label="${operator.rarity} 星">${'★'.repeat(operator.rarity)}</span>${esc(operator.profession)} · ${esc(operator.subProfession)}</span>
      </div>
    </div>
    <div class="training-task">
      <img class="skill-icon" src="${skillIcon(skill.skillId)}" alt="" data-img-fallback="skill">
      <div class="training-task-copy">
        <div class="training-skill-name">${skill.index ? `<span>第 ${skill.index} 技能</span>` : ''}<strong>${esc(skill.name)}</strong></div>
        <div class="training-progress">${level(from, 'from')}<span class="training-flow" aria-label="训练至"><i></i><i></i><i></i></span>${level(to, 'to')}</div>
      </div>
    </div>
    ${to < 3
      ? `<div class="training-next ${next ? 'ready' : 'pending'}"><span class="training-next-label">训练完成后可规划</span><strong>${masteryName(to)} → ${masteryName(to + 1)}</strong>${next ? '<button class="training-next-action" data-training-plan>查看后续材料<span aria-hidden="true">→</span></button>' : '<small>后续材料尚未满足</small>'}</div>`
      : '<div class="training-final"><span class="training-next-label">训练完成后</span><strong>该技能专精已满</strong></div>'}
  </section>`;
}

function trainingCandidate() {
  const training = state.training;
  if (!training) return;
  const matches = item => item.operator.operatorId === training.operator.operatorId && item.skill.skillId === training.skill.skillId;
  // Keep the next single step available when continuous mode has fewer than two steps left.
  return currentMasteryCandidates().find(matches) || (dashboardFilters.unlimited === 'real' ? state.singleReal : state.single).find(matches);
}

function currentMasteryCandidates() {
  if (dashboardFilters.unlimited === 'real') return mode === 'single' ? state.singleReal : state.continuousReal;
  return mode === 'single' ? state.single : state.continuous;
}

function select(name, placeholder, options) {
  return `<select aria-label="${placeholder}" data-dashboard-filter="${name}"><option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${esc(value)}" ${String(dashboardFilters[name]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function candidateCard(candidate, index) {
  return `<article class="candidate rarity-${candidate.operator.rarity}" data-candidate="${mode}:${index}" data-key="${esc(candidate.operator.operatorId)}:${esc(candidate.skill.skillId)}" role="button" tabindex="0" aria-label="查看${esc(candidate.operator.name)}的${esc(candidate.skill.name)}专精材料">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details">
        <div class="candidate-heading"><div class="candidate-identity"><h3>${esc(candidate.operator.name)}</h3><span class="identity-separator">|</span><span>${esc(candidate.operator.profession)}</span><span class="identity-separator">|</span><span>${esc(candidate.operator.subProfession)}</span></div></div>
        <div class="candidate-visuals">
          <div class="mastery-line" aria-label="${masteryName(candidate.from)} 到 ${masteryName(candidate.to)}">
            <img class="mastery-icon" src="${masteryIcon(candidate.from)}" alt="${masteryName(candidate.from)}">
            <span class="arrow" aria-hidden="true">→</span>
            <img class="mastery-icon" src="${masteryIcon(candidate.to)}" alt="${masteryName(candidate.to)}">
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
    <input type="search" class="operator-search search-input" data-operator-search value="${esc(operatorFilters.search)}" placeholder="搜索已持有干员，支持拼音首字母" autocomplete="off" spellcheck="false">
    ${operatorFilterRegion('common', '筛选', commonOperatorFilterGroups, rows)}
    ${operatorFilterRegion('more', '更多筛选', moreOperatorFilterGroups, rows)}
    <div class="operator-toolbar">
      <div class="operator-result-meta">
        <span class="operator-result-summary" data-operator-result-summary aria-live="polite"></span>
        <button class="link-button operator-reset" type="button" data-operator-reset ${OperatorFilters.hasActive(operatorFilters) ? '' : 'disabled hidden'}>清除全部筛选</button>
      </div>
      <div class="operator-sort" role="group" aria-label="排序方式">
        <span class="operator-sort-label">排序</span>
        <div class="operator-sort-options">${operatorSortModes.map(([value, label]) => `<button type="button" class="operator-sort-option" data-operator-sort="${value}"><span class="operator-sort-name">${label}</span><span class="operator-sort-direction" aria-hidden="true"></span></button>`).join('')}</div>
        <button type="button" class="operator-sort-order" data-operator-sort-order><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg><span data-operator-sort-order-label></span></button>
      </div>
    </div>
  </section>
  <div class="operator-list" data-operator-list></div>`;
  updateOperatorResults(rows);
  updateOperatorFilterControls();
  bindOperatorActions(rows);
  bindActions();
}

function ownedOperatorRows() {
  if (cachedOperatorRows) return cachedOperatorRows;
  const defs = new Map(state.gameData.operators.map(operator => [operator.operatorId, operator]));
  cachedOperatorRows = state.account.operators
    .map(owned => ({ owned, definition: defs.get(owned.operatorId) }))
    .filter(row => row.definition);
  return cachedOperatorRows;
}

function operatorFilterRegion(id, label, groups, rows) {
  return `<section class="operator-filter-region" data-operator-filter-region="${id}">
    <button class="operator-filter-trigger" type="button" data-operator-panel-trigger data-label="${label}" aria-expanded="false"><span>${label}</span><span class="operator-filter-count" data-operator-region-count="${id}"></span>${chevronIcon('operator-filter-chevron')}</button>
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
    <div class="operator-filter-group-heading"><strong>${esc(label)}</strong><span data-operator-filter-count="${key}"></span>
      <span class="operator-filter-group-actions"><button type="button" class="operator-filter-action" data-operator-filter-action="all" data-filter-key="${key}">全选</button><button type="button" class="operator-filter-action" data-operator-filter-action="clear" data-filter-key="${key}">清除</button></span>
    </div>
    <div class="operator-filter-options">
      ${values.length ? values.map(value => `<button type="button" class="operator-filter-option ${selected.has(value) ? 'active' : ''}" data-operator-filter-option data-filter-key="${key}" value="${esc(value)}" aria-pressed="${selected.has(value)}">${esc(format(value))}</button>`).join('') : '<span class="operator-filter-empty">暂无资料</span>'}
    </div>
  </div>`;
}

function updateOperatorResults(allRows = ownedOperatorRows()) {
  closeSkillPopover();
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
  const source = currentMasteryCandidates();
  if (source !== cachedMasterySource) {
    cachedMasterySource = source;
    cachedMasteryAvailable = new Map(source.map(candidate => [
      `${candidate.operator.operatorId}\u0000${candidate.skill.skillId}`,
      candidate,
    ]));
  }
  const available = cachedMasteryAvailable;
  return rows.map(({ owned, definition }) => `<article class="operator-row rarity-${definition.rarity}">
    <img class="operator-avatar" src="${avatar(definition.operatorId)}" alt="${esc(definition.name)}头像" loading="lazy" decoding="async" data-img-fallback>
    <div class="operator-info">
      <div class="operator-identity"><h3>${esc(definition.name)}</h3><span>${esc(definition.profession)} <i>|</i> ${esc(definition.subProfession)}</span></div>
      <div class="operator-status"><span class="rarity-badge rarity-${definition.rarity}">${definition.rarity}★</span><span><img src="${eliteIcon(owned.elitePhase)}" alt="" loading="lazy" decoding="async">精英 ${owned.elitePhase} · Lv.${owned.level}</span><span class="rank-badge">Rank ${owned.skillLevel}</span></div>
      <div class="operator-tags">${[definition.position, ...(definition.tags || [])].filter(Boolean).map(tag => `<span>${esc(tag)}</span>`).join('')}</div>
    </div>
    <div class="operator-skills ${definition.skills.length > 3 ? 'many-skills' : ''}" aria-label="${esc(definition.name)}技能详情与专精状态">${[...definition.skills].sort((a, b) => a.index - b.index).map(skill => {
      const ownedSkill = owned.skills.find(item => item.skillId === skill.skillId);
      const candidate = available.get(`${definition.operatorId}\u0000${skill.skillId}`);
      const masteryLevel = ownedSkill?.masteryLevel ?? 0;
      const progress = SkillDetails.progress(definition, owned, skill);
      const training = state.training?.operator.operatorId === definition.operatorId && state.training.skill.skillId === skill.skillId ? state.training : null;
      const status = training ? `正在训练至${masteryName(training.to)}` : candidate ? `当前可升级到 ${masteryName(candidate.to)}` : progress.next === null ? 'MAX' : '当前不可专精';
      return `<button type="button" class="operator-skill ${candidate ? 'can-upgrade' : ''}" data-operator-skill="${esc(`${definition.operatorId}:${skill.skillId}`)}" title="${esc(`第${skill.index}技能 · ${skill.name} · ${SkillDetails.levelName(progress.current)} · ${status}`)}" aria-label="${esc(`${skill.name}，当前${SkillDetails.levelName(progress.current)}，${status}，查看技能详情`)}" aria-haspopup="dialog" aria-expanded="false">
        <img class="operator-skill-icon" src="${skillIcon(skill.skillId)}" alt="${esc(skill.name)}技能图标" loading="lazy" decoding="async" data-img-fallback="skill">
        ${progress.maximum > 7 ? `<span class="mastery-badge" aria-hidden="true"><img class="operator-skill-mastery" src="${masteryBadge(masteryLevel)}" alt="" loading="lazy" decoding="async"></span>` : ''}
      </button>`;
    }).join('')}</div>
    <div class="operator-watermark" aria-hidden="true"><img src="${professionIcon(definition.profession)}" alt="" loading="lazy" decoding="async"></div>
  </article>`).join('');
}

function closeSkillPopover(restoreFocus = false) {
  if (!skillPopover) return;
  const { anchor, element } = skillPopover;
  element.remove();
  anchor.setAttribute('aria-expanded', 'false');
  anchor.removeAttribute('aria-controls');
  skillPopover = null;
  if (skillPopoverFrame !== null) cancelAnimationFrame(skillPopoverFrame);
  skillPopoverFrame = null;
  window.removeEventListener('scroll', scheduleSkillPopoverPosition, true);
  window.removeEventListener('resize', scheduleSkillPopoverPosition);
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function positionSkillPopover() {
  if (!skillPopover) return;
  const { anchor, element } = skillPopover;
  const rect = anchor.getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect();
  if (!anchor.isConnected || rect.bottom <= Math.max(0, main.top) || rect.top >= Math.min(innerHeight, main.bottom)
      || rect.right <= main.left || rect.left >= Math.min(innerWidth, main.right)) return closeSkillPopover();
  element.style.maxHeight = '';
  const placed = SkillDetails.position(rect, anchor.closest('.operator-row').getBoundingClientRect(), element.offsetWidth,
    element.offsetHeight, { width: innerWidth, height: innerHeight });
  Object.assign(element.style, { left: `${placed.left}px`, top: `${placed.top}px`, maxHeight: `${placed.maxHeight}px` });
  element.dataset.placement = placed.placement;
}

function scheduleSkillPopoverPosition(event) {
  if (!skillPopover || event.type === 'scroll' && skillPopover.element.contains(event.target) || skillPopoverFrame !== null) return;
  skillPopoverFrame = requestAnimationFrame(() => { skillPopoverFrame = null; positionSkillPopover(); });
}

function renderSkillPopover() {
  const { element, definition, owned, skill, next, highlighted } = skillPopover;
  const progress = SkillDetails.progress(definition, owned, skill);
  const level = next ? progress.next : progress.current;
  const detail = state.gameData.skillDetails?.[skill.skillId]?.[level - 1];
  const spType = { INCREASE_WITH_TIME: '自动回复', INCREASE_WHEN_ATTACK: '攻击回复', INCREASE_WHEN_TAKEN_DAMAGE: '受击回复', ALWAYS: '被动' };
  const skillType = { MANUAL: '手动触发', AUTO: '自动触发', PASSIVE: '被动' };
  const number = (label, value) => `<div class="skill-detail-number"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  const duration = detail?.duration > 0 ? `${detail.duration} 秒` : detail?.duration < 0 ? '无限' : '';
  const stats = detail?.skillType === 'PASSIVE' ? '<span class="skill-detail-chip">被动技能</span>' : detail
    ? `<div class="skill-detail-tags"><span class="skill-detail-chip">${esc(spType[detail.spType] ?? detail.spType)}</span><span class="skill-detail-chip">${esc(skillType[detail.skillType] ?? detail.skillType)}</span></div><dl class="skill-detail-numbers">${number('初始技力', detail.initialSp)}${number('技力消耗', detail.spCost)}${duration ? number('持续时间', duration) : ''}${detail.maxCharges > 1 ? number('充能次数', `${detail.maxCharges} 次`) : ''}</dl>`
    : '';
  const training = state.training?.operator.operatorId === definition.operatorId && state.training.skill.skillId === skill.skillId ? state.training : null;
  const badges = `${highlighted ? '<span class="skill-detail-ready">当前可专精</span>' : ''}${training ? `<span class="skill-detail-training">训练中 · 至${masteryName(training.to)}</span>` : ''}`;
  const materials = materialMap();
  const cost = ({ itemId, quantity }) => {
    const stock = state.account.inventory[itemId] ?? 0;
    return `<div class="skill-detail-material${stock < quantity ? ' short' : ''}">${planMaterialToken(itemId, quantity, materials)}<span class="skill-detail-material-copy"><span>${esc(materials.get(itemId)?.name || itemId)}</span><small>库存 ${compactNumber(stock)}</small></span></div>`;
  };
  element.classList.toggle('can-upgrade', highlighted);
  element.innerHTML = `<header class="skill-detail-heading"><img class="skill-detail-icon" src="${skillIcon(skill.skillId)}" alt="" data-img-fallback="skill"><div class="skill-detail-title"><small>${esc(definition.name)} · 第 ${skill.index} 技能</small><h2 id="skill-detail-title">${esc(detail?.name ?? skill.name)}</h2>${badges ? `<div class="skill-detail-badges">${badges}</div>` : ''}</div><button class="skill-detail-close" type="button" data-close-skill aria-label="关闭技能详情">${closeIcon}</button></header>
    <div class="segmented skill-detail-levels" role="group" aria-label="技能等级"><button type="button" data-skill-view="current" class="${next ? '' : 'active'}" aria-pressed="${!next}"><small>当前</small>${SkillDetails.levelName(progress.current)}</button>${progress.next === null ? '<span class="skill-detail-max" role="status" title="已达到最高等级">MAX</span>' : `<button type="button" data-skill-view="next" class="${next ? 'active' : ''}" aria-pressed="${next}"><small>下一级</small>${SkillDetails.levelName(progress.next)}</button>`}</div>
    <div class="skill-detail-body" aria-live="polite">${detail ? `<div class="skill-detail-stats">${stats}</div><p class="skill-detail-description">${esc(detail.description)}</p>` : '<p class="skill-detail-note">当前资源缺少此等级的技能详情，请更新资源数据。</p>'}
    ${next ? `<section class="skill-detail-costs"><h3>升至${SkillDetails.levelName(progress.next)}所需材料</h3>${progress.requirements ? progress.requirements.length ? `<div class="skill-detail-materials">${progress.requirements.map(cost).join('')}</div>` : '<p class="skill-detail-note">无需材料</p>' : '<p class="skill-detail-note">当前资源缺少该等级的升级材料数据。</p>'}</section>` : ''}</div>`;
  bindImageFallbacks(element);
  positionSkillPopover();
}

function showSkillPopover(anchor) {
  if (skillPopover?.anchor === anchor) return closeSkillPopover(true);
  closeSkillPopover();
  const [operatorId, skillId] = anchor.dataset.operatorSkill.split(':');
  const row = ownedOperatorRows().find(row => row.definition.operatorId === operatorId);
  const skill = row?.definition.skills.find(skill => skill.skillId === skillId);
  if (!skill) return;
  const element = document.createElement('div');
  element.id = 'skill-detail';
  element.className = 'skill-detail';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  element.setAttribute('aria-labelledby', 'skill-detail-title');
  skillPopover = { element, anchor, ...row, skill, next: false, highlighted: anchor.classList.contains('can-upgrade') };
  document.body.append(element);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', element.id);
  renderSkillPopover();
  element.addEventListener('click', event => {
    if (event.target.closest('[data-close-skill]')) return closeSkillPopover(true);
    const button = event.target.closest('[data-skill-view]');
    if (!button) return;
    const view = button.dataset.skillView;
    skillPopover.next = view === 'next';
    renderSkillPopover();
    element.querySelector(`[data-skill-view="${view}"]`).focus({ preventScroll: true });
  });
  element.querySelector('[data-skill-view="current"]').focus({ preventScroll: true });
  window.addEventListener('scroll', scheduleSkillPopoverPosition, true);
  window.addEventListener('resize', scheduleSkillPopoverPosition);
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
    operatorFilters.sort = OperatorFilters.nextSort(operatorFilters.sort, event.currentTarget.dataset.operatorSort);
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  }));
  content.querySelector('[data-operator-sort-order]').addEventListener('click', () => {
    operatorFilters.sort = OperatorFilters.nextSort(operatorFilters.sort, operatorFilters.sort.split('-')[0]);
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  });
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
    if (!counter) continue;
    counter.textContent = count ? String(count) : '';
    const trigger = counter.closest('[data-operator-panel-trigger]');
    trigger.setAttribute('aria-label', count ? `${trigger.dataset.label}，已选 ${count} 项` : trigger.dataset.label);
  }
  const active = OperatorFilters.hasActive(operatorFilters);
  const reset = content.querySelector('[data-operator-reset]');
  if (reset) { reset.disabled = !active; reset.hidden = !active; }
  const ascending = operatorFilters.sort.endsWith('-asc');
  content.querySelectorAll('[data-operator-sort]').forEach(button => {
    const [, label, ascLabel, descLabel] = operatorSortModes.find(([value]) => value === button.dataset.operatorSort);
    const selected = operatorFilters.sort.startsWith(`${button.dataset.operatorSort}-`);
    const description = selected
      ? `当前${ascending ? ascLabel : descLabel}，点击切换为${ascending ? descLabel : ascLabel}`
      : `点击按${ascLabel}排列`;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${label}，${description}`);
    button.title = `${label}：${description}`;
    button.querySelector('.operator-sort-direction').textContent = selected ? (ascending ? '↑' : '↓') : '';
  });
  const order = content.querySelector('[data-operator-sort-order]');
  const mode = operatorSortModes.find(([value]) => operatorFilters.sort.startsWith(`${value}-`));
  if (order && mode) {
    const [current, other] = ascending ? [mode[2], mode[3]] : [mode[3], mode[2]];
    order.dataset.direction = ascending ? 'asc' : 'desc';
    order.querySelector('[data-operator-sort-order-label]').textContent = current;
    order.title = `${mode[1]}：当前${current}，点击切换为${other}`;
    order.setAttribute('aria-label', `排序方向：${mode[1]}${current}，点击切换为${other}`);
  }
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
      <img class="inventory-icon-image" src="${itemIcon(item.itemId)}" alt="" loading="lazy" decoding="async" data-img-fallback>
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
    <p class="operator-meta inventory-detail-loading" role="status">正在加载配方…</p>
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
        <label class="switch"><input type="checkbox" aria-label="${esc(detail.material.name)}无限供应" data-inventory-unlimited="${esc(itemId)}" ${unlimited.has(itemId) ? 'checked' : ''}><span></span></label>
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
        <input type="search" class="search-input" data-inventory-search value="${esc(query)}" placeholder="搜索材料" autocomplete="off" spellcheck="false">
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
  const resourceVersion = state.gameData.version;
  try {
    const detail = await api.materialDetail(itemId);
    if (requestId !== inventoryDetailRequest || inventorySelectedId !== itemId || resourceVersion !== state.gameData.version) return;
    panel.innerHTML = renderInventoryDetailContent(itemId, detail);
    bindInventoryDetailActions(panel);
    bindImageFallbacks(panel);
  } catch (error) {
    if (requestId !== inventoryDetailRequest || inventorySelectedId !== itemId) return;
    panel.innerHTML = `${renderInventoryDetailLoading(itemId).replace(/<p class="operator-meta inventory-detail-loading"[^>]*>.*?<\/p>/, '')}<p class="error-banner" role="alert">配方加载失败：${esc(error.message || String(error))}</p><button class="secondary" data-retry-detail>重新加载</button>`;
    panel.querySelector('[data-retry-detail]').addEventListener('click', () => loadInventoryDetail(itemId));
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

function renderResourceStatus() {
  const message = document.querySelector('[data-resource-status]');
  if (message) message.textContent = resourceUpdateState?.message || '';
  const button = document.querySelector('[data-action="update-game"]');
  if (button) {
    button.disabled = ['checking', 'installing'].includes(resourceUpdateState?.phase);
    button.textContent = button.disabled ? '后台更新中…' : '检查并更新资源';
  }
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
  const icon = paths => `<span class="setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths}</svg></span>`;
  const row = (paths, title, body, actions, className = '') => `<div class="setting-row${className}"><div class="setting-main">${icon(paths)}<div class="setting-copy"><h3>${title}</h3>${body}</div></div><div class="setting-actions">${actions}</div></div>`;
  const group = (title, rows) => `<section class="settings-group"><h2 class="settings-group-title">${title}</h2><div class="settings-group-body">${rows}</div></section>`;
  const preview = value => `<span class="theme-preview theme-preview-${value}" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const account = state.loggedIn
    ? `<p><span class="setting-status ok">已连接</span>${state.account ? `<span class="setting-chip">UID ${esc(state.account.uid)}</span>` : ''}</p><p>凭据使用 Windows DPAPI 加密保存。</p>`
    : `<p><span class="setting-status">未连接</span>${state.account ? `<span class="setting-chip">缓存 UID ${esc(state.account.uid)}</span>` : ''}</p><p>凭据使用 Windows DPAPI 加密保存。</p>`;
  const refreshBody = accountRefreshing
    ? '<p class="setting-progress" role="status">正在从森空岛同步仓库、干员与专精状态…</p>'
    : `<p>从森空岛同步仓库、干员、专精与模组状态。</p><dl class="setting-meta"><div><dt>最近同步</dt><dd>${state.account?.syncedAt ? esc(fmtTime(state.account.syncedAt)) : '尚未同步'}</dd></div>${state.usingCache && state.account ? '<div><dt>当前数据</dt><dd>本地缓存</dd></div>' : ''}</dl>${state.loggedIn ? '' : '<p>连接森空岛账号后即可刷新。</p>'}`;
  const refreshAction = `<button class="${state.loggedIn ? 'primary' : 'secondary'}" data-action="refresh-account" ${state.loggedIn && !accountRefreshing ? '' : 'disabled'} ${accountRefreshing ? 'aria-busy="true"' : ''}>${accountRefreshing ? '同步中…' : '刷新账号数据'}</button>`;
  content.innerHTML = `${banners()}<div class="settings-list">
    ${group('账号', `
      ${row('<circle cx="12" cy="8" r="5"></circle><path d="M20 21a8 8 0 0 0-16 0"></path>', '森空岛账号', account, state.loggedIn ? '<button class="secondary" data-action="login">重新认证</button><button class="danger" data-action="logout">退出 / 删除认证</button>' : '<button class="primary" data-action="login">扫码连接</button>')}
      ${row('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path>', '账号数据', refreshBody, refreshAction, ' refresh-row')}
      ${row('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path>', '启动时自动刷新', '<p>先显示缓存结果，再在后台同步森空岛。</p>', `<label class="switch"><input type="checkbox" aria-label="启动时自动刷新" data-auto-refresh ${state.settings.autoRefresh ? 'checked' : ''}><span></span></label>`)}
    `)}
    ${group('外观', `
      ${row('<circle cx="12" cy="12" r="10"></circle><path d="M12 18a6 6 0 0 0 0-12v12z"></path>', '主题', '<p>跟随系统会在系统深色模式下使用黑色主题，并实时响应切换。</p>', `<div class="radio-stack theme-options" role="radiogroup" aria-label="主题"><label class="theme-option">${preview('system')}<input type="radio" name="theme" value="system" ${state.settings.theme === 'system' ? 'checked' : ''}> 跟随系统</label><label class="theme-option">${preview('black')}<input type="radio" name="theme" value="black" ${state.settings.theme === 'black' ? 'checked' : ''}> 黑色</label><label class="theme-option">${preview('light')}<input type="radio" name="theme" value="light" ${state.settings.theme === 'light' ? 'checked' : ''}> 浅色</label></div>`, ' theme-row')}
    `)}
    ${group('数据与维护', `
      ${row('<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14a9 3 0 0 0 18 0V5"></path><path d="M3 12a9 3 0 0 0 18 0"></path>', '游戏资源', `<p>启动时及每小时自动检查，更新后立即生效。</p><dl class="setting-meta"><div><dt>资源版本</dt><dd>${esc(state.gameData.version)}</dd></div><div><dt>最后更新</dt><dd>${esc(fmtTime(state.gameData.updatedAt))}</dd></div></dl><p class="update-message" data-resource-status role="status">${esc(resourceUpdateState?.message)}</p>`, '<button class="secondary" data-action="update-game">检查并更新资源</button>')}
      ${row('<circle cx="12" cy="12" r="10"></circle><path d="m16 12-4-4-4 4"></path><path d="M12 16V8"></path>', '应用更新', `<p><span class="setting-chip">当前版本 v${esc(updateState.currentVersion)}</span></p><p><span class="update-message ${updateState.phase === 'error' ? 'error' : ''}">${esc(updateState.message)}</span></p>${updateState.phase === 'downloading' ? `<progress class="update-progress" max="100" value="${Math.max(0, Math.min(100, updateState.progress || 0))}" aria-label="应用更新下载进度"></progress>` : ''}`, updateActions[updateState.phase] || updateActions.idle, ' update-row')}
      ${row('<path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>', '缓存', '<p>清除最近一次账号快照；不会删除登录凭据或内置游戏数据。</p>', '<button class="danger" data-action="clear-cache">清理账号缓存</button>')}
    `)}
  </div>`;
  bindActions();
  renderResourceStatus();
}

function bindActions() {
  document.querySelectorAll('[data-statistics-scope]').forEach(button => button.addEventListener('click', event => {
    statisticsScope = event.currentTarget.dataset.statisticsScope;
    renderStatistics();
    content.querySelector(`[data-statistics-scope="${statisticsScope}"]`).focus();
  }));
  document.querySelectorAll('[data-planner-filter]').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', event => {
    if (event.isComposing) return;
    const kind = event.target.dataset.plannerKind;
    plannerFilters[kind][event.target.dataset.plannerFilter] = event.target.value;
    kind === 'promotion' ? renderPromotionPlanner(true) : renderModulePlanner(true);
  }));
  content.querySelectorAll('[data-planner-filter="search"], [data-dashboard-filter="search"]').forEach(input => input.addEventListener('compositionend', () => input.dispatchEvent(new Event('input'))));
  document.querySelectorAll('[data-planner-toggle]').forEach(input => input.addEventListener('change', event => {
    const kind = event.target.dataset.plannerKind;
    const key = event.target.dataset.plannerToggle;
    plannerFilters[kind][key] = key === 'continuous' ? event.target.checked : event.target.checked ? 'with' : 'real';
    kind === 'promotion' ? renderPromotionPlanner(true) : renderModulePlanner(true);
  }));
  document.querySelector('[data-continuous-mode]')?.addEventListener('change', event => {
    mode = event.target.checked ? 'continuous' : 'single';
    if (mode === 'continuous' && dashboardFilters.mastery === '2') dashboardFilters.mastery = '';
    renderDashboard();
    content.querySelector('[data-continuous-mode]').focus();
  });
  document.querySelector('[data-unlimited-materials]')?.addEventListener('change', event => {
    dashboardFilters.unlimited = event.target.checked ? 'with' : 'real';
    renderDashboard(true);
  });
  document.querySelectorAll('[data-dashboard-filter]').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', event => {
    if (event.isComposing) return;
    dashboardFilters[event.target.dataset.dashboardFilter] = event.target.value;
    renderDashboard(true);
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
  bindCandidateActions();
  bindInventoryGridActions();
  bindInventoryDetailActions();
  document.querySelector('[data-unlimited-summaries]')?.addEventListener('change', async event => {
    const ids = new Set(state.settings.unlimitedItemIds);
    for (const id of state.skillSummaryItemIds) event.target.checked ? ids.add(id) : ids.delete(id);
    if (await saveSettings({ unlimitedItemIds: [...ids] })) page === 'dashboard' ? renderDashboard(true) : render();
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
  document.querySelectorAll('input[name="theme"]').forEach(input => input.addEventListener('change', () => saveSettings({ theme: input.value })));
  document.querySelector('[data-auto-refresh]')?.addEventListener('change', event => saveSettings({ autoRefresh: event.target.checked }));
  content.querySelectorAll('input[placeholder]').forEach(input => input.setAttribute('aria-label', input.placeholder));
  if (settingsSaving) content.querySelectorAll('input[type="checkbox"], input[name="theme"]').forEach(input => { input.disabled = true; });
  bindImageFallbacks();
}

function bindCandidateActions() {
  content.querySelector('[data-training-plan]')?.addEventListener('click', () => {
    const candidate = trainingCandidate();
    if (candidate) showCandidate(candidate);
  });
  content.querySelector('[data-reset-planner]')?.addEventListener('click', () => {
    const filters = page === 'dashboard' ? dashboardFilters : plannerFilters[page === 'promotion' ? 'promotion' : 'module'];
    for (const key of ['search', 'profession', 'rarity', 'mastery', 'level']) if (key in filters) filters[key] = '';
    render();
    content.querySelector('input')?.focus();
  });
  const openCandidate = card => {
    const [operatorId, skillId] = card.dataset.key.split(':');
    const candidate = currentMasteryCandidates().find(x => x.operator.operatorId === operatorId && x.skill.skillId === skillId);
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
}

async function saveSettings(patch) {
  if (settingsSaving) return false;
  settingsSaving = true;
  const controls = [...content.querySelectorAll('input[type="checkbox"], input[name="theme"]')];
  controls.forEach(input => { input.disabled = true; });
  try {
    setState(await api.updateSettings(patch));
    document.documentElement.dataset.theme = state.settings.theme;
    showToast('设置已保存');
    return true;
  } catch (error) {
    showToast(`设置未保存：${error.message || error}`, 'error');
    render();
    return false;
  } finally {
    settingsSaving = false;
    controls.forEach(input => { input.disabled = false; });
    content.querySelectorAll('input[type="checkbox"], input[name="theme"]').forEach(input => { input.disabled = false; });
  }
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
      if (await saveSettings({ unlimitedItemIds: [...ids] })) {
        if (page === 'inventory' && inventorySelectedId) loadInventoryDetail(inventorySelectedId);
        else render();
      }
    });
  });
}

function bindImageFallbacks(root = document) {
  root.querySelectorAll('[data-img-fallback]:not([data-fallback-bound])').forEach(img => {
    img.dataset.fallbackBound = 'true';
    img.addEventListener('error', () => {
    if (img.dataset.imgFallback === 'skill') {
      img.src = skillPlaceholder();
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
    if (action === 'login') { await beginLogin(); return; }
    if (action === 'refresh-account') { await refreshAccountData(); return; }
    if (action === 'logout') setState(await api.logout());
    if (action === 'update-game') {
      const previousVersion = state.gameData.version;
      setState(await api.updateGameData());
      showToast(previousVersion === state.gameData.version ? '当前已是最新兼容资源' : '游戏资源已更新');
    }
    if (action === 'check-update') updateState = await api.checkForUpdates();
    if (action === 'download-update') updateState = await api.downloadUpdate();
    if (action === 'install-update') updateState = await api.installUpdate();
    if (action === 'clear-cache' && confirm('确定清除账号缓存？登录凭据和无限材料设置会保留。')) setState(await api.clearCache());
    render();
  } catch (error) {
    showToast(error.message || String(error), 'error');
  } finally {
    setBusy(button, false);
    updateChrome();
  }
}

async function refreshAccountData() {
  if (accountRefreshing || !state.loggedIn) return;
  accountRefreshing = true;
  render();
  try {
    setState(await api.refreshAccount());
    showToast('账号数据已刷新');
  } catch (error) {
    showToast(error.message || String(error), 'error');
    setState(await api.getState().catch(() => state));
  } finally {
    accountRefreshing = false;
    render();
    content.querySelector('[data-action="refresh-account"]')?.focus();
  }
}

async function beginLogin() {
  const attempt = ++loginAttempt;
  const cancelled = new Promise(resolve => { cancelLogin = () => resolve(null); });
  const active = () => attempt === loginAttempt;
  showModal('<h2>连接森空岛</h2><p class="loading" role="status">正在生成二维码…</p>');
  try {
    const qr = await Promise.race([api.startQrLogin(), cancelled]);
    if (!active() || !qr) return;
    showModal(`<div class="qr-wrap"><h2>使用森空岛 App 扫码</h2><img src="${qr.qrCode}" alt="森空岛登录二维码"><p>二维码有效期约 2 分钟。扫码确认后应用会自动继续。</p><span class="badge warn" role="status">正在等待扫码确认…</span></div>`);
    const bindings = await Promise.race([api.finishQrLogin(qr.scanId), cancelled]);
    if (!active() || !bindings) return;
    if (!bindings.length) throw new Error('登录成功，但没有找到绑定的明日方舟角色');
    const selected = bindings.find(x => x.isDefault) || bindings[0];
    showModal(`<h2>选择游戏角色</h2><p>已安全保存认证信息。请选择要同步的角色。</p><label for="binding-select">游戏角色</label><select id="binding-select">${bindings.map(x => `<option value="${esc(x.uid)}" ${x.uid === selected.uid ? 'selected' : ''}>${esc(x.nickName || x.uid)} · ${esc(x.channelName || '')}</option>`).join('')}</select><p class="binding-actions"><button class="primary" id="binding-confirm">同步并进入首页</button></p>`);
    const uid = await Promise.race([new Promise(resolve => document.querySelector('#binding-confirm').addEventListener('click', () => resolve(document.querySelector('#binding-select').value), { once: true })), cancelled]);
    if (!active() || !uid) return;
    showModal('<h2>同步账号数据</h2><p class="loading" role="status">正在读取仓库与干员，请稍候…</p>');
    const next = await Promise.race([api.refreshAccount(uid), cancelled]);
    if (!active() || !next) return;
    setState(next);
    cancelLogin = null;
    closeModal();
    page = 'dashboard';
    render();
    showToast('账号数据同步完成');
  } catch (error) {
    if (!active()) return;
    showModal(`<h2>连接未完成</h2><p class="error-banner" role="alert">${esc(error.message || error)}</p><button class="primary" data-retry-login>重新连接</button>`);
    modalContent.querySelector('[data-retry-login]').addEventListener('click', beginLogin, { once: true });
  } finally {
    if (active()) cancelLogin = null;
  }
}

function showCandidate(candidate) {
  showModal(planDetailHtml(candidate, {
    heading: planDetailHeading(`<img class="plan-detail-icon" src="${skillIcon(candidate.skill.skillId)}" alt="" data-img-fallback="skill">`, `${esc(candidate.operator.name)} · S${candidate.skill.index}`, `${esc(candidate.skill.name)} · ${masteryName(candidate.from)} → ${masteryName(candidate.to)}`),
    stageHeading: stage => `<img src="${masteryIcon(stage.from)}" alt=""><span class="plan-stage-arrow">→</span><img src="${masteryIcon(stage.to)}" alt=""><span class="plan-stage-label">${masteryName(stage.from)} → ${masteryName(stage.to)}</span>`,
    continuousLabel: '连续专精合计',
    totalLabel: '专精总需求',
  }));
  bindPlanRecipes(candidate);
  refreshResourceModal = () => {
    const next = [trainingCandidate(), ...currentMasteryCandidates()].find(item => item && item.operator.operatorId === candidate.operator.operatorId && item.skill.skillId === candidate.skill.skillId);
    if (next) showCandidate(next); else closeModal();
  };
}

function showPlanCandidate(candidate, kind) {
  const moduleStageName = level => Number(level) === 0 ? '未装配' : `阶段 ${level}`;
  const options = kind === 'promotion'
    ? {
      heading: planDetailHeading(`<img class="plan-detail-icon plan-detail-avatar" src="${avatar(candidate.operator.operatorId)}" alt="" data-img-fallback>`, `${esc(candidate.operator.name)} · 精英化`, `${esc(candidate.operator.profession)} · 精英 ${candidate.from} → 精英 ${candidate.to}`),
      stageHeading: stage => `<img class="plan-stage-elite" src="${eliteIcon(stage.from)}" alt=""><span class="plan-stage-arrow">→</span><img class="plan-stage-elite" src="${eliteIcon(stage.to)}" alt=""><span class="plan-stage-label">精英 ${stage.from} → 精英 ${stage.to}</span>`,
      totalLabel: '精英化总需求',
    }
    : {
      heading: planDetailHeading(`<span class="plan-detail-icon module-type-icon"><img src="${moduleTypeIcon(candidate.module.typeIcon)}" alt="" data-img-fallback></span>`, `${esc(candidate.operator.name)} · ${esc(moduleTypeCode(candidate.module.typeIcon))}`, `${esc(candidate.module.name)} · ${esc(candidate.module.typeLabel)} · ${moduleStageName(candidate.from)} → ${moduleStageName(candidate.to)}`),
      stageHeading: stage => `${moduleStageTransition(stage.from, stage.to, true)}<span class="plan-stage-label">${moduleStageName(stage.from)} → ${moduleStageName(stage.to)}</span>`,
      totalLabel: '模组总需求',
      note: candidate.from === 0 ? '材料与等级门槛已满足；首次开启前仍需在游戏内完成该模组任务。' : '',
    };
  showModal(planDetailHtml(candidate, { continuousLabel: '连续规划合计', ...options }));
  bindPlanRecipes(candidate);
  refreshResourceModal = () => {
    const next = currentPlanCandidates(kind).find(item => item.operator.operatorId === candidate.operator.operatorId && item.module?.moduleId === candidate.module?.moduleId);
    if (next) showPlanCandidate(next, kind); else closeModal();
  };
}

function planDetailHeading(icon, title, subtitle) {
  return `<div class="plan-detail-heading">${icon}<div><h2>${title}</h2><p>${subtitle}</p></div></div>`;
}

// Shared by all planners; each kind supplies its heading and stage labels, the material logic stays per candidate.
function planDetailHtml(candidate, { heading, stageHeading, continuousLabel, totalLabel, note = '' }) {
  const materials = materialMap();
  const totals = new Map();
  const exchanges = new Map();
  let experienceTotal = 0;
  candidate.stages.forEach(stage => {
    stage.requirements.forEach(x => totals.set(x.itemId, (totals.get(x.itemId) || 0) + x.quantity));
    stage.craft.exchanges.forEach(x => exchanges.set(x.itemId, (exchanges.get(x.itemId) || 0) + x.quantity));
    experienceTotal += stage.experienceRequired || 0;
  });
  const summaries = new Set(state.skillSummaryItemIds);
  const shop = [...exchanges].filter(([id]) => !summaries.has(id));
  const books = [...exchanges].filter(([id]) => summaries.has(id));
  let inventory = state.account.inventory;
  let experienceAvailable = candidate.experienceAvailable ?? 0;
  const stages = candidate.stages.map((stage, stageIndex) => {
    const experience = stage.experienceRequired ? planExperienceCard(stage.experienceRequired, experienceAvailable) : '';
    experienceAvailable -= stage.experienceRequired || 0;
    const cards = stage.requirements.map(requirement => planMaterialCard(requirement, stage, stageIndex, inventory, materials)).join('');
    inventory = stage.craft.remainingInventory;
    return `<section class="stage-block plan-stage"><h3 class="plan-stage-heading">${stageHeading(stage)}</h3><div class="plan-material-grid">${experience}${cards}</div><div class="plan-stage-recipe" id="plan-recipe-${stageIndex}" role="region" hidden></div></section>`;
  }).join('');
  const totalTokens = [
    experienceTotal ? planExperienceToken(experienceTotal) : '',
    ...[...totals].map(([id, quantity]) => planMaterialToken(id, quantity, materials)),
  ].join('');
  return `${heading}${note ? `<p class="planner-note">${esc(note)}</p>` : ''}
    <section class="plan-exchange-summary${shop.length || books.length ? '' : ' is-clear'}"><h3>${planStatusIcon('shop')}还需兑换${candidate.stages.length > 1 ? `<small>${continuousLabel}</small>` : ''}</h3>
      ${shop.length ? `<div class="plan-exchange-grid">${shop.map(([id, quantity]) => `<div class="plan-exchange-item" data-exchange-item="${esc(id)}" data-exchange-quantity="${quantity}">${planMaterialToken(id, quantity, materials)}</div>`).join('')}</div>` : `<div class="plan-no-exchange">${planStatusIcon('check')}无需兑换材料</div>`}
      ${books.length ? `<div class="plan-summary-books"><span>技巧概要还需准备</span><div class="plan-exchange-grid">${books.map(([id, quantity]) => planMaterialToken(id, quantity, materials)).join('')}</div></div>` : ''}
    </section>${stages}
    ${candidate.stages.length > 1 ? `<section class="stage-block plan-total"><h3 class="plan-stage-heading"><span class="plan-stage-label">${totalLabel}</span></h3><div class="plan-total-grid">${totalTokens}</div></section>` : ''}`;
}

function planMaterialCard(requirement, stage, stageIndex, inventory, materials) {
  const step = stage.craft.steps.find(x => x.itemId === requirement.itemId);
  const stock = inventory[requirement.itemId] ?? 0;
  return `<article class="plan-material-card">${planMaterialToken(requirement.itemId, requirement.quantity, materials)}
    <div class="plan-stock" title="本阶段开始时的可用库存 ${stock}，已扣除前面阶段的消耗">库存 <strong>${compactNumber(stock)}</strong></div>
    ${planMaterialStatus(step)}<div class="plan-card-footer">${step?.batches ? `<button type="button" class="plan-recipe-toggle" data-plan-recipe-toggle="${esc(requirement.itemId)}" aria-controls="plan-recipe-${stageIndex}" aria-expanded="false">${planStatusIcon('craft')}配方<span class="plan-expand-arrow">⌄</span></button>` : '<span class="plan-card-footer-static">无需加工</span>'}</div>
  </article>`;
}

function planExperienceToken(quantity) {
  return `<div class="plan-material-token" tabindex="0" title="干员经验 ×${quantity.toLocaleString('zh-CN')}" aria-label="干员经验，数量 ${quantity}"><img src="${itemIcon('2004')}" alt="干员经验" data-img-fallback><strong>×${compactNumber(quantity)}</strong></div>`;
}

function planExperienceCard(required, available) {
  const missing = Math.max(0, required - available);
  return `<article class="plan-material-card plan-experience-card">${planExperienceToken(required)}
    <div class="plan-stock" title="作战记录按经验折算 ${Math.max(0, available).toLocaleString('zh-CN')}，已扣除前面阶段的消耗">折算 <strong>${compactNumber(Math.max(0, available))}</strong></div>
    <div class="plan-material-status">${missing ? `<span class="plan-status-exchange">${planStatusIcon('shop')}待补充 ×${compactNumber(missing)}</span>` : `<span class="plan-status-ready">${planStatusIcon('check')}已满足</span>`}</div>
    <div class="plan-card-footer"><span class="plan-card-footer-static">干员经验</span></div>
  </article>`;
}

function bindPlanRecipes(candidate) {
  const materials = materialMap();
  modalContent.querySelectorAll('.plan-stage').forEach((stageElement, index) => {
    const panel = stageElement.querySelector('.plan-stage-recipe');
    const buttons = [...stageElement.querySelectorAll('[data-plan-recipe-toggle]')];
    buttons.forEach(button => button.addEventListener('click', () => {
      const opening = button.getAttribute('aria-expanded') !== 'true';
      buttons.forEach(other => {
        other.setAttribute('aria-expanded', String(opening && other === button));
        other.closest('.plan-material-card').classList.toggle('selected', opening && other === button);
      });
      panel.hidden = !opening;
      if (!opening) return;
      const step = candidate.stages[index].craft.steps.find(item => item.itemId === button.dataset.planRecipeToggle);
      const name = materials.get(step.itemId)?.name || step.itemId;
      panel.setAttribute('aria-label', `${name}的加工配方`);
      panel.innerHTML = `<div class="plan-recipe-heading"><h4>${planMaterialToken(step.itemId, step.crafted, materials)}<span>${esc(name)}<small>加工 ×${step.batches}</small></span></h4><button type="button" class="plan-recipe-close" aria-label="收起加工配方">${closeIcon}</button></div>${planRecipeVisual(step, materials)}`;
      panel.querySelector('.plan-recipe-close').addEventListener('click', () => { button.click(); button.focus(); });
      bindImageFallbacks(panel);
    }));
  });
}

function planStatusIcon(kind) {
  const paths = {
    shop: '<path d="M5 8h14l1 12H4L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    craft: '<path d="m14 5 5 5M3 21l11-11M12 7l5-5 5 5-5 5Z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  return `<svg class="plan-status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind]}</svg>`;
}

function planMaterialToken(itemId, quantity, materials) {
  const name = materials.get(itemId)?.name || itemId;
  return `<div class="plan-material-token" tabindex="0" title="${esc(name)} ×${quantity}" aria-label="${esc(name)}，数量 ${quantity}"><img src="${itemIcon(itemId)}" alt="${esc(name)}" data-img-fallback><strong>×${compactNumber(quantity)}</strong></div>`;
}

function planMaterialStatus(step) {
  if (!step) return `<div class="plan-material-status"><span class="plan-status-ready">${planStatusIcon('check')}已满足</span></div>`;
  const needsExchange = step.unlimitedRoots.length > 0;
  const isSummary = state.skillSummaryItemIds.includes(step.itemId);
  const exchangeLabel = step.exchangeQuantity ? `${isSummary ? '待补充' : '待兑换'} ×${step.exchangeQuantity}` : '待兑换原料';
  return `<div class="plan-material-status">
    ${needsExchange ? `<span class="plan-status-exchange">${planStatusIcon('shop')}${exchangeLabel}</span>` : ''}
    ${step.batches ? `<span class="plan-status-craft">${planStatusIcon('craft')}加工 ×${step.batches}</span>` : ''}
    ${!needsExchange && !step.batches ? `<span class="plan-status-ready">${planStatusIcon('check')}已满足</span>` : ''}
  </div>`;
}

function planRecipeVisual(step, materials) {
  return `<div class="plan-recipe-body"><div class="plan-recipe-flow">${step.children.map(child => `<div class="plan-recipe-term"><div class="plan-recipe-input">${planMaterialToken(child.itemId, child.requested, materials)}<small title="这次加工前的可用库存，已扣除前面步骤的消耗">库存 ${compactNumber(child.availableInventory)}</small>${planMaterialStatus(child)}</div></div>`).join('')}<div class="plan-recipe-term"><span class="plan-flow-symbol">→</span><div class="plan-recipe-output">${planMaterialToken(step.itemId, step.crafted, materials)}<small>产出</small></div></div></div>
    ${step.children.filter(child => child.batches).map(child => `<details class="plan-recipe plan-recipe-nested"><summary>${planMaterialToken(child.itemId, child.requested, materials)}${planStatusIcon('craft')}配方<span class="plan-expand-arrow">⌄</span></summary>${planRecipeVisual(child, materials)}</details>`).join('')}
  </div>`;
}

function showModal(html) {
  closeSkillPopover();
  refreshResourceModal = null;
  if (modal.classList.contains('hidden')) modalTrigger = document.activeElement;
  modalContent.innerHTML = html;
  modal.classList.remove('hidden');
  if (!modal.open) modal.showModal();
  const title = modalContent.querySelector('h2');
  if (title) { title.id = 'modal-title'; modal.setAttribute('aria-labelledby', title.id); }
  modal.querySelector('.modal-panel').scrollTop = 0;
  modal.querySelector('.modal-close').focus();
  bindImageFallbacks(modalContent);
}

function closeModal() {
  refreshResourceModal = null;
  if (cancelLogin) {
    loginAttempt++;
    cancelLogin();
    cancelLogin = null;
    api.cancelQrLogin().catch(error => showToast(error.message || String(error), 'error'));
  }
  modal.classList.add('hidden');
  modal.close();
  if (modalTrigger?.isConnected) modalTrigger.focus();
}

document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => {
  page = button.dataset.page;
  document.querySelector('main').scrollTop = 0;
  render();
}));
document.querySelectorAll('[data-close-modal]').forEach(x => x.addEventListener('click', closeModal));
content.addEventListener('click', event => {
  const anchor = event.target.closest('[data-operator-skill]');
  if (anchor) showSkillPopover(anchor);
});
document.addEventListener('pointerdown', event => {
  if (skillPopover && !skillPopover.element.contains(event.target) && !skillPopover.anchor.contains(event.target)) closeSkillPopover();
});
document.addEventListener('focusin', event => {
  if (skillPopover && !skillPopover.element.contains(event.target) && event.target !== skillPopover.anchor) closeSkillPopover();
});
modal.addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && skillPopover) { event.preventDefault(); closeSkillPopover(true); return; }
  if (!modal.open && event.key === 'Escape') {
    const region = document.activeElement.closest('[data-operator-filter-region].open') || content.querySelector('[data-operator-filter-region].open');
    const trigger = region?.querySelector('[data-operator-panel-trigger]');
    if (trigger) { trigger.click(); trigger.focus(); }
  }
});
api.onStateChanged(loadState);
api.onUpdateStateChanged(next => { updateState = next; if (page === 'settings') renderSettings(); });
api.onResourceStateChanged(next => { resourceUpdateState = next; renderResourceStatus(); });
window.addEventListener('beforeunload', () => {
  if (toastTimer !== null) clearTimeout(toastTimer);
});
async function start() {
  const cached = api.getCachedState().then(next => {
    if (!state && next) {
      try {
        setState(next);
        updateState = api.initialUpdateState;
        render();
      } catch { state = undefined; }
    }
  }).catch(() => {});
  try { await loadState(); }
  catch (error) {
    await cached;
    if (state) showToast(`更新失败，继续显示上次结果：${error.message || error}`, 'error');
    else content.innerHTML = `<div class="error-banner">应用初始化失败：${esc(error.message || error)}</div>`;
  }
}
start();
