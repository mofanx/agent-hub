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

  it("mention 模式自动识别 alias 引用并注入上下文", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const a = rooms.addArtifact(room.roomId, { kind: "file", author: "s2", summary: "文件 a", path: "src/a.ts" })!;
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "@coder 继续 a1", {});
    assert.equal(prompts.length, 1);
    const text = typeof prompts[0]!.text === "string" ? prompts[0]!.text : JSON.stringify(prompts[0]!.text);
    assert.ok(text.includes("文件 a"));
    assert.ok(text.includes(a.alias!));
  });

  it("conductor 模式 /task 解析自动注入 artifact 引用", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    room.mode = "conductor";
    room.conductorId = "s1";
    const a = rooms.addArtifact(room.roomId, { kind: "file", author: "s2", summary: "需要继续的文件", path: "src/a.ts" })!;
    const prompts: { sessionId: string; text: string | unknown[] }[] = [];
    const agent: AgentOps = {
      prompt: async (sid, text) => { prompts.push({ sessionId: sid, text }); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    await manager.handle(room, "/task @coder 继续 a1");
    const worker = prompts.find((p) => p.sessionId === "s1");
    const text = typeof worker?.text === "string" ? worker!.text : JSON.stringify(worker!.text);
    assert.ok(text?.includes("需要继续的文件"));
    assert.ok(text?.includes("a1"));
  });
});
