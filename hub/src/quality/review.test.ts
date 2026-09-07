import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewerPrompt,
  parseReviewerOutput,
  validateReviewerOutput,
  isBlocking,
  toReviewFinding,
  findingsFromOutput,
  needsFix,
  canTransitionFindingStatus,
  isValidFindingStatus,
  newFindingId,
  type ReviewerOutput,
} from "./review.js";
import type { CheckRun, ChangeSet, QualityPolicy, QualityRun, ReviewFinding } from "./types.js";

function makeRun(): QualityRun {
  return {
    id: "q-test",
    projectId: "p-test",
    trigger: "interactive",
    stage: "reviewing",
    risk: "medium",
    policyVersion: "1",
    fixRound: 0,
    budget: { maxFixRounds: 2, timeoutMs: 60_000 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeChangeSet(): ChangeSet {
  return {
    runId: "q-test",
    baseRevision: "abc123",
    patchArtifact: "/tmp/patch.diff",
    patchHash: "h1",
    files: [
      { path: "hub/src/foo.ts", status: "modify", additions: 10, deletions: 2 },
      { path: "hub/src/bar.ts", status: "add", additions: 5 },
    ],
    preexistingDirty: false,
    contaminated: false,
    riskReasons: ["touches quality module"],
  };
}

function makeChecks(): CheckRun[] {
  return [
    { id: "c1", runId: "q-test", checkId: "tsc", attempt: 1, status: "passed", exitCode: 0, durationMs: 1000 },
  ];
}

function makePolicy(overrides: Partial<QualityPolicy["review"]> = {}): QualityPolicy {
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
      ...overrides,
    },
    autonomy: "observe",
  };
}

describe("review", () => {
  describe("buildReviewerPrompt", () => {
    it("包含任务上下文、用户目标、变更文件、检查结果", () => {
      const prompt = buildReviewerPrompt({
        run: makeRun(),
        changeSet: makeChangeSet(),
        checks: makeChecks(),
        userGoal: "修复 conductor 失败依赖问题",
      });
      assert.ok(prompt.includes("q-test"));
      assert.ok(prompt.includes("abc123"));
      assert.ok(prompt.includes("hub/src/foo.ts"));
      assert.ok(prompt.includes("tsc"));
      assert.ok(prompt.includes("修复 conductor 失败依赖问题"));
      assert.ok(prompt.includes("严格 JSON"));
    });

    it("包含 patch 和 AGENTS 规则", () => {
      const prompt = buildReviewerPrompt({
        run: makeRun(),
        changeSet: makeChangeSet(),
        checks: makeChecks(),
        userGoal: "目标",
        agentsRules: "禁止修改 store.ts",
        patch: "diff --git a/foo b/foo\n+hello",
      });
      assert.ok(prompt.includes("禁止修改 store.ts"));
      assert.ok(prompt.includes("+hello"));
    });

    it("无检查时显示占位", () => {
      const prompt = buildReviewerPrompt({
        run: makeRun(),
        changeSet: makeChangeSet(),
        checks: [],
        userGoal: "目标",
      });
      assert.ok(prompt.includes("无检查运行"));
    });
  });

  describe("parseReviewerOutput", () => {
    it("解析合法 JSON", () => {
      const raw = JSON.stringify({
        verdict: "needs-fix",
        findings: [
          {
            severity: "major",
            confidence: 0.9,
            category: "correctness",
            file: "a.ts",
            line: 10,
            claim: "bug",
            evidence: "code",
            reproduction: "steps",
            suggestion: "fix",
          },
        ],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(parseError, undefined);
      assert.equal(output.verdict, "needs-fix");
      assert.equal(output.findings.length, 1);
      assert.equal(output.findings[0]!.severity, "major");
    });

    it("解析 markdown 代码块包裹的 JSON", () => {
      const raw = "```json\n" + JSON.stringify({ verdict: "pass", findings: [] }) + "\n```";
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(parseError, undefined);
      assert.equal(output.verdict, "pass");
    });

    it("解析带前后文字的 JSON", () => {
      const raw = "好的，这是审查结果：\n" + JSON.stringify({ verdict: "pass", findings: [] }) + "\n以上。";
      const { output } = parseReviewerOutput(raw);
      assert.equal(output.verdict, "pass");
    });

    it("长输出不截断 - 1000 字符 finding claim 完整保留", () => {
      const longClaim = "x".repeat(1000);
      const longEvidence = "y".repeat(1000);
      const raw = JSON.stringify({
        verdict: "needs-fix",
        findings: [{ severity: "critical", confidence: 0.95, category: "security", claim: longClaim, evidence: longEvidence }],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(parseError, undefined);
      assert.equal(output.findings[0]!.claim.length, 1000);
      assert.equal(output.findings[0]!.evidence.length, 1000);
    });

    it("非法 JSON 安全失败 - 返回 uncertain", () => {
      const { output, parseError } = parseReviewerOutput("not json at all");
      assert.equal(output.verdict, "uncertain");
      assert.equal(output.findings.length, 0);
      assert.ok(parseError !== undefined);
    });

    it("空输出安全失败", () => {
      const { output, parseError } = parseReviewerOutput("");
      assert.equal(output.verdict, "uncertain");
      assert.ok(parseError !== undefined);
    });

    it("非法 verdict 安全失败", () => {
      const raw = JSON.stringify({ verdict: "maybe", findings: [] });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.verdict, "uncertain");
      assert.ok(parseError !== undefined);
    });

    it("findings 非数组安全失败", () => {
      const raw = JSON.stringify({ verdict: "pass", findings: "no" });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.verdict, "pass");
      assert.equal(output.findings.length, 0);
      assert.ok(parseError !== undefined);
    });

    it("单条 finding 非法不阻断其他合法 finding", () => {
      const raw = JSON.stringify({
        verdict: "needs-fix",
        findings: [
          { severity: "major", confidence: 0.9, category: "correctness", claim: "ok", evidence: "ev" },
          { severity: "invalid", confidence: 0.9, category: "correctness", claim: "bad", evidence: "ev" },
          { severity: "minor", confidence: 1.5, category: "correctness", claim: "bad2", evidence: "ev" },
        ],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.findings.length, 1);
      assert.equal(output.findings[0]!.claim, "ok");
      assert.ok(parseError !== undefined);
    });

    it("confidence 边界 0 和 1 合法", () => {
      const raw = JSON.stringify({
        verdict: "pass",
        findings: [
          { severity: "info", confidence: 0, category: "ux", claim: "a", evidence: "e" },
          { severity: "info", confidence: 1, category: "ux", claim: "b", evidence: "e" },
        ],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.findings.length, 2);
      assert.equal(parseError, undefined);
    });

    it("confidence 超范围非法", () => {
      const raw = JSON.stringify({
        verdict: "pass",
        findings: [{ severity: "info", confidence: 1.5, category: "ux", claim: "a", evidence: "e" }],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.findings.length, 0);
      assert.ok(parseError !== undefined);
    });

    it("缺少 claim 非法", () => {
      const raw = JSON.stringify({
        verdict: "pass",
        findings: [{ severity: "info", confidence: 0.5, category: "ux", evidence: "e" }],
      });
      const { output, parseError } = parseReviewerOutput(raw);
      assert.equal(output.findings.length, 0);
      assert.ok(parseError !== undefined);
    });

    it("file 和 line 可选", () => {
      const raw = JSON.stringify({
        verdict: "pass",
        findings: [{ severity: "info", confidence: 0.5, category: "ux", claim: "a", evidence: "e" }],
      });
      const { output } = parseReviewerOutput(raw);
      assert.equal(output.findings[0]!.file, undefined);
      assert.equal(output.findings[0]!.line, undefined);
    });

    it("validateReviewerOutput 接受非对象返回 uncertain", () => {
      const { output, parseError } = validateReviewerOutput("string");
      assert.equal(output.verdict, "uncertain");
      assert.ok(parseError !== undefined);
    });

    it("非整数 line 被忽略", () => {
      const raw = JSON.stringify({
        verdict: "pass",
        findings: [{ severity: "info", confidence: 0.5, category: "ux", claim: "a", evidence: "e", line: 1.5 }],
      });
      const { output } = parseReviewerOutput(raw);
      assert.equal(output.findings[0]!.line, undefined);
    });
  });

  describe("isBlocking", () => {
    it("major + 高置信度 + 有证据 = blocking", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.8, category: "correctness",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), true);
    });

    it("minor 不阻断", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "minor", confidence: 0.9, category: "correctness",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), false);
    });

    it("低置信度不阻断", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.5, category: "correctness",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), false);
    });

    it("无证据无复现不阻断", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.9, category: "correctness",
        claim: "x", evidence: "", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), false);
    });

    it("有复现无证据也阻断", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.9, category: "correctness",
        claim: "x", evidence: "", reproduction: "steps", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), true);
    });

    it("security 类别降低阈值", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.55, category: "security",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      // 0.55 < 0.7 但 security 降阈值到 0.5
      assert.equal(isBlocking(f, policy), true);
    });

    it("critical 降低阈值", () => {
      const policy = makePolicy();
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "critical", confidence: 0.55, category: "correctness",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), true);
    });

    it("blockSeverity=critical 时 major 不阻断", () => {
      const policy = makePolicy({ blockSeverity: "critical" });
      const f: ReviewFinding = {
        id: "f1", runId: "r", severity: "major", confidence: 0.95, category: "correctness",
        claim: "x", evidence: "ev", blocking: false, status: "open",
      };
      assert.equal(isBlocking(f, policy), false);
    });
  });

  describe("toReviewFinding", () => {
    it("生成 id、计算 blocking、初始 status=open", () => {
      const policy = makePolicy();
      const rf = toReviewFinding(
        { severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "ev" },
        "run-1",
        policy,
      );
      assert.ok(rf.id.startsWith("f-"));
      assert.equal(rf.runId, "run-1");
      assert.equal(rf.blocking, true);
      assert.equal(rf.status, "open");
    });
  });

  describe("findingsFromOutput", () => {
    it("批量转换", () => {
      const policy = makePolicy();
      const output: ReviewerOutput = {
        verdict: "needs-fix",
        findings: [
          { severity: "major", confidence: 0.9, category: "correctness", claim: "a", evidence: "e" },
          { severity: "minor", confidence: 0.5, category: "ux", claim: "b", evidence: "e" },
        ],
      };
      const findings = findingsFromOutput(output, "run-1", policy);
      assert.equal(findings.length, 2);
      assert.equal(findings[0]!.blocking, true);
      assert.equal(findings[1]!.blocking, false);
    });
  });

  describe("needsFix", () => {
    it("verdict=needs-fix 返回 true", () => {
      const output: ReviewerOutput = { verdict: "needs-fix", findings: [] };
      assert.equal(needsFix(output, []), true);
    });

    it("verdict=pass 无 blocking 返回 false", () => {
      const output: ReviewerOutput = { verdict: "pass", findings: [] };
      assert.equal(needsFix(output, []), false);
    });

    it("verdict=pass 但有 open blocking finding 返回 true", () => {
      const output: ReviewerOutput = { verdict: "pass", findings: [] };
      const findings: ReviewFinding[] = [
        { id: "f", runId: "r", severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "e", blocking: true, status: "open" },
      ];
      assert.equal(needsFix(output, findings), true);
    });

    it("blocking finding 已 fixed 不触发", () => {
      const output: ReviewerOutput = { verdict: "pass", findings: [] };
      const findings: ReviewFinding[] = [
        { id: "f", runId: "r", severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "e", blocking: true, status: "fixed" },
      ];
      assert.equal(needsFix(output, findings), false);
    });
  });

  describe("finding status transitions", () => {
    it("open → fixed/dismissed/accepted-risk 合法", () => {
      assert.equal(canTransitionFindingStatus("open", "fixed"), true);
      assert.equal(canTransitionFindingStatus("open", "dismissed"), true);
      assert.equal(canTransitionFindingStatus("open", "accepted-risk"), true);
    });

    it("fixed → open 合法（复检未修复）", () => {
      assert.equal(canTransitionFindingStatus("fixed", "open"), true);
    });

    it("dismissed → open 合法", () => {
      assert.equal(canTransitionFindingStatus("dismissed", "open"), true);
    });

    it("accepted-risk → open 合法", () => {
      assert.equal(canTransitionFindingStatus("accepted-risk", "open"), true);
    });

    it("相同状态合法", () => {
      assert.equal(canTransitionFindingStatus("open", "open"), true);
    });

    it("isValidFindingStatus", () => {
      assert.equal(isValidFindingStatus("open"), true);
      assert.equal(isValidFindingStatus("fixed"), true);
      assert.equal(isValidFindingStatus("dismissed"), true);
      assert.equal(isValidFindingStatus("accepted-risk"), true);
      assert.equal(isValidFindingStatus("invalid"), false);
    });

    it("newFindingId 唯一", () => {
      const a = newFindingId();
      const b = newFindingId();
      assert.notEqual(a, b);
      assert.ok(a.startsWith("f-"));
    });
  });
});
