import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RunPermissionManager,
  checkToolPermission,
  isReadOnlyRole,
  kindToToolKind,
  type QualityRole,
} from "./permissions.js";
import {
  isBlocking,
  toReviewFinding,
  findingsFromOutput,
  needsFix,
  parseReviewerOutput,
  canTransitionFindingStatus,
  isValidFindingStatus,
} from "./review.js";
import type { QualityPolicy, ReviewFinding } from "./types.js";

/**
 * Q2-02 集成测试：reviewer 独立 session 只读权限。
 *
 * agent.ts 的 handlePermission / handleWriteTextFile 通过 RunPermissionManager
 * 强制 reviewer 只读。本测试验证 RunPermissionManager 的 API 行为
 * 与 agent.ts 中的使用方式一致。
 */

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

describe("reviewer read-only permission (Q2-02)", () => {
  let mgr: RunPermissionManager;

  beforeEach(() => {
    mgr = new RunPermissionManager();
  });

  it("reviewer session 被标记为只读", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    assert.equal(mgr.isReadOnlyEnforced("rev-session"), true);
  });

  it("implementer session 不被标记为只读", () => {
    mgr.bindSession("impl-session", "run-1", "implementer");
    assert.equal(mgr.isReadOnlyEnforced("impl-session"), false);
  });

  it("reviewer session 的 write 工具调用被拒绝（即使 bypass 开启）", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkSession("rev-session", "edit", true);
    assert.equal(decision.allowed, false);
    assert.equal(decision.role, "reviewer");
  });

  it("reviewer session 的 delete 工具调用被拒绝", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkSession("rev-session", "delete", false);
    assert.equal(decision.allowed, false);
  });

  it("reviewer session 的 move 工具调用被拒绝", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkSession("rev-session", "move", false);
    assert.equal(decision.allowed, false);
  });

  it("reviewer session 的 read 工具调用被允许", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkSession("rev-session", "read", false);
    assert.equal(decision.allowed, true);
  });

  it("reviewer session 的 search 工具调用被允许", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkSession("rev-session", "search", false);
    assert.equal(decision.allowed, true);
  });

  it("reviewer checkPathAccess 拒绝任何路径写入", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    const decision = mgr.checkPathAccess("rev-session", "src/foo.ts", "/repo");
    assert.equal(decision.allowed, false);
    assert.equal(decision.role, "reviewer");
  });

  it("未绑定的 session 默认允许写入（普通聊天不受影响）", () => {
    const decision = mgr.checkSession("normal-session", "write", false);
    assert.equal(decision.allowed, true);
  });

  it("unbindSession 后 session 恢复默认权限", () => {
    mgr.bindSession("rev-session", "run-1", "reviewer");
    assert.equal(mgr.isReadOnlyEnforced("rev-session"), true);
    mgr.unbindSession("rev-session");
    assert.equal(mgr.isReadOnlyEnforced("rev-session"), false);
    assert.equal(mgr.checkSession("rev-session", "write").allowed, true);
  });

  it("unbindRun 解绑该 run 的所有 reviewer session", () => {
    mgr.bindSession("rev-1", "run-1", "reviewer");
    mgr.bindSession("rev-2", "run-1", "reviewer");
    mgr.bindSession("rev-3", "run-2", "reviewer");
    const removed = mgr.unbindRun("run-1");
    assert.equal(removed.length, 2);
    assert.equal(mgr.isReadOnlyEnforced("rev-1"), false);
    assert.equal(mgr.isReadOnlyEnforced("rev-2"), false);
    assert.equal(mgr.isReadOnlyEnforced("rev-3"), true);
  });

  it("kindToToolKind: edit → write（agent.ts 用此映射判断）", () => {
    assert.equal(kindToToolKind("edit"), "write");
    assert.equal(kindToToolKind("delete"), "delete");
    assert.equal(kindToToolKind("move"), "move");
    assert.equal(kindToToolKind("read"), "read");
  });

  it("reviewer 与 implementer 可绑定到同一 run（独立 session）", () => {
    mgr.bindSession("rev", "run-1", "reviewer");
    mgr.bindSession("impl", "run-1", "implementer");
    assert.equal(mgr.isReadOnlyEnforced("rev"), true);
    assert.equal(mgr.isReadOnlyEnforced("impl"), false);
    assert.equal(mgr.checkSession("rev", "write").allowed, false);
    assert.equal(mgr.checkSession("impl", "write").allowed, true);
  });

  it("planner 也是只读角色", () => {
    mgr.bindSession("planner-s", "run-1", "planner");
    assert.equal(mgr.isReadOnlyEnforced("planner-s"), true);
    assert.equal(mgr.checkSession("planner-s", "write").allowed, false);
  });

  it("getBinding 返回绑定的 runId 和 role", () => {
    mgr.bindSession("rev", "run-1", "reviewer");
    const binding = mgr.getBinding("rev");
    assert.equal(binding?.runId, "run-1");
    assert.equal(binding?.role, "reviewer");
  });

  it("checkToolPermission: reviewer 即使 bypass 也不能 execute", () => {
    assert.equal(checkToolPermission("reviewer", "execute", true).allowed, false);
  });
});

/**
 * Q2-03 集成测试：finding 持久化、阻断规则和处理状态。
 * 验证 review.ts 的 blocking 规则与 finding 状态机。
 */
describe("finding blocking rules and status (Q2-03)", () => {
  const policy = makePolicy();

  it("critical + security + 低置信度仍阻断（降阈值）", () => {
    const rf = toReviewFinding(
      { severity: "critical", confidence: 0.5, category: "security", claim: "sql注入", evidence: "拼接SQL" },
      "run-1",
      policy,
    );
    assert.equal(rf.blocking, true);
  });

  it("major + 高置信度 + 有证据 = blocking", () => {
    const rf = toReviewFinding(
      { severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "ev" },
      "run-1",
      policy,
    );
    assert.equal(rf.blocking, true);
  });

  it("minor 不阻断", () => {
    const rf = toReviewFinding(
      { severity: "minor", confidence: 0.95, category: "ux", claim: "x", evidence: "ev" },
      "run-1",
      policy,
    );
    assert.equal(rf.blocking, false);
  });

  it("findingsFromOutput 批量计算 blocking", () => {
    const { output } = parseReviewerOutput(JSON.stringify({
      verdict: "needs-fix",
      findings: [
        { severity: "major", confidence: 0.9, category: "correctness", claim: "a", evidence: "e" },
        { severity: "minor", confidence: 0.5, category: "ux", claim: "b", evidence: "e" },
        { severity: "critical", confidence: 0.95, category: "security", claim: "c", evidence: "e" },
      ],
    }));
    const findings = findingsFromOutput(output, "run-1", policy);
    assert.equal(findings[0]!.blocking, true);
    assert.equal(findings[1]!.blocking, false);
    assert.equal(findings[2]!.blocking, true);
  });

  it("needsFix: 有 open blocking finding → true", () => {
    const findings: ReviewFinding[] = [
      { id: "f", runId: "r", severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "e", blocking: true, status: "open" },
    ];
    assert.equal(needsFix({ verdict: "pass", findings: [] }, findings), true);
  });

  it("needsFix: blocking finding 已 fixed → false", () => {
    const findings: ReviewFinding[] = [
      { id: "f", runId: "r", severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "e", blocking: true, status: "fixed" },
    ];
    assert.equal(needsFix({ verdict: "pass", findings: [] }, findings), false);
  });

  it("needsFix: blocking finding dismissed → false", () => {
    const findings: ReviewFinding[] = [
      { id: "f", runId: "r", severity: "major", confidence: 0.9, category: "correctness", claim: "x", evidence: "e", blocking: true, status: "dismissed" },
    ];
    assert.equal(needsFix({ verdict: "pass", findings: [] }, findings), false);
  });

  it("finding 状态转换：open → fixed/dismissed/accepted-risk 合法", () => {
    assert.equal(canTransitionFindingStatus("open", "fixed"), true);
    assert.equal(canTransitionFindingStatus("open", "dismissed"), true);
    assert.equal(canTransitionFindingStatus("open", "accepted-risk"), true);
  });

  it("finding 状态转换：fixed → open（复检未修复）合法", () => {
    assert.equal(canTransitionFindingStatus("fixed", "open"), true);
  });

  it("isValidFindingStatus 校验", () => {
    assert.equal(isValidFindingStatus("open"), true);
    assert.equal(isValidFindingStatus("fixed"), true);
    assert.equal(isValidFindingStatus("dismissed"), true);
    assert.equal(isValidFindingStatus("accepted-risk"), true);
    assert.equal(isValidFindingStatus("rejected"), false);
  });
});
