import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTaskCommand, RoomModeManager, type AgentOps } from "./room-modes.js";
import { createPromptDoneParams, promptDoneInternalOutput } from "./agent.js";
import { resolveMemberByString } from "./conductor.js";
import { RoomManager } from "./room.js";
import type { Room } from "./room.js";

const room: Room = {
  roomId: "r1",
  name: "test",
  mode: "conductor",
  conductorId: "s1",
  members: [
    { sessionId: "s1", name: "coder" },
    { sessionId: "s2", name: "tester" },
  ],
};

function complete(sessionId: string, output: string): string {
  return promptDoneInternalOutput(createPromptDoneParams(sessionId, "end_turn", output));
}

describe("room-modes", () => {
  it("parseTaskCommand 解析单任务", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序");
    assert.equal(tasks?.length, 1);
    assert.equal(tasks?.[0]?.to, "coder");
    assert.equal(tasks?.[0]?.task, "实现排序");
    assert.equal(tasks?.[0]?.id, "t1");
    assert.deepEqual(tasks?.[0]?.dependsOn, []);
  });

  it("parseTaskCommand 解析多任务", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序；@tester 写单测");
    assert.equal(tasks?.length, 2);
    assert.equal(tasks?.[0]?.id, "t1");
    assert.equal(tasks?.[0]?.task, "实现排序");
    assert.equal(tasks?.[1]?.id, "t2");
    assert.equal(tasks?.[1]?.task, "写单测");
  });

  it("parseTaskCommand 解析依赖", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序；@tester 写单测 (depends: t1)");
    assert.equal(tasks?.length, 2);
    assert.deepEqual(tasks?.[1]?.dependsOn, ["t1"]);
    assert.equal(tasks?.[1]?.task, "写单测");
  });

  it("parseTaskCommand 空 /task 返回空数组", () => {
    const tasks = parseTaskCommand("/task  ");
    assert.equal(tasks?.length, 0);
  });

  it("parseTaskCommand 非 /task 返回 undefined", () => {
    const tasks = parseTaskCommand("@coder 实现排序");
    assert.equal(tasks, undefined);
  });

  it("resolveMemberByString 按 name / id / 前缀解析", () => {
    assert.equal(resolveMemberByString(room, "coder")?.sessionId, "s1");
    assert.equal(resolveMemberByString(room, "s2")?.sessionId, "s2");
    assert.equal(resolveMemberByString(room, "tes")?.sessionId, "s2");
    assert.equal(resolveMemberByString(room, "未知"), undefined);
  });

  it("mention 模式输出自动提取 artifact 到房间 registry", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const agent: AgentOps = {
      prompt: async () => {},
      isBusy: () => false,
      cancel: async () => {},
    };
    const broadcasted: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasted.push({ method, params }),
    );
    await manager.handle(room, "@coder 改一下 room.ts", {});
    assert.equal(manager.isRoomTurn("s1"), true);
    assert.equal(manager.isRoomTurn("s2"), false);
    const output = `已修改 hub/src/room.ts\n\`\`\`bash\nnpx tsc --noEmit\n\`\`\``;
    await manager.onPromptDone("s1", output);
    assert.equal(manager.isRoomTurn("s1"), false);
    const events = rooms.getEvents(room.roomId, 10);
    assert.equal(events.length, 1);
    const event = events.find((e) => e.action === "command");
    assert.equal(event?.summary, "npx tsc --noEmit");
  });

  it("mention 模式自动识别 alias 引用并注入上下文", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const a = rooms.addFile(room.roomId, { author: "s2", summary: "文件 a", path: "src/a.ts" })!;
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "@coder 继续 a1", {});
    assert.equal(prompts.length, 1);
    const text = typeof prompts[0]!.text === "string" ? prompts[0]!.text : JSON.stringify(prompts[0]!.text);
    assert.ok(text.includes("文件 a"));
    assert.ok(text.includes(a.alias!));
  });

  it("conductor 模式 /task 解析自动注入 artifact 引用", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    room.mode = "conductor";
    room.conductorId = "s1";
    const a = rooms.addFile(room.roomId, { author: "s2", summary: "需要继续的文件", path: "src/a.ts" })!;
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "/task @coder 继续 a1");
    const worker = prompts.find((p) => p.sessionId === "s1");
    const text = typeof worker?.text === "string" ? worker!.text : JSON.stringify(worker!.text);
    assert.ok(text?.includes("需要继续的文件"));
    assert.ok(text?.includes("a1"));
  });

  it("conductor 流程结束时通过 flowUpdate 清除进度面板", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    room.mode = "conductor";
    room.conductorId = "s1";
    const agent: AgentOps = {
      prompt: async () => {},
      isBusy: () => false,
      cancel: async () => {},
    };
    const broadcasts: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasts.push({ method, params }),
    );
    await manager.handle(room, "/task @tester 写测试");
    const flowUpdates = () => broadcasts.filter((b) => b.method === "room.flowUpdate");
    const lastFlow = () => flowUpdates().at(-1)?.params.flow as { phase?: string } | undefined;
    assert.equal(lastFlow()?.phase, "working");

    await manager.onPromptDone("s2", "完成了");
    assert.equal(lastFlow()?.phase, "summarizing");

    await manager.onPromptDone("s1", "最终总结");
    assert.equal(lastFlow(), undefined);
  });

  it("mention 和 roundrobin 使用完整输出提取前部 artifact", async () => {
    for (const mode of ["mention", "roundrobin"] as const) {
      const rooms = new RoomManager();
      const modeRoom = rooms.create(`${mode}-long`, [{ sessionId: "s1", name: "coder" }], mode);
      const manager = new RoomModeManager(
        { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
        rooms,
        () => {},
      );
      await manager.handle(modeRoom, mode === "mention" ? "@coder 修改文件" : "修改文件");
      const output = `\`\`\`json\n${JSON.stringify({
        text: "完成",
        artifacts: [{ type: "file", path: `${mode}.ts`, summary: "长输出前部产物" }],
      })}\n\`\`\`\n${"尾部内容".repeat(300)}`;
      await manager.onPromptDone("s1", complete("s1", output));
      assert.equal(rooms.getArtifacts(modeRoom.roomId, 10)[0]?.path, `${mode}.ts`);
    }
  });

  it("auto 使用完整长 JSON 决策而不错误兜底", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-long",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "worker", name: "worker" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const prompts: { sessionId: string; content: string | unknown[] }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    await manager.handle(autoRoom, "交给 worker 回答");
    const decision = `\`\`\`json\n${JSON.stringify({
      mode: "mention",
      reason: "需要指定成员",
      params: { targets: ["worker"], detail: "x".repeat(1000) },
    })}\n\`\`\``;
    await manager.onPromptDone("host", complete("host", decision));
    assert.equal(manager.subModeFor(autoRoom.roomId)?.mode, "mention");
    assert.equal(prompts.at(-1)?.sessionId, "worker");
  });

  it("parallel 汇总能读取长输出开头", async () => {
    const rooms = new RoomManager();
    const parallelRoom = rooms.create(
      "parallel-long",
      [
        { sessionId: "worker", name: "worker" },
        { sessionId: "summary", name: "summary" },
      ],
      "parallel",
      { parallelSummarizerId: "summary" },
    );
    const prompts: { sessionId: string; content: string | unknown[] }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          prompts.push({ sessionId, content });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    await manager.handle(parallelRoom, "分析问题", { params: { targets: ["worker"], summarizer: "summary" } });
    await manager.onPromptDone("worker", complete("worker", `关键结论在开头。${"长内容".repeat(300)}`));
    assert.equal(prompts.at(-1)?.sessionId, "summary");
    assert.match(String(prompts.at(-1)?.content), /关键结论在开头/);
  });

  it("pipeline 和 debate 能把长输出开头传给下一阶段", async () => {
    for (const mode of ["pipeline", "debate"] as const) {
      const rooms = new RoomManager();
      const members = [
        { sessionId: "s1", name: "first" },
        { sessionId: "s2", name: "second" },
        { sessionId: "s3", name: "judge" },
      ];
      const modeRoom = rooms.create(
        `${mode}-long`,
        members,
        mode,
        mode === "pipeline"
          ? { pipelineOrder: ["s1", "s2"] }
          : { debateSides: ["s1", "s2"], debateJudge: "s3", debateRounds: 1 },
      );
      const prompts: { sessionId: string; content: string | unknown[] }[] = [];
      const manager = new RoomModeManager(
        {
          prompt: async (sessionId, content) => {
            prompts.push({ sessionId, content });
          },
          isBusy: () => false,
          cancel: async () => {},
        },
        rooms,
        () => {},
      );
      await manager.handle(modeRoom, "继续处理");
      await manager.onPromptDone("s1", complete("s1", `首段关键证据。${"长内容".repeat(300)}`));
      assert.equal(prompts.at(-1)?.sessionId, "s2");
      assert.match(String(prompts.at(-1)?.content), /首段关键证据/);
    }
  });
});
