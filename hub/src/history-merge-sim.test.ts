import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";

/**
 * Android ChatViewModel.applyRecoveredRows 合并排序的 TS 镜像模拟。
 * 复刻语义（与 Kotlin 侧逐项对应）：
 * - 排序键：(at 归位键, tie)——persisted 用 (at, historyId)；
 *   historyId==null 的 live 项与 draft=1 回复行置尾哨兵 MAX_VALUE；
 *   未回显用户气泡按"下一个更大 historyId 落库行的 at"锚定；
 *   Process at<=0 用 turnEndAt/turnStartAt 归位。
 * - dedupeTail：live 副本被 incoming 指纹/证件吞并；Assistant/Thought
 *   过 earlierLive 门控（draft 行豁免 / 出生水位 / serverOffset 归一化）。
 * 目标：把"并发回合对调""回合中重进双显""已完成回复被新气泡压位"固化为断言。
 */

type Obj = Record<string, any>;
const MAX = Number.MAX_SAFE_INTEGER;

type SimItem = {
  id: number; // >0 live itemSeq；<0 = -historyId
  kind: "user" | "assistant" | "thought" | "tool" | "plan" | "system" | "error" | "process" | "flow" | "permission" | "elicitation";
  text: string;
  author: string;
  at: number;
  historyId?: number | undefined;
  historyAt?: number | undefined;
  clientMessageId?: string | undefined;
  replyText?: string | undefined;
  birthHistoryId?: number;
  turnStartAt?: number;
  turnEndAt?: number;
  toolCallId?: string;
  processId?: string;
  status?: string;
  sendStatus?: string;
};

/** 客户端模拟器：scope 内维护 live 列表、draft 集合与 serverOffset/maxHistIdSeen */
function makeClient(opts?: { clockSkewMs?: number }) {
  const skew = opts?.clockSkewMs ?? 0;
  const drafts = new Set<number>();
  let seq = 0;
  let latestServerAt = 0;
  let latestServerAtAt = 0;
  let maxHistIdSeen = 0;
  let items: SimItem[] = [];

  const clientNow = () => Date.now() + skew;
  const historyIdOf = (it: SimItem): number | undefined =>
    it.historyId ?? (it.id < 0 ? -it.id : undefined);
  const noteServerAt = (at: number) => {
    if (at > latestServerAt) {
      latestServerAt = at;
      latestServerAtAt = Date.now();
    }
  };
  const serverOffset = () => latestServerAt - latestServerAtAt;
  const isClientStamped = (it: SimItem): boolean => {
    if (it.kind === "flow" || it.kind === "process") return false;
    if (it.kind === "user") return it.historyAt == null;
    return historyIdOf(it) == null;
  };
  const normAtOf = (it: SimItem) =>
    it.at > 0 && isClientStamped(it) ? it.at + serverOffset() : it.at;
  const birthOf = (it: SimItem) =>
    it.kind === "assistant" || it.kind === "thought" ? it.birthHistoryId ?? 0 : 0;
  const sameChatAuthor = (a: string, b: string) =>
    a === b || a.startsWith(`${b} (`) || b.startsWith(`${a} (`);
  const isDraftRow = (h: SimItem) =>
    h.kind === "assistant" && historyIdOf(h) != null && drafts.has(historyIdOf(h)!);
  const earlierLive = (h: SimItem, t: SimItem): boolean => {
    if (isDraftRow(h)) return true;
    const b = birthOf(t);
    if (b > 0) return (historyIdOf(h) ?? 0) > b;
    return h.at <= 0 || t.at <= 0 || normAtOf(t) <= h.at;
  };
  const sameWindow = (h: SimItem, t: SimItem) =>
    h.at === 0 || t.at === 0 || Math.abs(h.at - normAtOf(t)) <= 300_000;
  const sameHistoryItem = (a: SimItem, b: SimItem) => {
    const id = historyIdOf(a);
    if (id != null && id === historyIdOf(b)) return true;
    if (a.kind === "user" && b.kind === "user")
      return a.clientMessageId != null && a.clientMessageId === b.clientMessageId;
    if (a.kind === "process" && b.kind === "process")
      return !!a.processId && a.processId === b.processId;
    return false;
  };
  const absorbedByProcess = (hist: SimItem[], t: SimItem) =>
    historyIdOf(t) == null && hist.some((h) => {
      if (h.kind !== "process" || !sameChatAuthor(h.author, t.author)) return false;
      const b = birthOf(t);
      return b > 0 ? (historyIdOf(h) ?? 0) > b : h.at >= normAtOf(t);
    });
  const dedupeTail = (hist: SimItem[], tail: SimItem[]): SimItem[] =>
    tail.filter((t) => {
      switch (t.kind) {
        case "user":
          return !hist.some(
            (h) =>
              h.kind === "user" &&
              (h.clientMessageId != null || t.clientMessageId != null
                ? h.clientMessageId != null && h.clientMessageId === t.clientMessageId
                : sameChatAuthor(h.author, t.author) &&
                  (h.text === t.text || h.text.endsWith(t.text))),
          );
        case "system":
          return !hist.some((h) => h.kind === "system" && sameWindow(h, t) && h.text === t.text);
        case "assistant":
          return !hist.some((h) => {
            if (h.kind !== "assistant" || !sameChatAuthor(h.author, t.author)) return false;
            if (!(t.replyText != null || earlierLive(h, t))) return false;
            const lt = t.replyText ?? t.text;
            return h.text === lt || h.text.startsWith(lt) || lt.startsWith(h.text);
          });
        case "tool":
          return !absorbedByProcess(hist, t) && !hist.some(
            (h) => h.kind === "tool" && !!t.toolCallId && h.toolCallId === t.toolCallId &&
              sameChatAuthor(h.author, t.author),
          );
        case "process":
          return !hist.some((h) => h.kind === "process" && !!t.processId && h.processId === t.processId);
        case "thought":
          return !absorbedByProcess(hist, t) && !hist.some(
            (h) =>
              h.kind === "thought" && sameChatAuthor(h.author, t.author) && earlierLive(h, t) &&
              (h.text === t.text || h.text.startsWith(t.text) || t.text.startsWith(h.text)),
          );
        case "error":
          return !hist.some(
            (h) => h.kind === "error" && sameWindow(h, t) && sameChatAuthor(h.author, t.author) &&
              h.text === t.text,
          );
        default:
          return true;
      }
    });

  /** parseHistoryItem 行→item（itemId=-rowId，user 另带 historyId/historyAt） */
  const parseRow = (row: Obj): SimItem => {
    const base: SimItem = {
      id: -row.id, kind: row.kind, text: row.text, author: row.author, at: row.at,
    };
    if (row.kind === "user") {
      base.historyId = row.id;
      base.historyAt = row.at;
      base.clientMessageId = row.clientMessageId;
    }
    if (row.kind === "tool") {
      try {
        const data = JSON.parse(row.text);
        base.toolCallId = data.toolCallId ?? "";
        base.status = data.status ?? "completed";
      } catch { base.toolCallId = ""; }
    }
    if (row.kind === "process") {
      try {
        const meta = JSON.parse(row.text);
        base.processId = meta.processId ?? "";
        base.status = meta.status ?? "done";
        base.turnStartAt = meta.turnStartAt ?? 0;
        base.turnEndAt = meta.turnEndAt ?? 0;
      } catch { /* keep */ }
    }
    return base;
  };

  const isActive = (it: SimItem, owned: Set<string>): boolean => {
    switch (it.kind) {
      case "user":
        return ["pending", "sending", "uncertain", "failed"].includes(it.sendStatus ?? "") ||
          (historyIdOf(it) == null && it.clientMessageId != null && !owned.has(it.clientMessageId));
      case "process": return it.status === "running";
      case "assistant": return it.id > 0 && it.replyText == null;
      case "tool": return !["completed", "failed", "cancelled", "done"].includes(it.status ?? "completed");
      default: return false;
    }
  };
  /** compactCacheItems：稳定项按 (normAt, historyId) 留最后 50，活跃/草稿项恒保留 */
  const compact = (owned: Set<string> = new Set()) => {
    const pinned = (it: SimItem) => historyIdOf(it) != null && drafts.has(historyIdOf(it)!);
    const stable = new Set(items.filter((it) => !isActive(it, owned) && !pinned(it))
      .map((it, i) => ({ it, i }))
      .sort((a, b) => normAtOf(a.it) - normAtOf(b.it) ||
        (historyIdOf(a.it) ?? MAX) - (historyIdOf(b.it) ?? MAX) || a.i - b.i)
      .slice(-50).map((x) => x.it));
    items = items.filter((it) => stable.has(it) || isActive(it, owned) || pinned(it));
  };
  /** applyUpdate tool_call_update：按 (author, toolCallId) 命中最后一条 live 工具 */
  const toolUpdate = (author: string, toolCallId: string, status: string) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const t = items[i]!;
      if (t.kind === "tool" && t.toolCallId === toolCallId && sameChatAuthor(t.author, author)) {
        items[i] = { ...t, status };
        return;
      }
    }
  };

  /** applyRecoveredRows：incoming 为落库行；tail 为现有 live 项；reset 镜像 recoveryResetBase 过滤 */
  const applyRows = (rows: Obj[], opts?: { reset?: boolean; before?: Set<SimItem>; owned?: Set<string> }) => {
    rows.forEach((r) => {
      if (r.id > maxHistIdSeen) maxHistIdSeen = r.id;
      noteServerAt(r.at);
      if (r.draft === 1) drafts.add(r.id);
      else if (r.draft === 0) drafts.delete(r.id);
    });
    const previous = items;
    const incoming = rows.map((r) => {
      const parsed = parseRow(r);
      const original = previous.find((o) => sameHistoryItem(o, parsed));
      if (parsed.kind === "user" && original?.kind === "user")
        return { ...original, historyId: r.id, historyAt: parsed.at, at: parsed.at };
      return parsed;
    });
    const owned = opts?.owned ?? new Set<string>();
    const before = opts?.before ?? new Set<SimItem>();
    const base = opts?.reset
      ? previous.filter((it) => !before.has(it) || isActive(it, owned) ||
        (historyIdOf(it) != null && drafts.has(historyIdOf(it)!)) ||
        (it.kind === "user" && it.clientMessageId != null && owned.has(it.clientMessageId)))
      : previous;
    const tail = base.filter((old) => !incoming.some((it) => sameHistoryItem(old, it)));
    const merged = [...incoming, ...dedupeTail(incoming, tail)];
    const persistedAsc = merged
      .filter((it) => historyIdOf(it) != null)
      .sort((a, b) => historyIdOf(a)! - historyIdOf(b)!);
    const anchorAtOf = (b: SimItem) => {
      const h = b.historyId;
      if (h == null) return undefined;
      return persistedAsc.find((it) => (historyIdOf(it) ?? -1) > h)?.at || undefined;
    };
    const keyOf = (it: SimItem): [number, number] => {
      const unmergedUser = it.kind === "user" && it.clientMessageId != null && it.historyAt == null;
      const isDraft = it.kind === "assistant" &&
        (historyIdOf(it) != null && drafts.has(historyIdOf(it)!));
      const anchored = unmergedUser ? anchorAtOf(it) : undefined;
      let at: number;
      if (anchored != null) at = anchored;
      else if (historyIdOf(it) == null || isDraft) at = MAX;
      else if (it.kind === "process" && it.at <= 0) at = it.turnEndAt! > 0 ? it.turnEndAt! : it.turnStartAt!;
      else at = normAtOf(it);
      if (at <= 0) at = MAX;
      const tie = isDraft ? MAX : (historyIdOf(it) ?? MAX - 1);
      return [at, tie];
    };
    items = merged
      .map((it, i) => ({ it, i }))
      .sort((a, b) => keyOf(a.it)[0] - keyOf(b.it)[0] || keyOf(a.it)[1] - keyOf(b.it)[1] || a.i - b.i)
      .map((x) => x.it);
  };

  const live = (partial: Partial<SimItem> & { kind: SimItem["kind"] }): SimItem => {
    const it: SimItem = {
      id: ++seq, text: "", author: "", at: clientNow(), ...partial,
    };
    if ((it.kind === "assistant" || it.kind === "thought") && it.birthHistoryId == null)
      it.birthHistoryId = maxHistIdSeen;
    items.push(it);
    return it;
  };
  const liveUser = (clientMessageId: string, historyId?: number): SimItem =>
    live({ kind: "user", text: "u-" + clientMessageId, author: "我", clientMessageId, historyId });

  return {
    drafts,
    applyRows,
    compact,
    toolUpdate,
    live,
    liveUser,
    clientNow,
    items: () => items,
    kinds: () => items.map((i) => i.kind),
    texts: () => items.map((i) => i.text),
    maxHistIdSeen: () => maxHistIdSeen,
  };
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-ms-"));
  return { store: new Store(dir), dir };
}
const row = (id: number, extra: Obj = {}): Obj =>
  ({ id, at: id, kind: "assistant", author: "A", text: `t${id}`, draft: 0, ...extra });

test("模拟：并发回合——live 到达序与持久完成序不同，recover 后归 (at,id) 序", () => {
  const { store } = mkStore();
  const roomId = "r1";
  store.append("room", roomId, { at: 900, kind: "user", author: "我", text: "m0" });
  // A 先开始（先落草稿行），B 后开始；B 先完成，A 后完成
  const aDraft = store.beginReplyDraft("room", roomId, { at: 1000, kind: "assistant", author: "A", text: "" });
  const bDraft = store.beginReplyDraft("room", roomId, { at: 1100, kind: "assistant", author: "B", text: "" });
  store.completeReplyDraft(bDraft, "B-final", store.maxHistoryAt("room", roomId) + 1);
  store.completeReplyDraft(aDraft, "A-final", store.maxHistoryAt("room", roomId) + 1);

  const c = makeClient();
  // 客户端已见 user 行；live 中两条流式回复按到达序（A 先 chunk）
  c.applyRows(store.read("room", roomId, 50).filter((r) => r.kind === "user"));
  const aLive = c.live({ kind: "assistant", author: "A", text: "A-part" });
  const bLive = c.live({ kind: "assistant", author: "B", text: "B-part" });
  assert.deepEqual(c.texts(), ["m0", "A-part", "B-part"], "live = 到达序");

  // 两条回复定稿：live 项标记 replyText（prompt.done 语义）
  aLive.replyText = "A-final";
  bLive.replyText = "B-final";
  // recover 拉到全部落库行（draft=0 已定稿）
  c.applyRows(store.read("room", roomId, 50));
  // 持久序 = 完成序：B 先完成在 A 之前；live 副本被指纹吞并
  assert.deepEqual(c.texts(), ["m0", "B-final", "A-final"]);
  assert.ok(c.items().every((i) => (i.historyId ?? -i.id) > 0 || i.id < 0),
    "重进后所有条目均已落库归位");
});

test("模拟：回合中重进——draft 行置尾与流式副本合并，不留中段草稿壳", () => {
  const { store } = mkStore();
  const sid = "s1";
  store.append("session", sid, { at: 900, kind: "user", author: "我", text: "q" });
  const draftId = store.beginReplyDraft("session", sid, {
    at: 1000, kind: "assistant", author: "A", text: "partial",
  });

  const c = makeClient();
  c.applyRows(store.read("session", sid, 50).filter((r) => r.kind === "user"));
  // 重进瞬间：先有一条 live 流式尾（新会话未见 draft 行时已创建）
  c.live({ kind: "assistant", author: "A", text: "partial" });
  // recover 拉到 draft=1 行
  c.applyRows(store.read("session", sid, 50));
  // draft 行豁免 earlierLive → 吞并同文本 live 副本；draft 本体置尾
  assert.equal(c.items().filter((i) => i.kind === "assistant").length, 1, "不得双显");
  const last = c.items().at(-1)!;
  assert.equal(last.id, -draftId, "尾部即 draft 行（流式续写并入其中）");
  assert.deepEqual(c.kinds(), ["user", "assistant"]);
  // draft 行即使 at=T_start 也排尾部——不卡在中段
  const userIdx = c.items().findIndex((i) => i.kind === "user");
  assert.ok(userIdx < c.items().length - 1);
});

test("模拟：已完成回复不被后续用户气泡压位", () => {
  const { store } = mkStore();
  const sid = "s1";
  const u1 = store.append("session", sid, { at: 900, kind: "user", author: "我", text: "m1", clientMessageId: "c1" });
  const replyId = store.append("session", sid, { at: 1000, kind: "assistant", author: "A", text: "r1" });
  const u2 = store.append("session", sid, { at: 1100, kind: "user", author: "我", text: "m2", clientMessageId: "c2" });

  const c = makeClient();
  c.applyRows(store.read("session", sid, 50).filter((r) => r.id === u1));
  // live：r1 定稿但 historyId 未学到（旧问题窗口）
  c.live({ kind: "assistant", author: "A", text: "r1", replyText: "r1" });
  // 新气泡已 ACK（historyId 已知）但回显未到
  c.liveUser("c2", u2);
  // recover：回复与回显行一起到达——回复归持久位，气泡锚定/合并
  c.applyRows(store.read("session", sid, 50).filter((r) => r.id === replyId || r.id === u2));
  // 断言回复在第二气泡之前（时间序 r1 < m2）
  const texts = c.texts();
  const m2 = c.items().findIndex((i) => i.clientMessageId === "c2");
  assert.ok(m2 >= 0 && texts.indexOf("r1") < m2,
    `定稿回复必须排在后续气泡之前: ${JSON.stringify(texts)}`);
  assert.equal(c.items().filter((i) => i.text === "r1").length, 1);
});

test("模拟：room.notice live 卡与同文本落库行合并不双显", () => {
  const { store } = mkStore();
  const roomId = "r1";
  const c = makeClient();
  store.append("room", roomId, { at: 1000, kind: "user", author: "我", text: "m1" });
  c.applyRows(store.read("room", roomId, 50));
  // room.notice 事件路径：客户端先加 live System（hub 侧 entry 广播已按抑制规则静默，
  // 但行仍落库——恢复/后续 merge 会拉回来）
  c.live({ kind: "system", text: "⏳ @A 处理中…", author: "" });
  store.append("room", roomId, { at: 2000, kind: "system", author: "", text: "⏳ @A 处理中…" });
  assert.deepEqual(c.kinds(), ["user", "system"], "广播被抑制：仅 live 单份");
  // 下一次 recover/entry merge 落库行到达：live 副本被 sameWindow+text 指纹吞并
  c.applyRows(store.read("room", roomId, 50).filter((r) => r.kind === "system"));
  assert.deepEqual(c.texts(), ["m1", "⏳ @A 处理中…"]);
  assert.equal(c.items().filter((i) => i.kind === "system").length, 1, "不得双显");
  assert.ok(c.items().at(-1)!.id < 0, "存留的是持久化行（id=-rowId）");
});

test("模拟：未落库卡类（Permission/System/Error）一律置尾，不插历史中段", () => {
  const { store } = mkStore();
  const roomId = "r1";
  const c = makeClient({ clockSkewMs: -10 * 60 * 1000 }); // 设备钟慢 10 分钟
  store.append("room", roomId, { at: 1000, kind: "user", author: "我", text: "m1" });
  store.append("room", roomId, { at: 5000, kind: "assistant", author: "A", text: "r1" });
  c.applyRows(store.read("room", roomId, 50));
  // 本地时钟域卡片（client at ≈ now ≪ server at）必须置尾而非插到 m1/r1 之间
  c.live({ kind: "permission", author: "A", text: "req" });
  c.live({ kind: "system", author: "", text: "notice" });
  c.applyRows([row(60, { kind: "process", author: "A", at: 6000 })]);
  assert.deepEqual(c.kinds(), ["user", "assistant", "process", "permission", "system"]);
});

test("模拟：O5 回显气泡经 reset 恢复与缓存压缩后不丢（保留本地 id）", () => {
  const { store } = mkStore();
  const sid = "fa-1";
  for (let i = 0; i < 12; i++) {
    store.append("session", sid, { at: 1000 + i * 10, kind: "user", author: "我", text: `old${i}`, clientMessageId: `old${i}` });
    store.append("session", sid, { at: 1001 + i * 10, kind: "thought", author: "A", text: `th${i}` });
    store.append("session", sid, { at: 1002 + i * 10, kind: "tool", author: "A", text: JSON.stringify({ toolCallId: `tc${i}`, status: "completed" }) });
    store.append("session", sid, { at: 1003 + i * 10, kind: "assistant", author: "A", text: `r${i}` });
  }
  const c = makeClient();
  c.applyRows(store.read("session", sid, 50));
  const bubble = c.liveUser("cmA");
  bubble.sendStatus = "sending";
  const hid = store.append("session", sid, { at: 2000, kind: "user", author: "我", text: bubble.text, clientMessageId: "cmA" });
  bubble.historyId = hid;
  bubble.sendStatus = "sent";
  c.applyRows(store.read("session", sid, 50).filter((r) => r.id === hid));
  const echoed = c.items().find((i) => i.clientMessageId === "cmA")!;
  assert.equal(echoed.id, bubble.id, "回显合并保留本地气泡 id（id>0，historyId 在字段里）");
  assert.equal(echoed.historyAt, 2000);
  c.live({ kind: "thought", author: "A", text: "thinking" });
  c.live({ kind: "assistant", author: "A", text: "part-0" });
  c.compact(new Set());
  assert.ok(c.items().some((i) => i.historyId === hid), "压缩后（投递记录已移除）气泡仍在");
  store.append("session", sid, { at: 2001, kind: "thought", author: "A", text: "thinking" });
  store.append("session", sid, { at: 2002, kind: "assistant", author: "A", text: "part-0 done" });
  c.items().filter((i) => i.kind === "assistant" && i.id > 0).forEach((i) => { i.replyText = "part-0 done"; });
  c.applyRows(store.read("session", sid, 50), { reset: true, before: new Set(c.items()), owned: new Set() });
  const users = c.items().filter((i) => i.kind === "user" && i.clientMessageId === "cmA");
  assert.equal(users.length, 1, "reset 后气泡恰一份");
  assert.equal(users[0]!.id, bubble.id);
  c.compact(new Set());
  c.applyRows(store.read("session", sid, 50), { reset: true, before: new Set(c.items()), owned: new Set() });
  const ids = c.items().map((i) => i.historyId ?? -i.id);
  const tailIds = store.read("session", sid, 50).map((r) => r.id);
  assert.deepEqual([...ids].sort((a, b) => a - b), [...tailIds].sort((a, b) => a - b), "重进后与服务端尾页一一对应");
  assert.equal(new Set(ids).size, ids.length, "无重复");
});

test("模拟：replyText 已定稿的残缺 live 回复被其落库行吞并", () => {
  const { store } = mkStore();
  const sid = "s1";
  store.append("session", sid, { at: 1000, kind: "user", author: "我", text: "q" });
  const c = makeClient({ clockSkewMs: 5 * 60 * 1000 });
  c.applyRows(store.read("session", sid, 50));
  const partial = c.live({ kind: "assistant", author: "A", text: "part-0 part-1" });
  partial.replyText = "part-0 part-1 part-2 done";
  const rid = store.append("session", sid, { at: 1500, kind: "assistant", author: "A", text: "part-0 part-1 part-2 done" });
  c.applyRows(store.read("session", sid, 50));
  assert.deepEqual(c.texts(), ["q", "part-0 part-1 part-2 done"]);
  assert.equal(c.items().at(-1)!.id, -rid, "存留的是落库行");
});

test("模拟：房间过程卡吞并同作者更早的 live 工具/思考，不吞其他成员", () => {
  const { store } = mkStore();
  const roomId = "r1";
  store.append("room", roomId, { at: 1000, kind: "user", author: "我", text: "@fm1 @fm2 go" });
  const c = makeClient();
  c.applyRows(store.read("room", roomId, 50));
  c.live({ kind: "thought", author: "fm1", text: "fm1 thinking" });
  c.live({ kind: "tool", author: "fm1", text: "", toolCallId: "tc-1", status: "completed" });
  c.live({ kind: "thought", author: "fm2", text: "fm2 thinking" });
  c.live({ kind: "tool", author: "fm2", text: "", toolCallId: "tc-2", status: "completed" });
  const at = c.clientNow() + 1000;
  store.append("room", roomId, { at, kind: "process", author: "fm1 (devin)", text: JSON.stringify({ processId: "p-fm1", status: "done" }) });
  c.applyRows(store.read("room", roomId, 50));
  const left = c.items().filter((i) => i.id > 0).map((i) => `${i.kind}:${i.author}`);
  assert.deepEqual(left, ["thought:fm2", "tool:fm2"], "仅 fm2 的 live 项存留");
  assert.equal(c.items().filter((i) => i.kind === "process").length, 1);
});

test("模拟：tool_call_update 按 (author, toolCallId) 命中，不串改同 toolCallId 的其他成员", () => {
  const { store } = mkStore();
  const roomId = "r1";
  store.append("room", roomId, { at: 1000, kind: "user", author: "我", text: "@fm1 @fm2 go" });
  const c = makeClient();
  c.applyRows(store.read("room", roomId, 50));
  c.live({ kind: "tool", author: "fm1", text: "", toolCallId: "call_0", status: "pending" });
  c.live({ kind: "tool", author: "fm2", text: "", toolCallId: "call_0", status: "pending" });
  c.toolUpdate("fm2", "call_0", "completed");
  const status = () => c.items().filter((i) => i.kind === "tool").map((i) => `${i.author}:${i.status}`);
  assert.deepEqual(status(), ["fm1:pending", "fm2:completed"]);
  c.toolUpdate("fm1", "call_0", "failed");
  assert.deepEqual(status(), ["fm1:failed", "fm2:completed"]);
  store.append("room", roomId, { at: 2000, kind: "tool", author: "fm1 (devin)", text: JSON.stringify({ toolCallId: "call_0", status: "failed" }) });
  c.applyRows(store.read("room", roomId, 50).filter((r) => r.kind === "tool"));
  const tools = c.items().filter((i) => i.kind === "tool").map((i) => `${i.id > 0 ? "live" : "row"}:${i.author}`);
  assert.deepEqual(tools.sort(), ["live:fm2", "row:fm1 (devin)"], "fm1 落库行只吞 fm1 live 副本");
});
