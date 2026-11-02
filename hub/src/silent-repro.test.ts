import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { Scheduler, type ScheduledTask } from "./scheduler.js";
import {
  parseEventTrigger,
  SilentReproBook,
  SILENT_REPRO_KEYWORDS,
  SILENT_REPRO_DEFAULTS,
  buildSilentReproPrompt,
} from "./mission-schedule.js";
import { wakeGateAllows, parseWakeFilter } from "./wake-gate.js";

function makeScheduler(trigger: (t: ScheduledTask) => Promise<void>): Scheduler {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-sr-")));
  return new Scheduler(store, () => {}, () => {}, trigger);
}

function baseTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "silent",
    targetType: "room",
    targetId: "r1",
    targetName: "room",
    message: "复现并修复用户报告的问题",
    schedule: { mode: "simple", kind: "event" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: Date.now(),
    ...over,
  };
}

test("wakeGateAllows.contains：关键词 OR 匹配、大小写不敏感、与 fields 为 AND", () => {
  const f = { contains: ["bug", "崩溃"] };
  assert.equal(wakeGateAllows(f, { text: "这里有个 Bug" }), true);
  assert.equal(wakeGateAllows(f, { text: "应用崩溃了" }), true);
  assert.equal(wakeGateAllows(f, { text: "你好呀" }), false);
  assert.equal(wakeGateAllows(f, { text: "" }), false);
  // 无 text 字段时 contains 必拦
  assert.equal(wakeGateAllows(f, {}), false);
  // fields 命中但 contains 未命中 → AND 语义拦截
  assert.equal(
    wakeGateAllows({ fields: { kind: "room.message" }, contains: ["bug"] }, { kind: "room.message", text: "闲聊" }),
    false,
  );
  // 未配置 contains → 不因缺少 text 拦截
  assert.equal(wakeGateAllows({ fields: { kind: "decision" } }, { kind: "decision" }), true);
});

test("parseWakeFilter.contains：校验非空字符串数组", () => {
  assert.throws(() => parseWakeFilter({ contains: [] }), /contains/);
  assert.throws(() => parseWakeFilter({ contains: [""] }), /contains/);
  assert.throws(() => parseWakeFilter({ contains: ["ok", 1] }), /contains/);
  assert.throws(() => parseWakeFilter({ contains: "bug" }), /contains/);
  assert.deepEqual(parseWakeFilter({ contains: [" bug "] }), { contains: ["bug"] });
});

test("parseEventTrigger.silentRepro：预设展开 room.message+默认关键词+默认节奏", () => {
  // silentRepro 无 events 也可创建（预设补 room.message），显式 opt-in
  const et = parseEventTrigger({ silentRepro: true }, "room")!;
  assert.equal(et.silentRepro, true);
  assert.ok(et.events.includes("room.message"));
  assert.equal(et.debounceMs, SILENT_REPRO_DEFAULTS.debounceMs);
  assert.equal(et.maxPerHour, SILENT_REPRO_DEFAULTS.maxPerHour);
  assert.deepEqual(et.filter?.contains, SILENT_REPRO_KEYWORDS);
  // 自定义 contains 覆盖默认、显式节奏不覆盖
  const custom = parseEventTrigger({
    silentRepro: true,
    debounceMs: 5000,
    filter: { contains: ["白屏"] },
  }, "room")!;
  assert.equal(custom.debounceMs, 5000);
  assert.deepEqual(custom.filter?.contains, ["白屏"]);
  // 非 silent 任务不含 room.message 也可订阅（白名单内），但不带 silentRepro 标记
  const plain = parseEventTrigger({ events: ["room.message"], filter: { contains: ["bug"] } }, "room")!;
  assert.equal(plain.silentRepro, undefined);
  // silentRepro 仍限房作用域
  assert.throws(() => parseEventTrigger({ silentRepro: true }, "session"), /room target/);
});

test("SilentReproBook：每房每天限轮次、跨天重置、房间隔离", () => {
  let now = 1000;
  const book = new SilentReproBook(() => now);
  assert.equal(book.admit("r1", 2), true);
  assert.equal(book.admit("r1", 2), true);
  assert.equal(book.admit("r1", 2), false, "第 3 轮被每房上限拦截");
  assert.equal(book.admit("r2", 2), true, "房间之间互不影响");
  now += 86_400_001;
  assert.equal(book.admit("r1", 2), true, "跨 24h 窗口后重置");
});

test("buildSilentReproPrompt：含报障原文+三段式要求+IFC 作用域+不打扰约束，长文截断", () => {
  const p = buildSilentReproPrompt("检查问题", "应用打开就崩溃");
  assert.ok(p.includes("检查问题"));
  assert.ok(p.includes("应用打开就崩溃"));
  assert.ok(p.includes("复现"));
  assert.ok(p.includes("根因"));
  assert.ok(p.includes("黑板"));
  assert.ok(p.includes("本房"));
  const long = buildSilentReproPrompt("x", "y".repeat(1000));
  assert.ok(long.length < 1000, "报障原文被截断到 500 字");
});

test("Scheduler.fireEvent.messageOverride：静默任务用包装 prompt 派发，日志仍记原文", async () => {
  const seen: string[] = [];
  const s = makeScheduler(async (t) => {
    seen.push(t.message);
  });
  const task = baseTask({ message: "原始任务文案" });
  await s.fireEvent(task, "包装后的静默复现 prompt");
  assert.deepEqual(seen, ["包装后的静默复现 prompt"]);
  await s.fireEvent(task);
  assert.deepEqual(seen, ["包装后的静默复现 prompt", "原始任务文案"]);
});
