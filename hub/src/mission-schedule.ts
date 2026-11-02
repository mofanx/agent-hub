import type { Room } from "./room.js";
import type { MissionSnapshot } from "./mission.js";
import {
  EVENT_WAKE_KINDS,
  type EventTrigger,
  type MissionTemplate,
  type ScheduledTask,
} from "./scheduler.js";
import { parseWakeFilter } from "./wake-gate.js";

/** 静默复现默认报障关键词（wake-gate contains OR 匹配，大小写不敏感） */
export const SILENT_REPRO_KEYWORDS = [
  "bug", "报错", "崩溃", "异常", "错误", "error", "crash", "修复",
];
/** 静默复现默认节奏：60s 去抖、每任务每小时最多 2 次、每房每天最多 2 轮 */
export const SILENT_REPRO_DEFAULTS = {
  debounceMs: 60_000,
  maxPerHour: 2,
  roomMaxPerDay: 2,
} as const;

/** task.create 入参校验：eventTrigger 仅房作用域、事件名白名单、数值字段合法。
 *  silentRepro:true 为预设——自动订阅 room.message 并按报障关键词默认过滤，
 *  默认不启用，仅显式 task.create 携带该标记才激活。 */
export function parseEventTrigger(raw: unknown, targetType: string): EventTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (targetType !== "room") throw new Error("eventTrigger requires room target");
  if (typeof raw !== "object") throw new Error("eventTrigger must be an object");
  const t = raw as Record<string, unknown>;
  const silentRepro = t.silentRepro === true;
  const events = Array.isArray(t.events) ? t.events.map((x) => String(x)) : [];
  if (silentRepro && !events.includes("room.message")) events.push("room.message");
  if (!events.length) throw new Error("eventTrigger.events required");
  for (const e of events) {
    if (!(EVENT_WAKE_KINDS as readonly string[]).includes(e))
      throw new Error(`unknown wake event: ${e}`);
  }
  const out: EventTrigger = { events: [...new Set(events)] };
  if (silentRepro) out.silentRepro = true;
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
  const filter = parseWakeFilter(t.filter);
  if (filter !== undefined) out.filter = filter;
  if (out.silentRepro) {
    if (out.debounceMs === undefined) out.debounceMs = SILENT_REPRO_DEFAULTS.debounceMs;
    if (out.maxPerHour === undefined) out.maxPerHour = SILENT_REPRO_DEFAULTS.maxPerHour;
    if (!out.filter?.contains?.length) {
      out.filter = { ...(out.filter ?? {}), contains: [...SILENT_REPRO_KEYWORDS] };
    }
  }
  return out;
}

/** 静默复现每房轮次账本：滑动 24h 窗口内每房最多 roomMaxPerDay 轮——
 *  与 EventWakeBook（每任务去抖/小时上限）互补，防同房多 silent 任务叠加打扰。 */
export class SilentReproBook {
  private rounds = new Map<string, { dayStart: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  admit(roomId: string, maxPerDay = SILENT_REPRO_DEFAULTS.roomMaxPerDay): boolean {
    const n = this.now();
    let st = this.rounds.get(roomId);
    if (!st || n - st.dayStart >= 86_400_000) {
      st = { dayStart: n, count: 0 };
      this.rounds.set(roomId, st);
    }
    if (st.count >= maxPerDay) return false;
    st.count += 1;
    return true;
  }

  drop(roomId: string): void {
    this.rounds.delete(roomId);
  }
}

/** 静默复现 worker prompt：复现→定位→修复建议/补丁，限本房范围（IFC 作用域），
 *  结果写黑板收尾（attention 聚合），不主动打扰用户。 */
export function buildSilentReproPrompt(instruction: string, report: string): string {
  const clipped = report.slice(0, 500);
  return `${instruction}\n\n[静默复现任务] 用户报障：「${clipped}」\n要求：1) 静默复现该问题；2) 定位根因；3) 给出修复建议或补丁。仅限本房范围内的信息（IFC 作用域），不要跨房拉取数据；结果写入黑板并等待用户确认，不要主动打扰用户。`;
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
