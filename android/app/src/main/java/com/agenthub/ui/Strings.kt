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
    val selectText: String
    val copied: String
    val inputRoom: String
    val inputSingle: String
    val send: String
    val thought: String
    val thoughtOf: String
    val plan: String
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
}

object ZhStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "已存配置"
    override val lanTag = "局域网"
    override val remoteTag = "远程 (wss)"
    override val del = "删"
    override val hubAddress = "例如 localhost:8787 或 wss://hub.example.com"
    override val tokenLabel = "Token"
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
    override val selectText = "选取文字"
    override val copied = "已复制"
    override val inputRoom = "群聊消息，@名字 指定成员"
    override val inputSingle = "给 AI 下指令…"
    override val send = "发送"
    override val thought = "思考过程"
    override val thoughtOf = "%s 的思考"
    override val plan = "计划"
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
}

object EnStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "Saved profiles"
    override val lanTag = "LAN"
    override val remoteTag = "Remote (wss)"
    override val del = "Del"
    override val hubAddress = "e.g. localhost:8787 or wss://hub.example.com"
    override val tokenLabel = "Token"
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
    override val selectText = "Select text"
    override val copied = "Copied"
    override val inputRoom = "Message, @name to mention"
    override val inputSingle = "Send an instruction…"
    override val send = "Send"
    override val thought = "Thinking"
    override val thoughtOf = "%s's thinking"
    override val plan = "Plan"
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
}

val LocalStrings = staticCompositionLocalOf<Strings> { ZhStrings }

fun stringsFor(lang: String): Strings = if (lang == "en") EnStrings else ZhStrings
