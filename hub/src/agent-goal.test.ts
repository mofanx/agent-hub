import { test } from "node:test";
import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, setPromptAckTimeoutMs, type HubEvent } from "./agent.js";

function pipe() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const end = () => { if (!closed) { closed = true; controller.close(); } };
  return {
    readable: new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } }),
    writable: new WritableStream<Uint8Array>({ write: (v) => controller.enqueue(v), close: end }),
    end,
  };
}

async function fixture(actions = ["set", "pause", "resume", "clear"], holdSet = false, steering?: string) {
  const a = pipe(), b = pipe();
  const events: HubEvent[] = [], calls: Record<string, unknown>[] = [], turns: string[] = [];
  let finishControl!: () => void;
  const heldControl = new Promise<void>((resolve) => { finishControl = resolve; });
  let initialize: acp.InitializeRequest | undefined;
  let cancels = 0;
  const steers: unknown[] = [];
  const capability = { version: 1, controlMethod: "_session/goal", actions };
  const backend = acp.agent()
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      initialize = params;
      return { protocolVersion: acp.PROTOCOL_VERSION, _meta: { steering: { supported: steering !== undefined }, jetbrains: { air: { version: 1, goal: capability } } } };
    })
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "s1" }))
    .onNotification(acp.methods.agent.session.cancel, () => { cancels++; })
    .onRequest("_session/steering", (p: unknown) => p, ({ params }) => { steers.push(params); return { outcome: steering }; })
    .onRequest("_session/goal", (p: unknown) => p as Record<string, unknown>, async ({ params }) => {
      calls.push(params);
      if (holdSet && params.action === "set") {
        await goal({ objective: String(params.objective), status: "active" });
        await heldControl;
      }
      return {};
    })
    .connect(acp.ndJsonStream(b.writable, a.readable));
  const agent = new AcpAgent("goal-test", acp.ndJsonStream(a.writable, b.readable), (e) => events.push(e),
    undefined, undefined, (_sid, text) => turns.push(text));
  const goal = (g: unknown) => backend.client.notify(acp.methods.client.session.update, {
    sessionId: "s1", update: { sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { goal: g } } } },
  });
  const chunk = (text: string) => backend.client.notify(acp.methods.client.session.update, {
    sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
  await agent.createSession(process.cwd(), "worker");
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { agent, backend, events, calls, turns, goal, chunk, tick, initialize, steers, finishControl, disconnect: b.end, cancels: () => cancels };
}

test("ACP goal: 使用真实 Hub 身份，仅声明已实现的扩展", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  assert.equal(f.initialize?.clientInfo?.name, "agent-hub");
  assert.deepEqual(f.initialize?.clientCapabilities?._meta, { jetbrains: { air: { version: 1, capabilities: [] } } });
  assert.deepEqual(f.agent.getGoalCapabilities()?.actions, ["set", "pause", "resume", "clear"]);
  assert.equal(f.agent.getNativeGoal("s1"), null);
});

test("ACP goal: 控制调用只能使用协商动作，不能伪造 Claude 暂停", async (t) => {
  const f = await fixture(["set", "clear"]);
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await assert.rejects(() => f.agent.controlGoal("s1", "pause"), /unsupported/);
  assert.equal(f.calls.length, 0);
});

test("ACP goal: 创建发原生控制请求而非 /goal 提示词，并从确认快照提前返回", async (t) => {
  const f = await fixture(undefined, true);
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await Promise.race([
    f.agent.controlGoal("s1", "set", "approved"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("goal ACK blocked by long execution")), 500)),
  ]);
  assert.deepEqual(f.calls, [{ sessionId: "s1", action: "set", objective: "approved" }]);
  assert.equal(f.agent.getNativeGoal("s1")?.status, "active");
});

test("ACP goal: 未绑定目标的空闲期内容仍按迟到流量丢弃", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  await f.chunk("zombie");
  await f.tick();
  assert.equal(f.events.filter((e) => e.method === "session.update").length, 0);
});

test("ACP goal: 绑定目标的自主输出能够定稿、持久化并保持普通回合防护", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  await f.chunk("first");
  await f.chunk(" second");
  await f.tick();
  assert.equal(f.agent.isBusy("s1"), true);
  await f.goal({ objective: "approved", status: "complete" });
  await f.tick();
  assert.deepEqual(f.turns, ["first second"]);
  assert.equal(f.agent.isBusy("s1"), false);
  await f.chunk("stale");
  await f.tick();
  assert.deepEqual(f.turns, ["first second"]);
});

test("ACP goal: 空闲期清除仍停止原生目标并发送取消，旧自主输出不能复活", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  await f.agent.controlGoal("s1", "clear");
  await f.chunk("late");
  await f.tick();
  assert.equal(f.agent.getNativeGoal("s1"), null);
  assert.equal(f.agent.isBusy("s1"), false);
  assert.equal(f.cancels(), 1);
  assert.equal(f.events.filter((e) => e.method === "prompt.done").length, 0);
});

test("ACP goal: 不接管或清除其他来源的目标", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  await f.goal({ objective: "user-existing-goal", status: "active" });
  await f.tick();
  assert.throws(() => f.agent.bindNativeGoal("s1", "execution-1", "approved"), /another.*goal|existing.*goal/);
  assert.equal(f.calls.length, 0);
});

test("ACP goal: 中途补充仅在 steering 明确 injected 后报告送达", async (t) => {
  const f = await fixture(undefined, false, "injected");
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  await f.chunk("working");
  await f.tick();
  assert.equal(await f.agent.supplementNativeGoal("s1", "approved correction"), "delivered");
  assert.deepEqual(f.steers, [{
    sessionId: "s1", prompt: [{ type: "text", text: "approved correction" }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  }]);
});

test("ACP goal: steering 不支持或失败只记录，不谎称已注入", async (t) => {
  for (const outcome of [undefined, "failed"]) {
    const f = await fixture(undefined, false, outcome);
    t.after(() => { f.agent.close(); f.backend.close(); });
    f.agent.bindNativeGoal("s1", "execution-1", "approved");
    await f.agent.controlGoal("s1", "set", "approved");
    await f.chunk("working");
    await f.tick();
    assert.equal(await f.agent.supplementNativeGoal("s1", "correction"), "recorded");
  }
});

test("ACP goal: 空闲期断连仍通知目标失联，不保留虚假的执行中状态", async (t) => {
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  f.disconnect();
  await f.tick();
  assert.ok(f.events.some((e) => e.method === "session.goal.error" && e.params.executionId === "execution-1"));
});

test("ACP goal: 目标已确认但一直零输出仍受 ACK 看门狗保护，不无限挂起", async (t) => {
  setPromptAckTimeoutMs(10);
  const f = await fixture();
  t.after(() => { f.agent.close(); f.backend.close(); setPromptAckTimeoutMs(180000); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(f.calls.map((p) => p.action), ["set", "pause"]);
  assert.equal(f.agent.getNativeGoal("s1")?.status, "paused");
});

test("ACP goal: complete 先于控制回合收尾时保留最后答复，不提前定稿", async (t) => {
  const f = await fixture(undefined, true);
  t.after(() => { f.agent.close(); f.backend.close(); });
  f.agent.bindNativeGoal("s1", "execution-1", "approved");
  await f.agent.controlGoal("s1", "set", "approved");
  await f.chunk("working;");
  await f.goal({ objective: "approved", status: "complete" });
  await f.tick();
  assert.equal(f.agent.isBusy("s1"), true);
  await f.chunk("final answer");
  f.finishControl();
  await f.tick();
  assert.equal(f.agent.isBusy("s1"), false);
  assert.equal(f.turns.at(-1), "working;final answer");
});
