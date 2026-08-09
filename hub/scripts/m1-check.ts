import WebSocket from "ws";

const url = process.argv[2] ?? "ws://127.0.0.1:8787/?token=dev-token";
const promptText = process.argv[3] ?? "Reply with exactly: OK";
const cwd = process.argv[4] ?? process.cwd();

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function call(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on("message", async (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    const resolve = pending.get(msg.id)!;
    pending.delete(msg.id);
    resolve(msg);
    return;
  }
  if (msg.method === "session.update") {
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      process.stdout.write(u.content.text);
    } else if (u.sessionUpdate === "tool_call") {
      console.log(`\n[tool] ${u.title} (${u.status})`);
    } else if (u.sessionUpdate === "tool_call_update") {
      console.log(`\n[tool] ${u.toolCallId} -> ${u.status}`);
    } else {
      console.log(`\n[update] ${u.sessionUpdate}`);
    }
  } else if (msg.method === "permission.request") {
    console.log(`\n[permission] ${msg.params.toolCall?.title ?? ""}`);
    const opt = msg.params.options.find((o: any) => o.kind === "allow_once") ?? msg.params.options[0];
    await call("permission.respond", { requestId: msg.params.requestId, optionId: opt.optionId });
  } else if (msg.method === "prompt.done") {
    console.log(`\n[done] stopReason=${msg.params.stopReason}`);
    ws.close();
    process.exit(0);
  } else {
    console.log(`\n[event] ${msg.method} ${JSON.stringify(msg.params)}`);
  }
});

ws.on("open", async () => {
  try {
    const { connections } = await call("connection.list");
    const conn = connections.find((c: any) => c.online || c.local);
    if (!conn) throw new Error("no online or local connection");

    const { sessionId } = await call("session.create", { cwd, connectionId: conn.id });
    console.log(`[m1] session created: ${sessionId}`);
    console.log(`[m1] prompt: ${promptText}`);
    await call("prompt.send", { sessionId, text: promptText });
  } catch (err) {
    console.error("[m1] failed:", err);
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("[m1] ws error:", err.message);
  process.exit(1);
});
