import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type {
  CheckDefinition,
  CheckTier,
  ProjectScope,
  QualityAutonomy,
  QualityPolicy,
  QualityPolicyV2,
  PolicyMigrationPreview,
  QualityRisk,
  RiskRule,
  RequirementRule,
  VerificationRule,
  EnforcementMode,
  RemediationMode,
  RequirementsMode,
  ReviewMode,
  VerificationMode,
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
 * 包含基础 checks；observe 仅报告，AI review 和自动修复默认关闭。
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
      enabled: false,
      blockSeverity: "major",
      minBlockingConfidence: 0.8,
      maxFixRounds: 0,
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

// ── Policy v2（v3.0 §9.2）：严格校验 + v1 兼容读取 + 迁移预览 ──────────

export const POLICY_VERSION_V2 = 2;

const ENFORCEMENT_MODES: readonly EnforcementMode[] = ["report", "require-pass", "require-approval"];
const REMEDIATION_MODES: readonly RemediationMode[] = ["off", "propose", "isolated-fix", "apply-low-risk"];
const REQUIREMENTS_MODES: readonly RequirementsMode[] = ["off", "suggest", "require-high-risk"];
const REVIEW_MODES: readonly ReviewMode[] = ["off", "advisory", "blocking"];
const VERIFICATION_MODES: readonly VerificationMode[] = ["off", "suggest", "require-evidence"];

/** 校验 RequirementRule，返回错误列表。 */
function validateRequirementRule(r: unknown, idx: number, errors: string[]): void {
  if (typeof r !== "object" || r === null) {
    errors.push(`requirementRules[${idx}]: not an object`);
    return;
  }
  const rr = r as Record<string, unknown>;
  if (typeof rr.id !== "string" || rr.id.length === 0) errors.push(`requirementRules[${idx}]: id required`);
  if (typeof rr.dimension !== "string" || rr.dimension.length === 0) errors.push(`requirementRules[${idx}]: dimension required`);
  if (typeof rr.questionTemplate !== "string") errors.push(`requirementRules[${idx}]: questionTemplate required`);
  // selector 可选，但若存在必须合法
  if (rr.selector !== undefined) validateRuleSelector(rr.selector, `requirementRules[${idx}].selector`, errors);
}

/** 校验 VerificationRule，返回错误列表。 */
function validateVerificationRule(r: unknown, idx: number, errors: string[]): void {
  if (typeof r !== "object" || r === null) {
    errors.push(`verificationRules[${idx}]: not an object`);
    return;
  }
  const rr = r as Record<string, unknown>;
  if (typeof rr.id !== "string" || rr.id.length === 0) errors.push(`verificationRules[${idx}]: id required`);
  if (typeof rr.criterionTemplate !== "string") errors.push(`verificationRules[${idx}]: criterionTemplate required`);
  if (rr.evidenceMode !== "all" && rr.evidenceMode !== "any") {
    errors.push(`verificationRules[${idx}]: evidenceMode must be all|any`);
  }
  if (!Array.isArray(rr.expectedEvidence)) {
    errors.push(`verificationRules[${idx}]: expectedEvidence must be an array`);
  }
  if (rr.selector !== undefined) validateRuleSelector(rr.selector, `verificationRules[${idx}].selector`, errors);
}

function validateRuleSelector(s: unknown, prefix: string, errors: string[]): void {
  if (typeof s !== "object" || s === null) {
    errors.push(`${prefix}: not an object`);
    return;
  }
  const sel = s as Record<string, unknown>;
  if (sel.intents !== undefined && (!Array.isArray(sel.intents) || sel.intents.some((x) => typeof x !== "string"))) {
    errors.push(`${prefix}.intents must be string array if present`);
  }
  if (sel.keywords !== undefined && (!Array.isArray(sel.keywords) || sel.keywords.some((x) => typeof x !== "string"))) {
    errors.push(`${prefix}.keywords must be string array if present`);
  }
  if (sel.pathPatterns !== undefined && (!Array.isArray(sel.pathPatterns) || sel.pathPatterns.some((x) => typeof x !== "string"))) {
    errors.push(`${prefix}.pathPatterns must be string array if present`);
  }
  if (sel.riskTags !== undefined && (!Array.isArray(sel.riskTags) || sel.riskTags.some((x) => typeof x !== "string"))) {
    errors.push(`${prefix}.riskTags must be string array if present`);
  }
}

function validateEnforcement(e: unknown, errors: string[]): void {
  if (typeof e !== "object" || e === null) { errors.push("enforcement must be an object"); return; }
  const ee = e as Record<string, unknown>;
  if (typeof ee.mode !== "string" || !ENFORCEMENT_MODES.includes(ee.mode as EnforcementMode)) {
    errors.push(`enforcement.mode must be one of ${ENFORCEMENT_MODES.join("|")}`);
  }
  if (ee.approvalRisk !== "high" && ee.approvalRisk !== "critical") {
    errors.push("enforcement.approvalRisk must be high|critical");
  }
}

function validateRemediation(r: unknown, errors: string[]): void {
  if (typeof r !== "object" || r === null) { errors.push("remediation must be an object"); return; }
  const rr = r as Record<string, unknown>;
  if (typeof rr.mode !== "string" || !REMEDIATION_MODES.includes(rr.mode as RemediationMode)) {
    errors.push(`remediation.mode must be one of ${REMEDIATION_MODES.join("|")}`);
  }
  if (typeof rr.maxFixRounds !== "number" || rr.maxFixRounds < 0 || !Number.isInteger(rr.maxFixRounds)) {
    errors.push("remediation.maxFixRounds must be a non-negative integer");
  }
}

function validateRequirements(r: unknown, errors: string[]): void {
  if (typeof r !== "object" || r === null) { errors.push("requirements must be an object"); return; }
  const rr = r as Record<string, unknown>;
  if (typeof rr.mode !== "string" || !REQUIREMENTS_MODES.includes(rr.mode as RequirementsMode)) {
    errors.push(`requirements.mode must be one of ${REQUIREMENTS_MODES.join("|")}`);
  }
  if (typeof rr.maxQuestions !== "number" || rr.maxQuestions < 0 || !Number.isInteger(rr.maxQuestions)) {
    errors.push("requirements.maxQuestions must be a non-negative integer");
  }
}

function validateReviewV2(r: unknown, errors: string[]): void {
  if (typeof r !== "object" || r === null) { errors.push("review must be an object"); return; }
  const rr = r as Record<string, unknown>;
  if (typeof rr.mode !== "string" || !REVIEW_MODES.includes(rr.mode as ReviewMode)) {
    errors.push(`review.mode must be one of ${REVIEW_MODES.join("|")}`);
  }
  if (rr.blockSeverity !== "critical" && rr.blockSeverity !== "major") {
    errors.push("review.blockSeverity must be critical|major");
  }
  if (typeof rr.minBlockingConfidence !== "number" || rr.minBlockingConfidence < 0 || rr.minBlockingConfidence > 1) {
    errors.push("review.minBlockingConfidence must be in [0,1]");
  }
}

function validateVerification(v: unknown, errors: string[]): void {
  if (typeof v !== "object" || v === null) { errors.push("verification must be an object"); return; }
  const vv = v as Record<string, unknown>;
  if (typeof vv.mode !== "string" || !VERIFICATION_MODES.includes(vv.mode as VerificationMode)) {
    errors.push(`verification.mode must be one of ${VERIFICATION_MODES.join("|")}`);
  }
}

function validateEvidence(e: unknown, errors: string[]): void {
  if (typeof e !== "object" || e === null) { errors.push("evidence must be an object"); return; }
  const ee = e as Record<string, unknown>;
  if (!Array.isArray(ee.excludePaths) || ee.excludePaths.some((x) => typeof x !== "string")) {
    errors.push("evidence.excludePaths must be string array");
  }
  if (typeof ee.retentionDays !== "number" || ee.retentionDays < 0 || !Number.isInteger(ee.retentionDays)) {
    errors.push("evidence.retentionDays must be a non-negative integer");
  }
  if (typeof ee.maxArtifactBytes !== "number" || ee.maxArtifactBytes < 0 || !Number.isInteger(ee.maxArtifactBytes)) {
    errors.push("evidence.maxArtifactBytes must be a non-negative integer");
  }
}

/** 校验完整 QualityPolicyV2，返回错误列表（空表示合法）。 */
export function validatePolicyV2(policy: unknown, scope: ProjectScope): string[] {
  const errors: string[] = [];
  if (typeof policy !== "object" || policy === null) return ["policy: not an object"];
  const p = policy as Record<string, unknown>;
  if (p.version !== POLICY_VERSION_V2) errors.push(`version must be ${POLICY_VERSION_V2}`);
  // checks / protectedPaths / riskRules 复用 v1 校验逻辑
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
      if (typeof r !== "object" || r === null) { errors.push(`riskRules[${i}]: not an object`); return; }
      const rr = r as Record<string, unknown>;
      if (typeof rr.pattern !== "string" || rr.pattern.length === 0) errors.push(`riskRules[${i}]: pattern required`);
      if (typeof rr.risk !== "string" || !RISKS.includes(rr.risk as QualityRisk)) errors.push(`riskRules[${i}]: risk must be one of ${RISKS.join("|")}`);
      if (typeof rr.reason !== "string") errors.push(`riskRules[${i}]: reason required`);
    });
  }
  if (!Array.isArray(p.requirementRules)) {
    errors.push("requirementRules must be an array");
  } else {
    p.requirementRules.forEach((r, i) => validateRequirementRule(r, i, errors));
  }
  if (!Array.isArray(p.verificationRules)) {
    errors.push("verificationRules must be an array");
  } else {
    p.verificationRules.forEach((r, i) => validateVerificationRule(r, i, errors));
  }
  validateEnforcement(p.enforcement, errors);
  validateRemediation(p.remediation, errors);
  validateRequirements(p.requirements, errors);
  validateReviewV2(p.review, errors);
  validateVerification(p.verification, errors);
  validateEvidence(p.evidence, errors);
  return errors;
}

/** v1 → v2 迁移映射（§9.2 表格）。 */
const V1_AUTONOMY_MAP: Record<QualityAutonomy, { enforcement: EnforcementMode; remediation: RemediationMode }> = {
  observe: { enforcement: "report", remediation: "off" },
  propose: { enforcement: "require-approval", remediation: "propose" },
  "isolated-fix": { enforcement: "require-pass", remediation: "isolated-fix" },
  "apply-low-risk": { enforcement: "require-pass", remediation: "apply-low-risk" },
};

export function getPolicyEnforcement(policy: QualityPolicy | QualityPolicyV2): EnforcementMode {
  return policy.version === 2 ? policy.enforcement.mode : V1_AUTONOMY_MAP[policy.autonomy].enforcement;
}

export function getPolicyApprovalRisk(policy: QualityPolicy | QualityPolicyV2): "high" | "critical" {
  return policy.version === 2 ? policy.enforcement.approvalRisk : "high";
}

export function isPolicyReviewEnabled(policy: QualityPolicy | QualityPolicyV2): boolean {
  return policy.version === 2 ? policy.review.mode !== "off" : policy.review.enabled;
}

export function getPolicyMaxFixRounds(policy: QualityPolicy | QualityPolicyV2): number {
  return policy.version === 2 ? policy.remediation.maxFixRounds : policy.review.maxFixRounds;
}

/**
 * 生成 v1 → v2 迁移预览（不写盘，仅展示差异）。
 * v1 的 review.enabled=true 映射为 review.mode=advisory，false 映射为 off。
 */
export function migrateV1ToV2(v1: QualityPolicy): PolicyMigrationPreview {
  const mapped = V1_AUTONOMY_MAP[v1.autonomy];
  const changes: string[] = [];
  changes.push(`autonomy="${v1.autonomy}" → enforcement.mode="${mapped.enforcement}", remediation.mode="${mapped.remediation}"`);
  changes.push(`review.enabled=${v1.review.enabled} → review.mode=${v1.review.enabled ? "advisory" : "off"}`);
  changes.push(`review.maxFixRounds=${v1.review.maxFixRounds} → remediation.maxFixRounds=${v1.review.maxFixRounds}`);
  changes.push("新增 requirementRules=[]（Phase 3 启用）");
  changes.push("新增 verificationRules=[]（Phase 4 启用）");
  changes.push("新增 requirements.mode=off（Phase 3 启用）");
  changes.push("新增 verification.mode=off（Phase 4 启用）");
  changes.push("新增 evidence={excludePaths:[],retentionDays:30,maxArtifactBytes:10485760}");

  const v2: QualityPolicyV2 = {
    version: 2,
    checks: v1.checks,
    protectedPaths: v1.protectedPaths,
    riskRules: v1.riskRules,
    requirementRules: [] as RequirementRule[],
    verificationRules: [] as VerificationRule[],
    enforcement: { mode: mapped.enforcement, approvalRisk: "high" },
    remediation: { mode: mapped.remediation, maxFixRounds: v1.review.maxFixRounds },
    requirements: { mode: "off", maxQuestions: 3 },
    review: {
      mode: v1.review.enabled ? "advisory" : "off",
      blockSeverity: v1.review.blockSeverity,
      minBlockingConfidence: v1.review.minBlockingConfidence,
    },
    verification: { mode: "off" },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10_485_760 },
  };
  return { v1, v2, changes };
}

/**
 * 原子迁移 v1 → v2：校验旧文件 hash（CAS），写入新 v2 policy。
 * - 旧文件 hash 不匹配时拒绝写入（防止并发修改）；
 * - 写入失败时保留旧文件；
 * - 写入成功后旧文件备份为 quality.json.v1.bak。
 */
export type MigrationResult =
  | { ok: true; path: string; backupPath: string; policy: QualityPolicyV2 }
  | { ok: false; path: string; errors: string[]; reason: "hash-mismatch" | "write-failed" | "invalid-v1" };

export function migrateV1ToV2Write(
  scope: ProjectScope,
  expectedOldHash?: string,
): MigrationResult {
  const file = path.join(scope.root, POLICY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, path: file, errors: ["policy file not found"], reason: "invalid-v1" };
  }

  // CAS 检查
  if (expectedOldHash !== undefined) {
    const actualHash = hashPolicyString(raw);
    if (actualHash !== expectedOldHash) {
      return { ok: false, path: file, errors: [`hash mismatch: expected ${expectedOldHash}, got ${actualHash}`], reason: "hash-mismatch" };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, path: file, errors: [String(err)], reason: "invalid-v1" };
  }

  const v1Errors = validatePolicy(parsed, scope);
  if (v1Errors.length > 0) {
    return { ok: false, path: file, errors: v1Errors, reason: "invalid-v1" };
  }

  const v1 = parsed as QualityPolicy;
  const preview = migrateV1ToV2(v1);

  // 校验 v2 结果
  const v2Errors = validatePolicyV2(preview.v2, scope);
  if (v2Errors.length > 0) {
    return { ok: false, path: file, errors: v2Errors, reason: "write-failed" };
  }

  // 原子写入：先写临时文件，再 rename
  const tmpFile = file + ".tmp";
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(preview.v2, null, 2) + "\n", "utf8");
    // 备份旧文件
    const backupPath = file + ".v1.bak";
    fs.copyFileSync(file, backupPath);
    fs.renameSync(tmpFile, file);
    return { ok: true, path: file, backupPath, policy: preview.v2 };
  } catch (err) {
    // 写入失败：清理临时文件，保留旧文件
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    return { ok: false, path: file, errors: [String(err)], reason: "write-failed" };
  }
}

function hashPolicyString(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** 加载 policy 文件，自动识别 v1/v2 版本。v1 仍按 v1 语义返回。 */
export type LoadResultV2 =
  | { ok: true; policy: QualityPolicy | QualityPolicyV2; version: 1 | 2; path: string }
  | { ok: false; path: string; errors: string[]; reason: "not-found" | "invalid-json" | "invalid" };

export function loadPolicyV2(scope: ProjectScope): LoadResultV2 {
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
  const ver = (typeof parsed === "object" && parsed !== null) ? (parsed as Record<string, unknown>).version : undefined;
  if (ver === POLICY_VERSION) {
    const errors = validatePolicy(parsed, scope);
    if (errors.length > 0) return { ok: false, path: file, errors, reason: "invalid" };
    return { ok: true, path: file, policy: parsed as QualityPolicy, version: 1 };
  }
  if (ver === POLICY_VERSION_V2) {
    const errors = validatePolicyV2(parsed, scope);
    if (errors.length > 0) return { ok: false, path: file, errors, reason: "invalid" };
    return { ok: true, path: file, policy: parsed as QualityPolicyV2, version: 2 };
  }
  return { ok: false, path: file, errors: [`unknown policy version: ${String(ver)}`], reason: "invalid" };
}

// ── Policy snapshot（v3.0 §8.2）：run 创建时冻结策略快照 ──────────────

/** 计算 policy 内容的 sha256 hash（用于 run.policyHash）。 */
export function hashPolicy(policy: QualityPolicy | QualityPolicyV2): string {
  const json = JSON.stringify(policy);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * 将 policy 快照写入 artifact 目录，返回相对路径引用。
 * 快照文件名格式：policy-<hash前12位>.json
 */
export function writePolicySnapshot(
  policy: QualityPolicy | QualityPolicyV2,
  artifactDir: string,
  runId: string,
): { hash: string; ref: string } {
  const hash = hashPolicy(policy);
  const shortHash = hash.slice(0, 12);
  const dir = path.join(artifactDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `policy-${shortHash}.json`;
  const ref = path.join(dir, fileName);
  fs.writeFileSync(ref, JSON.stringify(policy, null, 2) + "\n", "utf8");
  return { hash, ref };
}

export function readPolicySnapshot(ref: string, scope: ProjectScope): QualityPolicy | QualityPolicyV2 | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(ref, "utf8")) as unknown;
    const version = typeof parsed === "object" && parsed !== null
      ? (parsed as { version?: unknown }).version
      : undefined;
    const errors = version === 2 ? validatePolicyV2(parsed, scope) : validatePolicy(parsed, scope);
    return errors.length === 0 ? parsed as QualityPolicy | QualityPolicyV2 : undefined;
  } catch {
    return undefined;
  }
}
