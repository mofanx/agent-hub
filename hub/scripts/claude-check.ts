import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/?token=dev-token");
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function call(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 120_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "prompt.done") {
    console.log(`[done] ${msg.params.output.slice(0, 200)}`);
    console.log("[claude] PASSED");
    process.exit(0);
  } else if (msg.method === "prompt.error") {
    console.error(`[error] ${msg.params.message}`);
    process.exit(1);
  } else if (msg.method === "agent.status") {
    console.log(`[agent] ${msg.params.status} ${msg.params.detail ?? ""}`);
  }
});

ws.on("open", async () => {
  try {
    const { connections } = await call("connection.list");
    const conn = connections.find((c: any) => c.agent === "claude" && (c.online || c.local)) ??
      connections.find((c: any) => c.online || c.local);
    if (!conn) throw new Error("no online or local connection");

    const s = await call("session.create", { cwd: "/tmp", name: "小克", connectionId: conn.id });
    console.log("[claude] session:", s.sessionId, "agent:", s.agent);
    await call("prompt.send", { sessionId: s.sessionId, text: "只回复两个字：收到" });
  } catch (err) {
    console.error("[claude] FAILED:", err);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[claude] TIMEOUT");
  process.exit(1);
}, 150_000);
