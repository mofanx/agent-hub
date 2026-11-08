/**
 * fake-acp-agent：真机重启演练用的 ACP stub agent（ndjson stdio JSON-RPC）。
 * 按 session/prompt 文本分流行为：
 * - 含 "OUTWARD"：发 tool_call + agent_message_chunk 通知后挂起（模拟 running+已外发）
 * - 含 "SILENT"：直接挂起不发任何通知（running+无外发）
 * - 含 "主持人" 或 "指挥家"：返回 tasks JSON 代码块（conductor 规划回执）
 * - 其他：echo 简短文本后 end_turn
 * 全部 session/prompt 原文追加落 $FAKE_LOG（演练断言用）。
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

const logPath = process.env.FAKE_LOG ?? `${process.cwd()}/fake-agent.ndjson`;
const append = (rec: Record<string, unknown>) => {
  try { fs.appendFileSync(logPath, JSON.stringify(rec) + "\n"); } catch { /* best effort */ }
};
const send = (msg: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};
const notify = (sessionId: string, update: Record<string, unknown>) => {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
};

const HANG = new Set<number>();
let seq = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  let msg: { id?: number; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || !msg.method) return; // notification: ignore
  const p = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      return;
    case "session/new":
    case "session/load":
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { sessionId: String(p.sessionId ?? `fa-${++seq}`) },
      });
      return;
    case "session/cancel":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/prompt": {
      const sid = String(p.sessionId ?? "");
      const text = JSON.stringify(p.prompt ?? "");
      append({ at: Date.now(), sessionId: sid, kind: "prompt", text });
      if (text.includes("OUTWARD")) {
        // 已外发迹：tool_call + 文本块，然后挂起（prompt 永不 resolve → running 直到 kill）
        notify(sid, {
          sessionUpdate: "tool_call", toolCallId: "tc1", title: "edit files",
          status: "in_progress", kind: "edit",
        });
        notify(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "已开始修改文件，正在写入…" },
        });
        HANG.add(msg.id);
        return;
      }
      if (text.includes("SILENT")) {
        HANG.add(msg.id); // 无任何外发信号地挂起
        return;
      }
      if (text.includes("主持人") || text.includes("指挥家") || text.includes("拆分")) {
        const reply =
          "```json\n{\"tasks\":[" +
          "{\"id\":\"t1\",\"to\":\"w1\",\"task\":\"执行 OUTWARD 任务\"}," +
          "{\"id\":\"t2\",\"to\":\"w2\",\"task\":\"执行 SILENT 任务\"}" +
          "]}\n```";
        notify(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
      notify(sid, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "收到，已处理。" },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
