import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { unpackSnapshot } = require('../dist/src/resources/package.js');
const { loadSnapshot, validateManifest } = require('../dist/src/resources/validation.js');
const directory = path.resolve('output/resource-baseline');
await mkdir(directory, { recursive: true });
try { execFileSync('gh', ['release', 'view', 'resources-latest'], { stdio: 'ignore', windowsHide: true }); }
catch { console.log('No previously published resource; using the validated built-in baseline.'); process.exit(0); }
execFileSync('gh', ['release', 'download', 'resources-latest', '--pattern', 'manifest.json', '--dir', directory, '--clobber'], { stdio: 'inherit', windowsHide: true });
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), appVersion);
const url = new URL(manifest.package.url);
const match = /^\/WangXiangpu0916\/Arknights-Training-Room\/releases\/download\/(resource-[\d.]+)\/resource\.atr\.gz$/.exec(url.pathname);
if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) throw new Error('Untrusted resource baseline');
execFileSync('gh', ['release', 'download', match[1], '--pattern', 'resource.atr.gz', '--dir', directory, '--clobber'], { stdio: 'inherit', windowsHide: true });
const snapshot = path.join(directory, 'snapshot');
await rm(snapshot, { recursive: true, force: true });
await mkdir(snapshot, { recursive: true });
await unpackSnapshot(await readFile(path.join(directory, 'resource.atr.gz')), snapshot, manifest);
await loadSnapshot(snapshot, appVersion);
console.log(`Validated resource baseline: ${manifest.resourceVersion}`);
