import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { recoverInterruptedRuns } from "./recovery.js";
import type { ProjectScope, QualityPolicy } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-svc-"));
}

function makeProject(id: string, root: string): ProjectScope {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    root,
    gitRoot: root,
    displayName: "agent-hub",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: now,
    updatedAt: now,
  };
}

function validPolicy(): QualityPolicy {
  return {
    version: 1,
    checks: [
      { id: "typecheck", cwd: ".", argv: ["node", "-v"], tier: "quick", timeoutMs: 10_000, required: true },
    ],
    protectedPaths: [".devin/quality.json"],
    riskRules: [],
    review: { enabled: true, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 2 },
    autonomy: "propose",
  };
}

describe("QualityService", () => {
  let dir: string;
  let store: Store;
  let events: { method: string; runId: string }[];
  let service: QualityService;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
    events = [];
    service = new QualityService(store, (e) => events.push({ method: e.method, runId: e.params.runId }));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("projects", () => {
    it("registerProject 后能 list/get", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      assert.equal(service.listProjects().length, 1);
      assert.equal(service.getProject(p.id)!.id, p.id);
    });
    it("registerProject 同 id 覆盖保留 createdAt", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const again = service.registerProject({ connectionId: "c1", root: dir, displayName: "renamed" });
      assert.equal(again.createdAt, p.createdAt);
      assert.equal(again.displayName, "renamed");
    });
    it("未知 project get 返回 undefined", () => {
      assert.equal(service.getProject("nope"), undefined);
    });
  });

  describe("policy", () => {
    it("detectPolicy 无文件返回 errors + suggestions", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const r = service.detectPolicy(p.id);
      assert.ok(r.errors.length > 0);
      assert.deepEqual(r.suggestions, []);
    });
    it("detectPolicy 有文件返回 policy", () => {
      fs.mkdirSync(path.join(dir, ".devin"));
      fs.writeFileSync(path.join(dir, ".devin/quality.json"), JSON.stringify(validPolicy()));
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const r = service.detectPolicy(p.id);
      assert.ok(r.policy);
      assert.equal(r.policy!.checks.length, 1);
    });
    it("validatePolicy 合法返回 ok", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const r = service.validatePolicy(p.id, validPolicy());
      assert.equal(r.ok, true);
    });
    it("validatePolicy 非法返回 errors", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const bad = { ...validPolicy(), version: 9 as unknown as 1 };
      const r = service.validatePolicy(p.id, bad);
      assert.equal(r.ok, false);
      assert.ok(r.errors.length > 0);
    });
    it("getPolicy 无文件返回 default observe", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const r = service.getPolicy(p.id);
      assert.equal(r.source, "default");
      assert.equal(r.policy.autonomy, "observe");
    });
  });

  describe("runs lifecycle", () => {
    it("startRun 创建 queued run 并广播 runUpdate", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      assert.equal(run.stage, "queued");
      assert.equal(run.projectId, p.id);
      assert.ok(events.some((e) => e.method === "quality.runUpdate" && e.runId === run.id));
    });

    it("getRun/listRuns 持久化", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      assert.equal(service.getRun(run.id)!.id, run.id);
      assert.equal(service.listRuns(p.id).length, 1);
      assert.equal(service.listRuns().length, 1);
    });

    it("cancelRun 推进到 cancelled 并广播", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      const before = events.length;
      const cancelled = service.cancelRun(run.id);
      assert.equal(cancelled.stage, "cancelled");
      assert.ok(events.length > before);
    });

    it("cancelRun 终态 run 抛错", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.cancelRun(run.id);
      assert.throws(() => service.cancelRun(run.id), /already terminal/);
    });

    it("approveRun 从 awaiting-approval → accepted（需 patchHash）", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        patchHash: "h1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");
      service.advance(run.id, "full-verifying");
      service.advance(run.id, "awaiting-approval");
      const approved = service.approveRun(run.id);
      assert.equal(approved.stage, "accepted");
      assert.equal(approved.verdict, "pass");
    });

    it("approveRun 非 awaiting-approval 抛错", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      assert.throws(() => service.approveRun(run.id), /not awaiting approval/);
    });

    it("rejectRun 从 awaiting-approval → failed", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        patchHash: "h1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");
      service.advance(run.id, "full-verifying");
      service.advance(run.id, "awaiting-approval");
      const rejected = service.rejectRun(run.id);
      assert.equal(rejected.stage, "failed");
      assert.equal(rejected.verdict, "fail");
    });

    it("retryRun 基于原 run 创建新 queued run", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "conductor",
        risk: "medium",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.cancelRun(run.id);
      const retried = service.retryRun(run.id);
      assert.equal(retried.stage, "queued");
      assert.notEqual(retried.id, run.id);
      assert.equal(retried.projectId, run.projectId);
      assert.equal(retried.trigger, "conductor");
    });

    it("advance 非法转换抛 IllegalTransitionError", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      assert.throws(() => service.advance(run.id, "accepted"), /illegal stage transition/);
    });
  });

  describe("重启恢复", () => {
    it("重启后非终态 run 被恢复为 failed/cancelled", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      // 模拟重启：新 service 实例（同 store）调用 recoverInterruptedRuns
      const events2: { method: string }[] = [];
      const service2 = new QualityService(store, (e) => events2.push({ method: e.method }));
      const summary = recoverInterruptedRuns(store);
      assert.equal(summary.runs.length, 1);
      const got = service2.getRun(run.id)!;
      assert.equal(got.stage, "failed");
      assert.equal(got.failureCode, "hub-restart");
    });

    it("重启后 getRun 仍能取到历史 run", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const run = service.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.cancelRun(run.id);
      const service2 = new QualityService(store, () => {});
      assert.equal(service2.getRun(run.id)!.stage, "cancelled");
      assert.equal(service2.listRuns().length, 1);
    });
  });

  describe("reviewRunner & onTerminal hooks", () => {
    it("advance 到 reviewing 时触发 reviewRunner", () => {
      const reviewedRuns: string[] = [];
      const svc = new QualityService(store, () => {}, {
        reviewRunner: (run) => reviewedRuns.push(run.id),
      });
      const p = svc.registerProject({ connectionId: "c1", root: dir });
      const run = svc.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      svc.advance(run.id, "preflight");
      svc.advance(run.id, "implementing");
      svc.advance(run.id, "collecting");
      svc.advance(run.id, "quick-verifying");
      assert.equal(reviewedRuns.length, 0);
      svc.advance(run.id, "reviewing");
      assert.equal(reviewedRuns.length, 1);
      assert.equal(reviewedRuns[0], run.id);
    });

    it("advance 到非 reviewing 阶段不触发 reviewRunner", () => {
      const reviewedRuns: string[] = [];
      const svc = new QualityService(store, () => {}, {
        reviewRunner: (run) => reviewedRuns.push(run.id),
      });
      const p = svc.registerProject({ connectionId: "c1", root: dir });
      const run = svc.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      svc.advance(run.id, "preflight");
      svc.advance(run.id, "implementing");
      svc.advance(run.id, "collecting");
      assert.equal(reviewedRuns.length, 0);
    });

    it("run 进入终态时触发 onTerminal", () => {
      const terminalRuns: { id: string; stage: string }[] = [];
      const svc = new QualityService(store, () => {}, {
        onTerminal: (run) => terminalRuns.push({ id: run.id, stage: run.stage }),
      });
      const p = svc.registerProject({ connectionId: "c1", root: dir });
      const run = svc.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      svc.cancelRun(run.id);
      assert.equal(terminalRuns.length, 1);
      assert.equal(terminalRuns[0]!.stage, "cancelled");
    });

    it("approveRun 进入 accepted 时触发 onTerminal", () => {
      const terminalRuns: { id: string; stage: string }[] = [];
      const svc = new QualityService(store, () => {}, {
        onTerminal: (run) => terminalRuns.push({ id: run.id, stage: run.stage }),
      });
      const p = svc.registerProject({ connectionId: "c1", root: dir });
      const run = svc.startRun({
        projectId: p.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "v1",
        patchHash: "h1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      svc.advance(run.id, "preflight");
      svc.advance(run.id, "implementing");
      svc.advance(run.id, "collecting");
      svc.advance(run.id, "quick-verifying");
      svc.advance(run.id, "reviewing");
      svc.advance(run.id, "full-verifying");
      svc.advance(run.id, "awaiting-approval");
      svc.approveRun(run.id);
      assert.equal(terminalRuns.length, 1);
      assert.equal(terminalRuns[0]!.stage, "accepted");
    });
  });

  describe("incidents CRUD (Q3-01)", () => {
    it("createIncident → getIncident → listIncidents", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc = service.createIncident({
        projectId: p.id,
        description: "内存泄漏",
        severity: "major",
        sourceRunId: "run-1",
      });
      assert.ok(inc.id);
      assert.equal(inc.status, "open");
      assert.ok(inc.fingerprint.length > 0);

      const got = service.getIncident(inc.id);
      assert.equal(got?.description, "内存泄漏");

      const list = service.listIncidents(p.id);
      assert.equal(list.length, 1);
    });

    it("resolveIncident 合法状态转换", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc = service.createIncident({
        projectId: p.id,
        description: "x",
        severity: "low",
      });
      const resolved = service.resolveIncident(inc.id, "covered", "test-leak.ts");
      assert.equal(resolved.status, "covered");
      assert.equal(resolved.regressionTest, "test-leak.ts");
    });

    it("resolveIncident 非法状态转换抛错", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc = service.createIncident({
        projectId: p.id,
        description: "x",
        severity: "low",
      });
      assert.throws(() => service.resolveIncident(inc.id, "invalid" as never), /invalid incident status/);
    });

    it("deleteIncident", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc = service.createIncident({
        projectId: p.id,
        description: "x",
        severity: "low",
      });
      assert.equal(service.deleteIncident(inc.id), true);
      assert.equal(service.getIncident(inc.id), undefined);
      assert.equal(service.deleteIncident(inc.id), false);
    });

    it("listIncidents 按 projectId 过滤", () => {
      const p1 = service.registerProject({ connectionId: "c1", root: dir });
      const p2Dir = fs.mkdtempSync(path.join(os.tmpdir(), "q-svc-p2-"));
      const p2 = service.registerProject({ connectionId: "c2", root: p2Dir });
      service.createIncident({ projectId: p1.id, description: "a", severity: "low" });
      service.createIncident({ projectId: p2.id, description: "b", severity: "low" });
      assert.equal(service.listIncidents(p1.id).length, 1);
      assert.equal(service.listIncidents(p2.id).length, 1);
      assert.equal(service.listIncidents().length, 2);
      fs.rmSync(p2Dir, { recursive: true, force: true });
    });
  });

  describe("rule candidates CRUD (Q3-04)", () => {
    it("createRule → getRule → listRules", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const rule = service.createRule({
        projectId: p.id,
        rule: "禁止直接拼接 SQL",
        evidenceIncidentIds: ["inc-1", "inc-2"],
      });
      assert.ok(rule.id);
      assert.equal(rule.status, "candidate");
      assert.equal(rule.recurrence, 2);

      const got = service.getRule(rule.id);
      assert.equal(got?.rule, "禁止直接拼接 SQL");

      const list = service.listRules(p.id);
      assert.equal(list.length, 1);
    });

    it("resolveRule 合法状态转换 candidate → approved → active", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const rule = service.createRule({
        projectId: p.id,
        rule: "r",
        evidenceIncidentIds: [],
      });
      const approved = service.resolveRule(rule.id, "approved");
      assert.equal(approved.status, "approved");
      const active = service.resolveRule(rule.id, "active");
      assert.equal(active.status, "active");
    });

    it("resolveRule 非法状态转换抛错", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const rule = service.createRule({
        projectId: p.id,
        rule: "r",
        evidenceIncidentIds: [],
      });
      assert.throws(() => service.resolveRule(rule.id, "active" as never), /illegal/);
    });

    it("deleteRule", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const rule = service.createRule({
        projectId: p.id,
        rule: "r",
        evidenceIncidentIds: [],
      });
      assert.equal(service.deleteRule(rule.id), true);
      assert.equal(service.getRule(rule.id), undefined);
      assert.equal(service.deleteRule(rule.id), false);
    });

    it("promoteIncidentToRule 新规则创建 candidate", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc = service.createIncident({
        projectId: p.id,
        description: "SQL注入",
        severity: "critical",
      });
      const rule = service.promoteIncidentToRule(inc.id, "禁止拼接SQL");
      assert.equal(rule.projectId, p.id);
      assert.equal(rule.rule, "禁止拼接SQL");
      assert.equal(rule.evidenceIncidentIds.length, 1);
      assert.equal(rule.evidenceIncidentIds[0], inc.id);
      assert.equal(rule.recurrence, 1);
      assert.equal(rule.status, "candidate");
    });

    it("promoteIncidentToRule 同 fingerprint 追加 evidence 并递增 recurrence", () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const inc1 = service.createIncident({
        projectId: p.id,
        description: "SQL注入",
        severity: "critical",
      });
      const inc2 = service.createIncident({
        projectId: p.id,
        description: "又一个SQL注入",
        severity: "major",
      });
      const rule1 = service.promoteIncidentToRule(inc1.id, "禁止拼接SQL");
      const rule2 = service.promoteIncidentToRule(inc2.id, "禁止拼接SQL");
      assert.equal(rule1.id, rule2.id);
      assert.equal(rule2.evidenceIncidentIds.length, 2);
      assert.equal(rule2.recurrence, 2);
    });

    it("promoteIncidentToRule 未知 incident 抛错", () => {
      assert.throws(() => service.promoteIncidentToRule("nonexistent", "r"), /unknown incident/);
    });
  });

  describe("rule sandbox validation (P4)", () => {
    it("sandboxRule 验证通过后推进到 active", async () => {
      const sandboxSvc = new QualityService(store, () => {}, {
        sandboxRunner: async () => ({
          passed: true,
          checkSummaries: ["[passed] typecheck: ok"],
          checksTotal: 1,
          checksPassed: 1,
          checksFailed: 0,
        }),
      });
      const p = sandboxSvc.registerProject({ connectionId: "c1", root: dir });
      const rule = sandboxSvc.createRule({
        projectId: p.id,
        rule: JSON.stringify({ pattern: "hub/**", risk: "high", reason: "core change" }),
        evidenceIncidentIds: ["inc-1"],
      });
      assert.equal(rule.status, "candidate");
      const result = await sandboxSvc.sandboxRule(rule.id);
      assert.equal(result.passed, true);
      assert.equal(result.promoted, true);
      assert.equal(result.checksTotal, 1);
      assert.equal(result.checksPassed, 1);
      const updated = sandboxSvc.getRule(rule.id);
      assert.equal(updated!.status, "active");
    });

    it("sandboxRule 验证失败不推进", async () => {
      const sandboxSvc = new QualityService(store, () => {}, {
        sandboxRunner: async () => ({
          passed: false,
          checkSummaries: ["[failed] typecheck: errors"],
          checksTotal: 1,
          checksPassed: 0,
          checksFailed: 1,
        }),
      });
      const p = sandboxSvc.registerProject({ connectionId: "c1", root: dir });
      const rule = sandboxSvc.createRule({
        projectId: p.id,
        rule: JSON.stringify({ pattern: "hub/**", risk: "high", reason: "core" }),
        evidenceIncidentIds: [],
      });
      const result = await sandboxSvc.sandboxRule(rule.id);
      assert.equal(result.passed, false);
      assert.equal(result.promoted, false);
      assert.equal(result.checksFailed, 1);
      const updated = sandboxSvc.getRule(rule.id);
      assert.equal(updated!.status, "candidate");
    });

    it("sandboxRule 无 sandboxRunner 返回错误结果", async () => {
      const p = service.registerProject({ connectionId: "c1", root: dir });
      const rule = service.createRule({
        projectId: p.id,
        rule: JSON.stringify({ pattern: "hub/**", risk: "high", reason: "core" }),
        evidenceIncidentIds: [],
      });
      const result = await service.sandboxRule(rule.id);
      assert.equal(result.passed, false);
      assert.equal(result.promoted, false);
      assert.match(result.reason, /no sandbox runner/);
    });

    it("sandboxRule 非法 rule 文本返回错误结果", async () => {
      const sandboxSvc = new QualityService(store, () => {}, {
        sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
      });
      const p = sandboxSvc.registerProject({ connectionId: "c1", root: dir });
      const rule = sandboxSvc.createRule({
        projectId: p.id,
        rule: "not valid json",
        evidenceIncidentIds: [],
      });
      const result = await sandboxSvc.sandboxRule(rule.id);
      assert.equal(result.passed, false);
      assert.equal(result.promoted, false);
      assert.match(result.reason, /not valid RiskRule/);
    });

    it("sandboxRule 状态非 candidate/approved 拒绝", async () => {
      const sandboxSvc = new QualityService(store, () => {}, {
        sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
      });
      const p = sandboxSvc.registerProject({ connectionId: "c1", root: dir });
      const rule = sandboxSvc.createRule({
        projectId: p.id,
        rule: JSON.stringify({ pattern: "hub/**", risk: "high", reason: "core" }),
        evidenceIncidentIds: [],
      });
      sandboxSvc.resolveRule(rule.id, "approved");
      sandboxSvc.resolveRule(rule.id, "active");
      const result = await sandboxSvc.sandboxRule(rule.id);
      assert.equal(result.passed, false);
      assert.equal(result.promoted, false);
      assert.match(result.reason, /must be candidate or approved/);
    });

    it("sandboxRule 未知 rule 抛错", async () => {
      await assert.rejects(() => service.sandboxRule("nonexistent"), /unknown rule/);
    });

    it("sandboxRule approved 状态也可验证并推进到 active", async () => {
      const sandboxSvc = new QualityService(store, () => {}, {
        sandboxRunner: async () => ({
          passed: true,
          checkSummaries: ["[passed] check: ok"],
          checksTotal: 1,
          checksPassed: 1,
          checksFailed: 0,
        }),
      });
      const p = sandboxSvc.registerProject({ connectionId: "c1", root: dir });
      const rule = sandboxSvc.createRule({
        projectId: p.id,
        rule: JSON.stringify({ pattern: "hub/**", risk: "high", reason: "core" }),
        evidenceIncidentIds: [],
      });
      sandboxSvc.resolveRule(rule.id, "approved");
      const result = await sandboxSvc.sandboxRule(rule.id);
      assert.equal(result.passed, true);
      assert.equal(result.promoted, true);
      assert.equal(sandboxSvc.getRule(rule.id)!.status, "active");
    });
  });
});
