import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = require("typescript") as any;
const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function functionSource(name: string): string {
  return ast.statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
}

function fixture() {
  const goals: unknown[] = [], errors: unknown[] = [], done: unknown[] = [], writes: unknown[][] = [];
  let roomDriverCalls = 0;
  const native = { id: "m1", roomId: "r1", execution: { mode: "native-goal" } };
  const sandbox: any = {
    module: { exports: {} },
    sessionMetas: new Map([["s1", { name: "worker" }]]),
    turnStarts: new Map(), turnEnds: new Map(), turnDrafts: new Map(),
    flushTurnProcess: () => {}, dropTurnDraft: () => {}, markTurnStart: () => {},
    displayNameFor: () => "worker", originFor: () => "", emitMemberStatus: () => {},
    opLedger: { commit: () => true },
    roomIdForSessionTurn: () => "r1",
    roomModeManager: {
      isHiddenSession: () => false, isRoomTurn: () => false, roomIdForTurn: () => undefined,
      isHiddenTurn: () => false, isStaleTurnCommit: () => false, endDecidingTurn: () => {},
      onPromptDone: async () => { roomDriverCalls++; },
    },
    missionManager: {
      nativeMissionForSession: () => native,
      onNativeGoal: (...p: unknown[]) => goals.push(p),
      onNativeGoalError: (...p: unknown[]) => errors.push(p),
      onTurnDone: (...p: unknown[]) => done.push(p),
    },
    rooms: { recordOutput: () => false },
    store: { append: (...p: unknown[]) => { writes.push(p); } },
    sessionLedger: { captureOutput: () => {} },
    extractTaskResult: () => ({ artifacts: [] }),
    promptDoneInternalOutput: (p: any) => p.output,
    fireEventTasks: () => {}, persistState: () => {}, logError: () => {},
    broadcast: () => {}, toPublicHubEvent: (e: unknown) => e,
  };
  vm.createContext(sandbox);
  const js = ts.transpileModule(
    `${functionSource("onAgentEvent")}\n${functionSource("onTurnEnd")}\nmodule.exports = { onAgentEvent, onTurnEnd };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  vm.runInContext(js, sandbox);
  return { ...sandbox.module.exports, goals, errors, done, writes, roomDriverCalls: () => roomDriverCalls };
}

test("native wiring: 原生目标状态进入真实 MissionManager 回流分支", () => {
  const f = fixture();
  const goal = { objective: "approved", status: "complete" };
  f.onAgentEvent({ method: "session.goal", params: { sessionId: "s1", goal } });
  assert.deepEqual(f.goals, [["s1", goal]]);
});

test("native wiring: 原生错误按执行 ID 归属，不遗失取消失败", () => {
  const f = fixture();
  f.onAgentEvent({ method: "session.goal.error", params: { sessionId: "s1", executionId: "gx1", message: "transport" } });
  assert.deepEqual(f.errors, [["s1", "gx1", "transport"]]);
});

test("native wiring: 自主回合写入会话和目标房历史，不能因缺少 Hub prompt 丢失", () => {
  const f = fixture();
  f.onTurnEnd("s1", "native output");
  assert.deepEqual(f.writes.map((p: unknown[]) => p.slice(0, 2)), [["session", "s1"], ["room", "r1"]]);
});

test("native wiring: Goal 自主回合只驱动原生 Mission，不唤醒第二个 Hub 编排循环", async () => {
  const f = fixture();
  f.onAgentEvent({ method: "prompt.done", params: { sessionId: "s1", output: "partial", stopReason: "end_turn" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.roomDriverCalls(), 0);
  assert.deepEqual(f.done, [["s1", "r1", "partial"]]);
});

for (const method of ["session.delete", "session.deleteBatch"]) {
  test(`native wiring: ${method} 不能删除失联但仍有目标停止责任的会话`, async () => {
    let clause: any;
    const visit = (n: any) => {
      if (ts.isCaseClause(n) && n.expression.text === method) clause = n;
      ts.forEachChild(n, visit);
    };
    visit(ast);
    const context: any = {
      module: { exports: {} }, sessionMetas: new Map([["s1", {}]]), owners: new Map(),
      missionManager: { reservesSession: () => true },
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(`module.exports = async (req) => { switch (${JSON.stringify(method)}) { ${clause.getText(ast)} } };`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, context);
    await assert.rejects(() => context.module.exports({ params: { sessionId: "s1", sessionIds: ["s1"] } }), /busy/);
    assert.equal(context.sessionMetas.has("s1"), true);
  });
}
