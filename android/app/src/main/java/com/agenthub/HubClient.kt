package com.agenthub

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit

enum class HubConnectionState {
    Disconnected, Connecting, Connected, Reconnecting, AuthFailed, PolicyRejected, InvalidConfig;
    val terminal get() = this == AuthFailed || this == PolicyRejected || this == InvalidConfig
}

class HubRpcException(val payload: JsonElement) : Exception(
    (payload as? JsonPrimitive)?.contentOrNull
        ?: ((payload as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
        ?: payload.toString()
)

class HubClient(
    private val scope: CoroutineScope,
    private val socketFactory: ((Request, WebSocketListener) -> WebSocket)? = null,
    private val strings: () -> com.agenthub.ui.Strings = { com.agenthub.ui.ZhStrings },
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    var state = HubConnectionState.Disconnected
        private set
    val isConnected get() = state == HubConnectionState.Connected
    private var nextId = 1
    private val pending = mutableMapOf<Int, CompletableDeferred<JsonObject>>()
    private val json = Json { ignoreUnknownKeys = true }
    private var attemptGen = 0

    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512)
    private var emitTail: Job? = null
    private var emissionJob: Job = Job(scope.coroutineContext[Job])

    private fun isDroppableEvent(obj: JsonObject): Boolean {
        if (obj["method"]?.jsonPrimitive?.contentOrNull != "session.update") return false
        val t = obj["params"]?.jsonObject?.get("update")?.jsonObject
            ?.get("sessionUpdate")?.jsonPrimitive?.contentOrNull
        return t == "agent_message_chunk" || t == "agent_thought_chunk"
    }
    val events = _events.asSharedFlow()

    var onClosed: (() -> Unit)? = null
    var onEvent: ((String) -> Unit)? = null
    var onStateChanged: ((HubConnectionState) -> Unit)? = null

    private var url: String? = null
    private var publicToken: String? = null
    private var onOpenCallback: (() -> Unit)? = null
    private var onFailureCallback: ((String) -> Unit)? = null
    private var reconnectJob: Job? = null
    private var shouldReconnect = false
    private var lastNetworkId: Long? = null
    private var networkObserved = false
    private var reconnectDelayMs = 1000L
    // 退避封顶 5s：hub 重启恢复红线 <30s——30s 封顶下单次睡眠即越线（与 desktop client.ts 对齐）
    private val maxReconnectDelayMs = 5000L

    private fun actor(block: suspend CoroutineScope.() -> Unit): Job =
        scope.launch(scope.coroutineContext.minusKey(Job), block = block)

    private fun setState(s: HubConnectionState) {
        if (state == s) return
        state = s
        onStateChanged?.invoke(s)
    }

    fun connect(url: String, publicToken: String = "", onOpen: () -> Unit, onFailure: (String) -> Unit) {
        actor {
            this@HubClient.url = url
            this@HubClient.publicToken = publicToken
            onOpenCallback = onOpen
            onFailureCallback = onFailure
            shouldReconnect = true
            reconnectDelayMs = 1000L
            reconnectJob?.cancel()
            attemptGen++
            hardClose(notify = false)
            if (state.terminal) setState(HubConnectionState.Disconnected)
            doConnect()
        }
    }

    fun kickReconnect() {
        actor {
            if (!shouldReconnect || isConnected || state == HubConnectionState.Connecting || state.terminal) return@actor
            reconnectJob?.cancel()
            reconnectJob = null
            doConnect()
        }
    }

    fun onNetworkChanged(networkId: Long?) {
        actor {
            if (!networkObserved) { networkObserved = true; lastNetworkId = networkId; return@actor }
            if (networkId == lastNetworkId) return@actor
            lastNetworkId = networkId
            if (!shouldReconnect || state.terminal) return@actor
            reconnectJob?.cancel()
            reconnectJob = null
            attemptGen++
            hardClose(notify = true)
            reconnectDelayMs = 1000L
            doConnect()
        }
    }

    private fun doConnect() {
        if (!shouldReconnect || isConnected || state == HubConnectionState.Connecting || state.terminal) return
        val url = this.url ?: return
        val gen = ++attemptGen
        setState(HubConnectionState.Connecting)
        val request = try {
            Request.Builder().url(url).apply {
                if (!publicToken.isNullOrBlank()) header("X-Public-Token", publicToken!!)
            }.build()
        } catch (e: Exception) {
            terminal(HubConnectionState.InvalidConfig)
            return
        }
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                actor {
                    if (gen != attemptGen || !shouldReconnect) { webSocket.cancel(); return@actor }
                    ws = webSocket
                    reconnectDelayMs = 1000L
                    setState(HubConnectionState.Connected)
                    onOpenCallback?.invoke()
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                actor {
                    if (webSocket != ws || gen != attemptGen) return@actor
                    onEvent?.invoke(text)
                    val obj = try { json.parseToJsonElement(text).jsonObject } catch (e: Exception) { return@actor }
                    val id = (obj["id"] as? JsonPrimitive)?.intOrNull
                    if (id != null && pending.containsKey(id)) { pending.remove(id)?.complete(obj); return@actor }
                    val tailDone = emitTail?.isCompleted != false
                    if (tailDone) emitTail = null
                    if (emitTail == null) {
                        if (_events.tryEmit(obj)) return@actor
                        if (isDroppableEvent(obj)) return@actor
                    } else if (isDroppableEvent(obj)) return@actor
                    val prev = emitTail
                    val ej = emissionJob
                    emitTail = CoroutineScope(scope.coroutineContext + ej).launch { prev?.join(); if (gen == attemptGen) _events.emit(obj) }
                }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                onMessage(webSocket, bytes.utf8())
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                actor {
                    if ((webSocket != ws && ws != null) || gen != attemptGen) return@actor
                    val code = response?.code
                    if (code == 401 || code == 403) {
                        terminal(HubConnectionState.AuthFailed)
                        return@actor
                    }
                    loss("connection failed", t)
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                actor {
                    if (webSocket != ws || gen != attemptGen) { webSocket.close(code, reason); return@actor }
                    if (code == 4001 || (code == 1008 && reason.contains("token", true))) {
                        terminal(HubConnectionState.AuthFailed)
                    } else if (code == 1008) {
                        terminal(HubConnectionState.PolicyRejected)
                    }
                    webSocket.close(code, reason)
                }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                actor {
                    if (webSocket != ws || gen != attemptGen) return@actor
                    if (code == 4001 || (code == 1008 && reason.contains("token", true))) {
                        terminal(HubConnectionState.AuthFailed); return@actor
                    }
                    if (code == 1008) {
                        terminal(HubConnectionState.PolicyRejected); return@actor
                    }
                    loss("connection closed")
                }
            }
        }
        actor {
            val candidate = try {
                socketFactory?.invoke(request, listener) ?: client.newWebSocket(request, listener)
            } catch (e: Exception) {
                terminal(HubConnectionState.InvalidConfig)
                return@actor
            }
            if (gen != attemptGen || !shouldReconnect) { candidate.cancel(); return@actor }
            if (ws == null) ws = candidate
        }
    }

    private fun terminal(s: HubConnectionState) {
        attemptGen++
        val old = ws
        ws = null
        old?.cancel()
        shouldReconnect = false
        reconnectJob?.cancel()
        emitTail?.cancel()
        emitTail = null
        emissionJob.cancel()
        emissionJob = Job(scope.coroutineContext[Job])
        setState(s)
        onClosed?.invoke()
        failPending(IllegalStateException(s.name))
        onFailureCallback?.invoke(when (s) {
            HubConnectionState.AuthFailed -> strings().connectionAuthFailed
            HubConnectionState.PolicyRejected -> strings().connectionPolicyRejected
            else -> strings().connectionInvalidAddress
        })
    }

    private fun loss(msg: String, cause: Throwable? = null) {
        attemptGen++
        val old = ws
        ws = null
        old?.cancel()
        if (!state.terminal) setState(HubConnectionState.Disconnected)
        onClosed?.invoke()
        failPending(IllegalStateException(msg, cause))
        emitTail?.cancel()
        emitTail = null
        emissionJob.cancel()
        emissionJob = Job(scope.coroutineContext[Job])
        if (!shouldReconnect || state.terminal) return
        onFailureCallback?.invoke(strings().connectFailed)
        val delay = reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(maxReconnectDelayMs)
        reconnectJob?.cancel()
        setState(HubConnectionState.Reconnecting)
        reconnectJob = scope.launch {
            delay(delay)
            if (isActive && shouldReconnect && !state.terminal) doConnect()
        }
    }

    private fun hardClose(notify: Boolean) {
        ws?.cancel()
        ws = null
        if (!state.terminal) setState(HubConnectionState.Disconnected)
        emitTail?.cancel()
        emitTail = null
        emissionJob.cancel()
        emissionJob = Job(scope.coroutineContext[Job])
        if (notify) onClosed?.invoke()
        failPending(IllegalStateException("disconnected"))
    }

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 30_000): JsonObject =
        withContext(scope.coroutineContext.minusKey(Job)) {
            if (!scope.isActive) throw IllegalStateException("disposed")
            val gen = attemptGen
            val socket = ws ?: throw IllegalStateException("not connected")
            if (!isConnected) throw IllegalStateException("not connected")
            val id = nextId++
            val deferred = CompletableDeferred<JsonObject>()
            pending[id] = deferred
            try {
                val msg = buildJsonObject {
                    put("id", id)
                    put("method", method)
                    put("params", params)
                }
                if (!socket.send(msg.toString())) {
                    loss("send failed")
                    throw IllegalStateException("send failed")
                }
                val resp = withTimeout(timeoutMs) { deferred.await() }
                if (gen != attemptGen) throw IllegalStateException("stale generation")
                resp["error"]?.let { throw HubRpcException(it) }
                resp["result"]?.jsonObject ?: JsonObject(emptyMap())
            } finally {
                pending.remove(id)
            }
        }

    fun disconnect() {
        actor(NonCancellable) {
            shouldReconnect = false
            attemptGen++
            reconnectJob?.cancel()
            reconnectJob = null
            val socket = ws
            ws = null
            setState(HubConnectionState.Disconnected)
            socket?.cancel()
            emitTail?.cancel()
            emitTail = null
            emissionJob.cancel()
            emissionJob = Job(scope.coroutineContext[Job])
            onClosed?.invoke()
            failPending(IllegalStateException("disconnected"))
        }
    }

    private fun actor(context: CoroutineContext, block: suspend CoroutineScope.() -> Unit): Job =
        scope.launch(context, block = block)

    private fun failPending(t: Throwable) {
        val pendingCopy = pending.toMap()
        pending.clear()
        for (deferred in pendingCopy.values) deferred.completeExceptionally(t)
    }
}
