package com.agenthub

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 非活跃 profile 的 global 层后台链路状态：低频事件订阅 + attention 徽章快照 */
internal class HubLink(
    val key: String,
    val client: HubClient,
) {
    var generation = 0
    var ready = false
    var unsupported = false
    var connected = false
    var url = ""
    var publicToken = ""
    var origin = ""
    var hubId: String? = null
    var lastSyncAt = 0L
    val flows = mutableMapOf<String, JsonObject?>()
    val flowRevisions = mutableMapOf<String, Int>()
    val decisions = mutableMapOf<String, JsonObject>()
    var decisionRevision = 0
    var syncJob: Job? = null
    var retryJob: Job? = null
}

internal data class LinkTarget(
    val key: String,
    val url: String,
    val publicToken: String,
    val origin: String,
)

/** 链路徽章：目标清单 + 链路在线态（hubId 持久不随断连清除，connected 必须单独带） */
internal data class LinkBadge(
    val targets: List<AttentionTarget>,
    val connected: Boolean,
)

/** profiles → 非活跃链路选择：活跃 profile 不占名额，超限按 MRU 取前 maxLinks */
internal fun selectLinkKeys(
    profileKeys: List<String>,
    activeKey: String?,
    mru: List<String>,
    maxLinks: Int,
): List<String> {
    val candidates = profileKeys.filter { it != activeKey }
    if (candidates.size <= maxLinks) return candidates
    val rank = mru.withIndex().associate { it.value to it.index }
    return candidates.sortedBy { rank[it] ?: Int.MAX_VALUE }.take(maxLinks)
}

/**
 * 多 hub 后台链路管理：每个非活跃 profile 一条独立 HubClient（各自退避重连），
 * 订阅 global 层事件维护 attention 徽章；徽章经 badges StateFlow 供 ViewModel 消费。
 */
internal class HubLinkManager(
    private val scope: CoroutineScope,
    private val newClient: () -> HubClient,
    private val maxLinks: Int = DEFAULT_MAX_LINKS,
    private val staggerMs: Long = 250,
    private val retryMs: Long = 30_000,
) {
    private val links = LinkedHashMap<String, HubLink>()
    private var destroyed = false
    private val _badges = MutableStateFlow<Map<String, LinkBadge>>(emptyMap())
    val badges = _badges.asStateFlow()
    private var networkId: Long? = null

    /** 网络变化扇出：service 的 NetworkReconnectMonitor 回调转发到每条链路 */
    fun onNetworkChanged(id: Long?) {
        networkId = id
        links.values.forEach { it.client.onNetworkChanged(id) }
    }

    val size: Int get() = links.size
    fun link(key: String): HubLink? = links[key]

    /** 目标集合对账：多余/配置变更链路关闭，缺失链路错峰启动（活跃 profile 不占名额） */
    fun reconcile(targets: List<LinkTarget>, activeKey: String?, mru: List<String>) {
        if (destroyed) return
        val keep = selectLinkKeys(targets.map { it.key }, activeKey, mru, maxLinks).toSet()
        val wanted = LinkedHashMap<String, LinkTarget>()
        for (t in targets) if (t.key in keep) wanted[t.key] = t
        for (key in links.keys.toList()) {
            val link = links[key] ?: continue
            val target = wanted[key]
            if (target == null || target.url != link.url ||
                target.publicToken != link.publicToken || target.origin != link.origin) {
                closeLink(key)
            }
        }
        var index = 0
        for ((key, target) in wanted) {
            if (links.containsKey(key)) continue
            startLink(target, index++)
        }
    }

    fun closeAll() {
        destroyed = true
        for (key in links.keys.toList()) closeLink(key)
    }

    /** 显式断开单条链路（下次 reconcile 按目标集对账仍可能重建——调用方自行负责目标集语义） */
    fun close(key: String) {
        closeLink(key)
    }

    private fun closeLink(key: String) {
        val link = links.remove(key) ?: return
        link.syncJob?.cancel()
        link.retryJob?.cancel()
        link.client.onEvent = null
        link.client.onClosed = null
        link.client.disconnect()
        publishBadges()
    }

    private fun startLink(target: LinkTarget, index: Int) {
        val client = newClient()
        val link = HubLink(target.key, client).also {
            it.url = target.url
            it.publicToken = target.publicToken
            it.origin = target.origin
        }
        links[target.key] = link
        fun current() = !destroyed && links[target.key] === link
        client.onEvent = { obj -> if (current()) handleLinkEvent(link, obj) }
        client.onClosed = { if (current()) onLinkDisconnected(link) }
        networkId?.let { client.onNetworkChanged(it) }
        // 错峰启动防重连风暴：同批链路按序间隔 staggerMs；各 client 自身仍有独立退避
        scope.launch {
            if (staggerMs > 0 && index > 0) delay(staggerMs * index)
            if (!current()) return@launch
            client.connect(target.url, target.publicToken,
                onOpen = {
                    if (current()) {
                        link.connected = true
                        publishBadges()
                        scope.launch {
                            try {
                                client.call("client.subscribe", buildJsonObject { put("tier", "global") })
                            } catch (_: Exception) { }
                        }
                        syncLink(link)
                    }
                },
                onFailure = { if (current()) onLinkDisconnected(link) })
        }
    }

    private fun onLinkDisconnected(link: HubLink) {
        if (destroyed) return
        link.connected = false
        link.ready = false
        link.generation++
        link.syncJob?.cancel()
        link.retryJob?.cancel()
        publishBadges()
    }

    private fun publishBadges() {
        val map = LinkedHashMap<String, LinkBadge>()
        for ((key, link) in links) {
            val targets = link.hubId?.let {
                attentionTargets(link.origin, it, link.flows, link.decisions.values.toList())
            } ?: emptyList()
            map[key] = LinkBadge(targets, link.connected)
        }
        _badges.value = map
    }

    private fun syncLink(link: HubLink) {
        if (link.syncJob?.isActive == true || link.unsupported) return
        link.retryJob?.cancel()
        val gen = ++link.generation
        fun valid() = !destroyed && links[link.key] === link && link.connected && gen == link.generation
        link.syncJob = scope.launch {
            repeat(3) { attempt ->
                try {
                    val info = link.client.call("agent.info")
                    if (!valid()) return@launch
                    val id = (info["hubId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotBlank() }
                        ?: error("attention_binding_unavailable")
                    if (link.hubId != null && link.hubId != id) {
                        link.flows.clear(); link.decisions.clear(); link.flowRevisions.clear()
                    }
                    link.hubId = id
                    val beforeList = link.flowRevisions.toMap()
                    val rooms = link.client.call("room.list")["rooms"] as? JsonArray ?: error("attention_rooms_invalid")
                    if (!valid()) return@launch
                    val ids = rooms.map { it.jsonObject["roomId"]!!.jsonPrimitive.content }.toSet()
                    link.flows.keys.toList().filter { it !in ids && link.flowRevisions[it] == beforeList[it] }
                        .forEach { link.flows.remove(it); link.flowRevisions.remove(it) }
                    val limit = Semaphore(4)
                    coroutineScope {
                        ids.map { roomId -> async {
                            limit.withPermit {
                                val revision = link.flowRevisions[roomId] ?: 0
                                val response = link.client.call("room.flow", buildJsonObject { put("roomId", roomId) })
                                if (!valid()) throw CancellationException("attention_stale")
                                require(response["flow"] == kotlinx.serialization.json.JsonNull || response["flow"] is JsonObject)
                                if ((link.flowRevisions[roomId] ?: 0) == revision) {
                                    link.flows[roomId] = attentionFlow(response["flow"] as? JsonObject)
                                }
                            }
                        } }.awaitAll()
                    }
                    val revision = link.decisionRevision
                    val decisions = link.client.call("decision.list")["decisions"] as? JsonArray ?: error("attention_decisions_invalid")
                    if (!valid()) return@launch
                    if (revision != link.decisionRevision) error("attention_snapshot_stale")
                    link.decisions.clear()
                    decisions.forEach { value ->
                        val o = value.jsonObject
                        link.decisions[o["decisionId"]!!.jsonPrimitive.content] = attentionDecision(o)
                    }
                    link.ready = true
                    link.lastSyncAt = System.currentTimeMillis()
                    publishBadges()
                    return@launch
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    if (!valid()) return@launch
                    if (e.message == "attention_binding_unavailable" ||
                        e.message?.contains("unknown method", ignoreCase = true) == true ||
                        e.message?.contains("-32601") == true) {
                        link.unsupported = true
                        return@launch
                    }
                    if (attempt < 2) delay(500L * (attempt + 1))
                }
            }
            link.retryJob = scope.launch {
                delay(retryMs)
                if (valid() && !link.ready) syncLink(link)
            }
        }
    }

    private fun handleLinkEvent(link: HubLink, obj: JsonObject) {
        when ((obj["method"] as? JsonPrimitive)?.contentOrNull) {
            "room.flowUpdate" -> {
                val p = obj["params"] as? JsonObject ?: return
                val rid = (p["roomId"] as? JsonPrimitive)?.contentOrNull ?: return
                link.flowRevisions[rid] = (link.flowRevisions[rid] ?: 0) + 1
                link.flows[rid] = attentionFlow(p["flow"] as? JsonObject)
                publishBadges()
            }
            "decision.update" -> {
                val p = obj["params"] as? JsonObject ?: return
                val entry = p["entry"] as? JsonObject ?: return
                val meta = runCatching {
                    Json.parseToJsonElement(entry["text"]!!.jsonPrimitive.content).jsonObject
                }.getOrNull() ?: return
                val did = (meta["decisionId"] as? JsonPrimitive)?.contentOrNull ?: return
                link.decisionRevision++
                if (meta["status"]?.jsonPrimitive?.contentOrNull == "pending") {
                    link.decisions[did] = attentionDecision(meta)
                } else {
                    link.decisions.remove(did)
                }
                publishBadges()
            }
        }
        if (!link.ready && link.connected && link.syncJob?.isActive != true) syncLink(link)
    }

    companion object {
        const val DEFAULT_MAX_LINKS = 3
    }
}
