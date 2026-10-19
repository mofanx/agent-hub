import { describe, it } from "node:test";
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
