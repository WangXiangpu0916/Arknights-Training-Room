import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('GitHub Releases 更新配置会生成可自动更新的 NSIS 产物', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(pkg.build.publish, {
    provider: 'github',
    owner: '7aroland',
    repo: 'Arknights-Training-Room',
    releaseType: 'release',
  });
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.productName, '训练室');
  assert.equal(pkg.build.nsis.shortcutName, '训练室');
  assert.deepEqual(pkg.build.extraResources, [{ from: 'resources/game-data', to: 'game-data' }]);
  assert.match(pkg.build.nsis.artifactName, /^[\x20-\x7E]+$/);
  assert.ok(pkg.dependencies['electron-updater']);
});

test('专精规划默认使用无限材料且不再显示旧筛选和依赖标签', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(renderer, /unlimited: 'with'/);
  assert.doesNotMatch(renderer, /无限池不限|依赖无限材料/);
});

test('干员技能图标、三列卡片与独立主区域滚动保持在展示层', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /const available = state\.single/);
  assert.match(renderer, /class="operator-skill \$\{candidate \? 'can-upgrade' : ''\}"/);
  assert.match(renderer, /operator-skill-mastery">M\$\{masteryLevel\}/);
  assert.doesNotMatch(renderer, /class="skill-pills"|class="skill-pill/);
  assert.match(styles, /\.cards \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /main \{[^}]*height: 100vh;[^}]*overflow-y: auto/);
  assert.match(styles, /\.sidebar \{[^}]*height: 100vh;[^}]*overflow: hidden/);
});

test('专精候选整卡打开材料详情且不再显示查看材料按钮', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="candidate" data-candidate=/);
  assert.match(renderer, /role="button" tabindex="0"/);
  assert.doesNotMatch(renderer, />查看材料 →<\/button>/);
  assert.match(renderer, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(styles, /\.candidate:hover \{/);
});

test('仓库仅展示 21 种蓝色材料且设置页不再重复管理无限供应', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const inventoryIds = renderer.match(/const inventoryMaterialIds = new Set\(\[([\s\S]*?)\]\);/)?.[1].match(/'\d+'/g) ?? [];
  assert.equal(inventoryIds.length, 21);
  assert.match(renderer, /filter\(item => inventoryMaterialIds\.has\(item\.itemId\)\)/);
  assert.doesNotMatch(renderer, /data-action="manage-unlimited"|action === 'manage-unlimited'/);
  assert.doesNotMatch(renderer, /<h3>无限供应材料<\/h3>/);
});

test('专精卡片按头像边界对齐图标并保持技能名称单行滚动', () => {
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(styles, /grid-template-columns: 72px minmax\(0, 1fr\) 56px/);
  assert.match(styles, /\.candidate-avatar \{[^}]*width: 72px; height: 72px/);
  assert.match(styles, /\.mastery-icon \{[^}]*height: 51px; width: auto/);
  assert.match(styles, /\.skill-icon \{[^}]*width: 56px; height: 56px/);
  assert.match(styles, /\.skill-copy \{[^}]*overflow: hidden; white-space: nowrap/);
  assert.match(styles, /@keyframes skill-name-scroll/);
});
