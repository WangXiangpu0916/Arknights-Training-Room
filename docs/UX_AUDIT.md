# 训练室体验审计 · 2026-09-28

审计对象是实际运行的 Tauri / WebView2 应用，版本保持 **0.1.0**。依次完成流程、视觉、动效三轮检查。测试使用独立目录中的测试账号，不复制真实凭据、不修改用户仓库。未安装第三方依赖。

## 最重要的五项改进

1. **规划搜索可以连续输入。** 专精、精英化、模组页只更新结果区域，保留搜索框、光标及中文输入法状态；无结果时可以直接清除筛选。
2. **专精详情与当前库存模式一致。** 从正在展示的真实库存或无限池候选中读取详情，避免卡片与材料清单取自不同结果。
3. **登录与弹窗可以退出、重试和用键盘操作。** 原生 dialog 处理焦点隔离；Esc 关闭并返回入口。关闭扫码会取消等待和后台轮询，过期或错误提供重新连接；角色选择和同步过程有明确状态。
4. **材料标题与桌面布局更清楚。** 材料名称和可合成数量分行；稳定滚动条宽度，防止页面切换时卡片跳宽；浅色主题提高强调色对比度。按后续要求，专精、精英化和模组卡片已恢复原来的紧凑排列，撤回姓名独立成行的改动；后续验收聚焦电脑端。
5. **反馈与状态恢复完整。** 保存中禁止重复切换，失败恢复原值并显示错误；配方加载失败可重试。弹窗、筛选、配方有短过渡，加载有指示，成功和错误有不同提示。尊重减少动态效果设置；技能名称只在悬停或聚焦时滚动。

## 截图

[打开前后对比画廊](../output/playwright/ux-audit/index.html)。原始 PNG 和机器可读检查结果均保存在 `output/playwright/ux-audit/`。

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 专精规划 | [前](../output/playwright/ux-audit/before-dashboard.png) | [回滚后](../output/playwright/ux-audit/card-layout-rollback/mastery-planner-single.png) |
| 仓库详情 | [前](../output/playwright/ux-audit/before-inventory.png) | [后](../output/playwright/ux-audit/after-inventory.png) |
| 390px 规划 | [前](../output/playwright/ux-audit/before-mobile-dashboard.png) | [后](../output/playwright/ux-audit/after-mobile-dashboard.png) |
| 390px 干员 | [前](../output/playwright/ux-audit/before-mobile-operators.png) | [后](../output/playwright/ux-audit/after-mobile-operators.png) |

截图来自真实应用渲染。专精规划“回滚后”截图反映当前卡片布局；其他截图保留原审计记录，窄屏截图早于此次回滚。窄屏“优化前”截图在第一轮流程修复后、第二轮布局修复前采集；桌面“优化前”截图在源码修改前采集。更新下载/就绪/错误和登录角色选择的状态截图使用了明确标识的测试桥接响应，不能视为实际下载或实际登录的证明。

## 验证方式

- `npm test`：原生测试、TypeScript 测试及 31 组完整规划结果对照。
- `node scripts/qa-desktop.mjs`：原有桌面检查，包括搜索、排序、配方展开、三类规划及窗口策略。
- `node scripts/qa-ux.mjs`：真实鼠标、键盘、中文输入法；三类规划单阶段/连续路线；真实库存详情；弹窗焦点/Esc；保存回退和跨页面保存；扫码取消/角色确认；四个宽度下的七个页面；减少动态效果。
- `node scripts/qa-production.mjs`：最终 unpacked 启动、窗口响应、正常关闭、原缓存保持及生产版禁用 QA 端口。

桌面 QA 需先构建 debug：`npx --no-install tauri build --debug --no-bundle`。若使用自定义 Rust 构建目录，设置 `CARGO_TARGET_DIR`；`qa-ux.mjs` 默认自行创建隔离测试目录并在结束时关闭实例。`ATR_QA_PORT` 只用于连接已经隔离的测试会话。

## 仍未验证或受限

- 已实际生成森空岛二维码并验证取消；完整的真实账号扫码、手机授权和在线数据同步仍需要账号持有人操作。角色选择到首页的 UI 流程使用测试响应验证。
- 应用仍是 Windows 桌面程序，保留现有固定窗口策略；窄屏结果属于 WebView 视口检查，不是手机安装包，也未做真实手机触屏验证。
- unpacked 本来不支持应用内自更新。更新各状态已检查，但没有执行安装器下载与覆盖安装；游戏内信赖、模组任务等接口未提供的条件仍须在游戏内确认。
- 取消扫码可立即关闭界面；已经在途的 HTTP 请求需要返回或超时后才能释放后台串行服务锁。
- 缓存清理的取消与确认分支通过替代 `confirm` 返回值验证，实际删除走隔离账号后端；Windows 系统确认框本身未做原生点击验证。

## 本地交付

运行 [`release/win-unpacked/训练室.exe`](../release/win-unpacked/训练室.exe)。本次不递增版本号，不创建额外解包目录，不提交或推送 Git。
