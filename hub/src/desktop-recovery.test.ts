import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx/package.json"))("esbuild");
const directory = fileURLToPath(new URL("../../desktop/src/hub/", import.meta.url));
const bundles = new Map<string, Promise<string>>();
type Obj = Record<string, any>;

test("Desktop 待办入口使用真实 awaiting-input 阶段并隔离 scope", () => {
  const ui = fs.readFileSync(path.join(directory, "../screens/ChatScreen.tsx"), "utf8");
  const start = ui.indexOf("  const attentionDecisions =");
  const end = ui.indexOf("  const [attentionHint", start);
  assert.ok(start >= 0 && end > start);
  const count = vm.runInNewContext(`(store) => { ${ui.slice(start, end)}; return attentionCount; }`);
  const state = { currentRoom: { roomId: "r1" }, currentSession: null, pendingDecisions: [] as Obj[],
    flow: { phase: "awaiting-input", clarificationId: "question-1", tasks: [] as Obj[] } as Obj | null };
  assert.equal(count(state), 1);
  state.flow = { phase: "working", tasks: [{ waitingFor: "user", waitingHelpId: "h1" }] };
  assert.equal(count(state), 1);
  state.flow = { phase: "awaiting-retry", tasks: [] };
  assert.equal(count(state), 1);
  state.flow = { phase: "done", clarificationId: "old", tasks: [{ waitingFor: "user" }] };
  assert.equal(count(state), 0);
  state.flow = null;
  state.pendingDecisions = [{ status: "pending", roomId: "r2" }];
  assert.equal(count(state), 0);
  state.pendingDecisions.push({ status: "pending", roomId: "r1" });
  assert.equal(count(state), 1);
});

function bundle(name: string): Promise<string> {
  let pending = bundles.get(name);
  if (!pending) {
    pending = esbuild.build({
      entryPoints: [path.join(directory, name)], bundle: true, write: false, format: "cjs",
      platform: "node", external: ["zustand"], logLevel: "silent",
      plugins: [{
        name: "native-bridge",
        setup(build: any) {
          build.onResolve({ filter: /^\.\/commands$/ }, () => ({ path: "native", namespace: "test" }));
          build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `
              export const loadConfig = async () => globalThis.native.load();
              export const saveConfig = async (s) => globalThis.native.save(s);
              export const setTrayTooltip = async () => {};
              export const setTrayMenu = async () => {};
              export const showNotification = async () => {};
              export const isNotificationPermissionGranted = async () => true;
              export const requestNotificationPermission = async () => "granted";
            `,
          }));
        },
      }],
    }).then((result: any) => result.outputFiles[0].text) as Promise<string>;
    bundles.set(name, pending);
  }
  return pending;
}

const room = { roomId: "r1", name: "Room", mode: "conductor", members: [["s1", "Worker"]] };
const session = { sessionId: "s1", name: "Worker", cwd: ".", agent: "devin", busy: false, offline: false };
const flow = { roomId: "r1", flowId: "f1", phase: "working", tasks: [],
  progress: { done: 0, running: 1, pending: 0, failed: 0, total: 1 } };
const row = (id: number, text = `text-${id}`, extra: Obj = {}) =>
  ({ id, at: id, kind: "assistant", author: "Worker", text, draft: 0, ...extra });
const gate = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => { resolve = r; });
  return { promise, resolve };
};
async function until(check: () => unknown) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(check(), "condition did not settle");
}

function sharedStorage(map?: Map<string, string>, readFails = false) {
  const backing = map ?? new Map<string, string>();
  let failSet = false;
  const ls = {
    getItem: (k: string) => { if (readFails) throw new Error("read broken"); return backing.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (failSet) throw new Error("quota"); backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
    clear: () => { backing.clear(); },
    key: () => null,
    get length() { return backing.size; },
  };
  return { backing, ls, fail: (v: boolean) => { failSet = v; } };
}

async function environment(t: { after: (fn: () => void) => void }, name = "store.ts", storageMap?: Map<string, string>, readFails = false) {
  const calls: Obj[] = [];
  const sockets: Socket[] = [];
  let config = "";
  let respond: (req: Obj) => any = () => ({});
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onopen: any; onclose: any; onerror: any; onmessage: any;
    constructor(public url: string) { sockets.push(this); }
    send(text: string) {
      const req = JSON.parse(text);
      calls.push(req);
      Promise.resolve().then(() => respond(req)).then(
        (result) => this.emit({ id: req.id, result }),
        (error) => this.emit({ id: req.id, error: String(error.message ?? error) }),
      );
    }
    open() { this.readyState = 1; this.onopen?.({}); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "closed" }); }
    emit(value: Obj) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const storage = sharedStorage(storageMap, readFails);
  const mod = { exports: {} as Obj };
  const vmGlobals = {
    module: mod, exports: mod.exports, require: requireDesktop, console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    WebSocket: Socket, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
    URL, atob, btoa, escape, Blob,
    native: { load: () => config, save: (s: string) => { config = s; } },
    localStorage: storage.ls,
    document: { documentElement: { classList: { toggle() {}, add() {}, remove() {} }, style: {} } },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {},
      setTimeout, clearTimeout, setInterval, clearInterval,
      localStorage: storage.ls },
  };
  vm.runInNewContext(await bundle(name), vmGlobals);
  const store = mod.exports.useHubStore;
  t.after(() => { store?.getState().disconnect(); });
  const rows: Obj[] = [row(100)];
  const base = (req: Obj): any => {
    const p = req.params ?? {};
    switch (req.method) {
      case "agent.info": return { deliveryProtocol: 1, hubId: "hub-1", maxReplayAgeMs: 86400000, agents: [] };
      case "session.list": return { sessions: [session] };
      case "room.list": return { rooms: [room] };
      case "mission.list": return { missions: [] };
      case "decision.list": return { decisions: [] };
      case "room.sync": return { mode: room.mode, flow, blackboard: [], cards: rows.filter((r) => p.knownCardIds?.includes(r.id)) };
      case "room.history": return {
        entries: rows.filter((r) => p.entryIds ? p.entryIds.includes(r.id) : p.afterId == null || r.id > p.afterId),
        hasMore: false,
      };
      case "session.history": return { entries: [], hasMore: false };
      case "room.message": return { deliveryStatus: "accepted", historyId: 201, sent: [] };
      case "client.message.status": return { deliveryStatus: "uncertain" };
      default: return {};
    }
  };
  respond = base;
  return {
    exports: mod.exports, sockets, calls, rows, base, storage,
    get: () => store.getState(), set: (value: Obj) => store.setState(value),
    route: (fn: (req: Obj) => any) => { respond = fn; },
    async connect(address = "localhost", token = "test") {
      store.getState().connect(address, token);
      sockets.at(-1)!.open();
      await until(() => store.getState().deliveryReady || store.getState().connectError);
    },
    async view() {
      store.setState({ currentRoom: room, currentSession: null, flow });
      await store.getState().loadHistory("room.history", "roomId", "r1");
    },
  };
}

test("model switch sync errors preserve selection and never announce success", async (t) => {
  const e = await environment(t);
  await e.connect();
  const model = { uid: "gemini-4-argon-high", label: "Gemini", backend: "devin" };
  e.set({ currentSession: session, modelCurrent: "swe-2-high", showModelPicker: true, chatItems: [],
    roomMemberModels: { s1: { name: "Worker", backend: "devin", model: "swe-2-high" } } });
  e.route(req => req.method === "model.set"
    ? { set: true, model, syncErrors: [{ sessionId: "s1", error: "Invalid params" }] } : e.base(req));
  await e.get().switchModel(model);
  assert.equal(e.get().modelCurrent, "swe-2-high");
  assert.equal(e.get().showModelPicker, true);
  assert.match(e.get().connectError, /Invalid params/);
  assert.equal(e.get().chatItems.length, 0);
  await e.get().switchModelForMember("s1", model);
  assert.equal(e.get().roomMemberModels.s1.model, "swe-2-high");
  assert.equal(e.get().chatItems.length, 0);
});

test("single-chat model slash command targets only its session", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.set({ currentSession: session, currentRoom: null, chatItems: [] });
  e.route(req => req.method === "model.set"
    ? { set: true, model: { uid: "swe-2-high", label: "SWE-2" }, syncErrors: [] } : e.base(req));
  assert.equal(e.get().handleSlashCommand("/model swe-2-high"), true);
  await until(() => e.get().modelCurrent === "swe-2-high");
  const request = e.calls.find(req => req.method === "model.set");
  assert.equal(request?.params.sessionId, "s1");
  assert.equal(e.get().chatItems.filter((item: Obj) => item.kind === "system").length, 1);
});

test("first recovery failure never enables automatic delivery", async (t) => {
  const e = await environment(t);
  e.route((req) => { if (req.method === "agent.info") throw new Error("unavailable"); return e.base(req); });
  await e.connect();
  assert.equal(e.get().deliveryReady, false);
  assert.ok(e.get().connectError);
  assert.equal(e.calls.filter((r) => r.method === "room.message").length, 0);
});

test("recovery barrier completes before queued room message is sent", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const g = gate();
  e.route((req) => req.method === "agent.info" ? g.promise : e.base(req));
  const recovering = e.get().reconnectRecovery();
  e.get().sendRoomMessage("queued");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.calls.filter((r) => r.method === "room.message").length, 0);
  g.resolve(e.base({ method: "agent.info" }));
  await recovering;
  await until(() => e.calls.some((r) => r.method === "room.message"));
});

test("live 旧卡不污染 raw 窗口 cursor：广播 row1@1 后分页仍 before100→before50", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 149 }, (_, i) => row(i + 1, `m${i + 1}`)));
  const pageCalls: Obj[] = [];
  e.route((req) => {
    if (req.method === "room.history") {
      const p = req.params as Obj;
      if (p.beforeId != null) {
        pageCalls.push(p);
        const pool = e.rows.filter((r: Obj) => r.at < p.before || (r.at === p.before && r.id < p.beforeId));
        const page = pool.slice(-50);
        return { entries: page, hasMore: pool.length > page.length };
      }
      const page = e.rows.slice(-50);
      return { entries: page, hasMore: e.rows.length > 50 };
    }
    return e.base(req);
  });
  await e.connect();
  await e.view();
  assert.equal(e.get().chatItems.filter((it: Obj) => it.historyId != null).length, 50);
  const oldFlow = row(1, JSON.stringify({ ...flow, flowId: "old-live", phase: "working" }), { kind: "flow", at: 1 });
  e.rows[0] = oldFlow;
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: oldFlow } });
  await until(() => e.get().chatItems.some((it: Obj) => it.historyId === 1 && it.kind === "flow"));
  assert.equal((e.get().chatItems.find((it: Obj) => it.historyId != null) as Obj | undefined)?.at, 1, "显示首部确为旧卡");
  e.set({ historyHasMore: true });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0]!.before, 100, "before 取 raw 尾页最小 tuple，不被 live row1 污染");
  assert.equal(pageCalls[0]!.beforeId, 100);
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls.length, 2);
  assert.equal(pageCalls[1]!.before, 50, "下一页游标继续取 raw 页最小 tuple");
  assert.equal(pageCalls[1]!.beforeId, 50);
});

for (const scope of ["session", "room"] as const) {
  test(`${scope}: 同毫秒增量历史在恢复及重进后保持行 ID 顺序`, async (t) => {
    const e = await environment(t);
    e.rows.splice(0, e.rows.length, row(100, "first", { at: 1000 }));
    e.route(req => req.method === `${scope}.history`
      ? { entries: e.rows.filter(r => req.params.entryIds
          ? req.params.entryIds.includes(r.id) : req.params.afterId == null || r.id > req.params.afterId), hasMore: false }
      : e.base(req));
    await e.connect();
    e.set({ currentSession: scope === "session" ? session : null, currentRoom: scope === "room" ? room : null });
    const id = scope === "room" ? "r1" : "s1";
    await e.get().loadHistory(`${scope}.history`, `${scope}Id`, id);
    e.rows.push(row(200, "second", { at: 1000 }));
    await e.get().reconnectRecovery();
    const ids = () => Array.from(e.get().chatItems.filter((it: Obj) => it.historyId), (it: Obj) => it.historyId);
    assert.deepEqual(ids(), [100, 200]);
    await e.get().loadHistory(`${scope}.history`, `${scope}Id`, id);
    assert.deepEqual(ids(), [100, 200]);
  });
}

test("迟到过程卡位于正在输出的结论之前且不拆断后续 chunk", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  // 真实事件序：generating 先于 chunk 到达；无 busy 的 chunk 会被 applyStreamBatch 门控丢弃
  e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s1", stoppable: true } });
  e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part" } });
  await until(() => e.get().chatItems.some((it: Obj) => it.streaming));
  const stream = e.get().chatItems.find((it: Obj) => it.streaming);
  const card = row(200, JSON.stringify({
    processId: "proc-1", sessionId: "s1", turnStartAt: stream.at - 1,
    turnEndAt: stream.at + 1, steps: [], status: "done",
  }), { kind: "process", at: stream.at + 1 });
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: card } });
  const items = e.get().chatItems;
  assert.ok(items.findIndex((it: Obj) => it.processId === "proc-1") < items.findIndex((it: Obj) => it.streaming), JSON.stringify(items));
  e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ial" } });
  await until(() => e.get().chatItems.some((it: Obj) => it.text === "partial"));
  assert.equal(e.get().chatItems.filter((it: Obj) => it.kind === "assistant" && !it.historyId).length, 1);
});

test("迟到 flow 快照按 startedAt 归位，原位状态更新不改变锚点", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, row(100, "question", { kind: "user", at: 1000 }), row(200, "summary", { at: 3000 }));
  await e.connect();
  await e.view();
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: { ...flow, startedAt: 2000 } } });
  assert.deepEqual(Array.from(e.get().chatItems, (it: Obj) => it.kind), ["user", "flow", "assistant"]);
  e.sockets[0]!.emit({ method: "room.process", params: {
    roomId: "r1", entry: row(150, JSON.stringify({ ...flow, startedAt: 2000, phase: "done" }), { kind: "flow", at: 2000 }),
  } });
  assert.deepEqual(Array.from(e.get().chatItems, (it: Obj) => it.kind), ["user", "flow", "assistant"]);
  assert.equal(e.get().chatItems[1].snapshot.phase, "done");
});

test("合成卡接管真实行时采用服务端 at，实时与重进的顺序一致", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length,
    row(100, "question", { kind: "user", at: 1000 }),
    row(150, "middle", { at: 2300 }),
    row(300, "summary", { at: 3000 }));
  await e.connect();
  await e.view();
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: { ...flow, startedAt: 2000 } } });
  const real = row(200, JSON.stringify({ ...flow, startedAt: 2000, phase: "done" }), { kind: "flow", at: 2500 });
  e.rows.push(real);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: real } });
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: { ...flow, startedAt: 2000, phase: "done" } } });
  const timeline = () => Array.from(e.get().chatItems, (it: Obj) => [it.historyId, it.at]);
  const live = timeline();
  assert.deepEqual(live, [[100, 1000], [150, 2300], [200, 2500], [300, 3000]]);
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.deepEqual(timeline(), live);
});

test("并行成员的 chunk 与工具事件按接收顺序落入时间线", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.set({ currentRoom: { ...room, members: [["s1", "Worker"], ["s2", "Other"]] }, currentSession: null, chatItems: [] });
  // 真实事件序：generating 先于 chunk 到达；无 busy 的 chunk 会被 applyStreamBatch 门控丢弃
  e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s1", stoppable: true } });
  e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s2", stoppable: true } });
  const chunk = (id: string, text: string) =>
    e.get().applyUpdate(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  chunk("s1", "A1");
  chunk("s2", "B1");
  chunk("s1", "A2");
  e.get().applyUpdate("s2", { sessionUpdate: "tool_call", toolCallId: "t1", title: "tool", status: "completed" });
  await until(() => e.get().chatItems.filter((it: Obj) => it.kind === "assistant").length >= 3);
  assert.deepEqual(Array.from(e.get().chatItems, (it: Obj) => it.text ?? it.title), ["A1", "B1", "A2", "tool"]);
});

test("工具前后分段回复在完成及重进后不会留下重复尾片段", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s1", stoppable: true } });
  const chunk = (text: string) =>
    e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  chunk("first");
  await until(() => e.get().chatItems.some((it: Obj) => it.streaming && it.text === "first"));
  e.get().applyUpdate("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "tool", status: "completed" });
  chunk("second");
  e.sockets[0]!.emit({ method: "prompt.done", params: { sessionId: "s1", output: "firstsecond" } });
  e.rows.push(row(200, "firstsecond", { at: Date.now() + 10 }));
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.deepEqual(Array.from(e.get().chatItems.filter((it: Obj) => it.kind === "assistant"), (it: Obj) => it.text),
    ["text-100", "firstsecond"]);
});

test("任务卡详情去除首尾空行但保留段落与正文", () => {
  const ui = fs.readFileSync(path.join(directory, "../screens/ChatScreen.tsx"), "utf8");
  for (const cls of ["flow-task-full", "flow-task-output"]) {
    const expression = ui.match(new RegExp(`className="${cls}">\\{([^}]+)\\}`))?.[1];
    assert.ok(expression);
    const render = vm.runInNewContext(`(task) => ${expression}`);
    const text = "\n\n  first\n\nsecond  \n";
    assert.equal(render({ task: text, output: text }), "first\n\nsecond");
  }
});

test("按需分页：恢复只取 tail，未知 kind 原始页仍推进 before 游标", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const befores: Obj[] = [];
  e.route((req) => {
    if (req.method === "room.history" && req.params.beforeId != null) {
      befores.push(req.params);
      return { entries: [row(req.params.beforeId - 1, "", { kind: "future-kind", at: req.params.before - 1 })], hasMore: befores.length < 3 };
    }
    if (req.method === "room.history") {
      return { entries: [row(100, "tail", { kind: "assistant", at: 100 })], hasMore: true };
    }
    return e.base(req);
  });
  await e.get().reconnectRecovery();
  assert.equal(befores.length, 0, "恢复不自动翻页");
  e.set({ historyHasMore: true });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(befores.length, 1);
  assert.equal(befores[0]!.beforeId, 100);
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(befores.length, 2);
  assert.equal(befores[1]!.beforeId, 99, "未知 kind 行也按 raw (at,id) 推进游标");
});

test("old flow card is calibrated even when its id is below cursor", async (t) => {
  const e = await environment(t);
  e.rows.unshift(row(50, JSON.stringify({ ...flow, flowId: "old", phase: "working" }), { kind: "flow" }));
  await e.connect();
  await e.view();
  e.rows[0]!.text = JSON.stringify({ ...flow, flowId: "old", phase: "done" });
  await e.get().reconnectRecovery();
  assert.equal(e.get().chatItems.find((it: Obj) => it.historyId === 50)?.snapshot.phase, "done");
  assert.ok(e.calls.some((req) => req.method === "room.sync" && req.params.knownCardIds?.includes(50)));
});

test("draft text is refreshed in place after newer history advances cursor", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, 1, row(150, "partial", { draft: 1 }), row(200, "newer"));
  await e.connect();
  await e.view();
  e.rows[0]!.text = "final";
  e.rows[0]!.draft = 0;
  await e.get().reconnectRecovery();
  assert.equal(e.get().chatItems.find((it: Obj) => it.historyId === 150)?.text, "final");
  assert.equal(e.get().chatItems.filter((it: Obj) => it.historyId === 150).length, 1);
  assert.ok(e.calls.some((req) => req.method === "room.history" && req.params.entryIds?.includes(150)));
});

test("draft final timestamp can move beyond anchor window without losing final text", async (t) => {
  const e = await environment(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-draft-id-"));
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const draftId = store.beginReplyDraft("room", "r1", { at: 100, kind: "assistant", author: "Worker", text: "partial" });
  for (let i = 0; i < 80; i++) store.append("room", "r1", { at: 200 + i, kind: "assistant", author: "Worker", text: `neighbor-${i}` });
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    const p = req.params;
    if (p.entryIds) return { entries: store.readEntries("room", "r1", p.entryIds), hasMore: false };
    if (p.afterId !== undefined) {
      const result = store.readAfterId("room", "r1", p.afterId, p.limit ?? 200);
      return { ...result, hasMore: result.entries.length === (p.limit ?? 200) };
    }
    return { entries: store.read("room", "r1"), hasMore: false };
  });
  await e.connect(); await e.view();
  store.completeReplyDraft(draftId, "final after long stream");
  assert.equal(store.readAround("room", "r1", 100, 50).some((r) => r.id === draftId), false);
  await e.get().reconnectRecovery();
  assert.equal(e.get().chatItems.find((c: Obj) => c.historyId === draftId)?.text, "final after long stream");
  assert.equal(e.get().chatItems.filter((c: Obj) => c.historyId === draftId).length, 1);
});

test("same scope waits for first acceptance and does not skip next item", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const g = gate();
  let messages = 0;
  e.route((req) => req.method === "room.message" ? (++messages === 1 ? g.promise : {
    deliveryStatus: "accepted", historyId: 202,
  }) : e.base(req));
  e.get().sendRoomMessage("one");
  e.get().sendRoomMessage("two");
  await until(() => messages === 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(messages, 1);
  g.resolve({ deliveryStatus: "accepted", historyId: 201 });
  await until(() => messages === 2);
  await until(() => e.get().outboxPending === 0);
});

test("uncertain receipt blocks following messages and status errors do not resend", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let messages = 0;
  e.route((req) => {
    if (req.method === "room.message") { messages++; return { deliveryStatus: "uncertain", historyId: 201 }; }
    if (req.method === "client.message.status") throw new Error("lookup failed");
    return e.base(req);
  });
  e.get().sendRoomMessage("one");
  e.get().sendRoomMessage("two");
  await until(() => e.get().chatItems.some((it: Obj) => it.sendStatus === "uncertain"));
  await e.get().reconnectRecovery();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(messages, 1);
  assert.equal(e.get().chatItems.find((it: Obj) => it.text === "one").sendStatus, "uncertain");
});

test("failed queue head blocks newer messages", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let messages = 0;
  e.route((req) => {
    if (req.method === "room.message") { messages++; throw new Error("rejected"); }
    return e.base(req);
  });
  e.get().sendRoomMessage("one");
  e.get().sendRoomMessage("two");
  await until(() => e.get().chatItems.some((it: Obj) => it.sendStatus === "failed"));
  await e.get().reconnectRecovery();
  assert.equal(messages, 1);
});

test("history arriving before ACK reconciles by CID without claiming acceptance", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const g = gate();
  e.route((req) => req.method === "room.message" ? g.promise : e.base(req));
  e.get().sendRoomMessage("unique");
  await until(() => e.calls.some((req) => req.method === "room.message"));
  const sent = e.calls.find((req) => req.method === "room.message")!;
  assert.equal(sent.params.expectedFlowState, "active");
  assert.equal(sent.params.expectedRoomMode, "conductor");
  assert.equal(e.get().outboxEntries.find((entry: Obj) => entry.clientMessageId === sent.params.clientMessageId)?.status, "sending");
  e.rows.push(row(201, "unique", { kind: "user", author: "我", clientMessageId: sent.params.clientMessageId }));
  await e.get().loadHistory("room.history", "roomId", "r1");
  const users = e.get().chatItems.filter((it: Obj) => it.clientMessageId === sent.params.clientMessageId);
  assert.equal(users.length, 1);
  assert.equal(users[0].sendStatus, "sending");
  g.resolve({ deliveryStatus: "accepted", historyId: 201 });
  await until(() => e.get().chatItems.find((it: Obj) => it.historyId === 201)?.sendStatus === "sent");
});

test("changing Hub cannot send old pending payload into same room id", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  e.get().sendRoomMessage("old hub only");
  e.calls.length = 0;
  e.route((req) => req.method === "agent.info" ? { ...e.base(req), hubId: "hub-2" } : e.base(req));
  await e.connect("other-host", "different-token");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.calls.filter((req) => req.method === "room.message").length, 0);
});

test("real HubClient timeout cleans pending; only server rejection is HubRpcError", async (t) => {
  const e = await environment(t, "client.ts");
  const client = new e.exports.HubClient({ heartbeatIntervalMs: 60000 });
  t.after(() => client.disconnect());
  client.connect("ws://test", () => {}, () => {});
  e.sockets[0]!.open();
  const never = gate();
  e.route(() => never.promise);
  await assert.rejects(client.call("test", {}, 1), (error: any) => error.message === "rpc timeout" && !(error instanceof e.exports.HubRpcError));
  assert.equal(client.pending.size, 0);
  e.route(() => { throw new Error("denied"); });
  await assert.rejects(client.call("test", {}, 100), (error: any) => error instanceof e.exports.HubRpcError);
  assert.equal(client.pending.size, 0);
});

test("CID history is atomic with receipt and persists across reopen", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-cid-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const entry = { at: 1, kind: "user" as const, author: "我", text: "hi", clientMessageId: "cm-1" };
  store.clientMsgBegin("k:cid", "fp", "session", "s1", entry);
  store.close();
  store = new Store(dir);
  assert.equal(store.clientMsgBegin("k:cid", "fp", "session", "s1", entry).created, false);
  assert.equal(store.read("session", "s1").length, 1);
  assert.equal(store.read("session", "s1")[0]?.clientMessageId, "cm-1");
  (store as any).db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON client_msgs BEGIN SELECT RAISE(FAIL, 'x'); END;");
  assert.throws(() => store.clientMsgBegin("k:other", "fp2", "session", "s1", { ...entry, clientMessageId: "cm-2" }));
  assert.equal(store.read("session", "s1").length, 1);
});

test("离线附件拒绝：false、无新气泡、草稿/quote 保留且不偷换", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  (e.get().client as Obj).isConnected = false;
  e.set({
    pendingAttachments: [{ name: "a.png", mimeType: "image/png", base64: "QUJD", size: 3 }],
    quote: ["u", "原引用"] });
  const before = e.get().chatItems.length;
  const ok = e.get().sendRoomMessage("hi", undefined);
  assert.equal(ok, false);
  assert.equal(e.get().chatItems.length, before);
  assert.equal(e.get().pendingAttachments.length, 1);
  assert.equal(e.get().quote?.[0], "u");
  e.set({ pendingAttachments: [{ name: "b.txt", mimeType: "text/plain", base64: "REVG", size: 3 }] });
  const ok2 = e.get().sendRoomMessage("hi2", undefined);
  assert.equal(ok2, false);
  assert.equal(e.calls.filter((r) => r.method === "room.message").length, 0);
});

test("容量：30/scope、50/总量拒绝不 shift，ID 唯一", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  for (let i = 0; i < 30; i++) assert.equal(e.get().sendRoomMessage(`m${i}`, undefined), true, `msg${i}`);
  assert.equal(e.get().sendRoomMessage("m31", undefined), false);
  const cmIds = e.get().chatItems.filter((c: Obj) => c.kind === "user" && c.clientMessageId).map((c: Obj) => c.clientMessageId);
  assert.equal(new Set(cmIds).size, 30);
  e.set({ currentRoom: { ...room, roomId: "r2" } });
  for (let i = 0; i < 20; i++) assert.equal(e.get().sendRoomMessage(`r2-${i}`, undefined), true);
  assert.equal(e.get().sendRoomMessage("r2-21", undefined), false);
});

test("send 返回 boolean；RPC 拒绝 failed 阻断后项，dismiss 放行", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let first = true;
  e.route((req) => {
    if (req.method === "room.message") { if (first) { first = false; throw new Error("client_message_conflict"); } return { deliveryStatus: "accepted", historyId: 9, sent: [] }; }
    if (req.method === "client.message.status") return { deliveryStatus: "not_found" };
    return e.base(req);
  });
  assert.equal(e.get().sendRoomMessage("a", undefined), true);
  assert.equal(e.get().sendRoomMessage("b", undefined), true);
  await until(() => e.get().chatItems.some((c: Obj) => c.kind === "user" && c.sendStatus === "failed"));
  const failed = e.get().chatItems.find((c: Obj) => c.kind === "user" && c.sendStatus === "failed");
  const pend = e.get().chatItems.find((c: Obj) => c.kind === "user" && c.sendStatus === "pending");
  assert.ok(failed && pend, "第一项 failed 第二项仍 pending 被阻断");
  e.get().dismissOutgoing(failed.clientMessageId);
  await until(() => pend.sendStatus === "sent" || e.calls.filter((r) => r.method === "room.message").length >= 2);
  assert.ok(e.calls.filter((r) => r.method === "room.message").length >= 2, "dismiss 后第二项可发");
  const users = e.get().chatItems.filter((c: Obj) => c.kind === "user" && c.clientMessageId);
  assert.equal(new Set(users.map((c: Obj) => c.clientMessageId)).size, users.length, "无重复 CID");
});

test("控制词直达：普通首条 ACK gate 中控制立即发、params 无 CID、单气泡；离线拒绝保留草稿", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let gateFirst = true;
  e.route((req) => {
    if (req.method === "room.message") {
      if (gateFirst && !(req.params?.text === "停止")) { gateFirst = false; return new Promise(() => {}); }
      return { deliveryStatus: "accepted", historyId: 9, sent: [] };
    }
    return e.base(req);
  });
  assert.equal(e.get().sendRoomMessage("普通任务", undefined), true);
  assert.equal(e.get().sendRoomMessage("停止", undefined), true);
  await until(() => e.calls.filter((r) => r.method === "room.message").length >= 2);
  const msgs = e.calls.filter((r) => r.method === "room.message");
  const ctrl = msgs.find((r) => r.params?.text === "停止");
  const normal = msgs.find((r) => r.params?.text !== "停止");
  assert.ok(ctrl && !ctrl.params.clientMessageId, "控制不带 remote CID");
  assert.ok(normal?.params.clientMessageId, "普通带 CID");
  assert.equal(e.get().chatItems.filter((c: Obj) => c.kind === "user" && c.text === "停止").length, 1);
  (e.get().client as Obj).isConnected = false;
  e.set({ deliveryReady: false, quote: ["q", "r"] });
  assert.equal(e.get().sendRoomMessage("停止", undefined), false);
  assert.equal(e.get().quote?.[0], "q");
});

test("legacy 协议 0：离线文本拒绝保草稿", async (t) => {
  const e = await environment(t);
  e.route((req) => req.method === "agent.info" ? { deliveryProtocol: 0, agents: [] } : e.base(req));
  await e.connect();
  await e.view();
  (e.get().client as Obj).isConnected = false;
  e.set({ deliveryProtocol: 0, quote: ["a", "b"] });
  const before = e.get().chatItems.length;
  assert.equal(e.get().sendRoomMessage("x", undefined), false);
  assert.equal(e.get().chatItems.length, before);
  assert.equal(e.get().quote?.[0], "a");
});

test("持久化：离线文本入队→新 VM 同 storage 恢复同 CID，恢复后仅首发一次", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ deliveryReady: false });
  (e1.get().client as Obj).isConnected = false;
  assert.equal(e1.get().sendRoomMessage("offline msg", undefined), true);
  const cid = (e1.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  e1.get().disconnect();
  const e2 = await environment(t, "store.ts", map);
  await e2.connect();
  await e2.view();
  await until(() => e2.calls.some((r) => r.method === "room.message"));
  const msgs = e2.calls.filter((r) => r.method === "room.message" && r.params?.clientMessageId === cid);
  assert.equal(msgs.length, 1, "同 CID 仅首发一次");
});

test("持久化：attempted 重启先查 status，not_found 也不重发", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.route((req) => {
    if (req.method === "room.message") return new Promise(() => {});
    return e1.base(req);
  });
  assert.equal(e1.get().sendRoomMessage("a", undefined), true);
  await until(() => e1.calls.some((r) => r.method === "room.message"));
  e1.get().disconnect();
  const statusCalls: Obj[] = [];
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => {
    if (req.method === "client.message.status") { statusCalls.push(req); return { deliveryStatus: "not_found" }; }
    if (req.method === "room.message") { throw new Error("must not resend"); }
    return e2.base(req);
  });
  await e2.connect();
  await e2.view();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(statusCalls.length >= 1, "先查 receipt");
  assert.equal(e2.calls.filter((r) => r.method === "room.message").length, 0, "not_found 不重发");
});

test("持久化：accepted receipt 结算优先 TTL/flow 变更", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.route((req) => req.method === "room.message" ? new Promise(() => {}) : e1.base(req));
  assert.equal(e1.get().sendRoomMessage("a", undefined), true);
  await until(() => e1.calls.some((r) => r.method === "room.message"));
  const cid = (e1.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  e1.get().disconnect();
  // 磁盘 queuedAt 改 25h 前且 flow 换成新 flow——accepted 仍结算
  const raw = JSON.parse(map.get("agent-hub.outbox.v1")!);
  raw.entries[0].queuedAt = Date.now() - 25 * 3600_000;
  map.set("agent-hub.outbox.v1", JSON.stringify(raw));
  const e2 = await environment(t, "store.ts", map);
  const statusCalls: Obj[] = [];
  e2.route((req) => {
    if (req.method === "client.message.status") { statusCalls.push(req); return { deliveryStatus: "accepted", historyId: 55 }; }
    if (req.method === "room.message") throw new Error("must not resend");
    return e2.base(req);
  });
  e2.rows.push({ id: 55, at: 200, kind: "user", author: "我", text: "a", clientMessageId: cid });
  e2.set({ flow: { ...flow, flowId: "fNew" } });
  await e2.connect();
  await e2.view();
  await until(() => e2.get().chatItems.some((c: Obj) => c.kind === "user" && c.clientMessageId === cid && c.historyId === 55));
  const merged55 = e2.get().chatItems.find((c: Obj) => c.kind === "user" && c.clientMessageId === cid) as Obj;
  assert.ok(merged55 && merged55.sendStatus !== "sending" && merged55.sendStatus !== "pending" && merged55.sendStatus !== "uncertain", "已结算不回挂未完成态");
  assert.ok(statusCalls.length >= 1);
  assert.equal(e2.calls.filter((r) => r.method === "room.message").length, 0);
  const raw2 = map.get("agent-hub.outbox.v1")!;
  assert.ok(!raw2.includes(cid), "已结算项从磁盘移除");
});

test("持久化：不同 Hub 同 scope 不发旧项", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ deliveryReady: false });
  (e1.get().client as Obj).isConnected = false;
  assert.equal(e1.get().sendRoomMessage("hub1 msg", undefined), true);
  e1.get().disconnect();
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => req.method === "agent.info" ? { deliveryProtocol: 1, hubId: "hub-2", maxReplayAgeMs: 86400000, agents: [] } : e2.base(req));
  await e2.connect();
  await e2.view();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(e2.calls.filter((r) => r.method === "room.message").length, 0, "不同 Hub 不发");
});

test("持久化：入队存储失败 false 保留草稿/附件/无气泡", async (t) => {
  const map = new Map<string, string>();
  const e = await environment(t, "store.ts", map);
  await e.connect();
  await e.view();
  e.storage.fail(true);
  const before = e.get().chatItems.length;
  const ok = e.get().sendRoomMessage("x", undefined);
  assert.equal(ok, false);
  assert.equal(e.get().chatItems.length, before);
  assert.equal(e.get().outboxError, "storage");
});

test("持久化：发送前 attempted/sending 持久化失败无 room.message", async (t) => {
  const map = new Map<string, string>();
  const e = await environment(t, "store.ts", map);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  (e.get().client as Obj).isConnected = false;
  assert.equal(e.get().sendRoomMessage("queued", undefined), true);
  e.storage.fail(true);
  (e.get().client as Obj).isConnected = true;
  e.set({ deliveryReady: true });
  e.get().checkOutgoing((e.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(e.calls.filter((r) => r.method === "room.message").length, 0);
});

test("持久化：附件 tombstone 磁盘无 base64；重启仅查不发", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ pendingAttachments: [{ name: "a.png", mimeType: "image/png", base64: "QUJD", size: 3 }] });
  assert.equal(e1.get().sendRoomMessage("img", undefined), true);
  const raw = map.get("agent-hub.outbox.v1") ?? "";
  assert.ok(!raw.includes("QUJD"), "磁盘不含 base64");
  e1.get().disconnect();
  const statusCalls: Obj[] = [];
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => {
    if (req.method === "client.message.status") { statusCalls.push(req); return { deliveryStatus: "uncertain" }; }
    return e2.base(req);
  });
  await e2.connect();
  await e2.view();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(e2.calls.filter((r) => r.method === "room.message").length, 0);
});

test("持久化：坏 JSON 原键不被覆盖且标记 corrupt", async (t) => {
  const map = new Map<string, string>([["agent-hub.outbox.v1", "{bad json"]]);
  const e = await environment(t, "store.ts", map);
  assert.equal(e.get().outboxError, "corrupt");
  const ok = e.get().sendRoomMessage("x", undefined);
  assert.equal(ok, false);
  assert.equal(map.get("agent-hub.outbox.v1"), "{bad json", "原键未被覆盖");
});

test("取消竞态：room.sync gate 中 dismiss 队首后 release 不外发，后项被唤醒", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let gateResolve: ((v: Obj) => void) | null = null;
  let syncSeen = false;
  e.route((req) => {
    if (req.method === "room.sync") {
      if (!syncSeen) { syncSeen = true; return new Promise((r) => { gateResolve = r; }); }
      return { mode: room.mode, flow, blackboard: [], cards: [] };
    }
    if (req.method === "client.message.status") return { deliveryStatus: "not_found" };
    if (req.method === "room.message") return { deliveryStatus: "accepted", historyId: 9, sent: [] };
    return e.base(req);
  });
  assert.equal(e.get().sendRoomMessage("first", undefined), true);
  assert.equal(e.get().sendRoomMessage("second", undefined), true);
  await until(() => e.calls.some((r) => r.method === "room.sync"));
  const first = e.get().chatItems.find((c: Obj) => c.kind === "user" && c.text === "first") as Obj;
  e.get().dismissOutgoing(first.clientMessageId);
  gateResolve!({ mode: room.mode, flow, blackboard: [], cards: [] });
  await until(() => e.get().chatItems.some((c: Obj) => c.kind === "user" && c.text === "second" && c.sendStatus === "sent"));
  const sentTexts = e.calls.filter((r) => r.method === "room.message").map((r) => r.params?.text);
  assert.ok(!sentTexts.includes("first"), "dismiss 的队首不得外发");
  assert.ok(sentTexts.includes("second"), "后项被唤醒发送");
});

test("socket close：未追踪控制 sending → uncertain", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.route((req) => req.method === "room.message" ? new Promise(() => {}) : e.base(req));
  assert.equal(e.get().sendRoomMessage("停止", undefined), true);
  await until(() => e.get().chatItems.some((c: Obj) => c.kind === "user" && c.text === "停止" && c.sendStatus === "sending"));
  const ctrlCid = (e.get().chatItems.find((c: Obj) => c.kind === "user" && c.text === "停止") as Obj).clientMessageId;
  e.sockets.at(-1)!.close();
  await until(() => e.get().linkDown === true);
  const ctrl = e.get().chatItems.find((c: Obj) => c.kind === "user" && c.clientMessageId === ctrlCid) as Obj;
  assert.equal(ctrl?.sendStatus, "uncertain");
});

test("数据保护：corrupt 经 connect+disconnect 后原字节不变", async (t) => {
  const map = new Map<string, string>([["agent-hub.outbox.v1", "{bad json"]]);
  const e = await environment(t, "store.ts", map);
  await e.connect();
  assert.equal(e.get().outboxError, "corrupt");
  assert.equal(e.get().sendRoomMessage("x", undefined), false);
  e.get().disconnect();
  assert.equal(map.get("agent-hub.outbox.v1"), "{bad json");
});

test("数据保护：scopeKey/CID 不匹配的恢复项整条拒绝且原键保留", async (t) => {
  const bad = { version: 1, entries: [{ clientMessageId: "c1", method: "room.message", scopeKey: "room:other", params: { roomId: "r1", clientMessageId: "c1" }, status: "pending", queuedAt: 1, origin: null, hubId: null, replayable: true, attempted: false, bubble: { kind: "user", text: "x", author: "我", clientMessageId: "c1" } }] };
  const map = new Map<string, string>([["agent-hub.outbox.v1", JSON.stringify(bad)]]);
  const e = await environment(t, "store.ts", map);
  assert.equal(e.get().outboxError, "corrupt");
  assert.equal(map.get("agent-hub.outbox.v1"), JSON.stringify(bad));
});

test("busy 不标 attempted：sync 期间 dismiss 后仍 pending 可取消且不外发", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  let gate: ((v: Obj) => void) | null = null;
  let syncSeen = false;
  e.route((req) => {
    if (req.method === "room.sync") {
      if (!syncSeen) { syncSeen = true; return new Promise((r) => { gate = r; }); }
      return { mode: room.mode, flow, blackboard: [], cards: [] };
    }
    if (req.method === "client.message.status") return { deliveryStatus: "not_found" };
    if (req.method === "room.message") return { deliveryStatus: "accepted", historyId: 9, sent: [] };
    return e.base(req);
  });
  assert.equal(e.get().sendRoomMessage("first", undefined), true);
  assert.equal(e.get().sendRoomMessage("second", undefined), true);
  await until(() => e.calls.some((r) => r.method === "room.sync"));
  const first = e.get().chatItems.find((c: Obj) => c.kind === "user" && c.text === "first") as Obj;
  e.get().dismissOutgoing(first.clientMessageId);
  gate!({ flow, blackboard: [], cards: [] });
  await until(() => e.get().chatItems.some((c: Obj) => c.kind === "user" && c.text === "second" && c.sendStatus === "sent"));
  const sent = e.calls.filter((r) => r.method === "room.message").map((r) => r.params?.text);
  assert.ok(!sent.includes("first"));
  assert.ok(sent.includes("second"));
});

test("取消+附件走普通 CID 路径不被旁路", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ pendingAttachments: [{ name: "x.png", mimeType: "image/png", base64: "QUJD", size: 3 }] });
  assert.equal(e.get().sendRoomMessage("取消", undefined), true);
  await until(() => e.calls.some((r) => r.method === "room.message"));
  const m = e.calls.find((r) => r.method === "room.message");
  assert.ok(m?.params?.clientMessageId, "带附件取消词仍带 CID 走幂等");
});

test("A: session busy 不发且不标 attempted；checkOutgoing 后单发", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ currentRoom: null, currentSession: session });
  e.route((req) => {
    if (req.method === "session.list") return { sessions: [{ ...session, busy: true }] };
    if (req.method === "prompt.send") return { deliveryStatus: "accepted", historyId: 9 };
    return e.base(req);
  });
  assert.equal(e.get().sendPrompt("busy msg", undefined, undefined), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(e.calls.filter((r) => r.method === "prompt.send").length, 0, "busy 不发");
  {
    const raw = JSON.parse(e.storage.backing.get("agent-hub.outbox.v1") ?? "{}");
    assert.equal(raw.entries?.[0]?.attempted, false, "busy 项未标 attempted");
  }
  e.route((req) => {
    if (req.method === "session.list") return { sessions: [session] };
    if (req.method === "prompt.send") return { deliveryStatus: "accepted", historyId: 9 };
    return e.base(req);
  });
  const cid = (e.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  e.get().checkOutgoing(cid);
  await until(() => e.calls.filter((r) => r.method === "prompt.send").length >= 1);
  assert.equal(e.calls.filter((r) => r.method === "prompt.send").length, 1);
});

test("B: 公网 loadHistory 恢复 pending/tombstone 气泡且不重复", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ deliveryReady: false });
  (e1.get().client as Obj).isConnected = false;
  assert.equal(e1.get().sendRoomMessage("persist me", undefined), true);
  const cid = (e1.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  e1.get().disconnect();
  const raw = JSON.parse(map.get("agent-hub.outbox.v1")!);
  raw.entries[0].attempted = true;
  raw.entries[0].status = "uncertain";
  map.set("agent-hub.outbox.v1", JSON.stringify(raw));
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => req.method === "client.message.status" ? { deliveryStatus: "uncertain" } : e2.base(req));
  await e2.connect();
  await e2.view();
  await e2.get().loadHistory("room.history", "roomId", "r1");
  const matches = e2.get().chatItems.filter((c: Obj) => c.kind === "user" && c.clientMessageId === cid);
  assert.equal(matches.length, 1, "同 CID 气泡仅一份");
});

test("C1: dismiss 写失败恢复原记录无 RPC", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  (e.get().client as Obj).isConnected = false;
  assert.equal(e.get().sendRoomMessage("x", undefined), true);
  const cid = (e.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  const saved = (e.storage.backing.get("agent-hub.outbox.v1") ?? "");
  e.storage.fail(true);
  e.get().dismissOutgoing(cid);
  assert.ok(e.get().outboxEntries.some((o: Obj) => o.clientMessageId === cid), "写失败记录仍存");
  assert.equal(e.storage.backing.get("agent-hub.outbox.v1"), saved, "磁盘未被改");
});

test("C2: getItem 失败可写时仍不覆盖原键", async (t) => {
  const map = new Map<string, string>([["agent-hub.outbox.v1", JSON.stringify({ version: 1, entries: [] })]]);
  const e = await environment(t, "store.ts", map, true);
  await e.connect().catch(() => {});
  assert.equal(e.get().outboxError, "storage");
  e.get().disconnect();
  assert.equal(map.get("agent-hub.outbox.v1"), JSON.stringify({ version: 1, entries: [] }), "读失败不覆盖");
});

test("C3: 未知 version 同样安全保留", async (t) => {
  const map = new Map<string, string>([["agent-hub.outbox.v1", JSON.stringify({ version: 99, entries: [] })]]);
  const e = await environment(t, "store.ts", map);
  assert.equal(e.get().outboxError, "corrupt");
  e.get().disconnect();
  assert.equal(map.get("agent-hub.outbox.v1"), JSON.stringify({ version: 99, entries: [] }));
});

test("D: 同文两 UUID 各自存活不互相吞", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  (e.get().client as Obj).isConnected = false;
  assert.equal(e.get().sendRoomMessage("same text", undefined), true);
  assert.equal(e.get().sendRoomMessage("same text", undefined), true);
  const cids = e.get().chatItems.filter((c: Obj) => c.kind === "user" && c.text === "same text").map((c: Obj) => c.clientMessageId);
  assert.equal(new Set(cids).size, 2);
});

test("J: metadata 缺 hubId/maxAge 不启 protocol1 离线受理", async (t) => {
  const e = await environment(t);
  e.route((req) => req.method === "agent.info" ? { deliveryProtocol: 1, agents: [] } : e.base(req));
  await e.connect();
  await e.view();
  assert.equal(e.get().deliveryProtocol, 0, "缺 hubId 时 protocol 不为1");
  e.set({ deliveryReady: false });
  (e.get().client as Obj).isConnected = false;
  e.set({ quote: ["q", "r"] });
  assert.equal(e.get().sendRoomMessage("x", undefined), false);
  assert.equal(e.get().quote?.[0], "q");
  assert.equal(e.get().sendRoomMessage("/help", undefined), true);
  assert.equal(e.get().sendRoomMessage("/retry", undefined), false);
});

test("E: tail 重置恢复不 after0 全扫、RPC 在途 live 卡保留且游标取 raw", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const liveCard = row(900, JSON.stringify({ ...flow, flowId: "f-live", phase: "working" }), { kind: "flow" });
  const historyCalls: Obj[] = [];
  const tailGate = gate();
  let gated = false;
  let serverFlow = flow;
  e.route((req) => {
    if (req.method === "room.sync") return { ...e.base(req), flow: serverFlow };
    if (req.method === "room.history") {
      historyCalls.push(req.params);
      if (req.params.beforeId != null || req.params.afterId != null) {
        return { entries: [row(50, "older", { kind: "assistant", at: 50 })], hasMore: false };
      }
      if (!gated) { gated = true; return tailGate.promise; }
      return {
        entries: Array.from({ length: 50 }, (_, k) => row(1000 + k, `tail${k}`, { kind: "assistant", at: 1000 + k })),
        hasMore: true,
      };
    }
    return e.base(req);
  });
  const recovery = e.get().reconnectRecovery();
  await until(() => gated);
  serverFlow = { ...flow, flowId: "f-live" };
  e.rows.push(liveCard);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: liveCard } });
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: serverFlow } });
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 900), "RPC 在途时确实收到 live 卡");
  tailGate.resolve({
    entries: Array.from({ length: 50 }, (_, k) => row(1000 + k, `tail${k}`, { kind: "assistant", at: 1000 + k })),
    hasMore: true,
  });
  await recovery;
  assert.ok(historyCalls.every((p) => p.afterId == null), "tail 重置不发 afterId0/追档");
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 900), "RPC 在途 live 卡不被窗口替换抹掉");
  assert.ok(!e.get().chatItems.some((c: Obj) => c.historyId === 100), "旧窗口条目不复活");
  assert.equal(e.get().chatItems.filter((it: Obj) => it.kind === "assistant" && typeof it.historyId === "number").length <= 51, true);
  historyCalls.length = 0;
  await e.get().reconnectRecovery();
  assert.ok(historyCalls.every((p) => p.afterId == null && p.limit === 50), "二次恢复仍是 bounded tail");
});

test("loadMoreHistory 分页行接管同 flowId 合成卡，不产生重复", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, row(100, "question", { kind: "user", at: 3000 }));
  await e.connect();
  await e.view();
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: { ...flow, startedAt: 2000 } } });
  const live = e.get().chatItems.find((it: Obj) => it.kind === "flow");
  assert.ok(live, "前置：flowUpdate 应建立 live 合成卡");
  assert.equal(live.historyId == null, true);
  e.set({ historyHasMore: true });
  let pageCalls = 0;
  e.route((req) => {
    if (req.method === "room.history" && req.params.beforeId === 100 && req.params.before === 3000) {
      pageCalls++;
      return { entries: [row(90, JSON.stringify({ ...flow, phase: "working" }), { kind: "flow", at: 2000 })], hasMore: false };
    }
    return e.base(req);
  });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls, 1, "分页分支应恰好命中一次");
  const flows = e.get().chatItems.filter((it: Obj) => it.kind === "flow");
  assert.equal(flows.length, 1, "同 flowId 合成卡与持久化行不得并存两张");
  assert.equal(flows[0].historyId, 90, "持久化行应接管 live 卡身份");
  const items: Obj[] = Array.from(e.get().chatItems as Obj[]);
  assert.ok(items.findIndex((it) => it === flows[0]) < items.findIndex((it) => it.kind === "user"), "接管卡应位于 user100 之前");
});

test("loadHistory 旧 RPC 迟到不得让 live room.process 更新回退", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length,
    row(200, JSON.stringify({ ...flow, phase: "working" }), { kind: "flow", at: 2000 }));
  await e.connect();
  await e.view();
  const staleGate = gate();
  const syncGate = gate();
  let gated = false;
  let syncStarted = false;
  e.route((req) => {
    if (req.method === "room.history" && req.params.afterId == null && !gated) {
      gated = true;
      return staleGate.promise;
    }
    if (req.method === "room.sync") {
      syncStarted = true;
      return syncGate.promise;
    }
    return e.base(req);
  });
  const loadPromise = e.get().loadHistory("room.history", "roomId", "r1");
  try {
    await until(() => gated);
    e.sockets[0]!.emit({ method: "room.process", params: {
      roomId: "r1", entry: row(200, JSON.stringify({ ...flow, phase: "done" }), { kind: "flow", at: 2000 }),
    } });
    await until(() => e.get().chatItems.find((it: Obj) => it.kind === "flow")?.snapshot?.phase === "done");
    staleGate.resolve({ entries: [row(200, JSON.stringify({ ...flow, phase: "working" }), { kind: "flow", at: 2000 })], hasMore: false });
    await until(() => syncStarted);
    const after = e.get().chatItems.find((it: Obj) => it.kind === "flow");
    assert.equal(after?.snapshot?.phase, "done", "旧 history 应用后 live done 不得瞬时回退 working");
  } finally {
    syncGate.resolve({ mode: room.mode, flow, blackboard: [], cards: [] });
    staleGate.resolve({ entries: [], hasMore: false });
    await loadPromise.catch(() => {});
  }
});

test("setHistoryCache 同 id 同 at 时 incoming live 快照优先", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length,
    row(200, JSON.stringify({ ...flow, phase: "working" }), { kind: "flow", at: 2000 }));
  await e.connect();
  await e.view();
  e.rows[0]!.text = JSON.stringify({ ...flow, phase: "done" });
  e.sockets[0]!.emit({ method: "room.process", params: {
    roomId: "r1", entry: row(200, JSON.stringify({ ...flow, phase: "done" }), { kind: "flow", at: 2000 }),
  } });
  await until(() => e.get().chatItems.find((it: Obj) => it.kind === "flow")?.snapshot?.phase === "done");
  e.route((req) => e.base(req));
  await e.get().loadHistory("room.history", "roomId", "r1");
  const cached = Object.values(e.get().historyCache as Record<string, Obj[]>)
    .flat().find((it: Obj) => it.kind === "flow");
  assert.equal(cached?.snapshot?.phase, "done", "缓存应保存 live done 而非旧 working");
});

test("tail 窗口：真实SQLite 500混合行limit取页、同ms边界不漏重、重进仍最近50", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-hist-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const kinds = ["user", "assistant", "flow", "process", "decision"];
  for (let i = 1; i <= 500; i++) {
    const kind = kinds[(i - 1) % kinds.length];
    const at = 1000 + Math.floor((i - 1) / 7);
    const text = kind === "flow" ? JSON.stringify({ ...flow, flowId: `f${i}`, phase: "done" })
      : kind === "process" ? JSON.stringify({ processId: `p${i}`, status: "done", title: `t${i}` })
      : kind === "decision" ? JSON.stringify({ decisionId: `d${i}`, requestId: `q${i}`, status: "answered", decisionType: "x", title: `d${i}` })
      : kind === "user" ? `u${i}` : `m${i}`;
    store.append("room", "r1", { kind, author: kind === "user" ? "me" : "Worker", text, at } as never);
  }
  assert.equal(store.read("room", "r1", 1000).length, 500, "服务端 500 条不减");
  const served: number[] = [];
  const e = await environment(t);
  e.route((req) => {
    if (req.method === "room.sync") return {
      ...e.base(req), flow: null,
      cards: store.readRoomCards("r1", (req.params.knownCardIds as number[] | undefined) ?? []),
    };
    if (req.method !== "room.history") return e.base(req);
    const p = req.params as Obj;
    if (p.entryIds != null) {
      return { entries: store.readEntries("room", "r1", [...new Set(p.entryIds as number[])]), hasMore: false };
    }
    const limit = (p.limit as number | undefined) ?? 50;
    let entries;
    if (typeof p.before === "number") entries = store.readBefore("room", "r1", p.before, limit, p.beforeId as number | undefined);
    else if (typeof p.anchorAt === "number") entries = store.readAround("room", "r1", p.anchorAt, limit);
    else entries = store.read("room", "r1", limit);
    served.push(...entries.map((r) => r.id));
    const first = entries[0];
    const hasMore = first ? store.hasMoreBefore("room", "r1", first.at, first.id) : false;
    return { entries, hasMore };
  });
  await e.connect();
  await e.view();
  const persisted = (): Obj[] => Array.from(e.get().chatItems as Obj[]).filter((it) => it.historyId != null);
  assert.equal(persisted().length, 50, "首屏只物化最近50");
  assert.equal(persisted().at(-1)?.historyId, 500);
  for (let guard = 0; guard < 15 && e.get().historyHasMore; guard++) {
    await e.get().loadMoreHistory("room.history", "roomId", "r1");
  }
  assert.equal(e.get().historyHasMore, false, "分页到底");
  assert.equal(served.length, new Set(served).size, "跨页无重复下发");
  const unique = [...new Set(served)].sort((a, b) => a - b);
  assert.equal(unique.length, 500, "500 个唯一 historyId 全部可达");
  assert.deepEqual(unique, Array.from({ length: 500 }, (_, i) => i + 1), "id 1..500 无漏无重");
  const visibleIds = persisted().map((it: Obj) => it.historyId as number).sort((a: number, b: number) => a - b);
  assert.equal(new Set(visibleIds).size, visibleIds.length, "视图无重复 historyId");
  assert.deepEqual(visibleIds, unique, "全部下发的历史在视图中也无漏项");
  const timeline = persisted().map((it: Obj) => [it.at as number, it.historyId as number]);
  assert.deepEqual(timeline, [...timeline].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!), "同毫秒历史按 ID 排序");
  const cacheItems = Object.values(e.get().historyCache as Obj).flat() as Obj[];
  const cachedStable = cacheItems.filter((it) => it.historyId != null);
  assert.equal(cachedStable.length, 50, "全为终态时缓存恰好最近50条");
  store.close();
  store = new Store(dir);
  assert.equal(store.read("room", "r1", 1000).length, 500, "关闭重开数据库后服务端历史仍在");
  e.set({ currentRoom: null, currentSession: null, chatItems: [] });
  await e.view();
  assert.equal(persisted().length, 50, "数据库重开后重新进入只显示最近50条");
  await e.get().reconnectRecovery();
  assert.equal(persisted().length, 50, "重连仍保持最近窗口");
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.equal(persisted().length, 50, "重新 loadHistory 回到最近50窗口");
  assert.equal(persisted().at(-1)?.historyId, 500);
});

test("空 tail 清游标：历史被清后 loadMore 不再误翻页", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const pageCalls: Obj[] = [];
  e.route((req) => {
    if (req.method === "room.history" && req.params.beforeId != null) {
      pageCalls.push(req.params);
      return { entries: [], hasMore: false };
    }
    if (req.method === "room.history") return { entries: [], hasMore: false };
    return e.base(req);
  });
  await e.get().reconnectRecovery();
  assert.equal(e.get().historyHasMore, false);
  e.set({ historyHasMore: true });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls.length, 0, "空 tail 后游标已清，不向错页发请求");
});

test("同 scope 第二个 baseline：旧 gated 响应不能复活旧窗口", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 100 }, (_, i) => row(i + 1, `m${i + 1}`)));
  const first = gate();
  let calls = 0;
  e.route((req) => {
    if (req.method === "room.history" && req.params.beforeId == null) {
      calls++;
      if (calls === 1) return first.promise;
      return { entries: e.rows.slice(-50), hasMore: true };
    }
    if (req.method === "room.history") {
      const p = req.params as Obj;
      const pool = e.rows.filter((r: Obj) => r.at < p.before || (r.at === p.before && r.id < p.beforeId));
      return { entries: pool.slice(-50), hasMore: pool.length > 50 };
    }
    return e.base(req);
  });
  await e.connect();
  const viewPromise = e.view();
  await until(() => calls === 1);
  try {
    await e.get().loadHistory("room.history", "roomId", "r1");
    assert.equal(e.get().chatItems.filter((it: Obj) => it.historyId != null).at(-1)?.historyId, 100, "新请求已先返回");
  } finally {
    first.resolve({ entries: e.rows.slice(0, 50), hasMore: true });
    await viewPromise;
  }
  const persisted = e.get().chatItems.filter((it: Obj) => it.historyId != null);
  assert.equal(persisted.length, 50);
  assert.equal(persisted.at(-1)?.historyId, 100, "新 baseline 窗口=最近50，旧 gated 1..50 未复活");
  assert.ok(!persisted.some((it: Obj) => it.historyId === 1), "旧窗口条目不复活");
});

test("baseline 在途禁翻页，刷新后的旧分页响应不得修改窗口或 hasMore", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 100 }, (_, i) => row(i + 1, `m${i + 1}`)));
  const page = gate();
  const tail = gate();
  let pageWaiting = false;
  let tailWaiting = false;
  let gateTail = false;
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    if (req.params.beforeId != null) { pageWaiting = true; return page.promise; }
    if (gateTail) { tailWaiting = true; return tail.promise; }
    return { entries: e.rows.slice(-50), hasMore: true };
  });
  await e.connect();
  await e.view();
  const oldPage = e.get().loadMoreHistory("room.history", "roomId", "r1");
  await until(() => pageWaiting);
  gateTail = true;
  const refresh = e.get().loadHistory("room.history", "roomId", "r1");
  await until(() => tailWaiting);
  try {
    assert.equal(e.get().historyLoading, true);
    e.rows.push(...Array.from({ length: 50 }, (_, i) => row(101 + i, `new${i}`)));
    tail.resolve({ entries: e.rows.slice(-50), hasMore: true });
    await refresh;
    page.resolve({ entries: e.rows.slice(0, 50), hasMore: false });
    await oldPage;
    assert.equal(e.get().historyHasMore, true, "旧分页不能把新 baseline 的 hasMore 清掉");
    assert.deepEqual(Array.from(e.get().chatItems.filter((it: Obj) => it.historyId != null), (it: Obj) => it.historyId),
      Array.from({ length: 50 }, (_, i) => 101 + i));
  } finally {
    tail.resolve({ entries: [], hasMore: false });
    page.resolve({ entries: [], hasMore: false });
    await Promise.allSettled([refresh, oldPage]);
  }
});

test("普通 baseline 加载期间不使用上次窗口的游标", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const tail = gate();
  let waiting = false;
  let pageCalls = 0;
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    if (req.params.beforeId != null) { pageCalls++; return { entries: [], hasMore: false }; }
    waiting = true;
    return tail.promise;
  });
  e.set({ historyHasMore: true });
  const refresh = e.get().loadHistory("room.history", "roomId", "r1");
  await until(() => waiting);
  try {
    assert.equal(e.get().historyLoading, true, "baseline 必须持有加载标记");
    await e.get().loadMoreHistory("room.history", "roomId", "r1");
    assert.equal(pageCalls, 0);
  } finally {
    tail.resolve({ entries: e.rows, hasMore: false });
    await refresh;
  }
  assert.equal(e.get().historyLoading, false);
});

test("重连恢复与手动 baseline 串行，旧恢复不能覆盖新窗口或破坏发送屏障", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const firstTail = gate();
  let tailCalls = 0;
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    tailCalls++;
    if (tailCalls === 1) return firstTail.promise;
    return { entries: [row(200, "new")], hasMore: true };
  });
  const recovery = e.get().reconnectRecovery();
  await until(() => tailCalls === 1);
  const refresh = e.get().loadHistory("room.history", "roomId", "r1");
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(tailCalls, 1, "手动 baseline 应等现有恢复屏障结束");
  } finally {
    firstTail.resolve({ entries: [row(100, "old")], hasMore: false });
    await Promise.allSettled([recovery, refresh]);
  }
  assert.equal(e.get().deliveryReady, true);
  assert.deepEqual(Array.from(e.get().chatItems.filter((it: Obj) => it.historyId != null), (it: Obj) => it.historyId), [200]);
  assert.equal(e.get().historyHasMore, true);
});

test("anchor 与 normal raw cursor 分离：anchor 翻页不污染 normal 窗口", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 999 }, (_, i) => row(i + 1, `m${i + 1}`)));
  const pageCalls: Obj[] = [];
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    const p = req.params as Obj;
    if (p.beforeId != null) {
      pageCalls.push({ ...p, anchor: p.anchorAt != null });
      const pool = e.rows.filter((r: Obj) => r.at < p.before || (r.at === p.before && r.id < p.beforeId));
      const page = pool.slice(-50);
      return { entries: page, hasMore: pool.length > page.length };
    }
    if (typeof p.anchorAt === "number") {
      const win = e.rows.filter((r: Obj) => r.at >= p.anchorAt - 24 && r.at <= p.anchorAt + 25);
      return { entries: win, hasMore: true };
    }
    return { entries: e.rows.slice(-50), hasMore: true };
  });
  await e.connect();
  await e.view();
  assert.equal(e.get().chatItems.filter((it: Obj) => it.historyId != null).at(-1)?.historyId, 999);
  await e.get().loadHistory("room.history", "roomId", "r1", 500);
  assert.equal(e.get().historySearchContext, true);
  const ids = () => Array.from(e.get().chatItems.filter((it: Obj) => it.historyId != null), (it: Obj) => it.historyId);
  assert.deepEqual(ids(), Array.from({ length: 50 }, (_, i) => 476 + i), "anchor 窗口不混入最近页");
  await e.get().reconnectRecovery();
  assert.equal(e.get().historySearchContext, true);
  assert.deepEqual(ids(), Array.from({ length: 50 }, (_, i) => 476 + i), "normal 后台恢复不替换 anchor 可见窗口");
  const cache = Object.values(e.get().historyCache as Obj).flat() as Obj[];
  assert.deepEqual(cache.map((it: Obj) => it.historyId), Array.from({ length: 50 }, (_, i) => 950 + i));
  const anchorMin = Math.min(...e.get().chatItems.filter((it: Obj) => it.historyId != null).map((it: Obj) => it.historyId as number));
  e.set({ historyHasMore: true });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0]!.beforeId, anchorMin, "anchor 翻页用 anchor 窗口游标而非 normal 950");
  assert.notEqual(pageCalls[0]!.beforeId, 950);
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.equal(e.get().historySearchContext, false);
  assert.deepEqual(ids(), Array.from({ length: 50 }, (_, i) => 950 + i), "回到最近窗口不保留旧 anchor 稳定项");
  pageCalls.length = 0;
  e.set({ historyHasMore: true });
  await e.get().loadMoreHistory("room.history", "roomId", "r1");
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0]!.beforeId, 950, "退出 anchor 后 normal 游标仍指向 950 窗口");
});

test("anchor 阅读期间实时卡仅更新最近缓存，不插入旧窗口", async (t) => {
  const e = await environment(t);
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 999 }, (_, i) => row(i + 1, `m${i + 1}`)));
  e.route((req) => {
    if (req.method !== "room.history" || req.params.entryIds != null) return e.base(req);
    return { entries: req.params.anchorAt != null
      ? e.rows.filter((r: Obj) => r.at >= 476 && r.at <= 525) : e.rows.slice(-50), hasMore: true };
  });
  await e.connect();
  await e.view();
  await e.get().loadHistory("room.history", "roomId", "r1", 500);
  const before = Array.from(e.get().chatItems, (it: Obj) => it.historyId);
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: { ...flow, flowId: "new-flow", startedAt: 1050 } } });
  const real = row(1001, JSON.stringify({ ...flow, flowId: "new-flow", startedAt: 1050 }), { kind: "flow", at: 1060 });
  e.rows.push(real);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: real } });
  assert.deepEqual(Array.from(e.get().chatItems, (it: Obj) => it.historyId), before);
  const cached = Object.values(e.get().historyCache as Obj).flat() as Obj[];
  assert.equal(cached.filter((it: Obj) => it.flowId === "new-flow").length, 1);
  assert.equal(cached.find((it: Obj) => it.flowId === "new-flow")?.historyId, 1001);
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.equal(e.get().chatItems.filter((it: Obj) => it.flowId === "new-flow").length, 1);
  assert.equal(e.get().chatItems.at(-1)?.historyId, 1001);
});

test("旧 normal baseline 晚于 anchor 返回不得切走正在阅读的窗口", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const normal = gate();
  let waiting = false;
  e.route((req) => {
    if (req.method !== "room.history") return e.base(req);
    if (req.params.anchorAt != null) return { entries: [row(50, "anchor")], hasMore: true };
    waiting = true;
    return normal.promise;
  });
  const old = e.get().loadHistory("room.history", "roomId", "r1");
  await until(() => waiting);
  await e.get().loadHistory("room.history", "roomId", "r1", 50);
  normal.resolve({ entries: [row(200, "tail")], hasMore: false });
  await old;
  assert.equal(e.get().historySearchContext, true);
  assert.equal(e.get().historyHasMore, true);
  assert.deepEqual(Array.from(e.get().chatItems, (it: Obj) => it.historyId), [50]);
});

test("已知 draft 被挤出 latest50：恢复仍保留并 entryIds 精确校准", async (t) => {
  const e = await environment(t);
  const draftRow = row(150, "partial", { kind: "assistant", at: 150, draft: 1 });
  const decisionRow = row(145, JSON.stringify({ decisionId: "old-pending", status: "pending" }), { kind: "decision", at: 145 });
  const processRow = row(146, JSON.stringify({ processId: "old-running", status: "running" }), { kind: "process", at: 146 });
  e.rows.splice(0, e.rows.length, decisionRow, processRow, draftRow,
    ...Array.from({ length: 10 }, (_, i) => row(200 + i, `n${i}`, { at: 200 + i })));
  const entryCalls: Obj[] = [];
  let finalized = false;
  e.route((req) => {
    if (req.method === "room.history" && req.params.entryIds != null) {
      entryCalls.push(req.params);
      return { entries: e.rows.filter((r: Obj) => req.params.entryIds.includes(r.id)).map((r: Obj) =>
        finalized && r.id === 150 ? { ...r, draft: 0, text: "final" } :
        finalized && r.id === 146 ? { ...r, text: JSON.stringify({ processId: "old-running", status: "done" }) } : r),
      hasMore: false };
    }
    if (req.method === "room.history") {
      const p = req.params as Obj;
      if (typeof p.before === "number") {
        const pool = e.rows.filter((r: Obj) => r.at < p.before || (r.at === p.before && r.id < p.beforeId));
        return { entries: pool.slice(-50), hasMore: pool.length > 50 };
      }
      return { entries: e.rows.slice(-50), hasMore: e.rows.length > 50 };
    }
    return e.base(req);
  });
  await e.connect();
  await e.view();
  assert.ok(e.get().chatItems.some((it: Obj) => it.historyId === 150), "draft150 首屏在窗口内并被登记");
  e.rows.push(...Array.from({ length: 55 }, (_, i) => row(300 + i, `x${i}`, { at: 300 + i })));
  e.rows.sort((a: Obj, b: Obj) => a.id - b.id);
  await e.get().reconnectRecovery();
  const windowIds = e.get().chatItems.filter((it: Obj) => it.historyId != null).map((it: Obj) => it.historyId as number);
  assert.ok(windowIds.filter((id: number) => id >= 300).length >= 50, "新行已进入最新窗口");
  assert.ok(e.get().chatItems.some((it: Obj) => it.historyId === 150), "恢复后 draft150 仍保留");
  assert.ok(e.get().chatItems.some((it: Obj) => it.historyId === 145 && it.meta.status === "pending"), "旧 pending decision 仍保留");
  assert.ok(e.get().chatItems.some((it: Obj) => it.historyId === 146), "旧 running process 仍保留");
  assert.ok(entryCalls.some((p) => (p.entryIds as number[]).includes(150)), "对 draft150 发了 entryIds 精确补取");
  assert.ok(entryCalls.some((p) => (p.entryIds as number[]).includes(146)), "对运行中过程卡发 entryIds 校准");
  finalized = true;
  await e.get().reconnectRecovery();
  const item = e.get().chatItems.find((it: Obj) => it.historyId === 150) as Obj | undefined;
  assert.equal(item?.text, "final", "entryIds 校准后 draft 转 final");
  assert.equal(e.get().chatItems.find((it: Obj) => it.historyId === 146)?.status, "done", "过程卡不能永久停在 running");
});

test("纯实时完成的120条回复也受缓存窗口约束，重进不复活旧本地项", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const complete = (text: string) => {
    e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s1", stoppable: true } });
    e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    e.sockets[0]!.emit({ method: "prompt.done", params: { sessionId: "s1", output: text } });
  };
  for (let i = 0; i < 120; i++) complete(`live-${i}`);
  assert.equal(e.get().chatItems.filter((it: Obj) => it.kind === "assistant" && it.historyId == null).length, 120);
  const at = Date.now();
  e.rows.splice(0, e.rows.length, ...Array.from({ length: 50 }, (_, i) =>
    row(1000 + i, `system-${i}`, { kind: "system", author: "Hub", at })));
  const tail = gate();
  let waiting = false;
  let hold = true;
  e.route((req) => {
    if (req.method === "room.list") return {
      rooms: [{ ...room, members: [{ sessionId: "s1", name: "Worker" }] }],
    };
    if (req.method !== "room.history" || req.params.entryIds != null) return e.base(req);
    if (hold) { waiting = true; return tail.promise; }
    return { entries: e.rows.slice(-50), hasMore: e.rows.length > 50 };
  });
  await e.get().refreshAll();
  await e.get().openRoom(room);
  await until(() => waiting);
  try {
    const cached = Object.values(e.get().historyCache as Obj).flat();
    assert.equal(cached.length, 50, "未挂 historyId 的已完成本地消息不能绕过缓存上限");
    assert.equal(e.get().chatItems.length, 50, "先显示的缓存窗口也有界");
    complete("new-during-tail");
  } finally {
    tail.resolve({ entries: [...e.rows], hasMore: true });
    await until(() => !e.get().historyLoading);
  }
  assert.deepEqual(Array.from(e.get().chatItems.filter((it: Obj) => it.kind === "assistant"), (it: Obj) => it.text),
    ["new-during-tail"], "只保留 RPC 期间新到的回复，不保留旧完成项");
  assert.equal(e.get().chatItems.length, 51);
  hold = false;
  e.rows.push(row(2000, "new-during-tail", { at: at + 1 }));
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.equal(e.get().chatItems.length, 50);
  assert.equal(e.get().chatItems.at(-1)?.historyId, 2000);
});

for (const author of ["Worker", "Worker (Codex)"]) {
  test(`历史 draft 与实时 chunk 同一气泡且迟到快照不回退：${author}`, async (t) => {
    const e = await environment(t);
    const at = Date.now() + 600_000;
    const draft = row(150, "partial", { author, at, draft: 1 });
    e.rows.splice(0, e.rows.length, draft);
    await e.connect();
    await e.view();
    let snapshot = gate();
    const final = gate();
    let requests = 0;
    let completing = false;
    let calibrating = false;
    e.route((req) => {
      if (req.method !== "room.history") return e.base(req);
      if (req.params.entryIds != null) {
        if (completing) { calibrating = true; return final.promise; }
        return { entries: [draft], hasMore: false };
      }
      requests++;
      return snapshot.promise;
    });
    const bubbles = (): Obj[] => Array.from(e.get().chatItems as Obj[]).filter((it) => it.kind === "assistant");
    const first = e.get().loadHistory("room.history", "roomId", "r1");
    try {
      await until(() => requests === 1);
      e.sockets[0]!.emit({ method: "session.generating", params: { sessionId: "s1", stoppable: true } });
      e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "more" } });
      await until(() => bubbles().some((it) => it.text.endsWith("more")));
      snapshot.resolve({ entries: [draft], hasMore: false });
      await first;
      assert.equal(bubbles().length, 1);
      assert.equal(bubbles()[0]?.text, "partialmore", "旧 draft 和精确校准都不能吃掉新 chunk");
      assert.equal(bubbles()[0]?.historyId, 150);
      assert.equal(bubbles()[0]?.at, at, "带 historyId 的实时 draft 沿用服务端时钟");
    } finally {
      snapshot.resolve({ entries: [draft], hasMore: false });
      await first;
    }
    snapshot = gate();
    completing = true;
    const second = e.get().loadHistory("room.history", "roomId", "r1");
    try {
      await until(() => requests === 2);
      e.sockets[0]!.emit({ method: "prompt.done", params: { sessionId: "s1", output: "partialmore" } });
      snapshot.resolve({ entries: [draft], hasMore: false });
      await until(() => calibrating);
      assert.equal(bubbles().length, 1);
      assert.equal(bubbles()[0]?.text, "partialmore");
      assert.ok(!bubbles()[0]?.streaming, "迟到 draft1 不能让已结束气泡重新 streaming");
    } finally {
      snapshot.resolve({ entries: [draft], hasMore: false });
      final.resolve({ entries: [{ ...draft, draft: 0, text: "canonical", at: at + 1000 }], hasMore: false });
      await second;
    }
    assert.equal(bubbles().length, 1);
    assert.equal(bubbles()[0]?.text, "canonical", "非前缀的最终正文仍以服务器为准");
    assert.ok(!bubbles()[0]?.streaming);
  });
}

test("F: 无关 flowUpdate 不丢新历史卡且 knownCardIds 仍补校准", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const cardA = row(300, JSON.stringify({ ...flow, flowId: "fA", phase: "working" }), { kind: "flow" });
  const syncParams: Obj[] = [];
  const historyGate = gate();
  let requested = false;
  let serverFlow = flow;
  e.route((req) => {
    if (req.method === "room.history" && req.params.afterId == null && req.params.beforeId == null) {
      requested = true;
      return historyGate.promise;
    }
    if (req.method === "room.sync") {
      syncParams.push(req.params);
      const ids = (req.params?.knownCardIds as number[] | undefined) ?? [];
      if (ids.includes(300)) {
        const raw = e.get().chatItems.find((c: Obj) => c.historyId === 300);
        assert.equal(raw?.snapshot?.phase, "working", "无关更新不丢新历史卡：raw working 先行展示");
      }
      return { mode: room.mode, flow: serverFlow, blackboard: [], cards: ids.includes(300) ? [{ ...cardA, text: JSON.stringify({ ...flow, flowId: "fA", phase: "done" }) }] : [] };
    }
    return e.base(req);
  });
  const rec = e.get().reconnectRecovery();
  await until(() => requested);
  serverFlow = { ...flow, phase: "planning" };
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: serverFlow } });
  historyGate.resolve({ entries: [cardA], hasMore: false });
  await rec;
  assert.ok(syncParams.some((p) => (p.knownCardIds as number[] | undefined)?.includes(300)));
  assert.equal(e.get().chatItems.find((it: Obj) => it.historyId === 300)?.snapshot?.phase, "done");
});

test("G: anchor 响应不污染完整 scope 缓存", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.route((req) => {
    if (req.method === "room.history" && req.params.anchorAt != null) {
      return { entries: [row(50, "anchor-old", { kind: "assistant" })], hasMore: false };
    }
    return e.base(req);
  });
  const before = JSON.stringify((e.get().historyCache as Obj)?.["room:r1"] ?? []);
  await e.get().loadHistory("room.history", "roomId", "r1", 50);
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 50), "anchor 行在 UI 可见");
  const after = JSON.stringify((e.get().historyCache as Obj)?.["room:r1"] ?? []);
  assert.equal(after, before, "完整 cache JSON 完全不变");
  await e.get().loadHistory("room.history", "roomId", "r1");
  assert.ok(((e.get().historyCache as Obj)["room:r1"] as Obj[]).some((c: Obj) => c.historyId === 100 || c.id === 100));
});

test("H: 已 fulfilled 的旧 epoch RPC 迟到 continuation 不写新状态", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const oldGate = gate();
  const newGate = gate();
  let requestedNew = false;
  let staleReq: Obj | null = null;
  e.route((req) => {
    if (req.method === "session.list") {
      staleReq = req;
      return oldGate.promise;
    }
    return e.base(req);
  });
  const stalePromise = e.get().refreshAll().catch(() => {});
  await until(() => staleReq !== null);
  e.sockets[0]!.emit({ id: staleReq!.id, result: { sessions: [{ sessionId: "stale", name: "stale" }] } });
  e.route((req) => {
    if (req.method === "session.list") { requestedNew = true; return newGate.promise; }
    if (req.method === "agent.info") return { deliveryProtocol: 1, hubId: "hub-2", maxReplayAgeMs: 86400000, agents: [] };
    return e.base(req);
  });
  const connectingNew = e.connect("localhost2", "test2");
  await until(() => requestedNew);
  await stalePromise;
  const names = (e.get().sessions as Obj[]).map((x) => x.sessionId);
  assert.ok(!names.includes("stale"), "旧 fulfilled 响应的 continuation 不得写新状态");
  newGate.resolve({ sessions: [session] });
  await connectingNew;
  assert.equal(e.get().deliveryReady, true);
  assert.equal(e.get().deliveryHubId, "hub-2");
  oldGate.resolve({ sessions: [{ sessionId: "stale", name: "stale" }] });
});

test("I: parked 默认 dismiss 不删；includeParked 仅本地删除零 RPC", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ deliveryReady: false });
  (e1.get().client as Obj).isConnected = false;
  assert.equal(e1.get().sendRoomMessage("parked", undefined), true);
  const cid = (e1.get().chatItems.find((c: Obj) => c.kind === "user") as Obj).clientMessageId;
  e1.get().disconnect();
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => req.method === "agent.info" ? { deliveryProtocol: 1, hubId: "hub-2", maxReplayAgeMs: 86400000, agents: [] } : e2.base(req));
  await e2.connect();
  const entries = e2.get().outboxEntries as Obj[];
  const parked = entries.find((o) => o.clientMessageId === cid);
  assert.ok(parked && parked.current === false, "旧 origin 标 !current");
  e2.get().dismissOutgoing(cid);
  assert.ok((e2.get().outboxEntries as Obj[]).some((o) => o.clientMessageId === cid), "默认 dismiss 不删 parked");
  e2.get().dismissOutgoing(cid, true);
  assert.ok(!(e2.get().outboxEntries as Obj[]).some((o) => o.clientMessageId === cid), "includeParked 删除");
  assert.equal(e2.calls.filter((r) => r.method === "room.message").length, 0, "零远端调用");
});

test("缺 maxReplayAgeMs 的合法 hubId 也停 protocol0", async (t) => {
  const e = await environment(t);
  e.route((req) => req.method === "agent.info" ? { deliveryProtocol: 1, hubId: "hub-1", agents: [] } : e.base(req));
  await e.connect();
  assert.equal(e.get().deliveryProtocol, 0);
});

test("summary >300 全文复制 + labels 序列化往返", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ deliveryReady: false, currentProfile: { name: "QA profile", address: "localhost", token: "test" }, currentRoom: { ...room, name: "QA room" } });
  (e1.get().client as Obj).isConnected = false;
  const longText = "x".repeat(500);
  assert.equal(e1.get().sendRoomMessage(longText, undefined), true);
  const summary = (e1.get().outboxEntries as Obj[])[0];
  assert.ok(summary);
  assert.equal(summary.text.length, 500, "summary 全文不截断");
  assert.equal(summary.profileLabel, "QA profile");
  assert.equal(summary.scopeLabel, "QA room");
  e1.get().disconnect();
  {
    const raw = JSON.parse(map.get("agent-hub.outbox.v1")!);
    assert.equal(raw.entries[0].profileLabel, "QA profile");
    assert.equal(raw.entries[0].scopeLabel, "QA room");
    raw.entries[0].attempted = true;
    raw.entries[0].status = "uncertain";
    map.set("agent-hub.outbox.v1", JSON.stringify(raw));
  }
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => req.method === "client.message.status" ? { deliveryStatus: "uncertain" } : e2.base(req));
  await e2.connect();
  const ent = (e2.get().outboxEntries as Obj[])[0];
  assert.equal(ent?.text.length, 500, "恢复后全文保留");
  assert.equal(ent.profileLabel, "QA profile");
  assert.equal(ent.scopeLabel, "QA room");
});

test("非 string label 判 corrupt 保原键", async (t) => {
  const bad = { version: 1, entries: [{ clientMessageId: "c1", method: "room.message", scopeKey: "room:r1", params: { roomId: "r1", clientMessageId: "c1", content: [{ type: "text", text: "x" }] }, status: "pending", queuedAt: 1, origin: "a".repeat(64), hubId: null, replayable: true, attempted: false, profileLabel: 7, bubble: { kind: "user", text: "x", author: "我", clientMessageId: "c1" } }] };
  const map = new Map<string, string>([["agent-hub.outbox.v1", JSON.stringify(bad)]]);
  const e = await environment(t, "store.ts", map);
  assert.equal(e.get().outboxError, "corrupt");
  assert.equal(map.get("agent-hub.outbox.v1"), JSON.stringify(bad));
});

test("B2: 附件 tombstone 恢复气泡含文件名且无 base64", async (t) => {
  const map = new Map<string, string>();
  const e1 = await environment(t, "store.ts", map);
  await e1.connect();
  await e1.view();
  e1.set({ pendingAttachments: [{ name: "pic.png", mimeType: "image/png", base64: "QUJD", size: 3 }] });
  assert.equal(e1.get().sendRoomMessage("img", undefined), true);
  const cid = e1.get().chatItems.find((c: Obj) => c.kind === "user").clientMessageId;
  e1.get().disconnect();
  const e2 = await environment(t, "store.ts", map);
  e2.route((req) => req.method === "client.message.status" ? { deliveryStatus: "uncertain" } : e2.base(req));
  await e2.connect();
  await e2.view();
  await e2.get().loadHistory("room.history", "roomId", "r1");
  const ent = (e2.get().outboxEntries as Obj[])[0];
  assert.ok(Array.isArray(ent?.attachmentNames) && (ent.attachmentNames as string[]).includes("pic.png"));
  const bubbles = e2.get().chatItems.filter((c: Obj) => c.kind === "user" && c.clientMessageId === cid);
  assert.equal(bubbles.length, 1);
  assert.ok(bubbles[0].attachmentNames.includes("pic.png"));
  assert.ok(!(map.get("agent-hub.outbox.v1") ?? "").includes("QUJD"), "磁盘无 base64");
});

test("same-flow routing transition fails locally before outgoing RPC", async (t) => {
  for (const change of [
    { flow: { ...flow, mode: "parallel", phase: "summarizing" } },
    { flow: { ...flow, phase: "awaiting-retry" } },
    { subMode: "deciding" },
    { mode: "parallel" },
  ]) {
    const e = await environment(t);
    await e.connect();
    await e.view();
    e.route((req) => req.method === "room.sync" ? { ...e.base(req), ...change } : e.base(req));
    assert.equal(e.get().sendRoomMessage("old supplement"), true);
    await until(() => e.get().chatItems.some((item: Obj) => item.kind === "user" && item.sendStatus === "failed"));
    assert.equal(e.calls.filter((req) => req.method === "room.message").length, 0);
    assert.ok(e.get().chatItems.some((item: Obj) => item.kind === "user" && item.sendError === "context"));
  }
});

test("intentional parallel summarizing new goal captures restart instead of active", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const observed = { ...flow, mode: "parallel", phase: "summarizing" };
  const currentRoom = { ...room, mode: "auto" };
  e.set({ currentRoom, rooms: [currentRoom] });
  e.sockets.at(-1)!.emit({ method: "room.flowUpdate", params: { roomId: room.roomId, flow: observed } });
  await until(() => e.get().flow?.phase === "summarizing");
  e.route((req) => req.method === "room.sync" ? { ...e.base(req), flow: observed, mode: "auto" } : e.base(req));
  assert.equal(e.get().sendRoomMessage("next goal"), true);
  await until(() => e.calls.some((req) => req.method === "room.message"));
  const sent = e.calls.find((req) => req.method === "room.message")!;
  assert.equal(sent.params.expectedFlowState, "restart");
  assert.equal(sent.params.expectedRoomMode, "auto");
});

test("legacy never-attempted record without intent guard is preserved for confirmation", async (t) => {
  const map = new Map<string, string>();
  const e = await environment(t, "store.ts", map);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  assert.equal(e.get().sendRoomMessage("legacy draft"), true);
  e.get().disconnect();
  const raw = JSON.parse(map.get("agent-hub.outbox.v1")!);
  delete raw.entries[0].params.expectedFlowState;
  delete raw.entries[0].params.expectedRoomMode;
  map.set("agent-hub.outbox.v1", JSON.stringify(raw));
  const restored = await environment(t, "store.ts", map);
  await restored.connect();
  await until(() => restored.get().outboxEntries.some((item: Obj) => item.status === "failed"));
  assert.equal(restored.calls.filter((req) => req.method === "room.message").length, 0);
  const saved = JSON.parse(map.get("agent-hub.outbox.v1")!).entries[0];
  assert.equal(saved.bubble.text, "legacy draft");
  assert.equal(saved.sendError, "context");
  assert.equal("expectedFlowState" in saved.params, false);
});

test("deferred room send requires Hub support for routing guard snapshot", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  e.set({ deliveryReady: false });
  assert.equal(e.get().sendRoomMessage("keep until supported"), true);
  const cid = e.get().chatItems.find((item: Obj) => item.kind === "user").clientMessageId;
  e.route((req) => req.method === "room.sync" ? { flow, blackboard: [], cards: [] } : e.base(req));
  e.set({ deliveryReady: true });
  e.get().checkOutgoing(cid);
  await until(() => e.get().outboxError === "unsupported");
  assert.equal(e.calls.filter((req) => req.method === "room.message").length, 0);
  assert.equal(e.get().outboxEntries[0].text, "keep until supported");
});

test("unbound answer prefixes are live controls, never offline replay", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  (e.get().client as Obj).isConnected = false;
  e.set({ deliveryReady: false });
  for (const text of ["答：yes", "answer: yes", "reply: yes", "/reply yes"]) {
    assert.equal(e.exports.isLiveRoomControl(text), true);
    assert.equal(e.exports.isLiveRoomControl(text, "h1"), false);
    assert.equal(e.get().sendRoomMessage(text), false);
  }
  assert.equal(e.get().outboxEntries.length, 0);
  assert.equal(e.calls.filter((req) => req.method === "room.message").length, 0);
});

test("A: tail RPC 期间 process done 不被旧行回退，terminal 卡不丢", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.rows.splice(0, e.rows.length,
    row(100, "question", { kind: "user", at: 100 }),
    row(101, JSON.stringify({ ...flow, flowId: "f-101", phase: "done" }), { kind: "flow", at: 101 }),
    row(102, JSON.stringify({ decisionId: "d-102", status: "pending" }), { kind: "decision", at: 102 }),
    row(103, JSON.stringify({ processId: "proc-103", sessionId: "s1", turnStartAt: 90, turnEndAt: 0, steps: [], status: "running" }), { kind: "process", at: 103 }),
    row(104, "answer", { at: 104 }));
  await e.view();
  const tailGate = gate();
  let tailSeen = false;
  let followup: { gate: ReturnType<typeof gate>; kind: string } | null = null;
  let recSettled = false;
  e.route((req) => {
    if (req.method === "room.history" && req.params.entryIds == null && req.params.beforeId == null && req.params.anchorAt == null && !tailSeen) {
      tailSeen = true;
      return tailGate.promise;
    }
    if (tailSeen && (req.params?.entryIds != null || req.method === "room.sync")) {
      if (!followup) followup = { gate: gate(), kind: req.method === "room.sync" ? "sync" : "entryIds" };
      return followup.gate.promise;
    }
    return e.base(req);
  });
  const rec = e.get().loadHistory("room.history", "roomId", "r1");
  rec.then(() => { recSettled = true; });
  await until(() => tailSeen);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry:
    row(103, JSON.stringify({ processId: "proc-103", sessionId: "s1", turnStartAt: 90, turnEndAt: 105, steps: [], status: "done" }), { kind: "process", at: 105 }) } });
  tailGate.resolve({ entries: e.rows.slice(), hasMore: false });
  await until(() => followup !== null || recSettled);
  const items = e.get().chatItems;
  assert.equal(items.find((c: Obj) => c.processId === "proc-103")?.status, "done", "RPC 期间 live done 不被旧 tail 行回退");
  assert.ok(items.some((c: Obj) => c.historyId === 101), "terminal flow101 保留");
  assert.ok(items.some((c: Obj) => c.historyId === 102), "decision102 保留");
  const order = items.filter((c: Obj) => [100, 101, 102, 104].includes(c.historyId)).map((c: Obj) => c.historyId);
  assert.equal(order.join(","), "100,101,102,104", "未变项相对顺序稳定");
  assert.ok(items.some((c: Obj) => c.processId === "proc-103" && c.status === "done"), "process103 done 存在");
  const pendingFollowup = followup as { gate: ReturnType<typeof gate>; kind: string } | null;
  if (pendingFollowup) pendingFollowup.gate.resolve(pendingFollowup.kind === "sync"
    ? { mode: room.mode, flow, blackboard: [], cards: [] }
    : { entries: e.rows.slice(), hasMore: false });
  await rec;
  assert.equal(e.get().chatItems.find((c: Obj) => c.processId === "proc-103")?.status, "done");
});

test("B: targeted entryIds 校准期间 process done 不回退", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.rows.splice(0, e.rows.length,
    row(103, JSON.stringify({ processId: "proc-103", sessionId: "s1", turnStartAt: 90, turnEndAt: 0, steps: [], status: "running" }), { kind: "process", at: 103 }));
  await e.view();
  const entryGate = gate();
  let entrySeen = false;
  let followup: { gate: ReturnType<typeof gate>; kind: string } | null = null;
  let recSettled = false;
  e.route((req) => {
    if (req.method === "room.history" && req.params.entryIds != null && !entrySeen) {
      entrySeen = true;
      return entryGate.promise;
    }
    if (entrySeen && (req.params?.entryIds != null || req.method === "room.sync")) {
      if (!followup) followup = { gate: gate(), kind: req.method === "room.sync" ? "sync" : "entryIds" };
      return followup.gate.promise;
    }
    return e.base(req);
  });
  const rec = e.get().loadHistory("room.history", "roomId", "r1");
  rec.then(() => { recSettled = true; });
  await until(() => entrySeen);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry:
    row(103, JSON.stringify({ processId: "proc-103", sessionId: "s1", turnStartAt: 90, turnEndAt: 105, steps: [], status: "done" }), { kind: "process", at: 105 }) } });
  entryGate.resolve({ entries: [e.rows.find((r) => r.id === 103)], hasMore: false });
  await until(() => followup !== null || recSettled);
  assert.equal(e.get().chatItems.find((c: Obj) => c.processId === "proc-103")?.status, "done", "entryIds 校准不回退 live done");
  const pendingFollowup = followup as { gate: ReturnType<typeof gate>; kind: string } | null;
  if (pendingFollowup) pendingFollowup.gate.resolve(pendingFollowup.kind === "sync"
    ? { mode: room.mode, flow, blackboard: [], cards: [] }
    : { entries: e.rows.slice(), hasMore: false });
  await rec;
  assert.equal(e.get().chatItems.find((c: Obj) => c.processId === "proc-103")?.status, "done");
});

test("C: initial anchor RPC 期间 process done 保护，anchor 页不混 normal", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.rows.splice(0, e.rows.length,
    row(50, JSON.stringify({ processId: "proc-50", sessionId: "s1", turnStartAt: 40, turnEndAt: 0, steps: [], status: "running" }), { kind: "process", at: 90 }),
    row(51, JSON.stringify({ ...flow, flowId: "f-51", phase: "done" }), { kind: "flow", at: 96 }),
    row(100, "normal-q", { kind: "user", at: 100 }),
    row(104, "normal-a", { kind: "assistant", at: 104 }));
  await e.view();
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 100), "view 确有 normal user100");
  const anchorGate = gate();
  const syncGate = gate();
  let anchorCalls = 0;
  let syncCalls = 0;
  e.route((req) => {
    if (req.method === "room.history" && req.params.anchorAt != null) {
      anchorCalls++;
      if (anchorCalls === 1) return anchorGate.promise;
      return e.base(req);
    }
    if (req.method === "room.sync") {
      syncCalls++;
      if (syncCalls >= 1) return syncGate.promise;
      return e.base(req);
    }
    return e.base(req);
  });
  const rec = e.get().loadHistory("room.history", "roomId", "r1", 200);
  await until(() => anchorCalls === 1);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry:
    row(50, JSON.stringify({ processId: "proc-50", sessionId: "s1", turnStartAt: 40, turnEndAt: 105, steps: [], status: "done" }), { kind: "process", at: 105 }) } });
  anchorGate.resolve({ entries: [e.rows.find((r) => r.id === 50), e.rows.find((r) => r.id === 51),
    row(49, JSON.stringify({ ...flow, flowId: "f-49-anchor-only", phase: "done" }), { kind: "flow", at: 49 })], hasMore: false });
  await until(() => syncCalls >= 1);
  const items = e.get().chatItems;
  assert.equal(items.find((c: Obj) => c.processId === "proc-50")?.status, "done", "anchor 页 process 保持 done");
  assert.ok(items.some((c: Obj) => c.historyId === 51), "anchor 页 terminal flow51 存在");
  assert.ok(items.some((c: Obj) => c.historyId === 49), "anchor 独有 flow49 在窗口");
  assert.ok(!items.some((c: Obj) => c.historyId === 100), "anchor 窗口不混 normal user100");
  assert.ok(!items.some((c: Obj) => c.historyId === 104), "anchor 窗口不混 normal assistant104");
  syncGate.resolve({ mode: room.mode, flow, blackboard: [], cards: [] });
  await rec;
  const cache = (e.get().historyCache as Obj)?.["room:r1"] as Obj[] | undefined;
  assert.ok(cache?.some((c: Obj) => c.processId === "proc-50"), "normal cache 保留 p-50");
  assert.ok(cache?.some((c: Obj) => c.historyId === 100), "normal cache 保留 user100");
  assert.ok(cache?.some((c: Obj) => c.historyId === 104), "normal cache 保留 assistant104");
  assert.ok(!cache?.some((c: Obj) => c.historyId === 49), "anchor 独有 f-49 不污染 normal cache");
});
