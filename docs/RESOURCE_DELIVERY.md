# 游戏资源独立更新交付记录

## Implemented

应用 `0.0.20-beta.15` 与资源 `2026.09.12.1 / 2026.09.12.2` 分别更新。设置页的“检查并更新资源”读取可信 manifest，下载完整资源包，验证兼容性、SHA-256、内容和图片后安全切换并刷新界面。首次升级自动迁移旧缓存。现有 schema 能表示的干员、技能、材料、模组、消耗、metadata 和图片可只发布资源。

## Architecture

固定所有上游 commit / 非 Git 资产 SHA-256 → 内容寻址下载 → 共享 metadata 转换 → 冻结输入 → 稳定 GameData schema 1 → 全层校验 → 完整包与 manifest → 不可变 resource-* Release → resources-latest 清单指针 → 客户端校验 → .next / .backup / 事务日志 → 安全屏障 → 重建 provider、planner、statistics → preload / Renderer 刷新及版本化图片。

完整审计、MAA 实际行为与本次改进的区别、门禁和操作方法见 [RESOURCE_UPDATES.md](RESOURCE_UPDATES.md)。

## Reused

复用 GameData 领域模型、LocalStore、原 provider 的 .next / .backup 替换、原 toolbox 转换、metadata 同步的官方表转换、现有规划和统计逻辑，以及 game:update IPC / preload / 设置页入口。固定 PRTS 档案和 UI 图片作为资源种子保留。

## Changed

增加 src/resources 中的 schema、converter、builder、package 和 validation；扩展 game-data-provider 事务与网络信任检查；AppService 和 main 增加统一安全屏障、重载和本地图片协议；Renderer 使用 resourceVersion 图片路径并拒绝旧异步响应。增加固定输入锁、资源准备 / 发布脚本、每小时 CI、资源 E2E 和打包检查。业务 planner 与统计计算规则保持复用。

## Validation

| 检查 | 结果 |
|---|---|
| npm test（含 build / tsc） | 99 / 99 通过，无跳过 |
| 固定种子资源重复构建 | 两次完整包 SHA-256 一致 |
| 在线固定版本准备 / resource build | 两个 Git commit 均固定，Git blob 内容校验；完整 B 通过相对 A 的门禁 |
| npm run qa:resource | 真实 Electron Main / preload / Renderer A→B 通过 |
| npm run qa:electron | 现有搜索、输入、筛选、规划、统计、图片、主题与布局检查通过 |
| node scripts/benchmark-performance.mjs | 现有全部规划基准运行成功 |
| npm run qa:packaged | 解包应用启动、真实版本、资源与 PNG 字节检查通过 |

卡片布局检查曾在图片解码前测量 intrinsic width，现改为等待首张卡片的图片加载，复验通过。最终打包的 Electron 下载曾因直连超时失败，改用本机已配置的系统代理继续构建。

## End-to-End Verification

真实 Electron 先读取 A `2026.09.12.1`，独立 HTTP fixture 随后提供 B `2026.09.12.2`；点击设置页更新，完成清单、下载、校验、替换、重载。Renderer 显示改名的阿米娅、新干员 / 技能 / 模组及 metadata 和新材料详情，CDP 实际返回的头像 PNG SHA-256 与 B 相同：`4893e1ff59011bcac3c95025d958c8e0b5243b233a5b9372e4413d6130f17d10`。重启继续读取 B；未提交事务重启恢复 A。

fixture 仅在临时 user-data / 输出目录中生成，不进入 production 资源。报告及截图在 output/resource-qa，现有界面报告在 output/playwright，打包检查在 output/packaged-resource-qa。

实际生产 B 固定来源：

- toolbox：`4f589e1864bcb27e3ef0d5c6d001b45187232251`
- 官方表：`0ef7f952dfd018392200157a5c79a6511ba69122`
- 新模组类型图片：module-icons.lock.json 中预先固定 URL 和 SHA-256
- PRTS 扩展档案 / 固定 UI：当前种子输入摘要及原始导入来源

B 包 8,358,495 字节，SHA-256：`7cf5a5a898b9c48a254e186c17dc44c7db7aa49e0686a6c5885bfa271344f3c2`。

| 生产快照 | 干员 | 材料 | 专精技能 | 模组 |
|---|---:|---:|---:|---:|
| 内置 A 2026.09.12.1 | 408 | 97 | 922 | 492 |
| 独立 B 2026.09.12.2 | 411 | 97 | 929 | 496 |

## 发布位置

- [应用 beta.15](https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/tag/v0.0.20-beta.15)
- [独立资源 B](https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/tag/resource-2026.09.12.2)
- [资源清单](https://github.com/WangXiangpu0916/Arknights-Training-Room/releases/download/resources-latest/manifest.json)

仓库按用户授权公开。应用版本发布仍走原 v* 标签工作流；资源指针仅在不可变包上传并公开后更新。本地只保留 release/win-unpacked 一个解包目录；训练室.exe 文件版本为 0.0.20-beta.15，旧 beta.14 安装包 / Portable / blockmap 已清理。

## Failure Recovery

错误 checksum、损坏 gzip、非法 manifest、不兼容 schema / minAppVersion、缺失清单或包内关键 JSON、关键图片缺失、未知材料引用、网络连接失败 / 下载中断、业务重载失败，均拒绝新资源并保留可读 A。Windows 路径穿越 / 保留名、外部下载地址和恶意重定向被拒绝。

真实子进程在目录切换后、事务提交前暂停，由父进程强制终止；重新初始化恢复 A。另验证残留 .next 不被加载、未提交日志恢复及损坏缓存恢复备份。并发更新只下载一次，IPC 读取无法越过事务屏障。

## Remaining Limitations

当前资源针对国服简中。新干员的性别、生日等可选档案等待上游或种子补齐；新模组类型必须先导入并锁定图标，否则发布门禁拒绝。下载期间其他 IPC 排队。可信清单依赖 GitHub 发布权限，当前没有独立离线签名。
