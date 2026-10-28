import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('GitHub Releases 保留测试版、NSIS 和原安装标识', () => {
 const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
 const installer=readFileSync('build/nsis/installer.nsi','utf8');
 const updater=readFileSync('src-tauri/src/updater.rs','utf8');
 assert.deepEqual(config.bundle.targets,['nsis']);assert.equal(config.productName,'训练室');
 assert.match(installer,/89035d73-f384-5e6c-bda4-e2c88d3f133f/);
 assert.match(updater,/beta.yml/);assert.match(updater,/latest.yml/);
 const workflow=readFileSync('.github/workflows/release.yml','utf8');
 assert.doesNotMatch(workflow,/Only test\/pre-release versions may be published/);
 assert.match(workflow,/Tag must be \$expected/);
 assert.match(workflow,/gh release create[\s\S]*--prerelease/);
});

test('专精规划默认使用真实仓库且不再显示旧筛选和依赖标签', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(renderer, /unlimited: 'real'/);
  assert.doesNotMatch(renderer, /无限池不限|依赖无限材料/);
});

test('专精规划筛选器和模式提示按当前规则精简', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.doesNotMatch(renderer, /全部技能|一技能|二技能|三技能/);
  assert.doesNotMatch(renderer, /每个候选独立计算|排序：/);
  assert.match(renderer, /mode === 'continuous' \? \[0, 1\] : \[0, 1, 2\]/);
  assert.match(renderer, /\['未专精', '专精一级', '专精二级', '专精三级'\]/);
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
  assert.doesNotMatch(html, /refresh-button|sync-badge|top-actions/);
  assert.equal((renderer.match(/<button[^>]*data-action="refresh-account"/g) ?? []).length, 1);
  const settingsRenderer = renderer.slice(renderer.indexOf('function renderSettings('));
  assert.match(settingsRenderer.slice(0, settingsRenderer.indexOf('\nfunction ', 1)), /data-action="refresh-account"/);
  assert.match(renderer, /action === 'refresh-account'\) \{ await refreshAccountData\(\)/);
  assert.match(styles, /main\[data-page="settings"\] \{[^}]*scrollbar-width: none/);
});

test('干员技能图标、舒适宽度卡片网格与独立主区域滚动保持在展示层', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /cachedMasteryAvailable = new Map\(source\.map/);
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
  assert.match(styles, /\.cards \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 318px\), 1fr\)\);[^}]*justify-content: start/);
  assert.doesNotMatch(styles, /@container|repeat\(2, minmax\(0, 338px\)\)|repeat\(4, minmax\(0, 338px\)\)/);
  assert.doesNotMatch(styles, /\.cards \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /main \{[^}]*height: 100%;[^}]*overflow-y: auto/);
  assert.match(styles, /\.sidebar \{[^}]*height: 100%;[^}]*overflow: hidden/);
});

test('固定窗口锁定 1360×800 且不再运行 resize-only FLIP', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const main = readFileSync('src-tauri/src/main.rs', 'utf8');
  assert.match(main, /inner_size\(1360.0,800.0\)/);
  assert.match(main, /resizable\(false\)/);assert.match(main, /maximizable\(false\)/);
  assert.match(main, /minimizable\(true\)/);assert.match(main, /fullscreen\(false\)/);
  assert.doesNotMatch(renderer, /ResizeObserver|gridColumnCount|data-card-motion/);
  assert.doesNotMatch(renderer.slice(renderer.indexOf('function candidateCard('), renderer.indexOf('function renderOperators(')), /requestAnimationFrame/);
  assert.match(main, /PageLoadEvent::Finished/);
});

test('专精顶部控制区固定为筛选行与三个统一模式开关', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="filters dashboard-filters"/);
  assert.match(styles, /\.dashboard-filters \{[^}]*grid-template-columns: minmax\(240px, 1fr\) repeat\(3, minmax\(136px, 168px\)\)/);
  assert.match(renderer, /class="dashboard-mode-row"[\s\S]*连续专精模式[\s\S]*技巧概要视为无限[\s\S]*使用无限池材料/);
  assert.match(styles, /\.dashboard-mode-row \{[^}]*display: flex;[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.dashboard-mode-toggle \{[^}]*min-height: 36px;[^}]*padding: 0 8px 0 12px/);
  assert.match(renderer, /operatorFilterRegion\('common', '筛选'[\s\S]*operatorFilterRegion\('more', '更多筛选'/);
  assert.match(styles, /\.operator-filter-group \{[^}]*grid-template-columns: 116px minmax\(0, 1fr\)/);
  assert.doesNotMatch(renderer, /operatorFilterMenu|operator-filter-popover/);
  assert.match(renderer, /dashboardFilters\.unlimited = event\.target\.checked \? 'with' : 'real'/);
  assert.doesNotMatch(renderer, /data-mode=|data-supply-mode=|技巧概要无限供应|仅真实仓库<\/button>/);
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

test('长干员列表延迟解码屏外图片并跳过屏外布局绘制', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(styles, /\.operator-row \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto 107px/);
  assert.match(renderer, /class="operator-avatar"[^>]*loading="lazy" decoding="async"/);
  assert.match(renderer, /class="operator-skill-icon"[^>]*loading="lazy" decoding="async"/);
  assert.match(renderer, /class="inventory-icon-image"[^>]*loading="lazy" decoding="async"/);
});

test('renderer 合并并发状态刷新并缓存随 state 更新失效的派生索引', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  assert.match(renderer, /if \(stateLoadPromise\) \{\s*stateLoadQueued = true;/);
  assert.match(renderer, /cachedMaterialMap \?\?= new Map/);
  assert.match(renderer, /if \(cachedOperatorRows\) return cachedOperatorRows/);
  assert.match(renderer, /if \(source !== cachedMasterySource\)/);
});

test('模组卡片仅静态居中显示类型编号且不影响专精名称滚动', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /class="module-target-copy"[^>]*><strong class="module-type-code"/);
  assert.doesNotMatch(renderer, /class="module-target-copy"[^>]*>[\s\S]*?class="module-name"/);
  assert.match(styles, /\.module-target-copy \{[^}]*display: flex;[^}]*justify-content: center;[^}]*text-align: center/);
  assert.match(styles, /\.module-target-copy \.module-type-code \{[^}]*width: 100%;[^}]*text-align: center;[^}]*transform: none/);
  assert.doesNotMatch(styles, /module-name-scroll|\.module-target-copy[^}]*animation:/);
  assert.match(styles, /@keyframes skill-name-scroll/);
});

test('专精候选与干员列表复用六星纵向渐变', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /candidate rarity-\$\{candidate\.operator\.rarity\}/);
  assert.match(styles, /\.candidate\.rarity-4 \{ --rarity-line: #BF96ED; \}/);
  assert.match(styles, /\.candidate\.rarity-5 \{ --rarity-line: #EFD691; \}/);
  assert.match(styles, /--rarity-6-line: linear-gradient\(180deg, #C82A36 0%, #FF9433 100%\)/);
  assert.match(styles, /\.candidate\.rarity-6 \{[^}]*background-image: var\(--rarity-6-line\)[^}]*background-size: 3px 100%/);
  assert.match(styles, /\.operator-row\.rarity-6 \{[^}]*background-image: var\(--rarity-6-line\)[^}]*background-size: 3px 100%/);
  assert.doesNotMatch(styles, /--rarity-6-line: linear-gradient\(90deg/);
});

test('侧边栏使用统一矢量图标，精英化与模组规划保持同级页面和独立状态', () => {
  const html = readFileSync('renderer/index.html', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.equal((html.match(/<svg class="nav-icon"/g) ?? []).length, 7);
  assert.match(html, /data-page="promotion"[^>]*><svg class="nav-icon"[^>]*stroke="currentColor"[\s\S]*?<\/svg>精英化规划/);
  assert.match(html, /data-page="modules"[^>]*><svg class="nav-icon"[^>]*stroke="currentColor"[\s\S]*?<\/svg>模组规划/);
  assert.match(html, /data-page="statistics"[^>]*><svg class="nav-icon"[^>]*stroke="currentColor"[\s\S]*?<\/svg>统计/);
  assert.match(styles, /\.nav-icon \{[^}]*width: 18px; height: 18px;[^}]*color: currentColor/);
  assert.match(renderer, /state\[kind === 'promotion' \? 'promotions' : 'modules'\]/);
  assert.match(renderer, /resourceImage\(`elite\/e\$\{Number\(level\)\}\.png`\)/);
  assert.doesNotMatch(renderer, /resources\/images\/level\/elite-2\.png/);
  assert.match(renderer, /operator-current-elite/);
  assert.match(renderer, /operatorLevelBadge\(candidate\.currentLevel, candidate\.from\)/);
  assert.match(renderer, /digits-\$\{String\(value\)\.length\}/);
  assert.match(renderer, /resourceImage\(`module\/type\/\$\{encodeURIComponent\(String\(typeIcon\)\.toLowerCase\(\)\)\}\.png`\)/);
  assert.match(renderer, /resourceImage\(`module\/stage\/\$\{Number\(level\)\}\.png`\)/);
  assert.match(renderer, /candidate\.module\.typeIcon/);
  assert.match(renderer, /candidate\.module\.moduleId/);
  assert.match(renderer, /candidate\.module\.typeLabel/);
  assert.match(renderer, /data-planner-filter="search"/);
  assert.match(renderer, /data-planner-toggle="continuous"/);
  assert.match(renderer, /data-planner-toggle="unlimited"/);
  assert.doesNotMatch(renderer, /ready-badge|材料已就绪|torappu\.prts\.wiki\/assets\/uniequip_img|模组开启仍需在游戏内完成对应任务；此处核对/);
  assert.match(styles, /\.plan-card \.candidate-main \{ grid-template-columns: 72px minmax\(0, 1fr\) 56px; grid-template-rows: 21px 51px; min-height: 72px; \}/);
  assert.match(styles, /\.module-type-icon \{/);
  assert.match(styles, /\.module-stage-icon \{/);
  assert.match(styles, /\.operator-level-badge \{[^}]*width: 56px; height: 72px;[^}]*grid-template-rows: 56px 16px/);
  assert.match(styles, /\.operator-current-elite img \{[^}]*max-width: 56px; max-height: 54px; object-fit: contain/);
  assert.match(styles, /\.module-stage-icon \{[^}]*border: 0;[^}]*background: transparent/);
  assert.match(styles, /\.module-type-icon \{ width: 56px; height: 56px;[^}]*border-radius: 0;[^}]*background: transparent/);
  assert.match(styles, /\.module-target-copy \{[^}]*width: 56px;[^}]*color: var\(--text\)/);
  assert.match(renderer, /class="module-target-copy"[^>]*><strong class="module-type-code"/);
  assert.doesNotMatch(renderer, /当前 Lv\./);
});

test('缓存加载不弹出通知且统计页面共享统一完成度结构', () => {
  const html = readFileSync('renderer/index.html', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.doesNotMatch(html, /data-notice-region/);
  assert.doesNotMatch(renderer, /renderDataNotice|cacheNoticeTimer|当前使用缓存数据/);
  assert.doesNotMatch(renderer, /class="cache-banner"/);
  assert.doesNotMatch(styles, /\.data-notice|\.cache-notice/);
  assert.match(renderer, /statistics\.scopes\[statisticsScope\]/);
  for (const key of ['mastery', 'moduleUnlocked', 'moduleStage3', 'elite1', 'elite2']) assert.match(renderer, new RegExp(`scoped\\.${key}`));
  assert.match(renderer, /class="statistics-toolbar"/);
  assert.match(renderer, /class="statistics-list"/);
  assert.match(renderer, /class="stat-line \$\{kind\}"/);
  assert.match(renderer, /statisticGroup\('专精三级技能总进度'/);
  assert.match(renderer, /statisticGroup\('精英阶段1及以上总进度'/);
  assert.match(renderer, /statisticGroup\('精英阶段2总进度'/);
  const statisticsRenderer = renderer.slice(renderer.indexOf('function statisticLine('), renderer.indexOf('function renderDashboard('));
  assert.doesNotMatch(statisticsRenderer, /<details|<summary|stat-expand/);
  assert.doesNotMatch(renderer, /statistics-heading"><h2>[^<]+<\/h2><p>/);
  assert.doesNotMatch(renderer, /stat-card|stat-row|elite-distribution|当前 E0|当前 E1|当前 E2/);
  assert.match(styles, /\.stat-line \{[^}]*grid-template-columns: var\(--stat-label-width\) minmax\(80px, 1fr\) var\(--stat-count-width\) var\(--stat-rate-width\)/);
  assert.match(styles, /\.stat-child \.stat-label \{[^}]*padding-left: 1em;[^}]*font-weight: 400/);
  assert.match(styles, /\.stat-progress \{[^}]*height: 4px/);
  assert.doesNotMatch(styles, /\.stat-card|\.stat-row|\.stat-expand|\.elite-distribution/);
});

test('仓库详情栏固定独立滚动并展示递归可合成数量与 PRTS 文本', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /detail\.material\.purpose/);
  assert.match(renderer, /detail\.material\.description/);
  assert.match(renderer, /可合成 × \$\{detail\.craftable\}/);
  assert.match(styles, /\.inventory-detail \{[^}]*position: sticky;[^}]*top: 20px;[^}]*overflow-y: auto/);
  assert.match(readFileSync('src-tauri/src/domain/planning.rs', 'utf8'), /recursive_quantity/);
  assert.match(styles, /\.craftable-badge \{[^}]*grid-column: 1 \/ -1/);
  assert.match(styles, /\.inventory-copy-block p \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  const metadata = JSON.parse(readFileSync('resources/game-data/material-metadata.json', 'utf8'));
  assert.equal(metadata['31094'].purpose, '具备良好光学性能和物理性能的特种光学材料。用于高级强化场合。');
  assert.ok(metadata['30023'].description.length > 30);
});

test('应用壳使用窄侧栏与圆角工作区，主题支持系统、黑色和浅色', () => {
  const main = readFileSync('src-tauri/src/main.rs', 'utf8');
  const index = readFileSync('renderer/index.html', 'utf8');
  const bootstrap = readFileSync('renderer/theme-bootstrap.js', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  const types = readFileSync('src/domain/types.ts', 'utf8');
  const store = readFileSync('src-tauri/src/storage.rs', 'utf8');
  assert.match(main, /Some\(tauri::Theme::Dark\)/);
  assert.match(main, /system_dark/);
  assert.match(main, /initialization_script[\s\S]*theme=/);
  assert.match(index, /<html lang="zh-CN" data-theme="system">/);
  assert.ok(index.indexOf('<script src="theme-bootstrap.js"></script>') < index.indexOf('<link rel="stylesheet" href="styles.css">'));
  assert.match(bootstrap, /URLSearchParams\(window\.location\.search\)\.get\('theme'\)/);
  assert.match(bootstrap, /initialTheme === 'light' \|\| initialTheme === 'black'/);
  assert.doesNotMatch(index, /sidebar-brand|topbar|page-title|page-subtitle/);
  assert.match(index, /class="sidebar-spacer"/);
  assert.match(styles, /#app \{[^}]*grid-template-columns: minmax\(160px, 15fr\) minmax\(0, 85fr\)/);
  assert.match(styles, /main \{[^}]*border-radius: 18px/);
  assert.doesNotMatch(styles, /\.sidebar \{[^}]*border-right/);
  assert.match(renderer, /name="theme" value="system"/);
  assert.match(renderer, /name="theme" value="black"/);
  assert.match(renderer, /name="theme" value="light"/);
  assert.doesNotMatch(renderer, /name="theme" value="dark"|深蓝色/);
  assert.match(renderer, /> 黑色<\/label>/);
  assert.doesNotMatch(renderer, /游戏数据 \$\{esc\(fmtTime\(state\.gameData\.updatedAt\)\)\}/);
  assert.match(types, /'system' \| 'black' \| 'light'/);
  assert.match(store, /"dark"[\s\S]*"black"/);
  assert.doesNotMatch(styles, /:root\[data-theme="black"\]/);
  assert.match(styles, /:root\[data-theme="light"\]/);
  assert.match(styles, /@media \(prefers-color-scheme: light\)/);
  assert.match(styles, /--app-bg: #0f0f0f/);
  assert.match(styles, /--app-bg: #dfe7ed/);
});

test('更新异常被记录并转换成短消息，设置页使用列表且更新项位于倒数第二项', () => {
  const main = readFileSync('src-tauri/src/main.rs', 'utf8');
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  const types = readFileSync('src/domain/types.ts', 'utf8');
  const store = readFileSync('src-tauri/src/storage.rs', 'utf8');
  const service = readFileSync('src-tauri/src/service.rs', 'utf8');
  const updater=readFileSync('src-tauri/src/updater.rs','utf8');
  assert.match(updater,/暂时无法获取版本信息/);
  assert.match(updater,/storage::log/);
  assert.doesNotMatch(main, /message: `检查更新失败：\$\{error instanceof Error \? error\.message/);
  assert.match(styles, /\.update-message \{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  assert.match(styles, /\.setting-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(renderer, /class="settings-list"/);
  assert.doesNotMatch(renderer, /setting-card|settings-grid|连续专精排序|name="sort"/);
  assert.match(renderer, /启动时自动刷新[\s\S]*应用更新[\s\S]*缓存/);
  assert.doesNotMatch(`${types}\n${store}\n${service}`, /continuousSort/);
});

test('干员列表区分 Rank 与专精并提供默认培养排序、紧凑技能和职业图标', () => {
  const renderer = readFileSync('renderer/app.js', 'utf8');
  const styles = readFileSync('renderer/styles.css', 'utf8');
  assert.match(renderer, /Rank \$\{owned\.skillLevel\}/);
  assert.match(renderer, /masteryBadge\(masteryLevel\)/);
  assert.match(renderer, /definition\.position, \.\.\.\(definition\.tags \|\| \[\]\)/);
  assert.match(renderer, /operator-watermark/);
  assert.match(renderer, /professionIcon\(definition\.profession\)/);
  assert.match(renderer, /resourceImage\(`profession-hd/);
  assert.match(styles, /\.operator-watermark \{[^}]*filter: invert\(1\)/);
  assert.match(styles, /data-theme="light"[^}]*operator-watermark \{[^}]*filter: none/);
  assert.doesNotMatch(styles, /operator-watermark[^}]*mix-blend-mode/);
  for (const profession of ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种']) {
    const icon = readFileSync(`resources/images/profession-hd/${profession}.png`);
    assert.equal(icon.readUInt32BE(16), 108, `${profession}职业图标应使用高清宽度`);
    assert.equal(icon.readUInt32BE(20), 109, `${profession}职业图标应使用高清高度`);
  }
  assert.match(renderer, /definition\.skills\.length > 3 \? 'many-skills'/);
  assert.match(styles, /\.operator-list \{[^}]*gap: 0;[^}]*border: 1px solid var\(--line\)/);
  assert.match(styles, /\.operator-row \{[^}]*border-bottom: 1px solid var\(--line\);[^}]*border-radius: 0/);
  assert.match(styles, /\.operator-skills \{[^}]*justify-self: end/);
  assert.match(styles, /\.operator-skills\.many-skills \{[^}]*width: max-content/);
  assert.doesNotMatch(styles, /\.operator-skills\.many-skills[^}]*grid-template-columns/);
  const filters = readFileSync('renderer/operator-filter.js', 'utf8');
  assert.match(filters, /sort: 'training-desc'/);
  assert.match(filters, /PROFESSION_ORDER/);
  for (const rarity of [1, 2, 3, 4, 5, 6]) assert.match(styles, new RegExp(`\\.rarity-badge\\.rarity-${rarity}`));
  assert.match(styles, /\.rarity-badge\.rarity-6 \{[^}]*linear-gradient/);
});
