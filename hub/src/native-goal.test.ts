import { test } from "node:test";
import assert from "node:assert/strict";
import { goalCapabilities, goalSnapshot, goalUpdate } from "./native-goal.js";

const capability = { version: 1, controlMethod: "_session/goal", actions: ["set", "pause", "resume", "clear"] };
const snapshot = { objective: "approved objective", status: "active", createdAt: 100, tokensUsed: 42, tokenBudget: null };

for (const provider of ["neutral", "air"]) {
  test(`native goal: 按宣告协商 ${provider} 扩展，不按后端名称猜接口`, () => {
    const _meta = provider === "air" ? { jetbrains: { air: { version: 1, goal: capability } } } : { goal: capability };
    assert.deepEqual(goalCapabilities({ _meta }), capability);
  });
}

for (const invalid of [
  undefined,
  { ...capability, version: 2 },
  { ...capability, controlMethod: "session/prompt" },
  { ...capability, actions: ["set"] },
  { ...capability, actions: ["set", "clear", 42] },
]) {
  test(`native goal: 不安全或不完整能力降级 ${JSON.stringify(invalid)}`, () => {
    assert.equal(goalCapabilities({ _meta: { goal: invalid } }), undefined);
  });
}

test("native goal: Claude set/clear 不伪造 pause/resume", () => {
  assert.deepEqual(goalCapabilities({ _meta: { goal: { ...capability, actions: ["set", "clear"] } } })?.actions, ["set", "clear"]);
});

test("native goal: 仅采纳明确的目标快照，保留预算与原生计量", () => {
  assert.deepEqual(goalSnapshot(snapshot), snapshot);
  assert.deepEqual(goalSnapshot({ objective: "g", status: "active" }), { objective: "g", status: "active" });
  assert.equal(goalSnapshot({ objective: "g", status: "unknown" }), undefined);
  assert.equal(goalSnapshot({ objective: "", status: "active" }), undefined);
  assert.equal(goalSnapshot({ ...snapshot, tokensUsed: -1 }), undefined);
});

test("native goal: 清除、无更新和坏数据不可混淆", () => {
  const update = (goal: unknown) => ({ sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { goal } } } });
  assert.equal(goalUpdate(update(null)), null);
  assert.deepEqual(goalUpdate(update(snapshot)), snapshot);
  assert.equal(goalUpdate(update({ status: "active" })), undefined);
  assert.equal(goalUpdate({ sessionUpdate: "usage_update", _meta: { goal: snapshot } }), undefined);
  assert.equal(goalUpdate({ sessionUpdate: "session_info_update" }), undefined);
});
