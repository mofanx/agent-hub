import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ConductorOrchestrator } from "./conductor.js";
import { RoomModeManager } from "./room-modes.js";
import { RoomManager } from "./room.js";
import { ModeDecider } from "./decide.js";
import { retryEligibility } from "./mission.js";

type Task = { id: string; to: string; task: string; dependsOn?: string[]; files?: string[] };
type View = {
  phase: string;
  goal: string;
  acceptanceCriteria: string[];
  failureMessage?: string;
  tasks: { id: string; sessionId: string; status: string; dependsOn: string[] }[];
};
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r)); };
const task = (id: string, to: string, dependsOn: string[] = []): Task => ({ id, to, task: id, dependsOn });

function fixture(t: TestContext) {
  const rooms = new RoomManager();
  const room = rooms.create("safety", ["host", "a", "b", "c"].map((sessionId) => ({ sessionId, name: sessionId })), "conductor", { conductorId: "host" });
  const sent: { sid: string; text: string }[] = [];
  const notices: string[] = [];
  const agent = {
    prompt: async (sid: string, content: unknown) => { sent.push({ sid, text: String(content) }); },
    isBusy: () => false,
    has: () => true,
    cancel: async () => {},
  };
  const orch = new ConductorOrchestrator(agent, rooms, (n) => notices.push(n.message));
  const manager = new RoomModeManager(agent, rooms, () => {});
  t.after(() => { orch.cancel(room.roomId); manager.onRoomRemoved(room.roomId); });
  return { rooms, room, sent, notices, agent, orch, manager, view: () => orch.getFlow(room.roomId) as View };
}

for (const [name, tasks] of [
  ["循环依赖", [task("t1", "a", ["t2"]), task("t2", "b", ["t1"])]],
  ["自依赖", [task("t1", "a", ["t1"])]],
  ["悬空依赖", [task("t1", "a", ["missing"])]],
  ["重复任务 ID", [task("t1", "a"), task("t1", "b")]],
  ["未知成员", [task("t1", "a"), task("t2", "missing")]],
] as const) {
  it(`初始计划含${name}时整批阻塞，零任务外发`, async (t) => {
    const f = fixture(t);
    await f.orch.start(f.room, "approved goal", [...tasks]);
    assert.equal(f.view().phase, "awaiting-retry");
    assert.ok(f.view().failureMessage);
    assert.equal(f.sent.length, 0);
    f.orch.resumeFlows();
    await tick();
    assert.equal(f.sent.length, 0);
  });
}

it("规划 JSON 中未知依赖不能被归一化静默删除", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "approved goal");
  await f.orch.onPromptDone("host", JSON.stringify({ tasks: [task("t1", "a", ["missing"])] }));
  assert.equal(f.view().phase, "awaiting-retry");
  assert.deepEqual(f.sent.map((p) => p.sid), ["host"]);
});

it("同文件的串行任务保留节点与依赖，不合并成环", async (t) => {
  const f = fixture(t);
  const tasks = [
    task("t1", "a"),
    { ...task("t2", "b", ["t1"]), files: ["shared.ts"] },
    task("t3", "c", ["t2"]),
    { ...task("t4", "b", ["t3"]), files: ["shared.ts"] },
  ];
  await f.manager.handle(f.room, "approved goal", { params: { tasks } });
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.equal(view.tasks.length, 4);
  assert.deepEqual(view.tasks.find((n) => n.id === "t2")?.dependsOn, ["t1"]);
  assert.deepEqual(view.tasks.find((n) => n.id === "t4")?.dependsOn, ["t3"]);
});

it("独立同文件任务仍合并，未显式命名的下游引用不随数组缩短而改号", async (t) => {
  const f = fixture(t);
  await f.manager.handle(f.room, "approved goal", { params: { tasks: [
    { to: "a", task: "first", files: ["shared.ts"] },
    { to: "b", task: "second", files: ["shared.ts"] },
    { to: "c", task: "last", dependsOn: ["t2"] },
  ] } });
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.deepEqual(view.tasks.map((n) => n.id), ["t1", "t3"]);
  assert.deepEqual(view.tasks[1]?.dependsOn, ["t1"]);
});

it("验收追加任务支持前向依赖，不能因声明顺序提前派发", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", reason: "more work", tasks: [task("r1", "a", ["r2"]), task("r2", "b", ["t1"])] }));
  assert.equal(f.view().tasks.find((n) => n.id === "r1")?.status, "pending");
  assert.equal(f.view().tasks.find((n) => n.id === "r2")?.status, "running");
});

it("验收追加无效图整批拒绝，保留已完成结果且不增轮次外发", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  const count = f.sent.length;
  await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", tasks: [task("r1", "a", ["r2"]), task("r2", "b", ["r1"])] }));
  assert.equal(f.view().phase, "awaiting-retry");
  assert.match(f.view().failureMessage ?? "", /dependency cycle/);
  assert.equal(f.view().tasks.length, 3);
  assert.equal(f.sent.length, count);
});

for (const phase of ["working", "done"]) {
  it(`恢复 ${phase} 旧快照含依赖环时暂停，不验收、不自动重派`, async (t) => {
    const f = fixture(t);
    await f.orch.import({ flows: [{
      id: "legacy", roomId: f.room.roomId, phase, goal: "original goal",
      acceptanceCriteria: ["specific check"], tasks: [
        { id: "t1", sessionId: "a", task: "design", status: "done", dependsOn: [] },
        { id: "t2", sessionId: "b", task: "red", status: "pending", dependsOn: ["t3"] },
        { id: "t3", sessionId: "c", task: "implement", status: "pending", dependsOn: ["t2"] },
      ],
    }] });
    assert.equal(f.view().phase, "awaiting-retry");
    assert.equal(f.view().goal, "original goal");
    f.orch.resumeFlows();
    await tick();
    assert.equal(f.sent.length, 0);
  });
}

it("主持人中断保留待办并暂停，同批 worker 迟到结果只收录、不续派", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b", ["t1"])]);
  f.orch.onPromptError("host", "upstream timeout");
  assert.equal(f.view().phase, "awaiting-retry");
  assert.ok(f.view().failureMessage?.includes("timeout"));
  await f.orch.onPromptDone("a", "finished first task");
  assert.equal(f.view().tasks[0]?.status, "done");
  assert.equal(f.view().tasks[1]?.status, "pending");
  assert.equal(f.sent.length, 1);
  f.orch.resumeFlows();
  await tick();
  assert.equal(f.sent.length, 1);
});

it("worker 连续回合错误有持久上限，不能无限重新派发", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a")]);
  await tick();
  for (let i = 0; i < 4; i++) {
    f.orch.onPromptError("a", "model failed");
    await tick();
  }
  assert.equal(f.view().phase, "awaiting-retry");
  assert.equal(f.view().tasks[0]?.status, "failed");
  assert.ok(f.sent.length <= 3);
  const count = f.sent.length;
  f.orch.resumeFlows();
  await tick();
  assert.equal(f.sent.length, count);
});

it("worker 已经外发工具动作后出错，不能自动重跑造成重复副作用", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a")]);
  f.orch.observeToolUpdate("a", { sessionUpdate: "tool_call", toolCallId: "exec-1", kind: "execute", status: "in_progress", rawInput: { command: "approved action" } });
  f.orch.onPromptError("a", "stream lost");
  await tick();
  assert.equal(f.view().phase, "awaiting-retry");
  assert.equal(f.sent.length, 1);
});

for (const stop of ["error", "cancel"]) {
  it(`${stop} 后有工具动作证据时，工单自动重试也不能绕过人工确认`, async (t) => {
    const f = fixture(t);
    await f.orch.start(f.room, "goal", [task("t1", "a")]);
    f.orch.observeToolUpdate("a", { sessionUpdate: "tool_call", toolCallId: "exec-1", kind: "execute", status: "in_progress", rawInput: { command: "approved action" } });
    f.orch.observeToolUpdate("a", { sessionUpdate: "tool_call_update", toolCallId: "exec-1", status: "failed", rawOutput: { exitCode: 1 } });
    if (stop === "error") f.orch.onPromptError("a", "stream lost");
    else f.orch.onSessionCancelled("a");
    await tick();
    const tasks = () => f.orch.getFlow(f.room.roomId)!.tasks as Parameters<typeof retryEligibility>[0];
    assert.equal(tasks()[0]?.backendRuns?.[0]?.exitCode, 1);
    assert.equal(retryEligibility(tasks()), "waiting-user");
    await f.orch.import(f.orch.export());
    assert.equal(retryEligibility(tasks()), "waiting-user");
    assert.equal(f.sent.length, 1);
    assert.equal(f.orch.retryFailedTasks(f.room.roomId), true);
    assert.equal(tasks()[0]?.waitingFor, undefined);
    assert.equal(f.sent.length, 2);
  });
}

it("验收派发持续失败也有上限，不反复唤醒模型", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.agent.prompt = async (sid, content) => {
    if (sid === "host") { attempts++; throw new Error("backend unavailable"); }
    f.sent.push({ sid, text: String(content) });
  };
  const orch = new ConductorOrchestrator(f.agent, f.rooms, () => {}, undefined, 1);
  t.after(() => { orch.cancel(f.room.roomId); });
  await orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await orch.onPromptDone(sid, "done");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(orch.getFlow(f.room.roomId)?.phase, "awaiting-retry");
  assert.equal(attempts, 3);
});

it("全部任务被中断时不伪装 done", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a")]);
  f.orch.onSessionCancelled("a");
  await tick();
  assert.equal(f.view().phase, "awaiting-retry");
  assert.equal(f.view().tasks[0]?.status, "failed");
});

it("验收输出不可解析时即使汇总返回，也不能标记目标完成", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "specific goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  await f.orch.onPromptDone("host", "等其他成员复核后再推进");
  await f.orch.onPromptDone("host", "汇总：下次继续");
  assert.equal(f.view().phase, "awaiting-retry");
  assert.ok(f.view().failureMessage);
});

for (const phase of ["summarizing", "reviewing", "done"]) {
  it(`恢复 ${phase} 旧快照还有合法待办时不能越过待办直接验收`, async (t) => {
    const f = fixture(t);
    await f.orch.import({ flows: [{
      id: "incomplete", roomId: f.room.roomId, phase, goal: "goal",
      tasks: [
        { id: "t1", sessionId: "a", task: "design", status: "done", dependsOn: [] },
        { id: "t2", sessionId: "b", task: "implement", status: "pending", dependsOn: ["t1"] },
      ],
      results: { t1: { text: "design", artifacts: [] } },
    }] });
    assert.equal(f.view().phase, "awaiting-retry");
    assert.equal(f.sent.length, 0);
  });
}

it("验收已否定且达到迭代上限，只能汇总未完成状态，不能 done", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  for (let i = 2; i <= 3; i++) {
    await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", reason: "not yet", tasks: [task(`r${i}`, "a")] }));
    await f.orch.onPromptDone("a", "done");
  }
  await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", reason: "still missing", tasks: [task("r4", "a")] }));
  await f.orch.onPromptDone("host", "部分工作已完成");
  assert.equal(f.view().phase, "awaiting-retry");
  assert.ok(f.view().failureMessage);
});

it("明确批准讨论方案后直接规划执行，不能再走主持人自答或重复讨论", async (t) => {
  const f = fixture(t);
  f.room.mode = "auto";
  f.manager.setModeDecider(new ModeDecider({}));
  await f.manager.handle(f.room, "请大家讨论下一步方案");
  await f.manager.onPromptDone("a", "建议分两步实现并验证");
  await f.manager.onPromptDone("b", "同意");
  await f.manager.onPromptDone("c", "同意");
  await f.manager.onPromptDone("host", "建议按方案实施");
  await f.manager.onPromptDone("host", "共识：实现并验证，不停留在讨论");
  await f.manager.handle(f.room, "好的，按照你们的建议推进，确保完成后交叉复核，并闭环验证通过。");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "planning");
  assert.equal(f.manager.subModeFor(f.room.roomId)?.mode, "conductor");
  assert.ok(f.sent.at(-1)?.text.includes("实现并验证"));
  const count = f.sent.length;
  await f.manager.handle(f.room, "继续执行");
  assert.equal(f.sent.length, count);
  const flowId = f.manager.getFlow(f.room.roomId)?.flowId;
  await f.manager.onPromptDone("host", JSON.stringify({ goal: "implement agreed proposal", acceptanceCriteria: ["implementation verified"],
    tasks: [task("t1", "a"), task("t2", "b", ["t1"]), task("t3", "c", ["t2"])],
  }));
  for (const sid of ["a", "b", "c"]) await f.manager.onPromptDone(sid, "done");
  await f.manager.onPromptDone("host", JSON.stringify({ decision: "complete" }));
  await f.manager.onPromptDone("host", "proposal implemented and verified");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "done");
  assert.equal(f.manager.getFlow(f.room.roomId)?.flowId, flowId);
  assert.equal(f.manager.getFlow(f.room.roomId)?.goal, "implement agreed proposal");
});

it("主持人中断后用户继续，只补派未完成节点，不重跑已完成任务", async (t) => {
  const f = fixture(t);
  await f.manager.handle(f.room, "original goal", { params: { tasks: [task("t1", "a"), task("t2", "b", ["t1"]), task("t3", "c")] } });
  await f.manager.onPromptDone("a", "first done");
  f.manager.onPromptError("host", "host error");
  await f.manager.onPromptDone("b", "second done");
  await f.manager.onPromptDone("c", "third done");
  const count = f.sent.filter((p) => p.sid !== "host").length;
  await f.manager.handle(f.room, "继续执行");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "reviewing");
  assert.equal(f.sent.filter((p) => p.sid !== "host").length, count);
});

it("旧依赖环由用户明确继续触发重规划，保持目标、验收和已完成结果", async (t) => {
  const f = fixture(t);
  await f.manager.importRuntime({ conductor: { flows: [{
    id: "legacy", roomId: f.room.roomId, phase: "done", goal: "deliver feature",
    acceptanceCriteria: ["specific real check"], tasks: [
      { id: "t1", sessionId: "a", task: "design", status: "done", dependsOn: [] },
      { id: "t2", sessionId: "b", task: "red", status: "pending", dependsOn: ["t3"] },
      { id: "t3", sessionId: "c", task: "green", status: "pending", dependsOn: ["t2"] },
    ], results: { t1: { text: "approved design evidence", artifacts: [] } },
  }] } });
  assert.equal(f.sent.length, 0);
  await f.manager.handle(f.room, "修正依赖后继续执行");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "planning");
  assert.ok(f.sent.at(-1)?.text.includes("approved design evidence"));
  await f.manager.onPromptDone("host", JSON.stringify({
    goal: "replace the objective", acceptanceCriteria: ["weaken check"],
    tasks: [task("t2", "b", ["t1"]), task("t3", "c", ["t2"])],
  }));
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.equal(view.goal, "deliver feature");
  assert.deepEqual(view.acceptanceCriteria, ["specific real check"]);
  assert.equal(view.tasks.find((n) => n.id === "t1")?.status, "done");
  assert.deepEqual(f.sent.filter((p) => p.sid !== "host").map((p) => p.sid), ["b"]);
  await f.manager.onPromptDone("b", "red evidence");
  await f.manager.onPromptDone("c", "green evidence");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "reviewing");
  await f.manager.onPromptDone("host", JSON.stringify({ decision: "complete", reason: "specific real check verified" }));
  await f.manager.onPromptDone("host", "final evidence");
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "done");
});

it("auto 推荐的具体目标和验收项进入持久 Flow，而不是退回通用文案", async (t) => {
  const f = fixture(t);
  f.room.mode = "auto";
  await f.manager.handle(f.room, "执行已批准的方案");
  await f.manager.onPromptDone("host", JSON.stringify({ mode: "conductor", params: {
    goal: "specific delivery", acceptanceCriteria: ["specific behavior verified"],
    tasks: [task("t1", "a"), task("t2", "b", ["t1"])],
  } }));
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.equal(view.goal, "specific delivery");
  assert.deepEqual(view.acceptanceCriteria, ["specific behavior verified"]);
  assert.ok(f.sent.at(-1)?.text.includes("specific delivery"));
});

it("成员名依赖先归一化，不能使同文件任务跳过安全合并", async (t) => {
  const f = fixture(t);
  await f.manager.handle(f.room, "goal", { params: { tasks: [
    { ...task("t1", "a"), files: ["same.ts"] },
    { ...task("t2", "b"), files: ["same.ts"] },
    task("t3", "c", ["a"]),
  ] } });
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.equal(view.tasks.length, 2);
  assert.equal(view.tasks.filter((n) => n.status === "running").length, 1);
});

for (const phase of ["planning", "reviewing", "summarizing"]) {
  it(`主持人在 ${phase} 主动停止后保留快照、暂停并可由用户恢复`, async (t) => {
    const f = fixture(t);
    await f.orch.start(f.room, "goal");
    if (phase !== "planning") {
      await f.orch.onPromptDone("host", JSON.stringify({ tasks: [task("t1", "a"), task("t2", "b"), task("t3", "c")] }));
      for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
      if (phase === "summarizing") await f.orch.onPromptDone("host", JSON.stringify({ decision: "complete" }));
    }
    f.orch.onSessionCancelled("host");
    assert.equal(f.view().phase, "awaiting-retry");
    const count = f.sent.length;
    f.orch.resumeFlows();
    await tick();
    assert.equal(f.sent.length, count);
    assert.equal(f.orch.continueFlow(f.room.roomId, "继续执行"), true);
    assert.equal(f.view().phase, phase);
  });
}

it("初次规划派发失败不能遗留无人推进的 planning", async (t) => {
  const f = fixture(t);
  f.agent.prompt = async () => { throw new Error("planning unavailable"); };
  await assert.rejects(f.orch.start(f.room, "goal"), /planning unavailable/);
  assert.equal(f.view().phase, "awaiting-retry");
  assert.ok(f.view().failureMessage?.includes("planning unavailable"));
});

it("验收追加中有未知成员时不能只执行剩余合法子集", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  const count = f.sent.filter((p) => p.sid !== "host").length;
  await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", tasks: [task("r1", "a"), task("r2", "unknown")] }));
  await f.orch.onPromptDone("host", "partial report");
  assert.equal(f.view().phase, "awaiting-retry");
  assert.equal(f.view().tasks.length, 3);
  assert.equal(f.sent.filter((p) => p.sid !== "host").length, count);
});

it("重规划格式纠正失败后不丢失旧目标与完成结果", async (t) => {
  const f = fixture(t);
  await f.orch.import({ flows: [{
    id: "legacy", roomId: f.room.roomId, phase: "working", goal: "keep this goal",
    tasks: [
      { id: "t1", sessionId: "a", status: "done", task: "design", dependsOn: [] },
      { id: "t2", sessionId: "b", status: "pending", task: "implement", dependsOn: ["missing"] },
    ], results: { t1: { text: "keep this evidence", artifacts: [] } },
  }] });
  f.orch.continueFlow(f.room.roomId, "修正依赖后继续执行");
  await f.orch.onPromptDone("host", "malformed plan");
  await f.orch.onPromptDone("host", "still malformed");
  assert.equal(f.view()?.phase, "awaiting-retry");
  assert.equal(f.view().goal, "keep this goal");
  assert.equal(f.view().tasks[0]?.status, "done");
});

it("同成员多个可运行节点只外发一个，其余等待前一回合结束", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "a"), task("t3", "b")]);
  assert.equal(f.sent.filter((p) => p.sid === "a").length, 1);
  assert.equal(f.view().tasks.find((n) => n.id === "t2")?.status, "pending");
  await f.orch.onPromptDone("a", "first result");
  assert.equal(f.sent.filter((p) => p.sid === "a").length, 2);
});

it("主持人会话失效不能把尚未验收的工作标成成功", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  f.agent.has = (sid?: string) => sid !== "host";
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  assert.equal(f.view().phase, "awaiting-retry");
  assert.ok(f.view().failureMessage);
});

it("恢复暂停快照的未知在途任务不能永远保持 running", async (t) => {
  const f = fixture(t);
  await f.orch.import({ flows: [{
    id: "interrupted", roomId: f.room.roomId, phase: "awaiting-retry", goal: "goal",
    tasks: [{ id: "t1", sessionId: "a", task: "work", status: "running", dependsOn: [], dispatchedAt: 1,
      backendRuns: [{ toolCallId: "already-executed", status: "failed", exitCode: 1, at: 1 }],
    }],
  }] });
  assert.equal(f.view().phase, "awaiting-retry");
  assert.equal(f.view().tasks[0]?.status, "failed");
  assert.equal(retryEligibility(f.orch.getFlow(f.room.roomId)!.tasks as Parameters<typeof retryEligibility>[0]), "waiting-user");
  assert.equal(f.sent.length, 0);
});

it("主持人直接规划的同文件任务保持文件互斥，不依赖 auto 合并路径", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal");
  await f.orch.onPromptDone("host", JSON.stringify({ tasks: [
    { ...task("t1", "a"), files: ["./src/shared.ts"] },
    { ...task("t2", "b"), files: ["src\\shared.ts"] },
  ] }));
  assert.deepEqual(f.sent.map((p) => p.sid), ["host", "a"]);
  assert.equal(f.view().tasks.find((n) => n.id === "t2")?.status, "pending");
  await f.orch.onPromptDone("a", "first change done");
  assert.equal(f.sent.at(-1)?.sid, "b");
});

it("追加计划的同文件任务也互斥，并登记新任务的负责成员", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
  for (const sid of ["a", "b", "c"]) await f.orch.onPromptDone(sid, "done");
  const count = f.sent.filter((p) => p.sid !== "host").length;
  await f.orch.onPromptDone("host", JSON.stringify({ decision: "continue", tasks: [
    { ...task("r1", "a", ["t1"]), files: ["shared.ts"] },
    { ...task("r2", "b", ["t2"]), files: ["shared.ts"] },
  ] }));
  assert.equal(f.sent.filter((p) => p.sid !== "host").length, count + 1);
  assert.equal(f.view().tasks.find((n) => n.id === "r2")?.status, "pending");
  assert.equal(f.orch.taskSubscribers(f.room.roomId, "r1")?.has("a"), true);
});

it("明确批准执行后不能以空计划假装完成", async (t) => {
  const f = fixture(t);
  f.room.mode = "auto";
  await f.manager.handle(f.room, "好的，按照建议推进");
  await f.manager.onPromptDone("host", JSON.stringify({ goal: "deliver feature", acceptanceCriteria: ["verified"], tasks: [] }));
  assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "awaiting-retry");
  assert.equal(f.sent.length, 1);
});

it("单执行者已有具体目标和验收项时，不能降级丢掉持久契约", async (t) => {
  const f = fixture(t);
  f.room.mode = "auto";
  await f.manager.handle(f.room, "完成明确的交付要求");
  await f.manager.onPromptDone("host", JSON.stringify({ mode: "conductor", params: {
    goal: "single backend deliverable", acceptanceCriteria: ["specific proof"], tasks: [task("t1", "a")],
  } }));
  const view = f.manager.getFlow(f.room.roomId) as View;
  assert.equal(view?.goal, "single backend deliverable");
  assert.deepEqual(view.acceptanceCriteria, ["specific proof"]);
});

for (const invalid of [
  { to: "b" },
  { to: "missing", task: "work", files: ["shared"] },
  { to: "b", task: " \n ", files: ["shared"] },
]) {
  it(`无效任务 ${JSON.stringify(invalid)} 整批拒绝，不能被过滤或同文件合并掩盖`, async (t) => {
    const f = fixture(t);
    const result = await f.manager.handle(f.room, "goal", { params: {
      tasks: [{ ...task("t1", "a"), files: ["shared"] }, invalid],
    } });
    assert.equal(f.manager.getFlow(f.room.roomId)?.phase, "awaiting-retry");
    assert.equal(f.sent.length, 0);
    assert.equal(result.sent.length, 0);
  });
}

it("已有目标验收契约不能被无任务的回答提前结束", async (t) => {
  const f = fixture(t);
  await f.orch.start(f.room, "goal", undefined, undefined, undefined, undefined, {
    goal: "specific deliverable", acceptanceCriteria: ["specific proof"],
  });
  await f.orch.onPromptDone("host", JSON.stringify({ tasks: [] }));
  assert.equal(f.view().phase, "awaiting-retry");
});

for (const phase of ["reviewing", "summarizing"]) {
  it(`${phase} 主持人终态前，多次连接唤醒不能重复派发，包括 RPC 已返回但仍在排队`, async (t) => {
    const f = fixture(t);
    await f.orch.start(f.room, "goal", [task("t1", "a"), task("t2", "b"), task("t3", "c")]);
    await f.orch.onPromptDone("a", "done");
    await f.orch.onPromptDone("b", "done");
    if (phase === "summarizing") await f.orch.onPromptDone("c", "done");
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    t.after(() => finish());
    let attempts = 0;
    f.agent.prompt = async (sid, content) => {
      f.sent.push({ sid, text: String(content) });
      if (sid === "host") { attempts++; await gate; }
    };
    const pending = phase === "reviewing"
      ? f.orch.onPromptDone("c", "done")
      : f.orch.onPromptDone("host", JSON.stringify({ decision: "complete" }));
    await tick();
    for (let i = 0; i < 3; i++) f.orch.resumeFlows();
    await tick();
    try { assert.equal(attempts, 1); }
    finally { finish(); await pending; }
    for (let i = 0; i < 3; i++) f.orch.resumeFlows();
    await tick();
    assert.equal(attempts, 1);
  });
}
