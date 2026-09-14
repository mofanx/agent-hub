export const STAGE_LABELS: Record<string, string> = {
  queued: "排队中",
  preflight: "预检中",
  implementing: "实现中",
  collecting: "收集变更",
  "quick-verifying": "L1 快速检查",
  "full-verifying": "L1 完整检查",
  fixing: "自动修复中",
  reviewing: "AI 审查中",
  reviewed: "审查完成",
  "requirement-verifying": "L3 需求验证",
  "awaiting-approval": "等待审批",
  accepted: "验证通过",
  failed: "验证未通过",
  inconclusive: "无法判定",
  waived: "已豁免",
  cancelled: "已取消",
  quarantined: "已隔离",
  stale: "已过期",
};

export const FAILURE_CODE_LABELS: Record<string, string> = {
  "l1-check-failed": "L1 确定性检查未通过",
  "l1-infra-failed": "检查基础设施失败",
  "l1-inconclusive": "L1 检查无法判定",
  "l1-no-passed-checks": "无通过的检查",
  "l3-verification-failed": "L3 需求验证未通过",
  "l3-inconclusive": "L3 需求证据不足",
  "fixer-budget-exhausted": "自动修复预算耗尽",
  "fixer-session-error": "修复会话创建失败",
  "fixer-prompt-error": "修复执行失败",
  "fixer-quick-gate-error": "修复后检查失败",
  "fixer-infra-failed": "修复基础设施失败",
  "fixer-no-fixable": "无可修复的问题",
  "fixer-error": "修复流程异常",
  "review-error": "AI 审查异常",
  "hub-restart": "Hub 重启导致中断",
  "infra-no-project": "未找到质量项目",
  "infra-no-policy": "未找到质量策略",
  "no-patch": "无代码变更",
  "lease-failed": "写锁获取失败",
};

export const TERMINAL_STAGES = new Set([
  "accepted",
  "failed",
  "inconclusive",
  "waived",
  "cancelled",
  "quarantined",
  "stale",
]);

export function qualityStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function qualityFailureLabel(code?: string): string | undefined {
  if (!code) return undefined;
  return FAILURE_CODE_LABELS[code] ?? code;
}

export function actionGuide(stage: string, failureCode?: string, isRoom = false): string | undefined {
  if (stage === "fixing" || stage === "awaiting-approval" || stage === "accepted") return undefined;
  if (!TERMINAL_STAGES.has(stage)) return undefined;
  if (stage === "inconclusive") return "无法判定质量结论，请检查检查配置或重新发送消息";
  if (stage === "failed") {
    const guides: Record<string, string> = {
      "fixer-budget-exhausted": "修复预算耗尽，请向 AI 描述失败原因并要求修复",
      "l1-check-failed": "L1 检查未通过，请向 AI 描述失败并要求修复",
      "l3-verification-failed": "需求验证未通过，请查看未满足的验收标准",
      "fixer-session-error": "质量流程异常，可重新发送消息触发验证",
      "fixer-prompt-error": "质量流程异常，可重新发送消息触发验证",
      "fixer-infra-failed": "检查基础设施异常，请检查环境后重试",
      "l1-infra-failed": "检查基础设施异常，请检查环境后重试",
    };
    const base = guides[failureCode ?? ""];
    if (isRoom) return base ? `${base}，或点击重试按钮重新派发任务` : "可点击重试按钮重新派发任务";
    return base;
  }
  return undefined;
}

export function compactQualityProgress(stage: string, fixRound: number, maxFixRounds: number, passed: number, failed: number, awaitingApproval: boolean): string | undefined {
  if (awaitingApproval) return "待审批";
  if (stage === "fixing") return `修复 ${fixRound}/${maxFixRounds}`;
  if (stage === "quick-verifying" || stage === "full-verifying") {
    const total = passed + failed;
    return total > 0 ? `L1 ${passed}/${total}` : "L1";
  }
  if (stage === "requirement-verifying") return "L3";
  if (stage === "reviewing") return "审查";
  if (stage === "reviewed") return "审查完成";
  if (stage === "collecting") return "收集";
  if (stage === "preflight" || stage === "implementing" || stage === "queued") return undefined;
  return undefined;
}
