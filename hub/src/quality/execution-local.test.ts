import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerProject } from "./project.js";
import { LocalExecutionProvider, buildSummary } from "./execution-local.js";
import type { CheckDefinition, ProjectScope } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-exec-"));
}

function makeCheck(over: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "echo",
    cwd: ".",
    argv: ["node", "-e", "console.log('hi')"],
    tier: "quick",
    timeoutMs: 10_000,
    required: true,
    ...over,
  };
}

describe("LocalExecutionProvider", () => {
  let dir: string;
  let artifactRoot: string;
  let provider: LocalExecutionProvider;
  let project: ProjectScope;

  beforeEach(() => {
    dir = tmpDir();
    artifactRoot = path.join(dir, "artifacts");
    provider = new LocalExecutionProvider({ artifactRoot });
    project = registerProject({ connectionId: "c1", root: dir });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("成功执行返回 passed 和 exitCode=0", async () => {
    const run = await provider.run(project, makeCheck(), "run-1");
    assert.equal(run.status, "passed");
    assert.equal(run.exitCode, 0);
    assert.ok(run.durationMs !== undefined && run.durationMs >= 0);
    assert.ok(run.stdoutArtifact);
    const out = fs.readFileSync(run.stdoutArtifact!, "utf8");
    assert.ok(out.includes("hi"));
  });

  it("非零退出码返回 failed", async () => {
    const run = await provider.run(
      project,
      makeCheck({ argv: ["node", "-e", "process.exit(3)"] }),
      "run-2",
    );
    assert.equal(run.status, "failed");
    assert.equal(run.exitCode, 3);
  });

  it("stderr 写入 artifact 文件", async () => {
    const run = await provider.run(
      project,
      makeCheck({ argv: ["node", "-e", "console.error('boom')"] }),
      "run-3",
    );
    assert.equal(run.status, "passed");
    const err = fs.readFileSync(run.stderrArtifact!, "utf8");
    assert.ok(err.includes("boom"));
  });

  it("超时返回 timeout 状态", async () => {
    const run = await provider.run(
      project,
      makeCheck({
        argv: ["node", "-e", "setInterval(()=>{}, 1000)"],
        timeoutMs: 200,
      }),
      "run-4",
    );
    assert.equal(run.status, "timeout");
  });

  it("cancel 返回 cancelled 状态", async () => {
    const check = makeCheck({
      id: "long",
      argv: ["node", "-e", "setInterval(()=>{}, 1000)"],
      timeoutMs: 30_000,
    });
    const promise = provider.run(project, check, "run-5");
    // 等一会让进程启动
    await new Promise((r) => setTimeout(r, 100));
    await provider.cancel("run-5", "long");
    const run = await promise;
    assert.equal(run.status, "cancelled");
  });

  it("cwd 越界抛出错误", async () => {
    const outside = path.join(path.dirname(dir), "sibling");
    fs.mkdirSync(outside, { recursive: true });
    await assert.rejects(
      provider.run(project, makeCheck({ cwd: outside }), "run-6"),
      /path escape/,
    );
  });

  it("artifact 文件路径在 artifactRoot/runId/checks 下", async () => {
    const run = await provider.run(project, makeCheck({ id: "tc" }), "run-7");
    assert.ok(run.stdoutArtifact!.startsWith(path.join(artifactRoot, "run-7", "checks")));
    assert.ok(fs.existsSync(run.stdoutArtifact!));
  });

  it("不存在的命令返回 infra-failed", async () => {
    const run = await provider.run(
      project,
      makeCheck({ argv: ["this-binary-does-not-exist-xyz"] }),
      "run-8",
    );
    assert.equal(run.status, "infra-failed");
  });

  it("环境变量白名单：不传递未列入的变量", async () => {
    process.env.QUALITY_TEST_SECRET = "leak-me";
    const restricted = new LocalExecutionProvider({
      artifactRoot,
      envWhitelist: ["PATH", "HOME"],
    });
    const run = await restricted.run(
      project,
      makeCheck({
        argv: ["node", "-e", "console.log(process.env.QUALITY_TEST_SECRET ?? 'none')"],
      }),
      "run-9",
    );
    const out = fs.readFileSync(run.stdoutArtifact!, "utf8");
    assert.ok(out.includes("none"));
    delete process.env.QUALITY_TEST_SECRET;
  });

  it("extraEnv 注入的环境变量可见", async () => {
    const withExtra = new LocalExecutionProvider({
      artifactRoot,
      extraEnv: { QUALITY_INJECTED: "yes" },
    });
    const run = await withExtra.run(
      project,
      makeCheck({
        argv: ["node", "-e", "console.log(process.env.QUALITY_INJECTED)"],
      }),
      "run-10",
    );
    const out = fs.readFileSync(run.stdoutArtifact!, "utf8");
    assert.ok(out.includes("yes"));
  });

  describe("buildSummary", () => {
    it("包含 status 和 exitCode", () => {
      const s = buildSummary("out", "err", "failed", 1);
      assert.ok(s.includes("[failed]"));
      assert.ok(s.includes("exit=1"));
    });
    it("stderr 优先于 stdout 作为摘要尾部", () => {
      const s = buildSummary("stdout-tail", "stderr-tail", "failed", 1);
      assert.ok(s.includes("stderr-tail"));
    });
  });
});
