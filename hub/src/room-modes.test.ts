import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTaskCommand, RoomModeManager, type AgentOps } from "./room-modes.js";
import { ModeDecider } from "./decide.js";
import { createPromptDoneParams, promptDoneInternalOutput } from "./agent.js";
import { resolveMemberByString } from "./conductor.js";
import { RoomManager } from "./room.js";
import type { Room } from "./room.js";
import { clientMessageFlowState } from "./client-messages.js";

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
  it("移除房间广播空 flow，撤回其他客户端的待办而不再次派发", async () => {
    const rooms = new RoomManager();
    const r = rooms.create("team", room.members, "parallel");
    let sends = 0;
    const agent: AgentOps = { prompt: async () => { sends++; }, isBusy: () => false, cancel: async () => {} };
    const events: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) => events.push({ method, params }));
    await manager.handle(r, "review", {});
    assert.ok(manager.getFlow(r.roomId));
    const before = sends;
    rooms.delete(r.roomId);
    manager.onRoomRemoved(r.roomId);
    const last = events.filter((event) => event.method === "room.flowUpdate").at(-1);
    assert.deepEqual(last?.params, { roomId: r.roomId, flow: null });
    assert.equal(manager.getFlow(r.roomId), undefined);
    assert.equal(sends, before);
  });

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

  it("成员展示名统一：事件 author 与 notice 均产出 name·type·origin", async () => {
    const rooms = new RoomManager();
    rooms.setMemberChannelResolver((sid) =>
      sid === "s1" ? { agent: "devin", origin: "local" } : { agent: "claude", origin: "remote" },
    );
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const agent: AgentOps = { prompt: async () => {}, isBusy: () => false, cancel: async () => {} };
    const broadcasted: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasted.push({ method, params }),
    );
    await manager.handle(room, "@coder 跑一下测试", {});
    await manager.onPromptDone("s1", "完成\n```bash\nnpm test\n```");
    // captureArtifacts 路径：事件 author 不再是裸 sessionId/name
    const event = rooms.getEvents(room.roomId, 10).find((e) => e.action === "command");
    assert.equal(event?.author, "coder·devin·local");
    // mention 命中成员场景：直接断言展示名格式（name·agentType·local|remote）
    assert.match(event!.author, /^coder·devin·local$/);
  });

  it("nameFor 通知路径产出展示名；查不到成员回退短 id", async () => {
    const rooms = new RoomManager();
    rooms.setMemberChannelResolver((sid) =>
      sid === "s1" ? { agent: "devin", origin: "local" } : { agent: "claude", origin: "remote" },
    );
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ], "roundrobin");
    const agent: AgentOps = { prompt: async () => {}, isBusy: () => false, cancel: async () => {} };
    const broadcasted: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasted.push({ method, params }),
    );
    await manager.handle(room, "介绍下这个项目", {});
    const notice = broadcasted.find((b) => b.method === "room.notice");
    assert.equal(
      (notice?.params as { message?: string })?.message,
      "🔄 轮询模式：由 @coder·devin·local 作答",
    );
    // 非成员 sessionId（如已离房成员）回退为短 id，而不是整条展示名
    const rm = manager as unknown as { nameFor(roomId: string, sid?: string): string };
    assert.equal(rm.nameFor(room.roomId, "ghost9zzz"), "9zzz");
    assert.equal(rm.nameFor(room.roomId, "s2"), "tester·claude·remote");
  });

  it("并行 flow 视图的成员名与汇总者通知使用统一展示名", async () => {
    const rooms = new RoomManager();
    rooms.setMemberChannelResolver((sid) =>
      sid === "s1" ? { agent: "devin", origin: "local" } : { agent: "claude", origin: "remote" },
    );
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ], "parallel", { parallelSummarizerId: "s2" });
    const agent: AgentOps = { prompt: async () => {}, isBusy: () => false, cancel: async () => {} };
    const broadcasted: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasted.push({ method, params }),
    );
    await manager.handle(room, "你怎么看？", {});
    const notice = broadcasted.find(
      (b) => b.method === "room.notice" && String((b.params as { message?: string }).message ?? "").includes("并行模式"),
    );
    assert.ok(String((notice?.params as { message?: string }).message).includes("@coder·devin·local"));
    assert.ok(String((notice?.params as { message?: string }).message).includes("@tester·claude·remote"));
    const flow = broadcasted
      .filter((b) => b.method === "room.flowUpdate")
      .at(-1)?.params.flow as { tasks?: { name: string }[] } | undefined;
    assert.deepEqual(flow?.tasks?.map((t) => t.name), ["coder·devin·local", "tester·claude·remote"]);
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

  it("预条件消息在 relevanceFilter 挂起期间遇新 flow → context_changed 不派发", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "coder" }], { mode: "auto" } as never);
    room.mode = "mention";
    const dispatched: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => { dispatched.push(String(sid)); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    let release: (v: boolean) => void = () => {};
    const gate = new Promise<boolean>((r) => { release = r; });
    manager.setRelevanceFilter(() => gate);
    const params = { expectedFlowId: null };
    const p = manager.handle(room, "旧意图", { params } as never);
    await new Promise((r) => setImmediate(r));
    const origGetFlow = manager.getFlow.bind(manager);
    manager.getFlow = () => ({ flowId: "f2", missionId: null });
    const origActive = manager.hasActiveFlow.bind(manager);
    manager.hasActiveFlow = () => true;
    release(true);
    await assert.rejects(p, /client_message_context_changed/);
    manager.getFlow = origGetFlow;
    manager.hasActiveFlow = origActive;
    assert.equal(dispatched.length, 0, "旧意图不得派发");
  });

  it("预条件消息在 relevanceFilter 期间变更无 flow 的房间模式也拒绝派发", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "coder" }], "mention");
    let dispatched = 0;
    const manager = new RoomModeManager(
      { prompt: async () => { dispatched++; }, isBusy: () => false, cancel: async () => {} },
      rooms, () => {},
    );
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    manager.setRelevanceFilter(() => { entered(); return gate; });
    const sending = manager.handle(room, "old intent", {
      params: { expectedFlowId: null, expectedFlowState: "none", expectedRoomMode: "mention" },
    });
    await started;
    room.mode = "conductor";
    release(true);
    await assert.rejects(sending, /client_message_context_changed/);
    assert.equal(dispatched, 0);
  });

  it("预条件分类读取真实 parallel 汇总快照的执行模式", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("parallel", [{ sessionId: "a", name: "worker" }, { sessionId: "b", name: "summary" }], "parallel");
    const manager = new RoomModeManager(
      { prompt: async () => {}, isBusy: () => false, cancel: async () => {} }, rooms, () => {},
    );
    await manager.handle(room, "goal", { params: { targets: ["a"], summarizer: "b" } });
    assert.equal(manager.getFlow(room.roomId)?.mode, "parallel");
    assert.equal(clientMessageFlowState(manager.getFlow(room.roomId)), "active");
    await manager.onPromptDone("a", "result");
    const snapshot = manager.getFlow(room.roomId);
    assert.equal(snapshot?.phase, "summarizing");
    assert.equal(snapshot?.mode, "parallel");
    assert.equal(clientMessageFlowState(snapshot), "restart");
    await manager.cancelActive(room.roomId, "test cleanup");
  });
  it("auto 决策失败兜底：有最后发言成员时派给该成员而非 self", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-fb",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "worker", name: "worker" },
      ],
      "auto",
      { conductorId: "host" },
    );
    (autoRoom.blackboard ??= []).push({
      id: "b1",
      from: "worker",
      text: "上轮输出",
      detail: "",
      at: Date.now(),
    });
    const prompts: { sessionId: string }[] = [];
    const events: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId) => {
          prompts.push({ sessionId });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      (method, params) => events.push({ method, params }),
    );
    await manager.handle(autoRoom, "交给 worker 回答");
    manager.onPromptError("host", "went silent mid-turn");
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.at(-1)?.sessionId, "worker");
    const notice = events.find(
      (e) => e.method === "room.notice" && /兜底/.test(String(e.params.message)),
    );
    assert.ok(notice, "决策失败应有兜底系统提示");
  });

  it("auto 决策失败兜底：无最后发言成员时仍回退 self", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-fb-solo",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "worker", name: "worker" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const prompts: { sessionId: string }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId) => {
          prompts.push({ sessionId });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    await manager.handle(autoRoom, "交给 worker 回答");
    manager.onPromptError("host", "went silent mid-turn");
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1]?.sessionId, "host");
  });

  it("auto 规则快通道：self 应答通知标注决策来源", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-fast",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "worker", name: "worker" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const events: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(
      { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
      rooms,
      (method, params) => events.push({ method, params }),
    );
    manager.setModeDecider(new ModeDecider({}));
    await manager.handle(autoRoom, "帮我看下这段代码");
    const ev = events.find(
      (e) => e.method === "room.notice" && /独立作答/.test(String(e.params.message)),
    );
    assert.ok(ev && /规则/.test(String(ev.params.message)), "通知应标注规则来源");
  });
  it("编排活性+接续词：禁 fastPath 直出 self，交主持人决策", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-cont",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "w1", name: "w1" },
        { sessionId: "w2", name: "w2" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const prompts: { sessionId: string }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId) => {
          prompts.push({ sessionId });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    manager.setModeDecider(new ModeDecider({}));
    // 模拟上轮 parallel 编排刚跑过
    (manager as unknown as { autoHistory: Map<string, { at: number; mode: string; reason: string }[]> })
      .autoHistory.set(autoRoom.roomId, [{ at: Date.now(), mode: "parallel", reason: "x" }]);
    await manager.handle(autoRoom, "继续");
    // 应走 deciding（发决策 prompt 给 host），而非直出 self 应答
    const sent = prompts.at(-1)?.sessionId;
    assert.equal(sent, "host");
    assert.equal(manager.subModeFor(autoRoom.roomId)?.mode, "deciding");
  });

  it("规则直出 parallel 后记 autoHistory：接续词命中活性闸门不吞 self", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-rule-hist",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "w1", name: "w1" },
        { sessionId: "w2", name: "w2" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const prompts: { sessionId: string }[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sessionId) => {
          prompts.push({ sessionId });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    manager.setModeDecider(new ModeDecider({}));
    // 规则直出 parallel（不走 LLM 决策路径）——修复前此路径不记 autoHistory
    await manager.handle(autoRoom, "帮我讨论一下这个问题");
    const hist = (manager as unknown as { autoHistory: Map<string, { mode: string }[]> })
      .autoHistory.get(autoRoom.roomId);
    assert.equal(hist?.at(-1)?.mode, "parallel", "规则直出路径必须记 autoHistory");
    // 接续词应命中活性闸门：修复前规则直出不记账→orchestrationAlive 恒 false
    const alive = (manager as unknown as { orchestrationAlive(r: unknown): boolean })
      .orchestrationAlive(autoRoom);
    assert.equal(alive, true, "规则直出 parallel 后活性必须为真");
  });

  it("无编排活性时接续词仍走 fastPath self", async () => {
    const rooms = new RoomManager();
    const autoRoom = rooms.create(
      "auto-nocont",
      [
        { sessionId: "host", name: "host" },
        { sessionId: "w1", name: "w1" },
        { sessionId: "w2", name: "w2" },
      ],
      "auto",
      { conductorId: "host" },
    );
    const prompts: { sessionId: string; content: unknown }[] = [];
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
    manager.setModeDecider(new ModeDecider({}));
    await manager.handle(autoRoom, "好的，继续");
    assert.equal(manager.subModeFor(autoRoom.roomId)?.mode, "self");
  });
});

describe("followUp 逐项投递与归属", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));

  function queueHarness() {
    const rooms = new RoomManager();
    const busy = new Set<string>();
    const calls: { sessionId: string; content: unknown; opts: unknown; roomIdAtDispatch: string | undefined }[] = [];
    const cancelled: string[] = [];
    const events: { method: string; params: Record<string, unknown> }[] = [];
    let manager!: RoomModeManager;
    const agent: AgentOps = {
      prompt: async (sessionId, content, opts) => {
        calls.push({ sessionId, content, opts, roomIdAtDispatch: manager.roomIdForTurn(sessionId) });
        busy.add(sessionId);
      },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => {
        cancelled.push(sid);
        busy.delete(sid);
      },
    };
    manager = new RoomModeManager(agent, rooms, (method, params) => events.push({ method, params }));
    return { rooms, busy, calls, cancelled, events, agent, get manager() { return manager; } };
  }

  it("跨房共享会话：排队按 FIFO 逐项投递，归属与 artifact 各自归房", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("roomA", [{ sessionId: "s1", name: "coder" }], "mention");
    const rB = h.rooms.create("roomB", [{ sessionId: "s1", name: "coder" }], "mention");
    h.busy.add("s1");
    await h.manager.handle(rA, "@coder TASK_A", {});
    await h.manager.handle(rB, "@coder TASK_B", {});
    assert.equal(h.calls.length, 0);

    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "old done");
    await tick();
    assert.equal(h.calls.length, 1, "旧 done 后只派队首，不合并");
    assert.ok(text(h.calls[0]!.content).includes("TASK_A"));
    assert.ok(!text(h.calls[0]!.content).includes("TASK_B"), "不得并入 B 房内容");
    assert.equal(h.calls[0]!.roomIdAtDispatch, rA.roomId);
    assert.equal(h.manager.roomIdForTurn("s1"), rA.roomId, "在途归属 A 房");

    h.busy.delete("s1");
    await h.manager.onPromptDone(
      "s1",
      '```json\n{"text":"done","artifacts":[{"type":"file","path":"a.ts","summary":"产物A"}]}\n```',
    );
    await tick();
    assert.equal(h.calls.length, 2, "A 完成后才派 B");
    assert.ok(text(h.calls[1]!.content).includes("TASK_B"));
    assert.ok(!text(h.calls[1]!.content).includes("TASK_A"));
    assert.equal(h.calls[1]!.roomIdAtDispatch, rB.roomId);
    assert.equal(h.manager.roomIdForTurn("s1"), rB.roomId, "在途归属 B 房");
    assert.ok(h.rooms.getArtifacts(rA.roomId, 10).some((a) => a.path === "a.ts"), "A 产物归 rA");
    assert.equal(h.rooms.getArtifacts(rB.roomId, 10).length, 0);

    h.busy.delete("s1");
    await h.manager.onPromptDone(
      "s1",
      '```json\n{"text":"done","artifacts":[{"type":"file","path":"b.ts","summary":"产物B"}]}\n```',
    );
    await tick();
    assert.ok(h.rooms.getArtifacts(rB.roomId, 10).some((a) => a.path === "b.ts"), "B 产物归 rB");
    assert.equal(h.rooms.getArtifacts(rA.roomId, 10).filter((a) => a.path === "b.ts").length, 0);
  });

  it("同房排队同样逐项投递；importRuntime 仅保留数值 opts 且过滤失效条目", async () => {
    const h = queueHarness();
    const room = h.rooms.create(
      "team",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "tester" },
      ],
      "mention",
    );
    h.busy.add("s1");
    await h.manager.handle(room, "@coder 第一条", {});
    await h.manager.handle(room, "@coder 第二条", {});
    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "old done");
    await tick();
    assert.equal(h.calls.length, 1);
    assert.ok(text(h.calls[0]!.content).includes("第一条"));
    assert.ok(!text(h.calls[0]!.content).includes("第二条"), "同房也不合并");
    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "done1");
    await tick();
    assert.equal(h.calls.length, 2);
    assert.ok(text(h.calls[1]!.content).includes("第二条"));

    const rooms2 = new RoomManager();
    const room2 = rooms2.create("team2", [{ sessionId: "s1", name: "coder" }], "mention");
    const calls2: { content: unknown; opts: Record<string, unknown> | undefined }[] = [];
    const agent2: AgentOps = {
      prompt: async (_sid, content, opts) => {
        calls2.push({ content, opts: opts as Record<string, unknown> | undefined });
      },
      isBusy: () => false,
      has: () => true,
      cancel: async () => {},
    };
    const m2 = new RoomModeManager(agent2, rooms2, () => {});
    await m2.importRuntime({
      followUps: {
        s1: [
          {
            roomId: room2.roomId,
            content: "有效任务",
            opts: { ackTimeoutMs: 111, stallMs: 222, queueIfBusy: true, junk: "x" },
          },
          { roomId: "ghost-room", content: "已删房任务" },
        ],
        s9: [{ roomId: room2.roomId, content: "非成员任务" }],
      },
    });
    m2.resumeFlows();
    await tick();
    await tick();
    assert.equal(calls2.length, 1, "仅有效条目投递");
    assert.ok(text(calls2[0]!.content).includes("有效任务"));
    assert.equal(calls2[0]!.opts?.ackTimeoutMs, 111);
    assert.equal(calls2[0]!.opts?.stallMs, 222);
    assert.equal(calls2[0]!.opts?.queueIfBusy, false, "sendPrompt 统一 queueIfBusy:false");
    assert.equal(calls2[0]!.opts?.junk, undefined, "非数值字段不恢复");
  });

  it("删房清空其队列不影响其他房；恢复的失效队列不投递", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("roomA", [{ sessionId: "s1", name: "coder" }], "mention");
    const rB = h.rooms.create("roomB", [{ sessionId: "s1", name: "coder" }], "mention");
    h.busy.add("s1");
    await h.manager.handle(rA, "@coder TASK_A", {});
    await h.manager.handle(rB, "@coder TASK_B", {});
    h.rooms.delete(rA.roomId);
    h.manager.onRoomRemoved(rA.roomId);
    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "old done");
    await tick();
    assert.equal(h.calls.length, 1, "已删房队列不投递");
    assert.ok(text(h.calls[0]!.content).includes("TASK_B"));
    assert.ok(!text(h.calls[0]!.content).includes("TASK_A"));
  });

  it("cancelActive 清本房未派发队列，且不取消归属其他房的在跑会话", async () => {
    const h = queueHarness();
    const rA = h.rooms.create(
      "roomA",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "worker" },
      ],
      "mention",
      { conductorId: "s1" },
    );
    const rB = h.rooms.create("roomB", [{ sessionId: "s1", name: "coder" }], "mention");
    const rC = h.rooms.create(
      "roomC",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s3", name: "other" },
      ],
      "mention",
      { conductorId: "s1" },
    );

    await h.manager.handle(rB, "@coder TASK_B", {});
    assert.equal(h.manager.roomIdForTurn("s1"), rB.roomId);
    assert.ok(h.busy.has("s1"));

    await h.manager.handle(rA, "@coder TASK_A", {});
    const fu = () =>
      (h.manager as unknown as { followUps: Map<string, { roomId: string }[]> }).followUps;
    assert.ok(fu().get("s1")?.some((it) => it.roomId === rA.roomId), "rA 队列已建");

    await h.manager.cancelActive(rA.roomId, "测试取消");
    assert.ok(!h.cancelled.includes("s1"), "s1 当前回合属 rB，不得取消");
    assert.ok(h.busy.has("s1"), "s1 仍忙（rB 回合继续）");
    assert.equal(h.manager.roomIdForTurn("s1"), rB.roomId, "rB 归属未被清");
    assert.ok(!(fu().get("s1") ?? []).some((it) => it.roomId === rA.roomId), "rA 未派发项已清");

    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "B done");
    await tick();
    assert.equal(h.calls.filter((c) => text(c.content).includes("TASK_A")).length, 0, "rA 队列已清不再派发");

    await h.manager.handle(rC, "@coder TASK_C", {});
    assert.equal(h.manager.roomIdForTurn("s1"), rC.roomId);
    await h.manager.cancelActive(rC.roomId, "测试取消2");
    assert.ok(h.cancelled.includes("s1"), "归属本房的在跑会话仍应取消");
  });

  it("parallel：busy 成员明确跳过不排队，flow/notice 只含实际发送者", async () => {
    const h = queueHarness();
    const room = h.rooms.create(
      "par",
      [
        { sessionId: "s1", name: "sum" },
        { sessionId: "s2", name: "worker" },
      ],
      "parallel",
      { parallelSummarizerId: "s1" },
    );
    h.busy.add("s2");
    const res = await h.manager.handle(room, "TOPIC", {});
    assert.deepEqual(res.sent, ["s1"]);
    assert.deepEqual(res.skipped, ["s2"]);
    assert.equal(h.calls.length, 1, "s2 不派发");
    assert.equal(h.calls.filter((c) => c.sessionId === "s2").length, 0);
    const fu = (h.manager as unknown as { followUps: Map<string, unknown[]> }).followUps;
    assert.equal(fu.get("s2")?.length ?? 0, 0, "s2 无排队项");
    const flow = h.manager.getFlow(room.roomId) as { tasks: { sessionId: string }[] };
    assert.deepEqual(flow.tasks.map((t) => t.sessionId), ["s1"], "flow 只含发送者");
    const notice = h.events.find(
      (e) => e.method === "room.notice" && String(e.params.message ?? "").includes("并行模式"),
    );
    assert.ok(notice);
    const msg = String(notice!.params.message);
    assert.ok(!msg.includes("worker"), `notice 不得虚报忙碌成员已询问：${msg}`);

    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "RESULT_S1");
    await tick();
    assert.equal(h.calls.length, 2, "s1 完成后汇总者可派发");
    assert.equal(h.calls[1]!.sessionId, "s1");
    h.busy.delete("s1");
    await h.manager.onPromptDone("s1", "SUMMARY");
    await tick();
    assert.equal(h.calls.filter((c) => c.sessionId === "s2").length, 0, "全程 s2 零调用");
    assert.equal((h.manager.getFlow(room.roomId) as { phase?: string })?.phase, "done");
  });

  it("error/cancel 收尾后排队项仍正常派发且归属正确", async () => {
    const h = queueHarness();
    const room = h.rooms.create("team", [{ sessionId: "s1", name: "coder" }], "mention");
    h.busy.add("s1");
    await h.manager.handle(room, "@coder TASK_Q", {});
    h.busy.delete("s1");
    h.manager.onPromptError("s1");
    await tick();
    assert.equal(h.calls.length, 1, "error 收尾后 drain 派发");
    assert.equal(h.calls[0]!.roomIdAtDispatch, room.roomId, "error 后 drain 归属本房");

    h.busy.add("s1");
    await h.manager.handle(room, "@coder TASK_Q2", {});
    h.busy.delete("s1");
    h.manager.onSessionCancelled("s1");
    await tick();
    assert.equal(h.calls.length, 2, "cancel 收尾后 drain 派发");
    assert.equal(h.calls[1]!.roomIdAtDispatch, room.roomId);
    assert.ok(text(h.calls[1]!.content).includes("TASK_Q2"));
  });

  it("删除房间取消其明确在途回合一次，房队列清空不再派发", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("delA", [{ sessionId: "s1", name: "coder" }], "mention");
    await h.manager.handle(rA, "@coder TASK_A", {});
    assert.equal(h.manager.roomIdForTurn("s1"), rA.roomId);
    assert.ok(h.busy.has("s1"));

    h.rooms.delete(rA.roomId);
    h.manager.onRoomRemoved(rA.roomId);
    await tick();
    await tick();

    assert.deepEqual(h.cancelled, ["s1"], "在途回合应被 native cancel 一次");
    assert.equal(h.manager.roomIdForTurn("s1"), undefined, "房间登记应已清");
    assert.equal(h.calls.filter((c) => text(c.content).includes("TASK_A")).length, 1, "不再重复派发");
  });

  it("共享会话实际在他房在途：删本房不取消他房回合", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("delA2", [{ sessionId: "s1", name: "coder" }], "mention");
    const rB = h.rooms.create("keepB", [{ sessionId: "s1", name: "coder" }], "mention");
    await h.manager.handle(rB, "@coder TASK_B", {});
    assert.equal(h.manager.roomIdForTurn("s1"), rB.roomId);
    await h.manager.handle(rA, "@coder TASK_A", {});
    const fu = () =>
      (h.manager as unknown as { followUps: Map<string, { roomId: string }[]> }).followUps;
    assert.ok(fu().get("s1")?.some((it) => it.roomId === rA.roomId), "rA 队列已建");

    h.rooms.delete(rA.roomId);
    h.manager.onRoomRemoved(rA.roomId);
    await tick();
    await tick();

    assert.deepEqual(h.cancelled, [], "s1 在途归属 rB，不得取消");
    assert.equal(h.manager.roomIdForTurn("s1"), rB.roomId, "rB 归属保持");
    assert.ok(h.busy.has("s1"), "rB 回合继续");
    assert.ok(!(fu().get("s1") ?? []).some((it) => it.roomId === rA.roomId), "rA 队列已清");
  });

  it("删除房间取消 pending 期间真实 cancel 事件先到：confirm 后他房队列只补发一次", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("delA3", [{ sessionId: "s1", name: "coder" }], "mention");
    const rB = h.rooms.create("keepB3", [{ sessionId: "s1", name: "coder" }], "mention");
    await h.manager.handle(rA, "@coder TASK_A", {});
    await h.manager.handle(rB, "@coder TASK_B", {});
    assert.ok(h.busy.has("s1"));

    let releaseCancel!: () => void;
    const gate = new Promise<void>((r) => (releaseCancel = r));
    h.agent.cancel = async (sid) => {
      h.cancelled.push(sid);
      await gate;
      h.busy.delete(sid);
    };

    h.rooms.delete(rA.roomId);
    h.manager.onRoomRemoved(rA.roomId);
    await tick();
    assert.deepEqual(h.cancelled, ["s1"], "native cancel 已发起");

    h.manager.onSessionCancelled("s1");
    await tick();
    await tick();
    assert.equal(h.calls.length, 1, "cancel 未确认前他房队列不得补发");

    releaseCancel();
    await tick();
    await tick();
    await tick();
    const bCalls = h.calls.filter((c) => text(c.content).includes("TASK_B"));
    assert.equal(bCalls.length, 1, "confirm 后他房队列只补发一次");
    assert.equal(bCalls[0]!.roomIdAtDispatch, rB.roomId, "补发归属 rB");
  });

  it("批量删除两房：共享成员回合只取消一次，活房回合不受影响", async () => {
    const h = queueHarness();
    const rA = h.rooms.create("delA4", [{ sessionId: "s1", name: "coder" }], "mention");
    const rB = h.rooms.create("delB4", [{ sessionId: "s1", name: "coder" }], "mention");
    const rC = h.rooms.create("keepC4", [{ sessionId: "s2", name: "tester" }], "mention");
    await h.manager.handle(rA, "@coder TASK_A", {});
    await h.manager.handle(rB, "@coder TASK_B", {});
    await h.manager.handle(rC, "@tester TASK_C", {});
    assert.equal(h.manager.roomIdForTurn("s1"), rA.roomId);
    assert.equal(h.manager.roomIdForTurn("s2"), rC.roomId);

    h.rooms.delete(rA.roomId);
    h.rooms.delete(rB.roomId);
    h.manager.onRoomRemoved(rA.roomId);
    h.manager.onRoomRemoved(rB.roomId);
    await tick();
    await tick();

    assert.deepEqual(h.cancelled, ["s1"], "明确在途回合只取消一次");
    assert.equal(h.manager.roomIdForTurn("s2"), rC.roomId, "活房回合归属保持");
    assert.ok(h.busy.has("s2"), "活房回合不受影响");
    assert.equal(h.calls.filter((c) => text(c.content).includes("TASK_B")).length, 0, "已删房队列不派发");
    assert.equal(h.calls.filter((c) => text(c.content).includes("TASK_C")).length, 1);
  });
});

describe("cancelActive 归属与并发边界", () => {
  it("普通 mention 在途回合（无 conductorId）也可被本房取消", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("plain", [{ sessionId: "s1", name: "coder" }], "mention");
    const busy = new Set<string>();
    const cancelled: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      cancel: async (sid) => { cancelled.push(sid); busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "@coder TASK", {});
    assert.ok(busy.has("s1"));
    await manager.cancelActive(room.roomId, "停止");
    assert.ok(cancelled.includes("s1"), "本房在途 mention 回合应被取消");
  });

  it("共享会话忙于他房/单聊时，conductor pending 任务不误杀", async () => {
    const rooms = new RoomManager();
    const rA = rooms.create(
      "roomA",
      [
        { sessionId: "s1", name: "coder" },
        { sessionId: "s2", name: "worker" },
      ],
      "conductor",
      { conductorId: "s1" },
    );
    const rB = rooms.create("roomB", [{ sessionId: "s1", name: "coder" }], "mention");
    const busy = new Set<string>();
    const cancelled: string[] = [];
    const prompts: { sessionId: string; content: unknown }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, content) => { prompts.push({ sessionId: sid, content }); busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      cancel: async (sid) => { cancelled.push(sid); busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(rB, "@coder TASK_B", {});
    assert.equal(manager.roomIdForTurn("s1"), rB.roomId);
    const conductor = (manager as unknown as { conductor: { flows: Map<string, { tasks: Map<string, { sessionId: string; status: string }> }> } }).conductor;
    const flow = { roomId: rA.roomId, phase: "working", tasks: new Map([["t1", { sessionId: "s1", status: "pending" }]]) };
    conductor.flows.set(rA.roomId, flow as never);
    assert.equal(manager.roomIdForTurn("s1"), rB.roomId, "promptRooms 优先于 conductor pending");
    await manager.cancelActive(rA.roomId, "停止A");
    assert.ok(!cancelled.includes("s1"), "s1 忙于 rB 回合，不得被 rA pending 任务误杀");
    assert.ok(busy.has("s1"));
    assert.equal(manager.roomIdForTurn("s1"), rB.roomId);
  });
});

describe("统一外发 seam 与回合票据", () => {
  it("conductor 派发经 manager seam 登记 promptRooms 归属", async () => {
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
    const busy = new Set<string>();
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "goal", {
      params: { tasks: [{ id: "t1", to: "coder", task: "实现", dependsOn: [] }] },
    });
    const inner = manager as unknown as { promptRooms: Map<string, string> };
    assert.equal(inner.promptRooms.get("s2"), room.roomId, "worker 外发应登记 promptRooms");
    assert.equal(manager.roomIdForTurn("s2"), room.roomId);
  });

  it("worker done 触发同会话下一任务时，旧回合收尾不清新票据登记", async () => {
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
    const busy = new Set<string>();
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "goal", {
      params: {
        tasks: [
          { id: "t1", to: "coder", task: "第一步", dependsOn: [] },
          { id: "t2", to: "coder", task: "第二步", dependsOn: ["t1"] },
        ],
      },
    });
    const inner = manager as unknown as { promptRooms: Map<string, string>; promptTickets: Map<string, symbol> };
    assert.equal(inner.promptRooms.get("s2"), room.roomId);
    busy.delete("s2");
    await manager.onPromptDone("s2", "step1 done");
    assert.equal(inner.promptRooms.get("s2"), room.roomId, "下一任务外发后归属仍在");
    assert.ok(inner.promptTickets.has("s2"), "新回合应持有新票据");
    assert.equal(manager.roomIdForTurn("s2"), room.roomId);
  });

  it("queued pipeline 不消费其他房在途回合的 done", async () => {
    const rooms = new RoomManager();
    const rA = rooms.create("roomA", [
      { sessionId: "s1", name: "a" },
      { sessionId: "s2", name: "b" },
    ], "pipeline");
    const rB = rooms.create("roomB", [{ sessionId: "s2", name: "b" }], "mention");
    const busy = new Set<string>();
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(rB, "@b ROOM_B_TASK", {});
    await manager.handle(rA, "pipeline task", { params: { order: ["s1", "s2"] } });
    busy.delete("s1");
    await manager.onPromptDone("s1", "stage1 out");
    const fu = () => (manager as unknown as { followUps: Map<string, { roomId: string }[]> }).followUps;
    assert.ok(fu().get("s2")?.some((it) => it.roomId === rA.roomId), "roomA stage2 应排队");
    assert.equal(manager.roomIdForTurn("s2"), rB.roomId);
    busy.delete("s2");
    await manager.onPromptDone("s2", "ROOM_B_OUTPUT");
    const view = manager.getFlow(rA.roomId) as { phase?: string; tasks?: { status: string }[] } | undefined;
    assert.equal(view?.phase, "working", "roomB 回合输出不得推进 roomA pipeline");
    assert.notEqual(view?.tasks?.[1]?.status, "done");
  });
});

describe("A/E 回归", () => {
  it("auto @all 与别名精确命中 mention 目标", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("auto1", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "a" },
      { sessionId: "s3", name: "b" },
    ], "auto", { conductorId: "s1" });
    room.aliases = { 评审组: ["s2", "s3"] };
    const sent: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => { sent.push(sid); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "@all 大家评估一下", {});
    assert.deepEqual(sent.sort(), ["s1", "s2", "s3"], "@all 精确全员");
    sent.length = 0;
    await manager.handle(room, "@评审组 复核这个改动", {});
    assert.deepEqual(sent.sort(), ["s2", "s3"], "别名精确命中");
  });

  it("auto 无 @ 默认回退 conductorId 单成员", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("auto2", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "a" },
    ], "auto", { conductorId: "s1" });
    const sent: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid, content) => { sent.push(sid); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    const res = await manager.handle(room, "随便聊聊今天天气", {});
    assert.ok(res.sent.length <= 1, "无 @ 不广播全员");
  });

  it("parallel >400 字输出尾部经 flow.tasks.output 可取，汇总行含引用元数据", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("par", [
      { sessionId: "s1", name: "sum" },
      { sessionId: "s2", name: "w" },
    ], "parallel", { parallelSummarizerId: "s1" });
    const busy = new Set<string>();
    const prompts: { sessionId: string; text: string }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, content) => { prompts.push({ sessionId: sid, text: String(content) }); busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "评估方案", {});
    const longTail = "X".repeat(500) + "TAIL_MARKER_12345";
    busy.delete("s2");
    await manager.onPromptDone("s2", longTail);
    busy.delete("s1");
    await manager.onPromptDone("s1", "short sum input");
    const view = manager.getFlow(room.roomId) as { tasks?: { sessionId: string; output?: string }[] } | undefined;
    const t2 = view?.tasks?.find((t) => t.sessionId === "s2");
    assert.ok(t2?.output?.includes("TAIL_MARKER_12345"), "原始输出尾部应保留在 flow.tasks.output");
    const sumPrompt = prompts.filter((p) => p.sessionId === "s1").at(-1);
    assert.ok(sumPrompt, "应有汇总 prompt");
    assert.ok(sumPrompt!.text.includes("outputLen="), "汇总行应含原始长度");
    assert.ok(sumPrompt!.text.includes(`sessionId=s2`), "汇总行应含 sessionId");
    assert.ok(sumPrompt!.text.includes(`flowId=`), "汇总行应含 flowId");
    assert.ok(sumPrompt!.text.includes(`roomId=${room.roomId}`), "汇总行应含 roomId");
  });

  it("parallel 成员 prompt 带只读 note 且不丢用户 note", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("par2", [
      { sessionId: "s1", name: "sum" },
      { sessionId: "s2", name: "w" },
    ], "parallel", { parallelSummarizerId: "s1" });
    const prompts: { sessionId: string; text: string }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, content) => { prompts.push({ sessionId: sid, text: String(content) }); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "评估方案", { note: "用户补充NOTE_ABC" });
    const memberPrompt = prompts.find((p) => p.sessionId === "s2");
    assert.ok(memberPrompt, "成员应收到 prompt");
    assert.ok(memberPrompt!.text.includes("只读分析"), "成员 prompt 应含只读约束");
    assert.ok(memberPrompt!.text.includes("用户补充NOTE_ABC"), "用户 note 不应丢失");
  });
});

describe("严格回流门控", () => {
  it("未登记单聊的旧 done 不推进排队中的 pipeline 流程", async () => {
    const rooms = new RoomManager();
    const rA = rooms.create("roomA", [
      { sessionId: "s1", name: "a" },
      { sessionId: "s2", name: "b" },
    ], "pipeline");
    const busy = new Set<string>();
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    busy.add("s1");
    await manager.handle(rA, "pipeline task", { params: { order: ["s1", "s2"] } });
    const fu = () => (manager as unknown as { followUps: Map<string, { roomId: string }[]> }).followUps;
    assert.ok(fu().get("s1")?.some((it) => it.roomId === rA.roomId), "s1 的 pipeline 阶段应排队");
    await manager.onPromptDone("s1", "DM_OLD_OUTPUT");
    const view = manager.getFlow(rA.roomId) as { phase?: string; outputs?: unknown[] } | undefined;
    assert.notEqual(view?.phase, "done", "未登记 done 不得完成 pipeline");
    busy.delete("s1");
    await manager.onPromptDone("s1", "DM_OLD_OUTPUT2");
    const inner = manager as unknown as { promptRooms: Map<string, string> };
    assert.equal(inner.promptRooms.get("s1"), rA.roomId, "收尾后排队项应真正派发并登记");
  });

  it("未登记单聊的旧 done 不消费 auto 决策上下文", async () => {
    const rooms = new RoomManager();
    const rAuto = rooms.create("autoR", [
      { sessionId: "s1", name: "host" },
      { sessionId: "s2", name: "a" },
    ], "auto", { conductorId: "s1" });
    const busy = new Set<string>();
    const agent: AgentOps = {
      prompt: async (sid) => { busy.add(sid); },
      isBusy: (sid) => busy.has(sid),
      has: () => true,
      cancel: async (sid) => { busy.delete(sid); },
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    busy.add("s1");
    await manager.handle(rAuto, "帮我评估这个方案", {});
    const autoDec = () => (manager as unknown as { autoDecisions: Map<string, { roomId: string }> }).autoDecisions;
    assert.ok(autoDec().has(rAuto.roomId), "auto 决策应已登记（prompt 排队中）");
    await manager.onPromptDone("s1", "DM_DONE");
    assert.ok(autoDec().has(rAuto.roomId), "未登记 done 不得消费 auto 决策");
    busy.delete("s1");
    await manager.onPromptDone("s1", "DM_DONE2");
    const inner = manager as unknown as { promptRooms: Map<string, string> };
    assert.equal(inner.promptRooms.get("s1"), rAuto.roomId, "排队决策 prompt 应派发并登记");
  });
});
