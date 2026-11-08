import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-hs-"));
  const store = new Store(dir);
  store.append("room", "r1", { at: 1000, kind: "user", author: "我", text: "登录接口报 500" });
  store.append("room", "r1", { at: 2000, kind: "assistant", author: "devin", text: "排查后定位是超时 BUG" });
  store.append("room", "r1", { at: 3000, kind: "user", author: "我", text: "今天天气不错" });
  store.append("room", "r1", { at: 4000, kind: "assistant", author: "claude", text: "修复了登录 bug" });
  return { store, dir };
}

test("search：关键词大小写不敏感命中", () => {
  const { store } = mk();
  const r = store.searchHistory("room", "r1", { query: "bug" });
  assert.equal(r.length, 2); // "超时 BUG" + "登录 bug"
  assert.ok(r.every((e) => e.text.toLowerCase().includes("bug")));
  assert.equal(r[0]!.at, 4000); // at 倒序
});

test("search：作者+时间窗过滤", () => {
  const { store } = mk();
  assert.equal(store.searchHistory("room", "r1", { author: "devin" }).length, 1);
  assert.equal(store.searchHistory("room", "r1", { fromAt: 2000, toAt: 3000 }).length, 2);
  assert.equal(store.searchHistory("room", "r1", { query: "登录", author: "我" }).length, 1);
});

test("search：beforeId 游标分页 + limit 上限", () => {
  const { store } = mk();
  const page1 = store.searchHistory("room", "r1", { limit: 2 });
  assert.equal(page1.length, 2);
  const page2 = store.searchHistory("room", "r1", { limit: 2, beforeId: page1[1]!.id });
  assert.equal(page2.length, 2);
  assert.ok(page2.every((e) => e.id < page1[1]!.id));
  // limit 夹紧：100 → 50
  assert.equal(store.searchHistory("room", "r1", { limit: 100 }).length, 4);
});

test("search：无匹配/草稿排除", () => {
  const { store } = mk();
  assert.equal(store.searchHistory("room", "r1", { query: "不存在的词" }).length, 0);
  assert.equal(store.searchHistory("room", "rx", {}).length, 0); // 隔离
});

test("search：FTS5 英文词命中 + CJK 无 token 回退 LIKE", () => {
  const { store } = mk();
  // FTS 可用时英文词走 MATCH（大小写折叠）；不可用时 LIKE 兜底——两路结果一致
  assert.equal(store.searchHistory("room", "r1", { query: "BUG" }).length, 2);
  // CJK 串 unicode61 不拆 token → MATCH 零命中 → 回退 LIKE
  assert.equal(store.searchHistory("room", "r1", { query: "登录" }).length, 2);
  assert.equal(store.searchHistory("room", "r1", { query: "登录", author: "我" }).length, 1);
  // 混合短语：FTS 短语不命中 → LIKE 连续子串命中
  assert.equal(store.searchHistory("room", "r1", { query: "登录 bug" }).length, 1);
});

test("search：store.search / searchByScope / searchGroups FTS+回退一致", () => {
  const { store } = mk();
  assert.equal(store.search("超时", 10).length, 1); // CJK 回退 LIKE
  assert.equal(store.search("BUG", 10).length, 2);
  assert.equal(store.searchByScope("登录", "room", "r1", 10).length, 2);
  assert.equal(store.searchByScope("超时", "room", "rx", 10).length, 0); // scope 隔离
  const groups = store.searchGroups("bug", 10, 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.scopeId, "r1");
  assert.equal(groups[0]!.count, 2);
});
