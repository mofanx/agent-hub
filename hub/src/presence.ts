/**
 * member.status 事件协议：成员在线/生成中/离线状态广播。
 * 事件带 scope+id，客户端自行按上下文过滤。
 */
export type PresenceStatus = "online" | "generating" | "offline";

export type PresenceEventParams = {
  scope: "room" | "session";
  id: string;
  member: string;
  status: PresenceStatus;
};

/** 由连接/忙碌状态推导成员状态 */
export function deriveMemberStatus(online: boolean, busy: boolean): PresenceStatus {
  if (!online) return "offline";
  return busy ? "generating" : "online";
}

/**
 * 某成员状态迁移时应广播的事件集：
 * 一条 session 作用域 + 其归属的每个房间各一条 room 作用域。
 */
export function presenceEvents(
  sessionId: string,
  status: PresenceStatus,
  roomIds: string[] = [],
): PresenceEventParams[] {
  const events: PresenceEventParams[] = [
    { scope: "session", id: sessionId, member: sessionId, status },
  ];
  for (const roomId of roomIds) {
    events.push({ scope: "room", id: roomId, member: sessionId, status });
  }
  return events;
}
