import type {
  ChangeSet,
  CheckDefinition,
  CheckRun,
  CheckRunStatus,
  CheckTier,
  ProjectScope,
  QualityPolicy,
  QualityPolicyV2,
} from "./types.js";
import type { ExecutionProvider } from "./execution.js";
import { checkRunId } from "./execution.js";

/**
 * GateEngine（设计文档 §4.1 / §9）。
 *
 * 职责：
 * - 按 ChangeSet 受影响 paths 选择 quick/full 检查；
 * - 调用 ExecutionProvider 执行，收集 CheckRun；
 * - 非零 exitCode 一律判定 failed，绝不 PASS；
 * - timeout / 缺依赖 / 断线 归类为 infra-failed，不视为代码缺陷；
 * - 不允许 reviewer 覆盖确定性失败。
 */

/** Gate 运行结果。 */
export type GateResult = {
  tier: CheckTier;
  checks: CheckRun[];
  /** 所有 required 检查通过时为 true（optional 失败不阻断）。空 tier 视为通过。 */
  passed: boolean;
  /** 代码缺陷导致的失败（required 检查 exitCode !== 0 且非 infra）。 */
  codeFailed: boolean;
  /** 基础设施失败（timeout / infra-failed / cancelled）。 */
  infraFailed: boolean;
  /** 被取消。 */
  cancelled: boolean;
  /** 全部 required 检查均为 infra 失败，无法判定代码质量。 */
  inconclusive: boolean;
  /** 实际执行的 required 检查数。 */
  requiredCount: number;
  /** 实际执行的 optional 检查数。 */
  optionalCount: number;
};

/** 判断 CheckRunStatus 是否属于基础设施失败而非代码缺陷（§9 / Q1-02）。 */
export function isInfraFailure(status: CheckRunStatus): boolean {
  return status === "timeout" || status === "infra-failed" || status === "cancelled";
}

/**
 * 判断某 check 是否受 ChangeSet 影响。
 *
 * 规则：
 * - check 无 paths → 总是受影响（全量检查）；
 * - check.paths 中任一 pattern 匹配 ChangeSet.files 中任一路径 → 受影响；
 * - pattern 支持 `**` 递归通配（如 `hub/**` 匹配 `hub/src/foo.ts`）；
 * - 无 ChangeSet 时视为全量（首次运行 / 无 git）。
 */
export function isCheckAffected(check: CheckDefinition, changeSet: ChangeSet | undefined): boolean {
  if (!changeSet) return true;
  if (!check.paths || check.paths.length === 0) return true;
  return check.paths.some((pat) =>
    changeSet.files.some((f) => matchPath(pat, f.path)),
  );
}

/** 选择受影响的检查，按 tier 过滤。 */
export function selectChecks(
  policy: QualityPolicy | QualityPolicyV2,
  tier: CheckTier,
  changeSet: ChangeSet | undefined,
): CheckDefinition[] {
  return policy.checks.filter(
    (c) => c.tier === tier && isCheckAffected(c, changeSet),
  );
}

/**
 * 通配匹配：支持 `**` 递归、`*` 单层。
 * `hub/**` → hub 下所有文件（含子目录）；
 * `desktop/src/**` → desktop/src 下所有文件；
 * 精确路径 → 精确匹配。
 */
export function matchPath(pattern: string, filePath: string): boolean {
  if (pattern === filePath) return true;
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return filePath === base || filePath.startsWith(base.endsWith("/") ? base : base + "/");
  }
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return filePath.startsWith(base.endsWith("/") ? base : base + "/") &&
      !filePath.slice(base.length + 1).includes("/");
  }
  // 支持 `*` 作为单层通配
  if (pattern.includes("*")) {
    return globToRegex(pattern).test(filePath);
  }
  // 目录前缀匹配：`hub/src` 匹配 `hub/src/foo.ts`
  return filePath.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}

function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "/" || c === ".") {
      re += c;
    } else {
      re += c.replace(/[+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export type GateEngineOptions = {
  /** 持久化 check 结果的回调（通常绑定 Store / QualityService）。 */
  onSaveCheck?: ((check: CheckRun) => void) | undefined;
  /** 取消时调用的回调。 */
  onCancel?: ((runId: string, checkId?: string) => Promise<void> | void) | undefined;
};

export class GateEngine {
  private readonly exec: ExecutionProvider;
  private readonly onSaveCheck: ((check: CheckRun) => void) | undefined;
  private readonly onCancel: ((runId: string, checkId?: string) => Promise<void> | void) | undefined;

  constructor(exec: ExecutionProvider, opts: GateEngineOptions = {}) {
    this.exec = exec;
    this.onSaveCheck = opts.onSaveCheck;
    this.onCancel = opts.onCancel;
  }

  /**
   * 运行指定 tier 的 gate 检查。
   *
   * @param project  目标项目
   * @param policy   项目质量策略
   * @param tier     quick 或 full
   * @param runId    关联的 QualityRun id
   * @param changeSet 变更集（用于选择受影响检查）
   * @param attempt  重试次数（默认 1）
   */
  async runGate(
    project: ProjectScope,
    policy: QualityPolicy | QualityPolicyV2,
    tier: CheckTier,
    runId: string,
    changeSet: ChangeSet | undefined,
    attempt = 1,
  ): Promise<GateResult> {
    const checks = selectChecks(policy, tier, changeSet);
    const results: CheckRun[] = [];

    for (const check of checks) {
      const id = checkRunId(runId, check.id, attempt);
      const result = await this.exec.run(project, check, runId);
      const normalized: CheckRun = { ...result, id, attempt };
      results.push(normalized);
      this.onSaveCheck?.(normalized);
    }

    return classifyResult(tier, results, checks);
  }

  /** 取消指定 runId 下所有正在运行的 check。 */
  async cancel(runId: string, checkId?: string): Promise<void> {
    if (this.onCancel) {
      await this.onCancel(runId, checkId);
    }
    await this.exec.cancel(runId, checkId);
  }
}

/**
 * 对 CheckRun 列表做失败分类，生成 GateResult。
 *
 * 硬约束（§9 / Q1-01 / Q1-02）：
 * - 非零 exitCode → failed，绝不 PASS；
 * - timeout / infra-failed / cancelled → infraFailed，不视为代码缺陷；
 * - passed 要求所有 required 检查通过（optional 失败不阻断）；
 * - 空 tier（无受影响检查）视为 passed（vacuously true）；
 * - 所有 required 检查均为 infra 失败 → inconclusive，无法判定代码质量。
 */
export function classifyResult(
  tier: CheckTier,
  checks: CheckRun[],
  definitions: CheckDefinition[] = [],
): GateResult {
  let codeFailed = false;
  let infraFailed = false;
  let cancelled = false;
  let requiredFailed = false;
  let requiredInfraFailed = false;
  let requiredCount = 0;
  let optionalCount = 0;

  const defMap = new Map(definitions.map((d) => [d.id, d]));

  for (const c of checks) {
    const def = defMap.get(c.checkId);
    const isRequired = def ? def.required : true;

    if (c.status === "passed") continue;
    if (isInfraFailure(c.status)) {
      infraFailed = true;
      if (c.status === "cancelled") cancelled = true;
      if (isRequired) requiredInfraFailed = true;
    } else if (c.status === "failed") {
      if (isRequired) {
        codeFailed = true;
        requiredFailed = true;
      }
    }
  }

  requiredCount = definitions.filter((d) => d.required).length;
  optionalCount = definitions.filter((d) => !d.required).length;

  const inconclusive = requiredInfraFailed && !codeFailed && !requiredFailed;
  const passed = !requiredFailed && !requiredInfraFailed;

  return { tier, checks, passed, codeFailed, infraFailed, cancelled, inconclusive, requiredCount, optionalCount };
}
