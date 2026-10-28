# agentschat 开发与交付约定

## 当前入口

- 0.1.36 已实际更新本机安装并保留原有数据，最新交付与回滚位置见 HANDOFF.md 的“0.1.36 本机更新与 GitHub 源码交付”。后端能力与未验收边界见 docs/ZCODE_QODER_INTEGRATION.md。

- 0.1.36 把 Qoder/ZCode 纳入 direct 多会话。Qoder 新会话使用原生 `default`，ZCode 使用原生 `build`，不得标为 OS 只读沙箱。`NativeModePool` 校验模式回显并保持固定模型；`yolo` 必须明确确认，旧会话不自动迁移。
- ZCode 桌面桥接仅验证 Windows 3.16.3。`standalone/zcode-desktop-host.cjs` 在本应用拥有的无窗口 Electron 进程加载安装自带 Host，通过随机口令的 loopback 连接服务 `lib/zcode-pool.cjs`；`zcode-host-worker.cjs` 只为该子进程设置原安装资源根。未知版本拒绝。不要复制凭据、修改安装包或持久化权限批准；原生 Host 负责账号授权。关闭必须收尾 Host/Agent 子进程。
- ZCode 混合房间的每个 session 绑定自身 Agent 工作区，不能强制等于 pool 启动目录。流式/终态同时核对 session、inputId 和 turnId，取消后的旧终态不能结束新一轮。模型请求已发出但状态未知时不自动重放。

- 0.1.34 起项目/桌面显示名为 `agentschat`，package.productName 与 builder.productName 对齐。DSH 内部 npm 包名、客户端注册 ID、服务端导出名与 patch specifier 保持 `dsh-agent-room` 一致。为兼容既有升级，保留 appId `com.mocias.agentroom`、`Agent Room.exe`、`%APPDATA%/Agent Room`、环境变量/API/存储键及插件路由。不得因改名直接迁移用户目录。新安装包为 `agentschat-Setup-*`；增量更新新旧卸载程序时保持原注册的目标文件名。GitHub 仓库与发布 remote 均为 agentschat；本地源码目录沿用原名。
- 独立 UI 的三栏布局位于 `standalone/public/chat-layout.css`，在原 app.css 后加载；所有颜色跟随主题变量。导航按钮必须有实际入口与可访问名称，保留 Codex/DSH 的会话与输入选项。
- 0.1.35 的 `sessionConfig` 仅用于 Codex/DSH direct 会话，默认新会话只读，旧会话不自动迁移权限。通过 `/api/session-controls` 验证后端目录，预设只能在首条消息前更改；权限变更需空闲并释放旧运行态。不得把选择器做成只改文字、静默切换模型或自动批准工具。
- `standalone/dsh-session-controls.cjs` 只在 Room 所属的 ACP 子进程复用已安装 DSH 预设配方、原生 agentPresets/permissionPresets；临时认证桥接位于数据目录 session-controls，不修改个人 DSH profile。禁用有 broken 诊断的预设，未知版本失败时报告不支持，不能伪造成功。打包必须实测从 ASAR 加载该桥接。
- `lib/approval-requests.cjs` 将原生权限请求绑定当前房间和随机请求 ID；只能由用户一次性允许或拒绝，回复结束/取消/释放/超时拒绝未决请求。无效房间的停止请求不能取消其他房间的确认。ACP 显示原生工具标题/参数供用户审阅，不把显示标题当作自动授权依据。

- 先读 `HANDOFF.md` 的最新版本节、`README.md` 和 `DESKTOP_VALIDATION.md`。版本以 `package.json` 为准，历史验收数字不能当成当前检查结果。
- 主产品是 `desktop/main.cjs`、`standalone/` 与 `lib/room.cjs`；`lib/index.js` 和 `public/` 是旧 DSH 插件入口。投票目前接入独立应用，不能宣称旧插件也已支持。
- GitHub 发布目标为 remote `agentschat` 的 `main`，即 https://github.com/mocias/agentschat。本地分支名仍可能为 `master`，当前 upstream 应指向 `agentschat/main`，不要据此误推旧仓库。提交、推送或发布须有用户授权；推送前 fetch 并检查远端分歧，不强推。
- 后续计划见 `ROADMAP.md`，社区贡献与适配验收见 `CONTRIBUTING.md`、`docs/HARNESS_INTEGRATION.md`；候选清单不代表已接入，不能未验证就改 README 的已适配状态。外部贡献通过 Fork/PR，由维护者审核合并。

## 功能边界

- 每个 Agent 使用稳定工作区，每个群聊有独立原生会话；不得用共同会话代替隔离。尊重用户选择的模型，不能静默换模型。
- 0.1.33 起 Codex / DSH 支持一个 Agent 下多个 direct 会话，历史与原生上下文按房间隔离，工作区与记忆仍按 Agent 共享。`POST /api/conversations` 只建索引，`/conversation/title` 只改会话标题；旧 `/conversation/rename` 仍用于 Agent / 群聊改名，不可覆盖已有会话自定标题。Agent 与会话置顶分开保存，旧单聊置顶只作为 Agent 初始状态兼容。
- 前端 `composerAdapters` 按 direct 会话所属 Agent.backend 路由 Codex / DSH 布局；群聊与其他 harness 走通用布局。不把原生桌面 UI 截图中的未接入能力做成可用按钮；模型继续固定，推理设置经真实后端目录验证。
- 长期 memory 按稳定的 Agent ID 隔离，不能按 harness 或群聊划分归属。同一 Agent 在单聊和各群聊中有权接收的内容，默认进入该 Agent 的同一份共享记忆，并可跨会话检索；即使使用相同 harness，不同 Agent 也不共用 memory。
- 群聊独立的原生会话负责当前上下文、消息路由与运行状态，不切断该 Agent 的长期记忆。0.1.32 的 Room 记忆实现位于 `lib/agent-memory.cjs`，由独立宿主共享实例自动写入，并在每轮向原生会话提供本地检索片段；不发起摘要/embedding 模型请求。记忆保留来源房间、消息与可见范围，沿用私聊和匿名投票的输出边界；不能把共享工作区或原生恢复等同于 Room 记忆服务。
- 新建/修改工作区必须检查不同 Agent 的重复、嵌套和链接别名。旧共享目录不自动搬动或删除；保留路径与文件，提示冲突并阻止相关 Agent 创建/使用原生会话，待用户选定独立目录。不得通过复制账号配置或放宽工具权限实现隔离。
- 投票由 `lib/polls.cjs` 持久化，`lib/poll-mcp.cjs` 绑定房间和成员身份，`lib/poll-mcp-stdio.cjs` 向后端提供七个 MCP 工具。身份来自绑定，不能接受模型自报 voter/room 身份。
- 匿名投票的 API、SSE、界面、聊天日志和导出必须经过授权视图；不得直接返回内部 ballots/history/attempts。匿名轮次不展示生成文本或工具参数，结果仅汇总。内部磁盘和后端会话可能保存归属，因此不能宣称密码学匿名。
- 用户可以创建、管理投票但不计票；参与者是创建时成员快照，发起 Agent 也参与。重复调用不得增加票数；退出、忙碌、改票、弃权、截止和重启要保持一致。
- 保持原有文件/执行权限边界。Codex 按工具批准、Claude 精确工具白名单、WorkBuddy 依据 `_meta["codebuddy.ai/toolName"]` 判断身份；不能靠 rawInput 或显示标题批准工具。
- 打包后的桥接使用 Electron Node 模式读取 ASAR，不依赖系统 Node。

## 数据与工作区

- 不提交或打包聊天、账户、凭据、个人工作区、测试输出和第三方运行时；遵循 `.gitignore`。
- 不覆盖用户数据或运行中的桌面状态文件。桌面登记的退出等待、备份、原生入口和冲突检查必须保留，详见 README。
- 升级/卸载保留 agents 工作区；不得移除 `desktop/preserve-agents.nsh` 的保护。删除或移动前核对绝对路径，禁止目录穿越和祖先目录误操作。
- 修改已有混合工作树时保留其他改动，明确本次提交范围。原生会话登记不等于聊天历史同步。

## 验证与交付

- 基础回归 `npm test`；按改动运行相关真实 UI 或后端检查。真实模型检查使用隔离数据，会消耗用户额度；不得把 fixture 测试当成真实回复验证。
- 外观改动运行 `node scripts/check-ui-appearance.cjs`：使用本机 Chrome 与隔离 HTTP/SSE 服务，不调用模型或扫描安装；截图及报告写入 `output/playwright/appearance-*/`。同时保留现有输入栏、键盘和滚动回归。深浅色应跟随保存的背景色，新增颜色使用主题变量，不写死浅色控件。
- 多会话验收 `node scripts/check-agent-sessions-ui.cjs`：隔离 HTTP/SSE、草稿附件切换、会话命名/置顶、模型推理界面、四种宽度和深浅主题。`UI_PACKAGED=1` 使用最终 EXE 并检查重启保留；默认打包模式不保存模拟推理选项，不启动真实后端，只有下面的显式原生能力检查会启动后端读取配置。截图为隔离演示消息，不能冒充真实模型回复。
- 原生配置：`node --test checks/session-controls.test.cjs`；`UI_PACKAGED=1 UI_NATIVE_CONTROLS=1` 的多会话脚本实际读目录并保存，仍不生成。`scripts/check-native-session-controls.cjs` 实测隔离空会话权限，`CONTROLS_ASAR` 指向最终 ASAR 时须用 Electron Node 模式运行。目录/配置实测不证明真实模型或工具执行；不要运行旧脚本中的生成测试代替它。
- README 界面示例默认使用隔离演示数据，保留 harness 名称可见，并注明演示消息不是真实模型回复；用户明确指定上传的截图可按其要求使用，并据实更新图片说明。示例图片位于 `docs/images/`；未经用户授权不得上传真实聊天截图，不得把整个 `output/` 纳入提交。
- 投票回归 `node --test checks/polls.test.cjs`；显式真实检查 `node scripts/check-live-polls.cjs codex,dsh`，其他可用组合见 DESKTOP_VALIDATION.md。
- 记忆/目录回归 `node --test checks/agent-memory.test.cjs checks/workspaces.test.cjs`，使用临时数据和模拟 CLI，不消费真实模型额度。打包后运行 `node scripts/check-packaged-memory.cjs`，核对 ASAR、旧历史回填、重启去重与原文件校验；它不替换真实安装。
- 构建前同步 `package.json` 与 `package-lock.json` 版本。运行 `npm run desktop:dist`，再验收最终 `dist/win-unpacked` 的程序和 ASAR 内容，检查源码匹配与污染文件。
- 完整安装包、增量包和 SHA-256 放在 `dist/`，不得提交进 Git。增量包必须基于准确旧版本文件，并在隔离副本上验证文件校验和数据保留。
- 报告分清：源码已实现、自动测试、真实后端、打包程序、安装器、用户实际安装。没有执行安装更新，就不要宣称用户已升级；未经请求不要发布 GitHub Release。
- 更新 HANDOFF、AGENTS 与验收记录，给出实际证据路径。`output/` 是本地证据，不随源码上传。

## 建议技能

- `handoff`：更新交接内容；用户要求更新仓库现有文档时，以用户指定位置为准。
- `diagnose`：复杂后端或并发故障；先复现再做最小修复。
- `playwright`：实际界面操作与状态恢复验证。
- `openai-docs`：需要核对 Codex/MCP 官方接口时使用。
