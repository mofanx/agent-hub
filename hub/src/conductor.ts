import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { isEventAction, type Room, type RoomManager } from "./room.js";
import { logError, logWarn } from "./logger.js";
import type { Store } from "./store.js";
import {
  PLAN_FORMAT_FIX_PROMPT,
  conductorMemberList,
  conductorPlanningPrompt,
  conductorReviewPrompt,
  conductorSummarizePrompt,
  describeAutomaticCheck,
  helpRequestPrompt,
  helpResumePrompt,
  peerReviewTaskDescription,
  planExample,
  workerTaskPrompt,
  type OpenTopicInput,
} from "./prompts.js";

export type PromptContent = Array<Record<string, unknown>>;

export interface AgentOps {
  prompt(sessionId: string, content: string | PromptContent): Promise<void>;
  isBusy(sessionId: string): boolean;
  /** 会话是否仍存在（被删除的会话返回 false），用于编排恢复时识别失效成员 */
  has?(sessionId: string): boolean;
  cwd?(sessionId: string): string | undefined;
  runIsolatedCheck?(cwd: string, command: string): Promise<IsolatedCheckResult>;
}

type TaskArtifact = {
  type: "file" | "event";
  /** 事件动作，如 command / test / note / delete / rename */
  action?: string | undefined;
  path?: string | undefined;
  summary: string;
  /** 完整文本内容，仅用于 diff/file 这类需要预览时回显的场景 */
  content?: string | undefined;
};

export type VerificationEvidence = {
  summary?: string;
  baseline?: string;
  diff?: string;
  reproSteps?: string[];
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  artifactRefs?: string[];
};

export type TaskVerificationEvidence = VerificationEvidence;

type TaskResult = {
  text: string;
  artifacts: TaskArtifact[];
  /** 实现者为可复核交付提交的证据 */
  baseline?: string;
  diff?: string;
  reproSteps?: string[];
  verifyCommand?: string;
  verifyExitCode?: number;
  verifyStdout?: string;
  verifyStderr?: string;
  verifyCheckId?: string;
  verifyCheckIdProvided?: boolean;
  /** 对其他任务的独立验证声明（verify 字段） */
  verifications?: { taskId: string; verdict: string; evidence: VerificationEvidence }[];
};

type FlowPhase = "planning" | "awaiting-input" | "working" | "reviewing" | "summarizing" | "awaiting-retry" | "done";

type ParsedTask = { id?: string; to: string; task: string; dependsOn?: string[] };
type ConductorPlan = {
  goal?: string | undefined;
  acceptanceCriteria: string[];
  tasks: ParsedTask[];
  questions: string[];
};
type ReviewDecision =
  | { decision: "complete"; reason: string }
  | { decision: "continue"; reason: string; tasks: ParsedTask[] };

/** 其他成员对某个任务的独立验证记录 */
export type TaskVerification = {
  by: string;
  verdict: string;
  evidence: VerificationEvidence;
  at: number;
  backendToolCallId?: string;
};

type BackendToolRun = {
  toolCallId: string;
  commandHash?: string;
  status: "completed" | "failed";
  exitCode?: number;
  stdoutHash?: string;
  stderrHash?: string;
  at: number;
};

type AutomaticCheck =
  | IsolatedCheckResult
  | {
      status: "blocked";
      runner: "bubblewrap";
      reason: string;
      detail?: string;
      startedAt: number;
      finishedAt: number;
    };

type PendingToolCall = {
  roomId: string;
  taskId: string;
  commandHash?: string;
  exitCode?: number;
  stdoutHash?: string;
  stderrHash?: string;
};

/** 任务执行中的定向求助交换：worker 提问 → 目标成员/用户回复 → 唤醒原 worker 继续 */
type HelpExchange = {
  id: string;
  taskId: string;
  from: string;
  /** 成员 sessionId，或 "user" 表示向用户求助 */
  to: string;
  question: string;
  /** 求助发起时的输出摘录，随求助一起转发给目标 */
  context?: string;
  answer?: string;
  status: "pending" | "answered";
  /** 是否已向目标成员发出求助 prompt */
  dispatched: boolean;
};

type Supplement = { text: string; at: number };

type FlowTask = {
  id: string;
  sessionId: string;
  task: string;
  dependsOn: string[];
  status: "pending" | "running" | "done" | "failed";
  iteration: number;
  failureMessage?: string;
  retries?: number;
  /** 已发起的求助轮数（上限 MAX_HELP_ROUNDS） */
  helpRounds?: number;
  /** 等待中的求助交换 id */
  waitingForHelp?: string;
  /** 其他成员对本任务的独立验证记录 */
  verifications?: TaskVerification[];
  backendRuns?: BackendToolRun[];
  automaticCheck?: AutomaticCheck;
  /** 最近一次派发时刻（重试/恢复会刷新），用于过程钻取的时间窗下界 */
  dispatchedAt?: number;
  /** 进入终态（done/failed）的时刻，作为过程钻取窗口上界 */
  finishedAt?: number;
  /** 最近一次派发失败时刻（重试链统计用，成功派发清零） */
  lastRetryAt?: number;
};

type Flow = {
  /** 编排实例 id（fl-<startedAt>-<seq>），消息时间线卡片的配对键 */
  id: string;
  roomId: string;
  startedAt: number;
  /** 对应房史 kind:"flow" 卡条目 rowId，随快照持久化供重启后继续覆写 */
  cardRowId?: number;
  phase: FlowPhase;
  goal: string;
  acceptanceCriteria: string[];
  iteration: number;
  maxIterations: number;
  /** 已派发任务批次数（初始派工 + 每次验收 continue），上限 maxRounds */
  rounds: number;
  /** 跟进派发轮次上限：超限置 awaiting-retry 交还用户 */
  maxRounds: number;
  /** 任务以 taskId 为 key */
  tasks: Map<string, FlowTask>;
  /** 结果以 taskId 为 key */
  results: Map<string, TaskResult>;
  artifactContext?: { refs?: string[] } | undefined;
  /** 创建本 flow 的 mission id：mission 恢复/同步只认领归属自己的 flow */
  missionId?: string | undefined;
  reviewReason?: string;
  /** 用户在流程执行中补充的信息，并入后续派发/验收/汇总 prompt */
  supplements: Supplement[];
  /** 任务执行中的定向求助交换 */
  help: Map<string, HelpExchange>;
  /** 是否已有求助派发重试定时器在跑 */
  helpRetrying?: boolean;
  /** 派发失败滑动窗口（时间戳）：窗口内累计超限触发交还用户 */
  retryWindow?: number[] | undefined;
  /** 重试/重排定时器句柄集合：done/cancelled/删除时统一 clear 防悬挂 */
  retryTimers?: Set<ReturnType<typeof setTimeout>> | undefined;
  clarification?: { id: string; questions: string[] };
  clarificationAsked?: boolean;
  clarificationAnswer?: string;
  challengeScheduled?: boolean;
  challengeTaskId?: string;
  planFormatRetries: number;
  /** 进入 done 终态的时刻；话题归档窗口（startedAt, finishedAt] 上界 */
  finishedAt?: number;
};

export type ConductorNotice = {
  roomId: string;
  message: string;
  /** 结构化卡片 meta（如派工任务清单），随 room.notice 下发供 Hub 落 process 条目 */
  meta?: Record<string, unknown>;
};

const PLAN_RESULT_LEN = 4000;
const MAX_ITERATIONS = 3;
const DEFAULT_MAX_ROUNDS = 8;
const MAX_HELP_ROUNDS = 2;
const DEFAULT_ACCEPTANCE_CRITERIA = ["交付结果满足用户目标，并包含必要的实现与验证证据"];
const BUSY_RETRY_MS = 5000;
/** 派发失败重试链：同一 task 连续失败上限（超限标 failed 并交还用户） */
const DISPATCH_RETRY_TASK_MAX = 3;
/** flow 级滑动窗口：窗口内累计失败超上限同样交还用户（防多任务轮换失败造成的重试风暴） */
const DISPATCH_RETRY_WINDOW_MS = 10 * 60 * 1000;
const DISPATCH_RETRY_WINDOW_MAX = 8;

const PROMPT_RETRY_MS = 5000;
const SUMMARIZE_RETRY_MS = 5000;
const TOOL_CALL_ID_MAX = 128;
const TOOL_COMMAND_MAX = 8192;
const TOOL_OUTPUT_MAX = 262144;
const MAX_BACKEND_RUNS = 20;
const MAX_PENDING_TOOL_CALLS = 20;
/** 工作区快照哈希跨调用 TTL：getFlow 每次 flowUpdate 不再全树遍历 */
const SNAPSHOT_HASH_TTL_MS = 4000;
const SNAPSHOT_HASH_CACHE_MAX = 64;

/** snapshot 哈希 worker：常驻复用单例；创建失败/崩溃后永久回退同步计算 */
type SnapshotReply = { id: number; hash?: string; fp?: Map<string, string>; error?: boolean };
const SNAP_WORKER_TIMEOUT_MS = 40_000;
let snapWorker: Worker | null | undefined;
let snapWorkerSeq = 0;
const snapWorkerPending = new Map<number, (r: SnapshotReply) => void>();

function snapshotWorkerClient(): Worker | null {
  if (snapWorker !== undefined) return snapWorker;
  try {
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const w = new Worker(new URL(`./snapshot-worker.${ext}`, import.meta.url), {
      // 继承 tsx/loader 注册参数让 worker 能加载 .ts；只剔除测试运行器参数，
      // 其余原样保留（--import/--require 与其值成对出现，拆对会触发 ERR_WORKER_INVALID_EXEC_ARGV）
      execArgv: process.execArgv.filter((a) => a !== "--test" && !a.startsWith("--test-")),
    });
    w.on("message", (r: SnapshotReply) => {
      const cb = snapWorkerPending.get(r.id);
      if (cb) {
        snapWorkerPending.delete(r.id);
        cb(r);
      }
    });
    const dead = () => {
      if (snapWorker !== w) return;
      snapWorker = null;
      for (const cb of snapWorkerPending.values()) cb({ id: -1, error: true });
      snapWorkerPending.clear();
    };
    w.on("error", dead);
    w.on("exit", dead);
    w.unref();
    snapWorker = w;
  } catch {
    snapWorker = null;
  }
  return snapWorker;
}

/** 异步计算快照哈希+指纹；已调度返回 true，worker 不可用返回 false（调用方回退同步） */
function requestWorkspaceSnapshot(
  cwd: string,
  done: (hash: string | undefined, fp: Map<string, string> | undefined) => void,
): boolean {
  const w = snapshotWorkerClient();
  if (!w) return false;
  const id = ++snapWorkerSeq;
  const timer = setTimeout(() => {
    snapWorkerPending.delete(id);
    done(undefined, undefined);
  }, SNAP_WORKER_TIMEOUT_MS);
  timer.unref();
  snapWorkerPending.set(id, (r) => {
    clearTimeout(timer);
    done(r.error ? undefined : r.hash, r.fp);
  });
  try {
    w.postMessage({ id, cwd });
  } catch {
    snapWorkerPending.delete(id);
    clearTimeout(timer);
    return false;
  }
  return true;
}
const ISOLATED_CHECK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ISOLATED_CHECK_MAX = 32;
const PLAN_FORMAT_RETRY_LIMIT = 1;

export function parseIsolatedChecks(
  raw: string | undefined,
): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === "") return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    logWarn("hub", "HUB_ISOLATED_CHECKS is not valid JSON; isolated checks disabled");
    return {};
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    logWarn("hub", "HUB_ISOLATED_CHECKS must be a JSON object; isolated checks disabled");
    return {};
  }
  const entries = Object.entries(obj);
  const invalid = (): Record<string, string> => {
    logWarn("hub", "HUB_ISOLATED_CHECKS has invalid entries; isolated checks disabled");
    return {};
  };
  if (entries.length > ISOLATED_CHECK_MAX) return invalid();
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ISOLATED_CHECK_ID_RE.test(key) || typeof value !== "string") return invalid();
    const cmd = value.trim();
    if (!cmd || cmd.length > 256 || /[\r\n]/.test(cmd)) return invalid();
    out[key] = cmd;
  }
  return out;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function sanitizeAutomaticCheck(v: unknown): AutomaticCheck | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const status = String(o.status ?? "");
  if (
    status !== "exited_zero" &&
    status !== "exited_nonzero" &&
    status !== "blocked" &&
    status !== "timed_out"
  ) {
    return undefined;
  }
  if (o.runner !== "bubblewrap") return undefined;
  const hex64 = (x: unknown): x is string =>
    typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
  for (const h of ["commandHash", "snapshotHash", "stdoutHash", "stderrHash"] as const) {
    if (o[h] !== undefined && !hex64(o[h])) return undefined;
  }
  if (status === "exited_zero" && (o.exitCode !== 0 || !hex64(o.snapshotHash))) {
    return undefined;
  }
  if (status === "exited_nonzero" && !Number.isInteger(o.exitCode)) return undefined;
  const reason = typeof o.reason === "string" && /^[a-z_]+$/.test(o.reason) ? o.reason : undefined;
  const detail = typeof o.detail === "string" ? o.detail : undefined;
  const startedAt = Number(o.startedAt ?? 0);
  const finishedAt = Number(o.finishedAt ?? 0);
  if (status === "blocked" && o.commandHash === undefined) {
    return {
      status: "blocked",
      runner: "bubblewrap",
      reason: reason ?? "unknown",
      ...(detail ? { detail } : {}),
      startedAt,
      finishedAt,
    };
  }
  if (o.commandHash === undefined) return undefined;
  return {
    status: status as IsolatedCheckResult["status"],
    runner: "bubblewrap",
    commandHash: o.commandHash as string,
    ...(hex64(o.snapshotHash) ? { snapshotHash: o.snapshotHash } : {}),
    ...(Number.isInteger(o.exitCode) ? { exitCode: o.exitCode as number } : {}),
    ...(hex64(o.stdoutHash) ? { stdoutHash: o.stdoutHash } : {}),
    ...(hex64(o.stderrHash) ? { stderrHash: o.stderrHash } : {}),
    ...(o.stdoutTruncated === true ? { stdoutTruncated: true } : {}),
    ...(o.stderrTruncated === true ? { stderrTruncated: true } : {}),
    startedAt,
    finishedAt,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

type BackendClaimStatus =
  | "matched"
  | "missing_member_command"
  | "missing_member_exit_code"
  | "no_completed_backend_run"
  | "backend_exit_unknown"
  | "backend_mismatch";

function backendClaimStatus(task: FlowTask, result: TaskResult | undefined): BackendClaimStatus {
  const command = result?.verifyCommand?.trim();
  if (!command) return "missing_member_command";
  const exitCode = result?.verifyExitCode;
  if (exitCode === undefined) return "missing_member_exit_code";
  const commandHash = sha256Hex(command);
  const stdoutHash = result?.verifyStdout ? sha256Hex(result.verifyStdout) : undefined;
  const stderrHash = result?.verifyStderr ? sha256Hex(result.verifyStderr) : undefined;
  const completed = (task.backendRuns ?? []).filter((r) => r.status === "completed");
  if (completed.length === 0) return "no_completed_backend_run";
  if (
    completed.some(
      (r) =>
        r.commandHash === commandHash &&
        r.exitCode === exitCode &&
        (stdoutHash === undefined || r.stdoutHash === stdoutHash) &&
        (stderrHash === undefined || r.stderrHash === stderrHash),
    )
  ) {
    return "matched";
  }
  const sameCommand = completed.filter((r) => r.commandHash === commandHash);
  if (
    sameCommand.length > 0 &&
    sameCommand.every((r) => r.exitCode === undefined) &&
    sameCommand.some(
      (r) =>
        (stdoutHash === undefined || r.stdoutHash === stdoutHash) &&
        (stderrHash === undefined || r.stderrHash === stderrHash),
    )
  ) {
    return "backend_exit_unknown";
  }
  return "backend_mismatch";
}

function normalizeEvidence(raw: unknown): VerificationEvidence {
  if (typeof raw === "string" && raw.trim()) return { summary: raw.trim() };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const strArr = (key: string) =>
      Array.isArray(o[key]) ? o[key].filter((x): x is string => typeof x === "string") : undefined;
    const num = (key: string) =>
      typeof o[key] === "number" ? (o[key] as number) : undefined;
    const str = (key: string) =>
      typeof o[key] === "string" ? (o[key] as string) : undefined;
    const evidence: VerificationEvidence = {};
    const summary = str("summary");
    if (summary) evidence.summary = summary;
    const baseline = str("baseline");
    if (baseline) evidence.baseline = baseline;
    const diff = str("diff");
    if (diff) evidence.diff = diff;
    const reproSteps = strArr("reproSteps");
    if (reproSteps?.length) evidence.reproSteps = reproSteps;
    const command = str("command");
    if (command) evidence.command = command;
    const exitCode = num("exitCode");
    if (exitCode !== undefined) evidence.exitCode = exitCode;
    const stdout = str("stdout");
    if (stdout) evidence.stdout = stdout;
    const stderr = str("stderr");
    if (stderr) evidence.stderr = stderr;
    const artifactRefs = strArr("artifactRefs");
    if (artifactRefs?.length) evidence.artifactRefs = artifactRefs;
    return evidence;
  }
  return {};
}

function summarizeEvidence(ev: VerificationEvidence): string {
  const parts: string[] = [];
  if (ev.summary) parts.push(ev.summary);
  if (ev.command) parts.push(`cmd: ${ev.command}`);
  if (ev.exitCode !== undefined) parts.push(`exit=${ev.exitCode}`);
  if (ev.stdout) parts.push(ev.stdout.slice(0, 120));
  if (ev.stderr) parts.push(`stderr: ${ev.stderr.slice(0, 120)}`);
  return parts.join("；") || "无证据详情";
}

let flowSeq = 0;

/** 编排实例 id：fl-<毫秒>-<进程内递增序号>，消息时间线卡片的配对键 */
export function newFlowId(): string {
  return `fl-${Date.now()}-${++flowSeq}`;
}

export class ConductorOrchestrator {
  private flows = new Map<string, Flow>();
  private pendingToolCalls = new Map<string, Map<string, PendingToolCall>>();
  /** cwd → {at, hash, fp}：快照哈希跨调用缓存。命中需同时满足 TTL 窗口内 +
   * 廉价指纹未变（fp 为递归 lstat 遍历，无 git spawn、不读内容）；指纹失配即回退
   * 全量哈希，保证 snapshotCurrent 不因缓存对工作区变化撒谎 */
  private snapHashCache = new Map<
    string,
    { at: number; hash: string | undefined; fp: Map<string, string> | undefined }
  >();
  private readonly promptRetryMs: number;
  private readonly emitFlow: ((roomId: string) => void) | undefined;
  private store?: Store;

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly notice: (n: ConductorNotice) => void,
    emitFlow?: (roomId: string) => void,
    promptRetryMs?: number,
    private readonly isolatedChecks: Readonly<Record<string, string>> = {},
  ) {
    this.emitFlow = emitFlow;
    this.promptRetryMs = promptRetryMs ?? PROMPT_RETRY_MS;
  }

  setStore(store: Store): void {
    this.store = store;
  }

  /** turn 游标登记钩子（RoomModeManager 注入）：每次外发 prompt 前记录上下文游标；可返回发送失败时的清理函数 */
  private turnGuard?: (
    sessionId: string,
    roomId: string,
    content: string | PromptContent,
  ) => (() => void) | void;

  setTurnGuard(
    fn: (sessionId: string, roomId: string, content: string | PromptContent) => (() => void) | void,
  ): void {
    this.turnGuard = fn;
  }

  private sendPrompt(roomId: string, sessionId: string, content: string | PromptContent): Promise<void> {
    const unguard = this.turnGuard?.(sessionId, roomId, content);
    return this.agent.prompt(sessionId, content).catch((err: unknown) => {
      // 发送即失败（session 未知/忙碌）：不会有 prompt.done/error 事件兜底，回收游标登记
      unguard?.();
      throw err;
    });
  }

  hasActiveFlow(roomId: string): boolean {
    const flow = this.flows.get(roomId);
    return flow !== undefined && flow.phase !== "done";
  }

  clearCompleted(roomId: string): void {
    const flow = this.flows.get(roomId);
    if (flow?.phase !== "done") return;
    this.removeFlow(roomId);
    this.emitFlow?.(roomId);
  }

  /** 强制中断某个房间的指挥编排 */
  cancel(roomId: string, reason?: string): string[] {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase === "done") return [];
    const touched = new Set<string>();
    for (const t of flow.tasks.values()) {
      if (t.status === "pending" || t.status === "running") {
        touched.add(t.sessionId);
      }
    }
    this.removeFlow(roomId);
    this.planningInFlight.delete(roomId);
    for (const sid of touched) this.pendingToolCalls.delete(sid);
    this.emitFlow?.(roomId);
    if (reason) this.notice({ roomId, message: reason });
    return [...touched];
  }

  /** 房间删除/解散：无条件清掉该房间的 flow、planning 标记与 pendingToolCalls 残留 */
  dropRoom(roomId: string): void {
    const hadFlow = this.removeFlow(roomId);
    const hadPlanning = this.planningInFlight.delete(roomId);
    for (const [sid, m] of this.pendingToolCalls) {
      for (const [tid, p] of m) if (p.roomId === roomId) m.delete(tid);
      if (m.size === 0) this.pendingToolCalls.delete(sid);
    }
    if (hadFlow || hadPlanning) this.emitFlow?.(roomId);
  }

  observeToolUpdate(sessionId: string, update: unknown): void {
    if (typeof update !== "object" || update === null) return;
    const u = update as Record<string, unknown>;
    const sessionUpdate = String(u.sessionUpdate ?? "");
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") return;
    const toolCallId = typeof u.toolCallId === "string" ? u.toolCallId : "";
    if (!toolCallId || toolCallId.length > TOOL_CALL_ID_MAX) return;
    const kind = typeof u.kind === "string" ? u.kind : undefined;
    const status = typeof u.status === "string" ? u.status : "";
    const map = this.pendingToolCalls.get(sessionId);
    const existing = map?.get(toolCallId);
    if (!existing) {
      if (status !== "" && status !== "pending" && status !== "in_progress") return;
      if (kind !== "execute") return;
      const active = this.activeWorkerTask(sessionId);
      if (!active) return;
      const rawInput = u.rawInput;
      const command =
        typeof rawInput === "object" && rawInput !== null
          ? (rawInput as Record<string, unknown>).command
          : undefined;
      if (typeof command !== "string") return;
      const trimmed = command.trim();
      if (!trimmed || trimmed.length > TOOL_COMMAND_MAX) return;
      const p: PendingToolCall = {
        roomId: active.flow.roomId,
        taskId: active.task.id,
        commandHash: sha256Hex(trimmed),
      };
      this.applyRawOutputPatch(p, u);
      let m = map;
      if (!m) {
        m = new Map();
        this.pendingToolCalls.set(sessionId, m);
      }
      if (m.size >= MAX_PENDING_TOOL_CALLS) return;
      m.set(toolCallId, p);
      return;
    }
    if (kind !== undefined && kind !== "execute") {
      map!.delete(toolCallId);
      return;
    }
    this.applyRawInputPatch(existing, u);
    this.applyRawOutputPatch(existing, u);
    if (status !== "completed" && status !== "failed") return;
    map!.delete(toolCallId);
    const active = this.activeWorkerTask(sessionId);
    if (!active || active.task.id !== existing.taskId || active.flow.roomId !== existing.roomId) {
      return;
    }
    const runs = (active.task.backendRuns ??= []);
    runs.push({
      toolCallId,
      ...(existing.commandHash ? { commandHash: existing.commandHash } : {}),
      status,
      ...(existing.exitCode !== undefined ? { exitCode: existing.exitCode } : {}),
      ...(existing.stdoutHash !== undefined ? { stdoutHash: existing.stdoutHash } : {}),
      ...(existing.stderrHash !== undefined ? { stderrHash: existing.stderrHash } : {}),
      at: Date.now(),
    });
    if (runs.length > MAX_BACKEND_RUNS) runs.splice(0, runs.length - MAX_BACKEND_RUNS);
    this.emitFlow?.(active.flow.roomId);
  }

  private applyRawInputPatch(p: PendingToolCall, u: Record<string, unknown>): void {
    if (!("rawInput" in u)) return;
    delete p.commandHash;
    const rawInput = u.rawInput;
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return;
    const command = (rawInput as Record<string, unknown>).command;
    if (typeof command !== "string") return;
    const trimmed = command.trim();
    if (trimmed && trimmed.length <= TOOL_COMMAND_MAX) {
      p.commandHash = sha256Hex(trimmed);
    }
  }

  private applyRawOutputPatch(p: PendingToolCall, u: Record<string, unknown>): void {
    if (!("rawOutput" in u)) return;
    delete p.exitCode;
    delete p.stdoutHash;
    delete p.stderrHash;
    const rawOutput = u.rawOutput;
    if (typeof rawOutput !== "object" || rawOutput === null || Array.isArray(rawOutput)) return;
    const ro = rawOutput as Record<string, unknown>;
    if (
      typeof ro.exitCode === "number" &&
      Number.isInteger(ro.exitCode) &&
      ro.exitCode >= 0 &&
      ro.exitCode <= 255
    ) {
      p.exitCode = ro.exitCode;
    }
    if (typeof ro.stdout === "string" && ro.stdout.length <= TOOL_OUTPUT_MAX) {
      p.stdoutHash = sha256Hex(ro.stdout);
    }
    if (typeof ro.stderr === "string" && ro.stderr.length <= TOOL_OUTPUT_MAX) {
      p.stderrHash = sha256Hex(ro.stderr);
    }
  }

  private async maybeIsolatedCheck(
    flow: Flow,
    sessionId: string,
    task: FlowTask,
    result: TaskResult,
  ): Promise<void> {
    const runner = this.agent.runIsolatedCheck;
    if (!runner || task.automaticCheck !== undefined) return;
    const command = result.verifyCommand?.trim();
    if (!command) return;
    if (!result.artifacts.some((a) => a.type === "file") && !result.verifyCheckId) return;
    const cwd = this.agent.cwd?.(sessionId);
    const startedAt = Date.now();
    const staticBlocked = (reason: string): AutomaticCheck => ({
      status: "blocked",
      runner: "bubblewrap",
      reason,
      startedAt,
      finishedAt: Date.now(),
    });
    const preset = result.verifyCheckIdProvided
      ? result.verifyCheckId &&
        Object.hasOwn(this.isolatedChecks, result.verifyCheckId)
        ? this.isolatedChecks[result.verifyCheckId]
        : undefined
      : Object.values(this.isolatedChecks).find(
          (approved) => approved === command,
        );
    let check: AutomaticCheck;
    if (!preset) {
      check = staticBlocked("check_unapproved");
    } else if (preset.trim() !== command) {
      check = staticBlocked("command_mismatch");
    } else if (!cwd) {
      check = staticBlocked("cwd_missing");
    } else {
      try {
        check = await runner(cwd, preset.trim());
      } catch {
        check = staticBlocked("start_failed");
      }
    }
    if (
      this.flows.get(flow.roomId) !== flow ||
      task.status !== "running" ||
      task.sessionId !== sessionId
    ) {
      return;
    }
    task.automaticCheck = check;
    const exitCode = "exitCode" in check ? check.exitCode : undefined;
    const snapshot = "snapshotHash" in check ? check.snapshotHash : undefined;
    const detail = "detail" in check && check.detail ? `, detail=${check.detail.slice(0, 200)}` : "";
    this.rooms.addEvent(flow.roomId, {
      author: this.rooms.displayNameForId(flow.roomId, sessionId),
      action: "test",
      summary: `隔离检查 [${task.id}]：${check.status}（exit=${exitCode ?? "unknown"}, snapshot=${snapshot?.slice(0, 12) ?? "none"}${detail}）`,
      taskId: task.id,
    });
    this.emitFlow?.(flow.roomId);
  }

  private activeWorkerTask(sessionId: string): { flow: Flow; task: FlowTask } | undefined {
    let found: { flow: Flow; task: FlowTask } | undefined;
    for (const flow of this.flows.values()) {
      for (const t of flow.tasks.values()) {
        if (t.sessionId === sessionId && t.status === "running" && !t.waitingForHelp) {
          if (found) return undefined;
          found = { flow, task: t };
        }
      }
    }
    return found;
  }

  /** 登记重试/重排定时器到 flow，done/cancelled/删除时统一清理防悬挂 */
  private trackFlowTimer(flow: Flow, timer: ReturnType<typeof setTimeout>): void {
    (flow.retryTimers ??= new Set()).add(timer);
  }

  private clearFlowRetryTimers(flow: Flow): void {
    if (!flow.retryTimers) return;
    for (const t of flow.retryTimers) clearTimeout(t);
    flow.retryTimers.clear();
  }

  private removeFlow(roomId: string): boolean {
    const f = this.flows.get(roomId);
    if (f) this.clearFlowRetryTimers(f);
    return this.flows.delete(roomId);
  }

  /** 追踪式重排：登记句柄并在回调前确认 flow 仍存在且未终态 */
  private scheduleReschedule(flow: Flow, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      flow.retryTimers?.delete(timer);
      const f = this.flows.get(flow.roomId);
      if (f !== flow || f.phase === "done") return;
      run();
    }, ms);
    timer.unref();
    this.trackFlowTimer(flow, timer);
  }

  /** 交还用户：复用 maxRounds 的 awaiting-retry 语义（waitingFor=user 由快照层派生） */
  private handbackFlowToUser(flow: Flow, reason: string): void {
    flow.phase = "awaiting-retry";
    this.clearFlowRetryTimers(flow);
    this.emitFlow?.(flow.roomId);
    this.notice({ roomId: flow.roomId, message: reason });
  }

  /**
   * 派发失败计数：同 task 连续 3 次（标 failed）或 flow 滑动窗口内累计 8 次 → 交还用户。
   * 计数挂在 task/flow 上，agent 重连/断线不重置。返回 true 表示已交还（调用方不再排重试）。
   */
  private noteDispatchFailure(flow: Flow, task: FlowTask, msg: string): boolean {
    const now = Date.now();
    task.retries = (task.retries ?? 0) + 1;
    task.lastRetryAt = now;
    const win = (flow.retryWindow ??= []);
    win.push(now);
    while (win.length > 0 && now - win[0]! > DISPATCH_RETRY_WINDOW_MS) win.shift();
    if (task.retries >= DISPATCH_RETRY_TASK_MAX) {
      task.status = "failed";
      task.failureMessage = msg;
      task.finishedAt = now;
      this.handbackFlowToUser(
        flow,
        `子任务 ${task.id} 连续派发失败 ${task.retries} 次（${msg.slice(0, 200)}），发送"重试"重新派发失败任务，或发送新消息继续`,
      );
      return true;
    }
    if (win.length >= DISPATCH_RETRY_WINDOW_MAX) {
      this.handbackFlowToUser(
        flow,
        `派发失败次数超过安全上限（${win.length} 次/10 分钟），发送"重试"重新派发失败任务，或发送新消息继续`,
      );
      return true;
    }
    return false;
  }

  private fingerprintMatches(cwd: string, cached: Map<string, string>): boolean {
    const cur = workspaceFingerprint(cwd);
    if (!cur || cur.size !== cached.size) return false;
    for (const [k, v] of cur) {
      if (cached.get(k) !== v) return false;
    }
    return true;
  }

  /** cwd → 已派发给 worker 的在途重算任务（同 cwd 去重） */
  private readonly snapInflight = new Set<string>();

  private workspaceHashCached(cwd: string): string | undefined {
    const hit = this.snapHashCache.get(cwd);
    const now = Date.now();
    if (
      hit &&
      now - hit.at < SNAPSHOT_HASH_TTL_MS &&
      hit.fp !== undefined &&
      this.fingerprintMatches(cwd, hit.fp)
    ) {
      return hit.hash;
    }
    // 指纹不可读的缓存退化为纯 TTL 复用，避免每调用重发 worker 任务
    if (hit && hit.fp === undefined && now - hit.at < SNAPSHOT_HASH_TTL_MS) return hit.hash;
    if (hit) {
      // 有旧值但指纹失配/过期：worker 异步重算，回填前返回 undefined（保守报"未核对"）
      if (!this.snapInflight.has(cwd)) {
        const scheduled = requestWorkspaceSnapshot(cwd, (hash, fp) => {
          this.snapInflight.delete(cwd);
          this.snapHashCache.set(cwd, { at: Date.now(), hash, fp });
          // 回填后立即重广播 flow，snapshotCurrent 不必等下一个自然事件
          for (const roomId of this.flows.keys()) this.emitFlow?.(roomId);
        });
        if (scheduled) {
          this.snapInflight.add(cwd);
          return undefined;
        }
      } else {
        return undefined;
      }
    }
    // 无缓存冷启动 / worker 不可用：同步计算，保持首算即时的既有语义
    const hash = workspaceSnapshotHash(cwd);
    const fp = workspaceFingerprint(cwd);
    if (!hit && this.snapHashCache.size >= SNAPSHOT_HASH_CACHE_MAX) {
      const oldest = this.snapHashCache.keys().next().value;
      if (oldest !== undefined) this.snapHashCache.delete(oldest);
    }
    this.snapHashCache.set(cwd, { at: now, hash, fp });
    return hash;
  }

  /** 获取可用于前端展示的 flow 状态 */
  private snapshotCurrentFor(
    task: FlowTask,
    cache: Map<string, string | undefined>,
  ): boolean | undefined {
    const c = task.automaticCheck;
    if (!c || c.status === "blocked") return undefined;
    const snap = "snapshotHash" in c ? c.snapshotHash : undefined;
    if (typeof snap !== "string" || !/^[0-9a-f]{64}$/.test(snap)) return undefined;
    const cwd = this.agent.cwd?.(task.sessionId);
    if (!cwd) return false;
    if (!cache.has(cwd)) cache.set(cwd, this.workspaceHashCached(cwd));
    const cur = cache.get(cwd);
    return cur !== undefined && cur === snap;
  }

  getFlow(roomId: string): Record<string, unknown> | undefined {
    const flow = this.flows.get(roomId);
    if (!flow) return undefined;
    const hashCache = new Map<string, string | undefined>();
    const tasks = [...flow.tasks.values()].map((t) => {
      const result = flow.results.get(t.id);
      const waiting = t.waitingForHelp ? flow.help.get(t.waitingForHelp) : undefined;
      const verdicts = (t.verifications ?? []).map((v) => v.verdict.trim().toLowerCase());
      const claimStatus = backendClaimStatus(t, result);
      const verificationStatus =
        verdicts.length === 0
          ? "unverified"
          : verdicts.some((v) => v !== "pass")
            ? "member_nonpass"
            : "member_pass";
      return {
        id: t.id,
        sessionId: t.sessionId,
        name: this.rooms.displayNameForId(flow.roomId, t.sessionId),
        status: t.status,
        task: t.task,
        dependsOn: t.dependsOn,
        iteration: t.iteration,
        ...(t.dispatchedAt !== undefined ? { dispatchedAt: t.dispatchedAt } : {}),
        ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
        verificationStatus,
        automaticCheck: (() => {
          const ac = t.automaticCheck ?? { status: "not_run" };
          const sc = this.snapshotCurrentFor(t, hashCache);
          return sc === undefined ? ac : { ...ac, snapshotCurrent: sc };
        })(),
        artifacts: result?.artifacts ?? [],
        ...(waiting
          ? {
              waitingFor:
                waiting.to === "user"
                  ? "user"
                  : this.rooms.displayNameForId(flow.roomId, waiting.to),
              waitingQuestion: waiting.question.slice(0, 200),
              waitingHelpId: waiting.id,
            }
          : {}),
        ...(t.verifications?.length
          ? {
              verifications: t.verifications.map((v) => ({
                by: this.rooms.displayNameForId(flow.roomId, v.by),
                verdict: v.verdict,
                evidence: summarizeEvidence(v.evidence).slice(0, 500),
                evidenceDetail: v.evidence,
                ...(v.backendToolCallId ? { backendToolCallId: v.backendToolCallId } : {}),
              })),
            }
          : {}),
        ...(t.backendRuns?.length
          ? {
              backendRuns: t.backendRuns.map((r) => ({
                toolCallId: r.toolCallId,
                status: r.status,
                ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
                at: r.at,
              })),
            }
          : {}),
        backendClaimStatus: claimStatus,
        backendClaimMatch: claimStatus === "matched",
        ...(t.failureMessage !== undefined ? { failureMessage: t.failureMessage } : {}),
        ...(result?.text ? { output: result.text.slice(0, 2000) } : {}),
        ...(result?.baseline ? { baseline: result.baseline.slice(0, 2000) } : {}),
        ...(result?.diff ? { diff: result.diff.slice(0, 4000) } : {}),
        ...(result?.reproSteps?.length ? { reproSteps: result.reproSteps } : {}),
        ...(result?.verifyCommand
          ? {
              verifyCommand: result.verifyCommand,
              ...(result.verifyExitCode !== undefined ? { verifyExitCode: result.verifyExitCode } : {}),
              ...(result.verifyStdout ? { verifyStdout: result.verifyStdout.slice(0, 1000) } : {}),
              ...(result.verifyStderr ? { verifyStderr: result.verifyStderr.slice(0, 1000) } : {}),
            }
          : {}),
        ...(result?.verifyCheckId ? { verifyCheckId: result.verifyCheckId } : {}),
        ...(t.retries !== undefined && t.retries > 0 ? { retries: t.retries } : {}),
      };
    });
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    return {
      roomId: flow.roomId,
      flowId: flow.id,
      startedAt: flow.startedAt,
      phase: flow.phase,
      ...(flow.missionId !== undefined ? { missionId: flow.missionId } : {}),
      ...(flow.finishedAt !== undefined ? { finishedAt: flow.finishedAt } : {}),
      goal: flow.goal,
      acceptanceCriteria: flow.acceptanceCriteria,
      iteration: flow.iteration,
      maxIterations: flow.maxIterations,
      rounds: flow.rounds,
      maxRounds: flow.maxRounds,
      ...(flow.phase === "awaiting-retry" ? { waitingFor: "user" } : {}),
      progress: { done, running, pending, failed, total: tasks.length },
      tasks,
      ...(flow.phase === "awaiting-input" && flow.clarification
        ? {
            clarificationId: flow.clarification.id,
            clarificationQuestions: flow.clarification.questions,
          }
        : {}),
      ...(flow.supplements.length > 0
        ? { supplements: flow.supplements.map((s) => s.text.slice(0, 300)) }
        : {}),
    };
  }

  /** 判断某 session 是否是指挥家且正在指挥编排中 */
  isConductorSession(sessionId: string): boolean {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (room && room.conductorId === sessionId && flow.phase !== "done") return true;
    }
    return false;
  }

  /** 获取某 session 在当前编排中的角色与阶段 */
  getFlowForSession(
    sessionId: string,
  ):
    | { roomId: string; role: "conductor" | "worker"; phase: Flow["phase"] }
    | undefined {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room || flow.phase === "done") continue;
      if (room.conductorId === sessionId) {
        return { roomId: flow.roomId, role: "conductor", phase: flow.phase };
      }
      if (flow.phase === "working") {
        const hasTask = [...flow.tasks.values()].some(
          (t) => t.sessionId === sessionId && (t.status === "pending" || t.status === "running"),
        );
        if (hasTask) {
          return { roomId: flow.roomId, role: "worker", phase: flow.phase };
        }
      }
    }
    return undefined;
  }

  /** 某会话当前回合对应的子任务 id（过程聚合卡归属用）；flush 时任务已收尾，按执行窗口与回合窗口重叠匹配 */
  taskIdForSession(
    sessionId: string,
    roomId: string,
    turnStartAt?: number,
    turnEndAt?: number,
  ): string | undefined {
    const flow = this.flows.get(roomId);
    if (!flow) return undefined;
    const tasks = [...flow.tasks.values()].filter((t) => t.sessionId === sessionId);
    if (turnStartAt === undefined) {
      return tasks.find((t) => t.status === "running")?.id;
    }
    const end = turnEndAt ?? Number.MAX_SAFE_INTEGER;
    const hit = tasks
      .filter(
        (t) =>
          t.dispatchedAt !== undefined &&
          t.dispatchedAt <= end &&
          (t.finishedAt ?? Number.MAX_SAFE_INTEGER) >= turnStartAt,
      )
      .sort((a, b) => b.dispatchedAt! - a.dispatchedAt!)[0];
    return hit?.id;
  }

  /**
   * 成员被用户主动停止/会话取消：名下 running 任务收敛为 failed 终态（"重试"可恢复）。
   * 与 onPromptError 的 pending+自动重派不同，主动取消不立即重派，避免用户刚停又弹起。
   */
  onSessionCancelled(sessionId: string): string | undefined {
    this.pendingToolCalls.delete(sessionId);
    for (const [roomId, flow] of this.flows) {
      const room = this.rooms.get(roomId);
      if (!room || flow.phase !== "working") continue;
      // 该会话正被求助方等待回复：按无响应收敛，唤醒原任务
      const pendingReply = [...flow.help.values()].find(
        (e) => e.status === "pending" && e.dispatched && e.to === sessionId,
      );
      if (pendingReply) {
        pendingReply.status = "answered";
        pendingReply.answer = "（对方已停止/中断，未能提供回复）";
        this.repromptAsker(flow, room, pendingReply);
        this.emitFlow?.(roomId);
        return roomId;
      }
      const hits = [...flow.tasks.values()].filter(
        (t) => t.sessionId === sessionId && t.status === "running",
      );
      if (hits.length === 0) continue;
      const name = this.rooms.displayNameForId(room.roomId, sessionId);
      for (const t of hits) {
        t.status = "failed";
        t.failureMessage = "成员被停止/中断";
        t.finishedAt = Date.now();
        delete t.waitingForHelp;
      }
      this.emitFlow?.(roomId);
      this.notice({
        roomId,
        message: `@${name} 的子任务已中断并标记失败（发送"重试"重新派发，或发送新消息继续）`,
      });
      // 走一遍调度收敛依赖传播与阶段判定（全部终态时会自动进入汇总/awaiting-retry）
      void this.scheduleTasks(flow, room).catch((e) =>
        logError("conductor schedule after cancel", e),
      );
      return roomId;
    }
    return undefined;
  }

  /** prompt 异常（含取消）时清理该会话在编排中的状态 */
  onPromptError(sessionId: string): string | undefined {
    this.pendingToolCalls.delete(sessionId);
    for (const [roomId, flow] of [...this.flows]) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.removeFlow(roomId);
        continue;
      }
      if (flow.phase === "done") continue;
      if (sessionId === room.conductorId) {
        this.removeFlow(roomId);
        this.planningInFlight.delete(roomId);
        this.notice({ roomId, message: "指挥家中断，本轮编排已取消" });
        return roomId;
      }
      if (flow.phase === "working") {
        // 求助对象出错/中断：视为无响应，继续唤醒原任务
        const pendingReply = [...flow.help.values()].find(
          (e) => e.status === "pending" && e.dispatched && e.to === sessionId,
        );
        if (pendingReply) {
          pendingReply.status = "answered";
          pendingReply.answer = "（对方出错或中断，未能提供回复）";
          this.repromptAsker(flow, room, pendingReply);
          return roomId;
        }
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          running.status = "pending";
          delete running.waitingForHelp;
          const pendingCount = [...flow.tasks.values()].filter((t) => t.status === "pending").length;
          this.notice({
            roomId,
            message: `@${
              this.rooms.displayNameForId(room.roomId, sessionId)
            } 子任务中断（剩 ${pendingCount} 项待派发）`,
          });
          void this.scheduleTasks(flow, room).catch((err) => {
            logError("conductor schedule after error", err);
          });
          return roomId;
        }
      }
    }
    return undefined;
  }

  /** 未结话题 → prompt 注入条目：owner 按成员表解析为展示名 */
  private openTopicsFor(room: Room): OpenTopicInput[] {
    return this.rooms.openTopics(room.roomId).map((t) => ({
      ownerName: t.owner ? this.rooms.memberName(room.roomId, t.owner) : undefined,
      text: t.text,
    }));
  }

  private newFlow(
    roomId: string,
    goal: string,
    artifactContext?: { refs?: string[] },
    maxRounds?: number,
    missionId?: string,
  ): Flow {
    const startedAt = Date.now();
    return {
      id: newFlowId(),
      roomId,
      startedAt,
      ...(missionId !== undefined ? { missionId } : {}),
      phase: "planning",
      goal,
      acceptanceCriteria: [...DEFAULT_ACCEPTANCE_CRITERIA],
      iteration: 1,
      maxIterations: MAX_ITERATIONS,
      rounds: 0,
      maxRounds: maxRounds ?? DEFAULT_MAX_ROUNDS,
      tasks: new Map(),
      results: new Map(),
      artifactContext,
      supplements: [],
      help: new Map(),
      planFormatRetries: 0,
    };
  }

  private planningInFlight = new Set<string>();

  private buildPlanningPrompt(
    room: Room,
    text: string,
    artifactContext?: { refs?: string[] },
    qa?: { questions: string[]; answer: string; criteria: string[]; supplements: string[] },
  ): string {
    const artifactLines: string[] = [];
    if (artifactContext?.refs?.length) {
      const artifacts = this.rooms.getArtifactsForPrompt(room.roomId, room.conductorId!, artifactContext);
      for (const a of artifacts) {
        const parts = [`@${this.rooms.memberName(room.roomId, a.author)}`];
        if (a.path) parts.push(a.path);
        parts.push(a.summary);
        artifactLines.push(`- ${parts.join(" ")}`);
      }
    }
    return conductorPlanningPrompt({
      roomName: room.name,
      memberList: conductorMemberList(room.members, room.conductorId),
      task: text,
      example: planExample(room.members, room.conductorId),
      qa,
      artifactLines: artifactLines.length > 0 ? artifactLines : undefined,
      openTopics: this.openTopicsFor(room),
    });
  }

  private sendPlanningPrompt(flow: Flow, room: Room): void {
    if (flow.phase !== "planning" || !room.conductorId || this.conductorGone(flow, room)) {
      this.planningInFlight.delete(flow.roomId);
      return;
    }
    if (this.planningInFlight.has(flow.roomId)) return;
    this.planningInFlight.add(flow.roomId);
    this.notice({ roomId: flow.roomId, message: "指挥家拆解任务中…" });
    const qa =
      flow.clarification && flow.clarificationAnswer !== undefined
        ? {
            questions: flow.clarification.questions,
            answer: flow.clarificationAnswer,
            criteria: flow.acceptanceCriteria,
            supplements: flow.supplements.map((s) => s.text),
          }
        : undefined;
    const promptText =
      this.buildPlanningPrompt(room, flow.goal, flow.artifactContext, qa) +
      (flow.planFormatRetries > 0 ? `\n\n${PLAN_FORMAT_FIX_PROMPT}` : "");
    this.sendPrompt(flow.roomId, room.conductorId, promptText).catch((err: unknown) => {
      const cur = this.flows.get(flow.roomId);
      if (cur !== flow || cur.phase !== "planning") return;
      this.planningInFlight.delete(flow.roomId);
      this.scheduleReschedule(flow, this.promptRetryMs, () => {
        if (flow.phase !== "planning") return;
        this.sendPlanningPrompt(flow, room);
      });
    });
  }

  async start(
    room: Room,
    text: string,
    initialTasks?: { to: string; task: string; id?: string; dependsOn?: string[] }[],
    artifactContext?: { refs?: string[] },
    missionId?: string,
  ): Promise<void> {
    if (!room.conductorId) throw new Error("room has no conductor");
    this.planningInFlight.delete(room.roomId);
    if (initialTasks && initialTasks.length > 0) {
      // 由 auto 模式推荐的初始派工单，直接 dispatch
      this.flows.set(room.roomId, this.newFlow(room.roomId, text, artifactContext, room.maxRounds, missionId));
      const flow = this.flows.get(room.roomId)!;
      this.emitFlow?.(room.roomId);
      await this.dispatchFromTasks(flow, room, initialTasks, text);
      return;
    }
    const promptText = this.buildPlanningPrompt(room, text, artifactContext);
    const flow = this.newFlow(room.roomId, text, artifactContext, room.maxRounds, missionId);
    this.flows.set(room.roomId, flow);
    this.emitFlow?.(room.roomId);
    this.planningInFlight.add(room.roomId);
    this.notice({ roomId: room.roomId, message: "指挥家拆解任务中…" });
    try {
      await this.sendPrompt(room.roomId, room.conductorId, promptText);
    } catch (err) {
      if (this.flows.get(room.roomId) === flow) {
        this.planningInFlight.delete(room.roomId);
      }
      throw err;
    }
  }

  /** 每轮 prompt.done 时调用；返回 flow roomId 表示该事件属于某个编排流 */
  async onPromptDone(sessionId: string, output: string): Promise<string | undefined> {
    this.pendingToolCalls.delete(sessionId);
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) {
        this.removeFlow(flow.roomId);
        continue;
      }
      if (flow.phase === "done") continue;
      if (sessionId === room.conductorId) {
        this.planningInFlight.delete(flow.roomId);
        if (flow.phase === "planning") {
          await this.dispatch(flow, room, output);
          return flow.roomId;
        }
        if (flow.phase === "reviewing") {
          await this.handleReview(flow, room, output);
          return flow.roomId;
        }
        if (flow.phase === "summarizing") {
          const roomId = flow.roomId;
          const result = extractTaskResult(output);
          for (const a of result.artifacts) {
            this.commitArtifact(roomId, a, sessionId);
          }
          const hasFailed = [...flow.tasks.values()].some((t) => t.status === "failed");
          if (hasFailed) {
            flow.phase = "awaiting-retry";
            this.emitFlow?.(roomId);
            const failedIds = [...flow.tasks.values()]
              .filter((t) => t.status === "failed")
              .map((t) => t.id);
            this.notice({
              roomId,
              message: `部分子任务失败（${failedIds.join(", ")}），发送"重试"重新派发失败任务，或发送新消息继续`,
            });
          } else {
            flow.phase = "done";
            this.clearFlowRetryTimers(flow);
            flow.finishedAt = Date.now();
            this.emitFlow?.(roomId);
          }
          return roomId;
        }
      }
      if (flow.phase === "working") {
        // 定向求助回复：helper 的输出被消费为答案，唤醒原任务继续
        const reply = [...flow.help.values()].find(
          (e) => e.status === "pending" && e.dispatched && e.to === sessionId,
        );
        if (reply) {
          reply.status = "answered";
          reply.answer = output;
          const toName = this.rooms.displayNameForId(room.roomId, sessionId);
          const fromName = this.rooms.displayNameForId(room.roomId, reply.from);
          this.notice({
            roomId: flow.roomId,
            message: `@${toName} 已回复 @${fromName} 的求助（任务 ${reply.taskId}），任务继续`,
          });
          this.repromptAsker(flow, room, reply);
          this.emitFlow?.(flow.roomId);
          return flow.roomId;
        }
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          const name = this.rooms.displayNameForId(room.roomId, sessionId);
          // 定向求助：命中则挂起任务等待回复，而不是按结果收尾
          const helpReq = extractHelpRequest(output);
          if (helpReq && this.handleHelpRequest(flow, room, running, helpReq, output)) {
            return flow.roomId;
          }
          const result = extractTaskResult(output);
          flow.results.set(running.id, result);
          this.recordVerifications(flow, room, sessionId, running, result.verifications ?? []);
          for (const a of result.artifacts) {
            this.commitArtifact(flow.roomId, a, sessionId, running.id);
          }
          await this.maybeIsolatedCheck(flow, sessionId, running, result);
          if (
            this.flows.get(flow.roomId) !== flow ||
            running.status !== "running" ||
            flow.tasks.get(running.id) !== running
          ) {
            return flow.roomId;
          }
          const artifactCount = result.artifacts.length;
          const extra = artifactCount > 0 ? `，发现 ${artifactCount} 个 artifact` : "";
          const pendingCount = [...flow.tasks.values()].filter((t) => t.status === "pending").length;

          running.status = "done";
          running.finishedAt = Date.now();
          this.notice({
            roomId: flow.roomId,
            message: `@${name} 已完成子任务 ${running.id}（剩 ${pendingCount} 项）${extra}`,
          });
          await this.scheduleTasks(flow, room);
          return flow.roomId;
        }
      }
    }
    return undefined;
  }

  private commitArtifact(
    roomId: string,
    a: TaskArtifact,
    author: string,
    taskId?: string,
  ): void {
    // author 入参为 sessionId：产物/事件 author 统一存成员展示名，查不到成员时保留 sessionId 兜底
    const displayAuthor = this.rooms.displayNameForId(roomId, author);
    if (a.type === "file") {
      this.rooms.addFile(roomId, {
        author: displayAuthor,
        summary: a.summary,
        path: a.path,
        taskId,
        content: a.content,
      });
      return;
    }
    const action = isEventAction(a.action) ? a.action : undefined;
    if (!action) return;
    this.rooms.addEvent(roomId, {
      author: displayAuthor,
      action,
      summary: a.summary,
      path: a.path,
      taskId,
    });
  }

  /** 用户补充信息并入活跃流程（不取消任务）；返回 false 表示当前阶段不吸收 */
  addSupplement(roomId: string, text: string): boolean {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase === "awaiting-retry" || flow.phase === "done") return false;
    flow.supplements.push({ text, at: Date.now() });
    this.emitFlow?.(roomId);
    return true;
  }

  private clarificationQaLines(flow: Flow): string[] {
    if (!flow.clarification || flow.clarificationAnswer === undefined) return [];
    return [
      "",
      "派工前向用户确认的问题与答复（务必遵循）：",
      ...flow.clarification.questions.map((q, i) => `${i + 1}. ${q}`),
      `用户答复：${flow.clarificationAnswer.slice(0, 2000)}`,
    ];
  }

  pendingClarification(
    roomId: string,
  ): { id: string; questions: string[] } | undefined {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "awaiting-input" || !flow.clarification) return undefined;
    return { id: flow.clarification.id, questions: [...flow.clarification.questions] };
  }

  answerClarification(roomId: string, text: string, id?: string): boolean {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "awaiting-input" || !flow.clarification) return false;
    if (id !== undefined && id !== flow.clarification.id) return false;
    const answer = text.trim().slice(0, 2000);
    if (!answer) return false;
    const room = this.rooms.get(roomId);
    if (!room) return false;
    flow.clarificationAnswer = answer;
    flow.phase = "planning";
    this.emitFlow?.(roomId);
    this.sendPlanningPrompt(flow, room);
    return true;
  }

  /** 等待用户答复的求助交换（to === "user" 且 pending） */
  pendingUserHelps(
    roomId: string,
  ): { id: string; taskId: string; from: string; question: string }[] {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "working") return [];
    return [...flow.help.values()]
      .filter((e) => e.status === "pending" && e.to === "user")
      .map((e) => ({ id: e.id, taskId: e.taskId, from: e.from, question: e.question }));
  }

  /** 用户消息答复指向 "user" 的求助；helpId 可指定具体交换；返回被重新唤醒的成员 sessionId 列表 */
  answerUserHelp(roomId: string, text: string, helpId?: string): string[] {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "working") return [];
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const answered: string[] = [];
    for (const e of flow.help.values()) {
      if (e.status !== "pending" || e.to !== "user") continue;
      if (helpId && e.id !== helpId) continue;
      e.status = "answered";
      e.answer = text;
      this.repromptAsker(flow, room, e);
      answered.push(e.from);
    }
    if (answered.length > 0) this.emitFlow?.(roomId);
    return answered;
  }

  /** worker 输出命中求助块：挂起任务并转达目标成员或用户；返回 false 表示按普通完成处理 */
  private handleHelpRequest(
    flow: Flow,
    room: Room,
    task: FlowTask,
    req: { to: string; question: string },
    output: string,
  ): boolean {
    const rounds = task.helpRounds ?? 0;
    if (rounds >= MAX_HELP_ROUNDS) {
      this.notice({
        roomId: flow.roomId,
        message: `@${this.rooms.displayNameForId(flow.roomId, task.sessionId)} 求助次数已达上限（${MAX_HELP_ROUNDS}），按当前输出收尾`,
      });
      return false;
    }
    const toRaw = req.to.trim();
    const toUser = toRaw === "" || /^(user|用户|我)$/i.test(toRaw);
    const target = toUser ? undefined : resolveMemberByString(room, toRaw);
    if (!toUser && (!target || target.sessionId === task.sessionId)) {
      this.notice({
        roomId: flow.roomId,
        message: `求助目标「${req.to}」无法解析，按当前输出继续`,
      });
      return false;
    }
    task.helpRounds = rounds + 1;
    const exchange: HelpExchange = {
      id: randomUUID().slice(0, 8),
      taskId: task.id,
      from: task.sessionId,
      to: toUser ? "user" : target!.sessionId,
      question: req.question,
      context: output.trim().slice(0, 800),
      status: "pending",
      dispatched: false,
    };
    flow.help.set(exchange.id, exchange);
    task.waitingForHelp = exchange.id;
    this.pendingToolCalls.delete(task.sessionId);
    const fromName = this.rooms.displayNameForId(flow.roomId, task.sessionId);
    if (toUser) {
      this.notice({
        roomId: flow.roomId,
        message: `🆘 @${fromName} 在任务 ${task.id} 向你求助：${req.question.slice(0, 300)}（回复「答：内容」或带 replyTo 参数即可答复；其他消息将作为补充信息并入流程）`,
      });
      this.emitFlow?.(flow.roomId);
      return true;
    }
    this.notice({
      roomId: flow.roomId,
      message: `🆘 @${fromName} 在任务 ${task.id} 向 @${this.rooms.displayNameFor(target!)} 求助：${req.question.slice(0, 160)}`,
    });
    this.dispatchPendingHelp(flow, room);
    this.ensureHelpDispatch(flow, room);
    this.emitFlow?.(flow.roomId);
    return true;
  }

  /** 把可派发的成员求助送出去；目标忙碌或有自己在跑的任务时留待下次调度 */
  private dispatchPendingHelp(flow: Flow, room: Room): void {
    for (const e of flow.help.values()) {
      if (e.status !== "pending" || e.dispatched) continue;
      const task = flow.tasks.get(e.taskId);
      if (!task || task.waitingForHelp !== e.id) {
        // 任务已被重新调度/结束，清理陈旧求助
        e.status = "answered";
        e.answer = "（任务已变更，求助未送出）";
        continue;
      }
      if (e.to === "user") continue;
      // 对方自己还有未完成任务时，先等它空闲
      const ownActive = [...flow.tasks.values()].some(
        (t) =>
          t.sessionId === e.to &&
          (t.status === "pending" || (t.status === "running" && !t.waitingForHelp)),
      );
      if (ownActive || this.agent.isBusy(e.to)) continue;
      e.dispatched = true;
      const fromName = this.rooms.displayNameForId(room.roomId, e.from);
      const toName = this.rooms.displayNameForId(room.roomId, e.to);
      const body = helpRequestPrompt({
        roomName: room.name,
        fromName,
        task: task.task,
        question: e.question,
        context: e.context,
      });
      const prompt = this.rooms.buildPrompt(room.roomId, body, e.to, undefined, undefined, {
        taskId: e.taskId,
      });
      this.sendPrompt(flow.roomId, e.to, prompt).catch((err: unknown) => {
        e.dispatched = false;
        logError("conductor help dispatch", err);
        this.notice({
          roomId: flow.roomId,
          message: `向 @${toName} 转达求助失败，稍后重试`,
        });
        this.ensureHelpDispatch(flow, room);
      });
    }
  }

  /** 存在未派发的成员求助时，启动退避重试直到派发成功或流程结束 */
  private ensureHelpDispatch(flow: Flow, room: Room): void {
    if (flow.helpRetrying) return;
    const hasPending = [...flow.help.values()].some(
      (e) => e.status === "pending" && !e.dispatched && e.to !== "user",
    );
    if (!hasPending) return;
    flow.helpRetrying = true;
    this.scheduleReschedule(flow, this.promptRetryMs, () => {
      flow.helpRetrying = false;
      if (flow.phase !== "working") return;
      this.dispatchPendingHelp(flow, room);
      this.ensureHelpDispatch(flow, room);
    });
  }

  /** 求助获得答复后唤醒原 worker，把答案注入并让其继续完成任务 */
  private repromptAsker(flow: Flow, room: Room, e: HelpExchange): void {
    const task = flow.tasks.get(e.taskId);
    if (!task || task.status !== "running" || task.waitingForHelp !== e.id) return;
    delete task.waitingForHelp;
    this.pendingToolCalls.delete(task.sessionId);
    const fromLabel =
      e.to === "user"
        ? "用户"
        : `@${this.rooms.displayNameForId(room.roomId, e.to)}`;
    const remaining = MAX_HELP_ROUNDS - (task.helpRounds ?? 0);
    const taskBody = helpResumePrompt({
      taskId: task.id,
      task: task.task,
      fromLabel,
      question: e.question,
      answer: e.answer,
      remaining,
    });
    const prompt = this.rooms.buildPrompt(room.roomId, taskBody, task.sessionId, undefined, undefined, {
      taskId: task.id,
      dependsOn: task.dependsOn,
    });
    this.sendPrompt(flow.roomId, task.sessionId, prompt)
      .then(() => {
        task.retries = 0;
        delete task.lastRetryAt;
      })
      .catch((err: unknown) => {
        const msg = String(err);
        if (this.noteDispatchFailure(flow, task, msg)) return;
        // 恢复等待标记后重试唤醒
        task.waitingForHelp = e.id;
        this.scheduleReschedule(flow, this.promptRetryMs, () => {
          this.repromptAsker(flow, room, e);
        });
      });
    this.emitFlow?.(flow.roomId);
  }

  /** 把跨成员的 verify 声明记录到被验证任务上，并落一条 test 事件关联 taskId */
  private recordVerifications(
    flow: Flow,
    room: Room,
    verifierId: string,
    verifierTask: FlowTask,
    verifs: { taskId: string; verdict: string; evidence: VerificationEvidence }[],
  ): void {
    const verifierName = this.rooms.displayNameForId(room.roomId, verifierId);
    const verifierRuns = verifierTask.backendRuns ?? [];
    for (const v of verifs) {
      const target = flow.tasks.get(v.taskId);
      // 只记录跨成员的独立验证，自我验证走正常 artifact
      if (!target || target.sessionId === verifierId || target.status !== "done") continue;
      let backendToolCallId: string | undefined;
      const evidenceCommand = v.evidence.command?.trim();
      if (evidenceCommand && v.evidence.exitCode !== undefined) {
        const commandHash = sha256Hex(evidenceCommand);
        const matched = verifierRuns.find(
          (r) =>
            r.status === "completed" &&
            r.commandHash === commandHash &&
            r.exitCode === v.evidence.exitCode &&
            (v.evidence.stdout === undefined || r.stdoutHash === sha256Hex(v.evidence.stdout)) &&
            (v.evidence.stderr === undefined || r.stderrHash === sha256Hex(v.evidence.stderr)),
        );
        if (matched) backendToolCallId = matched.toolCallId;
      }
      (target.verifications ??= []).push({
        by: verifierId,
        verdict: v.verdict,
        evidence: v.evidence,
        at: Date.now(),
        ...(backendToolCallId ? { backendToolCallId } : {}),
      });
      const summary = summarizeEvidence(v.evidence).slice(0, 160);
      this.rooms.addEvent(flow.roomId, {
        author: this.rooms.displayNameForId(flow.roomId, verifierId),
        action: "test",
        summary: `验证任务 ${v.taskId}：${v.verdict}${summary ? ` — ${summary}` : ""}`,
        taskId: v.taskId,
      });
      this.notice({
        roomId: flow.roomId,
        message: `🧪 @${verifierName} 对任务 ${v.taskId} 的独立验证：${v.verdict}`,
      });
    }
  }

  private resolveMember(
    room: Room,
    rawTo: string,
  ): { sessionId: string; name: string } | undefined {
    return resolveMemberByString(room, rawTo);
  }

  private async dispatch(flow: Flow, room: Room, conductorOutput: string): Promise<void> {
    const plan = parsePlan(conductorOutput, room);
    if (plan === null) {
      if (flow.planFormatRetries < PLAN_FORMAT_RETRY_LIMIT) {
        flow.planFormatRetries = PLAN_FORMAT_RETRY_LIMIT;
        this.notice({
          roomId: flow.roomId,
          message: "规划格式无法解析，正在自动纠正（1/1）；尚未派工",
        });
        this.sendPlanningPrompt(flow, room);
        return;
      }
      this.removeFlow(flow.roomId);
      this.emitFlow?.(flow.roomId);
      this.notice({
        roomId: flow.roomId,
        message: "指挥家输出无法解析为任务计划，重试一次仍失败；本轮未派工，请重试",
      });
      return;
    }
    const tasks = plan.tasks;
    if (plan.questions.length > 0 && !flow.clarificationAsked) {
      flow.planFormatRetries = 0;
      flow.clarificationAsked = true;
      flow.phase = "awaiting-input";
      flow.clarification = { id: randomUUID().slice(0, 8), questions: plan.questions };
      this.emitFlow?.(flow.roomId);
      this.notice({
        roomId: flow.roomId,
        message: `指挥家需要先向你确认 ${plan.questions.length} 个问题再派工：\n${plan.questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}\n（回复「答：内容」或定向答复即可；其他消息将作为补充并入）`,
      });
      return;
    }
    if (plan.questions.length > 0) {
      this.removeFlow(flow.roomId);
      this.emitFlow?.(flow.roomId);
      this.notice({
        roomId: flow.roomId,
        message: "仍缺必要信息，未派工/未交付，请补充要求后重新发起",
      });
      return;
    }
    if (typeof plan.goal === "string" && plan.goal.trim()) {
      flow.goal = plan.goal.trim();
    }
    if (plan.acceptanceCriteria.length > 0) {
      flow.acceptanceCriteria = plan.acceptanceCriteria;
    }
    if (tasks.length === 0) {
      flow.phase = "done";
      this.clearFlowRetryTimers(flow);
      flow.finishedAt = Date.now();
      this.emitFlow?.(flow.roomId);
      const answer = conductorOutput.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
      this.notice({
        roomId: flow.roomId,
        message: answer || "指挥家判断本次任务无需派工",
      });
      return;
    }
    await this.dispatchFromTasks(flow, room, tasks);
  }

  private async dispatchFromTasks(
    flow: Flow,
    room: Room,
    tasks: ParsedTask[],
    originalText?: string,
  ): Promise<void> {
    if (tasks.length === 0) {
      this.removeFlow(flow.roomId);
      return;
    }
    flow.phase = "working";
    flow.rounds += 1;

    const idMap = new Map<string, string>();
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      if (!t.task.trim()) continue;
      const member = this.resolveMember(room, t.to);
      if (!member) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：未知成员 ${t.to}` });
        continue;
      }
      const taskId = t.id?.trim() || `t${i + 1}`;
      const dependsOn = this.normalizeDependsOn(t.dependsOn, tasks, i, idMap, room);
      flow.tasks.set(taskId, {
        id: taskId,
        sessionId: member.sessionId,
        task: t.task.trim(),
        dependsOn,
        status: "pending",
        iteration: flow.iteration,
      });
      idMap.set(String(i), taskId);
    }

    if (flow.tasks.size === 0) {
      this.removeFlow(flow.roomId);
      return;
    }

    if (originalText) {
      this.notice({
        roomId: flow.roomId,
        message: `指挥家根据推荐直接派工：${originalText.slice(0, 80)}`,
      });
    }

    await this.scheduleTasks(flow, room);
  }

  private normalizeDependsOn(
    raw: string[] | undefined,
    tasks: { id?: string; to: string }[],
    currentIndex: number,
    idMap: Map<string, string>,
    room: Room,
  ): string[] {
    if (!raw || raw.length === 0) return [];
    const result = new Set<string>();
    for (const d of raw) {
      const dep = d.trim();
      if (!dep) continue;
      // 1. 直接是某个 task 的 id
      const byId = tasks.find((t, idx) => (t.id?.trim() || `t${idx + 1}`) === dep);
      if (byId) {
        result.add(dep);
        continue;
      }
      // 2. 通过索引引用，如 "t1" 或 "1"（历史索引）
      const prevIdx = Number(dep);
      if (!Number.isNaN(prevIdx) && prevIdx > 0 && prevIdx <= tasks.length) {
        const mapped = idMap.get(String(prevIdx - 1)) ?? `t${prevIdx}`;
        result.add(mapped);
        continue;
      }
      // 3. 按成员名/id 引用
      const member = resolveMemberByString(room, dep.replace(/^@/, ""));
      if (member) {
        // 找到分配给该成员的前一个任务
        const prev = tasks.findIndex((t, idx) => {
          const m = resolveMemberByString(room, t.to);
          return m?.sessionId === member.sessionId && idx < currentIndex;
        });
        if (prev >= 0) {
          result.add(idMap.get(String(prev)) ?? `t${prev + 1}`);
        }
      }
    }
    return [...result];
  }

  private runnableTasks(flow: Flow): FlowTask[] {
    const doneIds = new Set<string>();
    for (const [id, t] of flow.tasks) {
      if (t.status === "done") doneIds.add(id);
    }
    const runningSessions = new Set<string>();
    for (const t of flow.tasks.values()) {
      if (t.status === "running") runningSessions.add(t.sessionId);
    }
    const out: FlowTask[] = [];
    for (const t of flow.tasks.values()) {
      if (t.status !== "pending") continue;
      const depsDone = t.dependsOn.every((d) => doneIds.has(d));
      if (!depsDone) continue;
      if (runningSessions.has(t.sessionId)) continue;
      out.push(t);
    }
    return out;
  }

  private async scheduleTasks(flow: Flow, room: Room): Promise<void> {
    if (!this.flows.has(flow.roomId)) return;

    // 先把可派发的求助送出去（目标空闲且无自己在跑的任务）
    this.dispatchPendingHelp(flow, room);
    this.ensureHelpDispatch(flow, room);

    // 成员会话已删除的任务直接标记失败，避免无限重试
    if (this.agent.has) {
      let marked = false;
      for (const t of flow.tasks.values()) {
        if ((t.status === "pending" || t.status === "running") && !this.agent.has(t.sessionId)) {
          t.status = "failed";
          t.failureMessage = "成员会话已失效";
          t.finishedAt = Date.now();
          marked = true;
        }
      }
      if (marked) this.emitFlow?.(flow.roomId);
    }

    // 依赖失败传播：任何 failed task 的下游 pending task 标记为 failed
    const failedIds = new Set<string>();
    for (const [id, t] of flow.tasks) {
      if (t.status === "failed") failedIds.add(id);
    }
    if (failedIds.size > 0) {
      let propagated = false;
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, t] of flow.tasks) {
          if (t.status !== "pending") continue;
          if (t.dependsOn.some((d) => failedIds.has(d))) {
            t.status = "failed";
            t.failureMessage = "前置依赖任务失败";
            t.finishedAt = Date.now();
            failedIds.add(id);
            changed = true;
            propagated = true;
          }
        }
      }
      if (propagated) this.emitFlow?.(flow.roomId);
    }

    const tasks = this.runnableTasks(flow);
    if (tasks.length === 0) {
      const values = [...flow.tasks.values()];
      const hasActive = values.some((t) => t.status === "running");
      if (hasActive) return;
      const doneCount = values.filter((t) => t.status === "done").length;
      const failedCount = values.filter((t) => t.status === "failed").length;
      if (doneCount > 0) {
        if (failedCount === 0) {
          if (this.maybeInjectPeerReview(flow, room)) {
            await this.scheduleTasks(flow, room);
            return;
          }
          await this.review(flow, room);
        } else {
          await this.summarize(flow, room);
        }
      } else {
        const failedTasks = values.filter((t) => t.status === "failed");
        const names = failedTasks.map((t) => this.rooms.displayNameForId(room.roomId, t.sessionId));
        this.notice({
          roomId: flow.roomId,
          message: `所有子任务均失败（${names.join("、")}），无法汇总`,
        });
        flow.phase = "done";
        this.clearFlowRetryTimers(flow);
        flow.finishedAt = Date.now();
        this.emitFlow?.(flow.roomId);
      }
      return;
    }

    const assignments: string[] = [];
    const dispatchedTasks: { id: string; to: string; task: string }[] = [];
    let skippedBusy = false;
    for (const t of tasks) {
      if (this.agent.isBusy(t.sessionId)) {
        skippedBusy = true;
        continue;
      }
      t.status = "running";
      t.dispatchedAt = Date.now();
      delete t.finishedAt;
      delete t.backendRuns;
      delete t.automaticCheck;
      this.pendingToolCalls.delete(t.sessionId);
      const name = this.rooms.displayNameForId(room.roomId, t.sessionId);
      assignments.push(`@${name}：${t.task}`);
      dispatchedTasks.push({ id: t.id, to: name, task: t.task });
      const taskRefs = this.rooms.parseArtifactRefs(room.roomId, t.task);
      const refs =
        taskRefs.length > 0
          ? [...new Set([...(flow.artifactContext?.refs ?? []), ...taskRefs])]
          : flow.artifactContext?.refs;
      const artifactContext = refs && refs.length > 0
        ? { taskId: t.id, dependsOn: t.dependsOn, ...(flow.artifactContext ?? {}), refs }
        : { taskId: t.id, dependsOn: t.dependsOn, ...(flow.artifactContext ?? {}) };
      const upstreamLines: string[] = [];
      for (const depId of t.dependsOn) {
        const depResult = flow.results.get(depId);
        if (!depResult) continue;
        const depTask = flow.tasks.get(depId);
        const depName = depTask
          ? this.rooms.displayNameForId(room.roomId, depTask.sessionId)
          : depId;
        upstreamLines.push(`- [${depId}] @${depName}：${depResult.text.slice(0, PLAN_RESULT_LEN)}`);
        for (const a of depResult.artifacts) {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          upstreamLines.push(`  artifacts: ${parts.join(" ")}`);
        }
        if (depResult.baseline) {
          upstreamLines.push(`  baseline（修改前）：${depResult.baseline.slice(0, 2000)}`);
        }
        if (depResult.diff) {
          upstreamLines.push(`  diff（实际修改）：${depResult.diff.slice(0, 4000)}`);
        }
        if (depResult.reproSteps?.length) {
          upstreamLines.push(`  reproSteps：${depResult.reproSteps.join("；")}`);
        }
        if (depResult.verifyCommand) {
          upstreamLines.push(
            `  verifyCommand：${depResult.verifyCommand}（exitCode=${depResult.verifyExitCode ?? "unknown"}${depResult.verifyStdout ? `, stdout=${depResult.verifyStdout.slice(0, 500)}` : ""}）`,
          );
        }
      }
      const taskBody = workerTaskPrompt({
        taskId: t.id,
        task: t.task,
        upstreamLines,
        qaLines: this.clarificationQaLines(flow),
        supplements: flow.supplements.map((s) => s.text),
      });
      const prompt = this.rooms.buildPrompt(
        room.roomId,
        taskBody,
        t.sessionId,
        undefined,
        undefined,
        artifactContext,
      );
      this.sendPrompt(flow.roomId, t.sessionId, prompt)
        .then(() => {
          t.retries = 0;
          delete t.lastRetryAt;
        })
        .catch((err: unknown) => {
          const msg = String(err);
          if (this.noteDispatchFailure(flow, t, msg)) return;
          t.status = "pending";
          this.notice({
            roomId: flow.roomId,
            message: `子任务派发失败（重试 ${t.retries}/3）：${msg}`,
          });
          this.scheduleReschedule(flow, this.promptRetryMs, () => {
            this.scheduleTasks(flow, room).catch((e) => {
              logError("conductor schedule after fail", e);
            });
          });
        });
    }

    if (assignments.length > 0) {
      this.notice({
        roomId: flow.roomId,
        message: `指挥家派工：已派发 ${assignments.length} 个子任务`,
        meta: {
          type: "dispatch",
          sessionId: room.conductorId ?? "",
          tasks: dispatchedTasks,
        },
      });
    }

    // Bug 4: 有 runnable task 因 isBusy 被跳过时，定时轮询重试
    if (skippedBusy) {
      this.scheduleReschedule(flow, BUSY_RETRY_MS, () => {
        this.scheduleTasks(flow, room).catch((e) =>
          logError("conductor busy retry reschedule", e),
        );
      });
    }

    this.emitFlow?.(flow.roomId);
  }

  private appendTasks(flow: Flow, room: Room, tasks: ParsedTask[]): number {
    let added = 0;
    const assigned = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      if (!t.task.trim()) continue;
      const member = this.resolveMember(room, t.to);
      if (!member) continue;
      let taskId = t.id?.trim() || `r${flow.iteration}t${i + 1}`;
      if (flow.tasks.has(taskId) || assigned.has(taskId)) {
        taskId = `r${flow.iteration}t${i + 1}`;
      }
      while (flow.tasks.has(taskId) || assigned.has(taskId)) taskId = `${taskId}x`;
      const dependsOn = [...new Set(
        (t.dependsOn ?? [])
          .map((d) => d.trim())
          .filter((d) => d && d !== taskId && (flow.tasks.has(d) || assigned.has(d))),
      )];
      flow.tasks.set(taskId, {
        id: taskId,
        sessionId: member.sessionId,
        task: t.task.trim(),
        dependsOn,
        status: "pending",
        iteration: flow.iteration,
      });
      assigned.add(taskId);
      added++;
    }
    return added;
  }

  private maybeInjectPeerReview(flow: Flow, room: Room): boolean {
    if (flow.challengeScheduled) return false;
    const all = [...flow.tasks.values()];
    const unverified = all.filter(
      (t) =>
        t.status === "done" &&
        t.id !== flow.challengeTaskId &&
        (t.verifications?.length ?? 0) === 0,
    );
    if (unverified.length === 0) return false;
    const executors = new Set(all.map((t) => t.sessionId));
    const reviewer = room.members.find(
      (m) => m.sessionId !== room.conductorId && !executors.has(m.sessionId),
    );
    if (!reviewer) return false;
    const doneIds = unverified.map((t) => t.id);
    let taskId = "peer-review";
    while (flow.tasks.has(taskId)) taskId += "x";
    flow.tasks.set(taskId, {
      id: taskId,
      sessionId: reviewer.sessionId,
      task: peerReviewTaskDescription(doneIds),
      dependsOn: doneIds,
      status: "pending",
      iteration: flow.iteration,
    });
    flow.challengeScheduled = true;
    flow.challengeTaskId = taskId;
    this.emitFlow?.(flow.roomId);
    this.notice({
      roomId: flow.roomId,
      message: `新增独立复核任务 ${taskId}：@${this.rooms.displayNameFor(reviewer)} 对已完成交付做质疑性验证`,
    });
    return true;
  }

  private unverifiedDoneIds(flow: Flow): string[] {
    return [...flow.tasks.values()]
      .filter(
        (t) =>
          t.status === "done" &&
          t.id !== flow.challengeTaskId &&
          (t.verifications?.length ?? 0) === 0,
      )
      .map((t) => t.id);
  }

  /** 主持人会话已被删除时终止 flow，避免无限重试 */
  private conductorGone(flow: Flow, room: Room): boolean {
    if (room.conductorId && (!this.agent.has || this.agent.has(room.conductorId))) return false;
    this.notice({ roomId: flow.roomId, message: "主持人会话已失效，本次编排终止" });
    flow.phase = "done";
    this.clearFlowRetryTimers(flow);
    flow.finishedAt = Date.now();
    this.emitFlow?.(flow.roomId);
    return true;
  }

  private async review(flow: Flow, room: Room): Promise<void> {
    if (flow.phase !== "working" && flow.phase !== "reviewing") return;
    if (this.conductorGone(flow, room)) return;
    if (flow.phase === "reviewing" && this.agent.isBusy(room.conductorId!)) return;
    flow.phase = "reviewing";
    this.emitFlow?.(flow.roomId);
    this.notice({
      roomId: flow.roomId,
      message: `第 ${flow.iteration}/${flow.maxIterations} 轮任务完成，指挥家验收中…`,
    });
    const lines: string[] = [];
    const hashCache = new Map<string, string | undefined>();
    for (const t of flow.tasks.values()) {
      const name = this.rooms.displayNameForId(room.roomId, t.sessionId);
      const result = flow.results.get(t.id);
      if (!result) continue;
      const artifacts = result.artifacts
        .map((a) => {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary.slice(0, 1000));
          return `    - ${parts.join(" ")}`;
        })
        .join("\n");
      const verifs = (t.verifications ?? [])
        .map(
          (v) =>
            `    - @${this.rooms.displayNameForId(room.roomId, v.by)}：${v.verdict}${v.evidence ? `（${summarizeEvidence(v.evidence).slice(0, 300)}）` : ""}`,
        )
        .join("\n");
      lines.push([
        `- [${t.id}] @${name}: ${result.text.slice(0, PLAN_RESULT_LEN)}`,
        ...(result.artifacts.length > 0 ? ["  artifacts:", artifacts] : []),
        ...(verifs ? ["  独立验证:", verifs] : []),
        ...(t.automaticCheck
          ? [`  ${describeAutomaticCheck(t.automaticCheck, this.snapshotCurrentFor(t, hashCache))}`]
          : []),
      ].join("\n"));
    }
    const hasChecks = [...flow.tasks.values()].some((t) => t.automaticCheck);
    const unverifiedDone = this.unverifiedDoneIds(flow);
    const prompt = conductorReviewPrompt({
      roomName: room.name,
      goal: flow.goal,
      criteria: flow.acceptanceCriteria,
      iteration: flow.iteration,
      maxIterations: flow.maxIterations,
      resultLines: lines,
      qaLines: this.clarificationQaLines(flow),
      supplements: flow.supplements.map((s) => s.text),
      hasChecks,
      unverifiedDone,
      memberList: conductorMemberList(room.members, room.conductorId),
      openTopics: this.openTopicsFor(room),
    });
    try {
      await this.sendPrompt(flow.roomId, room.conductorId!, prompt);
    } catch (err) {
      logError("conductor review prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家验收派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      this.scheduleReschedule(flow, this.promptRetryMs, () => {
        if (flow.phase !== "reviewing") return;
        this.review(flow, room).catch((e) => logError("conductor review retry", e));
      });
    }
  }

  private async handleReview(flow: Flow, room: Room, output: string): Promise<void> {
    const decision = parseReviewDecision(output, room);
    if (decision?.decision === "complete") {
      flow.reviewReason = decision.reason;
      await this.summarize(flow, room);
      return;
    }
    if (decision?.decision === "continue" && decision.tasks.length > 0) {
      // 跟进轮次预算：超限不再派新批次，置 awaiting-retry 交还用户
      if (flow.rounds >= flow.maxRounds) {
        flow.phase = "awaiting-retry";
        this.emitFlow?.(flow.roomId);
        this.notice({
          roomId: flow.roomId,
          message: `跟进轮次已达上限（${flow.rounds}/${flow.maxRounds}），编排已暂停等待你接手：发送新消息继续处理`,
        });
        return;
      }
    }
    if (
      decision?.decision === "continue" &&
      decision.tasks.length > 0 &&
      flow.iteration < flow.maxIterations
    ) {
      flow.iteration += 1;
      flow.rounds += 1;
      flow.reviewReason = decision.reason;
      const added = this.appendTasks(flow, room, decision.tasks);
      if (added > 0) {
        flow.phase = "working";
        this.emitFlow?.(flow.roomId);
        this.notice({
          roomId: flow.roomId,
          message: `验收未通过：${decision.reason}。新增 ${added} 项任务，进入第 ${flow.iteration}/${flow.maxIterations} 轮`,
        });
        await this.scheduleTasks(flow, room);
        return;
      }
    }
    if (decision) flow.reviewReason = decision.reason;
    const hitLimit = flow.iteration >= flow.maxIterations;
    this.notice({
      roomId: flow.roomId,
      message: hitLimit
        ? `达到迭代上限（${flow.maxIterations} 轮），指挥家汇总当前成果`
        : "验收决策无法执行，指挥家汇总当前成果",
    });
    await this.summarize(flow, room);
  }

  private async summarize(flow: Flow, room: Room): Promise<void> {
    if (flow.phase !== "working" && flow.phase !== "reviewing" && flow.phase !== "summarizing") return;
    if (this.conductorGone(flow, room)) return;
    if (flow.phase === "summarizing" && this.agent.isBusy(room.conductorId!)) return;
    flow.phase = "summarizing";
    this.emitFlow?.(flow.roomId);
    const failedTasks = [...flow.tasks.values()].filter((t) => t.status === "failed");
    const hasFailures = failedTasks.length > 0;
    // 按照 task 在 tasks Map 中的创建顺序（即指挥家给出的顺序）生成汇总
    const lines: string[] = [];
    const hashCache = new Map<string, string | undefined>();
    for (const t of flow.tasks.values()) {
      const name = this.rooms.displayNameForId(room.roomId, t.sessionId);
      if (t.status === "failed") {
        lines.push(`- [${t.id}] @${name}: 失败（${t.failureMessage ?? "未知原因"}）`);
        continue;
      }
      const result = flow.results.get(t.id);
      if (!result) continue;
      const artifacts = result.artifacts
        .map((a) => {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary.slice(0, 1000));
          return `    - ${parts.join(" ")}`;
        })
        .join("\n");
      const verifs = (t.verifications ?? [])
        .map(
          (v) =>
            `    - @${this.rooms.displayNameForId(room.roomId, v.by)}：${v.verdict}${v.evidence ? `（${summarizeEvidence(v.evidence).slice(0, 300)}）` : ""}`,
        )
        .join("\n");
      lines.push([
        `- [${t.id}] @${name}: ${result.text.slice(0, PLAN_RESULT_LEN)}`,
        ...(result.artifacts.length > 0 ? ["  artifacts:", artifacts] : []),
        ...(verifs ? ["  独立验证:", verifs] : []),
        ...(t.automaticCheck
          ? [`  ${describeAutomaticCheck(t.automaticCheck, this.snapshotCurrentFor(t, hashCache))}`]
          : []),
      ].join("\n"));
    }
    const hasChecks = [...flow.tasks.values()].some((t) => t.automaticCheck);
    const unverifiedDone = this.unverifiedDoneIds(flow);
    const prompt = conductorSummarizePrompt({
      roomName: room.name,
      goal: flow.goal,
      criteria: flow.acceptanceCriteria,
      reviewReason: flow.reviewReason,
      hasFailures,
      resultLines: lines,
      qaLines: this.clarificationQaLines(flow),
      supplements: flow.supplements.map((s) => s.text),
      hasChecks,
      unverifiedDone,
      failedNames: failedTasks
        .map((t) => this.rooms.displayNameForId(room.roomId, t.sessionId))
        .join("、"),
      openTopics: this.openTopicsFor(room),
    });
    this.notice({
      roomId: flow.roomId,
      message: hasFailures ? "子任务部分完成，指挥家降级汇总中…" : "子任务全部完成，指挥家汇总中…",
    });
    try {
      await this.sendPrompt(flow.roomId, room.conductorId!, prompt);
    } catch (err) {
      logError("conductor summarize prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家汇总派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      this.scheduleReschedule(flow, this.promptRetryMs, () => {
        if (flow.phase !== "summarizing") return;
        this.summarize(flow, room).catch((e) => logError("conductor summarize retry", e));
      });
    }
  }

  /** agent 连接后恢复所有活跃 flow 的调度（Fix C）。 */
  resumeFlows(): void {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) continue;
      if (flow.phase === "summarizing") {
        this.summarize(flow, room).catch((e) => logError("conductor resume summarize", e));
      } else if (flow.phase === "reviewing") {
        this.review(flow, room).catch((e) => logError("conductor resume review", e));
      } else if (flow.phase === "working") {
        this.scheduleTasks(flow, room).catch((e) => logError("conductor resume schedule", e));
      } else if (flow.phase === "planning") {
        this.sendPlanningPrompt(flow, room);
      }
    }
  }

  /** 检查房间是否有等待重试的 flow */
  hasAwaitingRetry(roomId: string): boolean {
    const flow = this.flows.get(roomId);
    return flow?.phase === "awaiting-retry";
  }

  /** 重试失败的子任务：把 failed 任务回退为 pending 并重新调度 */
  retryFailedTasks(roomId: string, taskIds?: string[]): boolean {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "awaiting-retry") return false;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.removeFlow(roomId);
      return false;
    }
    const failed = [...flow.tasks.values()].filter(
      (t) => t.status === "failed" && (!taskIds || taskIds.includes(t.id)),
    );
    if (failed.length === 0) return false;
    for (const t of failed) {
      t.status = "pending";
      delete t.failureMessage;
      delete t.finishedAt;
      t.retries = 0;
      delete t.lastRetryAt;
    }
    flow.retryWindow = [];
    this.clearFlowRetryTimers(flow);
    flow.phase = "working";
    this.emitFlow?.(roomId);
    const failedIds = failed.map((t) => t.id);
    this.notice({ roomId, message: `重试失败子任务：${failedIds.join(", ")}` });
    this.scheduleTasks(flow, room).catch((e) => logError("conductor retry schedule", e));
    return true;
  }

  /** 编排卡对应的房史条目 rowId：建卡后由 Hub 写回，随快照持久化 */
  flowCardRowId(roomId: string): number | undefined {
    return this.flows.get(roomId)?.cardRowId;
  }

  setFlowCardRowId(roomId: string, rowId: number): void {
    const flow = this.flows.get(roomId);
    if (flow) flow.cardRowId = rowId;
  }

  private serializeFlow(flow: Flow): Record<string, unknown> {
    return {
      id: flow.id,
      roomId: flow.roomId,
      startedAt: flow.startedAt,
      ...(flow.cardRowId !== undefined ? { cardRowId: flow.cardRowId } : {}),
      phase: flow.phase,
      ...(flow.finishedAt !== undefined ? { finishedAt: flow.finishedAt } : {}),
      goal: flow.goal,
      acceptanceCriteria: flow.acceptanceCriteria,
      iteration: flow.iteration,
      maxIterations: flow.maxIterations,
      rounds: flow.rounds,
      maxRounds: flow.maxRounds,
      ...(flow.missionId !== undefined ? { missionId: flow.missionId } : {}),
      ...(flow.reviewReason !== undefined ? { reviewReason: flow.reviewReason } : {}),
      tasks: [...flow.tasks.values()].map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        task: t.task,
        dependsOn: t.dependsOn,
        status: t.status,
        iteration: t.iteration,
        ...(t.dispatchedAt !== undefined ? { dispatchedAt: t.dispatchedAt } : {}),
        ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
        ...(t.failureMessage !== undefined ? { failureMessage: t.failureMessage } : {}),
        ...(t.retries !== undefined ? { retries: t.retries } : {}),
        ...(t.helpRounds !== undefined ? { helpRounds: t.helpRounds } : {}),
        ...(t.waitingForHelp !== undefined ? { waitingForHelp: t.waitingForHelp } : {}),
        ...(t.verifications !== undefined ? { verifications: t.verifications } : {}),
        ...(t.backendRuns !== undefined ? { backendRuns: t.backendRuns } : {}),
        ...(t.automaticCheck !== undefined ? { automaticCheck: t.automaticCheck } : {}),
      })),
      supplements: flow.supplements,
      help: [...flow.help.values()],
      ...(flow.clarification ? { clarification: flow.clarification } : {}),
      ...(flow.clarificationAsked ? { clarificationAsked: true } : {}),
      ...(flow.clarificationAnswer !== undefined
        ? { clarificationAnswer: flow.clarificationAnswer }
        : {}),
      ...(flow.challengeScheduled ? { challengeScheduled: true } : {}),
      ...(flow.challengeTaskId ? { challengeTaskId: flow.challengeTaskId } : {}),
      planFormatRetries: flow.planFormatRetries,
      results: Object.fromEntries(
        [...flow.results.entries()].map(([id, r]) => [
          id,
          {
            text: r.text,
            artifacts: r.artifacts,
            ...(r.baseline !== undefined ? { baseline: r.baseline } : {}),
            ...(r.diff !== undefined ? { diff: r.diff } : {}),
            ...(r.reproSteps !== undefined ? { reproSteps: r.reproSteps } : {}),
            ...(r.verifyCommand !== undefined ? { verifyCommand: r.verifyCommand } : {}),
            ...(r.verifyExitCode !== undefined ? { verifyExitCode: r.verifyExitCode } : {}),
            ...(r.verifyStdout !== undefined ? { verifyStdout: r.verifyStdout } : {}),
            ...(r.verifyStderr !== undefined ? { verifyStderr: r.verifyStderr } : {}),
            ...(r.verifyCheckId !== undefined ? { verifyCheckId: r.verifyCheckId } : {}),
          },
        ]),
      ),
      artifactContext: flow.artifactContext,
    };
  }

  export(): Record<string, unknown> {
    for (const flow of this.flows.values()) {
      const snapshot = this.serializeFlow(flow);
      this.store?.saveFlowSnapshot(flow.roomId, this.store.getMaxRoomSeq(flow.roomId), snapshot);
    }
    return { flows: [...this.flows.values()].map((flow) => this.serializeFlow(flow)) };
  }

  async import(state: Record<string, unknown>): Promise<void> {
    const flows = state.flows;
    if (!Array.isArray(flows)) return;
    for (const raw of flows) {
      const f = raw as Record<string, unknown>;
      const roomId = String(f.roomId ?? "");
      const room = this.rooms.get(roomId);
      if (!room) {
        logWarn("conductor import", `跳过流程：房间不存在 roomId=${roomId}`);
        continue;
      }
      // 缺指挥家时保留 flow 快照供面板查看，降级为 awaiting-retry 不再自动续跑
      const noConductor = !room.conductorId;
      const refsArr = Array.isArray((f.artifactContext as Record<string, unknown>)?.refs)
        ? ((f.artifactContext as Record<string, unknown>).refs as unknown[]).map((s) => String(s)).filter(Boolean)
        : [];
      const artifactContext = f.artifactContext && typeof f.artifactContext === "object" && refsArr.length > 0
        ? { refs: refsArr }
        : undefined;
      const restoredAt = Number(f.startedAt ?? 0) || Date.now();
      const flow: Flow = {
        id: typeof f.id === "string" && f.id ? f.id : newFlowId(),
        roomId,
        startedAt: restoredAt,
        ...(typeof f.cardRowId === "number" && f.cardRowId > 0
          ? { cardRowId: f.cardRowId }
          : {}),
        phase: (f.phase as Flow["phase"]) ?? "working",
        goal: typeof f.goal === "string" ? f.goal : "",
        acceptanceCriteria: Array.isArray(f.acceptanceCriteria)
          ? f.acceptanceCriteria.map((s) => String(s)).filter(Boolean)
          : [...DEFAULT_ACCEPTANCE_CRITERIA],
        iteration: typeof f.iteration === "number" && f.iteration > 0 ? f.iteration : 1,
        maxIterations:
          typeof f.maxIterations === "number" && f.maxIterations > 0
            ? f.maxIterations
            : MAX_ITERATIONS,
        rounds: typeof f.rounds === "number" && f.rounds >= 0 ? f.rounds : 0,
        maxRounds:
          typeof f.maxRounds === "number" && f.maxRounds > 0
            ? f.maxRounds
            : (room.maxRounds ?? DEFAULT_MAX_ROUNDS),
        ...(typeof f.missionId === "string" && f.missionId
          ? { missionId: f.missionId }
          : {}),
        tasks: new Map(),
        results: new Map(),
        artifactContext,
        supplements: Array.isArray(f.supplements)
          ? f.supplements
              .map((s) => ({ text: String((s as Record<string, unknown>)?.text ?? ""), at: Number((s as Record<string, unknown>)?.at ?? 0) }))
              .filter((s) => s.text)
          : [],
        help: new Map(),
        ...(typeof f.reviewReason === "string" ? { reviewReason: f.reviewReason } : {}),
        ...(typeof f.clarificationAsked === "boolean" ? { clarificationAsked: f.clarificationAsked } : {}),
        ...(typeof f.clarificationAnswer === "string" && f.clarificationAnswer
          ? { clarificationAnswer: f.clarificationAnswer.slice(0, 2000) }
          : {}),
        ...(typeof f.challengeScheduled === "boolean" ? { challengeScheduled: f.challengeScheduled } : {}),
        ...(typeof f.challengeTaskId === "string" && f.challengeTaskId
          ? { challengeTaskId: f.challengeTaskId }
          : {}),
        ...(typeof f.finishedAt === "number" && f.finishedAt > 0
          ? { finishedAt: f.finishedAt }
          : {}),
        planFormatRetries:
          f.planFormatRetries === 0 || f.planFormatRetries === 1
            ? f.planFormatRetries
            : 0,
      };
      const rawClar = f.clarification as Record<string, unknown> | undefined;
      if (rawClar && typeof rawClar === "object") {
        const cid = String(rawClar.id ?? "").trim();
        const qs = Array.isArray(rawClar.questions)
          ? rawClar.questions
              .map((q) => String(q).trim())
              .filter((q) => q.length > 0 && q.length <= 200)
              .slice(0, 4)
          : [];
        if (cid && qs.length > 0) flow.clarification = { id: cid, questions: qs };
      }
      for (const t of (f.tasks as unknown[]) ?? []) {
        const o = t as Record<string, unknown>;
        const taskId = String(o.id ?? "");
        if (!taskId) continue;
        const sessionId = String(o.sessionId ?? "");
        // 成员已离开：未完成的任务标记 failed（已完成的保持 done，离开不抹掉产出）
        const memberGone = !room.members.some((m) => m.sessionId === sessionId);
        const rawStatus = String(o.status ?? "pending");
        const status: FlowTask["status"] =
          memberGone && rawStatus !== "done"
            ? "failed"
            : rawStatus === "done" || rawStatus === "failed" || rawStatus === "running"
              ? rawStatus
              : "pending";
        flow.tasks.set(taskId, {
          id: taskId,
          sessionId,
          task: String(o.task ?? ""),
          dependsOn: Array.isArray(o.dependsOn)
            ? o.dependsOn.map((s) => String(s)).filter(Boolean)
            : [],
          status,
          iteration: typeof o.iteration === "number" && o.iteration > 0 ? o.iteration : 1,
          ...(typeof o.dispatchedAt === "number" ? { dispatchedAt: o.dispatchedAt } : {}),
          ...(memberGone && rawStatus !== "done"
            ? { finishedAt: Date.now() }
            : typeof o.finishedAt === "number"
              ? { finishedAt: o.finishedAt }
              : {}),
          ...(memberGone && rawStatus !== "done"
            ? { failureMessage: "成员已离开房间" }
            : typeof o.failureMessage === "string"
              ? { failureMessage: o.failureMessage }
              : {}),
          ...(typeof o.retries === "number" ? { retries: o.retries } : {}),
          ...(typeof o.helpRounds === "number" ? { helpRounds: o.helpRounds } : {}),
          ...(Array.isArray(o.verifications)
            ? {
                verifications: o.verifications
                  .map((v) => {
                    const vo = v as Record<string, unknown>;
                    return {
                      by: String(vo.by ?? ""),
                      verdict: String(vo.verdict ?? ""),
                      evidence: normalizeEvidence(vo.evidence),
                      at: Number(vo.at ?? 0),
                      ...(typeof vo.backendToolCallId === "string" && vo.backendToolCallId
                        ? { backendToolCallId: vo.backendToolCallId }
                        : {}),
                    };
                  })
                  .filter((v) => v.by && v.verdict),
              }
            : {}),
          ...(Array.isArray(o.backendRuns)
            ? {
                backendRuns: (o.backendRuns as unknown[])
                  .map((r) => {
                    const ro = r as Record<string, unknown>;
                    const id = typeof ro.toolCallId === "string" ? ro.toolCallId : "";
                    const st = String(ro.status ?? "");
                    const commandHash = typeof ro.commandHash === "string" ? ro.commandHash : "";
                    if (!id || (st !== "completed" && st !== "failed")) return null;
                    const run: BackendToolRun = {
                      toolCallId: id.slice(0, TOOL_CALL_ID_MAX),
                      ...(commandHash ? { commandHash } : {}),
                      status: st,
                      ...(typeof ro.exitCode === "number" && Number.isInteger(ro.exitCode) && ro.exitCode >= 0 && ro.exitCode <= 255
                        ? { exitCode: ro.exitCode }
                        : {}),
                      ...(typeof ro.stdoutHash === "string" ? { stdoutHash: ro.stdoutHash } : {}),
                      ...(typeof ro.stderrHash === "string" ? { stderrHash: ro.stderrHash } : {}),
                      at: Number(ro.at ?? 0),
                    };
                    return run;
                  })
                  .filter((r): r is BackendToolRun => r !== null)
                  .slice(-MAX_BACKEND_RUNS),
              }
            : {}),
          ...(status !== "pending" && o.automaticCheck !== undefined
            ? (() => {
                const ac = sanitizeAutomaticCheck(o.automaticCheck);
                return ac ? { automaticCheck: ac } : {};
              })()
            : {}),
        });
      }
      // 恢复求助交换：成员求助重新标记为未派发，等 scheduleTasks 重新送出
      for (const rawHelp of (f.help as unknown[]) ?? []) {
        const h = rawHelp as Record<string, unknown>;
        const taskId = String(h.taskId ?? "");
        const from = String(h.from ?? "");
        const to = String(h.to ?? "");
        const question = String(h.question ?? "");
        if (!taskId || !from || !to || !question) continue;
        const status = h.status === "answered" ? "answered" : "pending";
        const id = String(h.id ?? randomUUID().slice(0, 8));
        flow.help.set(id, {
          id,
          taskId,
          from,
          to,
          question,
          ...(typeof h.context === "string" ? { context: h.context } : {}),
          ...(typeof h.answer === "string" ? { answer: h.answer } : {}),
          status,
          dispatched: false,
        });
        // 等待中的任务恢复为 running 挂起，避免被重新派发丢失求助上下文
        const waitingTask = flow.tasks.get(taskId);
        if (
          status === "pending" &&
          waitingTask &&
          (waitingTask.status === "pending" || waitingTask.status === "running") &&
          waitingTask.sessionId === from
        ) {
          waitingTask.status = "running";
          waitingTask.waitingForHelp = id;
        }
      }
      const results = f.results as Record<string, Record<string, unknown>> | undefined;
      if (results) {
        for (const [id, r] of Object.entries(results)) {
          if (typeof r.text !== "string") continue;
          const reproSteps = Array.isArray(r.reproSteps)
            ? r.reproSteps.filter((x): x is string => typeof x === "string")
            : undefined;
          flow.results.set(id, {
            text: r.text,
            artifacts: Array.isArray(r.artifacts)
              ? r.artifacts
                  .map((a) => {
                    const o = a as Record<string, unknown>;
                    const rawType = String(o.type ?? "");
                    let type: TaskArtifact["type"];
                    if (rawType === "file") type = "file";
                    else if (rawType === "event" || rawType === "command" || rawType === "test") type = "event";
                    else return null;
                    const action = isEventAction(String(o.action ?? "")) ? String(o.action) : undefined;
                    return { type, action, path: typeof o.path === "string" ? o.path : undefined, summary: String(o.summary ?? "") };
                  })
                  .filter((a) => a !== null) as TaskArtifact[]
              : [],
            ...(typeof r.baseline === "string" ? { baseline: r.baseline } : {}),
            ...(typeof r.diff === "string" ? { diff: r.diff } : {}),
            ...(reproSteps?.length ? { reproSteps } : {}),
            ...(typeof r.verifyCommand === "string" ? { verifyCommand: r.verifyCommand } : {}),
            ...(typeof r.verifyExitCode === "number" ? { verifyExitCode: r.verifyExitCode } : {}),
            ...(typeof r.verifyStdout === "string" ? { verifyStdout: r.verifyStdout } : {}),
            ...(typeof r.verifyStderr === "string" ? { verifyStderr: r.verifyStderr } : {}),
            ...(typeof r.verifyCheckId === "string" && ISOLATED_CHECK_ID_RE.test(r.verifyCheckId)
              ? { verifyCheckId: r.verifyCheckId }
              : {}),
          });
        }
      }
      if (flow.phase === "awaiting-input" && !flow.clarification) {
        flow.phase = "planning";
      }
      const interrupted: string[] = [];
      if (flow.phase === "working") {
        for (const t of flow.tasks.values()) {
          if (t.status === "running" && !t.waitingForHelp) {
            t.status = "failed";
            t.failureMessage = "Hub 重启时执行状态未知，请检查工作区后重试";
            t.finishedAt = Date.now();
            delete t.automaticCheck;
            flow.results.delete(t.id);
            interrupted.push(t.id);
          }
        }
        const hasPendingHelp = [...flow.help.values()].some((h) => h.status === "pending");
        if (interrupted.length > 0 && !hasPendingHelp) {
          flow.phase = "awaiting-retry";
        }
      }
      // 无指挥家的房间无法规划/验收/汇总：降级为暂停态保留快照
      if (noConductor && flow.phase !== "done") flow.phase = "awaiting-retry";
      this.flows.set(roomId, flow);
      if (flow.phase === "done") {
        this.emitFlow?.(roomId);
        continue;
      }
      this.notice({
        roomId,
        message: noConductor
          ? "已恢复编排快照：该房间当前没有指挥家（conductorId），流程已暂停；恢复指挥家后可发送“重试”继续。"
          : flow.phase === "awaiting-retry"
            ? interrupted.length > 0
              ? `Hub 重启时任务执行状态未知：任务 ${interrupted.join(", ")} 已暂停，检查工作区后发送“重试”再派发；未自动重复执行。`
              : "已恢复暂停中的流程：存在待重试任务，检查工作区后发送“重试”再派发。"
            : flow.phase === "planning"
              ? "已恢复待规划任务，连接指挥家后继续规划。"
              : flow.phase === "awaiting-input"
                ? `已恢复待确认的流程：指挥家正等待你答复 ${flow.clarification?.questions.length ?? 0} 个问题后继续规划。`
                : "🔄 已恢复指挥编排，继续执行待派发任务",
      });
      if (flow.phase === "reviewing") {
        await this.review(flow, room).catch((err) => logError("conductor import review", err));
      } else if (flow.phase === "summarizing") {
        await this.summarize(flow, room).catch((err) => logError("conductor import summarize", err));
      } else if (flow.phase === "working") {
        await this.scheduleTasks(flow, room).catch((err) => {
          logError("conductor import schedule", err);
        });
      }
      this.emitFlow?.(roomId);
    }
  }
}

function extractTaskResult(output: string): TaskResult {
  // 1. 尝试提取 `text` 与 `artifacts` JSON code fence
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const artifacts: TaskArtifact[] = [];
      if (Array.isArray(obj.artifacts)) {
        for (const a of obj.artifacts) {
          const o = a as Record<string, unknown>;
          let type = String(o.type ?? "");
          if (type !== "file" && type !== "event") {
            // 兼容旧 kind：command / test / note 转为 event
            if (type === "command" || type === "test" || type === "note") type = "event";
            else continue;
          }
          const path = typeof o.path === "string" ? o.path : undefined;
          const summary = typeof o.summary === "string" ? o.summary : "";
          if (path || summary) {
            artifacts.push({
              type: type as TaskArtifact["type"],
              action: type === "event" ? (typeof o.action === "string" ? o.action : undefined) : undefined,
              path,
              summary,
            });
          }
        }
      }
      const verifications: NonNullable<TaskResult["verifications"]> = [];
      const rawVerify = obj.verify ?? obj.verifications;
      const vList = Array.isArray(rawVerify) ? rawVerify : rawVerify ? [rawVerify] : [];
      for (const v of vList) {
        const vo = v as Record<string, unknown>;
        const taskId = String(vo.task ?? vo.taskId ?? vo.id ?? "").trim();
        const verdict = String(vo.verdict ?? vo.result ?? "").trim() || "pass";
        const evidence = normalizeEvidence(vo.evidence ?? vo.summary ?? vo.detail ?? "");
        if (taskId) verifications.push({ taskId, verdict, evidence });
      }
      if (text || artifacts.length > 0 || verifications.length > 0) {
        // 去掉 JSON code fence 后的内容作为额外文本
        const plain = output.replace(fenceRe, "").trim().replace(/\s+/g, " ");
        const reproSteps = Array.isArray(obj.reproSteps)
          ? obj.reproSteps.filter((x): x is string => typeof x === "string")
          : undefined;
        const result: TaskResult = {
          text: text || plain.slice(0, PLAN_RESULT_LEN),
          artifacts,
          ...(verifications.length > 0 ? { verifications } : {}),
        };
        const baseline = typeof obj.baseline === "string" ? obj.baseline.trim() : undefined;
        if (baseline) result.baseline = baseline;
        const diff = typeof obj.diff === "string" ? obj.diff.trim() : undefined;
        if (diff) result.diff = diff;
        if (reproSteps?.length) result.reproSteps = reproSteps;
        const verifyCommand = typeof obj.verifyCommand === "string" ? obj.verifyCommand.trim() : undefined;
        if (verifyCommand) result.verifyCommand = verifyCommand;
        if (typeof obj.verifyExitCode === "number") result.verifyExitCode = obj.verifyExitCode;
        const verifyStdout = typeof obj.verifyStdout === "string" ? obj.verifyStdout.trim() : undefined;
        if (verifyStdout) result.verifyStdout = verifyStdout;
        const verifyStderr = typeof obj.verifyStderr === "string" ? obj.verifyStderr.trim() : undefined;
        if (verifyStderr) result.verifyStderr = verifyStderr;
        if (Object.hasOwn(obj, "verifyCheckId")) result.verifyCheckIdProvided = true;
        const verifyCheckId = typeof obj.verifyCheckId === "string" ? obj.verifyCheckId.trim() : undefined;
        if (verifyCheckId && ISOLATED_CHECK_ID_RE.test(verifyCheckId)) {
          result.verifyCheckId = verifyCheckId;
        }
        return result;
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  // 2. 没有合法 artifact JSON 时，自动扫描 diff 和命令
  const autoArtifacts: TaskArtifact[] = [];

  // 2.1 扫描 ```bash / ```shell 代码块作为 command 事件
  const shellRe = /```(?:bash|shell|sh)\s*([\s\S]*?)```/g;
  let sm: RegExpExecArray | null;
  while ((sm = shellRe.exec(output)) !== null) {
    const cmd = sm[1]?.trim();
    if (cmd) {
      autoArtifacts.push({ type: "event", action: "command", summary: cmd.slice(0, 200) });
    }
  }

  // 2.2 扫描 diff 输出块
  const diffRe = /(diff --git[\s\S]*?(?=\n```|\n\n\n|$))/g;
  let dm: RegExpExecArray | null;
  while ((dm = diffRe.exec(output)) !== null) {
    const diff = dm[1]?.trim();
    if (diff && diff.length > 20) {
      const path = extractDiffPath(diff);
      if (path && !isNoisePath(path)) {
        autoArtifacts.push({ type: "file", path, summary: diff.slice(0, 10000), content: diff });
      }
    }
  }

  // 2.3 扫描测试相关结果
  const testResultRe = /(\d+)\s*(passed|failed|skipped|pending)/gi;
  let tm: RegExpExecArray | null;
  const testResults: string[] = [];
  while ((tm = testResultRe.exec(output)) !== null) {
    if (tm[1] && tm[2]) testResults.push(`${tm[1]} ${tm[2].toLowerCase()}`);
  }
  if (testResults.length > 0) {
    autoArtifacts.push({ type: "event", action: "test", summary: testResults.slice(0, 5).join(", ") });
  }
  const testPathRe = /\b(?:test|tests|__tests__)\/([A-Za-z0-9_\-/.]+\.[a-zA-Z0-9]+)\b/g;
  const testPaths = new Set<string>();
  while ((tm = testPathRe.exec(output)) !== null) {
    const p = tm[0];
    if (!isNoisePath(p)) testPaths.add(p);
  }
  for (const p of [...testPaths].slice(0, 5)) {
    autoArtifacts.push({ type: "event", action: "test", path: p, summary: "测试文件" });
  }

  const artifacts: TaskArtifact[] = autoArtifacts.slice(0, 10);

  // 3. 兜底：返回截断文本
  return {
    text: output.trim().replace(/\s+/g, " ").slice(0, PLAN_RESULT_LEN),
    artifacts,
  };
}

function extractDiffPath(diff: string): string | undefined {
  const m = diff.match(/diff --git a\/(\S+)/);
  return m?.[1];
}

function isNoisePath(path: string): boolean {
  return /(?:^|\/)(node_modules|\.gradle|\.git|build|dist)(?:\/|$)/i.test(path);
}

function jsonCandidates(output: string, marker: string): string[] {
  const candidates: string[] = [];

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  if (candidates.length === 0) {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < output.length; i++) {
      const ch = output[i];
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && start >= 0) {
          const raw = output.slice(start, i + 1);
          if (raw.includes(marker)) candidates.push(raw);
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function resolveParsedTasks(raw: unknown, room: Room): ParsedTask[] | null {
  if (!Array.isArray(raw)) return null;
  const tasks = raw
    .map((t: unknown) => {
      const o = t as Record<string, unknown>;
      if (typeof o?.to !== "string" || typeof o?.task !== "string") return null;
      const toRaw = o.to.replace(/^@/, "").trim();
      const taskRaw = String(o.task).trim();
      if (!taskRaw) return null;
      // 允许 to 使用成员名、name (id: xxx) 或 sessionId
      const member = resolveMemberByString(room, toRaw);
      if (!member) return null;
      const id = typeof o.id === "string" ? o.id : undefined;
      const dependsOn = Array.isArray(o.dependsOn)
        ? o.dependsOn.map((s) => String(s)).filter(Boolean)
        : undefined;
      return { id, to: member.sessionId, task: taskRaw, dependsOn };
    })
    .filter((t) => t !== null);
  return tasks as ParsedTask[];
}

function parsePlan(output: string, room: Room): ConductorPlan | null {
  for (const raw of jsonCandidates(output, '"tasks"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const tasks = resolveParsedTasks(obj.tasks, room);
      if (tasks === null) continue;
      if (Array.isArray(obj.tasks) && tasks.length !== obj.tasks.length) continue;
      const goal = typeof obj.goal === "string" ? obj.goal : undefined;
      const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
        ? obj.acceptanceCriteria
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .map((s) => s.trim())
        : [];
      const questions = Array.isArray(obj.questions)
        ? obj.questions
            .filter((q): q is string => typeof q === "string")
            .map((q) => q.trim())
            .filter((q) => q.length > 0 && q.length <= 200)
            .slice(0, 4)
        : [];
      return { goal, acceptanceCriteria, tasks, questions };
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function parseReviewDecision(output: string, room: Room): ReviewDecision | null {
  for (const raw of jsonCandidates(output, '"decision"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const decision = obj.decision;
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
      if (decision === "complete") {
        return { decision: "complete", reason };
      }
      if (decision === "continue") {
        return { decision: "continue", reason, tasks: resolveParsedTasks(obj.tasks, room) ?? [] };
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function parseTasks(output: string, room: Room): ParsedTask[] | null {
  return parsePlan(output, room)?.tasks ?? null;
}

export function resolveMemberByString(
  room: Room,
  raw: string,
): { sessionId: string; name: string } | undefined {
  const to = raw.replace(/^@/, "").trim();
  if (!to) return undefined;
  // 优先从 "name (id: xxx)" 中提取 id
  const idMatch = to.match(/id:\s*([^\s)]+)/);
  if (idMatch) {
    const member = room.members.find((m) => m.sessionId === idMatch[1]);
    if (member) return member;
  }
  // 精确 sessionId
  const byId = room.members.find((m) => m.sessionId === to);
  if (byId) return byId;
  // 精确名字（去重后）
  const byName = room.members.find((m) => m.name === to);
  if (byName) return byName;
  // 前缀/子串匹配，用于 agent 只写了名字一部分的场景
  const byPrefix = room.members.find(
    (m) => m.name.toLowerCase().startsWith(to.toLowerCase()),
  );
  if (byPrefix) return byPrefix;
  const byIncludes = room.members.find((m) => m.name.toLowerCase().includes(to.toLowerCase()));
  if (byIncludes) return byIncludes;
  // agent 回显统一展示名（成员名·agentType·origin）时按首段成员名兜底
  const base = to.split("·")[0]!;
  return base !== to ? room.members.find((m) => m.name === base) : undefined;
}

/** 从 worker 输出中提取定向求助块：{"help":{"to":"成员|user","question":"..."}} */
export function extractHelpRequest(
  output: string,
): { to: string; question: string } | undefined {
  for (const raw of jsonCandidates(output, '"help"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const help =
        typeof obj.help === "object" && obj.help !== null
          ? (obj.help as Record<string, unknown>)
          : obj.type === "help"
            ? obj
            : undefined;
      if (!help) continue;
      const question = String(help.question ?? help.q ?? "").trim();
      if (!question) continue;
      return { to: String(help.to ?? "").trim(), question };
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

export { parseTasks, extractTaskResult };
export type { TaskArtifact, TaskResult };

export type IsolatedCheckResult = {
  status: "exited_zero" | "exited_nonzero" | "blocked" | "timed_out";
  runner: "bubblewrap";
  commandHash: string;
  snapshotHash?: string;
  exitCode?: number;
  stdoutHash?: string;
  stderrHash?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  startedAt: number;
  finishedAt: number;
  reason?: string;
  detail?: string;
};

const ISO_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".gradle",
  "build",
  "dist",
  "target",
  ".ssh",
  ".aws",
]);
const ISO_MAX_FILE_BYTES = 5 * 1024 * 1024;
const ISO_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ISO_MAX_FILES = 5000;
const ISO_STREAM_KEEP = 32 * 1024;
const ISO_TIMEOUT_MS = 30000;
const ISO_COMMAND_MAX = 256;

let isolatedCheckInFlight = false;

class IsoAbort extends Error {
  constructor(
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

function isoExcludedFile(name: string): boolean {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name.endsWith(".pem") ||
    name.endsWith(".key")
  );
}

function gitLsFiles(realCwd: string): string[] {
  try {
    const inside = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", realCwd, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
    if (inside !== "true") throw new IsoAbort("snapshot_error");
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        realCwd,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return out.toString("utf8").split("\0").filter(Boolean);
  } catch (e) {
    if (e instanceof IsoAbort) throw e;
    throw new IsoAbort("snapshot_error", String(e));
  }
}

export function snapshotWorkspace(srcRoot: string, dstRoot?: string): string {
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const raw of gitLsFiles(srcRoot)) {
    if (!raw || path.isAbsolute(raw)) throw new IsoAbort("snapshot_error");
    if (raw.split("/").some((s) => s === "" || s === "..")) {
      throw new IsoAbort("snapshot_error");
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    rels.push(raw);
    if (rels.length > ISO_MAX_FILES) throw new IsoAbort("snapshot_limit");
  }
  rels.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const hash = createHash("sha256");
  const marker = (rel: string, tag: string): void => {
    hash.update(Buffer.from(rel, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(tag, "utf8"));
    hash.update(Buffer.from([0]));
  };
  let total = 0;
  for (const rel of rels) {
    if (rel.split("/").some((s) => ISO_EXCLUDED_DIRS.has(s))) continue;
    if (isoExcludedFile(path.posix.basename(rel))) continue;
    const full = path.join(srcRoot, rel);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        marker(rel, "DELETED");
        continue;
      }
      throw new IsoAbort("snapshot_error", String(e));
    }
    if (lst.isSymbolicLink()) {
      marker(rel, "SKIPPED_SYMLINK");
      continue;
    }
    if (!lst.isFile()) throw new IsoAbort("snapshot_error");
    const bytes = readSnapshotFile(full);
    total += bytes.length;
    if (total > ISO_MAX_TOTAL_BYTES) throw new IsoAbort("snapshot_limit");
    if (dstRoot !== undefined) {
      const dst = path.join(dstRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, bytes);
    }
    hash.update(Buffer.from(rel, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

export function workspaceSnapshotHash(realCwd: string): string | undefined {
  try {
    return snapshotWorkspace(realCwd);
  } catch {
    return undefined;
  }
}

/**
 * 廉价工作区指纹：递归 lstat 遍历（跳过 ISO_EXCLUDED_DIRS，.git 含在其中），
 * 不 spawn git、不读文件内容。与 snapshotWorkspace 的哈希输入同变——非忽略文件的
 * 增/删/改/类型变化都会失配；指纹只可能过度敏感（忽略文件变化多触发一次重算），方向安全。
 * 遍历超限或不可读返回 undefined（调用方退化为不复用缓存）。
 */
export function workspaceFingerprint(cwd: string): Map<string, string> | undefined {
  const fp = new Map<string, string>();
  const stack = [""];
  let count = 0;
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel ? path.join(cwd, rel) : cwd;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ISO_EXCLUDED_DIRS.has(e.name)) stack.push(r);
        continue;
      }
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(abs, e.name));
      } catch {
        fp.set(r, "GONE");
        continue;
      }
      fp.set(
        r,
        `${st.mtimeMs}:${st.size}:${st.isSymbolicLink() ? "L" : st.isFile() ? "F" : "O"}`,
      );
      count++;
      if (count > ISO_MAX_FILES) return undefined;
    }
  }
  return fp;
}

function gitRepoLayout(realCwd: string): { repoName: string; relCwd: string } {
  try {
    const top = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", realCwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
    const repoName = path.basename(top);
    if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === "." || repoName === "..") {
      throw new IsoAbort("snapshot_error");
    }
    const rel = path.relative(top, realCwd);
    const segments = rel ? rel.split(path.sep) : [];
    if (
      path.isAbsolute(rel) ||
      segments.length > 16 ||
      segments.some((s) => s === "" || s === "." || s === "..")
    ) {
      throw new IsoAbort("snapshot_error");
    }
    return { repoName, relCwd: segments.join("/") };
  } catch (e) {
    if (e instanceof IsoAbort) throw e;
    throw new IsoAbort("snapshot_error");
  }
}

function readSnapshotFile(src: string): Buffer {
  const fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new IsoAbort("snapshot_error");
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let got = 0;
    for (;;) {
      const n = fs.readSync(
        fd,
        buf,
        0,
        Math.min(buf.length, ISO_MAX_FILE_BYTES + 1 - got),
        null,
      );
      if (n === 0) break;
      got += n;
      if (got > ISO_MAX_FILE_BYTES) throw new IsoAbort("snapshot_limit");
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

export async function runIsolatedCheck(
  cwd: string,
  command: string,
): Promise<IsolatedCheckResult> {
  const startedAt = Date.now();
  const commandHash = sha256Hex(typeof command === "string" ? command.trim() : "");
  const finish = (
    status: IsolatedCheckResult["status"],
    extra: Partial<IsolatedCheckResult> = {},
  ): IsolatedCheckResult => ({
    status,
    runner: "bubblewrap",
    commandHash,
    startedAt,
    finishedAt: Date.now(),
    ...extra,
  });
  const blocked = (reason: string, detail?: string) =>
    finish("blocked", { reason, ...(detail ? { detail } : {}) });
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed || trimmed.length > ISO_COMMAND_MAX || /[\r\n]/.test(trimmed)) {
    return blocked("invalid_command");
  }
  if (isolatedCheckInFlight) return blocked("busy");
  if (process.platform !== "linux") return blocked("unavailable", `platform=${process.platform}`);
  const missingBin = [
    !fs.existsSync("/usr/bin/systemd-run") && "/usr/bin/systemd-run",
    !fs.existsSync("/usr/bin/bwrap") && "/usr/bin/bwrap",
  ].filter(Boolean).join(", ");
  if (missingBin) return blocked("unavailable", `missing=${missingBin}`);
  isolatedCheckInFlight = true;
  let snapshotDir: string | undefined;
  try {
    const realCwd = fs.realpathSync(cwd);
    if (!fs.statSync(realCwd).isDirectory()) throw new IsoAbort("snapshot_error");
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-iso-"));
    fs.chmodSync(snapshotDir, 0o700);
    const layout = gitRepoLayout(realCwd);
    let snapshotHash: string;
    try {
      snapshotHash = snapshotWorkspace(realCwd, snapshotDir);
    } catch (e) {
      throw e instanceof IsoAbort ? e : new IsoAbort("snapshot_error");
    }
    const virtualCwd = `/workspace/${layout.repoName}${
      layout.relCwd ? `/${layout.relCwd}` : ""
    }`;
    const binds: string[] = ["--dir", `/workspace/${layout.repoName}`];
    {
      let prefix = `/workspace/${layout.repoName}`;
      const segs = layout.relCwd ? layout.relCwd.split("/") : [];
      for (let i = 0; i < segs.length - 1; i++) {
        prefix += `/${segs[i]}`;
        binds.push("--dir", prefix);
      }
    }
    binds.push("--bind", snapshotDir, virtualCwd);
    try {
      const nm = path.join(realCwd, "node_modules");
      const lst = fs.lstatSync(nm);
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        binds.push("--ro-bind", nm, `${virtualCwd}/node_modules`);
      }
    } catch {}
    const outcome = await new Promise<{
      spawnError?: boolean;
      spawnErrorMessage?: string;
      code: number | null;
      timedOut: boolean;
      stdout: Buffer;
      stderr: Buffer;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }>((resolve) => {
      const child = spawn(
        "/usr/bin/systemd-run",
        [
          "--quiet",
          "--user",
          "--scope",
          "--property=MemoryMax=1073741824",
          "--property=TasksMax=64",
          "--property=CPUQuota=100%",
          "/usr/bin/bwrap",
          "--unshare-user",
          "--unshare-pid",
          "--unshare-net",
          "--unshare-ipc",
          "--unshare-uts",
          "--die-with-parent",
          "--new-session",
          "--clearenv",
          "--setenv",
          "PATH",
          "/usr/bin:/bin",
          "--setenv",
          "HOME",
          "/tmp",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/bin",
          "/bin",
          "--ro-bind",
          "/lib",
          "/lib",
          "--ro-bind",
          "/lib64",
          "/lib64",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--tmpfs",
          "/workspace",
          ...binds,
          "--chdir",
          virtualCwd,
          "--",
          "/bin/sh",
          "-c",
          trimmed,
        ],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            HOME: "/tmp",
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "",
          },
        },
      );
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      const append = (buf: Buffer, chunk: Buffer) => {
        const room = ISO_STREAM_KEEP - buf.length;
        const kept = room > 0 ? Buffer.concat([buf, chunk.subarray(0, room)]) : buf;
        return { buf: kept, truncated: chunk.length > Math.max(room, 0) };
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        const r = append(stdout, chunk);
        stdout = r.buf;
        stdoutTruncated = stdoutTruncated || r.truncated;
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        const r = append(stderr, chunk);
        stderr = r.buf;
        stderrTruncated = stderrTruncated || r.truncated;
      });
      const killTimer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 800).unref();
      }, ISO_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(killTimer);
        resolve({
          spawnError: true,
          spawnErrorMessage: String(err),
          code: null,
          timedOut,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        resolve({
          code,
          timedOut,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
    if (outcome.spawnError) return blocked("start_failed", outcome.spawnErrorMessage);
    const shared = {
      snapshotHash,
      ...(outcome.stdout.length
        ? { stdoutHash: createHash("sha256").update(outcome.stdout).digest("hex") }
        : {}),
      ...(outcome.stderr.length
        ? { stderrHash: createHash("sha256").update(outcome.stderr).digest("hex") }
        : {}),
      ...(outcome.stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(outcome.stderrTruncated ? { stderrTruncated: true } : {}),
    };
    if (outcome.timedOut) {
      return finish("timed_out", {
        ...shared,
        ...(outcome.code !== null ? { exitCode: outcome.code } : {}),
      });
    }
    const code = outcome.code ?? 1;
    if (code !== 0) {
      const stderrText = outcome.stderr.toString("utf8");
      if (/bwrap:|systemd-run|Failed to (?:connect|start|create|allocate)/.test(stderrText)) {
        return blocked("start_failed", stderrText.slice(0, 500));
      }
      return finish("exited_nonzero", { ...shared, exitCode: code });
    }
    return finish("exited_zero", { ...shared, exitCode: 0 });
  } catch (e) {
    if (e instanceof IsoAbort) return blocked(e.reason, e.detail);
    return blocked("snapshot_error", String(e));
  } finally {
    if (snapshotDir) {
      try {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
      } catch {}
    }
    isolatedCheckInFlight = false;
  }
}
// conductor-dispatch: verified by agent-hub
// t2: 在 t1 确定的文件末尾追加此注释，标记子任务 t2 已完成
