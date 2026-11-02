import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Store } from "./store.js";
import {
  MEMORY_LIMIT,
  MEMORY_PROMPT_LIMIT,
  MEMORY_TEXT_LIMIT,
  distillMemoryText,
} from "./memory.js";

function makeStore(t?: { after: (fn: () => void) => void }): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-mem-"));
  const store = new Store(dir);
  t?.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("memory: add/list 按房隔离、按 at 倒序", (t) => {
  const store = makeStore(t);
  const now = Date.now();
  store.memoryAdd("r1", "fact", "f1", "s1", now - 100, null);
  store.memoryAdd("r1", "decision", "d1", "s1", now, null);
  store.memoryAdd("r2", "fact", "other", "s2", now, null);
  const list = store.memoryList("r1", now);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.kind, "decision");
  assert.equal(list[0]!.text, "d1");
  assert.equal(list[0]!.source, "s1");
  assert.equal(store.memoryList("r2", now).length, 1);
});

test("memory: expires_at 过期条目被过滤且插入时清理", (t) => {
  const store = makeStore(t);
  const now = Date.now();
  store.memoryAdd("r1", "fact", "stale", "s1", now - 1000, now - 1);
  store.memoryAdd("r1", "fact", "fresh", "s1", now, now + 1000);
  const list = store.memoryList("r1", now);
  assert.deepEqual(list.map((m) => m.text), ["fresh"]);
});

test("memory: 容量上限——超限淘汰最旧条目", (t) => {
  const store = makeStore(t);
  const now = Date.now();
  for (let i = 0; i < MEMORY_LIMIT + 5; i++) {
    store.memoryAdd("r1", "fact", `m${i}`, "s1", now + i, null);
  }
  const list = store.memoryList("r1", now + 99999);
  assert.equal(list.length, MEMORY_LIMIT);
  // 最旧的 m0-m4 被淘汰，最新在最前
  assert.equal(list[0]!.text, `m${MEMORY_LIMIT + 4}`);
  assert.equal(list.at(-1)!.text, "m5");
});

test("memory: deleteMemory 随房删除清空", (t) => {
  const store = makeStore(t);
  store.memoryAdd("r1", "decision", "x", "s1", Date.now(), null);
  store.memoryAdd("r2", "decision", "y", "s1", Date.now(), null);
  store.deleteMemory("r1");
  assert.equal(store.memoryList("r1", Date.now()).length, 0);
  assert.equal(store.memoryList("r2", Date.now()).length, 1);
});

test("distillMemoryText: 跳过围栏/JSON 取首个人话行，超长截断", () => {
  assert.equal(distillMemoryText("```json\n{}\n```\n完成了三件事"), "完成了三件事");
  assert.equal(distillMemoryText("{}\n结论：采用方案B"), "结论：采用方案B");
  const long = "x".repeat(MEMORY_TEXT_LIMIT + 10);
  assert.equal(distillMemoryText(long).length, MEMORY_TEXT_LIMIT + 1); // +省略号
  assert.equal(distillMemoryText("   \n  \n", 10), "");
  assert.ok(MEMORY_PROMPT_LIMIT <= MEMORY_LIMIT);
});
