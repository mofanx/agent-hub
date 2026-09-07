import * as crypto from "node:crypto";
import type {
  ChangeSet,
  CheckRun,
  FindingCategory,
  FindingSeverity,
  FindingStatus,
  QualityPolicy,
  QualityRun,
  ReviewFinding,
  ReviewVerdict,
} from "./types.js";

/**
 * ReviewOrchestrator（设计文档 §4.1 / §10）。
 *
 * 职责：
 * - 构造 reviewer prompt（包含目标、patch、check 结果、AGENTS.md 规则、风险分类）；
 * - 定义 reviewer 输出的严格 JSON schema；
 * - 从完整 prompt output 解析 finding（禁止从最后 800 字符解析，长输出不截断）；
 * - 非法输出安全失败（返回 uncertain + 解析错误，不抛异常中断流程）；
 * - 计算 blocking 标记（§10.3 阻断规则）；
 * - 不直接执行 shell，不直接修改代码。
 *
 * reviewer session 的只读权限由 RunPermissionManager + agent.ts 强制（Q2-02）。
 */

/** reviewer 输出的 JSON schema（§10.2）。 */
export type ReviewerOutput = {
  verdict: ReviewVerdict;
  findings: RawFinding[];
};

export type RawFinding = {
  severity: FindingSeverity;
  confidence: number;
  category: FindingCategory;
  file?: string | undefined;
  line?: number | undefined;
  claim: string;
  evidence: string;
  reproduction?: string | undefined;
  suggestion?: string | undefined;
};

export class ReviewParseError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ReviewParseError";
    this.raw = raw;
  }
}

/** 构造 reviewer prompt 的输入上下文。 */
export type ReviewPromptInput = {
  run: QualityRun;
  changeSet: ChangeSet;
  checks: CheckRun[];
  /** 原始用户目标与验收标准。 */
  userGoal: string;
  /** 相关 AGENTS.md 规则摘要（可空）。 */
  agentsRules?: string | undefined;
  /** 风险分类结果摘要（可空）。 */
  riskSummary?: string | undefined;
  /** 完整 patch 文本（diff）。 */
  patch?: string | undefined;
};

/**
 * 构造 reviewer prompt。
 *
 * 设计文档 §10.1 要求 reviewer 拥有：
 * - 原始用户目标与验收标准；
 * - projectId、base revision、patch hash；
 * - 完整 changed files 列表与真实 patch；
 * - 相关 AGENTS.md 规则；
 * - quick/full check 结果及失败历史；
 * - 风险分类结果；
 * - 明确声明：只报告会导致错误、安全问题、数据损坏、严重退化或违反需求的问题。
 */
export function buildReviewerPrompt(input: ReviewPromptInput): string {
  const { run, changeSet, checks, userGoal, agentsRules, riskSummary, patch } = input;
  const lines: string[] = [];

  lines.push("你是独立代码审查员（reviewer）。你只读仓库，不能修改任何文件。");
  lines.push("只报告会导致错误、安全问题、数据损坏、严重退化或违反需求的问题。");
  lines.push("不要报告风格偏好或可读性建议，除非它们导致实际缺陷。");
  lines.push("");
  lines.push("## 任务上下文");
  lines.push(`- projectId: ${run.projectId}`);
  lines.push(`- runId: ${run.id}`);
  lines.push(`- base revision: ${changeSet.baseRevision ?? "(non-git)"}`);
  lines.push(`- patch hash: ${changeSet.patchHash}`);
  lines.push(`- fix round: ${run.fixRound}`);
  lines.push(`- risk: ${run.risk}`);
  lines.push("");
  lines.push("## 用户目标与验收标准");
  lines.push(userGoal);
  lines.push("");
  lines.push("## 变更文件");
  for (const f of changeSet.files) {
    const stats = f.additions !== undefined || f.deletions !== undefined
      ? ` (+${f.additions ?? 0}/-${f.deletions ?? 0})`
      : "";
    lines.push(`- [${f.status}] ${f.path}${stats}`);
  }
  if (changeSet.riskReasons.length > 0) {
    lines.push("");
    lines.push("## 风险标记");
    for (const r of changeSet.riskReasons) lines.push(`- ${r}`);
  }
  lines.push("");
  lines.push("## 检查结果");
  if (checks.length === 0) {
    lines.push("（无检查运行）");
  } else {
    for (const c of checks) {
      const ec = c.exitCode !== undefined ? ` exit=${c.exitCode}` : "";
      lines.push(`- [${c.status}] ${c.checkId}${ec} (${c.durationMs ?? 0}ms)`);
      if (c.summary) lines.push(`  ${c.summary.split("\n").slice(0, 5).join(" | ")}`);
    }
  }
  if (agentsRules) {
    lines.push("");
    lines.push("## 项目约定（AGENTS.md 摘要）");
    lines.push(agentsRules);
  }
  if (riskSummary) {
    lines.push("");
    lines.push("## 风险分类");
    lines.push(riskSummary);
  }
  if (patch) {
    lines.push("");
    lines.push("## 完整 patch");
    lines.push("```diff");
    lines.push(patch);
    lines.push("```");
  }
  lines.push("");
  lines.push("## 输出格式（严格 JSON，不要 markdown 代码块）");
  lines.push("```json");
  lines.push(JSON.stringify(REVIEWER_OUTPUT_EXAMPLE, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("规则：");
  lines.push("- verdict: pass（无阻断问题）/ needs-fix（有需修复的问题）/ uncertain（无法判定）");
  lines.push("- severity: critical | major | minor | info");
  lines.push("- confidence: 0.0～1.0，表示你对这条 finding 的确信度");
  lines.push("- category: correctness | security | data | concurrency | performance | ux | maintainability");
  lines.push("- file/line: 问题所在位置（可选但推荐）");
  lines.push("- claim: 一句话描述问题");
  lines.push("- evidence: 代码证据（引用具体代码或逻辑）");
  lines.push("- reproduction: 复现步骤（可选）");
  lines.push("- suggestion: 修复建议（可选）");
  lines.push("- 只输出 JSON，不要输出其他文字");

  return lines.join("\n");
}

const REVIEWER_OUTPUT_EXAMPLE: ReviewerOutput = {
  verdict: "needs-fix",
  findings: [
    {
      severity: "major",
      confidence: 0.9,
      category: "correctness",
      file: "hub/src/example.ts",
      line: 120,
      claim: "失败依赖仍会解锁下游任务",
      evidence: "runnableTasks 将 failed 加入 doneIds",
      reproduction: "构造 t1 failed、t2 dependsOn t1",
      suggestion: "只有 done 才满足依赖",
    },
  ],
};

const VALID_SEVERITIES: readonly FindingSeverity[] = ["critical", "major", "minor", "info"];
const VALID_CATEGORIES: readonly FindingCategory[] = [
  "correctness", "security", "data", "concurrency", "performance", "ux", "maintainability",
];
const VALID_VERDICTS: readonly ReviewVerdict[] = ["pass", "needs-fix", "uncertain"];

/**
 * 从完整 prompt output 解析 reviewer JSON。
 *
 * 设计文档 §10.2：禁止从最后 800 字符中解析。
 * 本函数接收完整 internalOutput（不截断），从中提取第一个完整 JSON 对象。
 *
 * 非法输出安全失败：返回 { verdict: "uncertain", findings: [], parseError }，
 * 不抛异常中断质量流程。
 */
export function parseReviewerOutput(rawOutput: string): { output: ReviewerOutput; parseError?: string | undefined } {
  const trimmed = rawOutput.trim();
  if (trimmed.length === 0) {
    return { output: { verdict: "uncertain", findings: [] }, parseError: "empty output" };
  }

  // 提取 JSON：可能被 ```json ... ``` 包裹，或直接是 JSON
  let jsonStr = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch && fenceMatch[1]) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 找第一个 { 到最后一个 }（容忍前后有文字）
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      jsonStr = trimmed.slice(first, last + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { output: { verdict: "uncertain", findings: [] }, parseError: `JSON parse failed: ${String(err)}` };
  }

  return validateReviewerOutput(parsed);
}

/** 校验解析后的对象是否符合 schema。 */
export function validateReviewerOutput(parsed: unknown): { output: ReviewerOutput; parseError?: string | undefined } {
  if (typeof parsed !== "object" || parsed === null) {
    return { output: { verdict: "uncertain", findings: [] }, parseError: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !VALID_VERDICTS.includes(verdict as ReviewVerdict)) {
    return { output: { verdict: "uncertain", findings: [] }, parseError: `invalid verdict: ${String(verdict)}` };
  }
  const rawFindings = obj.findings;
  if (!Array.isArray(rawFindings)) {
    return { output: { verdict: verdict as ReviewVerdict, findings: [] }, parseError: "findings is not an array" };
  }

  const findings: RawFinding[] = [];
  const errors: string[] = [];
  for (let i = 0; i < rawFindings.length; i++) {
    const rf = rawFindings[i]!;
    const result = validateRawFinding(rf, i);
    if (result.ok) {
      findings.push(result.finding);
    } else {
      errors.push(result.error);
    }
  }

  return {
    output: { verdict: verdict as ReviewVerdict, findings },
    ...(errors.length > 0 ? { parseError: errors.join("; ") } : {}),
  };
}

type FindingValidation =
  | { ok: true; finding: RawFinding }
  | { ok: false; error: string };

function validateRawFinding(raw: unknown, idx: number): FindingValidation {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: `findings[${idx}]: not an object` };
  }
  const f = raw as Record<string, unknown>;
  const severity = f.severity;
  if (typeof severity !== "string" || !VALID_SEVERITIES.includes(severity as FindingSeverity)) {
    return { ok: false, error: `findings[${idx}]: invalid severity "${String(severity)}"` };
  }
  const confidence = f.confidence;
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1 || !Number.isFinite(confidence)) {
    return { ok: false, error: `findings[${idx}]: confidence must be in [0,1]` };
  }
  const category = f.category;
  if (typeof category !== "string" || !VALID_CATEGORIES.includes(category as FindingCategory)) {
    return { ok: false, error: `findings[${idx}]: invalid category "${String(category)}"` };
  }
  const claim = f.claim;
  if (typeof claim !== "string" || claim.length === 0) {
    return { ok: false, error: `findings[${idx}]: claim required` };
  }
  const evidence = f.evidence;
  if (typeof evidence !== "string" || evidence.length === 0) {
    return { ok: false, error: `findings[${idx}]: evidence required` };
  }

  const finding: RawFinding = {
    severity: severity as FindingSeverity,
    confidence,
    category: category as FindingCategory,
    claim,
    evidence,
  };
  if (typeof f.file === "string" && f.file.length > 0) finding.file = f.file;
  if (typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 0) finding.line = f.line;
  if (typeof f.reproduction === "string" && f.reproduction.length > 0) finding.reproduction = f.reproduction;
  if (typeof f.suggestion === "string" && f.suggestion.length > 0) finding.suggestion = f.suggestion;
  return { ok: true, finding };
}

// ── blocking 规则（§10.3）─────────────────────────────────────────────

/**
 * 判断单条 finding 是否为 blocking。
 *
 * 默认 blocking 条件（§10.3）：
 *   severity ∈ {critical, major}
 *   AND confidence >= policy.minBlockingConfidence
 *   AND 有代码证据、复现步骤或确定性检查支持
 *
 * 安全和数据数据损坏 finding（category=security/data）可降低置信度阈值，
 * 但应进入用户审批，而不是无限自动修复。
 */
export function isBlocking(
  finding: RawFinding | ReviewFinding,
  policy: QualityPolicy,
): boolean {
  const sev = finding.severity;
  const blockSev = policy.review.blockSeverity;
  // severity 严重度排序：critical > major > minor > info
  const order: Record<FindingSeverity, number> = { critical: 0, major: 1, minor: 2, info: 3 };
  if (order[sev] > order[blockSev]) return false;

  // 安全/数据损坏降低阈值但不自动阻断 → 仍需审批，这里标记 blocking=true 进入 awaiting-approval
  const threshold = sev === "critical" || finding.category === "security" || finding.category === "data"
    ? Math.max(0, policy.review.minBlockingConfidence - 0.2)
    : policy.review.minBlockingConfidence;
  if (finding.confidence < threshold) return false;

  // 必须有代码证据、复现步骤或确定性检查支持
  const hasEvidence = "evidence" in finding && typeof finding.evidence === "string" && finding.evidence.length > 0;
  const hasRepro = "reproduction" in finding && typeof finding.reproduction === "string" && finding.reproduction.length > 0;
  if (!hasEvidence && !hasRepro) return false;

  return true;
}

// ── finding 持久化与状态（Q2-03）───────────────────────────────────────

export type FindingStatusTransition =
  | "open"
  | "fixed"
  | "dismissed"
  | "accepted-risk";

const VALID_STATUSES: readonly FindingStatus[] = ["open", "fixed", "dismissed", "accepted-risk"];

/** 生成 finding id。 */
export function newFindingId(): string {
  return `f-${crypto.randomBytes(6).toString("hex")}`;
}

/** 将 RawFinding 转为可持久化的 ReviewFinding，计算 blocking 和初始 status。 */
export function toReviewFinding(
  raw: RawFinding,
  runId: string,
  policy: QualityPolicy,
): ReviewFinding {
  return {
    id: newFindingId(),
    runId,
    severity: raw.severity,
    confidence: raw.confidence,
    category: raw.category,
    ...(raw.file !== undefined ? { file: raw.file } : {}),
    ...(raw.line !== undefined ? { line: raw.line } : {}),
    claim: raw.claim,
    evidence: raw.evidence,
    ...(raw.reproduction !== undefined ? { reproduction: raw.reproduction } : {}),
    ...(raw.suggestion !== undefined ? { suggestion: raw.suggestion } : {}),
    blocking: isBlocking(raw, policy),
    status: "open",
  };
}

/** 校验 finding 状态转换是否合法。 */
export function canTransitionFindingStatus(from: FindingStatus, to: FindingStatus): boolean {
  if (from === to) return true;
  // open → fixed | dismissed | accepted-risk
  // fixed → open（复检后发现未修复）
  // dismissed → open（重新打开）
  // accepted-risk → open（撤销接受）
  // 终态没有严格定义，所有非终态都可回到 open
  const allowed: Record<FindingStatus, readonly FindingStatus[]> = {
    open: ["fixed", "dismissed", "accepted-risk"],
    fixed: ["open", "dismissed", "accepted-risk"],
    dismissed: ["open"],
    "accepted-risk": ["open"],
  };
  return allowed[from].includes(to);
}

/** 校验状态字符串是否合法。 */
export function isValidFindingStatus(s: string): s is FindingStatus {
  return VALID_STATUSES.includes(s as FindingStatus);
}

/**
 * 从 ReviewerOutput + policy 生成 ReviewFinding 列表。
 * 过滤掉非法 finding（已在 parseReviewerOutput 中处理），计算 blocking。
 */
export function findingsFromOutput(
  output: ReviewerOutput,
  runId: string,
  policy: QualityPolicy,
): ReviewFinding[] {
  return output.findings.map((raw) => toReviewFinding(raw, runId, policy));
}

/**
 * 判断 review 结果是否需要修复（有 blocking finding 且 verdict=needs-fix）。
 * 用于决定 run 从 reviewing → fixing 还是 → full-verifying。
 */
export function needsFix(output: ReviewerOutput, findings: ReviewFinding[]): boolean {
  if (output.verdict === "needs-fix") return true;
  return findings.some((f) => f.blocking && f.status === "open");
}
