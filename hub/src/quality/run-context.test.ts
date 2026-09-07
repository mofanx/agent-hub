import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RunContextRegistry, type RunContext } from "./run-context.js";

describe("run-context registry", () => {
  let reg: RunContextRegistry;

  beforeEach(() => {
    reg = new RunContextRegistry();
  });

  it("bind 后 get 返回上下文", () => {
    const ctx: RunContext = { runId: "r1", role: "implementer" };
    reg.bind("s1", ctx, "room-1");
    const sc = reg.get("s1");
    assert.ok(sc);
    assert.equal(sc!.runId, "r1");
    assert.equal(sc!.role, "implementer");
    assert.equal(sc!.roomId, "room-1");
  });

  it("unbind 解绑", () => {
    reg.bind("s1", { runId: "r1", role: "reviewer" });
    const removed = reg.unbind("s1");
    assert.ok(removed);
    assert.equal(reg.get("s1"), undefined);
  });

  it("unbindRun 解绑该 run 的所有 session", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    reg.bind("s2", { runId: "r1", role: "reviewer" });
    reg.bind("s3", { runId: "r2", role: "implementer" });
    const removed = reg.unbindRun("r1");
    assert.equal(removed.length, 2);
    assert.ok(removed.includes("s1"));
    assert.ok(removed.includes("s2"));
    assert.equal(reg.get("s3")?.runId, "r2");
  });

  it("hasActiveRun", () => {
    assert.equal(reg.hasActiveRun("s1"), false);
    reg.bind("s1", { runId: "r1", role: "implementer" });
    assert.equal(reg.hasActiveRun("s1"), true);
  });

  it("getSessionsForRun", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    reg.bind("s2", { runId: "r1", role: "reviewer" });
    reg.bind("s3", { runId: "r2", role: "implementer" });
    const sessions = reg.getSessionsForRun("r1");
    assert.equal(sessions.length, 2);
    assert.ok(sessions.includes("s1"));
    assert.ok(sessions.includes("s2"));
  });

  it("setTaskId 更新 session 的 task", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    assert.equal(reg.get("s1")?.taskId, undefined);
    assert.equal(reg.setTaskId("s1", "t1"), true);
    assert.equal(reg.get("s1")?.taskId, "t1");
  });

  it("setTaskId 对未绑定 session 返回 false", () => {
    assert.equal(reg.setTaskId("unknown", "t1"), false);
  });

  it("hasTask", () => {
    reg.bind("s1", { runId: "r1", role: "implementer", taskId: "t1" });
    assert.equal(reg.hasTask("s1", "t1"), true);
    assert.equal(reg.hasTask("s1", "t2"), false);
  });

  it("activeRunIds", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    reg.bind("s2", { runId: "r2", role: "reviewer" });
    const ids = reg.activeRunIds();
    assert.equal(ids.length, 2);
    assert.ok(ids.includes("r1"));
    assert.ok(ids.includes("r2"));
  });

  it("clear 清除所有", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    reg.clear();
    assert.equal(reg.get("s1"), undefined);
    assert.equal(reg.activeRunIds().length, 0);
  });

  it("tagEvent 附加 runId 和 taskId", () => {
    reg.bind("s1", { runId: "r1", role: "implementer", taskId: "t1" });
    const event = { path: "src/foo.ts", action: "modify" };
    const tagged = reg.tagEvent("s1", event);
    assert.equal(tagged.runId, "r1");
    assert.equal(tagged.taskId, "t1");
    assert.equal(tagged.path, "src/foo.ts");
  });

  it("tagEvent 对未绑定 session 不附加", () => {
    const event = { path: "src/foo.ts" };
    const tagged = reg.tagEvent("unknown", event);
    assert.equal(tagged.runId, undefined);
    assert.equal(tagged.taskId, undefined);
  });

  it("同 session 重新 bind 覆盖旧上下文", () => {
    reg.bind("s1", { runId: "r1", role: "implementer" });
    reg.bind("s1", { runId: "r2", role: "reviewer" });
    const sc = reg.get("s1");
    assert.equal(sc!.runId, "r2");
    assert.equal(sc!.role, "reviewer");
    assert.equal(reg.getSessionsForRun("r1").length, 0);
    assert.equal(reg.getSessionsForRun("r2").length, 1);
  });
});
