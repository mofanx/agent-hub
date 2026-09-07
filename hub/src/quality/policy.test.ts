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
  isProtectedPath,
  loadPolicy,
  suggestChecksFromAgentsMd,
  validatePolicy,
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

  describe("isProtectedPath", () => {
    it("精确匹配和前缀匹配", () => {
      const p = validPolicy();
      assert.ok(isProtectedPath(p, ".devin/quality.json"));
      assert.ok(isProtectedPath(p, "hub/src/quality/run.ts"));
      assert.equal(isProtectedPath(p, "hub/src/agent.ts"), false);
    });
  });
});
