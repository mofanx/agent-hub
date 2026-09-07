import type { QualityRole } from "./permissions.js";

/**
 * 活动 run/task/session 映射（设计文档 §4.1 / Q0-11）。
 *
 * 当 FS/tool 事件发生时，需要知道它属于哪个 quality run 和 task，
 * 以便将事件绑定到正确的 run，避免单聊/群聊串线。
 *
 * 映射链：
 *   sessionId → { runId, taskId?, role }
 *
 * 一个 session 在同一时间最多属于一个活跃 run。
 * run 结束时解绑所有 session。
 */

export type RunContext = {
  runId: string;
  taskId?: string | undefined;
  role: QualityRole;
};

export type SessionContext = {
  sessionId: string;
  runId: string;
  taskId?: string | undefined;
  role: QualityRole;
  roomId?: string | undefined;
  boundAt: number;
};

/**
 * 管理活动 run/task/session 映射。
 * 纯内存存储，Hub 重启后所有映射自动清除（run 状态由持久化层恢复）。
 */
export class RunContextRegistry {
  private readonly sessionToRun = new Map<string, SessionContext>();
  private readonly runToSessions = new Map<string, Set<string>>();

  /** 绑定 session 到某个 run 的某个角色。 */
  bind(sessionId: string, ctx: RunContext, roomId?: string): SessionContext {
    // 如果 session 已绑定到其他 run，先从旧 run 的 set 中移除
    const old = this.sessionToRun.get(sessionId);
    if (old && old.runId !== ctx.runId) {
      const oldSessions = this.runToSessions.get(old.runId);
      if (oldSessions) {
        oldSessions.delete(sessionId);
        if (oldSessions.size === 0) this.runToSessions.delete(old.runId);
      }
    }
    const sc: SessionContext = {
      sessionId,
      runId: ctx.runId,
      taskId: ctx.taskId,
      role: ctx.role,
      roomId,
      boundAt: Date.now(),
    };
    this.sessionToRun.set(sessionId, sc);
    let sessions = this.runToSessions.get(ctx.runId);
    if (!sessions) {
      sessions = new Set();
      this.runToSessions.set(ctx.runId, sessions);
    }
    sessions.add(sessionId);
    return sc;
  }

  /** 解绑单个 session。 */
  unbind(sessionId: string): SessionContext | undefined {
    const ctx = this.sessionToRun.get(sessionId);
    if (!ctx) return undefined;
    this.sessionToRun.delete(sessionId);
    const sessions = this.runToSessions.get(ctx.runId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.runToSessions.delete(ctx.runId);
    }
    return ctx;
  }

  /** 解绑某 runId 的所有 session。返回被解绑的 sessionId 列表。 */
  unbindRun(runId: string): string[] {
    const sessions = this.runToSessions.get(runId);
    if (!sessions) return [];
    const removed: string[] = [];
    for (const sid of sessions) {
      this.sessionToRun.delete(sid);
      removed.push(sid);
    }
    this.runToSessions.delete(runId);
    return removed;
  }

  /** 获取 session 的上下文。 */
  get(sessionId: string): SessionContext | undefined {
    return this.sessionToRun.get(sessionId);
  }

  /** 获取某 runId 绑定的所有 session。 */
  getSessionsForRun(runId: string): string[] {
    const sessions = this.runToSessions.get(runId);
    return sessions ? [...sessions] : [];
  }

  /** 该 session 是否属于某个活跃 run。 */
  hasActiveRun(sessionId: string): boolean {
    return this.sessionToRun.has(sessionId);
  }

  /** 该 session 的 run 是否有指定 taskId。 */
  hasTask(sessionId: string, taskId: string): boolean {
    const ctx = this.sessionToRun.get(sessionId);
    return ctx?.taskId === taskId;
  }

  /** 更新 session 的 taskId（conductor 派发子任务时）。 */
  setTaskId(sessionId: string, taskId: string): boolean {
    const ctx = this.sessionToRun.get(sessionId);
    if (!ctx) return false;
    ctx.taskId = taskId;
    return true;
  }

  /** 列出所有活跃 runId。 */
  activeRunIds(): string[] {
    return [...this.runToSessions.keys()];
  }

  /** 清除所有映射。 */
  clear(): void {
    this.sessionToRun.clear();
    this.runToSessions.clear();
  }

  /**
   * 为 FS/tool 事件附加 run 上下文。
   * 如果 session 不属于任何 run，返回原始事件不变。
   * 如果属于某个 run，附加 runId 和 taskId。
   */
  tagEvent<T extends Record<string, unknown>>(
    sessionId: string,
    event: T,
  ): T & { runId?: string | undefined; taskId?: string | undefined } {
    const ctx = this.sessionToRun.get(sessionId);
    if (!ctx) return event;
    const result: T & { runId?: string | undefined; taskId?: string | undefined } = { ...event };
    result.runId = ctx.runId;
    if (ctx.taskId !== undefined) result.taskId = ctx.taskId;
    return result;
  }
}
