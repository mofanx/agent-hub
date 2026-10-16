import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildProcessMeta, TurnProcessRecorder, type ProcessCardMeta } from "./process-log.js";
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

  it("缓冲区超过上限时丢弃最旧，仅保留最近 50 条", () => {
    const rec = new TurnProcessRecorder();
    for (let i = 1; i <= 60; i++) {
      rec.record("s1", {
        sessionUpdate: "tool_call",
        toolCallId: `tc${i}`,
        title: `step ${i}`,
        status: "completed",
      }, "bot");
    }
    const items = rec.take("s1");
    assert.equal(items.length, 50);
    assert.equal(items[0]!.toolCallId, "tc11", "最旧的 10 条被截断");
    assert.equal(items.at(-1)!.toolCallId, "tc60");
  });

  it("peek 返回当前缓冲但不消费，可供 running 任务钻取", () => {
    const rec = new TurnProcessRecorder();
    rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } }, "bot");
    rec.record("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "改文件" }, "bot");
    const first = rec.peek("s1");
    assert.equal(first.length, 2);
    assert.equal(rec.peek("s1").length, 2, "peek 不消费缓冲区");
    first.push({ at: 0, kind: "thought", author: "x", text: "污染" });
    assert.equal(rec.peek("s1").length, 2, "peek 返回副本，外部修改不污染内部");
    assert.equal(rec.take("s1").length, 2);
    assert.equal(rec.peek("s1").length, 0, "take 后缓冲区清空");
  });

  it("buildProcessMeta 聚合 buf 为单条过程卡 meta，processId 稳定", () => {
    const rec = new TurnProcessRecorder();
    rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "分析中" } }, "coder");
    rec.record("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "编辑 x.ts", status: "completed" }, "coder");
    const buf = rec.take("s1");
    const meta = buildProcessMeta("room1", "s1", buf, "t7", "done");
    assert.equal(meta.sessionId, "s1");
    assert.equal(meta.turnStartAt, buf[0]!.at);
    assert.equal(meta.status, "done");
    assert.equal(meta.taskId, "t7");
    assert.equal(meta.steps.length, 2);
    assert.deepEqual(meta.steps.map((s) => s.kind), ["thought", "tool"]);
    assert.equal(meta.steps[0]!.text, "分析中");
    assert.equal(meta.steps[1]!.title, "编辑 x.ts");
    const meta2 = buildProcessMeta("room1", "s1", buf, "t7", "done");
    assert.equal(meta2.processId, meta.processId, "同 room/session/turnStartAt 的 processId 稳定");
    const meta3 = buildProcessMeta("room2", "s1", buf, undefined, "interrupted");
    assert.notEqual(meta3.processId, meta.processId);
    assert.equal(meta3.taskId, undefined);
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

  it("回合 flush：session 保留全部过程项，room 历史仅一条 process 聚合卡", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const rec = new TurnProcessRecorder();
      rec.record("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } }, "coder");
      rec.record("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "改文件", status: "completed" }, "coder");
      rec.record("s1", { sessionUpdate: "plan", entries: [{ status: "in_progress", content: "步骤" }] }, "coder");
      const buf = rec.take("s1");
      // 与 index.ts flushTurnProcess 相同的写入序列
      for (const item of buf) {
        store.append("session", "s1", { at: item.at, kind: item.kind, author: item.author, text: item.text });
      }
      const meta = buildProcessMeta("room1", "s1", buf, "t1", "done");
      const at = buf[buf.length - 1]!.at;
      const id = store.append("room", "room1", { at, kind: "process", author: "coder", text: JSON.stringify(meta) });
      assert.ok(id > 0, "append 返回行号供广播携带");

      const roomEntries = store.read("room", "room1");
      assert.equal(roomEntries.length, 1, "room 历史仅一条聚合卡");
      assert.equal(roomEntries[0]!.kind, "process");
      const parsed = JSON.parse(roomEntries[0]!.text) as ProcessCardMeta;
      assert.equal(parsed.steps.length, 3);
      assert.equal(parsed.taskId, "t1");
      assert.equal(parsed.status, "done");
      assert.ok(
        !roomEntries.some((e) => e.kind === "thought" || e.kind === "tool" || e.kind === "plan"),
        "房史不出现 worker 散装过程项",
      );

      const sessionEntries = store.read("session", "s1");
      assert.deepEqual(sessionEntries.map((e) => e.kind), ["thought", "tool", "plan"], "session 保留全部明细");
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("过程卡锚定最后过程事件时刻：延迟 flush 也不排在结论之后", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      const buf = [
        { at: 100, kind: "thought" as const, author: "bot", text: "想" },
        { at: 200, kind: "tool" as const, author: "bot", text: "工具" },
      ];
      const meta = buildProcessMeta("room1", "s1", buf, "t1", "done");
      assert.equal(meta.turnStartAt, 100);
      assert.equal(meta.turnEndAt, 200, "turnEndAt 锚定最后过程事件而非落库时刻");
      // 结论以完成时刻先落库（at=300），过程卡延迟 flush 后落库但 at 仍为事件时刻
      store.append("room", "room1", { at: 300, kind: "assistant", author: "bot", text: "结论" });
      const cardAt = buf[buf.length - 1]!.at; // 与 flushTurnProcess 相同的锚点取法
      store.append("room", "room1", { at: cardAt, kind: "process", author: "bot", text: JSON.stringify(meta) });
      const entries = store.read("room", "room1");
      assert.deepEqual(
        entries.map((e) => e.kind),
        ["process", "assistant"],
        "过程卡 at ≤ 结论 at，按 at 升序排在结论之前",
      );
      assert.ok(entries[0]!.at <= entries[1]!.at);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readAfter 返回下界（含）之后的条目，用于任务时间窗钻取", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-store-"));
    const store = new Store(dir);
    try {
      store.append("session", "s1", { at: 100, kind: "assistant", author: "bot", text: "旧" });
      store.append("session", "s1", { at: 200, kind: "thought", author: "bot", text: "窗内1" });
      store.append("session", "s1", { at: 300, kind: "tool", author: "bot", text: "窗内2" });
      const entries = store.readAfter("session", "s1", 200);
      assert.deepEqual(entries.map((e) => e.at), [200, 300], "含下界、按时间升序");
      assert.equal(store.readAfter("session", "s1", 400).length, 0);
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
