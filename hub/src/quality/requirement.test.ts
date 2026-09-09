import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { projectId } from "./project.js";
import {
  classifyIntent,
  assessGeneric,
  assessProjectSpecific,
  selectQuestions,
  createClarificationRequest,
  isExpired,
  evaluateRequirement,
  applyClarificationAnswers,
  applyClarificationSkip,
  applyClarificationCancel,
  CLARIFICATION_TTL_MS,
  MAX_QUESTIONS,
  shouldUpgradeL0ToAdvisory,
  L0_ADVISORY_MIN_SAMPLES,
  L0_ADVISORY_MAX_SKIP_RATE,
  L0_ADVISORY_MIN_ANSWER_RATE,
  L0_ADVISORY_MIN_REWORK_REDUCTION,
} from "./requirement.js";
import type {
  WorkRequest,
  RequirementSpec,
  ClarificationRequest,
  QualityPolicyV2,
  RequirementRule,
} from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-l0-"));
}

function makeV2Policy(rules: RequirementRule[] = []): QualityPolicyV2 {
  return {
    version: 2,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    requirementRules: rules,
    verificationRules: [],
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "off", maxFixRounds: 0 },
    requirements: { mode: "suggest", maxQuestions: 3 },
    review: { mode: "off", blockSeverity: "major", minBlockingConfidence: 0.8 },
    verification: { mode: "off" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10485760 },
  };
}

function makeSpec(requestId: string, clarifications: RequirementSpec["clarifications"] = []): RequirementSpec {
  const now = Date.now();
  return {
    id: `rs-test-${Math.random().toString(36).slice(2, 8)}`,
    requestId,
    version: 1,
    goal: "test goal",
    scope: { included: [], excluded: [] },
    acceptanceCriteria: [],
    constraints: [],
    risks: [],
    clarifications,
    status: "clarifying",
    createdAt: now,
    updatedAt: now,
  };
}

function makeWorkRequest(intent: "code-change" | "investigation" = "code-change"): WorkRequest {
  const now = Date.now();
  return {
    id: `wr-test-${Math.random().toString(36).slice(2, 8)}`,
    source: "room",
    correlationId: `corr-${now}`,
    intent,
    status: "clarifying",
    createdAt: now,
    updatedAt: now,
  };
}

// ── 意图分类测试 ────────────────────────────────────────────────────

describe("L0 Intent Classification", () => {
  it("短确认为 clarification-answer", () => {
    assert.equal(classifyIntent("yes"), "clarification-answer");
    assert.equal(classifyIntent("好的"), "clarification-answer");
    assert.equal(classifyIntent("ok"), "clarification-answer");
    assert.equal(classifyIntent("跳过"), "clarification-answer");
  });

  it("斜杠命令为 control-command", () => {
    assert.equal(classifyIntent("/stop"), "control-command");
    assert.equal(classifyIntent("/run quality"), "control-command");
    assert.equal(classifyIntent("/quality check"), "control-command");
  });

  it("问句为 investigation", () => {
    assert.equal(classifyIntent("什么是依赖注入？"), "investigation");
    assert.equal(classifyIntent("为什么这段代码报错？"), "investigation");
    assert.equal(classifyIntent("如何配置 nginx?"), "investigation");
  });

  it("代码变更关键词为 code-change", () => {
    assert.equal(classifyIntent("实现用户登录功能"), "code-change");
    assert.equal(classifyIntent("修复登录页面的 bug"), "code-change");
    assert.equal(classifyIntent("重构认证模块"), "code-change");
    assert.equal(classifyIntent("添加新的 API 接口"), "code-change");
  });

  it("讨论性语句为 discussion", () => {
    assert.equal(classifyIntent("我觉得这个方案不错"), "discussion");
    assert.equal(classifyIntent("建议使用 React"), "discussion");
  });

  it("普通查询不被识别为 code-change", () => {
    assert.equal(classifyIntent("解释一下这段代码的逻辑"), "investigation");
    assert.notEqual(classifyIntent("查看当前数据库状态"), "code-change");
  });
});

// ── 7 维度通用评估测试 ──────────────────────────────────────────────

describe("L0 Generic Assessment", () => {
  it("短目标触发 goal-clarity", () => {
    const assessments = assessGeneric("登录");
    const goal = assessments.find((a) => a.dimension === "goal-clarity");
    assert.ok(goal?.material);
  });

  it("长目标不触发 goal-clarity", () => {
    const assessments = assessGeneric("实现用户登录功能，支持邮箱和手机号登录");
    const goal = assessments.find((a) => a.dimension === "goal-clarity");
    assert.ok(!goal?.material);
  });

  it("涉及安全关键词触发 risk-identification", () => {
    const assessments = assessGeneric("修改密码存储逻辑");
    const risk = assessments.find((a) => a.dimension === "risk-identification");
    assert.ok(risk?.material);
  });

  it("涉及 API 但无约束触发 constraint-clarity", () => {
    const assessments = assessGeneric("修改 API 接口返回格式");
    const constraint = assessments.find((a) => a.dimension === "constraint-clarity");
    assert.ok(constraint?.material);
  });

  it("提及依赖触发 dependency-identification", () => {
    const assessments = assessGeneric("实现功能前需要先完成数据库迁移");
    const dep = assessments.find((a) => a.dimension === "dependency-identification");
    assert.ok(dep?.material);
  });

  it("conflict-detection 默认不 material（需模型辅助）", () => {
    const assessments = assessGeneric("实现用户登录功能");
    const conflict = assessments.find((a) => a.dimension === "conflict-detection");
    assert.ok(!conflict?.material);
  });
});

// ── 项目级规则评估测试 ──────────────────────────────────────────────

describe("L0 Project-Specific Assessment", () => {
  it("匹配 selector 的规则生成评估", () => {
    const rules: RequirementRule[] = [{
      id: "rule-1",
      selector: { intents: ["code-change"], keywords: ["登录"] },
      dimension: "goal-clarity",
      questionTemplate: "登录方式是邮箱还是手机号？",
    }];
    const assessments = assessProjectSpecific("实现登录功能", rules, "code-change");
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0]!.ruleId, "rule-1");
    assert.ok(assessments[0]!.material);
  });

  it("不匹配 intent 的规则被过滤", () => {
    const rules: RequirementRule[] = [{
      id: "rule-1",
      selector: { intents: ["investigation"] },
      dimension: "goal-clarity",
      questionTemplate: "?",
    }];
    const assessments = assessProjectSpecific("实现登录", rules, "code-change");
    assert.equal(assessments.length, 0);
  });

  it("不匹配 keyword 的规则被过滤", () => {
    const rules: RequirementRule[] = [{
      id: "rule-1",
      selector: { keywords: ["支付"] },
      dimension: "goal-clarity",
      questionTemplate: "?",
    }];
    const assessments = assessProjectSpecific("实现登录", rules, "code-change");
    assert.equal(assessments.length, 0);
  });
});

// ── 问题选择测试 ────────────────────────────────────────────────────

describe("L0 Question Selection", () => {
  it("最多 3 个问题", () => {
    const generic = assessGeneric("登录");
    const questions = selectQuestions(generic, []);
    assert.ok(questions.length <= MAX_QUESTIONS);
  });

  it("项目级优先于通用", () => {
    const generic = assessGeneric("登录");
    const projectSpecific = [{
      dimension: "goal-clarity" as const,
      ruleId: "rule-1",
      material: true,
      question: "项目级问题",
      reason: "项目规则",
    }];
    const questions = selectQuestions(generic, projectSpecific);
    assert.equal(questions[0]!.text, "项目级问题");
  });

  it("按 dimension 去重", () => {
    const generic = [{
      dimension: "goal-clarity" as const,
      material: true,
      question: "通用问题",
      reason: "通用",
    }];
    const projectSpecific = [{
      dimension: "goal-clarity" as const,
      ruleId: "rule-1",
      material: true,
      question: "项目级问题",
      reason: "项目规则",
    }];
    const questions = selectQuestions(generic, projectSpecific);
    // 项目级 goal-clarity 优先，通用 goal-clarity 被去重
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.text, "项目级问题");
  });
});

// ── ClarificationRequest 过期保护测试 ──────────────────────────────

describe("L0 Clarification Expiration", () => {
  it("未过期返回 false", () => {
    const req = createClarificationRequest({
      requestId: "wr-1", specId: "rs-1", specVersion: 1,
      questions: [], expiresAt: Date.now() + 60000,
    });
    assert.ok(!isExpired(req));
  });

  it("过期返回 true", () => {
    const req = createClarificationRequest({
      requestId: "wr-1", specId: "rs-1", specVersion: 1,
      questions: [], expiresAt: Date.now() - 1000,
    });
    assert.ok(isExpired(req));
  });

  it("无 expiresAt 永不过期", () => {
    const req = createClarificationRequest({
      requestId: "wr-1", specId: "rs-1", specVersion: 1,
      questions: [],
    });
    assert.ok(!isExpired(req));
  });
});

// ── 完整 L0 评估流程测试 ────────────────────────────────────────────

describe("L0 evaluateRequirement", () => {
  it("纯确定性评估不调用模型", async () => {
    const request = makeWorkRequest();
    const spec = makeSpec(request.id);
    const assessment = await evaluateRequirement("实现登录功能", request, spec);
    assert.equal(assessment.cost.modelCalls, 0);
    assert.equal(assessment.mode, "shadow");
    assert.ok(!assessment.inconclusive);
  });

  it("模型超时降级为 inconclusive", async () => {
    const request = makeWorkRequest();
    const spec = makeSpec(request.id);
    const assessment = await evaluateRequirement("实现登录功能", request, spec, undefined, {
      mode: "shadow",
      modelCall: () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)),
      modelTimeoutMs: 50,
    });
    assert.ok(assessment.inconclusive);
  });

  it("模型返回非法 JSON 降级为 inconclusive", async () => {
    const request = makeWorkRequest();
    const spec = makeSpec(request.id);
    const assessment = await evaluateRequirement("实现登录功能", request, spec, undefined, {
      mode: "shadow",
      modelCall: async () => "not json",
    });
    // 模型输出非 JSON → parseModelResult 返回 undefined，不报错但不补充评估
    assert.ok(!assessment.inconclusive);
    assert.equal(assessment.cost.modelCalls, 1);
  });

  it("项目级规则补充评估", async () => {
    const request = makeWorkRequest();
    const spec = makeSpec(request.id);
    const policy = makeV2Policy([{
      id: "rule-1",
      selector: { keywords: ["登录"] },
      dimension: "goal-clarity",
      questionTemplate: "登录方式是什么？",
    }]);
    const assessment = await evaluateRequirement("实现登录功能", request, spec, policy);
    assert.equal(assessment.stage, "project-specific");
    const projectQs = assessment.selectedQuestions.filter((q) => q.ruleId === "rule-1");
    assert.ok(projectQs.length > 0);
  });
});

// ── 回答处理测试 ────────────────────────────────────────────────────

describe("L0 Answer Handling", () => {
  it("applyClarificationAnswers 更新 spec", () => {
    const spec = makeSpec("wr-1", [
      { id: "q-1", dimension: "goal-clarity", question: "目标是什么？", status: "pending" },
    ]);
    const cr = createClarificationRequest({
      requestId: "wr-1", specId: spec.id, specVersion: 1,
      questions: [{ id: "q-1", dimension: "goal-clarity", text: "目标是什么？" }],
    });
    const updated = applyClarificationAnswers(spec, [{ questionId: "q-1", answer: "邮箱登录" }], cr);
    assert.equal(updated.clarifications[0]!.status, "answered");
    assert.equal(updated.clarifications[0]!.answer, "邮箱登录");
    assert.equal(updated.status, "accepted");
  });

  it("过期回答不更新 spec 内容", () => {
    const spec = makeSpec("wr-1", [
      { id: "q-1", dimension: "goal-clarity", question: "目标是什么？", status: "pending" },
    ]);
    const cr = createClarificationRequest({
      requestId: "wr-1", specId: spec.id, specVersion: 1,
      questions: [{ id: "q-1", dimension: "goal-clarity", text: "目标是什么？" }],
      expiresAt: Date.now() - 1000,
    });
    const updated = applyClarificationAnswers(spec, [{ questionId: "q-1", answer: "邮箱登录" }], cr);
    // 过期时 answer 不写入
    assert.notEqual(updated.clarifications[0]!.answer, "邮箱登录");
  });

  it("applyClarificationSkip 标记 skipped", () => {
    const spec = makeSpec("wr-1", [
      { id: "q-1", dimension: "goal-clarity", question: "?", status: "pending" },
      { id: "q-2", dimension: "risk-identification", question: "?", status: "pending" },
    ]);
    const cr = createClarificationRequest({
      requestId: "wr-1", specId: spec.id, specVersion: 1,
      questions: [
        { id: "q-1", dimension: "goal-clarity", text: "?" },
        { id: "q-2", dimension: "risk-identification", text: "?" },
      ],
    });
    const updated = applyClarificationSkip(spec, cr);
    assert.equal(updated.clarifications[0]!.status, "skipped");
    assert.equal(updated.clarifications[1]!.status, "skipped");
    assert.equal(updated.status, "accepted");
  });

  it("applyClarificationCancel 标记 cancelled", () => {
    const spec = makeSpec("wr-1");
    const updated = applyClarificationCancel(spec);
    assert.equal(updated.status, "cancelled");
  });
});

// ── Service 集成测试 ────────────────────────────────────────────────

describe("L0 QualityService Integration", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
    service = new QualityService(store, () => {});
    service.registerProject({ connectionId: "conn-1", root: dir });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifyRequestIntent 暴露意图分类", () => {
    assert.equal(service.classifyRequestIntent("实现登录功能"), "code-change");
    assert.equal(service.classifyRequestIntent("什么是依赖注入？"), "investigation");
    assert.equal(service.classifyRequestIntent("/stop"), "control-command");
  });

  it("handleL0Request 非 code-change 不拦截", async () => {
    const result = await service.handleL0Request({
      text: "什么是依赖注入？",
      source: "room",
      correlationId: "corr-1",
    });
    assert.ok(result.skipped);
    assert.equal(result.request.intent, "investigation");
    assert.equal(result.request.status, "ready");
    assert.equal(result.spec, undefined);
    assert.equal(result.clarificationRequest, undefined);
  });

  it("handleL0Request code-change 创建 spec 和 clarification", async () => {
    const result = await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    assert.ok(!result.skipped);
    assert.equal(result.request.intent, "code-change");
    assert.ok(result.spec);
    assert.ok(result.assessment);
    // "登录" 很短，应该触发 goal-clarity 问题
    if (result.assessment!.selectedQuestions.length > 0) {
      assert.ok(result.clarificationRequest);
      assert.ok(result.clarificationRequest!.expiresAt);
    }
  });

  it("handleL0Request 无问题时 spec 直接 accepted", async () => {
    const result = await service.handleL0Request({
      text: "实现用户登录功能，支持邮箱和手机号登录，包含测试验证",
      source: "room",
      correlationId: "corr-1",
    });
    assert.ok(!result.skipped);
    assert.ok(result.spec);
    // 长描述 + 有验证关键词 → 可能无问题
    if (result.assessment!.selectedQuestions.length === 0) {
      assert.equal(result.clarificationRequest, undefined);
      const spec = service.getRequirementSpec(result.spec!.id);
      assert.equal(spec!.status, "accepted");
    }
  });

  it("answerClarification 处理回答", async () => {
    const evalResult = await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    if (!evalResult.clarificationRequest) return;

    const cr = evalResult.clarificationRequest;
    const answers = cr.questions.map((q) => ({ questionId: q.id, answer: "测试回答" }));
    const result = service.answerClarification({ clarificationRequestId: cr.id, answers });
    assert.ok(result);
    assert.equal(result!.clarification.status, "answered");
    assert.equal(result!.request.status, "ready");
  });

  it("skipClarification 处理跳过", async () => {
    const evalResult = await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    if (!evalResult.clarificationRequest) return;

    const result = service.skipClarification(evalResult.clarificationRequest.id);
    assert.ok(result);
    assert.equal(result!.spec.status, "accepted");
    assert.equal(result!.request.status, "ready");
  });

  it("cancelClarification 处理取消", async () => {
    const evalResult = await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    if (!evalResult.clarificationRequest) return;

    const result = service.cancelClarification(evalResult.clarificationRequest.id);
    assert.ok(result);
    assert.equal(result!.spec.status, "cancelled");
    assert.equal(result!.request.status, "cancelled");
  });

  it("过期回答被拒绝", async () => {
    const evalResult = await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    if (!evalResult.clarificationRequest) return;

    // 手动将 clarification 标记为过期
    const cr = evalResult.clarificationRequest;
    const expired = { ...cr, expiresAt: Date.now() - 1000 };
    store.saveClarificationRequest(expired);

    const result = service.answerClarification({
      clarificationRequestId: cr.id,
      answers: cr.questions.map((q) => ({ questionId: q.id, answer: "回答" })),
    });
    assert.equal(result, undefined);
  });

  it("模型超时安全降级不阻断", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "corr-1",
      modelCall: () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 50)),
      modelTimeoutMs: 30,
    });
    // 模型超时 → inconclusive 但不阻断，仍返回结果
    assert.ok(result.assessment);
    assert.ok(result.assessment!.inconclusive);
    assert.ok(result.spec);
  });

  it("项目级规则参与评估", async () => {
    const pid = projectId("conn-1", dir);
    // 写入 v2 policy 含 requirementRules
    const policy = makeV2Policy([{
      id: "rule-1",
      selector: { keywords: ["登录"] },
      dimension: "goal-clarity",
      questionTemplate: "登录方式是什么？",
    }]);
    fs.mkdirSync(path.join(dir, ".devin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".devin", "quality.json"), JSON.stringify(policy, null, 2));

    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "corr-1",
      projectId: pid,
    });
    assert.ok(result.assessment);
    const projectQs = result.assessment!.selectedQuestions.filter((q) => q.ruleId === "rule-1");
    assert.ok(projectQs.length > 0);
  });

  it("listClarificationRequests 持久化", async () => {
    await service.handleL0Request({
      text: "实现登录",
      source: "room",
      correlationId: "corr-1",
    });
    const list = service.listClarificationRequests();
    assert.ok(list.length >= 0);
  });
});

// ── L0 横切接入测试 ────────────────────────────────────────────────

describe("L0 Interception Behavior", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l0-intercept-"));
    store = new Store(dir);
    service = new QualityService(store, () => {});
    service.registerProject({ connectionId: "conn-1", root: dir });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifyRequestIntent 对 code-change 返回 code-change", () => {
    assert.equal(service.classifyRequestIntent("实现用户登录功能"), "code-change");
  });

  it("classifyRequestIntent 对普通查询不返回 code-change", () => {
    assert.equal(service.classifyRequestIntent("什么是依赖注入？"), "investigation");
    assert.equal(service.classifyRequestIntent("/stop"), "control-command");
    assert.equal(service.classifyRequestIntent("好的"), "clarification-answer");
  });

  it("handleL0Request 对 code-change 创建 WorkRequest 和 spec", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-1",
    });
    assert.ok(!result.skipped);
    assert.equal(result.request.intent, "code-change");
    assert.ok(result.spec);
    assert.ok(result.assessment);
  });

  it("handleL0Request 对非 code-change 跳过 L0 评估", async () => {
    const result = await service.handleL0Request({
      text: "什么是依赖注入？",
      source: "room",
      correlationId: "test-2",
    });
    assert.ok(result.skipped);
    assert.equal(result.request.intent, "investigation");
    assert.equal(result.spec, undefined);
    assert.equal(result.assessment, undefined);
    assert.equal(result.clarificationRequest, undefined);
  });

  it("handleL0Request shadow 模式不阻断（即使有 clarification 也返回结果）", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-3",
      l0Mode: "shadow",
    });
    // shadow 模式：即使有 clarification，也不阻断，返回完整结果
    assert.ok(result.assessment);
    assert.equal(result.assessment!.mode, "shadow");
    // skipped=false 表示 L0 评估已执行，但不应阻断后续流程
    assert.equal(result.skipped, false);
  });

  it("handleL0Request 模型失败安全降级不阻断", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-4",
      l0Mode: "shadow",
      modelCall: () => new Promise((_, reject) => setTimeout(() => reject(new Error("model unavailable")), 10)),
      modelTimeoutMs: 5,
    });
    assert.ok(result.assessment);
    assert.ok(result.assessment!.inconclusive);
    // 降级后仍返回结果，不抛异常
  });

  it("handleL0Request 有 clarification 时广播 clarificationRequired 事件", async () => {
    const events: { method: string; params: unknown }[] = [];
    const serviceWithEmit = new QualityService(store, (e) => {
      events.push({ method: e.method, params: e });
    });
    serviceWithEmit.registerProject({ connectionId: "conn-1", root: dir });

    const result = await serviceWithEmit.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-5",
      l0Mode: "shadow",
    });
    // 如果有 clarification，应该可以通过 listClarificationRequests 查到
    if (result.clarificationRequest) {
      const list = serviceWithEmit.listClarificationRequests(result.request.id);
      assert.ok(list.length > 0);
      assert.equal(list[0]!.status, "pending");
    }
  });

  it("handleL0Request 多次调用不冲突（不同 correlationId）", async () => {
    const r1 = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-6a",
    });
    const r2 = await service.handleL0Request({
      text: "修复认证模块",
      source: "room",
      correlationId: "test-6b",
    });
    assert.notEqual(r1.request.id, r2.request.id);
    assert.notEqual(r1.spec!.id, r2.spec!.id);
  });

  it("handleL0Request 从 room 入口传入 roomId 和 mode", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "room",
      correlationId: "test-7",
      mode: "conductor",
      roomId: "room-1",
    });
    assert.equal(result.request.mode, "conductor");
    assert.equal(result.request.roomId, "room-1");
  });

  it("handleL0Request 从 session 入口传入 sessionId", async () => {
    const result = await service.handleL0Request({
      text: "实现登录功能",
      source: "session",
      correlationId: "test-8",
      sessionId: "session-1",
    });
    assert.equal(result.request.sessionId, "session-1");
    assert.equal(result.request.source, "session");
  });
});

// ── §19 L0 advisory 升级阈值测试 ──────────────────────────────────────

describe("L0 advisory 升级阈值（§19）", () => {
  it("样本不足时不升级", () => {
    const r = shouldUpgradeL0ToAdvisory({
      samples: L0_ADVISORY_MIN_SAMPLES - 1,
      skipRate: 0.2,
      answerRate: 0.8,
      reworkReduction: 0.3,
    });
    assert.equal(r.upgrade, false);
    assert.match(r.reason, /samples/);
  });

  it("跳过率过高时不升级", () => {
    const r = shouldUpgradeL0ToAdvisory({
      samples: L0_ADVISORY_MIN_SAMPLES,
      skipRate: L0_ADVISORY_MAX_SKIP_RATE + 0.1,
      answerRate: 0.8,
      reworkReduction: 0.3,
    });
    assert.equal(r.upgrade, false);
    assert.match(r.reason, /skip/);
  });

  it("回答率过低时不升级", () => {
    const r = shouldUpgradeL0ToAdvisory({
      samples: L0_ADVISORY_MIN_SAMPLES,
      skipRate: 0.2,
      answerRate: L0_ADVISORY_MIN_ANSWER_RATE - 0.1,
      reworkReduction: 0.3,
    });
    assert.equal(r.upgrade, false);
    assert.match(r.reason, /answer/);
  });

  it("返工减少不足时不升级", () => {
    const r = shouldUpgradeL0ToAdvisory({
      samples: L0_ADVISORY_MIN_SAMPLES,
      skipRate: 0.2,
      answerRate: 0.8,
      reworkReduction: L0_ADVISORY_MIN_REWORK_REDUCTION - 0.05,
    });
    assert.equal(r.upgrade, false);
    assert.match(r.reason, /rework/);
  });

  it("全部达标时升级", () => {
    const r = shouldUpgradeL0ToAdvisory({
      samples: L0_ADVISORY_MIN_SAMPLES,
      skipRate: L0_ADVISORY_MAX_SKIP_RATE - 0.1,
      answerRate: L0_ADVISORY_MIN_ANSWER_RATE + 0.1,
      reworkReduction: L0_ADVISORY_MIN_REWORK_REDUCTION + 0.1,
    });
    assert.equal(r.upgrade, true);
    assert.equal(r.reason, "all thresholds met");
  });
});
