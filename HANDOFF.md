# agentschat — Handoff

交接更新：2026-10-28。当前源码和本机安装均为 0.1.36；最新 ZCode/Qoder 接入见文末及 docs/ZCODE_QODER_INTEGRATION.md。GitHub 仓库已改名 agentschat，界面采用微信风格三栏布局，验收和产物见文末最新节。0.1.33 的 Codex / DSH 多会话和独立输入布局继续保留。0.1.32 的 Agent 共享记忆和工作区隔离继续保留。本机已从 0.1.34 更新至 0.1.35，实际启动检查通过，原聊天和现存工作区保留；升级前已有一个 DSH 工作区缺失，未自动重建。发布目标为 `agentschat/main`（https://github.com/mocias/agentschat），不是 `origin/master`。优先阅读文末最新节及 AGENTS.md；前文各版本是历史记录，不能作为当前状态。产品显示名改为 agentschat；保留内部 npm 包名 dsh-agent-room、原 MIT LICENSE、旧安装/数据标识和插件入口兼容。本文区分已实现、已验证和未完成事项。

0.1.8 更新：默认工作区改为桌面安装目录/agents/backend/Agent名称；浏览器默认源码根/agents，支持 AGENT_ROOM_WORKSPACE_ROOT；旧路径不迁移。添加删除操作，默认保留文件，删除文件需完整路径确认，禁止共用/嵌套工作区、磁盘根、应用数据祖先、符号链接/联接。删除联系人移除单聊入口与群成员，保留群聊记录、底层日志和原后端记录。安装包构建不等于用户已安装版本更新。

同步未完成：standalone/desktop-sync.cjs 使用新版 project/create + thread/start.projectId，为每个 Agent 创建稳定项目，不采用原来的项目轮换删除。真实两次 SYNC_OK 已验证后端持久化关联，但 Codex 桌面 list_projects 没有显示新项目；本机桌面还维护 local-projects 缓存，不能宣称 GUI 可见。DSH workspaceRegistry 在桌面宿主；Qoder 的 chat_sessions / sidebar / messages 与 ACP 存储分离，目前返回 unsupported。不要绕过接口直接覆盖运行中应用的状态文件或数据库。下一步必须接通各宿主的受支持注册/导入接口并做 GUI 验收。

提示词精确结构见 docs/PROMPTS.md。创建 Agent/群聊无生成请求，首次消息才打开会话。新增 checks/desktop-sync.test.cjs、删除目录检查；真实脚本 scripts/check-native-codex.cjs 只证明后端关联，不证明桌面可见。

0.1.8 初始阶段验证：26/26 回归；打包 smoke `output/desktop-smoke-exb3Jx/report.json`；默认 EXE 同级 agents 根 `output/default-root-tDy4F6/report.json`；NSIS 保留宏隔离执行 `output/installer-preserve-lRIIFE/report.json`；DSH/Qoder 角色指令真实回复 `output/persona-live-J3wtcF/report.json`。宏位于 desktop/preserve-agents.nsh，升级/卸载保留 agents，不能退回默认递归删除安装目录。详细证据边界见 DESKTOP_VALIDATION.md。

0.1.10 WorkBuddy：通过已登录桌面的 supervisor 创建本机 ACP HTTP 运行时，复用桌面登录，每位群成员使用独立运行时。**当前只实测过 WorkBuddy AI 国际版 5.8.4；WorkBuddy 国内版没有实测。** 国内版仅有后端注册、安装识别和离线测试，不能据此宣称真实接入成功。完整实现流程、复现命令、证据及限制见文末“0.1.10 WorkBuddy 接入流程与实测边界”。

## 1. 产品目标与接手任务

独立多 Agent 聊天应用，微信式左侧联系人/群聊、右侧对话。原有后端为 Codex、DSH、Qoder，0.1.10 新增 WorkBuddy 接入（国际版已实测，国内版未实测）；同一类可以添加多位联系人。搜索旁 + 添加 Agent；多选联系人建群。第一版仅 CHAT、附件和外观设置。

后续用户要交给 DSH，把 Qoder 桌面后端和工作区能力移植回原插件。独立应用已接入，原插件未完整移植。Qoder 接入与工作区移植指南由用户另行提供，作为本地独立文档保存，不纳入本仓库；不要将其中待办描述为已实现。

## 2. 架构地图

| 文件 | 职责 |
| --- | --- |
| standalone/server.cjs | 通讯录/群聊持久化、HTTP、扫描许可、模型和推理接口、房间生命周期 |
| standalone/public/ | 独立前端，无构建步骤 |
| standalone/discovery.cjs | 自动发现、手动配置、候选优先级、ASAR 识别、启动参数 |
| standalone/windows-harnesses.ps1 | 只读 Windows 安装记录、进程、应用包和快捷方式发现 |
| standalone/models.cjs | Codex model/list、DSH/Qoder ACP configOptions 查询 |
| standalone/workspaces.cjs | 路径校验、默认目录创建、名称冲突处理 |
| standalone/qoder-worker.cjs | Qoder 内置 Worker 到 ACP 标准输入输出的桥接 |
| standalone/workbuddy.cjs | WorkBuddy 版本识别、安装包校验和桌面运行时启动配置 |
| desktop/main.cjs | Electron 窗口、原生选择器、每次启动本地服务访问凭证 |
| desktop/builder.cjs | Windows x64 NSIS 构建 |
| lib/room.cjs | 群聊调度、分段投递、CHAT 策略、会话与历史 |
| lib/codex-pool.cjs | Codex app-server 协议、模型和推理能力 |
| lib/acp-backend.cjs | ACP 启动、会话、流式回复、取消、配置 |
| lib/workbuddy-pool.cjs | 复用当前用户 WorkBuddy 桌面登录、独立运行时和 ACP HTTP 传输 |
| lib/index.js、public/ | 原 DSH 插件入口/UI，非 standalone |
| checks/、scripts/ | 自动回归和真实/桌面验收工具 |

## 3. 当前数据模型与行为

Agent 字段：id、label、backend、model、modelLocked、modelName、effort、workspace、persona、aliases、createdAt。新 Agent 从真实列表选模型并固定；旧联系人保留兼容行为。

Conversation 字段：id、kind、title、agentIds、updatedAt、preview，可含 efforts[agentId]。推理覆盖只作用于当前会话；群内不提供模型修改。后端模型不可用或拒绝应用时应报错，不静默切换。Qoder auto 是策略，不是固定具体模型。

workspace 自定义目录须存在；留空创建 agents/backend/Agent名称。非法字符/保留名/冲突由工具函数处理。新房间创建独立后端会话，但同一 Agent 使用同一 cwd。旧 Agent 保存原路径，不搬文件。

Codex 自动选择优先运行中的桌面托管后端，其次其他桌面入口，最后 npm/PATH；手动指定优先。DSH 通过自身 EXE + ASAR CLI + acp profile 启动，并使用已有账户路由补丁。Qoder 使用已安装产品附带的 Worker，不重新分发运行时。

## 4. 扫描许可与安全边界

首次启动或升级旧数据时，discovery-consent.json 不存在就先弹窗。automatic 表示允许后续自动发现，manual 表示只检查用户明确指定文件。后台限制不能只靠 UI；目录输入在手动模式拒绝。

读取范围包括安装记录、进程可执行路径、快捷方式、PATH、相关安装目录，不读取聊天或认证内容。允许扫描不等于允许删除旧安装。

桌面本地服务使用随机端口和每次启动的访问凭证，渲染器 sandbox/contextIsolation 开启，无 Node 集成。普通浏览器模式是 loopback 服务；两种数据目录分开。

cwd 不是权限沙箱；Codex 有只读策略，ACP 实际权限取决于后端。不得统一宣称完全禁止写文件或访问目录外文件。

## 5. 运行、构建和数据目录

```sh
npm start
npm ci
npm test
npm run desktop
npm run desktop:dist
```

浏览器默认 127.0.0.1:4318，数据 .agent-room-data/；AGENT_ROOM_DATA 可覆盖。桌面默认 %APPDATA%/Agent Room/data，AGENT_ROOM_DESKTOP_HOME 可隔离测试用户目录。聊天数据不放安装目录。

主要持久化文件：catalog.json、backend-preferences.json、discovery-consent.json、rooms/*.log.jsonl。旧 backends.json 仍兼容。附件/主题由 RoomApi 原有模块维护。

固定构建依赖：Electron 44.7.2、electron-builder 26.15.3。构建使用 node_modules/electron/dist，首次安装依赖需要下载 Electron。代理使用目标环境自己的配置，不照抄原机器端口。

源码不包含 node_modules、dist、output、用户数据、凭据、第三方运行时。安装包未签名，无自动更新；构建新包不等于升级用户已安装版本。

## 6. 验证证据与复现

详见 [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md)。里面 output/ 路径为本机历史报告，不随源码上传；新环境应重新生成，不能要求仓库中一定有这些报告。

- 当前离线/本地接口回归 50/50 通过：扫描许可、持久化、目录规则、模型锁定、推理隔离、附件和群聊。
- Codex/DSH 真实模型选择，low/high 各一轮回复通过；各创建两个同 cwd、不同 session ID 的会话通过。
- Qoder CN 0.4.8 内置 Worker 的 initialize、新会话、真实回复通过；打包 Electron 也完成真实回复。官方登录已在原机器完成，不代表新机器无需登录。
- 当前本机 Qoder 返回 15 个模型，无 thought_level。数量和模型随账户/版本变化。
- 0.1.7 打包 smoke 通过首次拒绝→允许扫描、三种后端添加、群聊、工作区、附件、主题和重启恢复。选择器返回值是模拟，不算人工原生选择器验收。
- 0.1.0 曾实际安装/卸载；之后主要验证打包 EXE，未逐版重复安装器全流程。

```sh
node scripts/check-live-models.cjs
node scripts/check-live-workspaces.cjs
node scripts/check-live-qoder.cjs
node scripts/check-desktop-qoder.cjs
npm run desktop:smoke
```

真实脚本要求安装及登录；部分会发送模型请求并消耗额度，部分仅创建会话。使用隔离目录。check-desktop-discovery.cjs 可用 CHECK_REAL_DSH=1 验证 DSH 初始化。开发脚本直接调用发现器，不代表产品 UI 能绕过许可。

## 7. 重要已知限制

1. 原插件的发现/UI/roster 序列化/宿主归档尚未完整接入；详细修改点见用户另行提供的本地移植指南。
2. 本地历史恢复不等于原生 session ID 恢复。runtime 闲置释放或进程重启后可能新建后端会话并重放历史。跨重启 session resume 仍需专门实现与测试。
3. ACP 附件主要传本地路径。即使 Qoder 宣告图片能力，也未接原生 ACP 图片块；Codex 使用原生图片输入。
4. 暂无 Agent 编辑、单独增删群成员、已有 workspace 迁移、跨设备同步、WORK UI、代码签名和自动升级。0.1.8 已添加全局删除 Agent。
5. 发现入口不等于账号/网络可用。模型查询会启动后端，ACP 可能创建能力查询会话。
6. Qoder 内部布局随升级可能变化。本次实测 CN 0.4.8，不能泛称所有版本都支持；国际版识别只是候选逻辑。
7. 模型查询目前使用后端默认工作目录，没有按 Agent 自定义 workspace 枚举项目级提供商配置；未来应把 cwd 纳入查询及缓存键。
8. BackendDiscovery 默认 allowAuto=true；应用层显式关闭直到授权。插件侧不得遗漏这个开关，也需审计旧注册表自动发现路径。
9. 旧历史文档的分支、测试数量、已实现范围仅代表上游当时状态。新 README/HANDOFF 与最新验收记录优先。
10. 扫描关闭时，尚未配置后端的旧会话浏览可能被 runtime 校验阻止。后续可解耦历史查看和后端初始化；必须保证不会因此触发未授权发现。

## 8. 建议接手顺序

先跑回归，结合用户另行提供的本地移植指南，从一个 Qoder Agent + 一个工作区做插件纵向闭环，再扩展群聊和 UI。每一步记录发现→initialize→session/new→prompt，不能把握手成功当完整聊天成功。

优先补插件字段持久化和 createSessionFiler 的 cwd 优先级，再验证独立会话及更新兼容。避免复制 standalone DOM ID、默认数据目录等宿主专属假设。

新私有远程名 agents-chatroom；origin 保持上游 mocias/dsh-agent-room。后续推送前检查 git remote -v，避免误推上游。本次保留原 Git 历史及 MIT 归属。

## 9. Suggested skills

- diagnose：先复现协议/进程/Electron 差异，再修复。
- playwright / computer-use：界面与真实打包程序验收，注明模拟步骤。
- handoff：持续记录已实现、已测试、待验证，不把历史测试冒充当前结果。

用户习惯：完成授权范围内的实际工作；不要把构建宣称为已安装版本升级；未经明确要求不要删除后端旧版本或移动工作区。

## 2026-10-16 界面与点名修复

- 单聊成员按钮直接打开 Agent 设置，可改工作区及当前会话推理强度；群聊先选择成员。固定模型只读。
- 工作区修改作用于该 Agent 所有会话；等待相关回复结束，释放旧运行会话并保留历史与原文件，不自动迁移文件。
- 左侧 Agent 右键菜单提供置顶/取消置顶与删除；置顶持久化，删除继续使用工作区保留/删除确认。
- 身份指令、发言人标签、每轮成员名册改用显示名；点名匹配支持小数点、空格、中文，旧内部 ID 仍兼容解析。历史正文不改写。
- 回归 28/28 通过；打包桌面实测 12 项通过，证据 output/desktop-smoke-4mkvqt/report.json。原桌面同步仍未完成。

## 2026-10-16 滚动、输入提及和重命名

- 页面锁定为窗口高度，消息区和联系人列表分别滚动；头部、输入框、左侧底部操作固定。
- 输入 @ 弹出当前会话成员，按显示名筛选，支持方向键、Enter/Tab、鼠标选择与 Escape；候选存在时 Enter 不发送。
- Agent 和群聊右键菜单增加重命名。Agent 重名被拒绝；名称更新到单聊及提及候选，工作区路径保持原值。历史正文不改写；Agent 改名等待相关回复结束并释放旧运行会话，下次回复使用新身份。
- npm test 29/29；最终打包程序交互检查 output/composer-ui-3RNEFD/report.json 通过（长列表/历史采用隔离测试数据，不调用模型）。
- 桌面数据：%APPDATA%/Agent Room/data/catalog.json 保存联系人和会话索引，rooms/*.log.jsonl 保存历史，agent-room-files 保存已上传附件（使用后创建）。卸载默认保留用户数据及安装目录 agents；浏览器数据独立在源码 .agent-room-data（可由环境变量覆盖）。

## 2026-10-16 用户自定义数据目录

用户明确选择手动迁移。后端管理新增数据目录入口，保存 pending，下次启动校验手动复制结果后激活；不复制或删除源数据。可取消 pending，失败继续使用旧目录。桌面定位文件保存在 userData/data-location.json（位于 data 外）；浏览器在源码根 .agent-room-location.json（gitignored）。有已保存选择时优先该设置，AGENT_ROOM_DATA 作为浏览器初始默认值。

启动时核对源目录普通文件哈希与目标副本，缺失/不同拒绝切换。源目录已不存在时仍要求目标 catalog.json 与 rooms 有效。历史附件重新绑定当前附件目录；workspace 的绝对路径不自动迁移。桌面菜单打开当前生效的数据目录。旧目录保留，不修改用户工作区文件。

验证：npm test 32/32；打包桌面检查 output/data-location-ui-1Q2MWm/report.json 通过，涵盖 UI 保存、未复制时回退、完整手动复制后重启激活与 Agent 保留。

## 0.1.9 性能与群体提及

群聊输入 @ 候选和工具栏提及弹窗都支持“所有人”，仅路由给当前群聊成员，仍受现有接力轮次上限控制。parseMentions 同时兼容 @all、@全体。

流式 delta 不再重建历史 DOM：requestAnimationFrame 合并同帧更新，仅更新当前输出气泡；持久化快照仍刷新完整历史，未做历史分页或虚拟列表。scripts/benchmark-render.cjs 的 500 条历史 + 200 次同步 delta 合成对照：旧版 dispatch 6533.4 ms / 总计 6578.3 ms，新版 dispatch 0.2 ms / 总计 58.4 ms，历史节点保留且最终文本完整。此结果不代表真实网络/模型生成加速。

打包使用 maximum 压缩，Electron locale 保留 en-US、zh-CN、zh-TW。Windows 安装包由 111232183 降至 102699065 字节，减少约 7.7%；不裁剪 Chromium 核心、GPU 库或许可证。业务 app.asar 约 0.46 MB，体积主要来自 Electron。

33/33 回归；最终优化版桌面核心验收 output/desktop-smoke-CWhsSh/report.json 12 项通过；@所有人 两入口验收 output/composer-ui-uu7WUT/report.json。基准证据 output/render-benchmark-79Jfcj/report.json 和 output/render-benchmark-p4GH7n/report.json。输出报告本地忽略，脚本随源码提供。桌面原生项目同步仍未完成。

## 0.1.10 WorkBuddy 接入流程与实测边界

### 验证范围：只实测国际版，国内版没有实测

| 版本 | 后端标识 | 当前证据 |
| --- | --- | --- |
| WorkBuddy AI 国际版 5.8.4 | `workbuddy-ai` | 已在真实安装上验证桌面登录复用、ACP 初始化、模型读取与应用、独立会话、两位群成员真实回复，以及 UI 发送和 @ 提及 |
| WorkBuddy 国内版 | `workbuddy` | **没有实测。** 仅完成代码中的后端注册、安装识别及离线模拟测试；未完成真实桌面的初始化、登录复用、模型查询或聊天回复验证 |

本机国内版运行在另一个 Windows 用户下。当前连接器只查找当前用户的桌面运行时，尚未实现跨用户 helper/转发。国内版未实测不代表已确认不兼容，也不能把国际版成功推广为国内版成功。`checks/standalone.test.cjs` 中双版本同群测试使用模拟后端，`checks/workbuddy.test.cjs` 的国内版安装识别使用构造的安装目录，均不算国内版实测。

### 接入原理与前提

连接链路为：群聊 → 当前用户 WorkBuddy 桌面的 supervisor 控制管道 → 桌面创建的独立后端进程 → 本机 ACP HTTP/SSE → 群聊回复。

这里的 HTTP/SSE 是群聊与本机 `127.0.0.1` 运行时之间的通信。模型请求仍由 WorkBuddy 后端按其已有账号和网络配置处理；这不表示模型在本地运行。无需另行部署云端 ACP 服务，也无需在群聊中重新登录。

1. 在同一个 Windows 用户下打开对应版本的 WorkBuddy，保持桌面已登录，并先在桌面发送一条消息，以启动桌面的运行时及凭据引导。
2. 在群聊“后端管理”中保存对应桌面程序的完整路径。此次实测国际版为 `D:\WorkBuddy mocias\WorkBuddyAI.exe`；这是本机路径，其他机器必须重新选择，不能硬编码。
3. 添加 Agent 时读取后端实际返回的模型列表，选择并固定模型，再加入群聊。创建联系人/群本身不发送生成请求；读取模型会启动能力查询运行时，发送消息才触发实际回复。

### 实现步骤

1. **识别安装包和版本。** `standalone/discovery.cjs` 调用 `standalone/workbuddy.cjs` 的 `desktopLaunch()`，校验程序名及安装目录中的 `resources/app.asar.unpacked/cli/bin/codebuddy`、`cli/product.json`。国际版要求 `product.authentication.id` 为 `workbuddy-desktop-ai`，国内版候选要求 `workbuddy-desktop`，防止两个版本入口混用。启动配置带 `workbuddySupervisor: true`；`lib/room.cjs` 据此选择 `WorkbuddyPool`，`standalone/models.cjs` 也使用同一连接器。
2. **寻找当前用户的 supervisor。** `connectSupervisor()` 在当前用户主目录的 `.workbuddy-ai`、`.workbuddy` 候选中查找运行时描述文件。国际版本次实际使用 `.workbuddy`，因此不能仅凭配置目录名判断版本。对每个 `path.resolve(configDir)` 计算 SHA-1，取前 12 个十六进制字符作为 `hash`，读取 `os.tmpdir()/wb/<hash>/sidecar.pid`。描述文件包含 PID、控制管道 UUID 和本地控制身份信息；不得把其中的 token 写入日志或交接材料。
3. **核对桌面身份。** 查询描述文件 PID 对应的可执行文件，必须与用户选择的程序路径一致。连接 Windows 命名管道 `\\.\pipe\workbuddy-<hash>-sidecar-control-<controlPipeUuid>`，使用按行分隔的 JSON-RPC 调用 `sidecar.ping`，核对返回的 PID/token 与描述文件一致。仅连接已有桌面 supervisor，不另建登录流程。
4. **由桌面创建群聊运行时。** 生成本应用独有的 `agent-room-<UUID>`，向 supervisor 调用 `session.create`，指定已安装桌面 EXE、内置 CLI 入口、现有工作目录和 `port: 0`。supervisor 通过桌面的正常凭据引导把已有授权提供给子进程；群聊不读取/导出账号密钥，不复制账号凭据文件，也不调用 ACP `authenticate`。此前直接启动独立后端、要求单独登录的尝试已被这条流程替代。
5. **建立带认证的本机 ACP 连接。** 从创建结果取得 `acpEndpoint`、PID、`runtimeId`，仅接受有效的 `http://127.0.0.1:<port>` 地址。先 `POST <endpoint>/connect` 取得 `connectionId` 和可选 `sessionToken`，随后请求携带本应用临时生成的网关认证及 ACP 连接标识。`GET <endpoint>` 订阅 SSE；`POST <endpoint>` 发送 JSON-RPC，并兼容 JSON/SSE 响应。端口由运行时返回，不能复用历史报告里的端口。
6. **打开会话并传递消息。** 调用 `initialize`，再以每位 Agent 的实际工作区调用 `session/new`，从返回的 `configOptions` 学习模型和推理选项，通过 `session/set_config_option` 应用固定模型。发送使用 `session/prompt`，文本增量来自 `session/update` 的 `agent_message_chunk`，由现有 ACP/群聊逻辑显示并持久化。`session/cancel` 用于取消。
7. **按成员隔离运行时。** `WorkbuddyPool` 为每个成员分配独立的 `WorkbuddyConnection`，每个连接对应独立后端进程和 ACP 会话。此前共享单个运行时时出现过旧会话无回复/并发卡住；每成员独立运行时是当前已验证的方案。启动进程使用已有的房间数据目录，具体会话仍使用成员工作区，避免新后端缺少旧版默认目录导致启动失败。
8. **清理本应用创建的资源。** 关闭时中断 SSE、拒绝未完成请求、尝试 `DELETE <endpoint>` 关闭连接，并向 supervisor 调用 `session.kill`，只传本应用生成的 `sessionId` 及已返回的 `expectedRuntimeId`。不关闭 supervisor，不结束桌面原有任务，不调用 `sidecar.shutdown`。

### 启动配置与权限

由 supervisor 启动桌面 EXE 时设置 `ELECTRON_RUN_AS_NODE=1`，执行其安装包中的 CLI，主要参数为：

```text
<cli/bin/codebuddy> --serve --acp --acp-transport streamable-http
--strict-mcp-config --mcp-config {"mcpServers":{}}
--permission-mode plan --tools ""
```

这些参数由程序以参数数组传递，以上仅用于说明，不应复制成忽略空参数/引号的启动命令。supervisor 负责动态端口和凭据引导；不要绕过它直接启动并期待自动继承桌面授权。

环境中指定安装包自己的 `ACC_PRODUCT_CONFIG_PATH`、`CODEBUDDY_HOST=workbuddy-desktop`，以及已核验的 `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR`；其余产品启动设置见 `desktopLaunch()`。`CODEBUDDY_GATEWAY_AUTH=password`，`CODEBUDDY_GATEWAY_PASSWORD` 是本应用随机生成、只用于这次本机连接的临时密码，**不是桌面账号密码或模型 API key**，不得落日志。保持接口认证开启。

当前用于 CHAT：不向 ACP 宣告客户端文件读写能力，运行时关闭工具及额外 MCP，权限请求返回 cancelled。这里只记录当前启动配置；未验证 WORK、文件修改、附件工具读取等能力，不能从聊天成功推断这些能力已接通。

### 复现与验收证据

在 `D:\agents-group\dsh-agent-room` 下运行；路径含空格时整体加引号，换机器须改为实际安装路径：

```powershell
# 初始化、模型枚举及两个独立会话，不发送生成请求
node scripts/check-live-workbuddy.cjs "workbuddy-ai=D:\WorkBuddy mocias\WorkBuddyAI.exe"

# 另发送固定文字的真实模型测试请求
node scripts/check-live-workbuddy.cjs "workbuddy-ai=D:\WorkBuddy mocias\WorkBuddyAI.exe" --chat

# 启动本地服务后，在另一终端验证真实群聊
npm start
node scripts/check-live-workbuddy-group.cjs "D:\WorkBuddy mocias\WorkBuddyAI.exe"
```

群聊脚本默认访问 `http://127.0.0.1:4318`（可用 `AGENT_ROOM_URL` 指定），会保存国际版后端路径，创建或复用 `WorkBuddy AI`、`WorkBuddy AI 测试伙伴` 联系人和“WorkBuddy AI 接入验证”群，发送 `@所有人` 的真实模型请求并保留聊天记录。该脚本针对国际版；不得当作国内版验收。带 `--chat` 的检查和群聊脚本会使用现有账号额度。脚本只证明它们实际检查到的行为，不能仅因脚本存在就宣称已执行通过。

2026-10-16 已完成的国际版证据：

| 检查 | 本机证据 | 结论 |
| --- | --- | --- |
| supervisor → ACP → 模型回复 | `output/workbuddy-sidecar-ZvITYn/report.json` | `passed: true`，返回 `WORKBUDDY_SUPERVISOR_API_OK`，未重新登录，测试运行时已关闭 |
| 两位群成员真实回复 | `output/workbuddy-group-OXkHEQ/report.json` | `passed: true`；两位 `fast-model` 成员有不同会话 ID/工作区，各自返回 `WORKBUDDY_GROUP_OK` |
| 群聊 UI 发送及 @ 提及 | 同报告 `uiVerification` 与 `output/workbuddy-group-OXkHEQ/group-ui.png` | 从页面发送，只提及 `WorkBuddy AI`，得到 `WORKBUDDY_UI_OK` |
| 自动回归 | 当次 `npm test`，41/41 通过 | 包含安装识别、流解析、独立运行时、断线清理/重连、工作区等；属于自动测试，不能替代国内版实测 |

这些 `output/` 文件是本机历史验收产物，已被 Git 忽略；新环境可通过脚本重新生成。0.1.10 安装包已构建，不能把构建成功说成已经在另一台机器或另一个 Windows 用户下完成验收。

### 未完成事项与排查入口

- **国内版没有实测**；另一个 Windows 用户的连接程序、经过认证的跨用户转发、真实登录复用/模型/回复验证均待实现或执行。不能读取另一用户的凭据文件来替代连接设计。
- 国际版目前仅确认本机 5.8.4；supervisor 控制管道、描述文件和内置 CLI 属于产品内部接口，版本升级后需重新核验，不能当作长期稳定的公开接口契约。
- WorkBuddy 原生桌面任务列表是否显示群聊会话尚未验证；本应用的联系人和历史持久化不等于原生任务列表同步，也不等于跨重启恢复原 session ID。
- 未发现运行时时先检查：是否同一 Windows 用户、选对版本/安装路径、桌面已登录且发送过消息、supervisor 进程路径是否匹配。不要转而要求群聊单独登录；不要记录描述文件 token、网关密码或 ACP sessionToken。

## 0.1.10 代理与新工作区启动修复

用户报告：开启全局代理时 Room 无法与 Codex 聊天，切成系统代理又影响 Dot；后端安装在不同盘时曾报错。没有原始报错或代理软件/模式信息，不能断言已复现用户所有网络模式。

确认并修复的原因：

- 旧 Codex/ACP 环境构造默认覆盖为 socks5h://127.0.0.1:10808，Codex 的 proxy:false 仍回落到固定值。改为共用 lib/backend-env.cjs：默认保留现有代理环境，未配置则不注入；只有显式后端代理或 AGENT_ROOM_PROXY 才追加。保留并合并 NO_PROXY/no_proxy，始终绕过 localhost、127.0.0.1、::1。proxy:false 或空字符串表示不追加应用代理，仍继承进程已有环境。
- 后端管理新增“仅此后端使用的代理”可选地址，按后端保存在 backend-preferences.json，模型查询和聊天使用同一配置。留空恢复继承；支持 HTTP/HTTPS/SOCKS5/SOCKS5H，不接受含账号密码、路径或查询参数的 URL。WorkBuddy 继续使用桌面网络配置，该输入对 WorkBuddy 禁用。此设置不改变系统代理或 Dot。
- 新 Agent 使用独立工作区时，旧 workspaces/<backend> 目录可能从未创建，spawn 使用不存在的 cwd 导致 ENOENT；Codex 可能停在初始化等待。进程启动现在优先使用已有后端目录，否则使用现有房间数据目录；具体 thread/session 仍传成员的工作区。没有同盘限制，也没有迁移或复制后端安装。

验证：新增回归先在旧实现上失败，修复后 npm test 50/50 通过。checks/launch-workspace.test.cjs 真实启动 C 盘 Node 进程，执行 D 盘协议测试程序并创建 D 盘成员会话；这验证启动路径，不冒充真实 DSH 模型回复。checks/network-env.test.cjs 验证不强制代理、继承/显式代理和本地绕过；checks/discovery.test.cjs 验证代理持久化和非法地址拒绝。

真实 Codex 端到端证据：output/codex-launch-live-EiaSzX/report.json，passed:true。通过本地应用 HTTP API 添加新 Agent、发送并收到 ROOM_CODEX_LAUNCH_OK；后端在 C 盘，应用数据和工作区在 D 盘，旧共享 workspaces/codex 目录不存在。仅为该测试后端配置本机现有 HTTP 代理，未改系统代理。先前未设置代理的一轮在当前网络下等待 90 秒无回复（output/codex-launch-live-PncL8Q/report.json），因此不能声称当前网络无需代理，也未对用户未说明的 TUN/全局/系统模式或 Dot 进行切换验收。

复现：node scripts/check-live-codex-launch.cjs <codex.exe绝对路径>；可用 CHECK_BACKEND_PROXY 为隔离应用中的此后端指定代理。会发送一次真实模型请求并使用已有账号额度；报告和数据存入 output/codex-launch-live-*。该脚本跳过原生项目注册，未改变现有联系人/历史。

代理设置 UI 验收：output/proxy-ui-a7GfI8/report.json 与 proxy-settings.png，验证手动配置、保存并重新打开后地址仍保留、切换 WorkBuddy 时禁用代理输入并提示使用桌面配置；测试在独立数据目录执行。

## 2026-10-17 私聊与多消息第一版

用户选择复用现有后端会话，通过收件人过滤实现私聊；用户可见所有消息，不另建私聊会话，也不新增发送消息工具。

- lib/message-routing.cjs：完整输出按代码块外独占一行 --- 拆分；每块开头 #完整显示名 路由至该成员，普通文本与 @ 公开。支持带空格名称、#用户；未知/歧义对象拒绝整批，绝不转公开。
- room.cjs：记录 visibility、recipientIds、recipientLabels。捕获、附件与重放按稳定 ID 过滤；接收方记录标明私聊双方，正文保留 #接收者。全部块入队后才唤醒接收者，每批对同一目标只触发一次接力。中断输出不发布。
- 用户多块输入也解析；附件只绑定第一块。无 visibility 的旧记录保持公开，不重新解析历史正文。
- agent-room-skill.md 为完整统一规则；Codex developerInstructions 与 ACP 首次 prompt 复用已有注入路径。新会话/重建注入，普通轮次仅简短提醒。进程启动读取文件，修改需重启；尚未实现热更新和压缩后检测补发。
- standalone 输入支持 # 成员补全；私聊淡紫色气泡与文字标识。用户看到的流式输出标为尚未投递的生成预览。原插件 UI 同步添加私聊颜色/标签，但本轮仅实际验收 standalone 页面。
- 打包配置包含技能文件。未构建新安装包，未升级现有安装。

验证：npm test 56/56（含 6 个新增私聊用例）。隔离真实 Edge + 本机服务 + 真实群聊引擎 + 模拟模型的 scripts/check-private-chat-ui.cjs 验收 9 项通过，证据 output/private-chat-ui-uK5zUx/report.json 与 chat.png；涵盖补全、拆分、接收者标记、第三 Agent 排除、颜色、刷新和失败草稿恢复。未进行真实 harness 模型格式遵循验收。

边界：这是模型消息投递过滤，不是本机文件访问隔离；私聊参与者共用原会话，后续公开发言仍可能引用已知内容，规则只能约束行为。用户可见完整日志和生成过程。

## 2026-10-17 0.1.11：闹钟、统一前缀与桌面升级

新增一次性本地闹钟 `/alarm 10m #成员 备注`，支持 s/m/h/d、带时区的 ISO 时间、公开 @成员/@所有人 和私密 #成员/#用户。Agent 在回复中单独一块输出指令即可调用，创建成功回执只对创建者及用户可见；当前群待触发上限 100、最长 366 天。独立服务持久化 alarms.json，运行期间按秒检查，退出/休眠期间到期的闹钟恢复后补发。事件带 alarmId 并根据已保存历史去重；目标删除则取消。UI 增加闹钟列表与取消。

群聊显示和模型输入统一 @发送者：@接收者 / #发送者：#接收者，发送者由真实会话确定；普通无点名内容是 @发送者：正文。兼容原简写，历史原文保持不变，动态增加 displayText。闹钟到期为系统 authorId 和 kind=alarm，过滤与重放不再把它当 UI-only 状态忽略。当前时间以 Asia/Shanghai 提供。skill 升级 v2；原 DSH 插件宿主未接入闹钟存储，能力提示明确不可用。

打包验收发现并复现退出错误 ERR_STREAM_WRITE_AFTER_END：SSE 已 end，但 room.dispose 再次广播。修复 standalone 服务退出时停止广播、清空连接集合并跳过已结束连接；增加保持 SSE 打开时关闭服务的回归。首次打包验收原先未检查主进程退出异常，其通过记录不能作为最终结果；脚本已增加异常采集和退出后断言。

最终验证：63/63 自动回归；浏览器 13 项通过 output/private-chat-ui-6uwoud/report.json（真实 UI/引擎、模拟模型）。修复后打包验收 output/packaged-alarms-tehXHi/report.json；实际安装路径验收 output/packaged-alarms-HvelYY/report.json（闹钟、取消、重启无重复、退出无主进程异常；均未调用真实模型）。未验证各真实模型对闹钟文本格式的遵循率。

安装包 dist/Agent-Room-Setup-0.1.11-x64.exe；已通过静默安装将 D:\Agent Room 从 0.1.9 升至 0.1.11.0，桌面快捷方式仍指向原路径。安装后 app.asar 与测试构建哈希一致，9 个既有聊天数据文件哈希未变。旧 exe、app.asar 与数据哈希清单在 output/desktop-backup-20261017-151612。用户文件与 output/dist 不进入 Git 源码提交。

## 2026-10-17 0.1.12：自动迁移与增量更新

数据目录改为由程序在重启时复制、逐文件 SHA-256 校验、切换；失败保留旧目录。兼容旧版已保存的 pending。数据目录内 workspace 路径更新，外部路径保持，清除旧 nativeSessions 以重建并回放历史。目标冲突、相互包含、链接及安装 resources/locales 路径拒绝；源目录从不删除。完成复制后、配置切换前的中断可凭迁移标记恢复。

新增 scripts/build-incremental.cjs 与 desktop/Apply-Update.ps1，按 64 KiB 二进制区块生成差异。更新器预检基准哈希、重建并校验全部文件、正常关闭应用、备份后覆盖，写入失败回滚。只允许应用文件，保留所有用户目录。NSIS 清理改为明确文件清单；增量包同时替换旧卸载器，避免继承旧版递归清理目录的行为。暂为手动下载 ZIP 运行 Update.cmd，不含应用内在线自动更新。

验证：66/66 自动回归；自动迁移 UI output/data-location-ui-eEseKX/report.json（控制重启为先退出再由测试启动，未调用模型）；NSIS 清理隔离验收 output/installer-preserve-CNzXU9/report.json。实际安装 D:\Agent Room 已通过同一增量脚本从 0.1.11 更新到 0.1.12，未执行卸载。安装版闹钟/重启/退出验收 output/packaged-alarms-hZrVzN/report.json，无真实模型调用。用户既有 pending 已在真实启动时自动迁移到 D:\Agent Room\agent room data；原目录 9 文件哈希不变，新目录 8 个非 catalog 文件哈希一致，catalog 移除旧会话绑定。当前目录无 warning/pending，证据 output/installed-migration-0.1.12.json 与 png。

发行包：完整安装包 Agent-Room-Setup-0.1.12-x64.exe；增量 Agent-Room-Update-0.1.11-to-0.1.12-x64.zip（292397 字节，基准必须精确匹配）。本机旧程序备份 D:\Agent Room\.update-backup-0.1.11-c523c2c8f70b4efe9066c3c015460f96。源数据未删除。

## 2026-10-17 0.1.13：群聊置顶与删除

群聊右键菜单增加置顶/取消置顶、删除；聊天页增加“群聊管理”按钮。复用 pinned 排序并持久化。删除弹窗说明保留范围，确认后关闭运行会话、取消该群 pending 闹钟、移除 catalog；保留联系人、其他群聊、工作区、本地日志与附件。忙碌回复和投递中的闹钟拒绝删除；异步 discovery 结束后再次检查会话存在性，避免删除后重新创建 runtime。SSE catalog 事件同步清空已删除的当前聊天与选中状态。

验证：67/67 自动回归；打包 UI output/group-management-ui-7jhHDd/report.json，安装版 UI output/group-management-ui-nwMZ66/report.json，覆盖置顶排序、重启、顶部菜单、删除取消/确认、清空当前面板；安装版闹钟/退出 output/packaged-alarms-Tyw7io/report.json。测试使用隔离配置，不调用模型，不删除真实群聊。

0.1.13 已通过增量脚本应用到 D:\Agent Room，旧程序备份 .update-backup-0.1.12-2e798f5506394afdaf6ccfa0d2363729。现有 10 个用户数据文件哈希不变，安装的三个补丁文件哈希匹配；完整安装包与 0.1.12→0.1.13 增量 ZIP（209950 字节）位于 dist。首次 NSIS 构建失败，串行重试后构建成功，最终安装版已重新验收。

## 2026-10-17 0.1.14：磁盘根目录下的数据迁移修复

用户选择 D:\agent room data 后失败，源目录仍为 D:\Agent Room\agent room data。复现 Node 在 Windows 上 mkdirSync('D:/', {recursive:true}) 返回 EPERM。新增回归先红后绿；ensureDirectory 对已经存在的目录只检查类型，不执行 mkdir，覆盖迁移目标父目录和配置父目录。

真实 Electron 首轮验证进一步发现 fs.cpSync 在根目录旁临时文件夹执行时进程退出（ECONNRESET，退出码 4294930435），临时副本仍为空；不能把初次测试通过认定为迁移成功。改为显式递归目录并 copyFileSync，拒绝特殊文件且不覆盖目标文件。最终真实安装版启动成功迁移至 D:\agent room data，pending/warning 均为空，证据 output/root-migration-0.1.14.json/png。原目录 10 文件哈希不变；8 个非 catalog/marker 文件在新目录哈希一致。失败产生的两个空临时目录保留，未执行删除。

68/68 回归通过；最终安装版闹钟、重启、退出检查 output/packaged-alarms-37j1VO/report.json。桌面已增量修复至 0.1.14；最终发行增量包基于备份的原 0.1.13 三个程序文件重新生成，不基于中间测试版。源数据未删除。

## 2026-10-17 0.1.15：气泡正文移除系统发送者前缀

渲染正文改用 record.text，不再使用供模型上下文识别发言者的 displayText。发送者继续显示在气泡上方；原消息的 @点名 / #私聊对象与私聊范围标签保留。历史文件和模型输入格式不变，不修改模型自己写出的自我介绍。

验证：真实浏览器+模拟模型 output/private-chat-ui-U3J7Jc/report.json，严格核对用户及私聊正文没有自动发送者前缀；公开/私聊闹钟、第三 Agent 排除、刷新通过。打包验收 output/packaged-alarms-0uSpXB/report.json；安装版 output/packaged-alarms-rkdJJc/report.json。桌面已通过增量更新至 0.1.15，无需重装。完整安装包和 0.1.14→0.1.15 增量 ZIP 在 dist。

## 2026-10-17 0.1.16：点名正文中的冒号误判

从 DSH 会话原始 assistant/message 确认失败正文为“@用户 没什么异常——…简单说：…”。旧正则匹配至正文里的首个冒号，把整段当成发送者。现在仅将精确已知姓名（含空格）或紧凑无空白标签后紧接冒号识别为 envelope；正文含空格的点名与私聊保留正常解析。真伪造、范围冲突检查保留。

12 项相关回归通过，新增公开点名/含空格私聊/Markdown 标题冒号用例；打包退出和闹钟验收 output/packaged-alarms-kfobGz/report.json。0.1.16 完整安装包及 0.1.15→0.1.16 增量 ZIP 已生成。检测到用户桌面正在运行，未应用补丁、未打断会话；当前实际安装仍为 0.1.15。未重发原失败消息。

## 2026-10-17 0.1.17：会话身份分层与消息界面优化

Agent 基础指令明确名称、工作区和 persona；单聊单独说明一对一身份，只有群聊注入 agent-room-skill.md。创建联系人仍仅保存角色资料，首次启动该会话时注入，不为了初始化额外调用模型。各群聊会话独立，身份保持一致；新后端会话加载一次完整规则。

思考/回复/连接重试状态移至输入工具栏右侧，空生成不再占聊天气泡；真正生成的文本仍为用户可见预览。消息列表保留未改变的 DOM 节点，避免状态更新重建历史。后端启动及点名多人回复并发；已连接会话发送不再等待发现扫描；单聊后续普通消息不再等待 1.2 秒群聊合并计时器。外部模型网络重试及冷启动耗时仍存在，没有宣称消除所有延迟。

验证：70 项自动测试通过（output/tests-0.1.17.log）；500 条历史的真实浏览器+模拟模型验证右侧状态、无空气泡、旧节点保留、私聊与闹钟（output/private-chat-ui-7OTcIh）。打包版群管理、输入框和长历史滚动、闹钟与重启通过（output/group-management-ui-PFkpRc、output/composer-ui-JONeiy、output/packaged-alarms-Qu7LLZ）。本机应用退出后已增量更新 0.1.15→0.1.17，安装版独立数据验收通过（output/packaged-alarms-pDmPqS）；原程序备份在安装目录 .update-backup-0.1.15-3867e937a84c4d108979273f0168756f。未调用真实模型或修改真实聊天记录进行测试。

## 2026-10-17 0.1.18：Claude Code 本机终端桥接（真实模型待验收）

### 更新基础与状态

开始时本地干净，0.1.17 / HEAD 5e67747。使用现有本机 HTTP 代理拉取 agents-chatroom 后，HEAD 与 agents-chatroom/main 的左右差异为 0/0。此次修改是在该版本上追加，未从旧 0.1.10 回退；没有改写 room.cjs 的身份分层、私聊、闹钟或群管理实现。开始前 70 项基线通过，完成后 78 项通过。

**已实现并通过模拟协议/应用流程测试，不等于已接通本机真实 Claude。** 本机 PATH、常见终端安装目录及 Claude 安装/运行目录未找到终端版入口；确认了 Claude 桌面进程（2.42304.0）与下载的 Claude Setup.exe。这些不证明终端版已安装，也不能断言 Claude 桌面未来永远无法桥接。用户安装的是桌面 Code 页面还是独立终端版，尚待确认；没有擅自安装另一个 CLI、发起登录或复制桌面凭据。

### 接入链路与流程

Room → 现有 AcpPool → standalone/claude-acp.cjs → 本机 Claude Code CLI 的双向 stream-json → 模型回复。ACP 由本项目桥接提供，不能称 Claude Code CLI 原生支持 ACP。协议参考 [官方 CLI 文档](https://code.claude.com/docs/en/cli-reference) 与 [官方 Python SDK 控制协议实现](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。

1. 找到当前 Windows 用户的终端版 claude.exe、npm claude.cmd 或 CLI JavaScript 入口；用户指定路径优先。自动发现仍遵守现有扫描许可，拒绝把 Claude 桌面 EXE 当 CLI。终端程序、Room 和工作区无需同盘。
2. 在“后端管理”选择 Claude Code 并保存该路径。使用终端版自己已有的登录/提供方配置；代理继承 Room 进程环境，可设置仅此后端代理。尚未验证复用 Claude 桌面登录，不能承诺桌面已登录就无需配置终端版。
3. “添加 Agent”读取原生 initialize 返回的 models，再用 set_model 并等待确认。只列 CLI 返回的模型，不生成备用模型列表；模型别名仍由 Claude Code 解释，无法承诺固定底层版本。没有模型或拒绝切换会报错。
4. 每个会话新建独立 CLI 子进程、session UUID 与成员工作区，同一 Agent 跨群复用工作区而会话独立。当前会话保留上下文；Room 重启后按现有日志机制重建，不声称恢复原生 session ID 或同步至 Claude 桌面任务列表。
5. 流式 delta 转成 ACP 更新；完整 assistant/result 仅作无流式内容时的后备，避免重复。result 即使 subtype=success，只要 is_error=true 仍按错误处理。取消通过 interrupt；异常退出使池清除旧会话，下轮可重建。退出只清理此桥接创建的子进程。
6. 当前只开放文本 CHAT：空工具集、plan 权限模式、禁用 hooks、空 MCP 配置，收到工具许可请求一律拒绝。消息标记 client_composed，防止 Room 的 @ 提及被 CLI 当作文件展开。图片/文件内容未接入；没有验证可用的推理强度控制，故不提供虚构档位。身份和群规则继续复用 0.1.17 注入路径，单聊不含群规则；私聊与闹钟由原有 Room 引擎处理。

入口位于 lib/harnesses.cjs、standalone/discovery.cjs；桥接为 standalone/claude-acp.cjs，沿用 lib/acp-backend.cjs 与 standalone/models.cjs。打包后桥接在 app.asar 内，因此必须由 Electron 的 Node 模式运行，不能交给 PATH 上普通 Node 读取 ASAR。安装包不分发 Claude CLI 或用户配置。

### 已执行的验证与证据

- output/tests-claude-integration.log：78/78 自动检查通过。新增 checks/claude.test.cjs 的 8 项使用 checks/fixtures/claude-stream-fixture.cjs 模拟 CLI：发现/桌面排除、模型读取与拒绝、两位成员会话/工作区隔离、流式去重、错误/权限、取消、进程崩溃重连、最新版单聊/群聊身份与真实 HTTP 联系人/置顶/历史重启流程。其余 70 项覆盖现有私聊、闹钟、代理、跨盘、迁移及群管理，不能当成真实模型验收。
- output/claude-ui-0.1.18/report.json、reply.png、settings.png：真实浏览器实际操作，使用模拟 CLI，验证读取模型、选择 Opus fixture、创建联系人、发送显示回复和准确的后端说明；未调用真实 Claude。
- output/claude-packaged-JZw4vV/report.json：实际 0.1.18 ASAR 内的桥接，在 PATH 有系统 Node 和没有系统 Node 两种环境均完成模型选择及模拟回复。这是打包运行时验证，不是完整桌面 GUI 或真实模型验证。
- output/claude-live-CbEjct/report.json：本机终端入口发现失败，modelRequestsSent=false、chatVerified=false；没有把桥接 initialize 成功当成实际 Claude 已连接。
- output/update-0.1.18-validation.json：在隔离的 0.1.17 安装副本上应用增量包，三个目标文件哈希与新版本一致、ASAR 版本 0.1.18、测试用户目录保留。没有替换用户当前安装或修改真实聊天数据。

后续找到终端版入口后运行：

```powershell
node scripts/check-live-claude.cjs "终端版 claude 程序完整路径"
node scripts/check-live-claude.cjs "终端版 claude 程序完整路径" --chat
```

首条只验证原生初始化、模型列表与独立会话，不证明账号可推理。第二条会向两个独立会话各发送一条固定标记消息、使用账号额度；必须实际执行通过后才能写“真实 Claude 回复已验证”。再在独立数据目录完成真实群聊 @、私聊和闹钟验证。脚本保留 report.json，不自动登录或导出账号信息。

### 构建交付

源码版本 0.1.18。完整安装包 dist/Agent-Room-Setup-0.1.18-x64.exe（102716652 字节）；对应最新 0.1.17 的增量包 dist/Agent-Room-Update-0.1.17-to-0.1.18-x64.zip（298294 字节）。保留旧版文件校验和备份逻辑。更新真实安装前需确认当前版本仍为 0.1.17；包构建及隔离升级成功不等于已更新用户安装，也不等于真实 Claude 已接入。

WorkBuddy 验证边界继续不变：仅国际版 5.8.4 有真实接入证据，国内版未实测。


## 2026-10-17 0.1.19：Claude 桌面 Gateway API 接入与已安装版本真实验证

本节优先于前文 0.1.18 的历史状态。用户已在 Claude 桌面配置 Gateway API，Code 可用；不能再用此前 Free 账号或缺少终端 CLI 的结论描述当前状态。

实现：选择 Claude 桌面 EXE 后，standalone/claude-desktop.cjs 在当前 Windows 用户的 Claude-3p 目录中解析已应用配置元数据、内置 Code 运行程序和公开模型缓存。桥接只保存桌面入口与配置目录引用。API 密钥仅在桥接进程内存和子进程环境中使用，不导出至 Room 后端配置、报告或聊天日志；错误消息屏蔽已知密钥。当前支持 Gateway 的 bearer 和 x-api-key，其他提供方未验收。第一方桌面账号登录复用与桌面原生任务列表同步仍未接通。

模型处理：终端 CLI 的别名可能与桌面不同，需读取 model-catalog/published.json 中桌面 ccd 的 provider_alias_targets，并按 Gateway 目标设置原生别名；显式 inferenceModels 家族默认项优先。本次 Haiku 对应 claude-haiku-4-5-20251001。目录来源是桌面现有缓存，不代表网关对全部列出模型均授权。

本轮发现并修复：Code 2.1.299 的 Plan 模式会把 Haiku 提升到 Sonnet；改用 default 权限模式，同时保持空工具集、禁用 hooks、空 MCP 和许可回调拒绝。之前尝试的 ANTHROPIC_MAX_OUTPUT_TOKENS 不生效，检查脚本现使用 CLAUDE_CODE_MAX_OUTPUT_TOKENS=32、MAX_THINKING_TOKENS=0，并采用简短系统提示。没有保留不必要的进程重启方案。

验证边界：

- 80/80 离线回归通过：output/tests-claude-desktop-api.log。首次全量运行曾出现 WorkBuddy 模拟群聊的两秒等待超时；该文件单独 15/15 与最终全量 80/80 均通过，不把早先失败轮次称作通过。
- 真实 Code 运行程序 + 本机假 API 通过：output/claude-local-gateway-Caf1Ln/report.json。观察到请求使用桌面 Haiku 4.5 映射、max_tokens=64；该检查不使用用户 API 或真实模型。
- 打包版模拟检查：output/claude-packaged-fOxrYL/report.json，有无系统 Node 两种情况通过，并确认可解析桌面 API 入口。
- 早先一次真实短回复尝试失败：output/claude-live-EEwwVo/report.json，选定 Haiku 却请求 Sonnet 5.5。之后的排查均使用本机假 API。
- 用户再次授权更新与真实验证后，仅发送一条测试消息。证据 output/claude-installed-live-Cnn5HP/report.json：installedVersion=0.1.19、desktopBackendConfigured=true、selectedModel=haiku、reply=CLAUDE_ROOM_OK、status=end_turn、passed=true。测试直接加载安装目录内的代码，并由已安装桌面 EXE 的 Node 模式运行。Room 回报输入加输出计数为 366 tokens；此计数不能作为完整网关账单核对，未统计原生重试的 HTTP 次数或缓存读写用量。

已更新当前安装 D:/Agent Room：0.1.17 → 0.1.19，实际生产代码已核对与源码一致。打包会调整 package.json.main 为 desktop/main.cjs，不能逐字比较打包前后的 package.json 来判断旧包。程序备份 D:/Agent Room/.update-backup-0.1.17-2694efb43e4544ac8578327ab1d8a5f2；真实聊天数据目录 D:/agent room data 保留。使用应用自身 BackendDiscovery.save 保存 Claude 桌面入口，未改其他后端设置；原后端配置备份位于该真实验证输出目录。未在用户聊天记录中插入测试消息或创建测试群。

这次成功证明已安装桥接可复用当前桌面 Gateway 配置并得到 Haiku 的真实短回复；未做多模型、多成员、真实群聊私聊/闹钟或跨重启原生会话恢复验收。此类行为仅有既有离线测试覆盖。WorkBuddy 仍仅国际版有真实接入证据，国内版未实测。

## 2026-10-17 0.1.20：具体模型目录补全

Claude 桌面桥接从当前 profile 的 model-catalog/published.json 读取 ccd 中支持 gateway 的具体模型，并合并显式 inferenceModels；保留 CLI 旧别名供既有 Agent 使用。真实目录查询返回 12 个具体模型，另保留兼容别名。选中模型经 set_model 传递原始 ID，不把多个版本折叠成家族别名。查询目录本身不额外执行 set_model。

WorkBuddy 原生 CLI 默认角色仅列四档。实验表明 web-ui header + models/refresh 或启用缓存仍返回四档，因此未引入这些无效改动。改为保留 ACP 原生选项，并用选定可执行文件同版本 product.json 中 supportsToolCall 且未 hidden/disabled 的模型补全，核验 authentication.id 避免国内/国际混用。不读取其他版本旧缓存，不编造 Step-5 等本版本未列出的模型；动态云端目录与权益可与安装版本目录不同。模型权限仍由服务端判断。

验证：81/81 回归通过，output/tests-model-catalog.log。WorkBuddy AI 原生查询 22 项、DeepSeek 完整 ID 被严格会话接受且一次真实回复 MODEL_SELECTION_OK（output/workbuddy-concrete-model.json）。Claude 真实 CLI + 本机假 Gateway 记录请求 model=claude-haiku-4-5-20251001（output/claude-local-gateway-OOjFxk/report.json），不是只改下拉框名称；未逐项验证所有远端模型。打包桥接与闹钟退出/重启通过 output/claude-packaged-ouUPD5、output/packaged-alarms-vhXW2K。

0.1.20 完整安装包及 0.1.19→0.1.20 增量 ZIP 已生成。用户安装版正在运行，因此没有关闭或替换，当前仍为 0.1.19。本轮未提交/上传混合工作树中的既有 Claude 接入改动。

## 2026-10-17 0.1.21：WorkBuddy 桌面在线目录快照同步

替换 0.1.20 的安装包模型补全。已定位 WorkBuddy 5.8.4 CloudProductManager 的 cloud_product_config_cache，desktop LocalStorage 为 wb_entry_<md5(key)>.info。仅读取 connectSupervisor 已验证 exe 的 configDir（本机 AI 实际为 .workbuddy，不能按版本名猜 .workbuddy-ai），支持 gzip/JSON，按 agents[cli].models 排序过滤模型；只输出 ID/名称，限输入与解压大小。多个账号缓存无法判定时拒绝补全，降级提示。没有读取凭据、修改桌面配置、刷新云端或改变现有会话。目录快照可能滞后于云端；自定义模型和套餐灰显尚未同步。刷新操作重新读取磁盘；账户权益仍由 WorkBuddy 校验。

验证：9 项定向回归；完整套件第一次群聊路由测试超时，隔离复跑通过，最终 82/82（output/tests-workbuddy-desktop-catalog-rerun.log）。实际读出 27 模型，Step-5 完整 ID 严格选择成功，真实一次短回复 MODEL_CATALOG_OK，证据 output/workbuddy-desktop-catalog.json。打包版 0.1.21 启动/闹钟/重启/退出通过 output/packaged-alarms-JXJek5。生成完整安装包和 0.1.19 到 0.1.21 增量包；D:/Agent Room 0.1.19 仍运行，未替换或中断。

## 2026-10-17 0.1.22：工具栏与交互边界

输入工具统一为 20px 线框 SVG、13px 文字和 36px 点击区域；闹钟移入工具菜单，支持点击外部、Escape、方向键与 Tab。输入卡片、会话列表、搜索和按钮增加主题适配的边界、悬浮和焦点反馈。窄窗口截图发现菜单被聊天边界裁切，修正定位并加入真实几何断言。

82/82 回归 output/tests-0.1.22.log；最终打包界面交互 output/composer-ui-ByLsOl，覆盖图标尺寸/悬浮、菜单键盘与外部关闭、闹钟弹窗、草稿保留、窄屏边界、提及和独立滚动。打包闹钟/退出/重启 output/packaged-alarms-8n7NBj；Claude 模拟协议打包验证 output/claude-packaged-ySbBdP（有/无系统 Node），不是新增真实模型调用。

本地 D:/Agent Room 已应用 0.1.21→0.1.22 增量更新并启动，更新文件 SHA-256 全部匹配；备份 .update-backup-0.1.21-d7d27d1bfb364487931eeffc2fb4293f。未卸载或改动真实聊天内容。发布目标是 agents-chatroom/main，不是 origin/master。

## 2026-10-17 0.1.23：历史搜索与导出

左侧“搜索聊天记录”覆盖全部现存会话，聊天标题栏“聊天记录”默认当前会话。按正文/作者/附件名进行不区分大小写的字面搜索，40 条分页；支持单聊与群聊完整 Markdown/JSON 导出，不受搜索词过滤。明确包含用户可见私聊和附件元数据、不包含附件原文件。直接异步逐行读取持久化日志，不启动模型；导出固定读取字节边界，遵循响应背压；损坏行计数提示，字段白名单不暴露附件路径/内部状态。

新增 checks/history.test.cjs 与 scripts/check-history-ui.cjs。打包 UI 真实搜索/分页/高亮/安全转义与 Electron 下载完成内容验证：output/history-ui-7RgKDL。原工具栏和闹钟回归：output/composer-ui-x4HibN、output/packaged-alarms-LTfX8w。全量并发检查既有 WorkBuddy 群路由出现间歇超时；最终并发 83/83，移除临时诊断后串行 83/83（output/tests-0.1.23-serial.log），未宣称修复旧竞态。

本地 D:/Agent Room 已从 0.1.22 增量升级至 0.1.23，全部更新文件哈希匹配并已启动；备份 .update-backup-0.1.22-798d23efe1e941c8bbbfdd824a2f911d。

## 2026-10-20 0.1.30：群聊投票与累计源码交付

本节是当前交接入口，优先于前文历史描述。源码版本 0.1.30，本轮同时收录此前本地 0.1.24–0.1.29 尚未上传的桌面工作区登记、登记队列生命周期和聊天并发修复；保留已有工作树成果。发布目标为 `agents-chatroom/main`，原 `origin/master` 不作为本轮目标。新建 AGENTS.md 供后续 agent 按当前约定接手。

### 投票实现

每位群成员可通过原生 MCP 发起命题和 2–10 个选项，支持公开记名与匿名、单选改票、弃权、截止、提前结束和取消；用户也可从“工具 → 投票”发起或管理，但用户不计票。参与者为创建时全员快照，包括发起 Agent；忙碌成员等待空闲，完成全员参与后自动结算，结果不自动执行任何方案。

- `lib/polls.cjs`：原子持久化、参与者快照、授权视图、幂等创建和去重、结算、限次邀请、暂停和重试。
- `lib/poll-mcp.cjs`、`lib/poll-mcp-stdio.cjs`：每位成员绑定的 loopback broker 与 stdio MCP；七个工具为 poll_create/list/get/vote/abstain/close/cancel，模型不能自报投票者身份。
- `lib/room.cjs`、`standalone/server.cjs`：专用投票轮次、后台邀请、聊天记录及 SSE；匿名轮次的文本和工具参数不显示，普通消息继续排队，不被隐藏轮次吞掉。
- Codex 通过 thread 配置逐工具批准，并调用 poll_list 预检；ACP 接收会话级 MCP。WorkBuddy 禁用工具延迟加载，通过 `_meta["codebuddy.ai/toolName"]` 精确批准；Claude 仅批准绑定的七个 MCP 工具。
- 前端卡片与列表在 `standalone/public/`；历史导出仅保留公开授权视图。数据位于 Room 数据目录的 `polls.json`，随现有目录迁移流程处理。

匿名是应用层匿名：其他 Agent、Room UI、SSE、聊天历史和导出不获得选票归属，匿名截止前不展示票数。为去重和改票，磁盘内部仍保存选票归属，后端原生会话可能保留工具调用；不能对本机管理员或 Agent 在普通聊天中的主动自曝承诺保密。旧 DSH 插件未接入这套投票工具。

### 累计桌面登记和聊天修复

当前支持按后端保存桌面登记队列、退出等待、备份与冲突检查；DSH 内置桥接、Codex 原生项目及退出后状态合并、Qoder/WorkBuddy 退出后索引登记、Claude 桌面原生 resume 入口，详见 README 的“桌面工作区登记”。登记目录不等于完整导入所有后端聊天历史。登记只在 Room 内运行，退出停止、重启恢复，不再保留脱离主程序的登记进程。

并发/聊天相关改动保留 ACP 轮次边界和会话隔离、模型目录请求合并、启动关闭错误处理，以及已存在的 WorkBuddy/Claude 文本回复修复。真实验收结论以对应报告为准，不能用本轮投票测试替代所有历史场景。

### 本轮验证

- `output/release-0.1.30-elxHfk/tests.log`：115/115 通过，0 失败、0 跳过。
- 投票真实闭环：Codex + DSH `output/polls-live-impMex/report.json`；DSH + Qoder `output/polls-live-rVwBnd/report.json`；DSH + WorkBuddy AI `output/polls-live-r2Mpbg/report.json`。均完成创建、独立投票和自动结算。Claude 投票与 WorkBuddy 国内版尚无本轮真实模型验收。
- 浏览器投票交互与匿名/公开展示已验收，截图 `output/playwright/polls-final.png`。具体边界见 DESKTOP_VALIDATION.md。
- 最终 0.1.30 打包程序启动：`output/packaged-chat-fix-oXjEVV/report.json`。
- 最终打包程序退出/重启登记生命周期：`output/registration-lifecycle-roPGOW`，通过退出后暂停、保留队列、重开恢复和无独立遗留 worker；未调用真实模型。
- `output/release-0.1.30-elxHfk/artifact-audit.json`：ASAR 内 47 个源文件与工作树一致，包含投票桥接，不含用户数据/测试输出；隔离副本实际应用 0.1.29→0.1.30 增量，3 个目标文件 SHA-256 全部匹配，数据与工作区标记保留。

这些 output 路径是本机证据，不随 Git 源码上传。重现实测应使用隔离数据，不能依赖原机器账户或硬编码安装路径。建议技能见 AGENTS.md 的“建议技能”。

### 构建产物与剩余边界

- 完整安装包：`dist/Agent-Room-Setup-0.1.30-x64.exe`，102744370 字节。
- 增量包：`dist/Agent-Room-Update-0.1.29-to-0.1.30-x64.zip`，338333 字节，仅适用于匹配的 0.1.29。
- 校验：`dist/SHA256SUMS-0.1.30.txt`；完整包 SHA-256 `c9b09ef18d6bb4ea39b900ae80cd79e1baec5f3930fd4a3cc527c30b8f8b9caa`，增量包 `657fe20694ca2436ff8e7d726816dd8ceba5b348d2e7cd81dd5a614ea34065cd`。

本轮生成安装包并验证打包程序和隔离增量升级，没有执行 NSIS 安装/卸载，也没有替换用户正在使用的安装或修改真实聊天数据。安装包未做发布者签名、没有自动更新。GitHub 上传范围为源码和文档；安装包保留本地，不创建新的 GitHub Release。

## 2026-10-22：独立界面美化（源码，未重新打包）

在现有绿色基调上整理独立桌面/浏览器共用界面：会话列表与分段筛选、欢迎页与功能提示、聊天留白和气泡、输入卡片、设置与历史弹窗、投票卡片。搜索、历史入口和投票工具使用统一线框图标；外观设置提供五种主题缩略预览与选中状态。深浅色根据浏览器解析后的实际背景色确定，兼容自定义 hex/RGB/HSL；用户气泡、头像、投票、原生表单和焦点均跟随主题。窄窗口工具菜单相对输入卡片定位，避免超出可见区域；保留减少动态效果偏好。

验证使用隔离数据，没有模型请求、真实安装扫描、正式聊天数据修改或发布：

- `output/ui-polish-tests-live.log`：115/115 基础回归通过。受限环境初跑无法访问部分临时文件/本机接口；放行本机测试后完整通过。
- `output/playwright/appearance-6O2lLX/report.json`：真实 Chrome + HTTP/SSE；五种主题、RGB/HSL/短 hex 保存后重载、私聊标记、匿名投票截止前隐藏、历史搜索、空会话、草稿保留、提及与菜单键盘操作；1440/1000/720/390px 无页面横向溢出，输入/发送可见，菜单位于窗口内。含欢迎页、聊天、主题预览、投票及窄窗口截图，浏览器异常与模型调用均为零。
- `output/composer-ui-XWiUOp/report.json`：源码 Electron（`UI_DEV=1`）通过原有图标尺寸、悬浮、菜单键盘/外部关闭、闹钟、提及、草稿保留、30 联系人/长历史独立滚动、联系人/群聊重命名验收。

新增 `scripts/check-ui-appearance.cjs` 可重现视觉验收。此轮没有改版本号、重建安装包、替换用户安装、提交或推送；现有 dist/0.1.30 产物不包含本次样式。

## 2026-10-22 0.1.31：多 harness 外观交付与本地升级

用户已授权打包、本地更新与 GitHub 源码上传。本节覆盖此前“源码未打包”状态。Agent 列表、普通/私聊/流式消息署名新增 harness 标识；群聊副标题列出成员 harness，搜索同时匹配 harness 名称。README 插入 `docs/images/agent-room-multi-harness.png`，截图展示 Codex、DSH、Qoder、Claude Code、WorkBuddy AI 与 WorkBuddy，并明确所有消息来自隔离演示数据，不是真实模型验收。

最终验证：

- `output/tests-0.1.31.log`：115/115 基础回归通过。
- `output/playwright/appearance-JZPIhv/report.json`：五主题、自定义色恢复、六种 harness 标识、匿名投票、历史/空会话、菜单/提及和四种窗口尺寸通过，无浏览器异常、无模型请求。README 图片来自该目录 `chat-light.png`。
- `output/packaged-chat-fix-ybdC4W/report.json`：最终打包程序版本 0.1.31、隔离启动通过。
- `output/composer-ui-dKO84H/report.json`：最终打包输入栏、菜单、提及、重命名和独立滚动通过。
- `output/registration-lifecycle-oDBFH9/report.json`：最终打包退出暂停、队列保留、重开恢复且无脱离主程序 worker。
- `output/release-0.1.31/artifact-audit.json`：ASAR 中 48 个文件逐个核对当前源码（package.json 核对版本与打包入口），无用户数据、工作区和测试输出。
- `output/release-0.1.31/isolated-update.json`：基于本机准确 0.1.28 文件生成增量，在隔离副本实际重建 3 个程序文件并校验 SHA-256；聊天/工作区标记保留。

本地真实更新已完成：`D:/Agent Room` 的 `Agent Room.exe`、`resources/app.asar`、`Uninstall Agent Room.exe` 更新到 0.1.31，已重新启动。程序备份 `D:/Agent Room/.update-backup-0.1.28-a1d9a15d7f824b8aa24f68d55b070974`；数据与四个工作区完整备份位于 `output/release-0.1.31/user-backup/`，不入 Git。正式数据路径保持 `D:/agent room data`，4 位 Agent / 5 个会话仍可从安装版读取。替换后、首次启动前，全部 33 个数据文件及四个工作区目录与原校验清单一致；首次启动后已有聊天日志与工作区继续通过哈希校验。证据：`installed-update.json`、`installed-startup.json`。未发送聊天、未运行真实模型验收，未执行卸载。

本地产物：`dist/Agent-Room-Setup-0.1.31-x64.exe`、`dist/Agent-Room-Update-0.1.28-to-0.1.31-x64.zip`、`dist/SHA256SUMS-0.1.31.txt`。增量仅适用于文件匹配的 0.1.28。GitHub 本轮仅上传源码、文档与 README 演示图；不上传安装包或创建 Release。

### 2026-10-22 README 示例图替换

按用户明确要求，将 README 示例图替换为用户上传的实际使用截图，原样保存在 `docs/images/agent-room-multi-harness.png`，复制后 SHA-256 与上传文件一致。图片说明同步改为实际使用截图，展示 Codex、WorkBuddy AI、DSH、Qoder；不再称其为隔离演示数据。此轮仅更新文档和图片，不涉及程序、版本或本地数据。

## 2026-10-23：后续 harness 路线图、开放贡献与 GitHub 调研

按用户要求整理 16 项后续候选，第一批为 OpenCode、Qwen Code、Kimi Code CLI、GitHub Copilot CLI。所有候选保持待接入/调研状态，不改当前六个后端的实现或适配结论。`ROADMAP.md` 为计划入口，包含官方依据、Windows/WSL 和授权前提、优先级，以及统一注册、诊断/恢复、接力预算、上下文/附件等优化事项。注意 Kimi 旧仓库归档迁移，Gemini CLI 部分使用路径迁往 Antigravity，当前文档优先于旧生态目录。

新增 `CONTRIBUTING.md`、`docs/HARNESS_INTEGRATION.md`、harness 提案/Bug Issue 表单与 PR 模板；README 增加接入计划和贡献入口。协作方式为外部 Fork/PR、维护者审核合并，不授予未指定人员仓库写权限，不自动合并。GitHub 实时核对：仓库 public，允许 Fork，Issues 与三种 PR 合并方式已开启，无仓库级 interaction limit；本轮未修改访问权限、分支保护或自动合并设置。PR CI 仍是路线图待办，不能说已强制自动检查。

`docs/SIMILAR_PROJECTS.md` 对比六个一手仓库：agentchattr、Agent Chat / multi-agent-collaboration-mcp、AionUi、Claude Squad、Orchestrator.inc / agent-orchestrator、Superset。前两项直接接近共享聊天室，AionUi 同时有多 harness 桌面与团队协作，不能简单描述成多窗口聊天。记录 Superset 的 Elastic License 2.0 与其 README 所述 Windows 尚未提供，避免把所有相似仓库一概称为 MIT/Apache 开源。未安装或实测竞品；不宣称产品唯一或功能优劣已实测。

验证：`output/roadmap-2026-10-23/validation.json`，通过相对文件链接、Markdown 代码围栏、两份 Issue 表单及 config YAML/字段结构检查，确认 16 个候选和版本 0.1.31。此轮仅文档与 GitHub 模板，不运行模型、不重打包或改动本地安装；未重复运行运行时套件，不把以前 115 项结果当作本轮新测试。

## 2026-10-23：Agent 级共享记忆约定（规划，未实现）

用户明确要求按 Agent 隔离 memory：同一 Agent 在单聊、不同群聊中有权接收的内容，都应默认进入自己的同一份共享记忆，并可跨会话调用；不同 Agent 即使使用同一 harness，也各有独立工作区和 memory。群聊仍保留独立原生会话，用来区分当前上下文、消息路由与运行状态，不能用共享 CLI 会话替代记忆服务。

`ROADMAP.md` 新增设计说明与 P0 待办，`docs/HARNESS_INTEGRATION.md` 补充命名空间、来源、并发/去重、恢复和验收要求，`AGENTS.md` 同步后续实现约定。默认写入与检索仅针对该 Agent 有权收到的内容，私聊与匿名投票的既有输出边界继续保留。

当前 0.1.31 已有 Agent 稳定目录与按房间独立的原生会话，尚未实现统一 memory 的自动持久化及跨群检索。手动选择重复/嵌套工作区和旧数据共享目录回退仍需补强；不得直接搬动现有目录。本轮仅修正文档设计，不修改运行代码、版本或用户数据；检查文档差异与格式，不重复运行运行时测试。

## 2026-10-23 0.1.32：按 Agent 共享记忆与独立工作区

用户授权实现，并要求尽量避免真实额度。`lib/agent-memory.cjs` 由独立宿主共享，按稳定 Agent ID 的 SHA-256 分目录追加 JSONL；同一 Agent 的单聊/群聊消息及自身输出自动汇入，不同 Agent 不共用命名空间。启动时从现有 catalog 中各会话的旧日志幂等回填，不重写日志或工作区。新消息保存当时可接收的 Agent 快照，避免后续成员变化扩大历史归属。每轮按本地关键词、中文词片段和最近记录召回其他会话的片段，保留来源、时间和可见范围；不调用摘要或 embedding 模型，当前不是语义检索。

原生会话仍以 Agent×房间分开。显式私聊仅向不会扩大参与者范围的上下文召回；普通单聊内容可供同一 Agent 在群聊使用。原始投票工具结果和匿名个人选票不进入记忆。记忆失败时保留聊天，回复前重试保存，持续失败不派发生成。多房间写入在同一宿主内同步追加并 fsync，按房间/消息去重；重启、改名、换工作区后身份不变。删除群聊保留 Agent 记忆；删除 Agent 不自动删除磁盘记忆，新建同名 Agent 不继承旧身份。

`standalone/workspaces.cjs` 增加规范路径检查，新建/修改目录拒绝重复、嵌套、链接别名、应用与聊天数据目录。旧共享目录保留路径与内容，返回 workspaceIssue 并阻止相关 Agent 使用原生会话，用户可在设置选择独立目录；没有自动复制、搬动或删除旧工作区。Agent 设置新增“查看共享记忆”，支持搜索和来源展示；输出用文本节点，沿用主题与窄窗口布局。详情见 README、docs/PROMPTS.md 和 docs/HARNESS_INTEGRATION.md。

参考 agentchattr 固定快照 d775776a30e8 的实例身份代理、跨频道读取/游标设计；独立实现 Room 记忆，没有复制其代码、改用单个共享原生会话、按键注入或放宽工具权限。真实模型检查未执行；当前验证证明持久化、归属、检索片段与协议传递，不证明真实模型必然正确理解每条旧事实。

验证与产物：

- `output/tests-0.1.32.log`：126/126，0 失败、0 跳过。含本地记忆、HTTP/真实房间引擎、模拟 Claude CLI、并发与截断恢复、旧数据回填、跨单聊/群聊、同 harness 隔离、私聊范围、匿名投票、改名/换目录/重启和保存失败恢复。修正旧测试中默认启动 Codex 的入口与共享目录 fixture，均不调用真实模型。
- `output/playwright/appearance-12JtSm/report.json`：真实 Chrome、隔离 HTTP/SSE；原有主题/投票/历史/输入栏回归及记忆查看、来源、搜索、390px 通过。模型调用和浏览器异常均为 0；记忆截图同目录。
- `output/packaged-memory-61S46z/report.json`：最终 0.1.32 程序真实启动与重启，模拟旧历史回填并保持去重、身份与工作区路径，原聊天日志/工作文件 SHA-256 不变；记忆查看界面可用，无生成请求。
- `output/claude-packaged-6m9tcA/report.json`：最终 ASAR 的 Claude 桥接以模拟 CLI 运行，有/无系统 Node 的两种环境通过，未访问真实 Claude。
- `output/release-0.1.32/artifact-audit.json`：48 个源文件与最终 ASAR 一致，版本 0.1.32，无聊天/记忆/工作区/测试输出污染。只读当前本机程序核实基线为 0.1.31，生成匹配的增量；在工作区隔离副本实际应用，3 个目标程序文件校验一致，模拟 catalog/聊天/工作区文件保持原哈希。
- 完整安装包 `dist/Agent-Room-Setup-0.1.32-x64.exe`（102751575 字节）；增量 `dist/Agent-Room-Update-0.1.31-to-0.1.32-x64.zip`（347706 字节）；校验 `dist/SHA256SUMS-0.1.32.txt`。增量仅适用于文件匹配的 0.1.31，解压到安装目录外后使用 Update.cmd。

本轮没有替换真实安装、改写真实聊天/工作区、发起真实模型请求、执行 NSIS 安装/卸载或推送 GitHub。真实安装仍为已读取核对的 0.1.31。程序未新增签名/自动更新；生成与验收产物不能视为用户已升级。后续可在用户授权的升级步骤中沿用备份、精确基线与数据保留流程。

## 2026-10-23：0.1.32 GitHub 源码交付与特点说明

用户授权将当前 0.1.32 提交到 GitHub，并将 Agent 工作区分离作为项目特点。README 首页新增特点说明和对照表：不同 Agent 即使使用同一 harness 也分别使用工作区与 Room 记忆；同一 Agent 跨单聊/群聊保持目录和共享记忆，各房间仍使用独立原生会话。说明新目录冲突校验、旧目录与聊天保留，以及原生全局记忆尚需单独适配的边界。

本次源码交付包含已验证的记忆实现、工作区校验、设置中的记忆查看、回归与打包验证脚本，以及对应文档。运行时实现与前节 126/126、浏览器和打包验证所对应源码一致；本次特点文案不改变运行行为。发布目标为 `agents-chatroom/main`，仓库简介同步突出 per-agent workspaces 与 Room-managed memory。此前“未推送 GitHub”的表述属于发布前阶段记录，发布状态以远端实际提交为准。

仅提交源码、测试、脚本及文档；dist 安装包、增量包、output 验收材料、研究快照、聊天和 Agent 工作区均留在本地。本次不创建 GitHub Release，不替换本机安装，不调用真实模型。

## 2026-10-24 0.1.33：Codex / DSH Agent 多会话与输入布局

用户要求把每位 Agent 作为工作区入口，展开其历史会话并允许新增；随后明确第一版只做 Codex 和 DSH。已在独立应用实现：左侧 Agent 可展开/收起，会话列表支持新建、切换、重命名和置顶；首次消息自动生成新会话标题。旧单聊直接保留在所属 Agent 下，不搬动、重写历史或工作区。Agent 改名只同步旧默认标题，自定义/自动生成的会话标题不受影响；Agent 置顶与会话置顶分开。

数据继续使用 `kind: direct`、`agentIds: [agent.id]` 与独立房间 ID。新增 `/api/conversations` 仅创建索引；首次发送才打开原生会话。同一 Agent 的工作区和 Room 记忆共享，各单聊拥有独立原生上下文、日志与推理覆盖。`/api/conversation/title` 仅改标题，旧 `/api/conversation/rename` 保持 Agent/群聊命名语义。创建会话不启动 harness；未同步或导入原生 Codex/DSH 桌面里的其他聊天。

`composerAdapters` 按单聊 Agent.backend 路由：Codex 的工作区栏置于输入卡片底部，DSH 的工作区栏置于上方，模型/推理位于下方。复用文件/图片、提及、工具、发送和停止管线；点击模型或推理进入已有设置，模型仍固定到 Agent，推理选项经过真实后端目录校验。没有提供未接入的语音、插件或权限模式切换。群聊及其他 harness 使用原有通用布局。草稿与附件在当前窗口内按会话隔离，不承诺未发送内容跨重启保存。

打包复测发现桌面每次随机端口会使 localStorage 无法恢复选中状态，已使用 `data/ui-state.json` 保存当前会话、展开状态、Agent 最近会话；`GET/POST /api/ui-state` 过滤不存在的 Agent/房间和跨 Agent 引用，原子写入。存储失败提示用户但不阻止读取历史。会话 ID 跨重启复用仍遵循原有 Room 恢复机制，没有新增原生 resume 保证。

最终证据：

- `output/tests-0.1.33.log`：128/128，通过新建/浏览不启动原生会话、Codex/DSH 独立会话标识与共同 cwd、共享记忆归属、设置隔离、标题/置顶独立、导航状态跨端口保存、重启原日志字节保留及非法输入拒绝。推理使用模拟后端。
- `output/playwright/agent-sessions-pJnNFn/report.json`：真实 Chrome + 隔离 HTTP/SSE，草稿附件、搜索、创建/标题/置顶、有效推理设置、Codex/DSH 四种宽度与深浅主题通过。模型目录由 fixture 提供，无真实模型请求。
- `output/playwright/appearance-2qGwmR/report.json`：原有外观、群聊/匿名投票、历史、提及、共享记忆与五主题回归通过。
- `output/playwright/agent-sessions-bhzRBA/report.json`：最终 0.1.33 EXE，多个会话、布局、文件/草稿、重载与真实退出重启恢复通过；旧聊天日志和工作文件 SHA-256 不变，无生成请求。
- `output/composer-ui-qUJ8Gv/report.json`：最终 EXE 输入栏、工具键盘操作、提及、重命名与独立滚动通过。
- `output/packaged-memory-QZcIY7/report.json`：最终 EXE/ASAR，旧历史回填、跨会话记忆、去重、目录分配、原日志与工作文件保留通过，无真实模型请求。
- `output/release-0.1.33/artifact-audit.json`：48 个源码文件逐字节匹配 ASAR，另核对 package 版本和桌面入口，无用户数据污染；从准确 0.1.32 打包基线和只读核实的本机 0.1.31 各构建一份增量。两份增量均实际应用到隔离副本，3 个程序文件 SHA-256 匹配，模拟聊天/工作区文件保持原哈希。

产物：`dist/Agent-Room-Setup-0.1.33-x64.exe`（102755685 字节）、`dist/Agent-Room-Update-0.1.31-to-0.1.33-x64.zip`（349066 字节）、`dist/Agent-Room-Update-0.1.32-to-0.1.33-x64.zip`（228922 字节）、`dist/SHA256SUMS-0.1.33.txt`。增量包只适用对应精确基线；解压至安装目录外执行 Update.cmd。未替换用户真实安装、未运行 NSIS 安装/卸载、未请求真实模型、未提交或推送 GitHub。工作树中的源码和文档等待用户另行授权发布。

## 2026-10-24 0.1.34：微信风格界面与 agentschat 品牌

用户要求按所附微信截图调整 UI，并把项目名改为 agentschat。独立应用采用窄图标导航、紧凑会话列表、聊天区三栏结构；浅灰背景、绿色列表选中态、方形头像、绿色用户气泡与贴底输入区。导航实际连接全部聊天、Agents、群聊、历史搜索、后端管理和外观设置；均保留可访问名称。Codex / DSH 的工作区/模型/推理选项及会话展开、新建、切换、置顶保持可用，其他 harness 和群聊继续使用通用输入区。新增 `standalone/public/chat-layout.css` 作为主题感知的布局层，未修改现有私聊/匿名投票权限。

显示名称统一为 agentschat：HTML 标题、侧栏、欢迎页、Electron 窗口/菜单/关于、package.productName、安装包、新安装快捷方式与卸载显示名称；更新应用图标颜色。保留原 MIT 归属和上游地址。README 使用 `docs/images/agentschat-messenger.png` 隔离演示截图，明确说明不是真实模型回复；旧用户截图原样保留在折叠历史示例中，用户本轮上传的微信参考图没有复制或打包。

兼容边界：内部 npm 包名、DSH ModuleLoader 注册 ID、服务端导出名及 cordis patch specifier 必须一致，继续保留 `dsh-agent-room`，避免宿主丢弃客户端 bundle。产品显示名改为 agentschat，宿主集成身份保持兼容。保留 appId `com.mocias.agentroom`、程序文件名 `Agent Room.exe`、`%APPDATA%/Agent Room` 数据定位、环境变量、API/存储键、tab ID 和路由。旧快捷方式仍有效；增量升级不重写 Windows 快捷方式或卸载注册项文字。当前仓库目录与远端仓库名未改，开发验收阶段未推送 GitHub，后续交付见文末。

增量脚本支持 `agentschat-Setup-*` 的卸载程序来源，并根据旧安装实际注册文件名更新 `Uninstall Agent Room.exe` 或 `Uninstall agentschat.exe`。仍保留路径白名单、精确旧哈希、备份、回滚和工作区保护；NSIS 的保留宏未放宽。产品改名不自动搬动或清空数据。

最终验证：

- `output/tests-0.1.34.log`：130/130，含真实执行客户端 bundle 注册入口并核对 package/patch/服务端身份一致，以及新旧卸载程序文件名的实际增量应用和数据保留。
- `output/playwright/appearance-sjiTbl/report.json`：真实 Chrome + 隔离 HTTP/SSE；三栏相邻布局、agentschat 标题、导航过滤、五主题、匿名投票、历史/提及/记忆及四种宽度通过，无模型请求和浏览器异常。
- `output/playwright/agent-sessions-iMz70i/report.json`：新版布局的 Codex / DSH 多会话、推理设置、草稿/附件、主题与窄屏通过，模拟后端。
- `output/playwright/agent-sessions-g2u3db/report.json`：最终 0.1.34 EXE，核对 agentschat 窗口/应用/菜单名称、原数据定位、多会话、退出重启恢复以及旧日志和工作文件哈希不变；没有生成请求。
- `output/composer-ui-dmQkE5/report.json`：同一最终 UI 源码的打包工具栏、键盘、提及、重命名与独立滚动通过。之后的最终包仅恢复内部 package identity 并新增 productName，界面源码未变；最终包另经上述多会话检查。
- `output/packaged-memory-tocik5/report.json`：最终 EXE/ASAR，旧历史回填、共享记忆、重启去重和工作文件保留通过，无真实模型请求。
- `output/release-0.1.34/artifact-audit.json`：49 个源文件与最终 ASAR 一致，核对 productName=agentschat、name=dsh-agent-room、版本及桌面入口，无用户数据污染；0.1.31/0.1.32/0.1.33 三份精确增量分别实际应用到隔离副本，3 个程序文件校验一致，模拟聊天/工作区哈希不变。

产物：`dist/agentschat-Setup-0.1.34-x64.exe`（102758049 字节）、`dist/agentschat-Update-0.1.31-to-0.1.34-x64.zip`（388693 字节）、`dist/agentschat-Update-0.1.32-to-0.1.34-x64.zip`（388701 字节）、`dist/agentschat-Update-0.1.33-to-0.1.34-x64.zip`（388695 字节），校验见 `dist/SHA256SUMS-0.1.34.txt`。未替换真实安装、未执行 NSIS 安装/卸载、未调用真实模型；内部插件匹配检查不等于真实 DSH 插件加载验收。工作树包含此前未提交的 0.1.33 和本轮 0.1.34 变化。

## 2026-10-24：0.1.34 GitHub 源码交付

用户授权提交并推送当前实现至 `agents-chatroom/main`（https://github.com/mocias/agentschat）。推送前获取远端 main 并核对本地基线一致；交付包含 0.1.33 多会话功能、0.1.34 agentschat 显示名称与微信风格界面、回归脚本、兼容升级逻辑、隔离演示截图及文档。运行代码沿用上述 130 项与最终打包验收对应版本，本次整理交付说明不改变运行行为。

仅交付源码和仓库文档；安装包、增量包、测试输出、聊天记录、个人工作区、第三方依赖和用户微信参考截图不进入提交。不创建 GitHub Release，不更改远端仓库名称，不替换本机安装。前文“未推送”描述开发验收时状态，发布状态以远端 main 的提交记录为准。

## 2026-10-24：GitHub 仓库改名与本机 0.1.34 更新

用户明确授权 GitHub 仓库改名 agentschat、更新本地远端和文档链接，并更新本地安装。仓库从 `mocias/agents-chatroom` 改为 `mocias/agentschat`，仓库 ID 1421773944、main 分支、public 可见性和历史保留；改名前后 main 均从 5e69b33 继续。本地发布 remote 改名为 `agentschat`，fetch/push URL 为 `https://github.com/mocias/agentschat.git`，当前 master 的 upstream 为 `agentschat/main`；`origin` 仍是原上游 `mocias/dsh-agent-room`。源码目录和内部 npm/插件标识保持兼容。README、贡献/路线图、AGENTS、交接文档及 Issue 模板链接已同步；历史段落中的旧 remote 名保留为当时事实。

真实安装 `D:/Agent Room` 从准确 0.1.31 基线应用已有的 0.1.31→0.1.34 增量，替换 3 个程序文件，SHA-256 与已验收产物一致。程序备份：`D:/Agent Room/.update-backup-0.1.31-3365512644234e9bbdc5ee62e4dad4be`。数据和工作区备份：`output/local-update-0.1.34-7ngkR1/user-backup/`，共 34 个现存文件；备份逐文件校验一致。

启动前核对发现 DSH 登记回执 `desktop-sync/dsh.json` 的 `checkedAt` 仍被已运行的 DSH 桥接每 15 秒刷新，只有该时间字段变化，其余内容与备份一致；不能声称这一动态回执逐字节不变。正式数据路径保持 `D:/agent room data`，4 位 Agent、5 个会话的身份、模型、工作区路径、会话 ID/标题/成员保留。真实启动后 agentschat 窗口/菜单/版本正确，Codex 展开会话可用；退出后的旧聊天、附件和全部现存工作区文件校验保持一致。未发送模型请求或测试聊天。

升级前一个 DSH 工作区目录已经不存在，备份中明确记录缺失；升级和检查均未重建、还原或改变该路径。这个旧状态不算升级造成的数据丢失，也不代表该 DSH Agent 已验证可正常生成。需要后续由用户指定工作区后再继续验证。

桌面与开始菜单快捷方式先备份再改名为 agentschat，目标仍是 `D:/Agent Room/Agent Room.exe`；完成检查后重新启动，新窗口标题为 agentschat。未修改卸载注册项、安装根目录或其他应用。证据：`output/local-update-0.1.34-7ngkR1/prepare.json`、`installed-update.json`、`installed-startup.json`、`shortcuts.json`。本次运行代码未改，不重复 130 项套件；仅做文档链接核对、精确升级与真实启动/数据保留验收。前文“未改名/未替换正式安装”属于之前阶段，本节为最新状态。没有创建 GitHub Release 或上传个人数据、安装包。


## 2026-10-24：0.1.35 原生权限/预设与新会话输入区

修复选中 Agent 的内层按钮在悬停/聚焦时恢复灰底的问题；DSH 空会话使用上方工作区/预设、圆角输入卡片、底部权限和模型/推理的结构，Codex 独立显示默认/规划模式。权限、预设、推理均为真正可选的菜单，保存后更新后端配置；模型仍固定到 Agent。配置按会话保存，预设只在首条消息前可改，权限变更需空闲并释放旧运行态。新建原生会话默认只读；旧会话保持原行为，直到用户显式选择配置。

新增 standalone/session-controls.cjs 统一能力目录和校验；Codex 从 collaborationMode/list 与 configRequirements/read 读取当前模式和限制，并传递 sandbox/approvalPolicy/collaborationMode。DSH 使用 standalone/dsh-session-controls.cjs 与 dsh-session-pool.cjs，在本应用拥有的 ACP 进程挂载安装自带预设服务，临时认证桥接应用原生 agentPresets/permissionPresets；不编辑用户原生 profile。预设应用后验证回显并重新应用固定模型，失败阻断发送，不伪造成功。当前 DSH 标准、程序化工具、精简可用；cordis 缺依赖禁用，桌面自定义预设未导入。

lib/approval-requests.cjs 将权限请求绑定房间与随机请求 ID，界面仅允许一次或拒绝。原生工具标题/参数用于用户审阅，不能作为自动授权依据。回复结束、停止、释放、超时均清除请求；无效房间不能停止其他房间的确认。旧群聊与其他 harness 保持原权限规则。ACP/Codex 停止时显式释放管道，修复 Windows 原生能力探测完成后仍不退出的问题。

最终验证：133/133 回归；原生 ASAR 空会话 report 为 output/native-session-controls-cRsACK/report.json；最终打包 UI（真实目录、保存、重启、四种宽度）为 output/playwright/agent-sessions-sZz3Vu/report.json。全部无真实模型生成。53 个源码文件与 ASAR 一致，0.1.34→0.1.35 增量在隔离副本上验证，完整安装包/增量/校验清单在 dist。真实工具执行和 Codex 规划回复未验收，不能把能力目录与协议测试称为真实模型端到端验证。详细报告和限制见 DESKTOP_VALIDATION.md 最新节。

本机已更新到最终 0.1.35，真实启动确认名称/菜单/数据位置正常；当前为 4 位 Agent、6 个会话，39 个现存文件备份并验证保留。最终本机证据为 output/local-update-0.1.35-final-fZzto4/，初次 .34→.35 备份为 output/local-update-0.1.35-f2smOO/。用户原 dsh-1 工作区此前缺失，仍不重建；选择有效目录后才能读取原生配置。新增 README 隔离演示截图。此轮源码尚未提交或推送，GitHub 的已知最后交付仍为 356d4b7；不得把本地 0.1.35 当成已发布远端版本。


## 2026-10-28：0.1.36 Qoder 多会话与 ZCode 桌面账号

用户要求按现有 DSH/Codex 方案接入，并明确选择继续复用当前 ZCode 桌面账号。实现详情见 docs/ZCODE_QODER_INTEGRATION.md。

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
