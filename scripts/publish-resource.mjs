import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateManifest, sha256, loadSnapshot } = require('../dist/src/resources/validation.js');
const directory = path.resolve(process.argv[2] ?? 'resource-publish');
const appVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), appVersion);
const tag = `resource-${manifest.resourceVersion}`;
const expected = `https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/${tag}/resource.atr.gz`;
if (manifest.package.url !== expected) throw new Error('Resource package URL does not match its immutable release');
const bytes = await readFile(path.join(directory, 'resource.atr.gz'));
if (bytes.length !== manifest.package.size || sha256(bytes) !== manifest.package.sha256) throw new Error('Resource package checksum mismatch');
const { package: _package, ...expectedSnapshot } = manifest;
await loadSnapshot(path.join(directory, 'snapshot'), appVersion, undefined, expectedSnapshot);
const gh = args => execFileSync('gh', args, { stdio: 'inherit', windowsHide: true });
const exists = name => { try { execFileSync('gh', ['release', 'view', name], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } };
const notes = path.join(directory, 'release-notes.md');
await writeFile(notes, `Training Room Resource ${manifest.resourceVersion}\n\nSchema ${manifest.schemaVersion}; requires App ${manifest.minAppVersion} or later.\nFull validated snapshot with data, metadata and images. App version is unchanged.\n\nSHA-256: ${manifest.package.sha256}\n`);
if (exists(tag)) {
  // Never replace bytes behind an already published resourceVersion.
  const remote = execFileSync('gh', ['api', `repos/WangXiangpu0916/Arknights-Training-Room/releases/tags/${tag}`], { encoding: 'utf8', windowsHide: true });
  const release = JSON.parse(remote);
  if (!release.draft) throw new Error(`Resource ${tag} already exists; choose a new resourceVersion`);
} else gh(['release', 'create', tag, '--draft', '--prerelease', '--title', `Resource ${manifest.resourceVersion}`, '--notes-file', notes]);
gh(['release', 'upload', tag, path.join(directory, 'resource.atr.gz'), path.join(directory, 'manifest.json'), '--clobber']);
gh(['release', 'edit', tag, '--draft=false', '--prerelease']);
if (!exists('resources-latest')) gh(['release', 'create', 'resources-latest', '--draft', '--prerelease', '--title', 'Training Room Resource update channel', '--notes', 'Latest validated resource manifest. Application updates use separate v* releases.']);
// The pointer changes only AFTER the immutable package has been published.
gh(['release', 'upload', 'resources-latest', path.join(directory, 'manifest.json'), '--clobber']);
gh(['release', 'edit', 'resources-latest', '--draft=false', '--prerelease']);
