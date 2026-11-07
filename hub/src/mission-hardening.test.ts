import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionManager, MISSION_TRANSITIONS, type MissionDeps } from "./mission.js";
import { asFlowView, flowOwnerOf } from "./conductor.js";
import { RoomManager, type Room } from "./room.js";
import { Store, type HistoryEntry } from "./store.js";
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

function tmpStore(prefix = "mission-hard-"): { dir: string; store: Store } {
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
  deps: MissionDeps;
  manager: MissionManager;
  broadcasts: Broadcast[];
  busy: Set<string>;
  dispatched: { text: string; note?: string }[];
  state: { flow: Record<string, unknown> | undefined; activeFlow: boolean };
  retryCalls: { id: string; taskIds?: string[] }[];
  setRetry(v: boolean): void;
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
  const dispatched: { text: string; note?: string }[] = [];
  const retryCalls: { id: string; taskIds?: string[] }[] = [];
  let retryResult = false;
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
      const res = await dispatchImpl(r, text);
      if (options?.missionId && state.flow && state.flow.missionId === undefined) {
        state.flow = { ...state.flow, missionId: options.missionId };
      }
      return res;
    },
    cancelActive: async () => {},
    cancel: async (sid) => {
      busy.delete(sid);
    },
    retryFailedTasks: (id, taskIds) => {
      retryCalls.push(taskIds === undefined ? { id } : { id, taskIds });
      return retryResult;
    },
    supplementActive: () => true,
    broadcast: (method, params) => broadcasts.push({ method, params }),
  };
  return {
    dir,
    store,
    rooms,
    room,
    deps,
    manager: new MissionManager(deps),
    broadcasts,
    busy,
    dispatched,
    state,
    retryCalls,
    setRetry: (v: boolean) => {
      retryResult = v;
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

function flowView(flowId: string, phase: string, tasks: Record<string, unknown>[] = [], missionId?: string) {
  return { roomId: "x", flowId, phase, tasks, ...(missionId !== undefined ? { missionId } : {}) };
}

function startWithFlow(h: Harness, missionId: string) {
  h.setDispatch(async () => {
    h.state.activeFlow = true;
    h.state.flow = flowView("f1", "working", [{ id: "t1", sessionId: "s1", status: "running" }]);
    return { sent: ["s1"], mentioned: [], skipped: [] };
  });
  return h.manager.start(missionId);
}

function pushFlow(h: Harness, phase: string, tasks: Record<string, unknown>[] = []) {
  h.state.flow = flowView("f1", phase, tasks, undefined);
  h.manager.syncFlow(h.room.roomId, h.state.flow);
}

function driveToAcceptance(h: Harness, missionId: string) {
  h.state.activeFlow = false;
  pushFlow(h, "done", [{ id: "t1", status: "done", output: "shipped" }]);
  assert.equal(h.manager.get(missionId)?.status, "awaiting-acceptance");
}

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

describe("迁移表合法边（现状钉住，重构不得回归）", () => {
  it("draft→running / draft→stopped", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    assert.equal(h.manager.get(m.id)?.status, "running");

    const m2 = makeMission(h);
    await h.manager.stop(m2.id);
    assert.equal(h.manager.get(m2.id)?.status, "stopped");
  });

  it("running→waiting-user→running（flow phase 往返）", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    pushFlow(h, "awaiting-input");
    assert.equal(h.manager.get(m.id)?.status, "waiting-user");
    pushFlow(h, "working", [{ id: "t1", status: "running" }]);
    assert.equal(h.manager.get(m.id)?.status, "running");
  });

  it("running→awaiting-acceptance→accepted；running→failed", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    driveToAcceptance(h, m.id);
    h.manager.review(m.id, { index: 0, verdict: "pass", note: "ok" });
    h.manager.review(m.id, { index: 1, verdict: "pass", note: "ok" });
    h.manager.accept(m.id);
    assert.equal(h.manager.get(m.id)?.status, "accepted");

    const h2 = makeHarness(undefined, "conductor");
    const m2 = makeMission(h2);
    await startWithFlow(h2, m2.id);
    h2.state.activeFlow = false;
    pushFlow(h2, "done", [{ id: "t1", status: "failed", failureMessage: "boom" }]);
    assert.equal(h2.manager.get(m2.id)?.status, "failed");
  });

  it("running→stopped（cancelled/stop）；waiting-user→stopped", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    pushFlow(h, "cancelled");
    assert.equal(h.manager.get(m.id)?.status, "stopped");

    const h2 = makeHarness(undefined, "conductor");
    const m2 = makeMission(h2);
    await startWithFlow(h2, m2.id);
    pushFlow(h2, "awaiting-input");
    assert.equal(h2.manager.get(m2.id)?.status, "waiting-user");
    await h2.manager.stop(m2.id);
    assert.equal(h2.manager.get(m2.id)?.status, "stopped");
  });

  it("waiting-user→awaiting-acceptance / waiting-user→failed / awaiting-acceptance→stopped", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    pushFlow(h, "awaiting-input");
    h.state.activeFlow = false;
    pushFlow(h, "done", [{ id: "t1", status: "done", output: "ok" }]);
    assert.equal(h.manager.get(m.id)?.status, "awaiting-acceptance");
    await h.manager.stop(m.id);
    assert.equal(h.manager.get(m.id)?.status, "stopped");

    const h2 = makeHarness(undefined, "conductor");
    const m2 = makeMission(h2);
    await startWithFlow(h2, m2.id);
    pushFlow(h2, "awaiting-input");
    h2.state.activeFlow = false;
    pushFlow(h2, "done", [{ id: "t1", status: "failed", failureMessage: "x" }]);
    assert.equal(h2.manager.get(m2.id)?.status, "failed");
  });
});

describe("TDD-red：applyFlowPhase 白名单守卫", () => {
  it("未识别 phase 不得把 waiting-user 拉回 running", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    pushFlow(h, "awaiting-input");
    assert.equal(h.manager.get(m.id)?.status, "waiting-user");
    pushFlow(h, "paused");
    assert.equal(h.manager.get(m.id)?.status, "waiting-user", "未知 phase 应按白名单忽略而非落入 else→running");
  });
});

describe("TDD-red：history mission_id 归因可区分", () => {
  it("append 携带 missionId 的条目读写往返不丢字段", () => {
    const { store } = tmpStore();
    store.append("room", "r1", {
      at: 1,
      kind: "user",
      author: "我",
      text: "mission goal",
      missionId: "m_attr",
    } as HistoryEntry);
    const rows = store.read("room", "r1");
    assert.equal((rows[0] as { missionId?: string } | undefined)?.missionId, "m_attr");
  });

  it("mission 派发条目与真人输入可区分", () => {
    const { store } = tmpStore();
    store.append("room", "r1", {
      at: 1,
      kind: "user",
      author: "我",
      text: "human input",
      clientMessageId: "cm-1",
    });
    store.append("room", "r1", {
      at: 2,
      kind: "user",
      author: "我",
      text: "mission goal",
      missionId: "m_attr",
    } as HistoryEntry);
    const rows = store.read("room", "r1") as (HistoryEntry & { id: number; missionId?: string })[];
    const human = rows.find((r) => r.text === "human input");
    const mission = rows.find((r) => r.text === "mission goal");
    assert.equal(mission?.missionId, "m_attr");
    assert.equal(human?.missionId, undefined);
    assert.equal(human?.clientMessageId, "cm-1");
  });
});

describe("TDD-red：结构化 reasonCode", () => {
  it("进入 waiting-user/failed 的快照携带 kebab-case reasonCode，回 running 清除", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    pushFlow(h, "awaiting-input");
    const waiting = h.manager.get(m.id) as { status: string; reasonCode?: unknown } | undefined;
    assert.equal(waiting?.status, "waiting-user");
    assert.equal(typeof waiting?.reasonCode, "string");
    assert.match(String(waiting?.reasonCode), KEBAB);

    pushFlow(h, "working", [{ id: "t1", status: "running" }]);
    const resumed = h.manager.get(m.id) as { status: string; reasonCode?: unknown } | undefined;
    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.reasonCode, undefined);

    h.state.activeFlow = false;
    pushFlow(h, "done", [{ id: "t1", status: "failed", failureMessage: "boom" }]);
    const failed = h.manager.get(m.id) as { status: string; reasonCode?: unknown } | undefined;
    assert.equal(failed?.status, "failed");
    assert.equal(typeof failed?.reasonCode, "string");
    assert.match(String(failed?.reasonCode), KEBAB);
  });
});

describe("TDD-red：missions.v1 两级 quarantine", () => {
  it("整 blob 损坏：不抛错、坏数据隔离、空集启动", () => {
    const h = makeHarness();
    h.store.setMeta("missions.v1", "not-json{{{");
    assert.doesNotThrow(() => new MissionManager(h.deps));
    const m2 = new MissionManager(h.deps);
    assert.equal(m2.list(h.room.roomId).length, 0);
    assert.equal(h.store.getMeta("missions.v1.corrupt"), "not-json{{{");
  });

  it("单记录损坏：有效记录存活，坏记录隔离", () => {
    const h = makeHarness();
    const m = makeMission(h);
    const raw = JSON.parse(h.store.getMeta("missions.v1")!) as unknown[];
    raw.push(42);
    h.store.setMeta("missions.v1", JSON.stringify(raw));
    const m2 = new MissionManager(h.deps);
    assert.equal(m2.list(h.room.roomId).length, 1);
    assert.equal(m2.list(h.room.roomId)[0]?.id, m.id);
    assert.ok(String(h.store.getMeta("missions.v1.corrupt") ?? "").includes("42"));
  });
});

describe("TDD-red：派发窗口簿记不落盘", () => {
  it("persisted record 不含 sent/pending/dispatching 等 in-flight 字段", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    const raw = JSON.parse(h.store.getMeta("missions.v1")!) as Record<string, unknown>[];
    const rec = raw.find((r) => r.id === m.id);
    assert.ok(rec, "persisted record missing");
    for (const key of [
      "sent",
      "pending",
      "earlyDone",
      "turnErrors",
      "dispatching",
      "stopRequested",
      "baselineFlowId",
      "lastPhase",
      "lastFlowSig",
    ]) {
      assert.equal(key in rec!, false, `persisted record 不应含 ${key}`);
    }
  });
});

describe("统一状态迁移表", () => {
  it("合法边集合与设计一致，非法边缺席", () => {
    const legal = (from: string, to: string) =>
      (MISSION_TRANSITIONS as Record<string, ReadonlySet<string>>)[from]?.has(to) === true;
    // 15 条合法边
    const legalEdges: [string, string][] = [
      ["draft", "running"], ["draft", "stopped"],
      ["running", "waiting-user"], ["running", "awaiting-acceptance"], ["running", "stopped"], ["running", "failed"],
      ["waiting-user", "running"], ["waiting-user", "awaiting-acceptance"], ["waiting-user", "stopped"], ["waiting-user", "failed"],
      ["awaiting-acceptance", "accepted"], ["awaiting-acceptance", "stopped"],
    ];
    for (const [f, t] of legalEdges) assert.ok(legal(f, t), `${f}→${t} 应为合法边`);
    // 非法边：终态出边、跳级、回退
    const illegalEdges: [string, string][] = [
      ["draft", "accepted"], ["draft", "awaiting-acceptance"], ["draft", "failed"],
      ["awaiting-acceptance", "running"], ["awaiting-acceptance", "failed"],
      ["accepted", "running"], ["accepted", "stopped"], ["accepted", "failed"],
      ["stopped", "running"], ["stopped", "failed"],
      ["failed", "running"], ["failed", "stopped"], ["failed", "awaiting-acceptance"],
    ];
    for (const [f, t] of illegalEdges) assert.ok(!legal(f, t), `${f}→${t} 不得为合法边`);
  });
});

describe("FlowView 窄化与归属谓词", () => {
  it("asFlowView：tasks 非数组归一为空数组，其余字段透传", () => {
    const v = asFlowView({ flowId: "f1", phase: "working", tasks: "bogus" });
    assert.deepEqual(v?.tasks, []);
    assert.equal(v?.phase, "working");
    const v2 = asFlowView({ flowId: "f1", phase: "working", tasks: [{ id: "t1", status: "running" }] });
    assert.equal(v2?.tasks.length, 1);
    assert.equal(asFlowView(undefined), undefined);
  });

  it("asFlowView 标量防御：非 string 契约字段归一 undefined，良构快照零拷贝", () => {
    const dirty = asFlowView({ flowId: 123, phase: 42, waitingFor: {}, failureMessage: null, tasks: [{ id: "t1" }] });
    assert.equal(dirty?.flowId, undefined);
    assert.equal(dirty?.phase, undefined);
    assert.equal(dirty?.waitingFor, undefined);
    assert.equal(dirty?.failureMessage, undefined);
    assert.equal(dirty?.tasks.length, 1);
    // 良构快照：tasks 数组引用不变（零拷贝路径）
    const tasks = [{ id: "t1", status: "running" }];
    const v2 = asFlowView({ flowId: "f1", phase: "working", tasks });
    assert.ok(v2);
    assert.equal(v2.tasks, tasks as unknown as typeof v2.tasks);
    assert.equal(v2.flowId, "f1");
  });

  it("start 经统一迁移表：单条 started 生命周期事件", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    const snap = await startWithFlow(h, m.id);
    assert.equal(snap.status, "running");
    const started = snap.events.filter((e) => e.kind === "lifecycle" && e.text === "started");
    assert.equal(started.length, 1, "draft→running 走 transition 只记一次 started");
  });

  it("flowOwnerOf：非空 missionId 才认归属", () => {
    assert.equal(flowOwnerOf({ missionId: "m1" }), "m1");
    assert.equal(flowOwnerOf({ missionId: "" }), undefined);
    assert.equal(flowOwnerOf({}), undefined);
    assert.equal(flowOwnerOf(undefined), undefined);
  });

  it("flowSig 噪声免疫：无关字段变化不再 bump revision", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    const rev1 = h.manager.get(m.id)!.revision;
    // 仅 flow 级无关字段（goal/rounds/results）变化，phase/tasks/missionId 同 → 不产生新 commit
    h.state.flow = { ...flowView("f1", "working", [{ id: "t1", sessionId: "s1", status: "running" }], m.id), goal: "changed", rounds: 99, results: { x: 1 } };
    h.manager.syncFlow(h.room.roomId, h.state.flow);
    assert.equal(h.manager.get(m.id)!.revision, rev1, "无关字段 churn 不应触发 commit");
  });
});

describe("history.search missionId 过滤", () => {
  it("missionId 过滤只命中带标条目", () => {
    const { store } = tmpStore();
    store.append("room", "r1", { at: 1, kind: "user", author: "我", text: "工单派发", missionId: "m1" });
    store.append("room", "r1", { at: 2, kind: "user", author: "我", text: "普通输入" });
    store.append("room", "r1", { at: 3, kind: "user", author: "我", text: "另一工单", missionId: "m2" });
    const rows = store.searchHistory("room", "r1", { missionId: "m1" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.text, "工单派发");
  });
});

describe("awaiting-acceptance 不占房", () => {
  it("AA 状态下同房间可开新工单", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    driveToAcceptance(h, m.id);
    assert.equal(h.manager.get(m.id)?.status, "awaiting-acceptance");
    const m2 = makeMission(h, { goal: "second" });
    const snap = await startWithFlow(h, m2.id);
    assert.equal(snap.status, "running");
  });
});

describe("m.output 单写者", () => {
  it("回合输出走 events(kind=output)，output 仅终态 summarizeFlow", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    h.manager.onTurnDone("s1", h.room.roomId, "mid-run result");
    const cur = h.manager.get(m.id)!;
    assert.ok(cur.events.some((e) => e.kind === "output" && e.text.includes("mid-run")));
    // flow 未 done 时 output 不被片段写入
    assert.equal(cur.output?.includes("mid-run") ?? false, false);
    pushFlow(h, "done", [{ id: "t1", name: "coder", status: "done", output: "shipped" }]);
    const done = h.manager.get(m.id)!;
    assert.ok(done.output?.includes("shipped"), "done 后 output 由 summarizeFlow 写入任务摘要");
  });
});

describe("history clientMessageId NULL 归一", () => {
  it("无 clientMessageId 的条目读回为 undefined 而非 null", () => {
    const { store } = tmpStore();
    store.append("room", "r1", { at: 1, kind: "user", author: "我", text: "hi" });
    const rows = store.read("room", "r1");
    assert.equal(rows[0]?.clientMessageId, undefined);
  });
});

describe("stopped 五路径 reasonCode（设计 9 码表）", () => {
  const reasonOf = (h: Harness, id: string) =>
    (h.manager.get(id) as { reasonCode?: string } | undefined)?.reasonCode;

  it("user-stopped / flow-cancelled / flow-lost", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    await h.manager.stop(m.id, "不用了");
    assert.equal(reasonOf(h, m.id), "user-stopped");

    const h2 = makeHarness(undefined, "conductor");
    const m2 = makeMission(h2);
    await startWithFlow(h2, m2.id);
    pushFlow(h2, "cancelled");
    assert.equal(reasonOf(h2, m2.id), "flow-cancelled");

    const h3 = makeHarness(undefined, "conductor");
    const m3 = makeMission(h3);
    await startWithFlow(h3, m3.id);
    h3.state.flow = undefined;
    h3.manager.syncFlow(h3.room.roomId, undefined);
    assert.equal(h3.manager.get(m3.id)?.status, "stopped");
    assert.equal(reasonOf(h3, m3.id), "flow-lost");
  });

  it("interrupted-restart：reconcile 丢失匹配 flow", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    const r = new MissionManager({
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
    r.reconcile();
    const rec = r.get(m.id) as { status: string; reasonCode?: string } | undefined;
    assert.equal(rec?.status, "stopped");
    assert.equal(rec?.reasonCode, "interrupted-restart");
  });

  it("closed-for-rework：母单随 rework 关闭", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    driveToAcceptance(h, m.id);
    const child = h.manager.rework(m.id, "验收不通过");
    assert.equal(reasonOf(h, m.id), "closed-for-rework");
    assert.equal(h.manager.get(m.id)?.status, "stopped");
    assert.equal(child.parentMissionId, m.id);
  });
});

describe("TDD-red：accept() 固化 finishedAt", () => {
  it("finishedAt 取验收时刻而非 flow done 时刻", async () => {
    const h = makeHarness(undefined, "conductor");
    const m = makeMission(h);
    await startWithFlow(h, m.id);
    driveToAcceptance(h, m.id);
    const flowDoneAt = h.manager.get(m.id)?.finishedAt;
    assert.ok(typeof flowDoneAt === "number");
    await new Promise((r) => setTimeout(r, 10));
    h.manager.review(m.id, { index: 0, verdict: "pass", note: "ok" });
    h.manager.review(m.id, { index: 1, verdict: "pass", note: "ok" });
    const snap = h.manager.accept(m.id);
    assert.ok(snap.finishedAt !== undefined && snap.finishedAt >= snap.acceptance!.at);
    assert.ok(snap.finishedAt! > flowDoneAt!, "accept 应把 finishedAt 推进到验收时刻");
  });
});
