import * as crypto from "node:crypto";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { CheckDefinition, CheckRun, CheckRunStatus, ProjectScope } from "./types.js";
import { assertInside, canonicalize, isPathInside, validateCwd } from "./project.js";
import { checkRunId, type ExecutionProvider, SUMMARY_LIMIT } from "./execution.js";

/**
 * WorkerExecutionProvider 协议（设计文档 §8.2）。
 *
 * Hub ↔ worker 控制通道帧：
 *   quality.exec.request   Hub → worker，请求执行一次 check
 *   quality.exec.output    worker → Hub，流式输出（stdout/stderr 增量）
 *   quality.exec.result    worker → Hub，最终 CheckRun
 *   quality.exec.cancel    Hub → worker，取消执行
 *   quality.project.describe worker → Hub，描述本连接允许的根目录
 *
 * worker 侧必须：
 * - 确认 projectRoot 属于该 connection 的允许目录；
 * - 拒绝路径逃逸和未知 projectId；
 * - 不接受 Hub 临时发送的任意绝对 cwd（cwd 必须在 projectRoot 内）；
 * - 断线后能上报未知/中断状态（由 Hub 侧超时/连接关闭判定）。
 */

export type ExecRequestFrame = {
  channel: "__control__";
  method: "quality.exec.request";
  requestId: string;
  runId: string;
  checkId: string;
  attempt: number;
  projectRoot: string;
  cwd: string;
  argv: string[];
  timeoutMs: number;
  envNames?: string[];
  allowNetwork?: boolean;
};

export type ExecOutputFrame = {
  channel: "__control__";
  method: "quality.exec.output";
  requestId: string;
  stream: "stdout" | "stderr";
  data: string;
};

export type ExecResultFrame = {
  channel: "__control__";
  method: "quality.exec.result";
  requestId: string;
  checkRun: CheckRun;
};

export type ExecCancelFrame = {
  channel: "__control__";
  method: "quality.exec.cancel";
  requestId: string;
  runId: string;
  checkId?: string;
};

export type ProjectDescribeFrame = {
  channel: "__control__";
  method: "quality.project.describe";
  requestId: string;
  roots: string[];
  hostname?: string;
};

export type QualityControlFrame =
  | ExecRequestFrame
  | ExecOutputFrame
  | ExecResultFrame
  | ExecCancelFrame
  | ProjectDescribeFrame;

export const QUALITY_METHODS: readonly string[] = [
  "quality.exec.request",
  "quality.exec.output",
  "quality.exec.result",
  "quality.exec.cancel",
  "quality.project.describe",
];

export function isQualityControlFrame(msg: unknown): msg is QualityControlFrame {
  if (typeof msg !== "object" || msg === null) return false;
  const f = msg as Record<string, unknown>;
  return f.channel === "__control__" && typeof f.method === "string" && QUALITY_METHODS.includes(f.method as string);
}

export class WorkerExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerExecError";
  }
}

/** 校验 exec request 的 projectRoot 是否在 worker 允许的根目录内。 */
export function validateExecRoot(allowedRoots: readonly string[], projectRoot: string): string {
  const canonical = canonicalize(projectRoot);
  for (const root of allowedRoots) {
    const cRoot = canonicalize(root);
    if (canonical === cRoot || isPathInside(cRoot, canonical)) return canonical;
  }
  throw new WorkerExecError(`projectRoot "${projectRoot}" not in allowed roots`);
}

/** 校验 cwd 在 projectRoot 内。 */
export function validateExecCwd(projectRoot: string, cwd: string): string {
  const canonicalCwd = canonicalize(cwd);
  assertInside(projectRoot, canonicalCwd);
  return canonicalCwd;
}

/** 生成 requestId。 */
export function newRequestId(): string {
  return `qexec-${crypto.randomBytes(8).toString("hex")}`;
}

export type WorkerSender = (frame: QualityControlFrame) => void;

/**
 * Hub 侧 WorkerExecutionProvider。
 * 通过 `send` 发送控制帧，通过 `dispatch` 接收 worker 回传的 output/result 帧。
 * 连接断开时调用 `onDisconnect(requestId)` 让挂起请求以 infra-failed 结束。
 */
export class WorkerExecutionProvider implements ExecutionProvider {
  private readonly send: WorkerSender;
  private readonly pending = new Map<string, {
    resolve: (r: CheckRun) => void;
    reject: (e: Error) => void;
    outputs: { stdout: string; stderr: string };
    cancelled: boolean;
    runId: string;
    checkId: string;
  }>();

  constructor(send: WorkerSender) {
    this.send = send;
  }

  async run(project: ProjectScope, check: CheckDefinition, runId: string): Promise<CheckRun> {
    const attempt = 1;
    const requestId = newRequestId();
    const cwd = path.isAbsolute(check.cwd) ? check.cwd : path.join(project.root, check.cwd);
    const req: ExecRequestFrame = {
      channel: "__control__",
      method: "quality.exec.request",
      requestId,
      runId,
      checkId: check.id,
      attempt,
      projectRoot: project.root,
      cwd,
      argv: check.argv,
      timeoutMs: check.timeoutMs,
    };
    if (check.envNames) req.envNames = check.envNames;
    if (check.allowNetwork !== undefined) req.allowNetwork = check.allowNetwork;

    const promise = new Promise<CheckRun>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        outputs: { stdout: "", stderr: "" },
        cancelled: false,
        runId,
        checkId: check.id,
      });
    });

    try {
      this.send(req);
    } catch (err) {
      this.pending.delete(requestId);
      throw err;
    }

    return promise;
  }

  async cancel(runId: string, checkId?: string): Promise<void> {
    for (const [reqId, p] of [...this.pending.entries()]) {
      if (p.runId !== runId) continue;
      if (checkId && p.checkId !== checkId) continue;
      p.cancelled = true;
      const frame: ExecCancelFrame = {
        channel: "__control__",
        method: "quality.exec.cancel",
        requestId: reqId,
        runId,
        ...(checkId !== undefined ? { checkId } : {}),
      };
      try {
        this.send(frame);
      } catch {
        // ignore send error; result will come or disconnect will resolve
      }
    }
  }

  /** 处理来自 worker 的帧。 */
  dispatch(frame: QualityControlFrame): void {
    if (frame.method === "quality.exec.output") {
      const p = this.pending.get(frame.requestId);
      if (!p) return;
      if (frame.stream === "stdout") p.outputs.stdout += frame.data;
      else p.outputs.stderr += frame.data;
      return;
    }
    if (frame.method === "quality.exec.result") {
      const p = this.pending.get(frame.requestId);
      if (!p) return;
      this.pending.delete(frame.requestId);
      p.resolve(frame.checkRun);
      return;
    }
  }

  /** 连接断开：所有挂起请求以 infra-failed 结束。 */
  onDisconnect(): void {
    for (const [reqId, p] of [...this.pending.entries()]) {
      this.pending.delete(reqId);
      const now = Date.now();
      const cr: CheckRun = {
        id: checkRunId(p.runId, p.checkId, 1),
        runId: p.runId,
        checkId: p.checkId,
        attempt: 1,
        status: "infra-failed",
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        summary: "worker disconnected before result",
      };
      p.resolve(cr);
    }
  }

  /** 当前挂起请求数（测试用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * worker 侧执行器：处理一个 exec request 帧，运行命令并回传 output/result。
 * `runCmd` 注入实际执行函数（便于测试），生产环境用 LocalExecutionProvider-like 实现。
 */
export type ExecRunner = (
  cwd: string,
  argv: string[],
  timeoutMs: number,
  onOutput: (stream: "stdout" | "stderr", data: string) => void,
  onCancel: () => boolean,
) => Promise<{ status: CheckRunStatus; exitCode: number | null; durationMs: number }>;

export async function runWorkerExec(
  frame: ExecRequestFrame,
  allowedRoots: readonly string[],
  send: WorkerSender,
  runCmd: ExecRunner,
): Promise<void> {
  let result: CheckRun;
  const startedAt = Date.now();
  try {
    const projectRoot = validateExecRoot(allowedRoots, frame.projectRoot);
    const cwd = validateExecCwd(projectRoot, frame.cwd);
    if (!Array.isArray(frame.argv) || frame.argv.length === 0) throw new WorkerExecError("empty argv");
    if (typeof frame.timeoutMs !== "number" || frame.timeoutMs <= 0) throw new WorkerExecError("invalid timeoutMs");

    const onOutput = (stream: "stdout" | "stderr", data: string): void => {
      const out: ExecOutputFrame = {
        channel: "__control__",
        method: "quality.exec.output",
        requestId: frame.requestId,
        stream,
        data,
      };
      send(out);
    };
    const onCancel = (): boolean => false; // 简化：取消由 Hub 侧超时/disconnect 判定

    const r = await runCmd(cwd, frame.argv, frame.timeoutMs, onOutput, onCancel);
    const completedAt = Date.now();
    result = {
      id: checkRunId(frame.runId, frame.checkId, frame.attempt),
      runId: frame.runId,
      checkId: frame.checkId,
      attempt: frame.attempt,
      status: r.status,
      startedAt,
      completedAt,
      durationMs: r.durationMs,
    };
    if (r.exitCode !== null) result.exitCode = r.exitCode;
  } catch (err) {
    const completedAt = Date.now();
    result = {
      id: checkRunId(frame.runId, frame.checkId, frame.attempt),
      runId: frame.runId,
      checkId: frame.checkId,
      attempt: frame.attempt,
      status: "infra-failed",
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      summary: String(err),
    };
  }
  const resFrame: ExecResultFrame = {
    channel: "__control__",
    method: "quality.exec.result",
    requestId: frame.requestId,
    checkRun: result,
  };
  send(resFrame);
}

/** 构造摘要（与 LocalExecutionProvider 一致）。 */
export function buildWorkerSummary(stdout: string, stderr: string, status: CheckRunStatus, exitCode: number | null): string {
  const tail = (stderr.trim() || stdout.trim()).slice(-SUMMARY_LIMIT);
  return `[${status}] exit=${exitCode ?? "n/a"}\n${tail}`;
}

/** 解析 worker 环境变量 QUALITY_ALLOWED_ROOTS（冒号分隔，兼容冒号与逗号）。 */
export function parseAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.QUALITY_ALLOWED_ROOTS ?? "";
  return raw.split(/[:;]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 默认 ExecRunner：用 cross-spawn 在 worker 本机执行，流式回传输出。
 * shell:false，timeout 先 SIGTERM 后 SIGKILL，取消通过 onCancel 轮询。
 */
export function defaultExecRunner(
  cwd: string,
  argv: string[],
  timeoutMs: number,
  onOutput: (stream: "stdout" | "stderr", data: string) => void,
  onCancel: () => boolean,
): Promise<{ status: CheckRunStatus; exitCode: number | null; durationMs: number }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let cancelled = false;
    let resolved = false;

    const finish = (status: CheckRunStatus, exitCode: number | null): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      clearInterval(pollHandle);
      resolve({ status, exitCode, durationMs: Date.now() - startedAt });
    };

    proc.stdout?.on("data", (b: Buffer) => onOutput("stdout", b.toString("utf8")));
    proc.stderr?.on("data", (b: Buffer) => onOutput("stderr", b.toString("utf8")));
    proc.on("exit", (code) => {
      if (timedOut) return finish("timeout", code);
      if (cancelled) return finish("cancelled", code);
      if (code === 0) return finish("passed", code);
      if (code === null) return finish("infra-failed", code);
      return finish("failed", code);
    });
    proc.on("error", () => finish("infra-failed", null));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { if (!proc.killed) proc.kill("SIGKILL"); } catch {}
      }, 5000).unref();
    }, timeoutMs).unref();

    const pollHandle = setInterval(() => {
      if (onCancel()) {
        cancelled = true;
        try { proc.kill("SIGTERM"); } catch {}
      }
    }, 200).unref();
  });
}

export { validateCwd };
