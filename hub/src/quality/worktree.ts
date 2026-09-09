import * as fs from "node:fs";
import * as path from "node:path";
import spawn from "cross-spawn";
import type { ProjectScope } from "./types.js";

/**
 * 隔离 worktree 管理（Phase 6 §10.6）。
 *
 * fixer 在隔离 worktree 中运行，避免污染主工作区：
 * - 创建 worktree：git worktree add <path> <base>
 * - 创建回滚点：git stash create 或 git commit
 * - 清理 worktree：git worktree remove
 * - 崩溃恢复：Hub 重启时清理残留 worktree
 */

export type WorktreeInfo = {
  path: string;
  baseRevision: string;
  rollbackPoint: string | null;
  createdAt: number;
};

export type WorktreeCreateOptions = {
  runId: string;
  baseRevision?: string | undefined;
};

export type WorktreeError = {
  code: "not-git" | "worktree-failed" | "stash-failed" | "cleanup-failed";
  message: string;
};

function gitSync(gitRoot: string, args: string[]): { stdout: string; status: number } {
  const res = spawn.sync("git", args, { cwd: gitRoot, encoding: "utf-8" });
  return { stdout: (res.stdout as string).trim(), status: res.status ?? -1 };
}

function git(gitRoot: string, args: string[]): string {
  const { stdout, status } = gitSync(gitRoot, args);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${status})`);
  return stdout;
}

/** 判断项目是否支持 worktree。 */
export function canCreateWorktree(project: ProjectScope): boolean {
  if (!project.capabilities.git) return false;
  if (!project.capabilities.isolatedWorktree) return false;
  const root = project.gitRoot ?? project.root;
  try {
    gitSync(root, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** 获取当前 HEAD revision。 */
export function getHeadRevision(gitRoot: string): string {
  return git(gitRoot, ["rev-parse", "HEAD"]);
}

/** 创建回滚点（stash 或 commit）。 */
export function createRollbackPoint(gitRoot: string): string | null {
  // 尝试 stash create（不修改工作区）
  try {
    const stashHash = git(gitRoot, ["stash", "create"]);
    if (stashHash) {
      // stash create 返回 hash 但不实际 stash，需要 stash store 保存
      git(gitRoot, ["stash", "store", "-m", "quality-rollback", stashHash]);
      return stashHash;
    }
  } catch {
    // 无 dirty 变更时 stash create 返回空，这是正常的
  }
  return null;
}

/** 创建隔离 worktree。 */
export function createWorktree(
  project: ProjectScope,
  opts: WorktreeCreateOptions,
): WorktreeInfo | { error: WorktreeError } {
  const root = project.gitRoot ?? project.root;
  if (!project.capabilities.git) {
    return { error: { code: "not-git", message: "project is not a git repo" } };
  }

  let baseRevision: string;
  try {
    baseRevision = opts.baseRevision ?? getHeadRevision(root);
  } catch (err) {
    return { error: { code: "worktree-failed", message: `failed to get HEAD revision: ${String(err)}` } };
  }

  const worktreePath = path.join(root, ".quality-worktrees", opts.runId);
  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(root, ["worktree", "add", "--detach", worktreePath, baseRevision]);
  } catch (err) {
    return { error: { code: "worktree-failed", message: `git worktree add failed: ${String(err)}` } };
  }

  let rollbackPoint: string | null = null;
  try {
    rollbackPoint = createRollbackPoint(root);
  } catch (err) {
    // 回滚点创建失败不阻断，但记录
    rollbackPoint = null;
  }

  return {
    path: worktreePath,
    baseRevision,
    rollbackPoint,
    createdAt: Date.now(),
  };
}

/** 清理隔离 worktree。 */
export function removeWorktree(
  project: ProjectScope,
  worktreePath: string,
): { ok: true } | { error: WorktreeError } {
  const root = project.gitRoot ?? project.root;
  try {
    gitSync(root, ["worktree", "remove", "--force", worktreePath]);
    // 清理空目录
    try { fs.rmdirSync(path.dirname(worktreePath)); } catch { /* */ }
    return { ok: true };
  } catch (err) {
    return { error: { code: "cleanup-failed", message: `git worktree remove failed: ${String(err)}` } };
  }
}

/** 回滚到回滚点。 */
export function rollbackTo(
  project: ProjectScope,
  rollbackPoint: string,
): { ok: true } | { error: WorktreeError } {
  const root = project.gitRoot ?? project.root;
  try {
    git(root, ["stash", "apply", rollbackPoint]);
    return { ok: true };
  } catch (err) {
    return { error: { code: "stash-failed", message: `git stash apply failed: ${String(err)}` } };
  }
}

/** 列出所有残留的 quality worktree（用于崩溃恢复）。 */
export function listStaleWorktrees(project: ProjectScope): string[] {
  const root = project.gitRoot ?? project.root;
  const worktreeDir = path.join(root, ".quality-worktrees");
  if (!fs.existsSync(worktreeDir)) return [];
  try {
    return fs.readdirSync(worktreeDir)
      .filter((name) => fs.statSync(path.join(worktreeDir, name)).isDirectory())
      .map((name) => path.join(worktreeDir, name));
  } catch {
    return [];
  }
}

/** 清理所有残留 worktree（Hub 重启恢复时调用）。 */
export function cleanupStaleWorktrees(project: ProjectScope): { cleaned: string[]; failed: string[] } {
  const stale = listStaleWorktrees(project);
  const cleaned: string[] = [];
  const failed: string[] = [];
  for (const wt of stale) {
    const result = removeWorktree(project, wt);
    if ("ok" in result) cleaned.push(wt);
    else failed.push(wt);
  }
  return { cleaned, failed };
}

/** 判断 run 是否需要审批（高风险或涉及 protectedPaths）。 */
export function requiresApproval(
  risk: "low" | "medium" | "high" | "critical",
  approvalRiskThreshold: "high" | "critical",
  changeSetFiles: string[],
  protectedPaths: string[],
): boolean {
  const riskOrder = ["low", "medium", "high", "critical"];
  const riskIdx = riskOrder.indexOf(risk);
  const thresholdIdx = riskOrder.indexOf(approvalRiskThreshold);
  if (riskIdx >= thresholdIdx) return true;
  for (const file of changeSetFiles) {
    for (const pp of protectedPaths) {
      if (matchPath(file, pp)) return true;
    }
  }
  return false;
}

function matchPath(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}
