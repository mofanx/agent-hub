import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { safetyFloorVerdict, extractCommand } from "./safety-floor.js";

const shellCall = (rawInput: unknown, kind = "execute") => ({ kind, rawInput, title: "run" });

describe("extractCommand", () => {
  test("rawInput.command string", () => {
    assert.equal(extractCommand(shellCall({ command: "ls" })), "ls");
  });
  test("rawInput.command array joins", () => {
    assert.equal(extractCommand(shellCall({ command: ["echo", "hi"] })), "echo hi");
  });
  test("missing command returns undefined", () => {
    assert.equal(extractCommand(shellCall({ path: "/x" })), undefined);
  });
});

describe("safetyFloorVerdict", () => {
  test("blocks rm -rf /", () => {
    const v = safetyFloorVerdict(shellCall({ command: "rm -rf /" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks rm -rf ~ with HOME expansion", () => {
    const v = safetyFloorVerdict(shellCall({ command: "rm -rf $HOME" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks quoted bypass variant rm -rf '/'", () => {
    const v = safetyFloorVerdict(shellCall({ command: `rm -rf "/"` }));
    assert.equal(v.action, "interactive");
  });
  test("blocks dd of=/dev/", () => {
    const v = safetyFloorVerdict(shellCall({ command: "dd if=x of=/dev/sda" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks redirect to raw device", () => {
    const v = safetyFloorVerdict(shellCall({ command: "echo x > /dev/sdb1" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks mkfs", () => {
    const v = safetyFloorVerdict(shellCall({ command: "mkfs.ext4 /dev/sda1" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks fork bomb", () => {
    const v = safetyFloorVerdict(shellCall({ command: ":(){ :|:& };:" }));
    assert.equal(v.action, "interactive");
  });
  test("blocks shutdown/reboot/init0", () => {
    for (const c of ["shutdown -h now", "reboot", "init 0", "systemctl poweroff"]) {
      assert.equal(safetyFloorVerdict(shellCall({ command: c })).action, "interactive", c);
    }
  });
  test("unparseable shell kind -> interactive (never clear)", () => {
    const v = safetyFloorVerdict({ kind: "execute", rawInput: { path: "/x" } });
    assert.equal(v.action, "interactive");
  });
  test("non-shell kind without command -> allow", () => {
    const v = safetyFloorVerdict({ kind: "read", rawInput: { path: "/x" } });
    assert.equal(v.action, "allow");
  });
  test("legit commands not blocked", () => {
    for (const c of [
      "rm -rf ./node_modules",
      "rm -rf /tmp/foo.log",
      "ls -la /",
      "dd if=/dev/zero of=./x bs=1k count=1",
      "npm test",
      "rm -f build/output.js",
    ]) {
      assert.equal(safetyFloorVerdict(shellCall({ command: c })).action, "allow", c);
    }
  });
});

describe("清残留：拆词绕过与误伤收窄", () => {
  test("反斜杠/quote 拆词的 rm -rf ~ 仍被拦截", () => {
    for (const v of ["r\\m -rf ~", 'r"m" -rf ~', "r'm' -rf ~", "rm -r\\f ~"]) {
      const r = safetyFloorVerdict({ kind: "execute", rawInput: { command: v } });
      assert.equal(r.action, "interactive", `变体 ${v} 应命中`);
    }
  });

  test("非 shell kind 的 code 字段不误拦", () => {
    const r = safetyFloorVerdict({
      kind: "write",
      rawInput: { code: "echo docs about rm -rf /" },
    });
    assert.equal(r.action, "allow", "文本类 kind 不做词法检查");
  });
});
