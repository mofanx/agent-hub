import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpAgent,
  normalizeElicitationFields,
  sliceTextFile,
  type HubEvent,
} from "./agent.js";

describe("normalizeElicitationFields", () => {
  it("按 properties 顺序生成字段并标记 required", () => {
    const fields = normalizeElicitationFields({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", title: "字段 A", description: "说明" },
        b: { type: "boolean" },
      },
    });
    assert.equal(fields.length, 2);
    assert.equal(fields[0]!.name, "a");
    assert.equal(fields[0]!.label, "字段 A");
    assert.equal(fields[0]!.description, "说明");
    assert.equal(fields[0]!.required, true);
    assert.equal(fields[1]!.name, "b");
    assert.equal(fields[1]!.label, "b");
    assert.equal(fields[1]!.required, false);
  });

  it("透传合法 default", () => {
    const fields = normalizeElicitationFields({
      properties: {
        s: { type: "string", default: "x" },
        n: { type: "number", default: 1.5 },
        i: { type: "integer", default: 2 },
        b: { type: "boolean", default: true },
        bad: { type: "string", default: 42 },
      },
    });
    assert.equal(fields.find((f) => f.name === "s")!.defaultValue, "x");
    assert.equal(fields.find((f) => f.name === "n")!.defaultValue, 1.5);
    assert.equal(fields.find((f) => f.name === "i")!.defaultValue, 2);
    assert.equal(fields.find((f) => f.name === "b")!.defaultValue, true);
    assert.equal(fields.find((f) => f.name === "bad")!.defaultValue, undefined);
  });

  it("string enum 映射 options，oneOf 映射 const/title", () => {
    const fields = normalizeElicitationFields({
      properties: {
        e: { type: "string", enum: ["a", "b"] },
        o: {
          type: "string",
          oneOf: [
            { const: "x", title: "X 标签" },
            { const: "y", title: "Y 标签" },
          ],
        },
      },
    });
    assert.deepEqual(fields.find((f) => f.name === "e")!.options, [
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
    assert.deepEqual(fields.find((f) => f.name === "o")!.options, [
      { value: "x", label: "X 标签" },
      { value: "y", label: "Y 标签" },
    ]);
  });

  it("array items 的 enum/anyOf 映射 options，default 为 string[]", () => {
    const fields = normalizeElicitationFields({
      properties: {
        m: {
          type: "array",
          items: { type: "string", enum: ["p", "q"] },
          default: ["p"],
        },
        t: {
          type: "array",
          items: { anyOf: [{ const: "u", title: "U" }] },
        },
      },
    });
    const m = fields.find((f) => f.name === "m")!;
    assert.equal(m.type, "array");
    assert.deepEqual(m.options, [
      { value: "p", label: "p" },
      { value: "q", label: "q" },
    ]);
    assert.deepEqual(m.defaultValue, ["p"]);
    assert.deepEqual(fields.find((f) => f.name === "t")!.options, [
      { value: "u", label: "U" },
    ]);
  });

  it("未知字段类型跳过", () => {
    const fields = normalizeElicitationFields({
      properties: {
        ok: { type: "string" },
        weird: { type: "object" },
        fut: { type: "_custom" },
      },
    });
    assert.equal(fields.length, 1);
    assert.equal(fields[0]!.name, "ok");
  });
});

describe("sliceTextFile", () => {
  const content = "l1\nl2\nl3\nl4";

  it("无参数返回原文", () => {
    assert.equal(sliceTextFile(content), content);
    assert.equal(sliceTextFile(content, null, null), content);
  });

  it("line 从 1 开始", () => {
    assert.equal(sliceTextFile(content, 2), "l2\nl3\nl4");
    assert.equal(sliceTextFile(content, 0), content);
    assert.equal(sliceTextFile(content, 99), "");
  });

  it("line + limit", () => {
    assert.equal(sliceTextFile(content, 2, 2), "l2\nl3");
    assert.equal(sliceTextFile(content, 4, 10), "l4");
  });

  it("limit=0 返回空串", () => {
    assert.equal(sliceTextFile(content, 1, 0), "");
    assert.equal(sliceTextFile(content, undefined, 0), "");
  });
});

function memPipe() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      try {
        ctrl.enqueue(chunk);
      } catch {}
    },
    close() {
      try {
        ctrl.close();
      } catch {}
    },
  });
  return { readable, writable };
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

describe("AcpAgent integration (in-memory stream)", () => {
  function setup(options?: {
    authMethods?: acp.AuthMethod[];
    agentCapabilities?: acp.AgentCapabilities;
    promptHandler?: (params: acp.PromptRequest) => Promise<acp.PromptResponse>;
    authGated?: boolean;
    stayGated?: boolean;
    failAuthenticate?: boolean;
    sessionNewError?: unknown;
    resumeError?: unknown;
    deferAuthErrors?: boolean;
    initializeError?: unknown;
    loadAuthGated?: boolean;
    loadStayGated?: boolean;
    localDevinAuth?: boolean;
  }) {
    const c2a = memPipe();
    const a2c = memPipe();
    const pipes = { c2a, a2c };
    const clientStream = acp.ndJsonStream(c2a.writable, a2c.readable);
    const agentStream = acp.ndJsonStream(a2c.writable, c2a.readable);
    const authCalls: acp.AuthenticateRequest[] = [];
    const prompts: acp.PromptRequest[] = [];
    const forkCalls: acp.ForkSessionRequest[] = [];
    const resumeCalls: acp.ResumeSessionRequest[] = [];
    const loadCalls: acp.LoadSessionRequest[] = [];
    const setConfigCalls: { sessionId: string; configId: string; value: unknown }[] = [];
    const order: string[] = [];
    const deferredResolvers: (() => void)[] = [];
    let newSessionSeq = 0;
    let authenticated = false;
    const requiresAuth = () =>
      (options?.authGated || options?.stayGated) &&
      (!authenticated || options?.stayGated === true);
    const seenClientCapabilities: (acp.ClientCapabilities | null | undefined)[] = [];
    const agentConn = acp
      .agent()
      .onRequest(acp.methods.agent.initialize, ({ params }) => {
        order.push("initialize");
        seenClientCapabilities.push(params.clientCapabilities);
        if (options?.initializeError) throw options.initializeError;
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: options?.agentCapabilities ?? {},
          ...(options?.authMethods ? { authMethods: options.authMethods } : {}),
        };
      })
      .onRequest(acp.methods.agent.authenticate, ({ params }) => {
        order.push("authenticate");
        authCalls.push(params);
        if (options?.failAuthenticate) throw new Error("login cancelled");
        authenticated = true;
      })
      .onRequest(acp.methods.agent.session.new, async () => {
        order.push("session.new");
        if (requiresAuth()) {
          if (options?.deferAuthErrors) {
            await new Promise<void>((r) => deferredResolvers.push(r));
          }
          throw acp.RequestError.authRequired();
        }
        if (options?.sessionNewError) throw options.sessionNewError;
        return {
          sessionId: `s${++newSessionSeq}`,
          configOptions: [
            {
              id: "thought_level",
              name: "Thinking",
              type: "select",
              currentValue: "high",
              options: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
                { value: "max", name: "Max" },
              ],
            },
          ],
        };
      })
      .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
        order.push("session.setConfigOption");
        if (requiresAuth()) throw acp.RequestError.authRequired();
        const p = params as { sessionId: string; configId: string; value: unknown };
        setConfigCalls.push(p);
        return {
          configOptions: [
            {
              id: p.configId,
              name: p.configId,
              type: "select" as const,
              currentValue: String(p.value),
              options: [{ value: String(p.value), name: String(p.value) }],
            },
          ],
        };
      })
      .onRequest(acp.methods.agent.session.fork, ({ params }) => {
        order.push("session.fork");
        forkCalls.push(params);
        if (requiresAuth()) throw acp.RequestError.authRequired();
        return { sessionId: "s2" };
      })
      .onRequest(acp.methods.agent.session.resume, ({ params }) => {
        order.push("session.resume");
        resumeCalls.push(params);
        if (requiresAuth()) throw acp.RequestError.authRequired();
        if (options?.resumeError) throw options.resumeError;
        return {};
      })
      .onRequest(acp.methods.agent.session.load, ({ params }) => {
        order.push("session.load");
        loadCalls.push(params);
        if (requiresAuth()) throw acp.RequestError.authRequired();
        if (
          (options?.loadAuthGated || options?.loadStayGated) &&
          (!authenticated || options?.loadStayGated)
        ) {
          throw acp.RequestError.authRequired();
        }
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
        prompts.push(params);
        return options?.promptHandler?.(params) ?? new Promise<acp.PromptResponse>(() => {});
      })
      .connect(agentStream);
    const events: HubEvent[] = [];
    const hub = new AcpAgent(
      "test",
      clientStream,
      (e) => events.push(e),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options?.localDevinAuth ?? false,
    );
    return { agentConn, hub, events, pipes, authCalls, prompts, forkCalls, resumeCalls, loadCalls, setConfigCalls, order, deferredResolvers, seenClientCapabilities };
  }

  it("elicitation request -> Hub event -> respond -> agent 收到 accept", async () => {
    const { agentConn, hub, events } = setup();
    const session = await hub.createSession("/tmp", "s");
    assert.equal(session.sessionId, "s1");

    const respPromise = agentConn.client.request(acp.methods.client.elicitation.create, {
      mode: "form",
      sessionId: "s1",
      message: "需要输入",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", title: "名字" },
        },
      },
    });

    const ev = await waitFor(() =>
      events.find((e) => e.method === "elicitation.request"),
    );
    if (ev.method !== "elicitation.request") throw new Error("unreachable");
    assert.equal(ev.params.sessionId, "s1");
    assert.equal(ev.params.message, "需要输入");
    assert.equal(ev.params.fields[0]!.name, "name");
    assert.equal(ev.params.fields[0]!.required, true);

    const ok = hub.respondElicitation(ev.params.requestId, "accept", { name: "devin" });
    assert.equal(ok, true);
    const resp = await respPromise;
    assert.equal(resp.action, "accept");
    assert.deepEqual(
      (resp as { content?: Record<string, unknown> }).content,
      { name: "devin" },
    );
    hub.close();
    agentConn.close();
  });

  it("elicitation url mode 直接 decline", async () => {
    const { agentConn, hub, events } = setup();
    await hub.createSession("/tmp", "s");
    const resp = await agentConn.client.request(acp.methods.client.elicitation.create, {
      mode: "url",
      sessionId: "s1",
      elicitationId: "e1",
      url: "https://example.com",
      message: "open url",
    } as acp.CreateElicitationRequest);
    assert.equal(resp.action, "decline");
    assert.equal(events.some((e) => e.method === "elicitation.request"), false);
    hub.close();
    agentConn.close();
  });

  it("断连时 promptOnce 立即 reject 且发 prompt.error", async () => {
    const { hub, events, pipes } = setup();
    await hub.createSession("/tmp", "s");
    const p = hub.promptOnce("s1", "hi", 60_000);
    const assertion = assert.rejects(p, /disconnected/);
    await waitFor(() =>
      events.find(
        (e) => e.method === "session.generating" && e.params.stoppable === true,
      ),
    );
    await pipes.a2c.writable.close();
    await assertion;
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const errors = events.filter((e) => e.method === "prompt.error");
    assert.equal(errors.length, 1, "prompt.error should be emitted exactly once");
    if (errors[0]?.method === "prompt.error") {
      assert.match(errors[0].params.message, /disconnected/);
    }
    assert.equal(events.some((e) => e.method === "prompt.done"), false);
  });

  it("同 session 并发 promptOnce 第二个立即失败，断连后第一个 reject 且无遗留", async () => {
    const { hub, pipes } = setup();
    await hub.createSession("/tmp", "s");
    const p1 = hub.promptOnce("s1", "first", 60_000);
    const firstRejects = assert.rejects(p1, /disconnected/);
    await assert.rejects(hub.promptOnce("s1", "second"), /already pending/);
    await pipes.a2c.writable.close();
    await firstRejects;
    await assert.rejects(hub.promptOnce("s1", "after"));
  });

  it("advertised agent auth 不触发预登录：已认证 agent 两次 session/new 零 authenticate", async () => {
    const { hub, agentConn, authCalls, order } = setup({
      authMethods: [
        { id: "term", name: "Terminal", type: "terminal" } as acp.AuthMethod,
        { id: "devin-browser", name: "Log in with browser", type: "agent" } as acp.AuthMethod,
      ],
    });
    const a = await hub.createSession("/tmp", "a");
    const b = await hub.createSession("/tmp", "b");
    assert.equal(a.sessionId, "s1");
    assert.equal(b.sessionId, "s2");
    assert.equal(authCalls.length, 0);
    assert.equal(order.filter((m) => m === "authenticate").length, 0);
    assert.equal(order.filter((m) => m === "session.new").length, 2);
    hub.close();
    agentConn.close();
  });

  it("auth_required 时按需 authenticate 一次并重试原请求，后续请求不再认证", async () => {
    const { hub, agentConn, authCalls, order, events } = setup({
      authGated: true,
      authMethods: [
        { id: "devin-browser", name: "Log in with browser", type: "agent" } as acp.AuthMethod,
      ],
    });
    const s = await hub.createSession("/tmp", "s");
    assert.equal(s.sessionId, "s1");
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0]!.methodId, "devin-browser");
    assert.deepEqual(
      order.filter((m) => m === "session.new" || m === "authenticate"),
      ["session.new", "authenticate", "session.new"],
    );
    assert.ok(
      events.some(
        (e) => e.method === "agent.status" && e.params.status === "authenticating",
      ),
    );
    await hub.createSession("/tmp", "t");
    assert.equal(authCalls.length, 1, "已认证后不得重复 authenticate");
    hub.close();
    agentConn.close();
  });

  it("并发 auth_required 共享同一次 authenticate", async () => {
    const { hub, agentConn, authCalls, order } = setup({
      authGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    const [a, b] = await Promise.all([
      hub.createSession("/tmp", "a"),
      hub.createSession("/tmp", "b"),
    ]);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(authCalls.length, 1, "并发挑战应去重为一次 authenticate");
    assert.equal(order.filter((m) => m === "session.new").length, 4);
    hub.close();
    agentConn.close();
  });

  it("非认证类错误不触发 authenticate", async () => {
    const { hub, agentConn, authCalls } = setup({
      sessionNewError: acp.RequestError.internalError(),
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.createSession("/tmp", "s"));
    assert.equal(authCalls.length, 0);
    hub.close();
    agentConn.close();
  });

  it("advertise env_var/terminal 但已认证时 session/new 直接成功且零 authenticate", async () => {
    const { hub, agentConn, authCalls } = setup({
      authMethods: [
        {
          id: "env",
          name: "Env",
          type: "env_var",
          vars: [{ name: "DEFINITELY_MISSING_HUB_TEST_VAR", value: "" }],
        } as acp.AuthMethod,
        { id: "term", name: "Terminal", type: "terminal" } as acp.AuthMethod,
      ],
    });
    const s = await hub.createSession("/tmp", "s");
    assert.equal(s.sessionId, "s1");
    assert.equal(authCalls.length, 0);
    hub.close();
    agentConn.close();
  });

  it("env_var 缺失且 agent 要求认证时报变量名错误且不调用 authenticate", async () => {
    const { hub, agentConn, authCalls } = setup({
      authGated: true,
      authMethods: [
        {
          id: "env",
          name: "Env",
          type: "env_var",
          vars: [{ name: "DEFINITELY_MISSING_HUB_TEST_VAR", value: "" }],
        } as acp.AuthMethod,
      ],
    });
    await assert.rejects(
      hub.createSession("/tmp", "s"),
      /DEFINITELY_MISSING_HUB_TEST_VAR/,
    );
    assert.equal(authCalls.length, 0, "env_var 方式不得发起 authenticate");
    hub.close();
    agentConn.close();
  });

  it("authenticate 失败时不重试不循环", async () => {
    const { hub, agentConn, authCalls, order } = setup({
      authGated: true,
      failAuthenticate: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.createSession("/tmp", "s"));
    assert.equal(authCalls.length, 1);
    assert.equal(order.filter((m) => m === "session.new").length, 1);
    hub.close();
    agentConn.close();
  });

  it("认证后重试仍 auth_required 时不再二次认证", async () => {
    const { hub, agentConn, authCalls, order } = setup({
      stayGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.createSession("/tmp", "s"));
    assert.equal(authCalls.length, 1);
    assert.equal(order.filter((m) => m === "session.new").length, 2);
    hub.close();
    agentConn.close();
  });

  it("resume 认证失败时上抛错误且不回退 load/重建造成二次弹窗", async () => {
    const { hub, agentConn, authCalls, resumeCalls, loadCalls } = setup({
      authGated: true,
      failAuthenticate: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.resumeSession("hist1", "/tmp", "旧会话"));
    assert.equal(resumeCalls.length, 1);
    assert.equal(loadCalls.length, 0, "登录失败不得回退 load 触发二次认证");
    assert.equal(authCalls.length, 1);
    hub.close();
    agentConn.close();
  });

  it("resume 重试仍 auth_required 时上抛且不回退 load", async () => {
    const { hub, agentConn, authCalls, resumeCalls, loadCalls } = setup({
      stayGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.resumeSession("hist1", "/tmp", "旧会话"));
    assert.equal(resumeCalls.length, 2);
    assert.equal(loadCalls.length, 0);
    assert.equal(authCalls.length, 1);
    hub.close();
    agentConn.close();
  });

  it("认证失败代际内延迟到达的 auth_required 不再弹窗且零重试，后续独立请求可再试", async () => {
    const { hub, agentConn, authCalls, order, deferredResolvers } = setup({
      authGated: true,
      failAuthenticate: true,
      deferAuthErrors: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    const p1 = hub.createSession("/tmp", "a");
    const p2 = hub.createSession("/tmp", "b");
    await waitFor(() => (deferredResolvers.length === 2 ? true : undefined));
    deferredResolvers[0]!();
    await assert.rejects(p1);
    deferredResolvers[1]!();
    await assert.rejects(p2);
    assert.equal(authCalls.length, 1, "失败代际内不得再次 authenticate");
    assert.equal(
      order.filter((m) => m === "session.new").length,
      2,
      "认证失败后不得重试已发请求",
    );
    const p3 = hub.createSession("/tmp", "c");
    await waitFor(() => (deferredResolvers.length === 3 ? true : undefined));
    deferredResolvers[2]!();
    await assert.rejects(p3);
    assert.equal(authCalls.length, 2, "后续独立请求允许再次尝试认证");
    hub.close();
    agentConn.close();
  });

  it("load 认证失败时上抛且不重试 load、不走重建", async () => {
    const { hub, agentConn, authCalls, resumeCalls, loadCalls, order } = setup({
      resumeError: acp.RequestError.methodNotFound("session/resume"),
      loadAuthGated: true,
      failAuthenticate: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.resumeSession("hist1", "/tmp", "旧会话"));
    assert.equal(resumeCalls.length, 1);
    assert.equal(loadCalls.length, 1, "load 认证失败不得重试");
    assert.equal(authCalls.length, 1);
    assert.equal(
      order.filter((m) => m === "session.new").length,
      0,
      "不得进入 createSession 重建路径",
    );
    hub.close();
    agentConn.close();
  });

  it("load 重试仍 auth_required 时上抛且 load 恰为两次", async () => {
    const { hub, agentConn, authCalls, resumeCalls, loadCalls, order } = setup({
      resumeError: acp.RequestError.methodNotFound("session/resume"),
      loadStayGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.resumeSession("hist1", "/tmp", "旧会话"));
    assert.equal(resumeCalls.length, 1);
    assert.equal(loadCalls.length, 2, "auth 成功后仅重试一次");
    assert.equal(authCalls.length, 1);
    assert.equal(order.filter((m) => m === "session.new").length, 0);
    hub.close();
    agentConn.close();
  });

  it("认证失败时补发 auth-required 状态且不泄漏后端错误详情", async () => {
    const { hub, agentConn, events } = setup({
      authGated: true,
      failAuthenticate: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await assert.rejects(hub.createSession("/tmp", "s"));
    const seq = events
      .filter((e) => e.method === "agent.status")
      .map((e) => (e as { params: { status: string; detail?: string } }).params);
    assert.deepEqual(
      seq.map((s) => s.status),
      ["starting", "ready", "authenticating", "auth-required"],
    );
    assert.equal(seq.at(-1)!.detail, undefined);
    hub.close();
    agentConn.close();
  });

  it("按需认证成功后补发 agent.status ready", async () => {
    const { hub, agentConn, events } = setup({
      authGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    await hub.createSession("/tmp", "s");
    const seq = events
      .filter((e) => e.method === "agent.status")
      .map((e) => (e as { params: { status: string } }).params.status);
    assert.deepEqual(seq, ["starting", "ready", "authenticating", "ready"]);
    hub.close();
    agentConn.close();
  });

  it("DEVIN_API_KEY 仅本地 devin 注入 _meta，ACP_API_KEY 对所有 agent 生效", async () => {
    const savedDevin = process.env.DEVIN_API_KEY;
    const savedAcp = process.env.ACP_API_KEY;
    process.env.DEVIN_API_KEY = "FAKE_TEST_DEVIN_KEY";
    delete process.env.ACP_API_KEY;
    const metaOf = (calls: acp.AuthenticateRequest[]) =>
      (calls[0] as { _meta?: { api_key?: unknown } } | undefined)?._meta?.api_key;
    try {
      const local = setup({
        authGated: true,
        localDevinAuth: true,
        authMethods: [
          { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
        ],
      });
      await local.hub.createSession("/tmp", "s");
      assert.equal(local.authCalls.length, 1);
      assert.equal(
        metaOf(local.authCalls) === process.env.DEVIN_API_KEY,
        true,
        "本地 devin 应注入 DEVIN_API_KEY",
      );
      local.hub.close();
      local.agentConn.close();

      const remote = setup({
        authGated: true,
        authMethods: [
          { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
        ],
      });
      await remote.hub.createSession("/tmp", "s");
      assert.equal(remote.authCalls.length, 1);
      assert.equal(
        metaOf(remote.authCalls),
        undefined,
        "非本地 devin 不得注入 DEVIN_API_KEY",
      );
      remote.hub.close();
      remote.agentConn.close();

      process.env.ACP_API_KEY = "FAKE_TEST_ACP_KEY";
      const remote2 = setup({
        authGated: true,
        authMethods: [
          { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
        ],
      });
      await remote2.hub.createSession("/tmp", "s");
      assert.equal(remote2.authCalls.length, 1);
      assert.equal(
        metaOf(remote2.authCalls) === process.env.ACP_API_KEY,
        true,
        "ACP_API_KEY 对任意 agent 生效",
      );
      remote2.hub.close();
      remote2.agentConn.close();
    } finally {
      if (savedDevin !== undefined) process.env.DEVIN_API_KEY = savedDevin;
      else delete process.env.DEVIN_API_KEY;
      if (savedAcp !== undefined) process.env.ACP_API_KEY = savedAcp;
      else delete process.env.ACP_API_KEY;
    }
  });

  it("initialize 失败后 ensureStarted fail fast 且不重复建立连接", async () => {
    const { hub, agentConn, order } = setup({
      initializeError: acp.RequestError.internalError(),
    });
    await assert.rejects(hub.createSession("/tmp", "a"));
    await assert.rejects(hub.createSession("/tmp", "b"));
    assert.equal(
      order.filter((m) => m === "initialize").length,
      1,
      "失败实例不得再次调用 start/connect",
    );
    hub.close();
    agentConn.close();
  });

  it("resume 认证成功后重试成功且不走 load", async () => {
    const { hub, agentConn, authCalls, resumeCalls, loadCalls } = setup({
      authGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
    });
    const ok = await hub.resumeSession("hist1", "/tmp", "旧会话");
    assert.equal(ok, true);
    assert.equal(resumeCalls.length, 2);
    assert.equal(loadCalls.length, 0);
    assert.equal(authCalls.length, 1);
    hub.close();
    agentConn.close();
  });

  it("resume 普通失败仍保留 session/load 回退", async () => {
    const { hub, agentConn, resumeCalls, loadCalls } = setup({
      resumeError: acp.RequestError.methodNotFound("session/resume"),
    });
    const ok = await hub.resumeSession("hist1", "/tmp", "旧会话");
    assert.equal(ok, true);
    assert.equal(resumeCalls.length, 1);
    assert.equal(loadCalls.length, 1);
    hub.close();
    agentConn.close();
  });

  it("fork 在 auth_required 后按需认证并重试成功", async () => {
    const { hub, agentConn, authCalls, forkCalls } = setup({
      authGated: true,
      authMethods: [
        { id: "devin-browser", name: "login", type: "agent" } as acp.AuthMethod,
      ],
      agentCapabilities: {
        sessionCapabilities: { fork: {} },
      } as acp.AgentCapabilities,
    });
    const c = await hub.cloneSession("s1", "/tmp", "副本");
    assert.equal(c.sessionId, "s2");
    assert.equal(forkCalls.length, 2);
    assert.equal(authCalls.length, 1);
    await hub.createSession("/tmp", "s");
    assert.equal(authCalls.length, 1, "认证后新会话不得再次弹窗");
    hub.close();
    agentConn.close();
  });

  it("usage_update 合法值写入缓存并发 session.usage，非法值不覆盖", async () => {
    const { agentConn, hub, events } = setup();
    await hub.createSession("/tmp", "s");

    await agentConn.client.notify("session/update", {
      sessionId: "s1",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 200,
        cost: { amount: 0.5, currency: "USD" },
      },
    });
    await waitFor(() => events.find((e) => e.method === "session.usage"));
    const usage = hub.getContextUsage("s1");
    assert.deepEqual(usage, {
      used: 100,
      size: 200,
      cost: { amount: 0.5, currency: "USD" },
    });
    usage!.cost!.amount = 999;
    assert.equal(hub.getContextUsage("s1")!.cost!.amount, 0.5);

    const usageEvents = () => events.filter((e) => e.method === "session.usage").length;
    assert.equal(usageEvents(), 1);
    await agentConn.client.notify("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: 150 },
    });
    await agentConn.client.notify("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "usage_update", used: -1, size: 300 },
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(usageEvents(), 1);
    assert.deepEqual(hub.getContextUsage("s1"), {
      used: 100,
      size: 200,
      cost: { amount: 0.5, currency: "USD" },
    });
    hub.close();
    agentConn.close();
  });

  it("cloneSession 在 agent 声明 fork capability 时使用 session/fork", async () => {
    const { agentConn, hub, forkCalls, order } = setup({
      agentCapabilities: {
        sessionCapabilities: { fork: {} },
      } as acp.AgentCapabilities,
    });
    await hub.createSession("/tmp", "s");
    const cloned = await hub.cloneSession("s1", "/tmp", "副本");
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0]!.sessionId, "s1");
    assert.equal(forkCalls[0]!.cwd, "/tmp");
    assert.deepEqual(forkCalls[0]!.mcpServers, []);
    assert.equal(cloned.sessionId, "s2");
    assert.equal(cloned.name, "副本");
    assert.equal(cloned.contextCloned, true);
    assert.equal(order.filter((m) => m === "session.new").length, 1);
    hub.renameSession("s2", "副本-renamed");
    hub.close();
    agentConn.close();
  });

  it("cloneSession 在 agent 不支持 fork 时降级为新建会话", async () => {
    const { agentConn, hub, forkCalls, order } = setup();
    await hub.createSession("/tmp", "s");
    const cloned = await hub.cloneSession("s1", "/tmp", "副本");
    assert.equal(forkCalls.length, 0);
    assert.equal(order.filter((m) => m === "session.new").length, 2);
    assert.equal(cloned.contextCloned, false);
    assert.equal(cloned.sessionId, "s2");
    hub.renameSession("s2", "副本-renamed");
    hub.close();
    agentConn.close();
  });

  it("configOptions 按 session 隔离，setConfigOption 只更新目标会话", async () => {
    const { agentConn, hub, setConfigCalls } = setup();
    await hub.createSession("/tmp", "a");
    await hub.createSession("/tmp", "b");
    const optOf = (sid: string) =>
      (hub.getConfigOptions(sid) as { currentValue?: string }[] | null)?.[0]?.currentValue;
    assert.equal(optOf("s1"), "high");
    assert.equal(optOf("s2"), "high");

    await hub.setConfigOption("s1", "thought_level", "max");
    assert.equal(setConfigCalls.length, 1);
    assert.equal(setConfigCalls[0]!.sessionId, "s1");
    assert.equal(optOf("s1"), "max");
    assert.equal(optOf("s2"), "high");
    hub.close();
    agentConn.close();
  });

  it("config_option_update 通知更新对应 session 的 configOptions", async () => {
    const { agentConn, hub } = setup();
    await hub.createSession("/tmp", "a");
    await hub.createSession("/tmp", "b");
    await agentConn.client.notify(acp.methods.client.session.update, {
      sessionId: "s1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "mode", name: "Session Mode", type: "select", currentValue: "plan", options: [] },
        ],
      },
    });
    await waitFor(() => {
      const opts = hub.getConfigOptions("s1") as { id?: string }[] | null;
      return opts?.[0]?.id === "mode" ? true : undefined;
    });
    const s2Opts = hub.getConfigOptions("s2") as { id?: string }[] | null;
    assert.equal(s2Opts?.[0]?.id, "thought_level");
    hub.close();
    agentConn.close();
  });

  it("initialize 声明 session.configOptions boolean 能力", async () => {
    const { hub, agentConn, seenClientCapabilities } = setup();
    await hub.createSession("/tmp", "s");
    const caps = seenClientCapabilities[0] as {
      session?: { configOptions?: { boolean?: unknown } };
      elicitation?: { form?: unknown };
    };
    assert.ok(caps?.session?.configOptions, "session.configOptions capability missing");
    assert.ok(caps.session.configOptions.boolean !== undefined);
    assert.ok(caps.elicitation?.form !== undefined);
    hub.close();
    agentConn.close();
  });

});
