const api = window.trainingRoom;
const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
let state;
let updateState;
let page = 'dashboard';
let mode = 'single';
let dashboardFilters = { search: '', profession: '', rarity: '', mastery: '', unlimited: 'real' };
let inventorySearch = '';
const operatorFilters = OperatorFilters.createState();
let operatorSearchComposing = false;

const professions = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const unlimitedPriority = new Map(['30103', '30093', '30083', '30073'].map((id, index) => [id, index]));
const inventoryMaterialIds = new Set([
  '31113', '31103', '31093', '31083', '31073', '31063', '31053',
  '31043', '31033', '31023', '31013', '30073', '30083', '30093',
  '30103', '30013', '30063', '30033', '30023', '30043', '30053',
]);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const fmtTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '从未';
const avatar = id => `../../resources/images/avatar/${encodeURIComponent(id)}.png`;
const itemIcon = id => `../../resources/images/item/${encodeURIComponent(id)}.png`;
const skillIcon = id => `../../resources/images/skill/${encodeURIComponent(id)}.png`;
const masteryIcon = level => `../../resources/images/mastery/m${level}.png`;
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
  updateChrome();
  if (page === 'dashboard') renderDashboard();
  if (page === 'operators') renderOperators();
  if (page === 'inventory') renderInventory();
  if (page === 'settings') renderSettings();
}

function updateChrome() {
  const titles = {
    dashboard: ['当前可以专精', '基于真实仓库与加工站配方的确定性计算'],
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
    ? `<strong>${esc(state.account.nickname || `UID ${state.account.uid}`)}</strong>${state.usingCache ? '当前使用缓存数据<br>' : ''}游戏数据 ${esc(fmtTime(state.gameData.updatedAt))}`
    : `<strong>尚未连接账号</strong>游戏数据 ${esc(fmtTime(state.gameData.updatedAt))}`;
  document.querySelector('#refresh-button').disabled = !state.loggedIn;
}

function banners() {
  const reauthenticate = state.lastError?.includes('重新认证') ? ' <button class="link-button" data-action="login">立即重新认证</button>' : '';
  return `${state.lastError ? `<div class="error-banner">上次刷新失败：${esc(state.lastError)}。已保留旧数据。${reauthenticate}</div>` : ''}${state.usingCache ? `<div class="cache-banner">当前使用缓存数据 · 最后同步：${esc(fmtTime(state.account?.syncedAt))}</div>` : ''}`;
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
    <div class="operator-filter-row">
      ${operatorFilterMenu('rarity', '稀有度', rows, value => `${value}★`, true)}
      ${operatorFilterMenu('gender', '性别', rows)}
      ${operatorFilterMenu('position', '位置', rows)}
      ${operatorFilterMenu('obtainMethods', '获得方式', rows)}
      ${operatorFilterMenu('profession', '职业标签', rows)}
      ${operatorFilterMenu('subProfession', '职业分支', rows)}
      <button class="operator-more-toggle" type="button" data-operator-more aria-expanded="${operatorFilters.moreExpanded}">更多筛选 <span aria-hidden="true">${operatorFilters.moreExpanded ? '▲' : '▼'}</span></button>
      <button class="operator-reset" type="button" data-operator-reset ${OperatorFilters.hasActive(operatorFilters) ? '' : 'disabled'}>清除筛选</button>
    </div>
    <div class="operator-filter-row operator-more-filters" data-operator-more-panel ${operatorFilters.moreExpanded ? '' : 'hidden'}>
      ${operatorFilterMenu('races', '种族', rows)}
      ${operatorFilterMenu('birthPlaces', '出身', rows)}
      ${operatorFilterMenu('organizations', '组织', rows)}
      ${operatorFilterMenu('teams', '团队', rows)}
      ${operatorFilterMenu('birthdayMonth', '生日月份', rows, value => `${value} 月`)}
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
    .filter(row => row.definition)
    .sort((a, b) => b.definition.rarity - a.definition.rarity
      || a.definition.name.localeCompare(b.definition.name, 'zh-CN')
      || a.definition.operatorId.localeCompare(b.definition.operatorId));
}

function operatorFilterMenu(key, label, rows, format = value => value, descending = false) {
  const selected = operatorFilters.selected[key];
  const values = OperatorFilters.valuesForRows(rows, key);
  if (descending) values.reverse();
  const count = selected.size;
  return `<details class="operator-filter-menu ${count ? 'has-value' : ''}" data-operator-filter-menu="${key}">
    <summary>${esc(label)}<span data-operator-filter-count="${key}">${count ? ` ${count}` : ''}</span></summary>
    <div class="operator-filter-popover" role="group" aria-label="${esc(label)}">
      ${values.length ? values.map(value => `<label title="${esc(format(value))}"><input type="checkbox" data-operator-filter="${key}" value="${esc(value)}" ${selected.has(value) ? 'checked' : ''}><span>${esc(format(value))}</span></label>`).join('') : '<span class="operator-filter-empty">暂无资料</span>'}
    </div>
  </details>`;
}

function updateOperatorResults(allRows = ownedOperatorRows()) {
  const rows = OperatorFilters.filterRows(allRows, operatorFilters);
  const summary = content.querySelector('[data-operator-result-summary]');
  const list = content.querySelector('[data-operator-list]');
  if (!summary || !list) return;
  summary.textContent = OperatorFilters.hasActive(operatorFilters)
    ? `已持有 ${allRows.length} · 当前显示 ${rows.length}`
    : `已持有 ${allRows.length}`;
  list.innerHTML = rows.length ? operatorRowsHtml(rows) : '<div class="empty"><div><h2>当前搜索和筛选下没有干员</h2><p>调整条件或清除筛选后再试。</p></div></div>';
  bindImageFallbacks(list);
}

function operatorRowsHtml(rows) {
  const available = new Map(currentMasteryCandidates().map(candidate => [
    `${candidate.operator.operatorId}\u0000${candidate.skill.skillId}`,
    candidate,
  ]));
  return rows.map(({ owned, definition }) => `<article class="operator-row">
    <img class="operator-avatar" src="${avatar(definition.operatorId)}" alt="${esc(definition.name)}头像" data-img-fallback>
    <div><h3>${esc(definition.name)}</h3><div class="operator-meta">${definition.rarity}★ · ${esc(definition.profession)}<br>精英 ${owned.elitePhase} · Lv.${owned.level} · 技能 Rank ${owned.skillLevel}</div></div>
    <div class="operator-skills" aria-label="${esc(definition.name)}技能专精状态">${[...definition.skills].sort((a, b) => a.index - b.index).map(skill => {
      const ownedSkill = owned.skills.find(item => item.skillId === skill.skillId);
      const candidate = available.get(`${definition.operatorId}\u0000${skill.skillId}`);
      const masteryLevel = ownedSkill?.masteryLevel ?? 0;
      const status = candidate ? `当前可升级到 M${candidate.to}` : masteryLevel === 3 ? '已完成专精' : '当前不可升级';
      return `<div class="operator-skill ${candidate ? 'can-upgrade' : ''}" data-operator-skill="${esc(`${definition.operatorId}:${skill.skillId}`)}" title="${esc(`第${skill.index}技能 · ${skill.name} · M${masteryLevel} · ${status}`)}" aria-label="${esc(`${skill.name}，当前 M${masteryLevel}，${status}`)}">
        <img src="${skillIcon(skill.skillId)}" alt="${esc(skill.name)}技能图标" data-img-fallback="skill">
        <span class="operator-skill-mastery">M${masteryLevel}</span>
      </div>`;
    }).join('')}</div>
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
  content.querySelectorAll('[data-operator-filter]').forEach(input => input.addEventListener('change', event => {
    const selected = operatorFilters.selected[event.target.dataset.operatorFilter];
    event.target.checked ? selected.add(event.target.value) : selected.delete(event.target.value);
    updateOperatorResults(rows);
    updateOperatorFilterControls();
  }));
  content.querySelector('[data-operator-more]').addEventListener('click', () => {
    operatorFilters.moreExpanded = !operatorFilters.moreExpanded;
    const panel = content.querySelector('[data-operator-more-panel]');
    panel.hidden = !operatorFilters.moreExpanded;
    updateOperatorFilterControls();
  });
  content.querySelector('[data-operator-reset]').addEventListener('click', () => {
    OperatorFilters.reset(operatorFilters);
    operatorFilters.moreExpanded = false;
    search.value = '';
    content.querySelectorAll('[data-operator-filter]').forEach(input => { input.checked = false; });
    content.querySelector('[data-operator-more-panel]').hidden = true;
    updateOperatorResults(rows);
    updateOperatorFilterControls();
    search.focus();
  });
}

function updateOperatorFilterControls() {
  for (const key of OperatorFilters.DIMENSIONS) {
    const count = operatorFilters.selected[key].size;
    const menu = content.querySelector(`[data-operator-filter-menu="${key}"]`);
    const counter = content.querySelector(`[data-operator-filter-count="${key}"]`);
    menu?.classList.toggle('has-value', Boolean(count));
    if (counter) counter.textContent = count ? ` ${count}` : '';
  }
  const active = OperatorFilters.hasActive(operatorFilters);
  const reset = content.querySelector('[data-operator-reset]');
  if (reset) reset.disabled = !active;
  const more = content.querySelector('[data-operator-more]');
  if (more) {
    more.setAttribute('aria-expanded', String(operatorFilters.moreExpanded));
    more.innerHTML = `更多筛选 <span aria-hidden="true">${operatorFilters.moreExpanded ? '▲' : '▼'}</span>`;
  }
}

function renderInventory() {
  if (!state.account) return renderDashboard();
  const query = inventorySearch;
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const unlimitedEligible = new Set(state.unlimitedEligibleItemIds);
  const blueUnlimitedCount = state.settings.unlimitedItemIds.filter(id => unlimitedEligible.has(id)).length;
  const rows = state.gameData.materials
    .filter(item => inventoryMaterialIds.has(item.itemId))
    .filter(item => !query || item.name.includes(query))
    .sort((a, b) => {
      return (unlimitedPriority.get(a.itemId) ?? Infinity)
        - (unlimitedPriority.get(b.itemId) ?? Infinity)
        || a.name.localeCompare(b.name, 'zh-CN');
    });
  content.innerHTML = `${banners()}<div class="filters" style="grid-template-columns:minmax(240px,1fr) auto">
    <input data-inventory-search value="${esc(query)}" placeholder="搜索材料">
    <span class="badge blue">已设无限 ${blueUnlimitedCount} 项蓝色材料</span>
  </div><div class="table-wrap"><table><thead><tr><th>材料</th><th>等级</th><th>实际数量</th><th>规划状态</th><th>无限供应</th><th></th></tr></thead><tbody>
    ${inventoryRowsHtml(rows, unlimited, unlimitedEligible)}
    </tbody></table></div>`;
  bindActions();
}

function inventoryRowsHtml(rows, unlimited, unlimitedEligible) {
  return rows.map(item => `<tr><td><div class="material-cell"><img class="item-icon" src="${itemIcon(item.itemId)}" alt="" data-img-fallback><strong>${esc(item.name)}</strong></div></td><td>${item.rarity}</td><td>${state.account.inventory[item.itemId] ?? 0}</td><td class="${unlimited.has(item.itemId) ? 'infinity' : ''}">${unlimited.has(item.itemId) ? '∞' : state.account.inventory[item.itemId] ?? 0}</td><td>${unlimitedEligible.has(item.itemId) ? `<label class="switch"><input type="checkbox" data-unlimited="${esc(item.itemId)}" ${unlimited.has(item.itemId) ? 'checked' : ''}><span></span></label>` : '<span class="operator-meta">—</span>'}</td><td><button class="link-button" data-material="${esc(item.itemId)}">查看配方</button></td></tr>`).join('');
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
  content.innerHTML = `${banners()}<div class="settings-grid">
    <section class="setting-card"><div><h3>森空岛账号</h3><p>${state.loggedIn ? `已连接${state.account ? ` · UID ${esc(state.account.uid)}` : ''}` : '未连接。凭据使用 Windows DPAPI 加密保存。'}</p></div><div>${state.loggedIn ? '<button class="secondary" data-action="login">重新认证</button> <button class="danger" data-action="logout">退出 / 删除认证</button>' : '<button class="primary" data-action="login">扫码连接</button>'}</div></section>
    <section class="setting-card"><div><h3>游戏数据</h3><p>最后更新：${esc(fmtTime(state.gameData.updatedAt))}<br>版本：${esc(state.gameData.version)}</p></div><button class="secondary" data-action="update-game">检查并更新</button></section>
    <section class="setting-card"><div><h3>连续专精排序</h3><p>严格使用指定的六档顺序或完全倒序。</p></div><div class="radio-stack"><label><input type="radio" name="sort" value="forward" ${state.settings.continuousSort === 'forward' ? 'checked' : ''}> 连续跨度优先</label><label><input type="radio" name="sort" value="reverse" ${state.settings.continuousSort === 'reverse' ? 'checked' : ''}> 完全反向</label></div></section>
    <section class="setting-card"><div><h3>应用更新</h3><p>当前版本 v${esc(updateState.currentVersion)}<br><span class="update-message ${updateState.phase === 'error' ? 'error' : ''}">${esc(updateState.message)}</span></p>${updateState.phase === 'downloading' ? `<div class="update-progress"><span style="width:${Math.max(0, Math.min(100, updateState.progress || 0))}%"></span></div>` : ''}</div><div>${updateActions[updateState.phase] || updateActions.idle}</div></section>
    <section class="setting-card"><div><h3>启动时自动刷新</h3><p>先显示缓存结果，再在后台同步森空岛。</p></div><label class="switch"><input type="checkbox" data-auto-refresh ${state.settings.autoRefresh ? 'checked' : ''}><span></span></label></section>
    <section class="setting-card"><div><h3>缓存</h3><p>清除最近一次账号快照；不会删除登录凭据或内置游戏数据。</p></div><button class="danger" data-action="clear-cache">清理账号缓存</button></section>
  </div>`;
  bindActions();
}

function bindActions() {
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
    const rows = content.querySelector('tbody');
    if (!rows) return;
    const unlimited = new Set(state.settings.unlimitedItemIds);
    const unlimitedEligible = new Set(state.unlimitedEligibleItemIds);
    const materials = state.gameData.materials
      .filter(item => inventoryMaterialIds.has(item.itemId))
      .filter(item => !inventorySearch || item.name.includes(inventorySearch))
      .sort((a, b) => (unlimitedPriority.get(a.itemId) ?? Infinity)
        - (unlimitedPriority.get(b.itemId) ?? Infinity)
        || a.name.localeCompare(b.name, 'zh-CN'));
    rows.innerHTML = inventoryRowsHtml(materials, unlimited, unlimitedEligible);
    bindInventoryRowActions(rows);
    bindImageFallbacks(rows);
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
  bindInventoryRowActions();
  document.querySelector('[data-unlimited-summaries]')?.addEventListener('change', async event => {
    const ids = new Set(state.settings.unlimitedItemIds);
    for (const id of state.skillSummaryItemIds) event.target.checked ? ids.add(id) : ids.delete(id);
    state = await api.updateSettings({ unlimitedItemIds: [...ids] });
    render();
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
  document.querySelectorAll('input[name="sort"]').forEach(input => input.addEventListener('change', async () => { state = await api.updateSettings({ continuousSort: input.value }); render(); }));
  document.querySelector('[data-auto-refresh]')?.addEventListener('change', async event => { state = await api.updateSettings({ autoRefresh: event.target.checked }); render(); });
  bindImageFallbacks();
}

function bindInventoryRowActions(root = document) {
  root.querySelectorAll('[data-material]:not([data-material-bound])').forEach(button => {
    button.dataset.materialBound = 'true';
    button.addEventListener('click', () => showMaterial(button.dataset.material));
  });
  root.querySelectorAll('[data-unlimited]:not([data-unlimited-bound])').forEach(input => {
    input.dataset.unlimitedBound = 'true';
    input.addEventListener('change', async () => {
      const ids = new Set(state.settings.unlimitedItemIds);
      input.checked ? ids.add(input.dataset.unlimited) : ids.delete(input.dataset.unlimited);
      state = await api.updateSettings({ unlimitedItemIds: [...ids] });
      render();
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

function craftTree(step, materials) {
  if (!step.batches && !step.unlimitedRoots.length) return '';
  if (step.unlimitedRoots.length && !step.batches) return `<div class="craft-tree">${esc(materials.get(step.itemId)?.name || step.itemId)} 由无限供应链满足</div>`;
  return `<div class="craft-tree">加工 ${esc(materials.get(step.itemId)?.name || step.itemId)}：${step.batches} 次，产出 ${step.crafted}${step.children.map(child => `<div>${esc(materials.get(child.itemId)?.name || child.itemId)} ×${child.requested}${craftTree(child, materials)}</div>`).join('')}</div>`;
}

async function showMaterial(itemId) {
  try {
    const detail = await api.materialDetail(itemId);
    const materials = materialMap();
    showModal(`<h2>${esc(detail.material.name)}</h2><p>实际拥有：<strong>${detail.realQuantity}</strong> · 规划状态：<strong class="${detail.planningAvailable === '∞' ? 'infinity' : ''}">${detail.planningAvailable}</strong></p>
      <section class="stage-block"><h3>加工配方</h3>${detail.material.recipe ? detail.material.recipe.ingredients.map(x => `<div class="material-line"><span>${esc(materials.get(x.itemId)?.name || x.itemId)}</span><strong>×${x.quantity}</strong><span></span></div>`).join('') + `<p>每次确定产出：${detail.material.recipe.outputQuantity} · 当前还可加工：${detail.craftable}</p>` : '<p class="operator-meta">该材料没有确定性加工配方。</p>'}</section>
      <section class="stage-block"><h3>参与的上级材料</h3>${detail.parents.length ? detail.parents.map(x => `<span class="badge muted" style="margin:4px">${esc(x.name)}</span>`).join('') : '<p class="operator-meta">当前数据中没有上级配方。</p>'}</section>`);
  } catch (error) { showToast(error.message || String(error)); }
}

function showModal(html) { modalContent.innerHTML = html; modal.classList.remove('hidden'); }

document.querySelectorAll('.nav').forEach(button => button.addEventListener('click', () => { page = button.dataset.page; render(); }));
document.querySelector('#refresh-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  try { setBusy(button, true, '同步中…'); state = await api.refreshAccount(); showToast('账号数据已刷新'); render(); }
  catch (error) { showToast(error.message || String(error)); state = await api.getState(); render(); }
  finally { setBusy(button, false); }
});
document.querySelectorAll('[data-close-modal]').forEach(x => x.addEventListener('click', () => modal.classList.add('hidden')));
api.onStateChanged(loadState);
api.onUpdateStateChanged(next => { updateState = next; if (page === 'settings') renderSettings(); });
loadState().catch(error => { content.innerHTML = `<div class="error-banner">应用初始化失败：${esc(error.message || error)}</div>`; });
