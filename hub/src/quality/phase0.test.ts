import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { validatePolicyV2, migrateV1ToV2, loadPolicyV2 } from "./policy.js";
import { projectId, registerProject as registerProjectScope } from "./project.js";
import { transition, createRun, isTerminal } from "./run.js";
import type {
  ProjectScope,
  QualityPolicy,
  QualityPolicyV2,
  WorkRequest,
  RequirementSpec,
  WorkItem,
  QualityObservation,
  QualityRun,
} from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-phase0-"));
}

function makeProject(id: string, root: string): ProjectScope {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    root,
    gitRoot: root,
    displayName: "test-project",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    policyVersion: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function makeV1Policy(): QualityPolicy {
  return {
    version: 1,
    checks: [{
      id: "typecheck", cwd: ".", argv: ["npx", "tsc", "--noEmit"],
      tier: "quick", timeoutMs: 120000, required: true,
    }],
    protectedPaths: [".devin/quality.json"],
    riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "observe",
  };
}

function makeV2Policy(): QualityPolicyV2 {
  return {
    version: 2,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    requirementRules: [],
    verificationRules: [],
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "off", maxFixRounds: 0 },
    requirements: { mode: "off", maxQuestions: 3 },
    review: { mode: "off", blockSeverity: "major", minBlockingConfidence: 0.8 },
    verification: { mode: "off" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10485760 },
  };
}

// ── Store CRUD 测试 ──────────────────────────────────────────────────

describe("Phase 0 Store CRUD", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saveWorkRequest / getWorkRequest / listWorkRequests", () => {
    const now = Date.now();
    const req: WorkRequest = {
      id: "wr-1", source: "room", correlationId: "corr-1",
      intent: "code-change", status: "received",
      roomId: "room-1", createdAt: now, updatedAt: now,
    };
    store.saveWorkRequest(req);
    const got = store.getWorkRequest("wr-1");
    assert.ok(got);
    assert.equal(got!.id, "wr-1");
    assert.equal(got!.intent, "code-change");
    assert.equal(got!.roomId, "room-1");

    const list = store.listWorkRequests("room-1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "wr-1");
  });

  it("saveRequirementSpec / getRequirementSpec / listRequirementSpecs", () => {
    const now = Date.now();
    const spec: RequirementSpec = {
      id: "rs-1", requestId: "wr-1", version: 1, goal: "实现登录功能",
      scope: { included: ["登录页"], excluded: ["注册"] },
      acceptanceCriteria: [{
        id: "ac-1", description: "用户可登录", required: true,
        evidenceMode: "all", expectedEvidence: [{ id: "e-1", kind: "test", description: "登录测试" }],
      }],
      constraints: ["不破坏现有 API"], risks: [],
      clarifications: [{ id: "c-1", dimension: "目标清晰度", question: "用什么认证?", status: "pending" }],
      status: "draft", createdAt: now, updatedAt: now,
    };
    store.saveRequirementSpec(spec);
    const got = store.getRequirementSpec("rs-1");
    assert.ok(got);
    assert.equal(got!.goal, "实现登录功能");
    assert.deepEqual(got!.scope, { included: ["登录页"], excluded: ["注册"] });
    assert.equal(got!.acceptanceCriteria.length, 1);
    assert.equal(got!.acceptanceCriteria[0]!.expectedEvidence[0]!.kind, "test");
    assert.equal(got!.clarifications[0]!.status, "pending");

    const list = store.listRequirementSpecs("wr-1");
    assert.equal(list.length, 1);
  });

  it("saveWorkItem / getWorkItem / listWorkItems", () => {
    const now = Date.now();
    const item: WorkItem = {
      id: "wi-1", requestId: "wr-1", projectId: "proj-1", mode: "conductor",
      kind: "implementation", status: "planned", currentGeneration: 0,
      createdAt: now, updatedAt: now,
    };
    store.saveWorkItem(item);
    const got = store.getWorkItem("wi-1");
    assert.ok(got);
    assert.equal(got!.projectId, "proj-1");
    assert.equal(got!.kind, "implementation");

    const list = store.listWorkItems("proj-1");
    assert.equal(list.length, 1);
  });

  it("saveObservation / listObservations", () => {
    const obs: QualityObservation = {
      id: "obs-1", projectId: "proj-1", kind: "check-failure",
      attribution: "candidate", evidenceRefs: ["ref-1"],
      status: "open", createdAt: Date.now(),
    };
    store.saveObservation(obs);
    const list = store.listObservations("proj-1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.kind, "check-failure");
    assert.equal(list[0]!.attribution, "candidate");
    assert.deepEqual(list[0]!.evidenceRefs, ["ref-1"]);
  });

  it("saveQualityRun with Phase 0 扩展字段", () => {
    const now = Date.now();
    const run: QualityRun = {
      ...createRun({
        id: "run-1", projectId: "proj-1", trigger: "interactive",
        risk: "low", policyVersion: "v1",
        budget: { maxFixRounds: 0, timeoutMs: 60000 },
      }),
      workItemId: "wi-1", generation: 1, policyHash: "abc123",
      policySnapshotRef: "snap-1", changeSetId: "cs-1", outcome: "verified",
    };
    store.saveQualityRun(run);
    const got = store.getQualityRun("run-1");
    assert.ok(got);
    assert.equal(got!.workItemId, "wi-1");
    assert.equal(got!.generation, 1);
    assert.equal(got!.policyHash, "abc123");
    assert.equal(got!.outcome, "verified");
  });

  it("旧数据库兼容：无 Phase 0 列时 quality_runs 仍可读写", () => {
    const now = Date.now();
    const run: QualityRun = createRun({
      id: "run-old", projectId: "proj-1", trigger: "interactive",
      risk: "low", policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    store.saveQualityRun(run);
    const got = store.getQualityRun("run-old");
    assert.ok(got);
    assert.equal(got!.id, "run-old");
    assert.equal(got!.workItemId, undefined);
    assert.equal(got!.generation, undefined);
  });
});

// ── Policy v2 校验测试 ──────────────────────────────────────────────

describe("Phase 0 Policy v2 validation", () => {
  let dir: string;
  let project: ProjectScope;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".devin"), { recursive: true });
    project = makeProject("proj-1", dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("合法 v2 policy 通过校验", () => {
    const errors = validatePolicyV2(makeV2Policy(), project);
    assert.equal(errors.length, 0, errors.join("\n"));
  });

  it("version 不是 2 时报错", () => {
    const p = makeV2Policy();
    (p as Record<string, unknown>).version = 1;
    const errors = validatePolicyV2(p, project);
    assert.ok(errors.some((e) => e.includes("version must be 2")));
  });

  it("enforcement.mode 非法时报错", () => {
    const p = makeV2Policy();
    p.enforcement.mode = "invalid" as QualityPolicyV2["enforcement"]["mode"];
    const errors = validatePolicyV2(p, project);
    assert.ok(errors.some((e) => e.includes("enforcement.mode")));
  });

  it("remediation.maxFixRounds 负数报错", () => {
    const p = makeV2Policy();
    p.remediation.maxFixRounds = -1;
    const errors = validatePolicyV2(p, project);
    assert.ok(errors.some((e) => e.includes("remediation.maxFixRounds")));
  });

  it("requirementRules 非法 id 报错", () => {
    const p = makeV2Policy();
    p.requirementRules = [{ id: "", selector: {}, dimension: "test", questionTemplate: "?" }];
    const errors = validatePolicyV2(p, project);
    assert.ok(errors.some((e) => e.includes("requirementRules[0]: id required")));
  });

  it("evidence.retentionDays 非整数报错", () => {
    const p = makeV2Policy();
    p.evidence.retentionDays = 1.5;
    const errors = validatePolicyV2(p, project);
    assert.ok(errors.some((e) => e.includes("evidence.retentionDays")));
  });
});

// ── v1 → v2 迁移预览测试 ────────────────────────────────────────────

describe("Phase 0 Policy migration preview", () => {
  it("observe → enforcement=report, remediation=off", () => {
    const v1 = makeV1Policy();
    v1.autonomy = "observe";
    const preview = migrateV1ToV2(v1);
    assert.equal(preview.v2.enforcement.mode, "report");
    assert.equal(preview.v2.remediation.mode, "off");
    assert.equal(preview.v2.review.mode, "off");
    assert.ok(preview.changes.length > 0);
  });

  it("propose → enforcement=require-approval, remediation=propose", () => {
    const v1 = makeV1Policy();
    v1.autonomy = "propose";
    const preview = migrateV1ToV2(v1);
    assert.equal(preview.v2.enforcement.mode, "require-approval");
    assert.equal(preview.v2.remediation.mode, "propose");
  });

  it("isolated-fix → enforcement=require-pass, remediation=isolated-fix", () => {
    const v1 = makeV1Policy();
    v1.autonomy = "isolated-fix";
    const preview = migrateV1ToV2(v1);
    assert.equal(preview.v2.enforcement.mode, "require-pass");
    assert.equal(preview.v2.remediation.mode, "isolated-fix");
  });

  it("apply-low-risk → enforcement=require-pass, remediation=apply-low-risk", () => {
    const v1 = makeV1Policy();
    v1.autonomy = "apply-low-risk";
    const preview = migrateV1ToV2(v1);
    assert.equal(preview.v2.enforcement.mode, "require-pass");
    assert.equal(preview.v2.remediation.mode, "apply-low-risk");
  });

  it("review.enabled=true → review.mode=advisory", () => {
    const v1 = makeV1Policy();
    v1.review.enabled = true;
    const preview = migrateV1ToV2(v1);
    assert.equal(preview.v2.review.mode, "advisory");
  });

  it("迁移后 requirementRules 和 verificationRules 为空数组", () => {
    const preview = migrateV1ToV2(makeV1Policy());
    assert.deepEqual(preview.v2.requirementRules, []);
    assert.deepEqual(preview.v2.verificationRules, []);
  });
});

// ── loadPolicyV2 兼容读取测试 ───────────────────────────────────────

describe("Phase 0 loadPolicyV2 compatible read", () => {
  let dir: string;
  let project: ProjectScope;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".devin"), { recursive: true });
    project = makeProject("proj-1", dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("v1 文件按 v1 语义返回", () => {
    const v1 = makeV1Policy();
    fs.writeFileSync(path.join(dir, ".devin", "quality.json"), JSON.stringify(v1, null, 2));
    const result = loadPolicyV2(project);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.version, 1);
  });

  it("v2 文件按 v2 语义返回", () => {
    const v2 = makeV2Policy();
    fs.writeFileSync(path.join(dir, ".devin", "quality.json"), JSON.stringify(v2, null, 2));
    const result = loadPolicyV2(project);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.version, 2);
  });

  it("文件不存在返回 not-found", () => {
    const result = loadPolicyV2(project);
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.reason, "not-found");
  });

  it("未知 version 返回 invalid", () => {
    fs.writeFileSync(path.join(dir, ".devin", "quality.json"), JSON.stringify({ version: 99 }));
    const result = loadPolicyV2(project);
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });
});

// ── 状态机新阶段测试 ────────────────────────────────────────────────

describe("Phase 0 run state machine new stages", () => {
  function makeRun(): QualityRun {
    return createRun({
      id: "run-1", projectId: "proj-1", trigger: "interactive",
      risk: "low", policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
  }

  it("inconclusive 是终态", () => {
    assert.ok(isTerminal("inconclusive"));
    assert.ok(isTerminal("waived"));
    assert.ok(isTerminal("stale"));
  });

  it("preflight → inconclusive 合法", () => {
    const run = transition(makeRun(), "preflight");
    const result = transition(run, "inconclusive");
    assert.equal(result.stage, "inconclusive");
    assert.equal(result.outcome, "inconclusive");
    assert.ok(result.completedAt);
  });

  it("full-verifying → requirement-verifying 合法", () => {
    const run = transition(makeRun(), "preflight");
    const r2 = transition(run, "implementing");
    const r3 = transition(r2, "collecting");
    const r4 = transition(r3, "quick-verifying");
    const r5 = transition(r4, "full-verifying");
    const r6 = transition(r5, "requirement-verifying");
    assert.equal(r6.stage, "requirement-verifying");
  });

  it("awaiting-approval → waived 合法", () => {
    const run = transition(makeRun(), "preflight");
    const r2 = transition(run, "implementing");
    const r3 = transition(r2, "collecting");
    const r4 = transition(r3, "quick-verifying");
    const r5 = transition(r4, "reviewing");
    const r6 = transition(r5, "awaiting-approval");
    const r7 = transition(r6, "waived");
    assert.equal(r7.stage, "waived");
    assert.equal(r7.outcome, "waived");
  });
});

// ── Service 方法测试 ────────────────────────────────────────────────

describe("Phase 0 QualityService methods", () => {
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

  it("createWorkRequest / getWorkRequest / updateWorkRequestStatus", () => {
    const req = service.createWorkRequest({
      source: "room", intent: "code-change", correlationId: "corr-1", roomId: "room-1",
    });
    assert.equal(req.status, "received");
    assert.equal(req.intent, "code-change");

    const got = service.getWorkRequest(req.id);
    assert.ok(got);

    const updated = service.updateWorkRequestStatus(req.id, "clarifying");
    assert.ok(updated);
    assert.equal(updated!.status, "clarifying");
  });

  it("createRequirementSpec 自动版本号", () => {
    const req = service.createWorkRequest({
      source: "room", intent: "code-change", correlationId: "corr-1",
    });
    const s1 = service.createRequirementSpec({ requestId: req.id, goal: "v1" });
    assert.equal(s1.version, 1);
    const s2 = service.createRequirementSpec({ requestId: req.id, goal: "v2", parentVersion: 1 });
    assert.equal(s2.version, 2);
    assert.equal(s2.parentVersion, 1);

    const list = service.listRequirementSpecs(req.id);
    assert.equal(list.length, 2);
  });

  it("createWorkItem / getWorkItem / listWorkItems", () => {
    const pid = projectId("conn-1", dir);
    const req = service.createWorkRequest({
      source: "room", intent: "code-change", correlationId: "corr-1",
    });
    const item = service.createWorkItem({
      requestId: req.id, projectId: pid, mode: "conductor",
    });
    assert.equal(item.kind, "implementation");
    assert.equal(item.status, "planned");

    const got = service.getWorkItem(item.id);
    assert.ok(got);

    const updated = service.updateWorkItemStatus(item.id, "active", "run-1", 1);
    assert.ok(updated);
    assert.equal(updated!.status, "active");
    assert.equal(updated!.currentRunId, "run-1");
    assert.equal(updated!.currentGeneration, 1);
  });

  it("createObservation / listObservations / confirmObservation", () => {
    const pid = projectId("conn-1", dir);
    const obs = service.createObservation({
      projectId: pid, kind: "check-failure", attribution: "candidate",
    });
    assert.equal(obs.status, "open");
    assert.equal(obs.attribution, "candidate");

    const list = service.listObservations(pid);
    assert.equal(list.length, 1);

    const confirmed = service.confirmObservation(obs.id);
    assert.ok(confirmed);
    assert.equal(confirmed!.status, "confirmed");
  });

  it("validatePolicyV2 合法 policy 返回 ok", () => {
    const pid = projectId("conn-1", dir);
    const result = service.validatePolicyV2(pid, makeV2Policy());
    assert.ok(result.ok);
  });

  it("validatePolicyV2 非法 policy 返回 errors", () => {
    const pid = projectId("conn-1", dir);
    const p = makeV2Policy();
    p.enforcement.mode = "invalid" as QualityPolicyV2["enforcement"]["mode"];
    const result = service.validatePolicyV2(pid, p);
    assert.ok(!result.ok);
    assert.ok(result.errors.length > 0);
  });

  it("previewPolicyMigration 返回迁移预览", () => {
    const pid = projectId("conn-1", dir);
    const v1 = makeV1Policy();
    fs.mkdirSync(path.join(dir, ".devin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".devin", "quality.json"), JSON.stringify(v1, null, 2));
    const preview = service.previewPolicyMigration(pid);
    assert.ok(preview);
    assert.equal(preview!.v2.enforcement.mode, "report");
  });

  it("loadPolicyWithVersion 无文件时返回默认 v1", () => {
    const pid = projectId("conn-1", dir);
    const result = service.loadPolicyWithVersion(pid);
    assert.equal(result.version, 1);
    assert.equal(result.source, "default");
  });
});

describe("Phase 0 度量收集（§12）", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-metric-"));
    store = new Store(path.join(dir, "test.db"));
    service = new QualityService(store, () => {});
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("run 进入终态时自动记录度量事件", () => {
    const pid = projectId("conn-1", dir);
    const run = service.startRun({
      projectId: pid,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    service.advance(run.id, "preflight");
    service.advance(run.id, "inconclusive");
    const metrics = service.listMetrics(pid);
    assert.equal(metrics.length, 1);
    const m = metrics[0]!;
    assert.equal(m.kind, "run-terminal");
    assert.equal(m.outcome, "inconclusive");
    assert.equal(m.stage, "inconclusive");
    assert.equal(m.checkCount, 0);
    assert.equal(m.hasPatch, false);
    assert.equal(m.fixRounds, 0);
  });

  it("accepted run 记录 patch 和 check 统计", () => {
    const pid = projectId("conn-1", dir);
    const run = service.startRun({
      projectId: pid,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    // 经过合法路径到 full-verifying，再带 patchHash advance 到 accepted
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "full-verifying");
    const withPatch = { ...service.getRun(run.id)!, patchHash: "abc123" };
    store.saveQualityRun(withPatch);
    service.advance(run.id, "accepted");
    const metrics = service.listMetrics(pid);
    assert.equal(metrics.length, 1);
    const m = metrics[0]!;
    assert.equal(m.outcome, "verified");
    assert.equal(m.hasPatch, true);
  });

  it("listMetrics 按 kind 过滤", () => {
    const pid = projectId("conn-1", dir);
    const run1 = service.startRun({ projectId: pid, trigger: "interactive", risk: "low", policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 } });
    service.advance(run1.id, "preflight");
    service.advance(run1.id, "inconclusive");
    const run2 = service.startRun({ projectId: pid, trigger: "interactive", risk: "low", policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 } });
    service.advance(run2.id, "preflight");
    service.advance(run2.id, "cancelled");
    const all = service.listMetrics(pid);
    assert.equal(all.length, 2);
    const terminal = service.listMetrics(pid, "run-terminal");
    assert.equal(terminal.length, 2);
  });

  it("度量事件包含 durationMs", () => {
    const pid = projectId("conn-1", dir);
    const run = service.startRun({ projectId: pid, trigger: "interactive", risk: "low", policyVersion: "1", budget: { maxFixRounds: 0, timeoutMs: 60000 } });
    service.advance(run.id, "preflight");
    service.advance(run.id, "inconclusive");
    const m = service.listMetrics(pid)[0]!;
    assert.ok(m.durationMs !== undefined && m.durationMs >= 0);
  });
});
