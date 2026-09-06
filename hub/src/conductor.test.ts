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
    );
    await orchestrator.start(failRoom, "任务");
    const plan = `\`\`\`json\n{"tasks":[{"id":"t1","to":"worker1","task":"先失败"},{"id":"t2","to":"worker2","task":"依赖 t1","dependsOn":["t1"]}]}\n\`\`\``;
    await orchestrator.onPromptDone("conductor", plan);

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
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

});
