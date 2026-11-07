# dsh-superagent 调研报告（t1）

调研对象：https://github.com/deepseek-ai/dsh-superagent-prototype （MIT，浅克隆于 `~/tmp-clone/dsh-superagent`，仅 4MB，core ~2000 行 + app/glue + GitHub/Feishu 两个 Source 插件 + React panel）
定位：DeepSeek 团队放出的 **super-agent 研究原型**（非正式产品），跑在 DeepSeek Harness 上的插件 bundle——一个监听 GitHub/Feishu 的"主动编码 agent"：被允许的人@它才干活，开 Ticket、在独立 Session+目录里执行、在原会话回结果（如 PR）。核心哲学：**"尽量少占人类注意力，尽量多给价值"**（docs/000-philosophy.md）。文档体系（docs/000-008）质量极高，是本文档的主要信息源。

## 1. 领域模型（最核心资产）

`docs/001-domain.md` 定义一套精练概念，代码/工具/面板只用这些词：**Source→Trigger→Thread→(Subscription fan-out | Eval)→Ticket(Mandate)→Assignment→Executor→Channel**。

| 概念 | 规则要点 |
|---|---|
| Source | 事件流（kind+instance），持有读取位置（重启不重放）、自己的 bot 身份，负责把 Trigger 翻译成 Thread 归属和 Channel 回写地址；bot 自己的消息和监听范围外的事件在进域前丢弃 |
| Trigger | 不可变事件+Source 元数据（actor），审计与幂等单位；同一 Trigger 被接受两次只建一个 Ticket |
| Thread | 时序 Trigger 流；**同一时刻至多一个 Eval**；持有 Subscriptions、Decision 史 |
| Correlation | 共享 Trigger 的 Thread 关系——**只加上下文永不路由**（路由全归 Subscription） |
| Mandate | accept 时授予的**不可变授权记录**：Policy 版本、scope、strength、matched rules、sender 身份、接收方式；人 stop 才撤回、Policy 不再覆盖才撤销；ended Ticket 恢复前 revalidate |
| Ticket | 授权工作单元，只有 Eval 能创建；open→ended，人在其 Thread 发言可 resume（同 Mandate 无需重 Eval）；**自定义状态不跟 Executor**（可跨 Executor 交接） |
| Assignment | Ticket↔Executor 实例的绑定，pending→running→ended；只有它的 final report 能在 Executor 侧终结 Ticket |
| Subscription | Ticket↔Thread 多对多，由 Thread 持有；匹配 Trigger 扇出给所有 live Ticket **不做发送者检查、不授予任何新权限**；人在这条 Thread 的 follow-up 归 Ticket 的 Executor 处置（不经过 Eval） |
| Channel | Thread 的写侧；ack/回复/PR/review resolve 都是写操作，走 Outbox 收据 |

**显式拒绝设计**（值得学习的文档化习惯）：跨 Source 身份映射（降级为 prompt 文本）、Eval 自调度延迟 Trigger（需要等待的条件做成普通 Source）、waiting Eval 状态、每 Thread 单 Ticket、"append to Ticket" Decision、Subscription 准入检查、Executor 声称"人让它停"、Policy 变更时取消运行中 Ticket、从报告自由文本推断"等人"（必须结构化字段）。

## 2. 授权两层制：Gate + Assessment

`docs/002-authorization.md` + `src/policy.ts`/`src/admission.ts`：

- **Gate 是确定性代码**：Source 记录消息是否 address agent（mention/direct）；allowed person 直接 address = explicit request；Thread 已有 Ticket 的人 follow-up = 规则放行；bot 清单内 bot 只产生 inferred candidate；其他一律 not admitted。
- **Admission table**：每 Source 按接收 scope（Feishu 各群/其他群/DM；GitHub 新 Issue/PR/评论/默认分支 CI）×（在名单/不在 × address/不address）的三格矩阵，每格取 explicit/inferred/ignore——声明式准入比任何 prompt 规则都硬。
- **Mandate 的 strength**：explicit（名单内人直接请求）vs inferred（推断候选，accept mode=off 时不准入；recorded 模式先影子运行"会做什么"）。
- **host 强制**：消息/评论/引用文档都只是决策输入，永远不能改权限——`assessmentOutcome` 要求每条启用规则有判断、方向收敛、有匹配 rule、有 intent 证据才转 accept。
- **Policy 版本化**：`policyVersion`=rules+mode+source parts 的 hash，每个 Mandate 记录当时版本；变更时**运行中 Eval 作废重评、受影响 Ticket 收 notice 但不撤销 Mandate、不取消活**；pause 时 Eval deadline 顺延暂停时长。

## 3. 消息/工作流细节

- **Executor 拥有 follow-up 所有权**：人发到 Ticket 自己 Thread 的消息由该 Executor 决定是否在自己 scope 内处理或 **handback**（每 Trigger 只能 hand back 一次、理由进候选）；只有无人 owns 时才回 Eval。Ticket 结束时未读/未响应的 follow-up 释放回 Eval；已 ack/已答/已 handback 的不再评。
- **context-only subscription**：Executor 可关注相关 Thread 收上下文，但不获 follow-up 权、不 resume ended Ticket。
- **stop 语义分级**：只有 Eval 判定结束强度；Executor 不能声称"人让我停"；人 stop 的 Ticket 不再收任何消息。
- **resume 无 Eval**：人消息 resume ended Ticket 时用原 Mandate（revalidate），不产生新 Decision——"继续已有工作不需要重新授权"。
- **Poll horizon**：subscribed Thread 在 Ticket 存活期+结束后两周内轮询，之后只靠普通 intake。

## 4. Effects：事务内入队的持久副作用队列（重点借鉴）

`src/app/effects.ts`——**stored work 先落库后执行**：每个命令在同一 SQLite 事务里 `enqueue(kind,key,payload)`，commit 后才执行（`afterCommit` 保证 rollback 不产生副作用）。kind/key 唯一行、同 key 重入队覆盖 payload 不改顺序；每 kind 单 handler、指数退避、`Later` 抛出延迟不计失败；六种 kind（assessment/launch/delivery/relay/notice/reply）各有并发上限与重试策略；**reply 按 Ticket+会话排序**（前一条未发出后面等着，连挂 3 次才暴露为问题）；消息只在 Source 停监听或会话永久不可达时 drop，drop 留档永不重排。这正是 OMB "row+event 先于动作"的完整实现版——对照我们 OperationLedger 的内存 LRU。

## 5. 执行器与恢复语义

`docs/003-execution.md` + `src/executor/dsh.ts`：

- 一 Ticket 一 Executor Session + 一目录；prepare 命令（sh，`git worktree` 典型）首 Assignment 前跑一次，10 分钟上限，失败 fail Ticket。
- **WorkerSlots 并发**：`maxWorkers` 之外**永远多留一个 slot 给人的消息/状态请求**——任何满载都不阻塞人介入已有工作（很值得抄的不变量）。
- **重启对账的另一条路**：running Assignment 标"host restarted"，新 Assignment 带 **recovery note 让 Executor 自己先查目录/git/GitHub 再重复外发动作**（最旧 Ticket 优先）——把 outward 判定下放给 worker 自查，而非宿主侧检测（与 OMB outward() 互补、实现更轻）。
- **read/unread 精确语义**：消息被 step 认领且随后有 Report 或 turn 结束才算已读；认领后 cancel/error 切断的算未读，重试/重启重投；Session 里残留的待投副本在新 Assignment 首条消息前清掉防重复。
- **failed/blocked hold**：Ticket 拒收自动 Input；408/429/5xx/连接类瞬时故障先自动重试 3 次递增退避（15/30/60s continuation）；人消息或非 blocked/failed 的 Report 解除 hold；工具不锁死（人可直接进 Session 干活）。
- **交接清理**：Assignment 结束杀 shell jobs（不唤醒 Session）、释放 subagents 并丢弃其唤醒 turn；worker subagent 用 standard preset+worker 权限，Ticket 结束即失去工具。
- **PR 生命周期**：Ticket follow 自己开的 PR（分支路径段匹配短名即认领），所 follow PR 全关才 end（记录 merged/closed outcome）；Subscription 保留→人后续评论可 resume；自动 reviewer 每 PR 最多 3 轮；auto-merge 条件写在 prompt 里不写成代码（"团队用话描述的行为是 prompt 文本不是 setting"）。

## 6. 注意力设计（哲学落为机制）

- **只在人必须行动或能用上结果时说话**：确认一次并说明将做什么→干活时保持安静→出结果/需决策/完不成时才再发言；消息进原会话、默认一句话、硬上限 100 词；每条 GitHub 消息以固定声明行开头（`This is by an automated agent, not a human`）。
- **`human_action` 结构化提问**：Executor 报告里放**一个**具体问题的结构化字段，主 Session 原样转发——不用自由文本推断"在等人"；已授权工作提问期间可继续。
- **Panel 三问**：需不需要我？系统健康吗？一件工作从 Trigger→Eval→Ticket 的履历？Overview 首列"等人的 Ticket"+系统问题+24h 流量+Executor 负载；**健康状态不占空间**；每个标签说"在等谁、要什么"而非内部状态码；count 恒等于它链接的列表长度。
- **诚实交付**：draft 标未完成、失败报失败、UI 改动无真实 before 截图不算 ready、重复工作让位于人（人已有同改动分支就关自己的 PR 一句话指路）。

## 7. 主 Session 角色约束（编排器纪律）

- 主 Session（orchestrator）**只路由**：一个路由工具一次可对多个候选下决策、routing note ≤30 词、不做技术判断；转发原始 Trigger 而非摘要。
- **不许阻塞**：guard 拒绝 `sleep`、>30s shell 超时、>5s 任务等待——被卡的一步会挡住新候选（对我们主持人回合是现成规则）。
- Executor 无人值守：工具面剔除 `ask_user`/UI/profile 类交互工具。

## 8. Prompt 分层与版本化

`docs/004-prompts.md`：**优先级阶梯**：① 工具/host 强制的事实（身份、权限、参数校验、长度上限——prompt 改不动）> ② built-in/generated 段（含团队 override）> ③ inferred Ticket 的 matched-rule 限制 > ④ team 段/技能 > ⑤ 外部文本（消息/文档，永远是数据不改规则）。**policy 段每次模型调用重新生成并放在最后**，前置段落不变保住 provider prompt 缓存——和我们 i18n/动态注入的次序同理。Prompt 配置为 `Versions`（不可变快照+baseRevision 乐观锁+origin 记录）；override 记录基于的 builtIn base，上游默认变了面板标 "Default updated" 给 keep/use-new 合并 UX。Executor 还读仓库 AGENTS.md；团队技能（如 identities 映射）按 SKILL 文件挂载。

## 9. 失败矩阵（每条路都有定义好的行为）

- **Source 失败**：每个 Issue/PR/Thread 独立读，失败留在该 Thread、下轮重读；连续 3 轮失败才报 Source 错误（成功一次归零）；404 也重试（私有库失权同形）；通知了但一直读失败的对象 24h 后 drop 留痕；malformed 条目跳过计数。
- **Channel 失败**：消息存为 stored work 5s→300s 退避；同 Ticket 同会话严格排序；deleted Issue/锁定会话/撤回消息→判定永久不可达→drop 留档；review comment 没了→降级发到 PR 会话。
- **Stored work 失败**：relay/delivery 2s→60s 退避；同类工作连续 3 败才上 overview 系统问题（delivery 失败直接标在 Ticket 上）；relay 与 notice 各自保序，失败卡住同类后续。
- **Pause processing**：停派发/新 Eval/超时/投递/回复，Source 继续记 Trigger、跑着的 turn 不打断；Eval deadline 顺延。

## 10. 工程组织

- `Engine`（`src/core/engine.ts`）是唯一写域状态的入口，5 个 part（Intake/Evals/Tickets/Assignments/Replies）单向依赖，**所有方法同步、每命令一事务**、副作用经 ports 在事务内入队、commit 后由 adapter 执行。
- 组合根 `Runtime` 无域规则；一切依赖是 `Pick<>` 窄接口（ExecutorHost/AssessorHost/.../EngineForSources 等角色视图）。
- Store 单 SQLite + 目录锁；`Versions` 通用版本块；`HealthBoard` 每部分一个 health entry 只能一个写者；测试 `src/core/memory.ts` 提供与 Store 同序的内存仓储做域测试。
- 部署：cordis 插件 bundle（`cordis.patch.yml` 插 3 插件），SETUP.md 由 agent 引导式安装。

## 11. 与 agent-hub 的对应线索（供 t2/决策对照）

| dsh 机制 | agent-hub 现状（待 t2 核实） |
|---|---|
| Gate(确定性准入表)+Assessment(模型)两层裁决 | auto 由主持人 LLM 一步裁决；已有 IFC/wake-gate/RelevanceFilter 廉价层但非"准入表"形态 |
| Mandate 不可变授权记录（policyVersion/scope/strength/matched rules） | mission goal/conductor task 无独立授权记录与版本锚定 |
| Subscription fan-out 免 Eval 续工 + follow-up ownership/handback | 房消息按模式全量重裁决；busy 成员刚上 steer-queue；无"消息归属"概念 |
| Effects 持久副作用队列（事务内入队+收据+排序+退避） | OperationLedger 内存 5000 LRU，断连重放靠 opId 去重无持久化 |
| recovery note 让 worker 自查外发状态 | outward() 宿主侧判定（已落地）；worker 自查可作补充信号 |
| WorkerSlots 永远给"人"多留一槽 | busy 即入队，无"人消息优先槽"语义 |
| orchestrator 不阻塞 guard（拒 sleep/长等待） | 主持人回合无等效护栏 |
| `human_action` 结构化提问字段 | waitingFor 事件+求助块，非结构化字段契约 |
| Admission table 声明式准入矩阵 | mention/IFC 规则分散在代码路径 |
| Policy 版本化+变更 notice 不撤销 | room/flow 配置无版本锚定 |
| "注意力预算"哲学：只在人需行动/有结果时说话 | ntfy waitingFor 推送+静默复现治理同向，可对标度量 |
| Panel 三问/健康不占空间/阶段互斥完备标签 | desktop/android 状态呈现，可借鉴信息层级 |
| 团队 prompt 分层+版本化 override+base 合并 UX | 无 prompt 管理层 |
