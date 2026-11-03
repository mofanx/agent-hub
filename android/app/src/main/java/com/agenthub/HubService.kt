package com.agenthub

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import com.agenthub.ui.stringsFor
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal fun savedHubConnection(context: Context): Triple<String, String, String>? {
    val prefs = context.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)
    val v2 = prefs.getString("last_v2", null)
    val connection = if (v2 != null) {
        val parts = v2.split("\u0001")
        if (parts.size < 3) return null
        Triple(parts[0], parts[1], parts[2])
    } else {
        val parts = (prefs.getString("last", null) ?: return null).split("\u0001")
        when (parts.size) {
            2 -> Triple(parts[0], parts[1], "")
            3 -> Triple(migrateAddress(parts[0], parts[1]), parts[2], "")
            else -> return null
        }
    }
    return connection.takeIf { it.first.isNotBlank() }
}

class HubService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var hub: HubClient? = null
    private var isConnected = false
    private var isDestroyed = false
    private var activeProfile: Triple<String, String, String>? = null
    private var connectionGeneration = 0
    private var networkMonitor: NetworkReconnectMonitor? = null
    private var networkMonitoringAvailable = true
    private lateinit var attentionLedger: AttentionLedger
    private var attentionJob: Job? = null
    private var attentionReconcileJob: Job? = null
    private var attentionRetryJob: Job? = null
    private var attentionUnsupported = false
    private var attentionReady = false
    private var attentionOrigin = ""
    private var attentionHubId: String? = null
    private var decisionRevision = 0
    private val attentionFlows = mutableMapOf<String, JsonObject?>()
    private val flowRevisions = mutableMapOf<String, Int>()
    private val attentionDecisions = mutableMapOf<String, JsonObject>()
    private val prefs by lazy { getSharedPreferences("agent-hub", MODE_PRIVATE) }

    private val powerManager by lazy { getSystemService(Context.POWER_SERVICE) as PowerManager }
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        attentionLedger = AttentionLedger(
            runCatching { prefs.getString("attention_v1", null) }.getOrNull(),
            write = { value -> withContext(Dispatchers.IO) { prefs.edit().putString("attention_v1", value).commit() } },
            show = { target, silent ->
                val S = stringsFor(prefs.getString("lang", "zh") ?: "zh")
                Notifier.notify(this, Notifier.CHANNEL_PERMISSION, S.attentionNeeded, S.attentionLabels.getValue("body"),
                    target.key.hashCode(), target.extras, target.key, silent)
            },
            cancel = { Notifier.cancel(this, it) },
            enabled = { !ChatViewModel.appForeground && Notifier.notificationsAvailable(this, Notifier.CHANNEL_PERMISSION) },
        )
        try {
            startForegroundWithNotification()
            runningStatus.value = true
        } catch (_: Exception) {
            stopConnection("start_restricted")
            return
        }
        networkMonitoringAvailable = try {
            NetworkReconnectMonitor(this, scope) { id ->
                if (!isDestroyed) hub?.onNetworkChanged(id)
            }.also { networkMonitor = it }.register()
        } catch (_: Exception) { false }
        if (!networkMonitoringAvailable) prefs.edit().putString("background_stop_reason", "network_monitor").apply()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isDestroyed) {
            connectIfNeeded()
            if (attentionReady) reconcileAttention()
            else if (isConnected && attentionJob?.isActive != true) syncAttention()
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (savedHubConnection(this) == null) stopConnection()
        super.onTaskRemoved(rootIntent)
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopConnection("timeout")
    }

    override fun onDestroy() {
        if (!isDestroyed) {
            val reason = prefs.getString("background_stop_reason", null)
            stopConnection(if (savedHubConnection(this) != null) reason ?: "service_stopped" else null)
        }
        scope.cancel()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun stopConnection(reason: String? = null, forgetProfile: Boolean = false) {
        if (isDestroyed) return
        isDestroyed = true
        runningStatus.value = false
        connectionGeneration++
        val edit = prefs.edit()
        if (reason != null) edit.putString("background_stop_reason", reason)
        if (forgetProfile && savedHubConnection(this) == activeProfile) edit.remove("last").remove("last_v2")
        edit.apply()
        networkMonitor?.close()
        networkMonitor = null
        hub?.disconnect()
        hub = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        isConnected = false
        attentionReady = false
        if (forgetProfile || savedHubConnection(this) == null) attentionLedger.cancelVisible()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundWithNotification() {
        Notifier.ensureChannels(this)
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val lang = getSharedPreferences("agent-hub", MODE_PRIVATE).getString("lang", "zh") ?: "zh"
        val S = stringsFor(lang)
        val active = attentionFlows.values.count {
            it != null && (it["flowId"] as? JsonPrimitive)?.contentOrNull?.isNotBlank() == true &&
                (it["phase"] as? JsonPrimitive)?.contentOrNull !in setOf(null, "", "done", "cancelled")
        }
        val statusText = if (!isConnected) S.connectingHub else if (attentionReady)
            S.serviceActivityFmt.format(active, attentionStatus.value.size) else S.serviceRunning
        val notification: Notification = NotificationCompat.Builder(this, Notifier.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(S.attentionLabels.getValue("app"))
            .setContentText(statusText)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun connectIfNeeded() {
        if (isDestroyed) return
        val profile = savedHubConnection(this)
        if (profile == null) { stopConnection(); return }
        if (activeProfile != profile) {
            hub?.disconnect()
            hub = null
            attentionLedger.cancelVisible()
            attentionReady = false
            attentionFlows.clear()
            attentionDecisions.clear()
            flowRevisions.clear()
            attentionStatus.value = emptyList()
            attentionHubId = null
            attentionOrigin = deliveryOriginFor(profile.first, profile.second, profile.third)
            activeProfile = profile
        }
        hub?.let {
            if (!it.isConnected) it.kickReconnect()
            return
        }
        connect(profile)
    }

    private fun connect(profile: Triple<String, String, String>) {
        val (address, token, publicToken) = profile
        val url = try { buildWsUrl(address, token) } catch (_: Exception) {
            stopConnection("invalid_config", forgetProfile = true)
            return
        }
        if (wakeLock?.isHeld != true) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentHub:HubService").apply {
                setReferenceCounted(false)
                acquire(30L * 60 * 1000)
            }
        }
        val client = HubClient(scope) {
            stringsFor(prefs.getString("lang", "zh") ?: "zh")
        }.also { hub = it }
        fun current() = !isDestroyed && hub === client && activeProfile == profile
        client.onEvent = { raw -> if (current()) handleEvent(raw) }
        client.onClosed = { if (current()) onDisconnected() }
        client.onNetworkChanged(networkMonitor?.currentNetworkId)
        client.connect(url, publicToken,
            onOpen = {
                if (current()) {
                    connectionGeneration++
                    isConnected = true
                    attentionUnsupported = false
                    prefs.edit().putString("attention_status", "sync").apply()
                    prefs.edit().apply {
                        if (networkMonitoringAvailable) remove("background_stop_reason")
                        else putString("background_stop_reason", "network_monitor")
                    }.apply()
                    updateForegroundNotification()
                    // 后台服务只订 global 层（待办/工单状态），高频流式事件不推
                    scope.launch {
                        try { client.call("client.subscribe", buildJsonObject { put("tier", "global") }) } catch (_: Exception) { }
                    }
                    syncAttention()
                }
            },
            onFailure = {
                if (current()) {
                    val reason = when (client.state) {
                        HubConnectionState.AuthFailed -> "auth"
                        HubConnectionState.PolicyRejected -> "policy"
                        HubConnectionState.InvalidConfig -> "invalid_config"
                        else -> null
                    }
                    if (reason != null) stopConnection(reason, forgetProfile = true)
                    else onDisconnected()
                }
            })
    }

    private fun onDisconnected() {
        if (isDestroyed) return
        connectionGeneration++
        isConnected = false
        prefs.edit().putString("attention_status", "sync").apply()
        attentionReady = false
        attentionJob?.cancel()
        attentionRetryJob?.cancel()
        attentionReconcileJob?.cancel()
        updateForegroundNotification()
    }

    private fun updateForegroundNotification() {
        if (isDestroyed) return
        try { startForegroundWithNotification() } catch (_: Exception) { stopConnection("start_restricted") }
    }

    private fun syncAttention() {
        val client = hub ?: return
        if (attentionJob?.isActive == true || attentionUnsupported) return
        attentionRetryJob?.cancel()
        val generation = connectionGeneration
        fun valid() = !isDestroyed && isConnected && hub === client && generation == connectionGeneration
        attentionJob = scope.launch {
            repeat(3) { attempt ->
                try {
                    val info = client.call("agent.info")
                    if (!valid()) return@launch
                    val id = (info["hubId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
                        ?: error("attention_binding_unavailable")
                    if (attentionHubId != null && attentionHubId != id) {
                        attentionFlows.clear(); attentionDecisions.clear(); flowRevisions.clear()
                        attentionLedger.cancelVisible()
                    }
                    attentionHubId = id
                    val beforeList = flowRevisions.toMap()
                    val rooms = client.call("room.list")["rooms"] as? JsonArray ?: error("attention_rooms_invalid")
                    if (!valid()) return@launch
                    val ids = rooms.map { it.jsonObject["roomId"]!!.jsonPrimitive.content }.toSet()
                    attentionFlows.keys.toList().filter { it !in ids && flowRevisions[it] == beforeList[it] }
                        .forEach { attentionFlows.remove(it); flowRevisions.remove(it) }
                    val limit = Semaphore(4)
                    coroutineScope { ids.map { roomId -> async {
                        limit.withPermit {
                            val revision = flowRevisions[roomId] ?: 0
                            val response = client.call("room.flow", buildJsonObject { put("roomId", roomId) })
                            if (!valid()) throw CancellationException("attention_stale")
                            require(response["flow"] == JsonNull || response["flow"] is JsonObject)
                            if ((flowRevisions[roomId] ?: 0) == revision) attentionFlows[roomId] = attentionFlow(response["flow"] as? JsonObject)
                        }
                    } }.awaitAll() }
                    val revision = decisionRevision
                    val decisions = client.call("decision.list")["decisions"] as? JsonArray ?: error("attention_decisions_invalid")
                    if (!valid()) return@launch
                    if (revision != decisionRevision) error("attention_snapshot_stale")
                    attentionDecisions.clear()
                    decisions.forEach { value ->
                        val o = value.jsonObject
                        attentionDecisions[o["decisionId"]!!.jsonPrimitive.content] = attentionDecision(o)
                    }
                    attentionReady = true
                    prefs.edit().remove("attention_status").apply()
                    reconcileAttention()
                    return@launch
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    if (!valid()) return@launch
                    if (e.message == "attention_binding_unavailable" || e.message?.contains("unknown method", ignoreCase = true) == true ||
                        e.message?.contains("-32601") == true) {
                        attentionUnsupported = true
                        prefs.edit().putString("attention_status", "unsupported").apply()
                        return@launch
                    }
                    prefs.edit().putString("attention_status", "sync").apply()
                    if (attempt < 2) delay(500L * (attempt + 1))
                }
            }
            attentionRetryJob = scope.launch { delay(30_000); if (valid() && !attentionReady) syncAttention() }
        }
    }

    private fun reconcileAttention() {
        if (!attentionReady || isDestroyed) return
        val id = attentionHubId ?: return
        val generation = connectionGeneration
        val targets = attentionTargets(attentionOrigin, id, attentionFlows, attentionDecisions.values.toList())
        attentionStatus.value = targets
        attentionReconcileJob?.cancel()
        attentionReconcileJob = scope.launch {
            val applied = attentionLedger.replace(targets, !ChatViewModel.appForeground) {
                !isDestroyed && attentionReady && generation == connectionGeneration
            }
            if (!isDestroyed && attentionReady && generation == connectionGeneration) {
                prefs.edit().apply { if (applied) remove("attention_status") else putString("attention_status", "sync") }.apply()
            }
            updateForegroundNotification()
        }
    }

    private fun handleEvent(raw: String) {
        val obj = try {
            kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject
        } catch (_: Exception) {
            return
        }
        when ((obj["method"] as? JsonPrimitive)?.contentOrNull) {
            "room.flowUpdate" -> {
                val p = obj["params"] as? JsonObject ?: return
                val rid = (p["roomId"] as? JsonPrimitive)?.contentOrNull ?: return
                flowRevisions[rid] = (flowRevisions[rid] ?: 0) + 1
                attentionFlows[rid] = attentionFlow(p["flow"] as? JsonObject)
                reconcileAttention()
            }
            "decision.update" -> {
                val p = obj["params"] as? JsonObject ?: return
                val entry = p["entry"] as? JsonObject ?: return
                val meta = runCatching { Json.parseToJsonElement(entry["text"]!!.jsonPrimitive.content).jsonObject }.getOrNull() ?: return
                val did = (meta["decisionId"] as? JsonPrimitive)?.contentOrNull ?: return
                decisionRevision++
                if (meta["status"]?.jsonPrimitive?.content == "pending") attentionDecisions[did] = attentionDecision(meta)
                else attentionDecisions.remove(did)
                reconcileAttention()
            }
            "prompt.done" -> {
                if (ChatViewModel.appForeground || !attentionReady) return
                val p = obj["params"] as? JsonObject ?: return
                val sid = (p["sessionId"] as? JsonPrimitive)?.contentOrNull ?: return
                val S = stringsFor(prefs.getString("lang", "zh") ?: "zh")
                val key = "reply:${deliveryOriginFor(attentionOrigin, attentionHubId.orEmpty(), sid)}"
                Notifier.notify(
                    this, Notifier.CHANNEL_MESSAGES, S.attentionLabels.getValue("app"), S.attentionLabels.getValue("reply"),
                    key.hashCode(), mapOf("navOrigin" to attentionOrigin, "navHubId" to attentionHubId.orEmpty(), "navSessionId" to sid), key,
                )
                Notifier.trimReplies(this)
            }
        }
        if (!attentionReady && isConnected && attentionJob?.isActive != true) syncAttention()
    }

    private fun dropRoomAttention(roomId: String) {
        attentionFlows.remove(roomId)
        flowRevisions.remove(roomId)
    }

    companion object {
        internal var instance: HubService? = null
        internal fun dropRoomAttention(roomId: String) = instance?.dropRoomAttention(roomId)
        private const val NOTIFICATION_ID = 1001
        private val runningStatus = MutableStateFlow(false)
        private val attentionStatus = MutableStateFlow<List<AttentionTarget>>(emptyList())
        internal val attentionState = attentionStatus.asStateFlow()
        val runningState = runningStatus.asStateFlow()
        val running: Boolean get() = runningStatus.value
    }
}
class NetworkReconnectMonitor(
    context: Context,
    private val scope: CoroutineScope,
    private val onChanged: (Long?) -> Unit,
) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var job: Job? = null
    private var current: Network? = null
    private var registered = false
    private var closed = false
    val currentNetworkId get() = current?.networkHandle
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            scope.launch {
                if (closed || current == network) return@launch
                current = network
                schedule()
            }
        }
        override fun onLost(network: Network) {
            scope.launch {
                if (closed || current != network) return@launch
                current = null
                schedule()
            }
        }
    }
    private fun schedule() {
        job?.cancel()
        job = scope.launch {
            delay(250)
            if (!closed) onChanged(currentNetworkId)
        }
    }
    fun register(): Boolean {
        if (closed) return false
        if (registered) return true
        return try {
            current = cm.activeNetwork
            cm.registerDefaultNetworkCallback(callback)
            registered = true
            scope.launch { if (!closed) onChanged(currentNetworkId) }
            true
        } catch (_: Exception) { false }
    }
    fun close() {
        closed = true
        job?.cancel()
        if (registered) {
            try { cm.unregisterNetworkCallback(callback) } catch (_: Exception) {}
            registered = false
        }
    }
}
