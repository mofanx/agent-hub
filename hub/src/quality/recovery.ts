import type { CheckRun, ProjectScope, QualityRun } from "./types.js";
import { isTerminal, transition } from "./run.js";
import type { Store } from "../store.js";
import { cleanupStaleWorktrees } from "./worktree.js";

/**
 * CheckRun 持久化与重启恢复（设计文档 §6 / §12）。
 *
 * 硬约束：Hub 重启时 implementing/running check 回到可判定状态，不直接标记通过。
 *
 * 恢复策略：
 * - 遍历所有非终态 QualityRun；
 * - 将其名下 status=running/queued 的 CheckRun 标记为 infra-failed（不产生假通过）；
 * - 将 run 推进到 inconclusive（failureCode="hub-restart"），queued 状态转 cancelled；
 * - 持久化更新后的 run 和 check；
 * - 返回恢复摘要，供 report 模式继续闭环或严格模式人工重试。
 */

export const FAILURE_HUB_RESTART = "hub-restart";

export type RecoverySummary = {
  runs: QualityRun[];
  checks: CheckRun[];
  worktreesCleaned: string[];
  worktreesFailed: string[];
};

/** 将单个 CheckRun 标记为 infra-failed（重启时）。 */
export function markCheckInfraFailed(check: CheckRun, now = Date.now()): CheckRun {
  return {
    ...check,
    status: "infra-failed",
    completedAt: now,
    ...(check.startedAt !== undefined ? {} : { startedAt: now }),
    summary: check.summary ?? "interrupted by hub restart",
  };
}

/**
 * 对单个 run 执行恢复：标记其运行中 check，并推进 run 到终态。
 * 返回更新后的 run 和被修改的 check 列表。不写存储。
 *
 * stale 判定：仅当 run.generation < currentGeneration（WorkItem 当前 generation）时，
 * 才标记为 stale；如果 run.generation === currentGeneration，说明是当前 generation 的 run，
 * 应标记为 inconclusive 而非 stale。
 */
export function recoverRun(
  run: QualityRun,
  checks: CheckRun[],
  now = Date.now(),
  currentGeneration?: number,
): { run: QualityRun; checks: CheckRun[] } {
  if (isTerminal(run.stage)) return { run, checks: [] };
  const updatedChecks = checks
    .filter((c) => c.status === "running" || c.status === "queued")
    .map((c) => markCheckInfraFailed(c, now));

  let nextRun = run;
  if (run.stage === "queued") {
    nextRun = transition(run, "cancelled");
  } else if (
    run.generation !== undefined &&
    run.generation > 0 &&
    currentGeneration !== undefined &&
    run.generation < currentGeneration
  ) {
    // stale generation：旧 generation 的 run 标记为 stale
    nextRun = { ...run, stage: "stale", updatedAt: now, completedAt: now, outcome: "inconclusive" };
  } else {
    nextRun = transition(run, "inconclusive");
    nextRun = { ...nextRun, failureCode: FAILURE_HUB_RESTART };
  }
  return { run: nextRun, checks: updatedChecks };
}

/**
 * 扫描整个 store，恢复所有被 Hub 重启中断的 run/check 并持久化。
 * 返回恢复摘要。
 *
 * 处理 stale generation：如果 run 有 generation 字段且 > 0，
 * 说明是旧 generation 的 run，标记为 stale 而非 failed。
 */
export function recoverInterruptedRuns(store: Store, projects: ProjectScope[] = []): RecoverySummary {
  const now = Date.now();
  const recoveredRuns: QualityRun[] = [];
  const recoveredChecks: CheckRun[] = [];
  const worktreesCleaned: string[] = [];
  const worktreesFailed: string[] = [];

  // 清理残留 worktree
  for (const project of projects) {
    if (project.capabilities.git && project.capabilities.isolatedWorktree) {
      const result = cleanupStaleWorktrees(project);
      worktreesCleaned.push(...result.cleaned);
      worktreesFailed.push(...result.failed);
    }
  }

  const nonTerminalStages = [
    "queued",
    "preflight",
    "implementing",
    "collecting",
    "quick-verifying",
    "reviewing",
    "fixing",
    "full-verifying",
    "requirement-verifying",
    "awaiting-approval",
  ];

  for (const stage of nonTerminalStages) {
    const runs = store.listQualityRunsByStage(stage);
    for (const run of runs) {
      const checks = store.listQualityChecks(run.id);
      const workItem = run.workItemId !== undefined ? store.getWorkItem(run.workItemId) : undefined;
      const currentGeneration = workItem?.currentGeneration;
      const { run: nextRun, checks: nextChecks } = recoverRun(run, checks, now, currentGeneration);
      store.saveQualityRun(nextRun);
      for (const c of nextChecks) store.saveQualityCheck(c);
      recoveredRuns.push(nextRun);
      recoveredChecks.push(...nextChecks);
    }
  }

  return { runs: recoveredRuns, checks: recoveredChecks, worktreesCleaned, worktreesFailed };
}

/** 判断某 run 是否因 hub 重启而失败（可重试）。 */
export function isHubRestartFailure(run: QualityRun): boolean {
  return run.failureCode === FAILURE_HUB_RESTART;
}
