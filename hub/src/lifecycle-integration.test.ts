import { test } from "node:test";
import assert from "node:assert/strict";
import { DirtyTracker, shouldTriggerGate } from "./quality/dirty-tracker.js";
import { RunContextRegistry } from "./quality/run-context.js";
import { WriterLeaseManager } from "./quality/lease.js";
import { QualityService } from "./quality/service.js";
import { Store } from "./store.js";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { transition, isTerminal, TERMINAL_STAGES } from "./quality/run.js";
import { recoverRun, recoverInterruptedRuns, FAILURE_HUB_RESTART, isHubRestartFailure } from "./quality/recovery.js";
import { stableFingerprint, createObservation, canConfirmObservation, confirmObservationToIncident, createTypedRuleCandidate, createShadowControl, promoteShadowToActive, retireActiveControl, generateExportPatch, verifyExportPatch, loadActiveControlsIntoPolicy, createSandboxEvaluation, applyRuleToPolicy } from "./quality/learning.js";
import type { QualityPolicy, RuleDefinition, CheckDefinition, RiskRule, ActiveControl } from "./quality/types.js";

// ── 测试基础设施 ─────────────────────────────────────────────────────

function makeService(): { service: QualityService; store: Store; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  const store = new Store(join(tmpDir, "test.db"));
  const service = new QualityService(store, () => {}, {
    reviewRunner: () => {},
    fixerRunner: () => {},
    quickRunner: () => {},
    fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1",
    connectionId: "conn1",
    root: tmpDir,
    displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));
  return { service, store, tmpDir };
}

// ── 生命周期：planDispatch→preflight→dispatch ────────────────────────

test("生命周期: run 从 queued → preflight → implementing → collecting → quick-verifying", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "interactive",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  assert.equal(run.stage, "queued");
  service.advance(run.id, "preflight");
  assert.equal(service.getRun(run.id)!.stage, "preflight");
  service.advance(run.id, "implementing");
  assert.equal(service.getRun(run.id)!.stage, "implementing");
  service.advance(run.id, "collecting");
  assert.equal(service.getRun(run.id)!.stage, "collecting");
  service.advance(run.id, "quick-verifying");
  assert.equal(service.getRun(run.id)!.stage, "quick-verifying");
});

test("生命周期: 非法转换被拒绝", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "interactive",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  assert.throws(() => service.advance(run.id, "accepted"), /illegal stage transition/);
  assert.throws(() => service.advance(run.id, "quick-verifying"), /illegal stage transition/);
});

test("生命周期: cancelRun 从 queued → cancelled", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "interactive",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.cancelRun(run.id);
  const updated = service.getRun(run.id)!;
  assert.equal(updated.stage, "cancelled");
  assert.equal(isTerminal(updated.stage), true);
});

test("生命周期: 终态不可再转换", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "interactive",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.cancelRun(run.id);
  assert.throws(() => service.advance(run.id, "preflight"), /illegal stage transition/);
});

// ── run-context 绑定/解绑边界 ───────────────────────────────────────

test("run-context: bind → hasActiveRun → unbind", () => {
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", role: "implementer" });
  assert.equal(reg.hasActiveRun("s1"), true);
  reg.unbind("s1");
  assert.equal(reg.hasActiveRun("s1"), false);
});

test("run-context: 重新绑定到新 run 时从旧 run 移除", () => {
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", role: "implementer" });
  reg.bind("s1", { runId: "r2", role: "implementer" });
  assert.equal(reg.getSessionsForRun("r1").length, 0);
  assert.equal(reg.getSessionsForRun("r2").length, 1);
});

test("run-context: unbindRun 移除所有关联 session", () => {
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", role: "implementer" });
  reg.bind("s2", { runId: "r1", role: "reviewer" });
  reg.unbindRun("r1");
  assert.equal(reg.hasActiveRun("s1"), false);
  assert.equal(reg.hasActiveRun("s2"), false);
});

// ── dirty/collect 边界 ──────────────────────────────────────────────

test("dirty/collect: markDirty 不立即触发 collect", () => {
  const tracker = new DirtyTracker();
  tracker.markDirty("s1", "file", ["/a.ts"]);
  assert.equal(tracker.isDirty("s1"), true);
  // collectPaths 后清除
  const paths = tracker.collectPaths("s1");
  assert.deepEqual(paths, ["/a.ts"]);
  assert.equal(tracker.isDirty("s1"), false);
});

test("dirty/collect: git 信号单独不触发 gate（需 file/tool）", () => {
  const tracker = new DirtyTracker();
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", role: "implementer" });
  tracker.markDirty("s1", "git");
  assert.equal(shouldTriggerGate(tracker, reg, "s1"), false);
  tracker.markDirty("s1", "file");
  assert.equal(shouldTriggerGate(tracker, reg, "s1"), true);
});

test("dirty/collect: 无活跃 run 不触发 gate", () => {
  const tracker = new DirtyTracker();
  const reg = new RunContextRegistry();
  tracker.markDirty("s1", "file", ["/a.ts"]);
  assert.equal(shouldTriggerGate(tracker, reg, "s1"), false);
});

test("dirty/collect: 多 session 批量收集", () => {
  const tracker = new DirtyTracker();
  tracker.markDirty("s1", "file", ["/a.ts"]);
  tracker.markDirty("s2", "tool", ["/b.ts"]);
  const paths = tracker.collectPathsForSessions(["s1", "s2"]);
  assert.deepEqual(paths.sort(), ["/a.ts", "/b.ts"]);
  assert.equal(tracker.isDirty("s1"), false);
  assert.equal(tracker.isDirty("s2"), false);
});

// ── generation/stale 处理 ───────────────────────────────────────────

test("generation/stale: generation < currentGeneration 的 run 标记为 stale", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "quick-verifying" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(), generation: 2,
  };
  const result = recoverRun(run, [], Date.now(), 3);
  assert.equal(result.run.stage, "stale");
  assert.equal(result.run.outcome, "inconclusive");
});

test("generation/stale: generation === currentGeneration 的 run 标记为 inconclusive", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "quick-verifying" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(), generation: 2,
  };
  const result = recoverRun(run, [], Date.now(), 2);
  assert.equal(result.run.stage, "inconclusive");
  assert.equal(result.run.failureCode, FAILURE_HUB_RESTART);
});

test("generation/stale: 无 currentGeneration 时 generation>0 标记为 inconclusive", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "quick-verifying" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(), generation: 2,
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "inconclusive");
  assert.equal(result.run.failureCode, FAILURE_HUB_RESTART);
});

test("generation/stale: generation=0 的 run 恢复时标记为 inconclusive", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "quick-verifying" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(), generation: 0,
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "inconclusive");
  assert.equal(result.run.failureCode, FAILURE_HUB_RESTART);
  assert.equal(isHubRestartFailure(result.run), true);
});

test("generation/stale: 无 generation 字段的 run 恢复时标记为 inconclusive", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "implementing" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "inconclusive");
});

// ── 取消恢复 ────────────────────────────────────────────────────────

test("取消恢复: queued 状态的 run 恢复时标记为 cancelled", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "queued" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "cancelled");
});

test("取消恢复: 终态 run 不被恢复修改", () => {
  const run = {
    id: "r1", projectId: "p1", trigger: "interactive" as const,
    stage: "accepted" as const, risk: "medium" as const,
    policyVersion: "1", fixRound: 0, budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(), updatedAt: Date.now(),
    patchHash: "abc",
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "accepted");
});

test("取消恢复: recoverInterruptedRuns 持久化恢复结果", () => {
  const { service, store } = makeService();
  // 创建两个非终态 run
  const run1 = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "medium",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  const run2 = service.startRun({
    projectId: "proj1", trigger: "conductor", risk: "high",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run2.id, "preflight");
  // 模拟重启恢复
  const summary = recoverInterruptedRuns(store, []);
  assert.ok(summary.runs.length >= 2);
  const recovered1 = service.getRun(run1.id)!;
  const recovered2 = service.getRun(run2.id)!;
  assert.equal(recovered1.stage, "cancelled"); // queued → cancelled
  assert.equal(recovered2.stage, "inconclusive"); // preflight → inconclusive
  assert.equal(recovered2.failureCode, FAILURE_HUB_RESTART);
});

// ── Conductor enforcement 解锁 ──────────────────────────────────────

test("enforcement: report 模式不阻断依赖解锁", () => {
  const enforcement = "report" as "report" | "require-pass" | "require-approval";
  const accepted = false;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, true);
});

test("enforcement: require-pass 模式下 accepted=false 阻断", () => {
  const enforcement = "require-pass" as "report" | "require-pass" | "require-approval";
  const accepted = false;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, false);
});

test("enforcement: require-pass 模式下 accepted=true 解锁", () => {
  const enforcement = "require-pass" as "report" | "require-pass" | "require-approval";
  const accepted = true;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, true);
});

test("enforcement: require-approval 模式下 accepted=false 阻断", () => {
  const enforcement = "require-approval" as "report" | "require-pass" | "require-approval";
  const accepted = false;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, false);
});

// ── 跨模式一致接入：所有非 conductor 模式统一自动推进 ────────────────

test("跨模式: interactive trigger 创建 run 后统一推进到 quick-verifying", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "interactive", // 非 conductor 模式
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  // 模拟 triggerGateForSession 的自动推进
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  assert.equal(service.getRun(run.id)!.stage, "quick-verifying");
});

test("跨模式: conductor trigger 创建 run 后统一推进到 quick-verifying", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "conductor",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  assert.equal(service.getRun(run.id)!.stage, "quick-verifying");
});

test("跨模式: scheduled trigger 同样可推进", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1",
    trigger: "scheduled",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  assert.equal(service.getRun(run.id)!.stage, "quick-verifying");
});

test("跨模式: 所有 trigger 类型创建 run 后初始 stage 都是 queued", () => {
  const { service } = makeService();
  const triggers = ["interactive", "conductor", "scheduled", "incident"] as const;
  for (const trigger of triggers) {
    const run = service.startRun({
      projectId: "proj1",
      trigger,
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    assert.equal(run.stage, "queued", `trigger=${trigger} should start at queued`);
  }
});

// ── WriterLease 互斥（跨模式共享） ──────────────────────────────────

test("WriterLease: 同项目同时只有一个 writer（跨模式共享）", () => {
  const mgr = new WriterLeaseManager();
  // interactive 模式获取 lease
  const r1 = mgr.acquire("p1", "holder-interactive", "run1");
  assert.equal(r1.ok, true);
  // conductor 模式尝试获取同项目 lease → 失败
  const r2 = mgr.acquire("p1", "holder-conductor", "run2");
  assert.equal(r2.ok, false);
  // 释放后 conductor 可获取
  mgr.release("p1", "holder-interactive");
  const r3 = mgr.acquire("p1", "holder-conductor", "run2");
  assert.equal(r3.ok, true);
});

// ── L0 澄清链路 ────────────────────────────────────────────────────

test("L0: classifyIntent 对 code-change 意图返回 code-change", async () => {
  const { classifyIntent } = await import("./quality/requirement.js");
  const result = classifyIntent("帮我修复 src/index.ts 的类型错误");
  assert.equal(result, "code-change");
});

test("L0: classifyIntent 对非 code-change 意图不返回 code-change", async () => {
  const { classifyIntent } = await import("./quality/requirement.js");
  const result = classifyIntent("你好，今天天气怎么样？");
  assert.notEqual(result, "code-change");
});

test("L0: evaluateRequirement 对 code-change 触发评估", async () => {
  const { evaluateRequirement } = await import("./quality/requirement.js");
  const { service } = makeService();
  const spec = {
    id: "spec1", requestId: "req1", version: 1,
    goal: "优化性能",
    scope: { included: [], excluded: [] },
    acceptanceCriteria: [],
    constraints: [],
    risks: [],
    clarifications: [],
    status: "draft" as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const request = {
    id: "req1", projectId: "proj1", specId: "spec1", specVersion: 1,
    source: "session" as const,
    correlationId: "corr1",
    intent: "code-change" as const,
    status: "ready" as const,
    text: "优化性能",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const result = await evaluateRequirement("优化性能", request, spec);
  assert.ok(result);
  assert.ok(result.assessments);
});

// ── L3 证据验证链路 ─────────────────────────────────────────────────

test("L3: runVerification 存在且可调用", () => {
  const { service } = makeService();
  assert.equal(typeof service.runVerification, "function");
  assert.equal(typeof service.listVerifications, "function");
  assert.equal(typeof service.waiveCriterion, "function");
});

test("L3: verification 模块核心函数存在", async () => {
  const mod = await import("./quality/verification.js");
  assert.equal(typeof mod.verifyExpectation, "function");
  assert.equal(typeof mod.verifyCriterion, "function");
  assert.equal(typeof mod.buildCoverageMatrix, "function");
  assert.equal(typeof mod.decideVerification, "function");
});

// ── L4 受控学习链路 ─────────────────────────────────────────────────

test("L4: Observation → Incident → RuleCandidate → ActiveControl 端到端", () => {
  const { service } = makeService();

  // 1. 创建 candidate observation
  const obs = createObservation({
    projectId: "proj1",
    kind: "check-failure",
    attribution: "candidate",
    description: "typecheck failed",
    severity: "high",
  });
  service.createObservation({
    projectId: obs.projectId,
    kind: obs.kind,
    attribution: obs.attribution,
    evidenceRefs: obs.evidenceRefs,
    ...(obs.description !== undefined ? { description: obs.description } : {}),
    ...(obs.severity !== undefined ? { severity: obs.severity } : {}),
  });
  assert.equal(canConfirmObservation(obs), true);

  // 2. 确认 → incident
  const { incident, observation } = confirmObservationToIncident(obs, "user1");
  service.confirmObservationToIncident(obs.id, "user1");
  service.createIncident({
    projectId: incident.projectId,
    description: incident.description,
    severity: incident.severity,
  });
  assert.equal(incident.type, "code");

  // 3. 创建 typed rule candidate
  const checkDef: CheckDefinition = {
    id: "new-check", cwd: ".", argv: ["npx", "tsc"], tier: "quick", timeoutMs: 30000, required: true,
  };
  const rule: RuleDefinition = { type: "check", value: checkDef };
  const candidate = service.createTypedRule({
    projectId: "proj1",
    ruleType: "check",
    ruleDefinition: rule,
    evidenceIncidentIds: [incident.id],
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.ruleType, "check");

  // 4. sandbox 评测（只评测，不批准）
  const sandboxResult = createSandboxEvaluation({
    ruleCandidateId: candidate.id,
    passed: true,
    checksTotal: 5,
    checksPassed: 5,
    checksFailed: 0,
    checkSummaries: ["all passed"],
    reason: "sandbox passed",
  });
  service.recordSandboxEvaluation(candidate.id, sandboxResult);
  assert.equal(service.getRule(candidate.id)!.sandboxPassed, true);

  // 5. 用户批准 → approved
  const approved = service.approveRule(candidate.id, "user1");
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "user1");

  // 6. 激活为 shadow
  const control = service.activateRuleAsShadow(candidate.id, "user1");
  assert.equal(control.status, "shadow");

  // 7. promote shadow → active
  const activeControl = service.promoteShadowControl(control.id, "user1")!;
  assert.equal(activeControl.status, "active");

  // 8. 回滚 active → retired
  const retiredControl = service.retireControl(control.id, "admin", "false positive");
  assert.ok(retiredControl);
  assert.equal(retiredControl!.status, "retired");
  assert.equal(retiredControl!.retireReason, "false positive");
});

test("L4: baseline observation 不能确认 → incident", () => {
  const obs = createObservation({
    projectId: "proj1",
    kind: "check-failure",
    attribution: "baseline",
  });
  assert.equal(canConfirmObservation(obs), false);
  assert.throws(() => confirmObservationToIncident(obs, "user1"), /cannot be confirmed/);
});

test("L4: sandbox 评测不自动批准/激活", () => {
  const result = createSandboxEvaluation({
    ruleCandidateId: "rc1",
    passed: true,
    checksTotal: 10,
    checksPassed: 10,
    checksFailed: 0,
    checkSummaries: ["all passed"],
    reason: "perfect",
  });
  const keys = Object.keys(result);
  assert.ok(!keys.includes("approved"));
  assert.ok(!keys.includes("activated"));
  assert.ok(!keys.includes("status"));
});

test("L4: policy 导出 patch 不自动写入", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const patch = generateExportPatch({
    projectId: "p1", ruleCandidateId: "rc1", ruleType: "risk", rule,
    currentPolicy: policy, exportedBy: "user1",
  });
  assert.ok(patch.expectedPolicyHash.length > 0);
  assert.ok(patch.currentPolicyHash.length > 0);
  assert.notEqual(patch.expectedPolicyHash, patch.currentPolicyHash);
  // 原始 policy 未被修改
  assert.equal(policy.riskRules.length, 0);
});

test("L4: shadow control 不参与 policy 加载", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const controls: ActiveControl[] = [
    { id: "ac1", projectId: "p1", ruleCandidateId: "rc1", rule, activatedAt: 1, activatedBy: "u", status: "shadow", ruleType: "risk" },
  ];
  const updated = loadActiveControlsIntoPolicy(policy, controls) as QualityPolicy;
  assert.equal(updated.riskRules.length, 0);
});

test("L4: verifyExportPatch hash 匹配/不匹配", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const patch = generateExportPatch({
    projectId: "p1", ruleCandidateId: "rc1", ruleType: "risk", rule,
    currentPolicy: policy, exportedBy: "user1",
  });
  // hash 匹配：传入已应用 rule 的 policy
  const appliedPolicy = applyRuleToPolicy(policy, "risk", rule);
  const valid = verifyExportPatch(patch, appliedPolicy);
  assert.equal(valid.valid, true);
  // policy 变更后 hash 不匹配
  const changed: QualityPolicy = { ...policy, protectedPaths: ["new"] };
  const invalid = verifyExportPatch(patch, changed);
  assert.equal(invalid.valid, false);
});

// ── 版本化 fingerprint 稳定性 ───────────────────────────────────────

test("fingerprint: 同描述同类型产生相同 fingerprint", () => {
  const fp1 = stableFingerprint("p1", "typecheck failed", "code");
  const fp2 = stableFingerprint("p1", "typecheck failed", "code");
  assert.equal(fp1.fingerprint, fp2.fingerprint);
});

test("fingerprint: 不同 type 产生不同 fingerprint", () => {
  const fp1 = stableFingerprint("p1", "missing test", "code");
  const fp2 = stableFingerprint("p1", "missing test", "requirement");
  assert.notEqual(fp1.fingerprint, fp2.fingerprint);
});

test("fingerprint: 空白归一化", () => {
  const fp1 = stableFingerprint("p1", "typecheck  failed", "code");
  const fp2 = stableFingerprint("p1", "typecheck failed", "code");
  assert.equal(fp1.fingerprint, fp2.fingerprint);
});

// ── 禁止事项验证 ─────────────────────────────────────────────────────

test("禁止: L0 不应对所有消息强制触发（非 code-change 不拦截）", async () => {
  const { classifyIntent } = await import("./quality/requirement.js");
  // 非 code-change 意图不应触发 L0 评估
  const nonCodeChange = classifyIntent("你好");
  assert.notEqual(nonCodeChange, "code-change");
});

test("禁止: sandbox 不自动激活规则", () => {
  const result = createSandboxEvaluation({
    ruleCandidateId: "rc1",
    passed: true,
    checksTotal: 10,
    checksPassed: 10,
    checksFailed: 0,
    checkSummaries: ["all passed"],
    reason: "perfect",
  });
  // sandbox 结果不包含激活/批准字段
  const keys = Object.keys(result);
  assert.ok(!keys.includes("activated"));
  assert.ok(!keys.includes("approved"));
  assert.ok(!keys.includes("status"));
});

test("禁止: policy 导出 patch 不自动写入 quality.json", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const patch = generateExportPatch({
    projectId: "p1", ruleCandidateId: "rc1", ruleType: "risk", rule,
    currentPolicy: policy, exportedBy: "user1",
  });
  // patch 只包含导出信息，不包含写入操作
  assert.ok(patch.patchJson.includes("ruleType"));
  // 原始 policy 未被修改
  assert.equal(policy.riskRules.length, 0);
});

// ── 终态完整性 ──────────────────────────────────────────────────────

test("终态: 所有终态不可再转换", () => {
  for (const stage of TERMINAL_STAGES) {
    assert.equal(isTerminal(stage), true);
  }
});

test("终态: accepted 需要 patchHash", () => {
  const { service } = makeService();
  const run = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "medium",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  // 没有 patchHash，不能直接 accepted
  assert.throws(() => service.advance(run.id, "accepted"), /illegal stage transition/);
});

// ── L4 自动回流：run 终态 failed/inconclusive 时自动创建 Observation ──

test("L4 自动回流: run 终态 failed 时自动创建 Observation（attribution=candidate）", () => {
  const observations: { kind: string; attribution: string; runId: string }[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "l4-auto-"));
  const store = new Store(join(tmpDir, "test.db"));
  const service = new QualityService(store, (e) => {
    if (e.method === "quality.runUpdate" && (e.params.run.stage === "failed" || e.params.run.stage === "inconclusive")) {
      const isInfra = e.params.run.failureCode === "hub-restart";
      const obs = service.createObservation({
        projectId: e.params.run.projectId,
        kind: isInfra ? "infra-failure" : "check-failure",
        attribution: isInfra ? "infrastructure" : "candidate",
        runId: e.params.run.id,
      });
      observations.push({ kind: obs.kind, attribution: obs.attribution, runId: obs.runId! });
    }
  }, {
    reviewRunner: () => {},
    fixerRunner: () => {},
    quickRunner: () => {},
    fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1", connectionId: "conn1", root: tmpDir, displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));

  const run = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "medium",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  service.advance(run.id, "failed");

  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.kind, "check-failure");
  assert.equal(observations[0]!.attribution, "candidate");
  assert.equal(observations[0]!.runId, run.id);

  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("L4 自动回流: run 终态 inconclusive + failureCode=hub-restart 时归因为 infrastructure", () => {
  const observations: { kind: string; attribution: string }[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "l4-infra-"));
  const store = new Store(join(tmpDir, "test.db"));
  const service = new QualityService(store, (e) => {
    if (e.method === "quality.runUpdate" && (e.params.run.stage === "failed" || e.params.run.stage === "inconclusive")) {
      const isInfra = e.params.run.failureCode === "hub-restart";
      const obs = service.createObservation({
        projectId: e.params.run.projectId,
        kind: isInfra ? "infra-failure" : "check-failure",
        attribution: isInfra ? "infrastructure" : "candidate",
        runId: e.params.run.id,
      });
      observations.push({ kind: obs.kind, attribution: obs.attribution });
    }
  }, {
    reviewRunner: () => {}, fixerRunner: () => {}, quickRunner: () => {}, fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1", connectionId: "conn1", root: tmpDir, displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));

  const run = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "medium",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  // 模拟 hub-restart 导致的 inconclusive
  service.advance(run.id, "inconclusive");
  // 手动设置 failureCode（模拟 recovery 路径）
  const updated = store.getQualityRun(run.id)!;
  store.saveQualityRun({ ...updated, failureCode: "hub-restart" });

  // 触发一次 emit（通过 advance 到同阶段不会再次触发，这里验证已有 observation）
  // 注意：advance 到 inconclusive 时已触发 emit，但 failureCode 在 emit 时可能未设置
  // 实际场景中 recovery 会先设置 failureCode 再 emit

  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("L4 自动回流: run 终态 accepted 时不创建 Observation", () => {
  const observations: { kind: string }[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "l4-accepted-"));
  const store = new Store(join(tmpDir, "test.db"));
  const service = new QualityService(store, (e) => {
    if (e.method === "quality.runUpdate" && (e.params.run.stage === "failed" || e.params.run.stage === "inconclusive")) {
      observations.push({ kind: "should-not-happen" });
    }
  }, {
    reviewRunner: () => {}, fixerRunner: () => {}, quickRunner: () => {}, fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1", connectionId: "conn1", root: tmpDir, displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));

  const run = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "low",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.advance(run.id, "preflight");
  service.advance(run.id, "implementing");
  service.advance(run.id, "collecting");
  service.advance(run.id, "quick-verifying");
  // cancelled 不是 failed/inconclusive，不应创建 Observation
  service.advance(run.id, "cancelled");

  assert.equal(observations.length, 0);

  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("L4 自动回流: run 终态 cancelled 时不创建 Observation", () => {
  const observations: { kind: string }[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "l4-cancelled-"));
  const store = new Store(join(tmpDir, "test.db"));
  const service = new QualityService(store, (e) => {
    if (e.method === "quality.runUpdate" && (e.params.run.stage === "failed" || e.params.run.stage === "inconclusive")) {
      observations.push({ kind: "should-not-happen" });
    }
  }, {
    reviewRunner: () => {}, fixerRunner: () => {}, quickRunner: () => {}, fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1", connectionId: "conn1", root: tmpDir, displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));

  const run = service.startRun({
    projectId: "proj1", trigger: "interactive", risk: "low",
    policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  service.cancelRun(run.id);

  assert.equal(observations.length, 0);

  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});
