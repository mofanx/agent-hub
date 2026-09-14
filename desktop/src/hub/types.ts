export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = Record<string, JsonValue>;

export interface ConnProfile {
  name: string;
  address: string;
  token: string;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  agent: string;
  token: string;
  address: string;
  cwd: string;
  online: boolean;
  local: boolean;
  error?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  name: string;
  busy: boolean;
  agent: string;
  address: string;
  connectionId: string | null;
  offline: boolean;
  archived: boolean;
}

export interface RoomModeConfig {
  conductorId?: string | null;
  parallelSummarizerId?: string | null;
  pipelineOrder?: string[] | null;
  debateSides?: [string, string] | null;
  debateJudge?: string | null;
  debateRounds?: number | null;
}

export interface FlowArtifact {
  type: "file" | "event";
  action?: string;
  path?: string;
  summary: string;
}

export interface EventInfo {
  id: string;
  author: string;
  at: number;
  action: "add" | "modify" | "delete" | "rename" | "command" | "test";
  summary: string;
  path?: string;
  oldPath?: string;
  taskId?: string;
}

export interface BlackboardInfo {
  id: string;
  from: string;
  text: string;
  detail: string;
  at: number;
}

export interface FileTreeRoot {
  name: string;
  path: string;
  kind: string;
  sessionId?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: string;
  at: number;
  size?: number;
}

export interface QualitySummary {
  runId: string;
  stage: string;
  enforcement: string;
  fixRound: number;
  maxFixRounds: number;
  passedChecks: number;
  failedChecks: number;
  findings: number;
  blockingFindings: number;
  verdict?: string;
  failureCode?: string;
  awaitingApproval: boolean;
}

export interface FlowTask {
  id: string;
  sessionId: string;
  name: string;
  status: "pending" | "running" | "done" | "failed" | "verifying";
  task: string;
  dependsOn: string[];
  artifacts: FlowArtifact[];
  qualityRunId?: string;
  failureMessage?: string;
  output?: string;
  retries?: number;
  awaitingApproval?: boolean;
  quality?: QualitySummary;
}

export interface ArtifactInfo {
  id: string;
  alias?: string;
  author: string;
  at: number;
  summary: string;
  path?: string;
  taskId?: string;
}

export interface FlowInfo {
  roomId: string;
  phase: string;
  progress: { done: number; running: number; pending: number; failed: number; verifying?: number; total: number };
  tasks: FlowTask[];
}

export interface RoomInfo {
  roomId: string;
  name: string;
  mode: string;
  conductorId: string | null;
  members: [string, string][];
  archived: boolean;
  /** 当前房间中正在发言的 sessionId */
  activeSpeaker?: string | null;
  /** 成员角色卡：sessionId -> persona */
  memberRoles?: Record<string, string> | null;
  /** 并行/集思广益：汇总者 sessionId */
  parallelSummarizerId?: string | null;
  /** 流水线：成员执行顺序 */
  pipelineOrder?: string[] | null;
  /** 辩论：正方/反方 sessionId */
  debateSides?: [string, string] | null;
  /** 辩论：裁判 sessionId */
  debateJudge?: string | null;
  /** 辩论：轮数 */
  debateRounds?: number | null;
}

export interface RoleInfo {
  id: string;
  name: string;
  persona: string;
  cwd: string | null;
  agent: string | null;
  address: string | null;
  connectionId: string | null;
  builtin: boolean;
}

export interface SearchHit {
  scope: string;
  scopeId: string;
  author: string;
  text: string;
  at?: number;
  id?: number;
}

export interface SearchGroup {
  scope: string;
  scopeId: string;
  count: number;
  previews: SearchHit[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface ContextUsage {
  used: number;
  size: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface Attachment {
  mimeType: string;
  base64: string;
  name: string;
}

export interface ModelInfo {
  uid: string;
  label: string;
  family: string;
  vendor: string;
  slug: string;
  aliases: string[];
  costTier: string;
  costSummary?: string;
  isCurrent?: boolean;
  backend: ModelBackend;
}

export type ModelBackend = "devin" | "claude" | "codex" | "opencode" | "openclaw" | "custom";

export interface BackendConfig {
  id: string;
  name: string;
  type: ModelBackend;
  enabled: boolean;
  config?: Record<string, string>;
}

export type ChatItem =
  | { kind: "user"; at?: number; historyId?: number; text: string; author: string; attachments?: Attachment[]; quoteAuthor?: string; quoteText?: string }
  | { kind: "system"; at?: number; historyId?: number; text: string; author: string }
  | { kind: "assistant"; at?: number; historyId?: number; id: number; text: string; author: string; usage?: TokenUsage; quoteAuthor?: string; quoteText?: string }
  | { kind: "thought"; at?: number; historyId?: number; id: number; text: string; author: string; quoteAuthor?: string; quoteText?: string }
  | { kind: "tool"; at?: number; historyId?: number; toolCallId: string; title: string; status: string; author: string }
  | { kind: "plan"; at?: number; historyId?: number; entries: string[]; author: string }
  | { kind: "error"; at?: number; historyId?: number; text: string; author: string }
  | {
      kind: "permission";
      at?: number;
      historyId?: number;
      requestId: string;
      title: string;
      options: [string, string][];
      answered: string | null;
      author: string;
    }
  | {
      kind: "clarification";
      at?: number;
      historyId?: number;
      clarificationRequestId: string;
      specId: string;
      specVersion: number;
      questions: Array<{ id: string; dimension: string; text: string }>;
      canSkip: boolean;
      expiresAt?: number;
      answered: "answered" | "skipped" | "cancelled" | null;
      author: string;
    };

export type Screen = "connect" | "sessions" | "chat" | "room" | "settings" | "schedule" | "quality";

export type QualityStage =
  | "queued"
  | "preflight"
  | "implementing"
  | "collecting"
  | "quick-verifying"
  | "reviewing"
  | "reviewed"
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
export type QualityOutcome = "verified" | "failed" | "inconclusive" | "waived";

export interface QualityRun {
  id: string;
  projectId: string;
  roomId?: string;
  taskId?: string;
  implementerSessionId?: string;
  reviewerSessionId?: string;
  trigger: QualityTrigger;
  stage: QualityStage;
  risk: QualityRisk;
  policyVersion: string;
  baseRevision?: string;
  dirtyBaselineHash?: string;
  patchHash?: string;
  fixRound: number;
  budget: { maxFixRounds: number; timeoutMs: number };
  verdict?: QualityVerdict;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  // ── Phase 0 扩展：WorkItem 关联与策略快照 ──
  workItemId?: string;
  generation?: number;
  policyHash?: string;
  policySnapshotRef?: string;
  changeSetId?: string;
  outcome?: QualityOutcome;
}

export type CheckRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "infra-failed";

export interface QualityCheck {
  id: string;
  runId: string;
  checkId: string;
  attempt: number;
  status: CheckRunStatus;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface QualityFinding {
  id: string;
  runId: string;
  severity: "critical" | "major" | "minor" | "info";
  confidence: number;
  category: string;
  file?: string;
  line?: number;
  claim: string;
  evidence: string;
  reproduction?: string;
  suggestion?: string;
  blocking: boolean;
  status: "open" | "fixed" | "dismissed" | "accepted-risk";
  resolutionNote?: string;
}

export interface RequirementVerification {
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
  confidence?: number;
  waiverReason?: string;
}

export type RequirementDimension =
  | "goal"
  | "scope"
  | "constraints"
  | "risks"
  | "acceptance"
  | "priority"
  | "dependencies"
  | "non-functional";

export type EvidenceExpectation = { id: string } & (
  | { kind: "check"; checkId: string }
  | { kind: "test"; testId?: string; description: string }
  | { kind: "runtime"; description: string }
  | { kind: "manual"; instruction: string }
  | { kind: "review"; rubric: string }
);

export interface AcceptanceCriterion {
  id: string;
  description: string;
  required: boolean;
  evidenceMode: "all" | "any";
  expectedEvidence: EvidenceExpectation[];
}

export interface Clarification {
  id: string;
  dimension: string;
  question: string;
  answer?: string;
  status: "pending" | "answered" | "skipped" | "expired";
}

export interface RequirementSpec {
  id: string;
  requestId: string;
  version: number;
  parentVersion?: number;
  goal: string;
  scope: { included: string[]; excluded: string[] };
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: string[];
  risks: string[];
  clarifications: Clarification[];
  status: "draft" | "clarifying" | "accepted" | "superseded" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface ClarificationRequest {
  id: string;
  requestId: string;
  specId: string;
  specVersion: number;
  questions: Array<{ id: string; dimension: RequirementDimension; ruleId?: string; text: string }>;
  canSkip: boolean;
  expiresAt?: number;
  status: "pending" | "answered" | "skipped" | "expired" | "cancelled";
  createdAt: number;
  answeredAt?: number;
}

export interface QualityProject {
  id: string;
  connectionId: string;
  root: string;
  gitRoot?: string;
  displayName: string;
  capabilities: { git: boolean; localExec: boolean; remoteExec: boolean; isolatedWorktree: boolean };
  policyVersion?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QualityCheckDef {
  id: string;
  cwd: string;
  argv: string[];
  tier: "quick" | "full";
  timeoutMs: number;
  paths?: string[];
  required: boolean;
  allowNetwork?: boolean;
}

export interface QualityPolicy {
  version: 1;
  checks: QualityCheckDef[];
  protectedPaths: string[];
  riskRules: { pattern: string; risk: QualityRisk; reason: string }[];
  review: {
    enabled: boolean;
    reviewerSessionId?: string;
    blockSeverity: string;
    minBlockingConfidence: number;
    maxFixRounds: number;
  };
  autonomy: "observe" | "propose" | "isolated-fix" | "apply-low-risk";
}

export interface QualityPolicyInfo {
  policy: QualityPolicy | QualityPolicyV2;
  version: 1 | 2;
  source: string;
  errors: string[];
}

// ── Policy v2（Phase 0 §9.2）──

export type EnforcementMode = "report" | "require-pass" | "require-approval";
export type RemediationMode = "off" | "propose" | "isolated-fix" | "apply-low-risk";
export type RequirementsMode = "off" | "suggest" | "require" | "require-high-risk";
export type ReviewMode = "off" | "advisory" | "blocking";
export type VerificationMode = "off" | "suggest" | "require-evidence";

export type ReviewTier = "light" | "standard" | "deep";

export interface ReviewTriggerConfig {
  minDiffLines: number;
  skipPatterns: string[];
}

export interface ReviewTierMapping {
  default: ReviewTier;
  byRisk: Partial<Record<QualityRisk, ReviewTier>>;
  byFileType: { pattern: string; tier: ReviewTier }[];
}

export interface ReviewConfigV2 {
  mode: ReviewMode;
  blockSeverity: "critical" | "major";
  minBlockingConfidence: number;
  trigger: ReviewTriggerConfig;
  tierMapping: ReviewTierMapping;
  model: string;
  reviewerAgent?: string;
  reviewerModel?: string;
}

export interface QualityPolicyV2 {
  version: 2;
  checks: QualityCheckDef[];
  protectedPaths: string[];
  riskRules: { pattern: string; risk: QualityRisk; reason: string }[];
  requirementRules: unknown[];
  verificationRules: unknown[];
  enforcement: { mode: EnforcementMode; approvalRisk: "high" | "critical" };
  remediation: { mode: RemediationMode; maxFixRounds: number };
  requirements: { mode: RequirementsMode; maxQuestions: number };
  review: ReviewConfigV2;
  verification: { mode: VerificationMode };
  evidence: { excludePaths: string[]; retentionDays: number; maxArtifactBytes: number };
}

export interface PolicyMigrationPreview {
  v1: QualityPolicy;
  v2: QualityPolicyV2;
  changes: string[];
}

// ── WorkItem / WorkRequest / RequirementSpec（Phase 0 §8）──

export interface WorkRequest {
  id: string;
  source: "room" | "session" | "scheduler" | "incident" | "manual";
  mode?: string;
  roomId?: string;
  sessionId?: string;
  intent: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItem {
  id: string;
  requestId: string;
  specId?: string;
  specVersion?: number;
  projectId: string;
  roomId?: string;
  taskId?: string;
  sessionId?: string;
  mode: string;
  kind: "implementation" | "verification-only" | "remediation";
  status: "planned" | "active" | "completed" | "cancelled";
  currentRunId?: string;
  currentGeneration: number;
  createdAt: number;
  updatedAt: number;
}

export interface QualityIncident {
  id: string;
  projectId: string;
  sourceRunId?: string;
  description: string;
  fingerprint: string;
  severity: string;
  reproduction?: string;
  regressionTest?: string;
  status: "open" | "covered" | "accepted-risk";
}

export interface QualityRule {
  id: string;
  projectId: string;
  fingerprint: string;
  rule: string;
  evidenceIncidentIds: string[];
  recurrence: number;
  measuredImpact?: string;
  status: "candidate" | "approved" | "active" | "retired" | "rejected";
}

export type ScheduleMode = "simple" | "cron";

export type SimpleSchedule = {
  mode: "simple";
  kind: "daily" | "interval" | "once";
  time?: string;
  intervalMinutes?: number;
  at?: number;
};

export type CronSchedule = {
  mode: "cron";
  expr: string;
};

export type Schedule = SimpleSchedule | CronSchedule;

export type ScheduledTask = {
  id: string;
  name: string;
  targetType: "session" | "room";
  targetId: string;
  targetName: string;
  message: string;
  schedule: Schedule;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
};

export type TaskLog = {
  id: string;
  taskId: string;
  taskName: string;
  targetType: "session" | "room";
  targetId: string;
  targetName: string;
  message: string;
  at: number;
  success: boolean;
  error: string | null;
};

export interface SlashCommand {
  name: string;
  description: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  location: string;
  scope: "project" | "user";
}

export interface AppConfig {
  profiles: ConnProfile[];
  pinned: string[];
  cwds: string[];
  commands: string[];
  theme: string;
  lang: string;
  sendKey?: "enter" | "ctrl-enter";
  last: { address: string; token: string } | null;
}
