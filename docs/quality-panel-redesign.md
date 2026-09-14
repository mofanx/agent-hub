# 质量面板优化方案：渐进式信息披露与跨入口联动

> 状态：待确认
> 制定日期：2026-09-10
> 基线代码：`c200f2f`
> 适用范围：Hub、Desktop、Android
> 前置文档：`docs/quality-lifecycle.md`、`docs/quality-visibility-plan.md`

## 0. 背景

`docs/quality-visibility-plan.md` 已落地了跨场景质量可见性的第一版：
- 单会话 ChatScreen header 下方新增质量状态条
- 群聊 FlowTaskItem 展开详情中新增质量摘要
- failureCode 归因、checkStats/findingStats 事件统计、quality.run.listBySession RPC

但第一版解决的是"有没有"的问题——让质量状态在聊天视图中可见。本文解决的是"好不好"的问题——让两个质量入口（聊天内嵌状态条 vs 独立 QualityScreen）形成职责清晰、渐进递进、双向联动的完整整体。

## 1. 第一性原理：用户在什么时刻需要什么

用户使用 Agent-Hub 编程的核心流程：

```
发送编程请求 → Agent 实现 → 质量检查自动运行 → 用户需要知道：通过了吗？失败了吗？我该做什么？
```

从这个流程出发，质量信息有四个递进层次的需求：

| 层次 | 时刻 | 用户的问题 | 所需信息 |
|------|------|-----------|---------|
| 判断 | 检查运行中/完成后 | 通过了还是没通过？ | 一句话结论 + 归因 |
| 定位 | 看到失败后 | 哪个检查失败了？错误是什么？ | 失败 check 名 + 错误摘要 |
| 决策 | 看到失败原因后 | 我该做什么？ | 行动引导（等 fixer / 发消息 / 审批） |
| 证据 | 需要深入排查时 | 完整的检查输出和证据链 | 全部 checks/findings/verifications |

**核心原则：每一层只展示该层需要的信息，不重复上层信息，不遗漏下层入口。用户按需逐层深入，不被信息淹没。**

## 2. 当前架构：两个入口的职责边界

### 2.1 现状

```
入口 A：聊天视图内嵌（刚实现）
├── 单会话：ChatScreen header 下方 QualityStatusBar
│   ├── 折叠态：阶段名 + L1 计数 + 失败标签 + 审批按钮
│   └── 展开态：同上 + runId（无增量信息）
└── 群聊：FlowTaskItem 展开详情中 QualitySummaryView
    └── 阶段名 + L1 计数 + findings 计数 + 失败标签 + 审批按钮

入口 B：独立 QualityScreen（已有）
├── 项目选择 + 策略信息
├── 全局 run 列表
├── run 详情（checks + findings，无 verifications）
├── Incident 列表
├── 规则候选
└── WorkItem 列表
```

### 2.2 问题诊断

| # | 问题 | 影响 |
|---|------|------|
| 1 | **状态条展开后无增量信息** | 用户点击展开，看到的还是折叠态的计数。违反"展开应提供更多细节"的预期。 |
| 2 | **没有行动引导** | 质量失败后用户不知道该做什么：是等 fixer 自动修，还是自己介入？ |
| 3 | **L3 需求验证结果无处可看** | Hub 已返回 verifications 数据，但 Desktop/Android 的 types/store/UI 均未定义和展示。 |
| 4 | **两个入口没有联动** | 状态条无法跳转到 QualityScreen 对应 run；QualityScreen 不感知当前聊天上下文。 |
| 5 | **群聊 task.quality 中间阶段不实时更新** | quality.runUpdate 推送中间 stage 变化时，conductor 不调用 emitFlow，FlowTask.quality 停留在上一次 flowUpdate 的快照。 |
| 6 | **QualityScreen "重试"按钮语义误导** | quality.run.retry 只重跑检查不重派 agent。单会话用户点"重试"以为 agent 会重新写代码，实际只是重新跑检查。 |
| 7 | **accepted 状态条不消失** | 多轮对话后旧的"验证通过"状态条永久占据 header 位置。 |
| 8 | **群聊任务折叠态无质量进度** | 必须逐个展开任务才能看到"L1 3/4"或"修复中 2/3"。 |
| 9 | **标签映射重复散落 5 个文件** | STAGE_LABELS / FAILURE_CODE_LABELS 在 Desktop ChatScreen、QualityScreen、Android ChatScreen、Android QualityScreen、Hub conductor 各维护一份。 |
| 10 | **单会话多 run 选择逻辑不够明确** | 连续发两个 prompt 时，第一个 run 在 fixing，第二个在 queued，sessionQuality 被后者覆盖，用户看到"排队中"而非"修复中"。 |

## 3. 目标架构：四层渐进式信息披露

```
Layer 0 — 一眼判断（聊天视图 · 状态条折叠态）
  职责：0.5 秒内判断质量状态
  内容：图标 + 阶段名 + L1 计数 + 失败归因（一句话）
  位置：单会话 header 下方 / 群聊 task 行内联

Layer 1 — 快速定位（聊天视图 · 状态条展开态）
  职责：5 秒内知道问题在哪、该做什么
  内容：
    - 失败 check 的 checkId + summary（前 200 字符）
    - blocking finding 的 claim + file:line
    - L3 验证通过/未通过条目（criterionId + status）
    - 行动引导文案
    - "查看完整证据 →" 跳转链接
  数据来源：展开时调用 quality.run.get 拉取 checks/findings/verifications

Layer 2 — 完整证据（QualityScreen · run 详情）
  职责：深入排查时查看完整证据链
  内容：
    - 全部 checks（status / exitCode / duration / summary / stdout / stderr）
    - 全部 findings（severity / claim / evidence / reproduction / suggestion / actions）
    - 全部 L3 verifications（criterionId / status / method / evidenceRefs）  ← 新增
    - run 元数据（risk / trigger / fixRound / verdict / failureCode / patchHash / generation）
    - 操作按钮（审批 / 取消 / 豁免）
  入口：Layer 1 的"查看完整证据 →"链接直接定位到对应 run

Layer 3 — 全局管理（QualityScreen · 全局视图）
  职责：长期质量管理和学习
  内容：
    - 项目选择 + 策略配置
    - 跨项目/跨会话的 run 历史
    - Incident 列表 + 规则候选 + WorkItem
  入口：侧边栏导航
```

### 3.1 各层职责边界

| 边界规则 | 说明 |
|---------|------|
| Layer 0 不展示 check 列表 | 只展示计数和归因，避免信息过载 |
| Layer 1 不展示完整 stdout/stderr | 只展示 summary 前 200 字符，完整输出在 Layer 2 |
| Layer 1 必须有 Layer 2 入口 | "查看完整证据 →"链接，不让用户困在摘要层 |
| Layer 2 不重复 Layer 0/1 的结论 | 直接展示原始数据，不重复"通过/失败"判断 |
| Layer 3 不嵌入聊天上下文 | 全局管理是跨上下文的，不绑定当前会话 |
| 审批操作在 Layer 0 和 Layer 1 都可执行 | 审批是高频操作，不应要求展开才能审批 |
| 重试操作只在群聊 FlowTaskItem 中 | 单会话"重试"语义是重新发消息，不是 quality.run.retry |

### 3.2 两个入口的联动

```
状态条（Layer 0-1）                         QualityScreen（Layer 2-3）
┌──────────────────────┐                   ┌────────────────────────┐
│ 折叠：一句话结论      │                   │ 上下文感知区（新增）     │
│ 展开：失败详情+引导   │───"查看完整证据"──→│ → 自动选中对应 run      │
│                      │                   │ → 展示完整 checks/     │
│                      │←──"返回聊天"─────│   findings/verifications│
└──────────────────────┘                   │                        │
                                           │ 全局 run 列表           │
                                           │ Incident/Rule/WorkItem │
                                           └────────────────────────┘
```

**状态条 → QualityScreen**：状态条展开详情底部有"查看完整证据 →"链接，点击后：
1. 设置 `qualityRunId` 为当前 run
2. 切换到 QualityScreen
3. QualityScreen 自动选中该 run 并展示详情（Layer 2）

**QualityScreen → 聊天上下文**：QualityScreen 顶部新增"当前上下文"区：
- 如果当前在单会话，显示"当前会话: {sessionName}" + 该会话最新 run 的状态摘要
- 如果当前在群聊，显示"当前群聊: {roomName}" + 正在验证的任务列表
- 点击可返回聊天视图

## 4. 具体改动

### 4.1 Layer 0 优化：状态条折叠态

#### 4.1.1 accepted 状态条自动收起

**问题 #7**：accepted 状态条永久占位。

**方案**：accepted 后 10 秒自动收起为左侧导航栏的小盾牌图标（绿色 = 最近通过，红色 = 最近失败）。用户点击图标可重新展开状态条。

实现：
- Desktop：`sessionQuality` 在 accepted 后 10 秒设为 `collapsed` 状态（新增字段），状态条渲染为 24px 图标
- Android：同理，收起为顶部小图标

#### 4.1.2 群聊任务折叠态显示质量进度

**问题 #8**：必须展开才能看到质量进度。

**方案**：FlowTaskItem 折叠态在任务描述后显示紧凑质量进度：

| task 状态 | quality.stage | 折叠态显示 |
|-----------|--------------|-----------|
| verifying | fixing | `🛡 修复 2/3` |
| verifying | quick-verifying | `🛡 L1 3/4` |
| verifying | full-verifying | `🛡 L1 ✓` |
| verifying | requirement-verifying | `🛡 L3` |
| verifying | awaiting-approval | `🛡 待审批`（高亮） |
| failed | * | `🛡 ✗`（已有 failureMessage） |
| done | accepted | 不额外显示 |

### 4.2 Layer 1 优化：状态条展开态

#### 4.2.1 展开时拉取失败详情

**问题 #1**：展开后无增量信息。

**方案**：`QualityStatusBar` 展开时调用 `quality.run.get`，缓存结果，展示：

```
┌─────────────────────────────────────────────┐
│ 🛡 L1 检查 · 3/4 · 1 失败 → 自动修复中 (2/3)  │
│                                              │
│ 失败检查：                                    │
│   ✗ build — exit code 1                      │
│     src/index.ts(42): type error             │
│                                              │
│ Blocking Findings：                           │
│   [critical] src/index.ts:42 类型不匹配       │
│                                              │
│ L3 需求验证：                                 │
│   ✓ RV-001 需要错误处理                      │
│   ✗ RV-002 需要单元测试                      │
│                                              │
│ 💡 修复预算耗尽，请向 AI 描述失败并要求修复    │
│                                              │
│ 查看完整证据 →                                │
└─────────────────────────────────────────────┘
```

展示规则：
- 失败 checks：只展示 `status !== "passed"` 的 check，显示 `checkId` + `summary`（前 200 字符）
- Blocking findings：只展示 `blocking === true` 的 finding，显示 `severity` + `claim` + `file:line`
- L3 verifications：展示全部，显示 `criterionId` + `status`（passed/failed/inconclusive）
- 如果没有失败 check / blocking finding / verifications，对应区不显示

数据缓存：展开时拉取一次，折叠后再展开重新拉取。不监听 runUpdate 刷新展开内容（避免展开态闪烁）。

#### 4.2.2 行动引导文案

**问题 #2**：失败后用户不知道该做什么。

**方案**：终态时根据 `failureCode` + `stage` + `fixRound` 显示引导：

| 条件 | 引导文案 |
|------|---------|
| stage=fixing | 不额外显示（fixer 进度已可见） |
| stage=failed, fc=fixer-budget-exhausted | "修复预算耗尽，请向 AI 描述失败原因并要求修复" |
| stage=failed, fc=l1-check-failed | "L1 检查未通过，请向 AI 描述失败并要求修复" |
| stage=failed, fc=l3-verification-failed | "需求验证未通过，请查看未满足的验收标准" |
| stage=failed, fc=fixer-session-error / fixer-prompt-error | "质量流程异常，可重新发送消息触发验证" |
| stage=failed, fc=fixer-infra-failed / l1-infra-failed | "检查基础设施异常，请检查环境后重试" |
| stage=inconclusive | "无法判定质量结论，请检查检查配置或重新发送消息" |
| stage=accepted | 不显示引导（10 秒后自动收起） |
| stage=awaiting-approval | 不显示引导（审批按钮已可见） |

群聊场景额外引导：
| 条件 | 引导文案 |
|------|---------|
| stage=failed, 群聊 task | "可点击重试按钮重新派发任务" |

#### 4.2.3 "查看完整证据"跳转

**问题 #4**：两个入口没有联动。

**方案**：展开详情底部添加"查看完整证据 →"链接。

Desktop 实现：
```ts
const handleViewEvidence = () => {
  useHubStore.setState({ qualityRunId: quality.runId, screen: "quality" });
};
```

Android 实现：
```kotlin
val handleViewEvidence = {
  vm.qualityRunId = q.runId
  vm.screen = Screen.Quality
}
```

QualityScreen 收到 `qualityRunId` 后自动选中并加载该 run 的详情。

### 4.3 Layer 2 优化：QualityScreen run 详情

#### 4.3.1 新增 L3 需求验证展示

**问题 #3**：L3 verifications 无处可看。

**方案**：

1. Desktop `types.ts` 新增 `RequirementVerification` 类型：
```ts
export interface RequirementVerification {
  id: string;
  runId: string;
  criterionId: string;
  expectationId: string;
  status: "passed" | "failed" | "inconclusive" | "waived";
  method: string;
  evidenceRefs: string[];
  verifier: string;
  confidence?: number;
  waiverReason?: string;
}
```

2. Desktop `store.ts`：`loadQualityRun` 解析 `verifications` 并存储到 `qualityVerifications` 状态

3. QualityScreen run 详情中，在 checks 和 findings 之间新增"L3 需求验证"区：
```
L3 需求验证（2）
  ✓ RV-001 — method: check — evidence: typecheck
  ✗ RV-002 — method: ai-inference — 无匹配证据
```

4. Android 同理：`ChatViewModel` 新增 `qualityVerifications` 状态，`QualityScreen` 新增验证展示区

#### 4.3.2 修正"重试"按钮语义

**问题 #6**：QualityScreen 的"重试"按钮调用 `quality.run.retry`，只重跑检查不重派 agent。

**方案**：
- QualityScreen 的"重试"按钮改名为"重跑检查"，并添加 tooltip 说明"仅重新执行质量检查，不会重新派发 AI 实现"
- 单会话场景：不在 QualityScreen 提供重试入口，引导用户回到聊天视图发新消息
- 群聊场景：重试通过 FlowTaskItem 的"重试"按钮（调用 `room.retryTasks` 重新派发）

#### 4.3.3 QualityScreen 上下文感知

**问题 #4**：QualityScreen 不感知当前聊天上下文。

**方案**：QualityScreen 顶部（项目选择卡片上方）新增"当前上下文"区：

```
┌─────────────────────────────────────────────┐
│ 当前会话：agent-hub                          │
│ 最新质量运行：🛡 L1 检查 · 3/4 · 1 失败       │
│ [查看聊天]  [查看完整证据]                    │
└─────────────────────────────────────────────┘
```

或群聊场景：
```
┌─────────────────────────────────────────────┐
│ 当前群聊：dev-team                           │
│ 正在验证：t1 (修复中 2/3), t2 (L1 检查)      │
│ [查看群聊]                                   │
└─────────────────────────────────────────────┘
```

数据来源：
- 单会话：`sessionQuality` 状态
- 群聊：`flow.tasks` 中 `status === "verifying"` 的任务及其 `quality` 字段

### 4.4 实时性修复：群聊 task.quality 中间阶段更新

**问题 #5**：quality.runUpdate 推送中间 stage 变化时，FlowTask.quality 不更新。

**根因**：conductor 只在 run 终态时调用 `emitFlow`，中间 stage 变化通过 `quality.runUpdate` 推送但不触发 `room.flowUpdate`。

**方案**：客户端侧修复——收到 `quality.runUpdate` 时，如果 run 有 `taskId` 且匹配当前 room 的某个 task，从全局 `qualityRuns` 中重新计算该 task 的 `quality` 摘要并更新 `flow`。

Desktop `store.ts`：
```ts
case "quality.runUpdate": {
  // ... 现有逻辑 ...

  // 新增：群聊 task.quality 实时更新
  const flow = get().flow;
  const currentRoom = get().currentRoom;
  if (flow && currentRoom && run.taskId && run.roomId === currentRoom.roomId) {
    const updatedTasks = flow.tasks.map((t) =>
      t.qualityRunId === run.id
        ? { ...t, quality: buildQualitySummary(run, params) }
        : t
    );
    set({ flow: { ...flow, tasks: updatedTasks } });
  }
  break;
}
```

Android `ChatViewModel` 同理。

这样不依赖 conductor 调用 emitFlow，客户端自行从 quality.runUpdate 同步 task.quality。

### 4.5 单会话多 run 选择逻辑优化

**问题 #10**：连续发两个 prompt 时 sessionQuality 被覆盖。

**方案**：`quality.runUpdate` 处理中，如果当前 `sessionQuality` 是非终态且新 run 是早期阶段（queued/preflight），不覆盖：

```ts
// 伪代码
const current = get().sessionQuality;
const isCurrentActive = current && !TERMINAL_STAGES.has(current.stage);
const isNewEarly = run.stage === "queued" || run.stage === "preflight";
if (isCurrentActive && isNewEarly) {
  // 当前有活跃 run，新 run 刚开始，不覆盖
  // 但可以将新 run ID 记录为 pending，当前 run 终态后切换
  return;
}
```

`loadSessionQuality` 初始化时也按此逻辑：优先取非终态 run，其次取最新终态 run。

### 4.6 标签映射统一

**问题 #9**：标签映射重复散落 5 个文件。

**方案**：

Desktop：新建 `desktop/src/hub/quality-labels.ts`，导出 `STAGE_LABELS`、`FAILURE_CODE_LABELS`、`ACTION_GUIDES`、`qualityStageLabel()`、`qualityFailureLabel()`、`actionGuide()`。ChatScreen 和 QualityScreen 共享。

Android：在 `ChatViewModel.kt` 的 companion object 中统一定义 `STAGE_LABELS`、`FAILURE_CODE_LABELS`、`ACTION_GUIDES` map 和 helper 函数。ChatScreen 和 QualityScreen 共享。

Hub：`conductor.ts` 的 `FAILURE_CODE_LABELS` 保持独立（后端逻辑，非 UI 标签）。

## 5. 改动清单

### 5.1 Desktop

| 文件 | 改动 |
|------|------|
| `desktop/src/hub/quality-labels.ts` | **新建**：统一标签映射 + 行动引导 |
| `desktop/src/hub/types.ts` | 新增 `RequirementVerification` 类型 |
| `desktop/src/hub/store.ts` | `loadQualityRun` 解析 verifications；`quality.runUpdate` 更新群聊 task.quality；多 run 选择逻辑优化；accepted 自动收起定时器 |
| `desktop/src/screens/ChatScreen.tsx` | `QualityStatusBar` 展开拉取详情；行动引导；跳转链接；群聊折叠态质量进度；引用共享标签 |
| `desktop/src/screens/QualityScreen.tsx` | 新增 L3 verifications 展示；上下文感知区；"重试"改名"重跑检查"；引用共享标签；从状态条跳转时自动选中 run |

### 5.2 Android

| 文件 | 改动 |
|------|------|
| `android/.../ChatViewModel.kt` | companion object 统一标签；新增 `RequirementVerification` data class + `qualityVerifications` 状态；`loadQualityRun` 解析 verifications；`quality.runUpdate` 更新群聊 task.quality；多 run 选择逻辑 |
| `android/.../ui/ChatScreen.kt` | `QualityStatusBar` 展开拉取详情；行动引导；跳转链接；群聊折叠态质量进度；引用共享标签 |
| `android/.../ui/QualityScreen.kt` | 新增 L3 verifications 展示；上下文感知区；"重试"改名；引用共享标签 |

### 5.3 Hub

无新增改动。`quality.run.get` 已返回 verifications，`quality.runUpdate` 已附带 checkStats/findingStats。本次优化全部在客户端侧。

## 6. 验证计划

### 6.1 类型检查和编译

```bash
cd hub && npx tsc --noEmit && npm test
cd desktop && npx tsc --noEmit
cd android && ./gradlew :app:compileDebugKotlin
```

### 6.2 功能验证

| # | 场景 | 预期 |
|---|------|------|
| 1 | 单会话发送代码变更，状态条出现 | 折叠态显示阶段 + L1 计数 |
| 2 | 点击状态条展开 | 显示失败 check 详情 + 行动引导 + "查看完整证据"链接 |
| 3 | 点击"查看完整证据" | 跳转到 QualityScreen，自动选中对应 run |
| 4 | QualityScreen 顶部显示当前上下文 | "当前会话: xxx" + 最新 run 状态 |
| 5 | QualityScreen run 详情 | 显示 L3 verifications 区 |
| 6 | accepted 后 10 秒 | 状态条自动收起为小图标 |
| 7 | 群聊任务验证中，折叠态 | 显示"🛡 修复 2/3"或"🛡 L1 3/4" |
| 8 | 群聊 quality.runUpdate 推送中间 stage | task.quality 实时更新（不依赖 flowUpdate） |
| 9 | 连续发两个 prompt，第一个在 fixing | 状态条显示第一个 run 的 fixing 状态，不被第二个 run 覆盖 |
| 10 | QualityScreen "重跑检查"按钮 | 文案为"重跑检查"而非"重试"，有 tooltip 说明 |

## 7. 优先级

| 优先级 | 改动 | 理由 |
|--------|------|------|
| P0 | 4.2.1 展开拉取失败详情 | 核心体验：展开后必须能看到增量信息 |
| P0 | 4.2.2 行动引导 | 失败后用户不知道该做什么 |
| P0 | 4.4 群聊 task.quality 实时更新 | 群聊中质量进度过时是功能性 bug |
| P1 | 4.3.1 L3 verifications 展示 | 数据已有但不可见，是功能缺口 |
| P1 | 4.2.3 跳转链接 | 两个入口联动 |
| P1 | 4.1.2 群聊折叠态质量进度 | 多任务场景减少点击 |
| P2 | 4.3.3 QualityScreen 上下文感知 | 改善但不紧急 |
| P2 | 4.1.1 accepted 自动收起 | 体验优化 |
| P2 | 4.5 多 run 选择逻辑 | 边界场景 |
| P3 | 4.3.2 "重试"改名 | 语义修正 |
| P3 | 4.6 标签统一 | 技术债 |

## 8. 不做的事

- 不改变 Hub 后端的 quality.run.get / quality.runUpdate / quality.run.listBySession 接口
- 不在 QualityScreen 中嵌入聊天功能
- 不改变 conductor 的 emitFlow 调用时机（客户端自行同步 task.quality）
- 不增加新的 npm/gradle 依赖
- 不改变 quality.run.retry 的后端语义（只改 UI 文案）
