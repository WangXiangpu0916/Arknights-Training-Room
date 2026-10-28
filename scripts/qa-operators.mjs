import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

// Run after a debug build. Only the temporary profile receives synthetic ownership or settings.
const output = path.resolve('output/playwright/skill-details');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const game = JSON.parse(await readFile('dist/resource/snapshot/data/game.json', 'utf8'));
const account = { uid: 'operators-qa', nickname: '技能验收', syncedAt: new Date().toISOString(),
  operators: game.operators.map(op => ({ operatorId: op.operatorId, elitePhase: op.maxElitePhase, level: 50, skillLevel: 7,
    skills: op.skills.map((s, index) => ({ skillId: s.skillId, masteryLevel: op.rarity >= 4 ? Math.min(index, 3) : 0 })), modules: [] })),
  inventory: Object.fromEntries(game.materials.map(m => [m.itemId, 999999])) };
account.operators.find(o => o.operatorId === '172_svrash').skills[2].masteryLevel = 3;
account.operators.find(o => o.operatorId === '002_amiya').skills.forEach((skill, index) => { skill.masteryLevel = [0, 1, 2, 0, 3, 1, 2][index]; });
await writeFile(path.join(profile, 'account-cache.json'), JSON.stringify(account));
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ autoRefresh: false, theme: 'black', unlimitedItemIds: [], selectedUid: account.uid }));
if (process.env.ATR_QA_OLD_RESOURCE) await cp(process.env.ATR_QA_OLD_RESOURCE, path.join(profile, 'game-data'), { recursive: true });
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const executable = path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target', 'debug/训练室.exe');
const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ATR_USER_DATA: profile, ATR_QA_PORT: String(port), ATR_QA_HIDDEN: '1' } });
let childOutput = '', socket, serial = 0, passed = false;
const checks = [], errors = [], pending = new Map();
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => childOutput = (childOutput + data).slice(-4000));
child.on('error', error => { childOutput += error.message; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector) {
  const point = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await pause(100);
}
async function open(id, index = 0, block = 'start') {
  const skill = game.operators.find(o => o.operatorId === id).skills[index];
  const selector = `[data-operator-skill="${id}:${skill.skillId}"]`;
  await evaluate(`closeSkillPopover();document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:${JSON.stringify(block)}})`);
  await pause(150);
  await click(selector);
  return skill;
}
async function capture(name) {
  await pause(150);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function check(name, expression) { assert.ok(await evaluate(expression), name); checks.push(name); console.log('PASS ' + name); }
const fits = `(() => {const e=document.querySelector('#skill-detail'),r=e?.getBoundingClientRect();return r && r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && e.scrollWidth<=e.clientWidth;})()`;
try {
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => [])).find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
    if (!target) await pause(200);
  }
  assert.ok(target, 'No QA window: ' + childOutput);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const task = pending.get(message.id);
    if (task) { pending.delete(message.id); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); }
  };
  await send('Runtime.enable');
  for (let i = 0; i < 200 && !await evaluate(`typeof state !== 'undefined' && !!state?.account`); i++) await pause(100);
  await check('existing profile loads newest bundled skill data', `state.gameData.version===${JSON.stringify(game.version)} && !!state.gameData.skillDetails`);
  await click('.nav[data-page="operators"]');
  await check('all owned operators remain in list', `document.querySelectorAll('.operator-row').length===${game.operators.length}`);

  await check('Amiya keeps all seven skills in one row', `document.querySelectorAll('[data-operator-skill^="002_amiya:"]').length===7 && state.gameData.operators.filter(o=>o.operatorId.includes('amiya')).length===1`);
  await open('002_amiya');
  await evaluate(`closeSkillPopover()`);
  await check('all seven Amiya icons are visible and loaded', `(() => {const buttons=[...document.querySelectorAll('[data-operator-skill^="002_amiya:"]')];const row=buttons[0].closest('.operator-row').getBoundingClientRect();return buttons.every(b=>{const r=b.getBoundingClientRect(),img=b.querySelector('.operator-skill-icon');return r.left>=row.left && r.right<=row.right && img.complete && img.naturalWidth>0;});})()`);
  await capture('00-amiya-seven-skills');
  for (let index = 0; index < 7; index++) {
    const skill = await open('002_amiya', index);
    const level = 7 + account.operators.find(o => o.operatorId === '002_amiya').skills[index].masteryLevel;
    await check(`Amiya skill ${index + 1} preserves its mastery and description`, `SkillDetails.progress(skillPopover.definition, skillPopover.owned, skillPopover.skill).current===${level} && document.querySelector('.skill-detail-description').textContent===state.gameData.skillDetails[${JSON.stringify(skill.skillId)}][${level - 1}].description`);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'account-cache.json'), 'utf8')), account, 'Resource correction must preserve the saved account');

  for (let level = 1; level <= 7; level++) {
    await evaluate(`state.account.operators.find(o=>o.operatorId==='123_fang').skillLevel=${level};render()`);
    const skill = await open('123_fang');
    await check(`Fang rank ${level} current description`, `document.querySelector('.skill-detail-description').textContent===state.gameData.skillDetails[${JSON.stringify(skill.skillId)}][${level - 1}].description`);
    if (level < 7) {
      await click('[data-skill-view="next"]');
      await check(`Fang rank ${level + 1} effects and exact costs`, `(() => { const op=operatorDefinitions().get('123_fang');return document.querySelector('.skill-detail-description').textContent===state.gameData.skillDetails[${JSON.stringify(skill.skillId)}][${level}].description && [...document.querySelectorAll('.skill-detail-materials .plan-material-token')].map(n=>n.title).join('|')===op.skillLevelRequirements[${level - 1}].map(c=>materialMap().get(c.itemId).name+' ×'+c.quantity).join('|');})()`);
    } else {
      await check('three-star MAX is not a button and has no next costs', `document.querySelector('.skill-detail-max').textContent==='MAX' && !document.querySelector('[data-skill-view="next"]') && !document.querySelector('.skill-detail-costs') && !document.querySelector('.skill-detail-ready')`);
    }
  }
  await capture('01-three-star-max');
  for (const [id, index, from] of [['172_svrash', 0, 7], ['172_svrash', 1, 8], ['180_amgoat', 2, 9]]) {
    const skill = await open(id, index);
    await check(`mastery ${from - 7} current and highlight match`, `document.querySelector('.skill-detail-description').textContent===state.gameData.skillDetails[${JSON.stringify(skill.skillId)}][${from - 1}].description && document.querySelector('#skill-detail').classList.contains('can-upgrade')===skillPopover.anchor.classList.contains('can-upgrade') && !!document.querySelector('.skill-detail-ready')`);
    await click('[data-skill-view="next"]');
    await check(`mastery ${from - 6} exact next cost`, `(() => {const s=skillPopover.skill;return document.querySelector('.skill-detail-description').textContent===state.gameData.skillDetails[s.skillId][${from}].description && [...document.querySelectorAll('.skill-detail-materials .plan-material-token')].map(n=>n.title).join('|')===s.requirements[${from - 6}].map(c=>materialMap().get(c.itemId).name+' ×'+c.quantity).join('|');})()`);
  }
  await capture('02-mastery-next');
  await open('172_svrash', 2);
  await check('M3 MAX has highest description without upgrade highlight', `document.querySelector('.skill-detail-max').textContent==='MAX' && !document.querySelector('.skill-detail-ready') && document.querySelector('.skill-detail-description').textContent.includes('+200%')`);
  await open('237_gravel');
  await check('passive timing does not claim infinite duration', `document.querySelector('.skill-detail-stats').textContent==='被动技能'`);

  for (const [theme, scheme, width, height] of [['black','dark',1360,760],['light','light',1024,720],['system','dark',800,600],['system','light',480,360]]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await send('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme',value:scheme}]});
    await evaluate(`state.settings.theme=${JSON.stringify(theme)};render()`);
    await open('4231_clemnt', 1);
    await check(`${theme}/${scheme} ${width} downward anchored and contained`, fits + ` && document.querySelector('#skill-detail').dataset.placement==='below'`);
    const rowHeight = await evaluate(`skillPopover.anchor.closest('.operator-row').getBoundingClientRect().height`);
    await click('[data-skill-view="next"]');
    await check(`${width} next-level content fits without changing card layout`, fits + ` && skillPopover.anchor.closest('.operator-row').getBoundingClientRect().height===${rowHeight}`);
    await capture(`03-${theme}-${scheme}-${width}-below`);
    await open('4231_clemnt', 1, 'end');
    await check(`${width} lower icon opens upward`, fits + ` && document.querySelector('#skill-detail').dataset.placement==='above'`);
    await capture(`04-${theme}-${scheme}-${width}-above`);
    await evaluate(`document.querySelector('#skill-detail').scrollTop=99999`);
    await check(`${width} long description is scrollable to end`, `(() => {const e=document.querySelector('#skill-detail');return Math.abs(e.scrollHeight-e.clientHeight-e.scrollTop)<2;})()`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`state.settings.theme='black';render()`);
  await open('123_fang');
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await check('Escape restores focus to the skill icon', `!skillPopover && document.activeElement.matches('[data-operator-skill]')`);
  await open('123_fang');
  await click('.nav[data-page="operators"]');
  await check('outside click dismisses', `!document.querySelector('#skill-detail')`);
  await open('123_fang');
  await evaluate(`document.querySelector('main').scrollTop=0`);
  await pause(150);
  await check('offscreen trigger closes floating window', `!skillPopover`);
  await open('123_fang');
  await evaluate(`updateOperatorResults()`);
  await check('filter result replacement dismisses stale details', `!skillPopover`);
  await open('123_fang');
  await evaluate(`setState({...state,revision:state.revision+1})`);
  await check('fresh account/resource snapshot dismisses old details', `!skillPopover`);

  await evaluate(`document.querySelector('[data-operator-sort="implementation"]').scrollIntoView({block:'center'})`);
  await pause(150);
  for (const sort of ['implementation-asc','implementation-desc']) {
    await click('[data-operator-sort="implementation"]');
    await check(`${sort} includes newly added Clementia at correct place`, `(() => {const rows=[...document.querySelectorAll('.operator-row')];const fang=rows.findIndex(r=>r.textContent.includes('芬'));const clem=rows.findIndex(r=>r.textContent.includes('克莱门莎'));return clem>=0 && ${sort.endsWith('desc') ? 'clem<fang' : 'clem>fang'};})()`);
  }
  for (const property of ['acquisition', 'skill']) {
    for (const direction of ['asc', 'desc']) {
      await click(`[data-operator-sort="${property}"]`);
      await check(`${property}-${direction} on the full roster`, `operatorFilters.sort==='${property}-${direction}' && document.querySelectorAll('.operator-row').length===${game.operators.length} && document.querySelector('.operator-sort-option.active .operator-sort-direction').textContent==='${direction === 'asc' ? '↑' : '↓'}'`);
    }
  }
  const performance = await evaluate(`(async () => {const start=performance.now();updateOperatorResults();const renderMs=performance.now()-start;const frames=[];let last=performance.now();for(let i=0;i<60;i++){await new Promise(requestAnimationFrame);const now=performance.now();frames.push(now-last);last=now;document.querySelector('main').scrollTop+=80;}frames.sort((a,b)=>a-b);return {operators:document.querySelectorAll('.operator-row').length,renderMs,scrollFrameP95:frames[Math.floor(frames.length*.95)],popovers:document.querySelectorAll('#skill-detail').length};})()`);
  await writeFile(path.join(output, 'performance.json'), JSON.stringify(performance, null, 2));
  assert.equal(performance.popovers, 0);
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (socket?.readyState === WebSocket.OPEN && !passed) await capture('failure').catch(() => {});
  socket?.close();
  child.kill();
  await pause(1200);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({pass:passed,checks,errors}, null, 2));
  if (path.dirname(profile) !== output) throw Error('Unsafe QA cleanup path');
  await rm(profile, {recursive:true,force:true,maxRetries:10,retryDelay:200});
}
