import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PathEscapeError,
  assertInside,
  canonicalize,
  detectGitRoot,
  isPathInside,
  projectId,
  registerProject,
  validateCwd,
} from "./project.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-project-"));
}

describe("ProjectRegistry", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("projectId", () => {
    it("同 connection + 同 root 生成相同 id", () => {
      const a = projectId("conn-1", dir);
      const b = projectId("conn-1", dir);
      assert.equal(a, b);
    });

    it("同路径不同 connection 不冲突", () => {
      const a = projectId("conn-1", dir);
      const b = projectId("conn-2", dir);
      assert.notEqual(a, b);
    });

    it("同 connection 不同路径不冲突", () => {
      const sub = path.join(dir, "sub");
      fs.mkdirSync(sub);
      const a = projectId("conn-1", dir);
      const b = projectId("conn-1", sub);
      assert.notEqual(a, b);
    });

    it("符号链接 realpath 后与目标相同 id", () => {
      const target = path.join(dir, "target");
      const link = path.join(dir, "link");
      fs.mkdirSync(target);
      try {
        fs.symlinkSync(target, link, "dir");
      } catch (err) {
        // 某些环境不支持 symlink，跳过
        if (err instanceof Error && err.message.includes("operation not permitted")) return;
        throw err;
      }
      assert.equal(projectId("conn-1", link), projectId("conn-1", target));
    });

    it("id 长度 32 hex", () => {
      assert.match(projectId("conn-1", dir), /^[0-9a-f]{32}$/);
    });
  });

  describe("canonicalize", () => {
    it("realpath 已规范化", () => {
      assert.equal(canonicalize(dir), fs.realpathSync(dir));
    });
    it("不存在路径回退 resolve", () => {
      const ghost = path.join(dir, "does-not-exist");
      assert.equal(canonicalize(ghost), path.resolve(ghost));
    });
  });

  describe("isPathInside / assertInside", () => {
    it("子目录在父目录内", () => {
      const child = path.join(dir, "a", "b");
      fs.mkdirSync(child, { recursive: true });
      assert.ok(isPathInside(dir, child));
    });
    it("父目录不在子目录内", () => {
      const child = path.join(dir, "a");
      fs.mkdirSync(child);
      assert.equal(isPathInside(child, dir), false);
    });
    it("相同目录不算 inside", () => {
      assert.equal(isPathInside(dir, dir), false);
    });
    it("assertInside 越界抛 PathEscapeError", () => {
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      assert.throws(() => assertInside(dir, outside), (e) => e instanceof PathEscapeError);
    });
  });

  describe("detectGitRoot", () => {
    it("无 .git 返回 undefined", () => {
      assert.equal(detectGitRoot(dir), undefined);
    });
    it("当前目录有 .git 返回该目录", () => {
      fs.mkdirSync(path.join(dir, ".git"));
      assert.equal(detectGitRoot(dir), dir);
    });
    it("向上查找父级 .git", () => {
      const root = path.join(dir, "repo");
      const sub = path.join(root, "a", "b");
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(path.join(root, ".git"));
      assert.equal(detectGitRoot(sub), root);
    });
  });

  describe("registerProject", () => {
    it("非 git 项目 capabilities.git=false", () => {
      const p = registerProject({ connectionId: "conn-1", root: dir });
      assert.equal(p.capabilities.git, false);
      assert.equal(p.gitRoot, undefined);
      assert.equal(p.capabilities.localExec, true);
      assert.equal(p.capabilities.remoteExec, false);
      assert.equal(p.connectionId, "conn-1");
      assert.equal(p.id, projectId("conn-1", dir));
    });

    it("git 项目 capabilities.git=true 且 gitRoot 设置", () => {
      fs.mkdirSync(path.join(dir, ".git"));
      const p = registerProject({ connectionId: "conn-1", root: dir });
      assert.equal(p.capabilities.git, true);
      assert.equal(p.gitRoot, dir);
    });

    it("自定义 displayName 和 capabilities 覆盖默认", () => {
      const p = registerProject({
        connectionId: "c1",
        root: dir,
        displayName: "my-proj",
        localExec: false,
        remoteExec: true,
        isolatedWorktree: true,
        policyVersion: "v1",
      });
      assert.equal(p.displayName, "my-proj");
      assert.equal(p.capabilities.localExec, false);
      assert.equal(p.capabilities.remoteExec, true);
      assert.equal(p.capabilities.isolatedWorktree, true);
      assert.equal(p.policyVersion, "v1");
    });

    it("root 规范化为 realpath", () => {
      const sub = path.join(dir, "sub");
      fs.mkdirSync(sub);
      const p = registerProject({ connectionId: "c1", root: sub });
      assert.equal(p.root, fs.realpathSync(sub));
    });
  });

  describe("validateCwd", () => {
    it("合法 cwd 返回 realpath", () => {
      const sub = path.join(dir, "pkg");
      fs.mkdirSync(sub);
      const p = registerProject({ connectionId: "c1", root: dir });
      assert.equal(validateCwd(p, sub), fs.realpathSync(sub));
    });
    it("越界 cwd 抛 PathEscapeError", () => {
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      const p = registerProject({ connectionId: "c1", root: dir });
      assert.throws(() => validateCwd(p, outside), PathEscapeError);
    });
    it("git 项目允许 cwd 在 gitRoot 子树", () => {
      const root = path.join(dir, "repo");
      const sub = path.join(root, "pkg");
      fs.mkdirSync(sub, { recursive: true });
      fs.mkdirSync(path.join(root, ".git"));
      const p = registerProject({ connectionId: "c1", root: sub });
      assert.equal(p.gitRoot, root);
      assert.equal(validateCwd(p, sub), fs.realpathSync(sub));
    });
  });
});
