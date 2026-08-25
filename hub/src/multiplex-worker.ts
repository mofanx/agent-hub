/**
 * Multiplex Worker：一个 WebSocket 连接复用多个本地 ACP agent。
 *
 * 用法：
 *   HUB_URL=ws://hub:8787/worker CONNECTION_TOKEN=xxx npx tsx src/multiplex-worker.ts
 *
 * 环境变量：
 *   HUB_URL            Hub 的 WebSocket 地址（必填）
 *   CONNECTION_TOKEN   Hub connection token（必填）
 *   AGENTS             要启动的 agent 列表，逗号分隔（默认自动检测）
 *                       例：AGENTS=devin,opencode,claude
 *   EXCLUDE_AGENTS     要排除的 agent（默认空）
 *
 * 工作流程：
 * 1. 检测本地可用的 agent（devin/opencode/claude/codex）
 * 2. 为每个 agent spawn 一个 ACP 进程
 * 3. 连接 Hub（带 multiplex=1）
 * 4. 发送 announce 控制帧声明可用通道
 * 5. 双向桥接：agent stdio ↔ WebSocket channel
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import * as acp from "@agentclientprotocol/sdk";
import type { Stream, AnyMessage } from "@agentclientprotocol/sdk";
import { getAgentDef } from "./agent-defs.js";

const HUB_URL = process.env.HUB_URL;
const TOKEN = process.env.CONNECTION_TOKEN;
const AGENTS_ENV = process.env.AGENTS;
const EXCLUDE = (process.env.EXCLUDE_AGENTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!HUB_URL) throw new Error("[mux-worker] HUB_URL required");
if (!TOKEN) throw new Error("[mux-worker] CONNECTION_TOKEN required");

/** 检测本地可用的 agent */
function detectAgents(): string[] {
  const explicit = AGENTS_ENV
    ? AGENTS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
    : Object.keys(getAgentDef("devin") ? ["devin", "opencode", "claude", "codex"] : []);
  // 如果没有 AGENTS 环境变量，尝试全部已知 agent
  const candidates = AGENTS_ENV
    ? explicit
    : ["devin", "opencode", "claude", "codex"];
  return candidates.filter((a) => !EXCLUDE.includes(a) && getAgentDef(a));
}

type Channel = {
  id: string;
  agent: string;
  proc: ChildProcess;
  localStream: Stream;
};

function spawnAgent(agent: string): Channel | null {
  const def = getAgentDef(agent);
  if (!def) return null;

  try {
    const proc = spawn(def.bin, def.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const localStream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
    );

    proc.on("exit", (code) => {
      console.log(`[mux-worker] agent ${agent} exited code=${code}`);
    });

    return { id: agent, agent, proc, localStream };
  } catch (err) {
    console.warn(`[mux-worker] failed to spawn ${agent}: ${String(err)}`);
    return null;
  }
}

function buildUrl(): string {
  const url = new URL(HUB_URL!);
  url.searchParams.set("token", TOKEN!);
  url.searchParams.set("multiplex", "1");
  return url.toString();
}

const PERMANENT_CLOSE_CODES = new Set([1000, 1008, 1009, 1011]);
const MAX_RETRY_MS = 30_000;
let retryDelay = 1000;

async function runOnce(channels: Channel[]): Promise<{ code: number; permanent: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(buildUrl());
    const abort = new AbortController();
    let finished = false;
    const bridgePromises: Promise<void>[] = [];

    function finish(code: number, permanent: boolean): void {
      if (finished) return;
      finished = true;
      try { ws.close(); } catch {}
      try { abort.abort(); } catch {}
      Promise.allSettled(bridgePromises).then(() => resolve({ code, permanent }));
    }

    ws.on("open", () => {
      console.log("[mux-worker] connected to hub");

      // 1. 发送 announce 控制帧
      const announce = {
        channel: "__control__",
        method: "announce",
        channels: channels.map((c) => ({ id: c.id, agent: c.agent })),
      };
      ws.send(JSON.stringify(announce));
      console.log(`[mux-worker] announced ${channels.length} channels: ${channels.map(c => c.id).join(", ")}`);

      // 2. 为每个 channel 建立双向桥接
      for (const ch of channels) {
        // agent → hub：读 agent stdout，包装成 { channel, payload } 发到 ws
        const agentToHub = (async () => {
          const reader = ch.localStream.readable.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ channel: ch.id, payload: value }));
            }
          }
        })();

        // hub → agent：从 ws 收 { channel: ch.id, payload }，写入 agent stdin
        // 这部分由 message handler 处理，这里只做反向桥接的 Promise
        bridgePromises.push(
          agentToHub.catch((err) => {
            console.warn(`[mux-worker] channel ${ch.id} agent→hub error: ${String(err)}`);
          }),
        );
      }

      // 3. ws message handler：按 channel 分发到对应 agent stdin
      const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        const frame = msg as Record<string, unknown>;
        const chId = frame.channel;
        const payload = frame.payload;
        if (typeof chId !== "string" || chId === "__control__") return;
        if (typeof payload !== "object" || payload === null) return;

        const ch = channels.find((c) => c.id === chId);
        if (!ch) return;

        const writer = ch.localStream.writable.getWriter();
        writer.write(payload as AnyMessage).then(() => writer.releaseLock()).catch((err: unknown) => {
          console.warn(`[mux-worker] channel ${chId} hub→agent write error: ${String(err)}`);
        });
      };

      ws.on("message", onMessage);

      // 4. 也把 hub→agent 的 pipeTo 加入 bridgePromises 以便清理
      for (const ch of channels) {
        bridgePromises.push(
          (async () => {
            // 等待 abort 或 agent 进程退出
            await new Promise<void>((resolve) => {
              abort.signal.addEventListener("abort", () => resolve(), { once: true });
              ch.proc.on("exit", () => resolve());
            });
          })(),
        );
      }

      Promise.allSettled(bridgePromises).then(() => {
        console.log("[mux-worker] all bridges closed");
        finish(1006, false);
      });
    });

    ws.on("close", (code) => {
      console.log(`[mux-worker] hub disconnected code=${code}`);
      finish(code ?? 1006, PERMANENT_CLOSE_CODES.has(code ?? 1006));
    });

    ws.on("error", (err) => {
      console.error("[mux-worker] ws error:", err);
      finish(1006, false);
    });
  });
}

async function main(): Promise<void> {
  const agentList = detectAgents();
  if (agentList.length === 0) {
    console.error("[mux-worker] no agents available");
    process.exit(1);
  }

  console.log(`[mux-worker] starting agents: ${agentList.join(", ")}`);

  const channels: Channel[] = [];
  for (const agent of agentList) {
    const ch = spawnAgent(agent);
    if (ch) channels.push(ch);
  }

  if (channels.length === 0) {
    console.error("[mux-worker] all agents failed to spawn");
    process.exit(1);
  }

  // 任意 agent 退出时整体退出
  for (const ch of channels) {
    ch.proc.on("exit", (code) => {
      console.log(`[mux-worker] agent ${ch.id} exited code=${code}, shutting down`);
      for (const c of channels) {
        if (c.proc.exitCode === null) c.proc.kill();
      }
      process.exit(0);
    });
  }

  while (true) {
    const result = await runOnce(channels);
    if (result.permanent) {
      console.log(`[mux-worker] permanent close code=${result.code}, exiting`);
      process.exit(0);
    }
    console.log(`[mux-worker] reconnecting in ${retryDelay}ms`);
    await new Promise((r) => setTimeout(r, retryDelay));
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  }
}

main();
