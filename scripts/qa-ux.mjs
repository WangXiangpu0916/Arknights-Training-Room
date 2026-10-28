import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
// Build debug first, then run node scripts/qa-ux.mjs. No credentials are copied.
// ATR_QA_PORT optionally connects to an already-running isolated QA session.
const output = path.resolve(process.env.ATR_QA_OUTPUT || 'output/playwright/ux-regression');
await mkdir(output, {recursive:true});
let child, profile;
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
  child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,ATR_USER_DATA:profile,ATR_QA_PORT:String(port)}});
  child.on('error', error => { console.error(error.message); });
  process.on('exit', () => { if(child.exitCode===null) child.kill(); });
}
let target;
for (let attempt = 0; attempt < 100 && !target; attempt++) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).catch(() => []);
  target = targets.find(t => t.type === 'page' && t.url.includes('renderer/index.html'));
  if (!target) await new Promise(resolve => setTimeout(resolve, 200));
}
if (!target) throw Error('No training room page');
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

const checks=[];
let passed=false;
const check=async(name,expression)=>{
  const deadline=Date.now()+10000;
  while (!(await evaluate(expression))) { assert.ok(Date.now()<deadline,name); await pause(50); }
  checks.push(name);console.log('PASS '+name);
};
try {
  await send('Runtime.enable');
  for(let attempt=0;attempt<100 && !(await evaluate(`typeof state!=='undefined' && !!state?.account`));attempt++) await pause(100);
  for(const page of ['dashboard','promotion','modules']) {
    await click(`.nav[data-page="${page}"]`);
    const selector=page==='dashboard'?'[data-dashboard-filter="search"]':'[data-planner-filter="search"]';
    await click(selector); await evaluate('window.originalSearch=document.activeElement');
    await send('Input.insertText',{text:'银'}); await send('Input.insertText',{text:'灰'});
    await check(page+' continuous typing',`originalSearch===document.activeElement && originalSearch.isConnected && originalSearch.value==='银灰'`);
    await fill(selector,'不存在的干员');
    await check(page+' empty reset',`!!document.querySelector('.empty') && !!document.querySelector('[data-reset-planner]')`);
    await click('[data-reset-planner]');
    await check(page+' reset returns candidates',`document.querySelectorAll('.candidate').length>0`);
    await click('.candidate');
    await check(page+' modal focus',`modal.contains(document.activeElement) && modal.open`);
    await key('Tab','Tab',1,9);
    await check(page+' modal focus wrap',`modal.contains(document.activeElement)`);
    await key('Escape','Escape',0,27);
    await check(page+' modal escape return',`modal.classList.contains('hidden') && document.activeElement.matches('.candidate') && !modal.open`);
  }
  await click('.nav[data-page="dashboard"]');
  // Force a distinguishable result in the unused source to expose wrong-mode lookup.
  await evaluate(`window.oldSingle=state.single; state.single=state.single.map(c=>({...c,skill:{...c.skill,name:'错误的无限池详情'}}))`);
  await click('.candidate');
  await check('detail uses real inventory source',`!modalContent.innerText.includes('错误的无限池详情')`);
  await key('Escape','Escape',0,27); await evaluate('state.single=window.oldSingle');
  await click('.nav[data-page="operators"]'); await click('[data-operator-panel-trigger]');
  await click('[data-operator-filter-option]'); await key('Escape','Escape',0,27);
  await check('filter escape',`document.querySelector('[data-operator-filter-panel]').hidden`);
  await click('.nav[data-page="settings"]');
  await click('input[name="theme"][value="light"]'); await pause(300);
  await check('theme persisted',`state.settings.theme==='light' && document.documentElement.dataset.theme==='light'`);
  await evaluate(`window.originalUpdateSettings=api.updateSettings; api.updateSettings=async()=>{throw Error('测试：保存失败')}`);
  await click('input[name="theme"][value="black"]');
  await check('save failure rolls back',`document.querySelector('input[name="theme"][value="light"]').checked && document.querySelector('#toast').innerText.includes('设置未保存')`);
  await evaluate('api.updateSettings=window.originalUpdateSettings');
  await click('input[name="theme"][value="black"]'); await pause(300);
  await click('.nav[data-page="dashboard"]');
  await evaluate(`api.updateSettings=()=>new Promise(resolve=>window.resolveSettings=resolve);window.settingsSnapshot=state`);
  await click('[data-unlimited-summaries] + span');
  await click('.nav[data-page="settings"]');
  await evaluate('resolveSettings(settingsSnapshot)'); await pause(100);
  await check('saving survives page navigation', `page==='settings' && !!document.querySelector('.settings-list') && !settingsSaving`);
  await evaluate('api.updateSettings=originalUpdateSettings');
  await click('.nav[data-page="inventory"]');
  await evaluate(`window.originalMaterialDetail=api.materialDetail; api.materialDetail=async()=>{throw Error('测试：读取失败')}`);
  await click('[data-inventory-item]:not(.selected)');
  await check('detail error has retry, no stale loading',`!!document.querySelector('[data-retry-detail]') && !document.querySelector('.inventory-detail-loading')`);
  await evaluate('api.materialDetail=window.originalMaterialDetail'); await click('[data-retry-detail]'); await pause(250);
  await check('detail retry succeeds',`!!document.querySelector('.inventory-detail-body') && !document.querySelector('[data-retry-detail]')`);
  // Delay and fail only the bridge in this isolated QA page; no real login is fabricated.
  await click('.nav[data-page="settings"]');
  await evaluate(`window.originalStart=api.startQrLogin; window.originalFinish=api.finishQrLogin; window.originalCancel=api.cancelQrLogin; window.cancelCount=0; api.startQrLogin=()=>new Promise(r=>window.resolveQr=r); api.cancelQrLogin=async()=>{window.cancelCount++}`);
  await click('[data-action="login"]'); await key('Escape','Escape',0,27);
  await check('login cancels immediately',`modal.classList.contains('hidden') && !document.querySelector('[data-action="login"]').disabled && cancelCount===1`);
  await evaluate(`resolveQr({qrCode:'data:image/png;base64,',scanId:'cancelled'}); api.startQrLogin=async()=>{throw Error('测试：二维码已过期')}`);
  await click('[data-action="login"]');
  await check('login error retry',`!!document.querySelector('[data-retry-login]') && modalContent.innerText.includes('二维码已过期')`);
  await key('Escape','Escape',0,27);
  await evaluate('api.startQrLogin=originalStart;api.finishQrLogin=originalFinish;api.cancelQrLogin=originalCancel');
  await evaluate(`window.originalRefresh=api.refreshAccount; window.loginSnapshot=state;
    api.startQrLogin=async()=>({scanId:'qa-ui-only',qrCode:''});
    api.finishQrLogin=async()=>[{uid:'qa-role-a',nickName:'测试角色 A'},{uid:'qa-role-b',nickName:'测试角色 B',isDefault:true}];
    api.refreshAccount=async uid=>{window.confirmedUid=uid;return loginSnapshot}`);
  await click('[data-action="login"]');
  await check('login role selection default', `document.querySelector('#binding-select').value==='qa-role-b'`);
  await capture('state-role-selection');
  await click('#binding-confirm');
  await check('login role confirmation returns dashboard', `window.confirmedUid==='qa-role-b' && page==='dashboard' && !modal.open`);
  await evaluate('api.startQrLogin=originalStart;api.finishQrLogin=originalFinish;api.refreshAccount=originalRefresh');
  await click('.nav[data-page="dashboard"]');
  await click('[data-continuous-mode] + span');
  await check('continuous mastery', `mode==='continuous' && currentMasteryCandidates().every(c=>c.to-c.from>=2)`);
  await click('.candidate'); await capture('after-continuous-detail'); await key('Escape','Escape',0,27);
  await click('[data-continuous-mode] + span');
  for (const page of ['promotion','modules']) {
    await click(`.nav[data-page="${page}"]`);
    await click('[data-planner-toggle="continuous"] + span');
    await check(page+' continuous route', `currentPlanCandidates('${page==='promotion'?'promotion':'module'}').every(c=>c.to-c.from>=2) && !!document.querySelector('.candidate')`);
    await click('.candidate'); await capture('after-'+page+'-detail'); await key('Escape','Escape',0,27);
    await click('[data-planner-toggle="continuous"] + span');
  }
  await click('.nav[data-page="dashboard"]');
  await click('[data-dashboard-filter="search"]');
  await send('Input.imeSetComposition',{text:'yinhui',selectionStart:6,selectionEnd:6});
  await check('IME keeps focus and candidates', `document.activeElement.matches('[data-dashboard-filter="search"]') && document.querySelectorAll('.candidate').length>0`);
  await send('Input.insertText',{text:'银灰'});
  await check('IME commits full search', `document.querySelector('[data-dashboard-filter="search"]').value==='银灰' && document.querySelectorAll('.candidate').length===1`);
  await capture('after-search'); await click('[data-reset-planner]');
  await click('[data-dashboard-filter="profession"]'); await key('ArrowDown','ArrowDown',0,40); await key('Enter','Enter',0,13);
  await check('native select filters', `dashboardFilters.profession!==''`);
  await click('[data-reset-planner]');
  await click('.nav[data-page="statistics"]'); await click('[data-statistics-scope="owned"]');
  await check('statistics scope', `statisticsScope==='owned' && document.activeElement.dataset.statisticsScope==='owned'`);
  await click('[data-statistics-scope="all"]');
  await click('.nav[data-page="inventory"]');
  await fill('[data-inventory-search]','源岩');
  await check('inventory search', `document.querySelectorAll('[data-inventory-item]').length>0`);
  const unlimitedMaterial = await evaluate(`([...document.querySelectorAll('[data-inventory-item]')].find(el=>state.unlimitedEligibleItemIds.includes(el.dataset.inventoryItem))).dataset.inventoryItem`);
  await click(`[data-inventory-item="${unlimitedMaterial}"]`);
  const inventoryBefore=await evaluate(`JSON.stringify(state.account.inventory)`);
  await click('[data-inventory-unlimited] + span'); await pause(250);
  await check('infinite supply persists', `state.settings.unlimitedItemIds.includes(inventorySelectedId)`);
  assert.equal(await evaluate(`JSON.stringify(state.account.inventory)`),inventoryBefore);
  await capture('after-inventory-unlimited');
  await click('[data-inventory-unlimited] + span'); await pause(250);
  await fill('[data-inventory-search]','');
  await click('.nav[data-page="operators"]'); await click('[data-operator-panel-trigger]'); await capture('after-filters');
  await click('[data-operator-filter-option]'); await capture('after-filter-selected');
  await key('Escape','Escape',0,27); await click('[data-operator-reset]');
  await click('[data-operator-sort="name"]');
  await check('operator sorting', `operatorFilters.sort==='name-asc'`);
  await click('[data-operator-sort="training"]');
  // Deterministic failures/delays at the bridge exercise renderer feedback, not server auth.
  await click('.nav[data-page="inventory"]');
  await evaluate(`api.materialDetail=()=>new Promise(r=>window.resolveDetail=r)`);
  await click('[data-inventory-item]:not(.selected)'); await capture('state-detail-loading');
  await check('loading indicator moves', `getComputedStyle(document.querySelector('.inventory-detail-loading'),'::before').animationName==='busy-spin'`);
  await evaluate(`api.materialDetail=async()=>{throw Error('测试：网络暂时不可用')}`);
  await click('[data-inventory-item]:not(.selected)'); await capture('state-detail-error');
  await evaluate('api.materialDetail=originalMaterialDetail'); await click('[data-retry-detail]'); await pause(250);
  await click('.nav[data-page="settings"]'); await click('input[name="theme"][value="light"]');await pause(250);await capture('state-save-success');
  await evaluate(`api.updateSettings=async()=>{throw Error('测试：无法写入设置')}`);
  await click('input[name="theme"][value="black"]'); await capture('state-save-error');
  await evaluate('api.updateSettings=originalUpdateSettings'); await click('input[name="theme"][value="black"]'); await pause(250);
  await evaluate(`window.savedUpdate=updateState`);
  for(const phase of ['checking','downloading','ready','error']) {
    await evaluate(`updateState={...savedUpdate,phase:'${phase}',availableVersion:'0.1.0',progress:42,message:'${phase==='error'?'测试：更新服务暂不可用，请重试':'测试：更新状态预览'}'};renderSettings()`);
    if(phase==='downloading') await check('native update progress is 42 percent', `document.querySelector('.update-progress') instanceof HTMLProgressElement && document.querySelector('.update-progress').position===0.42`);
    await capture('state-update-'+phase);
  }
  await evaluate('updateState=savedUpdate;renderSettings()');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await click('.nav[data-page="dashboard"]'); await click('.candidate');
  await check('reduced motion', `getComputedStyle(document.querySelector('.modal-panel')).animationName==='none' && getComputedStyle(document.querySelector('.candidate')).transitionDuration==='0s'`);
  await key('Escape','Escape',0,27);
  await send('Emulation.setEmulatedMedia',{features:[]});
  for(const width of [1344,768,390,320]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:width>700?761:844,deviceScaleFactor:1,mobile:false});
    for(const page of ['dashboard','promotion','modules','statistics','operators','inventory','settings']) {
      await click(`.nav[data-page="${page}"]`); await pause(200);
      await check(`${width}px ${page} navigation and fit`, `document.querySelector('.nav.active').dataset.page==='${page}' && document.querySelector('main').scrollWidth===document.querySelector('main').clientWidth`);
      if(width===1344 || width===390) await capture(`after-${width===390?'mobile-':''}${page}`);
    }
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await click('input[name="theme"][value="light"]');await pause(250);
  await click('.nav[data-page="inventory"]'); await capture('after-light-inventory');
  await click('.nav[data-page="settings"]'); await click('input[name="theme"][value="black"]');await pause(250);
  // Only the system confirmation is substituted; cache deletion uses the real isolated backend.
  await evaluate(`window.originalConfirm=window.confirm;window.confirm=()=>false`);
  await click('[data-action="clear-cache"]');
  await check('cancel cache clearing retains account', `!!state.account`);
  await evaluate(`window.confirm=()=>true`);
  await click('[data-action="clear-cache"]');
  await check('confirmed cache clearing', `state.account===null`);
  await evaluate('window.confirm=originalConfirm');
  await click('.nav[data-page="dashboard"]');
  await check('first launch login entry', `!!document.querySelector('.empty [data-action="login"]')`);
  await capture('state-first-launch');
  assert.deepEqual(runtimeErrors,[], 'No unhandled renderer errors');
  passed=true;

} finally {
  close();
  await writeFile(path.join(output,'report.json'),JSON.stringify({pass:passed,checks,passed:checks.length},null,2));
  if(child) {
    child.kill(); await pause(1500);
    if(path.dirname(profile)!==output) throw Error('Unsafe QA cleanup path');
    await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
