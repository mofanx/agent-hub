import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_FORMAT_FIX_PROMPT,
  SELF_MODE_NOTE,
  autoDecisionPrompt,
  autoHistorySection,
  conductorMemberList,
  conductorPlanningPrompt,
  conductorReviewPrompt,
  conductorSummarizePrompt,
  debateJudgePrompt,
  debateTurnTask,
  describeAutomaticCheck,
  extrasBlock,
  helpRequestPrompt,
  helpResumePrompt,
  openTopicsSection,
  parallelSummarizerPrompt,
  peerReviewTaskDescription,
  pipelineStage,
  planExample,
  workerTaskPrompt,
} from "./prompts.js";

const members = [
  { sessionId: "s1", name: "leader" },
  { sessionId: "s2", name: "coder" },
  { sessionId: "s3", name: "tester" },
];

describe("prompts 模板集中化", () => {
  it("conductorMemberList 排除主持人并渲染 id", () => {
    assert.equal(
      conductorMemberList(members, "s1"),
      "coder (id: s2)、tester (id: s3)",
    );
    assert.equal(conductorMemberList([{ sessionId: "s1", name: "a" }], "s1"), "（无）");
  });

  it("planExample 用实际成员 id 生成 JSON 示例", () => {
    const example = planExample(members, "s1");
    assert.ok(example.includes('"to":"s2"'));
    assert.ok(example.includes('"to":"s3"'));
    assert.ok(example.includes('"acceptanceCriteria"'));
    // 无可用成员时回退为空 tasks 示例
    assert.ok(planExample([], "s1").includes('"tasks":[]'));
  });

  it("conductorPlanningPrompt 插值房间/成员/任务/示例/QA/产物/未结话题", () => {
    const out = conductorPlanningPrompt({
      roomName: "研发组",
      memberList: "coder (id: s2)",
      task: "实现登录",
      example: '{"goal":"x","tasks":[]}',
      qa: {
        questions: ["用什么框架？"],
        answer: "react",
        criteria: ["可登录"],
        supplements: ["兼容移动端"],
      },
      artifactLines: ["- @coder src/a.ts 文件 a"],
      openTopics: [{ ownerName: "user", text: "选型待定" }],
    });
    assert.match(out, /群聊「研发组」的指挥家/);
    assert.match(out, /coder \(id: s2\)/);
    assert.match(out, /用户任务：实现登录/);
    assert.match(out, /"tasks":\[\]/);
    assert.match(out, /你此前就本任务向用户提问/);
    assert.match(out, /react/);
    assert.match(out, /可登录/);
    assert.match(out, /兼容移动端/);
    assert.match(out, /@coder src\/a\.ts 文件 a/);
    assert.match(out, /未结话题/);
    assert.match(out, /user：选型待定/);
  });

  it("conductorPlanningPrompt 无 QA/产物/话题时不出现相关段落", () => {
    const out = conductorPlanningPrompt({
      roomName: "r",
      memberList: "m",
      task: "t",
      example: "e",
    });
    assert.ok(!out.includes("你此前就本任务向用户提问"));
    assert.ok(!out.includes("用户明确引用了以下产物"));
    assert.ok(!out.includes("未结话题"));
    assert.match(out, /输出格式要求（必须严格遵守）/);
  });

  it("workerTaskPrompt 含子任务/上游结果/补充与 artifact 报告格式", () => {
    const out = workerTaskPrompt({
      taskId: "t1",
      task: "实现排序",
      upstreamLines: ["- [t0] @a：完成"],
      qaLines: ["", "派工前向用户确认的问题与答复（务必遵循）：", "1. Q"],
      supplements: ["补充要求X"],
    });
    assert.match(out, /前置任务结果（这是你的直接输入/);
    assert.match(out, /- \[t0\] @a：完成/);
    assert.match(out, /指挥家派发给你的子任务（id: t1）：实现排序/);
    assert.match(out, /补充要求X/);
    assert.match(out, /"artifacts":\[\{"type":"file"/);
    assert.match(out, /verifyCheckId/);
    // worker 侧不携带未结话题段
    assert.ok(!out.includes("未结话题"));
  });

  it("helpRequestPrompt / helpResumePrompt 插值求助往返内容", () => {
    const req = helpRequestPrompt({
      roomName: "team",
      fromName: "coder",
      task: "起服务",
      question: "端口用哪个？",
      context: "前面报了 EADDRINUSE",
    });
    assert.match(req, /@coder 在执行子任务「起服务」时向你求助/);
    assert.match(req, /端口用哪个？/);
    assert.match(req, /EADDRINUSE/);
    const resume = helpResumePrompt({
      taskId: "t1",
      task: "起服务",
      fromLabel: "@tester",
      question: "端口？",
      answer: "用 8080",
      remaining: 1,
    });
    assert.match(resume, /id: t1/);
    assert.match(resume, /@tester 的回复：用 8080/);
    assert.match(resume, /剩余 1 次/);
    const last = helpResumePrompt({
      taskId: "t1",
      task: "起服务",
      fromLabel: "用户",
      question: "端口？",
      remaining: 0,
    });
    assert.match(last, /（未获得回复）/);
    assert.match(last, /请基于现有信息完成任务/);
  });

  it("peerReviewTaskDescription 与 describeAutomaticCheck", () => {
    assert.match(peerReviewTaskDescription(["t1", "t2"]), /已完成任务 t1、t2/);
    const c = describeAutomaticCheck({
      status: "exited_zero",
      exitCode: 0,
      snapshotHash: "a".repeat(64),
    });
    assert.match(c, /隔离检查：exited_zero,exitCode=0,snapshotHash=aaaaaaaaaaaa/);
    const stale = describeAutomaticCheck({ status: "timed_out" }, false);
    assert.match(stale, /snapshotHash=none/);
    assert.match(stale, /当前工作区已变化/);
  });

  it("conductorReviewPrompt 插值目标/标准/结果/成员/话题", () => {
    const out = conductorReviewPrompt({
      roomName: "team",
      goal: "交付排序",
      criteria: ["正确排序", "有测试"],
      iteration: 2,
      maxIterations: 3,
      resultLines: ["- [t1] @coder: 完成"],
      supplements: ["补充A"],
      hasChecks: false,
      unverifiedDone: ["t1"],
      memberList: "coder (id: s2)",
      openTopics: [{ text: "接口未定" }],
    });
    assert.match(out, /原始目标：交付排序/);
    assert.match(out, /1\. 正确排序\n2\. 有测试/);
    assert.match(out, /第 2\/3 轮子任务已全部完成/);
    assert.match(out, /- \[t1\] @coder: 完成/);
    assert.match(out, /补充A/);
    assert.match(out, /均为成员自报/);
    assert.match(out, /没有任何独立成员复核记录（t1）/);
    assert.match(out, /未结话题/);
    assert.match(out, /接口未定/);
    assert.match(out, /"decision":"complete"/);
    assert.match(out, /coder \(id: s2\)/);
  });

  it("conductorSummarizePrompt 区分全成/部分失败并携带验收结论与话题", () => {
    const ok = conductorSummarizePrompt({
      roomName: "team",
      goal: "g",
      criteria: ["c1"],
      reviewReason: "达标",
      hasFailures: false,
      resultLines: ["- [t1] @a: done"],
      hasChecks: true,
      unverifiedDone: [],
      openTopics: [{ ownerName: "user", text: "遗留问题" }],
    });
    assert.match(ok, /已全部完成/);
    assert.match(ok, /验收结论：达标/);
    assert.match(ok, /不等于隔离检查/);
    assert.match(ok, /未结话题/);
    assert.ok(!ok.includes("未能完成"));
    const partial = conductorSummarizePrompt({
      roomName: "team",
      goal: "g",
      criteria: [],
      hasFailures: true,
      resultLines: ["- [t1] @a: 失败（中断）"],
      hasChecks: false,
      unverifiedDone: [],
      failedNames: "alice、bob",
    });
    assert.match(partial, /部分完成、部分失败/);
    assert.match(partial, /以下子任务未能完成：alice、bob/);
    assert.match(partial, /验收标准：（未提供）/);
  });

  it("autoHistorySection 渲染决策反馈统计", () => {
    assert.equal(autoHistorySection([]), "");
    const out = autoHistorySection([
      { at: 1, mode: "self", reason: "简单", accepted: true },
      { at: 2, mode: "parallel", reason: "多方观点", accepted: false },
      { at: 3, mode: "mention", reason: "待定" },
    ]);
    assert.match(out, /共 2 条，被接受 1 条，被覆盖 1 条/);
    assert.match(out, /✓ self/);
    assert.match(out, /✗ parallel/);
    assert.match(out, /\? mention/);
  });

  it("autoDecisionPrompt 插值成员/黑板/历史/引用/话题/正文", () => {
    const out = autoDecisionPrompt({
      roomName: "team",
      members: "a (id: s1)",
      boardText: "- a: 结论",
      historyText: "HISTORY",
      text: "讨论方案",
      quoteText: "用户引用了 x 的消息：\"y\"\n",
      noteText: "注意：N\n",
      sessionNoteText: "注意：S\n",
      openTopics: [{ ownerName: "a", text: "话题T" }],
    });
    assert.match(out, /群聊「team」的主持人/);
    assert.match(out, /成员：a \(id: s1\)/);
    for (const mode of ["mention", "conductor", "roundrobin", "parallel", "pipeline", "debate", "self"]) {
      assert.ok(out.includes(`- ${mode}：`), `缺少模式 ${mode}`);
    }
    assert.match(out, /- a: 结论/);
    assert.ok(out.includes("HISTORY"));
    assert.match(out, /未结话题/);
    assert.match(out, /a：话题T/);
    assert.match(out, /用户引用了 x 的消息："y"\n用户消息：讨论方案/);
    assert.match(out, /注意：N\n/);
    assert.match(out, /注意：S\n/);
  });

  it("extrasBlock 与各模式模板", () => {
    assert.equal(extrasBlock(undefined), "");
    assert.equal(extrasBlock([]), "");
    assert.match(extrasBlock(["补一"]), /\n\n用户补充要求：\n- 补一/);

    const p = parallelSummarizerPrompt({
      roomName: "team",
      lines: ["- @a: 观点1"],
      extras: ["补充"],
    });
    assert.match(p, /群聊「team」的汇总者/);
    assert.match(p, /- @a: 观点1/);
    assert.match(p, /用户补充要求：\n- 补充/);

    const st0 = pipelineStage({ topic: "主题", stage: 0, note: "备注", extras: ["补"] });
    assert.match(st0.task, /备注\n\n主题/);
    assert.match(st0.task, /用户补充要求/);
    const st1 = pipelineStage({
      topic: "主题",
      stage: 1,
      quote: { author: "a", text: "旧引用" },
      prevName: "b",
      prevOutput: "上阶段输出",
    });
    assert.match(st1.task, /请继续下一阶段处理原始任务：主题/);
    assert.deepEqual(st1.quote, { author: "b", text: "上阶段输出" });

    const d = debateTurnTask({
      topic: "辩题X",
      round: 2,
      rounds: 3,
      sideIndex: 1,
      hasOpponentOutput: true,
      note: "备注",
      extras: ["补"],
    });
    assert.match(d, /第 2\/3 轮，你是反方/);
    assert.match(d, /并回应对方/);
    assert.match(d, /辩题：辩题X/);
    assert.match(d, /备注\n\n/);
    assert.match(d, /- 补/);

    const j = debateJudgePrompt({ topic: "辩题X", lines: ["- 第 1 轮 正方：a"], extras: [] });
    assert.match(j, /你是辩论裁判。辩题：辩题X/);
    assert.match(j, /- 第 1 轮 正方：a/);
    assert.ok(!j.includes("用户补充要求"));
  });

  it("openTopicsSection 空数组返回空、超 10 条截断、单条 ≤120 字符", () => {
    assert.deepEqual(openTopicsSection([]), []);
    assert.deepEqual(openTopicsSection(undefined), []);
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `话题${i}` }));
    const sec = openTopicsSection(many);
    assert.equal(sec.length, 1 + 1 + 10, "标题 + 空行 + 最多 10 条");
    const long = openTopicsSection([{ text: "x".repeat(200) }]);
    assert.equal(long[2]!.length, 2 + 120, "- 前缀 + 120 字符截断");
    const spaced = openTopicsSection([{ text: "a\n\nb   c" }]);
    assert.match(spaced[2]!, /- a b c/);
  });

  it("常量模板固定文案不变", () => {
    assert.ok(PLAN_FORMAT_FIX_PROMPT.includes("上一次规划无法解析为任务计划"));
    assert.ok(SELF_MODE_NOTE.includes("本轮由你直接作答"));
  });
});
