# dsh-superagent 落地方案（t4）

输入：`docs/dsh-superagent-research.md`（t1，11 节调研）、`docs/openmausbot-landing-decision.md`（前次决策口径）、
t2 刷新基线（OMB 采纳项 5/7 已落地：sanitize 扩面/safety-floor/steer-queue 含持久化+重启 drain/outward()/memory 去重；
decision-model 与 routines 预检未实施；残留：error/cancel 不 drain、agent 层双队列、LIKE、单用户等）、
当前在途 mission v2 重构（m.output 单写者语义，conductor.ts:225 区段 +70 行，**不触 ~2850 恢复段**）。

评估原则：dsh 是"监听外部源的主动 agent"，agent-hub 是"人驱动房内编排的网关"——域不同，
只取**机制思想**不取源接入形态；凡与已落地 OMB 项同向的，只补不重建。

## 1. 候选结合点评估（按优先级）

### P1-1. recovery note：worker 自查外发副作用（补 outward() 盲区）— 采纳

- **dsh 机制**：running Assignment 重启后标 "host restarted"，新 Assignment 的 prompt 带
  recovery note，让 **Executor 自己先查目录/git/GitHub 再决定重发**——outward 判定下放给
  最了解现场的一方。
- **agent-hub 现状**：outward() 宿主侧判定已落地但有两个已知盲区：author 命名空间错配
  （conductor.ts:2861-2873，待修）+ 纯 tool 回合副作用无持久迹（SIGKILL 物理上限）。
  两个盲区都使"有外发"误判为"无外发"→ 自动重派。
- **价值**：高。给自动重派加**第二道独立防线**——即使宿主判定漏网，worker 自查也能
  拦截重复外发；成本极低且与 outward() 修复完全正交。
- **成本**：小。auto-resumed 任务（`t.autoRetried===true`）重派 prompt 前插一段
  恢复提示：「上次执行被 Hub 重启打断，先检查工作区已完成的外发副作用（文件改动/
  命令效果/已发输出），勿重复已生效动作，再继续任务」。conductor 派发路径挂 note 即可。
- **决策：采纳**。

### P1-2. orchestrator 不阻塞护栏：deciding 回合短超时 — 采纳精简版

- **dsh 机制**：guard 拒绝主 Session sleep/>30s shell/>5s 等待——编排器卡住会挡住全部新候选。
- **agent-hub 现状**：auto 决策回合走普通 prompt 路径，ACK watchdog 统一 180s
  （agent.ts:236 `HUB_PROMPT_ACK_TIMEOUT_MS`）；超时后 fail-open 兜底 self 已有
  （onPromptError autoCtx 分支）。缺的是**决策回合专用短预算**——主持人卡死时用户
  要等 3 分钟才兜底。
- **价值**：中。纯延迟改善，一行配置级收益。
- **成本**：小。watchdog 时长参数化（promptContent 增加可选 timeoutMs 或 per-session
  override），handleAuto 决策 prompt 用 `HUB_AUTO_DECIDE_TIMEOUT_MS`（默认 ~30s）。
  不实现"禁工具"级护栏——agent 是通用 CLI，host 无法限制其工具面，只能用时间预算兜底。
- **决策：采纳精简版**。

### P2-3. Effects 持久副作用队列 — 暂缓（分片已覆盖，登记 invariant + 触发条件）

- **dsh 机制**：stored work 与状态变更同事务入队，commit 后执行；kind/key 幂等、
  按类排序、退避、drop 留档。
- **agent-hub 现状**：外发副作用是**分片耐久**而非统一队列——history 表=事实源、
  flow 快照+followUps 已入 runtime export、turnGuard/opId 内存（重跑语义已定义）、
  persistState 500ms 防抖+exit flush。真实遗留缺口只剩：未发的 ntfy/通知（易失、
  可接受——下个事件会再触发）与 SIGKILL 窗口 ≤500ms 状态损失。
- **价值**：中低。统一框架能消的是已被分片覆盖的需求；剩余真实缺口小且低风险。
- **成本**：大（通用 stored-work 表+按类 handler+排序/退避语义+恢复扫描）。
- **决策：暂缓**。落地两条轻量沉淀代替框架：① 在 AGENTS.md/代码注释登记不变量
  「新外发副作用类型必须先有可恢复记录再执行」；② 触发条件——当出现**不可重推
  且需保证送达**的hub外发类（如 webhook、外部副作用 API）时按 dsh 形态立项。
  对照：OperationLedger 是"防重复"面，Effects 是"保送达"面，两者不冲突。

### P2-4. Gate+Assessment 两层裁决 / Admission table — 暂缓（并入 decision-model 立项）

- **dsh 机制**：确定性准入表（Source×scope×addressed 三格→explicit/inferred/ignore）
  先于任何模型；Assessment 只对 inferred 候选跑；strength 记入授权。
- **agent-hub 现状**：多层漏斗已事实存在但分散——mention 的 @ 规则（deterministic）、
  IFC 房级读写门、RelevanceFilter（chatter/relevant 廉价层）、wake-gate 事件谓词、
  然后才是主持人 LLM 一步裁决。缺的不是层而是**声明式形态**与 strength 记录。
- **价值**：中。把散规则收敛成一张可读准入矩阵+记录 decision strength 有审计价值；
  但与已立项 decision-model（廉价裁决+fail-open+置信度）是同一片土地——先单独立项
  会造两套"决定要不要起 LLM"的逻辑。
- **成本**：中。
- **决策：暂缓**，并入 decision-model 一期一起设计：cheap 层输出直接按
  explicit(确定性规则命中)/inferred(模型判)/ignore 三档建模，决策日志带 strength——
  等于用 dsh 的两层词汇实现已采纳项，不新造机制。
- **Admission table 本体**：hub 无外部 Source 多样性（消息源=用户+内部事件），
  矩阵化收益低——**不采纳**，待出现连接器类源再评。

### P2-5. Subscription 扇出免裁决续工 + follow-up ownership/handback — 部分已有，剩余暂缓

- **dsh 机制**：Ticket 订阅 Thread，匹配消息直接扇出给 owner Executor（免 Eval）；
  follow-up 归 owner 处置，handback 仅一次。
- **agent-hub 现状**：`extractHelpRequest` 结构化求助块 + `taskSubs` 订阅链
  （worker→worker 定向问答不经过模式重裁决）已覆盖核心语义；房消息每次过
  relevanceFilter+模式裁决是**刻意的**——用户在 hub 里是主权方，每句都该能改道编排。
- **价值**：低。剩余缺口≈"worker 对非求助类后续消息的ownership"，hub 的 worker
  只在被点名/派发时说话，场景稀薄。
- **决策：暂缓**；待出现"worker 常驻续工"类需求（如长任务多轮跟进）再取
  handback/ownership 细化。

### P2-6. 人优先槽 — 暂缓（降级为 drain 次序微项）

- **dsh 机制**：maxWorkers 之外永远多留一槽给人的消息/状态请求——满载不阻塞人介入。
- **agent-hub 现状**：无 worker 槽概念（成员=session，一 session 一回合）；
  人消息 busy 时进 followUps 队尾，与编排派发的排队消息混排。
- **价值**：低中。真实痛点形态=「人发话时排队中的低优先级派发应让位」。
- **决策：暂缓**，登记微项：drain 时若队列混杂人消息与编排消息，人消息优先
  （当前队列按到达序）。等 steer-queue 真实使用数据（队列深度分布）出来再定是否值得。

### P3-7. Mandate/policyVersion 授权锚定 — 暂缓

- **dsh 机制**：不可变授权记录（policyVersion/scope/strength/matched rules），
  变更 notice 但不撤销。
- **agent-hub 现状**：mission contract 已具雏形——goal/criteria/scope/constraints
  创建即锁定（updateContract 仅 draft 可编辑，mission.ts:632-659），mission.log
  是 append-only 审计。缺版本锚定与变更通知。
- **决策：暂缓**。触发条件：mission 需要"执行中改约"（rework/supplement 已部分
  覆盖该需求）或跨主体委托授权时，再把 contract 升级为带版本的 Mandate。

### P3-8. human_action 结构化提问 — 不采纳（已有等价物）

- hub 已有 `{"help":{to,question}}` JSON 块契约（conductor.ts:3287）→
  pendingClarification/waitingForHelp 结构化路由，功能等价。
- 差异点（登记不立项）：dsh 允许"已授权工作提问期间继续干活"，hub 的
  waitingForHelp 任务挂起——语义差异是有意的（求助=阻塞依赖），如需"非阻塞提问"
  另议。

### P3-9. 注意力预算哲学 — 不采纳为机制（已对齐），登记为度量原则

- hub 已有 wake-gate 廉价层、silentRepro 每房日限、ntfy 仅 waitingFor、
  "未点名零成本静默"——方向完全一致。
- 可吸收的一条具体做法：**自动化/例程产出的消息长度上限**（dsh 100 词），
  作为将来 routines 落地时的输出规约；不做为独立工作项。

### P3-10. Panel 三问/健康层级、prompt 分层版本化、失败矩阵 — 暂缓/不采纳

- Panel 三问：UI 信息架构参考，随下个面板迭代取用（desktop MissionPanel 已具雏形）— 暂缓。
- prompt 分层+Versions：hub 无 prompt 管理层与多租户 override 需求 — 不采纳；
  「动态段放最后保 provider 缓存」已是现有注入惯例，登记为约定即可。
- 失败矩阵：hub 各失败路已有定义行为（重试/退避/终态散布在对应模块）—
  不采纳整体框架，可把 dsh §9 当核对清单做一次性对照审计（低风险顺手活）。

## 2. 决策汇总

| 候选 | 决策 | 与已有项关系 | 落地状态（2026-11-07 基线） |
|---|---|---|---|
| recovery note worker 自查 | **采纳** | 补 outward() 两个盲区，正交第二道防线 | **已实施**（`RECOVERY_NOTE` 注入 autoRetried 重派 prompt，conductor.ts:317-320；与 outward author→sessionId 三形态匹配同批落地；待真机重启演练一并验证） |
| deciding 短超时护栏 | **采纳精简** | 现有 fail-open 不变，只压预算 | **已实施**（watchdog per-call `ackTimeoutMs` 覆盖 + `HUB_AUTO_DECIDE_TIMEOUT_MS` 默认 30s，handleAuto 决策 prompt 携带；口径限"无输出卡死"；prompt.error→onPromptError→fail-open self 链路不变） |
| Effects 持久队列 | 暂缓 | OperationLedger/followUps/history 分片已覆盖；登记 invariant+触发条件 | 暂缓（followUps 已增持久化，覆盖再扩大） |
| Gate+Assessment/Admission | 暂缓/不采纳 | 词汇并入 decision-model 一期；矩阵待外部源 | 暂缓（随 decision-model 一期立项） |
| Subscription/ownership | 暂缓 | help+taskSubs 已覆盖核心；用户消息重裁决是刻意的 | 暂缓 |
| 人优先槽 | 暂缓 | 降级为 drain 次序微项，等队列数据 | 暂缓（队列持久化已上线，待真实队列数据） |
| Mandate/policyVersion | 暂缓 | mission contract 已锁定式雏形；触发条件写明 | 暂缓 |
| human_action | 不采纳 | `{"help"}` 块已等价 | 不采纳 |
| 注意力哲学 | 不采纳 | 已对齐；仅吸收"自动化消息限长"作规约 | 不采纳（规约并入 routines 预检输出约定） |
| Panel/prompt分层/失败矩阵 | 暂缓/不采纳 | UI 参考/无需求/当对照清单 | 暂缓/不采纳 |

## 3. 采纳项落地路线

| 项 | 落点 | 改动面 | 依赖/冲突 |
|---|---|---|---|
| recovery note | `hub/src/conductor.ts`：auto-resumed 任务重派 prompt 注入恢复提示（复用 `note` 通道或 task prompt 前缀）；恢复段 ~2850 行区 | ~40 行 + `conductor.test.ts` 一条（auto-resumed 重派 prompt 含恢复提示断言） | **与在途 mission v2 无文本冲突**（其改动在 :225 区）；但同为 conductor.ts，建议等 v2 落盘或在独立 hunk 提交 |
| deciding 短超时 | `hub/src/agent.ts`：watchdog 时长参数化（`promptContent` 可选 timeoutMs 或 entry override）；`room-modes.ts handleAuto` 决策 prompt 传短预算；`index.ts` 读 `HUB_AUTO_DECIDE_TIMEOUT_MS` | ~50 行 + agent.test.ts/turn-governance 各一条 | 无冲突；须保持 prompt.error→onPromptError→fail-open self 链路不变 |

依赖序：两项互相独立可并行；均不与已落地 OMB 项耦合；recovery note 建议在
outward author 匹配修复**之后**合入同一批次（共享恢复段上下文、一并过真机演练）。

## 4. 遗留登记（不做事，只记账）

- SIGKILL 下纯 tool 副作用的物理盲区：recovery note 缓解但不消除，文案口径仍为
  "可证无外发"而非"确无外发"。
- drain 次序（人优先槽降级项）：等 steer-queue 上线数据。
- 「自动化消息限长」规约：并入 routines 预检立项时的输出约定。
- dsh §9 失败矩阵：可作一次性人工对照审计清单，非工程项。
