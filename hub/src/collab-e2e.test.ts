import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { RoomManager } from "./room.js";
import type { IsolatedCheckResult } from "./conductor.js";

type Prompt = { sessionId: string; text: string };
type Broadcast = { method: string; params: Record<string, unknown> };

type FlowTaskView = {
  id: string;
  name: string;
  status: string;
  waitingFor?: string;
  waitingQuestion?: string;
  waitingHelpId?: string;
  verifications?: { by: string; verdict: string; evidence: string; evidenceDetail?: Record<string, unknown>; backendToolCallId?: string }[];
  verificationStatus?: string;
  automaticCheck?: {
    status: string;
    exitCode?: number;
    snapshotHash?: string;
    reason?: string;
  };
  verifyCommand?: string;
  verifyExitCode?: number;
  verifyStdout?: string;
  backendRuns?: { toolCallId: string; status: string; exitCode?: number; at: number }[];
  backendClaimMatch?: boolean;
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
  return { rooms, room, prompts, broadcasts, cancelled, busy, agent, manager, done, lastPrompt, flow, lastFlowEvent, notices };
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

    // 3. 追问不当作答案（hub-test 实踩路径）；客户端显式答复（intent=answer + replyTo）唤醒原任务
    const followUp = await h.manager.handle(h.room, "问的是什么问题呀？", {});
    assert.deepEqual(followUp.sent, []);
    const waitingT1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(waitingT1.waitingFor, "user");
    assert.ok(waitingT1.waitingHelpId, "flow 视图应暴露 waitingHelpId 供客户端定向答复");
    const res = await h.manager.handle(h.room, "用快速排序", {
      params: { intent: "answer", replyTo: waitingT1.waitingHelpId },
    });
    assert.deepEqual(res.sent, ["s2"]);
    const woke = h.lastPrompt("s2")!;
    assert.match(woke.text, /快速排序/);
    assert.match(woke.text, /实现排序模块/);
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), true);

    // 4. 执行中补充信息：不取消流程，注入后续派发/验收/汇总
    const sup = await h.manager.handle(h.room, "补充：要兼容 Windows", {});
    assert.deepEqual(sup.sent, []);
    assert.equal(h.cancelled.length, 0, "补充不应触发取消");
    assert.deepEqual(h.flow()?.supplements, [
      "问的是什么问题呀？",
      "补充：要兼容 Windows",
    ]);
    assert.ok(h.notices().some((m) => m.includes("已并入")));

    // 5. t1 完成 → t2 派发，prompt 携带用户补充
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","artifacts":[{"type":"file","path":"src/sort.ts","summary":"快排实现"}],"verifyCommand":"npm test","verifyExitCode":0,"verifyStdout":"8 passing","automaticCheck":{"status":"passed"},"verificationStatus":"passed"}\n```',
    );
    await tick();
    const t2Prompt = h.lastPrompt("s3")!;
    assert.match(t2Prompt.text, /独立验证 t1/);
    assert.match(t2Prompt.text, /兼容 Windows/, "补充应进入后续派发 prompt");
    const selfReportedT1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(selfReportedT1.verifyCommand, "npm test");
    assert.equal(selfReportedT1.verifyExitCode, 0);
    assert.equal(
      selfReportedT1.verificationStatus,
      "unverified",
      "成员未复核前，自报 exitCode=0 不能提升验证状态",
    );
    assert.equal(
      selfReportedT1.automaticCheck?.status,
      "not_run",
      "worker JSON 伪造的 automaticCheck/verificationStatus 应被忽略",
    );

    // 6. tester 提交对 t1 的独立验证 → 记录到被验证任务
    await h.done(
      "s3",
      '复现验证通过\n```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":{"summary":"npm test 8/8 通过","command":"npm test","exitCode":0,"stdout":"8 passing"}}]}\n```',
    );
    const verifiedFlow = h.lastFlowEvent()!;
    const verifiedT1 = verifiedFlow.tasks.find((t) => t.id === "t1")!;
    assert.equal(verifiedT1.verifications?.length, 1);
    assert.equal(verifiedT1.verifications?.[0]?.by, "tester");
    assert.equal(verifiedT1.verifications?.[0]?.verdict, "pass");
    assert.match(verifiedT1.verifications?.[0]?.evidence ?? "", /npm test 8\/8/);
    assert.equal(verifiedT1.verifications?.[0]?.evidenceDetail?.summary, "npm test 8/8 通过");
    assert.equal(verifiedT1.verificationStatus, "member_pass", "跨成员 pass 后为成员判断通过");
    assert.equal(
      verifiedT1.automaticCheck?.status,
      "not_run",
      "成员自报的 command/exitCode/stdout 不能算作 Hub 自动检查",
    );
    assert.ok(h.notices().some((m) => m.includes("独立验证")));
    const ev = h.rooms.getEvents(h.room.roomId).find((e) => e.action === "test" && e.taskId === "t1");
    assert.ok(ev, "事件时间轴应有验证记录");

    // 7. 全部完成 → 验收 prompt 携带独立验证与用户补充
    assert.equal(h.flow()?.phase, "reviewing");
    const reviewPrompt = h.lastPrompt("s1")!;
    assert.match(reviewPrompt.text, /独立验证/);
    assert.match(reviewPrompt.text, /npm test 8\/8/);
    assert.match(reviewPrompt.text, /兼容 Windows/);
    assert.match(reviewPrompt.text, /成员自报/);
    assert.match(reviewPrompt.text, /并未自动执行/);

    // 8. 验收通过 → 汇总 prompt 同样携带证据
    await h.done("s1", '```json\n{"decision":"complete","reason":"达标"}\n```');
    assert.equal(h.flow()?.phase, "summarizing");
    const summaryPrompt = h.lastPrompt("s1")!;
    assert.match(summaryPrompt.text, /npm test 8\/8/);
    assert.match(summaryPrompt.text, /兼容 Windows/);
    assert.match(summaryPrompt.text, /验证证据/);
    assert.match(summaryPrompt.text, /成员自报/);
    assert.match(summaryPrompt.text, /并未自动执行/);

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
    assert.equal(rt1.verificationStatus, "member_pass", "导出/导入后状态仍依据真实成员记录");
    assert.equal(rt1.automaticCheck?.status, "not_run", "旧状态不得伪造自动检查已运行");
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

  it("验证状态：非 pass 判定为 member_nonpass，所有任务始终暴露可信字段", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
        { sessionId: "s4", name: "reviewer" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "实现并验证", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证 t1","dependsOn":["t1"]},{"id":"t4","to":"reviewer","task":"复核","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    const t2pending = h.flow()!.tasks.find((t) => t.id === "t2")!;
    assert.equal(t2pending.verificationStatus, "unverified");
    assert.equal(t2pending.automaticCheck?.status, "not_run");
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyExitCode":0,"automaticCheck":{"status":"passed"},"verificationStatus":"passed"}\n```',
    );
    await tick();
    const t1Self = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1Self.verificationStatus, "unverified");
    assert.equal(t1Self.automaticCheck?.status, "not_run");
    await h.done(
      "s3",
      '```json\n{"text":"复核","verify":[{"task":"t1","verdict":" PASS ","evidence":"复述一致"}]}\n```',
    );
    const t1Pass = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1Pass.verificationStatus, "member_pass");
    assert.equal(t1Pass.automaticCheck?.status, "not_run");
    await h.done(
      "s4",
      '```json\n{"text":"二次复核","verify":[{"task":"t1","verdict":" partial ","evidence":"缺少边界测试"}]}\n```',
    );
    const t1Mixed = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1Mixed.verificationStatus, "member_nonpass", "混合 pass 与 partial 时 nonpass 优先");
  });

  it("目标未完成时不记录跨成员验证，完成后才接受", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
        { sessionId: "s4", name: "reviewer" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "实现并验证", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"并行测试"},{"id":"t3","to":"reviewer","task":"复核","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"提前复核","verify":[{"task":"t1","verdict":"pass","evidence":"伪造提前验证"}]}\n```',
    );
    const t1Early = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1Early.status, "running");
    assert.equal(t1Early.verifications, undefined, "目标仍在运行，不应记录验证");
    assert.equal(t1Early.verificationStatus, "unverified");
    assert.equal(
      h.rooms.getEvents(h.room.roomId).filter((e) => e.action === "test" && e.taskId === "t1").length,
      0,
      "未完成目标不应产生 test 事件",
    );
    await h.done("s2", '```json\n{"text":"实现完成"}\n```');
    await tick();
    await h.done(
      "s4",
      '```json\n{"text":"复核","verify":[{"task":"t1","verdict":"pass","evidence":"复核通过"}]}\n```',
    );
    const t1Done = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1Done.verifications?.length, 1, "任务完成后跨成员验证才记录");
    assert.equal(t1Done.verifications?.[0]?.by, "reviewer");
    assert.equal(t1Done.verificationStatus, "member_pass");
    assert.ok(
      h.rooms.getEvents(h.room.roomId).some((e) => e.action === "test" && e.taskId === "t1"),
      "完成后应有 test 事件",
    );
  });

  it("后端工具回传归属任务并可与成员报告字段匹配，伪造与超源数据不提升信任", async () => {
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
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证 t1","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    const toolPending = (sid: string, id: string, command: string) =>
      h.manager.observeToolUpdate(sid, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        kind: "execute",
        status: "in_progress",
        rawInput: { command },
      });
    const toolPatch = (sid: string, id: string, patch: Record<string, unknown>) =>
      h.manager.observeToolUpdate(sid, {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        ...patch,
      });
    const toolDone = (sid: string, id: string, status: string) =>
      toolPatch(sid, id, { status });
    toolDone("s2", "tc0", "completed");
    toolPatch("s2", "tc0", { rawOutput: { exitCode: 0 } });
    toolPatch("s2", "tcx", {
      kind: "read",
      status: "in_progress",
      rawInput: { command: "cat x" },
    });
    toolDone("s2", "tcx", "completed");
    toolPatch("s2", "tcz", {
      kind: "execute",
      status: "weird",
      rawInput: { command: "x" },
    });
    toolDone("s2", "tcz", "completed");
    toolPatch("s2", "tcobj", {
      kind: "execute",
      status: "in_progress",
      rawInput: { command: { nested: true } },
    });
    toolDone("s2", "tcobj", "completed");
    toolPending("s3", "tcq", "npm test");
    toolDone("s3", "tcq", "completed");
    toolPending("s2", "tc2", "npm test");
    toolPatch("s2", "tc2", {
      status: "in_progress",
      rawOutput: { exitCode: 0, stdout: "8 passing", stderr: "" },
    });
    toolPatch("s2", "tc2", {
      rawOutput: { exitCode: 0, stdout: "8 passing", stderr: "" },
    });
    toolDone("s2", "tc2", "completed");
    toolDone("s2", "tc2", "completed");
    toolPending("s2", "tc3", "npm run lint");
    toolDone("s2", "tc3", "completed");
    toolPending("s2", "tc4", "npm run build");
    toolPatch("s2", "tc4", { rawOutput: { exitCode: 0 } });
    toolDone("s2", "tc4", "failed");
    toolPending("s2", "tc6", "npm run clean");
    toolPatch("s2", "tc6", { rawOutput: { exitCode: 0 } });
    toolPatch("s2", "tc6", { status: "completed", rawOutput: null });
    toolPending("s2", "tcStale", "npm run stale");
    toolPatch("s2", "tcStale", { rawOutput: { exitCode: 0, stdout: "partial" } });
    toolPatch("s2", "tcStale", { rawOutput: { stderr: "x" } });
    toolDone("s2", "tcStale", "completed");
    toolPending("s2", "tc7", "npm test");
    toolPatch("s2", "tc7", { kind: "read" });
    toolDone("s2", "tc7", "completed");
    toolPending("s2", "tcrev", "npm run revoked");
    toolPatch("s2", "tcrev", {
      rawInput: { command: null },
      rawOutput: { exitCode: 0 },
    });
    toolDone("s2", "tcrev", "completed");
    toolPending("s2", "tcbig", "npm run big");
    toolPatch("s2", "tcbig", { rawInput: {} });
    toolPatch("s2", "tcbig", { rawInput: { command: "z".repeat(9000) } });
    toolDone("s2", "tcbig", "completed");
    toolPending("s2", "tc8", "npm test");
    toolPending("s2", "tc5", "echo supersecret");
    toolPatch("s2", "tc5", {
      rawOutput: { exitCode: 0, stdout: "supersecret token" },
    });
    toolDone("s2", "tc5", "completed");
    for (let i = 0; i < 25; i++) toolPending("s2", `cap${i}`, "npm test");
    toolDone("s2", "cap20", "completed");
    toolDone("s2", "cap24", "completed");
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyExitCode":0,"verifyStdout":"8 passing","backendClaimMatch":true,"backendRuns":[{"toolCallId":"fake"}]}\n```',
    );
    toolDone("s2", "tc8", "completed");
    await tick();
    const t1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.deepEqual(
      t1.backendRuns?.map((r) => r.toolCallId),
      ["tc2", "tc3", "tc4", "tc6", "tcStale", "tcrev", "tcbig", "tc5"],
      "未登记/非 execute/未知状态/无活跃任务/显式换 kind/超限/prompt 已清理的调用都不应入库",
    );
    assert.equal(t1.backendRuns?.[0]?.exitCode, 0, "终态缺 rawOutput 应沿用 patch 累计字段");
    assert.equal(t1.backendRuns?.[1]?.exitCode, undefined, "无退出码不得伪造");
    assert.equal(t1.backendRuns?.[2]?.status, "failed");
    assert.equal(
      t1.backendRuns?.[3]?.exitCode,
      undefined,
      "终态显式 rawOutput:null 应清除已收字段",
    );
    assert.equal(
      t1.backendRuns?.[4]?.exitCode,
      undefined,
      "rawOutput 整体替换后不得残留陈旧 exitCode",
    );
    assert.equal(t1.backendRuns?.[5]?.toolCallId, "tcrev");
    assert.equal(t1.backendRuns?.[6]?.toolCallId, "tcbig");
    assert.equal(t1.backendClaimMatch, true, "自报命令+退出码与后端回传一致");
    assert.equal(t1.verificationStatus, "unverified");
    assert.equal(t1.automaticCheck?.status, "not_run");
    assert.ok(!JSON.stringify(h.flow()).includes("supersecret"), "flow 视图不得泄漏原始命令/输出");
    const exported = h.manager.exportRuntime();
    assert.ok(
      !JSON.stringify(exported).includes("supersecret"),
      "导出状态不得泄漏原始命令/输出",
    );
    const exportedT1 = (
      (exported.conductor as { flows: {
        roomId: string;
        tasks: {
          id: string;
          backendRuns?: {
            toolCallId: string;
            commandHash?: string;
            exitCode?: number;
            stdoutHash?: string;
            stderrHash?: string;
          }[];
        }[];
      }[] }).flows
    )
      .find((f) => f.roomId === h.room.roomId)!
      .tasks.find((t) => t.id === "t1")!;
    const exportedRun = (id: string) =>
      exportedT1.backendRuns?.find((r) => r.toolCallId === id)!;
    assert.equal(
      exportedRun("tcrev").commandHash,
      undefined,
      "命令被显式 null 撤销后不得保留可信 hash",
    );
    assert.equal(
      exportedRun("tcbig").commandHash,
      undefined,
      "无 command 字段或超长命令不得保留可信 hash",
    );
    const stale = exportedRun("tcStale");
    assert.equal(stale.exitCode, undefined);
    assert.equal(stale.stdoutHash, undefined, "rawOutput 整体替换后不得残留 stdoutHash");
    assert.ok(stale.stderrHash);
    toolPending("s3", "tc9", "npm test");
    toolPatch("s3", "tc9", { rawOutput: { exitCode: 0, stdout: "8 passing" } });
    toolDone("s3", "tc9", "completed");
    toolPending("s3", "tc10", "npm run build");
    toolPatch("s3", "tc10", { rawOutput: { exitCode: 0 } });
    toolDone("s3", "tc10", "failed");
    toolPending("s3", "tc11", "npm run stale2");
    toolPatch("s3", "tc11", { rawOutput: { exitCode: 0, stdout: "y" } });
    toolPatch("s3", "tc11", { rawOutput: { stderr: "z" } });
    toolDone("s3", "tc11", "completed");
    await h.done(
      "s3",
      '```json\n{"text":"复核","verifyCommand":"npm run build","verifyExitCode":0,"verify":[{"task":"t1","verdict":"pass","backendToolCallId":"forged","evidence":{"command":"npm test","exitCode":0,"stdout":"8 passing"}},{"task":"t1","verdict":"pass","backendToolCallId":"forged2","evidence":{"command":"npm test","exitCode":1}},{"task":"t1","verdict":"pass","backendToolCallId":"forged3","evidence":{"command":"npm run stale2","exitCode":0}}]}\n```',
    );
    const vt = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(vt.verifications?.length, 3);
    assert.equal(vt.verifications?.[0]?.backendToolCallId, "tc9", "应匹配真实后端调用而非伪造字段");
    assert.equal(vt.verifications?.[1]?.backendToolCallId, undefined, "退出码不匹配不得关联");
    assert.equal(
      vt.verifications?.[2]?.backendToolCallId,
      undefined,
      "被整体替换清空的退出码不得关联",
    );
    const t2 = h.flow()!.tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.backendClaimMatch, false, "failed 且退出码为 0 的回传不得计为匹配");
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
    await manager2.importRuntime(state);
    await tick();
    const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
    const rt1 = restored!.tasks.find((t) => t.id === "t1")!;
    assert.equal(rt1.backendRuns?.length, 8, "已完成任务的后端回传应随状态恢复");
    assert.equal(rt1.backendClaimMatch, true, "恢复后重新计算字段匹配");
    assert.equal(rt1.verifications?.[0]?.backendToolCallId, "tc9");
    assert.ok(!JSON.stringify(restored).includes("supersecret"));
  });

  it("仅有成员自报验证命令时，review prompt 仍声明 Hub 未自动执行", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "实现模块", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyExitCode":0}\n```',
    );
    await tick(20);
    assert.equal(h.flow()?.phase, "reviewing");
    const reviewPrompt = h.lastPrompt("s1")!;
    assert.match(reviewPrompt.text, /成员自报/);
    assert.match(reviewPrompt.text, /并未自动执行/);
    const t1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.verificationStatus, "unverified");
    assert.equal(t1.automaticCheck?.status, "not_run");
  });

  it("Hub 隔离检查：verifyCommand+文件产物触发一次，阻塞派发并在 prompt/事件/导出中留痕", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );
    const calls: { cwd: string; command: string }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    h.agent.cwd = (sid) => (sid === "s2" ? "/repo/ws" : undefined);
    h.agent.runIsolatedCheck = async (cwd, command): Promise<IsolatedCheckResult> => {
      calls.push({ cwd, command });
      await gate;
      return {
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        exitCode: 0,
        stdoutHash: "c".repeat(64),
        startedAt: 1,
        finishedAt: 2,
      };
    };
    await h.manager.handle(h.room, "实现并验证", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证 t1","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    const donePromise = h.done(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyExitCode":0,"artifacts":[{"type":"file","path":"src/sort.ts","summary":"实现"}],"automaticCheck":{"status":"blocked"}}\n```',
    );
    await tick(5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cwd, "/repo/ws");
    assert.equal(calls[0]!.command, "npm test");
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s3").length,
      0,
      "隔离检查完成前不得派发下游验证任务",
    );
    release();
    await donePromise;
    await tick();
    const t1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.status, "done");
    assert.equal(
      t1.automaticCheck?.status,
      "exited_zero",
      "结果必须来自 Hub runner 而非成员 JSON 伪造字段",
    );
    assert.equal(t1.automaticCheck?.exitCode, 0);
    const ev = h.rooms
      .getEvents(h.room.roomId)
      .find(
        (e) => e.action === "test" && e.taskId === "t1" && e.summary.includes("隔离检查"),
      );
    assert.ok(ev);
    assert.match(ev!.summary, /exited_zero/);
    await h.done(
      "s3",
      '```json\n{"text":"复核","verify":[{"task":"t1","verdict":"pass","evidence":{"command":"npm test","exitCode":0}}]}\n```',
    );
    await tick(20);
    assert.equal(h.flow()?.phase, "reviewing");
    const reviewPrompt = h.lastPrompt("s1")!;
    assert.match(reviewPrompt.text, /隔离检查：exited_zero,exitCode=0,snapshotHash=bbbbbbbbbbbb/);
    assert.match(reviewPrompt.text, /成员自报字段不等于隔离检查/);
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
    await manager2.importRuntime(state);
    const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
    const rt1 = restored!.tasks.find((t) => t.id === "t1")!;
    assert.equal(rt1.automaticCheck?.status, "exited_zero", "隔离检查结果应随状态恢复");
    assert.equal(rt1.automaticCheck?.exitCode, 0);
    assert.equal(rt1.automaticCheck?.snapshotHash, "b".repeat(64));
    await h.done("s1", '```json\n{"decision":"complete","reason":"通过"}\n```');
    await tick(20);
    const summaryPrompt = h.lastPrompt("s1")!;
    assert.match(summaryPrompt.text, /隔离检查：exited_zero/);
    assert.match(summaryPrompt.text, /成员自报字段不等于隔离检查/);
  });

  it("隔离检查门控：缺 artifact/verifyCommand 不执行，cwd 缺失与抛错均 blocked", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
        { sessionId: "s4", name: "reviewer" },
        { sessionId: "s5", name: "extra" },
      ],
      { conductorId: "s1" },
    );
    const calls: string[] = [];
    h.agent.cwd = (sid) => (sid === "s3" ? undefined : "/repo");
    h.agent.runIsolatedCheck = async (_cwd, command): Promise<IsolatedCheckResult> => {
      calls.push(command);
      throw new Error("boom");
    };
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"A"},{"id":"t2","to":"tester","task":"B"},{"id":"t3","to":"reviewer","task":"C"},{"id":"t4","to":"extra","task":"D"}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"A","verifyCommand":"npm test","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s3",
      '```json\n{"text":"B","verifyCommand":"npm test","artifacts":[{"type":"file","path":"b.ts","summary":"x"}]}\n```',
    );
    await h.done("s4", '```json\n{"text":"C","verifyCommand":"npm test"}\n```');
    await h.done(
      "s5",
      '```json\n{"text":"D","artifacts":[{"type":"file","path":"d.ts","summary":"x"}]}\n```',
    );
    await tick(20);
    const tasks = h.flow()!.tasks;
    const t1 = tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.automaticCheck?.status, "blocked");
    assert.equal(t1.automaticCheck?.reason, "start_failed");
    const t2 = tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.automaticCheck?.status, "blocked");
    assert.equal(t2.automaticCheck?.reason, "cwd_missing", "cwd 缺失必须是静态 receipt 而非 host 回退");
    assert.equal(tasks.find((t) => t.id === "t3")!.automaticCheck?.status, "not_run");
    assert.equal(tasks.find((t) => t.id === "t4")!.automaticCheck?.status, "not_run");
    assert.deepEqual(calls, ["npm test"], "只有完整候选才调用 runner 且仅一次");
  });

  it("隔离检查等待期间 flow 取消或替换时丢弃旧收尾", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    h.agent.cwd = () => "/repo";
    h.agent.runIsolatedCheck = async (): Promise<IsolatedCheckResult> => {
      await gate;
      return {
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        snapshotHash: "b".repeat(64),
        exitCode: 0,
        startedAt: 1,
        finishedAt: 2,
      };
    };
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"A"},{"id":"t2","to":"tester","task":"B","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    const donePromise = h.done(
      "s2",
      '```json\n{"text":"A","verifyCommand":"npm test","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await tick(5);
    await h.manager.handle(h.room, "停止", {});
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), false);
    await h.manager.handle(h.room, "新目标", {});
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), true);
    release();
    await donePromise;
    await tick();
    assert.ok(
      !h.notices().some((m) => m.includes("已完成子任务 t1")),
      "取消后不得发出旧任务完成通知",
    );
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s3").length,
      0,
      "取消后不得派发旧流程下游任务",
    );
    assert.ok(
      !h.rooms.getEvents(h.room.roomId).some((e) => e.summary.includes("隔离检查")),
      "被丢弃的检查不得写孤儿 test 事件",
    );
    assert.equal(h.flow()?.phase, "planning", "替换的新 flow 应处于规划阶段");
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
