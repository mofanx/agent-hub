import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  RunPermissionManager,
  checkToolPermission,
  isReadOnlyRole,
  kindToToolKind,
  type QualityRole,
} from "./permissions.js";

describe("permissions", () => {
  describe("checkToolPermission", () => {
    it("planner 可以读和搜索，不能写", () => {
      assert.equal(checkToolPermission("planner", "read").allowed, true);
      assert.equal(checkToolPermission("planner", "search").allowed, true);
      assert.equal(checkToolPermission("planner", "write").allowed, false);
    });

    it("reviewer 可以读和搜索，不能写/delete/move", () => {
      assert.equal(checkToolPermission("reviewer", "read").allowed, true);
      assert.equal(checkToolPermission("reviewer", "search").allowed, true);
      assert.equal(checkToolPermission("reviewer", "write").allowed, false);
      assert.equal(checkToolPermission("reviewer", "delete").allowed, false);
      assert.equal(checkToolPermission("reviewer", "move").allowed, false);
    });

    it("implementer 可以写和执行", () => {
      assert.equal(checkToolPermission("implementer", "write").allowed, true);
      assert.equal(checkToolPermission("implementer", "execute").allowed, true);
    });

    it("verifier 只能执行", () => {
      assert.equal(checkToolPermission("verifier", "execute").allowed, true);
      assert.equal(checkToolPermission("verifier", "read").allowed, false);
      assert.equal(checkToolPermission("verifier", "write").allowed, false);
    });

    it("fixer 可以写和执行", () => {
      assert.equal(checkToolPermission("fixer", "write").allowed, true);
      assert.equal(checkToolPermission("fixer", "execute").allowed, true);
    });

    it("scheduler 不能使用任何工具", () => {
      assert.equal(checkToolPermission("scheduler", "read").allowed, false);
      assert.equal(checkToolPermission("scheduler", "write").allowed, false);
    });

    it("globalBypass 对 implementer 生效", () => {
      assert.equal(checkToolPermission("implementer", "delete", true).allowed, true);
    });

    it("globalBypass 对 reviewer 不生效（硬限制）", () => {
      assert.equal(checkToolPermission("reviewer", "write", true).allowed, false);
      assert.equal(checkToolPermission("reviewer", "delete", true).allowed, false);
    });

    it("globalBypass 对 planner 不生效", () => {
      assert.equal(checkToolPermission("planner", "write", true).allowed, false);
    });

    it("globalBypass 对 verifier 不生效", () => {
      assert.equal(checkToolPermission("verifier", "write", true).allowed, false);
    });
  });

  describe("isReadOnlyRole", () => {
    it("planner 和 reviewer 是只读角色", () => {
      assert.equal(isReadOnlyRole("planner"), true);
      assert.equal(isReadOnlyRole("reviewer"), true);
    });

    it("implementer/fixer/verifier/scheduler 不是只读", () => {
      assert.equal(isReadOnlyRole("implementer"), false);
      assert.equal(isReadOnlyRole("fixer"), false);
      assert.equal(isReadOnlyRole("verifier"), false);
      assert.equal(isReadOnlyRole("scheduler"), false);
    });
  });

  describe("kindToToolKind", () => {
    it("映射 ACP tool kind", () => {
      assert.equal(kindToToolKind("read"), "read");
      assert.equal(kindToToolKind("search"), "search");
      assert.equal(kindToToolKind("edit"), "write");
      assert.equal(kindToToolKind("delete"), "delete");
      assert.equal(kindToToolKind("move"), "move");
      assert.equal(kindToToolKind("execute"), "execute");
      assert.equal(kindToToolKind("fetch"), "fetch");
      assert.equal(kindToToolKind("unknown"), "other");
    });
  });

  describe("RunPermissionManager", () => {
    let mgr: RunPermissionManager;

    beforeEach(() => {
      mgr = new RunPermissionManager();
    });

    it("bind 后 checkSession 按角色判断", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      const deny = mgr.checkSession("s1", "edit");
      assert.equal(deny.allowed, false);
      const allow = mgr.checkSession("s1", "read");
      assert.equal(allow.allowed, true);
    });

    it("未绑定的 session 默认允许", () => {
      assert.equal(mgr.checkSession("unknown", "write").allowed, true);
    });

    it("unbindSession 解绑", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      mgr.unbindSession("s1");
      assert.equal(mgr.checkSession("s1", "write").allowed, true);
    });

    it("unbindRun 解绑该 run 的所有 session", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      mgr.bindSession("s2", "run-1", "implementer");
      mgr.bindSession("s3", "run-2", "reviewer");
      const removed = mgr.unbindRun("run-1");
      assert.equal(removed.length, 2);
      assert.equal(mgr.checkSession("s1", "write").allowed, true);
      assert.equal(mgr.checkSession("s3", "write").allowed, false);
    });

    it("isReadOnlyEnforced 对 reviewer 为 true", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      assert.equal(mgr.isReadOnlyEnforced("s1"), true);
      mgr.bindSession("s2", "run-1", "implementer");
      assert.equal(mgr.isReadOnlyEnforced("s2"), false);
    });

    it("checkPathAccess：reviewer 不能写任何路径", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      const result = mgr.checkPathAccess("s1", "src/foo.ts", "/repo");
      assert.equal(result.allowed, false);
    });

    it("checkPathAccess：implementer 不能写 protectedPaths", () => {
      mgr.bindSession("s1", "run-1", "implementer");
      const result = mgr.checkPathAccess("s1", "hub/src/quality/types.ts", "/repo", [
        "hub/src/quality/**",
      ]);
      assert.equal(result.allowed, false);
    });

    it("checkPathAccess：implementer 可写普通路径", () => {
      mgr.bindSession("s1", "run-1", "implementer");
      const result = mgr.checkPathAccess("s1", "src/foo.ts", "/repo", ["hub/src/quality/**"]);
      assert.equal(result.allowed, true);
    });

    it("checkSession with globalBypass：reviewer 仍被拒绝", () => {
      mgr.bindSession("s1", "run-1", "reviewer");
      assert.equal(mgr.checkSession("s1", "write", true).allowed, false);
    });

    it("checkSession with globalBypass：implementer 被允许", () => {
      mgr.bindSession("s1", "run-1", "implementer");
      assert.equal(mgr.checkSession("s1", "delete", true).allowed, true);
    });
  });
});
