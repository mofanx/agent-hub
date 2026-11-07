package com.agenthub

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Environment
import android.util.Base64
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.State
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import com.agenthub.ui.Strings
import com.agenthub.ui.stringsFor
import com.agenthub.ui.splitMessageBlocks

data class Attachment(
    val mimeType: String,
    val base64: String,
    val name: String = "",
    /** base64 源文件（cacheDir）；非空时大附件不驻内存，发送/渲染按需读盘 */
    val localPath: String? = null,
) {
    fun readBase64(): String =
        if (base64.isNotEmpty()) base64
        else localPath?.let { runCatching { java.io.File(it).readText() }.getOrNull() } ?: ""

    /** 估算解码后字节数：内存态按 base64 长度，落盘态按 .b64 文件长度（同为 base64 文本） */
    val byteSize: Long
        get() = (if (base64.isNotEmpty()) base64.length.toLong()
            else localPath?.let { runCatching { java.io.File(it).length() }.getOrNull() } ?: 0L) * 3L / 4
}

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
    val backend: String = "devin",
)

data class SessionConfigOptionValue(
    val value: String,
    val name: String,
    val description: String? = null,
)

data class SessionConfigOption(
    val id: String,
    val name: String,
    val currentValue: String,
    val options: List<SessionConfigOptionValue>,
)

data class QuotaWindow(
    val remainingPercent: Int,
    val usedPercent: Int,
    val resetAtUnix: Long? = null,
)

data class BackendQuota(
    val available: Boolean,
    val planName: String? = null,
    val daily: QuotaWindow? = null,
    val weekly: QuotaWindow? = null,
)

data class ElicitationOption(val value: String, val label: String)

data class ElicitationField(
    val name: String,
    val label: String,
    val type: String,
    val required: Boolean,
    val description: String? = null,
    val options: List<ElicitationOption> = emptyList(),
    val defaultValue: JsonElement? = null,
)

sealed class ChatItem {
    abstract val id: Long
    abstract val author: String
    abstract val text: String
    abstract val at: Long

    data class User(
        override val id: Long,
        override val text: String,
        val attachments: List<Attachment> = emptyList(),
        override val author: String = "我",
        val quoteAuthor: String? = null,
        val quoteText: String? = null,
        override val at: Long = java.lang.System.currentTimeMillis(),
        val clientMessageId: String? = null,
        val historyId: Long? = null,
        val historyAt: Long? = null,
        val sendStatus: String? = null,
        val sendError: String? = null,
        val attachmentNames: List<String> = emptyList(),
    ) : ChatItem()
    data class System(
        override val id: Long,
        override val text: String,
        override val author: String = "",
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem()
    data class Assistant(override val id: Long, override val text: String, override val author: String, val usage: TokenUsage? = null, override val at: Long = java.lang.System.currentTimeMillis()) : ChatItem()
    data class Thought(override val id: Long, override val text: String, override val author: String, override val at: Long = java.lang.System.currentTimeMillis()) : ChatItem()
    data class Tool(
        override val id: Long,
        val toolCallId: String,
        val title: String,
        val status: String,
        override val author: String,
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem() {
        override val text: String get() = "[$title] $status"
    }
    data class Plan(
        override val id: Long,
        val entries: List<String>,
        override val author: String,
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem() {
        override val text: String get() = entries.joinToString("\n")
    }
    data class Error(
        override val id: Long,
        override val text: String,
        override val author: String = "",
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem()
    data class Permission(
        override val id: Long,
        val requestId: String,
        val title: String,
        val options: List<Pair<String, String>>,
        val answered: String? = null,
        override val author: String,
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem() {
        override val text: String get() = title
    }
    data class Elicitation(
        override val id: Long,
        val requestId: String,
        val message: String,
        val fields: List<ElicitationField>,
        val answered: String? = null,
        override val author: String,
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem() {
        override val text: String get() = message
    }
    /** 统一决策卡：kind:"decision" 房史条目（permission/elicitation 合并形态） */
    data class Decision(
        override val id: Long,
        val decisionId: String,
        val requestId: String,
        val decisionType: String,
        val title: String,
        val options: List<Pair<String, String>>,
        val status: String,
        val scope: String,
        val answerLabel: String? = null,
        val auto: Boolean = false,
        val contextSummary: String? = null,
        override val author: String,
        override val at: Long = 0L,
    ) : ChatItem() {
        override val text: String get() = title
    }
    data class ProcessStep(val kind: String, val title: String? = null, val text: String? = null)
    data class DispatchTask(val id: String? = null, val to: String? = null, val task: String? = null)
    data class Process(
        override val id: Long,
        val processId: String,
        val sessionId: String,
        val taskId: String?,
        val status: String,
        val steps: List<ProcessStep>,
        val turnStartAt: Long,
        val turnEndAt: Long,
        val cardType: String = "",
        val dispatchCount: Int = 0,
        val dispatchTasks: List<DispatchTask> = emptyList(),
        val flowId: String = "",
        override val author: String,
        override val at: Long = java.lang.System.currentTimeMillis(),
    ) : ChatItem() {
        override val text: String get() = steps.joinToString("\n") { it.title ?: it.text.orEmpty() }
    }
    /** 编排卡：kind:"flow" 房史条目，snapshot 为可独立渲染的终态/快照数据 */
    data class Flow(
        override val id: Long,
        val flowId: String,
        val snapshot: FlowInfo,
        override val author: String = "",
        override val at: Long = 0L,
    ) : ChatItem() {
        override val text: String get() =
            snapshot.goal ?: snapshot.tasks.joinToString("\n") { "@${it.name} ${it.task}" }
    }
}

/** 聊天列表里的可显示项：单个消息会按 Markdown 块展开为多个 ChatListItem.Message。 */
sealed class ChatListItem {
    abstract val id: String
    abstract val originalId: Long
    abstract val author: String
    abstract val text: String
    abstract val at: Long
    abstract val isFirst: Boolean

    data class Message(
        override val id: String,
        override val originalId: Long,
        override val author: String,
        override val text: String,
        val content: String,
        override val at: Long,
        val isUser: Boolean,
        override val isFirst: Boolean,
        val isLast: Boolean,
        val quoteAuthor: String? = null,
        val quoteText: String? = null,
        val attachments: List<Attachment> = emptyList(),
        val usage: TokenUsage? = null,
        val clientMessageId: String? = null,
        val sendStatus: String? = null,
        val sendError: String? = null,
        val attachmentNames: List<String> = emptyList(),
    ) : ChatListItem()

    data class Other(val item: ChatItem) : ChatListItem() {
        override val id: String get() = item.id.toString()
        override val originalId: Long get() = item.id
        override val author: String get() = item.author
        override val text: String get() = item.text
        override val at: Long get() = item.at
        override val isFirst: Boolean get() = true
    }

    data class ProcessGroup(
        override val id: String,
        override val originalId: Long,
        override val author: String,
        override val text: String,
        override val at: Long,
        val items: List<ChatItem>,
        override val isFirst: Boolean = true,
    ) : ChatListItem()

    /** 编排消息卡：key 用 flow:<flowId>，保证 LazyColumn 中稳定复用 */
    data class FlowCard(val item: ChatItem.Flow) : ChatListItem() {
        override val id: String get() = "flow:${item.flowId.ifEmpty { item.id.toString() }}"
        override val originalId: Long get() = item.id
        override val author: String get() = item.author
        override val text: String get() = item.text
        override val at: Long get() = item.at
        override val isFirst: Boolean get() = true
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
    val backendType: String? = null,
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
    val archived: Boolean = false,
    val subMode: String? = null,
    val activeSpeaker: String? = null,
    val reason: String? = null,
    val memberRoles: Map<String, String>? = null,
    val aliases: List<String> = emptyList(),
    val parallelSummarizerId: String? = null,
    val pipelineOrder: List<String>? = null,
    val debateSides: Pair<String, String>? = null,
    val debateJudge: String? = null,
    val debateRounds: Int? = null,
    val sensitivity: String = "shared",
)

data class FlowArtifact(
    val type: String,
    val path: String? = null,
    val summary: String = "",
)

data class MissionEvent(
    val id: String,
    val at: Long,
    val kind: String,
    val text: String,
    val flowId: String? = null,
    val taskId: String? = null,
    val sessionId: String? = null,
    val dispatchedAt: Long? = null,
    val phase: String? = null,
)

data class MissionReview(
    val index: Int,
    val verdict: String,
    val taskIds: List<String>,
    val note: String,
    val source: String = "user",
    val at: Long = 0,
)

data class MissionSupplement(
    val id: String,
    val at: Long,
    val text: String,
    val delivered: Boolean,
)

data class Mission(
    val id: String,
    val roomId: String,
    val goal: String,
    val acceptanceCriteria: List<String>,
    val scope: String,
    val constraints: List<String>,
    val ownerSessionId: String,
    val status: String,
    val createdAt: Long,
    val updatedAt: Long,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val flowId: String? = null,
    val flow: JsonObject? = null,
    val output: String? = null,
    val error: String? = null,
    val events: List<MissionEvent> = emptyList(),
    val reviews: List<MissionReview> = emptyList(),
    val acceptanceNote: String? = null,
    val supplements: List<MissionSupplement> = emptyList(),
    val parentMissionId: String? = null,
    val reworkReason: String? = null,
    val maxAutoRetries: Int = 0,
    val autoRetryCount: Int = 0,
    val revision: Int = 0,
    // 旧 Hub 不下发 revision 字段时为 false：此时 revision=0 是缺省值而非真实版本，
    // upsert 守卫不得据此吞掉更新
    val hasRevision: Boolean = false,
)

data class PendingDecision(
    val decisionId: String,
    val requestId: String,
    val type: String,
    val title: String,
    val options: List<Pair<String, String>>,
    val contextSummary: String,
    val requestedBy: String,
    val sessionId: String,
    val roomId: String?,
    val at: Long,
)

data class FlowVerification(
    val by: String,
    val verdict: String,
    val evidence: String,
    val evidenceDetail: VerificationEvidenceDetail? = null,
    val backendToolCallId: String? = null,
)

data class BackendToolRun(
    val toolCallId: String,
    val status: String,
    val exitCode: Int? = null,
    val at: Long = 0,
)

data class VerificationEvidenceDetail(
    val summary: String = "",
    val baseline: String = "",
    val diff: String = "",
    val reproSteps: List<String> = emptyList(),
    val command: String = "",
    val exitCode: Int? = null,
    val stdout: String = "",
    val stderr: String = "",
    val artifactRefs: List<String> = emptyList(),
)

data class ScheduledTask(
    val id: String,
    val name: String,
    val targetType: String, // "session" | "room"
    val targetId: String,
    val targetName: String,
    val message: String,
    val scheduleMode: String, // "simple" | "cron"
    val simpleKind: String? = null, // "daily" | "interval" | "once"
    val time: String? = null,
    val intervalMinutes: Int? = null,
    val at: Long? = null,
    val cronExpr: String? = null,
    val enabled: Boolean = true,
    val lastRunAt: Long? = null,
    val nextRunAt: Long? = null,
    val createdAt: Long = 0,
    val missionTemplate: JsonObject? = null,
    val missionAutoStart: Boolean = false,
    val eventKind: String? = null,
)

data class TaskLog(
    val id: String,
    val taskId: String,
    val taskName: String,
    val targetType: String,
    val targetId: String,
    val targetName: String,
    val message: String,
    val at: Long,
    val success: Boolean,
    val error: String?,
)

data class FlowTask(
    val id: String,
    val sessionId: String,
    val name: String,
    val status: String,
    val task: String,
    val dependsOn: List<String> = emptyList(),
    val artifacts: List<FlowArtifact> = emptyList(),
    val failureMessage: String? = null,
    val output: String? = null,
    val retries: Int = 0,
    val waitingFor: String? = null,
    val waitingQuestion: String? = null,
    val waitingHelpId: String? = null,
    val verifications: List<FlowVerification> = emptyList(),
    val verificationStatus: String? = null,
    val automaticCheckStatus: String = "not_run",
    val automaticCheckExitCode: Int? = null,
    val automaticCheckSnapshot: String? = null,
    val automaticCheckReason: String? = null,
    val automaticCheckTruncated: Boolean = false,
    val automaticCheckSnapshotCurrent: Boolean? = null,
    val backendRuns: List<BackendToolRun> = emptyList(),
    val backendClaimMatch: Boolean = false,
    val backendClaimStatus: String? = null,
    val baseline: String? = null,
    val diff: String? = null,
    val reproSteps: List<String> = emptyList(),
    val verifyCommand: String? = null,
    val verifyExitCode: Int? = null,
    val verifyStdout: String? = null,
    val verifyStderr: String? = null,
    val verifyCheckId: String? = null,
    val dispatchedAt: Long = 0,
    val finishedAt: Long = 0,
)

data class FlowProgress(
    val done: Int = 0,
    val running: Int = 0,
    val pending: Int = 0,
    val failed: Int = 0,
    val total: Int = 0,
)

data class FlowInfo(
    val roomId: String,
    val phase: String,
    val progress: FlowProgress,
    val tasks: List<FlowTask>,
    val flowId: String = "",
    val startedAt: Long = 0,
    val finishedAt: Long = 0,
    val mode: String = "",
    val goal: String? = null,
    val acceptanceCriteria: List<String> = emptyList(),
    val iteration: Int = 0,
    val maxIterations: Int = 0,
    val supplements: List<String> = emptyList(),
    val clarificationId: String? = null,
    val clarificationQuestions: List<String> = emptyList(),
    val missionId: String? = null,
    val failureMessage: String? = null,
)


data class ArtifactInfo(
    val id: String,
    val alias: String? = null,
    val author: String,
    val at: Long = 0,
    val summary: String = "",
    val path: String? = null,
    val taskId: String? = null,
)

data class EventInfo(
    val id: String,
    val author: String,
    val at: Long = 0,
    val action: String,
    val summary: String = "",
    val path: String? = null,
    val oldPath: String? = null,
    val taskId: String? = null,
)

data class FileTreeRoot(
    val name: String,
    val path: String,
    val kind: String,
    val sessionId: String? = null,
)

data class FileTreeNode(
    val name: String,
    val path: String,
    val kind: String,
    val at: Long = 0,
    val size: Long? = null,
)

data class FilePreview(
    val name: String,
    val path: String,
    val text: String? = null,
    val data: ByteArray? = null,
    val mime: String = "*/*",
    val isDir: Boolean = false,
)

data class DownloadRequest(
    val name: String,
    val text: String?,
    val data: String?,
    val mime: String,
)

data class BlackboardEntry(
    val id: String,
    val from: String,
    val text: String,
    val detail: String,
    val at: Long,
    val type: String = "note",
    val status: String = "open",
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
    val showArchived: Boolean = false,
)

data class TokenUsage(
    val totalTokens: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val thoughtTokens: Long? = null,
    val cachedReadTokens: Long? = null,
    val cachedWriteTokens: Long? = null,
)

data class ContextUsage(
    val used: Long = 0,
    val size: Long = 0,
    val costAmount: Double? = null,
    val costCurrency: String? = null,
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

data class SkillInfo(
    val name: String,
    val description: String,
    val location: String,
    val scope: String,
)

enum class Screen { Connect, Sessions, Chat, Room, FileTree, Settings, Schedule }

data class ConnProfile(
    val name: String,
    val address: String,
    val token: String,
    val publicToken: String = "",
)

fun migrateAddress(address: String, port: String): String {
    if (port.isBlank() || address.contains(":")) return address
    return "$address:$port"
}

fun buildWsUrl(address: String, token: String): String {
    return if (address.startsWith("ws://") || address.startsWith("wss://")) {
        if (address.contains("/hub/")) {
            address
        } else {
            val sep = if (address.contains("?")) "&" else "?"
            "$address${sep}token=${Uri.encode(token)}"
        }
    } else {
        val host = if (address.contains(":")) address else "$address:8787"
        "ws://$host/?token=${Uri.encode(token)}"
    }
}

/**
 * 解析 agenthub://connect?u=<地址>&t=<token>&mode=<lan|gateway> 接入链接。
 * mode=gateway 时 t 为网关 publicToken；缺省按地址是否含 /hub/ 推断。
 */
fun parseConnectUri(raw: String): ConnProfile? {
    val uri = try {
        Uri.parse(raw.trim())
    } catch (_: Exception) {
        return null
    } ?: return null
    if (uri.scheme != "agenthub" || uri.host != "connect") return null
    var u = uri.getQueryParameter("u")?.trim().orEmpty()
    val t = uri.getQueryParameter("t")?.trim().orEmpty()
    if (u.isEmpty() || t.isEmpty()) return null
    if (!u.startsWith("ws://") && !u.startsWith("wss://")) u = "ws://$u"
    val gateway = uri.getQueryParameter("mode").let { m ->
        if (m == "gateway" || m == "lan") m == "gateway" else u.contains("/hub/")
    }
    val name = if (u.contains("/hub/")) {
        u.substringAfterLast("/").substringBefore("?")
    } else {
        Uri.parse(u).host ?: u
    }
    return if (gateway) ConnProfile(name, u, "", t) else ConnProfile(name, u, t, "")
}

class ChatViewModel(app: Application) : AndroidViewModel(app) {
    private val hub = HubClient(viewModelScope) { stringsFor(lang) }
    private val prefs = app.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)
    private var profileEpoch = 0
    private var connectionWanted = false
    private var networkMonitor: NetworkReconnectMonitor? = null
    private var recoveryJob: Job? = null
    private lateinit var delivery: DeliveryOutbox
    private lateinit var deliveryRecovery: DeliveryRecovery
    internal val deliveryRecords = mutableStateListOf<DeliveryRecord>()
    var deliveryReady by mutableStateOf(false)
        private set
    var deliveryError by mutableStateOf<String?>(null)
        private set
    private var deliveryOrigin by mutableStateOf("")
    private var deliveryHubId by mutableStateOf<String?>(null)
    private var deliveryProtocol by mutableIntStateOf(0)
    private var deliveryMaxAgeMs = 24 * 3600_000L
    private var warmupSeq = 0
    private val preparingScopes = mutableStateListOf<String>()
    private val deliveryFiles = mutableMapOf<String, List<Attachment>>()
    private val recoveryResetBase = mutableMapOf<String, Set<ChatItem>>()
    private var anchorScopeKey: String? = null
    private val historyMoreCache = mutableMapOf<String, Boolean>()
    internal val attentionItems = mutableStateListOf<AttentionTarget>()
    var showAttentionManager by mutableStateOf(false)
    var attentionRequestId by mutableStateOf<String?>(null)
    var attentionNavError by mutableStateOf<String?>(null)
    private var pendingAttention: Map<String, String>? = null
    var connectionState by mutableStateOf(HubConnectionState.Disconnected)
        private set
    private var networkMonitoringAvailable by mutableStateOf(true)
    private var backgroundStopReason by mutableStateOf<String?>(null)
    private var backgroundRunning by mutableStateOf(HubService.running)
    private var attentionRecoveryState by mutableStateOf<String?>(null)
    private var notificationsEnabled by mutableStateOf(true)
    private val backgroundPrefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "background_stop_reason" || key == "attention_status") viewModelScope.launch { refreshBackgroundStatus() }
    }
    suspend fun hubCall(method: String, params: JsonObject): JsonObject = hub.call(method, params)

    val profiles = mutableStateListOf<ConnProfile>()

    // 置顶时间戳：后置顶的排最前（pinnedAt 倒序）；旧 pinned set 迁移为 ts=0
    val pinnedAt = mutableStateMapOf<String, Long>().apply {
        prefs.getString("pinnedAt", "{}")!!.let { raw ->
            runCatching {
                org.json.JSONObject(raw).let { j -> j.keys().forEach { put(it, j.getLong(it)) } }
            }
        }
        for (id in prefs.getStringSet("pinned", emptySet())!!) {
            if (!containsKey(id)) put(id, 0L)
        }
    }
    val pinnedIds get() = pinnedAt.keys

    fun togglePin(sessionId: String) {
        if (pinnedAt.containsKey(sessionId)) pinnedAt.remove(sessionId)
        else pinnedAt[sessionId] = System.currentTimeMillis()
        savePinnedMap("pinnedAt", pinnedAt)
    }

    val pinnedRoomAt = mutableStateMapOf<String, Long>().apply {
        prefs.getString("pinnedRoomsAt", "{}")!!.let { raw ->
            runCatching {
                org.json.JSONObject(raw).let { j -> j.keys().forEach { put(it, j.getLong(it)) } }
            }
        }
    }

    fun toggleRoomPin(roomId: String) {
        if (pinnedRoomAt.containsKey(roomId)) pinnedRoomAt.remove(roomId)
        else pinnedRoomAt[roomId] = System.currentTimeMillis()
        savePinnedMap("pinnedRoomsAt", pinnedRoomAt)
    }

    private fun savePinnedMap(key: String, map: Map<String, Long>) {
        val j = org.json.JSONObject()
        for ((k, v) in map) j.put(k, v)
        prefs.edit().putString(key, j.toString()).apply()
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

    val defaultCommands
        get() = stringsFor(lang).let { listOf(it.cmdContinue, it.cmdSummarize, it.cmdRunTests) }

    companion object {
        @Volatile
        var appForeground = false

        /** debug 构建的无 UI 控制面入口（DebugControlReceiver 经此调 VM API）；release 无 receiver 不会被引用 */
        @Volatile
        var debugInstance: ChatViewModel? = null
        const val LOST_REPLY_PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]"

        fun missionTaskNavMatch(
            target: MissionExecutionTarget?,
            currentRoomId: String?,
            flowId: String,
            task: FlowTask,
        ): Boolean {
            val t = target ?: return false
            if (t.roomId != currentRoomId) return false
            if (t.flowId == null || t.flowId != flowId) return false
            if (t.taskId == null || t.taskId != task.id) return false
            return t.dispatchedAt == null || t.dispatchedAt == task.dispatchedAt
        }

        fun missionFlowNavMatch(target: MissionExecutionTarget?, currentRoomId: String?, flowId: String): Boolean {
            val t = target ?: return false
            return t.roomId == currentRoomId && t.flowId != null && t.flowId == flowId
        }
    }

    var screen by mutableStateOf(Screen.Sessions)
    val listTab = mutableIntStateOf(0)
    var sessionListFilter by mutableStateOf(SessionListFilter())
    var roomListFilter by mutableStateOf(RoomListFilter())
    var connecting by mutableStateOf(false)
    var connectError by mutableStateOf<String?>(null)
    /** deep link / 粘贴导入的待确认连接 profile：非空时弹出预填对话框 */
    var pendingImport by mutableStateOf<ConnProfile?>(null)

    /** agenthub://connect 链接导入：解析成功置 pendingImport，失败 toast 并返回 false */
    fun importConnectUri(raw: String): Boolean {
        val profile = parseConnectUri(raw)
        if (profile == null) {
            Toast.makeText(getApplication(), stringsFor(lang).connectUriInvalid, Toast.LENGTH_SHORT).show()
            return false
        }
        pendingImport = profile
        return true
    }
    var agentStatus by mutableStateOf("offline")
    /** hub.connectInfo.localOnly：dev-token 回环运行的 hub 仅本机可连，提示用户换正式 token */
    var hubLocalOnly by mutableStateOf(false)
    /** ntfy 离线推送：hub agent.info 下发的 topic/url；未配置时回退 agenthub-<hubId> 约定名展示 */
    var ntfyTopic by mutableStateOf<String?>(null)
    var ntfyUrl by mutableStateOf("https://ntfy.sh")
    var currentProfile by mutableStateOf<ConnProfile?>(null)

    val sessions = mutableStateListOf<SessionInfo>()
    val rooms = mutableStateListOf<RoomInfo>()
    val roles = mutableStateListOf<RoleInfo>()
    val skills = mutableStateListOf<SkillInfo>()
    val connections = mutableStateListOf<ConnectionInfo>()
    val hubAgentTypes = mutableStateListOf<String>()
    val scheduledTasks = mutableStateListOf<ScheduledTask>()

    /** 蒸馏记忆条目（hub memory 表经 room.memory RPC 读取） */
    data class MemoryEntry(val id: Long, val kind: String, val text: String, val source: String, val at: Long)
    val roomMemories = mutableStateListOf<MemoryEntry>()

    /** scope 分层订阅：ViewModel 订 detail（当前房），切房重订并消费回包快照 */
    private var subscribedRoomId: String? = null

    /** 已声明的工单 taskId 集：仅展开态工单按需订阅，其余工单 tagged 事件被 hub 过滤 */
    private val subscribedTaskIds = mutableSetOf<String>()
    private var taskIdSubRoomId: String? = null


    fun subscribeTask(taskId: String) {
        val rid = currentRoom?.roomId ?: return
        if (taskId.isBlank()) return
        if (taskIdSubRoomId != rid) { subscribedTaskIds.clear(); taskIdSubRoomId = rid }
        if (!subscribedTaskIds.add(taskId)) return
        resubscribe()
    }

    private fun resubscribe() {
        val rid = subscribedRoomId ?: return
        viewModelScope.launch {
            try {
                hub.call("client.subscribe", buildJsonObject {
                    put("tier", "detail")
                    put("roomId", rid)
                    if (subscribedTaskIds.isNotEmpty()) put("taskIds", JsonArray(subscribedTaskIds.map { JsonPrimitive(it) }))
                })
            } catch (_: Exception) { }
        }
    }

    fun subscribeScope(roomId: String? = null) {
        val rid = roomId ?: currentRoom?.roomId
        if (rid == subscribedRoomId) return
        if (taskIdSubRoomId != rid) { subscribedTaskIds.clear(); taskIdSubRoomId = rid }
        subscribedRoomId = rid
        viewModelScope.launch {
            try {
                val result = hub.call("client.subscribe", buildJsonObject {
                    put("tier", "detail")
                    rid?.let { put("roomId", it) }
                    if (subscribedTaskIds.isNotEmpty()) put("taskIds", JsonArray(subscribedTaskIds.map { JsonPrimitive(it) }))
                })
                (result["snapshot"] as? JsonObject)?.let { snap ->
                    rid?.let { applyRecoveryRoom("room:$it", snap) }
                }
            } catch (_: Exception) {
                subscribedRoomId = null
            }
        }
    }

    fun loadRoomMemory(roomId: String) {
        viewModelScope.launch {
            try {
                val result = hub.call("room.memory", buildJsonObject { put("roomId", roomId); put("ifcAuthorized", true) })
                val list = result["memories"]?.jsonArray ?: return@launch
                roomMemories.clear()
                for (m in list) {
                    val o = m.jsonObject
                    roomMemories.add(MemoryEntry(
                        id = o["id"]!!.jsonPrimitive.content.toLong(),
                        kind = o["kind"]?.jsonPrimitive?.contentOrNull ?: "fact",
                        text = o["text"]?.jsonPrimitive?.contentOrNull ?: "",
                        source = o["source"]?.jsonPrimitive?.contentOrNull ?: "",
                        at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L,
                    ))
                }
            } catch (_: Exception) { }
        }
    }

    fun deleteRoomMemory(roomId: String, id: Long) {
        viewModelScope.launch {
            try {
                hub.call("room.memory.delete", buildJsonObject {
                    put("roomId", roomId)
                    put("id", id)
                    put("ifcAuthorized", true)
                })
                roomMemories.removeAll { it.id == id }
            } catch (_: Exception) { }
        }
    }
    val taskLogs = mutableStateListOf<TaskLog>()
    val missions = mutableStateListOf<Mission>()
    /** hub 是否支持 mission.* API；探测失败（unknown method）保持 false 隐藏入口 */
    var missionSupported by mutableStateOf(false)
    var missionChecked by mutableStateOf(false)
    var missionLoading by mutableStateOf(false)
    var missionError by mutableStateOf<String?>(null)
    private var missionConnectionGeneration = 0
    private var missionListSeq = 0
    private var missionEventRev = 0
    private var decisionListSeq = 0
    private var decisionEventRev = 0
    val pendingDecisions = mutableStateListOf<PendingDecision>()
    var decisionLoading by mutableStateOf(false)
    var missionFocusId by mutableStateOf<String?>(null)
    var missionExecutionTarget by mutableStateOf<MissionExecutionTarget?>(null)
    var missionNavMessage by mutableStateOf<String?>(null)
    private var roomOpenSeq = 0
    var scheduleReturnScreen by mutableStateOf(Screen.Sessions)
    var currentSession by mutableStateOf<SessionInfo?>(null)
    var currentRoom by mutableStateOf<RoomInfo?>(null)
    var flow by mutableStateOf<FlowInfo?>(null)
    val currentArtifacts = mutableStateListOf<ArtifactInfo>()
    val currentEvents = mutableStateListOf<EventInfo>()
    val blackboard = mutableStateListOf<BlackboardEntry>()
    /** 各类新增内容计数（展开对应面板时清零） */
    var newArtifactCount by mutableStateOf(0)
    var newEventCount by mutableStateOf(0)
    var newBlackboardCount by mutableStateOf(0)
    private class ScopeSeen {
        var artifacts: Set<String>? = null
        var events: Set<String>? = null
        var board: Set<String>? = null
        var counts: Triple<Int, Int, Int> = Triple(0, 0, 0)
    }
    private val scopeSeen = mutableMapOf<String, ScopeSeen>()
    private val chatCache = mutableMapOf<String, List<ChatItem>>()
    private val chatCacheKeys = ArrayDeque<String>()
    private val flowCache = mutableMapOf<String, FlowInfo?>()

    private class ScopePanels(
        val artifacts: List<ArtifactInfo>,
        val events: List<EventInfo>,
        val board: List<BlackboardEntry>,
    )

    private val panelsCache = mutableMapOf<String, ScopePanels>()
    private var artifactRefreshGeneration = 0L
    private var usageRefreshGeneration = 0L
    var fileTreeRoots by mutableStateOf<List<FileTreeRoot>>(emptyList())
    var fileTreePath by mutableStateOf<String?>(null)
    var fileTreeRootPath by mutableStateOf<String?>(null)
    var fileTreeRootName by mutableStateOf<String?>(null)
    val fileTreeNodes = mutableStateListOf<FileTreeNode>()
    var fileTreeLoading by mutableStateOf(false)
    var filePreview by mutableStateOf<FilePreview?>(null)
    val chatItems = mutableStateListOf<ChatItem>()
    val chatListItems: State<List<ChatListItem>> = derivedStateOf { expandChatItems(chatItems) }
    private val chatListCache = mutableMapOf<Pair<Long, String>, List<ChatListItem>>()
    val busyIds = mutableStateListOf<String>()
    /** member.status 事件维护的成员在线状态（sessionId → online/generating/offline） */
    val memberStatus = mutableStateMapOf<String, String>()
    val sessionUsage = mutableStateMapOf<String, ContextUsage>()
    val pendingAttachments = mutableStateListOf<Attachment>()
    private val drafts = mutableMapOf<String, String>()
    private val attachmentDrafts = mutableMapOf<String, List<Attachment>>()
    private val quoteDrafts = mutableMapOf<String, Pair<String, String>>()
    private val replyDrafts = mutableMapOf<String, String>()
    var quote by mutableStateOf<Pair<String, String>?>(null)
    var helpReplyTo by mutableStateOf<String?>(null)
        private set

    fun startHelpReply(helpId: String) {
        helpReplyTo = helpId
    }

    fun cancelHelpReply() {
        helpReplyTo = null
    }

    var multiSelectMode by mutableStateOf(false)
    val selectedMessageIds = mutableStateListOf<String>()
    var fileRefToInsert by mutableStateOf<String?>(null)
    var pendingDownload by mutableStateOf<DownloadRequest?>(null)

    var showModelPicker by mutableStateOf(false)
    val modelList = mutableStateListOf<ModelInfo>()
    var modelFilter by mutableStateOf("")
    var modelCurrent by mutableStateOf("")
    var backendQuota by mutableStateOf<BackendQuota?>(null)
    /** member.quota 事件+payload quota 字段：远端成员配额（sessionId/connectionId → quota） */
    val memberQuotas = mutableStateMapOf<String, BackendQuota>()
    /** 群聊模式：成员模型信息 sessionId -> (name, backend, model) */
    val roomMemberModels = mutableStateMapOf<String, Triple<String, String, String>>()
    val roomMemberTypes = mutableStateMapOf<String, String>() // sessionId → backendType（配额判定用，与 backend id 区分）
    /** 群聊模式：当前选中的成员 sessionId */
    var selectedMemberSession by mutableStateOf<String?>(null)
    /** 当前选中会话的非模型 ACP 配置项（mode/thought_level 等） */
    val sessionConfigOptions = mutableStateListOf<SessionConfigOption>()

    private fun persistProfiles() {
        prefs.edit().putStringSet(
            "profiles_v2",
            profiles.map { "${it.name}\u0001${it.address}\u0001${it.token}\u0001${it.publicToken}" }.toSet(),
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
        if (currentProfile == p && (hub.isConnected || connectionState == HubConnectionState.Connecting)) return
        connect(p.address, p.token, p.publicToken, p.name)
    }

    fun upsertProfile(
        old: ConnProfile?,
        name: String,
        address: String,
        token: String,
        publicToken: String = "",
        connectNow: Boolean = false,
    ) {
        val newProfile = ConnProfile(
            name.ifBlank {
                address.removePrefix("wss://").removePrefix("ws://")
                    .substringBefore("/").substringBefore(":").substringBefore("?")
            },
            address, token, publicToken,
        )
        if (old != null) {
            profiles.remove(old)
        }
        profiles.removeAll { it.address == address }
        profiles.add(newProfile)
        if (connectNow) {
            currentProfile = newProfile
        } else if (currentProfile == old && old?.address == address) {
            currentProfile = newProfile
        }
        persistProfiles()
        if (connectNow) {
            connect(address, token, publicToken, newProfile.name)
        }
    }

    private fun saveProfile(address: String, token: String, publicToken: String = "", name: String? = null) {
        val derived = address.removePrefix("wss://").removePrefix("ws://")
            .substringBefore("/").substringBefore(":").substringBefore("?")
        val profileName = name?.takeIf { it.isNotBlank() } ?: derived
        profiles.removeAll { it.address == address }
        val profile = ConnProfile(profileName, address, token, publicToken)
        profiles.add(profile)
        currentProfile = profile
        persistProfiles()
        prefs.edit().putString("last_v2", "$address\u0001$token\u0001$publicToken").apply()
        if (screen == Screen.Connect) screen = Screen.Sessions
    }

    fun startHubService() {
        val app = getApplication<Application>()
        if (!connectionWanted || savedHubConnection(app) == null) return
        try {
            app.startForegroundService(Intent(app, HubService::class.java))
        } catch (_: Exception) {
            prefs.edit().putString("background_stop_reason", "start_restricted").apply()
        }
        refreshBackgroundStatus()
    }

    fun refreshBackgroundStatus() {
        backgroundStopReason = prefs.getString("background_stop_reason", null)
        backgroundRunning = HubService.running
        attentionRecoveryState = prefs.getString("attention_status", null)
        notificationsEnabled = Notifier.notificationsAvailable(getApplication(), Notifier.CHANNEL_PERMISSION)
    }

    /** (文案, 硬错)——硬错=需要用户改配置/手动介入(auth/policy/invalid_config/start_restricted/service_stopped)，
     * 软态=可自愈或仅提醒(timeout/sync/network_monitor/permission 等)，横幅据此分色与点击行为 */
    fun backgroundConnectionBanner(): Pair<String, Boolean>? {
        val S = stringsFor(lang)
        when (connectionState) {
            HubConnectionState.AuthFailed -> return S.connectionAuthFailed to true
            HubConnectionState.PolicyRejected -> return S.connectionPolicyRejected to true
            HubConnectionState.InvalidConfig -> return S.connectionInvalidAddress to true
            else -> Unit
        }
        return when (backgroundStopReason) {
            "auth" -> S.connectionAuthFailed to true
            "policy" -> S.connectionPolicyRejected to true
            "invalid_config" -> S.connectionInvalidAddress to true
            "timeout" -> S.backgroundConnectionTimeout to false
            "network_monitor" -> S.networkMonitoringUnavailable to false
            "start_restricted", "service_stopped" -> S.backgroundConnectionUnavailable to true
            else -> when {
                !networkMonitoringAvailable -> S.networkMonitoringUnavailable to false
                connectionWanted && savedHubConnection(getApplication()) != null && !backgroundRunning ->
                    S.backgroundConnectionUnavailable to false
                connectionWanted && !notificationsEnabled -> S.attentionLabels.getValue("permission") to false
                connectionWanted && attentionRecoveryState == "unsupported" -> S.attentionLabels.getValue("unsupported") to false
                connectionWanted && attentionRecoveryState != null -> S.attentionLabels.getValue("sync") to false
                else -> null
            }
        }
    }

    fun backgroundConnectionWarning(): String? = backgroundConnectionBanner()?.first

    override fun onCleared() {
        if (debugInstance === this) debugInstance = null
        if (::delivery.isInitialized) delivery.pause()
        profileEpoch++
        missionConnectionGeneration++
        connectionWanted = false
        recoveryJob?.cancel()
        eventJob?.cancel()
        networkMonitor?.close()
        prefs.unregisterOnSharedPreferenceChangeListener(backgroundPrefsListener)
        hub.disconnect()
        super.onCleared()
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
            if (room != null) {
                if (room.members.any { busyIds.contains(it.first) }) return true
                val f = flow
                if (f != null && f.roomId == room.roomId && f.phase !in setOf("done", "cancelled")) return true
                return false
            }
            val s = currentSession ?: return false
            return busyIds.contains(s.sessionId)
        }

    private var itemSeq = 0L
    private var eventJob: Job? = null

    fun sessionName(sessionId: String): String {
        if (sessionId.isBlank()) return sessionId
        currentRoom?.members?.find { it.first == sessionId }?.second?.let { return it }
        sessions.find { it.sessionId == sessionId }?.let { return displayName(it) }
        currentRoom?.members?.find { it.second == sessionId }?.second?.let { return it }
        return sessionId
    }

    private fun parseReportedQuota(v: JsonElement?): BackendQuota? {
        val o = (v as? JsonObject) ?: return null
        fun win(key: String): QuotaWindow? {
            val w = o[key]?.jsonObject ?: return null
            val used = w["usedPercent"]?.jsonPrimitive?.intOrNull ?: return null
            val remaining = w["remainingPercent"]?.jsonPrimitive?.intOrNull ?: (100 - used)
            return QuotaWindow(remaining, used, w["resetAtUnix"]?.jsonPrimitive?.longOrNull
                ?: w["resetAt"]?.jsonPrimitive?.longOrNull?.let { it / 1000 })
        }
        return BackendQuota(
            available = o["available"]?.jsonPrimitive?.booleanOrNull == true,
            planName = o["planName"]?.jsonPrimitive?.contentOrNull,
            daily = win("daily"), weekly = win("weekly"),
        )
    }

    private fun parseContextUsage(u: JsonObject) = ContextUsage(
        used = u["used"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
        size = u["size"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
        costAmount = (u["cost"] as? JsonObject)?.get("amount")?.jsonPrimitive?.content?.toDoubleOrNull(),
        costCurrency = (u["cost"] as? JsonObject)?.get("currency")?.jsonPrimitive?.content,
    )

    private fun refreshSessionUsage(sessionId: String) {
        val generation = ++usageRefreshGeneration
        viewModelScope.launch {
            try {
                val result = hub.call("session.contextUsage", buildJsonObject { put("sessionId", sessionId) })
                if (generation != usageRefreshGeneration) return@launch
                val stillCurrent = currentSession?.sessionId == sessionId || currentRoom?.activeSpeaker == sessionId
                if (!stillCurrent) return@launch
                val u = result["usage"] as? JsonObject
                if (u != null) sessionUsage[sessionId] = parseContextUsage(u)
                else sessionUsage.remove(sessionId)
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    private fun parseTokenUsage(u: JsonObject?): TokenUsage? {
        if (u == null) return null
        return TokenUsage(
            totalTokens = u["totalTokens"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
            inputTokens = u["inputTokens"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
            outputTokens = u["outputTokens"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
            thoughtTokens = u["thoughtTokens"]?.jsonPrimitive?.content?.toLongOrNull(),
            cachedReadTokens = u["cachedReadTokens"]?.jsonPrimitive?.content?.toLongOrNull(),
            cachedWriteTokens = u["cachedWriteTokens"]?.jsonPrimitive?.content?.toLongOrNull(),
        )
    }

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
        if (pinnedAt.containsKey(s.sessionId)) add(SessionStatus.Pinned)
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
                .thenByDescending { pinnedAt[it.sessionId] != null }
                .thenByDescending { pinnedAt[it.sessionId] ?: 0L }
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
        val archivedCount = rooms.count { it.archived }
        val filtered = rooms.filter { r ->
            if (r.archived && !filter.showArchived) return@filter false
            if (filter.modes.isNotEmpty() && r.mode !in filter.modes) return@filter false
            if (q.isNotEmpty()) {
                val members = r.members.joinToString(" ") { it.second }.lowercase()
                val modeLabel = r.mode.lowercase()
                val hay = "${r.name} $modeLabel $members".lowercase()
                if (!hay.contains(q)) return@filter false
            }
            true
        }.sortedWith(
            compareByDescending<RoomInfo> { pinnedRoomAt[it.roomId] != null }
                .thenByDescending { pinnedRoomAt[it.roomId] ?: 0L }
                .thenBy { it.name.lowercase() }
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

    fun refreshCurrentModel() {
        viewModelScope.launch {
            if (!hub.isConnected) return@launch
            try {
                val room = currentRoom
                if (room != null) {
                    // 群聊：加载所有成员模型
                    val result = hub.call("room.memberModels", buildJsonObject { put("roomId", room.roomId) })
                    val members = result["members"]?.jsonArray ?: emptyList()
                    roomMemberModels.clear()
                    for (m in members) {
                        val obj = m.jsonObject
                        val sid = obj["sessionId"]?.jsonPrimitive?.content ?: continue
                        val name = obj["name"]?.jsonPrimitive?.content ?: sid
                        val backend = obj["backend"]?.jsonPrimitive?.content ?: "devin"
                        val backendType = obj["backendType"]?.jsonPrimitive?.content ?: backend
                        val model = obj["model"]?.jsonPrimitive?.content ?: ""
                        roomMemberModels[sid] = Triple(name, backend, model)
                        roomMemberTypes[sid] = backendType
                    }
                    // 显示第一个成员的模型作为概览
                    modelCurrent = roomMemberModels.values.firstOrNull()?.third ?: ""
                    if (roomMemberTypes.values.any { it == "devin" }) refreshBackendQuota()
                } else {
                    val session = currentSession ?: return@launch
                    val backend = session.agent
                    if ((session.backendType ?: backend) == "devin") refreshBackendQuota()
                    val result = hub.call("model.current", buildJsonObject {
                        put("backend", backend)
                        put("sessionId", session.sessionId)
                    })
                    modelCurrent = result["uid"]?.jsonPrimitive?.content ?: ""
                }
            } catch (_: Exception) {}
        }
    }

    fun refreshBackendQuota(force: Boolean = false) {
        viewModelScope.launch {
            if (!hub.isConnected) return@launch
            try {
                val r = hub.call("model.usage", buildJsonObject {
                    put("backend", "devin")
                    if (force) put("refresh", true)
                })
                fun window(key: String): QuotaWindow? {
                    val w = r[key]?.jsonObject ?: return null
                    val remaining = w["remainingPercent"]?.jsonPrimitive?.intOrNull ?: return null
                    return QuotaWindow(
                        remainingPercent = remaining,
                        usedPercent = w["usedPercent"]?.jsonPrimitive?.intOrNull ?: (100 - remaining),
                        resetAtUnix = w["resetAtUnix"]?.jsonPrimitive?.longOrNull,
                    )
                }
                backendQuota = BackendQuota(
                    available = r["available"]?.jsonPrimitive?.booleanOrNull == true,
                    planName = r["planName"]?.jsonPrimitive?.contentOrNull,
                    daily = window("daily"),
                    weekly = window("weekly"),
                )
            } catch (_: Exception) {}
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
                    val room = currentRoom
                    if (room != null) {
                        // 群聊模式：需要 @成员名 前缀
                        val mentionMatch = Regex("^@(\\S+)\\s+(.+)$").find(arg)
                        if (mentionMatch == null) {
                            chatItems.add(ChatItem.Error(++itemSeq, S.roomModelHint))
                            return@launch
                        }
                        val memberName = mentionMatch.groupValues[1]
                        val modelName = mentionMatch.groupValues[2]
                        val member = room.members.find { it.second == memberName }
                        if (member == null) {
                            chatItems.add(ChatItem.Error(++itemSeq, S.memberNotFoundFmt.format(memberName)))
                            return@launch
                        }
                        val result = hub.call("model.set", buildJsonObject {
                            put("model", modelName)
                            put("sessionId", member.first)
                        })
                        val model = result["model"]?.jsonObject
                        if (model != null) {
                            val uid = model["uid"]?.jsonPrimitive?.content ?: modelName
                            val label = model["label"]?.jsonPrimitive?.content ?: ""
                            chatItems.add(ChatItem.System(++itemSeq, S.modelSwitchedForFmt.format(memberName, label.ifBlank { uid })))
                            refreshCurrentModel()
                        } else {
                            chatItems.add(ChatItem.Error(++itemSeq, S.modelUnknown.format(modelName)))
                        }
                    } else {
                        // 单聊模式
                        val sid = currentSession?.sessionId
                        val result = hub.call("model.set", buildJsonObject {
                            put("model", arg)
                            if (!sid.isNullOrBlank()) put("sessionId", sid)
                        })
                        val model = result["model"]?.jsonObject
                        if (model != null) {
                            val uid = model["uid"]?.jsonPrimitive?.content ?: arg
                            val label = model["label"]?.jsonPrimitive?.content ?: ""
                            val cost = formatModelCost(S, model)
                            chatItems.add(ChatItem.System(++itemSeq, S.modelSwitched.format(uid, "$label $cost").trim()))
                            refreshCurrentModel()
                        } else {
                            chatItems.add(ChatItem.Error(++itemSeq, S.modelUnknown.format(arg)))
                        }
                    }
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
            }
        }
    }

    fun loadModelList(initialFilter: String = "") {
        viewModelScope.launch {
            val room = currentRoom
            if (room != null) {
                // 群聊模式：加载成员模型，默认选第一个成员
                loadRoomMemberModels(room.roomId, initialFilter)
            } else {
                // 单聊模式
                try {
                    val backend = currentSession?.agent ?: "devin"
                    if ((currentSession?.backendType ?: backend) == "devin") refreshBackendQuota()
                    val sid = currentSession?.sessionId
                    val result = hub.call("model.list", buildJsonObject {
                        put("backend", backend)
                        if (!sid.isNullOrBlank()) put("sessionId", sid)
                    })
                    val current = result["current"]?.jsonPrimitive?.content ?: ""
                    modelCurrent = current
                    modelList.clear()
                    val list = result["models"]?.jsonArray ?: emptyList()
                    modelList.addAll(list.map { it.jsonObject.toModelInfo(current) })
                    modelFilter = initialFilter
                    selectedMemberSession = null
                    showModelPicker = true
                    if (!sid.isNullOrBlank()) loadSessionConfigOptions(sid) else sessionConfigOptions.clear()
                } catch (e: Exception) {
                    val S = stringsFor(lang)
                    chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
                }
            }
        }
    }

    fun loadSessionConfigOptions(sessionId: String) {
        viewModelScope.launch {
            try {
                val result = hub.call("session.configOptions", buildJsonObject {
                    put("sessionId", sessionId)
                })
                sessionConfigOptions.clear()
                sessionConfigOptions.addAll(parseSessionConfigOptions(result["configOptions"]?.jsonArray))
            } catch (_: Exception) {
                sessionConfigOptions.clear()
            }
        }
    }

    fun setSessionConfigOption(sessionId: String, configId: String, value: String) {
        viewModelScope.launch {
            try {
                val result = hub.call("session.setConfigOption", buildJsonObject {
                    put("sessionId", sessionId)
                    put("configId", configId)
                    put("value", value)
                })
                sessionConfigOptions.clear()
                sessionConfigOptions.addAll(parseSessionConfigOptions(result["configOptions"]?.jsonArray))
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "set config failed"))
            }
        }
    }

    private suspend fun loadRoomMemberModels(roomId: String, initialFilter: String = "") {
        try {
            val result = hub.call("room.memberModels", buildJsonObject { put("roomId", roomId) })
            val members = result["members"]?.jsonArray ?: emptyList()
            roomMemberModels.clear()
            for (m in members) {
                val obj = m.jsonObject
                val sid = obj["sessionId"]?.jsonPrimitive?.content ?: continue
                val name = obj["name"]?.jsonPrimitive?.content ?: sid
                val backend = obj["backend"]?.jsonPrimitive?.content ?: "devin"
                val backendType = obj["backendType"]?.jsonPrimitive?.content ?: backend
                val model = obj["model"]?.jsonPrimitive?.content ?: ""
                roomMemberModels[sid] = Triple(name, backend, model)
                roomMemberTypes[sid] = backendType
            }
            // 默认选第一个成员
            val firstSid = roomMemberModels.keys.firstOrNull()
            selectedMemberSession = firstSid
            if (firstSid != null) loadModelListForMember(firstSid)
            modelFilter = initialFilter
            showModelPicker = true
        } catch (e: Exception) {
            val S = stringsFor(lang)
            chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
        }
    }

    fun selectMemberForModel(sessionId: String?) {
        selectedMemberSession = sessionId
        modelFilter = ""
        if (sessionId != null) viewModelScope.launch { loadModelListForMember(sessionId) }
    }

    private suspend fun loadModelListForMember(sessionId: String) {
        val info = roomMemberModels[sessionId] ?: return
        val backend = info.second
        if ((roomMemberTypes[sessionId] ?: backend) == "devin") refreshBackendQuota()
        try {
            val result = hub.call("model.list", buildJsonObject {
                put("backend", backend)
                put("sessionId", sessionId)
            })
            val current = result["current"]?.jsonPrimitive?.content ?: ""
            modelCurrent = current
            modelList.clear()
            val list = result["models"]?.jsonArray ?: emptyList()
            modelList.addAll(list.map { it.jsonObject.toModelInfo(current) })
            loadSessionConfigOptions(sessionId)
        } catch (e: Exception) {
            val S = stringsFor(lang)
            chatItems.add(ChatItem.Error(++itemSeq, S.modelListError.format(e.message ?: "")))
        }
    }

    fun switchModel(model: ModelInfo) {
        viewModelScope.launch {
            val S = stringsFor(lang)
            try {
                val room = currentRoom
                val selectedMember = selectedMemberSession
                if (room != null && selectedMember != null) {
                    // 群聊模式：切指定成员的模型
                    val result = hub.call("model.set", buildJsonObject {
                        put("model", model.uid)
                        put("sessionId", selectedMember)
                    })
                    val m = result["model"]?.jsonObject
                    val uid = m?.get("uid")?.jsonPrimitive?.content ?: model.uid
                    val memberName = roomMemberModels[selectedMember]?.first ?: selectedMember
                    roomMemberModels[selectedMember] = Triple(memberName, roomMemberModels[selectedMember]?.second ?: "devin", uid)
                    modelCurrent = uid
                    modelList.forEachIndexed { i, item -> modelList[i] = item.copy(isCurrent = item.uid == uid) }
                    chatItems.add(ChatItem.System(++itemSeq, stringsFor(lang).modelSwitchedForFmt.format(memberName, model.label.ifBlank { model.uid })))
                } else {
                    // 单聊模式
                    val sid = currentSession?.sessionId
                    val result = hub.call("model.set", buildJsonObject {
                        put("model", model.uid)
                        if (!sid.isNullOrBlank()) put("sessionId", sid)
                    })
                    val m = result["model"]?.jsonObject
                    if (m != null) {
                        val uid = m["uid"]?.jsonPrimitive?.content ?: model.uid
                        val label = m["label"]?.jsonPrimitive?.content ?: ""
                        val cost = formatModelCost(S, m)
                        chatItems.add(ChatItem.System(++itemSeq, S.modelSwitched.format(uid, "$label $cost").trim()))
                        refreshCurrentModel()
                    }
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
                val backend = currentSession?.agent ?: "devin"
                val sid = currentSession?.sessionId
                val result = hub.call("model.refresh", buildJsonObject {
                    put("backend", backend)
                    if (!sid.isNullOrBlank()) put("sessionId", sid)
                })
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
            val local = listOf(
                SlashCommand("help", S.slashHelpHelp),
                SlashCommand("stop", S.slashHelpStop),
                SlashCommand("bypass", S.slashHelpBypass),
                SlashCommand("mode", S.slashHelpMode),
                SlashCommand("model", S.slashHelpModel),
                SlashCommand("new", S.slashHelpNew),
                SlashCommand("fusion", S.fusionDesc),
            )
            val skillCmds = skills.map { SlashCommand(it.name, it.description) }
            return local + skillCmds
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

    /** /new：单聊重置为继承配置的新会话、群聊克隆为全新上下文的房间；旧的归档保留可回溯 */
    private fun newChat() {
        val S = stringsFor(lang)
        val room = currentRoom
        val session = currentSession
        fun nextName(base: String, taken: Set<String>): String {
            val stem = base.replace(Regex("""\s*\(\d+\)\s*$"""), "")
            var n = 2
            var name = "$stem ($n)"
            while (name in taken) { n++; name = "$stem ($n)" }
            return name
        }
        when {
            room != null -> viewModelScope.launch {
                try {
                    // 先停在途编排与成员回合，避免旧房间归档后仍写入幽灵回合
                    if (flow != null) {
                        try {
                            hub.call("room.flow.cancel", buildJsonObject { put("roomId", room.roomId) })
                        } catch (_: Exception) {}
                    }
                    for ((sid, _) in room.members) {
                        if (busyIds.contains(sid)) {
                            try {
                                hub.call("session.cancel", buildJsonObject { put("sessionId", sid) })
                            } catch (_: Exception) {}
                        }
                    }
                    val result = hub.call("room.clone", buildJsonObject {
                        put("roomId", room.roomId)
                        put("newName", nextName(room.name, rooms.map { it.name }.toSet()))
                        put("fresh", true)
                    })
                    val newRoom = parseRoom(result["room"]!!.jsonObject)
                    rooms.add(newRoom)
                    // 预播种到新房间缓存：openRoom 协程内会清 chatItems，直插会被抹掉；
                    // 经 chatCache 载入的条目（正 id）在 dedupeTail 中存活，空历史时也必现
                    chatCache["room:${newRoom.roomId}"] =
                        listOf(ChatItem.System(++itemSeq, S.newChatDoneFmt.format(newRoom.name)))
                    openRoom(newRoom)
                    try {
                        hub.call("room.archive", buildJsonObject {
                            put("roomId", room.roomId)
                            put("archived", true)
                        })
                    } catch (_: Exception) {}
                    refreshAll()
                } catch (e: Exception) {
                    chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "failed"))
                }
            }
            session != null -> viewModelScope.launch {
                try {
                    // 先停在途回合，避免旧会话归档后仍写入幽灵回合
                    if (session.busy || busyIds.contains(session.sessionId)) {
                        try {
                            hub.call("session.cancel", buildJsonObject {
                                put("sessionId", session.sessionId)
                            })
                        } catch (_: Exception) {}
                    }
                    // session.clone fresh:true：新建空上下文会话并继承模型/config/persona，名字由服务端派生
                    val result = hub.call("session.clone", buildJsonObject {
                        put("sessionId", session.sessionId)
                        put("fresh", true)
                    })
                    val newSession = SessionInfo(
                        result["sessionId"]!!.jsonPrimitive.content,
                        session.cwd,
                        result["name"]?.jsonPrimitive?.content ?: session.name,
                        false,
                        result["agent"]?.jsonPrimitive?.content ?: session.agent,
                        result["address"]?.jsonPrimitive?.content ?: "",
                        result["connectionId"]?.jsonPrimitive?.content ?: session.connectionId,
                        result["roleId"]?.jsonPrimitive?.content ?: session.roleId,
                        stoppable = false,
                    )
                    sessions.add(newSession)
                    chatCache["session:${newSession.sessionId}"] =
                        listOf(ChatItem.System(++itemSeq, S.newChatDoneFmt.format(newSession.name)))
                    openChat(newSession)
                    try {
                        hub.call("session.archive", buildJsonObject {
                            put("sessionId", session.sessionId)
                            put("archived", true)
                        })
                    } catch (_: Exception) {}
                    refreshAll()
                } catch (e: Exception) {
                    chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "failed"))
                }
            }
        }
    }

    private fun handleSlashCommand(text: String): Boolean {
        if (!text.startsWith("/")) return false
        val parts = text.substring(1).trim().split("""\s+""".toRegex()).filter { it.isNotBlank() }
        val command = parts.firstOrNull() ?: return false
        val arg = parts.drop(1).joinToString(" ").ifBlank { null }
        when (command) {
            "help" -> showSlashHelp()
            "bypass" -> toggleBypass(arg)
            "stop" -> stopCurrent()
            "fusion" -> loadModelList("fusion")
            "new" -> newChat()
            "model", "models" -> handleModelSlash(arg)
            else -> return false // 不匹配本地命令，透传给 agent（可能是 agent skill）
        }
        return true
    }

    fun connect(address: String, token: String, publicToken: String = "", name: String? = null) {
        val profile = Triple(address, token, publicToken)
        resetConnection(clearSaved = savedHubConnection(getApplication()) != profile)
        deliveryOrigin = deliveryOriginFor(address, token, publicToken)
        delivery.select(deliveryOrigin)
        val epoch = profileEpoch
        connectionWanted = true
        currentProfile = ConnProfile(
            name ?: address.removePrefix("wss://").removePrefix("ws://")
                .substringBefore("/").substringBefore(":").substringBefore("?"),
            address, token, publicToken,
        )
        connecting = true
        connectError = null
        var openedOnce = false
        hub.onStateChanged = { state -> if (epoch == profileEpoch) connectionState = state }
        hub.onClosed = {
            if (epoch == profileEpoch) {
                flushStreamChunks()
                deliveryReady = false
                delivery.pause()
                missionConnectionGeneration++
                historyLoading = false
                recoveryJob?.cancel()
                eventJob?.cancel()
                eventJob = null
                connecting = false
                agentStatus = if (connectionWanted) "reconnecting" else "offline"
            }
        }
        val url = buildWsUrl(address, token)
        hub.connect(url, publicToken,
            onOpen = {
                if (epoch == profileEpoch && connectionWanted) {
                    val generation = ++missionConnectionGeneration
                    eventJob?.cancel()
                    eventJob = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
                        hub.events.collect {
                            if (!currentConnection(epoch, generation)) return@collect
                            try {
                                handleEvent(it)
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                Log.w("agenthub", "handleEvent dropped", e)
                            }
                        }
                    }
                    connecting = false
                    connectError = null
                    saveProfile(address, token, publicToken, name)
                    startHubService()
                    agentStatus = "connected"
                    viewModelScope.launch {
                        hubLocalOnly = runCatching {
                            hub.call("hub.connectInfo")["localOnly"]?.jsonPrimitive?.booleanOrNull == true
                        }.getOrDefault(false)
                    }
                    if (!openedOnce) screen = Screen.Sessions
                    openedOnce = true
                    subscribedRoomId = null
                    subscribeScope()
                    startDeliveryRecovery(epoch, generation)
                }
            },
            onFailure = { msg ->
                if (epoch == profileEpoch) {
                    connecting = false
                    connectError = msg
                    if (hub.state.terminal) {
                        connectionWanted = false
                        agentStatus = "offline"
                        val reason = when (hub.state) {
                            HubConnectionState.AuthFailed -> "auth"
                            HubConnectionState.PolicyRejected -> "policy"
                            else -> "invalid_config"
                        }
                        prefs.edit().apply {
                            if (savedHubConnection(getApplication()) == profile) remove("last").remove("last_v2")
                            putString("background_stop_reason", reason)
                        }.apply()
                        getApplication<Application>().stopService(Intent(getApplication(), HubService::class.java))
                        refreshBackgroundStatus()
                    } else agentStatus = "reconnecting"
                }
            })
    }

    private fun currentConnection(epoch: Int, generation: Int) =
        epoch == profileEpoch && generation == missionConnectionGeneration && connectionWanted && hub.isConnected

    private fun adoptDeliveryInfo(info: JsonObject) {
        val id = (info["hubId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() && it.length <= 256 }
        val maxAge = (info["maxReplayAgeMs"] as? JsonPrimitive)?.longOrNull ?: 24 * 3600_000L
        val protocol = if ((info["deliveryProtocol"] as? JsonPrimitive)?.intOrNull == 1 && id != null && maxAge > 0) 1 else 0
        if (deliveryHubId != null && deliveryHubId != id) {
            saveComposition()
            exitHistoryAnchor()
            currentRoom = null
            currentSession = null
            chatItems.clear()
            chatCache.clear()
            historyMoreCache.clear()
            chatCacheKeys.clear()
            flowCache.clear()
            panelsCache.clear()
            scopeSeen.clear()
            deliveryRecovery.clear()
            recoveryResetBase.clear()
            flow = null
            quote = null
            helpReplyTo = null
            pendingAttachments.clear()
            currentArtifacts.clear()
            currentEvents.clear()
            blackboard.clear()
            missions.clear()
            pendingDecisions.clear()
            missionChecked = false
            missionSupported = false
            missionExecutionTarget = null
            screen = Screen.Sessions
        }
        deliveryHubId = id
        deliveryProtocol = protocol
        deliveryMaxAgeMs = minOf(maxAge, 24 * 3600_000L)
        delivery.bind(id, protocol, deliveryMaxAgeMs)
        delivery.records.filter { currentDelivery(it) }.forEach { recordDelivery(it) }
    }

    private fun startDeliveryRecovery(epoch: Int = profileEpoch, generation: Int = missionConnectionGeneration) {
        val seq = ++warmupSeq
        deliveryReady = false
        recoveryJob?.cancel()
        recoveryJob = viewModelScope.launch {
            repeat(3) { attempt ->
                try {
                    if (!syncRefreshAll(generation, epoch, ::adoptDeliveryInfo)) error("recovery_snapshot_unavailable")
                    if (!currentConnection(epoch, generation) || seq != warmupSeq) return@launch
                    val key = scopeKey()
                    if (key != null) {
                        val exists = if (key.startsWith("room:")) rooms.any { "room:${it.roomId}" == key }
                            else sessions.any { "session:${it.sessionId}" == key }
                        if (exists) recoverScope(key)
                        else {
                            saveComposition()
                            currentRoom = null
                            currentSession = null
                            anchorScopeKey = null
                            chatItems.clear()
                            pendingAttachments.clear()
                            quote = null
                            helpReplyTo = null
                            screen = Screen.Sessions
                        }
                    }
                    if (!currentConnection(epoch, generation) || seq != warmupSeq) return@launch
                    deliveryReady = true
                    // 第三闸：recovery 直拷 delivery.error 同样按本连接在途记录过滤瞬态错误
                    deliveryError = if (delivery.error != null && delivery.error in setOf(
                            "context", "sync", "expired", "attachments", "unsupported") &&
                        delivery.records.none {
                            currentDelivery(it) && it.status in setOf("pending", "sending", "uncertain", "failed")
                        }) null else delivery.error
                    delivery.resume()
                    openPendingAttention()
                    historyLoading = false
                    return@launch
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    if (!currentConnection(epoch, generation) || seq != warmupSeq) return@launch
                    deliveryError = "sync"
                    if (attempt < 2) delay(250L * (attempt + 1))
                }
            }
        }
    }

    fun retryDeliveryRecovery() {
        if (!hub.isConnected) {
            currentProfile?.let { connect(it.address, it.token, it.publicToken, it.name) }
            return
        }
        if (deliveryReady) refreshAll() else startDeliveryRecovery()
    }

    fun disconnect() = resetConnection(clearSaved = true)

    private fun resetConnection(clearSaved: Boolean) {
        saveComposition()
        if (::delivery.isInitialized) delivery.select(null)
        if (::deliveryRecovery.isInitialized) deliveryRecovery.clear()
        deliveryReady = false
        deliveryOrigin = ""
        deliveryHubId = null
        deliveryProtocol = 0
        anchorScopeKey = null
        recoveryResetBase.clear()
        profileEpoch++
        missionConnectionGeneration++
        connectionWanted = false
        recoveryJob?.cancel()
        eventJob?.cancel()
        eventJob = null
        hub.disconnect()
        if (clearSaved) {
            prefs.edit().remove("last").remove("last_v2").remove("background_stop_reason").apply()
            val app = getApplication<Application>()
            app.stopService(Intent(app, HubService::class.java))
        }
        connectionState = HubConnectionState.Disconnected
        refreshBackgroundStatus()
        sessions.clear()
        rooms.clear()
        roles.clear()
        skills.clear()
        connections.clear()
        chatItems.clear()
        busyIds.clear()
        currentSession = null
        currentRoom = null
        helpReplyTo = null
        currentArtifacts.clear()
        currentEvents.clear()
        blackboard.clear()
        flow = null
        quote = null
        pendingAttachments.clear()
        fileRefToInsert = null
        chatCache.clear()
        historyMoreCache.clear()
        chatCacheKeys.clear()
        scopeSeen.clear()
        flowCache.clear()
        panelsCache.clear()
        connecting = false
        connectError = null
        agentStatus = "offline"
        hubLocalOnly = false
        currentProfile = null
        missions.clear()
        missionSupported = false
        missionChecked = false
        missionLoading = false
        missionError = null
        missionFocusId = null
        missionExecutionTarget = null
        missionNavMessage = null
        roomOpenSeq++
        missionListSeq++
        decisionListSeq++
        pendingDecisions.clear()
        decisionLoading = false
        screen = Screen.Sessions
    }

    fun refreshAll() {
        viewModelScope.launch {
            if (syncRefreshAll()) {
                if (deliveryReady) delivery.resume()
            }
        }
    }

    /** IFC：门控错误（private 读/未授权写）映射为用户可读"待批准"提示 */
    private fun ifcHint(msg: String): String =
        if (msg.contains("is private") || msg.contains("ifcAuthorized"))
            "${stringsFor(lang).ifcPendingApproval}: $msg" else msg

    internal fun attentionCurrent(target: AttentionTarget) =
        target.extras["navOrigin"] == deliveryOrigin && target.extras["navHubId"] == deliveryHubId

    fun openAttentionTarget(extras: Map<String, String>) {
        if (extras["navOrigin"].isNullOrBlank() || extras["navHubId"].isNullOrBlank()) {
            attentionNavError = "wrong_connection"
            return
        }
        pendingAttention = extras.toMap()
        openPendingAttention()
    }

    fun dismissAttentionNavigation() {
        pendingAttention = null
        attentionNavError = null
    }

    private fun openPendingAttention() {
        val target = pendingAttention ?: return
        if (!deliveryReady) return
        if (target["navOrigin"] != deliveryOrigin || target["navHubId"] != deliveryHubId) {
            attentionNavError = "wrong_connection"
            return
        }
        pendingAttention = null
        attentionNavError = null
        attentionRequestId = null
        // 处理后本地销记：导航成功即从徽标移除该待办（仍真实待办的会在下次 reconcile 补回）
        val navKeys = listOf("navRoomId", "navFlowId", "navTaskId", "navHelpId", "navDecisionId", "navRequestId", "navBatchKey")
        attentionItems.removeAll { t -> navKeys.all { k -> (target[k] ?: "") == (t.extras[k] ?: "") } }
        val roomId = target["navRoomId"]
        val anchor = target["navAt"]?.toLongOrNull()?.takeIf { it > 0 }
        val request = target["navRequestId"]
        if (roomId != null) {
            val room = rooms.find { it.roomId == roomId }
            if (room == null) { attentionNavError = "gone"; return }
            openRoom(room, anchorAt = if (target["navDecisionId"] != null) anchor else null, readOnly = true) {
                missionExecutionTarget = if (target["navFlowId"] == null) null else MissionExecutionTarget(
                    missionId = "", roomId = roomId, flowId = target["navFlowId"], taskId = target["navTaskId"],
                    dispatchedAt = target["navDispatchedAt"]?.toLongOrNull()?.takeIf { it > 0 }, nonce = System.nanoTime(),
                )
                attentionRequestId = request
                target["navHelpId"]?.let { help ->
                    if (flow?.flowId != target["navFlowId"] || (flow?.clarificationId != help &&
                            flow?.tasks?.none { it.waitingHelpId == help && it.waitingFor == "user" } != false)) {
                        attentionNavError = "gone"
                    }
                }
                val batch = target["navBatchKey"]?.toLongOrNull()
                val taskBatch = target["navDispatchedAt"]?.toLongOrNull()?.takeIf { it > 0 }
                if (target["navFlowId"] != null && (flow?.flowId != target["navFlowId"] ||
                    (batch != null && (flow?.tasks?.maxOfOrNull { it.dispatchedAt } ?: 0) != batch) ||
                    (taskBatch != null && flow?.tasks?.find { it.id == target["navTaskId"] }?.dispatchedAt != taskBatch))) {
                    attentionNavError = "gone"
                }
            }
        } else {
            val session = sessions.find { it.sessionId == target["navSessionId"] }
            if (session == null) { attentionNavError = "gone"; return }
            openChat(session, anchorAt = anchor, readOnly = true) { attentionRequestId = request }
        }
    }

    private suspend fun syncRefreshAll(
        generation: Int = missionConnectionGeneration,
        epoch: Int = profileEpoch,
        onInfo: (JsonObject) -> Unit = {},
    ): Boolean = coroutineScope {
        fun valid() = currentConnection(epoch, generation)
        if (!valid()) return@coroutineScope false
        try {
            val info = hub.call("agent.info")
            if (!valid()) return@coroutineScope false
            onInfo(info)
            val ntfy = info["ntfy"] as? JsonObject
            ntfyTopic = ntfy?.get("topic")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                ?: info["hubId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }?.let { "agenthub-$it" }
            ntfyUrl = ntfy?.get("url")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: "https://ntfy.sh"
            val agents = info["agents"] as? JsonArray ?: JsonArray(emptyList())
            hubAgentTypes.clear()
            agents.forEach { hubAgentTypes.add(it.jsonPrimitive.content) }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            return@coroutineScope false
        }
        try {
            val cResult = hub.call("connection.list")
            if (!valid()) return@coroutineScope false
            val cList = cResult["connections"]?.jsonArray ?: JsonArray(emptyList())
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
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        if (!valid()) return@coroutineScope false
        var sessionsReady = false
        var roomsReady = false
        var tasksReady = false
        var missionsReady = false
        val jobs = listOf(
        async {
            try {
                val result = hub.call("session.list")
                if (!valid()) return@async
                val list = result["sessions"]?.jsonArray ?: return@async
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
                            backendType = o["backendType"]?.jsonPrimitive?.content,
                        )
                    )
                    parseReportedQuota(o["quota"])?.let { memberQuotas[o["sessionId"]!!.jsonPrimitive.content] = it }
                }
                syncBusyIdsFromList(sessions)
                sessionsReady = true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        },
        async {
            try {
                val result = hub.call("role.list")
                if (!valid()) return@async
                val list = result["roles"]?.jsonArray ?: return@async
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
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        },
        async {
            try {
                val connId = connections.firstOrNull()?.id
                val result = if (connId != null) hub.call("skill.list", buildJsonObject { put("connectionId", connId) }) else hub.call("skill.list")
                if (!valid()) return@async
                val list = result["skills"]?.jsonArray ?: return@async
                skills.clear()
                for (s in list) {
                    val o = s.jsonObject
                    skills.add(SkillInfo(
                        o["name"]?.jsonPrimitive?.content ?: "",
                        o["description"]?.jsonPrimitive?.content ?: "",
                        o["location"]?.jsonPrimitive?.content ?: "",
                        o["scope"]?.jsonPrimitive?.content ?: "user",
                    ))
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        },
        async {
            try {
                val result = hub.call("room.list")
                if (!valid()) return@async
                val list = result["rooms"]?.jsonArray ?: return@async
                rooms.clear()
                for (r in list) rooms.add(parseRoom(r.jsonObject))
                currentRoom?.let { cur -> rooms.find { it.roomId == cur.roomId }?.let { currentRoom = it } }
                roomsReady = true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        },
        async {
            try {
                val result = hub.call("task.list")
                if (!valid()) return@async
                val list = result["tasks"]?.jsonArray ?: return@async
                val parsed = list.map { parseTask(it.jsonObject) }
                scheduledTasks.clear()
                scheduledTasks.addAll(parsed)
                tasksReady = true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            }
        },
        async {
            missionsReady = valid() && syncRefreshMissions()
        },
        )
        jobs.awaitAll()
        val decisionsReady = valid() && syncRefreshDecisions()
        valid() && sessionsReady && roomsReady && tasksReady && missionsReady && decisionsReady
    }

    private suspend fun syncRefreshMissions(retry: Boolean = true): Boolean {
        if (missionChecked && !missionSupported) return true
        val gen = missionConnectionGeneration
        val seq = ++missionListSeq
        val rev = missionEventRev
        missionLoading = true
        try {
            val result = hub.call("mission.list")
            if (gen != missionConnectionGeneration || seq != missionListSeq) return false
            if (rev != missionEventRev) {
                return retry && syncRefreshMissions(false)
            }
            val list = result["missions"] as? JsonArray ?: return false
            val fresh = list.map { parseMission(it.jsonObject) }
            val byId = fresh.associateBy { it.id }.toMutableMap()
            for (old in missions) {
                val f = byId[old.id]
                if (f != null && old.revision > f.revision) byId[old.id] = old
            }
            missions.clear()
            missions.addAll(byId.values)
            missionSupported = true
            missionChecked = true
            missionError = null
            return true
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (gen != missionConnectionGeneration || seq != missionListSeq || rev != missionEventRev) return false
            if (e.message?.contains("unknown method") == true || e.message?.contains("-32601") == true) {
                missions.clear()
                missionSupported = false
                missionChecked = true
                missionError = null
                return true
            } else {
                missionError = e.message ?: e.toString()
                return false
            }
        } finally {
            if (gen == missionConnectionGeneration && seq == missionListSeq) missionLoading = false
        }
    }

    fun refreshDecisions(retry: Boolean = true) {
        viewModelScope.launch { syncRefreshDecisions(retry) }
    }

    private suspend fun syncRefreshDecisions(retry: Boolean = true): Boolean {
        val gen = missionConnectionGeneration
        val seq = ++decisionListSeq
        val rev = decisionEventRev
        decisionLoading = true
        try {
            val result = hub.call("decision.list")
            if (gen != missionConnectionGeneration || seq != decisionListSeq) return false
            if (rev != decisionEventRev) return retry && syncRefreshDecisions(false)
            val list = result["decisions"] as? JsonArray ?: return false
            pendingDecisions.clear()
            for (d in list) pendingDecisions.add(parseDecision(d.jsonObject))
            return true
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (gen == missionConnectionGeneration && seq == decisionListSeq && rev == decisionEventRev) {
                if (e.message?.contains("unknown method") == true || e.message?.contains("-32601") == true) {
                    pendingDecisions.clear()
                    return true
                } else {
                    missionError = e.message ?: e.toString()
                }
            }
            return false
        } finally {
            if (gen == missionConnectionGeneration && seq == decisionListSeq) decisionLoading = false
        }
    }

    private fun parseDecision(o: JsonObject): PendingDecision {
        val ctx = o["context"] as? JsonObject
        val summary = if (ctx?.get("redacted")?.jsonPrimitive?.content == "true") "redacted"
        else listOf("command", "path", "url", "kind", "name")
            .mapNotNull { ctx?.get(it)?.jsonPrimitive?.contentOrNull }
            .filter { it.isNotEmpty() }
            .joinToString(" · ") { it.take(80) }
        return PendingDecision(
            decisionId = (o["decisionId"] as? JsonPrimitive)?.contentOrNull ?: "",
            requestId = (o["requestId"] as? JsonPrimitive)?.contentOrNull ?: "",
            type = o["type"]?.jsonPrimitive?.content ?: "permission",
            title = o["title"]?.jsonPrimitive?.content ?: "",
            options = (o["options"] as? JsonArray)?.mapNotNull {
                val p = it as? JsonObject ?: return@mapNotNull null
                val oid = (p["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
                oid to ((p["label"] as? JsonPrimitive)?.contentOrNull ?: oid)
            } ?: emptyList(),
            contextSummary = summary,
            requestedBy = o["requestedBy"]?.jsonPrimitive?.content ?: "",
            sessionId = o["sessionId"]?.jsonPrimitive?.content ?: "",
            roomId = o["roomId"]?.jsonPrimitive?.contentOrNull,
            at = o["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
        )
    }

    fun respondToDecision(d: PendingDecision, optionId: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                hub.call("permission.respond", buildJsonObject {
                    put("requestId", d.requestId)
                    put("optionId", optionId)
                    put("scope", "once")
                })
                if (gen == missionConnectionGeneration) onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun reviewMission(id: String, index: Int, verdict: String, taskIds: List<String>, note: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.review", buildJsonObject {
                    put("id", id)
                    put("index", index)
                    put("verdict", verdict)
                    put("taskIds", JsonArray(taskIds.map { JsonPrimitive(it) }))
                    put("note", note)
                })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun acceptMission(id: String, note: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.accept", buildJsonObject {
                    put("id", id)
                    put("note", note)
                })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun reworkMission(id: String, note: String, onDone: (Mission?) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.rework", buildJsonObject {
                    put("id", id)
                    put("note", note)
                })
                if (gen != missionConnectionGeneration) return@launch
                val m = parseMission(result["mission"]!!.jsonObject)
                upsertMission(m)
                missionError = null
                onDone(m)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(null)
                }
            }
        }
    }

    fun updateMissionContract(id: String, goal: String, acceptanceCriteria: List<String>, scope: String, constraints: List<String>, ownerSessionId: String?, maxAutoRetries: Int = 0, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.updateContract", buildJsonObject {
                    put("id", id)
                    put("goal", goal)
                    put("acceptanceCriteria", JsonArray(acceptanceCriteria.map { JsonPrimitive(it) }))
                    put("scope", scope)
                    put("constraints", JsonArray(constraints.map { JsonPrimitive(it) }))
                    put("maxAutoRetries", maxAutoRetries)
                    ownerSessionId?.let { put("ownerSessionId", it) }
                })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun supplementMission(id: String, text: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.supplement", buildJsonObject {
                    put("id", id)
                    put("text", text)
                })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun retryMission(id: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.retry", buildJsonObject { put("id", id) })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun createMissionSchedule(
        name: String,
        roomId: String,
        roomName: String,
        message: String,
        time: String,
        missionId: String,
        missionAutoStart: Boolean,
        onDone: (Boolean) -> Unit = {},
    ) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                hub.call("task.create", buildJsonObject {
                    put("name", name)
                    put("targetType", "room")
                    put("targetId", roomId)
                    put("targetName", roomName)
                    put("message", message)
                    put("schedule", buildJsonObject {
                        put("mode", "simple")
                        put("kind", "daily")
                        put("time", time)
                    })
                    put("enabled", true)
                    put("missionId", missionId)
                    put("missionAutoStart", missionAutoStart)
                })
                if (gen == missionConnectionGeneration) {
                    loadScheduledTasks()
                    onDone(true)
                }
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    private fun upsertMission(m: Mission) {
        val local = missions.find { it.id == m.id }
        // 仅当双方 revision 均来自真实字段时才做新旧守卫；incoming 无 revision
        // （旧 Hub）时直接接受更新，local 无 revision 时其 0 是缺省值不可信
        if (local != null && m.hasRevision && local.hasRevision && local.revision >= m.revision) return
        missions.removeAll { it.id == m.id }
        missions.add(m)
    }

    fun refreshMissions() {
        viewModelScope.launch { syncRefreshMissions() }
    }

    fun createMission(
        roomId: String,
        goal: String,
        acceptanceCriteria: List<String>,
        scope: String,
        constraints: List<String>,
        ownerSessionId: String?,
        maxAutoRetries: Int = 0,
        onDone: (Mission?) -> Unit = {},
    ) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.create", buildJsonObject {
                    put("roomId", roomId)
                    put("goal", goal)
                    put("acceptanceCriteria", JsonArray(acceptanceCriteria.map { JsonPrimitive(it) }))
                    put("scope", scope)
                    put("constraints", JsonArray(constraints.map { JsonPrimitive(it) }))
                    put("maxAutoRetries", maxAutoRetries)
                    ownerSessionId?.let { put("ownerSessionId", it) }
                })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(parseMission(result["mission"]!!.jsonObject))
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(null)
                }
            }
        }
    }

    fun startMission(id: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.start", buildJsonObject { put("id", id) })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun deleteMission(id: String, force: Boolean = false, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                hub.call("mission.delete", buildJsonObject { put("id", id); put("force", force) })
                if (gen != missionConnectionGeneration) return@launch
                missions.removeAll { it.id == id }
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    fun stopMission(id: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val gen = missionConnectionGeneration
            try {
                val result = hub.call("mission.stop", buildJsonObject { put("id", id) })
                if (gen != missionConnectionGeneration) return@launch
                upsertMission(parseMission(result["mission"]!!.jsonObject))
                missionError = null
                onDone(true)
            } catch (e: Exception) {
                if (gen == missionConnectionGeneration) {
                    missionError = e.message ?: e.toString()
                    onDone(false)
                }
            }
        }
    }

    private fun parseMission(o: JsonObject): Mission {
        val str = { key: String -> (o[key] as? JsonPrimitive)?.contentOrNull }
        val strList = { key: String ->
            (o[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
        }
        val revision = (o["revision"] as? JsonPrimitive)?.intOrNull
        return Mission(
            id = str("id") ?: "",
            roomId = str("roomId") ?: "",
            goal = str("goal") ?: "",
            acceptanceCriteria = strList("acceptanceCriteria"),
            scope = str("scope") ?: "",
            constraints = strList("constraints"),
            ownerSessionId = str("ownerSessionId") ?: "",
            status = str("status") ?: "draft",
            createdAt = str("createdAt")?.toLongOrNull() ?: 0,
            updatedAt = str("updatedAt")?.toLongOrNull() ?: 0,
            startedAt = str("startedAt")?.toLongOrNull(),
            finishedAt = str("finishedAt")?.toLongOrNull(),
            flowId = str("flowId"),
            flow = o["flow"] as? JsonObject,
            output = str("output"),
            error = str("error"),
            events = (o["events"] as? JsonArray)?.mapNotNull {
                val ev = it as? JsonObject ?: return@mapNotNull null
                MissionEvent(
                    (ev["id"] as? JsonPrimitive)?.contentOrNull ?: "",
                    (ev["at"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0,
                    (ev["kind"] as? JsonPrimitive)?.contentOrNull ?: "",
                    (ev["text"] as? JsonPrimitive)?.contentOrNull ?: "",
                    flowId = (ev["flowId"] as? JsonPrimitive)?.contentOrNull,
                    taskId = (ev["taskId"] as? JsonPrimitive)?.contentOrNull,
                    sessionId = (ev["sessionId"] as? JsonPrimitive)?.contentOrNull,
                    dispatchedAt = (ev["dispatchedAt"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull(),
                    phase = (ev["phase"] as? JsonPrimitive)?.contentOrNull,
                )
            } ?: emptyList(),
            reviews = (o["reviews"] as? JsonArray)?.mapNotNull {
                val rv = it as? JsonObject ?: return@mapNotNull null
                MissionReview(
                    index = (rv["index"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 0,
                    verdict = (rv["verdict"] as? JsonPrimitive)?.contentOrNull ?: "unverified",
                    taskIds = (rv["taskIds"] as? JsonArray)?.mapNotNull { t -> (t as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
                    note = (rv["note"] as? JsonPrimitive)?.contentOrNull ?: "",
                    at = (rv["at"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0,
                )
            } ?: emptyList(),
            acceptanceNote = ((o["acceptance"] as? JsonObject)?.get("note") as? JsonPrimitive)?.contentOrNull,
            supplements = (o["supplements"] as? JsonArray)?.mapNotNull {
                val sp = it as? JsonObject ?: return@mapNotNull null
                MissionSupplement(
                    id = (sp["id"] as? JsonPrimitive)?.contentOrNull ?: "",
                    at = (sp["at"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: 0,
                    text = (sp["text"] as? JsonPrimitive)?.contentOrNull ?: "",
                    delivered = (sp["delivered"] as? JsonPrimitive)?.contentOrNull?.toBoolean() ?: false,
                )
            } ?: emptyList(),
            parentMissionId = str("parentMissionId"),
            reworkReason = str("reworkReason"),
            maxAutoRetries = (o["maxAutoRetries"] as? JsonPrimitive)?.intOrNull ?: 0,
            autoRetryCount = (o["autoRetryCount"] as? JsonPrimitive)?.intOrNull ?: 0,
            revision = revision ?: 0,
            hasRevision = revision != null,
        )
    }

    private fun parseTask(o: JsonObject): ScheduledTask {
        val sched = o["schedule"]!!.jsonObject
        return ScheduledTask(
            id = o["id"]!!.jsonPrimitive.content,
            name = o["name"]!!.jsonPrimitive.content,
            targetType = o["targetType"]?.jsonPrimitive?.content ?: "session",
            targetId = o["targetId"]!!.jsonPrimitive.content,
            targetName = o["targetName"]?.jsonPrimitive?.content ?: "",
            message = o["message"]!!.jsonPrimitive.content,
            scheduleMode = sched["mode"]?.jsonPrimitive?.content ?: "simple",
            simpleKind = sched["kind"]?.jsonPrimitive?.content,
            time = sched["time"]?.jsonPrimitive?.content,
            intervalMinutes = sched["intervalMinutes"]?.jsonPrimitive?.content?.toIntOrNull(),
            at = sched["at"]?.jsonPrimitive?.content?.toLongOrNull(),
            cronExpr = sched["expr"]?.jsonPrimitive?.content,
            enabled = o["enabled"]?.jsonPrimitive?.content?.toBoolean() ?: true,
            lastRunAt = o["lastRunAt"]?.jsonPrimitive?.content?.toLongOrNull(),
            nextRunAt = o["nextRunAt"]?.jsonPrimitive?.content?.toLongOrNull(),
            createdAt = o["createdAt"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
            missionTemplate = o["missionTemplate"] as? JsonObject,
            missionAutoStart = o["missionAutoStart"]?.jsonPrimitive?.contentOrNull == "true",
            eventKind = o["eventTrigger"]?.jsonObject?.get("events")?.jsonArray
                ?.mapNotNull { it.jsonPrimitive.contentOrNull }
                ?.takeIf { it.isNotEmpty() }
                ?.joinToString("/"),
        )
    }

    fun loadScheduledTasks() {
        viewModelScope.launch {
            try {
                val result = hub.call("task.list")
                val list = result["tasks"]?.jsonArray ?: return@launch
                val parsed = list.map { parseTask(it.jsonObject) }
                scheduledTasks.clear()
                scheduledTasks.addAll(parsed)
            } catch (_: Exception) {
            }
        }
    }

    fun createScheduledTask(
        name: String,
        targetType: String,
        targetId: String,
        targetName: String,
        message: String,
        scheduleMode: String,
        simpleKind: String?,
        time: String?,
        intervalMinutes: Int?,
        at: Long?,
        cronExpr: String?,
        enabled: Boolean,
        onDone: () -> Unit = {},
    ) {
        viewModelScope.launch {
            try {
                val sched = buildJsonObject {
                    put("mode", scheduleMode)
                    if (scheduleMode == "simple") {
                        simpleKind?.let { put("kind", it) }
                        time?.let { put("time", it) }
                        intervalMinutes?.let { put("intervalMinutes", it) }
                        at?.let { put("at", it) }
                    } else {
                        cronExpr?.let { put("expr", it) }
                    }
                }
                val result = hub.call("task.create", buildJsonObject {
                    put("name", name)
                    put("targetType", targetType)
                    put("targetId", targetId)
                    put("targetName", targetName)
                    put("message", message)
                    put("schedule", sched)
                    put("enabled", enabled)
                })
                val task = parseTask(result["task"]!!.jsonObject)
                scheduledTasks.add(task)
                onDone()
            } catch (_: Exception) {
            }
        }
    }

    fun updateScheduledTask(
        id: String,
        name: String,
        targetType: String,
        targetId: String,
        targetName: String,
        message: String,
        scheduleMode: String,
        simpleKind: String?,
        time: String?,
        intervalMinutes: Int?,
        at: Long?,
        cronExpr: String?,
        enabled: Boolean,
        onDone: () -> Unit = {},
    ) {
        viewModelScope.launch {
            try {
                val sched = buildJsonObject {
                    put("mode", scheduleMode)
                    if (scheduleMode == "simple") {
                        simpleKind?.let { put("kind", it) }
                        time?.let { put("time", it) }
                        intervalMinutes?.let { put("intervalMinutes", it) }
                        at?.let { put("at", it) }
                    } else {
                        cronExpr?.let { put("expr", it) }
                    }
                }
                val result = hub.call("task.update", buildJsonObject {
                    put("id", id)
                    put("name", name)
                    put("targetType", targetType)
                    put("targetId", targetId)
                    put("targetName", targetName)
                    put("message", message)
                    put("schedule", sched)
                    put("enabled", enabled)
                })
                val task = parseTask(result["task"]!!.jsonObject)
                val idx = scheduledTasks.indexOfFirst { it.id == id }
                if (idx >= 0) scheduledTasks[idx] = task
                onDone()
            } catch (_: Exception) {
            }
        }
    }

    fun deleteScheduledTask(id: String) {
        viewModelScope.launch {
            try {
                hub.call("task.delete", buildJsonObject { put("id", id) })
                scheduledTasks.removeAll { it.id == id }
            } catch (_: Exception) {
            }
        }
    }

    fun toggleScheduledTask(id: String) {
        viewModelScope.launch {
            try {
                val result = hub.call("task.toggle", buildJsonObject { put("id", id) })
                val task = parseTask(result["task"]!!.jsonObject)
                val idx = scheduledTasks.indexOfFirst { it.id == id }
                if (idx >= 0) scheduledTasks[idx] = task
            } catch (_: Exception) {
            }
        }
    }

    private fun parseLog(o: JsonObject): TaskLog {
        return TaskLog(
            id = o["id"]!!.jsonPrimitive.content,
            taskId = o["taskId"]!!.jsonPrimitive.content,
            taskName = o["taskName"]?.jsonPrimitive?.content ?: "",
            targetType = o["targetType"]?.jsonPrimitive?.content ?: "session",
            targetId = o["targetId"]?.jsonPrimitive?.content ?: "",
            targetName = o["targetName"]?.jsonPrimitive?.content ?: "",
            message = o["message"]?.jsonPrimitive?.content ?: "",
            at = o["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0,
            success = o["success"]?.jsonPrimitive?.content?.toBoolean() ?: false,
            error = o["error"]?.jsonPrimitive?.content,
        )
    }

    fun loadTaskLogs() {
        viewModelScope.launch {
            try {
                val result = hub.call("task.logs", buildJsonObject { put("limit", 200) })
                val list = result["logs"]?.jsonArray ?: return@launch
                taskLogs.clear()
                for (l in list) taskLogs.add(parseLog(l.jsonObject))
            } catch (_: Exception) {
            }
        }
    }

    fun clearTaskLogs() {
        viewModelScope.launch {
            try {
                hub.call("task.clearLogs")
                taskLogs.clear()
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

    data class RoomModeConfig(
        val conductorId: String? = null,
        val parallelSummarizerId: String? = null,
        val pipelineOrder: List<String>? = null,
        val debateSides: Pair<String, String>? = null,
        val debateJudge: String? = null,
        val debateRounds: Int? = null,
        val memberRoles: Map<String, String>? = null,
    )

    fun createRoom(name: String, memberIds: List<String>, mode: String, config: RoomModeConfig) {
        viewModelScope.launch {
            try {
                val result = hub.call("room.create", buildJsonObject {
                    put("name", name)
                    put("sessionIds", buildJsonArray { memberIds.forEach { add(it) } })
                    put("mode", mode)
                    config.conductorId?.let { put("conductorId", it) }
                    config.parallelSummarizerId?.let { put("parallelSummarizerId", it) }
                    config.pipelineOrder?.let { put("pipelineOrder", buildJsonArray { it.forEach { id -> add(id) } }) }
                    config.debateSides?.let { put("debateSides", buildJsonArray { add(it.first); add(it.second) }) }
                    config.debateJudge?.let { put("debateJudge", it) }
                    config.debateRounds?.let { put("debateRounds", it) }
                    if (!config.memberRoles.isNullOrEmpty()) {
                        put("memberRoles", buildJsonObject {
                            config.memberRoles.forEach { (sid, persona) ->
                                if (persona.isNotBlank()) put(sid, personaJsonValue(persona))
                            }
                        })
                    }
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

    fun updateRoom(room: RoomInfo, name: String, memberIds: List<String>, mode: String, config: RoomModeConfig) {
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
                    config.conductorId?.let { put("conductorId", it) }
                    config.parallelSummarizerId?.let { put("parallelSummarizerId", it) }
                    config.pipelineOrder?.let { put("pipelineOrder", buildJsonArray { it.forEach { id -> add(id) } }) }
                    config.debateSides?.let { put("debateSides", buildJsonArray { add(it.first); add(it.second) }) }
                    config.debateJudge?.let { put("debateJudge", it) }
                    config.debateRounds?.let { put("debateRounds", it) }
                    if (!config.memberRoles.isNullOrEmpty()) {
                        put("memberRoles", buildJsonObject {
                            config.memberRoles.forEach { (sid, persona) ->
                                if (persona.isNotBlank()) put(sid, personaJsonValue(persona))
                            }
                        })
                    }
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

    private fun dropScopeCache(scope: String, id: String) {
        val key = "$scope:$id"
        chatCache.remove(key)
        chatCacheKeys.remove(key)
        scopeSeen.remove(key)
        panelsCache.remove(key)
        recoveryResetBase.remove(key)
        historyMoreCache.remove(key)
        if (scope == "room") {
            flowCache.remove(id)
            HubService.dropRoomAttention(id)
        }
    }

    fun deleteRoom(room: RoomInfo) {
        viewModelScope.launch {
            try {
                hub.call("room.delete", buildJsonObject {
                    put("roomId", room.roomId)
                })
                dropScopeCache("room", room.roomId)
                if (currentRoom?.roomId == room.roomId) backToList()
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun archiveRoom(room: RoomInfo, archived: Boolean) {
        viewModelScope.launch {
            try {
                hub.call("room.archive", buildJsonObject {
                    put("roomId", room.roomId)
                    put("archived", archived)
                })
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    private fun parseRoom(o: JsonObject): RoomInfo {
        val members = o["members"]!!.jsonArray.map {
            val m = it.jsonObject
            parseReportedQuota(m["quota"])?.let { memberQuotas[m["sessionId"]!!.jsonPrimitive.content] = it }
            m["sessionId"]!!.jsonPrimitive.content to
                m["name"]!!.jsonPrimitive.content
        }
        val debateSidesArr = o["debateSides"]?.jsonArray
        val debateSides = if (debateSidesArr != null && debateSidesArr.size >= 2) {
            debateSidesArr[0].jsonPrimitive.content to debateSidesArr[1].jsonPrimitive.content
        } else null
        return RoomInfo(
            roomId = o["roomId"]!!.jsonPrimitive.content,
            name = o["name"]!!.jsonPrimitive.content,
            mode = o["mode"]?.jsonPrimitive?.content ?: "mention",
            conductorId = o["conductorId"]?.jsonPrimitive?.content,
            members = members,
            archived = o["archived"]?.jsonPrimitive?.content?.toBoolean() ?: false,
            subMode = o["subMode"]?.jsonPrimitive?.contentOrNull,
            activeSpeaker = o["activeSpeaker"]?.jsonPrimitive?.contentOrNull,
            reason = o["reason"]?.jsonPrimitive?.content,
            aliases = o["aliases"]?.jsonObject?.keys?.toList() ?: emptyList(),
            memberRoles = o["memberRoles"]?.jsonObject?.let { obj ->
                obj.entries.mapNotNull { (k, v) ->
                    // 值可为字符串或 PersonaCard 对象——对象序列化回 JSON 字符串供编辑对话框双格式解析
                    val persona = if (v is JsonObject) v.toString() else v.jsonPrimitive.contentOrNull ?: ""
                    if (persona.isNotBlank()) k to persona else null
                }.toMap()
            },
            parallelSummarizerId = o["parallelSummarizerId"]?.jsonPrimitive?.content,
            pipelineOrder = o["pipelineOrder"]?.jsonArray?.map { it.jsonPrimitive.content },
            debateSides = debateSides,
            debateJudge = o["debateJudge"]?.jsonPrimitive?.content,
            debateRounds = o["debateRounds"]?.jsonPrimitive?.intOrNull,
            sensitivity = o["sensitivity"]?.jsonPrimitive?.contentOrNull ?: "shared",
        )
    }

    fun openChat(session: SessionInfo, anchorAt: Long? = null, readOnly: Boolean = false, onOpened: (() -> Unit)? = null) {
        roomOpenSeq++
        missionExecutionTarget = null
        if (session.offline && !readOnly) {
            resumeSession(session, autoOpen = true)
            return
        }
        val isSameSession = currentSession?.sessionId == session.sessionId
        saveCurrentScope()
        exitHistoryAnchor()
        listTab.value = 0
        currentSession = session
        currentRoom = null
        helpReplyTo = null
        if (!isSameSession) {
            currentArtifacts.clear()
            currentEvents.clear()
            blackboard.clear()
            quote = null
            flow = null
            chatItems.clear()
            scopeKey()?.let { key -> chatCache[key]?.let { chatItems.addAll(it) } }
        }
        restoreScopeCounts()
        fileRefToInsert = null
        historyHasMore = false
        historyLoading = false
        if (anchorAt == null) {
            inChatSearchQuery = ""
            jumpToHistoryId = null
        }
        chatSearchMatchIndex = -1
        chatSearchMatchCount = 0
        screen = Screen.Chat
        val history = loadHistory("session.history", "sessionId", session.sessionId, anchorAt)
        if (onOpened != null) {
            val seq = roomOpenSeq
            val generation = missionConnectionGeneration
            viewModelScope.launch {
                history.join()
                if (seq == roomOpenSeq && generation == missionConnectionGeneration && currentSession?.sessionId == session.sessionId) onOpened()
            }
        }
        viewModelScope.launch { refreshSessionArtifacts(session.sessionId) }
        refreshCurrentModel()
        refreshMemberStatus()
        refreshSessionUsage(session.sessionId)
    }

    fun openRoom(room: RoomInfo, anchorAt: Long? = null, readOnly: Boolean = false, onOpened: (() -> Unit)? = null) {
        val seq = ++roomOpenSeq
        if (!readOnly) missionExecutionTarget = null
        viewModelScope.launch {
            connectError = null
            try {
                syncRefreshAll()
                if (seq != roomOpenSeq) return@launch
                val latestRoom = rooms.find { it.roomId == room.roomId } ?: room
                if (!readOnly) {
                    val toResume = latestRoom.members.mapNotNull { (sid, _) ->
                        sessions.find { it.sessionId == sid && it.offline }
                    }
                    for (s in toResume) {
                        if (seq != roomOpenSeq) return@launch
                        resumeOne(s)
                    }
                    if (seq != roomOpenSeq) return@launch
                    syncRefreshAll()
                }
                if (seq != roomOpenSeq) return@launch
                val updatedRoom = rooms.find { it.roomId == room.roomId } ?: room
                val isSameRoom = currentRoom?.roomId == updatedRoom.roomId
                saveCurrentScope()
                exitHistoryAnchor()
                listTab.value = 1
                currentRoom = updatedRoom
                currentSession = null
                if (!isSameRoom) {
                    currentArtifacts.clear()
                    currentEvents.clear()
                    blackboard.clear()
                    quote = null
                    helpReplyTo = null
                    flow = flowCache[updatedRoom.roomId]
                    chatItems.clear()
                    scopeKey()?.let { key -> chatCache[key]?.let { chatItems.addAll(it) } }
                }
                restoreScopeCounts()
                fileRefToInsert = null
                historyHasMore = false
                historyLoading = false
                if (anchorAt == null) {
                    inChatSearchQuery = ""
                    jumpToHistoryId = null
                }
                chatSearchMatchIndex = -1
                chatSearchMatchCount = 0
                screen = Screen.Room
                val history = loadHistory("room.history", "roomId", updatedRoom.roomId, anchorAt)
                syncBusyIdsFromList(sessions)
                refreshArtifacts(updatedRoom.roomId)
                refreshCurrentModel()
                refreshMemberStatus()
                updatedRoom.activeSpeaker?.let { refreshSessionUsage(it) }
                history.join()
                if (seq == roomOpenSeq) onOpened?.invoke()
                subscribeScope(room.roomId)
                loadRoomMemory(room.roomId)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                connectError = e.message
            }
        }
    }

    /**
     * 编排卡兜底：flow 存在但时间线里还没有对应卡片时
     * （旧 Hub 无 flowId、房史条目尚未广播/加载），尾部补一张 live 合成卡。
     * "__live" 占位卡在拿到真实 flowId 后就地升级为正式卡，随后由房史条目接管。
     */
    private fun ensureFlowCard(f: FlowInfo?) {
        if (f == null) return
        val key = scopeKey() ?: return
        val items = scopeItems(key).toMutableList()
        val flowId = f.flowId.ifEmpty { "__live" }
        val existing = items.indexOfLast { it is ChatItem.Flow && it.flowId == flowId }
        if (existing >= 0) {
            items[existing] = (items[existing] as ChatItem.Flow).copy(snapshot = f)
            updateScopeItems(key, items)
            return
        }
        if (f.flowId.isNotEmpty()) {
            val liveIdx = items.indexOfLast { it is ChatItem.Flow && it.flowId == "__live" }
            if (liveIdx >= 0) {
                val prev = items[liveIdx]
                items[liveIdx] = ChatItem.Flow(
                    prev.id,
                    flowId,
                    f,
                    prev.author,
                    f.startedAt.takeIf { it > 0 } ?: prev.at,
                )
                updateScopeItems(key, items)
                return
            }
        }
        items.add(
            ChatItem.Flow(
                ++itemSeq,
                flowId,
                f,
                "",
                f.startedAt.takeIf { it > 0 } ?: System.currentTimeMillis(),
            )
        )
        updateScopeItems(key, items)
    }

    private suspend fun refreshArtifacts(roomId: String) {
        val generation = ++artifactRefreshGeneration
        try {
            val result = hub.call("room.artifacts", buildJsonObject {
                put("roomId", roomId)
                // IFC：用户驱动的房内容拉取带授权标记——private 房不被门控拒绝
                put("ifcAuthorized", true)
            })
            val artifacts = result["artifacts"]?.jsonArray?.map { parseArtifactInfo(it.jsonObject) } ?: emptyList()
            val events = result["events"]?.jsonArray?.map { parseEventInfo(it.jsonObject) } ?: emptyList()
            if (generation != artifactRefreshGeneration) return
            if (currentRoom?.roomId != roomId) return
            val board = result["blackboard"]?.jsonArray?.map { parseBlackboardEntry(it.jsonObject) } ?: emptyList()
            trackNewArtifacts(artifacts, events, board)
            currentArtifacts.clear()
            currentArtifacts.addAll(artifacts)
            currentEvents.clear()
            currentEvents.addAll(events)
            blackboard.clear()
            blackboard.addAll(board)
        } catch (e: Exception) {
            // ignore
        }
    }

    private suspend fun refreshSessionArtifacts(sessionId: String) {
        val generation = ++artifactRefreshGeneration
        try {
            val result = hub.call("session.artifacts", buildJsonObject { put("sessionId", sessionId) })
            val artifacts = result["artifacts"]?.jsonArray?.map { parseArtifactInfo(it.jsonObject) } ?: emptyList()
            val events = result["events"]?.jsonArray?.map { parseEventInfo(it.jsonObject) } ?: emptyList()
            if (generation != artifactRefreshGeneration) return
            if (currentRoom != null || currentSession?.sessionId != sessionId) return
            trackNewArtifacts(artifacts, events, null)
            currentArtifacts.clear()
            currentArtifacts.addAll(artifacts)
            currentEvents.clear()
            currentEvents.addAll(events)
        } catch (e: Exception) {
            // ignore
        }
    }

    private fun scopeKey(): String? =
        currentRoom?.let { "room:${it.roomId}" } ?: currentSession?.let { "session:${it.sessionId}" }

    fun composerKey(): String = JsonArray(listOf(
        JsonPrimitive(deliveryOrigin),
        deliveryHubId?.let { JsonPrimitive(it) } ?: JsonNull,
        scopeKey()?.let { JsonPrimitive(it) } ?: JsonNull,
    )).toString()

    private fun saveComposition() {
        if (scopeKey() == null) return
        val key = composerKey()
        if (pendingAttachments.isEmpty()) attachmentDrafts.remove(key)
        else attachmentDrafts[key] = pendingAttachments.toList()
        quote?.let { quoteDrafts[key] = it } ?: quoteDrafts.remove(key)
        helpReplyTo?.let { replyDrafts[key] = it } ?: replyDrafts.remove(key)
    }

    private fun restoreComposition() {
        val key = composerKey()
        pendingAttachments.clear()
        pendingAttachments.addAll(attachmentDrafts[key].orEmpty())
        quote = quoteDrafts[key]
        helpReplyTo = replyDrafts[key]
    }

    private fun scopeItems(key: String): List<ChatItem> =
        if (scopeKey() == key && anchorScopeKey != key) chatItems.toList() else chatCache[key].orEmpty()

    private fun updateScopeItems(key: String, items: List<ChatItem>) {
        chatCache[key] = items
        chatCacheKeys.remove(key)
        chatCacheKeys.addFirst(key)
        trimChatCache()
        if (scopeKey() == key && anchorScopeKey != key) {
            chatItems.clear()
            chatItems.addAll(items)
        } else if (scopeKey() == key) {
            for (i in chatItems.indices) {
                items.find { sameHistoryItem(it, chatItems[i]) }?.let { chatItems[i] = it }
            }
        }
    }

    private fun trimChatCache() {
        val protected = deliveryRecords.filter { currentDelivery(it) }.map { it.scopeKey }.toSet() + listOfNotNull(scopeKey())
        while (chatCacheKeys.size > 20) {
            val evicted = chatCacheKeys.reversed().firstOrNull { it !in protected } ?: break
            chatCacheKeys.remove(evicted)
            chatCache.remove(evicted)
            panelsCache.remove(evicted)
            scopeSeen.remove(evicted)
            historyMoreCache.remove(evicted)
            if (::deliveryRecovery.isInitialized) deliveryRecovery.forget(evicted)
        }
    }

    private fun exitHistoryAnchor() {
        val key = anchorScopeKey
        if (key != null && scopeKey() == key) {
            chatItems.clear()
            chatItems.addAll(chatCache[key].orEmpty())
        }
        anchorScopeKey = null
    }

    private fun recordDelivery(record: DeliveryRecord) {
        if (record.status in setOf("sent", "dismissed", "failed") && !currentDelivery(record)) {
            deliveryFiles.remove(record.clientMessageId)
        }
        if (record.origin != deliveryOrigin || record.hubId != deliveryHubId) return
        val items = scopeItems(record.scopeKey).toMutableList()
        val index = items.indexOfFirst { it is ChatItem.User && it.clientMessageId == record.clientMessageId }
        val previous = items.getOrNull(index) as? ChatItem.User
        val status = if (record.status == "pending" && record.deferred) "deferred" else record.status
        val bubble = previous?.copy(
            historyId = record.historyId ?: previous.historyId,
            sendStatus = status,
            sendError = record.error,
            attachmentNames = record.attachmentNames,
        ) ?: ChatItem.User(
            ++itemSeq, record.text,
            attachments = deliveryFiles[record.clientMessageId].orEmpty(),
            quoteAuthor = record.quoteAuthor,
            quoteText = record.quoteText,
            at = record.createdAt,
            clientMessageId = record.clientMessageId,
            historyId = record.historyId,
            sendStatus = status,
            sendError = record.error,
            attachmentNames = record.attachmentNames,
        )
        if (index >= 0) items[index] = bubble else if (record.status != "dismissed") items.add(bubble)
        updateScopeItems(record.scopeKey, items)
        if (record.status in setOf("sent", "dismissed", "failed")) deliveryFiles.remove(record.clientMessageId)
    }

    private fun updateDeliveryRecords(records: List<DeliveryRecord>) {
        deliveryRecords.clear()
        deliveryRecords.addAll(records)
        // 陈腐瞬态错误清理：context/sync 等错误面向"需重确认的记录"，
        // 全部记录处置完毕后不再挂 banner（storage/corrupt/full 为存储级故障保留）
        // 只按"本连接"在途记录判定——parked（其他连接）记录本端无法处置不该撑 banner
        if (deliveryError in setOf("context", "sync", "expired", "attachments", "unsupported") &&
            records.none { currentDelivery(it) && it.status in setOf("pending", "sending", "uncertain", "failed") }) {
            deliveryError = null
        }
    }

    private fun historyIdOf(item: ChatItem): Long? =
        (item as? ChatItem.User)?.historyId ?: item.id.takeIf { it < 0 }?.let { -it }

    private fun sameHistoryItem(a: ChatItem, b: ChatItem): Boolean {
        val id = historyIdOf(a)
        if (id != null && id == historyIdOf(b)) return true
        return when {
            a is ChatItem.User && b is ChatItem.User ->
                a.clientMessageId != null && a.clientMessageId == b.clientMessageId
            a is ChatItem.Flow && b is ChatItem.Flow -> a.flowId.isNotEmpty() && a.flowId == b.flowId
            a is ChatItem.Process && b is ChatItem.Process -> a.processId.isNotEmpty() && a.processId == b.processId
            a is ChatItem.Decision && b is ChatItem.Decision -> a.decisionId.isNotEmpty() && a.decisionId == b.decisionId
            a is ChatItem.Elicitation && b is ChatItem.Elicitation -> a.requestId.isNotEmpty() && a.requestId == b.requestId
            else -> false
        }
    }

    private fun applyRecoveredRows(key: String, rows: List<JsonObject>, reset: Boolean, cardsCurrent: Boolean) {
        val previous = scopeItems(key)
        val roomId = key.takeIf { it.startsWith("room:") }?.substringAfter(':')
        val incoming = rows.mapNotNull { row ->
            val id = (row["id"] as? JsonPrimitive)?.longOrNull ?: return@mapNotNull null
            val parsed = parseHistoryItem(row, -id, roomId) ?: return@mapNotNull null
            val original = previous.find { sameHistoryItem(it, parsed) }
            when {
                !cardsCurrent && (parsed is ChatItem.Flow || parsed is ChatItem.Decision) -> original ?: parsed
                parsed is ChatItem.User && original is ChatItem.User -> original.copy(historyId = id, historyAt = parsed.at, at = parsed.at)
                parsed is ChatItem.Decision && parsed.decisionType == "elicitation" -> {
                    val elicitation = previous.filterIsInstance<ChatItem.Elicitation>().find { it.requestId == parsed.requestId }
                    elicitation?.copy(id = -id, answered = if (parsed.status == "pending") elicitation.answered else parsed.answerLabel ?: parsed.status) ?: parsed
                }
                else -> parsed
            }
        }
        val base = if (reset) {
            val before = recoveryResetBase.remove(key).orEmpty()
            val owned = deliveryRecords.filter {
                it.origin == deliveryOrigin && it.hubId == deliveryHubId && it.scopeKey == key
            }.map { it.clientMessageId }.toSet()
            previous.filter { it !in before || (it is ChatItem.User && it.clientMessageId in owned) }
        } else previous
        val tail = base.filter { old -> incoming.none {
            sameHistoryItem(old, it) || (old is ChatItem.Permission && it is ChatItem.Decision && old.requestId == it.requestId)
        } }
        // 过程卡 at<=0 时用 turnEndAt/turnStartAt 归位——否则晚到的执行过程排尾部而非汇总前
        // 在途条目（流式/刚完成未合并 historyId）at 是回合开始时刻而非完成时刻，
        // 按其 at 排序会把 at 更大的迟到落库卡钉在流式结论之后——在途条目恒置尾键
        val combined = (incoming + dedupeTail(incoming, tail)).sortedBy { item ->
            val inFlight = historyIdOf(item) == null &&
                (item is ChatItem.Assistant || item is ChatItem.Thought ||
                    item is ChatItem.Tool || item is ChatItem.Plan)
            val at = if (inFlight) Long.MAX_VALUE
                else if (item is ChatItem.Process && item.at <= 0)
                    item.turnEndAt.takeIf { it > 0 } ?: item.turnStartAt
                else item.at
            if (at <= 0) Long.MAX_VALUE else at
        }
        updateScopeItems(key, combined)
        deliveryRecords.filter {
            it.origin == deliveryOrigin && it.hubId == deliveryHubId && it.scopeKey == key
        }.forEach { recordDelivery(it) }
    }

    private fun applyRecoveryRoom(key: String, snapshot: JsonObject) {
        val roomId = key.substringAfter(':')
        val parsed = parseFlow(snapshot["flow"] as? JsonObject, roomId)
        flowCache[roomId] = parsed
        val index = rooms.indexOfFirst { it.roomId == roomId }
        if (index >= 0) {
            rooms[index] = rooms[index].copy(
                mode = (snapshot["mode"] as? JsonPrimitive)?.contentOrNull ?: rooms[index].mode,
                subMode = (snapshot["subMode"] as? JsonPrimitive)?.contentOrNull,
                activeSpeaker = (snapshot["activeSpeaker"] as? JsonPrimitive)?.contentOrNull,
            )
        }
        if (currentRoom?.roomId == roomId) {
            if (index >= 0) currentRoom = rooms[index]
            flow = parsed
            ensureFlowCard(parsed)
            (snapshot["blackboard"] as? JsonArray)?.let { list ->
                blackboard.clear()
                blackboard.addAll(list.map { parseBlackboardEntry(it.jsonObject) })
            }
        }
    }

    private suspend fun recoverScope(key: String): JsonObject? {
        val generation = missionConnectionGeneration
        val epoch = profileEpoch
        val visible = scopeItems(key) + if (anchorScopeKey == key && scopeKey() == key) chatItems else emptyList()
        deliveryRecovery.retainDrafts(key, visible.mapNotNull { historyIdOf(it) }.toSet())
        return deliveryRecovery.recover(key, deliveryProtocol) { currentConnection(epoch, generation) }
    }

    private suspend fun recoveryRpc(method: String, params: JsonObject): JsonObject {
        val generation = missionConnectionGeneration
        val epoch = profileEpoch
        val result = hub.call(method, params)
        if (currentConnection(epoch, generation) && method in setOf("room.history", "session.history") &&
            params["afterId"] == null && params["before"] == null && params["anchorAt"] == null) {
            val kind = method.substringBefore('.')
            val id = (params[if (kind == "room") "roomId" else "sessionId"] as? JsonPrimitive)?.contentOrNull
            val key = "$kind:$id"
            val more = (result["hasMore"] as? JsonPrimitive)?.booleanOrNull == true
            historyMoreCache[key] = more
            if (scopeKey() == key && anchorScopeKey != key) historyHasMore = more
        }
        return result
    }

    private fun deliveryFlowState(f: FlowInfo?, subMode: String?): String = when {
        subMode == "deciding" -> "deciding"
        f == null -> "none"
        f.phase in setOf("done", "cancelled") -> "terminal"
        f.phase == "awaiting-retry" || (f.mode in setOf("parallel", "debate") && f.phase == "summarizing") -> "restart"
        else -> "active"
    }

    private suspend fun validateDelivery(record: DeliveryRecord): String? {
        if (!deliveryReady || !hub.isConnected) return "busy"
        val generation = missionConnectionGeneration
        val epoch = profileEpoch
        val origin = deliveryOrigin
        val hubId = deliveryHubId
        fun valid() = currentConnection(epoch, generation) && origin == deliveryOrigin && hubId == deliveryHubId
        if (record.origin != origin || record.hubId != hubId) return "context"
        val target = record.scopeKey.substringAfter(':')
        if (record.method == "room.message") {
            val room = rooms.find { it.roomId == target } ?: return "context"
            val snapshot = recoverScope(record.scopeKey) ?: return "context"
            if (!valid()) throw CancellationException("delivery_stale")
            val expectedState = (record.params["expectedFlowState"] as? JsonPrimitive)?.contentOrNull ?: return "context"
            val expectedMode = (record.params["expectedRoomMode"] as? JsonPrimitive)?.contentOrNull ?: return "context"
            val mode = (snapshot["mode"] as? JsonPrimitive)?.contentOrNull ?: return "unsupported"
            val f = parseFlow(snapshot["flow"] as? JsonObject, target)
            val state = deliveryFlowState(f, (snapshot["subMode"] as? JsonPrimitive)?.contentOrNull)
            if (f?.flowId?.takeIf { it.isNotBlank() } != (record.params["expectedFlowId"] as? JsonPrimitive)?.contentOrNull ||
                f?.missionId != (record.params["expectedMissionId"] as? JsonPrimitive)?.contentOrNull || mode != expectedMode) return "context"
            if (record.waitUntilIdle && expectedState == "terminal" && state == "active") return "busy"
            if (state != expectedState || (record.deferred && state in setOf("restart", "deciding"))) return "context"
            val reply = (record.params["replyTo"] as? JsonPrimitive)?.contentOrNull
            if (reply != null && (state == "terminal" || f == null ||
                    (f.clarificationId != reply && f.tasks.none { it.waitingFor == "user" && it.waitingHelpId == reply }))) return "context"
            if (record.waitUntilIdle && state == "none") {
                val list = hub.call("session.list")["sessions"] as? JsonArray ?: return "sync"
                if (!valid()) throw CancellationException("delivery_stale")
                val memberIds = room.members.map { it.first }.toSet()
                if (list.any {
                        val o = it.jsonObject
                        (o["sessionId"] as? JsonPrimitive)?.contentOrNull in memberIds &&
                            (o["busy"] as? JsonPrimitive)?.booleanOrNull == true
                    }) return "busy"
            }
        } else {
            recoverScope(record.scopeKey)
            val list = hub.call("session.list")["sessions"] as? JsonArray ?: return "sync"
            if (!valid()) throw CancellationException("delivery_stale")
            val session = list.map { it.jsonObject }.find {
                (it["sessionId"] as? JsonPrimitive)?.contentOrNull == target
            } ?: return "context"
            if ((session["offline"] as? JsonPrimitive)?.booleanOrNull == true) return "context"
            if ((session["busy"] as? JsonPrimitive)?.booleanOrNull == true) return "busy"
        }
        return if (deliveryReady) null else "busy"
    }

    private suspend fun deliveryRpc(method: String, params: JsonObject): JsonObject {
        val sid = (params["sessionId"] as? JsonPrimitive)?.contentOrNull
        if (method == "prompt.send" && sid != null && !busyIds.contains(sid)) busyIds.add(sid)
        return try { hub.call(method, params) }
        catch (e: Exception) {
            if (e is CancellationException) throw e
            if (hub.isConnected) refreshBusy()
            throw e
        }
    }

    private fun saveCurrentScope() {
        val key = scopeKey() ?: return
        flushStreamChunks()
        saveComposition()
        if (anchorScopeKey != key) chatCache[key] = chatItems.toList()
        panelsCache[key] = ScopePanels(
            currentArtifacts.toList(),
            currentEvents.toList(),
            blackboard.toList(),
        )
        scopeSeen.getOrPut(key) { ScopeSeen() }.counts =
            Triple(newArtifactCount, newEventCount, newBlackboardCount)
        chatCacheKeys.remove(key)
        chatCacheKeys.addFirst(key)
        trimChatCache()
    }

    private fun restoreScopeCounts() {
        restoreComposition()
        ++artifactRefreshGeneration
        ++usageRefreshGeneration
        val key = scopeKey()
        val panels = key?.let { panelsCache[it] }
        if (panels != null) {
            currentArtifacts.clear()
            currentArtifacts.addAll(panels.artifacts)
            currentEvents.clear()
            currentEvents.addAll(panels.events)
            blackboard.clear()
            blackboard.addAll(panels.board)
        }
        val counts = key?.let { scopeSeen[it]?.counts }
        newArtifactCount = counts?.first ?: 0
        newEventCount = counts?.second ?: 0
        newBlackboardCount = counts?.third ?: 0
    }

    private fun trackNewArtifacts(
        artifacts: List<ArtifactInfo>,
        events: List<EventInfo>,
        board: List<BlackboardEntry>?,
    ) {
        val key = scopeKey() ?: return
        val seen = scopeSeen.getOrPut(key) { ScopeSeen() }
        seen.artifacts?.let { old ->
            newArtifactCount = artifacts.count { it.id !in old }
        } ?: run { seen.artifacts = artifacts.map { it.id }.toSet() }
        seen.events?.let { old ->
            newEventCount = events.count { it.id !in old }
        } ?: run { seen.events = events.map { it.id }.toSet() }
        if (board != null) {
            seen.board?.let { old ->
                newBlackboardCount = board.count { it.id !in old }
            } ?: run { seen.board = board.map { it.id }.toSet() }
        }
    }

    fun clearNewCounts(kind: String) {
        val key = scopeKey() ?: return
        val seen = scopeSeen.getOrPut(key) { ScopeSeen() }
        when (kind) {
            "artifact" -> {
                newArtifactCount = 0
                seen.artifacts = currentArtifacts.map { it.id }.toSet()
            }
            "event" -> {
                newEventCount = 0
                seen.events = currentEvents.map { it.id }.toSet()
            }
            "blackboard" -> {
                newBlackboardCount = 0
                seen.board = blackboard.map { it.id }.toSet()
            }
        }
        seen.counts = Triple(newArtifactCount, newEventCount, newBlackboardCount)
    }

    private fun parseBlackboardEntry(obj: JsonObject): BlackboardEntry {
        return BlackboardEntry(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            from = obj["from"]?.jsonPrimitive?.content ?: "",
            text = obj["text"]?.jsonPrimitive?.content ?: "",
            detail = obj["detail"]?.jsonPrimitive?.content ?: "",
            at = obj["at"]?.jsonPrimitive?.longOrNull ?: 0,
            type = obj["type"]?.jsonPrimitive?.contentOrNull ?: "note",
            status = obj["status"]?.jsonPrimitive?.contentOrNull ?: "open",
        )
    }

    fun resolveTopic(id: String) {
        val roomId = currentRoom?.roomId ?: return
        viewModelScope.launch {
            runCatching {
                hub.call("room.topic.resolve", buildJsonObject {
                    put("roomId", roomId); put("id", id)
                })
            }
        }
    }

    private fun parseArtifactInfo(obj: JsonObject): ArtifactInfo {
        return ArtifactInfo(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            alias = obj["alias"]?.jsonPrimitive?.content,
            author = obj["author"]?.jsonPrimitive?.content ?: "",
            at = obj["at"]?.jsonPrimitive?.longOrNull ?: 0,
            summary = obj["summary"]?.jsonPrimitive?.content ?: "",
            path = obj["path"]?.jsonPrimitive?.content,
            taskId = obj["taskId"]?.jsonPrimitive?.content,
        )
    }

    private fun parseEventInfo(obj: JsonObject): EventInfo {
        val action = obj["action"]?.jsonPrimitive?.content ?: "command"
        return EventInfo(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            author = obj["author"]?.jsonPrimitive?.content ?: "",
            at = obj["at"]?.jsonPrimitive?.longOrNull ?: 0,
            action = if (action in setOf("add", "modify", "delete", "rename", "command", "test")) action else "command",
            summary = obj["summary"]?.jsonPrimitive?.content ?: "",
            path = obj["path"]?.jsonPrimitive?.content,
            oldPath = obj["oldPath"]?.jsonPrimitive?.content,
            taskId = obj["taskId"]?.jsonPrimitive?.content,
        )
    }

    /** roomIdFallback：房史 kind:"flow" 快照不含 roomId，由所在房间上下文补上 */
    private fun parseFlow(obj: JsonObject?, roomIdFallback: String = ""): FlowInfo? {
        if (obj == null) return null
        val roomId = obj["roomId"]?.jsonPrimitive?.contentOrNull ?: roomIdFallback
        if (roomId.isEmpty()) return null
        val phase = obj["phase"]?.jsonPrimitive?.content ?: return null
        val progress = obj["progress"]?.jsonObject
        val tasks = obj["tasks"]?.jsonArray
        return FlowInfo(
            roomId = roomId,
            phase = phase,
            flowId = obj["flowId"]?.jsonPrimitive?.contentOrNull ?: "",
            startedAt = obj["startedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
            finishedAt = obj["finishedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
            mode = obj["mode"]?.jsonPrimitive?.contentOrNull ?: "",
            progress = FlowProgress(
                done = progress?.get("done")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                running = progress?.get("running")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                pending = progress?.get("pending")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                failed = progress?.get("failed")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                total = progress?.get("total")?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
            ),
            tasks = tasks?.map { parseFlowTask(it.jsonObject) } ?: emptyList(),
            goal = obj["goal"]?.jsonPrimitive?.contentOrNull,
            acceptanceCriteria = obj["acceptanceCriteria"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            iteration = obj["iteration"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            maxIterations = obj["maxIterations"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            supplements = obj["supplements"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            clarificationId = obj["clarificationId"]?.jsonPrimitive?.contentOrNull,
            clarificationQuestions = obj["clarificationQuestions"]?.jsonArray
                ?.map { it.jsonPrimitive.content } ?: emptyList(),
            missionId = obj["missionId"]?.jsonPrimitive?.contentOrNull,
            failureMessage = obj["failureMessage"]?.jsonPrimitive?.contentOrNull,
        )
    }

    private fun parseFlowTask(obj: JsonObject): FlowTask {
        val artifacts = obj["artifacts"]?.jsonArray?.map { parseFlowArtifact(it.jsonObject) } ?: emptyList()
        // 空白归一（数据层根治"任务间偶发大空白"）：task 是单行描述，全渲染路径折叠；
        // 正文类字段保留换行但压缩连续空行——空行栈在展开态曾渲染成大段空白
        val collapseBlank = { s: String? ->
            // [ \t\r] 含 \r：CRLF 输出的空行栈（\r\n\r\n+）同样压缩
            s?.replace(Regex("\n[ \t\r]*\n([ \t\r]*\n)+"), "\n\n")?.trim()
        }
        return FlowTask(
            id = obj["id"]?.jsonPrimitive?.content ?: "",
            sessionId = obj["sessionId"]?.jsonPrimitive?.content ?: "",
            name = obj["name"]?.jsonPrimitive?.content ?: "",
            status = obj["status"]?.jsonPrimitive?.content ?: "pending",
            task = obj["task"]?.jsonPrimitive?.content
                ?.replace(Regex("\\s+"), " ")?.trim() ?: "",
            dependsOn = obj["dependsOn"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            artifacts = artifacts,
            failureMessage = collapseBlank(obj["failureMessage"]?.jsonPrimitive?.contentOrNull),
            output = collapseBlank(obj["output"]?.jsonPrimitive?.contentOrNull),
            retries = obj["retries"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
            waitingFor = obj["waitingFor"]?.jsonPrimitive?.contentOrNull,
            waitingQuestion = collapseBlank(obj["waitingQuestion"]?.jsonPrimitive?.contentOrNull),
            waitingHelpId = obj["waitingHelpId"]?.jsonPrimitive?.contentOrNull,
            verifications = obj["verifications"]?.jsonArray?.map { v ->
                val vo = v.jsonObject
                val detail = vo["evidenceDetail"]?.jsonObject
                FlowVerification(
                    by = vo["by"]?.jsonPrimitive?.content ?: "",
                    verdict = vo["verdict"]?.jsonPrimitive?.content ?: "",
                    evidence = vo["evidence"]?.jsonPrimitive?.content ?: "",
                    evidenceDetail = detail?.let { parseVerificationEvidenceDetail(it) },
                    backendToolCallId = vo["backendToolCallId"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList(),
            backendRuns = obj["backendRuns"]?.jsonArray?.mapNotNull { r ->
                val ro = r.jsonObject
                val id = ro["toolCallId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                BackendToolRun(
                    toolCallId = id,
                    status = ro["status"]?.jsonPrimitive?.contentOrNull ?: "",
                    exitCode = ro["exitCode"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
                    at = ro["at"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
                )
            } ?: emptyList(),
            backendClaimMatch = obj["backendClaimMatch"]?.jsonPrimitive?.contentOrNull == "true",
            backendClaimStatus = obj["backendClaimStatus"]?.jsonPrimitive?.contentOrNull
                ?.takeIf {
                    it == "matched" || it == "missing_member_command" ||
                        it == "missing_member_exit_code" || it == "no_completed_backend_run" ||
                        it == "backend_exit_unknown" || it == "backend_mismatch"
                },
            verificationStatus = obj["verificationStatus"]?.jsonPrimitive?.contentOrNull,
            automaticCheckStatus = (obj["automaticCheck"] as? JsonObject)
                ?.get("status")?.jsonPrimitive?.contentOrNull
                ?.takeIf {
                    it == "not_run" || it == "exited_zero" || it == "exited_nonzero" ||
                        it == "blocked" || it == "timed_out"
                } ?: "not_run",
            automaticCheckExitCode = (obj["automaticCheck"] as? JsonObject)
                ?.get("exitCode")?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            automaticCheckSnapshot = (obj["automaticCheck"] as? JsonObject)
                ?.get("snapshotHash")?.jsonPrimitive?.contentOrNull
                ?.takeIf { it.matches(Regex("[0-9a-f]{64}")) },
            automaticCheckReason = (obj["automaticCheck"] as? JsonObject)
                ?.get("reason")?.jsonPrimitive?.contentOrNull
                ?.takeIf { it.matches(Regex("[a-z_]+")) },
            automaticCheckTruncated = (obj["automaticCheck"] as? JsonObject)
                ?.let {
                    it["stdoutTruncated"]?.jsonPrimitive?.contentOrNull == "true" ||
                        it["stderrTruncated"]?.jsonPrimitive?.contentOrNull == "true"
                } ?: false,
            automaticCheckSnapshotCurrent = (obj["automaticCheck"] as? JsonObject)
                ?.get("snapshotCurrent")?.jsonPrimitive?.booleanOrNull,
            baseline = obj["baseline"]?.jsonPrimitive?.contentOrNull,
            diff = obj["diff"]?.jsonPrimitive?.contentOrNull,
            reproSteps = obj["reproSteps"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            verifyCommand = obj["verifyCommand"]?.jsonPrimitive?.contentOrNull,
            verifyExitCode = obj["verifyExitCode"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            verifyStdout = obj["verifyStdout"]?.jsonPrimitive?.contentOrNull,
            verifyStderr = obj["verifyStderr"]?.jsonPrimitive?.contentOrNull,
            verifyCheckId = obj["verifyCheckId"]?.jsonPrimitive?.contentOrNull
                ?.takeIf { it.matches(Regex("[a-z][a-z0-9_-]{0,63}")) },
            dispatchedAt = obj["dispatchedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
            finishedAt = obj["finishedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
        )
    }

    private fun parseFlowArtifact(obj: JsonObject): FlowArtifact {
        return FlowArtifact(
            type = obj["type"]?.jsonPrimitive?.content ?: "",
            path = obj["path"]?.jsonPrimitive?.content,
            summary = obj["summary"]?.jsonPrimitive?.content ?: "",
        )
    }

    private fun parseVerificationEvidenceDetail(obj: JsonObject): VerificationEvidenceDetail {
        return VerificationEvidenceDetail(
            summary = obj["summary"]?.jsonPrimitive?.content ?: "",
            baseline = obj["baseline"]?.jsonPrimitive?.content ?: "",
            diff = obj["diff"]?.jsonPrimitive?.content ?: "",
            reproSteps = obj["reproSteps"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            command = obj["command"]?.jsonPrimitive?.content ?: "",
            exitCode = obj["exitCode"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
            stdout = obj["stdout"]?.jsonPrimitive?.content ?: "",
            stderr = obj["stderr"]?.jsonPrimitive?.content ?: "",
            artifactRefs = obj["artifactRefs"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
        )
    }

    fun openMission(id: String) {
        roomOpenSeq++
        missionExecutionTarget = null
        if (!missions.any { it.id == id }) {
            missionNavMessage = "unavailable"
            return
        }
        missionNavMessage = null
        missionFocusId = id
        searchQuery = ""
        listTab.value = 1
        screen = Screen.Sessions
    }

    fun openMissionExecution(missionId: String, event: MissionEvent? = null, task: FlowTask? = null) {
        val m = missions.find { it.id == missionId } ?: return run { missionNavMessage = "unavailable" }
        val room = rooms.find { it.roomId == m.roomId } ?: return run { missionNavMessage = "unavailable" }
        val flowId = event?.flowId ?: m.flowId
        val taskId = event?.taskId ?: task?.id
        val dispatchedAt = event?.dispatchedAt ?: task?.dispatchedAt?.takeIf { it > 0 }
        val anchor = if (event != null && event.flowId != null && event.flowId != m.flowId) event.at
            else (m.flow?.get("startedAt")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: m.startedAt ?: event?.at)
        val nonce = System.nanoTime()
        missionNavMessage = null
        openRoom(room, anchor, readOnly = true) {
            missionExecutionTarget = MissionExecutionTarget(
                missionId = missionId,
                roomId = m.roomId,
                flowId = flowId,
                taskId = taskId,
                dispatchedAt = dispatchedAt,
                anchorAt = anchor,
                nonce = nonce,
            )
        }
    }

    fun retryMissionLocation() {
        val t = missionExecutionTarget ?: return
        val room = rooms.find { it.roomId == t.roomId } ?: return run { missionNavMessage = "unavailable" }
        val nonce = System.nanoTime()
        openRoom(room, t.anchorAt, readOnly = true) {
            missionExecutionTarget = t.copy(nonce = nonce)
        }
    }

    fun parseMissionFlow(obj: JsonObject, roomIdFallback: String = ""): FlowInfo? = parseFlow(obj, roomIdFallback)

    data class MissionExecutionTarget(
        val missionId: String,
        val roomId: String,
        val flowId: String? = null,
        val taskId: String? = null,
        val dispatchedAt: Long? = null,
        val anchorAt: Long? = null,
        val nonce: Long = 0,
    )

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
                    connectError = stringsFor(lang).resumeFailed
                }
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun renameSession(session: SessionInfo, name: String) {
        viewModelScope.launch {
            connectError = null
            val trimmed = name.trim().replace("·", "-")
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

    private fun parseHistoryItem(o: JsonObject, itemId: Long, roomId: String? = null): ChatItem? {
        val kind = o["kind"]!!.jsonPrimitive.content
        val author = o["author"]!!.jsonPrimitive.content
        val text = o["text"]!!.jsonPrimitive.content
        val at = o["at"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L
        return when (kind) {
            "user" -> ChatItem.User(itemId, text, at = at,
                clientMessageId = (o["clientMessageId"] as? JsonPrimitive)?.contentOrNull,
                historyId = (o["id"] as? JsonPrimitive)?.longOrNull,
                historyAt = at,
            )
            "assistant" -> if (text == LOST_REPLY_PLACEHOLDER) {
                ChatItem.System(itemId, stringsFor(lang).lostReply, at = at)
            } else {
                ChatItem.Assistant(itemId, text, author, at = at)
            }
            "system" -> ChatItem.System(itemId, text, at = at)
            "thought" -> ChatItem.Thought(itemId, text, author, at = at)
            "tool" -> {
                val data = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                ChatItem.Tool(
                    itemId,
                    data?.get("toolCallId")?.jsonPrimitive?.contentOrNull ?: "",
                    data?.get("title")?.jsonPrimitive?.contentOrNull ?: "tool",
                    data?.get("status")?.jsonPrimitive?.contentOrNull ?: "completed",
                    author,
                    at = at,
                )
            }
            "plan" -> {
                val data = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                val entries = data?.get("entries")?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
                ChatItem.Plan(itemId, entries, author, at = at)
            }
            "error" -> ChatItem.Error(itemId, text, author, at = at)
            "process" -> {
                try {
                    parseProcessMeta(itemId, Json.parseToJsonElement(text).jsonObject, author, at)
                } catch (_: Exception) {
                    null
                }
            }
            "flow" -> {
                try {
                    val snap = parseFlow(Json.parseToJsonElement(text).jsonObject, roomId ?: "")
                        ?: return null
                    if (snap.flowId.isEmpty()) return null
                    ChatItem.Flow(itemId, snap.flowId, snap, author, at)
                } catch (_: Exception) {
                    null
                }
            }
            "decision" -> {
                try {
                    parseDecisionMeta(itemId, Json.parseToJsonElement(text).jsonObject, author, at)
                } catch (_: Exception) {
                    null
                }
            }
            else -> null
        }
    }

    /** memberRoles 值发送形态：形如 {"persona":...} 的字符串还原为 JSON 对象，否则按纯文本发 */
    private fun personaJsonValue(persona: String): JsonElement {
        val el = runCatching { Json.parseToJsonElement(persona) }.getOrNull()
        // 须是对象且 persona 为字符串——JsonNull/数字形态的 {"persona":null} 不应误判为卡
        val p = (el as? JsonObject)?.get("persona")
        return if (p is JsonPrimitive && p.isString) el else JsonPrimitive(persona)
    }

    private fun parseDecisionMeta(itemId: Long, data: JsonObject, author: String, at: Long): ChatItem.Decision? {
        val decisionId = data["decisionId"]?.jsonPrimitive?.contentOrNull ?: return null
        val ctx = data["context"]?.jsonObject
        val contextSummary = buildList {
            ctx?.get("message")?.jsonPrimitive?.contentOrNull?.take(160)?.let { add(it) }
            ctx?.get("command")?.jsonPrimitive?.contentOrNull?.take(120)?.let { add(it) }
            ctx?.get("path")?.jsonPrimitive?.contentOrNull?.take(120)?.let { add(it) }
            val paths = ctx?.get("paths")?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }?.take(3)
            if (!paths.isNullOrEmpty()) add(paths.joinToString(" · "))
            if (ctx?.get("redacted")?.jsonPrimitive?.contentOrNull == "true") add("[redacted]")
        }.joinToString("\n").ifBlank { null }
        return ChatItem.Decision(
            itemId,
            decisionId,
            data["requestId"]?.jsonPrimitive?.contentOrNull ?: "",
            data["type"]?.jsonPrimitive?.contentOrNull ?: "permission",
            data["title"]?.jsonPrimitive?.contentOrNull ?: "",
            data["options"]?.jsonArray?.mapNotNull {
                val o = it.jsonObject
                val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                id to (o["label"]?.jsonPrimitive?.contentOrNull ?: id)
            } ?: emptyList(),
            data["status"]?.jsonPrimitive?.contentOrNull ?: "pending",
            data["scope"]?.jsonPrimitive?.contentOrNull ?: "once",
            data["answer"]?.jsonObject?.get("label")?.jsonPrimitive?.contentOrNull
                ?: data["answer"]?.jsonObject?.get("action")?.jsonPrimitive?.contentOrNull,
            data["auto"]?.jsonPrimitive?.contentOrNull?.toBoolean() ?: false,
            contextSummary,
            author,
            at,
        )
    }

    /** 决策卡 upsert：同 decisionId/条目 id 原位替换；permission 卡替代旧 Permission 条目 */
    private fun upsertDecision(item: ChatItem.Decision) {
        if (item.decisionType == "elicitation") {
            val idx = chatItems.indexOfLast { it is ChatItem.Elicitation && it.requestId == item.requestId && it.answered == null }
            if (idx >= 0) {
                if (item.status != "pending") {
                    val e = chatItems[idx] as ChatItem.Elicitation
                    chatItems[idx] = e.copy(answered = item.answerLabel ?: item.status)
                }
                return
            }
        }
        chatItems.removeAll { it is ChatItem.Permission && it.requestId == item.requestId }
        val idx = chatItems.indexOfLast {
            (it is ChatItem.Decision && it.decisionId == item.decisionId) || it.id == item.id
        }
        if (idx >= 0) chatItems[idx] = item else chatItems.add(item)
    }

    private fun upsertDecisionEntry(entry: JsonObject) {
        val eid = entry["id"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
        val author = entry["author"]?.jsonPrimitive?.contentOrNull ?: ""
        val at = entry["at"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        val meta = try {
            Json.parseToJsonElement(entry["text"]?.jsonPrimitive?.content ?: "").jsonObject
        } catch (_: Exception) {
            null
        } ?: return
        val item = parseDecisionMeta(if (eid != null) -eid else ++itemSeq, meta, author, at) ?: return
        upsertDecision(item)
    }

    private fun parseProcessMeta(itemId: Long, data: JsonObject, author: String, at: Long): ChatItem.Process =
        ChatItem.Process(
            itemId,
            processId = data["processId"]?.jsonPrimitive?.contentOrNull ?: "",
            sessionId = data["sessionId"]?.jsonPrimitive?.contentOrNull ?: "",
            taskId = data["taskId"]?.jsonPrimitive?.contentOrNull,
            status = data["status"]?.jsonPrimitive?.contentOrNull ?: "",
            steps = (data["steps"] as? JsonArray)?.mapNotNull { s ->
                val o = s as? JsonObject ?: return@mapNotNull null
                ChatItem.ProcessStep(
                    kind = o["kind"]?.jsonPrimitive?.contentOrNull ?: "",
                    title = o["title"]?.jsonPrimitive?.contentOrNull,
                    text = o["text"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList(),
            turnStartAt = data["turnStartAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            turnEndAt = data["turnEndAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            cardType = data["type"]?.jsonPrimitive?.contentOrNull
                ?: data["card"]?.jsonPrimitive?.contentOrNull ?: "",
            dispatchTasks = (data["tasks"] as? JsonArray)?.mapNotNull { t ->
                val o = t as? JsonObject ?: return@mapNotNull null
                ChatItem.DispatchTask(
                    id = o["id"]?.jsonPrimitive?.contentOrNull,
                    to = o["to"]?.jsonPrimitive?.contentOrNull,
                    task = o["task"]?.jsonPrimitive?.contentOrNull,
                )
            } ?: emptyList(),
            dispatchCount = data["count"]?.jsonPrimitive?.intOrNull ?: 0,
            flowId = data["flowId"]?.jsonPrimitive?.contentOrNull ?: "",
            author = author,
            at = at,
        )

    private fun dedupeTail(hist: List<ChatItem>, tail: List<ChatItem>): List<ChatItem> {
        fun sameWindow(h: ChatItem, t: ChatItem): Boolean =
            h.at == 0L || t.at == 0L || kotlin.math.abs(h.at - t.at) <= 300_000L
        // 持久化 author 为 "名字 (来源)"，live 项用房内成员名，两者视为同一作者
        fun sameAuthor(h: ChatItem, t: ChatItem): Boolean =
            h.author == t.author || h.author.startsWith("${t.author} (") || t.author.startsWith("${h.author} (")
        // 时间门控：仅 live 副本不晚于持久化版本（残副本场景）才按指纹吞并，
        // 更晚到达的同文本/同前缀回复视为新回合保留
        fun earlierLive(h: ChatItem, t: ChatItem): Boolean =
            h.at <= 0L || t.at <= 0L || t.at <= h.at
        return tail.filter { t ->
            when (t) {
                is ChatItem.User ->
                    hist.none { it is ChatItem.User && if (it.clientMessageId != null || t.clientMessageId != null) {
                        it.clientMessageId != null && it.clientMessageId == t.clientMessageId
                    } else sameWindow(it, t) && sameAuthor(it, t) && (it.text == t.text || it.text.endsWith(t.text)) }
                is ChatItem.System ->
                    hist.none { it is ChatItem.System && sameWindow(it, t) && it.text == t.text }
                is ChatItem.Assistant ->
                    // 指纹级匹配不限 300s 窗口但带时间门控：同作者 + live 不晚于持久化 +
                    // 全文相等或互为前缀（含持久化截断为前缀）
                    hist.none { it is ChatItem.Assistant && sameAuthor(it, t) && earlierLive(it, t) && (it.text == t.text || it.text.startsWith(t.text) || t.text.startsWith(it.text)) }
                is ChatItem.Thought ->
                    hist.none { it is ChatItem.Thought && sameAuthor(it, t) && earlierLive(it, t) && (it.text == t.text || it.text.startsWith(t.text) || t.text.startsWith(it.text)) }
                is ChatItem.Tool ->
                    hist.none { it is ChatItem.Tool && t.toolCallId.isNotEmpty() && it.toolCallId == t.toolCallId }
                is ChatItem.Plan ->
                    hist.none { it is ChatItem.Plan && sameAuthor(it, t) && it.entries == t.entries }
                is ChatItem.Error ->
                    hist.none { it is ChatItem.Error && sameWindow(it, t) && sameAuthor(it, t) && it.text == t.text }
                is ChatItem.Process ->
                    hist.none { it is ChatItem.Process && t.processId.isNotEmpty() && it.processId == t.processId }
                is ChatItem.Flow ->
                    hist.none { it is ChatItem.Flow && (it.id == t.id || (t.flowId.isNotEmpty() && it.flowId == t.flowId)) }
                else -> true
            }
        }
    }

    private fun loadHistory(method: String, idKey: String, id: String, anchorAt: Long? = null): Job {
        val key = if (method == "room.history") "room:$id" else "session:$id"
        if (anchorAt == null) {
            exitHistoryAnchor()
            historyHasMore = historyMoreCache[key] ?: false
        }
        val scopeAtStart = scopeKey()
        val seqAtStart = roomOpenSeq
        val genAtStart = missionConnectionGeneration
        return viewModelScope.launch {
            try {
                if (anchorAt == null) {
                    recoverScope(key)
                    return@launch
                }
                val params = buildJsonObject {
                    put(idKey, id)
                    put("anchorAt", anchorAt)
                    put("ifcAuthorized", true)
                }
                val result = hub.call(method, params)
                if (scopeKey() != scopeAtStart || roomOpenSeq != seqAtStart || missionConnectionGeneration != genAtStart) return@launch
                val entries = result["entries"]?.jsonArray ?: return@launch
                historyHasMore = result["hasMore"]?.jsonPrimitive?.content?.toBoolean() ?: false
                val rows = entries.map { it.jsonObject }
                if (anchorScopeKey != key) chatCache[key] = chatItems.toList()
                anchorScopeKey = key
                val items = rows.mapNotNull { row ->
                    val hid = row["id"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                    parseHistoryItem(row, -hid, if (method == "room.history") id else null)
                }
                chatItems.clear()
                chatItems.addAll(items)
                deliveryRecovery.remember(key, rows)
                recoverScope(key)
                syncBusyIds()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (missionConnectionGeneration == genAtStart) deliveryError = "sync"
            }
        }
    }

    fun loadMoreHistory() {
        if (historyLoading || !historyHasMore) return
        val oldest = chatItems.filter { historyIdOf(it) != null && (it !is ChatItem.User || it.historyAt != null) }
            .minWithOrNull(compareBy<ChatItem> { (it as? ChatItem.User)?.historyAt ?: it.at }.thenBy { historyIdOf(it) }) ?: return
        val oldestAt = (oldest as? ChatItem.User)?.historyAt ?: oldest.at
        if (oldestAt == 0L) return
        historyLoading = true
        val scopeAtStart = scopeKey()
        val seqAtStart = roomOpenSeq
        val genAtStart = missionConnectionGeneration
        viewModelScope.launch {
            try {
                val (method, idKey, id) = when {
                    currentRoom != null -> Triple("room.history", "roomId", currentRoom!!.roomId)
                    currentSession != null -> Triple("session.history", "sessionId", currentSession!!.sessionId)
                    else -> return@launch
                }
                val result = hub.call(method, buildJsonObject {
                    put(idKey, id)
                    put("before", JsonPrimitive(oldestAt))
                    put("beforeId", JsonPrimitive(historyIdOf(oldest)!!))
                    put("limit", 50)
                })
                if (scopeKey() != scopeAtStart || roomOpenSeq != seqAtStart || missionConnectionGeneration != genAtStart) return@launch
                val entries = result["entries"]?.jsonArray ?: return@launch
                historyHasMore = result["hasMore"]?.jsonPrimitive?.content?.toBoolean() ?: false
                val key = scopeAtStart ?: return@launch
                val rows = entries.map { it.jsonObject }
                if (anchorScopeKey == key) {
                    val items = rows.mapNotNull { row ->
                        val hid = row["id"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                        parseHistoryItem(row, -hid, if (method == "room.history") id else null)
                    }
                    chatItems.addAll(0, items.filter { item -> chatItems.none { sameHistoryItem(it, item) } })
                } else {
                    historyMoreCache[key] = historyHasMore
                    applyRecoveredRows(key, rows, false, false)
                }
                deliveryRecovery.remember(key, rows)
                recoverScope(key)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
            } finally {
                if (scopeKey() == scopeAtStart && roomOpenSeq == seqAtStart && missionConnectionGeneration == genAtStart) {
                    historyLoading = false
                }
            }
        }
    }

    // 过程卡/任务钻取的懒加载缓存：key 为 processId、"card:<itemId>" 或
    // "task:<roomId>:<flowId>:<taskId>:<dispatchedAt>"（执行批次隔离，防跨 flow/重试串数据）
    val processItems = mutableStateMapOf<String, List<ChatItem>>()
    val processLoading = mutableStateMapOf<String, Boolean>()
    // 致命失败（会话不存在等）：停止重试并提示不可用；瞬时失败存 processErrors，不阻塞重试
    val processUnavailable = mutableStateMapOf<String, Boolean>()
    val processErrors = mutableStateMapOf<String, String>()
    /** 同 key 请求的代数：过期响应不得覆盖新结果 */
    private val processFetchSeq = mutableMapOf<String, Long>()
    private val processFetchFingerprints = mutableMapOf<String, String>()
    private val processFetchJobs = mutableMapOf<String, Job>()

    /** 过程钻取元数据上限：LinkedHashMap 插入序淘汰最旧（jobs 先取消防泄漏） */
    private fun pruneProcessFetchMaps(cap: Int = 200) {
        for (m in listOf(processFetchJobs, processFetchSeq, processFetchFingerprints)) {
            while (m.size > cap) {
                val oldest = m.entries.first().key
                processFetchJobs.remove(oldest)?.cancel()
                processFetchSeq.remove(oldest)
                processFetchFingerprints.remove(oldest)
            }
        }
    }

    fun processKey(item: ChatItem.Process): String =
        item.processId.ifEmpty { "card:${item.id}" }

    fun loadProcessCard(item: ChatItem.Process) {
        if (item.cardType == "dispatch" || item.dispatchTasks.isNotEmpty()) return
        val key = processKey(item)
        if (item.sessionId.isEmpty()) {
            processUnavailable[key] = true
            return
        }
        if (processLoading[key] == true) return
        processLoading[key] = true
        processUnavailable.remove(key)
        processErrors.remove(key)
        viewModelScope.launch {
            try {
                val running = item.turnEndAt <= 0L || item.status == "running"
                processItems[key] = fetchProcessItems(item.sessionId, item.turnStartAt, item.turnEndAt, running)
            } catch (e: Exception) {
                processErrors[key] = e.message ?: "error"
            } finally {
                processLoading[key] = false
            }
        }
    }

    fun loadTaskProcess(roomId: String, task: FlowTask, flowId: String = "") {
        val key = "task:$roomId:$flowId:${task.id}:${task.dispatchedAt}"
        if (task.sessionId.isEmpty()) {
            processUnavailable[key] = true
            return
        }
        val fingerprint = "${task.status}:${task.finishedAt}"
        if (processLoading[key] == true && processFetchFingerprints[key] == fingerprint) return
        val seq = (processFetchSeq[key] ?: 0) + 1
        processFetchSeq[key] = seq
        val identityChanged = processFetchFingerprints[key] != fingerprint
        processFetchFingerprints[key] = fingerprint
        if (identityChanged) processItems.remove(key)
        processFetchJobs[key]?.cancel()
        pruneProcessFetchMaps()
        processLoading[key] = true
        processUnavailable.remove(key)
        processErrors.remove(key)
        processFetchJobs[key] = viewModelScope.launch {
            try {
                val items = if (task.status == "pending") {
                    emptyList()
                } else if (task.status == "running") {
                    if (flow?.flowId == flowId && task.dispatchedAt > 0L) {
                        fetchProcessItems(task.sessionId, task.dispatchedAt, 0L, running = true)
                    } else {
                        if (processFetchSeq[key] == seq) processUnavailable[key] = true
                        emptyList()
                    }
                } else if (task.dispatchedAt > 0L && task.finishedAt >= task.dispatchedAt) {
                    fetchProcessItems(task.sessionId, task.dispatchedAt, task.finishedAt, running = false)
                } else {
                    val card = if (flowId.isNotEmpty()) {
                        chatItems.filterIsInstance<ChatItem.Process>().lastOrNull {
                            it.flowId == flowId && it.taskId == task.id &&
                                it.sessionId == task.sessionId &&
                                it.turnStartAt > 0L && it.turnEndAt >= it.turnStartAt &&
                                (task.dispatchedAt <= 0L || it.turnStartAt >= task.dispatchedAt) &&
                                (task.finishedAt <= 0L || it.turnEndAt <= task.finishedAt)
                        }
                    } else null
                    if (card == null) {
                        if (processFetchSeq[key] == seq) processUnavailable[key] = true
                        emptyList()
                    } else {
                        fetchProcessItems(card.sessionId, card.turnStartAt, card.turnEndAt, running = false)
                    }
                }
                if (processFetchSeq[key] == seq) processItems[key] = items
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (processFetchSeq[key] == seq) processErrors[key] = e.message ?: "error"
            } finally {
                if (processFetchSeq[key] == seq) processLoading.remove(key)
            }
        }
    }

    /** running 时走 session.process 读内存缓冲；否则按 [startAt..endAt] 窗口取 session.history。 */
    private suspend fun fetchProcessItems(sessionId: String, startAt: Long, endAt: Long, running: Boolean): List<ChatItem> {
        if (sessionId.isEmpty()) throw IllegalStateException("no session")
        val result = if (running) {
            hub.call("session.process", buildJsonObject { put("sessionId", sessionId) })
        } else {
            try {
                hub.call("session.history", buildJsonObject {
                    put("sessionId", sessionId)
                    if (startAt > 0) put("after", JsonPrimitive(startAt - 1))
                    put("limit", JsonPrimitive(500))
                })
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                hub.call("session.history", buildJsonObject {
                    put("sessionId", sessionId)
                    put("limit", JsonPrimitive(200))
                })
            }
        }
        val arr = result["items"]?.jsonArray
            ?: result["entries"]?.jsonArray
            ?: result["process"]?.jsonArray
            ?: JsonArray(emptyList())
        val out = mutableListOf<ChatItem>()
        for (e in arr) {
            try {
                parseHistoryItem(e.jsonObject, ++itemSeq)?.let { out.add(it) }
            } catch (_: Exception) {
            }
        }
        return out
            .filter { it is ChatItem.Thought || it is ChatItem.Tool || it is ChatItem.Plan }
            .filter {
                if (it.at <= 0L) return@filter true
                if (startAt > 0L && it.at < startAt) return@filter false
                if (!running && endAt > 0L && it.at > endAt) return@filter false
                true
            }
            .sortedBy { it.at }
    }

    private fun syncBusyIdsFromList(list: List<SessionInfo>) {
        val currentIds = currentRoom?.members?.map { it.first }?.toSet()
            ?: setOfNotNull(currentSession?.sessionId)
        if (currentIds.isEmpty()) return
        val busy = list.filter { it.busy && it.stoppable && currentIds.contains(it.sessionId) }
            .map { it.sessionId }
            .toSet()
        busyIds.removeAll { !busy.contains(it) && currentIds.contains(it) }
        streamingTail?.let { if (!busyIds.contains(it.first)) streamingTail = null }
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
                        backendType = o["backendType"]?.jsonPrimitive?.content,
                    )
                )
                parseReportedQuota(o["quota"])?.let { memberQuotas[o["sessionId"]!!.jsonPrimitive.content] = it }
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
    var historyHasMore by mutableStateOf(false)
    var historyLoading by mutableStateOf(false)
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

    fun sessionSearchMatches(q: String): List<SessionInfo> {
        val query = q.trim().lowercase()
        if (query.isEmpty()) return emptyList()
        return sessions.filter { s ->
            val hay = "${s.name} ${s.agent} ${s.cwd} ${sessionOrigin(s)}".lowercase()
            hay.contains(query)
        }.sortedWith(
            compareByDescending<SessionInfo> { !it.archived }
                .thenByDescending { pinnedAt[it.sessionId] != null }
                .thenByDescending { pinnedAt[it.sessionId] ?: 0L }
                .thenBy { it.name.lowercase() }
        ).take(5)
    }

    fun roomSearchMatches(q: String): List<RoomInfo> {
        val query = q.trim().lowercase()
        if (query.isEmpty()) return emptyList()
        return rooms.filter { r ->
            if (r.archived) return@filter false
            val members = r.members.joinToString(" ") { it.second }.lowercase()
            val hay = "${r.name} ${r.mode} $members".lowercase()
            hay.contains(query)
        }.sortedWith(
            compareByDescending<RoomInfo> { pinnedRoomAt[it.roomId] != null }
                .thenByDescending { pinnedRoomAt[it.roomId] ?: 0L }
                .thenBy { it.name.lowercase() }
        ).take(5)
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
                dropScopeCache("session", session.sessionId)
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
                sessionIds.forEach { dropScopeCache("session", it) }
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
                roomIds.forEach { dropScopeCache("room", it) }
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
                sessionIds.forEach { dropScopeCache("session", it) }
                roomIds.forEach { dropScopeCache("room", it) }
                refreshAll()
            } catch (e: Exception) {
                connectError = e.message
            }
        }
    }

    fun backToList() {
        // 返回列表时只切屏，不清空 currentRoom/currentSession/flow/artifacts 等状态，
        // 这样 re-enter 同一会话/群聊时还能继续看到运行中状态，避免被误判为“结束”
        listTab.value = if (currentRoom != null) 1 else if (currentSession != null) 0 else listTab.value
        fileRefToInsert = null
        jumpToHistoryId = null
        chatSearchMatchIndex = -1
        chatSearchMatchCount = 0
        roomOpenSeq++
        missionExecutionTarget = null
        refreshAll()
        screen = Screen.Sessions
    }

    fun draftFor(scope: String) = drafts[scope] ?: ""

    fun setDraft(scope: String, text: String) {
        if (text.isBlank()) drafts.remove(scope) else drafts[scope] = text
    }

    var showDeliveryManager by mutableStateOf(false)

    fun queuedCount(scope: String) = if (scope == composerKey()) deliveryRecords.count {
        it.origin == deliveryOrigin && it.hubId == deliveryHubId && it.scopeKey == scopeKey() && it.status != "sent"
    } else 0

    fun clearQueue(scope: String) { if (scope == composerKey()) showDeliveryManager = true }

    fun enqueueMessage(scope: String, text: String, onAccepted: (() -> Unit)? = null) {
        if (scope != composerKey()) return
        if (currentRoom != null) sendRoomMessage(text, quote, pendingAttachments.toList(), true, helpReplyTo, onAccepted = onAccepted)
        else sendPrompt(text, quote, pendingAttachments.toList(), true, onAccepted = onAccepted)
    }

    fun flushQueue(scope: String) { if (scope == composerKey() && deliveryReady) delivery.resume() }

    fun preparingDelivery() = composerKey() in preparingScopes

    internal fun currentDelivery(record: DeliveryRecord) = record.origin == deliveryOrigin && record.hubId == deliveryHubId

    fun checkDelivery(id: String) { viewModelScope.launch { delivery.check(id) } }

    fun dismissDeliveries(ids: Set<String>, includeParked: Boolean = false) {
        viewModelScope.launch { delivery.dismissMany(ids, includeParked) }
    }

    private fun newClientMessageId() = "cm-${java.util.UUID.randomUUID()}"

    private fun consumeComposition(
        key: String, draft: String?, attachments: List<Attachment>, q: Pair<String, String>?, reply: String?,
    ) {
        val unchanged = drafts[key] == draft
        if (unchanged) drafts.remove(key)
        if (unchanged && attachmentDrafts[key] == attachments) attachmentDrafts.remove(key)
        if (unchanged && quoteDrafts[key] == q) quoteDrafts.remove(key)
        if (unchanged && replyDrafts[key] == reply) replyDrafts.remove(key)
        if (composerKey() == key && unchanged) {
            if (pendingAttachments.toList() == attachments) pendingAttachments.clear()
            if (quote == q) quote = null
            if (helpReplyTo == reply) helpReplyTo = null
        }
    }

    private suspend fun prepareMessageContent(text: String, attachments: List<Attachment>, S: Strings): JsonArray =
        withContext(Dispatchers.IO) {
            require(attachments.size <= 5)
            var total = 0L
            buildJsonArray {
                if (text.isNotBlank()) add(buildJsonObject { put("type", "text"); put("text", text) })
                attachments.forEach { a ->
                    val encoded = if (a.base64.isNotEmpty()) a.base64 else File(a.localPath ?: error("attachment_missing")).readText()
                    val bytes = Base64.decode(encoded, Base64.DEFAULT)
                    require(bytes.size <= 10 * 1024 * 1024)
                    total += bytes.size
                    require(total <= 20L * 1024 * 1024)
                    val decoded = if (attachTextLike(a.mimeType, a.name)) runCatching {
                        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString().takeIf { '\u0000' !in it }
                    }.getOrNull() else null
                    when {
                        a.mimeType.startsWith("image/") -> add(buildJsonObject {
                            put("type", "image"); put("mimeType", a.mimeType); put("data", encoded)
                        })
                        decoded != null -> add(buildJsonObject {
                            put("type", "text"); put("text", S.deliveryAttachmentFmt.format(a.name, decoded))
                        })
                        else -> add(buildJsonObject {
                            put("type", "resource")
                            put("resource", buildJsonObject { put("mimeType", a.mimeType); put("uri", a.name); put("blob", encoded) })
                        })
                    }
                }
            }
        }

    private fun submitDelivery(
        text: String, room: RoomInfo?, session: SessionInfo?, q: Pair<String, String>?,
        attachments: List<Attachment>, reply: String?, waitUntilIdle: Boolean,
        clientMessageId: String, onAccepted: (() -> Unit)?,
    ) {
        val scope = room?.let { "room:${it.roomId}" } ?: session?.let { "session:${it.sessionId}" } ?: return
        val key = composerKey()
        if (key in preparingScopes) return
        if (text.isBlank() && attachments.isEmpty()) return
        if (handleSlashCommand(text)) {
            drafts.remove(key)
            onAccepted?.invoke()
            return
        }
        val control = Regex("^(?:/?retry|重试)(?:\\s+.*)?$", RegexOption.IGNORE_CASE).matches(text.trim()) ||
            (reply == null && (text.trimStart().startsWith("/") ||
                Regex("^(?:stop|cancel|停止|取消)[.!。！]*$", RegexOption.IGNORE_CASE).matches(text.trim())))
        if (room != null && reply == null && Regex("^\\s*(?:答\\s*[:：]|answer\\s*:|reply\\s*:)", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            deliveryError = "context"
            return
        }
        val reliable = deliveryProtocol == 1 && !deliveryHubId.isNullOrBlank() && !control
        if ((!reliable || attachments.isNotEmpty()) && (!hub.isConnected || !deliveryReady || waitUntilIdle)) {
            deliveryError = if (attachments.isNotEmpty()) "attachments" else "unsupported"
            return
        }
        val origin = deliveryOrigin
        val hubId = deliveryHubId
        val generation = missionConnectionGeneration
        val draft = drafts[key]
        val createdAt = System.currentTimeMillis()
        val S = stringsFor(lang)
        preparingScopes.add(key)
        viewModelScope.launch {
            try {
                if (room != null && !flowCache.containsKey(room.roomId)) {
                    if (!deliveryReady) { deliveryError = "context"; return@launch }
                    recoverScope(scope)
                }
                if (origin != deliveryOrigin || hubId != deliveryHubId) { deliveryError = "context"; return@launch }
                val originalFlow = room?.let { flowCache[it.roomId] }
                val originalRoom = room?.let { target -> rooms.find { it.roomId == target.roomId } ?: target }
                val state = deliveryFlowState(originalFlow, originalRoom?.subMode)
                val expectedState = if (waitUntilIdle && reply == null && state == "active") "terminal" else state
                val fullText = if (room == null && q != null) S.quoteHeaderFmt.format(q.first, q.second) + "\n" + text else text
                val content = prepareMessageContent(fullText, attachments, S)
                if (origin != deliveryOrigin || hubId != deliveryHubId) { deliveryError = "context"; return@launch }
                val method = if (room != null) "room.message" else "prompt.send"
                val params = buildJsonObject {
                    put(if (room != null) "roomId" else "sessionId", room?.roomId ?: session!!.sessionId)
                    put("content", content)
                    if (reliable) put("clientMessageId", clientMessageId)
                    if (room != null) {
                        put("text", text)
                        if (reliable) {
                            put("expectedFlowId", originalFlow?.flowId?.takeIf { it.isNotBlank() }?.let { JsonPrimitive(it) } ?: JsonNull)
                            put("expectedMissionId", originalFlow?.missionId?.let { JsonPrimitive(it) } ?: JsonNull)
                            put("expectedFlowState", expectedState)
                            put("expectedRoomMode", originalRoom!!.mode)
                        }
                        if (q != null) put("quote", buildJsonObject { put("author", q.first); put("text", q.second) })
                        if (reply != null) { put("intent", "answer"); put("replyTo", reply) }
                    }
                }
                if (reliable) {
                    deliveryFiles[clientMessageId] = attachments
                    val record = DeliveryRecord(
                        clientMessageId, origin, hubId!!, scope, method, params, text, createdAt,
                        deferred = !deliveryReady || waitUntilIdle, replayable = attachments.isEmpty(),
                        profileLabel = currentProfile?.name.orEmpty(),
                        scopeLabel = originalRoom?.name ?: session?.name.orEmpty(),
                        attachmentNames = attachments.map { it.name }, quoteAuthor = q?.first, quoteText = q?.second,
                        waitUntilIdle = waitUntilIdle,
                    )
                    if (!delivery.enqueue(record)) { deliveryFiles.remove(clientMessageId); return@launch }
                } else {
                    if (!deliveryReady || !currentConnection(profileEpoch, generation)) { deliveryError = "unsupported"; return@launch }
                    val bubble = ChatItem.User(++itemSeq, text, attachments, quoteAuthor = q?.first, quoteText = q?.second, sendStatus = "sending")
                    updateScopeItems(scope, scopeItems(scope) + bubble)
                    try {
                        deliveryRpc(method, params)
                        if (origin != deliveryOrigin || hubId != deliveryHubId) return@launch
                        updateScopeItems(scope, scopeItems(scope).map { if (it.id == bubble.id) bubble.copy(sendStatus = "sent") else it })
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        if (origin == deliveryOrigin && hubId == deliveryHubId) {
                            updateScopeItems(scope, scopeItems(scope).map { if (it.id == bubble.id) bubble.copy(sendStatus = "uncertain") else it })
                            deliveryError = "uncertain"
                        }
                        return@launch
                    }
                }
                consumeComposition(key, draft, attachments, q, reply)
                onAccepted?.invoke()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (origin == deliveryOrigin && hubId == deliveryHubId) deliveryError = if (attachments.isNotEmpty()) "attachments" else "sync"
            } finally {
                preparingScopes.remove(key)
            }
        }
    }

    fun sendPrompt(text: String, qOverride: Pair<String, String>? = null, attsOverride: List<Attachment>? = null,
                   fromQueue: Boolean = false, clientMessageId: String = newClientMessageId(), onAccepted: (() -> Unit)? = null) {
        val session = currentSession ?: return
        val q = if (fromQueue) qOverride else (qOverride ?: quote)
        submitDelivery(text, null, session, q, attsOverride ?: pendingAttachments.toList(), null, fromQueue,
            clientMessageId, onAccepted)
    }

    fun retryTask(taskId: String) {
        val room = currentRoom ?: return
        viewModelScope.launch {
            try {
                val taskIds = buildJsonArray { add(taskId) }
                hub.call("room.retryTasks", buildJsonObject {
                    put("roomId", room.roomId)
                    put("taskIds", taskIds)
                })
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, stringsFor(lang).retryFailedFmt.format(e.message)))
            }
        }
    }

    fun retryFailedTasks() {
        val room = currentRoom ?: return
        viewModelScope.launch {
            try {
                hub.call("room.retryTasks", buildJsonObject {
                    put("roomId", room.roomId)
                })
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, stringsFor(lang).retryFailedFmt.format(e.message)))
            }
        }
    }

    fun cancelFlow() {
        val room = currentRoom ?: return
        viewModelScope.launch {
            try {
                hub.call("room.flow.cancel", buildJsonObject { put("roomId", room.roomId) })
                flow = null
                flowCache[room.roomId] = null
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, stringsFor(lang).cancelFlowFailedFmt.format(e.message)))
            }
        }
    }

    fun sendRoomMessage(text: String, qOverride: Pair<String, String>? = null, attsOverride: List<Attachment>? = null,
                        fromQueue: Boolean = false, replyToOverride: String? = null,
                        clientMessageId: String = newClientMessageId(), onAccepted: (() -> Unit)? = null) {
        val room = currentRoom ?: return
        val q = if (fromQueue) qOverride else (qOverride ?: quote)
        val helpReply = replyToOverride ?: if (fromQueue) null else helpReplyTo
        submitDelivery(text, room, null, q, attsOverride ?: pendingAttachments.toList(), helpReply,
            fromQueue && helpReply == null, clientMessageId, onAccepted)
    }

    fun quoteArtifact(artifact: ArtifactInfo) {
        if (!artifact.path.isNullOrBlank()) {
            fileRefToInsert = artifact.path
        }
        quote = sessionName(artifact.author) to artifact.summary
    }

    fun quoteEvent(event: EventInfo) {
        quote = sessionName(event.author) to "[${event.action}] ${event.summary}"
    }

    fun quoteBlackboard(entry: BlackboardEntry) {
        quote = sessionName(entry.from) to entry.text
    }

    fun toggleMessageSelection(id: String) {
        if (selectedMessageIds.contains(id)) selectedMessageIds.remove(id) else selectedMessageIds.add(id)
    }

    fun enterMultiSelect(id: String) {
        multiSelectMode = true
        selectedMessageIds.clear()
        selectedMessageIds.add(id)
    }

    fun exitMultiSelect() {
        multiSelectMode = false
        selectedMessageIds.clear()
    }

    fun quoteSelectedMessages() {
        if (selectedMessageIds.isEmpty()) return
        val items = chatListItems.value.filter { it.id in selectedMessageIds }
        if (items.isEmpty()) return
        val byOriginal = items.distinctBy { it.originalId }
        val combined = byOriginal.joinToString("\n\n") { "@${it.author}: ${it.text.take(500)}" }
        quote = byOriginal.joinToString(", ") { it.author } to combined
        exitMultiSelect()
    }

    fun copySelectedMessages() {
        if (selectedMessageIds.isEmpty()) return
        val items = chatListItems.value.filter { it.id in selectedMessageIds }
        val byOriginal = items.distinctBy { it.originalId }
        val text = byOriginal.joinToString("\n\n") { "@${it.author}: ${it.text}" }
        viewModelScope.launch {
            // 复制到剪贴板
            val ctx = getApplication<Application>().applicationContext
            val clipboard = ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText(null, text))
            android.widget.Toast.makeText(ctx, stringsFor(lang).copiedMessagesFmt.format(byOriginal.size), android.widget.Toast.LENGTH_SHORT).show()
        }
        exitMultiSelect()
    }

    fun removeArtifact(artifact: ArtifactInfo) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        currentArtifacts.remove(artifact)
        viewModelScope.launch {
            try {
                if (roomId != null) {
                    hub.call("room.removeArtifact", buildJsonObject {
                        put("roomId", roomId)
                        put("artifactId", artifact.id)
                    })
                } else {
                    hub.call("session.removeArtifact", buildJsonObject {
                        put("sessionId", sessionId!!)
                        put("artifactId", artifact.id)
                    })
                }
            } catch (e: Exception) {
                currentArtifacts.add(artifact)
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "remove failed"))
            }
        }
    }

    fun clearArtifacts(kind: String? = null) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                if (roomId != null) {
                    hub.call("room.clearArtifacts", buildJsonObject {
                        put("roomId", roomId)
                        if (kind != null) put("kind", kind)
                    })
                } else if (kind == "event") {
                    hub.call("session.clearEvents", buildJsonObject { put("sessionId", sessionId!!) })
                } else {
                    hub.call("session.clearArtifacts", buildJsonObject { put("sessionId", sessionId!!) })
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "clear failed"))
            }
        }
    }

    fun removeEvent(event: EventInfo) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        currentEvents.remove(event)
        viewModelScope.launch {
            try {
                if (roomId != null) {
                    hub.call("room.removeEvent", buildJsonObject {
                        put("roomId", roomId)
                        put("eventId", event.id)
                    })
                } else {
                    hub.call("session.removeEvent", buildJsonObject {
                        put("sessionId", sessionId!!)
                        put("eventId", event.id)
                    })
                }
            } catch (e: Exception) {
                currentEvents.add(event)
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "remove failed"))
            }
        }
    }

    fun removeEvents(events: List<EventInfo>) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        currentEvents.removeAll(events)
        viewModelScope.launch {
            try {
                if (roomId != null) {
                    for (event in events) {
                        hub.call("room.removeEvent", buildJsonObject {
                            put("roomId", roomId)
                            put("eventId", event.id)
                        })
                    }
                } else {
                    for (event in events) {
                        hub.call("session.removeEvent", buildJsonObject {
                            put("sessionId", sessionId!!)
                            put("eventId", event.id)
                        })
                    }
                }
            } catch (e: Exception) {
                currentEvents.addAll(events)
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "remove failed"))
            }
        }
    }

    fun clearEvents(action: String? = null) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                if (roomId != null) {
                    hub.call("room.clearEvents", buildJsonObject {
                        put("roomId", roomId)
                        if (action != null) put("action", action)
                    })
                } else {
                    hub.call("session.clearEvents", buildJsonObject {
                        put("sessionId", sessionId!!)
                        if (action != null) put("action", action)
                    })
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "clear failed"))
            }
        }
    }

    fun removeBlackboardEntry(entry: BlackboardEntry) {
        val room = currentRoom ?: return
        viewModelScope.launch {
            try {
                hub.call("room.blackboard.remove", buildJsonObject {
                    put("roomId", room.roomId)
                    put("id", entry.id)
                })
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "remove failed"))
            }
        }
    }

    fun clearBlackboard() {
        val room = currentRoom ?: return
        viewModelScope.launch {
            try {
                hub.call("room.blackboard.clear", buildJsonObject {
                    put("roomId", room.roomId)
                })
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "clear failed"))
            }
        }
    }

    fun downloadArtifactFile(artifact: ArtifactInfo) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        if (artifact.path.isNullOrBlank()) {
            Toast.makeText(getApplication(), stringsFor(lang).noDownloadableFile, Toast.LENGTH_SHORT).show()
            return
        }
        viewModelScope.launch {
            val S = stringsFor(lang)
            try {
                val result = withContext(Dispatchers.IO) {
                    hub.call("file.get", buildJsonObject {
                        put("path", artifact.path)
                        if (roomId != null) put("roomId", roomId) else put("sessionId", sessionId!!)
                    })
                }
                val name = result["name"]?.jsonPrimitive?.content
                    ?: artifact.path.substringAfterLast('/')
                val mime = result["mime"]?.jsonPrimitive?.content ?: "*/*"
                val text = result["text"]?.jsonPrimitive?.content
                val data = result["data"]?.jsonPrimitive?.content
                if (text == null && data == null) throw Exception("empty file")
                pendingDownload = DownloadRequest(name, text, data, mime)
            } catch (e: Exception) {
                val msg = when {
                    e.message?.contains("not readable", true) == true -> S.fileNotReadable
                    e.message?.contains("not found", true) == true -> S.fileNotFound
                    else -> e.message ?: S.downloadFailed
                }
                Toast.makeText(getApplication(), msg, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun loadFilePreview(filePath: String) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        filePreview = FilePreview(name = File(filePath).name, path = filePath)
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    hub.call("file.get", buildJsonObject {
                        put("path", filePath)
                        if (roomId != null) put("roomId", roomId) else put("sessionId", sessionId!!)
                    })
                }
                val name = result["name"]?.jsonPrimitive?.content ?: filePath.substringAfterLast('/')
                val mime = result["mime"]?.jsonPrimitive?.content ?: "*/*"
                val text = result["text"]?.jsonPrimitive?.content
                val data = result["data"]?.jsonPrimitive?.content
                filePreview = if (text != null) {
                    FilePreview(name, filePath, text, null, mime)
                } else if (data != null) {
                    FilePreview(name, filePath, null, Base64.decode(data, Base64.NO_WRAP), mime)
                } else {
                    FilePreview(name, filePath, null, null, mime)
                }
            } catch (e: Exception) {
                filePreview = FilePreview(name = File(filePath).name, path = filePath, text = stringsFor(lang).loadFailedFmt.format(e.message))
            }
        }
    }

    fun dismissFilePreview() {
        filePreview = null
    }

    fun loadArtifactPreview(artifact: ArtifactInfo) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        val name = artifact.path?.substringAfterLast('/') ?: artifact.alias ?: artifact.id
        filePreview = FilePreview(name = name, path = artifact.path ?: "")
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    hub.call("file.get", buildJsonObject {
                        if (roomId != null) {
                            put("roomId", roomId)
                            put("artifactId", artifact.id)
                        } else {
                            put("sessionId", sessionId!!)
                            put("path", artifact.path ?: artifact.id)
                        }
                    })
                }
                val fileName = result["name"]?.jsonPrimitive?.content ?: name
                val mime = result["mime"]?.jsonPrimitive?.content ?: "*/*"
                val text = result["text"]?.jsonPrimitive?.content
                val data = result["data"]?.jsonPrimitive?.content
                filePreview = if (text != null) {
                    FilePreview(fileName, artifact.path ?: "", text, null, mime)
                } else if (data != null) {
                    FilePreview(fileName, artifact.path ?: "", null, Base64.decode(data, Base64.NO_WRAP), mime)
                } else {
                    FilePreview(fileName, artifact.path ?: "", null, null, mime)
                }
            } catch (e: Exception) {
                filePreview = FilePreview(name = name, path = artifact.path ?: "", text = stringsFor(lang).loadFailedFmt.format(e.message))
            }
        }
    }

    fun removeArtifacts(artifacts: List<ArtifactInfo>) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        currentArtifacts.removeAll(artifacts)
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    for (a in artifacts) {
                        if (roomId != null) {
                            hub.call("room.removeArtifact", buildJsonObject {
                                put("roomId", roomId)
                                put("artifactId", a.id)
                            })
                        } else {
                            hub.call("session.removeArtifact", buildJsonObject {
                                put("sessionId", sessionId!!)
                                put("artifactId", a.id)
                            })
                        }
                    }
                }
            } catch (e: Exception) {
                for (a in artifacts) {
                    if (!currentArtifacts.contains(a)) currentArtifacts.add(a)
                }
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "remove failed"))
            }
        }
    }

    fun deleteProjectFile(filePath: String) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    hub.call("file.delete", buildJsonObject {
                        put("path", filePath)
                        if (roomId != null) put("roomId", roomId) else put("sessionId", sessionId!!)
                    })
                }
                refreshFileTree(fileTreePath)
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "delete failed"))
            }
        }
    }

    fun renameProjectFile(from: String, to: String) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    if (roomId != null) {
                        hub.call("file.rename", buildJsonObject {
                            put("roomId", roomId)
                            put("from", from)
                            put("to", to)
                        })
                    } else {
                        hub.call("session.file.rename", buildJsonObject {
                            put("sessionId", sessionId!!)
                            put("from", from)
                            put("to", to)
                        })
                    }
                }
                refreshFileTree(fileTreePath)
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "rename failed"))
            }
        }
    }

    fun refreshFileTree(path: String? = null) {
        viewModelScope.launch {
            fileTreeLoading = true
            try {
                val room = currentRoom
                val session = currentSession
                val contextId = room?.roomId ?: session?.sessionId
                if (contextId == null) return@launch
                val isSession = room == null
                val result = withContext(Dispatchers.IO) {
                    if (path == null) {
                        if (isSession) {
                            hub.call("session.file.roots", buildJsonObject { put("sessionId", contextId) })
                        } else {
                            hub.call("room.file.roots", buildJsonObject { put("roomId", contextId) })
                        }
                    } else {
                        if (isSession) {
                            hub.call("session.file.list", buildJsonObject {
                                put("sessionId", contextId)
                                put("path", path)
                            })
                        } else {
                            hub.call("room.file.list", buildJsonObject {
                                put("roomId", contextId)
                                put("path", path)
                            })
                        }
                    }
                }
                if (path == null) {
                    fileTreeRoots = result["roots"]?.jsonArray?.map { root ->
                        val obj = root.jsonObject
                        FileTreeRoot(
                            name = obj["name"]?.jsonPrimitive?.content ?: "",
                            path = obj["path"]?.jsonPrimitive?.content ?: "",
                            kind = obj["kind"]?.jsonPrimitive?.content ?: "",
                            sessionId = obj["sessionId"]?.jsonPrimitive?.content,
                        )
                    } ?: emptyList()
                    fileTreeNodes.clear()
                    fileTreePath = null
                    fileTreeRootPath = null
                    fileTreeRootName = null
                } else {
                    val list = result["nodes"]?.jsonArray?.map { node ->
                        val obj = node.jsonObject
                        FileTreeNode(
                            name = obj["name"]?.jsonPrimitive?.content ?: "",
                            path = obj["path"]?.jsonPrimitive?.content ?: "",
                            kind = obj["kind"]?.jsonPrimitive?.content ?: "",
                            at = obj["at"]?.jsonPrimitive?.longOrNull ?: 0,
                            size = obj["size"]?.jsonPrimitive?.longOrNull,
                        )
                    } ?: emptyList()
                    fileTreeNodes.clear()
                    fileTreeNodes.addAll(list)
                    fileTreePath = path
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "file tree failed"))
            } finally {
                fileTreeLoading = false
            }
        }
    }

    fun enterFileTreeRoot(root: FileTreeRoot) {
        fileTreeRootPath = root.path
        fileTreeRootName = root.name
        refreshFileTree(root.path)
    }

    fun enterFileTreeDir(dir: FileTreeNode) {
        refreshFileTree(dir.path)
    }

    fun upFileTree() {
        val current = fileTreePath ?: return
        val root = fileTreeRootPath
        val parent = File(current).parentFile?.absolutePath
        if (parent == null || root == null || (parent != root && !parent.startsWith(root + File.separator))) {
            refreshFileTree(null)
        } else {
            refreshFileTree(parent)
        }
    }

    fun openProjectFile(filePath: String) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    hub.call("file.get", buildJsonObject {
                        put("path", filePath)
                        if (roomId != null) put("roomId", roomId) else put("sessionId", sessionId!!)
                    })
                }
                val name = result["name"]?.jsonPrimitive?.content
                    ?: filePath.substringAfterLast('/')
                val mime = result["mime"]?.jsonPrimitive?.content ?: "*/*"
                val text = result["text"]?.jsonPrimitive?.content
                val data = result["data"]?.jsonPrimitive?.content
                val bytes = if (text != null) {
                    text.toByteArray(Charsets.UTF_8)
                } else if (data != null) {
                    Base64.decode(data, Base64.NO_WRAP)
                } else {
                    throw Exception("empty file")
                }
                withContext(Dispatchers.IO) {
                    val app = getApplication<Application>()
                    val dir = app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: app.filesDir
                    val file = File(dir, name)
                    if (text != null) file.writeText(text) else file.writeBytes(bytes)
                    val uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", file)
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, mime)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    app.startActivity(intent)
                }
            } catch (e: Exception) {
                val S = stringsFor(lang)
                val msg = when {
                    e.message?.contains("not readable", true) == true -> S.fileNotReadable
                    e.message?.contains("not found", true) == true -> S.fileNotFound
                    else -> e.message ?: S.openFailed
                }
                Toast.makeText(getApplication(), msg, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun downloadProjectFile(filePath: String) {
        val roomId = currentRoom?.roomId
        val sessionId = currentSession?.sessionId
        if (roomId == null && sessionId == null) return
        viewModelScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    hub.call("file.get", buildJsonObject {
                        put("path", filePath)
                        if (roomId != null) put("roomId", roomId) else put("sessionId", sessionId!!)
                    })
                }
                val name = result["name"]?.jsonPrimitive?.content
                    ?: filePath.substringAfterLast('/')
                val mime = result["mime"]?.jsonPrimitive?.content ?: "*/*"
                val text = result["text"]?.jsonPrimitive?.content
                val data = result["data"]?.jsonPrimitive?.content
                if (text == null && data == null) throw Exception("empty file")
                pendingDownload = DownloadRequest(name, text, data, mime)
            } catch (e: Exception) {
                val S = stringsFor(lang)
                val msg = when {
                    e.message?.contains("not readable", true) == true -> S.fileNotReadable
                    e.message?.contains("not found", true) == true -> S.fileNotFound
                    else -> e.message ?: S.downloadFailed
                }
                Toast.makeText(getApplication(), msg, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun saveDownloadToUri(uri: Uri, request: DownloadRequest) {
        viewModelScope.launch {
            val S = stringsFor(lang)
            try {
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { os ->
                        if (request.text != null) os.write(request.text.toByteArray(Charsets.UTF_8)) else os.write(Base64.decode(request.data, Base64.NO_WRAP))
                    } ?: throw Exception(S.cannotOpenStream)
                }
                Toast.makeText(getApplication(), S.savedToFmt.format(request.name), Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(getApplication(), e.message ?: S.saveFailed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun sendProjectFileMessage(filePath: String) {
        val text = stringsFor(lang).continueFilePrompt.format(filePath)
        if (currentRoom != null) sendRoomMessage(text) else if (currentSession != null) sendPrompt(text)
    }

    private val attachAllowedExt = setOf(
        "ts","tsx","js","jsx","mjs","cjs","py","kt","kts","java","go","rs","c","cc","cpp","h","hpp",
        "cs","rb","php","swift","scala","sh","bash","zsh","ps1","bat","sql","md","markdown","txt",
        "log","json","yaml","yml","toml","xml","ini","cfg","conf","properties","csv","html","css",
        "vue","lua","r","m","pl","dockerfile","gitignore","env","pdf",
        "png","jpg","jpeg","gif","webp","svg","bmp",
    )
    private val attachMaxBytes = 10 * 1024 * 1024L
    private val attachMaxTotal = 20 * 1024 * 1024L
    private val attachMaxCount = 5

    // 发送分流：仅可判文本型走 text 内联，二进制/未知走 resource blob（防乱码注入）
    private fun attachTextLike(mime: String, name: String): Boolean =
        mime.startsWith("text/") || mime == "application/json" || mime == "application/xml" ||
            mime.endsWith("+json") || mime.endsWith("+xml") ||
            (mime.isEmpty() && name.substringAfterLast('.', "").lowercase() in attachAllowedExt)
    var attachError by mutableStateOf<String?>(null)
        private set

    fun addAttachment(uri: Uri) {
        val S = stringsFor(lang)
        viewModelScope.launch {
            try {
                val cr = getApplication<Application>().contentResolver
                val name = uri.lastPathSegment ?: ""
                val ext = name.substringAfterLast('.', "").lowercase()
                val mime = cr.getType(uri) ?: inferMimeType(uri)
                val allowed = ext in attachAllowedExt ||
                    mime.startsWith("image/") || mime.startsWith("text/") ||
                    mime == "application/pdf"
                if (!allowed) { attachError = S.attachTypeNotAllowed; return@launch }
                if (pendingAttachments.size >= attachMaxCount) {
                    attachError = S.attachTooMany.format(attachMaxCount); return@launch
                }
                val size = withContext(Dispatchers.IO) {
                    cr.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
                }
                if (size > attachMaxBytes) { attachError = S.attachTooLarge; return@launch }
                val bytes = withContext(Dispatchers.IO) {
                    cr.openInputStream(uri)?.use { it.readBytes() } ?: byteArrayOf()
                }
                if (bytes.isEmpty()) throw Exception("empty file")
                if (bytes.size > attachMaxBytes) { attachError = S.attachTooLarge; return@launch }
                val total = pendingAttachments.sumOf { it.byteSize } + bytes.size
                if (total > attachMaxTotal) { attachError = S.attachTotalTooLarge; return@launch }
                val attFile = java.io.File(
                    getApplication<Application>().cacheDir,
                    "att_${System.nanoTime()}_${name.hashCode()}.b64",
                )
                attFile.writeText(Base64.encodeToString(bytes, Base64.NO_WRAP))
                pendingAttachments.add(Attachment(mime, "", name, attFile.absolutePath))
                attachError = null
            } catch (e: Exception) {
                attachError = e.message ?: S.attachFailed
            }
        }
    }

    fun clearAttachError() { attachError = null }

    fun removeAttachment(attachment: Attachment) {
        attachment.localPath?.let { runCatching { java.io.File(it).delete() } }
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

    fun answerPermission(requestId: String, optionId: String, optionName: String, scope: String? = null) {
        viewModelScope.launch {
            try {
                hub.call("permission.respond", buildJsonObject {
                    put("requestId", requestId)
                    put("optionId", optionId)
                    if (scope != null) put("scope", scope)
                })
                val idx = chatItems.indexOfLast { it is ChatItem.Permission && it.requestId == requestId }
                if (idx >= 0) {
                    val p = chatItems[idx] as ChatItem.Permission
                    chatItems[idx] = p.copy(answered = optionName)
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "permission respond failed"))
            }
        }
    }

    /** 决策卡应答：permission → permission.respond（带粒度）；elicitation → action 直发 */
    fun answerDecision(item: ChatItem.Decision, optionId: String, scope: String) {
        if (item.decisionType == "elicitation") {
            answerElicitation(item.requestId, optionId)
            return
        }
        viewModelScope.launch {
            try {
                hub.call("permission.respond", buildJsonObject {
                    put("requestId", item.requestId)
                    put("optionId", optionId)
                    put("scope", scope)
                })
                val idx = chatItems.indexOfLast { it is ChatItem.Decision && it.decisionId == item.decisionId }
                if (idx >= 0) {
                    val d = chatItems[idx] as ChatItem.Decision
                    val label = d.options.find { it.first == optionId }?.second ?: optionId
                    chatItems[idx] = d.copy(status = "answered", answerLabel = label, scope = scope)
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "permission respond failed"))
            }
        }
    }

    /** 决策卡撤销：pending 终止底层请求；task/always 已授权则回收授权 */
    fun revokeDecision(item: ChatItem.Decision) {
        viewModelScope.launch {
            try {
                hub.call("decision.revoke", buildJsonObject { put("decisionId", item.decisionId) })
                val idx = chatItems.indexOfLast { it is ChatItem.Decision && it.decisionId == item.decisionId }
                if (idx >= 0) {
                    val d = chatItems[idx] as ChatItem.Decision
                    chatItems[idx] = d.copy(status = "revoked")
                }
            } catch (e: Exception) {
                chatItems.add(ChatItem.Error(++itemSeq, e.message ?: "decision revoke failed"))
            }
        }
    }

    /** member.status 种子：进房/进会话时拉一次全量，后续靠事件增量 */
    fun refreshMemberStatus() {
        viewModelScope.launch {
            if (!hub.isConnected) return@launch
            try {
                val room = currentRoom
                val params = if (room != null) {
                    buildJsonObject { put("roomId", room.roomId) }
                } else {
                    val sid = currentSession?.sessionId ?: return@launch
                    buildJsonObject { put("sessionId", sid) }
                }
                val result = hub.call("member.status", params)
                result["members"]?.jsonArray?.forEach {
                    val o = it.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@forEach
                    val st = o["status"]?.jsonPrimitive?.contentOrNull ?: return@forEach
                    memberStatus[sid] = st
                }
                result["status"]?.jsonPrimitive?.contentOrNull?.let { st ->
                    result["sessionId"]?.jsonPrimitive?.contentOrNull?.let { sid ->
                        memberStatus[sid] = st
                    }
                }
            } catch (_: Exception) {
            }
        }
    }

    fun answerElicitation(requestId: String, action: String, content: Map<String, JsonElement> = emptyMap()) {
        val idx = chatItems.indexOfLast { it is ChatItem.Elicitation && it.requestId == requestId }
        if (idx >= 0) {
            val item = chatItems[idx] as ChatItem.Elicitation
            val answered = when (action) {
                "accept" -> "accepted"
                "decline" -> "declined"
                else -> "cancelled"
            }
            chatItems[idx] = item.copy(answered = answered)
        }
        viewModelScope.launch {
            try {
                hub.call("elicitation.respond", buildJsonObject {
                    put("requestId", requestId)
                    put("action", action)
                    put("content", JsonObject(content))
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
        return true
    }

    private fun withLiveItems(update: () -> Unit) {
        val key = anchorScopeKey?.takeIf { it == scopeKey() }
        if (key == null) { update(); return }
        val window = chatItems.toList()
        val hasMore = historyHasMore
        anchorScopeKey = null
        chatItems.clear()
        chatItems.addAll(chatCache[key].orEmpty())
        try {
            update()
        } finally {
            if (scopeKey() == key) {
                val latest = chatItems.toList()
                chatCache[key] = latest
                chatItems.clear()
                chatItems.addAll(window.map { item -> latest.find {
                    sameHistoryItem(it, item) || (it is ChatItem.Decision && item is ChatItem.Permission && it.requestId == item.requestId)
                } ?: item })
                anchorScopeKey = key
                historyHasMore = hasMore
            }
        }
    }

    private fun handleEvent(obj: JsonObject) {
        withLiveItems { handleEventNow(obj) }
    }

    private fun handleEventNow(obj: JsonObject) {
        val params = obj["params"] as? JsonObject
        val roomId = (params?.get("roomId") as? JsonPrimitive)?.contentOrNull
        val scopedId = (params?.get("id") as? JsonPrimitive)?.contentOrNull
        val scopedKind = (params?.get("scope") as? JsonPrimitive)?.contentOrNull
        val key = roomId?.let { "room:$it" } ?: scopedId?.takeIf { scopedKind in setOf("room", "session") }?.let { "$scopedKind:$it" }
        if (key != null) {
            deliveryRecovery.changed(key)
            if (scopeKey() == key || chatCache.containsKey(key) || deliveryRecords.any { currentDelivery(it) && it.scopeKey == key }) {
                (params?.get("entry") as? JsonObject)?.let {
                    applyRecoveredRows(key, listOf(it), false, true)
                    deliveryRecovery.remember(key, listOf(it))
                }
            }
        }
        if (obj["method"]?.jsonPrimitive?.content != "session.update") flushStreamChunks()
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
                    clearStreamingTailIfIdle(sid)
                    refreshAll()
                }
            }
            "session.update" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                if (!inScope(sid)) return
                if (shouldShowInRoom(sid)) applyUpdate(sid, p["update"]!!.jsonObject)
            }
            "session.usage" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                val u = p["usage"] as? JsonObject ?: return
                sessionUsage[sid] = parseContextUsage(u)
            }
            "prompt.done" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                busyIds.remove(sid)
                clearStreamingTailIfIdle(sid)
                val usage = parseTokenUsage(p["usage"] as? JsonObject)
                if (usage != null) {
                    val author = sessionName(sid)
                    val idx = chatItems.indexOfLast { it is ChatItem.Assistant && it.author == author }
                    if (idx >= 0) {
                        chatItems[idx] = (chatItems[idx] as ChatItem.Assistant).copy(usage = usage)
                    }
                }
                if (sessions.firstOrNull { it.sessionId == sid }?.let { it.backendType ?: it.agent } == "devin") {
                    refreshBackendQuota()
                }
                refreshAll()
            }
            "prompt.error" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                busyIds.remove(sid)
                clearStreamingTailIfIdle(sid)
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
                        subMode = p["mode"]?.jsonPrimitive?.contentOrNull,
                        activeSpeaker = p["activeSpeaker"]?.jsonPrimitive?.contentOrNull,
                        reason = p["reason"]?.jsonPrimitive?.contentOrNull,
                    )
                    val idx = rooms.indexOfFirst { it.roomId == roomId }
                    if (idx >= 0) rooms[idx] = currentRoom!!
                    currentRoom?.activeSpeaker?.let { refreshSessionUsage(it) }
                }
            }
            "room.flowUpdate" -> {
                val p = obj["params"]!!.jsonObject
                val roomId = p["roomId"]!!.jsonPrimitive.content
                flowCache[roomId] = parseFlow(p["flow"] as? JsonObject, roomId)
                if (deliveryReady) delivery.resume()
                if (currentRoom?.roomId == roomId) {
                    flow = flowCache[roomId]
                    ensureFlowCard(flow)
                    viewModelScope.launch { refreshArtifacts(roomId) }
                }
            }
            "room.blackboardUpdate" -> {
                val p = obj["params"]!!.jsonObject
                val roomId = p["roomId"]!!.jsonPrimitive.content
                if (currentRoom?.roomId == roomId) {
                    val list = p["blackboard"]?.jsonArray?.map { parseBlackboardEntry(it.jsonObject) } ?: emptyList()
                    scopeKey()?.let { key ->
                        val seen = scopeSeen.getOrPut(key) { ScopeSeen() }
                        seen.board?.let { old ->
                            newBlackboardCount = list.count { it.id !in old }
                        } ?: run { seen.board = list.map { it.id }.toSet() }
                    }
                    blackboard.clear()
                    blackboard.addAll(list)
                }
            }
            "room.artifact" -> {
                val p = obj["params"]!!.jsonObject
                val roomId = p["roomId"]!!.jsonPrimitive.content
                if (currentRoom?.roomId == roomId) {
                    viewModelScope.launch { refreshArtifacts(roomId) }
                }
            }
            "session.artifact" -> {
                val p = obj["params"]!!.jsonObject
                val sessionId = p["sessionId"]!!.jsonPrimitive.content
                if (currentSession?.sessionId == sessionId && currentRoom == null) {
                    viewModelScope.launch { refreshSessionArtifacts(sessionId) }
                }
            }
            "decision.update" -> {
                decisionEventRev++
                val p = obj["params"]!!.jsonObject
                val entry = p["entry"] as? JsonObject ?: return
                try {
                    val meta = Json.parseToJsonElement(entry["text"]?.jsonPrimitive?.content ?: "").jsonObject
                    val did = meta["decisionId"]?.jsonPrimitive?.content
                    val st = meta["status"]?.jsonPrimitive?.content
                    if (did != null) {
                        if (st == "pending") {
                            pendingDecisions.removeAll { it.decisionId == did }
                            pendingDecisions.add(parseDecision(meta))
                        } else {
                            pendingDecisions.removeAll { it.decisionId == did }
                        }
                    }
                } catch (_: Exception) {
                }
            }
            "member.status" -> {
                val p = obj["params"]!!.jsonObject
                val scope = p["scope"]?.jsonPrimitive?.contentOrNull
                val member = p["member"]?.jsonPrimitive?.contentOrNull ?: return
                val status = p["status"]?.jsonPrimitive?.contentOrNull ?: return
                val relevant = when (scope) {
                    "room" -> p["id"]?.jsonPrimitive?.contentOrNull == currentRoom?.roomId
                    else -> true
                }
                if (relevant) memberStatus[member] = status
            }
            "member.quota" -> {
                val p = obj["params"]!!.jsonObject
                val q = parseReportedQuota(p["quota"]) ?: return
                (p["sessionIds"]?.jsonArray ?: p["connectionIds"]?.jsonArray)
                    ?.forEach { memberQuotas[it.jsonPrimitive.content] = q }
                p["sessionId"]?.jsonPrimitive?.contentOrNull?.let { memberQuotas[it] = q }
                p["connectionId"]?.jsonPrimitive?.contentOrNull?.let { memberQuotas[it] = q }
            }
            "permission.request" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                if (!inScope(sid)) return
                if (!busyIds.contains(sid)) busyIds.add(sid)
                val reqId = p["requestId"]!!.jsonPrimitive.content
                // 决策卡已覆盖此请求时不再重复渲染旧条目
                if (chatItems.any { it is ChatItem.Decision && it.requestId == reqId }) return
                val tool = p["toolCall"]!!.jsonObject
                val title = tool["title"]?.jsonPrimitive?.content ?: stringsFor(lang).toolCallLabel
                val options = p["options"]!!.jsonArray.map {
                    val o = it.jsonObject
                    o["optionId"]!!.jsonPrimitive.content to o["name"]!!.jsonPrimitive.content
                }
                chatItems.add(
                    ChatItem.Permission(++itemSeq,
                        reqId,
                        title,
                        options,
                        author = sessionName(sid),
                    )
                )
            }
            "elicitation.request" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                if (!inScope(sid)) return
                if (!busyIds.contains(sid)) busyIds.add(sid)
                val fields = p["fields"]?.jsonArray?.map { f ->
                    val fo = f.jsonObject
                    ElicitationField(
                        name = fo["name"]?.jsonPrimitive?.content ?: "",
                        label = fo["label"]?.jsonPrimitive?.content ?: "",
                        type = fo["type"]?.jsonPrimitive?.content ?: "string",
                        required = fo["required"]?.jsonPrimitive?.booleanOrNull ?: false,
                        description = fo["description"]?.jsonPrimitive?.contentOrNull,
                        options = fo["options"]?.jsonArray?.map { o ->
                            val oo = o.jsonObject
                            ElicitationOption(
                                oo["value"]?.jsonPrimitive?.content ?: "",
                                oo["label"]?.jsonPrimitive?.content ?: "",
                            )
                        } ?: emptyList(),
                        defaultValue = fo["defaultValue"],
                    )
                } ?: emptyList()
                chatItems.add(
                    ChatItem.Elicitation(++itemSeq,
                        p["requestId"]!!.jsonPrimitive.content,
                        p["message"]?.jsonPrimitive?.content ?: "",
                        fields,
                        author = sessionName(sid),
                    )
                )
            }
            "task.update" -> {
                val p = obj["params"]!!.jsonObject
                val list = p["tasks"]?.jsonArray ?: return
                // 先全部解析成功再整体替换：单条畸形 entry 不得造成部分填充
                val parsed = list.map { parseTask(it.jsonObject) }
                scheduledTasks.clear()
                scheduledTasks.addAll(parsed)
            }
            "mission.update" -> {
                try {
                    val p = obj["params"]!!.jsonObject
                    val raw = p["mission"] as? JsonObject ?: return
                    missionEventRev++
                    upsertMission(parseMission(raw))
                } catch (_: Exception) {
                }
            }
        }
    }

    /** 流式合帧的有序 run：连续同 (sessionId,kind) 合并，保留 message/thought 交错与跨会话到达序 */
    private data class StreamRun(val scopeKey: String, val epoch: Int, val generation: Int, val sessionId: String, val kind: String, val text: StringBuilder)

    private val streamRuns = mutableListOf<StreamRun>()
    private var streamFlushJob: kotlinx.coroutines.Job? = null
    private fun clearStreamingTailIfIdle(sid: String) {
        if (streamingTail?.first == sid && !busyIds.contains(sid)) streamingTail = null
    }

    /** 仍在接收流式 chunk 的尾部 item（sessionId to itemId）；busyIds 离组即自愈，无需显式清理 */
    private var streamingTail: Pair<String, Long>? = null

    /** UI 层判定：该 ChatItem id 是否为仍在流式增长的尾部 item（与 UI streaming 标记同语义） */
    fun isStreamingTail(id: Long): Boolean =
        streamingTail?.second == id && busyIds.contains(streamingTail?.first)

    private fun queueChunk(sessionId: String, kind: String, text: String) {
        val key = scopeKey() ?: return
        val last = streamRuns.lastOrNull()
        if (last != null && last.scopeKey == key && last.epoch == profileEpoch && last.generation == missionConnectionGeneration &&
            last.sessionId == sessionId && last.kind == kind) {
            last.text.append(text)
        } else {
            streamRuns.add(StreamRun(key, profileEpoch, missionConnectionGeneration, sessionId, kind, StringBuilder(text)))
        }
        if (streamFlushJob?.isActive != true) {
            streamFlushJob = viewModelScope.launch {
                kotlinx.coroutines.delay(80)
                flushStreamChunks()
            }
        }
    }

    private fun flushStreamChunks() {
        if (streamRuns.isEmpty()) return
        withLiveItems { flushStreamChunksNow() }
    }

    private fun flushStreamChunksNow() {
        val runs = streamRuns.toList()
        streamRuns.clear()
        for (run in runs) {
            // 80ms 窗口内可能已切换会话/房间：scope 校验与事件入口一致，防止缓冲写进新 scope 的 chatItems
            if (run.scopeKey != scopeKey() || run.epoch != profileEpoch || run.generation != missionConnectionGeneration ||
                !inScope(run.sessionId) || !shouldShowInRoom(run.sessionId)) continue
            val author = sessionName(run.sessionId)
            val text = run.text.toString()
            if (text.isEmpty()) continue
            val last = chatItems.lastOrNull()
            if (run.kind == "t") {
                if (last is ChatItem.Thought && last.author == author) {
                    chatItems[chatItems.lastIndex] = last.copy(text = last.text + text)
                    streamingTail = run.sessionId to last.id
                } else {
                    val id = ++itemSeq
                    chatItems.add(ChatItem.Thought(id, text, author))
                    streamingTail = run.sessionId to id
                }
            } else {
                if (last is ChatItem.Assistant && last.author == author) {
                    chatItems[chatItems.lastIndex] = last.copy(text = last.text + text)
                    streamingTail = run.sessionId to last.id
                } else {
                    val id = ++itemSeq
                    chatItems.add(ChatItem.Assistant(id, text, author))
                    streamingTail = run.sessionId to id
                }
            }
        }
    }

    private fun applyUpdate(sessionId: String, u: JsonObject) {
        val author = sessionName(sessionId)
        when (u["sessionUpdate"]?.jsonPrimitive?.content) {
            "agent_message_chunk" -> {
                val text = u["content"]?.jsonObject?.get("text")?.jsonPrimitive?.content ?: return
                queueChunk(sessionId, "m", text)
            }
            "agent_thought_chunk" -> {
                val text = u["content"]?.jsonObject?.get("text")?.jsonPrimitive?.content ?: return
                queueChunk(sessionId, "t", text)
            }
            "tool_call" -> {
                flushStreamChunks()
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
                flushStreamChunks()
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
                flushStreamChunks()
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

    private fun expandChatItems(items: List<ChatItem>): List<ChatListItem> {
        val currentKeys = items.map { it.id to it.text }.toSet()
        chatListCache.keys.retainAll(currentKeys)
        val result = mutableListOf<ChatListItem>()
        var i = 0
        while (i < items.size) {
            val item = items[i]
            if (item is ChatItem.Thought || item is ChatItem.Tool || item is ChatItem.Plan) {
                val group = mutableListOf<ChatItem>(item)
                val author = item.author
                i++
                while (i < items.size) {
                    val next = items[i]
                    if (next.author == author && (next is ChatItem.Thought || next is ChatItem.Tool || next is ChatItem.Plan)) {
                        group.add(next)
                        i++
                    } else break
                }
                result.add(
                    ChatListItem.ProcessGroup(
                        id = "p_${group.first().id}",
                        originalId = group.first().id,
                        author = author,
                        text = group.joinToString("\n") { it.text },
                        at = group.last().at,
                        items = group,
                    ),
                )
            } else {
                result.addAll(
                    when (item) {
                        is ChatItem.User -> splitItemBlocks(item, isUser = true)
                        is ChatItem.Assistant ->
                            // 流式中的尾部 item：跳过 splitMessageBlocks 块解析，整段作为单块直出；
                            // busyIds 离组（done/中断）后下次展开即恢复完整解析
                            if (i == items.lastIndex && isStreamingTail(item.id)) {
                                listOf(
                                    ChatListItem.Message(
                                        id = item.id.toString(),
                                        originalId = item.id,
                                        author = item.author,
                                        text = item.text,
                                        content = item.text,
                                        at = item.at,
                                        isUser = false,
                                        isFirst = true,
                                        isLast = true,
                                        usage = item.usage,
                                    ),
                                )
                            } else {
                                chatListCache.getOrPut(item.id to item.text) { splitItemBlocks(item, isUser = false) }
                            }
                        is ChatItem.Flow -> listOf(ChatListItem.FlowCard(item))
                        else -> listOf(ChatListItem.Other(item))
                    },
                )
                i++
            }
        }
        return result
    }

    private fun splitItemBlocks(item: ChatItem, isUser: Boolean): List<ChatListItem> {
        val blocks = splitMessageBlocks(item.text)
        if (blocks.isEmpty()) return listOf(ChatListItem.Other(item))
        val userItem = if (isUser) item as ChatItem.User else null
        val assistantItem = if (!isUser) item as ChatItem.Assistant else null
        return blocks.mapIndexed { index, block ->
            val isFirst = block.isFirst
            val isLast = block.isLast
            val id = if (index == 0) item.id.toString() else "${item.id}_${index}"
            val attachments = if (isFirst) userItem?.attachments ?: emptyList() else emptyList()
            val quoteAuthor = if (isFirst) userItem?.quoteAuthor else null
            val quoteText = if (isFirst) userItem?.quoteText else null
            val usage = if (isLast) assistantItem?.usage else null
            ChatListItem.Message(
                id = id,
                originalId = item.id,
                author = item.author,
                text = item.text,
                content = block.text,
                at = item.at,
                isUser = isUser,
                isFirst = isFirst,
                isLast = isLast,
                quoteAuthor = quoteAuthor,
                quoteText = quoteText,
                attachments = attachments,
                usage = usage,
                clientMessageId = userItem?.clientMessageId,
                sendStatus = if (isLast) userItem?.sendStatus else null,
                sendError = if (isLast) userItem?.sendError else null,
                attachmentNames = if (isFirst) userItem?.attachmentNames ?: emptyList() else emptyList(),
            )
        }
    }

    // 过滤出非模型的 select 型会话配置项（mode/thought_level 等）
    private fun parseSessionConfigOptions(raw: JsonArray?): List<SessionConfigOption> {
        if (raw == null) return emptyList()
        return raw.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
            if (id == "model") return@mapNotNull null
            val options = o["options"]?.jsonArray?.mapNotNull { v ->
                val vo = v as? JsonObject ?: return@mapNotNull null
                val value = vo["value"]?.jsonPrimitive?.content ?: return@mapNotNull null
                SessionConfigOptionValue(
                    value = value,
                    name = vo["name"]?.jsonPrimitive?.content ?: value,
                    description = vo["description"]?.jsonPrimitive?.content,
                )
            } ?: return@mapNotNull null
            if (options.isEmpty()) return@mapNotNull null
            SessionConfigOption(
                id = id,
                name = o["name"]?.jsonPrimitive?.content ?: id,
                currentValue = o["currentValue"]?.jsonPrimitive?.content ?: "",
                options = options,
            )
        }
    }

    private fun JsonObject.toModelInfo(current: String): ModelInfo {
        val uid = this["uid"]?.jsonPrimitive?.content ?: ""
        val family = this["family"]?.jsonPrimitive?.content ?: ""
        val familyUid = this["familyUid"]?.jsonPrimitive?.content ?: ""
        return ModelInfo(
            uid = uid,
            label = this["label"]?.jsonPrimitive?.content ?: "",
            family = family,
            vendor = familyUid.ifBlank { family.split(Regex("[-.\\s]")).firstOrNull { it.isNotBlank() } ?: family },
            slug = this["slug"]?.jsonPrimitive?.content ?: "",
            aliases = this["aliases"]?.jsonArray?.map { it.jsonPrimitive.content }?.filter { it.isNotBlank() } ?: emptyList(),
            costTier = this["costTier"]?.jsonPrimitive?.content ?: "",
            costSummary = this["costSummary"]?.jsonPrimitive?.content,
            isCurrent = uid == current,
            backend = this["backend"]?.jsonPrimitive?.content ?: "devin",
        )
    }

    init {
        debugInstance = this
        deliveryRecovery = DeliveryRecovery(
            rpc = ::recoveryRpc,
            applyRows = ::applyRecoveredRows,
            applyRoom = ::applyRecoveryRoom,
            knownCards = { key ->
                val visible = scopeItems(key) + if (scopeKey() == key && anchorScopeKey == key) chatItems else emptyList()
                visible.filter { it is ChatItem.Flow || it is ChatItem.Decision || it is ChatItem.Elicitation }
                    .mapNotNull { historyIdOf(it) }.distinct()
            },
            beforeReset = { key -> recoveryResetBase[key] = scopeItems(key).toSet() },
        )
        delivery = DeliveryOutbox(
            scope = viewModelScope,
            read = { prefs.getString("delivery_outbox_v1", null) },
            write = { value -> withContext(Dispatchers.IO) { prefs.edit().putString("delivery_outbox_v1", value).commit() } },
            rpc = ::deliveryRpc,
            validate = ::validateDelivery,
            onRecord = ::recordDelivery,
            onChange = ::updateDeliveryRecords,
            // 瞬态错误（context 等）仅当本连接有在途记录时才上报——
            // parked（其他连接）记录触发的失败不再复活 banner；存储级错误始终上报
            onError = { err ->
                deliveryError = if (err != null && err in setOf(
                        "context", "sync", "expired", "attachments", "unsupported") &&
                    delivery.records.none {
                        currentDelivery(it) && it.status in setOf("pending", "sending", "uncertain", "failed")
                    }) null else ifcHint(err.orEmpty())
            },
        )
        updateDeliveryRecords(delivery.records)
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            HubService.attentionState.collect { targets ->
                attentionItems.clear()
                attentionItems.addAll(targets)
            }
        }
        prefs.registerOnSharedPreferenceChangeListener(backgroundPrefsListener)
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            HubService.runningState.collect { refreshBackgroundStatus() }
        }
        networkMonitoringAvailable = try {
            NetworkReconnectMonitor(getApplication(), viewModelScope) { id -> hub.onNetworkChanged(id) }
                .also { networkMonitor = it }.register()
        } catch (_: Exception) { false }
        hub.onNetworkChanged(networkMonitor?.currentNetworkId)
        refreshBackgroundStatus()
        val v2Profiles = prefs.getStringSet("profiles_v2", emptySet())!!
        if (v2Profiles.isNotEmpty()) {
            v2Profiles.forEach { line ->
                val parts = line.split("\u0001")
                if (parts.size >= 4) {
                    profiles.add(ConnProfile(parts[0], parts[1], parts[2], parts[3]))
                } else if (parts.size == 3) {
                    profiles.add(ConnProfile(parts[0], parts[1], parts[2]))
                }
            }
        } else {
            prefs.getStringSet("profiles", emptySet())!!.forEach { line ->
                val parts = line.split("\u0001")
                when (parts.size) {
                    3 -> profiles.add(ConnProfile(parts[0], parts[1], parts[2]))
                    4 -> {
                        val (name, address, port, token) = parts
                        val migrated = migrateAddress(address, port)
                        profiles.add(ConnProfile(name, migrated, token))
                    }
                }
            }
        }
        savedHubConnection(getApplication())?.let { (address, token, publicToken) ->
            val name = profiles.find { it.address == address }?.name
                ?: address.removePrefix("wss://").removePrefix("ws://")
                    .substringBefore("/").substringBefore(":").substringBefore("?")
            currentProfile = ConnProfile(name, address, token, publicToken)
            connect(address, token, publicToken, name)
        }
    }
}
