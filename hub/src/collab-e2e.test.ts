import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { RoomManager } from "./room.js";
import { workspaceSnapshotHash, type IsolatedCheckResult } from "./conductor.js";

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
  verifyCheckId?: string;
  backendRuns?: { toolCallId: string; status: string; exitCode?: number; at: number }[];
  backendClaimMatch?: boolean;
  backendClaimStatus?: string;
};

type FlowView = {
  phase: string;
  supplements?: string[];
  tasks: FlowTaskView[];
  clarificationId?: string;
  clarificationQuestions?: string[];
};

function makeHarness(
  members: { sessionId: string; name: string }[],
  opts: Record<string, unknown> = {},
  isolatedChecks?: Readonly<Record<string, string>>,
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
    isolatedChecks,
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
      '```json\n{"goal":"交付排序模块","acceptanceCriteria":["实现完成且经独立验证","成员报告中记录命令和退出码","真实设备上完成端到端操作"],"tasks":[{"id":"t1","to":"coder","task":"实现排序模块"},{"id":"t2","to":"tester","task":"独立验证 t1","dependsOn":["t1"]}]}\n```',
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
    assert.match(reviewPrompt.text, /3\. 真实设备上完成端到端操作/);
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
    assert.match(summaryPrompt.text, /先给结论.*待确认.*实际复核/);
    assert.match(summaryPrompt.text, /验收标准：实现完成且经独立验证；成员报告中记录命令和退出码；真实设备上完成端到端操作/);
    assert.match(summaryPrompt.text, /对应任务 id 及证据来源/);
    assert.match(summaryPrompt.text, /没有明确对应证据时写「未覆盖」/);
    assert.match(summaryPrompt.text, /退出码0只说明该检查进程退出0，不代表该标准或整体目标达标/);
    assert.match(summaryPrompt.text, /成员自报/);
    assert.match(summaryPrompt.text, /并未自动执行/);

    // 9. 最终答复 → flow 进入 done，证据仍可查看但不再是活跃流程
    await h.done("s1", "最终答复：已完成实现并通过独立验证");
    assert.equal(h.manager.hasActiveFlow(h.room.roomId), false);
    const doneFlow = h.flow()!;
    assert.equal(doneFlow.phase, "done");
    assert.equal(doneFlow.tasks.find((t) => t.id === "t1")?.verificationStatus, "member_pass");
    assert.equal(
      doneFlow.tasks.find((t) => t.id === "t1")?.automaticCheck?.status,
      "not_run",
      "成员复核不能伪装成 Hub 自动检查",
    );
    const doneEvent = h.lastFlowEvent()!;
    assert.equal(doneEvent.phase, "done");
    assert.equal(doneEvent.tasks.length, 2);

    const state = h.manager.exportRuntime();
    const prompts2: Prompt[] = [];
    const manager2 = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          prompts2.push({ sessionId, text: String(content) });
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      h.rooms,
      () => {},
      0,
    );
    await manager2.importRuntime(state);
    await tick();
    const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
    assert.equal(restored?.phase, "done", "done 证据应随导出导入保留");
    assert.equal(restored?.tasks.length, 2);
    assert.equal(prompts2.length, 0, "done 恢复不得重派任何 prompt");
    manager2.resumeFlows();
    await tick();
    assert.equal(prompts2.length, 0, "resumeFlows 不得调度已完成流程");

    h.manager.onPromptError("s1");
    assert.equal(h.flow()?.phase, "done", "晚到的 conductor 错误不得抹掉已完成证据");
    assert.equal(h.flow()?.tasks.length, 2);

    await h.manager.handle(h.room, "新的任务", {});
    assert.equal(h.flow()?.phase, "planning", "新消息应开启新一轮而非残留旧 done");
    assert.equal(h.flow()?.tasks.length, 0);
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

  it("Devin 真实形态：首条 tool_call 无 status 可登记，缺退出码不计匹配", async () => {
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
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证a","dependsOn":["t1"]},{"id":"t3","to":"tester","task":"验证b","dependsOn":["t2"]},{"id":"t4","to":"tester","task":"验证c","dependsOn":["t3"]},{"id":"t5","to":"tester","task":"验证d","dependsOn":["t4"]},{"id":"t6","to":"tester","task":"验证e","dependsOn":["t5"]},{"id":"t7","to":"tester","task":"验证f","dependsOn":["t6"]},{"id":"t8","to":"tester","task":"验证g","dependsOn":["t7"]},{"id":"t9","to":"tester","task":"验证h","dependsOn":["t8"]},{"id":"t10","to":"tester","task":"验证i","dependsOn":["t9"]},{"id":"t11","to":"tester","task":"验证j","dependsOn":["t10"]}]}\n```',
    );
    await tick();
    const devinCall = (sid: string, id: string, command: string) =>
      h.manager.observeToolUpdate(sid, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        kind: "execute",
        rawInput: { command },
      });
    const upd = (sid: string, id: string, patch: Record<string, unknown>) =>
      h.manager.observeToolUpdate(sid, {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        ...patch,
      });
    devinCall("s2", "tcFull", "npm test");
    upd("s2", "tcFull", { status: "in_progress" });
    upd("s2", "tcFull", {
      status: "completed",
      rawOutput: { exitCode: 0, stdout: "8 passing", stderr: "warning" },
    });
    await h.done(
      "s2",
      '```json\n{"text":"完成","verifyCommand":"npm test","verifyExitCode":0,"verifyStdout":"8 passing","verifyStderr":"warning"}\n```',
    );
    await tick();
    devinCall("s3", "tcDev", "npm run e2e");
    upd("s3", "tcDev", { status: "in_progress" });
    upd("s3", "tcDev", { status: "completed" });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run e2e","verifyExitCode":0}\n```',
    );
    await tick();
    devinCall("s3", "tcFail", "npm run build");
    upd("s3", "tcFail", { status: "failed", rawOutput: { exitCode: 0 } });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run build","verifyExitCode":0}\n```',
    );
    await tick();
    devinCall("s3", "tcOut", "npm run other");
    upd("s3", "tcOut", {
      status: "completed",
      rawOutput: { exitCode: 0, stdout: "x", stderr: "supersecret_backend" },
    });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run other","verifyExitCode":0,"verifyStdout":"different","verifyStderr":"mismatch"}\n```',
    );
    await tick();
    devinCall("s3", "tcQuiet", "npm run quiet");
    upd("s3", "tcQuiet", { status: "completed", rawOutput: { exitCode: 0 } });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run quiet","verifyExitCode":0,"verifyStdout":"anything","verifyStderr":"anything"}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run ghost","verifyExitCode":0}\n```',
    );
    await tick();
    devinCall("s3", "tcWrong", "npm run real");
    upd("s3", "tcWrong", { status: "completed", rawOutput: { exitCode: 0 } });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run ghost","verifyExitCode":0}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyExitCode":0,"artifacts":[]}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run noexit"}\n```',
    );
    await tick();
    devinCall("s3", "tcOutOk", "npm run stdout");
    upd("s3", "tcOutOk", {
      status: "completed",
      rawOutput: { stdout: "8 passing" },
    });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run stdout","verifyExitCode":0,"verifyStdout":"8 passing"}\n```',
    );
    await tick();
    devinCall("s3", "tcOutBad", "npm run out2");
    upd("s3", "tcOutBad", {
      status: "completed",
      rawOutput: { stdout: "actual" },
    });
    await h.done(
      "s3",
      '```json\n{"text":"done","verifyCommand":"npm run out2","verifyExitCode":0,"verifyStdout":"wrong"}\n```',
    );
    await tick();
    const task = (id: string) => h.flow()!.tasks.find((t) => t.id === id)!;
    const run = (taskId: string, callId: string) =>
      task(taskId).backendRuns!.find((r) => r.toolCallId === callId)!;
    assert.equal(task("t1").backendClaimMatch, true, "命令+退出码+stdout 全一致应匹配");
    assert.equal(task("t1").backendClaimStatus, "matched");
    assert.equal(
      task("t2").backendClaimStatus,
      "backend_exit_unknown",
      "成员自报 0 但后端缺 exitCode",
    );
    assert.equal(
      task("t3").backendClaimStatus,
      "no_completed_backend_run",
      "仅 failed 运行无 completed",
    );
    assert.equal(task("t4").backendClaimStatus, "backend_mismatch");
    assert.equal(task("t5").backendClaimStatus, "backend_mismatch");
    assert.equal(task("t6").backendClaimStatus, "no_completed_backend_run");
    assert.equal(task("t7").backendClaimStatus, "backend_mismatch");
    assert.equal(task("t8").backendClaimStatus, "missing_member_command");
    assert.equal(task("t9").backendClaimStatus, "missing_member_exit_code");
    assert.equal(
      task("t10").backendClaimStatus,
      "backend_exit_unknown",
      "同命令后端缺退出码但输出一致时仍为 exit_unknown",
    );
    assert.equal(
      task("t11").backendClaimStatus,
      "backend_mismatch",
      "退出码未知且声称输出不一致时不得遮蔽为 exit_unknown",
    );
    assert.equal(run("t1", "tcFull").status, "completed");
    assert.equal(run("t1", "tcFull").exitCode, 0);
    const dev = run("t2", "tcDev");
    assert.equal(dev.status, "completed");
    assert.equal(dev.exitCode, undefined, "无 rawOutput 时退出码保持未知");
    assert.equal(task("t2").backendClaimMatch, false, "后端退出码未知时成员自报 0 不得匹配");
    assert.equal(task("t3").backendClaimMatch, false, "failed 运行不得匹配");
    assert.equal(
      task("t4").backendClaimMatch,
      false,
      "stdout/stderr hash 不一致不得匹配",
    );
    assert.equal(task("t5").backendClaimMatch, false, "后端缺 stdout/stderr 字段不得匹配");
    assert.equal(task("t6").backendClaimMatch, false, "无后端运行仅自报不得匹配");
    assert.equal(
      task("t7").backendClaimMatch,
      false,
      "后端有运行但命令 hash 不一致不得匹配",
    );
    assert.equal(
      run("t7", "tcWrong").status,
      "completed",
      "t7 应记录后端运行但不得匹配",
    );
    assert.ok(
      !JSON.stringify(h.flow()!).includes("supersecret_backend"),
      "flow 视图不得泄漏后端原始输出",
    );
    const exported = h.manager.exportRuntime();
    assert.ok(
      !JSON.stringify(exported).includes("supersecret_backend"),
      "导出状态不得泄漏后端原始输出",
    );
    const exportedDev = (
      (exported.conductor as {
        flows: {
          roomId: string;
          tasks: {
            id: string;
            backendRuns?: { toolCallId: string; commandHash?: string; exitCode?: number }[];
          }[];
        }[];
      }).flows
    )
      .find((f) => f.roomId === h.room.roomId)!
      .tasks.find((t) => t.id === "t2")!
      .backendRuns?.find((r) => r.toolCallId === "tcDev")!;
    assert.ok(exportedDev.commandHash, "导出应保留命令 hash");
    assert.equal(exportedDev.exitCode, undefined);
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
    await manager2.importRuntime(exported);
    await tick();
    const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
    const rt1 = restored!.tasks.find((t) => t.id === "t1")!;
    const rt2 = restored!.tasks.find((t) => t.id === "t2")!;
    assert.equal(rt1.backendClaimMatch, true, "恢复后重新计算字段匹配");
    assert.equal(rt1.backendClaimStatus, "matched", "恢复后枚举一致");
    assert.equal(
      restored!.tasks.find((t) => t.id === "t2")!.backendClaimStatus,
      "backend_exit_unknown",
      "恢复后枚举一致",
    );
    assert.equal(
      rt2.backendRuns?.find((r) => r.toolCallId === "tcDev")?.exitCode,
      undefined,
      "恢复后未知退出码不得伪造",
    );
    assert.ok(!JSON.stringify(restored).includes("supersecret_backend"));
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
      { unit: "npm test" },
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
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyCheckId":"unit","verifyExitCode":0,"artifacts":[{"type":"file","path":"src/sort.ts","summary":"实现"}],"automaticCheck":{"status":"blocked"}}\n```',
    );
    await tick(5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cwd, "/repo/ws");
    assert.equal(calls[0]!.command, "npm test", "必须执行预设命令而非成员字符串");
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
    assert.equal(t1.verifyCheckId, "unit", "getFlow 应输出成员报告的 check ID");
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
    const expT1 = (
      (state.conductor as {
        flows: {
          roomId: string;
          results: Record<string, { verifyCheckId?: string }>;
        }[];
      }).flows
    ).find((f) => f.roomId === h.room.roomId)!.results["t1"]!;
    assert.equal(expT1.verifyCheckId, "unit", "导出应保留成员报告的 check ID");
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
    assert.equal(rt1.verifyCheckId, "unit", "恢复后应保留合法 check ID");
    assert.equal(rt1.automaticCheck?.status, "exited_zero", "隔离检查结果应随状态恢复");
    assert.equal(rt1.automaticCheck?.exitCode, 0);
    assert.equal(rt1.automaticCheck?.snapshotHash, "b".repeat(64));
    assert.equal(
      rt1.backendClaimMatch,
      t1.backendClaimMatch,
      "恢复后匹配结果不变",
    );
    expT1.verifyCheckId = "INVALID ID!";
    const manager3 = new RoomModeManager(
      {
        prompt: async () => {},
        isBusy: () => false,
        cancel: async () => {},
      },
      h.rooms,
      () => {},
      0,
    );
    await manager3.importRuntime(state);
    const restored3 = manager3.getFlow(h.room.roomId) as FlowView | undefined;
    assert.equal(
      restored3!.tasks.find((t) => t.id === "t1")!.verifyCheckId,
      undefined,
      "非法 check ID 导入时必须被清洗",
    );
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
      { unit: "npm test" },
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
      '```json\n{"text":"A","verifyCommand":"npm test","verifyCheckId":"unit","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s3",
      '```json\n{"text":"B","verifyCommand":"npm test","verifyCheckId":"unit","artifacts":[{"type":"file","path":"b.ts","summary":"x"}]}\n```',
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

  it("隔离检查门控：无 ID 需 file+精确匹配批准命令，非法/未知 ID 一律 blocked", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "w1" },
        { sessionId: "s3", name: "w2" },
        { sessionId: "s4", name: "w3" },
        { sessionId: "s5", name: "w4" },
        { sessionId: "s6", name: "w5" },
        { sessionId: "s7", name: "w6" },
        { sessionId: "s8", name: "w7" },
        { sessionId: "s9", name: "w8" },
      ],
      { conductorId: "s1" },
      { unit: "npm test" },
    );
    const calls: string[] = [];
    h.agent.cwd = () => "/repo";
    h.agent.runIsolatedCheck = async (_cwd, command): Promise<IsolatedCheckResult> => {
      calls.push(command);
      return {
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        startedAt: 1,
        finishedAt: 2,
      };
    };
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"},{"id":"t2","to":"w2","task":"B"},{"id":"t3","to":"w3","task":"C"},{"id":"t4","to":"w4","task":"D"},{"id":"t5","to":"w5","task":"E"},{"id":"t6","to":"w6","task":"F"},{"id":"t7","to":"w7","task":"G"},{"id":"t8","to":"w8","task":"H"}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"A","verifyCommand":"npm test","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s3",
      '```json\n{"text":"B","verifyCommand":"npm test","verifyCheckId":"nope","artifacts":[{"type":"file","path":"b.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s4",
      '```json\n{"text":"C","verifyCommand":"npm run lint","verifyCheckId":"unit","artifacts":[{"type":"file","path":"c.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s5",
      '```json\n{"text":"D","verifyCommand":"npm test","verifyCheckId":"unit"}\n```',
    );
    await h.done(
      "s6",
      '```json\n{"text":"E","verifyCommand":"npm test","verifyCheckId":"nope"}\n```',
    );
    await h.done("s7", '```json\n{"text":"F","verifyCommand":"npm test"}\n```');
    await h.done(
      "s8",
      '```json\n{"text":"G","verifyCommand":"npm run lint","artifacts":[{"type":"file","path":"g.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s9",
      '```json\n{"text":"H","verifyCommand":"npm test","verifyCheckId":"INVALID ID!","artifacts":[{"type":"file","path":"h.ts","summary":"x"}]}\n```',
    );
    await tick(20);
    const tasks = h.flow()!.tasks;
    const t1 = tasks.find((t) => t.id === "t1")!;
    assert.equal(
      t1.automaticCheck?.status,
      "exited_zero",
      "无 ID + file + 精确匹配批准命令应执行",
    );
    const t2 = tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.automaticCheck?.status, "blocked");
    assert.equal(t2.automaticCheck?.reason, "check_unapproved", "未知 ID 不得执行且不回退匹配");
    const t3 = tasks.find((t) => t.id === "t3")!;
    assert.equal(t3.automaticCheck?.status, "blocked");
    assert.equal(t3.automaticCheck?.reason, "command_mismatch", "命令与预设不一致不得执行");
    assert.equal(t3.verifyCheckId, "unit", "成员报告的 ID 仍应透传给 UI");
    const t4 = tasks.find((t) => t.id === "t4")!;
    assert.equal(
      t4.automaticCheck?.status,
      "exited_zero",
      "合法预设 ID 无需文件 artifact 即可执行",
    );
    const t5 = tasks.find((t) => t.id === "t5")!;
    assert.equal(t5.automaticCheck?.status, "blocked");
    assert.equal(
      t5.automaticCheck?.reason,
      "check_unapproved",
      "无 artifact 的未知 ID 同样 blocked",
    );
    assert.equal(
      tasks.find((t) => t.id === "t6")!.automaticCheck?.status,
      "not_run",
      "无 ID 且无 artifact 保持 not_run",
    );
    const t7 = tasks.find((t) => t.id === "t7")!;
    assert.equal(t7.automaticCheck?.status, "blocked");
    assert.equal(
      t7.automaticCheck?.reason,
      "check_unapproved",
      "无 ID 且命令未获批准不得执行",
    );
    const t8 = tasks.find((t) => t.id === "t8")!;
    assert.equal(t8.automaticCheck?.status, "blocked");
    assert.equal(
      t8.automaticCheck?.reason,
      "check_unapproved",
      "显式非法 ID 不得回退为命令匹配",
    );
    assert.equal(t8.verifyCheckId, undefined, "非法 ID 不得透出 getFlow");
    assert.deepEqual(
      calls.sort(),
      ["npm test", "npm test"],
      "runner 恰调用两次且都用预设批准命令",
    );
  });

  it("隔离检查门控：原型键与非法 ID 不穿透，合法自有键 constructor 可执行", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "w1" },
        { sessionId: "s3", name: "w2" },
        { sessionId: "s4", name: "w3" },
      ],
      { conductorId: "s1" },
    );
    const calls: string[] = [];
    h.agent.cwd = () => "/repo";
    h.agent.runIsolatedCheck = async (_cwd, command): Promise<IsolatedCheckResult> => {
      calls.push(command);
      return {
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        startedAt: 1,
        finishedAt: 2,
      };
    };
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"},{"id":"t2","to":"w2","task":"B"},{"id":"t3","to":"w3","task":"C"}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"A","verifyCommand":"npm test","verifyCheckId":"constructor","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s3",
      '```json\n{"text":"B","verifyCommand":"npm test","verifyCheckId":"toString","artifacts":[{"type":"file","path":"b.ts","summary":"x"}]}\n```',
    );
    await h.done(
      "s4",
      '```json\n{"text":"C","verifyCommand":"npm test","verifyCheckId":"INVALID ID!","artifacts":[{"type":"file","path":"c.ts","summary":"x"}]}\n```',
    );
    await tick(20);
    const tasks = h.flow()!.tasks;
    const t1 = tasks.find((t) => t.id === "t1")!;
    assert.equal(t1.automaticCheck?.status, "blocked");
    assert.equal(t1.automaticCheck?.reason, "check_unapproved", "空配置下原型键不得命中");
    const t2 = tasks.find((t) => t.id === "t2")!;
    assert.equal(t2.automaticCheck?.reason, "check_unapproved", "空配置下 toString 不得命中");
    const t3 = tasks.find((t) => t.id === "t3")!;
    assert.equal(t3.automaticCheck?.reason, "check_unapproved", "非法 ID 解析时即剔除");
    assert.equal(t3.verifyCheckId, undefined, "非法 ID 不得透出 getFlow");
    assert.deepEqual(calls, [], "空配置下任何 ID 都不得调用 runner");
    const state = h.manager.exportRuntime();
    assert.ok(!JSON.stringify(state).includes("INVALID ID!"), "非法 ID 不得进入导出");

    const h2 = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "w1" },
      ],
      { conductorId: "s1" },
      { constructor: "npm test" },
    );
    const calls2: string[] = [];
    h2.agent.cwd = () => "/repo";
    h2.agent.runIsolatedCheck = async (_cwd, command): Promise<IsolatedCheckResult> => {
      calls2.push(command);
      return {
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        startedAt: 1,
        finishedAt: 2,
      };
    };
    await h2.manager.handle(h2.room, "任务", {});
    await h2.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"w1","task":"A"}]}\n```',
    );
    await tick();
    await h2.done(
      "s2",
      '```json\n{"text":"A","verifyCommand":"npm test","verifyCheckId":"constructor","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await tick(20);
    assert.deepEqual(calls2, ["npm test"], "显式自有键 constructor 应执行预设命令");
    assert.equal(
      h2.flow()!.tasks[0]!.automaticCheck?.status,
      "exited_zero",
    );
  });

  it("隔离检查等待期间 flow 取消或替换时丢弃旧收尾", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
      { unit: "npm test" },
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
      '```json\n{"text":"A","verifyCommand":"npm test","verifyCheckId":"unit","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
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

  it("快照失效：工作区变化后 snapshotCurrent 转 false 且验收提示历史快照", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-e2e-snap-"));
    const git = (args: string[]) =>
      execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-C", dir, ...args]);
    try {
      git(["init", "--quiet"]);
      fs.writeFileSync(path.join(dir, "marker.txt"), "v1");
      git(["add", "marker.txt"]);
      const h = makeHarness(
        [
          { sessionId: "s1", name: "leader" },
          { sessionId: "s2", name: "coder" },
        ],
        { conductorId: "s1" },
        { unit: "npm test" },
      );
      h.agent.cwd = (sid) => (sid === "s2" ? dir : "/repo");
      h.agent.runIsolatedCheck = async (): Promise<IsolatedCheckResult> => ({
        status: "exited_zero",
        runner: "bubblewrap",
        commandHash: "a".repeat(64),
        snapshotHash: workspaceSnapshotHash(dir)!,
        exitCode: 0,
        startedAt: 1,
        finishedAt: 2,
      });
      await h.manager.handle(h.room, "任务", {});
      await h.done(
        "s1",
        '```json\n{"tasks":[{"id":"t1","to":"coder","task":"A"}]}\n```',
      );
      await tick();
      await h.done(
        "s2",
        '```json\n{"text":"A","verifyCommand":"npm test","verifyCheckId":"unit","artifacts":[{"type":"file","path":"marker.txt","summary":"x"}]}\n```',
      );
      await tick(20);
      const t1 = h.flow()!.tasks.find((t) => t.id === "t1")!;
      assert.equal(t1.automaticCheck?.status, "exited_zero");
      assert.equal(
        (t1.automaticCheck as { snapshotCurrent?: boolean }).snapshotCurrent,
        true,
        "工作区未变时应为 true",
      );
      fs.writeFileSync(path.join(dir, "marker.txt"), "v2");
      const t1b = h.flow()!.tasks.find((t) => t.id === "t1")!;
      assert.equal(
        (t1b.automaticCheck as { snapshotCurrent?: boolean }).snapshotCurrent,
        false,
        "工作区变化后应为 false",
      );
      assert.equal(t1b.automaticCheck?.status, "exited_zero", "原始检查结果不得改写");
      h.agent.cwd = (sid) => (sid === "s2" ? path.join(dir, "gone") : "/repo");
      const t1c = h.flow()!.tasks.find((t) => t.id === "t1")!;
      assert.equal(
        (t1c.automaticCheck as { snapshotCurrent?: boolean }).snapshotCurrent,
        false,
        "不可访问的 cwd 应为 false",
      );
      h.agent.cwd = (sid) => (sid === "s2" ? dir : "/repo");
      await h.done("s1", '```json\n{"decision":"complete","reason":"达标"}\n```');
      const summaryPrompt = h.prompts.filter((p) => p.sessionId === "s1").at(-1)!;
      assert.ok(
        summaryPrompt.text.includes(
          "当前工作区已变化或无法核对，旧隔离检查仅对应历史快照，不得据此宣称当前版本通过。",
        ),
        "汇总 prompt 应附历史快照提醒",
      );
      const state = h.manager.exportRuntime();
      assert.ok(
        !JSON.stringify(state).includes("snapshotCurrent"),
        "派生字段不得持久化",
      );
      const manager2 = new RoomModeManager(
        {
          prompt: async () => {},
          isBusy: () => false,
          cancel: async () => {},
          cwd: () => dir,
        },
        h.rooms,
        () => {},
        0,
        { unit: "npm test" },
      );
      await manager2.importRuntime(state);
      const restored = manager2.getFlow(h.room.roomId) as FlowView | undefined;
      const rt1 = restored!.tasks.find((t) => t.id === "t1")!;
      assert.equal(rt1.automaticCheck?.status, "exited_zero", "原始结果恢复后不改写");
      assert.equal(
        (rt1.automaticCheck as { snapshotCurrent?: boolean }).snapshotCurrent,
        false,
        "恢复后应重新计算而非持久化",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("恢复闭环：求助挂起 → 导入 → 答复 → 预设检查 → 成员复核 → 验收汇总", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
      { unit: "npm test" },
    );
    const calls: { cwd: string; command: string }[] = [];
    const cwd = (sid: string) => (sid === "s2" ? "/repo/ws" : "/repo");
    const runIsolatedCheck = async (
      c: string,
      command: string,
    ): Promise<IsolatedCheckResult> => {
      calls.push({ cwd: c, command });
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
    h.agent.cwd = cwd;
    h.agent.runIsolatedCheck = runIsolatedCheck;
    await h.manager.handle(h.room, "实现排序", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"独立验证 t1","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '需要澄清\n```json\n{"help":{"to":"user","question":"用哪种算法？"}}\n```',
    );
    assert.equal(h.flow()!.tasks[0]!.waitingFor, "user");
    const state = h.manager.exportRuntime();
    const prompts2: Prompt[] = [];
    const busy2 = new Set<string>();
    const manager2 = new RoomModeManager(
      {
        prompt: async (sid, content) => {
          prompts2.push({ sessionId: sid, text: String(content) });
          busy2.add(sid);
        },
        isBusy: (sid) => busy2.has(sid),
        cancel: async (sid) => {
          busy2.delete(sid);
        },
        cwd,
        runIsolatedCheck,
      },
      h.rooms,
      () => {},
      0,
      { unit: "npm test" },
    );
    await manager2.importRuntime(state);
    await tick(5);
    assert.equal(
      prompts2.filter((p) => p.sessionId === "s2").length,
      0,
      "恢复不得重发挂起中的 worker prompt",
    );
    assert.equal(prompts2.filter((p) => p.sessionId === "s3").length, 0);
    const waiting = (manager2.getFlow(h.room.roomId) as FlowView)!.tasks.find(
      (t) => t.id === "t1",
    )!;
    assert.equal(waiting.waitingFor, "user");
    assert.ok(waiting.waitingHelpId);
    const res = await manager2.handle(h.room, "快速排序", {
      params: { intent: "answer", replyTo: waiting.waitingHelpId },
    });
    assert.deepEqual(res.sent, ["s2"], "定向答复只唤醒求助的 worker");
    await tick(5);
    const woke = prompts2.filter((p) => p.sessionId === "s2").at(-1)!;
    assert.match(woke.text, /快速排序/);
    await manager2.onPromptDone(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyCheckId":"unit","verifyExitCode":0,"artifacts":[{"type":"file","path":"src/sort.ts","summary":"快排"}]}\n```',
    );
    await tick(20);
    assert.deepEqual(
      calls.map((c) => c.command),
      ["npm test"],
      "预设检查恰好执行一次",
    );
    const t1 = (manager2.getFlow(h.room.roomId) as FlowView)!.tasks.find(
      (t) => t.id === "t1",
    )!;
    assert.equal(t1.automaticCheck?.status, "exited_zero");
    assert.equal(t1.verificationStatus, "unverified", "Hub 检查通过不等于成员复核");
    const t2p = prompts2.filter((p) => p.sessionId === "s3").at(-1)!;
    assert.match(t2p.text, /独立验证 t1/);
    await manager2.onPromptDone(
      "s3",
      '验证通过\n```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":{"summary":"npm test 8/8"}}]}\n```',
    );
    await tick(10);
    const t1v = (manager2.getFlow(h.room.roomId) as FlowView)!.tasks.find(
      (t) => t.id === "t1",
    )!;
    assert.equal(t1v.verificationStatus, "member_pass");
    assert.equal(
      t1v.backendClaimMatch,
      false,
      "成员 pass 不得当作后端/隔离复核通过",
    );
    assert.equal((manager2.getFlow(h.room.roomId) as FlowView)!.phase, "reviewing");
    const reviewPrompt = prompts2.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(reviewPrompt.text, /独立验证/);
    await manager2.onPromptDone(
      "s1",
      '```json\n{"decision":"complete","reason":"达标"}\n```',
    );
    await tick(10);
    const summaryPrompt = prompts2.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(summaryPrompt.text, /隔离检查/);
    await manager2.onPromptDone("s1", "最终答复：完成");
    assert.equal(manager2.hasActiveFlow(h.room.roomId), false);
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

  it("规划前澄清：questions 暂停派工，显式答复后恰重规划一次", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "帮我搭一个页面", {});
    await tick();
    assert.match(h.lastPrompt("s1")!.text, /questions/);

    await h.done(
      "s1",
      '```json\n{"goal":"搭建页面","acceptanceCriteria":["页面可访问"],"tasks":[],"questions":["用哪个框架？","目标平台是什么？"]}\n```',
    );
    await tick();
    const paused = h.flow()!;
    assert.equal(paused.phase, "awaiting-input", "澄清应暂停在任何派工之前");
    assert.equal(paused.tasks.length, 0);
    assert.ok(paused.clarificationId);
    assert.deepEqual(paused.clarificationQuestions, ["用哪个框架？", "目标平台是什么？"]);
    assert.ok(h.notices().some((m) => m.includes("用哪个框架？") && m.includes("目标平台")));
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s2").length,
      0,
      "澄清期间不得派发 worker",
    );

    const sup = await h.manager.handle(h.room, "随便聊聊", {});
    assert.deepEqual(sup.sent, []);
    assert.equal(h.flow()?.phase, "awaiting-input");
    assert.deepEqual(h.flow()?.supplements, ["随便聊聊"]);
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s1").length,
      1,
      "普通补充不得触发重新规划",
    );

    const empty = await h.manager.handle(h.room, "   ", {
      params: { intent: "answer", replyTo: paused.clarificationId },
    });
    assert.deepEqual(empty.sent, []);
    assert.equal(h.flow()?.phase, "awaiting-input", "空白答复不得消费澄清");
    assert.equal(h.prompts.filter((p) => p.sessionId === "s1").length, 1);
    assert.ok(
      !h.flow()!.supplements?.some((s) => !s.trim()),
      "空白答复不得落入 supplements",
    );
    assert.ok(h.notices().some((m) => m.includes("答复不能为空")));

    const ans = await h.manager.handle(h.room, "用 React，部署到 Web", {
      params: { intent: "answer", replyTo: paused.clarificationId },
    });
    assert.deepEqual(ans.sent, []);
    assert.equal(h.flow()?.phase, "planning");
    assert.equal(h.prompts.filter((p) => p.sessionId === "s1").length, 2);
    const replan = h.lastPrompt("s1")!;
    assert.match(replan.text, /帮我搭一个页面/);
    assert.match(replan.text, /用哪个框架？/);
    assert.match(replan.text, /用 React，部署到 Web/);
    assert.match(replan.text, /随便聊聊/, "等待期间的补充必须进入重规划 prompt");
    assert.match(replan.text, /不要再输出 questions/);

    const dup = await h.manager.handle(h.room, "再答一次", {
      params: { intent: "answer", replyTo: paused.clarificationId },
    });
    assert.deepEqual(dup.sent, []);
    assert.equal(h.prompts.filter((p) => p.sessionId === "s1").length, 2);

    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"}],"questions":["还想问点别的"]}\n```',
    );
    await tick();
    assert.equal(h.flow(), undefined, "第二批问题不得再次暂停或派工");
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s2").length,
      0,
      "重复提问时不得派发 worker",
    );
    assert.ok(
      h.notices().some((m) => m.includes("仍缺必要信息")),
      "必须如实告知信息仍缺、未派工",
    );
    assert.ok(!h.notices().some((m) => m.includes("无需派工")));
  });

  it("规划同时输出 questions 与 tasks 时仍先暂停澄清", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "帮我搭一个页面", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现页面"}],"questions":["用哪个框架？"]}\n```',
    );
    await tick();
    const paused = h.flow()!;
    assert.equal(paused.phase, "awaiting-input", "混合输出也必须先澄清");
    assert.equal(paused.tasks.length, 0);
    assert.deepEqual(paused.clarificationQuestions, ["用哪个框架？"]);
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s2").length,
      0,
      "混合输出不得绕过澄清直接派工",
    );

    await h.manager.handle(h.room, "其他：自建组件库，不用现成框架", {
      params: { intent: "answer", replyTo: paused.clarificationId },
    });
    assert.equal(h.flow()?.phase, "planning", "自定义答复恢复规划");
    assert.equal(h.prompts.filter((p) => p.sessionId === "s1").length, 2);
    const replan = h.lastPrompt("s1")!;
    assert.match(
      replan.text,
      /其他：自建组件库，不用现成框架/,
      "自定义答复原文必须进入重规划 prompt",
    );
    assert.deepEqual(
      h.flow()?.supplements ?? [],
      [],
      "自定义答复不得落入 supplements",
    );
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现页面"}]}\n```',
    );
    await tick();
    assert.equal(h.flow()?.phase, "working");
    assert.equal(h.prompts.filter((p) => p.sessionId === "s2").length, 1);
  });

  it("待澄清流程中定向答复「取消」按原文进入重规划而不取消流程", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "帮我搭一个页面", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[],"questions":["用现成框架还是取消这个需求？"]}\n```',
    );
    await tick();
    const paused = h.flow()!;
    assert.equal(paused.phase, "awaiting-input");

    await h.manager.handle(h.room, "取消", {
      params: { intent: "answer", replyTo: paused.clarificationId },
    });
    assert.equal(
      h.flow()?.phase,
      "planning",
      "定向答复「取消」不得取消流程，应恢复规划",
    );
    assert.equal(h.cancelled.length, 0, "不得取消任何会话");
    const replan = h.lastPrompt("s1")!;
    assert.match(replan.text, /用户答复：取消/, "答复原文必须进入重规划 prompt");

    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现页面"}]}\n```',
    );
    await tick();
    assert.equal(h.flow()?.phase, "working", "流程应正常继续而非被取消");
  });

  it("待澄清流程重启后保持暂停，答复后继续规划", async () => {
    const members = [
      { sessionId: "s1", name: "leader" },
      { sessionId: "s2", name: "coder" },
    ];
    const h = makeHarness(members, { conductorId: "s1" });
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[],"questions":["确认范围？"]}\n```',
    );
    await tick();
    const paused = h.flow()!;
    assert.equal(paused.phase, "awaiting-input");
    const clarId = paused.clarificationId!;
    const state = h.manager.exportRuntime();

    const prompts2: Prompt[] = [];
    const busy2 = new Set<string>();
    const manager2 = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          prompts2.push({ sessionId, text: String(content) });
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
    assert.equal(restored?.phase, "awaiting-input", "恢复后必须保持待确认暂停");
    assert.equal(restored?.clarificationId, clarId);
    assert.deepEqual(restored?.clarificationQuestions, ["确认范围？"]);
    assert.equal(prompts2.length, 0, "导入不得发送任何 prompt");

    manager2.resumeFlows();
    await tick();
    assert.equal(prompts2.length, 0, "resumeFlows 不得对待确认流程重发 prompt");

    const res = await manager2.handle(h.room, "答：全量范围", {});
    assert.deepEqual(res.sent, []);
    assert.equal(
      (manager2.getFlow(h.room.roomId) as FlowView | undefined)?.phase,
      "planning",
    );
    assert.equal(prompts2.filter((p) => p.sessionId === "s1").length, 1);
    const replan = prompts2.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(replan.text, /任务/);
    assert.match(replan.text, /确认范围？/);
    assert.match(replan.text, /全量范围/);

    busy2.delete("s1");
    await manager2.onPromptDone(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"}]}\n```',
    );
    await tick();
    assert.equal(
      (manager2.getFlow(h.room.roomId) as FlowView | undefined)?.phase,
      "working",
    );
    assert.match(prompts2.filter((p) => p.sessionId === "s2").at(-1)!.text, /实现/);
  });

  it("全部任务完成且无成员复核时，闲置成员收到一次质疑性复核任务", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "skeptic" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "实现排序", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现排序"}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"实现完成","verifyCommand":"npm test","verifyExitCode":0,"artifacts":[{"type":"file","path":"sort.ts","summary":"实现"}]}\n```',
    );
    await tick(20);
    const running = h.flow()!;
    assert.equal(running.phase, "working", "复核任务未完成前不得进入验收");
    const injected = running.tasks.find((t) => t.id.startsWith("peer-review"))!;
    assert.ok(injected);
    assert.equal(injected.name, "skeptic");
    const reviewPrompt = h.lastPrompt("s3")!;
    assert.match(reviewPrompt.text, /质疑/);
    assert.match(reviewPrompt.text, /verify/);
    assert.match(reviewPrompt.text, /t1/);
    assert.equal(h.prompts.filter((p) => p.sessionId === "s3").length, 1, "复核任务只派发一次");

    await h.done("s3", '```json\n{"text":"看了一遍"}\n```');
    await tick();
    assert.equal(h.flow()?.phase, "reviewing");
    const conductorReview = h.lastPrompt("s1")!;
    assert.match(conductorReview.text, /没有任何独立成员复核记录（t1）/);
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s3").length,
      1,
      "复核成员不得收到第二个注入任务",
    );

    await h.done("s1", '```json\n{"decision":"complete","reason":"达标"}\n```');
    await tick();
    const sumPrompt = h.lastPrompt("s1")!;
    assert.match(sumPrompt.text, /没有任何独立成员复核记录（t1）/);
  });

  it("已有复核记录但无闲置成员时不注入复核任务", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"完成","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":{"summary":"ok"}}]}\n```',
    );
    await tick(20);
    assert.equal(h.flow()?.phase, "reviewing");
    assert.ok(
      !h.flow()!.tasks.some((t) => t.id.startsWith("peer-review")),
      "没有闲置成员时不得注入复核任务",
    );
    assert.match(
      h.lastPrompt("s1")!.text,
      /没有任何独立成员复核记录（t2）/,
      "已复核的 t1 不应掩盖 t2 缺少独立复核",
    );

    const h2 = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h2.manager.handle(h2.room, "任务", {});
    await h2.done("s1", '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"}]}\n```');
    await tick();
    await h2.done("s2", '```json\n{"text":"完成"}\n```');
    await tick();
    assert.equal(h2.flow()?.phase, "reviewing");
    assert.match(h2.lastPrompt("s1")!.text, /没有任何独立成员复核记录（t1）/);
  });

  it("部分任务已有复核时，注入的质疑复核只覆盖未复核任务", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "tester" },
        { sessionId: "s4", name: "skeptic" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "任务", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现"},{"id":"t2","to":"tester","task":"验证","dependsOn":["t1"]}]}\n```',
    );
    await tick();
    await h.done(
      "s2",
      '```json\n{"text":"完成","artifacts":[{"type":"file","path":"a.ts","summary":"x"}]}\n```',
    );
    await tick();
    await h.done(
      "s3",
      '```json\n{"text":"验证完毕","verify":[{"task":"t1","verdict":"pass","evidence":{"summary":"ok"}}]}\n```',
    );
    await tick(20);
    const running = h.flow()!;
    assert.equal(running.phase, "working", "t2 未复核时应注入复核而非直接验收");
    const injected = running.tasks.find((t) => t.id.startsWith("peer-review"))!;
    assert.equal(injected.name, "skeptic");
    const reviewPrompt = h.lastPrompt("s4")!;
    assert.match(reviewPrompt.text, /t2/);
    assert.ok(
      !reviewPrompt.text.includes("t1、"),
      "已复核的 t1 不应列入复核目标",
    );

    await h.done("s4", '```json\n{"text":"复核 t2 通过","verify":[{"task":"t2","verdict":"pass","evidence":{"summary":"ok"}}]}\n```');
    await tick();
    assert.equal(h.flow()?.phase, "reviewing");
    assert.ok(!h.lastPrompt("s1")!.text.includes("没有任何独立成员复核记录"));
    assert.equal(
      h.prompts.filter((p) => p.sessionId === "s4").length,
      1,
      "每个 flow 至多注入一次复核任务",
    );
  });

  it("预检答复贯穿 worker/验收/汇总 prompt，导出导入后仍保留", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "做个页面", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[],"questions":["用什么技术栈？"]}\n```',
    );
    await tick();
    const clarId = h.flow()!.clarificationId!;

    const state = h.manager.exportRuntime();
    const prompts2: Prompt[] = [];
    const busy2 = new Set<string>();
    const manager2 = new RoomModeManager(
      {
        prompt: async (sessionId, content) => {
          prompts2.push({ sessionId, text: String(content) });
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
    assert.equal(restored?.phase, "awaiting-input");
    assert.equal(restored?.clarificationId, clarId);

    await manager2.handle(h.room, "必须用 React", {
      params: { intent: "answer", replyTo: clarId },
    });
    assert.equal(prompts2.filter((p) => p.sessionId === "s1").length, 1);
    busy2.delete("s1");
    await manager2.onPromptDone(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现页面"}]}\n```',
    );
    await tick();
    const workerPrompt = prompts2.filter((p) => p.sessionId === "s2").at(-1)!;
    assert.match(workerPrompt.text, /用什么技术栈？/);
    assert.match(
      workerPrompt.text,
      /必须用 React/,
      "重规划任务描述缺漏时，用户答复仍须抵达 worker prompt",
    );

    busy2.delete("s2");
    await manager2.onPromptDone("s2", '```json\n{"text":"完成"}\n```');
    await tick();
    const reviewPrompt = prompts2.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(reviewPrompt.text, /用什么技术栈？/);
    assert.match(reviewPrompt.text, /必须用 React/);

    busy2.delete("s1");
    await manager2.onPromptDone(
      "s1",
      '```json\n{"decision":"complete","reason":"达标"}\n```',
    );
    await tick();
    const summaryPrompt = prompts2.filter((p) => p.sessionId === "s1").at(-1)!;
    assert.match(summaryPrompt.text, /用什么技术栈？/);
    assert.match(summaryPrompt.text, /必须用 React/);
  });

  it("非字符串 questions 被忽略，不误暂停", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h.manager.handle(h.room, "做个页面", {});
    await h.done(
      "s1",
      '```json\n{"tasks":[{"id":"t1","to":"coder","task":"实现页面"}],"questions":[{"q":"x"},42,null,""]}\n```',
    );
    await tick();
    assert.equal(h.flow()?.phase, "working", "非法 questions 不得误暂停");
    assert.equal(h.prompts.filter((p) => p.sessionId === "s2").length, 1);

    const h2 = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h2.manager.handle(h2.room, "问题", {});
    await h2.done(
      "s1",
      '```json\n{"tasks":[],"questions":[{"q":"x"},{}]}\n```',
    );
    await tick();
    assert.equal(h2.flow()?.phase, "done", "全部非法时按无 questions 直接收尾");
    assert.equal(h2.manager.hasActiveFlow(h2.room.roomId), false);
    assert.ok(h2.notices().some((m) => m.includes("无需派工")));

    const h3 = makeHarness(
      [
        { sessionId: "s1", name: "leader" },
        { sessionId: "s2", name: "coder" },
      ],
      { conductorId: "s1" },
    );
    await h3.manager.handle(h3.room, "问题", {});
    await h3.done(
      "s1",
      '```json\n{"tasks":[],"questions":["",{"q":"x"},"  ","还剩一个问题？"]}\n```',
    );
    await tick();
    assert.equal(h3.flow()?.phase, "awaiting-input");
    assert.deepEqual(h3.flow()?.clarificationQuestions, ["还剩一个问题？"]);
  });
});
