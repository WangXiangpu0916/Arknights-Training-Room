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
await writeFile(path.join(runtime, 'account-cache.json'), `${JSON.stringify(account, null, 2)}\n`, 'utf8');

const env = {
  ...process.env,
  ATR_USER_DATA: runtime,
  ATR_QA_HIDDEN: '1',
  ATR_WINDOW_POLICY_REPORT: windowPolicyPath,
};
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
  throw new Error([message, ...protocolDiagnostics, childOutput].filter(Boolean).join('\n'));
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
  await waitFor(`Boolean(document.querySelector('.nav[data-page="operators"]'))`, 'Application did not render');
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
  for (const mode of ['implementation-asc', 'implementation-desc', 'name-asc', 'name-desc', 'rarity-asc', 'rarity-desc']) {
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
  for (const page of ['dashboard', 'operators', 'inventory', 'settings']) {
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

  const windowPolicy = JSON.parse(await readFile(windowPolicyPath, 'utf8'));
  console.log('QA phase: page overflow and window policy');

  const failures = [];
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
  if (pages.dashboard.columns !== 3) failures.push('dashboard columns');
  if (pages.dashboard.cardWidth < 337 || pages.dashboard.cardWidth > 338 || pages.dashboard.masterySkillGap < 28 || pages.dashboard.masterySkillGap > 40) failures.push('dashboard card geometry');
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
