import type { QualityRun, QualityStage } from "./types.js";

/** 终态：一旦进入不可再转换 */
export const TERMINAL_STAGES: ReadonlySet<QualityStage> = new Set([
  "accepted",
  "failed",
  "inconclusive",
  "waived",
  "cancelled",
  "quarantined",
  "stale",
]);

/**
 * 合法状态转换表（设计文档 §6 / v3.0 §6.9）。
 * key = 当前 stage，value = 可到达的 stage 集合。
 */
const TRANSITIONS: Readonly<Record<QualityStage, readonly QualityStage[]>> = {
  queued: ["preflight", "cancelled"],
  preflight: ["implementing", "failed", "inconclusive", "quarantined", "cancelled"],
  implementing: ["collecting", "failed", "inconclusive", "cancelled"],
  collecting: ["quick-verifying", "failed", "inconclusive", "quarantined", "cancelled"],
  "quick-verifying": ["reviewing", "full-verifying", "fixing", "failed", "inconclusive", "cancelled"],
  reviewing: ["full-verifying", "fixing", "awaiting-approval", "failed", "inconclusive", "cancelled"],
  fixing: ["collecting", "awaiting-approval", "failed", "inconclusive", "cancelled"],
  "full-verifying": ["requirement-verifying", "accepted", "fixing", "awaiting-approval", "failed", "inconclusive", "cancelled"],
  "requirement-verifying": ["accepted", "failed", "inconclusive", "awaiting-approval", "cancelled"],
  "awaiting-approval": ["accepted", "failed", "fixing", "inconclusive", "waived", "cancelled"],
  accepted: [],
  failed: [],
  inconclusive: [],
  waived: [],
  cancelled: [],
  quarantined: [],
  stale: [],
};

export function isTerminal(stage: QualityStage): boolean {
  return TERMINAL_STAGES.has(stage);
}

export function canTransition(from: QualityStage, to: QualityStage): boolean {
  if (isTerminal(from)) return false;
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: QualityStage;
  readonly to: QualityStage;
  constructor(from: QualityStage, to: QualityStage) {
    super(`illegal stage transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * 将 run 的 stage 从 `from` 推进到 `to`，返回更新后的 run 副本。
 * 非法转换抛出 IllegalTransitionError。
 *
 * 硬约束（§6 / v3.0 §6.9）：
 * - accepted/failed/inconclusive/waived/cancelled/quarantined/stale 是终态；
 * - 进入终态时设置 completedAt 和 verdict/outcome；
 * - fixing → collecting 时 fixRound +1；
 * - full-verifying → accepted 时要求 patchHash 已存在。
 */
export function transition(run: QualityRun, to: QualityStage): QualityRun {
  if (!canTransition(run.stage, to)) throw new IllegalTransitionError(run.stage, to);

  const now = Date.now();
  const next: QualityRun = { ...run, stage: to, updatedAt: now };

  if (to === "fixing") {
    next.fixRound = run.fixRound + 1;
  }

  if (to === "collecting" && run.stage === "fixing") {
    // fixing → collecting：修复后需要重新生成 ChangeSet，清除旧 patchHash
    next.patchHash = undefined;
  }

  if (isTerminal(to)) {
    next.completedAt = now;
    if (to === "accepted") {
      if (!run.patchHash) throw new IllegalTransitionError(run.stage, to);
      next.verdict = "pass";
      next.outcome = "verified";
    } else if (to === "failed") {
      next.verdict = "fail";
      next.outcome = "failed";
    } else if (to === "inconclusive") {
      next.outcome = "inconclusive";
    } else if (to === "waived") {
      next.outcome = "waived";
    }
  }

  return next;
}

/** 创建初始 QualityRun（stage = queued） */
export function createRun(init: Omit<QualityRun, "stage" | "fixRound" | "createdAt" | "updatedAt">): QualityRun {
  const now = Date.now();
  return {
    ...init,
    stage: "queued",
    fixRound: 0,
    createdAt: now,
    updatedAt: now,
  };
}
