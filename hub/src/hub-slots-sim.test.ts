import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const androidSrc = path.join(repoRoot, "android/app/src/main/java/com/agenthub");

/**
 * Android ChatViewModel 多 hub 槽位换绑的 TS 镜像模拟（可执行规格）。
 * 复刻语义（与 Kotlin 侧逐项对应）：
 * - 每 profile（address 为键）至多一个 HubClient；活跃 client 持全量状态，
 *   休眠 client 驻留 HubSlot（状态快照 + 降级 tier:"global" 订阅）。
 * - swapTo(address)：当前态压槽 → 字段复位 → 目标有槽则整槽回放（免重载），
 *   无槽走全量加载路径；同 address 重连不建槽。
 * - 休眠 client 的 global 白名单事件只写 hubBadges（waitingFor/待决/在线态），
 *   不触活跃时间线；断网重连由 client 自持。
 * - 显式 disconnect / profile 删除才移槽断链。
 */

type Obj = Record<string, any>;

class SimClient {
  state: "connected" | "disconnected" | "reconnecting" = "disconnected";
  subs: Obj[] = [];
  disconnected = 0;
  handshakes = 0;
  constructor(public url: string) {}
  /** Kotlin connect 幂等分支镜像：已连 socket 直接激活，零握手 */
  connect() { if (this.state === "connected") return; this.state = "connected"; this.handshakes++; }
  disconnect() { this.state = "disconnected"; this.disconnected++; }
  subscribe(params: Obj) { this.subs.push(params); }
}

type Badge = { waitingFor: number; pendingDecisions: number; connected: boolean };

class Slot {
  badgeWaiting = new Set<string>();
  badgeDecisions = new Set<string>();
  constructor(public key: string, public client: SimClient) {}
  snap: Obj = {};
}

/** ViewModel 镜像：hub-bound 字段组 + slots + hubBadges */
function makeVm() {
  const vm = {
    hub: null as SimClient | null,
    currentAddress: null as string | null,
    connectionWanted: false,
    slots: new Map<string, Slot>(),
    hubBadges: new Map<string, Badge>(),
    // —— hub-bound 字段子集（槽位换绑对象；完整清单见 Kotlin HubSlot）——
    sessions: [] as string[],
    chatItems: [] as string[],
    busyIds: [] as string[],
    flow: null as string | null,
    subscribedRoomId: null as string | null,
    deliveryOrigin: "",
    agentStatus: "offline",
    missions: [] as string[],
    screen: "sessions" as string,
  };
  const HUB_FIELDS = ["sessions","chatItems","busyIds","flow","subscribedRoomId","deliveryOrigin","agentStatus","missions","screen"] as const;
  const EMPTY: Obj = { sessions: [], chatItems: [], busyIds: [], flow: null, subscribedRoomId: null, deliveryOrigin: "", agentStatus: "offline", missions: [], screen: "sessions" };

  const badgeOf = (key: string) => vm.hubBadges.get(key) ?? vm.hubBadges.set(key, { waitingFor: 0, pendingDecisions: 0, connected: false }).get(key)!;
  const refreshBadge = (key: string) => {
    const s = vm.slots.get(key); if (!s) return;
    const b = badgeOf(key);
    b.waitingFor = s.badgeWaiting.size;
    b.pendingDecisions = s.badgeDecisions.size;
    b.connected = s.client.state === "connected";
  };

  /** 当前态压槽：字段快照 + client 降级 global + 徽章同步 */
  const parkToSlot = (key: string) => {
    const client = vm.hub!;
    const slot = vm.slots.get(key) ?? new Slot(key, client);
    vm.slots.set(key, slot);
    for (const f of HUB_FIELDS) slot.snap[f] = (vm as any)[f];
    client.subscribe({ tier: "global" });
    refreshBadge(key);
  };

  const clearHubState = () => { for (const f of HUB_FIELDS) (vm as any)[f] = structuredClone(EMPTY[f]); };

  /** 休眠 client 的 global 事件 → 只写徽章 */
  const slotBadgeEvent = (key: string, ev: Obj) => {
    const slot = vm.slots.get(key); if (!slot) return;
    if (ev.method === "room.flowUpdate") {
      const rid = ev.params?.roomId;
      const waiting = ev.params?.flow?.waitingFor != null;
      if (rid) waiting ? slot.badgeWaiting.add(rid) : slot.badgeWaiting.delete(rid);
    } else if (ev.method === "decision.update") {
      const did = ev.params?.decisionId;
      if (did) ev.params?.status === "pending" ? slot.badgeDecisions.add(did) : slot.badgeDecisions.delete(did);
    } else return; // 白名单外不处理
    refreshBadge(key);
  };

  /** HubLinkManager.take 镜像：摘出后台链路 socket 移交活跃侧（该 key 脱离 service 管理） */
  const takeServiceLink = (key: string) => {
    const c = serviceLinks.get(key);
    if (c) serviceLinks.delete(key);
    return c ?? null;
  };

  const connect = (address: string) => {
    const prev = vm.currentAddress;
    if (prev && prev !== address && vm.connectionWanted) parkToSlot(prev);
    const restored = vm.slots.get(address) ?? null;
    if (restored) vm.slots.delete(address);
    const adopted = (!restored && prev !== address) ? takeServiceLink(address) : null;
    vm.hub = restored?.client ?? adopted ?? new SimClient(`ws://${address}`);
    clearHubState();
    vm.connectionWanted = true;
    vm.currentAddress = address;
    vm.deliveryOrigin = `origin:${address}`;
    if (restored) {
      // 回放：字段灌回 + 升级 detail 订阅 + 徽章下线
      for (const f of HUB_FIELDS) (vm as any)[f] = restored.snap[f];
      restored.client.subscribe({ tier: "detail" });
      vm.hubBadges.delete(address);
    } else {
      vm.hubBadges.delete(address);
      vm.hub.connect();
      vm.hub.subscribe({ tier: "detail" });
      vm.agentStatus = "connected";
    }
  };

  const disconnectProfile = (key: string) => {
    vm.slots.get(key)?.client.disconnect();
    vm.slots.delete(key);
    vm.hubBadges.delete(key);
    if (vm.currentAddress === key) { vm.hub?.disconnect(); vm.hub = null; vm.connectionWanted = false; vm.currentAddress = null; }
  };

  const disconnectAll = () => {
    for (const s of vm.slots.values()) s.client.disconnect();
    vm.slots.clear(); vm.hubBadges.clear();
    vm.hub?.disconnect(); vm.hub = null; vm.connectionWanted = false;
  };

  // —— service 侧链路（HubLinkManager.close 镜像）——
  const serviceLinks = new Map<string, SimClient>();
  const linkFor = (key: string) => serviceLinks.get(key) ?? serviceLinks.set(key, new SimClient(`ws://${key}`)).get(key)!;
  const dropServiceLink = (key: string) => { serviceLinks.get(key)?.disconnect(); serviceLinks.delete(key); };

  /** disconnectLink：非活跃 profile 显式断链（槽位+service 链路一体；活跃走 disconnect） */
  const disconnectLink = (key: string) => {
    if (key === vm.currentAddress) return;
    disconnectProfile(key);
    dropServiceLink(key);
  };

  /** deleteProfile（修复前镜像）：仅清槽位，service 侧 global 链路残留至下次 reconcile */
  const deleteProfileBuggy = (key: string) => {
    if (key === vm.currentAddress) disconnectAll(); else disconnectProfile(key);
  };

  /** deleteProfile（目标语义）：非活跃走 disconnectLink（槽位+service 链路即回收） */
  const deleteProfile = (key: string) => {
    if (key === vm.currentAddress) disconnectAll(); else disconnectLink(key);
  };

  /** upsertProfile 镜像：换址丢旧槽+链；同址换 token/publicToken 亦丢（旧凭证链路作废） */
  const upsertProfile = (old: { address: string; token: string } | null, address: string, token: string) => {
    if (old != null) {
      if (old.address !== address) { disconnectProfile(old.address); dropServiceLink(old.address); }
      else if (old.token !== token) { disconnectProfile(address); dropServiceLink(address); }
    }
  };

  /** settleIdleLive 镜像（修复后）：按精确 author 定稿 live 项（replyText=null→置定稿）。
   *  缺陷版用 sameChatAuthor 宽松匹配（"devin" 命中 "devin (2)"），同房重名成员互伤。 */
  const settleIdleLive = (items: { author: string; replyText: string | null; settled?: boolean }[], author: string, exact = true) => {
    const match = (a: string) => exact ? a === author : (a === author || a.startsWith(`${author} (`) || author.startsWith(`${a} (`));
    for (const it of items) if (it.replyText == null && match(it.author)) { it.replyText = it.author; it.settled = true; }
  };

  return { vm, connect, parkToSlot, slotBadgeEvent, disconnectProfile, disconnectLink, deleteProfile, deleteProfileBuggy, disconnectAll, badgeOf, serviceLinks, linkFor, takeServiceLink, upsertProfile, settleIdleLive };
}

test("切走再切回：槽位整槽回放，client 复用零握手零断开", () => {
  const { vm, connect } = makeVm();
  connect("hubA");
  vm.sessions = ["s1", "s2"];
  vm.chatItems = ["m1", "m2"];
  vm.busyIds = ["s1"];
  vm.flow = "flowA";
  vm.subscribedRoomId = "roomA";
  const clientA = vm.hub!;

  connect("hubB");
  assert.equal(vm.sessions.length, 0, "切走后活跃态复位");
  assert.equal(vm.busyIds.length, 0);
  assert.equal(clientA.disconnected, 0, "旧 client 保活不断开");
  assert.equal(clientA.subs.at(-1)?.tier, "global", "旧 client 降级 global");
  assert.equal(vm.slots.has("hubA"), true);

  connect("hubA");
  assert.equal(vm.hub, clientA, "同一 client 实例复用——无新握手");
  assert.deepEqual(vm.sessions, ["s1", "s2"], "槽位回放");
  assert.deepEqual(vm.chatItems, ["m1", "m2"]);
  assert.deepEqual(vm.busyIds, ["s1"]);
  assert.equal(vm.flow, "flowA");
  assert.equal(vm.subscribedRoomId, "roomA");
  assert.equal(clientA.subs.at(-1)?.tier, "detail", "回激活升级 detail");
  assert.equal(vm.slots.has("hubA"), false);
});

test("A hub busy/flow 不串 B hub：休眠期 global 事件不触活跃态", () => {
  const { vm, connect, slotBadgeEvent } = makeVm();
  connect("hubA");
  vm.busyIds = ["worker1"];
  vm.chatItems = ["mA"];
  connect("hubB");
  assert.equal(vm.busyIds.length, 0, "B hub busyIds 独立");
  assert.equal(vm.chatItems.length, 0);
  slotBadgeEvent("hubA", { method: "member.status", params: {} }); // 白名单外忽略
  assert.equal(vm.busyIds.length, 0, "A 休眠事件不污染 B 活跃态");
  slotBadgeEvent("hubA", { method: "room.flowUpdate", params: { roomId: "r1", flow: { waitingFor: "user" } } });
  assert.equal(vm.busyIds.length, 0);
  connect("hubA");
  assert.deepEqual(vm.busyIds, ["worker1"], "A 槽位 busy 原样回");
});

test("global 事件只进徽章不进时间线", () => {
  const { vm, connect, slotBadgeEvent, badgeOf } = makeVm();
  connect("hubA");
  vm.chatItems = ["mA"];
  connect("hubB");
  slotBadgeEvent("hubA", { method: "room.flowUpdate", params: { roomId: "r1", flow: { waitingFor: "user" } } });
  slotBadgeEvent("hubA", { method: "room.flowUpdate", params: { roomId: "r2", flow: { waitingFor: "x" } } });
  slotBadgeEvent("hubA", { method: "decision.update", params: { decisionId: "d1", status: "pending" } });
  assert.equal(badgeOf("hubA").waitingFor, 2);
  assert.equal(badgeOf("hubA").pendingDecisions, 1);
  assert.equal(vm.chatItems.length, 0, "徽章事件不进活跃时间线");
  slotBadgeEvent("hubA", { method: "room.flowUpdate", params: { roomId: "r1", flow: { waitingFor: null } } });
  assert.equal(badgeOf("hubA").waitingFor, 1, "waitingFor 解除同步收");
});

test("显式断开移除槽位与链路；全断清全部", () => {
  const { vm, connect, disconnectProfile, disconnectAll } = makeVm();
  connect("hubA"); connect("hubB"); connect("hubC");
  const clientA = (vm.slots.get("hubA"))!.client;
  disconnectProfile("hubA");
  assert.equal(clientA.disconnected, 1, "显式断开才断链");
  assert.equal(vm.slots.has("hubA"), false);
  assert.equal(vm.hubBadges.has("hubA"), false);
  disconnectAll();
  assert.equal(vm.slots.size, 0);
  assert.equal(vm.hubBadges.size, 0);
});

test("删 profile 即断 service 侧链路：不残留至下次 reconcile", () => {
  const { vm, connect, linkFor, serviceLinks, deleteProfile, deleteProfileBuggy } = makeVm();
  connect("hubA"); connect("hubB"); connect("hubC");
  linkFor("hubA").connect(); // service 侧已挂 global 链路
  deleteProfileBuggy("hubA");
  assert.equal(serviceLinks.has("hubA"), true, "缺陷基线：仅清槽位，链路残留");
  deleteProfile("hubA");
  assert.equal(serviceLinks.has("hubA"), false, "修复后：槽位+service 链路即回收");
  const linkB = linkFor("hubB"); linkB.connect();
  deleteProfile("hubB");
  assert.equal(linkB.disconnected, 1);
  assert.equal(serviceLinks.has("hubB"), false);
});

test("槽位回放恢复 screen：切回落在原房间而非列表页", () => {
  const { vm, connect } = makeVm();
  connect("hubA");
  vm.screen = "room:r1"; // A hub 正在房间里
  connect("hubB");
  assert.equal(vm.screen, "sessions", "切走后场复位到列表页");
  connect("hubA");
  assert.equal(vm.screen, "room:r1", "切回 A 应回到原房间页");
});

test("settleIdleLive 精确匹配：同房重名成员定稿不互伤", () => {
  const { settleIdleLive } = makeVm();
  const items = [
    { author: "devin", replyText: null as string | null },     // sidA 的在途回复
    { author: "devin (2)", replyText: null as string | null }, // sidB 的在途回复
  ];
  settleIdleLive(items, "devin (2)", true); // sidB 转 idle——只定稿自己的
  assert.equal(items[0]!.replyText, null, "精确匹配下 devin 的在途项不被 devin (2) 的 idle 定稿");
  assert.notEqual(items[1]!.replyText, null);
  const items2 = [
    { author: "devin", replyText: null as string | null },
    { author: "devin (2)", replyText: null as string | null },
  ];
  settleIdleLive(items2, "devin", false); // 缺陷基线：宽松匹配
  assert.notEqual(items2[1]!.replyText, null, "缺陷基线：宽松匹配误伤 'devin (2)'");
});

test("upsertProfile 同址换 token 回收槽位+service 链路", () => {
  const { vm, connect, linkFor, serviceLinks, upsertProfile } = makeVm();
  connect("hubA"); connect("hubB");
  linkFor("hubA").connect(); // A 休眠：槽位+service 链路均在
  upsertProfile({ address: "hubA", token: "old" }, "hubA", "new"); // 同址换 token
  assert.equal(vm.slots.has("hubA"), false, "旧凭证槽位作废");
  assert.equal(serviceLinks.has("hubA"), false, "旧凭证 service 链路即回收");
});

test("同 profile 重连不建槽（full reset 路径）", () => {
  const { vm, connect } = makeVm();
  connect("hubA");
  vm.sessions = ["s1"];
  connect("hubA");
  assert.equal(vm.slots.size, 0, "同 address 不压槽");
  assert.equal(vm.sessions.length, 0, "走全量复位");
});

/** badgeFor 合并语义镜像：slot 实连徽章优先，service 链路徽章回退 */
test("badgeFor：slot 徽章优先于 service 链路徽章，活跃 profile 不出徽章", () => {
  type LinkBadge = { targets: { kind: string }[]; connected: boolean };
  const vm = {
    current: "hubB" as string | null,
    slot: new Map<string, Badge>([["hubA", { waitingFor: 2, pendingDecisions: 1, connected: true }]]),
    service: new Map<string, LinkBadge>([
      ["hubA", { targets: [{ kind: "flow" }], connected: true }],
      ["hubC", { targets: [{ kind: "flow" }, { kind: "flow" }, { kind: "decision" }], connected: true }],
      ["hubD", { targets: [], connected: false }],
      ["hubB", { targets: [{ kind: "flow" }], connected: true }],
    ]),
  };
  const badgeFor = (address: string) => {
    const s = vm.slot.get(address); if (s) return s;
    if (address === vm.current) return null;
    const l = vm.service.get(address); if (!l) return null;
    if (l.targets.length === 0 && !l.connected) return null;
    return {
      waitingFor: l.targets.filter((t) => t.kind === "flow").length,
      pendingDecisions: l.targets.filter((t) => t.kind === "decision").length,
      connected: l.connected,
    };
  };
  assert.deepEqual(badgeFor("hubA"), { waitingFor: 2, pendingDecisions: 1, connected: true }, "slot 源优先");
  assert.deepEqual(badgeFor("hubC"), { waitingFor: 2, pendingDecisions: 1, connected: true }, "service 回退 kind 计数");
  assert.equal(badgeFor("hubD"), null, "无目标且离线→无徽章（诚实无信息）");
  assert.equal(badgeFor("hubB"), null, "活跃 profile 不出徽章");
  assert.equal(badgeFor("hubE"), null, "未知 profile 无徽章");
});

/** 无槽有链：接管 service 链路 socket——免握手升级 detail，key 脱离 linkManager，槽位优先于链路 */
test("接管 service 链路：无槽切换免握手激活，链路旁路不入槽", () => {
  const { vm, connect, linkFor, serviceLinks } = makeVm();
  connect("hubA");
  const clientB = linkFor("hubB");
  clientB.connect();                          // service 后台链路已连（徽章绿、槽位空）
  assert.equal(clientB.handshakes, 1);
  connect("hubB");
  assert.equal(vm.hub, clientB, "活跃 client 为接管对象");
  assert.equal(clientB.handshakes, 1, "接管零新握手（connect 幂等激活）");
  assert.equal(clientB.disconnected, 0, "接管不断线");
  assert.equal(serviceLinks.has("hubB"), false, "key 已脱离 linkManager");
  assert.equal(clientB.subs.at(-1)?.tier, "detail", "接管后升级 detail 订阅");
  assert.equal(vm.slots.has("hubB"), false, "接管不入槽");

  // 槽位优先于链路：hubC 既有槽又有链——走槽位回放，链路原样保留（active 排除交由 reconcile）
  connect("hubC");                            // hubB 压槽
  const clientB2 = vm.slots.get("hubB")!.client;
  assert.equal(clientB2, clientB, "接管对象照常可压槽");
});

/** diffMergeList 镜像：同步回包按 key 增量合并——未变项实例零写回不重组、变更原位替换、
 *  乱序移动、消失删除。防 clear+addAll 整表重灌的列表闪烁与滚动跳动。 */
function diffMerge<T, K>(list: T[], incoming: T[], key: (t: T) => K) {
  const eq = (a: T, b: T) => a === b || JSON.stringify(a) === JSON.stringify(b);
  if (list.length === incoming.length && list.every((v, i) => eq(v, incoming[i]!))) return;
  const incomingKeys = new Set(incoming.map(key));
  for (let j = list.length - 1; j >= 0; j--) if (!incomingKeys.has(key(list[j]!))) list.splice(j, 1);
  let i = 0;
  while (i < incoming.length) {
    const want = incoming[i]!;
    if (i < list.length && key(list[i]!) === key(want)) {
      if (!eq(list[i]!, want)) list[i] = want;
      i++;
      continue;
    }
    const found = list.findIndex((it) => key(it) === key(want));
    if (found > i) {
      const moved = list.splice(found, 1)[0]!;
      list.splice(i, 0, eq(moved, want) ? moved : want);
    } else {
      list.splice(i, 0, want);
    }
    i++;
  }
  while (list.length > incoming.length) list.pop();
}

test("diffMerge：全量同步增量合并——未变项保实例零写回，变更/乱序/增删逐项对齐", () => {
  type Item = { id: string; v: number };
  const k = (t: Item) => t.id;
  const A = { id: "a", v: 1 }, B = { id: "b", v: 2 }, C = { id: "c", v: 3 };

  // 全等：零写回——所有项保留原实例（LazyColumn 位置项不重组）
  const list = [A, B, C];
  diffMerge(list, [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3 }], k);
  assert.deepEqual(list, [A, B, C]);
  assert.ok(list[0] === A && list[1] === B && list[2] === C, "未变项必须保实例");

  // 单点变更：仅该项原位替换为新实例，其余保实例
  const B2 = { id: "b", v: 22 };
  diffMerge(list, [{ id: "a", v: 1 }, B2, { id: "c", v: 3 }], k);
  assert.deepEqual(list, [A, B2, C]);
  assert.ok(list[0] === A && list[2] === C, "未变项仍保实例");
  assert.equal(list[1].v, 22);

  // 乱序：移动不复制——结果顺序精确对齐 incoming
  diffMerge(list, [{ id: "c", v: 3 }, { id: "a", v: 1 }, B2], k);
  assert.deepEqual(list, [C, A, B2]);
  assert.ok(list[0] === C && list[1] === A, "移动项保实例");

  // 增删：消失项删、新项插入正确位
  const D = { id: "d", v: 4 };
  diffMerge(list, [D, { id: "c", v: 3 }], k);
  assert.deepEqual(list, [D, C]);

  // 清空：incoming 空 → 全删
  diffMerge(list, [], k);
  assert.deepEqual(list, []);
});

/** Kotlin/UI 源码接线断言：swapTo 入口、badgeFor 合并、显式断开、双语、语义诚实 */
test("Android 多 hub 徽章接线：swapTo/badgeFor/disconnectLink/双语/无时间线预渲染", () => {
  const vm = fs.readFileSync(path.join(androidSrc, "ChatViewModel.kt"), "utf8");
  const drawer = fs.readFileSync(path.join(androidSrc, "ui/HubDrawer.kt"), "utf8");
  const strings = fs.readFileSync(path.join(androidSrc, "ui/Strings.kt"), "utf8");
  const linkMgr = fs.readFileSync(path.join(androidSrc, "HubLinkManager.kt"), "utf8");
  const service = fs.readFileSync(path.join(androidSrc, "HubService.kt"), "utf8");

  // ViewModel：swapTo 公开入口 + switchProfile 委托 + service 徽章汇入 + badgeFor 合并 + 显式断链
  assert.match(vm, /fun swapTo\(p: ConnProfile\)/, "swapTo 公开入口");
  assert.match(vm, /fun switchProfile\(p: ConnProfile\)\s*=\s*swapTo\(p\)/, "switchProfile 委托 swapTo");
  assert.match(vm, /HubService\.hubBadges\.collect/, "service 徽章汇入");
  assert.match(vm, /fun badgeFor\(address: String\)/, "badgeFor 合并访问器");
  const badgeForBody = vm.slice(vm.indexOf("fun badgeFor("), vm.indexOf("\n    fun ", vm.indexOf("fun badgeFor(") + 10));
  assert.ok(badgeForBody.indexOf("hubBadges[address]") < badgeForBody.indexOf("serviceBadges[address]"), "slot 徽章先于 service 回退");
  assert.match(badgeForBody, /currentProfile\?\.address/, "活跃 profile 不出徽章");
  assert.match(vm, /fun disconnectLink\(address: String\)/, "显式断链入口");
  const discBody = vm.slice(vm.indexOf("fun disconnectLink("), vm.indexOf("\n    fun ", vm.indexOf("fun disconnectLink(") + 10));
  assert.match(discBody, /dropSlot\(address\)/, "断链移槽");
  assert.match(discBody, /HubService\.dropLink\(address\)/, "断链同步 service 后台链路");

  // HubLinkManager：徽章携带 connected + 断/连时重发布 + 显式 close
  assert.match(linkMgr, /data class LinkBadge\(/, "LinkBadge 携带 targets+connected");
  assert.match(linkMgr, /connected/, "徽章含在线态");
  const onDisc = linkMgr.slice(linkMgr.indexOf("private fun onLinkDisconnected("), linkMgr.indexOf("private fun publishBadges("));
  assert.match(onDisc, /publishBadges\(\)/, "断连时重发布 connected=false");
  assert.match(linkMgr, /fun close\(key: String\)/, "公开 close 供显式断链");
  assert.match(linkMgr, /fun take\(key: String\)/, "公开 take 供活跃侧接管 socket");
  const takeBody = linkMgr.slice(linkMgr.indexOf("fun take("), linkMgr.indexOf("\n    private fun", linkMgr.indexOf("fun take(")));
  assert.match(takeBody, /onEvent = null/, "take 摘除事件回调");
  assert.match(takeBody, /publishBadges\(\)/, "take 后徽章下线");

  // HubService：徽章 map 带 LinkBadge + dropLink 伴生入口 + takeLink 移交入口
  assert.match(service, /fun dropLink\(address: String\)/, "service dropLink 入口");
  assert.match(service, /fun takeLink\(address: String\)/, "service takeLink 移交入口");
  assert.match(service, /HubClient\(linkScope\)/, "链路 client 挂进程级 linkScope——接管后不随 service 死");

  // ChatViewModel.connect：槽位→接管→新建三段式；接管路径不得 disconnect 已连 socket
  const conn = vm.slice(vm.indexOf("fun connect(address: String"), vm.indexOf("wireActiveCallbacks(client, epoch)"));
  assert.match(conn, /HubService\.takeLink\(address\)/, "connect 尝试接管后台链路");
  assert.match(conn, /disconnectHub = restored == null && adopted == null/, "接管 socket 不被 resetConnection 断开");

  // HubClient.connect：已连+同址幂等激活（接管免握手的底层保证）
  const client = fs.readFileSync(path.join(androidSrc, "HubClient.kt"), "utf8");
  assert.match(client, /isConnected && this@HubClient\.url == url/, "connect 幂等激活分支");

  // 二阶段增量刷新：syncRefreshAll 列表走 diffMergeList，不整表重灌
  const syncAll = vm.slice(vm.indexOf("private suspend fun syncRefreshAll("), vm.indexOf("private suspend fun syncRefreshMissions"));
  assert.match(syncAll, /diffMergeList\(sessions,/, "sessions 增量合并");
  assert.match(syncAll, /diffMergeList\(rooms,/, "rooms 增量合并");
  assert.match(syncAll, /diffMergeList\(connections,/, "connections 增量合并");
  assert.doesNotMatch(syncAll, /sessions\.clear\(\)|rooms\.clear\(\)/, "主列表不再 clear 重灌");

  // 横幅合并：service_stopped 恢复在途→统一恢复文案；待办同步同条软横幅
  const banner = vm.slice(vm.indexOf("fun backgroundConnectionBanner("), vm.indexOf("fun backgroundConnectionWarning("));
  assert.match(banner, /"service_stopped" -> if \(backgroundRunning\) S\.backgroundRecovering/, "恢复在途单横幅");
  assert.match(banner, /attentionRecoveryState != null -> S\.backgroundRecovering/, "待办同步并入恢复横幅");
  assert.match(strings, /val backgroundRecovering: String/, "接口声明 backgroundRecovering");
  assert.equal((strings.match(/override val backgroundRecovering =/g) || []).length, 2, "backgroundRecovering 双语");

  // HubDrawer：行点击=swapTo（不断开）、徽章读取 badgeFor、菜单显式断开、无双语外硬编码
  assert.match(drawer, /vm\.swapTo\(p\)/, "行点击走 swapTo 换绑");
  assert.match(drawer, /vm\.badgeFor\(/, "行渲染徽章");
  assert.match(drawer, /(?:S|LocalStrings\.current)\.disconnectLink/, "菜单显式断开项");
  const rowBody = drawer.slice(drawer.indexOf("private fun ProfileDrawerItem("));
  assert.doesNotMatch(rowBody, /vm\.disconnect\(\)/, "行内绝无断连调用");
  assert.doesNotMatch(drawer, /chatItems|ChatItem/, "非活跃 hub 不预渲染时间线（语义诚实）");
  assert.doesNotMatch(drawer, /"[^"]*[一-龥][^"]*"/, "无硬编码中文");

  // Strings.kt：接口声明 + 中英双实现
  assert.match(strings, /val disconnectLink: String/, "接口声明 disconnectLink");
  assert.match(strings, /val hubBadgePending: String/, "接口声明 hubBadgePending");
  assert.equal((strings.match(/override val disconnectLink =/g) || []).length, 2, "disconnectLink 双语");
  assert.equal((strings.match(/override val hubBadgePending =/g) || []).length, 2, "hubBadgePending 双语");
});
