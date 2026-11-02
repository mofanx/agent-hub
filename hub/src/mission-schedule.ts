import type { Room } from "./room.js";
import type { MissionSnapshot } from "./mission.js";
import {
  EVENT_WAKE_KINDS,
  type EventTrigger,
  type MissionTemplate,
  type ScheduledTask,
} from "./scheduler.js";

/** task.create 入参校验：eventTrigger 仅房作用域、事件名白名单、数值字段合法 */
export function parseEventTrigger(raw: unknown, targetType: string): EventTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (targetType !== "room") throw new Error("eventTrigger requires room target");
  if (typeof raw !== "object") throw new Error("eventTrigger must be an object");
  const t = raw as Record<string, unknown>;
  const events = Array.isArray(t.events) ? t.events.map((x) => String(x)) : [];
  if (!events.length) throw new Error("eventTrigger.events required");
  for (const e of events) {
    if (!(EVENT_WAKE_KINDS as readonly string[]).includes(e))
      throw new Error(`unknown wake event: ${e}`);
  }
  const out: EventTrigger = { events: [...new Set(events)] };
  if (t.debounceMs !== undefined) {
    const d = Number(t.debounceMs);
    if (!Number.isFinite(d) || d < 0) throw new Error("eventTrigger.debounceMs invalid");
    out.debounceMs = d;
  }
  if (t.maxPerHour !== undefined) {
    const c = Number(t.maxPerHour);
    if (!Number.isInteger(c) || c <= 0) throw new Error("eventTrigger.maxPerHour invalid");
    out.maxPerHour = c;
  }
  return out;
}

/**
 * 事件唤醒账本：同一任务 debounceMs 窗口内只放行一次，滑动小时窗内最多 maxPerHour 次。
 * 普通对话不产生唤醒——只有显式配置 eventTrigger 且事件名白名单命中的任务才会到 admit。
 */
export class EventWakeBook {
  private state = new Map<string, { lastAt: number; hourStart: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  admit(taskId: string, debounceMs = 30_000, maxPerHour = 6): boolean {
    const n = this.now();
    let st = this.state.get(taskId);
    if (!st || n - st.hourStart >= 3_600_000) {
      st = { lastAt: 0, hourStart: n, count: 0 };
      this.state.set(taskId, st);
    }
    // count>0 才说明本窗口内已放行过——lastAt=0 的初始态不能当"刚触发"判
    if ((st.count > 0 && n - st.lastAt < debounceMs) || st.count >= maxPerHour) return false;
    st.lastAt = n;
    st.count += 1;
    return true;
  }

  drop(taskId: string): void {
    this.state.delete(taskId);
  }
}

export type MissionTaskDeps = {
  getRoom(roomId: string): Room | undefined;
  hasActiveFlow(roomId: string): boolean;
  isMemberBusy(sessionId: string): boolean;
  isAvailable(sessionId: string): boolean;
  activeMissions(roomId: string): MissionSnapshot[];
  createMission(input: {
    roomId: string;
    goal: string;
    acceptanceCriteria: string[];
    scope: string;
    constraints: string[];
    ownerSessionId: string;
    maxAutoRetries: number;
  }): MissionSnapshot;
  startMission(id: string): Promise<MissionSnapshot>;
};

export function missionTemplateFrom(
  mission: MissionSnapshot,
  targetType: string,
  targetId: string,
): MissionTemplate {
  if (targetType !== "room") throw new Error("mission schedule requires room target");
  if (mission.roomId !== targetId) throw new Error("mission room does not match task target");
  return {
    sourceMissionId: mission.id,
    roomId: mission.roomId,
    goal: mission.goal,
    acceptanceCriteria: [...mission.acceptanceCriteria],
    scope: mission.scope,
    constraints: [...mission.constraints],
    ownerSessionId: mission.ownerSessionId,
    maxAutoRetries: mission.maxAutoRetries,
  };
}

export async function runMissionTask(
  task: ScheduledTask,
  deps: MissionTaskDeps,
): Promise<"draft" | "started"> {
  const tpl = task.missionTemplate;
  if (!tpl) throw new Error("not a mission task");
  if (task.targetType !== "room" || task.targetId !== tpl.roomId)
    throw new Error("mission template target mismatch");
  const room = deps.getRoom(tpl.roomId);
  if (!room) throw new Error(`unknown room: ${tpl.roomId}`);
  if (task.missionAutoStart && !room.members.every((mem) => deps.isAvailable(mem.sessionId)))
    throw new Error(`room ${room.roomId} has unavailable members; auto start skipped`);
  const occupied =
    deps.hasActiveFlow(room.roomId) ||
    room.members.some((mem) => deps.isMemberBusy(mem.sessionId)) ||
    deps.activeMissions(room.roomId).some((x) =>
      ["running", "waiting-user", "awaiting-acceptance"].includes(x.status),
    );
  if (occupied) throw new Error(`room ${room.roomId} occupied; mission task skipped`);
  const draft = deps.createMission({
    roomId: room.roomId,
    goal: tpl.goal,
    acceptanceCriteria: tpl.acceptanceCriteria,
    scope: tpl.scope,
    constraints: tpl.constraints,
    ownerSessionId: tpl.ownerSessionId,
    maxAutoRetries: tpl.maxAutoRetries,
  });
  if (task.missionAutoStart) {
    await deps.startMission(draft.id);
    return "started";
  }
  return "draft";
}
