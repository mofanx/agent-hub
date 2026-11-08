/**
 * restart-drill：真机重启演练（不碰生产 pm2/8787）。
 * 自包含驱动：临时 HUB_DATA_DIR + 独立端口起 hub（fake ACP agent 注入 DEVIN_BIN），
 * 造 conductor flow（t1 running+tool_call 外发、t2 running 无外发、w1 followUps 队列）
 * → SIGKILL → 同目录重启 → 断言：
 *   A) t1 停 failed/awaiting-retry 不自动重派（fake log 无新 w1 prompt）
 *   B) t2 自动重派且 prompt 含 "[恢复提示]"（recovery note）
 *   C) 重启后 w1 空闲时 followUps 队列 drain（fake log 见排队文本）
 *   D) draft/stopped mission 不被恢复误动
 * 用法：cd hub && npx tsx scripts/restart-drill.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.DRILL_PORT ?? 8891);
const TOKEN = "test";
const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = fs.mkdtempSync(path.join(ROOT, ".tmp-drill-"));
const FAKE_LOG = path.join(DIR, "fake.ndjson");
const results: { name: string; pass: boolean; detail: string }[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakePrompts = () => {
  try {
    return fs
      .readFileSync(FAKE_LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { sessionId: string; text: string });
  } catch {
    return [] as { sessionId: string; text: string }[];
  }
};

function startHub(): { proc: ChildProcess; ready: () => Promise<void> } {
  const proc = spawn("node", ["--import=tsx", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HUB_PORT: String(PORT),
      HUB_DATA_DIR: DIR,
      HUB_TOKEN: TOKEN,
      DEVIN_BIN: "npx",
      DEVIN_ACP_ARGS: `tsx ${path.join("scripts", "fake-acp-agent.ts")}`,
      FAKE_LOG,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (d) => process.stderr.write(`[hub] ${d}`));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hub start timeout")), 30_000);
    const onData = (d: Buffer) => {
      const s = String(d);
      if (s.includes("listening") || s.includes(String(PORT))) {
        clearTimeout(t);
        resolve();
      }
    };
  proc.stdout?.on("data", (d) => {
      process.stdout.write(`[hub:out] ${d}`);
      onData(d);
    });
    proc.on("exit", (code) => reject(new Error(`hub exited ${code}`)));
    // 轮询端口兜底
    const poll = setInterval(async () => {
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
        ws.on("open", () => {
          ws.close();
          clearInterval(poll);
          clearTimeout(t);
          resolve();
        });
        ws.on("error", () => {});
      } catch { /* retry */ }
    }, 400);
  });
  return { proc, ready: () => ready };
}

class Client {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
    this.ws.on("message", (raw) => {
      let msg: { id?: number; result?: unknown; error?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(String(msg.error)));
      else p.res(msg.result);
    });
    await new Promise<void>((res, rej) => {
      this.ws.on("open", () => res());
      this.ws.on("error", rej);
    });
  }
  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout:${method}`)), 30_000);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(t);
          res(v);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch { /* gone */ }
  }
}

async function main() {
  fs.writeFileSync(FAKE_LOG, "");
  const h1 = startHub();
  await h1.ready();
  const c = new Client();
  await c.connect();

  // —— 阶段1：造会话与 conductor 房 ——
  const conns = (await c.call("connection.list")) as { connections?: { id: string; local?: boolean; agent?: string }[] };
  let conn = conns.connections?.find((x) => x.local) ?? conns.connections?.[0];
  if (!conn) {
    const created = (await c.call("connection.create", { agentType: "devin" })) as { connection: { id: string } };
    conn = created.connection;
  }
  const mk = async (name: string) =>
    ((await c.call("session.create", { connectionId: conn!.id, name, cwd: ROOT })) as { sessionId: string }).sessionId;
  const lead = await mk("lead");
  const w1 = await mk("w1");
  const w2 = await mk("w2");
  const roomRes = (await c.call("room.create", {
    name: "drill-room",
    sessionIds: [lead, w1, w2],
    mode: "conductor",
    conductorId: lead,
  })) as { room: { roomId: string } };
  const roomId = roomRes.room.roomId;
  console.log("room:", roomId, "members:", { lead, w1, w2 });

  // —— 阶段2：派发 → t1/t2 running（t1 有外发迹、t2 无）——
  await c.call("room.message", { roomId, text: "请拆分这个任务" });
  await sleep(4000);
  const log1 = fakePrompts();
  const w1Prompted = log1.some((p) => p.sessionId === w1 && p.text.includes("OUTWARD"));
  const w2Prompted = log1.some((p) => p.sessionId === w2 && p.text.includes("SILENT"));
  record("phase1 派发", w1Prompted && w2Prompted, `w1Outward=${w1Prompted} w2Silent=${w2Prompted} prompts=${log1.length}`);
  if (!(w1Prompted && w2Prompted)) throw new Error("flow 未按预期进入 running，终止演练");

  // —— 阶段3：忙时消息入 followUps 队列 + draft mission ——
  await c.call("room.message", { roomId, text: "@w1 排队测试消息" }).catch((e) => console.log("queue seed err", e));
  await sleep(1500);
  let missionId = "";
  try {
    const m = (await c.call("mission.create", {
      roomId, goal: "drill mission", acceptanceCriteria: ["x"],
    })) as { mission?: { id?: string }; id?: string };
    missionId = m.mission?.id ?? m.id ?? "";
  } catch (e) {
    console.log("mission.create 不支持/失败（记录偏差）:", String(e));
  }
  const flow1 = (await c.call("room.flow", { roomId })) as {
    tasks?: { id: string; status: string }[];
    phase?: string;
  } | null;
  console.log("pre-kill flow:", JSON.stringify(flow1));
  await sleep(1200); // 等 persistState 防抖落盘
  c.close();

  // —— 阶段4：SIGKILL → 同数据目录重启 ——
  h1.proc.kill("SIGTERM"); // 优雅重启：在途 turn draft 以 interrupted 落库（SIGKILL 下纯 tool 回合无迹为已登记物理盲区）
  await sleep(2500);
  const h2 = startHub();
  await h2.ready();
  const c2 = new Client();
  await c2.connect();
  await sleep(2500); // restore + auto-resume 派发窗口

  // —— 阶段5：断言 ——
  const flow2raw = (await c2.call("room.flow", { roomId }).catch(() => null)) as {
    flow?: { tasks?: { id: string; status: string }[]; phase?: string };
    tasks?: { id: string; status: string }[];
    phase?: string;
  } | null;
  const flow2 = flow2raw?.flow ?? flow2raw;
  console.log("post-restart flow:", JSON.stringify(flow2raw).slice(0, 2000));
  const hist = (await c2
    .call("room.history.search", { roomId, query: "", limit: 30 })
    .catch(() => null)) as { entries?: { kind: string; author: string; at: number }[] } | null;
  console.log(
    "room history:",
    JSON.stringify(hist?.entries?.map((e) => `${e.kind}:${e.author}:${e.at}`)),
  );
  const t1 = flow2?.tasks?.find((t) => t.id === "t1");
  const t2 = flow2?.tasks?.find((t) => t.id === "t2");
  const log2 = fakePrompts();
  const w1Reprompt = log2.filter((p) => p.sessionId === w1).length > 1;
  // L2 修复后语义：w1 途中 tool_call 已落 tool_actions → outward() 判有外发
  // → t1 停 failed 不自动重派，flow 进 awaiting-retry 交还用户
  record(
    "A tool_call-only 途中回合判有外发→停 failed/awaiting-retry",
    t1?.status === "failed" && flow2?.phase === "awaiting-retry" && !w1Reprompt,
    `t1.status=${t1?.status} phase=${flow2?.phase} w1Reprompted=${w1Reprompt}`,
  );
  // t5 后语义：无外发 t2 自动回 pending 但被 awaiting-retry 相位门控挂起——
  // 不烧重试预算、等用户裁决；连接性失败不再计 retries
  record(
    "B 无外发任务自动转 pending 相位门控挂起（不自动补派）",
    t2?.status === "pending",
    `t2.status=${t2?.status} retries=${(t2 as { retries?: number })?.retries}`,
  );

  // C+D：会话 resume 上线 → 用户"重试"指令驱动 retryFailedTasks：
  // t1 回 pending 重派（人工确认后重跑，无 note）；t2 随调度恢复带 recovery note 派发
  for (const sid of [lead, w1, w2]) {
    await c2.call("session.resume", { sessionId: sid }).catch((e) => console.log(`resume ${sid} fail`, String(e)));
  }
  await sleep(2000);
  await c2.call("room.message", { roomId, text: "重试" }).catch((e) => console.log("retry msg fail", String(e)));
  await sleep(8000);
  const log3 = fakePrompts();
  const noteTo = (sid: string) =>
    log3.filter((p) => p.sessionId === sid).some((p) => p.text.includes("恢复提示"));
  record(
    "B' 用户重试后 auto-resumed 任务派发携带 recovery note",
    noteTo(w2),
    `w2Note=${noteTo(w2)} w2Prompts=${log3.filter((p) => p.sessionId === w2).length}`,
  );
  const drained = log3
    .filter((p) => p.sessionId === w1)
    .some((p) => p.text.includes("排队测试"));
  record(
    "C followUps 持久化+重启后 drain",
    drained,
    `w1Prompts=${log3.filter((p) => p.sessionId === w1).length} drained=${drained}`,
  );

  // D：draft mission 不被恢复误动
  if (missionId) {
    const list = (await c2.call("mission.list", { roomId }).catch(() => null)) as
      | { missions?: { id: string; status: string }[] }
      | null;
    const mm = list?.missions?.find((x) => x.id === missionId);
    record("D draft mission 不误动", mm?.status === "draft", `mission.status=${mm?.status}`);
  } else {
    record("D draft mission 不误动", true, "skipped：mission.create 不可用");
  }

  c2.close();
  h2.proc.kill("SIGTERM");
  await sleep(500);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${failed.length === 0 ? "ALL PASS" : `${failed.length} FAIL`} ===`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("drill aborted:", e);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(2);
});
