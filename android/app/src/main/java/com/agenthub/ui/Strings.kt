package com.agenthub.ui

import androidx.compose.runtime.staticCompositionLocalOf

interface Strings {
    val appName: String
    val savedProfiles: String
    val lanTag: String
    val remoteTag: String
    val del: String
    val hubAddress: String
    val tokenLabel: String
    val gatewayTokenLabel: String
    val connect: String
    val searchHistory: String
    val searchConversations: String
    val searchAll: String
    val matchedSessions: String
    val matchedRooms: String
    val historyMessages: String
    val sessions: String
    val newSession: String
    val rooms: String
    val createRoom: String
    val archived: String
    val resume: String
    val offline: String
    val busyTag: String
    val noResults: String
    val singleChat: String
    val roomTag: String
    val systemTag: String
    val chooseAction: String
    val batchDelete: String
    val batchDeleteTitle: String
    val batchDeleteConfirm: String
    val selectAll: String
    val invertSelection: String
    val selectedCount: String
    val archive: String
    val unarchive: String
    val delete: String
    val cancel: String
    val ok: String
    val deleteConfirmTitle: String
    val deleteConfirmText: String
    val create: String
    val agentLabel: String
    val addressLabel: String
    val connectionLabel: String
    val addConnection: String
    val manageConnections: String
    val agentSources: String
    val online: String
    val connectionNoteLabel: String
    val tokenAuto: String
    val tokenManual: String
    val connectionNameLabel: String
    val localConnection: String
    val localLaunch: String
    val noConnections: String
    val selectConnection: String
    val nameLabel: String
    val cwdLabel: String
    val roomName: String
    val modeLabel: String
    val modeMention: String
    val modeConductor: String
    val modeRoundRobin: String
    val modeParallel: String
    val modePipeline: String
    val modeDebate: String
    val modeAuto: String
    val modeSelf: String
    val modeDeciding: String
    val modeCurrent: String
    val conductorTag: String
    val summarizerTag: String
    val judgeTag: String
    val sideProTag: String
    val sideConTag: String
    val hostTag: String
    val speakerTag: String
    val back: String
    val previous: String
    val next: String
    val generating: String
    val stop: String
    val quoting: String
    val copy: String
    val copyFull: String
    val selectText: String
    val copied: String
    val inputRoom: String
    val inputSingle: String
    val inputFlowActive: String
    val inputHelpReply: String
    val helpReplying: String
    val helpReplyAction: String
    val exitHelpReply: String
    val flowAwaitingInput: String
    val flowAcceptanceTitle: String
    val flowAcceptanceCaution: String
    val clarificationPending: String
    val clarificationReplying: String
    val send: String
    val queueCountFmt: String
    val queueClearHint: String
    val personaCardLabel: String
    val personaFieldPersona: String
    val personaFieldTone: String
    val personaFieldBoundaries: String
    val personaFieldExamples: String
    val aliasGroupTag: String
    val topicResolve: String
    val scanFromGallery: String
    val qrDecodeFailed: String
    val originLocal: String
    val originRemote: String
    val attachTypeNotAllowed: String
    val attachTooLarge: String
    val attachTooMany: String
    val attachTotalTooLarge: String
    val attachFailed: String
    val decisionScopeOnce: String
    val decisionScopeTask: String
    val decisionScopeAlways: String
    val decisionRevoke: String
    val decisionRevokeGrant: String
    val decisionRevoked: String
    val decisionExpired: String
    val decisionAuto: String
    val thought: String
    val thoughtOf: String
    val plan: String
    val processSteps: String
    val processCardFmt: String
    val processRunningHint: String
    val processUnavailable: String
    val processLoading: String
    val processEmpty: String
    val viewProcess: String
    val dispatchCollapsedFmt: String
    val finalSummary: String
    val summaryCompleted: String
    val summaryAdopted: String
    val summaryVerified: String
    val permissionRequest: String
    val chose: String
    val errorTag: String
    val nameExists: String
    val chat: String
    val settings: String
    val scheduledTasks: String
    val createTask: String
    val editTask: String
    val taskName: String
    val taskTarget: String
    val taskMessage: String
    val taskSchedule: String
    val scheduleSimple: String
    val scheduleCron: String
    val scheduleDaily: String
    val scheduleInterval: String
    val scheduleOnce: String
    val taskEnabled: String
    val noTasks: String
    val nextRun: String
    val lastRun: String
    val theme: String
    val themeSystem: String
    val themeLight: String
    val themeDark: String
    val language: String
    val roleLabel: String
    val noneRole: String
    val addRole: String
    val roleNameLabel: String
    val personaLabel: String
    val defaultCwdLabel: String
    val deleteRoleTitle: String
    val pin: String
    val unpin: String
    val filter: String
    val filterBy: String
    val groupBy: String
    val noGroup: String
    val byAgent: String
    val byCwd: String
    val byMode: String
    val statusOnline: String
    val statusOffline: String
    val statusBusy: String
    val statusPinned: String
    val statusArchived: String
    val quickCommands: String
    val saveCommand: String
    val bypassEnabled: String
    val bypassDisabled: String
    val keepAlive: String
    val keepAliveDesc: String
    val batteryOptimization: String
    val slashHelpTitle: String
    val slashHelpHelp: String
    val slashHelpStop: String
    val slashHelpBypass: String
    val slashHelpModel: String
    val slashHelpNew: String
    val newChatDoneFmt: String
    val modelListTitle: String
    val modelCurrentPrefix: String
    val modelSwitched: String
    val modelUnknown: String
    val modelListError: String
    val costTierFree: String
    val costTierLow: String
    val costTierMed: String
    val costTierHigh: String
    val modelFilterHint: String
    val modelNoResults: String
    val modelClearFilters: String
    val modelCurrentLabel: String
    val modelSessionConfig: String
    val unknownCommandHint: String
    val exit: String
    val exitConfirmTitle: String
    val exitConfirmText: String
    val about: String
    val version: String
    val repository: String
    val checkForUpdates: String
    val openInBrowser: String
    val copyLink: String
    val clone: String
    val clonedSession: String
    val rename: String
    val edit: String
    val editRoom: String
    val clonedRoom: String
    val deleteRoomConfirmTitle: String
    val deleteRoomConfirmText: String
    val tokenInput: String
    val tokenOutput: String
    val tokenCached: String
    val tokenCachedWrite: String
    val tokenThought: String
    val tokenTotal: String
    val context: String
    val contextMax: String
    val quotaDaily: String
    val quotaWeekly: String
    val verificationBy: String
    val verificationStatusLabel: String
    val verificationStatusUnverified: String
    val verificationStatusMemberPass: String
    val verificationStatusMemberNonpass: String
    val automaticCheckLabel: String
    val automaticCheckNotRun: String
    val automaticCheckExitedZero: String
    val automaticCheckExitedNonzero: String
    val automaticCheckBlocked: String
    val automaticCheckTimedOut: String
    val automaticCheckSnapshot: String
    val automaticCheckTruncated: String
    val memberReportedLabel: String
    val backendRunsLabel: String
    val backendRunCompleted: String
    val backendRunFailed: String
    val backendExitUnknown: String
    val backendClaimMatchLabel: String
    val backendVerificationCall: String
    val snapshotCurrentTrue: String
    val snapshotCurrentFalse: String
    val presetCheckRequested: String
    val checkUnapproved: String
    val checkCommandMismatch: String
    val backendStatusMissingCommand: String
    val backendStatusMissingExit: String
    val backendStatusNoRun: String
    val backendStatusUnknownExit: String
    val backendStatusMismatch: String
    val deliverableEvidence: String
    val evidenceSummaryLabel: String
    val evidenceCommandLabel: String
    val evidenceExitCodeLabel: String
    val verificationCommandLabel: String
    val verificationExitCodeSuffix: String
    val evidenceBaselineLabel: String
    val evidenceDiffLabel: String
    val evidenceStdoutLabel: String
    val evidenceStderrLabel: String
    val evidenceReproStepsLabel: String
    val dependsOnLabel: String
    val retryBadge: String
    val retryAction: String
    val waitingReply: String
    val you: String
    val actionCancel: String
    val actionDelete: String
    val actionClear: String
    val actionManage: String
    val actionClose: String
    val actionCopy: String
    val actionQuote: String
    val actionDownload: String
    val actionPreview: String
    val actionSubmit: String
    val actionDecline: String
    val itemCount: String
    val authorMe: String
    val fileLabel: String
    val loadMoreHistory: String
    val jumpToBottom: String
    val dateToday: String
    val dateYesterday: String
    val uploadImage: String
    val removeAttachment: String
    val multiSelect: String
    val elicitationTitle: String
    val outcomeAccepted: String
    val outcomeDeclined: String
    val outcomeCancelled: String
    val commaSeparatedHint: String
    val flowTitleConductor: String
    val flowTitleRoom: String
    val phasePlanning: String
    val phaseWorking: String
    val phaseReviewing: String
    val phaseSummarizing: String
    val phaseAwaitingRetry: String
    val phaseDone: String
    val phaseCancelled: String
    val elapsedSecFmt: String
    val elapsedMinFmt: String
    val elapsedHourFmt: String
    val flowElapsedFmt: String
    val flowInterruptedRetry: String
    val retryAllFailed: String
    val flowCardPendingFmt: String
    val helpWanted: String
    val flowProgressFmt: String
    val flowProgressFailed: String
    val flowTasksTitle: String
    val interruptFlow: String
    val supplementCount: String
    val capsuleBlackboard: String
    val capsuleArtifact: String
    val capsuleEvent: String
    val artifactsTitle: String
    val eventsTitle: String
    val sharedBlackboard: String
    val deleteSelectedCount: String
    val clearAll: String
    val clearActionOnly: String
    val quotedToast: String
    val copiedToast: String
    val deleteArtifactTitle: String
    val deleteArtifactMsg: String
    val clearArtifactsTitle: String
    val clearArtifactsMsg: String
    val deleteSelectedArtifactsTitle: String
    val deleteSelectedArtifactsMsg: String
    val deleteEventTitle: String
    val deleteEventMsg: String
    val clearEventsTitle: String
    val clearEventsMsg: String
    val clearEventsActionMsg: String
    val deleteSelectedEventsTitle: String
    val deleteSelectedEventsMsg: String
    val clearBlackboardTitle: String
    val clearBlackboardMsg: String
    val eventAdd: String
    val eventModify: String
    val eventDelete: String
    val eventRename: String
    val eventCommand: String
    val eventTest: String
    val eventOther: String
    val statusNotConnected: String
    val statusConnected: String
    val statusReconnecting: String
    val statusDisconnected: String
    val resumeFailed: String
    val lostReply: String
    val retryFailedFmt: String
    val cancelFlowFailedFmt: String
    val connectUriInvalid: String
    val scanQrTitle: String
    val scanQrCode: String
    val cameraPermissionHint: String
    val copiedMessagesFmt: String
    val noDownloadableFile: String
    val fileNotReadable: String
    val fileNotFound: String
    val downloadFailed: String
    val openFailed: String
    val loadFailedFmt: String
    val savedToFmt: String
    val saveFailed: String
    val cannotOpenStream: String
    val continueFilePrompt: String
    val toolCallLabel: String
    val toolStatusPending: String
    val toolStatusInProgress: String
    val toolStatusCompleted: String
    val toolStatusFailed: String
    val toolStatusCancelled: String
    val roomModelHint: String
    val memberNotFoundFmt: String
    val modelSwitchedForFmt: String
    val cmdContinue: String
    val cmdSummarize: String
    val cmdRunTests: String
    val fusionDesc: String
    val quoteHeaderFmt: String
    val deleteHubTitle: String
    val deleteHubMsg: String
    val disconnectCurrent: String
    val more: String
    val save: String
    val sessionLabel: String
    val roomLabel: String
    val targetFmt: String
    val scheduleFmt: String
    val messageFmt: String
    val errorFmt: String
    val disabledTag: String
    val logsTitle: String
    val runLogsTitle: String
    val noRunRecords: String
    val intervalMinutesLabel: String
    val pickTimeHint: String
    val pickDateTime: String
    val cronLabel: String
    val cronHelp: String
    val cronDailyHint: String
    val nextStep: String
    val cronHelpTitle: String
    val cronFormatLine: String
    val cronRanges: String
    val cronSyntax: String
    val cronExamples: String
    val useIt: String
    val cronPresets: List<Pair<String, String>>
    val renameSessionTitle: String
    val newNameLabel: String
    val connectingHub: String
    val notConnectedHub: String
    val noSavedHubs: String
    val pickOrAddHubHint: String
    val addOrPickHub: String
    val hideArchived: String
    val archiveCountFmt: String
    val roleFieldLabel: String
    val defaultRole: String
    val debateRoundsFmt: String
    val totalCountFmt: String
    val modeDescMention: String
    val modeDescConductor: String
    val modeDescRoundRobin: String
    val modeDescParallel: String
    val modeDescPipeline: String
    val modeDescDebate: String
    val modeDescAuto: String
    val projectFiles: String
    val refresh: String
    val menu: String
    val toggle: String
    val upOneLevel: String
    val deleteFileTitle: String
    val deleteFileMsg: String
    val openLabel: String
    val enterLabel: String
    val quoteToInput: String
    val binaryNoPreview: String
    val cannotParseImage: String
    val connectFailed: String
    val notifChannelReply: String
    val notifChannelReplyDesc: String
    val notifChannelApproval: String
    val notifChannelApprovalDesc: String
    val notifChannelService: String
    val notifChannelServiceDesc: String
    val serviceRunning: String
    val approvalNotificationFmt: String
    val devinUsage: String
    val dailyUsed: String
    val weeklyUsed: String
    val quotaResetFmt: String
    val resetDatePattern: String
    val customBackend: String
    val addHub: String
    val editHub: String
    val nameExampleLabel: String
    val saveAndSwitch: String
    val saveAndConnect: String
    val addAndConnect: String
    val appDetails: String
    val scheduleDesc: String
    val statusSection: String
    val filterAllHint: String
    val resetLabel: String
}

object ZhStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "已存配置"
    override val lanTag = "局域网"
    override val remoteTag = "远程 (wss)"
    override val del = "删"
    override val hubAddress = "例如 localhost:8787 或 wss://hub.example.com"
    override val tokenLabel = "Hub Token"
    override val gatewayTokenLabel = "Gateway Token（公网）"
    override val connect = "连接"
    override val searchHistory = "搜索历史…"
    override val searchConversations = "搜索结果"
    override val searchAll = "搜索会话、群聊或历史消息…"
    override val matchedSessions = "会话"
    override val matchedRooms = "群聊"
    override val historyMessages = "历史消息"
    override val sessions = "会话"
    override val newSession = "新建会话"
    override val rooms = "群聊"
    override val createRoom = "建群"
    override val archived = "已归档"
    override val resume = "恢复"
    override val offline = "离线"
    override val busyTag = "执行中"
    override val noResults = "无结果"
    override val singleChat = "单聊"
    override val roomTag = "群"
    override val systemTag = "系统"
    override val chooseAction = "选择操作"
    override val batchDelete = "批量删除"
    override val batchDeleteTitle = "批量删除会话/群聊"
    override val batchDeleteConfirm = "确认删除选中的 %d 项？此操作不可撤销。"
    override val selectAll = "全选"
    override val invertSelection = "反选"
    override val selectedCount = "已选 %d 项"
    override val archive = "归档"
    override val unarchive = "取消归档"
    override val delete = "删除"
    override val cancel = "取消"
    override val ok = "确定"
    override val deleteConfirmTitle = "删除会话「%s」？"
    override val deleteConfirmText = "将从 Hub 移除该会话及其历史记录，所在的群会相应移除该成员。不可撤销。"
    override val create = "创建"
    override val agentLabel = "Agent："
    override val addressLabel = "地址（留空为本机，或 SSH 如 user@host）"
    override val connectionLabel = "连接"
    override val addConnection = "添加连接"
    override val manageConnections = "管理连接"
    override val agentSources = "Agent 来源"
    override val online = "在线"
    override val connectionNoteLabel = "备注（可选，如地址/用途）"
    override val tokenAuto = "自动生成"
    override val tokenManual = "手动填写"
    override val connectionNameLabel = "连接名称（如 公司服务器、家里电脑）"
    override val localConnection = "本机"
    override val localLaunch = "本地直接启动 (Hub 自动启 agent)"
    override val noConnections = "暂无连接，请先在设置中添加"
    override val selectConnection = "选择连接"
    override val nameLabel = "名字（如 后端、前端）"
    override val cwdLabel = "工作目录（PC 绝对路径）"
    override val roomName = "群名称"
    override val modeLabel = "模式："
    override val modeMention = "普通群"
    override val modeConductor = "指挥家"
    override val modeRoundRobin = "轮询"
    override val modeParallel = "并行"
    override val modePipeline = "流水线"
    override val modeDebate = "辩论"
    override val modeAuto = "自动"
    override val modeSelf = "自己"
    override val modeDeciding = "决策中"
    override val modeCurrent = "当前：%s"
    override val conductorTag = "指挥家"
    override val summarizerTag = "汇总者"
    override val judgeTag = "裁判"
    override val sideProTag = "正方"
    override val sideConTag = "反方"
    override val hostTag = "主持人"
    override val speakerTag = "起始发言人"
    override val back = "返回"
    override val previous = "上一个"
    override val next = "下一个"
    override val generating = "执行中…"
    override val stop = "停止"
    override val quoting = "引用"
    override val copy = "复制"
    override val copyFull = "复制全文"
    override val selectText = "选取文字"
    override val copied = "已复制"
    override val inputRoom = "群聊消息，@名字 指定成员"
    override val inputSingle = "给 AI 下指令…"
    override val inputFlowActive = "补充信息或答复求助（不打断编排，发送「取消」中断）"
    override val inputHelpReply = "答复该求助…（追问/其他内容请退出答复模式）"
    override val helpReplying = "答复"
    override val helpReplyAction = "答复"
    override val exitHelpReply = "退出答复"
    override val flowAwaitingInput = "待确认"
    override val flowAcceptanceTitle = "验收标准"
    override val flowAcceptanceCaution = "任务完成数不代表验收通过；请核对下方证据。"
    override val clarificationPending = "指挥家需要你确认以下问题后再派工，点「答复」可自由填写其他方案"
    override val clarificationReplying = "答复指挥家的确认问题"
    override val send = "发送"
    override val queueCountFmt = "排队 %d 条"
    override val queueClearHint = "点按清空"
    override val personaCardLabel = "人设卡"
    override val personaFieldPersona = "人设（persona）"
    override val personaFieldTone = "语气风格"
    override val personaFieldBoundaries = "边界/不做的事"
    override val personaFieldExamples = "示例"
    override val aliasGroupTag = "别名组"
    override val topicResolve = "标记已结"
    override val scanFromGallery = "从相册选择"
    override val qrDecodeFailed = "未识别到二维码，请重试"
    override val originLocal = "本地"
    override val originRemote = "远程"
    override val attachTypeNotAllowed = "不支持的附件类型"
    override val attachTooLarge = "附件过大（上限 10MB）"
    override val attachTooMany = "附件过多（最多 %d 个）"
    override val attachTotalTooLarge = "附件总大小超限"
    override val attachFailed = "附件添加失败"
    override val decisionScopeOnce = "仅一次"
    override val decisionScopeTask = "本任务"
    override val decisionScopeAlways = "始终"
    override val decisionRevoke = "撤销"
    override val decisionRevokeGrant = "撤销授权"
    override val decisionRevoked = "已撤销"
    override val decisionExpired = "已超时"
    override val decisionAuto = "自动放行"
    override val thought = "思考过程"
    override val thoughtOf = "%s 的思考"
    override val plan = "计划"
    override val processSteps = "执行过程（%d 步）"
    override val processCardFmt = "@%s · %d 步"
    override val processRunningHint = "进行中，完成后可查看完整过程"
    override val processUnavailable = "过程已不可用"
    override val processLoading = "加载过程…"
    override val processEmpty = "暂无过程记录"
    override val viewProcess = "查看过程"
    override val dispatchCollapsedFmt = "已派发 %d 个子任务"
    override val finalSummary = "最终总结"
    override val summaryCompleted = "%d/%d 任务已完成"
    override val summaryAdopted = "已采纳 %d 条用户补充"
    override val summaryVerified = "已记录 %d 条独立验证"
    override val permissionRequest = "审批请求"
    override val chose = "已选择：%s"
    override val errorTag = "错误"
    override val nameExists = "名称已存在"
    override val chat = "聊天"
    override val settings = "设置"
    override val scheduledTasks = "定时任务"
    override val createTask = "创建定时任务"
    override val editTask = "编辑定时任务"
    override val taskName = "名称"
    override val taskTarget = "目标"
    override val taskMessage = "消息内容"
    override val taskSchedule = "调度"
    override val scheduleSimple = "简易"
    override val scheduleCron = "高级"
    override val scheduleDaily = "每天"
    override val scheduleInterval = "间隔"
    override val scheduleOnce = "一次性"
    override val taskEnabled = "启用"
    override val noTasks = "暂无定时任务"
    override val nextRun = "下次执行"
    override val lastRun = "上次执行"
    override val theme = "主题"
    override val themeSystem = "跟随系统"
    override val themeLight = "浅色"
    override val themeDark = "深色"
    override val language = "语言"
    override val roleLabel = "角色"
    override val noneRole = "无"
    override val addRole = "＋自定义"
    override val roleNameLabel = "角色名"
    override val personaLabel = "角色设定（将作为首条消息注入）"
    override val defaultCwdLabel = "默认工作目录（可选）"
    override val deleteRoleTitle = "删除角色「%s」？"
    override val pin = "置顶"
    override val unpin = "取消置顶"
    override val filter = "筛选"
    override val filterBy = "筛选条件"
    override val groupBy = "分组"
    override val noGroup = "无分组"
    override val byAgent = "按 Agent"
    override val byCwd = "按工作目录"
    override val byMode = "按模式"
    override val statusOnline = "在线"
    override val statusOffline = "离线"
    override val statusBusy = "忙碌"
    override val statusPinned = "置顶"
    override val statusArchived = "归档"
    override val quickCommands = "快捷指令"
    override val saveCommand = "保存当前输入为指令"
    override val bypassEnabled = "已开启工具审批自动通过"
    override val bypassDisabled = "已关闭工具审批自动通过"
    override val keepAlive = "后台保活"
    override val keepAliveDesc = "连接后由前台服务保持与 Hub 的长连接，息屏/切后台也能收到回复与审批通知。若通知仍不及时，请关闭电池优化并在系统设置中允许本应用自启动（小米/华为/OPPO 等需单独开启）。"
    override val batteryOptimization = "关闭电池优化"
    override val slashHelpTitle = "可用命令："
    override val slashHelpHelp = "/help — 显示命令说明"
    override val slashHelpStop = "/stop — 停止当前生成（在群里可 @成员 指定）"
    override val slashHelpBypass = "/bypass [on|off|toggle] — 切换权限自动审批"
    override val slashHelpModel = "/model [name] — 列出或切换模型"
    override val slashHelpNew = "/new — 新建对话/群聊并重置上下文（旧的自动归档）"
    override val newChatDoneFmt = "已切换到新会话 %s，原会话已归档"
    override val modelListTitle = "可选模型："
    override val modelCurrentPrefix = "当前：%s"
    override val modelSwitched = "已切换到 %s（%s）"
    override val modelUnknown = "未知模型：%s"
    override val modelListError = "获取模型列表失败：%s"
    override val costTierFree = "免费"
    override val costTierLow = "低成本"
    override val costTierMed = "中等成本"
    override val costTierHigh = "高成本"
    override val modelFilterHint = "搜索模型名称、UID 或别名"
    override val modelNoResults = "没有匹配的模型"
    override val modelClearFilters = "清除筛选"
    override val modelCurrentLabel = "当前"
    override val modelSessionConfig = "用量与会话配置"
    override val unknownCommandHint = "未知命令，输入 /help 查看说明"
    override val exit = "退出"
    override val exitConfirmTitle = "退出当前连接？"
    override val exitConfirmText = "断开后将返回连接页面，可以重新选择或添加 Hub。"
    override val about = "关于"
    override val version = "版本"
    override val repository = "仓库地址"
    override val checkForUpdates = "检查更新"
    override val openInBrowser = "打开"
    override val copyLink = "复制"
    override val clone = "克隆"
    override val clonedSession = "已克隆会话「%s」"
    override val rename = "重命名"
    override val edit = "编辑"
    override val editRoom = "编辑群聊"
    override val clonedRoom = "已克隆群聊「%s」"
    override val deleteRoomConfirmTitle = "删除群聊「%s」？"
    override val deleteRoomConfirmText = "将从 Hub 移除该群聊及其聊天记录。不可撤销。"
    override val tokenInput = "输入"
    override val tokenOutput = "输出"
    override val tokenCached = "缓存"
    override val tokenCachedWrite = "写缓存"
    override val tokenThought = "思考"
    override val tokenTotal = "总计"
    override val context = "上下文"
    override val contextMax = "上限"
    override val quotaDaily = "日已用 %d%%"
    override val quotaWeekly = "周已用 %d%%"
    override val verificationBy = "成员验证 @%s："
    override val verificationStatusLabel = "验证："
    override val verificationStatusUnverified = "尚未验证"
    override val verificationStatusMemberPass = "成员判断通过"
    override val verificationStatusMemberNonpass = "成员未确认通过"
    override val automaticCheckLabel = "自动检查："
    override val automaticCheckNotRun = "未运行"
    override val automaticCheckExitedZero = "隔离检查：退出码 0（不代表验收通过）"
    override val automaticCheckExitedNonzero = "隔离检查：退出码 %d"
    override val automaticCheckBlocked = "隔离检查受阻"
    override val automaticCheckTimedOut = "隔离检查超时"
    override val automaticCheckSnapshot = "源码快照 %s"
    override val automaticCheckTruncated = "输出已截断"
    override val memberReportedLabel = "成员自报"
    override val backendRunsLabel = "后端工具回传（未独立复核）"
    override val backendRunCompleted = "完成"
    override val backendRunFailed = "失败"
    override val backendExitUnknown = "退出码未知"
    override val backendClaimMatchLabel = "命令/退出码与成员报告匹配"
    override val backendVerificationCall = "后端调用：%s（仅命令/退出码/可用输出字段匹配）"
    override val snapshotCurrentTrue = "与当前工作区快照一致"
    override val snapshotCurrentFalse = "仅对应历史快照：当前工作区已变化或无法核对，不能证明当前版本通过"
    override val presetCheckRequested = "请求的预设检查 ID：%s"
    override val checkUnapproved = "未配置或未批准此检查 ID"
    override val checkCommandMismatch = "成员命令与预设检查不一致"
    override val backendStatusMissingCommand = "成员未提供验证命令"
    override val backendStatusMissingExit = "成员未提供退出码"
    override val backendStatusNoRun = "没有完成的后端工具记录"
    override val backendStatusUnknownExit = "后端未提供结构化退出码"
    override val backendStatusMismatch = "后端命令、退出码或输出与成员报告不一致"
    override val deliverableEvidence = "交付证据"
    override val evidenceSummaryLabel = "结论："
    override val evidenceCommandLabel = "命令："
    override val evidenceExitCodeLabel = "退出码："
    override val verificationCommandLabel = "验证命令："
    override val verificationExitCodeSuffix = "（退出码：%d）"
    override val evidenceBaselineLabel = "修改前："
    override val evidenceDiffLabel = "差异："
    override val evidenceStdoutLabel = "标准输出："
    override val evidenceStderrLabel = "错误输出："
    override val evidenceReproStepsLabel = "复现步骤："
    override val dependsOnLabel = "依赖："
    override val retryBadge = "重试 %d"
    override val retryAction = "重试"
    override val waitingReply = "⏳ 等待 %s 回复："
    override val you = "你"
    override val actionCancel = "取消"
    override val actionDelete = "删除"
    override val actionClear = "清空"
    override val actionManage = "管理"
    override val actionClose = "关闭"
    override val actionCopy = "复制"
    override val actionQuote = "引用"
    override val actionDownload = "下载"
    override val actionPreview = "预览"
    override val actionSubmit = "提交"
    override val actionDecline = "拒绝"
    override val itemCount = "%d 条"
    override val authorMe = "我"
    override val fileLabel = "文件"
    override val loadMoreHistory = "加载更多历史…"
    override val jumpToBottom = "跳转到最下方"
    override val dateToday = "今天"
    override val dateYesterday = "昨天"
    override val uploadImage = "上传图片"
    override val removeAttachment = "移除"
    override val multiSelect = "多选"
    override val elicitationTitle = "输入请求"
    override val outcomeAccepted = "已提交"
    override val outcomeDeclined = "已拒绝"
    override val outcomeCancelled = "已取消"
    override val commaSeparatedHint = "逗号分隔多个值"
    override val flowTitleConductor = "指挥编排"
    override val flowTitleRoom = "编排进度"
    override val phasePlanning = "规划中"
    override val phaseWorking = "执行中"
    override val phaseReviewing = "验收中"
    override val phaseSummarizing = "汇总中"
    override val phaseAwaitingRetry = "等待重试"
    override val phaseDone = "已完成"
    override val phaseCancelled = "已中断"
    override val elapsedSecFmt = "%s 秒"
    override val elapsedMinFmt = "%s 分 %s 秒"
    override val elapsedHourFmt = "%s 小时 %s 分"
    override val flowElapsedFmt = "用时 %s"
    override val flowInterruptedRetry = "已中断 · 可重试"
    override val retryAllFailed = "重试失败任务"
    override val flowCardPendingFmt = "%s 个任务待执行"
    override val helpWanted = "向你求助"
    override val flowProgressFmt = "%d/%d 完成 · %d 进行中 · %d 待执行"
    override val flowProgressFailed = " · %d 失败"
    override val flowTasksTitle = "任务列表"
    override val interruptFlow = "中断"
    override val supplementCount = "用户补充 %d 条"
    override val capsuleBlackboard = "黑板 %d"
    override val capsuleArtifact = "产物 %d"
    override val capsuleEvent = "事件 %d"
    override val artifactsTitle = "产物"
    override val eventsTitle = "事件"
    override val sharedBlackboard = "共享黑板"
    override val deleteSelectedCount = "删除 %d"
    override val clearAll = "清空全部"
    override val clearActionOnly = "仅清空「%s」"
    override val quotedToast = "已引用到输入框"
    override val copiedToast = "已复制"
    override val deleteArtifactTitle = "删除产物"
    override val deleteArtifactMsg = "确定删除该产物？\n%s"
    override val clearArtifactsTitle = "清空产物"
    override val clearArtifactsMsg = "确定清空全部产物？"
    override val deleteSelectedArtifactsTitle = "删除选中产物"
    override val deleteSelectedArtifactsMsg = "确定删除 %d 条产物？"
    override val deleteEventTitle = "删除事件"
    override val deleteEventMsg = "确定删除该事件？\n%s"
    override val clearEventsTitle = "清空事件"
    override val clearEventsMsg = "确定清空全部事件？"
    override val clearEventsActionMsg = "确定清空全部「%s」事件？"
    override val deleteSelectedEventsTitle = "删除选中事件"
    override val deleteSelectedEventsMsg = "确定删除 %d 条事件？"
    override val clearBlackboardTitle = "清空黑板"
    override val clearBlackboardMsg = "确定清空全部 %d 条黑板摘要？"
    override val eventAdd = "新增"
    override val eventModify = "修改"
    override val eventDelete = "删除"
    override val eventRename = "重命名"
    override val eventCommand = "命令"
    override val eventTest = "测试"
    override val eventOther = "事件"
    override val statusNotConnected = "未连接"
    override val statusConnected = "已连接"
    override val statusReconnecting = "连接已断开，正在重连…"
    override val statusDisconnected = "连接已断开"
    override val resumeFailed = "恢复失败：agent 不支持或会话已失效"
    override val lostReply = "上一条回复在 Hub 重启中丢失"
    override val retryFailedFmt = "重试失败: %s"
    override val cancelFlowFailedFmt = "取消编排失败: %s"
    override val connectUriInvalid = "无效的接入链接"
    override val scanQrTitle = "扫码接入"
    override val scanQrCode = "扫码"
    override val cameraPermissionHint = "需要相机权限才能扫码；也可以手动粘贴接入链接"
    override val copiedMessagesFmt = "已复制 %d 条消息"
    override val noDownloadableFile = "该产物没有可下载文件"
    override val fileNotReadable = "文件不存在或无法读取"
    override val fileNotFound = "文件不存在"
    override val downloadFailed = "下载失败"
    override val openFailed = "打开失败"
    override val loadFailedFmt = "加载失败: %s"
    override val savedToFmt = "已保存到：%s"
    override val saveFailed = "保存失败"
    override val cannotOpenStream = "无法打开输出流"
    override val continueFilePrompt = "继续处理这个文件：%s"
    override val toolCallLabel = "工具调用"
    override val toolStatusPending = "排队中"
    override val toolStatusInProgress = "进行中"
    override val toolStatusCompleted = "已完成"
    override val toolStatusFailed = "失败"
    override val toolStatusCancelled = "已取消"
    override val roomModelHint = "群聊中切换模型请指定成员：/model @成员名 模型名"
    override val memberNotFoundFmt = "未找到成员 @%s"
    override val modelSwitchedForFmt = "@%s 模型已切换为 %s"
    override val cmdContinue = "继续"
    override val cmdSummarize = "总结目前的进展，列出下一步计划"
    override val cmdRunTests = "运行项目的测试并修复所有失败"
    override val fusionDesc = "/fusion - 选择 Fusion 模型"
    override val quoteHeaderFmt = "（引用 %s 的消息：\"%s\"）"
    override val deleteHubTitle = "删除 Hub"
    override val deleteHubMsg = "确定删除「%s」？"
    override val disconnectCurrent = "断开当前"
    override val more = "更多"
    override val save = "保存"
    override val sessionLabel = "会话"
    override val roomLabel = "群聊"
    override val targetFmt = "目标：%s · %s"
    override val scheduleFmt = "调度：%s"
    override val messageFmt = "消息：%s"
    override val errorFmt = "错误：%s"
    override val disabledTag = "禁用"
    override val logsTitle = "日志"
    override val runLogsTitle = "执行日志"
    override val noRunRecords = "暂无执行记录"
    override val intervalMinutesLabel = "间隔（分钟）"
    override val pickTimeHint = "请选择时间"
    override val pickDateTime = "选择日期时间"
    override val cronLabel = "Cron（分 时 日 月 周）"
    override val cronHelp = "Cron 说明"
    override val cronDailyHint = "如 0 9 * * * 表示每天 9:00"
    override val nextStep = "下一步"
    override val cronHelpTitle = "Cron 表达式说明"
    override val cronFormatLine = "格式：分 时 日 月 周"
    override val cronRanges = "· 分：0-59\n· 时：0-23\n· 日：1-31\n· 月：1-12\n· 周：0-6（0=周日）"
    override val cronSyntax = "支持 *（任意）、*/N（步长）、1-5（范围）、1,3,5（列表）"
    override val cronExamples = "常用示例（点击使用）："
    override val useIt = "使用"
    override val cronPresets = listOf(
        "0 9 * * *" to "每天 9:00",
        "0 9 * * 1-5" to "工作日 9:00",
        "*/30 * * * *" to "每 30 分钟",
        "0 */2 * * *" to "每 2 小时",
        "0 9,18 * * *" to "每天 9:00 和 18:00",
        "0 0 * * 0" to "每周日 0:00",
        "0 0 1 * *" to "每月 1 号 0:00",
    )
    override val renameSessionTitle = "重命名会话"
    override val newNameLabel = "新名称"
    override val connectingHub = "正在连接 Hub…"
    override val notConnectedHub = "当前未连接到 Hub"
    override val noSavedHubs = "还没有保存的 Hub，点击下方按钮添加"
    override val pickOrAddHubHint = "点击下方按钮选择或添加 Hub"
    override val addOrPickHub = "添加 / 选择 Hub"
    override val hideArchived = "隐藏归档"
    override val archiveCountFmt = "归档 (%d)"
    override val roleFieldLabel = "角色："
    override val defaultRole = "默认（无角色卡）"
    override val debateRoundsFmt = "%s 轮数："
    override val totalCountFmt = "共 %d 条"
    override val modeDescMention = "成员自由发言，@某个成员时该成员单独回答。适合闲聊、快速提问。"
    override val modeDescConductor = "指挥家自动拆解任务，派发给不同成员并行执行，最后汇总结果。适合复杂任务。"
    override val modeDescRoundRobin = "每个问题按顺序由一个成员回答，可设置起始发言人。适合多角色依次表态。"
    override val modeDescParallel = "所有成员同时回答同一个问题，最后由汇总者综合出一致结论。适合头脑风暴。"
    override val modeDescPipeline = "成员按指定顺序串行处理，后一个成员基于前一个的结果继续。适合多步骤流程。"
    override val modeDescDebate = "正方与反方交替辩论若干轮，最后由裁判给出公正总结。适合观点碰撞。"
    override val modeDescAuto = "主持人根据任务内容自动选择最合适的协作模式。不确定选哪个时可用。"
    override val projectFiles = "项目文件"
    override val refresh = "刷新"
    override val menu = "菜单"
    override val toggle = "启用/停用"
    override val upOneLevel = "↑ 返回上级"
    override val deleteFileTitle = "删除文件"
    override val deleteFileMsg = "确认删除 %s？"
    override val openLabel = "打开"
    override val enterLabel = "进入"
    override val quoteToInput = "引用到输入框"
    override val binaryNoPreview = "二进制文件，无法直接预览"
    override val cannotParseImage = "无法解析图片"
    override val connectFailed = "连接失败，请检查服务器或手动重连"
    override val notifChannelReply = "Agent 回复"
    override val notifChannelReplyDesc = "Agent 任务完成或回复消息时提醒"
    override val notifChannelApproval = "审批请求"
    override val notifChannelApprovalDesc = "Agent 发起权限审批时提醒"
    override val notifChannelService = "后台连接"
    override val notifChannelServiceDesc = "保持与 Hub 的后台连接（常驻，可隐藏）"
    override val serviceRunning = "后台连接保持中"
    override val approvalNotificationFmt = "审批请求 · %s"
    override val devinUsage = "Devin 用量"
    override val dailyUsed = "今日已用"
    override val weeklyUsed = "本周已用"
    override val quotaResetFmt = "重置 %s"
    override val resetDatePattern = "M月d日 HH:mm"
    override val customBackend = "自定义"
    override val addHub = "添加 Hub"
    override val editHub = "编辑 Hub"
    override val nameExampleLabel = "名称（如 本机 / 公网 VPS）"
    override val saveAndSwitch = "保存并切换"
    override val saveAndConnect = "保存并连接"
    override val addAndConnect = "添加并连接"
    override val appDetails = "应用详情设置"
    override val scheduleDesc = "定时向会话或群聊发送消息"
    override val statusSection = "状态"
    override val filterAllHint = "未选择时显示全部"
    override val resetLabel = "重置"
}

object EnStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "Saved profiles"
    override val lanTag = "LAN"
    override val remoteTag = "Remote (wss)"
    override val del = "Del"
    override val hubAddress = "e.g. localhost:8787 or wss://hub.example.com"
    override val tokenLabel = "Hub Token"
    override val gatewayTokenLabel = "Gateway Token (public)"
    override val connect = "Connect"
    override val searchHistory = "Search history…"
    override val searchConversations = "Search results"
    override val searchAll = "Search sessions, rooms or history…"
    override val matchedSessions = "Sessions"
    override val matchedRooms = "Rooms"
    override val historyMessages = "History"
    override val sessions = "Sessions"
    override val newSession = "New session"
    override val rooms = "Rooms"
    override val createRoom = "New room"
    override val archived = "Archived"
    override val resume = "Resume"
    override val offline = "offline"
    override val busyTag = "running"
    override val noResults = "No results"
    override val singleChat = "DM"
    override val roomTag = "Room"
    override val systemTag = "System"
    override val chooseAction = "Choose action"
    override val batchDelete = "Batch delete"
    override val batchDeleteTitle = "Batch delete sessions/rooms"
    override val batchDeleteConfirm = "Delete selected %d items? This cannot be undone."
    override val selectAll = "Select all"
    override val invertSelection = "Invert"
    override val selectedCount = "%d selected"
    override val archive = "Archive"
    override val unarchive = "Unarchive"
    override val delete = "Delete"
    override val cancel = "Cancel"
    override val ok = "OK"
    override val deleteConfirmTitle = "Delete session \"%s\"?"
    override val deleteConfirmText = "Removes the session and its history from the Hub, and removes it from rooms. This cannot be undone."
    override val create = "Create"
    override val agentLabel = "Agent:"
    override val addressLabel = "Address (blank for local, or SSH user@host)"
    override val connectionLabel = "Connection"
    override val addConnection = "Add Connection"
    override val manageConnections = "Manage Connections"
    override val agentSources = "Agent Sources"
    override val online = "online"
    override val connectionNoteLabel = "Note (optional, e.g. address/purpose)"
    override val tokenAuto = "Auto-generate"
    override val tokenManual = "Manual"
    override val connectionNameLabel = "Connection name (e.g. company server, home PC)"
    override val localConnection = "Local"
    override val localLaunch = "Launch locally (Hub auto-starts agent)"
    override val noConnections = "No connections, please add one in Settings"
    override val selectConnection = "Select Connection"
    override val nameLabel = "Name (e.g. backend, frontend)"
    override val cwdLabel = "Working directory (absolute path on PC)"
    override val roomName = "Room name"
    override val modeLabel = "Mode:"
    override val modeMention = "Normal"
    override val modeConductor = "Conductor"
    override val modeRoundRobin = "Round-robin"
    override val modeParallel = "Parallel"
    override val modePipeline = "Pipeline"
    override val modeDebate = "Debate"
    override val modeAuto = "Auto"
    override val modeSelf = "Self"
    override val modeDeciding = "Deciding"
    override val modeCurrent = "Now: %s"
    override val conductorTag = "Conductor"
    override val summarizerTag = "Summarizer"
    override val judgeTag = "Judge"
    override val sideProTag = "Pro"
    override val sideConTag = "Con"
    override val hostTag = "Host"
    override val speakerTag = "First Speaker"
    override val back = "Back"
    override val previous = "Previous"
    override val next = "Next"
    override val generating = "Running…"
    override val stop = "Stop"
    override val quoting = "Quote"
    override val copy = "Copy"
    override val copyFull = "Copy full text"
    override val selectText = "Select text"
    override val copied = "Copied"
    override val inputRoom = "Message, @name to mention"
    override val inputSingle = "Send an instruction…"
    override val inputFlowActive = "Add info or reply (won't interrupt; send \"cancel\" to stop)"
    override val inputHelpReply = "Reply to this help request…"
    override val helpReplying = "Replying to"
    override val helpReplyAction = "Reply"
    override val exitHelpReply = "Exit reply"
    override val flowAwaitingInput = "Awaiting input"
    override val flowAcceptanceTitle = "Acceptance criteria"
    override val flowAcceptanceCaution = "Completed tasks do not mean these criteria passed; review the evidence below."
    override val clarificationPending = "The conductor needs your answers before dispatching — tap Answer to write any custom plan"
    override val clarificationReplying = "Answering the conductor's questions"
    override val send = "Send"
    override val queueCountFmt = "%d queued"
    override val queueClearHint = "tap to clear"
    override val personaCardLabel = "Persona card"
    override val personaFieldPersona = "Persona"
    override val personaFieldTone = "Tone"
    override val personaFieldBoundaries = "Boundaries"
    override val personaFieldExamples = "Examples"
    override val aliasGroupTag = "alias group"
    override val topicResolve = "Mark done"
    override val scanFromGallery = "Choose from gallery"
    override val qrDecodeFailed = "No QR code detected, please retry"
    override val originLocal = "local"
    override val originRemote = "remote"
    override val attachTypeNotAllowed = "Unsupported attachment type"
    override val attachTooLarge = "Attachment too large (max 10MB)"
    override val attachTooMany = "Too many attachments (max %d)"
    override val attachTotalTooLarge = "Attachments exceed total size limit"
    override val attachFailed = "Failed to add attachment"
    override val decisionScopeOnce = "Once"
    override val decisionScopeTask = "This task"
    override val decisionScopeAlways = "Always"
    override val decisionRevoke = "Revoke"
    override val decisionRevokeGrant = "Revoke grant"
    override val decisionRevoked = "Revoked"
    override val decisionExpired = "Expired"
    override val decisionAuto = "Auto-approved"
    override val thought = "Thinking"
    override val thoughtOf = "%s's thinking"
    override val plan = "Plan"
    override val processSteps = "Process (%d steps)"
    override val processCardFmt = "@%s · %d steps"
    override val processRunningHint = "Running — full process available after completion"
    override val processUnavailable = "Process unavailable"
    override val processLoading = "Loading process…"
    override val processEmpty = "No process items"
    override val viewProcess = "View process"
    override val dispatchCollapsedFmt = "Dispatched %d subtasks"
    override val finalSummary = "Final summary"
    override val summaryCompleted = "%d/%d tasks completed"
    override val summaryAdopted = "Adopted %d user supplements"
    override val summaryVerified = "Recorded %d independent verifications"
    override val permissionRequest = "Approval request"
    override val chose = "Selected: %s"
    override val errorTag = "Error"
    override val nameExists = "Name already exists"
    override val chat = "Chat"
    override val settings = "Settings"
    override val scheduledTasks = "Scheduled Tasks"
    override val createTask = "Create Task"
    override val editTask = "Edit Task"
    override val taskName = "Name"
    override val taskTarget = "Target"
    override val taskMessage = "Message"
    override val taskSchedule = "Schedule"
    override val scheduleSimple = "Simple"
    override val scheduleCron = "Cron"
    override val scheduleDaily = "Daily"
    override val scheduleInterval = "Interval"
    override val scheduleOnce = "Once"
    override val taskEnabled = "Enabled"
    override val noTasks = "No scheduled tasks"
    override val nextRun = "Next run"
    override val lastRun = "Last run"
    override val theme = "Theme"
    override val themeSystem = "System"
    override val themeLight = "Light"
    override val themeDark = "Dark"
    override val language = "Language"
    override val roleLabel = "Role"
    override val noneRole = "None"
    override val addRole = "+ Custom"
    override val roleNameLabel = "Role name"
    override val personaLabel = "Persona prompt (sent as the first message)"
    override val defaultCwdLabel = "Default working directory (optional)"
    override val deleteRoleTitle = "Delete role \"%s\"?"
    override val pin = "Pin"
    override val unpin = "Unpin"
    override val filter = "Filter"
    override val filterBy = "Filter by"
    override val groupBy = "Group by"
    override val noGroup = "None"
    override val byAgent = "By Agent"
    override val byCwd = "By Working Dir"
    override val byMode = "By Mode"
    override val statusOnline = "Online"
    override val statusOffline = "Offline"
    override val statusBusy = "Busy"
    override val statusPinned = "Pinned"
    override val statusArchived = "Archived"
    override val quickCommands = "Quick commands"
    override val saveCommand = "Save current input as command"
    override val bypassEnabled = "Tool approval auto-allow enabled"
    override val bypassDisabled = "Tool approval auto-allow disabled"
    override val keepAlive = "Background keep-alive"
    override val keepAliveDesc = "A foreground service keeps the connection to the Hub alive so you get reply and approval notifications even with the screen off. If notifications are still delayed, disable battery optimization and allow auto-start in system settings (required on Xiaomi/Huawei/OPPO etc.)."
    override val batteryOptimization = "Disable battery optimization"
    override val slashHelpTitle = "Available commands:"
    override val slashHelpHelp = "/help — show command help"
    override val slashHelpStop = "/stop — stop current generation (use @name in a room)"
    override val slashHelpBypass = "/bypass [on|off|toggle] — toggle permission auto-approve"
    override val slashHelpModel = "/model [name] — list or switch model"
    override val slashHelpNew = "/new — start a fresh chat/room (the old one is archived)"
    override val newChatDoneFmt = "Switched to %s; the previous one was archived"
    override val modelListTitle = "Available models:"
    override val modelCurrentPrefix = "Current: %s"
    override val modelSwitched = "Switched to %s (%s)"
    override val modelUnknown = "Unknown model: %s"
    override val modelListError = "Failed to load models: %s"
    override val costTierFree = "Free"
    override val costTierLow = "Low cost"
    override val costTierMed = "Medium cost"
    override val costTierHigh = "High cost"
    override val modelFilterHint = "Search by name, UID or alias"
    override val modelNoResults = "No matching models"
    override val modelClearFilters = "Clear filters"
    override val modelCurrentLabel = "Current"
    override val modelSessionConfig = "Usage & session config"
    override val unknownCommandHint = "Unknown command, type /help for usage"
    override val exit = "Exit"
    override val exitConfirmTitle = "Exit current connection?"
    override val exitConfirmText = "You will return to the connection screen to choose or add another Hub."
    override val about = "About"
    override val version = "Version"
    override val repository = "Repository"
    override val checkForUpdates = "Check for updates"
    override val openInBrowser = "Open"
    override val copyLink = "Copy"
    override val clone = "Clone"
    override val clonedSession = "Cloned session \"%s\""
    override val rename = "Rename"
    override val edit = "Edit"
    override val editRoom = "Edit room"
    override val clonedRoom = "Cloned room \"%s\""
    override val deleteRoomConfirmTitle = "Delete room \"%s\"?"
    override val deleteRoomConfirmText = "Removes the room and its chat history from the Hub. This cannot be undone."
    override val tokenInput = "Input"
    override val tokenOutput = "Output"
    override val tokenCached = "Cache"
    override val tokenCachedWrite = "Cache write"
    override val tokenThought = "Thought"
    override val tokenTotal = "Total"
    override val context = "Context"
    override val contextMax = "max"
    override val quotaDaily = "Day %d%% used"
    override val quotaWeekly = "Week %d%% used"
    override val verificationBy = "Member review by @%s: "
    override val verificationStatusLabel = "Verification: "
    override val verificationStatusUnverified = "Not yet verified"
    override val verificationStatusMemberPass = "Passed by member review"
    override val verificationStatusMemberNonpass = "Member review did not confirm pass"
    override val automaticCheckLabel = "Automatic check: "
    override val automaticCheckNotRun = "not run"
    override val automaticCheckExitedZero = "Isolated check: exit code 0 (not a pass)"
    override val automaticCheckExitedNonzero = "Isolated check: exit code %d"
    override val automaticCheckBlocked = "Isolated check blocked"
    override val automaticCheckTimedOut = "Isolated check timed out"
    override val automaticCheckSnapshot = "source snapshot %s"
    override val automaticCheckTruncated = "output truncated"
    override val memberReportedLabel = "Member-reported"
    override val backendRunsLabel = "Backend tool reports (not independently verified)"
    override val backendRunCompleted = "completed"
    override val backendRunFailed = "failed"
    override val backendExitUnknown = "exit code unknown"
    override val backendClaimMatchLabel = "Command/exit code matches member report"
    override val backendVerificationCall = "Backend call: %s (command/exit code/available output fields match only)"
    override val snapshotCurrentTrue = "Matches the current workspace snapshot"
    override val snapshotCurrentFalse = "Historical snapshot only: the workspace changed or cannot be checked; the current version is not verified"
    override val presetCheckRequested = "Requested preset check ID: %s"
    override val checkUnapproved = "Check ID is not configured or approved"
    override val checkCommandMismatch = "Member command differs from the preset check"
    override val backendStatusMissingCommand = "Member did not provide a verification command"
    override val backendStatusMissingExit = "Member did not provide an exit code"
    override val backendStatusNoRun = "No completed backend tool run"
    override val backendStatusUnknownExit = "Backend did not provide a structured exit code"
    override val backendStatusMismatch = "Backend command, exit code or output differs from the member report"
    override val deliverableEvidence = "Delivery evidence"
    override val evidenceSummaryLabel = "Summary: "
    override val evidenceCommandLabel = "Command: "
    override val evidenceExitCodeLabel = "Exit code: "
    override val verificationCommandLabel = "Verification command: "
    override val verificationExitCodeSuffix = " (exit code: %d)"
    override val evidenceBaselineLabel = "Baseline: "
    override val evidenceDiffLabel = "Diff: "
    override val evidenceStdoutLabel = "Stdout: "
    override val evidenceStderrLabel = "Stderr: "
    override val evidenceReproStepsLabel = "Reproduction steps: "
    override val dependsOnLabel = "Depends on: "
    override val retryBadge = "Retry %d"
    override val retryAction = "Retry"
    override val waitingReply = "⏳ Waiting for %s to reply: "
    override val you = "you"
    override val actionCancel = "Cancel"
    override val actionDelete = "Delete"
    override val actionClear = "Clear"
    override val actionManage = "Manage"
    override val actionClose = "Close"
    override val actionCopy = "Copy"
    override val actionQuote = "Quote"
    override val actionDownload = "Download"
    override val actionPreview = "Preview"
    override val actionSubmit = "Submit"
    override val actionDecline = "Decline"
    override val itemCount = "%d"
    override val authorMe = "me"
    override val fileLabel = "File"
    override val loadMoreHistory = "Load more history…"
    override val jumpToBottom = "Jump to bottom"
    override val dateToday = "Today"
    override val dateYesterday = "Yesterday"
    override val uploadImage = "Upload image"
    override val removeAttachment = "Remove"
    override val multiSelect = "Select"
    override val elicitationTitle = "Input required"
    override val outcomeAccepted = "Submitted"
    override val outcomeDeclined = "Declined"
    override val outcomeCancelled = "Cancelled"
    override val commaSeparatedHint = "Separate multiple values with commas"
    override val flowTitleConductor = "Orchestration"
    override val flowTitleRoom = "Flow progress"
    override val phasePlanning = "Planning"
    override val phaseWorking = "Working"
    override val phaseReviewing = "Reviewing"
    override val phaseSummarizing = "Summarizing"
    override val phaseAwaitingRetry = "Awaiting retry"
    override val phaseDone = "Done"
    override val phaseCancelled = "Interrupted"
    override val elapsedSecFmt = "%ss"
    override val elapsedMinFmt = "%sm %ss"
    override val elapsedHourFmt = "%sh %sm"
    override val flowElapsedFmt = "took %s"
    override val flowInterruptedRetry = "Interrupted · retry available"
    override val retryAllFailed = "Retry failed tasks"
    override val flowCardPendingFmt = "%s pending"
    override val helpWanted = "Needs you"
    override val flowProgressFmt = "%d/%d done · %d running · %d pending"
    override val flowProgressFailed = " · %d failed"
    override val flowTasksTitle = "Tasks"
    override val interruptFlow = "Abort"
    override val supplementCount = "%d user supplements"
    override val capsuleBlackboard = "Board %d"
    override val capsuleArtifact = "Artifacts %d"
    override val capsuleEvent = "Events %d"
    override val artifactsTitle = "Artifacts"
    override val eventsTitle = "Events"
    override val sharedBlackboard = "Blackboard"
    override val deleteSelectedCount = "Delete %d"
    override val clearAll = "Clear all"
    override val clearActionOnly = "Clear \"%s\" only"
    override val quotedToast = "Quoted to input"
    override val copiedToast = "Copied"
    override val deleteArtifactTitle = "Delete artifact"
    override val deleteArtifactMsg = "Delete this artifact?\n%s"
    override val clearArtifactsTitle = "Clear artifacts"
    override val clearArtifactsMsg = "Clear all artifacts?"
    override val deleteSelectedArtifactsTitle = "Delete selected artifacts"
    override val deleteSelectedArtifactsMsg = "Delete %d artifacts?"
    override val deleteEventTitle = "Delete event"
    override val deleteEventMsg = "Delete this event?\n%s"
    override val clearEventsTitle = "Clear events"
    override val clearEventsMsg = "Clear all events?"
    override val clearEventsActionMsg = "Clear all \"%s\" events?"
    override val deleteSelectedEventsTitle = "Delete selected events"
    override val deleteSelectedEventsMsg = "Delete %d events?"
    override val clearBlackboardTitle = "Clear blackboard"
    override val clearBlackboardMsg = "Clear all %d blackboard entries?"
    override val eventAdd = "add"
    override val eventModify = "modify"
    override val eventDelete = "delete"
    override val eventRename = "rename"
    override val eventCommand = "command"
    override val eventTest = "test"
    override val eventOther = "event"
    override val statusNotConnected = "Not connected"
    override val statusConnected = "Connected"
    override val statusReconnecting = "Disconnected, reconnecting…"
    override val statusDisconnected = "Disconnected"
    override val resumeFailed = "Resume failed: agent unsupported or session expired"
    override val lostReply = "Previous reply lost during Hub restart"
    override val retryFailedFmt = "Retry failed: %s"
    override val cancelFlowFailedFmt = "Cancel flow failed: %s"
    override val connectUriInvalid = "Invalid connect link"
    override val scanQrTitle = "Scan to connect"
    override val scanQrCode = "Scan QR"
    override val cameraPermissionHint = "Camera permission is required to scan; you can also paste the connect link manually"
    override val copiedMessagesFmt = "Copied %d messages"
    override val noDownloadableFile = "No downloadable file for this artifact"
    override val fileNotReadable = "File missing or unreadable"
    override val fileNotFound = "File not found"
    override val downloadFailed = "Download failed"
    override val openFailed = "Open failed"
    override val loadFailedFmt = "Load failed: %s"
    override val savedToFmt = "Saved to: %s"
    override val saveFailed = "Save failed"
    override val cannotOpenStream = "Cannot open output stream"
    override val continueFilePrompt = "Continue working on this file: %s"
    override val toolCallLabel = "Tool call"
    override val toolStatusPending = "Pending"
    override val toolStatusInProgress = "In progress"
    override val toolStatusCompleted = "Completed"
    override val toolStatusFailed = "Failed"
    override val toolStatusCancelled = "Cancelled"
    override val roomModelHint = "In rooms, specify a member: /model @member model"
    override val memberNotFoundFmt = "Member @%s not found"
    override val modelSwitchedForFmt = "@%s model switched to %s"
    override val cmdContinue = "Continue"
    override val cmdSummarize = "Summarize progress and list next steps"
    override val cmdRunTests = "Run project tests and fix all failures"
    override val fusionDesc = "/fusion - pick a Fusion model"
    override val quoteHeaderFmt = "(Quoting %s: \"%s\")"
    override val deleteHubTitle = "Delete Hub"
    override val deleteHubMsg = "Delete \"%s\"?"
    override val disconnectCurrent = "Disconnect"
    override val more = "More"
    override val save = "Save"
    override val sessionLabel = "Session"
    override val roomLabel = "Room"
    override val targetFmt = "Target: %s · %s"
    override val scheduleFmt = "Schedule: %s"
    override val messageFmt = "Message: %s"
    override val errorFmt = "Error: %s"
    override val disabledTag = "Disabled"
    override val logsTitle = "Logs"
    override val runLogsTitle = "Run logs"
    override val noRunRecords = "No run records"
    override val intervalMinutesLabel = "Interval (minutes)"
    override val pickTimeHint = "Pick a time"
    override val pickDateTime = "Pick date & time"
    override val cronLabel = "Cron (min hour day month dow)"
    override val cronHelp = "Cron help"
    override val cronDailyHint = "e.g. 0 9 * * * runs daily at 9:00"
    override val nextStep = "Next"
    override val cronHelpTitle = "Cron expression"
    override val cronFormatLine = "Format: minute hour day month weekday"
    override val cronRanges = "· minute: 0-59\n· hour: 0-23\n· day: 1-31\n· month: 1-12\n· weekday: 0-6 (0=Sun)"
    override val cronSyntax = "Supports * (any), */N (step), 1-5 (range), 1,3,5 (list)"
    override val cronExamples = "Common examples (tap to use):"
    override val useIt = "Use"
    override val cronPresets = listOf(
        "0 9 * * *" to "Daily 9:00",
        "0 9 * * 1-5" to "Weekdays 9:00",
        "*/30 * * * *" to "Every 30 minutes",
        "0 */2 * * *" to "Every 2 hours",
        "0 9,18 * * *" to "Daily 9:00 and 18:00",
        "0 0 * * 0" to "Sundays 0:00",
        "0 0 1 * *" to "1st of month 0:00",
    )
    override val renameSessionTitle = "Rename session"
    override val newNameLabel = "New name"
    override val connectingHub = "Connecting to Hub…"
    override val notConnectedHub = "Not connected to a Hub"
    override val noSavedHubs = "No saved Hubs yet — tap the button below to add one"
    override val pickOrAddHubHint = "Tap the button below to pick or add a Hub"
    override val addOrPickHub = "Add / Pick Hub"
    override val hideArchived = "Hide archived"
    override val archiveCountFmt = "Archive (%d)"
    override val roleFieldLabel = "Role:"
    override val defaultRole = "Default (no role card)"
    override val debateRoundsFmt = "%s rounds:"
    override val totalCountFmt = "%d total"
    override val modeDescMention = "Members chat freely; @a member to get a direct answer. Good for quick questions."
    override val modeDescConductor = "A conductor breaks the task down, dispatches subtasks to members in parallel, then summarizes. Good for complex tasks."
    override val modeDescRoundRobin = "Each question is answered by one member in turn; the starting speaker can be set. Good for sequential opinions."
    override val modeDescParallel = "All members answer the same question at once; a summarizer merges conclusions. Good for brainstorming."
    override val modeDescPipeline = "Members process in a fixed order, each building on the previous result. Good for multi-step flows."
    override val modeDescDebate = "Pro and con sides debate for several rounds, then a judge summarizes. Good for weighing options."
    override val modeDescAuto = "The host picks the best mode automatically. Use when unsure."
    override val projectFiles = "Project files"
    override val refresh = "Refresh"
    override val menu = "Menu"
    override val toggle = "Toggle"
    override val upOneLevel = "↑ Up one level"
    override val deleteFileTitle = "Delete file"
    override val deleteFileMsg = "Delete %s?"
    override val openLabel = "Open"
    override val enterLabel = "Enter"
    override val quoteToInput = "Quote into input"
    override val binaryNoPreview = "Binary file, cannot preview"
    override val cannotParseImage = "Cannot parse image"
    override val connectFailed = "Connection failed — check the server or reconnect manually"
    override val notifChannelReply = "Agent reply"
    override val notifChannelReplyDesc = "Notify when the agent finishes a task or replies"
    override val notifChannelApproval = "Approval request"
    override val notifChannelApprovalDesc = "Notify when the agent requests permission approval"
    override val notifChannelService = "Background connection"
    override val notifChannelServiceDesc = "Keeps a background connection to the Hub (ongoing, hideable)"
    override val serviceRunning = "Background connection active"
    override val approvalNotificationFmt = "Approval request · %s"
    override val devinUsage = "Devin usage"
    override val dailyUsed = "Used today"
    override val weeklyUsed = "Used this week"
    override val quotaResetFmt = "Resets %s"
    override val resetDatePattern = "MMM d HH:mm"
    override val customBackend = "Custom"
    override val addHub = "Add Hub"
    override val editHub = "Edit Hub"
    override val nameExampleLabel = "Name (e.g. Laptop / VPS)"
    override val saveAndSwitch = "Save & switch"
    override val saveAndConnect = "Save & connect"
    override val addAndConnect = "Add & connect"
    override val appDetails = "App details"
    override val scheduleDesc = "Send scheduled messages to a session or room"
    override val statusSection = "Status"
    override val filterAllHint = "All shown when nothing selected"
    override val resetLabel = "Reset"
}

val LocalStrings = staticCompositionLocalOf<Strings> { ZhStrings }

fun stringsFor(lang: String): Strings = if (lang == "en") EnStrings else ZhStrings

fun toolStatusLabel(S: Strings, status: String): String = when (status) {
    "pending" -> S.toolStatusPending
    "in_progress" -> S.toolStatusInProgress
    "completed" -> S.toolStatusCompleted
    "failed" -> S.toolStatusFailed
    "cancelled" -> S.toolStatusCancelled
    else -> status
}

private val PLAN_STATUS_RE = Regex("^\\[(pending|in_progress|completed|failed|cancelled)\\]\\s*")

fun planEntryLabel(S: Strings, entry: String): String =
    PLAN_STATUS_RE.replace(entry) { "[${toolStatusLabel(S, it.groupValues[1])}] " }
