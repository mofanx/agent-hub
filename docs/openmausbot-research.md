# OpenMausBot 调研报告（t1）

调研对象：https://github.com/milind-soni/OpenMausBot （Apache-2.0，v0.1.140，浅克隆于 `~/tmp-clone/openmausbot`，386M，~1400 个 server TS 文件 + 大量测试）
定位："local-first 的 AI agent 团队聊天应用"——侧栏每个 bot 是真实 agent 进程（Claude/Codex/Grok 等本地 CLI），各有模型、人设、记忆、电脑、已连接应用。自称 Grok Bot 开源替代。

## 1. 整体架构

- **Harness server**（`server/`，`index.ts` ~1.6万行，纯 `node:http` 无框架）绑定 `127.0.0.1:8799`，拒绝非 loopback Host 头防 DNS rebinding。
- **双通道**：HTTP JSON API + 单条 `GET /api/events` SSE 流（`ServerFrame` union：`message/bot/group/runtime/notify/screen/config…`；`Last-Event-ID`/`?since=` 游标重放，4MB replay buffer 溢出则全量 snapshot，背压只丢 screen 帧）。WebSocket upgrade 由各路由认领（屏幕/浏览器 live view）。
- **客户端零 transport**：React 19 单 reducer store，`EventSource` 折叠 `ServerFrame` 进 state，发送走 HTTP。Electron 壳用 `utilityProcess` 起 server 子进程（借 `ELECTRON_RUN_AS_NODE`，1/2/4s 退避重启）。
- **数据全在 `~/.openmausbot`**：`config.json`(0600)、`messages.db`（node:sqlite WAL）、`runtime.db`（assignments/assignment_events/inbox）、每线程规范事件日志 `events/<tid>.ndjson`、影子 git `checkpoints/`。
- **Companion sidecar**：唯一离机监听面（`:8810` 已配对设备 + `:8811` loopback 配对口），mDNS 发现；QR/6位码配对，token 只存 SHA-256，路由白名单默认拒绝。
- **远程三选一**：`--tunnel`（托管 cloudflared + 控制面 Worker）、`--domain`（pinned Caddy + LE）、`--tailscale`（`tailscale serve`）。闭屏推送 = Cloudflare Worker 中继打 APNs，payload 只含 `{title,kind,botId,threadId}` 无正文。

## 2. Agent 接入（drivers + ACP）

- `contracts.ts` 抽象 `ProviderDriver→ProviderInstance→Adapter`；`harness/registry.ts` 启动探测各 CLI、失败降级 unavailable 不拖垮 fleet；`harness/bus.ts` EventBus 统一 `RuntimeEvent`→NDJSON 日志→SSE 扇出。
- Claude=双向 stream-json 每线程一常驻进程；Codex=app-server JSON-RPC；**ACP 子驱动**（`server/drivers/acp/`）共享 `core.ts/host.ts`，支持 cline/copilot/cursor/deepseek/droid/gemini/grok/hermes/kimi/opencode-go/qwen/custom 等十余 CLI，`AcpLink` 一进程多 session 复用。另有 openai-compat/ollama/openrouter 等纯 API 驱动。
- **bot 工具面是 MCP 回打**：派发给 agent 的 `agents` MCP server 经 env 注入 `OMB_HARNESS_URL/BOT_ID/COMMS_TOKEN`，工具回打 `/api/internal/*`（per-turn capability token）；Composio/HighLevel/browser/computer/phone 同理。

## 3. 消息/回合流

- 发送幂等（sendId + `SendSequencer`）→ `admission.ts` 纯函数裁决 start/queue/steer/refuse（surface 分 direct/room/unattended 等）。
- **bot 忙**：引擎支持 steer → `adapter.steer()` 注入运行中 turn；否则进 `steer-queue`（持久化 `chat_followups` 表），turn 完成后 `drainCoalesceHead` 合并 2 分钟内连发再起新 turn。
- **waits 条件等待**：bot 可登记 `url_contains/file_exists/process_running/bot_idle`（perBot≤10），5s tick 探测触发后注入新 turn——主动唤醒。
- **quick model**：`turn-route.ts` 把简单消息路由到同 provider 快速模型/降 effort。

## 4. 房间（多人多 bot 群聊）

- `defaultResponder` 四模式：`member`(固定 lead)/`everyone`/`mentions`/`auto`。auto 用 **decision model**（Jev 或 OpenRouter Decisions API，`server/decider/`）：每成员以"名字+头衔+描述"为选项，1.5s 预算、p≥0.6 才采纳、**fail-open 回退 lead**；`__everyone__` 选项覆盖"多人一起答"；每决一行 ndjson 日志可回放 eval（53 条标注 fixture）。
- **房内串行**：一时刻一 speaker（`groupSpeakers`/`busyBotId`/`RoomMemberLock`），消息排队；每成员保留各自 engine session，`RoomContextTracker` 跟踪 token 超 0.9 窗口触发 compact。
- **互感知 = 共享 transcript 窗口**：最近 ≤30 行渲染 `Speaker: "text"`（`[From…]` 防伪 provenance + `escapeNotes`）注入下一回合；另有 `peer-roster` 花名册 + `coordinate_bots`/`post_to_room` 工具。
- **room holds**："@X stop" 可 hold 成员，期间消息缓存 ≤20 条，release 时统一注入。
- **Chief of Staff**：人的单点联系人，经 `coordinate_bots` 向队友派工（Assignment 树），审批级沿 Chief 谱系下传只升不降。

## 5. Job runtime（`server/runtime/`，核心亮点）

一份 `Assignment` 记录统一一切派工（人/房间/routine/webhook/外部 runtime）：

- **树**：`rootId/parentId/depth`，`origin`（person/routine/outside）写到 root 沿树下传；`mode` = work/consult/notify；`reply` = resume/poll/none。
- **生命周期**：`queued→running→(waiting|needs_input)→resume→completed|failed|cancelled`，sqlite 存 `assignments` + append-only `assignment_events` 审计 + `inbox` 唤醒道，每状态变化一个事务先写行和事件再动作。
- **Admission 统一规则**：host 实现 `canStart`；`validate` 每次派发+每 tick 复查，权限中途关闭即 `failed(refused)` 并丢弃其产出。
- **同请求去重**：另一 requester 恰好问过同 bot 相同请求（规范化后 ≥40 字符）→ 共享一份答案（`same-request.ts` + `shareAnswer`）。
- **子问题中断等待**：waiting 节点因子代 `needs_input` 被 resume 一次，把问题带上跑一圈；Full 权限下 requester 可代替人回答（`decide` 默认值兜底）。
- **三时钟**：queueMs / stallMs(根级停滞) / turnStallMs(单回合,monotonic 防睡眠误判)；等人不设时钟。三根预算 requests/executions/wakes 随 durable progress 续。
- **重启对账**：running 且无新子节点且 `outward()` 无外发副作用 → 原地重跑一次；已知外发 → `failed(interrupted)` 不重跑（防重复外发）；有子节点 → waiting；needs_input 保持不重复发卡。
- **10 条不变量**用 scenario suite 断言（I1-I10：无孤儿、结果恰好一次投递、绝不假称 approved、事件可重建状态、重跑至多一次…）。
- **统一工具面**：所有可派工 turn 拿同一份工具列表（`coordinate_bots`/`assignment_status`/`raise_escalation`/`usage_limits`/`list_bots`/`start_thread`/`post_to_room`…），byte-for-byte 相同保 provider prompt 缓存；无权时调用返回 typed refusal。

## 6. Routines 主动例程

- `RoutineManager`：schedule 五型（once/daily/interval/cron/limit_reset，cron 必带 IANA 时区）；进程内 due-timer，**app 不跑不派发**（桌面端 wakeHold 阻止休眠、Cloud 按 CHECK_WAKE_MS 睡眠唤醒）。
- **checks 免 AI 预检**：`calendar/mail/runs` 纯代码每 tick 先读（cursor/judged-id 去重），无事不开 turn；需 AI 的条目攒一次批处理 run，**cursor 只在答复被保留后才推进**，失败重读。
- **结果回聊天**：`automation-reports.ts` 独立隐藏会话执行，结果以自动化名义落结果会话；`{"quiet":true}`/`NOTHING NEW` 静默约定；`deliver:"brief"` 产出小 JSON 喂每日简报卡。
- **恢复**：stall 重试、崩溃拾取、usage limit 换备胎引擎、15min→4h 指数退避、24h 上限 24 次 AI run；catch-up 12h 合并。
- 内置"Keep an eye on my day"routine = checks + quiet JSON + read-and-draft 受限访问级（只读邮件/日历、每线程一封草稿、服务端拒一切写）+ brief 卡的组合样板。

## 7. 云电脑/沙箱

- **Boat**（boat.dev 托管沙箱）：每 bot 一 Linux 桌面，TTL 8h，创建/删除幂等 + 崩溃 journal。
- **BYO VPS**：只凭 SSH，`docker -H ssh://` 直驱远端 daemon，每 bot 一加固 Cua 容器（无端口发布、drop caps、私有 ns），不存密钥只存 ssh alias，容器指纹校验不过不复用。
- **Local VM**：本机 Podman/Docker 跑同一 Cua 容器。
- **Cloud home 共享电脑**：用户的 Mac/PC 出借给自己 Cloud——scope 白名单（folders/terminal/computer/internet/chrome），桌面端长轮询 lease 10s 取 job，写文件先读校验 hash、≤256KiB、永不删除、不写敏感目录；**永不借 terminal**（除非显式开）。bot 缺能力时发 computer-ask 卡一键开。
- **bot-box**：Cloud 上引擎进程跑 unprivileged bubblewrap（只读镜像、loopback-only + egress 代理门拒内网/元数据地址 + 只通 `/api/internal/`）；broker 把真 API key 换 per-turn `omb_t0_` token，盒子拿不到凭据。
- 屏幕回传：容器内截图→Pillow 缩 1280 JPEG→per-turn 最新帧缓存；人控制时隐私门停截图；noVNC viewer 绑 loopback 随机口供接管。

## 8. 连接器与凭据

- 第三方应用走 **Composio**：OAuth 一次，工具经 MCP 桥 `/api/internal/connectors/mcp`；`connector-verdict` 服务端判决——解析 tools/call 帧、拆批量调用、按 per-bot grant `{service:{tools:"*"|["NAME"]}}` 过滤，**未识别形状一律拒绝**。
- App 事件自动化：broker 25s 长轮询事件，id 去重、ack cursor 在 run 保存后推进、15min 对账自愈。
- 凭据：`secret-vault` 内存一次性 `secret-ref:`（绑 bot+会话、1h TTL、用后即焚）或工作区 0700 文件夹 24h；引擎 per-turn bearer；HighLevel 等 token AES-256-GCM 落盘 0600。

## 9. 技能库与团队共享

- 技能=SKILL.md（≤32KB）存 bot 工作区，落地即关；自动学习 = 后台 skill review（步数计数→交付后 replay 审核→≤3 处修改，创建需批准）。
- 分享 `shareLearnedSkills: off|ask|auto`，**audience 收窄不变量**：技能只能流向不比学习处更宽的队友。
- 团队导出 `openmaus.package` v2：bot 人设/技能/playbook/群聊/routine(到达即暂停)/Chief/MCP 连接(剥密钥)/起始 MEMORY.md；**永不带**聊天记录、凭据、模型、电脑。导入增量且默认收紧（技能关、routine 停、bot 默认 Ask）。
- 组织库：Admin 分发包 SHA-256 校验、双 hash 三方合并自动升级、`withdrawnReleases` 一键下架。

## 10. 记忆与 profile

- `~/.openmausbot/workspaces/<botId>/MEMORY.md` + `memory/<topic>.md` + `memory/log/YYYY-MM-DD.md`，0600 原子写、凭据脱敏（`«redacted N chars»`）。
- 加载预算 200 行/24KB 硬截断（gauge 可视化），超限时最旧 dated 条目移 `archive.md`；topic 索引 ≤40 条随系统提示。
- 召回：每 turn 前消息检索 topic 文件+会话片段（≤4+4、6000 字符，注入消息体）；capture 静默 2min/6 turn 后小模型提取（偏好须带原文 quote）；每日 upkeep 归档/去重/标 superseded 不删；journal NDJSON 在 workspace **外**防 bot 自改、可一键 Undo。
- profile：About-me 全员可读画像，被删事实按 identity 永不再学；Team memory 走 admin 审核 + 乐观锁。

## 11. 审批与安全

- 五级 `ask/edits/auto/full/custom`，全部 provider 原生权限透传；Chief 委派级别只升不降；`isEmergencyApprovalDowngrade` 运行中可降级。
- `auto-approve` 只在明确授权时自问自答（Full、保存的精确命令、MCP 只读、读自己文件）。
- 命令白名单 ≤200 条 `{command,cwd,providerInstanceId}` 精确三元组，含凭据禁存、不解析符号链接防漂移。
- **safety-floor**：任何级别都不自动放行的黑名单（rm -rf / 与 home、mkfs、dd 覆盘、fork bomb），自建词法分析（quote/heredoc/HOME 替换），读不到行尾永不 clear。

## 12. 桌面/手机/中继/发版

- Electron 三块自包含（main/preload、dist UI、dist-server），原生负载全在 ASAR 外（cloudflared/cua-driver 钉 digest、Chrome for Testing、duckdb、adb）。
- 更新：electron-updater vendored，feed=GitHub release latest*.yml；mac 签名+公证+staple，Windows per-user 未签名静默升级，deb 用 pkexec+apt（校验 SHA-512），AppImage 原地替换。
- 手机：原生 iOS app（私有仓库）+ PWA；推送=Worker 中继 APNs（无 ntfy/WebPush）。`server/phones/` 反向：手机作为 bot 工具（注册 pushToken/capabilities，20s 长轮询取 job，lease 认领回交）。
- standalone-releases：桌面无 Node 时装引擎（仅 OpenCode，逐平台钉 archive+可执行 SHA-256+字节数+Team ID，禁自更新）。

## 13. 用量与限额

- usage-ledger：append-only JSONL `usage/YYYY-MM.jsonl`（trigger 区分 user/owner/routine/bot/helper），聚合导出 CSV 防公式注入。
- spend：月 USD cap（enterprise entitlement），409 `spend_cap`；warn 80% 告警去重。
- plan-usage：直接读引擎 CLI 登录态打各家用量端点（Anthropic oauth/usage、ChatGPT wham/usage、Grok billing），45s 缓存。
- quota-switch：turn 因 quota/签出失败自动切备胎引擎重发（能力校验+probe 超时+可关）；quick-model-fallback 对被拒模型持久化拉黑。

## 14. 与 agent-hub 的对应线索（供 t2/决策对照）

| OMB 机制 | agent-hub 现状（待 t2 核实） |
|---|---|
| Assignment runtime：统一记录+事件审计+inbox 唤醒+重启对账 outward() | conductor/flow + OperationLedger(opId 去重) + turn 游标作废重跑 |
| decision model（便宜分类器选 speaker，p≥0.6 fail-open） | auto 模式由主持人 LLM buildAutoPrompt 决策，无快速低成本裁决 |
| steer-queue：bot 忙时注入运行 turn / 合并 2min 连发 | turn 排队与 cancel 治理 |
| waits 条件等待（url/file/process/bot_idle） | 无对应机制 |
| routines：checks 免 AI 预检、quiet JSON、cursor 提交后推进、退避上限 | 无定时例程体系 |
| 命令白名单精确三元组 + safety-floor 词法分析 | 无审批分级体系（agent 自带） |
| 记忆 MEMORY.md 预算+归档+journal+凭据脱敏 | 无 agent 记忆层 |
| 团队导出包（人设/技能/playbook/routine，剥密钥默认收紧） | 无团队打包导入 |
| SSE replay buffer + notify kinds + 已读同步 | ntfy 离线推送 + waitingFor 深链（已实证大半） |
| ACP 多 session 复用（AcpLink draining/retired） | ACP fs 能力 + agent.status 错误条 |
| 手机 PWA/原生 app + 配对 + APNs | Android Kotlin app + ntfy |
