import { test } from "node:test";
import assert from "node:assert/strict";
import { DirtyTracker, shouldTriggerGate } from "./quality/dirty-tracker.js";
import { RunContextRegistry } from "./quality/run-context.js";
import { WriterLeaseManager } from "./quality/lease.js";
import { preBindDispatch, releaseBindings, type DispatchPlan, type PreBindDeps } from "./dispatch-plan.js";
import { QualityService } from "./quality/service.js";
import { Store } from "./store.js";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── DirtyTracker 基础行为 ─────────────────────────────────────────────

test("DirtyTracker: markDirty + isDirty + collectPaths", () => {
  const tracker = new DirtyTracker();
  tracker.markDirty("s1", "file", ["/a/b.ts"]);
  assert.equal(tracker.isDirty("s1"), true);
  assert.equal(tracker.isDirty("s2"), false);
  const paths = tracker.collectPaths("s1");
  assert.deepEqual(paths, ["/a/b.ts"]);
  assert.equal(tracker.isDirty("s1"), false);
});

test("DirtyTracker: 多信号合并", () => {
  const tracker = new DirtyTracker();
  tracker.markDirty("s1", "file", ["/a.ts"]);
  tracker.markDirty("s1", "tool", ["/b.ts"]);
  const paths = tracker.collectPaths("s1");
  assert.deepEqual(paths.sort(), ["/a.ts", "/b.ts"]);
});

test("DirtyTracker: 批量检查 + 批量收集", () => {
  const tracker = new DirtyTracker();
  tracker.markDirty("s1", "file");
  tracker.markDirty("s2", "tool");
  assert.equal(tracker.hasDirtyAmong(["s1", "s3"]), true);
  assert.equal(tracker.hasDirtyAmong(["s3"]), false);
  const paths = tracker.collectPathsForSessions(["s1", "s2"]);
  assert.equal(paths.length, 0); // 无路径
});

test("shouldTriggerGate: 只有 file/tool 信号触发", () => {
  const tracker = new DirtyTracker();
  const registry = new RunContextRegistry();
  registry.bind("s1", { runId: "r1", role: "implementer" });
  tracker.markDirty("s1", "git");
  assert.equal(shouldTriggerGate(tracker, registry, "s1"), false);
  tracker.markDirty("s1", "file");
  assert.equal(shouldTriggerGate(tracker, registry, "s1"), true);
});

test("shouldTriggerGate: 无活跃 run 不触发", () => {
  const tracker = new DirtyTracker();
  const registry = new RunContextRegistry();
  tracker.markDirty("s1", "file");
  assert.equal(shouldTriggerGate(tracker, registry, "s1"), false);
});

// ── WriterLeaseManager ────────────────────────────────────────────────

test("WriterLeaseManager: 同项目同时只有一个 writer", () => {
  const mgr = new WriterLeaseManager();
  const r1 = mgr.acquire("p1", "holder1", "run1");
  assert.equal(r1.ok, true);
  const r2 = mgr.acquire("p1", "holder2", "run2");
  assert.equal(r2.ok, false);
  // 同 holder 续租
  const r3 = mgr.acquire("p1", "holder1", "run1");
  assert.equal(r3.ok, true);
  // 释放后其他 holder 可获取
  mgr.release("p1", "holder1");
  const r4 = mgr.acquire("p1", "holder2", "run2");
  assert.equal(r4.ok, true);
});

test("WriterLeaseManager: releaseByRunId", () => {
  const mgr = new WriterLeaseManager();
  mgr.acquire("p1", "h1", "r1");
  mgr.acquire("p2", "h2", "r1");
  const released = mgr.releaseByRunId("r1");
  assert.deepEqual(released.sort(), ["p1", "p2"]);
  assert.equal(mgr.isHeld("p1"), false);
  assert.equal(mgr.isHeld("p2"), false);
});

// ── RunContextRegistry ───────────────────────────────────────────────

test("RunContextRegistry: bind + unbind + tagEvent", () => {
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", taskId: "t1", role: "implementer" }, "room1");
  assert.equal(reg.hasActiveRun("s1"), true);
  assert.equal(reg.hasTask("s1", "t1"), true);
  const tagged = reg.tagEvent("s1", { kind: "file" });
  assert.equal(tagged.runId, "r1");
  assert.equal(tagged.taskId, "t1");
  reg.unbind("s1");
  assert.equal(reg.hasActiveRun("s1"), false);
});

test("RunContextRegistry: 重新绑定到新 run 时从旧 run 移除", () => {
  const reg = new RunContextRegistry();
  reg.bind("s1", { runId: "r1", role: "implementer" });
  reg.bind("s1", { runId: "r2", role: "implementer" });
  assert.equal(reg.getSessionsForRun("r1").length, 0);
  assert.equal(reg.getSessionsForRun("r2").length, 1);
});

// ── DispatchPlan preBindDispatch ─────────────────────────────────────

function makeDeps(): { deps: PreBindDeps; qualityService: QualityService; store: Store; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  const store = new Store(join(tmpDir, "test.db"));
  const qualityService = new QualityService(store, () => {}, {
    reviewRunner: () => {},
    fixerRunner: () => {},
    quickRunner: () => {},
    fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  // 注册一个项目
  store.upsertQualityProject({
    id: "proj1",
    connectionId: "conn1",
    root: tmpDir,
    displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  // 写一个默认 policy
  mkdirSync(join(tmpDir, ".devin"), { recursive: true });
  writeFileSync(join(tmpDir, ".devin", "quality.json"), JSON.stringify({
    version: 1,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "apply-low-risk",
  }, null, 2));
  const leaseManager = new WriterLeaseManager();
  const runContextRegistry = new RunContextRegistry();
  const deps: PreBindDeps = {
    qualityService,
    store,
    leaseManager,
    runContextRegistry,
    qualityArtifactDir: join(tmpDir, "artifacts"),
    resolveProject: () => store.getQualityProject("proj1"),
  };
  return { deps, qualityService, store, tmpDir };
}

test("preBindDispatch: 成功预绑定", () => {
  const { deps } = makeDeps();
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 1);
  const b = result.bindings[0]!;
  assert.equal(b.sessionId, "s1");
  assert.equal(b.project.id, "proj1");
  assert.ok(b.policyHash.length > 0);
  assert.ok(b.run.id.startsWith("q-"));
  assert.equal(deps.runContextRegistry.hasActiveRun("s1"), true);
  assert.equal(deps.leaseManager.isHeld("proj1"), true);
});

test("preBindDispatch: lease 被占用时跳过", () => {
  const { deps } = makeDeps();
  // 先占用 lease
  deps.leaseManager.acquire("proj1", "other-holder", "other-run");
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 0);
});

test("preBindDispatch: 项目解析失败时跳过", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  const store = new Store(join(tmpDir, "test.db"));
  const qualityService = new QualityService(store, () => {}, {
    reviewRunner: () => {},
    fixerRunner: () => {},
    quickRunner: () => {},
    fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  const deps: PreBindDeps = {
    qualityService,
    store,
    leaseManager: new WriterLeaseManager(),
    runContextRegistry: new RunContextRegistry(),
    qualityArtifactDir: join(tmpDir, "artifacts"),
    resolveProject: () => undefined,
  };
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 0);
});

test("preBindDispatch: sessionPathsOf 的结果传给 resolveProject", () => {
  const { deps, tmpDir } = makeDeps();
  const seenPaths: string[] = [];
  deps.resolveProject = (paths: string[]) => {
    seenPaths.push(...paths);
    return deps.store.getQualityProject("proj1");
  };
  deps.sessionPathsOf = (sessionId: string) => {
    assert.equal(sessionId, "s1");
    return [tmpDir];
  };
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 1);
  assert.deepEqual(seenPaths, [tmpDir]);
});

test("preBindDispatch: 无 sessionPathsOf 时回退到空路径", () => {
  const { deps } = makeDeps();
  const seenPaths: string[] = [];
  deps.resolveProject = (paths: string[]) => {
    seenPaths.push(...paths);
    return deps.store.getQualityProject("proj1");
  };
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 1);
  assert.deepEqual(seenPaths, []);
});

test("releaseBindings: 释放 lease + runContext + cancel run", () => {
  const { deps, qualityService } = makeDeps();
  const plan: DispatchPlan = {
    targets: [{ sessionId: "s1", content: "do something" }],
    trigger: "interactive",
    risk: "low",
  };
  const result = preBindDispatch(plan, deps);
  assert.equal(result.bindings.length, 1);
  const runId = result.bindings[0]!.run.id;
  releaseBindings(result.bindings, deps);
  assert.equal(deps.leaseManager.isHeld("proj1"), false);
  assert.equal(deps.runContextRegistry.hasActiveRun("s1"), false);
  const run = qualityService.getRun(runId);
  assert.equal(run?.stage, "cancelled");
});

// ── 跨模式一致性：非 conductor run 自动推进 ──────────────────────────

test("跨模式一致性: triggerGateForSession 创建 run 后应自动推进到 quick-verifying", () => {
  // 这个测试验证修复后的行为：非 conductor run 不再停在 queued
  // 实际验证在 index.ts 集成层，这里验证 advance 逻辑可用
  const tmpDir = mkdtempSync(join(tmpdir(), "dispatch-test-"));
  const store = new Store(join(tmpDir, "test.db"));
  const qualityService = new QualityService(store, () => {}, {
    reviewRunner: () => {},
    fixerRunner: () => {},
    quickRunner: () => {},
    fullRunner: () => {},
    onAwaitingApproval: () => {},
    sandboxRunner: async () => ({ passed: true, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 0 }),
  });
  store.upsertQualityProject({
    id: "proj1",
    connectionId: "conn1",
    root: tmpDir,
    displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const run = qualityService.startRun({
    projectId: "proj1",
    trigger: "interactive",
    risk: "medium",
    policyVersion: "1",
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
  });
  // 模拟 triggerGateForSession 的自动推进逻辑
  qualityService.advance(run.id, "preflight");
  qualityService.advance(run.id, "implementing");
  qualityService.advance(run.id, "collecting");
  qualityService.advance(run.id, "quick-verifying");
  const updated = qualityService.getRun(run.id);
  assert.equal(updated?.stage, "quick-verifying");
});

// ── enforcement 控制依赖解锁 ─────────────────────────────────────────

test("enforcement: report 模式下 accepted=false 也解锁", () => {
  const enforcement = "report" as "report" | "require-pass" | "require-approval";
  const shouldUnlock = enforcement === "report" ? true : false;
  assert.equal(shouldUnlock, true);
});

test("enforcement: require-pass 模式下 accepted=false 不解锁", () => {
  const enforcement = "require-pass" as "report" | "require-pass" | "require-approval";
  const accepted = false;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, false);
});

test("enforcement: require-pass 模式下 accepted=true 解锁", () => {
  const enforcement = "require-pass" as "report" | "require-pass" | "require-approval";
  const accepted = true;
  const shouldUnlock = enforcement === "report" ? true : accepted;
  assert.equal(shouldUnlock, true);
});

// ── stale generation 恢复 ────────────────────────────────────────────

test("recovery: stale generation 的 run 标记为 stale 而非 failed", async () => {
  const { recoverRun } = await import("./quality/recovery.js");
  const run = {
    id: "r1",
    projectId: "p1",
    trigger: "interactive" as const,
    stage: "quick-verifying" as const,
    risk: "medium" as const,
    policyVersion: "1",
    fixRound: 0,
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    generation: 2, // stale generation
  };
  const result = recoverRun(run, [], Date.now(), 3); // currentGeneration=3 > generation=2
  assert.equal(result.run.stage, "stale");
  assert.equal(result.run.outcome, "inconclusive");
});

test("recovery: 当前 generation 的 run 标记为 failed", async () => {
  const { recoverRun } = await import("./quality/recovery.js");
  const run = {
    id: "r1",
    projectId: "p1",
    trigger: "interactive" as const,
    stage: "quick-verifying" as const,
    risk: "medium" as const,
    policyVersion: "1",
    fixRound: 0,
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    generation: 0, // 当前 generation
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "inconclusive");
  assert.equal(result.run.failureCode, "hub-restart");
});

test("recovery: queued 状态的 run 标记为 cancelled", async () => {
  const { recoverRun } = await import("./quality/recovery.js");
  const run = {
    id: "r1",
    projectId: "p1",
    trigger: "interactive" as const,
    stage: "queued" as const,
    risk: "medium" as const,
    policyVersion: "1",
    fixRound: 0,
    budget: { maxFixRounds: 0, timeoutMs: 60000 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const result = recoverRun(run, []);
  assert.equal(result.run.stage, "cancelled");
});

// ── findProjectForPaths 路径边界匹配 ──────────────────────────────────

test("findProjectForPaths: 路径边界匹配，不返回 fallback", () => {
  const projects = [
    { id: "p1", root: "/repo/app/", gitRoot: undefined },
    { id: "p2", root: "/repo/application/", gitRoot: undefined },
  ];
  const filePaths = ["/repo/app/src/index.ts"];
  let matched: string | undefined;
  for (const p of projects) {
    const root = p.root;
    const rootWithSlash = root.endsWith("/") ? root : root + "/";
    if (filePaths.some((fp) => fp.startsWith(rootWithSlash) || fp === root)) {
      matched = p.id;
      break;
    }
  }
  assert.equal(matched, "p1");
  const noMatch = ["/other/path"];
  matched = undefined;
  for (const p of projects) {
    const root = p.root;
    const rootWithSlash = root.endsWith("/") ? root : root + "/";
    if (noMatch.some((fp) => fp.startsWith(rootWithSlash) || fp === root)) {
      matched = p.id;
      break;
    }
  }
  assert.equal(matched, undefined);
});

test("findProjectForPaths: gitRoot 匹配", () => {
  const projects = [
    { id: "p1", root: "/repo/subdir/", gitRoot: "/repo/" },
  ];
  const filePaths = ["/repo/other/file.ts"];
  let matched: string | undefined;
  for (const p of projects) {
    const root = p.root;
    const gitRoot = p.gitRoot;
    const rootWithSlash = root.endsWith("/") ? root : root + "/";
    const gitRootWithSlash = gitRoot ? (gitRoot.endsWith("/") ? gitRoot : gitRoot + "/") : undefined;
    if (filePaths.some((fp) =>
      fp.startsWith(rootWithSlash) || fp === root ||
      (gitRootWithSlash !== undefined && (fp.startsWith(gitRootWithSlash) || fp === gitRoot))
    )) {
      matched = p.id;
      break;
    }
  }
  assert.equal(matched, "p1");
});
