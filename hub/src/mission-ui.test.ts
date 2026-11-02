import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = require("typescript") as any;
const DESKTOP_SRC = fileURLToPath(new URL("../../desktop/src", import.meta.url));

function extractProps(sourceFile: string, names: string[]): string {
  const text = fs.readFileSync(sourceFile, "utf8");
  const sf = ts.createSourceFile(path.basename(sourceFile), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: any) => {
    if (
      (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      names.includes(node.name.text)
    ) {
      out.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const missing = names.filter((n) => !out.some((s) => new RegExp(`${n}\\s*[:\\(]`).test(s)));
  if (missing.length) throw new Error(`props not found: ${missing.join(",")}`);
  return out.join(",\n");
}

const storeSnippet =
  `const actions = { ${extractProps(path.join(DESKTOP_SRC, "hub/store.ts"), ["openRoom", "openChat", "openMission", "openMissionClear", "openMissionExecution"])} };\n` +
  "module.exports = actions;\n";
const storeJs = ts.transpileModule(storeSnippet, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function makeEnv() {
  const state: any = {
    client: { id: "c1" },
    lang: "en",
    rooms: [],
    sessions: [],
    missions: [],
    currentRoom: null,
    currentSession: null,
    chatItems: [],
    connectError: null,
    missionFocusId: null,
    missionExecutionTarget: null,
    searchQuery: "q",
    screen: "chat",
    refreshAllCalls: 0,
    resumeCalls: [] as string[],
    openRoomDeferred: null as null | (() => void),
    historyLoads: [] as unknown[],
  };
  state.refreshAll = async () => {
    state.refreshAllCalls++;
    if (state.openRoomDeferred) await new Promise<void>((r) => { state.openRoomDeferred = r; });
  };
  state.resumeOne = async (s: any) => { state.resumeCalls.push(s.sessionId); return s; };
  state.loadHistory = (method: string, k: string, id: string, anchor?: number) => {
    state.historyLoads.push({ method, id, anchor });
  };
  state.syncBusyIdsFromList = () => {};
  state.refreshFlow = () => {};
  state.refreshArtifacts = () => {};
  state.refreshMemberStatus = () => {};
  state.refreshSessionUsage = () => {};
  state.refreshRoomMemberModels = () => {};

  const sandbox: Record<string, unknown> = {
    module: { exports: {} }, exports: {},
    roomOpenSeq: 0,
    get: () => state,
    set: (p: Record<string, unknown>) => Object.assign(state, p),
    stringsFor: () => new Proxy({}, { get: (_t, k) => `S.${String(k)}` }),
    getHistoryCache: () => undefined,
    panelsCache: new Map(),
    flowCache: new Map(),
    saveCurrentHistoryCache: () => {},
    saveCurrentScopeCounts: () => {},
    restoredCounts: () => ({}),
    // openRoom/openChat 内的 scope 订阅调用桩：记录调用，默认无副作用
    subscribeScope: (tier: string, opts?: Record<string, unknown>) => {
      (state.subscribeCalls ??= []).push({ tier, ...opts });
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(storeJs, sandbox);
  const actions = (sandbox.module as any).exports;
  Object.assign(state, actions);
  return { state, actions, sandbox };
}

const roomFixture = () => ({ roomId: "r1", name: "room", members: [["s1", "w"], ["s2", "c"]] });
const missionFixture = (over: Record<string, unknown> = {}) => ({
  id: "ms1", roomId: "r1", status: "running", startedAt: 500, flowId: "f1",
  flow: { startedAt: 500 }, events: [], ...over,
});

test("openRoom readOnly:不 resume 离线成员且只读设置 target；普通开房清 target 并 resume", async () => {
  const { state, actions } = makeEnv();
  state.rooms = [roomFixture()];
  state.sessions = [{ sessionId: "s1", offline: true }];
  await actions.openRoom(roomFixture(), undefined, {
    readOnly: true,
    missionTarget: { missionId: "ms1", roomId: "r1", flowId: "f1", nonce: 1 },
  });
  assert.equal(state.resumeCalls.length, 0, "readOnly 不得 resume");
  assert.equal(state.currentRoom?.roomId, "r1");
  assert.equal(state.screen, "room");
  assert.equal(state.missionExecutionTarget?.flowId, "f1");
  await actions.openRoom(roomFixture());
  assert.ok(state.resumeCalls.length > 0, "普通开房 resume 离线成员");
  assert.equal(state.missionExecutionTarget, null, "普通开房清 target");
});

test("openRoom 异步守卫:等待期间被新导航取代则不写状态", async () => {
  const { state, actions } = makeEnv();
  state.rooms = [roomFixture()];
  let release!: () => void;
  state.refreshAll = async () => { await new Promise<void>((r) => { release = r; }); };
  const p = actions.openRoom(roomFixture(), undefined, {
    readOnly: true,
    missionTarget: { missionId: "ms1", roomId: "r1", nonce: 2 },
  });
  actions.openChat({ sessionId: "s9" });
  release();
  await p;
  assert.notEqual(state.currentRoom?.roomId, "r1", "旧 openRoom 不得写 currentRoom");
  assert.equal(state.missionExecutionTarget, null, "旧导航不得恢复 target");
});

test("openMission:未知 id 双语错误；已知 id 聚焦并清 target", async () => {
  const { state, actions } = makeEnv();
  state.missionExecutionTarget = { missionId: "x", roomId: "r1", nonce: 1 };
  actions.openMission("ghost");
  assert.equal(state.connectError, "S.missionNavUnavailable");
  assert.equal(state.missionFocusId, null);
  state.missions = [missionFixture()];
  actions.openMission("ms1");
  assert.equal(state.missionFocusId, "ms1");
  assert.equal(state.screen, "sessions");
  assert.equal(state.missionExecutionTarget, null);
  state.missionExecutionTarget = { missionId: "x", roomId: "r1", nonce: 3 };
  actions.openMission("ms1");
  assert.equal(state.missionExecutionTarget, null, "已知 id 也清旧 target");
});

test("openMissionExecution:缺单/缺房不开房；旧 flow 事件用 event.at 锚点", async () => {
  const { state, actions } = makeEnv();
  await actions.openMissionExecution("ghost");
  assert.equal(state.connectError, "S.missionNavUnavailable");
  assert.equal(state.currentRoom, null);
  state.connectError = null;
  state.rooms = [roomFixture()];
  state.missions = [missionFixture()];
  await actions.openMissionExecution("ms1", { flowId: "f0", taskId: "t9", dispatchedAt: 77, at: 42 });
  const t = state.missionExecutionTarget;
  assert.equal(t?.flowId, "f0");
  assert.equal(t?.taskId, "t9");
  assert.equal(t?.dispatchedAt, 77);
  assert.equal(state.historyLoads[0]?.anchor, 42, "旧 flow 事件用 event.at 锚点");
  await actions.openMissionExecution("ms1");
  assert.equal(state.missionExecutionTarget?.flowId, "f1", "缺省用 m.flowId");
  assert.equal(state.historyLoads[1]?.anchor, 500);
});


test("Android 导航 wiring 静态断言：先滚动目标卡索引，任务行帧后自定位", () => {
  const src = fs.readFileSync(path.join(DESKTOP_SRC, "../../android/app/src/main/java/com/agenthub/ui/ChatScreen.kt"), "utf8");
  assert.ok(src.includes("listState.scrollToItem(idx + navOffset)"), "目标卡必须先滚动");
  assert.ok(!src.includes("if (t.taskId != null && navTaskFound) return@LaunchedEffect"), "不得因任务命中跳过卡片滚动");
  assert.ok(src.includes("withFrameNanos"), "任务行定位需等 layout 帧");
  assert.ok(src.includes("bringIntoViewRequester.bringIntoView()"), "任务行原生定位");
});
