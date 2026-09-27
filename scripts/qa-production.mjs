import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';

const portable=process.argv.includes('--portable');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const executable=path.resolve(portable ? `release/Arknights-Training-Room-${version}-Portable-x64.exe` : 'release/win-unpacked/训练室.exe');
const profile=await mkdtemp(path.join(tmpdir(),'atr-production-'));
const userData=path.join(profile,'arknights-training-room');
await mkdir(userData);await cp('qa-fixture',userData,{recursive:true});
const settings=JSON.parse(await readFile(path.join(userData,'settings.json'),'utf8'));settings.autoRefresh=false;
await writeFile(path.join(userData,'settings.json'),JSON.stringify(settings));
const original=await readFile(path.join(userData,'account-cache.json'));
const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const child=spawn(executable,[],{env:{...process.env,APPDATA:profile,ATR_USER_DATA:path.join(profile,'must-not-be-used'),ATR_QA_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',b=>errors+=b);let visible=false,mainPid=child.pid;
try {
  assert.ok(!(await readFile('release/win-unpacked/训练室.exe')).includes(Buffer.from('ATR_QA_PORT')),'QA feature must not be shipped');
  for(let i=0;i<60&&!visible;i++){
    assert.equal(child.exitCode,null,errors);
    const select=portable ? `$ids=@((Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Where-Object Name -eq '训练室.exe').ProcessId); $p=Get-Process -Id $ids -ErrorAction SilentlyContinue` : `$p=Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue`;
    const result=spawnSync('pwsh.exe',['-NoProfile','-Command',`${select}; if($p.MainWindowHandle -ne 0 -and $p.Responding -and $p.MainWindowTitle -eq '训练室'){Write-Output $p.Id}`],{encoding:'utf8',windowsHide:true});
    visible=/^\d+$/.test(result.stdout.trim());if(visible)mainPid=Number(result.stdout.trim());else await new Promise(r=>setTimeout(r,500));
  }
  assert.ok(visible,'Production window did not become visible');
  await new Promise(r=>setTimeout(r,3000));
  assert.deepEqual(await readFile(path.join(userData,'account-cache.json')),original);
  const manifest=JSON.parse(await readFile(path.join(userData,'game-data/manifest.json'),'utf8'));
  assert.equal(await fetch(`http://127.0.0.1:${port}/json`).then(()=>true,()=>false),false,'Production must ignore remote debugging environment');
  assert.equal(await readFile(path.join(profile,'must-not-be-used/settings.json')).then(()=>true,()=>false),false);
  assert.doesNotMatch(errors,/panicked|unhandled/i);
  const closed=spawnSync('pwsh.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${mainPid}; [void]$p.CloseMainWindow(); if(!$p.WaitForExit(10000)){exit 1}`],{encoding:'utf8',windowsHide:true});
  assert.equal(closed.status,0,closed.stderr);
  if(portable && child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>setTimeout(()=>reject(Error('Portable launcher did not exit')),15000))]);
  const report={pass:true,portable,visible,qaDisabled:true,legacyCachePreserved:true,resourceVersion:manifest.resourceVersion,gracefulExit:true};
  await mkdir('output/production-qa',{recursive:true});await writeFile(`output/production-qa/${portable?'portable-':''}report.json`,JSON.stringify(report,null,2));console.log(report);
} finally {
  if(child.exitCode===null){child.kill();await new Promise(r=>setTimeout(r,2000));}
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
