import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = [
  "durability", "fifo", "uncertain_barrier", "identity_fences", "dismiss_and_bulk",
  "context_and_busy", "codec", "bounds_and_snapshot", "attachment_tombstone",
  "receipt_cleanup_failure", "lifecycle_and_fast_worker", "expiry_and_protocol",
  "recovery_watermarks", "recovery_reset_and_draft", "recovery_fences",
  "viewmodel_context", "viewmodel_payload", "session_cards",
  "attention_identity", "attention_recovery", "attention_limits",
  "viewmodel_anchor", "stream_scope",
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
  const recovery = vm.slice(vm.indexOf("private fun startDeliveryRecovery("), vm.indexOf("fun retryDeliveryRecovery("));
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
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
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
    section("    private fun queueChunk(", "    private fun applyUpdate("),
  ].join("\n");
  fs.writeFileSync(bridge, bridgeFixture.replace("__NATIVE_METHODS__", methods));
  fs.writeFileSync(strings, stringsStub);
  fs.writeFileSync(fixture, kotlinFixture);
  execFileSync(java, ["-Xmx512m", "-cp", jars.join(path.delimiter),
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", runtime,
    "-jvm-target", "17", "-d", output,
    ...["HubClient.kt", "DeliveryOutbox.kt"].map((name) =>
      path.join(root, "android", "app", "src", "main", "java", "com", "agenthub", name)),
    strings, fixture, bridge, attention], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
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
  assert.match(result, /^RESULT cases=23$/m);
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
}
object ZhStrings : Strings {
  override val connectFailed = "connection"
  override val connectionAuthFailed = "auth"
  override val connectionPolicyRejected = "policy"
  override val connectionInvalidAddress = "config"
  override val deliveryAttachmentFmt = "\\nAttachment: %s\\n%s"
}
`;

const bridgeFixture = String.raw`
import com.agenthub.*
import com.agenthub.ui.Strings
import com.agenthub.ui.ZhStrings
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

internal data class FlowTask(val waitingFor: String?, val waitingHelpId: String?)
internal data class FlowInfo(val flowId: String, val missionId: String?, val mode: String, val phase: String,
    val clarificationId: String?, val tasks: List<FlowTask>)
internal data class RoomInfo(val roomId: String, val members: List<Pair<String, String>> = listOf("s1" to "worker"))
internal data class Attachment(val mimeType: String, val base64: String, val name: String, val localPath: String? = null)
internal sealed class ChatItem {
    abstract val id: Long
    data class Assistant(override val id: Long, val text: String, val author: String) : ChatItem()
    data class Thought(override val id: Long, val text: String, val author: String) : ChatItem()
    data class Permission(override val id: Long, val requestId: String) : ChatItem()
    data class Decision(override val id: Long, val requestId: String) : ChatItem()
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
}
internal class NativeBridge {
    val viewModelScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    var anchorScopeKey: String? = null
    var liveScope = "room:r1"
    var historyHasMore = true
    val chatItems = mutableListOf<ChatItem>()
    val chatCache = mutableMapOf<String, List<ChatItem>>()
    var itemSeq = 5000L
    private val streamRuns = mutableListOf<StreamRun>()
    private var streamFlushJob: Job? = null
    private var streamingTail: Pair<String, Long>? = null
    fun scopeKey(): String? = liveScope
    fun sameHistoryItem(a: ChatItem, b: ChatItem) = a.id == b.id
    fun inScope(sid: String) = sid == "s1"
    fun shouldShowInRoom(sid: String) = true
    fun sessionName(sid: String) = "worker"
    fun frame(body: () -> Unit) = withLiveItems(body)
    fun chunk(text: String) = queueChunk("s1", "m", text)
    fun flush() = flushStreamChunks()
    fun close() = viewModelScope.cancel()
    val hub = BridgeHub()
    var deliveryReady = true
    var missionConnectionGeneration = 1
    var profileEpoch = 1
    var deliveryOrigin = ORIGIN
    var deliveryHubId = "h1"
    val rooms = listOf(RoomInfo("r1"))
    val calls = mutableListOf<String>()
    var snapshot: JsonObject = snap(null)
    val attachAllowedExt = setOf("txt", "md")
    private val recovery = DeliveryRecovery(
        { method, _ ->
            calls.add(method)
            if (method == "room.sync") snapshot
            else buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
        }, { _, _, _, _ -> }, { _, _ -> }, { emptyList() }, { },
    )
    fun currentConnection(epoch: Int, generation: Int) =
        hub.isConnected && profileEpoch == epoch && missionConnectionGeneration == generation
    suspend fun recoverScope(key: String) = recovery.recover(key, 1) { hub.isConnected }
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
    check(b.calls.first() == "room.history" && b.calls.last() == "room.sync")
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
    scenario("uncertain_barrier") {
        val e = env(); e.bind(true)
        var receipt = "not_found"
        e.receiver = { method, p ->
            if (method == "client.message.status") status(receipt)
            else if (cid(p) == "a") status("uncertain") else accepted()
        }
        check(e.box.enqueue(rec("a"))); until { e.updates["a"]?.status == "uncertain" }
        check(e.box.enqueue(rec("b"))); e.box.resume()
        until { e.queries().size == 1 }; repeat(3) { e.box.resume(); flush() }
        check(e.queries().size == 1)
        check(e.sends().map { cid(it.second) } == listOf("a"))
        receipt = "accepted"; e.box.check("a"); until { e.box.records.isEmpty() }
        check(e.queries().size == 2)
        check(e.sends().map { cid(it.second) } == listOf("a", "b"))
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
        val e = env(); e.bind(true); e.validator = { "context" }
        check(e.box.enqueue(rec("a"))); until { e.updates["a"]?.status == "failed" }
        check(e.box.enqueue(rec("b"))); flush()
        check(e.calls.isEmpty())
        val stored = e.gate(); var busySeen = false
        e.validator = { busySeen = true; "busy" }
        e.writer = { raw ->
            if (busySeen && Json.parseToJsonElement(raw).jsonObject["entries"]!!.jsonArray.any {
                it.jsonObject["status"]!!.jsonPrimitive.content == "pending"
            }) stored.await()
            true
        }
        check(e.box.dismiss("a"))
        until { busySeen }
        check(e.box.records.single().status == "pending" && e.calls.isEmpty())
        e.validator = { null }; e.box.resume(); stored.complete(Unit); until { e.box.records.isEmpty() }
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
        restored.receiver = { m, _ -> check(m == "client.message.status"); status("not_found") }
        restored.bind(true); until { restored.queries().size == 1 }; flush()
        check(restored.sends().isEmpty() && restored.box.records.single().status == "uncertain")
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
        val requests = mutableListOf<Long>()
        val applied = mutableMapOf<Long, JsonObject>()
        var synchronized = false
        val recovery = DeliveryRecovery(
            { method, p ->
                if (method == "room.sync") {
                    check(applied.keys.containsAll((101L..150L).toList()))
                    synchronized = true
                    buildJsonObject { put("mode", "conductor"); put("flow", JsonNull); put("cards", JsonArray(emptyList())) }
                } else {
                    val after = p["afterId"]!!.jsonPrimitive.long
                    requests.add(after)
                    val batch = (101L..150L).filter { it > after }.take(2)
                    buildJsonObject {
                        put("entries", JsonArray(batch.map { hrow(it) })); put("hasMore", batch.lastOrNull()?.let { it < 150L } ?: false)
                    }
                }
            },
            { _, rows, reset, _ -> if (reset) applied.clear(); rows.forEach { applied[it["id"]!!.jsonPrimitive.long] = it } },
            { _, _ -> }, { emptyList() }, { error("unexpected reset") },
        )
        recovery.remember("room:r1", listOf(hrow(100)), baseline = true)
        recovery.changed("room:r1")
        recovery.remember("room:r1", listOf(hrow(150)))
        check(recovery.cursor("room:r1") == 100L)
        recovery.recover("room:r1", 1) { true }
        check(requests.first() == 100L && requests.last() == 148L)
        check(applied.keys.size == 50 && recovery.cursor("room:r1") == 150L && synchronized)
    }
    scenario("recovery_reset_and_draft") {
        val requests = mutableListOf<Long>()
        val applied = mutableMapOf<Long, JsonObject>()
        var resets = 0
        var draftReads = 0
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
                    val after = p["afterId"]!!.jsonPrimitive.long
                    requests.add(after)
                    when (after) {
                        999L -> buildJsonObject { put("entries", JsonArray(emptyList())); put("truncated", true) }
                        0L -> buildJsonObject { put("entries", JsonArray(listOf(hrow(1), hrow(2, "partial", 1)))); put("hasMore", true) }
                        2L -> buildJsonObject {
                            put("entries", JsonArray(listOf(buildJsonObject {
                                put("id", 3); put("at", 3); put("kind", "flow"); put("text", "working"); put("draft", 0)
                            }))); put("hasMore", false)
                        }
                        else -> error("bad cursor")
                    }
                }
            },
            { _, rows, reset, _ -> if (reset) { applied.clear(); resets++ }; rows.forEach { applied[it["id"]!!.jsonPrimitive.long] = it } },
            { _, _ -> }, { emptyList() }, { },
        )
        recovery.remember("room:r1", listOf(hrow(999)), baseline = true)
        recovery.recover("room:r1", 1) { true }
        check(requests == listOf(999L, 0L, 2L) && resets == 1 && recovery.cursor("room:r1") == 3L)
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
            { _, _, _, _ -> changes++ }, { _, _ -> changes++ }, { emptyList() }, { },
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
                } else buildJsonObject { put("entries", JsonArray(emptyList())); put("hasMore", false) }
            },
            { _, _, _, _ -> }, { _, _ -> snapshots++ }, { emptyList() }, { },
        )
        recovery.remember("room:r1", listOf(hrow(100)), baseline = true)
        recovery.recover("room:r1", 1) { true }
        check(attempts == 3 && snapshots == 1 && recovery.cursor("room:r1") == 100L)
        val first = CompletableDeferred<Unit>()
        var loading = false
        val cursors = mutableListOf<Long>()
        val merged = mutableSetOf<Long>()
        val concurrent = DeliveryRecovery(
            { _, p ->
                if (p["afterId"] == null) {
                    loading = true; first.await()
                    buildJsonObject { put("entries", JsonArray((1L..100L).map { hrow(it) })) }
                } else {
                    val after = p["afterId"]!!.jsonPrimitive.long; cursors.add(after)
                    buildJsonObject { put("entries", JsonArray((101L..350L).filter { it > after }.map { hrow(it) })); put("hasMore", false) }
                }
            },
            { _, rows, _, _ -> rows.forEach { merged.add(it["id"]!!.jsonPrimitive.long) } },
            { _, _ -> }, { emptyList() }, { },
        )
        val cold = async { concurrent.recover("session:s1", 1) { true } }
        until { loading }
        concurrent.remember("session:s1", (151L..350L).map { hrow(it) }, baseline = true)
        first.complete(Unit); cold.await()
        check(cursors.first() == 100L && merged.containsAll((101L..350L).toList()))
        check(concurrent.cursor("session:s1") == 350L)
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
            { _, rows, _, _ -> if (rows.any { it["text"]?.jsonPrimitive?.content == "answered" }) refreshed = true },
            { _, _ -> error("session must not request room state") }, { listOf(12) }, { },
        )
        recovery.remember("session:s1", listOf(hrow(100)), baseline = true)
        recovery.recover("session:s1", 1) { true }
        check(refreshed && recovery.cursor("session:s1") == 100L)
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
        } finally { b.close() }
    }
    check(count == 23)
    println("RESULT cases=$count")
}
`;
