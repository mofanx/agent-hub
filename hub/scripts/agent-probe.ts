// 探测某 agent 类型能否完成 ACP initialize + session/new
// 用法: npx tsx scripts/agent-probe.ts <codex|opencode|claude|devin>
import WebSocket from "ws";

const agentType = process.argv[2] ?? "codex";
const ws = new WebSocket("ws://127.0.0.1:8787/?token=dev-token");
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function call(method: string, params?: Record<string, unknown>): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 90_000);
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
  if (msg.method === "agent.status") {
    console.log(`[agent] ${msg.params.status} ${msg.params.detail ?? ""}`);
  }
});

ws.on("open", async () => {
  try {
    const s = await call("session.create", {
      cwd: "/tmp",
      name: `probe-${agentType}`,
      agent: agentType,
    });
    console.log(`[probe] ${agentType} session created: ${s.sessionId} -> initialize+session/new OK`);
    process.exit(0);
  } catch (err) {
    console.error(`[probe] ${agentType} FAILED:`, String(err).slice(0, 300));
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[probe] TIMEOUT");
  process.exit(1);
}, 100_000);
