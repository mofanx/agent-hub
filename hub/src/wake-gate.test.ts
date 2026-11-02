import test from "node:test";
import assert from "node:assert/strict";
import { wakeGateAllows, parseWakeFilter, WakeGateStats } from "./wake-gate.js";
import { parseEventTrigger } from "./mission-schedule.js";

test("wakeGateAllows: 无 filter/无 fields 恒放行（兼容现有行为）", () => {
  assert.equal(wakeGateAllows(undefined, { kind: "decision" }), true);
  assert.equal(wakeGateAllows({}, { kind: "x" }), true);
  assert.equal(wakeGateAllows({ fields: {} }, { kind: "x" }), true);
});

test("wakeGateAllows: fields AND 匹配——全命中才放行", () => {
  const f = { fields: { status: "accepted", kind: "task.done" } };
  assert.equal(
    wakeGateAllows(f, { kind: "task.done", status: "accepted" }),
    true,
  );
  assert.equal(
    wakeGateAllows(f, { kind: "task.done", status: "failed" }),
    false,
    "status 不匹配",
  );
  assert.equal(
    wakeGateAllows(f, { kind: "decision", status: "accepted" }),
    false,
    "kind 不匹配",
  );
  assert.equal(wakeGateAllows(f, { kind: "task.done" }), false, "缺字段按不匹配");
});

test("wakeGateAllows: 点路径下探 + 布尔/数字转字符串比较", () => {
  assert.equal(
    wakeGateAllows({ fields: { "flow.waitingFor": "user" } }, { flow: { waitingFor: "user" } }),
    true,
  );
  assert.equal(wakeGateAllows({ fields: { n: "3" } }, { n: 3 }), true);
  assert.equal(wakeGateAllows({ fields: { ok: "true" } }, { ok: true }), true);
});

test("parseWakeFilter: 形状校验——对象外拒绝、值类型限定", () => {
  assert.equal(parseWakeFilter(undefined), undefined);
  assert.deepEqual(parseWakeFilter({}), {});
  assert.deepEqual(
    parseWakeFilter({ fields: { a: "x", n: 2, b: true } }),
    { fields: { a: "x", n: "2", b: "true" } },
  );
  assert.throws(() => parseWakeFilter("x"), /must be an object/);
  assert.throws(() => parseWakeFilter({ fields: [1] }), /must be an object/);
  assert.throws(() => parseWakeFilter({ fields: { a: {} } }), /string\/number\/boolean/);
});

test("parseEventTrigger: filter 透传 + 非法 filter 拒绝", () => {
  const et = parseEventTrigger(
    { events: ["task.done"], filter: { fields: { status: "accepted" } } },
    "room",
  );
  assert.deepEqual(et?.filter, { fields: { status: "accepted" } });
  const noFilter = parseEventTrigger({ events: ["prompt.done"] }, "room");
  assert.equal(noFilter?.filter, undefined);
  assert.throws(
    () => parseEventTrigger({ events: ["task.done"], filter: "x" }, "room"),
    /must be an object/,
  );
});

test("WakeGateStats: 拦截计数按任务聚合、可清理", () => {
  const s = new WakeGateStats();
  s.skip("t1"); s.skip("t1"); s.skip("t2");
  assert.equal(s.count("t1"), 2);
  assert.equal(s.count("t2"), 1);
  assert.equal(s.count("t9"), 0);
  s.remove("t1");
  assert.equal(s.count("t1"), 0);
});
