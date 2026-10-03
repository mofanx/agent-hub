import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ConductorOrchestrator,
  parseTasks,
  extractTaskResult,
  extractHelpRequest,
  runIsolatedCheck,
  parseIsolatedChecks,
  workspaceSnapshotHash,
} from "./conductor.js";
import { createPromptDoneParams, promptDoneInternalOutput, toPublicHubEvent } from "./agent.js";
import { RoomManager, type Room } from "./room.js";

describe("conductor", () => {
  it("parseIsolatedChecks 边界：非法输入整体 fail closed，合法配置规范存储", () => {
    assert.deepEqual(parseIsolatedChecks(undefined), {});
    assert.deepEqual(parseIsolatedChecks(""), {});
    assert.deepEqual(parseIsolatedChecks("   "), {});
    assert.deepEqual(parseIsolatedChecks("not json"), {});
    assert.deepEqual(parseIsolatedChecks('["npm test"]'), {});
    assert.deepEqual(parseIsolatedChecks('"npm test"'), {});
    assert.deepEqual(parseIsolatedChecks("null"), {});
    assert.deepEqual(
      parseIsolatedChecks('{"unit":"npm test","lint":"npm run lint"}'),
      { unit: "npm test", lint: "npm run lint" },
    );
    assert.deepEqual(parseIsolatedChecks('{"u":"  npm test  "}'), { u: "npm test" });
    assert.deepEqual(
      parseIsolatedChecks('{"Bad":"x","ok":"y"}'),
      {},
      "任一非法键必须整份拒绝",
    );
    assert.deepEqual(parseIsolatedChecks('{"1bad":"x"}'), {});
    assert.deepEqual(parseIsolatedChecks('{"a b":"x"}'), {});
    assert.deepEqual(parseIsolatedChecks(`{"${"a".repeat(65)}":"x"}`), {});
    assert.deepEqual(
      parseIsolatedChecks('{"u":"echo a\\necho b"}'),
      {},
      "命令含换行必须整份拒绝",
    );
    assert.deepEqual(parseIsolatedChecks(`{"u":"${"x".repeat(257)}"}`), {});
    assert.deepEqual(parseIsolatedChecks('{"u":"   "}'), {});
    assert.deepEqual(
      parseIsolatedChecks('{"u":123,"v":"npm test"}'),
      {},
      "任一非法值必须整份拒绝",
    );
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`k${i}`, "npm test"]),
    );
    assert.deepEqual(
      parseIsolatedChecks(JSON.stringify(many)),
      {},
      "超过 32 项必须整份拒绝",
    );
    const proto = parseIsolatedChecks('{"__proto__":{"p":1},"u":"npm test"}');
    assert.deepEqual(proto, {}, "原型键必须整份拒绝");
    assert.equal(
      ({} as Record<string, unknown>).p,
      undefined,
      "解析不得造成原型污染",
    );
    const own = parseIsolatedChecks('{"constructor":"npm test"}');
    assert.equal(own["constructor"], "npm test", "合法自有键应正常存储");
    assert.ok(Object.hasOwn(own, "constructor"));
  });

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
      if ((orchestrator.getFlow(qRoom.roomId) as { phase?: string } | undefined)?.phase === "done") break;
    }

    assert.ok(
      notices.some((m) => m.includes("所有子任务均失败")),
      "should notify all-failed",
    );
    const terminal = orchestrator.getFlow(qRoom.roomId) as { phase: string } | undefined;
    assert.equal(terminal?.phase, "done", "all-failed flow should stay as done evidence");
    assert.equal(orchestrator.hasActiveFlow(qRoom.roomId), false);
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

  it("review complete 后进入 summarizing，最终答复后保留 flow", async () => {
    const prompts: string[] = [];
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
      { prompt: async (_sessionId, content) => { if (typeof content === "string") prompts.push(content); }, isBusy: () => false },
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
    assert.match(prompts.at(-1)!, /先给结论.*待确认.*实际复核/);
    assert.match(prompts.at(-1)!, /未运行或受阻的检查如实说明/);

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
    const injected = (
      orchestrator.getFlow(r.roomId)!.tasks as { id: string; status: string }[]
    ).find((t) => t.id.startsWith("peer-review"));
    assert.ok(injected, "存在未参与成员时应先注入一次独立复核");
    await orchestrator.onPromptDone("worker2", "复核完成");
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

  it("import 恢复：中断的 running 任务标 failed 暂停，仅显式重试才派发", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "resume-unknown",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
        { sessionId: "w2", name: "w2" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const notices: string[] = [];
    const mk = () =>
      new ConductorOrchestrator(
        {
          prompt: async (sessionId, content) => {
            prompts.push({ sessionId, content: String(content) });
          },
          isBusy: () => false,
        },
        rooms,
        (n) => notices.push(n.message),
      );
    const orchestrator = mk();
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"},{"id":"t2","to":"w2","task":"B","dependsOn":["t1"]}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    const w1Before = prompts.filter((p) => p.sessionId === "w1").length;
    assert.equal(w1Before, 1, "t1 应已派发一次");
    orchestrator.observeToolUpdate("w1", {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      kind: "execute",
      rawInput: { command: "npm test" },
    });
    orchestrator.observeToolUpdate("w1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    const state = orchestrator.export();
    const orchestrator2 = mk();
    await orchestrator2.import(state);
    const flow = orchestrator2.getFlow(r.roomId) as {
      phase: string;
      tasks: { id: string; status: string; failureMessage?: string }[];
    };
    assert.equal(flow.phase, "awaiting-retry", "中断运行应暂停整个 flow");
    const t1 = flow.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.status, "failed");
    assert.equal(t1.failureMessage, "Hub 重启时执行状态未知，请检查工作区后重试");
    assert.equal(
      flow.tasks.find((t) => t.id === "t2")!.status,
      "pending",
      "下游任务保持 pending 而非误标失败",
    );
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      w1Before,
      "恢复不得重复派发 worker",
    );
    assert.ok(
      notices.some(
        (m) =>
          m ===
          "Hub 重启时任务执行状态未知：任务 t1 已暂停，检查工作区后发送“重试”再派发；未自动重复执行。",
      ),
      "应发出精确的暂停通知",
    );
    orchestrator2.resumeFlows();
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      w1Before,
      "resumeFlows 不得派发 awaiting-retry flow",
    );
    assert.equal(orchestrator2.retryFailedTasks(r.roomId, ["t1"]), true);
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      w1Before + 1,
      "显式重试恰好重派一次",
    );
    const t1b = (
      orchestrator2.getFlow(r.roomId) as {
        tasks: {
          id: string;
          status: string;
          backendRuns?: unknown[];
          automaticCheck?: { status: string };
        }[];
      }
    ).tasks.find((t) => t.id === "t1")!;
    assert.equal(t1b.status, "running");
    assert.equal(t1b.backendRuns, undefined, "重派应清除旧 backendRuns");
    assert.equal(t1b.automaticCheck?.status, "not_run", "重派应清除旧 automaticCheck");
    await orchestrator2.onPromptDone(
      "w1",
      '```json\n{"text":"done","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "w2").length,
      1,
      "worker 完成后触发下游派发",
    );
    orchestrator2.resumeFlows();
    orchestrator2.resumeFlows();
    assert.equal(
      prompts.filter((p) => p.sessionId === "w2").length,
      1,
      "反复 resume 不得额外派发",
    );
  });

  it("import 恢复：等待用户求助的任务不失败不重派，定向答复唤醒一次", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "resume-help",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
        { sessionId: "w2", name: "w2" },
        { sessionId: "w3", name: "w3" },
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
          phase: "working",
          tasks: [
            { id: "t1", sessionId: "w1", task: "A", dependsOn: [], status: "done" },
            { id: "t2", sessionId: "w2", task: "B", dependsOn: [], status: "running" },
            { id: "t3", sessionId: "w3", task: "C", dependsOn: [], status: "running" },
          ],
          help: [
            {
              id: "h1",
              taskId: "t2",
              from: "w2",
              to: "user",
              question: "需要参数",
              status: "pending",
            },
          ],
          results: {
            t1: {
              text: "结果A",
              artifacts: [{ type: "file", path: "a.ts", summary: "x" }],
              verifyCommand: "npm test",
              verifyExitCode: 0,
            },
          },
        },
      ],
    });
    const flow = orchestrator.getFlow(r.roomId) as {
      phase: string;
      tasks: {
        id: string;
        status: string;
        failureMessage?: string;
        waitingHelpId?: string;
        verifyCommand?: string;
        verifyExitCode?: number;
      }[];
    };
    assert.equal(flow.phase, "working", "存在挂起求助时流程保持 working");
    const t1 = flow.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.status, "done");
    assert.equal(t1.verifyCommand, "npm test", "已完成任务证据保留");
    assert.equal(t1.verifyExitCode, 0);
    const t2 = flow.tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.status, "running", "等待用户答复的任务保持挂起");
    assert.equal(t2.waitingHelpId, "h1");
    const t3 = flow.tasks.find((t) => t.id === "t3")!;
    assert.equal(t3.status, "failed", "无挂起求助的不确定 running 标 failed");
    assert.equal(t3.failureMessage, "Hub 重启时执行状态未知，请检查工作区后重试");
    assert.equal(
      prompts.filter((p) => p.sessionId === "w2").length,
      0,
      "等待中的 worker 不得重复收到任务提示",
    );
    assert.equal(
      prompts.filter((p) => p.sessionId === "w3").length,
      0,
      "中断任务不得自动重派",
    );
    assert.deepEqual(
      orchestrator.pendingUserHelps(r.roomId).map((p) => p.id),
      ["h1"],
      "用户求助保持待答复",
    );
    assert.equal(
      orchestrator.addSupplement(r.roomId, "随便聊聊"),
      true,
      "普通补充消息并入流程但不消费求助",
    );
    assert.equal(
      orchestrator.pendingUserHelps(r.roomId).length,
      1,
      "补充消息不得消耗求助",
    );
    assert.deepEqual(orchestrator.answerUserHelp(r.roomId, "参数是 42", "h1"), ["w2"]);
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    const w2Prompts = prompts.filter((p) => p.sessionId === "w2");
    assert.equal(w2Prompts.length, 1, "定向答复只唤醒一次");
    assert.ok(w2Prompts[0]!.content.includes("参数是 42"), "答复内容注入唤醒 prompt");
    assert.equal(orchestrator.pendingUserHelps(r.roomId).length, 0);
    orchestrator.resumeFlows();
    assert.equal(
      prompts.filter((p) => p.sessionId === "w2").length,
      1,
      "resume 不得重复唤醒",
    );
  });

  it("import 恢复：planning 流程仅由 resumeFlows 重发一次规划 prompt", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "resume-plan",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
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
    await orchestrator.import({
      flows: [{ roomId: r.roomId, phase: "planning", goal: "实现排序", tasks: [] }],
    });
    assert.equal(
      prompts.filter((p) => p.sessionId === "conductor").length,
      0,
      "import 不得立即向未连接后端发规划 prompt",
    );
    assert.ok(
      notices.some((m) => m === "已恢复待规划任务，连接指挥家后继续规划。"),
      "应发出待规划恢复通知",
    );
    orchestrator.resumeFlows();
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "conductor").length,
      1,
      "resumeFlows 重发一次规划 prompt",
    );
    assert.ok(
      notices.some((m) => m === "指挥家拆解任务中…"),
      "重发规划沿用现有进行通知",
    );
    assert.match(
      prompts.filter((p) => p.sessionId === "conductor").at(-1)!.content,
      /指挥家/,
    );
    orchestrator.resumeFlows();
    orchestrator.resumeFlows();
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "conductor").length,
      1,
      "in-flight 期间重复 resume 不得重发",
    );
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      1,
      "规划完成后派发 worker 恰好一次",
    );
    orchestrator.resumeFlows();
    assert.equal(
      prompts.filter((p) => p.sessionId === "conductor").length,
      1,
      "phase 离开 planning 后不再发规划 prompt",
    );
  });

  it("planning 门控竞态：start 在途时 resumeFlows 不重复发，旧 flow 失败不拖新 flow", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "plan-race",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const deferred: { resolve: () => void; reject: (e: Error) => void }[] = [];
    const orchestrator = new ConductorOrchestrator(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content: String(content) });
          await new Promise<void>((res, rej) =>
            deferred.push({ resolve: res, reject: rej }),
          );
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    const conductorPrompts = () =>
      prompts.filter((p) => p.sessionId === "conductor").length;
    const p1 = orchestrator.start(r, "任务A");
    assert.equal(conductorPrompts(), 1, "start 发出一次规划 prompt");
    orchestrator.resumeFlows();
    orchestrator.resumeFlows();
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      conductorPrompts(),
      1,
      "原始规划在途时 resumeFlows 不得重复发送",
    );
    const p2 = orchestrator.start(r, "任务B");
    assert.equal(conductorPrompts(), 2, "替换 flow 发出新规划 prompt");
    deferred[0]!.reject(new Error("old stream died"));
    await assert.rejects(p1, /old stream died/, "原 start 错误应传播");
    orchestrator.resumeFlows();
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      conductorPrompts(),
      2,
      "旧 flow 的 prompt 失败不得解锁或重发新规划",
    );
    deferred[1]!.resolve();
    await p2;
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      1,
      "新规划完成后派发 worker 恰好一次",
    );
  });

  it("import 恢复：awaiting-retry 流程再次恢复保持暂停且通知不误导", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "resume-paused",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: { sessionId: string; content: string }[] = [];
    const notices: string[] = [];
    const mk = () =>
      new ConductorOrchestrator(
        {
          prompt: async (sessionId, content) => {
            prompts.push({ sessionId, content: String(content) });
          },
          isBusy: () => false,
        },
        rooms,
        (n) => notices.push(n.message),
      );
    const orchestrator = mk();
    await orchestrator.import({
      flows: [
        {
          roomId: r.roomId,
          phase: "working",
          tasks: [
            { id: "t1", sessionId: "w1", task: "A", dependsOn: [], status: "running" },
          ],
        },
      ],
    });
    assert.equal(
      (orchestrator.getFlow(r.roomId) as { phase: string }).phase,
      "awaiting-retry",
    );
    const state = orchestrator.export();
    const orchestrator2 = mk();
    await orchestrator2.import(state);
    assert.equal(
      (orchestrator2.getFlow(r.roomId) as { phase: string }).phase,
      "awaiting-retry",
      "连续 export/import 后仍保持暂停",
    );
    assert.ok(
      notices.some(
        (m) =>
          m === "已恢复暂停中的流程：存在待重试任务，检查工作区后发送“重试”再派发。",
      ),
      "已暂停流程的恢复不得宣称继续执行",
    );
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      0,
      "awaiting-retry 恢复不得派发 worker",
    );
    orchestrator2.resumeFlows();
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(prompts.filter((p) => p.sessionId === "w1").length, 0);
    assert.equal(orchestrator2.retryFailedTasks(r.roomId), true);
    for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    assert.equal(
      prompts.filter((p) => p.sessionId === "w1").length,
      1,
      "显式重试恰好派发一次",
    );
  });

  it("import 恢复：blocked 与过期快照的历史检查回执保留且不升级", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "resume-receipt",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "w1", name: "w1" },
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
          phase: "reviewing",
          tasks: [
            {
              id: "t1",
              sessionId: "w1",
              task: "A",
              dependsOn: [],
              status: "done",
              automaticCheck: {
                status: "blocked",
                runner: "bubblewrap",
                reason: "check_unapproved",
                startedAt: 1,
                finishedAt: 2,
              },
            },
            {
              id: "t2",
              sessionId: "w1",
              task: "B",
              dependsOn: [],
              status: "done",
              automaticCheck: {
                status: "exited_zero",
                runner: "bubblewrap",
                commandHash: "a".repeat(64),
                snapshotHash: "c".repeat(64),
                exitCode: 0,
                startedAt: 1,
                finishedAt: 2,
              },
            },
          ],
          results: {
            t1: { text: "r1", artifacts: [] },
            t2: { text: "r2", artifacts: [] },
          },
        },
      ],
    });
    const flow = orchestrator.getFlow(r.roomId) as {
      tasks: {
        id: string;
        status: string;
        verificationStatus?: string;
        automaticCheck?: { status: string; reason?: string; snapshotCurrent?: boolean };
      }[];
    };
    const t1 = flow.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.automaticCheck?.status, "blocked", "blocked 回执原样保留");
    assert.equal(t1.automaticCheck?.reason, "check_unapproved");
    assert.equal(
      t1.automaticCheck?.snapshotCurrent,
      undefined,
      "blocked 无 snapshotCurrent",
    );
    const t2 = flow.tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.automaticCheck?.status, "exited_zero", "原始历史结果不改写");
    assert.equal(
      t2.automaticCheck?.snapshotCurrent,
      false,
      "cwd 不可访问时应标记为无法核对",
    );
    assert.equal(t1.verificationStatus, "unverified");
    assert.equal(t2.verificationStatus, "unverified");
    const reviewPrompt = prompts.filter((p) => p.sessionId === "conductor").at(-1)!;
    assert.ok(
      reviewPrompt.content.includes(
        "当前工作区已变化或无法核对，旧隔离检查仅对应历史快照",
      ),
      "恢复的过期快照应在验收 prompt 附提醒",
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

  it("extractHelpRequest 解析 help 求助块", () => {
    const output = '需要澄清\n```json\n{"help":{"to":"tester","question":"边界怎么定？"}}\n```';
    const req = extractHelpRequest(output);
    assert.equal(req?.to, "tester");
    assert.equal(req?.question, "边界怎么定？");
    assert.equal(extractHelpRequest("没有求助"), undefined);
  });

  it("worker 定向求助成员：挂起任务 → 成员回复 → 唤醒继续", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "help-member",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
        { sessionId: "worker2", name: "b" },
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"实现接口"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // worker1 发起定向求助，任务保持 running 并等待
    const consumed = await orchestrator.onPromptDone(
      "worker1",
      '需要澄清\n```json\n{"help":{"to":"b","question":"验收口径是什么？"}}\n```',
    );
    assert.equal(consumed, r.roomId);
    const flow = orchestrator.getFlow(r.roomId)!;
    const t1 = (flow.tasks as Record<string, unknown>[]).find((t) => t.id === "t1")!;
    assert.equal(t1.status, "running");
    assert.equal(t1.waitingFor, "b");
    const helpPrompt = prompts.find((p) => p.sessionId === "worker2");
    assert.ok(helpPrompt);
    assert.match(helpPrompt!.content, /验收口径是什么/);
    assert.ok(notices.some((m) => m.includes("求助")));

    // worker2 的回复被消费为答案，唤醒 worker1
    await orchestrator.onPromptDone("worker2", "口径：覆盖率 80%");
    const resume = prompts.filter((p) => p.sessionId === "worker1").at(-1)!;
    assert.match(resume.content, /覆盖率 80%/);
    assert.match(resume.content, /实现接口/);

    // worker1 继续并完成任务
    await orchestrator.onPromptDone("worker1", "done");
    const flow2 = orchestrator.getFlow(r.roomId)!;
    const injected = (flow2.tasks as { id: string; status: string }[]).find((t) =>
      t.id.startsWith("peer-review"),
    );
    assert.ok(injected, "未参与成员应收到一次质疑性复核任务");
    await orchestrator.onPromptDone("worker2", "复核完成");
    const flow3 = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow3 as { phase: string }).phase, "reviewing");
    assert.equal(
      (flow3.tasks as { id: string; status: string }[]).find((t) => t.id === "t1")!.status,
      "done",
    );
  });

  it("worker 向用户求助：answerUserHelp 用下一条消息唤醒", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "help-user",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"起服务"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
    );
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.equal((flow.tasks as Record<string, unknown>[])[0]!.waitingFor, "user");
    assert.ok(notices.some((m) => m.includes("向你求助")));
    // 没有成员被派发求助 prompt
    assert.equal(prompts.filter((p) => p.sessionId === "worker1").length, 1);

    const resumed = orchestrator.answerUserHelp(r.roomId, "用 3000");
    assert.deepEqual(resumed, ["worker1"]);
    const last = prompts.filter((p) => p.sessionId === "worker1").at(-1)!;
    assert.match(last.content, /3000/);
    assert.match(last.content, /起服务/);
  });

  it("answerUserHelp 支持 helpId 定向答复；pendingUserHelps 列出待答求助", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "help-target",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker1", name: "a" },
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"起服务"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
    );

    const pending = orchestrator.pendingUserHelps(r.roomId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.taskId, "t1");
    assert.equal(pending[0]!.from, "worker1");
    assert.equal(pending[0]!.question, "端口用哪个？");

    // 不匹配的 helpId 不消费
    assert.deepEqual(orchestrator.answerUserHelp(r.roomId, "x", "nope"), []);
    assert.equal(orchestrator.pendingUserHelps(r.roomId).length, 1);

    // 定向答复命中
    assert.deepEqual(
      orchestrator.answerUserHelp(r.roomId, "用 4000", pending[0]!.id),
      ["worker1"],
    );
    const last = prompts.filter((p) => p.sessionId === "worker1").at(-1)!;
    assert.match(last.content, /4000/);
  });

  it("export/import 恢复后仍可向用户求助任务答复", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "help-restore",
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"起服务"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
    );
    assert.equal(orchestrator.pendingUserHelps(r.roomId).length, 1);

    const state = orchestrator.export();
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
      undefined,
      0,
    );
    await orchestrator2.import(state);
    // 恢复后等待中的用户求助仍在，任务保持挂起
    const restored = orchestrator2.pendingUserHelps(r.roomId);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.question, "端口用哪个？");
    const flow = orchestrator2.getFlow(r.roomId)!;
    assert.equal(
      (flow.tasks as Record<string, unknown>[])[0]!.waitingFor,
      "user",
    );

    assert.deepEqual(orchestrator2.answerUserHelp(r.roomId, "用 4000"), ["worker1"]);
    const last = prompts.filter((p) => p.sessionId === "worker1").at(-1)!;
    assert.match(last.content, /4000/);
  });

  it("addSupplement 注入后续派发与验收 prompt，不中断流程", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "supplement",
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"先做"},{"id":"t2","to":"b","task":"再做","dependsOn":["t1"]}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    assert.equal(orchestrator.addSupplement(r.roomId, "必须兼容 Windows"), true);
    const flow = orchestrator.getFlow(r.roomId)!;
    assert.deepEqual((flow as { supplements?: string[] }).supplements, ["必须兼容 Windows"]);

    await orchestrator.onPromptDone("worker1", "done1");
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    const w2 = prompts.find((p) => p.sessionId === "worker2");
    assert.ok(w2);
    assert.match(w2!.content, /必须兼容 Windows/);

    await orchestrator.onPromptDone("worker2", "done2");
    const reviewPrompt = prompts.filter((p) => p.sessionId === "conductor").at(-1)!;
    assert.match(reviewPrompt.content, /必须兼容 Windows/);
    assert.match(reviewPrompt.content, /验收/);
  });

  it("verify 声明把独立验证记录到被验证任务并进验收 prompt", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "verify-link",
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"实现"},{"id":"t2","to":"b","task":"验证 t1","dependsOn":["t1"]}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"text":"实现完成","artifacts":[]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await orchestrator.onPromptDone(
      "worker2",
      '复现通过\n```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":"npm test 12/12 通过"}]}\n```',
    );

    const flow = orchestrator.getFlow(r.roomId)!;
    const t1 = (flow.tasks as Record<string, unknown>[]).find((t) => t.id === "t1")!;
    const vers = t1.verifications as { by: string; verdict: string; evidence: string }[];
    assert.equal(vers.length, 1);
    assert.equal(vers[0]!.by, "b");
    assert.equal(vers[0]!.verdict, "pass");
    // 事件时间轴记录 test 事件并关联 taskId
    const ev = rooms
      .getEvents(r.roomId)
      .find((e) => e.action === "test" && e.taskId === "t1" && e.author === "worker2");
    assert.ok(ev);
    assert.match(ev!.summary, /pass/);
    // 验收 prompt 展示独立验证
    const reviewPrompt = prompts.filter((p) => p.sessionId === "conductor").at(-1)!;
    assert.match(reviewPrompt.content, /独立验证/);
    assert.match(reviewPrompt.content, /npm test 12\/12 通过/);
  });

  it("自我验证不记录为独立验证", async () => {
    const rooms = new RoomManager();
    const r = rooms.create(
      "verify-self",
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
      undefined,
      0,
    );
    await orchestrator.start(r, "任务");
    await orchestrator.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"id":"t1","to":"a","task":"实现并自验"}]}\n```',
    );
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await orchestrator.onPromptDone(
      "worker1",
      '```json\n{"text":"完成","verify":[{"task":"t1","verdict":"pass","evidence":"自测"}]}\n```',
    );
    const flow = orchestrator.getFlow(r.roomId)!;
    const t1 = (flow.tasks as Record<string, unknown>[]).find((t) => t.id === "t1")!;
    assert.equal(t1.verifications, undefined);
  });

  it("同一 session 在多个 flow 均有运行中任务时拒绝工具回传归属", async () => {
    const rooms = new RoomManager();
    const members = [
      { sessionId: "conductor", name: "leader" },
      { sessionId: "worker", name: "coder" },
    ];
    const r1 = rooms.create("amb-a", members, "conductor", { conductorId: "conductor" });
    const r2 = rooms.create("amb-b", members, "conductor", { conductorId: "conductor" });
    const orchestrator = new ConductorOrchestrator(
      { prompt: async () => {}, isBusy: () => false },
      rooms,
      () => {},
      undefined,
      0,
    );
    const plan = (task: string) =>
      `\`\`\`json\n{"tasks":[{"id":"t1","to":"coder","task":"${task}"}]}\n\`\`\``;
    const tick = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };
    const taskView = (roomId: string) =>
      (orchestrator.getFlow(roomId)!.tasks as Record<string, unknown>[]).find(
        (t) => t.id === "t1",
      )!;
    await orchestrator.start(r1, "任务");
    await orchestrator.onPromptDone("conductor", plan("A"));
    await orchestrator.start(r2, "任务");
    await orchestrator.onPromptDone("conductor", plan("B"));
    await tick();
    orchestrator.observeToolUpdate("worker", {
      sessionUpdate: "tool_call",
      toolCallId: "tcA",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    });
    orchestrator.observeToolUpdate("worker", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tcA",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    assert.equal(taskView(r1.roomId).backendRuns, undefined, "歧义会话不得在 r1 归属");
    assert.equal(taskView(r2.roomId).backendRuns, undefined, "歧义会话不得在 r2 归属");
    await orchestrator.onPromptDone("worker", '```json\n{"text":"done"}\n```');
    await tick();
    orchestrator.observeToolUpdate("worker", {
      sessionUpdate: "tool_call",
      toolCallId: "tcB",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    });
    orchestrator.observeToolUpdate("worker", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tcB",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
    assert.equal(taskView(r1.roomId).backendRuns, undefined);
    const runs = taskView(r2.roomId).backendRuns as { toolCallId: string; exitCode?: number }[];
    assert.equal(runs.length, 1, "歧义解除后应归属唯一运行中任务");
    assert.equal(runs[0]!.toolCallId, "tcB");
    assert.equal(runs[0]!.exitCode, 0);
  });

  it("workspaceSnapshotHash：跟踪/未跟踪/删除/恢复均反映真实字节", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-iso-hash-"));
    const git = (args: string[]) =>
      execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", dir, ...args]);
    try {
      assert.equal(
        workspaceSnapshotHash(dir),
        undefined,
        "非 Git 工作区必须返回 undefined",
      );
      git(["init", "--quiet"]);
      fs.writeFileSync(path.join(dir, ".gitignore"), "data/\n");
      fs.mkdirSync(path.join(dir, "data"));
      fs.writeFileSync(path.join(dir, "data", "big.bin"), Buffer.alloc(6 * 1024 * 1024));
      fs.writeFileSync(path.join(dir, "marker.txt"), "v1");
      git(["add", ".gitignore", "marker.txt"]);
      const h1 = workspaceSnapshotHash(dir);
      assert.ok(h1 && /^[0-9a-f]{64}$/.test(h1));
      fs.writeFileSync(path.join(dir, "marker.txt"), "v2");
      const h2 = workspaceSnapshotHash(dir);
      assert.notEqual(h2, h1, "修改已跟踪文件应改变 hash");
      fs.writeFileSync(path.join(dir, "untracked.txt"), "u");
      const h3 = workspaceSnapshotHash(dir);
      assert.notEqual(h3, h2, "未跟踪未忽略文件应计入 hash");
      fs.rmSync(path.join(dir, "marker.txt"));
      const h4 = workspaceSnapshotHash(dir);
      assert.notEqual(h4, h3, "删除已跟踪文件应改变 hash");
      fs.rmSync(path.join(dir, "untracked.txt"));
      fs.writeFileSync(path.join(dir, "marker.txt"), "v1");
      assert.equal(
        workspaceSnapshotHash(dir),
        h1,
        "恢复原始内容后 hash 必须一致",
      );
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(
        workspaceSnapshotHash(dir),
        undefined,
        "不可访问的 cwd 必须返回 undefined",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("隔离检查器：命令校验、快照哈希、沙箱隔离与 fail-closed", async () => {
    const sandboxReady =
      process.platform === "linux" &&
      fs.existsSync("/usr/bin/bwrap") &&
      fs.existsSync("/usr/bin/systemd-run") &&
      fs.existsSync("/usr/bin/git") &&
      Boolean(process.env.XDG_RUNTIME_DIR);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-iso-test-"));
    const git = (args: string[]) =>
      execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", dir, ...args]);
    try {
      git(["init", "--quiet"]);
      fs.writeFileSync(path.join(dir, ".gitignore"), "data/\n");
      fs.mkdirSync(path.join(dir, "data"));
      fs.writeFileSync(
        path.join(dir, "data", "big.bin"),
        Buffer.alloc(6 * 1024 * 1024),
      );
      fs.writeFileSync(path.join(dir, "marker.txt"), "v1");
      git(["add", ".gitignore", "marker.txt"]);
      const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "ah-iso-nongit-"));
      try {
        const ng = await runIsolatedCheck(nonGit, "node -e 'process.exit(0)'");
        assert.equal(ng.status, "blocked");
        assert.equal(ng.reason, "snapshot_error", "非 Git 工作区必须 fail closed");
      } finally {
        fs.rmSync(nonGit, { recursive: true, force: true });
      }
      const multi = await runIsolatedCheck(dir, "echo a\necho b");
      assert.equal(multi.status, "blocked");
      assert.equal(multi.reason, "invalid_command");
      const long = await runIsolatedCheck(dir, `node -e '${"x".repeat(300)}'`);
      assert.equal(long.status, "blocked");
      assert.equal(long.reason, "invalid_command");
      const empty = await runIsolatedCheck(dir, "   ");
      assert.equal(empty.status, "blocked");
      assert.equal(empty.reason, "invalid_command");
      if (!sandboxReady) {
        const un = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
        assert.equal(un.status, "blocked", "无沙箱设施时必须 fail closed");
        return;
      }
      const ok = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      assert.equal(ok.status, "exited_zero");
      assert.equal(ok.runner, "bubblewrap");
      assert.equal(ok.exitCode, 0);
      assert.ok(ok.snapshotHash);
      assert.ok(!JSON.stringify(ok).includes("process.exit"), "结果不得回显原始命令");
      const ignored = await runIsolatedCheck(
        dir,
        "node -e 'process.exit(require(\"fs\").existsSync(\"data\")?1:0)'",
      );
      assert.equal(ignored.status, "exited_zero", "gitignore 的运行时目录不得进入沙箱");
      const siblingName = `ah-iso-sibling-${process.pid}.txt`;
      const parentWrite = await runIsolatedCheck(
        dir,
        `node -e 'require("fs").writeFileSync("../${siblingName}","x")'`,
      );
      assert.equal(parentWrite.status, "exited_zero", "沙箱虚拟父级 tmpfs 应可写");
      assert.ok(
        !fs.existsSync(path.join(os.tmpdir(), siblingName)),
        "沙箱父级写入不得泄漏到宿主",
      );
      fs.writeFileSync(path.join(dir, "marker.txt"), "v2");
      const ok2 = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      assert.equal(ok2.status, "exited_zero");
      assert.notEqual(ok2.snapshotHash, ok.snapshotHash, "快照内容变化应改变 hash");
      fs.writeFileSync(path.join(dir, "untracked.txt"), "u");
      const ok3 = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      assert.equal(ok3.status, "exited_zero");
      assert.notEqual(ok3.snapshotHash, ok2.snapshotHash, "未跟踪未忽略文件应计入快照");
      fs.rmSync(path.join(dir, "marker.txt"));
      const ok4 = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      assert.equal(ok4.status, "exited_zero");
      assert.notEqual(ok4.snapshotHash, ok3.snapshotHash, "已跟踪文件删除应改变 hash");
      fs.writeFileSync(path.join(dir, "marker.txt"), "v2");
      const nz = await runIsolatedCheck(dir, "node -e 'process.exit(2)'");
      assert.equal(nz.status, "exited_nonzero");
      assert.equal(nz.exitCode, 2);
      const iso = await runIsolatedCheck(
        dir,
        "node -e 'require(\"fs\").existsSync(\"/etc/shadow\") ? process.exit(1) : process.exit(0)'",
      );
      assert.equal(iso.status, "exited_zero", "沙箱内不得看到宿主敏感路径");
      const secretFile = path.join(os.tmpdir(), `ah-iso-secret-${process.pid}`);
      fs.writeFileSync(secretFile, "topsecret");
      fs.writeFileSync(path.join(dir, ".env.local"), "TOKEN=x");
      fs.symlinkSync(secretFile, path.join(dir, "leak_link"));
      const leak = await runIsolatedCheck(
        dir,
        "node -e 'const f=require(\"fs\");process.exit(f.existsSync(\".env.local\")||f.existsSync(\"leak_link\")?1:0)'",
      );
      assert.equal(leak.status, "exited_zero", ".env.* 与符号链接不得进入沙箱");
      fs.rmSync(secretFile, { force: true });
      const mutate = await runIsolatedCheck(
        dir,
        "node -e 'require(\"fs\").writeFileSync(\"marker.txt\",\"hacked\")'",
      );
      assert.equal(mutate.status, "exited_zero");
      assert.equal(
        fs.readFileSync(path.join(dir, "marker.txt"), "utf8"),
        "v2",
        "沙箱写快照副本不得改动宿主文件",
      );
      const inflight = runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      const busy = await runIsolatedCheck(dir, "node -e 'process.exit(0)'");
      assert.equal(busy.status, "blocked");
      assert.equal(busy.reason, "busy");
      await inflight;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
