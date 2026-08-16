# Agent Hub — 产品逻辑与开发方案

> 移动端连接并编排多个 AI coding agent（Devin / Codex / OpenCode / Claude Code），
> 基于 ACP（Agent Client Protocol）通信，支持多会话与 agent 群聊协作。

## 1. 背景与协议事实

- ACP：JSON-RPC 2.0 over stdio。Client 把 agent 作为子进程拉起，单连接支持多并发 session。
- 关键方法：
  - `initialize` / `authenticate` — 能力协商与鉴权
  - `session/new` · `session/load` · `session/prompt` · `session/cancel`
  - `session/update`（agent→client 通知）：message_chunk / thought_chunk / tool_call / tool_call_update / plan / available_commands
  - `session/request_permission`（agent→client 请求）：工具调用审批
  - client 侧能力：`fs/read_text_file` `fs/write_text_file` `terminal/*`
- Hub 已主动声明 ACP `fs.readTextFile` / `fs.writeTextFile` 能力，直接从协议层捕获 agent 文件写入，生成产物与事件记录。
- 各家支持现状：
  | Agent | 启动命令 | 备注 |
  |---|---|---|
  | Devin | `devin acp [--model opus]` | 官方支持；`devin auth login` 或 ACP `authenticate` |
  | Codex | `npx @agentclientprotocol/codex-acp` | 官方适配器；ChatGPT/API key/gateway 三种鉴权 |
  | OpenCode | `opencode acp` | 原生支持 |
  | Claude Code | `claude-code-acp` | Zed 社区适配器 |
  | Gemini CLI | `gemini --experimental-acp` | 首个 ACP 集成 |
- 约束 1：stdio 协议 → 手机不能直连，必须有 PC 侧网关。
- 约束 2：ACP 无 agent-to-agent 语义 → 群聊协作是应用层编排。

## 2. 产品逻辑

### 2.1 角色与实体

```text
Workspace（一台 PC 上一个 Hub 实例）
 ├── Agent 类型（devin / codex / opencode / claude-code，可扩展注册表）
 ├── Session（一个 ACP session = 一个独立对话上下文，绑定 cwd 和 agent 类型）
 ├── Room（群聊房间 = 若干 Session 的集合 + 路由规则）
 └── User（手机端用户，MVP 单用户）
```

### 2.2 核心使用场景

1. **多会话并行**：手机上一个列表展示同一台 PC 上的 N 个 Devin 会话，各自独立 cwd/任务，实时流式查看输出、工具调用、计划。
2. **远程审批**：agent 发起 `request_permission` → Hub 推到客户端 → 用户批准/拒绝/始终允许 → 回传 agent。
3. **产物与事件追踪**：通过 ACP `fs/write_text_file` 与 `tool_call_update` 自动记录文件操作；客户端可在产物面板预览/下载文件，在事件时间轴查看操作日志，并支持清空、删除、按类型过滤。
4. **群聊协作（Room）**：
   - 用户把多个 session 拉入一个房间；
   - 用户在群里发消息，按路由模式分发；
   - agent A 的产出可被注入为 agent B 的上下文（Hub 做摘要后转发）。

### 2.3 群聊路由模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `mention` | 只发给被 @ 的 agent | 精确指派 |
| `roundrobin` | 轮流作答 | 按顺序补充 |
| `parallel` | 全员并行，最后由汇总者整合 | 集思广益 |
| `pipeline` | 按固定顺序串行处理 | 编码 → 审查 → 测试 |
| `conductor` | 指定指挥家拆解任务为 JSON 工单并派发 | 复杂任务分工 |
| `debate` | 正方/反方辩论，裁判总结 | 方案对比 |
| `auto` | 自动选择模式 | 默认兜底 |

跨 agent 上下文注入策略（MVP 简化版）：Hub 维护每个 Room 的"共享黑板"（最近 K 条各 agent 的结论摘要），转发消息时作为前缀 context 附在 prompt 里。

### 2.4 消息渲染

ACP 的 `session/update` 直接映射为聊天 UI 气泡：
- `agent_message_chunk` → 流式文本气泡
- `agent_thought_chunk` → 可折叠"思考"块
- `tool_call` + `tool_call_update` → 工具卡片（kind 图标 + 状态：pending/running/done/failed）
- `plan` → 任务清单块
- `request_permission` → 审批卡片（按钮：允许一次/始终允许/拒绝）

非 ACP 的 Hub 状态同步：
- `session.artifact` / `room.artifact` → 产物面板刷新
- `session.update` / `room.update` → 事件时间轴刷新
- `room.flow` / `room.flowUpdate` → 编排进度面板

## 3. 系统架构

```text
┌─────────────────────────────┐         ┌─────────────────────────────────────┐
│  Android App (Compose)      │  WSS    │  PC: Agent Hub Daemon (Node.js/TS)  │
│  - 会话列表 / 聊天UI         │◄═══════►│  - WS Server (JSON-RPC 应用层协议)  │
│  - 群聊 Room                │  JSON   │  - SessionRegistry (session 生命周期)│
│  - 审批 / 产物 / 事件        │         │  - RoomManager (群聊路由 / 黑板 /   │
├─────────────────────────────┤         │    产物 / 事件)                     │
│  Desktop App (Tauri/React)  │         │  - SessionLedger (会话产物/事件账本) │
│  - Windows / Linux 客户端   │         │  - AcpAgent × N (每 worker 一个)    │
│                             │         │     │ stdio JSON-RPC (ACP)           │
└─────────────────────────────┘         │     ▼                                │
                                        │  devin acp · claude-code-acp         │
                                        │  codex-acp · opencode acp            │
                                        │  - FsBridge (fs/* client 能力)       │
                                        │  - TerminalBridge (terminal/* 能力)  │
                                        └─────────────────────────────────────┘
```

### 3.1 Hub 内部模块

- **AcpAgent**：封装一个 agent 子进程（spawn + stdio framing + JSON-RPC 收发 + 重连）以及对应的 WebSocket worker 连接。处理 ACP `session/update`、`tool_call`、`request_permission` 等。
- **SessionRegistry / SessionLedger**：sessionId → { agentType, cwd, status, historyRef }；独立的产物/事件账本，持久化到 SQLite，支持 `session/load` 恢复。
- **RoomManager**：Room 定义、8 种路由模式、共享黑板、产物/事件注册表、并发控制（同一 session 串行 prompt）。
- **RoomModeManager**：解析并执行 conductor / pipeline / parallel / debate / roundrobin 等模式的路由与进度同步。
- **PermissionProxy**：把 `session/request_permission` 转成 WS 消息推客户端，等待用户决定，带超时默认策略与 bypass 开关。
- **FsBridge / TerminalBridge**：在 PC 本地实现 ACP client 能力（文件读写、终端），路径白名单 + 项目根目录保护。
- **AuthManager**：托管各 agent 鉴权状态（devin auth login / ACP authenticate / env key）。

### 3.2 客户端 ↔ Hub 消息协议（应用层，非 ACP）

WebSocket JSON， envelopes：`{type, id, payload}`。

主要消息：
- `session.list` / `session.create {agentType, cwd, name}` / `session.delete`
- `prompt.send {sessionId|roomId, text, mentions[]}`
- `event.update {sessionId, update}`（透传 ACP session/update）
- `permission.request {sessionId, toolCall, options}` / `permission.respond {requestId, optionId}`
- `room.create {name, sessionIds, routeMode}` / `room.message`
- `session.artifacts` / `room.artifacts` / `file.get` / `file.delete` / `file.rename` / `session.file.list`
- `session.removeEvent` / `session.clearEvents` / `room.removeEvent` / `room.clearEvents`
- `room.blackboard` / `room.blackboard.remove` / `room.blackboard.clear`
- `room.flow` / `room.flowUpdate`
- `agent.registry`（Hub 上报本机可用 agent 类型及版本）

传输与网络：
- MVP：局域网直连 + mDNS 发现；远程用 Tailscale（零自建中继）。
- 认证：首次配对用 PC 端显示二维码（内含一次性 token + 地址），手机扫码绑定。

### 3.3 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| Hub | Node.js 20+ / TypeScript，`@agentclientprotocol/sdk` | 官方 SDK 覆盖协议细节；各家 agent 生态都在 npm |
| Hub 存储 | SQLite (better-sqlite3) | 单用户单机，免运维 |
| Android App | Kotlin + Jetpack Compose | 原生 Android，Material 3，与系统通知/权限深度集成 |
| Desktop App | Tauri 2 + React + TypeScript | 复用 WebSocket 协议与状态逻辑；Windows / Linux 双包 |
| 传输 | WebSocket（`ws`），TLS + token | 简单、双向、够实时；手机与桌面共用同一 Hub 后端 |
| 推送（后续） | APNs/FCM / ntfy | 客户端后台时的审批提醒 |

## 4. MVP 范围与里程碑

### 已实现
1. **Hub**：spawn `devin acp`，initialize/authenticate，多 session/room 管理，prompt/流式透传，权限代理，ACP `fs/*` 能力，SQLite 持久化，远程中继。
2. **Android App**：局域网/远程连接、会话与群聊列表、单聊/群聊流式 UI、审批卡片、产物与事件面板、文件树、历史搜索、系统通知。
3. **Desktop App**：Tauri 客户端，功能与 Android 端对齐（聊天、审批、产物、事件、设置）。
4. **群聊**：8 种模式（mention / roundrobin / parallel / pipeline / conductor / debate / auto + broadcast）、共享黑板、编排进度、产物/事件管理。
5. **产物与事件**：ACP `fs/write_text_file` 与 `tool_call_update` 自动捕获文件操作；产物支持预览/下载/删除，事件支持清空/按类型过滤/批量删除。

### 后续规划
- ~~M1~~ ✅ Hub 单机 CLI 版跑通 Devin ACP 全链路
- ~~M2~~ ✅ Android App 单聊 + 审批 + 群聊
- ~~M3~~ ✅ 群聊路由模式 + 共享黑板 + Conductor 编排
- ~~M4~~ ✅ 多 agent 注册表（devin / claude / codex / opencode / deepseek-harness）
- ~~M5~~ ✅ 远程中继（cloudflared / VPS / Tailscale）、桌面客户端
- 推送审批（FCM/ntfy/APNs）、命名隧道、iOS 客户端、多 PC 同步

## 5. 关键风险与对策

| 风险 | 对策 |
|---|---|
| ACP 各家实现成熟度不一（如 opencode 流式/plan 支持不全） | Hub 内做 capability 探测，UI 按能力降级；先 Devin 跑通 |
| 权限审批在移动端超时导致 agent 卡死 | 超时默认策略可配（拒绝/允许只读）；审批消息带剩余时间 |
| 群聊上下文污染/死循环（agent 互相 @） | 黑板只注入摘要而非全文；Conductor 模式限深度；Room 级轮次上限 |
| stdio 子进程崩溃/僵死 | AcpClient 心跳 + 自动重spawn + session 恢复（session/load） |
| 安全：客户端可操作 PC 文件/终端 | 配对 token + TLS；fs 白名单（项目根目录 / workspace / session cwd）；危险 tool kind（execute/delete）强制人工审批；`HUB_PERMISSION_BYPASS` 仅限本地可信环境 |

## 6. 目录建议（实现时）

```text
agent-hub/
├── hub/            # Node.js WebSocket 网关 + ACP client
│   ├── src/        # index, agent, room, room-modes, store, session-ledger ...
│   └── scripts/    # 验证脚本
├── android/        # Kotlin + Jetpack Compose App
│   └── app/src/main/java/com/agenthub/...
├── desktop/        # Tauri 2 + React + TypeScript 桌面客户端
│   ├── src/        # screens, hub store, client
│   └── src-tauri/  # Rust 后端、托盘、通知
├── deploy/         # VPS 自建中继部署套件（Caddy / Nginx + systemd + autossh）
└── docs/design.md
```
