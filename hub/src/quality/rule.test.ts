import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  newRuleId,
  ruleFingerprint,
  isValidRuleStatus,
  canTransitionRuleStatus,
  createRuleCandidate,
  appendEvidence,
  findMatchingCandidate,
  parseRuleToRiskRule,
  buildSandboxPolicy,
} from "./rule.js";
import type { RuleCandidate } from "./types.js";

describe("rule candidate helpers (Q3-04)", () => {
  it("newRuleId 以 rule- 前缀", () => {
    const id = newRuleId();
    assert.match(id, /^rule-[0-9a-f]{12}$/);
  });

  it("ruleFingerprint 同输入产生同指纹", () => {
    const fp1 = ruleFingerprint("p1", "禁止直接拼接 SQL");
    const fp2 = ruleFingerprint("p1", "禁止直接拼接 SQL");
    const fp3 = ruleFingerprint("p1", "禁止拼接 SQL");
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fp3);
    assert.equal(fp1.length, 16);
  });

  it("isValidRuleStatus", () => {
    assert.equal(isValidRuleStatus("candidate"), true);
    assert.equal(isValidRuleStatus("approved"), true);
    assert.equal(isValidRuleStatus("active"), true);
    assert.equal(isValidRuleStatus("retired"), true);
    assert.equal(isValidRuleStatus("rejected"), true);
    assert.equal(isValidRuleStatus("pending"), false);
  });

  it("canTransitionRuleStatus: candidate → approved/rejected", () => {
    assert.equal(canTransitionRuleStatus("candidate", "approved"), true);
    assert.equal(canTransitionRuleStatus("candidate", "rejected"), true);
    assert.equal(canTransitionRuleStatus("candidate", "active"), false);
  });

  it("canTransitionRuleStatus: approved → active/rejected/candidate", () => {
    assert.equal(canTransitionRuleStatus("approved", "active"), true);
    assert.equal(canTransitionRuleStatus("approved", "rejected"), true);
    assert.equal(canTransitionRuleStatus("approved", "candidate"), true);
  });

  it("canTransitionRuleStatus: active → retired/candidate", () => {
    assert.equal(canTransitionRuleStatus("active", "retired"), true);
    assert.equal(canTransitionRuleStatus("active", "candidate"), true);
    assert.equal(canTransitionRuleStatus("active", "rejected"), false);
  });

  it("canTransitionRuleStatus: retired → candidate/active", () => {
    assert.equal(canTransitionRuleStatus("retired", "candidate"), true);
    assert.equal(canTransitionRuleStatus("retired", "active"), true);
  });

  it("canTransitionRuleStatus: rejected → candidate", () => {
    assert.equal(canTransitionRuleStatus("rejected", "candidate"), true);
    assert.equal(canTransitionRuleStatus("rejected", "active"), false);
  });

  it("createRuleCandidate 生成完整对象，recurrence = evidence 数", () => {
    const rule = createRuleCandidate({
      projectId: "p1",
      rule: "禁止直接拼接 SQL",
      evidenceIncidentIds: ["inc-1", "inc-2", "inc-3"],
    });
    assert.equal(rule.projectId, "p1");
    assert.equal(rule.rule, "禁止直接拼接 SQL");
    assert.equal(rule.evidenceIncidentIds.length, 3);
    assert.equal(rule.recurrence, 3);
    assert.equal(rule.status, "candidate");
    assert.ok(rule.fingerprint.length > 0);
    assert.match(rule.id, /^rule-/);
  });

  it("appendEvidence 去重并递增 recurrence", () => {
    const base = createRuleCandidate({
      projectId: "p1",
      rule: "r",
      evidenceIncidentIds: ["inc-1"],
    });
    const updated = appendEvidence(base, "inc-2");
    assert.equal(updated.evidenceIncidentIds.length, 2);
    assert.equal(updated.recurrence, 2);
    const dedup = appendEvidence(updated, "inc-1");
    assert.equal(dedup.evidenceIncidentIds.length, 2);
    assert.equal(dedup.recurrence, 2);
  });

  it("findMatchingCandidate 按 projectId + fingerprint 查找", () => {
    const candidates: RuleCandidate[] = [
      createRuleCandidate({ projectId: "p1", rule: "r1", evidenceIncidentIds: [] }),
      createRuleCandidate({ projectId: "p2", rule: "r2", evidenceIncidentIds: [] }),
    ];
    const fp1 = candidates[0]!.fingerprint;
    const found = findMatchingCandidate(candidates, "p1", fp1);
    assert.ok(found);
    assert.equal(found!.id, candidates[0]!.id);
    const notFound = findMatchingCandidate(candidates, "p1", "nonexistent");
    assert.equal(notFound, undefined);
  });

  it("parseRuleToRiskRule 解析合法 JSON", () => {
    const rule = parseRuleToRiskRule('{"pattern":"hub/**","risk":"high","reason":"core change"}');
    assert.ok(rule);
    assert.equal(rule!.pattern, "hub/**");
    assert.equal(rule!.risk, "high");
    assert.equal(rule!.reason, "core change");
  });

  it("parseRuleToRiskRule 非法 JSON 返回 undefined", () => {
    assert.equal(parseRuleToRiskRule("not json"), undefined);
    assert.equal(parseRuleToRiskRule('{"pattern":"","risk":"high","reason":"x"}'), undefined);
    assert.equal(parseRuleToRiskRule('{"pattern":"x","risk":"high"}'), undefined);
    assert.equal(parseRuleToRiskRule('{"pattern":"x","risk":"invalid","reason":"x"}'), undefined);
  });

  it("buildSandboxPolicy 追加 rule 到 riskRules", () => {
    const base: import("./types.js").QualityPolicy = {
      version: 1,
      checks: [],
      protectedPaths: [],
      riskRules: [{ pattern: "existing/**", risk: "medium", reason: "existing" }],
      review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
      autonomy: "observe",
    };
    const newRule: import("./types.js").RiskRule = { pattern: "hub/**", risk: "high", reason: "core" };
    const sandbox = buildSandboxPolicy(base, newRule);
    assert.equal(sandbox.riskRules.length, 2);
    assert.equal(sandbox.riskRules[1]!.pattern, "hub/**");
    assert.equal(base.riskRules.length, 1);
  });

  it("buildSandboxPolicy 重复 rule 不追加", () => {
    const base: import("./types.js").QualityPolicy = {
      version: 1,
      checks: [],
      protectedPaths: [],
      riskRules: [{ pattern: "hub/**", risk: "high", reason: "core" }],
      review: { enabled: false, blockSeverity: "major", minBlockingConfidence: 0.8, maxFixRounds: 0 },
      autonomy: "observe",
    };
    const dup: import("./types.js").RiskRule = { pattern: "hub/**", risk: "high", reason: "core" };
    const sandbox = buildSandboxPolicy(base, dup);
    assert.equal(sandbox.riskRules.length, 1);
  });
});
