import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReviewOrchestrator, type ReviewerSessionRunner } from "./review-orchestrator.js";
import { QualityService } from "./service.js";
import { RunPermissionManager } from "./permissions.js";
import { Store } from "../store.js";
import type { ChangeSet, ProjectScope, QualityPolicy, QualityRun } from "./types.js";
import type { Baseline, ChangeSetCollectorOptions } from "./change-set.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-orch-"));
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

function makePolicy(): QualityPolicy {
  return {
    version: 1,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    review: {
      enabled: true,
      blockSeverity: "major",
      minBlockingConfidence: 0.7,
      maxFixRounds: 2,
    },
    autonomy: "observe",
  };
}

/** Mock session runner：记录调用，返回预设输出。 */
class MockSessionRunner implements ReviewerSessionRunner {
  public prompts: { sessionId: string; text: string }[] = [];
  public nextOutput = "";
  public nextStopReason = "end_turn";
  public createdSessions = 0;
  private sessionCounter = 0;

  async ensureSession(opts: {
    project: ProjectScope;
    run: QualityRun;
    existingSessionId?: string | undefined;
  }): Promise<string> {
    if (opts.existingSessionId) return opts.existingSessionId;
    return `rev-session-${++this.sessionCounter}`;
  }

  async promptOnce(
    sessionId: string,
    text: string,
    _timeoutMs?: number,
  ): Promise<{ output: string; stopReason: string }> {
    this.prompts.push({ sessionId, text });
    return { output: this.nextOutput, stopReason: this.nextStopReason };
  }
}

function setupService(dir: string): { service: QualityService; store: Store; project: ProjectScope } {
  const store = new Store(path.join(dir, "test.db"));
  const emit = () => {};
  const service = new QualityService(store, emit as never);
  const project = makeProject(dir);
  store.upsertQualityProject(project);
  return { service, store, project };
}

describe("ReviewOrchestrator", () => {
  let dir: string;
  let service: QualityService;
  let store: Store;
  let project: ProjectScope;
  let permissionManager: RunPermissionManager;
  let sessionRunner: MockSessionRunner;
  let orchestrator: ReviewOrchestrator;

  beforeEach(() => {
    dir = makeTempDir();
    const setup = setupService(dir);
    service = setup.service;
    store = setup.store;
    project = setup.project;
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
      readAgentsMd: () => "## 规则\n禁止修改 store.ts",
    });
  });

  it("run 不在 reviewing 阶段时抛错", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    await assert.rejects(() => orchestrator.runReview(run.id), /not in reviewing stage/);
  });

  it("verdict=needs-fix + blocking finding → 推进到 fixing", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    // 推进到 reviewing
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "reviewing");

    sessionRunner.nextOutput = JSON.stringify({
      verdict: "needs-fix",
      findings: [
        {
          severity: "major",
          confidence: 0.9,
          category: "correctness",
          file: "src/foo.ts",
          line: 10,
          claim: "bug",
          evidence: "code evidence",
          reproduction: "steps",
          suggestion: "fix it",
        },
      ],
    });

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.verdict, "needs-fix");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.blocking, true);
    assert.equal(result.nextStage, "fixing");

    // finding 已持久化
    const persisted = service.listFindings(run.id);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.claim, "bug");
  });

  it("verdict=pass 无 blocking → 推进到 full-verifying", async () => {
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

    sessionRunner.nextOutput = JSON.stringify({
      verdict: "pass",
      findings: [],
    });

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.verdict, "pass");
    assert.equal(result.findings.length, 0);
    assert.equal(result.nextStage, "full-verifying");
  });

  it("verdict=uncertain → 推进到 awaiting-approval", async () => {
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

    sessionRunner.nextOutput = "I cannot determine the result.";

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.verdict, "uncertain");
    assert.equal(result.findings.length, 0);
    assert.ok(result.parseError !== undefined);
    assert.equal(result.nextStage, "awaiting-approval");
  });

  it("非法 JSON 输出安全失败 → uncertain + parseError", async () => {
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

    sessionRunner.nextOutput = "this is not json at all";

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.verdict, "uncertain");
    assert.ok(result.parseError !== undefined);
    // uncertain → awaiting-approval
    assert.equal(result.nextStage, "awaiting-approval");
  });

  it("超过 maxFixRounds → 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 1, timeoutMs: 60000 },
    });
    // 手动推进到 reviewing，并设置 fixRound=1（已达上限）
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "reviewing");
    // 模拟已经过一轮 fix
    const current = service.getRun(run.id)!;
    service.saveRun({ ...current, fixRound: 1 });

    sessionRunner.nextOutput = JSON.stringify({
      verdict: "needs-fix",
      findings: [
        { severity: "major", confidence: 0.9, category: "correctness", claim: "still broken", evidence: "ev" },
      ],
    });

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.nextStage, "failed");
  });

  it("reviewer session 被绑定只读权限", async () => {
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

    sessionRunner.nextOutput = JSON.stringify({ verdict: "pass", findings: [] });

    await orchestrator.runReview(run.id);

    // reviewer session 应被绑定只读
    assert.equal(permissionManager.isReadOnlyEnforced("rev-session-1"), true);
    assert.equal(permissionManager.checkSession("rev-session-1", "write").allowed, false);
    assert.equal(permissionManager.checkSession("rev-session-1", "read").allowed, true);
  });

  it("复用已有 reviewerSessionId", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
      reviewerSessionId: "existing-rev-session",
    });
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "reviewing");

    sessionRunner.nextOutput = JSON.stringify({ verdict: "pass", findings: [] });

    await orchestrator.runReview(run.id);

    // 应复用 existing-rev-session，不创建新的
    assert.equal(sessionRunner.prompts.length, 1);
    assert.equal(sessionRunner.prompts[0]!.sessionId, "existing-rev-session");
  });

  it("prompt 包含任务上下文、变更文件、AGENTS 规则", async () => {
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

    sessionRunner.nextOutput = JSON.stringify({ verdict: "pass", findings: [] });

    await orchestrator.runReview(run.id);

    const promptText = sessionRunner.prompts[0]!.text;
    assert.ok(promptText.includes("src/foo.ts"));
    assert.ok(promptText.includes("禁止修改 store.ts"));
    assert.ok(promptText.includes("严格 JSON"));
    assert.ok(promptText.includes(run.id));
  });

  it("长输出不截断 - 1000 字符 finding 完整保留", async () => {
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

    const longClaim = "x".repeat(1000);
    const longEvidence = "y".repeat(1000);
    sessionRunner.nextOutput = JSON.stringify({
      verdict: "needs-fix",
      findings: [
        { severity: "major", confidence: 0.9, category: "correctness", claim: longClaim, evidence: longEvidence },
      ],
    });

    const result = await orchestrator.runReview(run.id);
    assert.equal(result.findings[0]!.claim.length, 1000);
    assert.equal(result.findings[0]!.evidence.length, 1000);
  });

  it("prompt 调用失败 → run 推进到 failed", async () => {
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

    // 替换 sessionRunner 使 promptOnce 抛错
    const failingRunner: ReviewerSessionRunner = {
      ensureSession: async () => "rev-fail",
      promptOnce: async () => { throw new Error("connection lost"); },
    };
    const failingOrchestrator = new ReviewOrchestrator(service, permissionManager, failingRunner, {
      artifactDir: dir,
      reviewTimeoutMs: 5000,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId, baseRevision: undefined, patchArtifact: "", patchHash: "h1",
        files: [], preexistingDirty: false, contaminated: false, riskReasons: [],
      }),
      readAgentsMd: () => undefined,
    });

    const result = await failingOrchestrator.runReview(run.id);
    assert.equal(result.nextStage, "failed");
    assert.ok(result.parseError !== undefined);
    assert.ok(result.parseError.includes("connection lost"));
  });

  it("cleanupRun 解绑 reviewer session", async () => {
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

    sessionRunner.nextOutput = JSON.stringify({ verdict: "pass", findings: [] });
    await orchestrator.runReview(run.id);

    assert.equal(permissionManager.isReadOnlyEnforced("rev-session-1"), true);
    orchestrator.cleanupRun(run.id);
    assert.equal(permissionManager.isReadOnlyEnforced("rev-session-1"), false);
  });

  it("verdict=pass 但有 open blocking finding → 推进到 fixing", async () => {
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

    // verdict=pass 但有 major blocking finding
    sessionRunner.nextOutput = JSON.stringify({
      verdict: "pass",
      findings: [
        { severity: "major", confidence: 0.9, category: "correctness", claim: "blocking issue", evidence: "ev" },
      ],
    });

    const result = await orchestrator.runReview(run.id);
    // needsFix 因有 blocking finding → fixing
    assert.equal(result.nextStage, "fixing");
  });
});
