# AI Review 优化方案

## 0. 问题现象

一个"给文件添加一行注释"的简单任务，在群聊派单模式下失败。根因链：

```
agent 完成实现 → quick gate 通过（typecheck passed）
  → isPolicyReviewEnabled(policy) = true  ← hub/.devin/quality.json 配置了 review.enabled: true
  → run 进入 reviewing 阶段
  → ReviewOrchestrator 创建 reviewer session (candied-milkshake)
  → reviewer 超时 300s（promptOnce timeout after 300000ms）
  → 直接 advance 到 failed
```

## 1. 第一性原理：AI Review 是什么，为什么需要它

### 1.1 Review 的本质

AI Review 是 L2 层的质量保障手段，用于捕获 L1 确定性检查（typecheck/test）无法发现的问题：

- 逻辑错误（类型安全但不正确的条件判断）
- 安全漏洞（注入、越权、信息泄露）
- 数据损坏（并发写入、事务边界缺失）
- 需求偏离（实现了功能但不符合意图）
- 严重退化（性能回退、API 破坏）

### 1.2 Review 的成本

每次 review 的实际开销：

| 维度 | 开销 |
|------|------|
| Session 创建 | 1-3s（ACP 握手 + session.new） |
| Prompt 构造 | 收集 ChangeSet + patch + checks + AGENTS.md |
| AI 推理 | 30-120s（取决于 patch 大小和模型速度） |
| 总耗时 | 60-180s 典型，复杂 patch 可达 300s+ |
| 资源占用 | 独立 session，占用一个 agent 连接槽 |

### 1.3 Review 的收益曲线

Review 的收益不是线性的：

```
收益
  ↑
  │    ┌──────────────  高风险变更（安全/数据/核心逻辑）
  │   /
  │  /
  │ /
  │/
  │────────────────────  中风险变更（业务逻辑/接口修改）
  │
  │────────────────────  低风险变更（注释/格式/文档）
  │
  └────────────────────→ 变更风险
```

**低风险变更（如加注释）的 review 收益接近零**——L1 检查已经足够。强行 review 只增加延迟和失败概率。

## 2. 当前问题诊断

### 2.1 配置问题：review.enabled 对所有变更无差别启用

`hub/.devin/quality.json` 配置了 `review.enabled: true`，导致**每一个代码变更**都触发 AI review，不区分风险等级。

```json
// hub/.devin/quality.json（当前）
"review": {
  "enabled": true,          // ← 所有变更都 review
  "maxFixRounds": 2
}
```

加一行注释和重写安全模块走同样的 review 流程，这不合理。

### 2.2 架构问题：review 失败不感知 enforcement 模式

`review-orchestrator.ts` 在 reviewer 超时/失败时**无条件 advance 到 `failed`**：

```ts
// review-orchestrator.ts:230-231
const failed = this.service.advance(runId, "failed");
```

但 policy 配置了 `autonomy: "observe"` → `enforcement: "report"`（仅报告不阻断）。在 report 模式下，review 失败应该降级为 advisory，不阻断后续流程。

### 2.3 模型问题：reviewer 无独立模型配置

`ModelManager` 支持按 session 设置模型（`setForSession`），但 `reviewerSessionRunner` 从未调用它。reviewer 使用与 implementer 相同的模型。

从第一性原理看，reviewer 和 implementer 的任务特征不同：

| 维度 | Implementer | Reviewer |
|------|-------------|----------|
| 任务 | 生成代码 | 审查代码 |
| 输出 | 多文件编辑 | 结构化 JSON |
| 思维模式 | 建设性 | 批判性 |
| 理想模型 | 擅长编码 | 擅长推理/发现缺陷 |

用同一个模型自己审查自己的代码，存在"认知盲区"问题。

### 2.4 超时问题：300s 固定超时 + 超时后 session 永久 busy

- 300s 对简单变更太长，对复杂变更太短
- 超时后 `promptOnceWaiters` 被删除，但 `promptContent` 仍在执行
- session 的 `busy` 标记仍为 true，后续复用会失败
- 没有自动 cancel/stop 机制

### 2.5 风险门控缺失：review 不看 risk 等级

`advanceAfterGate` 中的判断：

```ts
// index.ts:322
qualityService.advance(runId, isPolicyReviewEnabled(policy) ? "reviewing" : "full-verifying");
```

只看 `review.enabled`，不看 `run.risk`。一个 `risk: "low"` 的注释变更和 `risk: "critical"` 的安全修改走同一条路。

## 3. 优化方案

### 3.1 引入 review.minRisk 风险门控（P0）

**原理**：review 应该按风险等级选择性触发，而非全量触发。

**v1 policy 扩展**（向后兼容）：

```json
"review": {
  "enabled": true,
  "minRisk": "medium",       // 新增：仅 medium 及以上风险才触发 review
  "blockSeverity": "major",
  "minBlockingConfidence": 0.8,
  "maxFixRounds": 2
}
```

**v2 policy**（已有 mode 字段，扩展 minRisk）：

```json
"review": {
  "mode": "advisory",        // off | advisory | blocking
  "minRisk": "medium",       // 新增：仅 medium 及以上风险才触发
  "blockSeverity": "major",
  "minBlockingConfidence": 0.8
}
```

**门控逻辑**（修改 `advanceAfterGate`）：

```ts
// 当前
qualityService.advance(runId, isPolicyReviewEnabled(policy) ? "reviewing" : "full-verifying");

// 优化后
const reviewEnabled = isPolicyReviewEnabled(policy);
const minRisk = getPolicyReviewMinRisk(policy);  // 新增：默认 "low"（兼容现有行为）
const riskOrder = ["low", "medium", "high", "critical"];
const shouldReview = reviewEnabled && riskOrder.indexOf(run.risk) >= riskOrder.indexOf(minRisk);
qualityService.advance(runId, shouldReview ? "reviewing" : "full-verifying");
```

**效果**：`minRisk: "medium"` 时，加注释（risk=low）跳过 review，修改安全代码（risk=high）仍触发 review。

### 3.2 Review 失败感知 enforcement 模式（P0）

**原理**：`report` 模式下 review 失败不应阻断，应降级为 advisory。

**修改 `review-orchestrator.ts`**：

```ts
// reviewer prompt 失败时的处理（:213-238）
} catch (err) {
  logWarn("review", `reviewer prompt failed for run ${runId}: ${String(err)}`);
  this.service.saveReviewDecision({ ... });

  const policy = this.service.getPolicy(run.projectId).policy;
  const enforcement = getPolicyEnforcement(policy);

  if (enforcement === "report") {
    // report 模式：review 失败不阻断，跳过 review 继续
    logWarn("review", `run ${runId} enforcement=report, skipping review on failure`);
    const next = this.service.advance(runId, "full-verifying");
    return { runId, verdict: "uncertain", findings: [], parseError: `reviewer prompt failed: ${String(err)}`, nextStage: next.stage };
  }

  // require-pass / require-approval 模式：review 失败 = 质量失败
  const failed = this.service.advance(runId, "failed");
  return { runId, verdict: "uncertain", findings: [], parseError: ..., nextStage: failed.stage };
}
```

同样修改 `parseError` 和 `isReadOnlyEnforced` 失败路径。

### 3.3 Reviewer 独立模型配置（P1）

**原理**：reviewer 可以使用不同的模型，适合审查而非生成。

**policy 扩展**：

```json
"review": {
  "enabled": true,
  "minRisk": "medium",
  "model": "swe-1-7",        // 新增：reviewer 专用模型，可选
  ...
}
```

**实现**：在 `reviewerSessionRunner.ensureSession` 创建 session 后，调用 `modelManager.setForSession`：

```ts
const reviewerSessionRunner: ReviewerSessionRunner = {
  async ensureSession(opts) {
    if (opts.existingSessionId) return opts.existingSessionId;
    const agent = [...agents.values()].find((a) => a.isReady);
    if (!agent) throw new Error("no agent available for reviewer session");
    const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
    owners.set(sessionId, ...);

    // 设置 reviewer 专用模型（如果 policy 配置了）
    const { policy } = qualityService.getPolicy(opts.project.id);
    const reviewModel = policy.version === 1 ? policy.review.model : undefined;  // v2 待定
    if (reviewModel) {
      try { await modelManager.setForSession(reviewModel, sessionId); }
      catch (err) { logWarn("review", `failed to set reviewer model: ${String(err)}`); }
    }
    return sessionId;
  },
  ...
};
```

### 3.4 超时后自动 cancel + 自适应超时（P1）

**原理**：超时后应清理 session 状态，而非留下永久 busy 的 session。超时应按 patch 大小自适应。

**修改 `agent.ts` 的 `promptOnce`**：

```ts
async promptOnce(sessionId, text, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.promptOnceWaiters.delete(sessionId);
      // 超时后自动 cancel，避免 session 永久 busy
      this.cancel(sessionId).catch(() => { /* session 可能已结束 */ });
      reject(new Error(`promptOnce timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    // ...
  });
}
```

**自适应超时**（`review-orchestrator.ts`）：

```ts
// 根据 patch 大小调整超时
const patchLines = patch ? patch.split("\n").length : 0;
const adaptiveTimeout = Math.min(
  Math.max(this.reviewTimeoutMs, patchLines * 500),  // 每行 0.5s
  600_000  // 上限 10 分钟
);
const result = await this.sessionRunner.promptOnce(reviewerSessionId, prompt, adaptiveTimeout);
```

### 3.5 调整 hub/.devin/quality.json 配置（P0，立即执行）

**原理**：当前项目阶段（dogfood 验证期）不需要对所有变更做 AI review。设为 advisory + minRisk=medium，让低风险变更快速通过，中高风险变更才触发 review。

```json
// hub/.devin/quality.json（优化后）
{
  "version": 1,
  "checks": [
    { "id": "typecheck", "cwd": ".", "argv": ["npx", "tsc", "--noEmit"], "tier": "quick", "timeoutMs": 120000, "required": true },
    { "id": "test", "cwd": ".", "argv": ["npm", "test"], "tier": "full", "timeoutMs": 300000, "required": true }
  ],
  "protectedPaths": [".devin/quality.json", "src/quality/", "src/agent.ts", "src/scheduler.ts"],
  "riskRules": [
    { "pattern": ".devin/quality.json", "risk": "critical", "reason": "质量策略自修改" },
    { "pattern": "src/quality/", "risk": "high", "reason": "质量引擎/权限路径" }
  ],
  "review": {
    "enabled": true,
    "minRisk": "medium",
    "blockSeverity": "major",
    "minBlockingConfidence": 0.8,
    "maxFixRounds": 2
  },
  "autonomy": "observe"
}
```

**效果**：
- 加注释（risk=low）→ 跳过 review，直接 full-verifying
- 修改 `src/quality/` 下的代码（risk=high）→ 触发 review
- 修改 `quality.json`（risk=critical）→ 触发 review
- review 超时/失败时，因为 `autonomy=observe`（report 模式），不阻断流程

## 4. 实施计划

### 阶段 1：立即修复（P0）

1. **修改 `hub/.devin/quality.json`**：添加 `minRisk: "medium"`
2. **修改 `review-orchestrator.ts`**：review 失败时感知 enforcement 模式
3. **修改 `index.ts` 的 `advanceAfterGate`**：加入 risk 门控
4. **修改 `policy.ts`**：解析 `review.minRisk`，默认 `"low"`（兼容）
5. **修改 `types.ts`**：v1/v2 policy 类型添加 `minRisk` 字段
6. **添加测试**：minRisk 门控、report 模式降级

### 阶段 2：模型与超时优化（P1）

7. **修改 `reviewerSessionRunner`**：支持 reviewer 专用模型
8. **修改 `agent.ts` 的 `promptOnce`**：超时后自动 cancel
9. **修改 `review-orchestrator.ts`**：自适应超时
10. **添加测试**：模型设置、超时 cancel

### 阶段 3：v2 policy 迁移（P2）

11. 将 `hub/.devin/quality.json` 迁移到 v2 格式
12. v2 的 `review.mode: "advisory"` + `review.minRisk: "medium"`
13. `review.mode: "blocking"` 对应 `enforcement: "require-pass"`

## 5. 验证方法

### 单元测试

```bash
cd hub && npm test
```

新增测试用例：
- `policy.test.ts`：minRisk 解析、默认值、v1/v2 兼容
- `review-orchestrator.test.ts`：report 模式降级、require-pass 模式失败
- `gate.test.ts`：risk 门控（low 跳过、medium 触发）

### 端到端验证

1. 在群聊中派发"加注释"任务 → 确认跳过 review，直接 accepted
2. 在群聊中派发"修改 quality 引擎"任务 → 确认触发 review
3. 模拟 reviewer 超时 → 确认 report 模式下降级为 full-verifying
4. 确认 reviewer session 超后不再永久 busy

## 6. 设计决策记录

### 为什么不直接关闭 review？

`review.enabled: false` 虽然能解决当前问题，但失去了对中高风险变更的 AI 审查能力。`minRisk: "medium"` 在保留审查能力的同时避免低风险变更的无效 review。

### 为什么用 v1 的 minRisk 而非直接迁移 v2？

v2 的 `review.mode: "advisory" | "blocking"` 语义更清晰，但迁移涉及面广（enforcement/remediation/requirements/verification 全部重构）。`minRisk` 作为 v1 的增量扩展，向后兼容，可以立即落地。v2 迁移作为 P2 后续推进。

### 为什么 reviewer 需要独立模型？

用同一个模型"自己审查自己的代码"存在认知盲区。不同模型有不同的训练数据和偏好，交叉审查能发现更多问题。但这是 P1，因为当前模型列表有限，先让 minRisk + enforcement 降级解决阻塞问题。

## 7. 落地细节确认（模型选择机制）

### 7.1 当前模型选择优先级链

```
session 偏好 (session-model-preferences.json)
  ↓ 未命中
后端偏好 (model-preference.json)
  ↓ 未命中（仅 devin 后端）
acp-model.json (~/.config/devin/acp-model.json)
  ↓ 未命中
config.json (~/.config/devin/config.json → agent.model)
  ↓ 未命中
默认模型 (devin → "swe-1-7", opencode → "opencode/big-pickle", 其他 → "")
```

### 7.2 当前实际生效的模型

| 配置文件 | 值 | 优先级 |
|----------|-----|--------|
| `model-preference.json` | `devin: "glm-5-2"` | 2（后端偏好） |
| `acp-model.json` | `model: "glm-5-2"` | 3 |
| `config.json` | `agent.model: "swe-1-7"` | 4 |

**对新建 session（无 session 偏好时）**：devin 后端生效模型为 `glm-5-2`（后端偏好命中）。

### 7.3 reviewer session 创建的关键缺失

**`session.create` handler 的模型同步流程**（index.ts:1557-1568）：

```ts
// 1. 注入 agent 上报的模型列表
modelManager.injectConfigOptions(backend, configOptions);
// 2. 按优先级链获取当前模型
const current = modelManager.current(backend, s.sessionId);
// 3. 通过 ACP setConfigOption 同步到 agent
await agent.setConfigOption(s.sessionId, "model", current.uid);
```

**`reviewerSessionRunner.ensureSession` 的实际实现**（index.ts:139-148）：

```ts
const agent = [...agents.values()].find((a) => a.isReady);
const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
owners.set(sessionId, ...);
// ← 缺少：modelManager.injectConfigOptions + modelManager.current + setConfigOption
return sessionId;
```

**问题**：reviewer session 创建后**不同步模型**。agent 使用自身默认模型，而非 Hub 配置的偏好模型（`glm-5-2`）。这导致：
- reviewer 可能使用与 implementer 不同的模型（agent 默认 vs Hub 偏好）
- 模型选择不可控、不可观测
- 如果 agent 默认模型响应慢或不擅长审查，review 容易超时

`fixerSessionRunner` 存在完全相同的问题。

### 7.4 落地方案：reviewer 模型设置

**修改 `reviewerSessionRunner.ensureSession`**：

```ts
const reviewerSessionRunner: ReviewerSessionRunner = {
  async ensureSession(opts) {
    if (opts.existingSessionId) return opts.existingSessionId;
    const agent = [...agents.values()].find((a) => a.isReady);
    if (!agent) throw new Error("no agent available for reviewer session");
    const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
    owners.set(sessionId, [...agents.entries()].find(([, a]) => a === agent)![0]);

    // 同步模型（与 session.create handler 一致的逻辑）
    const connectionId = owners.get(sessionId);
    const connection = connectionId ? getConnectionById(connectionId) : undefined;
    const backend = (connection?.agent ?? "devin") as ModelBackend;
    const configOptions = agent.getConfigOptions();
    if (configOptions) modelManager.injectConfigOptions(backend, configOptions);

    // 优先使用 policy 中配置的 reviewer 模型，否则使用后端当前模型
    const { policy } = qualityService.getPolicy(opts.project.id);
    const reviewModel = policy.version === 1 ? policy.review.model : undefined;
    if (reviewModel) {
      try {
        const model = await modelManager.setForSession(reviewModel, sessionId);
        await agent.setConfigOption(sessionId, "model", model.uid);
      } catch (err) {
        logWarn("review", `failed to set reviewer model ${reviewModel}: ${String(err)}`);
        // 降级：使用后端当前模型
        const current = modelManager.current(backend, sessionId);
        await agent.setConfigOption(sessionId, "model", current.uid)
          .catch((e) => logWarn("review", `fallback model sync failed: ${String(e)}`));
      }
    } else {
      const current = modelManager.current(backend, sessionId);
      await agent.setConfigOption(sessionId, "model", current.uid)
        .catch((err) => logWarn("review", `reviewer model sync failed: ${String(err)}`));
    }
    return sessionId;
  },
  ...
};
```

**`fixerSessionRunner` 同理修复**。

### 7.5 policy 中 review.model 字段

**v1 policy 扩展**（types.ts）：

```ts
review: {
  enabled: boolean;
  reviewerSessionId?: string | undefined;
  model?: string | undefined;         // 新增：reviewer 专用模型 uid
  blockSeverity: "critical" | "major";
  minBlockingConfidence: number;
  maxFixRounds: number;
};
```

**校验**（policy.ts）：

```ts
if (rv.model !== undefined && typeof rv.model !== "string") {
  errors.push("review.model must be string if present");
}
```

**quality.json 示例**：

```json
"review": {
  "enabled": true,
  "minRisk": "medium",
  "model": "swe-1-7",
  ...
}
```

### 7.6 落地步骤确认

| 步骤 | 修改文件 | 内容 |
|------|----------|------|
| 1 | `hub/.devin/quality.json` | 添加 `"minRisk": "medium"` |
| 2 | `hub/src/quality/types.ts` | v1 QualityPolicy.review 添加 `model?` 和 `minRisk?` 字段 |
| 3 | `hub/src/quality/policy.ts` | 校验 `review.model` 和 `review.minRisk`；新增 `getPolicyReviewMinRisk()` |
| 4 | `hub/src/index.ts` `advanceAfterGate` | 加入 risk 门控：`shouldReview = reviewEnabled && riskOrder(run.risk) >= riskOrder(minRisk)` |
| 5 | `hub/src/quality/review-orchestrator.ts` | review 失败时感知 enforcement：report 模式降级为 full-verifying |
| 6 | `hub/src/index.ts` `reviewerSessionRunner` | 创建 session 后同步模型（policy 配置或后端默认） |
| 7 | `hub/src/index.ts` `fixerSessionRunner` | 同步修复模型缺失 |
| 8 | `hub/src/agent.ts` `promptOnce` | 超时后自动 cancel session |
| 9 | `hub/src/quality/review-orchestrator.ts` | 自适应超时（按 patch 行数） |
| 10 | 测试 | minRisk 门控、report 降级、模型同步、超时 cancel |

### 7.7 边界条件确认

1. **`review.model` 指定的模型不存在**：`modelManager.setForSession` 会抛 `unknown model`，catch 后降级为后端当前模型
2. **agent 不支持 `setConfigOption`**：`.catch` 记录 warning，不阻断 review 流程
3. **`review.minRisk` 未配置**：默认 `"low"`，兼容现有行为（所有变更都 review）
4. **v2 policy**：v2 的 `review` 没有 `model` 字段，P2 迁移时再添加
5. **reviewer session 复用**：`existingSessionId` 存在时直接返回，不重新设置模型（模型在首次创建时已设置）
6. **fixer session 复用 implementer session**：复用时不重新设置模型（implementer 的模型已确定）
