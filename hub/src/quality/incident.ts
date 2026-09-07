import * as crypto from "node:crypto";
import type { QualityIncident } from "./types.js";

/**
 * Incident 模型与辅助函数（设计文档 §12 / Q3-01）。
 *
 * Incident 是已发生的质量事件记录：
 * - 由 failed run 或 reviewer finding 触发创建；
 * - fingerprint 用于去重和关联 RuleCandidate；
 * - status: open → covered（已有回归测试覆盖）→ accepted-risk；
 * - 不自动修改安全策略，沉淀为 RuleCandidate 后需人工审批才能 active。
 */

export type IncidentStatus = QualityIncident["status"];

const VALID_STATUSES: readonly IncidentStatus[] = ["open", "covered", "accepted-risk"];

/** 生成 incident id。 */
export function newIncidentId(): string {
  return `inc-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 计算 incident fingerprint：sha256(projectId:description:sourceRunId?) 前 16 hex。
 * 同一项目下描述和来源 run 相同的 incident 会被视为同一事件。
 */
export function incidentFingerprint(
  projectId: string,
  description: string,
  sourceRunId?: string,
): string {
  return crypto
    .createHash("sha256")
    .update(`${projectId}:${description}:${sourceRunId ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/** 校验 status 字符串是否合法。 */
export function isValidIncidentStatus(s: string): s is IncidentStatus {
  return VALID_STATUSES.includes(s as IncidentStatus);
}

/** 校验 incident 状态转换是否合法。 */
export function canTransitionIncidentStatus(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === to) return true;
  const allowed: Record<IncidentStatus, readonly IncidentStatus[]> = {
    open: ["covered", "accepted-risk"],
    covered: ["open", "accepted-risk"],
    "accepted-risk": ["open"],
  };
  return allowed[from].includes(to);
}

/** 创建 Incident（不持久化，由调用方写入 store）。 */
export function createIncident(opts: {
  projectId: string;
  description: string;
  severity: string;
  sourceRunId?: string;
  reproduction?: string;
  regressionTest?: string;
  fingerprint?: string;
}): QualityIncident {
  return {
    id: newIncidentId(),
    projectId: opts.projectId,
    description: opts.description,
    severity: opts.severity,
    fingerprint: opts.fingerprint ?? incidentFingerprint(opts.projectId, opts.description, opts.sourceRunId),
    ...(opts.sourceRunId !== undefined ? { sourceRunId: opts.sourceRunId } : {}),
    ...(opts.reproduction !== undefined ? { reproduction: opts.reproduction } : {}),
    ...(opts.regressionTest !== undefined ? { regressionTest: opts.regressionTest } : {}),
    status: "open",
  };
}

/** 自动沉淀阈值：同 fingerprint incident 复发次数达到此值时自动生成 rule candidate。 */
export const AUTO_PROMOTE_THRESHOLD = 3;

/**
 * 从 incident 描述自动生成 rule candidate 的规则文本（P4 自动沉淀）。
 * 规则文本以 incident description 为基础，加上自动沉淀标记。
 */
export function autoPromoteRuleText(description: string): string {
  return `auto: ${description}`;
}
