package com.agenthub

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import com.agenthub.ui.Strings
import com.agenthub.ui.stringsFor

data class Attachment(
    val mimeType: String,
    val base64: String,
    val name: String = "",
)

data class ModelInfo(
    val uid: String,
    val label: String,
    val family: String,
    val vendor: String,
    val slug: String,
    val aliases: List<String>,
    val costTier: String,
    val costSummary: String?,
    val isCurrent: Boolean = false,
)

sealed class ChatItem {
    abstract val id: Long
    abstract val author: String
    abstract val text: String

    data class User(
        override val id: Long,
        override val text: String,
        val attachments: List<Attachment> = emptyList(),
        override val author: String = "我",
        val quoteAuthor: String? = null,
        val quoteText: String? = null,
    ) : ChatItem()
    data class System(
        override val id: Long,
        override val text: String,
        override val author: String = "",
    ) : ChatItem()
    data class Assistant(override val id: Long, override val text: String, override val author: String) : ChatItem()
    data class Thought(override val id: Long, override val text: String, override val author: String) : ChatItem()
    data class Tool(
        override val id: Long,
        val toolCallId: String,
        val title: String,
        val status: String,
        override val author: String,
    ) : ChatItem() {
        override val text: String get() = "[$title] $status"
    }
    data class Plan(
        override val id: Long,
        val entries: List<String>,
        override val author: String,
    ) : ChatItem() {
        override val text: String get() = entries.joinToString("\n")
    }
    data class Error(
        override val id: Long,
        override val text: String,
        override val author: String = "",
    ) : ChatItem()
    data class Permission(
        override val id: Long,
        val requestId: String,
        val title: String,
        val options: List<Pair<String, String>>,
        val answered: String? = null,
        override val author: String,
    ) : ChatItem() {
        override val text: String get() = title
    }
}

data class ConnectionInfo(
    val id: String,
    val name: String,
    val agent: String,
    val token: String = "",
    val address: String = "",
    val cwd: String = "",
    val online: Boolean = false,
    val local: Boolean = false,
)

data class SessionInfo(
    val sessionId: String,
    val cwd: String,
    val name: String,
    val busy: Boolean,
    val agent: String = "devin",
    val address: String = "",
    val connectionId: String? = null,
    val roleId: String? = null,
    val offline: Boolean = false,
    val archived: Boolean = false,
    val stoppable: Boolean = false,
)

data class SearchHit(
    val scope: String,
    val scopeId: String,
    val author: String,
    val text: String,
    val historyId: Long = 0,
    val at: Long = 0,
)

data class SearchGroup(
    val scope: String,
    val scopeId: String,
    val count: Int,
    val previews: List<SearchHit>,
)

data class RoomInfo(
    val roomId: String,
    val name: String,
    val mode: String,
    val conductorId: String?,
    val members: List<Pair<String, String>>,
    val subMode: String? = null,
    val activeSpeaker: String? = null,
    val reason: String? = null,
)

enum class SessionGroupBy { None, Agent, Cwd }

enum class RoomGroupBy { None, Mode }

enum class SessionStatus { Online, Offline, Busy, Pinned, Archived }

data class SessionListFilter(
    val query: String = "",
    val agents: Set<String> = emptySet(),
    val cwds: Set<String> = emptySet(),
    val statuses: Set<SessionStatus> = emptySet(),
    val groupBy: SessionGroupBy = SessionGroupBy.None,
)

data class RoomListFilter(
    val query: String = "",
    val modes: Set<String> = emptySet(),
    val groupBy: RoomGroupBy = RoomGroupBy.None,
)

data class SessionListGroup(val title: String, val sessions: List<SessionInfo>)

data class RoomListGroup(val title: String, val rooms: List<RoomInfo>)

data class RoleInfo(
    val id: String,
    val name: String,
    val persona: String,
    val cwd: String?,
    val agent: String?,
    val address: String?,
    val connectionId: String?,
    val builtin: Boolean,
)

enum class Screen { Connect, Sessions, Chat, Room, Settings }

data class ConnProfile(
    val name: String,
    val address: String,
    val port: String,
    val token: String,
)

class ChatViewModel(app: Application) : AndroidViewModel(app) {
    private val hub = HubClient(viewModelScope)
    private val prefs = app.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)

    val profiles = mutableStateListOf<ConnProfile>()

    val pinnedIds = mutableStateListOf<String>().apply {
        addAll(prefs.getStringSet("pinned", emptySet())!!)
    }

    fun togglePin(sessionId: String) {
        if (pinnedIds.contains(sessionId)) pinnedIds.remove(sessionId) else pinnedIds.add(sessionId)
        prefs.edit().putStringSet("pinned", pinnedIds.toSet()).apply()
    }

    val recentCwds = mutableStateListOf<String>().apply {
        addAll(prefs.getString("cwds", "")!!.split("\n").filter { it.isNotBlank() })
    }

    fun noteCwd(cwd: String) {
        if (cwd.isBlank()) return
        recentCwds.remove(cwd)
        recentCwds.add(0, cwd)
        while (recentCwds.size > 10) recentCwds.removeAt(recentCwds.lastIndex)
        prefs.edit().putString("cwds", recentCwds.joinToString("\n")).apply()
    }

    fun removeCwd(cwd: String) {
        recentCwds.remove(cwd)
        prefs.edit().putString("cwds", recentCwds.joinToString("\n")).apply()
    }

    val customCommands = mutableStateListOf<String>().apply {
        addAll(prefs.getString("commands", "")!!.split("\u0001").filter { it.isNotBlank() })
    }

    fun addCommand(text: String) {
        if (text.isBlank() || customCommands.contains(text)) return
        customCommands.add(text)
        prefs.edit().putString("commands", customCommands.joinToString("\u0001")).apply()
    }

    fun removeCommand(text: String) {
        customCommands.remove(text)
        prefs.edit().putString("commands", customCommands.joinToString("\u0001")).apply()
    }

    val defaultCommands = listOf(
        "继续",
        "总结目前的进展，列出下一步计划",
        "运行项目的测试并修复所有失败",
    )

    companion object {
        @Volatile
        var appForeground = true
        const val LOST_REPLY_PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]"
    }

    var screen by mutableStateOf(Screen.Sessions)
    val listTab = mutableIntStateOf(0)
    var sessionListFilter by mutableStateOf(SessionListFilter())
    var roomListFilter by mutableStateOf(RoomListFilter())
    var connecting by mutableStateOf(false)
    var connectError by mutableStateOf<String?>(null)
    var agentStatus by mutableStateOf("未连接")
    var currentProfile by mutableStateOf<ConnProfile?>(null)

    val sessions = mutableStateListOf<SessionInfo>()
    val rooms = mutableStateListOf<RoomInfo>()
    val roles = mutableStateListOf<RoleInfo>()
    val connections = mutableStateListOf<ConnectionInfo>()
    var currentSession by mutableStateOf<SessionInfo?>(null)
    var currentRoom by mutableStateOf<RoomInfo?>(null)
    val chatItems = mutableStateListOf<ChatItem>()
    val busyIds = mutableStateListOf<String>()
    val pendingAttachments = mutableStateListOf<Attachment>()
    var quote by mutableStateOf<Pair<String, String>?>(null)

    var showModelPicker by mutableStateOf(false)
    val modelList = mutableStateListOf<ModelInfo>()
    var modelFilter by mutableStateOf("")
    var modelCurrent by mutableStateOf("")

    init {
        prefs.getStringSet("profiles", emptySet())!!.forEach { line ->
            val parts = line.split("\u0001")
            if (parts.size == 4) {
                profiles.add(ConnProfile(parts[0], parts[1], parts[2], parts[3]))
            }
        }
        prefs.getString("last", null)?.let { line ->
            val parts = line.split("\u0001")
            if (parts.size == 3) {
                val (address, port, token) = parts
                val profile = profiles.find { it.address == address && it.port == port }
                    ?: ConnProfile(
                        address.removePrefix("wss://").removePrefix("ws://")
                            .substringBefore("/").substringBefore(":").substringBefore("?"),
                        address, port, token,
                    )
                currentProfile = profile
                connect(address, port, token, profile.name)
            }
        }
    }

    private fun persistProfiles() {
        prefs.edit().putStringSet(
            "profiles",
            profiles.map { "${it.name}\u0001${it.address}\u0001${it.port}\u0001${it.token}" }.toSet(),
        ).apply()
    }

    fun deleteProfile(p: ConnProfile) {
        if (currentProfile == p) {
            disconnect()
        }
        profiles.remove(p)
        persistProfiles()
    }

    fun switchProfile(p: ConnProfile) {
        if (currentProfile == p) return
        connect(p.address, p.port, p.token, p.name)
    }

    fun upsertProfile(
        old: ConnProfile?,
        name: String,
        address: String,
        port: String,
        token: String,
        connectNow: Boolean = false,
    ) {
        val newProfile = ConnProfile(
            name.ifBlank {
                address.removePrefix("wss://").removePrefix("ws://")
                    .substringBefore("/").substringBefore(":").substringBefore("?")
            },
            address, port, token,
        )
        if (old != null) {
            profiles.remove(old)
        }
        profiles.removeAll { it.address == address && it.port == port }
        profiles.add(newProfile)
        if (connectNow) {
            currentProfile = newProfile
        } else if (currentProfile == old && old?.address == address && old.port == port) {
            currentProfile = newProfile
        }
        persistProfiles()
        if (connectNow) {
            connect(address, port, token, newProfile.name)
        }
    }

    private fun saveProfile(address: String, port: String, token: String, name: String? = null) {
        val derived = address.removePrefix("wss://").removePrefix("ws://")
            .substringBefore("/").substringBefore(":").substringBefore("?")
        val profileName = name?.takeIf { it.isNotBlank() } ?: derived
        profiles.removeAll { it.address == address && it.port == port }
        val profile = ConnProfile(profileName, address, port, token)
        profiles.add(profile)
        currentProfile = profile
        persistProfiles()
        prefs.edit().putString("last", "$address\u0001$port\u0001$token").apply()
        if (screen == Screen.Connect) screen = Screen.Sessions
    }

    private fun startHubService() {
        val app = getApplication<Application>()
        app.startForegroundService(Intent(app, HubService::class.java))
    }

    var themeMode by mutableStateOf(prefs.getString("theme", "system") ?: "system")
    var lang by mutableStateOf(prefs.getString("lang", "zh") ?: "zh")

    fun updateThemeMode(mode: String) {
        themeMode = mode
        prefs.edit().putString("theme", mode).apply()
    }

    fun updateLang(l: String) {
        lang = l
        prefs.edit().putString("lang", l).apply()
    }

    val generating: Boolean
        get() {
            val room = currentRoom
            if (room != null) return room.members.any { busyIds.contains(it.first) }
            val s = currentSession ?: return false
            return busyIds.contains(s.sessionId)
        }

    private var itemSeq = 0L
    private var eventJob: Job? = null

    fun sessionName(sessionId: String): String =
        currentRoom?.members?.find { it.first == sessionId }?.second
            ?: sessions.find { it.sessionId == sessionId }?.let { displayName(it) }
            ?: sessionId

    fun sessionOrigin(s: SessionInfo): String {
        if (s.connectionId != null) {
            connections.find { it.id == s.connectionId }?.let { return it.name }
        }
        return s.address
    }

    fun displayName(s: SessionInfo): String {
        val origin = sessionOrigin(s)
        return if (origin.isNotBlank()) "${s.name} (${origin})" else s.name
    }

    fun sessionStatuses(s: SessionInfo): List<SessionStatus> = buildList {
        if (s.archived) add(SessionStatus.Archived)
        when {
            s.offline -> add(SessionStatus.Offline)
            s.busy || busyIds.contains(s.sessionId) -> add(SessionStatus.Busy)
            !s.archived -> add(SessionStatus.Online)
        }
        if (pinnedIds.contains(s.sessionId)) add(SessionStatus.Pinned)
    }

    fun filteredSessionGroups(): List<SessionListGroup> {
        val filter = sessionListFilter
        val q = filter.query.trim().lowercase()
        val filtered = sessions.filter { s ->
            if (filter.agents.isNotEmpty() && s.agent !in filter.agents) return@filter false
            if (filter.cwds.isNotEmpty() && s.cwd !in filter.cwds) return@filter false
            val st = sessionStatuses(s)
            if (filter.statuses.isNotEmpty() && !filter.statuses.any { it in st }) return@filter false
            if (q.isNotEmpty()) {
                val hay = "${s.name} ${s.cwd} ${s.agent} ${sessionOrigin(s)}".lowercase()
                if (!hay.contains(q)) return@filter false
            }
            true
        }.sortedWith(
            compareByDescending<SessionInfo> { !it.archived }
                .thenByDescending { pinnedIds.contains(it.sessionId) }
                .thenBy { it.name.lowercase() }
        )
        return when (filter.groupBy) {
            SessionGroupBy.None -> listOf(SessionListGroup("", filtered))
            SessionGroupBy.Agent -> filtered.groupBy { it.agent }.toSortedMap().map { (k, v) -> SessionListGroup(k, v) }
            SessionGroupBy.Cwd -> filtered.groupBy { it.cwd }.toSortedMap().map { (k, v) -> SessionListGroup(k, v) }
        }
    }

    fun filteredRoomGroups(): List<RoomListGroup> {
        val filter = roomListFilter
        val q = filter.query.trim().lowercase()
        val filtered = rooms.filter { r ->
            if (filter.modes.isNotEmpty() && r.mode !in filter.modes) return@filter false
            if (q.isNotEmpty()) {
                val members = r.members.joinToString(" ") { it.second }.lowercase()
                val modeLabel = r.mode.lowercase()
                val hay = "${r.name} $modeLabel $members".lowercase()
                if (!hay.contains(q)) return@filter false
            }
            true
        }.sortedWith(
            compareBy<RoomInfo> { it.name.lowercase() }
        )
        return when (filter.groupBy) {
            RoomGroupBy.None -> listOf(RoomListGroup("", filtered))
            RoomGroupBy.Mode -> filtered.groupBy { it.mode }.map { (k, v) -> RoomListGroup(k, v) }
                .sortedBy { it.title }
        }
    }

    fun refreshBusy() {
        viewModelScope.launch {
            if (!hub.isConnected) return@launch
            try { syncBusyIds() } catch (_: Exception) {}
        }
    }

    fun toggleBypass(arg: String? = null) {
        viewModelScope.launch {
            try {
                val enabled = when (arg?.lowercase()) {
                    "on", "true", "1" -> true
                    "off", "false", "0" -> false
                    else -> null
                }
                val result = hub.call("permission.bypass", buildJsonObject {
                    if (enabled != null) put("enabled", enabled)
                })
                val bypass = result["bypass"]?.jsonPrimitive?.content?.toBoolean() ?: false
                val S = stringsFor(lang)
                chatItems.add(ChatItem.System(++itemSeq, if (bypass) S.bypassEnabled else S.bypassDisabled))
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "bypass failed"))
            }
        }
    }

    private fun handleModelSlash(arg: String?) {
        viewModelScope.launch {
            val S = stringsFor(lang)
            try {
                if (arg.isNullOrBlank()) {
                    loadModelList()
                } else {
                    val result = hub.call("model.set", buildJsonObject { put("model", arg) })
                    val model = result["model"]?.jsonObject
                    if (model != null) {
                        val uid = model["uid"]?.jsonPrimitive?.content ?: arg
                        val label = model["label"]?.jsonPrimitive?.content ?: ""
                        val cost = formatModelCost(S, model)
                        chatItems.add(ChatItem.System(++itemSeq, S.modelSwitched.format(uid, "$label $cost").trim()))
                    } else {
                        chatItems.add(ChatItem.Error(++itemSeq, S.modelUnknown.format(arg)))
                    }
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
            }
        }
    }

    fun loadModelList() {
        viewModelScope.launch {
            try {
                val result = hub.call("model.list")
                val current = result["current"]?.jsonPrimitive?.content ?: ""
                modelCurrent = current
                modelList.clear()
                val list = result["models"]?.jsonArray ?: emptyList()
                modelList.addAll(list.map { it.jsonObject.toModelInfo(current) })
                modelFilter = ""
                showModelPicker = true
            } catch (e: Exception) {
                val S = stringsFor(lang)
                chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
            }
        }
    }

    fun switchModel(model: ModelInfo) {
        viewModelScope.launch {
            val S = stringsFor(lang)
            try {
                val result = hub.call("model.set", buildJsonObject { put("model", model.uid) })
                val m = result["model"]?.jsonObject
                if (m != null) {
                    val uid = m["uid"]?.jsonPrimitive?.content ?: model.uid
                    val label = m["label"]?.jsonPrimitive?.content ?: ""
                    val cost = formatModelCost(S, m)
                    chatItems.add(ChatItem.System(++itemSeq, S.modelSwitched.format(uid, "$label $cost").trim()))
                }
                showModelPicker = false
                modelFilter = ""
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "model switch failed"))
            }
        }
    }

    fun refreshModelList() {
        viewModelScope.launch {
            try {
                val result = hub.call("model.refresh")
                val current = result["current"]?.jsonPrimitive?.content ?: ""
                modelCurrent = current
                modelList.clear()
                val list = result["models"]?.jsonArray ?: emptyList()
                modelList.addAll(list.map { it.jsonObject.toModelInfo(current) })
            } catch (e: Exception) {
                val S = stringsFor(lang)
                chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
            }
        }
    }

    private fun formatModelCost(S: Strings, model: JsonObject): String {
        val tier = model["costTier"]?.jsonPrimitive?.content ?: ""
        val summary = model["costSummary"]?.jsonPrimitive?.content
        val tierName = when (tier) {
            "Free" -> S.costTierFree
            "Low cost" -> S.costTierLow
            "Med cost" -> S.costTierMed
            "High cost" -> S.costTierHigh
            else -> tier
        }
        return if (summary.isNullOrBlank()) "($tierName)" else "($tierName · $summary)"
    }

    data class SlashCommand(val name: String, val description: String)

    val slashCommands: List<SlashCommand>
        get() {
            val S = stringsFor(lang)
            return listOf(
                SlashCommand("help", S.slashHelpHelp),
                SlashCommand("stop", S.slashHelpStop),
                SlashCommand("bypass", S.slashHelpBypass),
                SlashCommand("model", S.slashHelpModel),
            )
        }

    private fun showSlashHelp() {
        val S = stringsFor(lang)
        chatItems.add(
            ChatItem.System(++itemSeq, 
                buildString {
                    appendLine(S.slashHelpTitle)
                    slashCommands.forEach { appendLine(it.description) }
                }.trim()
            )
        )
    }

    private fun handleSlashCommand(text: String): Boolean {
        if (!text.startsWith("/")) return false
        val parts = text.substring(1).trim().split("""\s+""".toRegex()).filter { it.isNotBlank() }
        val command = parts.firstOrNull() ?: return false
        val arg = parts.drop(1).firstOrNull()
        when (command) {
            "help" -> showSlashHelp()
            "bypass" -> toggleBypass(arg)
            "stop" -> stopCurrent()
            "model", "models" -> handleModelSlash(arg)
            else -> {
                val S = stringsFor(lang)
                chatItems.add(ChatItem.Error(++itemSeq, "/$command\n${S.unknownCommandHint}"))
            }
        }
        return true
    }

    fun connect(host: String, port: String, token: String, name: String? = null) {
        disconnect()
        connecting = true
        connectError = null
        val url = if (host.startsWith("ws://") || host.startsWith("wss://")) {
            val sep = if (host.contains("?")) "&" else "?"
            "$host${sep}token=$token"
        } else {
            "ws://$host:$port/?token=$token"
        }
        hub.connect(url,
            onOpen = {
                viewModelScope.launch {
                    val firstConnect = connecting
                    connecting = false
                    connectError = null
                    saveProfile(host, port, token, name)
                    startHubService()
                    agentStatus = "已连接"
                    if (firstConnect) screen = Screen.Sessions
                    syncRefreshAll()
                    restoreCurrentScreen()
                }
            },
            onFailure = { msg ->
                if (connecting) {
                    connecting = false
                    connectError = msg
                } else {
                    agentStatus = "连接已断开，正在重连…"
                }
            })
        hub.onClosed = {
            if (connecting) {
                connecting = false
                connectError = "连接已断开"
            } else {
                agentStatus = "连接已断开，正在重连…"
            }
        }
        eventJob = viewModelScope.launch {
            hub.events.collect { handleEvent(it) }
        }
    }

    fun disconnect() {
        eventJob?.cancel()
        eventJob = null
        hub.disconnect()
        val app = getApplication<Application>()
        app.stopService(Intent(app, HubService::class.java))
        prefs.edit().remove("last").apply()
        sessions.clear()
        rooms.clear()
        roles.clear()
        connections.clear()
        chatItems.clear()
        busyIds.clear()
        currentSession = null
        currentRoom = null
        quote = null
        connecting = false
        connectError = null
        agentStatus = "未连接"
        currentProfile = null
        screen = Screen.Sessions
    }

    fun refreshAll() {
        viewModelScope.launch { syncRefreshAll() }
    }

    private suspend fun syncRefreshAll() {
        try {
            val cResult = hub.call("connection.list")
            val cList = cResult["connections"]?.jsonArray ?: return
                connections.clear()
                for (c in cList) {
                    val o = c.jsonObject
                    connections.add(
                        ConnectionInfo(
                            o["id"]!!.jsonPrimitive.content,
                            o["name"]!!.jsonPrimitive.content,
                            o["agent"]!!.jsonPrimitive.content,
                            o["token"]?.jsonPrimitive?.content ?: "",
                            o["address"]?.jsonPrimitive?.content ?: "",
                            o["cwd"]?.jsonPrimitive?.content ?: "",
                            o["online"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                            o["local"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        )
                    )
                }
            } catch (_: Exception) {
            }
            try {
                val result = hub.call("session.list")
                val list = result["sessions"]?.jsonArray ?: return
                sessions.clear()
                for (s in list) {
                    val o = s.jsonObject
                    sessions.add(
                        SessionInfo(
                            o["sessionId"]!!.jsonPrimitive.content,
                            o["cwd"]!!.jsonPrimitive.content,
                            o["name"]!!.jsonPrimitive.content,
                            o["busy"]!!.jsonPrimitive.content.toBoolean(),
                            o["agent"]?.jsonPrimitive?.content ?: "devin",
                            o["address"]?.jsonPrimitive?.content ?: "",
                            o["connectionId"]?.jsonPrimitive?.content,
                            o["roleId"]?.jsonPrimitive?.content,
                            o["offline"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                            o["archived"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                            o["stoppable"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        )
                    )
                }
                syncBusyIdsFromList(sessions)
            } catch (_: Exception) {
            }
            try {
                val result = hub.call("role.list")
                val list = result["roles"]?.jsonArray ?: return
                roles.clear()
                for (r in list) {
                    val o = r.jsonObject
                    roles.add(RoleInfo(
                        o["id"]!!.jsonPrimitive.content,
                        o["name"]!!.jsonPrimitive.content,
                        o["persona"]!!.jsonPrimitive.content,
                        o["cwd"]?.jsonPrimitive?.content,
                        o["agent"]?.jsonPrimitive?.content,
                        o["address"]?.jsonPrimitive?.content,
                        o["connectionId"]?.jsonPrimitive?.content,
                        o["builtin"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                    ))
                }
            } catch (_: Exception) {
            }
            try {
                val result = hub.call("room.list")
                val list = result["rooms"]?.jsonArray ?: return
                rooms.clear()
                for (r in list) {
                    val o = r.jsonObject
                    rooms.add(
                        RoomInfo(
                            o["roomId"]!!.jsonPrimitive.content,
                            o["name"]!!.jsonPrimitive.content,
                            o["mode"]?.jsonPrimitive?.content ?: "mention",
                            o["conductorId"]?.jsonPrimitive?.content,
                            o["members"]!!.jsonArray.map {
                                val m = it.jsonObject
                                m["sessionId"]!!.jsonPrimitive.content to
                                    m["name"]!!.jsonPrimitive.content
                            },
                        )
                    )
                }
            } catch (_: Exception) {
            }
        }

    private fun restoreCurrentScreen() {
        val room = currentRoom
        if (room != null) {
            val latestRoom = rooms.find { it.roomId == room.roomId } ?: room
            openRoom(latestRoom)
            return
        }
        val session = currentSession
        if (session != null) {
            val latestSession = sessions.find { it.sessionId == session.sessionId } ?: session
            if (latestSession.offline) {
                resumeSession(latestSession, autoOpen = true)
            } else {
                openChat(latestSession)
            }
        }
    }

    fun createSession(
        cwd: String,
        name: String,
        connectionId: String,
        roleId: String? = null,
    ) {
        viewModelScope.launch {
            try {
                val result = hub.call("session.create", buildJsonObject {
                    put("cwd", cwd)
                    put("name", name)
                    put("connectionId", connectionId)
                    roleId?.let { put("roleId", it) }
                })
                val o = result
                val session = SessionInfo(
                    o["sessionId"]!!.jsonPrimitive.content,
                    cwd,
                    o["name"]?.jsonPrimitive?.content ?: name,
                    false,
                    o["agent"]?.jsonPrimitive?.content ?: "devin",
                    o["address"]?.jsonPrimitive?.content ?: "",
                    o["connectionId"]?.jsonPrimitive?.content,
                    o["roleId"]?.jsonPrimitive?.content,
                    stoppable = false,
                )
                noteCwd(cwd)
                sessions.add(session)
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun cloneSession(session: SessionInfo, onCloned: ((SessionInfo) -> Unit)? = null) {
        viewModelScope.launch {
            try {
                val result = hub.call("session.clone", buildJsonObject {
                    put("sessionId", session.sessionId)
                })
                val o = result
                val newSession = SessionInfo(
                    o["sessionId"]!!.jsonPrimitive.content,
                    o["cwd"]?.jsonPrimitive?.content ?: session.cwd,
                    o["name"]?.jsonPrimitive?.content ?: "",
                    false,
                    o["agent"]?.jsonPrimitive?.content ?: session.agent,
                    o["address"]?.jsonPrimitive?.content ?: "",
                    o["connectionId"]?.jsonPrimitive?.content ?: session.connectionId,
                    o["roleId"]?.jsonPrimitive?.content ?: session.roleId,
                    stoppable = false,
                )
                sessions.add(newSession)
                onCloned?.invoke(newSession)
                val S = stringsFor(lang)
                chatItems.add(ChatItem.System(++itemSeq, S.clonedSession.format(newSession.name)))
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun createRole(
        name: String,
        persona: String,
        cwd: String,
        connectionId: String? = null,
    ) {
        viewModelScope.launch {
            try {
                hub.call("role.create", buildJsonObject {
                    put("name", name)
                    put("persona", persona)
                    if (cwd.isNotBlank()) put("cwd", cwd)
                    if (connectionId != null) put("connectionId", connectionId)
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun createConnection(name: String, agent: String, address: String, cwd: String, token: String = "", local: Boolean = false) {
        viewModelScope.launch {
            try {
                hub.call("connection.create", buildJsonObject {
                    put("name", name)
                    put("agent", agent)
                    if (address.isNotBlank()) put("address", address)
                    if (cwd.isNotBlank()) put("cwd", cwd)
                    if (token.isNotBlank()) put("token", token)
                    if (local) put("local", true)
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteConnection(id: String) {
        viewModelScope.launch {
            try {
                hub.call("connection.delete", buildJsonObject { put("id", id) })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteRole(id: String) {
        viewModelScope.launch {
            try {
                hub.call("role.delete", buildJsonObject { put("id", id) })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun createRoom(name: String, memberIds: List<String>, mode: String, conductorId: String?) {
        viewModelScope.launch {
            try {
                val result = hub.call("room.create", buildJsonObject {
                    put("name", name)
                    put("sessionIds", buildJsonArray { memberIds.forEach { add(it) } })
                    put("mode", mode)
                    if (conductorId != null) put("conductorId", conductorId)
                })
                val o = result["room"]!!.jsonObject
                val room = parseRoom(o)
                rooms.add(room)
                openRoom(room)
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun renameRoom(room: RoomInfo, name: String) {
        viewModelScope.launch {
            connectError = null
            val trimmed = name.trim()
            if (trimmed.isBlank()) return@launch
            try {
                hub.call("room.rename", buildJsonObject {
                    put("roomId", room.roomId)
                    put("name", trimmed)
                })
                val idx = rooms.indexOfFirst { it.roomId == room.roomId }
                if (idx >= 0) rooms[idx] = rooms[idx].copy(name = trimmed)
                if (currentRoom?.roomId == room.roomId) {
                    currentRoom = currentRoom?.copy(name = trimmed)
                }
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun updateRoom(room: RoomInfo, name: String, memberIds: List<String>, mode: String, conductorId: String?) {
        viewModelScope.launch {
            connectError = null
            val trimmed = name.trim()
            if (trimmed.isBlank()) return@launch
            try {
                val result = hub.call("room.update", buildJsonObject {
                    put("roomId", room.roomId)
                    put("name", trimmed)
                    put("sessionIds", buildJsonArray { memberIds.forEach { add(it) } })
                    put("mode", mode)
                    if (conductorId != null) put("conductorId", conductorId)
                })
                val o = result["room"]!!.jsonObject
                val updated = parseRoom(o)
                val idx = rooms.indexOfFirst { it.roomId == room.roomId }
                if (idx >= 0) rooms[idx] = updated
                if (currentRoom?.roomId == room.roomId) currentRoom = updated
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun cloneRoom(room: RoomInfo, newName: String, onCloned: ((RoomInfo) -> Unit)? = null) {
        viewModelScope.launch {
            try {
                val result = hub.call("room.clone", buildJsonObject {
                    put("roomId", room.roomId)
                    put("newName", newName)
                })
                val o = result["room"]!!.jsonObject
                val newRoom = parseRoom(o)
                rooms.add(newRoom)
                refreshAll()
                onCloned?.invoke(newRoom)
                val S = stringsFor(lang)
                chatItems.add(ChatItem.System(++itemSeq, S.clonedRoom.format(newRoom.name)))
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteRoom(room: RoomInfo) {
        viewModelScope.launch {
            try {
                hub.call("room.delete", buildJsonObject {
                    put("roomId", room.roomId)
                })
                if (currentRoom?.roomId == room.roomId) backToList()
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    private fun parseRoom(o: JsonObject): RoomInfo = RoomInfo(
        o["roomId"]!!.jsonPrimitive.content,
        o["name"]!!.jsonPrimitive.content,
        o["mode"]?.jsonPrimitive?.content ?: "mention",
        o["conductorId"]?.jsonPrimitive?.content,
        o["members"]!!.jsonArray.map {
            val m = it.jsonObject
            m["sessionId"]!!.jsonPrimitive.content to
                m["name"]!!.jsonPrimitive.content
        },
        o["subMode"]?.jsonPrimitive?.content,
        o["activeSpeaker"]?.jsonPrimitive?.content,
        o["reason"]?.jsonPrimitive?.content,
    )

    fun openChat(session: SessionInfo, anchorAt: Long? = null) {
        if (session.offline) {
            resumeSession(session, autoOpen = true)
            return
        }
        listTab.value = 0
        currentSession = session
        currentRoom = null
        chatItems.clear()
        quote = null
        if (anchorAt == null) {
            inChatSearchQuery = ""
            jumpToHistoryId = null
        }
        chatSearchMatchIndex = -1
        chatSearchMatchCount = 0
        screen = Screen.Chat
        loadHistory("session.history", "sessionId", session.sessionId, anchorAt)
    }

    fun openRoom(room: RoomInfo, anchorAt: Long? = null) {
        viewModelScope.launch {
            connectError = null
            try {
                syncRefreshAll()
                val latestRoom = rooms.find { it.roomId == room.roomId } ?: room
                val toResume = latestRoom.members.mapNotNull { (sid, _) ->
                    sessions.find { it.sessionId == sid && it.offline }
                }
                for (s in toResume) {
                    resumeOne(s)
                }
                syncRefreshAll()
                val updatedRoom = rooms.find { it.roomId == room.roomId } ?: room
                listTab.value = 1
                currentRoom = updatedRoom
                currentSession = null
                chatItems.clear()
                quote = null
                if (anchorAt == null) {
                    inChatSearchQuery = ""
                    jumpToHistoryId = null
                }
                chatSearchMatchIndex = -1
                chatSearchMatchCount = 0
                screen = Screen.Room
                loadHistory("room.history", "roomId", updatedRoom.roomId, anchorAt)
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    private suspend fun resumeOne(session: SessionInfo): SessionInfo? {
        val result = hub.call("session.resume", buildJsonObject {
            put("sessionId", session.sessionId)
        })
        return if (result["resumed"]?.jsonPrimitive?.content?.toBoolean() == true) {
            val newSessionId = result["sessionId"]?.jsonPrimitive?.content
            if (newSessionId != null && newSessionId != session.sessionId) {
                val newSession = session.copy(sessionId = newSessionId, offline = false)
                val oldIdx = sessions.indexOfFirst { it.sessionId == session.sessionId }
                if (oldIdx >= 0) sessions.removeAt(oldIdx)
                sessions.add(0, newSession)
                newSession
            } else {
                val idx = sessions.indexOfFirst { it.sessionId == session.sessionId }
                if (idx >= 0) sessions[idx] = session.copy(offline = false)
                session.copy(offline = false)
            }
        } else null
    }

    fun resumeSession(session: SessionInfo, autoOpen: Boolean = false) {
        viewModelScope.launch {
            connectError = null
            try {
                val updated = resumeOne(session)
                if (updated != null && autoOpen) {
                    openChat(updated)
                } else if (updated == null) {
                    connectError = "恢复失败：agent 不支持或会话已失效"
                }
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun renameSession(session: SessionInfo, name: String) {
        viewModelScope.launch {
            connectError = null
            val trimmed = name.trim()
            if (trimmed.isBlank()) return@launch
            try {
                hub.call("session.rename", buildJsonObject {
                    put("sessionId", session.sessionId)
                    put("name", trimmed)
                })
                val idx = sessions.indexOfFirst { it.sessionId == session.sessionId }
                if (idx >= 0) sessions[idx] = session.copy(name = trimmed)
                if (currentSession?.sessionId == session.sessionId) {
                    currentSession = currentSession?.copy(name = trimmed)
                }
                rooms.forEachIndexed { i, room ->
                    if (room.members.any { it.first == session.sessionId }) {
                        rooms[i] = room.copy(
                            members = room.members.map {
                                if (it.first == session.sessionId) it.first to trimmed else it
                            },
                        )
                    }
                }
                if (currentRoom?.members?.any { it.first == session.sessionId } == true) {
                    currentRoom = currentRoom?.copy(
                        members = currentRoom!!.members.map {
                            if (it.first == session.sessionId) it.first to trimmed else it
                        },
                    )
                }
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    private fun loadHistory(method: String, idKey: String, id: String, anchorAt: Long? = null) {
        viewModelScope.launch {
            try {
                val params = buildJsonObject {
                    put(idKey, id)
                    if (anchorAt != null) put("anchorAt", anchorAt)
                }
                val result = hub.call(method, params)
                val entries = result["entries"]?.jsonArray ?: return@launch
                val items = mutableListOf<ChatItem>()
                for (e in entries) {
                    val o = e.jsonObject
                    val kind = o["kind"]!!.jsonPrimitive.content
                    val author = o["author"]!!.jsonPrimitive.content
                    val text = o["text"]!!.jsonPrimitive.content
                    val historyId = o["id"]?.jsonPrimitive?.content?.toLongOrNull()
                    val itemId = if (historyId != null) -historyId else ++itemSeq
                    when (kind) {
                        "user" -> items.add(ChatItem.User(itemId, text))
                        "assistant" -> if (text == LOST_REPLY_PLACEHOLDER) {
                            items.add(ChatItem.System(itemId, "上一条回复在 Hub 重启中丢失"))
                        } else {
                            items.add(ChatItem.Assistant(itemId, text, author))
                        }
                        "system" -> items.add(ChatItem.System(itemId, text))
                    }
                }
                chatItems.addAll(items)
                syncBusyIds()
            } catch (_: Exception) {
            }
        }
    }

    private fun syncBusyIdsFromList(list: List<SessionInfo>) {
        val currentIds = currentRoom?.members?.map { it.first }?.toSet()
            ?: setOfNotNull(currentSession?.sessionId)
        if (currentIds.isEmpty()) return
        val busy = list.filter { it.busy && it.stoppable && currentIds.contains(it.sessionId) }
            .map { it.sessionId }
            .toSet()
        busyIds.removeAll { !busy.contains(it) && currentIds.contains(it) }
        busy.forEach { if (!busyIds.contains(it)) busyIds.add(it) }
    }

    private suspend fun syncBusyIds() {
        if (!hub.isConnected) return
        try {
            val result = hub.call("session.list")
            val list = result["sessions"]?.jsonArray ?: return
            val sessionsList = mutableListOf<SessionInfo>()
            for (s in list) {
                val o = s.jsonObject
                sessionsList.add(
                    SessionInfo(
                        o["sessionId"]?.jsonPrimitive?.content ?: continue,
                        o["cwd"]?.jsonPrimitive?.content ?: continue,
                        o["name"]?.jsonPrimitive?.content ?: continue,
                        o["busy"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        o["agent"]?.jsonPrimitive?.content ?: "devin",
                        o["address"]?.jsonPrimitive?.content ?: "",
                        o["connectionId"]?.jsonPrimitive?.content,
                        o["roleId"]?.jsonPrimitive?.content,
                        o["offline"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        o["archived"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        o["stoppable"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                    )
                )
            }
            syncBusyIdsFromList(sessionsList)
        } catch (_: Exception) {
        }
    }

    val searchGroups = mutableStateListOf<SearchGroup>()
    val searchResults = mutableStateListOf<SearchHit>()
    var selectedSearchGroup by mutableStateOf<SearchGroup?>(null)
    var searchQuery by mutableStateOf("")
    var inChatSearchQuery by mutableStateOf("")
    var jumpToHistoryId by mutableStateOf<Long?>(null)
    var chatSearchMatchIndex by mutableIntStateOf(-1)
    var chatSearchMatchCount by mutableIntStateOf(0)
    private var searchJob: Job? = null

    suspend fun search(query: String) {
        try {
            searchGroups.clear()
            searchResults.clear()
            selectedSearchGroup = null
            if (query.isBlank()) return
            val result = hub.call("history.searchGroups", buildJsonObject {
                put("query", query)
                put("limit", 30)
                put("previewLimit", 1)
            })
            for (g in result["groups"]?.jsonArray ?: return) {
                val o = g.jsonObject
                val previews = o["previews"]?.jsonArray?.map { p ->
                    val po = p.jsonObject
                    SearchHit(
                        scope = po["scope"]?.jsonPrimitive?.content ?: "session",
                        scopeId = po["scopeId"]?.jsonPrimitive?.content ?: "",
                        author = po["author"]?.jsonPrimitive?.content ?: "",
                        text = po["text"]?.jsonPrimitive?.content ?: "",
                        historyId = po["id"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                        at = po["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    )
                } ?: emptyList()
                searchGroups.add(SearchGroup(
                    scope = o["scope"]?.jsonPrimitive?.content ?: "session",
                    scopeId = o["scopeId"]?.jsonPrimitive?.content ?: "",
                    count = o["count"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                    previews = previews,
                ))
            }
        } catch (_: Exception) {
        }
    }

    fun scheduleSearch(query: String) {
        searchQuery = query
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(300)
            search(query)
        }
    }

    fun openSearchGroup(group: SearchGroup) {
        viewModelScope.launch {
            try {
                selectedSearchGroup = group
                searchResults.clear()
                val result = hub.call("history.search", buildJsonObject {
                    put("query", searchQuery)
                    put("scope", group.scope)
                    put("scopeId", group.scopeId)
                    put("limit", 200)
                })
                for (r in result["results"]?.jsonArray ?: return@launch) {
                    val o = r.jsonObject
                    searchResults.add(SearchHit(
                        scope = o["scope"]!!.jsonPrimitive.content,
                        scopeId = o["scopeId"]!!.jsonPrimitive.content,
                        author = o["author"]!!.jsonPrimitive.content,
                        text = o["text"]!!.jsonPrimitive.content,
                        historyId = o["id"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                        at = o["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                    ))
                }
            } catch (_: Exception) {
            }
        }
    }

    fun clearSearchScope() {
        selectedSearchGroup = null
        searchResults.clear()
    }

    fun openSearchHit(hit: SearchHit) {
        inChatSearchQuery = searchQuery
        jumpToHistoryId = hit.historyId.takeIf { it != 0L }
        chatSearchMatchIndex = -1
        chatSearchMatchCount = 0
        val anchorAt = hit.at.takeIf { it > 0 }
        if (hit.scope == "session") {
            sessions.find { it.sessionId == hit.scopeId }?.let { openChat(it, anchorAt) }
        } else {
            rooms.find { it.roomId == hit.scopeId }?.let { openRoom(it, anchorAt) }
        }
    }

    fun nextChatSearchMatch() {
        if (chatSearchMatchCount <= 0) return
        chatSearchMatchIndex = (chatSearchMatchIndex + 1).coerceAtMost(chatSearchMatchCount - 1)
    }

    fun prevChatSearchMatch() {
        if (chatSearchMatchCount <= 0) return
        chatSearchMatchIndex = (chatSearchMatchIndex - 1).coerceAtLeast(0)
    }

    fun archiveSession(session: SessionInfo, archived: Boolean) {
        viewModelScope.launch {
            try {
                hub.call("session.archive", buildJsonObject {
                    put("sessionId", session.sessionId)
                    put("archived", archived)
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteSession(session: SessionInfo) {
        viewModelScope.launch {
            try {
                hub.call("session.delete", buildJsonObject {
                    put("sessionId", session.sessionId)
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteSessions(sessionIds: List<String>) {
        viewModelScope.launch {
            try {
                hub.call("session.deleteBatch", buildJsonObject {
                    put("sessionIds", buildJsonArray { sessionIds.forEach { add(it) } })
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun deleteRooms(roomIds: List<String>) {
        viewModelScope.launch {
            try {
                hub.call("room.deleteBatch", buildJsonObject {
                    put("roomIds", buildJsonArray { roomIds.forEach { add(it) } })
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun batchDelete(sessionIds: List<String>, roomIds: List<String>) {
        viewModelScope.launch {
            try {
                if (sessionIds.isNotEmpty()) {
                    hub.call("session.deleteBatch", buildJsonObject {
                        put("sessionIds", buildJsonArray { sessionIds.forEach { add(it) } })
                    })
                }
                if (roomIds.isNotEmpty()) {
                    hub.call("room.deleteBatch", buildJsonObject {
                        put("roomIds", buildJsonArray { roomIds.forEach { add(it) } })
                    })
                }
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun backToList() {
        currentSession = null
        currentRoom = null
        jumpToHistoryId = null
        chatSearchMatchIndex = -1
        chatSearchMatchCount = 0
        refreshAll()
        screen = Screen.Sessions
    }

    fun sendPrompt(text: String) {
        val session = currentSession ?: return
        if (text.isBlank() && pendingAttachments.isEmpty()) return
        if (handleSlashCommand(text)) return
        val q = quote
        val attachments = pendingAttachments.toList()
        chatItems.add(
            ChatItem.User(
                ++itemSeq,
                text,
                attachments,
                quoteAuthor = q?.first,
                quoteText = q?.second,
            ),
        )
        quote = null
        pendingAttachments.clear()
        val fullText = if (q != null) "（引用 ${q.first} 的消息：\"${q.second.take(300)}\"）\n$text" else text
        busyIds.add(session.sessionId)
        viewModelScope.launch {
            try {
                hub.call("prompt.send", buildJsonObject {
                    put("sessionId", session.sessionId)
                    put("content", buildJsonArray {
                        if (fullText.isNotBlank()) {
                            add(buildJsonObject {
                                put("type", "text")
                                put("text", fullText)
                            })
                        }
                        attachments.forEach { a ->
                            add(buildJsonObject {
                                put("type", "image")
                                put("mimeType", a.mimeType)
                                put("data", a.base64)
                            })
                        }
                    })
                })
            } catch (e: Exception) {
                busyIds.remove(session.sessionId)
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "send failed"))
            }
        }
    }

    fun sendRoomMessage(text: String) {
        val room = currentRoom ?: return
        if (text.isBlank() && pendingAttachments.isEmpty()) return
        if (handleSlashCommand(text)) return
        val q = quote
        val attachments = pendingAttachments.toList()
        chatItems.add(
            ChatItem.User(
                ++itemSeq,
                text,
                attachments,
                quoteAuthor = q?.first,
                quoteText = q?.second,
            ),
        )
        quote = null
        pendingAttachments.clear()
        viewModelScope.launch {
            try {
                val content = buildJsonArray {
                    if (text.isNotBlank()) {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", text)
                        })
                    }
                    attachments.forEach { a ->
                        add(buildJsonObject {
                            put("type", "image")
                            put("mimeType", a.mimeType)
                            put("data", a.base64)
                        })
                    }
                }
                val result = hub.call("room.message", buildJsonObject {
                    put("roomId", room.roomId)
                    put("text", text)
                    put("content", content)
                    if (q != null) {
                        put("quote", buildJsonObject {
                            put("author", q.first)
                            put("text", q.second)
                        })
                    }
                })
                result["sent"]?.jsonArray?.forEach {
                    val sid = it.jsonPrimitive.content
                    if (!busyIds.contains(sid)) busyIds.add(sid)
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "send failed"))
            }
        }
    }

    fun addAttachment(uri: Uri) {
        viewModelScope.launch {
            try {
                val cr = getApplication<Application>().contentResolver
                val mime = cr.getType(uri) ?: inferMimeType(uri)
                val bytes = withContext(Dispatchers.IO) {
                    cr.openInputStream(uri)?.use { it.readBytes() } ?: byteArrayOf()
                }
                if (bytes.isEmpty()) throw Exception("empty file")
                val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val name = uri.lastPathSegment ?: ""
                pendingAttachments.add(Attachment(mime, base64, name))
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "attach failed"))
            }
        }
    }

    fun removeAttachment(attachment: Attachment) {
        pendingAttachments.remove(attachment)
    }

    private fun inferMimeType(uri: Uri): String {
        val ext = uri.path?.substringAfterLast('.', "")?.lowercase()
        return when (ext) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            else -> "image/*"
        }
    }

    fun stopCurrent() {
        val targets = currentRoom?.members?.map { it.first }?.filter { busyIds.contains(it) }
            ?: listOfNotNull(currentSession?.sessionId?.takeIf { busyIds.contains(it) })
        targets.forEach { sid ->
            viewModelScope.launch {
                try {
                    hub.call("session.cancel", buildJsonObject { put("sessionId", sid) })
                } catch (_: Exception) {
                }
            }
        }
    }

    fun answerPermission(requestId: String, optionId: String, optionName: String) {
        val idx = chatItems.indexOfLast { it is ChatItem.Permission && it.requestId == requestId }
        if (idx >= 0) {
            val p = chatItems[idx] as ChatItem.Permission
            chatItems[idx] = p.copy(answered = optionName)
        }
        viewModelScope.launch {
            try {
                hub.call("permission.respond", buildJsonObject {
                    put("requestId", requestId)
                    put("optionId", optionId)
                })
            } catch (_: Exception) {
            }
        }
    }

    private fun inScope(sessionId: String): Boolean {
        val room = currentRoom
        if (room != null) return room.members.any { it.first == sessionId }
        return currentSession?.sessionId == sessionId
    }

    private fun shouldShowInRoom(sessionId: String): Boolean {
        val room = currentRoom ?: return true
        val sub = room.subMode
        return when {
            room.mode == "conductor" -> sessionId == room.conductorId
            room.mode == "auto" && (sub == "deciding" || sub == "self" || sub == "conductor" || sub == "roundrobin") -> sessionId == room.activeSpeaker
            else -> true
        }
    }

    private fun handleEvent(obj: JsonObject) {
        when (obj["method"]?.jsonPrimitive?.content) {
            "agent.status" -> {
                val p = obj["params"]!!.jsonObject
                agentStatus = p["status"]!!.jsonPrimitive.content +
                    (p["detail"]?.jsonPrimitive?.content?.let { " ($it)" } ?: "")
                refreshAll()
            }
            "session.generating" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                val stoppable = p["stoppable"]?.jsonPrimitive?.content?.toBoolean() ?: false
                if (!inScope(sid)) return
                if (stoppable) {
                    if (!busyIds.contains(sid)) busyIds.add(sid)
                } else {
                    busyIds.remove(sid)
                    refreshAll()
                }
            }
            "session.update" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                if (!inScope(sid)) return
                if (shouldShowInRoom(sid)) applyUpdate(sid, p["update"]!!.jsonObject)
            }
            "prompt.done" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                busyIds.remove(sid)
                refreshAll()
            }
            "prompt.error" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                busyIds.remove(sid)
                if ((inScope(sid) || sid.isEmpty()) && shouldShowInRoom(sid)) {
                    chatItems.add(
                        ChatItem.Error(++itemSeq, p["message"]!!.jsonPrimitive.content, sessionName(sid))
                    )
                }
            }
            "room.notice" -> {
                val p = obj["params"]!!.jsonObject
                if (p["roomId"]!!.jsonPrimitive.content == currentRoom?.roomId) {
                    chatItems.add(ChatItem.System(++itemSeq, p["message"]!!.jsonPrimitive.content))
                }
            }
            "room.modeSelected" -> {
                val p = obj["params"]!!.jsonObject
                val roomId = p["roomId"]!!.jsonPrimitive.content
                val r = currentRoom
                if (r != null && r.roomId == roomId) {
                    currentRoom = r.copy(
                        subMode = p["mode"]?.jsonPrimitive?.content,
                        activeSpeaker = p["activeSpeaker"]?.jsonPrimitive?.content,
                        reason = p["reason"]?.jsonPrimitive?.content,
                    )
                    val idx = rooms.indexOfFirst { it.roomId == roomId }
                    if (idx >= 0) rooms[idx] = currentRoom!!
                }
            }
            "permission.request" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                if (!inScope(sid)) return
                if (!busyIds.contains(sid)) busyIds.add(sid)
                val tool = p["toolCall"]!!.jsonObject
                val title = tool["title"]?.jsonPrimitive?.content ?: "工具调用"
                val options = p["options"]!!.jsonArray.map {
                    val o = it.jsonObject
                    o["optionId"]!!.jsonPrimitive.content to o["name"]!!.jsonPrimitive.content
                }
                chatItems.add(
                    ChatItem.Permission(++itemSeq, 
                        p["requestId"]!!.jsonPrimitive.content,
                        title,
                        options,
                        author = sessionName(sid),
                    )
                )
            }
        }
    }

    private fun applyUpdate(sessionId: String, u: JsonObject) {
        val author = sessionName(sessionId)
        when (u["sessionUpdate"]?.jsonPrimitive?.content) {
            "agent_message_chunk" -> {
                val text = u["content"]?.jsonObject?.get("text")?.jsonPrimitive?.content ?: return
                val last = chatItems.lastOrNull()
                if (last is ChatItem.Assistant && last.author == author) {
                    chatItems[chatItems.lastIndex] = last.copy(text = last.text + text)
                } else {
                    chatItems.add(ChatItem.Assistant(++itemSeq, text, author))
                }
            }
            "agent_thought_chunk" -> {
                val text = u["content"]?.jsonObject?.get("text")?.jsonPrimitive?.content ?: return
                val last = chatItems.lastOrNull()
                if (last is ChatItem.Thought && last.author == author) {
                    chatItems[chatItems.lastIndex] = last.copy(text = last.text + text)
                } else {
                    chatItems.add(ChatItem.Thought(++itemSeq, text, author))
                }
            }
            "tool_call" -> {
                chatItems.add(
                    ChatItem.Tool(++itemSeq, 
                        u["toolCallId"]!!.jsonPrimitive.content,
                        u["title"]?.jsonPrimitive?.content ?: "tool",
                        u["status"]?.jsonPrimitive?.content ?: "pending",
                        author,
                    )
                )
            }
            "tool_call_update" -> {
                val id = u["toolCallId"]!!.jsonPrimitive.content
                val idx = chatItems.indexOfLast { it is ChatItem.Tool && it.toolCallId == id }
                if (idx >= 0) {
                    val t = chatItems[idx] as ChatItem.Tool
                    chatItems[idx] = t.copy(
                        title = u["title"]?.jsonPrimitive?.content ?: t.title,
                        status = u["status"]?.jsonPrimitive?.content ?: t.status,
                    )
                }
            }
            "plan" -> {
                val entries = u["entries"]?.jsonArray?.map {
                    val e = it.jsonObject
                    val status = e["status"]?.jsonPrimitive?.content ?: ""
                    val content = e["content"]?.jsonPrimitive?.content ?: ""
                    "[$status] $content"
                } ?: return
                chatItems.add(ChatItem.Plan(++itemSeq, entries, author))
            }
        }
    }

    private fun JsonObject.toModelInfo(current: String): ModelInfo {
        val uid = this["uid"]?.jsonPrimitive?.content ?: ""
        val family = this["family"]?.jsonPrimitive?.content ?: ""
        return ModelInfo(
            uid = uid,
            label = this["label"]?.jsonPrimitive?.content ?: "",
            family = family,
            vendor = family.split(Regex("[-.\\s]")).firstOrNull { it.isNotBlank() } ?: family,
            slug = this["slug"]?.jsonPrimitive?.content ?: "",
            aliases = this["aliases"]?.jsonArray?.map { it.jsonPrimitive.content }?.filter { it.isNotBlank() } ?: emptyList(),
            costTier = this["costTier"]?.jsonPrimitive?.content ?: "",
            costSummary = this["costSummary"]?.jsonPrimitive?.content,
            isCurrent = uid == current,
        )
    }
}
