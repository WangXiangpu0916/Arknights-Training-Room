import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { unpackSnapshot } from '../src/resources/package';
import { ResourceManifest, SnapshotManifest } from '../src/resources/schema';
import { sha256 } from '../src/resources/validation';

function resourcePackage(content: string) {
  const file = Buffer.from(content, 'base64');
  const snapshot: SnapshotManifest = {
    resourceVersion: '2026.09.12.1', schemaVersion: 1, buildTime: '2026-09-12T00:00:00.000Z', minAppVersion: '0.1.1',
    sources: [{ repository: 'https://github.com/example/game', commit: 'a'.repeat(40) }],
    files: { 'data/game.json': { size: file.length, sha256: sha256(file) } }, fallbacks: { skills: [] },
  };
  const bytes = gzipSync(Buffer.from(JSON.stringify({ format: 'training-room-resource-1', manifest: snapshot, files: { 'data/game.json': content } })));
  const manifest: ResourceManifest = { ...snapshot, package: { url: 'https://example.com/resource.atr.gz', size: bytes.length, sha256: sha256(bytes) } };
  return { bytes, manifest };
}

test('资源包解包：大文件 Base64 校验不会耗尽调用栈', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-package-'));
  try {
    const file = Buffer.from(JSON.stringify({ text: 'a'.repeat(8 * 1024 * 1024) }));
    const { bytes, manifest } = resourcePackage(file.toString('base64'));
    await unpackSnapshot(bytes, root, manifest);
    assert.deepEqual(await readFile(path.join(root, 'data/game.json')), file);
    const { package: _package, ...snapshot } = manifest;
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')), snapshot);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});

test('资源包解包：接受标准 Base64，拒绝非法字符、填充和非规范编码', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atr-resource-package-'));
  try {
    for (const content of ['TQ==', 'TWE=', 'TWFu']) {
      const { bytes, manifest } = resourcePackage(content);
      await unpackSnapshot(bytes, root, manifest);
      assert.deepEqual(await readFile(path.join(root, 'data/game.json')), Buffer.from(content, 'base64'));
    }
    for (const content of ['TQ==\n', 'TQ', 'T%Q==', '=TQ=', 'TQ===', 'AB==']) {
      const { bytes, manifest } = resourcePackage(content);
      await assert.rejects(unpackSnapshot(bytes, root, manifest), /资源包文件无效/, content);
    }
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
