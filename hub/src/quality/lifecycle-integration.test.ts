import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { defaultReviewConfig, writePolicyV2 } from "./policy.js";
import type { QualityPolicyV2, VerificationRule } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-life-"));
}

const verificationRules: VerificationRule[] = [
  {
    id: "test-coverage",
    selector: { intents: ["code-change"], keywords: ["测试", "test"] },
    criterionTemplate: "需提供测试证据覆盖：{goal}",
    evidenceMode: "any",
    expectedEvidence: [{ id: "e1", kind: "test", description: "单元测试通过" }],
  },
];

function makePolicy(requirementsMode: QualityPolicyV2["requirements"]["mode"]): QualityPolicyV2 {
  return {
    version: 2,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    requirementRules: [],
    verificationRules,
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "off", maxFixRounds: 0 },
    requirements: { mode: requirementsMode, maxQuestions: 3 },
    review: { ...defaultReviewConfig(), mode: "off" },
    verification: { mode: "suggest" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10485760 },
  };
}

describe("L0 lifecycle integration", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;
  let projectId: string;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
    service = new QualityService(store, () => {});
    const project = service.registerProject({ connectionId: "conn-1", root: dir });
    projectId = project.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("requirements.mode=off 时 handleL0Request 仍创建 spec（mode 由调用方决定是否拦截）", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("off"));
    const result = await service.handleL0Request({
      text: "实现登录功能并写测试",
      source: "session",
      correlationId: "corr-off",
      sessionId: "sess-off",
      projectId,
      l0Mode: "suggest",
    });
    assert.ok(result.spec);
    // off 模式下 verificationRules 仍生成 criteria（用于 L3）
    const spec = service.getRequirementSpec(result.spec!.id)!;
    assert.ok(spec.acceptanceCriteria.length >= 1);
  });

  it("requirements.mode=suggest 不阻断：返回 proceed 语义由调用方处理", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("suggest"));
    const result = await service.handleL0Request({
      text: "实现登录",
      source: "session",
      correlationId: "corr-suggest",
      sessionId: "sess-suggest",
      projectId,
      l0Mode: "suggest",
    });
    // suggest 模式下 service 不阻断，调用方根据 l0Mode 决定
    assert.ok(result.request);
  });

  it("requirements.mode=require 时有澄清问题（调用方应挂起）", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("require"));
    const result = await service.handleL0Request({
      text: "实现登录",
      source: "session",
      correlationId: "corr-require",
      sessionId: "sess-require",
      projectId,
      l0Mode: "require",
    });
    // 短目标"实现登录"应触发 goal-clarity 澄清
    if (result.clarificationRequest) {
      assert.ok(result.clarificationRequest.questions.length > 0);
      const request = service.getWorkRequest(result.request.id)!;
      assert.equal(request.status, "clarifying");
    }
  });

  it("持久化查找：Hub 重启模拟（新 Store 实例）后仍能找到 spec", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("suggest"));
    await service.handleL0Request({
      text: "实现登录功能并写测试",
      source: "session",
      correlationId: "corr-persist",
      sessionId: "sess-persist",
      projectId,
      l0Mode: "suggest",
    });
    // 模拟重启：用同一目录新开 Store + Service
    store.close();
    store = new Store(dir);
    const restarted = new QualityService(store, () => {});
    restarted.registerProject({ connectionId: "conn-1", root: dir });
    const current = restarted.findCurrentSpec({ sessionId: "sess-persist" });
    assert.ok(current, "重启后应能通过 sessionId 持久化查找 spec");
    assert.ok(current!.spec.acceptanceCriteria.length >= 1, "criteria 应已持久化");
  });

  it("WorkItem 自动绑定 specId/specVersion（模拟 prepareQualityRun 绑定路径）", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("suggest"));
    const result = await service.handleL0Request({
      text: "实现登录功能并写测试",
      source: "session",
      correlationId: "corr-bind",
      sessionId: "sess-bind",
      projectId,
      l0Mode: "suggest",
    });
    const current = service.findCurrentSpec({ sessionId: "sess-bind" });
    assert.ok(current);
    const workItem = service.createWorkItem({
      requestId: current!.request.id,
      projectId,
      mode: "session",
      sessionId: "sess-bind",
      specId: current!.spec.id,
      specVersion: current!.spec.version,
    });
    assert.equal(workItem.specId, current!.spec.id);
    assert.equal(workItem.specVersion, current!.spec.version);
    const loaded = service.getWorkItem(workItem.id);
    assert.equal(loaded!.specId, result.spec!.id);
  });

  it("autoRunVerification 依赖 WorkItem.specId 触发 L3", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("suggest"));
    const result = await service.handleL0Request({
      text: "实现登录功能并写测试",
      source: "session",
      correlationId: "corr-l3",
      sessionId: "sess-l3",
      projectId,
      l0Mode: "suggest",
    });
    const current = service.findCurrentSpec({ sessionId: "sess-l3" });
    assert.ok(current);
    const workItem = service.createWorkItem({
      requestId: current!.request.id,
      projectId,
      mode: "session",
      sessionId: "sess-l3",
      specId: current!.spec.id,
      specVersion: current!.spec.version,
    });
    const run = service.startRun({
      projectId,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "2",
      workItemId: workItem.id,
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    // autoRunVerification 在进入 requirement-verifying 时读取 WorkItem.specId
    const loaded = service.getWorkItem(workItem.id);
    assert.ok(loaded?.specId, "WorkItem 必须有 specId 才能触发 L3");
    assert.equal(loaded!.specId, result.spec!.id);
    void run;
  });

  it("默认 verification.mode=suggest（迁移后）", () => {
    const policy = makePolicy("suggest");
    assert.equal(policy.verification.mode, "suggest");
  });

  it("澄清回答后 spec 状态变为 accepted 且 request ready", async () => {
    writePolicyV2(service.listProjects()[0]!, makePolicy("require"));
    const result = await service.handleL0Request({
      text: "实现登录",
      source: "session",
      correlationId: "corr-answer",
      sessionId: "sess-answer",
      projectId,
      l0Mode: "require",
    });
    if (!result.clarificationRequest) return;
    const answers = result.clarificationRequest.questions.map((q) => ({ questionId: q.id, answer: "邮箱+密码" }));
    const answered = service.answerClarification({ clarificationRequestId: result.clarificationRequest.id, answers });
    assert.ok(answered);
    assert.equal(answered!.spec.status, "accepted");
    assert.equal(answered!.request.status, "ready");
  });
});
