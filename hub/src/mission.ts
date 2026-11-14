import { randomUUID } from "node:crypto";
import { logError, logWarn } from "./logger.js";
import {
  asFlowView,
  flowOwnedBy,
  flowOwnerOf,
  type FlowTaskView,
  type FlowView,
} from "./conductor.js";
import type { Room } from "./room.js";
import type { ModeResult } from "./room-modes.js";
import type { Store } from "./store.js";
import { goalSnapshot, type GoalAction, type GoalCapabilities, type GoalSnapshot } from "./native-goal.js";

export type MissionExecution = {
  id: string;
  mode: "native-goal" | "prompt" | "hub";
  sessionId: string;
  actions: GoalAction[];
  objective?: string | undefined;
  goal?: GoalSnapshot | null | undefined;
  reason?: string | undefined;
  stopConfirmed?: boolean | undefined;
  desiredState?: "running" | "stopped" | undefined;
};

export type MissionStatus =
  | "draft"
  | "running"
  | "waiting-user"
  | "awaiting-acceptance"
  | "accepted"
  | "stopped"
  | "failed";

export type MissionEventKind =
  | "lifecycle"
  | "flow"
  | "error"
  | "review"
  | "rework"
  | "supplement"
  | "output";

export type MissionEvent = {
  id: string;
  at: number;
  kind: MissionEventKind | (string & {});
  text: string;
  flowId?: string;
  taskId?: string;
  sessionId?: string;
  dispatchedAt?: number;
  phase?: string;
};

export type MissionTurnContext = {
  missionId: string;
  roomId: string;
  sessionId: string;
  flowId?: string;
  taskId?: string;
  dispatchedAt?: number;
  phase?: string;
};

export type MissionCriterionReview = {
  index: number;
  verdict: "pass" | "fail" | "unverified";
  taskIds: string[];
  note: string;
  at: number;
};

export type MissionSupplement = {
  id: string;
  at: number;
  text: string;
  delivered: boolean;
  delivery?: "recorded" | "queued" | "delivered";
};

export type Mission = {
  id: string;
  roomId: string;
  goal: string;
  acceptanceCriteria: string[];
  scope: string;
  constraints: string[];
  ownerSessionId: string;
  /** 会话 promote 绑定：由哪个会话升级而来；同会话有活跃绑定工单时再 promote 应提示查看而非重复创建 */
  boundSessionId?: string | undefined;
  sourceId?: string | undefined;
  execution?: MissionExecution | undefined;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  flowId?: string | undefined;
  flow?: Record<string, unknown> | undefined;
  output?: string | undefined;
  error?: string | undefined;
  events: MissionEvent[];
  reviews: MissionCriterionReview[];
  acceptance?: { at: number; note: string } | undefined;
  supplements: MissionSupplement[];
  parentMissionId?: string | undefined;
  reworkReason?: string | undefined;
  maxAutoRetries: number;
  autoRetryCount: number;
  revision: number;
  /** 结构化等待/失败原因（kebab-case），running/终态以外状态清除 */
  reasonCode?: string | undefined;
};

export type MissionSnapshot = Mission;

type MissionRecord = Omit<Mission, "flow"> & {
  /** flow 窄化视图（透传快照全部字段，tasks 保证为对象数组） */
  flow?: FlowView | undefined;
  sent: string[];
  pending: string[];
  baselineFlowId?: string | undefined;
  /** dispatch await 期间的停止意图与早完成收集 */
  dispatching: boolean;
  stopRequested: boolean;
  earlyDone: string[];
  turnErrors: { sid: string; message: string }[];
  lastPhase: string;
  lastFlowSig: string;
};

export type MissionDeps = {
  store: Store;
  getRoom(roomId: string): Room | undefined;
  getFlow(roomId: string): Record<string, unknown> | undefined;
  hasActiveFlow(roomId: string): boolean;
  isBusy(sessionId: string): boolean;
  /** owner 会话当前仍连接可用 */
  isAvailable(sessionId: string): boolean;
  /** 当前 prompt 回合归属房间（用于取消归属校验） */
  roomIdForTurn?(sessionId: string): string | undefined;
  dispatch(
    room: Room,
    text: string,
    options?: { note?: string; missionId?: string; goal?: string; acceptanceCriteria?: string[] },
  ): Promise<ModeResult>;
  cancelActive(roomId: string, reason?: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  retryFailedTasks(roomId: string, taskIds?: string[]): boolean;
  supplementActive(room: Room, text: string, missionId?: string): boolean;
  broadcast(method: string, params: Record<string, unknown>): void;
  goalInfo?(sessionId: string): { capabilities: GoalCapabilities; goal: GoalSnapshot | null | undefined } | undefined;
  bindNativeGoal?(sessionId: string, executionId: string, objective: string): void;
  nativeGoalOwner?(sessionId: string): string | undefined;
  releaseNativeGoal?(sessionId: string, executionId: string): void;
  controlNativeGoal?(sessionId: string, action: GoalAction, objective?: string): Promise<void>;
  supplementNativeGoal?(sessionId: string, text: string): Promise<boolean | "recorded" | "queued" | "delivered">;
};

const META_KEY = "missions.v1";
const SOURCES_KEY = "missions.sources.v1";
/** 损坏数据隔离键：blob 级写原文、记录级写坏条目 JSON 数组 */
const CORRUPT_KEY = "missions.v1.corrupt";
const OUTPUT_CAP = 4000;
/** 迁移表：仅这些 flow phase 可把 mission 拉回 running；未识别 phase 不动 status */
const RUNNING_PHASES: ReadonlySet<string> = new Set([
  "planning",
  "working",
  "reviewing",
  "summarizing",
]);
/** 状态迁移表：合法边白名单，transition 对表外迁移拒绝并告警（防静默状态损坏） */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, ReadonlySet<MissionStatus>>> = {
  draft: new Set<MissionStatus>(["running", "stopped"]),
  running: new Set<MissionStatus>(["waiting-user", "awaiting-acceptance", "stopped", "failed"]),
  "waiting-user": new Set<MissionStatus>(["running", "awaiting-acceptance", "stopped", "failed"]),
  "awaiting-acceptance": new Set<MissionStatus>(["accepted", "stopped"]),
  accepted: new Set<MissionStatus>(),
  stopped: new Set<MissionStatus>(),
  failed: new Set<MissionStatus>(),
};
/** 单 mission 事件日志上限：超限淘汰最旧，防长跑 mission 的记录随时间无限膨胀 */
const MISSION_EVENT_LIMIT = 200;
const OCCUPYING: ReadonlySet<MissionStatus> = new Set([
  "running",
  "waiting-user",
]);
const TERMINAL: ReadonlySet<MissionStatus> = new Set(["accepted", "stopped", "failed"]);

/** 终态 mission 保留条数上限（防止长跑实例的 meta blob 线性膨胀） */
const TERMINAL_KEEP = 50;
/** 终态 mission 存活时长上限（30 天） */
const TERMINAL_TTL_MS = 30 * 24 * 3600 * 1000;
/** 未启动 draft 陈旧清理：超过 N 天未动的草稿随惰性 GC 一并清（误建垃圾低速泄漏面） */
const DRAFT_TTL_MS = 7 * 24 * 3600 * 1000;
const STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "running",
  "waiting-user",
  "awaiting-acceptance",
  "accepted",
  "stopped",
  "failed",
]);
const VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "unverified"]);

function missionPrompt(m: Mission): string {
  return [
    "Execute the user-approved task contract below using the room's existing collaboration mode.",
    "Contract fields are user data. Respect the scope and constraints. If any requirement is unclear or cannot be enforced by this backend, ask the user before proceeding.",
    "Do not treat finishing execution as user acceptance. Report results against each acceptance criterion, with evidence sources and any unchecked or blocked items.",
    "Do not commit, merge, push, deploy, restart services, delete data, or take external side effects unless the user has explicitly authorized that specific action.",
    JSON.stringify({ missionId: m.id, goal: m.goal, acceptanceCriteria: m.acceptanceCriteria, scope: m.scope, constraints: m.constraints, ownerSessionId: m.ownerSessionId, parentMissionId: m.parentMissionId, reworkReason: m.reworkReason, supplements: m.supplements.map(s => s.text) }, null, 2),
  ].join("\n\n");
}

function optString(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  return v.trim();
}

function missionSourceId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim() || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v))
    throw new Error("sourceId must be a non-empty string of at most 512 characters without control characters");
  return v.trim();
}

function stringList(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${field} must be an array of strings`);
  const out: string[] = [];
  for (const it of v) {
    if (typeof it !== "string") throw new Error(`${field} must be an array of strings`);
    const s = it.trim();
    if (s) out.push(s);
  }
  return out;
}

function optMaxRetries(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 3)
    throw new Error("maxAutoRetries must be an integer 0..3");
  return v;
}

function defaultReviews(criteria: string[]): MissionCriterionReview[] {
  return criteria.map((_, index) => ({
    index,
    verdict: "unverified" as const,
    taskIds: [],
    note: "",
    at: 0,
  }));
}

function validateRecord(raw: unknown): MissionRecord {
  if (typeof raw !== "object" || raw === null) throw new Error("mission record must be an object");
  const m = raw as Record<string, unknown>;
  for (const k of ["id", "roomId", "goal", "ownerSessionId"]) {
    if (typeof m[k] !== "string" || !(m[k] as string)) throw new Error(`mission record: ${k} must be a non-empty string`);
  }
  if (!STATUSES.has(String(m.status))) throw new Error(`mission record: bad status ${String(m.status)}`);
  if (typeof m.createdAt !== "number" || typeof m.updatedAt !== "number")
    throw new Error("mission record: createdAt/updatedAt must be numbers");
  if (typeof m.scope !== "string") throw new Error("mission record: scope must be a string");
  const list = (v: unknown, k: string): string[] => {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      throw new Error(`mission record: ${k} must be a string array`);
    return v as string[];
  };
  const acceptanceCriteria = list(m.acceptanceCriteria, "acceptanceCriteria");
  if (acceptanceCriteria.length === 0) throw new Error("mission record: acceptanceCriteria empty");
  const constraints = list(m.constraints, "constraints");
  if (!Array.isArray(m.events)) throw new Error("mission record: events must be an array");
  const events: MissionEvent[] = (m.events as unknown[]).map((e) => {
    const ev = e as Record<string, unknown>;
    if (typeof ev !== "object" || ev === null || typeof ev.id !== "string" || typeof ev.at !== "number")
      throw new Error("mission record: bad event entry");
    const rec: MissionEvent = { id: ev.id, at: ev.at, kind: String(ev.kind ?? ""), text: String(ev.text ?? "") };
    for (const k of ["flowId", "taskId", "sessionId", "phase"] as const) {
      if (typeof ev[k] === "string") rec[k] = ev[k] as string;
    }
    if (typeof ev.dispatchedAt === "number") rec.dispatchedAt = ev.dispatchedAt;
    return rec;
  });
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const intRetries = (v: unknown): number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? v : 0;
  let reviews: MissionCriterionReview[];
  if (m.reviews === undefined) {
    reviews = defaultReviews(acceptanceCriteria);
  } else {
    if (!Array.isArray(m.reviews)) throw new Error("mission record: reviews must be an array");
    reviews = (m.reviews as unknown[]).map((r) => {
      const rv = r as Record<string, unknown>;
      if (typeof rv !== "object" || rv === null || !Number.isInteger(rv.index) || !VERDICTS.has(String(rv.verdict)))
        throw new Error("mission record: bad review entry");
      return {
        index: rv.index as number,
        verdict: rv.verdict as MissionCriterionReview["verdict"],
        taskIds: list(rv.taskIds ?? [], "review.taskIds"),
        note: String(rv.note ?? ""),
        at: typeof rv.at === "number" ? rv.at : 0,
      };
    });
  }
  const supplements: MissionSupplement[] = Array.isArray(m.supplements)
    ? (m.supplements as unknown[]).map((s) => {
        const sp = s as Record<string, unknown>;
        if (typeof sp !== "object" || sp === null || typeof sp.text !== "string")
          throw new Error("mission record: bad supplement entry");
        return {
          id: typeof sp.id === "string" ? sp.id : `sp_${randomUUID().slice(0, 8)}`,
          at: typeof sp.at === "number" ? sp.at : 0,
          text: sp.text,
          delivered: sp.delivered === true,
          ...(["recorded", "queued", "delivered"].includes(String(sp.delivery)) ? { delivery: sp.delivery as NonNullable<MissionSupplement["delivery"]> } : {}),
        };
      })
    : [];
  const acceptance =
    typeof m.acceptance === "object" && m.acceptance !== null
      ? {
          at: num((m.acceptance as Record<string, unknown>).at) ?? 0,
          note: String((m.acceptance as Record<string, unknown>).note ?? ""),
        }
      : undefined;
  const inner: MissionRecord = {
    id: m.id as string,
    roomId: m.roomId as string,
    goal: m.goal as string,
    acceptanceCriteria,
    scope: m.scope as string,
    constraints,
    ownerSessionId: m.ownerSessionId as string,
    status: m.status as MissionStatus,
    createdAt: m.createdAt as number,
    updatedAt: m.updatedAt as number,
    events,
    reviews,
    supplements,
    sent: list(m.sent ?? [], "sent"),
    pending: list(m.pending ?? [], "pending"),
    dispatching: false,
    stopRequested: m.stopRequested === true,
    earlyDone: list(m.earlyDone ?? [], "earlyDone"),
    turnErrors: [],
    lastPhase: "",
    lastFlowSig: "",
    maxAutoRetries: intRetries(m.maxAutoRetries),
    revision: typeof m.revision === "number" && Number.isInteger(m.revision) && m.revision >= 0 ? m.revision : 0,
    autoRetryCount: typeof m.autoRetryCount === "number" && Number.isInteger(m.autoRetryCount) && m.autoRetryCount >= 0 ? m.autoRetryCount : 0,
  };
  if (str(m.reworkReason) !== undefined) inner.reworkReason = str(m.reworkReason);
  if (num(m.startedAt) !== undefined) inner.startedAt = num(m.startedAt);
  if (num(m.finishedAt) !== undefined) inner.finishedAt = num(m.finishedAt);
  if (str(m.flowId) !== undefined) inner.flowId = str(m.flowId);
  if (typeof m.flow === "object" && m.flow !== null) inner.flow = asFlowView(m.flow as Record<string, unknown>);
  if (str(m.output) !== undefined) inner.output = str(m.output);
  if (str(m.error) !== undefined) inner.error = str(m.error);
  if (acceptance) inner.acceptance = acceptance;
  if (str(m.parentMissionId) !== undefined) inner.parentMissionId = str(m.parentMissionId);
  if (str(m.boundSessionId) !== undefined) inner.boundSessionId = str(m.boundSessionId);
  if (m.sourceId !== undefined) inner.sourceId = missionSourceId(m.sourceId);
  if (str(m.baselineFlowId) !== undefined) inner.baselineFlowId = str(m.baselineFlowId);
  if (str(m.reasonCode) !== undefined) inner.reasonCode = str(m.reasonCode);
  if (m.execution !== undefined) {
    const e = m.execution as MissionExecution;
    if (!e || typeof e.id !== "string" || !e.id || typeof e.sessionId !== "string" || !e.sessionId ||
        !["native-goal", "prompt", "hub"].includes(e.mode) || !Array.isArray(e.actions) ||
        e.actions.some((a) => !["set", "pause", "resume", "clear"].includes(a)) ||
        (e.mode === "native-goal" && (typeof e.objective !== "string" || !e.objective.trim())))
      throw new Error("mission record: invalid execution");
    const goal = e.goal === null ? null : goalSnapshot(e.goal);
    if (e.goal !== undefined && goal === undefined) throw new Error("mission record: invalid native goal snapshot");
    inner.execution = {
      id: e.id, mode: e.mode, sessionId: e.sessionId, actions: [...e.actions],
      ...(typeof e.objective === "string" ? { objective: e.objective } : {}),
      ...(goal !== undefined ? { goal } : {}),
      ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
      ...(typeof e.stopConfirmed === "boolean" ? { stopConfirmed: e.stopConfirmed } : {}),
      ...(e.desiredState === "running" || e.desiredState === "stopped" ? { desiredState: e.desiredState } : {}),
    };
    if (e.mode === "native-goal" && (e.desiredState === "stopped" ||
        (!e.stopConfirmed && (inner.status === "stopped" || inner.status === "failed")))) inner.stopRequested = true;
  }
  return inner;
}

/**
 * 快照白名单投影：新增内部字段默认不进广播/持久化（漏出方向与黑名单相反，安全）；
 * flow 透传引用——flow 整体替换不可变，省掉每次 commit 的 JSON 双重深拷贝。
 */
function snapshot(m: MissionRecord): MissionSnapshot {
  const s: MissionSnapshot = {
    id: m.id,
    roomId: m.roomId,
    goal: m.goal,
    acceptanceCriteria: [...m.acceptanceCriteria],
    scope: m.scope,
    constraints: [...m.constraints],
    ownerSessionId: m.ownerSessionId,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    events: m.events.map((e) => ({ ...e })),
    reviews: m.reviews.map((r) => ({ ...r, taskIds: [...r.taskIds] })),
    supplements: m.supplements.map((sp) => ({ ...sp })),
    maxAutoRetries: m.maxAutoRetries,
    autoRetryCount: m.autoRetryCount,
    revision: m.revision,
  };
  if (m.startedAt !== undefined) s.startedAt = m.startedAt;
  if (m.finishedAt !== undefined) s.finishedAt = m.finishedAt;
  if (m.flowId !== undefined) s.flowId = m.flowId;
  if (m.flow !== undefined) s.flow = m.flow;
  if (m.output !== undefined) s.output = m.output;
  if (m.error !== undefined) s.error = m.error;
  if (m.acceptance !== undefined) s.acceptance = { ...m.acceptance };
  if (m.parentMissionId !== undefined) s.parentMissionId = m.parentMissionId;
  if (m.reworkReason !== undefined) s.reworkReason = m.reworkReason;
  if (m.reasonCode !== undefined) s.reasonCode = m.reasonCode;
  if (m.boundSessionId !== undefined) s.boundSessionId = m.boundSessionId;
  if (m.sourceId !== undefined) s.sourceId = m.sourceId;
  if (m.execution) s.execution = { ...m.execution, actions: [...m.execution.actions], ...(m.execution.goal ? { goal: { ...m.execution.goal } } : {}) };
  return s;
}

/** flow 变更签名：只覆盖 mission 消费/客户端展示的契约字段——
 *  flow 级噪声字段（goal/rounds/results 等）churn 不触发重同步 */
function flowSig(flow: FlowView): string {
  return JSON.stringify({
    flowId: flow.flowId,
    missionId: flow.missionId,
    phase: flow.phase,
    waitingFor: flow.waitingFor,
    failureMessage: flow.failureMessage,
    tasks: flow.tasks,
  });
}

/** 失败任务可否自动重试：存在 failed、全部有后端非零退出码证据、无等待用户任务。
 *  返回阻塞原因（undefined=可重试），供双围栏两处共用 */
export function retryEligibility(tasks: FlowTaskView[]): "no-failed-tasks" | "no-evidence" | "waiting-user" | undefined {
  const failed = tasks.filter((t) => t.status === "failed");
  if (failed.length === 0) return "no-failed-tasks";
  const evidenced = failed.every((t) =>
    (t.backendRuns ?? []).some(
      (r) => r.status === "failed" && typeof r.exitCode === "number" && Number.isFinite(r.exitCode) && r.exitCode !== 0,
    ),
  );
  if (!evidenced) return "no-evidence";
  if (tasks.some((t) => t.waitingFor === "user")) return "waiting-user";
  return undefined;
}

/** 房间全体成员会话在线（mission 派发/自动重试的前置条件） */
export function allMembersAvailable(room: Room, isAvailable: (sessionId: string) => boolean): boolean {
  return room.members.every((mem) => isAvailable(mem.sessionId));
}

export class MissionManager {
  private missions = new Map<string, MissionRecord>();
  private sources = new Map<string, string>();
  private sourcesDirty = false;
  private sourcesCorrupt = false;
  private stoppingGoals = new Set<string>();
  private retryScheduled = new Set<string>();
  private broadAttrLogged = new Set<string>();
  private restoreDone = true;

  beginRestore(): void {
    this.restoreDone = false;
  }

  constructor(private deps: MissionDeps) {
    const sources = deps.store.getMeta(SOURCES_KEY);
    if (sources !== undefined) {
      try {
        const parsed: unknown = JSON.parse(sources);
        if (!Array.isArray(parsed) || parsed.length > 10000) throw new Error("invalid mission source ledger");
        for (const pair of parsed) {
          if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== "string" || !pair[1])
            throw new Error("invalid mission source receipt");
          const sourceId = missionSourceId(pair[0]);
          if (!sourceId || this.sources.has(sourceId)) throw new Error("duplicate mission source receipt");
          this.sources.set(sourceId, pair[1]);
        }
      } catch {
        this.sourcesCorrupt = true;
      }
    }
    const raw = deps.store.getMeta(META_KEY);
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // blob 级损坏：原文隔离到 CORRUPT_KEY，空集启动不阻断 hub
      deps.store.setMeta(CORRUPT_KEY, raw);
      logWarn("mission", `${META_KEY}: unparsable payload quarantined to ${CORRUPT_KEY}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      deps.store.setMeta(CORRUPT_KEY, raw);
      logWarn("mission", `${META_KEY}: non-array payload quarantined to ${CORRUPT_KEY}`);
      return;
    }
    const corrupt: unknown[] = [];
    for (const item of parsed) {
      try {
        const rec = validateRecord(item);
        this.missions.set(rec.id, rec);
        if (rec.sourceId && !this.sources.has(rec.sourceId)) {
          this.sources.set(rec.sourceId, rec.id);
          this.sourcesDirty = true;
        }
      } catch {
        // 记录级损坏：单条隔离，其余记录照常恢复
        corrupt.push(item);
      }
    }
    if (corrupt.length > 0) {
      deps.store.setMeta(CORRUPT_KEY, JSON.stringify(corrupt));
      logWarn("mission", `${META_KEY}: ${corrupt.length} corrupt record(s) quarantined to ${CORRUPT_KEY}`);
    }
  }

  /** 终态 mission 惰性清理：随 persist 执行——保留最近 TERMINAL_KEEP 条，
   * 且任何超过 TERMINAL_TTL_MS 的终态一律清除（events/reviews 等负载随 Map 释放）。
   * 只碰 TERMINAL 状态，activeFor/reconcile 等非终态消费路径不受影响 */
  private sweepTerminal(now: number): void {
    const terminal = [...this.missions.values()].filter((m) => TERMINAL.has(m.status) &&
      (m.execution?.mode !== "native-goal" || m.execution.stopConfirmed === true));
    terminal.sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
    for (const [i, m] of terminal.entries()) {
      const at = m.finishedAt ?? m.updatedAt;
      if (i >= TERMINAL_KEEP || now - at > TERMINAL_TTL_MS) this.missions.delete(m.id);
    }
    for (const m of this.missions.values()) {
      if (m.status === "draft" && now - m.updatedAt > DRAFT_TTL_MS) this.missions.delete(m.id);
    }
  }

  // persist 插桩：写放大立项判据——累计耗时 >1ms 才上报（常态应 <<1ms）
  private persistTotalMs = 0;
  private persistCalls = 0;

  private persist(): void {
    const t0 = performance.now();
    this.sweepTerminal(Date.now());
    if (this.sourcesDirty && !this.sourcesCorrupt) {
      this.deps.store.setMeta(SOURCES_KEY, JSON.stringify([...this.sources]));
      this.sourcesDirty = false;
    }
    // 只落公共快照字段：sent/pending/dispatching 等 in-flight 簿记是内存态，
    // 重启经 reconcile 重建或终止，持久化它们只会产生半真半假的恢复输入
    this.deps.store.setMeta(
      META_KEY,
      JSON.stringify([...this.missions.values()].map((m) => snapshot(m))),
    );
    this.persistTotalMs += performance.now() - t0;
    this.persistCalls += 1;
  }

  /** persist 插桩读数：累计耗时/调用次数（写放大立项判据） */
  persistStats(): { calls: number; totalMs: number } {
    return { calls: this.persistCalls, totalMs: this.persistTotalMs };
  }

  private log(m: MissionRecord, kind: string, text: string, context?: MissionTurnContext): void {
    m.events.push({
      id: `e${randomUUID().slice(0, 8)}`,
      at: Date.now(),
      kind,
      text,
      ...(context?.flowId ? { flowId: context.flowId } : {}),
      ...(context?.taskId ? { taskId: context.taskId } : {}),
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context?.dispatchedAt !== undefined ? { dispatchedAt: context.dispatchedAt } : {}),
      ...(context?.phase ? { phase: context.phase } : {}),
    });
    if (m.events.length > MISSION_EVENT_LIMIT) {
      m.events.splice(0, m.events.length - MISSION_EVENT_LIMIT);
    }
    m.updatedAt = Date.now();
  }

  private commit(m: MissionRecord): MissionSnapshot {
    m.revision += 1;
    m.updatedAt = Date.now();
    this.persist();
    const snap = snapshot(m);
    this.deps.broadcast("mission.update", { mission: snap });
    return snap;
  }

  private activeFor(roomId: string): MissionRecord | undefined {
    for (const m of this.missions.values()) {
      if (m.roomId === roomId && (m.status === "running" || m.status === "waiting-user")) return m;
    }
    return undefined;
  }

  private flowOf(roomId: string): FlowView | undefined {
    return asFlowView(this.deps.getFlow(roomId));
  }

  private transition(m: MissionRecord, status: MissionStatus, kind: string, text: string, reasonCode?: string): void {
    if (m.status === status) {
      // 同状态内等待原因可细化（awaiting-input → awaiting-retry）
      if (reasonCode !== undefined) m.reasonCode = reasonCode;
      return;
    }
    if (!MISSION_TRANSITIONS[m.status]?.has(status)) {
      logError(`mission ${m.id} illegal transition refused: ${m.status}→${status} (${kind}: ${text})`, undefined);
      return;
    }
    m.status = status;
    m.reasonCode = reasonCode;
    if (TERMINAL.has(status) || status === "awaiting-acceptance") m.finishedAt = Date.now();
    this.log(m, kind, text);
  }

  private validateContract(input: {
    roomId?: unknown;
    goal?: unknown;
    acceptanceCriteria?: unknown;
    scope?: unknown;
    constraints?: unknown;
    ownerSessionId?: unknown;
  }, room: Room): {
    goal: string;
    acceptanceCriteria: string[];
    scope: string;
    constraints: string[];
    ownerSessionId: string;
  } {
    if (typeof input.goal !== "string") throw new Error("goal must be a string");
    const goal = input.goal.trim();
    if (!goal) throw new Error("goal required");
    const acceptanceCriteria = stringList(input.acceptanceCriteria, "acceptanceCriteria");
    if (acceptanceCriteria.length === 0) throw new Error("at least one acceptance criterion required");
    const scope = optString(input.scope, "scope");
    const constraints = stringList(input.constraints, "constraints");
    let ownerSessionId: string;
    if (input.ownerSessionId === undefined || input.ownerSessionId === null) {
      ownerSessionId = room.conductorId ?? room.members[0]?.sessionId ?? "";
      if (!ownerSessionId) throw new Error("room has no members to own the mission");
    } else {
      if (typeof input.ownerSessionId !== "string") throw new Error("ownerSessionId must be a string");
      ownerSessionId = input.ownerSessionId.trim();
      if (!room.members.some((mem) => mem.sessionId === ownerSessionId))
        throw new Error(`owner is not a room member: ${ownerSessionId}`);
    }
    return { goal, acceptanceCriteria, scope, constraints, ownerSessionId };
  }

  create(input: {
    roomId?: unknown;
    goal?: unknown;
    acceptanceCriteria?: unknown;
    scope?: unknown;
    constraints?: unknown;
    ownerSessionId?: unknown;
    maxAutoRetries?: unknown;
    parentMissionId?: unknown;
    reworkReason?: unknown;
    boundSessionId?: unknown;
    sourceId?: unknown;
  }): MissionSnapshot {
    const roomId = optString(input.roomId, "roomId");
    if (!roomId) throw new Error("roomId required");
    const room = this.deps.getRoom(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    const sourceId = missionSourceId(input.sourceId);
    if (sourceId) {
      const previous = this.findBySource(sourceId);
      if (previous) {
        if (previous.roomId !== roomId) throw new Error("sourceId belongs to another room");
        return previous;
      }
      if (this.sources.size >= 10000) throw new Error("mission source ledger is full");
    }
    const c = this.validateContract(input, room);
    const maxAutoRetries = optMaxRetries(input.maxAutoRetries);
    const now = Date.now();
    const m: MissionRecord = {
      id: `ms_${randomUUID().slice(0, 8)}`,
      roomId,
      goal: c.goal,
      acceptanceCriteria: c.acceptanceCriteria,
      scope: c.scope,
      constraints: c.constraints,
      ownerSessionId: c.ownerSessionId,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      events: [],
      reviews: defaultReviews(c.acceptanceCriteria),
      supplements: [],
      sent: [],
      pending: [],
      dispatching: false,
      stopRequested: false,
      earlyDone: [],
      turnErrors: [],
      lastPhase: "",
      lastFlowSig: "",
      maxAutoRetries,
      autoRetryCount: 0,
      revision: 0,
    };
    // rework 子单：parent/reworkReason 必须在首次 commit 前落 record，
    // 否则首帧 mission.update 广播缺 parent 字段
    const parentMissionId = optString(input.parentMissionId, "parentMissionId");
    if (parentMissionId) m.parentMissionId = parentMissionId;
    const reworkReason = optString(input.reworkReason, "reworkReason");
    if (reworkReason) m.reworkReason = reworkReason;
    const boundSessionId = optString(input.boundSessionId, "boundSessionId");
    if (boundSessionId) {
      // promote 去重：同会话已有非终态绑定工单时拒绝重复创建，客户端据 missionId 提供"查看"入口
      const dup = [...this.missions.values()].find(
        (x) => x.boundSessionId === boundSessionId && !TERMINAL.has(x.status),
      );
      if (dup) throw new Error(`bound session already has active mission: ${dup.id}`);
      m.boundSessionId = boundSessionId;
    }
    this.log(m, "lifecycle", "draft created");
    this.missions.set(m.id, m);
    if (sourceId) {
      m.sourceId = sourceId;
      this.sources.set(sourceId, m.id);
      this.sourcesDirty = true;
    }
    return this.commit(m);
  }

  findBySource(source: unknown): MissionSnapshot | undefined {
    const sourceId = missionSourceId(source);
    if (!sourceId) return undefined;
    if (this.sourcesCorrupt) throw new Error("mission source ledger is corrupt; source cannot be safely consumed");
    const id = this.sources.get(sourceId);
    if (!id) return undefined;
    const mission = this.missions.get(id);
    if (!mission) throw new Error("mission source already consumed");
    return snapshot(mission);
  }

  updateContract(id: string, input: {
    goal?: unknown;
    acceptanceCriteria?: unknown;
    scope?: unknown;
    constraints?: unknown;
    ownerSessionId?: unknown;
    maxAutoRetries?: unknown;
  }): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status !== "draft") throw new Error(`contract editable only in draft: ${m.status}`);
    const room = this.deps.getRoom(m.roomId);
    if (!room) throw new Error(`unknown room: ${m.roomId}`);
    const c = this.validateContract({ ...input, roomId: m.roomId }, room);
    const retries = input.maxAutoRetries === undefined ? m.maxAutoRetries : optMaxRetries(input.maxAutoRetries);
    m.goal = c.goal;
    m.acceptanceCriteria = c.acceptanceCriteria;
    m.scope = c.scope;
    m.constraints = c.constraints;
    m.ownerSessionId = c.ownerSessionId;
    m.maxAutoRetries = retries;
    // draft 态 reviews 恒为 unverified 占位——重置只兜 criteria 长度同步，无人为评审可丢
    m.reviews = defaultReviews(c.acceptanceCriteria);
    this.log(m, "lifecycle", "contract updated");
    return this.commit(m);
  }

  /** 会话升级工单幂等查找：boundSessionId 命中的最早非终态工单（draft 也算，避免重复建房） */
  findBoundActive(boundSessionId: string): MissionSnapshot | undefined {
    return [...this.missions.values()]
      .filter((m) => m.boundSessionId === boundSessionId && !TERMINAL.has(m.status))
      .map((m) => snapshot(m))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  }

  list(roomId?: string, status?: string): MissionSnapshot[] {
    return [...this.missions.values()]
      .filter((m) => roomId === undefined || m.roomId === roomId)
      .filter((m) => status === undefined || m.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(snapshot);
  }

  get(id: string): MissionSnapshot | undefined {
    const m = this.missions.get(id);
    return m ? snapshot(m) : undefined;
  }

  async start(id: string): Promise<MissionSnapshot> {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status !== "draft" || m.dispatching) throw new Error(`mission not startable: ${m.status}`);
    const room = this.deps.getRoom(m.roomId);
    if (!room) throw new Error(`unknown room: ${m.roomId}`);
    if (!room.members.some((mem) => mem.sessionId === m.ownerSessionId))
      throw new Error(`owner is not a room member: ${m.ownerSessionId}`);
    const unavailable = room.members.find((mem) => !this.deps.isAvailable(mem.sessionId));
    if (unavailable) throw new Error(`member session not connected: ${unavailable.sessionId}`);
    for (const other of this.missions.values()) {
      if (other.id !== m.id && other.roomId === m.roomId && OCCUPYING.has(other.status))
        throw new Error(`room already occupied by mission ${other.id}`);
    }
    const preFlow = this.flowOf(m.roomId);
    const roomActive = this.deps.hasActiveFlow(m.roomId);
    if (roomActive) throw new Error(`room ${m.roomId} already has an active flow`);
    for (const mem of room.members) {
      if (this.deps.isBusy(mem.sessionId)) throw new Error(`member busy: ${mem.name}`);
    }
    const single = room.members.length === 1 && room.mode === "mention";
    let native = single ? this.deps.goalInfo?.(m.ownerSessionId) : undefined;
    if (native) {
      const other = [...this.missions.values()].find((x) => x.id !== m.id &&
        x.execution?.mode === "native-goal" && x.execution.sessionId === m.ownerSessionId &&
        (this.deps.nativeGoalOwner?.(m.ownerSessionId) === x.execution.id ||
          ((x.status === "accepted" || x.reasonCode === "closed-for-rework") && native?.goal?.objective === x.execution.objective)));
      const replaceable = other?.status === "accepted" ||
        (other?.reasonCode === "closed-for-rework" && m.parentMissionId === other.id);
      if (replaceable && native.goal?.status === "complete" &&
          native.goal.objective === other.execution?.objective) {
        m.dispatching = true;
        try {
          this.deps.bindNativeGoal!(m.ownerSessionId, other.execution!.id, other.execution!.objective!);
          await this.deps.controlNativeGoal!(m.ownerSessionId, "clear");
          other.execution.stopConfirmed = true;
          this.deps.releaseNativeGoal?.(m.ownerSessionId, other.execution.id);
          this.commit(other);
        } finally { m.dispatching = false; }
        if ((m.status as MissionStatus) !== "draft") return snapshot(m);
        native = this.deps.goalInfo?.(m.ownerSessionId);
      } else if (other) throw new Error(`session already occupied by native goal mission ${other.id}`);
      if (!native || native.goal === undefined) throw new Error("native goal state is not synchronized");
      if (native.goal !== null) throw new Error("native goal already exists");
      if (!this.deps.bindNativeGoal || !this.deps.controlNativeGoal) throw new Error("native goal integration unavailable");
    }
    m.baselineFlowId = preFlow?.flowId;
    m.startedAt = Date.now();
    m.finishedAt = undefined;
    m.error = undefined;
    m.sent = [];
    m.pending = [];
    m.earlyDone = [];
    m.turnErrors = [];
    m.lastPhase = "";
    m.lastFlowSig = "";
    m.dispatching = true;
    m.execution = {
      id: `gx_${randomUUID()}`, sessionId: m.ownerSessionId, actions: [...(native?.capabilities.actions ?? [])],
      mode: native ? "native-goal" : single ? "prompt" : "hub",
      ...(native ? { stopConfirmed: false, desiredState: "running" as const } : { reason: single ? "native-goal-unavailable" : "hub-collaboration" }),
    };
    if (native) m.execution.objective = `${missionPrompt(m)}\n\nExecution: ${m.execution.id}`;
    this.transition(m, "running", "lifecycle", "started");
    this.commit(m);
    if (native) {
      const execution = m.execution;
      try {
        this.deps.bindNativeGoal!(execution.sessionId, execution.id, execution.objective!);
        m.sent = [execution.sessionId];
        m.pending = [execution.sessionId];
        await this.deps.controlNativeGoal!(execution.sessionId, "set", execution.objective);
        m.dispatching = false;
        if (m.stopRequested) await this.cancelOwnWork(m);
        else this.syncNativeGoal(m, this.deps.goalInfo?.(execution.sessionId)?.goal);
        return this.commit(m);
      } catch (e) {
        m.dispatching = false;
        m.stopRequested = true;
        execution.desiredState = "stopped";
        m.error = String(e);
        this.transition(m, "failed", "error", `native goal start failed: ${String(e)}`, "native-goal-start-failed");
        this.commit(m);
        await this.cancelOwnWork(m);
        this.commit(m);
        throw e;
      }
    }
    let result: ModeResult;
    try {
      result = await this.deps.dispatch(room, m.goal, { note: missionPrompt(m), missionId: m.id, goal: m.goal, acceptanceCriteria: [...m.acceptanceCriteria] });
    } catch (e) {
      m.dispatching = false;
      if (m.stopRequested) {
        this.log(m, "lifecycle", "dispatch aborted after stop request");
        await this.cancelOwnWork(m);
        this.commit(m);
        return snapshot(m);
      }
      this.transition(m, "failed", "error", `dispatch failed: ${String(e)}`, "dispatch-failed");
      m.error = String(e);
      this.commit(m);
      throw e;
    }
    m.dispatching = false;
    m.sent = [...(result?.sent ?? [])];
    m.pending = m.sent.filter((s) => !m.earlyDone.includes(s) && !m.turnErrors.some((t) => t.sid === s));
    const flow = this.flowOf(m.roomId);
    const flowId = flow?.flowId;
    // 只绑定本 mission 派发创建的 flow（missionId 打标），不按 roomId 认领外来 flow
    if (flowId && flowId !== m.baselineFlowId && flowOwnedBy(flow, m.id)) {
      // dispatch await 期间 syncFlow 可能已绑定同一 flow：不重复记 bound 事件
      const alreadyBound = m.flowId === flowId;
      m.flowId = flowId;
      m.flow = flow;
      m.lastPhase = flow?.phase ?? "";
      m.lastFlowSig = flowSig(flow);
      if (!alreadyBound) this.log(m, "flow", `bound flow ${flowId} (${m.lastPhase || "?"})`);
      this.applyFlowPhase(m, flow);
    }
    if (m.stopRequested) {
      await this.cancelOwnWork(m);
      return this.commit(m);
    }
    // dispatch 窗口内 syncFlow 可能已改过 status：按当前值判定（transition 不更新 TS 收窄）
    const curStatus = m.status as MissionStatus;
    if (!m.flowId && m.pending.length === 0 && !this.deps.hasActiveFlow(m.roomId) && (curStatus === "running" || curStatus === "waiting-user")) {
      if (m.sent.length === 0) {
        this.transition(m, "failed", "error", "dispatch produced no prompts and no flow", "dispatch-empty");
      } else {
        this.finishNoFlow(m);
      }
    }
    return this.commit(m);
  }

  private async cancelOwnWork(m: MissionRecord): Promise<void> {
    const errors: string[] = [];
    const execution = m.execution;
    if (execution?.mode === "native-goal") {
      if (execution.stopConfirmed || this.stoppingGoals.has(execution.id)) return;
      this.stoppingGoals.add(execution.id);
      execution.desiredState = "stopped";
      m.stopRequested = true;
      try {
        const info = this.deps.goalInfo?.(execution.sessionId);
        if (info?.goal && info.goal.objective !== execution.objective) {
          execution.stopConfirmed = true;
          this.deps.releaseNativeGoal?.(execution.sessionId, execution.id);
          return;
        }
        this.deps.bindNativeGoal?.(execution.sessionId, execution.id, execution.objective!);
        await this.deps.controlNativeGoal!(execution.sessionId, "clear");
        execution.goal = info?.goal?.status === "complete" ? info.goal : null;
        execution.stopConfirmed = true;
        this.deps.releaseNativeGoal?.(execution.sessionId, execution.id);
      } catch (e) {
        execution.stopConfirmed = false;
        m.error = `native goal cancellation not confirmed: ${String(e)}`;
        this.log(m, "error", m.error);
      } finally {
        this.stoppingGoals.delete(execution.id);
      }
      return;
    }
    const flow = this.flowOf(m.roomId);
    const flowId = flow?.flowId;
    if (m.flowId && flowId === m.flowId && this.deps.hasActiveFlow(m.roomId)) {
      try {
        await this.deps.cancelActive(m.roomId, `mission ${m.id} stopped`);
      } catch (e) {
        errors.push(`cancelActive: ${String(e)}`);
      }
    }
    for (const sid of [...new Set([...m.pending, ...m.sent])]) {
      if (this.deps.roomIdForTurn && this.deps.roomIdForTurn(sid) !== m.roomId) continue;
      if (!this.deps.isBusy(sid)) continue;
      try {
        await this.deps.cancel(sid);
      } catch (e) {
        errors.push(`cancel ${sid}: ${String(e)}`);
      }
    }
    if (errors.length > 0) {
      m.error = `${errors.join("; ")}; cancellation was requested only - already-applied changes are not rolled back`;
      this.log(m, "error", m.error);
    }
  }

  async stop(id: string, reason?: string): Promise<MissionSnapshot> {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status === "stopped" || (m.status === "failed" && m.execution?.mode === "native-goal")) {
      if (m.execution?.mode === "native-goal" && !m.execution.stopConfirmed) {
        await this.cancelOwnWork(m);
        return this.commit(m);
      }
      return snapshot(m);
    }
    if (TERMINAL.has(m.status)) throw new Error(`mission not stoppable: ${m.status}`);
    const wasActive = m.status === "running" || m.status === "waiting-user";
    m.stopRequested = true;
    if (m.execution?.mode === "native-goal") m.execution.desiredState = "stopped";
    this.transition(m, "stopped", "lifecycle", reason ? `stopped: ${reason}` : "stopped by user", "user-stopped");
    this.commit(m);
    if (!wasActive && m.execution?.mode !== "native-goal") return snapshot(m);
    await this.cancelOwnWork(m);
    if (m.execution?.mode === "native-goal") return this.commit(m);
    if (m.error) this.commit(m);
    return snapshot(m);
  }

  /**
   * 分级删除：draft/终态直删；running/waiting-user 须先 stop（force=true 先 cancelOwnWork 再删）；
   * awaiting-acceptance 须先终态化。重复删除幂等返回 deleted:true。
   * 轨迹（events/reviews/supplements）随 Map 条目释放；房史中的文本记录不受影响。
   */
  async delete(id: string, force = false): Promise<{ deleted: boolean }> {
    const m = this.missions.get(id);
    if (!m) return { deleted: true };
    if (m.execution?.mode === "native-goal" && !m.execution.stopConfirmed) {
      if ((m.status === "running" || m.status === "waiting-user") && !force)
        throw new Error(`mission active: stop first (or force): ${m.status}`);
      if (m.status === "awaiting-acceptance") throw new Error(`mission not deletable in status: ${m.status}`);
      if (m.status === "accepted" && this.deps.isBusy(m.execution.sessionId)) throw new Error("session busy; cannot clean up a completed native goal");
      m.stopRequested = true;
      m.execution.desiredState = "stopped";
      if (m.status === "running" || m.status === "waiting-user")
        this.transition(m, "stopped", "lifecycle", "stopped before deletion", "user-stopped");
      this.commit(m);
      await this.cancelOwnWork(m);
      this.commit(m);
      if (!m.execution.stopConfirmed) throw new Error("native goal stop not confirmed; mission retained");
    }
    if (m.status === "running" || m.status === "waiting-user") {
      if (!force) throw new Error(`mission active: stop first (or force): ${m.status}`);
      await this.cancelOwnWork(m);
    } else if (!TERMINAL.has(m.status) && m.status !== "draft") {
      throw new Error(`mission not deletable in status: ${m.status}`);
    }
    this.missions.delete(id);
    this.persist();
    return { deleted: true };
  }

  /** 房删除级联：清掉引用死房的孤儿工单（活动中的先尽力取消执行） */
  async onRoomRemoved(roomId: string): Promise<void> {
    let touched = false;
    for (const m of [...this.missions.values()]) {
      if (m.roomId !== roomId) continue;
      if (m.execution?.mode === "native-goal" && !m.execution.stopConfirmed) {
        m.stopRequested = true;
        m.execution.desiredState = "stopped";
        if (!TERMINAL.has(m.status)) this.transition(m, "stopped", "lifecycle", "room removed", "user-stopped");
        this.commit(m);
        await this.cancelOwnWork(m);
        if (!m.execution.stopConfirmed) { this.commit(m); continue; }
      }
      if (m.status === "running" || m.status === "waiting-user") {
        try { await this.cancelOwnWork(m); } catch { /* best effort */ }
      }
      this.missions.delete(m.id);
      touched = true;
    }
    if (touched) this.persist();
  }

  syncFlow(roomId: string, flow: Record<string, unknown> | undefined): void {
    const m = this.activeFor(roomId);
    if (!m) return;
    const fv = asFlowView(flow);
    const flowId = fv?.flowId;
    if (!m.flowId) {
      if (!flowId || flowId === m.baselineFlowId) return;
      // 无归属标记的 flow 不认领：同房间可能跑着与 mission 无关的编排
      if (!flowOwnedBy(fv, m.id)) return;
      if (!this.restoreDone) return;
      m.flowId = flowId;
      this.log(m, "flow", `bound flow ${flowId}`);
    }
    if (!fv || flowId !== m.flowId) {
      this.transition(m, "stopped", "flow", "bound flow cancelled or disappeared", "flow-lost");
      this.commit(m);
      return;
    }
    const sig = flowSig(fv);
    if (sig === m.lastFlowSig) return;
    m.lastFlowSig = sig;
    m.flow = fv;
    this.applyFlowPhase(m, fv);
    const room = this.deps.getRoom(roomId);
    if (room && this.deps.hasActiveFlow(roomId)) this.replayPendingSupplements(m, room);
    this.commit(m);
  }

  /** flow 绑定/恢复时重放未送达的补充，delivered:false 不再是死端 */
  private replayPendingSupplements(m: MissionRecord, room: Room): void {
    for (const sup of m.supplements) {
      if (sup.delivered) continue;
      try {
        if (this.deps.supplementActive(room, `User supplement to mission ${m.id}:\n${sup.text}`, m.id)) {
          sup.delivered = true;
          this.log(m, "supplement", `supplement ${sup.id} replayed to bound flow`);
        }
      } catch (e) {
        this.log(m, "error", `supplement ${sup.id} replay failed: ${String(e)}`.slice(0, 300));
      }
    }
  }

  private applyFlowPhase(m: MissionRecord, flow: FlowView): void {
    // 状态白名单守卫：仅活跃态响应 flow phase——awaiting-acceptance/终态不被拉回
    if (m.status !== "running" && m.status !== "waiting-user") return;
    const phase = flow.phase ?? "";
    if (phase !== m.lastPhase) {
      m.lastPhase = phase;
      this.log(m, "flow", `phase: ${phase || "unknown"}`);
    }
    const tasks = flow.tasks;
    const waitingUser =
      phase === "awaiting-input" ||
      phase === "awaiting-retry" ||
      flow.waitingFor === "user" ||
      tasks.some((t) => t.waitingFor === "user");
    if (phase === "done") {
      if (!flow.failureMessage && !tasks.some((t) => t.status === "failed") &&
          tasks.some((t) => t.status === "pending" || t.status === "running")) {
        m.error = "flow ended with unfinished tasks";
        this.transition(m, "waiting-user", "flow", m.error, "awaiting-retry");
        return;
      }
      const flowFailure = flow.failureMessage ? flow.failureMessage : undefined;
      const anyFailed = tasks.some((t) => t.status === "failed") || flowFailure !== undefined;
      m.output = summarizeFlow(flow);
      this.transition(
        m,
        anyFailed ? "failed" : "awaiting-acceptance",
        "flow",
        anyFailed ? "flow done with failed tasks" : "flow done",
        anyFailed ? "flow-tasks-failed" : undefined,
      );
      if (anyFailed) {
        const taskFailure = tasks.find((t) => t.status === "failed" && typeof t.failureMessage === "string");
        m.error = flowFailure ?? taskFailure?.failureMessage ?? "flow finished with failed tasks";
      }
    } else if (phase === "cancelled") {
      this.transition(m, "stopped", "flow", "flow cancelled", "flow-cancelled");
    } else if (waitingUser) {
      if (flow.failureMessage) m.error = flow.failureMessage;
      this.transition(
        m,
        "waiting-user",
        "flow",
        "flow waits for user",
        phase === "awaiting-retry" ? "awaiting-retry" : "awaiting-input",
      );
      if (phase === "awaiting-retry") this.maybeAutoRetry(m, flow);
    } else if (RUNNING_PHASES.has(phase)) {
      m.error = undefined;
      this.transition(m, "running", "flow", "flow active");
    }
    // 未识别 phase：白名单忽略——仅 lastPhase/事件轨迹更新，不迁移 status
  }

  private maybeAutoRetry(m: MissionRecord, flow: FlowView): void {
    if (!this.restoreDone || m.stopRequested || m.status !== "waiting-user") return;
    if (m.maxAutoRetries <= m.autoRetryCount) {
      if (m.maxAutoRetries > 0)
        this.log(m, "flow", `auto retries exhausted (${m.autoRetryCount}/${m.maxAutoRetries}); waiting for user`);
      return;
    }
    const blocked = retryEligibility(flow.tasks);
    if (blocked === "no-failed-tasks" || blocked === "waiting-user") return;
    if (blocked === "no-evidence") {
      this.log(m, "flow", "failed tasks lack recorded backend failure evidence; not auto-retrying");
      return;
    }
    const room = this.deps.getRoom(m.roomId);
    if (!room || !allMembersAvailable(room, (sid) => this.deps.isAvailable(sid))) {
      this.log(m, "flow", "room member unavailable; not auto-retrying");
      return;
    }
    const key = `${m.id}:${String(m.flowId)}:${m.autoRetryCount}`;
    if (this.retryScheduled.has(key)) return;
    this.retryScheduled.add(key);
    queueMicrotask(() => {
      try {
        // 双围栏第二段：microtask 内按当前快照原样重验（与预检同谓词）
        const cur = this.missions.get(m.id);
        if (!cur || cur.status !== "waiting-user" || cur.stopRequested || !this.restoreDone) return;
        if (cur.maxAutoRetries <= cur.autoRetryCount) return;
        const curFlow = this.flowOf(cur.roomId);
        if (!curFlow || curFlow.flowId !== cur.flowId || curFlow.phase !== "awaiting-retry") return;
        if (retryEligibility(curFlow.tasks) !== undefined) return;
        const curRoom = this.deps.getRoom(cur.roomId);
        if (!curRoom || !allMembersAvailable(curRoom, (sid) => this.deps.isAvailable(sid))) return;
        const curFailed = curFlow.tasks.filter((t) => t.status === "failed");
        cur.autoRetryCount += 1;
        this.log(cur, "flow", `auto retry ${cur.autoRetryCount}/${cur.maxAutoRetries}`);
        this.persist();
        let okRetry = false;
        try {
          okRetry = this.deps.retryFailedTasks(cur.roomId, curFailed.map((t) => t.id ?? ""));
        } catch (e) {
          this.log(cur, "error", `auto retry failed: ${String(e).slice(0, 200)}`);
        }
        if (okRetry) this.transition(cur, "running", "flow", "auto retry dispatched");
        else this.log(cur, "error", "auto retry declined by room orchestrator; waiting for user");
        this.commit(cur);
      } finally {
        this.retryScheduled.delete(key);
      }
    });
  }

  retry(id: string): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status !== "waiting-user" && m.status !== "running")
      throw new Error(`retry requires an active mission: ${m.status}`);
    const flow = this.flowOf(m.roomId);
    const flowId = flow?.flowId;
    if (!flow || !m.flowId || flowId !== m.flowId || flow.phase !== "awaiting-retry")
      throw new Error("no matching awaiting-retry flow for this mission");
    const failedIds = flow.tasks.filter((t) => t.status === "failed").map((t) => t.id ?? "");
    if (failedIds.length === 0) throw new Error("no failed tasks to retry");
    if (!this.deps.retryFailedTasks(m.roomId, failedIds)) {
      this.log(m, "error", "manual retry declined by room orchestrator; still waiting for user");
      this.commit(m);
      return snapshot(m);
    }
    this.transition(m, "running", "flow", "manual retry dispatched");
    return this.commit(m);
  }

  private ownsTurn(m: MissionRecord, sessionId: string): boolean {
    if (
      m.sent.includes(sessionId) ||
      m.pending.includes(sessionId) ||
      m.earlyDone.includes(sessionId)
    ) return true;
    if (m.flowId) {
      const tasks = m.flow?.tasks ?? [];
      if (tasks.some((t) => t.sessionId === sessionId)) return true;
    }
    if (m.dispatching && this.isRoomMember(m, sessionId)) {
      const key = `${m.id}:${sessionId}`;
      if (!this.broadAttrLogged.has(key)) {
        this.broadAttrLogged.add(key);
        this.log(m, "flow", `turn attributed via dispatch-window broad fallback: ${sessionId}`);
      }
      return true;
    }
    return false;
  }

  /** 该 session 当前回合归属的 mission id（房间回合视角），无则 undefined */
  missionIdForTurn(sessionId: string, roomId: string): string | undefined {
    const m = this.activeFor(roomId);
    return m && this.ownsTurn(m, sessionId) ? m.id : undefined;
  }

  private isRoomMember(m: MissionRecord, sessionId: string): boolean {
    const room = this.deps.getRoom(m.roomId);
    return !!room && room.members.some((mem) => mem.sessionId === sessionId);
  }

  private rescanBusy(m: MissionRecord): void {
    const room = this.deps.getRoom(m.roomId);
    if (!room) return;
    for (const mem of room.members) {
      if (!this.deps.isBusy(mem.sessionId)) continue;
      if (this.deps.roomIdForTurn && this.deps.roomIdForTurn(mem.sessionId) !== m.roomId) continue;
      if (!m.pending.includes(mem.sessionId)) m.pending.push(mem.sessionId);
      if (!m.sent.includes(mem.sessionId)) m.sent.push(mem.sessionId);
    }
  }

  private finishNoFlow(m: MissionRecord): void {
    if (m.turnErrors.length > 0) {
      m.error = m.turnErrors[0]!.message;
      this.transition(m, "failed", "error", `turn error on ${m.turnErrors[0]!.sid}: ${m.error.slice(0, 300)}`, "turn-error");
    } else {
      this.transition(m, "awaiting-acceptance", "output", "all dispatched turns completed");
    }
  }

  private nativeRecord(sessionId: string): MissionRecord | undefined {
    const owner = this.deps.nativeGoalOwner?.(sessionId);
    return [...this.missions.values()].find((m) => m.execution?.mode === "native-goal" &&
      m.execution.sessionId === sessionId && (owner ? m.execution.id === owner :
        (m.status === "running" || m.status === "waiting-user" || (m.stopRequested && !m.execution.stopConfirmed))));
  }

  nativeMissionForSession(sessionId: string): MissionSnapshot | undefined {
    const m = this.nativeRecord(sessionId);
    return m ? snapshot(m) : undefined;
  }

  reservesSession(sessionId: string): boolean {
    const m = this.nativeRecord(sessionId);
    return !!m && (m.status === "running" || m.status === "waiting-user" ||
      ((m.status !== "accepted" || m.stopRequested) && m.execution?.stopConfirmed === false));
  }

  private syncNativeGoal(m: MissionRecord, goal: GoalSnapshot | null | undefined): void {
    const e = m.execution!;
    e.actions = [...(this.deps.goalInfo?.(e.sessionId)?.capabilities.actions ?? [])];
    if (goal === undefined) {
      this.transition(m, "waiting-user", "lifecycle", "native goal state needs synchronization", "native-goal-reconnect");
    } else if (goal && goal.objective !== e.objective) {
      this.transition(m, "waiting-user", "lifecycle", "native goal was replaced outside this mission", "native-goal-replaced");
    } else {
      e.goal = goal;
      if (goal === null) {
        if (m.status !== "awaiting-acceptance")
          this.transition(m, "waiting-user", "lifecycle", "native goal cleared; execution outcome needs confirmation", "native-goal-cleared");
      } else if (goal.status === "complete") {
        if (!m.dispatching && !this.deps.isBusy(e.sessionId))
          this.transition(m, "awaiting-acceptance", "output", "native goal completed; human acceptance required");
      } else if (goal.status === "active") {
        if (m.reasonCode !== "native-goal-error") this.transition(m, "running", "lifecycle", "native goal active");
      } else {
        this.transition(m, "waiting-user", "lifecycle", `native goal ${goal.status}`, `native-goal-${goal.status}`);
      }
    }
  }

  onNativeGoal(sessionId: string, goal: GoalSnapshot | null): void {
    let m = this.nativeRecord(sessionId);
    if (!m && goal) {
      m = [...this.missions.values()].find((x) => x.execution?.mode === "native-goal" &&
        x.execution.sessionId === sessionId && x.execution.objective === goal.objective &&
        (x.status === "running" || x.status === "waiting-user"));
      if (m) {
        try { this.deps.bindNativeGoal?.(sessionId, m.execution!.id, m.execution!.objective!); } catch {}
      }
    }
    if (!m) return;
    if (m.stopRequested || TERMINAL.has(m.status)) {
      if (m.stopRequested && !m.execution!.stopConfirmed && goal?.objective === m.execution!.objective &&
          !this.stoppingGoals.has(m.execution!.id)) {
        void this.cancelOwnWork(m).finally(() => this.commit(m!));
      }
      return;
    }
    const before = JSON.stringify([m.status, m.reasonCode, m.execution]);
    this.syncNativeGoal(m, goal);
    if (before !== JSON.stringify([m.status, m.reasonCode, m.execution])) this.commit(m);
  }

  onNativeGoalError(sessionId: string, executionId: string, message: string): void {
    const m = this.nativeRecord(sessionId);
    if (!m || m.execution?.id !== executionId) return;
    m.execution.actions = [...(this.deps.goalInfo?.(sessionId)?.capabilities.actions ?? [])];
    if (TERMINAL.has(m.status)) { this.commit(m); return; }
    m.error = message;
    this.transition(m, "waiting-user", "error", message, "native-goal-error");
    this.commit(m);
  }

  async goalControl(id: string, action: unknown): Promise<MissionSnapshot> {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    const e = m.execution;
    if (e?.mode !== "native-goal" || !["pause", "resume", "clear"].includes(String(action)) ||
        !this.deps.goalInfo?.(e.sessionId)?.capabilities.actions.includes(action as GoalAction))
      throw new Error(`native goal action unsupported: ${String(action)}`);
    if (TERMINAL.has(m.status)) throw new Error(`mission not controllable: ${m.status}`);
    if (action === "clear" && (m.status === "running" || m.status === "waiting-user")) return this.stop(id);
    this.deps.bindNativeGoal?.(e.sessionId, e.id, e.objective!);
    await this.deps.controlNativeGoal!(e.sessionId, action as GoalAction);
    m.error = undefined;
    if (action === "resume" && m.reasonCode === "native-goal-error") m.reasonCode = undefined;
    this.syncNativeGoal(m, this.deps.goalInfo?.(e.sessionId)?.goal);
    if (action === "clear") {
      e.stopConfirmed = true;
      this.deps.releaseNativeGoal?.(e.sessionId, e.id);
    }
    return this.commit(m);
  }

  submitForReview(id: string): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    const e = m.execution;
    const goal = e ? this.deps.goalInfo?.(e.sessionId)?.goal : undefined;
    if (e?.mode !== "native-goal" || m.status !== "waiting-user" ||
        (goal !== null && goal?.status !== "complete") || this.deps.isBusy(e.sessionId))
      throw new Error("native execution must be idle and complete or cleared before review");
    this.transition(m, "awaiting-acceptance", "lifecycle", "user submitted native execution for human acceptance");
    return this.commit(m);
  }

  onTurnDone(sessionId: string, roomId: string | undefined, output: string): void {
    const native = this.nativeRecord(sessionId);
    if (native?.execution?.mode === "native-goal") {
      if (native.status !== "running" && native.status !== "waiting-user") return;
      native.pending = [];
      if (output.trim()) {
        native.output = [native.output, output].filter(Boolean).join("\n\n").slice(-OUTPUT_CAP);
        this.log(native, "output", `${sessionId}: ${output.slice(0, 200)}`);
      }
      this.syncNativeGoal(native, this.deps.goalInfo?.(sessionId)?.goal);
      this.commit(native);
      return;
    }
    const m = roomId ? this.activeFor(roomId) : this.findPending(sessionId);
    if (!m) return;
    if (!this.ownsTurn(m, sessionId)) return;
    m.pending = m.pending.filter((s) => s !== sessionId);
    if (m.dispatching) {
      if (!m.earlyDone.includes(sessionId) && this.isRoomMember(m, sessionId))
        m.earlyDone.push(sessionId);
    }
    this.log(m, "output", `${sessionId}: ${output.length > 200 ? `${output.slice(0, 200)}…` : output}`);
    const active = this.deps.hasActiveFlow(m.roomId);
    const flow = this.flowOf(m.roomId);
    const flowId = flow?.flowId;
    const ownFlow = !!flowId && flowOwnedBy(flow, m.id);
    // 明确归属他人且进行中的 flow 不再阻断本 mission 的回合收敛；
    // 活跃但视图缺席（auto 决策在途）或仅残留 done 快照时仍按原语义等待
    const foreignActive = active && !!flow && !ownFlow && flow.phase !== "done";
    if (m.flowId || (active && !foreignActive)) {
      if (!m.flowId && ownFlow && flowId !== m.baselineFlowId) {
        m.flowId = flowId;
        this.log(m, "flow", `bound flow ${flowId}`);
      }
      if (m.flowId && flow) this.syncFlow(m.roomId, flow);
      else this.commit(m);
      return;
    }
    if (m.dispatching) {
      this.commit(m);
      return;
    }
    this.rescanBusy(m);
    if (m.pending.length === 0) this.finishNoFlow(m);
    this.commit(m);
  }

  captureTurnContext(sessionId: string, roomId: string | undefined): MissionTurnContext | undefined {
    const m = roomId ? this.activeFor(roomId) : this.findPending(sessionId);
    if (!m || !this.ownsTurn(m, sessionId)) return undefined;
    const flow = m.flow ?? this.flowOf(m.roomId);
    const running = flow?.tasks.find((t) => t.sessionId === sessionId && t.status === "running");
    return {
      missionId: m.id,
      roomId: m.roomId,
      sessionId,
      ...(flow?.flowId ? { flowId: flow.flowId } : {}),
      ...(flow?.phase ? { phase: flow.phase } : {}),
      ...(running
        ? {
            taskId: running.id ?? "",
            ...(running.dispatchedAt !== undefined ? { dispatchedAt: running.dispatchedAt } : {}),
          }
        : {}),
    };
  }

  private writebackContextError(sessionId: string, message: string, context?: MissionTurnContext): void {
    if (!context) return;
    const m = this.missions.get(context.missionId);
    if (!m || m.roomId !== context.roomId || context.sessionId !== sessionId) return;
    if (m.flowId && context.flowId && m.flowId !== context.flowId) return;
    this.log(m, "error", `turn error on ${sessionId}: ${message.slice(0, 300)}`, context);
    if (!m.error || m.error === "flow finished with failed tasks") {
      m.error = message.slice(0, 1000);
    }
    this.commit(m);
  }

  onTurnError(sessionId: string, roomId: string | undefined, message: string, context?: MissionTurnContext): void {
    const native = this.nativeRecord(sessionId);
    if (native?.execution?.mode === "native-goal") {
      this.onNativeGoalError(sessionId, native.execution.id, message);
      return;
    }
    if (context !== undefined) {
      const target = this.contextTarget(sessionId, context);
      if (!target) return;
      if (this.activeFor(target.roomId) === target && this.ownsTurn(target, sessionId)) {
        this.applyTurnError(target, sessionId, message, context);
      } else {
        this.writebackContextError(sessionId, message, context);
      }
      return;
    }
    const m = roomId ? this.activeFor(roomId) : this.findPending(sessionId);
    if (!m) return;
    if (!this.ownsTurn(m, sessionId)) return;
    this.applyTurnError(m, sessionId, message, undefined);
  }

  private contextTarget(sessionId: string, context: MissionTurnContext): MissionRecord | undefined {
    const m = this.missions.get(context.missionId);
    if (!m || m.roomId !== context.roomId || context.sessionId !== sessionId) return undefined;
    if (m.flowId && context.flowId && m.flowId !== context.flowId) return undefined;
    if (context.taskId !== undefined) {
      const tasks = m.flow?.tasks ?? this.flowOf(m.roomId)?.tasks ?? [];
      const cur = tasks.find((t) => (t.id ?? "") === context.taskId && t.sessionId === sessionId);
      if (!cur) return undefined;
      if (context.dispatchedAt !== undefined && cur.dispatchedAt !== context.dispatchedAt) return undefined;
    }
    return m;
  }

  private applyTurnError(m: MissionRecord, sessionId: string, message: string, context: MissionTurnContext | undefined): void {
    m.pending = m.pending.filter((s) => s !== sessionId);
    if (!m.turnErrors.some((t) => t.sid === sessionId)) {
      m.turnErrors.push({ sid: sessionId, message });
    }
    const active = this.deps.hasActiveFlow(m.roomId);
    const flow = this.flowOf(m.roomId);
    const flowId = flow?.flowId;
    const ownFlow = !!flowId && flowOwnedBy(flow, m.id);
    const foreignActive = active && !!flow && !ownFlow && flow.phase !== "done";
    if (m.flowId || (active && !foreignActive) || m.dispatching) {
      if (!m.flowId && ownFlow && flowId !== m.baselineFlowId) {
        m.flowId = flowId;
        this.log(m, "flow", `bound flow ${flowId}`);
      }
      this.log(m, "error", `turn error on ${sessionId}: ${message.slice(0, 300)}`, context?.missionId === m.id ? context : undefined);
      this.commit(m);
      return;
    }
    this.rescanBusy(m);
    if (m.pending.length === 0) this.finishNoFlow(m);
    else this.log(m, "error", `turn error on ${sessionId}: ${message.slice(0, 300)}`, context?.missionId === m.id ? context : undefined);
    this.commit(m);
  }

  reconcile(): void {
    try {
      for (const m of this.missions.values()) {
        const pendingStop = m.execution?.mode === "native-goal" && m.stopRequested && !m.execution.stopConfirmed;
        if (m.status !== "running" && m.status !== "waiting-user" && !pendingStop) continue;
        try {
          if (m.execution?.mode === "native-goal") {
            const e = m.execution;
            const goal = this.deps.goalInfo?.(e.sessionId)?.goal;
            if (goal?.objective === e.objective) this.deps.bindNativeGoal?.(e.sessionId, e.id, e.objective!);
            if (pendingStop) {
              if (goal === null || (goal && goal.objective !== e.objective)) {
                e.stopConfirmed = true;
                this.deps.releaseNativeGoal?.(e.sessionId, e.id);
              } else if (goal?.objective === e.objective) {
                void this.cancelOwnWork(m).finally(() => this.commit(m));
              }
              this.commit(m);
              continue;
            }
            this.syncNativeGoal(m, goal);
            this.commit(m);
            continue;
          }
          const flow = this.flowOf(m.roomId);
          const flowId = flow?.flowId;
          // 认领依据：mission 显式持有的 flowId 匹配，或 flow 打标 missionId 归属
          // （派发窗口内崩溃导致 flowId 未落盘的场景可按归属恢复）；roomId 匹配不算数
          const bound = (!!m.flowId && flowId === m.flowId) || (!!flowId && flowOwnedBy(flow, m.id));
          // 归属匹配的 flow 不论是否仍活跃都走 syncFlow 正常映射：done/cancelled
          // 快照对应 awaiting-acceptance/failed/flow-cancelled，而非误落 interrupted-restart
          if (bound && flow) {
            if (!m.flowId && flowId) m.flowId = flowId;
            m.lastFlowSig = "";
            m.lastPhase = "";
            this.log(m, "flow", `resumed bound flow ${String(flowId)}`);
            this.syncFlow(m.roomId, flow);
            continue;
          }
          m.pending = [];
          this.transition(
            m,
            "stopped",
            "lifecycle",
            "interrupted by hub restart; matching flow lost or absent, not re-dispatched",
            "interrupted-restart",
          );
          this.commit(m);
        } catch (err) {
          // 单条记录恢复失败不中断整体 reconcile，也不阻断 restoreDone 置位
          logError(`mission reconcile ${m.id}`, err);
          try {
            this.log(m, "error", `restore reconcile failed: ${String(err)}`);
          } catch {}
        }
      }
    } finally {
      this.restoreDone = true;
    }
  }

  review(id: string, input: {
    index?: unknown;
    verdict?: unknown;
    taskIds?: unknown;
    note?: unknown;
  }): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status !== "awaiting-acceptance") throw new Error(`review requires awaiting-acceptance: ${m.status}`);
    const index = input.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= m.acceptanceCriteria.length)
      throw new Error(`invalid criterion index: ${String(index)}`);
    const verdict = String(input.verdict ?? "");
    if (!VERDICTS.has(verdict)) throw new Error(`invalid verdict: ${verdict}`);
    const taskIds = stringList(input.taskIds, "taskIds");
    const flowTasks = m.flow?.tasks ?? [];
    const validIds = new Set(flowTasks.map((t) => t.id ?? ""));
    for (const tid of taskIds) {
      if (!validIds.has(tid)) throw new Error(`taskId not in bound flow: ${tid}`);
    }
    if (typeof input.note !== "string") throw new Error("note must be a string");
    const note = input.note.trim();
    if (verdict === "pass" && !note) throw new Error("pass requires a non-empty human note");
    const review: MissionCriterionReview = {
      index,
      verdict: verdict as MissionCriterionReview["verdict"],
      taskIds,
      note,
      at: Date.now(),
    };
    const i = m.reviews.findIndex((r) => r.index === index);
    if (i >= 0) m.reviews[i] = review;
    else m.reviews.push(review);
    this.log(m, "review", `criterion ${index + 1}: ${verdict}${taskIds.length ? ` (tasks: ${taskIds.join(",")})` : ""}`);
    return this.commit(m);
  }

  accept(id: string, note?: unknown): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status === "accepted") return snapshot(m);
    if (m.status !== "awaiting-acceptance") throw new Error(`accept requires awaiting-acceptance: ${m.status}`);
    if (m.execution?.mode === "native-goal") {
      const goal = this.deps.goalInfo?.(m.execution.sessionId)?.goal;
      if ((goal !== null && (goal?.status !== "complete" || goal.objective !== m.execution.objective)) ||
          this.deps.isBusy(m.execution.sessionId)) throw new Error("native goal is not quiescent; acceptance must wait");
    }
    if (m.reviews.length < m.acceptanceCriteria.length ||
        m.acceptanceCriteria.some((_, i) => m.reviews.find((r) => r.index === i)?.verdict !== "pass"))
      throw new Error("all acceptance criteria must be manually passed first");
    // acceptance.at 先落定，transition 再把 finishedAt 推到验收时刻（≥ acceptance.at）
    m.acceptance = { at: Date.now(), note: typeof note === "string" ? note.trim() : "" };
    this.transition(m, "accepted", "lifecycle", "accepted by user");
    if (m.execution?.mode === "native-goal") this.deps.releaseNativeGoal?.(m.execution.sessionId, m.execution.id);
    return this.commit(m);
  }

  rework(id: string, note?: unknown): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (typeof note !== "string" || !note.trim()) throw new Error("rework requires a non-empty reason");
    if (m.status !== "awaiting-acceptance" && m.status !== "failed" && m.status !== "stopped")
      throw new Error(`rework requires a closed mission: ${m.status}`);
    // 先创建子 draft（完成全部校验），成功后再关闭原任务：失败时零副作用；
    // parent/reworkReason 随 create 入参写入，保证首帧广播即带 parent 字段
    const draft = this.create({
      roomId: m.roomId,
      goal: m.goal,
      acceptanceCriteria: m.acceptanceCriteria,
      scope: m.scope,
      constraints: m.constraints,
      ownerSessionId: m.ownerSessionId,
      maxAutoRetries: m.maxAutoRetries,
      parentMissionId: m.id,
      reworkReason: note.trim(),
    });
    const nm = this.missions.get(draft.id)!;
    this.log(nm, "rework", `rework of ${m.id}: ${note.trim().slice(0, 300)}`);
    if (m.status === "awaiting-acceptance") {
      this.transition(m, "stopped", "lifecycle", "closed for rework", "closed-for-rework");
    }
    this.log(m, "rework", `rework requested: ${note.trim().slice(0, 300)}`);
    this.commit(m);
    return this.commit(nm);
  }

  async supplement(id: string, text?: unknown): Promise<MissionSnapshot> {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (m.status !== "running" && m.status !== "waiting-user")
      throw new Error(`supplement requires an active mission: ${m.status}`);
    if (typeof text !== "string" || !text.trim()) throw new Error("text required");
    const room = this.deps.getRoom(m.roomId);
    if (!room) throw new Error(`unknown room: ${m.roomId}`);
    const t = text.trim();
    // 归属预检：明确归属他人的活跃 flow 显式失败，补充不得被他人流程吞掉；
    // 无标记（兼容旧 flow）或本 mission 的 flow 维持 supplementActive 吸收语义
    const flow = this.flowOf(m.roomId);
    const flowOwner = flow?.phase !== "done" ? flowOwnerOf(flow) : undefined;
    if (this.deps.hasActiveFlow(m.roomId) && flowOwner !== undefined && flowOwner !== m.id)
      throw new Error(`room already occupied by an active flow of mission ${flowOwner}`);
    const sup: MissionSupplement = {
      id: `sp_${randomUUID().slice(0, 8)}`,
      at: Date.now(),
      text: t,
      delivered: false,
      delivery: "recorded",
    };
    m.supplements.push(sup);
    m.updatedAt = Date.now();
    this.persist();
    if (m.execution?.mode === "native-goal") {
      try {
        const delivery = await this.deps.supplementNativeGoal?.(m.execution.sessionId, t) ?? false;
        sup.delivered = delivery === true || delivery === "delivered";
        sup.delivery = sup.delivered ? "delivered" : delivery === "queued" ? "queued" : "recorded";
      } catch (e) {
        this.log(m, "error", `native goal supplement failed: ${String(e)}`);
      }
      this.log(m, "supplement", `native goal supplement ${sup.delivery ?? "recorded"}`);
      return this.commit(m);
    }
    const flowId = flow?.flowId;
    const bound = !!m.flowId && flowId === m.flowId && this.deps.hasActiveFlow(m.roomId);
    if (bound) {
      try {
        if (this.deps.supplementActive(room, `User supplement to mission ${m.id}:\n${t}`, m.id)) {
          sup.delivered = true;
          sup.delivery = "queued";
        }
      } catch (e) {
        // 补充投递失败是操作级故障，不覆写 mission 级 m.error
        this.log(m, "error", `supplement dispatch failed: ${String(e)}`.slice(0, 300));
      }
    }
    this.log(
      m,
      "supplement",
      sup.delivered
        ? "supplement delivered to active flow"
        : "supplement recorded; in-flight execution is not guaranteed to adopt it",
    );
    return this.commit(m);
  }

  private findPending(sessionId: string): MissionRecord | undefined {
    for (const m of this.missions.values()) {
      if ((m.status === "running" || m.status === "waiting-user") && m.pending.includes(sessionId))
        return m;
    }
    return undefined;
  }
}

function summarizeFlow(flow: FlowView): string {
  const lines = flow.tasks.map((t) => {
    const name = t.name ?? t.id ?? "";
    const status = t.status ?? "";
    const out = t.output ? ` ${t.output.slice(0, 200)}` : "";
    return `${name} [${status}]${out}`;
  });
  const text = lines.join("\n").trim();
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}…` : text;
}

/** m.output 单写者语义：仅 summarizeFlow（flow done）写终态交付摘要；
 *  回合过程片段走 events(kind:"output") 审计轨迹，不占 output 字段 */
