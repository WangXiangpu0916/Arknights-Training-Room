import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Run the optimized QA build with an anonymized account copy and no credentials.
const root = process.cwd();
const output = process.env.ATR_PERF_OUTPUT_DIRECTORY || path.join(root, 'output/performance/core-flow');
const label = process.argv[2] || 'baseline';
assert.match(label, /^[a-z0-9-]+$/);
const executable = process.env.ATR_PERF_EXECUTABLE || path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target', 'release/训练室.exe');
if (!process.env.ATR_PERF_EXECUTABLE) assert.ok((await readFile(executable)).includes(Buffer.from('ATR_QA_PORT')), 'Run npm run benchmark:desktop to build the optimized QA executable first');
const seed = path.join(output, 'seed');
const samples = Number(process.env.ATR_PERF_SAMPLES || 3);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rounded = n => Math.round(n * 10) / 10;
await mkdir(output, { recursive: true });
try { await readFile(path.join(seed, 'account-cache.json')); } catch {
  const source = process.env.ATR_PERF_PROFILE || path.join(process.env.APPDATA, 'arknights-training-room');
  const account = JSON.parse(await readFile(path.join(source, 'account-cache.json'), 'utf8'));
  const settings = JSON.parse(await readFile(path.join(source, 'settings.json'), 'utf8'));
  await mkdir(seed, { recursive: true });
  account.uid = 'performance-fixture'; account.nickname = '性能测试';
  await writeFile(path.join(seed, 'account-cache.json'), JSON.stringify(account));
  await writeFile(path.join(seed, 'settings.json'), JSON.stringify({ ...settings, selectedUid: account.uid, autoRefresh: false }));
  await cp(path.join(source, 'game-data'), path.join(seed, 'game-data'), { recursive: true });
  try { await cp(path.join(source, 'game-data.backup'), path.join(seed, 'game-data.backup'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const accountBytes = await readFile(path.join(seed, 'account-cache.json'));
const account = JSON.parse(accountBytes);
const game = JSON.parse(await readFile(path.join(seed, 'game-data/data/game.json'), 'utf8'));
const searchName = game.operators.find(op => op.name === '能天使' && account.operators.some(o => o.operatorId === op.operatorId))?.name
  || game.operators.find(op => account.operators.some(o => o.operatorId === op.operatorId))?.name;
const report = {
  label, generatedAt: new Date().toISOString(), version: JSON.parse(await readFile('package.json', 'utf8')).version,
  executable, logicalCpus: os.cpus().length, totalMemoryMiB: rounded(os.totalmem() / 2 ** 20),
  accountSha256: createHash('sha256').update(accountBytes).digest('hex'),
  operators: account.operators.length, gameOperators: game.operators.length, resourceVersion: game.version,
  searchName, runs: [],
};

const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
for (let run = 1; run <= samples; run++) {
  const runDir = path.join(output, `${label}-${run}-${Date.now()}`);
  await mkdir(runDir,{recursive:true});
  const profile = path.join(output, `${label}-profile`, 'arknights-training-room');
  if (run === 1) await cp(seed, profile, { recursive: true });
  // One persistent sampler avoids spawning a PowerShell process on every sample.
  const sampler = spawn('pwsh.exe', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'SilentlyContinue'
    while ($true) {
      $ids = [Collections.Generic.HashSet[int]]::new()
      Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${executable.replaceAll("'", "''")}' } | ForEach-Object { [void]$ids.Add($_.Id) }
      $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
      do { $changed=$false; foreach($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed=$true } } } while($changed)
      $rows = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | ForEach-Object {
        @{ pid=$_.Id; cpuSeconds=$_.CPU; workingSet=$_.WorkingSet64; privateBytes=$_.PrivateMemorySize64 }
      })
      @{ time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes=$rows } | ConvertTo-Json -Compress -Depth 3
      Start-Sleep -Milliseconds 250
    }
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let sampleText = ''; const processSamples = [];
  sampler.stdout.on('data', data => {
    sampleText += data;
    let end;
    while ((end = sampleText.indexOf('\n')) >= 0) {
      const line = sampleText.slice(0, end).trim(); sampleText = sampleText.slice(end + 1);
      if (line) processSamples.push(JSON.parse(line));
    }
  });
  await pause(350);
  const started = Date.now();
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: root, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      APPDATA: path.dirname(profile), ATR_USER_DATA: profile, ATR_QA_PORT:String(port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  let socket; let serial = 0; const pending = new Map(); const errors = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 60000;
    while (!(await evaluate(expression))) {
      if (Date.now() > deadline) throw new Error(`Wait failed: ${expression}`);
      await pause(25);
    }
  };
  try {
    let target;
    while (!target && Date.now() - started < 90000) {
      assert.equal(child.exitCode, null, stderr);
      target = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json()).then(t => t.find(t => t.type === 'page' && t.url.includes('renderer/index.html'))).catch(() => undefined);
      if (!target) await pause(25);
    }
    assert.ok(target, `No renderer: ${stderr}`);
    const targetMs = Date.now() - started;
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const item = pending.get(message.id); pending.delete(message.id);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    await send('Runtime.enable');
    await waitFor(`Boolean(typeof state !== 'undefined' && state?.account && !document.querySelector('#content .loading') && document.querySelector('.candidate'))`);
    const domReadyMs = Date.now() - started;
    await evaluate(`(() => {
      window.__perf = { tasks: [], frames: [], lastFrame: 0 };
      new PerformanceObserver(list => __perf.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({type:'longtask', buffered:true});
      requestAnimationFrame(function tick(t) { if (__perf.lastFrame) __perf.frames.push({start:__perf.lastFrame, duration:t-__perf.lastFrame}); __perf.lastFrame=t; requestAnimationFrame(tick); });
      window.__paint = async () => {
        await new Promise(r => requestAnimationFrame(r));
        const images = [...document.querySelectorAll('img')].filter(img => { if(!img.checkVisibility({contentVisibilityAuto:true})) return false; const b=img.getBoundingClientRect(); return b.width && b.height && b.bottom>0 && b.top<innerHeight && b.right>0 && b.left<innerWidth; });
        await Promise.all(images.map(img => img.decode().catch(() => {})));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      };
    })()`);
    await evaluate('__paint()');
    const startupMs = Date.now() - started;
    const result = { run, runDir, started, targetMs, domReadyMs, startupMs, steps: [] };
    await pause(3000);
    result.idleStart = Date.now();
    await pause(5000);
    result.idleEnd = Date.now();
    if (process.env.ATR_PERF_TRACE === '1' && run === 1) await send('Profiler.enable').then(() => send('Profiler.start'));
    const step = async (name, action, ready = 'true') => {
      await pause(200);
      const before = await evaluate('performance.now()');
      await action();
      await waitFor(ready);
      const domEnd = await evaluate('performance.now()');
      await evaluate('__paint()');
      const metrics = await evaluate(`(() => {
        const end = performance.now();
        const tasks = __perf.tasks.filter(e => e.start>=${before} && e.start<end);
        const frames = __perf.frames.filter(e => e.start>=${before} && e.start<end);
        const resources = performance.getEntriesByType('resource').filter(e => e.startTime>=${before}).sort((a,b)=>b.duration-a.duration).slice(0,5).map(e=>({name:e.name,duration:e.duration}));
        return {start:${before},end,domMs:${domEnd-before},paintMs:end-${before},longTasks:tasks,maxFrameMs:Math.max(0,...frames.map(e=>e.duration)),resources,rows:document.querySelectorAll('.operator-row,.candidate').length};
      })()`);
      result.steps.push({ name, ...metrics });
    };
    const click = async selector => {
      const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing '+${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; })()`);
      await send('Input.dispatchMouseEvent', { type:'mousePressed',button:'left',clickCount:1,...point });
      await send('Input.dispatchMouseEvent', { type:'mouseReleased',button:'left',clickCount:1,...point });
    };
    const nav = name => click(`.nav[data-page="${name}"]`);
    await step('operators', () => nav('operators'), `Boolean(document.querySelector('.operator-row'))`);
    result.workingStart = Date.now();
    await pause(3000);
    result.workingEnd = Date.now();
    await step('search', async () => { await click('[data-operator-search]'); await send('Input.insertText', {text:searchName}); }, `document.querySelector('[data-operator-search]').value===${JSON.stringify(searchName)}`);
    await step('clear-search', async () => {
      await send('Input.dispatchKeyEvent', {type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await send('Input.dispatchKeyEvent', {type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    }, `document.querySelector('[data-operator-search]').value===''`);
    await step('operators-scroll', async () => {
      for (let n=0;n<12;n++) { await send('Input.dispatchMouseEvent', {type:'mouseWheel',x:1000,y:650,deltaX:0,deltaY:350}); await pause(80); }
    });
    await step('mastery', () => nav('dashboard'), `Boolean(document.querySelector('.candidate'))`);
    await step('mastery-detail', () => click('.candidate'), `!document.querySelector('#modal').classList.contains('hidden')`);
    await step('close-detail', () => click('.modal-close'), `document.querySelector('#modal').classList.contains('hidden')`);
    await step('continuous', () => click('[data-continuous-mode]'), `document.querySelector('[data-continuous-mode]').checked`);
    await step('inventory', () => nav('inventory'), `Boolean(document.querySelector('.inventory-detail-content')) || !document.querySelector('.inventory-detail-loading')`);
    const itemSelector = await evaluate(`(() => { const e=[...document.querySelectorAll('[data-inventory-item]')].find(e=>e.dataset.inventoryItem==='30135') || document.querySelector('[data-inventory-item]'); return '[data-inventory-item="'+e.dataset.inventoryItem+'"]'; })()`);
    await step('material-detail', () => click(itemSelector), `!document.querySelector('.inventory-detail-loading')`);
    await step('promotion', () => nav('promotion'));
    await step('modules', () => nav('modules'));
    await step('statistics', () => nav('statistics'));
    await step('mastery-return', () => nav('dashboard'));
    const finished = Date.now();
    if (process.env.ATR_PERF_TRACE === '1' && run === 1) {
      const {profile:cpuProfile} = await send('Profiler.stop');
      await writeFile(path.join(runDir,'renderer.cpuprofile'),JSON.stringify(cpuProfile));
    }
    result.durationMs = finished-started;
    result.renderer = await evaluate(`({ tasks:__perf.tasks, framesOver50:__perf.frames.filter(e=>e.duration>50), paints:performance.getEntriesByType('paint').map(e=>({name:e.name,start:e.startTime})), heap:performance.memory.usedJSHeapSize, nodes:document.querySelectorAll('*').length })`);
    result.errors = errors;
    result.processSamples = processSamples.filter(s=>s.time>=started && s.time<=finished);
    let prior = {time:started,processes:[]};
    result.resourceSamples = result.processSamples.map(s => {
      const cpuSeconds = s.processes.reduce((sum,p)=>sum+(p.cpuSeconds||0),0);
      const previousCpu = prior.processes.reduce((sum,p)=>sum+(p.cpuSeconds||0),0);
      const workingSetMiB = s.processes.reduce((sum,p)=>sum+p.workingSet,0)/2**20;
      const privateMiB = s.processes.reduce((sum,p)=>sum+p.privateBytes,0)/2**20;
      const cpuPercent = Math.max(0,(cpuSeconds-previousCpu)*100000/(s.time-prior.time)/os.cpus().length);
      prior=s; return {time:s.time-started,cpuPercent,workingSetMiB,privateMiB,cpuSeconds};
    });
    assert.ok(result.resourceSamples.some(s=>s.workingSetMiB>0), 'Process sampler collected no app data');
    result.peakWorkingSetMiB = Math.max(...result.resourceSamples.map(s=>s.workingSetMiB));
    result.peakPrivateMiB = Math.max(...result.resourceSamples.map(s=>s.privateMiB));
    result.cpuSeconds = result.resourceSamples.at(-1).cpuSeconds;
    result.averageCpuPercent = result.cpuSeconds/(result.durationMs/1000)/os.cpus().length*100;
    const phase = (start,end) => {
      const values = result.resourceSamples.filter(s=>s.time+started>=start && s.time+started<=end);
      const average = key => values.reduce((sum,s)=>sum+s[key],0)/values.length;
      return { samples:values.length, workingSetMiB:average('workingSetMiB'), privateMiB:average('privateMiB'), cpuPercent:average('cpuPercent') };
    };
    result.idle = phase(result.idleStart,result.idleEnd);
    result.working = phase(result.workingStart,result.workingEnd);
    result.peakCpuPercent = Math.max(...result.resourceSamples.map(s=>s.cpuPercent));
    report.runs.push(result);
    await writeFile(path.join(output,`${label}.json`),JSON.stringify(report,null,2));
    const screenshot = await send('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(runDir,'mastery.png'),Buffer.from(screenshot.data,'base64'));
    console.log(JSON.stringify({label,run,startupMs,cpuSeconds:rounded(result.cpuSeconds),peakWorkingSetMiB:rounded(result.peakWorkingSetMiB),steps:result.steps.map(s=>[s.name,rounded(s.paintMs),rounded(s.maxFrameMs)])}));
    if (process.env.ATR_PERF_HOLD === '1' && run === samples) {
      console.log(`INSPECT port=${port} pid=${child.pid}`);
      await new Promise(resolve => { process.once('SIGINT',resolve); child.once('exit',resolve); });
    }
  } finally {
    socket?.close();
    sampler.kill();
    const closed = spawnSync('pwsh.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if($p){ [void]$p.CloseMainWindow(); if(!$p.WaitForExit(10000)){exit 2} }`],{windowsHide:true,encoding:'utf8'});
    if (closed.status !== 0) child.kill();
    await pause(2000);
    const ids = [...new Set(processSamples.flatMap(s=>s.processes.map(p=>p.pid)))];
    const residual = ids.length ? spawnSync('pwsh.exe',['-NoProfile','-Command',`@((Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue).Id) | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'}) : null;
    if(report.runs.at(-1)?.run === run){
      report.runs.at(-1).gracefulExit = closed.status === 0;
      report.runs.at(-1).residualPids = JSON.parse(residual?.stdout.trim() || '[]') ?? [];
      await writeFile(path.join(output,`${label}.json`),JSON.stringify(report,null,2));
    }
  }
}
