# 训练室

Windows 10/11 本地桌面应用。读取森空岛的真实仓库、持有干员和技能专精状态，按加工站的确定配方进行库存扣除模拟，打开首页即可看到“现在能专精什么”。运行时不使用 LLM、Agent、AI API 或 AI Token。

## 已实现

- 森空岛 App 扫码登录、绑定角色选择、手动刷新与可选启动刷新
- 仓库、精英阶段、技能 Rank、每技能 M0/M1/M2/M3 同步
- `M2→M3 > M1→M2 > M0→M1` 单阶段独立规划
- 六档连续专精及严格完全反向排序
- 多层递归、共享原料、整数批次、多产物和循环防护
- 无限材料的正式状态、合成链传播及结果依赖标记
- 首页筛选、干员页、仓库页、材料配方和专精加工详情
- 断网缓存、原子游戏数据更新、损坏缓存回退、错误保留旧数据
- Windows DPAPI 凭据加密、退出账号、脱敏轮转日志
- NSIS 安装包与 portable 单文件构建

## 使用

1. 从 `release` 目录运行安装包或 portable 版本。
2. 首次启动点击“使用森空岛 App 扫码连接”。
3. 在森空岛 App 中确认登录，选择绑定的《明日方舟》角色。
4. 同步完成后首页直接显示当前可行的专精。
5. 活动无限池材料在“仓库”页开启；真实库存数字始终保持不变。

设置页可以刷新游戏数据、切换连续排序、清理账号缓存或删除本地认证。

## 本地数据与安全

数据默认保存在 `%APPDATA%/arknights-training-room`：

- `credentials.bin`：Electron `safeStorage` 加密；Windows 上使用 DPAPI
- `account-cache.json`：最近一次成功的账号快照，不含登录凭据
- `settings.json`：无限材料、排序、选中 UID 和自动刷新开关
- `game-data/`：最近一次成功的静态游戏数据
- `app.log` / `app.log.1`：最大约 1 MB，敏感长字符串会被替换为 `[REDACTED]`

“清理账号缓存”不删除凭据；“退出 / 删除认证”只删除加密凭据。规划始终使用账号快照的副本，不会修改真实仓库缓存。

## 从干净环境构建

要求：Windows 10/11、Node.js 20+。最终用户不需要这些开发工具。

```powershell
npm ci
npm test
npm run dist
```

输出位于 `release/`：NSIS 安装包和 portable `.exe`。

开发启动：

```powershell
npm install
npm start
```

## 项目结构

```text
src/
├─ domain/types.ts                  统一领域模型
├─ engine/crafting.ts               确定性加工与库存模拟
├─ engine/mastery.ts                单阶段/连续专精规划
├─ data/skland-client.ts            森空岛 adapter
├─ data/game-data-provider.ts       游戏数据 provider 与原子更新
├─ data/local-store.ts              缓存、DPAPI 凭据与日志
├─ app-service.ts                   应用用例与自动重算
├─ main.ts                          Electron 主进程
└─ preload.ts                       受限 IPC 边界
renderer/                           中文桌面 UI
resources/                          内置离线数据与图标
tests/engine.test.ts                核心自动化测试
docs/DATA_SOURCES.md                2026 数据源技术审计
```

## 计算保证

每次可行性判断都复制真实仓库。加工会按整数批次递归扣除输入，确定产物才入库，随机副产物完全忽略；任何未知材料、缺失配方、无效产量或循环依赖都会保守地判为不可行。单阶段候选各自从同一快照开始，连续模式则把上一阶段的剩余库存交给下一阶段。

无限材料用集合状态表示，不用大数字替代。某产物只有在其本身被设为无限，或配方的每一种输入都可由无限链得到时，才会传播为无限。

## 测试

```powershell
npm test
```

测试覆盖需求中的 18 个 Case，并额外覆盖多产物整数批次、循环配方与精二/Rank 7 前置条件。

## 已知限制

- 森空岛接口是非公开接口，没有公开 SLA、固定 Token 生命周期或频率额度；应用只在用户刷新或明确启用启动刷新时访问，并按返回错误码刷新签名 Token/凭据。
- 当前静态名称与账号接口针对国服简中数据。
- 未登录时无法端到端验证某个真实账号；数据契约基于 2026-08 仍维护的实现，接口改变时会显示错误并保留旧缓存，不会给出可能错误的新候选。
- 新增干员的静态 JSON 可在线更新；若其头像尚未随安装包发布，数据与计算仍可用，头像可能暂时为空。
- 当前构建没有商业 Authenticode 证书，Windows SmartScreen 可能在首次运行时显示“未知发布者”；可核对下方交付哈希后选择继续运行。

游戏名称与图片版权归上海鹰角网络科技有限公司及其关联公司所有。本项目仅作为本地个人工具使用。
