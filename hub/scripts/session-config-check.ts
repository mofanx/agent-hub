// 端到端验证 session.configOptions / session.setConfigOption（devin acp 3000.11+ 上报 mode/thought_level）
// 用法: HUB_PORT=8790 npx tsx scripts/session-config-check.ts
import WebSocket from "ws";

const port = process.env.HUB_PORT ?? "8790";
const token = process.env.HUB_TOKEN ?? "dev-token";
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
let nextId = 1;
const pending = new Map<number, (msg: { error?: string; result?: unknown }) => void>();

function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
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

type ConfigOption = {
  id: string;
  name?: string;
  type?: string;
  currentValue?: string;
  options?: { value: string; name?: string }[];
};

function findOption(opts: unknown, id: string): ConfigOption | undefined {
  if (!Array.isArray(opts)) return undefined;
  return (opts as ConfigOption[]).find((o) => o?.id === id);
}

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id != null && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

ws.on("open", async () => {
  let sessionId = "";
  try {
    const created = (await call("session.create", {
      connectionId: "local-devin",
      cwd: "/tmp",
      name: `cfg-check-${Date.now().toString(36)}`,
    })) as { sessionId: string };
    sessionId = created.sessionId;

    const initial = (await call("session.configOptions", { sessionId })) as { configOptions: ConfigOption[] };
    const mode = findOption(initial.configOptions, "mode");
    const thinking = findOption(initial.configOptions, "thought_level");
    if (!mode || !thinking) {
      throw new Error(`missing config options: mode=${!!mode} thought_level=${!!thinking}`);
    }

    const setThinking = (await call("session.setConfigOption", {
      sessionId,
      configId: "thought_level",
      value: "max",
    })) as { configOptions: ConfigOption[] };
    const afterThinking = findOption(setThinking.configOptions, "thought_level");
    if (afterThinking?.currentValue !== "max") {
      throw new Error(`thought_level not applied: ${afterThinking?.currentValue}`);
    }

    const reread = (await call("session.configOptions", { sessionId })) as { configOptions: ConfigOption[] };
    if (findOption(reread.configOptions, "thought_level")?.currentValue !== "max") {
      throw new Error("thought_level reread mismatch");
    }

    const setMode = (await call("session.setConfigOption", {
      sessionId,
      configId: "mode",
      value: "plan",
    })) as { configOptions: ConfigOption[] };
    if (findOption(setMode.configOptions, "mode")?.currentValue !== "plan") {
      throw new Error("mode not applied");
    }

    await call("session.setConfigOption", { sessionId, configId: "mode", value: "accept-edits" });
    await call("session.setConfigOption", { sessionId, configId: "thought_level", value: "high" });

    console.log(JSON.stringify({
      ok: true,
      sessionId,
      modeOptions: mode.options?.map((o) => o.value),
      thinkingOptions: thinking.options?.map((o) => o.value),
      thoughtLevelApplied: "max->high",
      modeApplied: "plan->accept-edits",
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, sessionId, error: String(err) }, null, 2));
    process.exitCode = 1;
  } finally {
    if (sessionId) {
      try { await call("session.delete", { sessionId }); } catch {}
    }
    ws.close();
  }
});

setTimeout(() => {
  console.error(JSON.stringify({ ok: false, error: "overall timeout" }));
  process.exit(1);
}, 120_000);
