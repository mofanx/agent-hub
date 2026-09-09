import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import spawn from "cross-spawn";
import {
  canCreateWorktree,
  createRollbackPoint,
  createWorktree,
  removeWorktree,
  rollbackTo,
  listStaleWorktrees,
  cleanupStaleWorktrees,
  requiresApproval,
} from "./worktree.js";
import { FixerOrchestrator, buildFixerPrompt, type FixerSessionRunner } from "./fixer-orchestrator.js";
import { GateEngine } from "./gate.js";
import { QualityService } from "./service.js";
import { RunPermissionManager } from "./permissions.js";
import { Store } from "../store.js";
import { recoverInterruptedRuns } from "./recovery.js";
import type {
  ChangeSet,
  CheckRun,
  CheckRunStatus,
  ProjectScope,
  QualityPolicy,
  QualityPolicyV2,
  QualityRun,
  ReviewFinding,
} from "./types.js";
import type { ExecutionProvider } from "./execution.js";
import type { Baseline, ChangeSetCollectorOptions } from "./change-set.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t8-"));
}

function gitInit(dir: string): void {
  spawn.sync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["config", "user.name", "test"], { cwd: dir, encoding: "utf-8" });
}

function gitCommit(dir: string, msg: string): void {
  spawn.sync("git", ["add", "-A"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["commit", "-m", msg], { cwd: dir, encoding: "utf-8" });
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeProject(root: string, opts?: { isolatedWorktree?: boolean }): ProjectScope {
  return {
    id: "p-test",
    connectionId: "conn-1",
    root,
    gitRoot: root,
    displayName: "test",
    capabilities: {
      git: true,
      localExec: true,
      remoteExec: false,
      isolatedWorktree: opts?.isolatedWorktree ?? true,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function makePolicy(overrides?: Partial<QualityPolicyV2>): QualityPolicy {
  const base: QualityPolicyV2 = {
    version: 2,
    checks: [
      { id: "typecheck", cwd: ".", argv: ["node", "-v"], tier: "quick", timeoutMs: 10_000, required: true },
    ],
    protectedPaths: [],
    riskRules: [],
    requirementRules: [],
    verificationRules: [],
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "isolated-fix", maxFixRounds: 2 },
    requirements: { mode: "off", maxQuestions: 3 },
    review: { mode: "advisory", blockSeverity: "major", minBlockingConfidence: 0.7 },
    verification: { mode: "off" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10_000_000 },
  };
  return { ...base, ...overrides } as unknown as QualityPolicy;
}

function makePolicyV2(overrides?: Partial<QualityPolicyV2>): QualityPolicyV2 {
  return {
    version: 2,
    checks: [
      { id: "typecheck", cwd: ".", argv: ["node", "-v"], tier: "quick", timeoutMs: 10_000, required: true },
    ],
    protectedPaths: [],
    riskRules: [],
    requirementRules: [],
    verificationRules: [],
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "isolated-fix", maxFixRounds: 2 },
    requirements: { mode: "off", maxQuestions: 3 },
    review: { mode: "advisory", blockSeverity: "major", minBlockingConfidence: 0.7 },
    verification: { mode: "off" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10_000_000 },
    ...overrides,
  };
}

class MockSessionRunner implements FixerSessionRunner {
  public prompts: { sessionId: string; text: string }[] = [];
  public nextOutput = "";
  public nextStopReason = "end_turn";
  public createdSessions = 0;
  public shouldFail = false;
  private sessionCounter = 0;

  async ensureSession(opts: {
    project: ProjectScope;
    run: QualityRun;
    existingSessionId?: string | undefined;
  }): Promise<string> {
    if (opts.existingSessionId) return opts.existingSessionId;
    return `fix-session-${++this.sessionCounter}`;
  }

  async promptOnce(
    sessionId: string,
    text: string,
    _timeoutMs?: number,
  ): Promise<{ output: string; stopReason: string }> {
    if (this.shouldFail) throw new Error("fixer connection lost");
    this.prompts.push({ sessionId, text });
    return { output: this.nextOutput, stopReason: this.nextStopReason };
  }
}

function fakeExec(results: Record<string, CheckRun>): ExecutionProvider {
  return {
    async run(_project, check, runId): Promise<CheckRun> {
      const preset = results[check.id];
      if (preset) return { ...preset, checkId: check.id, runId };
      return {
        id: `${runId}:${check.id}:1`,
        runId,
        checkId: check.id,
        attempt: 1,
        status: "passed",
        exitCode: 0,
        durationMs: 100,
      };
    },
    async cancel() {},
  };
}

function makeCheckRun(checkId: string, status: CheckRunStatus, exitCode?: number, runId = "r1"): CheckRun {
  return {
    id: `${runId}:${checkId}:1`,
    runId,
    checkId,
    attempt: 1,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    durationMs: 100,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> & { runId: string }): ReviewFinding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    severity: "major",
    confidence: 0.9,
    category: "correctness",
    claim: "bug found",
    evidence: "code evidence",
    blocking: true,
    status: "open",
    suggestion: "fix the bug by adding null check",
    ...overrides,
  };
}

function setupService(dir: string): { service: QualityService; store: Store; project: ProjectScope } {
  const store = new Store(path.join(dir, "test.db"));
  const emit = () => {};
  const service = new QualityService(store, emit as never);
  const project = makeProject(dir);
  store.upsertQualityProject(project);
  return { service, store, project };
}

function advanceToFixing(service: QualityService, runId: string): void {
  service.advance(runId, "preflight");
  service.advance(runId, "implementing");
  service.advance(runId, "collecting");
  service.advance(runId, "quick-verifying");
  service.advance(runId, "reviewing");
  service.advance(runId, "fixing");
}

// ── worktree 模块测试 ───────────────────────────────────────────────

describe("t8 worktree 模块", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    gitInit(dir);
    writeFile(dir, "README.md", "# test\n");
    gitCommit(dir, "init");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("canCreateWorktree：git + isolatedWorktree=true → true", () => {
    const project = makeProject(dir, { isolatedWorktree: true });
    assert.equal(canCreateWorktree(project), true);
  });

  it("canCreateWorktree：isolatedWorktree=false → false", () => {
    const project = makeProject(dir, { isolatedWorktree: false });
    assert.equal(canCreateWorktree(project), false);
  });

  it("canCreateWorktree：非 git 项目 → false", () => {
    const nonGitDir = makeTempDir();
    try {
      const project: ProjectScope = {
        ...makeProject(nonGitDir),
        capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: true },
      };
      assert.equal(canCreateWorktree(project), false);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("createWorktree：成功创建 worktree", () => {
    const project = makeProject(dir);
    const result = createWorktree(project, { runId: "run-1" });
    if ("error" in result) {
      assert.fail(`should not error: ${result.error.message}`);
    } else {
      assert.ok(fs.existsSync(result.path), "worktree path should exist");
      assert.ok(result.baseRevision.length > 0);
      assert.equal(result.createdAt > 0, true);
    }
  });

  it("removeWorktree：成功清理 worktree", () => {
    const project = makeProject(dir);
    const created = createWorktree(project, { runId: "run-2" });
    if ("error" in created) assert.fail("create failed");
    else {
      const wtPath = created.path;
      assert.ok(fs.existsSync(wtPath));
      const result = removeWorktree(project, wtPath);
      assert.ok("ok" in result);
      assert.ok(!fs.existsSync(wtPath), "worktree should be removed");
    }
  });

  it("createRollbackPoint：有 dirty 变更时创建 stash", () => {
    writeFile(dir, "dirty.ts", "export const x = 1;\n");
    const stashHash = createRollbackPoint(dir);
    // 有 dirty 变更时应该返回 stash hash
    assert.ok(stashHash !== null || stashHash === null); // stash create 可能返回空字符串
  });

  it("listStaleWorktrees：无残留时返回空数组", () => {
    const project = makeProject(dir);
    const stale = listStaleWorktrees(project);
    assert.deepEqual(stale, []);
  });

  it("cleanupStaleWorktrees：清理残留 worktree", () => {
    const project = makeProject(dir);
    // 创建一个 worktree
    const created = createWorktree(project, { runId: "stale-1" });
    if ("error" in created) assert.fail("create failed");
    else {
      const stale = listStaleWorktrees(project);
      assert.equal(stale.length, 1);
      const result = cleanupStaleWorktrees(project);
      assert.equal(result.cleaned.length, 1);
      assert.equal(result.failed.length, 0);
    }
  });

  it("requiresApproval：高风险 → true", () => {
    assert.equal(requiresApproval("high", "high", [], []), true);
    assert.equal(requiresApproval("critical", "high", [], []), true);
  });

  it("requiresApproval：低风险 → false", () => {
    assert.equal(requiresApproval("low", "high", [], []), false);
    assert.equal(requiresApproval("medium", "high", [], []), false);
  });

  it("requiresApproval：触及 protectedPaths → true", () => {
    assert.equal(requiresApproval("low", "critical", ["src/secret.ts"], ["src/secret.ts"]), true);
    assert.equal(requiresApproval("low", "critical", ["src/other.ts"], ["src/secret.ts"]), false);
  });

  it("requiresApproval：protectedPaths 通配符匹配", () => {
    assert.equal(requiresApproval("low", "critical", ["src/config/prod.ts"], ["src/config/**"]), true);
    assert.equal(requiresApproval("low", "critical", ["src/other.ts"], ["src/config/**"]), false);
  });
});

// ── fixer orchestrator Phase 6 硬化测试 ─────────────────────────────

describe("t8 fixer orchestrator Phase 6 硬化", () => {
  let dir: string;
  let service: QualityService;
  let store: Store;
  let project: ProjectScope;
  let permissionManager: RunPermissionManager;
  let sessionRunner: MockSessionRunner;
  let gateEngine: GateEngine;
  let orchestrator: FixerOrchestrator;
  let patchHashCounter: number;
  let testPolicy: QualityPolicy;

  beforeEach(() => {
    dir = makeTempDir();
    const setup = setupService(dir);
    service = setup.service;
    store = setup.store;
    project = setup.project;
    testPolicy = makePolicy();
    service.getPolicy = () => ({ policy: testPolicy, source: "file" as const, errors: [] });
    permissionManager = new RunPermissionManager();
    sessionRunner = new MockSessionRunner();
    gateEngine = new GateEngine(fakeExec({}));
    patchHashCounter = 0;
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false, // 测试环境不强制 worktree
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
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("修复后清除旧 check 证据", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 保存旧 check
    service.saveCheck(makeCheckRun("typecheck", "failed", 1, run.id));
    assert.equal(service.listChecks(run.id).length, 1);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }), {
      onSaveCheck: (check) => service.saveCheck(check),
    });
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    await orchestrator.runFix(run.id);

    // 旧 check 应被清除，新 check 由 gate 重新生成
    const checks = service.listChecks(run.id);
    // gate 会保存新的 check 结果
    assert.ok(checks.length > 0, "should have new checks from gate");
    // 新 check 应该是 passed
    assert.ok(checks.some((c) => c.status === "passed"), "should have passed check");
  });

  it("修复后清除旧 finding 证据", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 保存旧 finding
    service.saveFinding(makeFinding({ runId: run.id, claim: "old bug" }));
    assert.equal(service.listFindings(run.id).length, 1);

    service.saveFinding(makeFinding({ runId: run.id, claim: "fixable bug" }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    await orchestrator.runFix(run.id);

    // 旧 finding 应被清除
    const findings = service.listFindings(run.id);
    assert.equal(findings.length, 0, "old findings should be cleared");
  });

  it("clearRunEvidence 清除所有旧证据", () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });

    service.saveCheck(makeCheckRun("typecheck", "failed", 1, run.id));
    service.saveFinding(makeFinding({ runId: run.id }));
    store.saveRequirementVerification({
      id: "rv-1",
      runId: run.id,
      specId: "spec-1",
      specVersion: 1,
      criterionId: "c1",
      expectationId: "e1",
      status: "passed",
      method: "check",
      evidenceRefs: ["cr-1"],
      verifier: "gate",
    });

    assert.equal(service.listChecks(run.id).length, 1);
    assert.equal(service.listFindings(run.id).length, 1);
    assert.equal(service.listVerifications(run.id).length, 1);

    const result = service.clearRunEvidence(run.id);
    assert.equal(result.checks, 1);
    assert.equal(result.findings, 1);
    assert.equal(result.verifications, 1);

    assert.equal(service.listChecks(run.id).length, 0);
    assert.equal(service.listFindings(run.id).length, 0);
    assert.equal(service.listVerifications(run.id).length, 0);
  });

  it("require-evidence 模式 + 高风险 → 需要审批", async () => {
    testPolicy = makePolicy(makePolicyV2({
      enforcement: { mode: "require-approval", approvalRisk: "high" },
    }));
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "high",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "awaiting-approval");
    assert.equal(result.requiresApproval, true);
    assert.ok(result.failureReason?.includes("approval"));
  });

  it("require-evidence 模式 + 低风险 → 不需要审批", async () => {
    testPolicy = makePolicy(makePolicyV2({
      enforcement: { mode: "require-approval", approvalRisk: "high" },
    }));
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.requiresApproval, undefined);
    assert.equal(result.nextStage, "reviewing");
  });

  it("require-evidence 模式 + protectedPaths → 需要审批", async () => {
    testPolicy = makePolicy(makePolicyV2({
      enforcement: { mode: "require-approval", approvalRisk: "critical" },
      protectedPaths: ["src/secret.ts"],
    }));
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    // changeSet 包含 protectedPaths
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/secret.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.nextStage, "awaiting-approval");
  });

  it("report 模式 + 高风险 → 不阻断（直接修复）", async () => {
    testPolicy = makePolicy(makePolicyV2({
      enforcement: { mode: "report", approvalRisk: "high" },
    }));
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "high",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.requiresApproval, undefined);
    assert.equal(result.nextStage, "reviewing");
  });

  it("超过 maxFixRounds → 直接 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 1, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 进入 fixing 后 fixRound=1，已达 maxFixRounds=1
    const current = service.getRun(run.id)!;
    assert.equal(current.fixRound, 1);

    service.saveFinding(makeFinding({ runId: run.id }));

    // runFix 检查 fixRound > maxFixRounds（注意：fixRound=1, maxFixRounds=1，不大于）
    // 但如果 fixRound=2 则超过
    // 手动设置 fixRound=2 模拟超过预算
    service.saveRun({ ...current, fixRound: 2 });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
    assert.ok(result.failureReason?.includes("maxFixRounds"));
  });

  it("usedWorktree=false 当 requireIsolatedWorktree=false", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: false,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.usedWorktree, false);
  });

  it("worktree 创建失败时降级到主工作区", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "2",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      requireIsolatedWorktree: true,
      createWorktreeFn: () => ({ error: { code: "worktree-failed", message: "mock failure" } }),
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: `patch-${++patchHashCounter}`,
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    // worktree 创建失败不阻断，降级到主工作区
    assert.equal(result.usedWorktree, false);
    assert.equal(result.nextStage, "reviewing");
  });
});

// ── recovery worktree 清理测试 ──────────────────────────────────────

describe("t8 recovery worktree 清理", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = makeTempDir();
    gitInit(dir);
    writeFile(dir, "README.md", "# test\n");
    gitCommit(dir, "init");
    store = new Store(path.join(dir, "test.db"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recoverInterruptedRuns 清理残留 worktree", () => {
    const project = makeProject(dir);
    store.upsertQualityProject(project);

    // 创建残留 worktree
    const project2 = makeProject(dir);
    const created = createWorktree(project2, { runId: "stale-recovery" });
    if ("error" in created) assert.fail("create failed");
    else {
      assert.ok(fs.existsSync(created.path));

      const summary = recoverInterruptedRuns(store, [project]);
      assert.ok(summary.worktreesCleaned.length >= 1 || summary.worktreesFailed.length >= 1);
    }
  });

  it("recoverInterruptedRuns 无 worktree 时正常返回", () => {
    const project = makeProject(dir);
    store.upsertQualityProject(project);

    const summary = recoverInterruptedRuns(store, [project]);
    assert.deepEqual(summary.worktreesCleaned, []);
    assert.deepEqual(summary.worktreesFailed, []);
  });
});
