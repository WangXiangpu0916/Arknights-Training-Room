import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_EXPANDED_BYTES, MAX_PACKAGE_BYTES, ResourceManifest, SnapshotManifest } from './schema';
import { safeResourcePath, sha256 } from './validation';

// A bounded gzip JSON container: regular files only, no executable code, links or archive metadata.
export async function packSnapshot(directory: string, manifest: SnapshotManifest): Promise<Buffer> {
  const files: Record<string, string> = {};
  for (const name of Object.keys(manifest.files).sort()) files[name] = (await readFile(path.join(directory, name))).toString('base64');
  return gzipSync(Buffer.from(JSON.stringify({ format: 'training-room-resource-1', manifest, files })), { level: 9 });
}

export async function unpackSnapshot(bytes: Buffer, directory: string, expected: ResourceManifest): Promise<void> {
  if (bytes.length > MAX_PACKAGE_BYTES || bytes.length !== expected.package.size || sha256(bytes) !== expected.package.sha256) {
    throw new Error('资源包大小或 SHA-256 不匹配，保留当前资源。');
  }
  const envelope = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8'));
  const { package: _package, ...snapshotManifest } = expected;
  if (envelope.format !== 'training-room-resource-1' || JSON.stringify(envelope.manifest) !== JSON.stringify(snapshotManifest)
    || !envelope.files || typeof envelope.files !== 'object' || Array.isArray(envelope.files)
    || Object.keys(envelope.files).length !== Object.keys(expected.files).length) throw new Error('资源包结构或清单不一致');
  for (const [name, content] of Object.entries(envelope.files)) {
    safeResourcePath(name);
    const info = expected.files[name];
    if (!info || typeof content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error(`资源包文件无效：${name}`);
    const file = Buffer.from(content, 'base64');
    if (file.length !== info.size || sha256(file) !== info.sha256) throw new Error(`资源包文件损坏：${name}`);
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file);
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(snapshotManifest, null, 2));
}
