import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = require("typescript") as any;
const text = fs.readFileSync(new URL("../../desktop/src/hub/strings.ts", import.meta.url), "utf8");
const sandbox: any = { exports: {} };
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, sandbox);
const actions = (status: string, e: unknown) =>
  Array.from(sandbox.exports.missionNativeActions(status, e));
const native = (status: string | null, capabilities = ["set", "pause", "resume", "clear"]) => ({
  mode: "native-goal", actions: capabilities, goal: status === null ? null : { status },
});

test("native UI: 只显示真实协商动作，Claude 不出现暂停/恢复", () => {
  assert.deepEqual(actions("running", native("active")), ["pause"]);
  assert.deepEqual(actions("waiting-user", native("paused")), ["resume"]);
  assert.deepEqual(actions("running", native("active", ["set", "clear"])), []);
  assert.deepEqual(actions("running", { mode: "prompt", actions: ["pause"] }), []);
  assert.deepEqual(actions("accepted", native("complete")), []);
});

test("native UI: 清除后只允许明确提交验收，不自动验收；停止未确认可重试", () => {
  assert.deepEqual(actions("waiting-user", native(null)), ["review"]);
  assert.deepEqual(actions("stopped", { ...native("active"), stopConfirmed: false }), ["stop"]);
  assert.deepEqual(actions("failed", { ...native("active"), stopConfirmed: false }), ["stop"]);
  assert.deepEqual(actions("stopped", { ...native(null), stopConfirmed: true }), []);
});

test("native UI: 执行模式、状态与控制文案中英齐全，完成与验收文案分离", () => {
  for (const lang of ["zh", "en"]) {
    const S = sandbox.exports.stringsFor(lang);
    for (const key of ["native-goal", "prompt", "hub"]) assert.ok(S.missionExecutionModes[key]);
    for (const key of ["active", "paused", "blocked", "limited", "complete", "cleared", "unknown", "stopping"])
      assert.ok(S.missionNativeStatuses[key]);
    for (const key of ["pause", "resume", "clear", "review", "stop"]) assert.ok(S.missionNativeActions[key]);
    assert.notEqual(S.missionNativeStatuses.complete, S.missionStatusAccepted);
  }
});

test("draft UI: 关闭/创建后的提前返回不能跳过 React Hook", () => {
  const source = fs.readFileSync(new URL("../../desktop/src/screens/MissionPanel.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function MissionDraftCard(");
  const component = source.slice(start);
  assert.ok(component.indexOf("if (dismissed) return") > component.lastIndexOf("= useState"));
});
