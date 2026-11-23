import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");

const cases = [
  "select_cap_mru", "reconcile_starts_links", "active_excluded_and_swapped",
  "reconcile_removes_stale", "sync_badge_flow", "event_decision_badge",
  "disconnect_keeps_badge", "token_change_rebuilds", "close_all",
  "dead_link_yields", "dead_link_refill", "dead_link_revives",
  "link_takeover", "takeover_survives_scope",
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

test("Android HubLinkManager: real JVM source with fake WebSockets", { timeout: 150_000 }, (t) => {
  const versions = fs.readFileSync(path.join(root, "android", "gradle", "libs.versions.toml"), "utf8");
  const version = (key: string) => {
    const match = versions.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
    assert.ok(match, `missing Android version: ${key}`);
    return match[1];
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-android-links-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = jars.slice(0, 7).join(path.delimiter);
  const output = path.join(directory, "out");
  const strings = path.join(directory, "Strings.kt");
  const fixture = path.join(directory, "Test.kt");
  const attention = path.join(directory, "Attention.kt");
  const notifier = fs.readFileSync(path.join(root, "android/app/src/main/java/com/agenthub/Notifier.kt"), "utf8");
  const pure = notifier.slice(notifier.indexOf("internal data class AttentionTarget"), notifier.indexOf("object Notifier"));
  assert.ok(pure.includes("internal class AttentionLedger"));
  fs.writeFileSync(attention, "package com.agenthub\nimport kotlinx.serialization.json.*\n" +
    "import kotlinx.coroutines.NonCancellable\nimport kotlinx.coroutines.withContext\n" +
    "import kotlinx.coroutines.sync.Mutex\nimport kotlinx.coroutines.sync.withLock\n" + pure);
  fs.writeFileSync(strings, stringsStub);
  fs.writeFileSync(fixture, kotlinFixture);
  execFileSync(java, ["-Xmx512m", "-cp", jars.join(path.delimiter),
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", runtime,
    "-jvm-target", "17", "-d", output,
    ...["HubClient.kt", "HubLinkManager.kt", "DeliveryOutbox.kt"].map((name) =>
      path.join(root, "android", "app", "src", "main", "java", "com", "agenthub", name)),
    strings, fixture, attention], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
  let result: string;
  try {
    result = execFileSync(java, ["-cp", [output, runtime].join(path.delimiter), "TestKt"],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) t.diagnostic(String(stdout).trim());
    throw error;
  }
  assert.deepEqual(result.split(/\r?\n/).filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5)), cases);
  assert.match(result, /^RESULT cases=14$/m);
  t.diagnostic(result.trim());
});

const stringsStub = `
package com.agenthub.ui
interface Strings {
  val connectFailed: String
  val connectionAuthFailed: String
  val connectionPolicyRejected: String
  val connectionInvalidAddress: String
  val networkMonitoringUnavailable: String
  val backgroundConnectionUnavailable: String
  val backgroundConnectionTimeout: String
}
object ZhStrings : Strings {
  override val connectFailed = "connection"
  override val connectionAuthFailed = "auth"
  override val connectionPolicyRejected = "policy"
  override val connectionInvalidAddress = "config"
  override val networkMonitoringUnavailable = "network"
  override val backgroundConnectionUnavailable = "background"
  override val backgroundConnectionTimeout = "timeout"
}
`;

const kotlinFixture = String.raw`
import com.agenthub.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

class FakeWS(val req: Request, val listener: WebSocketListener) : WebSocket {
    val sent = mutableListOf<String>()
    var cursor = 0
    var canceled = 0
    var failSend = false
    override fun request() = req
    override fun queueSize() = 0L
    override fun send(text: String): Boolean { sent.add(text); return !failSend }
    override fun send(bytes: ByteString) = !failSend
    override fun close(code: Int, reason: String?) = true
    override fun cancel() { canceled++ }
    fun response(code: Int) = Response.Builder().request(req).protocol(Protocol.HTTP_1_1).message("fixture").code(code).build()
    fun open() = listener.onOpen(this, response(101))
    fun message(value: JsonObject) = listener.onMessage(this, value.toString())
    fun fail() = listener.onFailure(this, IOException("lost"), null)
    fun answer(handler: (String, JsonObject) -> JsonObject) {
        while (cursor < sent.size) {
            val msg = Json.parseToJsonElement(sent[cursor]).jsonObject
            cursor++
            val id = msg["id"]!!.jsonPrimitive.int
            val method = msg["method"]!!.jsonPrimitive.content
            val params = (msg["params"] as? JsonObject) ?: buildJsonObject {}
            message(buildJsonObject { put("id", id); put("result", handler(method, params)) })
        }
    }
}

suspend fun until(predicate: () -> Boolean) {
    withTimeout(8000) { while (!predicate()) { yield(); delay(2) } }
}
suspend fun flush() { repeat(5) { yield() } }

internal class Env(context: CoroutineContext, maxLinks: Int = 3, deadThreshold: Int = 5, deadCooldownMs: Long = 120_000) {
    val scope = CoroutineScope(context.minusKey(Job) + SupervisorJob() + EmptyCoroutineContext)
    // 镜像生产 linkScope：进程级——service(scope) 取消不影响已建链路 client
    val linkScope = CoroutineScope(context.minusKey(Job) + SupervisorJob() + EmptyCoroutineContext)
    val sockets = mutableListOf<FakeWS>()
    var now = 0L
    val manager = HubLinkManager(scope, {
        HubClient(linkScope, { req, l -> FakeWS(req, l).also { sockets.add(it) } })
    }, maxLinks = maxLinks, staggerMs = 0, retryMs = 60_000,
        deadThreshold = deadThreshold, deadCooldownMs = deadCooldownMs, nowMs = { now })

    fun target(key: String) = LinkTarget(key, "wss://fixture.invalid/$key", "pub-$key", "origin-$key")

    suspend fun linkSocket(key: String): FakeWS {
        until { sockets.isNotEmpty() }
        return sockets.last()
    }

    suspend fun sync(linkKey: String, ws: FakeWS, handler: (String, JsonObject) -> JsonObject) {
        var guard = 0
        while (guard++ < 60) {
            ws.answer(handler)
            val link = manager.link(linkKey)
            if (link != null && link.ready) break
            delay(15)
        }
        until { manager.link(linkKey)?.ready == true }
    }

    suspend fun dispose() { manager.closeAll(); flush(); scope.cancel(); linkScope.cancel(); flush() }
}

internal fun hubHandler(hubId: String, flow: JsonObject? = null, decisions: JsonArray = buildJsonArray {}): (String, JsonObject) -> JsonObject = { method, params ->
    when (method) {
        "agent.info" -> buildJsonObject { put("hubId", hubId) }
        "room.list" -> buildJsonObject {
            put("rooms", buildJsonArray { add(buildJsonObject { put("roomId", "r1") }) })
        }
        "room.flow" -> buildJsonObject {
            if (flow == null) put("flow", JsonNull) else put("flow", flow)
        }
        "decision.list" -> buildJsonObject { put("decisions", decisions) }
        else -> buildJsonObject { put("ok", true) }
    }
}

internal val flowWaiting: JsonObject = buildJsonObject {
    put("flowId", "f1")
    put("phase", "running")
    put("startedAt", 1000)
    put("goal", "goal text")
    put("tasks", buildJsonArray {
        add(buildJsonObject {
            put("id", "t1"); put("waitingFor", "user"); put("dispatchedAt", 2000); put("task", "do x")
        })
    })
}

internal fun pendingDecision(id: String = "d1"): JsonObject = buildJsonObject {
    put("decisionId", id); put("requestId", "req-$id"); put("sessionId", "s1")
    put("at", 3000); put("status", "pending"); put("title", "approve x")
}

fun main() = runBlocking {
    var passed = 0
    suspend fun case(name: String, block: suspend () -> Unit) {
        block()
        passed++
        println("PASS " + name)
    }

    case("select_cap_mru") {
        val picked = selectLinkKeys(listOf("a", "b", "c", "d"), "a", listOf("c", "b", "d"), 2)
        check(picked == listOf("c", "b")) { "mru order: $picked" }
        val all = selectLinkKeys(listOf("a", "b"), "a", emptyList(), 3)
        check(all == listOf("b"))
    }

    case("reconcile_starts_links") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1"), env.target("h2")), null, emptyList())
            until { env.sockets.size == 2 }
            check(env.manager.size == 2)
        } finally { env.dispose() }
    }

    case("active_excluded_and_swapped") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1"), env.target("h2")), "h1", emptyList())
            until { env.sockets.size == 1 }
            check(env.manager.link("h1") == null && env.manager.link("h2") != null)
            // 活跃换到 h2：h1 变非活跃补链，h2 链路收编为活跃侧（manager 关链）
            env.manager.reconcile(listOf(env.target("h1"), env.target("h2")), "h2", listOf("h2", "h1"))
            until { env.manager.link("h1") != null && env.manager.link("h2") == null }
            check(env.manager.size == 1)
        } finally { env.dispose() }
    }

    case("reconcile_removes_stale") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1"), env.target("h2")), null, emptyList())
            until { env.sockets.size == 2 }
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            until { env.manager.link("h2") == null }
            check(env.manager.link("h1") != null)
            until { env.sockets[1].canceled > 0 }
        } finally { env.dispose() }
    }

    case("sync_badge_flow") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            val ws = env.linkSocket("h1")
            ws.open()
            until { env.manager.link("h1")?.client?.isConnected == true }
            env.sync("h1", ws, hubHandler("hub-1", flowWaiting))
            val targets = env.manager.badges.value["h1"]?.targets ?: error("badge missing")
            check(targets.size == 1 && targets[0].kind == "flow") { "targets=$targets" }
            check(targets[0].extras["navRoomId"] == "r1" && targets[0].extras["navHubId"] == "hub-1")
            check(targets[0].extras["navOrigin"] == "origin-h1")
        } finally { env.dispose() }
    }

    case("event_decision_badge") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            val ws = env.linkSocket("h1")
            ws.open()
            until { env.manager.link("h1")?.client?.isConnected == true }
            env.sync("h1", ws, hubHandler("hub-1"))
            check(env.manager.badges.value["h1"]!!.targets.isEmpty())
            // decision.update pending → +1；resolved → 移除
            ws.message(buildJsonObject {
                put("method", "decision.update")
                put("params", buildJsonObject {
                    put("entry", buildJsonObject { put("text", pendingDecision().toString().let { JsonPrimitive(it) }) })
                })
            })
            until { env.manager.badges.value["h1"]!!.targets.size == 1 }
            check(env.manager.badges.value["h1"]!!.targets[0].kind == "decision")
            ws.message(buildJsonObject {
                put("method", "decision.update")
                put("params", buildJsonObject {
                    put("entry", buildJsonObject {
                        put("text", JsonPrimitive(buildJsonObject {
                            put("decisionId", "d1"); put("requestId", "req-d1"); put("sessionId", "s1")
                            put("at", 3001); put("status", "accepted")
                        }.toString()))
                    })
                })
            })
            until { env.manager.badges.value["h1"]!!.targets.isEmpty() }
        } finally { env.dispose() }
    }

    case("disconnect_keeps_badge") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            val ws = env.linkSocket("h1")
            ws.open()
            until { env.manager.link("h1")?.client?.isConnected == true }
            env.sync("h1", ws, hubHandler("hub-1", flowWaiting))
            check(env.manager.badges.value["h1"]!!.targets.size == 1)
            ws.fail()
            until { env.manager.link("h1")?.ready == false }
            // 徽章保留（陈旧 > 无），ready 翻 false、connected 如实翻 false
            check(env.manager.badges.value["h1"]!!.targets.size == 1)
            check(env.manager.badges.value["h1"]!!.connected == false)
        } finally { env.dispose() }
    }

    case("token_change_rebuilds") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            until { env.sockets.size == 1 }
            val old = env.sockets[0]
            env.manager.reconcile(
                listOf(LinkTarget("h1", "wss://fixture.invalid/h1-v2", "pub-h1", "origin-h1")),
                null, emptyList(),
            )
            until { env.sockets.size == 2 }
            until { old.canceled > 0 }
        } finally { env.dispose() }
    }

    case("close_all") {
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1"), env.target("h2")), null, emptyList())
            until { env.sockets.size == 2 }
            env.manager.closeAll()
            check(env.manager.size == 0)
            until { env.sockets.all { it.canceled > 0 } }
            check(env.manager.badges.value.isEmpty())
        } finally { env.dispose() }
    }

    case("dead_link_yields") {
        // selectLinkKeys：dead 集排尾让位
        check(selectLinkKeys(listOf("a","b","c","d"), null, listOf("a","b","c","d"), 2, dead = setOf("a")) == listOf("b","c"))
        val env = Env(coroutineContext, deadThreshold = 2, deadCooldownMs = 60_000)
        try {
            val targets = listOf(env.target("dead"), env.target("m1"), env.target("m2"), env.target("m3"))
            val mru = listOf("dead", "m1", "m2", "m3")
            env.manager.reconcile(targets, null, mru)
            until { env.sockets.size == 3 }
            check(env.manager.link("m3") == null) { "m3 应在等位" }
            // dead 连败 2 次（每次 fail 后 client 退避自重连产生新 socket）达阈值断路
            env.sockets[0].fail()
            until { env.sockets.size >= 4 }
            env.sockets.last().fail()
            until { (env.manager.link("dead")?.losses ?: 0) >= 2 }
            env.manager.reconcile(targets, null, mru)
            until { env.manager.link("dead") == null }
            until { env.manager.link("m3") != null }
            check(env.manager.size == 3)
        } finally { env.dispose() }
    }

    case("dead_link_refill") {
        val env = Env(coroutineContext, deadThreshold = 1, deadCooldownMs = 50)
        try {
            val targets = listOf(env.target("dead"), env.target("m1"), env.target("m2"), env.target("m3"))
            val mru = listOf("dead", "m1", "m2", "m3")
            env.manager.reconcile(targets, null, mru)
            until { env.sockets.size == 3 }
            env.sockets[0].fail()
            until { (env.manager.link("dead")?.losses ?: 0) >= 1 }
            env.manager.reconcile(targets, null, mru)
            until { env.manager.link("dead") == null && env.manager.link("m3") != null }
            // 冷却过期 → dead 重新入选（MRU 首位）→ 连接成功 → 连败归零、徽章 connected
            env.now += 100
            val socketCount = env.sockets.size
            env.manager.reconcile(targets, null, mru)
            until { env.manager.link("dead") != null }
            until { env.sockets.size > socketCount } // 新链路的 connect 协程产出新 socket
            val ws = env.sockets.last()
            ws.open()
            env.sync("dead", ws, hubHandler("hub-dead"))
            check(env.manager.link("dead")?.connected == true)
            check(env.manager.link("dead")?.losses == 0)
        } finally { env.dispose() }
    }

    case("dead_link_revives") {
        // 冷却到期探针自主复活：不依赖用户切 profile / 手动 reconcile
        val env = Env(coroutineContext, deadThreshold = 1, deadCooldownMs = 50)
        try {
            val targets = listOf(env.target("dead"), env.target("m1"), env.target("m2"), env.target("m3"))
            val mru = listOf("dead", "m1", "m2", "m3")
            env.manager.reconcile(targets, null, mru)
            until { env.sockets.size == 3 }
            env.sockets[0].fail()
            until { (env.manager.link("dead")?.losses ?: 0) >= 1 }
            env.manager.reconcile(targets, null, mru)
            until { env.manager.link("dead") == null && env.manager.link("m3") != null }
            // 不手动 reconcile：deadUntil=50ms 到期后探针自触发对账，dead 自动重建
            env.now += 100
            val socketCount = env.sockets.size
            until { env.manager.link("dead") != null }
            until { env.sockets.size > socketCount }
            val ws = env.sockets.last()
            ws.open()
            env.sync("dead", ws, hubHandler("hub-dead"))
            check(env.manager.link("dead")?.connected == true && env.manager.link("dead")?.losses == 0)
        } finally { env.dispose() }
    }

    case("link_takeover") {
        // ViewModel 免握手接管：take 摘除管理回调并移交 socket；client.connect 对已连+同址幂等激活
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            val ws = env.linkSocket("h1")
            ws.open()
            env.sync("h1", ws, hubHandler("hub-1"))
            check(env.manager.badges.value["h1"]!!.connected)
            val socketCount = env.sockets.size
            val client = env.manager.take("h1")!!
            check(client.isConnected)
            check(env.sockets.size == socketCount)
            check(env.manager.link("h1") == null)
            until { !env.manager.badges.value.containsKey("h1") }
            // 接管后 connect(url, token 相同)：幂等激活——onOpen 直触发、零新 socket
            var opened = false
            client.connect("wss://fixture.invalid/h1", "pub-h1", onOpen = { opened = true }, onFailure = {})
            until { opened }
            check(env.sockets.size == socketCount) { "接管 connect 不应新建 socket" }
            // 断开后事件不再回流 manager（回调已摘除）
            ws.fail()
            flush()
            check(env.manager.link("h1") == null)
        } finally { env.dispose() }
    }

    case("takeover_survives_scope") {
        // 接管后 service scope 整体取消（onDestroy→scope.cancel 模拟）：
        // 被 take 的 client 事件泵/RPC/重连调度不得随 scope 死亡
        val env = Env(coroutineContext)
        try {
            env.manager.reconcile(listOf(env.target("h1")), null, emptyList())
            val ws = env.linkSocket("h1")
            ws.open()
            env.sync("h1", ws, hubHandler("hub-1"))
            val client = env.manager.take("h1")!!
            env.scope.cancel()
            flush()
            // 事件泵：server 推事件 → SharedFlow 发射不被 emissionJob 冻结
            var got = false
            val collector = async { client.events.first(); got = true }
            flush()   // 等订阅注册，防事件先于 collector 到达被丢
            ws.message(buildJsonObject { put("method", "pong"); put("params", buildJsonObject {}) })
            until { got }
            collector.cancel()
            // RPC：scope 死后 call 不抛 disposed，能正常收发
            val deferred = async { client.call("agent.info", buildJsonObject {}) }
            until { ws.cursor < ws.sent.size }   // 等请求真正发出再应答
            ws.answer(hubHandler("hub-1"))
            check(deferred.await()["hubId"]?.jsonPrimitive?.content == "hub-1") { "scope 死后 RPC 应可用" }
            // 重连调度：断线后 reconnectJob 仍产新 socket
            val socketCount = env.sockets.size
            ws.fail()
            until { env.sockets.size > socketCount }
            env.sockets.last().open()
            until { client.isConnected }
        } finally { env.dispose() }
    }

    println("RESULT cases=" + passed)
}
`;
