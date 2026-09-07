import type { ChangeSetFile, QualityPolicy, QualityRisk, RiskRule } from "./types.js";

/**
 * 保护路径与风险分类（设计文档 §11.3 / §5.2）。
 *
 * - 权限/质量/部署/DB 修改自动升为 high/critical；
 * - protectedPaths 中的文件修改 → critical；
 * - riskRules 匹配的文件按规则风险等级分类；
 * - 无匹配的普通文件 → low。
 */

/** 默认保护路径模式（设计文档 §11.3 自修改保护区域）。 */
export const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  ".devin/quality.json",
  "hub/src/quality/**",
  "hub/src/agent.ts",
  "hub/src/worker.ts",
  "hub/src/multiplex-worker.ts",
];

/** 默认风险规则（设计文档 §11.3）。 */
export const DEFAULT_RISK_RULES: readonly RiskRule[] = [
  { pattern: ".devin/quality.json", risk: "critical", reason: "quality policy 自修改" },
  { pattern: "hub/src/quality/**", risk: "critical", reason: "质量系统核心代码" },
  { pattern: "hub/src/agent.ts", risk: "high", reason: "Agent 协议层" },
  { pattern: "hub/src/worker.ts", risk: "high", reason: "远程 worker 协议" },
  { pattern: "hub/src/multiplex-worker.ts", risk: "high", reason: "多路 worker 协议" },
  { pattern: "hub/src/store.ts", risk: "high", reason: "持久化层" },
  { pattern: "hub/src/index.ts", risk: "high", reason: "Hub 主入口" },
  { pattern: "hub/src/conductor.ts", risk: "high", reason: "编排核心" },
  { pattern: "hub/src/room-modes.ts", risk: "high", reason: "编排核心" },
  { pattern: "**/*.test.ts", risk: "medium", reason: "测试文件修改需审查" },
  { pattern: ".github/**", risk: "high", reason: "CI/CD 配置" },
  { pattern: "deploy/**", risk: "high", reason: "部署配置" },
  { pattern: "**/secrets/**", risk: "critical", reason: "可能包含密钥" },
  { pattern: "**/*.env", risk: "critical", reason: "环境变量文件" },
];

const RISK_ORDER: readonly QualityRisk[] = ["low", "medium", "high", "critical"];

function higherRisk(a: QualityRisk, b: QualityRisk): QualityRisk {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function matchPath(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(pattern + "/");
}

/**
 * 判断文件是否在保护路径中。
 */
export function isProtectedPath(filePath: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((p) => matchPath(filePath, p));
}

/**
 * 对单个文件分类风险等级。
 * - protectedPaths 匹配 → critical
 * - riskRules 匹配 → 取最高匹配规则的风险
 * - 无匹配 → low
 */
export function classifyFile(
  filePath: string,
  policy?: Pick<QualityPolicy, "protectedPaths" | "riskRules">,
): { risk: QualityRisk; reasons: string[] } {
  const protectedPaths = policy?.protectedPaths ?? [];
  const riskRules = policy?.riskRules ?? [];
  const reasons: string[] = [];
  let risk: QualityRisk = "low";

  if (isProtectedPath(filePath, protectedPaths)) {
    risk = "critical";
    reasons.push(`protected path: ${filePath}`);
  }

  for (const rule of riskRules) {
    if (matchPath(filePath, rule.pattern)) {
      risk = higherRisk(risk, rule.risk);
      reasons.push(`risk rule (${rule.risk}): ${rule.pattern} — ${rule.reason}`);
    }
  }

  return { risk, reasons };
}

/**
 * 对整个 ChangeSet 的文件列表分类风险，返回整体风险和所有原因。
 * 整体风险 = 所有文件中的最高风险。
 */
export function classifyChangeSet(
  files: ChangeSetFile[],
  policy?: Pick<QualityPolicy, "protectedPaths" | "riskRules">,
): { risk: QualityRisk; reasons: string[] } {
  let overallRisk: QualityRisk = "low";
  const allReasons: string[] = [];

  for (const f of files) {
    const { risk, reasons } = classifyFile(f.path, policy);
    if (RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(overallRisk)) {
      overallRisk = risk;
    }
    allReasons.push(...reasons);
  }

  return { risk: overallRisk, reasons: allReasons };
}

/**
 * 判断某风险等级是否需要用户审批。
 * high/critical 始终需要审批；medium 在 autonomy=propose 时需要审批。
 */
export function requiresApproval(
  risk: QualityRisk,
  autonomy: QualityPolicy["autonomy"],
): boolean {
  if (risk === "critical" || risk === "high") return true;
  if (risk === "medium" && autonomy === "propose") return true;
  if (autonomy === "observe") return risk !== "low";
  return false;
}

/**
 * 判断某文件修改是否属于自修改保护区域（设计文档 §11.3）。
 * 这些改动永远不能只由同一质量循环自动批准。
 */
export function isSelfModification(filePath: string): boolean {
  return DEFAULT_PROTECTED_PATTERNS.some((p) => matchPath(filePath, p));
}
