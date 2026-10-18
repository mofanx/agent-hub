import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionManager, type MissionSnapshot } from "./mission.js";
import { missionTemplateFrom, runMissionTask, type MissionTaskDeps } from "./mission-schedule.js";
import { RoomManager } from "./room.js";
import { Store } from "./store.js";
import type { ScheduledTask } from "./scheduler.js";

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

function makeMissionHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-sched-"));
  const store = new Store(dir);
  cleanupDirs.push(dir);
  cleanupStores.push(store);
  const rooms = new RoomManager();
  const room = rooms.create("t", [{ sessionId: "s1", name: "lead" }], "mention", {});
  const busy = new Set<string>();
  const available = new Set<string>(["s1"]);
  const state = { flow: undefined as Record<string, unknown> | undefined, activeFlow: false };
  const manager = new MissionManager({
    store,
    getRoom: (id) => rooms.get(id),
    getFlow: () => state.flow,
    hasActiveFlow: () => state.activeFlow,
    isBusy: (sid) => busy.has(sid),
    isAvailable: () => true,
    dispatch: async () => ({ sent: ["s1"], mentioned: [], skipped: [] }),
    cancelActive: async () => {},
    cancel: async () => {},
    retryFailedTasks: () => false,
    supplementActive: () => false,
    broadcast: () => {},
  });
  const deps: MissionTaskDeps = {
    getRoom: (id) => rooms.get(id),
    hasActiveFlow: (id) => state.activeFlow,
    isMemberBusy: (sid) => busy.has(sid),
    isAvailable: (sid) => available.has(sid),
    activeMissions: (id) => manager.list(id),
    createMission: (input) => manager.create(input),
    startMission: (id) => manager.start(id),
  };
  const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
    id: "task-1",
    name: "巡检",
    targetType: "room",
    targetId: room.roomId,
    targetName: "t",
    message: "m",
    schedule: { mode: "simple", kind: "daily", time: "09:00" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: Date.now(),
    ...over,
  });
  const mission = (): MissionSnapshot =>
    manager.create({
      roomId: room.roomId,
      goal: "ship X",
      acceptanceCriteria: ["ok"],
      scope: "s",
      constraints: ["no net"],
      ownerSessionId: "s1",
      maxAutoRetries: 2,
    });
  return { room, busy, available, state, manager, deps, task, mission };
}

describe("mission schedule", () => {
  it("模板冻结契约快照，不随 draft 变更；非 room/房间不匹配拒绝", () => {
    const h = makeMissionHarness();
    const m = h.mission();
    const tpl = missionTemplateFrom(m, "room", h.room.roomId);
    assert.equal(tpl.sourceMissionId, m.id);
    assert.equal(tpl.maxAutoRetries, 2);
    h.manager.updateContract(m.id, {
      goal: "changed", acceptanceCriteria: ["ok"], scope: "", constraints: [],
    });
    assert.equal(tpl.goal, "ship X", "冻结契约不随原 draft 改变");
    assert.throws(() => missionTemplateFrom(m, "session", h.room.roomId), /room target/);
    assert.throws(() => missionTemplateFrom(m, "room", "other"), /does not match/);
  });

  it("默认触发只生成待确认 draft；显式 autoStart 才启动", async () => {
    const h = makeMissionHarness();
    const tpl = missionTemplateFrom(h.mission(), "room", h.room.roomId);
    const r1 = await runMissionTask(h.task({ missionTemplate: tpl }), h.deps);
    assert.equal(r1, "draft");
    const drafts = h.manager.list().filter((x) => x.status === "draft" && x.id !== tpl.sourceMissionId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]!.parentMissionId, undefined);
    const h2 = makeMissionHarness();
    const tpl2 = missionTemplateFrom(h2.mission(), "room", h2.room.roomId);
    const r2 = await runMissionTask(h2.task({ missionTemplate: tpl2, missionAutoStart: true }), h2.deps);
    assert.equal(r2, "started");
    const started = h2.manager.list().find((x) => x.status === "running");
    assert.ok(started);
  });

  it("房间被占用/flow/成员忙时跳过不堆 draft", async () => {
    const h = makeMissionHarness();
    const tpl = missionTemplateFrom(h.mission(), "room", h.room.roomId);
    h.busy.add("s1");
    await assert.rejects(() => runMissionTask(h.task({ missionTemplate: tpl }), h.deps), /occupied/);
    h.busy.delete("s1");
    h.state.activeFlow = true;
    await assert.rejects(() => runMissionTask(h.task({ missionTemplate: tpl }), h.deps), /occupied/);
    h.state.activeFlow = false;
    const h2 = makeMissionHarness();
    const tpl2 = missionTemplateFrom(h2.mission(), "room", h2.room.roomId);
    await h2.manager.start(h2.manager.list()[0]!.id);
    await assert.rejects(() => runMissionTask(h2.task({ missionTemplate: tpl2 }), h2.deps), /occupied/);
    assert.equal(h2.manager.list().filter((x) => x.status === "draft").length, 0, "不反复堆新 draft");
  });

  it("无模板任务完全不受影响", async () => {
    const h = makeMissionHarness();
    await assert.rejects(() => runMissionTask(h.task({}), h.deps), /not a mission task/);
    const unknown = h.task({ missionTemplate: missionTemplateFrom(h.mission(), "room", h.room.roomId) });
    unknown.missionTemplate!.roomId = "ghost";
    unknown.targetId = "ghost";
    await assert.rejects(() => runMissionTask(unknown, h.deps), /unknown room/);
  });

  it("模板目标错配拒绝执行", async () => {
    const h = makeMissionHarness();
    const tpl = missionTemplateFrom(h.mission(), "room", h.room.roomId);
    await assert.rejects(
      () => runMissionTask(h.task({ missionTemplate: tpl, targetId: "other-room" }), h.deps),
      /target mismatch/,
    );
    await assert.rejects(
      () => runMissionTask(h.task({ missionTemplate: tpl, targetType: "session" }), h.deps),
      /target mismatch/,
    );
  });

  it("autoStart 时成员不可用先于建草稿跳过", async () => {
    const h = makeMissionHarness();
    h.available.delete("s1");
    const tpl = missionTemplateFrom(h.mission(), "room", h.room.roomId);
    const before = h.manager.list(h.room.roomId).length;
    await assert.rejects(
      () => runMissionTask(h.task({ missionTemplate: tpl, missionAutoStart: true }), h.deps),
      /unavailable/,
    );
    assert.equal(h.manager.list(h.room.roomId).length, before, "不得产生新 draft");
  });
});
