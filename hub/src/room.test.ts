import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { RoomManager, type Room } from "./room.js";

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
    rooms.recordOutput("s1", "a1", "完成了任务");
    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.length, 1);
    assert.ok(board[0]!.id);
    assert.equal(board[0]!.from, "a1");
    assert.equal(board[0]!.text, "完成了任务");
    assert.equal(board[0]!.detail, "完成了任务");
  });

  it("removeBlackboard 删除指定黑板条目", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput("s1", "a1", "任务一");
    const board = rooms.getBlackboard(room.roomId);
    assert.equal(board.length, 1);
    assert.ok(rooms.removeBlackboard(room.roomId, board[0]!.id));
    assert.equal(rooms.getBlackboard(room.roomId).length, 0);
    assert.ok(!rooms.removeBlackboard(room.roomId, "missing"));
  });

  it("clearBlackboard 清空黑板", () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
    rooms.recordOutput("s1", "a1", "任务一");
    rooms.recordOutput("s1", "a1", "任务二");
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
