import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  ChangeSet,
  CheckRun,
  ProjectScope,
  QualityPolicy,
  QualityRun,
  ReviewFinding,
  ReviewerDecision,
} from "./types.js";
import type { QualityService } from "./service.js";
import type { RunPermissionManager } from "./permissions.js";
import {
  buildReviewerPrompt,
  parseReviewerOutput,
  findingsFromOutput,
  needsFix,
  type ReviewerOutput,
} from "./review.js";
import { classifyChangeSet } from "./risk.js";
import { collectChangeSet, collectBaseline, type Baseline } from "./change-set.js";
import { logWarn } from "../logger.js";

/**
 * ReviewOrchestrator（设计文档 §4.1 / §10 / Q2-04）。
 *
 * 当 run 进入 reviewing 阶段时：
 * 1. 收集 ChangeSet、CheckRun、AGENTS.md 摘要、风险分类、patch；
 * 2. 构造 reviewer prompt（buildReviewerPrompt）；
 * 3. 创建/复用 reviewer session，绑定只读权限；
 * 4. 调用 reviewer，等待完整输出（不截断）；
 * 5. 用 parseReviewerOutput 解析输出；
 * 6. 通过 QualityService.saveFindings 保存 finding；
 * 7. 按 needsFix 推进 run 到 fixing 或 full-verifying。
 *
 * 非法输出安全失败：parseError 时 run 推进到 failed（不伪装通过）。
 */

/** reviewer session 创建/复用 + prompt 调用的抽象接口。 */
export type ReviewerSessionRunner = {
  /**
   * 获取或创建 reviewer session，返回 sessionId。
   * 如果已有 reviewerSessionId 则复用。
   */
  ensureSession(opts: {
    project: ProjectScope;
    run: QualityRun;
    existingSessionId?: string | undefined;
  }): Promise<string>;
  /**
   * 向 session 发送 prompt 并等待完整输出（不截断）。
   * 返回 { output, stopReason }。
   */
  promptOnce(
    sessionId: string,
    text: string,
    timeoutMs?: number,
  ): Promise<{ output: string; stopReason: string }>;
};

export type ReviewOrchestratorOptions = {
  /** artifact 目录（用于 collectChangeSet 落盘 patch）。 */
  artifactDir: string;
  /** reviewer prompt 超时（默认 300s）。 */
  reviewTimeoutMs?: number | undefined;
  /** 自定义 ChangeSet 收集器（测试注入）。 */
  collectChangeSetFn?: typeof collectChangeSet | undefined;
  /** 自定义 baseline 收集器（测试注入）。 */
  collectBaselineFn?: typeof collectBaseline | undefined;
  /** 自定义 AGENTS.md 读取（测试注入）。 */
  readAgentsMd?: ((project: ProjectScope) => string | undefined) | undefined;
};

export type ReviewResult = {
  runId: string;
  verdict: ReviewerOutput["verdict"];
  findings: ReviewFinding[];
  parseError?: string | undefined;
  nextStage: QualityRun["stage"];
};

export class ReviewOrchestrator {
  private readonly service: QualityService;
  private readonly permissionManager: RunPermissionManager;
  private readonly sessionRunner: ReviewerSessionRunner;
  private readonly artifactDir: string;
  private readonly reviewTimeoutMs: number;
  private readonly collectChangeSetFn: typeof collectChangeSet;
  private readonly collectBaselineFn: typeof collectBaseline;
  private readonly readAgentsMd: (project: ProjectScope) => string | undefined;
  /** runId → reviewerSessionId 缓存（复用 session） */
  private readonly reviewerSessions = new Map<string, string>();

  constructor(
    service: QualityService,
    permissionManager: RunPermissionManager,
    sessionRunner: ReviewerSessionRunner,
    opts: ReviewOrchestratorOptions,
  ) {
    this.service = service;
    this.permissionManager = permissionManager;
    this.sessionRunner = sessionRunner;
    this.artifactDir = opts.artifactDir;
    this.reviewTimeoutMs = opts.reviewTimeoutMs ?? 300_000;
    this.collectChangeSetFn = opts.collectChangeSetFn ?? collectChangeSet;
    this.collectBaselineFn = opts.collectBaselineFn ?? collectBaseline;
    this.readAgentsMd = opts.readAgentsMd ?? defaultReadAgentsMd;
  }

  /**
   * 执行 review 流程。当 run 处于 reviewing 阶段时调用。
   * 返回 ReviewResult，包含 verdict、findings、nextStage。
   */
  async runReview(runId: string): Promise<ReviewResult> {
    const run = this.service.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.stage !== "reviewing") {
      throw new Error(`run ${runId} not in reviewing stage (stage=${run.stage})`);
    }

    const project = this.service.getProject(run.projectId);
    if (!project) throw new Error(`unknown project: ${run.projectId}`);

    const { policy } = this.service.getPolicy(project.id);

    // 1. 收集 ChangeSet
    const baseline = this.collectBaselineFn(project);
    const changeSet = this.collectChangeSetFn(
      runId,
      project,
      baseline,
      {
        protectedPaths: policy.protectedPaths,
        riskRules: policy.riskRules,
      },
      this.artifactDir,
    );

    // 2. 收集 CheckRun
    const checks = this.service.listChecks(runId);

    // 3. 收集 AGENTS.md 摘要和风险分类
    const agentsRules = this.readAgentsMd(project);
    const riskSummary = buildRiskSummary(changeSet, policy);

    // 4. 读取 patch（如果有 artifact 路径）
    const patch = readPatchArtifact(changeSet);

    // 5. 构造 reviewer prompt
    const userGoal = run.taskId
      ? `任务 ${run.taskId} 的实现需要审查。`
      : "交互式质量运行，请审查当前变更。";
    const prompt = buildReviewerPrompt({
      run,
      changeSet,
      checks,
      userGoal,
      ...(agentsRules !== undefined ? { agentsRules } : {}),
      ...(riskSummary !== undefined ? { riskSummary } : {}),
      ...(patch !== undefined ? { patch } : {}),
    });

    // 6. 创建/复用 reviewer session
    const existingSessionId = run.reviewerSessionId ?? this.reviewerSessions.get(runId);
    const reviewerSessionId = await this.sessionRunner.ensureSession({
      project,
      run,
      ...(existingSessionId !== undefined ? { existingSessionId } : {}),
    });
    // 绑定只读权限
    this.permissionManager.bindSession(reviewerSessionId, runId, "reviewer");
    this.reviewerSessions.set(runId, reviewerSessionId);

    // 7. 调用 reviewer，等待完整输出
    let output: string;
    let stopReason: string;
    try {
      const result = await this.sessionRunner.promptOnce(
        reviewerSessionId,
        prompt,
        this.reviewTimeoutMs,
      );
      output = result.output;
      stopReason = result.stopReason;
    } catch (err) {
      logWarn("review", `reviewer prompt failed for run ${runId}: ${String(err)}`);
      // 记录失败的 review 决策（Q2-07）
      this.service.saveReviewDecision({
        id: `rd-${crypto.randomBytes(6).toString("hex")}`,
        runId,
        projectId: run.projectId,
        verdict: "uncertain",
        findingCount: 0,
        blockingCount: 0,
        parseError: `reviewer prompt failed: ${String(err)}`,
        ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
        reviewedAt: Date.now(),
        outcome: "uncertain",
        resolvedAt: Date.now(),
        note: "prompt failed",
      });
      // prompt 调用失败 → run 推进到 failed（不伪装通过）
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        verdict: "uncertain",
        findings: [],
        parseError: `reviewer prompt failed: ${String(err)}`,
        nextStage: failed.stage,
      };
    }

    // 8. 解析输出（长输出不截断，非法输出安全失败）
    const { output: parsed, parseError } = parseReviewerOutput(output);
    if (parseError) {
      logWarn("review", `parse error for run ${runId}: ${parseError} (stopReason=${stopReason})`);
    }

    // 9. 生成并持久化 findings
    const findings = findingsFromOutput(parsed, runId, policy);
    if (findings.length > 0) {
      this.service.saveFindings(findings);
    }

    // 10. 记录 reviewer 决策（Q2-07 精度试运行数据收集）
    const blockingCount = findings.filter((f) => f.blocking).length;
    const decision: ReviewerDecision = {
      id: `rd-${crypto.randomBytes(6).toString("hex")}`,
      runId,
      projectId: run.projectId,
      verdict: parsed.verdict,
      findingCount: findings.length,
      blockingCount,
      ...(parseError !== undefined ? { parseError } : {}),
      ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
      reviewedAt: Date.now(),
      outcome: "pending",
    };
    this.service.saveReviewDecision(decision);

    // 11. 推进 run 状态
    const nextStage = this.advanceAfterReview(runId, parsed, findings, policy, run);

    return {
      runId,
      verdict: parsed.verdict,
      findings,
      ...(parseError !== undefined ? { parseError } : {}),
      nextStage,
    };
  }

  /**
   * review 完成后推进 run 状态。
   * - needsFix → fixing（如果未超过 maxFixRounds）或 failed（超过预算）
   * - verdict=pass 且无 blocking → full-verifying
   * - verdict=uncertain → awaiting-approval（需人工判断）
   * - parseError 且无 findings → failed（不伪装通过）
   */
  private advanceAfterReview(
    runId: string,
    output: ReviewerOutput,
    findings: ReviewFinding[],
    _policy: QualityPolicy,
    run: QualityRun,
  ): QualityRun["stage"] {
    const fix = needsFix(output, findings);

    if (fix) {
      // 检查 fix 预算（使用 run.budget，而非 policy 默认值）
      if (run.fixRound >= run.budget.maxFixRounds) {
        logWarn("review", `run ${runId} exceeded maxFixRounds (${run.fixRound}/${run.budget.maxFixRounds}), failing`);
        const next = this.service.advance(runId, "failed");
        return next.stage;
      }
      const next = this.service.advance(runId, "fixing");
      return next.stage;
    }

    if (output.verdict === "uncertain") {
      // 不确定 → 需要人工审批
      const next = this.service.advance(runId, "awaiting-approval");
      return next.stage;
    }

    // verdict=pass 且无 blocking finding → full-verifying
    const next = this.service.advance(runId, "full-verifying");
    return next.stage;
  }

  /** 清理 run 的 reviewer session 绑定。 */
  cleanupRun(runId: string): void {
    const sessionId = this.reviewerSessions.get(runId);
    if (sessionId) {
      this.permissionManager.unbindSession(sessionId);
      this.reviewerSessions.delete(runId);
    }
    this.permissionManager.unbindRun(runId);
  }
}

/** 读取 AGENTS.md 前 4000 字符作为 reviewer 上下文。 */
function defaultReadAgentsMd(project: ProjectScope): string | undefined {
  const file = path.join(project.root, "AGENTS.md");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return raw.length > 4000 ? raw.slice(0, 4000) + "\n... (truncated)" : raw;
  } catch {
    return undefined;
  }
}

/** 构建风险分类摘要。 */
function buildRiskSummary(
  changeSet: ChangeSet,
  policy: QualityPolicy,
): string | undefined {
  if (changeSet.files.length === 0) return undefined;
  const { risk, reasons } = classifyChangeSet(changeSet.files, policy);
  if (reasons.length === 0) return undefined;
  const lines = [`整体风险: ${risk}`];
  for (const r of reasons.slice(0, 20)) lines.push(`- ${r}`);
  return lines.join("\n");
}

/** 读取 patch artifact（如果存在）。 */
function readPatchArtifact(changeSet: ChangeSet): string | undefined {
  if (!changeSet.patchArtifact) return undefined;
  try {
    return fs.readFileSync(changeSet.patchArtifact, "utf-8");
  } catch {
    return undefined;
  }
}
