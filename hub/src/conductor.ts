import type { Room, RoomManager } from "./room.js";

export type PromptContent = Array<Record<string, unknown>>;

export interface AgentOps {
  prompt(sessionId: string, content: string | PromptContent): Promise<void>;
  isBusy(sessionId: string): boolean;
}

type Flow = {
  roomId: string;
  phase: "planning" | "working" | "summarizing";
  pending: Map<string, string>;
  /** 结果以 sessionId 为 key，避免重名覆盖 */
  results: Map<string, string>;
};

export type ConductorNotice = { roomId: string; message: string };

const PLAN_RESULT_LEN = 500;

export class ConductorOrchestrator {
  private flows = new Map<string, Flow>();

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly notice: (n: ConductorNotice) => void,
  ) {}

  hasActiveFlow(roomId: string): boolean {
    return this.flows.has(roomId);
  }

  /** 强制中断某个房间的指挥编排 */
  cancel(roomId: string, reason?: string): string[] {
    const flow = this.flows.get(roomId);
    if (!flow) return [];
    const touched = [...flow.pending.keys()];
    if (flow.phase !== "planning" && flow.phase !== "summarizing") {
      // working 阶段成员也算在活跃中
    }
    this.flows.delete(roomId);
    if (reason) this.notice({ roomId, message: reason });
    return touched;
  }

  /** 判断某 session 是否是指挥家且正在指挥编排中 */
  isConductorSession(sessionId: string): boolean {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (room && room.conductorId === sessionId) return true;
    }
    return false;
  }

  /** 获取某 session 在当前编排中的角色与阶段 */
  getFlowForSession(
    sessionId: string,
  ):
    | { roomId: string; role: "conductor" | "worker"; phase: Flow["phase"] }
    | undefined {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) continue;
      if (room.conductorId === sessionId) {
        return { roomId: flow.roomId, role: "conductor", phase: flow.phase };
      }
      if (flow.phase === "working" && (flow.pending.has(sessionId) || flow.results.has(sessionId))) {
        return { roomId: flow.roomId, role: "worker", phase: flow.phase };
      }
    }
    return undefined;
  }

  /** prompt 异常（含取消）时清理该会话在编排中的状态 */
  onPromptError(sessionId: string): boolean {
    for (const [roomId, flow] of [...this.flows]) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.flows.delete(roomId);
        continue;
      }
      if (sessionId === room.conductorId) {
        this.flows.delete(roomId);
        this.notice({ roomId, message: "指挥家中断，本轮编排已取消" });
        return true;
      }
      if (flow.phase === "working" && flow.pending.has(sessionId)) {
        flow.pending.delete(sessionId);
        this.notice({
          roomId,
          message: `@${
            room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId
          } 子任务中断（剩 ${flow.pending.size} 项）`,
        });
        if (flow.pending.size === 0) {
          void this.summarize(flow, room).catch((err) => {
            console.error("[conductor] summarize after error failed:", err);
          });
        }
        return true;
      }
    }
    return false;
  }

  private buildMemberList(room: Room): string {
    return room.members
      .filter((m) => m.sessionId !== room.conductorId)
      .map((m) => `${m.name} (id: ${m.sessionId})`)
      .join("、") || "（无）";
  }

  private buildExample(room: Room): string {
    const others = room.members.filter((m) => m.sessionId !== room.conductorId);
    if (others.length === 0) return '{"tasks":[]}';
    const sample = others.slice(0, 2).map((m, i) =>
      JSON.stringify({ to: m.sessionId, task: i === 0 ? "先处理第一个子任务" : "再处理第二个子任务" })
    );
    return `{"tasks":[${sample.join(",")}]}`;
  }

  async start(room: Room, text: string): Promise<void> {
    if (!room.conductorId) throw new Error("room has no conductor");
    const example = this.buildExample(room);
    const prompt = [
      `你是群聊「${room.name}」的指挥家（Conductor）。`,
      `可派工的成员：${this.buildMemberList(room)}。`,
      "",
      `用户任务：${text}`,
      "",
      "请把任务拆解并派发给成员。",
      "",
      "要求：",
      "- 输出必须且仅包含一个 JSON code block。",
      "- `to` 字段必须是上面列出的成员 ID（括号中的 `id:...` 部分），不能写占位符或说明文字。",
      "- `to` 字段也可以写 `@成员名` 作为兼容写法，但当成员名字重复时请用成员 ID。",
      "- 如果任务简单、无需分工，输出 `{\"tasks\":[]}` 并直接给出你的回答。",
      "",
      "示例（请用实际成员 ID 替换，不要原样复制说明文字）：",
      "```json",
      example,
      "```",
    ].join("\n");
    this.flows.set(room.roomId, {
      roomId: room.roomId,
      phase: "planning",
      pending: new Map(),
      results: new Map(),
    });
    this.notice({ roomId: room.roomId, message: "指挥家拆解任务中…" });
    await this.agent.prompt(room.conductorId, prompt);
  }

  /** 每轮 prompt.done 时调用；返回 true 表示该事件属于某个编排流 */
  async onPromptDone(sessionId: string, output: string): Promise<boolean> {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) {
        this.flows.delete(flow.roomId);
        continue;
      }
      if (sessionId === room.conductorId) {
        if (flow.phase === "planning") {
          await this.dispatch(flow, room, output);
          return true;
        }
        if (flow.phase === "summarizing") {
          this.flows.delete(flow.roomId);
          return true;
        }
      }
      if (flow.phase === "working" && flow.pending.has(sessionId)) {
        const name =
          room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
        flow.pending.delete(sessionId);
        flow.results.set(
          sessionId,
          output.trim().replace(/\s+/g, " ").slice(0, PLAN_RESULT_LEN),
        );
        this.notice({
          roomId: flow.roomId,
          message: `@${name} 已完成子任务（剩 ${flow.pending.size} 项）`,
        });
        if (flow.pending.size === 0) {
          await this.summarize(flow, room);
        }
        return true;
      }
    }
    return false;
  }

  private resolveMember(
    room: Room,
    rawTo: string,
  ): { sessionId: string; name: string } | undefined {
    const to = rawTo.replace(/^@/, "").trim();
    // 优先按 sessionId 匹配，支持从 "name (id: xxx)" 中提取 ID
    const idMatch = to.match(/id:\s*([^\s)]+)/);
    const id = idMatch?.[1] ?? to;
    let member = room.members.find((m) => m.sessionId === id);
    if (member) return member;
    // 回退按名字匹配
    member = room.members.find((m) => m.name === to);
    return member;
  }

  private async dispatch(flow: Flow, room: Room, conductorOutput: string): Promise<void> {
    const tasks = parseTasks(conductorOutput);
    if (tasks === null) {
      this.notice({
        roomId: flow.roomId,
        message: "指挥家未给出有效派工单，本轮按指挥家直接回复结束",
      });
      this.flows.delete(flow.roomId);
      return;
    }
    if (tasks.length === 0) {
      this.flows.delete(flow.roomId);
      return;
    }
    flow.phase = "working";
    const assignments: string[] = [];
    const assigned = new Set<string>();
    for (const t of tasks) {
      if (!t.task.trim()) continue;
      const member = this.resolveMember(room, t.to);
      if (!member) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：未知成员 ${t.to}` });
        continue;
      }
      if (member.sessionId === room.conductorId) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：${member.name} 是指挥家` });
        continue;
      }
      if (assigned.has(member.sessionId)) {
        this.notice({
          roomId: flow.roomId,
          message: `派工跳过：${member.name} 已被派发过，请拆分进同一条任务`,
        });
        continue;
      }
      if (this.agent.isBusy(member.sessionId)) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：@${member.name} 忙碌中` });
        continue;
      }
      flow.pending.set(member.sessionId, t.task);
      assigned.add(member.sessionId);
      assignments.push(`@${member.name}：${t.task}`);
    }
    if (flow.pending.size === 0) {
      this.flows.delete(flow.roomId);
      return;
    }
    this.notice({ roomId: flow.roomId, message: `指挥家派工：${assignments.join("；")}` });
    for (const [sid, task] of flow.pending) {
      const prompt = this.rooms.buildPrompt(
        room.roomId,
        `指挥家派发给你的子任务：${task}`,
        sid,
      );
      this.agent.prompt(sid, prompt).catch((err: unknown) => {
        flow.pending.delete(sid);
        this.notice({
          roomId: flow.roomId,
          message: `子任务派发失败：${String(err)}`,
        });
      });
    }
  }

  private async summarize(flow: Flow, room: Room): Promise<void> {
    flow.phase = "summarizing";
    const lines = [...flow.results.entries()].map(([sessionId, r]) => {
      const name = room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
      return `- @${name}: ${r}`;
    });
    const prompt = [
      `你是群聊「${room.name}」的指挥家。你之前派发的子任务已全部完成，结果：`,
      ...lines,
      "",
      "请汇总这些结果，向用户给出最终答复。",
    ].join("\n");
    this.notice({ roomId: flow.roomId, message: "子任务全部完成，指挥家汇总中…" });
    await this.agent.prompt(room.conductorId!, prompt);
  }
}

function parseTasks(output: string): { to: string; task: string }[] | null {
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = fence?.[1]?.trim();
  if (!raw) {
    // 没有 code fence 时，尝试找出包含 "tasks" 的最大 JSON 对象
    const match = output.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
    if (match) {
      raw = match[0];
      // 简单尝试从第一个 '{' 到最后一个 '}'
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
    }
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.tasks)) return null;
    return obj.tasks
      .filter((t: unknown): t is { to: string; task: string } => {
        const o = t as Record<string, unknown>;
        return typeof o?.to === "string" && typeof o?.task === "string";
      })
      .map((t: { to: string; task: string }) => ({
        to: t.to.replace(/^@/, "").trim(),
        task: t.task.trim(),
      }));
  } catch {
    return null;
  }
}
