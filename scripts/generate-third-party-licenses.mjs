import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const result = spawnSync('cargo', ['metadata','--manifest-path','src-tauri/Cargo.toml','--format-version','1','--features','desktop','--filter-platform','x86_64-pc-windows-msvc','--locked'], {encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
if (result.status !== 0) throw result.error || new Error(result.stderr);
const metadata = JSON.parse(result.stdout);
const sections = [];
const reached = new Set();
const visit = id => { if (reached.has(id)) return; reached.add(id); for (const dep of metadata.resolve.nodes.find(n=>n.id===id)?.deps || []) visit(dep.pkg); };
visit(metadata.resolve.root);
// Include the whole locked native graph so conditional runtime dependencies are not omitted.
for (const dependency of metadata.packages.filter(p=>p.source && reached.has(p.id)).sort((a,b)=>a.name.localeCompare(b.name))) {
  const directory = path.dirname(dependency.manifest_path);
  const licenses = (await readdir(directory,{withFileTypes:true})).filter(e=>e.isFile() && /^(license|licence|copying|notice)([-_.].*)?$/i.test(e.name));
  const texts = [];
  for (const file of licenses) texts.push(`${file.name}\n${(await readFile(path.join(directory,file.name),'utf8')).trim()}`);
  if (dependency.license_file && !licenses.some(e=>e.name===dependency.license_file)) texts.push(await readFile(path.join(directory,dependency.license_file),'utf8'));
  if (!texts.length) {
    const fallback = path.join('build/licenses',`${dependency.name}.txt`);
    texts.push(await readFile(fallback,'utf8').catch(()=>{throw new Error(`Missing license text: ${dependency.name} ${dependency.version}`);}));
  }
  sections.push(`${dependency.name} ${dependency.version}\nDeclared license: ${dependency.license}\nSource: ${dependency.repository || dependency.source}\n\n${texts.join('\n\n')}`);
}
await mkdir('dist',{recursive:true});
await writeFile('dist/THIRD_PARTY_LICENSES.txt',`THIRD-PARTY RUST DEPENDENCY LICENSES\nGenerated from Cargo.lock. Asset notices are in THIRD_PARTY_NOTICES.md.\n\n${sections.join('\n\n'+'='.repeat(80)+'\n\n')}\n`);
console.log(`已收录 ${sections.length} 个原生依赖的许可证。`);
