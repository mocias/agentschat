# ZCode 与 Qoder 接入（0.1.36）

2026-10-28。独立浏览器/桌面版的接入实现；不是标准 A2A，也不宣称旧 DSH 插件宿主已完整移植。

## 用户行为

四种后端 Codex、DSH、Qoder、ZCode 共享 Agent 多会话入口、会话命名/置顶、独立历史/草稿/附件、稳定工作区和按 Agent 隔离的 Room 记忆。浏览和新建空会话不生成模型回复。模型随 Agent 固定；推理档位按实际目录、按会话校验。

Qoder 复用安装自带 ACP Worker。按当前实际目录显示 `default`、`acceptEdits`、`auto`、`dontAsk`、`yolo`；默认逐次确认。`yolo` 需用户确认。原生策略不等同于 Codex 的 OS sandbox；不能将自动编辑描述成“只能写工作区”。

ZCode 桌面账号路径支持已核对的 Windows 3.16.3 / 内置 CLI 0.17.0。默认 `build`，只展示“逐次确认”。新版的 plan 是独立开关，旧 session snapshot 回显的是底层模式，因此不开放未经验证的规划切换。旧会话不自动迁移权限。

## 运行路径

`standalone/discovery.cjs` / `zcode.cjs` 识别桌面或官方 CLI。桌面入口由本应用的 Electron 启动无窗口 helper；打包版在 `desktop/main.cjs` 的早期分支进入 helper，尚未触碰用户 Room 数据目录或单实例逻辑。

`zcode-host-transport.cjs` 使用随机 loopback 端口和 256-bit 临时口令，解决 Windows GUI Electron 不能可靠继承 stdin 的问题。只有已认证的一个连接可用，停止关闭连接及 owned helper。口令仅经子进程环境传递，不传给 native Host 或工具进程。

`zcode-desktop-host.cjs` 从用户安装的 ASAR 加载原生 RPC，并启动 `zcode-host-worker.cjs`。worker 为自己的进程设置正确的原安装 resources 根后加载原生 Host；不修改或复制安装代码。当前桥接明确检查桌面版本和 RPC 导出结构，未知版本失败。

原生 Host 负责读取桌面账号、模型资格、刷新及请求授权。Room 不解密、复制或保存账号令牌；没有把账号额度换成个人 API Key。原生缓存、原生会话和账号服务仍由 ZCode 自己管理。

`lib/zcode-pool.cjs` 将原生 Host 的会话接口转成现有 pool 生命周期，独立提供启动、模型/推理校验、创建/释放会话、流式文本/推理/工具事件、停止和错误。直接指定官方 CLI 时仍可走其 stdio app-server；这条路径不能假定继承桌面账号。

共享房间可包含同一后端的不同 Agent，故 session 的工作目录以经过 Room 验证的 Agent 目录为准，随后按原生 session ID 绑定。当前上下文按会话隔离；长记忆仍使用既有 AgentMemoryStore。

审批从实际原生请求传入既有房间审批服务，只能允许一次或拒绝。ZCode 原生 `resolveInteraction` 命令回传选择，未知能力拒绝；若账号需要桌面验证，则提示回到原应用，不伪造验证结果。取消/结束/退出沿用 Room 审批清理。ZCode 终态绑定 inputId、turnId，避免旧事件结束下一轮。

## 验收入口和边界

- `npm test`：包含注册/发现许可、原生模式回显、一次性审批、不同会话、取消事件隔离以及认证 transport 测试。
- `node scripts/check-agent-sessions-ui.cjs`：四种后端、四种宽度、深浅主题、草稿/附件、重命名/置顶及恢复。`UI_PACKAGED=1` 使用最终 EXE。
- `node scripts/check-native-new-harnesses.cjs`：实际安装运行时；ZCode 使用本地模拟模型，不代表云模型成功。`ZCODE_HOST_FIXTURE=1` 走真实桌面 Host；`ZCODE_FIXTURE_TOOLS=1` 验证审批拒绝，`ZCODE_FIXTURE_ALLOW=1` 仅允许脚本生成的隔离测试文件，`ZCODE_FIXTURE_CANCEL=1` 检查取消及续聊。Qoder 云生成仅在 `LIVE_QODER=1` 开启。
- `node scripts/check-live-zcode.cjs`：明确真实账号检查；通过 `ZCODE_EXE` 选择安装，`ZCODE_MODEL` 明确所测模型，结果独立记录。没有失败后自动替换模型。
- `node scripts/check-live-new-harnesses-room.cjs`：真实 Qoder 与 ZCode 混合群，通过完整 HTTP/房间引擎检查各自回复和独立 session ID；桌面工作区登记在测试中禁用。

本轮已验证 Qoder CN 0.4.11 的原生 Worker（CLI 1.1.75-hotfix.1），以及 ZCode Start Plan 的 GLM-5.3-Flash。GLM-5.3 曾返回 `429 / 3009 model concurrency limit exceeded`；这是本次真实服务端结果，不表明其他模型/账号必定可用。

未专项验收：ZCode 原生桌面列表展示/历史导入、电脑操作、完整 MCP 投票、其他桌面版本/OS、完整 NSIS 安装/卸载。实际本机 0.1.35→0.1.36 增量更新与启动、数据保留已验证，见 HANDOFF.md 最新交付节。不能将本地模拟模型的通过描述成云模型回复。当前源码交付不含账号、聊天、安装运行时或 output；不自动推送或发布 GitHub。

## 上游依据

[Qoder ACP](https://docs.qoder.cn/cli/acp) 说明其结构化客户端入口；实际模式及模型仍以当前安装握手为准。[ZCode 官方源码](https://github.com/zai-org/ZCode) 提供独立 app-server 和桌面 Host，[配置说明](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/03-config.md) 区分模型配置与登录凭据。协议适配以本机安装实际行为和隔离测试为准，不能直接把最新 main 的接口当成本机已具备能力。
