import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../desktop/package.json", import.meta.url));
const ts = require("typescript") as any;
const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const variable = ast.statements.flatMap((n: any) =>
  ts.isVariableStatement(n) ? [...n.declarationList.declarations] : [],
).find((n: any) => n.name.getText(ast) === "MISSION_RPC");
const script = ts.transpileModule(`module.exports = ${variable.initializer.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(existing?: Record<string, unknown>) {
  const starts: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const missionManager = {
    create: (p: Record<string, unknown>) => {
      creates.push(p);
      return { id: "m1", roomId: "r1", status: "draft" };
    },
    findBySource: (sourceId: unknown) => sourceId === "history:42:0" ? existing : undefined,
    findBoundActive: () => undefined,
    start: async (id: string) => {
      starts.push(id);
      return { id, roomId: "r1", status: "running" };
    },
  };
  const sandbox: any = {
    module: { exports: {} }, missionManager,
    sessionMetas: new Map([["s1", { name: "worker" }]]),
    rooms: { create: () => ({ roomId: "r1" }), delete: () => {} },
    dedupeRoomName: (name: string) => name,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { rpc: sandbox.module.exports, starts, creates };
}

for (const method of ["mission.create", "mission.promote"]) {
  test(`${method}: 创建与启动使用同一次明确授权请求，持久传递来源`, async () => {
    const f = fixture();
    const result = await f.rpc[method]({ roomId: "r1", sessionId: "s1", sourceId: "history:42:0", start: true });
    assert.deepEqual(f.starts, ["m1"]);
    assert.equal(f.creates[0]?.sourceId, "history:42:0");
    assert.equal(result.mission.status, "running");
  });
}

for (const status of ["stopped", "failed", "accepted"]) {
  test(`mission.promote: 历史来源已 ${status} 时不重新建房或启动`, async () => {
    const f = fixture({ id: "m0", roomId: "r0", boundSessionId: "s1", status });
    const result = await f.rpc["mission.promote"]({ sessionId: "s1", sourceId: "history:42:0", start: true });
    assert.equal(result.mission.id, "m0");
    assert.deepEqual(f.starts, []);
    assert.deepEqual(f.creates, []);
  });
}
