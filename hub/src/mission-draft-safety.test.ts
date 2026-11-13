import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = require("typescript") as any;
const source = fs.readFileSync(new URL("../../desktop/src/screens/MissionPanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("MissionPanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === "MissionDraftCard");
const script = ts.transpileModule(`${component.getText(ast)}\nmodule.exports = MissionDraftCard;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

async function render(missions: unknown[] = [], fail = false) {
  const calls: string[] = [];
  const inputs: Record<string, unknown>[] = [];
  const effects: (() => void)[] = [];
  const store = {
    missions,
    promoteMission: async (input: Record<string, unknown>) => {
      calls.push("promote");
      inputs.push(input);
      return fail ? null : { id: "m1", status: input.start === true ? "running" : "draft" };
    },
    startMission: async () => { calls.push("start"); },
  };
  const sandbox: any = {
    module: { exports: {} },
    React: {
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
      useEffect: (f: () => void) => effects.push(f),
    },
    useState: (v: unknown) => [v, () => {}],
    useHubStore: () => store,
    listField: (v: unknown) => Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : "",
    confirm: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const tree = sandbox.module.exports({
    draft: { auto: true, goal: "synthetic", acceptanceCriteria: ["verified"] },
    sessionId: "s1",
    sourceId: "session:s1:42:0",
    S: new Proxy({}, { get: (_, k) => String(k) }),
  });
  for (const effect of effects) effect();
  await new Promise((r) => setImmediate(r));
  return { tree, calls, inputs };
}

function button(tree: any, text: string): any {
  if (tree?.type === "button" && tree.children.includes(text)) return tree;
  for (const child of tree?.children ?? []) {
    const found = button(child, text);
    if (found) return found;
  }
}

for (const status of ["none", "draft", "running", "accepted", "stopped", "failed"]) {
  test(`mission draft: 渲染或历史重放 ${status} 不产生创建与启动请求`, async () => {
    const { calls } = await render(status === "none" ? [] : [{ id: "m0", boundSessionId: "s1", status }]);
    assert.deepEqual(calls, []);
  });
}

test("mission draft: 服务不可用时渲染不产生自动重试", async () => {
  const { calls } = await render([], true);
  assert.deepEqual(calls, []);
});

test("mission draft: 只有明确点击创建并开始才发送带稳定来源的一次性启动请求", async () => {
  const { tree, calls, inputs } = await render();
  button(tree, "missionCreateAndStart").props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["promote"]);
  assert.equal(inputs[0]?.sourceId, "session:s1:42:0");
  assert.equal(inputs[0]?.start, true);
});

test("mission draft: 仅创建按钮不得启动 auto:true 草稿", async () => {
  const { tree, calls, inputs } = await render();
  button(tree, "missionCreateConfirm").props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["promote"]);
  assert.notEqual(inputs[0]?.start, true);
  assert.equal(inputs[0]?.sourceId, "session:s1:42:0");
});

test("Android mission draft: 自动草稿不在组合时发起创建或启动", () => {
  const ui = fs.readFileSync(new URL("../../android/app/src/main/java/com/agenthub/ui/MissionPanel.kt", import.meta.url), "utf8");
  const card = ui.slice(ui.indexOf("private fun MissionDraftCard("));
  assert.doesNotMatch(card, /LaunchedEffect\(Unit\)\s*\{/);
  assert.doesNotMatch(card, /mutableStateOf\(if \(autoRun\) "creating"/);
});
