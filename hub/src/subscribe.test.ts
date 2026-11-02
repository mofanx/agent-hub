import test from "node:test";
import assert from "node:assert/strict";
import { shouldDeliver, type ClientSub } from "./subscribe.js";

const globalSub: ClientSub = { tier: "global" };

test("未声明订阅按 detail 全量放行（向后兼容）", () => {
  assert.equal(shouldDeliver(undefined, { method: "session.update" }), true);
  assert.equal(shouldDeliver({ tier: "detail" }, { method: "session.update" }), true);
});

test("global 层放行低频状态类事件", () => {
  for (const m of [
    "mission.update",
    "decision.request",
    "decision.resolve",
    "room.flowUpdate",
    "room.blackboardUpdate",
    "room.modeSelected",
    "room.update",
    "task.update",
    "agent.status",
    "prompt.error",
    "session.status",
    "room.artifact",
    "member.status",
    "room.notice",
  ]) {
    assert.equal(shouldDeliver(globalSub, { method: m }), true, m);
  }
});

test("global 层过滤高频流式/过程/用量事件", () => {
  for (const m of [
    "session.update",
    "session.usage",
    "prompt.chunk",
    "tool_call",
    "room.events",
    "session.artifact",
  ]) {
    assert.equal(shouldDeliver(globalSub, { method: m }), false, m);
  }
});

test("global 层 room.process 仅放行 flow 卡信封", () => {
  assert.equal(
    shouldDeliver(globalSub, {
      method: "room.process",
      params: { entry: { kind: "flow" } },
    }),
    true,
  );
  assert.equal(
    shouldDeliver(globalSub, {
      method: "room.process",
      params: { entry: { kind: "thought" } },
    }),
    false,
  );
  assert.equal(
    shouldDeliver(globalSub, {
      method: "room.process",
      params: { cardType: "flow" },
    }),
    true,
  );
  assert.equal(
    shouldDeliver(globalSub, { method: "room.process", params: {} }),
    false,
  );
});
