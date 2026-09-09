import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerProject } from "./project.js";
import {
  POLICY_FILE,
  PolicyValidationError,
  assertPolicy,
  defaultObservePolicy,
  detectDefaultChecks,
  generateDefaultPolicy,
  getPolicyEnforcement,
  getPolicyApprovalRisk,
  isProtectedPath,
  loadPolicy,
  loadPolicyV2,
  migrateV1ToV2Write,
  suggestChecksFromAgentsMd,
  validatePolicy,
  writePolicy,
} from "./policy.js";
import type { ProjectScope, QualityPolicy } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-policy-"));
}

function makeScope(dir: string): ProjectScope {
  return registerProject({ connectionId: "conn-1", root: dir });
}

function validPolicy(): QualityPolicy {
  return {
    version: 1,
    checks: [
      {
        id: "typecheck",
        cwd: "hub",
        argv: ["npx", "tsc", "--noEmit"],
        tier: "quick",
        timeoutMs: 120_000,
        required: true,
      },
    ],
    protectedPaths: [".devin/quality.json", "hub/src/quality/**"],
    riskRules: [{ pattern: "hub/src/quality/**", risk: "high", reason: "quality core" }],
    review: {
      enabled: true,
      blockSeverity: "major",
      minBlockingConfidence: 0.8,
      maxFixRounds: 2,
    },
    autonomy: "propose",
  };
}

describe("quality policy", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, "hub"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("validatePolicy", () => {
    it("合法 policy 无错误", () => {
      const scope = makeScope(dir);
      assert.deepEqual(validatePolicy(validPolicy(), scope), []);
    });

    it("version 错误被拒", () => {
      const scope = makeScope(dir);
      const p = { ...validPolicy(), version: 2 as unknown as 1 };
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("version")));
    });

    it("cwd 越界被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks[0]!.cwd = "/etc";
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("escapes project root")));
    });

    it("空 argv 被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks[0]!.argv = [];
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("argv")));
    });

    it("timeoutMs <= 0 被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks[0]!.timeoutMs = 0;
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("timeoutMs")));
    });

    it("tier 非法被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks[0]!.tier = "medium" as unknown as "quick";
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("tier")));
    });

    it("autonomy 非法被拒", () => {
      const scope = makeScope(dir);
      const p = { ...validPolicy(), autonomy: "auto" as unknown as "propose" };
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("autonomy")));
    });

    it("minBlockingConfidence 越界被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.review.minBlockingConfidence = 1.5;
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("minBlockingConfidence")));
    });

    it("maxFixRounds 非整数被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.review.maxFixRounds = 1.5;
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("maxFixRounds")));
    });

    it("重复 check id 被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks = [p.checks[0]!, { ...p.checks[0]!, id: "typecheck" }];
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("duplicate id")));
    });

    it("riskRule risk 非法被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.riskRules[0]!.risk = "urgent" as unknown as "high";
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("risk must be one of")));
    });

    it("blockSeverity 非法被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.review.blockSeverity = "minor" as unknown as "major";
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("blockSeverity")));
    });

    it("required 非布尔被拒", () => {
      const scope = makeScope(dir);
      const p = validPolicy();
      p.checks[0]!.required = "yes" as unknown as boolean;
      const errs = validatePolicy(p, scope);
      assert.ok(errs.some((e) => e.includes("required")));
    });
  });

  describe("assertPolicy", () => {
    it("合法不抛出", () => {
      assert.doesNotThrow(() => assertPolicy(validPolicy(), makeScope(dir)));
    });
    it("非法抛出 PolicyValidationError 含 errors", () => {
      const scope = makeScope(dir);
      const p = { ...validPolicy(), version: 9 as unknown as 1 };
      assert.throws(
        () => assertPolicy(p, scope),
        (e) => e instanceof PolicyValidationError && e.errors.length > 0,
      );
    });
  });

  describe("loadPolicy", () => {
    it("文件不存在返回 not-found", () => {
      const r = loadPolicy(makeScope(dir));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "not-found");
    });
    it("非法 JSON 返回 invalid-json", () => {
      fs.mkdirSync(path.join(dir, ".devin"));
      fs.writeFileSync(path.join(dir, POLICY_FILE), "{not json");
      const r = loadPolicy(makeScope(dir));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "invalid-json");
    });
    it("合法文件返回 policy", () => {
      fs.mkdirSync(path.join(dir, ".devin"));
      fs.writeFileSync(path.join(dir, POLICY_FILE), JSON.stringify(validPolicy()));
      const r = loadPolicy(makeScope(dir));
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.policy.checks.length, 1);
    });
    it("非法内容返回 invalid + errors", () => {
      fs.mkdirSync(path.join(dir, ".devin"));
      const bad = validPolicy();
      bad.checks[0]!.timeoutMs = -1;
      fs.writeFileSync(path.join(dir, POLICY_FILE), JSON.stringify(bad));
      const r = loadPolicy(makeScope(dir));
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "invalid");
      assert.ok(r.errors.length > 0);
    });
  });

  describe("suggestChecksFromAgentsMd", () => {
    it("从 AGENTS.md bash 块提取建议", () => {
      fs.writeFileSync(
        path.join(dir, "AGENTS.md"),
        "# Guide\n\n```bash\ncd hub && npx tsc --noEmit\n```\n\n```bash\nnpm test\n```\n",
      );
      const suggestions = suggestChecksFromAgentsMd(makeScope(dir));
      assert.ok(suggestions.length >= 2);
      assert.ok(suggestions.every((s) => s.required === false));
    });
    it("无 AGENTS.md 返回空数组", () => {
      assert.deepEqual(suggestChecksFromAgentsMd(makeScope(dir)), []);
    });
    it("建议不包含注释行", () => {
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "```bash\n# comment\necho hi\n```");
      const s = suggestChecksFromAgentsMd(makeScope(dir));
      assert.equal(s.length, 1);
      assert.deepEqual(s[0]!.argv, ["echo", "hi"]);
    });
  });

  describe("defaultObservePolicy", () => {
    it("返回合法 observe policy", () => {
      const p = defaultObservePolicy();
      assert.equal(p.autonomy, "observe");
      assert.equal(p.review.enabled, false);
      assert.deepEqual(validatePolicy(p, makeScope(dir)), []);
    });
  });

  describe("detectDefaultChecks", () => {
    it("Node.js + TypeScript 项目生成 typecheck + test", () => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
      const checks = detectDefaultChecks(makeScope(dir));
      const ids = checks.map((c) => c.id);
      assert.ok(ids.includes("typecheck"));
      assert.ok(ids.includes("test"));
    });
    it("无 tsconfig 不生成 typecheck", () => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      const checks = detectDefaultChecks(makeScope(dir));
      assert.ok(!checks.some((c) => c.id === "typecheck"));
    });
    it("无 test 脚本不生成 test check", () => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({}));
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
      const checks = detectDefaultChecks(makeScope(dir));
      assert.ok(checks.some((c) => c.id === "typecheck"));
      assert.ok(!checks.some((c) => c.id === "test"));
    });
    it("空项目返回空 checks", () => {
      assert.deepEqual(detectDefaultChecks(makeScope(dir)), []);
    });
  });

  describe("generateDefaultPolicy", () => {
    it("生成低摩擦安全默认策略：observe 仅报告，review/fix 默认关闭", () => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
      const p = generateDefaultPolicy(makeScope(dir));
      assert.equal(p.autonomy, "observe");
      assert.equal(p.review.enabled, false);
      assert.equal(p.review.maxFixRounds, 0);
      assert.ok(p.checks.length > 0);
      assert.deepEqual(validatePolicy(p, makeScope(dir)), []);
    });
    it("保护 .devin/quality.json 和 AGENTS.md", () => {
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "# test");
      const p = generateDefaultPolicy(makeScope(dir));
      assert.ok(p.protectedPaths.includes(POLICY_FILE));
      assert.ok(p.protectedPaths.includes("AGENTS.md"));
    });
  });

  describe("getPolicyEnforcement", () => {
    it("v1 observe 为 report，不阻断 Conductor 闭环", () => {
      assert.equal(getPolicyEnforcement({ ...validPolicy(), autonomy: "observe" }), "report");
    });

    it("v1 propose 需要审批，修复模式需要通过", () => {
      assert.equal(getPolicyEnforcement({ ...validPolicy(), autonomy: "propose" }), "require-approval");
      assert.equal(getPolicyEnforcement({ ...validPolicy(), autonomy: "isolated-fix" }), "require-pass");
    });
  });

  describe("getPolicyApprovalRisk", () => {
    it("v1 默认 high", () => {
      assert.equal(getPolicyApprovalRisk({ ...validPolicy(), autonomy: "observe" }), "high");
      assert.equal(getPolicyApprovalRisk({ ...validPolicy(), autonomy: "propose" }), "high");
    });

    it("v2 返回 enforcement.approvalRisk", () => {
      const v2 = { ...validPolicy(), version: 2 as unknown as 1, enforcement: { mode: "require-approval" as const, approvalRisk: "critical" as const } };
      assert.equal(getPolicyApprovalRisk(v2 as unknown as QualityPolicy), "critical");
    });
  });

  describe("writePolicy", () => {
    it("写入 .devin/quality.json 并可重新加载", () => {
      const scope = makeScope(dir);
      const p = generateDefaultPolicy(scope);
      const file = writePolicy(scope, p);
      assert.ok(fs.existsSync(file));
      const loaded = loadPolicy(scope);
      assert.equal(loaded.ok, true);
    });
  });

  describe("isProtectedPath", () => {
    it("精确匹配和前缀匹配", () => {
      const p = validPolicy();
      assert.ok(isProtectedPath(p, ".devin/quality.json"));
      assert.ok(isProtectedPath(p, "hub/src/quality/run.ts"));
      assert.equal(isProtectedPath(p, "hub/src/agent.ts"), false);
    });
  });
});

describe("migrateV1ToV2Write", () => {
  let dir: string;
  let scope: ProjectScope;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-migrate-"));
    scope = registerProject({ connectionId: "conn-1", root: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("成功迁移 v1 → v2 并备份旧文件", () => {
    const v1 = generateDefaultPolicy(scope);
    writePolicy(scope, v1);

    const result = migrateV1ToV2Write(scope);
    assert.ok(result.ok, `migration should succeed: ${(result as { errors: string[] }).errors?.join(", ")}`);
    if (!result.ok) return;
    assert.ok(fs.existsSync(result.backupPath));
    assert.ok(fs.existsSync(result.path));

    // 验证写入的是 v2
    const loaded = loadPolicyV2(scope);
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    assert.equal(loaded.version, 2);
  });

  it("hash 不匹配时拒绝写入", () => {
    const v1 = generateDefaultPolicy(scope);
    writePolicy(scope, v1);

    const result = migrateV1ToV2Write(scope, "wronghash");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "hash-mismatch");
  });

  it("无 policy 文件时返回 invalid-v1", () => {
    const result = migrateV1ToV2Write(scope);
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, "invalid-v1");
  });

  it("已迁移的 v2 policy 再次迁移返回 invalid-v1", () => {
    const v1 = generateDefaultPolicy(scope);
    writePolicy(scope, v1);
    const first = migrateV1ToV2Write(scope);
    assert.ok(first.ok);

    // 再次迁移：此时文件已是 v2，validatePolicy(v1) 会失败
    const second = migrateV1ToV2Write(scope);
    assert.ok(!second.ok);
    if (second.ok) return;
    assert.equal(second.reason, "invalid-v1");
  });
});
