import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomManager, type Room } from "./room.js";

describe("room", () => {
  it("buildPrompt 注入角色 persona", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: "你是资深架构师，注重可维护性" },
    });
    const prompt = rooms.buildPrompt(room.roomId, "怎么设计？", "s1", undefined, "你是资深架构师，注重可维护性");
    assert.ok(prompt.includes("你的角色设定：你是资深架构师，注重可维护性"));
  });

  it("buildPrompt 无角色时使用默认提示", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const prompt = rooms.buildPrompt(room.roomId, "hello", "s1");
    assert.ok(prompt.includes("你在一个多 agent 协作群聊中"));
  });

  it("create 保存 memberRoles", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: "test" },
    });
    assert.deepEqual(room.memberRoles, { s1: "test" });
  });

  it("update 更新 memberRoles", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const updated = rooms.update(room.roomId, "team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: "updated" },
    });
    assert.deepEqual(updated.memberRoles, { s1: "updated" });
  });
});
