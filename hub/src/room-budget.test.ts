import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomManager, roomExecutionLimits } from "./room.js";
import { RoomModeManager, type AgentOps, type PromptContent } from "./room-modes.js";
import type { Room } from "./room.js";

function makeAgent() {
  const busy = new Set<string>();
  const prompts: { sessionId: string; content: unknown }[] = [];
  const agent: AgentOps = {
    prompt: async (sessionId, content) => {
      prompts.push({ sessionId, content });
      busy.add(sessionId);
    },
    isBusy: (sid) => busy.has(sid),
    has: () => true,
    cancel: async (sid) => {
      busy.delete(sid);
    },
    cwd: (sid) => `/w/${sid}`,
  };
  return { agent, busy, prompts };
}

function makeManager(agent: AgentOps, rooms: RoomManager, broadcasts: { method: string; params: Record<string, unknown> }[] = []) {
  const b = broadcasts.length ? broadcasts : [];
  const manager = new RoomModeManager(agent, rooms, (method, params) => b.push({ method, params }));
  return { manager, broadcasts: b };
}

const budgetsOf = (m: RoomModeManager) =>
  (m as unknown as { budgets: Map<string, {
    id: string; usedCalls: number; maxCalls: number; deadlineAt: number; maxConcurrent: number;
    stopped: boolean; reason?: string;
  }> }).budgets;

const budgetNotices = (b: { method: string; params: Record<string, unknown> }[]) =>
  b.filter((x) => x.method === "room.notice" && (x.params.meta as { type?: string } | undefined)?.type === "budget");

describe("roomExecutionLimits", () => {
  it("默认三上限为 null 不限，显式大值合法，非法仍拒", () => {
    assert.deepEqual(roomExecutionLimits({}), { maxConcurrent: null, maxCalls: null, maxFlowDurationMs: null });
    assert.deepEqual(
      roomExecutionLimits({ maxConcurrent: 100, maxAgentCalls: 100000, maxFlowDurationMs: 2592000000 }),
      { maxConcurrent: 100, maxCalls: 100000, maxFlowDurationMs: 2592000000 },
    );
    assert.deepEqual(
      roomExecutionLimits({ maxConcurrent: 17, maxAgentCalls: 257, maxFlowDurationMs: 172800000 }),
      { maxConcurrent: 17, maxCalls: 257, maxFlowDurationMs: 172800000 },
    );
    assert.throws(() => roomExecutionLimits({ maxConcurrent: 0 }));
    assert.throws(() => roomExecutionLimits({ maxConcurrent: 1.5 }));
    assert.throws(() => roomExecutionLimits({ maxAgentCalls: -1 }));
    assert.throws(() => roomExecutionLimits({ maxFlowDurationMs: 999 }));
    assert.throws(() => roomExecutionLimits({ maxFlowDurationMs: Number.MAX_SAFE_INTEGER }));
    assert.equal(roomExecutionLimits({ maxFlowDurationMs: 2160000000 }).maxFlowDurationMs, 2160000000);
    assert.throws(() => roomExecutionLimits({ maxRounds: 0 }));
    assert.throws(() => roomExecutionLimits({ maxRounds: 2.5 }));
    assert.equal(roomExecutionLimits({ maxRounds: 100 }).maxCalls, null);
  });
});

describe("a) auto 决策+调用上限", () => {
  it("maxCalls=2：决策+1worker 共2次，第三被拒，stopped，notice恰好1，无重试", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("a1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w1" },
      { sessionId: "s3", name: "w2" },
    ], "auto", { conductorId: "s1", maxAgentCalls: 2 });
    const { agent, busy, prompts } = makeAgent();
    const { manager, broadcasts } = makeManager(agent, rooms);
    const p0 = prompts.length;
    await manager.handle(room, "并行评估两件事", {});
    busy.delete("s1");
    await manager.onPromptDone("s1", '```json\n{"mode":"parallel","params":{"targets":["s2","s3"],"summarizer":"s1"}}\n```');
    await new Promise((r) => setImmediate(r));
    const sent = prompts.slice(p0);
    assert.equal(sent.filter((p) => p.sessionId === "s1").length, 1, "决策 prompt 已发");
    const workerSends = sent.filter((p) => p.sessionId === "s2" || p.sessionId === "s3");
    assert.equal(workerSends.length, 1);
    const budget = budgetsOf(manager).get(room.roomId)!;
    assert.equal(budget.stopped, true, "预算应已 stopped");
    assert.equal(budgetNotices(broadcasts).length, 1, "budget notice 恰好1次");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(prompts.length - p0, 2, "eventloop 后无额外重试发送");
  });
});

describe("b) 并发上限分批+第三人汇总", () => {
  it("maxConcurrent=2：三成员第三排队，完成后参与且进 results", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("b1", [
      { sessionId: "s1", name: "a" },
      { sessionId: "s2", name: "b" },
      { sessionId: "s3", name: "c" },
    ], "parallel", { parallelSummarizerId: "s1", maxConcurrent: 2 });
    const { agent, busy, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "评估", { params: { targets: ["s1", "s2", "s3"], summarizer: "s1" } });
    assert.equal(prompts.filter((p) => p.sessionId === "s3").length, 0, "并发2时第三人不立即外发");
    busy.delete("s1"); busy.delete("s2");
    await manager.onPromptDone("s1", "out-s1");
    await manager.onPromptDone("s2", "out-s2");
    await new Promise((r) => setImmediate(r));
    assert.ok(prompts.some((p) => p.sessionId === "s3"), "释放配额后第三人应派发");
    busy.delete("s3");
    await manager.onPromptDone("s3", "out-s3");
    await new Promise((r) => setImmediate(r));
    const flow = manager.getFlow(room.roomId) as { tasks: { sessionId: string; output?: string }[]; phase: string };
    assert.equal(flow.tasks.find((t) => t.sessionId === "s3")?.output, "out-s3");
    assert.equal(flow.phase, "summarizing");
    assert.match(String(prompts.at(-1)?.content), /out-s3/);
  });
});

describe("c) SessionBusyError 计数回滚", () => {
  it("竞态 busy：计数回滚不重复计", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("c1", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 5 });
    const { agent, busy, prompts } = makeAgent();
    let calls = 0;
    const origPrompt = agent.prompt;
    agent.prompt = async (sid, content, opts) => {
      calls++;
      if (calls === 1) {
        busy.add(sid);
        const { isSessionBusyError } = await import("./agent.js");
        const err = new Error("session busy: x");
        (err as { code?: string }).code = "SESSION_BUSY";
        void isSessionBusyError; void opts;
        throw err;
      }
      return origPrompt(sid, content, opts);
    };
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a 任务", {});
    await new Promise((r) => setImmediate(r));
    const budget = budgetsOf(manager).get(room.roomId)!;
    assert.equal(budget.usedCalls, 0, "SessionBusyError 回退后 usedCalls 应为0");
  });
});

describe("d) maxCalls=1 conductor 首个 worker 后阻塞", () => {
  it("首 worker 完成后下一派发被挡→awaiting-retry+未发pending", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("d1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxAgentCalls: 1 });
    const { agent, busy } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "goal", {
      params: { tasks: [
        { id: "t1", to: "w", task: "一", dependsOn: [] },
        { id: "t2", to: "w", task: "二", dependsOn: ["t1"] },
      ] },
    });
    const budget = budgetsOf(manager).get(room.roomId)!;
    busy.delete("s1");
    await manager.onPromptDone("s1", '```json\n{"tasks":[{"id":"t1","to":"w","task":"一","dependsOn":[]},{"id":"t2","to":"w","task":"二","dependsOn":["t1"]}]}\n```');
    await new Promise((r) => setImmediate(r));
    busy.delete("s2");
    await manager.onPromptDone("s2", "done-t1");
    await new Promise((r) => setTimeout(r, 20));
    const flow = manager.getFlow(room.roomId) as { phase?: string; tasks?: { id: string; status: string }[] } | undefined;
    assert.ok(flow, "应有 flow");
    assert.equal(budget.stopped, true);
    assert.equal(budget.usedCalls, 1);
    assert.equal(flow!.phase, "awaiting-retry", "耗尽应 awaiting-retry");
    const t2 = flow!.tasks!.find((t) => t.id === "t2")!;
    assert.equal(t2.status, "pending", "未发任务应退 pending");
  });
});

describe("e) deadline 真实 timer 取消", () => {
  it("到期触发 deadline cancel，仅本房在途", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const rooms = new RoomManager();
    const room = rooms.create("e1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxFlowDurationMs: 1000 });
    const { agent, busy } = makeAgent();
    const cancelled: string[] = [];
    const origCancel = agent.cancel;
    agent.cancel = async (sid) => { cancelled.push(sid); await origCancel(sid); };
    const { manager, broadcasts } = makeManager(agent, rooms);
    await manager.handle(room, "goal", {
      params: { tasks: [{ id: "t1", to: "w", task: "任务", dependsOn: [] }] },
    });
    busy.delete("s1");
    await manager.onPromptDone("s1", '```json\n{"tasks":[{"id":"t1","to":"w","task":"任务","dependsOn":[]}]}\n```');
    await new Promise((r) => setImmediate(r));
    const budget = budgetsOf(manager).get(room.roomId)!;
    t.mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(budget.stopped, true);
    assert.equal(budget.reason, "deadline");
    assert.deepEqual(cancelled, ["s2"]);
    const notice = broadcasts.find((b) => b.method === "room.notice" &&
      (b.params.meta as { reasonCode?: string } | undefined)?.reasonCode === "deadline");
    assert.ok(notice, "应有 deadline notice");
  });
});

describe("f) 导出耗尽预算+队列导入不续跑", () => {
  it("已耗尽预算导出→导入→resumeFlows 零新调用", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("f1", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 1 });
    const { agent, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a 任务一", {});
    const pAfterFirst = prompts.length;
    await manager.handle(room, "@a 任务二", {});
    const state = manager.exportRuntime();
    const budgets = state.budgets as { roomId: string; stopped: boolean; usedCalls: number }[];
    assert.ok(budgets.some((b) => b.roomId === room.roomId), "export 应含 budgets");

    const rooms2 = new RoomManager();
    const room2 = rooms2.create("f1b", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 1 });
    (rooms2 as unknown as { rooms: Map<string, Room> }).rooms.delete(room2.roomId);
    room2.roomId = room.roomId;
    (rooms2 as unknown as { rooms: Map<string, Room> }).rooms.set(room.roomId, room2);
    const { agent: agent2, prompts: prompts2 } = makeAgent();
    const { manager: manager2 } = makeManager(agent2, rooms2);
    await manager2.importRuntime(state);
    manager2.resumeFlows();
    await new Promise((r) => setTimeout(r, 20));
    const b2 = budgetsOf(manager2).get(room.roomId)!;
    assert.ok(b2, "import 应恢复预算");
    assert.equal(prompts2.length, 0, "耗尽预算导入后 resumeFlows 不应新调用");
    assert.ok(pAfterFirst >= 1);
  });
});

describe("h) 显式 continue 续杯 vs 补充不重置", () => {
  it("stopped 后 retryFailedTasks 换新预算 id；未耗尽不换", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("h1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxAgentCalls: 2 });
    const { agent, busy } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "goal", {
      params: { tasks: [{ id: "t1", to: "w", task: "任务", dependsOn: [] }] },
    });
    const b1 = budgetsOf(manager).get(room.roomId)!;
    busy.delete("s1");
    await manager.onPromptDone("s1", '```json\n{"tasks":[{"id":"t1","to":"w","task":"任务","dependsOn":[]}]}\n```');
    await new Promise((r) => setImmediate(r));
    const idBefore = b1.id;
    const usedBefore = b1.usedCalls;
    manager.supplementActive(room, "补充验证要求");
    assert.equal(budgetsOf(manager).get(room.roomId)?.id, idBefore);
    assert.equal(b1.usedCalls, usedBefore, "未耗尽计数不重置");
  });
});

describe("预算交付边界", () => {
  it("deadline 取消确认前，即使真实取消事件先到也不补发他房回合", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const rooms = new RoomManager();
    const members = [{ sessionId: "a", name: "a" }];
    const first = rooms.create("cancel-first", members, "mention", { maxFlowDurationMs: 1000 });
    const second = rooms.create("cancel-second", members, "mention");
    const { agent, busy, prompts } = makeAgent();
    let confirm!: () => void;
    const confirmation = new Promise<void>((resolve) => { confirm = resolve; });
    const cancellations: string[] = [];
    agent.cancel = async (sid) => {
      cancellations.push(sid);
      await confirmation;
      busy.delete(sid);
    };
    const { manager } = makeManager(agent, rooms);
    await manager.handle(first, "@a first");
    await manager.handle(second, "@a second");
    t.mock.timers.tick(1000);
    busy.delete("a");
    manager.onSessionCancelled("a");
    assert.equal(prompts.length, 1);
    confirm();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(cancellations, ["a"]);
    assert.equal(prompts.length, 2);
    assert.equal(manager.roomIdForTurn("a"), second.roomId);
    assert.match(String(prompts[1]!.content), /second/);
  });

  it("旧 prompt Promise 迟到失败不能清掉新回合归属", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("late-reject", [{ sessionId: "a", name: "a" }], "mention");
    const { agent, busy } = makeAgent();
    let rejectOld!: (err: Error) => void;
    const old = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    let calls = 0;
    agent.prompt = async (sid) => {
      busy.add(sid);
      if (++calls === 1) return old;
    };
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a first");
    busy.delete("a");
    await manager.onPromptDone("a", "first done");
    await manager.handle(room, "@a second");
    rejectOld(new Error("late transport failure"));
    await new Promise((r) => setImmediate(r));
    assert.equal(manager.roomIdForTurn("a"), room.roomId);
    assert.equal(calls, 2);
  });

  it("异步路由返回时，已撤销请求不能借用新预算重新派发", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("late-router", [
      { sessionId: "host", name: "host" }, { sessionId: "a", name: "a" },
    ], "auto", { conductorId: "host" });
    const { agent, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    let finish!: (v: unknown) => void;
    const result = new Promise((resolve) => { finish = resolve; });
    manager.setModeDecider({
      enforced: true, explicitMention: () => undefined, fastRoute: () => undefined, decide: () => result,
    } as unknown as Parameters<RoomModeManager["setModeDecider"]>[0]);
    const dispatch = manager.handle(room, "OLD_ROUTING_REQUEST");
    await new Promise((r) => setImmediate(r));
    await manager.cancelActive(room.roomId);
    await manager.handle(room, "@a NEW_EXPLICIT_REQUEST");
    finish({ action: "direct", mode: "parallel", reason: "late", confidence: 1, via: "model" });
    await dispatch;
    assert.equal(prompts.length, 1);
    assert.match(String(prompts[0]!.content), /NEW_EXPLICIT_REQUEST/);
  });

  it("同批未发送 worker 回 pending，明确重试后先授额再发出并计数", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("resume-budget", [
      { sessionId: "host", name: "host" },
      { sessionId: "a", name: "a" },
      { sessionId: "b", name: "b" },
    ], "conductor", { conductorId: "host", maxAgentCalls: 1 });
    const { agent, busy, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "goal", { params: { tasks: [
      { id: "t1", to: "a", task: "one" },
      { id: "t2", to: "b", task: "two" },
    ] } });
    await new Promise((r) => setImmediate(r));
    const stopped = budgetsOf(manager).get(room.roomId)!;
    assert.equal(stopped.stopped, true);
    let flow = manager.getFlow(room.roomId) as { phase: string; tasks: { id: string; status: string; output?: string }[] };
    assert.equal(flow.phase, "awaiting-retry");
    assert.equal(flow.tasks.find((t) => t.id === "t1")?.status, "running");
    assert.equal(flow.tasks.find((t) => t.id === "t2")?.status, "pending");
    busy.delete("a");
    await manager.onPromptDone("a", "evidence-one");
    flow = manager.getFlow(room.roomId) as typeof flow;
    assert.equal(flow.tasks.find((t) => t.id === "t1")?.status, "done");
    assert.equal(flow.tasks.find((t) => t.id === "t1")?.output, "evidence-one");
    assert.equal(manager.retryFailedTasks(room.roomId), true);
    await new Promise((r) => setImmediate(r));
    const renewed = budgetsOf(manager).get(room.roomId)!;
    assert.notEqual(renewed.id, stopped.id);
    assert.equal(renewed.usedCalls, 1);
    assert.equal(prompts.filter((p) => p.sessionId === "b").length, 1);
  });

  it("同一主持人的两个房间排队决策各自消费正确的原始请求", async () => {
    const rooms = new RoomManager();
    const members = [{ sessionId: "host", name: "host" }, { sessionId: "a", name: "a" }];
    const first = rooms.create("first", members, "auto", { conductorId: "host" });
    const second = rooms.create("second", members, "auto", { conductorId: "host" });
    const { agent, busy, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(first, "FIRST_UNIQUE_REQUEST", {});
    await manager.handle(second, "SECOND_UNIQUE_REQUEST", {});
    busy.delete("host");
    await manager.onPromptDone("host", '{"mode":"self"}');
    assert.equal(prompts.length, 2);
    assert.match(String(prompts[1]!.content), /FIRST_UNIQUE_REQUEST/);
    assert.doesNotMatch(String(prompts[1]!.content), /SECOND_UNIQUE_REQUEST/);
    busy.delete("host");
    await manager.onPromptDone("host", "first answer");
    assert.match(String(prompts.at(-1)!.content), /SECOND_UNIQUE_REQUEST/);
    busy.delete("host");
    await manager.onPromptDone("host", '{"mode":"self"}');
    assert.match(String(prompts.at(-1)!.content), /SECOND_UNIQUE_REQUEST/);
    assert.equal(manager.subModeFor(second.roomId)?.mode, "self");
  });

  it("Store flow 快照比 runtime 新时恢复较大调用计数", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("snapshot-budget", [
      { sessionId: "host", name: "host" }, { sessionId: "a", name: "a" },
    ], "conductor", { conductorId: "host" });
    const { agent, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    const budget = { id: "budget-stable", usedCalls: 1, maxCalls: 2, maxConcurrent: 3,
      deadlineAt: Date.now() + 60000, stopped: false };
    await manager.importRuntime({
      budgets: [{ roomId: room.roomId, ...budget }],
      conductor: { flows: [{
        id: "flow-stable", roomId: room.roomId, startedAt: Date.now(), phase: "planning",
        goal: "goal", tasks: [], results: {}, budget: { ...budget, usedCalls: 2, stopped: true },
      }] },
    });
    manager.resumeFlows();
    await new Promise((r) => setImmediate(r));
    assert.equal(budgetsOf(manager).get(room.roomId)?.usedCalls, 2);
    assert.equal(manager.getFlow(room.roomId)?.phase, "awaiting-retry");
    assert.equal(prompts.length, 0);
  });
});

describe("j) tool update 不计调用", () => {
  it("observeToolUpdate 不增加 usedCalls", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("j1", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 5 });
    const { agent } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a 任务", {});
    const budget = budgetsOf(manager).get(room.roomId)!;
    const before = budget.usedCalls;
    manager.observeToolUpdate("s1", { kind: "tool_call", title: "x" });
    manager.observeToolUpdate("s1", { kind: "tool_call_update", status: "in_progress" });
    assert.equal(budget.usedCalls, before, "tool update 不应计调用");
  });
});

describe("批5判别：fresh 生命周期", () => {
  it("i) 顺序 mention：完成后新请求授新预算（id 变、计数不沿用）", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("i1", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 10 });
    const { agent, busy } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a 任务一", {});
    const b1 = budgetsOf(manager).get(room.roomId)!;
    busy.delete("s1");
    await manager.onPromptDone("s1", "done1");
    await new Promise((r) => setImmediate(r));
    await manager.handle(room, "@a 任务二", {});
    const b2 = budgetsOf(manager).get(room.roomId)!;
    assert.notEqual(b2.id, b1.id, "流程终结后新请求应授新预算 id");
    assert.equal(b2.usedCalls, 1, "新预算从0计，本次外发计1");
  });

  it("cancelActive 后预算 stopped，新请求仍可授新预算", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("i2", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1" });
    const { agent, busy } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "goal", {
      params: { tasks: [{ id: "t1", to: "w", task: "任务", dependsOn: [] }] },
    });
    const b1 = budgetsOf(manager).get(room.roomId)!;
    await manager.cancelActive(room.roomId, "test");
    assert.equal(b1.stopped, true, "cancelActive 应停预算");
    await manager.handle(room, "@w 新任务", {});
    const b2 = budgetsOf(manager).get(room.roomId)!;
    assert.notEqual(b2.id, b1.id, "取消后新请求应授新预算");
    assert.equal(b2.stopped, false);
  });
});

describe("批5判别：blockedStage 保留", () => {
  it("planning 阶段耗尽→awaiting-retry 保留 blockedStage=planning", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("j2", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxAgentCalls: 1 });
    const { agent, busy } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "goal", {});
    const budget = budgetsOf(manager).get(room.roomId)!;
    assert.equal(budget.usedCalls, 1, "规划 prompt 计1次");
    const inner = manager as unknown as { exhaustBudget: (r: string, reason: "call-limit" | "deadline") => void };
    inner.exhaustBudget(room.roomId, "call-limit");
    const flow = manager.getFlow(room.roomId) as { phase?: string } | undefined;
    assert.equal(flow?.phase, "awaiting-retry");
    const snap = (manager.exportRuntime().conductor as { flows?: { blockedStage?: string }[] }).flows?.[0];
    assert.equal(snap?.blockedStage, "planning", "planning 阶段耗尽应保留 blockedStage=planning");
    void busy;
  });
});

describe("批5判别：importRuntime flow 快照预算合并", () => {
  it("仅 flow.budget 无 state.budgets 时 usedCalls 仍还原", async () => {
    const rooms2 = new RoomManager();
    const room2 = rooms2.create("k1", [{ sessionId: "s1", name: "a" }], "mention", { maxAgentCalls: 5 });
    const { agent: agent2 } = makeAgent();
    const { manager: manager2 } = makeManager(agent2, rooms2);
    const state = {
      conductor: { flows: [{ roomId: room2.roomId, budget: { id: "bfx1", usedCalls: 3, maxCalls: 5, deadlineAt: Date.now() + 60000, maxConcurrent: 2, stopped: false } }] },
      budgets: [],
    };
    await manager2.importRuntime(state as Record<string, unknown>);
    const b2 = budgetsOf(manager2).get(room2.roomId);
    assert.ok(b2, "应从 flow 快照恢复预算");
    assert.equal(b2.usedCalls, 3, "usedCalls 应从 flow.budget 还原");
    assert.equal(b2.id, "bfx1");
  });
});

describe("importRuntime 预算细节", () => {
  it("显式时限且快照缺 deadlineAt：由 flow startedAt 推断而非落 null", async () => {
    const rooms = new RoomManager();
    const startedAt = Date.now() - 1000;
    const room = rooms.create("imp1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxFlowDurationMs: 60000 });
    const { agent } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.importRuntime({
      budgets: [{ roomId: room.roomId, id: "b1", usedCalls: 3, stopped: false }],
      conductor: {
        flows: [{ roomId: room.roomId, startedAt, phase: "working", goal: "g" }],
      },
    });
    const b = budgetsOf(manager).get(room.roomId)!;
    assert.equal(b.deadlineAt, startedAt + 60000, "startedAt+显式时限推断 deadline");
    assert.equal(b.stopped, false);
  });

  it("同 id merge：null deadline 不转 0，单侧有效取有效值", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("imp2", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "w" },
    ], "conductor", { conductorId: "s1", maxFlowDurationMs: 60000 });
    const { agent } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    const future = Date.now() + 30000;
    await manager.importRuntime({
      budgets: [{ roomId: room.roomId, id: "x1", usedCalls: 1, deadlineAt: null, stopped: false }],
      conductor: {
        flows: [{
          roomId: room.roomId, startedAt: Date.now(), phase: "working", goal: "g",
          budget: { id: "x1", usedCalls: 1, deadlineAt: future, maxCalls: null, maxConcurrent: null, stopped: false },
        }],
      },
    });
    const b = budgetsOf(manager).get(room.roomId)!;
    assert.equal(b.deadlineAt, future, "null 侧不捏造 0，取有效时间戳");
    assert.equal(b.stopped, false, "不因伪造 deadline 立即到期");
  });
});

describe("默认无限预算", () => {
  it("默认三上限 null：同房 busy 锚点下 31 次串行调用同预算不停止", async (t) => {
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["Date"] });
    try {
      const rooms = new RoomManager();
      const room = rooms.create("u1", [
        { sessionId: "s1", name: "a" },
        { sessionId: "s2", name: "b" },
      ], "mention");
      const { agent, busy, prompts } = makeAgent();
      const { manager } = makeManager(agent, rooms);
      await manager.handle(room, "@b anchor", {});
      const first = budgetsOf(manager).get(room.roomId)!;
      for (let i = 0; i < 30; i++) {
        await manager.handle(room, `@a msg${i}`, {});
        busy.delete("s1");
        await manager.onPromptDone("s1", `ok${i}`);
        await new Promise((r) => setImmediate(r));
      }
      const b = budgetsOf(manager).get(room.roomId)!;
      assert.equal(b.id, first.id, "锚点存活期间同一预算代际");
      assert.equal(b.usedCalls, 31, "1 次锚点 + 30 次串行全部计入");
      assert.equal(b.maxCalls, null);
      assert.equal(b.maxConcurrent, null);
      assert.equal(b.deadlineAt, null);
      assert.equal(b.stopped, false);
      assert.equal(prompts.length, 31, "全部派发不截断");
      mock.timers.tick(31 * 60 * 1000);
      await new Promise((r) => setImmediate(r));
      assert.equal(b.stopped, false, "推进 31 分钟无 deadline 不停止");
      assert.equal((b as { timer?: unknown }).timer, undefined, "无 deadline 不排 timer");
    } finally {
      mock.timers.reset();
    }
  });

  it("显式单字段不捆绑：仅 maxCalls 不带 deadline/并发，默认并发不再是3", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("u2", [
      { sessionId: "s1", name: "a" },
      { sessionId: "s2", name: "b" },
      { sessionId: "s3", name: "c" },
      { sessionId: "s4", name: "d" },
    ], "parallel", { parallelSummarizerId: "s1", maxAgentCalls: 100 });
    const { agent, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "评估", { params: { targets: ["s1", "s2", "s3", "s4"], summarizer: "s1" } });
    await new Promise((r) => setImmediate(r));
    const workers = prompts.filter((p) => ["s1", "s2", "s3", "s4"].includes(p.sessionId));
    assert.ok(workers.length >= 4, "默认并发不限：四成员同时派发");
    const b = budgetsOf(manager).get(room.roomId)!;
    assert.equal(b.maxCalls, 100);
    assert.equal(b.maxConcurrent, null, "仅设调用上限不附带并发上限");
    assert.equal(b.deadlineAt, null, "仅设调用上限不附带时长上限");
  });

  it("两个不同 cwd 房间各 4 成员并发互不挤占", async () => {
    const rooms = new RoomManager();
    const mk = (name: string, ids: string[]) =>
      rooms.create(name, ids.map((s) => ({ sessionId: s, name: s })), "parallel", {
        parallelSummarizerId: ids[0],
      });
    const r1 = mk("p1", ["s1", "s2", "s3", "s4"]);
    const r2 = mk("p2", ["s5", "s6", "s7", "s8"]);
    const { agent, prompts } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(r1, "评估", { params: { targets: ["s1", "s2", "s3", "s4"], summarizer: "s1" } });
    await manager.handle(r2, "评估", { params: { targets: ["s5", "s6", "s7", "s8"], summarizer: "s5" } });
    await new Promise((r) => setImmediate(r));
    const sent = prompts.filter((p) => ["s1","s2","s3","s4","s5","s6","s7","s8"].includes(p.sessionId));
    assert.equal(sent.length, 8, "两房 8 成员全部并发派发不共享配额");
  });

  it("显式时长>24天分段 timer 不提前 exhaust，deadline 到才取消", async (t) => {
    const { mock } = await import("node:test");
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const rooms = new RoomManager();
      const room = rooms.create("u3", [{ sessionId: "s1", name: "a" }], "mention", {
        maxFlowDurationMs: 2160000000,
      });
      const { agent, busy } = makeAgent();
      const { manager, broadcasts } = makeManager(agent, rooms);
      await manager.handle(room, "@a task", {});
      const b = budgetsOf(manager).get(room.roomId)!;
      assert.equal(b.deadlineAt !== null, true);
      const deadline = b.deadlineAt!;
      mock.timers.tick(2147483647);
      await new Promise((r) => setImmediate(r));
      assert.equal(b.stopped, false, "分段点不提前 exhaust");
      assert.equal(budgetNotices(broadcasts).length, 0);
      mock.timers.tick(deadline - Date.now() + 1);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(b.stopped, true, "最终 deadline 到才停止");
      assert.equal(b.reason, "deadline");
    } finally {
      mock.timers.reset();
    }
  });

  it("导出导入 null 上限保持 null，旧快照默认 caps 在房未设时不生效", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("u4", [{ sessionId: "s1", name: "a" }], "mention");
    const { agent } = makeAgent();
    const { manager } = makeManager(agent, rooms);
    await manager.handle(room, "@a hi", {});
    const state = manager.exportRuntime() as { budgets: Record<string, unknown>[] };
    const exported = state.budgets.find((x) => x.roomId === room.roomId)!;
    assert.equal(exported.maxCalls, null);
    assert.equal(exported.maxConcurrent, null);
    assert.equal(exported.deadlineAt, null);

    const rooms2 = new RoomManager();
    rooms2.import(room);
    const { agent: agent2 } = makeAgent();
    const { manager: manager2 } = makeManager(agent2, rooms2);
    const legacyState = {
      budgets: [{
        roomId: room.roomId, id: "old1", usedCalls: 5, maxCalls: 24, maxConcurrent: 3,
        deadlineAt: Date.now() + 60000, stopped: false,
      }],
    };
    await manager2.importRuntime(legacyState);
    const b2 = budgetsOf(manager2).get(room.roomId)!;
    assert.equal(b2.maxCalls, null, "旧快照默认 caps 不得当作用户授权");
    assert.equal(b2.maxConcurrent, null);
    assert.equal(b2.deadlineAt, null);
    assert.equal(b2.usedCalls, 5, "调用计数代际仍恢复");
    assert.equal(b2.stopped, false);
  });
});
