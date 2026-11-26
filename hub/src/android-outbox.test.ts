import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("Android MissionDraftCards 仅在 isLast 块渲染一次", () => {
  const ui = fs.readFileSync(path.join(root, "android/app/src/main/java/com/agenthub/ui/ChatScreen.kt"), "utf8");
  const start = ui.indexOf("MissionDraftCards(item.text");
  assert.ok(start > 0, "MissionDraftCards 调用点存在");
  const before = ui.slice(Math.max(0, start - 120), start);
  assert.match(before, /if \(item\.isLast\)/, "须以 item.isLast 守卫");
  const count = (ui.match(/MissionDraftCards\(item\.text/g) || []).length;
  assert.equal(count, 1, "每个 MessageBlock 只允许一处调用");
});

test("Android 任务产物标签换行并限制单行，避免窄标签撑出整屏空白", () => {
  const ui = fs.readFileSync(path.join(root, "android/app/src/main/java/com/agenthub/ui/ChatScreen.kt"), "utf8");
  const start = ui.indexOf("if (task.artifacts.isNotEmpty())", ui.indexOf("private fun FlowTaskRow("));
  const artifacts = ui.slice(start, ui.indexOf("private fun ArtifactPanel(", start));
  assert.match(artifacts, /FlowRow\(/);
  assert.match(artifacts, /maxLines = 1/);
  assert.match(artifacts, /overflow = TextOverflow\.Ellipsis/);
});

const cases = [
  "durability", "fifo", "uncertain_autoresolve", "identity_fences", "dismiss_and_bulk",
  "context_and_busy", "codec", "bounds_and_snapshot", "attachment_tombstone",
  "receipt_cleanup_failure", "lifecycle_and_fast_worker", "expiry_and_protocol",
  "recovery_watermarks", "recovery_reset_and_draft", "recovery_fences",
  "recovery_tail_reset_order", "recovery_refresh_false", "recovery_tail_stale_no_callback",
  "viewmodel_context", "viewmodel_payload", "session_cards",
  "attention_identity", "attention_recovery", "attention_limits",
  "viewmodel_anchor", "stream_scope", "timeline",
  "recovery_mutable_entries", "recovery_dedupe_draft150", "recovery_cursor_isolation",
  "recovery_loadmore_viewseq", "recovery_concurrent_afterreset", "recovery_compact_completed_local", "recovery_race_tail_process_done", "recovery_race_targeted_entryids", "recovery_race_initial_anchor",
];

function cachedJar(group: string, name: string, version: string): string | undefined {
  const folder = path.join(process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), ".gradle"),
    "caches", "modules-2", "files-2.1", group, name, version);
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder)) {
    const file = path.join(folder, entry, `${name}-${version}.jar`);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
}

test("Android sender wiring: durable acceptance, recovery gate, original bubbles, bilingual actions", () => {
  const native = path.join(root, "android/app/src/main/java/com/agenthub");
  const vm = fs.readFileSync(path.join(native, "ChatViewModel.kt"), "utf8");
  const ui = fs.readFileSync(path.join(native, "ui/ChatScreen.kt"), "utf8");
  const strings = fs.readFileSync(path.join(native, "ui/Strings.kt"), "utf8");
  const init = vm.slice(vm.lastIndexOf("\n    init {"));
  assert.ok(init.indexOf("delivery = DeliveryOutbox(") < init.indexOf("prefs.registerOnSharedPreferenceChangeListener"));
  const recovery = vm.slice(vm.indexOf("private fun startDeliveryRecovery("), vm.indexOf("data class HubBadge"));
  assert.ok(recovery.indexOf("syncRefreshAll(") < recovery.indexOf("recoverScope(key)"));
  assert.ok(recovery.indexOf("recoverScope(key)") < recovery.indexOf("deliveryReady = true"));
  assert.ok(recovery.indexOf("deliveryReady = true") < recovery.indexOf("delivery.resume()"));
  const sender = vm.slice(vm.indexOf("private fun submitDelivery("), vm.indexOf("fun sendPrompt("));
  assert.ok(sender.indexOf("val originalFlow =") < sender.indexOf("prepareMessageContent("));
  assert.ok(sender.indexOf("if (!delivery.enqueue(record))") < sender.indexOf("consumeComposition("));
  assert.ok(sender.indexOf("consumeComposition(") < sender.indexOf("onAccepted?.invoke()", sender.indexOf("consumeComposition(")));
  assert.doesNotMatch(vm, /class OutboxEntry|messageQueue|drainOutbox|e\.state = if \(sent\)/);
  assert.match(vm, /clientMessageId == record\.clientMessageId/);
  assert.match(vm, /original\.copy\(historyId = id, historyAt = parsed\.at, at = parsed\.at\)/);
  assert.match(ui, /ChatItem\.User\)\?\.historyId == targetId/);
  assert.match(ui, /vm\.composerKey\(\) == key && input == before/);
  assert.doesNotMatch(ui, /vm\.send(?:RoomMessage|Prompt)\(input\.trim\(\)\)\s*\n\s*input = ""/);
  assert.match(ui, /enabled = record\.status != "sending"/);
  const maps = [...strings.matchAll(/override val deliveryLabels = mapOf\(([\s\S]*?)\n    \)/g)];
  assert.equal(maps.length, 2);
  const keys = (body: string) => [...body.matchAll(/"([^"]+)" to /g)].map((m) => m[1]).sort();
  assert.deepEqual(keys(maps[0]![1]!), keys(maps[1]![1]!));
  const attentionMaps = [...strings.matchAll(/override val attentionLabels = mapOf\(([\s\S]*?)\n    \)/g)];
  assert.equal(attentionMaps.length, 2);
  assert.deepEqual(keys(attentionMaps[0]![1]!), keys(attentionMaps[1]![1]!));
  assert.doesNotMatch(vm, /Notifier\.notify|attentionNotified|recomputeAttention/);
  const nav = vm.slice(vm.indexOf("fun openAttentionTarget("), vm.indexOf("private suspend fun syncRefreshAll("));
  assert.ok(nav.indexOf("pendingAttention = extras.toMap()") < nav.indexOf("if (!deliveryReady) return"));
  assert.ok(nav.indexOf("if (!deliveryReady) return") < nav.indexOf("rooms.find"));
  assert.match(nav, /readOnly = true/);
  assert.match(nav, /dispatchedAt = target\["navDispatchedAt"\]/);
  const service = fs.readFileSync(path.join(native, "HubService.kt"), "utf8");
  assert.doesNotMatch(service.slice(service.indexOf("private fun handleEvent("), service.indexOf('when ((obj["method"]')), /appForeground/);
  assert.match(service, /"decision\.update" ->/);
  assert.match(service, /"room\.flowUpdate" ->/);
  const save = vm.slice(vm.indexOf("private fun saveCurrentScope("), vm.indexOf("private fun restoreScopeCounts("));
  assert.ok(save.indexOf("flushStreamChunks()") < save.indexOf("chatCache[key] ="));
  assert.match(vm, /withLiveItems \{ handleEventNow\(obj\) \}/);
});

test("Android Outbox: actual Kotlin persistence and delivery state machine", { timeout: 150_000 }, (t) => {
  const versions = fs.readFileSync(path.join(root, "android", "gradle", "libs.versions.toml"), "utf8");
  const version = (key: string) => {
    const match = versions.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
    assert.ok(match, `missing Android version: ${key}`);
    return match[1]!;
  };
  const artifacts = [
    ["org.jetbrains.kotlin", "kotlin-stdlib", version("kotlin")],
    ["org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.11.0"],
    ["org.jetbrains.kotlinx", "kotlinx-serialization-core-jvm", version("serialization")],
    ["org.jetbrains.kotlinx", "kotlinx-serialization-json-jvm", version("serialization")],
    ["com.squareup.okhttp3", "okhttp", version("okhttp")],
    ["com.squareup.okio", "okio-jvm", "3.6.0"],
    ["org.jetbrains", "annotations", "23.0.0"],
    ["org.jetbrains.kotlin", "kotlin-compiler-embeddable", version("kotlin")],
    ["org.jetbrains.kotlin", "kotlin-reflect", "2.3.20"],
  ];
  const jars = artifacts.map(([group, name, v]) => cachedJar(group!, name!, v!));
  const missing = artifacts.filter((_, i) => !jars[i]);
  if (missing.length) {
    t.skip(`cached Android JVM toolchain unavailable: ${missing.map((a) => a.join(":")).join(", ")}`);
    return;
  }
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-android-outbox-"));
  if (!process.env.KEEP_BRIDGE) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = jars.slice(0, 7).join(path.delimiter);
  const output = path.join(directory, "out");
  const strings = path.join(directory, "Strings.kt");
  const fixture = path.join(directory, "Test.kt");
  const bridge = path.join(directory, "Bridge.kt");
  const attention = path.join(directory, "Attention.kt");
  const notifier = fs.readFileSync(path.join(root, "android/app/src/main/java/com/agenthub/Notifier.kt"), "utf8");
  const pure = notifier.slice(notifier.indexOf("internal data class AttentionTarget"), notifier.indexOf("object Notifier"));
  assert.ok(pure.includes("internal class AttentionLedger"));
  fs.writeFileSync(attention, "package com.agenthub\nimport kotlinx.serialization.json.*\n" +
    "import kotlinx.coroutines.NonCancellable\nimport kotlinx.coroutines.withContext\n" +
    "import kotlinx.coroutines.sync.Mutex\nimport kotlinx.coroutines.sync.withLock\n" + pure);
  const perfTrace = path.join(directory, "PerfTrace.kt");
  fs.writeFileSync(perfTrace, "package com.agenthub\ninternal object PerfTrace { fun mark(event: String, extra: String = \"\") {} }\n");
  const vm = fs.readFileSync(path.join(root, "android/app/src/main/java/com/agenthub/ChatViewModel.kt"), "utf8");
  const section = (from: string, to: string) => {
    const a = vm.indexOf(from), b = vm.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `missing native bridge seam: ${from}`);
    return vm.slice(a, b).trim();
  };
  const methods = [
    section("    private fun deliveryFlowState(", "    private suspend fun deliveryRpc("),
    section("    private suspend fun prepareMessageContent(", "    private fun submitDelivery("),
    section("    private fun attachTextLike(", "    var attachError"),
    section("    private fun withLiveItems(", "    private fun handleEvent("),
    section("    private data class StreamRun(", "    private val streamRuns"),
    section("    private var tailRecoverJob", "    private var pendingPromoteDraftSid"),
    section("    private fun queueChunk(", "    private fun applyUpdate("),
    section("    private fun isActiveChatItem(", "    private fun updateScopeItems("),
    section("    private fun historyIdOf(", "    private fun sameHistoryItem("),
    section("    private fun sameChatAuthor(", "    private fun dedupeTail("),
  ].join("\n");
  const phiStart = vm.indexOf("private fun parseHistoryItem(");
  const assistantArm = vm.slice(vm.indexOf('"assistant" ->', phiStart), vm.indexOf('"system" ->', phiStart)).trim();
  assert.ok(assistantArm.includes("LOST_REPLY_PLACEHOLDER") && assistantArm.includes("ChatItem.Assistant(itemId, text, author, at = at)"), "assistant arm 真实源码提取");
  const timelineOrder = section("        val merged =", "        if (anchor) {");
  const cacheProperty = vm.match(/private val chatListCache = .+/)?.[0];
  const cacheKey = vm.match(/chatListCache\.getOrPut\(([^)]+)\)/)?.[1];
  assert.ok(cacheProperty && cacheKey);
  const timelineBridge = `
data class ChatListItem(val at: Long)
internal class TimelineHub {
    val isConnected = true
    var responder: suspend (String, JsonObject) -> JsonObject = { _, _ -> error("no_history_stub") }
    suspend fun call(method: String, params: JsonObject): JsonObject = responder(method, params)
    suspend fun call(method: String): JsonObject = responder(method, buildJsonObject {})
}

internal class TimelineBridge {
    val chatItems = mutableListOf<ChatItem>()
    var itemSeq = 5000L
    var historyViewSeq = 0L
    var historyHasMore = false
    var anchorScopeKey: String? = null
    val historyPageCursors = mutableMapOf<String, Pair<Long, Long>>()
    val historyMoreCache = mutableMapOf<String, Boolean>()
    fun scopeKey(): String? = liveScope
    fun inScope(sid: String) = sid == "s1"
    fun sessionName(sid: String) = "worker"
    ${section("    private fun scopeItems(", "    private fun isActiveChatItem(")}
    ${section("    private fun updateScopeItems(", "    private fun trimChatCache(")}
    fun ensure(f: FlowInfo) = ensureFlowCard(f)
    fun finish(output: String) = finalizeReply("s1", output)
    ${section("    private fun ensureFlowCard(", "    private suspend fun refreshArtifacts(")}
    ${cacheProperty}
    ${section("    private fun historyIdOf(", "    private fun sameHistoryItem(")}
    ${section("    private fun sameChatAuthor(", "    private fun dedupeTail(")}
    ${section("    private fun dedupeTail(", "    private fun loadHistory(")}
    ${section("    private fun isActiveChatItem(", "    private fun compactCacheItems(")}
    ${section("    private fun compactCacheItems(", "    private fun updateScopeItems(")}
    ${section("    private fun sameHistoryItem(", "    private fun applyRecoveredRows(")}
    ${section("    private fun applyRecoveredRows(", "    private fun applyRecoveryRoom(")}
    ${section("    private fun loadHistory(", "    val processItems")}
    ${section("    private data class StreamRun(", "    private val streamRuns")}
    ${section("    private fun withLiveItems(", "    private fun handleEvent(")}
    ${section("    private var tailRecoverJob", "    private var pendingPromoteDraftSid")}
    ${section("    private fun queueChunk(", "    private fun applyUpdate(")}
    private val streamRuns = mutableListOf<StreamRun>()
    var streamFlushJob: Job? = null
    fun shouldShowInRoom(sid: String) = true
    fun chunk(text: String) = queueChunk("s1", "m", text)
    fun flush() = flushStreamChunks()
    val chatCache = mutableMapOf<String, List<ChatItem>>()
    val chatCacheKeys = ArrayDeque<String>()
    fun trimChatCache() {}
    var connectionWanted = true
    fun currentConnection(epoch: Int, generation: Int) =
        epoch == profileEpoch && generation == missionConnectionGeneration && connectionWanted && hub.isConnected
    val recoveryResetBase = mutableMapOf<String, Set<ChatItem>>()
    val deliveryRecords = mutableListOf<DeliveryRecord>()
    var deliveryError: String? = null
    var roomOpenSeq = 0
    var deliveryProtocol = 1
    var missionConnectionGeneration = 1
    var profileEpoch = 1
    var historyLoading = false
    var streamingTail: Pair<String, Long>? = null
    val busyIds = mutableSetOf("s1")
    fun isStreamingTail(id: Long) = streamingTail?.second == id && busyIds.contains(streamingTail?.first)
    var currentRoom: RoomInfo? = RoomInfo("r1")
    var liveScope = "room:r1"
    var currentSession: SessionInfo? = null
    val viewModelScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    val hub = TimelineHub()
    suspend fun hubCall(method: String, params: JsonObject = buildJsonObject {}): JsonObject = hub.call(method, params)
    val deliveryRecovery = DeliveryRecovery(
        { method, params -> hub.call(method, params) },
        { key, rows, reset, cardsCurrent, requestItems -> applyRecoveredRows(key, rows, reset, cardsCurrent, requestItems = requestItems) }, { _, _ -> },
        { key -> historyReadItems(key).filter { it is ChatItem.Flow || it is ChatItem.Decision || it is ChatItem.Elicitation }
            .mapNotNull { historyIdOf(it) }.distinct() },
        { key -> recoveryResetBase[key] = scopeItems(key).toSet() },
        { key -> recoveryResetBase.remove(key) },
        { key, response -> rememberHistoryPage(key, response) },
        { key -> scopeItems(key).filter { it is ChatItem.Process && it.status == "running" }.mapNotNull { historyIdOf(it) } },
        { key -> historyReadItems(key).toSet() },
    )
    fun isDraftId(key: String, id: Long) = deliveryRecovery.isDraftId(key, id)
    fun exitHistoryAnchor() { anchorScopeKey = null }
    suspend fun syncBusyIds() {}
    var deliveryOrigin = ORIGIN
    var deliveryHubId = "h1"
    var lang = "zh"
    val LOST_REPLY_PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]"
    val deliveredRecords = mutableListOf<DeliveryRecord>()
    fun recordDelivery(record: DeliveryRecord) { deliveredRecords.add(record) }
    fun parseFlow(o: JsonObject?, id: String): FlowInfo? = o?.let {
        FlowInfo(it["flowId"]!!.jsonPrimitive.content, it["missionId"]?.jsonPrimitive?.contentOrNull,
            it["mode"]!!.jsonPrimitive.content, it["phase"]!!.jsonPrimitive.content,
            it["clarificationId"]?.jsonPrimitive?.contentOrNull,
            (it["tasks"] as? JsonArray).orEmpty().map { t ->
                FlowTask(t.jsonObject["waitingFor"]?.jsonPrimitive?.contentOrNull, t.jsonObject["waitingHelpId"]?.jsonPrimitive?.contentOrNull)
            })
    }
    fun parseHistoryItem(o: JsonObject, itemId: Long, roomId: String? = null): ChatItem? {
        val kind = o["kind"]?.jsonPrimitive?.content ?: return null
        val author = o["author"]?.jsonPrimitive?.content ?: ""
        val text = o["text"]?.jsonPrimitive?.content ?: ""
        val at = o["at"]?.jsonPrimitive?.longOrNull ?: 0L
        return when (kind) {
            ${assistantArm}
            "user" -> ChatItem.User(itemId, at, historyId = if (itemId < 0) -itemId else null)
            "system" -> ChatItem.System(itemId)
            "tool" -> {
                val meta = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                ChatItem.Tool(itemId, at, toolCallId = meta?.get("toolCallId")?.jsonPrimitive?.content ?: "",
                    status = meta?.get("status")?.jsonPrimitive?.content ?: "completed",
                    title = meta?.get("title")?.jsonPrimitive?.content ?: "tool", author = author)
            }
            "plan" -> ChatItem.Plan(itemId, at)
            "process" -> {
                val meta = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                ChatItem.Process(itemId, at = at,
                    processId = meta?.get("processId")?.jsonPrimitive?.content ?: "",
                    status = meta?.get("status")?.jsonPrimitive?.content ?: "")
            }
            "flow" -> {
                val meta = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                ChatItem.Flow(itemId, meta?.get("flowId")?.jsonPrimitive?.content ?: "",
                    parseFlow(meta, roomId ?: "") ?: FlowInfo("", null, "", "", null, emptyList()), author, at)
            }
            "decision" -> {
                val meta = try { Json.parseToJsonElement(text).jsonObject } catch (_: Exception) { null }
                ChatItem.Decision(itemId, meta?.get("requestId")?.jsonPrimitive?.content ?: "",
                    meta?.get("status")?.jsonPrimitive?.content ?: "",
                    decisionId = meta?.get("decisionId")?.jsonPrimitive?.content ?: "",
                    decisionType = meta?.get("decisionType")?.jsonPrimitive?.content ?: "",
                    answerLabel = meta?.get("answerLabel")?.jsonPrimitive?.content)
            }
            else -> null
        }
    }
    ${section("    private suspend fun recoverScope(", "    private suspend fun recoveryRpc(").replace(/^private /, "")}
    fun close() = viewModelScope.cancel()
    fun loadHistoryPub(method: String, idKey: String, id: String, anchorAt: Long?): Job = loadHistory(method, idKey, id, anchorAt)
    fun compactCacheItemsPub(key: String, items: List<ChatItem>) = compactCacheItems(key, items)
    fun isActiveChatItemPub(it: ChatItem, key: String) = isActiveChatItem(it, key)
    fun order(incoming: List<ChatItem>, tail: List<ChatItem>): List<ChatItem> {
        val key = liveScope
        ${timelineOrder}
        return combined
    }
    fun render(item: ChatItem): Long =
        chatListCache.getOrPut(${cacheKey}) { listOf(ChatListItem(item.at)) }.single().at
}
`;
  fs.writeFileSync(bridge, bridgeFixture.replace("__NATIVE_METHODS__", methods) + timelineBridge);
  fs.writeFileSync(strings, stringsStub);
  fs.writeFileSync(fixture, kotlinFixture);
  execFileSync(java, ["-Xmx512m", "-cp", jars.join(path.delimiter),
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", runtime,
    "-jvm-target", "17", "-d", output,
    ...["HubClient.kt", "DeliveryOutbox.kt"].map((name) =>
      path.join(root, "android", "app", "src", "main", "java", "com", "agenthub", name)),
    strings, fixture, bridge, attention, perfTrace], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
  let result: string;
  try {
    result = execFileSync(java, ["-cp", [output, runtime].join(path.delimiter), "TestKt"],
      { encoding: "utf8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) t.diagnostic(String(stdout).trim());
    throw error;
  }
  assert.deepEqual(result.split(/\r?\n/).filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5)), cases);
  assert.match(result, /^RESULT cases=36$/m);
  t.diagnostic(result.trim());
});

const stringsStub = `
package com.agenthub.ui
interface Strings {
  val connectFailed: String
  val connectionAuthFailed: String
  val connectionPolicyRejected: String
  val connectionInvalidAddress: String
  val deliveryAttachmentFmt: String
  val lostReply: String
}
fun stringsFor(lang: String): Strings = ZhStrings
object ZhStrings : Strings {
  override val connectFailed = "connection"
  override val connectionAuthFailed = "auth"
  override val connectionPolicyRejected = "policy"
  override val connectionInvalidAddress = "config"
  override val deliveryAttachmentFmt = "\\nAttachment: %s\\n%s"
  override val lostReply = "lost"
}
`;

const bridgeFixture = String.raw`
import com.agenthub.*
import com.agenthub.ui.Strings
import com.agenthub.ui.ZhStrings
import com.agenthub.ui.stringsFor
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

internal data class FlowTask(val waitingFor: String?, val waitingHelpId: String?)
internal data class FlowInfo(val flowId: String, val missionId: String?, val mode: String, val phase: String,
    val clarificationId: String?, val tasks: List<FlowTask>, val startedAt: Long = 0)
internal data class RoomInfo(val roomId: String, val members: List<Pair<String, String>> = listOf("s1" to "worker"))
internal data class SessionInfo(val sessionId: String)
internal data class Attachment(val mimeType: String, val base64: String, val name: String, val localPath: String? = null)
internal sealed class ChatItem {
    abstract val id: Long
    open val at: Long = 0
    open val text: String = ""
    open val author: String = ""
    data class Assistant(override val id: Long, override val text: String, override val author: String,
        override val at: Long = 0, val replyText: String? = null, val birthHistoryId: Long = 0) : ChatItem()
    data class Thought(override val id: Long, override val text: String, override val author: String, override val at: Long = 0,
        val birthHistoryId: Long = 0) : ChatItem()
    data class User(override val id: Long, override val at: Long = 0, val historyId: Long? = null,
        val historyAt: Long? = null, val clientMessageId: String? = null, val sendStatus: String? = null) : ChatItem()
    data class System(override val id: Long, override val text: String = "", override val at: Long = 0) : ChatItem()
    data class Error(override val id: Long) : ChatItem()
    data class Tool(override val id: Long, override val at: Long = 0, val toolCallId: String = "", val status: String = "completed", val title: String = "", override val author: String = "") : ChatItem()
    data class Plan(override val id: Long, override val at: Long = 0, val entries: List<String> = emptyList()) : ChatItem()
    data class Process(override val id: Long, override val at: Long = 0,
        val turnStartAt: Long = 0, val turnEndAt: Long = 0, val processId: String = "", val status: String = "") : ChatItem()
    data class Flow(override val id: Long, val flowId: String, val snapshot: FlowInfo,
        override val author: String = "", override val at: Long = 0) : ChatItem()
    data class Permission(override val id: Long, val requestId: String) : ChatItem()
    data class Decision(override val id: Long, val requestId: String, val status: String = "",
        val decisionId: String = "", val decisionType: String = "", val answerLabel: String? = null) : ChatItem()
    data class Elicitation(override val id: Long, val requestId: String, val answered: String? = null) : ChatItem()
    data class MissionCriterion(val index: Int, val text: String, val verdict: String, val note: String)
    data class Mission(override val id: Long, val missionId: String, val goal: String, val status: String,
        val criteria: List<MissionCriterion>, val reasonCode: String? = null,
        override val author: String = "", override val at: Long = 0) : ChatItem() {
        override val text: String get() = goal
    }
}
object Base64 {
    const val DEFAULT = 0
    fun decode(text: String, flags: Int): ByteArray = java.util.Base64.getMimeDecoder().decode(text)
}
internal class BridgeHub {
    var isConnected = true
    var beforeCall: () -> Unit = {}
    var sessions = buildJsonObject { put("sessions", buildJsonArray {
        add(buildJsonObject { put("sessionId", "s1"); put("busy", false); put("offline", false) })
    }) }
    suspend fun call(method: String): JsonObject { beforeCall(); check(method == "session.list"); return sessions }
    suspend fun call(method: String, params: JsonObject): JsonObject = call(method)
}
internal class NativeBridge {
    val viewModelScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    var anchorScopeKey: String? = null
    var liveScope = "room:r1"
    var historyHasMore = true
    var historyViewSeq = 0L
    val historyPageCursors = mutableMapOf<String, Pair<Long, Long>>()
    val historyMoreCache = mutableMapOf<String, Boolean>()
    val chatItems = mutableListOf<ChatItem>()
    val chatCache = mutableMapOf<String, List<ChatItem>>()
    val deliveryRecords = mutableListOf<DeliveryRecord>()
    var itemSeq = 5000L
    private val streamRuns = mutableListOf<StreamRun>()
    private var streamFlushJob: Job? = null
    private var streamingTail: Pair<String, Long>? = null
    val busyIds = mutableSetOf("s1")
    fun isStreamingTail(id: Long) = streamingTail?.second == id && busyIds.contains(streamingTail?.first)
    fun scopeKey(): String? = liveScope
    fun sameHistoryItem(a: ChatItem, b: ChatItem) = a.id == b.id
    fun inScope(sid: String) = sid == "s1"
    fun shouldShowInRoom(sid: String) = true
    fun sessionName(sid: String) = "worker"
    fun frame(body: () -> Unit) = withLiveItems(body)
    fun chunk(text: String) = queueChunk("s1", "m", text)
    fun streaming(id: Long) { streamingTail = "s1" to id }
    fun flush() = flushStreamChunks()
    fun close() = viewModelScope.cancel()
    val hub = BridgeHub()
    suspend fun hubCall(method: String, params: JsonObject = buildJsonObject {}): JsonObject = hub.call(method, params)
    var deliveryReady = true
    var missionConnectionGeneration = 1
    var profileEpoch = 1
    var deliveryOrigin = ORIGIN
    var deliveryHubId = "h1"
    val rooms = listOf(RoomInfo("r1"))
    val calls = mutableListOf<String>()
    var snapshot: JsonObject = snap(null)
    val attachAllowedExt = setOf("txt", "md")
    private val deliveryRecovery get() = recovery
    private val recovery = DeliveryRecovery(
        { method, _ ->
            calls.add(method)
            if (method == "room.sync") snapshot
            else buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
        }, { _, _, _, _, _ -> }, { _, _ -> }, { emptyList() }, { },
    )
    fun currentConnection(epoch: Int, generation: Int) =
        hub.isConnected && profileEpoch == epoch && missionConnectionGeneration == generation
    suspend fun recoverScope(key: String, refreshHistory: Boolean = true) = recovery.recover(key, 1, refreshHistory) { hub.isConnected }
    fun parseFlow(o: JsonObject?, id: String): FlowInfo? = o?.let {
        FlowInfo(it["flowId"]!!.jsonPrimitive.content, it["missionId"]?.jsonPrimitive?.contentOrNull,
            it["mode"]!!.jsonPrimitive.content, it["phase"]!!.jsonPrimitive.content,
            it["clarificationId"]?.jsonPrimitive?.contentOrNull,
            (it["tasks"] as? JsonArray).orEmpty().map { t ->
                FlowTask(t.jsonObject["waitingFor"]?.jsonPrimitive?.contentOrNull, t.jsonObject["waitingHelpId"]?.jsonPrimitive?.contentOrNull)
            })
    }
    suspend fun check(record: DeliveryRecord) = validateDelivery(record)
    suspend fun content(text: String, files: List<Attachment>) = prepareMessageContent(text, files, ZhStrings)
    __NATIVE_METHODS__
}
fun snap(phase: String?, mode: String = "conductor", help: String = "help-1") = buildJsonObject {
    put("mode", "conductor")
    put("cards", JsonArray(emptyList()))
    put("flow", if (phase == null) JsonNull else buildJsonObject {
        put("flowId", "f1"); put("missionId", "m1"); put("mode", mode); put("phase", phase)
        put("clarificationId", help); put("tasks", JsonArray(emptyList()))
    })
}
internal fun intent(record: DeliveryRecord, state: String, reply: String? = null) = record.copy(params =
    JsonObject(record.params.toMutableMap().apply {
        put("expectedFlowId", JsonPrimitive("f1")); put("expectedMissionId", JsonPrimitive("m1"))
        put("expectedFlowState", JsonPrimitive(state))
        if (reply != null) put("replyTo", JsonPrimitive(reply))
    }))
suspend fun verifyViewModelContext() {
    val b = NativeBridge()
    b.deliveryReady = false
    check(b.check(rec("a")) == "busy" && b.calls.isEmpty())
    b.deliveryReady = true
    check(b.check(rec("a")) == null)
    check(b.calls.first() == "room.sync" && b.calls.none { it == "room.history" || it == "session.history" })
    b.snapshot = snap("working")
    check(b.check(rec("a")) == "context")
    val active = intent(rec("a"), "active")
    check(b.check(active) == null)
    check(b.check(intent(rec("a"), "terminal").copy(waitUntilIdle = true)) == "busy")
    b.snapshot = snap("done")
    check(b.check(active) == "context")
    check(b.check(intent(rec("a"), "terminal").copy(waitUntilIdle = true, deferred = true)) == null)
    b.snapshot = snap("working", help = "help-2")
    check(b.check(intent(rec("a"), "active", "help-1")) == "context")
    b.snapshot = snap("summarizing", "parallel")
    check(b.check(intent(rec("a"), "restart")) == null)
    check(b.check(intent(rec("a"), "restart").copy(deferred = true)) == "context")
    b.snapshot = JsonObject(snap(null).toMutableMap().apply { put("subMode", JsonPrimitive("deciding")) })
    check(b.check(rec("a").copy(deferred = true)) == "context")
    val session = rec("s").copy(scopeKey = "session:s1", method = "prompt.send", params = buildJsonObject {
        put("clientMessageId", "s"); put("sessionId", "s1")
    })
    check(b.check(session) == null)
    b.hub.sessions = buildJsonObject { put("sessions", buildJsonArray {
        add(buildJsonObject { put("sessionId", "s1"); put("busy", true) })
    }) }
    check(b.check(session) == "busy")
    b.hub.sessions = buildJsonObject { put("sessions", JsonArray(emptyList())) }
    check(b.check(session) == "context")
    b.hub.beforeCall = { b.profileEpoch++ }
    check(runCatching { b.check(session) }.exceptionOrNull() is CancellationException)
}
suspend fun verifyViewModelPayload() {
    val b = NativeBridge()
    val full = "multibyte-" + "\u4e2d\u6587".repeat(150_000)
    fun encode(bytes: ByteArray) = java.util.Base64.getEncoder().encodeToString(bytes)
    val file = File.createTempFile("hub-native-payload-", ".b64")
    try {
        file.writeText(encode(full.toByteArray(Charsets.UTF_8)))
        val parts = b.content("goal", listOf(Attachment("text/plain", "", "full.txt", file.path)))
        check(parts.last().jsonObject["text"]!!.jsonPrimitive.content.endsWith(full))
        val binary = encode(byteArrayOf(-1, 0, 1))
        val blob = b.content("", listOf(Attachment("text/plain", binary, "binary.txt"))).single().jsonObject
        check(blob["type"]!!.jsonPrimitive.content == "resource")
        check(blob["resource"]!!.jsonObject["blob"]!!.jsonPrimitive.content == binary)
        check(runCatching { b.content("", List(6) { Attachment("image/png", "YQ==", "pic.png") }) }.isFailure)
        check(runCatching { b.content("", listOf(Attachment("application/octet-stream",
            encode(ByteArray(10 * 1024 * 1024 + 1)), "large.bin"))) }.isFailure)
        val eight = encode(ByteArray(8 * 1024 * 1024))
        check(runCatching { b.content("", List(3) { Attachment("application/octet-stream", eight, "part.bin") }) }.isFailure)
    } finally { file.delete() }
    check(runCatching { b.content("", listOf(Attachment("text/plain", "", "missing.txt", file.path))) }.isFailure)
}
`;

const kotlinFixture = String.raw`
import com.agenthub.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import kotlin.coroutines.CoroutineContext

const val NOW = 1_000_000L
val ORIGIN = "a".repeat(64)
fun accepted() = buildJsonObject { put("deliveryStatus", "accepted"); put("historyId", 42) }
fun status(value: String) = buildJsonObject { put("deliveryStatus", value) }
fun hrow(id: Long, text: String = "row-$id", draft: Int = 0) = buildJsonObject {
    put("id", id); put("at", id); put("kind", "assistant"); put("author", "worker"); put("text", text); put("draft", draft)
}
fun prow(id: Long, processId: String, status: String, at: Long = 100L) = buildJsonObject {
    put("id", id); put("at", at); put("kind", "process")
    put("text", buildJsonObject { put("processId", processId); put("status", status) }.toString())
}
fun frow(id: Long, flowId: String, phase: String = "done", at: Long = 100L) = buildJsonObject {
    put("id", id); put("at", at); put("kind", "flow")
    put("text", buildJsonObject { put("flowId", flowId); put("mode", "conductor"); put("phase", phase) }.toString())
}
fun drow(id: Long, requestId: String, status: String = "answered", at: Long = 100L) = buildJsonObject {
    put("id", id); put("at", at); put("kind", "decision")
    put("text", buildJsonObject { put("requestId", requestId); put("status", status); put("decisionId", "d-$requestId") }.toString())
}
fun cid(params: JsonObject) = params["clientMessageId"]!!.jsonPrimitive.content
internal fun rec(id: String, target: String = "r1", binary: Boolean = false) = DeliveryRecord(
    id, ORIGIN, "h1", "room:$target", "room.message",
    buildJsonObject {
        put("clientMessageId", id); put("roomId", target); put("text", "message-$id")
        put("expectedFlowId", JsonNull); put("expectedMissionId", JsonNull)
        put("expectedFlowState", "none"); put("expectedRoomMode", "conductor")
        if (binary) put("content", buildJsonArray {
            add(buildJsonObject { put("type", "image"); put("data", "U0VDUkVUX0ZJTEU="); put("mimeType", "image/png") })
        })
    },
    "message-$id", NOW, replayable = !binary,
    attachmentNames = if (binary) listOf("pic.png") else emptyList(),
)
suspend fun until(check: () -> Boolean) {
    withTimeout(3000) { while (!check()) { yield(); delay(1) } }
}
suspend fun flush() { repeat(10) { yield() } }

internal class Env(context: CoroutineContext, initial: String? = null, immediate: Boolean = false) {
    val job = SupervisorJob()
    val scope = CoroutineScope(context.minusKey(Job) + job +
        if (immediate) Dispatchers.Unconfined else kotlin.coroutines.EmptyCoroutineContext)
    var raw = initial
    var clock = NOW
    var writes = 0
    var server = "h1"
    val gates = mutableListOf<CompletableDeferred<Unit>>()
    val calls = mutableListOf<Triple<String, JsonObject, String>>()
    val updates = mutableMapOf<String, DeliveryRecord>()
    var writer: suspend (String) -> Boolean = { true }
    var receiver: suspend (String, JsonObject) -> JsonObject = { _, _ -> accepted() }
    var validator: suspend (DeliveryRecord) -> String? = { null }
    val box = DeliveryOutbox(scope, { raw },
        { value -> writes++; if (writer(value)) { raw = value; true } else false },
        { method, params -> calls.add(Triple(method, params, server)); receiver(method, params) },
        { validator(it) }, { updates[it.clientMessageId] = it }, {}, now = { clock })
    fun gate() = CompletableDeferred<Unit>().also { gates.add(it) }
    fun bind(ready: Boolean = false, origin: String = ORIGIN, hub: String = "h1", age: Long = 86_400_000L) {
        box.select(origin); box.bind(hub, 1, age); if (ready) box.resume()
    }
    fun sends() = calls.filter { it.first != "client.message.status" }
    fun queries() = calls.filter { it.first == "client.message.status" }
    suspend fun close() {
        val cleanup = box.pause()
        gates.forEach { it.complete(Unit) }
        cleanup.join()
        job.cancelAndJoin()
        flush()
    }
}

fun main() = runBlocking {
    val envs = mutableListOf<Env>()
    fun env(initial: String? = null, immediate: Boolean = false) =
        Env(coroutineContext, initial, immediate).also { envs.add(it) }
    var count = 0
    suspend fun scenario(name: String, body: suspend () -> Unit) {
        try { withTimeout(5000) { body() } }
        catch (failure: Throwable) { println("FAIL $name"); throw failure }
        finally { envs.asReversed().forEach { it.close() }; envs.clear() }
        count++
        println("PASS $name")
    }
    scenario("durability") {
        val e = env(); e.bind(); e.writer = { false }
        check(!e.box.enqueue(rec("a"))); check(e.writes > 0)
        check(e.box.records.isEmpty() && e.calls.isEmpty())
        e.writer = { true }
        check(e.box.enqueue(rec("b")))
        check(!e.raw!!.contains("\"clientMessageId\":\"a\""))
        e.box.resume(); until { e.box.records.isEmpty() }
        check(e.sends().map { cid(it.second) } == listOf("b"))
    }
    scenario("fifo") {
        val e = env(); val gate = e.gate(); e.bind(true)
        e.receiver = { _, p -> if (cid(p) == "a") gate.await(); accepted() }
        check(e.box.enqueue(rec("a"))); until { e.sends().size == 1 }
        check(e.box.enqueue(rec("b"))); flush()
        check(e.sends().map { cid(it.second) } == listOf("a"))
        check(e.updates["a"]!!.status == "sending" && e.updates["b"]!!.status == "pending")
        check(!e.box.dismiss("a"))
        gate.complete(Unit); until { e.box.records.isEmpty() }
        check(e.sends().map { cid(it.second) } == listOf("a", "b"))
    }
    scenario("uncertain_autoresolve") {
        val e = env(); e.bind(true)
        var receipt = "not_found"
        e.receiver = { method, p ->
            if (method == "client.message.status") status(receipt)
            else if (cid(p) == "a") status("uncertain") else accepted()
        }
        check(e.box.enqueue(rec("a"))); until { e.updates["a"]?.status == "uncertain" }
        check(e.box.enqueue(rec("b"))); e.box.resume()
        // uncertain 不再是屏障：a 自动消解（not_found→回退重发），仍 uncertain 则退避，b 正常送达
        until { e.updates["b"]?.status == "sent" }
        check(e.sends().map { cid(it.second) } == listOf("a", "a", "b"))
        // 退避窗口后自动续查：accepted → 判 sent
        receipt = "accepted"; e.clock += 3_000; until { e.box.records.isEmpty() }
        check(e.queries().size == 2)
        check(e.sends().map { cid(it.second) } == listOf("a", "a", "b"))
    }
    scenario("identity_fences") {
        val e = env(); val gate = e.gate(); e.bind(true)
        var validating = false
        e.validator = { if (it.clientMessageId == "a") { validating = true; gate.await() }; null }
        check(e.box.enqueue(rec("a"))); until { validating }
        e.server = "h2"; e.box.select("b".repeat(64)); e.box.bind("h2", 1, 86_400_000L); e.box.resume()
        check(e.box.enqueue(rec("b").copy(origin = "b".repeat(64), hubId = "h2")))
        gate.complete(Unit); until { e.updates["b"]?.status == "sent" }
        check(e.sends().map { cid(it.second) to it.third } == listOf("b" to "h2"))
        check(e.box.records.single().clientMessageId == "a")
        val late = env(); val reply = late.gate(); late.bind(true)
        late.receiver = { _, p -> if (cid(p) == "old") withContext(NonCancellable) { reply.await() }; accepted() }
        check(late.box.enqueue(rec("old"))); until { late.sends().size == 1 }
        late.server = "h2"; late.box.bind("h2", 1, 86_400_000L); late.box.resume()
        check(late.box.enqueue(rec("new").copy(hubId = "h2")))
        until { late.updates["new"]?.status == "sent" }
        reply.complete(Unit); flush()
        check(late.updates["old"]?.status != "sent")
        check(late.sends().map { cid(it.second) to it.third } == listOf("old" to "h1", "new" to "h2"))
        val io = env(); val commit = io.gate(); var writing = false; io.bind(true)
        io.writer = { raw ->
            if (Json.parseToJsonElement(raw).jsonObject["entries"]!!.jsonArray.any {
                it.jsonObject["status"]!!.jsonPrimitive.content == "sending"
            }) { writing = true; commit.await() }
            true
        }
        check(io.box.enqueue(rec("io"))); until { writing }
        io.server = "h2"; io.box.select("b".repeat(64)); io.box.bind("h2", 1, 86_400_000L); io.box.resume()
        commit.complete(Unit); flush()
        check(io.sends().isEmpty())
    }
    scenario("dismiss_and_bulk") {
        val e = env(); val gate = e.gate(); var waiting = false; e.bind(true)
        e.validator = { if (it.clientMessageId == "a") { waiting = true; gate.await() }; null }
        check(e.box.enqueue(rec("a"))); until { waiting }
        check(e.box.enqueue(rec("b"))); check(e.box.enqueue(rec("c")))
        e.writer = { false }
        check(!e.box.dismissMany(setOf("a", "b")))
        check(e.box.records.map { it.clientMessageId } == listOf("a", "b", "c"))
        e.writer = { true }
        check(e.box.dismissMany(setOf("a", "b")))
        gate.complete(Unit); until { e.box.records.isEmpty() }
        check(e.sends().map { cid(it.second) } == listOf("c"))
        check(e.updates["a"]?.status == "dismissed" && e.updates["b"]?.status == "dismissed")
        val single = env(); val held = single.gate(); var preflight = false; single.bind(true)
        single.validator = { if (it.clientMessageId == "a") { preflight = true; held.await() }; null }
        check(single.box.enqueue(rec("a"))); until { preflight }
        check(single.box.enqueue(rec("b"))); check(single.box.dismiss("a"))
        held.complete(Unit); until { single.box.records.isEmpty() }
        check(single.sends().map { cid(it.second) } == listOf("b"))
    }
    scenario("context_and_busy") {
        val e = env(); e.bind(true); var busySeen = false
        e.validator = {
            if (it.clientMessageId == "a") "context"
            else { busySeen = true; "busy" }
        }
        check(e.box.enqueue(rec("a"))); until { e.updates["a"]?.status == "failed" }
        // failed 不再头阻：b 直接 validate → busy → deferred 待自动退避
        check(e.box.enqueue(rec("b"))); until { busySeen }
        check(e.calls.isEmpty())
        check(e.box.dismiss("a"))
        check(e.box.records.single().status == "pending" && e.calls.isEmpty())
        e.validator = { null }; e.box.resume(); until { e.box.records.isEmpty() }
        check(e.sends().map { cid(it.second) } == listOf("b"))
    }
    scenario("codec") {
        val e = env(); e.bind()
        val origin = deliveryOriginFor(" ws://hub ", "private-token", "public-token")
        check(origin.matches(Regex("[a-f0-9]{64}")) && origin == deliveryOriginFor("ws://hub", "private-token", "public-token"))
        check(origin != deliveryOriginFor("ws://hub", "other-token", "public-token"))
        check(origin != deliveryOriginFor("ws://hub", "private-token", "other-public"))
        check(e.box.enqueue(rec("a").copy(waitUntilIdle = true))); check(e.box.enqueue(rec("b", "r2")))
        val seed = e.raw!!
        val restored = env(seed)
        check(restored.box.error == null && restored.box.records.map { it.clientMessageId } == listOf("a", "b"))
        check(restored.box.records.first().waitUntilIdle && !restored.box.records.last().waitUntilIdle)
        restored.bind(true); until { restored.box.records.isEmpty() }
        check(restored.sends().map { cid(it.second) }.toSet() == setOf("a", "b"))
        val doc = Json.parseToJsonElement(seed).jsonObject
        val row = doc["entries"]!!.jsonArray.first().jsonObject
        val wrong = JsonObject(row.toMutableMap().apply { put("scopeLabel", JsonPrimitive(123)) })
        val invalid = JsonObject(doc.toMutableMap().apply { put("entries", JsonArray(listOf(wrong))) }).toString()
        val duplicate = JsonObject(doc.toMutableMap().apply { put("entries", JsonArray(listOf(row, row))) }).toString()
        for (raw in listOf("", "{bad", invalid, duplicate)) {
            val bad = env(raw); bad.bind(true)
            check(bad.box.error == "corrupt")
            check(!bad.box.enqueue(rec("new"))); flush()
            check(bad.raw == raw && bad.writes == 0 && bad.calls.isEmpty())
        }
    }
    scenario("bounds_and_snapshot") {
        val e = env(); e.bind()
        repeat(30) { check(e.box.enqueue(rec("a$it"))) }
        check(!e.box.enqueue(rec("scope-full")))
        repeat(20) { check(e.box.enqueue(rec("b$it", "r2"))) }
        val ids = e.box.records.map { it.clientMessageId }
        check(!e.box.enqueue(rec("global-full", "r3")) && e.box.records.map { it.clientMessageId } == ids)
        val snap = env(); snap.bind()
        val original = rec("snap")
        val params = original.params.toMutableMap()
        val names = mutableListOf("original.txt")
        check(snap.box.enqueue(original.copy(params = JsonObject(params), attachmentNames = names)))
        params["text"] = JsonPrimitive("changed"); names[0] = "changed.txt"
        snap.box.resume(); until { snap.box.records.isEmpty() }
        check(snap.sends().single().second["text"]!!.jsonPrimitive.content == "message-snap")
        check(snap.updates["snap"]!!.attachmentNames == listOf("original.txt"))
        val bytes = env(); bytes.bind()
        val text = "x".repeat(170_000)
        fun large(id: String) = rec(id).let { it.copy(text = text,
            params = JsonObject(it.params.toMutableMap().apply { put("text", JsonPrimitive(text)) })) }
        repeat(3) { check(bytes.box.enqueue(large("large$it"))) }
        check(!bytes.box.enqueue(large("overflow")) && bytes.box.records.size == 3)
    }
    scenario("attachment_tombstone") {
        val e = env(); val gate = e.gate(); var preflight = false; e.bind(true)
        e.validator = { preflight = true; gate.await(); null }
        check(e.box.enqueue(rec("image", binary = true))); until { preflight }
        check(!e.box.records.single().deferred)
        val saved = e.raw!!
        val row = Json.parseToJsonElement(saved).jsonObject["entries"]!!.jsonArray.single().jsonObject
        check(row["attachmentNames"]!!.jsonArray.single().jsonPrimitive.content == "pic.png")
        check(!saved.contains("U0VDUkVUX0ZJTEU=") && row["params"]!!.jsonObject["content"] == null)
        check(e.box.records.single().params["content"] != null)
        val restored = env(saved)
        check(restored.box.records.single().attempted && restored.box.records.single().status == "uncertain")
        restored.receiver = { m, _ ->
            if (m == "client.message.status") status("not_found") else accepted()
        }
        // not_found → 回退 pending 自动重发；附件不可重放 → failed(attachments) 留给用户一键决定
        restored.bind(true); until { restored.box.records.single().status == "failed" }
        check(restored.sends().isEmpty() && restored.box.records.single().error == "attachments"
            && restored.queries().size == 1)
        val offline = env(); offline.bind()
        check(!offline.box.enqueue(rec("offline-image", binary = true)) && offline.box.records.isEmpty())
        val interrupted = env(); interrupted.bind(true)
        val writing = interrupted.gate(); var saving = false
        interrupted.writer = { raw ->
            if (!saving && Json.parseToJsonElement(raw).jsonObject["entries"]!!.jsonArray.isNotEmpty()) {
                saving = true; writing.await()
            }
            true
        }
        val enqueue = interrupted.scope.async { interrupted.box.enqueue(rec("interrupted", binary = true)) }
        until { saving }
        interrupted.box.pause(); interrupted.box.resume()
        writing.complete(Unit); check(enqueue.await())
        until { interrupted.box.records.single().status == "failed" }
        check(interrupted.box.records.single().error == "attachments" && interrupted.calls.isEmpty())
    }
    scenario("receipt_cleanup_failure") {
        val e = env(); e.bind(true)
        e.writer = { raw -> Json.parseToJsonElement(raw).jsonObject["entries"]!!.jsonArray.isNotEmpty() }
        check(e.box.enqueue(rec("a"))); until { e.updates["a"]?.status == "sent" }
        check(e.box.records.single().status == "sent" && e.box.error == "storage")
        val saved = e.raw!!
        check(Json.parseToJsonElement(saved).jsonObject["entries"]!!.jsonArray.single()
            .jsonObject["status"]!!.jsonPrimitive.content == "sending")
        val restarted = env(saved)
        restarted.receiver = { m, _ -> check(m == "client.message.status"); accepted() }
        restarted.bind(true); until { restarted.box.records.isEmpty() }
        check(restarted.sends().isEmpty() && restarted.queries().size == 1)
        check(restarted.updates["a"]?.status == "sent")
        e.writer = { true }; check(e.box.enqueue(rec("b"))); until { e.box.records.isEmpty() }
        check(e.sends().map { cid(it.second) } == listOf("a", "b"))
    }
    scenario("lifecycle_and_fast_worker") {
        val fast = env(immediate = true); fast.bind(true)
        repeat(20) {
            check(fast.box.enqueue(rec("fast$it")))
            until { fast.box.records.isEmpty() }
        }
        check(fast.sends().size == 20 && fast.updates.values.all { it.status == "sent" })
        val e = env(); val gate = e.gate(); e.bind(true)
        e.receiver = { _, _ -> gate.await(); accepted() }
        check(e.box.enqueue(rec("a"))); until { e.sends().size == 1 }
        e.job.cancelAndJoin()
        check(e.box.records.single().status == "uncertain")
        e.box.resume()
        check(!e.box.ready && !e.box.enqueue(rec("b")) && e.sends().size == 1)
    }
    scenario("expiry_and_protocol") {
        val seed = env(); seed.bind(); check(seed.box.enqueue(rec("old")))
        val doc = Json.parseToJsonElement(seed.raw!!).jsonObject
        val row = JsonObject(doc["entries"]!!.jsonArray.single().jsonObject.toMutableMap().apply {
            put("createdAt", JsonPrimitive(1)); put("status", JsonPrimitive("sending")); put("attempted", JsonPrimitive(true))
        })
        val raw = JsonObject(doc.toMutableMap().apply { put("entries", JsonArray(listOf(row))) }).toString()
        val attempted = env(raw)
        attempted.receiver = { m, _ -> check(m == "client.message.status"); accepted() }
        attempted.bind(true, age = 1000); until { attempted.box.records.isEmpty() }
        check(attempted.queries().size == 1 && attempted.sends().isEmpty())
        for (clock in listOf(NOW - 1, NOW + 86_400_001L)) {
            val e = env(); e.bind(age = Long.MAX_VALUE); check(e.box.enqueue(rec("expired")))
            e.clock = clock; e.box.resume(); until { e.box.records.single().status == "failed" }
            check(e.box.records.single().error == "expired" && e.calls.isEmpty())
        }
        for ((protocol, age) in listOf(0 to 86_400_000L, 1 to 0L)) {
            val e = env(); e.box.select(ORIGIN); e.box.bind("h1", protocol, age); e.box.resume()
            check(!e.box.ready && !e.box.enqueue(rec("unsupported")) && e.calls.isEmpty())
        }
    }
    scenario("recovery_watermarks") {
        val requests = mutableListOf<JsonObject>()
        val applied = mutableMapOf<Long, JsonObject>()
        var synchronized = false
        var resets = 0
        val tail = (101L..150L).map { hrow(it) }
        val recovery = DeliveryRecovery(
            { method, p ->
                if (method == "room.sync") {
                    check(applied.keys.containsAll(tail.map { it["id"]!!.jsonPrimitive.long }))
                    synchronized = true
                    buildJsonObject { put("mode", "conductor"); put("flow", JsonNull); put("cards", JsonArray(emptyList())) }
                } else {
                    requests.add(p)
                    check(p["afterId"] == null && p["limit"]!!.jsonPrimitive.long == 50L)
                    buildJsonObject { put("entries", JsonArray(tail)); put("hasMore", true) }
                }
            },
            { _, rows, reset, _, _ -> if (reset) applied.clear(); rows.forEach { applied[it["id"]!!.jsonPrimitive.long] = it } },
            { _, _ -> }, { emptyList() }, { resets++ },
        )
        recovery.remember("room:r1", listOf(hrow(100)), baseline = true)
        recovery.changed("room:r1")
        recovery.remember("room:r1", listOf(hrow(150)))
        check(recovery.cursor("room:r1") == 100L)
        recovery.recover("room:r1", 1) { true }
        check(requests.size == 1 && resets == 1)
        check(applied.keys.size == 50 && recovery.cursor("room:r1") == 150L && synchronized)
    }
    scenario("recovery_reset_and_draft") {
        val requests = mutableListOf<JsonObject>()
        val applied = mutableMapOf<Long, JsonObject>()
        var resets = 0
        var draftReads = 0
        val tailRows = listOf(
            hrow(1), hrow(2, "partial", 1),
            buildJsonObject { put("id", 3); put("at", 3); put("kind", "flow"); put("text", "working"); put("draft", 0) },
        )
        val recovery = DeliveryRecovery(
            { method, p ->
                if (method == "room.sync") buildJsonObject {
                    check(p["knownCardIds"]!!.jsonArray.any { it.jsonPrimitive.long == 3L })
                    put("flow", JsonNull); put("mode", "conductor")
                    put("cards", JsonArray(listOf(buildJsonObject {
                        put("id", 3); put("at", 3); put("kind", "flow"); put("text", "done"); put("draft", 0)
                    })))
                } else if (p["entryIds"] != null) {
                    draftReads++
                    check(p["entryIds"]!!.jsonArray.single().jsonPrimitive.long == 2L)
                    buildJsonObject { put("entries", JsonArray(listOf(buildJsonObject {
                        hrow(2, "final").forEach { (k, v) -> put(k, v) }; put("at", 10000)
                    }))) }
                } else {
                    requests.add(p)
                    check(p["afterId"] == null && p["limit"]!!.jsonPrimitive.long == 50L)
                    buildJsonObject { put("entries", JsonArray(tailRows)); put("hasMore", false) }
                }
            },
            { _, rows, reset, _, _ -> if (reset) { applied.clear(); resets++ }; rows.forEach { applied[it["id"]!!.jsonPrimitive.long] = it } },
            { _, _ -> }, { emptyList() }, { },
        )
        recovery.remember("room:r1", listOf(hrow(999)), baseline = true)
        recovery.recover("room:r1", 1) { true }
        check(requests.size == 1 && resets == 1 && recovery.cursor("room:r1") == 3L)
        check(draftReads == 1 && applied[2]!!["text"]!!.jsonPrimitive.content == "final")
        check(applied[3]!!["text"]!!.jsonPrimitive.content == "done")
    }
    scenario("recovery_fences") {
        var gate = CompletableDeferred<Unit>()
        var entered = false
        var valid = true
        var changes = 0
        val stale = DeliveryRecovery(
            { _, _ -> entered = true; gate.await(); buildJsonObject { put("entries", JsonArray(listOf(hrow(100)))) } },
            { _, _, _, _, _ -> changes++ }, { _, _ -> changes++ }, { emptyList() }, { },
        )
        val pending = async { stale.recover("room:r1", 1) { valid } }
        until { entered }; valid = false; gate.complete(Unit)
        check(runCatching { pending.await() }.exceptionOrNull() is CancellationException)
        check(changes == 0 && stale.cursor("room:r1") == 0L)
        gate = CompletableDeferred(); entered = false; valid = true
        val replaced = async { stale.recover("room:r1", 1) { valid } }
        until { entered }; stale.clear(); gate.complete(Unit)
        check(runCatching { replaced.await() }.exceptionOrNull() is CancellationException && changes == 0)
        lateinit var recovery: DeliveryRecovery
        var attempts = 0
        var snapshots = 0
        recovery = DeliveryRecovery(
            { method, _ ->
                if (method == "room.sync") {
                    attempts++
                    if (attempts < 3) recovery.changed("room:r1")
                    buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                } else buildJsonObject { put("entries", JsonArray(listOf(hrow(100)))); put("hasMore", false) }
            },
            { _, _, _, _, _ -> }, { _, _ -> snapshots++ }, { emptyList() }, { },
        )
        recovery.remember("room:r1", listOf(hrow(100)), baseline = true)
        recovery.recover("room:r1", 1) { true }
        check(attempts == 3 && snapshots == 1 && recovery.cursor("room:r1") == 100L)
        val first = CompletableDeferred<Unit>()
        var loading = false
        val merged = mutableSetOf<Long>()
        val tail = (301L..350L).map { hrow(it) }
        val concurrent = DeliveryRecovery(
            { _, p ->
                check(p["afterId"] == null && p["limit"]!!.jsonPrimitive.long == 50L)
                loading = true; first.await()
                buildJsonObject { put("entries", JsonArray(tail)); put("hasMore", true) }
            },
            { _, rows, _, _, _ -> rows.forEach { merged.add(it["id"]!!.jsonPrimitive.long) } },
            { _, _ -> }, { emptyList() }, { },
        )
        val cold = async { concurrent.recover("session:s1", 1) { true } }
        until { loading }
        concurrent.remember("session:s1", (151L..350L).map { hrow(it) }, baseline = true)
        first.complete(Unit); cold.await()
        check(merged.containsAll(tail.map { it["id"]!!.jsonPrimitive.long }))
        check(concurrent.cursor("session:s1") == 350L)
    }
    scenario("recovery_tail_reset_order") {
        val order = mutableListOf<String>()
        var tailResponded = false
        val recovery = DeliveryRecovery(
            { method, _ ->
                order.add("rpc:$method")
                if (method == "room.sync") buildJsonObject {
                    put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList()))
                } else {
                    tailResponded = true
                    buildJsonObject { put("entries", JsonArray((100L..149L).map { hrow(it) })); put("hasMore", true) }
                }
            },
            { _, rows, reset, _, _ -> order.add("apply:\${rows.size}:$reset") },
            { _, _ -> }, { emptyList() },
            { order.add("beforeReset") }, { order.add("afterReset") },
            onTail = { _, resp -> order.add("onTail:" + ((resp["entries"] as? JsonArray)?.size ?: -1).toString()) },
        )
        recovery.recover("room:r1", 1) { true }
        check(order.first() == "beforeReset" && order.indexOf("rpc:room.history") > order.indexOf("beforeReset"))
        check(order.contains("onTail:50") && order.last() == "afterReset")
        check(tailResponded)
        var leaked = true
        val failing = DeliveryRecovery(
            { _, _ -> error("boom") },
            { _, _, _, _, _ -> }, { _, _ -> }, { emptyList() },
            { }, { leaked = false },
        )
        runCatching { failing.recover("room:r1", 1) { true } }
        check(!leaked) { "失败路径也须 afterReset 清理 capture" }
    }
    scenario("recovery_refresh_false") {
        val methods = mutableListOf<String>()
        var syncParams: JsonObject? = null
        val recovery = DeliveryRecovery(
            { method, p ->
                methods.add(method)
                if (method == "room.sync") { syncParams = p; buildJsonObject {
                    put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList()))
                } } else error("refreshHistory=false 不得发 history: $method")
            },
            { _, rows, _, _, _ -> check(rows.isEmpty()) { "false 仅允许空 cards 批次" } },
            { _, _ -> }, { listOf(7L) }, { },
        )
        val snap = recovery.recover("room:r1", 1, false) { true }
        check(snap != null && methods == listOf("room.sync"))
        check((syncParams?.get("knownCardIds") as? JsonArray)?.size == 0) { "false 用空 knownCardIds" }
        check(recovery.recover("session:s1", 1, false) { true } == null) { "session false 直接 null" }
    }
    scenario("recovery_tail_stale_no_callback") {
        val gate = CompletableDeferred<Unit>()
        var entered = false
        var valid = true
        var tailCalls = 0
        var onTailCalls = 0
        val recovery = DeliveryRecovery(
            { method, _ ->
                if (method == "room.history") { entered = true; tailCalls++; gate.await()
                    buildJsonObject { put("entries", JsonArray(listOf(hrow(100)))); put("hasMore", false) }
                } else buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
            },
            { _, _, _, _, _ -> }, { _, _ -> }, { emptyList() }, { }, { },
            onTail = { _, _ -> onTailCalls++ },
        )
        val pending = async { recovery.recover("room:r1", 1) { valid } }
        until { entered }; valid = false; gate.complete(Unit)
        check(runCatching { pending.await() }.exceptionOrNull() is CancellationException)
        check(onTailCalls == 0 && tailCalls == 1) { "stale 响应不得触发 onTail/二次 tail" }
    }
    scenario("viewmodel_context") { verifyViewModelContext() }
    scenario("viewmodel_payload") { verifyViewModelPayload() }
    scenario("session_cards") {
        var refreshed = false
        val decision = buildJsonObject { put("id", 12); put("kind", "decision"); put("text", "answered"); put("draft", 0) }
        val recovery = DeliveryRecovery(
            { method, p ->
                check(method == "session.history")
                if (p["entryIds"] != null) {
                    check(p["entryIds"]!!.jsonArray.single().jsonPrimitive.long == 12L)
                    buildJsonObject { put("entries", JsonArray(listOf(decision))) }
                } else buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
            },
            { _, rows, _, _, _ -> if (rows.any { it["text"]?.jsonPrimitive?.content == "answered" }) refreshed = true },
            { _, _ -> error("session must not request room state") }, { listOf(12) }, { },
        )
        recovery.remember("session:s1", listOf(hrow(100)), baseline = true)
        recovery.recover("session:s1", 1) { true }
        check(refreshed && recovery.cursor("session:s1") == 0L)
    }
    scenario("attention_identity") {
        fun targets(batch: Long = 1, help: String = "h1", origin: String = ORIGIN, hub: String = "h1") =
            attentionTargets(origin, hub, mapOf("r1" to buildJsonObject {
                put("flowId", "f1"); put("phase", "working"); put("goal", "private goal")
                put("tasks", buildJsonArray { add(buildJsonObject {
                    put("id", "t1"); put("name", "worker"); put("task", "private task"); put("waitingFor", "user")
                    put("waitingHelpId", help); put("dispatchedAt", batch)
                }) })
            }), emptyList())
        val first = targets().single()
        check(first.key.matches(Regex("[a-f0-9]{64}")) && first.label == "private task")
        check(first.extras["navDispatchedAt"] == "1" && first.extras["navHelpId"] == "h1")
        check(listOf(targets(2), targets(help = "h2"), targets(origin = "b".repeat(64)), targets(hub = "h2"))
            .all { it.single().key != first.key })
        check(first.extras.values.none { it.contains("private") })
        val raw = buildJsonObject {
            put("flowId", "f1"); put("phase", "awaiting-input"); put("goal", "private goal")
            put("clarificationId", "q1"); put("clarificationQuestions", buildJsonArray { add("private question") })
            put("diff", "unneeded secret"); put("tasks", JsonArray(emptyList()))
        }
        val projected = attentionFlow(raw)!!
        check(!projected.toString().contains("unneeded secret") && !projected.toString().contains("private question"))
        check(attentionTargets(ORIGIN, "h1", mapOf("r1" to projected), emptyList()).single().extras["navHelpId"] == "q1")
        fun retry(batch: Long) = attentionFlow(buildJsonObject {
            put("flowId", "f1"); put("phase", "awaiting-retry")
            put("tasks", buildJsonArray { add(buildJsonObject { put("dispatchedAt", batch); put("status", "failed") }) })
        })
        val retry1 = attentionTargets(ORIGIN, "h1", mapOf("r1" to retry(1)), emptyList()).single()
        check(retry1.key != attentionTargets(ORIGIN, "h1", mapOf("r1" to retry(2)), emptyList()).single().key)
        check(attentionDecision(buildJsonObject { put("decisionId", "d1"); put("context", "private token") })["context"] == null)
        check(attentionTargets(ORIGIN, "h1", mapOf("r1" to buildJsonObject {
            put("flowId", "f1"); put("phase", "done")
            put("clarificationId", "h1"); put("clarificationQuestions", buildJsonArray { add("private question") })
        }), emptyList()).isEmpty())
    }
    scenario("attention_recovery") {
        val target = AttentionTarget("a".repeat(64), "flow", mapOf("navRoomId" to "r1"), 1, "private task")
        var raw: String? = null
        val alerts = mutableListOf<Pair<String, Boolean>>()
        val canceled = mutableListOf<String>()
        fun ledger() = AttentionLedger(raw, { raw = it; true }, { t, silent -> alerts.add(t.key to silent); true }, { canceled.add(it) })
        val first = ledger()
        check(first.replace(listOf(target), true))
        check(alerts == listOf(target.key to false))
        first.replace(listOf(target), true)
        check(alerts.size == 1 && !raw!!.contains("private task"))
        val restored = ledger()
        restored.replace(listOf(target), true)
        check(alerts.last() == target.key to true)
        restored.replace(emptyList(), false)
        check(canceled == listOf(target.key))
        restored.replace(listOf(target.copy(key = "b".repeat(64), at = 2)), true)
        check(alerts.last() == "b".repeat(64) to false)
    }
    scenario("attention_limits") {
        fun target(n: Int) = AttentionTarget(n.toString(16).padStart(64, '0'), "flow", emptyMap(), n.toLong())
        var allowed = false
        var writes = true
        var raw = ""
        val shown = mutableListOf<Pair<String, Boolean>>()
        val ledger = AttentionLedger(null, { if (writes) raw = it; writes }, { t, silent -> shown.add(t.key to silent); true }, {}, { allowed })
        ledger.replace(listOf(target(1)), true)
        check(shown.isEmpty())
        allowed = true
        ledger.replace(listOf(target(1)), false)
        check(shown.isEmpty())
        ledger.replace(listOf(target(1)), true)
        check(shown == listOf(target(1).key to false))
        writes = false
        check(!ledger.replace(listOf(target(2)), true) && shown.size == 1)
        writes = true
        check(ledger.replace((1..1100).map { target(it) }, true))
        val doc = Json.parseToJsonElement(raw).jsonObject
        check(doc["active"]!!.jsonArray.size == 40 && doc["seen"]!!.jsonArray.size <= 1000)
        check(doc["active"]!!.jsonArray.all { it.jsonObject["at"]!!.jsonPrimitive.long >= 1061 })
        val before = raw
        check(!ledger.replace(emptyList(), true) { false } && raw == before)
        val corrupt = AttentionLedger("{bad", { true }, { _, silent -> check(silent); true }, {})
        check(corrupt.replace(listOf(target(3)), true))
        var background = true
        val racing = AttentionLedger(null, { background = false; true }, { _, _ -> error("foreground after IO must not alert") }, {}, { background })
        check(racing.replace(listOf(target(4)), true))
    }
    scenario("viewmodel_anchor") {
        val b = NativeBridge()
        try {
            b.anchorScopeKey = b.liveScope
            b.chatItems.add(ChatItem.Permission(1, "request-1"))
            b.chatCache[b.liveScope] = listOf(ChatItem.Decision(-4, "request-1"), ChatItem.Assistant(7, "latest", "worker"))
            b.frame { b.chatItems.add(ChatItem.Assistant(8, "live", "worker")); b.historyHasMore = false }
            b.streaming(8)
            check(b.chatItems.single() is ChatItem.Decision && b.chatItems.single().id == -4L)
            check(b.chatCache[b.liveScope]!!.map { it.id } == listOf(-4L, 7L, 8L))
            check(b.historyHasMore && b.anchorScopeKey == b.liveScope)
            check(runCatching { b.frame { error("injected") } }.isFailure)
            check(b.anchorScopeKey == b.liveScope && b.chatItems.single().id == -4L)
            b.chunk(" buffered"); b.flush()
            check(b.chatItems.single().id == -4L)
            check((b.chatCache[b.liveScope]!!.last() as ChatItem.Assistant).text == "live buffered")
        } finally { b.close() }
    }
    scenario("stream_scope") {
        val b = NativeBridge()
        try {
            b.chunk("room-a")
            b.liveScope = "room:r2"
            b.flush()
            check(b.chatItems.isEmpty())
            b.chunk("old-connection")
            b.missionConnectionGeneration++
            b.flush()
            check(b.chatItems.isEmpty())
            b.chunk("old-profile")
            b.profileEpoch++
            b.flush()
            check(b.chatItems.isEmpty())
            b.chunk("current"); b.flush()
            check((b.chatItems.single() as ChatItem.Assistant).text == "current")
            b.chatItems.clear()
            b.chatItems.add(ChatItem.Assistant(-100, "history", "worker"))
            b.chunk("new"); b.flush()
            check(b.chatItems.map { it.text } == listOf("history", "new"))
        } finally { b.close() }
    }
    scenario("timeline") {
        val b = TimelineBridge()
        val ordered = b.order(listOf(ChatItem.Assistant(-200, "new", "worker", 1000)),
            listOf(ChatItem.Assistant(-100, "old", "worker", 1000))).map { it.id } == listOf(-100L, -200L)
        val item = ChatItem.Assistant(-300, "same text", "worker", 1000)
        b.render(item)
        val refreshed = b.render(item.copy(at = 2000)) == 2000L
        check(ordered && refreshed) { "same-time order=$ordered, refreshed metadata=$refreshed" }
        check(b.order(listOf(ChatItem.Process(-400, turnStartAt = 100, turnEndAt = 200)),
            listOf(ChatItem.Assistant(1, "streaming", "worker", 50))).map { it.id } == listOf(-400L, 1L))
        b.chatItems.addAll(listOf(ChatItem.User(-100, at = 1000), ChatItem.Assistant(-200, "summary", "worker", 3000)))
        val f = FlowInfo("f1", null, "conductor", "working", null, emptyList(), 2000)
        b.ensure(f)
        check(b.chatItems.map { it.at } == listOf(1000L, 3000L, 3001L)) { "late flow anchored at persisted tail" }
        b.chatItems.clear()
        b.chatItems.addAll(listOf(ChatItem.Assistant(1, "first", "worker", 100), ChatItem.Assistant(2, "second", "worker", 110)))
        b.finish("firstsecond")
        val final = ChatItem.Assistant(-500, "firstsecond", "worker", 200)
        check(b.order(listOf(final), b.chatItems) == listOf(final)) { "fragment suffix survived history reconciliation" }
        b.chatItems.add(ChatItem.Assistant(3, "next", "worker", 210))
        b.finish("next")
        check((b.chatItems[0] as ChatItem.Assistant).replyText == "firstsecond")
        check((b.chatItems[2] as ChatItem.Assistant).replyText == "next")
    }
    scenario("recovery_mutable_entries") {
        val entryIdCalls = mutableListOf<Set<Long>>()
        val recovery = DeliveryRecovery(
            { method, p ->
                val ids = p["entryIds"]?.jsonArray?.map { it.jsonPrimitive.long }?.toSet()
                if (ids != null) entryIdCalls.add(ids)
                if (method.endsWith("history") && p["entryIds"] != null) buildJsonObject {
                    put("entries", JsonArray(ids!!.map { hrow(it) })); put("hasMore", false)
                } else if (method == "room.sync") buildJsonObject {
                    put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList()))
                } else buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
            },
            { _, _, _, _, _ -> }, { _, _ -> }, { _ -> emptyList() },
            { }, { }, { _, _ -> }, { _ -> listOf(77L) },
        )
        recovery.remember("room:r1", listOf(hrow(150, "draft", 1)), baseline = true)
        recovery.recover("room:r1", 1) { true }
        check(entryIdCalls.any { it.contains(150L) && it.contains(77L) }) { "mutableEntries 与 drafts 合并 entryIds: \$entryIdCalls" }
    }
    scenario("recovery_dedupe_draft150") {
        for (persistedAuthor in listOf("worker", "worker (Codex)")) {
            val b = TimelineBridge()
            try {
                b.liveScope = "room:r1"
                b.chatItems.clear()
                val futureAt = System.currentTimeMillis() + 600000
                b.deliveryRecovery.remember("room:r1", listOf(buildJsonObject {
                    put("id", 150); put("at", futureAt); put("kind", "assistant"); put("author", persistedAuthor); put("text", "partial"); put("draft", 1)
                }), baseline = true)
                b.chatItems.add(ChatItem.Assistant(-150, "partial", persistedAuthor, at = futureAt))
                fun draftRow(text: String, draft: Int, author: String = persistedAuthor) = buildJsonObject {
                    put("id", 150); put("at", futureAt); put("kind", "assistant"); put("author", author); put("text", text); put("draft", draft)
                }
                val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
                val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
                var gated = false
                var tailCalls = 0
                b.hub.responder = { method, params ->
                    when {
                        method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                        method.endsWith("history") -> {
                            tailCalls++
                            if (params["entryIds"] == null && !gated) { gated = true; entered.complete(Unit); gate.await() }
                            val ids = params["entryIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                            val rows = if (ids.isNotEmpty()) ids.map { draftRow("partial", 1) } else listOf(draftRow("partial", 1))
                            buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                        }
                        else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                    }
                }
                kotlinx.coroutines.runBlocking {
                    kotlinx.coroutines.coroutineScope {
                        val job = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { b.recoverScope("room:r1") }
                        entered.await()
                        check(tailCalls >= 1) { "baseline tail RPC 在途" }
                        b.chunk("more")
                        b.flush()
                        val during = b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }
                        check(during.text == "partialmore" && during.at == futureAt) { "draft 追加保持 server.at: \${during.text}@\${during.at}" }
                        gate.complete(Unit)
                        job.await()
                    }
                }
                val kept = b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }
                check(kept.text == "partialmore" && kept.at == futureAt) { "迟到 draft1 不覆盖更长 live: \${kept.text}@\${kept.at}" }
                b.finish("")
                check((b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }).replyText != null) { "finalize 标记完成" }
                b.hub.responder = { method, params ->
                    when {
                        method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                        method.endsWith("history") -> {
                            val ids = params["entryIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                            val rows = if (ids.isNotEmpty()) ids.map { draftRow("partial", 1) } else listOf(draftRow("partial", 1))
                            buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                        }
                        else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                    }
                }
                kotlinx.coroutines.runBlocking { b.recoverScope("room:r1") }
                val afterDraft = b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }
                check(afterDraft.text == "partialmore" && afterDraft.replyText != null) { "迟到 draft1 不得复活已完成: \${afterDraft.text}" }
                b.hub.responder = { method, params ->
                    when {
                        method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                        method.endsWith("history") -> {
                            val ids = params["entryIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                            val rows = if (ids.isNotEmpty()) ids.map { draftRow("partial", 0) } else listOf(draftRow("partial", 0))
                            buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                        }
                        else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                    }
                }
                kotlinx.coroutines.runBlocking { b.recoverScope("room:r1") }
                val shortFinal = b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }
                check(shortFinal.text == "partial") { "draft0 短 prefix 也权威采纳: \${shortFinal.text}" }
                b.hub.responder = { method, params ->
                    when {
                        method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                        method.endsWith("history") -> {
                            val ids = params["entryIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                            val rows = if (ids.isNotEmpty()) ids.map { draftRow("canonical-final", 0) } else listOf(draftRow("canonical-final", 0))
                            buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                        }
                        else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                    }
                }
                kotlinx.coroutines.runBlocking { b.recoverScope("room:r1") }
                check(b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }.text == "canonical-final") { "draft0 非 prefix canonical 权威" }
            } finally { b.close() }
        }
        val b = TimelineBridge()
        try {
            b.liveScope = "room:r1"
            b.chatItems.clear()
            val futureAt = System.currentTimeMillis() + 600000
            b.chatCache["room:r1"] = (950L..999L).map { ChatItem.Assistant(it, "n\$it", "worker", at = it, replyText = "n\$it") }
            b.anchorScopeKey = "room:r1"
            b.deliveryRecovery.remember("room:r1", listOf(buildJsonObject {
                put("id", 150); put("at", futureAt); put("kind", "assistant"); put("author", "worker"); put("text", "partial"); put("draft", 1)
            }))
            b.chatItems.add(ChatItem.Assistant(-150, "partialmore", "worker", at = futureAt))
            b.historyPageCursors["anchor:room:r1"] = (futureAt + 1) to 151
            b.historyHasMore = true
            val normalBefore = b.chatCache["room:r1"]!!.toList()
            fun anchorDraftRow(text: String, draft: Int) = buildJsonObject {
                put("id", 150); put("at", futureAt); put("kind", "assistant"); put("author", "worker"); put("text", text); put("draft", draft)
            }
            b.hub.responder = { method, p ->
                when {
                    method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    p["before"] != null -> buildJsonObject {
                        put("entries", JsonArray(listOf(hrow(149), anchorDraftRow("partial", 1)))); put("hasMore", false)
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            b.loadMoreHistory()
            kotlinx.coroutines.runBlocking { until { !b.historyLoading } }
            check(b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }.text == "partialmore") { "anchor 页旧 draft1 不覆盖 partialmore" }
            check(b.chatItems.any { it is ChatItem.Assistant && it.id == -149L }) { "anchor 页旧行前插" }
            check(b.chatItems.none { it is ChatItem.Assistant && it.id in 950L..999L }) { "anchor 窗口不被 normal 尾页换掉" }
            check(b.chatCache["room:r1"] == normalBefore) { "anchor 分页不动 normal cache" }
            b.historyPageCursors["anchor:room:r1"] = futureAt to 150
            b.historyHasMore = true
            b.hub.responder = { method, p ->
                when {
                    method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    p["before"] != null -> buildJsonObject {
                        put("entries", JsonArray(listOf(anchorDraftRow("partial", 0)))); put("hasMore", false)
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            b.loadMoreHistory()
            kotlinx.coroutines.runBlocking { until { !b.historyLoading } }
            check(b.chatItems.filterIsInstance<ChatItem.Assistant>().single { it.id == -150L }.text == "partial") { "anchor 页 draft0 短 prefix 权威" }
            check(b.chatCache["room:r1"] == normalBefore) { "draft0 页仍不动 normal cache" }
        } finally { b.close() }
    }

    scenario("recovery_cursor_isolation") {
        val b = TimelineBridge()
        val beforeParams = mutableListOf<Pair<Long, Long>>()
        try {
            b.hub.responder = { method, p ->
                when {
                    method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    p["anchorAt"] != null -> buildJsonObject {
                        put("entries", JsonArray((475L..524L).map { hrow(it) })); put("hasMore", true)
                    }
                    p["before"] != null -> {
                        beforeParams.add(p["before"]!!.jsonPrimitive.long to p["beforeId"]!!.jsonPrimitive.long)
                        buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                    }
                    method.endsWith("history") -> buildJsonObject {
                        put("entries", JsonArray((950L..999L).map { hrow(it) })); put("hasMore", true)
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            kotlinx.coroutines.runBlocking { b.recoverScope("room:r1") }
            val normalCursor = b.historyPageCursors["room:r1"]
            check(normalCursor == (950L to 950L)) { "normal 游标来自 raw 尾页: $normalCursor" }
            kotlinx.coroutines.runBlocking { b.loadHistoryPub("room.history", "roomId", "r1", 1000).join() }
            val anchorCursor = b.historyPageCursors["anchor:room:r1"]
            check(anchorCursor == (475L to 475L)) { "anchor 游标独立: $anchorCursor" }
            check(b.historyPageCursors["room:r1"] == (950L to 950L)) { "anchor 不污染 normal 游标" }
            b.loadMoreHistory()
            kotlinx.coroutines.runBlocking { until { !b.historyLoading } }
            check(beforeParams.any { it == (475L to 475L) }) { "anchor loadMore 用 anchor 游标: \$beforeParams" }
            check(b.historyPageCursors["anchor:room:r1"] == null) { "空页清除 anchor 游标" }
        } finally { b.close() }
    }
    scenario("recovery_loadmore_viewseq") {
        val b = TimelineBridge()
        val staleGate = kotlinx.coroutines.CompletableDeferred<Unit>()
        try {
            b.anchorScopeKey = "room:r1"
            b.historyPageCursors["anchor:room:r1"] = 475L to 475L
            b.historyHasMore = true
            val enteredPage = kotlinx.coroutines.CompletableDeferred<Unit>()
            b.hub.responder = { method, p ->
                when {
                    method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    p["before"] != null -> {
                        enteredPage.complete(Unit)
                        staleGate.await()
                        buildJsonObject { put("entries", JsonArray((350L..399L).map { hrow(it) })); put("hasMore", true) }
                    }
                    p["anchorAt"] != null -> buildJsonObject {
                        put("entries", JsonArray((400L..449L).map { hrow(it) })); put("hasMore", true)
                    }
                    method.endsWith("history") -> buildJsonObject {
                        put("entries", JsonArray((950L..999L).map { hrow(it) })); put("hasMore", true)
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            b.loadMoreHistory()
            kotlinx.coroutines.runBlocking { enteredPage.await() }
            kotlinx.coroutines.runBlocking { b.loadHistoryPub("room.history", "roomId", "r1", 1000).join() }
            staleGate.complete(Unit)
            kotlinx.coroutines.runBlocking { until { !b.historyLoading } }
            val staleCursor = b.historyPageCursors["anchor:room:r1"]
            check(staleCursor == (400L to 400L)) { "迟到旧页不得改写 anchor 游标: $staleCursor" }
        } finally { b.close() }
    }
    scenario("recovery_concurrent_afterreset") {
        val order = mutableListOf<String>()
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        var entered = 0
        val firstEntered = kotlinx.coroutines.CompletableDeferred<Unit>()
        val recovery = DeliveryRecovery(
            { method, _ ->
                if (method.endsWith("history") && entered == 0) { entered++; firstEntered.complete(Unit); gate.await() }
                if (method == "room.sync") buildJsonObject {
                    put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList()))
                } else buildJsonObject { put("entries", JsonArray((100L..149L).map { hrow(it) })); put("hasMore", false) }
            },
            { _, _, _, _, _ -> }, { _, _ -> }, { _ -> emptyList() },
            { order.add("beforeReset") }, { order.add("afterReset") }, { _, _ -> },
        )
        kotlinx.coroutines.runBlocking {
            val j1 = async { recovery.recover("room:r1", 1) { true } }
            firstEntered.await()
            val j2 = async { recovery.recover("room:r1", 1) { true } }
            gate.complete(Unit)
            j1.await(); j2.await()
        }
        val secondBefore = order.withIndex().firstOrNull { it.index > 0 && it.value == "beforeReset" }?.index ?: -1
        val firstAfter = order.indexOf("afterReset")
        check(firstAfter in 1 until secondBefore) { "首个 recover 的 afterReset 须在锁内先于第二个 beforeReset: \$order" }
    }
    scenario("recovery_compact_completed_local") {
        val b = TimelineBridge()
        try {
            b.liveScope = "room:r1"
            b.chatItems.clear()
            repeat(120) { i ->
                b.chatItems.add(ChatItem.Assistant((1000 + i).toLong(), "done-\$i", "worker", at = (1000 + i).toLong(), replyText = "done-\$i"))
                b.chatItems.add(ChatItem.Tool((2000 + i).toLong(), at = (2000 + i).toLong(), status = "completed"))
            }
            b.chatItems.add(ChatItem.Assistant(1L, "stream-tail", "worker", at = 10))
            b.streamingTail = "s1" to 1L
            b.busyIds.add("s1")
            b.chatItems.add(ChatItem.Thought(6L, "think-tail", "worker", at = 11))
            b.streamingTail = "s1" to 6L
            b.chatItems.add(ChatItem.User(2L, at = 12, sendStatus = "sending", clientMessageId = "cm-1"))
            b.chatItems.add(ChatItem.Flow(3L, "f-active", FlowInfo("f-active", null, "conductor", "working", null, emptyList()), "worker", at = 13))
            b.chatItems.add(ChatItem.Decision(4L, "req-p", status = "pending", decisionId = "d-p", decisionType = "permission"))
            b.chatItems.add(ChatItem.Process(5L, at = 14, processId = "p-run", status = "running"))
            b.chatItems.add(ChatItem.Tool(7L, at = 15, status = "in_progress", toolCallId = "tc-1"))
            b.chatItems.add(ChatItem.Tool(9L, at = 9, status = "queued", toolCallId = "tc-9"))
            b.chatItems.add(ChatItem.Elicitation(8L, "req-e", answered = null))
            b.deliveryRecovery.remember("room:r1", listOf(hrow(150, "draft-partial", 1)), baseline = true)
            b.chatItems.add(ChatItem.Assistant(-150, "draft-partial", "worker", at = 16))
            val compacted = b.compactCacheItemsPub("room:r1", b.chatItems.toList())
            val nonActive = compacted.count {
                !b.isActiveChatItemPub(it, "room:r1") &&
                    !(it is ChatItem.Assistant && b.isDraftId("room:r1", -it.id))
            }
            check(nonActive == 50) { "非活跃项恰 50: \$nonActive" }
            check(compacted.count { b.isActiveChatItemPub(it, "room:r1") } >= 8) { "全部 active 保留: \${compacted.size - nonActive}" }
            check(compacted.any { it is ChatItem.Flow && it.flowId == "f-active" }) { "active flow 保留" }
            check(compacted.any { it is ChatItem.Decision && it.status == "pending" }) { "pending decision 保留" }
            check(compacted.any { it is ChatItem.Process && it.status == "running" }) { "running process 保留" }
            check(compacted.any { it is ChatItem.User && it.clientMessageId == "cm-1" }) { "sending user 保留" }
            check(compacted.any { it is ChatItem.Assistant && it.id == 1L }) { "streaming assistant 保留" }
            check(compacted.any { it is ChatItem.Thought && it.id == 6L }) { "streaming thought 保留" }
            check(compacted.any { it is ChatItem.Tool && it.id == 7L }) { "in_progress tool 保留" }
            check(compacted.any { it is ChatItem.Tool && it.id == 9L }) { "未知非终态 queued tool 保留" }
            check(compacted.any { it is ChatItem.Elicitation && it.requestId == "req-e" }) { "unanswered elicitation 保留" }
            check(compacted.any { it is ChatItem.Assistant && it.id == -150L }) { "draft pinned 保留" }
            check(!compacted.any { it is ChatItem.Tool && it.status == "completed" && it.id == 2000L }) { "最老 completed tool 被裁" }
            b.chatCache["room:r1"] = compacted
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
            b.hub.responder = { method, params ->
                when {
                    method == "room.sync" -> buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    method.endsWith("history") -> {
                        entered.complete(Unit)
                        gate.await()
                        val ids = params["entryIds"]?.jsonArray?.mapNotNull { it.jsonPrimitive.longOrNull } ?: emptyList()
                        val rows = if (ids.isNotEmpty()) ids.map { if (it == 150L) hrow(150, "draft-partial", 1) else hrow(it) }
                            else (500L..549L).map { hrow(it) }
                        buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.coroutineScope {
                    val job = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { b.recoverScope("room:r1") }
                    entered.await()
                    check(b.recoveryResetBase.containsKey("room:r1")) { "beforeReset 真实捕获 resetBase" }
                    b.chatItems.add(ChatItem.Assistant(9001L, "rpc-live", "worker", at = 9500, replyText = "rpc-live"))
                    gate.complete(Unit)
                    job.await()
                }
            }
            check(b.chatItems.any { it is ChatItem.Assistant && it.id == 9001L }) { "RPC 期间新完成项保留" }
            check(b.chatItems.none { it is ChatItem.Assistant && it.id in 1000L..1119L }) { "reset 后旧 completed 本地项不复活" }
            check(!b.recoveryResetBase.containsKey("room:r1")) { "afterReset 清理 resetBase" }
            check(b.chatItems.size <= 70) { "reset 后 cache 受控: \${b.chatItems.size}" }
        } finally { b.close() }
    }
    scenario("recovery_race_tail_process_done") {
        val b = TimelineBridge()
        try {
            b.liveScope = "room:r1"
            b.chatItems.clear()
            b.chatItems.add(ChatItem.Process(-103, at = 103, processId = "p-103", status = "running", turnStartAt = 90, turnEndAt = 0))
            b.chatItems.add(ChatItem.Flow(-101, "f-101", FlowInfo("f-101", null, "conductor", "done", null, emptyList()), at = 101))
            b.chatItems.add(ChatItem.Decision(-102, "req-102", "answered", decisionId = "d-102"))
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val tailGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val syncGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val followupEntered = kotlinx.coroutines.CompletableDeferred<Unit>()
            var gated = false
            var followupSignaled = false
            b.hub.responder = { method, params ->
                when {
                    method == "room.sync" -> {
                        if (!gated) { gated = true; entered.complete(Unit); tailGate.await() }
                        else { if (!followupSignaled) { followupSignaled = true; followupEntered.complete(Unit) }; syncGate.await() }
                        buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    }
                    method.endsWith("history") -> {
                        if (!gated) { gated = true; entered.complete(Unit); tailGate.await() }
                        else { if (!followupSignaled) { followupSignaled = true; followupEntered.complete(Unit) }; syncGate.await() }
                        val rows = if (params["entryIds"] != null) listOf(prow(103, "p-103", "done", 103))
                            else listOf(prow(103, "p-103", "running", 103), frow(101, "f-101", "done", 101), drow(102, "req-102", "answered", 102))
                        buildJsonObject { put("entries", JsonArray(rows)); put("hasMore", false) }
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.coroutineScope {
                    val job = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { b.recoverScope("room:r1") }
                    entered.await()
                    val idx = b.chatItems.indexOfFirst { it is ChatItem.Process && it.processId == "p-103" }
                    b.chatItems[idx] = (b.chatItems[idx] as ChatItem.Process).copy(status = "done", turnEndAt = 105)
                    b.deliveryRecovery.changed("room:r1")
                    tailGate.complete(Unit)
                    followupEntered.await()
                    val mid = b.chatItems.filterIsInstance<ChatItem.Process>().single { it.processId == "p-103" }
                    check(mid.status == "done") { "tail 应用后 process 保持 done: \${mid.status}" }
                    check(b.chatItems.any { it is ChatItem.Flow && it.flowId == "f-101" }) { "terminal flow 不丢" }
                    check(b.chatItems.any { it is ChatItem.Decision && it.requestId == "req-102" }) { "decision 不丢" }
                    syncGate.complete(Unit)
                    job.await()
                }
            }
            check(b.chatItems.filterIsInstance<ChatItem.Process>().single { it.processId == "p-103" }.status == "done") { "最终 process done" }
        } finally { b.close() }
    }
    scenario("recovery_race_targeted_entryids") {
        val b = TimelineBridge()
        try {
            b.liveScope = "room:r1"
            b.chatItems.clear()
            b.chatItems.add(ChatItem.Process(-103, at = 103, processId = "p-103", status = "running", turnStartAt = 90, turnEndAt = 0))
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val entryGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val syncGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val syncEntered = kotlinx.coroutines.CompletableDeferred<Unit>()
            var entryCalls = 0
            b.hub.responder = { method, params ->
                when {
                    method == "room.sync" -> {
                        syncEntered.complete(Unit)
                        syncGate.await()
                        buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    }
                    method.endsWith("history") -> {
                        if (params["entryIds"] != null) {
                            entryCalls++
                            if (entryCalls == 1) { entered.complete(Unit); entryGate.await() }
                            buildJsonObject { put("entries", JsonArray(listOf(prow(103, "p-103", "running", 103)))); put("hasMore", false) }
                        } else {
                            buildJsonObject { put("entries", JsonArray(listOf(prow(103, "p-103", "running", 103)))); put("hasMore", false) }
                        }
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.coroutineScope {
                    val job = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { b.recoverScope("room:r1") }
                    entered.await()
                    val idx = b.chatItems.indexOfFirst { it is ChatItem.Process && it.processId == "p-103" }
                    b.chatItems[idx] = (b.chatItems[idx] as ChatItem.Process).copy(status = "done", turnEndAt = 105)
                    b.deliveryRecovery.changed("room:r1")
                    entryGate.complete(Unit)
                    syncEntered.await()
                    check(b.chatItems.filterIsInstance<ChatItem.Process>().single { it.processId == "p-103" }.status == "done") { "entryIds 校准期间 process 保持 done" }
                    syncGate.complete(Unit)
                    job.await()
                }
            }
            check(b.chatItems.filterIsInstance<ChatItem.Process>().single { it.processId == "p-103" }.status == "done") { "最终 process done" }
        } finally { b.close() }
    }
    scenario("recovery_race_initial_anchor") {
        val b = TimelineBridge()
        try {
            b.liveScope = "room:r1"
            b.chatItems.clear()
            b.chatItems.add(ChatItem.Process(-50, at = 90, processId = "p-50", status = "running", turnStartAt = 40, turnEndAt = 0))
            b.chatItems.add(ChatItem.Assistant(999, "normal-only", "worker", at = 999))
            check(b.chatItems.any { it is ChatItem.Assistant && it.id == 999L }) { "前置：normal-only 999 存在" }
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val anchorGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val followupEntered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val followupGate = kotlinx.coroutines.CompletableDeferred<Unit>()
            var phase = 0
            b.hub.responder = { method, params ->
                when {
                    method == "room.sync" -> {
                        if (phase == 2) { followupEntered.complete(Unit); followupGate.await() }
                        buildJsonObject { put("flow", JsonNull); put("mode", "conductor"); put("cards", JsonArray(emptyList())) }
                    }
                    params["anchorAt"] != null -> {
                        if (phase == 0) {
                            phase = 1
                            entered.complete(Unit)
                            anchorGate.await()
                            phase = 2
                        }
                        buildJsonObject {
                            put("entries", JsonArray(listOf(prow(50, "p-50", "running", 90), frow(51, "f-51", "done", 96)))); put("hasMore", false)
                        }
                    }
                    method.endsWith("history") -> {
                        if (phase == 2) { followupEntered.complete(Unit); followupGate.await() }
                        buildJsonObject {
                            put("entries", JsonArray(listOf(prow(50, "p-50", "done", 90)))); put("hasMore", false)
                        }
                    }
                    else -> buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
                }
            }
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.coroutineScope {
                    val job = async(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { b.loadHistoryPub("room.history", "roomId", "r1", 200) }
                    entered.await()
                    val idx = b.chatItems.indexOfFirst { it is ChatItem.Process && it.processId == "p-50" }
                    if (idx >= 0) b.chatItems[idx] = (b.chatItems[idx] as ChatItem.Process).copy(status = "done", turnEndAt = 105)
                    else b.chatItems.add(ChatItem.Process(-50, at = 90, processId = "p-50", status = "done", turnStartAt = 40, turnEndAt = 105))
                    b.deliveryRecovery.changed("room:r1")
                    anchorGate.complete(Unit)
                    followupEntered.await()
                    val win50 = b.chatItems.filterIsInstance<ChatItem.Process>().singleOrNull { it.processId == "p-50" }
                    check(win50?.status == "done") { "anchor 窗口 process 保持 done: \${win50?.status}" }
                    check(b.chatItems.any { it is ChatItem.Flow && it.flowId == "f-51" }) { "anchor 页 terminal flow 存在" }
                    check(b.chatItems.none { it is ChatItem.Assistant && it.id == 999L }) { "anchor 窗口不含 normal-only 999" }
                    followupGate.complete(Unit)
                    job.await()
                }
            }
            check(b.chatCache["room:r1"]?.any { it is ChatItem.Assistant && it.id == 999L } == true) { "normal cache 保留 999" }
            check(b.chatCache["room:r1"]?.any { it is ChatItem.Process && it.processId == "p-50" } == true) { "normal cache 保留 p-50" }
            check(b.chatCache["room:r1"]?.none { it is ChatItem.Flow && it.flowId == "f-51" } == true) { "anchor 页 f-51 不污染 normal cache" }
        } finally { b.close() }
    }
    check(count == 36)
    println("RESULT cases=$count")
}
`;
