export type QualityStage =
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

export type QualityRisk = "low" | "medium" | "high" | "critical";

export type QualityTrigger = "interactive" | "conductor" | "scheduled" | "incident";

export type QualityVerdict = "pass" | "fail" | "needs-approval";

export type QualityRun = {
  id: string;
  projectId: string;
  roomId?: string | undefined;
  taskId?: string | undefined;
  implementerSessionId?: string | undefined;
  reviewerSessionId?: string | undefined;
  trigger: QualityTrigger;
  stage: QualityStage;
  risk: QualityRisk;
  policyVersion: string;
  baseRevision?: string | undefined;
  dirtyBaselineHash?: string | undefined;
  patchHash?: string | undefined;
  fixRound: number;
  budget: { maxFixRounds: number; timeoutMs: number };
  verdict?: QualityVerdict | undefined;
  failureCode?: string | undefined;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
};

export type CheckTier = "quick" | "full";

export type CheckDefinition = {
  id: string;
  cwd: string;
  argv: string[];
  tier: CheckTier;
  timeoutMs: number;
  paths?: string[] | undefined;
  required: boolean;
  allowNetwork?: boolean | undefined;
  envNames?: string[] | undefined;
};

export type CheckRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "infra-failed";

export type CheckRun = {
  id: string;
  runId: string;
  checkId: string;
  attempt: number;
  status: CheckRunStatus;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  summary?: string | undefined;
  stdoutArtifact?: string | undefined;
  stderrArtifact?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
};

export type FindingSeverity = "critical" | "major" | "minor" | "info";

export type FindingCategory =
  | "correctness"
  | "security"
  | "data"
  | "concurrency"
  | "performance"
  | "ux"
  | "maintainability";

export type FindingStatus = "open" | "fixed" | "dismissed" | "accepted-risk";

export type ReviewFinding = {
  id: string;
  runId: string;
  severity: FindingSeverity;
  confidence: number;
  category: FindingCategory;
  file?: string | undefined;
  line?: number | undefined;
  claim: string;
  evidence: string;
  reproduction?: string | undefined;
  suggestion?: string | undefined;
  blocking: boolean;
  status: FindingStatus;
  resolutionNote?: string | undefined;
};

export type ReviewVerdict = "pass" | "needs-fix" | "uncertain";

export type ChangeSetFile = {
  path: string;
  status: "add" | "modify" | "delete" | "rename";
  additions?: number | undefined;
  deletions?: number | undefined;
};

export type ChangeSet = {
  runId: string;
  baseRevision?: string | undefined;
  patchArtifact: string;
  patchHash: string;
  files: ChangeSetFile[];
  preexistingDirty: boolean;
  contaminated: boolean;
  riskReasons: string[];
};

export type ProjectScope = {
  id: string;
  connectionId: string;
  root: string;
  gitRoot?: string | undefined;
  displayName: string;
  capabilities: {
    git: boolean;
    localExec: boolean;
    remoteExec: boolean;
    isolatedWorktree: boolean;
  };
  policyVersion?: string | undefined;
  createdAt: number;
  updatedAt: number;
};

export type QualityAutonomy = "observe" | "propose" | "isolated-fix" | "apply-low-risk";

export type QualityPolicy = {
  version: 1;
  checks: CheckDefinition[];
  protectedPaths: string[];
  riskRules: RiskRule[];
  review: {
    enabled: boolean;
    reviewerSessionId?: string | undefined;
    blockSeverity: "critical" | "major";
    minBlockingConfidence: number;
    maxFixRounds: number;
  };
  autonomy: QualityAutonomy;
};

export type RiskRule = {
  pattern: string;
  risk: QualityRisk;
  reason: string;
};

export type QualityIncident = {
  id: string;
  projectId: string;
  sourceRunId?: string | undefined;
  description: string;
  fingerprint: string;
  severity: string;
  reproduction?: string | undefined;
  regressionTest?: string | undefined;
  status: "open" | "covered" | "accepted-risk";
};

export type RuleCandidateStatus = "candidate" | "approved" | "active" | "retired" | "rejected";

export type RuleCandidate = {
  id: string;
  projectId: string;
  fingerprint: string;
  rule: string;
  evidenceIncidentIds: string[];
  recurrence: number;
  measuredImpact?: string | undefined;
  status: RuleCandidateStatus;
};

// ── Q2-07: reviewer 精度试运行数据 ────────────────────────────────────

/**
 * 记录单次 review 的 reviewer 决策与最终结果（§17.3 reviewer precision/dismissal rate）。
 *
 * - review 发生时记录 reviewer verdict、finding 数量、blocking 数量、parseError；
 * - finding 被 resolve（fixed/dismissed/accepted-risk）时更新 outcome；
 * - 用于计算确认率（confirmed / total）和驳回率（dismissed / total）。
 */
export type ReviewerDecision = {
  id: string;
  runId: string;
  projectId: string;
  /** reviewer 输出的 verdict。 */
  verdict: ReviewVerdict;
  /** reviewer 报告的 finding 总数。 */
  findingCount: number;
  /** 其中 blocking 的数量。 */
  blockingCount: number;
  /** 解析错误（非法输出安全失败时记录）。 */
  parseError?: string | undefined;
  /** reviewer 使用的 session id。 */
  reviewerSessionId?: string | undefined;
  /** review 发生时间。 */
  reviewedAt: number;
  /** 最终结果：confirmed（finding 被修复或促成代码修改）/ dismissed / accepted-risk / pending。 */
  outcome: ReviewerDecisionOutcome;
  /** 最终结果确定时间。 */
  resolvedAt?: number | undefined;
  /** 备注（如 run 终态、fix 轮次等）。 */
  note?: string | undefined;
};

export type ReviewerDecisionOutcome = "pending" | "confirmed" | "dismissed" | "accepted-risk" | "uncertain";

/**
 * reviewer 精度汇总指标（§17.3）。
 * 至少 30 条 decision 后才有统计意义。
 */
export type ReviewerMetrics = {
  totalDecisions: number;
  confirmed: number;
  dismissed: number;
  acceptedRisk: number;
  uncertain: number;
  pending: number;
  /** 确认率 = confirmed / (confirmed + dismissed + accepted-risk)。 */
  confirmationRate: number;
  /** 驳回率 = dismissed / (confirmed + dismissed + accepted-risk)。 */
  dismissalRate: number;
  /** 平均 finding 数量。 */
  avgFindingCount: number;
  /** 平均 blocking 数量。 */
  avgBlockingCount: number;
  /** 是否达到 30 条样本（统计可靠的最低要求）。 */
  sufficient: boolean;
};

// ── P4 评测基线（Benchmark）─────────────────────────────────────────────

/** benchmark 运行状态。 */
export type BenchmarkStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** 单个 agent 在一次 benchmark 中的运行结果。 */
export type BenchmarkRun = {
  id: string;
  benchmarkId: string;
  /** agent 标识（如 "devin-cli" / "claude" / "codex"）。 */
  agent: string;
  /** 关联的 QualityRun id（如果通过质量链路执行）。 */
  qualityRunId?: string | undefined;
  status: BenchmarkStatus;
  /** 通过的检查数。 */
  passedChecks: number;
  /** 失败的检查数。 */
  failedChecks: number;
  /** review finding 数。 */
  findingCount: number;
  /** blocking finding 数。 */
  blockingCount: number;
  /** fix 轮次。 */
  fixRounds: number;
  /** 从开始到完成的总耗时 ms。 */
  durationMs: number;
  /** 失败原因（如果 failed）。 */
  failureReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
};

/**
 * QualityBenchmark：一组 agent 在同一任务集上的对比评测基线。
 *
 * 设计文档 §14 / P4：
 * - 同一 projectId + taskSet 下，多个 agent 各运行一次；
 * - 用 QualityRun 的 check/finding/fix 数据作为客观指标；
 * - 支持后续版本对比（下一版优于上一版）。
 */
export type QualityBenchmark = {
  id: string;
  projectId: string;
  /** 评测名称。 */
  name: string;
  /** 任务集描述（JSON 或自由文本）。 */
  taskSet: string;
  /** 参与对比的 agent 列表。 */
  agents: string[];
  /** 各 agent 的运行结果。 */
  runs: BenchmarkRun[];
  status: BenchmarkStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
};
