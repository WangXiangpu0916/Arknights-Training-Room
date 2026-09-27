import { cp, mkdir, readdir, rename, rm, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const release = path.join(root,'release');
const unpacked = path.join(release,'win-unpacked');
const next = path.join(release,'.native-next');
const previous = path.join(release,'.native-previous');
const target = path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','release');
const version = JSON.parse(await readFile('package.json','utf8')).version;
if ((await readFile(path.join(target,'训练室.exe'))).includes(Buffer.from('ATR_QA_PORT'))) {
  throw new Error('拒绝同步启用了 qa feature 的测试程序；请先构建正式版本。');
}
const ps = value => `'${value.replaceAll("'", "''")}'`;
const check = spawnSync('pwsh.exe',['-NoProfile','-Command',`
  $exe = ${ps(path.join(unpacked,'训练室.exe'))}
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | ForEach-Object {
    if (!$_.CloseMainWindow()) { Stop-Process -Id $_.Id }
    if (!$_.WaitForExit(10000)) { Stop-Process -Id $_.Id -Force; $_.WaitForExit() }
  }
  $version = (Get-Item -LiteralPath ${ps(path.join(target,'训练室.exe'))}).VersionInfo.FileVersion
  if ($version -ne ${ps(version)}) { throw "Executable version mismatch: $version" }
`],{encoding:'utf8',windowsHide:true});
if (check.status !== 0) throw new Error(check.stderr || 'Could not stop the local app or verify its version');
// All replacement paths are fixed children of this workspace's release directory.
for (const directory of [next,previous,unpacked]) if (path.dirname(directory) !== release) throw new Error('Unsafe output path');
await mkdir(release,{recursive:true});
await rm(next,{recursive:true,force:true}); await mkdir(next);
await cp(path.join(target,'训练室.exe'),path.join(next,'训练室.exe'));
await cp('dist/resource/snapshot',path.join(next,'training-room-resource'),{recursive:true});
for (const file of ['LICENSE','THIRD_PARTY_NOTICES.md']) await cp(file,path.join(next,file));
await cp('dist/THIRD_PARTY_LICENSES.txt',path.join(next,'THIRD_PARTY_LICENSES.txt'));
await rm(previous,{recursive:true,force:true});
const exists = await stat(unpacked).then(()=>true,()=>false);
if (exists) await rename(unpacked,previous);
try { await rename(next,unpacked); }
catch (error) { if (exists) await rename(previous,unpacked); throw error; }
await rm(previous,{recursive:true,force:true});
const found = [];
async function scan(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(directory,entry.name);
    if (entry.name === 'win-unpacked') found.push(child);
    await scan(child);
  }
}
await scan(root);
if (found.length !== 1 || found[0] !== unpacked) throw new Error(`Expected exactly one win-unpacked directory: ${found.join(', ')}`);
console.log(`已同步 ${unpacked}，版本 ${version}；仓库中仅有一个 win-unpacked。`);
