export type TurnProcessItem = {
  at: number;
  kind: "thought" | "tool" | "plan";
  author: string;
  text: string;
  toolCallId?: string;
};

export class TurnProcessRecorder {
  private buffers = new Map<string, TurnProcessItem[]>();

  record(sessionId: string, update: Record<string, unknown>, author: string): void {
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (!kind) return;
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(sessionId, buf);
    }
    switch (kind) {
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        const text = content?.type === "text" ? (content.text ?? "") : "";
        if (!text) return;
        const last = buf[buf.length - 1];
        if (last && last.kind === "thought" && last.author === author) {
          last.text += text;
        } else {
          buf.push({ at: Date.now(), kind: "thought", author, text });
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
          buf.push(item);
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
        buf.push({ at: Date.now(), kind: "plan", author, text: JSON.stringify({ entries }) });
        break;
      }
    }
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
