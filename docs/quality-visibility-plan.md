# 质量生命周期可见性方案

> 状态：待确认
> 制定日期：2026-09-10
> 基线代码：`4f08296`
> 适用范围：Hub、Desktop、Android

## 1. 问题

### 1.1 现状

`docs/quality-lifecycle.md` 中 Phase 0–6 全部标记"已落地"，L0/L1/L3/L4/fixer 在 Hub 后端均可运转。但用户在客户端几乎看不到质量过程和结果：

- **单会话编程**：agent 回复完成后，质量检查静默运行。用户不知道检查在跑、不知道通过与否、不知道 fixer 在自动修复、不知道在等审批。ChatScreen 没有任何质量状态展示。
- **群聊编排**：FlowPanel 的 task 只显示 `verifying` 状态和 `qualityRunId`（一个 ID 字符串），不展示检查结果、失败归因、修复轮次。要查看详情需手动切到 QualityScreen，且 QualityScreen 不反向关联到具体会话或子任务。

### 1.2 根本原因

质量生命周期是**横切关注点**——不分群聊和单会话，任何代码变更都应走完整质量链路。但当前架构把它实现成了**独立页面**，与两个实际使用场景的聊天视图脱节：

```
ChatScreen（聊天视图）              QualityScreen（独立页面）
├── 群聊：FlowPanel                ├── run 列表
│   └── verifying → 只显示"验证中"   ├── run 详情（stage/fixRound/verdict）
└── 单会话：无质量展示              ├── checks 列表
                                    └── findings 列表
    ↑ 两个信息孤岛，没有桥梁 ↑
```

三个具体断裂：

| 断裂 | 说明 |
|---|---|
| **场景断裂** | 质量检查在单会话和群聊都运行，但 ChatScreen 只在群聊有极少量展示，单会话完全没有 |
| **关联断裂** | `quality.runUpdate` 事件推送了完整 run（含 `implementerSessionId`/`taskId`），但客户端不按这些字段匹配当前会话；QualityScreen 展示 run 列表但不反向关联到会话/子任务 |
| **归因断裂** | run 的 `failureCode` 在质量检查失败时为 `undefined`（只有 hub-restart 才设置），conductor 的 `failureMessage` 把 5 种不同来源压成同一个字符串 |

## 2. 设计原则

1. **质量状态嵌入聊天视图**，不要求用户跳转到独立页面。单会话在 ChatScreen header 下方显示状态条；群聊在 FlowTaskItem 展开区显示质量摘要。
2. **统一数据源**：两个场景共享同一套质量摘要数据结构，差异只在展示位置。
3. **实时推送**：通过 `quality.runUpdate` 事件实时更新，不依赖轮询。
4. **不破坏现有 QualityScreen**：QualityScreen 保留为完整证据查看页面，聊天视图只展示摘要。
5. **归因先行**：修复 `failureCode` 缺失问题，让失败原因可区分。

## 3. 方案

### 3.1 数据层

#### 3.1.1 质量摘要类型

```ts
type QualitySummary = {
  runId: string;
  stage: QualityStage;
  enforcement: "require-pass" | "require-approval" | "report";
  fixRound: number;
  maxFixRounds: number;
  passedChecks: number;
  failedChecks: number;
  findings: number;
  blockingFindings: number;
  verdict?: QualityVerdict;
  failureCode?: string;
  awaitingApproval: boolean;
  checks?: { checkId: string; status: CheckRunStatus; summary?: string }[];
};
```

#### 3.1.2 Hub 侧改动

**问题 A：conductor 拿不到 qualityService**

conductor 持有 `QualityIntegration` 接口，该接口没有 `getRun` 方法。`getFlow` 在 conductor 内实现，无法直接查询 quality run 详情。

**解决**：给 `QualityIntegration` 接口新增方法：

```ts
getRunSummary?(runId: string): QualitySummary | undefined;
```

在 `index.ts` 的 `qualityIntegration` 对象中实现该方法，调用 `qualityService.getRun` + `qualityService.listChecks` + `qualityService.listFindings` 组装摘要。

conductor 的 `getFlow` 在序列化 task 时，对有 `qualityRunId` 的 task 调用 `this.quality?.getRunSummary?.(qualityRunId)`，将结果挂到 task 的 `quality` 字段。

这样 `room.flowUpdate` 事件和 `room.flow` RPC 自动携带质量摘要，无需额外事件。

**问题 B：单会话场景没有 flow，无法通过 getFlow 关联**

单会话不走 conductor，`triggerGateForSession` 创建的 run 通过 `quality.runUpdate` 事件推送。客户端需要自行匹配。

**解决**：客户端监听 `quality.runUpdate` 事件，按 `run.implementerSessionId === currentSession.sessionId` 匹配。一个 session 多轮对话会产生多个 run，取 `updatedAt` 最新的非 `stale`/`cancelled` run 作为当前会话的质量状态。

初始化时需要按 sessionId 加载历史 run。新增 Hub RPC：

```
quality.run.listBySession  params: { sessionId, limit? }
返回: { runs: QualityRun[] }
```

对应 store 新增 `listQualityRunsBySession(sessionId, limit)` 方法，SQL 查询 `implementer_session_id = ? ORDER BY updated_at DESC LIMIT ?`。

**问题 C：`failureCode` 在质量检查失败时缺失**

`transition()` 函数推进到 `failed`/`inconclusive` 时不设置 `failureCode`。只有 `recovery.ts` 在 hub-restart 时设置。导致 L1 检查失败、L3 验证失败、fixer 超预算等场景的 `failureCode` 全部为 `undefined`。

**解决**：扩展 `advance` 方法，接受可选的 `failureCode` 参数：

```ts
advance(id: string, to: QualityStage, failureCode?: string): QualityRun;
```

`transition` 函数在 `to === "failed"` 或 `to === "inconclusive"` 时，如果传入了 `failureCode` 则设置到 run 上。

各调用点传入对应的 failureCode：

| 调用点 | failureCode |
|---|---|
| gate runner（L1 检查失败） | `l1-check-failed` |
| gate runner（基础设施失败） | `l1-infra-failed` |
| L3 verification（验证失败） | `l3-verification-failed` |
| L3 verification（证据不足） | `l3-inconclusive` |
| fixer-orchestrator（超预算） | `fixer-budget-exhausted` |
| fixer-orchestrator（session 创建失败） | `fixer-session-error` |
| fixer-orchestrator（prompt 失败） | `fixer-prompt-error` |
| review-orchestrator（安全失败） | `review-error` |
| recovery（hub 重启） | `hub-restart`（已有） |

conductor 的 `failureMessage` 也相应丰富，根据 `failureCode` 生成可读消息，而非统一写"质量验证未通过"。

**问题 D：`quality.run.get` 没有返回 L3 verification records**

store 有 `listRequirementVerifications(runId)` 方法，但 `quality.run.get` RPC 只返回 `{ run, checks, findings }`，不返回 verification。

**解决**：扩展 `quality.run.get` 返回值为 `{ run, checks, findings, verifications }`。

**问题 E：CheckRun 只有 `checkId`，没有人类可读名称**

`CheckDefinition` 有 `id` 和 `argv`，没有 `name` 字段。`CheckRun.checkId` 对应 `CheckDefinition.id`。

**解决**：质量摘要中的 checks 不额外查 policy 映射名称（避免 getFlow 变重）。客户端展示时用 `checkId` 作为标识，如果需要可读名称，在 QualityScreen 详情页从 policy 查。摘要中 checks 列表可选——初始版本只在展开详情时通过 `quality.run.get` 拉取完整 checks，getFlow 摘要只带 `passedChecks`/`failedChecks` 计数。

修正后的 `QualitySummary` 精简为：

```ts
type QualitySummary = {
  runId: string;
  stage: QualityStage;
  enforcement: "require-pass" | "require-approval" | "report";
  fixRound: number;
  maxFixRounds: number;
  passedChecks: number;
  failedChecks: number;
  findings: number;
  blockingFindings: number;
  verdict?: QualityVerdict;
  failureCode?: string;
  awaitingApproval: boolean;
};
```

不带 checks 列表。客户端需要查看检查详情时，通过 `quality.run.get` RPC 拉取。

#### 3.1.3 Desktop store 改动

新增状态：

```ts
sessionQuality: QualitySummary | null;
```

监听 `quality.runUpdate` 事件：

```ts
case "quality.runUpdate": {
  const run = params.run as QualityRun;
  // 现有逻辑：更新 qualityRuns 列表
  // 新增：如果 run.implementerSessionId 匹配当前 session，更新 sessionQuality
  const currentSession = get().currentSession;
  if (currentSession && run.implementerSessionId === currentSession.sessionId) {
    if (run.stage !== "stale" && run.stage !== "cancelled") {
      set({ sessionQuality: buildSummary(run) });
    } else {
      set({ sessionQuality: null });
    }
  }
  break;
}
```

`openChat` 时：
- 设置 `sessionQuality: null`（清理上一个会话的质量状态）
- 调用 `quality.run.listBySession` 加载该会话最新的质量 run
- **同时修复已有 bug**：Desktop `openChat` 没有设置 `flow: null`，从群聊切到单会话时 flow 残留。补上 `flow: null`。

`openRoom` 时：
- 设置 `sessionQuality: null`（群聊用 task.quality，不用 sessionQuality）

`buildSummary(run)` 从 QualityRun 构造 QualitySummary，需要额外查询 checks/findings 计数。为避免每次 runUpdate 都查，有两种策略：

- **策略 A**：runUpdate 事件只更新 run 级字段（stage/fixRound/verdict/failureCode），checks/findings 计数通过 run 的 `outcome` 和 `failureCode` 推断。当用户展开详情时再通过 `quality.run.get` 拉取完整数据。
- **策略 B**：Hub 侧在 runUpdate 事件里附带 checks/findings 计数。

选择**策略 B**：扩展 `quality.runUpdate` 事件参数，增加 `checkStats: { passed: number; failed: number; infraFailed: number }` 和 `findingStats: { total: number; blocking: number }`。这样客户端无需额外查询即可展示摘要。

#### 3.1.4 Android 改动

- `QualityRun` data class 补充 `implementerSessionId: String? = null` 字段
- `parseQualityRun` 补充解析 `implementerSessionId`
- `ChatViewModel` 新增 `sessionQuality: QualitySummary?` 状态
- 监听 `quality.runUpdate`，按 `implementerSessionId` 匹配当前 session
- `openChat` 时清理 `sessionQuality`，加载历史

### 3.2 展示层

#### 3.2.1 单会话：质量状态条

位置：ChatScreen header 下方，消息列表上方。仅当 `sessionQuality` 非空时显示。

```
┌─────────────────────────────────────────────┐
│ 🛢 质量验证中 · L1 检查 3/4 · 1 失败 → 自动修复中 (2/3)  │
└─────────────────────────────────────────────┘
```

状态条内容按 stage 映射：

| stage | 显示 |
|---|---|
| `preflight` / `implementing` | 准备中 |
| `collecting` | 收集变更中 |
| `quick-verifying` | L1 快速检查中 |
| `full-verifying` | L1 完整检查中 |
| `fixing` | 自动修复中 (fixRound/maxFixRounds) |
| `reviewing` | AI 审查中 |
| `requirement-verifying` | L3 需求验证中 |
| `awaiting-approval` | 等待审批 · [批准] [拒绝] |
| `accepted` | ✓ 质量验证通过 |
| `failed` | ✗ 质量未通过 · {failureCode 对应的可读描述} |
| `inconclusive` | ⚠ 无法判定 · {failureCode 对应的可读描述} |

点击状态条展开详情面板（调 `quality.run.get` 拉取 checks/findings/verifications）：

```
┌─────────────────────────────────────────────┐
│ 质量 run abc123                              │
│ 阶段：L1 检查 · 修复轮次 2/3 · enforcement: require-pass │
│                                              │
│ 检查：                                       │
│   ✓ typecheck (120ms)                       │
│   ✗ build — exit code 1                     │
│     summary: src/index.ts(42): type error   │
│                                              │
│ Findings：1 critical · 0 major               │
│   [critical] src/index.ts:42 类型不匹配      │
│                                              │
│ L3 需求验证：                                │
│   ✓ RV-001 需要错误处理                      │
│   ✗ RV-002 需要单元测试                      │
└─────────────────────────────────────────────┘
```

#### 3.2.2 群聊：FlowTaskItem 质量摘要

task 展开后，如果有 `quality` 字段，在执行信息下方增加质量区：

```
┌─────────────────────────────────────────────┐
│ [t1] @devin 实现用户登录接口                  │
│ 状态：验证中                                  │
│                                              │
│ ▼ 执行详情                                    │
│   依赖：无                                    │
│   输出：Created src/auth/login.ts...         │
│                                              │
│ ▼ 质量验证                                    │
│   阶段：自动修复中 (2/3)                      │
│   L1 检查：3 通过 · 1 失败                    │
│   Findings：1 critical                        │
│   enforcement: require-pass                  │
│                                              │
│   [查看完整证据 →] (跳转 QualityScreen)       │
└─────────────────────────────────────────────┘
```

`awaiting-approval` 时在质量区内显示批准/拒绝按钮，调用 `quality.run.approve/reject`。

`failed` 时显示失败归因（基于 `failureCode`）。

#### 3.2.3 failureCode 可读映射

```ts
const FAILURE_CODE_LABELS: Record<string, string> = {
  "l1-check-failed": "L1 确定性检查未通过",
  "l1-infra-failed": "检查基础设施失败（超时或环境异常）",
  "l3-verification-failed": "L3 需求验证未通过",
  "l3-inconclusive": "L3 需求证据不足",
  "fixer-budget-exhausted": "自动修复预算耗尽",
  "fixer-session-error": "修复会话创建失败",
  "fixer-prompt-error": "修复执行失败",
  "review-error": "AI 审查异常",
  "hub-restart": "Hub 重启导致中断",
};
```

### 3.3 交互层

#### 3.3.1 群聊重试

保持现有 `room.retryTasks` RPC 行为：重新派发 task，scheduleTasks 创建新 QualityRun。

**修正**：重试按钮的显示条件需要考虑 fixer 状态：

- task 状态为 `verifying` 且 `quality.stage` 为 `fixing` → 显示"自动修复中"，不显示重试
- task 状态为 `failed` 且 `failureCode` 为 `fixer-budget-exhausted` → 显示"修复预算耗尽，可重试"
- task 状态为 `failed` 且 `failureCode` 为 `l1-check-failed` / `l3-verification-failed` → 显示"质量未通过，可重试"
- task 状态为 `failed` 且 `failureCode` 为 `fixer-session-error` / `fixer-prompt-error` / `review-error` → 显示"质量流程异常，可重试"
- task 状态为 `verifying` 且 `quality.awaitingApproval` → 显示批准/拒绝，不显示重试

#### 3.3.2 单会话重试

单会话不走 conductor，`quality.run.retry` 创建新 run 但不重新派发 agent——agent 不会重新写代码。

**设计**：单会话质量失败后，状态条不提供"重试"按钮，而是显示引导文案：

- `fixer-budget-exhausted`：`修复预算耗尽，请向 AI 描述问题并要求修复`
- `l1-check-failed`：`L1 检查未通过，请向 AI 描述失败原因并要求修复`
- `l3-verification-failed`：`需求验证未通过，请向 AI 补充实现`
- `fixer-session-error` / `fixer-prompt-error` / `review-error`：`质量流程异常，可重新发送消息触发再次验证`

用户重新发 prompt → agent 修复代码 → `prompt.done` → `triggerGateForSession` 创建新 run → `runUpdate` 推送 → 状态条更新。

这是正确的语义：单会话里"重试"等于"让 agent 重新修"，而不是"重新跑一遍同样的检查"。

#### 3.3.3 审批入口

单会话和群聊的审批入口都调用 `quality.run.approve` / `quality.run.reject` RPC。

现有 `quality.approvalRequest` 事件会在聊天流里插入 permission 卡片（单会话 roomId 为 null 时不过滤，会显示）。状态条/质量区的审批按钮是**补充入口**，不替代聊天流里的卡片。用户可以从任一入口审批。

## 4. 改动清单

### 4.1 Hub

| 文件 | 改动 |
|---|---|
| `hub/src/conductor.ts` | `QualityIntegration` 接口新增 `getRunSummary?`；`getFlow` 序列化 task 时关联质量摘要；`failureMessage` 按 `failureCode` 生成可读消息 |
| `hub/src/index.ts` | `qualityIntegration` 实现 `getRunSummary`；新增 `quality.run.listBySession` RPC；`quality.run.get` 返回值增加 `verifications`；`quality.runUpdate` 事件参数增加 `checkStats`/`findingStats`；各 `advance(… "failed")` 调用点传入 `failureCode` |
| `hub/src/quality/service.ts` | `advance` 方法签名增加可选 `failureCode` 参数；`broadcast` 方法附带 checkStats/findingStats |
| `hub/src/quality/run.ts` | `transition` 函数接受可选 `failureCode`，在终态时设置 |
| `hub/src/quality/fixer-orchestrator.ts` | 各 `advance(… "failed")` 调用点传入对应 `failureCode` |
| `hub/src/store.ts` | 新增 `listQualityRunsBySession(sessionId, limit)` 方法 |
| `hub/src/conductor.test.ts` | 新增 `getRunSummary` 关联测试 |
| `hub/src/quality/service.test.ts` 或 `run.test.ts` | 新增 `failureCode` 传递测试 |

### 4.2 Desktop

| 文件 | 改动 |
|---|---|
| `desktop/src/hub/types.ts` | 新增 `QualitySummary` 类型；`FlowTask` 增加 `quality?: QualitySummary`；`QualityRun` 已有 `implementerSessionId`（确认） |
| `desktop/src/hub/store.ts` | 新增 `sessionQuality` 状态；监听 `quality.runUpdate` 按 `implementerSessionId` 匹配；`openChat` 时清理 `sessionQuality` 并加载历史、**修复 `flow: null` 缺失**；新增 `loadSessionQuality` 方法 |
| `desktop/src/screens/ChatScreen.tsx` | 单会话 header 下方加质量状态条；FlowTaskItem 展开区加质量摘要；状态条点击展开详情面板（调 `quality.run.get`） |
| `desktop/src/styles/chat.css` | 质量状态条、详情面板、质量摘要区样式 |

### 4.3 Android

| 文件 | 改动 |
|---|---|
| `android/app/src/main/java/com/agenthub/ChatViewModel.kt` | `QualityRun` 补 `implementerSessionId`；新增 `QualitySummary` data class 和 `sessionQuality` 状态；监听 `quality.runUpdate` 匹配；`openChat` 时清理并加载；新增 `loadSessionQuality` |
| `android/app/src/main/java/com/agenthub/ui/ChatScreen.kt` | 单会话顶部加质量状态条；FlowTaskRow 展开区加质量摘要；状态条点击展开详情 |

## 5. 验证计划

### 5.1 类型检查和单元测试

```bash
cd hub && npx tsc --noEmit && npm test
cd desktop && npx tsc --noEmit
cd android && ./gradlew :app:compileDebugKotlin
```

### 5.2 功能验证

1. **单会话质量状态条**：在单会话中发送代码变更请求，确认状态条出现并随 stage 变化更新
2. **单会话审批**：触发高风险变更进入 `awaiting-approval`，确认状态条显示审批按钮，点击后 run 终态更新
3. **单会话质量失败**：触发 L1 检查失败，确认状态条显示可读的失败归因（而非"质量验证未通过"）
4. **群聊质量摘要**：在群聊中触发多子任务编排，确认 task 展开后显示质量摘要（stage/fixRound/checks 计数）
5. **群聊重试条件**：确认 fixer 修复中不显示重试按钮，fixer 超预算后显示重试按钮
6. **Desktop flow 清理**：从群聊切到单会话，确认 FlowPanel 不再显示
7. **failureCode 传递**：确认 run 终态 failed 时 `failureCode` 非 undefined
8. **quality.run.get verifications**：确认 RPC 返回 verifications 数组

### 5.3 不重启 Hub

所有改动通过 `quality.runUpdate` 事件和 RPC 完成，不需要重启 Hub。如果 Hub 代码改动需要重启才能生效，停下来等用户手动重启。

## 6. 风险和约束

| 风险 | 缓解 |
|---|---|
| `getRunSummary` 增加 getFlow 开销 | 摘要只查 run + 计数，不查完整 checks/findings 列表；runUpdate 事件附带计数后客户端无需反查 |
| `quality.runUpdate` 事件体积增大 | 只增加两个数字字段（checkStats/findingStats），不增加完整列表 |
| `failureCode` 传递遗漏某些路径 | 逐一排查所有 `advance(… "failed")` 调用点，补充测试覆盖 |
| Android `QualityRun` 新增字段破坏序列化 | `implementerSessionId` 为可选字段（`String? = null`），向后兼容 |
| 单会话多 run 竞态 | 取 `updatedAt` 最新的非 stale/cancelled run；旧 run 终态后 sessionQuality 保留最后一个终态直到新 run 出现 |

## 7. 不做的事

- 不修改 QualityScreen 的现有功能和布局
- 不在 getFlow 摘要中携带完整 checks/findings/verifications 列表（按需通过 `quality.run.get` 拉取）
- 不改变 conductor.retryFailedTasks 的语义（仍为重新派发）
- 不改变 quality.run.retry 的语义（仍为创建新 generation run）
- 不增加新的 npm/gradle 依赖
