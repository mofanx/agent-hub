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

test("live persistent id 150 cannot replace complete cursor 100", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const card = row(150, JSON.stringify(flow), { kind: "flow" });
  e.rows.push(card);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: card } });
  e.calls.length = 0;
  await e.get().reconnectRecovery();
  assert.equal(e.calls.find((r) => r.method === "room.history" && r.params.afterId != null)?.params.afterId, 100);
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

test("并行成员的 chunk 与工具事件按接收顺序落入时间线", async (t) => {
  const e = await environment(t);
  await e.connect();
  e.set({ currentRoom: { ...room, members: [["s1", "Worker"], ["s2", "Other"]] }, currentSession: null, chatItems: [] });
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
  const chunk = (text: string) =>
    e.get().applyUpdate("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  chunk("first");
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

test("unknown raw history rows advance pagination beyond twenty pages", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const cursors: number[] = [];
  e.route((req) => {
    if (req.method === "room.history" && req.params.afterId != null) {
      cursors.push(req.params.afterId);
      return { entries: [row(req.params.afterId + 1, "", { kind: "future-kind" })], hasMore: cursors.length < 22 };
    }
    return e.base(req);
  });
  await e.get().reconnectRecovery();
  assert.equal(cursors.length, 22);
  assert.equal(cursors[21], 121);
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

test("E: truncated 恢复 after0 全页收齐、live 新 flow 卡不推进水位", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const liveCard = row(900, JSON.stringify({ ...flow, flowId: "f-live", phase: "working" }), { kind: "flow" });
  const historyCalls: Obj[] = [];
  const lastPage = gate();
  let waitingLastPage = false;
  let serverFlow = flow;
  e.route((req) => {
    if (req.method === "room.sync") return { ...e.base(req), flow: serverFlow };
    if (req.method === "room.history") {
      historyCalls.push(req.params);
      const after = req.params?.afterId;
      if (after === 0) {
        return { entries: Array.from({ length: 500 }, (_, k) => ({ id: 201 + k, at: 201 + k, kind: "assistant", author: "w", text: `r${201 + k}` })), hasMore: true };
      }
      if (after === 700) { waitingLastPage = true; return lastPage.promise; }
      if (after === 100) return { entries: [], hasMore: false, truncated: true };
      if (after === 701) return { entries: [liveCard], hasMore: false };
      return { entries: [], hasMore: false };
    }
    return e.base(req);
  });
  const recovery = e.get().reconnectRecovery();
  await until(() => waitingLastPage);
  serverFlow = { ...flow, flowId: "f-live" };
  e.rows.push(liveCard);
  e.sockets[0]!.emit({ method: "room.process", params: { roomId: "r1", entry: liveCard } });
  e.sockets[0]!.emit({ method: "room.flowUpdate", params: { roomId: "r1", flow: serverFlow } });
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 900), "RPC 在途时确实收到 live 卡");
  lastPage.resolve({ entries: [row(701)], hasMore: false });
  await recovery;
  assert.ok(historyCalls.some((p) => p.afterId === 0));
  assert.ok(historyCalls.some((p) => p.afterId === 700));
  assert.ok(e.get().chatItems.some((c: Obj) => c.historyId === 900), "live 卡仍保留");
  assert.ok(!e.get().chatItems.some((c: Obj) => c.historyId === 100), "已清理的旧历史不冒充完整快照");
  historyCalls.length = 0;
  await e.get().reconnectRecovery();
  assert.ok(historyCalls.some((p) => p.afterId === 701), "水位 raw701 不跳 live900");
});

test("F: revision 过滤的新卡经 knownCardIds 补校准", async (t) => {
  const e = await environment(t);
  await e.connect();
  await e.view();
  const cardA = row(300, JSON.stringify({ ...flow, flowId: "fA", phase: "working" }), { kind: "flow" });
  const syncParams: Obj[] = [];
  const historyGate = gate();
  let requested = false;
  let serverFlow = flow;
  e.route((req) => {
    if (req.method === "room.history" && req.params.afterId === 100) {
      requested = true;
      return historyGate.promise;
    }
    if (req.method === "room.sync") {
      syncParams.push(req.params);
      const ids = (req.params?.knownCardIds as number[] | undefined) ?? [];
      if (ids.includes(300)) {
        assert.equal(e.get().chatItems.some((c: Obj) => c.historyId === 300), false, "校准前300确被过滤");
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
