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

const phases: string[] = [];

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "room.notice") {
    console.log(`[notice] ${msg.params.message}`);
    phases.push(msg.params.message);
  } else if (msg.method === "prompt.done") {
    const name = nameOf(msg.params.sessionId);
    console.log(`[done:${name}] ${msg.params.output.slice(0, 150)}`);
    if (phases.length > 0 && phases[phases.length - 1]?.includes("汇总中")) {
      console.log("\n[conductor] FINAL SUMMARY ABOVE -> ALL PASSED");
      process.exit(0);
    }
  } else if (msg.method === "prompt.error") {
    console.error(`[error] ${msg.params.message}`);
  }
});

const names = new Map<string, string>();
function nameOf(sid: string): string {
  return names.get(sid) ?? sid;
}

ws.on("open", async () => {
  try {
    const { connections } = await call("connection.list");
    const conn = connections.find((c: any) => c.online || c.local);
    if (!conn) throw new Error("no online or local connection");
    const connectionId = conn.id;

    const boss = await call("session.create", { cwd: "/tmp", name: "指挥", connectionId });
    const a = await call("session.create", { cwd: "/tmp", name: "小甲", connectionId });
    const b = await call("session.create", { cwd: "/tmp", name: "小乙", connectionId });
    names.set(boss.sessionId, "指挥");
    names.set(a.sessionId, "小甲");
    names.set(b.sessionId, "小乙");
    console.log("[conductor] sessions ready");

    const { room } = await call("room.create", {
      name: "指挥家群",
      sessionIds: [boss.sessionId, a.sessionId, b.sessionId],
      mode: "conductor",
      conductorId: boss.sessionId,
    });
    console.log("[conductor] room:", room.roomId, "mode:", room.mode);

    await call("room.message", {
      roomId: room.roomId,
      text: "让小甲说一种水果，让小乙说一种动物，各自一句话即可",
    });
    console.log("[conductor] task sent, orchestrating...");
  } catch (err) {
    console.error("[conductor] FAILED:", err);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[conductor] TIMEOUT");
  process.exit(1);
}, 300_000);

ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});
