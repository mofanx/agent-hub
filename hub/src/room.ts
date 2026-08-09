import { randomUUID } from "node:crypto";

export type RoomMode =
  | "mention"
  | "conductor"
  | "roundrobin"
  | "parallel"
  | "pipeline"
  | "debate"
  | "auto";

export type Room = {
  roomId: string;
  name: string;
  mode: RoomMode;
  conductorId?: string | undefined;
  members: { sessionId: string; name: string }[];
  /** 成员角色卡：sessionId -> roleId 或自定义 persona */
  memberRoles?: Record<string, string> | undefined;
  /** 轮询模式：当前轮到第几个成员 */
  roundRobinIndex?: number | undefined;
  /** 流水线模式：成员执行顺序，未设置则按 members 顺序 */
  pipelineOrder?: string[] | undefined;
  /** 辩论模式：正方/反方 sessionId */
  debateSides?: [string, string] | undefined;
  /** 辩论模式：裁判 sessionId */
  debateJudge?: string | undefined;
  /** 辩论模式：轮数 */
  debateRounds?: number | undefined;
  /** 并发模式：汇总者 sessionId */
  parallelSummarizerId?: string | undefined;
};

export type RoomModeConfig = {
  conductorId?: string | undefined;
  parallelSummarizerId?: string | undefined;
  pipelineOrder?: string[] | undefined;
  debateSides?: [string, string] | undefined;
  debateJudge?: string | undefined;
  debateRounds?: number | undefined;
  memberRoles?: Record<string, string> | undefined;
};

type BlackboardEntry = { from: string; text: string; at: number };

const BLACKBOARD_LIMIT = 10;
const BLACKBOARD_OUTPUT_LEN = 400;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private blackboards = new Map<string, BlackboardEntry[]>();
  private getPersona?: (roleId: string) => string | undefined;

  setRoleResolver(getPersona: (roleId: string) => string | undefined): void {
    this.getPersona = getPersona;
  }

  create(
    name: string,
    members: { sessionId: string; name: string }[],
    mode: RoomMode = "mention",
    config?: RoomModeConfig,
  ): Room {
    const conductorId = config?.conductorId;
    if (mode === "conductor" || mode === "auto") {
      if (!conductorId || !members.some((m) => m.sessionId === conductorId)) {
        throw new Error(`${mode} room needs a valid conductorId`);
      }
    }
    if (conductorId && !members.some((m) => m.sessionId === conductorId)) {
      throw new Error("conductorId must be a member of the room");
    }
    const room: Room = {
      roomId: randomUUID().slice(0, 8),
      name,
      mode,
      conductorId,
      members,
      memberRoles: config?.memberRoles,
      roundRobinIndex: 0,
      parallelSummarizerId: config?.parallelSummarizerId,
      pipelineOrder: config?.pipelineOrder,
      debateSides: config?.debateSides,
      debateJudge: config?.debateJudge,
      debateRounds: config?.debateRounds,
    };
    this.rooms.set(room.roomId, room);
    this.blackboards.set(room.roomId, []);
    this.dedupMemberNames(room.roomId);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** 从持久化状态恢复（不覆盖黑板已有记录） */
  import(room: Room): void {
    this.rooms.set(room.roomId, room);
    this.blackboards.set(room.roomId, []);
  }

  roomsFor(sessionId: string): Room[] {
    return [...this.rooms.values()].filter((r) =>
      r.members.some((m) => m.sessionId === sessionId),
    );
  }

  /** 从所有群移除该成员；指挥家被移除或成员不足 2 人时解散群。返回解散的 roomId */
  removeMember(sessionId: string): string[] {
    const dissolved: string[] = [];
    for (const room of [...this.rooms.values()]) {
      if (!room.members.some((m) => m.sessionId === sessionId)) continue;
      if ((room.mode === "conductor" || room.mode === "auto") && room.conductorId === sessionId) {
        this.rooms.delete(room.roomId);
        this.blackboards.delete(room.roomId);
        dissolved.push(room.roomId);
        continue;
      }
      room.members = room.members.filter((m) => m.sessionId !== sessionId);
      if (room.conductorId === sessionId) {
        room.conductorId = room.members[0]?.sessionId;
      }
      if (room.members.length < 2) {
        this.rooms.delete(room.roomId);
        this.blackboards.delete(room.roomId);
        dissolved.push(room.roomId);
      }
    }
    return dissolved;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  delete(roomId: string): boolean {
    const ok = this.rooms.delete(roomId);
    this.blackboards.delete(roomId);
    return ok;
  }

  rename(roomId: string, name: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    room.name = name;
    return room;
  }

  update(
    roomId: string,
    name: string,
    members: { sessionId: string; name: string }[],
    mode: RoomMode,
    config?: RoomModeConfig,
  ): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    if (members.length === 0) throw new Error("room needs at least 1 member");
    const conductorId = config?.conductorId;
    if (mode === "conductor" || mode === "auto") {
      if (!conductorId || !members.some((m) => m.sessionId === conductorId)) {
        throw new Error(`${mode} room needs a valid conductorId`);
      }
    }
    if (conductorId && !members.some((m) => m.sessionId === conductorId)) {
      throw new Error("conductorId must be a member of the room");
    }
    room.name = name;
    room.mode = mode;
    room.members = members;
    room.memberRoles = config?.memberRoles;
    room.conductorId = conductorId;
    room.parallelSummarizerId = config?.parallelSummarizerId;
    room.pipelineOrder = config?.pipelineOrder;
    room.debateSides = config?.debateSides;
    room.debateJudge = config?.debateJudge;
    room.debateRounds = config?.debateRounds;
    this.dedupMemberNames(room.roomId);
    return room;
  }

  private dedupMemberNames(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const used = new Set<string>();
    for (const m of room.members) {
      let name = m.name;
      let attempt = 1;
      while (used.has(name)) {
        attempt++;
        const shortId = m.sessionId.slice(-4);
        name = `${m.name} (${shortId}${attempt > 2 ? `-${attempt}` : ""})`;
      }
      used.add(name);
      m.name = name;
    }
  }

  /** 解析 @mention，返回目标 sessionId 列表；无 mention 时返回全部成员 */
  route(roomId: string, text: string): { targets: string[]; mentioned: string[] } {
    const room = this.rooms.get(roomId);
    if (!room) return { targets: [], mentioned: [] };
    const mentioned = room.members
      .filter((m) => new RegExp(`@${m.name}(?![\\w-])`).test(text))
      .map((m) => m.sessionId);
    return {
      targets: mentioned.length > 0 ? mentioned : room.members.map((m) => m.sessionId),
      mentioned,
    };
  }

  /** 获取房间共享黑板 */
  getBlackboard(roomId: string): BlackboardEntry[] {
    return [...(this.blackboards.get(roomId) ?? [])];
  }

  /** 构造发给某个成员的最终 prompt：注入房间上下文与共享黑板 */
  buildPrompt(
    roomId: string,
    text: string,
    excludeSessionId: string,
    quote?: { author: string; text: string },
    persona?: string,
  ): string {
    const room = this.rooms.get(roomId)!;
    const roleId = room.memberRoles?.[excludeSessionId];
    const resolved = persona ?? (roleId ? this.getPersona?.(roleId) : undefined) ?? roleId;
    const board = (this.blackboards.get(roomId) ?? [])
      .filter((e) => e.from !== excludeSessionId)
      .slice(-BLACKBOARD_LIMIT);
    const others = room.members
      .filter((m) => m.sessionId !== excludeSessionId)
      .map((m) => `@${m.name}`)
      .join(" ");
    const lines = [
      `[群聊「${room.name}」| 其他成员: ${others || "无"}]`,
    ];
    if (resolved) {
      lines.push(`你的角色设定：${resolved}`);
    } else {
      lines.push("你在一个多 agent 协作群聊中。用户和其他 agent 的最近结论如下：");
    }
    if (board.length === 0) {
      lines.push("（暂无）");
    } else {
      for (const e of board) lines.push(`- ${e.from}: ${e.text}`);
    }
    if (quote) {
      lines.push("", `用户引用了 ${quote.author} 的消息："${quote.text}"`);
    }
    lines.push("", `用户消息：${text}`);
    return lines.join("\n");
  }

  /** 同步更新所有包含该 session 的群中成员显示名 */
  updateMemberName(sessionId: string, name: string): string[] {
    const touched: string[] = [];
    for (const room of this.rooms.values()) {
      const member = room.members.find((m) => m.sessionId === sessionId);
      if (member) {
        member.name = name;
        this.dedupMemberNames(room.roomId);
        touched.push(room.roomId);
      }
    }
    return touched;
  }

  /** 把某个成员的 sessionId 替换为新的 sessionId，用于空会话重建 */
  updateMemberSessionId(oldSessionId: string, newSessionId: string): string[] {
    const touched: string[] = [];
    for (const room of this.rooms.values()) {
      const member = room.members.find((m) => m.sessionId === oldSessionId);
      if (member) {
        member.sessionId = newSessionId;
        if (room.conductorId === oldSessionId) room.conductorId = newSessionId;
        if (room.parallelSummarizerId === oldSessionId) room.parallelSummarizerId = newSessionId;
        if (room.debateJudge === oldSessionId) room.debateJudge = newSessionId;
        if (room.debateSides) {
          room.debateSides = room.debateSides.map((s) =>
            s === oldSessionId ? newSessionId : s,
          ) as [string, string];
        }
        if (room.pipelineOrder) {
          room.pipelineOrder = room.pipelineOrder.map((s) =>
            s === oldSessionId ? newSessionId : s,
          );
        }
        touched.push(room.roomId);
      }
    }
    return touched;
  }

  /** 某个 session 一轮结束后，把输出摘要写上黑板（供其他成员参考） */
  recordOutput(sessionId: string, sessionName: string, output: string): string[] {
    const touched: string[] = [];
    const text = output.trim().replace(/\s+/g, " ").slice(0, BLACKBOARD_OUTPUT_LEN);
    if (!text) return touched;
    for (const room of this.rooms.values()) {
      if (!room.members.some((m) => m.sessionId === sessionId)) continue;
      const board = this.blackboards.get(room.roomId)!;
      board.push({ from: sessionName, text, at: Date.now() });
      if (board.length > BLACKBOARD_LIMIT) board.shift();
      touched.push(room.roomId);
    }
    return touched;
  }
}
