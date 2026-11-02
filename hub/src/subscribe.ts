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
};

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
  "room.artifact",
  "member.status",
  "room.notice",
]);

/** global 层判定：白名单 + room.process 信封中的 flow 卡（过程流本身不推） */
export function shouldDeliver(
  sub: ClientSub | undefined,
  event: { method: string; params?: Record<string, unknown> },
): boolean {
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
