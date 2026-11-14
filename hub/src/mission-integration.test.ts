import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { RoomManager } from "./room.js";
import { Store } from "./store.js";
import { MissionManager } from "./mission.js";
import { createPromptDoneParams, promptDoneInternalOutput } from "./agent.js";
import { toCardSnapshot } from "./flow-card.js";

function makeFixture(mode: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-it-"));
  const store = new Store(dir);
  const rooms = new RoomManager();
  const room = rooms.create(
    "team",
    [
      { sessionId: "s1", name: "lead" },
      { sessionId: "s2", name: "coder" },
    ],
    mode as never,
    { conductorId: "s1" } as never,
  );
  const busy = new Set<string>();
  const mockPrompts: { sid: string; content: unknown }[] = [];
  const agent: AgentOps = {
    prompt: async (sid, content) => {
      busy.add(sid);
      mockPrompts.push({ sid, content });
    },
    isBusy: (sid) => busy.has(sid),
    cancel: async (sid) => {
      busy.delete(sid);
    },
  };
  const roomModes = new RoomModeManager(agent, rooms, () => {});
  roomModes.setStore(store);
  const mission = new MissionManager({
    store,
    getRoom: (id) => rooms.get(id),
    getFlow: (id) => roomModes.getFlow(id),
    hasActiveFlow: (id) => roomModes.hasActiveFlow(id),
    isBusy: (sid) => agent.isBusy(sid),
    isAvailable: () => true,
    roomIdForTurn: (sid) => roomModes.roomIdForTurn(sid),
    dispatch: async (r, text, options) => roomModes.handle(r, text, { ...options, bypassFilter: true }),
    cancelActive: (roomId, reason) => roomModes.cancelActive(roomId, reason),
    cancel: (sid) => agent.cancel(sid),
    retryFailedTasks: (roomId, taskIds) => roomModes.retryFailedTasks(roomId, taskIds),
    supplementActive: (r, text, missionId) => roomModes.supplementActive(r, text, missionId),
    broadcast: () => {},
  });
  mission.beginRestore();
  mission.reconcile();
  roomModes.onFlowCard = (roomId, flow) => {
    mission.syncFlow(roomId, flow);
  };
  async function done(sid: string, output: string) {
    const roomId = roomModes.roomIdForTurn(sid);
    busy.delete(sid);
    const internal = promptDoneInternalOutput(createPromptDoneParams(sid, "end_turn", output));
    await roomModes.onPromptDone(sid, internal);
    mission.onTurnDone(sid, roomId, internal);
  }
  function err(sid: string, message: string) {
    const roomId = roomModes.roomIdForTurn(sid);
    const ctx = mission.captureTurnContext(sid, roomId);
    busy.delete(sid);
    roomModes.onPromptError(sid, message);
    mission.onTurnError(sid, roomId, message, ctx);
  }
  const mk = (goal: string) =>
    mission.create({ roomId: room.roomId, goal, acceptanceCriteria: ["c1"], ownerSessionId: "s1" });
  return { dir, store, rooms, room, agent, busy, mockPrompts, roomModes, mission, done, err, mk };
}

describe("mission-integration", () => {
  it("无标记旧 active flow：start 拒绝，draft 保持，旧 flow 与 prompt 不变", async () => {
    const fx = makeFixture("parallel");
    await fx.roomModes.handle(fx.room, "旧并行任务", {});
    const flowBefore = fx.roomModes.getFlow(fx.room.roomId);
    const promptsBefore = fx.mockPrompts.length;
    const m = fx.mk("MISSION_GOAL");
    await assert.rejects(() => fx.mission.start(m.id), /active flow/);
    assert.equal(fx.mission.get(m.id)!.status, "draft");
    assert.equal(fx.roomModes.getFlow(fx.room.roomId)?.flowId, flowBefore?.flowId);
    assert.equal(fx.mockPrompts.length, promptsBefore);
    fx.store.close();
  });

  it("无 flow 的 mission 正常启动并绑定自有 flow", async () => {
    const fx = makeFixture("parallel");
    const m = fx.mk("PAR_GOAL");
    const started = await fx.mission.start(m.id);
    assert.equal(started.status, "running");
    assert.equal(typeof started.flowId, "string");
    fx.store.close();
  });

  it("pipeline 首成员 error：真实原因进 Mission error + 结构化事件", async () => {
    const fx = makeFixture("pipeline");
    const m = fx.mk("PIPE_GOAL");
    await fx.mission.start(m.id);
    fx.err("s1", "MOCK_AUTH_EXPIRED");
    const cur = fx.mission.get(m.id)!;
    assert.equal(cur.status, "failed");
    assert.equal(cur.error, "MOCK_AUTH_EXPIRED");
    const ev = cur.events.find((e) => e.kind === "error" && e.text.includes("MOCK_AUTH_EXPIRED"));
    assert.ok(ev, "error event with real message");
    assert.equal(ev!.sessionId, "s1");
    assert.equal(ev!.flowId, cur.flowId);
    assert.ok(ev!.phase);
    fx.store.close();
  });

  it("parallel 首轮全成功 + 同成员 summary error：Mission failed 且 flow.failureMessage 保留", async () => {
    const fx = makeFixture("parallel");
    const m = fx.mk("PAR_GOAL");
    await fx.mission.start(m.id);
    await fx.done("s1", "s1首轮");
    await fx.done("s2", "s2首轮");
    assert.equal(fx.roomModes.getFlow(fx.room.roomId)?.phase, "summarizing");
    fx.err("s1", "MOCK_SUMMARY_TIMEOUT");
    const cur = fx.mission.get(m.id)!;
    assert.equal(cur.status, "failed");
    assert.equal(cur.error, "MOCK_SUMMARY_TIMEOUT");
    assert.equal(cur.events.some((e) => e.text.includes("MOCK_SUMMARY_TIMEOUT")), true);
    const flow = fx.roomModes.getFlow(fx.room.roomId);
    assert.equal(flow?.phase, "done");
    assert.equal(flow?.failureMessage, "MOCK_SUMMARY_TIMEOUT");
    const tasks = (flow?.tasks ?? []) as { status: string }[];
    assert.deepEqual(tasks.map((t) => t.status), ["done", "done"]);
    fx.store.close();
  });

  it("summary error 缺省 message：failureMessage 仍非空，Mission failed", async () => {
    const fx = makeFixture("parallel");
    const m = fx.mk("PAR_GOAL");
    await fx.mission.start(m.id);
    await fx.done("s1", "s1首轮");
    await fx.done("s2", "s2首轮");
    const roomId = fx.roomModes.roomIdForTurn("s1");
    const ctx = fx.mission.captureTurnContext("s1", roomId);
    fx.busy.delete("s1");
    fx.roomModes.onPromptError("s1");
    fx.mission.onTurnError("s1", roomId, "", ctx);
    const cur = fx.mission.get(m.id)!;
    assert.equal(cur.status, "failed");
    const flow = fx.roomModes.getFlow(fx.room.roomId);
    assert.ok(typeof flow?.failureMessage === "string" && flow.failureMessage.length > 0);
    fx.store.close();
  });

  it("conductor 主持人 error：保留待重试快照，Mission 等待用户且保留真实原因", async () => {
    const fx = makeFixture("conductor");
    const m = fx.mk("COND_GOAL");
    await fx.mission.start(m.id);
    fx.err("s1", "MOCK_CONDUCTOR_DOWN");
    const cur = fx.mission.get(m.id)!;
    assert.equal(cur.status, "waiting-user");
    assert.equal(cur.error, "MOCK_CONDUCTOR_DOWN");
    const flow = fx.roomModes.getFlow(fx.room.roomId);
    assert.equal(flow?.phase, "awaiting-retry");
    assert.equal(flow?.failureMessage, "MOCK_CONDUCTOR_DOWN");
    fx.store.close();
  });

  it("终态 context 只补原单；新单与重试新批次隔离", async () => {
    const fx = makeFixture("pipeline");
    const m = fx.mk("PIPE_GOAL");
    await fx.mission.start(m.id);
    const roomId = fx.roomModes.roomIdForTurn("s1");
    const ctx = fx.mission.captureTurnContext("s1", roomId);
    assert.ok(ctx);
    fx.busy.delete("s1");
    fx.roomModes.onPromptError("s1", "MOCK_AUTH_EXPIRED");
    fx.mission.onTurnError("s1", roomId, "MOCK_AUTH_EXPIRED", ctx);
    const first = fx.mission.get(m.id)!;
    assert.equal(first.status, "failed");
    const oldEvents = first.events.length;
    const m2 = fx.mk("GOAL2");
    await fx.mission.start(m2.id);
    fx.mission.onTurnError("s1", roomId, "LATE_OLD_ERROR", ctx);
    const after = fx.mission.get(m.id)!;
    assert.equal(after.status, "failed");
    assert.equal(after.events.length, oldEvents + 1);
    assert.ok(after.events.at(-1)!.text.includes("LATE_OLD_ERROR"));
    const m2cur = fx.mission.get(m2.id)!;
    assert.equal(m2cur.status, "running");
    assert.equal(m2cur.events.every((e) => !e.text.includes("LATE_OLD_ERROR")), true);
    const retryCtx = { ...ctx, flowId: "fl-stale" };
    fx.mission.onTurnError("s1", roomId, "STALE_BATCH", retryCtx);
    assert.equal(fx.mission.get(m.id)!.events.every((e) => !e.text.includes("STALE_BATCH")), true);
    assert.equal(fx.mission.get(m2.id)!.events.every((e) => !e.text.includes("STALE_BATCH")), true);
    fx.store.close();
  });

  it("结构化事件字段经 Manager 重建后保留", async () => {
    const fx = makeFixture("pipeline");
    const m = fx.mk("PIPE_GOAL");
    await fx.mission.start(m.id);
    fx.err("s1", "MOCK_AUTH_EXPIRED");
    const rebuilt = new MissionManager({
      store: fx.store,
      getRoom: (id) => fx.rooms.get(id),
      getFlow: (id) => fx.roomModes.getFlow(id),
      hasActiveFlow: (id) => fx.roomModes.hasActiveFlow(id),
      isBusy: (sid) => fx.agent.isBusy(sid),
      isAvailable: () => true,
      dispatch: async () => ({ sent: [], mentioned: [], skipped: [] }),
      cancelActive: async () => {},
      cancel: async () => {},
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: () => {},
    });
    const cur = rebuilt.get(m.id)!;
    const ev = cur.events.find((e) => e.kind === "error" && e.text.includes("MOCK_AUTH_EXPIRED"));
    assert.ok(ev);
    assert.equal(ev!.sessionId, "s1");
    assert.equal(ev!.flowId, cur.flowId);
    assert.ok(ev!.phase);
    fx.store.close();
  });

  it("空/全空白 error message 归一为非空默认原因，Mission failed", async () => {
    for (const raw of ["", "   "]) {
      const fx = makeFixture("parallel");
      const m = fx.mk("PAR_GOAL");
      await fx.mission.start(m.id);
      await fx.done("s1", "s1首轮");
      await fx.done("s2", "s2首轮");
      assert.equal(fx.roomModes.getFlow(fx.room.roomId)?.phase, "summarizing");
      const roomId = fx.roomModes.roomIdForTurn("s1");
      const ctx = fx.mission.captureTurnContext("s1", roomId);
      fx.busy.delete("s1");
      const message = raw.trim() || "turn error";
      fx.roomModes.onPromptError("s1", message);
      fx.mission.onTurnError("s1", roomId, message, ctx);
      const cur = fx.mission.get(m.id)!;
      assert.equal(cur.status, "failed");
      assert.ok(typeof cur.error === "string" && cur.error.length > 0);
      assert.equal(fx.roomModes.getFlow(fx.room.roomId)?.failureMessage, "turn error");
      fx.store.close();
    }
  });

  it("context.taskId+dispatchedAt 与当前任务窗口不符：整条回调忽略不写状态", async () => {
    const fx = makeFixture("conductor");
    const m = fx.mk("COND_GOAL");
    await fx.mission.start(m.id);
    await fx.done("s1", '```json\n{"tasks":[{"id":"t1","to":"coder","task":"做事"}]}\n```');
    const roomId = fx.roomModes.roomIdForTurn("s2");
    const ctx = fx.mission.captureTurnContext("s2", roomId);
    assert.ok(ctx?.taskId && ctx.dispatchedAt !== undefined);
    const before = fx.mission.get(m.id)!;
    const eventsBefore = before.events.length;
    const pendingBefore = (before as unknown as Record<string, unknown>).status;
    fx.err("s2", "WORKER_RETRYABLE");
    const mid = fx.mission.get(m.id)!;
    const taskNow = ((mid.flow?.tasks ?? []) as Record<string, unknown>[]).find((t) => t.id === ctx.taskId);
    assert.ok(taskNow && taskNow.dispatchedAt !== ctx.dispatchedAt, "重派后 dispatchedAt 已前进");
    fx.mission.onTurnError("s2", roomId, "STALE_OLD_TURN", ctx);
    const after = fx.mission.get(m.id)!;
    assert.equal(after.status, mid.status);
    assert.equal(after.events.length, mid.events.length);
    assert.equal(after.error, mid.error);
    assert.equal(pendingBefore, "running");
    assert.ok(eventsBefore > 0);
    fx.store.close();
  });

  it("flow-card 快照保留 missionId 与 failureMessage", () => {
    const card = toCardSnapshot(
      {
        flowId: "f1",
        phase: "done",
        goal: "g",
        missionId: "ms_x",
        failureMessage: "MOCK_ERR",
        startedAt: 1,
        tasks: [{ id: "t1", sessionId: "s1", name: "n", status: "failed", task: "t", failureMessage: "MOCK_ERR" }],
      },
      "parallel",
    );
    assert.equal(card.missionId, "ms_x");
    assert.equal(card.failureMessage, "MOCK_ERR");
  });
});
