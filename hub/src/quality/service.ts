import * as crypto from "node:crypto";
import type {
  CheckRun,
  ProjectScope,
  QualityPolicy,
  QualityPolicyV2,
  PolicyMigrationPreview,
  QualityRun,
  QualityTrigger,
  QualityRisk,
  QualityIncident,
  RuleCandidate,
  RuleCandidateStatus,
  ReviewFinding,
  FindingStatus,
  ReviewerDecision,
  ReviewerDecisionOutcome,
  ReviewerMetrics,
  QualityBenchmark,
  BenchmarkRun,
  BenchmarkStatus,
  WorkRequest,
  RequirementSpec,
  RequirementVerification,
  WorkItem,
  QualityObservation,
  ClarificationRequest,
  RequirementAssessment,
  RequestIntent,
  ActiveControl,
  RuleDefinition,
  RuleCandidateType,
  PolicyExportPatch,
} from "./types.js";
import { createRun, isTerminal, transition, IllegalTransitionError } from "./run.js";
import { registerProject } from "./project.js";
import { assertPolicy, defaultObservePolicy, loadPolicy, suggestChecksFromAgentsMd, validatePolicy, generateDefaultPolicy, writePolicy, validatePolicyV2, migrateV1ToV2, migrateV1ToV2Write, loadPolicyV2 } from "./policy.js";
import {
  classifyIntent,
  assessGeneric,
  assessProjectSpecific,
  selectQuestions,
  createClarificationRequest,
  isExpired,
  evaluateRequirement,
  applyClarificationAnswers,
  applyClarificationSkip,
  applyClarificationCancel,
  CLARIFICATION_TTL_MS,
} from "./requirement.js";
import { canTransitionFindingStatus, isValidFindingStatus } from "./review.js";
import {
  createIncident,
  canTransitionIncidentStatus,
  isValidIncidentStatus,
  incidentFingerprint,
  autoPromoteRuleText,
  AUTO_PROMOTE_THRESHOLD,
  type IncidentStatus,
} from "./incident.js";
import {
  createRuleCandidate,
  appendEvidence,
  findMatchingCandidate,
  canTransitionRuleStatus,
  isValidRuleStatus,
  ruleFingerprint,
  parseRuleToRiskRule,
  buildSandboxPolicy,
  type SandboxResult,
} from "./rule.js";
import {
  createObservation as createObservationRec,
  canConfirmObservation,
  confirmObservationToIncident,
  createTypedRuleCandidate,
  createShadowControl,
  promoteShadowToActive,
  retireActiveControl,
  generateExportPatch,
  loadActiveControlsIntoPolicy,
  loadShadowControls,
  createSandboxEvaluation,
  verifyExportPatch,
  isRuleTypeCompatible,
  inferRuleType,
  stableFingerprint,
  FINGERPRINT_VERSION,
  type SandboxEvaluationResult,
} from "./learning.js";
import { startBenchmark as createBenchmark } from "./eval.js";
import type { Store, QualityMetricRow } from "../store.js";

/**
 * QualityService（设计文档 §4.1 / §13）。
 *
 * 负责：
 * - 创建、推进、取消、批准、拒绝、重试 QualityRun；
 * - 保证状态转换合法（委托 run.ts 状态机）；
 * - 持久化所有变更（重启后状态存在）；
 * - 通过 `emit` 广播 quality.runUpdate 事件。
 *
 * 不直接执行 shell，不直接解析 reviewer 自由文本。
 */

export type QualityEvent =
  | { method: "quality.runUpdate"; params: { runId: string; projectId: string; run: QualityRun } }
  | { method: "quality.verification.auto"; params: { runId: string; projectId: string; verdict: VerificationVerdict; records: RequirementVerification[] } };

export type Emit = (event: QualityEvent) => void;

export type StartRunParams = {
  projectId: string;
  trigger: QualityTrigger;
  roomId?: string | undefined;
  taskId?: string | undefined;
  implementerSessionId?: string | undefined;
  reviewerSessionId?: string | undefined;
  risk: QualityRisk;
  policyVersion: string;
  baseRevision?: string | undefined;
  dirtyBaselineHash?: string | undefined;
  patchHash?: string | undefined;
  budget: { maxFixRounds: number; timeoutMs: number };
  policyHash?: string | undefined;
  policySnapshotRef?: string | undefined;
  workItemId?: string | undefined;
  generation?: number | undefined;
  changeSetId?: string | undefined;
};

export type ReviewRunner = (run: QualityRun) => void;

/** fixer 回调：当 run 进入 fixing 阶段时触发 FixerOrchestrator。 */
export type FixerRunner = (run: QualityRun) => void;

/** gate runner 回调：在 quick-verifying / full-verifying 阶段执行 gate 检查。 */
export type GateRunner = (run: QualityRun) => void;

export type QualityServiceOptions = {
  reviewRunner?: ReviewRunner | undefined;
  fixerRunner?: FixerRunner | undefined;
  onTerminal?: ((run: QualityRun) => void) | undefined;
  /** quick gate runner：run 进入 quick-verifying 时触发。 */
  quickRunner?: GateRunner | undefined;
  /** full gate runner：run 进入 full-verifying 时触发。 */
  fullRunner?: GateRunner | undefined;
  /** run 进入 awaiting-approval 时触发，用于通知用户审批。 */
  onAwaitingApproval?: ((run: QualityRun) => void) | undefined;
  /**
   * 沙盒验证 runner（P4）：在临时策略版本上跑 quick gate。
   * 返回 check 摘要列表和是否通过。由 index.ts 提供 GateEngine 实现。
   */
  sandboxRunner?: ((opts: {
    projectId: string;
    sandboxPolicy: QualityPolicy;
  }) => Promise<{ passed: boolean; checkSummaries: string[]; checksTotal: number; checksPassed: number; checksFailed: number }>) | undefined;
};

export class QualityService {
  private readonly store: Store;
  private readonly emit: Emit;
  private readonly reviewRunner: ReviewRunner | undefined;
  private readonly fixerRunner: FixerRunner | undefined;
  private readonly onTerminal: ((run: QualityRun) => void) | undefined;
  private readonly sandboxRunner: QualityServiceOptions["sandboxRunner"];
  private readonly quickRunner: GateRunner | undefined;
  private readonly fullRunner: GateRunner | undefined;
  private readonly onAwaitingApproval: ((run: QualityRun) => void) | undefined;

  constructor(store: Store, emit: Emit, opts: QualityServiceOptions = {}) {
    this.store = store;
    this.emit = emit;
    this.reviewRunner = opts.reviewRunner;
    this.fixerRunner = opts.fixerRunner;
    this.onTerminal = opts.onTerminal;
    this.sandboxRunner = opts.sandboxRunner;
    this.quickRunner = opts.quickRunner;
    this.fullRunner = opts.fullRunner;
    this.onAwaitingApproval = opts.onAwaitingApproval;
  }

  // ── projects ───────────────────────────────────────────────────────

  listProjects(): ProjectScope[] {
    return this.store.listQualityProjects();
  }

  getProject(id: string): ProjectScope | undefined {
    return this.store.getQualityProject(id);
  }

  deleteProject(id: string): boolean {
    return this.store.deleteQualityProject(id);
  }

  /** 注册/刷新项目（按 connectionId + root）。 */
  registerProject(opts: Parameters<typeof registerProject>[0]): ProjectScope {
    const scope = registerProject(opts);
    const existing = this.store.getQualityProject(scope.id);
    const toSave: ProjectScope = existing
      ? { ...scope, createdAt: existing.createdAt }
      : scope;
    this.store.upsertQualityProject(toSave);
    return toSave;
  }

  // ── policy ──────────────────────────────────────────────────────────

  /** 探测项目 policy：加载 .devin/quality.json，附带 AGENTS.md 建议。无文件时返回生成的默认策略。 */
  detectPolicy(projectId: string): {
    policy?: QualityPolicy | undefined;
    suggestions: ReturnType<typeof suggestChecksFromAgentsMd>;
    errors: string[];
    path: string;
  } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { suggestions: [], errors: ["unknown project"], path: "" };
    const loaded = loadPolicy(project);
    if (loaded.ok) {
      return { policy: loaded.policy, suggestions: suggestChecksFromAgentsMd(project), errors: [], path: loaded.path };
    }
    // 无 quality.json 或文件无效时，生成合理的默认策略
    if (loaded.reason === "not-found") {
      return { policy: generateDefaultPolicy(project), suggestions: suggestChecksFromAgentsMd(project), errors: [], path: loaded.path };
    }
    return { suggestions: suggestChecksFromAgentsMd(project), errors: loaded.errors, path: loaded.path };
  }

  /** 校验给定 policy 对象（不写盘）。 */
  validatePolicy(projectId: string, policy: unknown): { ok: boolean; errors: string[] } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { ok: false, errors: ["unknown project"] };
    const errors = validatePolicy(policy, project);
    return { ok: errors.length === 0, errors };
  }

  /** 获取项目当前生效 policy（无配置时返回根据项目类型生成的默认策略）。 */
  getPolicy(projectId: string): { policy: QualityPolicy; source: "file" | "default"; errors: string[] } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { policy: defaultObservePolicy(), source: "default", errors: ["unknown project"] };
    const loaded = loadPolicy(project);
    if (loaded.ok) return { policy: loaded.policy, source: "file", errors: [] };
    if (loaded.reason === "not-found") return { policy: generateDefaultPolicy(project), source: "default", errors: [] };
    return { policy: defaultObservePolicy(), source: "default", errors: loaded.errors };
  }

  /** 为项目生成默认 quality.json 并写入磁盘，返回写入路径和策略。 */
  ensurePolicy(projectId: string): { path: string; policy: QualityPolicy } {
    const project = this.store.getQualityProject(projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    const policy = generateDefaultPolicy(project);
    const filePath = writePolicy(project, policy);
    return { path: filePath, policy };
  }

  // ── runs ────────────────────────────────────────────────────────────

  /** 创建并持久化一个 queued run，广播 runUpdate。 */
  startRun(params: StartRunParams): QualityRun {
    const run = createRun({
      id: newRunId(),
      projectId: params.projectId,
      ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      ...(params.implementerSessionId !== undefined ? { implementerSessionId: params.implementerSessionId } : {}),
      ...(params.reviewerSessionId !== undefined ? { reviewerSessionId: params.reviewerSessionId } : {}),
      trigger: params.trigger,
      risk: params.risk,
      policyVersion: params.policyVersion,
      ...(params.baseRevision !== undefined ? { baseRevision: params.baseRevision } : {}),
      ...(params.dirtyBaselineHash !== undefined ? { dirtyBaselineHash: params.dirtyBaselineHash } : {}),
      ...(params.patchHash !== undefined ? { patchHash: params.patchHash } : {}),
      budget: params.budget,
      ...(params.policyHash !== undefined ? { policyHash: params.policyHash } : {}),
      ...(params.policySnapshotRef !== undefined ? { policySnapshotRef: params.policySnapshotRef } : {}),
      ...(params.workItemId !== undefined ? { workItemId: params.workItemId } : {}),
      ...(params.generation !== undefined ? { generation: params.generation } : {}),
      ...(params.changeSetId !== undefined ? { changeSetId: params.changeSetId } : {}),
    });
    this.store.saveQualityRun(run);
    this.broadcast(run);
    return run;
  }

  getRun(id: string): QualityRun | undefined {
    return this.store.getQualityRun(id);
  }

  listRuns(projectId?: string, limit?: number): QualityRun[] {
    return this.store.listQualityRuns(projectId, limit);
  }

  listChecks(runId: string): CheckRun[] {
    return this.store.listQualityChecks(runId);
  }

  listFindings(runId: string): ReviewFinding[] {
    return this.store.listQualityFindings(runId);
  }

  getFinding(id: string): ReviewFinding | undefined {
    return this.store.getQualityFinding(id);
  }

  /** 持久化 finding（Q2-03）。 */
  saveFinding(finding: ReviewFinding): void {
    this.store.saveQualityFinding(finding);
    const run = this.store.getQualityRun(finding.runId);
    if (run) this.broadcast(run);
  }

  /** 批量持久化 findings（Q2-03）。 */
  saveFindings(findings: ReviewFinding[]): void {
    for (const f of findings) this.store.saveQualityFinding(f);
    if (findings.length > 0) {
      const run = this.store.getQualityRun(findings[0]!.runId);
      if (run) this.broadcast(run);
    }
  }

  /**
   * 更新 finding 状态（Q2-03）。
   * 校验状态转换合法性，持久化并广播。
   * 同时更新关联的 reviewer decision outcome（Q2-07 精度试运行）。
   */
  resolveFinding(
    id: string,
    status: FindingStatus,
    resolutionNote?: string,
  ): ReviewFinding {
    const finding = this.store.getQualityFinding(id);
    if (!finding) throw new Error(`unknown finding: ${id}`);
    if (!isValidFindingStatus(status)) throw new Error(`invalid finding status: ${status}`);
    if (!canTransitionFindingStatus(finding.status, status)) {
      throw new Error(`illegal finding status transition: ${finding.status} → ${status}`);
    }
    const updated: ReviewFinding = {
      ...finding,
      status,
      ...(resolutionNote !== undefined ? { resolutionNote } : {}),
    };
    this.store.saveQualityFinding(updated);
    const run = this.store.getQualityRun(finding.runId);
    if (run) this.broadcast(run);

    // Q2-07: 更新关联的 reviewer decision outcome
    this.updateDecisionFromFindingResolve(finding.runId, status);
    return updated;
  }

  // ── review decisions (Q2-07) ───────────────────────────────────────

  /** 持久化 reviewer decision。 */
  saveReviewDecision(decision: ReviewerDecision): void {
    this.store.saveQualityReviewDecision(decision);
  }

  getReviewDecision(id: string): ReviewerDecision | undefined {
    return this.store.getQualityReviewDecision(id);
  }

  getReviewDecisionByRun(runId: string): ReviewerDecision | undefined {
    return this.store.getQualityReviewDecisionByRun(runId);
  }

  listReviewDecisions(projectId?: string, limit?: number): ReviewerDecision[] {
    return this.store.listQualityReviewDecisions(projectId, limit);
  }

  /**
   * 当 finding 被 resolve 时，更新关联的 reviewer decision outcome。
   *
   * outcome 映射：
   * - fixed → confirmed（finding 被修复，说明 reviewer 报告了真实问题）
   * - dismissed → dismissed（误报或低价值）
   * - accepted-risk → accepted-risk（已知风险接受）
   *
   * 一个 run 可能有多个 finding，outcome 取最严重的：
   * confirmed > accepted-risk > dismissed > pending
   */
  private updateDecisionFromFindingResolve(runId: string, findingStatus: FindingStatus): void {
    const decision = this.store.getQualityReviewDecisionByRun(runId);
    if (!decision) return;
    if (decision.outcome !== "pending") return; // 已有终态不再覆盖

    const outcomeMap: Record<FindingStatus, ReviewerDecisionOutcome> = {
      open: "pending",
      fixed: "confirmed",
      dismissed: "dismissed",
      "accepted-risk": "accepted-risk",
    };
    const newOutcome = outcomeMap[findingStatus];
    if (newOutcome === "pending") return;

    // 检查该 run 是否还有 open blocking finding
    const stillOpen = this.hasOpenBlockingFindings(runId);
    if (stillOpen) return; // 还有未处理的 blocking finding，暂不更新

    this.store.updateQualityReviewDecisionOutcome(decision.id, newOutcome);
  }

  /**
   * 计算 reviewer 精度汇总指标（§17.3 / Q2-07）。
   * 至少 30 条 decision 后才有统计意义（sufficient=true）。
   *
   * - confirmationRate = confirmed / (confirmed + dismissed + accepted-risk)
   * - dismissalRate = dismissed / (confirmed + dismissed + accepted-risk)
   */
  getReviewerMetrics(projectId?: string): ReviewerMetrics {
    const decisions = this.store.listQualityReviewDecisions(projectId);
    return computeReviewerMetrics(decisions);
  }

  /**
   * 计算 run 的 review 阻断状态（Q2-03）。
   * 返回是否有 open blocking finding。
   */
  hasOpenBlockingFindings(runId: string): boolean {
    return this.store.listQualityFindings(runId).some(
      (f) => f.blocking && f.status === "open",
    );
  }

  // ── incidents (Q3-01) ──────────────────────────────────────────────

  listIncidents(projectId?: string): QualityIncident[] {
    return this.store.listQualityIncidents(projectId);
  }

  getIncident(id: string): QualityIncident | undefined {
    return this.store.getQualityIncident(id);
  }

  /**
   * 创建并持久化 incident（P4 自动沉淀）。
   *
   * 创建后检查同 fingerprint 的 incident 数量：
   * - 若 >= AUTO_PROMOTE_THRESHOLD（3）且尚未关联 rule candidate，自动生成 candidate；
   * - 自动生成的 candidate 关联所有同 fingerprint 的 incident 作为 evidenceIncidentIds；
   * - candidate status 始终为 candidate，不自动激活（设计文档 §16.2）。
   *
   * 返回 { incident, promoted? }：promoted 为自动生成的 rule candidate（如有）。
   */
  createIncident(opts: {
    projectId: string;
    description: string;
    severity: string;
    sourceRunId?: string;
    reproduction?: string;
    regressionTest?: string;
  }): QualityIncident {
    const incident = createIncident(opts);
    this.store.saveQualityIncident(incident);
    this.maybeAutoPromote(incident);
    return incident;
  }

  /**
   * 检查是否应自动沉淀为 rule candidate（P4）。
   * 同 fingerprint incident 数量 >= AUTO_PROMOTE_THRESHOLD 时触发。
   * 已有同 fingerprint 的 candidate 时追加 evidence 而非重复创建。
   */
  private maybeAutoPromote(incident: QualityIncident): RuleCandidate | undefined {
    const sameFp = this.store.listQualityIncidentsByFingerprint(
      incident.projectId,
      incident.fingerprint,
    );
    if (sameFp.length < AUTO_PROMOTE_THRESHOLD) return undefined;

    const ruleText = autoPromoteRuleText(incident.description);
    const fp = ruleFingerprint(incident.projectId, ruleText);
    const existing = findMatchingCandidate(
      this.store.listQualityRules(incident.projectId),
      incident.projectId,
      fp,
    );

    // 收集所有同 fingerprint incident 的 id 作为 evidence
    const allIds = sameFp.map((i) => i.id);

    if (existing) {
      // 追加尚未关联的 evidence
      const newIds = allIds.filter((id) => !existing.evidenceIncidentIds.includes(id));
      if (newIds.length === 0) return existing;
      const updated: RuleCandidate = {
        ...existing,
        evidenceIncidentIds: [...existing.evidenceIncidentIds, ...newIds],
        recurrence: existing.evidenceIncidentIds.length + newIds.length,
      };
      this.store.saveQualityRule(updated);
      return updated;
    }

    const candidate = createRuleCandidate({
      projectId: incident.projectId,
      rule: ruleText,
      evidenceIncidentIds: allIds,
      fingerprint: fp,
      ...(incident.severity !== undefined ? { measuredImpact: `auto-promoted: ${sameFp.length} recurrences, severity=${incident.severity}` } : {}),
    });
    this.store.saveQualityRule(candidate);
    return candidate;
  }

  /** 更新 incident 状态（校验状态转换合法性）。 */
  resolveIncident(id: string, status: IncidentStatus, regressionTest?: string): QualityIncident {
    const incident = this.store.getQualityIncident(id);
    if (!incident) throw new Error(`unknown incident: ${id}`);
    if (!isValidIncidentStatus(status)) throw new Error(`invalid incident status: ${status}`);
    if (!canTransitionIncidentStatus(incident.status, status)) {
      throw new Error(`illegal incident status transition: ${incident.status} → ${status}`);
    }
    const updated: QualityIncident = {
      ...incident,
      status,
      ...(regressionTest !== undefined ? { regressionTest } : {}),
    };
    this.store.saveQualityIncident(updated);
    return updated;
  }

  deleteIncident(id: string): boolean {
    return this.store.deleteQualityIncident(id);
  }

  // ── rule candidates (Q3-04) ────────────────────────────────────────

  listRules(projectId?: string): RuleCandidate[] {
    return this.store.listQualityRules(projectId);
  }

  getRule(id: string): RuleCandidate | undefined {
    return this.store.getQualityRule(id);
  }

  /** 创建并持久化 rule candidate。 */
  createRule(opts: {
    projectId: string;
    rule: string;
    evidenceIncidentIds: string[];
    measuredImpact?: string;
  }): RuleCandidate {
    const candidate = createRuleCandidate(opts);
    this.store.saveQualityRule(candidate);
    return candidate;
  }

  /**
   * 从 incident 沉淀 rule candidate（P4 / Q3-04）。
   *
   * - 如果同 rule fingerprint 的 candidate 已存在，追加 evidence 并递增 recurrence；
   * - 新建 candidate 时，关联所有同 incident fingerprint 的 incident 作为 evidenceIncidentIds
   *   （而非仅当前 incident），使 rule candidate 拥有完整的复发证据链。
   */
  promoteIncidentToRule(incidentId: string, rule: string): RuleCandidate {
    const incident = this.store.getQualityIncident(incidentId);
    if (!incident) throw new Error(`unknown incident: ${incidentId}`);
    const fp = ruleFingerprint(incident.projectId, rule);
    const existing = findMatchingCandidate(
      this.store.listQualityRules(incident.projectId),
      incident.projectId,
      fp,
    );
    if (existing) {
      const updated = appendEvidence(existing, incidentId);
      this.store.saveQualityRule(updated);
      return updated;
    }
    // 收集所有同 incident fingerprint 的 incident 作为 evidence
    const sameFp = this.store.listQualityIncidentsByFingerprint(
      incident.projectId,
      incident.fingerprint,
    );
    const evidenceIds = sameFp.length > 0 ? sameFp.map((i) => i.id) : [incidentId];
    const candidate = createRuleCandidate({
      projectId: incident.projectId,
      rule,
      evidenceIncidentIds: evidenceIds,
      fingerprint: fp,
    });
    this.store.saveQualityRule(candidate);
    return candidate;
  }

  /** 更新 rule candidate 状态（校验状态转换合法性）。 */
  resolveRule(id: string, status: RuleCandidateStatus): RuleCandidate {
    const candidate = this.store.getQualityRule(id);
    if (!candidate) throw new Error(`unknown rule: ${id}`);
    if (!isValidRuleStatus(status)) throw new Error(`invalid rule status: ${status}`);
    if (!canTransitionRuleStatus(candidate.status, status)) {
      throw new Error(`illegal rule status transition: ${candidate.status} → ${status}`);
    }
    const updated: RuleCandidate = { ...candidate, status };
    this.store.saveQualityRule(updated);
    return updated;
  }

  deleteRule(id: string): boolean {
    return this.store.deleteQualityRule(id);
  }

  // ── benchmarks (P4 评测基线) ───────────────────────────────────────

  listBenchmarks(projectId?: string): QualityBenchmark[] {
    return this.store.listQualityBenchmarks(projectId);
  }

  getBenchmark(id: string): QualityBenchmark | undefined {
    return this.store.getQualityBenchmark(id);
  }

  startBenchmark(opts: {
    projectId: string;
    name: string;
    taskSet: string;
    agents: string[];
  }): QualityBenchmark {
    const benchmark = createBenchmark(opts);
    this.store.saveQualityBenchmark(benchmark);
    return benchmark;
  }

  collectBenchmarkResult(opts: {
    benchmarkId: string;
    agent: string;
    qualityRunId: string;
    passedChecks: number;
    failedChecks: number;
    findingCount: number;
    blockingCount: number;
    fixRounds: number;
    durationMs: number;
    status?: BenchmarkStatus;
    failureReason?: string;
  }): QualityBenchmark {
    const benchmark = this.store.getQualityBenchmark(opts.benchmarkId);
    if (!benchmark) throw new Error(`unknown benchmark: ${opts.benchmarkId}`);
    const run = benchmark.runs.find((r) => r.agent === opts.agent);
    if (!run) throw new Error(`agent ${opts.agent} not in benchmark ${opts.benchmarkId}`);

    const now = Date.now();
    const status = opts.status ?? "completed";
    const updatedRun: BenchmarkRun = {
      ...run,
      qualityRunId: opts.qualityRunId,
      status,
      passedChecks: opts.passedChecks,
      failedChecks: opts.failedChecks,
      findingCount: opts.findingCount,
      blockingCount: opts.blockingCount,
      fixRounds: opts.fixRounds,
      durationMs: opts.durationMs,
      ...(opts.failureReason !== undefined ? { failureReason: opts.failureReason } : {}),
      updatedAt: now,
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { completedAt: now }
        : {}),
    };
    this.store.saveQualityBenchmarkRun(updatedRun);

    const allRuns = this.store.listQualityBenchmarkRuns(opts.benchmarkId);
    const allDone = allRuns.every(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "cancelled",
    );
    const updated: QualityBenchmark = {
      ...benchmark,
      runs: allRuns,
      status: allDone ? "completed" : "running",
      updatedAt: now,
      ...(allDone ? { completedAt: now } : {}),
    };
    this.store.saveQualityBenchmark(updated);
    return updated;
  }

  cancelBenchmark(id: string): QualityBenchmark {
    const benchmark = this.store.getQualityBenchmark(id);
    if (!benchmark) throw new Error(`unknown benchmark: ${id}`);
    const now = Date.now();
    for (const run of benchmark.runs) {
      if (run.status === "pending" || run.status === "running") {
        this.store.saveQualityBenchmarkRun({
          ...run,
          status: "cancelled",
          updatedAt: now,
          completedAt: now,
        });
      }
    }
    const allRuns = this.store.listQualityBenchmarkRuns(id);
    const updated: QualityBenchmark = {
      ...benchmark,
      runs: allRuns,
      status: "cancelled",
      updatedAt: now,
      completedAt: now,
    };
    this.store.saveQualityBenchmark(updated);
    return updated;
  }

  deleteBenchmark(id: string): boolean {
    return this.store.deleteQualityBenchmark(id);
  }

  /**
   * 沙盒验证候选 rule（P4）。
   *
   * 流程：
   * 1. 加载候选 rule 和关联项目的当前 policy；
   * 2. 将 rule 解析为 RiskRule，构造沙盒策略（追加该 rule）；
   * 3. 调用 sandboxRunner 在沙盒策略上跑 quick gate；
   * 4. 验证通过则将 rule 推进到 active（需 candidate/approved 状态）；
   * 5. 返回 SandboxResult。
   *
   * 无 sandboxRunner 时返回错误结果（不推进）。
   */
  async sandboxRule(id: string): Promise<SandboxResult> {
    const candidate = this.store.getQualityRule(id);
    if (!candidate) throw new Error(`unknown rule: ${id}`);
    if (candidate.status !== "candidate" && candidate.status !== "approved") {
      return {
        ruleId: id,
        passed: false,
        checksTotal: 0,
        checksPassed: 0,
        checksFailed: 0,
        checkSummaries: [],
        promoted: false,
        reason: `rule status is ${candidate.status}, must be candidate or approved`,
      };
    }

    const riskRule = parseRuleToRiskRule(candidate.rule);
    if (!riskRule) {
      return {
        ruleId: id,
        passed: false,
        checksTotal: 0,
        checksPassed: 0,
        checksFailed: 0,
        checkSummaries: [],
        promoted: false,
        reason: "rule text is not valid RiskRule JSON",
      };
    }

    if (!this.sandboxRunner) {
      return {
        ruleId: id,
        passed: false,
        checksTotal: 0,
        checksPassed: 0,
        checksFailed: 0,
        checkSummaries: [],
        promoted: false,
        reason: "no sandbox runner configured",
      };
    }

    const { policy } = this.getPolicy(candidate.projectId);
    const sandboxPolicy = buildSandboxPolicy(policy, riskRule);

    const gateResult = await this.sandboxRunner({
      projectId: candidate.projectId,
      sandboxPolicy,
    });

    if (gateResult.passed) {
      let promoted = candidate;
      if (candidate.status === "candidate") {
        promoted = this.resolveRule(id, "approved");
      }
      promoted = this.resolveRule(id, "active");
      return {
        ruleId: id,
        passed: true,
        checksTotal: gateResult.checksTotal,
        checksPassed: gateResult.checksPassed,
        checksFailed: gateResult.checksFailed,
        checkSummaries: gateResult.checkSummaries,
        promoted: true,
        reason: `rule promoted to active (${promoted.status})`,
      };
    }

    return {
      ruleId: id,
      passed: false,
      checksTotal: gateResult.checksTotal,
      checksPassed: gateResult.checksPassed,
      checksFailed: gateResult.checksFailed,
      checkSummaries: gateResult.checkSummaries,
      promoted: false,
      reason: `sandbox gate failed: ${gateResult.checksFailed} check(s) failed`,
    };
  }

  /** 取消 run（从任意非终态 → cancelled）。 */
  cancelRun(id: string): QualityRun {
    const run = this.requireRun(id);
    if (isTerminal(run.stage)) throw new Error(`run ${id} already terminal: ${run.stage}`);
    const next = transition(run, "cancelled");
    this.store.saveQualityRun(next);
    this.broadcast(next);
    return next;
  }

  /** 批准 run（awaiting-approval → accepted，需要 patchHash）。 */
  approveRun(id: string): QualityRun {
    const run = this.requireRun(id);
    if (run.stage !== "awaiting-approval") throw new Error(`run ${id} not awaiting approval (stage=${run.stage})`);
    const next = transition(run, "accepted");
    this.store.saveQualityRun(next);
    this.broadcast(next);
    return next;
  }

  /** 拒绝 run（awaiting-approval → failed）。 */
  rejectRun(id: string): QualityRun {
    const run = this.requireRun(id);
    if (run.stage !== "awaiting-approval") throw new Error(`run ${id} not awaiting approval (stage=${run.stage})`);
    const next = transition(run, "failed");
    this.store.saveQualityRun(next);
    this.broadcast(next);
    return next;
  }

  /** 重试：基于原 run 创建新的 queued run。 */
  retryRun(id: string): QualityRun {
    const run = this.requireRun(id);
    return this.startRun({
      projectId: run.projectId,
      trigger: run.trigger,
      ...(run.roomId !== undefined ? { roomId: run.roomId } : {}),
      ...(run.taskId !== undefined ? { taskId: run.taskId } : {}),
      ...(run.implementerSessionId !== undefined ? { implementerSessionId: run.implementerSessionId } : {}),
      ...(run.reviewerSessionId !== undefined ? { reviewerSessionId: run.reviewerSessionId } : {}),
      risk: run.risk,
      policyVersion: run.policyVersion,
      ...(run.baseRevision !== undefined ? { baseRevision: run.baseRevision } : {}),
      budget: run.budget,
    });
  }

  /**
   * 通用推进：将 run 从当前 stage 推进到 `to`，持久化并广播。
   * 供内部编排（GateEngine/ReviewOrchestrator）使用。
   */
  advance(id: string, to: QualityRun["stage"]): QualityRun {
    const run = this.requireRun(id);
    const next = transition(run, to);
    this.store.saveQualityRun(next);
    this.broadcast(next);
    if (to === "reviewing" && this.reviewRunner) {
      this.reviewRunner(next);
    }
    if (to === "fixing" && this.fixerRunner) {
      this.fixerRunner(next);
    }
    if (to === "quick-verifying" && this.quickRunner) {
      this.quickRunner(next);
    }
    if (to === "full-verifying" && this.fullRunner) {
      this.fullRunner(next);
    }
    if (to === "awaiting-approval" && this.onAwaitingApproval) {
      this.onAwaitingApproval(next);
    }
    if (to === "requirement-verifying") {
      this.autoRunVerification(next);
    }
    if (isTerminal(to)) {
      this.recordRunMetric(next);
    }
    return next;
  }

  /** 进入 requirement-verifying 阶段时自动触发 L3 验证（有 spec 的 run）。 */
  private autoRunVerification(run: QualityRun): void {
    console.log(`[hub] autoRunVerification: run=${run.id}, workItemId=${run.workItemId ?? "none"}`);
    if (!run.workItemId) return;
    const item = this.store.getWorkItem(run.workItemId);
    console.log(`[hub] autoRunVerification: workItem=${run.workItemId}, specId=${item?.specId ?? "none"}, itemFound=${!!item}`);
    if (!item?.specId) return;
    const result = this.runVerification({ runId: run.id, specId: item.specId });
    console.log(`[hub] autoRunVerification: runVerification result=${result ? "found" : "null"}, records=${result?.records?.length ?? 0}, verdict.block=${result?.verdict?.block}, matrix.overallStatus=${result?.matrix?.overallStatus}`);
    if (result) {
      this.emit({
        method: "quality.verification.auto",
        params: { runId: run.id, projectId: run.projectId, verdict: result.verdict, records: result.records },
      });
      // 按 L3 verdict 推进 run 到终态
      const status = result.matrix.overallStatus;
      let nextStage: "accepted" | "failed" | "inconclusive";
      if (result.verdict.block) {
        nextStage = "failed";
      } else if (status === "passed" || status === "waived") {
        nextStage = "accepted";
      } else {
        nextStage = "inconclusive";
      }
      try {
        this.advance(run.id, nextStage);
      } catch (err) {
        // accepted 要求 patchHash；若无 patch 则降级为 inconclusive
        if (nextStage === "accepted") {
          try { this.advance(run.id, "inconclusive"); } catch { /* */ }
        }
      }
    }
  }

  /** 直接持久化 run（供 ExecutionProvider 回写 check 后更新 run 用）。 */
  saveRun(run: QualityRun): void {
    this.store.saveQualityRun(run);
    this.broadcast(run);
  }

  /** 持久化 check 并广播 runUpdate（check 变化也触发 UI 刷新）。 */
  saveCheck(check: CheckRun): void {
    this.store.saveQualityCheck(check);
    const run = this.store.getQualityRun(check.runId);
    if (run) this.broadcast(run);
  }

  /** 清除 run 的所有旧证据（check/finding/review decision/requirement verification）。修复后复验前调用。 */
  clearRunEvidence(runId: string): { checks: number; findings: number; decisions: number; verifications: number } {
    const result = this.store.clearRunEvidence(runId);
    const run = this.store.getQualityRun(runId);
    if (run) this.broadcast(run);
    return result;
  }

  private requireRun(id: string): QualityRun {
    const run = this.store.getQualityRun(id);
    if (!run) throw new Error(`unknown run: ${id}`);
    return run;
  }

  private broadcast(run: QualityRun): void {
    this.emit({ method: "quality.runUpdate", params: { runId: run.id, projectId: run.projectId, run } });
    if (isTerminal(run.stage) && this.onTerminal) {
      this.onTerminal(run);
    }
  }

  // ── Phase 0（v3.0 §8）：WorkRequest / WorkItem / RequirementSpec / Observation ──

  createWorkRequest(params: {
    source: WorkRequest["source"];
    intent: WorkRequest["intent"];
    correlationId: string;
    mode?: string;
    roomId?: string;
    sessionId?: string;
    turnId?: string;
    rawInputRef?: string;
  }): WorkRequest {
    const now = Date.now();
    const req: WorkRequest = {
      id: `wr-${crypto.randomBytes(8).toString("hex")}`,
      source: params.source,
      intent: params.intent,
      correlationId: params.correlationId,
      status: "received",
      createdAt: now,
      updatedAt: now,
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(params.rawInputRef !== undefined ? { rawInputRef: params.rawInputRef } : {}),
    };
    this.store.saveWorkRequest(req);
    return req;
  }

  getWorkRequest(id: string): WorkRequest | undefined {
    return this.store.getWorkRequest(id);
  }

  listWorkRequests(roomId?: string, limit?: number): WorkRequest[] {
    return this.store.listWorkRequests(roomId, limit);
  }

  updateWorkRequestStatus(id: string, status: WorkRequest["status"]): WorkRequest | undefined {
    const req = this.store.getWorkRequest(id);
    if (!req) return undefined;
    const updated = { ...req, status, updatedAt: Date.now() };
    this.store.saveWorkRequest(updated);
    return updated;
  }

  createRequirementSpec(params: {
    requestId: string;
    goal: string;
    scope?: { included: string[]; excluded: string[] };
    acceptanceCriteria?: RequirementSpec["acceptanceCriteria"];
    constraints?: string[];
    risks?: string[];
    clarifications?: RequirementSpec["clarifications"];
    parentVersion?: number;
  }): RequirementSpec {
    const existing = this.store.listRequirementSpecs(params.requestId);
    const version = existing.length > 0 ? Math.max(...existing.map((s) => s.version)) + 1 : 1;
    const now = Date.now();
    const spec: RequirementSpec = {
      id: `rs-${crypto.randomBytes(8).toString("hex")}`,
      requestId: params.requestId,
      version,
      goal: params.goal,
      scope: params.scope ?? { included: [], excluded: [] },
      acceptanceCriteria: params.acceptanceCriteria ?? [],
      constraints: params.constraints ?? [],
      risks: params.risks ?? [],
      clarifications: params.clarifications ?? [],
      status: "draft",
      createdAt: now,
      updatedAt: now,
      ...(params.parentVersion !== undefined ? { parentVersion: params.parentVersion } : {}),
    };
    this.store.saveRequirementSpec(spec);
    return spec;
  }

  getRequirementSpec(id: string): RequirementSpec | undefined {
    return this.store.getRequirementSpec(id);
  }

  listRequirementSpecs(requestId: string): RequirementSpec[] {
    return this.store.listRequirementSpecs(requestId);
  }

  updateRequirementSpec(id: string, patch: Partial<Pick<RequirementSpec, "goal" | "scope" | "acceptanceCriteria" | "constraints" | "risks" | "clarifications" | "status">>): RequirementSpec | undefined {
    const spec = this.store.getRequirementSpec(id);
    if (!spec) return undefined;
    const updated = { ...spec, ...patch, updatedAt: Date.now() };
    this.store.saveRequirementSpec(updated);
    return updated;
  }

  createWorkItem(params: {
    requestId: string;
    projectId: string;
    mode: string;
    kind?: WorkItem["kind"];
    specId?: string;
    specVersion?: number;
    roomId?: string;
    taskId?: string;
    sessionId?: string;
  }): WorkItem {
    const now = Date.now();
    const item: WorkItem = {
      id: `wi-${crypto.randomBytes(8).toString("hex")}`,
      requestId: params.requestId,
      projectId: params.projectId,
      mode: params.mode,
      kind: params.kind ?? "implementation",
      status: "planned",
      currentGeneration: 0,
      createdAt: now,
      updatedAt: now,
      ...(params.specId !== undefined ? { specId: params.specId } : {}),
      ...(params.specVersion !== undefined ? { specVersion: params.specVersion } : {}),
      ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
      ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    };
    this.store.saveWorkItem(item);
    return item;
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.store.getWorkItem(id);
  }

  listWorkItems(projectId?: string, limit?: number): WorkItem[] {
    return this.store.listWorkItems(projectId, limit);
  }

  updateWorkItemStatus(id: string, status: WorkItem["status"], currentRunId?: string, currentGeneration?: number): WorkItem | undefined {
    const item = this.store.getWorkItem(id);
    if (!item) return undefined;
    const updated: WorkItem = {
      ...item,
      status,
      updatedAt: Date.now(),
      ...(currentRunId !== undefined ? { currentRunId } : {}),
      ...(currentGeneration !== undefined ? { currentGeneration } : {}),
    };
    this.store.saveWorkItem(updated);
    return updated;
  }

  createObservation(params: {
    projectId: string;
    kind: QualityObservation["kind"];
    attribution?: QualityObservation["attribution"];
    runId?: string;
    workItemId?: string;
    fingerprint?: string;
    fingerprintVersion?: number;
    evidenceRefs?: string[];
  }): QualityObservation {
    const obs: QualityObservation = {
      id: `obs-${crypto.randomBytes(8).toString("hex")}`,
      projectId: params.projectId,
      kind: params.kind,
      attribution: params.attribution ?? "unknown",
      evidenceRefs: params.evidenceRefs ?? [],
      status: "open",
      createdAt: Date.now(),
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
      ...(params.workItemId !== undefined ? { workItemId: params.workItemId } : {}),
      ...(params.fingerprint !== undefined ? { fingerprint: params.fingerprint } : {}),
      ...(params.fingerprintVersion !== undefined ? { fingerprintVersion: params.fingerprintVersion } : {}),
    };
    this.store.saveObservation(obs);
    return obs;
  }

  listObservations(projectId?: string, limit?: number): QualityObservation[] {
    return this.store.listObservations(projectId, limit);
  }

  confirmObservation(id: string): QualityObservation | undefined {
    const list = this.store.listObservations(undefined, 10000);
    const obs = list.find((o) => o.id === id);
    if (!obs) return undefined;
    const updated = { ...obs, status: "confirmed" as const };
    this.store.saveObservation(updated);
    return updated;
  }

  // ── Phase 5 L4（v3.0 §12）：受控学习 ────────────────────────────────

  /**
   * 确认 candidate-attributable 的 Observation → 生成 Incident。
   * 只有 candidate 归因的 Observation 才能确认。
   * baseline/infrastructure/unknown 归因的 Observation 不能确认。
   */
  confirmObservationToIncident(id: string, confirmedBy: string): { incident: QualityIncident; observation: QualityObservation } | undefined {
    const list = this.store.listObservations(undefined, 10000);
    const obs = list.find((o) => o.id === id);
    if (!obs) return undefined;
    if (!canConfirmObservation(obs)) {
      throw new Error(`observation ${id} cannot be confirmed (attribution=${obs.attribution})`);
    }
    const { incident, observation } = confirmObservationToIncident(obs, confirmedBy);
    this.store.saveObservation(observation);
    this.store.saveQualityIncident(incident);
    this.maybeAutoPromote(incident);
    return { incident, observation };
  }

  /** dismiss 非 candidate 的 Observation（baseline/infrastructure/unknown）。 */
  dismissObservation(id: string): QualityObservation | undefined {
    const list = this.store.listObservations(undefined, 10000);
    const obs = list.find((o) => o.id === id);
    if (!obs) return undefined;
    const updated = { ...obs, status: "dismissed" as const };
    this.store.saveObservation(updated);
    return updated;
  }

  /** 创建类型化 RuleCandidate（check/risk/requirement/verification）。 */
  createTypedRule(opts: {
    projectId: string;
    ruleType: RuleCandidateType;
    ruleDefinition: RuleDefinition;
    evidenceIncidentIds: string[];
    measuredImpact?: string;
  }): RuleCandidate {
    const candidate = createTypedRuleCandidate(opts);
    this.store.saveQualityRule(candidate);
    return candidate;
  }

  /**
   * 用户批准 rule candidate（candidate → approved）。
   * 记录批准者和批准时间。
   */
  approveRule(id: string, approvedBy: string): RuleCandidate {
    const candidate = this.store.getQualityRule(id);
    if (!candidate) throw new Error(`unknown rule: ${id}`);
    if (!isValidRuleStatus("approved")) throw new Error(`invalid rule status: approved`);
    if (!canTransitionRuleStatus(candidate.status, "approved")) {
      throw new Error(`illegal rule status transition: ${candidate.status} → approved`);
    }
    const updated: RuleCandidate = {
      ...candidate,
      status: "approved",
      approvedBy,
      approvedAt: Date.now(),
    };
    this.store.saveQualityRule(updated);
    return updated;
  }

  /**
   * 将 approved rule candidate 激活为 shadow ActiveControl（只观察不执行）。
   * shadow → active 需要用户显式 promote。
   */
  activateRuleAsShadow(id: string, activatedBy: string): ActiveControl {
    const candidate = this.store.getQualityRule(id);
    if (!candidate) throw new Error(`unknown rule: ${id}`);
    if (candidate.status !== "approved" && candidate.status !== "active") {
      throw new Error(`rule ${id} must be approved or active to activate (status=${candidate.status})`);
    }
    if (!candidate.ruleDefinition) {
      throw new Error(`rule ${id} has no ruleDefinition`);
    }
    const control = createShadowControl({
      projectId: candidate.projectId,
      ruleCandidateId: id,
      rule: candidate.ruleDefinition,
      activatedBy,
      ...(candidate.ruleType !== undefined ? { ruleType: candidate.ruleType } : {}),
    });
    this.store.saveActiveControl(control);
    // 更新 rule candidate 状态为 shadow
    const updated: RuleCandidate = { ...candidate, status: "shadow" };
    this.store.saveQualityRule(updated);
    return control;
  }

  /**
   * 将 shadow ActiveControl 提升为 active（开始执行）。
   */
  promoteShadowControl(controlId: string, activatedBy: string): ActiveControl | undefined {
    const list = this.store.listActiveControls(undefined, true);
    const control = list.find((c) => c.id === controlId);
    if (!control) return undefined;
    const updated = promoteShadowToActive(control, activatedBy);
    this.store.saveActiveControl(updated);
    return updated;
  }

  /**
   * 回滚（retire）ActiveControl，记录回滚原因。
   */
  retireControl(controlId: string, retiredBy: string, reason: string): ActiveControl | undefined {
    const list = this.store.listActiveControls(undefined, true);
    const control = list.find((c) => c.id === controlId);
    if (!control) return undefined;
    const updated = retireActiveControl(control, retiredBy, reason);
    this.store.saveActiveControl(updated);
    return updated;
  }

  /** 列出 ActiveControl（可选包含 shadow）。 */
  listActiveControls(projectId?: string, includeShadow = false): ActiveControl[] {
    return this.store.listActiveControls(projectId, includeShadow);
  }

  /**
   * 生成 policy 导出 patch（不自动写入 quality.json）。
   * 包含规则定义和预期 hash，供用户审查后手动写入。
   */
  generateExportPatch(opts: {
    projectId: string;
    ruleCandidateId: string;
    ruleType: RuleCandidateType;
    rule: RuleDefinition;
    exportedBy: string;
  }): PolicyExportPatch {
    const loaded = this.loadPolicyWithVersion(opts.projectId);
    const currentPolicy = loaded.policy ?? ({} as QualityPolicy);
    return generateExportPatch({
      ...opts,
      currentPolicy,
    });
  }

  /**
   * 验证导出 patch 的 expected hash 是否与当前 policy 匹配。
   */
  verifyExportPatch(patch: PolicyExportPatch, projectId: string): { valid: boolean; reason: string } {
    const loaded = this.loadPolicyWithVersion(projectId);
    const currentPolicy = loaded.policy ?? ({} as QualityPolicy);
    return verifyExportPatch(patch, currentPolicy);
  }

  /**
   * 加载活跃规则到 policy（运行时加载）。
   * 只加载 status=active 的规则，shadow 规则不参与执行。
   */
  loadActiveControlsIntoPolicy(policy: QualityPolicy | QualityPolicyV2, projectId: string): QualityPolicy | QualityPolicyV2 {
    const controls = this.store.listActiveControls(projectId, false);
    return loadActiveControlsIntoPolicy(policy, controls);
  }

  /** 列出 shadow 规则（用于观察/日志，不执行）。 */
  listShadowControls(projectId?: string): ActiveControl[] {
    const controls = this.store.listActiveControls(projectId, true);
    return loadShadowControls(controls);
  }

  /**
   * sandbox 评测（只评测，不批准/激活）。
   * sandbox 永远不能自动批准或激活规则。
   */
  evaluateRuleInSandbox(opts: {
    ruleCandidateId: string;
    passed: boolean;
    checksTotal: number;
    checksPassed: number;
    checksFailed: number;
    checkSummaries: string[];
    falsePositiveRate?: number;
    reason: string;
  }): SandboxEvaluationResult {
    return createSandboxEvaluation(opts);
  }

  /** 更新 rule candidate 的 sandbox 评测结果（只记录，不自动批准）。 */
  recordSandboxEvaluation(ruleId: string, result: SandboxEvaluationResult): RuleCandidate | undefined {
    const candidate = this.store.getQualityRule(ruleId);
    if (!candidate) return undefined;
    const updated: RuleCandidate = {
      ...candidate,
      sandboxPassed: result.passed,
      measuredImpact: `sandbox: ${result.reason} (passed=${result.checksPassed}/${result.checksTotal}, fpRate=${result.falsePositiveRate ?? "n/a"})`,
    };
    this.store.saveQualityRule(updated);
    return updated;
  }

  /** 类型匹配检查：rule type 是否与 incident type 兼容。 */
  isRuleTypeCompatible(ruleType: RuleCandidateType, incident: QualityIncident): boolean {
    return isRuleTypeCompatible(ruleType, incident);
  }

  /** 根据 incident type 推断合适的 rule type。 */
  inferRuleType(incident: QualityIncident): RuleCandidateType {
    return inferRuleType(incident);
  }

  // ── Policy v2（v3.0 §9.2）──────────────────────────────────────────

  validatePolicyV2(projectId: string, policy: unknown): { ok: boolean; errors: string[] } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { ok: false, errors: ["unknown project"] };
    const errors = validatePolicyV2(policy, project);
    return { ok: errors.length === 0, errors };
  }

  /** 生成 v1 → v2 迁移预览（不写盘）。 */
  previewPolicyMigration(projectId: string): PolicyMigrationPreview | undefined {
    const project = this.store.getQualityProject(projectId);
    if (!project) return undefined;
    const loaded = loadPolicy(project);
    if (!loaded.ok) return undefined;
    return migrateV1ToV2(loaded.policy);
  }

  /** 执行 v1 → v2 原子迁移（写盘 + 备份旧文件）。 */
  migratePolicyToV2(projectId: string, expectedOldHash?: string): { ok: boolean; errors: string[]; backupPath?: string; policy?: QualityPolicyV2 } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { ok: false, errors: ["unknown project"] };
    const result = migrateV1ToV2Write(project, expectedOldHash);
    if (!result.ok) return { ok: false, errors: result.errors };
    return { ok: true, errors: [], backupPath: result.backupPath, policy: result.policy };
  }

  /** 加载 policy，自动识别 v1/v2。 */
  loadPolicyWithVersion(projectId: string): {
    policy?: QualityPolicy | QualityPolicyV2;
    version: 1 | 2;
    source: "file" | "default";
    errors: string[];
  } {
    const project = this.store.getQualityProject(projectId);
    if (!project) return { version: 1, source: "default", errors: ["unknown project"] };
    const loaded = loadPolicyV2(project);
    if (loaded.ok) return { policy: loaded.policy, version: loaded.version, source: "file", errors: [] };
    if (loaded.reason === "not-found") {
      return { policy: generateDefaultPolicy(project), version: 1, source: "default", errors: [] };
    }
    return { version: 1, source: "default", errors: loaded.errors };
  }

  // ── Phase 3 L0（v3.0 §6.2）：需求质量门 ────────────────────────────

  /**
   * 意图分类：确定性规则判断用户输入的意图类型。
   * 只有 code-change 进入需求辅助。
   */
  classifyRequestIntent(text: string): RequestIntent {
    return classifyIntent(text);
  }

  /**
   * L0 完整流程：分类 → 创建 WorkRequest → 创建 RequirementSpec → 评估 → 生成 ClarificationRequest。
   * 非 code-change 意图直接返回，不拦截。
   * shadow/suggest 模式不阻断消息。
   */
  async handleL0Request(params: {
    text: string;
    source: WorkRequest["source"];
    correlationId: string;
    mode?: string;
    roomId?: string;
    sessionId?: string;
    turnId?: string;
    projectId?: string;
    l0Mode?: "shadow" | "suggest" | "require";
    modelCall?: (prompt: string) => Promise<string>;
    modelTimeoutMs?: number;
  }): Promise<{
    request: WorkRequest;
    spec?: RequirementSpec;
    assessment?: RequirementAssessment;
    clarificationRequest?: ClarificationRequest;
    skipped: boolean;
  }> {
    const intent = classifyIntent(params.text);

    // 非 code-change 不拦截
    if (intent !== "code-change") {
      const now = Date.now();
      const request: WorkRequest = {
        id: `wr-${crypto.randomBytes(8).toString("hex")}`,
        source: params.source,
        intent,
        correlationId: params.correlationId,
        status: "ready",
        createdAt: now,
        updatedAt: now,
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      };
      this.store.saveWorkRequest(request);
      return { request, skipped: true };
    }

    // 创建 WorkRequest
    const request = this.createWorkRequest({
      source: params.source,
      intent,
      correlationId: params.correlationId,
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
    });

    // 创建 RequirementSpec v1
    const spec = this.createRequirementSpec({
      requestId: request.id,
      goal: params.text,
    });
    this.updateRequirementSpec(spec.id, { status: "clarifying" });

    // 获取项目级 policy（第二阶段）
    let policy: QualityPolicyV2 | undefined;
    if (params.projectId) {
      const loaded = this.loadPolicyWithVersion(params.projectId);
      if (loaded.version === 2 && loaded.policy) {
        policy = loaded.policy as QualityPolicyV2;
      }
    }

    // 执行 L0 评估
    const assessment = await evaluateRequirement(
      params.text, request, spec, policy,
      {
        mode: params.l0Mode ?? "shadow",
        ...(params.modelCall !== undefined ? { modelCall: params.modelCall } : {}),
        ...(params.modelTimeoutMs !== undefined ? { modelTimeoutMs: params.modelTimeoutMs } : {}),
      },
    );

    // 更新 WorkRequest 状态
    this.updateWorkRequestStatus(request.id, "clarifying");

    // 生成 ClarificationRequest（如果有问题）
    let clarificationRequest: ClarificationRequest | undefined;
    if (assessment.selectedQuestions.length > 0) {
      clarificationRequest = createClarificationRequest({
        requestId: request.id,
        specId: spec.id,
        specVersion: spec.version,
        questions: assessment.selectedQuestions.map((q) => ({
          id: q.id,
          dimension: q.dimension,
          ...(q.ruleId !== undefined ? { ruleId: q.ruleId } : {}),
          text: q.text,
        })),
        canSkip: true,
        expiresAt: Date.now() + CLARIFICATION_TTL_MS,
      });
      this.store.saveClarificationRequest(clarificationRequest);

      // 将问题写入 spec 的 clarifications
      this.updateRequirementSpec(spec.id, {
        clarifications: assessment.selectedQuestions.map((q) => ({
          id: q.id,
          dimension: q.dimension,
          question: q.text,
          status: "pending" as const,
        })),
      });
    } else {
      // 无问题 → spec 直接 accepted
      this.updateRequirementSpec(spec.id, { status: "accepted" });
      this.updateWorkRequestStatus(request.id, "ready");
    }

    return { request, spec, assessment, ...(clarificationRequest !== undefined ? { clarificationRequest } : {}), skipped: false };
  }

  /** 处理用户回答澄清问题。 */
  answerClarification(params: {
    clarificationRequestId: string;
    answers: Array<{ questionId: string; answer: string }>;
  }): { spec: RequirementSpec; request: WorkRequest; clarification: ClarificationRequest } | undefined {
    const clarification = this.store.getClarificationRequest(params.clarificationRequestId);
    if (!clarification) return undefined;
    if (clarification.status !== "pending") return undefined;

    // 过期保护
    if (isExpired(clarification)) {
      const updated = { ...clarification, status: "expired" as const, answeredAt: Date.now() };
      this.store.saveClarificationRequest(updated);
      return undefined;
    }

    const spec = this.store.getRequirementSpec(clarification.specId);
    if (!spec) return undefined;

    const request = this.store.getWorkRequest(clarification.requestId);
    if (!request) return undefined;

    const updatedSpec = applyClarificationAnswers(spec, params.answers, clarification);
    this.store.saveRequirementSpec(updatedSpec);

    const updatedClarification: ClarificationRequest = {
      ...clarification,
      status: "answered",
      answeredAt: Date.now(),
    };
    this.store.saveClarificationRequest(updatedClarification);

    this.updateWorkRequestStatus(request.id, "ready");
    const updatedRequest = this.store.getWorkRequest(request.id)!;

    return { spec: updatedSpec, request: updatedRequest, clarification: updatedClarification };
  }

  /** 处理用户跳过澄清。 */
  skipClarification(clarificationRequestId: string): { spec: RequirementSpec; request: WorkRequest } | undefined {
    const clarification = this.store.getClarificationRequest(clarificationRequestId);
    if (!clarification) return undefined;
    if (clarification.status !== "pending") return undefined;

    const spec = this.store.getRequirementSpec(clarification.specId);
    if (!spec) return undefined;

    const request = this.store.getWorkRequest(clarification.requestId);
    if (!request) return undefined;

    const updatedSpec = applyClarificationSkip(spec, clarification);
    this.store.saveRequirementSpec(updatedSpec);

    const updatedClarification: ClarificationRequest = {
      ...clarification,
      status: "skipped",
      answeredAt: Date.now(),
    };
    this.store.saveClarificationRequest(updatedClarification);

    this.updateWorkRequestStatus(request.id, "ready");
    const updatedRequest = this.store.getWorkRequest(request.id)!;

    return { spec: updatedSpec, request: updatedRequest };
  }

  /** 处理用户取消澄清。 */
  cancelClarification(clarificationRequestId: string): { spec: RequirementSpec; request: WorkRequest } | undefined {
    const clarification = this.store.getClarificationRequest(clarificationRequestId);
    if (!clarification) return undefined;

    const spec = this.store.getRequirementSpec(clarification.specId);
    if (!spec) return undefined;

    const request = this.store.getWorkRequest(clarification.requestId);
    if (!request) return undefined;

    const updatedSpec = applyClarificationCancel(spec);
    this.store.saveRequirementSpec(updatedSpec);

    const updatedClarification: ClarificationRequest = {
      ...clarification,
      status: "cancelled",
      answeredAt: Date.now(),
    };
    this.store.saveClarificationRequest(updatedClarification);

    this.updateWorkRequestStatus(request.id, "cancelled");
    const updatedRequest = this.store.getWorkRequest(request.id)!;

    return { spec: updatedSpec, request: updatedRequest };
  }

  /** 获取待处理的澄清请求。 */
  getPendingClarification(requestId: string): ClarificationRequest | undefined {
    return this.store.getPendingClarificationRequest(requestId);
  }

  /** 列出澄清请求。 */
  listClarificationRequests(requestId?: string, limit?: number): ClarificationRequest[] {
    return this.store.listClarificationRequests(requestId, limit);
  }

  // ── 度量收集（§12）：run 终态时自动记录度量事件 ────────────────────

  /** 在 run 进入终态时记录度量事件（由 advance/broadcast 触发）。 */
  recordRunMetric(run: QualityRun): void {
    const checks = this.store.listQualityChecks(run.id);
    const passed = checks.filter((c) => c.status === "passed").length;
    const failed = checks.filter((c) => c.status === "failed").length;
    const infraFailed = checks.filter((c) => c.status === "infra-failed" || c.status === "timeout").length;
    const durationMs = run.completedAt !== undefined && run.createdAt !== undefined
      ? run.completedAt - run.createdAt
      : undefined;
    this.store.saveQualityMetric({
      id: `metric-${run.id}`,
      projectId: run.projectId,
      ...(run.id !== undefined ? { runId: run.id } : {}),
      ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
      kind: "run-terminal",
      ...(run.stage !== undefined ? { stage: run.stage } : {}),
      ...(run.outcome !== undefined ? { outcome: run.outcome } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      checkCount: checks.length,
      checkPassed: passed,
      checkFailed: failed,
      checkInfraFailed: infraFailed,
      hasPatch: run.patchHash !== undefined && run.patchHash !== "",
      fixRounds: run.fixRound,
      timestamp: Date.now(),
    });
  }

  /** 查询项目度量事件。 */
  listMetrics(projectId: string, kind?: string, limit?: number): QualityMetricRow[] {
    return this.store.listQualityMetrics(projectId, kind, limit);
  }

  // ── Phase 4 L3（v3.0 §6.4）：需求验证门 ────────────────────────────

  /** 运行 L3 需求验证，生成覆盖矩阵和验证记录。 */
  runVerification(params: RunVerificationInput): RunVerificationResult | undefined {
    const run = this.store.getQualityRun(params.runId);
    if (!run) return undefined;
    const spec = this.store.getRequirementSpec(params.specId);
    if (!spec) return undefined;

    const checkRuns = params.checkRuns ?? this.store.listQualityChecks(params.runId);
    const findings = params.findings ?? this.store.listQualityFindings(params.runId);

    const matrix = buildCoverageMatrix({
      spec,
      runId: params.runId,
      checkRuns,
      findings,
      runtimeEvidence: params.runtimeEvidence ?? [],
      manualEvidence: params.manualEvidence ?? [],
      aiInference: params.aiInference,
      waivers: params.waivers,
    });

    const loaded = this.loadPolicyWithVersion(run.projectId);
    const verificationMode = loaded.policy && "verification" in loaded.policy
      ? loaded.policy.verification.mode
      : "off" as const;

    const verdict = decideVerification(verificationMode, matrix);
    const records = toVerificationRecords(matrix, spec);
    for (const rec of records) this.store.saveRequirementVerification(rec);

    return { verdict, records, matrix };
  }

  /** 获取 run 的验证记录列表。 */
  listVerifications(runId: string): RequirementVerification[] {
    return this.store.listRequirementVerifications(runId);
  }

  /** 用户放弃某条验收标准。 */
  waiveCriterion(runId: string, criterionId: string, reason: string): RequirementVerification | undefined {
    const records = this.store.listRequirementVerifications(runId);
    const existing = records.find((r) => r.criterionId === criterionId);
    if (!existing) return undefined;
    const updated: RequirementVerification = {
      ...existing,
      status: "waived",
      waiverReason: reason,
      verifier: "user",
    };
    this.store.saveRequirementVerification(updated);
    return updated;
  }
}

export function newRunId(): string {
  return `q-${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * 计算 reviewer 精度汇总指标（§17.3 / Q2-07）。
 *
 * - confirmationRate = confirmed / (confirmed + dismissed + accepted-risk)
 * - dismissalRate = dismissed / (confirmed + dismissed + accepted-risk)
 * - sufficient = totalDecisions >= 30
 */
export function computeReviewerMetrics(decisions: ReviewerDecision[]): ReviewerMetrics {
  const total = decisions.length;
  const confirmed = decisions.filter((d) => d.outcome === "confirmed").length;
  const dismissed = decisions.filter((d) => d.outcome === "dismissed").length;
  const acceptedRisk = decisions.filter((d) => d.outcome === "accepted-risk").length;
  const uncertain = decisions.filter((d) => d.outcome === "uncertain").length;
  const pending = decisions.filter((d) => d.outcome === "pending").length;

  const resolved = confirmed + dismissed + acceptedRisk;
  const confirmationRate = resolved > 0 ? confirmed / resolved : 0;
  const dismissalRate = resolved > 0 ? dismissed / resolved : 0;

  const avgFindingCount = total > 0
    ? decisions.reduce((sum, d) => sum + d.findingCount, 0) / total
    : 0;
  const avgBlockingCount = total > 0
    ? decisions.reduce((sum, d) => sum + d.blockingCount, 0) / total
    : 0;

  return {
    totalDecisions: total,
    confirmed,
    dismissed,
    acceptedRisk,
    uncertain,
    pending,
    confirmationRate,
    dismissalRate,
    avgFindingCount,
    avgBlockingCount,
    sufficient: total >= 30,
  };
}

export { IllegalTransitionError, assertPolicy };

// ── L3 需求验证门（Phase 4）──────────────────────────────────────────

import {
  buildCoverageMatrix,
  decideVerification,
  toVerificationRecords,
  type VerifySpecInput,
  type CoverageMatrix,
  type VerificationVerdict,
} from "./verification.js";

export type { CoverageMatrix, VerificationVerdict } from "./verification.js";

export type RunVerificationInput = {
  runId: string;
  specId: string;
  checkRuns?: CheckRun[];
  findings?: ReviewFinding[];
  runtimeEvidence?: { description: string; artifactRef?: string }[];
  manualEvidence?: { instruction: string; verifier: string; artifactRef?: string }[];
  aiInference?: { verifier: string; confidence: number; reasoning: string; expectationId: string }[];
  waivers?: { criterionId: string; reason: string }[];
};

export type RunVerificationResult = {
  verdict: VerificationVerdict;
  records: RequirementVerification[];
  matrix: CoverageMatrix;
};

export { buildCoverageMatrix, decideVerification, toVerificationRecords };
