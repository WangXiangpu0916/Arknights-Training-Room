import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const developmentElectron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const executable = process.env.ATR_QA_EXECUTABLE || developmentElectron;
const chromiumFlags = (process.env.ATR_QA_CHROMIUM_FLAGS ?? '').split(',').map(flag => flag.trim()).filter(Boolean);
const launchArguments = [...chromiumFlags, `--remote-debugging-port=${port}`];
if (!process.env.ATR_QA_EXECUTABLE) launchArguments.push('.');
const runtime = await mkdtemp(path.join(tmpdir(), 'atr-electron-qa-'));
const windowPolicyPath = path.join(runtime, 'window-policy.json');
const output = path.join(root, 'output', 'playwright');
await mkdir(output, { recursive: true });
await cp(path.join(root, 'qa-fixture', 'settings.json'), path.join(runtime, 'settings.json'));

const account = JSON.parse(await readFile(path.join(root, 'qa-fixture', 'account-cache.json'), 'utf8'));
const cultivate = JSON.parse(await readFile(path.join(root, 'resources', 'game-data', 'cultivate.json'), 'utf8'));
for (const operatorId of ['002_amiya', '4132_ascln', '180_amgoat', '485_pallas', '346_aosta', '159_peacok', '4198_christ']) {
  if (account.operators.some(operator => operator.operatorId === operatorId)) continue;
  account.operators.push({
    operatorId,
    level: 90,
    elitePhase: 2,
    skillLevel: 7,
    skills: (cultivate[operatorId]?.skills?.elite ?? []).map(skill => ({ skillId: skill.name, masteryLevel: 0 })),
  });
}
for (const itemId of Object.keys(JSON.parse(await readFile(path.join(root, 'resources', 'game-data', 'item.json'), 'utf8')))) {
  account.inventory[itemId] = 999;
}
const progression = JSON.parse(await readFile(path.join(root, 'resources', 'game-data', 'progression.json'), 'utf8'));
for (const itemId of Object.keys(progression.expItems)) account.inventory[itemId] = 999;
account.inventory['4001'] = 99_999_999;
const promotionFixture = account.operators.find(operator => operator.operatorId === '002_amiya');
if (promotionFixture) {
  promotionFixture.elitePhase = 0;
  promotionFixture.level = 50;
}
await writeFile(path.join(runtime, 'account-cache.json'), `${JSON.stringify(account, null, 2)}\n`, 'utf8');

const env = {
  ...process.env,
  ATR_USER_DATA: runtime,
  ATR_WINDOW_POLICY_REPORT: windowPolicyPath,
};
if (!process.env.ATR_QA_SCREENSHOTS) env.ATR_QA_HIDDEN = '1';
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, launchArguments, {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let childOutput = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', chunk => { childOutput = `${childOutput}${chunk}`.slice(-8000); });
}

let socket;
let id = 0;
const pending = new Map();
const protocolDiagnostics = [];

function send(method, params = {}) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(`Electron DevTools socket is not open while sending ${method}`));
  }
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Electron DevTools command timed out: ${method}`));
    }, method === 'Page.captureScreenshot' ? 60_000 : 15_000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(expression, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const pageDiagnostic = await evaluate(`(() => ({
    title: document.querySelector('#page-title')?.textContent,
    content: document.querySelector('#content')?.innerText?.slice(0, 1200),
    body: document.body?.innerText?.slice(0, 1200),
  }))()`).catch(error => ({ diagnosticError: error.message }));
  throw new Error([message, JSON.stringify(pageDiagnostic), ...protocolDiagnostics, childOutput].filter(Boolean).join('\n'));
}

async function captureScreen(name) {
  if (process.env.ATR_QA_SKIP_SCREENSHOTS === '1') return;
  await new Promise(resolve => setTimeout(resolve, 120));
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(path.join(output, name), Buffer.from(screenshot.data, 'base64'));
}

async function setSearch(value) {
  await evaluate(`(() => { const input = document.querySelector('[data-operator-search]'); input.focus(); input.select(); window.__qaSearch = input; })()`);
  await send('Input.insertText', { text: value });
  await new Promise(resolve => setTimeout(resolve, 30));
  return evaluate(`(() => ({
    value: document.querySelector('[data-operator-search]').value,
    focused: document.activeElement === window.__qaSearch,
    stable: document.querySelector('[data-operator-search]') === window.__qaSearch,
    names: [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent),
  }))()`);
}

async function typeCharacters(value) {
  for (const character of value) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
  }
  await new Promise(resolve => setTimeout(resolve, 30));
}

try {
  let target;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Electron exited before QA connected (code ${child.exitCode})\n${childOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = response.ok ? await response.json() : [];
      target = targets.find(item => item.type === 'page' && item.url.includes('renderer/index.html'));
      if (target) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) throw new Error('Electron DevTools target did not become available');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      protocolDiagnostics.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      protocolDiagnostics.push(message.params.args.map(argument => argument.value ?? argument.description).join(' '));
    }
    if (!message.id || !pending.has(message.id)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    const error = new Error(`Electron DevTools socket closed during QA\n${childOutput}`);
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(`Boolean(document.querySelector('.nav[data-page="operators"]')
    && document.querySelector('#sidebar-status strong')
    && !document.querySelector('#content .loading'))`, 'Application did not finish loading');
  await waitFor(`document.querySelector('#data-notice-region.show [data-close-cache-notice]')`, 'Cache notification did not appear');
  const cacheNotice = await evaluate(`(() => {
    const controls = document.querySelector('.dashboard-layout').getBoundingClientRect();
    const region = document.querySelector('#data-notice-region');
    const style = getComputedStyle(region);
    return { beforeTop: controls.top, fixed: style.position === 'fixed', zIndex: Number(style.zIndex), outsideContent: !document.querySelector('#content').contains(region) };
  })()`);
  await evaluate(`document.querySelector('[data-close-cache-notice]').click()`);
  await waitFor(`!document.querySelector('#data-notice-region.show')`, 'Cache notification did not close manually');
  cacheNotice.afterManualTop = await evaluate(`document.querySelector('.dashboard-layout').getBoundingClientRect().top`);
  await evaluate(`(() => { dismissedCacheNoticeKey = ''; activeCacheNoticeKey = ''; renderDataNotice(); })()`);
  await waitFor(`document.querySelector('#data-notice-region.show')`, 'Cache notification did not reopen for auto-dismiss QA');
  await new Promise(resolve => setTimeout(resolve, 5200));
  cacheNotice.autoDismissed = await evaluate(`!document.querySelector('#data-notice-region.show') && cacheNoticeTimer === null`);
  cacheNotice.afterAutoTop = await evaluate(`document.querySelector('.dashboard-layout').getBoundingClientRect().top`);
  await evaluate(`document.querySelector('.nav[data-page="operators"]').click()`);
  await waitFor(`Boolean(document.querySelector('[data-operator-search]'))`, 'Operators page did not render');
  const masteryBadgeLayout = await evaluate(`(() => {
    const skill = document.querySelector('.operator-skill');
    const icon = skill?.querySelector('.operator-skill-icon');
    const wrap = skill?.querySelector('.mastery-badge');
    const badge = skill?.querySelector('.mastery-badge img');
    if (!skill || !icon || !wrap || !badge) return { valid: false };
    const ir = icon.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const br = badge.getBoundingClientRect();
    const sr = skill.getBoundingClientRect();
    const wrapStyle = getComputedStyle(wrap);
    const ratio = wr.width / ir.width;
    return {
      valid: Math.abs(wr.width - 26) < 0.5 && Math.abs(wr.height - 24) < 0.5
        && Math.abs(br.width - 22) < 0.5 && Math.abs(br.height - 20) < 0.5
        && Math.abs(br.left - wr.left - 2) < 0.5 && Math.abs(br.top - wr.top - 2) < 0.5
        && wrapStyle.backgroundColor === 'rgb(31, 26, 28)'
        && ratio >= 0.34 && ratio <= 0.44,
      icon: { w: ir.width, h: ir.height },
      wrap: { w: wr.width, h: wr.height, left: wr.left - sr.left, top: wr.top - sr.top, bg: wrapStyle.backgroundColor },
      badge: { w: br.width, h: br.height },
      ratio,
    };
  })()`);
  console.log('QA phase: operators page ready');

  await evaluate(`(() => { const input = document.querySelector('[data-operator-search]'); input.focus(); window.__qaSearch = input; })()`);
  await typeCharacters('abcdefghijkl');
  const continuousInput = await evaluate(`(() => ({
    value: document.querySelector('[data-operator-search]').value,
    focused: document.activeElement === window.__qaSearch,
    stable: document.querySelector('[data-operator-search]') === window.__qaSearch,
  }))()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  const afterBackspace = await evaluate(`document.querySelector('[data-operator-search]').value`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await typeCharacters('Z');
  const afterMiddleEdit = await evaluate(`document.querySelector('[data-operator-search]').value`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
  await send('Input.insertText', { text: '阿米娅' });
  const afterPaste = await evaluate(`document.querySelector('[data-operator-search]').value`);
  console.log('QA phase: keyboard editing');

  const a = await setSearch('a');
  const upperA = await setSearch('A');
  const as = await setSearch('as');
  const asi = await setSearch('asi');
  const ask = await setSearch('ask');
  const askl = await setSearch('askl');
  const chineseAscalon = await setSearch('阿斯卡纶');
  console.log('QA phase: search cases');

  await setSearch('');
  const beforeComposition = await evaluate(`document.querySelectorAll('.operator-row').length`);
  await evaluate(`document.querySelector('[data-operator-search]').focus()`);
  let compositionMethod = 'cdp';
  try {
    await send('Input.imeSetComposition', { text: 'amiya', selectionStart: 5, selectionEnd: 5 });
  } catch {
    compositionMethod = 'dom-fallback';
    await evaluate(`(() => {
      const input = document.querySelector('[data-operator-search]');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      input.value = 'amiya';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'amiya', inputType: 'insertCompositionText', isComposing: true }));
    })()`);
  }
  const duringComposition = await evaluate(`(() => ({
    count: document.querySelectorAll('.operator-row').length,
    focused: document.activeElement.matches('[data-operator-search]'),
  }))()`);
  if (compositionMethod === 'cdp') await send('Input.insertText', { text: '阿米娅' });
  else await evaluate(`(() => {
    const input = document.querySelector('[data-operator-search]');
    input.value = '阿米娅';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '阿米娅' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '阿米娅', inputType: 'insertText' }));
  })()`);
  await new Promise(resolve => setTimeout(resolve, 30));
  const afterComposition = await evaluate(`(() => ({
    value: document.querySelector('[data-operator-search]').value,
    names: [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent),
    focused: document.activeElement.matches('[data-operator-search]'),
  }))()`);
  console.log('QA phase: IME composition');

  await setSearch('a');
  await evaluate(`(() => {
    for (const [key, value] of [['rarity', '6'], ['position', '近战位']]) {
      document.querySelector('[data-operator-filter-option][data-filter-key="' + key + '"][value="' + value + '"]').click();
    }
  })()`);
  const combined = await evaluate(`(() => ({
    names: [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent),
    summary: document.querySelector('[data-operator-result-summary]').textContent,
    focused: document.activeElement.matches('[data-operator-search]'),
    valid: OperatorFilters.filterRows(ownedOperatorRows(), operatorFilters).every(row =>
      row.definition.rarity === 6 && row.definition.position === '近战位' && OperatorFilters.matchesSearch(row.definition, 'a')),
  }))()`);
  await evaluate(`document.querySelector('[data-operator-reset]').click()`);
  const reset = await evaluate(`(() => ({
    value: document.querySelector('[data-operator-search]').value,
    count: document.querySelectorAll('.operator-row').length,
    disabled: document.querySelector('[data-operator-reset]').disabled,
  }))()`);
  console.log('QA phase: combined filters and reset');

  const dimensionChecks = {};
  for (const key of ['profession', 'subProfession', 'rarity', 'position', 'gender', 'obtainMethods', 'organizations', 'birthPlaces', 'races', 'teams', 'birthdayMonth']) {
    dimensionChecks[key] = await evaluate(`(() => {
      const option = document.querySelector('[data-operator-filter-option][data-filter-key="${key}"]');
      option.click();
      const names = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
      const valid = OperatorFilters.filterRows(ownedOperatorRows(), operatorFilters).every(row =>
        OperatorFilters.dimensionValues(row.definition, '${key}').includes(option.value));
      const selected = option.value;
      document.querySelector('[data-operator-filter-action="clear"][data-filter-key="${key}"]').click();
      return { selected, names, valid, restored: document.querySelectorAll('.operator-row').length === ownedOperatorRows().length };
    })()`);
    console.log(`QA phase: dimension ${key}`);
  }

  const multiSelect = await evaluate(`(() => {
    const options = [...document.querySelectorAll('[data-operator-filter-option][data-filter-key="profession"]')].slice(0, 2);
    options.forEach(option => option.click());
    const selected = options.map(option => option.value);
    const valid = OperatorFilters.filterRows(ownedOperatorRows(), operatorFilters).every(row =>
      OperatorFilters.dimensionValues(row.definition, 'profession').some(value => selected.includes(value)));
    const count = document.querySelectorAll('.operator-row').length;
    document.querySelector('[data-operator-filter-action="clear"][data-filter-key="profession"]').click();
    return { selected, count, valid };
  })()`);

  const selectAll = await evaluate(`(() => {
    document.querySelector('[data-operator-filter-action="all"][data-filter-key="rarity"]').click();
    const options = [...document.querySelectorAll('[data-operator-filter-option][data-filter-key="rarity"]')];
    const result = { allActive: options.every(option => option.classList.contains('active')), count: document.querySelectorAll('.operator-row').length };
    document.querySelector('[data-operator-filter-action="clear"][data-filter-key="rarity"]').click();
    return result;
  })()`);

  const otherGender = await evaluate(`(() => {
    const option = document.querySelector('[data-operator-filter-option][data-filter-key="gender"][value="其他"]');
    option.click();
    const names = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
    document.querySelector('[data-operator-filter-action="clear"][data-filter-key="gender"]').click();
    return { exists: Boolean(option), names };
  })()`);
  console.log('QA phase: multi/select-all/other');

  const sortChecks = {};
  for (const mode of ['training-desc', 'implementation-asc', 'implementation-desc', 'name-asc', 'name-desc', 'rarity-asc', 'rarity-desc']) {
    sortChecks[mode] = await evaluate(`(() => {
      document.querySelector('[data-operator-sort="${mode}"]').click();
      const actual = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
      const expected = OperatorFilters.sortRows(ownedOperatorRows(), '${mode}').map(row => row.definition.name);
      return { actual, expected, equal: JSON.stringify(actual) === JSON.stringify(expected) };
    })()`);
    console.log(`QA phase: sort ${mode}`);
  }

  await setSearch('a');
  await evaluate(`document.querySelector('[data-operator-filter-option][data-filter-key="rarity"][value="6"]').click()`);
  const combinedSort = await evaluate(`(() => {
    document.querySelector('[data-operator-sort="implementation-desc"]').click();
    const actual = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
    const expected = OperatorFilters.sortRows(OperatorFilters.filterRows(ownedOperatorRows(), operatorFilters), operatorFilters.sort).map(row => row.definition.name);
    return { actual, expected, equal: JSON.stringify(actual) === JSON.stringify(expected) };
  })()`);
  await evaluate(`document.querySelector('[data-operator-reset]').click()`);
  console.log('QA phase: combined sort');

  const optionCounts = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-operator-filter-group]')].map(group => [group.dataset.operatorFilterGroup, group.querySelectorAll('[data-operator-filter-option]').length]))`);
  const triggerPoint = await evaluate(`(() => { const rect = document.querySelector('[data-operator-filter-region="common"] [data-operator-panel-trigger]').getBoundingClientRect(); return { x: rect.x + 20, y: rect.y + rect.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...triggerPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...triggerPoint });
  await new Promise(resolve => setTimeout(resolve, 30));
  const clickOpened = await evaluate(`!document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]').hidden`);
  const filterPanelOverflow = await evaluate(`(() => { const panel = document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]'); return panel.scrollWidth > panel.clientWidth; })()`);
  const optionPoint = await evaluate(`(() => { const rect = document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-option]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...optionPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...optionPoint });
  const clickStayedOpen = await evaluate(`!document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 50 });
  await new Promise(resolve => setTimeout(resolve, 200));
  const moveAwayStayedOpen = await evaluate(`!document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...triggerPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...triggerPoint });
  await new Promise(resolve => setTimeout(resolve, 30));
  const clickClosed = await evaluate(`document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...triggerPoint });
  await new Promise(resolve => setTimeout(resolve, 200));
  const hoverNoOpen = await evaluate(`document.querySelector('[data-operator-filter-region="common"] [data-operator-filter-panel]').hidden`);
  const moreTriggerPoint = await evaluate(`(() => { const rect = document.querySelector('[data-operator-filter-region="more"] [data-operator-panel-trigger]').getBoundingClientRect(); return { x: rect.x + 20, y: rect.y + rect.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...moreTriggerPoint });
  await new Promise(resolve => setTimeout(resolve, 200));
  const moreHoverNoOpen = await evaluate(`document.querySelector('[data-operator-filter-region="more"] [data-operator-filter-panel]').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...moreTriggerPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...moreTriggerPoint });
  await new Promise(resolve => setTimeout(resolve, 30));
  const moreClickOpened = await evaluate(`!document.querySelector('[data-operator-filter-region="more"] [data-operator-filter-panel]').hidden`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...moreTriggerPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...moreTriggerPoint });
  await new Promise(resolve => setTimeout(resolve, 30));
  const moreClickClosed = await evaluate(`document.querySelector('[data-operator-filter-region="more"] [data-operator-filter-panel]').hidden`);
  await evaluate(`document.querySelector('[data-operator-reset]').click()`);
  console.log('QA phase: filter panel toggle');

  const highlightSync = await evaluate(`(() => {
    const source = new Set(currentMasteryCandidates().map(candidate => candidate.operator.operatorId + ':' + candidate.skill.skillId));
    const highlighted = new Set([...document.querySelectorAll('[data-operator-skill].can-upgrade')].map(node => node.dataset.operatorSkill));
    return { source: source.size, highlighted: highlighted.size, equal: source.size === highlighted.size && [...source].every(key => highlighted.has(key)) };
  })()`);

  const pages = {};
  for (const page of ['dashboard', 'promotion', 'modules', 'statistics', 'operators', 'inventory', 'settings']) {
    await evaluate(`document.querySelector('.nav[data-page="${page}"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 40));
    pages[page] = await evaluate(`(() => ({
      horizontalOverflow: document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth,
      scrollHeight: document.querySelector('main').scrollHeight,
      clientHeight: document.querySelector('main').clientHeight,
      columns: document.querySelector('.cards') ? getComputedStyle(document.querySelector('.cards')).gridTemplateColumns.split(/\\s+/).length : null,
      cardWidth: document.querySelector('.candidate')?.getBoundingClientRect().width ?? null,
      masterySkillGap: (() => {
        const target = document.querySelector('.mastery-line .mastery-icon:last-child')?.getBoundingClientRect();
        const skill = document.querySelector('.skill-info .skill-icon')?.getBoundingClientRect();
        return target && skill ? skill.left - target.right : null;
      })(),
    }))()`);
  }

  await evaluate(`document.querySelector('.nav[data-page="statistics"]').click()`);
  const statisticsVisuals = await evaluate(`(() => {
    const read = () => {
      const lines = [...document.querySelectorAll('.stat-line')];
      const columnAligned = ['.stat-progress', '.stat-count', '.stat-rate'].every(selector => (
        new Set(lines.map(line => Math.round(line.querySelector(selector).getBoundingClientRect().left))).size === 1
      ));
      return {
        scope: statisticsScope,
        rows: document.querySelectorAll('.stat-total').length,
        sections: [...document.querySelectorAll('.statistics-heading h2')].map(node => node.textContent.trim()),
        ownership: document.querySelector('.stat-total .stat-count')?.textContent.trim(),
        totals: [...document.querySelectorAll('.stat-total .stat-count')].map(node => node.textContent.trim()),
        permanentBreakdowns: !document.querySelector('details, summary, .stat-expand')
          && [...document.querySelectorAll('.stat-group')].every(group => group.querySelectorAll('.stat-child').length >= 3),
        progressForEveryLine: document.querySelectorAll('.stat-progress').length === lines.length,
        columnAligned,
        distributionRemoved: !document.querySelector('.elite-distribution')
          && !['当前 E0', '当前 E1', '当前 E2'].some(label => document.body.textContent.includes(label)),
        scopeCompact: document.querySelector('.statistics-scope').getBoundingClientRect().width < 260,
        horizontalOverflow: document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth,
      };
    };
    const all = read();
    document.querySelector('[data-statistics-scope="owned"]').click();
    const owned = read();
    return { all, owned };
  })()`);
  await captureScreen('statistics-owned.png');

  await evaluate(`document.querySelector('.nav[data-page="settings"]').click()`);
  const settingsVisuals = await evaluate(`(() => {
    const titles = [...document.querySelectorAll('.setting-row h3')].map(node => node.textContent.trim());
    return {
      rows: titles.length,
      cardsRemoved: !document.querySelector('.setting-card, .settings-grid'),
      sortRemoved: !document.body.textContent.includes('连续专精排序') && !document.querySelector('input[name="sort"]'),
      updatePenultimate: titles.at(-2) === '应用更新',
      horizontalOverflow: document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth,
    };
  })()`);
  await captureScreen('settings-list.png');

  const plannerVisuals = {};
  await evaluate(`document.querySelector('.nav[data-page="promotion"]').click()`);
  await waitFor(`Boolean(document.querySelector('.promotion-plan-card') && [...document.querySelectorAll('.promotion-plan-card img')].every(image => image.complete && image.naturalWidth > 0))`, 'Promotion planner visuals did not load');
  plannerVisuals.promotionSingle = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.promotion-plan-card')];
    const levelBadges = cards.map(card => card.querySelector('.operator-level-badge'));
    const eliteBottomAligned = cards.every(card => {
      const avatarBottom = card.querySelector('.candidate-avatar').getBoundingClientRect().bottom;
      return [...card.querySelectorAll('.elite-card-transition img')].every(image => Math.abs(image.getBoundingClientRect().bottom - avatarBottom) <= 1);
    });
    const testHost = document.createElement('div');
    testHost.style.cssText = 'position:fixed;left:0;top:0;display:flex;gap:8px;z-index:-1';
    testHost.innerHTML = [[0, 45], [1, 50], [2, 60]].map(([phase, level]) => operatorLevelBadge(level, phase)).join('');
    document.body.append(testHost);
    const levelSamples = [...testHost.querySelectorAll('.operator-level-badge')].map((badge, phase) => {
      const frame = badge.getBoundingClientRect();
      const iconFrame = badge.querySelector('.operator-current-elite').getBoundingClientRect();
      const number = badge.querySelector('strong').getBoundingClientRect();
      const image = badge.querySelector('img');
      const imageRect = image.getBoundingClientRect();
      return {
        value: badge.textContent,
        correctPhase: badge.getAttribute('aria-label').includes('当前精英 ' + phase),
        loaded: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        aspectPreserved: Math.abs(imageRect.width / imageRect.height - image.naturalWidth / image.naturalHeight) < .02,
        contained: imageRect.left >= iconFrame.left && imageRect.right <= iconFrame.right && imageRect.top >= iconFrame.top && imageRect.bottom <= iconFrame.bottom,
        numberBelowIcon: number.top >= iconFrame.bottom,
        frameContained: number.left >= frame.left && number.right <= frame.right && number.bottom <= frame.bottom,
      };
    });
    testHost.remove();
    return {
      cards: cards.length,
      transitions: document.querySelectorAll('.promotion-plan-card .elite-card-transition').length,
      levelBadges: levelBadges.filter(Boolean).length,
      imagesLoaded: [...document.querySelectorAll('.promotion-plan-card img')].every(image => image.complete && image.naturalWidth > 0),
      eliteBottomAligned,
      levelBottomAligned: cards.every(card => Math.abs(card.querySelector('.operator-level-badge').getBoundingClientRect().bottom - card.querySelector('.candidate-avatar').getBoundingClientRect().bottom) <= 1),
      levelSamples,
    };
  })()`);
  await captureScreen('promotion-planner-single.png');
  await evaluate(`document.querySelector('[data-planner-toggle="continuous"][data-planner-kind="promotion"]').click()`);
  await waitFor(`Boolean(document.querySelector('.promotion-plan-card'))`, 'Continuous promotion planner did not render a multi-stage candidate');
  plannerVisuals.promotionContinuous = await evaluate(`(() => ({
    cards: document.querySelectorAll('.promotion-plan-card').length,
    allMultiStage: currentPlanCandidates('promotion').every(candidate => candidate.stages.length >= 2),
  }))()`);
  await captureScreen('promotion-planner-continuous.png');

  await evaluate(`document.querySelector('.nav[data-page="modules"]').click()`);
  await waitFor(`Boolean(document.querySelector('.module-plan-card') && [...document.querySelectorAll('.module-plan-card img')].every(image => image.complete && image.naturalWidth > 0))`, 'Module planner visuals did not load');
  plannerVisuals.moduleSingle = await evaluate(`(() => {
    const typeFrames = [...document.querySelectorAll('.module-plan-card .module-type-icon')];
    const typeImages = typeFrames.map(frame => frame.querySelector('img'));
    const stageFrames = [...document.querySelectorAll('.module-plan-card .module-stage-icon')];
    const stageImages = stageFrames.map(frame => frame.querySelector('img'));
    const transparentSquare = frame => {
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      return Math.abs(rect.width - rect.height) < .1 && style.borderTopWidth === '0px'
        && style.borderRadius === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
    };
    const keepsAspect = image => {
      const rect = image.getBoundingClientRect();
      return Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) < .02;
    };
    const stageTransparent = stageFrames.every(frame => {
      const style = getComputedStyle(frame);
      return style.borderTopWidth === '0px' && style.borderRadius === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
    });
    const originalTheme = document.documentElement.dataset.theme;
    const themeState = theme => {
      document.documentElement.dataset.theme = theme;
      const typeImage = getComputedStyle(typeImages[0]);
      const stageImage = getComputedStyle(stageImages[0]);
      const code = getComputedStyle(document.querySelector('.module-type-code'));
      const name = getComputedStyle(document.querySelector('.module-name small'));
      const textColor = getComputedStyle(document.body).color;
      return {
        typeFilter: typeImage.filter,
        stageFilter: stageImage.filter,
        codeUsesText: code.color === textColor,
        nameUsesText: name.color === textColor,
      };
    };
    const light = themeState('light');
    const dark = themeState('dark');
    const black = themeState('black');
    document.documentElement.dataset.theme = originalTheme;
    return {
      cards: document.querySelectorAll('.module-plan-card').length,
      noteRemoved: !document.querySelector('#content').innerText.includes('模组开启仍需在游戏内完成对应任务；此处核对精英/等级门槛、现有模组等级与材料。'),
      typeImagesLoaded: typeImages.every(image => image.complete && image.naturalWidth > 0),
      stageImagesLoaded: stageImages.every(image => image.complete && image.naturalWidth > 0),
      codesUppercase: [...document.querySelectorAll('.module-plan-card .module-type-code')].every(node => /^[A-Z]+-[A-Z]$/.test(node.textContent)),
      typeFramesSquare: typeFrames.every(transparentSquare),
      typeAspectPreserved: typeImages.every(keepsAspect),
      stageTransparent,
      stageAspectPreserved: stageImages.every(keepsAspect),
      themes: { light, dark, black },
    };
  })()`);
  await captureScreen('module-planner-single.png');
  await evaluate(`document.querySelector('[data-planner-toggle="continuous"][data-planner-kind="module"]').click()`);
  await waitFor(`Boolean(document.querySelector('.module-plan-card'))`, 'Continuous module planner did not render a multi-stage candidate');
  plannerVisuals.moduleContinuous = await evaluate(`(() => ({
    cards: document.querySelectorAll('.module-plan-card').length,
    allMultiStage: currentPlanCandidates('module').every(candidate => candidate.stages.length >= 2),
    includesSupportedSpan: currentPlanCandidates('module').some(candidate => candidate.to - candidate.from >= 2),
  }))()`);
  await captureScreen('module-planner-continuous.png');
  await evaluate(`document.querySelector('.module-plan-card').click()`);
  await waitFor(`!document.querySelector('#modal').classList.contains('hidden') && Boolean(document.querySelector('#modal .module-modal-heading'))`, 'Module detail modal did not render');
  await waitFor(`[...document.querySelectorAll('#modal .module-modal-heading img')].every(image => image.complete && image.naturalWidth > 0)`, 'Module detail modal images did not load');
  await captureScreen('module-planner-detail.png');
  await evaluate(`document.querySelector('[data-close-modal]').click()`);

  const windowPolicy = JSON.parse(await readFile(windowPolicyPath, 'utf8'));
  console.log('QA phase: page overflow and window policy');

  const failures = [];
  if (!cacheNotice.fixed || cacheNotice.zIndex < 10 || !cacheNotice.outsideContent
    || Math.abs(cacheNotice.beforeTop - cacheNotice.afterManualTop) > .1
    || Math.abs(cacheNotice.beforeTop - cacheNotice.afterAutoTop) > .1 || !cacheNotice.autoDismissed) failures.push('cache notification overlay');
  if (continuousInput.value !== 'abcdefghijkl' || !continuousInput.focused || !continuousInput.stable) failures.push('continuous input');
  if (afterBackspace !== 'abcdefghijk') failures.push('backspace');
  if (afterMiddleEdit !== 'abcdefghijZk') failures.push('middle edit');
  if (afterPaste !== '阿米娅') failures.push('select/paste');
  for (const [label, value] of Object.entries({ a, upperA, as, asi, ask, askl, chineseAscalon })) if (!value.focused || !value.stable) failures.push(`${label} focus`);
  for (const expected of ['阿米娅', '阿斯卡纶', '艾雅法拉']) if (!a.names.includes(expected)) failures.push(`a missing ${expected}`);
  if (JSON.stringify(a.names) !== JSON.stringify(upperA.names)) failures.push('case insensitive');
  for (const value of [as, asi, ask, askl, chineseAscalon]) if (!value.names.includes('阿斯卡纶')) failures.push('Ascalon search');
  for (const excluded of ['缄默德克萨斯', '帕拉斯']) if (as.names.includes(excluded)) failures.push(`middle substring ${excluded}`);
  if (!as.names.includes('奥斯塔')) failures.push('initials prefix Aosta');
  if (duringComposition.count !== beforeComposition || !duringComposition.focused) failures.push('composition interrupted');
  if (!afterComposition.names.includes('阿米娅') || !afterComposition.focused) failures.push('composition commit');
  if (!combined.names.includes('阿斯卡纶') || !combined.valid) failures.push('combined filters');
  if (reset.value || reset.count !== account.operators.length || !reset.disabled) failures.push('reset');
  for (const [key, check] of Object.entries(dimensionChecks)) if (!check.valid || !check.restored || !check.names.length) failures.push(`dimension ${key}`);
  if (!multiSelect.valid || !multiSelect.count) failures.push('same-dimension OR');
  if (!selectAll.allActive || selectAll.count !== account.operators.length) failures.push('select all');
  if (!otherGender.exists || !otherGender.names.includes('断罪者') || !otherGender.names.includes('Miss.Christine')) failures.push('gender other');
  for (const [mode, check] of Object.entries(sortChecks)) if (!check.equal) failures.push(`sort ${mode}`);
  if (!combinedSort.equal) failures.push('combined sort');
  if (!masteryBadgeLayout.valid) failures.push('mastery badge layout');
  if (!highlightSync.equal) failures.push('highlight source mismatch');
  if (Object.values(pages).some(page => page.horizontalOverflow)) failures.push('horizontal overflow');
  if (statisticsVisuals.all.scope !== 'all' || statisticsVisuals.owned.scope !== 'owned'
    || statisticsVisuals.all.rows !== 6 || statisticsVisuals.owned.rows !== 6
    || statisticsVisuals.all.sections.join('|') !== '干员持有|技能专精|模组|精英化'
    || statisticsVisuals.all.ownership !== statisticsVisuals.owned.ownership
    || statisticsVisuals.owned.totals.some((value, index) => Number(value.split('/')[1]) > Number(statisticsVisuals.all.totals[index].split('/')[1]))
    || !statisticsVisuals.all.distributionRemoved || !statisticsVisuals.owned.distributionRemoved
    || !statisticsVisuals.all.scopeCompact || !statisticsVisuals.owned.scopeCompact
    || !statisticsVisuals.all.permanentBreakdowns || !statisticsVisuals.owned.permanentBreakdowns
    || !statisticsVisuals.all.progressForEveryLine || !statisticsVisuals.owned.progressForEveryLine
    || !statisticsVisuals.all.columnAligned || !statisticsVisuals.owned.columnAligned
    || statisticsVisuals.all.horizontalOverflow || statisticsVisuals.owned.horizontalOverflow) failures.push('statistics visuals');
  if (settingsVisuals.rows !== 6 || !settingsVisuals.cardsRemoved || !settingsVisuals.sortRemoved
    || !settingsVisuals.updatePenultimate || settingsVisuals.horizontalOverflow) failures.push('settings visuals');
  if (pages.dashboard.columns !== 3) failures.push('dashboard columns');
  if (pages.dashboard.cardWidth < 337 || pages.dashboard.cardWidth > 338 || pages.dashboard.masterySkillGap < 28 || pages.dashboard.masterySkillGap > 40) failures.push('dashboard card geometry');
  if (!pages.promotion.cardWidth || pages.promotion.cardWidth < 337 || pages.promotion.cardWidth > 338) failures.push('promotion card geometry');
  if (!pages.modules.cardWidth || pages.modules.cardWidth < 337 || pages.modules.cardWidth > 338) failures.push('module card geometry');
  if (!plannerVisuals.promotionSingle.cards || plannerVisuals.promotionSingle.levelBadges !== plannerVisuals.promotionSingle.cards
    || !plannerVisuals.promotionSingle.transitions || !plannerVisuals.promotionSingle.imagesLoaded
    || !plannerVisuals.promotionSingle.eliteBottomAligned || !plannerVisuals.promotionSingle.levelBottomAligned
    || plannerVisuals.promotionSingle.levelSamples.some(sample => !sample.loaded || !sample.correctPhase || !sample.aspectPreserved || !sample.contained || !sample.numberBelowIcon || !sample.frameContained)) failures.push('promotion planner visuals');
  if (!plannerVisuals.promotionContinuous.cards || !plannerVisuals.promotionContinuous.allMultiStage) failures.push('promotion continuous visuals');
  if (!plannerVisuals.moduleSingle.cards || !plannerVisuals.moduleSingle.noteRemoved || !plannerVisuals.moduleSingle.typeImagesLoaded
    || !plannerVisuals.moduleSingle.stageImagesLoaded || !plannerVisuals.moduleSingle.codesUppercase
    || !plannerVisuals.moduleSingle.typeFramesSquare || !plannerVisuals.moduleSingle.typeAspectPreserved
    || !plannerVisuals.moduleSingle.stageTransparent || !plannerVisuals.moduleSingle.stageAspectPreserved
    || plannerVisuals.moduleSingle.themes.light.typeFilter === 'none'
    || plannerVisuals.moduleSingle.themes.light.stageFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.dark.typeFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.dark.stageFilter === 'none'
    || plannerVisuals.moduleSingle.themes.black.typeFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.black.stageFilter === 'none'
    || !plannerVisuals.moduleSingle.themes.light.codeUsesText || !plannerVisuals.moduleSingle.themes.light.nameUsesText
    || !plannerVisuals.moduleSingle.themes.dark.codeUsesText || !plannerVisuals.moduleSingle.themes.dark.nameUsesText
    || !plannerVisuals.moduleSingle.themes.black.codeUsesText || !plannerVisuals.moduleSingle.themes.black.nameUsesText) failures.push('module planner visuals');
  if (!plannerVisuals.moduleContinuous.cards || !plannerVisuals.moduleContinuous.allMultiStage || !plannerVisuals.moduleContinuous.includesSupportedSpan) failures.push('module continuous visuals');
  if (windowPolicy.bounds.width !== 1360 || windowPolicy.bounds.height !== 800
    || windowPolicy.minimumSize.join('x') !== '1360x800'
    || windowPolicy.maximumSize.join('x') !== '1360x800'
    || windowPolicy.resizable || windowPolicy.maximizable || windowPolicy.fullscreenable
    || !windowPolicy.minimizable || !windowPolicy.movable || !windowPolicy.closable) failures.push('window policy');

  const report = {
    pass: failures.length === 0,
    failures,
    window: windowPolicy,
    continuousInput,
    keyboard: { afterBackspace, afterMiddleEdit, afterPaste },
    pinyin: { a: a.names, as: as.names, asi: asi.names, ask: ask.names, askl: askl.names, chineseAscalon: chineseAscalon.names, uppercaseEqual: JSON.stringify(a.names) === JSON.stringify(upperA.names) },
    ime: { method: compositionMethod, beforeComposition, duringComposition, afterComposition },
    combined,
    reset,
    dimensionChecks,
    multiSelect,
    selectAll,
    otherGender,
    sortChecks,
    combinedSort,
    masteryBadgeLayout,
    filterPanelToggle: { opened: clickOpened, stayedOpen: clickStayedOpen, moveAwayStayedOpen, closed: clickClosed, hoverNoOpen, moreHoverNoOpen, moreOpened: moreClickOpened, moreClosed: moreClickClosed, horizontalOverflow: filterPanelOverflow },
    optionCounts,
    highlightSync,
    pages,
    plannerVisuals,
  };
  await writeFile(path.join(output, 'operators-search-filter-qa.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  try { socket?.close(); } catch {}
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 2500);
  });
  await rm(runtime, { recursive: true, force: true }).catch(() => undefined);
}
