import { test } from "node:test";
import assert from "node:assert/strict";
import { MissionManager, type MissionDeps } from "./mission.js";

function fixture(meta = new Map<string, string>()) {
  const room = { roomId: "r1", name: "test", mode: "mention", members: [{ sessionId: "s1", name: "worker" }] };
  const deps = {
    store: { getMeta: (key: string) => meta.get(key), setMeta: (key: string, value: string) => { meta.set(key, value); } },
    getRoom: () => room,
    getFlow: () => undefined,
    hasActiveFlow: () => false,
    isBusy: () => false,
    isAvailable: () => true,
    dispatch: async () => ({ sent: [], skipped: [], mentioned: [] }),
    cancelActive: async () => {},
    cancel: async () => {},
    retryFailedTasks: () => false,
    supplementActive: () => false,
    broadcast: () => {},
  } as unknown as MissionDeps;
  const manager = new MissionManager(deps);
  const create = (sourceId: unknown = "session:s1:42:0") =>
    manager.create({ roomId: "r1", goal: "g", acceptanceCriteria: ["a"], ...{ sourceId } });
  return { manager, create, meta };
}

test("mission source: 同一来源跨客户端和停止后重放返回原工单", async () => {
  const f = fixture();
  const first = f.create();
  assert.equal(f.create().id, first.id);
  await f.manager.stop(first.id);
  assert.equal(f.create().id, first.id);
  assert.equal(f.create().status, "stopped");
  assert.equal(f.manager.list().length, 1);
});

test("mission source: 重启后来源去重仍有效，不重新启动终态工单", async () => {
  const f = fixture();
  const first = f.create();
  await f.manager.stop(first.id);
  const restored = fixture(f.meta);
  assert.equal(restored.create().id, first.id);
  assert.equal(restored.create().status, "stopped");
});

test("mission source: 删除工单后来源仍已消费，不能由旧卡重建", async () => {
  const f = fixture();
  const first = f.create();
  await f.manager.delete(first.id, true);
  const restored = fixture(f.meta);
  assert.throws(() => restored.create(), /source.*consumed/i);
});

test("mission source: 相同内容的新来源可以显式创建新工单", () => {
  const f = fixture();
  assert.notEqual(f.create().id, f.create("session:s1:43:0").id);
});

for (const sourceId of ["", "x".repeat(513), 42, "bad\nsource"]) {
  test(`mission source: 拒绝非法来源 ${String(sourceId).slice(0, 18)}`, () => {
    assert.throws(() => fixture().create(sourceId), /sourceId/);
  });
}
