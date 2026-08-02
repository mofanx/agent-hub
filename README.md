# Agent Hub

手机（Android）通过局域网连接 PC 上的 Devin（ACP 协议），远程创建会话、下发指令、流式查看输出、审批工具调用。

## 架构

```
                    ┌──> devin acp
Android App ──WS──> Hub (Node.js)
                    └──> claude-code-acp (npx @zed-industries/claude-code-acp)
```

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

# 开启远程中继（cloudflared 快速隧道，手机走蜂窝也能连）
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

环境变量：`HUB_PORT`（默认 8787）、`HUB_TOKEN`、`HUB_TUNNEL=1`（开隧道）、`HUB_DATA_DIR`（数据目录）、`DEVIN_BIN`、`CLAUDE_ACP_BIN/CLAUDE_ACP_ARGS`。
前提：`devin auth login` 已登录；远程隧道需 `cloudflared` 在 PATH。

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
3. **Tailscale**：PC/手机组网后直接填 Tailscale IP

App 连接界面支持保存多个配置档案（局域网/远程随意切换，点一下即连）。

### 2. 安装 App（Android 手机）

```bash
cd android
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

### 3. 连接

App 中输入 Hub IP、端口 8787、token（默认 dev-token）→ 新建会话（填 PC 上的工作目录绝对路径）→ 开始聊天。

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

## 验证（无手机时）

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
- 推送审批（FCM/ntfy）、命名隧道
