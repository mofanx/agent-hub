import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FixerOrchestrator, buildFixerPrompt, type FixerSessionRunner } from "./fixer-orchestrator.js";
import { GateEngine } from "./gate.js";
import { QualityService } from "./service.js";
import { RunPermissionManager } from "./permissions.js";
import { Store } from "../store.js";
import type {
  ChangeSet,
  CheckRun,
  CheckRunStatus,
  ProjectScope,
  QualityPolicy,
  QualityRun,
  ReviewFinding,
} from "./types.js";
import type { ExecutionProvider } from "./execution.js";
import type { Baseline, ChangeSetCollectorOptions } from "./change-set.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fixer-orch-"));
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

function makePolicy(protectedPaths: string[] = [], riskRules: QualityPolicy["riskRules"] = []): QualityPolicy {
  return {
    version: 1,
    checks: [
      { id: "typecheck", cwd: ".", argv: ["node", "-v"], tier: "quick", timeoutMs: 10_000, required: true },
    ],
    protectedPaths,
    riskRules,
    review: {
      enabled: true,
      blockSeverity: "major",
      minBlockingConfidence: 0.7,
      maxFixRounds: 2,
    },
    autonomy: "observe",
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

function makeCheckRun(checkId: string, status: CheckRunStatus, exitCode?: number): CheckRun {
  return {
    id: `r1:${checkId}:1`,
    runId: "r1",
    checkId,
    attempt: 1,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    durationMs: 100,
  };
}

function makeFinding(
  overrides: Partial<ReviewFinding> & { runId: string },
): ReviewFinding {
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

/** 推进 run 到 fixing 阶段。 */
function advanceToFixing(service: QualityService, runId: string): void {
  service.advance(runId, "preflight");
  service.advance(runId, "implementing");
  service.advance(runId, "collecting");
  service.advance(runId, "quick-verifying");
  service.advance(runId, "reviewing");
  service.advance(runId, "fixing");
}

describe("FixerOrchestrator", () => {
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
    // 覆盖 getPolicy 返回测试 policy（含 checks）
    service.getPolicy = () => ({ policy: testPolicy, source: "file" as const, errors: [] });
    permissionManager = new RunPermissionManager();
    sessionRunner = new MockSessionRunner();
    gateEngine = new GateEngine(fakeExec({}));
    patchHashCounter = 0;
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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

  it("run 不在 fixing 阶段时抛错", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    await assert.rejects(() => orchestrator.runFix(run.id), /not in fixing stage/);
  });

  it("无可用 finding（无 suggestion）→ 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 保存一个 blocking finding 但没有 suggestion
    service.saveFinding(makeFinding({
      runId: run.id,
      suggestion: undefined,
    }));

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
    assert.ok(result.failureReason !== undefined);
    assert.ok(result.failureReason.includes("no fixable findings"));
  });

  it("无 blocking finding → 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 非 blocking finding
    service.saveFinding(makeFinding({
      runId: run.id,
      blocking: false,
    }));

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
  });

  it("成功修复 + quick gate 通过 → 推进到 reviewing", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    // gate 全部通过
    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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
    assert.equal(result.fixed, true);
    assert.equal(result.nextStage, "reviewing");
    assert.ok(result.patchHash.length > 0);
    assert.equal(result.fixerSessionId, "fix-session-1");
    assert.ok(result.quickGate !== undefined);
    assert.equal(result.quickGate!.passed, true);
  });

  it("修复后 patchHash 应更新为新值", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
      patchHash: "old-hash",
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
      collectBaselineFn: () => ({ revision: "", dirtyHash: null, isGit: false }) as Baseline,
      collectChangeSetFn: (runId: string): ChangeSet => ({
        runId,
        baseRevision: undefined,
        patchArtifact: "",
        patchHash: "new-hash-after-fix",
        files: [{ path: "src/foo.ts", status: "modify", additions: 5, deletions: 1 }],
        preexistingDirty: false,
        contaminated: false,
        riskReasons: [],
      }),
    });

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.patchHash, "new-hash-after-fix");
    assert.notEqual(result.patchHash, "old-hash");

    // run 的 patchHash 也应被更新
    const updatedRun = service.getRun(run.id)!;
    assert.equal(updatedRun.patchHash, "new-hash-after-fix");
  });

  it("旧 check 结果不复用 - attempt 递增", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    // 记录 gate 调用的 attempt 参数
    let capturedAttempt = 0;
    const origRunGate = gateEngine.runGate.bind(gateEngine);
    gateEngine.runGate = async (...args) => {
      capturedAttempt = args[5] as number;
      return origRunGate(...args);
    };

    await orchestrator.runFix(run.id);
    // fixRound 在进入 fixing 时已递增为 1，attempt = fixRound + 1 = 2
    assert.ok(capturedAttempt > 1, `attempt should be > 1, got ${capturedAttempt}`);
  });

  it("quick gate codeFailed + 未超 maxFixRounds → 推进到 fixing", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 3, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "failed", 1),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "fixing");
    assert.ok(result.quickGate!.codeFailed);
  });

  it("quick gate codeFailed + 已达 maxFixRounds → 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 1, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    // 进入 fixing 后 fixRound=1，已达 maxFixRounds=1
    const current = service.getRun(run.id)!;
    assert.equal(current.fixRound, 1);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "failed", 1),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
  });

  it("quick gate infraFailed → 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 3, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "timeout"),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
    assert.ok(result.quickGate!.infraFailed);
  });

  it("fixer session 被绑定 fixer 角色（implementer 权限）", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
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

    // fixer session 应被绑定 fixer 角色
    const binding = permissionManager.getBinding("fix-session-1");
    assert.ok(binding !== undefined);
    assert.equal(binding!.role, "fixer");
    // fixer 可以写
    assert.equal(permissionManager.checkSession("fix-session-1", "write").allowed, true);
    // fixer 可以执行
    assert.equal(permissionManager.checkSession("fix-session-1", "execute").allowed, true);
  });

  it("复用已有 implementerSessionId", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
      implementerSessionId: "existing-impl-session",
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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
    assert.equal(result.fixerSessionId, "existing-impl-session");
    assert.equal(sessionRunner.prompts.length, 1);
    assert.equal(sessionRunner.prompts[0]!.sessionId, "existing-impl-session");
  });

  it("prompt 包含 finding suggestion 和 protectedPaths", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({
      runId: run.id,
      claim: "null pointer dereference",
      suggestion: "add null check before accessing property",
    }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    testPolicy = makePolicy(["hub/src/quality/types.ts"]);
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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

    const promptText = sessionRunner.prompts[0]!.text;
    assert.ok(promptText.includes("add null check before accessing property"));
    assert.ok(promptText.includes("null pointer dereference"));
    assert.ok(promptText.includes("hub/src/quality/types.ts"));
    assert.ok(promptText.includes("受保护路径"));
  });

  it("prompt 包含 riskRules", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "high",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    testPolicy = makePolicy([], [
      { pattern: "hub/src/store.ts", risk: "critical", reason: "core persistence layer" },
    ]);
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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

    const promptText = sessionRunner.prompts[0]!.text;
    assert.ok(promptText.includes("hub/src/store.ts"));
    assert.ok(promptText.includes("core persistence layer"));
    assert.ok(promptText.includes("风险规则"));
  });

  it("fixer prompt 调用失败 → 推进到 failed", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    sessionRunner.shouldFail = true;

    const result = await orchestrator.runFix(run.id);
    assert.equal(result.fixed, false);
    assert.equal(result.nextStage, "failed");
    assert.ok(result.failureReason !== undefined);
    assert.ok(result.failureReason.includes("connection lost"));
  });

  it("多个 finding 的 suggestion 都出现在 prompt 中", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({
      runId: run.id,
      claim: "bug A",
      suggestion: "fix A by checking type",
    }));
    service.saveFinding(makeFinding({
      runId: run.id,
      claim: "bug B",
      suggestion: "fix B by adding guard",
    }));

    gateEngine = new GateEngine(fakeExec({
      typecheck: makeCheckRun("typecheck", "passed", 0),
    }));
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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

    const promptText = sessionRunner.prompts[0]!.text;
    assert.ok(promptText.includes("fix A by checking type"));
    assert.ok(promptText.includes("fix B by adding guard"));
    assert.ok(promptText.includes("bug A"));
    assert.ok(promptText.includes("bug B"));
  });

  it("fixing → collecting → quick-verifying 状态转换正确", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
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

    // 最终状态应为 reviewing（quick gate 通过后）
    const finalRun = service.getRun(run.id)!;
    assert.equal(finalRun.stage, "reviewing");
    // fixRound 应为 1（进入 fixing 时递增一次）
    assert.equal(finalRun.fixRound, 1);
  });

  it("cleanupRun 解绑 fixer session", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
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
    assert.ok(permissionManager.getBinding("fix-session-1") !== undefined);

    orchestrator.cleanupRun(run.id);
    assert.ok(permissionManager.getBinding("fix-session-1") === undefined);
  });

  it("check 结果被持久化", async () => {
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "medium",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    });
    advanceToFixing(service, run.id);

    service.saveFinding(makeFinding({ runId: run.id }));

    gateEngine = new GateEngine(
      fakeExec({ typecheck: makeCheckRun("typecheck", "passed", 0) }),
      { onSaveCheck: (check) => service.saveCheck(check) },
    );
    orchestrator = new FixerOrchestrator(service, permissionManager, sessionRunner, gateEngine, {
      artifactDir: dir,
      fixTimeoutMs: 5000,
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

    const checks = service.listChecks(run.id);
    assert.ok(checks.length > 0);
    assert.ok(checks.some((c) => c.checkId === "typecheck"));
  });
});

describe("buildFixerPrompt", () => {
  it("包含 finding claim 和 suggestion", () => {
    const run: QualityRun = {
      id: "q-test",
      projectId: "p-test",
      trigger: "interactive",
      stage: "fixing",
      risk: "medium",
      policyVersion: "1",
      fixRound: 1,
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
      createdAt: 1,
      updatedAt: 1,
    };
    const findings: ReviewFinding[] = [
      makeFinding({
        runId: "q-test",
        claim: "memory leak in handler",
        suggestion: "free the buffer after use",
        file: "src/handler.ts",
        line: 42,
      }),
    ];
    const policy = makePolicy([".devin/quality.json"]);

    const prompt = buildFixerPrompt(run, findings, policy);
    assert.ok(prompt.includes("memory leak in handler"));
    assert.ok(prompt.includes("free the buffer after use"));
    assert.ok(prompt.includes("src/handler.ts:42"));
    assert.ok(prompt.includes(".devin/quality.json"));
  });

  it("无 protectedPaths 时不输出受保护路径段", () => {
    const run: QualityRun = {
      id: "q-test",
      projectId: "p-test",
      trigger: "interactive",
      stage: "fixing",
      risk: "low",
      policyVersion: "1",
      fixRound: 1,
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
      createdAt: 1,
      updatedAt: 1,
    };
    const findings: ReviewFinding[] = [
      makeFinding({ runId: "q-test" }),
    ];
    const policy = makePolicy();

    const prompt = buildFixerPrompt(run, findings, policy);
    assert.ok(!prompt.includes("## 受保护路径"));
  });
});
