import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function lockInputs(root) {
  const files = {};
  async function scan(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Input symlink refused: ${name}`);
      if (entry.isDirectory()) await scan(name);
      else files[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
    }
  }
  await scan('game-data'); await scan('images');
  files['notices.md'] = createHash('sha256').update(await readFile(path.join(root, 'notices.md'))).digest('hex');
  files['module-icons.lock.json'] = createHash('sha256').update(await readFile(path.join(root, 'module-icons.lock.json'))).digest('hex');
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  await writeFile(path.join(root, 'resource-inputs.json'), JSON.stringify(sorted, null, 2));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await lockInputs(path.resolve(process.argv[2] ?? 'resources')));
