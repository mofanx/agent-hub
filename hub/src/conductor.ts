import type { Room, RoomManager } from "./room.js";

export interface AgentOps {
  prompt(sessionId: string, text: string): Promise<void>;
  isBusy(sessionId: string): boolean;
}

type Flow = {
  roomId: string;
  phase: "planning" | "working" | "summarizing";
  pending: Map<string, string>;
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
  cancel(roomId: string, reason?: string): boolean {
    const flow = this.flows.get(roomId);
    if (!flow) return false;
    this.flows.delete(roomId);
    if (reason) this.notice({ roomId, message: reason });
    return true;
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

  async start(room: Room, text: string): Promise<void> {
    if (!room.conductorId) throw new Error("room has no conductor");
    const others = room.members
      .filter((m) => m.sessionId !== room.conductorId)
      .map((m) => m.name);
    const prompt = [
      `你是群聊「${room.name}」的指挥家（Conductor）。`,
      `可派工的成员：${others.map((n) => `@${n}`).join("、") || "（无）"}。`,
      "",
      `用户任务：${text}`,
      "",
      "请把任务拆解并派发给成员。在回复末尾输出且仅输出一个 json 代码块，格式：",
      "```json",
      '{"tasks":[{"to":"成员名","task":"具体子任务描述"}]}',
      "```",
      "如果任务简单、无需分工，输出 {\"tasks\":[]} 并直接给出你的回答。",
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
          name,
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
    for (const t of tasks) {
      const member = room.members.find(
        (m) => m.name === t.to && m.sessionId !== room.conductorId,
      );
      if (!member) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：未知成员 ${t.to}` });
        continue;
      }
      if (this.agent.isBusy(member.sessionId)) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：@${member.name} 忙碌中` });
        continue;
      }
      flow.pending.set(member.sessionId, t.task);
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
    const lines = [...flow.results.entries()].map(([name, r]) => `- @${name}: ${r}`);
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
  const raw = fence?.[1] ?? output.match(/\{[\s\S]*"tasks"[\s\S]*\}/)?.[0];
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
        to: t.to.replace(/^@/, ""),
        task: t.task,
      }));
  } catch {
    return null;
  }
}
