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

  it("Q1-03: 写任务接入 QualityRun，accepted 前不标记 done", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "quality-room",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const terminalCallbacks = new Map<string, (accepted: boolean) => void>();
    const startedRuns: { runId: string; taskId: string; sessionId: string }[] = [];

    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        const runId = `qrun-${opts.taskId}`;
        startedRuns.push({ runId, taskId: opts.taskId, sessionId: opts.sessionId });
        return runId;
      },
      onRunTerminal(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
      recoverRun(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
    };

    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "写任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"写文件"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const workerOutput = '已完成\n```json\n{"text":"done","artifacts":[{"type":"file","path":"src/foo.ts","summary":"新增"}]}\n```';
    await orchestrator.onPromptDone("worker1", workerOutput);

    const flow = orchestrator.getFlow(qRoom.roomId);
    assert.ok(flow);
    const tasks = flow!.tasks as { id: string; status: string; qualityRunId?: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "verifying");
    assert.equal(tasks.find((t) => t.id === "t1")?.qualityRunId, "qrun-t1");
    assert.equal(startedRuns.length, 1);
    assert.equal(startedRuns[0]!.taskId, "t1");

    assert.equal(orchestrator.hasActiveFlow(qRoom.roomId), true);

    terminalCallbacks.get("qrun-t1")!(true);

    const flow2 = orchestrator.getFlow(qRoom.roomId);
    const tasks2 = flow2!.tasks as { id: string; status: string }[];
    assert.equal(tasks2.find((t) => t.id === "t1")?.status, "done");
  });

  it("Q1-03: 质量验证失败后任务标记 failed，下游不继续", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "quality-fail",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const terminalCallbacks = new Map<string, (accepted: boolean) => void>();

    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        return `qrun-${opts.taskId}`;
      },
      onRunTerminal(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
      recoverRun(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
    };

    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async () => {},
        isBusy: () => false,
      },
      rooms,
      () => {},
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "写任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"写文件"},{"id":"t2","to":"worker2","task":"依赖 t1","dependsOn":["t1"]}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const workerOutput = '已完成\n```json\n{"text":"done","artifacts":[{"type":"file","path":"src/foo.ts","summary":"新增"}]}\n```';
    await orchestrator.onPromptDone("worker1", workerOutput);

    const flow = orchestrator.getFlow(qRoom.roomId);
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "verifying");
    assert.equal(tasks.find((t) => t.id === "t2")?.status, "pending");

    terminalCallbacks.get("qrun-t1")!(false);

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const flow2 = orchestrator.getFlow(qRoom.roomId);
    assert.equal(flow2, undefined, "flow should be cleaned up after dependency failure cascade");
  });

  it("report 模式下质量未通过仍完成任务，但不能提示为验证通过", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "quality-report",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const terminalCallbacks = new Map<string, (accepted: boolean) => void>();
    const notices: string[] = [];
    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask: () => "qrun-t1",
      onRunTerminal(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
      recoverRun() {},
      getRunEnforcement: () => "report",
    };
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      (n) => notices.push(n.message),
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "任务", [{ id: "t1", to: "worker1", task: "改文件" }]);
    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"text":"done","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```',
    );
    terminalCallbacks.get("qrun-t1")!(false);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const flow = orchestrator.getFlow(qRoom.roomId)!;
    const task = (flow.tasks as { id: string; status: string }[]).find((t) => t.id === "t1");
    assert.equal(task?.status, "done");
    assert.ok(notices.some((m) => m.includes("仅报告")));
    assert.ok(!notices.some((m) => m.includes("质量验证通过")));
  });

  it("Q1-03: 无文件 artifact 时不启动质量验证，直接 done", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "quality-nochange",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    let runStarted = false;

    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask() {
        runStarted = true;
        return "qrun-x";
      },
      onRunTerminal() {},
      recoverRun() {},
    };

    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async () => {},
        isBusy: () => false,
      },
      rooms,
      () => {},
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "分析任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"分析代码"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const workerOutput = '```json\n{"text":"分析完成","artifacts":[]}\n```';
    await orchestrator.onPromptDone("worker1", workerOutput);

    assert.equal(runStarted, false);
    const flow = orchestrator.getFlow(qRoom.roomId);
    const tasks = flow!.tasks as { id: string; status: string }[];
    assert.equal(tasks.find((t) => t.id === "t1")?.status, "done");
  });

  it("Q2-01: 重启恢复 verifying task 时重新注册回调，run 已终态则直接推进", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "test",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );

    const terminalCallbacks = new Map<string, (accepted: boolean) => void>();
    const runStates = new Map<string, "running" | "accepted" | "failed">();
    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        return `qrun-${opts.taskId}`;
      },
      onRunTerminal(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
      recoverRun(runId, cb) {
        const state = runStates.get(runId);
        if (state === "accepted") cb(true);
        else if (state === "failed") cb(false);
        else terminalCallbacks.set(runId, cb);
      },
    };

    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改文件"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const workerOutput = '```json\n{"text":"done","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", workerOutput);

    const flowBefore = orchestrator.getFlow(qRoom.roomId);
    const t1Before = (flowBefore!.tasks as { id: string; status: string; qualityRunId?: string }[]).find((t) => t.id === "t1");
    assert.equal(t1Before?.status, "verifying");
    assert.ok(t1Before?.qualityRunId);

    const exported = orchestrator.export();
    orchestrator.cancel(qRoom.roomId);
    assert.equal(orchestrator.hasActiveFlow(qRoom.roomId), false);

    runStates.set(t1Before!.qualityRunId!, "accepted");
    await orchestrator.import(exported);

    const flowAfter = orchestrator.getFlow(qRoom.roomId);
    const t1After = (flowAfter!.tasks as { id: string; status: string }[]).find((t) => t.id === "t1");
    assert.equal(t1After?.status, "done");
  });

  it("Q2-02: 重启恢复 verifying task，run 仍在跑时保留 verifying 并等待回调", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "test",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );

    const terminalCallbacks = new Map<string, (accepted: boolean) => void>();
    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        return `qrun-${opts.taskId}`;
      },
      onRunTerminal(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
      recoverRun(runId, cb) {
        terminalCallbacks.set(runId, cb);
      },
    };

    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改文件"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const workerOutput = '```json\n{"text":"done","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", workerOutput);

    const exported = orchestrator.export();
    orchestrator.cancel(qRoom.roomId);

    await orchestrator.import(exported);
    const flowAfter = orchestrator.getFlow(qRoom.roomId);
    const t1 = (flowAfter!.tasks as { id: string; status: string; qualityRunId?: string }[]).find((t) => t.id === "t1");
    assert.equal(t1?.status, "verifying");

    const cb = terminalCallbacks.get(t1!.qualityRunId!);
    assert.ok(cb, "recoverRun should have registered callback");
    cb!(true);
    await new Promise((r) => setImmediate(r));

    const flowFinal = orchestrator.getFlow(qRoom.roomId);
    const t1Final = (flowFinal!.tasks as { id: string; status: string }[]).find((t) => t.id === "t1");
    assert.equal(t1Final?.status, "done");
  });

  it("Q2-03: scheduleTasks 中有 verifying task 时，hasFailed 不会立即报失败", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "test",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );

    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        return `qrun-${opts.taskId}`;
      },
      onRunTerminal(runId, cb) {
        // t2 的 run 立即 reject
        if (runId === "qrun-t2") cb(false);
      },
      recoverRun() {},
    };

    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      (n) => notices.push(n.message),
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改文件"},{"id":"t2","to":"worker2","task":"独立任务"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // t1 提交质量验证 → verifying
    const w1Output = '```json\n{"text":"done","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", w1Output);

    // t2 也提交 file artifact → 触发 quality run → onRunTerminal 立即 reject → failed
    const w2Output = '```json\n{"text":"done","artifacts":[{"type":"file","path":"/b.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker2", w2Output);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const flow = orchestrator.getFlow(qRoom.roomId);
    const t1 = (flow!.tasks as { id: string; status: string }[]).find((t) => t.id === "t1");
    const t2 = (flow!.tasks as { id: string; status: string }[]).find((t) => t.id === "t2");
    assert.equal(t1?.status, "verifying");
    assert.equal(t2?.status, "failed");

    // 不应出现"指挥家无法进行汇总"通知，因为 t1 还在 verifying
    assert.ok(
      !notices.some((m) => m.includes("无法进行汇总")),
      "should not report failure summary while verifying tasks exist",
    );
  });

  it("Q2-04: awaitingApproval 期间 verifying 超时检查被跳过", async () => {
    const rooms = new RoomManager();
    const qRoom = rooms.create(
      "test",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );

    const qualityIntegration: import("./conductor.js").QualityIntegration = {
      startRunForTask(opts) {
        return `qrun-${opts.taskId}`;
      },
      onRunTerminal() {},
      recoverRun() {},
    };

    const notices: string[] = [];
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      (n) => notices.push(n.message),
      qualityIntegration,
    );

    await orchestrator.start(qRoom, "任务");
    const plan = '```json\n{"tasks":[{"id":"t1","to":"worker1","task":"改文件"}]}\n```';
    await orchestrator.onPromptDone("conductor", plan);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const w1Output = '```json\n{"text":"done","artifacts":[{"type":"file","path":"/a.ts","summary":"改"}]}\n```';
    await orchestrator.onPromptDone("worker1", w1Output);

    const flow = orchestrator.getFlow(qRoom.roomId);
    const t1 = (flow!.tasks as { id: string; status: string; qualityRunId?: string }[]).find((t) => t.id === "t1");
    assert.equal(t1?.status, "verifying");
    assert.ok(t1?.qualityRunId);

    // 模拟 run 进入 awaiting-approval
    orchestrator.notifyAwaitingApproval(t1!.qualityRunId!);

    // 手动把 verifyingSince 设为很久以前，模拟超时
    const flowInternal = orchestrator.getFlow(qRoom.roomId);
    const tasks = flowInternal!.tasks as unknown as Array<{ id: string; status: string; verifyingSince: number; awaitingApproval: boolean }>;
    const t1Internal = tasks.find((t) => t.id === "t1")!;
    t1Internal.verifyingSince = Date.now() - 10 * 60 * 1000; // 10 分钟前

    // 触发 scheduleTasks（通过 cancel + import 重新触发）
    const exported = orchestrator.export();
    orchestrator.cancel(qRoom.roomId);
    await orchestrator.import(exported);

    // 不应出现超时通知
    assert.ok(
      !notices.some((m) => m.includes("质量验证超时")),
      "should not timeout while awaitingApproval is true",
    );

    const flowAfter = orchestrator.getFlow(qRoom.roomId);
    const t1After = (flowAfter!.tasks as { id: string; status: string }[]).find((t) => t.id === "t1");
    assert.equal(t1After?.status, "verifying");
  });

});
