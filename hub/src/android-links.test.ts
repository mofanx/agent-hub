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
  assert.match(result, /^RESULT cases=9$/m);
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

internal class Env(context: CoroutineContext, maxLinks: Int = 3) {
    val scope = CoroutineScope(context.minusKey(Job) + SupervisorJob() + EmptyCoroutineContext)
    val sockets = mutableListOf<FakeWS>()
    val manager = HubLinkManager(scope, {
        HubClient(scope, { req, l -> FakeWS(req, l).also { sockets.add(it) } })
    }, maxLinks = maxLinks, staggerMs = 0, retryMs = 60_000)

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

    suspend fun dispose() { manager.closeAll(); flush(); scope.cancel(); flush() }
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

    println("RESULT cases=" + passed)
}
`;
