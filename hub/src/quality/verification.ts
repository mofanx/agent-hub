import * as crypto from "node:crypto";
import type {
  AcceptanceCriterion,
  CheckRun,
  EvidenceExpectation,
  QualityPolicyV2,
  RequirementSpec,
  RequirementVerification,
  ReviewFinding,
  VerificationMode,
} from "./types.js";

/**
 * L3 需求验证门（v3.0 §6.4）。
 *
 * 设计约束：
 * - specVersion 固定绑定：验证记录绑定创建时的 spec 版本，spec 后续更新不影响已有验证；
 * - AI inference 不得单独满足 required criterion：required 验收标准必须有确定性证据（check/test/runtime/manual/review）；
 * - off/suggest/require-evidence 三种语义：
 *   - off：不执行验证，直接放行；
 *   - suggest：执行验证，生成覆盖矩阵，但不阻断（结果仅报告）；
 *   - require-evidence：required 验收标准必须有确定性证据，否则阻断；
 * - unknown：证据不足时标记 inconclusive，不自动 pass；
 * - waived：用户显式放弃某条验收标准，需记录 waiverReason。
 */

export type EvidenceSource =
  | { kind: "check"; checkRun: CheckRun }
  | { kind: "test"; checkRun: CheckRun; testId?: string }
  | { kind: "runtime"; description: string; artifactRef?: string }
  | { kind: "manual"; instruction: string; verifier: string; artifactRef?: string }
  | { kind: "review"; finding: ReviewFinding; rubric: string }
  | { kind: "ai-inference"; verifier: string; confidence: number; reasoning: string };

export type CriterionVerificationResult = {
  criterionId: string;
  expectationId: string;
  status: "passed" | "failed" | "inconclusive" | "waived";
  method: EvidenceExpectation["kind"] | "ai-inference";
  evidenceRefs: string[];
  verifier: string;
  confidence?: number | undefined;
  waiverReason?: string | undefined;
};

export type CoverageMatrixEntry = {
  criterionId: string;
  description: string;
  required: boolean;
  evidenceMode: "all" | "any";
  expectations: {
    expectationId: string;
    kind: EvidenceExpectation["kind"] | "ai-inference";
    satisfied: boolean;
    evidenceRef?: string | undefined;
  }[];
  criterionStatus: "passed" | "failed" | "inconclusive" | "waived" | "pending";
  hasDeterministicEvidence: boolean;
  hasAiInferenceOnly: boolean;
  waiverReason?: string | undefined;
};

export type CoverageMatrix = {
  specId: string;
  specVersion: number;
  runId: string;
  entries: CoverageMatrixEntry[];
  overallStatus: "passed" | "failed" | "inconclusive" | "waived";
  requiredAllPassed: boolean;
  optionalAllCovered: boolean;
};

export type VerificationVerdict = {
  mode: VerificationMode;
  matrix: CoverageMatrix;
  /** require-evidence 模式下 required 未全部通过 → block=true */
  block: boolean;
  /** suggest 模式下始终 block=false */
  reason: string;
};

// ── 证据匹配 ────────────────────────────────────────────────────────

/** 判断 CheckRun 是否满足某 check 类型证据期望。 */
export function matchCheckEvidence(
  expectation: Extract<EvidenceExpectation, { kind: "check" }>,
  checkRuns: CheckRun[],
): CheckRun | undefined {
  return checkRuns.find(
    (cr) => cr.checkId === expectation.checkId && cr.status === "passed",
  );
}

/** 判断 CheckRun 是否满足某 test 类型证据期望。 */
export function matchTestEvidence(
  expectation: Extract<EvidenceExpectation, { kind: "test" }>,
  checkRuns: CheckRun[],
): CheckRun | undefined {
  // test 证据：checkRun 通过即可，testId 可选用于精确匹配
  const candidates = checkRuns.filter((cr) => cr.status === "passed");
  if (expectation.testId) {
    return candidates.find((cr) => cr.checkId === expectation.testId);
  }
  // 无 testId 时，用 description 做内容匹配（checkId 或 summary 包含期望描述）
  const desc = expectation.description.toLowerCase();
  const byDesc = candidates.find((cr) =>
    cr.checkId.toLowerCase().includes(desc) ||
    (cr.summary !== undefined && cr.summary.toLowerCase().includes(desc)),
  );
  return byDesc ?? candidates[0];
}

/** 判断 runtime 证据是否满足（需要外部提供 artifactRef）。 */
export function matchRuntimeEvidence(
  expectation: Extract<EvidenceExpectation, { kind: "runtime" }>,
  runtimeEvidence: { description: string; artifactRef?: string }[],
): { description: string; artifactRef?: string } | undefined {
  // 内容校验：runtime 证据的 description 需与 expectation.description 相关
  const desc = expectation.description.toLowerCase();
  return runtimeEvidence.find((e) => e.description.toLowerCase().includes(desc));
}

/** 判断 manual 证据是否满足。 */
export function matchManualEvidence(
  expectation: Extract<EvidenceExpectation, { kind: "manual" }>,
  manualEvidence: { instruction: string; verifier: string; artifactRef?: string }[],
): { instruction: string; verifier: string; artifactRef?: string } | undefined {
  // 内容校验：manual 证据的 instruction 需与 expectation.instruction 相关
  const instr = expectation.instruction.toLowerCase();
  return manualEvidence.find((e) => e.instruction.toLowerCase().includes(instr));
}

/** 判断 review 证据是否满足（需要 review finding 且非 blocking）。 */
export function matchReviewEvidence(
  _expectation: Extract<EvidenceExpectation, { kind: "review" }>,
  findings: ReviewFinding[],
): ReviewFinding | undefined {
  // review 证据：有非 blocking 的 finding 即可（blocking finding 表示有问题）
  return findings.find((f) => !f.blocking || f.status === "fixed");
}

// ── 单条 expectation 验证 ────────────────────────────────────────────

export type ExpectationMatchResult = {
  expectationId: string;
  kind: EvidenceExpectation["kind"] | "ai-inference";
  satisfied: boolean;
  evidenceRef?: string | undefined;
  method: EvidenceExpectation["kind"] | "ai-inference";
  verifier: string;
  confidence?: number | undefined;
};

/** 验证单条 expectation 是否被满足。 */
export function verifyExpectation(
  expectation: EvidenceExpectation,
  context: {
    checkRuns: CheckRun[];
    findings: ReviewFinding[];
    runtimeEvidence: { description: string; artifactRef?: string }[];
    manualEvidence: { instruction: string; verifier: string; artifactRef?: string }[];
    aiInference?: { verifier: string; confidence: number; reasoning: string; expectationId: string }[] | undefined;
  },
): ExpectationMatchResult {
  const base = { expectationId: expectation.id, kind: expectation.kind };

  switch (expectation.kind) {
    case "check": {
      const cr = matchCheckEvidence(expectation, context.checkRuns);
      return {
        ...base,
        satisfied: cr !== undefined,
        evidenceRef: cr?.id,
        method: "check",
        verifier: "gate-engine",
      };
    }
    case "test": {
      const cr = matchTestEvidence(expectation, context.checkRuns);
      return {
        ...base,
        satisfied: cr !== undefined,
        evidenceRef: cr?.id,
        method: "test",
        verifier: "gate-engine",
      };
    }
    case "runtime": {
      const rt = matchRuntimeEvidence(expectation, context.runtimeEvidence);
      return {
        ...base,
        satisfied: rt !== undefined,
        evidenceRef: rt?.artifactRef,
        method: "runtime",
        verifier: "runtime-observer",
      };
    }
    case "manual": {
      const m = matchManualEvidence(expectation, context.manualEvidence);
      return {
        ...base,
        satisfied: m !== undefined,
        evidenceRef: m?.artifactRef,
        method: "manual",
        verifier: m?.verifier ?? "unknown",
      };
    }
    case "review": {
      const f = matchReviewEvidence(expectation, context.findings);
      return {
        ...base,
        satisfied: f !== undefined,
        evidenceRef: f?.id,
        method: "review",
        verifier: "review-orchestrator",
      };
    }
  }
}

// ── 单条 criterion 验证 ─────────────────────────────────────────────

export type CriterionVerificationInput = {
  criterion: AcceptanceCriterion;
  expectationResults: ExpectationMatchResult[];
  aiInferenceOnly?: boolean | undefined;
  waiverReason?: string | undefined;
};

/** 判断 expectation 列表中是否有确定性证据（非 ai-inference）。 */
export function hasDeterministicEvidence(results: ExpectationMatchResult[]): boolean {
  return results.some((r) => r.kind !== "ai-inference" && r.satisfied);
}

/** 判断是否仅靠 AI inference 满足（无确定性证据）。 */
export function isAiInferenceOnly(results: ExpectationMatchResult[]): boolean {
  const satisfied = results.filter((r) => r.satisfied);
  return satisfied.length > 0 && satisfied.every((r) => r.kind === "ai-inference");
}

/** 验证单条 criterion，返回 criterion 级别状态。 */
export function verifyCriterion(input: CriterionVerificationInput): CriterionVerificationResult {
  const { criterion, expectationResults, waiverReason } = input;

  // waived 优先
  if (waiverReason) {
    return {
      criterionId: criterion.id,
      expectationId: criterion.expectedEvidence[0]?.id ?? "",
      status: "waived",
      method: expectationResults[0]?.method ?? "manual",
      evidenceRefs: [],
      verifier: "user",
      waiverReason,
    };
  }

  const satisfied = expectationResults.filter((r) => r.satisfied);
  const hasDet = hasDeterministicEvidence(expectationResults);
  const aiOnly = isAiInferenceOnly(expectationResults);

  // required criterion：AI inference 不得单独满足
  if (criterion.required && aiOnly) {
    return {
      criterionId: criterion.id,
      expectationId: criterion.expectedEvidence[0]?.id ?? "",
      status: "inconclusive",
      method: "ai-inference",
      evidenceRefs: satisfied.map((r) => r.evidenceRef).filter((x): x is string => x !== undefined),
      verifier: "verification-engine",
      confidence: satisfied[0]?.confidence,
    };
  }

  // evidenceMode: all → 所有 expectation 都需满足
  if (criterion.evidenceMode === "all") {
    const allSatisfied = criterion.expectedEvidence.every((e) =>
      expectationResults.some((r) => r.expectationId === e.id && r.satisfied),
    );
    if (allSatisfied && (hasDet || !criterion.required)) {
      return passedResult(criterion, expectationResults);
    }
    if (allSatisfied && criterion.required && !hasDet) {
      return inconclusiveResult(criterion, expectationResults);
    }
    return failedResult(criterion, expectationResults);
  }

  // evidenceMode: any → 任一 expectation 满足即可
  if (criterion.evidenceMode === "any") {
    if (satisfied.length > 0 && (hasDet || !criterion.required)) {
      return passedResult(criterion, expectationResults);
    }
    if (satisfied.length > 0 && criterion.required && !hasDet) {
      return inconclusiveResult(criterion, expectationResults);
    }
    return failedResult(criterion, expectationResults);
  }

  return failedResult(criterion, expectationResults);
}

function passedResult(criterion: AcceptanceCriterion, results: ExpectationMatchResult[]): CriterionVerificationResult {
  const first = results.find((r) => r.satisfied) ?? results[0]!;
  return {
    criterionId: criterion.id,
    expectationId: first.expectationId,
    status: "passed",
    method: first.method,
    evidenceRefs: results.filter((r) => r.satisfied).map((r) => r.evidenceRef).filter((x): x is string => x !== undefined),
    verifier: first.verifier,
    confidence: first.confidence,
  };
}

function failedResult(criterion: AcceptanceCriterion, results: ExpectationMatchResult[]): CriterionVerificationResult {
  const first = results[0] ?? { expectationId: "", method: "manual" as const, verifier: "verification-engine" };
  return {
    criterionId: criterion.id,
    expectationId: first.expectationId,
    status: "failed",
    method: first.method,
    evidenceRefs: [],
    verifier: first.verifier,
  };
}

function inconclusiveResult(criterion: AcceptanceCriterion, results: ExpectationMatchResult[]): CriterionVerificationResult {
  const aiResult = results.find((r) => r.kind === "ai-inference" && r.satisfied);
  return {
    criterionId: criterion.id,
    expectationId: aiResult?.expectationId ?? results[0]?.expectationId ?? "",
    status: "inconclusive",
    method: "ai-inference",
    evidenceRefs: results.filter((r) => r.satisfied).map((r) => r.evidenceRef).filter((x): x is string => x !== undefined),
    verifier: "verification-engine",
    confidence: aiResult?.confidence,
  };
}

// ── 覆盖矩阵 ────────────────────────────────────────────────────────

export type VerifySpecInput = {
  spec: RequirementSpec;
  runId: string;
  checkRuns: CheckRun[];
  findings: ReviewFinding[];
  runtimeEvidence: { description: string; artifactRef?: string }[];
  manualEvidence: { instruction: string; verifier: string; artifactRef?: string }[];
  aiInference?: { verifier: string; confidence: number; reasoning: string; expectationId: string }[] | undefined;
  waivers?: { criterionId: string; reason: string }[] | undefined;
};

/** 构建验收覆盖矩阵。 */
export function buildCoverageMatrix(input: VerifySpecInput): CoverageMatrix {
  const { spec, runId, checkRuns, findings, runtimeEvidence, manualEvidence, aiInference, waivers } = input;
  const entries: CoverageMatrixEntry[] = [];
  const waiverMap = new Map((waivers ?? []).map((w) => [w.criterionId, w.reason]));

  for (const criterion of spec.acceptanceCriteria) {
    const expectationResults = criterion.expectedEvidence.map((exp) => {
      const aiMatch = aiInference?.find((a) => a.expectationId === exp.id);
      const baseResult = verifyExpectation(exp, {
        checkRuns,
        findings,
        runtimeEvidence,
        manualEvidence,
        aiInference,
      });
      // 如果确定性证据未满足但有 AI inference，补充 AI inference 结果
      if (!baseResult.satisfied && aiMatch) {
        return {
          ...baseResult,
          satisfied: true,
          kind: "ai-inference" as const,
          method: "ai-inference" as const,
          verifier: aiMatch.verifier,
          confidence: aiMatch.confidence,
          evidenceRef: `ai-inference:${exp.id}`,
        };
      }
      return baseResult;
    });

    const waiverReason = waiverMap.get(criterion.id);
    const criterionResult = verifyCriterion({
      criterion,
      expectationResults,
      waiverReason,
    });

    const hasDet = hasDeterministicEvidence(expectationResults);
    const aiOnly = isAiInferenceOnly(expectationResults);

    entries.push({
      criterionId: criterion.id,
      description: criterion.description,
      required: criterion.required,
      evidenceMode: criterion.evidenceMode,
      expectations: expectationResults.map((r) => ({
        expectationId: r.expectationId,
        kind: r.kind,
        satisfied: r.satisfied,
        evidenceRef: r.evidenceRef,
      })),
      criterionStatus: criterionResult.status,
      hasDeterministicEvidence: hasDet,
      hasAiInferenceOnly: aiOnly,
      ...(criterionResult.waiverReason !== undefined ? { waiverReason: criterionResult.waiverReason } : {}),
    });
  }

  const requiredCriteria = entries.filter((e) => e.required);
  const optionalCriteria = entries.filter((e) => !e.required);
  const requiredAllPassed = requiredCriteria.every((e) => e.criterionStatus === "passed" || e.criterionStatus === "waived");
  const optionalAllCovered = optionalCriteria.every((e) => e.criterionStatus !== "pending" && e.criterionStatus !== "failed");

  let overallStatus: CoverageMatrix["overallStatus"];
  if (entries.length === 0) {
    overallStatus = "inconclusive";
  } else if (entries.every((e) => e.criterionStatus === "waived")) {
    overallStatus = "waived";
  } else if (requiredAllPassed && optionalAllCovered) {
    overallStatus = "passed";
  } else if (entries.some((e) => e.criterionStatus === "inconclusive")) {
    overallStatus = "inconclusive";
  } else {
    overallStatus = "failed";
  }

  return {
    specId: spec.id,
    specVersion: spec.version,
    runId,
    entries,
    overallStatus,
    requiredAllPassed,
    optionalAllCovered,
  };
}

// ── 验证裁决 ────────────────────────────────────────────────────────

/** 根据 VerificationMode 和覆盖矩阵生成最终裁决。 */
export function decideVerification(
  mode: VerificationMode,
  matrix: CoverageMatrix,
): VerificationVerdict {
  switch (mode) {
    case "off":
      return { mode, matrix, block: false, reason: "verification off, skipping" };
    case "suggest":
      return { mode, matrix, block: false, reason: `verification suggest: overall=${matrix.overallStatus}` };
    case "require-evidence": {
      if (!matrix.requiredAllPassed) {
        const failed = matrix.entries.filter((e) => e.required && e.criterionStatus !== "passed" && e.criterionStatus !== "waived");
        return {
          mode,
          matrix,
          block: true,
          reason: `required criteria not satisfied: ${failed.map((e) => e.criterionId).join(", ")}`,
        };
      }
      return { mode, matrix, block: false, reason: "all required criteria satisfied" };
    }
  }
}

// ── 持久化辅助 ──────────────────────────────────────────────────────

/** 生成 RequirementVerification 记录列表（specVersion 固定绑定）。 */
export function toVerificationRecords(
  matrix: CoverageMatrix,
  spec: RequirementSpec,
): RequirementVerification[] {
  return matrix.entries.map((entry) => {
    const criterion = spec.acceptanceCriteria.find((c) => c.id === entry.criterionId)!;
    const firstExp = entry.expectations[0];
    const record: RequirementVerification = {
      id: `${matrix.runId}:${entry.criterionId}:${matrix.specVersion}`,
      runId: matrix.runId,
      specId: matrix.specId,
      specVersion: matrix.specVersion, // 固定绑定创建时的版本
      criterionId: entry.criterionId,
      expectationId: firstExp?.expectationId ?? "",
      status: entry.criterionStatus === "pending" ? "inconclusive" : entry.criterionStatus,
      method: determineMethod(entry),
      evidenceRefs: entry.expectations.filter((e) => e.satisfied).map((e) => e.evidenceRef).filter((x): x is string => x !== undefined),
      verifier: determineVerifier(entry, criterion),
      ...(entry.criterionStatus === "waived" ? { waiverReason: entry.waiverReason ?? "user waiver" } : {}),
    };
    return record;
  });
}

function determineMethod(entry: CoverageMatrixEntry): RequirementVerification["method"] {
  const satisfied = entry.expectations.filter((e) => e.satisfied);
  if (satisfied.some((e) => e.kind !== "ai-inference")) {
    const det = satisfied.find((e) => e.kind !== "ai-inference")!;
    return det.kind as RequirementVerification["method"];
  }
  if (satisfied.length > 0) {
    return "ai-inference";
  }
  return (entry.expectations[0]?.kind ?? "manual") as RequirementVerification["method"];
}

function determineVerifier(entry: CoverageMatrixEntry, _criterion: AcceptanceCriterion): string {
  if (entry.criterionStatus === "waived") return "user";
  const satisfied = entry.expectations.filter((e) => e.satisfied);
  if (satisfied.some((e) => e.kind === "check" || e.kind === "test")) return "gate-engine";
  if (satisfied.some((e) => e.kind === "review")) return "review-orchestrator";
  if (satisfied.some((e) => e.kind === "manual")) return "manual-verifier";
  if (satisfied.some((e) => e.kind === "runtime")) return "runtime-observer";
  if (satisfied.length > 0) return "ai-inference";
  return "verification-engine";
}

/** 生成 verification id。 */
export function verificationId(runId: string, criterionId: string, specVersion: number): string {
  return `${runId}:${criterionId}:${specVersion}`;
}

/** 生成随机 id（用于新记录）。 */
export function newVerificationId(): string {
  return crypto.randomBytes(8).toString("hex");
}
