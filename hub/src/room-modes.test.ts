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
    assert.equal(manager.roomIdForTurn("s1"), room.roomId);
    assert.equal(manager.subModeFor(room.roomId)?.activeSpeaker, "s1");
    const output = `已修改 hub/src/room.ts\n\`\`\`bash\nnpx tsc --noEmit\n\`\`\``;
    await manager.onPromptDone("s1", output);
    assert.equal(manager.isRoomTurn("s1"), false);
    assert.equal(manager.roomIdForTurn("s1"), undefined);
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
    assert.equal(lastFlow()?.phase, "reviewing");
    assert.equal(manager.isHiddenSession("s1"), true);

    await manager.onPromptDone("s1", '```json\n{"decision":"complete","reason":"达标"}\n```');
    assert.equal(lastFlow()?.phase, "summarizing");
    assert.equal(manager.isHiddenSession("s1"), false);

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

  it("auto 决策 prompt 包含避免双重编排的选择原则", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-prompt",
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
    await manager.handle(autoRoom, "做个决定");
    const decision = prompts.find((p) => p.sessionId === "host");
    assert.ok(decision);
    assert.ok(String(decision.content).includes("避免双重编排"));
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

  it("活跃流程中用户消息被吸收为补充而非取消编排", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "tester" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const cancelled: string[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
        isBusy: () => false,
        cancel: async (sid) => { cancelled.push(sid); },
      },
      rooms,
      () => {},
    );
    await manager.handle(room, "/task @tester 做A");
    assert.equal(manager.hasActiveFlow(room.roomId), true);

    const res = await manager.handle(room, "补充：要兼容 Windows", {});
    assert.deepEqual(res.sent, []);
    assert.equal(cancelled.length, 0);
    assert.equal(manager.hasActiveFlow(room.roomId), true);
    const flow = manager.getFlow(room.roomId) as { supplements?: string[] };
    assert.deepEqual(flow.supplements, ["补充：要兼容 Windows"]);

    // 补充进入下一阶段：任务完成后验收 prompt 携带补充
    await manager.onPromptDone("s2", "done");
    const review = prompts.filter((p) => p.sessionId === "s1").at(-1);
    assert.ok(review);
    assert.match(String(review!.text), /兼容 Windows/);
  });

  it("活跃流程中显式取消词仍然终止编排", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "tester" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const manager = new RoomModeManager(
      { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
      rooms,
      () => {},
    );
    await manager.handle(room, "/task @tester 做A");
    assert.equal(manager.hasActiveFlow(room.roomId), true);
    const res = await manager.handle(room, "取消", {});
    assert.deepEqual(res.sent, []);
    assert.equal(manager.hasActiveFlow(room.roomId), false);
  });

  it("成员向用户求助后，追问默认并入补充而非答案", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "tester" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const notices: string[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      (method, params) => {
        if (method === "room.notice") notices.push(String(params.message));
      },
    );
    await manager.handle(room, "/task @tester 起服务");
    await manager.onPromptDone(
      "s2",
      '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
    );
    const waiting = manager.getFlow(room.roomId) as {
      tasks: { waitingFor?: string }[];
    };
    assert.equal(waiting.tasks[0]!.waitingFor, "user");

    // 追问不当作答案：任务保持等待，消息并入补充并提醒仍有求助未答复
    const res = await manager.handle(room, "问的是什么问题呀？", {});
    assert.deepEqual(res.sent, []);
    const flow = manager.getFlow(room.roomId) as {
      tasks: { waitingFor?: string }[];
      supplements?: string[];
    };
    assert.equal(flow.tasks[0]!.waitingFor, "user");
    assert.deepEqual(flow.supplements, ["问的是什么问题呀？"]);
    assert.ok(notices.some((m) => m.includes("仍在等待答复")));
    // 没有唤醒 worker
    assert.equal(prompts.filter((p) => p.sessionId === "s2").length, 1);

    // 追问后再用「答：」前缀显式答复，唤醒原任务且前缀被剥离
    const res2 = await manager.handle(room, "答：用 3000", {});
    assert.deepEqual(res2.sent, ["s2"]);
    const last = prompts.filter((p) => p.sessionId === "s2").at(-1)!;
    assert.match(String(last.text), /用 3000/);
    assert.equal(manager.hasActiveFlow(room.roomId), true);
  });

  it("room.message 显式参数答复求助：params.answer 与 params.replyTo", async () => {
    for (const useReplyTo of [false, true]) {
      const rooms = new RoomManager();
      const room = rooms.create(
        "team",
        [
          { sessionId: "s1", name: "coder" },
          { sessionId: "s2", name: "tester" },
        ],
        "conductor",
        { conductorId: "s1" },
      );
      const prompts: { sessionId: string; text: string | unknown[] }[] = [];
      const manager = new RoomModeManager(
        {
          prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
          isBusy: () => false,
          cancel: async () => {},
        },
        rooms,
        () => {},
      );
      await manager.handle(room, "/task @tester 起服务");
      await manager.onPromptDone(
        "s2",
        '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
      );
      const flow = manager.getFlow(room.roomId) as {
        tasks: { waitingFor?: string; waitingHelpId?: string }[];
      };
      assert.equal(flow.tasks[0]!.waitingFor, "user");
      assert.ok(flow.tasks[0]!.waitingHelpId);

      const options = useReplyTo
        ? { params: { replyTo: flow.tasks[0]!.waitingHelpId } }
        : { params: { answer: true } };
      const res = await manager.handle(room, "用 3000", options);
      assert.deepEqual(res.sent, ["s2"]);
      const last = prompts.filter((p) => p.sessionId === "s2").at(-1)!;
      assert.match(String(last.text), /3000/);
    }
  });

  it("「答：」前缀之外的消息不会误消费求助，intent=supplement 也强制走补充", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "tester" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    await manager.handle(room, "/task @tester 起服务");
    await manager.onPromptDone(
      "s2",
      '```json\n{"help":{"to":"user","question":"端口用哪个？"}}\n```',
    );

    // intent=supplement 即使文本像答复也不消费求助
    const res = await manager.handle(room, "答：先别答复", {
      params: { intent: "supplement" },
    });
    assert.deepEqual(res.sent, []);
    const flow = manager.getFlow(room.roomId) as {
      tasks: { waitingFor?: string }[];
      supplements?: string[];
    };
    assert.equal(flow.tasks[0]!.waitingFor, "user");
    assert.deepEqual(flow.supplements, ["答：先别答复"]);

    const res2 = await manager.handle(room, "answer: 8080", {});
    assert.deepEqual(res2.sent, ["s2"]);
    const last = prompts.filter((p) => p.sessionId === "s2").at(-1)!;
    assert.match(String(last.text), /8080/);
  });
});
