import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpAgent,
  permissionKeyOf,
  permissionTitleOf,
  setPermissionBypass,
  type HubEvent,
} from "./agent.js";
import {
  DecisionCenter,
  inferOptionScope,
  isRejectOption,
  permissionContext,
  sweepPendingDecisions,
  type DecisionMeta,
} from "./decision.js";
import { Store } from "./store.js";
import { makeFlowCardSync, sweepOrphanFlowCards } from "./flow-card.js";

function tmpStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-dec-")));
}

function memPipe() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      try {
        ctrl.enqueue(chunk);
      } catch {}
    },
    close() {
      try {
        ctrl.close();
      } catch {}
    },
  });
  return { readable, writable };
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

function agentSetup() {
  const c2a = memPipe();
  const a2c = memPipe();
  const clientStream = acp.ndJsonStream(c2a.writable, a2c.readable);
  const agentStream = acp.ndJsonStream(a2c.writable, c2a.readable);
  let seq = 0;
  const agentConn = acp
    .agent()
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `s${++seq}` }))
    .onRequest(acp.methods.agent.session.prompt, () => new Promise<acp.PromptResponse>(() => {}))
    .connect(agentStream);
  const events: HubEvent[] = [];
  const hub = new AcpAgent("test", clientStream, (e) => events.push(e));
  return { agentConn, hub, events };
}

const TOOL_CALL = {
  toolCallId: "tc1",
  title: "Run command",
  kind: "execute",
  rawInput: { command: "rm -rf /tmp/x" },
};
const OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Reject", kind: "reject_once" },
];

describe("decision context 白名单截断", () => {
  it("只保留白名单字段且 ≤300 字符", () => {
    const ctx = permissionContext({
      title: "t".repeat(400),
      kind: "execute",
      name: "bash",
      locations: [{ path: "/a/b.ts" }],
      rawInput: { command: "c".repeat(500), args: ["x", "y"], evil: "dropped" },
      rawOutput: "should not appear",
    });
    assert.equal((ctx.title as string).length, 300);
    assert.equal(ctx.kind, "execute");
    assert.equal((ctx.command as string).length, 300);
    assert.equal(ctx.args, "x y");
    assert.deepEqual(ctx.paths, ["/a/b.ts"]);
    assert.equal(ctx.evil, undefined);
    assert.equal(ctx.rawOutput, undefined);
  });

  it("标注敏感的 toolCall / rawInput 不落明文", () => {
    assert.deepEqual(
      permissionContext({ title: "x", _meta: { sensitive: true }, rawInput: { command: "rm" } }),
      { redacted: true },
    );
    const ctx = permissionContext({ title: "x", rawInput: { command: "rm", sensitive: true } });
    assert.equal(ctx.rawInput, "[redacted]");
    assert.equal(ctx.command, undefined);
  });
});

describe("decision scope 推断", () => {
  it("always 选项 → always，其余 → once", () => {
    assert.equal(inferOptionScope({ kind: "allow_always", label: "Allow always" }), "always");
    assert.equal(inferOptionScope({ kind: "allow_once", label: "Allow" }), "once");
    assert.equal(inferOptionScope(undefined), "once");
  });
  it("reject/deny 选项识别", () => {
    assert.equal(isRejectOption({ kind: "reject_once" }), true);
    assert.equal(isRejectOption({ label: "Deny" }), true);
    assert.equal(isRejectOption({ kind: "allow_always" }), false);
  });
});

describe("DecisionCenter 决策卡生命周期", () => {
  const open = (dc: DecisionCenter) =>
    dc.open(
      {
        requestId: "req-1",
        sessionId: "s1",
        type: "permission",
        title: "Run command",
        options: OPTIONS.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
        toolCall: TOOL_CALL,
        grantKey: "execute:Run command",
      },
      { scope: "room", scopeId: "r1", requestedBy: "coder" },
    );

  it("open → kind:decision 条目 pending；resolve → answered+scope；revoke → revoked；审计齐全", () => {
    const store = tmpStore();
    const broadcasts: { method: string; params: Record<string, unknown> }[] = [];
    const audits: { scope: string; scopeId: string; summary: string }[] = [];
    const dc = new DecisionCenter({
      store,
      broadcast: (m, p) => broadcasts.push({ method: m, params: p }),
      audit: (scope, scopeId, ev) => audits.push({ scope, scopeId, summary: ev.summary }),
    });
    const meta = open(dc)!;
    assert.equal(meta.status, "pending");
    assert.equal(meta.scope, "once");
    const entries = store.read("room", "r1");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, "decision");
    const stored = JSON.parse(entries[0]!.text) as DecisionMeta;
    assert.equal(stored.decisionId, meta.decisionId);
    assert.equal(stored.status, "pending");
    assert.equal(stored.context?.command, "rm -rf /tmp/x");
    // 广播：decision.update + room.process 信封
    assert.ok(broadcasts.some((b) => b.method === "decision.update"));
    assert.ok(
      broadcasts.some(
        (b) => b.method === "room.process" && (b.params.entry as { kind: string }).kind === "decision",
      ),
    );
    assert.ok(audits.some((a) => a.summary.includes("发起决策")));

    dc.resolveByRequest("req-1", "answered", { optionId: "always", scope: "always" });
    const after = JSON.parse(store.read("room", "r1")[0]!.text) as DecisionMeta;
    assert.equal(after.status, "answered");
    assert.equal(after.scope, "always");
    assert.equal(after.answer?.label, "Allow always");
    assert.ok(audits.some((a) => a.summary.includes("批准") && a.summary.includes("always")));

    dc.revoke(meta.decisionId);
    const revoked = JSON.parse(store.read("room", "r1")[0]!.text) as DecisionMeta;
    assert.equal(revoked.status, "revoked");
    assert.ok(audits.some((a) => a.summary.includes("撤销")));
  });

  it("session 作用域只发 decision.update；auto 开卡即 answered", () => {
    const store = tmpStore();
    const broadcasts: string[] = [];
    const dc = new DecisionCenter({
      store,
      broadcast: (m) => broadcasts.push(m),
    });
    const meta = dc.open(
      {
        requestId: "req-a",
        sessionId: "s9",
        type: "permission",
        title: "t",
        options: [],
        auto: true,
        autoOptionId: "allow",
        grantScope: "always",
      },
      { scope: "session", scopeId: "s9", requestedBy: "bot" },
    )!;
    assert.equal(meta.status, "answered");
    assert.equal(meta.scope, "always");
    assert.equal(meta.auto, true);
    assert.equal(store.read("session", "s9")[0]!.kind, "decision");
    assert.ok(broadcasts.includes("decision.update"));
    assert.ok(!broadcasts.includes("room.process"), "session 作用域不发 room.process");
  });

  it("sweepPendingDecisions 把重启前 pending 卡定稿为 expired", () => {
    const store = tmpStore();
    const dc = new DecisionCenter({ store, broadcast: () => {} });
    open(dc);
    const updates: string[] = [];
    const n = sweepPendingDecisions({ store, broadcast: (m) => updates.push(m) });
    assert.equal(n, 1);
    assert.equal(updates.includes("room.process"), true);
    const meta = JSON.parse(store.read("room", "r1")[0]!.text) as DecisionMeta;
    assert.equal(meta.status, "expired");
  });
});

describe("AcpAgent 决策卡事件", () => {
  it("permission → decision.request + permission.request；respond → decision.resolve answered", async () => {
    setPermissionBypass(false);
    const { agentConn, hub, events } = agentSetup();
    await hub.createSession("/tmp", "s");
    const respP = agentConn.client.request(acp.methods.client.session.requestPermission, {
      sessionId: "s1",
      toolCall: TOOL_CALL,
      options: OPTIONS,
    });
    const ev = await waitFor(() => events.find((e) => e.method === "decision.request"));
    if (ev.method !== "decision.request") throw new Error("unreachable");
    assert.equal(ev.params.type, "permission");
    assert.equal(ev.params.title, "Run command");
    assert.equal(ev.params.grantKey, permissionKeyOf(TOOL_CALL));
    assert.equal(ev.params.options.length, 3);
    assert.ok(events.some((e) => e.method === "permission.request"), "旧 permission.request 路径保留");

    assert.equal(hub.respondPermission(ev.params.requestId, "allow"), true);
    const resp = (await respP) as { outcome: { outcome?: string } };
    assert.equal(resp.outcome.outcome, "selected");
    const done = await waitFor(() => events.find((e) => e.method === "decision.resolve"));
    if (done.method !== "decision.resolve") throw new Error("unreachable");
    assert.equal(done.params.outcome, "answered");
    assert.equal(done.params.optionId, "allow");
    hub.close();
    agentConn.close();
  });

  it("always 授权命中 → 同类请求自动放行（auto 决策卡，无 permission.request）；撤销后恢复询问", async () => {
    setPermissionBypass(false);
    const { agentConn, hub, events } = agentSetup();
    await hub.createSession("/tmp", "s");
    hub.grantPermission("s1", permissionKeyOf(TOOL_CALL), "always");

    const resp = (await agentConn.client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: "s1",
        toolCall: TOOL_CALL,
        options: OPTIONS,
      },
    )) as { outcome: { outcome?: string } };
    assert.equal(resp.outcome.outcome, "selected");
    const autoCard = await waitFor(() =>
      events.find((e) => e.method === "decision.request" && e.params.auto === true),
    );
    if (autoCard.method !== "decision.request") throw new Error("unreachable");
    assert.equal(autoCard.params.grantScope, "always");
    assert.ok(
      !events.some((e) => e.method === "permission.request"),
      "授权命中不再弹 permission.request",
    );

    // 撤销授权 → 恢复逐次询问
    assert.equal(hub.revokePermissionGrant("s1", permissionKeyOf(TOOL_CALL)), true);
    const p2 = agentConn.client.request(acp.methods.client.session.requestPermission, {
      sessionId: "s1",
      toolCall: TOOL_CALL,
      options: OPTIONS,
    });
    const ev = await waitFor(() => events.find((e) => e.method === "permission.request"));
    if (ev.method !== "permission.request") throw new Error("unreachable");
    assert.equal(hub.respondPermission(ev.params.requestId, "allow"), true);
    await p2;
    hub.close();
    agentConn.close();
  });

  it("revokePermission 终止挂起请求并 resolve revoked", async () => {
    setPermissionBypass(false);
    const { agentConn, hub, events } = agentSetup();
    await hub.createSession("/tmp", "s");
    const respP = agentConn.client.request(acp.methods.client.session.requestPermission, {
      sessionId: "s1",
      toolCall: TOOL_CALL,
      options: OPTIONS,
    });
    const ev = await waitFor(() => events.find((e) => e.method === "decision.request"));
    if (ev.method !== "decision.request") throw new Error("unreachable");
    assert.equal(hub.revokePermission(ev.params.requestId), true);
    await respP;
    const done = await waitFor(() => events.find((e) => e.method === "decision.resolve"));
    if (done.method !== "decision.resolve") throw new Error("unreachable");
    assert.equal(done.params.outcome, "revoked");
    hub.close();
    agentConn.close();
  });

  it("elicitation → decision.request(type=elicitation)；respond → resolve answered", async () => {
    const { agentConn, hub, events } = agentSetup();
    await hub.createSession("/tmp", "s");
    const respP = agentConn.client.request(acp.methods.client.elicitation.create, {
      mode: "form",
      sessionId: "s1",
      message: "需要输入",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", title: "名字" } },
      },
    });
    const ev = await waitFor(() => events.find((e) => e.method === "decision.request"));
    if (ev.method !== "decision.request") throw new Error("unreachable");
    assert.equal(ev.params.type, "elicitation");
    assert.equal(ev.params.title, "需要输入");
    assert.ok(events.some((e) => e.method === "elicitation.request"));
    assert.equal(hub.respondElicitation(ev.params.requestId, "accept", { name: "x" }), true);
    const resp = await respP;
    assert.equal(resp.action, "accept");
    const done = await waitFor(() => events.find((e) => e.method === "decision.resolve"));
    if (done.method !== "decision.resolve") throw new Error("unreachable");
    assert.equal(done.params.outcome, "answered");
    assert.equal(done.params.action, "accept");
    hub.close();
    agentConn.close();
  });
});

describe("permissionKeyOf/permissionTitleOf", () => {
  it("kind:name 组合键，缺 name 回退 title 首行，再回退 kind", () => {
    assert.equal(permissionKeyOf({ kind: "execute", name: "bash" }), "execute:bash");
    assert.equal(permissionKeyOf({ kind: "edit", title: "a.ts\n细节" }), "edit:a.ts");
    assert.equal(permissionKeyOf({ kind: "read" }), "read");
    assert.equal(permissionKeyOf(undefined), "other");
    assert.equal(permissionTitleOf({ title: "T" }), "T");
    assert.equal(permissionTitleOf({ name: "N" }), "N");
    assert.equal(permissionTitleOf({}), "permission");
  });
});

describe("listPending", () => {
  it("仅返回活跃 pending，按 at 排序，深拷贝", () => {
    const store = tmpStore();
    try {
      const broadcasts: unknown[] = [];
      const dc = new DecisionCenter({
        store,
        broadcast: (m, p) => broadcasts.push({ method: m, params: p }),
      });
      dc.open(
        { requestId: "r2", sessionId: "s1", type: "permission", title: "T2", options: [{ id: "allow", label: "Allow" }] },
        { scope: "session", scopeId: "s1", requestedBy: "a" },
      );
      dc.open(
        { requestId: "r1", sessionId: "s1", type: "permission", title: "T1", options: [{ id: "allow", label: "Allow" }] },
        { scope: "room", scopeId: "room1", requestedBy: "b" },
      );
      const list = dc.listPending();
      assert.equal(list.length, 2);
      assert.ok(list[0]!.at <= list[1]!.at);
      (list[0] as Record<string, unknown>).title = "mutated";
      assert.notEqual(dc.listPending()[0]!.title, "mutated", "深拷贝隔离");
      dc.resolveByRequest("r1", "answered", { optionId: "allow" });
      const after = dc.listPending();
      assert.equal(after.length, 1);
      assert.equal(after[0]!.requestId, "r2");
      dc.resolveByRequest("r2", "expired");
      assert.equal(dc.listPending().length, 0);
    } finally {
      store.close();
    }
  });

  it("按 roomId/sessionId/missionId 过滤；无参返回全部 pending", () => {
    const store = tmpStore();
    try {
      const dc = new DecisionCenter({ store, broadcast: () => {} });
      const req = (requestId: string, sessionId: string) => ({
        requestId,
        sessionId,
        type: "permission" as const,
        title: "t",
        options: [{ id: "allow", label: "Allow" }],
      });
      dc.open(req("r-room", "s1"), { scope: "room", scopeId: "roomA", requestedBy: "x" });
      dc.open(req("r-sess", "s9"), { scope: "session", scopeId: "s9", requestedBy: "x" });
      dc.open(req("r-mis", "s2"), { scope: "room", scopeId: "roomB", requestedBy: "x", missionId: "ms_1" });
      assert.equal(dc.listPending().length, 3, "无过滤返回全部");
      assert.deepEqual(dc.listPending({ roomId: "roomA" }).map((d) => d.requestId), ["r-room"]);
      assert.deepEqual(dc.listPending({ sessionId: "s9" }).map((d) => d.requestId), ["r-sess"]);
      assert.deepEqual(dc.listPending({ missionId: "ms_1" }).map((d) => d.requestId), ["r-mis"]);
      assert.equal(dc.listPending({ roomId: "nope" }).length, 0);
      // OR 语义：命中任一即收窄
      assert.equal(dc.listPending({ roomId: "roomA", sessionId: "s9" }).length, 2);
    } finally {
      store.close();
    }
  });

  it("pending 超上限淘汰最旧：定稿 revoked + 原位覆写", () => {
    const store = tmpStore();
    try {
      const dc = new DecisionCenter({ store, broadcast: () => {}, maxPending: 2 });
      const req = (requestId: string) => ({
        requestId,
        sessionId: "s1",
        type: "permission" as const,
        title: requestId,
        options: [{ id: "allow", label: "Allow" }],
      });
      dc.open(req("d1"), { scope: "room", scopeId: "r1", requestedBy: "x" });
      dc.open(req("d2"), { scope: "room", scopeId: "r1", requestedBy: "x" });
      dc.open(req("d3"), { scope: "room", scopeId: "r1", requestedBy: "x" });
      const list = dc.listPending();
      assert.deepEqual(list.map((d) => d.requestId), ["d2", "d3"], "最旧的 d1 被淘汰");
      const entries = store.read("room", "r1");
      const oldest = JSON.parse(entries[0]!.text) as DecisionMeta;
      assert.equal(oldest.status, "revoked", "淘汰的 pending 定稿为 revoked 而非悬挂");
      // resolved/answered 卡不占 pending 名额
      dc.resolveByRequest("d2", "answered", { optionId: "allow" });
      dc.open(req("d4"), { scope: "room", scopeId: "r1", requestedBy: "x" });
      assert.deepEqual(dc.listPending().map((d) => d.requestId), ["d3", "d4"]);
    } finally {
      store.close();
    }
  });
});

test("prune 保留5000普通历史且豁免未完成flow/decision/draft/running process", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-ret-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const prot: number[] = [];
  prot.push(store.append("room", "r1", { at: 1, kind: "flow", author: "", text: JSON.stringify({ flowId: "fw", phase: "working" }) }));
  prot.push(store.append("room", "r1", { at: 2, kind: "flow", author: "", text: JSON.stringify({ flowId: "fr", phase: "awaiting-retry" }) }));
  prot.push(store.append("room", "r1", { at: 3, kind: "decision", author: "", text: JSON.stringify({ decisionId: "pd", status: "pending" }) }));
  prot.push(store.beginReplyDraft("room", "r1", { at: 4, kind: "assistant", author: "w", text: "draft-done-later" }));
  prot.push(store.append("room", "r1", { at: 5, kind: "process", author: "", text: JSON.stringify({ processId: "pr1", status: "running" }) }));
  const draftKeep = store.beginReplyDraft("room", "r1", { at: 6, kind: "assistant", author: "w", text: "draft-keep" });
  const malformed = ["{bad", "null", "[1,2]", '"str"'];
  const ordinaryIDs: number[] = [];
  for (let i = 0; i < 5100; i++) {
    const kind = i % 25 === 0 ? "flow" : i % 25 === 1 ? "decision" : i % 25 === 2 ? "process" : "assistant";
    const text = kind === "flow" ? (i % 7 === 0 ? malformed[i % malformed.length]! : JSON.stringify({ flowId: `f${i}`, phase: "done" }))
      : kind === "decision" ? (i % 7 === 0 ? malformed[(i + 1) % malformed.length]! : JSON.stringify({ decisionId: `d${i}`, status: "answered" }))
      : kind === "process" ? (i % 7 === 0 ? malformed[(i + 2) % malformed.length]! : JSON.stringify({ processId: `p${i}`, status: "done" }))
      : `n${i}`;
    ordinaryIDs.push(store.append("room", "r1", { at: 100 + i, kind, author: "w", text }));
  }
  store.append("session", "r1", { at: 1, kind: "assistant", author: "w", text: "s1" });
  store.append("session", "r1", { at: 2, kind: "assistant", author: "w", text: "s2" });
  store.close();
  store = new Store(dir);
  const rows = store.read("room", "r1", 10000);
  const ids = new Set(rows.map((r) => r.id));
  const keptOrdinary = ordinaryIDs.filter((id) => ids.has(id));
  const expectedOrdinary = new Set(ordinaryIDs.slice(ordinaryIDs.length - 5000));
  assert.deepEqual(new Set(keptOrdinary), expectedOrdinary, "恰好保留最新5000普通行");
  for (const pid of [...prot, draftKeep]) assert.ok(ids.has(pid), `保护行 ${pid} 应保留`);
  assert.equal(rows.length, 5006, "6 保护 + 最新5000 普通");
  const protRows = rows.filter((r) => [...prot, draftKeep].includes(r.id));
  assert.deepEqual(protRows.map((r) => r.at).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], "保护行 id/at 不变");
  assert.equal(store.read("session", "r1", 100).length, 2, "另一 scope_id 不受影响");
  store.updateEntry(prot[0]!, JSON.stringify({ flowId: "fw", phase: "done" }));
  store.updateEntry(prot[1]!, JSON.stringify({ flowId: "fr", phase: "cancelled" }));
  store.updateEntry(prot[2]!, JSON.stringify({ decisionId: "pd", status: "expired" }));
  store.updateEntry(prot[4]!, JSON.stringify({ processId: "pr1", status: "done" }));
  store.completeReplyDraft(prot[3]!, "draft-final", 0);
  store.close();
  store = new Store(dir);
  const rows3 = store.read("room", "r1", 10000);
  const ids3 = new Set(rows3.map((r) => r.id));
  for (const pid of [prot[0]!, prot[1]!, prot[2]!, prot[4]!]) assert.ok(!ids3.has(pid), `旧终态行 ${pid} 被裁`);
  assert.ok(ids3.has(prot[3]!), "completeReplyDraft 后 at=NOW 仍足够新被保留");
  assert.ok(ids3.has(draftKeep), "仍 draft1 的行继续豁免");
  assert.equal(rows3.length, 5001, "5000 普通 + 1 仍 draft");
  const keptOrdinary3 = new Set([...ordinaryIDs.slice(-4999), prot[3]!]);
  const actualOrdinary3 = new Set(rows3.map((r) => r.id).filter((id) => ![draftKeep].includes(id)));
  assert.deepEqual(actualOrdinary3, keptOrdinary3, "普通集合=最新4999普通+刚完成draft行");
});

test("sweep 孤儿flow/pending decision keyset 分页扫完全部批次", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sweep-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const flowText = (id: string, phase = "working") => JSON.stringify({ flowId: id, phase });
  const orphanRooms: string[] = [];
  for (let i = 0; i < 501; i++) {
    store.append("room", "r1", { at: i + 1, kind: "flow", author: "", text: flowText(`orphan-${i}`) });
  }
  store.append("room", "rX", { at: 1, kind: "flow", author: "", text: flowText("orphan-x") });
  for (let i = 0; i < 500; i++) {
    const rid = `rL${i}`;
    orphanRooms.push(rid);
    store.append("room", rid, { at: i + 1, kind: "flow", author: "", text: flowText(`live-${rid}`) });
  }
  for (let i = 0; i < 600; i++) {
    store.append("room", "r1", { at: 9000 + i, kind: "flow", author: "", text: flowText(`done-${i}`, "done") });
  }
  const snap = () => {
    const m = new Map<string, string>();
    for (const rid of ["r1", "rX", ...orphanRooms]) {
      m.set(rid, store.read("room", rid, 10000).map((r) => `${r.id}@${r.at}`).join(","));
    }
    return m;
  };
  const before = snap();
  const broadcasts: { method: string; params: Record<string, unknown> }[] = [];
  sweepOrphanFlowCards({
    store,
    liveFlowId: (roomId) => (roomId.startsWith("rL") ? `live-${roomId}` : undefined),
    broadcast: (method, params) => broadcasts.push({ method, params }),
  });
  assert.deepEqual(snap(), before, "sweep 不改任何行 id/at 且不新增行");
  const r1rows = store.read("room", "r1", 10000);
  const cancelled = r1rows.filter((r) => {
    try { const m = JSON.parse(r.text) as { flowId?: string; phase?: string }; return m.flowId?.startsWith("orphan-") && m.phase === "cancelled"; } catch { return false; }
  });
  assert.equal(cancelled.length, 501, "r1 全部 501 孤儿 cancelled");
  const xrow = store.read("room", "rX", 100).find((r) => { try { return (JSON.parse(r.text) as { flowId?: string }).flowId === "orphan-x"; } catch { return false; } });
  assert.equal((JSON.parse(xrow!.text) as { phase?: string }).phase, "cancelled", "首批全 skip 后第二批仍扫到 rX 孤儿");
  const liveOk = orphanRooms.every((rid) => {
    const row = store.read("room", rid, 10)[0];
    try { const m = JSON.parse(row!.text) as { flowId?: string; phase?: string }; return m.flowId === `live-${rid}` && m.phase === "working"; } catch { return false; }
  });
  assert.ok(liveOk, "500 个 live 卡原样 working");
  for (let i = 0; i < 501; i++) {
    const scope = i % 2 === 0 ? "room" : "session";
    const sid = scope === "room" ? "r1" : "s1";
    store.append(scope, sid, { at: i + 1, kind: "decision", author: "", text: JSON.stringify({ decisionId: `pd-${i}`, status: "pending", requestedBy: "x" }) });
  }
  for (let i = 0; i < 600; i++) {
    store.append("room", "r1", { at: 20000 + i, kind: "decision", author: "", text: JSON.stringify({ decisionId: `dn-${i}`, status: "approved" }) });
  }
  const dSnap = () => ["room:r1", "session:s1"].map((k) => {
    const [s, id] = k.split(":") as ["room" | "session", string];
    return store.read(s, id, 10000).map((r) => `${r.id}@${r.at}`).join(",");
  });
  const dBefore = dSnap();
  const dBroadcasts: { method: string; params: Record<string, unknown> }[] = [];
  const swept = sweepPendingDecisions({ store, broadcast: (method, params) => dBroadcasts.push({ method, params }) });
  assert.equal(swept, 501, "501 pending 全部 swept");
  assert.equal(dBroadcasts.filter((b) => b.method === "decision.update").length, 501);
  assert.equal(dBroadcasts.filter((b) => b.method === "room.process").length, 251, "room scope pending 251 个");
  assert.deepEqual(dSnap(), dBefore, "decision sweep 不改任何行 id/at");
  for (const [s, id] of [["room", "r1"], ["session", "s1"]] as const) {
    const pending = store.read(s, id, 10000).filter((r) => {
      try { return (JSON.parse(r.text) as { status?: string }).status === "pending"; } catch { return false; }
    });
    assert.equal(pending.length, 0, `${s}:${id} 无 pending 残留`);
  }
});

test("flow card sync 边界防御：tracked/restored 缺行与异己行不复用", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-fc-"));
  let store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const mkSync = (rowId: () => number | undefined, setId: (id: number) => void, roomMode = "") =>
    makeFlowCardSync({
      store,
      rooms: { get: () => (roomMode ? { mode: roomMode } : undefined) } as never,
      broadcast: () => {},
      cardRowId: rowId,
      setCardRowId: (_r, id) => setId(id),
    });
  const flow = { flowId: "f-track", phase: "working", tasks: [], progress: { done: 0, running: 1, pending: 0, failed: 0, total: 1 }, startedAt: 1000 };

  let trackedId: number | undefined;
  const syncT = mkSync(() => trackedId, (id) => { trackedId = id; });
  syncT("rT", flow);
  const firstRow = trackedId!;
  assert.ok(store.entryAt(firstRow) !== undefined);
  store.deleteHistory("room", "rT");
  syncT("rT", flow);
  assert.notEqual(trackedId, firstRow, "tracked 行被清后不得沿用旧 id");
  assert.ok(store.entryAt(trackedId!) !== undefined, "新 tracked 行真实存在");
  assert.equal(store.read("room", "rT", 100).length, 1);
  syncT("rT", { ...flow, phase: "done" });
  assert.equal(store.read("room", "rT", 100).length, 1, "重建后更新不重复 append");
  assert.equal(trackedId, store.read("room", "rT", 100)[0]!.id);

  const legalRow = store.append("room", "rL", { at: 7000, kind: "flow", author: "", text: JSON.stringify(flow) });
  let legalId: number | undefined = legalRow;
  const syncL = mkSync(() => legalId, (id) => { legalId = id; });
  const beforeL = store.read("room", "rL", 100).length;
  syncL("rL", { ...flow, phase: "reviewing" });
  assert.equal(legalId, legalRow, "合法 cardRowId 保持同 id");
  assert.equal(store.read("room", "rL", 100).length, beforeL, "合法恢复不新增行");
  const legalMeta = JSON.parse(store.read("room", "rL", 100).find((r) => r.id === legalRow)!.text) as Record<string, unknown>;
  assert.equal(legalMeta.phase, "reviewing", "原位覆写生效");

  const foreignRow = store.append("session", "sF", { at: 8000, kind: "flow", author: "", text: JSON.stringify(flow) });
  const foreignText = store.read("session", "sF", 100).find((r) => r.id === foreignRow)!.text;
  let fId: number | undefined = foreignRow;
  const syncF = mkSync(() => fId, (id) => { fId = id; });
  syncF("rF", flow);
  assert.notEqual(fId, foreignRow, "异 scope 行不得复用");
  assert.ok(store.entryAt(fId!) !== undefined);
  assert.equal(store.read("session", "sF", 100).find((r) => r.id === foreignRow)!.text, foreignText, "异 scope 原行不被覆写");

  const kindRow = store.append("room", "rK", { at: 8100, kind: "assistant", author: "w", text: "not-a-card" });
  let kId: number | undefined = kindRow;
  const syncK = mkSync(() => kId, (id) => { kId = id; });
  syncK("rK", flow);
  assert.notEqual(kId, kindRow, "非 flow 行不得复用");
  assert.equal(store.read("room", "rK", 100).find((r) => r.id === kindRow)!.text, "not-a-card", "原行不被覆写");

  const misRow = store.append("room", "rM", { at: 8200, kind: "flow", author: "", text: JSON.stringify({ ...flow, flowId: "other" }) });
  let mId: number | undefined = misRow;
  const syncM = mkSync(() => mId, (id) => { mId = id; });
  syncM("rM", flow);
  assert.notEqual(mId, misRow, "flowId 不匹配不得复用");
  assert.equal((JSON.parse(store.read("room", "rM", 100).find((r) => r.id === misRow)!.text) as { flowId?: string }).flowId, "other", "原行不被覆写");

  const flowConductor = { ...flow, flowId: "f-mode", mode: "conductor" };
  let modeId: number | undefined;
  const syncMode2 = mkSync(() => modeId, (id) => { modeId = id; }, "parallel");
  syncMode2("rMode2", flowConductor);
  const modeMeta = JSON.parse(store.read("room", "rMode2", 100).at(-1)!.text) as Record<string, unknown>;
  assert.equal(modeMeta.mode, "conductor", "快照 mode 优先 flow.mode 而非 room.mode");

  let finBroadcasts = 0;
  let finId: number | undefined;
  const syncFin = makeFlowCardSync({
    store,
    rooms: { get: () => undefined } as never,
    broadcast: () => { finBroadcasts++; },
    cardRowId: () => finId,
    setCardRowId: (_r, id) => { finId = id; },
  });
  syncFin("rFin", flow);
  const finRow = finId!;
  assert.ok(store.entryAt(finRow) !== undefined);
  store.deleteHistory("room", "rFin");
  finBroadcasts = 0;
  syncFin("rFin", undefined);
  assert.equal(store.read("room", "rFin", 100).length, 0, "清史后 finalize 不得复活行");
  assert.equal(finBroadcasts, 0, "缺行 finalize 不得广播幽灵 id");
});
