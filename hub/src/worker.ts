import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import { webSocketStream } from "./stream.js";
import { getAgentDef } from "./agent-defs.js";

const HUB_URL = process.env.HUB_URL;
const TOKEN = process.env.CONNECTION_TOKEN;
const AGENT = process.env.AGENT ?? "devin";

if (!HUB_URL) {
  throw new Error("[worker] HUB_URL environment variable required");
}
if (!TOKEN) {
  throw new Error("[worker] CONNECTION_TOKEN environment variable required");
}

const def = getAgentDef(AGENT);
if (!def) {
  throw new Error(`[worker] unknown agent type: ${AGENT}`);
}

function buildUrl(): string {
  const url = new URL(HUB_URL!);
  url.searchParams.set("token", TOKEN!);
  url.searchParams.set("agent", AGENT);
  return url.toString();
}

const PERMANENT_CLOSE_CODES = new Set([1000, 1008, 1009, 1011]);
const MAX_RETRY_MS = 30_000;
let retryDelay = 1000;

function runOnce(localStream: Stream): Promise<{ code: number; permanent: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(buildUrl());
    const hubStream = webSocketStream(ws);
    const abort = new AbortController();
    let finished = false;
    let bridgeDone: Promise<void> = Promise.resolve();

    function finish(code: number, permanent: boolean): void {
      if (finished) return;
      finished = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      try {
        abort.abort();
      } catch {
        // ignore
      }
      void bridgeDone.then(
        () => resolve({ code, permanent }),
        () => resolve({ code, permanent }),
      );
    }

    ws.on("open", () => {
      console.log("[worker] connected to hub");
      bridgeDone = Promise.all([
        hubStream.readable.pipeTo(localStream.writable, {
          signal: abort.signal,
          preventClose: true,
          preventAbort: true,
        }),
        localStream.readable.pipeTo(hubStream.writable, {
          signal: abort.signal,
          preventCancel: true,
        }),
      ]).then(() => {
        console.log("[worker] hub disconnected");
        finish(1006, false);
      }).catch((err) => {
        console.warn("[worker] bridge error:", String(err));
        finish(1006, false);
      });
    });

    ws.on("close", (code) => {
      console.log(`[worker] hub disconnected code=${code}`);
      finish(code ?? 1006, PERMANENT_CLOSE_CODES.has(code ?? 1006));
    });

    ws.on("error", (err) => {
      console.error("[worker] ws error:", err);
      finish(1006, false);
    });
  });
}

async function main(): Promise<void> {
  console.log(`[worker] ${AGENT} -> ${HUB_URL}`);

  const proc = spawn(def!.bin, def!.args, {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const localStream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  proc.on("exit", (code) => {
    console.log(`[worker] agent exited code=${code}`);
    process.exit(0);
  });

  while (true) {
    const result = await runOnce(localStream);
    if (result.permanent) {
      console.log(`[worker] permanent close code=${result.code}, exiting`);
      process.exit(0);
    }
    console.log(`[worker] reconnecting in ${retryDelay}ms`);
    await new Promise((r) => setTimeout(r, retryDelay));
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }
}

main();
