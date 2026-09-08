import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CheckDefinition,
  CheckTier,
  ProjectScope,
  QualityAutonomy,
  QualityPolicy,
  QualityRisk,
  RiskRule,
} from "./types.js";
import { canonicalize, validateCwd } from "./project.js";

/**
 * `.devin/quality.json` 加载与校验（设计文档 §5.2 / §9）。
 *
 * 约束：
 * - cwd 必须在 ProjectScope 内；
 * - argv 非空、不含 shell 注入风险（shell:false 执行，但仍拒绝空 argv）；
 * - timeoutMs > 0；
 * - autonomy / tier / severity 等枚举合法；
 * - AGENTS.md 只用于生成建议，不直接执行。
 */

export class PolicyValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid quality policy:\n  - ${errors.join("\n  - ")}`);
    this.name = "PolicyValidationError";
    this.errors = errors;
  }
}

export const POLICY_FILE = ".devin/quality.json";
export const POLICY_VERSION = 1;

const TIERS: readonly CheckTier[] = ["quick", "full"];
const AUTONOMY: readonly QualityAutonomy[] = ["observe", "propose", "isolated-fix", "apply-low-risk"];
const BLOCK_SEVERITY = ["critical", "major"] as const;
const RISKS: readonly QualityRisk[] = ["low", "medium", "high", "critical"];

/** 校验单个 CheckDefinition，返回错误列表。 */
function validateCheck(check: unknown, scope: ProjectScope, idx: number, errors: string[]): void {
  if (typeof check !== "object" || check === null) {
    errors.push(`checks[${idx}]: not an object`);
    return;
  }
  const c = check as Record<string, unknown>;
  if (typeof c.id !== "string" || c.id.length === 0) errors.push(`checks[${idx}]: id required`);
  if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.some((a) => typeof a !== "string")) {
    errors.push(`checks[${idx}]: argv must be non-empty string array`);
  }
  if (typeof c.cwd !== "string" || c.cwd.length === 0) {
    errors.push(`checks[${idx}]: cwd required`);
  } else {
    try {
      const abs = path.isAbsolute(c.cwd) ? c.cwd : path.join(scope.root, c.cwd);
      validateCwd(scope, abs);
    } catch (err) {
      errors.push(`checks[${idx}]: cwd "${c.cwd}" escapes project root (${String(err)})`);
    }
  }
  if (typeof c.tier !== "string" || !TIERS.includes(c.tier as CheckTier)) {
    errors.push(`checks[${idx}]: tier must be one of ${TIERS.join("|")}`);
  }
  if (typeof c.timeoutMs !== "number" || c.timeoutMs <= 0 || !Number.isFinite(c.timeoutMs)) {
    errors.push(`checks[${idx}]: timeoutMs must be a positive finite number`);
  }
  if (typeof c.required !== "boolean") errors.push(`checks[${idx}]: required must be boolean`);
  if (c.allowNetwork !== undefined && typeof c.allowNetwork !== "boolean") {
    errors.push(`checks[${idx}]: allowNetwork must be boolean if present`);
  }
  if (c.paths !== undefined && (!Array.isArray(c.paths) || c.paths.some((p) => typeof p !== "string"))) {
    errors.push(`checks[${idx}]: paths must be string array if present`);
  }
}

/** 校验完整 QualityPolicy，返回错误列表（空表示合法）。 */
export function validatePolicy(policy: unknown, scope: ProjectScope): string[] {
  const errors: string[] = [];
  if (typeof policy !== "object" || policy === null) {
    return ["policy: not an object"];
  }
  const p = policy as Record<string, unknown>;
  if (p.version !== POLICY_VERSION) errors.push(`version must be ${POLICY_VERSION}`);
  if (!Array.isArray(p.checks)) {
    errors.push("checks must be an array");
  } else {
    const ids = new Set<string>();
    p.checks.forEach((c, i) => {
      validateCheck(c, scope, i, errors);
      if (typeof c === "object" && c !== null && typeof (c as Record<string, unknown>).id === "string") {
        const id = (c as Record<string, unknown>).id as string;
        if (ids.has(id)) errors.push(`checks[${i}]: duplicate id "${id}"`);
        ids.add(id);
      }
    });
  }
  if (!Array.isArray(p.protectedPaths) || p.protectedPaths.some((s) => typeof s !== "string")) {
    errors.push("protectedPaths must be string array");
  }
  if (!Array.isArray(p.riskRules)) {
    errors.push("riskRules must be an array");
  } else {
    p.riskRules.forEach((r, i) => {
      if (typeof r !== "object" || r === null) {
        errors.push(`riskRules[${i}]: not an object`);
        return;
      }
      const rr = r as Record<string, unknown>;
      if (typeof rr.pattern !== "string" || rr.pattern.length === 0) errors.push(`riskRules[${i}]: pattern required`);
      if (typeof rr.risk !== "string" || !RISKS.includes(rr.risk as QualityRisk)) {
        errors.push(`riskRules[${i}]: risk must be one of ${RISKS.join("|")}`);
      }
      if (typeof rr.reason !== "string") errors.push(`riskRules[${i}]: reason required`);
    });
  }
  const rev = p.review;
  if (typeof rev !== "object" || rev === null) {
    errors.push("review must be an object");
  } else {
    const rv = rev as Record<string, unknown>;
    if (typeof rv.enabled !== "boolean") errors.push("review.enabled must be boolean");
    if (rv.reviewerSessionId !== undefined && typeof rv.reviewerSessionId !== "string") {
      errors.push("review.reviewerSessionId must be string if present");
    }
    if (typeof rv.blockSeverity !== "string" || !BLOCK_SEVERITY.includes(rv.blockSeverity as "critical" | "major")) {
      errors.push(`review.blockSeverity must be one of ${BLOCK_SEVERITY.join("|")}`);
    }
    if (typeof rv.minBlockingConfidence !== "number" || rv.minBlockingConfidence < 0 || rv.minBlockingConfidence > 1) {
      errors.push("review.minBlockingConfidence must be in [0,1]");
    }
    if (typeof rv.maxFixRounds !== "number" || rv.maxFixRounds < 0 || !Number.isInteger(rv.maxFixRounds)) {
      errors.push("review.maxFixRounds must be a non-negative integer");
    }
  }
  if (typeof p.autonomy !== "string" || !AUTONOMY.includes(p.autonomy as QualityAutonomy)) {
    errors.push(`autonomy must be one of ${AUTONOMY.join("|")}`);
  }
  return errors;
}

/** 抛出版本错误（若存在错误）。 */
export function assertPolicy(policy: unknown, scope: ProjectScope): asserts policy is QualityPolicy {
  const errors = validatePolicy(policy, scope);
  if (errors.length > 0) throw new PolicyValidationError(errors);
}

export type LoadResult =
  | { ok: true; policy: QualityPolicy; path: string }
  | { ok: false; path: string; errors: string[]; reason: "not-found" | "invalid-json" | "invalid" };

/** 加载并校验 `<root>/.devin/quality.json`。文件不存在时返回 not-found。 */
export function loadPolicy(scope: ProjectScope): LoadResult {
  const file = path.join(scope.root, POLICY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, path: file, errors: ["policy file not found"], reason: "not-found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path: file, errors: [String(err)], reason: "invalid-json" };
  }
  const errors = validatePolicy(parsed, scope);
  if (errors.length > 0) return { ok: false, path: file, errors, reason: "invalid" };
  return { ok: true, path: file, policy: parsed as QualityPolicy };
}

/**
 * 从 AGENTS.md 提取 ```bash ... ``` 代码块作为检查建议。
 * 仅返回建议，不写入 policy，不自动执行（设计文档 §5.2 / §11.2）。
 */
export function suggestChecksFromAgentsMd(scope: ProjectScope): CheckDefinition[] {
  const file = path.join(scope.root, "AGENTS.md");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const suggestions: CheckDefinition[] = [];
  const re = /```bash\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw)) !== null) {
    const lines = m[1]!.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
    for (const line of lines) {
      const argv = line.split(/\s+/);
      if (argv.length === 0) continue;
      const id = `agents-suggest-${i++}`;
      suggestions.push({
        id,
        cwd: ".",
        argv,
        tier: "quick",
        timeoutMs: 120_000,
        required: false,
      });
    }
  }
  return suggestions;
}

/** 构造最小合法 policy（用于无配置时的默认 observe 模式）。 */
export function defaultObservePolicy(): QualityPolicy {
  return {
    version: 1,
    checks: [],
    protectedPaths: [],
    riskRules: [] as RiskRule[],
    review: {
      enabled: false,
      blockSeverity: "major",
      minBlockingConfidence: 0.8,
      maxFixRounds: 0,
    },
    autonomy: "observe",
  };
}

/**
 * 根据项目类型探测合理的默认 checks。
 * 检测 package.json / tsconfig.json / Cargo.toml / go.mod / pom.xml 等，
 * 生成对应的 typecheck / test 命令。
 */
export function detectDefaultChecks(scope: ProjectScope): CheckDefinition[] {
  const checks: CheckDefinition[] = [];
  const root = scope.root;

  const has = (f: string): boolean => {
    try { fs.accessSync(path.join(root, f)); return true; } catch { return false; }
  };

  // Node.js / TypeScript 项目
  if (has("package.json")) {
    if (has("tsconfig.json")) {
      checks.push({
        id: "typecheck",
        cwd: ".",
        argv: ["npx", "tsc", "--noEmit"],
        tier: "quick",
        timeoutMs: 120_000,
        required: true,
      });
    }
    // 检测是否有 test 脚本
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.scripts && typeof pkg.scripts.test !== "undefined") {
        // 如果 test 脚本不是默认的 "echo Error: no test specified"
        if (pkg.scripts.test !== "Error: no test specified\" && exit 1") {
          checks.push({
            id: "test",
            cwd: ".",
            argv: ["npm", "test"],
            tier: "full",
            timeoutMs: 300_000,
            required: false,
          });
        }
      }
    } catch { /* ignore */ }
  }

  // Rust 项目
  if (has("Cargo.toml")) {
    checks.push({
      id: "cargo-check",
      cwd: ".",
      argv: ["cargo", "check"],
      tier: "quick",
      timeoutMs: 120_000,
      required: true,
    });
    checks.push({
      id: "cargo-test",
      cwd: ".",
      argv: ["cargo", "test"],
      tier: "full",
      timeoutMs: 300_000,
      required: false,
    });
  }

  // Go 项目
  if (has("go.mod")) {
    checks.push({
      id: "go-build",
      cwd: ".",
      argv: ["go", "build", "./..."],
      tier: "quick",
      timeoutMs: 120_000,
      required: true,
    });
    checks.push({
      id: "go-test",
      cwd: ".",
      argv: ["go", "test", "./..."],
      tier: "full",
      timeoutMs: 300_000,
      required: false,
    });
  }

  return checks;
}

/**
 * 为项目生成一个合理的默认策略（无 quality.json 时使用）。
 * 包含基础 checks（tsc/test 适配项目类型）、autonomy=observe、review.enabled=true。
 */
export function generateDefaultPolicy(scope: ProjectScope): QualityPolicy {
  const checks = detectDefaultChecks(scope);
  const protectedPaths: string[] = [POLICY_FILE];
  // 如果有 AGENTS.md，也保护
  try { fs.accessSync(path.join(scope.root, "AGENTS.md")); protectedPaths.push("AGENTS.md"); } catch { /* ignore */ }

  return {
    version: POLICY_VERSION,
    checks,
    protectedPaths,
    riskRules: [],
    review: {
      enabled: true,
      blockSeverity: "major",
      minBlockingConfidence: 0.8,
      maxFixRounds: 2,
    },
    autonomy: "observe",
  };
}

/** 将 policy 序列化为 JSON 写入 <root>/.devin/quality.json。 */
export function writePolicy(scope: ProjectScope, policy: QualityPolicy): string {
  const file = path.join(scope.root, POLICY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(policy, null, 2) + "\n", "utf8");
  return file;
}

/** 校验某路径是否受保护（用于风险分类前置检查）。支持 `**` 递归通配。 */
export function isProtectedPath(policy: QualityPolicy, filePath: string): boolean {
  const rel = path.isAbsolute(filePath)
    ? path.relative(scopeRootOf(policy, filePath), canonicalize(filePath))
    : filePath;
  return policy.protectedPaths.some((pat) => matchProtected(pat, rel));
}

function matchProtected(pattern: string, rel: string): boolean {
  // 去掉末尾 /** 视为目录前缀；去掉末尾 /* 视为单层目录下文件
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return rel === base || rel.startsWith(base.endsWith("/") ? base : base + "/");
  }
  if (pattern === rel) return true;
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return path.dirname(rel) === base;
  }
  return rel.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}

function scopeRootOf(_policy: QualityPolicy, filePath: string): string {
  return path.dirname(canonicalize(filePath));
}
