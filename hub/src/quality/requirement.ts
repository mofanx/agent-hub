import * as crypto from "node:crypto";
import type {
  RequestIntent,
  RequirementDimension,
  DimensionAssessment,
  RequirementAssessment,
  ClarificationRequest,
  RequirementSpec,
  RequirementRule,
  WorkRequest,
  QualityPolicyV2,
} from "./types.js";

/**
 * L0 需求质量门（v3.0 §6.2）。
 *
 * 设计约束：
 * - 只有 code-change 进入需求辅助；
 * - 确定性规则优先，模型辅助可选；
 * - 单轮最多 3 个 material questions；
 * - 模型超时/不可用时降级放行，记录 inconclusive；
 * - shadow/suggest 模式不阻断消息。
 */

export const MAX_QUESTIONS = 3;
export const CLARIFICATION_TTL_MS = 5 * 60 * 1000;

// ── L0 advisory 升级阈值（§19）──────────────────────────────────────
// shadow → advisory 升级条件：需同时满足以下全部阈值，且样本量达标。
// 这些是保守默认值，按项目可在 policy 中覆盖；未达标前保持 shadow 不阻断。

/** 升级评估所需最小 L0 交互样本数（提问次数）。 */
export const L0_ADVISORY_MIN_SAMPLES = 20;
/** 跳过率上限：跳过率高于此值说明问题打扰用户，不升级。 */
export const L0_ADVISORY_MAX_SKIP_RATE = 0.4;
/** 回答率下限：回答率低于此值说明问题无用，不升级。 */
export const L0_ADVISORY_MIN_ANSWER_RATE = 0.5;
/** 返工减少率下限：升级后返工率需相对基线减少至此比例，否则不升级。 */
export const L0_ADVISORY_MIN_REWORK_REDUCTION = 0.1;

/**
 * 评估 L0 是否满足从 shadow 升级到 advisory 的条件（§19）。
 * 只生成建议，不自动升级；升级仍需用户确认。
 *
 * 升级条件（需同时满足）：
 * - 样本数 >= L0_ADVISORY_MIN_SAMPLES；
 * - 跳过率 <= L0_ADVISORY_MAX_SKIP_RATE；
 * - 回答率 >= L0_ADVISORY_MIN_ANSWER_RATE；
 * - 返工减少率 >= L0_ADVISORY_MIN_REWORK_REDUCTION。
 */
export function shouldUpgradeL0ToAdvisory(opts: {
  samples: number;
  skipRate: number;
  answerRate: number;
  reworkReduction: number;
}): { upgrade: boolean; reason: string } {
  if (opts.samples < L0_ADVISORY_MIN_SAMPLES) {
    return { upgrade: false, reason: `samples ${opts.samples} < ${L0_ADVISORY_MIN_SAMPLES}` };
  }
  if (opts.skipRate > L0_ADVISORY_MAX_SKIP_RATE) {
    return { upgrade: false, reason: `skip rate ${opts.skipRate.toFixed(2)} > ${L0_ADVISORY_MAX_SKIP_RATE}` };
  }
  if (opts.answerRate < L0_ADVISORY_MIN_ANSWER_RATE) {
    return { upgrade: false, reason: `answer rate ${opts.answerRate.toFixed(2)} < ${L0_ADVISORY_MIN_ANSWER_RATE}` };
  }
  if (opts.reworkReduction < L0_ADVISORY_MIN_REWORK_REDUCTION) {
    return { upgrade: false, reason: `rework reduction ${opts.reworkReduction.toFixed(2)} < ${L0_ADVISORY_MIN_REWORK_REDUCTION}` };
  }
  return { upgrade: true, reason: "all thresholds met" };
}

// ── 意图分类 ────────────────────────────────────────────────────────

const CODE_CHANGE_KEYWORDS = [
  "实现", "修改", "添加", "新增", "删除", "重构", "修复", "更新", "创建",
  "改", "写", "做", "开发", "部署", "迁移", "升级", "替换", "集成", "对接",
  "implement", "fix", "add", "remove", "refactor", "update", "create",
  "deploy", "migrate", "integrate",
];

const INVESTIGATION_KEYWORDS = [
  "什么是", "为什么", "如何", "怎么", "解释", "分析", "调研", "了解",
  "查看", "检查", "诊断", "what", "why", "how", "explain", "analyze",
];

const DISCUSSION_KEYWORDS = [
  "讨论", "觉得", "认为", "建议", "想法", "比较", "选择", "权衡",
  "discuss", "think", "suggest", "compare", "consider",
];

const CONTROL_COMMANDS = ["/stop", "/run", "/cancel", "/pause", "/resume", "/quality"];

const SHORT_CONFIRMATIONS = new Set([
  "yes", "no", "ok", "好的", "是", "否", "对", "不对", "继续", "跳过", "skip",
  "取消", "cancel", "确认", "confirm", "y", "n", "好的", "可以", "不行",
]);

/**
 * 意图分类：确定性规则优先。
 * - 短确认 → clarification-answer
 * - 斜杠命令 → control-command
 * - 问句/查询 → investigation
 * - 讨论性语句 → discussion
 * - 代码变更关键词 → code-change
 * - 默认 → discussion（不拦截）
 */
export function classifyIntent(text: string): RequestIntent {
  const trimmed = text.trim();

  // 短确认（< 20 字符且在确认集合中）
  if (trimmed.length < 20 && SHORT_CONFIRMATIONS.has(trimmed.toLowerCase())) {
    return "clarification-answer";
  }

  // 斜杠命令
  if (trimmed.startsWith("/")) {
    const cmd = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (CONTROL_COMMANDS.some((c) => cmd.startsWith(c))) return "control-command";
  }

  // 问句（以 ? 或 ？结尾，或包含疑问词）
  if (trimmed.endsWith("?") || trimmed.endsWith("？")) {
    return INVESTIGATION_KEYWORDS.some((kw) => trimmed.includes(kw))
      ? "investigation"
      : "investigation";
  }
  if (INVESTIGATION_KEYWORDS.some((kw) => trimmed.includes(kw))) {
    return "investigation";
  }

  // 代码变更关键词
  if (CODE_CHANGE_KEYWORDS.some((kw) => trimmed.toLowerCase().includes(kw))) {
    return "code-change";
  }

  // 讨论性语句
  if (DISCUSSION_KEYWORDS.some((kw) => trimmed.includes(kw))) {
    return "discussion";
  }

  // 默认：讨论（不拦截）
  return "discussion";
}

// ── 7 维度通用评估 ──────────────────────────────────────────────────

/** 评估单个维度的确定性检查。 */
function assessDimension(
  dimension: RequirementDimension,
  text: string,
  ruleId?: string,
): DimensionAssessment {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  switch (dimension) {
    case "goal-clarity": {
      // 目标不清晰：过短（< 15 字符）、无动词、只有名词短语
      const hasVerb = CODE_CHANGE_KEYWORDS.some((kw) => lower.includes(kw));
      const material = trimmed.length < 15 || !hasVerb;
      return {
        dimension,
        ruleId,
        material,
        question: material ? "你希望实现什么具体功能？请描述目标行为而非仅提及组件名。" : undefined,
        reason: material ? "目标描述过短或缺少动作词，不同理解会产生不同实现" : "目标包含明确动作词",
      };
    }
    case "boundary-completeness": {
      // 边界缺失：未提及迁移/兼容/删除等会改变工作量的内容
      const boundaryKeywords = ["迁移", "兼容", "删除", "保留", "回滚", "降级", "migrate", "compatible", "rollback"];
      const hasBoundary = boundaryKeywords.some((kw) => lower.includes(kw));
      const material = !hasBoundary && trimmed.length > 20;
      return {
        dimension,
        ruleId,
        material,
        question: material ? "是否需要数据迁移、兼容旧版本或清理废弃代码？" : undefined,
        reason: material ? "未提及边界条件，可能遗漏影响工作量的内容" : "已包含边界描述或任务简单",
      };
    }
    case "verifiability": {
      // 验收不可验证：无明确验收标准
      const verifyKeywords = ["测试", "验证", "检查", "test", "verify", "assert", "通过条件"];
      const hasVerify = verifyKeywords.some((kw) => lower.includes(kw));
      const material = !hasVerify && CODE_CHANGE_KEYWORDS.some((kw) => lower.includes(kw));
      return {
        dimension,
        ruleId,
        material,
        question: material ? "完成后如何验证这个功能正确工作？有具体的验收标准吗？" : undefined,
        reason: material ? "缺少可验证的完成标准" : "已包含验证描述或非代码任务",
      };
    }
    case "constraint-clarity": {
      // 约束不明确：涉及性能/平台但未明确约束
      const constraintKeywords = ["性能", "兼容", "平台", "版本", "限制", "不能破坏", "保持", "performance", "platform", "version"];
      const hasConstraint = constraintKeywords.some((kw) => lower.includes(kw));
      const material = !hasConstraint && (lower.includes("api") || lower.includes("接口") || lower.includes("数据库"));
      return {
        dimension,
        ruleId,
        material,
        question: material ? "有哪些不能破坏的兼容性、性能或平台约束？" : undefined,
        reason: material ? "涉及 API/数据库但未明确约束" : "已包含约束或不涉及敏感区域",
      };
    }
    case "conflict-detection": {
      // 冲突检测：确定性规则难以独立判断，默认不 material（需模型辅助）
      return {
        dimension,
        ruleId,
        material: false,
        reason: "确定性规则无法独立检测冲突，需模型辅助",
      };
    }
    case "dependency-identification": {
      // 依赖识别：提及"先"、"等"、"依赖"等词时可能有未完成依赖
      const depKeywords = ["先", "等", "依赖", "需要", "前提", "depend", "require", "prerequisite"];
      const hasDep = depKeywords.some((kw) => lower.includes(kw));
      const material = hasDep && !lower.includes("已完成") && !lower.includes("已就绪");
      return {
        dimension,
        ruleId,
        material,
        question: material ? "是否有未完成的前置任务或外部依赖需要先解决？" : undefined,
        reason: material ? "提及依赖但未确认是否就绪" : "未提及依赖或已确认就绪",
      };
    }
    case "risk-identification": {
      // 风险识别：涉及安全/权限/数据/部署等高风险路径
      const riskKeywords = ["安全", "权限", "密码", "token", "数据", "部署", "生产", "账务", "security", "permission", "password", "deploy", "production"];
      const hasRisk = riskKeywords.some((kw) => lower.includes(kw));
      const material = hasRisk;
      return {
        dimension,
        ruleId,
        material,
        question: material ? "这个变更涉及安全/权限/数据/部署等高风险路径，需要特别注意什么？" : undefined,
        reason: material ? "涉及高风险路径" : "未涉及高风险路径",
      };
    }
  }
}

const ALL_DIMENSIONS: RequirementDimension[] = [
  "goal-clarity",
  "boundary-completeness",
  "verifiability",
  "constraint-clarity",
  "conflict-detection",
  "dependency-identification",
  "risk-identification",
];

/**
 * 通用维度评估（第一阶段，项目未知时）。
 * 纯确定性规则，不调用模型。
 */
export function assessGeneric(text: string): DimensionAssessment[] {
  return ALL_DIMENSIONS.map((dim) => assessDimension(dim, text));
}

/**
 * 项目级规则评估（第二阶段，项目已知后）。
 * 应用 policy v2 的 requirementRules，按 selector 过滤后生成额外评估。
 */
export function assessProjectSpecific(
  text: string,
  rules: RequirementRule[],
  intent: RequestIntent,
): DimensionAssessment[] {
  const lower = text.toLowerCase();
  const assessments: DimensionAssessment[] = [];
  for (const rule of rules) {
    if (!matchesSelector(rule.selector, intent, lower)) continue;
    assessments.push({
      dimension: rule.dimension as RequirementDimension,
      ruleId: rule.id,
      material: true,
      question: rule.questionTemplate,
      reason: `项目规则 ${rule.id} 匹配`,
    });
  }
  return assessments;
}

function matchesSelector(
  selector: RequirementRule["selector"],
  intent: RequestIntent,
  lowerText: string,
): boolean {
  if (selector.intents && !selector.intents.includes(intent)) return false;
  if (selector.keywords && !selector.keywords.some((kw) => lowerText.includes(kw.toLowerCase()))) return false;
  // pathPatterns 和 riskTags 在纯文本意图分类阶段无法匹配，跳过
  return true;
}

// ── Clarification 生成 ──────────────────────────────────────────────

/**
 * 合并通用和项目级评估，按 materiality 选择最多 3 个问题。
 * 按 dimension/ruleId 去重。
 */
export function selectQuestions(
  generic: DimensionAssessment[],
  projectSpecific: DimensionAssessment[],
): Array<{ id: string; dimension: RequirementDimension; ruleId?: string; text: string }> {
  const seenDimensions = new Set<RequirementDimension>();
  const candidates: Array<{ dimension: RequirementDimension; ruleId?: string; text: string }> = [];

  // 项目级优先
  for (const a of projectSpecific) {
    if (!a.material || !a.question) continue;
    if (seenDimensions.has(a.dimension)) continue;
    seenDimensions.add(a.dimension);
    candidates.push(a.ruleId !== undefined
      ? { dimension: a.dimension, ruleId: a.ruleId, text: a.question }
      : { dimension: a.dimension, text: a.question });
  }

  // 通用补充
  for (const a of generic) {
    if (!a.material || !a.question) continue;
    if (seenDimensions.has(a.dimension)) continue;
    seenDimensions.add(a.dimension);
    candidates.push({ dimension: a.dimension, text: a.question });
  }

  return candidates.slice(0, MAX_QUESTIONS).map((c) => ({
    id: `q-${crypto.randomBytes(4).toString("hex")}`,
    dimension: c.dimension,
    ...(c.ruleId !== undefined ? { ruleId: c.ruleId } : {}),
    text: c.text,
  }));
}

// ── ClarificationRequest 工厂 ───────────────────────────────────────

export function createClarificationRequest(params: {
  requestId: string;
  specId: string;
  specVersion: number;
  questions: ClarificationRequest["questions"];
  canSkip?: boolean;
  expiresAt?: number;
}): ClarificationRequest {
  return {
    id: `cr-${crypto.randomBytes(8).toString("hex")}`,
    requestId: params.requestId,
    specId: params.specId,
    specVersion: params.specVersion,
    questions: params.questions,
    canSkip: params.canSkip ?? true,
    expiresAt: params.expiresAt,
    status: "pending",
    createdAt: Date.now(),
  };
}

/**
 * 检查澄清请求是否过期。
 * 过期的请求不接受回答，不写入新 spec 版本。
 */
export function isExpired(req: ClarificationRequest, now = Date.now()): boolean {
  return req.expiresAt !== undefined && now > req.expiresAt;
}

// ── 完整 L0 评估流程 ────────────────────────────────────────────────

/**
 * 执行完整 L0 评估（两阶段）。
 *
 * @param text 用户原始输入
 * @param request 已创建的 WorkRequest
 * @param spec 已创建的 RequirementSpec
 * @param policy 可选的项目级 policy v2（第二阶段用）
 * @param opts 模式和模型回调
 */
export async function evaluateRequirement(
  text: string,
  request: WorkRequest,
  spec: RequirementSpec,
  policy?: QualityPolicyV2,
  opts?: {
    mode?: "shadow" | "suggest" | "require";
    modelCall?: (prompt: string) => Promise<string>;
    modelTimeoutMs?: number;
  },
): Promise<RequirementAssessment> {
  const start = Date.now();
  const mode = opts?.mode ?? "shadow";
  let modelCalls = 0;
  let tokensUsed = 0;
  let inconclusive = false;

  // 第一阶段：通用维度
  const generic = assessGeneric(text);

  // 第二阶段：项目级规则
  let projectSpecific: DimensionAssessment[] = [];
  if (policy && policy.requirementRules.length > 0) {
    try {
      projectSpecific = assessProjectSpecific(text, policy.requirementRules, request.intent);
    } catch {
      inconclusive = true;
    }
  }

  // 可选：模型辅助（用于 conflict-detection 等确定性规则无法覆盖的维度）
  if (opts?.modelCall && !inconclusive) {
    try {
      const modelPrompt = buildModelPrompt(text, spec);
      const timeoutMs = opts.modelTimeoutMs ?? 10000;
      const result = await withTimeout(opts.modelCall(modelPrompt), timeoutMs);
      modelCalls = 1;
      tokensUsed = estimateTokens(text + result);
      // 模型结果解析为额外评估（简化：只补充 conflict-detection）
      const modelAssessment = parseModelResult(result);
      if (modelAssessment) {
        projectSpecific = [...projectSpecific, modelAssessment];
      }
    } catch {
      // 模型超时或不可用 → 安全降级
      inconclusive = true;
    }
  }

  const selectedQuestions = selectQuestions(generic, projectSpecific);

  return {
    specId: spec.id,
    specVersion: spec.version,
    requestId: request.id,
    stage: policy ? "project-specific" : "generic",
    assessments: [...generic, ...projectSpecific],
    selectedQuestions,
    mode,
    cost: { modelCalls, tokensUsed, durationMs: Date.now() - start },
    inconclusive,
  };
}

function buildModelPrompt(text: string, spec: RequirementSpec): string {
  return `分析以下需求是否存在冲突或遗漏。只返回 JSON：{"dimension":"conflict-detection","material":true,"question":"...","reason":"..."} 或 null。\n需求：${text}\n当前 spec goal：${spec.goal}`;
}

function parseModelResult(result: string): DimensionAssessment | undefined {
  try {
    const parsed = JSON.parse(result.trim());
    if (parsed && parsed.dimension && parsed.material !== undefined) {
      return {
        dimension: parsed.dimension as RequirementDimension,
        material: Boolean(parsed.material),
        question: parsed.question,
        reason: String(parsed.reason ?? "model-assisted"),
      };
    }
  } catch {
    // 模型输出非 JSON → 安全降级
  }
  return undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("model timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── 回答处理 ────────────────────────────────────────────────────────

/**
 * 处理用户回答：将回答写入 spec 的 clarifications，返回更新后的 spec。
 * 过期回答不写入新版本。
 */
export function applyClarificationAnswers(
  spec: RequirementSpec,
  answers: Array<{ questionId: string; answer: string }>,
  clarificationRequest: ClarificationRequest,
): RequirementSpec {
  if (isExpired(clarificationRequest)) {
    // 过期：标记问题为 expired，不修改 spec 内容
    return {
      ...spec,
      clarifications: spec.clarifications.map((c) =>
        c.id === clarificationRequest.questions[0]?.id ? { ...c, status: "expired" as const } : c,
      ),
      updatedAt: Date.now(),
    };
  }

  const answerMap = new Map(answers.map((a) => [a.questionId, a.answer]));
  const updatedClarifications = spec.clarifications.map((c) => {
    if (answerMap.has(c.id)) {
      return { ...c, answer: answerMap.get(c.id), status: "answered" as const };
    }
    return c;
  });

  return {
    ...spec,
    clarifications: updatedClarifications,
    status: "accepted",
    updatedAt: Date.now(),
  };
}

/**
 * 处理跳过：标记所有未回答问题为 skipped，spec 直接进入 accepted。
 */
export function applyClarificationSkip(
  spec: RequirementSpec,
  clarificationRequest: ClarificationRequest,
): RequirementSpec {
  const questionIds = new Set(clarificationRequest.questions.map((q) => q.id));
  const updatedClarifications = spec.clarifications.map((c) =>
    questionIds.has(c.id) && c.status === "pending"
      ? { ...c, status: "skipped" as const }
      : c,
  );

  return {
    ...spec,
    clarifications: updatedClarifications,
    status: "accepted",
    updatedAt: Date.now(),
  };
}

/**
 * 处理取消：标记 WorkRequest 和 spec 为 cancelled。
 */
export function applyClarificationCancel(spec: RequirementSpec): RequirementSpec {
  return {
    ...spec,
    status: "cancelled",
    updatedAt: Date.now(),
  };
}
