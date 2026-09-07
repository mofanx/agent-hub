import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isProtectedPath,
  classifyFile,
  classifyChangeSet,
  requiresApproval,
  isSelfModification,
  DEFAULT_PROTECTED_PATTERNS,
  DEFAULT_RISK_RULES,
} from "./risk.js";
import type { ChangeSetFile, QualityPolicy } from "./types.js";

const policy: Pick<QualityPolicy, "protectedPaths" | "riskRules"> = {
  protectedPaths: [".devin/quality.json", "hub/src/quality/**"],
  riskRules: [
    { pattern: "hub/src/quality/**", risk: "critical", reason: "质量系统核心" },
    { pattern: "hub/src/agent.ts", risk: "high", reason: "Agent 协议层" },
    { pattern: "**/*.test.ts", risk: "medium", reason: "测试文件" },
  ],
};

describe("risk classification", () => {
  describe("isProtectedPath", () => {
    it("精确匹配", () => {
      assert.equal(isProtectedPath(".devin/quality.json", policy.protectedPaths), true);
    });

    it("递归通配匹配", () => {
      assert.equal(isProtectedPath("hub/src/quality/types.ts", policy.protectedPaths), true);
      assert.equal(isProtectedPath("hub/src/quality/sub/deep.ts", policy.protectedPaths), true);
    });

    it("不匹配的路径返回 false", () => {
      assert.equal(isProtectedPath("hub/src/agent.ts", policy.protectedPaths), false);
      assert.equal(isProtectedPath("src/foo.ts", policy.protectedPaths), false);
    });
  });

  describe("classifyFile", () => {
    it("protectedPath 匹配 → critical", () => {
      const { risk, reasons } = classifyFile(".devin/quality.json", policy);
      assert.equal(risk, "critical");
      assert.ok(reasons.length > 0);
    });

    it("riskRule 匹配 → 对应风险", () => {
      const { risk } = classifyFile("hub/src/agent.ts", policy);
      assert.equal(risk, "high");
    });

    it("取最高风险（protected + rule）", () => {
      const { risk } = classifyFile("hub/src/quality/types.ts", policy);
      assert.equal(risk, "critical");
    });

    it("无匹配 → low", () => {
      const { risk, reasons } = classifyFile("src/utils.ts", policy);
      assert.equal(risk, "low");
      assert.equal(reasons.length, 0);
    });

    it("测试文件 → medium", () => {
      const { risk } = classifyFile("hub/src/room.test.ts", policy);
      assert.equal(risk, "medium");
    });

    it("空 policy → low", () => {
      const { risk } = classifyFile("any/path.ts");
      assert.equal(risk, "low");
    });
  });

  describe("classifyChangeSet", () => {
    it("整体风险 = 最高文件风险", () => {
      const files: ChangeSetFile[] = [
        { path: "src/foo.ts", status: "modify" },
        { path: "hub/src/quality/types.ts", status: "modify" },
        { path: "README.md", status: "modify" },
      ];
      const { risk, reasons } = classifyChangeSet(files, policy);
      assert.equal(risk, "critical");
      assert.ok(reasons.length > 0);
    });

    it("全部 low → low", () => {
      const files: ChangeSetFile[] = [
        { path: "src/a.ts", status: "modify" },
        { path: "src/b.ts", status: "add" },
      ];
      const { risk } = classifyChangeSet(files, policy);
      assert.equal(risk, "low");
    });

    it("空文件列表 → low", () => {
      const { risk } = classifyChangeSet([], policy);
      assert.equal(risk, "low");
    });
  });

  describe("requiresApproval", () => {
    it("critical 始终需要审批", () => {
      assert.equal(requiresApproval("critical", "apply-low-risk"), true);
    });

    it("high 始终需要审批", () => {
      assert.equal(requiresApproval("high", "apply-low-risk"), true);
    });

    it("medium 在 propose 模式需要审批", () => {
      assert.equal(requiresApproval("medium", "propose"), true);
    });

    it("medium 在 apply-low-risk 不需要审批", () => {
      assert.equal(requiresApproval("medium", "apply-low-risk"), false);
    });

    it("low 在 apply-low-risk 不需要审批", () => {
      assert.equal(requiresApproval("low", "apply-low-risk"), false);
    });

    it("observe 模式所有非 low 都需要审批", () => {
      assert.equal(requiresApproval("medium", "observe"), true);
      assert.equal(requiresApproval("low", "observe"), false);
    });
  });

  describe("isSelfModification", () => {
    it("质量系统代码是自修改", () => {
      assert.equal(isSelfModification("hub/src/quality/types.ts"), true);
    });

    it("quality.json 是自修改", () => {
      assert.equal(isSelfModification(".devin/quality.json"), true);
    });

    it("普通代码不是自修改", () => {
      assert.equal(isSelfModification("src/foo.ts"), false);
    });

    it("DEFAULT_PROTECTED_PATTERNS 非空", () => {
      assert.ok(DEFAULT_PROTECTED_PATTERNS.length > 0);
    });

    it("DEFAULT_RISK_RULES 非空", () => {
      assert.ok(DEFAULT_RISK_RULES.length > 0);
    });
  });
});
