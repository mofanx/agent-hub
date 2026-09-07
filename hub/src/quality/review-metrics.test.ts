import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService, computeReviewerMetrics } from "./service.js";
import { RunPermissionManager } from "./permissions.js";
import { ReviewOrchestrator, type ReviewerSessionRunner } from "./review-orchestrator.js";
import type { ReviewerDecision, ProjectScope, ReviewFinding } from "./types.js";
import type { Baseline, ChangeSetCollectorOptions } from "./change-set.js";
import type { ChangeSet } from "./types.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-metrics-"));
}

function makeProject(root: string): ProjectScope {
  return {
    id: "p-test",
    connectionId: "conn-1",
    root,
    gitRoot: undefined,
    displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: 1,
    updatedAt: 1,
  };
}

class MockSessionRunner implements ReviewerSessionRunner {
  public nextOutput = "";
  async ensureSession(): Promise<string> { return "rev-1"; }
  async promptOnce(): Promise<{ output: string; stopReason: string }> {
    return { output: this.nextOutput, stopReason: "end_turn" };
  }
}

function makeFinding(runId: string, id: string, blocking = true): ReviewFinding {
  return {
    id,
    runId,
    severity: "major",
    confidence: 0.9,
    category: "correctness",
    claim: "test bug",
    evidence: "evidence",
    blocking,
    status: "open",
  };
}

describe("review metrics (Q2-07)", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;
  let project: ProjectScope;
  let permissionManager: RunPermissionManager;
  let sessionRunner: MockSessionRunner;
  let orchestrator: ReviewOrchestrator;

  beforeEach(() => {
    dir = makeTempDir();
    store = new Store(path.join(dir, "test.db"));
    service = new QualityService(store, () => {});
    project = makeProject(dir);
    store.upsertQualityProject(project);
    permissionManager = new RunPermissionManager();
    sessionRunner = new MockSessionRunner();
    orchestrator = new ReviewOrchestrator(service, permissionManager, sessionRunner, {
      artifactDir: dir,
      reviewTimeoutMs: 5000,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (
        runId: string,
        _project: ProjectScope,
        _baseline: Baseline,
        _options: ChangeSetCollectorOptions | undefined,
        _artifactDir: string,
      ): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: "h1",
        files: [{ path: "src/foo.ts", status: "modify", additions: 10, deletions: 2 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
      readAgentsMd: () => undefined,
    });
  });

  describe("computeReviewerMetrics", () => {
    it("空列表 sufficient=false", () => {
      const m = computeReviewerMetrics([]);
      assert.equal(m.totalDecisions, 0);
      assert.equal(m.sufficient, false);
      assert.equal(m.confirmationRate, 0);
      assert.equal(m.dismissalRate, 0);
    });

    it("29 条 insufficient，30 条 sufficient", () => {
      const make29 = Array.from({ length: 29 }, (_, i) => ({
        id: `rd-${i}`,
        runId: `r-${i}`,
        projectId: "p",
        verdict: "needs-fix" as const,
        findingCount: 1,
        blockingCount: 1,
        reviewedAt: 1,
        outcome: "confirmed" as const,
      }));
      assert.equal(computeReviewerMetrics(make29).sufficient, false);
      const make30 = [...make29, {
        id: "rd-29",
        runId: "r-29",
        projectId: "p",
        verdict: "needs-fix" as const,
        findingCount: 1,
        blockingCount: 1,
        reviewedAt: 1,
        outcome: "confirmed" as const,
      }];
      assert.equal(computeReviewerMetrics(make30).sufficient, true);
    });

    it("confirmationRate = confirmed / (confirmed + dismissed + accepted-risk)", () => {
      const decisions: ReviewerDecision[] = [
        ...Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, runId: `r-${i}`, projectId: "p", verdict: "needs-fix" as const, findingCount: 1, blockingCount: 1, reviewedAt: 1, outcome: "confirmed" as const })),
        ...Array.from({ length: 5 }, (_, i) => ({ id: `d-${i}`, runId: `r-${100 + i}`, projectId: "p", verdict: "needs-fix" as const, findingCount: 1, blockingCount: 1, reviewedAt: 1, outcome: "dismissed" as const })),
        ...Array.from({ length: 5 }, (_, i) => ({ id: `a-${i}`, runId: `r-${200 + i}`, projectId: "p", verdict: "needs-fix" as const, findingCount: 1, blockingCount: 1, reviewedAt: 1, outcome: "accepted-risk" as const })),
      ];
      const m = computeReviewerMetrics(decisions);
      assert.equal(m.confirmed, 20);
      assert.equal(m.dismissed, 5);
      assert.equal(m.acceptedRisk, 5);
      // 20 / 30 = 0.6667
      assert.ok(Math.abs(m.confirmationRate - 20 / 30) < 0.001);
      // 5 / 30 = 0.1667
      assert.ok(Math.abs(m.dismissalRate - 5 / 30) < 0.001);
      assert.equal(m.sufficient, true);
    });

    it("pending 和 uncertain 不计入 confirmationRate 分母", () => {
      const decisions: ReviewerDecision[] = [
        { id: "1", runId: "r1", projectId: "p", verdict: "needs-fix", findingCount: 1, blockingCount: 1, reviewedAt: 1, outcome: "confirmed" },
        { id: "2", runId: "r2", projectId: "p", verdict: "pass", findingCount: 0, blockingCount: 0, reviewedAt: 1, outcome: "pending" },
        { id: "3", runId: "r3", projectId: "p", verdict: "uncertain", findingCount: 0, blockingCount: 0, reviewedAt: 1, outcome: "uncertain" },
      ];
      const m = computeReviewerMetrics(decisions);
      assert.equal(m.confirmed, 1);
      assert.equal(m.pending, 1);
      assert.equal(m.uncertain, 1);
      // 1 / 1 = 1.0
      assert.equal(m.confirmationRate, 1.0);
      assert.equal(m.dismissalRate, 0);
    });

    it("avgFindingCount 和 avgBlockingCount", () => {
      const decisions: ReviewerDecision[] = [
        { id: "1", runId: "r1", projectId: "p", verdict: "needs-fix", findingCount: 3, blockingCount: 1, reviewedAt: 1, outcome: "confirmed" },
        { id: "2", runId: "r2", projectId: "p", verdict: "needs-fix", findingCount: 1, blockingCount: 0, reviewedAt: 1, outcome: "dismissed" },
      ];
      const m = computeReviewerMetrics(decisions);
      assert.equal(m.avgFindingCount, 2.0);
      assert.equal(m.avgBlockingCount, 0.5);
    });
  });

  describe("Store CRUD for review decisions", () => {
    it("save 和 get", () => {
      const d: ReviewerDecision = {
        id: "rd-1",
        runId: "r-1",
        projectId: "p-test",
        verdict: "needs-fix",
        findingCount: 2,
        blockingCount: 1,
        reviewedAt: 1000,
        outcome: "pending",
      };
      store.saveQualityReviewDecision(d);
      const got = store.getQualityReviewDecision("rd-1");
      assert.equal(got?.id, "rd-1");
      assert.equal(got?.verdict, "needs-fix");
      assert.equal(got?.findingCount, 2);
      assert.equal(got?.outcome, "pending");
    });

    it("getByRun", () => {
      const d: ReviewerDecision = {
        id: "rd-2",
        runId: "r-2",
        projectId: "p-test",
        verdict: "pass",
        findingCount: 0,
        blockingCount: 0,
        reviewedAt: 2000,
        outcome: "pending",
      };
      store.saveQualityReviewDecision(d);
      const got = store.getQualityReviewDecisionByRun("r-2");
      assert.equal(got?.id, "rd-2");
    });

    it("list by project", () => {
      for (let i = 0; i < 5; i++) {
        store.saveQualityReviewDecision({
          id: `rd-${i}`,
          runId: `r-${i}`,
          projectId: "p-test",
          verdict: "needs-fix",
          findingCount: 1,
          blockingCount: 1,
          reviewedAt: i,
          outcome: "confirmed",
        });
      }
      const list = store.listQualityReviewDecisions("p-test");
      assert.equal(list.length, 5);
      // 按 reviewed_at DESC 排序
      assert.equal(list[0]!.reviewedAt, 4);
    });

    it("update outcome", () => {
      store.saveQualityReviewDecision({
        id: "rd-3",
        runId: "r-3",
        projectId: "p-test",
        verdict: "needs-fix",
        findingCount: 1,
        blockingCount: 1,
        reviewedAt: 3000,
        outcome: "pending",
      });
      const ok = store.updateQualityReviewDecisionOutcome("rd-3", "confirmed", "fixed");
      assert.equal(ok, true);
      const got = store.getQualityReviewDecision("rd-3");
      assert.equal(got?.outcome, "confirmed");
      assert.ok(got?.resolvedAt !== undefined);
      assert.equal(got?.note, "fixed");
    });

    it("parseError 和 reviewerSessionId 持久化", () => {
      store.saveQualityReviewDecision({
        id: "rd-4",
        runId: "r-4",
        projectId: "p-test",
        verdict: "uncertain",
        findingCount: 0,
        blockingCount: 0,
        parseError: "bad json",
        reviewerSessionId: "rev-x",
        reviewedAt: 4000,
        outcome: "uncertain",
      });
      const got = store.getQualityReviewDecision("rd-4");
      assert.equal(got?.parseError, "bad json");
      assert.equal(got?.reviewerSessionId, "rev-x");
    });

    it("update 不存在的 decision 返回 false", () => {
      assert.equal(store.updateQualityReviewDecisionOutcome("nonexistent", "confirmed"), false);
    });
  });

  describe("ReviewOrchestrator 记录决策", () => {
    it("review 成功后记录 pending decision", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: "bug", evidence: "ev" }],
      });

      await orchestrator.runReview(run.id);

      const decision = service.getReviewDecisionByRun(run.id);
      assert.ok(decision !== undefined);
      assert.equal(decision.verdict, "needs-fix");
      assert.equal(decision.findingCount, 1);
      assert.equal(decision.blockingCount, 1);
      assert.equal(decision.outcome, "pending");
    });

    it("parse error 时记录 parseError", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = "not json";

      await orchestrator.runReview(run.id);

      const decision = service.getReviewDecisionByRun(run.id);
      assert.ok(decision !== undefined);
      assert.equal(decision.verdict, "uncertain");
      assert.ok(decision.parseError !== undefined);
      assert.equal(decision.outcome, "pending");
    });

    it("prompt 失败时记录 uncertain outcome", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "low",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      const failingRunner: ReviewerSessionRunner = {
        ensureSession: async () => "rev-fail",
        promptOnce: async () => { throw new Error("connection lost"); },
      };
      const failingOrch = new ReviewOrchestrator(service, permissionManager, failingRunner, {
        artifactDir: dir,
        reviewTimeoutMs: 5000,
        collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
        collectChangeSetFn: (runId: string): ChangeSet => ({
          runId, baseRevision: undefined, patchArtifact: "", patchHash: "h1",
          files: [], preexistingDirty: false, contaminated: false, riskReasons: [],
        }),
        readAgentsMd: () => undefined,
      });

      await failingOrch.runReview(run.id);

      const decision = service.getReviewDecisionByRun(run.id);
      assert.ok(decision !== undefined);
      assert.equal(decision.outcome, "uncertain");
      assert.ok(decision.parseError !== undefined);
      assert.ok(decision.parseError.includes("connection lost"));
    });
  });

  describe("resolveFinding 更新 decision outcome", () => {
    it("finding fixed → decision outcome=confirmed", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: "bug", evidence: "ev" }],
      });

      const result = await orchestrator.runReview(run.id);
      const findingId = result.findings[0]!.id;

      // resolve finding as fixed
      service.resolveFinding(findingId, "fixed");

      const decision = service.getReviewDecisionByRun(run.id);
      assert.equal(decision?.outcome, "confirmed");
      assert.ok(decision?.resolvedAt !== undefined);
    });

    it("finding dismissed → decision outcome=dismissed", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: "bug", evidence: "ev" }],
      });

      const result = await orchestrator.runReview(run.id);
      const findingId = result.findings[0]!.id;

      service.resolveFinding(findingId, "dismissed");

      const decision = service.getReviewDecisionByRun(run.id);
      assert.equal(decision?.outcome, "dismissed");
    });

    it("finding accepted-risk → decision outcome=accepted-risk", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: "bug", evidence: "ev" }],
      });

      const result = await orchestrator.runReview(run.id);
      const findingId = result.findings[0]!.id;

      service.resolveFinding(findingId, "accepted-risk");

      const decision = service.getReviewDecisionByRun(run.id);
      assert.equal(decision?.outcome, "accepted-risk");
    });

    it("多个 finding 时，还有 open blocking 不更新 outcome", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [
          { severity: "major", confidence: 0.9, category: "correctness", claim: "bug1", evidence: "ev1" },
          { severity: "major", confidence: 0.9, category: "security", claim: "bug2", evidence: "ev2" },
        ],
      });

      const result = await orchestrator.runReview(run.id);
      const f1 = result.findings[0]!.id;
      // 只 resolve 第一个，第二个仍 open
      service.resolveFinding(f1, "fixed");

      const decision = service.getReviewDecisionByRun(run.id);
      // 还有 open blocking finding，outcome 仍为 pending
      assert.equal(decision?.outcome, "pending");
    });

    it("已终态的 decision 不被覆盖", async () => {
      const run = service.startRun({
        projectId: project.id,
        trigger: "interactive",
        risk: "medium",
        policyVersion: "1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      service.advance(run.id, "preflight");
      service.advance(run.id, "implementing");
      service.advance(run.id, "collecting");
      service.advance(run.id, "quick-verifying");
      service.advance(run.id, "reviewing");

      sessionRunner.nextOutput = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: "bug", evidence: "ev" }],
      });

      const result = await orchestrator.runReview(run.id);
      const findingId = result.findings[0]!.id;

      service.resolveFinding(findingId, "fixed");
      const decision1 = service.getReviewDecisionByRun(run.id);
      assert.equal(decision1?.outcome, "confirmed");

      // 再次 resolve 同一 finding 到 dismissed（合法转换）
      service.resolveFinding(findingId, "dismissed");
      const decision2 = service.getReviewDecisionByRun(run.id);
      // 已终态，不被覆盖
      assert.equal(decision2?.outcome, "confirmed");
    });
  });

  describe("getReviewerMetrics 集成", () => {
    it("30 条 confirmed → confirmationRate=1.0 sufficient=true", async () => {
      // 批量创建 30 个 run + review + resolve
      for (let i = 0; i < 30; i++) {
        const run = service.startRun({
          projectId: project.id,
          trigger: "interactive",
          risk: "medium",
          policyVersion: "1",
          budget: { maxFixRounds: 2, timeoutMs: 60000 },
        });
        service.advance(run.id, "preflight");
        service.advance(run.id, "implementing");
        service.advance(run.id, "collecting");
        service.advance(run.id, "quick-verifying");
        service.advance(run.id, "reviewing");

        sessionRunner.nextOutput = JSON.stringify({
          verdict: "needs-fix",
          findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: `bug-${i}`, evidence: "ev" }],
        });

        const result = await orchestrator.runReview(run.id);
        service.resolveFinding(result.findings[0]!.id, "fixed");
      }

      const metrics = service.getReviewerMetrics(project.id);
      assert.equal(metrics.totalDecisions, 30);
      assert.equal(metrics.confirmed, 30);
      assert.equal(metrics.dismissed, 0);
      assert.equal(metrics.confirmationRate, 1.0);
      assert.equal(metrics.sufficient, true);
    });

    it("混合 outcome 的 metrics", async () => {
      // 20 confirmed, 5 dismissed, 5 accepted-risk, 5 pending
      for (let i = 0; i < 20; i++) {
        const run = service.startRun({
          projectId: project.id,
          trigger: "interactive",
          risk: "medium",
          policyVersion: "1",
          budget: { maxFixRounds: 2, timeoutMs: 60000 },
        });
        service.advance(run.id, "preflight");
        service.advance(run.id, "implementing");
        service.advance(run.id, "collecting");
        service.advance(run.id, "quick-verifying");
        service.advance(run.id, "reviewing");
        sessionRunner.nextOutput = JSON.stringify({
          verdict: "needs-fix",
          findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: `c-${i}`, evidence: "ev" }],
        });
        const result = await orchestrator.runReview(run.id);
        service.resolveFinding(result.findings[0]!.id, "fixed");
      }
      for (let i = 0; i < 5; i++) {
        const run = service.startRun({
          projectId: project.id,
          trigger: "interactive",
          risk: "medium",
          policyVersion: "1",
          budget: { maxFixRounds: 2, timeoutMs: 60000 },
        });
        service.advance(run.id, "preflight");
        service.advance(run.id, "implementing");
        service.advance(run.id, "collecting");
        service.advance(run.id, "quick-verifying");
        service.advance(run.id, "reviewing");
        sessionRunner.nextOutput = JSON.stringify({
          verdict: "needs-fix",
          findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: `d-${i}`, evidence: "ev" }],
        });
        const result = await orchestrator.runReview(run.id);
        service.resolveFinding(result.findings[0]!.id, "dismissed");
      }
      for (let i = 0; i < 5; i++) {
        const run = service.startRun({
          projectId: project.id,
          trigger: "interactive",
          risk: "medium",
          policyVersion: "1",
          budget: { maxFixRounds: 2, timeoutMs: 60000 },
        });
        service.advance(run.id, "preflight");
        service.advance(run.id, "implementing");
        service.advance(run.id, "collecting");
        service.advance(run.id, "quick-verifying");
        service.advance(run.id, "reviewing");
        sessionRunner.nextOutput = JSON.stringify({
          verdict: "needs-fix",
          findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: `a-${i}`, evidence: "ev" }],
        });
        const result = await orchestrator.runReview(run.id);
        service.resolveFinding(result.findings[0]!.id, "accepted-risk");
      }
      // 5 pending（不 resolve）
      for (let i = 0; i < 5; i++) {
        const run = service.startRun({
          projectId: project.id,
          trigger: "interactive",
          risk: "medium",
          policyVersion: "1",
          budget: { maxFixRounds: 2, timeoutMs: 60000 },
        });
        service.advance(run.id, "preflight");
        service.advance(run.id, "implementing");
        service.advance(run.id, "collecting");
        service.advance(run.id, "quick-verifying");
        service.advance(run.id, "reviewing");
        sessionRunner.nextOutput = JSON.stringify({
          verdict: "needs-fix",
          findings: [{ severity: "major", confidence: 0.9, category: "correctness", claim: `p-${i}`, evidence: "ev" }],
        });
        await orchestrator.runReview(run.id);
      }

      const metrics = service.getReviewerMetrics(project.id);
      assert.equal(metrics.totalDecisions, 35);
      assert.equal(metrics.confirmed, 20);
      assert.equal(metrics.dismissed, 5);
      assert.equal(metrics.acceptedRisk, 5);
      assert.equal(metrics.pending, 5);
      // 20 / 30 = 0.6667
      assert.ok(Math.abs(metrics.confirmationRate - 20 / 30) < 0.001);
      // 5 / 30 = 0.1667
      assert.ok(Math.abs(metrics.dismissalRate - 5 / 30) < 0.001);
      assert.equal(metrics.sufficient, true);
    });
  });
});
