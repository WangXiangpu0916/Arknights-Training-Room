import { app, safeStorage } from 'electron';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AccountSnapshot, Settings } from '../domain/types';

export interface StoredCredentials {
  accessToken: string;
  cred: string;
  credToken: string;
}

export class LocalStore {
  readonly root = app.getPath('userData');
  readonly gameDataDir = path.join(this.root, 'game-data');
  private readonly credentialPath = path.join(this.root, 'credentials.bin');
  private readonly settingsPath = path.join(this.root, 'settings.json');
  private readonly accountPath = path.join(this.root, 'account-cache.json');
  private readonly logPath = path.join(this.root, 'app.log');
  private credentialsLoaded = false;
  private cachedCredentials: StoredCredentials | null = null;

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.gameDataDir, { recursive: true });
  }

  async readSettings(): Promise<Settings> {
    const value = await this.readJson<Omit<Partial<Settings>, 'theme'> & { theme?: string }>(this.settingsPath);
    return {
      unlimitedItemIds: Array.isArray(value?.unlimitedItemIds)
        ? value.unlimitedItemIds.filter(x => typeof x === 'string')
        : [],
      selectedUid: typeof value?.selectedUid === 'string' ? value.selectedUid : undefined,
      autoRefresh: value?.autoRefresh === true,
      theme: value?.theme === 'dark' ? 'black' : value?.theme === 'black' || value?.theme === 'light' ? value.theme : 'system',
    };
  }

  async writeSettings(settings: Settings): Promise<void> {
    await this.writeJsonAtomic(this.settingsPath, settings);
  }

  async readAccount(): Promise<AccountSnapshot | null> {
    const value = await this.readJson<Partial<AccountSnapshot>>(this.accountPath);
    if (!value
      || typeof value.uid !== 'string'
      || typeof value.syncedAt !== 'string'
      || !Array.isArray(value.operators)
      || !value.inventory
      || typeof value.inventory !== 'object') return null;
    return {
      ...value,
      operators: value.operators.map(operator => ({
        ...operator,
        modules: Array.isArray(operator.modules) ? operator.modules : [],
      })),
    } as AccountSnapshot;
  }

  writeAccount(account: AccountSnapshot): Promise<void> {
    return this.writeJsonAtomic(this.accountPath, account);
  }

  async clearAccountCache(): Promise<void> {
    await rm(this.accountPath, { force: true });
  }

  async writeCredentials(credentials: StoredCredentials): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储当前不可用，拒绝保存森空岛凭据');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
    await writeFile(this.credentialPath, encrypted, { mode: 0o600 });
    this.cachedCredentials = credentials;
    this.credentialsLoaded = true;
  }

  async readCredentials(): Promise<StoredCredentials | null> {
    if (this.credentialsLoaded) return this.cachedCredentials;
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        this.credentialsLoaded = true;
        return null;
      }
      const encrypted = await readFile(this.credentialPath);
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as Partial<StoredCredentials>;
      if (typeof parsed.accessToken !== 'string'
        || typeof parsed.cred !== 'string'
        || typeof parsed.credToken !== 'string') {
        this.credentialsLoaded = true;
        return null;
      }
      this.cachedCredentials = parsed as StoredCredentials;
      this.credentialsLoaded = true;
      return this.cachedCredentials;
    } catch {
      this.credentialsLoaded = true;
      return null;
    }
  }

  async clearCredentials(): Promise<void> {
    await rm(this.credentialPath, { force: true });
    this.cachedCredentials = null;
    this.credentialsLoaded = true;
  }

  async log(event: string, detail = ''): Promise<void> {
    try {
      const size = await stat(this.logPath).then(x => x.size).catch(() => 0);
      if (size > 1_000_000) {
        await rm(`${this.logPath}.1`, { force: true });
        await rename(this.logPath, `${this.logPath}.1`);
      }
      const safeDetail = detail
        .replace(/((?:access[_-]?token|cred[_-]?token|cred|token|authorization|cookie|set-cookie|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)([^"'\s,;}{]+)/gi, '$1[REDACTED]')
        .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
        .replace(/\buid\s*=\s*[A-Za-z0-9_-]+\b/gi, 'uid=[REDACTED]')
        .replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]')
        .slice(0, 2000);
      await appendFile(this.logPath, `${new Date().toISOString()} ${event} ${safeDetail}\n`, 'utf8');
    } catch {
      // 日志失败不得影响规划。
    }
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rm(file, { force: true });
    await rename(temporary, file);
  }
}
