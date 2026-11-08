/**
 * 订阅分层：客户端声明 tier 后 hub 按需过滤推送。
 * - detail（默认/兼容行为）：全量事件
 * - global：仅低频状态类（待办/工单/决策/成员状态/错误），高频流式与过程事件不推
 * 切换订阅时由 client.subscribe 响应附带快照，防订阅窗口漏事件。
 */
export type SubTier = "global" | "detail";

export type ClientSub = {
  tier: SubTier;
  /** 订阅目标房：切 detail 时用于补快照，不过滤其他房事件 */
  roomId?: string | undefined;
  sessionId?: string | undefined;
  /** 任务级订阅链：声明后，携带 taskId 的事件仅订阅中的工单放行；
   *  未声明（undefined）保持房级广播兼容语义 */
  taskIds?: Set<string> | undefined;
};

/** 工单订阅账本：taskId → 关注成员 sessionId 集。
 *  conductor 派工（FlowTask.sessionId）与认领/求助时登记，flow 终结随任务清理；
 *  供"讨论沿工单直达负责 worker"的过滤判定用。 */
export class TaskSubscriptions {
  private subs = new Map<string, Set<string>>();

  private key(roomId: string, taskId: string): string {
    return `${roomId}|${taskId}`;
  }

  add(roomId: string, taskId: string, sessionId: string): void {
    const key = this.key(roomId, taskId);
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(sessionId);
  }

  members(roomId: string, taskId: string): ReadonlySet<string> | undefined {
    return this.subs.get(this.key(roomId, taskId));
  }

  removeTask(roomId: string, taskId: string): void {
    this.subs.delete(this.key(roomId, taskId));
  }

  removeTasks(roomId: string, taskIds: Iterable<string>): void {
    for (const id of taskIds) this.subs.delete(this.key(roomId, id));
  }

  get size(): number {
    return this.subs.size;
  }
}

/** global 层放行的事件白名单：低频状态/待办/错误 */
const GLOBAL_METHODS = new Set<string>([
  "mission.update",
  "decision.request",
  "decision.resolve",
  "decision.update",
  "room.flowUpdate",
  "room.blackboardUpdate",
  "room.modeSelected",
  "room.update",
  "task.update",
  "agent.status",
  "prompt.error",
  "session.status",
  "session.notice",
  "room.artifact",
  "member.status",
  "room.notice",
]);

/** 事件携带的工单 id 集合：task.update 在 params.taskId；过程卡/派发卡的 taskId 在
 *  entry.text 的 JSON meta 里（单卡 .taskId、派发卡 .tasks[].id），entry/meta 直挂字段也兼容。 */
function eventTaskIds(event: { params?: Record<string, unknown> }): Set<string> {
  const ids = new Set<string>();
  const p = event.params;
  if (!p) return ids;
  const push = (v: unknown) => {
    if (typeof v === "string" && v) ids.add(v);
  };
  push(p.taskId);
  const e = p.entry as Record<string, unknown> | undefined;
  if (e) {
    push(e.taskId);
    push((e.meta as Record<string, unknown> | undefined)?.taskId);
    if (typeof e.text === "string" && e.text.startsWith("{")) {
      try {
        const t = JSON.parse(e.text) as Record<string, unknown>;
        push(t.taskId);
        push((t.meta as Record<string, unknown> | undefined)?.taskId);
        const tasks = t.tasks;
        if (Array.isArray(tasks)) for (const x of tasks) push((x as Record<string, unknown>)?.id);
      } catch { /* 非 JSON 文本跳过 */ }
    }
  }
  return ids;
}

/** global 层判定：白名单 + room.process 信封中的 flow 卡（过程流本身不推）。
 *  任务级订阅链附加规则：客户端声明 taskIds 后，携带 taskId 的事件仅订阅命中放行——
 *  无 taskId 的事件按原层级判定，保证未声明客户端的房级广播语义不变。 */
export function shouldDeliver(
  sub: ClientSub | undefined,
  event: { method: string; params?: Record<string, unknown> },
): boolean {
  if (sub?.taskIds) {
    const tagged = eventTaskIds(event);
    // taskId 非房内唯一（conductor 生成 t1/peer-review）——仅当事件属于声明房间时才按 taskIds 收窄，
    // 否则他房同名 taskId 会误放行/误拦截
    const eventRoom = typeof event.params?.roomId === "string" ? event.params.roomId : undefined;
    if (
      tagged.size > 0 &&
      (!sub.roomId || eventRoom === undefined || eventRoom === sub.roomId) &&
      ![...tagged].some((id) => sub.taskIds!.has(id))
    )
      return false;
  }
  if (!sub || sub.tier !== "global") return true;
  if (GLOBAL_METHODS.has(event.method)) return true;
  if (event.method === "room.process") {
    const e = (event.params?.entry ?? event.params) as
      | Record<string, unknown>
      | undefined;
    return e?.kind === "flow" || e?.cardType === "flow";
  }
  return false;
}
