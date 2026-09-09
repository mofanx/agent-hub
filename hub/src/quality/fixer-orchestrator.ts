import type {
  ChangeSet,
  ProjectScope,
  QualityPolicy,
  QualityRun,
  ReviewFinding,
} from "./types.js";
import type { QualityService } from "./service.js";
import type { RunPermissionManager } from "./permissions.js";
import type { GateEngine, GateResult } from "./gate.js";
import { collectChangeSet, collectBaseline, type Baseline } from "./change-set.js";
import { logWarn } from "../logger.js";
import {
  canCreateWorktree,
  createWorktree,
  removeWorktree,
  requiresApproval,
  type WorktreeInfo,
} from "./worktree.js";
import { getPolicyEnforcement, getPolicyApprovalRisk } from "./policy.js";

/**
 * FixerOrchestrator（设计文档 §4.1 / §10 / Q2-04）。
 *
 * 当 run 进入 fixing 阶段时：
 * 1. 读取 review findings（open + blocking），从 suggestion 构造修复指令；
 * 2. 创建/复用 fixer session，绑定 implementer 角色（受 protectedPaths/riskRules 限制）；
 * 3. 向 fixer 发送修复 prompt，等待完整输出；
 * 4. 推进 fixing → collecting（状态机自动清除旧 patchHash）；
 * 5. 收集新 ChangeSet；
 * 6. 推进 collecting → quick-verifying，运行 quick gate；
 * 7. 按 quick gate 结果推进到 reviewing / fixing / failed；
 * 8. 处理 maxFixRounds：超过预算时不再进入 fixing，直接 failed。
 *
 * 非法/空 suggestion 安全失败：无可用 finding 时不发空指令，直接 failed。
 */

/** fixer session 创建/复用 + prompt 调用的抽象接口。 */
export type FixerSessionRunner = {
  /**
   * 获取或创建 fixer session，返回 sessionId。
   * 如果已有 implementerSessionId 则复用。
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

export type FixerOrchestratorOptions = {
  /** artifact 目录（用于 collectChangeSet 落盘 patch）。 */
  artifactDir: string;
  /** fixer prompt 超时（默认 300s）。 */
  fixTimeoutMs?: number | undefined;
  /** 自定义 ChangeSet 收集器（测试注入）。 */
  collectChangeSetFn?: typeof collectChangeSet | undefined;
  /** 自定义 baseline 收集器（测试注入）。 */
  collectBaselineFn?: typeof collectBaseline | undefined;
  /** 自定义 worktree 创建（测试注入）。 */
  createWorktreeFn?: typeof createWorktree | undefined;
  /** 自定义 worktree 清理（测试注入）。 */
  removeWorktreeFn?: typeof removeWorktree | undefined;
  /** 是否强制使用隔离 worktree（测试时可关闭）。 */
  requireIsolatedWorktree?: boolean | undefined;
};

export type FixResult = {
  runId: string;
  /** 是否成功完成修复并重新验证。 */
  fixed: boolean;
  /** 新收集的 ChangeSet 的 patchHash。 */
  patchHash: string;
  /** quick gate 结果（如果执行了）。 */
  quickGate?: GateResult | undefined;
  /** 最终 stage。 */
  nextStage: QualityRun["stage"];
  /** 失败原因（如果 failed）。 */
  failureReason?: string | undefined;
  /** 使用的 fixer sessionId。 */
  fixerSessionId: string;
  /** 是否使用了隔离 worktree。 */
  usedWorktree: boolean;
  /** worktree 信息（如果使用了）。 */
  worktreeInfo?: WorktreeInfo | undefined;
  /** 是否需要审批（高风险或 protectedPaths）。 */
  requiresApproval?: boolean | undefined;
};

export class FixerOrchestrator {
  private readonly service: QualityService;
  private readonly permissionManager: RunPermissionManager;
  private readonly sessionRunner: FixerSessionRunner;
  private readonly gateEngine: GateEngine;
  private readonly artifactDir: string;
  private readonly fixTimeoutMs: number;
  private readonly collectChangeSetFn: typeof collectChangeSet;
  private readonly collectBaselineFn: typeof collectBaseline;
  private readonly createWorktreeFn: typeof createWorktree;
  private readonly removeWorktreeFn: typeof removeWorktree;
  private readonly requireIsolatedWorktree: boolean;
  /** runId → fixerSessionId 缓存（复用 session） */
  private readonly fixerSessions = new Map<string, string>();
  /** runId → WorktreeInfo 缓存（崩溃恢复用） */
  private readonly worktrees = new Map<string, WorktreeInfo>();

  constructor(
    service: QualityService,
    permissionManager: RunPermissionManager,
    sessionRunner: FixerSessionRunner,
    gateEngine: GateEngine,
    opts: FixerOrchestratorOptions,
  ) {
    this.service = service;
    this.permissionManager = permissionManager;
    this.sessionRunner = sessionRunner;
    this.gateEngine = gateEngine;
    this.artifactDir = opts.artifactDir;
    this.fixTimeoutMs = opts.fixTimeoutMs ?? 300_000;
    this.collectChangeSetFn = opts.collectChangeSetFn ?? collectChangeSet;
    this.collectBaselineFn = opts.collectBaselineFn ?? collectBaseline;
    this.createWorktreeFn = opts.createWorktreeFn ?? createWorktree;
    this.removeWorktreeFn = opts.removeWorktreeFn ?? removeWorktree;
    this.requireIsolatedWorktree = opts.requireIsolatedWorktree ?? true;
  }

  /**
   * 执行 fix 流程。当 run 处于 fixing 阶段时调用。
   * 返回 FixResult，包含 fixed、patchHash、quickGate、nextStage。
   *
   * Phase 6 硬化：
   * - 检查 fix 预算（maxFixRounds）
   * - 在隔离 worktree 中运行（如果项目支持）
   * - 创建回滚点
   * - 修复后清除旧证据（check/finding/review decision/requirement verification）
   * - 高风险或 protectedPaths 需要审批
   */
  async runFix(runId: string): Promise<FixResult> {
    const run = this.service.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.stage !== "fixing") {
      throw new Error(`run ${runId} not in fixing stage (stage=${run.stage})`);
    }

    const project = this.service.getProject(run.projectId);
    if (!project) throw new Error(`unknown project: ${run.projectId}`);

    const { policy } = this.service.getPolicy(project.id);

    // 0. 检查 fix 预算
    if (run.fixRound > run.budget.maxFixRounds) {
      logWarn("fixer", `run ${runId} exceeded maxFixRounds (${run.fixRound}/${run.budget.maxFixRounds}), failing`);
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        fixed: false,
        patchHash: run.patchHash ?? "",
        nextStage: failed.stage,
        failureReason: `exceeded maxFixRounds (${run.fixRound}/${run.budget.maxFixRounds})`,
        fixerSessionId: "",
        usedWorktree: false,
      };
    }

    // 1. 读取 open blocking findings，从 suggestion 构造修复指令
    const findings = this.service.listFindings(runId);
    const fixable = findings.filter(
      (f) => f.blocking && f.status === "open" && f.suggestion && f.suggestion.trim().length > 0,
    );

    if (fixable.length === 0) {
      logWarn("fixer", `run ${runId} has no fixable findings (open+blocking+suggestion), failing`);
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        fixed: false,
        patchHash: run.patchHash ?? "",
        nextStage: failed.stage,
        failureReason: "no fixable findings with suggestions",
        fixerSessionId: "",
        usedWorktree: false,
      };
    }

    // 2. 检查是否需要审批（高风险或 protectedPaths）
    const enforcementMode = getPolicyEnforcement(policy);
    const approvalRiskThreshold = getPolicyApprovalRisk(policy);
    const changeSetFiles = this.getChangeSetFiles(runId, project, policy);
    const needsApproval = requiresApproval(
      run.risk,
      approvalRiskThreshold,
      changeSetFiles,
      policy.protectedPaths,
    );
    if (needsApproval && enforcementMode === "require-approval") {
      logWarn("fixer", `run ${runId} requires approval (risk=${run.risk} or protectedPaths)`);
      const next = this.service.advance(runId, "awaiting-approval");
      return {
        runId,
        fixed: false,
        patchHash: run.patchHash ?? "",
        nextStage: next.stage,
        failureReason: "requires approval (high risk or protectedPaths)",
        fixerSessionId: "",
        usedWorktree: false,
        requiresApproval: true,
      };
    }

    // 3. 创建隔离 worktree（如果项目支持且要求）
    let worktreeInfo: WorktreeInfo | undefined;
    let usedWorktree = false;
    if (this.requireIsolatedWorktree && canCreateWorktree(project)) {
      const wtResult = this.createWorktreeFn(project, { runId, baseRevision: run.baseRevision });
      if ("error" in wtResult) {
        logWarn("fixer", `worktree creation failed for run ${runId}: ${wtResult.error.message}`);
        // worktree 创建失败不阻断，降级到主工作区
      } else {
        worktreeInfo = wtResult;
        usedWorktree = true;
        this.worktrees.set(runId, worktreeInfo);
      }
    }

    // 4. 构造修复 prompt
    const prompt = buildFixerPrompt(run, fixable, policy);

    // 5. 创建/复用 fixer session
    const existingSessionId = run.implementerSessionId ?? this.fixerSessions.get(runId);
    let fixerSessionId: string;
    try {
      fixerSessionId = await this.sessionRunner.ensureSession({
        project,
        run,
        ...(existingSessionId !== undefined ? { existingSessionId } : {}),
      });
    } catch (err) {
      logWarn("fixer", `fixer session creation failed for run ${runId}: ${String(err)}`);
      this.cleanupWorktree(runId, project);
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        fixed: false,
        patchHash: run.patchHash ?? "",
        nextStage: failed.stage,
        failureReason: `fixer session creation failed: ${String(err)}`,
        fixerSessionId: "",
        usedWorktree,
        ...(worktreeInfo !== undefined ? { worktreeInfo } : {}),
      };
    }
    // 绑定 fixer 角色（implementer 权限，受 protectedPaths/riskRules 限制）
    this.permissionManager.bindSession(fixerSessionId, runId, "fixer");
    this.fixerSessions.set(runId, fixerSessionId);

    // 6. 调用 fixer，等待完整输出
    try {
      await this.sessionRunner.promptOnce(fixerSessionId, prompt, this.fixTimeoutMs);
    } catch (err) {
      logWarn("fixer", `fixer prompt failed for run ${runId}: ${String(err)}`);
      this.cleanupWorktree(runId, project);
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        fixed: false,
        patchHash: run.patchHash ?? "",
        nextStage: failed.stage,
        failureReason: `fixer prompt failed: ${String(err)}`,
        fixerSessionId,
        usedWorktree,
        ...(worktreeInfo !== undefined ? { worktreeInfo } : {}),
      };
    }

    // 7. 清除旧证据（check/finding/review decision/requirement verification）
    this.service.clearRunEvidence(runId);

    // 8. 推进 fixing → collecting（状态机自动清除旧 patchHash，fixRound 已在进入 fixing 时递增）
    const collectingRun = this.service.advance(runId, "collecting");

    // 9. 收集新 ChangeSet（从 worktree 收集，如果使用了隔离 worktree）
    const baseline = this.collectBaselineFn(project);
    const newChangeSet = this.collectChangeSetFn(
      runId,
      project,
      baseline,
      {
        protectedPaths: policy.protectedPaths,
        riskRules: policy.riskRules,
      },
      this.artifactDir,
      worktreeInfo?.path,
    );

    // 10. 持久化新 patchHash 到 run
    this.service.saveRun({ ...collectingRun, patchHash: newChangeSet.patchHash });

    // 11. 推进 collecting → quick-verifying
    this.service.advance(runId, "quick-verifying");

    // 12. 运行 quick gate（attempt = fixRound + 1，确保不复用旧 check 结果）
    const attempt = collectingRun.fixRound + 1;
    let quickGate: GateResult;
    try {
      quickGate = await this.gateEngine.runGate(
        project,
        policy,
        "quick",
        runId,
        newChangeSet,
        attempt,
      );
    } catch (err) {
      logWarn("fixer", `quick gate failed for run ${runId}: ${String(err)}`);
      this.cleanupWorktree(runId, project);
      const failed = this.service.advance(runId, "failed");
      return {
        runId,
        fixed: false,
        patchHash: newChangeSet.patchHash,
        nextStage: failed.stage,
        failureReason: `quick gate execution failed: ${String(err)}`,
        fixerSessionId,
        usedWorktree,
        ...(worktreeInfo !== undefined ? { worktreeInfo } : {}),
      };
    }

    // 13. 按 quick gate 结果推进
    const nextStage = this.advanceAfterGate(runId, quickGate, collectingRun, policy);

    // 14. 清理 worktree（如果 gate 通过或进入终态）
    if (nextStage === "reviewing" || nextStage === "full-verifying" || nextStage === "failed" || nextStage === "accepted") {
      this.cleanupWorktree(runId, project);
    }

    return {
      runId,
      fixed: nextStage === "reviewing" || nextStage === "full-verifying",
      patchHash: newChangeSet.patchHash,
      quickGate,
      nextStage,
      fixerSessionId,
      usedWorktree,
      ...(worktreeInfo !== undefined ? { worktreeInfo } : {}),
    };
  }

  /** 获取 run 的变更文件列表（用于审批判断）。 */
  private getChangeSetFiles(runId: string, project: ProjectScope, policy: QualityPolicy): string[] {
    try {
      const baseline = this.collectBaselineFn(project);
      const changeSet = this.collectChangeSetFn(runId, project, baseline, {
        protectedPaths: policy.protectedPaths,
        riskRules: policy.riskRules,
      }, this.artifactDir);
      return changeSet.files.map((f) => f.path);
    } catch {
      return [];
    }
  }

  /** 清理 run 的 worktree。 */
  private cleanupWorktree(runId: string, project: ProjectScope): void {
    const worktreeInfo = this.worktrees.get(runId);
    if (!worktreeInfo) return;
    const result = this.removeWorktreeFn(project, worktreeInfo.path);
    if ("error" in result) {
      logWarn("fixer", `worktree cleanup failed for run ${runId}: ${result.error.message}`);
    } else {
      this.worktrees.delete(runId);
    }
  }

  /**
   * quick gate 完成后推进 run 状态。
   * - passed → reviewing（重新审查修复后的代码）
   * - codeFailed → fixing（如果未超过 maxFixRounds）或 failed（超过预算）
   * - infraFailed → failed（基础设施问题不视为代码缺陷，但无法继续）
   * - cancelled → failed
   */
  private advanceAfterGate(
    runId: string,
    gate: GateResult,
    run: QualityRun,
    _policy: QualityPolicy,
  ): QualityRun["stage"] {
    if (gate.passed) {
      // quick gate 通过 → 回到 reviewing 重新审查
      const next = this.service.advance(runId, "reviewing");
      return next.stage;
    }

    if (gate.infraFailed || gate.cancelled) {
      logWarn("fixer", `run ${runId} quick gate infra-failed/cancelled, failing`);
      const next = this.service.advance(runId, "failed");
      return next.stage;
    }

    // codeFailed：检查是否还有 fix 预算
    // fixRound 已在进入 fixing 时递增，当前 run.fixRound 是本轮修复的轮次
    if (run.fixRound >= run.budget.maxFixRounds) {
      logWarn(
        "fixer",
        `run ${runId} exceeded maxFixRounds (${run.fixRound}/${run.budget.maxFixRounds}), failing after quick gate`,
      );
      const next = this.service.advance(runId, "failed");
      return next.stage;
    }

    // 还有预算 → 进入下一轮 fixing
    const next = this.service.advance(runId, "fixing");
    return next.stage;
  }

  /** 清理 run 的 fixer session 绑定和 worktree。 */
  cleanupRun(runId: string): void {
    const sessionId = this.fixerSessions.get(runId);
    if (sessionId) {
      this.permissionManager.unbindSession(sessionId);
      this.fixerSessions.delete(runId);
    }
    const project = this.service.getProject(this.service.getRun(runId)?.projectId ?? "");
    if (project) {
      this.cleanupWorktree(runId, project);
    } else {
      this.worktrees.delete(runId);
    }
  }

  /** 获取所有活跃的 worktree（崩溃恢复用）。 */
  getActiveWorktrees(): Map<string, WorktreeInfo> {
    return new Map(this.worktrees);
  }

  /** 清理所有残留 worktree（Hub 重启恢复时调用）。 */
  cleanupAllWorktrees(project: ProjectScope): void {
    for (const [runId] of this.worktrees) {
      this.cleanupWorktree(runId, project);
    }
  }
}

/**
 * 构造 fixer prompt（从 review findings 的 suggestion 生成修复指令）。
 *
 * 设计文档 §10.4 要求：
 * - 明确告知 fixer 只能修改候选工作区，不能修改 protectedPaths；
 * - 列出每个 finding 的 claim、evidence、suggestion；
 * - 要求 fixer 完成后不要自行声明完成，由 gate 验证。
 */
export function buildFixerPrompt(
  run: QualityRun,
  findings: ReviewFinding[],
  policy: QualityPolicy,
): string {
  const lines: string[] = [];

  lines.push("你是修复执行者（fixer）。你可以在项目工作区内修改文件，但受以下限制：");
  lines.push("- 不能修改 protectedPaths 中的文件（需要人工审批）。");
  lines.push("- 必须遵守 riskRules 中的风险约束。");
  lines.push("- 完成修复后不要自行声明完成，系统会自动运行验证。");
  lines.push("");
  lines.push("## 任务上下文");
  lines.push(`- runId: ${run.id}`);
  lines.push(`- projectId: ${run.projectId}`);
  lines.push(`- fix round: ${run.fixRound}`);
  lines.push(`- risk: ${run.risk}`);
  lines.push("");

  if (policy.protectedPaths.length > 0) {
    lines.push("## 受保护路径（禁止修改）");
    for (const p of policy.protectedPaths) lines.push(`- ${p}`);
    lines.push("");
  }

  if (policy.riskRules.length > 0) {
    lines.push("## 风险规则");
    for (const r of policy.riskRules) {
      lines.push(`- [${r.risk}] ${r.pattern}: ${r.reason}`);
    }
    lines.push("");
  }

  lines.push("## 需要修复的问题");
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    lines.push(`### ${i + 1}. [${f.severity}] ${f.claim}`);
    if (f.file) {
      lines.push(`- 文件: ${f.file}${f.line !== undefined ? `:${f.line}` : ""}`);
    }
    lines.push(`- 证据: ${f.evidence}`);
    if (f.reproduction) lines.push(`- 复现: ${f.reproduction}`);
    lines.push(`- 修复建议: ${f.suggestion}`);
    lines.push("");
  }

  lines.push("## 修复要求");
  lines.push("1. 只修复上述问题，不要引入新问题或重构无关代码。");
  lines.push("2. 不要修改受保护路径。");
  lines.push("3. 修复后确保代码能通过项目的 quick 检查（类型检查等）。");
  lines.push("4. 不要提交 git commit。");

  return lines.join("\n");
}
