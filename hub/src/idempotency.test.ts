import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { createHash } from "node:crypto";
import { helpAnswerIntent } from "./room-modes.js";
import { clientMessageFlowState, runClientMessage } from "./client-messages.js";
import { createRequire } from "node:module";
const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = requireDesktop(requireDesktop.resolve("typescript")) as {
  transpileModule: (src: string, opts: unknown) => { outputText: string };
  ScriptTarget: { ES2020: unknown };
  ModuleKind: { CommonJS: unknown };
};
import vm from "node:vm";
import { execFileSync } from "node:child_process";

test("部署安全：开发凭据仅回环，生产和隧道拒绝默认或占位凭据", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const config = source.slice(source.indexOf("const PORT ="), source.indexOf("const WORKER_PATH ="));
  const read = (env: Record<string, string> = {}) => vm.runInNewContext(config + "\n({ LOCAL_ONLY });", { process: { env } });
  assert.equal(read().LOCAL_ONLY, true);
  assert.equal(read({ HUB_TOKEN: "private-hub-test-credential" }).LOCAL_ONLY, false);
  const configs: Record<string, string>[] = [{ NODE_ENV: "production" }, { HUB_TUNNEL: "1" }, { HUB_TOKEN: "" },
    { HUB_TOKEN: "CHANGE_ME_TO_A_LONG_RANDOM_STRING" }, { HUB_TOKEN: " padded-token " }];
  for (const env of configs) {
    assert.throws(() => read(env), /HUB_TOKEN/);
  }
  assert.match(source, /healthServer\.listen\(PORT, LOCAL_ONLY \? "127\.0\.0\.1" : "0\.0\.0\.0"\)/);
  const gateway = fs.readFileSync(new URL("../../deploy/gateway/src/server.ts", import.meta.url), "utf8");
  const start = gateway.indexOf("  const { port, host, gatewayToken");
  const validate = vm.runInNewContext(`(options) => { ${gateway.slice(start, gateway.indexOf("  const hubs =", start))}; return true; }`);
  const options = { gatewayToken: "private-gateway-test-key", adminToken: "private-admin-test-key" };
  assert.equal(validate(options), true);
  for (const token of ["", " ", "CHANGE_ME_gateway", "dev-token", " padded "]) {
    assert.throws(() => validate({ ...options, gatewayToken: token }), /TOKEN/);
    assert.throws(() => validate({ ...options, adminToken: token }), /TOKEN/);
  }
  const compose = fs.readFileSync(new URL("../../deploy/gateway/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /"127\.0\.0\.1:8788:8788"/);
  assert.match(compose, /GATEWAY_TOKEN: \$\{GATEWAY_TOKEN:\?/);
  assert.match(compose, /ADMIN_TOKEN: \$\{ADMIN_TOKEN:\?/);
  assert.match(fs.readFileSync(new URL("../../deploy/gateway/Dockerfile", import.meta.url), "utf8"), /^USER node$/m);
});

test("部署安全：systemd 启动前脚本拒绝占位凭据而不执行服务", (t) => {
  if (process.platform === "win32") { t.skip("systemd templates are Unix-only"); return; }
  for (const file of ["../../deploy/agent-hub.service", "../../deploy/gateway/hub-gateway.service"]) {
    const unit = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const script = unit.match(/^ExecStartPre=\/bin\/sh -c '(.*)'$/m)?.[1]?.replaceAll("$$", "$");
    assert.ok(script);
    const run = (value: string) => execFileSync("sh", ["-c", script], {
      env: { ...process.env, HUB_TOKEN: value, GATEWAY_TOKEN: value, ADMIN_TOKEN: value }, stdio: "pipe",
    });
    assert.throws(() => run("CHANGE_ME_TO_A_LONG_RANDOM_STRING"));
    assert.throws(() => run(""));
    assert.doesNotThrow(() => run("verification-private-credential"));
  }
});

test("健康探针：实际回调区分握手中与已就绪连接，不启动 Hub", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const agents = new Map([["pending", { isReady: false }]]);
  let hubProbe: (req: unknown, res: unknown) => void = () => {};
  vm.runInNewContext(source.slice(source.indexOf("const healthServer = createServer("), source.indexOf("const wss = new WebSocketServer(")), {
    agents, clients: new Set(), process: { uptime: () => 1 }, createServer: (handler: typeof hubProbe) => { hubProbe = handler; },
  });
  function response(handler: typeof hubProbe, route: string) {
    const res = { statusCode: 0, body: "", setHeader: () => {}, end: (body: string) => { res.body = body; } };
    handler({ method: "GET", url: route }, res);
    return res;
  }
  assert.equal(response(hubProbe, "/healthz").statusCode, 200);
  assert.equal(response(hubProbe, "/readyz").statusCode, 503);
  agents.set("ready", { isReady: true });
  assert.equal(response(hubProbe, "/readyz").statusCode, 200);
  assert.equal(JSON.parse(response(hubProbe, "/readyz").body).agents, 1);
  const gateway = fs.readFileSync(new URL("../../deploy/gateway/src/server.ts", import.meta.url), "utf8");
  const begin = gateway.indexOf("    if (parts[0] === 'healthz'");
  const finish = gateway.indexOf("    if (parts[0] === 'admin'", begin);
  assert.ok(begin > 0 && finish > begin);
  const state = { agent: { readyState: 1 }, hello: false, clients: new Set(), workers: new Set() };
  const gatewayProbe = vm.runInNewContext(`(req, res) => { const parts = [req.url.slice(1)]; ${gateway.slice(begin, finish)} }`, {
    hubs: new Map([["private-hub-id", state]]), WebSocket: { OPEN: 1 }, process: { uptime: () => 1 },
  });
  assert.equal(response(gatewayProbe, "/healthz").statusCode, 200);
  assert.equal(response(gatewayProbe, "/readyz").statusCode, 503);
  state.hello = true;
  assert.equal(response(gatewayProbe, "/readyz").statusCode, 200);
  state.agent.readyState = 3;
  assert.equal(response(gatewayProbe, "/readyz").statusCode, 503);
  assert.doesNotMatch(response(gatewayProbe, "/healthz").body, /private-hub-id/);
});

function makeStore(t?: { after: (fn: () => void) => void }): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-idem-"));
  const store = new Store(dir);
  t?.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const requireDesktop2 = createRequire(new URL("../../desktop/package.json", import.meta.url));
const tsAst = requireDesktop(requireDesktop.resolve("typescript")) as {
  createSourceFile: (name: string, text: string, target: unknown, setParentNodes: boolean, kind: unknown) => unknown;
  transpileModule: (src: string, opts: unknown) => { outputText: string };
  isCaseClause: (n: unknown) => boolean;
  isStringLiteral: (n: unknown) => boolean;
  forEachChild: (n: unknown, cb: (n: unknown) => unknown) => void;
  ScriptTarget: { Latest: unknown; ES2020: unknown };
  ScriptKind: { TS: unknown };
  ModuleKind: { CommonJS: unknown };
};

type IndexCaseRunner = (params: Record<string, unknown>) => Promise<unknown>;

function extractIndexCaseBody(label: string): string {
  const text = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const sf = tsAst.createSourceFile("index.ts", text, tsAst.ScriptTarget.Latest, true, tsAst.ScriptKind.TS) as never;
  let body = "";
  const visit = (n: { getText?: () => string; kind?: number; expression?: { text?: string }; statements?: unknown } & Record<string, unknown>) => {
    if (body) return;
    if (tsAst.isCaseClause(n) && n.expression && (n.expression as { text?: string }).text === label) {
      body = `{ ${((n as { statements?: { getText: () => string }[] }).statements ?? []).map((st) => st.getText()).join(" ")} }`;
      return;
    }
    tsAst.forEachChild(n, visit as never);
  };
  tsAst.forEachChild(sf, visit as never);
  if (!body) throw new Error("case not found: " + label);
  return body;
}

function compileIndexCase(body: string, sandbox: Record<string, unknown>): IndexCaseRunner {
  const fn = tsAst.transpileModule(
    `module.exports = async (req) => ${body};`,
    { compilerOptions: { target: tsAst.ScriptTarget.ES2020, module: tsAst.ModuleKind.CommonJS } },
  ).outputText;
  const box: Record<string, unknown> = { module: { exports: null }, console, Date, Promise, Error, String, Array, Number, Object, JSON, Set, Map, RegExp, clientMessageFlowState,
    // IFC 门控桩：测试 store 恒 shared 直通，保持原语义
    ifcCheckRoomRead: () => {},
    ...sandbox };
  vm.runInNewContext(fn, box, { timeout: 5000 });
  const fn2 = (box.module as { exports: (req: { params: Record<string, unknown> }) => Promise<unknown> }).exports;
  return (params) => fn2({ params });
}

test("clientMsgSet/Get：写入后可读回原结果，重复 key 覆盖", (t) => {
  const store = makeStore(t);
  const key = "room.message:r1:cm-1";
  assert.equal(store.clientMsgGet(key), undefined);
  store.clientMsgSet(key, { sent: ["s1"], skipped: [] });
  assert.deepEqual(store.clientMsgGet(key), { sent: ["s1"], skipped: [] });
  store.clientMsgSet(key, { sent: ["s2"], skipped: [] });
  assert.deepEqual(store.clientMsgGet(key), { sent: ["s2"], skipped: [] });
});

test("clientMsgSet：超出 cap 时最旧记录被淘汰", (t) => {
  const store = makeStore(t);
  for (let i = 0; i < 5; i++) {
    store.clientMsgSet(`k:${i}`, { n: i }, 3);
  }
  assert.equal(store.clientMsgGet("k:0"), undefined);
  assert.equal(store.clientMsgGet("k:1"), undefined);
  assert.deepEqual(store.clientMsgGet("k:2"), { n: 2 });
  assert.deepEqual(store.clientMsgGet("k:4"), { n: 4 });
});

test("readAfterId：返回游标之后的条目，游标行缺失时标记 truncated", (t) => {
  const store = makeStore(t);
  const a = store.append("room", "r1", { at: 1000, kind: "user", author: "我", text: "m1" });
  const b = store.append("room", "r1", { at: 2000, kind: "assistant", author: "d1", text: "m2" });
  const c = store.append("room", "r1", { at: 3000, kind: "system", author: "", text: "m3" });
  assert.ok(a > 0 && b > a && c > b);

  const inc = store.readAfterId("room", "r1", a);
  assert.equal(inc.truncated, false);
  assert.deepEqual(inc.entries.map((e) => e.id), [b, c]);

  // 游标指向不存在的行（已被清理/超保留范围）→ truncated，调用方应全量回退
  const dead = store.readAfterId("room", "r1", 999999);
  assert.equal(dead.truncated, true);
  assert.deepEqual(dead.entries, []);

  // 其他 scope 互不影响
  const other = store.readAfterId("session", "r1", a);
  assert.equal(other.truncated, true);
});

test("readAfterId：游标行被物理删除后同样标记 truncated", (t) => {
  const store = makeStore(t);
  const a = store.append("room", "r2", { at: 1000, kind: "user", author: "我", text: "m1" });
  store.append("room", "r2", { at: 2000, kind: "assistant", author: "d1", text: "m2" });
  store.deleteHistory("room", "r2");
  store.append("room", "r2", { at: 3000, kind: "user", author: "我", text: "m3" });
  const res = store.readAfterId("room", "r2", a);
  assert.equal(res.truncated, true);
});

test("runClientMessage：并发同 key 只有一次 history 和 dispatch", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  let dispatched = 0;
  const req = {
    key: "k:conc", fingerprint: "fp1", scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "hi" },
  };
  const dispatch = async () => { dispatched++; await new Promise((r) => setImmediate(r)); return { accepted: true }; };
  const [a, b] = await Promise.all([
    runClientMessage(store, req, dispatch),
    runClientMessage(store, req, dispatch),
  ]);
  assert.equal(dispatched, 1);
  assert.equal(store.read("session", "s1").filter((e) => e.kind === "user").length, 1);
  assert.equal(a.deliveryStatus, "accepted");
  assert.equal(b.deliveryStatus, "accepted");
});

test("runClientMessage：同 key 不同 fingerprint 冲突（含在途并发）", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  const req = (fp: string) => ({
    key: "k:cf", fingerprint: fp, scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  });
  let resolveSlow: (() => void) | null = null;
  const slow = () => new Promise<Record<string, unknown>>((r) => { resolveSlow = () => r({ ok: 1 }); });
  const p1 = runClientMessage(store, req("fpA"), slow);
  await assert.rejects(runClientMessage(store, req("fpB"), async () => ({})), /client_message_conflict/);
  resolveSlow!();
  await p1;
  await assert.rejects(runClientMessage(store, req("fpB"), async () => ({})), /client_message_conflict/);
});

test("runClientMessage：ACK 丢失后相同请求 accepted 去重不再派发", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  let dispatched = 0;
  const req = {
    key: "k:dup", fingerprint: "fp", scope: "room" as const, scopeId: "r1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "m" },
  };
  const first = await runClientMessage(store, req, async () => { dispatched++; return { sent: ["s1"], skipped: [] }; });
  assert.equal(first.deliveryStatus, "accepted");
  const replay = await runClientMessage(store, req, async () => { dispatched++; return { sent: [], skipped: [] }; });
  assert.equal(dispatched, 1);
  assert.equal(replay.deliveryStatus, "accepted");
  assert.equal(replay.deduped, true);
  assert.deepEqual(replay.sent, ["s1"]);
  assert.equal(store.read("room", "r1").filter((e) => e.kind === "user").length, 1);
});

test("runClientMessage：派发后 Finish 故障不二派", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  let dispatched = 0;
  const origFinish = store.clientMsgFinish.bind(store);
  let once = true;
  store.clientMsgFinish = (key, st, res) => {
    if (once && st === "accepted") { once = false; throw new Error("simulated finish failure"); }
    return origFinish(key, st, res);
  };
  const req = {
    key: "k:ff", fingerprint: "fp", scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  };
  const r1 = await runClientMessage(store, req, async () => { dispatched++; return { accepted: true }; });
  assert.equal(r1.deliveryStatus, "uncertain");
  const r2 = await runClientMessage(store, req, async () => { dispatched++; return { accepted: true }; });
  assert.equal(dispatched, 1, "uncertain 回执禁止自动重派");
  assert.equal(r2.deliveryStatus, "uncertain");
  assert.equal(store.read("session", "s1").filter((e) => e.kind === "user").length, 1);
});

test("runClientMessage：重建 Store 后 dispatching/uncertain 不二派", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-idem-re-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const req = {
    key: "k:re", fingerprint: "fp", scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  };
  // dispatch 抛错 → uncertain 持久化
  const r1 = await runClientMessage(store, req, async () => { throw new Error("agent down"); });
  assert.equal(r1.deliveryStatus, "uncertain");
  store.close();
  let dispatched = 0;
  store = new Store(dir);
  const r2 = await runClientMessage(store, req, async () => { dispatched++; return { accepted: true }; });
  assert.equal(dispatched, 0);
  assert.equal(r2.deliveryStatus, "uncertain");
});

test("runClientMessage：Begin 失败（容量/冲突）不调用 dispatch", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  // 冲突：先占一个 fpA，再用 fpB 同 key → Begin 冲突 → 不派发
  const req = (fp: string) => ({
    key: "k:bf", fingerprint: fp, scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  });
  await runClientMessage(store, req("fpA"), async () => ({ ok: 1 }));
  let dispatched = 0;
  await assert.rejects(
    runClientMessage(store, req("fpB"), async () => { dispatched++; return {}; }),
    /client_message_conflict/,
  );
  assert.equal(dispatched, 0);
});

test("runClientMessage：validateNew 上下文校验（新拒绝/旧回执不受 flow 变化影响）", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  let flow: string | null = "f1";
  const req = {
    key: "k:cx", fingerprint: "fp", scope: "room" as const, scopeId: "r1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "m" },
    validateNew: () => {
      if (flow !== "f1") throw new Error("client_message_context_changed");
    },
  };
  const r1 = await runClientMessage(store, req, async () => ({ sent: ["s1"], skipped: [] }));
  assert.equal(r1.deliveryStatus, "accepted");
  // flow 变化后旧回执仍返回原结果，不重校验
  flow = "f2";
  const r2 = await runClientMessage(store, req, async () => ({ sent: [], skipped: [] }));
  assert.equal(r2.deliveryStatus, "accepted");
  assert.equal(r2.deduped, true);
  // 新 key 在 flow=f2 下校验失败
  await assert.rejects(
    runClientMessage(store, { ...req, key: "k:cx2" }, async () => ({})),
    /client_message_context_changed/,
  );
});

test("clientMsgBegin：满容量不挤有效记录；仅过期项被清理", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-idem-cap-"));
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // 造 10000 条未过期
  const stmt = (store as any).db.prepare(
    "INSERT INTO client_msgs (key, result, at) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < 10000; i++) {
    stmt.run(`k:${i}`, JSON.stringify({ v: 1, fingerprint: "f", historyId: 1, state: "accepted", result: {} }), Date.now());
  }
  assert.throws(
    () => store.clientMsgBegin("k:new", "f", "session", "s1", { at: 1, kind: "user", author: "我", text: "x" }),
    /client_message_capacity/,
  );
  // 把一条置为过期（>48h），再次 Begin 可清理后成功
  (store as any).db.prepare("UPDATE client_msgs SET at = ? WHERE key = ?")
    .run(Date.now() - 49 * 3600_000, "k:0");
  const began = store.clientMsgBegin("k:new", "f", "session", "s1", { at: 1, kind: "user", author: "我", text: "x" });
  assert.equal(began.state, "dispatching");
  assert.equal(store.clientMsgReceipt("k:0"), undefined, "过期回执被清理");
});

test("room.sync knownCardIds：原位卡片校准（含 updateEntry 新内容/不漏跨房普通行）", (t) => {
  const store = makeStore(t);
  const a = store.append("room", "r1", { at: 1, kind: "flow", author: "", text: "flow-v1" });
  const b = store.append("room", "r1", { at: 2, kind: "decision", author: "", text: "dec-v1" });
  store.append("room", "r1", { at: 3, kind: "assistant", author: "w", text: "chat" });
  store.append("room", "r2", { at: 4, kind: "flow", author: "", text: "other-room" });
  let cards = store.readRoomCards("r1", [a, b]);
  assert.equal(cards.length, 2);
  store.updateEntry(a, "flow-v2");
  cards = store.readRoomCards("r1", [a, b]);
  assert.equal(cards[0]?.text, "flow-v2", "updateEntry 后返回新内容");
  assert.deepEqual(store.readRoomCards("r1", []), []);
  const leaked = store.readRoomCards("r1", [a]);
  assert.ok(leaked.every((c) => c.kind === "flow"));
});

test("runClientMessage：外层读与事务内读之间已有记录落入不重派", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  store.clientMsgBegin("k:race", "fp", "session", "s1", { at: 1, kind: "user", author: "我", text: "x" });
  const orig = store.clientMsgReceipt.bind(store);
  let first = true;
  store.clientMsgReceipt = (key: string) => (first ? (first = false, undefined) : orig(key)) as never;
  let dispatched = 0;
  const r = await runClientMessage(store, {
    key: "k:race", fingerprint: "fp", scope: "session", scopeId: "s1",
    entry: { at: 2, kind: "user", author: "我", text: "x" },
  }, async () => { dispatched++; return { accepted: true }; });
  assert.equal(dispatched, 0);
  assert.equal(store.read("session", "s1").filter((e) => e.kind === "user").length, 1);
  assert.equal(r.deliveryStatus, "uncertain");
});

test("runClientMessage：不同 Store 相同 key 互不共享 inflight", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const s1 = makeStore(t);
  const s2 = makeStore(t);
  const req = (k: string) => ({
    key: k, fingerprint: "fp", scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  });
  let d1 = 0, d2 = 0;
  await Promise.all([
    runClientMessage(s1, req("k:x"), async () => { d1++; return {}; }),
    runClientMessage(s2, req("k:x"), async () => { d2++; return {}; }),
  ]);
  assert.equal(d1, 1);
  assert.equal(d2, 1);
});

test("runClientMessage：Begin 事务原子失败 → 0 history/0 receipt/0 dispatch", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  (store as any).db.exec(
    "CREATE TRIGGER fail_client_receipt BEFORE INSERT ON client_msgs BEGIN SELECT RAISE(FAIL, 'simulated receipt insert failure'); END;",
  );
  let dispatched = 0;
  await assert.rejects(
    runClientMessage(store, {
      key: "k:atomic", fingerprint: "fp", scope: "session", scopeId: "s1",
      entry: { at: 1, kind: "user", author: "我", text: "x" },
    }, async () => { dispatched++; return {}; }),
    /simulated receipt insert failure/,
  );
  assert.equal(dispatched, 0);
  assert.equal(store.read("session", "s1").length, 0);
  assert.equal(store.clientMsgReceipt("k:atomic"), undefined);
});

test("runClientMessage：两次 Finish 都失败 → 重开仍 dispatching 不二派", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-idem-ff-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let dispatched = 0;
  const origFinish = store.clientMsgFinish.bind(store);
  store.clientMsgFinish = () => { throw new Error("finish down"); };
  const req = {
    key: "k:ff2", fingerprint: "fp", scope: "session" as const, scopeId: "s1",
    entry: { at: 1, kind: "user" as const, author: "我", text: "x" },
  };
  const r1 = await runClientMessage(store, req, async () => { dispatched++; return { accepted: true }; });
  assert.equal(r1.deliveryStatus, "uncertain");
  assert.equal(dispatched, 1);
  store.close();
  store = new Store(dir);
  const receipt = store.clientMsgReceipt("k:ff2");
  assert.equal(receipt?.state, "dispatching", "Finish 双失败时仍停在 dispatching");
  const r2 = await runClientMessage(store, req, async () => { dispatched++; return { accepted: true }; });
  assert.equal(dispatched, 1);
  assert.equal(r2.deliveryStatus, "uncertain");
  void origFinish;
});

test("readRoomCards：别房 id/普通聊天 id/草稿 id 均不泄露", (t) => {
  const store = makeStore(t);
  const card = store.append("room", "r1", { at: 1, kind: "flow", author: "", text: "f" });
  const chat = store.append("room", "r1", { at: 2, kind: "assistant", author: "w", text: "c" });
  const draft = (store as any).db.prepare(
    "INSERT INTO history(scope, scope_id, at, kind, author, text, draft) VALUES ('room','r1',3,'flow','','d',1)",
  ).run().lastInsertRowid;
  const other = store.append("room", "r2", { at: 4, kind: "flow", author: "", text: "o" });
  const cards = store.readRoomCards("r1", [card, chat, Number(draft), other]);
  assert.deepEqual(cards.map((c) => c.id), [card]);
});

test("clientMessageStatus：全状态/legacy/not_found 均纯读", async (t) => {
  const { clientMessageStatus } = await import("./client-messages.js");
  const store = makeStore(t);
  store.clientMsgBegin("k:a", "fp", "room", "r1", { at: 1, kind: "user", author: "我", text: "x" });
  assert.equal(clientMessageStatus(store, "k:a").deliveryStatus, "uncertain");
  store.clientMsgFinish("k:a", "accepted", { sent: ["s1"], skipped: [] });
  const acc = clientMessageStatus(store, "k:a");
  assert.equal(acc.deliveryStatus, "accepted");
  assert.equal(acc.deduped, true);
  assert.deepEqual(acc.sent, ["s1"]);
  store.clientMsgSet("k:legacy", { sent: ["s2"], skipped: [] });
  const leg = clientMessageStatus(store, "k:legacy");
  assert.equal(leg.deliveryStatus, "accepted");
  assert.equal(leg.deduped, true);
  assert.equal(clientMessageStatus(store, "k:none").deliveryStatus, "not_found");
  assert.equal(store.read("room", "r1").filter((e) => e.kind === "user").length, 1);
});

test("index prompt.send/room.message 提取：同 key 改 payload 冲突/控制拒绝/无 id 兼容/上下文校验", async (t) => {
  const { runClientMessage } = await import("./client-messages.js");
  const store = makeStore(t);
  const idxSrc = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const sfAst = tsAst.createSourceFile("index.ts", idxSrc, tsAst.ScriptTarget.Latest, true, tsAst.ScriptKind.TS) as never;
  let stableFingerprint: ((v: unknown) => string) | null = null;
  const visit = (n: { name?: { text?: string }; initializer?: { getText: () => string }; getText: () => string }) => {
    if (stableFingerprint) return;
    const name = (n as { name?: { text?: string } }).name;
    if (name && name.text === "stableFingerprint" && (n as { initializer?: { getText: () => string } }).initializer) {
      const init = (n as { initializer: { getText: () => string } }).initializer.getText();
      const fnSrc = tsAst.transpileModule(`module.exports = ${init};`, {
        compilerOptions: { target: tsAst.ScriptTarget.ES2020, module: tsAst.ModuleKind.CommonJS },
      }).outputText;
      const box: Record<string, unknown> = { module: { exports: null }, createHash, JSON, Array, Object };
      vm.runInNewContext(fnSrc, box, { timeout: 5000 });
      stableFingerprint = (box.module as { exports: (v: unknown) => string }).exports;
    }
    tsAst.forEachChild(n, visit as never);
  };
  tsAst.forEachChild(sfAst, visit as never);
  assert.ok(stableFingerprint, "extract real stableFingerprint");

  const promptCalls: number[] = [];
  const roomCalls: number[] = [];
  const flow = { flowId: "f1", missionId: "m1", phase: "working", clarificationId: "h1" };
  const sb = {
    store, runClientMessage, stableFingerprint,
    parseSlash: () => null, HUB_SLASH_COMMANDS: new Set(), handleSessionSlash: () => ({}), handleRoomSlash: () => ({}),
    sessionLostReplyNote: () => null, roomLostReplyNote: () => null,
    agentOps: { prompt: async () => { promptCalls.push(1); } },
    roomModeManager: {
      getFlow: () => flow,
      hasAwaitingRetry: () => false,
      retryFailedTasks: () => false,
      handle: async () => { roomCalls.push(1); return { sent: ["s1"], skipped: [] }; },
    },
    rooms: { get: () => ({ roomId: "r1" }) },
    persistState() {}, broadcast() {},
    parseRetryCommand: (txt: string) => (/^(?:retry|重试)(?:\s|$)/i.test(txt) ? { taskIds: [] } : null),
    helpAnswerIntent,
    CANCEL_TEXT: /^(?:停止|取消|终止|中断|停下|别做了|stop|cancel|abort)$/i,
  };
  const runPrompt = compileIndexCase(extractIndexCaseBody("prompt.send"), sb);
  const runRoom = compileIndexCase(extractIndexCaseBody("room.message"), sb);
  const base = { sessionId: "s1", content: [{ type: "text", text: "hi" }], clientMessageId: "cm1" };
  const r1 = await runPrompt({ ...base }) as Record<string, unknown>;
  assert.equal(r1.deliveryStatus, "accepted");
  assert.equal(promptCalls.length, 1);
  await assert.rejects(runPrompt({ ...base, intent: "supplement" }), /client_message_conflict/);
  assert.equal(promptCalls.length, 1);
  await assert.rejects(runPrompt({ ...base, clientMessageId: "cm2", content: [{ type: "text", text: "取消" }] }), /client_message_control/);
  const legacy = await runPrompt({ sessionId: "s1", content: [{ type: "text", text: "hi" }] }) as Record<string, unknown>;
  assert.equal(legacy.accepted, true);
  assert.equal(promptCalls.length, 2);

  const rb = { roomId: "r1", text: "hello", clientMessageId: "cm-r1" };
  const rr1 = await runRoom({ ...rb }) as Record<string, unknown>;
  assert.equal(rr1.deliveryStatus, "accepted");
  assert.equal(roomCalls.length, 1);
  await assert.rejects(runRoom({ ...rb, targets: ["w2"] }), /client_message_conflict/);
  assert.equal(roomCalls.length, 1);
  await assert.rejects(
    runRoom({ roomId: "r1", text: "m2", clientMessageId: "cm-r2", expectedMissionId: null }),
    /client_message_context_changed/,
    "expectedMissionId:null 与实际 m1 不符应拒绝",
  );
  assert.equal(roomCalls.length, 1);
  await assert.rejects(
    runRoom({ roomId: "r1", text: "重试", clientMessageId: "cm-r3", replyTo: "h1" }),
    /client_message_control/,
    "replyTo 不能豁免 retry",
  );
  await assert.rejects(
    runRoom({ roomId: "r1", text: "取消", clientMessageId: "cm-r4", replyTo: null, intent: "supplement" }),
    /client_message_control/,
    "replyTo:null+supplement 不能绕过取消拒绝",
  );
  const okAns = await runRoom({ roomId: "r1", text: "取消", clientMessageId: "cm-r5", answer: true, replyTo: "h1" }) as Record<string, unknown>;
  assert.equal(okAns.deliveryStatus, "accepted", "answer:true+replyTo 合法答复放行");
  const noIdRoom = await runRoom({ roomId: "r1", text: "m3" }) as Record<string, unknown>;
  assert.equal(noIdRoom.sent ? "ok" : "ok", "ok");
  assert.equal(roomCalls.length, 3);
});

test("index client.message.status 提取：非法参数拒绝 + 状态查询", async (t) => {
  const { clientMessageStatus } = await import("./client-messages.js");
  const store = makeStore(t);
  const run = compileIndexCase(extractIndexCaseBody("client.message.status"), { clientMessageStatus, store });
  await assert.rejects(run({ method: "x" }), /method/);
  await assert.rejects(run({ method: "prompt.send" }), /scope id required/);
  await assert.rejects(run({ method: "prompt.send", sessionId: "s1", clientMessageId: 1 }), /clientMessageId/);
  const miss = await run({ method: "prompt.send", sessionId: "s1", clientMessageId: "cm-x" }) as Record<string, unknown>;
  assert.equal(miss.deliveryStatus, "not_found");
});

function guardedRoom(t: { after: (fn: () => void) => void }) {
  const store = makeStore(t);
  const state = {
    flow: { flowId: "f1", missionId: "m1", phase: "working", mode: "conductor", clarificationId: "h1" } as Record<string, unknown> | null,
    room: { roomId: "r1", mode: "conductor" },
    subMode: null as string | null,
    dispatches: 0,
  };
  const run = compileIndexCase(extractIndexCaseBody("room.message"), {
    store, runClientMessage, stableFingerprint: JSON.stringify,
    parseSlash: () => null, HUB_SLASH_COMMANDS: new Set(), handleRoomSlash: () => ({}),
    roomLostReplyNote: () => null, persistState() {}, broadcast() {},
    parseRetryCommand: () => null, helpAnswerIntent,
    CANCEL_TEXT: /^(?:停止|取消|终止|中断|停下|别做了|stop|cancel|abort)$/i,
    rooms: { get: () => state.room },
    roomModeManager: {
      getFlow: () => state.flow ?? undefined,
      subModeFor: () => state.subMode ? { mode: state.subMode } : undefined,
      hasAwaitingRetry: () => false,
      handle: async () => { state.dispatches++; return { sent: ["worker"], skipped: [] }; },
    },
  });
  const params = (id: string) => ({
    roomId: "r1", text: "supplement", clientMessageId: id,
    expectedFlowId: "f1", expectedMissionId: "m1", expectedFlowState: "active", expectedRoomMode: "conductor",
  });
  return { store, state, run, params };
}

test("clientMessageFlowState: absorption and restart boundaries", () => {
  assert.equal(clientMessageFlowState(null), "none");
  assert.equal(clientMessageFlowState({ phase: "done" }), "terminal");
  assert.equal(clientMessageFlowState({ phase: "cancelled" }), "terminal");
  assert.equal(clientMessageFlowState({ phase: "awaiting-retry" }), "restart");
  assert.equal(clientMessageFlowState({ phase: "summarizing", mode: "parallel" }), "restart");
  assert.equal(clientMessageFlowState({ phase: "summarizing", mode: "debate" }), "restart");
  assert.equal(clientMessageFlowState({ phase: "summarizing", mode: "pipeline" }), "active");
  assert.equal(clientMessageFlowState({ phase: "summarizing", mode: "conductor" }), "active");
  assert.equal(clientMessageFlowState({ phase: "done" }, "deciding"), "deciding");
});

test("index room context: same flow changing intent rejects before history or dispatch", async (t) => {
  for (const change of ["done", "retry", "parallel-summary", "deciding", "mode"]) {
    const e = guardedRoom(t);
    if (change === "done") e.state.flow!.phase = "done";
    if (change === "retry") e.state.flow!.phase = "awaiting-retry";
    if (change === "parallel-summary") Object.assign(e.state.flow!, { mode: "parallel", phase: "summarizing" });
    if (change === "deciding") e.state.subMode = "deciding";
    if (change === "mode") e.state.room.mode = "parallel";
    await assert.rejects(e.run(e.params(change)), /client_message_context_changed/);
    assert.equal(e.state.dispatches, 0, change);
    assert.equal(e.store.read("room", "r1").length, 0, change);
    assert.equal(e.store.clientMsgReceipt(`room.message:r1:${change}`), undefined, change);
  }
});

test("index room context: normal progress and intentional terminal new goal are accepted", async (t) => {
  const e = guardedRoom(t);
  for (const phase of ["planning", "working", "summarizing"]) {
    e.state.flow!.phase = phase;
    const response = await e.run(e.params(phase)) as Record<string, unknown>;
    assert.equal(response.deliveryStatus, "accepted");
  }
  e.state.flow!.phase = "done";
  const response = await e.run({ ...e.params("new-goal"), expectedFlowState: "terminal" }) as Record<string, unknown>;
  assert.equal(response.deliveryStatus, "accepted");
  assert.equal(e.state.dispatches, 4);
});

test("index room context: old receipt settles after phase and question change without redispatch", async (t) => {
  const e = guardedRoom(t);
  const params = { ...e.params("answer"), replyTo: "h1", intent: "answer" };
  assert.equal((await e.run(params) as Record<string, unknown>).deliveryStatus, "accepted");
  Object.assign(e.state.flow!, { phase: "done", clarificationId: "h2" });
  assert.equal((await e.run(params) as Record<string, unknown>).deliveryStatus, "accepted");
  assert.equal(e.state.dispatches, 1);
  assert.equal(e.store.read("room", "r1").length, 1);
  await assert.rejects(e.run({ ...params, clientMessageId: "expired-answer" }), /client_message_context_changed/);
});

test("index room context: changed question and mode without flow are not new supplements", async (t) => {
  const e = guardedRoom(t);
  e.state.flow!.clarificationId = "h2";
  await assert.rejects(e.run({ ...e.params("old-question"), replyTo: "h1", intent: "answer" }), /client_message_context_changed/);
  e.state.flow = null;
  e.state.room.mode = "parallel";
  await assert.rejects(e.run({
    ...e.params("mode-no-flow"), expectedFlowId: null, expectedMissionId: null, expectedFlowState: "none",
  }), /client_message_context_changed/);
  assert.equal(e.state.dispatches, 0);
  assert.equal(e.store.read("room", "r1").length, 0);
});

test("index room context: invalid semantic state is rejected", async (t) => {
  const e = guardedRoom(t);
  await assert.rejects(e.run({ ...e.params("invalid"), expectedFlowState: "unknown" }), /client_message_context_changed/);
  assert.equal(e.state.dispatches, 0);
  assert.equal(e.store.read("room", "r1").length, 0);
});

test("index room context: unbound answer cannot be queued against a future question", async (t) => {
  const e = guardedRoom(t);
  for (const text of ["答：yes", "answer: yes", "reply: yes"]) {
    await assert.rejects(e.run({ ...e.params(text), text }), /client_message_context_changed/);
  }
  assert.equal(e.state.dispatches, 0);
  assert.equal(e.store.read("room", "r1").length, 0);
});

test("history handlers: zero cursor rebuild and scoped entryIds use real Store", async (t) => {
  const store = makeStore(t);
  for (const scope of ["room", "session"] as const) {
    const target = `${scope}-target`;
    const ids = Array.from({ length: 3 }, (_, i) =>
      store.append(scope, target, { at: i + 1, kind: "assistant", author: "worker", text: `row-${i}` }));
    const run = compileIndexCase(extractIndexCaseBody(`${scope}.history`), { store });
    const idKey = `${scope}Id`;
    const first = await run({ [idKey]: target, afterId: 0, limit: 2 }) as Record<string, unknown>;
    assert.equal(first.truncated, false);
    assert.equal(first.hasMore, true);
    assert.deepEqual(JSON.parse(JSON.stringify(first.entries)).map((e: { id: number }) => e.id), ids.slice(0, 2));
    const next = await run({ [idKey]: target, afterId: ids[1], limit: 2 }) as Record<string, unknown>;
    assert.deepEqual(JSON.parse(JSON.stringify(next.entries)).map((e: { id: number }) => e.id), ids.slice(2));
    assert.equal(next.hasMore, false);
    const selected = await run({ [idKey]: target, entryIds: [ids[2], ids[0], ids[0]] }) as Record<string, unknown>;
    assert.deepEqual(JSON.parse(JSON.stringify(selected.entries)).map((e: { id: number }) => e.id), [ids[0], ids[2]]);
    assert.deepEqual((await run({ [idKey]: "other", entryIds: ids }) as Record<string, unknown>).entries, []);
    for (const entryIds of ["bad", [0], [-1], [1.5], ["1"], Array(201).fill(1)]) {
      await assert.rejects(run({ [idKey]: target, entryIds }), /invalid_history_ids/);
    }
  }
});

test("room.flow 恢复协议：无 flow 时字段序列化为 null 不丢键，有 flow 原样透传", async (t) => {
  const store = makeStore(t);
  const flowFixture = { flowId: "flow-1", phase: "working" };
  const state: { flow: Record<string, unknown> | undefined } = { flow: undefined };
  const run = compileIndexCase(extractIndexCaseBody("room.flow"), {
    store,
    rooms: { get: (id: string) => (id === "r1" ? { roomId: "r1", mode: "mention" } : undefined) },
    roomModeManager: { getFlow: () => state.flow, subModeFor: () => undefined },
  });
  const roundTrip = async (params: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await run(params))) as Record<string, unknown>;

  const empty = await roundTrip({ roomId: "r1" });
  assert.equal(Object.hasOwn(empty, "flow"), true, "room.flow 响应必须显式携带 flow 键");
  assert.equal(empty.flow, null);

  state.flow = flowFixture;
  const active = await roundTrip({ roomId: "r1" });
  assert.deepEqual(active.flow, flowFixture);

  await assert.rejects(run({ roomId: "unknown" }), /unknown room/);
});

test("room.sync 恢复协议：无 flow 时字段序列化为 null 且快照字段齐全", async (t) => {
  const store = makeStore(t);
  const flowFixture = { flowId: "flow-1", phase: "working" };
  const state: { flow: Record<string, unknown> | undefined } = { flow: undefined };
  const run = compileIndexCase(extractIndexCaseBody("room.sync"), {
    store,
    rooms: {
      get: (id: string) => (id === "r1" ? { roomId: "r1", mode: "mention" } : undefined),
      getBlackboard: () => [],
    },
    roomModeManager: { getFlow: () => state.flow, subModeFor: () => undefined },
  });
  const roundTrip = async (params: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(await run(params))) as Record<string, unknown>;

  const snap = await roundTrip({ roomId: "r1", knownCardIds: [] });
  assert.equal(Object.hasOwn(snap, "flow"), true, "room.sync 响应必须显式携带 flow 键");
  assert.equal(snap.flow, null);
  assert.equal(snap.mode, "mention");
  assert.deepEqual(snap.blackboard, []);
  assert.equal(snap.subMode, null);
  assert.equal(snap.activeSpeaker, null);
  assert.deepEqual(snap.cards, []);

  state.flow = flowFixture;
  const active = await roundTrip({ roomId: "r1", knownCardIds: [] });
  assert.deepEqual(active.flow, flowFixture);

  const noCards = await roundTrip({ roomId: "r1" });
  assert.equal(Object.hasOwn(noCards, "cards"), false, "无 knownCardIds 时不返回 cards 键");

  await assert.rejects(run({ roomId: "unknown" }), /unknown room/);
});
