import test from "node:test";
import assert from "node:assert/strict";
import { shouldDeliver, TaskSubscriptions } from "./subscribe.js";

const ev = (method: string, params: Record<string, unknown>) => ({ method, params });

test("TaskSubscriptions：登记/成员查询/单任务与批量清理", () => {
  const s = new TaskSubscriptions();
  s.add("r1", "t1", "s1");
  s.add("r1", "t1", "s2");
  s.add("r1", "t2", "s3");
  assert.deepEqual([...s.members("r1", "t1")!].sort(), ["s1", "s2"]);
  assert.equal(s.members("r1", "nope"), undefined);
  s.removeTask("r1", "t1");
  assert.equal(s.members("r1", "t1"), undefined);
  s.add("r1", "t3", "s1");
  s.removeTasks("r1", ["t2", "t3"]);
  assert.equal(s.size, 0);
  s.add("r1", "t1", "s1");
  s.add("r2", "t1", "s2");
  s.removeTasks("r1", ["t1"]);
  assert.deepEqual([...s.members("r2", "t1")!], ["s2"]);
});

test("shouldDeliver 任务级订阅：声明 taskIds 后仅订阅工单放行，未声明全量兼容", () => {
  const sub = { tier: "detail" as const, taskIds: new Set(["t1"]) };
  // params.taskId 路径
  assert.equal(shouldDeliver(sub, ev("task.update", { taskId: "t1" })), true);
  assert.equal(shouldDeliver(sub, ev("task.update", { taskId: "t2" })), false);
  // 声明房间时 taskIds 仅收窄本房事件——他房同名 taskId 不误放行也不误拦
  const roomSub = { tier: "detail" as const, roomId: "r1", taskIds: new Set(["t1"]) };
  assert.equal(shouldDeliver(roomSub, ev("task.update", { roomId: "r1", taskId: "t2" })), false);
  assert.equal(shouldDeliver(roomSub, ev("task.update", { roomId: "r2", taskId: "t2" })), true);
  assert.equal(shouldDeliver(roomSub, ev("task.update", { roomId: "r2", taskId: "t1" })), true);
  // entry.taskId 路径
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { taskId: "t1" } })), true);
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { taskId: "t9" } })), false);
  // entry.meta.taskId 路径
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { meta: { taskId: "t1" } } })), true);
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { meta: { taskId: "t9" } } })), false);
  // 无 taskId 的事件按原层级判定——detail 全放行
  assert.equal(shouldDeliver(sub, ev("room.update", { roomId: "r1" })), true);
  // 未声明 taskIds → 兼容：工单事件照常全量（房级广播语义不变）
  const legacy = { tier: "detail" as const };
  assert.equal(shouldDeliver(legacy, ev("task.update", { taskId: "t2" })), true);
  assert.equal(shouldDeliver(undefined, ev("task.update", { taskId: "t2" })), true);
});

test("shouldDeliver 任务级订阅 × global 层：taskId 过滤先于 tier 白名单", () => {
  const sub = { tier: "global" as const, taskIds: new Set(["t1"]) };
  // 订阅工单且在 global 白名单 → 放行
  assert.equal(shouldDeliver(sub, ev("task.update", { taskId: "t1" })), true);
  // 未订阅工单 → 白名单也拦
  assert.equal(shouldDeliver(sub, ev("task.update", { taskId: "t2" })), false);
  // 订阅工单的 room.process 非 flow 卡 → tier 层拦
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { taskId: "t1", kind: "stderr" } })), false);
  // 订阅工单的 room.process flow 卡 → 两层都放行
  assert.equal(shouldDeliver(sub, ev("room.process", { entry: { taskId: "t1", kind: "flow" } })), true);
});
