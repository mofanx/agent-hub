import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8787/?token=dev-token");
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
let sawConductorNotice = false;

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
  if (msg.method === "room.notice") {
    console.log(`[notice] ${msg.params.message}`);
    if (msg.params.message.includes("拆解")) sawConductorNotice = true;
  } else if (msg.method === "prompt.done") {
    console.log(`[done:${msg.params.sessionId}] ${msg.params.output.slice(0, 80)}`);
    if (sawConductorNotice) {
      console.error("[bypass] FAILED: @消息触发了指挥家编排");
      process.exit(1);
    }
    console.log("[bypass] PASSED: @消息直达成员，未触发指挥家");
    process.exit(0);
  } else if (msg.method === "prompt.error") {
    console.error(`[error] ${msg.params.message}`);
  }
});

ws.on("open", async () => {
  try {
    const boss = await call("session.create", { cwd: "/tmp", name: "指挥" });
    const a = await call("session.create", { cwd: "/tmp", name: "小甲" });
    const { room } = await call("room.create", {
      name: "绕过测试群",
      sessionIds: [boss.sessionId, a.sessionId],
      mode: "conductor",
      conductorId: boss.sessionId,
    });
    console.log("[bypass] conductor room ready:", room.roomId);
    const r = await call("room.message", {
      roomId: room.roomId,
      text: "@小甲 只回复一个字：好",
    });
    console.log("[bypass] routed -> sent:", r.sent, "mentioned:", r.mentioned);
  } catch (err) {
    console.error("[bypass] FAILED:", err);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[bypass] TIMEOUT");
  process.exit(1);
}, 120_000);
