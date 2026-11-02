import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { Scheduler, parseSchedule, computeNextRun, type ScheduledTask } from "./scheduler.js";
import { EventWakeBook, parseEventTrigger } from "./mission-schedule.js";

function makeScheduler(trigger: (t: ScheduledTask) => Promise<void>): Scheduler {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-wake-")));
  return new Scheduler(store, () => {}, () => {}, trigger);
}

function baseTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "wake",
    targetType: "room",
    targetId: "r1",
    targetName: "room",
    message: "hi",
    schedule: { mode: "simple", kind: "event" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: Date.now(),
    ...over,
  };
}

test("parseEventTrigger：白名单校验、房作用域限定、数值字段边界", () => {
  assert.throws(() => parseEventTrigger({ events: ["prompt.done"] }, "session"), /room target/);
  assert.throws(() => parseEventTrigger({}, "room"), /events required/);
  assert.throws(() => parseEventTrigger({ events: ["hack"] }, "room"), /unknown wake event/);
  assert.throws(() => parseEventTrigger({ events: ["decision"], debounceMs: -1 }, "room"));
  assert.throws(() => parseEventTrigger({ events: ["decision"], maxPerHour: 0 }, "room"));
  const t = parseEventTrigger(
    { events: ["prompt.done", "decision", "decision"], debounceMs: 5000, maxPerHour: 3 },
    "room",
  );
  assert.deepEqual(t, { events: ["prompt.done", "decision"], debounceMs: 5000, maxPerHour: 3 });
});

test("parseSchedule/computeNextRun：kind=event 合法且永不定时触发", () => {
  const s = parseSchedule({ mode: "simple", kind: "event" });
  assert.deepEqual(s, { mode: "simple", kind: "event" });
  assert.equal(computeNextRun(baseTask()), null);
});

test("EventWakeBook：去抖窗口内只放行一次", () => {
  let now = 1000;
  const book = new EventWakeBook(() => now);
  assert.equal(book.admit("t1", 5000, 3), true);
  now += 1000;
  assert.equal(book.admit("t1", 5000, 3), false, "窗口内重复触发被拒");
  now += 5000;
  assert.equal(book.admit("t1", 5000, 3), true, "超过窗口放行");
});

test("EventWakeBook：小时上限拦截、跨小时窗口重置、任务间隔离", () => {
  let now = 0;
  const book = new EventWakeBook(() => now);
  for (let i = 0; i < 3; i++) {
    now += 31_000; // 跳过去抖窗
    assert.equal(book.admit("t1", 1000, 3), true);
  }
  now += 31_000;
  assert.equal(book.admit("t1", 1000, 3), false, "超过 maxPerHour 拦截");
  assert.equal(book.admit("t2", 1000, 3), true, "另一任务独立计数");
  now += 3_600_000;
  assert.equal(book.admit("t1", 1000, 3), true, "跨小时后额度重置");
});

test("Scheduler.fireEvent：复用触发管线写日志，不推进时间表游标", async () => {
  const ran: string[] = [];
  const scheduler = makeScheduler(async (t) => {
    ran.push(t.id);
  });
  const task = scheduler.create({
    name: "w", targetType: "room", targetId: "r1", targetName: "r",
    message: "m", schedule: { mode: "simple", kind: "event" }, enabled: true,
  });
  assert.equal(task.nextRunAt, null);
  await scheduler.fireEvent(task);
  assert.deepEqual(ran, [task.id]);
  const after = scheduler.list().find((t) => t.id === task.id)!;
  assert.equal(after.lastRunAt, null, "事件触发不推进时间表游标");
  assert.equal(after.nextRunAt, null);
  assert.equal(scheduler.listLogs(10).filter((l) => l.taskId === task.id).length, 1);
});

test("Scheduler.fireEvent：触发失败写入 error 日志并上抛", async () => {
  const scheduler = makeScheduler(async () => {
    throw new Error("boom");
  });
  const task = scheduler.create({
    name: "w", targetType: "room", targetId: "r1", targetName: "r",
    message: "m", schedule: { mode: "simple", kind: "event" }, enabled: true,
  });
  await assert.rejects(() => scheduler.fireEvent(task), /boom/);
  const log = scheduler.listLogs(10).find((l) => l.taskId === task.id);
  assert.equal(log?.success, false);
  assert.equal(log?.error, "boom");
});
