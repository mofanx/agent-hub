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
    promptHandler?: (params: acp.PromptRequest) => Promise<acp.PromptResponse>;
  }) {
    const c2a = memPipe();
    const a2c = memPipe();
    const pipes = { c2a, a2c };
    const clientStream = acp.ndJsonStream(c2a.writable, a2c.readable);
    const agentStream = acp.ndJsonStream(a2c.writable, c2a.readable);
    const authCalls: acp.AuthenticateRequest[] = [];
    const prompts: acp.PromptRequest[] = [];
    const order: string[] = [];
    const seenClientCapabilities: (acp.ClientCapabilities | null | undefined)[] = [];
    const agentConn = acp
      .agent()
      .onRequest(acp.methods.agent.initialize, ({ params }) => {
        order.push("initialize");
        seenClientCapabilities.push(params.clientCapabilities);
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: {},
          ...(options?.authMethods ? { authMethods: options.authMethods } : {}),
        };
      })
      .onRequest(acp.methods.agent.authenticate, ({ params }) => {
        order.push("authenticate");
        authCalls.push(params);
      })
      .onRequest(acp.methods.agent.session.new, () => {
        order.push("session.new");
        return { sessionId: "s1" };
      })
      .onRequest(acp.methods.agent.session.prompt, ({ params }) => {
        prompts.push(params);
        return options?.promptHandler?.(params) ?? new Promise<acp.PromptResponse>(() => {});
      })
      .connect(agentStream);
    const events: HubEvent[] = [];
    const hub = new AcpAgent("test", clientStream, (e) => events.push(e));
    return { agentConn, hub, events, pipes, authCalls, prompts, order, seenClientCapabilities };
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

  it("initialize 返回多个 authMethods 时优先 agent 并在 session/new 前 authenticate", async () => {
    const savedDevin = process.env.DEVIN_API_KEY;
    const savedAcp = process.env.ACP_API_KEY;
    delete process.env.DEVIN_API_KEY;
    delete process.env.ACP_API_KEY;
    try {
      const { hub, agentConn, authCalls, order, events } = setup({
        authMethods: [
          { id: "term", name: "Terminal", type: "terminal" } as acp.AuthMethod,
          { id: "devin-browser", name: "Log in with browser", type: "agent" } as acp.AuthMethod,
        ],
      });
      const session = await hub.createSession("/tmp", "s");
      assert.equal(session.sessionId, "s1");
      assert.equal(authCalls.length, 1);
      assert.equal(authCalls[0]!.methodId, "devin-browser");
      assert.ok(order.indexOf("authenticate") < order.indexOf("session.new"));
      assert.ok(
        events.some(
          (e) => e.method === "agent.status" && e.params.status === "authenticating",
        ),
      );
      hub.close();
      agentConn.close();
    } finally {
      if (savedDevin !== undefined) process.env.DEVIN_API_KEY = savedDevin;
      if (savedAcp !== undefined) process.env.ACP_API_KEY = savedAcp;
    }
  });

  it("仅 required env_var 且变量缺失时 createSession reject 并包含变量名", async () => {
    const { hub, agentConn } = setup({
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
