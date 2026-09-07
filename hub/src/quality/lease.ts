import type { ProjectScope } from "./types.js";

/**
 * Project writer lease（设计文档 §7.1）。
 *
 * P0/P1 阶段不实现复杂 worktree 编排，而是每个 ProjectScope 同一时间最多一个 writer。
 * planner/reviewer 可并行读；其他写任务进入队列。
 *
 * lease 存储在内存中，Hub 重启后所有 lease 自动释放（无持有者）。
 */

export type Lease = {
  projectId: string;
  holderId: string;
  runId: string;
  acquiredAt: number;
  expiresAt: number;
};

export type LeaseAcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "held-by-other"; currentHolder: string; currentRunId: string };

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class LeaseExpiredError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`lease for project ${projectId} has expired`);
    this.name = "LeaseExpiredError";
    this.projectId = projectId;
  }
}

export class LeaseNotHeldError extends Error {
  readonly projectId: string;
  constructor(projectId: string) {
    super(`no lease held for project ${projectId}`);
    this.name = "LeaseNotHeldError";
    this.projectId = projectId;
  }
}

export class WriterLeaseManager {
  private readonly leases = new Map<string, Lease>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** 尝试获取项目的 writer lease。同一 holder 可重复获取（续租）。 */
  acquire(projectId: string, holderId: string, runId: string): LeaseAcquireResult {
    this.evictExpired(projectId);
    const existing = this.leases.get(projectId);
    if (existing) {
      if (existing.holderId !== holderId) {
        return {
          ok: false,
          reason: "held-by-other",
          currentHolder: existing.holderId,
          currentRunId: existing.runId,
        };
      }
      existing.acquiredAt = Date.now();
      existing.expiresAt = Date.now() + this.ttlMs;
      existing.runId = runId;
      return { ok: true, lease: existing };
    }
    const now = Date.now();
    const lease: Lease = {
      projectId,
      holderId,
      runId,
      acquiredAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.leases.set(projectId, lease);
    return { ok: true, lease };
  }

  /** 释放 lease，只有持有者才能释放。 */
  release(projectId: string, holderId: string): boolean {
    const existing = this.leases.get(projectId);
    if (!existing || existing.holderId !== holderId) return false;
    this.leases.delete(projectId);
    return true;
  }

  /** 检查项目是否被持有（自动淘汰过期的）。 */
  isHeld(projectId: string): boolean {
    this.evictExpired(projectId);
    return this.leases.has(projectId);
  }

  /** 获取当前 lease（可能已过期但未淘汰）。 */
  getLease(projectId: string): Lease | undefined {
    return this.leases.get(projectId);
  }

  /** 续租当前 lease。 */
  renew(projectId: string, holderId: string): Lease {
    const existing = this.leases.get(projectId);
    if (!existing || existing.holderId !== holderId) {
      throw new LeaseNotHeldError(projectId);
    }
    existing.acquiredAt = Date.now();
    existing.expiresAt = Date.now() + this.ttlMs;
    return existing;
  }

  /** 释放某 runId 持有的所有 lease（用于 run 结束时清理）。 */
  releaseByRunId(runId: string): string[] {
    const released: string[] = [];
    for (const [pid, lease] of [...this.leases.entries()]) {
      if (lease.runId === runId) {
        this.leases.delete(pid);
        released.push(pid);
      }
    }
    return released;
  }

  /** 列出所有活跃 lease。 */
  listActive(): Lease[] {
    const now = Date.now();
    return [...this.leases.values()].filter((l) => l.expiresAt > now);
  }

  /** 清除所有 lease（Hub 重启时调用，实际上内存重建已自动清除）。 */
  clear(): void {
    this.leases.clear();
  }

  private evictExpired(projectId: string): void {
    const lease = this.leases.get(projectId);
    if (lease && lease.expiresAt <= Date.now()) {
      this.leases.delete(projectId);
    }
  }
}

/**
 * 便捷函数：为指定 project + run 获取 lease，失败时抛出错误。
 */
export function acquireOrThrow(
  manager: WriterLeaseManager,
  project: ProjectScope,
  holderId: string,
  runId: string,
): Lease {
  const result = manager.acquire(project.id, holderId, runId);
  if (!result.ok) {
    throw new Error(
      `writer lease for project ${project.id} held by ${result.currentHolder} (run ${result.currentRunId})`,
    );
  }
  return result.lease;
}
