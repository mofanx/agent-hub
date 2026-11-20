import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { Store } from "./store.js";

const requireDesktop = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = requireDesktop(requireDesktop.resolve("typescript")) as {
  transpileModule: (src: string, opts: unknown) => { outputText: string };
  ScriptTarget: { ES2020: unknown };
  ModuleKind: { CommonJS: unknown };
};

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-ho-"));
  return { store: new Store(dir), dir };
}

test("并发 draft 定稿：过程卡在 (at,id) 序下稳排结论之前", () => {
  const { store } = mk();
  const roomId = "r1";
  // 两个并发回合：A 的草稿行先落（id 小），B 后落
  const a = store.beginReplyDraft("room", roomId, {
    at: 1000, kind: "assistant", author: "A", text: "a-reply-part",
  });
  const b = store.beginReplyDraft("room", roomId, {
    at: 1000, kind: "assistant", author: "B", text: "b-reply-part",
  });
  // 回合期间落过程卡：flush 时刻落库，at >= 草稿 at
  const p1 = store.append("room", roomId, {
    at: 2000, kind: "process", author: "A", text: "{\"processId\":\"p1\"}",
  });
  const p2 = store.append("room", roomId, {
    at: 3000, kind: "process", author: "B", text: "{\"processId\":\"p2\"}",
  });
  // B 先完成，A 后完成：atFloor 语义 = maxAt+1
  const floorB = store.maxHistoryAt("room", roomId) + 1;
  store.completeReplyDraft(b, "b-reply-final", floorB);
  const floorA = store.maxHistoryAt("room", roomId) + 1;
  store.completeReplyDraft(a, "a-reply-final", floorA);

  const rows = store.read("room", roomId, 50);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // 定稿 at 严格大于同回合已落库条目：过程卡在结论之前
  assert.ok(byId.get(b)!.at > byId.get(p2)!.at);
  assert.ok(byId.get(a)!.at > byId.get(p2)!.at);
  assert.ok(byId.get(a)!.at > byId.get(b)!.at);
  // 展示序（at 升序）：过程卡簇在前，两条结论在尾部按完成先后排
  assert.deepEqual(rows.map((r) => r.id), [p1, p2, b, a]);
  // 结论行 id（回合开始位）< 过程卡 id，但 at 更大——排序键必须是 (at,id) 而非 id
  assert.ok(a < p1 && byId.get(a)!.at > byId.get(p1)!.at);
});

test("draft 行：beginReplyDraft 标记 draft=1 且 at 为回合开始锚", () => {
  const { store } = mk();
  const id = store.beginReplyDraft("session", "s1", {
    at: 1000, kind: "assistant", author: "A", text: "partial",
  });
  const rows = store.read("session", "s1", 50);
  const row = rows.find((r) => r.id === id);
  assert.ok(row);
  assert.equal(row.draft, 1);
  assert.equal(row.at, 1000);
  // updateReplyDraft 不动 at/draft
  store.updateReplyDraft(id, "partial-more");
  assert.equal(store.entry(id)!.at, 1000);
  assert.equal(store.entry(id)!.draft, 1);
  // 定稿后 draft=0 且 at 抬升（实现取 max(now, minAt)，断言不早于下限与开始锚）
  store.completeReplyDraft(id, "final", 5000);
  assert.equal(store.entry(id)!.draft, 0);
  assert.ok(store.entry(id)!.at >= 5000);
  assert.ok(store.entry(id)!.at > 1000);
  assert.equal(store.entry(id)!.text, "final");
});

test("entryAt/entry：广播信封 at 必须与钳制后的存储 at 一致", () => {
  const { store } = mk();
  // 先落一条 at=5000 的条目，再以更早的语义锚 append——存储侧钳到 5000
  store.append("room", "r1", { at: 5000, kind: "user", author: "我", text: "m1" });
  const id = store.append("room", "r1", {
    at: 1000, kind: "process", author: "A", text: "{}", clientMessageId: "cm-1",
  });
  // 广播必须用 entryAt(id)（=5000）而非调用方传入的 1000，否则客户端按旧锚归位
  assert.equal(store.entryAt(id), 5000);
  const e = store.entry(id)!;
  assert.equal(e.at, store.entryAt(id));
  assert.equal(e.clientMessageId, "cm-1");
  assert.equal(e.kind, "process");
  // draft 标记可供广播侧过滤半成品行
  const d = store.beginReplyDraft("room", "r1", {
    at: 6000, kind: "assistant", author: "A", text: "wip",
  });
  assert.equal(store.entry(d)!.draft, 1);
});

test("broadcastEntry 抑制规则：error 全域不下发，room 域 system 不下发，session 域 system 放行", () => {
  const { store } = mk();
  const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = src.indexOf("function broadcastEntry(");
  const end = src.indexOf("\n}\n", start) + 3;
  const fnSrc = ts.transpileModule(
    `module.exports = ${src.slice(start, end)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const sent: { method?: string; params?: { entry?: { kind?: string; at?: number } } }[] = [];
  const box: Record<string, unknown> = {
    module: { exports: null }, store,
    broadcast: (e: { method?: string }) => sent.push(e),
  };
  vm.runInNewContext(fnSrc, box, { timeout: 5000 });
  const broadcastEntry = (box.module as { exports: (s: string, id: string, r: number) => void }).exports;

  const put = (scope: "room" | "session", scopeId: string, kind: "user" | "system" | "error") =>
    store.append(scope, scopeId, { at: Date.now(), kind, author: "a", text: `t-${kind}` });
  const roomError = put("room", "r1", "error");
  const roomSystem = put("room", "r1", "system");
  const roomUser = put("room", "r1", "user");
  const sessionError = put("session", "s1", "error");
  const sessionSystem = put("session", "s1", "system");
  const sessionUser = put("session", "s1", "user");

  broadcastEntry("room", "r1", roomError);
  broadcastEntry("room", "r1", roomSystem);
  broadcastEntry("room", "r1", roomUser);
  broadcastEntry("session", "s1", sessionError);
  broadcastEntry("session", "s1", sessionSystem);
  broadcastEntry("session", "s1", sessionUser);

  const kinds = sent.map((e) => e.params?.entry?.kind);
  assert.deepEqual(kinds, ["user", "system", "user"]);
  // room 域复用 room.process 信封，session 域用 session.entry
  assert.equal(sent[0]?.method, "room.process");
  assert.equal(sent[1]?.method, "session.entry");
  // 放行行的 at 与钳制后存储 at 一致
  assert.equal(sent[1]?.params?.entry?.at, store.entryAt(sessionSystem));
});
