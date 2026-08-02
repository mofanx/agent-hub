package com.agenthub

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class HubClient(private val scope: CoroutineScope) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    var isConnected = false
        private set
    private var nextId = 1
    private val pending = mutableMapOf<Int, CompletableDeferred<JsonObject>>()
    private val json = Json { ignoreUnknownKeys = true }

    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 512)
    val events = _events.asSharedFlow()

    var onClosed: (() -> Unit)? = null
    var onEvent: ((String) -> Unit)? = null

    fun connect(url: String, onOpen: () -> Unit, onFailure: (String) -> Unit) {
        disconnect()
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket != ws) return
                isConnected = true
                onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket != ws) return
                onEvent?.invoke(text)
                val obj = try {
                    json.parseToJsonElement(text).jsonObject
                } catch (e: Exception) {
                    return
                }
                val id = obj["id"]?.jsonPrimitive?.intOrNull
                if (id != null && pending.containsKey(id)) {
                    pending.remove(id)?.complete(obj)
                    return
                }
                scope.launch { _events.emit(obj) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket == ws) {
                    isConnected = false
                    ws = null
                    failPending(t)
                }
                onFailure(t.message ?: "connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket == ws) {
                    isConnected = false
                    ws = null
                    failPending(IllegalStateException("connection closed"))
                }
                onClosed?.invoke()
            }
        })
    }

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonObject {
        val socket = ws ?: throw IllegalStateException("not connected")
        if (!isConnected) throw IllegalStateException("not connected")
        val id = nextId++
        val deferred = CompletableDeferred<JsonObject>()
        pending[id] = deferred
        val msg = buildJsonObject {
            put("id", id)
            put("method", method)
            put("params", params)
        }
        if (!socket.send(msg.toString())) {
            pending.remove(id)
            if (ws == socket) {
                isConnected = false
                ws = null
            }
            throw IllegalStateException("send failed")
        }
        val resp = deferred.await()
        resp["error"]?.let { throw Exception(it.jsonPrimitive.content) }
        return resp["result"]?.jsonObject ?: JsonObject(emptyMap())
    }

    fun disconnect() {
        isConnected = false
        ws?.close(1000, "bye")
        ws = null
    }

    private fun failPending(t: Throwable) {
        val pendingCopy = pending.toMap()
        pending.clear()
        for (deferred in pendingCopy.values) {
            deferred.completeExceptionally(t)
        }
    }
}
