import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const bootstrap = readFileSync('renderer/theme-bootstrap.js', 'utf8');

function bootTheme(search: string): string {
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  vm.runInNewContext(bootstrap, {
    document,
    URLSearchParams,
    window: { location: { search } },
  });
  return document.documentElement.dataset.theme;
}

test('首屏主题引导保留固定主题且仅在 system 时跟随系统', () => {
  assert.equal(bootTheme('?theme=light'), 'light');
  assert.equal(bootTheme('?theme=black'), 'black');
  assert.equal(bootTheme('?theme=system'), 'system');
  assert.equal(bootTheme(''), 'system');
  assert.equal(bootTheme('?theme=invalid'), 'system');
});
