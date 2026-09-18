import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { parseConfigOptionsModels } from "../src/model.js";

const cwd = process.argv[2] ?? process.cwd();
const bin = process.env.DEVIN_BIN ?? "devin";
const rawArgs = process.env.DEVIN_ACP_ARGS?.trim();
const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : ["acp"];
const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const stream = acp.ndJsonStream(
  Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
);
let activeSessionId = "";
let turnText = "";
let elicitationCount = 0;
let elicitationFields: string[] = [];
let configOptions: unknown[] = [];
let authMethods: Array<{ id: string; name: string; type: string }> = [];

const app = acp
  .client({ name: "agent-hub-smoke" })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const option = params.options.find((o) => /reject|deny|block/i.test(`${o.kind} ${o.name}`)) ?? params.options.at(-1);
    return { outcome: { outcome: "selected", optionId: option?.optionId ?? "" } };
  })
  .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
    if (params.mode !== "form" || !("sessionId" in params) || params.sessionId !== activeSessionId) {
      return { action: "decline" };
    }
    const schema = (params as { requestedSchema?: acp.ElicitationSchema }).requestedSchema;
    if (!schema) return { action: "decline" };
    elicitationCount++;
    elicitationFields = Object.keys(schema.properties ?? {});
    return { action: "decline" };
  })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.sessionId !== activeSessionId) return;
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      turnText += update.content.text;
    } else if (update.sessionUpdate === "config_option_update") {
      configOptions = update.configOptions;
    }
  });

const conn = app.connect(stream);
const timeout = setTimeout(() => {
  conn.close(new Error("Devin ACP smoke timeout"));
  if (proc.exitCode === null) proc.kill();
}, 180_000);

async function prompt(text: string): Promise<{ output: string; stopReason: string }> {
  turnText = "";
  const response = await conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: activeSessionId,
    prompt: [{ type: "text", text }],
  });
  return { output: turnText.trim(), stopReason: response.stopReason };
}

async function setModel(model: string): Promise<number> {
  const response = await conn.agent.request(acp.methods.agent.session.setConfigOption, {
    sessionId: activeSessionId,
    configId: "model",
    value: model,
  });
  configOptions = response.configOptions;
  return configOptions.length;
}

async function main(): Promise<void> {
  try {
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } }, elicitation: { form: {} } },
      clientInfo: { name: "agent-hub-smoke", version: "0.9.0" },
    });
    authMethods = (init.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      type: "type" in method ? method.type : "agent",
    }));
    if (init.authMethods && init.authMethods.length > 0) {
      const method =
        init.authMethods.find((c) => ((c as { type?: string }).type ?? "agent") === "agent") ??
        init.authMethods[0]!;
      const methodType: string = "type" in method ? method.type : "agent";
      if (methodType === "terminal") {
        throw new Error("agent requires terminal authentication, cannot run interactively here");
      }
      if (methodType === "env_var") {
        const vars = (method as { vars?: { name: string; optional?: boolean }[] }).vars ?? [];
        const missing = vars.filter((v) => !v.optional && !process.env[v.name]);
        if (missing.length > 0) {
          throw new Error(`missing auth env vars: ${missing.map((v) => v.name).join(", ")}`);
        }
      }
      const apiKey = process.env.DEVIN_API_KEY ?? process.env.ACP_API_KEY;
      await conn.agent.request(acp.methods.agent.authenticate, {
        methodId: method.id,
        ...(apiKey ? { _meta: { api_key: apiKey } } : {}),
      });
    }
    const session = await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    activeSessionId = session.sessionId;
    configOptions = session.configOptions ?? [];
    const advertisedModels = parseConfigOptionsModels(configOptions, "devin");
    const requestedModel = process.env.DEVIN_SMOKE_MODEL ?? "swe-2-high";
    const modelOptionsAfterSwitch = await setModel(requestedModel);
    const models = parseConfigOptionsModels(configOptions, "devin");
    const status = await prompt("/status");
    const fusionModels = models.filter((m) => /fusion/i.test(`${m.uid} ${m.label} ${m.family}`));
    const preferredFusion = process.env.DEVIN_SMOKE_FUSION_MODEL ??
      "fusion-gpt-5-6-sol-high-sidekick-swe-2-medium";
    const fusionModel = fusionModels.find((m) => m.uid === preferredFusion) ?? fusionModels[0];
    if (!fusionModel) throw new Error("Devin model catalog did not advertise Fusion options");
    const modelOptionsAfterFusion = await setModel(fusionModel.uid);
    const modelOptionsAfterRestore = await setModel(requestedModel);
    await prompt("请调用 ask_user_question，仅询问一个二选一问题，不要执行其他工具；用户取消也可正常结束。");
    if (elicitationCount === 0) throw new Error("Devin ACP did not issue a form elicitation");
    console.log(JSON.stringify({
      ok: true,
      protocolVersion: init.protocolVersion,
      agent: init.agentInfo?.name ?? "unknown",
      requestedModel,
      advertisedModelOptions: advertisedModels.length,
      modelOptionsAfterSwitch,
      fusionOptionCount: fusionModels.length,
      fusionModel: fusionModel.uid,
      modelOptionsAfterFusion,
      modelOptionsAfterRestore,
      statusStopReason: status.stopReason,
      statusOutput: status.output.slice(0, 200),
      elicitationCount,
      elicitationFields,
    }, null, 2));
  } finally {
    if (activeSessionId) {
      await conn.agent.request(acp.methods.agent.session.delete, { sessionId: activeSessionId }).catch(() => undefined);
    }
    clearTimeout(timeout);
    conn.close();
    if (proc.exitCode === null) proc.kill();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    authMethods,
  }, null, 2));
  process.exitCode = 1;
});
