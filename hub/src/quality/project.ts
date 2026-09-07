import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectScope } from "./types.js";

/**
 * ProjectRegistry（设计文档 §4.1 / §2.4 / §5.1）。
 *
 * projectId = sha256(connectionId + ":" + canonical(gitRoot || root))，截取前 32 hex。
 * 必须包含 connectionId，避免不同机器上同路径被误判为同一项目。
 */

export class PathEscapeError extends Error {
  readonly child: string;
  readonly parent: string;
  constructor(parent: string, child: string) {
    super(`path escape: "${child}" is not inside "${parent}"`);
    this.name = "PathEscapeError";
    this.child = child;
    this.parent = parent;
  }
}

/** 规范化绝对路径：realpath，失败时回退到 path.resolve。 */
export function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 判断 child 是否在 parent 目录内（两者需已规范化）。 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 校验 child 在 parent 内或等于 parent，否则抛 PathEscapeError。 */
export function assertInside(parent: string, child: string): void {
  if (child === parent) return;
  if (!isPathInside(parent, child)) throw new PathEscapeError(parent, child);
}

/** 生成稳定 projectId：sha256(connectionId:canonicalRoot) 前 32 hex。 */
export function projectId(connectionId: string, root: string): string {
  const canonical = canonicalize(root);
  return crypto
    .createHash("sha256")
    .update(`${connectionId}:${canonical}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * 从 root 向上查找 .git 目录，返回 gitRoot（含 .git 的目录）。
 * 非 git 仓库返回 undefined。
 */
export function detectGitRoot(root: string): string | undefined {
  const canonical = canonicalize(root);
  let dir = canonical;
  for (let i = 0; i < 64; i++) {
    const gitDir = path.join(dir, ".git");
    try {
      if (fs.statSync(gitDir).isDirectory() || fs.statSync(gitDir).isFile()) return dir;
    } catch {
      // not found, walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export type RegisterOptions = {
  connectionId: string;
  root: string;
  displayName?: string | undefined;
  /** 是否允许本地执行（Hub 所在机器）。默认 true。 */
  localExec?: boolean | undefined;
  /** 是否可远程执行（worker 拥有该目录）。默认 false。 */
  remoteExec?: boolean | undefined;
  /** 是否支持隔离 worktree。默认 false。 */
  isolatedWorktree?: boolean | undefined;
  /** 已知 policy 版本。 */
  policyVersion?: string | undefined;
};

/**
 * 注册/刷新项目，返回 ProjectScope。不写存储，由调用方持久化。
 * capabilities.git 由 detectGitRoot 决定。
 */
export function registerProject(opts: RegisterOptions): ProjectScope {
  const root = canonicalize(opts.root);
  const gitRoot = detectGitRoot(root);
  const id = projectId(opts.connectionId, root);
  const now = Date.now();
  const scope: ProjectScope = {
    id,
    connectionId: opts.connectionId,
    root,
    displayName: opts.displayName ?? (path.basename(root) || root),
    capabilities: {
      git: gitRoot !== undefined,
      localExec: opts.localExec ?? true,
      remoteExec: opts.remoteExec ?? false,
      isolatedWorktree: opts.isolatedWorktree ?? false,
    },
    createdAt: now,
    updatedAt: now,
  };
  if (gitRoot !== undefined) scope.gitRoot = gitRoot;
  if (opts.policyVersion !== undefined) scope.policyVersion = opts.policyVersion;
  return scope;
}

/**
 * 校验某个 cwd 相对 ProjectScope 是否合法：
 * - cwd 必须在 scope.root 内（或等于 gitRoot 内）；
 * - 解析为 realpath 后再判断，防止符号链接逃逸。
 */
export function validateCwd(scope: ProjectScope, cwd: string): string {
  const canonicalCwd = canonicalize(cwd);
  const base = scope.gitRoot ?? scope.root;
  assertInside(base, canonicalCwd);
  return canonicalCwd;
}
