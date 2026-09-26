import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConductorOrchestrator, parseTasks, extractTaskResult } from "./conductor.js";
import { createPromptDoneParams, promptDoneInternalOutput, toPublicHubEvent } from "./agent.js";
import { RoomManager, type Room } from "./room.js";

describe("conductor", () => {
  const room: Room = {
    roomId: "room1",
    name: "test",
    mode: "conductor",
    members: [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ],
  };

  it("解析 JSON code fence 任务计划", () => {
    const output = `好的，开始拆解：\n\`\`\`json\n{\n  \"tasks\": [\n    {\"to\": \"coder\", \"task\": \"实现排序\"},\n    {\"to\": \"tester\", \"task\": \"写单测\", \"dependsOn\": [\"t1\"], \"id\": \"t2\"}\n  ]\n}\n\`\`\``;
    const tasks = parseTasks(output, room) ?? [];
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.to, "s1");
    assert.equal(tasks[0]!.task, "实现排序");
    assert.equal(tasks[1]!.to, "s2");
    assert.equal(tasks[1]!.dependsOn![0], "t1");
    assert.equal(tasks[1]!.id, "t2");
  });

  it("解析平衡 JSON 对象（无 code fence）", () => {
    const output = `计划：{"tasks":[{"to":"coder","task":"fix"},{"to":"tester","task":"test"}]}`;
    const tasks = parseTasks(output, room) ?? [];
    assert.equal(tasks.length, 2);
  });

  it("匹配部分名字", () => {
    const output = `{"tasks":[{"to":"cod","task":"quick fix"}]}`;
    const tasks = parseTasks(output, room) ?? [];
    assert.equal(tasks[0]!.to, "s1");
  });

  it("无任务时返回 null", () => {
    const tasks = parseTasks("随便说两句", room);
    assert.equal(tasks, null);
  });

  it("extractTaskResult 提取 JSON 中的 artifact", () => {
    const output = `\`\`\`json\n{\n  \"text\": \"已完成\",\n  \"artifacts\": [\n    {\"type\": \"file\", \"path\": \"src/sort.ts\", \"summary\": \"新增排序函数\"}\n  ]\n}\n\`\`\``;
    const result = extractTaskResult(output);
    assert.equal(result.text, "已完成");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]!.type, "file");
    assert.equal(result.artifacts[0]!.path, "src/sort.ts");
  });

  it("extractTaskResult 不再自动扫描普通文件路径", () => {
    const output = `我已经修改了 src/utils.ts 和 src/foo.ts，并运行了 npm test。`;
    const result = extractTaskResult(output);
    assert.equal(result.artifacts.filter((a) => a.type === "file").length, 0);
  });

  it("extractTaskResult 自动扫描 bash 命令", () => {
    const output = `\`\`\`bash\nnpx tsc --noEmit\n\`\`\`\n代码编译通过。`;
    const result = extractTaskResult(output);
    const cmd = result.artifacts.find((a) => a.type === "event" && a.action === "command");
    assert.ok(cmd);
    if (!cmd) return;
    assert.ok(cmd.summary.includes("tsc"));
  });

  it("extractTaskResult 自动扫描 diff 块", () => {
    const output = `diff --git a/src/sort.ts b/src/sort.ts\n--- a/src/sort.ts\n+++ b/src/sort.ts\n@@ -1,3 +1,4 @@\n+export function sort() {}`;
    const result = extractTaskResult(output);
    const file = result.artifacts.find((a) => a.type === "file" && a.path === "src/sort.ts");
    assert.ok(file);
  });

  it("extractTaskResult 忽略 build/node_modules diff", () => {
    const output = `diff --git a/node_modules/foo/index.ts b/node_modules/foo/index.ts\n--- a/node_modules/foo/index.ts\n+++ b/node_modules/foo/index.ts\n@@ -1,1 +1,2 @@\n+export {}`;
    const result = extractTaskResult(output);
    assert.equal(result.artifacts.length, 0);
  });

  it("extractTaskResult 自动扫描测试结果", () => {
    const output = `已完成，运行测试：\n\`\`\`bash\nnpm test\n\`\`\`\nTest passed: 12 failed, 3 skipped`;
    const result = extractTaskResult(output);
    const test = result.artifacts.find((a) => a.type === "event" && a.action === "test");
    assert.ok(test);
    assert.ok(test?.summary.includes("12 failed"));
    assert.ok(test?.summary.includes("3 skipped"));
  });

  it("extractTaskResult 自动扫描测试文件路径", () => {
    const output = `修改了 tests/sort.test.ts，运行测试全部通过。`;
    const result = extractTaskResult(output);
    const test = result.artifacts.find((a) => a.type === "event" && a.action === "test" && a.path === "tests/sort.test.ts");
    assert.ok(test);
  });

  it("长计划使用完整内部输出派工，公开事件仍保持截断", async () => {
    const rooms = new RoomManager();
    const conductorRoom = rooms.create(
      "long-plan",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(conductorRoom, "实现完整质量方案");
    const task = `实现：${"详细要求".repeat(300)}`;
    const fullOutput = `\`\`\`json\n${JSON.stringify({ tasks: [{ to: "worker", task }] })}\n\`\`\``;
    const params = createPromptDoneParams("conductor", "end_turn", fullOutput);
    assert.equal(params.output.length, 800);
    assert.equal(parseTasks(params.output, conductorRoom), null);
    assert.equal(promptDoneInternalOutput(params), fullOutput);
    await orchestrator.onPromptDone("conductor", promptDoneInternalOutput(params));
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1]!.sessionId, "worker");
    assert.match(prompts[1]!.content, /详细要求/);
    const publicEvent = toPublicHubEvent({ method: "prompt.done", params });
    assert.equal("internalOutput" in publicEvent.params, false);
  });

  it("planner/worker prompt 包含 Fusion 协作边界说明", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "fusion-boundary",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "任务");
    const planner = prompts.find((p) => p.sessionId === "conductor");
    assert.ok(planner);
    assert.ok(planner.content.includes("独立责任边界"));
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker","task":"做事"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    const worker = prompts.find((p) => p.sessionId === "worker");
    assert.ok(worker);
    assert.ok(worker.content.includes("端到端责任"));
    assert.ok(worker.content.includes("Fusion"));
  });

  it("计划无法解析时通知用户而不是静默结束", async () => {
    const rooms = new RoomManager();
    const conductorRoom = rooms.create(
      "bad-plan",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      (notice) => notices.push(notice.message),
    );
    await orchestrator.start(conductorRoom, "拆解任务");
    await orchestrator.onPromptDone("conductor", "不是合法任务计划");
    assert.equal(orchestrator.hasActiveFlow(conductorRoom.roomId), false);
    assert.match(notices.at(-1) ?? "", /无法解析/);
  });

  it("子任务派发失败后自动重试，失败依赖不解锁下游任务", async () => {
    const rooms = new RoomManager();
    const failRoom = rooms.create(
      "fail-retry",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
          if (sessionId === "worker1") throw new Error("worker1 unavailable");
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
      undefined,
      0,
    );
    await orchestrator.start(failRoom, "任务");
    const plan = `\`\`\`json\n{"tasks":[{"id":"t1","to":"worker1","task":"先失败"},{"id":"t2","to":"worker2","task":"依赖 t1","dependsOn":["t1"]}]}\n\`\`\``;
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (prompts.filter((p) => p.sessionId === "worker1").length >= 3) break;
    }

    assert.equal(prompts.filter((p) => p.sessionId === "worker1").length, 3);
    assert.equal(prompts.filter((p) => p.sessionId === "worker2").length, 0);

    const flow = orchestrator.getFlow(failRoom.roomId);
    assert.ok(flow);
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "failed");
    assert.equal(tasks.find((t) => t.id === "t2")?.status, "pending");
  });

  it("链式依赖：t1 failed 后 t2 和 t3 都保持 pending", async () => {
    const rooms = new RoomManager();
    const chainRoom = rooms.create(
      "chain-fail",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
        { sessionId: "worker3", name: "c" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
          if (sessionId === "worker1") throw new Error("worker1 unavailable");
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
      undefined,
      0,
    );
    await orchestrator.start(chainRoom, "任务");
    const plan = `\`\`\`json\n{"tasks":[{"id":"t1","to":"worker1","task":"先失败"},{"id":"t2","to":"worker2","task":"依赖 t1","dependsOn":["t1"]},{"id":"t3","to":"worker3","task":"依赖 t2","dependsOn":["t2"]}]}\n\`\`\``;
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (prompts.filter((p) => p.sessionId === "worker1").length >= 3) break;
    }

    assert.equal(prompts.filter((p) => p.sessionId === "worker1").length, 3);
    assert.equal(prompts.filter((p) => p.sessionId === "worker2").length, 0);
    assert.equal(prompts.filter((p) => p.sessionId === "worker3").length, 0);

    const flow = orchestrator.getFlow(chainRoom.roomId);
    assert.ok(flow);
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "failed");
    assert.equal(tasks.find((t) => t.id === "t2")?.status, "pending");
    assert.equal(tasks.find((t) => t.id === "t3")?.status, "pending");
  });

  it("空任务计划把指挥家的直接回答展示给用户", async () => {
    const rooms = new RoomManager();
    const conductorRoom = rooms.create(
      "direct-answer",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      (notice) => notices.push(notice.message),
    );
    await orchestrator.start(conductorRoom, "简单问题");
    await orchestrator.onPromptDone(
      "conductor",
      "这个问题不需要派工，答案是 42。\n```json\n{\"tasks\":[]}\n```",
    );
    assert.equal(orchestrator.hasActiveFlow(conductorRoom.roomId), false);
    assert.equal(notices.at(-1), "这个问题不需要派工，答案是 42。");
  });

  it("部分失败时降级汇总：有 done 任务时进入 summarize 而非直接结束", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "partial-fail",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const conductorPrompts: string[] = [];
    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          if (sessionId === "conductor") conductorPrompts.push(String(content));
          if (sessionId === "worker2") throw new Error("worker2 unavailable");
        },
        isBusy: () => false,
      },
      rooms,
      (n) => notices.push(n.message),
      undefined,
      0,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改前端"},{"id":"t2","to":"worker2","task":"改后端"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const w1Output = '```json\n{"text":"前端改好了","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", w1Output);

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1));
      const flow = orchestrator.getFlow(qRoom.roomId);
      if (!flow) break;
      const t2 = (flow.tasks as { id: string; status: string }[]).find((t) => t.id === "t2");
      if (t2?.status === "failed" && (flow as { phase: string }).phase === "summarizing") break;
    }

    assert.ok(
      notices.some((m) => m.includes("降级汇总")),
      "should notify partial summary",
    );
    assert.ok(
      !notices.some((m) => m.includes("所有子任务均失败")),
      "should not report all-failed when some tasks done",
    );

    const flow = orchestrator.getFlow(qRoom.roomId);
    assert.ok(flow);
    assert.equal((flow as { phase: string }).phase, "summarizing");

    const summaryPrompt = conductorPrompts.find((p) => p.includes("部分完成、部分失败"));
    assert.ok(summaryPrompt, "conductor should receive partial-failure prompt");
    assert.ok(summaryPrompt!.includes("未能完成"), "prompt should mention failed tasks");
    assert.ok(summaryPrompt!.includes("建议用户是否需要重新派发"), "prompt should suggest retry");
  });

  it("全部失败时不汇总，直接通知并结束 flow", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "all-fail",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const conductorPrompts: string[] = [];

    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          if (sessionId === "conductor") conductorPrompts.push(String(content));
          else throw new Error("worker unavailable");
        },
        isBusy: () => false,
      },
      rooms,
      (n) => notices.push(n.message),
      undefined,
      0,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改前端"},{"id":"t2","to":"worker2","task":"改后端"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (!orchestrator.getFlow(qRoom.roomId)) break;
    }

    assert.ok(
      notices.some((m) => m.includes("所有子任务均失败")),
      "should notify all-failed",
    );
    assert.equal(orchestrator.getFlow(qRoom.roomId), undefined, "flow should be cleaned up");
    assert.ok(
      !conductorPrompts.some((p) => p.includes("汇总")),
      "should not summarize when all tasks failed",
    );
  });

  it("降级汇总后进入 awaiting-retry，重试指令恢复 failed 任务", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "retry-test",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const conductorPrompts: string[] = [];
    const workerPrompts: { sessionId: string; content: string }[] = [];
    let failWorker2 = true;

    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          if (sessionId === "conductor") {
            conductorPrompts.push(String(content));
            return;
          }
          workerPrompts.push({ sessionId, content: String(content) });
          if (sessionId === "worker2" && failWorker2) throw new Error("worker2 unavailable");
        },
        isBusy: () => false,
      },
      rooms,
      (n) => notices.push(n.message),
      undefined,
      0,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改前端"},{"id":"t2","to":"worker2","task":"改后端"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const w1Output = '```json\n{"text":"前端改好了","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", w1Output);

    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (notices.some((m) => m.includes("降级汇总"))) break;
    }
    assert.ok(notices.some((m) => m.includes("降级汇总")), "should enter partial summary");

    await orchestrator.onPromptDone("conductor", "汇总完成，t2 失败");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    assert.ok(orchestrator.hasAwaitingRetry(qRoom.roomId), "should be awaiting-retry");
    assert.ok(
      notices.some((m) => m.includes("重试") && m.includes("新消息继续")),
      "should notify retry option",
    );

    failWorker2 = false;
    const retried = orchestrator.retryFailedTasks(qRoom.roomId);
    assert.ok(retried, "retry should succeed");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const flow = orchestrator.getFlow(qRoom.roomId);
    assert.ok(flow);
    assert.equal((flow as { phase: string }).phase, "working");
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "done");
    assert.equal(tasks.find((t) => t.id === "t2")?.status, "running");

    assert.ok(
      workerPrompts.some((p) => p.sessionId === "worker2" && p.content.includes("改后端")),
      "worker2 should receive retry prompt",
    );
  });

  it("awaiting-retry 时指定 task ID 只重试指定任务", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "retry-specific",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
        { sessionId: "worker3", name: "c" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const workerPrompts: { sessionId: string; content: string }[] = [];
    let failWorkers = true;

    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          if (sessionId !== "conductor") {
            workerPrompts.push({ sessionId, content: String(content) });
            if (failWorkers && (sessionId === "worker2" || sessionId === "worker3")) {
              throw new Error("worker unavailable");
            }
          }
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
      undefined,
      0,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"任务一"},{"id":"t2","to":"worker2","task":"任务二"},{"id":"t3","to":"worker3","task":"任务三"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"text":"done","artifacts":[]}\n```',
    );
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1));
      const flow = orchestrator.getFlow(qRoom.roomId);
      if (!flow) break;
      const tasks = flow.tasks as { id: string; status: string }[];
      const allTerminal = ["t2", "t3"].every(
        (id) => tasks.find((t) => t.id === id)?.status === "failed",
      );
      if (allTerminal && (flow as { phase: string }).phase === "summarizing") break;
    }

    await orchestrator.onPromptDone("conductor", "汇总");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    assert.ok(orchestrator.hasAwaitingRetry(qRoom.roomId));

    failWorkers = false;
    workerPrompts.length = 0;
    const retried = orchestrator.retryFailedTasks(qRoom.roomId, ["t3"]);
    assert.ok(retried);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const flow = orchestrator.getFlow(qRoom.roomId);
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "done");
    assert.equal(tasks.find((t) => t.id === "t2")?.status, "failed");
    assert.equal(tasks.find((t) => t.id === "t3")?.status, "running");

    assert.ok(workerPrompts.some((p) => p.sessionId === "worker3"));
    assert.ok(!workerPrompts.some((p) => p.sessionId === "worker2"));
  });

  it("planner prompt 要求输出 goal 与 acceptanceCriteria", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "goal-plan",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "实现登录功能");
    const planner = prompts.find((p) => p.sessionId === "conductor");
    assert.ok(planner);
    assert.ok(planner.content.includes("goal"));
    assert.ok(planner.content.includes("acceptanceCriteria"));
    assert.ok(planner.content.includes("可验证"));
  });

  it("planner 输出的 goal/acceptanceCriteria 会更新 flow", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "goal-update",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "原始需求");
    const plan =
      '```json\n{"goal":"重写后的目标","acceptanceCriteria":["标准A","标准B"],"tasks":[{"id":"t1","to":"worker","task":"做事"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow as { goal: string }).goal, "重写后的目标");
    assert.deepEqual((flow as { acceptanceCriteria: string[] }).acceptanceCriteria, ["标准A", "标准B"]);
    assert.equal((flow as { iteration: number }).iteration, 1);
    assert.equal((flow as { maxIterations: number }).maxIterations, 3);
  });

  it("dependsOn 任务的 prompt 注入前置任务结果", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "dep-handoff",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "任务");
    const plan =
      '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"先做"},{"id":"t2","to":"worker2","task":"再做","dependsOn":["t1"]}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(prompts.filter((p) => p.sessionId === "worker2").length, 0);

    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"text":"T1的结果文本","artifacts":[{"type":"file","path":"src/x.ts","summary":"新增"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    const w2 = prompts.find((p) => p.sessionId === "worker2");
    assert.ok(w2);
    assert.ok(w2.content.includes("前置任务结果"));
    assert.ok(w2.content.includes("T1的结果文本"));
    assert.ok(w2.content.includes("src/x.ts"));
  });

  it("全部 worker 完成后进入 reviewing 而非直接 summarizing", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "review-phase",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      (n) => notices.push(n.message),
    );
    await orchestrator.start(r, "目标X");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"goal":"目标X","acceptanceCriteria":["完成X"],"tasks":[{"id":"t1","to":"worker","task":"做X"}]}\n```',
    );
    await orchestrator.onPromptDone("worker", "完成了 X");
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow as { phase: string }).phase, "reviewing");
    assert.ok(notices.some((m) => m.includes("验收中")));
    const reviewPrompt = prompts.filter((p) => p.sessionId === "conductor").at(-1)!;
    assert.ok(reviewPrompt.content.includes("原始目标"));
    assert.ok(reviewPrompt.content.includes("验收标准"));
    assert.ok(reviewPrompt.content.includes("decision"));
  });

  it("review complete 后进入 summarizing，最终答复后 flow 删除", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "review-complete",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    await orchestrator.onPromptDone("worker", "done");
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "reviewing");

    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"complete","reason":"已满足"}\n```',
    );
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "summarizing");

    await orchestrator.onPromptDone("conductor", "最终答复");
    assert.equal(orchestrator.hasActiveFlow(r.roomId), false);
  });

  it("review continue 追加任务进入下一轮，已完成任务不重跑", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "review-continue",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"做"}]}\n```',
    );
    await orchestrator.onPromptDone("worker1", "done");
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "reviewing");

    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"缺测试","tasks":[{"to":"worker2","task":"补测试","dependsOn":["t1"]}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow as { phase: string }).phase, "working");
    assert.equal((flow as { iteration: number }).iteration, 2);
    const tasks = flow.tasks as { id: string; status: string; iteration: number }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "done");
    const added = tasks.filter((t) => t.iteration === 2);
    assert.equal(added.length, 1);
    assert.equal(added[0]!.status, "running");
    assert.ok(prompts.some((p) => p.sessionId === "worker2" && p.content.includes("补测试")));
    assert.equal(prompts.filter((p) => p.sessionId === "worker1").length, 1);
  });

  it("达到迭代上限仍 continue 时直接 summarizing，不再派工", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "review-max",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    await orchestrator.onPromptDone("worker", "done1");
    // 第 1 轮验收 -> continue
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"还差","tasks":[{"id":"r2","to":"worker","task":"补1"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await orchestrator.onPromptDone("worker", "done2");
    // 第 2 轮验收 -> continue
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"还差","tasks":[{"id":"r3","to":"worker","task":"补2"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal((orchestrator.getFlow(r.roomId) as { iteration: number }).iteration, 3);
    await orchestrator.onPromptDone("worker", "done3");
    // 第 3 轮验收仍 continue -> 达到上限，直接汇总
    const workerPromptsBefore = prompts.filter((p) => p.sessionId === "worker").length;
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"还差","tasks":[{"id":"r4","to":"worker","task":"补3"}]}\n```',
    );
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "summarizing");
    assert.equal(
      prompts.filter((p) => p.sessionId === "worker").length,
      workerPromptsBefore,
      "should not dispatch a 4th round",
    );
    await orchestrator.onPromptDone("conductor", "最终答复");
    assert.equal(orchestrator.hasActiveFlow(r.roomId), false);
  });

  it("export/import 保留 goal/criteria/iteration 并可恢复 reviewing", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "export-flow",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标G");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"goal":"目标G","acceptanceCriteria":["标准1"],"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    await orchestrator.onPromptDone("worker", "done");
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "reviewing");

    const state = orchestrator.export();
    const flows = state.flows as Record<string, unknown>[];
    assert.equal(flows[0]!.goal, "目标G");
    assert.deepEqual(flows[0]!.acceptanceCriteria, ["标准1"]);
    assert.equal(flows[0]!.phase, "reviewing");

    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator2 = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator2.import(state);
    const restored = orchestrator2.getFlow(r.roomId)!;
    assert.equal((restored as { goal: string }).goal, "目标G");
    assert.deepEqual((restored as { acceptanceCriteria: string[] }).acceptanceCriteria, ["标准1"]);
    assert.equal((restored as { phase: string }).phase, "reviewing");
    assert.ok(
      prompts.some((p) => p.sessionId === "conductor" && p.content.includes("验收标准")),
      "imported reviewing flow should re-send review prompt",
    );
  });

  it("import summarizing flow 会重新发送汇总 prompt", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "import-summary",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.import({
      flows: [
        {
          roomId: r.roomId,
          phase: "summarizing",
          tasks: [
            { id: "t1", sessionId: "worker", task: "做", dependsOn: [], status: "done" },
          ],
          results: { t1: { text: "结果", artifacts: [] } },
        },
      ],
    });
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow as { phase: string }).phase, "summarizing");
    assert.equal((flow as { iteration: number }).iteration, 1);
    assert.ok(
      prompts.some((p) => p.sessionId === "conductor" && p.content.includes("汇总") || p.sessionId === "conductor" && p.content.includes("原始目标")),
      "imported summarizing flow should re-send summarize prompt",
    );
  });

  it("conductor 忙碌时 resumeFlows 不重复发送 review/summarize prompt", async () => {
    for (const phase of ["reviewing", "summarizing"] as const) {
      const rooms = new RoomManager();
      const r = rooms.create(
        `busy-${phase}`,
        [
          { sessionId: "conductor", name: "leader" },
          { sessionId: "worker", name: "coder" },
        ],
        "conductor",
        { conductorId: "conductor" },
      );
      const prompts: { sessionId: string; content: string }[] = [];
      const notices: string[] = [];
      let flowUpdates = 0;
      const orchestrator = new ConductorOrchestrator(
        {
          prompt: async (sessionId, content) => {
            prompts.push({ sessionId, content: String(content) });
          },
          isBusy: () => true,
        },
        rooms,
        (n) => notices.push(n.message),
        () => flowUpdates++,
      );
      await orchestrator.import({
        flows: [
          {
            roomId: r.roomId,
            phase,
            tasks: [
              { id: "t1", sessionId: "worker", task: "做", dependsOn: [], status: "done" },
            ],
            results: { t1: { text: "结果", artifacts: [] } },
          },
        ],
      });
      assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, phase);
      prompts.length = 0;
      notices.length = 0;
      flowUpdates = 0;
      orchestrator.resumeFlows();
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      assert.equal(
        prompts.filter((p) => p.sessionId === "conductor").length,
        0,
        `busy conductor should not get a duplicate ${phase} prompt`,
      );
      assert.equal(notices.length, 0, `busy ${phase} should not emit new notices`);
      assert.equal(flowUpdates, 0, `busy ${phase} should not emit flow updates`);
      assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, phase);
    }
  });

  it("超长 worker 结果在 review prompt 中被截断", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "long-result",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    const tailMarker = "TAIL_MARKER_NEVER_IN_PROMPT";
    await orchestrator.onPromptDone(
      "worker",
      `\`\`\`json\n${JSON.stringify({ text: "结果".repeat(3000) + tailMarker, artifacts: [] })}\n\`\`\``,
    );
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "reviewing");
    const reviewPrompt = prompts.filter((p) => p.sessionId === "conductor").at(-1)!;
    assert.ok(reviewPrompt.content.includes("验收标准"));
    assert.ok(!reviewPrompt.content.includes(tailMarker), "tail of long result must be truncated");
  });

  it("review continue 只含空 task 时不增加 iteration，直接 summarizing", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "empty-continue",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    await orchestrator.onPromptDone("worker", "done");
    assert.equal((orchestrator.getFlow(r.roomId) as { phase: string }).phase, "reviewing");

    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"勉强算缺","tasks":[{"to":"worker","task":"   "}]}\n```',
    );
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow as { iteration: number }).iteration, 1);
    assert.equal((flow as { phase: string }).phase, "summarizing");
    assert.equal((flow.tasks as { status: string }[]).length, 1);
  });

  it("acceptanceCriteria 中的非字符串项被忽略", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "bad-criteria",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );
    await orchestrator.start(r, "目标");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"acceptanceCriteria":["标准A",{"x":1},42,null,"  "],"tasks":[{"id":"t1","to":"worker","task":"做"}]}\n```',
    );
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.deepEqual((flow as { acceptanceCriteria: string[] }).acceptanceCriteria, ["标准A"]);
  });

  it("非 awaiting-retry 状态调用 retryFailedTasks 返回 false", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "no-retry",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );

    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
    );

    assert.equal(orchestrator.retryFailedTasks(qRoom.roomId), false);
    assert.equal(orchestrator.hasAwaitingRetry(qRoom.roomId), false);
  });

});
