export type QualityStage =
  | "queued"
  | "preflight"
  | "implementing"
  | "collecting"
  | "quick-verifying"
  | "reviewing"
  | "fixing"
  | "full-verifying"
  | "requirement-verifying"
  | "awaiting-approval"
  | "accepted"
  | "failed"
  | "inconclusive"
  | "waived"
  | "cancelled"
  | "quarantined"
  | "stale";

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
  // ── Phase 0 扩展（v3.0 §8.2）：WorkItem 关联与策略快照 ──────────────
  workItemId?: string | undefined;
  generation?: number | undefined;
  policyHash?: string | undefined;
  policySnapshotRef?: string | undefined;
  changeSetId?: string | undefined;
  outcome?: "verified" | "failed" | "inconclusive" | "waived" | undefined;
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
  // ── Phase 0 扩展（v3.0 §8.3）：Observation 归因与类型 ──────────────
  type?: "code" | "requirement" | "verification" | undefined;
  fingerprintVersion?: number | undefined;
  sourceObservationIds?: string[] | undefined;
  // ── Phase 5 扩展（v3.0 §8.3）：确认元数据 ──────────────────────
  confirmedAt?: number | undefined;
  confirmedBy?: string | undefined;
};

export type RuleCandidateStatus = "candidate" | "approved" | "active" | "retired" | "rejected" | "shadow";

export type RuleCandidateType = "check" | "risk" | "requirement" | "verification";

export type RuleCandidate = {
  id: string;
  projectId: string;
  fingerprint: string;
  rule: string;
  evidenceIncidentIds: string[];
  recurrence: number;
  measuredImpact?: string | undefined;
  status: RuleCandidateStatus;
  // ── Phase 5 扩展（v3.0 §12）：类型化规则候选 ──────────────────────
  ruleType?: RuleCandidateType | undefined;
  ruleDefinition?: RuleDefinition | undefined;
  fingerprintVersion?: number | undefined;
  sandboxPassed?: boolean | undefined;
  approvedBy?: string | undefined;
  approvedAt?: number | undefined;
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

// ── Phase 0（v3.0 §8）：WorkRequest / WorkItem / RequirementSpec / Observation ──

export type RequestIntent =
  | "code-change"
  | "investigation"
  | "discussion"
  | "operation"
  | "clarification-answer"
  | "control-command";

export type WorkRequest = {
  id: string;
  source: "room" | "session" | "scheduler" | "incident" | "manual";
  mode?: string | undefined;
  roomId?: string | undefined;
  sessionId?: string | undefined;
  correlationId: string;
  turnId?: string | undefined;
  rawInputRef?: string | undefined;
  intent: RequestIntent;
  status: "received" | "clarifying" | "ready" | "dispatched" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

export type Clarification = {
  id: string;
  dimension: string;
  question: string;
  answer?: string | undefined;
  status: "pending" | "answered" | "skipped" | "expired";
};

export type EvidenceExpectation = { id: string } & (
  | { kind: "check"; checkId: string }
  | { kind: "test"; testId?: string | undefined; description: string }
  | { kind: "runtime"; description: string }
  | { kind: "manual"; instruction: string }
  | { kind: "review"; rubric: string }
);

export type AcceptanceCriterion = {
  id: string;
  description: string;
  required: boolean;
  evidenceMode: "all" | "any";
  expectedEvidence: EvidenceExpectation[];
};

export type RequirementSpec = {
  id: string;
  requestId: string;
  version: number;
  parentVersion?: number | undefined;
  goal: string;
  scope: { included: string[]; excluded: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  risks: string[];
  clarifications: Clarification[];
  status: "draft" | "clarifying" | "accepted" | "superseded" | "cancelled";
  createdAt: number;
  updatedAt: number;
};

export type WorkItemKind = "implementation" | "verification-only" | "remediation";

export type WorkItem = {
  id: string;
  requestId: string;
  specId?: string | undefined;
  specVersion?: number | undefined;
  projectId: string;
  roomId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
  mode: string;
  kind: WorkItemKind;
  status: "planned" | "active" | "completed" | "cancelled";
  currentRunId?: string | undefined;
  currentGeneration: number;
  createdAt: number;
  updatedAt: number;
};

export type RequirementVerification = {
  id: string;
  runId: string;
  specId: string;
  specVersion: number;
  criterionId: string;
  expectationId: string;
  status: "passed" | "failed" | "inconclusive" | "waived";
  method: "check" | "test" | "runtime" | "manual" | "ai-inference";
  evidenceRefs: string[];
  verifier: string;
  confidence?: number | undefined;
  waiverReason?: string | undefined;
};

export type ObservationKind =
  | "check-failure"
  | "infra-failure"
  | "finding"
  | "verification-gap"
  | "user-feedback"
  | "contamination";

export type ObservationAttribution = "candidate" | "baseline" | "infrastructure" | "unknown";

export type QualityObservation = {
  id: string;
  projectId: string;
  runId?: string | undefined;
  workItemId?: string | undefined;
  kind: ObservationKind;
  attribution: ObservationAttribution;
  fingerprint?: string | undefined;
  fingerprintVersion?: number | undefined;
  evidenceRefs: string[];
  status: "open" | "confirmed" | "dismissed";
  createdAt: number;
  // ── Phase 5 扩展（v3.0 §8.3）：确认元数据 ──────────────────────
  confirmedAt?: number | undefined;
  confirmedBy?: string | undefined;
  attributionReason?: string | undefined;
  description?: string | undefined;
  severity?: string | undefined;
};

export type RuleSelector = {
  intents?: RequestIntent[] | undefined;
  keywords?: string[] | undefined;
  pathPatterns?: string[] | undefined;
  riskTags?: string[] | undefined;
};

export type RequirementRule = {
  id: string;
  selector: RuleSelector;
  dimension: string;
  questionTemplate: string;
};

export type VerificationRule = {
  id: string;
  selector: RuleSelector;
  criterionTemplate: string;
  evidenceMode: AcceptanceCriterion["evidenceMode"];
  expectedEvidence: AcceptanceCriterion["expectedEvidence"];
};

export type RuleDefinition =
  | { type: "check"; value: CheckDefinition }
  | { type: "risk"; value: RiskRule }
  | { type: "requirement"; value: RequirementRule }
  | { type: "verification"; value: VerificationRule };

export type ActiveControl = {
  id: string;
  projectId: string;
  ruleCandidateId: string;
  rule: RuleDefinition;
  activatedAt: number;
  activatedBy: string;
  status: "shadow" | "active" | "retired";
  retiredAt?: number | undefined;
  // ── Phase 5 扩展（v3.0 §12）：回滚记录 ──────────────────────
  retiredBy?: string | undefined;
  retireReason?: string | undefined;
  ruleType?: RuleCandidateType | undefined;
};

// ── Policy v2（v3.0 §9.2）─────────────────────────────────────────────

export type EnforcementMode = "report" | "require-pass" | "require-approval";
export type RemediationMode = "off" | "propose" | "isolated-fix" | "apply-low-risk";
export type RequirementsMode = "off" | "suggest" | "require-high-risk";
export type ReviewMode = "off" | "advisory" | "blocking";
export type VerificationMode = "off" | "suggest" | "require-evidence";

export type QualityPolicyV2 = {
  version: 2;
  checks: CheckDefinition[];
  protectedPaths: string[];
  riskRules: RiskRule[];
  requirementRules: RequirementRule[];
  verificationRules: VerificationRule[];
  enforcement: { mode: EnforcementMode; approvalRisk: "high" | "critical" };
  remediation: { mode: RemediationMode; maxFixRounds: number };
  requirements: { mode: RequirementsMode; maxQuestions: number };
  review: { mode: ReviewMode; blockSeverity: "critical" | "major"; minBlockingConfidence: number };
  verification: { mode: VerificationMode };
  evidence: { excludePaths: string[]; retentionDays: number; maxArtifactBytes: number };
};

/** v1 → v2 迁移预览（不写盘，仅展示）。 */
export type PolicyMigrationPreview = {
  v1: QualityPolicy;
  v2: QualityPolicyV2;
  changes: string[];
};

// ── Phase 5 L4（v3.0 §12）：受控学习导出 patch ──────────────────────

/** 规则激活导出 patch：包含规则定义和预期 hash，供用户审查后手动写入 quality.json。 */
export type PolicyExportPatch = {
  projectId: string;
  ruleCandidateId: string;
  ruleType: RuleCandidateType;
  rule: RuleDefinition;
  /** 导出时计算的预期 policy hash（写入后应与此匹配）。 */
  expectedPolicyHash: string;
  /** 导出时的当前 policy hash（用于检测冲突）。 */
  currentPolicyHash: string;
  /** 导出时间戳。 */
  exportedAt: number;
  /** 导出者。 */
  exportedBy: string;
  /** patch 序列化文本（JSON），供用户直接粘贴到 quality.json。 */
  patchJson: string;
};

// ── Phase 3 L0（v3.0 §6.2）：需求质量门 ──────────────────────────────

/** L0 评估的 7 个通用维度。 */
export type RequirementDimension =
  | "goal-clarity"
  | "boundary-completeness"
  | "verifiability"
  | "constraint-clarity"
  | "conflict-detection"
  | "dependency-identification"
  | "risk-identification";

/** 单个维度的评估结果。 */
export type DimensionAssessment = {
  dimension: RequirementDimension;
  ruleId?: string | undefined;
  material: boolean;
  question?: string | undefined;
  reason: string;
};

/** L0 完整评估结果。 */
export type RequirementAssessment = {
  specId: string;
  specVersion: number;
  requestId: string;
  stage: "generic" | "project-specific";
  assessments: DimensionAssessment[];
  selectedQuestions: Array<{ id: string; dimension: RequirementDimension; ruleId?: string; text: string }>;
  mode: "shadow" | "suggest" | "require";
  cost: { modelCalls: number; tokensUsed: number; durationMs: number };
  inconclusive: boolean;
};

/** 澄清请求（发送给客户端）。 */
export type ClarificationRequest = {
  id: string;
  requestId: string;
  specId: string;
  specVersion: number;
  questions: Array<{ id: string; dimension: RequirementDimension; ruleId?: string; text: string }>;
  canSkip: boolean;
  expiresAt?: number | undefined;
  status: "pending" | "answered" | "skipped" | "expired" | "cancelled";
  createdAt: number;
  answeredAt?: number | undefined;
};

/** L0 运行度量（shadow/suggest 灰度数据）。 */
export type L0Metrics = {
  totalRequests: number;
  codeChangeRequests: number;
  clarificationsAsked: number;
  clarificationsAnswered: number;
  clarificationsSkipped: number;
  clarificationsExpired: number;
  totalQuestions: number;
  totalModelCalls: number;
  totalTokensUsed: number;
  totalDurationMs: number;
  inconclusiveCount: number;
  /** 有用率：回答后后续 spec 版本有实质变化的比率（Phase 4 补充） */
  usefulnessRate: number;
};
