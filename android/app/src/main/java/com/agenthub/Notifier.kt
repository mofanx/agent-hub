package com.agenthub

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.agenthub.ui.stringsFor
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

internal data class AttentionTarget(val key: String, val kind: String, val extras: Map<String, String>, val at: Long, val label: String = "")

internal fun attentionFlow(flow: JsonObject?): JsonObject? {
    if (flow == null || flow["phase"]?.jsonPrimitive?.contentOrNull in setOf("done", "cancelled")) return null
    val tasks = (flow["tasks"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    val batch = tasks.maxOfOrNull { (it["dispatchedAt"] as? JsonPrimitive)?.longOrNull ?: 0 } ?: 0
    return buildJsonObject {
        for (key in listOf("flowId", "phase", "startedAt", "clarificationId")) flow[key]?.let { put(key, it) }
        put("attentionBatchAt", (flow["attentionBatchAt"] as? JsonPrimitive)?.longOrNull ?: batch)
        (flow["goal"] as? JsonPrimitive)?.contentOrNull?.let { put("goal", it.take(200)) }
        put("clarificationQuestions", buildJsonArray {
            if ((flow["clarificationQuestions"] as? JsonArray)?.isNotEmpty() == true) add(JsonPrimitive(""))
        })
        put("tasks", JsonArray(tasks.filter { it["waitingFor"]?.jsonPrimitive?.contentOrNull == "user" }.map { task ->
            buildJsonObject {
                for (key in listOf("id", "waitingFor", "waitingHelpId", "dispatchedAt")) task[key]?.let { put(key, it) }
                ((task["task"] ?: task["name"]) as? JsonPrimitive)?.contentOrNull?.let { put("task", it.take(200)) }
            }
        }))
    }
}

internal fun attentionDecision(decision: JsonObject): JsonObject = buildJsonObject {
    for (key in listOf("decisionId", "requestId", "sessionId", "roomId", "at", "status")) decision[key]?.let { put(key, it) }
    (decision["title"] as? JsonPrimitive)?.contentOrNull?.let { put("title", it.take(200)) }
}

internal fun attentionTargets(origin: String, hubId: String, flows: Map<String, JsonObject?>, decisions: List<JsonObject>): List<AttentionTarget> {
    fun str(o: JsonObject, key: String) = (o[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
    val result = mutableListOf<AttentionTarget>()
    fun add(kind: String, at: Long, fields: Map<String, String>, label: String = "") {
        val extras = mapOf("navOrigin" to origin, "navHubId" to hubId) + fields
        val identity = JsonObject(extras.mapValues { JsonPrimitive(it.value) }).toString()
        result.add(AttentionTarget(deliveryOriginFor(origin, hubId, identity), kind, extras.toMap(), at, label))
    }
    flows.forEach { (roomId, flow) ->
        if (flow == null || str(flow, "phase") in setOf("done", "cancelled")) return@forEach
        val fid = str(flow, "flowId") ?: return@forEach
        val at = (flow["startedAt"] as? JsonPrimitive)?.longOrNull ?: 0
        val base = mapOf("navRoomId" to roomId, "navFlowId" to fid)
        str(flow, "clarificationId")?.let { help ->
            if ((flow["clarificationQuestions"] as? JsonArray)?.isNotEmpty() == true) {
                add("flow", at, base + mapOf("navHelpId" to help, "navAt" to at.toString()), str(flow, "goal").orEmpty())
            }
        }
        val waiting = (flow["tasks"] as? JsonArray).orEmpty().filter { (it as? JsonObject)?.let { t -> str(t, "waitingFor") } == "user" }
        if (str(flow, "phase") == "awaiting-retry" && waiting.isEmpty()) {
            val batch = (flow["attentionBatchAt"] as? JsonPrimitive)?.longOrNull
                ?: (flow["tasks"] as? JsonArray).orEmpty().maxOfOrNull { (it.jsonObject["dispatchedAt"] as? JsonPrimitive)?.longOrNull ?: 0 } ?: 0
            add("flow", at, base + mapOf("navBatchKey" to batch.toString()), str(flow, "goal").orEmpty())
        }
        waiting.forEach taskLoop@{ value ->
            val task = value as? JsonObject ?: return@taskLoop
            if (str(task, "waitingFor") != "user") return@taskLoop
            val tid = str(task, "id") ?: return@taskLoop
            val dispatched = (task["dispatchedAt"] as? JsonPrimitive)?.longOrNull ?: 0
            val extras = base + mapOf("navTaskId" to tid, "navDispatchedAt" to dispatched.toString())
            add("flow", dispatched.takeIf { it > 0 } ?: at,
                extras + (str(task, "waitingHelpId")?.let { mapOf("navHelpId" to it) } ?: emptyMap()), str(task, "task") ?: str(task, "name").orEmpty())
        }
    }
    decisions.forEach { decision ->
        if (str(decision, "status") != "pending") return@forEach
        val did = str(decision, "decisionId") ?: return@forEach
        val sid = str(decision, "sessionId") ?: return@forEach
        val at = (decision["at"] as? JsonPrimitive)?.longOrNull ?: 0
        val fields = mapOf("navDecisionId" to did, "navSessionId" to sid, "navAt" to at.toString()) +
            (str(decision, "requestId")?.let { mapOf("navRequestId" to it) } ?: emptyMap()) +
            (str(decision, "roomId")?.let { mapOf("navRoomId" to it) } ?: emptyMap())
        add("decision", at, fields, str(decision, "title").orEmpty())
    }
    return result.distinctBy { it.key }.sortedBy { it.at }
}

internal class AttentionLedger(
    raw: String?,
    private val write: suspend (String) -> Boolean,
    private val show: (AttentionTarget, Boolean) -> Boolean,
    private val cancel: (String) -> Unit,
    private val enabled: () -> Boolean = { true },
) {
    private val mutex = Mutex()
    private var active = linkedMapOf<String, AttentionTarget>()
    private var seen = linkedSetOf<String>()
    private val posted = mutableSetOf<String>()
    private var invalid = false
    private var lastWritten = raw

    init {
        try {
            if (raw != null) {
                require(raw.length <= 256 * 1024)
                val doc = Json.parseToJsonElement(raw).jsonObject
                require(doc["version"]?.jsonPrimitive?.intOrNull == 1)
                val entries = doc["active"]!!.jsonArray
                val history = doc["seen"]!!.jsonArray
                require(entries.size <= 40 && history.size <= 1000)
                val restored = entries.map { value ->
                    val o = value.jsonObject
                    val key = o["key"]!!.jsonPrimitive.content
                    require(key.matches(Regex("[a-f0-9]{64}")))
                    AttentionTarget(key, o["kind"]!!.jsonPrimitive.content,
                        o["extras"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content },
                        o["at"]!!.jsonPrimitive.long)
                }
                active.putAll(restored.associateBy { it.key })
                seen.addAll(history.map { it.jsonPrimitive.content.also { key -> require(key.matches(Regex("[a-f0-9]{64}"))) } })
            }
        } catch (_: Exception) { active.clear(); seen.clear(); invalid = true }
    }

    suspend fun replace(targets: List<AttentionTarget>, background: Boolean, valid: () -> Boolean = { true }): Boolean =
        mutex.withLock {
            if (!valid()) return@withLock false
            val next = targets.distinctBy { it.key }.sortedBy { it.at }.takeLast(40).associateByTo(linkedMapOf()) { it.key }
            val removed = active.keys - next.keys
            val canShow = background && enabled()
            val priorSeen = seen.toSet()
            val nextSeen = LinkedHashSet(seen)
            if (canShow) nextSeen.addAll(next.keys)
            while (nextSeen.size > 1000) nextSeen.remove(nextSeen.first { it !in next })
            val doc = buildJsonObject {
                put("version", 1)
                put("seen", JsonArray(nextSeen.map { JsonPrimitive(it) }))
                put("active", JsonArray(next.values.map { target -> buildJsonObject {
                    put("key", target.key); put("kind", target.kind); put("at", target.at)
                    put("extras", JsonObject(target.extras.mapValues { JsonPrimitive(it.value) }))
                } }))
            }.toString()
            val saved = doc == lastWritten || withContext(NonCancellable) { try { write(doc) } catch (_: Exception) { false } }
            removed.forEach { cancel(it); posted.remove(it) }
            if (!saved || !valid()) return@withLock false
            active = next
            seen = nextSeen
            lastWritten = doc
            if (canShow && enabled()) next.values.filter { it.key !in posted }.forEach {
                if (show(it, invalid || it.key in priorSeen)) posted.add(it.key)
            }
            invalid = false
            true
        }

    fun cancelVisible() { active.keys.forEach(cancel); posted.clear() }
}

object Notifier {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_PERMISSION = "permissions"
    const val CHANNEL_SERVICE = "service"

    fun ensureChannels(context: Context) {
        val S = stringsFor(
            context.getSharedPreferences("agent-hub", Context.MODE_PRIVATE)
                .getString("lang", "zh") ?: "zh",
        )
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_MESSAGES,
                S.notifChannelReply,
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = S.notifChannelReplyDesc },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_PERMISSION,
                S.notifChannelApproval,
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = S.notifChannelApprovalDesc },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SERVICE,
                S.notifChannelService,
                NotificationManager.IMPORTANCE_MIN,
            ).apply { description = S.notifChannelServiceDesc },
        )
    }

    fun notificationsAvailable(context: Context, channel: String): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            context.getSystemService(NotificationManager::class.java).getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE

    fun cancel(context: Context, key: String) { NotificationManagerCompat.from(context).cancel(key, key.hashCode()) }

    fun trimReplies(context: Context) {
        context.getSystemService(NotificationManager::class.java).activeNotifications
            .filter { it.tag?.startsWith("reply:") == true }.sortedByDescending { it.postTime }
            .drop(8).forEach { NotificationManagerCompat.from(context).cancel(it.tag, it.id) }
    }

    fun notify(context: Context, channel: String, title: String, text: String, id: Int,
               extras: Map<String, String> = emptyMap(), key: String? = null, silent: Boolean = false): Boolean {
        if (!notificationsAvailable(context, channel)) return false
        val intent = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
                if (key != null) data = Uri.parse("agenthub://attention").buildUpon().appendQueryParameter("key", key).build()
                extras.forEach { (k, v) -> putExtra(k, v) }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle(title)
            .setContentText(text.take(120))
            .setStyle(NotificationCompat.BigTextStyle().bigText(text.take(500)))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setSilent(silent)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(key, id, notification)
            return true
        } catch (_: SecurityException) { return false }
        catch (_: IllegalArgumentException) { return false }
    }
}
