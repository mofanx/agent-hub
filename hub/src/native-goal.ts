export type GoalAction = "set" | "pause" | "resume" | "clear";
export type GoalCapabilities = { version: 1; controlMethod: string; actions: GoalAction[] };
export type GoalSnapshot = {
  objective: string;
  status: "active" | "paused" | "blocked" | "limited" | "complete";
  createdAt?: number;
  updatedAt?: number;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  iterations?: number;
  lastReason?: string;
};

const object = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

function goalField(envelope: unknown): unknown {
  const meta = object(object(envelope)._meta);
  const air = object(object(meta.jetbrains).air);
  return Object.hasOwn(air, "goal") ? air.goal : meta.goal;
}

export function goalCapabilities(initialize: unknown): GoalCapabilities | undefined {
  const g = object(goalField(initialize));
  if (g.version !== 1 || typeof g.controlMethod !== "string" || !/^_[A-Za-z0-9/._-]{1,127}$/.test(g.controlMethod) ||
      !Array.isArray(g.actions) || g.actions.some((a) => typeof a !== "string")) return undefined;
  const actions = [...new Set(g.actions)].filter((a): a is GoalAction => ["set", "pause", "resume", "clear"].includes(a));
  if (!actions.includes("set") || !actions.includes("clear")) return undefined;
  return { version: 1, controlMethod: g.controlMethod, actions };
}

export function goalSnapshot(value: unknown): GoalSnapshot | undefined {
  const g = object(value);
  if (typeof g.objective !== "string" || !g.objective.trim() ||
      !["active", "paused", "blocked", "limited", "complete"].includes(String(g.status))) return undefined;
  const result: GoalSnapshot = { objective: g.objective, status: g.status as GoalSnapshot["status"] };
  for (const key of ["createdAt", "updatedAt", "tokenBudget", "tokensUsed", "timeUsedSeconds", "iterations"] as const) {
    const v = g[key];
    if (v === undefined) continue;
    if (key === "tokenBudget" && v === null) { result.tokenBudget = null; continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (key === "iterations" && !Number.isInteger(v))) return undefined;
    result[key] = v;
  }
  if (typeof g.lastReason === "string") result.lastReason = g.lastReason;
  return result;
}

export function goalUpdate(update: unknown): GoalSnapshot | null | undefined {
  if (object(update).sessionUpdate !== "session_info_update") return undefined;
  const value = goalField(update);
  return value === null ? null : goalSnapshot(value);
}
