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

function extractDecls(sourceFile: string, names: string[]): string {
  const text = fs.readFileSync(sourceFile, "utf8");
  const sf = ts.createSourceFile(path.basename(sourceFile), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) out.push(node.getText(sf));
    else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && names.includes(d.name.text)) { out.push(node.getText(sf)); break; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const missing = names.filter((n) => !out.some((s) => new RegExp(`(function|const|let|var)\\s+${n}\\b`).test(s)));
  if (missing.length) throw new Error(`declarations not found: ${missing.join(",")}`);
  return out.join("\n");
}

const screenSnippet =
  extractDecls(path.join(DESKTOP_SRC, "screens/ChatScreen.tsx"), ["itemKey", "FlowCardBody", "FlowTaskItem", "FlowCard", "FLOW_PHASE_LABEL_KEYS"]) +
  "\nmodule.exports = { itemKey, FlowCardBody, FlowTaskItem, FlowCard, FLOW_PHASE_LABEL_KEYS };\n";
const screenJs = ts.transpileModule(screenSnippet, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "h" },
}).outputText;
const stringsJs = ts.transpileModule(fs.readFileSync(path.join(DESKTOP_SRC, "hub/strings.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

const depsEqual = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && (a as unknown[]).every((v, i) => Object.is(v, (b as unknown[])[i]));

type FetchCall = { sessionId: string; running?: boolean; from?: number; to?: number; resolve: (items: unknown[] | null) => void };

function makeRuntime() {
  const fetchCalls: FetchCall[] = [];
  const timers = new Map<number, { cb: () => void; ms: number; acc: number; cleared: boolean }>();
  let nextTimer = 1;
  let autoResolve = true;
  const fetchProcessItems = (sessionId: string, opts: { running?: boolean; from?: number; to?: number } = {}) => {
    let resolve!: (items: unknown[] | null) => void;
    const p = new Promise<unknown[] | null>((r) => { resolve = r; });
    fetchCalls.push({ sessionId, ...opts, resolve });
    if (autoResolve) resolve([{ kind: "thought", marker: opts.running ? "partial" : "final" }]);
    return p;
  };
  const storeBox = {
    current: {
      lang: "en", client: null, currentRoom: null as any, fetchProcessItems,
      chatItems: [] as unknown[], missions: [] as unknown[], missionExecutionTarget: null as any,
      flow: { flowId: "f1" } as any,
      openMission: () => {}, openMissionExecution: () => {}, loadHistory: () => {},
    },
  };

  const hooks: any[] = [];
  let idx = 0;
  let pendingFx: { i: number; fn: () => unknown; deps: unknown[] | undefined }[] = [];
  let dirty = false;
  let dead = false;
  let Comp: any = null;
  let props: any = null;
  let tree: any = null;

  const h = (type: any, p: any, ...children: any[]) => ({ type, props: { ...(p ?? {}), children: children.flat(Infinity) } });

  const exposed: Record<string, unknown> = {
    h,
    useState(init: unknown) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { kind: "state", v: typeof init === "function" ? (init as () => unknown)() : init };
      const set = (nv: unknown) => {
        const s = hooks[i];
        const val = typeof nv === "function" ? (nv as (v: unknown) => unknown)(s.v) : nv;
        if (!Object.is(val, s.v)) { s.v = val; dirty = true; }
      };
      return [hooks[i].v, set];
    },
    useRef(init: unknown) {
      const i = idx++;
      if (!(i in hooks)) hooks[i] = { kind: "ref", current: init };
      return hooks[i];
    },
    useEffect(fn: () => unknown, deps?: unknown[]) { pendingFx.push({ i: idx++, fn, deps }); },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = idx++;
      if (!(i in hooks) || !depsEqual(hooks[i].deps, deps)) hooks[i] = { kind: "cb", fn, deps };
      return hooks[i].fn;
    },
    useHubStore: Object.assign(() => storeBox.current, { getState: () => storeBox.current }),
    stringsFor: () => new Proxy({}, { get: (_t, k) => `S.${String(k)}` }),
    ProcessSteps: (p: any) => h("div", { className: "proc-steps-stub" }, p.items.map((it: any) => it.marker ?? it.kind).join(",")),
    Check: () => null, Loader2: () => null, X: () => null, Circle: () => null,
    ChevronRight: () => null, ChevronDown: () => null, RotateCcw: () => null,
    formatClock: () => "", formatElapsed: () => "",
    localStorage: { getItem: () => null, setItem: () => {} },
    confirm: () => true,
    setInterval: (cb: () => void, ms: number) => { const id = nextTimer++; timers.set(id, { cb, ms, acc: 0, cleared: false }); return id; },
    clearInterval: (id: number) => { const t = timers.get(id); if (t) t.cleared = true; },
    requestAnimationFrame: (cb: () => void) => { cb(); return 0; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    React: { Fragment: Symbol.for("h.fragment") },
    console,
  };

  function render() {
    let guard = 0;
    do {
      dirty = false;
      idx = 0;
      pendingFx = [];
      tree = Comp(props);
      for (const fx of pendingFx) {
        const prev = hooks[fx.i];
        if (prev && prev.kind === "fx" && depsEqual(prev.deps, fx.deps)) continue;
        if (prev?.cleanup) prev.cleanup();
        hooks[fx.i] = { kind: "fx", deps: fx.deps, cleanup: fx.fn() || null };
      }
    } while (dirty && !dead && ++guard < 100);
  }

  return {
    exposed,
    fetchCalls,
    timers,
    mount(C: any, p: any) { Comp = C; props = p; dead = false; render(); },
    update(p: any) { props = p; render(); },
    flush: render,
    unmount() { dead = true; for (const s of hooks) if (s?.kind === "fx" && s.cleanup) s.cleanup(); },
    get tree() { return tree; },
    tick(ms: number) {
      for (const t of timers.values()) {
        if (t.cleared) continue;
        t.acc += ms;
        while (t.acc >= t.ms) { t.acc -= t.ms; void t.cb(); }
      }
    },
    newStoreSnapshot() {
      storeBox.current = { ...storeBox.current, chatItems: [...storeBox.current.chatItems, { marker: "live" }] };
    },
    setAutoResolve(v: boolean) { autoResolve = v; },
  };
}

type Rt = ReturnType<typeof makeRuntime>;

function fresh() {
  const rt = makeRuntime();
  const sandbox: Record<string, unknown> = { module: { exports: {} }, exports: {}, ...rt.exposed };
  vm.createContext(sandbox);
  vm.runInContext(screenJs, sandbox);
  return { rt, mod: (sandbox.module as any).exports };
}

function walk(node: any, fn: (n: any) => void) {
  if (node == null || typeof node !== "object") return;
  fn(node);
  if (typeof node.type === "function") walk(node.type(node.props), fn);
  const kids = node.props?.children;
  if (Array.isArray(kids)) kids.forEach((k) => walk(k, fn));
}
function findByClass(tree: any, cls: string): any {
  let hit: any = null;
  walk(tree, (n) => {
    if (!hit && typeof n.props?.className === "string" && n.props.className.split(" ").includes(cls)) hit = n;
  });
  return hit;
}
function allText(tree: any): string {
  const out: string[] = [];
  const collect = (n: any) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return; }
    if (typeof n === "object") {
      if (typeof n.type === "function") collect(n.type(n.props));
      if (Array.isArray(n.props?.children)) n.props.children.forEach(collect);
    }
  };
  collect(tree);
  return out.join("\n");
}
const immediate = () => new Promise((r) => setImmediate(r));
async function settle(rt: Rt) { for (let i = 0; i < 10; i++) { await immediate(); rt.flush(); } }

const baseTask = {
  id: "t1", sessionId: "s1", dispatchedAt: 100, name: "worker",
  task: "full-task-text", artifacts: [], dependsOn: [], verifications: [],
};
const clickTaskLine = (rt: Rt) => { findByClass(rt.tree, "flow-task-line").props.onClick(); rt.flush(); };
const clickProcToggle = (rt: Rt) => { findByClass(rt.tree, "flow-task-proc-toggle").props.onClick(); rt.flush(); };
const mount = (rt: Rt, mod: any, task: any, flowId = "f1") =>
  rt.mount(mod.FlowTaskItem, { task, showRetry: false, flowId });


test("pending 无依赖:点击可展开+完整详情+0 fetch", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "pending" });
  clickTaskLine(rt);
  await settle(rt);
  assert.equal(findByClass(rt.tree, "flow-task-line").props["aria-expanded"], true);
  assert.ok(findByClass(rt.tree, "flow-task-full"));
  assert.ok(allText(rt.tree).includes("full-task-text"));
  assert.equal(rt.fetchCalls.length, 0);
});

test("failed 无 output/error 仍可展开", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "failed" });
  clickTaskLine(rt);
  await settle(rt);
  assert.equal(findByClass(rt.tree, "flow-task-line").props["aria-expanded"], true);
  assert.ok(findByClass(rt.tree, "flow-task-full"));
});

test("running 一次点击直看 partial(过程默认展开)", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 1);
  assert.equal(rt.fetchCalls[0]!.running, true);
  assert.ok(allText(rt.tree).includes("partial"));
});

test("终态默认过程折叠:展开任务不预取,点过程才加载 history", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200 });
  clickTaskLine(rt);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 0);
  const toggle = findByClass(rt.tree, "flow-task-proc-toggle");
  assert.equal(toggle.props["aria-expanded"], false);
  clickProcToggle(rt);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 1);
  assert.equal(rt.fetchCalls[0]!.running, false);
  assert.equal(rt.fetchCalls[0]!.from, 100);
  assert.equal(rt.fetchCalls[0]!.to, 200);
  assert.ok(allText(rt.tree).includes("final"));
});

test("显式保持过程开时 running->done 自动补拉 final", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  clickProcToggle(rt);
  await settle(rt);
  clickProcToggle(rt);
  await settle(rt);
  rt.update({ task: { ...baseTask, status: "done", finishedAt: 200 }, showRetry: false, flowId: "f1" });
  await settle(rt);
  const finalCalls = rt.fetchCalls.filter((c) => c.running === false);
  assert.ok(finalCalls.length >= 1);
  assert.equal(finalCalls[0]!.to, 200);
  assert.ok(allText(rt.tree).includes("final"));
});

test("running 查看->收起->done->展开详情->展开过程:必须 history final", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  clickTaskLine(rt);
  await settle(rt);
  rt.update({ task: { ...baseTask, status: "done", finishedAt: 200 }, showRetry: false, flowId: "f1" });
  await settle(rt);
  clickTaskLine(rt);
  await settle(rt);
  clickProcToggle(rt);
  await settle(rt);
  const finalCalls = rt.fetchCalls.filter((c) => c.running === false);
  assert.ok(finalCalls.length >= 1, "expected history fetch with running=false");
  assert.ok(allText(rt.tree).includes("final"));
  assert.ok(!allText(rt.tree).includes("partial"));
});

test("running 过程展开期间 2s 轮询,store 快照更换不打断", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  for (let i = 0; i < 5; i++) {
    rt.tick(1000);
    await settle(rt);
    rt.newStoreSnapshot();
    rt.update({ task: { ...baseTask, status: "running" }, showRetry: false, flowId: "f1" });
    await settle(rt);
  }
  assert.ok(rt.fetchCalls.length > 1, `expected polling fetches >1, got ${rt.fetchCalls.length}`);
});

test("收起详情/卸载后不再轮询", async () => {
  const { rt, mod } = fresh();
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  const n = rt.fetchCalls.length;
  clickTaskLine(rt);
  rt.tick(6000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, n);
  clickTaskLine(rt);
  await settle(rt);
  const m1 = rt.fetchCalls.length;
  clickProcToggle(rt);
  rt.tick(6000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, m1);
  clickProcToggle(rt);
  await settle(rt);
  rt.unmount();
  const m = rt.fetchCalls.length;
  rt.tick(6000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, m);
});

test("迟到的 running 结果不得覆盖 done 之后的 final", async () => {
  const { rt, mod } = fresh();
  rt.setAutoResolve(false);
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  clickProcToggle(rt);
  await settle(rt);
  clickProcToggle(rt);
  await settle(rt);
  const openCalls = rt.fetchCalls.length;
  rt.update({ task: { ...baseTask, status: "done", finishedAt: 200 }, showRetry: false, flowId: "f1" });
  await settle(rt);
  assert.equal(rt.fetchCalls.length, openCalls + 1);
  rt.fetchCalls[openCalls]!.resolve([{ kind: "thought", marker: "final" }]);
  await settle(rt);
  for (let i = 0; i < openCalls; i++) rt.fetchCalls[i]!.resolve([{ kind: "thought", marker: "partial" }]);
  await settle(rt);
  assert.ok(allText(rt.tree).includes("final"));
  assert.ok(!allText(rt.tree).includes("partial"));
});

test("新 dispatch 批次后旧响应不得覆盖", async () => {
  const { rt, mod } = fresh();
  rt.setAutoResolve(false);
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  rt.update({ task: { ...baseTask, dispatchedAt: 300, status: "running" }, showRetry: false, flowId: "f1" });
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 2);
  rt.fetchCalls[1]!.resolve([{ kind: "thought", marker: "new-batch" }]);
  await settle(rt);
  rt.fetchCalls[0]!.resolve([{ kind: "thought", marker: "old-batch" }]);
  await settle(rt);
  assert.ok(allText(rt.tree).includes("new-batch"));
  assert.ok(!allText(rt.tree).includes("old-batch"));
});

test("FlowCardBody 子任务 key 含 flowId:不同 flow 复用 t1 不共享状态", () => {
  const { rt, mod } = fresh();
  const flow = (flowId: string) => ({
    flowId, phase: "working",
    progress: { done: 0, running: 1, pending: 0, failed: 0, total: 1 },
    tasks: [{ ...baseTask, status: "running" }],
    supplements: [],
  });
  const taskKeys = (tree: any): string[] => {
    const keys: string[] = [];
    const rec = (n: any) => {
      if (n == null || typeof n !== "object") return;
      if (n.type === mod.FlowTaskItem) { keys.push(n.props.key); return; }
      if (typeof n.type === "function" && n.type !== mod.FlowTaskItem) rec(n.type(n.props));
      if (Array.isArray(n.props?.children)) n.props.children.forEach(rec);
    };
    rec(tree);
    return keys;
  };
  rt.mount(mod.FlowCardBody, { flow: flow("f1"), showRetry: false });
  const keys1 = taskKeys(rt.tree);
  rt.mount(mod.FlowCardBody, { flow: flow("f2"), showRetry: false });
  const keys2 = taskKeys(rt.tree);
  assert.deepEqual(keys1, ["f1:t1"]);
  assert.deepEqual(keys2, ["f2:t1"]);
});

test("itemKey:无 id 合成 flow 移位一致,落库后不变", () => {
  const { mod } = fresh();
  const item = { kind: "flow", flowId: "f1", snapshot: { flowId: "f1", phase: "working", tasks: [], progress: { done: 0, running: 0, pending: 0, failed: 0, total: 0 } }, author: "" };
  assert.equal(mod.itemKey(item, 1), mod.itemKey(item, 2));
  assert.equal(mod.itemKey(item, 1), "flow:f1");
  assert.equal(mod.itemKey({ ...item, historyId: 9 }, 1), "flow:f1");
});

test("itemKey:process 卡 processId live->落库 key 一致", () => {
  const { mod } = fresh();
  const item = { kind: "process", processId: "p1", sessionId: "s1", status: "running", steps: 0, author: "" };
  assert.equal(mod.itemKey(item, 1), mod.itemKey(item, 5));
  assert.equal(mod.itemKey(item, 1), "process:p1");
  assert.equal(mod.itemKey({ ...item, historyId: 7 }, 2), "process:p1");
});


test("running 过程 poll 返回 null 保留已显示 partial", async () => {
  const { rt, mod } = fresh();
  rt.setAutoResolve(false);
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 1);
  rt.fetchCalls[0]!.resolve([{ kind: "thought", marker: "partial" }]);
  await settle(rt);
  rt.tick(2000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 2);
  rt.fetchCalls[1]!.resolve(null);
  await settle(rt);
  assert.ok(allText(rt.tree).includes("partial"));
});

test("running 在途请求未结束时 tick 不重叠发请求", async () => {
  const { rt, mod } = fresh();
  rt.setAutoResolve(false);
  mount(rt, mod, { ...baseTask, status: "running" });
  clickTaskLine(rt);
  await settle(rt);
  rt.tick(6000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 1);
  rt.fetchCalls[0]!.resolve([{ kind: "thought", marker: "partial" }]);
  await settle(rt);
  rt.tick(2000);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 2);
});

function loadStrings() {
  const sandbox: Record<string, unknown> = { module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(stringsJs, sandbox);
  return sandbox.exports as any;
}

test("flowMessageHint truth table(zh/en)", () => {
  const { stringsFor, flowMessageHint } = loadStrings();
  const zh = stringsFor("zh");
  const en = stringsFor("en");
  for (const S of [zh, en]) {
    for (const phase of ["done", "cancelled", "", "bogus"]) assert.equal(flowMessageHint(phase, "conductor", S), null, `${phase}`);
    for (const mode of ["conductor", "parallel", "debate", "pipeline", "mention", ""]) {
      assert.equal(flowMessageHint("awaiting-retry", mode, S), S.flowStartsNewHint, `awaiting-retry/${mode}`);
    }
    assert.equal(flowMessageHint("summarizing", "parallel", S), S.flowStartsNewHint);
    assert.equal(flowMessageHint("summarizing", "debate", S), S.flowStartsNewHint);
    for (const phase of ["planning", "awaiting-input", "working", "reviewing", "summarizing"]) {
      assert.equal(flowMessageHint(phase, "conductor", S), S.sendAsSupplement ?? S.composeSupplementHint, `conductor/${phase}`);
    }
    for (const phase of ["working", "summarizing"]) {
      assert.equal(flowMessageHint(phase, "pipeline", S), S.sendAsSupplement ?? S.composeSupplementHint);
    }
    for (const mode of ["parallel", "debate"]) {
      assert.equal(flowMessageHint("working", mode, S), S.sendAsSupplement ?? S.composeSupplementHint);
      assert.equal(flowMessageHint("planning", mode, S), null);
      assert.equal(flowMessageHint("reviewing", mode, S), null);
    }
    assert.equal(flowMessageHint("planning", "pipeline", S), null);
    assert.equal(flowMessageHint("working", "mention", S), null);
    assert.equal(flowMessageHint("working", "", S), null);
  }
  assert.equal(zh.composeSupplementHint, "普通新消息将补充到当前流程");
  assert.equal(en.composeSupplementHint, "New messages add context to the current flow");
  assert.equal(zh.flowStartsNewHint, "此阶段普通新消息会结束当前流程并开启新一轮");
  assert.equal(en.flowStartsNewHint, "At this stage, a new message ends the current flow and starts a new one");
});

const navTarget = (over: Record<string, unknown> = {}) => ({
  missionId: "ms1", roomId: "r1", flowId: "f1", taskId: "t1", dispatchedAt: 100, nonce: 7, ...over,
});
const navRoom = { roomId: "r1", mode: "parallel", members: [["s1", "w"]], name: "room" };

test("导航 target 命中任务:自动展开详情并打开同过程", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  store.currentRoom = navRoom;
  store.missionExecutionTarget = navTarget();
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200 });
  await settle(rt);
  assert.ok(findByClass(rt.tree, "flow-task-detail"), "任务应自动展开详情");
  assert.equal(rt.fetchCalls.length, 1);
  assert.equal(rt.fetchCalls[0]!.running, false);
  assert.equal(rt.fetchCalls[0]!.from, 100);
  assert.equal(rt.fetchCalls[0]!.to, 200);
});

test("导航 target 批次不符:dispatchedAt 不同不展开不取过程", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  store.currentRoom = navRoom;
  store.missionExecutionTarget = navTarget({ dispatchedAt: 50 });
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200, dispatchedAt: 100 });
  await settle(rt);
  assert.equal(findByClass(rt.tree, "flow-task-detail"), null);
  assert.equal(rt.fetchCalls.length, 0);
});

test("导航展开仅当 nonce 变化触发:同 nonce 重渲染不覆盖用户收起", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  store.currentRoom = navRoom;
  store.missionExecutionTarget = navTarget();
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200 });
  await settle(rt);
  assert.ok(findByClass(rt.tree, "flow-task-detail"));
  clickTaskLine(rt);
  assert.equal(findByClass(rt.tree, "flow-task-detail"), null, "用户已收起");
  rt.flush();
  assert.equal(findByClass(rt.tree, "flow-task-detail"), null, "同 nonce 不重新展开");
  store.missionExecutionTarget = navTarget({ nonce: 8 });
  rt.flush();
  assert.ok(findByClass(rt.tree, "flow-task-detail"), "新 nonce 再次展开");
});

test("FlowCard:done+failureMessage 危险样式且收起可见;nonce 只强制展开一次", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  store.currentRoom = navRoom;
  store.missionExecutionTarget = null;
  store.flow = { flowId: "f2" };
  const item = {
    kind: "flow",
    flowId: "f1",
    author: "",
    snapshot: {
      flowId: "f1", phase: "done", mode: "parallel", missionId: "ms1",
      failureMessage: "MOCK_SUMMARY_TIMEOUT", startedAt: 1, finishedAt: 2,
      progress: { done: 2, running: 0, pending: 0, failed: 0, total: 2 },
      tasks: [{ ...baseTask, status: "done", finishedAt: 2 }],
    },
  };
  rt.mount(mod.FlowCard, { item, currentMatchClass: "" });
  const card = findByClass(rt.tree, "flow-card");
  assert.ok(card.props.className.includes("flow-card-failed"), "failureMessage 应转危险分组");
  assert.ok(allText(rt.tree).includes("MOCK_SUMMARY_TIMEOUT"), "收起态应显示失败原因");
  assert.equal(findByClass(rt.tree, "flow-task-line"), null, "终态默认收起");
  store.missionExecutionTarget = navTarget({ taskId: undefined, dispatchedAt: undefined, nonce: 9 });
  rt.flush();
  assert.ok(findByClass(rt.tree, "flow-task-line"), "nonce 命中强制展开一次");
  findByClass(rt.tree, "flow-card-head").props.onClick();
  rt.flush();
  assert.equal(findByClass(rt.tree, "flow-task-line"), null, "用户收起");
  rt.flush();
  assert.equal(findByClass(rt.tree, "flow-task-line"), null, "同 nonce 不重展开");
  store.missionExecutionTarget = navTarget({ taskId: undefined, dispatchedAt: undefined, nonce: 10 });
  rt.flush();
  assert.ok(findByClass(rt.tree, "flow-task-line"), "新 nonce 可再展开");
});


test("过程守卫:无 dispatch 任务不请求,旧 running 快照遇新 flow 不请求", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200, dispatchedAt: 0 });
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 0, "无 dispatchedAt 不发无界请求");
  clickTaskLine(rt);
  clickProcToggle(rt);
  await settle(rt);
  assert.equal(rt.fetchCalls.length, 0, "手动展开过程也不发请求");
  assert.ok(allText(rt.tree).includes("S.processUnavailable"), "明确不可用");

  const rt2 = makeRuntime();
  const sandbox2: Record<string, unknown> = { module: { exports: {} }, exports: {}, ...rt2.exposed };
  vm.createContext(sandbox2);
  vm.runInContext(screenJs, sandbox2);
  const mod2 = (sandbox2.module as any).exports;
  const store2 = (rt2 as any).exposed.useHubStore();
  store2.flow = { flowId: "f-other" };
  rt2.mount(mod2.FlowTaskItem, { task: { ...baseTask, status: "running" }, showRetry: false, flowId: "f1" });
  clickTaskLine(rt2);
  await settle(rt2);
  assert.equal(rt2.fetchCalls.length, 0, "非 live flow 的 running 快照不借新回合过程");
});

test("导航 target 无 dispatch:展开详情但不自动取过程", async () => {
  const { rt, mod } = fresh();
  const store = (rt as any).exposed.useHubStore();
  store.currentRoom = navRoom;
  store.missionExecutionTarget = navTarget({ dispatchedAt: undefined });
  mount(rt, mod, { ...baseTask, status: "done", finishedAt: 200 });
  await settle(rt);
  assert.ok(findByClass(rt.tree, "flow-task-detail"), "详情展开");
  assert.equal(rt.fetchCalls.length, 0, "缺 dispatch 不自动取过程");
});
