import { createHash, createHmac, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { AccountSnapshot, MasteryLevel, OwnedOperator } from '../domain/types';
import type { LocalStore, StoredCredentials } from './local-store';

const APP_CODE = '4ca99fa6b56cc2ba';
const HG_BASE = 'https://as.hypergryph.com';
const SKLAND_BASE = 'https://zonai.skland.com';
const USER_AGENT = 'Skland/1.32.1 (com.hypergryph.skland; build:103201004; Android 33; ) Okhttp/4.11.0';

interface ApiEnvelope<T> {
  code?: number;
  status?: number;
  message?: string;
  msg?: string;
  data: T;
}

interface RawBinding {
  uid: string;
  nickName?: string;
  channelName?: string;
  isDefault?: boolean;
}

interface RawCharacter {
  id: string;
  level?: number;
  exp?: number;
  evolvePhase?: number;
  mainSkillLevel?: number;
  skills?: Array<{ id: string; level: number }>;
  equips?: Array<{ id: string; level: number }>;
}

interface RawCultivate {
  characters?: RawCharacter[];
  items?: Array<{ id: string; count: number | string }>;
}

class HttpStatusError extends Error {
  constructor(readonly status: number, label: string) {
    super(`${label}：HTTP ${status}`);
  }
}

class ApiStatusError extends Error {
  constructor(readonly status: number | undefined, label: string, message: string) {
    super(`${label}：${message}`);
  }
}

export class SklandClient {
  private readonly deviceId = randomUUID().toUpperCase();

  constructor(private readonly store: LocalStore) {}

  async startQrLogin(): Promise<{ scanId: string; qrCode: string }> {
    const response = await this.request<{ scanId: string }>(`${HG_BASE}/general/v1/gen_scan/login`, {
      method: 'POST',
      body: JSON.stringify({ appCode: APP_CODE }),
      headers: { 'Content-Type': 'application/json' },
    });
    const scanId = response.scanId;
    return {
      scanId,
      qrCode: await QRCode.toDataURL(`hypergryph://scan_login?scanId=${scanId}`, { width: 320, margin: 1 }),
    };
  }

  async finishQrLogin(scanId: string, timeoutMs = 120_000): Promise<RawBinding[]> {
    const deadline = Date.now() + timeoutMs;
    let scanCode = '';
    while (Date.now() < deadline) {
      try {
        scanCode = (await this.request<{ scanCode: string }>(
          `${HG_BASE}/general/v1/scan_status?scanId=${encodeURIComponent(scanId)}`,
        )).scanCode;
        if (scanCode) break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    if (!scanCode) throw new Error('二维码已过期，请重新生成');

    const accessToken = (await this.request<{ token: string }>(`${HG_BASE}/user/auth/v1/token_by_scan_code`, {
      method: 'POST',
      body: JSON.stringify({ scanCode }),
      headers: { 'Content-Type': 'application/json' },
    })).token;
    const grant = await this.request<{ code: string }>(`${HG_BASE}/user/oauth2/v2/grant`, {
      method: 'POST',
      body: JSON.stringify({ appCode: APP_CODE, token: accessToken, type: 0 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const credential = await this.request<{ cred: string; token: string }>(
      `${SKLAND_BASE}/api/v1/user/auth/generate_cred_by_code`,
      {
        method: 'POST',
        body: JSON.stringify({ code: grant.code, kind: 1 }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    await this.store.writeCredentials({
      accessToken,
      cred: credential.cred,
      credToken: credential.token,
    });
    return this.getBindings();
  }

  async getBindings(): Promise<RawBinding[]> {
    const data = await this.signedGet<{ list: Array<{ appCode: string; defaultUid?: string; bindingList?: RawBinding[] }> }>(
      '/api/v1/game/player/binding',
    );
    const app = data.list.find(x => x.appCode === 'arknights');
    if (!app) throw new Error('森空岛账号未绑定《明日方舟》角色');
    return (app.bindingList ?? []).map(binding => ({
      ...binding,
      isDefault: binding.uid === app.defaultUid,
    }));
  }

  async fetchAccount(uid: string): Promise<AccountSnapshot> {
    if (!uid) throw new Error('请先选择要同步的游戏角色');
    const data = await this.signedGet<RawCultivate>(
      `/api/v1/game/cultivate/player?uid=${encodeURIComponent(uid)}`,
    );
    if (!Array.isArray(data.characters) || !Array.isArray(data.items)) {
      throw new Error('森空岛返回结构已变化：缺少 characters 或 items');
    }

    const merged = new Map<string, OwnedOperator>();
    for (const raw of data.characters) {
      let operatorId = raw.id.replace(/^char_/, '');
      if (/_amiya\d+$/.test(operatorId)) operatorId = '002_amiya';
      const current = merged.get(operatorId) ?? {
        operatorId,
        level: Number(raw.level ?? 0),
        experience: Math.max(0, Number(raw.exp ?? 0)),
        elitePhase: Number(raw.evolvePhase ?? 0),
        skillLevel: Number(raw.mainSkillLevel ?? 0),
        skills: [],
        modules: [],
      };
      current.level = Math.max(current.level, Number(raw.level ?? 0));
      current.experience = Math.max(current.experience ?? 0, Number(raw.exp ?? 0));
      current.elitePhase = Math.max(current.elitePhase, Number(raw.evolvePhase ?? 0));
      current.skillLevel = Math.max(current.skillLevel, Number(raw.mainSkillLevel ?? 0));
      for (const skill of raw.skills ?? []) {
        const skillId = skill.id.replace(/\[([0-9]+?)\]/g, '_$1');
        const masteryLevel = Math.max(0, Math.min(3, Number(skill.level ?? 0))) as MasteryLevel;
        const existing = current.skills.find(x => x.skillId === skillId);
        if (existing) existing.masteryLevel = Math.max(existing.masteryLevel, masteryLevel) as MasteryLevel;
        else current.skills.push({ skillId, masteryLevel });
      }
      for (const module of raw.equips ?? []) {
        const moduleId = module.id.replace(/\[([0-9]+?)\]/g, '_$1');
        const level = Math.max(0, Math.min(3, Number(module.level ?? 0)));
        const existing = current.modules?.find(item => item.moduleId === moduleId);
        if (existing) existing.level = Math.max(existing.level, level);
        else (current.modules ??= []).push({ moduleId, level });
      }
      merged.set(operatorId, current);
    }

    return {
      uid,
      syncedAt: new Date().toISOString(),
      operators: [...merged.values()],
      inventory: Object.fromEntries(
        data.items
          .map(item => [item.id, Number(item.count)] as const)
          .filter(([, count]) => Number.isFinite(count) && count >= 0),
      ),
    };
  }

  private async signedGet<T>(path: string): Promise<T> {
    let credentials = await this.store.readCredentials();
    if (!credentials) throw new Error('尚未连接森空岛');

    let refreshStage = 0;
    while (true) {
      let envelope: ApiEnvelope<T>;
      try {
        envelope = await this.rawSignedGet<T>(path, credentials);
      } catch (error) {
        if (!(error instanceof HttpStatusError) || error.status !== 401) throw error;
        envelope = { code: refreshStage === 0 ? 10000 : 10002, data: undefined as T };
      }

      const status = envelope.code ?? envelope.status;
      if (status === 10000 && refreshStage === 0) {
        try {
          credentials = await this.refreshCredToken(credentials);
          refreshStage = 1;
          continue;
        } catch (error) {
          if (!this.isCredentialFailure(error)) throw error;
        }
      }
      if ((status === 10000 || status === 10002) && refreshStage < 2) {
        try {
          credentials = await this.refreshCredentials(credentials);
          refreshStage = 2;
          continue;
        } catch (error) {
          if (!this.isCredentialFailure(error)) throw error;
          throw this.reauthenticationRequired();
        }
      }
      if ((status === 10000 || status === 10002) && refreshStage === 2) {
        throw this.reauthenticationRequired();
      }
      return this.unwrap(envelope, '森空岛请求失败');
    }
  }

  private async rawSignedGet<T>(path: string, credentials: StoredCredentials): Promise<ApiEnvelope<T>> {
    const timestamp = String(Math.floor(Date.now() / 1000) - 1);
    const url = new URL(`${SKLAND_BASE}${path}`);
    const headerCa = { platform: '3', timestamp, dId: this.deviceId, vName: '1.0.0' };
    const payload = `${url.pathname}${url.search.replace(/^\?/, '')}${timestamp}${JSON.stringify(headerCa)}`;
    const hmac = createHmac('sha256', credentials.credToken).update(payload).digest('hex');
    const sign = createHash('md5').update(hmac).digest('hex');
    const response = await fetch(url, {
      headers: {
        cred: credentials.cred,
        sign,
        platform: headerCa.platform,
        timestamp,
        dId: headerCa.dId,
        vName: headerCa.vName,
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) throw new HttpStatusError(response.status, '森空岛网络错误');
    return response.json() as Promise<ApiEnvelope<T>>;
  }

  private async refreshCredToken(credentials: StoredCredentials): Promise<StoredCredentials> {
    const data = await this.request<{ token: string }>(`${SKLAND_BASE}/api/v1/auth/refresh`, {
      headers: { cred: credentials.cred },
    });
    const next = { ...credentials, credToken: data.token };
    await this.store.writeCredentials(next);
    return next;
  }

  private async refreshCredentials(credentials: StoredCredentials): Promise<StoredCredentials> {
    const grant = await this.request<{ code: string }>(`${HG_BASE}/user/oauth2/v2/grant`, {
      method: 'POST',
      body: JSON.stringify({ appCode: APP_CODE, token: credentials.accessToken, type: 0 }),
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await this.request<{ cred: string; token: string }>(
      `${SKLAND_BASE}/api/v1/user/auth/generate_cred_by_code`,
      {
        method: 'POST',
        body: JSON.stringify({ code: grant.code, kind: 1 }),
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const next = { ...credentials, cred: data.cred, credToken: data.token };
    await this.store.writeCredentials(next);
    return next;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
    });
    if (!response.ok) throw new HttpStatusError(response.status, '网络请求失败');
    return this.unwrap(await response.json() as ApiEnvelope<T>, '接口请求失败');
  }

  private unwrap<T>(envelope: ApiEnvelope<T>, label: string): T {
    const status = envelope.code ?? envelope.status;
    if (status !== 0) {
      throw new ApiStatusError(status, label, envelope.message ?? envelope.msg ?? `错误码 ${status}`);
    }
    return envelope.data;
  }

  private isCredentialFailure(error: unknown): boolean {
    return error instanceof ApiStatusError
      || (error instanceof HttpStatusError && (error.status === 401 || error.status === 403));
  }

  private reauthenticationRequired(): Error {
    return new Error('森空岛认证已失效，自动续期失败。请立即重新认证');
  }
}
