import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import spawn from "cross-spawn";
import {
  isGitRepo,
  getHeadRevision,
  getDirtyHash,
  collectBaseline,
  collectChangeSet,
  detectContamination,
  type Baseline,
} from "./change-set.js";
import type { ProjectScope } from "./types.js";

function gitInit(dir: string): void {
  spawn.sync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["config", "user.email", "test@test.com"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["config", "user.name", "test"], { cwd: dir, encoding: "utf-8" });
}

function gitCommit(dir: string, msg: string): void {
  spawn.sync("git", ["add", "-A"], { cwd: dir, encoding: "utf-8" });
  spawn.sync("git", ["commit", "-m", msg], { cwd: dir, encoding: "utf-8" });
}

function writeFile(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

let tmpRoot: string;
let project: ProjectScope;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "change-set-"));
  gitInit(tmpRoot);
  writeFile(tmpRoot, "README.md", "# test\n");
  gitCommit(tmpRoot, "init");
  project = {
    id: "p1",
    connectionId: "conn-1",
    root: tmpRoot,
    gitRoot: tmpRoot,
    displayName: "test",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("change-set collector", () => {
  it("isGitRepo 对 git 仓库返回 true", () => {
    assert.equal(isGitRepo(tmpRoot), true);
  });

  it("isGitRepo 对普通目录返回 false", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"));
    assert.equal(isGitRepo(nonGit), false);
    fs.rmSync(nonGit, { recursive: true, force: true });
  });

  it("getHeadRevision 返回非空 hash", () => {
    const rev = getHeadRevision(tmpRoot);
    assert.ok(rev.length > 0);
    assert.equal(rev.length, 40);
  });

  it("getDirtyHash 干净工作区返回 null", () => {
    const hash = getDirtyHash(tmpRoot);
    assert.equal(hash, null);
  });

  it("getDirtyHash 有修改时返回 hash", () => {
    writeFile(tmpRoot, "dirty.txt", "dirty");
    const hash = getDirtyHash(tmpRoot);
    assert.ok(hash);
    assert.equal(hash!.length, 64);
    // 清理
    fs.unlinkSync(path.join(tmpRoot, "dirty.txt"));
  });

  it("collectBaseline 返回 revision 和 dirtyHash", () => {
    const baseline = collectBaseline(project);
    assert.equal(baseline.isGit, true);
    assert.ok(baseline.revision.length > 0);
    assert.equal(baseline.dirtyHash, null);
  });

  it("collectChangeSet 干净工作区返回空文件列表", () => {
    const baseline = collectBaseline(project);
    const cs = collectChangeSet("run-1", project, baseline, {}, tmpRoot);
    assert.equal(cs.files.length, 0);
    assert.equal(cs.preexistingDirty, false);
    assert.equal(cs.contaminated, false);
    assert.equal(cs.riskReasons.length, 0);
  });

  it("collectChangeSet 检测新增文件", () => {
    // 确保干净
    gitCommit(tmpRoot, "ensure clean");
    writeFile(tmpRoot, "src/new.ts", "export const x = 1;");
    const baseline = collectBaseline(project);
    const cs = collectChangeSet("run-1", project, baseline, {}, tmpRoot);
    const newFile = cs.files.find((f) => f.path === "src/new.ts");
    assert.ok(newFile, "should find src/new.ts");
    assert.equal(newFile!.status, "add");
    // 清理
    fs.unlinkSync(path.join(tmpRoot, "src/new.ts"));
    fs.rmdirSync(path.join(tmpRoot, "src"));
    gitCommit(tmpRoot, "cleanup");
  });

  it("collectChangeSet 检测 protectedPaths 和 riskRules", () => {
    gitCommit(tmpRoot, "ensure clean");
    writeFile(tmpRoot, "hub/src/quality/types.ts", "export {}");
    const baseline = collectBaseline(project);
    const cs = collectChangeSet(
      "run-1",
      project,
      baseline,
      {
        protectedPaths: ["hub/src/quality/**"],
        riskRules: [
          { pattern: "hub/src/quality/**", risk: "critical", reason: "质量核心" },
        ],
      },
      tmpRoot,
    );
    assert.ok(cs.riskReasons.length > 0);
    assert.ok(cs.riskReasons.some((r) => r.includes("protected")));
    assert.ok(cs.riskReasons.some((r) => r.includes("critical")));
    // 清理
    fs.rmSync(path.join(tmpRoot, "hub"), { recursive: true, force: true });
    gitCommit(tmpRoot, "cleanup");
  });

  it("collectChangeSet 计算 patchHash", () => {
    gitCommit(tmpRoot, "ensure clean");
    // 修改已跟踪的 README.md
    writeFile(tmpRoot, "README.md", "# test\nmodified\n");
    const baseline = collectBaseline(project);
    const cs1 = collectChangeSet("run-1", project, baseline, {}, tmpRoot);
    writeFile(tmpRoot, "README.md", "# test\nmodified again\n");
    const cs2 = collectChangeSet("run-2", project, baseline, {}, tmpRoot);
    assert.notEqual(cs1.patchHash, cs2.patchHash);
    assert.ok(cs1.patchHash.length > 0);
    // 清理
    writeFile(tmpRoot, "README.md", "# test\n");
    gitCommit(tmpRoot, "cleanup");
  });

  it("collectChangeSet 非 Git 项目返回 preexistingDirty=true", () => {
    const nonGitProject: ProjectScope = {
      id: "p2",
      connectionId: "conn-2",
      root: "/nonexistent",
      displayName: "non-git",
      capabilities: { git: false, localExec: false, remoteExec: false, isolatedWorktree: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const baseline: Baseline = { revision: "", dirtyHash: null, isGit: false };
    const cs = collectChangeSet("run-1", nonGitProject, baseline, {}, "/tmp");
    assert.equal(cs.preexistingDirty, true);
    assert.equal(cs.files.length, 0);
    assert.equal(cs.patchHash, "");
  });

  it("detectContamination：baseline 干净时 implementer 写入不算污染", () => {
    gitCommit(tmpRoot, "ensure clean");
    const baseline = collectBaseline(project);
    assert.equal(baseline.dirtyHash, null);
    writeFile(tmpRoot, "tracked.txt", "content");
    const cs = collectChangeSet("run-1", project, baseline, {}, tmpRoot);
    assert.equal(detectContamination(project, baseline, cs.patchHash, cs.patchHash), false);
    fs.unlinkSync(path.join(tmpRoot, "tracked.txt"));
    gitCommit(tmpRoot, "cleanup");
  });

  it("detectContamination：baseline 有 dirty 且 dirty hash 变了但 patchHash 没变 → 污染", () => {
    gitCommit(tmpRoot, "ensure clean");
    writeFile(tmpRoot, "preexist2.txt", "initial");
    const baseline = collectBaseline(project);
    assert.ok(baseline.dirtyHash);
    const cs = collectChangeSet("run-1", project, baseline, {}, tmpRoot);
    // 模拟运行外修改：改变文件内容
    writeFile(tmpRoot, "preexist2.txt", "modified outside");
    // patchHash 相同（模拟 run 没有产生新变更）
    assert.equal(detectContamination(project, baseline, cs.patchHash, cs.patchHash), true);
    fs.unlinkSync(path.join(tmpRoot, "preexist2.txt"));
    gitCommit(tmpRoot, "cleanup");
  });
});
