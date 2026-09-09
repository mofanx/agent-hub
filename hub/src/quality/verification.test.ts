import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import {
  matchCheckEvidence,
  matchTestEvidence,
  matchRuntimeEvidence,
  matchManualEvidence,
  matchReviewEvidence,
  verifyExpectation,
  verifyCriterion,
  buildCoverageMatrix,
  decideVerification,
  toVerificationRecords,
  hasDeterministicEvidence,
  isAiInferenceOnly,
  type ExpectationMatchResult,
  type VerifySpecInput,
} from "./verification.js";
import type {
  AcceptanceCriterion,
  CheckRun,
  EvidenceExpectation,
  RequirementSpec,
  RequirementVerification,
  ReviewFinding,
} from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────

function makeCheckRun(
  checkId: string,
  status: "passed" | "failed" | "timeout" | "infra-failed",
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

function makeFinding(
  id: string,
  blocking: boolean,
  status: "open" | "fixed" | "dismissed" | "accepted-risk" = "fixed",
): ReviewFinding {
  return {
    id,
    runId: "r1",
    severity: "major",
    confidence: 0.9,
    category: "correctness",
    claim: "test finding",
    evidence: "test evidence",
    blocking,
    status,
  };
}

function makeExpectation(
  id: string,
  kind: EvidenceExpectation["kind"],
  extra?: Record<string, unknown>,
): EvidenceExpectation {
  const base: Record<string, unknown> = { id, kind };
  if (kind === "check") base.checkId = extra?.checkId ?? `check-${id}`;
  if (kind === "test") { base.testId = extra?.testId; base.description = extra?.description ?? `test-${id}`; }
  if (kind === "runtime") base.description = extra?.description ?? `runtime-${id}`;
  if (kind === "manual") base.instruction = extra?.instruction ?? `manual-${id}`;
  if (kind === "review") base.rubric = extra?.rubric ?? `rubric-${id}`;
  return base as EvidenceExpectation;
}

function makeCriterion(
  id: string,
  required: boolean,
  expectations: EvidenceExpectation[],
  evidenceMode: "all" | "any" = "all",
): AcceptanceCriterion {
  return { id, description: `criterion-${id}`, required, evidenceMode, expectedEvidence: expectations };
}

function makeSpec(
  id: string,
  version: number,
  criteria: AcceptanceCriterion[],
): RequirementSpec {
  return {
    id,
    requestId: "req-1",
    version,
    goal: "test goal",
    scope: { included: ["src/"], excluded: [] },
    acceptanceCriteria: criteria,
    constraints: [],
    risks: [],
    clarifications: [],
    status: "accepted",
    createdAt: 1000,
    updatedAt: 1000,
  };
}

// ── 证据匹配 ─────────────────────────────────────────────────────────

describe("t6 L3 证据匹配", () => {
  it("matchCheckEvidence：通过的 CheckRun 满足 check 证据", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const cr = makeCheckRun("lint", "passed", 0);
    const result = matchCheckEvidence(exp as Extract<EvidenceExpectation, { kind: "check" }>, [cr]);
    assert.ok(result !== undefined);
    assert.equal(result.checkId, "lint");
  });

  it("matchCheckEvidence：失败的 CheckRun 不满足 check 证据", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const cr = makeCheckRun("lint", "failed", 1);
    const result = matchCheckEvidence(exp as Extract<EvidenceExpectation, { kind: "check" }>, [cr]);
    assert.equal(result, undefined);
  });

  it("matchTestEvidence：通过且 testId 匹配时满足", () => {
    const exp = makeExpectation("e1", "test", { testId: "unit-test" });
    const cr = makeCheckRun("unit-test", "passed", 0);
    const result = matchTestEvidence(exp as Extract<EvidenceExpectation, { kind: "test" }>, [cr]);
    assert.ok(result !== undefined);
  });

  it("matchTestEvidence：无 testId 时用 description 内容匹配", () => {
    const exp = makeExpectation("e1", "test", { description: "unit-test" });
    const cr = makeCheckRun("unit-test", "passed", 0);
    const result = matchTestEvidence(exp as Extract<EvidenceExpectation, { kind: "test" }>, [cr]);
    assert.ok(result !== undefined);
    assert.equal(result.checkId, "unit-test");
  });

  it("matchTestEvidence：无 testId 且 description 不匹配时回退到首个通过 check", () => {
    const exp = makeExpectation("e1", "test", { description: "nonexistent" });
    const cr = makeCheckRun("any-check", "passed", 0);
    const result = matchTestEvidence(exp as Extract<EvidenceExpectation, { kind: "test" }>, [cr]);
    assert.ok(result !== undefined);
  });

  it("matchRuntimeEvidence：description 匹配时满足", () => {
    const exp = makeExpectation("e1", "runtime", { description: "server-startup" });
    const ev = [{ description: "server-startup observed", artifactRef: "log-1" }];
    const result = matchRuntimeEvidence(exp as Extract<EvidenceExpectation, { kind: "runtime" }>, ev);
    assert.ok(result !== undefined);
    assert.equal(result.artifactRef, "log-1");
  });

  it("matchRuntimeEvidence：description 不匹配时不满足", () => {
    const exp = makeExpectation("e1", "runtime", { description: "server-startup" });
    const ev = [{ description: "unrelated runtime event", artifactRef: "log-2" }];
    const result = matchRuntimeEvidence(exp as Extract<EvidenceExpectation, { kind: "runtime" }>, ev);
    assert.equal(result, undefined);
  });

  it("matchRuntimeEvidence：空证据列表不满足", () => {
    const exp = makeExpectation("e1", "runtime", { description: "server-startup" });
    const result = matchRuntimeEvidence(exp as Extract<EvidenceExpectation, { kind: "runtime" }>, []);
    assert.equal(result, undefined);
  });

  it("matchManualEvidence：instruction 匹配时满足", () => {
    const exp = makeExpectation("e1", "manual", { instruction: "verify-login" });
    const ev = [{ instruction: "verify-login flow", verifier: "alice", artifactRef: "note-1" }];
    const result = matchManualEvidence(exp as Extract<EvidenceExpectation, { kind: "manual" }>, ev);
    assert.ok(result !== undefined);
    assert.equal(result.verifier, "alice");
  });

  it("matchManualEvidence：instruction 不匹配时不满足", () => {
    const exp = makeExpectation("e1", "manual", { instruction: "verify-login" });
    const ev = [{ instruction: "unrelated manual step", verifier: "bob" }];
    const result = matchManualEvidence(exp as Extract<EvidenceExpectation, { kind: "manual" }>, ev);
    assert.equal(result, undefined);
  });

  it("matchManualEvidence：空证据列表不满足", () => {
    const exp = makeExpectation("e1", "manual", { instruction: "verify-login" });
    const result = matchManualEvidence(exp as Extract<EvidenceExpectation, { kind: "manual" }>, []);
    assert.equal(result, undefined);
  });

  it("matchReviewEvidence：非 blocking finding 满足 review 证据", () => {
    const exp = makeExpectation("e1", "review", {});
    const f = makeFinding("f1", false);
    const result = matchReviewEvidence(exp as Extract<EvidenceExpectation, { kind: "review" }>, [f]);
    assert.ok(result !== undefined);
  });

  it("matchReviewEvidence：blocking finding 不满足（除非已修复）", () => {
    const exp = makeExpectation("e1", "review", {});
    const f = makeFinding("f1", true, "open");
    const result = matchReviewEvidence(exp as Extract<EvidenceExpectation, { kind: "review" }>, [f]);
    assert.equal(result, undefined);
  });

  it("matchReviewEvidence：blocking 但已修复的 finding 满足", () => {
    const exp = makeExpectation("e1", "review", {});
    const f = makeFinding("f1", true, "fixed");
    const result = matchReviewEvidence(exp as Extract<EvidenceExpectation, { kind: "review" }>, [f]);
    assert.ok(result !== undefined);
  });
});

// ── verifyExpectation ─────────────────────────────────────────────────

describe("t6 L3 verifyExpectation", () => {
  it("check 类型：通过 → satisfied=true", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const cr = makeCheckRun("lint", "passed", 0);
    const result = verifyExpectation(exp, {
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    assert.equal(result.satisfied, true);
    assert.equal(result.method, "check");
  });

  it("manual 类型：有 manual 证据 → satisfied=true", () => {
    const exp = makeExpectation("e1", "manual", { instruction: "manual verify" });
    const result = verifyExpectation(exp, {
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [{ instruction: "manual verify flow", verifier: "user" }],
    });
    assert.equal(result.satisfied, true);
    assert.equal(result.method, "manual");
    assert.equal(result.verifier, "user");
  });

  it("runtime 类型：有 runtime 证据 → satisfied=true", () => {
    const exp = makeExpectation("e1", "runtime", { description: "runtime ok" });
    const result = verifyExpectation(exp, {
      checkRuns: [],
      findings: [],
      runtimeEvidence: [{ description: "runtime ok observed" }],
      manualEvidence: [],
    });
    assert.equal(result.satisfied, true);
    assert.equal(result.method, "runtime");
  });
});

// ── hasDeterministicEvidence / isAiInferenceOnly ────────────────────

describe("t6 L3 确定性证据 vs AI inference", () => {
  it("hasDeterministicEvidence：有 check 证据 → true", () => {
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: true, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai" },
    ];
    assert.equal(hasDeterministicEvidence(results), true);
  });

  it("hasDeterministicEvidence：只有 ai-inference → false", () => {
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai" },
    ];
    assert.equal(hasDeterministicEvidence(results), false);
  });

  it("isAiInferenceOnly：仅 ai-inference 满足 → true", () => {
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: false, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai" },
    ];
    assert.equal(isAiInferenceOnly(results), true);
  });

  it("isAiInferenceOnly：有确定性证据 → false", () => {
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: true, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai" },
    ];
    assert.equal(isAiInferenceOnly(results), false);
  });
});

// ── verifyCriterion ──────────────────────────────────────────────────

describe("t6 L3 verifyCriterion", () => {
  it("required criterion + 确定性证据 → passed", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: true, method: "check", verifier: "gate", evidenceRef: "cr-1" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "passed");
  });

  it("required criterion + 仅 ai-inference → inconclusive", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai", confidence: 0.9, evidenceRef: "ai:e1" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "inconclusive");
    assert.equal(result.method, "ai-inference");
  });

  it("optional criterion + 仅 ai-inference → passed", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", false, [exp]);
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "ai-inference", satisfied: true, method: "ai-inference", verifier: "ai", confidence: 0.9 },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "passed");
  });

  it("required criterion + 无任何证据 → failed", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: false, method: "check", verifier: "gate" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "failed");
  });

  it("waived criterion → status=waived", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: false, method: "check", verifier: "gate" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results, waiverReason: "用户放弃" });
    assert.equal(result.status, "waived");
    assert.equal(result.waiverReason, "用户放弃");
    assert.equal(result.verifier, "user");
  });

  it("evidenceMode=all：所有 expectation 都满足 → passed", () => {
    const exp1 = makeExpectation("e1", "check", { checkId: "lint" });
    const exp2 = makeExpectation("e2", "test", { testId: "unit" });
    const criterion = makeCriterion("c1", true, [exp1, exp2], "all");
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: true, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "test", satisfied: true, method: "test", verifier: "gate" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "passed");
  });

  it("evidenceMode=all：部分满足 → failed", () => {
    const exp1 = makeExpectation("e1", "check", { checkId: "lint" });
    const exp2 = makeExpectation("e2", "test", { testId: "unit" });
    const criterion = makeCriterion("c1", true, [exp1, exp2], "all");
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: true, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "test", satisfied: false, method: "test", verifier: "gate" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "failed");
  });

  it("evidenceMode=any：任一满足 → passed", () => {
    const exp1 = makeExpectation("e1", "check", { checkId: "lint" });
    const exp2 = makeExpectation("e2", "manual", {});
    const criterion = makeCriterion("c1", true, [exp1, exp2], "any");
    const results: ExpectationMatchResult[] = [
      { expectationId: "e1", kind: "check", satisfied: false, method: "check", verifier: "gate" },
      { expectationId: "e2", kind: "manual", satisfied: true, method: "manual", verifier: "user" },
    ];
    const result = verifyCriterion({ criterion, expectationResults: results });
    assert.equal(result.status, "passed");
  });
});

// ── buildCoverageMatrix ──────────────────────────────────────────────

describe("t6 L3 buildCoverageMatrix", () => {
  it("所有 required 通过 → overallStatus=passed", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const cr = makeCheckRun("lint", "passed", 0);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    assert.equal(matrix.overallStatus, "passed");
    assert.equal(matrix.requiredAllPassed, true);
    assert.equal(matrix.entries[0]!.criterionStatus, "passed");
    assert.equal(matrix.entries[0]!.hasDeterministicEvidence, true);
  });

  it("required 未通过 → overallStatus=failed", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const cr = makeCheckRun("lint", "failed", 1);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    assert.equal(matrix.overallStatus, "failed");
    assert.equal(matrix.requiredAllPassed, false);
  });

  it("required 仅 ai-inference → overallStatus=inconclusive", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      aiInference: [{ verifier: "ai", confidence: 0.9, reasoning: "looks good", expectationId: "e1" }],
    });
    assert.equal(matrix.overallStatus, "inconclusive");
    assert.equal(matrix.entries[0]!.hasAiInferenceOnly, true);
    assert.equal(matrix.entries[0]!.hasDeterministicEvidence, false);
  });

  it("specVersion 固定绑定到 spec.version", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 5, [criterion]);
    const cr = makeCheckRun("lint", "passed", 0);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    assert.equal(matrix.specVersion, 5);
  });

  it("waivers 标记对应 criterion 为 waived", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      waivers: [{ criterionId: "c1", reason: "已知限制" }],
    });
    assert.equal(matrix.entries[0]!.criterionStatus, "waived");
    assert.equal(matrix.overallStatus, "waived");
  });
});

// ── decideVerification ────────────────────────────────────────────────

describe("t6 L3 decideVerification", () => {
  it("mode=off → block=false", () => {
    const matrix: any = { overallStatus: "failed", requiredAllPassed: false, optionalAllCovered: false, entries: [] };
    const verdict = decideVerification("off", matrix);
    assert.equal(verdict.block, false);
  });

  it("mode=suggest → block=false（即使 required 未通过）", () => {
    const matrix: any = { overallStatus: "failed", requiredAllPassed: false, optionalAllCovered: false, entries: [] };
    const verdict = decideVerification("suggest", matrix);
    assert.equal(verdict.block, false);
  });

  it("mode=require-evidence + required 未通过 → block=true", () => {
    const matrix: any = {
      overallStatus: "failed",
      requiredAllPassed: false,
      optionalAllCovered: true,
      entries: [{ criterionId: "c1", required: true, criterionStatus: "failed" }],
    };
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(verdict.block, true);
    assert.ok(verdict.reason.includes("c1"));
  });

  it("mode=require-evidence + required 全通过 → block=false", () => {
    const matrix: any = {
      overallStatus: "passed",
      requiredAllPassed: true,
      optionalAllCovered: true,
      entries: [{ criterionId: "c1", required: true, criterionStatus: "passed" }],
    };
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(verdict.block, false);
  });

  it("mode=require-evidence + required waived → block=false", () => {
    const matrix: any = {
      overallStatus: "waived",
      requiredAllPassed: true,
      optionalAllCovered: true,
      entries: [{ criterionId: "c1", required: true, criterionStatus: "waived" }],
    };
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(verdict.block, false);
  });
});

// ── toVerificationRecords ────────────────────────────────────────────

describe("t6 L3 toVerificationRecords", () => {
  it("生成 RequirementVerification 记录，specVersion 固定", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 3, [criterion]);
    const cr = makeCheckRun("lint", "passed", 0);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const records = toVerificationRecords(matrix, spec);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.specVersion, 3);
    assert.equal(records[0]!.criterionId, "c1");
    assert.equal(records[0]!.status, "passed");
    assert.equal(records[0]!.method, "check");
  });

  it("waived 记录包含 waiverReason", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      waivers: [{ criterionId: "c1", reason: "已知限制" }],
    });
    const records = toVerificationRecords(matrix, spec);
    assert.equal(records[0]!.status, "waived");
    assert.equal(records[0]!.waiverReason, "已知限制");
    assert.equal(records[0]!.verifier, "user");
  });
});

// ── 端到端场景 ──────────────────────────────────────────────────────

describe("t6 L3 端到端场景", () => {
  it("场景 1：required check 通过 + optional review 通过 → passed", () => {
    const checkExp = makeExpectation("e1", "check", { checkId: "lint" });
    const reviewExp = makeExpectation("e2", "review", {});
    const requiredCrit = makeCriterion("c1", true, [checkExp]);
    const optionalCrit = makeCriterion("c2", false, [reviewExp]);
    const spec = makeSpec("spec-1", 1, [requiredCrit, optionalCrit]);
    const cr = makeCheckRun("lint", "passed", 0);
    const f = makeFinding("f1", false, "fixed");
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [f],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(matrix.overallStatus, "passed");
    assert.equal(verdict.block, false);
  });

  it("场景 2：required check 失败 + AI inference → inconclusive（不阻断为 failed）", () => {
    const checkExp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [checkExp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      aiInference: [{ verifier: "ai", confidence: 0.8, reasoning: "代码看起来正确", expectationId: "e1" }],
    });
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(matrix.overallStatus, "inconclusive");
    assert.equal(verdict.block, true);
    assert.ok(verdict.reason.includes("c1"));
  });

  it("场景 3：suggest 模式 + required 失败 → block=false（仅报告）", () => {
    const checkExp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [checkExp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const cr = makeCheckRun("lint", "failed", 1);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const verdict = decideVerification("suggest", matrix);
    assert.equal(matrix.overallStatus, "failed");
    assert.equal(verdict.block, false);
  });

  it("场景 4：off 模式 → 完全跳过", () => {
    const checkExp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [checkExp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const verdict = decideVerification("off", matrix);
    assert.equal(verdict.block, false);
    assert.ok(verdict.reason.includes("off"));
  });

  it("场景 5：spec 版本更新后旧验证记录不受影响", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const specV1 = makeSpec("spec-1", 1, [criterion]);
    const specV2 = makeSpec("spec-1", 2, [criterion]);
    const cr = makeCheckRun("lint", "passed", 0);
    const matrixV1 = buildCoverageMatrix({
      spec: specV1,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const matrixV2 = buildCoverageMatrix({
      spec: specV2,
      runId: "r2",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
    });
    const recordsV1 = toVerificationRecords(matrixV1, specV1);
    const recordsV2 = toVerificationRecords(matrixV2, specV2);
    assert.equal(recordsV1[0]!.specVersion, 1);
    assert.equal(recordsV2[0]!.specVersion, 2);
    assert.notEqual(recordsV1[0]!.id, recordsV2[0]!.id);
  });

  it("场景 6：混合证据（check + ai-inference）→ required 通过", () => {
    const checkExp = makeExpectation("e1", "check", { checkId: "lint" });
    const aiExp = makeExpectation("e2", "test", {});
    const criterion = makeCriterion("c1", true, [checkExp, aiExp], "any");
    const spec = makeSpec("spec-1", 1, [criterion]);
    const cr = makeCheckRun("lint", "passed", 0);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [cr],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      aiInference: [{ verifier: "ai", confidence: 0.9, reasoning: "test ok", expectationId: "e2" }],
    });
    assert.equal(matrix.entries[0]!.criterionStatus, "passed");
    assert.equal(matrix.entries[0]!.hasDeterministicEvidence, true);
    assert.equal(matrix.entries[0]!.hasAiInferenceOnly, false);
  });

  it("场景 7：用户放弃某条 required → waived 不阻断", () => {
    const exp = makeExpectation("e1", "check", { checkId: "lint" });
    const criterion = makeCriterion("c1", true, [exp]);
    const spec = makeSpec("spec-1", 1, [criterion]);
    const matrix = buildCoverageMatrix({
      spec,
      runId: "r1",
      checkRuns: [],
      findings: [],
      runtimeEvidence: [],
      manualEvidence: [],
      waivers: [{ criterionId: "c1", reason: "已知限制，用户接受" }],
    });
    const verdict = decideVerification("require-evidence", matrix);
    assert.equal(matrix.overallStatus, "waived");
    assert.equal(verdict.block, false);
  });
});

describe("t6 L3 QualityService.runVerification 集成", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "l3-svc-"));
    store = new Store(dir);
    service = new QualityService(store, () => {});
    service.registerProject({ connectionId: "conn-1", root: dir });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runVerification 对不存在的 run 返回 undefined", () => {
    const result = service.runVerification({ runId: "nonexistent", specId: "nonexistent" });
    assert.equal(result, undefined);
  });

  it("listVerifications 返回空数组（无记录）", () => {
    const list = service.listVerifications("run-1");
    assert.equal(list.length, 0);
  });

  it("waiveCriterion 对不存在的记录返回 undefined", () => {
    const result = service.waiveCriterion("run-1", "criterion-1", "test");
    assert.equal(result, undefined);
  });

  it("advance 进入 requirement-verifying 时自动触发 runVerification（有 spec）", () => {
    const project = service.registerProject({ connectionId: "conn-1", root: dir });
    const request = service.createWorkRequest({
      source: "session",
      intent: "code-change",
      correlationId: "corr-1",
      mode: "session",
    });
    const spec = service.createRequirementSpec({
      requestId: request.id,
      goal: "修复类型错误",
      scope: { included: ["src/index.ts"], excluded: [] },
      acceptanceCriteria: [{
        id: "c1",
        description: "tsc 通过",
        required: true,
        evidenceMode: "all",
        expectedEvidence: [{ id: "e1", kind: "check", checkId: "typecheck" }],
      }],
      constraints: [],
      risks: [],
    });
    const item = service.createWorkItem({
      requestId: request.id,
      projectId: project.id,
      mode: "session",
      specId: spec.id,
      specVersion: spec.version,
    });
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
      workItemId: item.id,
    });
    // 推进到 requirement-verifying（需要经过中间状态）
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "full-verifying");
    service.advance(run.id, "requirement-verifying");

    // 自动触发后应有验证记录
    const verifications = service.listVerifications(run.id);
    assert.ok(verifications.length > 0, "应自动生成验证记录");
    assert.equal(verifications[0]!.runId, run.id);
    assert.equal(verifications[0]!.specId, spec.id);
  });

  it("advance 进入 requirement-verifying 无 workItemId 时不自动触发", () => {
    const project = service.registerProject({ connectionId: "conn-1", root: dir });
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    });
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "full-verifying");
    service.advance(run.id, "requirement-verifying");

    const verifications = service.listVerifications(run.id);
    assert.equal(verifications.length, 0, "无 workItemId 不应触发验证");
  });

  it("advance 进入 requirement-verifying workItem 无 specId 时不自动触发", () => {
    const project = service.registerProject({ connectionId: "conn-1", root: dir });
    const request = service.createWorkRequest({
      source: "session",
      intent: "code-change",
      correlationId: "corr-2",
      mode: "session",
    });
    const item = service.createWorkItem({
      requestId: request.id,
      projectId: project.id,
      mode: "session",
      // 不传 specId
    });
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
      workItemId: item.id,
    });
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "full-verifying");
    service.advance(run.id, "requirement-verifying");

    const verifications = service.listVerifications(run.id);
    assert.equal(verifications.length, 0, "无 specId 不应触发验证");
  });

  it("advance 进入 requirement-verifying 时广播 quality.verification.auto 事件", () => {
    const events: { method: string }[] = [];
    const svc = new QualityService(store, (e) => events.push({ method: e.method }));
    const project = svc.registerProject({ connectionId: "conn-1", root: dir });
    const request = svc.createWorkRequest({
      source: "session",
      intent: "code-change",
      correlationId: "corr-3",
      mode: "session",
    });
    const spec = svc.createRequirementSpec({
      requestId: request.id,
      goal: "修复类型错误",
      scope: { included: ["src/index.ts"], excluded: [] },
      acceptanceCriteria: [{
        id: "c1",
        description: "tsc 通过",
        required: true,
        evidenceMode: "all",
        expectedEvidence: [{ id: "e1", kind: "check", checkId: "typecheck" }],
      }],
      constraints: [],
      risks: [],
    });
    const item = svc.createWorkItem({
      requestId: request.id,
      projectId: project.id,
      mode: "session",
      specId: spec.id,
      specVersion: spec.version,
    });
    const run = svc.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
      workItemId: item.id,
    });
    svc.advance(run.id, "preflight");
    svc.advance(run.id, "implementing");
    svc.advance(run.id, "collecting");
    svc.advance(run.id, "quick-verifying");
    svc.advance(run.id, "full-verifying");
    svc.advance(run.id, "requirement-verifying");

    const autoEvents = events.filter((e) => e.method === "quality.verification.auto");
    assert.equal(autoEvents.length, 1, "应广播一次 quality.verification.auto 事件");
  });

  it("advance 进入 requirement-verifying 后按 verdict 自动推进到终态", () => {
    const project = service.registerProject({ connectionId: "conn-1", root: dir });
    const request = service.createWorkRequest({
      source: "session",
      intent: "code-change",
      correlationId: "corr-term",
      mode: "session",
    });
    const spec = service.createRequirementSpec({
      requestId: request.id,
      goal: "修复类型错误",
      scope: { included: ["src/index.ts"], excluded: [] },
      acceptanceCriteria: [{
        id: "c1",
        description: "tsc 通过",
        required: true,
        evidenceMode: "all",
        expectedEvidence: [{ id: "e1", kind: "check", checkId: "typecheck" }],
      }],
      constraints: [],
      risks: [],
    });
    const item = service.createWorkItem({
      requestId: request.id,
      projectId: project.id,
      mode: "session",
      specId: spec.id,
      specVersion: spec.version,
    });
    const run = service.startRun({
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
      workItemId: item.id,
      patchHash: "patch-123",
    });
    service.advance(run.id, "preflight");
    service.advance(run.id, "implementing");
    service.advance(run.id, "collecting");
    service.advance(run.id, "quick-verifying");
    service.advance(run.id, "full-verifying");
    service.advance(run.id, "requirement-verifying");

    // 无 check 证据 → verdict block=false, overallStatus=inconclusive → 推进到 inconclusive
    const finalRun = service.getRun(run.id);
    assert.ok(finalRun, "run 应存在");
    assert.equal(finalRun!.stage, "inconclusive", "无证据时应推进到 inconclusive");
  });
});
