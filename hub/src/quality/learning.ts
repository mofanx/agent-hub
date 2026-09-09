import * as crypto from "node:crypto";
import type {
  ActiveControl,
  CheckDefinition,
  QualityIncident,
  QualityObservation,
  RequirementRule,
  RiskRule,
  RuleCandidate,
  RuleCandidateType,
  RuleDefinition,
  VerificationRule,
  PolicyExportPatch,
  QualityPolicy,
  QualityPolicyV2,
} from "./types.js";
import { newIncidentId, incidentFingerprint } from "./incident.js";
import { newRuleId, ruleFingerprint } from "./rule.js";

/**
 * L4 受控学习引擎（v3.0 §12 / Phase 5）。
 *
 * 信号流转：
 *   原始信号 → Observation（open）→ 确认 → Incident（open）→ RuleCandidate（candidate）
 *   → 评测 → 用户批准 → ActiveControl（shadow → active）→ retired（回滚）
 *
 * 硬约束：
 * - 只有 candidate-attributable 的 Observation 才能确认 → Incident
 * - baseline/infrastructure/unknown 归因的 Observation 只能 dismiss
 * - sandbox 只评测，不批准/激活
 * - policy 只生成导出 patch（带 expected hash），不自动写入
 */

export const FINGERPRINT_VERSION = 2;

// ── L4 评测与退役阈值（§19）─────────────────────────────────────────
// 保守默认值：未达标时只生成 candidate 建议或保持 shadow，不自动激活。

/** RuleCandidate 评测所需最小独立样本数（正反样本各算独立）。 */
export const MIN_EVAL_SAMPLES = 10;
/** shadow ActiveControl 退役评估所需最小观察次数。 */
export const SHADOW_RETIRE_MIN_OBSERVATIONS = 15;
/** shadow precision 下限：低于此值建议退役。 */
export const SHADOW_RETIRE_MIN_PRECISION = 0.7;
/** shadow 复发减少率下限：启用后复发率需相对基线减少至此比例，否则建议退役。 */
export const SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION = 0.2;

/**
 * 版本化稳定 fingerprint：v2 排除 sourceRunId（易变），加入 type 和归一化描述。
 * v1 兼容：调用方可指定 fingerprintVersion=1 使用旧算法。
 */
export function stableFingerprint(
  projectId: string,
  description: string,
  type?: string,
  version: number = FINGERPRINT_VERSION,
): { fingerprint: string; version: number } {
  if (version === 1) {
    return { fingerprint: incidentFingerprint(projectId, description), version: 1 };
  }
  // v2: 排除 sourceRunId，加入 type，归一化描述（去首尾空格、合并空白）
  const normalizedDesc = description.trim().replace(/\s+/g, " ");
  const typeKey = type ?? "code";
  const fp = crypto
    .createHash("sha256")
    .update(`${projectId}:${typeKey}:${normalizedDesc}`)
    .digest("hex")
    .slice(0, 16);
  return { fingerprint: fp, version: 2 };
}

// ── Observation 记录 ─────────────────────────────────────────────────

export function newObservationId(): string {
  return `obs-${crypto.randomBytes(6).toString("hex")}`;
}

export function createObservation(opts: {
  projectId: string;
  runId?: string;
  workItemId?: string;
  kind: QualityObservation["kind"];
  attribution: QualityObservation["attribution"];
  evidenceRefs?: string[];
  fingerprint?: string;
  fingerprintVersion?: number;
  description?: string;
  severity?: string;
  attributionReason?: string;
}): QualityObservation {
  return {
    id: newObservationId(),
    projectId: opts.projectId,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.workItemId !== undefined ? { workItemId: opts.workItemId } : {}),
    kind: opts.kind,
    attribution: opts.attribution,
    ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}),
    ...(opts.fingerprintVersion !== undefined ? { fingerprintVersion: opts.fingerprintVersion } : {}),
    evidenceRefs: opts.evidenceRefs ?? [],
    status: "open",
    createdAt: Date.now(),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
    ...(opts.attributionReason !== undefined ? { attributionReason: opts.attributionReason } : {}),
  };
}

/**
 * 判断 Observation 是否可以确认（只有 candidate 归因可以确认 → Incident）。
 * baseline/infrastructure/unknown 归因的 Observation 只能 dismiss。
 */
export function canConfirmObservation(obs: QualityObservation): boolean {
  return obs.attribution === "candidate" && obs.status === "open";
}

/**
 * 确认 Observation → 生成 Incident。
 * 只有 candidate-attributable 的 Observation 才能确认。
 */
export function confirmObservationToIncident(
  obs: QualityObservation,
  confirmedBy: string,
): { incident: QualityIncident; observation: QualityObservation } {
  if (!canConfirmObservation(obs)) {
    throw new Error(`observation ${obs.id} cannot be confirmed (attribution=${obs.attribution}, status=${obs.status})`);
  }
  const desc = obs.description ?? `${obs.kind} (${obs.kind})`;
  const { fingerprint, version } = stableFingerprint(
    obs.projectId,
    desc,
    obs.kind === "verification-gap" ? "verification" : obs.kind === "finding" ? "code" : "code",
  );
  const now = Date.now();
  const incident: QualityIncident = {
    id: newIncidentId(),
    projectId: obs.projectId,
    description: desc,
    fingerprint,
    severity: obs.severity ?? "medium",
    status: "open",
    ...(obs.runId !== undefined ? { sourceRunId: obs.runId } : {}),
    type: obs.kind === "verification-gap" ? "verification" : "code",
    fingerprintVersion: version,
    sourceObservationIds: [obs.id],
    confirmedAt: now,
    confirmedBy,
  };
  const observation: QualityObservation = {
    ...obs,
    status: "confirmed",
    confirmedAt: now,
    confirmedBy,
  };
  return { incident, observation };
}

// ── 类型化 RuleCandidate ──────────────────────────────────────────────

/**
 * 根据 incident type 推断合适的 rule type。
 * - code incident → check 或 risk
 * - requirement incident → requirement
 * - verification incident → verification
 */
export function inferRuleType(incident: QualityIncident): RuleCandidateType {
  if (incident.type === "requirement") return "requirement";
  if (incident.type === "verification") return "verification";
  return "check";
}

/**
 * 类型匹配检查：rule type 是否与 incident type 兼容。
 * - check/risk → code incident
 * - requirement → requirement incident
 * - verification → verification incident
 */
export function isRuleTypeCompatible(ruleType: RuleCandidateType, incident: QualityIncident): boolean {
  const incidentType = incident.type ?? "code";
  if (ruleType === "check" || ruleType === "risk") return incidentType === "code";
  if (ruleType === "requirement") return incidentType === "requirement";
  if (ruleType === "verification") return incidentType === "verification";
  return false;
}

/**
 * 创建类型化 RuleCandidate（不持久化）。
 */
export function createTypedRuleCandidate(opts: {
  projectId: string;
  ruleType: RuleCandidateType;
  ruleDefinition: RuleDefinition;
  evidenceIncidentIds: string[];
  fingerprint?: string;
  measuredImpact?: string;
}): RuleCandidate {
  const ruleText = JSON.stringify(opts.ruleDefinition);
  const fp = opts.fingerprint ?? ruleFingerprint(opts.projectId, ruleText);
  return {
    id: newRuleId(),
    projectId: opts.projectId,
    rule: ruleText,
    fingerprint: fp,
    evidenceIncidentIds: opts.evidenceIncidentIds,
    recurrence: opts.evidenceIncidentIds.length,
    status: "candidate",
    ruleType: opts.ruleType,
    ruleDefinition: opts.ruleDefinition,
    ...(opts.measuredImpact !== undefined ? { measuredImpact: opts.measuredImpact } : {}),
  };
}

// ── ActiveControl 生命周期 ───────────────────────────────────────────

export function newActiveControlId(): string {
  return `ac-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 创建 shadow ActiveControl（只观察不执行）。
 * shadow → active 需要用户显式批准。
 */
export function createShadowControl(opts: {
  projectId: string;
  ruleCandidateId: string;
  rule: RuleDefinition;
  activatedBy: string;
  ruleType?: RuleCandidateType;
}): ActiveControl {
  return {
    id: newActiveControlId(),
    projectId: opts.projectId,
    ruleCandidateId: opts.ruleCandidateId,
    rule: opts.rule,
    activatedAt: Date.now(),
    activatedBy: opts.activatedBy,
    status: "shadow",
    ...(opts.ruleType !== undefined ? { ruleType: opts.ruleType } : {}),
  };
}

/**
 * 将 shadow control 提升为 active（开始执行）。
 */
export function promoteShadowToActive(control: ActiveControl, activatedBy: string): ActiveControl {
  if (control.status !== "shadow") {
    throw new Error(`control ${control.id} is not shadow (status=${control.status})`);
  }
  return {
    ...control,
    status: "active",
    activatedAt: Date.now(),
    activatedBy,
  };
}

/**
 * 回滚（retire）ActiveControl，记录回滚原因。
 */
export function retireActiveControl(
  control: ActiveControl,
  retiredBy: string,
  reason: string,
): ActiveControl {
  if (control.status === "retired") return control;
  return {
    ...control,
    status: "retired",
    retiredAt: Date.now(),
    retiredBy,
    retireReason: reason,
  };
}

// ── Policy 导出 patch（不自动写入） ──────────────────────────────────

/**
 * 生成 policy 导出 patch：包含规则定义和预期 hash，供用户审查后手动写入 quality.json。
 * 不自动写入 quality.json。
 */
export function generateExportPatch(opts: {
  projectId: string;
  ruleCandidateId: string;
  ruleType: RuleCandidateType;
  rule: RuleDefinition;
  currentPolicy: QualityPolicy | QualityPolicyV2;
  exportedBy: string;
}): PolicyExportPatch {
  const currentPolicyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(opts.currentPolicy))
    .digest("hex");

  // 构造导出后的 policy（追加规则）
  const exportedPolicy = applyRuleToPolicy(opts.currentPolicy, opts.ruleType, opts.rule);
  const expectedPolicyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(exportedPolicy))
    .digest("hex");

  // 生成 patch JSON（用户可直接粘贴）
  const patchEntry = ruleToPatchEntry(opts.ruleType, opts.rule);
  const patchJson = JSON.stringify(patchEntry, null, 2);

  return {
    projectId: opts.projectId,
    ruleCandidateId: opts.ruleCandidateId,
    ruleType: opts.ruleType,
    rule: opts.rule,
    expectedPolicyHash,
    currentPolicyHash,
    exportedAt: Date.now(),
    exportedBy: opts.exportedBy,
    patchJson,
  };
}

/**
 * 将规则应用到 policy，返回新 policy（不可变）。
 */
export function applyRuleToPolicy(
  policy: QualityPolicy | QualityPolicyV2,
  ruleType: RuleCandidateType,
  rule: RuleDefinition,
): QualityPolicy | QualityPolicyV2 {
  if (ruleType === "check" && rule.type === "check") {
    const check = rule.value as CheckDefinition;
    if (policy.version === 1) {
      const exists = policy.checks.some((c) => c.id === check.id);
      return { ...policy, checks: exists ? policy.checks : [...policy.checks, check] };
    }
    const exists = policy.checks.some((c) => c.id === check.id);
    return { ...policy, checks: exists ? policy.checks : [...policy.checks, check] };
  }
  if (ruleType === "risk" && rule.type === "risk") {
    const risk = rule.value as RiskRule;
    if (policy.version === 1) {
      const exists = policy.riskRules.some((r) => r.pattern === risk.pattern);
      return { ...policy, riskRules: exists ? policy.riskRules : [...policy.riskRules, risk] };
    }
    const exists = policy.riskRules.some((r) => r.pattern === risk.pattern);
    return { ...policy, riskRules: exists ? policy.riskRules : [...policy.riskRules, risk] };
  }
  if (ruleType === "requirement" && rule.type === "requirement" && policy.version === 2) {
    const req = rule.value as RequirementRule;
    const exists = policy.requirementRules.some((r) => r.id === req.id);
    return { ...policy, requirementRules: exists ? policy.requirementRules : [...policy.requirementRules, req] };
  }
  if (ruleType === "verification" && rule.type === "verification" && policy.version === 2) {
    const ver = rule.value as VerificationRule;
    const exists = policy.verificationRules.some((r) => r.id === ver.id);
    return { ...policy, verificationRules: exists ? policy.verificationRules : [...policy.verificationRules, ver] };
  }
  return policy;
}

/**
 * 将规则转换为 patch entry（用于导出 JSON）。
 */
function ruleToPatchEntry(ruleType: RuleCandidateType, rule: RuleDefinition): Record<string, unknown> {
  return {
    ruleType,
    rule,
  };
}

// ── SQLite 运行时加载 ────────────────────────────────────────────────

/**
 * 从 ActiveControl 列表加载活跃规则到 policy。
 * 只加载 status=active 的规则，shadow 规则不参与执行。
 */
export function loadActiveControlsIntoPolicy(
  policy: QualityPolicy | QualityPolicyV2,
  controls: ActiveControl[],
): QualityPolicy | QualityPolicyV2 {
  const activeControls = controls.filter((c) => c.status === "active");
  let result = policy;
  for (const control of activeControls) {
    if (control.ruleType) {
      result = applyRuleToPolicy(result, control.ruleType, control.rule);
    }
  }
  return result;
}

/**
 * 从 ActiveControl 列表加载 shadow 规则（用于观察/日志，不执行）。
 */
export function loadShadowControls(controls: ActiveControl[]): ActiveControl[] {
  return controls.filter((c) => c.status === "shadow");
}

/**
 * 评估 shadow ActiveControl 是否应建议退役（§10.3 / §19）。
 * 只生成建议，不自动退役；退役仍需用户显式操作。
 *
 * 退役条件（需同时满足）：
 * - 观察次数 >= SHADOW_RETIRE_MIN_OBSERVATIONS；
 * - precision < SHADOW_RETIRE_MIN_PRECISION 或复发减少率 < SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION。
 */
export function shouldRetireShadow(opts: {
  observations: number;
  precision: number;
  recurrenceReduction: number;
}): { retire: boolean; reason: string } {
  if (opts.observations < SHADOW_RETIRE_MIN_OBSERVATIONS) {
    return { retire: false, reason: `observations ${opts.observations} < ${SHADOW_RETIRE_MIN_OBSERVATIONS}` };
  }
  if (opts.precision < SHADOW_RETIRE_MIN_PRECISION) {
    return { retire: true, reason: `precision ${opts.precision.toFixed(2)} < ${SHADOW_RETIRE_MIN_PRECISION}` };
  }
  if (opts.recurrenceReduction < SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION) {
    return { retire: true, reason: `recurrence reduction ${opts.recurrenceReduction.toFixed(2)} < ${SHADOW_RETIRE_MIN_RECURRENCE_REDUCTION}` };
  }
  return { retire: false, reason: "healthy" };
}

/**
 * 评估 RuleCandidate 是否满足最小样本数要求（§10.2 / §19）。
 * 固定"出现 3 次"只触发 candidate 建议；评测需更多独立样本。
 */
export function hasEnoughEvalSamples(positiveSamples: number, negativeSamples: number): boolean {
  return positiveSamples + negativeSamples >= MIN_EVAL_SAMPLES;
}

// ── 安全约束 ──────────────────────────────────────────────────────────

/**
 * sandbox 评测结果：只包含评测数据，不包含批准/激活操作。
 * sandbox 永远不能自动批准或激活规则。
 */
export type SandboxEvaluationResult = {
  ruleCandidateId: string;
  passed: boolean;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checkSummaries: string[];
  falsePositiveRate?: number;
  reason: string;
};

/**
 * 构造 sandbox 评测结果（只评测，不批准）。
 */
export function createSandboxEvaluation(opts: {
  ruleCandidateId: string;
  passed: boolean;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checkSummaries: string[];
  falsePositiveRate?: number;
  reason: string;
}): SandboxEvaluationResult {
  return {
    ruleCandidateId: opts.ruleCandidateId,
    passed: opts.passed,
    checksTotal: opts.checksTotal,
    checksPassed: opts.checksPassed,
    checksFailed: opts.checksFailed,
    checkSummaries: opts.checkSummaries,
    ...(opts.falsePositiveRate !== undefined ? { falsePositiveRate: opts.falsePositiveRate } : {}),
    reason: opts.reason,
  };
}

/**
 * 验证导出 patch 的 hash 是否与实际 policy 匹配。
 * 用于用户手动写入 quality.json 后的验证。
 *
 * 双重校验：
 * 1. currentPolicyHash：导出时的 policy hash，用于检测导出后 policy 是否被其他方修改；
 * 2. expectedPolicyHash：应用规则后的预期 policy hash，用于确认规则已正确写入。
 *
 * 如果 currentHash === expectedPolicyHash，说明规则已应用（policy 已变为预期状态）。
 * 如果 currentHash === currentPolicyHash，说明规则尚未应用（policy 仍是导出时的状态）。
 * 两者都不匹配则说明 policy 被其他方修改，存在冲突。
 */
export function verifyExportPatch(
  patch: PolicyExportPatch,
  currentPolicy: QualityPolicy | QualityPolicyV2,
): { valid: boolean; reason: string } {
  const currentHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(currentPolicy))
    .digest("hex");
  if (currentHash === patch.expectedPolicyHash) {
    return { valid: true, reason: "policy hash matches expected (rule applied)" };
  }
  if (currentHash === patch.currentPolicyHash) {
    return { valid: false, reason: "rule not yet applied: current policy still matches export-time hash" };
  }
  return {
    valid: false,
    reason: `policy hash mismatch: expected ${patch.expectedPolicyHash.slice(0, 12)} (applied) or ${patch.currentPolicyHash.slice(0, 12)} (pre-export), got ${currentHash.slice(0, 12)} (policy changed by other party)`,
  };
}
