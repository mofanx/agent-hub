import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import spawn from "cross-spawn";
import {
  classifyResult,
  isInfraFailure,
  type GateResult,
} from "./gate.js";
import type {
  CheckDefinition,
  CheckRun,
  CheckRunStatus,
} from "./types.js";
import {
  hashFileContent,
  collectUntrackedHashes,
  snapshotBaseline,
  diffBaselines,
  detectContaminationFromSnapshot,
  collectChangeSet,
  type Baseline,
} from "./change-set.js";
import {
  hashPolicy,
  writePolicySnapshot,
} from "./policy.js";
import {
  RoutingExecutionProvider,
  type ExecutionProvider,
} from "./execution.js";
import type { ProjectScope, QualityPolicy } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeCheckRun(
  checkId: string,
  status: CheckRunStatus,
  exitCode?: number,
): CheckRun {
  return {
    id: `r1:${checkId}:1`,
    runId: "r1",
    checkId,
    attempt: 1,
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    durationMs: 100,
    startedAt: 1000,
    completedAt: 1100,
  };
}

function makeCheckDef(id: string, required: boolean): CheckDefinition {
  return {
    id,
    cwd: ".",
    argv: ["echo", "ok"],
    tier: "quick",
    timeoutMs: 10000,
    required,
  };
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

function makeProject(root: string): ProjectScope {
  return {
    id: "p1",
    connectionId: "conn-1",
    root,
    gitRoot: root,
    displayName: "test",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makePolicy(): QualityPolicy {
  return {
    version: 1,
    checks: [],
    protectedPaths: [],
    riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
    autonomy: "observe",
  };
}

// ── Gate classifyResult: required/optional/inconclusive ──────────────

describe("t2 gate classifyResult", () => {
  it("空检查列表 → passed=true（vacuously）", () => {
    const result = classifyResult("quick", [], []);
    assert.equal(result.passed, true);
    assert.equal(result.requiredCount, 0);
    assert.equal(result.optionalCount, 0);
  });

  it("required 全过 → passed=true", () => {
    const defs = [makeCheckDef("c1", true), makeCheckDef("c2", true)];
    const checks = [makeCheckRun("c1", "passed", 0), makeCheckRun("c2", "passed", 0)];
    const result = classifyResult("quick", checks, defs);
    assert.equal(result.passed, true);
    assert.equal(result.requiredCount, 2);
    assert.equal(result.optionalCount, 0);
  });

  it("optional 失败不阻断 passed", () => {
    const defs = [makeCheckDef("c1", true), makeCheckDef("c2", false)];
    const checks = [makeCheckRun("c1", "passed", 0), makeCheckRun("c2", "failed", 1)];
    const result = classifyResult("quick", checks, defs);
    assert.equal(result.passed, true);
    assert.equal(result.codeFailed, false);
    assert.equal(result.requiredCount, 1);
    assert.equal(result.optionalCount, 1);
  });

  it("required 失败 → passed=false, codeFailed=true", () => {
    const defs = [makeCheckDef("c1", true), makeCheckDef("c2", false)];
    const checks = [makeCheckRun("c1", "failed", 1), makeCheckRun("c2", "passed", 0)];
    const result = classifyResult("quick", checks, defs);
    assert.equal(result.passed, false);
    assert.equal(result.codeFailed, true);
  });

  it("所有 required infra-failed → inconclusive=true", () => {
    const defs = [makeCheckDef("c1", true), makeCheckDef("c2", false)];
    const checks = [makeCheckRun("c1", "timeout"), makeCheckRun("c2", "passed", 0)];
    const result = classifyResult("quick", checks, defs);
    assert.equal(result.passed, false);
    assert.equal(result.inconclusive, true);
    assert.equal(result.codeFailed, false);
    assert.equal(result.infraFailed, true);
  });

  it("code + infra 混合 → code 优先（inconclusive=false）", () => {
    const defs = [makeCheckDef("c1", true), makeCheckDef("c2", true)];
    const checks = [makeCheckRun("c1", "failed", 1), makeCheckRun("c2", "timeout")];
    const result = classifyResult("full", checks, defs);
    assert.equal(result.passed, false);
    assert.equal(result.codeFailed, true);
    assert.equal(result.inconclusive, false);
  });

  it("无 definitions 时默认所有 check 为 required", () => {
    const checks = [makeCheckRun("c1", "failed", 1)];
    const result = classifyResult("quick", checks);
    assert.equal(result.passed, false);
    assert.equal(result.codeFailed, true);
  });
});

// ── change-set: patch artifact 写入 + untracked/binary hash ──────────

describe("t2 change-set patch artifact", () => {
  let dir: string;
  let project: ProjectScope;
  let artifactDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-cs-"));
    gitInit(dir);
    writeFile(dir, "README.md", "# test\n");
    gitCommit(dir, "init");
    project = makeProject(dir);
    artifactDir = path.join(dir, "artifacts");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("collectChangeSet 写入 patch.diff 文件", () => {
    writeFile(dir, "src/new.ts", "export const x = 1;\n");
    const baseline: Baseline = { revision: "", dirtyHash: null, isGit: true };
    const realBaseline = { revision: "abc", dirtyHash: null, isGit: true };
    const cs = collectChangeSet("run-1", project, realBaseline, {}, artifactDir);
    assert.ok(cs.patchArtifact.length > 0);
    assert.ok(fs.existsSync(cs.patchArtifact), "patch.diff should exist");
    const content = fs.readFileSync(cs.patchArtifact, "utf-8");
    assert.ok(content.includes("src/new.ts"), "patch should contain untracked file");
  });

  it("hashFileContent 对文本文件返回 sha256", () => {
    const file = path.join(dir, "text.txt");
    fs.writeFileSync(file, "hello world");
    const hash = hashFileContent(file);
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]+$/);
  });

  it("hashFileContent 对二进制文件返回 sha256", () => {
    const file = path.join(dir, "binary.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const hash = hashFileContent(file);
    assert.equal(hash.length, 64);
  });

  it("collectUntrackedHashes 返回 untracked 文件列表", () => {
    writeFile(dir, "untracked1.ts", "export const a = 1;\n");
    writeFile(dir, "untracked2.ts", "export const b = 2;\n");
    const hashes = collectUntrackedHashes(dir);
    assert.equal(hashes.length, 2);
    assert.ok(hashes.some((h) => h.path === "untracked1.ts"));
    assert.ok(hashes.some((h) => h.path === "untracked2.ts"));
    assert.ok(hashes.every((h) => h.hash.length === 64));
  });

  it("collectUntrackedHashes 对二进制文件返回 hash", () => {
    const file = path.join(dir, "binary.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const hashes = collectUntrackedHashes(dir);
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0]!.path, "binary.bin");
    assert.ok(hashes[0]!.hash.length > 0);
  });
});

// ── baseline snapshot API ────────────────────────────────────────────

describe("t2 baseline snapshot", () => {
  let dir: string;
  let project: ProjectScope;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-bl-"));
    gitInit(dir);
    writeFile(dir, "README.md", "# test\n");
    gitCommit(dir, "init");
    project = makeProject(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("snapshotBaseline 返回 revision + dirtyHash + untrackedFiles", () => {
    writeFile(dir, "new.ts", "export const x = 1;\n");
    const snap = snapshotBaseline(project);
    assert.ok(snap.revision.length > 0);
    assert.ok(snap.dirtyHash !== null);
    assert.equal(snap.untrackedFiles.length, 1);
    assert.equal(snap.untrackedFiles[0]!.path, "new.ts");
  });

  it("diffBaselines 检测 untracked 变化", () => {
    writeFile(dir, "a.ts", "a\n");
    const snap1 = snapshotBaseline(project);
    writeFile(dir, "b.ts", "b\n");
    const snap2 = snapshotBaseline(project);
    const diffs = diffBaselines(snap1, snap2);
    assert.ok(diffs.some((d) => d.includes("untracked added: b.ts")));
    assert.ok(diffs.some((d) => d.includes("untracked modified: a.ts") || d.includes("dirtyHash")));
  });

  it("detectContaminationFromSnapshot 干净 baseline 不污染", () => {
    const snap = snapshotBaseline(project);
    const result = detectContaminationFromSnapshot(project, snap);
    assert.equal(result.contaminated, false);
  });

  it("detectContaminationFromSnapshot 有外部写入时检测到污染", () => {
    // baseline 需要有 preexisting dirty（否则所有变更归因于当前 run）
    writeFile(dir, "preexisting.ts", "preexisting\n");
    const snap = snapshotBaseline(project);
    assert.ok(snap.dirtyHash !== null, "baseline should have dirty hash");
    // 模拟外部写入（新增另一个文件）
    writeFile(dir, "external.ts", "external\n");
    const result = detectContaminationFromSnapshot(project, snap);
    assert.equal(result.contaminated, true);
    assert.ok(result.diffs.length > 0);
  });
});

// ── policy snapshot ──────────────────────────────────────────────────

describe("t2 policy snapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "t2-ps-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hashPolicy 返回稳定 sha256", () => {
    const policy = makePolicy();
    const h1 = hashPolicy(policy);
    const h2 = hashPolicy(policy);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
  });

  it("hashPolicy 对不同 policy 返回不同 hash", () => {
    const p1 = makePolicy();
    const p2 = { ...makePolicy(), protectedPaths: ["foo"] };
    assert.notEqual(hashPolicy(p1), hashPolicy(p2));
  });

  it("writePolicySnapshot 写入文件并返回 hash + ref", () => {
    const policy = makePolicy();
    const { hash, ref } = writePolicySnapshot(policy, dir, "run-1");
    assert.equal(hash.length, 64);
    assert.ok(fs.existsSync(ref), "snapshot file should exist");
    const content = fs.readFileSync(ref, "utf-8");
    assert.ok(content.includes("\"version\""));
  });
});

// ── RoutingExecutionProvider ─────────────────────────────────────────

describe("t2 RoutingExecutionProvider", () => {
  it("按 project.connectionId 路由到对应 worker", async () => {
    const localRuns: string[] = [];
    const workerRuns: string[] = [];
    const local: ExecutionProvider = {
      async run(_p, _c, runId) { localRuns.push(runId); return makeCheckRun(_c.id, "passed", 0); },
      async cancel() {},
    };
    const worker: ExecutionProvider = {
      async run(_p, _c, runId) { workerRuns.push(runId); return makeCheckRun(_c.id, "passed", 0); },
      async cancel() {},
    };
    const workers = new Map([["conn-worker", worker]]);
    const routing = new RoutingExecutionProvider(local, workers);

    const projectLocal: ProjectScope = {
      id: "p1", connectionId: "conn-local", root: "/tmp", gitRoot: "/tmp",
      displayName: "local", capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
      createdAt: 0, updatedAt: 0,
    };
    const projectWorker: ProjectScope = { ...projectLocal, connectionId: "conn-worker" };

    const check = makeCheckDef("c1", true);
    await routing.run(projectLocal, check, "run-1");
    await routing.run(projectWorker, check, "run-2");

    assert.deepEqual(localRuns, ["run-1"]);
    assert.deepEqual(workerRuns, ["run-2"]);
  });

  it("无匹配 connectionId 时 fallback 到 local", async () => {
    const local: ExecutionProvider = {
      async run(_p, _c, _runId) { return makeCheckRun(_c.id, "passed", 0); },
      async cancel() {},
    };
    const workers = new Map<string, ExecutionProvider>();
    const routing = new RoutingExecutionProvider(local, workers);
    const project: ProjectScope = {
      id: "p1", connectionId: "unknown", root: "/tmp", gitRoot: "/tmp",
      displayName: "test", capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
      createdAt: 0, updatedAt: 0,
    };
    const check = makeCheckDef("c1", true);
    const result = await routing.run(project, check, "run-1");
    assert.equal(result.status, "passed");
  });

  it("cancel 向所有 provider 广播", async () => {
    let localCancelled = false;
    let workerCancelled = false;
    const local: ExecutionProvider = {
      async run() { return makeCheckRun("c1", "passed", 0); },
      async cancel() { localCancelled = true; },
    };
    const worker: ExecutionProvider = {
      async run() { return makeCheckRun("c1", "passed", 0); },
      async cancel() { workerCancelled = true; },
    };
    const workers = new Map([["conn-w", worker]]);
    const routing = new RoutingExecutionProvider(local, workers);
    await routing.cancel("run-1");
    assert.equal(localCancelled, true);
    assert.equal(workerCancelled, true);
  });
});
