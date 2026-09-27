# Electron → Tauri 迁移记录

后续版本调整：迁移完成后，按用户要求将应用版本更新为 **0.1.0**。下文的基线、测试与性能数据记录的是迁移验收时的 `0.0.20-beta.16`。

## 验收边界

迁移时的工作区（包括任务开始前未提交的改动）是兼容基准，测试版本为 `0.0.20-beta.16`。界面、中文文案、资源、排序及数据结果被冻结。仅在对应替代实现通过验证后删除 Electron 实现。没有证据的项目不标为完成。

## A. 原架构与迁移映射

| 当前实现 | 职责 / 用户可观察行为 | 目标实现 | 风险 / 必须验证 |
|---|---|---|---|
| `src/main.ts:createWindow` | 单窗口；1360×800 **外框**；不可缩放、最大化、全屏；可最小化、移动、关闭；无菜单；准备好后显示 | Tauri / WebView2 窗口生命周期 | Tauri 默认尺寸是内容尺寸；核对 DPI、客户区、初次主题、关闭进程 |
| `src/preload.ts` | `window.trainingRoom`，14 个 invoke、2 个订阅 | 保留同一 frontend contract，Tauri command/event adapter | 参数、返回值、错误文本、事件时序 |
| `src/main.ts:secureHandle` | 仅主窗口主 frame；全部操作串行，不跨资源事务读取 | Tauri capabilities、来源限制、服务串行屏障 | 禁止远程内容、iframe、任意命令/文件/URL API |
| `src/app-service.ts` | 聚合 state、缓存规划、账号/设置/资源一致性 | 独立 application service | revision、失败时旧数据、缓存失效、重复请求 |
| `src/engine/*` | 加工树、专精、精英化、模组、统计 | 独立可测 Rust domain；展示排序保留等价规则 | 每字段比对；共享材料、无限材料回退、阿米娅、多阶段、中文排序 |
| `src/data/local-store.ts` | `%APPDATA%/arknights-training-room`；settings.json、account-cache.json、credentials.bin、app.log | 相同路径/JSON，Windows DPAPI 兼容存储 | 不读取或打印用户秘密；合成凭据交叉解密；旧文件失败不损坏；dark→black、缺省 modules |
| `src/data/skland-client.ts` | 扫码→轮询→grant→cred；HMAC-SHA256→MD5 签名；401/10000/10002 两阶段续期；账号标准化 | 原生 network service | 相同请求体/签名/超时行为；禁重定向；网络错误不错误注销 |
| `src/data/game-data-provider.ts` | 内置资源；完整校验；game-data.next / backup / transaction.json 原子替换、回滚、重启恢复 | Rust resource repository/service | 包格式保持 gzip JSON+base64；路径白名单、SHA256、大小、数据引用、图片安全、10% sanity 检查 |
| `src/data/electron-resource-fetch.ts` | 系统代理；手动校验每次重定向；取消、流式限额 | Windows native HTTP adapter | 系统代理/PAC；GitHub/CDN 白名单；超时、中断、无 body |
| `atr-resource://snapshot/<version>/images/*` | 当前及上一资源版本图片；no-store | Tauri 自定义资源协议及 Windows URL 适配 | 禁止任意文件；编码中文路径；旧页面图片可读 |
| `src/main.ts:configureUpdater` | 仅安装版支持；beta prerelease；手动检查、下载、重启；进度/中文消息 | 原生 updater，兼容现有发布源及安装路径 | 当前 electron-updater manifest 与 Tauri 签名更新协议不同，不能直接替换后宣称兼容 |
| `renderer/{index.html,styles.css,app.js}` | 七页、输入/IME、筛选、排序、主题、modal、原生 confirm、动画、键盘 Enter/Space | 原样保留 | Chromium→WebView2 的字体、窗口客户区、原生对话框、CSS、主题媒体查询差异 |
| `renderer/{operator-filter,inventory-catalog,theme-bootstrap}.js` | 拼音/中文搜索、仓库分组、首帧主题 | 保留前端 | 无 Node/Electron 依赖；现有测试继续运行 |
| `scripts/*`, `src/resources/{builder,converter}.ts` | 数据资源构建/发布；上游元数据与图片；许可证 | 可保留 Node **构建工具** | 不打包 Node runtime；资源工作流不与应用发布耦合 |
| `package.json` / release workflow | electron / electron-builder / electron-updater；NSIS+portable；fuses；licenses | Tauri Windows 构建和安装包 | 版本不变；仅一个 release/win-unpacked；安装覆盖、卸载注册项、快捷方式、更新渠道 |

### IPC 完整清单

| bridge | channel | payload |
|---|---|---|
| getState | app:get-state | 无 |
| startQrLogin | auth:start-qr | 无 |
| finishQrLogin | auth:finish-qr | scanId（1–128 字符，无控制字符） |
| getBindings | auth:get-bindings | 无 |
| logout | auth:logout | 无 |
| refreshAccount | account:refresh | 可选 uid（1–64 字符） |
| updateGameData | game:update | 无 |
| updateSettings | settings:update | 设置对象 |
| clearCache | cache:clear | 无 |
| materialDetail | material:detail | itemId（1–128 字符） |
| getUpdateState | update:get-state | 无 |
| checkForUpdates | update:check | 无 |
| downloadUpdate | update:download | 无 |
| installUpdate | update:install | 无 |
| onStateChanged | app:state-changed | 无 |
| onUpdateStateChanged | update:state-changed | UpdateState |

另有 `theme:changed`：main 发送但 preload 未暴露、renderer 未订阅。主题实际依靠首屏 query 参数、data-theme 及 prefers-color-scheme。迁移不应误将未使用事件当成功能。

### 仓库全面检查结果

- renderer 无 Node 直接或间接导入，无 fs/path/child_process/http；所有 native 操作通过上述 bridge。
- fs/path：main、local-store、game-data-provider、resource validation/package/builder/converter；crypto：skland-client 和 resource validation；zlib：resource package；Node 全局 fetch：森空岛；Electron net：资源更新。
- os/child_process：仅测试、QA、构建脚本。业务运行时没有 MAA、其他外部程序调用（更新安装器除外）。
- 无 SQLite、托盘、通知、globalShortcut、自定义原生菜单、多窗口、deep-link 接收、clipboard、shell/openExternal、文件选择器。扫码图中 `hypergryph://` 是供手机扫描的内容，不是应用注册的协议。
- 用户数据和凭据在 roaming appData；Electron Chromium 缓存与 GPUCache 在同一 userData。game-data 是完整资源快照；仅 clearCache 删除 account-cache.json，logout 删除 credentials.bin 并清除 selectedUid，保留账号缓存。
- 规划无独立磁盘文件，由账号、库存、设置、资源重算；UI 页签/输入/筛选为内存态。
- Chromium 特性包括 `content-visibility`、`:has()`、CSS 动画、Intl 中文排序/日期格式、原生 confirm、matchMedia；QA 使用 CDP、performance.memory、checkVisibility 等，不能将 QA 接口作为生产依赖。
- 首屏关键路径：store 初始化→资源完整校验/恢复+账号+设置→派生索引→清理非法无限材料→凭据读取→创建窗口→getState 计算整份规划/统计→render。自动账号刷新在窗口加载后排队；无启动自动资源同步或更新检查。
- IPC 已是粗粒度聚合 state，且有 state/plans 缓存；不做无证据的细粒度拆分或全量前端 Rust 化。

## 迁移前验证

首次 `npm test`：107 项，106 通过，1 条已有过时 CSS 源码断言失败（旧 ::before 条带已在工作区改成 background-image）。仅修正测试断言以匹配冻结 UI，不改 CSS。

原始证据保存在本地 `output/migration`（忽略提交）；不把私有用户账号和真实凭据提交到仓库。截图/性能仅使用隔离测试目录。冷启动需要操作系统文件缓存控制；不能把首次启动随意标为冷启动。

## B. 新架构

```text
原 HTML / CSS / app.js / 图片
        ↓ window.trainingRoom（原有方法名、参数、返回值、事件）
renderer/platform.js + plan-order.js
        ↓ 一个受限 training_room command，14 个 Request 变体
src-tauri/src/main.rs：来源校验、窗口、事件、后台执行
        ↓
service.rs：聚合用例、状态版本、规划缓存、一致性屏障
        ├─ domain/：加工、专精、精英化、模组、统计
        ├─ storage.rs：原路径 JSON、日志、加密凭据
        ├─ resources/：快照、完整校验、事务切换、恢复
        ├─ network/skland.rs：认证、签名、续期、账号规范化
        └─ updater.rs：检查、下载、校验、启动安装器
platform/：WinHTTP、DPAPI、原子文件替换、系统主题、WebView2 策略
```

业务库默认不启用 Tauri；`cargo test --lib --test resources` 独立运行。Windows 类型限制在 platform 和桌面入口。Node.js 只服务于资源构建、测试与发布工具，用户进程不加载 Node。

保留粗粒度整份 state/plan IPC，没有逐材料 invoke。原有状态/规划缓存继续存在，主题变更不重算规划。HTTP 和计算在后台线程执行；串行用例屏障保护资源与账号一致性。图片索引使用独立读锁，网络等待不会占住图片读取；写锁只覆盖目录切换与索引更新。慢速 HTTP 期间图片加载已加入端到端测试。

首屏仍需要本地快照校验、恢复和初始状态；账号自动刷新在页面载入后执行。没有新增启动时联网更新。对资源路径校验中重复构造正则的实际热点进行了缓存，未引入新的任务调度框架、数据库或通用插件层。

## C. 删除的运行时依赖

- 删除 `electron`、`electron-builder`、`electron-updater`、JavaScript `qrcode` 和 `@types/qrcode`，以及不再需要的传递依赖；本次 npm 安装移除 347 个包。
- 删除原 main、preload、AppService、Node 存储/网络/resource provider 和 TypeScript 运行时计算引擎。已迁移的原生行为测试取代针对这些类内部实现的测试；原有业务断言通过测试适配器直接调用 Rust 核心。
- 不再打包 Chromium、Node、ASAR、Electron DLL/PAK 文件。`package.json` 没有生产 npm dependencies，没有 Electron main/build/fuses 配置。
- 保留的开发依赖是 Tauri CLI、TypeScript、Node 类型、资源构建使用的 pinyin-pro、像素对照使用的 pngjs；都不进入用户运行时。

## D. 迁移到 Rust 的模块

| 能力 | Rust 实现 | 兼容验证 |
|---|---|---|
| 加工及三类规划、统计、材料详情 | `domain/crafting.rs`、`domain/planning.rs` | 原有 43 项业务断言；31 组完整结果 SHA-256；覆盖 408 干员、阶段、稀缺/充足库存、无限材料及嵌套加工树 |
| 设置、账号快照、日志 | `storage.rs`、`service.rs` | dark 旧值、缺省 modules、重复读取、状态缓存、失败保留、清缓存与退出不同语义 |
| 加密凭据 | `platform/credentials.rs` | Electron→Rust 读取及重写→Electron 解密；原生重启、篡改拒绝、幂等读取 |
| 扫码、签名、绑定和同步 | `network/skland.rs` | 固定签名向量、401、10000/10002 两阶段续期、HTTP 500、续期失败不删除旧凭据、阿米娅多形态合并 |
| 资源 HTTP、校验、事务 | `platform/http.rs`、`resources/` | 实际本地 HTTP、重定向、坏哈希、不兼容 schema、下载中断、缺失文件/引用、A→B 图片字节、旧版本、重启和日志恢复 |
| 更新器 | `updater.rs` | beta/stable 筛选、beta.yml→latest.yml 回退、下载状态/进度、SHA-512、安装前二次校验、篡改拒绝 |
| 窗口与原生确认框 | `main.rs`、`platform/window.rs` | 外框/客户区、固定大小、主题、无菜单/新窗口、权限限制；确认框的人工验证限制见 G |

未添加原应用没有的 MAA、托盘、通知、SQLite、shell 或文件选择器。

## E. 有意保留的前端逻辑

DOM 渲染、页签、输入、IME、动画、展开/收起、键盘焦点、搜索筛选、展示格式、图片解码和视图缓存继续由原 JavaScript 实现。这些逻辑与浏览器 UI 紧密相关，迁出会增加边界调用和兼容风险。

候选名称的 `Intl` / `localeCompare('zh-CN')` 排序留在 `plan-order.js`，以保持原 Chromium 中文排序和同值稳定顺序。Rust 返回计算结果，桥接层完成这一步展示排序。未新增渲染框架或重写交互。

## F. UI compatibility

迁移开始时的六个原 renderer 文件（含 HTML、CSS、app.js）及图标 SHA-256 全部保持一致；不是拿 Git HEAD 覆盖用户已有未提交修改。新增平台桥、展示排序、一个兼容样式文件。构建副本替换 CSP 并注入桥接脚本/样式，原 HTML 的可见 DOM 未改。

25 张截图覆盖初始/主要页面、单阶段与连续规划、详情及嵌套配方、hover、selected、disabled、loading、empty、popup、dropdown、搜索、筛选、滚动、统计范围与设置。测试同时断言输入法组合、连续输入、焦点、回退/中间插入/粘贴、拼音、全部筛选维度、组合排序、卡片几何和窗口策略。

- 外框 1360×800，当前测试机客户区 1344×761；不可调整大小、最大化和全屏，可最小化/移动/关闭。
- loading 与搜索截图逐像素相同；大多数常规页面只有 0～45 个像素差异，最大通道差 1～6。hover 截图有轻微颜色量化差异。
- 精英化图标约 1,500～1,800 个像素有差异，最大通道差 45；展开配方的缩放图像最多约 11,700 个像素有差异。已对照图像、文案、数量与几何，差异集中于图像采样，不是数据或布局变化。
- 固定测试鼠标位置后，缓存提示最终状态仅 32 个像素差异；运动状态存在采样时刻差异。
- 单选按钮显式采用原默认蓝色后，设置页差异从 177 个像素降至 157 个，最大通道差从 196 降至 43。剩余为原生控件边缘/内部绘制差异。

**不能声称全界面逐像素零差异。** Electron 37 与本机 WebView2 153 的原生控件、图片重采样有上述差异；未通过重画控件或改动图片来掩盖差异，布局、字体、文案和交互仍保持原实现。系统 WebView2 后续升级也可能改变栅格化结果。

原始图、当前图和差异图分别在本地 `output/migration/baseline/screenshots`、`output/migration/final-ui`、`output/migration/final-ui-diff`。可用 `node scripts/compare-ui.mjs <baseline> <current> <output>` 重跑像素统计。

## G. 行为 compatibility 与验证边界

已验证：全部前端流程断言、14 项受限业务操作对应关系、资源切换/图片/缓存/重启恢复、凭据续期失败保留、退出与清缓存区别、固定窗口和主题、生产中没有 Node、未知 IPC 动作/字段拒绝、Ctrl+滚轮不改变缩放。

窗口关闭没有退出确认；更新由用户手动检查/下载/安装，Portable 不支持自动更新。无新增全局快捷键。WebView2 的浏览器快捷键、上下文菜单、缩放和滑动导航按原窗口行为关闭；文本编辑键仍由原前端/浏览器处理。依据：[WebView2 快捷键设置说明](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/AreBrowserAcceleratorKeysEnabled.md)、[Electron 37 的缩放回调](https://github.com/electron/electron/blob/v37.10.3/shell/browser/api/electron_api_web_contents.cc#L1314)。

以下项目没有虚报为端到端通过：

- **真实手机扫码、真实账号在线同步**：没有让用户重新认证；认证测试使用隔离合成凭据和可控 HTTP 响应，生产仍调用真实接口。已有凭据格式已双向验证，但不代替真实账号现场验收。
- **原生 confirm 点击与视觉**：使用与 Electron Windows 相同的 TaskDialog、应用名称标题、系统确定/取消、默认按钮、父窗口相对位置和 Escape 取消；代码及 Common-Controls manifest 已核对。computer-use 的应用访问确认超时，未取得原生对话框截图/点击结果。页面内 modal 已通过自动化。
- **真实公开新版的安装升级**：本次明确不升版本、不发布 GitHub Release，因此不伪造线上新版本。下载/状态/校验以原生单测验证；安装布局升级另用隔离 NSIS 测试。
- **冷启动、不同 DPI、多显示器、无 WebView2 的干净 Windows**：本环境没有可靠覆盖，需人工/独立环境验收。安装引导实现存在，但不能据此宣称在无 Runtime 机器实测通过。
- **安装向导外观**：Tauri NSIS 向导与原 electron-builder 向导不是像素等价；保留目录选择、安装身份、快捷方式和数据保留语义。双安装范围向导及缺失 WebView2 时的引导属于可观察的安装流程差异。此处轻量运行时目标与完全相同安装体验存在冲突，明确保留为验收限制。

## H. 数据 compatibility

沿用 `%APPDATA%/arknights-training-room` 及原 settings.json、account-cache.json、credentials.bin、Local State、game-data、backup、transaction.json、日志文件。规划仍由快照重算，没有迁移或清空用户设置/仓库/历史账号数据。

Electron 37 Windows OSCrypt 的 `v10 + nonce + AES-GCM 密文/tag` 由 Rust 兼容解密；`Local State` 内 DPAPI 包装密钥沿用。损坏密钥不会被悄悄替换，失败不覆盖旧密文。交叉验证使用合成数据，没有输出真实 token。原加密格式保留也是回退旧应用时仍可读取的条件。

新的浏览器缓存单独放在原数据根目录的 `webview2/`，不覆盖 Chromium 的 `Local State` 密钥。旧资源包 gzip JSON/base64、manifest、校验哈希、图片引用和版本规则均保留。更新先完成校验与派生结果构造，再进入短事务；失败保留旧数据。崩溃恢复测试覆盖磁盘上残留的未提交日志状态，不将其包装成覆盖所有断电时刻的证明。

## I. Build / package

- `npm test`：资源构建、类型检查、独立 Rust 测试、85 项 Node 断言、31 组冻结结果。
- `npm run build`：生产 Tauri 构建并覆盖唯一 `release/win-unpacked`。
- `npm run dist`：测试、原生 NSIS、Portable、beta.yml / latest.yml、SHA256SUMS，并同步 unpacked。
- `npm run qa:desktop` / `qa:resource`：原生开发构建的 UI / 真实 HTTP 回归。
- `npm run qa:packaged`：显式 `qa` feature 的优化构建进行 CDP 验证，之后恢复生产构建并同步；生产同步脚本拒绝含测试端口入口的二进制。
- `npm run qa:production`：实际 unpacked EXE 可见窗口、原路径缓存保留、QA 环境覆盖无效、正常关闭。
- `node scripts/qa-production.mjs --portable`：对单文件 Portable 执行相同的生产启动和退出验证。
- `pwsh -NoProfile -File scripts/qa-installer.ps1`：仅当原安装注册项不存在时，测试隔离旧目录布局→NSIS 覆盖→原更新参数→卸载；存在真实安装时拒绝修改它。

迁移验收阶段版本为 **0.0.20-beta.16**。构建核对 package.json 与 Cargo.toml，不自动递增。安装身份沿用 `89035d73-f384-5e6c-bda4-e2c88d3f133f`，恢复旧 InstallLocation；仅在该身份匹配且发现旧 ASAR 时移除已知 Electron 运行时文件，不清理用户目录中的未知文件。卸载不提供新增的删除账号数据选项。

生产包采用系统 WebView2，没有捆绑 fixed Runtime。NSIS / Portable 的缺失 Runtime 引导需要网络。未添加商业签名证书，继续保留原来的未签名发布限制。原生依赖完整许可写入 `THIRD_PARTY_LICENSES.txt`。

构建工具有一条来自上游 CLI/tauri-build 的 `STATIC_VCRUNTIME` 弃用提示；不影响本次构建，不隐藏成无警告构建。

2026-09-27 最终验证结果：独立 Rust 8 项单测与 2 项集成测试、85 项 Node 断言、31 组完整结果对照全部通过。25 张 UI 截图及配套行为断言、真实 HTTP 资源切换/恢复、下载等待期间图片读取、优化 QA 包的 IPC/缩放/资源校验全部通过。正式 unpacked 和 Portable 均能显示窗口、继承隔离旧缓存并正常退出；正式程序忽略 QA 路径和调试端口覆盖。

隔离 NSIS 测试通过：模拟旧 Electron 安装布局，沿用安装身份及目录，移除已知旧运行时，保留未知文件；原 `--updated` 参数可执行原地更新；卸载保留无关文件。安装后的 EXE 与 unpacked 仅差 Tauri 打包时写入的三个包类型字节（`UNK`→`NSS`），规范化这三字节后 SHA-256 相同。该测试不等同于在真实用户安装目录或线上跨版本升级。

迁移验收时，`release` 只保留该版 Setup、Portable、beta.yml、latest.yml、SHA256SUMS.txt 和唯一 `win-unpacked`；当时 `训练室.exe` 文件版本为 **0.0.20-beta.16**。生产包没有 `qa` feature，未提交、推送或发布 GitHub Release。后续版本与本地产物随用户要求更新，历史测量保留不变。

本地证据：完整发布构建 `output/migration/final-dist.log`，以及同目录的 `native-final-tests.log`、`node-final-tests.log`、`final-tests.log`、`final-ui/operators-search-filter-qa.json`、`final-packaged-ui.log`；端到端报告为 `output/resource-qa/report.json`、`output/production-qa/{report,portable-report}.json`、`output/installer-qa/report.json`。

## J. 实测对照

下表体积采用 MiB（1,048,576 字节）；时间和内存采用三次运行的中位数。

| 指标 | Electron | Tauri / Rust | 变化 |
|---|---:|---:|---:|
| Setup 安装包 | 104.91 MiB | 19.07 MiB | −81.8% |
| Portable 单文件 | 104.67 MiB | 19.03 MiB | −81.8% |
| unpacked 应用内容 | 338.93 MiB | 31.48 MiB | −90.7% |
| 重复/热启动至可见首屏 | 2307 ms | 1417 ms | −38.6% |
| 冷启动 | 未可靠测量 | 未可靠测量 | 需独立环境 |
| 空闲阶段工作集总和 | 437.19 MiB | 485.31 MiB | **+11.0%** |
| 空闲阶段私有提交量 | 280.67 MiB | 271.93 MiB | −3.1% |
| 干员页面工作集总和 | 476.15 MiB | 531.08 MiB | **+11.5%** |
| 干员页面私有提交量 | 314.45 MiB | 308.85 MiB | −1.8% |
| 纯 idle CPU | 未可靠测量 | 未可靠测量 | 探针/动画有干扰 |
| 带探针空闲 CPU 观测值 | 4.36% | 3.15% | 占整机 16 逻辑 CPU |
| 正常退出后的残留进程 | 三次均 0 | 三次均 0 | 均正常关闭 |

体积的原始字节数保存在 `output/migration/final-metrics.json`。unpacked 是两版可运行目录内容之和，未包含注册表/快捷方式/卸载器开销、用户缓存或系统共享 WebView2；完整安装后系统磁盘增量 **未可靠测量**。缺少 WebView2 的机器还会额外安装共享 Runtime，不能把 31.48 MiB 宣称为这种机器的全部新增占用。

启动三次原始样本分别为 Electron 2449 / 2307 / 2277 ms，Tauri 1417 / 1601 / 1295 ms。安装体积和重复启动有明确收益，**工作集没有降低，也未实现“大幅降低内存”**。

| 可见响应中位数 | Electron | Tauri |
|---|---:|---:|
| 进入干员页面 | 137.7 ms | 101.4 ms |
| 搜索输入至绘制 | 50.4 ms | 38.5 ms |
| 清空搜索至绘制 | 74.7 ms | 30.7 ms |
| 专精详情 | 87.8 ms | 35.1 ms |
| 进入仓库 | 151.9 ms | 136.8 ms |
| 材料详情 | 54.5 ms | 56.7 ms |
| 进入精英化 | 35.0 ms | 27.8 ms |
| 进入模组 | 24.6 ms | 22.0 ms |
| 进入统计 | 31.8 ms | 40.8 ms |

部分短交互有回退，三次样本不足以保证每个页面更快。筛选正确性已覆盖，但独立筛选响应延迟 **未可靠测量**。滚动工作流含固定发送间隔，不能用它推导纯滚动速度。

可复核的原始记录：`output/migration/baseline/inventory.json`、`output/migration/runtime-benchmark/{electron,tauri}.json`、`output/migration/final-metrics.json`；核心八场景记录在 `output/performance/latest.json`。`npm run benchmark:desktop` 自动构建优化 QA 版本、测量后恢复正式版；桌面样本运行时没有并行编译。

测量范围：同一 Windows 机器、16 逻辑 CPU、同一匿名账号 fixture（6 个持有干员）、同一 408 干员资源、同一 UI 工作流；每种运行时三次。启动计时从进程创建至首屏 DOM/可见图片完成并经过绘制帧，操作系统文件缓存未清空，因此仅称重复/热启动。原生性能构建采用与生产相同的优化等级，额外启用 `qa` feature 以开放 CDP 和隔离数据路径；生产包关闭这些入口。发布版另做无 CDP 启动验证。

内存覆盖主程序与所有子进程（包括 WebView2），列出工作集总和和私有提交量。工作集会重复计入共享页，不能等同于系统新增 RAM。私有提交也不是独占驻留内存。空闲段仍有原 UI 动画及测试 rAF/PerformanceObserver，另有 PowerShell 进程树采样；**纯 idle CPU 未可靠测量**，只能列出带探针的观测值，不能保证真实用户环境相同。

大数据量兼容由 408 干员结果对照覆盖；`benchmark:performance` 保留原八项场景，计时在 Rust 进程内执行、排除进程创建和 JSON IPC。原 TypeScript 规划计时包含中文展示排序，新核心计时不含该步骤，不能直接用这两份内部计时宣称等边界加速比。大账号下的完整可见页面端到端响应 **未可靠测量**。

## K. 尚存技术债

1. WebView2 的工作集总和未必小于 Electron；不能把安装体积缩小当作内存同幅下降。系统 Runtime 版本与共享页使比较需长期重复采样。
2. 完整 state 仍复制和序列化较大的 JSON。当前保留聚合接口和缓存以维护一致性；需要新证据时再考虑局部传输，避免破坏 revision/快照语义。
3. 规划和 API 边界部分使用 `serde_json::Value` 以保留原字段/数字语义；资源进入时有严格 schema 校验，但进一步静态类型化仍有维护价值。
4. WinHTTP、DPAPI、原生控件和安装器面向 Windows；没有宣称跨平台可用。系统代理/PAC 实现沿用平台机制，企业代理认证和所有网络故障组合未在本机穷尽。
5. UI 栅格化、原生确认框人工验收、不同 DPI、无 WebView2 安装环境和真实线上更新的剩余验证见 G。
6. 森空岛为非公开接口；既有接口变动风险及 GitHub 私有发布源限制仍存在。此次未扩大权限或内置私人访问令牌。

## L. Electron 残留审计

活跃源码、package.json / lock、node_modules、发布产物不再需要 Electron/main/preload/dead IPC。仍出现该名称的地方只有历史迁移说明、兼容性测试的排除断言、加密格式/窗口行为注释和安装器删除旧运行时的明确文件名；这些是持续的数据/安装兼容责任。

`src/resources` 下的 Node 工具继续构建资源，不是桌面 backend。`output/migration` 中保留迁移前源码归档、基线和测试证据，受 gitignore 排除，不参与构建和发布；没有把可执行的双运行时 fallback 留在应用里。

## M. 全部 UI / CSS 兼容改动

只有新增 `renderer/platform.css` 的一条规则：

```css
.radio-stack input { accent-color: #0075ff; }
```

目的：恢复原 Chromium 的单选按钮默认蓝色，减少 WebView2 原生绘制差异。没有调整布局、间距、字体、尺寸、图标、图片、动画或文案。原 styles.css 保持迁移开始时的原始字节。该兼容 CSS 由构建后的入口引入；平台脚本注入与 CSP 替换只服务于 native bridge，不改变可见 DOM。
