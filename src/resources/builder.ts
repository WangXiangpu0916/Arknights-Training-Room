import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolboxResourceConverter } from './converter';
import { ResourceManifest, ResourceSource, SnapshotManifest } from './schema';
import { listResourceFiles, loadSnapshot, sha256 } from './validation';
import { packSnapshot } from './package';

export interface BuildOptions {
  input: string;
  output: string;
  resourceVersion: string;
  buildTime: string;
  minAppVersion: string;
  sources: ResourceSource[];
  packageUrl: string;
  previous?: string;
}

export async function buildResource(options: BuildOptions): Promise<ResourceManifest> {
  const { input, output } = options;
  if (path.resolve(input) === path.resolve(output) || path.resolve(input).startsWith(`${path.resolve(output)}${path.sep}`)) throw new Error('资源构建输出不能覆盖输入');
  const directory = path.join(output, 'snapshot');
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, 'data'), { recursive: true });
  // Freeze every input before conversion; no converter performs network requests.
  const frozen = path.join(output, 'frozen-input');
  await rm(frozen, { recursive: true, force: true });
  await cp(input, frozen, { recursive: true });
  try {
    const inputHashes = JSON.parse(await readFile(path.join(frozen, 'resource-inputs.json'), 'utf8')) as Record<string, string>;
    const inputFiles = (await listResourceFiles(frozen)).filter(n => n.startsWith('game-data/') || n.startsWith('images/') || n === 'notices.md' || n === 'module-icons.lock.json');
    if (inputFiles.length !== Object.keys(inputHashes).length) throw new Error('固定输入清单不完整，请先锁定输入');
    for (const name of inputFiles) {
      if (sha256(await readFile(path.join(frozen, name))) !== inputHashes[name]) throw new Error(`固定输入校验失败：${name}`);
    }
    const data = await new ToolboxResourceConverter().convert(path.join(frozen, 'game-data'));
    data.version = options.resourceVersion;
    data.updatedAt = options.buildTime;
    await writeFile(path.join(directory, 'data/game.json'), JSON.stringify(data));
    await mkdir(path.join(directory, 'metadata'), { recursive: true });
    const provenance = {
      inputsSha256: sha256(JSON.stringify(Object.fromEntries(Object.entries(inputHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))),
      prts: JSON.parse(await readFile(path.join(frozen, 'images/prts-assets.json'), 'utf8')),
      professions: JSON.parse(await readFile(path.join(frozen, 'images/profession-hd/source.json'), 'utf8')),
      moduleIcons: JSON.parse(await readFile(path.join(frozen, 'module-icons.lock.json'), 'utf8')),
    };
    await writeFile(path.join(directory, 'metadata/provenance.json'), JSON.stringify(provenance));
    await cp(path.join(frozen, 'notices.md'), path.join(directory, 'metadata/notices.md'));
    await cp(path.join(frozen, 'images'), path.join(directory, 'images'), { recursive: true });
    for (const name of await listResourceFiles(path.join(directory, 'images'))) {
      if (!/\.(png|svg)$/.test(name)) await rm(path.join(directory, 'images', name));
    }
    const files: SnapshotManifest['files'] = {};
    for (const name of await listResourceFiles(directory)) {
      const bytes = await readFile(path.join(directory, name));
      files[name] = { size: bytes.length, sha256: sha256(bytes) };
    }
    const skills = [...new Set(data.operators.flatMap(o => o.skills.map(s => s.skillId)))];
    const manifest: SnapshotManifest = {
      resourceVersion: options.resourceVersion, schemaVersion: 1, buildTime: options.buildTime,
      minAppVersion: options.minAppVersion, sources: options.sources, files,
      fallbacks: { skills: skills.filter(id => !files[`images/skill/${id}.png`]).sort() },
    };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const previous = options.previous ? await loadSnapshot(options.previous, options.minAppVersion) : undefined;
    await loadSnapshot(directory, options.minAppVersion, previous?.data);
    const bytes = await packSnapshot(directory, manifest);
    const remote = { ...manifest, package: { url: options.packageUrl, size: bytes.length, sha256: sha256(bytes) } };
    await writeFile(path.join(output, 'resource.atr.gz'), bytes);
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(remote, null, 2));
    return remote;
  } finally { await rm(frozen, { recursive: true, force: true }); }
}
