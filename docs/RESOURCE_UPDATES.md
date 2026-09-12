# 游戏资源独立更新机制

资源格式：schema 1。应用与资源分别使用应用 SemVer 和 `YYYY.MM.DD.sequence` 版本。新增干员、技能、模组、材料、消耗、名称、metadata 和图标只需发布资源；新计算规则、新 UI 行为或不兼容 schema 才需要升级应用。

## 改造前的真实链路

| 数据 | 来源 / 原来位置 | 原来在线更新 | 本次处理 |
|---|---|---|---|
| 干员、技能、精英化、专精、模组成本 | toolbox 七个 JSON，`resources/game-data` | 分别请求浮动分支，首个 ETag 代表整批版本 | 固定 toolbox commit 后转换为 GameData |
| 材料、加工公式、中文名称 | toolbox data / locales | 同上 | 同一固定提交 |
| 八职业 | professions.ts 适配上游编号 | 程序内置 | 只在构建转换中使用编号，运行时使用中文 enum |
| 分支、档案、拼音、实装日期等 | PRTS 同步的内置 JSON | 否 | 固定 vendored 输入 + 官方表派生资料一起进入快照 |
| 材料用途、描述 | PRTS 同步的内置 JSON | 否 | 官方固定提交补充，一起进入快照 |
| 模组类型、完整成本、升级曲线 | 官方表生成的内置 JSON | 否 | 共享原同步脚本的转换函数，固定官方提交生成 |
| 头像、材料、技能、精英、专精、职业、模组类型 / 阶段图标 | 内置 resources/images；renderer 文件相对路径 | 否 | 整套图像进入同一个快照，通过版本化本地协议加载 |

原 provider 虽有 `.next` / `.backup` 和解析后交换目录，但只更新七个 JSON，读取补充数据时仍访问安装包，因此存在新数据与旧 metadata / image 混用。也缺少严格 schema、跨数据引用和图片校验。旧培养表包含一个已命名但没有培养技能的高星条目；构建端现在排除没有发布培养数据的高星条目，避免进入已实装统计。经验物品原本不在材料目录中，现在统一补齐，供引用校验与升级规划使用。

planner、statistics、operator list、mastery、elite、module 和 inventory 原本已统一消费 GameData。本次保持这个模型，未另建平行业务模型。

## 借鉴 MAA 的范围

2026-09-12 核实的源码：

- [res-update-game.yml](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev-v2/.github/workflows/res-update-game.yml)：每 20 分钟 / 手动拉取已提取的上游数据，执行 ResourceUpdater，更新资源版本并提交。
- [ResourceUpdater/main.cpp](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev-v2/tools/ResourceUpdater/main.cpp)：把游戏表转换成战斗、公招、基建、物品、关卡数据和识别模板。
- [MaaResource](https://github.com/MaaAssistantArknights/MaaResource)：独立分发与 MaaCore 版本无关的动态资源。
- [Windows ResourceUpdater](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev-v2/src/MaaWpfGui/Models/ResourceUpdater.cs)：GitHub 完整压缩包合并 / MirrorChyan 更新、资源时间戳检查、空闲时重载。版本文件最后复制，并非本文实现的完整目录事务。
- [maa-cli installer/resource.rs](https://github.com/MaaAssistantArknights/maa-cli/blob/main/crates/maa-cli/src/installer/resource.rs)：通过 git / libgit2 clone 或 pull 资源仓库，支持配置分支和失败警告。

Training Room 借鉴独立生成、独立分发、集中加载和安全重载；严格哈希清单、稳定 GameData 包、兼容性门禁、事务回滚和版本化图片协议是此次针对 Training Room 实现的方案，不能理解为上述 MAA 客户端已经全部这样实现。

## 最终链路

```text
确定所有 Git dependency commits / 非 Git 资产预先锁定 SHA-256
  → Git tree/blob 内容寻址下载并校验 Git blob SHA
  → 固定 metadata / 图片输入
  → resource-inputs.json 锁定全部输入字节
  → 冻结输入副本
  → ToolboxResourceConverter + 共享 officialMetadata 转换
  → schema / 引用 / 资产 / sanity validation
  → 完整 snapshot + manifest + resource.atr.gz
  → immutable resource-* GitHub Release
  → resources-latest Release 更新 manifest 指针
  → 客户端 HTTPS 读取 manifest、检查兼容性和版本
  → 下载完整包、检查大小和 SHA-256
  → .next 解压、全文件校验、领域与图片校验
  → IPC 安全屏障 → 写未提交事务日志 → 原目录改为 .backup
  → .next 切换为 game-data → provider / planner / statistics 全量重载
  → 移除事务日志提交 → preload / renderer 刷新
```

运行时快照：

```text
manifest.json                  清单，资源版本、格式、兼容性、来源、文件哈希、允许的 fallback
data/game.json                 稳定 GameData，含 metadata / 完整培养成本 / 曲线
metadata/provenance.json        固定输入摘要、资产来源说明和非 Git 图标锁
metadata/notices.md             来源与版权 / 许可声明
images/...                     原有图标目录命名
```

包外 manifest 额外包含 `package.url / size / sha256`。包内 manifest 不包含自身包哈希，避免循环依赖。客户端逐字段读取 manifest，包内清单必须与远端对应部分完全一致。

`resource.atr.gz` 使用 Node 自带 gzip 压缩 JSON 容器，含固定格式标识、快照清单和 Base64 常规文件。它不包含 symlink、脚本或可执行文件。下载上限 80 MiB，解压 JSON 上限 160 MiB，总文件字节上限 110 MiB，单文件 20 MiB，最多 10000 个文件；文件路径同时拒绝目录穿越、NTFS stream、Windows 保留名称和大小写冲突。包体也校验每个文件的长度及 SHA-256。完整资源包的实际构建约 8–18 MB，当前不需要 delta patch。

## 固定输入和来源

`resources/resource-build.json` 定义内置快照版本、构建时间、最低应用版本和固定来源。`resources/resource-inputs.json` 锁定当前 vendored 文件的实际字节。任何输入变化而未更新锁文件，构建失败。

在线准备阶段先解析全部 dependency SHAs，之后 Git tree 和 blob 请求只使用这些 SHA，不再读取浮动分支。toolbox 提供基础表和头像 / 材料 / 技能图标；固定官方表补充模组、升级曲线、位置、标签、中文分支与材料文本。PRTS 扩展档案和固定 UI 图标沿用 vendored 种子。种子来源 commit 表示原始导入版本；seed 内容摘要同时记录当前被锁定的完整输入。只有 Git 来源宣称 commit。

PRTS 不是 Git 数据源。新增 `brk-x` / `ran-x` 类型 PNG 在资源构建前将 URL 与内容 SHA-256 固定于 `module-icons.lock.json`；该来源在 manifest 中以内容摘要标识，不虚构 Git commit。若 URL 返回了不同内容，禁止构建。今后新模组类型需要先导入图片并更新这个锁；这属于资源输入更新，无需改 App。

手动使用旧的 `metadata:sync / assets:sync` 更新输入后，先检查内容，重新执行 `node scripts/lock-resource-inputs.mjs`，再构建资源。在线 Resource Builder 不调用浮动 PRTS Cargo 查询，也不把动态 Wiki 页面读取混进已经锁定的构建过程。新干员没有上游可用的性别、生日等资料时保持领域模型允许的空字段，可通过更新种子 metadata 补齐。

## 门禁与兼容性

- 必填字段、类型、enum、唯一干员 / 模组 ID、技能所属干员、阶段与正整数成本均校验。
- 成本、加工输入、经验物品和龙门币都必须引用已有材料。
- 头像、材料、职业、模组类型 / 阶段、精英、专精与角标必须存在。缺失技能图标仅允许 manifest 明确列出的 fallback，且不得超过技能总数 10%；占位 SVG 本身必须存在。其他关键缺图直接拒绝。
- 干员至少 100、材料至少 30，必须有六星、技能、模组和有效升级曲线。对上一已验证快照比较干员、材料、六星、技能、模组及已知分支覆盖，减少超过 10% 禁止发布。
- 当前支持 schema 1；不同 schema 或低于 minAppVersion 时拒绝下载 / 加载，明确提示升级应用，继续使用本地兼容快照。不兼容新资源不会覆盖缓存。

## 事务、并发和退出恢复

继续使用 LocalStore 的 game-data 目录，不影响账号、设置和 DPAPI 凭据。首次升级迁移旧七文件缓存到完整内置快照；缓存损坏优先恢复已验证备份，否则恢复内置快照。

所有 main IPC（包括账号同步、设置、material detail、state / 规划 / 统计）通过 AppService.exclusive 排队。资源更新期间读取不会跨越切换。图片读取也通过屏障，先读取完整 Buffer 再响应，避免拿到旧路径却在目录切换后读取新字节。此实现以简单的整次事务锁为主：下载期间其他 IPC 会等候，当前内测资源规模无需复杂读写锁。

图片地址使用 `atr-resource://snapshot/<resourceVersion>/images/...`。固定域名避免数字日期被 Chromium 按 IP 解析；版本在路径中避免旧缓存复用。协议只返回 manifest 内的图片。保留一份备份处理上一 renderer 状态中尚未完成的请求。renderer 的 revision 阻止旧响应覆盖新状态；更新时关闭旧资源详情，并使 inventory 异步详情和派生缓存失效。

事务日志存在就表示切换尚未提交。下载 / 解压阶段退出时，下次启动丢弃 .next；旧目录移走后退出时恢复 .backup；重载失败时恢复目录并重建旧 GameData。重载成功且事务日志移除后，重新启动加载新快照。

## 分发选择与 CI

按用户明确选择，应用仓库将公开，资源也在该仓库 GitHub Release Assets 中发布。无需额外资源仓库或 Pages/CDN。Raw 更适合文本却难以表达一致的大批资产；Pages/CDN/镜像当前增加维护成本。资源用非 SemVer 的 `resource-* / resources-latest` 预发布标签，应用仍用 `v*`；应用更新器显式使用 beta channel，跳过非 SemVer 资源标签。

resources.yml 每小时 / 手动运行：现有测试 → 真实 Renderer E2E → 已发布 baseline 校验 → 固定上游准备 → 与 baseline 比较并构建 → 发布完整包 → 最后移动 manifest 指针。所有固定 upstream 和 seed 摘要未变时，不构建或发布新版本。CI 默认只读，发布 job 使用同仓库 contents:write，checkout 不持久化 token。没有把私人 token 打包到客户端。

内测必须具备的保护为 HTTPS、固定可信 manifest URL、同仓库 package 地址、受控 GitHub asset 重定向、SHA-256、schema / 兼容性 / 内容门禁和事务恢复。本次未引入数字签名。

## 操作和验证

```powershell
npm test
npm run resource:build
npm run qa:resource
npm run qa:electron
npm run qa:packaged # 先构建 release/win-unpacked
# 实际公开 HTTPS 更新：先 fetch-resource-baseline，再 qa:packaged -- --update
# 在线准备，命令需要 gh 能读取公开 API
npm run resource:prepare
npm run resource:build -- --input output/resource-input/input --output resource-publish --previous dist/resource/snapshot
node scripts/publish-resource.mjs resource-publish
```

Builder 输出与客户端载入的是相同 schema 和 validation 实现。原同步脚本 officialMetadata 转换被共享，原 provider 的临时目录 / 备份机制扩展为完整事务，原 state / IPC / preload / renderer 更新入口保持复用；性能基准直接读取稳定快照。

`qa-resource-update.mjs` 在临时 user-data 和独立 HTTP fixture 中执行 A→B，检查实际按钮更新、main / preload / renderer、新干员 / 技能 / 模组 / metadata、库存详情、新头像自然尺寸与 CDP 返回的 PNG SHA-256，生成 `output/resource-qa/report.json` 和 A/B 截图，不修改 production 数据。失败注入包含错误 checksum、坏包、非法 manifest、schema / app 不兼容、缺失 JSON / 图片、错误引用、网络失败 / 中断、重载失败、残留目录、损坏缓存、非法路径、恶意重定向，以及在真正更新进程未提交时终止进程后的恢复。

## 当前限制

静态数据针对国服简中。档案的可选字段可能等待上游或种子补齐；新类型图标未锁定前门禁会拒绝发布。下载期间其他 IPC 排队；网络连接失败会保留旧快照。当前可信清单依赖 GitHub 仓库和发布权限，没有单独的离线签名密钥。
