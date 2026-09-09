import type { RunContextRegistry } from "./run-context.js";

/**
 * DirtyTracker：文件/tool/git 信号只 markDirty，prompt/task 完成后才 collect。
 *
 * 设计目标：
 * - agent 写文件时，只标记 session 为 dirty，不立即触发 gate
 * - prompt.done 或 task 完成后，才检查 dirty 标记并触发 collect → gate
 * - 避免 race condition（agent 还在写，gate 就开始收集）
 * - 支持跨模式：单聊、mention、roundrobin、parallel、pipeline、debate、self、conductor
 *
 * 信号类型：
 * - file: agent 写/删/移动文件
 * - tool: agent 执行 edit/delete/move 命令
 * - git: git 状态变化（未来扩展）
 */

export type DirtySignal = "file" | "tool" | "git";

export type DirtyEntry = {
  sessionId: string;
  signals: Set<DirtySignal>;
  paths: Set<string>;
  markedAt: number;
};

/**
 * 跟踪 session 的 dirty 信号。
 * 纯内存存储，Hub 重启后自动清除（run 状态由持久化层恢复）。
 */
export class DirtyTracker {
  private readonly dirty = new Map<string, DirtyEntry>();

  /** 标记 session 为 dirty（文件/tool/git 信号）。 */
  markDirty(sessionId: string, signal: DirtySignal, paths: string[] = []): void {
    let entry = this.dirty.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        signals: new Set(),
        paths: new Set(),
        markedAt: Date.now(),
      };
      this.dirty.set(sessionId, entry);
    }
    entry.signals.add(signal);
    for (const p of paths) entry.paths.add(p);
    entry.markedAt = Date.now();
  }

  /** 检查 session 是否有 dirty 信号。 */
  isDirty(sessionId: string): boolean {
    return this.dirty.has(sessionId);
  }

  /** 获取 session 的 dirty 条目（含路径列表，用于 collect）。 */
  getDirty(sessionId: string): DirtyEntry | undefined {
    return this.dirty.get(sessionId);
  }

  /** 获取所有 dirty session 的 sessionId。 */
  dirtySessionIds(): string[] {
    return [...this.dirty.keys()];
  }

  /** 清除 session 的 dirty 标记（collect 完成后调用）。 */
  clearDirty(sessionId: string): DirtyEntry | undefined {
    const entry = this.dirty.get(sessionId);
    this.dirty.delete(sessionId);
    return entry;
  }

  /** 清除所有 dirty 标记。 */
  clear(): void {
    this.dirty.clear();
  }

  /**
   * 为给定 session 收集 dirty 路径，并清除标记。
   * 返回路径列表（用于 findProjectForPaths 和 collectChangeSet）。
   */
  collectPaths(sessionId: string): string[] {
    const entry = this.dirty.get(sessionId);
    if (!entry) return [];
    const paths = [...entry.paths];
    this.dirty.delete(sessionId);
    return paths;
  }

  /**
   * 批量检查多个 session 是否有 dirty 信号。
   * 用于群聊模式（roundrobin/parallel/pipeline）中检查所有成员。
   */
  hasDirtyAmong(sessionIds: string[]): boolean {
    return sessionIds.some((sid) => this.dirty.has(sid));
  }

  /**
   * 批量收集多个 session 的 dirty 路径。
   * 返回合并后的路径列表。
   */
  collectPathsForSessions(sessionIds: string[]): string[] {
    const allPaths = new Set<string>();
    for (const sid of sessionIds) {
      const paths = this.collectPaths(sid);
      for (const p of paths) allPaths.add(p);
    }
    return [...allPaths];
  }
}

/**
 * 判断 dirty 信号是否应该触发 quality run。
 * - 只有 file/tool 信号才触发（git 信号是辅助信息）
 * - 如果 session 不属于任何活跃 run，不触发（避免无主 run）
 */
export function shouldTriggerGate(
  tracker: DirtyTracker,
  runContextRegistry: RunContextRegistry,
  sessionId: string,
): boolean {
  if (!tracker.isDirty(sessionId)) return false;
  const entry = tracker.getDirty(sessionId);
  if (!entry) return false;
  // 只有 file 或 tool 信号才触发
  if (!entry.signals.has("file") && !entry.signals.has("tool")) return false;
  // session 必须属于某个活跃 run（预绑定阶段已创建）
  return runContextRegistry.hasActiveRun(sessionId);
}
