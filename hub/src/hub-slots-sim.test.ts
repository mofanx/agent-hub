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
  constructor(public url: string) {}
  connect() { this.state = "connected"; }
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
  };
  const HUB_FIELDS = ["sessions","chatItems","busyIds","flow","subscribedRoomId","deliveryOrigin","agentStatus","missions"] as const;
  const EMPTY: Obj = { sessions: [], chatItems: [], busyIds: [], flow: null, subscribedRoomId: null, deliveryOrigin: "", agentStatus: "offline", missions: [] };

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

  const connect = (address: string) => {
    const prev = vm.currentAddress;
    if (prev && prev !== address && vm.connectionWanted) parkToSlot(prev);
    const restored = vm.slots.get(address) ?? null;
    if (restored) vm.slots.delete(address);
    vm.hub = restored?.client ?? new SimClient(`ws://${address}`);
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

  return { vm, connect, parkToSlot, slotBadgeEvent, disconnectProfile, disconnectLink, deleteProfile, deleteProfileBuggy, disconnectAll, badgeOf, serviceLinks, linkFor };
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

  // HubService：徽章 map 带 LinkBadge + dropLink 伴生入口
  assert.match(service, /fun dropLink\(address: String\)/, "service dropLink 入口");

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
