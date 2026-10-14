import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TurnProcessRecorder } from "./process-log.js";
import { Store } from "./store.js";

describe("TurnProcessRecorder", () => {
  it("thought chunk 合并为单条，tool_call 按 toolCallId 更新，plan 保留快照", () => {
    const rec = new TurnProcessRecorder();
    rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } }, "bot");
    rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "一想" } }, "bot");
    rec.record("s1", {
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "读文件",
      status: "in_progress",
      kind: "read",
    }, "bot");
    rec.record("s1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
    }, "bot");
    rec.record("s1", {
      sessionUpdate: "plan",
      entries: [{ status: "in_progress", content: "步骤1" }],
    }, "bot");

    const items = rec.take("s1");
    assert.equal(items.length, 3);
    assert.equal(items[0]!.kind, "thought");
    assert.equal(items[0]!.text, "想一想");
    assert.equal(items[0]!.author, "bot");
    assert.equal(items[1]!.kind, "tool");
    assert.equal(items[1]!.toolCallId, "tc1");
    const toolData = JSON.parse(items[1]!.text) as Record<string, unknown>;
    assert.equal(toolData.status, "completed");
    assert.equal(toolData.title, "读文件");
    assert.equal(items[2]!.kind, "plan");
    const planData = JSON.parse(items[2]!.text) as { entries: string[] };
    assert.deepEqual(planData.entries, ["[in_progress] 步骤1"]);
    assert.equal(rec.take("s1").length, 0, "take 后缓冲区被清空");
  });

  it("忽略非过程类型 update，tool_call_update 无前置 tool_call 时也记录", () => {
    const rec = new TurnProcessRecorder();
    rec.record("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, "bot");
    rec.record("s1", { sessionUpdate: "usage_update", used: 1, size: 2 }, "bot");
    assert.equal(rec.take("s1").length, 0);

    rec.record("s1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc9",
      status: "completed",
      title: "执行命令",
    }, "bot");
    const items = rec.take("s1");
    assert.equal(items.length, 1);
    const data = JSON.parse(items[0]!.text) as Record<string, unknown>;
    assert.equal(data.status, "completed");
    assert.equal(data.title, "执行命令");
  });

  it("不同 session 的过程消息互相隔离", () => {
    const rec = new TurnProcessRecorder();
    rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "a" } }, "bot");
    rec.record("s2", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "b" } }, "bot2");
    assert.equal(rec.take("s1")[0]!.text, "a");
    assert.equal(rec.take("s2")[0]!.text, "b");
  });
});

describe("process history persistence", () => {
  it("过程消息写入 history 后可按序恢复", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const rec = new TurnProcessRecorder();
      rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "分析" } }, "bot");
      rec.record("s1", {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "编辑 x.ts",
        status: "completed",
        kind: "edit",
      }, "bot");
      for (const item of rec.take("s1")) {
        store.append("session", "s1", { at: item.at, kind: item.kind, author: item.author, text: item.text });
      }
      store.append("session", "s1", { at: Date.now(), kind: "assistant", author: "bot", text: "完成" });

      const entries = store.read("session", "s1");
      assert.deepEqual(entries.map((e) => e.kind), ["thought", "tool", "assistant"]);
      assert.equal(entries[0]!.text, "分析");
      const toolData = JSON.parse(entries[1]!.text) as Record<string, unknown>;
      assert.equal(toolData.toolCallId, "t1");
      assert.equal(toolData.status, "completed");
      assert.equal(entries[2]!.text, "完成");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("error kind 可写入并读回", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      store.append("session", "s1", { at: 1, kind: "error", author: "bot", text: "boom" });
      const entries = store.read("session", "s1");
      assert.equal(entries[0]!.kind, "error");
      assert.equal(entries[0]!.text, "boom");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assistant 草稿完成时 at 更新为完成时刻，排在过程消息之后", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const draft = store.beginReplyDraft("session", "s1", {
        at: 1,
        kind: "assistant",
        author: "bot",
        text: "片段",
      });
      store.append("session", "s1", { at: 2, kind: "thought", author: "bot", text: "想" });
      store.completeReplyDraft(draft, "完成");
      const entries = store.read("session", "s1");
      assert.equal(entries[0]!.kind, "thought");
      assert.equal(entries[1]!.kind, "assistant");
      assert.ok(entries[1]!.at > 2, "草稿完成后 at 为完成时刻");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
