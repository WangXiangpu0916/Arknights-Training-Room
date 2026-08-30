# 2026 数据源技术审计

审计日期：2026-08-25。

## 森空岛账号数据

### 采用的链路

应用把森空岛访问集中在 `SklandClient`，没有在 UI 中直接请求接口。

```text
POST as.hypergryph.com/general/v1/gen_scan/login
GET  as.hypergryph.com/general/v1/scan_status
POST as.hypergryph.com/user/auth/v1/token_by_scan_code
POST as.hypergryph.com/user/oauth2/v2/grant
POST zonai.skland.com/api/v1/user/auth/generate_cred_by_code
GET  zonai.skland.com/api/v1/game/player/binding
GET  zonai.skland.com/api/v1/game/cultivate/player?uid=...
```

扫码 URI 为 `hypergryph://scan_login?scanId=...`。2026-08-25 实测 `gen_scan/login` 返回 `status=0` 和 32 字符 `scanId`。

扫码确认后得到 24 字符访问 Token，再交换 grant code、`cred` 与签名用 `credToken`。签名输入为请求 path、GET query、时间戳和紧凑 header JSON；先做 HMAC-SHA256，再对十六进制结果做 MD5。`credToken` 只在本机参与签名，不发送给数据接口。

`player/binding` 返回 `arknights` 下的绑定角色与默认 UID。`game/cultivate/player` 返回：

- `characters[].id / level / evolvePhase / mainSkillLevel`
- `characters[].skills[].id / level`（level 为当前 M0-M3）
- `characters[].equips[].id / level`（当前已开启模组与等级）
- `items[].id / count`（仓库）

这条培养接口在 2026-08-18 仍更新的 `arkntools/arknights-toolbox` 中用于导入仓库和完整干员养成状态。扫码、凭据交换、刷新和签名还与 2026-07-13 更新的 `TNXG/skland-api` 交叉核验。

### 生命周期、设备与频率

- 服务没有公开稳定的 Token 生命周期。签名 Token 返回 `10000` 时调用 `/api/v1/auth/refresh`；凭据返回 `10002` 时使用加密保存的访问 Token 重新交换。
- 当前扫码链路不要求第三方 dId 服务；签名请求在每次应用进程中生成一个随机 UUID 作为 `dId`，并使用 `platform=3 / vName=1.0.0`，与培养接口的当前维护实现一致。它不是硬件指纹，也不上传给无关服务。
- 没有发现公开、可验证的固定频率额度，因此不写死虚构数字。默认仅手动刷新，可选启动刷新；二维码每 2 秒轮询，最多 120 秒。
- API schema 缺少 `characters` 或 `items` 时同步失败并保留旧快照。

### 安全边界

`accessToken / cred / credToken` 作为一个加密记录写入 Electron `safeStorage`。Windows 使用 DPAPI，日志不记录任何完整凭据。应用不经过代理服务，也不把账号数据上传给其他第三方。

## 静态游戏数据

采用 `arkntools/arknights-toolbox-data` 的结构化发布数据，上游为 `MooncellWiki/OpenArknightsFBS`。内置快照：

- commit `5eebd23466e01e989d3bee0e7b6c730fee89c9c8`
- commit 时间 `2026-08-20T15:11:55Z`

使用文件：

| 文件 | 用途 |
|---|---|
| `data/character.json` | 星级、职业 |
| `data/cultivate.json` | 专精、精英化与模组开启/升级材料、阶段和等级门槛 |
| `data/item.json` | 材料等级、类型、加工配方 |
| `locales/cn/character.json` | 官方中文干员名 |
| `locales/cn/skill.json` | 官方中文技能名 |
| `locales/cn/material.json` | 官方中文材料名 |
| `locales/cn/uniequip.json` | 模组中文名 |

`cultivate.skills.elite[].cost[0..2]` 分别映射 M1/M2/M3；`cultivate.evolve` 与 `cultivate.uniequip` 分别提供精英化和模组需求。`item.formula` 是确定输入；普通加工产出 1，芯片转换按游戏规则产出 2。随机副产物字段不进入模型。

“检查并更新”先把六个文件下载到旁路目录，全部完成 JSON 与领域解析后再目录交换；任一下载或解析失败时继续使用旧目录。缓存损坏则回退到安装包内置快照。

## Adapter 边界与替换策略

- `SklandClient` 是账号 adapter；未来可由其他账号 provider 替代，只需输出 `AccountSnapshot`。
- `ToolboxGameDataProvider` 是静态数据 provider；业务引擎只消费统一 `GameData`，不依赖 GitHub 或网页 HTML。
- PRTS 用于通过 `npm run assets:sync` 同步专精等级、技能、精英阶段图标，以及通过 Cargo 写入干员标签和材料用途/描述。模组图片由 PRTS 静态资源按真实模组 ID 懒加载；其余规划数据不依赖网页 HTML。结构化数据缺字段时仍应在 provider 层增加校验/补充，不把 HTML 结构渗入规划器。

## 参考实现

- https://github.com/arkntools/arknights-toolbox
- https://github.com/arkntools/arknights-toolbox-data
- https://github.com/TNXG/skland-api
- https://github.com/MooncellWiki/OpenArknightsFBS
- https://github.com/Kengxxiao/ArknightsGameData （旧 JSON 来源与交叉校验）
