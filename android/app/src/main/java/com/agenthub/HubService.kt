package com.agenthub

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class HubService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var hub: HubClient? = null
    private var isConnected = false
    private var isDestroyed = false
    private val sessionNames = mutableMapOf<String, String>()
    private var reconnectJob: Job? = null
    private var retryCount = 0

    private val powerManager by lazy { getSystemService(Context.POWER_SERVICE) as PowerManager }
    private var wakeLock: PowerManager.WakeLock? = null

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (!isDestroyed) connectIfNeeded()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForegroundWithNotification()
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try { cm.registerNetworkCallback(request, networkCallback) } catch (_: Exception) { }
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AgentHub:HubService").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!isDestroyed) connectIfNeeded()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        try { startForegroundService(Intent(this, HubService::class.java)) } catch (_: Exception) { }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        isDestroyed = true
        reconnectJob?.cancel()
        hub?.disconnect()
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager)
                .unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) { }
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        Notifier.ensureChannels(this)
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val statusText = if (isConnected) "后台连接保持中" else "正在连接 Hub…"
        val notification: Notification = NotificationCompat.Builder(this, Notifier.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("Agent Hub")
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
        if (isDestroyed || isConnected) return
        connect()
    }

    private fun connect() {
        val prefs = getSharedPreferences("agent-hub", MODE_PRIVATE)
        val last = prefs.getString("last", null) ?: return
        val parts = last.split("\u0001")
        if (parts.size != 3) return
        val (address, port, token) = parts
        val url = if (address.startsWith("ws://") || address.startsWith("wss://")) {
            val sep = if (address.contains("?")) "&" else "?"
            "$address${sep}token=$token"
        } else {
            "ws://$address:$port/?token=$token"
        }
        val client = HubClient(scope)
        hub?.disconnect()
        hub = client
        client.onEvent = { raw -> handleEvent(raw) }
        client.onClosed = { onDisconnected() }
        client.connect(url,
            onOpen = {
                isConnected = true
                retryCount = 0
                reconnectJob?.cancel()
                updateForegroundNotification()
                refreshSessionNames()
            },
            onFailure = { onDisconnected() })
    }

    private fun onDisconnected() {
        if (isDestroyed) return
        isConnected = false
        updateForegroundNotification()
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (isDestroyed) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            val delayMs = (1000L * (1L shl minOf(retryCount, 6))).coerceAtMost(60_000L)
            retryCount++
            try { delay(delayMs) } catch (_: CancellationException) { return@launch }
            if (isActive && !isDestroyed && !isConnected) {
                connectIfNeeded()
            }
        }
    }

    private fun updateForegroundNotification() {
        try { startForegroundWithNotification() } catch (_: Exception) { }
    }

    private fun refreshSessionNames() {
        val client = hub ?: return
        scope.launch {
            try {
                val result = client.call("session.list")
                val sessions = result["sessions"]?.jsonArray ?: return@launch
                for (s in sessions) {
                    val o = s.jsonObject
                    sessionNames[o["sessionId"]!!.jsonPrimitive.content] =
                        o["name"]!!.jsonPrimitive.content
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun sessionName(sessionId: String): String {
        if (!sessionNames.containsKey(sessionId)) refreshSessionNames()
        return sessionNames[sessionId] ?: "Agent"
    }

    private fun handleEvent(raw: String) {
        if (ChatViewModel.appForeground) return
        val obj = try {
            kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject
        } catch (_: Exception) {
            return
        }
        when (obj["method"]?.jsonPrimitive?.content) {
            "prompt.done" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                val output = p["output"]?.jsonPrimitive?.content.orEmpty()
                if (output.isBlank()) return
                Notifier.notify(
                    this,
                    Notifier.CHANNEL_MESSAGES,
                    sessionName(sid),
                    output,
                    sid.hashCode(),
                )
            }
            "permission.request" -> {
                val p = obj["params"]!!.jsonObject
                val sid = p["sessionId"]!!.jsonPrimitive.content
                val title = p["toolCall"]?.jsonObject?.get("title")?.jsonPrimitive?.content
                    ?: "工具调用"
                Notifier.notify(
                    this,
                    Notifier.CHANNEL_PERMISSION,
                    "审批请求 · ${sessionName(sid)}",
                    title,
                    (p["requestId"]?.jsonPrimitive?.content ?: sid).hashCode(),
                )
            }
        }
    }

    companion object {
        private const val NOTIFICATION_ID = 1001
    }
}
