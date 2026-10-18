import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionManager, type Mission, type MissionDeps } from "./mission.js";
import { RoomManager, type Room } from "./room.js";
import { Store } from "./store.js";
import type { ModeResult } from "./room-modes.js";

type Broadcast = { method: string; params: Record<string, unknown> };

const cleanupStores: Store[] = [];
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const s of cleanupStores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const d of cleanupDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpStore(prefix = "mission-test-"): { dir: string; store: Store } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new Store(dir);
  cleanupDirs.push(dir);
  cleanupStores.push(store);
  return { dir, store };
}

type Harness = {
  dir: string;
  store: Store;
  rooms: RoomManager;
  room: Room;
  manager: MissionManager;
  broadcasts: Broadcast[];
  busy: Set<string>;
  cancelled: string[];
  cancelActived: string[];
  dispatched: { text: string; note?: string }[];
  state: { flow: Record<string, unknown> | undefined; activeFlow: boolean };
  retryCalls: { id: string; taskIds?: string[] }[];
  supplementLog: string[];
  setRetry(v: boolean): void;
  setRetryThrows(v: boolean): void;
  setSupplement(v: boolean): void;
  setDispatch(fn: (room: Room, text: string) => Promise<ModeResult>): void;
};

function makeHarness(
  members = [
    { sessionId: "s1", name: "lead" },
    { sessionId: "s2", name: "coder" },
  ],
  mode: "mention" | "conductor" | "auto" = "mention",
): Harness {
  const { dir, store } = tmpStore();
  const rooms = new RoomManager();
  const room = rooms.create("t", members, mode, { conductorId: "s1" });
  const broadcasts: Broadcast[] = [];
  const busy = new Set<string>();
  const cancelled: string[] = [];
  const cancelActived: string[] = [];
  const dispatched: { text: string; note?: string }[] = [];
  const retryCalls: { id: string; taskIds?: string[] }[] = [];
  let retryResult = false;
  let retryThrows = false;
  const supplementLog: string[] = [];
  let supplementResult = true;
  const state: Harness["state"] = { flow: undefined, activeFlow: false };
  let dispatchImpl = async (room: Room, text: string): Promise<ModeResult> => {
    const sent = room.members.map((m) => m.sessionId);
    for (const s of sent) busy.add(s);
    return { sent, mentioned: [], skipped: [] };
  };
  const deps: MissionDeps = {
    store,
    getRoom: (id) => rooms.get(id),
    getFlow: () => state.flow,
    hasActiveFlow: () => state.activeFlow,
    isBusy: (sid) => busy.has(sid),
    isAvailable: () => true,
    dispatch: async (r, text, options) => {
      dispatched.push(options?.note === undefined ? { text } : { text, note: options.note });
      return dispatchImpl(r, text);
    },
    cancelActive: async (id) => {
      cancelActived.push(id);
    },
    cancel: async (sid) => {
      cancelled.push(sid);
      busy.delete(sid);
    },
    retryFailedTasks: (id, taskIds) => {
      retryCalls.push(taskIds === undefined ? { id } : { id, taskIds });
      if (retryThrows) throw new Error("retry boom");
      return retryResult;
    },
    supplementActive: (r, t) => {
      if (!supplementResult || String(state.flow?.phase ?? "") === "awaiting-retry") return false;
      supplementLog.push(t);
      return true;
    },
    broadcast: (method, params) => broadcasts.push({ method, params }),
  };
  return {
    dir,
    store,
    rooms,
    room,
    manager: new MissionManager(deps),
    broadcasts,
    busy,
    cancelled,
    cancelActived,
    dispatched,
    state,
    retryCalls,
    supplementLog,
    setRetry: (v: boolean) => {
      retryResult = v;
    },
    setRetryThrows: (v: boolean) => {
      retryThrows = v;
    },
    setSupplement: (v: boolean) => {
      supplementResult = v;
    },
    setDispatch: (fn) => {
      dispatchImpl = fn;
    },
  };
}

function makeMission(h: Harness, extra: Record<string, unknown> = {}) {
  return h.manager.create({
    roomId: h.room.roomId,
    goal: "ship feature X",
    acceptanceCriteria: ["tests pass", "docs updated"],
    scope: "hub only",
    constraints: ["no network"],
    ...extra,
  });
}

function flowView(flowId: string, phase: string, tasks: Record<string, unknown>[] = []) {
  return { roomId: "x", flowId, phase, tasks };
}

describe("mission", () => {
  it("create 校验：room/goal/验收/owner", () => {
    const h = makeHarness();
    assert.throws(() => h.manager.create({ roomId: "nope", goal: "g", acceptanceCriteria: ["a"] }), /unknown room/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: 42, acceptanceCriteria: ["a"] }), /string/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "  ", acceptanceCriteria: ["a"] }), /goal required/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: "x" }), /array/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: [] }), /at least one/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["  "] }), /at least one/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: [1] }), /array of strings/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], constraints: [1] }), /array of strings/);
    assert.throws(() => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], ownerSessionId: "ghost" }), /not a room member/);
    const m = makeMission(h);
    assert.equal(m.status, "draft");
    assert.equal(m.ownerSessionId, "s1"); // 默认 conductorId
    assert.equal(m.scope, "hub only");
    assert.deepEqual(m.constraints, ["no network"]);
    const m2 = h.manager.create({
      roomId: h.room.roomId,
      goal: "g2",
      acceptanceCriteria: ["a"],
      ownerSessionId: "s2",
    });
    assert.equal(m2.ownerSessionId, "s2");
    assert.equal(h.manager.list().length, 2, "一个 room 可有多 draft");
  });

  it("持久化：重建 manager 恢复，空库兼容", () => {
    const h = makeHarness();
    const m = makeMission(h);
    const reopened = new MissionManager({
      store: h.store,
      getRoom: (id) => h.rooms.get(id),
      getFlow: () => undefined,
      hasActiveFlow: () => false,
      isBusy: () => false,
      isAvailable: () => true,
      dispatch: async () => ({ sent: [], mentioned: [], skipped: [] }),
      cancelActive: async () => {},
      cancel: async () => {},
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: () => {},
    });
    const restored = reopened.get(m.id);
    assert.equal(restored?.goal, "ship feature X");
    assert.equal(restored?.status, "draft");
    assert.deepEqual(restored?.acceptanceCriteria, ["tests pass", "docs updated"]);
    assert.equal(restored?.events.length, m.events.length);
    // 旧库：meta 中无 key → 空列表
    const { store: store2 } = tmpStore("mission-empty-");
    const empty = new MissionManager({
      store: store2,
      getRoom: () => undefined,
      getFlow: () => undefined,
      hasActiveFlow: () => false,
      isBusy: () => false,
      isAvailable: () => true,
      dispatch: async () => ({ sent: [], mentioned: [], skipped: [] }),
      cancelActive: async () => {},
      cancel: async () => {},
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: () => {},
    });
    assert.deepEqual(empty.list(), []);
  });

  it("持久化：损坏数据显式失败而非静默覆盖", () => {
    const h = makeHarness();
    h.store.setMeta("missions.v1", "not-json{{{");
    assert.throws(
      () =>
        new MissionManager({
          store: h.store,
          getRoom: () => undefined,
          getFlow: () => undefined,
          hasActiveFlow: () => false,
          isBusy: () => false,
          isAvailable: () => true,
          dispatch: async () => ({ sent: [], mentioned: [], skipped: [] }),
          cancelActive: async () => {},
          cancel: async () => {},
          retryFailedTasks: () => false,
          supplementActive: () => false,
          broadcast: () => {},
        }),
      /missions\.v1/,
    );
  });

  it("start 拒绝：busy / 活跃flow / 房间被占 / 重复start", async () => {
    const h = makeHarness();
    h.busy.add("s2");
    const m1 = makeMission(h);
    await assert.rejects(() => h.manager.start(m1.id), /member busy/);
    h.busy.clear();
    h.state.activeFlow = true;
    await assert.rejects(() => h.manager.start(m1.id), /active flow/);
    h.state.activeFlow = false;
    // 另一 mission 占用房间
    const occ = makeMission(h);
    await h.manager.start(occ.id);
    h.busy.clear();
    await assert.rejects(() => h.manager.start(m1.id), /occupied/);
    // 重复 start
    await assert.rejects(() => h.manager.start(occ.id), /not startable/);
  });

  it("dispatch 为空且无 flow → failed；dispatch 抛错 → failed", async () => {
    const h = makeHarness();
    h.setDispatch(async () => ({ sent: [], mentioned: [], skipped: [] }));
    const m = makeMission(h);
    const res = await h.manager.start(m.id);
    assert.equal(res.status, "failed");

    const h2 = makeHarness();
    h2.setDispatch(async () => {
      throw new Error("boom");
    });
    const m2 = makeMission(h2);
    await assert.rejects(() => h2.manager.start(m2.id), /boom/);
    assert.equal(h2.manager.get(m2.id)?.status, "failed");
    assert.match(h2.manager.get(m2.id)?.error ?? "", /boom/);
  });

  it("旧 done 卡不能终结新 mission（baselineFlowId）", async () => {
    const h = makeHarness(undefined, "conductor");
    // 房间残留上一轮已完成 flow 快照
    h.state.flow = flowView("flow_old", "done", [{ id: "t1", status: "done" }]);
    h.setDispatch(async (room) => {
      h.busy.add("s1");
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    const started = await h.manager.start(m.id);
    assert.equal(started.status, "running");
    // 旧 done 卡再次广播（flowUpdate 重放）→ 不得终结
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "running");
    // 新 flow 出现 → 绑定
    const nf = flowView("flow_new", "working", [{ id: "t1", status: "running" }]);
    h.state.flow = nf;
    h.manager.syncFlow(h.room.roomId, nf);
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.flowId, "flow_new");
    assert.equal(cur.status, "running");
  });

  it("无flow单成员：sent → done → awaiting-acceptance", async () => {
    const h = makeHarness([{ sessionId: "s1", name: "solo" }]);
    h.setDispatch(async () => {
      h.busy.add("s1");
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    assert.equal(h.manager.get(m.id)?.status, "running");
    h.busy.delete("s1");
    h.manager.onTurnDone("s1", h.room.roomId, "done: all good");
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.status, "awaiting-acceptance");
    assert.ok(cur.output?.includes("all good"));
    assert.ok(cur.finishedAt);
  });

  it("无flow多成员：全部 done 才完成，任一 error 即 failed", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    await h.manager.start(m.id); // mention: sent=[s1,s2]
    h.busy.delete("s1");
    h.manager.onTurnDone("s1", h.room.roomId, "part1");
    assert.equal(h.manager.get(m.id)?.status, "running", "s2 仍在途不得完成");
    h.busy.delete("s2");
    h.manager.onTurnDone("s2", h.room.roomId, "part2");
    assert.equal(h.manager.get(m.id)?.status, "awaiting-acceptance");

    const h2 = makeHarness();
    const m2 = makeMission(h2);
    await h2.manager.start(m2.id);
    h2.busy.delete("s1");
    h2.manager.onTurnDone("s1", h2.room.roomId, "ok");
    h2.busy.delete("s2");
    h2.manager.onTurnError("s2", h2.room.roomId, "agent exploded");
    const cur2 = h2.manager.get(m2.id)!;
    assert.equal(cur2.status, "failed");
    assert.match(cur2.error ?? "", /exploded/);
  });

  it("auto 决策/worker 接力不提前终结", async () => {
    const h = makeHarness(undefined, "auto");
    h.setDispatch(async () => {
      h.busy.add("s1");
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    // host 决策完成，编排内部转派 worker（onPromptDone 期间 s2 变 busy，无 flow）
    h.busy.delete("s1");
    h.busy.add("s2");
    h.manager.onTurnDone("s1", h.room.roomId, "decision: mention coder");
    assert.equal(h.manager.get(m.id)?.status, "running", "worker 接力仍在途");
    h.busy.delete("s2");
    h.manager.onTurnDone("s2", h.room.roomId, "worker output");
    assert.equal(h.manager.get(m.id)?.status, "awaiting-acceptance");
  });

  it("flow 等待用户 → waiting-user；恢复 running", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.busy.add("s1");
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    assert.equal(h.manager.get(m.id)?.flowId, "f1");
    h.state.flow = flowView("f1", "awaiting-input", [{ id: "t1", status: "running" }]);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "waiting-user");
    h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running", waitingFor: "user" }]);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "waiting-user", "任务等 user 也是 waiting-user");
    h.state.flow = flowView("f1", "awaiting-retry", []);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "waiting-user");
    h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "running");
  });

  it("flow done → awaiting-acceptance（非 accepted）；failed 任务 → failed", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.state.flow = flowView("f1", "done", [{ id: "t1", name: "coder", status: "done", output: "shipped" }]);
    h.state.activeFlow = false;
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.status, "awaiting-acceptance");
    assert.notEqual(cur.status, "accepted");
    assert.ok(cur.output?.includes("shipped"));

    const h2 = makeHarness(undefined, "conductor");
    h2.setDispatch(async () => {
      h2.state.activeFlow = true;
      h2.state.flow = flowView("f2", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m2 = makeMission(h2);
    await h2.manager.start(m2.id);
    h2.state.flow = flowView("f2", "done", [
      { id: "t1", status: "done" },
      { id: "t2", status: "failed" },
    ]);
    h2.manager.syncFlow(h2.room.roomId, h2.state.flow);
    assert.equal(h2.manager.get(m2.id)?.status, "failed");
  });

  it("绑定 flow 消失/取消 → stopped；迟到结果不改变 stopped", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.state.flow = undefined;
    h.state.activeFlow = false;
    h.manager.syncFlow(h.room.roomId, undefined);
    assert.equal(h.manager.get(m.id)?.status, "stopped");
    // 迟到的 done/flow 不得复活
    h.manager.onTurnDone("s1", h.room.roomId, "late");
    h.manager.syncFlow(h.room.roomId, flowView("f1", "done", [{ id: "t1", status: "done" }]));
    assert.equal(h.manager.get(m.id)?.status, "stopped");
  });

  it("stop：先落盘 stopped，迟到事件不复活；cancel 失败可见", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    await h.manager.start(m.id);
    const stopped = await h.manager.stop(m.id, "user abort");
    assert.equal(stopped.status, "stopped");
    assert.deepEqual(h.cancelActived, [], "无 flow 模式不触发 cancelActive");
    assert.deepEqual(h.cancelled.sort(), ["s1", "s2"]);
    h.manager.onTurnDone("s1", h.room.roomId, "late output");
    h.manager.onTurnError("s2", h.room.roomId, "late err");
    assert.equal(h.manager.get(m.id)?.status, "stopped");
    assert.equal(h.manager.get(m.id)?.events.at(-1)?.kind, "lifecycle");

    // cancelActive 失败 → 记录并声明不回滚
    const h2 = makeHarness();
    const mgr2 = new MissionManager({
      store: h2.store,
      getRoom: (id) => h2.rooms.get(id),
      getFlow: () => h2.state.flow,
      hasActiveFlow: () => h2.state.activeFlow,
      isBusy: (sid) => h2.busy.has(sid),
      isAvailable: () => true,
      dispatch: async () => {
        h2.busy.add("s1");
        h2.state.activeFlow = true;
        h2.state.flow = flowView("fc", "working", []);
        return { sent: ["s1"], mentioned: [], skipped: [] };
      },
      cancelActive: async () => {
        throw new Error("cannot cancel flow");
      },
      cancel: async () => {
        throw new Error("cancel refused");
      },
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: (method, params) => h2.broadcasts.push({ method, params }),
    });
    const m2 = mgr2.create({
      roomId: h2.room.roomId,
      goal: "g",
      acceptanceCriteria: ["a"],
    });
    await mgr2.start(m2.id);
    const stopped2 = await mgr2.stop(m2.id);
    assert.equal(stopped2.status, "stopped");
    assert.match(stopped2.error ?? "", /cannot cancel flow/);
    assert.match(stopped2.error ?? "", /not rolled back/);
    assert.match(stopped2.error ?? "", /cancel refused/);
    // 终态后再次 stop：幂等返回
    assert.equal((await mgr2.stop(m2.id)).status, "stopped");
  });

  it("reconcile：匹配活跃 flow 恢复同步，失配/无 flow → stopped，不重发 prompt", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);

    // 同一 store 重建（模拟重启）：flow 仍匹配 → 保持 running
    let dispatchedAfter = 0;
    const mk = (state: Harness["state"]) =>
      new MissionManager({
        store: h.store,
        getRoom: (id) => h.rooms.get(id),
        getFlow: () => state.flow,
        hasActiveFlow: () => state.activeFlow,
        isBusy: (sid) => h.busy.has(sid),
        isAvailable: () => true,
        dispatch: async () => {
          dispatchedAfter++;
          return { sent: [], mentioned: [], skipped: [] };
        },
        cancelActive: async () => {},
        cancel: async () => {},
        retryFailedTasks: () => false,
        supplementActive: () => false,
        broadcast: () => {},
      });
    const st1: Harness["state"] = { flow: h.state.flow, activeFlow: true };
    const r1 = mk(st1);
    r1.reconcile();
    assert.equal(r1.get(m.id)?.status, "running");
    assert.equal(dispatchedAfter, 0);

    // flow 丢失 → stopped 且不重发
    const st2: Harness["state"] = { flow: undefined, activeFlow: false };
    const r2 = mk(st2);
    r2.reconcile();
    const rec = r2.get(m.id)!;
    assert.equal(rec.status, "stopped");
    assert.match(rec.events.at(-1)?.text ?? "", /restart/);
    assert.equal(dispatchedAfter, 0);
    // reconcile 后迟到事件不复活
    r2.onTurnDone("s1", h.room.roomId, "late");
    assert.equal(r2.get(m.id)?.status, "stopped");
  });

  it("reconcile：无 flow 模式的 running → stopped", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    await h.manager.start(m.id); // mention sent=[s1,s2], pending 在持久化中
    const r = new MissionManager({
      store: h.store,
      getRoom: (id) => h.rooms.get(id),
      getFlow: () => undefined,
      hasActiveFlow: () => false,
      isBusy: () => false,
      isAvailable: () => true,
      dispatch: async () => {
        throw new Error("must not re-dispatch");
      },
      cancelActive: async () => {},
      cancel: async () => {},
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: () => {},
    });
    r.reconcile();
    assert.equal(r.get(m.id)?.status, "stopped");
  });

  it("状态变化广播 mission.update", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    let ups = h.broadcasts.filter((b) => b.method === "mission.update");
    assert.equal(ups.length, 1);
    assert.equal((ups[0]!.params.mission as Mission).status, "draft");
    await h.manager.start(m.id);
    ups = h.broadcasts.filter((b) => b.method === "mission.update");
    assert.ok(ups.length >= 2);
    assert.equal((ups.at(-1)!.params.mission as Mission).status, "running");
    // snapshot 不泄露内部字段
    const snap = ups.at(-1)!.params.mission as Record<string, unknown>;
    assert.equal(snap.pending, undefined);
    assert.equal(snap.sent, undefined);
    assert.equal(snap.baselineFlowId, undefined);
  });

  it("flow sync 幂等：重复相同状态不追加历史", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    const evCount = h.manager.get(m.id)!.events.length;
    // 同一 phase 重复 sync → 无新事件
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)!.events.length, evCount);
  });
});

describe("mission v2", () => {
  const doneFlowMission = async (h: Harness) => {
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [
        { id: "t1", sessionId: "s1", status: "running" },
        { id: "t2", sessionId: "s2", status: "pending" },
      ]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.state.flow = flowView("f1", "done", [
      { id: "t1", sessionId: "s1", name: "lead", status: "done", output: "o1" },
      { id: "t2", sessionId: "s2", name: "coder", status: "done", output: "o2" },
    ]);
    h.state.activeFlow = false;
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    return m;
  };

  it("draft/awaiting-acceptance stop 不触发取消", async () => {
    const h = makeHarness();
    const d = makeMission(h);
    await h.manager.stop(d.id);
    assert.deepEqual(h.cancelActived, []);
    assert.deepEqual(h.cancelled, []);
    // awaiting-acceptance 结束态 stop：不动房间
    const h2 = makeHarness(undefined, "conductor");
    const m2 = await doneFlowMission(h2);
    assert.equal(h2.manager.get(m2.id)?.status, "awaiting-acceptance");
    await h2.manager.stop(m2.id);
    assert.deepEqual(h2.cancelActived, []);
    assert.equal(h2.manager.get(m2.id)?.status, "stopped");
  });

  it("dispatch await 中 stop：派发返回后取消本次任务不继续运行", async () => {
    const h = makeHarness(undefined, "conductor");
    let resolveDispatch!: (r: ModeResult) => void;
    h.setDispatch(() => new Promise<ModeResult>((res) => (resolveDispatch = res)));
    const m = makeMission(h);
    const started = h.manager.start(m.id);
    await new Promise((r) => setImmediate(r));
    const stopped = await h.manager.stop(m.id);
    assert.equal(stopped.status, "stopped");
    h.busy.add("s1");
    h.state.flow = flowView("f_new", "working", [{ id: "t1", status: "running" }]);
    h.state.activeFlow = true;
    resolveDispatch({ sent: ["s1"], mentioned: [], skipped: [] });
    await started;
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.status, "stopped");
    assert.equal(cur.flowId, "f_new");
    assert.deepEqual(h.cancelActived, [h.room.roomId], "匹配flow应 cancelActive");
    assert.deepEqual(h.cancelled, ["s1"], "在途成员应取消");
  });

  it("早完成收集：dispatch 期间 done 不挂死不复活", async () => {
    const h = makeHarness([{ sessionId: "s1", name: "solo" }]);
    let resolveDispatch!: (r: ModeResult) => void;
    h.setDispatch(() => new Promise<ModeResult>((res) => (resolveDispatch = res)));
    const m = makeMission(h);
    const started = h.manager.start(m.id);
    await new Promise((r) => setImmediate(r));
    // prompt.done 先于 sent/pending 初始化到达
    h.manager.onTurnDone("s1", h.room.roomId, "early result");
    resolveDispatch({ sent: ["s1"], mentioned: [], skipped: [] });
    const cur = await started;
    assert.equal(cur.status, "awaiting-acceptance", "早完成应计入收敛");
    assert.ok(cur.output?.includes("early result"));
  });

  it("无关成员 done/error 不消费；ownsTurn 限制", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    await h.manager.start(m.id); // sent=[s1,s2]
    const evCount = h.manager.get(m.id)!.events.length;
    h.manager.onTurnDone("ghost", h.room.roomId, "noise");
    h.manager.onTurnError("ghost", h.room.roomId, "noise err");
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.status, "running");
    assert.equal(cur.events.length, evCount, "无关回合不得记录");
    h.busy.clear();
    h.manager.onTurnDone("s1", h.room.roomId, "a");
    h.manager.onTurnDone("s2", h.room.roomId, "b");
    assert.equal(h.manager.get(m.id)?.status, "awaiting-acceptance");
  });

  it("flow phase=cancelled → stopped", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", []);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.manager.syncFlow(h.room.roomId, flowView("f1", "cancelled", []));
    assert.equal(h.manager.get(m.id)?.status, "stopped");
  });

  it("无flow error 先到时等其余在途收敛为 failed", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.busy.delete("s2");
    h.manager.onTurnError("s2", h.room.roomId, "s2 failed");
    assert.equal(h.manager.get(m.id)?.status, "running", "s1 仍在途不得立即 failed");
    const st = await h.manager.stop(m.id);
    assert.equal(st.status, "stopped", "期间仍允许 stop");
    // 重建一个验证最终 failed
    const h2 = makeHarness();
    const m2 = makeMission(h2);
    await h2.manager.start(m2.id);
    h2.busy.delete("s2");
    h2.manager.onTurnError("s2", h2.room.roomId, "s2 failed");
    h2.busy.delete("s1");
    h2.manager.onTurnDone("s1", h2.room.roomId, "ok");
    const cur = h2.manager.get(m2.id)!;
    assert.equal(cur.status, "failed");
    assert.match(cur.error ?? "", /s2 failed/);
  });

  it("stop 不误停其它房间的同 session", async () => {
    const h = makeHarness();
    const mgr = new MissionManager({
      store: h.store,
      getRoom: (id) => h.rooms.get(id),
      getFlow: () => h.state.flow,
      hasActiveFlow: () => h.state.activeFlow,
      isBusy: (sid) => h.busy.has(sid),
      isAvailable: () => true,
      roomIdForTurn: (sid) => (sid === "s1" ? "other-room" : h.room.roomId),
      dispatch: async () => {
        h.busy.add("s1");
        h.busy.add("s2");
        return { sent: ["s1", "s2"], mentioned: [], skipped: [] };
      },
      cancelActive: async (id) => {
        h.cancelActived.push(id);
      },
      cancel: async (sid) => {
        h.cancelled.push(sid);
      },
      retryFailedTasks: () => false,
      supplementActive: () => false,
      broadcast: () => {},
    });
    const m = mgr.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"] });
    await mgr.start(m.id);
    await mgr.stop(m.id);
    assert.deepEqual(h.cancelled, ["s2"], "s1 回合属于其它房间不得取消");
  });

  it("syncFlow 相同快照幂等；phase 变化记录稳定 kind", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", []);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    const ev1 = h.manager.get(m.id)!.events.length;
    const bc1 = h.broadcasts.length;
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.events.length, ev1, "相同快照不追加历史");
    assert.equal(h.broadcasts.length, bc1, "相同快照不广播");
    h.manager.syncFlow(h.room.roomId, flowView("f1", "reviewing", []));
    const evs = h.manager.get(m.id)!.events;
    assert.ok(evs.some((e) => e.kind === "flow" && e.text.includes("reviewing")), "phase 轨迹");
  });

  it("review：index/taskIds/note 校验与 pass 规则", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = await doneFlowMission(h);
    assert.throws(() => h.manager.review(m.id, { index: 9, verdict: "pass", taskIds: [], note: "x" }), /index/);
    assert.throws(() => h.manager.review(m.id, { index: 0, verdict: "maybe", taskIds: [], note: "x" }), /verdict/);
    assert.throws(() => h.manager.review(m.id, { index: 0, verdict: "pass", taskIds: ["nope"], note: "x" }), /taskId/);
    assert.throws(() => h.manager.review(m.id, { index: 0, verdict: "pass", taskIds: ["t1"], note: " " }), /non-empty/);
    const r = h.manager.review(m.id, { index: 0, verdict: "pass", taskIds: ["t1"], note: "核对过输出" });
    assert.equal(r.reviews[0]!.verdict, "pass");
    assert.equal(r.reviews[0]!.source, "user");
    const r2 = h.manager.review(m.id, { index: 1, verdict: "fail", taskIds: [], note: "不符合" });
    assert.equal(r2.reviews.find((x) => x.index === 1)?.verdict, "fail");
    // 非 awaiting-acceptance 拒绝
    const h2 = makeHarness();
    const d = makeMission(h2);
    assert.throws(() => h2.manager.review(d.id, { index: 0, verdict: "pass", taskIds: [], note: "x" }), /awaiting-acceptance/);
  });

  it("accept：全部人工 pass 才可 accepted；幂等；迟到不复活", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = await doneFlowMission(h);
    assert.throws(() => h.manager.accept(m.id), /manually passed/);
    h.manager.review(m.id, { index: 0, verdict: "pass", taskIds: [], note: "ok" });
    assert.throws(() => h.manager.accept(m.id), /manually passed/);
    h.manager.review(m.id, { index: 1, verdict: "pass", taskIds: ["t2"], note: "verified" });
    const acc = h.manager.accept(m.id, "验收通过");
    assert.equal(acc.status, "accepted");
    assert.ok(acc.acceptance?.note === "验收通过");
    // 幂等
    assert.equal(h.manager.accept(m.id).status, "accepted");
    // accepted 释放房间占用
    const d2 = makeMission(h);
    await h.manager.start(d2.id);
    // 迟到事件不复活
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)?.status, "accepted");
  });

  it("rework：复制契约生成新 draft，原记录保留并关联", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = await doneFlowMission(h);
    assert.throws(() => h.manager.rework(m.id, ""), /non-empty/);
    const nm = h.manager.rework(m.id, "范围不对，返工");
    const orig = h.manager.get(m.id)!;
    assert.equal(orig.status, "stopped");
    assert.ok(orig.events.some((e) => e.kind === "rework"));
    assert.equal(nm.status, "draft");
    assert.equal(nm.parentMissionId, m.id);
    assert.equal(nm.goal, m.goal);
    assert.deepEqual(nm.acceptanceCriteria, m.acceptanceCriteria);
    assert.equal(h.dispatched.length, 1, "返工绝不自动派发");
    // draft/running 状态拒绝 rework
    assert.throws(() => h.manager.rework(nm.id, "x"), /closed/);
  });

  it("rework：create 失败时原 mission 零副作用", async () => {
    const h = makeHarness(
      [
        { sessionId: "s1", name: "lead" },
        { sessionId: "s2", name: "coder" },
        { sessionId: "s3", name: "ops" },
      ],
      "mention",
    );
    const m = await doneFlowMission(h);
    assert.equal(h.manager.get(m.id)!.status, "awaiting-acceptance");
    const revBefore = h.manager.get(m.id)!.revision;
    // owner 已离房 → 子 draft 的 create 校验必然失败
    h.rooms.removeMember("s1");
    assert.throws(() => h.manager.rework(m.id, "返工"), /not a room member/);
    const orig = h.manager.get(m.id)!;
    assert.equal(orig.status, "awaiting-acceptance", "原 mission 不得被关闭");
    assert.equal(orig.revision, revBefore, "不得产生新提交");
    assert.ok(!orig.events.some((e) => e.kind === "rework"), "不得残留 rework 事件");
    assert.equal(h.manager.list().length, 1, "不得产生子 draft");
  });

  it("updateContract：仅 draft 可改，同 create 校验", async () => {
    const h = makeHarness();
    const m = makeMission(h);
    const updated = h.manager.updateContract(m.id, {
      goal: "new goal",
      acceptanceCriteria: ["c1", "c2", "c3"],
      scope: "s2",
      constraints: ["k1"],
      ownerSessionId: "s2",
    });
    assert.equal(updated.goal, "new goal");
    assert.equal(updated.ownerSessionId, "s2");
    assert.equal(updated.reviews.length, 3);
    assert.throws(
      () => h.manager.updateContract(m.id, { goal: "", acceptanceCriteria: ["a"], scope: "", constraints: [] }),
      /goal required/,
    );
    const h2 = makeHarness();
    const m2 = makeMission(h2);
    await h2.manager.start(m2.id);
    assert.throws(() => h2.manager.updateContract(m2.id, { goal: "x", acceptanceCriteria: ["a"], scope: "", constraints: [] }), /draft/);
  });

  it("supplement：activeFlow 透传 / awaiting-retry 只记录 / 无flow只记录", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async (room, text) => {
      if (h.state.activeFlow) return { sent: [], mentioned: [], skipped: [] };
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", []);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    const r = await h.manager.supplement(m.id, "追加：兼容旧格式");
    assert.equal(r.supplements.length, 1);
    assert.equal(r.supplements[0]!.delivered, true);
    assert.match(h.supplementLog.at(-1) ?? "", /^User supplement to mission ms_\w+:\n追加：兼容旧格式$/);
    assert.equal(h.dispatched.length, 1, "supplement 不走 handle 重派");
    // awaiting-retry → 只记录不重派
    h.state.flow = flowView("f1", "awaiting-retry", []);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    const suppBefore = h.supplementLog.length;
    const r2 = await h.manager.supplement(m.id, "retry 后记得带上");
    assert.equal(r2.supplements[1]!.delivered, false);
    assert.equal(h.supplementLog.length, suppBefore);
    assert.equal(h.dispatched.length, 1);
    // 非 active 状态拒绝
    const h2 = makeHarness();
    const d = makeMission(h2);
    await assert.rejects(() => h2.manager.supplement(d.id, "x"), /active/);
  });
});

describe("mission v3", () => {
  it("rework 原因与 supplements 进入新 draft 的派发 prompt", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", []);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    h.state.flow = flowView("f1", "done", [{ id: "t1", status: "done" }]);
    h.state.activeFlow = false;
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    const nm = h.manager.rework(m.id, "需求描述不完整");
    h.setDispatch(async () => ({ sent: ["s1"], mentioned: [], skipped: [] }));
    await h.manager.start(nm.id);
    const note = h.dispatched.at(-1)!.note!;
    assert.match(note, /"reworkReason": "需求描述不完整"/);
    assert.match(note, new RegExp(`"parentMissionId": "${m.id}"`));
    assert.match(note, /"supplements": \[\]/);
  });

  it("maxAutoRetries 校验：非法拒绝，draft 可改，运行不可改", async () => {
    const h = makeHarness();
    assert.throws(
      () => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: -1 }),
      /0\.\.3/,
    );
    assert.throws(
      () => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: 4 }),
      /0\.\.3/,
    );
    assert.throws(
      () => h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: 1.5 }),
      /0\.\.3/,
    );
    const m = h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: 2 });
    assert.equal(m.maxAutoRetries, 2);
    const d2 = makeMission(h);
    assert.equal(d2.maxAutoRetries, 0, "默认关闭");
    h.manager.updateContract(d2.id, { goal: "g", acceptanceCriteria: ["a"], scope: "", constraints: [], maxAutoRetries: 3 });
    assert.equal(h.manager.get(d2.id)!.maxAutoRetries, 3);
    await h.manager.start(m.id);
    assert.throws(
      () => h.manager.updateContract(m.id, { goal: "g", acceptanceCriteria: ["a"], scope: "", constraints: [], maxAutoRetries: 1 }),
      /draft/,
      "运行中不能悄改契约",
    );
  });

  const retryHarness = async (opts?: { max?: number; backendRuns?: unknown[] }) => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [{ id: "t1", sessionId: "s1", status: "running" }]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = h.manager.create({
      roomId: h.room.roomId,
      goal: "g",
      acceptanceCriteria: ["a"],
      ...(opts?.max !== undefined ? { maxAutoRetries: opts.max } : {}),
    });
    await h.manager.start(m.id);
    const runs = opts?.backendRuns ?? [{ status: "failed", exitCode: 1 }];
    h.state.flow = flowView("f1", "awaiting-retry", [
      { id: "t1", sessionId: "s1", status: "failed", backendRuns: runs },
    ]);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    await new Promise((r) => setImmediate(r));
    return { h, m };
  };

  it("autoRetry：有真实失败证据才自动重试，限额与停止意图阻断", async () => {
    // 默认 0 → 不自动重试
    {
      const { h } = await retryHarness();
      assert.equal(h.retryCalls.length, 0);
    }
    // 无后端失败证据 → 只记录提示
    {
      const { h } = await retryHarness({ max: 2, backendRuns: [] });
      assert.equal(h.retryCalls.length, 0);
      const evs = h.manager.get(h.manager.list()[0]!.id)!.events;
      assert.ok(evs.some((e) => e.kind === "flow" && /evidence/i.test(e.text)));
    }
    // 有证据 → 自动 retry 一次，autoRetryCount+1
    {
      const { h, m } = await retryHarness({ max: 2 });
      h.setRetry(true);
      // syncFlow 已触发 maybeAutoRetry，但 retryResult 在调度前是 false → declined
      // 重新触发一次：再次 sync 同一 awaiting-retry（先改变 sig）
      h.state.flow = flowView("f1", "awaiting-retry", [
        { id: "t1", sessionId: "s1", status: "failed", backendRuns: [{ status: "failed", exitCode: 1 }] },
      ]);
      h.manager.syncFlow(h.room.roomId, h.state.flow);
      await new Promise((r) => setImmediate(r));
      const cur = h.manager.get(m.id)!;
      assert.equal(cur.autoRetryCount >= 1, true);
      assert.ok(h.retryCalls.length >= 1);
    }
    // stopRequested → 绝不自动重试
    {
      const h2 = makeHarness(undefined, "conductor");
      const m2 = h2.manager.create({ roomId: h2.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: 2 });
      await h2.manager.stop(m2.id);
      h2.state.flow = flowView("f9", "awaiting-retry", [{ id: "t1", status: "failed", backendRuns: [{ status: "failed", exitCode: 1 }] }]);
      h2.manager.syncFlow(h2.room.roomId, h2.state.flow);
      await new Promise((r) => setImmediate(r));
      assert.equal(h2.retryCalls.length, 0);
      assert.equal(h2.manager.get(m2.id)!.status, "stopped");
    }
  });

  it("autoRetry：恢复期间不自动派发", async () => {
    const { h, m } = await retryHarness({ max: 2 });
    h.setRetry(true);
    // 模拟恢复窗口：beginRestore 后 syncFlow 不得安排 auto retry
    const mgr2 = new MissionManager({
      store: h.store,
      getRoom: (id) => h.rooms.get(id),
      getFlow: () => h.state.flow,
      hasActiveFlow: () => h.state.activeFlow,
      isBusy: (sid) => h.busy.has(sid),
      isAvailable: () => true,
      dispatch: async () => ({ sent: [], mentioned: [], skipped: [] }),
      cancelActive: async () => {},
      cancel: async () => {},
      retryFailedTasks: (id, taskIds) => {
        h.retryCalls.push(taskIds === undefined ? { id } : { id, taskIds });
        return true;
      },
      supplementActive: () => false,
      broadcast: () => {},
    });
    const callsBefore = h.retryCalls.length;
    mgr2.beginRestore();
    mgr2.syncFlow(h.room.roomId, h.state.flow);
    mgr2.reconcile();
    await new Promise((r) => setImmediate(r));
    assert.equal(mgr2.get(m.id)!.status, "waiting-user", "匹配活跃 flow 恢复后保持原状态");
    assert.equal(h.retryCalls.length, callsBefore, "恢复期间绝不自动重试");
    assert.equal(
      mgr2.get(m.id)!.autoRetryCount,
      h.manager.get(m.id)!.autoRetryCount,
      "恢复不补发计数",
    );
  });

  it("manual retry：仅匹配 awaiting-retry 的失败子任务，declined 保持 waiting-user", async () => {
    const { h, m } = await retryHarness();
    h.setRetry(true);
    const cur = h.manager.retry(m.id);
    assert.equal(cur.status, "running");
    assert.equal(h.retryCalls.length, 1);
    assert.deepEqual(h.retryCalls[0]!.taskIds, ["t1"]);
    // declined → 保持 waiting-user 且记录原因
    const { h: h2, m: m2 } = await retryHarness();
    h2.setRetry(false);
    const cur2 = h2.manager.retry(m2.id);
    assert.equal(cur2.status, "waiting-user");
    assert.ok(cur2.events.some((e) => /declined/.test(e.text)));
    // 无匹配 awaiting-retry → 拒绝
    const h3 = makeHarness();
    const m3 = makeMission(h3);
    await h3.manager.start(m3.id);
    assert.throws(() => h3.manager.retry(m3.id), /awaiting-retry/);
  });

  it("dispatch 期间 stop 后 dispatch 抛错：保持 stopped 不转 failed", async () => {
    const h = makeHarness(undefined, "conductor");
    let rejectDispatch!: (e: Error) => void;
    h.setDispatch(() => new Promise<ModeResult>((_, rej) => (rejectDispatch = rej)));
    const m = makeMission(h);
    const started = h.manager.start(m.id);
    await new Promise((r) => setImmediate(r));
    await h.manager.stop(m.id);
    rejectDispatch(new Error("boom"));
    const cur = await started;
    assert.equal(cur.status, "stopped");
  });

  it("revision 单调递增：同毫秒两次 review 可累计且可 accept", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "done", [
        { id: "t1", sessionId: "s1", status: "done" },
      ]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    assert.equal(h.manager.get(m.id)!.status, "awaiting-acceptance");
    h.manager.review(m.id, { index: 0, verdict: "pass", taskIds: ["t1"], note: "核对单测" });
    h.manager.review(m.id, { index: 1, verdict: "pass", taskIds: [], note: "人工确认文档" });
    const mid = h.manager.get(m.id)!;
    assert.ok(mid.revision >= 3, `revision 应单调增长（got ${mid.revision}）`);
    const acc = h.manager.accept(m.id, "全部核对通过");
    assert.equal(acc.status, "accepted");
    assert.ok(acc.revision > mid.revision);
  });

  it("非法 maxAutoRetries 不会偷改 contract 其它字段", () => {
    const h = makeHarness();
    const m = makeMission(h);
    assert.throws(() =>
      h.manager.updateContract(m.id, {
        goal: "new goal", acceptanceCriteria: ["x"], scope: "newscope", constraints: ["c"],
        maxAutoRetries: 7,
      }),
    );
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.goal, "ship feature X", "goal 不得被非法请求偷改");
    assert.equal(cur.scope, "hub only");
    assert.equal(cur.maxAutoRetries, 0);
  });

  it("start 返回 done flow 含 failed 任务保持 failed 不被 finishNoFlow 覆盖", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "done", [
        { id: "t1", sessionId: "s1", status: "failed" },
      ]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = makeMission(h);
    await h.manager.start(m.id);
    assert.equal(h.manager.get(m.id)!.status, "failed");
  });

  it("autoRetry 回调中 retryFailedTasks 抛错不崩且交还用户", async () => {
    const h = makeHarness(undefined, "conductor");
    h.setDispatch(async () => {
      h.state.activeFlow = true;
      h.state.flow = flowView("f1", "working", [
        { id: "t1", sessionId: "s1", status: "running" },
      ]);
      return { sent: ["s1"], mentioned: [], skipped: [] };
    });
    const m = h.manager.create({ roomId: h.room.roomId, goal: "g", acceptanceCriteria: ["a"], maxAutoRetries: 2 });
    await h.manager.start(m.id);
    h.state.flow = flowView("f1", "awaiting-retry", [
      { id: "t1", sessionId: "s1", status: "failed", backendRuns: [{ status: "failed", exitCode: 1 }] },
    ]);
    h.setRetryThrows(true);
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const cur = h.manager.get(m.id)!;
    assert.equal(cur.status, "waiting-user", "throw 后交还用户");
    assert.equal(h.retryCalls.length, 1, "尝试过一次自动重试");
    assert.ok(cur.events.some((e) => e.kind === "error" && e.text.includes("auto retry")));
  });
});
