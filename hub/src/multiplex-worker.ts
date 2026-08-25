/**
 * Multiplex Worker：一个 WebSocket 连接复用多个本地 ACP agent。
 *
 * 用法：
 *   HUB_URL=ws://hub:8787/worker CONNECTION_TOKEN=xxx npx tsx src/multiplex-worker.ts
 *
 * 环境变量：
 *   HUB_URL            Hub 的 WebSocket 地址（必填）
 *   CONNECTION_TOKEN   Hub connection token（必填）
 *   AGENTS             要启动的 agent 列表，逗号分隔（可选，默认自动检测）
 *                       例：AGENTS=devin,opencode,claude
 *   EXCLUDE_AGENTS     要排除的 agent，逗号分隔（可选，默认空）
 *                       例：EXCLUDE_AGENTS=codex
 *
 * Agent 自动检测：
 *   不设置 AGENTS 时，worker 会检测本地 PATH 中哪些 agent CLI 可用：
 *     devin     → devin acp
 *     opencode  → opencode acp
 *     claude    → npx @agentclientprotocol/claude-agent-acp
 *     codex     → npx @agentclientprotocol/codex-acp
 *   只启动检测到的 agent，无需手动声明。
 *   也可通过 AGENTS 显式指定子集，或用 EXCLUDE_AGENTS 排除部分。
 *
 * 工作流程：
 * 1. 检测本地可用的 agent（AGENTS 显式指定 或 自动检测 PATH）
 * 2. 为每个 agent spawn 一个 ACP 进程
 * 3. 连接 Hub（带 multiplex=1）
 * 4. 发送 announce 控制帧声明可用通道
 * 5. 双向桥接：agent stdio ↔ WebSocket channel
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

// --help / -h：打印帮助后退出
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Multiplex Worker — 单 WebSocket 连接复用多个本地 ACP agent

用法：
  HUB_URL=ws://<hub>:8787/worker CONNECTION_TOKEN=<token> npx tsx src/multiplex-worker.ts
  HUB_URL=... CONNECTION_TOKEN=... AGENTS=devin,opencode npx tsx src/multiplex-worker.ts

环境变量：
  HUB_URL            Hub 的 WebSocket 地址（必填）
                     例：ws://192.168.1.100:8787/worker
  CONNECTION_TOKEN   Hub connection token（必填，从 App「Agent 来源」复制）
  AGENTS             要启动的 agent 列表，逗号分隔（可选）
                     不设置时自动检测本地 PATH 中可用的 agent
                     例：AGENTS=devin,opencode,claude
  EXCLUDE_AGENTS     要排除的 agent，逗号分隔（可选）
                     例：EXCLUDE_AGENTS=codex

支持的 agent：
  devin      devin acp              （需 devin auth login）
  opencode   opencode acp           （需 npm i -g opencode-ai）
  claude     npx ...claude-agent-acp（需 claude auth login）
  codex      npx ...codex-acp       （需 codex login）

自动检测：
  不设置 AGENTS 时，worker 检测本地 PATH 中哪些 agent CLI 可用，
  只启动检测到的。claude/codex 走 npx -y 自动下载，视为可用。
  也可用 AGENTS 显式指定子集，或 EXCLUDE_AGENTS 排除部分。

工作流程：
  1. 检测可用 agent → spawn ACP 进程
  2. 连接 Hub（带 multiplex=1）
  3. 发送 announce 控制帧声明通道
  4. 双向桥接：agent stdio ↔ WebSocket channel

Hub 侧会为每个通道自动创建虚拟 connection（ID: <base>::<agent>），
客户端像使用独立 connection 一样创建会话、发 prompt。`);
  process.exit(0);
}

if (!HUB_URL) throw new Error("[mux-worker] HUB_URL required");
if (!TOKEN) throw new Error("[mux-worker] CONNECTION_TOKEN required");

/** 检查可执行文件是否在 PATH 中（npx 始终可用） */
function isBinAvailable(bin: string): boolean {
  if (bin === "npx") return true; // npx 是 Node 自带
  try {
    const r = spawnSync("command", ["-v", bin], { stdio: "ignore", shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 检测本地可用的 agent：显式指定 或 自动检测 PATH */
function detectAgents(): string[] {
  const allKnown = ["devin", "opencode", "claude", "codex"];
  const candidates = AGENTS_ENV
    ? AGENTS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
    : allKnown;

  const available: string[] = [];
  for (const agent of candidates) {
    if (EXCLUDE.includes(agent)) continue;
    const def = getAgentDef(agent);
    if (!def) {
      console.warn(`[mux-worker] unknown agent: ${agent}, skipping`);
      continue;
    }
    if (!isBinAvailable(def.bin)) {
      if (AGENTS_ENV) {
        // 显式指定的 agent 如果不可用，警告但不跳过（让 spawn 报错）
        console.warn(`[mux-worker] ${agent}: binary "${def.bin}" not in PATH`);
      } else {
        // 自动检测模式下，跳过不可用的
        console.log(`[mux-worker] ${agent}: not found in PATH, skipping`);
        continue;
      }
    }
    available.push(agent);
  }
  return available;
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
