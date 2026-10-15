import { createHash } from "node:crypto";

export type ProcessStatus = "done" | "failed" | "interrupted";
export type ProcessStep = { kind: string; title?: string; text?: string };
export type DispatchTaskItem = { id?: string | undefined; to?: string | undefined; task?: string | undefined };
export type ProcessCardMeta = {
  processId: string;
  sessionId: string;
  turnStartAt: number;
  turnEndAt: number;
  steps: ProcessStep[];
  taskId?: string;
  status: ProcessStatus;
  /** 结构化通知卡类型；type="dispatch" 时 count/tasks 承载派工清单 */
  type?: string;
  count?: number;
  tasks?: DispatchTaskItem[];
};

export function newProcessId(roomId: string, sessionId: string, turnStartAt: number): string {
  return createHash("sha1").update(`${roomId}:${sessionId}:${turnStartAt}`).digest("hex").slice(0, 12);
}

export function buildProcessMeta(
  roomId: string,
  sessionId: string,
  buf: TurnProcessItem[],
  taskId: string | undefined,
  status: ProcessStatus,
): ProcessCardMeta {
  const steps = buf.map((i) => {
    const step: ProcessStep = { kind: i.kind };
    if (i.kind === "tool" || i.kind === "plan") {
      try {
        step.title = String((JSON.parse(i.text) as Record<string, unknown>).title ?? "");
      } catch {
        step.title = "";
      }
    } else {
      step.text = i.text.slice(0, 120);
    }
    return step;
  });
  const turnStartAt = buf[0]!.at;
  const meta: ProcessCardMeta = {
    processId: newProcessId(roomId, sessionId, turnStartAt),
    sessionId,
    turnStartAt,
    turnEndAt: Date.now(),
    steps,
    status,
  };
  if (taskId) meta.taskId = taskId;
  return meta;
}

export type TurnProcessItem = {
  at: number;
  kind: "thought" | "tool" | "plan";
  author: string;
  text: string;
  toolCallId?: string;
};

/** 单回合过程项上限：超限丢弃最旧，防超大 turn 撑爆聚合卡 */
const MAX_PROCESS_ITEMS = 50;

export class TurnProcessRecorder {
  private buffers = new Map<string, TurnProcessItem[]>();

  private push(sessionId: string, item: TurnProcessItem): void {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    buf.push(item);
    if (buf.length > MAX_PROCESS_ITEMS) buf.splice(0, buf.length - MAX_PROCESS_ITEMS);
  }

  record(sessionId: string, update: Record<string, unknown>, author: string): void {
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (!kind) return;
    const buf = this.buffers.get(sessionId) ?? [];
    switch (kind) {
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        const text = content?.type === "text" ? (content.text ?? "") : "";
        if (!text) return;
        const last = buf[buf.length - 1];
        if (last && last.kind === "thought" && last.author === author) {
          last.text += text;
        } else {
          this.push(sessionId, { at: Date.now(), kind: "thought", author, text });
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolCallId = String(update.toolCallId ?? "");
        let item: TurnProcessItem | undefined;
        for (let i = buf.length - 1; i >= 0; i--) {
          if (buf[i]!.kind === "tool" && buf[i]!.toolCallId === toolCallId) {
            item = buf[i];
            break;
          }
        }
        if (!item) {
          item = {
            at: Date.now(),
            kind: "tool",
            author,
            toolCallId,
            text: JSON.stringify({
              toolCallId,
              title: "tool",
              status: "pending",
              toolKind: "",
            }),
          };
          this.push(sessionId, item);
        }
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(item.text) as Record<string, unknown>;
        } catch {
          /* keep */
        }
        if (typeof update.title === "string") data.title = update.title;
        if (typeof update.status === "string") data.status = update.status;
        if (typeof update.kind === "string") data.toolKind = update.kind;
        item.text = JSON.stringify(data);
        break;
      }
      case "plan": {
        const entries = ((update.entries as unknown[] | undefined) ?? []).map((it) => {
          const e = it as Record<string, unknown>;
          return `[${String(e.status ?? "")}] ${String(e.content ?? "")}`;
        });
        this.push(sessionId, { at: Date.now(), kind: "plan", author, text: JSON.stringify({ entries }) });
        break;
      }
    }
  }

  /** 查看进行中的回合缓冲（不消费），供 session.process 钻取 running 任务 */
  peek(sessionId: string): TurnProcessItem[] {
    return [...(this.buffers.get(sessionId) ?? [])];
  }

  take(sessionId: string): TurnProcessItem[] {
    const buf = this.buffers.get(sessionId);
    this.buffers.delete(sessionId);
    return buf ?? [];
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
