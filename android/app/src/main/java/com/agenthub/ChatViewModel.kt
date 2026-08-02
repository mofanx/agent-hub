package com.agenthub

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import com.agenthub.ui.stringsFor

sealed class ChatItem {
    abstract val author: String

    data class User(
        val text: String,
        override val author: String = "我",
        val quoteAuthor: String? = null,
        val quoteText: String? = null,
    ) : ChatItem()
    data class System(val text: String, override val author: String = "") : ChatItem()
    data class Assistant(val id: Long, val text: String, override val author: String) : ChatItem()
    data class Thought(val id: Long, val text: String, override val author: String) : ChatItem()
    data class Tool(
        val toolCallId: String,
        val title: String,
        val status: String,
        override val author: String,
    ) : ChatItem()
    data class Plan(val entries: List<String>, override val author: String) : ChatItem()
    data class Error(val text: String, override val author: String = "") : ChatItem()
    data class Permission(
        val requestId: String,
        val title: String,
        val options: List<Pair<String, String>>,
        val answered: String? = null,
        override val author: String,
    ) : ChatItem()
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
    val offline: Boolean = false,
    val archived: Boolean = false,
)

data class SearchHit(
    val scope: String,
    val scopeId: String,
    val author: String,
    val text: String,
)

data class RoomInfo(
    val roomId: String,
    val name: String,
    val mode: String,
    val conductorId: String?,
    val members: List<Pair<String, String>>,
)

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
    }

    init {
        prefs.getStringSet("profiles", emptySet())!!.forEach { line ->
            val parts = line.split("\u0001")
            if (parts.size == 4) {
                profiles.add(ConnProfile(parts[0], parts[1], parts[2], parts[3]))
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
        profiles.remove(p)
        persistProfiles()
    }

    private fun saveProfile(address: String, port: String, token: String) {
        val name = address.removePrefix("wss://").removePrefix("ws://")
            .substringBefore("/").substringBefore(":").substringBefore("?")
        profiles.removeAll { it.address == address && it.port == port }
        profiles.add(ConnProfile(name, address, port, token))
        persistProfiles()
        prefs.edit().putString("last", "$address\u0001$port\u0001$token").apply()
    }

    private fun startHubService() {
        val app = getApplication<Application>()
        app.startForegroundService(Intent(app, HubService::class.java))
    }

    var screen by mutableStateOf(Screen.Connect)
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

    var connecting by mutableStateOf(false)
    var connectError by mutableStateOf<String?>(null)
    var agentStatus by mutableStateOf("未连接")

    val sessions = mutableStateListOf<SessionInfo>()
    val rooms = mutableStateListOf<RoomInfo>()
    val roles = mutableStateListOf<RoleInfo>()
    val connections = mutableStateListOf<ConnectionInfo>()
    var currentSession by mutableStateOf<SessionInfo?>(null)
    var currentRoom by mutableStateOf<RoomInfo?>(null)
    val chatItems = mutableStateListOf<ChatItem>()
    val busyIds = mutableStateListOf<String>()
    var quote by mutableStateOf<Pair<String, String>?>(null)

    val generating: Boolean
        get() {
            val room = currentRoom
            if (room != null) return room.members.any { busyIds.contains(it.first) }
            val s = currentSession ?: return false
            return busyIds.contains(s.sessionId)
        }

    private var itemSeq = 0L

    fun sessionName(sessionId: String): String =
        sessions.find { it.sessionId == sessionId }?.let { displayName(it) }
            ?: currentRoom?.members?.find { it.first == sessionId }?.second
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
                chatItems.add(ChatItem.System(if (bypass) S.bypassEnabled else S.bypassDisabled))
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(e.message ?: "bypass failed"))
            }
        }
    }

    data class SlashCommand(val name: String, val description: String)

    val slashCommands: List<SlashCommand>
        get() {
            val S = stringsFor(lang)
            return listOf(
                SlashCommand("help", S.slashHelpHelp),
                SlashCommand("stop", S.slashHelpStop),
                SlashCommand("bypass", S.slashHelpBypass),
            )
        }

    private fun showSlashHelp() {
        val S = stringsFor(lang)
        chatItems.add(
            ChatItem.System(
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
            else -> {
                val S = stringsFor(lang)
                chatItems.add(ChatItem.Error("/$command\n${S.unknownCommandHint}"))
            }
        }
        return true
    }

    fun connect(host: String, port: String, token: String) {
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
                    connecting = false
                    saveProfile(host, port, token)
                    startHubService()
                    screen = Screen.Sessions
                    refreshAll()
                }
            },
            onFailure = { msg ->
                connecting = false
                connectError = msg
            })
        hub.onClosed = { agentStatus = "连接已断开" }
        viewModelScope.launch {
            hub.events.collect { handleEvent(it) }
        }
    }

    fun disconnect() {
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
        screen = Screen.Connect
    }

    fun refreshAll() {
        viewModelScope.launch {
            try {
                val cResult = hub.call("connection.list")
                val cList = cResult["connections"]?.jsonArray ?: return@launch
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
                val list = result["sessions"]?.jsonArray ?: return@launch
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
                            o["offline"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                            o["archived"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        )
                    )
                }
                syncBusyIdsFromList(sessions)
            } catch (_: Exception) {
            }
            try {
                val result = hub.call("role.list")
                val list = result["roles"]?.jsonArray ?: return@launch
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
                val list = result["rooms"]?.jsonArray ?: return@launch
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
                )
                noteCwd(cwd)
                sessions.add(session)
                openChat(session)
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
                val room = RoomInfo(
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
                rooms.add(room)
                openRoom(room)
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun openChat(session: SessionInfo) {
        currentSession = session
        currentRoom = null
        chatItems.clear()
        quote = null
        screen = Screen.Chat
        loadHistory("session.history", "sessionId", session.sessionId)
    }

    fun openRoom(room: RoomInfo) {
        currentRoom = room
        currentSession = null
        chatItems.clear()
        quote = null
        screen = Screen.Room
        loadHistory("room.history", "roomId", room.roomId)
    }

    fun resumeSession(session: SessionInfo) {
        viewModelScope.launch {
            connectError = null
            try {
                val result = hub.call("session.resume", buildJsonObject {
                    put("sessionId", session.sessionId)
                })
                if (result["resumed"]?.jsonPrimitive?.content?.toBoolean() == true) {
                    val idx = sessions.indexOfFirst { it.sessionId == session.sessionId }
                    if (idx >= 0) sessions[idx] = session.copy(offline = false)
                    openChat(session.copy(offline = false))
                } else {
                    connectError = "恢复失败：agent 不支持或会话已失效"
                }
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    private fun loadHistory(method: String, idKey: String, id: String) {
        viewModelScope.launch {
            try {
                val result = hub.call(method, buildJsonObject { put(idKey, id) })
                val entries = result["entries"]?.jsonArray ?: return@launch
                for (e in entries) {
                    val o = e.jsonObject
                    val kind = o["kind"]!!.jsonPrimitive.content
                    val author = o["author"]!!.jsonPrimitive.content
                    val text = o["text"]!!.jsonPrimitive.content
                    when (kind) {
                        "user" -> chatItems.add(ChatItem.User(text))
                        "assistant" -> chatItems.add(ChatItem.Assistant(++itemSeq, text, author))
                        "system" -> chatItems.add(ChatItem.System(text))
                    }
                }
                syncBusyIds()
            } catch (_: Exception) {
            }
        }
    }

    private fun syncBusyIdsFromList(list: List<SessionInfo>) {
        val currentIds = currentRoom?.members?.map { it.first }?.toSet()
            ?: setOfNotNull(currentSession?.sessionId)
        if (currentIds.isEmpty()) return
        val busy = list.filter { it.busy && currentIds.contains(it.sessionId) }
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
                        o["offline"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                        o["archived"]?.jsonPrimitive?.content?.toBoolean() ?: false,
                    )
                )
            }
            syncBusyIdsFromList(sessionsList)
        } catch (_: Exception) {
        }
    }

    val searchResults = mutableStateListOf<SearchHit>()

    fun search(query: String) {
        viewModelScope.launch {
            try {
                val result = hub.call("history.search", buildJsonObject { put("query", query) })
                searchResults.clear()
                for (r in result["results"]?.jsonArray ?: return@launch) {
                    val o = r.jsonObject
                    searchResults.add(SearchHit(
                        o["scope"]!!.jsonPrimitive.content,
                        o["scopeId"]!!.jsonPrimitive.content,
                        o["author"]!!.jsonPrimitive.content,
                        o["text"]!!.jsonPrimitive.content,
                    ))
                }
            } catch (_: Exception) {
            }
        }
    }

    fun openSearchHit(hit: SearchHit) {
        if (hit.scope == "session") {
            sessions.find { it.sessionId == hit.scopeId }?.let { openChat(it) }
        } else {
            rooms.find { it.roomId == hit.scopeId }?.let { openRoom(it) }
        }
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
        refreshAll()
        screen = Screen.Sessions
    }

    fun sendPrompt(text: String) {
        val session = currentSession ?: return
        if (handleSlashCommand(text)) return
        val q = quote
        chatItems.add(ChatItem.User(text, quoteAuthor = q?.first, quoteText = q?.second))
        quote = null
        val fullText = if (q != null) "（引用 ${q.first} 的消息：\"${q.second.take(300)}\"）\n$text" else text
        busyIds.add(session.sessionId)
        viewModelScope.launch {
            try {
                hub.call("prompt.send", buildJsonObject {
                    put("sessionId", session.sessionId)
                    put("text", fullText)
                })
            } catch (e: Exception) {
                busyIds.remove(session.sessionId)
                chatItems.add(ChatItem.Error(e.message ?: "send failed"))
            }
        }
    }

    fun sendRoomMessage(text: String) {
        val room = currentRoom ?: return
        if (handleSlashCommand(text)) return
        val q = quote
        chatItems.add(ChatItem.User(text, quoteAuthor = q?.first, quoteText = q?.second))
        quote = null
        viewModelScope.launch {
            try {
                val result = hub.call("room.message", buildJsonObject {
                    put("roomId", room.roomId)
                    put("text", text)
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
                chatItems.add(ChatItem.Error(e.message ?: "send failed"))
            }
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
        if (room.mode != "conductor") return true
        return sessionId == room.conductorId
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
                        ChatItem.Error(p["message"]!!.jsonPrimitive.content, sessionName(sid))
                    )
                }
            }
            "room.notice" -> {
                val p = obj["params"]!!.jsonObject
                if (p["roomId"]!!.jsonPrimitive.content == currentRoom?.roomId) {
                    chatItems.add(ChatItem.System(p["message"]!!.jsonPrimitive.content))
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
                    ChatItem.Permission(
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
                    ChatItem.Tool(
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
                chatItems.add(ChatItem.Plan(entries, author))
            }
        }
    }
}
