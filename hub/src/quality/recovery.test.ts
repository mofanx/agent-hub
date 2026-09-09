import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { createRun, transition } from "./run.js";
import {
  FAILURE_HUB_RESTART,
  isHubRestartFailure,
  markCheckInfraFailed,
  recoverInterruptedRuns,
  recoverRun,
} from "./recovery.js";
import type { CheckRun, ProjectScope, QualityRun } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-recovery-"));
}

function makeProject(id: string): ProjectScope {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    root: "/repo/agent-hub",
    gitRoot: "/repo/agent-hub",
    displayName: "agent-hub",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(projectId: string, id: string, stage: QualityRun["stage"]): QualityRun {
  const init = createRun({
    id,
    projectId,
    trigger: "interactive",
    risk: "low",
    policyVersion: "v1",
    budget: { maxFixRounds: 2, timeoutMs: 60000 },
  });
  if (stage === "queued") return init;
  const paths: Record<string, QualityRun["stage"][]> = {
    preflight: ["preflight"],
    implementing: ["preflight", "implementing"],
    collecting: ["preflight", "implementing", "collecting"],
    "quick-verifying": ["preflight", "implementing", "collecting", "quick-verifying"],
    reviewing: ["preflight", "implementing", "collecting", "quick-verifying", "reviewing"],
    fixing: ["preflight", "implementing", "collecting", "quick-verifying", "fixing"],
    "full-verifying": ["preflight", "implementing", "collecting", "quick-verifying", "reviewing", "full-verifying"],
    "awaiting-approval": ["preflight", "implementing", "collecting", "quick-verifying", "reviewing", "full-verifying", "awaiting-approval"],
  };
  let run = init;
  for (const s of paths[stage] ?? []) run = transition(run, s);
  return run;
}

function makeCheck(runId: string, id: string, status: CheckRun["status"]): CheckRun {
  return {
    id,
    runId,
    checkId: "hub-typecheck",
    attempt: 1,
    status,
    startedAt: 1000,
  };
}

describe("CheckRun recovery", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
    store.upsertQualityProject(makeProject("p1"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("markCheckInfraFailed", () => {
    it("running → infra-failed 并补全 completedAt", () => {
      const c = markCheckInfraFailed(makeCheck("r1", "c1", "running"), 5000);
      assert.equal(c.status, "infra-failed");
      assert.equal(c.completedAt, 5000);
    });
    it("保留原 summary 若存在", () => {
      const c = markCheckInfraFailed({ ...makeCheck("r1", "c1", "running"), summary: "orig" });
      assert.equal(c.summary, "orig");
    });
    it("无 summary 时填入 interrupted 说明", () => {
      const c = markCheckInfraFailed(makeCheck("r1", "c1", "running"));
      assert.ok(c.summary?.includes("interrupted by hub restart"));
    });
  });

  describe("recoverRun", () => {
    it("implementing run → inconclusive + failureCode=hub-restart，不误报代码失败", () => {
      const run = makeRun("p1", "r1", "implementing");
      const checks = [makeCheck("r1", "c1", "running"), makeCheck("r1", "c2", "queued")];
      const { run: nextRun, checks: nextChecks } = recoverRun(run, checks, 9000);
      assert.equal(nextRun.stage, "inconclusive");
      assert.equal(nextRun.failureCode, FAILURE_HUB_RESTART);
      assert.equal(nextRun.verdict, undefined);
      assert.equal(nextRun.outcome, "inconclusive");
      assert.equal(nextChecks.length, 2);
      assert.ok(nextChecks.every((c) => c.status === "infra-failed"));
    });

    it("queued run → cancelled（不记为 failed）", () => {
      const run = makeRun("p1", "r1", "queued");
      const { run: nextRun } = recoverRun(run, [], 9000);
      assert.equal(nextRun.stage, "cancelled");
      assert.equal(nextRun.failureCode, undefined);
    });

    it("已 passed 的 check 不被改动", () => {
      const run = makeRun("p1", "r1", "quick-verifying");
      const checks = [makeCheck("r1", "c1", "passed"), makeCheck("r1", "c2", "running")];
      const { checks: nextChecks } = recoverRun(run, checks, 9000);
      assert.equal(nextChecks.length, 1);
      assert.equal(nextChecks[0]!.id, "c2");
    });

    it("终态 run 不被恢复", () => {
      let run = makeRun("p1", "r1", "full-verifying");
      run = { ...run, patchHash: "h" };
      run = transition(run, "accepted");
      const { run: nextRun, checks: nextChecks } = recoverRun(run, [makeCheck("r1", "c1", "running")]);
      assert.equal(nextRun, run);
      assert.deepEqual(nextChecks, []);
    });
  });

  describe("recoverInterruptedRuns", () => {
    it("恢复所有非终态 run 并持久化", () => {
      const r1 = makeRun("p1", "r1", "implementing");
      const r2 = makeRun("p1", "r2", "quick-verifying");
      store.saveQualityRun(r1);
      store.saveQualityRun(r2);
      store.saveQualityCheck(makeCheck("r1", "c1", "running"));
      store.saveQualityCheck(makeCheck("r2", "c2", "running"));
      store.saveQualityCheck(makeCheck("r2", "c3", "passed"));

      const summary = recoverInterruptedRuns(store);
      assert.equal(summary.runs.length, 2);
      assert.equal(summary.checks.length, 2);

      const got1 = store.getQualityRun("r1")!;
      assert.equal(got1.stage, "inconclusive");
      assert.equal(got1.failureCode, FAILURE_HUB_RESTART);
      const got2 = store.getQualityRun("r2")!;
      assert.equal(got2.stage, "inconclusive");

      const checks1 = store.listQualityChecks("r1");
      assert.equal(checks1[0]!.status, "infra-failed");
    });

    it("不产生假通过：running check 不变为 passed", () => {
      const run = makeRun("p1", "r1", "implementing");
      store.saveQualityRun(run);
      store.saveQualityCheck(makeCheck("r1", "c1", "running"));
      recoverInterruptedRuns(store);
      const c = store.listQualityChecks("r1")[0]!;
      assert.notEqual(c.status, "passed");
      assert.equal(c.status, "infra-failed");
    });

    it("终态 run 不受影响", () => {
      let run = makeRun("p1", "r1", "full-verifying");
      run = { ...run, patchHash: "h" };
      run = transition(run, "accepted");
      store.saveQualityRun(run);
      const summary = recoverInterruptedRuns(store);
      assert.equal(summary.runs.length, 0);
      assert.equal(store.getQualityRun("r1")!.stage, "accepted");
    });

    it("queued run 恢复为 cancelled", () => {
      const run = makeRun("p1", "r1", "queued");
      store.saveQualityRun(run);
      recoverInterruptedRuns(store);
      assert.equal(store.getQualityRun("r1")!.stage, "cancelled");
    });

    it("无质量数据时返回空摘要", () => {
      const summary = recoverInterruptedRuns(store);
      assert.deepEqual(summary.runs, []);
      assert.deepEqual(summary.checks, []);
    });
  });

  describe("isHubRestartFailure", () => {
    it("识别 hub-restart 失败", () => {
      const run = makeRun("p1", "r1", "implementing");
      const { run: next } = recoverRun(run, []);
      assert.ok(isHubRestartFailure(next));
    });
    it("普通 failed 不识别", () => {
      const run = makeRun("p1", "r1", "preflight");
      const failed = transition(run, "failed");
      assert.equal(isHubRestartFailure(failed), false);
    });
  });
});
