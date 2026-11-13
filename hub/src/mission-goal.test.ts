import { test } from "node:test";
import assert from "node:assert/strict";
import { MissionManager, type MissionDeps } from "./mission.js";
import type { GoalAction, GoalSnapshot } from "./native-goal.js";

function fixture(options: { supported?: boolean; actions?: GoalAction[]; meta?: Map<string, string>; members?: number } = {}) {
  const meta = options.meta ?? new Map<string, string>();
  const state: { goal: GoalSnapshot | null | undefined; busy: boolean; owner?: string; fail?: string } = { goal: null, busy: false };
  const controls: { action: GoalAction; objective?: string }[] = [];
  const prompts: string[] = [];
  const actions = options.actions ?? ["set", "pause", "resume", "clear"];
  const deps = {
    store: { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => meta.set(k, v) },
    getRoom: () => ({ roomId: "r1", mode: "mention", members: Array.from({ length: options.members ?? 1 }, (_, i) => ({ sessionId: `s${i + 1}`, name: `w${i}` })) }),
    getFlow: () => undefined, hasActiveFlow: () => false,
    isBusy: () => state.busy, isAvailable: () => true,
    dispatch: async (_r: unknown, text: string) => { prompts.push(text); return { sent: ["s1"], skipped: [], mentioned: [] }; },
    cancelActive: async () => {}, cancel: async () => { state.busy = false; },
    retryFailedTasks: () => false, supplementActive: () => false, broadcast: () => {},
    goalInfo: () => options.supported === false ? undefined : {
      capabilities: { version: 1, controlMethod: "_session/goal", actions }, goal: state.goal,
    },
    bindNativeGoal: (_sid: string, id: string) => { state.owner = id; },
    nativeGoalOwner: () => state.owner,
    releaseNativeGoal: () => { delete state.owner; },
    controlNativeGoal: async (_sid: string, action: GoalAction, objective?: string) => {
      controls.push({ action, ...(objective ? { objective } : {}) });
      if (state.fail) throw new Error(state.fail);
      if (action === "set") state.goal = { objective: objective!, status: "active" };
      else if (action === "clear") state.goal = null;
      else state.goal = { ...state.goal!, status: action === "pause" ? "paused" : "active" };
    },
  } as unknown as MissionDeps;
  const manager = new MissionManager(deps);
  const create = () => manager.create({ roomId: "r1", goal: "deliver", acceptanceCriteria: ["tests pass"], constraints: ["no push"], scope: "hub only" });
  return { manager, create, state, controls, prompts, meta };
}

test("native mission: 单后端优先原生 Goal，目标带完整批准契约，不另发 prompt", async () => {
  const f = fixture();
  const m = f.create();
  const started = await f.manager.start(m.id);
  assert.equal(started.execution?.mode, "native-goal");
  assert.equal(f.prompts.length, 0);
  assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0]?.action, "set");
  for (const text of [m.id, "deliver", "tests pass", "no push", "hub only"]) assert.ok(f.controls[0]?.objective?.includes(text));
});

test("native mission: 不支持时明确记录 prompt 降级；多成员保留 Hub 编排", async () => {
  for (const options of [{ supported: false }, { members: 2 }]) {
    const f = fixture(options);
    const started = await f.manager.start(f.create().id);
    assert.notEqual(started.execution?.mode, "native-goal");
    assert.ok(started.execution?.reason);
    assert.equal(f.controls.length, 0);
    assert.equal(f.prompts.length, 1);
  }
});

test("native mission: prompt 完成不等于 Goal 完成，最终只进入人工待验收", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.manager.onTurnDone("s1", undefined, "partial");
  assert.equal(f.manager.get(m.id)?.status, "running");
  f.state.goal = { ...f.state.goal!, status: "complete" };
  f.manager.onNativeGoal("s1", f.state.goal);
  assert.equal(f.manager.get(m.id)?.status, "awaiting-acceptance");
  assert.throws(() => f.manager.accept(m.id), /manually passed/);
});

test("native mission: Goal complete 在途时等输出收尾，重复快照幂等", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.busy = true;
  f.state.goal = { ...f.state.goal!, status: "complete" };
  f.manager.onNativeGoal("s1", f.state.goal);
  assert.equal(f.manager.get(m.id)?.status, "running");
  f.state.busy = false;
  f.manager.onTurnDone("s1", undefined, "final");
  assert.equal(f.manager.get(m.id)?.status, "awaiting-acceptance");
  const revision = f.manager.get(m.id)?.revision;
  f.manager.onNativeGoal("s1", f.state.goal);
  assert.equal(f.manager.get(m.id)?.revision, revision);
});

test("native mission: 暂停/限额交还用户，恢复只调用原生动作", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  await f.manager.goalControl(m.id, "pause");
  assert.equal(f.manager.get(m.id)?.status, "waiting-user");
  await f.manager.goalControl(m.id, "resume");
  assert.equal(f.manager.get(m.id)?.status, "running");
  f.state.goal = { ...f.state.goal!, status: "limited", tokenBudget: 100, tokensUsed: 100 };
  f.manager.onNativeGoal("s1", f.state.goal);
  assert.equal(f.manager.get(m.id)?.reasonCode, "native-goal-limited");
  assert.equal(f.prompts.length, 0);
});

test("native mission: 空闲期停止也清除目标，不靠 busy 判定", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  await f.manager.stop(m.id);
  assert.equal(f.controls.at(-1)?.action, "clear");
  assert.equal(f.manager.get(m.id)?.status, "stopped");
  assert.equal(f.manager.get(m.id)?.execution?.stopConfirmed, true);
});

test("native mission: 清除失败如实保留未确认状态，不谎称已停止后端", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.fail = "transport unavailable";
  const stopped = await f.manager.stop(m.id);
  assert.equal(stopped.execution?.stopConfirmed, false);
  assert.match(stopped.error ?? "", /transport unavailable/);
});

test("native mission: 不覆盖已有目标，不在状态未知时猜测为空", async () => {
  for (const goal of [undefined, { objective: "foreign", status: "active" as const }]) {
    const f = fixture();
    f.state.goal = goal;
    const m = f.create();
    await assert.rejects(() => f.manager.start(m.id), /goal.*synchron|goal.*exist/);
    assert.equal(f.controls.length, 0);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.manager.get(m.id)?.status, "draft");
  }
});

test("native mission: Claude 不支持暂停时拒绝，不转成提示词模拟", async () => {
  const f = fixture({ actions: ["set", "clear"] });
  const m = await f.manager.start(f.create().id);
  await assert.rejects(() => f.manager.goalControl(m.id, "pause"), /unsupported/);
  assert.equal(f.controls.length, 1);
  assert.equal(f.prompts.length, 0);
});

test("native mission: 重启后只读重关联，不发送 set/resume/prompt", async () => {
  const first = fixture();
  const m = await first.manager.start(first.create().id);
  const restored = fixture({ meta: first.meta });
  restored.state.goal = first.state.goal;
  restored.manager.beginRestore();
  restored.manager.reconcile();
  assert.equal(restored.manager.get(m.id)?.execution?.id, m.execution?.id);
  assert.notEqual(restored.manager.get(m.id)?.status, "stopped");
  assert.equal(restored.controls.length, 0);
  assert.equal(restored.prompts.length, 0);
});

test("native mission: 验收后释放消息归属，不截走下一次普通群聊", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.goal = { ...f.state.goal!, status: "complete" };
  f.manager.onNativeGoal("s1", f.state.goal);
  f.manager.review(m.id, { index: 0, verdict: "pass", note: "verified" });
  f.manager.accept(m.id);
  assert.equal(f.state.owner, undefined);
  assert.equal(f.manager.nativeMissionForSession("s1"), undefined);
});

test("native mission: 已验收目标重启后可安全接替，不删除陌生目标", async () => {
  const first = fixture();
  const m = await first.manager.start(first.create().id);
  first.state.goal = { ...first.state.goal!, status: "complete" };
  first.manager.onNativeGoal("s1", first.state.goal);
  first.manager.review(m.id, { index: 0, verdict: "pass", note: "verified" });
  first.manager.accept(m.id);
  const f = fixture({ meta: first.meta });
  f.state.goal = first.state.goal;
  const next = await f.manager.start(f.create().id);
  assert.equal(next.status, "running");
  assert.deepEqual(f.controls.map((c) => c.action), ["clear", "set"]);
});

test("native mission: 补充明确区分已记录、已排队和已注入，重启保留", async () => {
  for (const delivery of ["recorded", "queued", "delivered"] as const) {
    const f = fixture();
    (f.manager as any).deps.supplementNativeGoal = async () => delivery;
    const m = await f.manager.start(f.create().id);
    const updated = await f.manager.supplement(m.id, "new constraint");
    assert.equal(updated.supplements[0]?.delivery, delivery);
    assert.equal(updated.supplements[0]?.delivered, delivery === "delivered");
    assert.equal(fixture({ meta: f.meta }).manager.get(m.id)?.supplements[0]?.delivery, delivery);
  }
});

test("native mission: 待验收后返工可替换自己已完成的目标", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.goal = { ...f.state.goal!, status: "complete" };
  f.manager.onNativeGoal("s1", f.state.goal);
  const draft = f.manager.rework(m.id, "review requested changes");
  assert.equal((await f.manager.start(draft.id)).status, "running");
  assert.deepEqual(f.controls.map((c) => c.action), ["set", "clear", "set"]);
});

test("native mission: 后端停止未确认时不能删除唯一的持久停止意图", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.fail = "offline";
  await f.manager.stop(m.id);
  await assert.rejects(() => f.manager.delete(m.id, true), /not confirmed/);
  assert.ok(f.manager.get(m.id));
  assert.equal(f.manager.reservesSession("s1"), true);
});

test("native mission: 删除房间也保留未确认的原生停止意图", async () => {
  const f = fixture();
  const m = await f.manager.start(f.create().id);
  f.state.fail = "offline";
  await f.manager.onRoomRemoved("r1");
  assert.equal(f.manager.get(m.id)?.status, "stopped");
  assert.equal(f.manager.get(m.id)?.execution?.stopConfirmed, false);
});

test("native mission: 重启后重发已授权停止，不重启目标", async () => {
  const first = fixture();
  const m = await first.manager.start(first.create().id);
  first.state.fail = "offline";
  await first.manager.stop(m.id);
  const f = fixture({ meta: first.meta });
  f.state.goal = first.state.goal;
  f.manager.beginRestore();
  f.manager.reconcile();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.controls.map((c) => c.action), ["clear"]);
  assert.equal(f.manager.get(m.id)?.execution?.stopConfirmed, true);
});

test("native mission: 停止确认也持久化，待验收时一次停止即可清除目标", async () => {
  for (const complete of [false, true]) {
    const f = fixture();
    const m = await f.manager.start(f.create().id);
    if (complete) {
      f.state.goal = { ...f.state.goal!, status: "complete" };
      f.manager.onNativeGoal("s1", f.state.goal);
    }
    await f.manager.stop(m.id);
    assert.equal(f.controls.at(-1)?.action, "clear");
    assert.equal(fixture({ meta: f.meta }).manager.get(m.id)?.execution?.stopConfirmed, true);
  }
});
