import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
// Visual review harness for the real Tauri/WebView2 renderer.
// Build debug first (npx tauri build --debug --no-bundle), then run:
//   node scripts/qa-visual.mjs [--tag name] [--themes black,light] [--sizes 1360x800,1100x700] [--shots a,b]
// The renderer is embedded in the binary, so rebuild debug after every renderer edit before capturing.
// The account is synthesized from bundled game data in an isolated profile; no credentials are used.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), list[index + 1]?.startsWith('--') ? 'true' : list[index + 1] ?? 'true']);
  return pairs;
}, []));
const tag = args.tag || 'latest';
const themes = (args.themes || 'black,light').split(',');
const sizes = (args.sizes || '1360x800').split(',').map(size => size.split('x').map(Number));
const only = args.shots ? new Set(args.shots.split(',')) : null;
const output = path.resolve('output/playwright/ui-polish', tag);
await mkdir(output, { recursive: true });

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function syntheticAccount() {
  const game = JSON.parse(await readFile('dist/resource/snapshot/data/game.json', 'utf8'));
  const rand = random(20261026);
  const pick = list => list[Math.floor(rand() * list.length)];
  const between = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const operators = game.operators.filter(operator => rand() < (operator.rarity >= 5 ? 0.55 : 0.7)).map(operator => {
    const maxElite = operator.maxElitePhase ?? (operator.rarity >= 4 ? 2 : operator.rarity === 3 ? 1 : 0);
    const elitePhase = Math.min(maxElite, pick([0, 1, 1, 2, 2, 2]));
    const levelCap = [[30, 30, 40, 45, 50, 50], [0, 0, 55, 60, 70, 80], [0, 0, 0, 70, 80, 90]][elitePhase][operator.rarity - 1];
    const level = rand() < 0.6 ? levelCap : between(1, levelCap);
    const skills = operator.skills.map(skill => ({ skillId: skill.skillId, masteryLevel: elitePhase === 2 && operator.rarity >= 4 ? pick([0, 0, 1, 2, 3, 3]) : 0 }));
    const modules = elitePhase === 2 ? (operator.modules || []).map(module => ({ moduleId: module.moduleId, level: pick([0, 0, 1, 2, 3]) })) : [];
    return { operatorId: operator.operatorId, level, elitePhase, skillLevel: elitePhase === 0 ? between(1, 4) : 7, skills, modules };
  });
  const inventory = {};
  for (const material of game.materials) {
    const ranges = { 1: [150, 700], 2: [80, 320], 3: [20, 140], 4: [4, 45], 5: [0, 14] };
    const [min, max] = ranges[material.rarity] || [0, 30];
    inventory[material.itemId] = between(min, max);
  }
  Object.assign(inventory, { 4001: 3860000, 2001: 900, 2002: 640, 2003: 520, 2004: 610, 3301: 140, 3302: 210, 3303: 180, mod_unlock_token: 9 });
  const training = operators.find(owned => owned.elitePhase === 2 && owned.skills.some(skill => skill.masteryLevel === 1));
  const trainingSkill = training?.skills.find(skill => skill.masteryLevel === 1);
  return {
    uid: '123456789', nickname: '博士·视觉检查', syncedAt: new Date('2026-10-26T08:30:00Z').toISOString(), operators, inventory,
    training: training ? { operatorId: training.operatorId, skillId: trainingSkill.skillId, from: 1, to: 2 } : null,
  };
}

let child, profile, socket;
let port = process.env.ATR_QA_PORT;
if (!port) {
  port = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  profile = await mkdtemp(path.join(output, 'profile-'));
  await writeFile(path.join(profile, 'account-cache.json'), JSON.stringify(await syntheticAccount()));
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ unlimitedItemIds: ['3301', '3302', '3303'], autoRefresh: false, theme: themes[0], selectedUid: '123456789' }));
  const executable = process.env.ATR_QA_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target', 'debug/训练室.exe');
  child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ATR_USER_DATA: profile, ATR_QA_PORT: String(port) } });
  child.on('error', error => console.error(error.message));
  process.on('exit', () => { if (child.exitCode === null) child.kill(); });
}

let serial = 0;
const pending = new Map();
const runtimeErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, label = expression, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await evaluate(expression))) {
    if (Date.now() > deadline) {
      const snapshot = await evaluate(`location.href + ' | ' + (document.querySelector('#content')?.innerText || document.body?.innerText || '').slice(0, 300)`).catch(error => error.message);
      throw Error(`Timed out: ${label} — ${snapshot}`);
    }
    await pause(60);
  }
}
async function click(selector) {
  const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing ' + ${JSON.stringify(selector)}); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await pause(240);
}
async function hover(selector) {
  const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await pause(220);
}
async function key(name, code = name, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode });
  await pause(200);
}
async function type(selector, text) {
  await click(selector);
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.select(); })()`);
  await send('Input.insertText', { text });
  await pause(250);
}
async function capture(file) {
  await evaluate(`Promise.all([...document.images].filter(i => i.getBoundingClientRect().top < innerHeight).map(i => i.decode().catch(() => {})))`);
  await pause(260);
  const data = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, `${file}.png`), Buffer.from(data.data, 'base64'));
  console.log(`captured ${file}`);
}
async function layoutIssues() {
  return evaluate(`(() => {
    const issues = [];
    const main = document.querySelector('main');
    if (main.scrollWidth > main.clientWidth + 1) issues.push('main horizontal overflow ' + main.scrollWidth + '>' + main.clientWidth);
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('document horizontal overflow');
    for (const el of document.querySelectorAll('#content *')) {
      const style = getComputedStyle(el);
      if (style.overflowX === 'hidden' || style.overflowX === 'auto' || style.textOverflow === 'ellipsis' || !el.offsetParent) continue;
      const parent = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      if (rect.width && rect.right > parent.right + 2 && getComputedStyle(el.parentElement).overflowX === 'visible' && el.parentElement.clientWidth > 0 && rect.right > main.getBoundingClientRect().right) issues.push('overflow: ' + el.className);
    }
    return [...new Set(issues)].slice(0, 12);
  })()`);
}

async function setTheme(theme) {
  await evaluate(`api.updateSettings({ theme: ${JSON.stringify(theme)} }).then(next => { setState(next); render(); })`);
  await pause(300);
}
async function gotoPage(name) {
  await evaluate(`closeModal && document.querySelector('#modal').open && closeModal()`);
  await click(`.nav[data-page="${name}"]`);
  await evaluate(`document.querySelector('main').scrollTop = 0`);
  await pause(200);
}

const shots = {
  async dashboard(prefix) { await gotoPage('dashboard'); await capture(`${prefix}-dashboard`); },
  async 'dashboard-hover'(prefix) { await gotoPage('dashboard'); await hover('.candidate'); await capture(`${prefix}-dashboard-hover`); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 }); },
  async 'dashboard-detail'(prefix) {
    await gotoPage('dashboard'); await click('.candidate'); await waitFor(`document.querySelector('#modal').open`);
    await capture(`${prefix}-dashboard-detail`);
    const toggle = await evaluate(`!!document.querySelector('[data-plan-recipe-toggle]')`);
    if (toggle) { await click('[data-plan-recipe-toggle]'); await capture(`${prefix}-dashboard-detail-recipe`); }
    await key('Escape', 'Escape', 27);
  },
  async 'dashboard-search'(prefix) {
    await gotoPage('dashboard'); await type('[data-dashboard-filter="search"]', 'yh');
    await capture(`${prefix}-dashboard-search`);
    await evaluate(`dashboardFilters.search = ''; render()`);
  },
  async promotion(prefix) { await gotoPage('promotion'); await capture(`${prefix}-promotion`); },
  async 'promotion-detail'(prefix) {
    await gotoPage('promotion'); await click('.candidate'); await waitFor(`document.querySelector('#modal').open`);
    await capture(`${prefix}-promotion-detail`);
    await evaluate(`document.querySelector('.modal-panel').scrollTop = 99999`); await capture(`${prefix}-promotion-detail-end`);
    await key('Escape', 'Escape', 27);
  },
  async 'promotion-continuous'(prefix) {
    await gotoPage('promotion'); await click('[data-planner-toggle="continuous"] + span');
    if (await evaluate(`!!document.querySelector('.candidate')`)) { await click('.candidate'); await capture(`${prefix}-promotion-continuous-detail`); await key('Escape', 'Escape', 27); }
    await click('[data-planner-toggle="continuous"] + span');
  },
  async 'promotion-search'(prefix) {
    await gotoPage('promotion'); await type('[data-planner-filter="search"]', 'ss');
    await capture(`${prefix}-promotion-search`);
    await evaluate(`plannerFilters.promotion.search = ''; render()`);
  },
  async modules(prefix) { await gotoPage('modules'); await capture(`${prefix}-modules`); },
  async 'modules-detail'(prefix) {
    await gotoPage('modules'); await click('.candidate'); await waitFor(`document.querySelector('#modal').open`);
    await capture(`${prefix}-modules-detail`);
    await key('Escape', 'Escape', 27);
  },
  async 'modules-search'(prefix) {
    await gotoPage('modules'); await type('[data-planner-filter="search"]', 'h');
    await capture(`${prefix}-modules-search`);
    await evaluate(`plannerFilters.module.search = ''; render()`);
  },
  async statistics(prefix) { await gotoPage('statistics'); await capture(`${prefix}-statistics`); },
  async operators(prefix) { await gotoPage('operators'); await capture(`${prefix}-operators`); },
  async 'operators-filter'(prefix) { await gotoPage('operators'); await click('[data-operator-panel-trigger]'); await click('[data-operator-filter-option]'); await capture(`${prefix}-operators-filter`); await key('Escape', 'Escape', 27); await evaluate(`OperatorFilters.reset(operatorFilters); render()`); },
  async 'operators-skill'(prefix) {
    await gotoPage('operators');
    await evaluate(`(() => { const button = document.querySelector('.operator-skill.can-upgrade') || document.querySelector('.operator-skill'); button.setAttribute('data-qa-skill', ''); button.scrollIntoView({ block: 'center' }); })()`);
    await click('[data-qa-skill]'); await capture(`${prefix}-operators-skill`);
    if (await evaluate(`!!document.querySelector('[data-skill-view="next"]')`)) { await click('[data-skill-view="next"]'); await capture(`${prefix}-operators-skill-next`); }
    await key('Escape', 'Escape', 27);
  },
  async inventory(prefix) { await gotoPage('inventory'); await waitFor(`!!document.querySelector('.inventory-detail-body:not(:has(.inventory-detail-loading))')`); await capture(`${prefix}-inventory`); },
  async 'modules-unlock'(prefix) {
    await gotoPage('modules');
    const found = await evaluate(`(() => { const card = [...document.querySelectorAll('.candidate')].find(c => c.textContent.includes('未装配')); card?.setAttribute('data-qa-target', ''); return !!card; })()`);
    if (!found) return;
    await click('[data-qa-target]'); await waitFor(`document.querySelector('#modal').open`);
    await capture(`${prefix}-modules-unlock-detail`);
    await key('Escape', 'Escape', 27);
  },
  async settings(prefix) {
    await gotoPage('settings'); await capture(`${prefix}-settings`);
    const metrics = await evaluate(`(() => { const main = document.querySelector('main'); const before = main.scrollTop; main.scrollTop = 99999; const after = main.scrollTop; return { scrollbarWidth: main.offsetWidth - main.clientWidth, scrollable: main.scrollHeight > main.clientHeight, scrolledBy: after - before, rightGap: Math.round(main.getBoundingClientRect().right - document.querySelector('.settings-list').getBoundingClientRect().right) }; })()`);
    settingsMetrics[prefix] = metrics;
    await pause(150); await capture(`${prefix}-settings-end`);
  },
  async 'settings-states'(prefix) {
    await gotoPage('settings');
    await evaluate(`state.loggedIn = true; render()`); await capture(`${prefix}-settings-online`);
    await evaluate(`accountRefreshing = true; render()`); await capture(`${prefix}-settings-refreshing`);
    await evaluate(`accountRefreshing = false; state.loggedIn = false; render()`);
  },
};
const settingsMetrics = {};

try {
  let target;
  for (let attempt = 0; attempt < 150 && !target; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json()).catch(() => []);
    target = targets.find(item => item.type === 'page' && item.url.includes('renderer/index.html'));
    if (!target) await pause(200);
  }
  if (!target) throw Error('No training room page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(`typeof state !== 'undefined' && !!state?.account && !!document.querySelector('.nav')`, 'app state', 20000);
  const report = {};
  for (const [width, height] of sizes) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of themes) {
      await setTheme(theme);
      const prefix = `${theme}-${width}`;
      for (const [name, shot] of Object.entries(shots)) {
        if (only && !only.has(name)) continue;
        try { await shot(prefix); } catch (error) { console.error(`FAIL ${prefix} ${name}: ${error.message}`); report[`${prefix}-${name}`] = { error: error.message }; continue; }
        const issues = await layoutIssues();
        if (issues.length) { report[`${prefix}-${name}`] = { issues }; console.log(`layout ${prefix}-${name}: ${issues.join(' | ')}`); }
      }
    }
  }
  if (runtimeErrors.length) console.error('Runtime errors:\n' + runtimeErrors.join('\n'));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ report, settingsMetrics, runtimeErrors }, null, 2));
} finally {
  socket?.close();
  if (child) {
    child.kill(); await pause(1500);
    if (path.dirname(profile) !== output) throw Error('Unsafe QA cleanup path');
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
