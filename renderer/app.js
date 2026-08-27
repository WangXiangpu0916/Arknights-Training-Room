const api = window.trainingRoom;
const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
let state;
let page = 'dashboard';
let mode = 'single';
let filters = { search: '', profession: '', rarity: '', skill: '', mastery: '', unlimited: '' };

const professions = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const unlimitedPriority = new Map(['30103', '30093', '30083', '30073'].map((id, index) => [id, index]));
const hiddenInventoryMaterials = new Set([
  ...professions.flatMap(profession => [`${profession}芯片`, `${profession}芯片组`, `${profession}双芯片`]),
  '芯片助剂', '模组数据块', '数据增补仪', '数据增补条', '采购凭证',
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
  state = await api.getState();
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
  badge.className = `badge ${state.usingCache ? 'warn' : state.account ? 'ok' : 'muted'}`;
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
  const list = (mode === 'single' ? state.single : state.continuous).filter(candidate => {
    return (!filters.search || `${candidate.operator.name}${candidate.skill.name}`.includes(filters.search))
      && (!filters.profession || candidate.operator.profession === filters.profession)
      && (!filters.rarity || String(candidate.operator.rarity) === filters.rarity)
      && (!filters.skill || String(candidate.skill.index) === filters.skill)
      && (!filters.mastery || String(candidate.from) === filters.mastery)
      && (!filters.unlimited || String(candidate.usesUnlimited) === filters.unlimited);
  });
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const skillSummariesUnlimited = state.skillSummaryItemIds.some(id => unlimited.has(id));
  content.innerHTML = `${banners()}
    <div class="toolbar">
      <div class="segmented"><button data-mode="single" class="${mode === 'single' ? 'active' : ''}">单阶段专精</button><button data-mode="continuous" class="${mode === 'continuous' ? 'active' : ''}">连续专精</button></div>
      ${mode === 'continuous' ? `<span class="badge muted">排序：${state.settings.continuousSort === 'forward' ? '连续跨度优先' : '完全反向'}</span>` : '<span class="badge muted">每个候选独立计算</span>'}
      <label class="dashboard-supply-toggle"><span>技巧概要无限供应</span><span class="switch"><input type="checkbox" data-unlimited-summaries ${skillSummariesUnlimited ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="filters">
      <input data-filter="search" value="${esc(filters.search)}" placeholder="搜索干员或技能">
      ${select('profession', '全部职业', professions.map(name => [name, name]))}
      ${select('rarity', '全部星级', [[6,'六星'],[5,'五星'],[4,'四星'],[3,'三星']])}
      ${select('skill', '全部技能', [[1,'S1'],[2,'S2'],[3,'S3']])}
      ${select('mastery', '全部当前等级', [[0,'M0'],[1,'M1'],[2,'M2']])}
      ${select('unlimited', '无限池不限', [['false','仅真实仓库'],['true','使用无限材料']])}
    </div>
    <div class="result-summary">找到 ${list.length} 个当前可行候选</div>
    ${list.length ? `<div class="cards">${list.map(candidateCard).join('')}</div>` : `<div class="empty"><div><h2>当前筛选下没有可行专精</h2><p>仓库、专精状态或无限供应设置变化后会自动重新计算。</p></div></div>`}`;
  bindActions();
}

function select(name, placeholder, options) {
  return `<select data-filter="${name}"><option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${esc(value)}" ${String(filters[name]) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
}

function candidateCard(candidate, index) {
  return `<article class="candidate">
    <div class="candidate-main">
      <img class="candidate-avatar" src="${avatar(candidate.operator.operatorId)}" alt="${esc(candidate.operator.name)}头像" data-img-fallback>
      <div class="candidate-details">
        <div class="candidate-heading"><h3>${esc(candidate.operator.name)}</h3><button class="link-button" data-candidate="${mode}:${index}" data-key="${esc(candidate.operator.operatorId)}:${esc(candidate.skill.skillId)}">查看材料 →</button></div>
        <div class="candidate-visuals">
          <div class="mastery-line" aria-label="M${candidate.from} 到 M${candidate.to}">
            <img class="mastery-icon" src="${masteryIcon(candidate.from)}" alt="M${candidate.from}">
            <span class="arrow" aria-hidden="true">→</span>
            <img class="mastery-icon" src="${masteryIcon(candidate.to)}" alt="M${candidate.to}">
          </div>
          <div class="skill-info">
            <img class="skill-icon" src="${skillIcon(candidate.skill.skillId)}" alt="${esc(candidate.skill.name)}技能图标" data-img-fallback="skill">
            <div class="skill-copy" title="${esc(candidate.skill.name)}"><strong>${esc(candidate.skill.name)}</strong>${candidate.usesUnlimited ? '<span class="candidate-special">依赖无限材料</span>' : ''}</div>
          </div>
        </div>
      </div>
    </div>
  </article>`;
}

function renderOperators() {
  if (!state.account) return renderDashboard();
  const defs = new Map(state.gameData.operators.map(x => [x.operatorId, x]));
  const query = filters.search;
  const rows = state.account.operators
    .map(owned => ({ owned, definition: defs.get(owned.operatorId) }))
    .filter(x => x.definition && (!query || x.definition.name.includes(query)))
    .sort((a, b) => b.definition.rarity - a.definition.rarity || a.definition.name.localeCompare(b.definition.name, 'zh-CN'));
  const available = [...state.single, ...state.continuous];
  content.innerHTML = `${banners()}<div class="toolbar"><input data-filter="search" value="${esc(query)}" placeholder="搜索已持有干员" style="max-width:360px"><span class="badge muted">已持有 ${rows.length}</span></div>
    <div class="operator-list">${rows.map(({ owned, definition }) => `<article class="operator-row">
      <img class="operator-avatar" src="${avatar(definition.operatorId)}" alt="" data-img-fallback>
      <div><h3>${esc(definition.name)}</h3><div class="operator-meta">${definition.rarity}★ · ${esc(definition.profession)}<br>精英 ${owned.elitePhase} · Lv.${owned.level} · 技能 Rank ${owned.skillLevel}</div></div>
      <div class="skill-pills">${definition.skills.map(skill => {
        const ownedSkill = owned.skills.find(x => x.skillId === skill.skillId);
        const candidate = available.find(x => x.operator.operatorId === definition.operatorId && x.skill.skillId === skill.skillId);
        return `<div class="skill-pill ${candidate ? 'can' : ''}"><strong>S${skill.index} · M${ownedSkill?.masteryLevel ?? 0}</strong><br><span class="${candidate ? 'success' : 'operator-meta'}">${candidate ? `可到 M${candidate.to}` : ownedSkill?.masteryLevel === 3 ? '已完成' : '当前不可完成'}</span></div>`;
      }).join('')}</div>
    </article>`).join('')}</div>`;
  bindActions();
}

function renderInventory() {
  if (!state.account) return renderDashboard();
  const query = filters.search;
  const rarity = filters.rarity;
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const unlimitedEligible = new Set(state.unlimitedEligibleItemIds);
  const blueUnlimitedCount = state.settings.unlimitedItemIds.filter(id => unlimitedEligible.has(id)).length;
  const rows = state.gameData.materials
    .filter(item => !hiddenInventoryMaterials.has(item.name))
    .filter(item => unlimitedEligible.has(item.itemId)
      || Object.prototype.hasOwnProperty.call(state.account.inventory, item.itemId)
      || item.recipe)
    .filter(item => (!query || item.name.includes(query)) && (!rarity || String(item.rarity) === rarity))
    .sort((a, b) => {
      const aEligible = unlimitedEligible.has(a.itemId);
      const bEligible = unlimitedEligible.has(b.itemId);
      if (aEligible !== bEligible) return aEligible ? -1 : 1;
      if (aEligible) return (unlimitedPriority.get(a.itemId) ?? Infinity)
        - (unlimitedPriority.get(b.itemId) ?? Infinity)
        || a.name.localeCompare(b.name, 'zh-CN');
      return b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh-CN');
    });
  content.innerHTML = `${banners()}<div class="filters" style="grid-template-columns:minmax(240px,1fr) 180px auto">
    <input data-filter="search" value="${esc(query)}" placeholder="搜索材料">
    ${select('rarity', '全部材料等级', [[5,'等级 5'],[4,'等级 4'],[3,'等级 3'],[2,'等级 2'],[1,'等级 1']])}
    <span class="badge blue">已设无限 ${blueUnlimitedCount} 项蓝色材料</span>
  </div><div class="table-wrap"><table><thead><tr><th>材料</th><th>等级</th><th>实际数量</th><th>规划状态</th><th>无限供应（仅蓝色）</th><th></th></tr></thead><tbody>
    ${rows.map(item => `<tr><td><div class="material-cell"><img class="item-icon" src="${itemIcon(item.itemId)}" alt="" data-img-fallback><strong>${esc(item.name)}</strong></div></td><td>${item.rarity}</td><td>${state.account.inventory[item.itemId] ?? 0}</td><td class="${unlimited.has(item.itemId) ? 'infinity' : ''}">${unlimited.has(item.itemId) ? '∞' : state.account.inventory[item.itemId] ?? 0}</td><td>${unlimitedEligible.has(item.itemId) ? `<label class="switch"><input type="checkbox" data-unlimited="${esc(item.itemId)}" ${unlimited.has(item.itemId) ? 'checked' : ''}><span></span></label>` : '<span class="operator-meta">—</span>'}</td><td><button class="link-button" data-material="${esc(item.itemId)}">查看配方</button></td></tr>`).join('')}
    </tbody></table></div>`;
  bindActions();
}

function renderSettings() {
  const eligible = new Set(state.unlimitedEligibleItemIds);
  const unlimited = new Set(state.settings.unlimitedItemIds);
  const blueCount = state.settings.unlimitedItemIds.filter(id => eligible.has(id)).length;
  const skillSummariesUnlimited = state.skillSummaryItemIds.some(id => unlimited.has(id));
  content.innerHTML = `${banners()}<div class="settings-grid">
    <section class="setting-card"><div><h3>森空岛账号</h3><p>${state.loggedIn ? `已连接${state.account ? ` · UID ${esc(state.account.uid)}` : ''}` : '未连接。凭据使用 Windows DPAPI 加密保存。'}</p></div><div>${state.loggedIn ? '<button class="secondary" data-action="login">重新认证</button> <button class="danger" data-action="logout">退出 / 删除认证</button>' : '<button class="primary" data-action="login">扫码连接</button>'}</div></section>
    <section class="setting-card"><div><h3>游戏数据</h3><p>最后更新：${esc(fmtTime(state.gameData.updatedAt))}<br>版本：${esc(state.gameData.version)}</p></div><button class="secondary" data-action="update-game">检查并更新</button></section>
    <section class="setting-card"><div><h3>连续专精排序</h3><p>严格使用指定的六档顺序或完全倒序。</p></div><div class="radio-stack"><label><input type="radio" name="sort" value="forward" ${state.settings.continuousSort === 'forward' ? 'checked' : ''}> 连续跨度优先</label><label><input type="radio" name="sort" value="reverse" ${state.settings.continuousSort === 'reverse' ? 'checked' : ''}> 完全反向</label></div></section>
    <section class="setting-card"><div><h3>无限供应材料</h3><p>当前 ${blueCount} 项蓝色材料；技巧概要${skillSummariesUnlimited ? '已开启' : '未开启'}。真实仓库数量不会被覆盖。</p></div><button class="secondary" data-action="manage-unlimited">管理</button></section>
    <section class="setting-card"><div><h3>启动时自动刷新</h3><p>先显示缓存结果，再在后台同步森空岛。</p></div><label class="switch"><input type="checkbox" data-auto-refresh ${state.settings.autoRefresh ? 'checked' : ''}><span></span></label></section>
    <section class="setting-card"><div><h3>缓存</h3><p>清除最近一次账号快照；不会删除登录凭据或内置游戏数据。</p></div><button class="danger" data-action="clear-cache">清理账号缓存</button></section>
  </div>`;
  bindActions();
}

function bindActions() {
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; renderDashboard(); }));
  document.querySelectorAll('[data-filter]').forEach(input => input.addEventListener(input.tagName === 'INPUT' ? 'input' : 'change', event => {
    filters[event.target.dataset.filter] = event.target.value;
    if (page === 'dashboard') renderDashboard();
    if (page === 'operators') renderOperators();
    if (page === 'inventory') renderInventory();
  }));
  document.querySelectorAll('[data-candidate]').forEach(button => button.addEventListener('click', () => {
    const [candidateMode] = button.dataset.candidate.split(':');
    const [operatorId, skillId] = button.dataset.key.split(':');
    const candidate = state[candidateMode].find(x => x.operator.operatorId === operatorId && x.skill.skillId === skillId);
    if (candidate) showCandidate(candidate);
  }));
  document.querySelectorAll('[data-material]').forEach(button => button.addEventListener('click', () => showMaterial(button.dataset.material)));
  document.querySelectorAll('[data-unlimited]').forEach(input => input.addEventListener('change', async () => {
    const ids = new Set(state.settings.unlimitedItemIds);
    input.checked ? ids.add(input.dataset.unlimited) : ids.delete(input.dataset.unlimited);
    state = await api.updateSettings({ unlimitedItemIds: [...ids] });
    render();
  }));
  document.querySelector('[data-unlimited-summaries]')?.addEventListener('change', async event => {
    const ids = new Set(state.settings.unlimitedItemIds);
    for (const id of state.skillSummaryItemIds) event.target.checked ? ids.add(id) : ids.delete(id);
    state = await api.updateSettings({ unlimitedItemIds: [...ids] });
    render();
  });
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
  document.querySelectorAll('input[name="sort"]').forEach(input => input.addEventListener('change', async () => { state = await api.updateSettings({ continuousSort: input.value }); render(); }));
  document.querySelector('[data-auto-refresh]')?.addEventListener('change', async event => { state = await api.updateSettings({ autoRefresh: event.target.checked }); render(); });
  document.querySelectorAll('[data-img-fallback]').forEach(img => img.addEventListener('error', () => {
    if (img.dataset.imgFallback === 'skill') {
      img.src = skillPlaceholder;
      img.classList.add('missing');
      return;
    }
    img.style.visibility = 'hidden';
  }, { once: true }));
}

async function handleAction(action, button) {
  try {
    setBusy(button, true);
    if (action === 'login') await beginLogin();
    if (action === 'logout') state = await api.logout();
    if (action === 'update-game') { state = await api.updateGameData(); showToast('游戏数据已更新'); }
    if (action === 'manage-unlimited') { page = 'inventory'; filters = { ...filters, search: '', rarity: '' }; }
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
loadState().catch(error => { content.innerHTML = `<div class="error-banner">应用初始化失败：${esc(error.message || error)}</div>`; });
