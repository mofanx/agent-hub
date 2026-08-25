# Agent Hub

Android App / Desktop App 通过局域网或远程连接 PC 上的 Devin（ACP 协议），远程创建会话、下发指令、流式查看输出、审批工具调用。

## 架构

```
                    ┌─> worker ──> devin acp
Android App ──WS──> Hub (Node.js) ──WS──> worker ──> claude-code-acp
Desktop App ──WS──>   ▲              └─> worker ──> codex-acp
                    └─> worker ──> opencode acp

                    ┌─> devin acp
Hub ──WS(multiplex)──> multiplex-worker ──┼─> opencode acp
                    └─> claude acp
```

- **Hub**：常驻 Node.js WebSocket 网关，管理连接、会话、群聊编排与持久化。
- **Worker**：在运行 agent 的机器上执行 `npx tsx src/worker.ts`，把本地 agent 的 ACP stdio 桥接到 Hub。
- **Multiplex Worker**：执行 `npx tsx src/multiplex-worker.ts`，一条 WebSocket 连接复用多个本地 agent，适合多 agent 机器（详见下文）。
- **Android App**：通过 `HUB_TOKEN` 连接 Hub，管理连接、创建会话、下发 prompt、审批工具调用。
- **Desktop App**：Tauri + React 桌面客户端，功能与 Android 端对齐，支持 Windows / Linux。

Hub 内置多 agent 注册表，群聊可混编不同类型的 agent 会话。

## Agent 类型

| 类型 | 命令 | 前提 |
|------|------|------|
| `devin` | `devin acp` | `devin auth login` |
| `claude` | `npx -y @zed-industries/claude-code-acp` | `npm i -g @anthropic-ai/claude-code` 且 `claude auth login` |
| `codex` | `npx -y @zed-industries/codex-acp` | `npm i -g @openai/codex` 且 `codex login` |
| `opencode` | `opencode acp` | `npm i -g opencode-ai`（如已有模型配置可直接用） |

四种 agent 的会话可混编进同一个群。新增类型只需在 `AGENT_DEFS` 加一行。

## 快速开始

### 1. 启动 Hub（PC 上）

**临时运行**

```bash
cd hub
HUB_TOKEN=dev-token npx tsx src/index.ts
# 输出: [hub] phone connect: ws://192.168.x.x:8787/?token=dev-token

# 开启远程中继（cloudflared 快速隧道，客户端走蜂窝/公网也能连）
HUB_TUNNEL=1 npx tsx src/index.ts
# 输出: [tunnel] remote connect: wss://xxx.trycloudflare.com/?token=dev-token
```

**PM2 常驻（推荐，适合长期挂机）**

项目根目录已提供 `ecosystem.config.cjs.example` 模板：

```bash
# 1. 安装 pm2（如未安装）
npm i -g pm2

# 2. 从模板复制本地配置，并修改 HUB_TOKEN
#    公网部署务必改成强随机串，例如：
#    openssl rand -hex 24
cp ecosystem.config.cjs.example ecosystem.config.cjs

# 3. 启动并常驻
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

PM2 会自动处理崩溃重启、内存超限重启、日志滚动。查看运行状态：`pm2 logs agent-hub`。

**修改代码后统一重启：**

```bash
# 代码更新后使用 pm2 restart 重载，不要直接再跑 npx tsx
pm2 restart agent-hub

# 常用运维
pm2 logs agent-hub -f
pm2 monit
pm2 save
```

Hub 环境变量：`HUB_PORT`（默认 8787）、`HUB_TOKEN`、`HUB_TUNNEL=1`（开隧道）、`HUB_DATA_DIR`（数据目录）、`HUB_PERMISSION_BYPASS=1`（自动通过工具调用，仅本地可信环境）。
前提：`devin auth login` 已登录；远程隧道需 `cloudflared` 在 PATH。

### 2. 安装 App（Android 手机）

```bash
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

### 3. 安装桌面客户端（Windows / Linux，可选）

```bash
cd desktop
pnpm install
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`（MSI / NSIS / AppImage / deb）。运行后同样填入 Hub 地址和 token 即可连接。

### 4. 添加连接并复制 token

打开 App，**连接**页填入 Hub IP、端口 `8787`、token `dev-token`（即 `HUB_TOKEN`）。

连接成功后进入 **设置 → Agent 来源**，点击**添加来源**：

- 输入名称、选择 Agent 类型。
- token 选择**自动生成**或**手动填写**；自动生成会在创建后显示在列表中。
- 点击创建后，在来源列表右侧点击**复制图标**，把 `CONNECTION_TOKEN` 复制到剪贴板。

> 这个 token 是给 worker 用的，不是 App 连接 Hub 的 `HUB_TOKEN`。

### 5. 启动 Worker（运行 agent 的机器上）

worker 负责把本地 agent（`devin` / `claude` / `codex` / `opencode`）桥接到 Hub。必须**在 `hub/` 目录下**启动，因为依赖 `hub/node_modules`。

```bash
cd /path/to/agent-hub/hub
HUB_URL=ws://<hub-ip>:8787/worker \
  CONNECTION_TOKEN=<从 App 复制的 token> \
  AGENT=devin \
  npx tsx src/worker.ts
```

说明：

- `HUB_URL`：填 Hub 的 IP 和端口（局域网 IP 或远程地址），路径必须是 `/worker`。
- `CONNECTION_TOKEN`：App 中为该来源生成的 token（**不是** App 连接 Hub 用的 `dev-token`）。
- `AGENT`：支持 `devin`（默认）、`claude`、`codex`、`opencode`，对应的 agent 需要在该机器上安装并登录。
- worker 和 agent 运行在同一台机器上；可以在多台机器分别启动多个 worker，每台对应 App 里的一个连接。
- **不要**在项目根目录执行 `npx tsx worker.js` 或 `npx tsx hub/src/worker.ts`；根目录没有 `tsx` 等依赖，`npx` 会重新下载一个孤立的 tsx，找不到 `worker.ts` 也会找不到 `ws` 等包。

worker 环境变量：`HUB_URL`、`CONNECTION_TOKEN`、`AGENT`、`DEVIN_BIN`、`CLAUDE_ACP_BIN/CLAUDE_ACP_ARGS`、`CODEX_ACP_BIN/CODEX_ACP_ARGS`、`OPENCODE_BIN/OPENCODE_ARGS`。

### 5b. 启动 Multiplex Worker（单连接复用多 agent，可选）

上面的普通 worker 一个进程只桥接一个 agent。如果一台机器上同时跑了多个 agent（如 devin + opencode + claude），可以用 **multiplex worker** 把它们合并到一条 WebSocket 连接里，只需一个 token、一个进程：

```
                    ┌─> devin acp
Hub ──WS(multiplex)──> multiplex-worker ──┼─> opencode acp
                    └─> claude acp
```

Hub 会为每个 agent 自动创建虚拟 connection（ID 格式 `<base>::<agent>`，如 `local-devin::opencode`），客户端像使用独立 connection 一样创建会话、发 prompt。

**启动命令：**

```bash
cd /path/to/agent-hub/hub
HUB_URL=ws://<hub-ip>:8787/worker \
  CONNECTION_TOKEN=<从 App 复制的 token> \
  npx tsx src/multiplex-worker.ts
```

不设置 `AGENTS` 时，worker 自动检测本地 PATH 中哪些 agent CLI 可用，只启动检测到的。也可以显式指定：

```bash
# 只启动 devin 和 opencode
AGENTS=devin,opencode npx tsx src/multiplex-worker.ts

# 自动检测但排除 codex
EXCLUDE_AGENTS=codex npx tsx src/multiplex-worker.ts
```

**环境变量：**

| 变量 | 必填 | 说明 |
|------|------|------|
| `HUB_URL` | 是 | Hub 的 WebSocket 地址，路径必须是 `/worker` |
| `CONNECTION_TOKEN` | 是 | App 中为来源生成的 token |
| `AGENTS` | 否 | 要启动的 agent 列表，逗号分隔；不设置则自动检测 |
| `EXCLUDE_AGENTS` | 否 | 要排除的 agent，逗号分隔 |

**自动检测规则：**

| Agent | 检测方式 | 前提 |
|-------|---------|------|
| `devin` | `command -v devin` | `devin auth login` |
| `opencode` | `command -v opencode` | `npm i -g opencode-ai` |
| `claude` | `npx -y`（视为可用） | `claude auth login` |
| `codex` | `npx -y`（视为可用） | `codex login` |

查看完整帮助：`npx tsx src/multiplex-worker.ts --help`

> **与普通 worker 的关系**：multiplex worker 是普通 worker 的超集——如果只检测到一个 agent，效果等同于普通 worker。两种 worker 可以混用（不同机器各跑各的），但同一台机器上同一 agent 不要同时跑两种 worker，会重复注册。

### 6. 创建会话/群聊

worker 上线后，回到 App：

- **新建会话**：选择已在线的来源（connection），填写工作目录，开始聊天。
- **新建群聊**：勾选多个会话，混编多个 worker/agent。

## 产物与事件

- **产物面板**：实时显示 agent 创建/修改的文件，支持引用、预览、下载、删除、清空
- **事件时间轴**：自动记录文件新增/修改/删除/重命名、工具调用等关键动作
- **ACP fs 能力捕获**：Hub 通过 `fs/write_text_file`、`fs/read_text_file` 标准 ACP 能力直接感知文件写入
- **tool_call 捕获**：解析 `session/update` 中的 `tool_call` / `tool_call_update`，记录 edit/delete/move/execute 类事件
- 事件支持按类型清空、批量删除、单独删除，安卓与桌面端均已同步

## 持久化与历史

- 元数据 + 聊天记录存于 SQLite（`hub/data/hub.db`，WAL 模式），Hub 重启自动恢复（离线状态展示）
- 首次启动自动从旧版 `state.json` / `history/*.jsonl` 迁移
- 历史按会话/群分 scope 存储，带索引，默认拉取最近 200 条
- 离线会话点「恢复」：优先 `session/resume`，不支持则回退 `session/load`（Devin 实测可用，历史上下文完整恢复）
- 长按会话：归档（折叠到「已归档」区，可恢复）或删除（连历史一起清，所在群自动移除该成员）
- 列表页顶部搜索框：跨会话/群全文搜索历史，点结果直达对应聊天
- **角色系统**：内置 6 个角色（通用助手/后端/前端/代码审查/产品/测试），可自定义；建会话选角色后自动注入设定 prompt 作为首条消息，角色可携带默认工作目录和 agent 类型
- **本地通知**：App 退后台后，回复完成 / 审批请求会发系统通知（两个渠道），点击回到 App
- **会话置顶**：长按会话置顶，钉在最前
- **常用目录**：建会话自动收集最近工作目录，目录字段下拉一键选择
- **快捷指令**：输入框旁闪电按钮，内置 3 条模板，可把当前输入存为自定义指令
- 建会话对话框的角色/Agent 为收纳式下拉选择，扩展不破坏布局

## 远程接入

三种方式（详见 `deploy/README.md`）：

1. **cloudflared 快速隧道**：`HUB_TUNNEL=1` 启动即可，零配置，地址每次变化
2. **自建 VPS + 域名**：`deploy/` 内含 Caddy / Nginx 配置 + systemd unit（Hub 常驻 + autossh 反向隧道），固定 `wss://hub.你的域名`
3. **Tailscale**：PC/客户端组网后直接填 Tailscale IP

App 连接界面支持保存多个配置档案（局域网/远程随意切换，点一下即连）。

## 群聊

会话列表页点「建群」，勾选 ≥2 个会话创建群聊。两种模式：

**普通群（mention）**
- `@名字` → 只派给该成员（输入 @ 会弹出成员补全，点选即可）
- 不 @ 任何人 → 广播给全体成员

**指挥家群（conductor）**
- 建群时指定一个成员当指挥家
- 不 @ 任何人的消息 → 指挥家拆解任务输出派工单（JSON）→ Hub 自动派发给成员并行执行 → 全部完成后回指挥家汇总
- `@成员` 的消息 → **绕过指挥家**直达该成员（带共享黑板上下文），随时可单聊
- 派工/完成/汇总等编排事件以系统消息显示在群里

**协作辅助**
- 每个 agent 收到的 prompt 自动附带「共享黑板」（其他成员最近输出摘要）
- 长按消息气泡可「引用」，引用内容随消息注入目标成员的上下文
- 执行中可点「停止」中断当前会话（群内所有忙碌成员）
- 群聊中发送 `/stop` 可停止当前群内所有生成；`/stop @成员` 只停止指定成员

## 验证（无实体设备时）

```bash
cd hub
npx tsx scripts/m1-check.ts        # 单会话 prompt 全链路
npx tsx scripts/room-check.ts      # 群聊 @路由 + 黑板协作
npx tsx scripts/conductor-check.ts # 指挥家拆解-派工-汇总全流程
npx tsx scripts/bypass-check.ts    # 指挥家群 @直达绕过编排
npx tsx scripts/claude-check.ts    # claude-code-acp 会话（需先 claude auth login）
```

## 目录

- `hub/` — Node.js 网关（WS 服务 + ACP client + 权限代理 + SQLite 持久化）
- `android/` — Kotlin + Jetpack Compose App
- `desktop/` — Tauri 桌面客户端（Windows / Linux）
- `deploy/` — VPS 自建中继部署套件（Caddy / Nginx + systemd + autossh）
- `docs/design.md` — 完整产品设计（含群聊编排规划）

## MVP 之外（后续）

- ~~群聊 Room（多 agent @mention / 广播）~~ ✅ 已实现
- ~~指挥家（Conductor）编排模式 + @直达~~ ✅ 已实现
- ~~@补全、消息引用、停止按钮~~ ✅ 已实现
- ~~多 agent 注册表 + claude-code-acp 接入~~ ✅ 已实现（待登录验证）
- ~~codex / opencode 接入~~ ✅ 已实现（opencode 已全链路验证；codex 待 `codex login`）
- ~~会话持久化 + 历史记录 + 离线恢复~~ ✅ 已实现
- ~~远程中继（cloudflared 隧道 + VPS 自建）~~ ✅ 已实现
- ~~会话归档/删除 + 历史全文搜索~~ ✅ 已实现
- ~~桌面客户端（Tauri / Windows / Linux）~~ ✅ 已实现
- ~~产物/事件面板 + 文件操作捕获~~ ✅ 已实现
- 推送审批（FCM/ntfy）、命名隧道
