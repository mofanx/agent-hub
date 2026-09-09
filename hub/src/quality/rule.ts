import * as crypto from "node:crypto";
import type { QualityPolicy, RiskRule, RuleCandidate, RuleCandidateStatus } from "./types.js";

/**
 * RuleCandidate 模型与辅助函数（设计文档 §12 / Q3-04）。
 *
 * RuleCandidate 是从反复出现的 Incident 中提炼的候选规则：
 * - 由 incident 沉淀而来，evidenceIncidentIds 记录关联的 incident；
 * - recurrence 记录关联 incident 次数；
 * - status: candidate → approved → active → retired；candidate → rejected；
 * - 不自动修改 policy，需人工审批后才能 active。
 */

const VALID_STATUSES: readonly RuleCandidateStatus[] = [
  "candidate",
  "approved",
  "active",
  "retired",
  "rejected",
];

/** 生成 rule candidate id。 */
export function newRuleId(): string {
  return `rule-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 计算 rule fingerprint：sha256(projectId:rule) 前 16 hex。
 * 同一项目下规则文本相同的 candidate 会被视为同一规则。
 */
export function ruleFingerprint(projectId: string, rule: string): string {
  return crypto
    .createHash("sha256")
    .update(`${projectId}:${rule}`)
    .digest("hex")
    .slice(0, 16);
}

/** 校验 status 字符串是否合法。 */
export function isValidRuleStatus(s: string): s is RuleCandidateStatus {
  return VALID_STATUSES.includes(s as RuleCandidateStatus);
}

/** 校验 rule candidate 状态转换是否合法。 */
export function canTransitionRuleStatus(from: RuleCandidateStatus, to: RuleCandidateStatus): boolean {
  if (from === to) return true;
  const allowed: Record<RuleCandidateStatus, readonly RuleCandidateStatus[]> = {
    candidate: ["approved", "rejected", "shadow"],
    approved: ["active", "rejected", "candidate", "shadow"],
    active: ["retired", "candidate", "shadow"],
    retired: ["candidate", "active"],
    rejected: ["candidate"],
    shadow: ["approved", "rejected", "candidate"],
  };
  return allowed[from].includes(to);
}

/**
 * 从 incident 列表创建 RuleCandidate（不持久化）。
 * recurrence = evidenceIncidentIds.length。
 */
export function createRuleCandidate(opts: {
  projectId: string;
  rule: string;
  evidenceIncidentIds: string[];
  measuredImpact?: string;
  fingerprint?: string;
}): RuleCandidate {
  return {
    id: newRuleId(),
    projectId: opts.projectId,
    rule: opts.rule,
    fingerprint: opts.fingerprint ?? ruleFingerprint(opts.projectId, opts.rule),
    evidenceIncidentIds: opts.evidenceIncidentIds,
    recurrence: opts.evidenceIncidentIds.length,
    ...(opts.measuredImpact !== undefined ? { measuredImpact: opts.measuredImpact } : {}),
    status: "candidate",
  };
}

/**
 * 根据 fingerprint 查找已有 candidate，存在则增加 evidence 并递增 recurrence。
 * 不存在则返回 undefined（调用方应创建新 candidate）。
 */
export function findMatchingCandidate(
  candidates: RuleCandidate[],
  projectId: string,
  fingerprint: string,
): RuleCandidate | undefined {
  return candidates.find(
    (c) => c.projectId === projectId && c.fingerprint === fingerprint,
  );
}

/**
 * 向已有 candidate 追加 evidence incident id（去重）。
 * 返回更新后的 candidate（不可变更新）。
 */
export function appendEvidence(
  candidate: RuleCandidate,
  incidentId: string,
): RuleCandidate {
  const ids = new Set([...candidate.evidenceIncidentIds, incidentId]);
  return {
    ...candidate,
    evidenceIncidentIds: [...ids],
    recurrence: ids.size,
  };
}

// ── sandbox 验证（P4）─────────────────────────────────────────────────

/** 沙盒验证结果。 */
export type SandboxResult = {
  ruleId: string;
  passed: boolean;
  checksTotal: number;
  checksPassed: number;
  checksFailed: number;
  checkSummaries: string[];
  promoted: boolean;
  reason: string;
};

const VALID_RISKS: readonly string[] = ["low", "medium", "high", "critical"];

/**
 * 将 RuleCandidate.rule 字符串解析为 RiskRule。
 * rule 字段应为 JSON 字符串：{"pattern":"...","risk":"high","reason":"..."}。
 * 解析失败返回 undefined。
 */
export function parseRuleToRiskRule(ruleText: string): RiskRule | undefined {
  try {
    const obj = JSON.parse(ruleText) as Record<string, unknown>;
    if (typeof obj.pattern !== "string" || obj.pattern.length === 0) return undefined;
    if (typeof obj.risk !== "string" || !VALID_RISKS.includes(obj.risk)) return undefined;
    if (typeof obj.reason !== "string" || obj.reason.length === 0) return undefined;
    return {
      pattern: obj.pattern,
      risk: obj.risk as RiskRule["risk"],
      reason: obj.reason,
    };
  } catch {
    return undefined;
  }
}

/**
 * 构造沙盒策略：在现有 policy 基础上追加候选 rule（去重）。
 * 返回新 policy 对象，不修改原 policy。
 */
export function buildSandboxPolicy(policy: QualityPolicy, rule: RiskRule): QualityPolicy {
  const exists = policy.riskRules.some(
    (r) => r.pattern === rule.pattern && r.risk === rule.risk && r.reason === rule.reason,
  );
  if (exists) return policy;
  return {
    ...policy,
    riskRules: [...policy.riskRules, rule],
  };
}
