import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { RoomManager } from "./room.js";

type Prompt = { sessionId: string; text: string };
type Broadcast = { method: string; params: Record<string, unknown> };

type FlowTaskView = {
  id: string;
  name: string;
  status: string;
  waitingFor?: string;
  waitingQuestion?: string;
  verifications?: { by: string; verdict: string; evidence: string }[];
};

type FlowView = {
  phase: string;
  supplements?: string[];
  tasks: FlowTaskView[];
};

function makeHarness(
  members: { sessionId: string; name: string }[],
  opts: Record<string, unknown> = {},
) {
  const rooms = new RoomManager();
  const room = rooms.create("e2e", members, "conductor", opts);
  const prompts: Prompt[] = [];
  const broadcasts: Broadcast[] = [];
  const cancelled: string[] = [];
  const busy = new Set<string>();
  const agent: AgentOps = {
    prompt: async (sessionId, content) => {
      prompts.push({ sessionId, text: String(content) });
      busy.add(sessionId);
    },
    isBusy: (sid) => busy.has(sid),
    cancel: async (sid) => {
      cancelled.push(sid);
      busy.delete(sid);
    },
  };
  const manager = new RoomModeManager(
    agent,
    rooms,
    (method, params) => broadcasts.push({ method, params }),
    0,
  );
  const done = (sid: string, output: string) => {
    busy.delete(sid);
    return manager.onPromptDone(sid, output);
  };
  const lastPrompt = (sid: string) => prompts.filter((p) => p.sessionId === sid).at(-1);
  const flow = () => manager.getFlow(room.roomId) as FlowView | undefined;
  const lastFlowEvent = () =>
    broadcasts.filter((b) => b.method === "room.flowUpdate").at(-1)?.params.flow as
      | FlowView
      | undefined;
  const notices = () =>
    broadcasts
      .filter((b) => b.method === "room.notice")
      .map((b) => String(b.params.message ?? ""));
  return { rooms, room, prompts, broadcasts, cancelled, busy, manager, done, lastPrompt, flow, lastFlowEvent, notices };
}

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

describe("collab-e2e", () => {
  it("完整闭环：派工 → 向用户求助 → 答复唤醒 → 独立验证 → 验收/汇总携带证据", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );

    // 1. room.message 发起任务 → conductor 规划
    await h.manager.handle(h.room, "实现排序模块并请他人独立验证", {});
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), true);
    assert.ok(h.lastPrompt("s1")?.text.includes("指挥家"));

    await h.done(
      "s1",
      '```json\n{"goal":"交付排序模块","acceptanceCriteria":["实现完成且经独立验证"],"tasks":[{"id":"t1","to":"coder","task":"实现排序模块"},{"id":"t2","to":"tester","task":"独立验证 t1","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    assert.equal(h.flow()?.phase, "working");
    assert.ok(h.lastPrompt("s2")?.text.includes("实现排序模块"));
    assert.equal(h.prompts.filter((p) => p.sessionId === "s3").length, 0, "t2 依赖 t1，不应提前派发");

    // 2. worker 向用户求助 → flowUpdate 携带 waitingFor/waitingQuestion（客户端可消费）
    await h.done(
      "s2",
      '需要澄清\n```json\n{"help":{"to":"user","question":"排序算法用哪个？"}}\n```',
    );
    const waitingFlow = h.lastFlowEvent()!;
    const t1 = waitingFlow.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.status, "running");
    assert.equal(t1.waitingFor, "user");
    assert.match(t1.waitingQuestion ?? "", /排序算法/);
    assert.ok(h.notices().some((m) => m.includes("向你求助")));
    assert.equal(h.prompts.filter((p) => p.sessionId === "s2").length, 1, "求助期间不应重复派发");

    // 3. 用户回复任意消息 → 作为答案唤醒原任务
    const res = await h.manager.handle(h.room, "用快速排序", {});
    assert.deepEqual(res.sent, ["s2"]);
    const woke = h.lastPrompt("s2")!;
    assert.match(woke.text, /快速排序/);
    assert.match(woke.text, /实现排序模块/);
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), true);

    // 4. 执行中补充信息：不取消流程，注入后续派发/验收/汇总
    const sup = await h.manager.handle(h.room, "补充：要兼容 Windows", {});
    assert.deepEqual(sup.sent, []);
    assert.equal(h.cancelled.length, 0, "补充不应触发取消");
    assert.deepEqual(h.flow()?.supplements, ["补充：要兼容 Windows"]);
    assert.ok(h.notices().some((m) => m.includes("已并入")));

    // 5. t1 完成 → t2 派发，prompt 携带用户补充
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","artifacts":[{"type":"file","path":"src/sort.ts","summary":"快排实现"}]}\n```',
    );
    await tick();
    const t2Prompt = h.lastPrompt("s3")!;
    assert.match(t2Prompt.text, /独立验证 t1/);
    assert.match(t2Prompt.text, /兼容 Windows/, "补充应进入后续派发 prompt");

    // 6. tester 提交对 t1 的独立验证 → 记录到被验证任务
    await h.done(
      "s3",
      '复现验证通过\n```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":"npm test 8/8 通过"}]}\n```',
    );
    const verifiedFlow = h.lastFlowEvent()!;
    const verifiedT1 = verifiedFlow.tasks.find((t) => t.id === "t1")!;
    assert.equal(verifiedT1.verifications?.length, 1);
    assert.equal(verifiedT1.verifications?.[0]?.by, "tester");
    assert.equal(verifiedT1.verifications?.[0]?.verdict, "pass");
    assert.match(verifiedT1.verifications?.[0]?.evidence ?? "", /npm test 8\/8/);
    assert.ok(h.notices().some((m) => m.includes("独立验证")));
    const ev = h.rooms.getEvents(h.room.roomId).find((e) => e.action === "test" && e.taskId === "t1");
    assert.ok(ev, "事件时间轴应有验证记录");

    // 7. 全部完成 → 验收 prompt 携带独立验证与用户补充
    assert.equal(h.flow()?.phase, "reviewing");
    const reviewPrompt = h.lastPrompt("s1")!;
    assert.match(reviewPrompt.text, /独立验证/);
    assert.match(reviewPrompt.text, /npm test 8\/8/);
    assert.match(reviewPrompt.text, /兼容 Windows/);

    // 8. 验收通过 → 汇总 prompt 同样携带证据
    await h.done("s1", '```json\n{"decision":"complete","reason":"达标"}\n```');
    assert.equal(h.flow()?.phase, "summarizing");
    const summaryPrompt = h.lastPrompt("s1")!;
    assert.match(summaryPrompt.text, /npm test 8\/8/);
    assert.match(summaryPrompt.text, /兼容 Windows/);
    assert.match(summaryPrompt.text, /验证证据/);

    // 9. 最终答复 → flow 清除，flowUpdate 广播空 flow
    await h.done("s1", "最终答复：已完成实现并通过独立验证");
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), false);
    assert.equal(h.lastFlowEvent(), undefined);
  });

  it("成员间求助：派发 → 回复唤醒；显式取消词终止流程", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "做个任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现接口"}]}\n```',
    );
    await tick();

    await h.done(
      "s2",
      '需要确认\n```json\n{"help":{"to":"tester","question":"验收口径是什么？"}}\n```',
    );
    await tick();
    // 求助转达给成员：flowUpdate 中 waitingFor 解析为成员名（客户端直接显示）
    const waitingT1 = h.lastFlowEvent()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(waitingT1.waitingFor, "tester");
    assert.match(waitingT1.waitingQuestion ?? "", /验收口径/);
    const helpPrompt = h.lastPrompt("s3")!;
    assert.match(helpPrompt.text, /验收口径是什么/);
    assert.match(helpPrompt.text, /不是派工/);

    // 成员回复被消费为答案，唤醒原 worker
    await h.done("s3", "口径：覆盖率 80%");
    const woke = h.lastPrompt("s2")!;
    assert.match(woke.text, /覆盖率 80%/);
    assert.equal(h.lastFlowEvent()!.tasks.find((t) => t.id === "t1")!.waitingFor, undefined);

    // 显式取消词终止流程并 cancel 正在运行的会话
    const res = await h.manager.handle(h.room, "停止", {});
    assert.deepEqual(res.sent, []);
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), false);
    assert.ok(h.cancelled.includes("s2"), "运行中的 worker 应被取消");
  });

  it("export/import 恢复后：求助挂起与验证记录不丢失", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "实现并验证", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证 t1","dependsOn":["t1"]},{"id":"t3","to":"tester","task":"写文档","dependsOn":["t2"]}]}\n```',
    );
    await tick();
    await h.done("s2", '```json\n{"text":"实现完成","artifacts":[]}\n```');
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":"12/12 通过"}]}\n```',
    );
    await tick();
    // t3 派发后 tester 向 coder 求助 → 挂起等待
    assert.ok(h.lastPrompt("s3")?.text.includes("写文档"));
    await h.done(
      "s3",
      '```json\n{"help":{"to":"coder","question":"文档要覆盖哪些 API？"}}\n```',
    );
    await tick();
    assert.equal(h.flow()?.tasks.find((t) => t.id === "t3")?.waitingFor, "coder");

    // 导出 → 新 manager 导入（模拟 Hub 重启恢复）
    const state = h.manager.exportRuntime();
    const h2prompts: Prompt[] = [];
    const busy2 = new Set<string>();
    const manager2 = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          h2prompts.push({ sessionId, text: String(content) });
          busy2.add(sessionId);
        },
        isBusy: (sid) => busy2.has(sid),
        cancel: async (sid) => {
          busy2.delete(sid);
        },
      },
      h.rooms,
      () => {},
      0,
    );
    const done2 = (sid: string, output: string) => {
      busy2.delete(sid);
      return manager2.onPromptDone(sid, output);
    };
    await manager2.importRuntime(state);
    await tick();

    const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
    assert.ok(restored);
    const rt1 = restored!.tasks.find((t) => t.id === "t1")!;
    assert.equal(rt1.status, "done");
    assert.equal(rt1.verifications?.length, 1, "验证记录应随状态恢复");
    assert.equal(rt1.verifications?.[0]?.by, "tester");
    const rt3 = restored!.tasks.find((t) => t.id === "t3")!;
    assert.equal(rt3.status, "running");
    assert.equal(rt3.waitingFor, "coder", "挂起的求助应恢复等待状态");
    // 未送达的求助在恢复后重新派发
    assert.ok(
      h2prompts.some((p) => p.sessionId === "s2" && p.text.includes("文档要覆盖哪些 API")),
      "恢复后应重新派发成员求助",
    );

    // 恢复后成员答复仍能唤醒原任务
    await done2("s2", "覆盖公开 API 即可");
    const woke = h2prompts.filter((p) => p.sessionId === "s3").at(-1)!;
    assert.match(woke.text, /覆盖公开 API/);
    assert.match(woke.text, /写文档/);
  });

  it("parallel/pipeline/debate 流程的补充信息应体现在 flow 视图中", async () => {
    for (const mode of ["parallel", "pipeline", "debate"] as const) {
      const rooms = new RoomManager();
      const room = rooms.create(
        `${mode}-supp`,
        [
          { sessionId: "s1", name: "a" },
          { sessionId: "s2", name: "b" },
          { sessionId: "s3", name: "judge" },
        ],
        mode,
        mode === "pipeline"
          ? { pipelineOrder: ["s1", "s2"] }
          : mode === "debate"
            ? { debateSides: ["s1", "s2"], debateJudge: "s3", debateRounds: 1 }
            : { parallelSummarizerId: "s3" },
      );
      const manager = new RoomModeManager(
        { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
        rooms,
        () => {},
        0,
      );
      await manager.handle(room, "主题", { params: { targets: ["s1", "s2"] } });
      assert.equal(manager.hasActiveFlow(room.roomId), true, `${mode} flow should start`);
      await manager.handle(room, "补充：额外的约束", {});
      const flow = manager.getFlow(room.roomId) as FlowView | undefined;
      assert.ok(
        (flow?.supplements ?? []).includes("补充：额外的约束"),
        `${mode} 模式的补充应在 flow 视图中可见`,
      );
    }
  });
});
