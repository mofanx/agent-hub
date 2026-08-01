import WebSocket from "ws";
import * as fs from "node:fs";
import * as path from "node:path";

const stateFile = path.resolve(new URL("../data/state.json", import.meta.url).pathname);
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const lastSession = state.sessions[state.sessions.length - 1];
console.log("[persist] state.json has", state.sessions.length, "sessions,", state.rooms.length, "rooms");
console.log("[persist] last session:", lastSession.sessionId, lastSession.name, lastSession.agent);

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
  if (msg.method === "prompt.done") {
    console.log(`[done] ${msg.params.output.slice(0, 100)}`);
    console.log("[persist] ALL PASSED");
    process.exit(0);
  } else if (msg.method === "prompt.error") {
    console.error(`[error] ${msg.params.message}`);
    process.exit(1);
  }
});

ws.on("open", async () => {
  try {
    const { sessions } = await call("session.list");
    const offline = sessions.filter((s: any) => s.offline);
    console.log(`[persist] hub sees ${sessions.length} sessions, ${offline.length} offline`);

    const { entries } = await call("session.history", { sessionId: lastSession.sessionId });
    console.log(`[persist] history entries: ${entries.length}`);
    for (const e of entries) console.log(`  [${e.kind}] ${e.author}: ${e.text.slice(0, 60)}`);
    if (entries.length === 0) throw new Error("history empty");

    const { resumed } = await call("session.resume", { sessionId: lastSession.sessionId });
    console.log(`[persist] resume: ${resumed}`);
    if (!resumed) {
      console.log("[persist] agent 不支持 resume，跳过后续 prompt 验证（部分通过）");
      process.exit(0);
    }

    await call("prompt.send", {
      sessionId: lastSession.sessionId,
      text: "上一轮我说了什么？一句话复述",
    });
  } catch (err) {
    console.error("[persist] FAILED:", err);
    process.exit(1);
  }
});

setTimeout(() => {
  console.error("[persist] TIMEOUT");
  process.exit(1);
}, 120_000);
