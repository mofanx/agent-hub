import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cases = [
  "handshake_cancel", "retry_handshake_kick", "stale_callbacks", "network_replace",
  "explicit_disconnect", "auth_policy", "manual_after_terminal", "invalid_config_and_factory_throw",
  "fast_factory", "send_false", "timeout_cleanup", "rpc_error_payload",
  "event_order_and_generation", "scope_cancel_cleanup",
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

test("Android HubClient: real JVM source with fake WebSockets", { timeout: 120_000 }, (t) => {
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hub-android-client-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = jars.slice(0, 7).join(path.delimiter);
  const output = path.join(directory, "out");
  const strings = path.join(directory, "Strings.kt");
  const fixture = path.join(directory, "Test.kt");
  fs.writeFileSync(strings, stringsStub);
  fs.writeFileSync(fixture, kotlinFixture);
  execFileSync(java, ["-Xmx512m", "-cp", jars.join(path.delimiter),
    "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", runtime,
    "-jvm-target", "17", "-d", output,
    path.join(root, "android", "app", "src", "main", "java", "com", "agenthub", "HubClient.kt"),
    strings, fixture], { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
  const result = execFileSync(java, ["-cp", [output, runtime].join(path.delimiter), "TestKt"],
    { encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"] });
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
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*
import okhttp3.*
import okio.ByteString
import java.io.IOException
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

class FakeWS(val req: Request, val listener: WebSocketListener) : WebSocket {
    val sent = mutableListOf<String>()
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
    fun id(index: Int = sent.lastIndex) = Json.parseToJsonElement(sent[index]).jsonObject["id"]!!.jsonPrimitive.int
    fun result(id: Int) = message(buildJsonObject { put("id", id); put("result", buildJsonObject { put("ok", true) }) })
    fun event(value: String) = message(buildJsonObject { put("method", value) })
}
suspend fun until(predicate: () -> Boolean) {
    withTimeout(5000) { while (!predicate()) { yield(); delay(1) } }
}
suspend fun flush() { repeat(5) { yield() } }
class Fix(context: CoroutineContext, immediate: Boolean = false, val factoryMode: String = "") {
    val scope = CoroutineScope(context.minusKey(Job) + SupervisorJob() + if (immediate) Dispatchers.Unconfined else EmptyCoroutineContext)
    val sockets = mutableListOf<FakeWS>()
    var closed = 0
    var opened = 0
    var error: String? = null
    var onLoss: () -> Unit = {}
    val client = HubClient(scope, { request, listener ->
        if (factoryMode == "throw") throw IllegalArgumentException("fixture")
        FakeWS(request, listener).also {
            sockets.add(it)
            if (factoryMode == "open") it.open()
            if (factoryMode == "fail") listener.onFailure(it, IOException("fixture"), it.response(401))
        }
    })
    init { client.onClosed = { closed++; onLoss() } }
    fun connect(url: String = "wss://fixture.invalid") = client.connect(url, onOpen = { opened++ }, onFailure = { error = it })
    suspend fun start(open: Boolean = true): FakeWS {
        val count = sockets.size
        connect()
        until { sockets.size > count }
        val socket = sockets.last()
        if (open) { socket.open(); until { client.isConnected } }
        return socket
    }
    fun pending(): Int {
        val field = HubClient::class.java.getDeclaredField("pending").apply { isAccessible = true }
        return (field.get(client) as Map<*, *>).size
    }
    suspend fun dispose() { client.disconnect(); flush(); scope.cancel(); flush() }
}
suspend fun fixture(context: CoroutineContext, immediate: Boolean = false, mode: String = "", block: suspend (Fix) -> Unit) {
    val f = Fix(context, immediate, mode)
    try { block(f) } finally { f.dispose() }
}
fun main() = runBlocking {
    var passed = 0
    suspend fun case(name: String, block: suspend () -> Unit) {
        block()
        passed++
        println("PASS " + name)
    }
    case("handshake_cancel") {
        fixture(coroutineContext) { f ->
            val old = f.start(false)
            f.client.disconnect()
            val next = f.start(false)
            old.open()
            next.open()
            until { f.client.isConnected }
            check(old.canceled > 0 && f.sockets.size == 2)
        }
    }
    case("retry_handshake_kick") {
        fixture(coroutineContext) { f ->
            val old = f.start()
            old.listener.onFailure(old, IOException("lost"), null)
            until { f.client.state == HubConnectionState.Reconnecting }
            f.client.kickReconnect()
            until { f.sockets.size == 2 }
            repeat(8) { f.client.kickReconnect() }
            flush()
            check(f.sockets.size == 2 && f.client.state == HubConnectionState.Connecting)
            f.sockets.last().open()
            until { f.client.isConnected }
        }
    }
    case("stale_callbacks") {
        fixture(coroutineContext) { f ->
            val old = f.start()
            f.client.disconnect()
            val next = f.start(false)
            old.open()
            flush()
            check(!f.client.isConnected)
            next.open()
            until { f.client.isConnected }
            val response = f.scope.async { f.client.call("fixture") }
            until { f.pending() == 1 }
            val id = next.id()
            val closed = f.closed
            val worker = Thread { old.result(id) }
            worker.start()
            worker.join()
            old.listener.onFailure(old, IOException("stale"), null)
            old.listener.onClosing(old, 4001, "stale auth")
            old.listener.onClosed(old, 1008, "stale policy")
            flush()
            check(response.isActive && f.pending() == 1 && f.closed == closed && f.client.isConnected)
            next.result(id)
            check(response.await()["ok"]!!.jsonPrimitive.boolean)
        }
    }
    case("network_replace") {
        fixture(coroutineContext) { f ->
            val first = f.start()
            f.client.onNetworkChanged(1)
            f.client.onNetworkChanged(1)
            flush()
            check(f.sockets.size == 1)
            f.client.onNetworkChanged(2)
            until { f.sockets.size == 2 }
            val handshake = f.sockets.last()
            check(first.canceled > 0)
            f.client.onNetworkChanged(3)
            until { f.sockets.size == 3 }
            check(handshake.canceled > 0)
            f.client.onNetworkChanged(3)
            flush()
            check(f.sockets.size == 3)
            handshake.open()
            f.sockets.last().open()
            until { f.client.isConnected }
        }
    }
    case("explicit_disconnect") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            f.client.disconnect()
            flush()
            f.client.onNetworkChanged(1)
            f.client.onNetworkChanged(2)
            f.client.kickReconnect()
            flush()
            check(f.sockets.size == 1 && socket.canceled > 0 && f.client.state == HubConnectionState.Disconnected)
        }
    }
    case("auth_policy") {
        for (kind in listOf("401", "403", "closing4001", "closed4001", "token", "policy")) {
            fixture(coroutineContext) { f ->
                val socket = f.start(kind != "401" && kind != "403")
                when (kind) {
                    "401", "403" -> socket.listener.onFailure(socket, IOException("fixture-secret"), socket.response(kind.toInt()))
                    "closing4001" -> {
                        socket.listener.onClosing(socket, 4001, "auth")
                        socket.listener.onClosed(socket, 4001, "auth")
                    }
                    "closed4001" -> socket.listener.onClosed(socket, 4001, "auth")
                    "token" -> socket.listener.onClosed(socket, 1008, "Invalid token")
                    else -> socket.listener.onClosed(socket, 1008, "Rate limited")
                }
                until { f.client.state.terminal }
                check(f.client.state == if (kind == "policy") HubConnectionState.PolicyRejected else HubConnectionState.AuthFailed)
                check(f.closed == 1 && f.error == if (kind == "policy") "policy" else "auth")
                f.client.onNetworkChanged(1)
                f.client.onNetworkChanged(2)
                f.client.kickReconnect()
                flush()
                check(f.sockets.size == 1)
            }
        }
    }
    case("manual_after_terminal") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            socket.listener.onClosed(socket, 4001, "auth")
            until { f.client.state.terminal }
            f.start()
            check(f.sockets.size == 2 && f.client.isConnected)
        }
    }
    case("invalid_config_and_factory_throw") {
        fixture(coroutineContext) { f ->
            f.connect("invalid")
            until { f.client.state == HubConnectionState.InvalidConfig }
            check(f.error == "config" && f.sockets.isEmpty())
        }
        fixture(coroutineContext, mode = "throw") { f ->
            f.connect()
            until { f.client.state == HubConnectionState.InvalidConfig }
            check(f.error == "config" && f.sockets.isEmpty())
        }
    }
    case("fast_factory") {
        fixture(coroutineContext, true, "open") { f ->
            f.connect()
            until { f.client.isConnected }
            check(f.opened == 1 && f.sockets.size == 1)
        }
        fixture(coroutineContext, true, "fail") { f ->
            f.connect()
            until { f.client.state == HubConnectionState.AuthFailed }
            check(f.closed == 1 && f.sockets.single().canceled > 0)
        }
    }
    case("send_false") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            var failureAfterClose = false
            val first = f.scope.async {
                runCatching { f.client.call("first") }.also { failureAfterClose = f.closed > 0 }
            }
            until { f.pending() == 1 }
            socket.failSend = true
            val second = f.scope.async { runCatching { f.client.call("second") } }
            check(second.await().isFailure && first.await().isFailure && failureAfterClose)
            check(f.pending() == 0 && socket.canceled > 0)
            f.client.kickReconnect()
            until { f.sockets.size == 2 }
        }
    }
    case("timeout_cleanup") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            val timed = f.scope.async { runCatching { f.client.call("timeout", timeoutMs = 40) } }
            check(timed.await().exceptionOrNull() is TimeoutCancellationException)
            check(f.pending() == 0 && socket.sent.size == 1)
            val canceled = f.scope.async { f.client.call("cancel") }
            until { f.pending() == 1 }
            canceled.cancelAndJoin()
            until { f.pending() == 0 }
            check(f.client.isConnected)
        }
    }
    case("rpc_error_payload") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            val errors = listOf<JsonElement>(
                JsonPrimitive("denied"),
                buildJsonObject { put("message", "denied"); put("code", 7) },
                buildJsonObject { put("message", buildJsonObject { put("detail", "denied") }) },
            )
            for (payload in errors) {
                val response = f.scope.async { runCatching { f.client.call("error") } }
                until { f.pending() == 1 }
                socket.message(buildJsonObject { put("id", socket.id()); put("error", payload) })
                val failure = response.await().exceptionOrNull()
                check(failure is HubRpcException && failure.payload == payload)
                check(f.client.isConnected && f.closed == 0 && f.pending() == 0)
            }
        }
    }
    case("event_order_and_generation") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            val seen = mutableListOf<String>()
            val gate = CompletableDeferred<Unit>()
            val collector = f.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                f.client.events.collect {
                    val value = it["method"]!!.jsonPrimitive.content
                    seen.add(value)
                    if (value == "old-0") gate.await()
                }
            }
            repeat(650) { socket.event("old-" + it) }
            until { seen.size == 1 }
            flush()
            f.onLoss = { collector.cancel() }
            f.client.disconnect()
            flush()
            val next = f.start()
            val fresh = mutableListOf<String>()
            val newCollector = f.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                f.client.events.collect { fresh.add(it["method"]!!.jsonPrimitive.content) }
            }
            repeat(20) { next.event("new-" + it) }
            until { fresh.size >= 20 }
            check(fresh == (0 until 20).map { "new-" + it })
            check(seen == listOf("old-0"))
            newCollector.cancelAndJoin()
        }
    }
    case("scope_cancel_cleanup") {
        fixture(coroutineContext) { f ->
            val socket = f.start()
            f.scope.cancel()
            val sent = socket.sent.size
            check(runCatching { f.client.call("disposed") }.isFailure)
            check(socket.sent.size == sent)
            f.client.disconnect()
            until { socket.canceled > 0 }
            check(!f.client.isConnected)
        }
    }
    println("RESULT cases=" + passed)
}
`;
