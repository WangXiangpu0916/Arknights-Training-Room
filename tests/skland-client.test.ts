import assert from 'node:assert/strict';
import test from 'node:test';
import { SklandClient } from '../src/data/skland-client';
import type { StoredCredentials } from '../src/data/local-store';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('HTTP 401 时自动刷新 cred_token 后重试', async () => {
  const originalFetch = globalThis.fetch;
  const credentials: StoredCredentials = { accessToken: 'access', cred: 'cred', credToken: 'expired' };
  let bindingCalls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error');
    const url = String(input);
    if (url.endsWith('/api/v1/auth/refresh')) return json({ code: 0, data: { token: 'fresh' } });
    if (url.includes('/api/v1/game/player/binding')) {
      bindingCalls += 1;
      return bindingCalls === 1
        ? json({}, 401)
        : json({ code: 0, data: { list: [{ appCode: 'arknights', bindingList: [{ uid: '123' }] }] } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    const store = {
      readCredentials: async () => credentials,
      writeCredentials: async (next: StoredCredentials) => Object.assign(credentials, next),
    };
    const bindings = await new SklandClient(store as never).getBindings();
    assert.equal(bindings[0].uid, '123');
    assert.equal(credentials.credToken, 'fresh');
    assert.equal(bindingCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('两级凭据续期均失败时提示重新认证', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    return json({}, 401);
  };

  try {
    const store = {
      readCredentials: async () => ({ accessToken: 'expired', cred: 'expired', credToken: 'expired' }),
      writeCredentials: async () => undefined,
    };
    await assert.rejects(
      new SklandClient(store as never).getBindings(),
      /认证已失效.*自动续期失败.*重新认证/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
