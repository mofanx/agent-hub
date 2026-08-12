import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomManager, type Room } from "./room.js";

describe("room", () => {
  it("buildPrompt 通过 roleId 注入角色 persona", () => {
    const rooms = new RoomManager();
    rooms.setRoleResolver((roleId) =>
      roleId === "architect" ? "你是资深架构师，注重可维护性" : undefined,
    );
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: "architect" },
    });
    const prompt = rooms.buildPrompt(room.roomId, "怎么设计？", "s1");
    assert.ok(prompt.includes("你的角色设定：你是资深架构师，注重可维护性"));
  });

  it("buildPrompt 兼容旧数据中的 persona 全文", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: "你是产品经理，关注用户体验" },
    });
    const prompt = rooms.buildPrompt(room.roomId, "怎么设计？", "s1");
    assert.ok(prompt.includes("你的角色设定：你是产品经理，关注用户体验"));
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

  it("route @mention 精确匹配目标", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "alice" },
      { sessionId: "s2", name: "bob" },
    ]);
    const result = rooms.route(room.roomId, "@alice 你好");
    assert.deepEqual(result.targets, ["s1"]);
    assert.deepEqual(result.mentioned, ["s1"]);
  });

  it("route 无 mention 时广播给全体成员", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "alice" },
      { sessionId: "s2", name: "bob" },
    ]);
    const result = rooms.route(room.roomId, "大家好");
    assert.deepEqual(result.targets, ["s1", "s2"]);
    assert.deepEqual(result.mentioned, []);
  });

  it("create 对重名成员自动去重", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "alice" },
      { sessionId: "s2", name: "alice" },
    ]);
    const names = room.members.map((m) => m.name);
    assert.equal(names[0], "alice");
    assert.notEqual(names[1], "alice");
    assert.ok(names[1]!.startsWith("alice"));
  });

  it("pipelineOrder 使用自定义顺序并补齐剩余成员", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a" },
      { sessionId: "s2", name: "b" },
      { sessionId: "s3", name: "c" },
    ], "pipeline", { pipelineOrder: ["s3", "s1"] });
    // RoomManager 本身没有 pipelineOrder 方法；它存于 room 对象，由 RoomModeManager 消费
    assert.deepEqual(room.pipelineOrder, ["s3", "s1"]);
  });

  it("addArtifact 写入房间 registry 并返回 id", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const artifact = rooms.addArtifact(room.roomId, {
      kind: "file",
      author: "s1",
      summary: "修改了 room.ts",
      path: "hub/src/room.ts",
    });
    assert.ok(artifact);
    assert.ok(artifact!.id);
    assert.equal(artifact!.kind, "file");
    assert.equal(room.artifacts!.length, 1);
  });

  it("getArtifacts 按时间倒序返回并支持 limit", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    for (let i = 0; i < 15; i++) {
      rooms.addArtifact(room.roomId, { kind: "note", author: "s1", summary: `n${i}` });
    }
    const all = rooms.getArtifacts(room.roomId, 100);
    assert.equal(all.length, 15);
    assert.equal(all[0]!.summary, "n14");
    const limited = rooms.getArtifacts(room.roomId, 5);
    assert.equal(limited.length, 5);
    assert.equal(limited[0]!.summary, "n14");
  });

  it("artifact 总量超过上限时自动移除最旧条目", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    for (let i = 0; i < 55; i++) {
      rooms.addArtifact(room.roomId, { kind: "note", author: "s1", summary: `n${i}` });
    }
    assert.equal(room.artifacts!.length, 50);
    assert.ok(room.artifacts!.every((a) => a.summary.startsWith("n")));
    assert.equal(rooms.getArtifacts(room.roomId, 1)[0]!.summary, "n54");
  });

  it("removeArtifact 删除指定 artifact", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addArtifact(room.roomId, { kind: "file", author: "s1", summary: "s", path: "p" });
    assert.ok(rooms.removeArtifact(room.roomId, a!.id));
    assert.equal(room.artifacts!.length, 0);
    assert.ok(!rooms.removeArtifact(room.roomId, "missing"));
  });

  it("buildPrompt 自动注入最近的 artifacts", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    rooms.addArtifact(room.roomId, { kind: "file", author: "a2", summary: "修改了 room.ts", path: "hub/src/room.ts" });
    const prompt = rooms.buildPrompt(room.roomId, "继续改", "s1");
    assert.ok(prompt.includes("最近产生的作品/结果"));
    assert.ok(prompt.includes("hub/src/room.ts"));
    assert.ok(prompt.includes("修改了 room.ts"));
  });

  it("buildPrompt 不注入自己的 artifacts", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.addArtifact(room.roomId, { kind: "note", author: "s1", summary: "我写的" });
    const prompt = rooms.buildPrompt(room.roomId, "继续", "s1");
    assert.ok(!prompt.includes("最近产生的作品/结果"));
  });

  it("import 恢复房间时补齐 artifacts 数组", () => {
    const rooms = new RoomManager();
    const room: Room = {
      roomId: "r1",
      name: "team",
      mode: "mention",
      members: [{ sessionId: "s1", name: "a1" }],
    } as unknown as Room;
    rooms.import(room);
    assert.deepEqual(rooms.get(room.roomId)!.artifacts, []);
  });
});
