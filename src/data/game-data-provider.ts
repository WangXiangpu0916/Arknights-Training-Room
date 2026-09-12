import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GameData } from '../domain/types';
import type { LocalStore } from './local-store';
import { MAX_PACKAGE_BYTES, RESOURCE_MANIFEST_URL, ResourceSnapshot, compareResourceVersions } from '../resources/schema';
import { loadSnapshot, safeResourcePath, validateManifest } from '../resources/validation';
import { unpackSnapshot } from '../resources/package';

export interface ResourceProviderOptions {
  bundledDirectory: string;
  appVersion: string;
  manifestUrl?: string;
  // Only main's unpackaged QA entry point may enable loopback HTTP fixtures.
  allowLoopback?: boolean;
  fetch?: typeof fetch;
}

export class ToolboxGameDataProvider {
  private active!: ResourceSnapshot;
  private previous?: ResourceSnapshot;
  private updatePromise?: Promise<GameData>;
  private readonly nextDir: string;
  private readonly backupDir: string;
  private readonly journal: string;
  constructor(private readonly store: Pick<LocalStore, 'gameDataDir' | 'log'>, private readonly options: ResourceProviderOptions) {
    this.nextDir = `${store.gameDataDir}.next`;
    this.backupDir = `${store.gameDataDir}.backup`;
    this.journal = `${store.gameDataDir}.transaction.json`;
  }

  async initialize(): Promise<GameData> {
    await mkdir(path.dirname(this.store.gameDataDir), { recursive: true });
    const interrupted = await readFile(this.journal).then(() => true).catch(() => false);
    if (interrupted) {
      const backup = await this.tryLoad(this.backupDir);
      if (backup) {
        await rm(this.store.gameDataDir, { recursive: true, force: true });
        await rename(this.backupDir, this.store.gameDataDir);
      }
      await rm(this.journal, { force: true });
      await this.store.log('resource-interrupted-update-recovered');
    }
    await rm(this.nextDir, { recursive: true, force: true });
    let current = await this.tryLoad(this.store.gameDataDir);
    if (!current) {
      const backup = await this.tryLoad(this.backupDir);
      if (backup) {
        await rm(this.store.gameDataDir, { recursive: true, force: true });
        await rename(this.backupDir, this.store.gameDataDir);
      } else {
        await loadSnapshot(this.options.bundledDirectory, this.options.appVersion);
        await cp(this.options.bundledDirectory, this.nextDir, { recursive: true });
        await loadSnapshot(this.nextDir, this.options.appVersion);
        await rm(this.store.gameDataDir, { recursive: true, force: true });
        await rename(this.nextDir, this.store.gameDataDir);
        await this.store.log('game-data-cache-recovered', '已迁移到完整内置资源快照');
      }
      current = await loadSnapshot(this.store.gameDataDir, this.options.appVersion);
    }
    this.active = current;
    this.previous = await this.tryLoad(this.backupDir);
    return current.data;
  }

  async load(): Promise<GameData> { return (await loadSnapshot(this.store.gameDataDir, this.options.appVersion)).data; }
  get assetBase(): string { return `atr-resource://snapshot/${this.active.manifest.resourceVersion}/images/`; }

  assetPath(version: string, name: string): string | undefined {
    const snapshot = this.active?.manifest.resourceVersion === version ? this.active
      : this.previous?.manifest.resourceVersion === version ? this.previous : undefined;
    if (!snapshot) return undefined;
    try { safeResourcePath(name); } catch { return undefined; }
    if (!name.startsWith('images/') || !snapshot.manifest.files[name]) return undefined;
    return path.join(snapshot.directory, name);
  }

  update(activate: (data: GameData) => Promise<void>): Promise<GameData> {
    if (this.updatePromise) return this.updatePromise;
    const pending = this.performUpdate(activate);
    this.updatePromise = pending;
    void pending.finally(() => { if (this.updatePromise === pending) this.updatePromise = undefined; }).catch(() => undefined);
    return pending;
  }

  private async performUpdate(activate: (data: GameData) => Promise<void>): Promise<GameData> {
    const manifest = validateManifest(JSON.parse((await this.download(this.options.manifestUrl ?? RESOURCE_MANIFEST_URL, 2 * 1024 * 1024, true)).toString('utf8')), this.options.appVersion);
    if (compareResourceVersions(manifest.resourceVersion, this.active.manifest.resourceVersion) <= 0) return this.active.data;
    const bytes = await this.download(manifest.package.url, MAX_PACKAGE_BYTES);
    await rm(this.nextDir, { recursive: true, force: true });
    await mkdir(this.nextDir, { recursive: true });
    try {
      await unpackSnapshot(bytes, this.nextDir, manifest);
      const { package: _package, ...expected } = manifest;
      const next = await loadSnapshot(this.nextDir, this.options.appVersion, this.active.data, expected);
      await rm(this.backupDir, { recursive: true, force: true });
      this.previous = undefined;
      // Presence means an uncommitted transaction. Startup restores the backup.
      await writeFile(this.journal, JSON.stringify({ from: this.active.manifest.resourceVersion, to: manifest.resourceVersion }));
      const old = this.active;
      let moved = false;
      try {
        await rename(this.store.gameDataDir, this.backupDir);
        moved = true;
        await rename(this.nextDir, this.store.gameDataDir);
        this.previous = { ...old, directory: this.backupDir };
        this.active = { ...next, directory: this.store.gameDataDir };
        await activate(next.data);
        await rm(this.journal, { force: true });
        // Keep one backup for recovery and requests from the previous renderer state.
        return next.data;
      } catch (error) {
        if (moved) {
          await rm(this.store.gameDataDir, { recursive: true, force: true });
          await rename(this.backupDir, this.store.gameDataDir);
        }
        this.active = old;
        this.previous = undefined;
        await activate(old.data);
        await rm(this.journal, { force: true });
        throw error;
      }
    } finally { await rm(this.nextDir, { recursive: true, force: true }); }
  }

  private async tryLoad(directory: string): Promise<ResourceSnapshot | undefined> {
    return loadSnapshot(directory, this.options.appVersion).catch(() => undefined);
  }

  private trustedUrl(url: string, initial: boolean, manifest = false): URL {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw new Error('资源地址不允许凭据');
    if (this.options.allowLoopback && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return parsed;
    if (parsed.protocol !== 'https:') throw new Error('资源更新仅允许 HTTPS');
    if (manifest && url !== RESOURCE_MANIFEST_URL) throw new Error('未受信任的资源清单地址');
    const repoPrefix = '/WangXiangpu0916/Arknights-Training-Room/releases/download/';
    if (parsed.hostname === 'github.com' && parsed.pathname.startsWith(repoPrefix)) return parsed;
    if (!initial && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) return parsed;
    throw new Error('未受信任的资源下载地址');
  }

  private async download(url: string, limit: number, manifest = false): Promise<Buffer> {
    let target = this.trustedUrl(url, true, manifest);
    const request = this.options.fetch ?? fetch;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await request(target, { redirect: 'manual', signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'Arknights-Training-Room' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('资源下载重定向缺少地址');
        target = this.trustedUrl(new URL(location, target).href, false);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`资源下载失败：HTTP ${response.status}，保留当前资源。`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > limit) { await response.body.cancel(); throw new Error('资源下载超过大小限制'); }
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of response.body as any) {
        size += part.length;
        if (size > limit) throw new Error('资源下载超过大小限制');
        chunks.push(Buffer.from(part));
      }
      return Buffer.concat(chunks);
    }
    throw new Error('资源下载重定向次数过多');
  }
}
