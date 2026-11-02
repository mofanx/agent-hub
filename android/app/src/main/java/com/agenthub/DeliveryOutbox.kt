package com.agenthub

import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal fun deliveryOriginFor(address: String, token: String, publicToken: String): String {
    val identity = JsonArray(listOf(address.trim(), token, publicToken).map { JsonPrimitive(it) }).toString()
    return MessageDigest.getInstance("SHA-256").digest(identity.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

internal data class DeliveryRecord(
    val clientMessageId: String,
    val origin: String,
    val hubId: String,
    val scopeKey: String,
    val method: String,
    val params: JsonObject,
    val text: String,
    val createdAt: Long,
    val status: String = "pending",
    val deferred: Boolean = false,
    val attempted: Boolean = false,
    val replayable: Boolean = true,
    val profileLabel: String = "",
    val scopeLabel: String = "",
    val attachmentNames: List<String> = emptyList(),
    val quoteAuthor: String? = null,
    val quoteText: String? = null,
    val historyId: Long? = null,
    val error: String? = null,
    val waitUntilIdle: Boolean = false,
)

internal class DeliveryOutbox(
    private val scope: CoroutineScope,
    private val read: () -> String?,
    private val write: suspend (String) -> Boolean,
    private val rpc: suspend (String, JsonObject) -> JsonObject,
    private val validate: suspend (DeliveryRecord) -> String?,
    private val onRecord: (DeliveryRecord) -> Unit,
    private val onChange: (List<DeliveryRecord>) -> Unit,
    private val onError: (String?) -> Unit = {},
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()
    private var epoch = 0
    private var ready_ = false
    private var corrupt = false
    private var protocol_ = 0
    private var origin_: String? = null
    private var hubId_: String? = null
    private var maxAgeMs_ = 24L * 3600_000
    private var records_: List<DeliveryRecord> = emptyList()
    private val workers = mutableMapOf<String, Job>()
    private val statusQueried = mutableSetOf<String>()
    private val manualChecks = mutableSetOf<String>()
    private val wakeups = mutableSetOf<String>()

    val records: List<DeliveryRecord> get() = records_
    var error: String? = null
        private set
    val ready get() = ready_

    init { loadPersisted() }

    private fun jStr(o: JsonObject, k: String): String? =
        (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun jLong(o: JsonObject, k: String): Long? =
        (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

    private fun jBool(o: JsonObject, k: String): Boolean? =
        (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun identityKey(origin: String?, hubId: String?, scopeKey: String) =
        JsonArray(listOf(JsonPrimitive(origin), JsonPrimitive(hubId), JsonPrimitive(scopeKey))).toString()

    private fun validRecord(r: DeliveryRecord): Boolean {
        val targetKey = when (r.method) {
            "room.message" -> "roomId"
            "prompt.send" -> "sessionId"
            else -> return false
        }
        val target = jStr(r.params, targetKey)?.takeIf { it.isNotBlank() } ?: return false
        return r.clientMessageId.isNotBlank() && r.clientMessageId.length <= 200 &&
            r.origin.matches(Regex("^[a-f0-9]{64}$")) && r.hubId.isNotBlank() &&
            r.scopeKey == "${if (r.method == "room.message") "room" else "session"}:$target" &&
            jStr(r.params, "clientMessageId") == r.clientMessageId && r.createdAt > 0 &&
            r.status in setOf("pending", "sending", "uncertain", "failed", "sent")
    }

    private fun loadPersisted() {
        val raw = try { read() } catch (e: Exception) { corrupt = true; error = "storage"; onError("storage"); return }
        if (raw == null) return
        try {
            if (raw.toByteArray(Charsets.UTF_8).size > 1024 * 1024) return corruptFail()
            val doc = json.parseToJsonElement(raw).jsonObject
            if ((doc["version"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull != 1) { corrupt = true; error = "corrupt"; onError("corrupt"); return }
            val list = doc["entries"] as? JsonArray ?: run { corrupt = true; error = "corrupt"; onError("corrupt"); return }
            if (list.size > 50) { corrupt = true; error = "corrupt"; onError("corrupt"); return }
            val seen = mutableSetOf<String>()
            val scopeCounts = mutableMapOf<String, Int>()
            val restored = mutableListOf<DeliveryRecord>()
            for (el in list) {
                val o = el as? JsonObject ?: return corruptFail()
                val cid = jStr(o, "clientMessageId")?.takeIf { it.isNotBlank() && it.length <= 200 } ?: return corruptFail()
                if (!seen.add(cid)) return corruptFail()
                val origin = jStr(o, "origin")?.takeIf { it.matches(Regex("^[a-f0-9]{64}$")) } ?: return corruptFail()
                val hubId = jStr(o, "hubId")?.takeIf { it.isNotBlank() } ?: return corruptFail()
                val method = jStr(o, "method")?.takeIf { it == "room.message" || it == "prompt.send" } ?: return corruptFail()
                val scopeKey = jStr(o, "scopeKey") ?: return corruptFail()
                val params = o["params"] as? JsonObject ?: return corruptFail()
                if (jStr(params, "clientMessageId") != cid) return corruptFail()
                val expectScope = when (method) {
                    "room.message" -> "room:" + (jStr(params, "roomId")?.takeIf { it.isNotBlank() } ?: return corruptFail())
                    else -> "session:" + (jStr(params, "sessionId")?.takeIf { it.isNotBlank() } ?: return corruptFail())
                }
                if (scopeKey != expectScope) return corruptFail()
                val status = jStr(o, "status")?.takeIf { it in setOf("pending", "sending", "uncertain", "failed", "sent") } ?: return corruptFail()
                val createdAt = jLong(o, "createdAt")?.takeIf { it > 0 } ?: return corruptFail()
                val replayable = jBool(o, "replayable") ?: return corruptFail()
                val attempted = jBool(o, "attempted") ?: return corruptFail()
                val key = identityKey(origin, hubId, scopeKey)
                scopeCounts[key] = (scopeCounts[key] ?: 0) + 1
                if (scopeCounts[key]!! > 30) return corruptFail()
                if (replayable && params.toString().toByteArray(Charsets.UTF_8).size > 256 * 1024) return corruptFail()
                restored += DeliveryRecord(
                    clientMessageId = cid, origin = origin, hubId = hubId, scopeKey = scopeKey,
                    method = method, params = params,
                    text = jStr(o, "text") ?: return corruptFail(),
                    createdAt = createdAt,
                    status = if (status == "sent") "sent"
                        else if (!replayable || status == "sending" || (status == "pending" && attempted)) "uncertain" else status,
                    deferred = true,
                    attempted = attempted || !replayable || status in setOf("sending", "uncertain", "sent"),
                    replayable = replayable,
                    profileLabel = if (o["profileLabel"] == null) "" else jStr(o, "profileLabel") ?: return corruptFail(),
                    scopeLabel = if (o["scopeLabel"] == null) "" else jStr(o, "scopeLabel") ?: return corruptFail(),
                    attachmentNames = if (o["attachmentNames"] == null) emptyList()
                        else (o["attachmentNames"] as? JsonArray)?.map {
                            (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull ?: return corruptFail()
                        } ?: return corruptFail(),
                    quoteAuthor = jStr(o, "quoteAuthor"),
                    quoteText = jStr(o, "quoteText"),
                    historyId = jLong(o, "historyId")?.takeIf { it > 0 },
                    error = jStr(o, "error"),
                    waitUntilIdle = if (o["waitUntilIdle"] == null) false else jBool(o, "waitUntilIdle") ?: return corruptFail(),
                )
            }
            records_ = restored
        } catch (e: CorruptRestore) { }
        catch (e: Exception) { corrupt = true; error = "corrupt"; onError("corrupt") }
    }
    private fun corruptFail(): Nothing { corrupt = true; error = "corrupt"; onError("corrupt"); records_ = emptyList(); throw CorruptRestore() }
    private class CorruptRestore : Exception()

    private fun persistDoc(entries: List<DeliveryRecord>): JsonObject = buildJsonObject {
        put("version", 1)
        put("entries", JsonArray(entries.map { r ->
            buildJsonObject {
                put("clientMessageId", r.clientMessageId)
                put("origin", r.origin)
                put("hubId", r.hubId)
                put("scopeKey", r.scopeKey)
                put("method", r.method)
                put("params", if (r.replayable) r.params else tombstoneParams(r))
                put("text", r.text)
                put("createdAt", r.createdAt)
                put("status", r.status)
                put("deferred", r.deferred)
                put("attempted", r.attempted)
                put("replayable", r.replayable)
                put("waitUntilIdle", r.waitUntilIdle)
                put("profileLabel", r.profileLabel)
                put("scopeLabel", r.scopeLabel)
                put("attachmentNames", JsonArray(r.attachmentNames.map { JsonPrimitive(it) }))
                if (r.quoteAuthor != null) put("quoteAuthor", r.quoteAuthor)
                if (r.quoteText != null) put("quoteText", r.quoteText.take(300))
                if (r.historyId != null) put("historyId", r.historyId)
                if (r.error != null) put("error", r.error)
            }
        }))
    }

    private fun tombstoneParams(r: DeliveryRecord): JsonObject = buildJsonObject {
        val keep = setOf("roomId", "sessionId", "clientMessageId", "expectedFlowId", "expectedMissionId", "expectedFlowState", "expectedRoomMode", "intent", "replyTo")
        r.params.forEach { (k, v) -> if (keep.contains(k)) put(k, v) }
    }

    private fun fail(reason: String): Boolean {
        error = reason
        onError(reason)
        return false
    }

    private suspend fun persist(next: List<DeliveryRecord> = records_): Boolean {
        if (corrupt) return fail(error ?: "corrupt")
        val raw = persistDoc(next).toString()
        if (raw.toByteArray(Charsets.UTF_8).size > 1024 * 1024) return fail("full")
        val ok = withContext(NonCancellable) {
            try { write(raw) } catch (_: Exception) { false }
        }
        if (!ok) return fail("storage")
        records_ = next
        error = null
        onError(null)
        onChange(records_)
        return true
    }

    private fun current(gen: Int, o: String?, h: String?): Boolean =
        gen == epoch && ready_ && scope.isActive && o == origin_ && h == hubId_

    private fun head(o: String?, h: String?, scopeKey: String): DeliveryRecord? =
        records_.firstOrNull {
            it.origin == o && it.hubId == h && it.scopeKey == scopeKey &&
                it.status != "sent" && it.status != "dismissed"
        }

    private fun replace(record: DeliveryRecord) =
        records_.map { if (it.clientMessageId == record.clientMessageId) record else it }

    fun select(origin: String?): Job {
        val parked = pause()
        origin_ = origin?.takeIf { it.matches(Regex("^[a-f0-9]{64}$")) }
        hubId_ = null
        protocol_ = 0
        return parked
    }

    fun bind(hubId: String?, protocol: Int, maxAgeMs: Long) {
        val id = hubId?.takeIf { it.isNotBlank() }
        val version = if (protocol == 1 && maxAgeMs > 0) 1 else 0
        if (id != hubId_ || version != protocol_) pause()
        hubId_ = id
        protocol_ = version
        maxAgeMs_ = if (maxAgeMs > 0) minOf(maxAgeMs, 24L * 3600_000) else 24L * 3600_000
    }

    fun pause(): Job {
        val parkedIds = records_.map { it.clientMessageId }.toSet()
        epoch++
        ready_ = false
        workers.values.forEach { it.cancel() }
        workers.clear()
        wakeups.clear()
        statusQueried.clear()
        manualChecks.clear()
        return CoroutineScope(scope.coroutineContext.minusKey(Job)).launch {
            mutex.withLock {
                val before = records_
                val next = before.map { r ->
                    if (r.clientMessageId !in parkedIds) r else when (r.status) {
                        "sending" -> r.copy(status = "uncertain", attempted = true, deferred = true)
                        "pending" -> r.copy(deferred = true)
                        else -> r
                    }
                }
                if (next != before) {
                    if (!persist(next)) { records_ = next; onChange(records_) }
                    next.filterIndexed { index, r -> r != before[index] }.forEach(onRecord)
                }
            }
        }
    }

    fun resume() {
        ready_ = scope.isActive && !corrupt && protocol_ == 1 && !hubId_.isNullOrBlank() && origin_ != null
        if (ready_) pokeCurrent()
    }

    private fun pokeCurrent() {
        records_.filter { it.origin == origin_ && it.hubId == hubId_ }
            .map { it.scopeKey }.toSet()
            .forEach { drain(it) }
    }

    private fun wkey(scopeKey: String) = identityKey(origin_, hubId_, scopeKey)

    private fun drain(scopeKey: String) {
        if (!ready_ || !scope.isActive) return
        val key = wkey(scopeKey)
        workers[key]?.takeIf { it.isActive }?.let { wakeups.add(key); return }
        val gen = epoch
        val o = origin_; val h = hubId_
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var inFlight: DeliveryRecord? = null
            try {
                while (current(gen, o, h)) {
                    val first = mutex.withLock { head(o, h, scopeKey) } ?: break
                    val manual = manualChecks.remove(first.clientMessageId)
                    if (first.status == "failed" && !(manual && first.attempted)) break
                    if (first.attempted || first.status in setOf("uncertain", "sending")) {
                        val queryKey = "$gen:${first.clientMessageId}"
                        if (!manual && queryKey in statusQueried) break
                        statusQueried.add(queryKey)
                        if (statusQuery(first, gen, o, h)) continue else break
                    }
                    if (first.status != "pending") break
                    val age = now() - first.createdAt
                    if (age < 0 || age > maxAgeMs_ || (!first.replayable && first.deferred)) {
                        mutex.withLock {
                            if (current(gen, o, h) && head(o, h, scopeKey) == first) {
                                val expired = first.copy(status = "failed",
                                    error = if (!first.replayable && first.deferred) "attachments" else "expired")
                                if (persist(replace(expired))) onRecord(expired)
                            }
                        }
                        break
                    }
                    val verdict = try { validate(first) }
                        catch (e: CancellationException) { throw e }
                        catch (_: Exception) { "unavailable" }
                    var blocked = false
                    val r = mutex.withLock {
                        if (!current(gen, o, h) || head(o, h, scopeKey) != first) return@withLock null
                        if (verdict != null) {
                            blocked = true
                            val updated = if (verdict in setOf("busy", "unavailable"))
                                first.copy(deferred = true, error = if (verdict == "busy") null else verdict)
                            else first.copy(status = "failed", error = verdict)
                            if (persist(replace(updated))) onRecord(updated)
                            return@withLock null
                        }
                        val sending = first.copy(status = "sending", attempted = true, error = null)
                        if (!persist(replace(sending))) { blocked = true; return@withLock null }
                        inFlight = sending
                        onRecord(sending)
                        sending
                    }
                    if (r == null) { if (blocked) break else continue }
                    if (!current(gen, o, h)) break
                    var response: JsonObject? = null
                    var rejected = false
                    try { response = rpc(r.method, r.params) }
                    catch (e: CancellationException) { throw e }
                    catch (_: HubRpcException) { rejected = true }
                    catch (_: Exception) { }
                    val accepted = mutex.withLock {
                        if (!current(gen, o, h) || records_.none {
                            it.clientMessageId == r.clientMessageId && it.status == "sending"
                        }) return@withLock false
                        if (jStr(response ?: JsonObject(emptyMap()), "deliveryStatus") == "accepted") {
                            accept(r, response?.let { jLong(it, "historyId") })
                            true
                        } else {
                            fact(r.copy(status = if (rejected) "failed" else "uncertain",
                                error = if (rejected) "context" else null))
                            false
                        }
                    }
                    inFlight = null
                    if (!accepted) break
                }
            } finally {
                withContext(NonCancellable) {
                    mutex.withLock {
                        inFlight?.let { old ->
                            records_.firstOrNull { it.clientMessageId == old.clientMessageId &&
                                it.origin == o && it.hubId == h && it.status == "sending" }
                                ?.let { fact(it.copy(status = "uncertain", deferred = true)) }
                        }
                    }
                }
                val owned = workers.remove(key, coroutineContext[Job])
                val first = head(o, h, scopeKey)
                if (owned && current(gen, o, h)) {
                    val requested = wakeups.remove(key)
                    if (first != null && (requested || first.clientMessageId in manualChecks)) drain(scopeKey)
                }
            }
        }
        workers[key] = job
        job.start()
    }

    private suspend fun fact(record: DeliveryRecord) {
        records_ = replace(record)
        onRecord(record)
        onChange(records_)
        persist()
    }

    private suspend fun accept(record: DeliveryRecord, historyId: Long?) {
        val done = record.copy(status = "sent", historyId = historyId?.takeIf { it > 0 }, error = null)
        records_ = replace(done)
        onRecord(done)
        onChange(records_)
        persist(records_.filter { it.status != "sent" })
    }

    private suspend fun statusQuery(head: DeliveryRecord, gen: Int, o: String?, h: String?): Boolean {
        val target = buildJsonObject {
            put("method", head.method)
            if (head.method == "room.message") put("roomId", jStr(head.params, "roomId") ?: "") else put("sessionId", jStr(head.params, "sessionId") ?: "")
            put("clientMessageId", head.clientMessageId)
        }
        var ds: String? = null
        var hid: Long? = null
        try {
            val res = rpc("client.message.status", target)
            ds = res["deliveryStatus"]?.jsonPrimitive?.contentOrNull
            hid = res["historyId"]?.jsonPrimitive?.longOrNull
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { }
        return mutex.withLock {
            if (!current(gen, o, h)) return@withLock false
            val cur = records_.firstOrNull { it.clientMessageId == head.clientMessageId } ?: return@withLock false
            if (ds == "accepted") {
                accept(cur, hid)
                true
            } else {
                if (cur.status != "uncertain") {
                    fact(cur.copy(status = "uncertain", attempted = true))
                }
                false
            }
        }
    }

    suspend fun enqueue(record: DeliveryRecord): Boolean {
        mutex.withLock {
            if (corrupt) return fail(error ?: "corrupt")
            if (!scope.isActive || protocol_ != 1 || hubId_.isNullOrBlank() ||
                record.origin != origin_ || record.hubId != hubId_) return fail("unsupported")
            if (record.replayable && record.params.toString().toByteArray(Charsets.UTF_8).size > 256 * 1024)
                return fail("full")
            if (!validRecord(record) || record.status != "pending" || record.attempted ||
                records_.any { it.clientMessageId == record.clientMessageId }) return fail("context")
            val before = records_.filter { it.status != "sent" }
            val earlier = before.any {
                it.origin == record.origin && it.hubId == record.hubId && it.scopeKey == record.scopeKey
            }
            if (!record.replayable && (!ready_ || earlier || record.deferred)) return fail("attachments")
            if (before.size >= 50 || before.count {
                it.origin == record.origin && it.hubId == record.hubId && it.scopeKey == record.scopeKey
            } >= 30) return fail("full")
            val frozen = record.copy(
                params = json.parseToJsonElement(record.params.toString()).jsonObject,
                attachmentNames = record.attachmentNames.toList(),
                deferred = record.deferred || !ready_ || earlier,
            )
            val next = before + frozen
            if (next.sumOf { it.params.toString().toByteArray(Charsets.UTF_8).size.toLong() } > 64L * 1024 * 1024)
                return fail("full")
            val acceptedEpoch = epoch
            if (!persist(next)) return false
            val accepted = if (acceptedEpoch == epoch) frozen else frozen.copy(deferred = true)
            if (accepted != frozen) {
                if (!persist(replace(accepted))) {
                    records_ = replace(accepted)
                    onChange(records_)
                }
            }
            onRecord(accepted)
        }
        drain(record.scopeKey)
        return true
    }

    fun check(cid: String) {
        if (!ready_ || !scope.isActive) return
        val r = records_.firstOrNull { it.clientMessageId == cid && it.origin == origin_ && it.hubId == hubId_ } ?: return
        if (r.status == "sending" || (!r.attempted && r.status != "uncertain")) return
        manualChecks.add(cid)
        drain(r.scopeKey)
    }

    suspend fun dismiss(cid: String, includeParked: Boolean = false): Boolean =
        dismissMany(setOf(cid), includeParked)

    suspend fun dismissMany(cids: Set<String>, includeParked: Boolean = false): Boolean =
        mutex.withLock l@{
            if (corrupt) return@l fail(error ?: "corrupt")
            if (cids.isEmpty()) return@l false
            val hits = records_.filter { cids.contains(it.clientMessageId) && (includeParked || (it.origin == origin_ && it.hubId == hubId_)) }
            if (hits.size != cids.size) return@l false
            if (hits.any { it.status == "sending" }) return@l false
            val removed = hits.map { it.clientMessageId }.toSet()
            val scopes = hits.map { it.scopeKey }.toSet()
            if (!persist(records_.filter { !removed.contains(it.clientMessageId) })) return@l false
            manualChecks.removeAll(removed)
            hits.forEach { onRecord(it.copy(status = "dismissed")) }
            scopes.forEach { drain(it) }
            true
        }
}

internal class DeliveryRecovery(
    private val rpc: suspend (String, JsonObject) -> JsonObject,
    private val applyRows: (String, List<JsonObject>, Boolean, Boolean) -> Unit,
    private val applyRoom: (String, JsonObject) -> Unit,
    private val knownCards: (String) -> List<Long>,
    private val beforeReset: (String) -> Unit,
) {
    private class State {
        val mutex = Mutex()
        var cursor = 0L
        var revision = 0
        val drafts = mutableSetOf<Long>()
    }
    private val states = mutableMapOf<String, State>()

    fun clear() = states.clear()
    fun forget(key: String) { states.remove(key) }
    fun changed(key: String) { states.getOrPut(key) { State() }.revision++ }
    fun cursor(key: String) = states[key]?.cursor ?: 0L
    fun retainDrafts(key: String, ids: Set<Long>) { states[key]?.drafts?.retainAll(ids) }

    private fun rows(response: JsonObject, field: String = "entries"): List<JsonObject> =
        (response[field] as? JsonArray)?.map { it.jsonObject } ?: error("history_sync_invalid")

    private fun rowId(row: JsonObject) =
        (row["id"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it > 0 }
            ?: error("history_sync_invalid")

    fun remember(key: String, rows: List<JsonObject>, baseline: Boolean = false, advance: Boolean = false) {
        val state = states.getOrPut(key) { State() }
        val max = rows.maxOfOrNull { rowId(it) } ?: 0L
        if (advance || (baseline && state.cursor == 0L)) state.cursor = maxOf(state.cursor, max)
        rows.forEach { row ->
            when ((row["draft"] as? JsonPrimitive)?.intOrNull) {
                1 -> state.drafts.add(rowId(row))
                0 -> state.drafts.remove(rowId(row))
            }
        }
    }

    suspend fun recover(key: String, protocol: Int, valid: () -> Boolean): JsonObject? {
        val scope = key.substringBefore(':')
        val id = key.substringAfter(':', "")
        require(scope in setOf("room", "session") && id.isNotBlank())
        val state = states.getOrPut(key) { State() }
        return state.mutex.withLock {
            fun checkCurrent() {
                if (!valid() || states[key] !== state) throw CancellationException("recovery_stale")
            }
            fun params(cursor: Long? = null) = buildJsonObject {
                put("${scope}Id", id)
                put("limit", 500)
                if (cursor != null) put("afterId", cursor)
            }
            val cards = mutableSetOf<Long>()
            fun apply(batch: List<JsonObject>, reset: Boolean, revision: Int) {
                batch.filter { (it["kind"] as? JsonPrimitive)?.contentOrNull in setOf("flow", "decision") }
                    .forEach { cards.add(rowId(it)) }
                applyRows(key, batch, reset, revision == state.revision)
            }
            checkCurrent()
            if (state.cursor == 0L) {
                val revision = state.revision
                val response = rpc("$scope.history", params())
                checkCurrent()
                val batch = rows(response)
                val max = batch.maxOfOrNull { rowId(it) } ?: 0L
                apply(batch, false, revision)
                remember(key, batch)
                state.cursor = if (state.cursor == 0L) max else minOf(state.cursor, max)
            }
            while (true) {
                checkCurrent()
                val cursor = state.cursor
                val revision = state.revision
                val response = rpc("$scope.history", params(cursor))
                checkCurrent()
                if ((response["truncated"] as? JsonPrimitive)?.booleanOrNull == true) {
                    if (cursor == 0L) error("history_sync_truncated")
                    beforeReset(key)
                    val full = mutableListOf<JsonObject>()
                    var after = 0L
                    while (true) {
                        val page = rpc("$scope.history", params(after))
                        checkCurrent()
                        if ((page["truncated"] as? JsonPrimitive)?.booleanOrNull == true) error("history_sync_truncated")
                        val batch = rows(page)
                        val last = batch.maxOfOrNull { rowId(it) } ?: after
                        full.addAll(batch)
                        if ((page["hasMore"] as? JsonPrimitive)?.booleanOrNull != true) break
                        if (last <= after) error("history_cursor_stalled")
                        after = last
                    }
                    state.cursor = 0L
                    state.drafts.clear()
                    apply(full, true, revision)
                    remember(key, full, advance = true)
                    break
                }
                val batch = rows(response)
                val last = batch.maxOfOrNull { rowId(it) } ?: cursor
                apply(batch, false, revision)
                remember(key, batch, advance = true)
                if ((response["hasMore"] as? JsonPrimitive)?.booleanOrNull != true) break
                if (last <= cursor) error("history_cursor_stalled")
            }
            for (ids in state.drafts.toList().chunked(200)) {
                val revision = state.revision
                val response = rpc("$scope.history", buildJsonObject {
                    put("${scope}Id", id)
                    put("entryIds", JsonArray(ids.map { JsonPrimitive(it) }))
                })
                checkCurrent()
                val batch = rows(response)
                if (!batch.map { rowId(it) }.containsAll(ids)) error("history_draft_unavailable")
                apply(batch, false, revision)
                remember(key, batch)
            }
            val ids = (knownCards(key) + cards).distinct().filter { it > 0 }
            if (scope != "room") {
                for (chunk in ids.chunked(200)) {
                    val revision = state.revision
                    val response = rpc("$scope.history", buildJsonObject {
                        put("${scope}Id", id)
                        put("entryIds", JsonArray(chunk.map { JsonPrimitive(it) }))
                    })
                    checkCurrent()
                    apply(rows(response), false, revision)
                }
                return@withLock null
            }
            var snapshot: JsonObject? = null
            for (chunk in ids.chunked(200).ifEmpty { listOf(emptyList()) }) {
                var applied = false
                for (attempt in 0 until 3) {
                    val revision = state.revision
                    val response = rpc(if (protocol == 1) "room.sync" else "room.flow", buildJsonObject {
                        put("roomId", id)
                        put("ifcAuthorized", true)
                        if (protocol == 1) put("knownCardIds", JsonArray(chunk.map { JsonPrimitive(it) }))
                    })
                    checkCurrent()
                    if (revision != state.revision) continue
                    if (response["flow"] == null) error("history_snapshot_invalid")
                    applyRoom(key, response)
                    if (protocol == 1) apply(rows(response, "cards"), false, revision)
                    snapshot = response
                    applied = true
                    break
                }
                if (!applied) error("recovery_snapshot_stale")
            }
            snapshot
        }
    }
}
