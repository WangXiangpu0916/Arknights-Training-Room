import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { native } from '../dist/tests/native-core.js';
// Build debug first, then run node scripts/qa-training.mjs. No credentials are copied.
// ATR_QA_PORT optionally connects to an already-running isolated QA session.
const output = path.resolve(process.env.ATR_QA_OUTPUT || 'output/playwright/training');
await mkdir(output, {recursive:true});
let child, profile, childOutput='';
let port = process.env.ATR_QA_PORT;
if (!port) {
  port = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const value=server.address().port; server.close(()=>resolve(value)); });
  });
  profile = await mkdtemp(path.join(output, 'profile-'));
  const account=JSON.parse(await readFile('qa-fixture/account-cache.json','utf8'));
  const game=JSON.parse(await readFile('dist/resource/snapshot/data/game.json','utf8'));
  for (const id of ['002_amiya','4132_ascln','180_amgoat']) {
    const operator=game.operators.find(x=>x.operatorId===id);
    if(!account.operators.some(x=>x.operatorId===id)) account.operators.push({operatorId:id,level:90,elitePhase:2,skillLevel:7,skills:operator.skills.map(s=>({skillId:s.skillId,masteryLevel:0}))});
  }
  Object.assign(account.operators.find(x=>x.operatorId==='002_amiya'),{level:50,elitePhase:0});
  for(const material of game.materials) account.inventory[material.itemId]=999;
  for(const item of ['2001','2002','2003','2004']) account.inventory[item]=999;
  account.inventory['4001']=99999999;
  await writeFile(path.join(profile,'account-cache.json'),JSON.stringify(account));
  await writeFile(path.join(profile,'settings.json'),JSON.stringify({unlimitedItemIds:['3301','3302','3303'],autoRefresh:false,theme:'black',selectedUid:account.uid}));
  const executable=process.env.ATR_QA_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','debug/训练室.exe');
  child=spawn(executable,[],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ATR_USER_DATA:profile,ATR_QA_PORT:String(port)}});
  for(const stream of [child.stdout,child.stderr]) stream.on('data',data=>childOutput=(childOutput+data).slice(-4000));
  child.on('error', error => { console.error(error.message); });
  process.on('exit', () => { if(child.exitCode===null) child.kill(); });
}
let target;
for (let attempt = 0; attempt < 100 && !target; attempt++) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => []);
  target = targets.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
  if (!target) await new Promise(resolve => setTimeout(resolve, 200));
}
if (!target) throw Error('No training room page: '+childOutput);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
const pending = new Map();
const runtimeErrors = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (!message.id) return;
  const task = pending.get(message.id);
  if (!task) return;
  pending.delete(message.id);
  message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result);
};
export const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
});
export async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
export const pause = ms => new Promise(r => setTimeout(r, ms));
export async function click(selector) {
  const point = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...point });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...point });
  await pause(220);
}
export async function key(key, code = key, modifiers = 0, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type:'keyDown', key, code, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type:'keyUp', key, code, modifiers, windowsVirtualKeyCode });
}
export async function fill(selector, text) {
  await click(selector);
  await key('a','KeyA',2,65); await key('Backspace','Backspace',0,8);
  await send('Input.insertText', {text}); await pause(100);
}
export async function capture(name) {
  await evaluate(`Promise.all([...document.images].filter(i=>i.getBoundingClientRect().top<innerHeight).map(i=>i.decode().catch(()=>{})))`);
  await pause(300);
  const data = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(path.join(output,name+'.png'),Buffer.from(data.data,'base64'));
}
export const close = () => socket.close();

const checks = [];
let passed = false;
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS '+name); };
try {
  await send('Runtime.enable');
  for (let attempt=0; attempt<100 && !(await evaluate(`typeof state !== 'undefined' && !!state?.account`)); attempt++) await pause(100);
  await send('Input.dispatchMouseEvent', {type:'mouseMoved',x:1,y:1});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const initial = await evaluate('state');
  const account = structuredClone(initial.account);
  const operator = initial.gameData.operators.find(o => o.operatorId === '172_svrash');
  assert.ok(operator, 'SilverAsh fixture definition');
  const skill = operator.skills[2];
  const owned = account.operators.find(o=>o.operatorId===operator.operatorId);
  assert.ok(owned, 'SilverAsh fixture ownership');
  const snapshot = (from, training=true, inventory=account.inventory) => {
    const next = structuredClone(account);
    next.operators.find(o=>o.operatorId===operator.operatorId).skills.find(s=>s.skillId===skill.skillId).masteryLevel=from;
    next.training = training ? {operatorId:operator.operatorId,skillId:skill.skillId,from,to:from+1} : null;
    next.inventory=inventory;
    return {...initial,...native({game:initial.gameData,account:next,unlimited:initial.settings.unlimitedItemIds}),account:next,revision:initial.revision+1};
  };
  async function show(next) {
    // Simulate a fresh account event with plans computed by the real Rust core.
    next.revision = await evaluate('state.revision+1');
    await evaluate(`window.qaNext=${JSON.stringify(next)}; api.getState=async()=>presentPlans(window.qaNext); loadState()`);
    await pause(300);
  }
  async function fit() {
    return evaluate(`(() => {
      const strip=document.querySelector('.training-strip'), cards=document.querySelector('.cards');
      const r=strip?.getBoundingClientRect(), c=cards?.getBoundingClientRect();
      return document.documentElement.scrollWidth<=innerWidth && r && c && r.right<=innerWidth && r.left>=0 && r.bottom<=c.top && Math.abs(r.width-c.width)<1
        && [...document.querySelectorAll('.training-strip img')].every(i=>i.complete && i.naturalWidth>0);
    })()`);
  }
  await show(snapshot(1, false));
  await capture('01-empty-room');
  check('empty room has no training region',await evaluate(`!document.querySelector('.training-strip')`));

  // Real animation time and two screenshots prove motion; no hover or forced animation progress.
  await evaluate(`(() => {
    dashboardFilters.search='';render();
    const cards=[...document.querySelectorAll('.candidate')];
    window.qaLong=cards.find(c=>c.querySelector('.skill-copy strong').scrollWidth>100);
    window.qaShort=cards.find(c=>c.querySelector('.skill-copy strong').scrollWidth<=56);
    if(!qaLong || !qaShort) throw Error('Missing long/short fixture');
    qaLong.scrollIntoView({block:'center'});
    qaLong.focus(); document.activeElement.blur();
  })()`);
  const metrics = () => evaluate(`(() => {
    const read=c=>{const n=c.querySelector('.skill-copy strong'),s=getComputedStyle(n),r=c.getBoundingClientRect();return {name:n.textContent,transform:s.transform==='none'?0:new DOMMatrix(s.transform).m41,width:r.width,height:r.height,clip:getComputedStyle(n.parentElement).overflow};};
    return {long:read(qaLong),short:read(qaShort)};
  })()`);
  const before=await metrics(); await capture('02-name-scroll-start'); await pause(3500);
  const after=await metrics(); await capture('03-name-scroll-moving');
  await writeFile(path.join(output,'scroll-metrics.json'),JSON.stringify({before,after},null,2));
  check('long name automatically scrolls',before.long.transform!==after.long.transform);
  check('short name stays still and card dimensions are stable',Math.abs(before.short.transform-after.short.transform)<0.1 && before.long.width===after.long.width && before.long.height===after.long.height && after.long.clip==='hidden');

  await evaluate(`document.querySelector('main').scrollTop=0`);
  await show(snapshot(1)); await capture('04-training-next-black');
  check('full-width region with next level',await fit());
  check('training is unique and other skills remain',await evaluate(`document.querySelectorAll('.training-strip').length===1 && !document.querySelector('.cards [data-key="${operator.operatorId}:${skill.skillId}"]') && !!document.querySelector('.cards [data-key^="${operator.operatorId}:"]')`));
  check('actual level unchanged',await evaluate(`state.account.operators.find(o=>o.operatorId==='${operator.operatorId}').skills.find(s=>s.skillId==='${skill.skillId}').masteryLevel===1`));
  await click('.nav[data-page="operators"]');
  check('operator status keeps completed level and names ongoing training',await evaluate(`document.querySelector('[data-operator-skill="${operator.operatorId}:${skill.skillId}"]').title.includes('专精一级 · 正在训练至专精二级')`));
  await click('.nav[data-page="dashboard"]');
  await click('[data-training-plan]'); await capture('05-next-materials');
  check('material modal starts after current training',await evaluate(`modalContent.querySelector('.plan-detail-heading').textContent.includes('专精二级 → 专精三级') && modalContent.querySelectorAll('.plan-stage').length===1`));
  const nextPlan=await evaluate('trainingCandidate()');
  assert.deepEqual(nextPlan.stages[0].requirements,skill.requirements[3]);
  await show(snapshot(2));
  check('refresh closes stale materials modal',await evaluate('!modal.open'));
  await capture('06-training-maximum');
  check('maximum level shows operator without next hint',await evaluate(`!!document.querySelector('.training-strip') && !document.querySelector('.training-next') && document.querySelector('.training-strip').textContent.includes('专精三级')`));
  await show(snapshot(0)); await click('[data-continuous-mode]'); await click('[data-training-plan]');
  await capture('07-continuous-materials');
  const continuous = await evaluate('trainingCandidate()');
  assert.deepEqual(continuous.stages.map(s=>s.from),[1,2]);
  const totals=new Map(); for (const level of [2,3]) for(const r of skill.requirements[level]) totals.set(r.itemId,(totals.get(r.itemId)||0)+r.quantity);
  const shownTotals=await evaluate(`[...modalContent.querySelectorAll('.plan-total-grid .plan-material-token')].map(n=>n.title)`);
  check('continuous totals omit in-progress stage',shownTotals.length===totals.size && [...totals].every(([id,n])=>shownTotals.includes(initial.gameData.materials.find(m=>m.itemId===id).name+' ×'+n)));
  await key('Escape','Escape',0,27);
  await show(snapshot(1)); await click('[data-training-plan]');
  check('continuous mode retains the final single-step details',await evaluate(`modalContent.querySelectorAll('.plan-stage').length===1`));
  await key('Escape','Escape',0,27); await click('[data-continuous-mode]');
  await show(snapshot(1,true,{})); await capture('08-insufficient-materials');
  check('training remains visible with insufficient materials',await evaluate(`!!document.querySelector('.training-strip') && !!document.querySelector('.training-next') && !document.querySelector('[data-training-plan]')`));
  await show(snapshot(1));
  await fill('[data-dashboard-filter="search"]','不存在');
  check('filters do not hide active task',await evaluate(`!!document.querySelector('.training-strip') && !document.querySelector('.cards')`));
  await fill('[data-dashboard-filter="search"]','');

  for (const [theme,scheme,width,height] of [['light','light',1360,760],['black','dark',1024,720],['system','light',1024,720],['system','dark',1600,900]]) {
    await click('.nav[data-page="settings"]'); await click(`input[name="theme"][value="${theme}"]`);
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme},{name:'prefers-reduced-motion',value:'no-preference'}]});
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await click('.nav[data-page="dashboard"]');
    const next=snapshot(1);next.settings.theme=theme;await show(next);
    await capture(`09-theme-${theme}-${scheme}-${width}`);
    check(`theme ${theme}/${scheme} at ${width} fits`,await fit());
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await click('.nav[data-page="modules"]'); await capture('10-modules-unchanged');
  check('module labels remain static',await evaluate(`[...document.querySelectorAll('.module-type-code')].length>0 && [...document.querySelectorAll('.module-type-code')].every(n=>getComputedStyle(n).animationName==='none')`));
  await click('.nav[data-page="dashboard"]'); await show(snapshot(1,false)); await capture('11-training-cleared');
  check('latest empty snapshot restores ordinary card',await evaluate(`!document.querySelector('.training-strip') && !!document.querySelector('.cards [data-key="${operator.operatorId}:${skill.skillId}"]')`));
  const switched=snapshot(1,false);
  const other=initial.gameData.operators.find(o=>o.operatorId==='180_amgoat');
  switched.account.training={operatorId:other.operatorId,skillId:other.skills[0].skillId,from:0,to:1};
  Object.assign(switched,native({game:initial.gameData,account:switched.account,unlimited:initial.settings.unlimitedItemIds}));
  await show(switched);await capture('12-task-switched');
  check('task change updates only the new operator and skill',await evaluate(`state.training.operator.operatorId==='180_amgoat' && document.querySelectorAll('.training-strip').length===1 && !!document.querySelector('.cards [data-key="${operator.operatorId}:${skill.skillId}"]')`));
  switched.training.skill.name='用于验证训练区域换行与边界的超长技能名称，文字完整可读且不会遮挡后续规划';
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:720,deviceScaleFactor:1,mobile:false});
  await show(switched);await capture('13-long-training-name');
  check('long training title wraps within narrow viewport',await fit());
  assert.deepEqual(runtimeErrors,[],'No renderer exceptions'); passed=true;
} finally {
  close();
  await writeFile(path.join(output,'report.json'),JSON.stringify({pass:passed,checks},null,2));
  if(child) {
    child.kill(); await pause(1500);
    if(path.dirname(profile)!==output) throw Error('Unsafe QA cleanup path');
    await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
