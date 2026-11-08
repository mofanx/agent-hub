# OpenMausBot 落地点决策文档（t3）

输入：`docs/openmausbot-research.md`（t1，OMB v0.1.140 调研）、t2 本仓现状调研、@3 独立复核修正、
`AGENTS.md` 与 `hub/src` 一手代码核对（2026-11-04）。

## 0. 现状基线（核对后修正）

t2 结论：hub = ACP 多 agent WS 网关（7 种群聊编排 + conductor 工单 + mission/scheduler +
可靠性不变量 + IFC + ntfy），desktop/android/deploy 三端配套。薄弱点：仅 ACP 协议、
无 SDK/webhook/插件、单用户 token、无原生 TLS/E2E（复核修正：nginx 边缘 TLS 已存在，
缺的是 hub 自身 TLS 与端到端加密）、LIKE 检索、无 Web 端、推送仅 ntfy、观测与 CI 门禁薄、
客户端巨型文件零测试。

任务书中"无 routines/记忆层/决策模型/审批分级"的表述经代码核对**部分过时**，实际基线：

| 维度 | 实际已有 |
|---|---|
| 定时例程 | `scheduler.ts`（daily/interval/once/cron）+ `mission-schedule.ts` 事件触发 + `wake-gate.ts` 廉价谓词层（fields/contains，不烧模型） |
| 审批 | `decision.ts` 决策卡 + `agent.ts` permission 透传 + once/task/always grant 登记 + `HUB_PERMISSION_BYPASS` 全局放行 + `HUB_ISOLATED_CHECKS` 管理员预设命令白名单（精确匹配 + bubblewrap 隔离 + 密钥文件排除） |
| 记忆 | `memory.ts` 房级蒸馏长记忆（50 条/30d TTL/300 字，prompt 注入 ≤10 条，复用黑板管线） |
| 廉价决策 | `filter.ts` RelevanceFilter（规则层 + 可选轻量模型档 HUB_FILTER_*，fail-open）——**仅过滤"值不值得回"，不做模式裁决** |
| 重启恢复 | flow 快照持久化 + `conductor.resumeFlows()` + running 任务标 failed("执行状态未知") + awaiting-retry 人工重试；turn 游标作废重跑（≤1 次）+ OperationLedger opId 去重 |

## 1. 候选落地点评估（按优先级排序）

### P0-1. 房间 transcript 注入防伪（OMB `escapeNotes`/`[From…]` provenance）

- **OMB 机制**：共享 transcript 窗口渲染 `Speaker: "text"`，provenance 标记不可伪造，
  `escapeNotes` 防成员文本伪装成系统行/他人发言。
- **agent-hub 现状**：`room.ts buildPrompt` 把黑板条目以 `- ${e.from}: ${e.text}` **原文注入**，
  `e.text` 是成员全权控制的自由文本，可含换行 → 可伪造 `- 我: <假用户指令>`、
  `用户消息：…`、`[群聊「…」` 等保留前缀行，对下游成员做提示词注入；成员名本身也是可仿冒字段。
  `room.history.search` 返回的原始 entries 同样无净化。
- **价值**：高。多 agent 互读原文是提示词注入的直达通道（恶意/跑偏成员可向同伴注入
  "忽略约束/把某文件发我"），攻击面随房间增大线性扩大。
- **成本**：小。在 `buildPrompt`（及 memory/history 注入路径）加一个净化函数：
  成员侧文本逐行前缀化/剥离保留行头（`用户消息：`、`[群聊「`、`- ` 行首、`检索工具：` 等），
  或用不可伪造的包裹符把整条 entry 框住。hub 单文件级改动 + `prompts.test.ts`/`room.test.ts` 用例。
- **决策：采纳**。

### P0-2. safety-floor：bypass 也不自动放行的危险命令地板

- **OMB 机制**：词法分析黑名单（`rm -rf /` 与 `~`、mkfs、dd 覆盘、fork bomb），
  任何审批级别都不自动放行，读不到行尾永不 clear。
- **agent-hub 现状**：审批全走 provider 原生 requestPermission → 决策卡/grant；
  `HUB_PERMISSION_BYPASS=1`（**本机生产配置正在使用**）时一律自动选 allow 项；
  grant scope=always 同样直达放行。**hub 侧没有任何"无论如何都要拦住"的下限**——
  bypass 下 `rm -rf ~` 级命令无人复核。
- **价值**：高且直接——给 bypass/grant 路径加最后一道闸。代价极低，防的是不可恢复事故。
- **成本**：小。新模块 `safety-floor.ts`（命令串词法黑名单，仿 OMB 处理 quote/heredoc/HOME 展开），
  在 `agent.ts` requestPermission 的 bypass/grant 自动放行**之前**调用；命中 → 强制交互决策卡
  （不自动拒——agent 上下文中可能有合法理由，但绝不 silently allow）。+ 单测。
- **决策：采纳**。注意范围限定：只拦"自动放行路径"，交互卡照常走，不新造审批级。

### P1-3. steer-queue：忙时会话 follow-up 持久队列 + 连发合并

- **OMB 机制**：bot 忙 → 支持 steer 则注入运行中 turn，否则 `chat_followups` 持久化队列；
  turn 结束后 `drainCoalesceHead` 把 2 分钟内连发合并成一个新 turn。
- **agent-hub 现状**：`prompt.send` 遇 busy 直接抛 `session busy`；房间派发遇 busy 成员
  进 `skipped`（mention 模式仅一条"忙碌中"提示，**用户消息实质上丢了**）。
  无队列、无 steer、无合并。
- **价值**：高。这是当前最伤 UX 的缺口——长任务期间用户每条消息都报错或静默丢弃。
- **成本**：中。ACP 无统一 steer 语义（各 CLI 能力不一，steer 注入暂缓）；
  落地队列+合并即可：`agent.ts` 增 per-session followUp FIFO（上限 + 容量策略），
  `finishTurn` 后 drain，窗口内多条合并为单 prompt（与 OMB 一致）；房间派发 busy 成员
  改为入队而非 skipped；与 `turnGuards` 的游标登记时点对齐（外发时才登记）。
- **决策：采纳（队列+合并）；steer 注入暂缓**（依赖 agent 端能力探测，无收益前不铺）。

### P1-4. 重启对账 `outward()`：无外发副作用的任务原地自动重跑

- **OMB 机制**：重启时 running 且无新子节点且 `outward()` 无外发副作用 → 原地重跑一次；
  已知外发 → `failed(interrupted)` 不重跑（防重复外发）；有子节点 → waiting。
- **agent-hub 现状**：保守一刀切——running 任务全标 `failed("执行状态未知")` +
  awaiting-retry 等人工"重试"（`conductor.ts` 恢复段，~L2850）。安全但每个重启都要人工捞单，
  本机 pm2 已重启 19 次。
- **价值**：高。把"可证无外发"与"状态未知"分开：前者自动续跑，后者维持人工。
  判定信号现成：该任务派发后房史无 assistant/过程卡步骤/ tool_call/artifact 记录
  （OperationLedger 与 history 即为事实源）。
- **成本**：中。`conductor.ts` 恢复路径：running 任务查 store/turnProcess 判定 outward，
  无外发 → 回 pending 由 `scheduleTasks` 重派（**限自动重跑 1 次**并打标防循环）；
  有外发 → 维持现状。+ 恢复用例测试。
- **决策：采纳**。只取 outward() 判定思想，不引入 OMB 的 Assignment 统一树（见 §3）。

### P1-5. decision-model：auto 模式的廉价裁决层

- **OMB 机制**：decision model（1.5s 预算、p≥0.6、`__everyone__` 选项、fail-open 回退
  lead、每决一行 ndjson 可回放 eval）。
- **agent-hub 现状**：auto 每条用户消息先烧一个**完整主持人 LLM 回合**做模式裁决
  （`handleAuto`→`buildAutoPrompt`→JSON 解析→多级兜底），再执行第二个回合。
  主持人忙时直接"忙碌中"空转。已有 `RelevanceFilter` 证明廉价层可行（规则 + 可选
  OpenAI-compat 轻量端点 + fail-open），但它只判"回不回"，不判"怎么编排"。
- **价值**：中高。砍掉一半的 auto 模式延迟与 token；主持人忙不再卡决策。
- **成本**：中偏大。新增 `decide.ts`：复用 `HUB_FILTER_*` 式轻量端点配置
  （新增 `HUB_DECIDE_*` 环境变量），输入成员花名册+消息，输出 `{mode, confidence}`；
  低置信/超时/未配置 → fail-open 走现有主持人决策。无参模式（self/mention/parallel/
  roundrobin）可直接执行；conductor 仍需主持人拆任务——廉价层只负"是否编排"分流也可接受。
  **必须**配 ndjson 决策日志 + 标注 fixture 回放评测（OMB 53 条的对应物），否则无验收依据。
- **决策：采纳（分两期：①日志+分流骨架 fail-open 上线，②标注集达标后逐步提高裁决占比）**。

### P2-6. routines/checks 免 AI 预检（精简版）

- **OMB 机制**：checks 纯代码每 tick 先读（cursor/judged-id 去重），无事不开 turn；
  需 AI 的攒批；cursor 只在答复被保留后推进；`{"quiet":true}`/`NOTHING NEW` 静默约定。
- **agent-hub 现状**：`scheduler.ts` 时间表触发**无条件**起 agent 回合；事件路径已有
  wake-gate 廉价谓词（等价于 checks 的门控思想，但只覆盖内部事件源）；
  无外部源 checks（calendar/mail——hub 本无连接器，越界）。
- **价值**：中。cron 型任务空跑即烧 turn，预检能省大头；但本仓定时任务密度尚低。
- **成本**：中小且能复用现成白名单——`ScheduledTask` 加 `precheckCheckId`，tick 时先跑
  `HUB_ISOLATED_CHECKS` 对应预设（bubblewrap runner 已存在），exit≠0 跳过并记一条 event；
  结果静默约定并入 silentRepro 的聚合路径。
- **决策：采纳精简版（precheckCheckId + 静默约定）；外部连接器 checks 不采纳**。

### P2-7. MEMORY.md 记忆层（预算+归档+journal+脱敏）

- **OMB 机制**：每 bot 工作区 MEMORY.md + topic 文件 + 日志，200 行/24KB 加载预算、
  超限归档 archive.md、凭据脱敏、journal 在工作区外防自改。
- **agent-hub 现状**：房级蒸馏记忆已存在（`memory.ts`，50 条/30d/300 字/注入 10 条）。
  缺的是**per-agent** 持久记忆、归档、脱敏保证、journal 防自改边界。
- **价值**：低。agent-hub 的 agent 是各自 cwd 下的本地 CLI——per-agent 记忆属于
  各 agent 工作区（AGENTS.md/skills/MEMORY.md 由 agent 自己维护，devin/claude 生态已有
  对应机制）。hub 再造一套记忆层会与房级蒸馏+agent 本地记忆三方重叠。
- **成本**：高（写权限边界、脱敏、归档、UI 展示都要新做），收益与现有层重叠。
- **决策：不采纳整套机制**。仅吸收一个微项：`memory.ts` 蒸馏写入前做近重复去重
  （AGENTS.md 观察指标已登记"蒸馏近重复堆积率"，顺手闭环）。

## 2. 决策汇总

| 候选 | 决策 | 理由一句话 | 落地状态（2026-11-07 基线） |
|---|---|---|---|
| transcript 防伪 escapeNotes | **采纳** | 原文注入=多 agent 注入直达通道，净化成本极小 | **已实施**（`c1e5e60`；独立 `sanitize.ts`，buildPrompt 全字段+prompts.ts 全模板；行分隔符含 U+2028/29/85/`\v`/`\f`；a.path/roomName/persona/displayName 同净化） |
| safety-floor | **采纳** | bypass=1 生产在用，缺"无条件下限" | **已实施**（`d2cc3e5`；`safety-floor.ts` 词法黑名单，bypass/grant 自动放行前挂钩+交互卡兜底） |
| steer-queue（队列+合并） | **采纳** | busy 丢消息是最痛 UX；steer 暂缓（ACP 无统一语义） | **已实施**（`d2cc3e5`+修复轮：房侧队列、外发才登记 turnGuard、队列持久化+重启 drain）。**已收口**：error/cancel 路径补 drain（onSessionCancelled/onPromptError+agent 层 catch/cancel）；双队列收口——编排路径 `queueIfBusy:false` 竞态变忙转房侧带 guard 队列（conductor 经 `setEnqueueFollowUp`），agent 层仅服务 session 直发；`:1357` 重复行已删；conductor busy 去早退改入队 |
| 重启对账 outward() | **采纳** | 现成信号可分"可证无外发→自动续跑"，免人工捞单 | **已实施**（保守兜底达标）。**已修边角**：author 匹配改 sessionId→三形态解析（裸名/`name (origin)`/`name·agent·origin` 前缀），消飞行中改名假阴性+带 store 负向 fixture；残余：SIGKILL 纯 tool 副作用物理盲区（dsh recovery note 已补第二道防线）；tool_call-only 回合重启后无持久迹，outward() 会判"可证无外发"而重派（L2 物理盲区，recovery note 为补偿层） |
| decision-model | **采纳（两期）** | auto 每消息省一个完整回合；须日志+标注集先行 | **一期已实施**（`decide.ts`：explicit/inferred/ignore 三档+enforce 闸门+DIRECT_MODES 白名单，默认 shadow 零行为变化；`decisions.ndjson` stateHash 不落原文；`decide-eval.ts` 回放骨架；`HUB_DECIDE_*` 环境变量） |
| routines 免 AI 预检 | **采纳精简版** | precheckCheckId 复用隔离检查白名单即够用 | **已实施**（`ScheduledTask.precheckCheckId`+tick 先跑 `HUB_ISOLATED_CHECKS` 预设 bubblewrap runner，非 exited_zero 跳过记 skipped 不开回合；task.create/update 校验预设存在） |
| MEMORY.md 层 | **不采纳** | per-agent 记忆归 agent 工作区；仅补近重复去重 | 不采纳；微项近重复去重**已实施+修正**（80% 公共前缀+分叉尾 ≤25 防脚手架误并；`memoryExtends` 命中存较长新文本不再吞修正） |

**交叉复核结论回写（2026-11-07）**：① turnGuard 入队时点缺陷（busy 入队静默覆盖在跑 turn 的 guard → 在跑输出误判 stale 作废 + 入队内容被执行两次）已**证实并修复**（房侧队列 + 外发才登记）；② outward "author 命名空间永远不匹配"高危断言已**证伪**——`name (` 前缀匹配覆盖 `name (origin)` 写入形态；③ 净化首轮残余面（auto boardText、conductor resultLines/upstreamLines、help 通道、artifact path、Unicode 行分隔符）已全部补齐；④ 在途未提交：mission v2（m.output 单写者语义）+ ntfy 提醒增强 + member display name 跨端。登记小项：`history.search` 返回原始 entries 无 untrusted 标注；§5 LIKE→FTS5 可作独立小项立项。

## 3. 暂缓 / 不采纳（其余 OMB 机制）

- **暂缓**：
  - *steer 注入*——依赖各 ACP CLI 能力探测，先落队列收益已覆盖。
  - *waits 条件等待（url/file/process/bot_idle）*——eventTrigger+wake-gate 已覆盖内部事件；
    外部条件轮询等真实需求出现再加（可挂在 scheduler 事件源白名单扩展上）。
  - *same-request 去重（shareAnswer）*——与 steer-queue 同区域，可做队列时的顺带项。
  - *room holds（@X stop 缓存）*、*Chief of Staff 谱系*、*quick-model turn-route*、
    *团队导出包*——有对应弱需求（model backends/quota 已部分覆盖），不阻塞。
- **不采纳**：
  - *Assignment 统一树大重构*——hub 已有 mission/flow/scheduler 三模型且各自带不变量与测试，
    改写为单 Assignment 是无收益大手术；只取 outward() 思想。
  - *bot MCP 回打工具面 + 统一工具列表 + typed refusal*——agent-hub 的 agent 是通用
    ACP CLI，无法像 OMB 自研 adapter 那样按 turn 注入 capability token 工具；结构性不适用。
  - *五级审批分级*——provider 原生 + 决策卡 once/task/always 已够用；只需 safety-floor 下限。
  - *Companion sidecar/配对/APNs、Boat 托管沙箱、usage-ledger/spend cap*——
    现有 gateway+ntfy、bubblewrap 隔离检查、quota.ts 已覆盖对应需求的实用子集；
    OMB 完整版属不同产品形态（托管/多设备/计费），与本仓定位不符。

## 4. 采纳项落地路线（全部落 `hub/`，desktop/android 非必需）

| 项 | 落点 | 大致改动面 |
|---|---|---|
| transcript 防伪 | `hub/src/room.ts`（buildPrompt 黑板/memory/history 注入路径）+ `prompts.ts` | 新增 sanitize 函数 ~80 行；保留行头清单常量；`room.test.ts`/`prompts.test.ts` 加伪造注入用例 |
| safety-floor | 新增 `hub/src/safety-floor.ts`；`agent.ts` requestPermission 在 bypass/grant 自动放行前挂钩 | 新模块 ~150 行词法黑名单；bypass/grant 命中前短路为强制交互卡；`safety-floor.test.ts` |
| steer-queue | `agent.ts`（per-session followUp FIFO + drain on finishTurn + coalesce 窗口）；`room-modes.ts` busy→入队替代 skipped；`index.ts` prompt.send | ~250 行；与 turnGuards 游标时点联动；`turn-governance.test.ts`/`room-modes` 测试补队列语义 |
| outward() | `conductor.ts` flow 恢复段 + `store.ts` 外发信号查询（房史 assistant/process/tool_call/artifact） | ~120 行判定 + autoRetried 防循环标记；恢复路径测试（模拟 running 无外发→自动重派） |
| decision-model | 新增 `hub/src/decide.ts`；`room-modes.ts handleAuto` 前置分流；`index.ts` env 配置 | ~200 行 + ndjson 日志 + `scripts/decide-eval.ts` 标注回放；阈值/fail-open 全量兜底现行路径 |
| routines 预检 | `scheduler.ts` ScheduledTask.precheckCheckId；`mission-schedule.ts` tick 挂钩；`index.ts` task.create 校验 | ~100 行；复用 isolatedChecks preset + bubblewrap runner；`mission-schedule.test.ts` 补用例 |
| memory 近重复去重 | `memory.ts` 蒸馏写入路径 | ~40 行；`memory.test.ts` 补用例 |

依赖关系：safety-floor、transcript 防伪、memory 去重互相独立可并行；
steer-queue 与 outward() 都动 turn/恢复路径，建议串行或同人；
decision-model 二期依赖一期日志积累。

## 5. t2 薄弱点中超出 OMB 候选的遗留项（登记，不在本文档决策范围）

仅 ACP 无 SDK/webhook、单用户 token、hub 无原生 TLS/E2E、LIKE 检索（可升 FTS5，
better-sqlite3 已在依赖中）、无 Web 端、推送仅 ntfy、观测与 CI 门禁薄、客户端零测试。
这些与 OMB 机制无直接对应，建议另行立项评估。

**已实施项已知限制（2026-11-08 演练实证）**：

- outward()：纯 tool_call 途中回合现由 `tool_actions` 表判定（已修 L2）；剩余盲区=
  无任何工具调用的纯思考回合（无迹可循，属物理下限，recovery note 兜底）。
- steer-queue/followUps：房侧队列持久化+重启 drain 已落地；但"不外发会话"（无
  prompt.done 事件的会话）队列 drain 依赖会话重连/agent 上线事件触发——消息延迟
  而非丢失（演练 C 项实证：session.resume 后队列投递）。
- recovery note：auto-resumed 任务重派 prompt 注入恢复提示，发送成功才消费；
  用户"重试"指令驱动的重派不带 note（人工确认即授权）。
