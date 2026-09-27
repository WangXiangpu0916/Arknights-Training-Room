import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('生产包使用原生程序、明确能力权限并禁用 QA 入口', () => {
 const pkg=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(pkg.dependencies,undefined);
 for(const key of Object.keys(pkg.devDependencies)) assert.ok(!key.startsWith('electron'));
 const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
 assert.deepEqual(config.app.security.capabilities[0].permissions,['core:event:allow-listen','core:event:allow-unlisten']);
 assert.equal(config.bundle.windows.webviewInstallMode.type,'downloadBootstrapper');
 const main=readFileSync('src-tauri/src/main.rs','utf8');
 assert.match(main,/deny_unknown_fields/);assert.match(main,/on_navigation\(trusted\)/);
 assert.match(main,/PermissionResponse::Deny/);assert.match(main,/NewWindowResponse::Deny/);
 assert.match(main,/cfg!\(any\(debug_assertions, feature = "qa"\)\)/);
 assert.doesNotMatch(pkg.scripts.build,/--features qa/);assert.doesNotMatch(pkg.scripts.dist,/--features qa/);
 const native=readFileSync('src-tauri/Cargo.toml','utf8');assert.match(native,/default = \[\]/);
});
test('构建生成原生依赖许可证清单', () => {
 const notices=readFileSync('dist/THIRD_PARTY_LICENSES.txt','utf8');
 assert.match(notices,/tauri 2\./);assert.match(notices,/qrcode 0\./);
 assert.match(notices,/Permission is hereby granted/);
 assert.doesNotMatch(notices,/electron-updater|electron-builder/);
});
test('WebView2 兼容样式仅固定原生单选按钮的原配色', () => {
 const css=readFileSync('renderer/platform.css','utf8').replace(/\/\*[\s\S]*?\*\//g,'').trim();
 assert.equal(css,'.radio-stack input { accent-color: #0075ff; }');
});

test('素材声明区分项目 MIT、游戏权利与上游许可', () => {
  const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
  assert.match(notices, /MIT license covers only original project code/);
  assert.match(notices, /Copyright \(c\) 2023 神代綺凛/);
  assert.match(notices, /CC BY-NC-SA 4\.0/);
  assert.match(notices, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
  assert.match(notices, /Copyright \(c\) 2013-present Cole Bemis/);
});

test('仓库忽略本地凭证、账号缓存与环境文件', () => {
  const gitignore = readFileSync('.gitignore', 'utf8');
  for (const entry of ['.env', '.env.*', 'credentials.bin', 'account-cache.json', 'settings.json', '*.dmp', 'crashpad/']) {
    assert.ok(gitignore.split(/\r?\n/).includes(entry), `缺少忽略规则：${entry}`);
  }
});

test('发布工作流先完成构建并仅在产物齐全后公开预发布', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const buildIndex = workflow.indexOf('npm run dist');
  const createIndex = workflow.indexOf('gh release create');
  const uploadIndex = workflow.indexOf('gh release upload');
  const publishIndex = workflow.indexOf('gh release edit $tag --draft=false --prerelease');

  assert.ok(buildIndex >= 0 && createIndex > buildIndex);
  assert.ok(uploadIndex > createIndex && publishIndex > uploadIndex);
  assert.match(workflow, /if \(\$assets\.Count -lt 4\) \{ throw "Release artifacts are incomplete" \}/);
  assert.doesNotMatch(workflow, /--publish always/);
});

test('包含截图的 WebView2 QA 使用可见窗口，跳过截图时才隐藏', () => {
  const qa = readFileSync('scripts/qa-desktop.mjs', 'utf8');
  assert.match(qa, /const screenshotsEnabled = process\.env\.ATR_QA_SKIP_SCREENSHOTS !== '1'/);
  assert.match(qa, /if \(!screenshotsEnabled\) env\.ATR_QA_HIDDEN = '1'/);
  assert.doesNotMatch(qa, /if \(!process\.env\.ATR_QA_SCREENSHOTS\) env\.ATR_QA_HIDDEN/);
});

test('发布图标固定为已审核的红白黑三角资产且不存在旧生成器', () => {
  const icon = readFileSync('build/icon.png');
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.equal(createHash('sha256').update(icon).digest('hex'), 'c4d68b6f728a7a465b7aa10d1b8807df90aff029e4b2207d36eca15fb0433345');
  assert.equal(existsSync('build/icon.svg'), false);
  assert.equal(existsSync('scripts/render-icon.cjs'), false);
});
