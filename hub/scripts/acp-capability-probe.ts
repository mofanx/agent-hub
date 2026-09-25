// 探测 devin acp 上报的 agentCapabilities 与 session configOptions 原始结构
// 用法: npx tsx scripts/acp-capability-probe.ts [cwd]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const cwd = process.argv[2] ?? process.cwd();
const bin = process.env.DEVIN_BIN ?? "devin";
const rawArgs = process.env.DEVIN_ACP_ARGS?.trim();
const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : ["acp"];
const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
const stream = acp.ndJsonStream(
  Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
);

const app = acp
  .client({ name: "agent-hub-probe" })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const option = params.options.find((o) => /reject|deny|block/i.test(`${o.kind} ${o.name}`)) ?? params.options.at(-1);
    return { outcome: { outcome: "selected", optionId: option?.optionId ?? "" } };
  })
  .onNotification(acp.methods.client.session.update, () => {});

const conn = app.connect(stream);
const timeout = setTimeout(() => {
  conn.close(new Error("probe timeout"));
  if (proc.exitCode === null) proc.kill();
}, 120_000);

async function main(): Promise<void> {
  try {
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        session: { configOptions: { boolean: {} } },
        elicitation: { form: {} },
      },
      clientInfo: { name: "agent-hub-probe", version: "0.9.0" },
    });
    console.log("=== initialize ===");
    console.log(JSON.stringify({
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo,
      agentCapabilities: init.agentCapabilities,
      authMethods: init.authMethods,
    }, null, 2));

    const authMethods = init.authMethods ?? [];
    if (authMethods.length > 0) {
      const method = authMethods[0]!;
      const apiKey = process.env.DEVIN_API_KEY ?? process.env.ACP_API_KEY;
      await conn.agent.request(acp.methods.agent.authenticate, {
        methodId: method.id,
        ...(apiKey ? { _meta: { api_key: apiKey } } : {}),
      });
      console.log("=== authenticated ===", method.id);
    }

    const session = await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    console.log("=== session.new ===");
    console.log(JSON.stringify(session, null, 2));
    await conn.agent.request(acp.methods.agent.session.delete, { sessionId: session.sessionId }).catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    conn.close();
    if (proc.exitCode === null) proc.kill();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exitCode = 1;
});
