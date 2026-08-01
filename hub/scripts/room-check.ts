import WebSocket from "ws";

const url = "ws://127.0.0.1:8787/?token=dev-token";
const ws = new WebSocket(url);
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

const doneWaiters = new Map<string, () => void>();

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "prompt.done") {
    const { sessionId, output } = msg.params;
    console.log(`\n[done:${sessionId}] ${output.slice(0, 200)}`);
    doneWaiters.get(sessionId)?.();
    doneWaiters.delete(sessionId);
  } else if (msg.method === "prompt.error") {
    console.error(`\n[error:${msg.params.sessionId}] ${msg.params.message}`);
  }
});

function waitDone(sessionId: string): Promise<void> {
  return new Promise((r) => doneWaiters.set(sessionId, r));
}

ws.on("open", async () => {
  try {
    const a = await call("session.create", { cwd: "/tmp", name: "阿明" });
    const b = await call("session.create", { cwd: "/tmp", name: "小红" });
    console.log("[room] sessions:", a.sessionId, b.sessionId);

    const { room } = await call("room.create", {
      name: "测试群",
      sessionIds: [a.sessionId, b.sessionId],
    });
    console.log("[room] created:", room.roomId, room.name);

    console.log('[room] send: "@阿明 只回复三个字：我很好"');
    const r1 = await call("room.message", {
      roomId: room.roomId,
      text: "@阿明 只回复三个字：我很好",
    });
    console.log("[room] routed -> sent:", r1.sent, "mentioned:", r1.mentioned);
    await waitDone(a.sessionId);

    console.log('[room] send: "@小红 群里另一位成员刚才说了什么？一句话转述"');
    const r2 = await call("room.message", {
      roomId: room.roomId,
      text: "@小红 群里另一位成员刚才说了什么？一句话转述",
    });
    console.log("[room] routed -> sent:", r2.sent);
    await waitDone(b.sessionId);

    console.log("\n[room] ALL PASSED");
    process.exit(0);
  } catch (err) {
    console.error("[room] FAILED:", err);
    process.exit(1);
  }
});

ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});
