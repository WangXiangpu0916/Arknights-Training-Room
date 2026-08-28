import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('GitHub Releases 更新配置只发布可自动更新的测试版 NSIS 产物', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.version, /-(?:alpha|beta|rc)(?:\.|$)/);
  assert.deepEqual(pkg.build.publish, {
    provider: 'github',
    owner: '7aroland',
    repo: 'Arknights-Training-Room',
    releaseType: 'prerelease',
  });
  assert.equal(pkg.build.win.target, 'nsis');
  assert.equal(pkg.build.productName, '训练室');
  assert.equal(pkg.build.nsis.shortcutName, '训练室');
  assert.deepEqual(pkg.build.extraResources, [{ from: 'resources/game-data', to: 'game-data' }]);
  assert.match(pkg.build.nsis.artifactName, /^[\x20-\x7E]+$/);
  assert.ok(pkg.dependencies['electron-updater']);

  const main = readFileSync('src/main.ts', 'utf8');
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(main, /autoUpdater\.allowPrerelease = true/);
  assert.match(workflow, /Only test\/pre-release versions may be published/);
});

test('专精规划默认使用无限材料且不再显示旧筛选和依赖标签', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(renderer, /unlimited: 'with'/);
  assert.doesNotMatch(renderer, /无限池不限|依赖无限材料/);
});

test('专精规划筛选器和模式提示按当前规则精简', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.doesNotMatch(renderer, /全部技能|一技能|二技能|三技能/);
  assert.doesNotMatch(renderer, /三星|每个候选独立计算|排序：/);
  assert.match(renderer, /mode === 'continuous' \? \[\[0,'M0'\],\[1,'M1'\]\] : \[\[0,'M0'\],\[1,'M1'\],\[2,'M2'\]\]/);
  assert.match(renderer, /mode === 'continuous' && filters\.mastery === '2'\) filters\.mastery = ''/);
});

test('应用主题使用青蓝重点色并降低最后同步信息权重', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const html = readFileSync('renderer/index.html', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(styles, /--accent: #0098DC;/);
  assert.match(styles, /--accent-hover: #22BBFF;/);
  assert.match(styles, /--accent-bright: #18D1FF;/);
  assert.match(styles, /--accent-soft: rgba\(0, 152, 220, 0\.12\);/);
  assert.match(styles, /--accent-border: rgba\(0, 152, 220, 0\.55\);/);
  assert.doesNotMatch(html, /brand-mark|TRAINING ROOM|>TR</);
  assert.doesNotMatch(styles, /#ffd329|rgba\(255,211,41/);
  assert.match(html, /refresh-button[\s\S]*sync-badge/);
  assert.match(renderer, /badge\.className = 'sync-status'/);
  assert.match(styles, /\.top-actions \{[^}]*flex-direction: column;[^}]*align-items: flex-end/);
});

test('干员技能图标、舒适宽度卡片网格与独立主区域滚动保持在展示层', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /const available = state\.single/);
  assert.match(renderer, /class="operator-skill \$\{candidate \? 'can-upgrade' : ''\}"/);
  assert.match(renderer, /operator-skill-mastery">M\$\{masteryLevel\}/);
  assert.doesNotMatch(renderer, /class="skill-pills"|class="skill-pill/);
  assert.match(styles, /\.dashboard-layout \{[^}]*container-type: inline-size;[^}]*max-width: 1680px/);
  assert.match(styles, /\.cards \{[^}]*grid-template-columns: minmax\(0, 410px\);[^}]*justify-content: start/);
  assert.match(styles, /@container \(min-width: 674px\) \{\s*\.cards \{ grid-template-columns: repeat\(2, minmax\(0, 410px\)\)/);
  assert.match(styles, /@container \(min-width: 1018px\) \{\s*\.cards \{ grid-template-columns: repeat\(3, minmax\(0, 410px\)\)/);
  assert.match(styles, /@container \(min-width: 1362px\) \{\s*\.cards \{ grid-template-columns: repeat\(4, minmax\(0, 410px\)\)/);
  assert.doesNotMatch(styles, /\.cards \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /main \{[^}]*height: 100vh;[^}]*overflow-y: auto/);
  assert.match(styles, /\.sidebar \{[^}]*height: 100vh;[^}]*overflow: hidden/);
});

test('专精筛选栏让搜索框弹性伸缩并限制筛选控件宽度', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="filters dashboard-filters"/);
  assert.match(styles, /\.dashboard-filters \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*max-width: 1240px/);
  assert.match(styles, /\.dashboard-filters > input \{[^}]*flex: 1 1 260px;[^}]*min-width: 220px;[^}]*max-width: 520px/);
  assert.match(styles, /\.dashboard-filters > select \{[^}]*min-width: 118px;[^}]*max-width: 144px/);
  assert.match(styles, /\.dashboard-filters > \.filter-mode \{[^}]*min-width: 225px;[^}]*max-width: 260px/);
});

test('专精候选整卡打开材料详情且不再显示查看材料按钮', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="candidate rarity-\$\{candidate\.operator\.rarity\}" data-candidate=/);
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

test('专精候选竖线直接按真实星级使用游戏稀有度配色', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /candidate rarity-\$\{candidate\.operator\.rarity\}/);
  assert.match(styles, /\.candidate\.rarity-4 \{ --rarity-line: #BF96ED; \}/);
  assert.match(styles, /\.candidate\.rarity-5 \{ --rarity-line: #EFD691; \}/);
  assert.match(styles, /\.candidate\.rarity-6 \{[^}]*linear-gradient\(180deg, #C82A36 0%, #FF9433 100%\)[^}]*background-size: 3px 100%/);
  assert.doesNotMatch(styles, /\.candidate\.rarity-6 \{[^}]*linear-gradient\(90deg/);
});
