import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const renderer = readFileSync('renderer/app.js', 'utf8');
const startIndex = renderer.indexOf('async function start()');
assert.ok(startIndex >= 0);
const startup = renderer.slice(startIndex);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: (value?: any) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function boot(cached: Promise<any>) {
  const live = deferred(), rendered: any[] = [], errors: string[] = [];
  const context: any = {
    state: undefined, updateState: undefined,
    api: { getCachedState: () => cached, initialUpdateState: { phase: 'idle' } },
    content: { innerHTML: '' }, esc: String,
    setState: (next: any) => { context.state = next; },
    render: () => { rendered.push(context.state); },
    showToast: (message: string) => errors.push(message),
    loadState: async () => {
      await live.promise;
      context.state = { revision: 0, fresh: true };
      context.render();
    },
  };
  vm.runInNewContext(startup, context);
  return { live, rendered, errors, context };
}

test('启动先显示缓存，后台加载完成后替换', async () => {
  const cached = { revision: -1, cached: true };
  const run = boot(Promise.resolve(cached));
  await tick();
  assert.deepEqual(run.rendered, [cached], '后台请求未完成时也应显示上次结果');
  run.live.resolve();
  await tick();
  assert.equal(run.context.state.fresh, true);
});

test('缓存读取慢时不会阻塞或覆盖已经加载的新状态', async () => {
  const cached = deferred();
  const run = boot(cached.promise);
  run.live.resolve();
  await tick();
  cached.resolve({ revision: -1 });
  await tick();
  assert.equal(run.rendered.length, 1);
  assert.equal(run.context.state.fresh, true);
});

test('缓存不可用时仍正常加载', async () => {
  const run = boot(Promise.resolve(null));
  run.live.resolve();
  await tick();
  assert.equal(run.context.state.fresh, true);
});

test('缓存读取失败时仍正常加载', async () => {
  const run = boot(Promise.reject(Error('cache unavailable')));
  await tick();
  run.live.resolve();
  await tick();
  assert.equal(run.context.state.fresh, true);
});

test('缓存内容无法渲染时回退到新状态', async () => {
  const run = boot(Promise.resolve({ revision: -1 }));
  run.context.render = () => {
    if (run.context.state.revision === -1) throw Error('bad cache');
    run.rendered.push(run.context.state);
  };
  await tick();
  run.live.resolve();
  await tick();
  assert.equal(run.rendered.length, 1);
  assert.equal(run.context.state.fresh, true);
});

test('后台加载失败时保留缓存并提示错误', async () => {
  const cached = { revision: -1 };
  const run = boot(Promise.resolve(cached));
  await tick();
  run.live.reject(Error('fixture failure'));
  await tick();
  assert.equal(run.context.state, cached);
  assert.equal(run.context.content.innerHTML, '');
  assert.match(run.errors[0], /fixture failure/);
});
