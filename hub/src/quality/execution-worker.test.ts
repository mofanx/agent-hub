import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerProject } from "./project.js";
import {
  WorkerExecutionProvider,
  WorkerExecError,
  defaultExecRunner,
  isQualityControlFrame,
  newRequestId,
  parseAllowedRoots,
  runWorkerExec,
  validateExecCwd,
  validateExecRoot,
  type ExecRequestFrame,
  type ExecResultFrame,
  type QualityControlFrame,
} from "./execution-worker.js";
import type { CheckDefinition, ProjectScope } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-wexec-"));
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

describe("WorkerExecutionProvider protocol", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("isQualityControlFrame", () => {
    it("识别 quality.exec.request", () => {
      const f = { channel: "__control__", method: "quality.exec.request", requestId: "r1" };
      assert.ok(isQualityControlFrame(f));
    });
    it("拒绝非 control channel", () => {
      assert.equal(isQualityControlFrame({ channel: "agent", method: "quality.exec.request" }), false);
    });
    it("拒绝 announce", () => {
      assert.equal(isQualityControlFrame({ channel: "__control__", method: "announce" }), false);
    });
  });

  describe("validateExecRoot", () => {
    it("允许在白名单根内", () => {
      const sub = path.join(dir, "proj");
      fs.mkdirSync(sub);
      assert.equal(validateExecRoot([dir], sub), fs.realpathSync(sub));
    });
    it("拒绝白名单外的 root", () => {
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      assert.throws(() => validateExecRoot([dir], outside), WorkerExecError);
    });
    it("realpath 解析符号链接", () => {
      const sub = path.join(dir, "proj");
      const link = path.join(dir, "link");
      fs.mkdirSync(sub);
      try {
        fs.symlinkSync(sub, link, "dir");
      } catch (err) {
        if (err instanceof Error && err.message.includes("operation not permitted")) return;
        throw err;
      }
      assert.equal(validateExecRoot([dir], link), fs.realpathSync(sub));
    });
  });

  describe("validateExecCwd", () => {
    it("cwd 在 root 内通过", () => {
      const sub = path.join(dir, "pkg");
      fs.mkdirSync(sub);
      assert.equal(validateExecCwd(dir, sub), fs.realpathSync(sub));
    });
    it("cwd 越界抛错", () => {
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      assert.throws(() => validateExecCwd(dir, outside), /path escape/);
    });
  });

  describe("parseAllowedRoots", () => {
    it("解析冒号分隔", () => {
      assert.deepEqual(parseAllowedRoots({ QUALITY_ALLOWED_ROOTS: "/a:/b:/c" }), ["/a", "/b", "/c"]);
    });
    it("兼容逗号", () => {
      assert.deepEqual(parseAllowedRoots({ QUALITY_ALLOWED_ROOTS: "/a;/b" }), ["/a", "/b"]);
    });
    it("空返回空数组", () => {
      assert.deepEqual(parseAllowedRoots({}), []);
    });
  });

  describe("WorkerExecutionProvider", () => {
    it("run 发送 exec.request 帧并等待 result", async () => {
      const sent: QualityControlFrame[] = [];
      const provider = new WorkerExecutionProvider((f) => sent.push(f));
      const project: ProjectScope = registerProject({ connectionId: "c1", root: dir });
      const runPromise = provider.run(project, makeCheck(), "run-1");
      // 应已发送 request
      assert.ok(sent.some((f) => f.method === "quality.exec.request"));
      // 模拟 worker 回传 result
      const req = sent.find((f) => f.method === "quality.exec.request") as ExecRequestFrame;
      const result: ExecResultFrame = {
        channel: "__control__",
        method: "quality.exec.result",
        requestId: req.requestId,
        checkRun: {
          id: "run-1:echo:1",
          runId: "run-1",
          checkId: "echo",
          attempt: 1,
          status: "passed",
          exitCode: 0,
          durationMs: 5,
          startedAt: 1,
          completedAt: 6,
        },
      };
      provider.dispatch(result);
      const run = await runPromise;
      assert.equal(run.status, "passed");
      assert.equal(run.exitCode, 0);
      assert.equal(provider.pendingCount, 0);
    });

    it("dispatch output 累积但不 resolve", async () => {
      const provider = new WorkerExecutionProvider(() => {});
      const project = registerProject({ connectionId: "c1", root: dir });
      const runPromise = provider.run(project, makeCheck(), "run-2");
      const req = (provider as unknown as { pending: Map<string, { outputs: { stdout: string } }> }).pending.keys().next().value as string;
      provider.dispatch({ channel: "__control__", method: "quality.exec.output", requestId: req, stream: "stdout", data: "partial" });
      assert.equal(provider.pendingCount, 1);
      provider.dispatch({
        channel: "__control__",
        method: "quality.exec.result",
        requestId: req,
        checkRun: { id: "x", runId: "run-2", checkId: "echo", attempt: 1, status: "passed", exitCode: 0, durationMs: 1, startedAt: 0, completedAt: 1 },
      });
      await runPromise;
    });

    it("cancel 发送 cancel 帧", async () => {
      const sent: QualityControlFrame[] = [];
      const provider = new WorkerExecutionProvider((f) => sent.push(f));
      const project = registerProject({ connectionId: "c1", root: dir });
      void provider.run(project, makeCheck({ id: "long" }), "run-3");
      await provider.cancel("run-3", "long");
      assert.ok(sent.some((f) => f.method === "quality.exec.cancel"));
    });

    it("onDisconnect 将挂起请求标记为 infra-failed", async () => {
      const provider = new WorkerExecutionProvider(() => {});
      const project = registerProject({ connectionId: "c1", root: dir });
      const runPromise = provider.run(project, makeCheck(), "run-4");
      provider.onDisconnect();
      const run = await runPromise;
      assert.equal(run.status, "infra-failed");
      assert.ok(run.summary?.includes("worker disconnected"));
    });

    it("newRequestId 唯一", () => {
      const a = newRequestId();
      const b = newRequestId();
      assert.notEqual(a, b);
    });
  });

  describe("runWorkerExec", () => {
    it("成功执行回传 passed result", async () => {
      const sent: QualityControlFrame[] = [];
      const project = registerProject({ connectionId: "c1", root: dir });
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-1",
        checkId: "echo",
        attempt: 1,
        projectRoot: project.root,
        cwd: project.root,
        argv: ["node", "-e", "console.log('hi')"],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const result = sent.find((f) => f.method === "quality.exec.result") as ExecResultFrame | undefined;
      assert.ok(result);
      assert.equal(result.checkRun.status, "passed");
      assert.equal(result.checkRun.exitCode, 0);
    });

    it("projectRoot 越界回传 infra-failed", async () => {
      const sent: QualityControlFrame[] = [];
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-2",
        checkId: "echo",
        attempt: 1,
        projectRoot: outside,
        cwd: outside,
        argv: ["echo", "hi"],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const result = sent.find((f) => f.method === "quality.exec.result") as ExecResultFrame | undefined;
      assert.ok(result);
      assert.equal(result.checkRun.status, "infra-failed");
      assert.ok(result.checkRun.summary?.includes("allowed roots"));
    });

    it("cwd 越界回传 infra-failed", async () => {
      const sent: QualityControlFrame[] = [];
      const outside = path.join(path.dirname(dir), "sibling");
      fs.mkdirSync(outside, { recursive: true });
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-3",
        checkId: "echo",
        attempt: 1,
        projectRoot: dir,
        cwd: outside,
        argv: ["echo", "hi"],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const result = sent.find((f) => f.method === "quality.exec.result") as ExecResultFrame | undefined;
      assert.ok(result);
      assert.equal(result.checkRun.status, "infra-failed");
    });

    it("空 argv 回传 infra-failed", async () => {
      const sent: QualityControlFrame[] = [];
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-4",
        checkId: "echo",
        attempt: 1,
        projectRoot: dir,
        cwd: dir,
        argv: [],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const result = sent.find((f) => f.method === "quality.exec.result") as ExecResultFrame | undefined;
      assert.ok(result);
      assert.equal(result.checkRun.status, "infra-failed");
    });

    it("非零退出码回传 failed", async () => {
      const sent: QualityControlFrame[] = [];
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-5",
        checkId: "fail",
        attempt: 1,
        projectRoot: dir,
        cwd: dir,
        argv: ["node", "-e", "process.exit(7)"],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const result = sent.find((f) => f.method === "quality.exec.result") as ExecResultFrame | undefined;
      assert.ok(result);
      assert.equal(result.checkRun.status, "failed");
      assert.equal(result.checkRun.exitCode, 7);
    });

    it("流式 output 帧被发送", async () => {
      const sent: QualityControlFrame[] = [];
      const req: ExecRequestFrame = {
        channel: "__control__",
        method: "quality.exec.request",
        requestId: newRequestId(),
        runId: "run-6",
        checkId: "echo",
        attempt: 1,
        projectRoot: dir,
        cwd: dir,
        argv: ["node", "-e", "console.log('streamed')"],
        timeoutMs: 10_000,
      };
      await runWorkerExec(req, [dir], (f) => sent.push(f), defaultExecRunner);
      const outputs = sent.filter((f) => f.method === "quality.exec.output");
      assert.ok(outputs.length > 0);
    });
  });

  describe("defaultExecRunner", () => {
    it("timeout 返回 timeout 状态", async () => {
      const r = await defaultExecRunner(
        dir,
        ["node", "-e", "setInterval(()=>{}, 1000)"],
        200,
        () => {},
        () => false,
      );
      assert.equal(r.status, "timeout");
    });
    it("cancel 返回 cancelled 状态", async () => {
      let tick = 0;
      const r = await defaultExecRunner(
        dir,
        ["node", "-e", "setInterval(()=>{}, 1000)"],
        30_000,
        () => {},
        () => {
          tick++;
          return tick > 1;
        },
      );
      assert.equal(r.status, "cancelled");
    });
  });
});
