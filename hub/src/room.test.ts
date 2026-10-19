import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  RoomManager,
  dedupeName,
  displayNameFor,
  remapRoomModeConfig,
  normalizePersonaValue,
  serializePersonaCard,
  parseMemberRolesParam,
  parseAliasesParam,
  PERSONA_PROMPT_LIMIT,
  type Room,
} from "./room.js";
import { lostReplyAction, Store } from "./store.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../..");
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..");
const FILES_DIR = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../data/files");

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

  it("addFile 写入房间 registry 并返回 id", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const artifact = rooms.addFile(room.roomId, {
      author: "s1",
      summary: "修改了 room.ts",
      path: "hub/src/room.ts",
    });
    assert.ok(artifact);
    assert.ok(artifact!.id);
    assert.equal(artifact!.path, "hub/src/room.ts");
    assert.equal(artifact!.author, "s1");
    assert.equal(room.artifacts!.length, 1);
  });

  it("addFile 同 path 时 upsert，作者名规范为 sessionId", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    const first = rooms.addFile(room.roomId, { author: "a1", summary: "初版", path: "src/a.ts" })!;
    const second = rooms.addFile(room.roomId, { author: "a2", summary: "改过", path: "src/a.ts", taskId: "t2" })!;
    assert.equal(room.artifacts!.length, 1);
    assert.equal(second.id, first.id);
    assert.equal(second.alias, first.alias);
    assert.equal(second.author, "s2");
    assert.equal(second.summary, "改过");
    assert.equal(second.taskId, "t2");
    const ev = rooms.addEvent(room.roomId, { author: "a1", action: "command", summary: "跑测试" });
    assert.equal(ev!.author, "s1");
    assert.equal(room.events!.length, 1);
  });

  it("getArtifacts 按时间倒序返回并支持 limit", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    for (let i = 0; i < 15; i++) {
      rooms.addFile(room.roomId, { author: "s1", summary: `n${i}`, path: `p${i}.ts` });
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
      rooms.addFile(room.roomId, { author: "s1", summary: `n${i}`, path: `p${i}.ts` });
    }
    assert.equal(room.artifacts!.length, 50);
    assert.ok(room.artifacts!.every((a) => a.summary.startsWith("n")));
    assert.equal(rooms.getArtifacts(room.roomId, 1)[0]!.summary, "n54");
  });

  it("removeArtifact 删除指定 artifact", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addFile(room.roomId, { author: "s1", summary: "s", path: "p" });
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
    rooms.addFile(room.roomId, { author: "s2", summary: "修改了 room.ts", path: "hub/src/room.ts" });
    const prompt = rooms.buildPrompt(room.roomId, "继续改", "s1");
    assert.ok(prompt.includes("最近产物"));
    assert.ok(prompt.includes("hub/src/room.ts"));
    assert.ok(prompt.includes("修改了 room.ts"));
    assert.ok(prompt.includes("@a2"));
    assert.ok(!prompt.includes("@s2"));
  });

  it("buildPrompt 按 dependsOn 只注入上游 task 的 artifact", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    rooms.addFile(room.roomId, { author: "s2", summary: "上游输出", path: "src/a.ts", taskId: "t1" });
    rooms.addFile(room.roomId, { author: "s2", summary: "无关输出", path: "src/b.ts", taskId: "t2" });
    const prompt = rooms.buildPrompt(room.roomId, "继续改", "s1", undefined, undefined, { taskId: "t3", dependsOn: ["t1"] });
    assert.ok(prompt.includes("上游输出"));
    assert.ok(!prompt.includes("无关输出"));
  });

  it("buildPrompt 不注入自己的 artifacts", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.addFile(room.roomId, { author: "s1", summary: "我写的", path: "src/a.ts" });
    const prompt = rooms.buildPrompt(room.roomId, "继续", "s1");
    assert.ok(!prompt.includes("最近产物"));
  });

  it("parseArtifactRefs 从文本识别 id 与 path", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addFile(room.roomId, { author: "s2", summary: "x", path: "hub/src/room.ts" })!;
    const refs = rooms.parseArtifactRefs(room.roomId, `继续 ${a.id} 和 artifact:${a.id} 以及 hub/src/room.ts`);
    assert.deepEqual(refs, [a.id]);
  });

  it("parseArtifactRefs 识别 alias、括号与 artifact: 前缀", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addFile(room.roomId, { author: "s2", summary: "alias test", path: "hub/src/x.ts" })!;
    assert.equal(a.alias, "a1");
    const refs = rooms.parseArtifactRefs(room.roomId, "继续 a1 和 [a1] 以及 artifact:a1");
    assert.deepEqual(refs, [a.id]);
    const byPath = rooms.parseArtifactRefs(room.roomId, "基于 hub/src/x.ts");
    assert.deepEqual(byPath, [a.id]);
  });

  it("buildPrompt 显式引用时不过滤作者", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addFile(room.roomId, { author: "s1", summary: "我写的", path: "src/a.ts" })!;
    const prompt = rooms.buildPrompt(room.roomId, `继续 ${a.id}`, "s1", undefined, undefined, { refs: [a.id] });
    assert.ok(prompt.includes("我写的"));
  });

  it("buildPrompt 显式引用 alias 时不过滤作者", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const a = rooms.addFile(room.roomId, { author: "s1", summary: "alias 写的", path: "src/a.ts" })!;
    assert.equal(a.alias, "a1");
    const prompt = rooms.buildPrompt(room.roomId, "继续 a1", "s1", undefined, undefined, { refs: ["a1"] });
    assert.ok(prompt.includes("alias 写的"));
  });

  it("buildPrompt 显式引用不存在的 artifact 不报错", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const prompt = rooms.buildPrompt(room.roomId, "继续 abcdefgh", "s1", undefined, undefined);
    assert.ok(!prompt.includes("最近产生的产物"));
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

  it("import 把旧作者名规范为 sessionId", () => {
    const rooms = new RoomManager();
    const room: Room = {
      roomId: "r2",
      name: "team",
      mode: "mention",
      members: [{ sessionId: "s1", name: "a1" }],
      artifacts: [{
        id: "x1",
        alias: "a1",
        kind: "file",
        author: "a1",
        at: 1,
        summary: "旧文件",
        path: "src/a.ts",
      }],
      events: [{
        id: "e1",
        author: "a1",
        at: 2,
        action: "command",
        summary: "旧命令",
      }],
    } as unknown as Room;
    rooms.import(room);
    assert.equal(rooms.get(room.roomId)!.artifacts![0]!.author, "s1");
    assert.equal(rooms.get(room.roomId)!.events![0]!.author, "s1");
  });

  it("displayNameFor 输出 成员名·agentType·origin，通道缺失段省略", () => {
    const m = { sessionId: "s1", name: "alice" };
    assert.equal(displayNameFor(m, { agent: "devin", origin: "local" }), "alice·devin·local");
    assert.equal(displayNameFor(m, { agent: "claude", origin: "remote" }), "alice·claude·remote");
    assert.equal(displayNameFor(m, { origin: "remote" }), "alice·remote");
    assert.equal(displayNameFor(m), "alice");
    // 新格式不含 " ("，与客户端 startsWith("name (") 容差互不误判
    assert.ok(!displayNameFor(m, { agent: "devin", origin: "local" }).includes(" ("));
  });

  it("rooms.displayNameFor 经 resolver 判定 local/remote；displayNameForId 查不到成员兜底 sessionId", () => {
    const rooms = new RoomManager();
    rooms.setMemberChannelResolver((sid) =>
      sid === "s1"
        ? { agent: "devin", origin: "local" }
        : sid === "s2"
          ? { agent: "claude", origin: "remote" }
          : undefined,
    );
    const room = rooms.create("team", [
      { sessionId: "s1", name: "alice" },
      { sessionId: "s2", name: "bob" },
    ]);
    assert.equal(rooms.displayNameFor(room.members[0]!), "alice·devin·local");
    assert.equal(rooms.displayNameFor(room.members[1]!), "bob·claude·remote");
    assert.equal(rooms.displayNameForId(room.roomId, "s1"), "alice·devin·local");
    assert.equal(rooms.displayNameForId(room.roomId, "ghost"), "ghost");
    // memberName 同一展示口径：sessionId/name/displayName 入参均产出新格式或原样透传
    assert.equal(rooms.memberName(room.roomId, "s2"), "bob·claude·remote");
    assert.equal(rooms.memberName(room.roomId, "bob·claude·remote"), "bob·claude·remote");
  });

  it("displayName 格式的 artifact author 仍参与自身产物排除与成员 cwd 解析", () => {
    const rooms = new RoomManager();
    rooms.setMemberChannelResolver(() => ({ agent: "devin", origin: "local" }));
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    const artifact = rooms.addFile(room.roomId, {
      author: "a1·devin·local",
      summary: "我写的",
      path: "src/own.ts",
    })!;
    // 新格式 author 原样入库（不再回写 sessionId）
    assert.equal(artifact.author, "a1·devin·local");
    const prompt = rooms.buildPrompt(room.roomId, "继续", "s1");
    assert.ok(!prompt.includes("我写的"));
    const prompt2 = rooms.buildPrompt(room.roomId, "继续", "s2");
    assert.ok(prompt2.includes("我写的"));
    // 产物展示走 memberName → 统一展示名
    assert.ok(prompt2.includes("@a1·devin·local"));
  });

  it("sendFile 复制文件到缓存并生成 file artifact", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const rel = `hub/src/room-file-test-${Date.now()}.txt`;
    const full = path.join(PROJECT_ROOT, rel);
    const content = "hello room file";
    fs.writeFileSync(full, content);
    try {
      const artifact = rooms.sendFile(room.roomId, rel, "s1", "test file");
      assert.ok(artifact);
      assert.equal(artifact!.summary, "test file");
      const cached = path.join(FILES_DIR, room.roomId, artifact!.id, path.basename(rel));
      assert.ok(fs.existsSync(cached));
      const result = rooms.getFile(room.roomId, artifact!.alias!);
      assert.equal((result as { text: string }).text, content);
    } finally {
      fs.rmSync(full, { force: true });
      fs.rmSync(path.join(FILES_DIR, room.roomId), { recursive: true, force: true });
    }
  });

  it("getFile 返回 base64 给二进制文件", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const rel = `hub/src/room-file-bin-${Date.now()}.bin`;
    const full = path.join(PROJECT_ROOT, rel);
    const original = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    fs.writeFileSync(full, original);
    try {
      const artifact = rooms.sendFile(room.roomId, rel);
      const result = rooms.getFile(room.roomId, artifact!.path!);
      assert.ok("data" in result);
      assert.deepEqual(Buffer.from((result as { data: string }).data, "base64"), original);
    } finally {
      fs.rmSync(full, { force: true });
      fs.rmSync(path.join(FILES_DIR, room.roomId), { recursive: true, force: true });
    }
  });

  it("sendFile 拒绝项目根目录外的文件", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    assert.throws(() => rooms.sendFile(room.roomId, "/etc/passwd"), /outside project root/);
  });

  it("getFile 可以通过工作区根目录或 session cwd 解析文件", () => {
    const rooms = new RoomManager();
    rooms.setCwdResolver((sessionId) => (sessionId === "s1" ? path.join(WORKSPACE_ROOT, "other-project") : undefined));
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);

    const rel = `getFile-workspace-${Date.now()}.txt`;
    const fullByWorkspace = path.join(WORKSPACE_ROOT, rel);
    fs.writeFileSync(fullByWorkspace, "workspace file");

    const cwdRel = `cwd-file-${Date.now()}.txt`;
    const cwd = path.join(WORKSPACE_ROOT, "other-project");
    fs.mkdirSync(cwd, { recursive: true });
    const fullByCwd = path.join(cwd, cwdRel);
    fs.writeFileSync(fullByCwd, "cwd file");

    try {
      const a1 = rooms.addFile(room.roomId, { author: "a1", summary: "workspace", path: rel })!;
      assert.equal((rooms.getFile(room.roomId, a1.id) as { text: string }).text, "workspace file");

      const a2 = rooms.addFile(room.roomId, { author: "a1", summary: "cwd", path: cwdRel })!;
      assert.equal((rooms.getFile(room.roomId, a2.id) as { text: string }).text, "cwd file");
    } finally {
      fs.rmSync(fullByWorkspace, { force: true });
      fs.rmSync(fullByCwd, { force: true });
      fs.rmSync(path.join(FILES_DIR, room.roomId), { recursive: true, force: true });
    }
  });

  it("parseFileRefs 解析 #path", () => {
    const rooms = new RoomManager();
    rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    assert.deepEqual(rooms.parseFileRefs("看一下 #hub/src/room.ts"), ["hub/src/room.ts"]);
    assert.deepEqual(rooms.parseFileRefs("对比 #a 和 #b/c"), ["a", "b/c"]);
    assert.deepEqual(rooms.parseFileRefs("# 标题不会命中"), []);
    assert.deepEqual(rooms.parseFileRefs("## 也不会"), []);
  });

  it("buildPrompt 内联 #path 引用的文件内容", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const rel = `hub/src/file-ref-${Date.now()}.txt`;
    const full = path.join(PROJECT_ROOT, rel);
    fs.writeFileSync(full, "hello file ref");
    try {
      const prompt = rooms.buildPrompt(room.roomId, `查看 #${rel}`, "s1");
      assert.ok(prompt.includes("相关文件："));
      assert.ok(prompt.includes("hello file ref"));
      assert.ok(prompt.includes(`#${rel}`));
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it("buildPrompt 内联 #path 引用的文件夹列表", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const dir = `hub/src/file-ref-dir-${Date.now()}`;
    const full = path.join(PROJECT_ROOT, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "a.txt"), "a");
    fs.writeFileSync(path.join(full, "b.txt"), "b");
    try {
      const prompt = rooms.buildPrompt(room.roomId, `查看 #${dir}`, "s1");
      assert.ok(prompt.includes("相关文件："));
      assert.ok(prompt.includes("a.txt"));
      assert.ok(prompt.includes("b.txt"));
    } finally {
      fs.rmSync(full, { recursive: true, force: true });
    }
  });

  it("buildPrompt 对不存在的 #path 给出提示", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const prompt = rooms.buildPrompt(room.roomId, "查看 #not/exist.txt", "s1");
    assert.ok(prompt.includes("相关文件："));
    assert.ok(prompt.includes("未找到文件或文件夹"));
  });

  it("getBlackboard 与 recordOutput", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput(room.roomId, "s1", "a1", "完成了任务");
    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.length, 1);
    assert.ok(board[0]!.id);
    assert.equal(board[0]!.from, "a1");
    assert.equal(board[0]!.text, "完成了任务");
    assert.equal(board[0]!.detail, "完成了任务");
  });

  it("recordOutput 只写入来源房间，不串到其他房间", () => {
    const rooms = new RoomManager();
    const roomA = rooms.create("teamA", [{ sessionId: "s1", name: "a1" }]);
    const roomB = rooms.create("teamB", [{ sessionId: "s1", name: "a1" }]);
    assert.equal(rooms.recordOutput(roomA.roomId, "s1", "a1", "完成了任务"), true);
    assert.equal(rooms.getBlackboard(roomA.roomId).length, 1);
    assert.equal(rooms.getBlackboard(roomB.roomId).length, 0);
  });

  it("removeBlackboard 删除指定黑板条目", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput(room.roomId, "s1", "a1", "任务一");
    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.length, 1);
    assert.ok(rooms.removeBlackboard(room.roomId, board[0]!.id));
    assert.equal(rooms.getBlackboard(room.roomId).length, 0);
    assert.ok(!rooms.removeBlackboard(room.roomId, "missing"));
  });

  it("clearBlackboard 清空黑板", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput(room.roomId, "s1", "a1", "任务一");
    rooms.recordOutput(room.roomId, "s1", "a1", "任务二");
    assert.equal(rooms.getBlackboard(room.roomId).length, 2);
    assert.ok(rooms.clearBlackboard(room.roomId));
    assert.equal(rooms.getBlackboard(room.roomId).length, 0);
    assert.ok(!rooms.clearBlackboard(room.roomId));
  });

  it("clearArtifacts 清空文件产物，clearEvents 清空事件", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.addFile(room.roomId, { author: "s1", summary: "文件", path: "a.ts" });
    rooms.addEvent(room.roomId, { author: "s1", action: "command", summary: "笔记" });
    rooms.addEvent(room.roomId, { author: "s1", action: "test", summary: "测试" });
    assert.equal(rooms.clearArtifacts(room.roomId), 1);
    assert.equal(room.artifacts!.length, 0);
    assert.equal(room.events!.length, 2);
    assert.equal(rooms.clearEvents(room.roomId), 2);
    assert.equal(room.events!.length, 0);
  });

  it("deleteFile 删除房间允许路径内的文件，并清除 artifact path", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const rel = `hub/src/room-delete-${Date.now()}.txt`;
    const full = path.join(PROJECT_ROOT, rel);
    fs.writeFileSync(full, "delete me");
    rooms.addFile(room.roomId, { author: "s1", summary: "test", path: rel })!;
    try {
      assert.ok(rooms.deleteFile(room.roomId, rel));
      assert.ok(!fs.existsSync(full));
      assert.ok(!room.artifacts!.some((a) => a.path === rel));
      assert.ok(room.events!.some((e) => e.action === "delete" && e.path === rel));
      assert.throws(() => rooms.deleteFile(room.roomId, rel), /file not found/);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it("deleteFile 拒绝项目根目录外的文件", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    assert.throws(() => rooms.deleteFile(room.roomId, "/etc/passwd"), /outside project root/);
  });

  it("renameFile 重命名房间允许路径内的文件，并更新 artifact path", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const fromRel = `hub/src/room-rename-from-${Date.now()}.txt`;
    const toRel = `hub/src/room-rename-to-${Date.now()}.txt`;
    const fromFull = path.join(PROJECT_ROOT, fromRel);
    const toFull = path.join(PROJECT_ROOT, toRel);
    fs.writeFileSync(fromFull, "rename me");
    const artifact = rooms.addFile(room.roomId, { author: "a1", summary: "test", path: fromRel })!;
    try {
      assert.ok(rooms.renameFile(room.roomId, fromRel, toRel));
      assert.ok(!fs.existsSync(fromFull));
      assert.ok(fs.existsSync(toFull));
      assert.equal(artifact.path, toRel);
    } finally {
      fs.rmSync(fromFull, { force: true });
      fs.rmSync(toFull, { force: true });
    }
  });

  it("renameFile 拒绝目标路径越界", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const rel = `hub/src/room-rename-out-${Date.now()}.txt`;
    const full = path.join(PROJECT_ROOT, rel);
    fs.writeFileSync(full, "x");
    try {
      assert.throws(() => rooms.renameFile(room.roomId, rel, "../outside.txt"), /outside project root/);
    } finally {
      fs.rmSync(full, { force: true });
    }
  });

  it("sessionDeleteFile / sessionRenameFile 在 session cwd 内操作", () => {
    const rooms = new RoomManager();
    const cwd = path.join(WORKSPACE_ROOT, `session-file-op-${Date.now()}`);
    fs.mkdirSync(cwd, { recursive: true });
    rooms.setCwdResolver((sessionId) => (sessionId === "s1" ? cwd : undefined));
    const fromName = `from-${Date.now()}.txt`;
    const toName = `to-${Date.now()}.txt`;
    const fromFull = path.join(cwd, fromName);
    const toFull = path.join(cwd, toName);
    fs.writeFileSync(fromFull, "session");
    try {
      assert.ok(rooms.sessionRenameFile("s1", fromName, toName));
      assert.ok(!fs.existsSync(fromFull));
      assert.ok(fs.existsSync(toFull));
      assert.ok(rooms.sessionDeleteFile("s1", toName));
      assert.ok(!fs.existsSync(toFull));
      assert.throws(() => rooms.sessionDeleteFile("s1", toName), /file not found/);
    } finally {
      fs.rmSync(fromFull, { force: true });
      fs.rmSync(toFull, { force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("sessionDeleteFile 拒绝越界路径", () => {
    const rooms = new RoomManager();
    rooms.setCwdResolver((sessionId) => (sessionId === "s1" ? WORKSPACE_ROOT : undefined));
    assert.throws(() => rooms.sessionDeleteFile("s1", "/etc/passwd"), /outside project root/);
  });
});

describe("lostReplyAction", () => {
  const PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]";

  it("活跃编排未产出最终回复时不误报", () => {
    assert.equal(
      lostReplyAction({ kind: "user", text: "红" }, PLACEHOLDER, true),
      undefined,
    );
    // 占位符已在末尾同样不重复提示
    assert.equal(
      lostReplyAction({ kind: "assistant", text: PLACEHOLDER }, PLACEHOLDER, true),
      undefined,
    );
  });

  it("无活跃流程时保持原有判定", () => {
    // 上一条是用户消息且流程已结束 → 追加占位符并提示
    assert.equal(
      lostReplyAction({ kind: "user", text: "做X" }, PLACEHOLDER, false),
      "append",
    );
    // 占位符已在末尾 → 只提示不重复追加
    assert.equal(
      lostReplyAction({ kind: "assistant", text: PLACEHOLDER }, PLACEHOLDER, false),
      "repeat",
    );
    // 正常 assistant 回复 / 系统消息 / 空历史 → 不提示
    assert.equal(
      lostReplyAction({ kind: "assistant", text: "完成了" }, PLACEHOLDER, false),
      undefined,
    );
    assert.equal(
      lostReplyAction({ kind: "system", text: "通知" }, PLACEHOLDER, false),
      undefined,
    );
    assert.equal(lostReplyAction(undefined, PLACEHOLDER, false), undefined);
  });

  it("回复草稿在重启中断后保留为片段且幂等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const marker = "[Hub 重启中断了此回复；以上为已保存片段，未自动重试]";
    const genericMarker = "[回复中断；以上为已保存片段，未自动重试]";
    const stores: Store[] = [];
    try {
      const s1 = new Store(dir);
      stores.push(s1);
      const sessionDraft = s1.beginReplyDraft("session", "sess1", {
        at: 1,
        kind: "assistant",
        author: "bot",
        text: "片段一",
      });
      const roomDraft = s1.beginReplyDraft("room", "room1", {
        at: 1,
        kind: "assistant",
        author: "bot",
        text: "片段一",
      });
      const emptyDraft = s1.beginReplyDraft("room", "room2", {
        at: 1,
        kind: "assistant",
        author: "bot",
        text: "",
      });
      const errorDraft = s1.beginReplyDraft("session", "sessErr", {
        at: 1,
        kind: "assistant",
        author: "bot",
        text: "错误前片段",
      });
      s1.updateReplyDraft(sessionDraft, "片段一片段二");
      s1.updateReplyDraft(roomDraft, "片段一片段二");
      s1.close();
      stores.length = 0;

      const s2 = new Store(dir);
      stores.push(s2);
      const affected = s2.interruptReplyDrafts();
      assert.deepEqual(
        [...affected].sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`)),
        [
          { scope: "room", id: "room1" },
          { scope: "room", id: "room2" },
          { scope: "session", id: "sess1" },
          { scope: "session", id: "sessErr" },
        ],
      );

      const sess = s2.read("session", "sess1");
      assert.equal(sess.length, 1, "每个 scope 只保留一条片段历史");
      assert.equal(sess[0]!.id, sessionDraft, "片段复用草稿行 id");
      assert.equal(sess[0]!.text, `片段一片段二\n\n${marker}`);
      const room1 = s2.read("room", "room1");
      assert.equal(room1.length, 1);
      assert.equal(room1[0]!.text, `片段一片段二\n\n${marker}`);
      const room2 = s2.read("room", "room2");
      assert.equal(room2[0]!.text, marker, "空正文草稿只留中断标记");
      const sessErr = s2.read("session", "sessErr");
      assert.equal(sessErr[0]!.text, `错误前片段\n\n${marker}`);

      assert.deepEqual(s2.interruptReplyDrafts(), [], "重复中断不得重复追加");
      assert.equal(s2.read("session", "sess1")[0]!.text, `片段一片段二\n\n${marker}`);

      const doneDraft = s2.beginReplyDraft("session", "sess2", {
        at: 2,
        kind: "assistant",
        author: "bot",
        text: "中间片段",
      });
      s2.updateReplyDraft(doneDraft, "中间片段更多");
      s2.completeReplyDraft(doneDraft, "最终结果");
      s2.close();
      stores.length = 0;

      const s3 = new Store(dir);
      stores.push(s3);
      assert.deepEqual(s3.interruptReplyDrafts(), [], "已完成草稿不再标记中断");
      const final = s3.read("session", "sess2");
      assert.equal(final.length, 1);
      assert.equal(final[0]!.id, doneDraft, "完成后仍是同一行 id");
      assert.equal(final[0]!.text, "最终结果");

      const errDraft = s3.beginReplyDraft("session", "sess3", {
        at: 3,
        kind: "assistant",
        author: "bot",
        text: "断连前片段",
      });
      const errEmpty = s3.beginReplyDraft("session", "sess4", {
        at: 3,
        kind: "assistant",
        author: "bot",
        text: "",
      });
      s3.interruptReplyDraft(errDraft);
      s3.interruptReplyDraft(errEmpty);
      assert.equal(
        s3.read("session", "sess3")[0]!.text,
        `断连前片段\n\n${genericMarker}`,
        "运行期中断用通用标记并保留片段",
      );
      assert.equal(s3.read("session", "sess4")[0]!.text, genericMarker);
      s3.interruptReplyDraft(errDraft);
      assert.equal(
        s3.read("session", "sess3")[0]!.text,
        `断连前片段\n\n${genericMarker}`,
        "通用中断重复调用不追加两次",
      );
      s3.close();
      stores.length = 0;

      const closed = new Store(dir);
      closed.close();
      assert.equal(
        closed.beginReplyDraft("session", "x", { at: 0, kind: "assistant", author: "b", text: "t" }),
        -1,
        "关闭的 Store 上 begin 返回 -1",
      );
      assert.equal(
        closed.beginReplyDraft("session", "y", { at: 0, kind: "assistant", author: "b", text: "t" }),
        -1,
      );
    } finally {
      for (const s of stores) {
        try {
          s.close();
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("既有无 draft 列的 history 库经迁移后支持草稿且不丢旧记录", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const marker = "[Hub 重启中断了此回复；以上为已保存片段，未自动重试]";
    const stores: Store[] = [];
    try {
      const legacy = new Database(path.join(dir, "hub.db"));
      legacy.exec(
        `CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, scope_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL)`,
      );
      legacy
        .prepare(
          `INSERT INTO history(scope,scope_id,at,kind,author,text) VALUES ('session','legacy',1,'user','我','旧消息')`,
        )
        .run();
      legacy.close();

      const s1 = new Store(dir);
      stores.push(s1);
      const draftId = s1.beginReplyDraft("session", "legacy", {
        at: 2,
        kind: "assistant",
        author: "bot",
        text: "新片段",
      });
      assert.ok(draftId > 0);
      s1.close();
      stores.length = 0;

      const s2 = new Store(dir);
      stores.push(s2);
      const affected = s2.interruptReplyDrafts();
      assert.deepEqual(affected, [{ scope: "session", id: "legacy" }]);
      const entries = s2.read("session", "legacy");
      assert.equal(entries.length, 2);
      assert.equal(entries[0]!.kind, "user");
      assert.equal(entries[0]!.text, "旧消息");
      assert.equal(entries[0]!.id, 1);
      assert.equal(entries[1]!.id, draftId);
      assert.equal(entries[1]!.text, `新片段\n\n${marker}`);
      assert.equal(
        lostReplyAction(entries[1]!, PLACEHOLDER, false),
        undefined,
        "已有中断片段不再追加 LOST_REPLY_PLACEHOLDER",
      );
      s2.close();
      stores.length = 0;
    } finally {
      for (const s of stores) {
        try {
          s.close();
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readBefore 使用 (at,id) 元组边界，同毫秒条目不被截断丢失", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const at = 1000;
      // 三条同一毫秒写入的条目
      for (const text of ["a", "b", "c"]) {
        store.append("room", "r1", { at, kind: "assistant", author: "bot", text });
      }
      store.append("room", "r1", { at: 999, kind: "user", author: "我", text: "old" });
      // 窗口边界落在同毫秒簇中间：只取最新的 2 条（c、b）
      const window = store.read("room", "r1", 2);
      assert.deepEqual(window.map((e) => e.text), ["b", "c"]);
      // 旧行为 at < 1000 会永远跳过 "a"；带 beforeId 的元组比较能取回
      const page = store.readBefore("room", "r1", window[0]!.at, 50, window[0]!.id);
      assert.deepEqual(page.map((e) => e.text), ["old", "a"]);
      assert.equal(store.hasMoreBefore("room", "r1", window[0]!.at, window[0]!.id), true);
      // "a" 之后只剩 "old"
      assert.equal(store.hasMoreBefore("room", "r1", page[1]!.at, page[1]!.id), true);
      assert.equal(store.hasMoreBefore("room", "r1", page[0]!.at, page[0]!.id), false);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updateEntry 原位覆写 text，不改 id/at", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const at = 12345;
      const rowId = store.append("room", "r1", {
        at,
        kind: "flow",
        author: "",
        text: '{"flowId":"fl-1-1","phase":"working"}',
      });
      assert.ok(rowId > 0);
      store.updateEntry(rowId, '{"flowId":"fl-1-1","phase":"done"}');
      const entries = store.read("room", "r1");
      assert.equal(entries.length, 1, "原位更新不产生新行");
      assert.equal(entries[0]!.id, rowId);
      assert.equal(entries[0]!.at, at, "覆写不改 at 锚点");
      assert.equal(entries[0]!.kind, "flow");
      assert.equal(entries[0]!.text, '{"flowId":"fl-1-1","phase":"done"}');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("remapRoomModeConfig（room.clone fresh 会话重映射）", () => {
  it("全部会话引用按 idMap 换成新 sessionId，不携带旧 id", () => {
    const idMap = new Map([
      ["s1", "n1"],
      ["s2", "n2"],
      ["s3", "n3"],
    ]);
    const cfg = remapRoomModeConfig(
      {
        conductorId: "s1",
        parallelSummarizerId: "s2",
        pipelineOrder: ["s1", "s2", "s3"],
        debateSides: ["s1", "s3"],
        debateJudge: "s2",
        debateRounds: 3,
        memberRoles: { s1: "leader", s2: "coder" },
      },
      idMap,
    );
    assert.equal(cfg.conductorId, "n1");
    assert.equal(cfg.parallelSummarizerId, "n2");
    assert.deepEqual(cfg.pipelineOrder, ["n1", "n2", "n3"]);
    assert.deepEqual(cfg.debateSides, ["n1", "n3"]);
    assert.equal(cfg.debateJudge, "n2");
    assert.equal(cfg.debateRounds, 3);
    assert.deepEqual(cfg.memberRoles, { n1: "leader", n2: "coder" });
    const flat = JSON.stringify(cfg);
    for (const old of ["s1", "s2", "s3"]) {
      assert.ok(!flat.includes(`"${old}"`), `旧 sessionId ${old} 不得泄漏进新配置`);
    }
  });

  it("未映射成员引用丢弃而非残留旧 id", () => {
    const idMap = new Map([["s1", "n1"]]);
    const cfg = remapRoomModeConfig(
      {
        conductorId: "s9",
        pipelineOrder: ["s1", "s9"],
        debateSides: ["s1", "s9"],
        memberRoles: { s1: "a", s9: "b" },
      },
      idMap,
    );
    assert.equal(cfg.conductorId, undefined);
    assert.deepEqual(cfg.pipelineOrder, ["n1"]);
    assert.deepEqual(cfg.debateSides, ["n1"]);
    assert.deepEqual(cfg.memberRoles, { n1: "a" });
  });

  it("空配置返回全 undefined，不产生空对象残留", () => {
    const cfg = remapRoomModeConfig({}, new Map());
    assert.deepEqual(cfg, {
      conductorId: undefined,
      parallelSummarizerId: undefined,
      pipelineOrder: undefined,
      debateSides: undefined,
      debateJudge: undefined,
      debateRounds: undefined,
      maxRounds: undefined,
      relevanceFilter: undefined,
      memberRoles: undefined,
      aliases: undefined,
    });
  });
});

describe("nameTaken 归档名占坑", () => {
  it("连续两次归档同名：归档后名字释放可复用，取消归档恢复占用", () => {
    const rooms = new RoomManager();
    const r1 = rooms.create("team", [{ sessionId: "s1", name: "a" }]);
    assert.equal(rooms.nameTaken("team"), true);
    rooms.archive(r1.roomId, true);
    assert.equal(rooms.nameTaken("team"), false, "归档后原名释放");
    const r2 = rooms.create("team", [{ sessionId: "s2", name: "b" }]);
    rooms.archive(r2.roomId, true);
    assert.equal(rooms.nameTaken("team"), false, "第二次归档后同名仍可用");
    rooms.archive(r1.roomId, false);
    assert.equal(rooms.nameTaken("team"), true, "取消归档恢复占用");
    assert.equal(rooms.nameTaken("team", r1.roomId), false, "自身排除");
  });

  it("归档保留原名不改写；重名展示名自动加 (n) 后缀消歧", () => {
    const rooms = new RoomManager();
    const r1 = rooms.create("team", [{ sessionId: "s1", name: "a" }]);
    rooms.archive(r1.roomId, true);
    assert.equal(rooms.get(r1.roomId)!.name, "team", "归档不改名");
    // 归档名已释放 → 新建同名直接得到原名
    const taken = (n: string) => rooms.nameTaken(n);
    assert.equal(dedupeName("team", taken), "team");
    const r2 = rooms.create("team", [{ sessionId: "s2", name: "b" }]);
    assert.equal(dedupeName("team", taken), "team (2)", "占用时自动后缀");
    rooms.create("team (2)", [{ sessionId: "s3", name: "c" }]);
    assert.equal(dedupeName("team", taken), "team (3)", "递增直到空位");
    assert.equal(dedupeName("team", (n) => rooms.nameTaken(n, r2.roomId)), "team", "自身排除时原名可用");
  });
});

describe("route 集合别名", () => {
  const makeRoom = (rooms: RoomManager, aliases?: Record<string, string[]>) =>
    rooms.create(
      "team",
      [
        { sessionId: "s1", name: "alice" },
        { sessionId: "s2", name: "bob" },
        { sessionId: "s3", name: "carol" },
      ],
      "mention",
      aliases ? { aliases } : undefined,
    );

  it("@all 展开为全部成员", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms);
    const r = rooms.route(room.roomId, "@all 看一下");
    assert.deepEqual(r.mentioned, ["s1", "s2", "s3"]);
    assert.deepEqual(r.targets, ["s1", "s2", "s3"]);
  });

  it("@all 大小写不敏感，@全员 中文保留字同样生效", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms);
    for (const t of ["@ALL hi", "@All hi", "@全员 hi"]) {
      const r = rooms.route(room.roomId, t);
      assert.deepEqual(r.mentioned, ["s1", "s2", "s3"], t);
    }
    const noHit = rooms.route(room.roomId, "@allow hi");
    assert.deepEqual(noHit.mentioned, []);
  });

  it("自定义别名组命中子集，未展开成员不派发（SILENT 语义一致）", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms, { 后端组: ["s1", "s2"] });
    const r = rooms.route(room.roomId, "@后端组 评审一下");
    assert.deepEqual(r.mentioned, ["s1", "s2"]);
    assert.deepEqual(r.targets, ["s1", "s2"]);
  });

  it("别名优先于同名成员：成员名撞别名时只展开别名", () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "alice" },
        { sessionId: "s2", name: "bob" },
        { sessionId: "s3", name: "后端组" },
      ],
      "mention",
      { aliases: { 后端组: ["s1"] } },
    );
    const r = rooms.route(room.roomId, "@后端组 来");
    assert.deepEqual(r.mentioned, ["s1"], "成员『后端组』被别名遮蔽");
    assert.deepEqual(r.targets, ["s1"]);
  });

  it("保留字优先：成员名为 all 时 @all 仍展开全员（该成员无法被单独点名）", () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "s1", name: "all" },
        { sessionId: "s2", name: "bob" },
      ],
      "mention",
    );
    const r = rooms.route(room.roomId, "@all hi");
    assert.deepEqual(r.mentioned, ["s1", "s2"]);
  });

  it("别名值单层解析不递归，非成员 id 丢弃", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms, { a组: ["s1"], b组: ["a组", "s2", "s9"] });
    const r = rooms.route(room.roomId, "@b组 hi");
    assert.deepEqual(r.mentioned, ["s2"], "别名值里的别名不再展开，未知 id s9 丢弃");
  });

  it("别名命中 + 普通 @点名 可叠加", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms, { g: ["s1"] });
    const r = rooms.route(room.roomId, "@g @carol 一起");
    assert.deepEqual(r.mentioned, ["s1", "s3"]);
  });

  it("update 可设置/清空 aliases", () => {
    const rooms = new RoomManager();
    const room = makeRoom(rooms);
    const members = room.members.map((m) => ({ ...m }));
    rooms.update(room.roomId, "team", members, "mention", { aliases: { g: ["s1"] } });
    assert.deepEqual(rooms.get(room.roomId)!.aliases, { g: ["s1"] });
    assert.deepEqual(rooms.route(room.roomId, "@g x").targets, ["s1"]);
    rooms.update(room.roomId, "team", members, "mention", {});
    assert.equal(rooms.get(room.roomId)!.aliases, undefined);
    const r = rooms.route(room.roomId, "@g x");
    assert.deepEqual(r.mentioned, []);
  });
});

describe("parseAliasesParam / parseMemberRolesParam", () => {
  const members = new Set(["s1", "s2", "s3"]);

  it("aliases 解析：key 去 @ 前缀、值过滤非成员、空组丢弃", () => {
    const out = parseAliasesParam(
      { "@后端组": ["s1", "s2", "s9"], 空组: ["s9"], 非数组: "s1" },
      members,
    );
    assert.deepEqual(out, { 后端组: ["s1", "s2"] });
  });

  it("aliases 非对象/全无效时返回 undefined", () => {
    assert.equal(parseAliasesParam("x", members), undefined);
    assert.equal(parseAliasesParam(["a"], members), undefined);
    assert.equal(parseAliasesParam({ g: [] }, members), undefined);
    assert.equal(parseAliasesParam(undefined, members), undefined);
  });

  it("memberRoles 双格式：字符串直通，对象白名单清洗", () => {
    const out = parseMemberRolesParam(
      {
        s1: "  你是产品经理 ",
        s2: { persona: "后端", tone: "简洁", junk: 1, tone2: "x" },
        s9: "not-member",
        s3: "   ",
      },
      members,
    );
    assert.deepEqual(out, {
      s1: "你是产品经理",
      s2: { persona: "后端", tone: "简洁" },
    });
  });

  it("memberRoles 非法值报错：数字、数组、缺 persona 的对象", () => {
    assert.throws(() => parseMemberRolesParam({ s1: 42 }, members));
    assert.throws(() => parseMemberRolesParam({ s1: ["x"] }, members));
    assert.throws(() => parseMemberRolesParam({ s1: null }, members));
    assert.throws(() => parseMemberRolesParam({ s1: { tone: "x" } }, members));
  });
});

describe("PersonaCard", () => {
  it("normalizePersonaValue：字符串兜底为原文，对象按字段清洗", () => {
    assert.equal(normalizePersonaValue("  hi "), "hi");
    assert.deepEqual(
      normalizePersonaValue({ persona: "P", tone: "T", boundaries: "B", examples: "E", x: 1 }),
      { persona: "P", tone: "T", boundaries: "B", examples: "E" },
    );
  });

  it("serializePersonaCard：按 persona→风格→边界→示例 顺序拼接并带标签", () => {
    const text = serializePersonaCard({
      persona: "P",
      tone: "T",
      boundaries: "B",
      examples: "E",
    });
    assert.equal(text, "P\n风格: T\n边界: B\n示例: E");
  });

  it("serializePersonaCard：总长截断至 PERSONA_PROMPT_LIMIT", () => {
    const long = "x".repeat(700);
    const text = serializePersonaCard({ persona: long, tone: "T", examples: "E" });
    assert.ok(text.length <= PERSONA_PROMPT_LIMIT, `${text.length} <= ${PERSONA_PROMPT_LIMIT}`);
    assert.ok(!text.includes("示例"), "超出预算的后续段被整体丢弃");
    const head = serializePersonaCard({ persona: "P", tone: "y".repeat(700) });
    assert.ok(head.startsWith("P\n风格: "));
    assert.ok(head.length <= PERSONA_PROMPT_LIMIT);
  });

  it("buildPrompt 注入 PersonaCard 序列化结果", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: {
        s1: { persona: "你是后端", tone: "简洁", boundaries: "不碰前端", examples: "示例代码" },
      },
    });
    const prompt = rooms.buildPrompt(room.roomId, "干活", "s1");
    assert.ok(prompt.includes("你的角色设定：你是后端\n风格: 简洁\n边界: 不碰前端\n示例: 示例代码"));
  });

  it("memberRoles 对象形态随房间 JSON 序列化往返不丢", () => {
    const rooms = new RoomManager();
    const card = { persona: "P", tone: "T", boundaries: "B", examples: "E" };
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {
      memberRoles: { s1: card },
      aliases: { g: ["s1"] },
    });
    const revived = JSON.parse(JSON.stringify(room)) as Room;
    assert.deepEqual(revived.memberRoles, { s1: card });
    assert.deepEqual(revived.aliases, { g: ["s1"] });
    const rooms2 = new RoomManager();
    rooms2.import(revived);
    const prompt = rooms2.buildPrompt(room.roomId, "hi", "s1");
    assert.ok(prompt.includes("风格: T"));
    assert.deepEqual(rooms2.route(room.roomId, "@g x").targets, ["s1"]);
  });

  it("remapRoomModeConfig：memberRoles 对象保留、aliases 按 idMap 重映射", () => {
    const idMap = new Map([
      ["s1", "n1"],
      ["s2", "n2"],
    ]);
    const cfg = remapRoomModeConfig(
      {
        memberRoles: { s1: { persona: "P", tone: "T" }, s2: "plain", s9: "gone" },
        aliases: { g: ["s1", "s9"], 空: ["s9"] },
      },
      idMap,
    );
    assert.deepEqual(cfg.memberRoles, { n1: { persona: "P", tone: "T" }, n2: "plain" });
    assert.deepEqual(cfg.aliases, { g: ["n1"] }, "全失效的别名组丢弃");
  });
});

describe("openTopics 话题工作记忆", () => {
  it("openTopic/resolveTopic 保留 type/owner/status，resolve 不删条目", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    const topic = rooms.openTopic(room.roomId, "  接口选型待定  ", "s1")!;
    assert.equal(topic.type, "topic");
    assert.equal(topic.owner, "s1");
    assert.equal(topic.status, "open");
    assert.equal(topic.text, "接口选型待定");
    assert.equal(topic.from, "s1");
    assert.equal(topic.detail, "接口选型待定");

    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.length, 1);
    assert.equal(board[0]!.type, "topic");
    assert.equal(board[0]!.owner, "s1");

    assert.equal(rooms.resolveTopic(room.roomId, topic.id), true);
    const after = rooms.getBlackboard(room.roomId);
    assert.equal(after.length, 1, "resolve 不删条目");
    assert.equal(after[0]!.status, "resolved");
    assert.equal(rooms.resolveTopic(room.roomId, topic.id), false, "重复 resolve 幂等返回 false");
    assert.equal(rooms.resolveTopic(room.roomId, "missing"), false);
  });

  it("recordOutput 写 note；resolve 对 note 不生效；openTopics 只列 open topic", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput(room.roomId, "s1", "a1", "成员输出");
    const note = rooms.getBlackboard(room.roomId)[0]!;
    assert.equal(note.type, "note");
    assert.equal(rooms.resolveTopic(room.roomId, note.id), false, "note 不能被 resolve");

    rooms.openTopic(room.roomId, "话题一");
    const t2 = rooms.openTopic(room.roomId, "话题二", "user")!;
    rooms.resolveTopic(room.roomId, t2.id);
    const open = rooms.openTopics(room.roomId);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.text, "话题一");
  });

  it("成员 buildPrompt 黑板段只含 note，不泄漏 topic", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "a1" },
      { sessionId: "s2", name: "a2" },
    ]);
    rooms.recordOutput(room.roomId, "s2", "a2", "普通笔记");
    rooms.openTopic(room.roomId, "排期未确认", "user");
    const prompt = rooms.buildPrompt(room.roomId, "hi", "s1");
    assert.ok(prompt.includes("普通笔记"));
    assert.ok(!prompt.includes("排期未确认"), "topic 不进成员黑板段");
    assert.ok(!prompt.includes("未结话题"), "成员 prompt 无未结话题段");
  });

  it("黑板序列化与 room_events 回放均保留 type/owner/status", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-topics-"));
    const store = new Store(dir);
    try {
      const rooms = new RoomManager();
      rooms.setStore(store);
      const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
      const t1 = rooms.openTopic(room.roomId, "已结话题", "s1")!;
      rooms.openTopic(room.roomId, "未结话题", "user");
      rooms.resolveTopic(room.roomId, t1.id);

      // 1) 房间整体序列化往返
      const rooms2 = new RoomManager();
      rooms2.setStore(store);
      const snapshot = JSON.parse(JSON.stringify(room)) as Room;
      rooms2.import(snapshot);
      const b2 = rooms2.getBlackboard(room.roomId);
      assert.equal(b2.length, 2);
      assert.equal(b2[0]!.type, "topic");
      assert.equal(b2[0]!.owner, "s1");
      assert.equal(b2[0]!.status, "resolved");
      assert.equal(b2[1]!.status, "open");
      assert.equal(b2[1]!.owner, "user");

      // 2) 仅事件回放（清空内存黑板后由 room_events 重建）
      const rooms3 = new RoomManager();
      rooms3.setStore(store);
      const emptySnap = JSON.parse(JSON.stringify(room)) as Room;
      emptySnap.blackboard = [];
      emptySnap.eventSeq = 0;
      rooms3.import(emptySnap);
      const b3 = rooms3.getBlackboard(room.roomId);
      assert.deepEqual(
        b3.map((e) => ({ type: e.type, owner: e.owner, status: e.status, text: e.text })),
        [
          { type: "topic", owner: "s1", status: "resolved", text: "已结话题" },
          { type: "topic", owner: "user", status: "open", text: "未结话题" },
        ],
      );
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveTopicsSince 只归档时间窗内仍 open 的话题", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    const old = rooms.openTopic(room.roomId, "旧话题")!;
    old.at -= 60_000;
    const inWin = rooms.openTopic(room.roomId, "窗口内")!;
    const done = rooms.openTopic(room.roomId, "已结")!;
    rooms.resolveTopic(room.roomId, done.id);
    const start = Date.now() - 1_000;
    const end = Date.now() + 1_000;
    const n = rooms.resolveTopicsSince(room.roomId, start, end);
    assert.equal(n, 1);
    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.find((e) => e.id === old.id)!.status, "open", "窗口外不归档");
    assert.equal(board.find((e) => e.id === inWin.id)!.status, "resolved");
    assert.equal(board.find((e) => e.id === done.id)!.status, "resolved");
    assert.equal(rooms.resolveTopicsSince(room.roomId, start, end), 0, "幂等");
  });
});

  it("成员名分隔符消毒：addMember/updateMemberName 将 · 归一为 -", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }], "mention", {});
    rooms.addMember(room.roomId, "s2", "a·b·local");
    assert.equal(room.members.find((m) => m.sessionId === "s2")!.name, "a-b-local");
    rooms.updateMemberName("s2", "x·y");
    assert.equal(room.members.find((m) => m.sessionId === "s2")!.name, "x-y");
  });
