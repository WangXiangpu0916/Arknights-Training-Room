import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root=process.cwd(), release=path.join(root,'release');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const target=path.resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target','release');
const installers=await readdir(path.join(target,'bundle/nsis'));
const installer=installers.find(name=>name.endsWith('.exe') && name.includes(version));
if(!installer)throw new Error('Tauri NSIS installer is missing');
const setup=`Arknights-Training-Room-${version}-Setup-x64.exe`;
const portable=`Arknights-Training-Room-${version}-Portable-x64.exe`;
await cp(path.join(target,'bundle/nsis',installer),path.join(release,setup));
async function findCompiler(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])) {
    const file=path.join(directory,entry.name);
    if(entry.isFile() && entry.name.toLowerCase()==='makensis.exe')return file;
    if(entry.isDirectory() && !entry.isSymbolicLink()){const found=await findCompiler(file);if(found)return found;}
  }
}
const compiler=process.env.NSIS_PATH || await findCompiler(process.env.TAURI_BUNDLER_TOOLS_DIR || path.join(process.env.LOCALAPPDATA,'tauri'));
if(!compiler)throw new Error('NSIS compiler not found in the Tauri bundle cache; set NSIS_PATH to makensis.exe');
const built=spawnSync(compiler,['/V2','/INPUTCHARSET','UTF8',`/DOUTPUT=${path.join(release,portable)}`,`/DPAYLOAD=${path.join(release,'win-unpacked')}`,
  `/DICON=${path.join(root,'build/icon.ico')}`,`/DVERSION=${version}`,`/DNUMERIC_VERSION=${version.split('-')[0]}.0`,path.join(root,'build/nsis/portable.nsi')],
  {stdio:'inherit',windowsHide:true});
if(built.status!==0)throw built.error || new Error('Portable packaging failed');
const bytes=await readFile(path.join(release,setup));
const sha512=createHash('sha512').update(bytes).digest('base64');
const metadata=`version: ${version}\nfiles:\n  - url: ${setup}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${setup}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;
for(const channel of ['beta.yml','latest.yml'])await writeFile(path.join(release,channel),metadata);
const hashes=[];
for(const name of [setup,portable])hashes.push(`${createHash('sha256').update(await readFile(path.join(release,name))).digest('hex')}  ${name}`);
await writeFile(path.join(release,'SHA256SUMS.txt'),hashes.join('\n')+'\n');
const keep=new Set([setup,portable,'beta.yml','latest.yml','SHA256SUMS.txt','win-unpacked']);
for(const entry of await readdir(release,{withFileTypes:true})) {
  if(keep.has(entry.name))continue;
  const file=path.resolve(release,entry.name);
  if(path.dirname(file)!==release || entry.isSymbolicLink())throw new Error(`Unexpected release path: ${file}`);
  await rm(file,{recursive:entry.isDirectory(),force:true});
}
console.log(`已生成 ${setup}、${portable} 和兼容更新元数据；版本未改变。`);
