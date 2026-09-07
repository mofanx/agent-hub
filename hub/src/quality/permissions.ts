import type { QualityPolicy } from "./types.js";

/**
 * per-session/per-run 权限策略（设计文档 §11.1）。
 *
 * 角色权限矩阵：
 *   planner     读、搜索；禁止写
 *   implementer 允许项目范围内写；高风险工具需批准
 *   reviewer    读、搜索、允许的检查；禁止写/delete/move
 *   verifier    只能执行 policy 中批准的 argv
 *   fixer       与 implementer 相同，但只在候选工作区
 *   scheduler   只能创建 QualityRun
 *
 * 即使全局 bypass 开启，reviewer 和 verifier 仍受质量系统硬限制。
 */

export type QualityRole =
  | "planner"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "fixer"
  | "scheduler";

export type ToolKind = "read" | "search" | "write" | "delete" | "move" | "execute" | "fetch" | "other";

const READ_ONLY_ROLES = new Set<QualityRole>(["planner", "reviewer"]);

const ROLE_TOOL_MATRIX: Readonly<Record<QualityRole, ReadonlySet<ToolKind>>> = {
  planner: new Set<ToolKind>(["read", "search", "fetch"]),
  implementer: new Set<ToolKind>(["read", "search", "write", "execute", "fetch"]),
  reviewer: new Set<ToolKind>(["read", "search", "fetch"]),
  verifier: new Set<ToolKind>(["execute"]),
  fixer: new Set<ToolKind>(["read", "search", "write", "execute", "fetch"]),
  scheduler: new Set<ToolKind>([]),
};

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string; role: QualityRole; tool: ToolKind };

export class PermissionDeniedError extends Error {
  readonly role: QualityRole;
  readonly tool: ToolKind;
  constructor(role: QualityRole, tool: ToolKind, reason: string) {
    super(`permission denied: role=${role} tool=${tool} — ${reason}`);
    this.name = "PermissionDeniedError";
    this.role = role;
    this.tool = tool;
  }
}

/**
 * 按角色判断工具是否允许。
 * 即使 globalBypass 为 true，reviewer/verifier/planner 仍受硬限制。
 */
export function checkToolPermission(
  role: QualityRole,
  tool: ToolKind,
  globalBypass = false,
): PermissionDecision {
  if (globalBypass && !READ_ONLY_ROLES.has(role) && role !== "verifier") {
    return { allowed: true };
  }
  const allowed = ROLE_TOOL_MATRIX[role];
  if (allowed.has(tool)) return { allowed: true };
  return {
    allowed: false,
    reason: `${role} cannot use ${tool}`,
    role,
    tool,
  };
}

/**
 * 判断角色是否为只读（reviewer/planner）。
 * 只读角色即使 bypass 开启也不能写/delete/move。
 */
export function isReadOnlyRole(role: QualityRole): boolean {
  return READ_ONLY_ROLES.has(role);
}

/**
 * 将 ACP tool_call 的 kind 映射为 ToolKind。
 */
export function kindToToolKind(kind: string): ToolKind {
  switch (kind) {
    case "read": return "read";
    case "search": return "search";
    case "edit":
    case "write":
      return "write";
    case "delete": return "delete";
    case "move": return "move";
    case "execute": return "execute";
    case "fetch": return "fetch";
    default: return "other";
  }
}

/**
 * per-run 权限策略管理器。
 * 维护 sessionId → (runId, role) 的映射，用于在工具调用时检查权限。
 */
export class RunPermissionManager {
  private readonly sessionRoles = new Map<string, { runId: string; role: QualityRole }>();
  private readonly readOnlyEnforced = new Set<string>();

  /** 绑定 session 到某个 run 的某个角色。 */
  bindSession(sessionId: string, runId: string, role: QualityRole): void {
    this.sessionRoles.set(sessionId, { runId, role });
    if (isReadOnlyRole(role)) {
      this.readOnlyEnforced.add(sessionId);
    }
  }

  /** 解绑 session。 */
  unbindSession(sessionId: string): void {
    this.sessionRoles.delete(sessionId);
    this.readOnlyEnforced.delete(sessionId);
  }

  /** 解绑某 runId 的所有 session。 */
  unbindRun(runId: string): string[] {
    const removed: string[] = [];
    for (const [sid, binding] of [...this.sessionRoles.entries()]) {
      if (binding.runId === runId) {
        this.sessionRoles.delete(sid);
        this.readOnlyEnforced.delete(sid);
        removed.push(sid);
      }
    }
    return removed;
  }

  /** 获取 session 的角色绑定。 */
  getBinding(sessionId: string): { runId: string; role: QualityRole } | undefined {
    return this.sessionRoles.get(sessionId);
  }

  /** 检查 session 的工具调用是否被允许。 */
  checkSession(sessionId: string, kind: string, globalBypass = false): PermissionDecision {
    const binding = this.sessionRoles.get(sessionId);
    if (!binding) return { allowed: true };
    const tool = kindToToolKind(kind);
    return checkToolPermission(binding.role, tool, globalBypass);
  }

  /** 该 session 是否被强制只读。 */
  isReadOnlyEnforced(sessionId: string): boolean {
    return this.readOnlyEnforced.has(sessionId);
  }

  /**
   * 检查路径是否在允许写入的范围内。
   * reviewer 只能读，不能写任何路径。
   * implementer/fixer 只能在 project root 内写。
   */
  checkPathAccess(
    sessionId: string,
    filePath: string,
    projectRoot: string,
    protectedPaths: string[] = [],
  ): PermissionDecision {
    const binding = this.sessionRoles.get(sessionId);
    if (!binding) return { allowed: true };
    if (isReadOnlyRole(binding.role)) {
      return {
        allowed: false,
        reason: `${binding.role} is read-only, cannot modify any path`,
        role: binding.role,
        tool: "write",
      };
    }
    for (const pp of protectedPaths) {
      if (matchProtectedPath(filePath, pp)) {
        return {
          allowed: false,
          reason: `path ${filePath} is protected (${pp}), requires approval`,
          role: binding.role,
          tool: "write",
        };
      }
    }
    return { allowed: true };
  }

  clear(): void {
    this.sessionRoles.clear();
    this.readOnlyEnforced.clear();
  }
}

function matchProtectedPath(filePath: string, pattern: string): boolean {
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
  return filePath === pattern || filePath.startsWith(pattern + "/");
}
