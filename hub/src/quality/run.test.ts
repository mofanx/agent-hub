import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  createRun,
  isTerminal,
  transition,
  IllegalTransitionError,
  TERMINAL_STAGES,
} from "./run.js";
import type { QualityRun, QualityStage } from "./types.js";

function makeRun(stage: QualityStage, patchHash?: string): QualityRun {
  return {
    id: "r1",
    projectId: "p1",
    trigger: "interactive",
    stage,
    risk: "low",
    policyVersion: "v1",
    patchHash,
    fixRound: 0,
    budget: { maxFixRounds: 2, timeoutMs: 60000 },
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe("quality state machine", () => {
  describe("isTerminal", () => {
    it("accepted/failed/cancelled/quarantined 是终态", () => {
      assert.ok(isTerminal("accepted"));
      assert.ok(isTerminal("failed"));
      assert.ok(isTerminal("cancelled"));
      assert.ok(isTerminal("quarantined"));
    });

    it("非终态 stage 返回 false", () => {
      assert.equal(isTerminal("queued"), false);
      assert.equal(isTerminal("implementing"), false);
      assert.equal(isTerminal("fixing"), false);
      assert.equal(isTerminal("full-verifying"), false);
    });

    it("TERMINAL_STAGES 与 isTerminal 一致", () => {
      for (const s of TERMINAL_STAGES) assert.ok(isTerminal(s));
    });
  });

  describe("canTransition", () => {
    it("queued → preflight / cancelled", () => {
      assert.ok(canTransition("queued", "preflight"));
      assert.ok(canTransition("queued", "cancelled"));
      assert.equal(canTransition("queued", "implementing"), false);
    });

    it("preflight → implementing / failed / quarantined / cancelled", () => {
      assert.ok(canTransition("preflight", "implementing"));
      assert.ok(canTransition("preflight", "failed"));
      assert.ok(canTransition("preflight", "quarantined"));
      assert.ok(canTransition("preflight", "cancelled"));
      assert.equal(canTransition("preflight", "collecting"), false);
    });

    it("implementing → collecting / failed / cancelled", () => {
      assert.ok(canTransition("implementing", "collecting"));
      assert.ok(canTransition("implementing", "failed"));
      assert.ok(canTransition("implementing", "cancelled"));
      assert.equal(canTransition("implementing", "quick-verifying"), false);
    });

    it("collecting → quick-verifying / failed / quarantined / cancelled", () => {
      assert.ok(canTransition("collecting", "quick-verifying"));
      assert.ok(canTransition("collecting", "failed"));
      assert.ok(canTransition("collecting", "quarantined"));
      assert.ok(canTransition("collecting", "cancelled"));
    });

    it("quick-verifying → reviewing / full-verifying / fixing / failed / cancelled", () => {
      assert.ok(canTransition("quick-verifying", "reviewing"));
      assert.ok(canTransition("quick-verifying", "full-verifying"));
      assert.ok(canTransition("quick-verifying", "fixing"));
      assert.ok(canTransition("quick-verifying", "failed"));
      assert.ok(canTransition("quick-verifying", "cancelled"));
    });

    it("reviewing → full-verifying / fixing / awaiting-approval / failed / cancelled", () => {
      assert.ok(canTransition("reviewing", "full-verifying"));
      assert.ok(canTransition("reviewing", "fixing"));
      assert.ok(canTransition("reviewing", "awaiting-approval"));
      assert.ok(canTransition("reviewing", "failed"));
      assert.ok(canTransition("reviewing", "cancelled"));
    });

    it("fixing → collecting / failed / cancelled", () => {
      assert.ok(canTransition("fixing", "collecting"));
      assert.ok(canTransition("fixing", "failed"));
      assert.ok(canTransition("fixing", "cancelled"));
      assert.equal(canTransition("fixing", "quick-verifying"), false);
    });

    it("full-verifying → accepted / fixing / awaiting-approval / failed / cancelled", () => {
      assert.ok(canTransition("full-verifying", "accepted"));
      assert.ok(canTransition("full-verifying", "fixing"));
      assert.ok(canTransition("full-verifying", "awaiting-approval"));
      assert.ok(canTransition("full-verifying", "failed"));
      assert.ok(canTransition("full-verifying", "cancelled"));
    });

    it("awaiting-approval → accepted / failed / fixing / cancelled", () => {
      assert.ok(canTransition("awaiting-approval", "accepted"));
      assert.ok(canTransition("awaiting-approval", "failed"));
      assert.ok(canTransition("awaiting-approval", "fixing"));
      assert.ok(canTransition("awaiting-approval", "cancelled"));
    });

    it("终态不能转换到任何 stage", () => {
      const terminals: QualityStage[] = ["accepted", "failed", "cancelled", "quarantined"];
      const all: QualityStage[] = [
        "queued", "preflight", "implementing", "collecting",
        "quick-verifying", "reviewing", "fixing", "full-verifying",
        "awaiting-approval", "accepted", "failed", "cancelled", "quarantined",
      ];
      for (const t of terminals) {
        for (const s of all) {
          assert.equal(canTransition(t, s), false, `${t} → ${s} should be false`);
        }
      }
    });

    it("不能跳过中间 stage", () => {
      assert.equal(canTransition("queued", "accepted"), false);
      assert.equal(canTransition("implementing", "accepted"), false);
      assert.equal(canTransition("collecting", "accepted"), false);
      assert.equal(canTransition("queued", "reviewing"), false);
    });
  });

  describe("transition", () => {
    it("合法转换更新 stage 和 updatedAt", () => {
      const run = makeRun("queued");
      const next = transition(run, "preflight");
      assert.equal(next.stage, "preflight");
      assert.ok(next.updatedAt >= run.updatedAt);
    });

    it("非法转换抛出 IllegalTransitionError", () => {
      const run = makeRun("queued");
      assert.throws(
        () => transition(run, "implementing"),
        (e) => e instanceof IllegalTransitionError && e.from === "queued" && e.to === "implementing",
      );
    });

    it("终态转换抛出错误", () => {
      const run = makeRun("accepted", "hash123");
      assert.throws(() => transition(run, "failed"), IllegalTransitionError);
      assert.throws(() => transition(run, "queued"), IllegalTransitionError);
    });

    it("accepted 设置 verdict=pass 和 completedAt，要求 patchHash", () => {
      const run = makeRun("full-verifying", "hash123");
      const next = transition(run, "accepted");
      assert.equal(next.verdict, "pass");
      assert.ok(next.completedAt !== undefined);
    });

    it("accepted 无 patchHash 时抛出错误", () => {
      const run = makeRun("full-verifying");
      assert.throws(() => transition(run, "accepted"), IllegalTransitionError);
    });

    it("failed 设置 verdict=fail 和 completedAt", () => {
      const run = makeRun("preflight");
      const next = transition(run, "failed");
      assert.equal(next.verdict, "fail");
      assert.ok(next.completedAt !== undefined);
    });

    it("cancelled 设置 completedAt 但不设置 verdict", () => {
      const run = makeRun("queued");
      const next = transition(run, "cancelled");
      assert.equal(next.verdict, undefined);
      assert.ok(next.completedAt !== undefined);
    });

    it("quarantined 设置 completedAt 但不设置 verdict", () => {
      const run = makeRun("preflight");
      const next = transition(run, "quarantined");
      assert.equal(next.verdict, undefined);
      assert.ok(next.completedAt !== undefined);
    });

    it("fixing 递增 fixRound", () => {
      const run = makeRun("quick-verifying", "hash1");
      assert.equal(run.fixRound, 0);
      const fixing = transition(run, "fixing");
      assert.equal(fixing.fixRound, 1);
      const collecting = transition(fixing, "collecting");
      assert.equal(collecting.fixRound, 1);
      const fixing2 = transition(collecting, "quick-verifying");
      const fixing3 = transition(fixing2, "fixing");
      assert.equal(fixing3.fixRound, 2);
    });

    it("fixing → collecting 清除旧 patchHash", () => {
      const run = makeRun("quick-verifying", "old-hash");
      const fixing = transition(run, "fixing");
      const collecting = transition(fixing, "collecting");
      assert.equal(collecting.patchHash, undefined);
    });

    it("完整 happy path: queued → accepted", () => {
      let run = createRun({
        id: "r2",
        projectId: "p1",
        trigger: "conductor",
        risk: "low",
        policyVersion: "v1",
        budget: { maxFixRounds: 2, timeoutMs: 60000 },
      });
      assert.equal(run.stage, "queued");
      assert.equal(run.fixRound, 0);

      run = transition(run, "preflight");
      run = transition(run, "implementing");
      run = transition(run, "collecting");
      run.patchHash = "patch-abc";
      run = transition(run, "quick-verifying");
      run = transition(run, "reviewing");
      run = transition(run, "full-verifying");
      run = transition(run, "accepted");

      assert.equal(run.stage, "accepted");
      assert.equal(run.verdict, "pass");
      assert.ok(isTerminal(run.stage));
      assert.ok(run.completedAt !== undefined);
    });

    it("修复循环: quick-verifying → fixing → collecting → quick-verifying", () => {
      let run = makeRun("quick-verifying", "hash1");
      run = transition(run, "fixing");
      assert.equal(run.fixRound, 1);
      run = transition(run, "collecting");
      assert.equal(run.patchHash, undefined);
      run.patchHash = "hash2";
      run = transition(run, "quick-verifying");
      assert.equal(run.stage, "quick-verifying");
    });

    it("审批循环: full-verifying → awaiting-approval → fixing → collecting", () => {
      let run = makeRun("full-verifying", "hash1");
      run = transition(run, "awaiting-approval");
      run = transition(run, "fixing");
      assert.equal(run.fixRound, 1);
      run = transition(run, "collecting");
      assert.equal(run.patchHash, undefined);
    });

    it("awaiting-approval → accepted 需要 patchHash", () => {
      const run = makeRun("awaiting-approval", "hash1");
      const next = transition(run, "accepted");
      assert.equal(next.verdict, "pass");
    });

    it("awaiting-approval → accepted 无 patchHash 抛错", () => {
      const run = makeRun("awaiting-approval");
      assert.throws(() => transition(run, "accepted"), IllegalTransitionError);
    });

    it("从任意非终态 stage 可以取消", () => {
      const stages: QualityStage[] = [
        "queued", "preflight", "implementing", "collecting",
        "quick-verifying", "reviewing", "fixing", "full-verifying", "awaiting-approval",
      ];
      for (const s of stages) {
        const run = makeRun(s, "hash");
        const next = transition(run, "cancelled");
        assert.equal(next.stage, "cancelled");
        assert.ok(isTerminal(next.stage));
      }
    });

    it("transition 不修改原 run（不可变）", () => {
      const run = makeRun("queued");
      const next = transition(run, "preflight");
      assert.equal(run.stage, "queued");
      assert.equal(next.stage, "preflight");
    });
  });

  describe("createRun", () => {
    it("创建初始 run stage=queued, fixRound=0", () => {
      const run = createRun({
        id: "r3",
        projectId: "p1",
        trigger: "scheduled",
        risk: "medium",
        policyVersion: "v1",
        budget: { maxFixRounds: 3, timeoutMs: 120000 },
      });
      assert.equal(run.stage, "queued");
      assert.equal(run.fixRound, 0);
      assert.ok(run.createdAt > 0);
      assert.equal(run.createdAt, run.updatedAt);
    });
  });
});
