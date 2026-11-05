import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Store } from "./store.js";
import { RoomManager } from "./room.js";
import {
  MEMORY_LIMIT,
  MEMORY_PROMPT_LIMIT,
  MEMORY_TEXT_LIMIT,
  distillMemoryText,
  isMemoryNearDup,
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

test("memoryAdd: 同 room+kind+text 重复写入原位刷新不堆积", (t) => {
  const store = makeStore(t);
  store.memoryAdd("r1", "decision", "结论A", "s1", 1000, null);
  store.memoryAdd("r1", "decision", "结论A", "s2", 2000, null);
  const list = store.memoryList("r1", Date.now());
  assert.equal(list.length, 1, "同文本不重复入库");
  assert.equal(list[0]!.at, 2000, "刷新为最新时间戳");
  assert.equal(list[0]!.source, "s2", "刷新为最新来源");
  // 不同 kind/不同文本正常插入
  store.memoryAdd("r1", "fact", "结论A", "s1", 3000, null);
  store.memoryAdd("r1", "decision", "结论B", "s1", 3001, null);
  assert.equal(store.memoryList("r1", Date.now()).length, 3);
});

test("memoryRemove: 单条删除限房作用域", (t) => {
  const store = makeStore(t);
  store.memoryAdd("r1", "decision", "x", "s1", Date.now(), null);
  store.memoryAdd("r1", "fact", "y", "s1", Date.now(), null);
  const [y, x] = store.memoryList("r1", Date.now());
  assert.equal(store.memoryRemove("r1", y!.id), true);
  assert.equal(store.memoryList("r1", Date.now()).length, 1);
  // 跨房 id 不误删、重复删除返回 false
  assert.equal(store.memoryRemove("r2", x!.id), false);
  assert.equal(store.memoryRemove("r1", y!.id), false);
});

test("distillMemoryText: 跳过围栏/JSON 取首个人话行，超长截断", () => {
  assert.equal(distillMemoryText("```json\n{}\n```\n完成了三件事"), "完成了三件事");
  assert.equal(distillMemoryText("{}\n结论：采用方案B"), "结论：采用方案B");
  // markdown 标题/表格行跳过，取首个信息量行
  assert.equal(
    distillMemoryText("## 结论\n\n| a | b |\n已修复重复消息问题"),
    "已修复重复消息问题",
  );
  assert.equal(distillMemoryText("# Summary\n- 决定采用方案 A"), "- 决定采用方案 A");
  const long = "x".repeat(MEMORY_TEXT_LIMIT + 10);
  assert.equal(distillMemoryText(long).length, MEMORY_TEXT_LIMIT + 1); // +省略号
  assert.equal(distillMemoryText("   \n  \n", 10), "");
  assert.ok(MEMORY_PROMPT_LIMIT <= MEMORY_LIMIT);
});

test("isMemoryNearDup: 全等/前缀变体/长公共前缀命中，短文本不误并", () => {
  assert.equal(isMemoryNearDup("采用方案A", "采用方案a"), true);
  assert.equal(isMemoryNearDup("决定：本周五发版，不再延期。", "决定本周五发版不再延期"), true);
  // 截断/扩写互为前缀
  const base = "修复了任务编排列表大空白问题，根因是 CRLF 空行未被折叠";
  assert.equal(isMemoryNearDup(base, `${base}，已验证三形态`), true);
  // 长公共前缀 ≥80%
  const a = "工单系统现已支持创建、启动、停止、验收与删除全生命周期管理";
  const b = "工单系统现已支持创建、启动、停止、验收与删除全生命周期的管理操作";
  assert.equal(isMemoryNearDup(a, b), true);
  // 短文本近似措辞不合并
  assert.equal(isMemoryNearDup("修复了A问题", "修复了B问题"), false);
  // 语义不同
  assert.equal(
    isMemoryNearDup("用户偏好中文回复", "目标工单需要交互式确认才能创建"),
    false,
  );
});

test("recordMemory: 近重复写入不堆积，刷新既有条目 TTL/来源", (t) => {
  const store = makeStore(t);
  const rooms = new RoomManager();
  rooms.setStore(store);
  const room = rooms.create("memdup", [{ sessionId: "s1", name: "a1" }]);
  const now = Date.now();

  rooms.recordMemory(room.roomId, "fact", "决定本周五发版，不再延期", "flow:x");
  rooms.recordMemory(room.roomId, "fact", "决定：本周五发版，不再延期。", "flow:y");
  const list = store.memoryList(room.roomId, now);
  assert.equal(list.length, 1, "近重复应合并而非新增");
  assert.equal(list[0]!.text, "决定本周五发版，不再延期");
  assert.equal(list[0]!.source, "flow:y", "来源应刷新为最近写入");

  // 非重复条目正常新增
  rooms.recordMemory(room.roomId, "decision", "附件白名单放开文本与 PDF", "flow:z");
  assert.equal(store.memoryList(room.roomId, now).length, 2);
});

test("清残留：脚手架长前缀+尾部分叉大→不误并", () => {
  const a = "flow「修复登录页样式异常」完成：已修复 CSS 层叠问题，验证通过";
  const b = "flow「修复登录页样式异常」完成：新增响应式断点，已回归";
  assert.equal(isMemoryNearDup(a, b), false, "尾部分叉 25+ 不得误并");
});

test("清残留：修正型扩展新文本被合并保留（recordMemory 集成）", (t) => {
  const store = makeStore(t);
  const rooms = new RoomManager();
  rooms.setStore(store);
  const room = rooms.create("team", [{ sessionId: "s1", name: "a1" }]);
  rooms.recordMemory(room.roomId, "decision", "修复了 banner 分色", "s1");
  rooms.recordMemory(room.roomId, "decision", "修复了 banner 分色并加了点击行为", "s1");
  const mems = rooms.memoryForPrompt(room.roomId);
  assert.equal(mems.length, 1, "扩展合并为一条");
  assert.equal(mems[0]!.text, "修复了 banner 分色并加了点击行为", "保留信息更长的新文本");
});
