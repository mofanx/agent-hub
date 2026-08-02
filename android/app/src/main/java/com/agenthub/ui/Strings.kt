package com.agenthub.ui

import androidx.compose.runtime.staticCompositionLocalOf

interface Strings {
    val appName: String
    val savedProfiles: String
    val lanTag: String
    val remoteTag: String
    val del: String
    val hubAddress: String
    val portLabel: String
    val tokenLabel: String
    val connect: String
    val searchHistory: String
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
    val archive: String
    val unarchive: String
    val delete: String
    val cancel: String
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
    val conductorTag: String
    val back: String
    val generating: String
    val stop: String
    val quoting: String
    val copy: String
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
    val chat: String
    val settings: String
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
    val unknownCommandHint: String
}

object ZhStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "已存配置"
    override val lanTag = "局域网"
    override val remoteTag = "远程 (wss)"
    override val del = "删"
    override val hubAddress = "Hub IP 或完整 wss 地址（远程）"
    override val portLabel = "端口"
    override val tokenLabel = "Token"
    override val connect = "连接"
    override val searchHistory = "搜索历史…"
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
    override val archive = "归档"
    override val unarchive = "取消归档"
    override val delete = "删除"
    override val cancel = "取消"
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
    override val conductorTag = "指挥"
    override val back = "返回"
    override val generating = "执行中…"
    override val stop = "停止"
    override val quoting = "引用"
    override val copy = "复制"
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
    override val chat = "聊天"
    override val settings = "设置"
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
    override val unknownCommandHint = "未知命令，输入 /help 查看说明"
}

object EnStrings : Strings {
    override val appName = "Agent Hub"
    override val savedProfiles = "Saved profiles"
    override val lanTag = "LAN"
    override val remoteTag = "Remote (wss)"
    override val del = "Del"
    override val hubAddress = "Hub IP or full wss URL (remote)"
    override val portLabel = "Port"
    override val tokenLabel = "Token"
    override val connect = "Connect"
    override val searchHistory = "Search history…"
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
    override val archive = "Archive"
    override val unarchive = "Unarchive"
    override val delete = "Delete"
    override val cancel = "Cancel"
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
    override val conductorTag = "Conductor"
    override val back = "Back"
    override val generating = "Running…"
    override val stop = "Stop"
    override val quoting = "Quote"
    override val copy = "Copy"
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
    override val chat = "Chat"
    override val settings = "Settings"
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
    override val unknownCommandHint = "Unknown command, type /help for usage"
}

val LocalStrings = staticCompositionLocalOf<Strings> { ZhStrings }

fun stringsFor(lang: String): Strings = if (lang == "en") EnStrings else ZhStrings
