import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveMemberStatus, presenceEvents } from "./presence.js";

describe("member.status 事件协议", () => {
  it("deriveMemberStatus：busy→generating，离线→offline，其余→online", () => {
    assert.equal(deriveMemberStatus(true, true), "generating");
    assert.equal(deriveMemberStatus(true, false), "online");
    assert.equal(deriveMemberStatus(false, false), "offline");
    assert.equal(deriveMemberStatus(false, true), "offline");
  });

  it("busy 起止/断连 → session+room 双作用域事件，scope/id/member 字段正确", () => {
    // busy 开始 → generating
    const gen = presenceEvents("s1", "generating", ["r1", "r2"]);
    assert.deepEqual(gen, [
      { scope: "session", id: "s1", member: "s1", status: "generating" },
      { scope: "room", id: "r1", member: "s1", status: "generating" },
      { scope: "room", id: "r2", member: "s1", status: "generating" },
    ]);
    // busy 结束 → online；worker 断连 → offline
    const off = presenceEvents("s1", "offline", ["r1"]);
    assert.equal(off.length, 2);
    assert.equal(off[1]!.scope, "room");
    assert.equal(off[1]!.id, "r1");
    assert.equal(off[1]!.status, "offline");
    // 无房间归属：仅 session 作用域
    const solo = presenceEvents("s9", "online");
    assert.deepEqual(solo, [
      { scope: "session", id: "s9", member: "s9", status: "online" },
    ]);
  });
});
