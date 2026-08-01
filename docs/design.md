# Agent Hub — 产品逻辑与开发方案

> 移动端连接并编排多个 AI coding agent（Devin / Codex / OpenCode / Claude Code），
> 基于 ACP（Agent Client Protocol）通信，支持多会话与 agent 群聊协作。

## 1. 背景与协议事实

- ACP：JSON-RPC 2.0 over stdio。Client 把 agent 作为子进程拉起，单连接支持多并发 session。
- 关键方法：
  - `initialize` / `authenticate` — 能力协商与鉴权
  - `session/new` · `session/load` · `session/prompt` · `session/cancel`
  - `session/update`（agent→client 通知）：message_chunk / thought_chunk / tool_call / plan / available_commands
  - `session/request_permission`（agent→client 请求）：工具调用审批
  - client 侧能力：`fs/read_text_file` `fs/write_text_file` `terminal/*`
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
2. **远程审批**：agent 发起 `request_permission` → Hub 推到手机 → 用户批准/拒绝/始终允许 → 回传 agent。
3. **群聊协作（Room）**：
   - 用户把多个 session 拉入一个房间；
   - 用户在群里发消息，按路由模式分发；
   - agent A 的产出可被注入为 agent B 的上下文（Hub 做摘要后转发）。

### 2.3 群聊路由模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `@mention` | 只发给被 @ 的 agent | 精确指派（MVP 默认） |
| Broadcast | 发给全员，各自作答 | 头脑风暴 / 多方案对比 |
| Conductor | 指定 lead agent，由它拆任务、派发、汇总 | 复杂任务分工（V1.5） |

跨 agent 上下文注入策略（MVP 简化版）：Hub 维护每个 Room 的"共享黑板"（最近 K 条各 agent 的结论摘要），转发消息时作为前缀 context 附在 prompt 里。

### 2.4 消息渲染

ACP 的 `session/update` 直接映射为聊天 UI 气泡：
- `agent_message_chunk` → 流式文本气泡
- `agent_thought_chunk` → 可折叠"思考"块
- `tool_call` + `tool_call_update` → 工具卡片（kind 图标 + 状态：pending/running/done/failed）
- `plan` → 任务清单块
- `request_permission` → 审批卡片（按钮：允许一次/始终允许/拒绝）

## 3. 系统架构

```text
┌────────────────────────┐         ┌─────────────────────────────────────┐
│  Mobile App (Flutter)  │  WSS    │  PC: Agent Hub Daemon (Node.js/TS)  │
│  - 会话列表 / 聊天UI    │◄═══════►│  - WS Server (JSON 消息协议)          │
│  - 群聊 Room           │  JSON   │  - SessionRegistry (session 生命周期)│
│  - 审批推送             │         │  - RoomRouter (群聊路由/黑板)        │
└────────────────────────┘         │  - AcpClient × N (每 agent 子进程)   │
                                   │     │ stdio JSON-RPC (ACP)           │
                                   │     ▼                                │
                                   │  devin acp · codex-acp · opencode acp│
                                   │  - FsBridge (实现 fs/* client 能力)   │
                                   │  - TerminalBridge (terminal/* 能力)   │
                                   └─────────────────────────────────────┘
```

### 3.1 Hub 内部模块

- **AcpClient**：封装一个 agent 子进程（spawn + stdio  framing + JSON-RPC 收发 + 重连）。一个进程承载其全部 session（ACP 原生支持）；如需隔离也可一会话一进程。
- **SessionRegistry**：sessionId → { agentType, cwd, acpClientId, status, historyRef }，持久化到 SQLite，支持 `session/load` 恢复。
- **RoomRouter**：Room 定义、消息路由（mention/broadcast/conductor）、共享黑板、并发控制（同一 session 串行 prompt）。
- **PermissionProxy**：把 `session/request_permission` 转成 WS 消息推手机，等待用户决定，带超时默认策略。
- **FsBridge / TerminalBridge**：在 PC 本地实现 ACP client 能力（文件读写、终端），MVP 可直接放行 + 路径白名单。
- **AuthManager**：托管各 agent 鉴权状态（devin auth login / ACP authenticate / env key）。

### 3.2 手机 App ↔ Hub 消息协议（应用层，非 ACP）

WebSocket JSON， envelopes：`{type, id, payload}`。

主要消息：
- `session.list` / `session.create {agentType, cwd, name}` / `session.delete`
- `prompt.send {sessionId|roomId, text, mentions[]}`
- `event.update {sessionId, update}`（透传 ACP session/update）
- `permission.request {sessionId, toolCall, options}` / `permission.respond {requestId, optionId}`
- `room.create {name, sessionIds, routeMode}` / `room.message`
- `agent.registry`（Hub 上报本机可用 agent 类型及版本）

传输与网络：
- MVP：局域网直连 + mDNS 发现；远程用 Tailscale（零自建中继）。
- 认证：首次配对用 PC 端显示二维码（内含一次性 token + 地址），手机扫码绑定。

### 3.3 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| Hub | Node.js 20+ / TypeScript，`@agentclientprotocol/sdk` | 官方 SDK 覆盖协议细节；各家 agent 生态都在 npm |
| Hub 存储 | SQLite (better-sqlite3) | 单用户单机，免运维 |
| App | Flutter | 一套代码 iOS/Android；流式 UI 成熟 |
| 传输 | WebSocket（`ws`），TLS + token | 简单、双向、够实时 |
| 推送（后续） | APNs/FCM | App 后台时的审批提醒 |

## 4. MVP 范围与里程碑

### MVP（只做 Devin）
1. Hub：spawn `devin acp`，initialize/authenticate，多 session 管理，prompt/流式透传，权限代理，fs 能力（白名单根目录）。
2. App：扫码配对、会话列表、单聊流式 UI、审批卡片。
3. 群聊：Room + @mention 路由 + 共享黑板（最近 5 条摘要）。
4. 验收：手机上创建 2 个 Devin 会话 → 拉入群 → 一句话 @A 写接口、@B 写测试 → 两者并行执行，审批在手机上完成。

### 里程碑
- **M1（1~2 周）**：Hub 单机 CLI 版跑通 Devin ACP 全链路（无 App，先 curl/脚本验证）。
- **M2（2 周）**：App 单聊 + 审批。
- **M3（2 周）**：群聊 @mention + 黑板。
- **M4**：codex-acp / opencode 接入，agent 注册表抽象。
- **M5+**：Conductor 编排、远程中继、推送通知、多 PC。

## 5. 关键风险与对策

| 风险 | 对策 |
|---|---|
| ACP 各家实现成熟度不一（如 opencode 流式/plan 支持不全） | Hub 内做 capability 探测，UI 按能力降级；先 Devin 跑通 |
| 权限审批在移动端超时导致 agent 卡死 | 超时默认策略可配（拒绝/允许只读）；审批消息带剩余时间 |
| 群聊上下文污染/死循环（agent 互相 @） | 黑板只注入摘要而非全文；Conductor 模式限深度；Room 级轮次上限 |
| stdio 子进程崩溃/僵死 | AcpClient 心跳 + 自动重spawn + session 恢复（session/load） |
| 安全：手机可操作 PC 文件/终端 | 配对 token + TLS；fs 白名单；危险 tool kind（execute/delete）强制人工审批 |

## 6. 目录建议（实现时）

```text
agent-hub/
├── hub/            # Node.js 网关
│   ├── src/acp/    # AcpClient, framing
│   ├── src/core/   # SessionRegistry, RoomRouter, PermissionProxy
│   └── src/ws/     # WS server, 应用层协议
├── app/            # Flutter
└── docs/design.md
```
