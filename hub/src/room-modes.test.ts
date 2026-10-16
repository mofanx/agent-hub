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

  it("conductor 流程结束时 flowUpdate 广播 done 视图", async () => {
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
    assert.equal(lastFlow()?.phase, "done");
    assert.equal(manager.hasActiveFlow(room.roomId), false);
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

describe("mention 集合别名派发", () => {
  const harness = (aliases?: Record<string, string[]>) => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "alice" },
        { sessionId: "s2", name: "bob" },
        { sessionId: "s3", name: "carol" },
      ],
      "mention",
      aliases ? { aliases } : undefined,
    );
    const prompts: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => { prompts.push(sid); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    return { room, prompts, manager };
  };

  it("@all 派发给全部成员", async () => {
    const h = harness();
    const res = await h.manager.handle(h.room, "@all 集合", {});
    assert.deepEqual([...h.prompts].sort(), ["s1", "s2", "s3"]);
    assert.deepEqual(res.mentioned, ["s1", "s2", "s3"]);
  });

  it("自定义别名组只派发给被展开成员，未命中成员 SILENT", async () => {
    const h = harness({ 后端组: ["s1", "s3"] });
    const res = await h.manager.handle(h.room, "@后端组 干活", {});
    assert.deepEqual([...h.prompts].sort(), ["s1", "s3"]);
    assert.deepEqual(res.mentioned, ["s1", "s3"]);
    assert.ok(!h.prompts.includes("s2"), "s2 未被别名命中，不派发");
  });
});

describe("openTopics 编排注入与归档", () => {
  const conductorHarness = () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const prompts: { sessionId: string; text: string }[] = [];
    const broadcasts: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid, text) => {
          prompts.push({ sessionId: sid, text: String(text) });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      (method, params) => broadcasts.push({ method, params }),
    );
    return { rooms, room, prompts, broadcasts, manager };
  };

  it("conductor 规划/验收 prompt 含未结话题，worker prompt 不含", async () => {
    const h = conductorHarness();
    h.rooms.openTopic(h.room.roomId, "接口选型未定", "user");
    h.rooms.openTopic(h.room.roomId, "已结的旧话题", "s2");
    const done2 = h.rooms.openTopics(h.room.roomId)[1]!;
    h.rooms.resolveTopic(h.room.roomId, done2.id);
    await h.manager.handle(h.room, "实现登录功能");

    const planning = h.prompts.find((p) => p.sessionId === "s1")!;
    assert.match(planning.text, /未结话题/);
    assert.match(planning.text, /user：接口选型未定/);
    assert.ok(!planning.text.includes("已结的旧话题"), "已结话题不注入");

    await h.manager.onPromptDone(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现登录"}]}\n```',
    );
    const worker = h.prompts.find((p) => p.sessionId === "s2")!;
    assert.ok(!worker.text.includes("未结话题"), "worker prompt 不带话题段");
    assert.ok(!worker.text.includes("接口选型未定"), "topic 不泄漏进 worker 黑板段");

    await h.manager.onPromptDone("s2", "完成了");
    const review = h.prompts.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(review.text, /未结话题/);
    assert.match(review.text, /接口选型未定/);
  });

  it("auto 决策 prompt 注入未结话题", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "auto-room",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "w", name: "w" },
      ],
      "auto",
      { conductorId: "host" },
    );
    rooms.openTopic(room.roomId, "数据源待定", "w");
    const prompts: { sessionId: string; text: string }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid, text) => {
          prompts.push({ sessionId: sid, text: String(text) });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    await manager.handle(room, "选个方案");
    const decision = prompts.find((p) => p.sessionId === "host")!;
    assert.match(decision.text, /未结话题/);
    assert.match(decision.text, /w：数据源待定/);
  });

  it("flow 到 done 自动归档本轮开启的话题并广播黑板", async () => {
    const h = conductorHarness();
    const stale = h.rooms.openTopic(h.room.roomId, "上一轮遗留话题")!;
    stale.at -= 60_000; // 窗口外：flow 启动前开启的话题不归档
    await h.manager.handle(h.room, "做功能");
    const fresh = h.rooms.openTopic(h.room.roomId, "本轮新话题", "s2")!;

    // 走完 planning → working → reviewing → summarizing → done
    await h.manager.onPromptDone(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"做A"}]}\n```',
    );
    await h.manager.onPromptDone("s2", "完成");
    await h.manager.onPromptDone(
      "s1",
      '```json\n{"decision":"complete","reason":"达标"}\n```',
    );
    await h.manager.onPromptDone("s1", "总结输出");
    assert.equal(
      (h.manager.getFlow(h.room.roomId) as { phase?: string } | undefined)?.phase,
      "done",
    );
    const board = h.rooms.getBlackboard(h.room.roomId);
    assert.equal(board.find((e) => e.id === fresh.id)!.status, "resolved", "本轮开启的话题已归档");
    assert.equal(board.find((e) => e.id === stale.id)!.status, "open", "窗口外话题保持 open");
    assert.ok(
      h.broadcasts.some(
        (b) =>
          b.method === "room.blackboardUpdate" &&
          (b.params.blackboard as { id: string; status?: string }[]).some(
            (e) => e.id === fresh.id && e.status === "resolved",
          ),
      ),
      "归档后广播最新黑板",
    );
  });

  it("parallel flow 完成同样归档窗口内话题", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "parallel-room",
      [
        { sessionId: "a", name: "a" },
        { sessionId: "b", name: "b" },
      ],
      "parallel",
      { parallelSummarizerId: "b" },
    );
    const manager = new RoomModeManager(
      { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
      rooms,
      () => {},
    );
    await manager.handle(room, "给观点", { params: { targets: ["a"], summarizer: "b" } });
    const t = rooms.openTopic(room.roomId, "并行期话题")!;
    await manager.onPromptDone("a", "观点");
    await manager.onPromptDone("b", "汇总");
    assert.equal(
      rooms.getBlackboard(room.roomId).find((e) => e.id === t.id)!.status,
      "resolved",
    );
  });
});
