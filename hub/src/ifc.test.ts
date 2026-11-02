import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSensitivity,
  ifcCheckRoomRead,
  ifcCheckSensitiveWrite,
  IfcAuthError,
} from "./ifc.js";
import { Store } from "./store.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mkStore = (t: test.TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
};

test("parseSensitivity: 默认 shared、private 合法、其他拒绝", () => {
  assert.equal(parseSensitivity(undefined), "shared");
  assert.equal(parseSensitivity("shared"), "shared");
  assert.equal(parseSensitivity("private"), "private");
  assert.throws(() => parseSensitivity("secret"), /shared\|private/);
});

test("ifcCheckRoomRead: shared 恒放行、private 需授权/白名单", () => {
  assert.doesNotThrow(() => ifcCheckRoomRead(undefined, "r1", {}));
  const shared = { sensitivity: "shared" as const, allow: [] };
  assert.doesNotThrow(() => ifcCheckRoomRead(shared, "r1", {}));
  const priv = { sensitivity: "private" as const, allow: ["r2"] };
  assert.throws(() => ifcCheckRoomRead(priv, "r1", {}), IfcAuthError);
  assert.throws(
    () => ifcCheckRoomRead(priv, "r1", { fromRoomId: "r3" }),
    IfcAuthError,
  );
  assert.doesNotThrow(() =>
    ifcCheckRoomRead(priv, "r1", { ifcAuthorized: true }),
  );
  assert.doesNotThrow(() =>
    ifcCheckRoomRead(priv, "r1", { fromRoomId: "r2" }),
  );
});

test("ifcCheckSensitiveWrite: 必须显式授权标记", () => {
  assert.throws(() => ifcCheckSensitiveWrite({}), IfcAuthError);
  assert.throws(() => ifcCheckSensitiveWrite({ ifcAuthorized: false }), IfcAuthError);
  assert.doesNotThrow(() => ifcCheckSensitiveWrite({ ifcAuthorized: true }));
});

test("ifc 门控漏面一致性：flow/file 读类同样适用读门控语义", () => {
  const priv = { sensitivity: "private" as const, allow: ["ops"] };
  // 未授权/非白名单拒读（flow.file 路径同一语义）
  for (const params of [{}, { fromRoomId: "other" }]) {
    assert.throws(() => ifcCheckRoomRead(priv, "r1", params), IfcAuthError);
  }
  // 授权标记与白名单放行
  for (const params of [{ ifcAuthorized: true }, { fromRoomId: "ops" }]) {
    assert.doesNotThrow(() => ifcCheckRoomRead(priv, "r1", params));
  }
});

test("store IFC: 默认 shared、set/grant 往返、白名单增删", (t) => {
  const store = mkStore(t);
  assert.deepEqual(store.ifcGet("r1"), { sensitivity: "shared", allow: [] });
  store.ifcSet("r1", "private");
  assert.equal(store.ifcGet("r1").sensitivity, "private");
  store.ifcAllow("r1", "r2", true);
  store.ifcAllow("r1", "r3", true);
  assert.deepEqual(store.ifcGet("r1").allow.sort(), ["r2", "r3"]);
  store.ifcAllow("r1", "r2", false);
  assert.deepEqual(store.ifcGet("r1").allow, ["r3"]);
  // grant 不重置 sensitivity
  assert.equal(store.ifcGet("r1").sensitivity, "private");
  // 房间隔离：r1 规则不影响 r2
  assert.equal(store.ifcGet("r2").sensitivity, "shared");
});
