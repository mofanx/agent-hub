import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import spawnCross from "cross-spawn";
import type { CheckDefinition, CheckRun, CheckRunStatus, ProjectScope } from "./types.js";
import { validateCwd } from "./project.js";
import {
  DEFAULT_ENV_WHITELIST,
  checkRunId,
  type ExecutionProvider,
  SUMMARY_LIMIT,
} from "./execution.js";

/**
 * 检测 bwrap（bubblewrap）是否可用，用于 allowNetwork=false 时的网络隔离。
 * 缓存结果，避免重复 fork。
 */
let bwrapAvailable: boolean | undefined;
function isBwrapAvailable(): boolean {
  if (bwrapAvailable !== undefined) return bwrapAvailable;
  try {
    const result = spawnCross.sync("bwrap", ["--version"], { stdio: "pipe" });
    bwrapAvailable = result.status === 0;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/**
 * 构造 bwrap 网络隔离 argv：--unshare-net + 只读根绑定 + 可写 cwd。
 * 调用方需确保 bwrap 可用（isBwrapAvailable()）。
 */
function buildBwrapArgv(argv: string[], cwd: string): string[] {
  return [
    "bwrap",
    "--unshare-net",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", cwd, cwd,
    "--",
    ...argv,
  ];
}

/**
 * LocalExecutionProvider（设计文档 §8.1）。
 *
 * - shell:false，argv 直接传递；
 * - cwd realpath 校验，必须在 ProjectScope 内；
 * - stdout/stderr 流式写入 artifact 文件；
 * - timeout 先 SIGTERM，宽限期后 SIGKILL；
 * - cancel 标记为 cancelled 并杀进程；
 * - 环境变量白名单，不继承秘密值。
 */

export type LocalExecOptions = {
  /** artifact 根目录，默认 `<dataDir>/quality`。 */
  artifactRoot?: string | undefined;
  /** 环境变量白名单，默认 DEFAULT_ENV_WHITELIST。 */
  envWhitelist?: readonly string[] | undefined;
  /** timeout 后 SIGTERM 到 SIGKILL 的宽限期 ms，默认 5000。 */
  killGraceMs?: number | undefined;
  /** 额外注入的环境变量。 */
  extraEnv?: Record<string, string> | undefined;
};

type ActiveRun = {
  runId: string;
  checkId: string;
  proc: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
};

export class LocalExecutionProvider implements ExecutionProvider {
  private readonly artifactRoot: string;
  private readonly envWhitelist: readonly string[];
  private readonly killGraceMs: number;
  private readonly extraEnv: Record<string, string>;
  private readonly active = new Map<string, ActiveRun>();

  constructor(opts: LocalExecOptions = {}) {
    this.artifactRoot = opts.artifactRoot ?? path.resolve(process.cwd(), "data", "quality");
    this.envWhitelist = opts.envWhitelist ?? DEFAULT_ENV_WHITELIST;
    this.killGraceMs = opts.killGraceMs ?? 5000;
    this.extraEnv = opts.extraEnv ?? {};
  }

  /** 计算某次 check 的 artifact 目录。 */
  artifactDir(runId: string): string {
    return path.join(this.artifactRoot, runId, "checks");
  }

  async run(project: ProjectScope, check: CheckDefinition, runId: string): Promise<CheckRun> {
    const cwd = this.resolveCwd(project, check);
    const attempt = 1; // 由调用方在重试时传入更高 attempt，此处默认 1
    const id = checkRunId(runId, check.id, attempt);
    const dir = this.artifactDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const stdoutPath = path.join(dir, `${check.id}-${attempt}.stdout.log`);
    const stderrPath = path.join(dir, `${check.id}-${attempt}.stderr.log`);
    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];

    const env = this.buildEnv(check);
    const startedAt = Date.now();
    const status: CheckRunStatus = "running";
    let finalStatus: CheckRunStatus = status;

    // allowNetwork=false 时用 bwrap 隔离网络；bwrap 不可用则降级为记录警告
    const needIsolate = check.allowNetwork === false;
    let execArgv = check.argv;
    let networkIsolated = false;
    if (needIsolate) {
      if (isBwrapAvailable()) {
        execArgv = buildBwrapArgv(check.argv, cwd);
        networkIsolated = true;
      }
      // bwrap 不可用时不阻断执行，但会在 summary 中标注未隔离
    }

    const proc = spawnCross(execArgv[0]!, execArgv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }) as unknown as ChildProcess;

    const key = id;
    const active: ActiveRun = { runId, checkId: check.id, proc, cancelled: false, timedOut: false };
    this.active.set(key, active);

    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    let streamsDestroyed = false;
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf.push(chunk);
      if (!streamsDestroyed) stdoutStream.write(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf.push(chunk);
      if (!streamsDestroyed) stderrStream.write(chunk);
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    if (check.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        active.timedOut = true;
        this.gracefulKill(proc);
      }, check.timeoutMs);
    }

    const exitCode: number | null = await new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code));
      proc.on("error", () => resolve(-1));
    });

    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killTimer) clearTimeout(killTimer);
    streamsDestroyed = true;
    stdoutStream.destroy();
    stderrStream.destroy();
    await new Promise<void>((resolve) => {
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(); };
      stdoutStream.once("close", done);
      stderrStream.once("close", done);
    });
    this.active.delete(key);

    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;
    const stdoutFull = Buffer.concat(stdoutBuf).toString("utf8");
    const stderrFull = Buffer.concat(stderrBuf).toString("utf8");

    if (active.cancelled) {
      finalStatus = "cancelled";
    } else if (active.timedOut) {
      finalStatus = "timeout";
    } else if (exitCode === -1) {
      finalStatus = "infra-failed";
    } else if (exitCode === 0) {
      finalStatus = "passed";
    } else {
      finalStatus = "failed";
    }

    const summary = buildSummary(stdoutFull, stderrFull, finalStatus, exitCode)
      + (needIsolate ? (networkIsolated ? " [net-isolated]" : " [net-isolate-unavailable]") : "");

    const result: CheckRun = {
      id,
      runId,
      checkId: check.id,
      attempt,
      status: finalStatus,
      startedAt,
      completedAt,
      durationMs,
      summary,
      stdoutArtifact: stdoutPath,
      stderrArtifact: stderrPath,
    };
    if (exitCode !== null && exitCode !== -1) result.exitCode = exitCode;
    return result;
  }

  async cancel(runId: string, checkId?: string): Promise<void> {
    for (const [key, active] of [...this.active.entries()]) {
      if (active.runId !== runId) continue;
      if (checkId && active.checkId !== checkId) continue;
      active.cancelled = true;
      this.gracefulKill(active.proc);
      this.active.delete(key);
    }
  }

  private resolveCwd(project: ProjectScope, check: CheckDefinition): string {
    const raw = path.isAbsolute(check.cwd) ? check.cwd : path.join(project.root, check.cwd);
    return validateCwd(project, raw);
  }

  /**
   * 构造子进程环境变量。
   * - 基础白名单（DEFAULT_ENV_WHITELIST 或自定义 envWhitelist）始终注入；
   * - check.envNames 中指定的额外变量从 process.env 注入；
   * - extraEnv 始终注入（Hub 配置）；
   * - allowNetwork=false 时通过 bwrap --unshare-net 隔离网络（bwrap 不可用则降级为记录）。
   */
  private buildEnv(check?: CheckDefinition): Record<string, string> {
    const env: Record<string, string> = {};
    for (const k of this.envWhitelist) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    if (check?.envNames) {
      for (const k of check.envNames) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }
    }
    for (const [k, v] of Object.entries(this.extraEnv)) env[k] = v;
    return env;
  }

  private gracefulKill(proc: ChildProcess): void {
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, this.killGraceMs).unref();
  }
}

/** 构造截断摘要：包含 status、exitCode 和输出尾部。 */
export function buildSummary(
  stdout: string,
  stderr: string,
  status: CheckRunStatus,
  exitCode: number | null,
): string {
  const tail = (stderr.trim() || stdout.trim()).slice(-SUMMARY_LIMIT);
  return `[${status}] exit=${exitCode ?? "n/a"}\n${tail}`;
}
