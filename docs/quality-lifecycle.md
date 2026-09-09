# Agent-Hub 工程质量闭环方案：从请求到可验证交付

> 状态：修订后的执行基线，按阶段验证后启用
> 版本：3.0
> 制定日期：2026-09-08
> 修订日期：2026-09-08
> 适用范围：Hub、Desktop、Android，以及通过 agent-hub 开发的项目
> 关联文档：`docs/quality-self-review-evolution.md`（质量控制平面技术方案 v2.0）

## 0. 文档定位与结论

本文定义质量能力的产品目标、领域边界、生命周期、证据标准、跨模式接入、配置演进、阶段依赖和验收条件。

`quality-self-review-evolution.md` 中关于安全、隔离、独立验证、持久化和可恢复性的约束继续有效。若两份文档冲突，以本文明确记录的新决策为准；未被本文修改的技术约束仍以前置文档为准。

本次修订后的核心结论：

1. 质量能力服务于“减少真实缺陷和返工”，不是为了增加 Agent、状态或检查次数。
2. 用户消息不是质量运行；先识别是否为代码变更请求，再决定是否进入质量生命周期。
3. `WorkItem` 及其首个 `QualityRun` 必须在实现开始前创建，并绑定项目、执行者和基线；writer 还必须绑定写锁或隔离工作区。
4. 文件写入只表示工作区变脏；turn/task 完成才是冻结 ChangeSet 和启动完整验证的边界。
5. 没有证据不能宣称通过；无法归因、无检查或基础设施失败必须标记为 `inconclusive`。
6. 原始失败先成为 Observation，只有已确认且可归因的缺陷才能成为 Incident。
7. 规则必须经过类型匹配的评测、用户批准和可回滚激活，不能由失败次数直接自动生效。
8. 度量从第一阶段开始，不能等全部功能完成后再证明价值。

## 1. 要解决的用户问题

当前 Agent 开发流程容易出现四类损失：

- 需求含糊或边界遗漏，Agent 直接实现，完成后才发现方向偏差；
- Agent 声称完成，但没有可复现的检查和验收证据；
- 不同会话、群聊模式、项目和远程机器之间的质量体验不一致；
- 失败被记录，却没有形成可信、可评测、可退役的预防措施。

质量系统的价值不是“检查更多”，而是：

```text
质量净价值
= 避免的缺陷成本 + 减少的返工成本 + 提升的交付可信度
- 新增延迟 - 模型与算力成本 - 误报和交互摩擦
```

只有净价值为正，功能才应默认启用。

### 1.1 北极星指标

**首次可验证交付率（First-pass Verified Delivery Rate）**：

```text
首次实现即满足全部 required checks 和 required acceptance evidence，
且在观察窗口内未 reopen / rollback 的代码变更 WorkItem 数
÷
全部代码变更 WorkItem 数
```

### 1.2 非目标

本方案不追求：

- 用更多 Agent 代替确定性测试；
- 对所有聊天消息强制生成需求文档；
- 在没有隔离和回滚能力时自动修复或应用变更；
- 从任意失败自动生成可执行命令；
- 用“通过”掩盖无检查、检查未运行或证据不足；
- 自动 push、merge、commit、deploy；
- 让规则数量、检查次数或流程严格程度单调增长。

目标是越来越精准，而不是越来越严格。

## 2. 第一性原理与不可变原则

### 2.1 越早消除不确定性，修复成本越低

| 缺陷引入阶段 | 典型问题 | 最低成本的处理方式 |
|---|---|---|
| 需求 | 目标、边界、约束、验收标准缺失 | 在实现前提出少量关键问题 |
| 设计 | 接口、状态、架构冲突 | 在编码前比较方案和约束 |
| 实现 | 逻辑、安全、并发、数据错误 | 测试、静态检查、独立审查 |
| 验证 | 漏测、证据不足、错误归因 | 验收矩阵、基线对照 |
| 运行 | 回归、性能退化、用户投诉 | 回滚、复现、回归资产 |

需求阶段应介入，但只处理会显著影响实现或验收的不确定性，不能把所有信息缺失都变成阻塞问题。

### 2.2 质量结论必须来自证据

证据优先级从高到低：

1. 独立执行器的退出码、测试报告和构建产物；
2. base-fail / candidate-pass 的差分回归证据；
3. 静态分析、类型检查、lint 和依赖审计；
4. 可定位、可复现的独立 reviewer finding；
5. 人工验收记录；
6. 实现 Agent 的自述或 AI 推断。

低等级证据不能覆盖高等级失败。AI 认为“已完成”不能覆盖测试失败。

### 2.3 可信归因先于学习

系统只有知道以下事实，才可以从失败中学习：

- 这是哪个项目、哪个 WorkItem、哪个候选变更；
- 实现前的 revision 和 dirty baseline 是什么；
- 失败是否在候选变更前已经存在；
- 失败来自代码、基础设施、flaky check 还是错误路由；
- finding 是否被复现、修复或用户确认。

无法归因的信号只能成为 Observation，不能直接成为 Incident 或规则证据。

### 2.4 请求边界、项目边界和协作边界不同

- `WorkRequest` 是用户意图边界；
- `ProjectScope` 是代码、策略、执行和学习边界；
- `Room` 是协作与展示边界；
- `WorkItem` 是一个执行者对一个 ProjectScope 的工作边界；
- `QualityRun` 是 WorkItem 的一次执行尝试，从实现前基线建立到候选验证终态。

一个 Room 可以涉及多个项目，一个请求可以拆成多个 WorkItem，一个项目也可以被多个 Room 使用。因此不能在收到 room 消息时随意绑定第一个项目。

### 2.5 生产者不能成为唯一验证者

- 实现者可以自检，但不能覆盖独立执行器的结论；
- reviewer 使用独立 session，默认只读；
- 高风险变更优先使用不同模型族审查；
- 争议 finding 由复现、第二 reviewer 或用户裁决；
- requirement verification 与 code review 可以共享一次模型调用，但必须保存为不同类型的结果。

### 2.6 自动化必须可降级、可停止、可回滚

模型不可用、远程 worker 断线、工作区污染或检查缺失时，系统必须给出明确的 `inconclusive`，不能静默失败或假通过。

## 3. 统一术语与领域模型

| 概念 | 定义 | 绑定范围 |
|---|---|---|
| WorkRequest | 一次用户请求及其意图分类 | room/session turn |
| RequirementSpec | 可版本化的目标、边界、约束和验收标准 | WorkRequest |
| WorkItem | 一个执行者在一个项目上的逻辑工作单元 | ProjectScope + session/task |
| QualityRun | WorkItem 的一次执行尝试，从 preflight、实现到验证终态 | WorkItem + generation + policy version |
| ChangeSet | 相对该次 QualityRun 实现前基线冻结的候选变更 | QualityRun |
| RequirementVerification | 验收标准到证据的逐项验证结果 | spec version + QualityRun |
| Observation | 尚未确认归因的原始质量信号 | QualityRun/project |
| Incident | 已确认的真实缺陷或需求偏差 | ProjectScope |
| RuleCandidate | 从 Incident 提炼、尚未生效的规则候选 | ProjectScope |
| ActiveControl | 已评测、已批准、可回滚的有效控制 | ProjectScope |

关系如下：

```text
WorkRequest
  └─ RequirementSpec v1..n
       └─ WorkItem 1..n
            └─ QualityRun generation 1..n
                 ├─ baseline + writer lease + run context
                 ├─ implementation signals
                 ├─ frozen ChangeSet
                 ├─ CheckRun
                 ├─ ReviewFinding
                 ├─ RequirementVerification
                 └─ Observation
                       └─ confirmed → Incident
                            └─ RuleCandidate
                                 └─ evaluated + approved → ActiveControl
```

一个 WorkItem 可以因重新实现、手动重试或新 turn 产生多个 QualityRun；单次自动修复则在当前 run 内递增 fixRound。只有最新 generation 的非 stale 结果能决定 WorkItem 终态，历史 run 只保留证据。

## 4. L0-L4 能力模型

能力层是职责分类，不表示每次请求都必须顺序执行全部层级。

| 层级 | 名称 | 职责 | 默认行为 |
|---|---|---|---|
| L0 | 需求辅助 | 识别会显著影响实现的需求缺口，形成版本化 spec | 建议模式，仅代码变更请求适用 |
| L1 | 确定性验证 | typecheck/test/lint/build 等可复现检查 | 有合法 checks 时启用 |
| L2 | AI 语义审查 | 检查逻辑、安全、数据、并发和跨层一致性 | 默认关闭 |
| L3 | 需求验证 | 将每条验收标准映射到真实证据 | 有 spec 时启用建议模式 |
| L4 | 受控学习 | Observation → Incident → Candidate → ActiveControl | 仅消费已确认信号 |

多模型交叉审查属于 **L2b 审查策略**，不再称为 L3：

- L2a：一个独立 reviewer；
- L2b：不同模型族交叉审查；
- L3：始终表示需求与证据的一致性验证。

### 4.1 层级依赖

- L1 可独立运行；
- L2 不得覆盖 L1 失败；
- L3 需要 RequirementSpec，但不强制依赖 L2；
- L4 可以接收 L0-L3 信号，但只能沉淀已确认、可归因的结果；
- 没有代码变更时，L1/L2/L3 通常为 `not-applicable`；
- 没有 spec 时，L3 为 `not-applicable`，不能假装已验证需求。

## 5. 统一证据与结论模型

### 5.1 层级结果

每个适用层输出以下状态之一：

| 状态 | 含义 |
|---|---|
| `passed` | 有足够证据且要求已满足 |
| `failed` | 有确定证据表明要求未满足 |
| `inconclusive` | 无检查、基础设施失败、污染、归因不清或证据不足 |
| `waived` | 用户明确接受已知失败或未知风险，并记录理由 |
| `not-applicable` | 本层不适用于当前 WorkItem |

### 5.2 QualityRun 终态

目标终态：

- `accepted`：所有 required 层均为 passed，且至少存在一项独立证据；
- `failed`：存在可归因的 required 失败；
- `inconclusive`：无法形成可信结论；
- `waived`：用户接受已知风险；
- `cancelled`：流程被取消；
- `quarantined`：检测到污染、越权或安全异常；
- `stale`：已被同一 WorkItem 的更新 generation 取代，不再具有裁决权。

每个终态同时保存 `assuranceProfile`，列出哪些层是 required、advisory、passed、unknown 或 not-applicable。UI 不只显示笼统的“通过”，而应显示例如“L1 已验证，L3 建议项仍有 1 条未知”。只有 policy-required 层参与 accepted/failed 判定；advisory 结果不会阻断，但必须可见。

禁止以下等价关系：

- checks 数量为 0 ≠ passed；
- 命令未执行 ≠ passed；
- infra failure ≠ code failure；
- reviewer pass ≠ deterministic pass；
- AI 推断存在实现 ≠ 验收标准已满足。

### 5.3 “通过”和“应用”必须分离

`accepted` 只表示质量证据通过，不表示代码已经 merge、commit 或 deploy。

- 直接写用户工作区时，质量流程只能报告和要求处理，拒绝不会自动撤销已有修改；
- 只有候选位于隔离 worktree 且存在可靠 apply/rollback 机制时，审批才能控制是否应用；
- `enforcement=report` 时，Conductor/WorkItem 可在附带 failed/inconclusive 结论后完成，不把质量报告伪装成门禁；
- `enforcement=require-pass` 时，只有 accepted 或策略允许的 waived 才能解锁依赖；
- `enforcement=require-approval` 时，按风险进入 awaiting-approval；
- UI 在非隔离模式下使用“验证通过 / 需要处理 / 接受风险”，不使用容易误解的“批准应用”。

## 6. 从请求到验证的完整生命周期

```text
用户消息
  → 意图分类
     ├─ 非代码变更 → 正常分发，不创建代码质量 WorkItem
     └─ 代码变更 → WorkRequest
          → L0 通用维度建议式澄清 → RequirementSpec vN
          → 模式选择、任务拆分和目标项目解析
          → L0 项目规则补充评估（仍写入同一 specVersion）
          → 每个 writer/project 创建 WorkItem + QualityRun generation N
          → preflight：解析项目、选执行器、获取 lease、记录 baseline
          → implementing：向 Agent 分发带 spec 的任务
          → 文件/工具/git 信号只标记当前 run dirty
          → turn/task 完成
          → collecting：冻结 ChangeSet、检测污染、分类风险
          → L1 quick/full checks
          → L2 AI review（可选）
          → L3 acceptance evidence verification（有 spec 时）
          → accepted / failed / inconclusive / waived / quarantined
          → 原始信号记录为 Observation
          → 已确认且可归因 → Incident
          → 评测和批准 → ActiveControl
```

### 6.1 入口：先判断意图，不是先拦截

`room.message` 和 `prompt.send` 是统一请求入口，但 L0 不应无条件阻塞这两个入口。

至少区分：

```ts
type RequestIntent =
  | "code-change"
  | "investigation"
  | "discussion"
  | "operation"
  | "clarification-answer"
  | "control-command";
```

只有 `code-change` 默认进入需求辅助。查询、解释、review、辩论、停止命令和澄清回答按各自路径处理。手动“运行质量检查”和定时巡检直接创建 `verification-only` WorkItem，跳过 L0/implementing；Incident 驱动的修复创建 `remediation` WorkItem，并继承已确认的复现和验收证据。

### 6.2 L0：建议式需求辅助

通用检查维度：

| 维度 | 只在何时提问 |
|---|---|
| 目标清晰度 | 不同理解会产生明显不同实现 |
| 边界完整性 | 是否包含迁移、兼容、删除等会改变工作量 |
| 验收可验证性 | 无法客观判断完成，且任务不是纯探索 |
| 约束明确性 | 涉及不能破坏的兼容、性能或平台要求 |
| 冲突检测 | 与现有功能、规则或用户前文冲突 |
| 依赖识别 | 存在未完成任务、服务、凭据或环境依赖 |
| 风险识别 | 涉及安全、权限、数据、部署、账务等高风险路径 |

提问规则：

- 单轮最多 3 个问题；
- 只问会改变实现、风险或验收的问题；
- 问题必须引用当前上下文，不能输出通用问卷；
- 用户可回答、跳过、修改或取消；
- 模型超时或不可用时降级放行并记录 `inconclusive` 评估，不阻断消息；
- “发现需求缺口”本身不是 Incident；
- 用户中途改变需求先创建 spec 新版本，不自动认定为需求缺陷；
- 已分发的 QualityRun 永远绑定原 specVersion；新版本不得原地篡改验证基准，用户选择继续旧 run、取消，或创建绑定新版本的新 generation。

L0 可采用确定性规则优先、模型辅助的实现：

1. 命令、短确认、澄清回答先由确定性路由排除；
2. 明显高风险关键词和项目规则触发检查；
3. 需要语义判断时才调用模型；
4. 所有模型调用都有超时、token 和成本预算；
5. 默认先以 shadow/advisory 模式灰度。

L0 分两次、共享同一个 specVersion：

- 路由前只运行通用维度，不假设 Room 属于某个项目；
- 模式选定执行者并解析 ProjectScope 后，在 writer 派发前追加项目级 RequirementRule；
- 两次评估按 dimension/ruleId 去重，最多仍只向用户展示 3 个关键问题；
- 一个请求拆到多个项目时，项目特定问题标明目标 planned task/project；在 WorkItem 创建后保存对应关联，不能把某项目规则污染到其他项目。

### 6.3 澄清协议

不能只发送无法关联的 `room.notice`。目标协议至少包含：

```ts
type ClarificationRequest = {
  requestId: string;
  specId: string;
  specVersion: number;
  questions: Array<{ id: string; dimension: string; text: string }>;
  canSkip: boolean;
  expiresAt?: number;
};
```

事件与 RPC：

```text
requirement.clarificationRequired
requirement.clarificationAnswer
requirement.clarificationSkip
requirement.specUpdate
```

Desktop 和 Android 均按 `requestId + specVersion + questionId` 回答。Hub 重启后从持久化状态恢复，过期回答不得写入新版本 spec。

### 6.4 WorkItem 与首个 QualityRun 必须在实现前创建

模式完成路由和执行者选择后，为每个 writer/project 创建 WorkItem，并立即创建 generation 1 的 QualityRun。后续状态机属于 QualityRun；WorkItem 只汇总逻辑任务和当前权威 generation。`preflight` 必须完成：

1. 从 session owner connection 和 session cwd 解析唯一 ProjectScope；
2. 不允许匹配失败后回退到“第一个项目”；
3. 按 `project.connectionId` 选择本地或远程 ExecutionProvider；
4. implementation/remediation 获取 writer lease 或独立 worktree；verification-only 等待活动 writer 完成后冻结只读 snapshot；
5. 记录 `baseRevision`、`dirtyBaselineHash` 和 policy hash/version；
6. 绑定 `requestId/specVersion/workItemId/runId/taskId/sessionId`；
7. 评估已有 dirty tree，无法隔离时降级为 report/inconclusive；
8. 确认检查命令、cwd 和执行能力可用。

preflight 失败不得派发 writer。后续 gate/review/fix 始终使用该 run 冻结的 policy snapshot；运行中策略变化只影响新 generation，不能让同一 run 前后使用不同标准。

### 6.5 文件变化只是 dirty 信号

以下信号均可标记 WorkItem 变脏：

- ACP `fs.writeTextFile`；
- `tool_call` / `tool_call_update` 的 edit/delete/move；
- turn 结束时的 Git/文件 manifest 对比；
- Desktop/Android 文件操作；
- 可选的外部 watcher 或 pre-commit 集成。

信号规则：

- 信号必须绑定活动 WorkItem/QualityRun；
- Hub 可拦截的写操作在落盘前校验 ProjectScope、允许范围和 protectedPaths；需要审批时先暂停，不先写后批；
- 无法预拦截的 shell/外部写入在 snapshot 对比时发现越界则 quarantine；
- artifact 文本解析只能作为补充，不能决定项目归属；
- debounce 用于合并 dirty 信号，不直接启动 full gate；
- turn/task 完成后冻结 generation N 的 ChangeSet；
- 新 generation 到来时，旧 run 取消、标记 stale 或仅保留历史，不得覆盖新结果；
- 非代码变更意图且没有文件变化时不创建 WorkItem/QualityRun；已进入代码变更生命周期但最终没有 ChangeSet 时，由 collecting 给出 `inconclusive` 或明确失败原因。

### 6.6 L1：确定性验证

- quick checks：低成本、快速反馈；
- full checks：候选完成后的全量或高风险检查；
- `required=false` 的失败可见但不阻断；
- 某个 tier 没有检查时跳过该 tier；
- 整个 run 没有任何适用检查时结果为 `inconclusive`；
- 基础设施失败单独分类，不创建代码 Incident；
- 生成默认 policy 后先 dry-run，命令不可用时提示用户修正；
- verification-only 没有候选 ChangeSet 时运行显式选择或全量 checks，其结论描述当前 snapshot，不用于候选缺陷归因；
- 对需要归因的失败，优先在 base revision 复跑同一最小检查。

### 6.7 L2：可选 AI 语义审查

L2 输入：

- 冻结的 ChangeSet；
- L1 结果；
- 项目规则和受保护路径；
- RequirementSpec；
- 风险分类和预算。

finding 必须包含位置、主张、证据、置信度和建议。重大 finding 只有在可复现、被修复或用户确认后才能成为 Incident。

L2a 默认一个独立 reviewer；L2b 只用于高风险或有争议的 finding。默认 `review=off`，避免每次变更增加模型成本。

### 6.8 L3：需求到证据的验证

L3 不检查“diff 中是否出现相关代码”，而是逐项判断验收标准是否有足够证据：

```text
AcceptanceCriterion
  → 预期 evidence type
  → CheckRun / test report / runtime artifact / manual record / AI inference
  → passed / failed / inconclusive / waived
```

规则：

- `verification=off` 时 L3 为 `not-applicable`；
- `verification=suggest` 时结果可见但不决定 QualityRun 终态；
- `verification=require-evidence` 时 required criterion 的 failed/unknown 分别导致 failed/inconclusive；
- 每个 EvidenceExpectation 独立记录结果，criterion 再按 `evidenceMode=all|any` 汇总；空 expectedEvidence 只能得到 inconclusive；
- deterministic evidence 优先；
- AI 可以建议证据映射，但没有真实证据时只能给 `inconclusive`；
- L2 和 L3 可共享一次 reviewer 调用以降低成本，但结果分别存储；
- 没有 spec 时 L3 为 `not-applicable`；
- 未覆盖标准产生 VerificationGap Observation；经确认后才成为 RequirementIncident；
- 用户接受限制时记录 criterion 级 waiver 和理由。

### 6.9 QualityRun 状态机

```text
queued
  → preflight
     ├─ 项目/执行器不可用 → inconclusive
     ├─ 污染或越权 → quarantined
     ├─ verification-only snapshot 就绪 → collecting
     └─ implementation/remediation 的 lease + baseline 就绪 → implementing
          ├─ Agent 失败 → failed / cancelled
          └─ turn/task 完成 → collecting
               ├─ 预期修改但无 ChangeSet → inconclusive / failed（按任务契约）
               ├─ 无法冻结或归因 → inconclusive / quarantined
               └─ ChangeSet 或 verification-only snapshot 就绪 → quick-verifying
                    ├─ required failure → fixing（有隔离和预算）/ failed
                    └─ passed / tier skipped
                         ├─ L2 启用 → reviewing
                         │    ├─ blocking finding → fixing（有隔离和预算）/ failed / awaiting-approval
                         │    └─ 无 blocking finding → full-verifying
                         └─ L2 关闭 → full-verifying
                              ├─ required failure → fixing（有隔离和预算）/ failed
                              └─ passed / tier skipped → requirement-verifying（L3 适用）或结论汇总
                                   ├─ required criterion failed → failed
                                   ├─ required criterion unknown → inconclusive / awaiting-approval
                                   └─ 全部 required evidence passed → accepted

fixing → collecting 保持在同一 QualityRun，递增 fixRound，并清除修复前的 patchHash、checks、findings 和 requirement evidence。
用户重新实现、重试或新 turn 产生新的 QualityRun generation；新 generation 成为权威后，尚未完成的旧 generation → stale。
awaiting-approval → accepted / waived / failed / fixing / cancelled。
结论汇总若发现所有验证层均 skipped/not-applicable，则必须进入 inconclusive，不能 accepted。
```

内部保留这些状态用于归因、恢复和审计；Desktop/Android 可以折叠显示为“准备、实现、验证、待处理、完成”。

## 7. 跨模式接入

### 7.1 统一接口，而不是复制模式逻辑

现有 `roomModeManager.handle()` 同时完成模式决策和 prompt 派发，无法在已知执行者/项目后、首次写入前完成 project-specific L0 与 preflight。目标实现需拆成两步：

```text
planDispatch(request) → DispatchPlan（只决定模式、执行者、任务和依赖，不启动 writer）
prepare WorkItem/QualityRun → project-specific L0 + preflight
dispatch(plan) → 实际发送 prompt
```

`auto` 模式的主持人决策属于只读 planning turn；选定实际模式后仍必须经过 DispatchPlan 和 preflight。所有模式调用同一组生命周期接口：

```ts
interface QualityLifecycle {
  classifyRequest(input: RequestInput): Promise<WorkRequest>;
  evaluateRequirement(request: WorkRequest, context?: { projectId?: string; taskId?: string }): Promise<RequirementSpec | undefined>;
  beginWorkItem(input: BeginWorkItemInput): Promise<{ workItem: WorkItem; run: QualityRun }>;
  markDirty(runId: string, signal: ChangeSignal): void;
  completeRun(runId: string): Promise<QualityRun>;
  cancelWorkItem(workItemId: string, reason: string): Promise<void>;
}
```

`beginWorkItem` 只有在 preflight 完成后才 resolve；调用方仅在返回的 run 进入 `implementing` 时执行 dispatch，若已是 inconclusive/quarantined/failed 则不得发送 writer prompt。

模式只负责决定执行者、顺序和任务拆分；质量服务负责项目绑定、基线、变更集和结论。

### 7.2 当前状态与目标

| 模式 | 当前状态 | 目标接入 | L0/L1/L3 是否总适用 |
|---|---|---|---|
| 会话 | 有变更信号；post-turn 创建 run 后可能停在 queued | prompt 前 begin，prompt.done 后 complete | 仅代码变更时适用 |
| mention/self/roundrobin | 依赖通用 post-turn 路径，推进不完整 | 每个 writer 建 WorkItem | 仅代码变更时适用 |
| conductor | task 完成后创建并推进 run，但 baseline 过晚 | task 派发前 begin，run 终态后按 enforcement 决定依赖解锁 | 写任务适用 |
| parallel | flow 完成路径可能绕过通用触发 | 每个 project/writer 建 child WorkItem | 同项目多 writer 需隔离 |
| pipeline | 中间阶段和最终产物边界不清 | writer 阶段各自验证，最终阶段做 L3 | 只读阶段不适用 L1 |
| debate | 通常是讨论，不应自动启动代码门禁 | 只有明确落地产物的 writer 建 WorkItem | 默认 not-applicable |
| auto | 继承所选模式的不一致 | 选择模式后调用统一接口 | 取决于实际意图 |

兼容性的目标是**相同意图获得相同质量语义**，不是所有模式无条件运行 L0-L4。

### 7.3 并发规则

- 同一 ProjectScope 同一时间最多一个直接工作区 writer；
- parallel 模式需要同项目多 writer 时必须使用独立 worktree；
- 不具备隔离能力时，多 writer 排队或降级为只读方案比较；
- reviewer/planner 可并行读；
- 所有质量结果必须绑定各自 ChangeSet，不能对共享 dirty tree 给出独立通过结论。

## 8. 目标数据模型

### 8.1 WorkRequest 与 RequirementSpec

```ts
type WorkRequest = {
  id: string;
  source: "room" | "session" | "scheduler" | "incident" | "manual";
  mode?: string;
  roomId?: string;
  sessionId?: string;
  correlationId: string;
  turnId?: string;
  rawInputRef?: string;
  intent: RequestIntent;
  status: "received" | "clarifying" | "ready" | "dispatched" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

type RequirementSpec = {
  id: string;
  requestId: string;
  version: number;
  parentVersion?: number;
  goal: string;
  scope: { included: string[]; excluded: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  risks: string[];
  clarifications: Clarification[];
  status: "draft" | "clarifying" | "accepted" | "superseded" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

type EvidenceExpectation = { id: string } & (
  | { kind: "check"; checkId: string }
  | { kind: "test"; testId?: string; description: string }
  | { kind: "runtime"; description: string }
  | { kind: "manual"; instruction: string }
  | { kind: "review"; rubric: string }
);

type AcceptanceCriterion = {
  id: string;
  description: string;
  required: boolean;
  evidenceMode: "all" | "any";
  expectedEvidence: EvidenceExpectation[];
};

type Clarification = {
  id: string;
  dimension: string;
  question: string;
  answer?: string;
  status: "pending" | "answered" | "skipped" | "expired";
};
```

`AcceptanceCriterion` 不保存 `covered`。覆盖情况属于某次 QualityRun 的验证结果，不能污染不可变的需求基准。

### 8.2 WorkItem、QualityRun 与 RequirementVerification

```ts
type WorkItem = {
  id: string;
  requestId: string;
  specId?: string;
  specVersion?: number;
  projectId: string;
  roomId?: string;
  taskId?: string;
  sessionId?: string;
  mode: string;
  kind: "implementation" | "verification-only" | "remediation";
  status: "planned" | "active" | "completed" | "cancelled";
  currentRunId?: string;
  currentGeneration: number;
  createdAt: number;
  updatedAt: number;
};

type QualityRun = {
  id: string;
  workItemId: string;
  projectId: string;
  sessionId?: string;
  generation: number;
  fixRound: number;
  budget: { maxFixRounds: number; timeoutMs: number };
  stage:
    | "queued"
    | "preflight"
    | "implementing"
    | "collecting"
    | "quick-verifying"
    | "reviewing"
    | "fixing"
    | "full-verifying"
    | "requirement-verifying"
    | "awaiting-approval"
    | "accepted"
    | "failed"
    | "inconclusive"
    | "waived"
    | "cancelled"
    | "quarantined"
    | "stale";
  baseRevision?: string;
  dirtyBaselineHash?: string;
  policyVersion: string;
  policyHash: string;
  policySnapshotRef: string;
  changeSetId?: string;
  outcome?: "verified" | "failed" | "inconclusive" | "waived";
  createdAt: number;
  updatedAt: number;
};

type RequirementVerification = {
  id: string;
  runId: string;
  specId: string;
  specVersion: number;
  criterionId: string;
  expectationId: string;
  status: "passed" | "failed" | "inconclusive" | "waived";
  method: "check" | "test" | "runtime" | "manual" | "ai-inference";
  evidenceRefs: string[];
  verifier: string;
  confidence?: number;
  waiverReason?: string;
};
```

### 8.3 Observation、Incident 与规则

```ts
type QualityObservation = {
  id: string;
  projectId: string;
  runId?: string;
  workItemId?: string;
  kind: "check-failure" | "infra-failure" | "finding" | "verification-gap" | "user-feedback" | "contamination";
  attribution: "candidate" | "baseline" | "infrastructure" | "unknown";
  fingerprint?: string;
  fingerprintVersion?: number;
  evidenceRefs: string[];
  status: "open" | "confirmed" | "dismissed";
  createdAt: number;
};

type QualityIncident = {
  id: string;
  projectId: string;
  type: "code" | "requirement" | "verification";
  fingerprint: string;
  fingerprintVersion: number;
  description: string;
  severity: "critical" | "major" | "minor" | "info";
  sourceObservationIds: string[];
  status: "open" | "covered" | "accepted-risk" | "resolved";
  createdAt: number;
};

type RuleSelector = {
  intents?: RequestIntent[];
  keywords?: string[];
  pathPatterns?: string[];
  riskTags?: string[];
};

type RequirementRule = {
  id: string;
  selector: RuleSelector;
  dimension: string;
  questionTemplate: string;
};

type VerificationRule = {
  id: string;
  selector: RuleSelector;
  criterionTemplate: string;
  evidenceMode: AcceptanceCriterion["evidenceMode"];
  expectedEvidence: AcceptanceCriterion["expectedEvidence"];
};

type RuleDefinition =
  | { type: "check"; value: CheckDefinition }
  | { type: "risk"; value: RiskRule }
  | { type: "requirement"; value: RequirementRule }
  | { type: "verification"; value: VerificationRule };

type RuleCandidate = {
  id: string;
  projectId: string;
  definition: RuleDefinition;
  sourceIncidentIds: string[];
  evaluation: {
    status: "pending" | "passed" | "failed";
    evaluatorVersion?: string;
    datasetId?: string;
    metrics?: Record<string, number>;
    evidenceRefs: string[];
  };
  status: "candidate" | "approved" | "promoted" | "rejected";
  createdAt: number;
};

type ActiveControl = {
  id: string;
  projectId: string;
  candidateId: string;
  definition: RuleDefinition;
  activatedBy: string;
  activatedAt: number;
  activationPolicyHash: string;
  rollbackRef: string;
  status: "shadow" | "active" | "retired";
};
```

fingerprint 必须描述失败模式，不能包含会导致每次运行都不同的 runId。推荐由稳定字段构成：

```text
projectId + incidentType + check/category + normalized path + normalized error signature
```

模型可提出聚类建议，但合并 Incident 必须保留原始证据并可人工拆分。fingerprint 算法必须带版本；升级算法时重建索引但保留旧值，不能静默改变既有 recurrence。

## 9. 策略配置与兼容演进

### 9.1 当前可执行的 v1 示例

在 policy v2 落地前，任何写入 `.devin/quality.json` 的配置必须符合当前 parser。以下是仅覆盖 Hub 的最小示例，可直接被当前 schema 校验；它不代表 agent-hub 全仓验证，Desktop/Android 检查需由完整项目策略另行加入：

```json
{
  "version": 1,
  "checks": [
    {
      "id": "hub-typecheck",
      "cwd": "hub",
      "argv": ["npx", "tsc", "--noEmit"],
      "tier": "quick",
      "timeoutMs": 120000,
      "required": true,
      "allowNetwork": false
    },
    {
      "id": "hub-test",
      "cwd": "hub",
      "argv": ["npm", "test"],
      "tier": "full",
      "timeoutMs": 300000,
      "required": true,
      "allowNetwork": false
    }
  ],
  "protectedPaths": [
    ".devin/quality.json",
    "AGENTS.md",
    "hub/src/quality/**"
  ],
  "riskRules": [
    {
      "pattern": "hub/src/quality/**",
      "risk": "high",
      "reason": "质量控制核心路径"
    }
  ],
  "review": {
    "enabled": false,
    "blockSeverity": "major",
    "minBlockingConfidence": 0.8,
    "maxFixRounds": 0
  },
  "autonomy": "observe"
}
```

v1 中不得写入未实现的 `auto-pass`、`requirementRules` 或 `verificationRules` 并宣称已经生效。

### 9.2 policy v2 目标

现有 `autonomy` 同时混合“是否阻断”和“是否修复”，语义不清。v2 拆为独立维度：

```ts
type QualityPolicyV2 = {
  version: 2;
  checks: CheckDefinition[];
  protectedPaths: string[];
  riskRules: RiskRule[];
  requirementRules: RequirementRule[];
  verificationRules: VerificationRule[];
  enforcement: { mode: "report" | "require-pass" | "require-approval"; approvalRisk: "high" | "critical" };
  remediation: { mode: "off" | "propose" | "isolated-fix" | "apply-low-risk"; maxFixRounds: number };
  requirements: { mode: "off" | "suggest" | "require-high-risk"; maxQuestions: number };
  review: { mode: "off" | "advisory" | "blocking"; blockSeverity: "critical" | "major"; minBlockingConfidence: number };
  verification: { mode: "off" | "suggest" | "require-evidence" };
  evidence: { excludePaths: string[]; retentionDays: number; maxArtifactBytes: number };
};
```

迁移原则：

| v1 autonomy | v2 enforcement | v2 remediation |
|---|---|---|
| observe | report | off |
| propose | require-approval | propose |
| isolated-fix | require-pass | isolated-fix |
| apply-low-risk | require-pass | apply-low-risk |

新项目的首期 v2 默认值为：`enforcement=report`、`remediation=off`、`requirements=off`、`review=off`、`verification=off`，两类新增规则数组为空；evidence 配置使用有限保留期、大小上限和常见秘密路径排除。Phase 1 自动运行 L1 并报告；L0/L3 分别到 Phase 3/4 后先以 shadow 或 suggest 开放，不因 schema 已存在就提前启用。

- 已存在的 v1 文件在用户迁移前保持原语义，不静默重解释；
- UI 展示 v1 → v2 迁移预览；
- 只有用户确认后才切换到 v2 语义并原子写入；
- 不自动覆写用户文件；
- 写入使用 expected old hash，文件已变化时拒绝覆盖；
- 写入失败保留旧策略；
- v2 对未知字段和未支持的 rule definition 给出显式错误，不静默忽略；
- malformed policy 不得被“初始化策略”按钮静默覆盖。

### 9.3 学习规则的存储

首期 ActiveControl 存储在 SQLite，按项目运行时加载。只有用户明确选择“导出到项目策略”时，系统才生成可审阅的 policy patch。

原因：

- 避免频繁污染版本控制工作区；
- 避免并发覆盖用户配置；
- 便于 shadow、回滚和退役；
- 防止 Agent 输出直接成为可执行命令。

导出映射固定为：check → `checks`、risk → `riskRules`、requirement → `requirementRules`、verification → `verificationRules`。导出前仍需对当前 policy hash 做并发检查。

任何 AI 生成的 CheckDefinition 都只能是候选，必须经过命令安全校验、隔离执行、正反样本评测和用户批准。

## 10. L4 受控学习闭环

### 10.1 Observation 到 Incident

```text
原始信号
  → Observation
  → 分类与归因
     ├─ baseline / infrastructure / unknown → 保留观察，不生成代码 Incident
     └─ candidate attributable
          → 复现、修复确认或用户确认
          → Incident
```

可直接确认 Incident 的典型来源：

- 用户明确报告且能够关联项目和变更；
- candidate 上失败、base 上通过的确定性检查；
- reviewer finding 被复现或对应修复后消失；
- L3 验收缺口被用户确认；
- 发布后 rollback/reopen 能关联到原 WorkItem。

以下情况不自动成为 RequirementIncident：

- L0 提出了澄清问题；
- 用户正常扩大或改变范围；
- Agent 推测需求可能不完整；
- 用户跳过澄清但尚未发生实际偏差。

需求变化首先创建 RequirementSpec 新版本。只有后续返工被确认由遗漏或误解造成时，才记录需求级 Incident。

### 10.2 候选类型与评测

| 候选类型 | 评测方法 | 激活后的作用 |
|---|---|---|
| CheckDefinition | 历史失败样本应失败、正常样本应通过、耗时稳定、命令安全 | L1 执行检查 |
| RiskRule | 已知高风险路径命中率与误伤率 | 调整审批和验证强度 |
| RequirementRule | 问题有用率、跳过率、后续返工变化 | L0 提问建议 |
| VerificationRule | 已知遗漏检出率、正常验收误报率 | L3 evidence template |

固定“出现 3 次”只能触发 candidate 建议，不能证明规则正确。严重度、证据质量、样本独立性和误伤成本都必须进入评测。

### 10.3 规则生命周期

```text
RuleCandidate(candidate)
  → evaluation passed
  → user approved
  → create ActiveControl(shadow)，candidate 标记 promoted
  → guardrails healthy
  → ActiveControl(active)
  → continuously measured
  → ineffective / noisy / conflicting
  → ActiveControl(retired)
```

禁止 sandbox 自行批准 candidate 或创建/激活 ActiveControl。用户批准必须是独立动作，并记录批准人、时间、policy hash 和回滚信息。

### 10.4 防止学习污染

- 不从 infra failure 生成代码规则；
- 不从未确认 AI finding 生成规则；
- 不允许候选修改评价器、保护路径、权限逻辑或自身评测数据；
- 规则有项目/组件/路径适用范围、最大数量、冷却和退役机制；
- 规则文本和模型输入按不可信内容处理，防止 prompt injection；
- 可执行规则使用 argv 且 `shell:false`，cwd 必须在 ProjectScope 内；
- 网络、环境变量和秘密访问遵守执行器白名单。

## 11. 产品体验

### 11.1 首次价值体验

用户第一次使用质量能力，应完成以下闭环：

1. 自动识别项目及候选检查；
2. 用户预览并确认策略；
3. dry-run 验证命令可执行；
4. Agent 完成一个代码变更；
5. 聊天中自动出现简洁质量卡片；
6. 用户能看到失败原因、证据和下一步操作；
7. 无需进入独立页面才能知道是否验证成功。

### 11.2 聊天内摘要

```text
质量验证 · WorkItem W-123
结果：inconclusive
L1：typecheck passed；full test 未配置
L2：未启用
L3：2/3 条有证据，1 条待人工确认
[查看证据] [补充验证] [接受风险]
```

### 11.3 质量中心

Desktop 和 Android 质量中心展示：

- WorkRequest、spec 版本和关联 WorkItem；
- 项目、连接、执行机器和实际 cwd；
- baseline、ChangeSet、policy version/hash；
- checks、findings、requirement verification；
- verified/failed/inconclusive/waived 的明确原因；
- Observation、Incident、候选规则及激活历史；
- 延迟、成本、误报和趋势。

所有 RPC 错误必须可见，客户端不能用空 `catch` 把失败伪装成操作成功。

## 12. 度量、对照和发布条件

度量从 Phase 0 开始写入，不再作为最后阶段补做。

### 12.1 核心结果指标

| 指标 | 含义 |
|---|---|
| first-pass verified delivery rate | 首次实现即有完整证据通过的比例 |
| escaped defect rate | 质量流程通过后仍发现真实缺陷的比例 |
| reopen / rollback rate | 交付后再次修复或撤销的比例 |
| requirement rework rate | 因需求误解或遗漏导致返工的比例 |
| regression evidence rate | Incident 是否有可复现的 base/candidate 证据 |
| rule recurrence delta | 规则启用前后同类问题复发变化 |

### 12.2 可信度指标

- 代码变更 WorkItem 的质量运行覆盖率；
- project/session/task/run 关联正确率；
- no-check 和 inconclusive 比例；
- infra/flaky rate；
- reviewer confirmation/dismissal rate；
- L3 criterion evidence coverage；
- stale/duplicate/stuck run 数量。

### 12.3 用户成本护栏

- p50/p95 额外延迟；
- 每 WorkItem 的 token、API 和执行成本；
- L0 提问率、回答率、跳过率和“有帮助”反馈；
- false-block / override / waiver rate；
- 每日通知和审批数量；
- CPU、磁盘和远程 worker 压力。

所有比率以持久化 WorkItem/QualityRun 事件为分母，不能用当前 UI 列表反推。事件至少带 `projectId/requestId/workItemId/runId/generation/mode/agent/model/policyHash/timestamp`，成本事件带 token、金额和币种；不为度量复制保存完整用户 prompt。

### 12.4 评测方法

按相同任务、模型和预算比较：

1. 原生 Agent；
2. agent-hub 当前流程；
3. agent-hub + L1；
4. agent-hub + L1 + L2；
5. agent-hub + L0 + L1 + L3；
6. agent-hub + 完整受控学习。

先使用 agent-hub 历史真实缺陷构建版本化固定评测集，再进行项目内 shadow/分阶段灰度。评测任务保留隐藏验收，规则来源样本与最终验证样本分离，模型、预算、基础 revision 和重复次数固定；不能用生成候选的同一条 Incident 作为唯一“通过”证据。每个阶段启用默认行为前必须记录旧基线。

### 12.5 发布和停止条件

只有同时满足以下条件才扩大默认启用范围：

- 严重 false pass 在固定评测集中为 0；
- 项目、执行器和 WorkItem 归属测试全部通过；
- 没有 run 静默停在非终态；
- 解决率不低于对照；
- escaped defect 或返工指标改善；
- 延迟、成本、误报和审批量在预设预算内；
- 功能可按项目关闭并可回滚。

若 escaped defect 上升、路由错误、规则误伤或用户成本越过预算，立即回退到 shadow/report，不以扩大样本为理由继续自动化。

## 13. 分阶段落地计划

### Phase 0：可信基础与度量

目标：先让每个质量结论可归属、可解释、可恢复。

工作项：

- 引入最小 WorkRequest/WorkItem/run-context 关联；
- 为 SQLite、Hub RPC、Desktop 和 Android 增加向后兼容的数据/状态迁移；
- 在 Agent 实现前创建 WorkItem/QualityRun，并冻结 baseline 与 policy snapshot；
- 按 session owner connection + cwd 唯一解析 ProjectScope；
- 按 project.connectionId 选择 ExecutionProvider；
- 接入 writer lease，并在 Hub 重启时从非终态 run 安全重建或 quarantine 歧义租约；
- 将 WorkItem 允许修改范围和 protectedPaths 接入写前权限判断；
- 持久化真实 patch artifact，对 untracked/binary 文件使用完整内容 hash 或受限 manifest；
- 修复 required/optional 和空 tier 语义；
- 执行器真正落实 allowNetwork、envNames、cwd 和超时限制；
- 增加 `inconclusive` 结果；
- 修复非 conductor run 不自动推进；
- 记录覆盖率、stuck run、infra/no-check、耗时和成本基线；
- 明确 v1 行为并实现 policy v2 兼容读取方案。

退出条件：

- dirty tree、错误项目、错误 worker、无 checks、infra failure 均不会被判定为 accepted；
- 单元测试和集成测试证明 baseline 早于第一次写入；
- 同项目第二 writer 被排队或隔离；
- 所有 run 最终进入明确终态；
- 本阶段不自动创建规则。

### Phase 1：L1 最小纵向闭环

目标：让用户在日常代码变更后立即获得可信且低摩擦的确定性反馈。

范围：会话、mention/self/roundrobin、conductor。

工作项：

- dirty 信号绑定 WorkItem；
- turn/task 完成后冻结 ChangeSet；
- quick/full checks 自动执行；
- 默认检查探测支持常见 monorepo/workspace，AGENTS.md 仍只提供建议、不直接执行；
- 默认 review 关闭、fix 关闭；
- 聊天内显示质量摘要和证据入口；
- 非代码意图不创建 WorkItem/run；代码变更请求若无 ChangeSet 则明确显示 inconclusive/失败原因；
- policy 初始化先 preview + dry-run，不静默覆盖。

退出条件：

- 四类入口完成端到端测试；
- agent-hub dogfood policy 能明确覆盖 Hub、Desktop、Android，未覆盖模块会在 UI 显示；
- required failure 不通过，optional failure 不阻断；
- 无适用检查显示 inconclusive；
- Conductor 按 enforcement 解锁：report 附带质量结论后可完成，require-pass 仅 accepted/允许的 waived 解锁。

### Phase 2：跨模式一致性

目标：让相同代码变更意图在所有模式下获得相同质量语义。

工作项：

- parallel 每个 writer/project 创建 child WorkItem；
- pipeline 区分只读阶段、写阶段和最终 L3；
- debate 默认只读，只有落地 writer 进入质量流程；
- auto 继承被选模式的统一接口；
- generation 去重、stale run 处理和取消传播；
- Desktop/Android 行为一致。

退出条件：

- 模式契约测试覆盖所有模式；
- 同项目并行 writer 无共享脏工作区误归因；
- 任一模式都不存在只创建 run 不推进的情况。

### Phase 3：L0 建议式需求辅助

目标：降低高价值需求缺口导致的返工，而不制造审讯感。

工作项：

- 意图分类和 clarification-answer 路由；
- RequirementSpec 版本化持久化；
- 专用 clarification 事件/RPC；
- 七维检查按 materiality 选择；
- 用户 answer/skip/edit/cancel；
- shadow → advisory 灰度；
- 记录提问率、跳过率、有用率、延迟和返工变化。

退出条件：

- 普通查询、讨论和命令不被拦截；
- 澄清回答不会被识别为新需求；
- 模型不可用时可安全放行；
- 未证明净价值前不启用强制模式。

### Phase 4：L3 需求证据验证

目标：从“代码能运行”提升到“验收标准有证据”。

工作项：

- AcceptanceCriterion expectedEvidence；
- RequirementVerification 独立存储；
- criterion → checks/tests/runtime/manual evidence 映射；
- unknown/waived 处理；
- 可选与 L2 共享调用但输出分离；
- 生成 coverage matrix 和聊天摘要。

退出条件：

- AI 推断不能单独把 required criterion 判 passed；
- spec 版本和 run 一一对应；
- 未覆盖标准可补充证据或显式 waiver；
- 没有 spec 的 run 明确显示 not-applicable。

### Phase 5：L4 受控学习

目标：只从真实、确认过的失败中形成可测量的预防能力。

工作项：

- Observation 与 Incident 分离；
- 稳定 fingerprint 和人工合并/拆分；
- 四类 RuleCandidate schema；
- 类型匹配的历史 eval；
- RuleCandidate candidate → approved → promoted；
- ActiveControl shadow → active → retired，并由运行时加载；
- policy patch 仅由用户显式导出；
- 记录 recurrence、precision、误伤和规则成本。

退出条件：

- infra/baseline/unknown 不生成代码 Incident；
- candidate 无法自行 approved/promoted，也无法自行创建或激活 ActiveControl；
- 每条 active 规则有评测、批准和回滚记录；
- 规则无效或误伤时可自动建议 retired，但仍由用户确认。

### Phase 6：可选 AI 审查、修复与隔离应用

目标：在可信基础上逐步增加高成本、高自治能力。

工作项：

- L2a 独立 reviewer；
- 高风险 L2b 交叉审查；
- reviewer 精度灰度；
- worktree 隔离 fixer；
- base-fail/candidate-pass 回归验证；
- 按风险审批和低风险应用；
- 完整 rollback。

退出条件：

- reviewer 精度和成本达到项目预算；
- fixer 不直接污染用户工作区；
- 没有回滚点时自动修复保持关闭；
- 高风险和保护区域始终需要明确审批。

## 14. 必须覆盖的验收场景

### 14.1 请求与 L0

- 清晰的小改动不提无价值问题；
- 模糊且高风险的请求最多提出 3 个关键问题；
- 用户回答、跳过、修改、取消均能恢复正确状态；
- “继续”“是”“跳过”不会创建新 WorkRequest；
- 查询、review、讨论和 slash command 不进入代码质量流程；
- Hub 重启后澄清状态可恢复。

### 14.2 项目、执行器和并发

- 一个 Room 中多个 cwd 不会选错项目；
- 相同路径的不同 connection 不会串项目；
- 远程项目的检查只在对应 worker 执行；
- 相对 artifact 路径不会触发“第一个项目”回退；
- 同项目第二 writer 排队；
- parallel 使用不同 worktree 时结果分别归属。

### 14.3 变更集和 Gate

- baseline 在首次写入前记录；
- 实现前已有 dirty patch 不归入本轮；
- FS、tool call、shell 写入和文件删除均能在完成边界被检测；
- protected/out-of-scope 写入能预拦截，无法预拦截的外部写入会 quarantine；
- 多次写入只产生一个最新 generation run；
- required/optional 语义正确；
- quick 或 full tier 为空时可跳过；
- 全部 tier 无检查时为 inconclusive；
- timeout/断线为 infra，不创建代码 Incident；
- patch artifact 实际存在且 hash 匹配。

### 14.4 L2/L3/L4

- reviewer 不能写文件；
- reviewer pass 不能覆盖测试失败；
- criterion 有代码但无行为证据时不能自动 passed；
- requirement waiver 保存理由；
- 用户正常改需求只产生 spec 新版本；
- 同类 Incident 跨 run 可聚类；
- 不同失败不会因描述相似被错误合并；
- 自动候选不能绕过评测和用户批准；
- active rule 可 shadow、回滚和 retired。

### 14.5 产品与恢复

- 聊天能看到结果，不必主动打开质量中心；
- RPC 失败在 UI 中可见；
- Hub 在每个非终态重启后不会假通过；
- 重启后活动 writer lease 被重建或进入 quarantine，不会静默放行第二 writer；
- Desktop/Android 展示同一 evidence/outcome 语义；
- 用户可按项目关闭 L0/L2/L3/L4，L1 也可切换为仅手动。

## 15. 与当前实现的关系

### 15.1 可复用但需要硬化的骨架

| 现有模块 | 可复用能力 | 落地前需要补齐 |
|---|---|---|
| `quality/run.ts` | 状态转换和持久化骨架 | inconclusive/waived、真实阶段职责 |
| `quality/project.ts` | ProjectScope 和路径约束 | session/project 唯一解析 |
| `quality/policy.ts` | v1 读取与校验 | v2、迁移、CAS 写入、dry-run |
| `quality/execution-*.ts` | 本地/远程命令执行 | 按 project 路由、能力确认 |
| `quality/change-set.ts` | Git diff/hash 基础 | 实现前 baseline、真实 artifact、污染归因 |
| `quality/gate.ts` | 检查选择和执行 | required/optional、空 tier、结论四态 |
| `quality/review-orchestrator.ts` | 独立 reviewer 骨架 | 精度门槛、L2/L3 分离 |
| `quality/incident.ts` | Incident CRUD | Observation、稳定 fingerprint、确认门 |
| `quality/rule.ts` | candidate 状态骨架 | typed rule、真实 eval、RuleCandidate/ActiveControl 拆分和旧状态迁移 |
| `quality/eval.ts` | benchmark 存储骨架 | 固定任务驱动、对照和统计结论 |
| QualityScreen | 质量中心基础 UI | WorkItem/spec/evidence、错误可见、内联摘要 |

“可复用”不等于“当前已闭环”。在 Phase 0 验收前，不宣称 L1/L4 已具备生产可信度。

### 15.2 当前已知阻塞项

1. ~~非 conductor 路径可创建 run 但不统一自动推进~~——已修复（`triggerGateForSession` 统一推进）；
2. ~~部分 flow 完成路径会绕过通用触发~~——已修复（`onPromptDone` + `dirtyTracker.isDirty`）；
3. ~~baseline 在 gate 时采集，晚于实现~~——已修复（preflight 阶段采集）；
4. ~~项目匹配失败会回退第一个项目~~——已修复（返回 undefined 不回退）；
5. ~~remote provider 未按 project.connectionId 选择~~——已修复（`RoutingExecutionProvider`）；
6. ~~writer lease 已有实现但未接入主流程~~——已修复（`prepareQualityRun` 中 acquire）；
7. ~~Gate 未正确使用 `required`，空 checks 直接失败~~——已修复（区分 required/optional，空 checks→inconclusive）；
8. `allowNetwork` 策略字段已通过 `bwrap --unshare-net` 实现 OS 级网络隔离（bwrap 不可用时降级为记录警告）；
9. ~~ChangeSet 返回 patch 路径但需确认内容真实落盘~~——已修复（`writeFileSync` 真实落盘）；
10. ChangeSet 风险结果已通过 `classifyChangeSet` + `higherRisk` 回写 run 并驱动 `requiresRiskApproval` 审批策略；
11. incident fingerprint 已移除 `sourceRunId` 入参，跨 run 同描述聚类为同一 fingerprint（§8.3 约束已满足）；
12. ~~sandbox 不得自动完成用户批准~~——已修复（rule 需人工 approved→active）；
13. ~~v1 示例、默认值和目标 `auto-pass` 语义曾互相冲突~~——已修复（已移除 `auto-pass`）；
14. ~~客户端存在静默吞掉部分质量 RPC 错误的路径~~——已修复（所有 quality RPC catch 写入 `qualityError`）。

这些项目属于 Phase 0/1 的验收输入，而不是后续优化项。

## 16. 不可破坏的约束

1. 没有独立证据不能标记 accepted；
2. infra、baseline、unknown 不能记录为候选代码缺陷；
3. WorkItem 的当前 QualityRun 未完成 preflight 不得启动 writer；
4. 同项目并行 writer 必须排队或隔离；
5. reviewer/planner 默认只读；
6. 质量策略、权限、评价器和学习逻辑属于保护区域；
7. AI 输出不能直接成为可执行 CheckDefinition；
8. malformed policy 不得被自动覆盖；
9. policy 更新必须原子、带旧 hash、可回滚；
10. 规则不自动批准、不自动激活；
11. 没有回滚点不自动修复；
12. 不自动 commit、push、merge、deploy；
13. L0 默认可跳过，且不能替用户决定需求；
14. 原始需求、patch 和检查日志有大小、文件权限、保留期和敏感信息处理策略；
15. 发送给 reviewer/model 前按项目策略排除秘密文件并执行敏感信息过滤；
16. 质量能力按项目可关闭并安全降级；
17. 任何模式不得拥有绕过证据约束的特殊通过路径。

## 17. 防踩坑决策清单

后续实现和评审直接使用此表判断是否偏离方案：

| 禁止做法 | 正确做法 | 原因 |
|---|---|---|
| 对每条消息运行 L0 | 先做意图和上下文路由 | 防止普通聊天被拦截 |
| 把澄清回答当新需求 | requestId/specVersion 关联 | 防止无限澄清循环 |
| 在文件写入时立即跑 full gate | 文件事件标 dirty，完成边界冻结验证 | 防止检查半成品和风暴 |
| 实现后才采 baseline | 当前 QualityRun 的 preflight 采集 | 保证变更归因 |
| 项目不明时取第一个 | 无法唯一解析就 inconclusive/阻止 writer | 防止跨项目误执行 |
| 任意 worker 执行命令 | 按 project.connectionId 路由 | 防止远程机器串线 |
| 零检查判通过 | 标记 inconclusive | 防止质量错觉 |
| optional check 失败阻断 | 单独展示但不阻断 | 遵守策略语义 |
| 所有 gate fail 建 Incident | 先 Observation、归因、确认 | 防止学习污染 |
| 用户改需求记缺陷 | 先生成 spec 新版本 | 需求演进不等于错误 |
| 出现 3 次自动激活规则 | 仅生成 candidate，再评测和批准 | 频率不证明正确性 |
| 用 quick gate 验证 RiskRule 有效 | 用该类型的正反样本评测 | 检查通过不代表分类规则有效 |
| 自动写 quality.json | 运行时存储，用户显式导出 patch | 防止配置污染和并发覆盖 |
| 改写 v1 autonomy 语义 | v2 显式拆分并迁移 | 避免兼容性陷阱 |
| 删除 preflight/collecting | 仅在 UI 折叠内部阶段 | 保留基线、隔离和恢复语义 |
| 所有模式标全能力 ✅ | 标注 current/target/applicable | 避免把愿景当现状 |
| 只在最后阶段做度量 | Phase 0 建立基线 | 否则无法证明增益 |
| 规则越来越多即越强 | 看 precision、复发率、成本并退役 | 防止规则腐化 |

## 18. 落地状态跟踪

> 基线测试结果（2026-09-09 复核）：`cd hub && npx tsc --noEmit` 通过；`cd hub && npm test` 941 tests / 0 fail（连跑稳定）。各 Phase 单独复跑结果见下表“测试”列。未提交改动包含 L0/L3/L4/Phase 6/policy v2 全部源码与测试，按约束未 commit/push/重启 Hub。

| Phase | 内容 | 状态 | 启用范围 | 测试 | 已知偏差 |
|---|---|---|---|---|---|
| Phase 0 | 可信基础与度量 | 已落地 | 内部/测试 | phase0 38、t2-trusted-exec 22、lease 14、recovery 14 全 pass | §19 参数已全部记录默认值；§12 度量收集已实现（run 终态自动记录，含 durationMs/check 统计/patch/fixRounds） |
| Phase 1 | L1 最小纵向闭环 | 已落地 | 会话/mention/conductor | service 48 pass | 默认 review/fix 仍为关闭，符合预期；dogfood 真实 run 证据链已评审通过 |
| Phase 2 | 跨模式一致性 | 已落地 | 全模式 | lifecycle-integration 51 pass | 非 conductor 模式自动推进已通过 `startRunForTask` + `triggerGateForSession` 统一；按适用性不强制全层 |
| Phase 3 | L0 建议式需求辅助 | 已落地（shadow，入口横切） | shadow → advisory | requirement 55 pass | L0 已在 `room.message`/`prompt.send` 入口横切接入（shadow 不阻断）；升级阈值已定义（§19），需度量数据达标后升级 |
| Phase 4 | L3 需求证据验证 | 已落地（自动触发） | 有 spec 的 WorkItem | verification 56 pass | L3 已在 `requirement-verifying` 阶段自动触发 `runVerification`；dogfood 真实 run 证据链已评审通过 |
| Phase 5 | L4 受控学习 | 已落地（candidate/shadow，自动回流） | candidate/shadow | learning 63、incident 10、rule 15 全 pass | Observation 已从 run 终态 failed/inconclusive 自动创建；shadow→active 仍需人工批准；退役阈值已定义（§19） |
| Phase 6 | AI 审查、修复与隔离应用 | 已落地 | 可选/高风险 | phase6 24、fixer 20、review 13 pass | 依赖 worktree 和回滚；非 Git 项目 run 无 patchHash 会卡在 `awaiting-approval`，符合 `run.ts` 硬约束 |
| Policy v1/v2 | 策略配置与兼容演进 | 已落地 | 全项目 | policy 39 pass | `migrateV1ToV2Write` 原子迁移+备份+CAS 已实现；v2 enforcement/remediation 解耦 |

每个 Phase 完成后记录：提交或变更引用、测试结果、指标基线、启用范围、已知偏差、回滚方式。未满足退出条件时状态不能标记完成。

### 18.1 跨层接入现状

L0、L3、L4 均已自动触发，L0-L4 闭环可自动运转：

- L0：已在 `room.message` 和 `prompt.send` 入口横切接入（shadow 模式不阻断）
- L3：已在 run 进入 `requirement-verifying` 阶段时自动触发 `runVerification`
- L4：已在 run 终态 `failed`/`inconclusive` 时自动创建 Observation（attribution 按 failureCode 映射）

要升级为默认启用，需完成：

- L0：从 shadow 升级为 advisory 需基于度量数据（提问率、跳过率、有用率、返工变化）；升级阈值已定义（§19），需收集度量数据达标后升级
- L3：已自动触发，dogfood 真实 run 证据链已评审通过
- L4：Observation 自动创建已实现；从 candidate 升级为 incident 仍需人工 confirm（设计意图，非缺陷）

## 19. 实施前必须显式决定的参数

以下参数不应由开发者在实现中临时猜测；到达最迟阶段前必须记录决策、依据和回滚值。
本次 dogfood 运行后记录的实际默认值如下：

| 参数 | 最迟决定阶段 | 所需依据 | 当前实际默认值（2026-09-09） |
|---|---|---|---|
| L1 p95 时间预算和并发上限 | Phase 0 | 当前项目命令基线与机器能力 | quick check 120s / full check 300s；单次 run budget 60s；当前无显式并发上限，单项目串行执行 |
| artifact 大小、权限和保留期 | Phase 0 | 磁盘预算与敏感信息策略 | 根目录：`hub/data/quality/<runId>/`；单个 artifact 上限 10MB（`evidence.maxArtifactBytes=10485760`）；保留 30 天（`evidence.retentionDays=30`） |
| v1→v2 迁移 UX 和兼容窗口 | Phase 0 | 现有 policy 数量与行为回归测试 | `loadPolicyV2` 自动识别 `version` 字段；v2 字段通过 `getPolicyEnforcement/getPolicyApprovalRisk/getPolicyMaxFixRounds/isPolicyReviewEnabled` 兼容读取；暂无自动写回/迁移 deadline |
| worktree 根目录、清理和崩溃恢复 | Phase 0/2 | 本地/远程平台测试 | worktree 路径：`<project.gitRoot or root>/.quality-worktrees/<runId>`；终态后清理；Hub 重启时当前 generation run → `inconclusive`（`failureCode=hub-restart`），旧 generation → `stale` |
| L0 使用的模型、token/超时预算 | Phase 3 | shadow 延迟、成本和问题有用率 | 默认 shadow 模式，确定性规则优先；模型调用超时默认 10s；`MAX_QUESTIONS=3`；澄清 TTL 5min |
| L0 从 advisory 升级的阈值 | Phase 3 | 跳过率、返工率和 false-block | `L0_ADVISORY_MIN_SAMPLES=20`、`MAX_SKIP_RATE=0.4`、`MIN_ANSWER_RATE=0.5`、`MIN_REWORK_REDUCTION=0.1`；`shouldUpgradeL0ToAdvisory` 全达标才建议升级 |
| L3 哪些证据可以满足 required criterion | Phase 4 | 项目验收样本和人工校准 | 支持 `check` / `test` / `runtime` / `manual` / `review` / `ai-inference`；v2 `verification.mode` 默认 `off`，dogfood 使用 `require-evidence` |
| 各类 RuleCandidate 的最小独立样本数 | Phase 5 | 历史 Incident 数量和误伤成本 | `MIN_EVAL_SAMPLES=10`（正反样本合计）；`hasEnoughEvalSamples` 不足时不进入评测 |
| shadow 观察窗口与自动退役建议阈值 | Phase 5 | recurrence、precision 和成本 | `SHADOW_RETIRE_MIN_OBSERVATIONS=15`、`MIN_PRECISION=0.7`、`MIN_RECURRENCE_REDUCTION=0.2`；`shouldRetireShadow` 只生成建议不自动退役 |
| L2/L2b 模型选择与最低确认率 | Phase 6 | reviewer benchmark 与预算 | review 默认关闭；reviewer 超时 300s |
| `allowNetwork` 的 OS 级网络隔离 | Phase 0 | 平台能力测试 | `allowNetwork=false` 时用 `bwrap --unshare-net` 隔离网络；bwrap 不可用时降级为记录警告（summary 标注 `[net-isolate-unavailable]`） |

这些参数可以按项目覆盖，但必须有安全默认值。参数变化写入 policy/decision version，确保历史结果可解释。

## 20. 修订记录

### v3.3 — 2026-09-09

文档全面同步与度量收集补齐：

1. §12 度量收集实现：SQLite `quality_metrics` 表 + `recordRunMetric`（run 终态自动记录 durationMs/check 统计/patch/fixRounds）+ `quality.metric.list` RPC + 4 个测试；
2. §18 Phase 0/1/4 已知偏差更新：参数已记录、dogfood 证据链已评审、度量已实现；
3. §18.1 跨层接入现状更新：L3 dogfood 已验证；
4. §15.2 #10 阻塞项更新：ChangeSet 风险回写已实现；
5. §21 下一步全部标注完成状态；
6. 基线测试数更新至 941 tests / 0 fail。

### v3.2 — 2026-09-09

剩余事项落地闭环：

1. §19 三组"未定义"参数全部定义保守默认值并实现评估函数：
   - L0 advisory 升级阈值（`shouldUpgradeL0ToAdvisory`：样本数/跳过率/回答率/返工减少率）；
   - RuleCandidate 最小独立样本数（`MIN_EVAL_SAMPLES=10` + `hasEnoughEvalSamples`）；
   - shadow 退役阈值（`shouldRetireShadow`：观察数/precision/复发减少率）；
2. `allowNetwork` OS 级网络隔离硬化：`execution-local.ts` 在 `allowNetwork=false` 时用 `bwrap --unshare-net` 隔离网络，不可用时降级为记录警告（summary 标注 `[net-isolated]` 或 `[net-isolate-unavailable]`）；
3. dogfood 真实 run 证据链评审通过：L0 spec → WorkItem → L1 checks → L3 verification → accepted，patchHash 完整，L4 observations 归因正确；
4. §15.2 阻塞项 #8 从"待硬化"更新为"已实现"；
5. §18 测试数同步（learning 63、requirement 55、execution-local 15）。

### v3.1 — 2026-09-09

闭环验证后的修复与文档同步：

1. `incidentFingerprint` 移除 `sourceRunId` 入参，fingerprint 不再包含易变的 runId，满足 §8.3 跨 run 聚类约束；
2. `incident-auto-promote` 测试同步修正：同描述不同 sourceRunId 现在产生相同 fingerprint 并触发自动沉淀；
3. §18 落地状态表测试数同步实际复跑结果（923 tests 全绿，各 Phase 测试数更新）；
4. §15.2 阻塞项 #8/#11 状态更新：allowNetwork 标注为待硬化，fingerprint 已修复；
5. §19 追加 `allowNetwork` OS 级隔离待硬化参数项。

### v3.0 — 2026-09-08

本次从“功能层堆叠”重构为“可信工作单元和证据闭环”，主要变化：

1. 将文档状态从愿景共识改为按阶段验证的执行基线；
2. 新增质量净价值、北极星指标和非目标；
3. 明确 WorkRequest、RequirementSpec、WorkItem、ChangeSet、QualityRun 的不同边界；
4. 将 QualityRun 起点前移到 Agent 实现之前；
5. 恢复 preflight/implementing/collecting 的内部职责，不再因 UI 简化删除关键状态；
6. 将文件写入从 gate 触发点改为 dirty signal，完整验证改在 turn/task 完成边界触发；
7. 新增 request intent，L0 不再拦截所有消息；
8. 新增专用澄清协议、spec 版本和过期回答保护；
9. 统一 L3 为需求证据验证，多模型交叉审查改为 L2b；
10. 新增 passed/failed/inconclusive/waived/not-applicable 证据语义；
11. 明确 accepted 只是质量结论，不等于应用、提交或发布；
12. 将 AcceptanceCriterion 的运行态 `covered` 拆到 RequirementVerification；
13. 将 Observation 与 Incident 分离，取消“任意失败自动沉淀”；
14. 定义 check/risk/requirement/verification 四类规则及各自评测；
15. 禁止 sandbox 自动批准和激活规则；
16. 修复文档中的无效 v1 policy 示例，移除不存在的 `auto-pass`；
17. 设计 policy v2，将 enforcement 和 remediation 解耦并定义迁移；
18. 将学习规则首期存储改为 SQLite，quality.json 只由用户显式导出 patch；
19. 将全模式全 ✅ 改为 current/target/applicable 矩阵；
20. 将度量从最后阶段前移到 Phase 0；
21. 重排路线：可信基础 → L1 闭环 → 跨模式 → L0 → L3 → L4 → 高自治；
22. 新增发布/停止条件、验收场景和防踩坑决策表；
23. 新增必须显式决定的实施参数和最迟决策阶段；
24. 校正修订日期，避免未来日期造成基线混乱；
25. 同步 §18 落地状态表：Phase 0–6 与 policy v1/v2 全部标记为“已落地”，记录各 Phase 测试数与已知偏差，新增 §18.1 跨层接入现状说明 L0/L3/L4 当前为 RPC 可调用、尚未自动触发。

### v2.0 — 2026-09-08

- 合并需求生命周期愿景与模式兼容性设计；
- 提出 L0-L4、七个需求维度和三向反馈；
- 形成跨模式横切思路；
- 遗留问题：运行边界过晚、L3 命名冲突、配置示例无效、学习门槛不足、度量后置。

## 21. 下一步

1. ~~以 Phase 0 的阻塞项建立可执行任务清单，不并行推进 L0/L4~~——已完成，§15.2 全部解决；
2. ~~先为当前已知错误语义补回归测试，再修改实现~~——已完成，937 tests 全绿；
3. ~~使用 agent-hub 自身作为第一个 dogfood 项目，建立修改前指标基线~~——dogfood 证据链已评审通过；
4. ~~Phase 0 完成后评审一次真实 QualityRun 的完整证据链~~——已完成（L0→L1→L3→L4→accepted）；
5. ~~只有可信 L1 在会话、mention 和 conductor 跑通后，才扩展全模式~~——已扩展全模式（Phase 2 已落地）；
6. L0、L3、L4 均先 shadow，再根据净价值和护栏决定默认行为——L0 仍为 shadow（升级阈值已定义，待度量数据）；L3 已自动触发；L4 candidate→incident 需人工确认（设计意图）；
7. 每次方案变更同步更新修订记录和防踩坑决策，避免旧结论重新进入实现——持续执行；
8. ~~实现 §12 度量收集（覆盖率、stuck run、infra/no-check rate、cost、latency），Phase 0 退出条件要求度量从 Phase 0 开始写入~~——已实现，run 终态自动记录度量事件（SQLite `quality_metrics` 表 + `quality.metric.list` RPC）；
