import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WriterLeaseManager, acquireOrThrow, type Lease } from "./lease.js";

describe("writer lease", () => {
  let mgr: WriterLeaseManager;

  beforeEach(() => {
    mgr = new WriterLeaseManager(1000);
  });

  it("首次获取 lease 成功", () => {
    const result = mgr.acquire("p1", "holder-1", "run-1");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lease.projectId, "p1");
      assert.equal(result.lease.holderId, "holder-1");
      assert.equal(result.lease.runId, "run-1");
    }
  });

  it("同一 holder 可重复获取（续租）", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    const result = mgr.acquire("p1", "holder-1", "run-2");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.lease.runId, "run-2");
  });

  it("不同 holder 获取失败", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    const result = mgr.acquire("p1", "holder-2", "run-2");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "held-by-other");
      assert.equal(result.currentHolder, "holder-1");
      assert.equal(result.currentRunId, "run-1");
    }
  });

  it("release 后其他 holder 可获取", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    assert.equal(mgr.release("p1", "holder-1"), true);
    const result = mgr.acquire("p1", "holder-2", "run-2");
    assert.equal(result.ok, true);
  });

  it("非持有者 release 返回 false", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    assert.equal(mgr.release("p1", "holder-2"), false);
  });

  it("isHeld 反映当前状态", () => {
    assert.equal(mgr.isHeld("p1"), false);
    mgr.acquire("p1", "holder-1", "run-1");
    assert.equal(mgr.isHeld("p1"), true);
    mgr.release("p1", "holder-1");
    assert.equal(mgr.isHeld("p1"), false);
  });

  it("过期 lease 自动淘汰", async () => {
    mgr.acquire("p1", "holder-1", "run-1");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(mgr.isHeld("p1"), false);
    const result = mgr.acquire("p1", "holder-2", "run-2");
    assert.equal(result.ok, true);
  });

  it("renew 续租", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    const lease = mgr.renew("p1", "holder-1");
    assert.ok(lease.expiresAt > Date.now());
  });

  it("renew 非持有者抛错", () => {
    assert.throws(() => mgr.renew("p1", "holder-1"), /no lease held/);
  });

  it("releaseByRunId 释放该 run 的所有 lease", () => {
    mgr.acquire("p1", "holder-1", "run-1");
    mgr.acquire("p2", "holder-2", "run-1");
    mgr.acquire("p3", "holder-3", "run-2");
    const released = mgr.releaseByRunId("run-1");
    assert.equal(released.length, 2);
    assert.ok(released.includes("p1"));
    assert.ok(released.includes("p2"));
    assert.equal(mgr.isHeld("p3"), true);
  });

  it("listActive 只返回未过期的", async () => {
    mgr.acquire("p1", "h1", "r1");
    await new Promise((r) => setTimeout(r, 1100));
    mgr.acquire("p2", "h2", "r2");
    const active = mgr.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.projectId, "p2");
  });

  it("clear 清除所有", () => {
    mgr.acquire("p1", "h1", "r1");
    mgr.acquire("p2", "h2", "r2");
    mgr.clear();
    assert.equal(mgr.isHeld("p1"), false);
    assert.equal(mgr.isHeld("p2"), false);
  });

  it("acquireOrThrow 成功返回 lease", () => {
    const project = { id: "p1" } as never;
    const lease = acquireOrThrow(mgr, project, "h1", "r1");
    assert.equal(lease.projectId, "p1");
  });

  it("acquireOrThrow 失败抛错", () => {
    mgr.acquire("p1", "h1", "r1");
    const project = { id: "p1" } as never;
    assert.throws(() => acquireOrThrow(mgr, project, "h2", "r2"), /held by h1/);
  });
});
