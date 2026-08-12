import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTaskCommand, RoomModeManager, type AgentOps } from "./room-modes.js";
import { resolveMemberByString } from "./conductor.js";
import { RoomManager } from "./room.js";
import type { Room } from "./room.js";

const room: Room = {
  roomId: "r1",
  name: "test",
  mode: "conductor",
  conductorId: "s1",
  members: [
    { sessionId: "s1", name: "coder" },
    { sessionId: "s2", name: "tester" },
  ],
};

describe("room-modes", () => {
  it("parseTaskCommand 解析单任务", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序");
    assert.equal(tasks?.length, 1);
    assert.equal(tasks?.[0]?.to, "coder");
    assert.equal(tasks?.[0]?.task, "实现排序");
    assert.equal(tasks?.[0]?.id, "t1");
    assert.deepEqual(tasks?.[0]?.dependsOn, []);
  });

  it("parseTaskCommand 解析多任务", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序；@tester 写单测");
    assert.equal(tasks?.length, 2);
    assert.equal(tasks?.[0]?.id, "t1");
    assert.equal(tasks?.[0]?.task, "实现排序");
    assert.equal(tasks?.[1]?.id, "t2");
    assert.equal(tasks?.[1]?.task, "写单测");
  });

  it("parseTaskCommand 解析依赖", () => {
    const tasks = parseTaskCommand("/task @coder 实现排序；@tester 写单测 (depends: t1)");
    assert.equal(tasks?.length, 2);
    assert.deepEqual(tasks?.[1]?.dependsOn, ["t1"]);
    assert.equal(tasks?.[1]?.task, "写单测");
  });

  it("parseTaskCommand 空 /task 返回空数组", () => {
    const tasks = parseTaskCommand("/task  ");
    assert.equal(tasks?.length, 0);
  });

  it("parseTaskCommand 非 /task 返回 undefined", () => {
    const tasks = parseTaskCommand("@coder 实现排序");
    assert.equal(tasks, undefined);
  });

  it("resolveMemberByString 按 name / id / 前缀解析", () => {
    assert.equal(resolveMemberByString(room, "coder")?.sessionId, "s1");
    assert.equal(resolveMemberByString(room, "s2")?.sessionId, "s2");
    assert.equal(resolveMemberByString(room, "tes")?.sessionId, "s2");
    assert.equal(resolveMemberByString(room, "未知"), undefined);
  });

  it("mention 模式输出自动提取 artifact 到房间 registry", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const agent: AgentOps = {
      prompt: async () => {},
      isBusy: () => false,
      cancel: async () => {},
    };
    const broadcasted: { method: string; params: Record<string, unknown> }[] = [];
    const manager = new RoomModeManager(agent, rooms, (method, params) =>
      broadcasted.push({ method, params }),
    );
    await manager.handle(room, "@coder 改一下 room.ts", {});
    const output = `已修改 hub/src/room.ts\n\`\`\`bash\nnpx tsc --noEmit\n\`\`\``;
    await manager.onPromptDone("s1", output);
    const artifacts = rooms.getArtifacts(room.roomId, 10);
    assert.equal(artifacts.length, 2);
    const command = artifacts.find((a) => a.kind === "command");
    const file = artifacts.find((a) => a.kind === "file");
    assert.equal(command?.summary, "npx tsc --noEmit");
    assert.equal(file?.path, "hub/src/room.ts");
  });
});
