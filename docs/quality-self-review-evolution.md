# Agent-Hub 质量控制平面：自审查、自修复与受控进化落地方案

> 状态：待评审、待拆分执行
> 版本：2.0
> 制定日期：2026-09-06
> 制定时代码基线：`8f9d232`
> 适用范围：Hub、Desktop、Android，以及通过 agent-hub 开发的外部项目

## 1. 目标与产品定位

把 agent-hub 从“多 Agent 对话编排器”升级为“跨模型、跨后端、可验证、可恢复的质量控制平面”。

目标不是让更多 Agent 互相讨论，而是让任何代码变更都能经历一条有证据、可追踪、可回滚的质量链路：

```text
需求/缺陷/巡检信号
  → 受控实现
  → 捕获真实变更集
  → 确定性验证
  → 独立审查
  → 修复与复验
  → 候选结果
  → 按风险批准或应用
  → 缺陷与规则沉淀
  → 用评测证明下一版优于上一版
```

最终希望实现：

1. 使用 agent-hub 开发的项目比直接使用单个原生 Agent 更少出现回归、漏洞和跨层状态错误。
2. 质量结论来自真实命令、真实 patch 和可复现证据，而不是 Agent 自述。
3. 同一套质量能力覆盖 Devin、Codex、Claude、OpenCode 等 ACP 后端。
4. 质量运行可以跨 Hub 重启恢复，并在 Desktop/Android 上观察、批准和追踪。
5. 系统能够从真实缺陷中生成回归资产和规则候选，但任何“进化”都必须经过评测、隔离和回滚门禁。

## 2. 第一性原理与不可破坏的约束

### 2.1 质量的本质是有证据的状态提升

“Agent 说完成了”不是完成；只有候选变更满足明确验收标准，并且验证证据可复现，才能进入可接受状态。

证据可信度从高到低：

1. 独立执行器的退出码、测试报告、构建产物；
2. 基线失败、候选通过的差分回归测试；
3. 静态分析、类型检查、lint、依赖审计；
4. 独立 reviewer 给出的可定位、可复现 finding；
5. 实现 Agent 的自检与文字总结。

低级证据不能覆盖高级证据。例如，reviewer 说“没有问题”不能覆盖测试失败。

### 2.2 自进化是受约束优化，不是自动改代码

系统只有在以下条件同时成立时，才能宣称发生了“进化”：

- 有稳定的旧版本基线；
- 有覆盖真实失败模式的评测集；
- 候选版本在相同任务、模型和预算下优于或不劣于旧版本；
- 没有破坏安全、权限、数据完整性等硬约束；
- 结果可回滚；
- 评价器、质量策略和保护规则没有被候选实现偷偷放宽。

### 2.3 生产者不能成为唯一验证者

- 实现者可以自检，但不能决定最终通过；
- 确定性检查由独立执行器运行；
- reviewer 使用独立会话，推荐与实现者使用不同模型族；
- reviewer 默认只读，不能直接修改候选代码；
- 有争议的重大 finding 由复现结果、第二 reviewer 或用户裁决。

### 2.4 项目是质量边界，Room 只是协作边界

质量配置、变更集、运行记录、规则和指标必须绑定项目，而不是绑定 Room。

项目身份定义为：

```text
ProjectScope = connectionId + canonical(gitRoot || cwd)
```

原因：

- 一个 Room 可能包含多个 cwd；
- 一个项目可能同时被单聊和多个 Room 使用；
- mention、pipeline、conductor、定时任务都可能修改同一项目；
- 验证命令、Git revision 和回归测试天然属于项目。

### 2.5 默认隔离、最小权限、可恢复

- 同一 ProjectScope 同一时间最多一个 writer，除非每个任务有独立 worktree；
- reviewer 只能读代码和运行允许的无副作用检查；
- 质量规则、权限代码、验证器、自进化逻辑属于保护区域；
- 所有长流程持久化，Hub 重启后不能把运行中的任务误判为完成；
- 自动化必须有预算、超时、重试上限、冷却和 quarantine。

## 3. 当前能力与必须补齐的缺口

### 3.1 可复用能力

| 现有能力 | 可复用方式 |
|---|---|
| Session/Room/角色卡 | 承载 planner、implementer、reviewer、QA 等角色 |
| Conductor | 负责需求拆解和任务依赖，不负责充当质量真相源 |
| Pipeline/Parallel/Debate | 用于不同评审策略和方案比较 |
| SessionLedger/Room artifacts/events | 作为 UI 观察数据，不作为真实 ChangeSet 的唯一来源 |
| SQLite/WAL | 存储质量运行、检查、finding 和规则候选 |
| Scheduler | 只负责触发质量运行，不负责管理长流程 |
| ACP permission | 作为权限入口，后续扩展为按 session/run 的工具策略 |
| Desktop/Android Flow 面板 | 展示质量阶段摘要和审批入口 |
| per-session 模型切换 | 为 planner/reviewer 配置强模型，为普通 worker 配置成本模型 |

### 3.2 当前阻碍

1. `prompt.done` 内部输出只有最后 800 字符，长 JSON 和 review finding 会被截断。
2. Conductor 收到 `prompt.done` 就把任务标记为 done，没有验证阶段。
3. Conductor 当前把 failed dependency 当作可继续执行的依赖。
4. artifact 和 tool_call 只能辅助追踪，无法证明任务真实 patch。
5. FS 写入记录未绑定活动 `runId/taskId`。
6. 当前 Hub 没有独立命令执行服务；远程 worker 只有字节转发。
7. 全局 permission bypass 无法保证 reviewer 只读。
8. Blackboard 只有最近 10 条，不适合做质量账本。
9. Scheduler 的成功仅代表消息成功派发，不代表质量流程完成。
10. Hub 有单元测试，但 Desktop/Android 没有自动化测试；仅编译无法抓住 UI 和跨层状态 bug。
11. AGENTS.md 是人类文档，不是安全、稳定的机器执行配置。
12. 目前没有原生 Agent 与质量流程的同条件对比评测，不能证明增益。

## 4. 目标架构

```text
                         ┌──────────────────────────────┐
用户/Conductor/Scheduler ─→ QualityService              │
                         │  - 状态机                    │
                         │  - 风险分类                  │
                         │  - 重试/预算/恢复            │
                         └──────────────┬───────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
      ProjectRegistry             ChangeSetCollector        RunLedger
      项目身份/能力               baseline/patch/hash       SQLite 持久化
             │                          │                          │
             ▼                          ▼                          ▼
      ExecutionProvider           ReviewOrchestrator        LearningEngine
      local/remote checks         独立只读 reviewer          incident/rule/eval
             └──────────────────────────┼──────────────────────────┘
                                        ▼
                               Desktop / Android
                           状态、证据、finding、审批
```

### 4.1 模块职责

#### `quality/project.ts` — ProjectRegistry

- 根据 connectionId、cwd、Git root 生成稳定 projectId；
- 检测项目是否为 Git 仓库；
- 记录项目执行能力：本地执行、远程执行、Git、容器；
- 防止同名路径在不同机器上被错误视为同一项目；
- 解析并校验项目质量策略。

#### `quality/run.ts` — QualityService

- 创建、推进、取消和恢复 QualityRun；
- 保证状态转换合法；
- 管理 writer lease、重试预算和超时；
- 调用 ChangeSetCollector、GateEngine、ReviewOrchestrator；
- 广播 `quality.runUpdate`；
- 不直接执行 shell，不直接解析 reviewer 自由文本。

#### `quality/change-set.ts` — ChangeSetCollector

Git 项目：

- 记录 base commit；
- 记录运行前已有 dirty patch 的 hash；
- 生成候选 `git diff --binary --no-ext-diff`；
- 记录 changed files、增删行、patch hash；
- 标记测试、策略、权限、部署等高风险路径；
- 检测运行外修改和并发污染。

非 Git 项目：

- P0/P1 默认只报告，不自动修复；
- 后续可使用受限文件 manifest/hash 快照；
- 没有可靠快照时不得进入自动应用级别。

#### `quality/execution.ts` — ExecutionProvider

统一接口：

```ts
interface ExecutionProvider {
  run(project: ProjectScope, check: CheckDefinition, runId: string): Promise<CheckRun>;
  cancel(runId: string, checkId?: string): Promise<void>;
}
```

实现：

- `LocalExecutionProvider`：在 Hub 所在机器执行；
- `WorkerExecutionProvider`：通过远程 worker 控制通道，在拥有项目目录的机器执行；
- Agent 自己运行并汇报的命令只记作 `reported-check`，不能作为硬门禁。

#### `quality/gate.ts` — GateEngine

- 选择受影响检查；
- quick checks 失败时快速打回；
- full checks 在候选完成后运行；
- 区分代码失败、基础设施失败、超时、取消；
- 保存退出码、耗时、截断摘要和完整输出 artifact；
- 不允许 reviewer 覆盖确定性失败。

#### `quality/review.ts` — ReviewOrchestrator

- 为 reviewer 构造任务契约、真实 patch、检查结果和项目约定；
- reviewer 使用独立 session；
- 强制只读工具策略；
- 接收结构化 finding；
- 对 blocking finding 触发 fixer；
- 修复后重新生成 patch、重跑 gate、再审或抽样复审；
- 控制最大回合数与模型预算。

#### `quality/learning.ts` — LearningEngine

- 用户报告 bug、验证失败和被确认的 finding 形成 incident；
- 聚类重复 failure fingerprint；
- 生成回归测试建议和规则候选；
- 用历史评测验证规则效果；
- 规则只有经过批准和效果验证后才能激活；
- 不直接自动修改 AGENTS.md。

#### `quality/scheduler-adapter.ts`

- Scheduler 到点后只调用 `QualityService.startRun()`；
- 使用 project lease 防止重复巡检；
- 记录 misfire、跳过、重复抑制；
- 定时任务日志引用最终 runId 和 verdict，而不是记录“消息已发送”。

## 5. 核心数据模型

### 5.1 ProjectScope

```ts
type ProjectScope = {
  id: string;
  connectionId: string;
  root: string;
  gitRoot?: string;
  displayName: string;
  capabilities: {
    git: boolean;
    localExec: boolean;
    remoteExec: boolean;
    isolatedWorktree: boolean;
  };
  policyVersion?: string;
  createdAt: number;
  updatedAt: number;
};
```

projectId 必须包含 connectionId，不能只对路径做 hash。

### 5.2 QualityPolicy

项目机器配置建议放在 `.devin/quality.json`。AGENTS.md 继续作为人类规范和发现来源，不直接执行其中代码块。

```ts
type QualityPolicy = {
  version: 1;
  checks: CheckDefinition[];
  protectedPaths: string[];
  riskRules: RiskRule[];
  review: {
    enabled: boolean;
    reviewerSessionId?: string;
    blockSeverity: "critical" | "major";
    minBlockingConfidence: number;
    maxFixRounds: number;
  };
  autonomy: "observe" | "propose" | "isolated-fix" | "apply-low-risk";
};

type CheckDefinition = {
  id: string;
  cwd: string;
  argv: string[];
  tier: "quick" | "full";
  timeoutMs: number;
  paths?: string[];
  required: boolean;
  allowNetwork?: boolean;
};
```

约束：

- `cwd` 必须在 ProjectScope 内；
- 默认不通过 shell 解释字符串；
- 环境变量使用白名单，不继承秘密值到日志；
- 新发现命令先进入建议状态，由用户确认后写入 policy；
- 修改 policy 本身必须人工批准。

### 5.3 QualityRun

```ts
type QualityStage =
  | "queued"
  | "preflight"
  | "implementing"
  | "collecting"
  | "quick-verifying"
  | "reviewing"
  | "fixing"
  | "full-verifying"
  | "awaiting-approval"
  | "accepted"
  | "failed"
  | "cancelled"
  | "quarantined";

type QualityRun = {
  id: string;
  projectId: string;
  roomId?: string;
  taskId?: string;
  implementerSessionId?: string;
  reviewerSessionId?: string;
  trigger: "interactive" | "conductor" | "scheduled" | "incident";
  stage: QualityStage;
  risk: "low" | "medium" | "high" | "critical";
  policyVersion: string;
  baseRevision?: string;
  dirtyBaselineHash?: string;
  patchHash?: string;
  fixRound: number;
  budget: { maxFixRounds: number; timeoutMs: number };
  verdict?: "pass" | "fail" | "needs-approval";
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};
```

### 5.4 CheckRun

```ts
type CheckRun = {
  id: string;
  runId: string;
  checkId: string;
  attempt: number;
  status: "queued" | "running" | "passed" | "failed" | "timeout" | "cancelled" | "infra-failed";
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  startedAt?: number;
  completedAt?: number;
};
```

### 5.5 ChangeSet

```ts
type ChangeSet = {
  runId: string;
  baseRevision?: string;
  patchArtifact: string;
  patchHash: string;
  files: Array<{
    path: string;
    status: "add" | "modify" | "delete" | "rename";
    additions?: number;
    deletions?: number;
  }>;
  preexistingDirty: boolean;
  contaminated: boolean;
  riskReasons: string[];
};
```

### 5.6 ReviewFinding

```ts
type ReviewFinding = {
  id: string;
  runId: string;
  severity: "critical" | "major" | "minor" | "info";
  confidence: number;
  category: "correctness" | "security" | "data" | "concurrency" | "performance" | "ux" | "maintainability";
  file?: string;
  line?: number;
  claim: string;
  evidence: string;
  reproduction?: string;
  suggestion?: string;
  blocking: boolean;
  status: "open" | "fixed" | "dismissed" | "accepted-risk";
  resolutionNote?: string;
};
```

### 5.7 RuleCandidate 与 Incident

```ts
type QualityIncident = {
  id: string;
  projectId: string;
  sourceRunId?: string;
  description: string;
  fingerprint: string;
  severity: string;
  reproduction?: string;
  regressionTest?: string;
  status: "open" | "covered" | "accepted-risk";
};

type RuleCandidate = {
  id: string;
  projectId: string;
  fingerprint: string;
  rule: string;
  evidenceIncidentIds: string[];
  recurrence: number;
  measuredImpact?: string;
  status: "candidate" | "approved" | "active" | "retired" | "rejected";
};
```

## 6. 任务状态机

```text
queued
  ↓
preflight
  ├─ 项目不存在/执行器不可用 → failed
  ├─ 工作区有未知并发写入 → quarantined
  └─ 获取 writer lease + baseline → implementing

implementing
  ├─ Agent 失败/取消 → failed/cancelled
  └─ prompt 完整结束 → collecting

collecting
  ├─ 无变更且任务要求修改 → failed
  ├─ 检测到污染 → quarantined
  └─ ChangeSet 就绪 → quick-verifying

quick-verifying
  ├─ 失败且有修复预算 → fixing
  ├─ 失败且无预算 → failed
  └─ 通过 → reviewing 或 full-verifying

reviewing
  ├─ blocking finding 且有预算 → fixing
  ├─ blocking finding 且无预算 → awaiting-approval/failed
  └─ 无 blocking finding → full-verifying

fixing
  └─ fixer 完成 → collecting

full-verifying
  ├─ 失败且有预算 → fixing
  ├─ 失败且无预算 → failed
  ├─ 高风险/策略要求 → awaiting-approval
  └─ 低风险且允许自动应用 → accepted

awaiting-approval
  ├─ 用户批准 → accepted
  ├─ 用户拒绝 → failed
  └─ 用户要求修改 → fixing
```

硬约束：

- 只有 `accepted/failed/cancelled/quarantined` 是终态；
- failed dependency 不能解锁下游任务；
- 每次 fixing 后必须重新生成 ChangeSet；
- full verification 不复用修复前结果；
- policyVersion 和 patchHash 必须写入每个 verdict；
- Hub 重启时 `implementing/running check` 回到可判定状态，不直接标记通过。

## 7. 变更隔离与并发策略

### 7.1 第一阶段：项目写锁

为了尽快落地，P0/P1 不立即实现复杂 worktree 编排，而是：

- 每个 ProjectScope 同一时间一个 writer；
- planner/reviewer 可并行读；
- 其他写任务进入队列；
- run 开始前记录已有 dirty patch；
- 如果工作区本来就有未归属修改：
  - 默认降级为 observe/propose；
  - 用户明确允许后才能继续；
  - 不能把旧修改归到本次 run。

### 7.2 第二阶段：隔离 worktree

Git 项目为每个写任务创建临时 worktree：

```text
<quality-data>/worktrees/<projectId>/<runId>
```

- 基于固定 base revision；
- 为 worktree 创建临时 ACP session，因为 session cwd 创建后不可变；
- 实现者只写自己的 worktree；
- reviewer 只读该 worktree；
- 产出 patch artifact；
- 用户批准后应用 patch；
- 清理 worktree 前确认 run 已持久化且 patch 已保存。

禁止并行 Agent 直接修改同一主工作区。

## 8. 本地与远程命令执行

### 8.1 本地执行

`LocalExecutionProvider` 使用 `cross-spawn`：

- `shell: false`；
- cwd 通过 realpath 校验；
- stdout/stderr 流式写入 artifact；
- UI 只接收有长度上限的增量；
- timeout 后先温和终止，再强制结束；
- 不允许环境变量秘密进入日志；
- 每个 run 可取消。

### 8.2 远程执行

在 multiplex/worker 控制通道增加：

```text
quality.exec.request
quality.exec.output
quality.exec.result
quality.exec.cancel
quality.project.describe
```

请求至少包含：

```ts
{
  requestId,
  runId,
  projectRoot,
  cwd,
  argv,
  timeoutMs,
  envNames,
  allowNetwork
}
```

worker 侧必须：

- 确认 root 属于该 connection 的允许目录；
- 拒绝路径逃逸和未知 projectId；
- 不接受 Hub 临时发送的任意绝对 cwd；
- 控制最大并发与输出；
- 断线后能上报未知/中断状态；
- 不能把“连接中断”记录为测试失败。

ACP terminal 能力可以继续用于 Agent 的交互式工具，但质量硬门禁不能依赖 Agent 自己决定是否运行和如何汇报。

## 9. 确定性验证策略

### 9.1 检查分层

#### Quick checks

- 受影响模块的类型检查；
- 针对性测试；
- 格式/lint；
- 低成本静态检查。

#### Full checks

- 全量测试；
- 完整构建；
- Rust/Android 等跨语言检查；
- 可选集成/E2E；
- 高风险路径的专项安全检查。

### 9.2 agent-hub 初始质量策略建议

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
      "paths": ["hub/**"],
      "required": true
    },
    {
      "id": "hub-tests",
      "cwd": "hub",
      "argv": ["npm", "test"],
      "tier": "full",
      "timeoutMs": 180000,
      "paths": ["hub/**"],
      "required": true
    },
    {
      "id": "desktop-typecheck",
      "cwd": "desktop",
      "argv": ["npx", "tsc", "--noEmit"],
      "tier": "quick",
      "timeoutMs": 120000,
      "paths": ["desktop/src/**"],
      "required": true
    },
    {
      "id": "desktop-build",
      "cwd": "desktop",
      "argv": ["npm", "run", "build"],
      "tier": "full",
      "timeoutMs": 240000,
      "paths": ["desktop/**"],
      "required": true
    },
    {
      "id": "tauri-check",
      "cwd": "desktop/src-tauri",
      "argv": ["cargo", "check"],
      "tier": "full",
      "timeoutMs": 600000,
      "paths": ["desktop/src-tauri/**"],
      "required": true
    },
    {
      "id": "android-compile",
      "cwd": "android",
      "argv": ["./gradlew", ":app:compileDebugKotlin"],
      "tier": "quick",
      "timeoutMs": 600000,
      "paths": ["android/**"],
      "required": true
    },
    {
      "id": "android-assemble",
      "cwd": "android",
      "argv": ["./gradlew", "assembleDebug"],
      "tier": "full",
      "timeoutMs": 900000,
      "paths": ["android/**"],
      "required": true
    }
  ],
  "protectedPaths": [
    ".devin/quality.json",
    "hub/src/agent.ts",
    "hub/src/quality/**",
    "hub/src/worker.ts",
    "hub/src/multiplex-worker.ts"
  ],
  "review": {
    "enabled": true,
    "blockSeverity": "major",
    "minBlockingConfidence": 0.8,
    "maxFixRounds": 2
  },
  "autonomy": "propose"
}
```

此配置是方案样例，落地时由用户确认后再创建。

### 9.3 Bug 修复的差分验收

对可自动测试的 bug，优先要求：

1. 新回归测试在 base revision 上失败；
2. 同一测试在 candidate patch 上通过；
3. 原有 full checks 不回归；
4. reviewer 验证测试没有只迎合当前实现；
5. 测试文件修改与生产代码修改分别展示。

如果 UI/系统行为暂时无法自动化，必须明确标记为 `manual-evidence-required`，不能伪装为完全通过。

## 10. 独立审查设计

### 10.1 Reviewer 输入

```text
- 原始用户目标与验收标准
- projectId、base revision、patch hash
- 完整 changed files 列表与真实 patch
- 相关 AGENTS.md 规则
- quick/full check 结果及失败历史
- 风险分类结果
- 明确声明：只报告会导致错误、安全问题、数据损坏、严重退化或违反需求的问题
```

Reviewer 应拥有完整仓库只读访问和安全检查执行能力，而不是只看 diff 摘要。

### 10.2 Reviewer 输出

初期使用完整 prompt output 中的严格 JSON；稳定后可增加专用结构化提交接口。禁止从最后 800 字符中解析。

```json
{
  "verdict": "pass | needs-fix | uncertain",
  "findings": [
    {
      "severity": "critical | major | minor | info",
      "confidence": 0.92,
      "category": "correctness",
      "file": "hub/src/example.ts",
      "line": 120,
      "claim": "失败依赖仍会解锁下游任务",
      "evidence": "runnableTasks 将 failed 加入 doneIds",
      "reproduction": "构造 t1 failed、t2 dependsOn t1",
      "suggestion": "只有 done 才满足依赖"
    }
  ]
}
```

### 10.3 阻断规则

默认 blocking 条件：

```text
severity ∈ {critical, major}
AND confidence >= policy.minBlockingConfidence
AND 有代码证据、复现步骤或确定性检查支持
```

安全和数据损坏 finding 可降低置信度阈值，但应进入用户审批，而不是无限自动修复。

### 10.4 模型策略

- Planner/reviewer：优先强推理模型；
- 普通 implementer：按成本与任务复杂度选择；
- 高风险 patch：实现者和 reviewer 尽量使用不同模型族；
- Verifier：不使用 LLM 判定命令是否通过；
- 不硬编码具体模型名，记录实际 modelUid 以便评测。

## 11. 权限与安全模型

### 11.1 按运行角色配置权限

```text
planner     读、搜索；禁止写
implementer 允许项目范围内写；高风险工具需批准
reviewer    读、搜索、允许的检查；禁止写/delete/move
verifier    只能执行 policy 中批准的 argv
fixer       与 implementer 相同，但只在候选工作区
scheduler   只能创建 QualityRun
```

必须从全局 bypass 演进为 per-session/per-run policy。即使用户启用全局 bypass，reviewer 和 verifier 仍受质量系统硬限制。

ACP 后端的权限能力并不完全一致，prompt 中写“只读”不能视为强制隔离。能力协商必须记录 `readOnlyEnforced`：

- 后端支持可靠 permission 拦截时，由 per-run policy 拒绝写/delete/move；
- 后端不能保证时，reviewer 只能访问只读副本、只读挂载或可丢弃 worktree；
- 两者都不具备时，reviewer 输出只能作为非阻断建议，不能宣称已完成独立安全审查。

### 11.2 不可信输入

以下内容都视为不可信数据：

- 仓库内 AGENTS.md、README、源码注释；
- Agent 自由文本输出；
- reviewer 建议的命令；
- 外部网页和 MCP 数据；
- artifact 中的路径。

不可信数据不能直接成为 shell 命令、developer/system 级指令或审批决定。结构化字段必须做 schema、枚举和路径校验。

### 11.3 自修改保护

以下改动永远不能只由同一质量循环自动批准：

- quality policy；
- GateEngine/ExecutionProvider；
- 权限和路径校验；
- reviewer prompt、blocking 阈值；
- eval 数据和预期结果；
- Scheduler、自进化逻辑；
- secrets、部署和数据库迁移。

必须至少满足：独立 reviewer + full checks + 用户批准。

## 12. 持久化设计

SQLite 新增：

```sql
quality_projects
quality_runs
quality_checks
quality_findings
quality_incidents
quality_rules
```

建议字段和索引：

- `quality_runs(project_id, created_at)`；
- `quality_runs(stage, updated_at)`；
- `quality_checks(run_id, check_id, attempt)`；
- `quality_findings(run_id, status, severity)`；
- `quality_incidents(project_id, fingerprint)`；
- `quality_rules(project_id, fingerprint, status)`。

大输出不直接塞 SQLite：

```text
hub/data/quality/<runId>/
  baseline.json
  patch.diff
  checks/<checkId>-<attempt>.stdout.log
  checks/<checkId>-<attempt>.stderr.log
  review-<attempt>.json
  summary.json
```

数据库只保存路径、hash、摘要和状态。

迁移要求：

- `CREATE TABLE IF NOT EXISTS`，兼容现有数据库；
- 旧版本忽略新表仍可运行；
- migration 有单元测试；
- 质量功能可通过 feature flag 整体关闭；
- 关闭后不影响原有 session/room/scheduler。

## 13. Hub RPC 与事件

### 13.1 RPC

```text
quality.project.list
quality.project.get
quality.policy.detect
quality.policy.validate
quality.policy.get
quality.policy.update

quality.run.start
quality.run.list
quality.run.get
quality.run.cancel
quality.run.approve
quality.run.reject
quality.run.retry

quality.finding.resolve
quality.rule.list
quality.rule.approve
quality.rule.reject
quality.incident.list
quality.incident.create
```

### 13.2 推送事件

```text
quality.runUpdate
quality.checkOutput
quality.findingUpdate
quality.approvalRequired
quality.ruleCandidate
```

所有事件都必须带 `runId/projectId`，客户端通过 RPC 获取完整状态，事件只用于通知刷新，避免丢事件造成状态错误。

## 14. 与现有编排模式集成

### 14.1 Conductor

Conductor 继续负责：

- 拆解任务；
- 指定 session；
- 建立依赖；
- 汇总已被质量系统接受的结果。

QualityService 负责：

- worker 是否真正完成；
- 变更集；
- 验证、审查、修复；
- 最终 verdict。

Conductor 只有在对应 QualityRun 为 accepted 后，才能把写任务标记 done。

### 14.2 Pipeline

可以把 pipeline 成员配置为：

```text
planner → implementer → reviewer → QA
```

但 pipeline 展示顺序不是质量真相源；GateEngine 的状态仍独立持久化。

### 14.3 单聊与 mention

质量能力不能只覆盖 conductor：

- 单聊写入结束后可提示“运行质量检查”；
- policy 可配置自动启动 quick gate；
- mention 模式中的写任务同样创建 QualityRun；
- 只回答问题、没有文件变化的 turn 不启动代码质量流程。

### 14.4 Scheduler

质量巡检任务绑定 projectId，而不是 roomId。room/session 只用于展示结果和接收通知。

## 15. Desktop 与 Android 产品形态

### 15.1 质量中心

Desktop 和 Android 均增加独立“质量”入口，避免把所有状态塞入聊天或黑板。

至少展示：

- 项目列表和执行能力；
- 当前/历史 QualityRun；
- 阶段、风险、implementer/reviewer/model；
- changed files 和 patch 摘要；
- 每个 check 的状态、耗时和日志；
- findings 及其处理状态；
- 用户批准/拒绝/要求修复；
- incident、规则候选和趋势。

### 15.2 聊天内展示

聊天只显示摘要卡片：

```text
质量运行 Q-123
阶段：审查中
Quick checks：4/4
Findings：1 major
[查看详情] [取消]
```

Flow 面板可以显示关联 run 状态，但完整数据来自 QualityService。

### 15.3 首期 UI 最小范围

P0/P1 不做复杂图表，只完成：

- 运行列表；
- check 状态和日志；
- 最终 verdict；
- 取消与批准；
- Hub 重启后恢复显示。

趋势、规则管理和月报放到 P3/P4。

## 16. 自学习与受控进化闭环

### 16.1 缺陷进入系统

来源：

- 用户明确报告；
- 确定性检查失败；
- reviewer finding 被确认；
- 发布后回滚；
- 定时巡检发现；
- 同类修复反复出现。

流程：

```text
Incident
  → fingerprint
  → 尝试生成最小复现/回归测试
  → base-fail/candidate-pass 验证
  → 加入项目回归资产
  → 统计重复模式
  → 生成 RuleCandidate
```

### 16.2 规则候选生命周期

```text
candidate
  → 有足够真实 incident 证据
  → 在历史 eval 上不降低总体表现
  → 用户批准
  → active
  → 持续测量复发率与误伤
  → ineffective/冲突时 retired
```

禁止“出现三次就自动写 AGENTS.md”。频率只是候选信号，不是正确性证明。

### 16.3 自进化执行

定时或手动触发：

1. 读取质量趋势和高价值 incident；
2. 选择可操作、可验证的最弱项；
3. 在隔离工作区创建 QualityRun；
4. planner 生成改进假设和验收标准；
5. implementer 生成候选 patch；
6. 跑回归集、full checks、独立 review；
7. 与旧版本在固定 eval 上比较；
8. 只输出候选、证据和影响；
9. 按 autonomy/risk 决定等待批准或应用；
10. 失败候选保留报告但不污染主工作区。

## 17. 如何证明超越原生 Agent

### 17.1 评测集

从 agent-hub 历史真实缺陷建立第一批 20～30 个任务：

- 模型切换后顶部状态未刷新；
- Android 长 Markdown 后半段无法选中；
- 单聊回复泄漏到群聊历史/黑板/产物；
- Hub 重启后的会话恢复；
- Windows 托盘菜单一闪而逝；
- artifact/event 归属错误；
- flow 依赖和失败恢复；
- scheduler 重复触发/日志语义；
- 路径逃逸和权限边界。

每个任务固定：

```text
base revision
问题描述
允许修改范围
验收检查
隐藏回归检查
最大模型/token/时间预算
```

### 17.2 对照组

用相同模型和预算比较：

1. 原生 Agent 单会话；
2. agent-hub 当前编排；
3. agent-hub + deterministic gate；
4. agent-hub + gate + independent reviewer；
5. agent-hub + 完整学习闭环。

### 17.3 核心指标

| 指标 | 含义 |
|---|---|
| task resolved rate | 隐藏验收全部通过比例 |
| escaped defect rate | 流程通过后仍出现的真实缺陷 |
| first-pass verification rate | 第一次实现直接通过比例 |
| regression evidence rate | bug 是否有 base-fail/candidate-pass 证据 |
| reviewer precision | finding 被确认或促成代码修改的比例 |
| reviewer dismissal rate | 误报/低价值 finding 比例 |
| rollback/reopen rate | 变更后撤销或再次修复比例 |
| infra/flaky rate | 非代码失败比例 |
| time/token/cost | 质量提升付出的代价 |
| rule recurrence delta | 规则启用前后问题复发变化 |

不把 TODO 数量、代码行数和一般复杂度作为主要优化目标。

### 17.4 发布判断

只有在足够样本上满足以下条件，才宣称质量方案有效：

- 解决率不低于对照组；
- 严重 escaped defect 明显下降；
- reviewer finding 有可接受的确认率；
- 成本和延迟在配置预算内；
- 没有安全门禁退化；
- 结果可重复。

## 18. 分阶段落地计划与任务跟踪

状态定义：

- `[ ]` 未开始
- `[~]` 进行中
- `[x]` 完成并验收
- `[!]` 阻塞
- `[-]` 取消

### P0-A：状态机与可信输出

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q0-01 | [ ] | 定义 QualityRun/CheckRun/Finding 类型与状态转换 | `hub/src/quality/types.ts`, `run.ts` | 无 | 非法转换被拒绝；状态机单测覆盖终态/重试/取消 |
| Q0-02 | [ ] | 新增质量表和 CRUD | `hub/src/store.ts` | Q0-01 | 新旧 DB 均能启动；往返与索引测试通过 |
| Q0-03 | [ ] | 内部编排获取完整 turn output，UI 仍可截断 | `hub/src/agent.ts`, `index.ts` | 无 | 超过 10KB 的结构化结果可完整解析；不会重复写聊天历史 |
| Q0-04 | [ ] | 修复 failed dependency 解锁下游问题 | `hub/src/conductor.ts` | 无 | failed 上游时下游不派发；有回归测试 |
| Q0-05 | [ ] | QualityRun RPC 与广播骨架 | `hub/src/index.ts`, `agent.ts` | Q0-01, Q0-02 | start/get/list/cancel 可用，重启后状态存在 |

### P0-B：项目身份与执行器

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q0-06 | [ ] | ProjectRegistry 和稳定 projectId | `hub/src/quality/project.ts` | Q0-02 | 同路径不同 connection 不冲突；realpath/path escape 测试通过 |
| Q0-07 | [ ] | `.devin/quality.json` schema、加载和校验 | `hub/src/quality/policy.ts` | Q0-06 | 非法 cwd/argv/timeout 被拒绝；AGENTS 仅生成建议 |
| Q0-08 | [ ] | LocalExecutionProvider | `hub/src/quality/execution-local.ts` | Q0-06, Q0-07 | exit code、timeout、取消、输出截断/落盘均有测试 |
| Q0-09 | [ ] | WorkerExecutionProvider 协议 | `worker.ts`, `multiplex-worker.ts`, `stream.ts` | Q0-06, Q0-07 | 命令在远程机器执行；断线和取消可判定；越界拒绝 |
| Q0-10 | [ ] | CheckRun 持久化与恢复 | `hub/src/quality/run.ts`, `store.ts` | Q0-08, Q0-09 | Hub 重启不产生假通过；未知运行状态可重试/人工处理 |

### P0-C：真实变更集、隔离与权限

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q0-11 | [ ] | 活动 run/task/session 映射 | `hub/src/index.ts`, `room-modes.ts` | Q0-01 | FS/tool 事件带 runId/taskId；单聊/群聊不串线 |
| Q0-12 | [ ] | Git ChangeSetCollector | `hub/src/quality/change-set.ts` | Q0-06, Q0-11 | base/diff/hash/changed files 稳定；预存 dirty 不误归属 |
| Q0-13 | [ ] | Project writer lease | `hub/src/quality/lease.ts` | Q0-06 | 同项目第二 writer 排队；读者不阻塞；重启 lease 可恢复 |
| Q0-14 | [ ] | per-session/per-run 权限策略 | `hub/src/agent.ts`, `quality/permissions.ts` | Q0-01 | reviewer 写/delete/move 即使 bypass 开启也被拒绝 |
| Q0-15 | [ ] | 保护路径与风险分类 | `hub/src/quality/risk.ts` | Q0-12 | 权限/质量/部署/DB 修改自动升为 high/critical |

### P1：确定性验证门禁

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q1-01 | [ ] | GateEngine quick/full 检查 | `hub/src/quality/gate.ts` | Q0-10, Q0-12 | 非零退出码绝不 PASS；受影响 paths 正确选检查 |
| Q1-02 | [ ] | 代码失败/基础设施失败分类 | `hub/src/quality/gate.ts` | Q1-01 | timeout/缺依赖/断线不会被当成代码缺陷 |
| Q1-03 | [ ] | Conductor 写任务接入 QualityRun | `conductor.ts`, `room-modes.ts` | Q1-01, Q0-04 | accepted 前任务不 done；失败依赖不继续 |
| Q1-04 | [ ] | 单聊/mention 写入后的手动或自动 gate | `index.ts` | Q1-01 | 有变更才触发；只读回答不触发 |
| Q1-05 | [ ] | Desktop 最小质量面板 | `desktop/src/hub/*`, `ChatScreen.tsx` | Q0-05, Q1-01 | 可看 stage/check/log/verdict，可取消 |
| Q1-06 | [ ] | Android 最小质量面板 | `ChatViewModel.kt`, `ChatScreen.kt` | Q0-05, Q1-01 | 与 Desktop 状态语义一致，可取消 |
| Q1-07 | [ ] | agent-hub 初始 policy 经人工确认落地 | `.devin/quality.json` | Q0-07, Q1-01 | Hub/Desktop/Tauri/Android 检查可分别触发 |

### P2：独立审查与修复循环

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q2-01 | [ ] | Reviewer prompt 与 JSON schema | `hub/src/quality/review.ts` | Q0-03, Q0-12 | 长 finding 不截断；非法输出安全失败 |
| Q2-02 | [ ] | reviewer 独立 session 和只读权限 | `review.ts`, `agent.ts` | Q0-14 | reviewer 可读仓库/运行检查，不能写 |
| Q2-03 | [ ] | finding 持久化、阻断规则和处理状态 | `store.ts`, `run.ts` | Q2-01 | blocking 规则可复现，状态可恢复 |
| Q2-04 | [ ] | fixer 回合与强制复验 | `run.ts`, `gate.ts` | Q2-03, Q1-01 | 修复后 patchHash 改变且旧 check 不复用；最多 N 轮 |
| Q2-05 | [ ] | Desktop finding/patch/审批 UI | Desktop 质量面板 | Q2-03 | 可查看证据、dismiss/accept-risk/要求修复 |
| Q2-06 | [ ] | Android finding/patch/审批 UI | Android 质量面板 | Q2-03 | 核心操作与 Desktop 对齐 |
| Q2-07 | [ ] | reviewer 精度试运行 | 运行数据 | Q2-04 | 收集至少 30 条 finding 后计算确认/驳回率 |

### P3：回归资产、评测与规则候选

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q3-01 | [ ] | Incident 数据模型与 RPC | `quality/learning.ts`, `store.ts` | Q0-02 | 用户 bug、检查失败、confirmed finding 可统一入账 |
| Q3-02 | [ ] | base-fail/candidate-pass 差分验证 | `quality/regression.ts` | Q0-12, Q1-01 | 可证明测试在旧版失败、新版通过 |
| Q3-03 | [ ] | 建立首批历史缺陷 eval corpus | `hub/src/quality-evals/` 或测试夹具 | Q3-02 | 至少覆盖 20 个真实缺陷/风险场景 |
| Q3-04 | [ ] | 对照运行与指标报告 | `quality/eval.ts` | Q3-03 | 同模型/预算可比较 native/current/quality pipeline |
| Q3-05 | [ ] | RuleCandidate 聚类和生命周期 | `quality/learning.ts` | Q3-01, Q3-04 | 不自动激活；有证据、批准、retire 状态 |
| Q3-06 | [ ] | 质量趋势与规则 UI | Desktop/Android | Q3-04, Q3-05 | 能看复发率、误报、成本，而非只看总分 |

### P4：巡检、隔离修复与受控进化

| ID | 状态 | 工作项 | 主要文件 | 依赖 | 验收 |
|---|---|---|---|---|---|
| Q4-01 | [ ] | Scheduler 只触发 durable QualityRun | `scheduler.ts`, adapter | Q0-10 | 日志引用最终 verdict；防重复运行 |
| Q4-02 | [ ] | Git worktree 隔离器 | `quality/worktree.ts` | Q0-12, Q0-13 | 主工作区不被候选污染；patch 可恢复 |
| Q4-03 | [ ] | 临时 ACP session 绑定 worktree | `index.ts`, `agent.ts` | Q4-02 | session cwd 正确；结束可回收；历史不串线 |
| Q4-04 | [ ] | 质量巡检报告 | `quality/patrol.ts` | Q4-01, Q1-01 | 生成 run/check/finding，不只生成聊天文本 |
| Q4-05 | [ ] | 自进化候选生成 | `quality/evolution.ts` | Q3-04, Q4-02, Q2-04 | 候选通过 eval/full checks/review 后才可提请批准 |
| Q4-06 | [ ] | 低风险自动应用可选项 | `run.ts`, UI | Q4-05 | 默认关闭；protected/high risk 永远要求批准；可回滚 |

## 19. 多 AI 执行组织方案

### 19.1 建议角色

| 角色 | 主要职责 | 推荐模型策略 |
|---|---|---|
| 总架构/集成负责人 | 冻结接口、拆任务、审查跨模块影响、最终集成 | 强规划模型 |
| Hub 状态与存储执行方 | Q0-01/02/05/10、RPC、迁移 | 强编码模型 |
| 执行器与远程协议执行方 | Q0-06～09 | 熟悉 Node/网络/安全的模型 |
| 变更集与权限执行方 | Q0-11～15 | 强推理、偏安全模型 |
| 编排/Gate 执行方 | Q1-01～04 | 熟悉当前 conductor/room-modes |
| Desktop 执行方 | Desktop 质量 UI | 前端模型 |
| Android 执行方 | Android 质量 UI | Kotlin/Compose 模型 |
| 测试与对抗审查方 | 回归测试、故障注入、路径逃逸、恢复测试 | 独立模型族，默认只读 |

### 19.2 并行原则

可以并行：

- 类型/存储设计冻结后，LocalExecutionProvider 与 WorkerExecutionProvider；
- Hub RPC 稳定后，Desktop 与 Android；
- GateEngine 与 UI mock；
- 功能实现与独立测试/威胁建模。

不能并行修改同一核心文件：

- `hub/src/index.ts`；
- `hub/src/agent.ts`；
- `hub/src/conductor.ts`；
- `hub/src/store.ts`；
- `desktop/src/hub/store.ts`；
- `ChatViewModel.kt`。

这些文件由集成负责人分时合并，其他执行方通过新模块和接口降低冲突。

### 19.3 接口冻结顺序

```text
1. types/state machine
2. persistence schema
3. Project/Policy/Execution interfaces
4. Hub RPC/events
5. Gate/Review implementation
6. Desktop/Android
7. Learning/Scheduler
```

下游 AI 不得在未协调时自行改变已冻结 schema。

### 19.4 每个工作项的交付模板

```text
Work item: Qx-xx
Base commit:
Scope:
Changed files:
Public interfaces changed:
Behavior before/after:
Tests added:
Verification commands and results:
Security/compatibility risks:
Known limitations:
Migration/rollback:
Patch hash or branch:
Open questions:
```

### 19.5 集成规则

1. 每个 AI 只领取一个边界明确的工作项；
2. 优先增加失败测试，再实现；
3. 不允许通过删除/放宽测试让检查通过；
4. 不允许修改安全策略规避失败；
5. 不自动 commit、push、merge，由用户确认；
6. 每个工作项先经过独立 reviewer，再进入集成队列；
7. 集成后运行受影响 quick checks；阶段完成后运行 full checks；
8. 实际状态及时回写本文任务表，不批量补记。

## 20. 测试策略

### 20.1 单元测试

- 状态机所有合法/非法转换；
- risk/path matcher；
- policy schema；
- finding blocking 规则；
- scheduler lease；
- output 截断与 artifact 存储；
- failure fingerprint；
- migration。

### 20.2 集成测试

使用 fake ACP agent、临时 Git repo 和临时 SQLite：

- 实现者写文件 → ChangeSet → quick check → accepted；
- check failed → fixer → recheck；
- reviewer needs-fix → fixer → full check；
- Hub 在每个阶段重启后的恢复；
- failed dependency 不派发；
- 同项目 writer lease；
- 远程 worker 断线、重连、取消；
- prompt output 超过 800/10K；
- dirty working tree 和并发污染；
- reviewer 尝试写文件被拒绝；
- protected path 必须审批。

### 20.3 客户端测试

优先覆盖最近真实回归类型：

- 质量 run 状态推送后 UI 更新；
- Hub 重连后重新加载完整状态；
- 模型/成员/room 切换不串 run；
- 长日志、长 finding、长 patch 可滚动查看；
- approval 操作幂等；
- Android 后台/前台切换不丢审批状态。

### 20.4 故障注入

- 命令 timeout；
- 进程退出无 exit code；
- worker 断线；
- Hub 重启；
- SQLite 写失败；
- patch 生成失败；
- reviewer 非法 JSON；
- reviewer 空输出；
- 同一任务重复 prompt.done；
- Scheduler 重复触发；
- 文件在 run 外被人工修改。

## 21. 阶段完成标准

### P0 完成

- 本地和远程项目都能形成 ProjectScope；
- QualityRun 可持久化、取消、恢复；
- 完整输出不再因 800 字符截断破坏内部编排；
- 执行器可以给出可信退出码；
- 真实 patch 可归属 run；
- reviewer 强制只读；
- 不影响现有聊天和群聊功能。

### P1 完成

- 任意 required check 失败时不存在假 PASS；
- conductor、单聊、mention 至少有明确接入策略；
- Desktop/Android 能看到相同 verdict 和证据；
- agent-hub 自身质量 policy 跑通；
- Hub 重启和远程断线恢复测试通过。

### P2 完成

- reviewer 输入真实 patch 和仓库上下文；
- finding 有证据、置信度和处理状态；
- 修复后强制复验；
- 至少 30 条真实 finding 用于初步精度评估；
- 误报不会无限打回。

### P3 完成

- 至少 20 个真实缺陷进入 eval；
- 有 native/current/quality pipeline 对照报告；
- RuleCandidate 不会未经批准自动激活；
- 能测量复发率、误报率和成本。

### P4 完成

- 定时巡检产生 durable run；
- 候选修复在隔离 worktree；
- 主工作区不会因失败候选被污染；
- 自进化修改能与旧版本对比并回滚；
- 高风险和保护区域始终要求批准。

## 22. 明确不做

1. 不自动执行从 AGENTS.md/README/Agent 输出中临时发现的 shell 命令。
2. 不把 Agent 自述的“测试通过”作为硬门禁。
3. 不用 Blackboard 作为质量事实数据库。
4. 不让多个 writer 在同一未隔离工作区并发修改。
5. 不让 reviewer 同时担任实现者和最终裁决者。
6. 不自动把高频建议写入 AGENTS.md 或立即激活。
7. 不用 TODO 数量、代码行数等易被投机的指标驱动自进化。
8. 不允许候选实现自行放宽验证器、权限、eval 或阻断阈值。
9. 不自动 push、合并、部署或删除用户数据。
10. 不在无法获取真实 patch、可信执行结果或回滚点时自动修复。

## 23. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 质量流程延迟和成本过高 | quick/full 分层、风险路由、预算和抽样 review |
| reviewer 误报导致用户关闭功能 | 高置信度阻断、可 dismiss、跟踪 precision |
| 多 Agent 修改互相污染 | writer lease，后续 worktree |
| Agent 修改测试迎合实现 | base-fail/candidate-pass、保护测试、独立 reviewer |
| 远程执行不稳定 | ExecutionProvider 分类 infra failure、lease 和恢复 |
| 仓库 prompt injection | 不可信数据隔离、结构化 schema、命令白名单 |
| 自进化修改评价器以刷分 | protected paths、固定 eval、独立批准 |
| DB/日志膨胀 | 大输出落盘、保留策略、hash 去重 |
| 质量状态与聊天状态不一致 | QualityService 单一事实源，事件只通知刷新 |
| 新能力破坏原有模式 | feature flag、兼容迁移、阶段性回归测试 |

## 24. 决策记录

| 决策 | 原因 |
|---|---|
| 增加 P0，而不是直接实施旧 P1 | 当前缺少可信执行、变更集、隔离和状态恢复 |
| 质量配置绑定 ProjectScope | Room 可能跨 cwd，项目才是验证和规则边界 |
| AGENTS.md 不直接执行 | 人类文档结构不稳定且可能包含不可信命令 |
| Scheduler 只触发 QualityRun | 当前 Scheduler 只保证消息派发，不管理长流程 |
| Blackboard 只展示摘要 | 容量小、会淘汰、没有 finding 生命周期 |
| reviewer repo-wide 且只读 | 只给 diff 摘要误报高，写权限会破坏独立性 |
| 必须建设轻量 eval | 没有对照评测就无法证明自进化和超越原生 Agent |
| 初期 writer lease，后期 worktree | 先控制风险和复杂度，再实现真正并行隔离 |
| 不自动写 AGENTS.md | 规则需要证据、评测、批准和退役机制 |
| 默认 autonomy=propose | 在质量系统自身成熟前不直接污染用户工作区 |

## 25. 调研依据

本方案采用的关键判断有以下外部依据：

1. [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
   - 优先简单、可组合的工作流；
   - evaluator-optimizer 只有在评价标准清晰、改进可测量时才值得使用；
   - 复杂度必须用实际效果证明，而不是默认增加更多 Agent。
2. [OpenAI：A Practical Approach to Verifying Code at Scale](https://alignment.openai.com/scaling-code-verification/)
   - 自动代码审查是纵深防御，不是正确性保证；
   - reviewer 需要仓库级工具和执行能力；
   - 实际部署中高精度、低误报比盲目追求召回率更重要。
3. [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798)
   - 没有外部反馈的内在自我修正可能没有提升，甚至降低表现；
   - 多 Agent 讨论本身不自动产生可信验证信号。
4. [SWE-bench Verified](https://www.swebench.com/verified)
   - 真实问题、固定仓库基线、可复现测试和人类确认是比较编码 Agent 的必要条件；
   - 因此本方案要求建立项目自己的历史缺陷 eval corpus。
5. [Google DeepMind：CodeMender](https://deepmind.google/blog/introducing-codemender-an-ai-agent-for-code-security/)
   - 高质量自动修复依赖静态/动态分析、差分测试和独立 critique；
   - 对高风险补丁应先形成高质量候选，再交给人类审查。
6. Devin CLI 当前已经支持独立 subagent、自定义 reviewer 和测试执行方。
   - agent-hub 的差异化不能只是“多派一个 reviewer”；
   - 必须落在跨后端控制、真实证据、持久质量账本、移动审批和长期评测上。

## 26. 下一步

在安排多个 AI 执行方之前，先完成一次人工架构评审并冻结以下合同：

1. `QualityRun/QualityStage`；
2. SQLite schema；
3. `ProjectScope` 与 projectId 算法；
4. `.devin/quality.json` schema；
5. `ExecutionProvider`；
6. Hub RPC/events；
7. per-run 权限规则；
8. P0 任务的文件所有权。

合同冻结后，优先并行启动：

```text
执行方 A：Q0-01/Q0-02（类型、状态机、存储）
执行方 B：Q0-03/Q0-04（完整输出、Conductor 依赖语义）
执行方 C：Q0-06/Q0-07（ProjectRegistry、Policy）
独立审查方：对上述接口做一致性、安全和迁移评审
```

Q0-01、Q0-02、Q0-06 的接口稳定后，再启动本地/远程执行器与客户端工作，避免多人同时修改核心文件导致返工。