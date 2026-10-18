import { randomUUID } from "node:crypto";
import { logError } from "./logger.js";
import type { Room } from "./room.js";
import type { ModeResult } from "./room-modes.js";
import type { Store } from "./store.js";

export type MissionStatus =
  | "draft"
  | "running"
  | "waiting-user"
  | "awaiting-acceptance"
  | "accepted"
  | "stopped"
  | "failed";

export type MissionEvent = { id: string; at: number; kind: string; text: string };

export type MissionCriterionReview = {
  index: number;
  verdict: "pass" | "fail" | "unverified";
  taskIds: string[];
  note: string;
  source: "user";
  at: number;
};

export type MissionSupplement = {
  id: string;
  at: number;
  text: string;
  delivered: boolean;
};

export type Mission = {
  id: string;
  roomId: string;
  goal: string;
  acceptanceCriteria: string[];
  scope: string;
  constraints: string[];
  ownerSessionId: string;
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
};

export type MissionSnapshot = Mission;

type MissionRecord = Mission & {
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
    options?: { note?: string },
  ): Promise<ModeResult>;
  cancelActive(roomId: string, reason?: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  retryFailedTasks(roomId: string, taskIds?: string[]): boolean;
  supplementActive(room: Room, text: string): boolean;
  broadcast(method: string, params: Record<string, unknown>): void;
};

const META_KEY = "missions.v1";
const OUTPUT_CAP = 4000;
const OCCUPYING: ReadonlySet<MissionStatus> = new Set([
  "running",
  "waiting-user",
  "awaiting-acceptance",
]);
const TERMINAL: ReadonlySet<MissionStatus> = new Set(["accepted", "stopped", "failed"]);
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
    source: "user" as const,
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
    return { id: ev.id, at: ev.at, kind: String(ev.kind ?? ""), text: String(ev.text ?? "") };
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
        note: typeof rv.note === "string" ? rv.note : "",
        source: "user" as const,
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
  if (typeof m.flow === "object" && m.flow !== null) inner.flow = m.flow as Record<string, unknown>;
  if (str(m.output) !== undefined) inner.output = str(m.output);
  if (str(m.error) !== undefined) inner.error = str(m.error);
  if (acceptance) inner.acceptance = acceptance;
  if (str(m.parentMissionId) !== undefined) inner.parentMissionId = str(m.parentMissionId);
  if (str(m.baselineFlowId) !== undefined) inner.baselineFlowId = str(m.baselineFlowId);
  return inner;
}

const INTERNAL_KEYS = new Set([
  "sent",
  "pending",
  "baselineFlowId",
  "dispatching",
  "stopRequested",
  "earlyDone",
  "turnErrors",
  "lastPhase",
  "lastFlowSig",
]);

function snapshot(m: MissionRecord): MissionSnapshot {
  const pub = Object.fromEntries(
    Object.entries(m).filter(([k]) => !INTERNAL_KEYS.has(k)),
  ) as Mission;
  return {
    ...pub,
    acceptanceCriteria: [...m.acceptanceCriteria],
    constraints: [...m.constraints],
    events: m.events.map((e) => ({ ...e })),
    reviews: m.reviews.map((r) => ({ ...r, taskIds: [...r.taskIds] })),
    supplements: m.supplements.map((s) => ({ ...s })),
    ...(m.flow ? { flow: JSON.parse(JSON.stringify(m.flow)) as Record<string, unknown> } : {}),
    ...(m.acceptance ? { acceptance: { ...m.acceptance } } : {}),
  };
}

export class MissionManager {
  private missions = new Map<string, MissionRecord>();
  private retryScheduled = new Set<string>();
  private restoreDone = true;

  beginRestore(): void {
    this.restoreDone = false;
  }

  constructor(private deps: MissionDeps) {
    const raw = deps.store.getMeta(META_KEY);
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${META_KEY}: persisted payload is not valid JSON: ${String(e)}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${META_KEY}: persisted payload must be an array`);
    for (const item of parsed) {
      const rec = validateRecord(item);
      this.missions.set(rec.id, rec);
    }
  }

  private persist(): void {
    this.deps.store.setMeta(META_KEY, JSON.stringify([...this.missions.values()]));
  }

  private log(m: MissionRecord, kind: string, text: string): void {
    m.events.push({ id: `e${randomUUID().slice(0, 8)}`, at: Date.now(), kind, text });
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

  private transition(m: MissionRecord, status: MissionStatus, kind: string, text: string): void {
    if (m.status === status) return;
    m.status = status;
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
  }): MissionSnapshot {
    const roomId = optString(input.roomId, "roomId");
    if (!roomId) throw new Error("roomId required");
    const room = this.deps.getRoom(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
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
    this.log(m, "lifecycle", "draft created");
    this.missions.set(m.id, m);
    return this.commit(m);
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
    m.reviews = defaultReviews(c.acceptanceCriteria);
    this.log(m, "lifecycle", "contract updated");
    return this.commit(m);
  }

  list(roomId?: string): MissionSnapshot[] {
    return [...this.missions.values()]
      .filter((m) => roomId === undefined || m.roomId === roomId)
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
    if (m.status !== "draft") throw new Error(`mission not startable: ${m.status}`);
    const room = this.deps.getRoom(m.roomId);
    if (!room) throw new Error(`unknown room: ${m.roomId}`);
    if (!room.members.some((mem) => mem.sessionId === m.ownerSessionId))
      throw new Error(`owner is not a room member: ${m.ownerSessionId}`);
    for (const mem of room.members) {
      if (!this.deps.isAvailable(mem.sessionId))
        throw new Error(`member session not connected: ${mem.sessionId}`);
    }
    for (const other of this.missions.values()) {
      if (other.id !== m.id && other.roomId === m.roomId && OCCUPYING.has(other.status))
        throw new Error(`room already occupied by mission ${other.id}`);
    }
    if (this.deps.hasActiveFlow(m.roomId)) throw new Error("room has an active flow");
    for (const mem of room.members) {
      if (this.deps.isBusy(mem.sessionId)) throw new Error(`member busy: ${mem.name}`);
    }
    const baseline = this.deps.getFlow(m.roomId);
    m.baselineFlowId = typeof baseline?.flowId === "string" ? baseline.flowId : undefined;
    m.status = "running";
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
    this.log(m, "lifecycle", "started");
    this.commit(m);
    let result: ModeResult;
    try {
      result = await this.deps.dispatch(room, m.goal, { note: missionPrompt(m) });
    } catch (e) {
      m.dispatching = false;
      if (m.stopRequested) {
        this.log(m, "lifecycle", "dispatch aborted after stop request");
        await this.cancelOwnWork(m);
        this.commit(m);
        return snapshot(m);
      }
      this.transition(m, "failed", "error", `dispatch failed: ${String(e)}`);
      m.error = String(e);
      this.commit(m);
      throw e;
    }
    m.dispatching = false;
    m.sent = [...(result?.sent ?? [])];
    m.pending = m.sent.filter((s) => !m.earlyDone.includes(s) && !m.turnErrors.some((t) => t.sid === s));
    const flow = this.deps.getFlow(m.roomId);
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
    if (flowId && flowId !== m.baselineFlowId) {
      // dispatch await 期间 syncFlow 可能已绑定同一 flow：不重复记 bound 事件
      const alreadyBound = m.flowId === flowId;
      m.flowId = flowId;
      if (flow) m.flow = flow;
      m.lastPhase = flow ? String(flow.phase ?? "") : "";
      m.lastFlowSig = JSON.stringify(flow);
      if (!alreadyBound) this.log(m, "flow", `bound flow ${flowId} (${m.lastPhase || "?"})`);
      if (flow) this.applyFlowPhase(m, flow);
    }
    if (m.stopRequested) {
      await this.cancelOwnWork(m);
      return this.commit(m);
    }
    if (!m.flowId && m.pending.length === 0 && !this.deps.hasActiveFlow(m.roomId) && (m.status === "running" || m.status === "waiting-user")) {
      if (m.sent.length === 0) {
        this.transition(m, "failed", "error", "dispatch produced no prompts and no flow");
      } else {
        this.finishNoFlow(m);
      }
    }
    return this.commit(m);
  }

  private async cancelOwnWork(m: MissionRecord): Promise<void> {
    const errors: string[] = [];
    const flow = this.deps.getFlow(m.roomId);
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
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
    if (m.status === "stopped") return snapshot(m);
    if (TERMINAL.has(m.status)) throw new Error(`mission not stoppable: ${m.status}`);
    const wasActive = m.status === "running" || m.status === "waiting-user";
    m.stopRequested = true;
    this.transition(m, "stopped", "lifecycle", reason ? `stopped: ${reason}` : "stopped by user");
    this.commit(m);
    if (!wasActive) return snapshot(m);
    await this.cancelOwnWork(m);
    if (m.error) this.commit(m);
    return snapshot(m);
  }

  syncFlow(roomId: string, flow: Record<string, unknown> | undefined): void {
    const m = this.activeFor(roomId);
    if (!m) return;
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
    if (!m.flowId) {
      if (!flowId || flowId === m.baselineFlowId) return;
      if (!this.restoreDone) return;
      m.flowId = flowId;
      this.log(m, "flow", `bound flow ${flowId}`);
    }
    if (!flow || flowId !== m.flowId) {
      this.transition(m, "stopped", "flow", "bound flow cancelled or disappeared");
      this.commit(m);
      return;
    }
    const sig = JSON.stringify(flow);
    if (sig === m.lastFlowSig) return;
    m.lastFlowSig = sig;
    m.flow = flow;
    this.applyFlowPhase(m, flow);
    this.commit(m);
  }

  private applyFlowPhase(m: MissionRecord, flow: Record<string, unknown>): void {
    if (TERMINAL.has(m.status)) return;
    const phase = String(flow.phase ?? "");
    if (phase !== m.lastPhase) {
      m.lastPhase = phase;
      this.log(m, "flow", `phase: ${phase || "unknown"}`);
    }
    const tasks = Array.isArray(flow.tasks) ? (flow.tasks as Record<string, unknown>[]) : [];
    const waitingUser =
      phase === "awaiting-input" ||
      phase === "awaiting-retry" ||
      flow.waitingFor === "user" ||
      tasks.some((t) => t.waitingFor === "user");
    if (phase === "done") {
      const anyFailed = tasks.some((t) => t.status === "failed");
      m.output = summarizeFlow(flow);
      this.transition(
        m,
        anyFailed ? "failed" : "awaiting-acceptance",
        "flow",
        anyFailed ? "flow done with failed tasks" : "flow done",
      );
      if (anyFailed) m.error = "flow finished with failed tasks";
    } else if (phase === "cancelled") {
      this.transition(m, "stopped", "flow", "flow cancelled");
    } else if (waitingUser) {
      this.transition(m, "waiting-user", "flow", "flow waits for user");
      if (phase === "awaiting-retry") this.maybeAutoRetry(m, flow);
    } else {
      this.transition(m, "running", "flow", "flow active");
    }
  }

  private maybeAutoRetry(m: MissionRecord, flow: Record<string, unknown>): void {
    if (!this.restoreDone || m.stopRequested || m.status !== "waiting-user") return;
    if (m.maxAutoRetries <= m.autoRetryCount) {
      if (m.maxAutoRetries > 0)
        this.log(m, "flow", `auto retries exhausted (${m.autoRetryCount}/${m.maxAutoRetries}); waiting for user`);
      return;
    }
    const tasks = Array.isArray(flow.tasks) ? (flow.tasks as Record<string, unknown>[]) : [];
    const failedTasks = tasks.filter((t) => t.status === "failed");
    if (failedTasks.length === 0) return;
    const evidenced = failedTasks.every((t) => {
      const runs = Array.isArray(t.backendRuns) ? (t.backendRuns as Record<string, unknown>[]) : [];
      return runs.some(
        (r) => r.status === "failed" &&
          typeof r.exitCode === "number" && Number.isFinite(r.exitCode) && r.exitCode !== 0,
      );
    });
    if (!evidenced) {
      this.log(m, "flow", "failed tasks lack recorded backend failure evidence; not auto-retrying");
      return;
    }
    if (tasks.some((t) => t.waitingFor === "user")) return;
    const room = this.deps.getRoom(m.roomId);
    if (!room || !room.members.every((mem) => this.deps.isAvailable(mem.sessionId))) {
      this.log(m, "flow", "room member unavailable; not auto-retrying");
      return;
    }
    const key = `${m.id}:${String(m.flowId)}:${m.autoRetryCount}`;
    if (this.retryScheduled.has(key)) return;
    this.retryScheduled.add(key);
    queueMicrotask(() => {
      try {
        const cur = this.missions.get(m.id);
        if (!cur || cur.status !== "waiting-user" || cur.stopRequested || !this.restoreDone) return;
        if (cur.maxAutoRetries <= cur.autoRetryCount) return;
        const curFlow = this.deps.getFlow(cur.roomId);
        const curFlowId = typeof curFlow?.flowId === "string" ? curFlow.flowId : undefined;
        if (curFlowId !== cur.flowId || String(curFlow?.phase ?? "") !== "awaiting-retry") return;
        const curTasks = Array.isArray(curFlow?.tasks) ? (curFlow.tasks as Record<string, unknown>[]) : [];
        const curFailed = curTasks.filter((t) => t.status === "failed");
        if (curFailed.length === 0) return;
        if (curTasks.some((t) => t.waitingFor === "user")) return;
        const stillEvidenced = curFailed.every((t) => {
          const runs = Array.isArray(t.backendRuns) ? (t.backendRuns as Record<string, unknown>[]) : [];
          return runs.some((r) => r.status === "failed" && typeof r.exitCode === "number" && Number.isFinite(r.exitCode) && r.exitCode !== 0);
        });
        if (!stillEvidenced) return;
        const curRoom = this.deps.getRoom(cur.roomId);
        if (!curRoom || !curRoom.members.every((mem) => this.deps.isAvailable(mem.sessionId))) return;
        cur.autoRetryCount += 1;
        this.log(cur, "flow", `auto retry ${cur.autoRetryCount}/${cur.maxAutoRetries}`);
        this.persist();
        let okRetry = false;
        try {
          okRetry = this.deps.retryFailedTasks(cur.roomId, curFailed.map((t) => String(t.id ?? "")));
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
    const flow = this.deps.getFlow(m.roomId);
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
    if (!flow || !m.flowId || flowId !== m.flowId || String(flow.phase ?? "") !== "awaiting-retry")
      throw new Error("no matching awaiting-retry flow for this mission");
    const tasks = Array.isArray(flow.tasks) ? (flow.tasks as Record<string, unknown>[]) : [];
    const failedIds = tasks.filter((t) => t.status === "failed").map((t) => String(t.id ?? ""));
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
      const tasks = Array.isArray(m.flow?.tasks) ? (m.flow!.tasks as Record<string, unknown>[]) : [];
      if (tasks.some((t) => t.sessionId === sessionId)) return true;
    }
    if (m.dispatching && this.isRoomMember(m, sessionId)) return true;
    return false;
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
      this.transition(m, "failed", "error", `turn error on ${m.turnErrors[0]!.sid}: ${m.error.slice(0, 300)}`);
    } else {
      this.transition(m, "awaiting-acceptance", "output", "all dispatched turns completed");
    }
  }

  onTurnDone(sessionId: string, roomId: string | undefined, output: string): void {
    const m = roomId ? this.activeFor(roomId) : this.findPending(sessionId);
    if (!m) return;
    if (!this.ownsTurn(m, sessionId)) return;
    m.pending = m.pending.filter((s) => s !== sessionId);
    if (m.dispatching) {
      if (!m.earlyDone.includes(sessionId) && this.isRoomMember(m, sessionId))
        m.earlyDone.push(sessionId);
    }
    appendOutput(m, sessionId, output);
    if (m.flowId || this.deps.hasActiveFlow(m.roomId)) {
      const flow = this.deps.getFlow(m.roomId);
      const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
      if (!m.flowId && flowId && flowId !== m.baselineFlowId) {
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

  onTurnError(sessionId: string, roomId: string | undefined, message: string): void {
    const m = roomId ? this.activeFor(roomId) : this.findPending(sessionId);
    if (!m) return;
    if (!this.ownsTurn(m, sessionId)) return;
    m.pending = m.pending.filter((s) => s !== sessionId);
    if (!m.turnErrors.some((t) => t.sid === sessionId)) {
      m.turnErrors.push({ sid: sessionId, message });
    }
    if (m.flowId || this.deps.hasActiveFlow(m.roomId) || m.dispatching) {
      this.log(m, "error", `turn error on ${sessionId}: ${message.slice(0, 300)}`);
      this.commit(m);
      return;
    }
    this.rescanBusy(m);
    if (m.pending.length === 0) this.finishNoFlow(m);
    else this.log(m, "error", `turn error on ${sessionId}: ${message.slice(0, 300)}`);
    this.commit(m);
  }

  reconcile(): void {
    try {
      for (const m of this.missions.values()) {
        if (m.status !== "running" && m.status !== "waiting-user") continue;
        try {
          const flow = this.deps.getFlow(m.roomId);
          const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
          const active = this.deps.hasActiveFlow(m.roomId);
          if (m.flowId && active && flowId === m.flowId) {
            m.lastFlowSig = "";
            m.lastPhase = "";
            this.syncFlow(m.roomId, flow);
            continue;
          }
          m.pending = [];
          this.transition(
            m,
            "stopped",
            "lifecycle",
            "interrupted by hub restart; matching flow lost or absent, not re-dispatched",
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
    const flowTasks = Array.isArray(m.flow?.tasks) ? (m.flow!.tasks as Record<string, unknown>[]) : [];
    const validIds = new Set(flowTasks.map((t) => String(t.id ?? "")));
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
      source: "user",
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
    if (m.reviews.length < m.acceptanceCriteria.length ||
        m.acceptanceCriteria.some((_, i) => m.reviews.find((r) => r.index === i)?.verdict !== "pass"))
      throw new Error("all acceptance criteria must be manually passed first");
    m.status = "accepted";
    m.acceptance = { at: Date.now(), note: typeof note === "string" ? note.trim() : "" };
    this.log(m, "lifecycle", "accepted by user");
    return this.commit(m);
  }

  rework(id: string, note?: unknown): MissionSnapshot {
    const m = this.missions.get(id);
    if (!m) throw new Error(`unknown mission: ${id}`);
    if (typeof note !== "string" || !note.trim()) throw new Error("rework requires a non-empty reason");
    if (m.status !== "awaiting-acceptance" && m.status !== "failed" && m.status !== "stopped")
      throw new Error(`rework requires a closed mission: ${m.status}`);
    // 先创建子 draft（完成全部校验），成功后再关闭原任务：失败时零副作用
    const draft = this.create({
      roomId: m.roomId,
      goal: m.goal,
      acceptanceCriteria: m.acceptanceCriteria,
      scope: m.scope,
      constraints: m.constraints,
      ownerSessionId: m.ownerSessionId,
      maxAutoRetries: m.maxAutoRetries,
    });
    const nm = this.missions.get(draft.id)!;
    nm.parentMissionId = m.id;
    nm.reworkReason = note.trim();
    this.log(nm, "rework", `rework of ${m.id}: ${note.trim().slice(0, 300)}`);
    if (m.status === "awaiting-acceptance") {
      this.transition(m, "stopped", "lifecycle", "closed for rework");
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
    const sup: MissionSupplement = {
      id: `sp_${randomUUID().slice(0, 8)}`,
      at: Date.now(),
      text: t,
      delivered: false,
    };
    m.supplements.push(sup);
    m.updatedAt = Date.now();
    this.persist();
    const flow = this.deps.getFlow(m.roomId);
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : undefined;
    const bound = !!m.flowId && flowId === m.flowId && this.deps.hasActiveFlow(m.roomId);
    if (bound) {
      try {
        if (this.deps.supplementActive(room, `User supplement to mission ${m.id}:\n${t}`)) {
          sup.delivered = true;
        }
      } catch (e) {
        m.error = `supplement dispatch failed: ${String(e)}`;
        this.log(m, "error", m.error.slice(0, 300));
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

function summarizeFlow(flow: Record<string, unknown>): string {
  const tasks = Array.isArray(flow.tasks) ? (flow.tasks as Record<string, unknown>[]) : [];
  const lines = tasks.map((t) => {
    const name = String(t.name ?? t.id ?? "");
    const status = String(t.status ?? "");
    const out = typeof t.output === "string" ? ` ${t.output.slice(0, 200)}` : "";
    return `${name} [${status}]${out}`;
  });
  const text = lines.join("\n").trim();
  return text.length > OUTPUT_CAP ? `${text.slice(0, OUTPUT_CAP)}…` : text;
}

function appendOutput(m: MissionRecord, sessionId: string, output: string): void {
  const snippet = output.trim().slice(0, 500);
  if (!snippet) return;
  const line = `${sessionId}: ${snippet}`;
  const prev = m.output ? `${m.output}\n` : "";
  const merged = `${prev}${line}`;
  m.output = merged.length > OUTPUT_CAP ? merged.slice(merged.length - OUTPUT_CAP) : merged;
}
