import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('GitHub Releases 更新配置只发布可自动更新的测试版 NSIS 产物', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.version, /-(?:alpha|beta|rc)(?:\.|$)/);
  assert.deepEqual(pkg.build.publish, {
    provider: 'github',
    owner: 'WangXiangpu0916',
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
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release create[\s\S]*--prerelease/);
});

test('专精规划默认使用真实仓库且不再显示旧筛选和依赖标签', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(renderer, /unlimited: 'real'/);
  assert.doesNotMatch(renderer, /无限池不限|依赖无限材料/);
});

test('专精规划筛选器和模式提示按当前规则精简', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.doesNotMatch(renderer, /全部技能|一技能|二技能|三技能/);
  assert.doesNotMatch(renderer, /三星|每个候选独立计算|排序：/);
  assert.match(renderer, /mode === 'continuous' \? \[\[0,'M0'\],\[1,'M1'\]\] : \[\[0,'M0'\],\[1,'M1'\],\[2,'M2'\]\]/);
  assert.match(renderer, /mode = event\.target\.checked \? 'continuous' : 'single'/);
  assert.match(renderer, /mode === 'continuous' && dashboardFilters\.mastery === '2'\) dashboardFilters\.mastery = ''/);
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
  assert.match(renderer, /const available = new Map\(currentMasteryCandidates\(\)/);
  assert.match(renderer, /function currentMasteryCandidates\(\)/);
  assert.match(renderer, /class="operator-skill \$\{candidate \? 'can-upgrade' : ''\}"/);
  assert.match(renderer, /class="operator-skill-icon"/);
  assert.match(renderer, /class="mastery-badge" aria-hidden="true"><img class="operator-skill-mastery"/);
  assert.doesNotMatch(renderer, /operator-skill-mastery">M\$\{masteryLevel\}/);
  assert.match(styles, /\.mastery-badge \{[^}]*width: 26px;[^}]*height: 24px/);
  assert.match(styles, /\.mastery-badge \{[^}]*background: #1f1a1c/);
  assert.match(styles, /\.mastery-badge \{[^}]*overflow: hidden/);
  assert.match(styles, /\.mastery-badge img \{[^}]*width: 22px;[^}]*height: 20px/);
  assert.match(styles, /\.mastery-badge img \{[^}]*left: 2px;[^}]*top: 2px/);
  assert.match(styles, /\.mastery-badge img \{[^}]*object-fit: contain/);
  assert.match(styles, /\.operator-skill-icon \{[^}]*width: 100%; height: 100%/);
  assert.doesNotMatch(renderer, /class="skill-pills"|class="skill-pill/);
  assert.match(styles, /\.dashboard-layout \{[^}]*max-width: 1680px/);
  assert.match(styles, /\.cards \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 338px\)\);[^}]*justify-content: start/);
  assert.doesNotMatch(styles, /@container|repeat\(2, minmax\(0, 338px\)\)|repeat\(4, minmax\(0, 338px\)\)/);
  assert.doesNotMatch(styles, /\.cards \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /main \{[^}]*height: 100vh;[^}]*overflow-y: auto/);
  assert.match(styles, /\.sidebar \{[^}]*height: 100vh;[^}]*overflow: hidden/);
});

test('固定窗口锁定 1360×800 且不再运行 resize-only FLIP', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const main = readFileSync('src/main.ts', 'utf8');
  assert.match(main, /FIXED_WINDOW_WIDTH = 1360/);
  assert.match(main, /FIXED_WINDOW_HEIGHT = 800/);
  assert.match(main, /resizable: false/);
  assert.match(main, /maximizable: false/);
  assert.match(main, /minimizable: true/);
  assert.match(main, /fullscreenable: false/);
  assert.doesNotMatch(renderer, /ResizeObserver|gridColumnCount|data-card-motion|requestAnimationFrame/);
});

test('专精顶部控制区固定为筛选行与三个统一模式开关', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="filters dashboard-filters"/);
  assert.match(styles, /\.dashboard-filters \{[^}]*grid-template-columns: minmax\(220px, 520px\) repeat\(3, minmax\(118px, 144px\)\)/);
  assert.match(renderer, /class="dashboard-mode-row"[\s\S]*连续专精模式[\s\S]*技巧概要视为无限[\s\S]*使用无限池材料/);
  assert.match(styles, /\.dashboard-mode-row \{[^}]*display: flex;[^}]*flex-wrap: nowrap/);
  assert.match(styles, /\.dashboard-mode-toggle \{[^}]*min-height: 38px;[^}]*padding: 6px 10px/);
  assert.match(renderer, /operatorFilterRegion\('common', '筛选'[\s\S]*operatorFilterRegion\('more', '更多筛选'/);
  assert.match(styles, /\.operator-filter-group \{[^}]*grid-template-columns: 116px minmax\(0, 1fr\)/);
  assert.doesNotMatch(renderer, /<details|operatorFilterMenu|operator-filter-popover/);
  assert.match(renderer, /dashboardFilters\.unlimited = event\.target\.checked \? 'with' : 'real'/);
  assert.doesNotMatch(renderer, /data-mode=|data-supply-mode=|技巧概要无限供应|仅真实仓库<\/button>/);
  const main = readFileSync('src/main.ts', 'utf8');
  assert.match(main, /ATR_SCREENSHOT_MODE === 'continuous'[\s\S]*querySelector\('\[data-continuous-mode\]'\)/);
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

test('仓库展示分类图标网格与右侧详情抽屉', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /InventoryCatalog\.buildSections/);
  assert.match(renderer, /inventory-section-title/);
  assert.match(renderer, /inventory-icon-grid-pinned/);
  assert.match(renderer, /inventory-icon-frame/);
  assert.match(renderer, /data-inventory-detail/);
  assert.match(renderer, /data-inventory-unlimited/);
  assert.match(renderer, /renderRecipeVisual/);
  assert.doesNotMatch(renderer, /inventory-icon-ring/);
  assert.doesNotMatch(renderer, /recipe-target/);
  assert.doesNotMatch(renderer, /recipe-ingredient-plus/);
  assert.doesNotMatch(renderer, /recipe-flow-arrow/);
  assert.doesNotMatch(renderer, /inventoryMaterialIds/);
  assert.doesNotMatch(renderer, /已设无限/);
  assert.doesNotMatch(renderer, /<th>规划状态<\/th>/);
  assert.doesNotMatch(renderer, /operator-meta">—<\/span>/);
  assert.doesNotMatch(renderer, /data-action="manage-unlimited"|action === 'manage-unlimited'/);
  assert.doesNotMatch(renderer, /<h3>无限供应材料<\/h3>/);
  assert.doesNotMatch(renderer, />查看配方</);
  assert.doesNotMatch(renderer, /inventory-switch-slot/);
  assert.doesNotMatch(styles, /inventory-icon-ring/);
  assert.doesNotMatch(styles, /inventory-detail-icon\.rarity-/);
  assert.doesNotMatch(styles, /recipe-ingredient-icon\.rarity-/);
  assert.match(styles, /\.inventory-icon-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(72px, 1fr\)\)/);
  assert.match(styles, /\.inventory-icon-grid-pinned \{[^}]*grid-template-columns: repeat\(4, 72px\)/);
  assert.match(styles, /\.inventory-detail \{/);
  assert.match(styles, /\.recipe-visual/);
});

test('专精卡片按头像边界对齐图标并保持技能名称单行滚动', () => {
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(styles, /\.candidate \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto 72px/);
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

test('精英化与模组规划是同级页面并使用真实图标和独立状态', () => {
  const html = readFileSync('renderer/index.html', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(html, /data-page="promotion"[^>]*>[^<]*<span>[^<]*<\/span>精英化规划/);
  assert.match(html, /data-page="modules"[^>]*>[^<]*<span>[^<]*<\/span>模组规划/);
  assert.match(renderer, /state\.promotions/);
  assert.match(renderer, /state\.modules/);
  assert.match(renderer, /resources\/images\/elite\/e\$\{Number\(level\)\}\.png/);
  assert.match(renderer, /torappu\.prts\.wiki\/assets\/uniequip_img/);
  assert.match(renderer, /candidate\.module\.moduleId/);
});

test('仓库详情栏共享页面滚动并展示动态 PRTS 文本与固定可合成标签', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /detail\.material\.purpose/);
  assert.match(renderer, /detail\.material\.description/);
  assert.match(renderer, /可合成 × \$\{detail\.craftable\}/);
  assert.match(styles, /\.inventory-detail \{[^}]*position: static;[^}]*overflow: visible/);
  assert.doesNotMatch(styles, /\.inventory-detail \{[^}]*overflow: auto/);
  assert.match(styles, /\.craftable-badge \{[^}]*position: absolute/);
  assert.match(styles, /\.inventory-copy-block p \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  const metadata = JSON.parse(readFileSync('resources/game-data/material-metadata.json', 'utf8'));
  assert.equal(metadata['31094'].purpose, '具备良好光学性能和物理性能的特种光学材料。用于高级强化场合。');
  assert.ok(metadata['30023'].description.length > 30);
});

test('主题使用 Electron nativeTheme 三态并完整定义浅色层级', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(main, /nativeTheme\.themeSource = theme/);
  assert.match(renderer, /name="theme" value="system"/);
  assert.match(renderer, /name="theme" value="dark"/);
  assert.match(renderer, /name="theme" value="light"/);
  assert.match(styles, /:root\[data-theme="light"\]/);
  assert.match(styles, /@media \(prefers-color-scheme: light\)/);
  assert.match(styles, /--bg: #edf2f6/);
});

test('更新异常被记录并转换成短消息，设置卡片可断开任意长字符串', () => {
  const main = readFileSync('src/main.ts', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(main, /friendlyUpdateError/);
  assert.match(main, /service\?\.store\.log\(event, detail\)/);
  assert.doesNotMatch(main, /message: `检查更新失败：\$\{error instanceof Error \? error\.message/);
  assert.match(styles, /\.update-message \{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  assert.match(styles, /\.setting-card \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
});

test('干员卡片区分 Rank 与专精并提供全星级徽标、标签和职业水印', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /Rank \$\{owned\.skillLevel\}/);
  assert.match(renderer, /masteryBadge\(masteryLevel\)/);
  assert.match(renderer, /definition\.position, \.\.\.\(definition\.tags \|\| \[\]\)/);
  assert.match(renderer, /operator-watermark/);
  for (const rarity of [1, 2, 3, 4, 5, 6]) assert.match(styles, new RegExp(`\\.rarity-badge\\.rarity-${rarity}`));
  assert.match(styles, /\.rarity-badge\.rarity-6 \{[^}]*linear-gradient/);
});
