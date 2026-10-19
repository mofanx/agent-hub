import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupInflight } from "./op-ledger.js";

describe("dedupInflight", () => {
  it("并发同 key 复用同一 Promise", async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const factory = () => {
      calls++;
      return new Promise<number>((r) => setTimeout(() => r(42), 5));
    };
    const a = dedupInflight(map, "k", factory);
    const b = dedupInflight(map, "k", factory);
    assert.equal(a, b, "inflight 期同 key 应返回同一 Promise");
    assert.equal(calls, 1);
    assert.equal(await a, 42);
    assert.equal(map.size, 0, "settle 后条目应清理");
  });

  it("factory 失败后条目清理可重试", async () => {
    const map = new Map<string, Promise<number>>();
    let calls = 0;
    const factory = () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(7);
    };
    await assert.rejects(dedupInflight(map, "k", factory));
    assert.equal(map.size, 0, "失败后条目应清理");
    assert.equal(await dedupInflight(map, "k", factory), 7, "重试应重新调用 factory");
    assert.equal(calls, 2);
  });
});
