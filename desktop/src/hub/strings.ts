export interface Strings {
  bypassEnabled: string;
  bypassDisabled: string;
  slashHelpTitle: string;
  slashHelpHelp: string;
  slashHelpStop: string;
  slashHelpBypass: string;
  slashHelpModel: string;
  unknownCommandHint: string;
  connectError: string;
  agentDisconnected: string;
  notConnected: string;
  connected: string;
  permissionRequest: string;
  modelSwitched: string;
  modelUnknown: string;
  modelListError: string;
  copy: string;
  selectText: string;
  quoting: string;
  copied: string;
  modelListTitle: string;
  modelCurrentLabel: string;
  modelNoResults: string;
  modelClearFilters: string;
  modelFilterHint: string;
  tokenInput: string;
  tokenOutput: string;
  tokenCached: string;
  tokenCachedWrite: string;
  tokenThought: string;
  tokenTotal: string;
  context: string;
  contextMax: string;
  quotaDaily: string;
  quotaWeekly: string;
  chatPlaceholder: string;
  roomPlaceholder: string;
  roomFlowPlaceholder: string;
  searchPlaceholder: string;
  close: string;
  permissionRequestLabel: string;
  elicitationRequestLabel: string;
  errorLabel: string;
  thoughtProcess: string;
  plan: string;
  verificationBy: string;
  verificationStatusLabel: string;
  verificationStatusUnverified: string;
  verificationStatusMemberPass: string;
  verificationStatusMemberNonpass: string;
  automaticCheckLabel: string;
  automaticCheckNotRun: string;
  automaticCheckExitedZero: string;
  automaticCheckExitedNonzero: string;
  automaticCheckBlocked: string;
  automaticCheckTimedOut: string;
  automaticCheckSnapshot: string;
  automaticCheckTruncated: string;
  memberReportedLabel: string;
  backendRunsLabel: string;
  backendRunCompleted: string;
  backendRunFailed: string;
  backendExitUnknown: string;
  backendClaimMatchLabel: string;
  backendVerificationCall: string;
  deliverableEvidence: string;
  evidenceSummaryLabel: string;
  evidenceCommandLabel: string;
  evidenceExitCodeLabel: string;
  verificationCommandLabel: string;
  verificationExitCodeSuffix: string;
  evidenceBaselineLabel: string;
  evidenceDiffLabel: string;
  evidenceStdoutLabel: string;
  evidenceStderrLabel: string;
  evidenceReproStepsLabel: string;
  dependsOnLabel: string;
  retryBadge: string;
  retryAction: string;
  helpBadgeUser: string;
  helpBadgeMember: string;
  waitingHelpHint: string;
  helpRequestUser: string;
  helpRequestMember: string;
  copyPathHint: string;
  copySummaryHint: string;
}

const zh: Strings = {
  bypassEnabled: "已开启审批自动通过",
  bypassDisabled: "已关闭审批自动通过",
  slashHelpTitle: "可用指令：",
  slashHelpHelp: "/help — 显示帮助",
  slashHelpStop: "/stop — 停止当前生成",
  slashHelpBypass: "/bypass [on|off] — 切换审批自动通过",
  slashHelpModel: "/model [模型] — 切换模型",
  unknownCommandHint: "未知指令，输入 /help 查看可用指令",
  connectError: "连接失败",
  agentDisconnected: "连接已断开",
  notConnected: "未连接",
  connected: "已连接",
  permissionRequest: "工具调用",
  modelSwitched: "已切换到 %s（%s）",
  modelUnknown: "未知模型: %s",
  modelListError: "获取模型列表失败: %s",
  copy: "复制",
  selectText: "选取文字",
  quoting: "引用",
  copied: "已复制",
  modelListTitle: "可选模型",
  modelCurrentLabel: "当前",
  modelNoResults: "没有匹配的模型",
  modelClearFilters: "清除筛选",
  modelFilterHint: "搜索模型名称、UID 或别名",
  tokenInput: "输入",
  tokenOutput: "输出",
  tokenCached: "缓存",
  tokenCachedWrite: "写缓存",
  tokenThought: "思考",
  tokenTotal: "总计",
  context: "上下文",
  contextMax: "上限",
  quotaDaily: "日已用 %s%",
  quotaWeekly: "周已用 %s%",
  chatPlaceholder: "给 AI 下指令…",
  roomPlaceholder: "群聊消息，@名字 指定成员",
  roomFlowPlaceholder: "流程进行中：发送并入补充；答复求助请点上方「答复」，输入“取消”中止",
  searchPlaceholder: "搜索聊天内容…",
  close: "关闭",
  permissionRequestLabel: "审批请求",
  elicitationRequestLabel: "输入请求",
  errorLabel: "错误",
  thoughtProcess: "思考过程",
  plan: "计划",
  verificationBy: "成员验证 @%s：",
  verificationStatusLabel: "验证：",
  verificationStatusUnverified: "尚未验证",
  verificationStatusMemberPass: "成员判断通过",
  verificationStatusMemberNonpass: "成员未确认通过",
  automaticCheckLabel: "自动检查：",
  automaticCheckNotRun: "未运行",
  automaticCheckExitedZero: "隔离检查：退出码 0（不代表验收通过）",
  automaticCheckExitedNonzero: "隔离检查：退出码 %s",
  automaticCheckBlocked: "隔离检查受阻",
  automaticCheckTimedOut: "隔离检查超时",
  automaticCheckSnapshot: "源码快照 %s",
  automaticCheckTruncated: "输出已截断",
  memberReportedLabel: "成员自报",
  backendRunsLabel: "后端工具回传（未独立复核）",
  backendRunCompleted: "完成",
  backendRunFailed: "失败",
  backendExitUnknown: "退出码未知",
  backendClaimMatchLabel: "命令/退出码与成员报告匹配",
  backendVerificationCall: "后端调用：%s（仅命令/退出码/可用输出字段匹配）",
  deliverableEvidence: "交付证据",
  evidenceSummaryLabel: "结论：",
  evidenceCommandLabel: "命令：",
  evidenceExitCodeLabel: "退出码：",
  verificationCommandLabel: "验证命令：",
  verificationExitCodeSuffix: "（退出码：%s）",
  evidenceBaselineLabel: "修改前：",
  evidenceDiffLabel: "差异：",
  evidenceStdoutLabel: "标准输出：",
  evidenceStderrLabel: "错误输出：",
  evidenceReproStepsLabel: "复现步骤：",
  dependsOnLabel: "依赖：",
  retryBadge: "重试 %s",
  retryAction: "重试",
  helpBadgeUser: "向你求助",
  helpBadgeMember: "求助 @%s",
  waitingHelpHint: "等待求助回复",
  helpRequestUser: "🆘 求助你：",
  helpRequestMember: "🆘 求助 @%s：",
  copyPathHint: "点击复制路径：%s",
  copySummaryHint: "点击复制摘要",
};

const en: Strings = {
  bypassEnabled: "Permission bypass enabled",
  bypassDisabled: "Permission bypass disabled",
  slashHelpTitle: "Available commands:",
  slashHelpHelp: "/help — show help",
  slashHelpStop: "/stop — stop current generation",
  slashHelpBypass: "/bypass [on|off] — toggle permission bypass",
  slashHelpModel: "/model [model] — switch model",
  unknownCommandHint: "Unknown command, type /help for available commands",
  connectError: "Connection failed",
  agentDisconnected: "Disconnected",
  notConnected: "Not connected",
  connected: "Connected",
  permissionRequest: "Tool call",
  modelSwitched: "Switched to %s (%s)",
  modelUnknown: "Unknown model: %s",
  modelListError: "Failed to load model list: %s",
  copy: "Copy",
  selectText: "Select text",
  quoting: "Quote",
  copied: "Copied",
  modelListTitle: "Available models",
  modelCurrentLabel: "Current",
  modelNoResults: "No matching models",
  modelClearFilters: "Clear filters",
  modelFilterHint: "Search by name, UID or alias",
  tokenInput: "Input",
  tokenOutput: "Output",
  tokenCached: "Cache",
  tokenCachedWrite: "Cache write",
  tokenThought: "Thought",
  tokenTotal: "Total",
  context: "Context",
  contextMax: "max",
  quotaDaily: "Day %s% used",
  quotaWeekly: "Week %s% used",
  chatPlaceholder: "Send an instruction…",
  roomPlaceholder: "Message, @name to mention",
  roomFlowPlaceholder: "Flow running: send adds a note; click “Reply” above to answer, “cancel” to abort",
  searchPlaceholder: "Search chat…",
  close: "Close",
  permissionRequestLabel: "Permission request",
  elicitationRequestLabel: "Input request",
  errorLabel: "Error",
  thoughtProcess: "Thinking",
  plan: "Plan",
  verificationBy: "Member review by @%s: ",
  verificationStatusLabel: "Verification: ",
  verificationStatusUnverified: "Not yet verified",
  verificationStatusMemberPass: "Passed by member review",
  verificationStatusMemberNonpass: "Member review did not confirm pass",
  automaticCheckLabel: "Automatic check: ",
  automaticCheckNotRun: "not run",
  automaticCheckExitedZero: "Isolated check: exit code 0 (not a pass)",
  automaticCheckExitedNonzero: "Isolated check: exit code %s",
  automaticCheckBlocked: "Isolated check blocked",
  automaticCheckTimedOut: "Isolated check timed out",
  automaticCheckSnapshot: "source snapshot %s",
  automaticCheckTruncated: "output truncated",
  memberReportedLabel: "Member-reported",
  backendRunsLabel: "Backend tool reports (not independently verified)",
  backendRunCompleted: "completed",
  backendRunFailed: "failed",
  backendExitUnknown: "exit code unknown",
  backendClaimMatchLabel: "Command/exit code matches member report",
  backendVerificationCall: "Backend call: %s (command/exit code/available output fields match only)",
  deliverableEvidence: "Delivery evidence",
  evidenceSummaryLabel: "Summary: ",
  evidenceCommandLabel: "Command: ",
  evidenceExitCodeLabel: "Exit code: ",
  verificationCommandLabel: "Verification command: ",
  verificationExitCodeSuffix: " (exit code: %s)",
  evidenceBaselineLabel: "Baseline: ",
  evidenceDiffLabel: "Diff: ",
  evidenceStdoutLabel: "Stdout: ",
  evidenceStderrLabel: "Stderr: ",
  evidenceReproStepsLabel: "Reproduction steps: ",
  dependsOnLabel: "Depends on: ",
  retryBadge: "Retry %s",
  retryAction: "Retry",
  helpBadgeUser: "Asking you",
  helpBadgeMember: "Asking @%s",
  waitingHelpHint: "Waiting for help reply",
  helpRequestUser: "🆘 Asking you: ",
  helpRequestMember: "🆘 Asking @%s: ",
  copyPathHint: "Click to copy path: %s",
  copySummaryHint: "Click to copy summary",
};

export function stringsFor(lang: string): Strings {
  return lang === "zh" ? zh : en;
}
