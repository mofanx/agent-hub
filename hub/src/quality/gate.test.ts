import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GateEngine,
  classifyResult,
  isCheckAffected,
  isInfraFailure,
  matchPath,
  selectChecks,
  type GateResult,
} from "./gate.js";
import type { ExecutionProvider } from "./execution.js";
import type {
  ChangeSet,
  CheckDefinition,
  CheckRun,
  CheckRunStatus,
  ProjectScope,
  QualityPolicy,
} from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeProject(): ProjectScope {
  return {
    id: "p1",
    connectionId: "conn-1",
    root: "/repo/agent-hub",
    gitRoot: "/repo/agent-hub",
    displayName: "agent-hub",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makePolicy(checks: CheckDefinition[]): QualityPolicy {
  return {
    version: 1,
    checks,
    protectedPaths: [],
    riskRules: [],
    review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 2 },
    autonomy: "propose",
  };
}

function makeCheck(id: string, tier: "quick" | "full", paths?: string[]): CheckDefinition {
  return {
    id,
    cwd: ".",
    argv: ["echo", "ok"],
    tier,
    timeoutMs: 10000,
    required: true,
    ...(paths ? { paths } : {}),
  };
}

function makeChangeSet(files: string[]): ChangeSet {
  return {
    runId: "r1",
    patchArtifact: "/tmp/patch.diff",
    patchHash: "hash1",
    files: files.map((p) => ({ path: p, status: "modify" as const })),
    preexistingDirty: false,
    contaminated: false,
    riskReasons: [],
  };
}

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

/** Fake ExecutionProvider：按 checkId 返回预设的 CheckRun。 */
function fakeExec(results: Record<string, CheckRun>): ExecutionProvider {
  return {
    async run(_project, check, _runId): Promise<CheckRun> {
      const preset = results[check.id];
      if (preset) return { ...preset, checkId: check.id };
      return makeCheckRun(check.id, "passed", 0);
    },
    async cancel() {},
  };
}

// ── tests ────────────────────────────────────────────────────────────

describe("gate", () => {
  describe("matchPath", () => {
    it("精确匹配", () => {
      assert.ok(matchPath("hub/src/foo.ts", "hub/src/foo.ts"));
      assert.equal(matchPath("hub/src/foo.ts", "hub/src/bar.ts"), false);
    });

    it("** 递归通配", () => {
      assert.ok(matchPath("hub/**", "hub/src/foo.ts"));
      assert.ok(matchPath("hub/**", "hub/src/quality/gate.ts"));
      assert.ok(matchPath("hub/**", "hub/index.ts"));
      assert.equal(matchPath("hub/**", "desktop/src/app.tsx"), false);
    });

    it("/* 单层通配", () => {
      assert.ok(matchPath("hub/*", "hub/index.ts"));
      assert.equal(matchPath("hub/*", "hub/src/foo.ts"), false);
    });

    it("目录前缀匹配", () => {
      assert.ok(matchPath("hub/src", "hub/src/foo.ts"));
      assert.ok(matchPath("hub/src/", "hub/src/foo.ts"));
      assert.equal(matchPath("hub/src", "desktop/src/foo.ts"), false);
    });
  });

  describe("isInfraFailure", () => {
    it("timeout/infra-failed/cancelled 是 infra failure", () => {
      assert.ok(isInfraFailure("timeout"));
      assert.ok(isInfraFailure("infra-failed"));
      assert.ok(isInfraFailure("cancelled"));
    });

    it("passed/failed/queued/running 不是 infra failure", () => {
      assert.equal(isInfraFailure("passed"), false);
      assert.equal(isInfraFailure("failed"), false);
      assert.equal(isInfraFailure("queued"), false);
      assert.equal(isInfraFailure("running"), false);
    });
  });

  describe("isCheckAffected", () => {
    it("无 paths 总是受影响", () => {
      const check = makeCheck("c1", "quick");
      assert.ok(isCheckAffected(check, makeChangeSet(["hub/foo.ts"])));
    });

    it("无 changeSet 视为全量", () => {
      const check = makeCheck("c1", "quick", ["hub/**"]);
      assert.ok(isCheckAffected(check, undefined));
    });

    it("paths 匹配 changeSet 文件时受影响", () => {
      const check = makeCheck("c1", "quick", ["hub/**"]);
      assert.ok(isCheckAffected(check, makeChangeSet(["hub/src/gate.ts"])));
    });

    it("paths 不匹配 changeSet 文件时不受影响", () => {
      const check = makeCheck("c1", "quick", ["hub/**"]);
      assert.equal(isCheckAffected(check, makeChangeSet(["desktop/src/app.tsx"])), false);
    });

    it("多 paths 任一匹配即受影响", () => {
      const check = makeCheck("c1", "quick", ["desktop/**", "hub/**"]);
      assert.ok(isCheckAffected(check, makeChangeSet(["hub/src/gate.ts"])));
      assert.ok(isCheckAffected(check, makeChangeSet(["desktop/src/app.tsx"])));
      assert.equal(isCheckAffected(check, makeChangeSet(["android/foo.kt"])), false);
    });
  });

  describe("selectChecks", () => {
    it("按 tier 过滤", () => {
      const policy = makePolicy([
        makeCheck("quick-1", "quick", ["hub/**"]),
        makeCheck("full-1", "full", ["hub/**"]),
        makeCheck("quick-2", "quick", ["desktop/**"]),
      ]);
      const cs = makeChangeSet(["hub/src/gate.ts"]);
      const quick = selectChecks(policy, "quick", cs);
      assert.equal(quick.length, 1);
      assert.equal(quick[0]!.id, "quick-1");
      const full = selectChecks(policy, "full", cs);
      assert.equal(full.length, 1);
      assert.equal(full[0]!.id, "full-1");
    });

    it("无 changeSet 时选择全部该 tier 检查", () => {
      const policy = makePolicy([
        makeCheck("quick-1", "quick"),
        makeCheck("quick-2", "quick"),
        makeCheck("full-1", "full"),
      ]);
      const quick = selectChecks(policy, "quick", undefined);
      assert.equal(quick.length, 2);
    });

    it("受影响 paths 正确选检查", () => {
      const policy = makePolicy([
        makeCheck("hub-check", "quick", ["hub/**"]),
        makeCheck("desktop-check", "quick", ["desktop/**"]),
        makeCheck("android-check", "quick", ["android/**"]),
      ]);
      const cs = makeChangeSet(["hub/src/quality/gate.ts", "desktop/src/app.tsx"]);
      const selected = selectChecks(policy, "quick", cs);
      assert.equal(selected.length, 2);
      const ids = selected.map((c) => c.id);
      assert.ok(ids.includes("hub-check"));
      assert.ok(ids.includes("desktop-check"));
      assert.equal(ids.includes("android-check"), false);
    });
  });

  describe("classifyResult", () => {
    it("全部 passed → passed=true", () => {
      const defs = [makeCheck("c1", "quick"), makeCheck("c2", "quick")];
      const checks = [
        makeCheckRun("c1", "passed", 0),
        makeCheckRun("c2", "passed", 0),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, true);
      assert.equal(result.codeFailed, false);
      assert.equal(result.infraFailed, false);
    });

    it("非零 exitCode → failed，绝不 PASS（Q1-01）", () => {
      const defs = [makeCheck("c1", "quick"), makeCheck("c2", "quick")];
      const checks = [
        makeCheckRun("c1", "passed", 0),
        makeCheckRun("c2", "failed", 1),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, true);
      assert.equal(result.infraFailed, false);
    });

    it("timeout 归类为 infra-failed 而非代码缺陷（Q1-02）", () => {
      const defs = [makeCheck("c1", "quick"), makeCheck("c2", "quick")];
      const checks = [
        makeCheckRun("c1", "passed", 0),
        makeCheckRun("c2", "timeout"),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, false);
      assert.equal(result.infraFailed, true);
    });

    it("infra-failed 归类为基础设施失败", () => {
      const defs = [makeCheck("c1", "quick")];
      const checks = [makeCheckRun("c1", "infra-failed")];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, false);
      assert.equal(result.infraFailed, true);
      assert.equal(result.inconclusive, true);
    });

    it("cancelled 归类为取消而非代码缺陷", () => {
      const defs = [makeCheck("c1", "quick")];
      const checks = [makeCheckRun("c1", "cancelled")];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, false);
      assert.equal(result.infraFailed, true);
      assert.equal(result.cancelled, true);
    });

    it("空检查列表 → passed=true（vacuously，无 required 检查）", () => {
      const result = classifyResult("quick", [], []);
      assert.equal(result.passed, true);
      assert.equal(result.requiredCount, 0);
      assert.equal(result.optionalCount, 0);
    });

    it("optional 失败不阻断 passed", () => {
      const defs = [
        { ...makeCheck("c1", "quick"), required: true },
        { ...makeCheck("c2", "quick"), required: false },
      ];
      const checks = [
        makeCheckRun("c1", "passed", 0),
        makeCheckRun("c2", "failed", 1),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, true);
      assert.equal(result.codeFailed, false);
      assert.equal(result.requiredCount, 1);
      assert.equal(result.optionalCount, 1);
    });

    it("optional 基础设施失败不阻断 passed", () => {
      const defs = [
        { ...makeCheck("c1", "quick"), required: true },
        { ...makeCheck("c2", "quick"), required: false },
      ];
      const checks = [
        makeCheckRun("c1", "passed", 0),
        makeCheckRun("c2", "timeout"),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, true);
      assert.equal(result.inconclusive, false);
      assert.equal(result.infraFailed, true);
    });

    it("required 失败阻断 passed", () => {
      const defs = [
        { ...makeCheck("c1", "quick"), required: true },
        { ...makeCheck("c2", "quick"), required: false },
      ];
      const checks = [
        makeCheckRun("c1", "failed", 1),
        makeCheckRun("c2", "passed", 0),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, true);
    });

    it("所有 required 检查 infra-failed → inconclusive", () => {
      const defs = [
        { ...makeCheck("c1", "quick"), required: true },
        { ...makeCheck("c2", "quick"), required: false },
      ];
      const checks = [
        makeCheckRun("c1", "timeout"),
        makeCheckRun("c2", "passed", 0),
      ];
      const result = classifyResult("quick", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.inconclusive, true);
      assert.equal(result.codeFailed, false);
      assert.equal(result.infraFailed, true);
    });

    it("code + infra 混合失败：code 优先于 inconclusive", () => {
      const defs = [
        { ...makeCheck("c1", "quick"), required: true },
        { ...makeCheck("c2", "quick"), required: true },
      ];
      const checks = [
        makeCheckRun("c1", "failed", 1),
        makeCheckRun("c2", "timeout"),
      ];
      const result = classifyResult("full", checks, defs);
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, true);
      assert.equal(result.infraFailed, true);
      assert.equal(result.inconclusive, false);
    });
  });

  describe("GateEngine.runGate", () => {
    it("调用 ExecutionProvider 并返回分类结果", async () => {
      const exec = fakeExec({
        "c1": makeCheckRun("c1", "passed", 0),
        "c2": makeCheckRun("c2", "passed", 0),
      });
      const saved: CheckRun[] = [];
      const gate = new GateEngine(exec, { onSaveCheck: (c) => saved.push(c) });
      const policy = makePolicy([
        makeCheck("c1", "quick", ["hub/**"]),
        makeCheck("c2", "quick", ["hub/**"]),
      ]);
      const cs = makeChangeSet(["hub/src/gate.ts"]);
      const result = await gate.runGate(makeProject(), policy, "quick", "r1", cs);
      assert.equal(result.passed, true);
      assert.equal(result.checks.length, 2);
      assert.equal(saved.length, 2);
    });

    it("非零 exitCode 不 PASS", async () => {
      const exec = fakeExec({
        "c1": makeCheckRun("c1", "passed", 0),
        "c2": makeCheckRun("c2", "failed", 2),
      });
      const gate = new GateEngine(exec);
      const policy = makePolicy([
        makeCheck("c1", "quick", ["hub/**"]),
        makeCheck("c2", "quick", ["hub/**"]),
      ]);
      const result = await gate.runGate(makeProject(), policy, "quick", "r1", makeChangeSet(["hub/foo.ts"]));
      assert.equal(result.passed, false);
      assert.equal(result.codeFailed, true);
    });

    it("timeout 归类为 infra-failed", async () => {
      const exec = fakeExec({ "c1": makeCheckRun("c1", "timeout") });
      const gate = new GateEngine(exec);
      const policy = makePolicy([makeCheck("c1", "quick", ["hub/**"])]);
      const result = await gate.runGate(makeProject(), policy, "quick", "r1", makeChangeSet(["hub/foo.ts"]));
      assert.equal(result.passed, false);
      assert.equal(result.infraFailed, true);
      assert.equal(result.codeFailed, false);
    });

    it("只选择受影响路径的检查", async () => {
      let called: string[] = [];
      const exec: ExecutionProvider = {
        async run(_p, check) {
          called.push(check.id);
          return makeCheckRun(check.id, "passed", 0);
        },
        async cancel() {},
      };
      const gate = new GateEngine(exec);
      const policy = makePolicy([
        makeCheck("hub-check", "quick", ["hub/**"]),
        makeCheck("desktop-check", "quick", ["desktop/**"]),
        makeCheck("android-check", "quick", ["android/**"]),
      ]);
      const cs = makeChangeSet(["hub/src/gate.ts"]);
      await gate.runGate(makeProject(), policy, "quick", "r1", cs);
      assert.deepEqual(called, ["hub-check"]);
    });

    it("full tier 只选 full 检查", async () => {
      let called: string[] = [];
      const exec: ExecutionProvider = {
        async run(_p, check) {
          called.push(check.id);
          return makeCheckRun(check.id, "passed", 0);
        },
        async cancel() {},
      };
      const gate = new GateEngine(exec);
      const policy = makePolicy([
        makeCheck("quick-1", "quick", ["hub/**"]),
        makeCheck("full-1", "full", ["hub/**"]),
      ]);
      await gate.runGate(makeProject(), policy, "full", "r1", makeChangeSet(["hub/foo.ts"]));
      assert.deepEqual(called, ["full-1"]);
    });

    it("onSaveCheck 回调被调用", async () => {
      const exec = fakeExec({ "c1": makeCheckRun("c1", "passed", 0) });
      const saved: CheckRun[] = [];
      const gate = new GateEngine(exec, { onSaveCheck: (c) => saved.push(c) });
      const policy = makePolicy([makeCheck("c1", "quick")]);
      await gate.runGate(makeProject(), policy, "quick", "r1", undefined);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.checkId, "c1");
    });

    it("cancel 调用 ExecutionProvider.cancel", async () => {
      let cancelled = false;
      const exec: ExecutionProvider = {
        async run() { return makeCheckRun("c1", "passed", 0); },
        async cancel() { cancelled = true; },
      };
      const gate = new GateEngine(exec);
      await gate.cancel("r1");
      assert.ok(cancelled);
    });
  });
});
