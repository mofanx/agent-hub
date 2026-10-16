export interface Strings {
  bypassEnabled: string;
  bypassDisabled: string;
  slashHelpTitle: string;
  slashHelpHelp: string;
  slashHelpStop: string;
  slashHelpBypass: string;
  slashHelpModel: string;
  slashHelpNew: string;
  newChatDoneFmt: string;
  unknownCommandHint: string;
  connectError: string;
  agentDisconnected: string;
  notConnected: string;
  connected: string;
  trayShow: string;
  trayHide: string;
  trayQuit: string;
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
  modeCurrent: string;
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
  processSteps: string;
  /** 房间时间线过程卡：@%s · N 步 */
  processCardFmt: string;
  processRunning: string;
  processLoading: string;
  processUnavailable: string;
  /** 派发卡：已派发 %s 个子任务 */
  dispatchCardFmt: string;
  viewProcess: string;
  toolStatusPending: string;
  toolStatusInProgress: string;
  toolStatusCompleted: string;
  toolStatusFailed: string;
  toolStatusCancelled: string;
  finalSummary: string;
  summaryCompleted: string;
  summaryAdopted: string;
  summaryVerified: string;
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
  snapshotCurrentTrue: string;
  snapshotCurrentFalse: string;
  presetCheckRequested: string;
  checkUnapproved: string;
  checkCommandMismatch: string;
  backendStatusMissingCommand: string;
  backendStatusMissingExit: string;
  backendStatusNoRun: string;
  backendStatusUnknownExit: string;
  backendStatusMismatch: string;
  flowAwaitingInput: string;
  flowAcceptanceTitle: string;
  flowAcceptanceCaution: string;
  clarificationPending: string;
  clarificationReply: string;
  clarificationReplying: string;
  clarificationSupplementHint: string;
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
  approvalNotificationFmt: string;
  elicitationNotificationFmt: string;
  cmdContinue: string;
  cmdSummarize: string;
  cmdRunTests: string;
  resumeFailed: string;
  quoteHeaderFmt: string;
  imageMessage: string;
  roomModelHint: string;
  memberNotFoundFmt: string;
  modelSwitchedForFmt: string;
  deleteFailedFmt: string;
  clearFailedFmt: string;
  renameFailedFmt: string;
  statusOnline: string;
  statusOffline: string;
  statusBusy: string;
  statusPinned: string;
  statusArchived: string;
  groupByNone: string;
  groupByAgent: string;
  groupByCwd: string;
  groupByMode: string;
  modeMention: string;
  modeConductor: string;
  modeRoundRobin: string;
  modeParallel: string;
  modePipeline: string;
  modeDebate: string;
  modeAuto: string;
  searchChipFmt: string;
  groupByChipFmt: string;
  archivedChipFmt: string;
  totalCountFmt: string;
  systemAuthor: string;
  batchDeleteConfirmFmt: string;
  expandSidebar: string;
  scheduledTasks: string;
  settings: string;
  backHome: string;
  collapseSidebar: string;
  searchAllPlaceholder: string;
  selectAll: string;
  invertSelection: string;
  selectedCountFmt: string;
  deleteLabel: string;
  exitLabel: string;
  sessionsLabel: string;
  filterTitle: string;
  newSessionTitle: string;
  noSessions: string;
  roomsLabel: string;
  newRoomTitle: string;
  noRooms: string;
  exitBatch: string;
  batchManage: string;
  refreshTitle: string;
  themeTitleFmt: string;
  themeSystem: string;
  themeLight: string;
  themeDark: string;
  clickToConfigHub: string;
  noSavedHubs: string;
  manageHubsTitle: string;
  disconnectCurrent: string;
  busyTag: string;
  pinTitle: string;
  unpinTitle: string;
  renameTitle: string;
  cloneTitle: string;
  archiveTitle: string;
  unarchiveTitle: string;
  archivedGroupFmt: string;
  dateToday: string;
  dateYesterday: string;
  resumeTitle: string;
  editRoomTitle: string;
  copySuffixFmt: string;
  noResults: string;
  sessionsCountFmt: string;
  roomsCountFmt: string;
  historyCountFmt: string;
  groupBySection: string;
  statusSectionLabel: string;
  cwdSection: string;
  modeSection: string;
  sessionFilterPlaceholder: string;
  roomFilterPlaceholder: string;
  resetLabel: string;
  nameLabel: string;
  connectionLabel: string;
  pleaseSelect: string;
  localTag: string;
  roleLabel: string;
  optionalLabel: string;
  builtinTag: string;
  cancelLabel: string;
  createLabel: string;
  hubTagline: string;
  editHubConfig: string;
  addConnectHub: string;
  hubNamePlaceholder: string;
  hubAddressLabel: string;
  hubAddressPlaceholder: string;
  cancelEdit: string;
  connectingLabel: string;
  saveAndConnect: string;
  addAndConnect: string;
  savedHubs: string;
  remoteWss: string;
  lanLabel: string;
  editTitle: string;
  connectTitle: string;
  rmMentionLabel: string;
  rmMentionDesc: string;
  rmConductorLabel: string;
  rmConductorDesc: string;
  rmRoundrobinLabel: string;
  rmRoundrobinDesc: string;
  rmParallelLabel: string;
  rmParallelDesc: string;
  rmPipelineLabel: string;
  rmPipelineDesc: string;
  rmDebateLabel: string;
  rmDebateDesc: string;
  rmAutoLabel: string;
  rmAutoDesc: string;
  conductorLabel: string;
  moderatorLabel: string;
  firstSpeakerLabel: string;
  summarizerLabel: string;
  judgeLabel: string;
  pipelineOrderLabel: string;
  proSideLabel: string;
  conSideLabel: string;
  roundsLabel: string;
  pickMembersLabel: string;
  defaultRoleLabel: string;
  saveLabel: string;
  greetingLate: string;
  greetingMorning: string;
  greetingAfternoon: string;
  greetingEvening: string;
  connectedToFmt: string;
  homePickHint: string;
  newSessionDesc: string;
  newRoomDesc: string;
  agentSources: string;
  agentSourcesDesc: string;
  refreshStatus: string;
  refreshStatusDesc: string;
  recentSessions: string;
  shortcutSearch: string;
  shortcutNewSession: string;
  shortcutChatSearch: string;
  shortcutBackHome: string;
  pickFileTitle: string;
  searchFilesPlaceholder: string;
  rootDirLabel: string;
  loadingDots: string;
  noMatchFiles: string;
  dirEmpty: string;
  hintSelect: string;
  hintConfirm: string;
  hintClose: string;
  hintBack: string;
  loadFailedFmt: string;
  readFailedFmt: string;
  confirmDeleteFileFmt: string;
  renameToPrompt: string;
  projectFiles: string;
  goUpLabel: string;
  enterLabel: string;
  previewLabel: string;
  downloadLabel: string;
  quoteToInput: string;
  settingsTitle: string;
  generalTab: string;
  rolesTab: string;
  disconnectLabel: string;
  themeSection: string;
  themeDesc: string;
  langSection: string;
  langDesc: string;
  sendKeySection: string;
  sendKeyDesc: string;
  sendKeyEnter: string;
  sendKeyCtrlEnter: string;
  bypassSection: string;
  bypassDesc: string;
  onLabel: string;
  offLabel: string;
  aboutSection: string;
  aboutDescFmt: string;
  openRepo: string;
  addAgentSource: string;
  shareConnectTitle: string;
  shareConnectHint: string;
  lanCardTitle: string;
  gatewayCardTitle: string;
  gatewayNotReady: string;
  copyUriLabel: string;
  remoteBackendTitle: string;
  remoteBackendHint: string;
  genJoinCmd: string;
  joinCmdReady: string;
  connectInfoError: string;
  lanLocalOnly: string;
  lastSeenFmt: string;
  typeLabel: string;
  localStartLabel: string;
  noLabel: string;
  yesLabel: string;
  startFailed: string;
  localLaunch: string;
  startFailedFmt: string;
  copyToken: string;
  addRole: string;
  personaLabel: string;
  builtinBadge: string;
  defaultCwdFmt: string;
  schedDailyFmt: string;
  schedIntervalFmt: string;
  schedOnceFmt: string;
  scheduledTasksTitle: string;
  taskLogsTitle: string;
  backLabel: string;
  noTasksHint: string;
  enabledLabel: string;
  disabledLabel: string;
  targetRowFmt: string;
  scheduleRowFmt: string;
  messageRowFmt: string;
  nextRunFmt: string;
  lastRunFmt: string;
  errorRowFmt: string;
  createTask: string;
  editTask: string;
  clearLogsTitle: string;
  noLogs: string;
  taskNamePlaceholder: string;
  targetTypeLabel: string;
  sessionSingleLabel: string;
  targetLabel: string;
  messageContentLabel: string;
  messagePlaceholder: string;
  scheduleModeLabel: string;
  simpleModeLabel: string;
  cronModeLabel: string;
  repeatLabel: string;
  dailyOpt: string;
  intervalOpt: string;
  onceOpt: string;
  timeLabel: string;
  intervalMinLabel: string;
  runAtLabel: string;
  cronExprLabel: string;
  cronPlaceholder: string;
  cronSyntaxTitle: string;
  cronHelpTitle: string;
  cronFormatLine: string;
  cronFieldMin: string;
  cronFieldHour: string;
  cronFieldDay: string;
  cronFieldMonth: string;
  cronFieldWeek: string;
  cronSundayLabel: string;
  cronSupportPrefix: string;
  cronAny: string;
  cronStep: string;
  cronRange: string;
  cronList: string;
  cronExamplesTitle: string;
  cronExDaily9: string;
  cronExWeekday9: string;
  cronExEvery30m: string;
  cronExEvery2h: string;
  cronExDaily9And18: string;
  cronExSunday0: string;
  cronExMonthly1st: string;
  cronExFirstMonday: string;
  chatFallback: string;
  modeSelfLabel: string;
  modeDecidingLabel: string;
  prevMatchTitle: string;
  nextMatchTitle: string;
  closeEscTitle: string;
  searchChatTitle: string;
  filesPanelTitle: string;
  contextPanelTitle: string;
  switchModelTitle: string;
  memberModelsLabel: string;
  modelFallback: string;
  loadMoreHistory: string;
  backToBottom: string;
  helpAskFmt: string;
  helpNeededFallback: string;
  helpBannerHint: string;
  answerLabel: string;
  replyHelpFmt: string;
  cancelReplyTitle: string;
  quoteLineFmt: string;
  cancelQuoteTitle: string;
  commandsGroupLabel: string;
  sendMergeTitleFmt: string;
  sendQueueTitleFmt: string;
  scopeOnce: string;
  scopeTask: string;
  scopeAlways: string;
  decisionRevoke: string;
  presenceOnline: string;
  presenceGenerating: string;
  presenceOffline: string;
  followUpQueuedHint: string;
  stopGenerateTitle: string;
  sendTitleFmt: string;
  saveAsCommand: string;
  quickCommandsTitle: string;
  pickFileRefTitle: string;
  addImageTitle: string;
  flowCountFmt: string;
  blackboardCountFmt: string;
  artifactCountFmt: string;
  eventCountFmt: string;
  closePanelTitle: string;
  binaryFileLabel: string;
  meLabel: string;
  answeredFmt: string;
  multiValuePlaceholder: string;
  selectOptionParen: string;
  submittedLabel: string;
  declinedStatus: string;
  cancelledStatus: string;
  submittingLabel: string;
  submitLabel: string;
  declineLabel: string;
  noBoardEntries: string;
  confirmClearBoard: string;
  confirmDeleteBoard: string;
  blackboardLabel: string;
  clearLabel: string;
  boardSummaryTitle: string;
  quoteLabel: string;
  flowTitleConductor: string;
  flowTitleDefault: string;
  phasePlanning: string;
  phaseWorking: string;
  phaseReviewing: string;
  phaseSummarizing: string;
  phaseAwaitingRetry: string;
  phaseDone: string;
  supplementLabel: string;
  collapseToggleTitle: string;
  progressFmt: string;
  failedSuffixFmt: string;
  abortFlowTitle: string;
  confirmAbortFlow: string;
  abortLabel: string;
  phaseCancelled: string;
  elapsedSecFmt: string;
  elapsedMinFmt: string;
  elapsedHourFmt: string;
  flowElapsedFmt: string;
  flowInterruptedRetry: string;
  flowStripLocate: string;
  flowStripExpand: string;
  flowWaitingUser: string;
  retryAllFailed: string;
  flowCardPendingFmt: string;
  previewFailedFmt: string;
  downloadFailedFmt: string;
  confirmDeleteArtifactsFmt: string;
  confirmClearArtifacts: string;
  confirmDeleteArtifactFmt: string;
  manageLabel: string;
  deleteSelected: string;
  doneLabel: string;
  itemsCountFmt: string;
  noArtifacts: string;
  artifactsLabel: string;
  confirmDeleteEventsFmt: string;
  allLabel: string;
  confirmClearEventsFmt: string;
  confirmDeleteEventFmt: string;
  clearEventTypeTitle: string;
  clearAllEvents: string;
  clearOnlyFmt: string;
  bracketNameFmt: string;
  noEvents: string;
  eventsLabel: string;
  eventActionDelete: string;
  eventActionRename: string;
  eventActionCommand: string;
  eventActionTest: string;
  eventActionAdd: string;
  eventActionModify: string;
  eventActionDefault: string;
  copiedPathFmt: string;
  customOpt: string;
  quotaToday: string;
  quotaWeek: string;
  devinQuotaLabel: string;
  quotaResetFmt: string;
}

const zh: Strings = {
  bypassEnabled: "已开启审批自动通过",
  bypassDisabled: "已关闭审批自动通过",
  slashHelpTitle: "可用指令：",
  slashHelpHelp: "/help — 显示帮助",
  slashHelpStop: "/stop — 停止当前生成",
  slashHelpBypass: "/bypass [on|off] — 切换审批自动通过",
  slashHelpModel: "/model [模型] — 切换模型",
  slashHelpNew: "/new — 新建对话/群聊并重置上下文（旧的自动归档）",
  newChatDoneFmt: "已切换到新会话 %s，原会话已归档",
  unknownCommandHint: "未知指令，输入 /help 查看可用指令",
  connectError: "连接失败",
  agentDisconnected: "连接已断开",
  notConnected: "未连接",
  connected: "已连接",
  trayShow: "显示窗口",
  trayHide: "隐藏窗口",
  trayQuit: "退出",
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
  modeCurrent: "当前：%s",
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
  processSteps: "执行过程（%s 步）",
  processCardFmt: "@%s · 执行过程（%s 步）",
  processRunning: "进行中…",
  processLoading: "加载过程…",
  processUnavailable: "过程不可用（会话已失效或 Hub 不支持）",
  dispatchCardFmt: "已派发 %s 个子任务",
  viewProcess: "查看过程",
  toolStatusPending: "排队中",
  toolStatusInProgress: "进行中",
  toolStatusCompleted: "已完成",
  toolStatusFailed: "失败",
  toolStatusCancelled: "已取消",
  finalSummary: "最终总结",
  summaryCompleted: "%s/%s 任务已完成",
  summaryAdopted: "已采纳 %s 条用户补充",
  summaryVerified: "已记录 %s 条独立验证",
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
  snapshotCurrentTrue: "与当前工作区快照一致",
  snapshotCurrentFalse: "仅对应历史快照：当前工作区已变化或无法核对，不能证明当前版本通过",
  presetCheckRequested: "请求的预设检查 ID：%s",
  checkUnapproved: "未配置或未批准此检查 ID",
  checkCommandMismatch: "成员命令与预设检查不一致",
  backendStatusMissingCommand: "成员未提供验证命令",
  backendStatusMissingExit: "成员未提供退出码",
  backendStatusNoRun: "没有完成的后端工具记录",
  backendStatusUnknownExit: "后端未提供结构化退出码",
  backendStatusMismatch: "后端命令、退出码或输出与成员报告不一致",
  flowAwaitingInput: "待确认",
  flowAcceptanceTitle: "验收标准",
  flowAcceptanceCaution: "任务完成数不代表验收通过；请核对下方证据。",
  clarificationPending: "指挥家需要你确认以下问题后再派工（点「答复」可自由填写其他方案）：",
  clarificationReply: "答复",
  clarificationReplying: "答复指挥家的确认问题",
  clarificationSupplementHint: "直接发送并入补充",
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
  approvalNotificationFmt: "审批请求 · %s",
  elicitationNotificationFmt: "输入请求 · %s",
  cmdContinue: "继续",
  cmdSummarize: "总结目前的进展，列出下一步计划",
  cmdRunTests: "运行项目的测试并修复所有失败",
  resumeFailed: "恢复失败：agent 不支持或会话已失效",
  quoteHeaderFmt: "（引用 %s 的消息：\"%s\"）",
  imageMessage: "（图片）",
  roomModelHint: "群聊中切换模型请指定成员：/model @成员名 模型名",
  memberNotFoundFmt: "未找到成员 @%s",
  modelSwitchedForFmt: "@%s 模型已切换为 %s",
  deleteFailedFmt: "删除失败：%s",
  clearFailedFmt: "清空失败：%s",
  renameFailedFmt: "重命名失败：%s",
  statusOnline: "在线",
  statusOffline: "离线",
  statusBusy: "忙碌",
  statusPinned: "置顶",
  statusArchived: "归档",
  groupByNone: "不分组",
  groupByAgent: "按 Agent",
  groupByCwd: "按目录",
  groupByMode: "按模式",
  modeMention: "普通群",
  modeConductor: "指挥家",
  modeRoundRobin: "轮询",
  modeParallel: "并行",
  modePipeline: "流水线",
  modeDebate: "辩论",
  modeAuto: "自动",
  searchChipFmt: "搜索: %s",
  groupByChipFmt: "分组: %s",
  archivedChipFmt: "归档 (%s)",
  totalCountFmt: "共 %s 条",
  systemAuthor: "系统",
  batchDeleteConfirmFmt: "确认删除选中的 %s 个会话和 %s 个群？此操作不可撤销。",
  expandSidebar: "展开侧栏",
  scheduledTasks: "定时任务",
  settings: "设置",
  backHome: "返回首页",
  collapseSidebar: "收起侧栏",
  searchAllPlaceholder: "搜索会话、群聊、消息…",
  selectAll: "全选",
  invertSelection: "反选",
  selectedCountFmt: "已选 %s",
  deleteLabel: "删除",
  exitLabel: "退出",
  sessionsLabel: "会话",
  filterTitle: "筛选",
  newSessionTitle: "新建会话 (Ctrl+N)",
  noSessions: "暂无会话",
  roomsLabel: "群聊",
  newRoomTitle: "新建群聊",
  noRooms: "暂无群聊",
  exitBatch: "退出批量管理",
  batchManage: "批量管理",
  refreshTitle: "刷新",
  themeTitleFmt: "主题：%s（点击切换）",
  themeSystem: "跟随系统",
  themeLight: "浅色",
  themeDark: "深色",
  clickToConfigHub: "点击配置 Hub",
  noSavedHubs: "暂无保存的 Hub",
  manageHubsTitle: "添加 / 管理 Hub",
  disconnectCurrent: "断开当前连接",
  busyTag: "执行中",
  pinTitle: "置顶",
  unpinTitle: "取消置顶",
  renameTitle: "重命名",
  cloneTitle: "克隆",
  archiveTitle: "归档",
  unarchiveTitle: "取消归档",
  archivedGroupFmt: "已归档（%s）",
  dateToday: "今天",
  dateYesterday: "昨天",
  resumeTitle: "恢复",
  editRoomTitle: "编辑群聊",
  copySuffixFmt: "%s (副本)",
  noResults: "无结果",
  sessionsCountFmt: "会话 (%s)",
  roomsCountFmt: "群聊 (%s)",
  historyCountFmt: "历史消息 (%s)",
  groupBySection: "分组",
  statusSectionLabel: "状态",
  cwdSection: "工作目录",
  modeSection: "模式",
  sessionFilterPlaceholder: "按名称、目录或 Agent 过滤…",
  roomFilterPlaceholder: "按名称、成员或模式过滤…",
  resetLabel: "重置",
  nameLabel: "名称",
  connectionLabel: "连接",
  pleaseSelect: "请选择",
  localTag: "本机",
  roleLabel: "角色",
  optionalLabel: "可选",
  builtinTag: "(内置)",
  cancelLabel: "取消",
  createLabel: "创建",
  hubTagline: "连接一个 Hub，统一调度你的所有 Agent",
  editHubConfig: "编辑 Hub 配置",
  addConnectHub: "添加 / 连接 Hub",
  hubNamePlaceholder: "例如 本机 / 公网 VPS",
  hubAddressLabel: "地址",
  hubAddressPlaceholder: "例如 localhost:8787 或 wss://hub.example.com",
  cancelEdit: "取消编辑",
  connectingLabel: "连接中…",
  saveAndConnect: "保存并连接",
  addAndConnect: "添加并连接",
  savedHubs: "已保存的 Hub",
  remoteWss: "远程 (wss)",
  lanLabel: "局域网",
  editTitle: "编辑",
  connectTitle: "连接",
  rmMentionLabel: "普通群 (@mention / 广播)",
  rmMentionDesc: "成员自由发言，@某个成员时该成员单独回答。适合闲聊、快速提问。",
  rmConductorLabel: "指挥家（拆解派工汇总）",
  rmConductorDesc: "指挥家自动拆解任务，派发给不同成员并行执行，最后汇总结果。适合复杂任务。",
  rmRoundrobinLabel: "轮询（轮流作答）",
  rmRoundrobinDesc: "每个问题按顺序由一个成员回答，可设置起始发言人。适合多角色依次表态。",
  rmParallelLabel: "并行（集思广益 + 汇总）",
  rmParallelDesc: "所有成员同时回答同一个问题，最后由汇总者综合出一致结论。适合头脑风暴。",
  rmPipelineLabel: "流水线（按成员顺序串行）",
  rmPipelineDesc: "成员按指定顺序串行处理，后一个成员基于前一个的结果继续。适合多步骤流程。",
  rmDebateLabel: "辩论（正反方 + 裁判）",
  rmDebateDesc: "正方与反方交替辩论若干轮，最后由裁判给出公正总结。适合观点碰撞。",
  rmAutoLabel: "自动（由主持人选择模式）",
  rmAutoDesc: "主持人根据任务内容自动选择最合适的协作模式。不确定选哪个时可用。",
  conductorLabel: "指挥家",
  moderatorLabel: "主持人",
  firstSpeakerLabel: "起始发言人",
  summarizerLabel: "汇总者",
  judgeLabel: "裁判",
  pipelineOrderLabel: "执行顺序",
  proSideLabel: "正方",
  conSideLabel: "反方",
  roundsLabel: "轮数",
  pickMembersLabel: "选择成员与角色",
  defaultRoleLabel: "默认（无角色卡）",
  saveLabel: "保存",
  greetingLate: "夜深了",
  greetingMorning: "早上好",
  greetingAfternoon: "下午好",
  greetingEvening: "晚上好",
  connectedToFmt: "已连接到 %s · %s",
  homePickHint: "选择一个会话开始工作，或创建新的协作",
  newSessionDesc: "与单个 Agent 开始一对一任务",
  newRoomDesc: "多个 Agent 协作：指挥家 / 辩论 / 流水线…",
  agentSources: "Agent 来源",
  agentSourcesDesc: "管理本地与远程 Agent 连接",
  refreshStatus: "刷新状态",
  refreshStatusDesc: "同步会话、群聊与 Agent 最新状态",
  recentSessions: "最近会话",
  shortcutSearch: "搜索",
  shortcutNewSession: "新建会话",
  shortcutChatSearch: "聊天内搜索",
  shortcutBackHome: "返回首页",
  pickFileTitle: "选择文件",
  searchFilesPlaceholder: "搜索文件...",
  rootDirLabel: "根目录",
  loadingDots: "加载中...",
  noMatchFiles: "未找到匹配的文件",
  dirEmpty: "此目录为空",
  hintSelect: "↑↓ 选择",
  hintConfirm: "Enter 确认",
  hintClose: "Esc 关闭",
  hintBack: "Backspace 返回",
  loadFailedFmt: "加载失败：%s",
  readFailedFmt: "读取失败：%s",
  confirmDeleteFileFmt: "确认删除文件？\n%s",
  renameToPrompt: "重命名为",
  projectFiles: "项目文件",
  goUpLabel: "返回上级",
  enterLabel: "进入",
  previewLabel: "预览",
  downloadLabel: "下载",
  quoteToInput: "引用到输入框",
  settingsTitle: "设置",
  generalTab: "通用",
  rolesTab: "角色",
  disconnectLabel: "断开连接",
  themeSection: "主题",
  themeDesc: "界面外观，默认跟随系统",
  langSection: "语言",
  langDesc: "界面语言",
  sendKeySection: "发送快捷键",
  sendKeyDesc: "发送消息的快捷键",
  sendKeyEnter: "Enter 发送",
  sendKeyCtrlEnter: "Ctrl+Enter 发送",
  bypassSection: "权限绕过",
  bypassDesc: "开启后自动审批工具调用请求",
  onLabel: "开启",
  offLabel: "关闭",
  aboutSection: "关于",
  aboutDescFmt: "Agent Hub 桌面端 · 版本 %s",
  openRepo: "打开仓库",
  addAgentSource: "＋ 添加 Agent 来源",
  shareConnectTitle: "分享连接",
  shareConnectHint: "扫码或复制链接，即可让其他设备接入本 Hub",
  lanCardTitle: "局域网直连",
  gatewayCardTitle: "远程接入 (Gateway)",
  gatewayNotReady: "暂未上报 Gateway 接入点",
  copyUriLabel: "复制链接",
  remoteBackendTitle: "远程后端接入",
  remoteBackendHint: "生成接入命令，在远程机器上执行即可挂入本 Hub",
  genJoinCmd: "生成接入命令",
  joinCmdReady: "复制后在远程机器终端执行",
  connectInfoError: "获取连接信息失败",
  lanLocalOnly: "仅本机可见",
  lastSeenFmt: "最近在线 %s",
  typeLabel: "类型",
  localStartLabel: "本地启动",
  noLabel: "否",
  yesLabel: "是",
  startFailed: "启动失败",
  localLaunch: "本地直接启动",
  startFailedFmt: "启动失败: %s",
  copyToken: "复制 Token",
  addRole: "＋ 添加角色",
  personaLabel: "人设",
  builtinBadge: "内置",
  defaultCwdFmt: "默认目录: %s",
  schedDailyFmt: "每天 %s",
  schedIntervalFmt: "每 %s 分钟",
  schedOnceFmt: "一次性 %s",
  scheduledTasksTitle: "定时任务",
  taskLogsTitle: "执行日志",
  backLabel: "返回",
  noTasksHint: "暂无定时任务。点击下方按钮创建一个，例如“每天 9 点发送最新天气”。",
  enabledLabel: "启用",
  disabledLabel: "禁用",
  targetRowFmt: "目标：%s · %s",
  scheduleRowFmt: "调度：%s",
  messageRowFmt: "消息：%s",
  nextRunFmt: "下次执行：%s",
  lastRunFmt: "上次执行：%s",
  errorRowFmt: "错误：%s",
  createTask: "创建定时任务",
  editTask: "编辑定时任务",
  clearLogsTitle: "清空日志",
  noLogs: "暂无执行记录。",
  taskNamePlaceholder: "如：每日天气",
  targetTypeLabel: "目标类型",
  sessionSingleLabel: "会话（单聊）",
  targetLabel: "目标",
  messageContentLabel: "消息内容",
  messagePlaceholder: "如：给我发送最新天气",
  scheduleModeLabel: "调度模式",
  simpleModeLabel: "简易模式",
  cronModeLabel: "高级模式（Cron）",
  repeatLabel: "重复方式",
  dailyOpt: "每天",
  intervalOpt: "间隔",
  onceOpt: "一次性",
  timeLabel: "时间",
  intervalMinLabel: "间隔（分钟）",
  runAtLabel: "执行时间",
  cronExprLabel: "Cron 表达式",
  cronPlaceholder: "分 时 日 月 周，如 0 9 * * *",
  cronSyntaxTitle: "Cron 语法说明",
  cronHelpTitle: "Cron 表达式说明",
  cronFormatLine: "格式：",
  cronFieldMin: "分",
  cronFieldHour: "时",
  cronFieldDay: "日",
  cronFieldMonth: "月",
  cronFieldWeek: "周",
  cronSundayLabel: "周日",
  cronSupportPrefix: "支持",
  cronAny: "任意",
  cronStep: "步长",
  cronRange: "范围",
  cronList: "列表",
  cronExamplesTitle: "常用示例（点击使用）：",
  cronExDaily9: "每天 9:00",
  cronExWeekday9: "工作日 9:00",
  cronExEvery30m: "每 30 分钟",
  cronExEvery2h: "每 2 小时",
  cronExDaily9And18: "每天 9:00 和 18:00",
  cronExSunday0: "每周日 0:00",
  cronExMonthly1st: "每月 1 号 0:00",
  cronExFirstMonday: "每月第一个周一 9:00",
  chatFallback: "聊天",
  modeSelfLabel: "自己",
  modeDecidingLabel: "决策中",
  prevMatchTitle: "上一个 (Shift+Enter)",
  nextMatchTitle: "下一个 (Enter)",
  closeEscTitle: "关闭 (Esc)",
  searchChatTitle: "搜索聊天内容 (Ctrl+F)",
  filesPanelTitle: "项目文件 (Ctrl+Shift+F)",
  contextPanelTitle: "任务 / 产物 / 事件面板",
  switchModelTitle: "切换模型",
  memberModelsLabel: "成员模型",
  modelFallback: "模型",
  loadMoreHistory: "加载更多历史…",
  backToBottom: "回到底部",
  helpAskFmt: "@%s 在任务 %s 向你求助：",
  helpNeededFallback: "需要你的回复",
  helpBannerHint: "直接发送并入补充",
  answerLabel: "答复",
  replyHelpFmt: "答复 @%s 的求助（任务 %s）：",
  cancelReplyTitle: "取消答复，消息将作为补充发送",
  quoteLineFmt: "引用 @%s: %s",
  cancelQuoteTitle: "取消引用",
  commandsGroupLabel: "命令",
  sendMergeTitleFmt: "发送 (%s) — 并入当前流程",
  sendQueueTitleFmt: "发送 (%s) — 排队，回合结束后自动发送",
  scopeOnce: "仅本次",
  scopeTask: "本次任务",
  scopeAlways: "始终",
  decisionRevoke: "撤销授权",
  presenceOnline: "在线",
  presenceGenerating: "生成中",
  presenceOffline: "离线",
  followUpQueuedHint: "已排队，回合结束后按序发送",
  stopGenerateTitle: "停止生成",
  sendTitleFmt: "发送 (%s)",
  saveAsCommand: "保存当前输入为指令",
  quickCommandsTitle: "快捷指令",
  pickFileRefTitle: "选择文件引用 (#)",
  addImageTitle: "添加图片",
  flowCountFmt: "任务编排 · %s 项",
  blackboardCountFmt: "共享黑板 · %s 条",
  artifactCountFmt: "产物 · %s 条",
  eventCountFmt: "事件 · %s 条",
  closePanelTitle: "关闭面板 (Esc)",
  binaryFileLabel: "二进制文件",
  meLabel: "我",
  answeredFmt: "已选择: %s",
  multiValuePlaceholder: "逗号分隔多个值",
  selectOptionParen: "（请选择）",
  submittedLabel: "已提交",
  declinedStatus: "已拒绝",
  cancelledStatus: "已取消",
  submittingLabel: "提交中…",
  submitLabel: "提交",
  declineLabel: "拒绝",
  noBoardEntries: "暂无黑板摘要",
  confirmClearBoard: "确认清空全部黑板摘要？",
  confirmDeleteBoard: "确认删除这条黑板摘要？",
  blackboardLabel: "黑板",
  clearLabel: "清空",
  boardSummaryTitle: "黑板摘要",
  quoteLabel: "引用",
  flowTitleConductor: "指挥编排",
  flowTitleDefault: "编排进度",
  phasePlanning: "规划中",
  phaseWorking: "执行中",
  phaseReviewing: "验收中",
  phaseSummarizing: "汇总中",
  phaseAwaitingRetry: "等待重试",
  phaseDone: "已完成",
  supplementLabel: "补充",
  collapseToggleTitle: "点击折叠/展开",
  progressFmt: "%s/%s 完成 · %s 进行中 · %s 待执行",
  failedSuffixFmt: " · %s 失败",
  abortFlowTitle: "中断当前编排",
  confirmAbortFlow: "确认中断当前编排？所有进行中的任务将被取消。",
  abortLabel: "中断",
  phaseCancelled: "已中断",
  elapsedSecFmt: "%s 秒",
  elapsedMinFmt: "%s 分 %s 秒",
  elapsedHourFmt: "%s 小时 %s 分",
  flowElapsedFmt: "用时 %s",
  flowInterruptedRetry: "已中断 · 可重试",
  flowStripLocate: "定位到编排卡",
  flowStripExpand: "展开任务列表",
  flowWaitingUser: "等待你",
  retryAllFailed: "重试失败任务",
  flowCardPendingFmt: "%s 个任务待执行",
  previewFailedFmt: "预览失败：%s",
  downloadFailedFmt: "下载失败：%s",
  confirmDeleteArtifactsFmt: "确认删除选中的 %s 个产物？\n%s",
  confirmClearArtifacts: "确认清空全部产物？",
  confirmDeleteArtifactFmt: "确认删除产物 %s？",
  manageLabel: "管理",
  deleteSelected: "删除选中",
  doneLabel: "完成",
  itemsCountFmt: "%s 条",
  noArtifacts: "没有产物",
  artifactsLabel: "产物",
  confirmDeleteEventsFmt: "确认删除选中的 %s 条事件？",
  allLabel: "全部",
  confirmClearEventsFmt: "确认清空 %s 事件？",
  confirmDeleteEventFmt: "确认删除该事件？\n%s",
  clearEventTypeTitle: "选择要清空的事件类型",
  clearAllEvents: "清空全部",
  clearOnlyFmt: "仅清空「%s」",
  bracketNameFmt: "「%s」",
  noEvents: "没有事件",
  eventsLabel: "事件",
  eventActionDelete: "删除",
  eventActionRename: "重命名",
  eventActionCommand: "命令",
  eventActionTest: "测试",
  eventActionAdd: "新增",
  eventActionModify: "修改",
  eventActionDefault: "事件",
  copiedPathFmt: "已复制：%s",
  customOpt: "自定义",
  quotaToday: "今日已用",
  quotaWeek: "本周已用",
  devinQuotaLabel: "Devin 用量",
  quotaResetFmt: "重置 %s",
};

const en: Strings = {
  bypassEnabled: "Permission bypass enabled",
  bypassDisabled: "Permission bypass disabled",
  slashHelpTitle: "Available commands:",
  slashHelpHelp: "/help — show help",
  slashHelpStop: "/stop — stop current generation",
  slashHelpBypass: "/bypass [on|off] — toggle permission bypass",
  slashHelpModel: "/model [model] — switch model",
  slashHelpNew: "/new — start a fresh chat/room (the old one is archived)",
  newChatDoneFmt: "Switched to %s; the previous one was archived",
  unknownCommandHint: "Unknown command, type /help for available commands",
  connectError: "Connection failed",
  agentDisconnected: "Disconnected",
  notConnected: "Not connected",
  trayShow: "Show window",
  trayHide: "Hide window",
  trayQuit: "Quit",
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
  modeCurrent: "Now: %s",
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
  processSteps: "Process (%s steps)",
  processCardFmt: "@%s · Process (%s steps)",
  processRunning: "Running…",
  processLoading: "Loading process…",
  processUnavailable: "Process unavailable (session gone or unsupported)",
  dispatchCardFmt: "Dispatched %s subtasks",
  viewProcess: "View process",
  toolStatusPending: "Pending",
  toolStatusInProgress: "In progress",
  toolStatusCompleted: "Completed",
  toolStatusFailed: "Failed",
  toolStatusCancelled: "Cancelled",
  finalSummary: "Final summary",
  summaryCompleted: "%s/%s tasks completed",
  summaryAdopted: "Adopted %s user supplements",
  summaryVerified: "Recorded %s independent verifications",
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
  snapshotCurrentTrue: "Matches the current workspace snapshot",
  snapshotCurrentFalse: "Historical snapshot only: the workspace changed or cannot be checked; the current version is not verified",
  presetCheckRequested: "Requested preset check ID: %s",
  checkUnapproved: "Check ID is not configured or approved",
  checkCommandMismatch: "Member command differs from the preset check",
  backendStatusMissingCommand: "Member did not provide a verification command",
  backendStatusMissingExit: "Member did not provide an exit code",
  backendStatusNoRun: "No completed backend tool run",
  backendStatusUnknownExit: "Backend did not provide a structured exit code",
  backendStatusMismatch: "Backend command, exit code or output differs from the member report",
  flowAwaitingInput: "Awaiting input",
  flowAcceptanceTitle: "Acceptance criteria",
  flowAcceptanceCaution: "Completed tasks do not mean these criteria passed; review the evidence below.",
  clarificationPending: "The conductor needs your answers before dispatching (tap Answer to write any custom plan):",
  clarificationReply: "Answer",
  clarificationReplying: "Answering the conductor's questions",
  clarificationSupplementHint: "Send normally to add as a supplement",
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
  approvalNotificationFmt: "Approval request · %s",
  elicitationNotificationFmt: "Input request · %s",
  cmdContinue: "Continue",
  cmdSummarize: "Summarize progress and list next steps",
  cmdRunTests: "Run project tests and fix all failures",
  resumeFailed: "Resume failed: agent unsupported or session expired",
  quoteHeaderFmt: "(Quoting %s: \"%s\")",
  imageMessage: "(image)",
  roomModelHint: "In rooms, specify a member: /model @member model",
  memberNotFoundFmt: "Member @%s not found",
  modelSwitchedForFmt: "@%s model switched to %s",
  deleteFailedFmt: "Delete failed: %s",
  clearFailedFmt: "Clear failed: %s",
  renameFailedFmt: "Rename failed: %s",
  statusOnline: "Online",
  statusOffline: "Offline",
  statusBusy: "Busy",
  statusPinned: "Pinned",
  statusArchived: "Archived",
  groupByNone: "No grouping",
  groupByAgent: "By agent",
  groupByCwd: "By directory",
  groupByMode: "By mode",
  modeMention: "Mention",
  modeConductor: "Conductor",
  modeRoundRobin: "Round-robin",
  modeParallel: "Parallel",
  modePipeline: "Pipeline",
  modeDebate: "Debate",
  modeAuto: "Auto",
  searchChipFmt: "Search: %s",
  groupByChipFmt: "Group: %s",
  archivedChipFmt: "Archived (%s)",
  totalCountFmt: "%s total",
  systemAuthor: "System",
  batchDeleteConfirmFmt: "Delete %s selected sessions and %s rooms? This cannot be undone.",
  expandSidebar: "Expand sidebar",
  scheduledTasks: "Scheduled tasks",
  settings: "Settings",
  backHome: "Back to home",
  collapseSidebar: "Collapse sidebar",
  searchAllPlaceholder: "Search sessions, rooms, messages…",
  selectAll: "Select all",
  invertSelection: "Invert",
  selectedCountFmt: "%s selected",
  deleteLabel: "Delete",
  exitLabel: "Exit",
  sessionsLabel: "Sessions",
  filterTitle: "Filter",
  newSessionTitle: "New session (Ctrl+N)",
  noSessions: "No sessions",
  roomsLabel: "Rooms",
  newRoomTitle: "New room",
  noRooms: "No rooms",
  exitBatch: "Exit batch mode",
  batchManage: "Batch manage",
  refreshTitle: "Refresh",
  themeTitleFmt: "Theme: %s (click to switch)",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  clickToConfigHub: "Click to configure Hub",
  noSavedHubs: "No saved Hubs",
  manageHubsTitle: "Add / Manage Hubs",
  disconnectCurrent: "Disconnect",
  busyTag: "Running",
  pinTitle: "Pin",
  unpinTitle: "Unpin",
  renameTitle: "Rename",
  cloneTitle: "Clone",
  archiveTitle: "Archive",
  unarchiveTitle: "Unarchive",
  archivedGroupFmt: "Archived (%s)",
  dateToday: "Today",
  dateYesterday: "Yesterday",
  resumeTitle: "Resume",
  editRoomTitle: "Edit room",
  copySuffixFmt: "%s (copy)",
  noResults: "No results",
  sessionsCountFmt: "Sessions (%s)",
  roomsCountFmt: "Rooms (%s)",
  historyCountFmt: "History (%s)",
  groupBySection: "Group",
  statusSectionLabel: "Status",
  cwdSection: "Directory",
  modeSection: "Mode",
  sessionFilterPlaceholder: "Filter by name, directory or agent…",
  roomFilterPlaceholder: "Filter by name, member or mode…",
  resetLabel: "Reset",
  nameLabel: "Name",
  connectionLabel: "Connection",
  pleaseSelect: "Select…",
  localTag: "local",
  roleLabel: "Role",
  optionalLabel: "Optional",
  builtinTag: "(builtin)",
  cancelLabel: "Cancel",
  createLabel: "Create",
  hubTagline: "Connect to a Hub and orchestrate all your agents",
  editHubConfig: "Edit Hub config",
  addConnectHub: "Add / Connect Hub",
  hubNamePlaceholder: "e.g. Local / Public VPS",
  hubAddressLabel: "Address",
  hubAddressPlaceholder: "e.g. localhost:8787 or wss://hub.example.com",
  cancelEdit: "Cancel edit",
  connectingLabel: "Connecting…",
  saveAndConnect: "Save & connect",
  addAndConnect: "Add & connect",
  savedHubs: "Saved Hubs",
  remoteWss: "Remote (wss)",
  lanLabel: "LAN",
  editTitle: "Edit",
  connectTitle: "Connect",
  rmMentionLabel: "Plain group (@mention / broadcast)",
  rmMentionDesc: "Members speak freely; @a member makes only that member reply. Good for casual chat and quick questions.",
  rmConductorLabel: "Conductor (plan, dispatch, summarize)",
  rmConductorDesc: "The conductor breaks the task down, dispatches subtasks to members in parallel, then summarizes. Good for complex tasks.",
  rmRoundrobinLabel: "Round robin (take turns)",
  rmRoundrobinDesc: "Each question is answered by one member in order, with a configurable first speaker. Good for sequential statements.",
  rmParallelLabel: "Parallel (brainstorm + summarize)",
  rmParallelDesc: "All members answer the same question, then a summarizer merges the results. Good for brainstorming.",
  rmPipelineLabel: "Pipeline (serial by member order)",
  rmPipelineDesc: "Members process in a fixed order, each building on the previous result. Good for multi-step flows.",
  rmDebateLabel: "Debate (sides + judge)",
  rmDebateDesc: "Pro and con sides alternate for several rounds, then a judge summarizes fairly. Good for weighing options.",
  rmAutoLabel: "Auto (moderator picks the mode)",
  rmAutoDesc: "The moderator picks the most suitable collaboration mode for each task. Use when unsure which mode fits.",
  conductorLabel: "Conductor",
  moderatorLabel: "Moderator",
  firstSpeakerLabel: "First speaker",
  summarizerLabel: "Summarizer",
  judgeLabel: "Judge",
  pipelineOrderLabel: "Run order",
  proSideLabel: "Pro side",
  conSideLabel: "Con side",
  roundsLabel: "Rounds",
  pickMembersLabel: "Pick members & roles",
  defaultRoleLabel: "Default (no role card)",
  saveLabel: "Save",
  greetingLate: "Working late",
  greetingMorning: "Good morning",
  greetingAfternoon: "Good afternoon",
  greetingEvening: "Good evening",
  connectedToFmt: "Connected to %s · %s",
  homePickHint: "Pick a session to start working, or create a new collaboration",
  newSessionDesc: "Start a one-on-one task with a single agent",
  newRoomDesc: "Multi-agent collaboration: conductor / debate / pipeline…",
  agentSources: "Agent sources",
  agentSourcesDesc: "Manage local and remote agent connections",
  refreshStatus: "Refresh status",
  refreshStatusDesc: "Sync the latest sessions, rooms and agent states",
  recentSessions: "Recent sessions",
  shortcutSearch: "Search",
  shortcutNewSession: "New session",
  shortcutChatSearch: "Search in chat",
  shortcutBackHome: "Back home",
  pickFileTitle: "Pick a file",
  searchFilesPlaceholder: "Search files...",
  rootDirLabel: "Root",
  loadingDots: "Loading...",
  noMatchFiles: "No matching files",
  dirEmpty: "This directory is empty",
  hintSelect: "↑↓ Select",
  hintConfirm: "Enter Confirm",
  hintClose: "Esc Close",
  hintBack: "Backspace Back",
  loadFailedFmt: "Load failed: %s",
  readFailedFmt: "Read failed: %s",
  confirmDeleteFileFmt: "Delete this file?\n%s",
  renameToPrompt: "Rename to",
  projectFiles: "Project files",
  goUpLabel: "Go up",
  enterLabel: "Open",
  previewLabel: "Preview",
  downloadLabel: "Download",
  quoteToInput: "Quote into input",
  settingsTitle: "Settings",
  generalTab: "General",
  rolesTab: "Roles",
  disconnectLabel: "Disconnect",
  themeSection: "Theme",
  themeDesc: "Appearance, follows system by default",
  langSection: "Language",
  langDesc: "Interface language",
  sendKeySection: "Send shortcut",
  sendKeyDesc: "Keyboard shortcut to send messages",
  sendKeyEnter: "Enter to send",
  sendKeyCtrlEnter: "Ctrl+Enter to send",
  bypassSection: "Permission bypass",
  bypassDesc: "Auto-approve tool call requests when enabled",
  onLabel: "On",
  offLabel: "Off",
  aboutSection: "About",
  aboutDescFmt: "Agent Hub Desktop · v%s",
  openRepo: "Open repository",
  addAgentSource: "＋ Add agent source",
  shareConnectTitle: "Share connection",
  shareConnectHint: "Scan the QR or copy the link to connect another device to this hub",
  lanCardTitle: "LAN direct",
  gatewayCardTitle: "Remote access (Gateway)",
  gatewayNotReady: "No gateway endpoint reported yet",
  copyUriLabel: "Copy link",
  remoteBackendTitle: "Remote backend",
  remoteBackendHint: "Generate a join command and run it on the remote machine to attach it to this hub",
  genJoinCmd: "Generate join command",
  joinCmdReady: "Copy and run in the remote machine's terminal",
  connectInfoError: "Failed to load connection info",
  lanLocalOnly: "Visible on this device only",
  lastSeenFmt: "Last seen %s",
  typeLabel: "Type",
  localStartLabel: "Local launch",
  noLabel: "No",
  yesLabel: "Yes",
  startFailed: "Launch failed",
  localLaunch: "Launched locally",
  startFailedFmt: "Launch failed: %s",
  copyToken: "Copy token",
  addRole: "＋ Add role",
  personaLabel: "Persona",
  builtinBadge: "builtin",
  defaultCwdFmt: "Default dir: %s",
  schedDailyFmt: "Daily at %s",
  schedIntervalFmt: "Every %s min",
  schedOnceFmt: "Once at %s",
  scheduledTasksTitle: "Scheduled tasks",
  taskLogsTitle: "Run logs",
  backLabel: "Back",
  noTasksHint: "No scheduled tasks yet. Create one below, e.g. \"send me the latest weather at 9am every day\".",
  enabledLabel: "Enabled",
  disabledLabel: "Disabled",
  targetRowFmt: "Target: %s · %s",
  scheduleRowFmt: "Schedule: %s",
  messageRowFmt: "Message: %s",
  nextRunFmt: "Next run: %s",
  lastRunFmt: "Last run: %s",
  errorRowFmt: "Error: %s",
  createTask: "Create task",
  editTask: "Edit task",
  clearLogsTitle: "Clear logs",
  noLogs: "No run records yet.",
  taskNamePlaceholder: "e.g. Daily weather",
  targetTypeLabel: "Target type",
  sessionSingleLabel: "Session (1:1)",
  targetLabel: "Target",
  messageContentLabel: "Message",
  messagePlaceholder: "e.g. Send me the latest weather",
  scheduleModeLabel: "Schedule mode",
  simpleModeLabel: "Simple",
  cronModeLabel: "Advanced (Cron)",
  repeatLabel: "Repeat",
  dailyOpt: "Daily",
  intervalOpt: "Interval",
  onceOpt: "Once",
  timeLabel: "Time",
  intervalMinLabel: "Interval (minutes)",
  runAtLabel: "Run at",
  cronExprLabel: "Cron expression",
  cronPlaceholder: "min hour day month weekday, e.g. 0 9 * * *",
  cronSyntaxTitle: "Cron syntax",
  cronHelpTitle: "Cron expression help",
  cronFormatLine: "Format: ",
  cronFieldMin: "minute",
  cronFieldHour: "hour",
  cronFieldDay: "day",
  cronFieldMonth: "month",
  cronFieldWeek: "weekday",
  cronSundayLabel: "Sunday",
  cronSupportPrefix: "Supports",
  cronAny: "any",
  cronStep: "step",
  cronRange: "range",
  cronList: "list",
  cronExamplesTitle: "Common examples (click to use):",
  cronExDaily9: "Daily at 9:00",
  cronExWeekday9: "Weekdays at 9:00",
  cronExEvery30m: "Every 30 minutes",
  cronExEvery2h: "Every 2 hours",
  cronExDaily9And18: "Daily at 9:00 and 18:00",
  cronExSunday0: "Sundays at 0:00",
  cronExMonthly1st: "1st of each month at 0:00",
  cronExFirstMonday: "First Monday of month at 9:00",
  chatFallback: "Chat",
  modeSelfLabel: "Solo",
  modeDecidingLabel: "Deciding",
  prevMatchTitle: "Previous (Shift+Enter)",
  nextMatchTitle: "Next (Enter)",
  closeEscTitle: "Close (Esc)",
  searchChatTitle: "Search in chat (Ctrl+F)",
  filesPanelTitle: "Project files (Ctrl+Shift+F)",
  contextPanelTitle: "Tasks / artifacts / events panel",
  switchModelTitle: "Switch model",
  memberModelsLabel: "Member models",
  modelFallback: "Model",
  loadMoreHistory: "Loading more history…",
  backToBottom: "Back to bottom",
  helpAskFmt: "@%s asked for your help in task %s:",
  helpNeededFallback: "Your reply is needed",
  helpBannerHint: "Send directly to merge as supplement",
  answerLabel: "Reply",
  replyHelpFmt: "Reply to @%s's help request (task %s):",
  cancelReplyTitle: "Cancel reply; the message will be sent as a supplement",
  quoteLineFmt: "Quote @%s: %s",
  cancelQuoteTitle: "Cancel quote",
  commandsGroupLabel: "Commands",
  sendMergeTitleFmt: "Send (%s) — merge into current flow",
  sendQueueTitleFmt: "Send (%s) — queued, sends after this turn",
  scopeOnce: "Once",
  scopeTask: "This task",
  scopeAlways: "Always",
  decisionRevoke: "Revoke",
  presenceOnline: "Online",
  presenceGenerating: "Generating",
  presenceOffline: "Offline",
  followUpQueuedHint: "Queued — will send in order when idle",
  stopGenerateTitle: "Stop generating",
  sendTitleFmt: "Send (%s)",
  saveAsCommand: "Save current input as command",
  quickCommandsTitle: "Quick commands",
  pickFileRefTitle: "Pick file reference (#)",
  addImageTitle: "Add image",
  flowCountFmt: "Orchestration · %s tasks",
  blackboardCountFmt: "Blackboard · %s",
  artifactCountFmt: "Artifacts · %s",
  eventCountFmt: "Events · %s",
  closePanelTitle: "Close panel (Esc)",
  binaryFileLabel: "Binary file",
  meLabel: "You",
  answeredFmt: "Selected: %s",
  multiValuePlaceholder: "Comma-separated values",
  selectOptionParen: "(Select)",
  submittedLabel: "Submitted",
  declinedStatus: "Declined",
  cancelledStatus: "Cancelled",
  submittingLabel: "Submitting…",
  submitLabel: "Submit",
  declineLabel: "Decline",
  noBoardEntries: "No blackboard entries",
  confirmClearBoard: "Clear all blackboard entries?",
  confirmDeleteBoard: "Delete this blackboard entry?",
  blackboardLabel: "Blackboard",
  clearLabel: "Clear",
  boardSummaryTitle: "Blackboard entries",
  quoteLabel: "Quote",
  flowTitleConductor: "Conductor flow",
  flowTitleDefault: "Orchestration",
  phasePlanning: "Planning",
  phaseWorking: "Working",
  phaseReviewing: "Reviewing",
  phaseSummarizing: "Summarizing",
  phaseAwaitingRetry: "Awaiting retry",
  phaseDone: "Done",
  supplementLabel: "Supplement",
  collapseToggleTitle: "Click to collapse/expand",
  progressFmt: "%s/%s done · %s running · %s pending",
  failedSuffixFmt: " · %s failed",
  abortFlowTitle: "Abort current flow",
  confirmAbortFlow: "Abort the current orchestration? All running tasks will be cancelled.",
  abortLabel: "Abort",
  phaseCancelled: "Interrupted",
  elapsedSecFmt: "%ss",
  elapsedMinFmt: "%sm %ss",
  elapsedHourFmt: "%sh %sm",
  flowElapsedFmt: "took %s",
  flowInterruptedRetry: "Interrupted · retry available",
  flowStripLocate: "Locate flow card",
  flowStripExpand: "Expand task list",
  flowWaitingUser: "Waiting for you",
  retryAllFailed: "Retry failed tasks",
  flowCardPendingFmt: "%s pending",
  previewFailedFmt: "Preview failed: %s",
  downloadFailedFmt: "Download failed: %s",
  confirmDeleteArtifactsFmt: "Delete the %s selected artifacts?\n%s",
  confirmClearArtifacts: "Clear all artifacts?",
  confirmDeleteArtifactFmt: "Delete artifact %s?",
  manageLabel: "Manage",
  deleteSelected: "Delete selected",
  doneLabel: "Done",
  itemsCountFmt: "%s",
  noArtifacts: "No artifacts",
  artifactsLabel: "Artifacts",
  confirmDeleteEventsFmt: "Delete the %s selected events?",
  allLabel: "All",
  confirmClearEventsFmt: "Clear %s events?",
  confirmDeleteEventFmt: "Delete this event?\n%s",
  clearEventTypeTitle: "Choose which event type to clear",
  clearAllEvents: "Clear all",
  clearOnlyFmt: "Clear only \"%s\"",
  bracketNameFmt: "\"%s\"",
  noEvents: "No events",
  eventsLabel: "Events",
  eventActionDelete: "Delete",
  eventActionRename: "Rename",
  eventActionCommand: "Command",
  eventActionTest: "Test",
  eventActionAdd: "Add",
  eventActionModify: "Modify",
  eventActionDefault: "Event",
  copiedPathFmt: "Copied: %s",
  customOpt: "Custom",
  quotaToday: "Today",
  quotaWeek: "This week",
  devinQuotaLabel: "Devin usage",
  quotaResetFmt: "Resets %s",
};

export function stringsFor(lang: string): Strings {
  return lang === "zh" ? zh : en;
}

export function toolStatusLabel(S: Strings, status: string): string {
  switch (status) {
    case "pending": return S.toolStatusPending;
    case "in_progress": return S.toolStatusInProgress;
    case "completed": return S.toolStatusCompleted;
    case "failed": return S.toolStatusFailed;
    case "cancelled": return S.toolStatusCancelled;
    default: return status;
  }
}

const PLAN_STATUS_RE = /^\[(pending|in_progress|completed|failed|cancelled)\]\s*/;

export function planEntryLabel(S: Strings, entry: string): string {
  return entry.replace(PLAN_STATUS_RE, (_m, s: string) => `[${toolStatusLabel(S, s)}] `);
}
