import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MasteryPlanner } from '../dist/tests/native-core.js';

const root = process.cwd();
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const executable = process.env.ATR_QA_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target', 'debug/训练室.exe');
const runtime = await mkdtemp(path.join(tmpdir(), 'atr-desktop-qa-'));
const windowPolicyPath = path.join(runtime, 'window-policy.json');
const output = process.env.ATR_QA_OUTPUT || path.join(root, 'output', 'playwright');
await mkdir(output, { recursive: true });
const settings = JSON.parse(await readFile(path.join(root, 'qa-fixture', 'settings.json'), 'utf8'));
if (['system', 'black', 'light'].includes(process.env.ATR_QA_THEME)) settings.theme = process.env.ATR_QA_THEME;
await writeFile(path.join(runtime, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

const account = JSON.parse(await readFile(path.join(root, 'qa-fixture', 'account-cache.json'), 'utf8'));
account.operators.forEach((operator, index) => {
  if (index % 3) operator.gainTime = 1600000000 + (account.operators.length - index) * 86400;
});
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
  ATR_QA_PORT: String(port),
  ATR_WINDOW_POLICY_REPORT: windowPolicyPath,
};
const screenshotsEnabled = process.env.ATR_QA_SKIP_SCREENSHOTS !== '1';
if (!screenshotsEnabled) env.ATR_QA_HIDDEN = '1';

const launchStarted = performance.now();
const child = spawn(executable, [], {
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
    return Promise.reject(new Error(`WebView2 DevTools socket is not open while sending ${method}`));
  }
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`WebView2 DevTools command timed out: ${method}`));
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
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const pageDiagnostic = await evaluate(`(() => ({
    page: document.querySelector('main')?.dataset.page,
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
    if (child.exitCode !== null) throw new Error(`Native app exited before QA connected (code ${child.exitCode})\n${childOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = response.ok ? await response.json() : [];
      target = targets.find(item => item.type === 'page' && item.url.includes('renderer/index.html'));
      if (target) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) throw new Error(`Desktop DevTools target did not become available\n${childOutput}`);
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
    const error = new Error(`WebView2 DevTools socket closed during QA\n${childOutput}`);
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(`Boolean(document.body && document.styleSheets.length)`, 'Initial themed document did not render');
  const startupTheme = await evaluate(`(() => ({
    saved: ${JSON.stringify(settings.theme ?? 'system')},
    query: new URLSearchParams(location.search).get('theme'),
    applied: document.documentElement.dataset.theme,
    prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }))()`);
  await waitFor(`Boolean(document.querySelector('.nav[data-page="operators"]')
    && document.querySelector('#sidebar-status strong')
    && !document.querySelector('#content .loading'))`, 'Application did not finish loading');
  const startupMs = performance.now() - launchStarted;
  await evaluate(`api.cacheState({...state, startupCacheKey: 'outdated-inputs'})`);
  if (await evaluate(`api.getCachedState()`)) throw Error('Startup cache accepted changed inputs');
  if (!await evaluate(`api.cacheState({...state, revision: 100000, account: {...state.account, nickname: '缓存启动校验'}})`)) throw Error('Startup cache was not persisted');
  const holdStartup = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(window, 'trainingRoom', { configurable: true, set(api) {
      const getState = api.getState;
      const ready = new Promise(resolve => { window.__qaResumeStartup = resolve; });
      api.getState = () => ready.then(() => getState());
      Object.defineProperty(window, 'trainingRoom', {value: api, configurable: true, writable: true});
    }});
  ` });
  await send('Page.reload');
  await waitFor(`typeof state !== 'undefined' && state?.revision === -1 && Boolean(document.querySelector('.candidate'))`, 'Cached home screen did not render while the live request was blocked');
  const startupCache = await evaluate(`(() => {
    const result = {homeReadyMs: performance.now(), cached: state.account.nickname === '缓存启动校验'};
    mode = 'continuous'; render();
    document.querySelector('[data-dashboard-filter="search"]').focus();
    document.querySelector('main').scrollTop = 120;
    result.scrollTop = document.querySelector('main').scrollTop;
    return result;
  })()`);
  await captureScreen('startup-cached.png');
  await evaluate(`window.__qaResumeStartup()`);
  await waitFor(`state.revision >= 0 && !stateLoadPromise`, 'Fresh state did not replace the previous-session revision');
  Object.assign(startupCache, await evaluate(`({
    refreshed: state.account.nickname !== '缓存启动校验',
    modePreserved: mode === 'continuous' && document.querySelector('[data-continuous-mode]').checked,
    focusPreserved: document.activeElement.matches('[data-dashboard-filter="search"]'),
    refreshedScrollTop: document.querySelector('main').scrollTop,
  })`));
  if (!startupCache.cached || !startupCache.refreshed || !startupCache.modePreserved || !startupCache.focusPreserved || startupCache.scrollTop !== startupCache.refreshedScrollTop) throw Error(`Startup cache replacement failed: ${JSON.stringify(startupCache)}`);
  await writeFile(path.join(output, 'startup-cache-qa.json'), JSON.stringify(startupCache, null, 2));
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: holdStartup.identifier });
  await evaluate(`mode='single'; render(); document.querySelector('main').scrollTop=0;`);
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:1, y:1 });
  if (await evaluate(`Boolean(document.querySelector('#data-notice-region, .cache-notice'))`)) throw Error('Unexpected cache notification');
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
  const accountBeforeSort = await evaluate('JSON.stringify(state.account)');
  for (const property of ['training', 'implementation', 'name', 'rarity', 'acquisition', 'skill']) {
    for (const [index, direction] of ['asc', 'desc', 'asc'].entries()) {
      const mode = `${property}-${direction}`;
      sortChecks[`${mode}-${index}`] = await evaluate(`(() => {
        const button = document.querySelector('[data-operator-sort="${property}"]');
        button.click();
        const actual = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
        const expected = OperatorFilters.sortRows(ownedOperatorRows(), '${mode}').map(row => row.definition.name);
        const controls = [...document.querySelectorAll('[data-operator-sort]')];
        const active = controls.filter(b => b.classList.contains('active') && b.getAttribute('aria-pressed') === 'true');
        const valid = operatorFilters.sort === '${mode}' && controls.length === 6
          && new Set(controls.map(b => b.dataset.operatorSort)).size === 6
          && active.length === 1 && active[0] === button
          && button.querySelector('.operator-sort-direction').textContent === '${direction === 'asc' ? '↑' : '↓'}'
          && controls.filter(b => b !== button).every(b => !b.querySelector('.operator-sort-direction').textContent);
        return { actual, expected, equal: valid && JSON.stringify(actual) === JSON.stringify(expected) };
      })()`);
      console.log(`QA phase: sort ${mode}`);
    }
  }
  if (await evaluate('JSON.stringify(state.account)') !== accountBeforeSort) throw Error('Sorting mutated the account snapshot');

  const sortThemeChecks = {};
  for (const [theme, scheme] of [['light', 'light'], ['black', 'dark'], ['system', 'light'], ['system', 'dark']]) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await new Promise(resolve => setTimeout(resolve, 200));
    sortThemeChecks[`${theme}-${scheme}`] = await evaluate(`(() => {
      const active = document.querySelector('.operator-sort-option.active');
      const inactive = document.querySelector('.operator-sort-option:not(.active)');
      return getComputedStyle(active).backgroundColor !== getComputedStyle(inactive).backgroundColor
        && getComputedStyle(active).color !== getComputedStyle(inactive).color
        && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth;
    })()`);
    await captureScreen(`operator-sort-${theme}-${scheme}.png`);
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await evaluate(`document.documentElement.dataset.theme=state.settings.theme`);

  await setSearch('a');
  await evaluate(`document.querySelector('[data-operator-filter-option][data-filter-key="rarity"][value="6"]').click()`);
  const combinedSort = await evaluate(`(() => {
    const checks = [];
    for (const property of ['implementation', 'acquisition', 'skill']) {
      for (const direction of ['asc', 'desc']) {
        document.querySelector('[data-operator-sort="' + property + '"]').click();
        const actual = [...document.querySelectorAll('.operator-row h3')].map(node => node.textContent);
        const expected = OperatorFilters.sortRows(OperatorFilters.filterRows(ownedOperatorRows(), operatorFilters), property + '-' + direction).map(row => row.definition.name);
        checks.push({ property, direction, actual, expected, equal: operatorFilters.sort === property + '-' + direction && JSON.stringify(actual) === JSON.stringify(expected) });
      }
    }
    return { checks, equal: checks.every(check => check.equal) };
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
    if (['dashboard', 'promotion', 'modules'].includes(page)) {
      await waitFor(`Boolean(document.querySelector('.candidate') && [...document.querySelector('.candidate').querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0))`, `${page} first card images did not load before geometry measurement`);
    }
    pages[page] = await evaluate(`(() => ({
      horizontalOverflow: document.querySelector('main').scrollWidth > document.querySelector('main').clientWidth,
      scrollHeight: document.querySelector('main').scrollHeight,
      clientHeight: document.querySelector('main').clientHeight,
      columns: document.querySelector('.cards') ? getComputedStyle(document.querySelector('.cards')).gridTemplateColumns.split(/\\s+/).length : null,
      cardWidth: document.querySelector('.candidate')?.getBoundingClientRect().width ?? null,
      cardHeight: document.querySelector('.candidate')?.getBoundingClientRect().height ?? null,
      avatar: (() => {
        const rect = document.querySelector('.candidate-avatar')?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top } : null;
      })(),
      rightVisual: (() => {
        const node = document.querySelector('.skill-info, .operator-level-badge, .plan-target');
        const rect = node?.getBoundingClientRect();
        const card = document.querySelector('.candidate')?.getBoundingClientRect();
        return rect && card ? { width: rect.width, height: rect.height, rightInset: card.right - rect.right, topInset: rect.top - card.top } : null;
      })(),
      masterySkillGap: (() => {
        const target = document.querySelector('.mastery-line .mastery-icon:last-child')?.getBoundingClientRect();
        const skill = document.querySelector('.skill-info .skill-icon')?.getBoundingClientRect();
        return target && skill ? skill.left - target.right : null;
      })(),
    }))()`);
    if (page === 'dashboard') await captureScreen('mastery-planner-single.png');
    if (page === 'operators') await captureScreen('operators.png');
  }

  await evaluate(`document.querySelector('.nav[data-page="dashboard"]').click()`);
  const masteryRarityGradient = await evaluate(`getComputedStyle(document.querySelector('.candidate.rarity-6')).backgroundImage`);
  await evaluate(`document.querySelector('.nav[data-page="operators"]').click()`);
  const operatorRarityVisuals = await evaluate(`(() => {
    const six = document.querySelector('.operator-row.rarity-6');
    const five = document.querySelector('.operator-row.rarity-5');
    return {
      sixGradient: getComputedStyle(six).backgroundImage,
      sixBorderTransparent: getComputedStyle(six).borderLeftColor === 'rgba(0, 0, 0, 0)',
      fiveBorderVisible: getComputedStyle(five).borderLeftColor !== 'rgba(0, 0, 0, 0)',
      sixStripWidth: getComputedStyle(six).backgroundSize.split(' ')[0],
      stripsAligned: getComputedStyle(six).backgroundOrigin === 'border-box'
        && getComputedStyle(six).backgroundPositionX === '0%'
        && six.getBoundingClientRect().left === five.getBoundingClientRect().left,
    };
  })()`);

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
        progressForEveryLine: lines.every(line => line.querySelector('.stat-progress')),
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
  plannerVisuals.promotionSingle = await evaluate(`(async () => {
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
    await Promise.all([...testHost.querySelectorAll('img')].map(image => image.decode()));
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
        numberBelowIcon: number.top >= iconFrame.bottom - 1,
        frameContained: number.left >= frame.left - 1 && number.right <= frame.right + 1 && number.bottom <= frame.bottom + 1,
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
      const textColor = getComputedStyle(document.body).color;
      return {
        typeFilter: typeImage.filter,
        stageFilter: stageImage.filter,
        codeUsesText: code.color === textColor,
      };
    };
    const light = themeState('light');
    const dark = themeState('dark');
    const black = themeState('black');
    document.documentElement.dataset.theme = originalTheme;
    const masterySample = document.createElement('div');
    masterySample.className = 'skill-copy';
    masterySample.innerHTML = '<strong>足够长的专精技能名称</strong>';
    masterySample.style.position = 'fixed';
    masterySample.style.visibility = 'hidden';
    document.body.append(masterySample);
    const masteryAutoScroll = getComputedStyle(masterySample.firstElementChild).animationName === 'skill-name-scroll';
    masterySample.remove();
    const codeSamples = ['EA-X', 'AMB-X', 'IAC-Y'].map(text => {
      const sample = document.createElement('div');
      sample.className = 'module-target-copy';
      sample.style.cssText = 'position:fixed;visibility:hidden';
      sample.innerHTML = '<strong class="module-type-code">' + text + '</strong>';
      document.body.append(sample);
      const code = sample.firstElementChild;
      const style = getComputedStyle(code);
      const result = {
        text,
        fits: code.scrollWidth <= sample.clientWidth,
        static: style.animationName === 'none' && style.transform === 'none',
        centered: style.textAlign === 'center',
      };
      sample.remove();
      return result;
    });
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
      targetsMatchMastery: [...document.querySelectorAll('.module-plan-card')].every(card => {
        const target = card.querySelector('.plan-target').getBoundingClientRect();
        const icon = card.querySelector('.module-type-icon').getBoundingClientRect();
        return Math.abs(target.width - 56) < .1 && Math.abs(target.height - 72) < .1
          && Math.abs(icon.width - 56) < .1 && Math.abs(icon.height - 56) < .1;
      }),
      copyContained: [...document.querySelectorAll('.module-target-copy')].every(copy => {
        const frame = copy.getBoundingClientRect();
        const target = copy.closest('.plan-target').getBoundingClientRect();
        const style = getComputedStyle(copy);
        return Math.abs(frame.width - 56) < .1 && frame.height <= 17.5 && frame.bottom <= target.bottom + 1
          && style.overflowX === 'hidden' && style.overflowY === 'hidden' && style.whiteSpace === 'nowrap';
      }),
      codeLengths: new Set([...document.querySelectorAll('.module-type-code')].map(code => code.textContent.length)).size,
      codeSamples,
      codesStaticAndCentered: [...document.querySelectorAll('.module-plan-card')].every(card => {
        const icon = card.querySelector('.module-type-icon').getBoundingClientRect();
        const copy = card.querySelector('.module-target-copy').getBoundingClientRect();
        const codeNode = card.querySelector('.module-type-code');
        const code = codeNode.getBoundingClientRect();
        const style = getComputedStyle(codeNode);
        return style.animationName === 'none' && style.transform === 'none'
          && Math.abs((code.left + code.right) / 2 - (icon.left + icon.right) / 2) <= .5
          && Math.abs((copy.left + copy.right) / 2 - (icon.left + icon.right) / 2) <= .5
          && code.left >= copy.left - 1 && code.right <= copy.right + 1
          && copy.top >= icon.bottom - 1 && copy.bottom <= card.querySelector('.module-target').getBoundingClientRect().bottom + 1;
      }),
      masteryAutoScroll,
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
  await waitFor(`!document.querySelector('#modal').classList.contains('hidden') && Boolean(document.querySelector('#modal .plan-detail-heading .module-type-icon'))`, 'Module detail modal did not render');
  await waitFor(`[...document.querySelectorAll('#modal .plan-detail-heading img')].every(image => image.complete && image.naturalWidth > 0)`, 'Module detail modal images did not load');
  await captureScreen('module-planner-detail.png');
  await evaluate(`document.querySelector('[data-close-modal]').click()`);

  const performanceReport = await evaluate(`(async () => {
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const sample = async task => {
      const values = [];
      await task();
      for (let index = 0; index < 7; index += 1) {
        const started = performance.now();
        await task();
        values.push(performance.now() - started);
      }
      return { medianMs: median(values), samples: values };
    };
    const navigate = target => document.querySelector('.nav[data-page="' + target + '"]').click();
    const getState = await sample(() => window.trainingRoom.getState());
    navigate('dashboard');
    const dashboardFilter = await sample(() => {
      const input = document.querySelector('[data-dashboard-filter="search"]');
      input.value = input.value ? '' : '阿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    dashboardFilters.search = '';
    renderDashboard();
    navigate('promotion');
    const promotionFilter = await sample(() => {
      const input = document.querySelector('[data-planner-filter="search"][data-planner-kind="promotion"]');
      input.value = input.value ? '' : '阿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    plannerFilters.promotion.search = '';
    renderPromotionPlanner();
    navigate('modules');
    const moduleFilter = await sample(() => {
      const input = document.querySelector('[data-planner-filter="search"][data-planner-kind="module"]');
      input.value = input.value ? '' : '阿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    plannerFilters.module.search = '';
    renderModulePlanner();
    navigate('operators');
    const operatorFilter = await sample(() => {
      const input = document.querySelector('[data-operator-search]');
      input.value = input.value ? '' : 'a';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    operatorFilters.search = '';
    updateOperatorResults();
    navigate('statistics');
    const statisticsSwitch = await sample(() => {
      const target = statisticsScope === 'all' ? 'owned' : 'all';
      document.querySelector('[data-statistics-scope="' + target + '"]').click();
    });
    statisticsScope = 'all';
    renderStatistics();
    const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
    const navigation = await sample(() => {
      for (const target of ['dashboard', 'promotion', 'modules', 'statistics', 'operators', 'inventory', 'settings']) navigate(target);
    });
    navigate('dashboard');
    const heapAfter = performance.memory?.usedJSHeapSize ?? 0;
    return {
      getState,
      dashboardFilter,
      promotionFilter,
      moduleFilter,
      operatorFilter,
      statisticsSwitch,
      navigation,
      heapBefore,
      heapAfter,
      finalDomNodes: document.querySelectorAll('*').length,
      finalImages: document.images.length,
    };
  })()`);
  performanceReport.startupMs = startupMs;

  console.log('QA phase: mastery exchange checklist and folded recipes');
  await evaluate(`document.querySelector('.nav[data-page="dashboard"]').click()`);
  await evaluate(`document.querySelector('.candidate').click()`);
  const noExchange = await evaluate(`Boolean(document.querySelector('.plan-no-exchange') && !document.querySelector('[data-exchange-item]'))`);
  await captureScreen('mastery-detail-stock.png');
  await evaluate(`document.querySelector('.modal-close').click()`);
  const masteryData = await evaluate('state.gameData');
  const sourceCandidate = await evaluate('state.single[0]');
  const fixtureSkill = { ...sourceCandidate.skill, requirements: {
    1: [{ itemId: '30014', quantity: 2 }, { itemId: '3303', quantity: 2 }, { itemId: '30103', quantity: 1 }],
    2: [{ itemId: '30104', quantity: 2 }, { itemId: '3303', quantity: 2 }, { itemId: '30053', quantity: 1 }],
    3: [{ itemId: '30135', quantity: 1 }, { itemId: '3303', quantity: 2 }, { itemId: '30014', quantity: 1 }],
  } };
  const fixtureOperator = { ...sourceCandidate.operator, skills: [fixtureSkill] };
  const fixtureInventory = { '30014': 1, '30013': 5, '30104': 1, '30084': 1, '30094': 1, '3303': 3 };
  const [exchangeCandidate] = new MasteryPlanner({ ...masteryData, operators: [fixtureOperator] }).continuous([{
    operatorId: fixtureOperator.operatorId, level: 90, elitePhase: 2, skillLevel: 7,
    skills: [{ skillId: fixtureSkill.skillId, masteryLevel: 0 }],
  }], fixtureInventory, ['30013', '30053', '30103', '3303']);
  if (!exchangeCandidate || exchangeCandidate.to !== 3) throw new Error('Mastery exchange QA fixture is not feasible');
  await evaluate(`(() => {
    window.__masteryQaState = state;
    state = { ...state, account: { ...state.account, inventory: ${JSON.stringify(fixtureInventory)} }, continuous: [${JSON.stringify(exchangeCandidate)}] };
    mode = 'continuous'; dashboardFilters.unlimited = 'with'; renderDashboard();
    document.querySelector('.candidate').click();
  })()`);
  await waitFor(`Boolean(document.querySelectorAll('.plan-stage').length === 3 && [...document.querySelectorAll('#modal-content img')].every(image => image.complete && image.naturalWidth > 0))`, 'Mastery material icons did not load');
  await evaluate(`Promise.all(document.querySelector('#modal').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))`);
  const masteryExchange = await evaluate(`(() => ({
    noExchange: ${JSON.stringify(noExchange)},
    items: Object.fromEntries([...document.querySelectorAll('[data-exchange-item]')].map(node => [node.dataset.exchangeItem, Number(node.dataset.exchangeQuantity)])),
    stages: document.querySelectorAll('.plan-stage').length,
    cards: document.querySelectorAll('.plan-material-card').length,
    folded: [...document.querySelectorAll('.plan-stage-recipe')].every(node => node.hidden),
    booksSeparate: document.querySelector('.plan-summary-books')?.innerText.includes('×3'),
    stageStocks: [...document.querySelectorAll('.plan-stage')].map(node => node.querySelector('.plan-stock strong').textContent),
    infinityCopy: document.querySelector('#modal-content').innerText.includes('无限供应链'),
    overflow: document.querySelector('.modal-panel').scrollWidth > document.querySelector('.modal-panel').clientWidth,
  }))()`);
  await evaluate(`window.__qaMaterialGeometry = () => [...document.querySelectorAll('.plan-stage')].map(stage => {
    const grid = stage.querySelector('.plan-material-grid').getBoundingClientRect();
    return [...stage.querySelectorAll('.plan-material-card')].map(card => {
      const rect = card.getBoundingClientRect();
      return { left: rect.left - grid.left, top: rect.top - grid.top, width: rect.width, height: rect.height,
        footer: card.querySelector('.plan-card-footer').getBoundingClientRect().bottom - rect.top };
    });
  })`);
  masteryExchange.cardGeometry = await evaluate('window.__qaMaterialGeometry()');
  masteryExchange.aligned = masteryExchange.cardGeometry.every(row => row.every(card => Math.abs(card.height - row[0].height) < .1 && Math.abs(card.width - row[0].width) < .1 && Math.abs(card.top) < .1 && Math.abs(card.footer - row[0].footer) < .1));
  await captureScreen('mastery-detail-exchange-folded.png');
  await evaluate(`document.querySelectorAll('.plan-stage')[2].querySelector('[data-plan-recipe-toggle="30135"]').click()`);
  await evaluate(`document.querySelectorAll('.plan-stage')[2].querySelector('.plan-recipe-nested > summary').click()`);
  masteryExchange.expanded = await evaluate(`(() => ({
    root: !document.querySelectorAll('.plan-stage')[2].querySelector('.plan-stage-recipe').hidden,
    nested: document.querySelectorAll('.plan-stage')[2].querySelector('.plan-recipe-nested').open,
    arrows: document.querySelectorAll('.plan-flow-symbol').length,
    rawNames: [...document.querySelectorAll('.plan-recipe-flow img')].every(image => image.alt),
    overflow: document.querySelector('.modal-panel').scrollWidth > document.querySelector('.modal-panel').clientWidth,
    belowGrid: document.querySelectorAll('.plan-stage')[2].querySelector('.plan-stage-recipe').getBoundingClientRect().top >= document.querySelectorAll('.plan-stage')[2].querySelector('.plan-material-grid').getBoundingClientRect().bottom,
  }))()`);
  masteryExchange.expanded.stableCards = JSON.stringify(await evaluate('window.__qaMaterialGeometry()')) === JSON.stringify(masteryExchange.cardGeometry);
  await waitFor(`[...document.querySelectorAll('.plan-stage-recipe img')].every(image => image.complete && image.naturalWidth > 0)`, 'Expanded recipe icons did not load');
  await evaluate(`document.querySelectorAll('.plan-stage')[2].scrollIntoView({ block: 'start' })`);
  await captureScreen('mastery-detail-exchange-expanded.png');
  await evaluate(`document.documentElement.dataset.theme = 'light'`);
  await captureScreen('mastery-detail-exchange-light.png');
  await evaluate(`document.querySelectorAll('.plan-stage')[2].querySelector('[data-plan-recipe-toggle="30014"]').click()`);
  masteryExchange.switched = await evaluate(`(() => {
    const stage = document.querySelectorAll('.plan-stage')[2];
    return stage.querySelectorAll('[data-plan-recipe-toggle][aria-expanded="true"]').length === 1
      && stage.querySelectorAll('.plan-material-card.selected').length === 1
      && stage.querySelector('[data-plan-recipe-toggle="30014"]').getAttribute('aria-expanded') === 'true'
      && stage.querySelector('.plan-recipe-heading h4').innerText.includes('提纯源岩');
  })()`);
  masteryExchange.switchedStable = JSON.stringify(await evaluate('window.__qaMaterialGeometry()')) === JSON.stringify(masteryExchange.cardGeometry);
  await evaluate(`document.querySelectorAll('.plan-stage')[2].querySelector('.plan-recipe-close').click()`);
  masteryExchange.closed = await evaluate(`(() => {
    const stage = document.querySelectorAll('.plan-stage')[2];
    return stage.querySelector('.plan-stage-recipe').hidden
      && !stage.querySelector('[aria-expanded="true"]') && !stage.querySelector('.selected')
      && document.activeElement === stage.querySelector('[data-plan-recipe-toggle="30014"]');
  })()`);
  await evaluate(`(() => {
    document.querySelector('.modal-close').click();
    state = window.__masteryQaState; delete window.__masteryQaState; delete window.__qaMaterialGeometry;
    mode = 'single'; dashboardFilters.unlimited = 'real';
    document.documentElement.dataset.theme = state.settings.theme; render();
  })()`);

  const windowPolicy = JSON.parse(await readFile(windowPolicyPath, 'utf8'));
  startupTheme.windowBackground = windowPolicy.backgroundColor;
  console.log('QA phase: page overflow and window policy');

  const failures = [];
  if (!masteryExchange.noExchange || masteryExchange.stages !== 3 || masteryExchange.cards !== 9
    || JSON.stringify(masteryExchange.items) !== JSON.stringify({ '30013': 7, '30053': 3, '30103': 3 })
    || !masteryExchange.folded || !masteryExchange.booksSeparate
    || masteryExchange.stageStocks.join(',') !== '1,1,0'
    || masteryExchange.infinityCopy || masteryExchange.overflow
    || !masteryExchange.expanded.root || !masteryExchange.expanded.nested
    || !masteryExchange.expanded.arrows || !masteryExchange.expanded.rawNames
    || masteryExchange.expanded.overflow || !masteryExchange.aligned || !masteryExchange.expanded.belowGrid
    || !masteryExchange.expanded.stableCards || !masteryExchange.switched || !masteryExchange.switchedStable
    || !masteryExchange.closed) failures.push('mastery exchange checklist and folded recipes');
  const startupShouldBeLight = startupTheme.saved === 'light'
    || (startupTheme.saved === 'system' && startupTheme.prefersLight);
  const expectedStartupBackground = startupShouldBeLight ? 'rgb(223, 231, 237)' : 'rgb(15, 15, 15)';
  const expectedWindowBackground = startupShouldBeLight ? '#dfe7ed' : '#0f0f0f';
  if (startupTheme.query !== startupTheme.saved || startupTheme.applied !== startupTheme.saved
    || startupTheme.bodyBackground !== expectedStartupBackground
    || startupTheme.windowBackground.toLowerCase() !== expectedWindowBackground) failures.push('startup theme');
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
  for (const [theme, valid] of Object.entries(sortThemeChecks)) if (!valid) failures.push(`sort theme ${theme}`);
  if (!combinedSort.equal) failures.push('combined sort');
  if (!masteryBadgeLayout.valid) failures.push('mastery badge layout');
  if (!highlightSync.equal) failures.push('highlight source mismatch');
  if (Object.values(pages).some(page => page.horizontalOverflow)) failures.push('horizontal overflow');
  if (statisticsVisuals.all.scope !== 'all' || statisticsVisuals.owned.scope !== 'owned'
    || statisticsVisuals.all.rows !== 6 || statisticsVisuals.owned.rows !== 6
    || statisticsVisuals.all.sections.join('|') !== '干员持有|精英化|技能专精|模组'
    || statisticsVisuals.all.ownership !== statisticsVisuals.owned.ownership
    || statisticsVisuals.owned.totals.some((value, index) => Number(value.split('/')[1]) > Number(statisticsVisuals.all.totals[index].split('/')[1]))
    || !statisticsVisuals.all.distributionRemoved || !statisticsVisuals.owned.distributionRemoved
    || !statisticsVisuals.all.scopeCompact || !statisticsVisuals.owned.scopeCompact
    || !statisticsVisuals.all.permanentBreakdowns || !statisticsVisuals.owned.permanentBreakdowns
    || !statisticsVisuals.all.progressForEveryLine || !statisticsVisuals.owned.progressForEveryLine
    || !statisticsVisuals.all.columnAligned || !statisticsVisuals.owned.columnAligned
    || statisticsVisuals.all.horizontalOverflow || statisticsVisuals.owned.horizontalOverflow) failures.push('statistics visuals');
  if (settingsVisuals.rows !== 7 || !settingsVisuals.cardsRemoved || !settingsVisuals.sortRemoved
    || !settingsVisuals.updatePenultimate || settingsVisuals.horizontalOverflow) failures.push('settings visuals');
  if (pages.dashboard.columns !== 3) failures.push('dashboard columns');
  if (pages.dashboard.cardWidth < 318 || pages.dashboard.cardWidth > 360 || pages.dashboard.masterySkillGap < 0) failures.push('dashboard card geometry');
  for (const planner of ['promotion', 'modules']) {
    const geometry = pages[planner];
    if (!geometry.cardWidth || Math.abs(geometry.cardWidth - pages.dashboard.cardWidth) > .1
      || Math.abs(geometry.cardHeight - pages.dashboard.cardHeight) > .1
      || Math.abs(geometry.avatar.width - pages.dashboard.avatar.width) > .1
      || Math.abs(geometry.avatar.height - pages.dashboard.avatar.height) > .1
      || Math.abs(geometry.rightVisual.width - pages.dashboard.rightVisual.width) > .1
      || Math.abs(geometry.rightVisual.height - pages.dashboard.rightVisual.height) > .1
      || Math.abs(geometry.rightVisual.rightInset - pages.dashboard.rightVisual.rightInset) > .1
      || Math.abs(geometry.rightVisual.topInset - pages.dashboard.rightVisual.topInset) > .1) failures.push(`${planner} card geometry`);
  }
  if (operatorRarityVisuals.sixGradient !== masteryRarityGradient || !operatorRarityVisuals.sixBorderTransparent
    || !operatorRarityVisuals.fiveBorderVisible || operatorRarityVisuals.sixStripWidth !== '3px'
    || !operatorRarityVisuals.stripsAligned) failures.push('operator rarity gradient');
  if (!plannerVisuals.promotionSingle.cards || plannerVisuals.promotionSingle.levelBadges !== plannerVisuals.promotionSingle.cards
    || !plannerVisuals.promotionSingle.transitions || !plannerVisuals.promotionSingle.imagesLoaded
    || !plannerVisuals.promotionSingle.eliteBottomAligned || !plannerVisuals.promotionSingle.levelBottomAligned
    || plannerVisuals.promotionSingle.levelSamples.some(sample => !sample.loaded || !sample.correctPhase || !sample.aspectPreserved || !sample.contained || !sample.numberBelowIcon || !sample.frameContained)) failures.push('promotion planner visuals');
  if (!plannerVisuals.promotionContinuous.cards || !plannerVisuals.promotionContinuous.allMultiStage) failures.push('promotion continuous visuals');
  if (!plannerVisuals.moduleSingle.cards || !plannerVisuals.moduleSingle.noteRemoved || !plannerVisuals.moduleSingle.typeImagesLoaded
    || !plannerVisuals.moduleSingle.stageImagesLoaded || !plannerVisuals.moduleSingle.codesUppercase
    || !plannerVisuals.moduleSingle.typeFramesSquare || !plannerVisuals.moduleSingle.typeAspectPreserved
    || !plannerVisuals.moduleSingle.stageTransparent || !plannerVisuals.moduleSingle.stageAspectPreserved
    || !plannerVisuals.moduleSingle.targetsMatchMastery || !plannerVisuals.moduleSingle.copyContained
    || plannerVisuals.moduleSingle.codeSamples.some(sample => !sample.fits || !sample.static || !sample.centered)
    || !plannerVisuals.moduleSingle.codesStaticAndCentered
    || !plannerVisuals.moduleSingle.masteryAutoScroll
    || plannerVisuals.moduleSingle.themes.light.typeFilter === 'none'
    || plannerVisuals.moduleSingle.themes.light.stageFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.dark.typeFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.dark.stageFilter === 'none'
    || plannerVisuals.moduleSingle.themes.black.typeFilter !== 'none'
    || plannerVisuals.moduleSingle.themes.black.stageFilter === 'none'
    || !plannerVisuals.moduleSingle.themes.light.codeUsesText
    || !plannerVisuals.moduleSingle.themes.dark.codeUsesText
    || !plannerVisuals.moduleSingle.themes.black.codeUsesText) failures.push('module planner visuals');
  if (!plannerVisuals.moduleContinuous.cards || !plannerVisuals.moduleContinuous.allMultiStage || !plannerVisuals.moduleContinuous.includesSupportedSpan) failures.push('module continuous visuals');
  if (Math.abs(windowPolicy.bounds.width - 1360) > 1 || Math.abs(windowPolicy.bounds.height - 800) > 1
    || windowPolicy.minimumSize.join('x') !== '1360x800'
    || windowPolicy.maximumSize.join('x') !== '1360x800'
    || windowPolicy.resizable || windowPolicy.maximizable || windowPolicy.fullscreenable
    || !windowPolicy.minimizable || !windowPolicy.movable || !windowPolicy.closable) failures.push('window policy');

  const report = {
    pass: failures.length === 0,
    failures,
    startupTheme,
    startupCache,
    statisticsVisuals,
    settingsVisuals,
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
    sortThemeChecks,
    combinedSort,
    masteryBadgeLayout,
    filterPanelToggle: { opened: clickOpened, stayedOpen: clickStayedOpen, moveAwayStayedOpen, closed: clickClosed, hoverNoOpen, moreHoverNoOpen, moreOpened: moreClickOpened, moreClosed: moreClickClosed, horizontalOverflow: filterPanelOverflow },
    optionCounts,
    highlightSync,
    performance: performanceReport,
    pages,
    rarity: { masteryRarityGradient, operatorRarityVisuals },
    plannerVisuals,
    masteryExchange,
  };
  console.log('QA phase: frozen UI state screenshots');
  await evaluate(`(async () => { setState(await api.updateSettings({theme:'black'})); page='dashboard'; mode='single'; dashboardFilters={search:'',profession:'',rarity:'',mastery:'',unlimited:'real'}; render(); document.querySelector('main').scrollTop=0; })()`);
  await captureScreen('state-initial.png');
  const hover = await evaluate(`(() => {const r=document.querySelector('.candidate').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...hover});
  await captureScreen('state-hover.png');
  await evaluate(`document.querySelector('.candidate').click()`);
  await captureScreen('state-popup.png');
  await evaluate(`document.querySelector('.modal-close').click(); page='operators'; render(); document.querySelector('main').scrollTop=0; document.querySelector('[data-operator-panel-trigger]').click()`);
  await captureScreen('state-dropdown.png');
  await evaluate(`document.querySelector('[data-operator-filter-option]').click()`);
  await captureScreen('state-filter-selected.png');
  await evaluate(`OperatorFilters.reset(operatorFilters); render();`);
  await setSearch('阿米娅');
  await captureScreen('state-search.png');
  await evaluate(`OperatorFilters.reset(operatorFilters); render(); document.querySelector('main').scrollTop=350;`);
  await captureScreen('state-scroll.png');
  await evaluate(`page='settings'; render()`);
  await captureScreen('state-disabled.png');
  // Slow the actual renderer during a reload to capture the real pending first-state UI.
  await evaluate(`api.cacheState({...state, account: null})`);
  await send('Emulation.setCPUThrottlingRate',{rate:20});
  await send('Page.reload');
  await waitFor(`Boolean(document.querySelector('#content .loading'))`, 'Loading state was not observed');
  await captureScreen('state-loading.png');
  await send('Emulation.setCPUThrottlingRate',{rate:1});
  await waitFor(`typeof state !== 'undefined' && Boolean(state?.gameData)`, 'Reload did not finish');
  await evaluate(`(async () => {setState(await api.clearCache()); page='dashboard'; render();})()`);
  await evaluate(`api.cacheState(state)`);
  if (await evaluate(`api.getCachedState()`)) throw Error('Cleared account survived in startup cache');
  await captureScreen('state-empty.png');
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
  await rm(runtime, { recursive: true, force: true, maxRetries:10, retryDelay:200 });
}
