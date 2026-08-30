import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionLedger } from "./session-ledger.js";
import type { SessionMeta } from "./store.js";

describe("session-ledger", () => {
  it("addFile 同 path upsert，alias 使用独立 s 前缀", () => {
    const ledger = new SessionLedger();
    const first = ledger.addFile("s1", { author: "s1", summary: "初版", path: "src/a.ts" });
    const second = ledger.addFile("s1", { author: "s1", summary: "改过", path: "src/a.ts" });
    assert.equal(first.alias, "s1");
    assert.equal(second.id, first.id);
    assert.equal(second.summary, "改过");
    assert.equal(ledger.getArtifacts("s1").length, 1);
  });

  it("addFile 更新已有产物时移到末尾，保证 getArtifacts 时间倒序", () => {
    const ledger = new SessionLedger();
    ledger.addFile("s1", { author: "s1", summary: "a", path: "a.ts" });
    ledger.addFile("s1", { author: "s1", summary: "b", path: "b.ts" });
    ledger.addFile("s1", { author: "s1", summary: "a2", path: "a.ts" });
    const all = ledger.getArtifacts("s1");
    assert.equal(all[0]!.path, "a.ts");
    assert.equal(all[1]!.path, "b.ts");
  });

  it("addEvent 保持 append-only", () => {
    const ledger = new SessionLedger();
    ledger.addEvent("s1", { author: "s1", action: "command", summary: "tsc" });
    ledger.addEvent("s1", { author: "s1", action: "test", summary: "npm test" });
    assert.equal(ledger.getEvents("s1").length, 2);
  });

  it("addFileEvent 修正 5 秒内同路径的 tool_call modify 事件，不产生重复", () => {
    const ledger = new SessionLedger();
    // tool_call edit 先到，记录为 modify
    ledger.addEvent("s1", { author: "s1", action: "modify", summary: "Wrote a.ts", path: "a.ts" });
    // fs 通道随后用准确 existed 信息修正为 add
    ledger.addFileEvent("s1", { author: "s1", action: "add", summary: "新增", path: "a.ts" });
    const events = ledger.getEvents("s1");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, "add");
    // 无前置 tool_call 事件时直接新增
    ledger.addFileEvent("s1", { author: "s1", action: "modify", summary: "修改", path: "b.ts" });
    assert.equal(ledger.getEvents("s1").length, 2);
  });

  it("captureOutput 写入文件与事件，不接受未知 action", () => {
    const ledger = new SessionLedger();
    ledger.captureOutput("s1", [
      { type: "file", path: "src/a.ts", summary: "改文件" },
      { type: "event", action: "command", summary: "npx tsc --noEmit" },
      { type: "event", action: "note", summary: "忽略" },
    ]);
    assert.equal(ledger.getArtifacts("s1").length, 1);
    assert.equal(ledger.getEvents("s1").length, 1);
    assert.equal(ledger.getEvents("s1")[0]!.action, "command");
  });

  it("recordDelete / recordRename 只动 session 账本", () => {
    const ledger = new SessionLedger();
    ledger.addFile("s1", { author: "s1", summary: "a", path: "a.ts" });
    ledger.recordRename("s1", "a.ts", "b.ts");
    assert.equal(ledger.getArtifacts("s1")[0]!.path, "b.ts");
    ledger.recordDelete("s1", "b.ts");
    assert.equal(ledger.getArtifacts("s1").length, 0);
    const events = ledger.getEvents("s1");
    assert.equal(events.length, 2);
    assert.equal(events[0]!.action, "delete");
    assert.equal(events[1]!.action, "rename");
  });

  it("importFromMeta / attachTo 往返，且不共用房间 a 前缀", () => {
    const ledger = new SessionLedger();
    ledger.addFile("s1", { author: "s1", summary: "文件", path: "a.ts" });
    const metas: SessionMeta[] = [{
      sessionId: "s1",
      cwd: "/tmp",
      name: "devin",
      agent: "devin",
      artifacts: ledger.getArtifacts("s1"),
      events: [],
    }];
    const next = new SessionLedger();
    next.importFromMeta(metas);
    const attached = next.attachTo([{ sessionId: "s1", cwd: "/tmp", name: "devin", agent: "devin" }]);
    assert.equal(attached[0]!.artifacts![0]!.alias, "s1");
    assert.equal(attached[0]!.artifacts![0]!.path, "a.ts");
  });

  it("不同 session 账本互不影响", () => {
    const ledger = new SessionLedger();
    ledger.addFile("s1", { author: "s1", summary: "s1 文件", path: "a.ts" });
    ledger.addFile("s2", { author: "s2", summary: "s2 文件", path: "a.ts" });
    assert.equal(ledger.getArtifacts("s1")[0]!.author, "s1");
    assert.equal(ledger.getArtifacts("s2")[0]!.author, "s2");
    ledger.drop("s1");
    assert.equal(ledger.getArtifacts("s1").length, 0);
    assert.equal(ledger.getArtifacts("s2").length, 1);
  });
});
