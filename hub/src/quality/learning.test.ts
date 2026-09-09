import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { projectId } from "./project.js";
import {
  FINGERPRINT_VERSION,
  stableFingerprint,
  createObservation,
  canConfirmObservation,
  confirmObservationToIncident,
  inferRuleType,
  isRuleTypeCompatible,
  createTypedRuleCandidate,
  createShadowControl,
  promoteShadowToActive,
  retireActiveControl,
  generateExportPatch,
  applyRuleToPolicy,
  loadActiveControlsIntoPolicy,
  loadShadowControls,
  createSandboxEvaluation,
  verifyExportPatch,
  shouldRetireShadow,
  hasEnoughEvalSamples,
  MIN_EVAL_SAMPLES,
  SHADOW_RETIRE_MIN_OBSERVATIONS,
  SHADOW_RETIRE_MIN_PRECISION,
  SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION,
  type SandboxEvaluationResult,
} from "./learning.js";
import type {
  QualityObservation,
  QualityIncident,
  QualityPolicy,
  RuleDefinition,
  CheckDefinition,
  RiskRule,
  RequirementRule,
  VerificationRule,
  ActiveControl,
} from "./types.js";
import { canTransitionRuleStatus } from "./rule.js";

// ── 版本化稳定 fingerprint ───────────────────────────────────────────

test("stableFingerprint: v2 排除 sourceRunId，同一描述+类型产生相同 fingerprint", () => {
  const fp1 = stableFingerprint("p1", "typecheck failed", "code");
  const fp2 = stableFingerprint("p1", "typecheck failed", "code");
  assert.equal(fp1.fingerprint, fp2.fingerprint);
  assert.equal(fp1.version, FINGERPRINT_VERSION);
});

test("stableFingerprint: v2 归一化空白（多空格 vs 单空格相同）", () => {
  const fp1 = stableFingerprint("p1", "typecheck  failed", "code");
  const fp2 = stableFingerprint("p1", "typecheck failed", "code");
  assert.equal(fp1.fingerprint, fp2.fingerprint);
});

test("stableFingerprint: v2 不同 type 产生不同 fingerprint", () => {
  const fp1 = stableFingerprint("p1", "missing test", "code");
  const fp2 = stableFingerprint("p1", "missing test", "requirement");
  assert.notEqual(fp1.fingerprint, fp2.fingerprint);
});

test("stableFingerprint: v1 兼容模式", () => {
  const fp = stableFingerprint("p1", "desc", "code", 1);
  assert.equal(fp.version, 1);
  // v1 调用 incidentFingerprint(projectId, description)，不含 sourceRunId
  assert.ok(fp.fingerprint.length > 0);
});

test("stableFingerprint: 不同 projectId 产生不同 fingerprint", () => {
  const fp1 = stableFingerprint("p1", "desc", "code");
  const fp2 = stableFingerprint("p2", "desc", "code");
  assert.notEqual(fp1.fingerprint, fp2.fingerprint);
});

// ── Observation 记录 ─────────────────────────────────────────────────

test("createObservation: 基本字段", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "candidate",
    evidenceRefs: ["ref1"],
    description: "typecheck failed",
    severity: "high",
  });
  assert.equal(obs.projectId, "p1");
  assert.equal(obs.kind, "check-failure");
  assert.equal(obs.attribution, "candidate");
  assert.equal(obs.status, "open");
  assert.deepEqual(obs.evidenceRefs, ["ref1"]);
  assert.equal(obs.description, "typecheck failed");
  assert.equal(obs.severity, "high");
  assert.ok(obs.id.startsWith("obs-"));
});

test("createObservation: 可选字段省略", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "infra-failure",
    attribution: "infrastructure",
  });
  assert.deepEqual(obs.evidenceRefs, []);
  assert.equal(obs.description, undefined);
  assert.equal(obs.severity, undefined);
});

// ── candidate-attributable 过滤 ──────────────────────────────────────

test("canConfirmObservation: candidate + open 可以确认", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "candidate",
  });
  assert.equal(canConfirmObservation(obs), true);
});

test("canConfirmObservation: baseline 归因不能确认", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "baseline",
  });
  assert.equal(canConfirmObservation(obs), false);
});

test("canConfirmObservation: infrastructure 归因不能确认", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "infra-failure",
    attribution: "infrastructure",
  });
  assert.equal(canConfirmObservation(obs), false);
});

test("canConfirmObservation: unknown 归因不能确认", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "unknown",
  });
  assert.equal(canConfirmObservation(obs), false);
});

test("canConfirmObservation: 已 confirmed 的不能再次确认", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "candidate",
  });
  const confirmed = { ...obs, status: "confirmed" as const };
  assert.equal(canConfirmObservation(confirmed), false);
});

// ── confirmObservationToIncident ─────────────────────────────────────

test("confirmObservationToIncident: candidate observation 生成 incident", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "candidate",
    description: "typecheck failed",
    severity: "high",
  });
  const { incident, observation } = confirmObservationToIncident(obs, "user1");
  assert.equal(incident.projectId, "p1");
  assert.equal(incident.description, "typecheck failed");
  assert.equal(incident.severity, "high");
  assert.equal(incident.status, "open");
  assert.equal(incident.type, "code");
  assert.ok(incident.fingerprint.length > 0);
  assert.equal(incident.fingerprintVersion, FINGERPRINT_VERSION);
  assert.deepEqual(incident.sourceObservationIds, [obs.id]);
  assert.equal(incident.confirmedBy, "user1");
  assert.ok(incident.confirmedAt !== undefined);
  assert.equal(observation.status, "confirmed");
  assert.equal(observation.confirmedBy, "user1");
});

test("confirmObservationToIncident: verification-gap → verification type", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "verification-gap",
    attribution: "candidate",
    description: "missing acceptance test",
  });
  const { incident } = confirmObservationToIncident(obs, "user1");
  assert.equal(incident.type, "verification");
});

test("confirmObservationToIncident: 非 candidate 抛出错误", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "baseline",
  });
  assert.throws(() => confirmObservationToIncident(obs, "user1"), /cannot be confirmed/);
});

// ── inferRuleType ────────────────────────────────────────────────────

test("inferRuleType: code incident → check", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "code",
  };
  assert.equal(inferRuleType(incident), "check");
});

test("inferRuleType: requirement incident → requirement", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "requirement",
  };
  assert.equal(inferRuleType(incident), "requirement");
});

test("inferRuleType: verification incident → verification", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "verification",
  };
  assert.equal(inferRuleType(incident), "verification");
});

test("inferRuleType: 无 type → check（默认）", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open",
  };
  assert.equal(inferRuleType(incident), "check");
});

// ── isRuleTypeCompatible ────────────────────────────────────────────

test("isRuleTypeCompatible: check + code incident = 兼容", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "code",
  };
  assert.equal(isRuleTypeCompatible("check", incident), true);
  assert.equal(isRuleTypeCompatible("risk", incident), true);
});

test("isRuleTypeCompatible: requirement + code incident = 不兼容", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "code",
  };
  assert.equal(isRuleTypeCompatible("requirement", incident), false);
  assert.equal(isRuleTypeCompatible("verification", incident), false);
});

test("isRuleTypeCompatible: requirement + requirement incident = 兼容", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "requirement",
  };
  assert.equal(isRuleTypeCompatible("requirement", incident), true);
  assert.equal(isRuleTypeCompatible("check", incident), false);
});

test("isRuleTypeCompatible: verification + verification incident = 兼容", () => {
  const incident: QualityIncident = {
    id: "inc1", projectId: "p1", description: "test", fingerprint: "fp",
    severity: "medium", status: "open", type: "verification",
  };
  assert.equal(isRuleTypeCompatible("verification", incident), true);
  assert.equal(isRuleTypeCompatible("check", incident), false);
});

// ── createTypedRuleCandidate ─────────────────────────────────────────

test("createTypedRuleCandidate: check 类型", () => {
  const checkDef: CheckDefinition = {
    id: "new-check", cwd: ".", argv: ["echo"], tier: "quick", timeoutMs: 5000, required: true,
  };
  const rule: RuleDefinition = { type: "check", value: checkDef };
  const candidate = createTypedRuleCandidate({
    projectId: "p1",
    ruleType: "check",
    ruleDefinition: rule,
    evidenceIncidentIds: ["inc1", "inc2"],
  });
  assert.equal(candidate.ruleType, "check");
  assert.deepEqual(candidate.ruleDefinition, rule);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.recurrence, 2);
  assert.ok(candidate.fingerprint.length > 0);
});

test("createTypedRuleCandidate: risk 类型", () => {
  const riskRule: RiskRule = { pattern: "src/quality/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: riskRule };
  const candidate = createTypedRuleCandidate({
    projectId: "p1",
    ruleType: "risk",
    ruleDefinition: rule,
    evidenceIncidentIds: ["inc1"],
  });
  assert.equal(candidate.ruleType, "risk");
  assert.deepEqual(candidate.ruleDefinition, rule);
});

test("createTypedRuleCandidate: requirement 类型", () => {
  const reqRule: RequirementRule = {
    id: "req-1", selector: { keywords: ["优化"] }, dimension: "acceptance-verifiability",
    questionTemplate: "请明确优化目标",
  };
  const rule: RuleDefinition = { type: "requirement", value: reqRule };
  const candidate = createTypedRuleCandidate({
    projectId: "p1",
    ruleType: "requirement",
    ruleDefinition: rule,
    evidenceIncidentIds: ["inc1"],
  });
  assert.equal(candidate.ruleType, "requirement");
});

test("createTypedRuleCandidate: verification 类型", () => {
  const verRule: VerificationRule = {
    id: "ver-1", selector: { keywords: ["重连"] },
    criterionTemplate: "断网场景测试", evidenceMode: "all", expectedEvidence: [],
  };
  const rule: RuleDefinition = { type: "verification", value: verRule };
  const candidate = createTypedRuleCandidate({
    projectId: "p1",
    ruleType: "verification",
    ruleDefinition: rule,
    evidenceIncidentIds: ["inc1"],
  });
  assert.equal(candidate.ruleType, "verification");
});

// ── shadow 状态转换 ──────────────────────────────────────────────────

test("canTransitionRuleStatus: candidate → shadow 合法", () => {
  assert.equal(canTransitionRuleStatus("candidate", "shadow"), true);
});

test("canTransitionRuleStatus: shadow → approved 合法", () => {
  assert.equal(canTransitionRuleStatus("shadow", "approved"), true);
});

test("canTransitionRuleStatus: shadow → rejected 合法", () => {
  assert.equal(canTransitionRuleStatus("shadow", "rejected"), true);
});

test("canTransitionRuleStatus: active → shadow 合法（降级）", () => {
  assert.equal(canTransitionRuleStatus("active", "shadow"), true);
});

// ── ActiveControl 生命周期 ───────────────────────────────────────────

test("createShadowControl: 初始状态为 shadow", () => {
  const rule: RuleDefinition = { type: "risk", value: { pattern: "src/", risk: "high", reason: "test" } };
  const control = createShadowControl({
    projectId: "p1",
    ruleCandidateId: "rc1",
    rule,
    activatedBy: "user1",
    ruleType: "risk",
  });
  assert.equal(control.status, "shadow");
  assert.equal(control.ruleCandidateId, "rc1");
  assert.equal(control.ruleType, "risk");
  assert.equal(control.activatedBy, "user1");
  assert.ok(control.id.startsWith("ac-"));
});

test("promoteShadowToActive: shadow → active", () => {
  const rule: RuleDefinition = { type: "risk", value: { pattern: "src/", risk: "high", reason: "test" } };
  const control = createShadowControl({
    projectId: "p1", ruleCandidateId: "rc1", rule, activatedBy: "user1",
  });
  const active = promoteShadowToActive(control, "user2");
  assert.equal(active.status, "active");
  assert.equal(active.activatedBy, "user2");
});

test("promoteShadowToActive: 非 shadow 抛出错误", () => {
  const rule: RuleDefinition = { type: "risk", value: { pattern: "src/", risk: "high", reason: "test" } };
  const control = createShadowControl({
    projectId: "p1", ruleCandidateId: "rc1", rule, activatedBy: "user1",
  });
  const active = promoteShadowToActive(control, "user2");
  assert.throws(() => promoteShadowToActive(active, "user3"), /not shadow/);
});

test("retireActiveControl: active → retired，记录回滚原因", () => {
  const rule: RuleDefinition = { type: "risk", value: { pattern: "src/", risk: "high", reason: "test" } };
  const control = createShadowControl({
    projectId: "p1", ruleCandidateId: "rc1", rule, activatedBy: "user1",
  });
  const active = promoteShadowToActive(control, "user2");
  const retired = retireActiveControl(active, "admin", "false positive");
  assert.equal(retired.status, "retired");
  assert.equal(retired.retiredBy, "admin");
  assert.equal(retired.retireReason, "false positive");
  assert.ok(retired.retiredAt !== undefined);
});

test("retireActiveControl: 已 retired 的保持不变", () => {
  const rule: RuleDefinition = { type: "risk", value: { pattern: "src/", risk: "high", reason: "test" } };
  const control = createShadowControl({
    projectId: "p1", ruleCandidateId: "rc1", rule, activatedBy: "user1",
  });
  const active = promoteShadowToActive(control, "user2");
  const retired = retireActiveControl(active, "admin", "reason");
  const retiredAgain = retireActiveControl(retired, "admin", "another");
  assert.equal(retiredAgain.status, "retired");
  assert.equal(retiredAgain.retireReason, "reason"); // 保持原始原因
});

// ── applyRuleToPolicy ───────────────────────────────────────────────

test("applyRuleToPolicy: check 规则追加到 v1 policy", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const check: CheckDefinition = {
    id: "new-check", cwd: ".", argv: ["echo"], tier: "quick", timeoutMs: 5000, required: true,
  };
  const rule: RuleDefinition = { type: "check", value: check };
  const updated = applyRuleToPolicy(policy, "check", rule) as QualityPolicy;
  assert.equal(updated.checks.length, 1);
  assert.equal(updated.checks[0]!.id, "new-check");
});

test("applyRuleToPolicy: risk 规则追加到 v1 policy", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const updated = applyRuleToPolicy(policy, "risk", rule) as QualityPolicy;
  assert.equal(updated.riskRules.length, 1);
});

test("applyRuleToPolicy: 重复规则不追加", () => {
  const check: CheckDefinition = {
    id: "dup-check", cwd: ".", argv: ["echo"], tier: "quick", timeoutMs: 5000, required: true,
  };
  const policy: QualityPolicy = {
    version: 1, checks: [check], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const rule: RuleDefinition = { type: "check", value: check };
  const updated = applyRuleToPolicy(policy, "check", rule) as QualityPolicy;
  assert.equal(updated.checks.length, 1); // 不重复
});

// ── loadActiveControlsIntoPolicy ────────────────────────────────────

test("loadActiveControlsIntoPolicy: 只加载 active 规则，跳过 shadow", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const controls: ActiveControl[] = [
    { id: "ac1", projectId: "p1", ruleCandidateId: "rc1", rule, activatedAt: 1, activatedBy: "u", status: "active", ruleType: "risk" },
    { id: "ac2", projectId: "p1", ruleCandidateId: "rc2", rule, activatedAt: 2, activatedBy: "u", status: "shadow", ruleType: "risk" },
    { id: "ac3", projectId: "p1", ruleCandidateId: "rc3", rule, activatedAt: 3, activatedBy: "u", status: "retired", ruleType: "risk" },
  ];
  const updated = loadActiveControlsIntoPolicy(policy, controls) as QualityPolicy;
  assert.equal(updated.riskRules.length, 1); // 只有 active 的 ac1
});

test("loadShadowControls: 只返回 shadow 规则", () => {
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const controls: ActiveControl[] = [
    { id: "ac1", projectId: "p1", ruleCandidateId: "rc1", rule, activatedAt: 1, activatedBy: "u", status: "active" },
    { id: "ac2", projectId: "p1", ruleCandidateId: "rc2", rule, activatedAt: 2, activatedBy: "u", status: "shadow" },
  ];
  const shadows = loadShadowControls(controls);
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0]!.status, "shadow");
});

// ── generateExportPatch ─────────────────────────────────────────────

test("generateExportPatch: 包含 expected hash 和 patch JSON", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const patch = generateExportPatch({
    projectId: "p1",
    ruleCandidateId: "rc1",
    ruleType: "risk",
    rule,
    currentPolicy: policy,
    exportedBy: "user1",
  });
  assert.equal(patch.projectId, "p1");
  assert.equal(patch.ruleCandidateId, "rc1");
  assert.equal(patch.ruleType, "risk");
  assert.ok(patch.expectedPolicyHash.length > 0);
  assert.ok(patch.currentPolicyHash.length > 0);
  assert.notEqual(patch.expectedPolicyHash, patch.currentPolicyHash);
  assert.ok(patch.patchJson.length > 0);
  assert.equal(patch.exportedBy, "user1");
});

test("generateExportPatch: expected hash 与应用规则后的 policy hash 一致", () => {
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
  const appliedPolicy = applyRuleToPolicy(policy, "risk", rule);
  const appliedHash = crypto.createHash("sha256").update(JSON.stringify(appliedPolicy)).digest("hex");
  assert.equal(patch.expectedPolicyHash, appliedHash);
});

// ── verifyExportPatch ───────────────────────────────────────────────

test("verifyExportPatch: hash 匹配时 valid=true", () => {
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
  // 验证时传入已应用 rule 的 policy（模拟用户已手动应用 patch）
  const appliedPolicy = applyRuleToPolicy(policy, "risk", rule);
  const result = verifyExportPatch(patch, appliedPolicy);
  assert.equal(result.valid, true);
});

test("verifyExportPatch: policy 变更后 hash 不匹配 valid=false", () => {
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
  // 修改 policy
  const changedPolicy: QualityPolicy = { ...policy, protectedPaths: ["new-path"] };
  const result = verifyExportPatch(patch, changedPolicy);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("mismatch"));
});

// ── sandbox 安全约束 ────────────────────────────────────────────────

test("createSandboxEvaluation: 只评测，不包含批准/激活操作", () => {
  const result = createSandboxEvaluation({
    ruleCandidateId: "rc1",
    passed: true,
    checksTotal: 10,
    checksPassed: 9,
    checksFailed: 1,
    checkSummaries: ["9/10 passed"],
    falsePositiveRate: 0.1,
    reason: "sandbox evaluation",
  });
  assert.equal(result.ruleCandidateId, "rc1");
  assert.equal(result.passed, true);
  assert.equal(result.checksTotal, 10);
  assert.equal(result.checksPassed, 9);
  assert.equal(result.checksFailed, 1);
  assert.equal(result.falsePositiveRate, 0.1);
  assert.equal(result.reason, "sandbox evaluation");
  // SandboxEvaluationResult 类型不包含 status/approved/activated 字段
  const keys = Object.keys(result);
  assert.ok(!keys.includes("status"));
  assert.ok(!keys.includes("approved"));
  assert.ok(!keys.includes("activated"));
});

test("createSandboxEvaluation: failed 评测也不自动批准", () => {
  const result = createSandboxEvaluation({
    ruleCandidateId: "rc1",
    passed: false,
    checksTotal: 10,
    checksPassed: 5,
    checksFailed: 5,
    checkSummaries: ["5/10 failed"],
    reason: "high false positive rate",
  });
  assert.equal(result.passed, false);
  // 不包含任何自动批准/激活字段
  const keys = Object.keys(result);
  assert.ok(!keys.includes("approved"));
  assert.ok(!keys.includes("activated"));
});

// ── 端到端：Observation → Incident → RuleCandidate → ActiveControl ──

test("端到端: candidate observation → incident → typed rule → shadow → active → retired", () => {
  // 1. 创建 candidate observation
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "candidate",
    description: "typecheck failed in src/index.ts",
    severity: "high",
    evidenceRefs: ["stdout.txt"],
  });
  assert.equal(canConfirmObservation(obs), true);

  // 2. 确认 → incident
  const { incident } = confirmObservationToIncident(obs, "user1");
  assert.equal(incident.type, "code");
  assert.equal(incident.status, "open");

  // 3. 推断 rule type → check
  const ruleType = inferRuleType(incident);
  assert.equal(ruleType, "check");
  assert.equal(isRuleTypeCompatible(ruleType, incident), true);

  // 4. 创建 typed rule candidate
  const checkDef: CheckDefinition = {
    id: "new-check", cwd: ".", argv: ["npx", "tsc", "--noEmit"], tier: "quick", timeoutMs: 30000, required: true,
  };
  const rule: RuleDefinition = { type: "check", value: checkDef };
  const candidate = createTypedRuleCandidate({
    projectId: "p1",
    ruleType: "check",
    ruleDefinition: rule,
    evidenceIncidentIds: [incident.id],
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.ruleType, "check");

  // 5. sandbox 评测（只评测，不批准）
  const sandboxResult = createSandboxEvaluation({
    ruleCandidateId: candidate.id,
    passed: true,
    checksTotal: 5,
    checksPassed: 5,
    checksFailed: 0,
    checkSummaries: ["all passed"],
    reason: "sandbox passed",
  });
  assert.equal(sandboxResult.passed, true);

  // 6. 用户批准 → approved
  // (模拟 resolveRule(candidate.id, "approved"))
  assert.equal(canTransitionRuleStatus("candidate", "approved"), true);

  // 7. 激活为 shadow
  const control = createShadowControl({
    projectId: "p1",
    ruleCandidateId: candidate.id,
    rule,
    activatedBy: "user1",
    ruleType: "check",
  });
  assert.equal(control.status, "shadow");

  // 8. promote shadow → active
  const activeControl = promoteShadowToActive(control, "user1");
  assert.equal(activeControl.status, "active");

  // 9. 回滚 active → retired
  const retiredControl = retireActiveControl(activeControl, "admin", "false positive in production");
  assert.equal(retiredControl.status, "retired");
  assert.equal(retiredControl.retireReason, "false positive in production");
});

test("端到端: baseline observation 不能确认，只能 dismiss", () => {
  const obs = createObservation({
    projectId: "p1",
    kind: "check-failure",
    attribution: "baseline",
    description: "pre-existing failure",
  });
  assert.equal(canConfirmObservation(obs), false);
  // baseline observation 只能 dismiss
  const dismissed = { ...obs, status: "dismissed" as const };
  assert.equal(dismissed.status, "dismissed");
});

// ── 安全约束验证 ─────────────────────────────────────────────────────

test("安全: sandbox 评测结果不能直接用于激活", () => {
  const result = createSandboxEvaluation({
    ruleCandidateId: "rc1",
    passed: true,
    checksTotal: 10,
    checksPassed: 10,
    checksFailed: 0,
    checkSummaries: ["all passed"],
    reason: "perfect",
  });
  // SandboxEvaluationResult 不包含任何激活/批准字段
  const keys = Object.keys(result);
  assert.ok(!keys.includes("activated"));
  assert.ok(!keys.includes("approved"));
  assert.ok(!keys.includes("status"));
});

test("安全: generateExportPatch 不自动写入 policy", () => {
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
  assert.ok(patch.patchJson.includes("rule"));
  // 原始 policy 未被修改
  assert.equal(policy.riskRules.length, 0);
});

test("安全: shadow control 不参与 policy 加载", () => {
  const policy: QualityPolicy = {
    version: 1, checks: [], protectedPaths: [], riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  };
  const risk: RiskRule = { pattern: "src/", risk: "high", reason: "core" };
  const rule: RuleDefinition = { type: "risk", value: risk };
  const controls: ActiveControl[] = [
    { id: "ac1", projectId: "p1", ruleCandidateId: "rc1", rule, activatedAt: 1, activatedBy: "u", status: "shadow" },
  ];
  const updated = loadActiveControlsIntoPolicy(policy, controls) as QualityPolicy;
  // shadow control 不加载到 policy
  assert.equal(updated.riskRules.length, 0);
});

describe("t6 L4 QualityService 受控学习集成", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l4-svc-"));
    store = new Store(dir);
    service = new QualityService(store, () => {});
    service.registerProject({ connectionId: "conn-1", root: dir });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("createObservation + listObservations + confirmObservation", () => {
    const pid = projectId("conn-1", dir);
    const obs = service.createObservation({
      projectId: pid,
      kind: "check-failure",
      attribution: "candidate",
      evidenceRefs: [],
    });
    assert.ok(obs.id);

    const list = service.listObservations(pid);
    assert.equal(list.length, 1);

    const confirmed = service.confirmObservation(obs.id);
    assert.ok(confirmed);
    assert.equal(confirmed!.status, "confirmed");
  });

  it("dismissObservation 标记为 dismissed", () => {
    const pid = projectId("conn-1", dir);
    const obs = service.createObservation({
      projectId: pid,
      kind: "infra-failure",
      attribution: "infrastructure",
      evidenceRefs: [],
    });
    const dismissed = service.dismissObservation(obs.id);
    assert.ok(dismissed);
    assert.equal(dismissed!.status, "dismissed");
  });

  it("createTypedRule + approveRule + activateRuleAsShadow", () => {
    const pid = projectId("conn-1", dir);
    const candidate = service.createTypedRule({
      projectId: pid,
      ruleType: "check",
      ruleDefinition: { type: "check", value: { id: "c1", cwd: dir, argv: ["npm", "test"], tier: "quick", timeoutMs: 60000, required: false } },
      evidenceIncidentIds: [],
    });
    assert.ok(candidate.id);
    assert.equal(candidate.status, "candidate");

    const approved = service.approveRule(candidate.id, "user-1");
    assert.equal(approved.status, "approved");

    const control = service.activateRuleAsShadow(candidate.id, "user-1");
    assert.equal(control.status, "shadow");
  });

  it("promoteShadowControl + retireControl", () => {
    const pid = projectId("conn-1", dir);
    const candidate = service.createTypedRule({
      projectId: pid,
      ruleType: "risk",
      ruleDefinition: { type: "risk", value: { pattern: "secret", risk: "high", reason: "test" } },
      evidenceIncidentIds: [],
    });
    service.approveRule(candidate.id, "user-1");
    const control = service.activateRuleAsShadow(candidate.id, "user-1");

    const promoted = service.promoteShadowControl(control.id, "user-1");
    assert.ok(promoted);
    assert.equal(promoted!.status, "active");

    const retired = service.retireControl(control.id, "user-1", "no longer needed");
    assert.ok(retired);
    assert.equal(retired!.status, "retired");
  });

  it("listActiveControls 包含 shadow", () => {
    const pid = projectId("conn-1", dir);
    const candidate = service.createTypedRule({
      projectId: pid,
      ruleType: "requirement",
      ruleDefinition: { type: "requirement", value: { id: "req1", selector: { keywords: ["test"] }, dimension: "goal-clarity", questionTemplate: "?" } },
      evidenceIncidentIds: [],
    });
    service.approveRule(candidate.id, "user-1");
    service.activateRuleAsShadow(candidate.id, "user-1");

    const controls = service.listActiveControls(pid, true);
    assert.equal(controls.length, 1);
    assert.equal(controls[0]!.status, "shadow");

    const activeOnly = service.listActiveControls(pid, false);
    assert.equal(activeOnly.length, 0);
  });
});

// ── §19 参数阈值函数测试 ──────────────────────────────────────────────

describe("L4 退役与样本阈值（§19）", () => {
  it("hasEnoughEvalSamples: 样本不足时返回 false", () => {
    assert.equal(hasEnoughEvalSamples(3, 4), false);
    assert.equal(hasEnoughEvalSamples(5, 4), false);
  });

  it("hasEnoughEvalSamples: 样本达标时返回 true", () => {
    assert.equal(hasEnoughEvalSamples(MIN_EVAL_SAMPLES, 0), true);
    assert.equal(hasEnoughEvalSamples(5, 5), true);
  });

  it("shouldRetireShadow: 观察不足时不退役", () => {
    const r = shouldRetireShadow({ observations: 5, precision: 0.5, recurrenceReduction: 0.1 });
    assert.equal(r.retire, false);
    assert.match(r.reason, /observations/);
  });

  it("shouldRetireShadow: precision 过低时建议退役", () => {
    const r = shouldRetireShadow({
      observations: SHADOW_RETIRE_MIN_OBSERVATIONS,
      precision: SHADOW_RETIRE_MIN_PRECISION - 0.1,
      recurrenceReduction: 0.5,
    });
    assert.equal(r.retire, true);
    assert.match(r.reason, /precision/);
  });

  it("shouldRetireShadow: 复发减少不足时建议退役", () => {
    const r = shouldRetireShadow({
      observations: SHADOW_RETIRE_MIN_OBSERVATIONS,
      precision: 0.9,
      recurrenceReduction: SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION - 0.1,
    });
    assert.equal(r.retire, true);
    assert.match(r.reason, /recurrence/);
  });

  it("shouldRetireShadow: 全部达标时不退役", () => {
    const r = shouldRetireShadow({
      observations: SHADOW_RETIRE_MIN_OBSERVATIONS,
      precision: SHADOW_RETIRE_MIN_PRECISION + 0.1,
      recurrenceReduction: SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION + 0.1,
    });
    assert.equal(r.retire, false);
    assert.equal(r.reason, "healthy");
  });
});
