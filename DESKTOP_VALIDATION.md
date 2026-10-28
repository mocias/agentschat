# Windows 桌面版验收 · 2026-10-16

## WorkBuddy refusal 复查 · 2026-10-20

- 同一 WorkBuddy AI 安装、`deepseek-v4.1-flash`，单运行时/单会话/单 prompt 成功返回 `WORKBUDDY_LOCAL_OK`：`output/workbuddy-diagnosis-ji48xn/report.json`。
- 与当前 Agent 配置对齐的模型和 `effort=enabled`，经过真实 HTTP、Room 引擎、WorkBuddy 后端成功返回 `WORKBUDDY_ROOM_OK`：`output/workbuddy-room-live-InTgbw/report.json`。均使用隔离数据目录。
- 当前已安装 0.1.28 的原始服务代码也通过同样的完整流程：`output/workbuddy-room-live-XbxPC9/report.json`。因此本次恢复不依赖安装 0.1.29；未修改用户配置或正式代码来改变请求行为。
- 昨日探测日志确认上游 HTTP 429 出现在生成前，WorkBuddy 内部等待 474 ms 后重试一次仍失败。可见日志没有可用于区分具体原因的业务码。未证明账号额度耗尽、本机并发超限或服务过载中的哪一种；当前未复现，不把暂时恢复表述为根因修复。
- 初版完整流程夹具遗漏 effort，触发本地 `none` 不支持；补齐用户真实的 `enabled` 设置后通过。这一夹具失败不是用户 refusal 的根因。

## 0.1.29 消息发送与后端错误 · 2026-10-19

- 已复现旧版慢模型期间第二次 `/say` 返回 409；新增测试先失败，修复后通过。桌面提交只等待消息落入房间，不等待整个模型回复。其他调用方默认仍等待回复。
- 全部 `checks/*.test.cjs` 105/105 通过。覆盖慢成员不阻塞其他成员、同成员补充、固定模型失败原因和会话清理、WorkBuddy 错误详情脱敏与部分输出后失败。
- 真实浏览器 + HTTP + SSE + 房间引擎验证通过；仅推理使用可控慢回复替身。覆盖鼠标/Enter 发送、群聊、单聊、Codex steering、ACP 取消后接续、切换会话保留草稿、停止、无重复用户消息及无浏览器异常。证据：`output/concurrent-chat-ui-r7Kunw/report.json` 和 `send-while-thinking.png`。
- 真实 WorkBuddy AI 当前固定模型 `deepseek-v4.1-flash` 探测失败，返回 `Quota exceeded: 429 too many requests`。这是上游额度/限流，未声称模型回复恢复。证据：`output/workbuddy-live-ogV5Ab/report.json`。
- 真实 Claude 默认模型初始化通过，未发送聊天。截图中的 `claude-opus-5-5` 可从目录读取，但实际应用固定模型返回 `Model 'claude-opus-5-5' not found`，聊天未发出。目录选择已不再触发多余的 `set_model`；固定模型会话仍严格校验，不静默换模型。证据：`output/claude-live-fruUAy/report.json`、`output/claude-live-XtHAGI/report.json`。
- 0.1.29 安装包与 0.1.28 → 0.1.29 增量包已生成。独立桌面启动通过，修复文件与源码逐字节一致：`output/packaged-chat-fix-NmbECp/report.json`。增量包以本机已安装 0.1.28 为基线，三个文件重建 SHA-256 校验通过；未执行用户安装目录的更新。

## 0.1.8 工作区、删除与原生归档边界

- 最终回归 26/26 通过，包含删除确认、共用/祖先路径保护、模型与角色指令隔离。
- 最终打包桌面验收 `output/desktop-smoke-exb3Jx/report.json` 通过；实际交互覆盖取消删除、保留目录、确认完整路径后删除、重启恢复。原生文件选择器仍用模拟返回值。
- 无工作区环境变量覆盖的打包程序默认根目录验证：`output/default-root-tDy4F6/report.json`，确认为 EXE 同级 `agents/`。已有 Agent 不搬目录。
- 安装器清理宏隔离执行：`output/installer-preserve-lRIIFE/report.json`，应用文件删除而 `agents/` 保留。实际执行的是同一 NSIS 宏的无注册表测试程序，不是覆盖用户已安装版本或完整卸载验收。
- Codex：`output/native-codex-vN7bjq/report.json`，同一 Agent 项目下两段独立会话均回复 SYNC_OK，并读回 projectId。当前桌面 read_thread 能读回验证对话；list_projects 未显示新项目，GUI 自动项目同步仍未完成。成员菜单提供 `codex://threads/<id>` 打开入口；该系统协议的用户点击跳转未纳入自动 UI 验收。
- DSH/Qoder：`output/persona-live-J3wtcF/report.json`，实际回复 DSH_PERSONA_OK / QODER_PERSONA_OK，验证首次 ACP prompt 已接入身份和角色设定。0.1.7 的 ACP 实现曾遗漏这些指令。
- DSH 的 workspaceRegistry 和 Qoder 的桌面项目/消息库尚未对接；界面明确标记未支持，不将 ACP 聊天成功视为原桌面可见。
- 浏览器服务已更新，默认工作区根为源码目录/agents。安装包 `dist/Agent-Room-Setup-0.1.8-x64.exe` 已构建；用户原已安装版本未覆盖。

## 0.1.7 扫描前告知与手动配置

- 首次使用（含升级后的旧数据）未作选择前不自动发现；弹窗说明读取范围，提供允许扫描与不扫描手动配置。选择按数据目录保存。
- 手动模式不查询系统安装信息、进程、PATH，不遍历安装目录；仅检查用户指定的程序文件及对应入口。目录输入会被拒绝。
- 后端管理增加扫描设置入口，手动查找指引覆盖快捷方式、打开文件位置和属性目标。
- 21/21 回归通过，包含无许可/手动模式下扫描计数为零、重启保持选择、授权后开始扫描。
- 打包桌面首次拒绝、重新授权、功能回归和重启验收通过：`output/desktop-smoke-SVCCtN/report.json`。
- 浏览器服务已更新且保留未选择状态，等待用户自行决定。安装包 `dist/Agent-Room-Setup-0.1.7-x64.exe`，未替换已安装版本。

## 0.1.6 Qoder 桌面 Worker 适配

- 本机 Qoder CN 0.4.8 内置 SDK 1.0.52 / Worker 1.1.69，支持隐藏的 `--acp` 参数。新增 Worker 标准输入输出桥接，使用 Qoder 自带 Electron Node 运行，无需另装 CLI。
- 自动发现必须同时验证 ASAR 内 SDK 和外部 Worker 文件；优先运行中的桌面版。无入口的普通桌面程序仍不宣称可用。
- 初次 session/new 返回 Authentication required；通过内置运行时官方浏览器登录成功后，两个独立会话及真实 QODER_OK 回复通过。报告：`output/qoder-live-dcv9cw/report.json`。
- 打包桌面 ASAR 环境真实 QODER_DESKTOP_OK 回复通过。报告：`output/qoder-desktop-4d6ODU/report.json`。
- 模型查询/固定模型选择已接入，当前返回 15 个模型选项。当前未返回 thought_level，不提供虚构推理档位。auto 是后端自动选模策略，不代表具体模型固定。
- 20/20 自动回归通过；浏览器实际返回 Qoder detected 与 15 个模型选项。
- 完整桌面界面验收通过三种后端添加、Qoder 固定模型保存及重启恢复：`output/desktop-smoke-10tCks/report.json`。前一轮在截图步骤超时，未算通过；重跑成功。
- 安装包 `dist/Agent-Room-Setup-0.1.6-x64.exe`，尚未替换已安装版本。本次只实际验证 Qoder CN 0.4.8，其他版本需另行验证。

## 0.1.5 Codex 桌面后端优先

- 自动选择优先正在运行的桌面托管后端，再选择其他桌面后端，最后回退 npm/PATH。手动指定仍优先。
- 19/19 回归通过；打包界面验收报告 `output/desktop-smoke-aldAfO/report.json`。
- 浏览器版恢复自动选择后，实际选择桌面托管 `0.163.0`，成功读取 8 个模型。没有删除任何旧版本或应用安装文件。
- 安装包 `dist/Agent-Room-Setup-0.1.5-x64.exe`；已安装版本需要更新。如曾手动指定 npm 路径，更新后点击「恢复自动选择」。

## 0.1.4 Agent 工作区

- 添加界面支持自定义已有目录和默认 `workspaces/后端/Agent名称`；默认名称兼容 Windows 非法字符、保留名称及重名。
- 18/18 回归通过，包含同一 Agent 在不同房间使用相同 cwd、不同 Agent 使用独立目录、创建与重启持久化。
- 打包桌面界面验收通过默认目录创建、自定义目录保存及原有功能；原生目录选择器模拟返回。报告：`output/desktop-smoke-VnUPRq/report.json`。
- `scripts/check-live-workspaces.cjs` 为 Codex、DSH 各创建两个真实会话，验证 cwd 相同而会话 ID 不同；没有发送模型消息。证据：`output/live-workspaces-1xexn5/report.json`。
- 旧联系人继续使用原有目录；不自动移动用户文件。当前工作区在添加时配置，不提供已有 Agent 的迁移界面。
- 安装包：`dist/Agent-Room-Setup-0.1.4-x64.exe`；没有替换用户已安装的旧版。

## 0.1.3 固定模型与会话推理强度

- 本机 Codex 返回 7 个模型，DSH 返回 5 个提供商/模型组合；DSH 报告 off/low/high/max。以上为本机测试结果，不是对所有安装的固定列表。
- `scripts/check-live-models.cjs`：两种后端分别选择实际模型，同一会话以 low、high 完成两次真实模型回复，共 4 次。DSH 校验模型与推理配置应用成功，Codex 校验会话模型。报告：`output/model-live-aDt16r/report.json`。
- 16/16 回归通过：包含模型锁定、群聊推理隔离和恢复、ACP 提供商标识不碰撞、不虚构推理选项。
- 打包桌面应用在 PATH 无系统 Node 的环境通过真实模型下拉、Codex/DSH 群内推理设置与只读模型 UI，以及原有附件/群聊/恢复验收。报告：`output/desktop-smoke-o3ApXO/report.json`。
- 新安装包 `dist/Agent-Room-Setup-0.1.3-x64.exe`，没有替换用户已安装的旧版本；本次未重跑安装/卸载流程。Qoder 模型能力未验证，单 Agent 自定义工作区尚未实现。

## 0.1.2 Electron 下的 DSH 发现修复

0.1.1 的桌面界面验收没有断言本机真实 DSH 发现成功，遗漏了 Electron 将 ASAR 虚拟化为目录的差异。普通 `fs.openSync` 在 Electron 下无法读取外部 ASAR 文件头，错误被转为“未识别聊天入口”。现改用 `original-fs` 检查外部归档及其文件头；同样修复 Codex/Qoder 桌面主程序过滤中的 ASAR 文件判断。

- `scripts/check-desktop-discovery.cjs` 使用真实 ASAR 测试样本和打包 Electron，旧版复现失败，修复版通过。
- 设置 `CHECK_REAL_DSH=1` 额外验证本机 DSH 自动发现及真实 ACP initialize；已在修复后的打包 EXE 内通过，未发送模型消息。
- 界面实际显示“DSH · 已发现入口”，路径由系统安装记录提供。截图和报告：`output/discovery-desktop-4PyJOf/`。
- 13/13 Node 回归通过。产物：`dist/Agent-Room-Setup-0.1.2-x64.exe`。未重新执行安装/卸载流程。

## 0.1.1 自动发现与手动配置

新增安装包：`dist/Agent-Room-Setup-0.1.1-x64.exe`。

- 13/13 自动回归通过，新增自定义安装目录、Codex 桌面主程序过滤与内置 CLI 识别、版本刷新、手动配置持久化和失效处理、npm 启动器参数、配置 API 验证。
- 最终打包应用在 PATH 不包含系统 Node.js 的条件下通过界面验收：后端路径校验、浏览选择结果处理、保存与恢复自动选择，以及联系人、群聊、图片和外观恢复。
- 后端程序选择弹窗采用模拟返回值；未把这项测试描述为人工操作系统选择器验收。证据：`output/desktop-smoke-6KOySM/report.json`。
- 本机发现 Codex CLI 和桌面附带后端，通过系统安装记录发现 D 盘 DSH，并用自动生成的启动配置完成真实 ACP initialize 握手；未创建模型对话。
- 本机 Qoder CN 桌面版识别为已安装、需要补充聊天入口；未验证其 ACP 回复。
- 浏览器服务已重启加载新功能，原有数据保留。此次未重复进行安装/卸载验收；下面是 0.1.0 的历史结果。安装包仍未进行发布者签名。

## 0.1.0 历史验收

产物：`dist/Agent-Room-Setup-0.1.0-x64.exe`，111,215,455 字节。SHA-256：`6f321db0987087745ad0deb981a981313ec9b1d4d78ccea80cd7cb590d438012`。

Electron 44.7.2 / electron-builder 26.15.3，Windows x64 NSIS 安装向导。运行时 ZIP 已与 Electron npm 包提供的官方 SHA-256 核对。安装包尚未进行发布者代码签名；构建日志中的 signing 步骤不表示已签名。

## 已验证

- `npm test`：5/5 通过，涵盖联系人/群聊持久化、CHAT 策略、附件及记录恢复、后端失败隔离、桌面服务访问凭证。
- 已打包 EXE 实测：窗口载入、渲染进程隔离、添加 Agent、多选建群、原生文件选择与图片预览、退出后本地服务释放、再次启动恢复联系人/群聊/主题。
- 安装器实际静默安装到 `output/安装验收 Agent Room`，退出码 0。
- 实际安装后的 EXE 在子进程 PATH 不含系统 Node.js 的条件下再次通过相同桌面验收。
- 测试副本通过自身卸载器卸载，退出码 0，安装的 EXE 已不存在；隔离的测试聊天数据仍保留。
- 检查 `app.asar`：不包含用户数据、测试样本或构建依赖。

证据：`output/desktop-smoke-EMOFNY/report.json`（打包后）、`output/desktop-smoke-XRJB6h/report.json`（安装后）。同目录保存界面截图。

## 验收边界

未调用真实模型，未重复宣称 Codex / DSH / Qoder 真实回复通过。后端仍依赖用户本机的安装、登录或显式启动配置。未验证不同 Windows 版本/架构、自动升级或发布者签名。

构建依赖审计报告 7 项 moderate，来自 electron-builder 的下载/日志工具间接依赖；未执行破坏性的自动降级修复。它们不包含在已核对的运行安装包中。

桌面运行数据默认为 `%APPDATA%\Agent Room\data`，不写入安装目录。测试使用单独的 `AGENT_ROOM_DESKTOP_HOME`，未改动浏览器版已有数据。

2026-10-16 新界面验证：output/desktop-smoke-4mkvqt/report.json，12 项通过。新增右键置顶/取消置顶、Escape 关闭、重启持久化、直接编辑工作区并保留旧文件；既有模型读取、推理设置及删除确认也通过。npm test 28/28。已重新生成 0.1.8 安装包，未覆盖用户安装。

2026-10-16：29/29 回归通过；最终安装包对应的桌面程序通过 scripts/check-composer-ui.cjs，报告 output/composer-ui-3RNEFD/report.json。验证独立滚动、@ 输入候选筛选/键鼠选择/取消、Agent 与群聊重命名及名称更新。使用隔离的 30 联系人和 80 条模拟历史，不代表真实模型调用测试。

2026-10-16 数据目录：32/32 回归通过，包含手动迁移后的附件路径。打包桌面检查 output/data-location-ui-1Q2MWm/report.json：配置待切换、未复制回退、完整复制后启动切换及原目录保留通过。测试使用隔离目录，未迁移用户实际数据。

0.1.9：33/33 回归通过；最终优化打包核心桌面检查 output/desktop-smoke-CWhsSh/report.json 12 项通过。@所有人 双入口检查 output/composer-ui-uu7WUT/report.json。渲染合成基准及包体对照见 HANDOFF 0.1.9 节，不能解释为模型加速。

## 2026-10-20：群聊公开与匿名投票（源码验收）

- 最终 `npm test`：115/115 通过，0 跳过，记录 `output/polls-regression-final.log`。覆盖去重与改票、权限隔离、匿名读取和导出、持久化恢复、截止、成员退出、忙碌等待、重试上限和停止后的暂停。
- Electron 实际以 Node 模式从隔离 `app.asar` 启动 MCP 桥接，握手及工具调用通过；这项检查没有构建或覆盖安装器。
- 真实 MCP 闭环：Codex + DSH（`output/polls-live-impMex/report.json`）、DSH + Qoder（`output/polls-live-rVwBnd/report.json`）、DSH + WorkBuddy AI（`output/polls-live-r2Mpbg/report.json`），均完成创建、独立投票和全员自动结算。WorkBuddy 使用实际权限元数据中的工具名，只放行绑定的七个 Room 工具。
- 浏览器真实操作验证：匿名进行中隐藏票数和归属、公开详情、创建、提前结束、取消、切群保留草稿和刷新恢复。截图 `output/playwright/polls-public-anonymous.png`、`output/playwright/polls-final.png`。
- Claude 的桥接配置与工具权限通过自动化验证；本轮未验证其真实模型投票。WorkBuddy 国内版也未单独实测。匿名保证范围见 README。
- 使用隔离测试数据和新后端会话；没有迁移用户聊天数据，没有发布或覆盖已安装的桌面程序。

## 2026-10-20：0.1.30 构建交付

- 发布版本回归 `output/release-0.1.30-elxHfk/tests.log`：115/115 通过。
- 完整安装包 `dist/Agent-Room-Setup-0.1.30-x64.exe`；增量包 `dist/Agent-Room-Update-0.1.29-to-0.1.30-x64.zip`；校验清单 `dist/SHA256SUMS-0.1.30.txt`。
- 最终打包程序启动、版本和源文件匹配：`output/packaged-chat-fix-oXjEVV/report.json`。登记生命周期隔离检查：`output/registration-lifecycle-roPGOW`，退出暂停、重开恢复、无脱离主程序的登记 worker。
- ASAR 检查与实际增量应用：`output/release-0.1.30-elxHfk/artifact-audit.json`。47 个打包源文件与工作树一致；投票桥接在包内；私有数据和测试输出不在包内。升级副本的 3 个目标文件校验正确，测试数据与工作区保持完整。
- 本轮没有执行 NSIS 安装/卸载，没有更新用户已安装程序。构建与隔离验收成功不代表用户已经升级。

## 界面美化源码验收 · 2026-10-22

- 桌面/浏览器共用的 `standalone/public/` 已更新列表、欢迎页、聊天、输入卡片、弹窗、主题预览和投票样式；旧 DSH 插件界面未改动。
- 基础回归 115/115：`output/ui-polish-tests-live.log`。
- 真实 Chrome + 隔离 HTTP/SSE：`output/playwright/appearance-6O2lLX/report.json`。五主题及自定义 RGB/HSL/短 hex 重载，私聊标记与匿名投票，历史与空会话，工具菜单/提及/草稿，1440/1000/720/390px 布局通过。浏览器异常和模型调用均为零。截图同目录。
- 源码 Electron 原有输入栏回归：`output/composer-ui-XWiUOp/report.json`，覆盖菜单、闹钟、提及、草稿、重命名和长列表/长历史独立滚动。
- 初次在受限环境运行的浏览器与基础回归遇到本机访问限制；放行隔离测试后通过。源码 Electron 启动同样在放行后通过。
- 此轮未重新打包或安装，没有真实模型验收；用户已安装程序与现有 dist 安装包尚不包含此次界面更新。

## 0.1.31 最终交付与真实安装更新 · 2026-10-22

- 基础回归：`output/tests-0.1.31.log`，115/115。
- 多 harness 界面与响应式验收：`output/playwright/appearance-JZPIhv/report.json`；README 演示图来自该目录，无真实模型调用或个人聊天。
- 最终安装包启动 `output/packaged-chat-fix-ybdC4W/report.json`；输入栏/滚动/重命名 `output/composer-ui-dKO84H/report.json`；退出重启登记 `output/registration-lifecycle-oDBFH9/report.json`。
- ASAR 审计 `output/release-0.1.31/artifact-audit.json`：48 文件匹配源码，不含用户数据/工作区/测试输出。隔离实际增量升级 `isolated-update.json`：3 文件 SHA-256 与数据保留通过。
- 已将真实 `D:/Agent Room` 从 0.1.28 更新至 0.1.31，并重新启动。`installed-update.json` 证明替换后首次启动前全部保护文件与目录不变，首次启动后已有聊天日志与工作区仍匹配；`installed-startup.json` 证明正式数据路径及 4 位 Agent、5 个会话可读，没有发送聊天。
- 程序备份 `D:/Agent Room/.update-backup-0.1.28-a1d9a15d7f824b8aa24f68d55b070974`；完整数据/工作区备份 `output/release-0.1.31/user-backup/`。没有卸载、安装器流程或真实模型验收。
- 完整安装包、0.1.28→0.1.31 增量与 SHA-256 位于 dist；仅源码、文档和演示图进入 GitHub，不创建 Release。

## 路线图与社区贡献文档检查 · 2026-10-23

本轮仅新增计划、贡献与接入说明、相似项目调研、Issue/PR 模板，运行代码/依赖/版本未变。`output/roadmap-2026-10-23/validation.json`：相对文件链接、Markdown 代码围栏、两份 Issue 表单及 config YAML/字段结构、16 项候选数量和 0.1.31 版本检查通过。调研基于上游官方文档和 GitHub 元数据，不是竞品或候选 harness 的运行验收。没有模型请求、打包、安装更新或权限变更；运行时测试未重复运行。

## 0.1.32 Agent 共享记忆与工作区隔离 · 2026-10-23

- `output/tests-0.1.32.log`：126/126，含 Agent ID 记忆归属、单聊/跨群召回、旧历史回填去重、并发/截断/故障恢复、重启/改名/换目录保留记忆与工作文件、同 harness 的目录冲突和链接别名、显式私聊及匿名投票不泄露。全部推理为模拟，不消费真实模型额度。
- `output/playwright/appearance-12JtSm/report.json`：真实 Chrome + 隔离 HTTP/SSE，五主题及原有界面回归、记忆来源/搜索/私聊过滤与 390px 展示通过；模型调用、浏览器异常为零。`agent-memory.png`、`agent-memory-mobile.png` 为新入口截图。
- `output/packaged-memory-61S46z/report.json`：最终 0.1.32 EXE/ASAR 启动与重启，通过旧聊天记忆回填、跨来源查看、不同 Agent 隔离、去重和原日志/工作区文件哈希保留；没有发送生成请求。
- `output/claude-packaged-6m9tcA/report.json`：ASAR 桥接在有/无系统 Node 环境均通过，使用本地 Claude 协议 fixture，无真实账号/模型访问。
- `output/release-0.1.32/artifact-audit.json`：最终 ASAR 的 48 个源文件与工作树匹配，无运行时私有数据；基线 0.1.31 增量在隔离副本实际重建 3 个目标文件，哈希及模拟数据/工作文件保留验证通过。

完整安装包、0.1.31→0.1.32 增量和 SHA-256 位于 dist。未更新真实安装或推送 GitHub，未运行 NSIS 安装/卸载。记忆是本地历史检索与有界片段传递，未做真实模型召回质量验收；普通模型回复仍按实际输入（含记忆片段）计费。旧共享工作区保留并阻止生成，自动复制迁移和全局原生记忆隔离不在本轮完成范围。

## 0.1.33 Codex / DSH Agent 多会话 · 2026-10-24

- `output/tests-0.1.33.log`：128/128，通过新建空会话、独立历史/原生标识、工作区与记忆复用、推理隔离、重命名与置顶语义、未知 harness/名称拒绝、导航状态跨服务端口恢复。所有生成均为模拟后端。
- `output/playwright/agent-sessions-pJnNFn/report.json`：Chrome + 实际本地 HTTP/SSE；展开/新建/切换、草稿和附件归属、标题/置顶、搜索、真实接口保存模拟目录中的推理值、通用界面回退、1440/1000/720/390px 和深浅主题通过。
- `output/playwright/appearance-2qGwmR/report.json`：原有五主题、匿名投票边界、历史、提及、记忆查看与响应式检查通过。
- `output/playwright/agent-sessions-bhzRBA/report.json`：最终 0.1.33 打包程序，验证新会话、选择状态与展开列表在退出重启后恢复，原日志与工作文件哈希不变；打包模式没有启动模型查询或发送生成请求。
- `output/composer-ui-qUJ8Gv/report.json`：最终 EXE 工具栏、键盘、提及、重命名、长列表/历史独立滚动通过。
- `output/packaged-memory-QZcIY7/report.json`：最终版本记忆回填、去重、身份、工作区分配与数据保留通过。
- `output/release-0.1.33/artifact-audit.json`：48 个源码文件匹配，包内无用户聊天/工作区；0.1.31→0.1.33、0.1.32→0.1.33 增量均在隔离副本实际重建 3 个程序文件并保留模拟数据，SHA-256 通过。

桌面随机端口下 localStorage 丢失选中状态的问题已复现并修复为数据目录 `ui-state.json` 持久化；同一窗口内的草稿/附件保留与跨重启导航恢复是不同保证。第一版仅路由 Codex / DSH 单聊布局，不导入原生桌面外部会话，不改变固定模型或现有执行权限。未替换真实安装、未验证真实模型回复或原生 session resume、未推送/发布 GitHub。安装包、两份增量及校验清单位于 dist。

## 0.1.34 agentschat 微信风格界面 · 2026-10-24

- `output/tests-0.1.34.log`：130/130，新增品牌与 DSH loader 一致性、旧/新卸载程序文件名升级保护；无真实模型调用。
- `output/playwright/appearance-sjiTbl/report.json`：三栏布局、导航过滤、五主题、匿名投票/历史/提及/记忆、1440/1000/720/390px 通过。README 截图来自该目录的 `chat-light.png`，是隔离演示数据。
- `output/playwright/agent-sessions-iMz70i/report.json`：新版 Codex / DSH 布局的多会话、草稿附件、模拟推理设置及深浅/窄屏通过。
- `output/playwright/agent-sessions-g2u3db/report.json`：最终 EXE，agentschat 应用/菜单/页面名、既有数据位置、退出重启与会话状态恢复通过，旧文件 SHA-256 不变，无生成请求。
- `output/composer-ui-dmQkE5/report.json`：打包输入栏/键盘/提及/重命名/独立滚动通过；最终只恢复包的内部身份，UI 源码与该检查一致。
- `output/packaged-memory-tocik5/report.json`：最终 EXE 的共享记忆、旧历史回填、去重和数据保留通过。
- `output/release-0.1.34/artifact-audit.json`：49 个文件与 ASAR 一致，productName/内部包名/版本/入口核对通过；从准确 0.1.31、0.1.32、0.1.33 各生成增量并实际应用到隔离副本，程序哈希和模拟数据保留通过。

产品显示名与安装包使用 agentschat；内部 npm/DSH 注册标识、appId、程序文件名和数据定位保持兼容。精确增量沿用旧快捷方式，完整新安装使用 agentschat 快捷方式；未执行真实安装升级或 NSIS 安装/卸载。保留旧插件标识的合同检查不代表本轮真实加载旧 DSH 插件。未发布或重命名远端仓库。

## 真实安装更新与仓库改名 · 2026-10-24

- GitHub 仓库为 [mocias/agentschat](https://github.com/mocias/agentschat)，改名前后仓库 ID 1421773944 一致；main 与原历史保留，本地发布 remote 和文档链接已同步，原上游 origin 不变。
- `output/local-update-0.1.34-7ngkR1/prepare.json`：准确 0.1.31 基线和已验证增量匹配，34 个现存数据/工作区文件备份通过；记录一个升级前就缺失的 DSH 工作区，未重建。
- `installed-update.json`：真实安装更新到 0.1.34，3 个程序文件 SHA-256 匹配；启动前其余受保护数据内容不变，DSH 桥接动态回执只有 checkedAt 刷新。程序备份位于安装目录 `.update-backup-0.1.31-3365512644234e9bbdc5ee62e4dad4be`。
- `installed-startup.json`：真实程序启动后页面/应用/菜单均显示 agentschat，数据路径保持 `D:/agent room data`，4 位 Agent、5 个会话及身份/模型/目录保留，Codex 多会话入口可读。退出后原日志、附件和现存工作区文件哈希不变；生成/模型目录请求均为 0，浏览器异常为 0。
- `shortcuts.json`：桌面、开始菜单快捷方式已备份并改名 agentschat，仍指向同一程序；检查完成后重新启动，窗口标题已核对。

本轮未改运行代码，沿用此前 130 项回归；真实启动不等于真实模型回复验证，缺失的 DSH 工作区仍需用户后续指定。未执行 NSIS 安装/卸载，未创建 GitHub Release；个人备份与测试证据只保存在本地 output。

## 0.1.35 原生会话控件与选中态修复 · 2026-10-24

- `output/tests-0.1.35.log`：133/133。新增会话配置持久化与隔离、首条消息后的预设锁定、忙碌期间拒绝修改、完整访问确认、后端参数和跨房间权限确认测试。无效停止请求不能清除其他房间的确认；回复结束、停止、释放和超时取消未决确认。
- `output/playwright/agent-sessions-0v72AE/report.json`：源码 UI，真实 HTTP/SSE 加模拟能力目录；权限/预设/推理下拉、允许/拒绝卡片、Codex 规划模式、取消完整访问与悬停背景回归通过。
- `output/playwright/appearance-TiQSCH/report.json`：五主题、匿名投票、历史、提及、记忆及 1440/1000/720/390px 通过。
- `output/playwright/agent-sessions-sZz3Vu/report.json`：最终 EXE 读取真实 DSH/Codex 能力目录，实际选择和保存、退出重启恢复、展开历史/新建会话、深浅主题及四种宽度通过；0 模型请求、0 浏览器异常。README 的两张控件截图来自此隔离演示数据。
- `output/native-session-controls-cRsACK/report.json`：最终 ASAR 使用本机 Codex 0.163.0 和安装的 DSH 创建空会话；三个权限档位均通过。DSH 标准/程序化工具/精简预设实际应用结果与请求一致，预设应用后重新锁定所选模型成功；Codex 验证实际 sandbox 配置。脚本禁止 `turn/start` 和 `session/prompt`，生成请求为 0。Codex 协作模式的发送结构由协议测试覆盖，没有进行真实规划回复或工具执行验收。
- `output/composer-ui-ScXyiq/report.json`、`output/packaged-memory-hzzUoY/report.json`：0.1.35 打包输入栏/键盘/提及/重命名/滚动和记忆数据保留通过；这些 UI/记忆代码在后续权限确认生命周期收尾中未再改变。
- `output/release-0.1.35/artifact-audit.json`：最终 ASAR 与 53 个源码文件一致，无用户数据；准确 0.1.34→0.1.35 增量在隔离副本上应用，程序哈希与模拟聊天/工作区保留通过。安装包 102764349 字节，增量包 362199 字节；完整 SHA-256 见 `dist/SHA256SUMS-0.1.35.txt`。

DSH 仅使用当前安装自带预设，依赖缺失的 cordis 显示不可用；未导入桌面自定义预设。新会话默认只读，旧会话不自动改变配置。DSH 临时桥接只作用于本应用子进程，不修改用户 DSH profile。UI 允许/拒绝和协议回归不等于真实模型触发工具的端到端验证。

本机安装 `D:/Agent Room` 已更新到最终 0.1.35。初次更新证据为 `output/local-update-0.1.35-f2smOO/`；权限确认收尾后，以当次已安装文件的精确哈希生成内部修订增量（基线标签 `0.1.35-interim`），再校验并更新两个程序文件。最终证据为 `output/local-update-0.1.35-final-fZzto4/prepare.json`、`installed-update.json`、`installed-startup.json`，39 个受保护文件备份保留，4 位 Agent、6 个会话及历史/附件/现存工作区保持一致。DSH 动态回执仅允许 checkedAt 刷新。最终真实启动页面/菜单均为 agentschat，生成和模型目录请求为 0。

升级前缺失的 `D:/Agent Room/agents/dsh/dsh-1` 仍未重建；需要在 Agent 设置中选择有效工作区后才能读取原生选项或发起会话。程序备份保留在安装目录 `.update-backup-0.1.34-6edbf2934ade4aca8e4b26809b1141fe` 和 `.update-backup-0.1.35-interim-42d99de39573460296ed44c969b0da78`。未执行 NSIS 安装/卸载，也未提交、推送本轮 0.1.35 源码或创建 GitHub Release。


## 2026-10-28：0.1.36 Qoder 多会话与 ZCode 桌面账号

验证对象：Qoder CN 0.4.11（内置 CLI 1.1.75-hotfix.1）与 ZCode Windows 3.16.3（CLI 0.17.0）。实现与复现入口见 docs/ZCODE_QODER_INTEGRATION.md。

Qoder/ZCode 纳入多会话与输入区：新建、命名、置顶、草稿/附件隔离、模型固定和推理设置。Qoder 使用真实 ACP 模式目录并验证回显，默认 default，yolo 需确认。ZCode 通过本应用拥有的无窗口 Electron helper 加载安装自带 Host/RPC，由原生服务读取桌面账号、模型资格与请求授权；不复制凭据，不修改安装包。Windows 3.16.3 被明确版本门控，首版只开放可核验的 build 模式。混合房间按 session 绑定各 Agent 工作区。修复停止 ACK 迟到结束下一轮的问题，并为 inputId/turnId 隔离增加回归。

当前结果：140/140 回归；Qoder/ZCode 真实混合群各自返回 MIXED_ROOM_OK，session ID 独立；ZCode Start Plan GLM-5.3-Flash 真实流式回复通过。GLM-5.3 本轮曾返回 429 / 3009 并发限制，程序不自动换模型。真实 ZCode 宿主配合本地模拟模型，验证两会话、逐次拒绝/允许写入、停止及同会话续聊；这些本地模型检查与真实云回复分别记录。

最终打包 EXE 的四种后端、四种宽度、深浅主题、重启恢复检查通过；ASAR 59 个文件与源码一致，原生 Qoder/ZCode 模型和权限目录读取通过，未请求生成。0.1.35→0.1.36 增量在隔离安装副本实跑，3 个程序文件校验一致，测试聊天和工作区保留。产物：dist/agentschat-Setup-0.1.36-x64.exe、dist/agentschat-Update-0.1.35-to-0.1.36-x64.zip、dist/SHA256SUMS-0.1.36.txt。

证据：output/new-backends-final-tests.log；output/live-new-harnesses-room-9lW4M5/report.json；output/zcode-live-bjPG2m/report.json（仅单个真实生成会话）；output/native-new-harnesses-dl79Vy/report.json（拒绝）；output/native-new-harnesses-CUATJA/report.json（允许、停止及续聊）；output/playwright/appearance-6i8Rgt/report.json；output/playwright/agent-sessions-4AVbZG/report.json（源码）；output/playwright/agent-sessions-ZKbYKi/report.json（最终 EXE）；output/packaged-new-harnesses-KJ885q/report.json；output/release-0.1.36/incremental-validation.json。

本机 D:/Agent Room 的实际 ASAR 仍为 0.1.35，没有覆盖当前安装；本轮未提交、推送或发布 GitHub。旧 0.1.35 未提交改动保留。尚未专项验收 ZCode 其他版本/平台、规划开关、电脑操作、MCP 投票、原生桌面历史展示，以及安装器覆盖用户实际安装。不要把协议/目录或本地模拟模型验收扩大为这些能力已支持。


## 2026-10-28：0.1.36 本机更新与 GitHub 源码交付

实际安装 D:/Agent Room 已从准确 0.1.35 基线应用已验收增量，Agent Room.exe、resources/app.asar、原注册名 Uninstall Agent Room.exe 三个程序文件均与最终 0.1.36 产物校验一致。更新前备份 43 个现存数据、工作区及桌面配置文件，152368 字节；原已缺失的 dsh-1 目录不重建。程序回滚备份保留在 D:/Agent Room/.update-backup-0.1.35-ff7d64c05fda4121b23a77b37f878284，数据备份与报告位于 output/local-update-0.1.36-ck3NXZ/。

真实安装启动确认名称/菜单/版本为 agentschat 0.1.36，数据仍为 D:/agent room data；4 位 Agent、6 个会话的身份、模型、工作区、标题和权限配置保持一致。Qoder/ZCode 后端均被发现。未发送聊天或模型请求，浏览器错误为零，现存聊天/附件/工作区内容保留。41 个受保护文件哈希不变；另外两项是正常原生登记状态变化：DSH 回执 checkedAt 刷新，以及 WorkBuddy 登记队列更新，不能把这些运行状态描述为逐字节不变。验证后已重新打开应用。

源码交付目标为 agentschat/main。提交包含此前本地 0.1.35 原生会话配置及 0.1.36 Qoder/ZCode 接入、测试、隔离演示图和文档；不包含用户数据、备份、测试输出、安装包、凭据或第三方运行时。140 项回归、最终包源码一致性、原生目录、真实混合群及增量检查沿用前一节对应证据；本次没有修改运行代码。完整 NSIS 安装/卸载未重跑，不创建 GitHub Release。前文“本机仍为 0.1.35 / 尚未推送”保留为实现阶段记录，当前安装和交付事实以本节与远端 main 为准。

本次证据：output/local-update-0.1.36-ck3NXZ/prepare.json、installed-update.json、installed-startup.json、dynamic-receipt.json、reopened.json。
