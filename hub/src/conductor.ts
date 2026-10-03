import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isEventAction, type Room, type RoomManager } from "./room.js";
import { logError, logWarn } from "./logger.js";

export type PromptContent = Array<Record<string, unknown>>;

export interface AgentOps {
  prompt(sessionId: string, content: string | PromptContent): Promise<void>;
  isBusy(sessionId: string): boolean;
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
};

type Flow = {
  roomId: string;
  phase: FlowPhase;
  goal: string;
  acceptanceCriteria: string[];
  iteration: number;
  maxIterations: number;
  /** 任务以 taskId 为 key */
  tasks: Map<string, FlowTask>;
  /** 结果以 taskId 为 key */
  results: Map<string, TaskResult>;
  artifactContext?: { refs?: string[] } | undefined;
  reviewReason?: string;
  /** 用户在流程执行中补充的信息，并入后续派发/验收/汇总 prompt */
  supplements: Supplement[];
  /** 任务执行中的定向求助交换 */
  help: Map<string, HelpExchange>;
  /** 是否已有求助派发重试定时器在跑 */
  helpRetrying?: boolean;
  clarification?: { id: string; questions: string[] };
  clarificationAsked?: boolean;
  clarificationAnswer?: string;
  challengeScheduled?: boolean;
  challengeTaskId?: string;
  planFormatRetries: number;
};

export type ConductorNotice = { roomId: string; message: string };

const PLAN_RESULT_LEN = 4000;
const MAX_ITERATIONS = 3;
const MAX_HELP_ROUNDS = 2;
const DEFAULT_ACCEPTANCE_CRITERIA = ["交付结果满足用户目标，并包含必要的实现与验证证据"];
const BUSY_RETRY_MS = 5000;

const PROMPT_RETRY_MS = 5000;
const SUMMARIZE_RETRY_MS = 5000;
const TOOL_CALL_ID_MAX = 128;
const TOOL_COMMAND_MAX = 8192;
const TOOL_OUTPUT_MAX = 262144;
const MAX_BACKEND_RUNS = 20;
const MAX_PENDING_TOOL_CALLS = 20;
const ISOLATED_CHECK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ISOLATED_CHECK_MAX = 32;
const PLAN_FORMAT_RETRY_LIMIT = 1;
const PLAN_FORMAT_FIX_PROMPT =
  "上一次规划无法解析为任务计划，尚未派工。请只输出一个 JSON code block，顶层包含 goal（字符串）、acceptanceCriteria（字符串数组）和 tasks（数组）；每项任务的 to 必须是现有成员且 task 非空。若确实需要用户先决定，请输出 questions（最多 4 条）并将 tasks 设为 []。不要解释或调用工具。";

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
  const startedAt = Number(o.startedAt ?? 0);
  const finishedAt = Number(o.finishedAt ?? 0);
  if (status === "blocked" && o.commandHash === undefined) {
    return {
      status: "blocked",
      runner: "bubblewrap",
      reason: reason ?? "unknown",
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
  };
}

function describeAutomaticCheck(c: AutomaticCheck, snapshotCurrent?: boolean): string {
  const exitCode = "exitCode" in c ? c.exitCode : undefined;
  const snapshot = "snapshotHash" in c ? c.snapshotHash : undefined;
  return `隔离检查：${c.status},exitCode=${exitCode ?? "unknown"},snapshotHash=${snapshot?.slice(0, 12) ?? "none"}${snapshotCurrent === false ? "，当前工作区已变化或无法核对，旧隔离检查仅对应历史快照，不得据此宣称当前版本通过。" : ""}`;
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

export class ConductorOrchestrator {
  private flows = new Map<string, Flow>();
  private pendingToolCalls = new Map<string, Map<string, PendingToolCall>>();
  private readonly promptRetryMs: number;
  private readonly emitFlow: ((roomId: string) => void) | undefined;

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

  hasActiveFlow(roomId: string): boolean {
    const flow = this.flows.get(roomId);
    return flow !== undefined && flow.phase !== "done";
  }

  clearCompleted(roomId: string): void {
    const flow = this.flows.get(roomId);
    if (flow?.phase !== "done") return;
    this.flows.delete(roomId);
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
    this.flows.delete(roomId);
    this.planningInFlight.delete(roomId);
    for (const sid of touched) this.pendingToolCalls.delete(sid);
    this.emitFlow?.(roomId);
    if (reason) this.notice({ roomId, message: reason });
    return [...touched];
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
    this.rooms.addEvent(flow.roomId, {
      author: sessionId,
      action: "test",
      summary: `隔离检查 [${task.id}]：${check.status}（exit=${exitCode ?? "unknown"}, snapshot=${snapshot?.slice(0, 12) ?? "none"}）`,
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
    if (!cache.has(cwd)) cache.set(cwd, workspaceSnapshotHash(cwd));
    const cur = cache.get(cwd);
    return cur !== undefined && cur === snap;
  }

  getFlow(roomId: string): Record<string, unknown> | undefined {
    const flow = this.flows.get(roomId);
    if (!flow) return undefined;
    const room = this.rooms.get(roomId);
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
        name: room?.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId,
        status: t.status,
        task: t.task,
        dependsOn: t.dependsOn,
        iteration: t.iteration,
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
                  : room?.members.find((m) => m.sessionId === waiting.to)?.name ?? waiting.to,
              waitingQuestion: waiting.question.slice(0, 200),
              waitingHelpId: waiting.id,
            }
          : {}),
        ...(t.verifications?.length
          ? {
              verifications: t.verifications.map((v) => ({
                by: room?.members.find((m) => m.sessionId === v.by)?.name ?? v.by,
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
      phase: flow.phase,
      goal: flow.goal,
      acceptanceCriteria: flow.acceptanceCriteria,
      iteration: flow.iteration,
      maxIterations: flow.maxIterations,
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

  /** prompt 异常（含取消）时清理该会话在编排中的状态 */
  onPromptError(sessionId: string): string | undefined {
    this.pendingToolCalls.delete(sessionId);
    for (const [roomId, flow] of [...this.flows]) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.flows.delete(roomId);
        continue;
      }
      if (flow.phase === "done") continue;
      if (sessionId === room.conductorId) {
        this.flows.delete(roomId);
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
              room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId
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

  private buildMemberList(room: Room): string {
    return room.members
      .filter((m) => m.sessionId !== room.conductorId)
      .map((m) => `${m.name} (id: ${m.sessionId})`)
      .join("、") || "（无）";
  }

  private buildExample(room: Room): string {
    const others = room.members.filter((m) => m.sessionId !== room.conductorId);
    if (others.length === 0) {
      return '{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[]}';
    }
    const sample = others.slice(0, 2).map((m, i) =>
      JSON.stringify({ to: m.sessionId, task: i === 0 ? "先处理第一个子任务" : "再处理第二个子任务" })
    );
    return `{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[${sample.join(",")}]}`;
  }

  private newFlow(roomId: string, goal: string, artifactContext?: { refs?: string[] }): Flow {
    return {
      roomId,
      phase: "planning",
      goal,
      acceptanceCriteria: [...DEFAULT_ACCEPTANCE_CRITERIA],
      iteration: 1,
      maxIterations: MAX_ITERATIONS,
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
    const example = this.buildExample(room);
    const prompt = [
      `你是群聊「${room.name}」的指挥家（Conductor）。`,
      `可派工的成员：${this.buildMemberList(room)}。`,
      "",
      `用户任务：${text}`,
      "",
      "请把任务拆解并派发给成员。",
      "协作边界：成员可能本身运行 Devin Fusion 或内部子代理。Agent Hub 只按独立责任边界、不同专长或明确依赖拆分；不要把单个成员能端到端完成的工作切成多个重复/微小任务，也不要让多个写任务修改同一文件。",
      "",
      "输出格式要求（必须严格遵守）：",
      "1. 必须输出一个 JSON code block；tasks 非空时 JSON 外不要有文字。",
      "2. JSON 顶层字段必须包含 `goal`（用一句话重述最终目标）、`acceptanceCriteria`（数组，每条是可验证的验收标准）和 `tasks`（数组）。",
      "3. 每个任务对象包含 `to`（接收成员）、`task`（具体子任务描述），可选 `id`（任务标识）和 `dependsOn`（依赖的 id 数组）。",
      "4. `to` 可以是：成员 ID（括号里的 `id:...`）、`@成员名` 或成员名。",
      "5. `task` 必须具体、可执行，不要写占位符。",
      "6. 如果任务有依赖关系，请用 `dependsOn` 指定前置任务 `id`。",
      "7. `acceptanceCriteria` 每条都必须是可验证的标准，用于任务完成后验收是否达标。",
      "8. 如果任务简单、无需分工，tasks 输出 `[]`；tasks 为空时允许在 code block 之前直接写出你的最终回答。",
      "9. 仅当缺少必须由用户决定的关键信息、完全无法给出合理计划时，可同时输出 `questions` 数组（1-4 条、每条不超过 200 字、只问不可或缺的问题），此时 `tasks` 必须为 `[]`；Hub 会把问题转给用户，答复后会再请你规划一次，届时不得再次提问。可自主判断的细节不要提问，也不要请求用户批准执行任意命令。",
      "",
      "正确示例（请用实际成员 ID 替换）：",
      "```json",
      example,
      "```",
      "",
      "错误示例（不要这样做）：",
      '- to: "成员A"（不存在该成员）',
      '- task: "处理一下"（不够具体）',
      '- 输出多个 code block 或在 JSON 外加解释文字',
    ];
    if (qa) {
      prompt.push(
        "",
        "你此前就本任务向用户提问，答复如下：",
        ...qa.questions.map((q, i) => `${i + 1}. ${q}`),
        `用户答复：${qa.answer.slice(0, 2000)}`,
        ...(qa.criteria.length > 0
          ? ["", "验收标准：", ...qa.criteria.map((c, i) => `${i + 1}. ${c}`)]
          : []),
        ...(qa.supplements.length > 0
          ? [
              "",
              "用户在等待答复期间补充的要求（请一并纳入拆解与验收）：",
              ...qa.supplements.map((s) => `- ${s.slice(0, 400)}`),
            ]
          : []),
        "",
        "已收集所需信息：请直接输出最终计划（tasks）或最终回答，不要再输出 questions。",
      );
    }
    if (artifactContext?.refs?.length) {
      const artifacts = this.rooms.getArtifactsForPrompt(room.roomId, room.conductorId!, artifactContext);
      if (artifacts.length > 0) {
        prompt.push("", "用户明确引用了以下产物，请把它们作为上下文：");
        for (const a of artifacts) {
          const parts = [`@${this.rooms.memberName(room.roomId, a.author)}`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          prompt.push(`- ${parts.join(" ")}`);
        }
      }
    }
    return prompt.join("\n");
  }

  private sendPlanningPrompt(flow: Flow, room: Room): void {
    if (flow.phase !== "planning" || !room.conductorId) {
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
    this.agent.prompt(room.conductorId, promptText).catch((err: unknown) => {
      logError("conductor planning prompt", err);
      const cur = this.flows.get(flow.roomId);
      if (cur !== flow || cur.phase !== "planning") return;
      this.planningInFlight.delete(flow.roomId);
      setTimeout(() => {
        const f = this.flows.get(flow.roomId);
        if (f !== flow || f.phase !== "planning") return;
        this.sendPlanningPrompt(f, room);
      }, this.promptRetryMs);
    });
  }

  async start(
    room: Room,
    text: string,
    initialTasks?: { to: string; task: string; id?: string; dependsOn?: string[] }[],
    artifactContext?: { refs?: string[] },
  ): Promise<void> {
    if (!room.conductorId) throw new Error("room has no conductor");
    this.planningInFlight.delete(room.roomId);
    if (initialTasks && initialTasks.length > 0) {
      // 由 auto 模式推荐的初始派工单，直接 dispatch
      this.flows.set(room.roomId, this.newFlow(room.roomId, text, artifactContext));
      const flow = this.flows.get(room.roomId)!;
      await this.dispatchFromTasks(flow, room, initialTasks, text);
      return;
    }
    const promptText = this.buildPlanningPrompt(room, text, artifactContext);
    const flow = this.newFlow(room.roomId, text, artifactContext);
    this.flows.set(room.roomId, flow);
    this.planningInFlight.add(room.roomId);
    this.notice({ roomId: room.roomId, message: "指挥家拆解任务中…" });
    try {
      await this.agent.prompt(room.conductorId, promptText);
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
        this.flows.delete(flow.roomId);
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
          const toName = room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
          const fromName = room.members.find((m) => m.sessionId === reply.from)?.name ?? reply.from;
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
          const name =
            room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
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
    if (a.type === "file") {
      this.rooms.addFile(roomId, {
        author,
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
      author,
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
        message: `@${room.members.find((m) => m.sessionId === task.sessionId)?.name ?? task.sessionId} 求助次数已达上限（${MAX_HELP_ROUNDS}），按当前输出收尾`,
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
    const fromName = room.members.find((m) => m.sessionId === task.sessionId)?.name ?? task.sessionId;
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
      message: `🆘 @${fromName} 在任务 ${task.id} 向 @${target!.name} 求助：${req.question.slice(0, 160)}`,
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
      const fromName = room.members.find((m) => m.sessionId === e.from)?.name ?? e.from;
      const toName = room.members.find((m) => m.sessionId === e.to)?.name ?? e.to;
      const body = [
        `群聊「${room.name}」成员 @${fromName} 在执行子任务「${task.task.slice(0, 200)}」时向你求助：`,
        "",
        e.question,
        ...(e.context ? ["", `相关上下文：${e.context}`] : []),
        "",
        "请直接给出结论与依据；这不是派工，无需执行完整任务。",
      ].join("\n");
      const prompt = this.rooms.buildPrompt(room.roomId, body, e.to, undefined, undefined, {
        taskId: e.taskId,
      });
      this.agent.prompt(e.to, prompt).catch((err: unknown) => {
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
    setTimeout(() => {
      flow.helpRetrying = false;
      const f = this.flows.get(flow.roomId);
      if (!f || f.phase !== "working") return;
      this.dispatchPendingHelp(f, room);
      this.ensureHelpDispatch(f, room);
    }, this.promptRetryMs);
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
        : `@${room.members.find((m) => m.sessionId === e.to)?.name ?? e.to}`;
    const remaining = MAX_HELP_ROUNDS - (task.helpRounds ?? 0);
    const taskBody = [
      `你此前在执行子任务（id: ${task.id}）时向 ${fromLabel} 求助。`,
      `你的问题：${e.question}`,
      `${fromLabel} 的回复：${(e.answer ?? "（未获得回复）").slice(0, 2000)}`,
      "",
      `请据此继续完成子任务：${task.task}`,
      remaining > 0
        ? `若仍有关键阻塞可再次求助（剩余 ${remaining} 次）；否则完成任务并输出 artifact 报告 JSON。`
        : "请基于现有信息完成任务并输出 artifact 报告 JSON。",
    ].join("\n");
    const prompt = this.rooms.buildPrompt(room.roomId, taskBody, task.sessionId, undefined, undefined, {
      taskId: task.id,
      dependsOn: task.dependsOn,
    });
    this.agent.prompt(task.sessionId, prompt).catch((err: unknown) => {
      task.retries = (task.retries ?? 0) + 1;
      const msg = String(err);
      if (task.retries >= 3) {
        task.status = "failed";
        task.failureMessage = msg;
        this.emitFlow?.(flow.roomId);
        this.scheduleTasks(flow, room).catch((e2) =>
          logError("conductor schedule after help fail", e2),
        );
        return;
      }
      // 恢复等待标记后重试唤醒
      task.waitingForHelp = e.id;
      setTimeout(() => {
        const f = this.flows.get(flow.roomId);
        if (f) this.repromptAsker(f, room, e);
      }, this.promptRetryMs);
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
    const verifierName =
      room.members.find((m) => m.sessionId === verifierId)?.name ?? verifierId;
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
        author: verifierId,
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
      this.flows.delete(flow.roomId);
      this.emitFlow?.(flow.roomId);
      this.notice({
        roomId: flow.roomId,
        message: "指挥家输出无法解析为任务计划，重试一次仍失败；本轮未派工，请重试",
      });
      return;
    }
    const tasks = plan.tasks;
    if (plan.questions.length > 0 && !flow.clarificationAsked) {
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
      this.flows.delete(flow.roomId);
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
      this.flows.delete(flow.roomId);
      return;
    }
    flow.phase = "working";

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
      this.flows.delete(flow.roomId);
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
        const names = failedTasks.map((t) => room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId);
        this.notice({
          roomId: flow.roomId,
          message: `所有子任务均失败（${names.join("、")}），无法汇总`,
        });
        flow.phase = "done";
        this.emitFlow?.(flow.roomId);
      }
      return;
    }

    const assignments: string[] = [];
    let skippedBusy = false;
    for (const t of tasks) {
      if (this.agent.isBusy(t.sessionId)) {
        skippedBusy = true;
        continue;
      }
      t.status = "running";
      delete t.backendRuns;
      delete t.automaticCheck;
      this.pendingToolCalls.delete(t.sessionId);
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
      assignments.push(`@${name}：${t.task}`);
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
          ? room.members.find((m) => m.sessionId === depTask.sessionId)?.name ?? depTask.sessionId
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
      const taskBody = [
        ...(upstreamLines.length > 0
          ? [
              "前置任务结果（这是你的直接输入，请在此基础上继续）：",
              ...upstreamLines,
              "",
            ]
          : []),
        `指挥家派发给你的子任务（id: ${t.id}）：${t.task}`,
        ...this.clarificationQaLines(flow),
        ...(flow.supplements.length > 0
          ? [
              "",
              "用户在执行中补充了要求（请遵循）：",
              ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
            ]
          : []),
        "",
        "你拥有该子任务的端到端责任；若当前 Agent 支持 Fusion 或内部子代理，可用于本任务内的探索、实现和验证，但不要把工作再次分派给群聊中的其他成员。",
        "",
        "协作约定：",
        "- 如遇阻塞需要他人关键信息，在输出末尾附一个求助块并结束本轮，Hub 会把回复转回给你后继续；",
        '  ```json',
        '  {"help":{"to":"成员名/id 或 \\"user\\"（求助用户）","question":"具体问题"}}',
        '  ```',
        "- 若你的产出是对其他成员任务的独立验证，请在报告 JSON 中附加 verify 数组；evidence 必须基于被验证任务提交的 baseline/diff/verifyCommand 进行实际复核；command/exitCode/stdout 仅在你确实运行了命令且有工具输出反馈时填写，不要编造——该结论属于成员判断，不代表 Hub 自动执行了检查：",
        '  ```json',
        '  {"verify":[{"task":"tX","verdict":"pass|fail|partial","evidence":{"summary":"结论","baseline":"修改前代码","diff":"..."}}]}',
        '  ```',
        "",
        "完成子任务后，请在自由文本总结后附带一个 JSON code block 报告你产生的 artifact（修改的文件、执行的命令、测试结果、以及用于他人复核的证据）：",
        '```json',
        '{"text":"你的总结","artifacts":[{"type":"file","path":"/path/to/file","summary":"改动摘要"},{"type":"command","summary":"运行的命令和结果"},{"type":"test","summary":"测试结果"}]}',
        '```',
        "",
        "若子任务涉及代码修改，强烈建议在 JSON 中附加可验证字段：baseline（修改前代码/状态）、diff（实际修改）、reproSteps（复现步骤）、verifyCommand（验证命令）。这些会直接进入验收证据，供其他成员或用户复查。",
        "若报告 verifyCommand，Hub 只会在命令与管理员已预设的检查完全匹配时尝试隔离运行；未提供 verifyCheckId 时还需文件产物。若知道预设 ID，可附加 verifyCheckId；ID 未获批准或与命令不一致不会回退为自动匹配。未获批准的命令仅保留成员自报，绝不自动运行。",
        "如果没有 artifact，可以只输出文本，不必输出 JSON。",
      ].join("\n");
      const prompt = this.rooms.buildPrompt(
        room.roomId,
        taskBody,
        t.sessionId,
        undefined,
        undefined,
        artifactContext,
      );
      this.agent.prompt(t.sessionId, prompt).catch((err: unknown) => {
        t.retries = (t.retries ?? 0) + 1;
        const msg = String(err);
        if (t.retries >= 3) {
          t.status = "failed";
          t.failureMessage = msg;
        } else {
          t.status = "pending";
        }
        this.notice({
          roomId: flow.roomId,
          message: `子任务派发失败（重试 ${t.retries}/3）：${msg}`,
        });
        setTimeout(() => {
          if (!this.flows.has(flow.roomId)) return;
          this.scheduleTasks(flow, room).catch((e) => {
            logError("conductor schedule after fail", e);
          });
        }, this.promptRetryMs);
      });
    }

    if (assignments.length > 0) {
      this.notice({ roomId: flow.roomId, message: `指挥家派工：${assignments.join("；")}` });
    }

    // Bug 4: 有 runnable task 因 isBusy 被跳过时，定时轮询重试
    if (skippedBusy) {
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        this.scheduleTasks(flow, room).catch((e) =>
          logError("conductor busy retry reschedule", e),
        );
      }, BUSY_RETRY_MS);
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
      task: `独立复核（质疑性验证）：请逐项审查已完成任务 ${doneIds.join("、")} 的交付内容与自报验证证据，主动挑战其假设、寻找遗漏的边界与负面用例；对每个被复核任务在报告 JSON 中输出结构化 verify 条目，evidence 必须基于该任务提交的 baseline/diff/verifyCommand 实际复核，仅当你确实运行过命令且有工具输出反馈时才填写 command/exitCode/stdout，不得编造执行记录或正向结论。`,
      dependsOn: doneIds,
      status: "pending",
      iteration: flow.iteration,
    });
    flow.challengeScheduled = true;
    flow.challengeTaskId = taskId;
    this.emitFlow?.(flow.roomId);
    this.notice({
      roomId: flow.roomId,
      message: `新增独立复核任务 ${taskId}：@${reviewer.name} 对已完成交付做质疑性验证`,
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

  private async review(flow: Flow, room: Room): Promise<void> {
    if (flow.phase !== "working" && flow.phase !== "reviewing") return;
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
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
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
            `    - @${room.members.find((m) => m.sessionId === v.by)?.name ?? v.by}：${v.verdict}${v.evidence ? `（${summarizeEvidence(v.evidence).slice(0, 300)}）` : ""}`,
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
    const criteria = flow.acceptanceCriteria.length > 0
      ? flow.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "（未提供，按用户目标自行判断）";
    const prompt = [
      `你是群聊「${room.name}」的指挥家。`,
      "",
      `原始目标：${flow.goal || "（未记录）"}`,
      "",
      "验收标准：",
      criteria,
      "",
      `第 ${flow.iteration}/${flow.maxIterations} 轮子任务已全部完成，结果如下：`,
      ...lines,
      ...this.clarificationQaLines(flow),
      ...(flow.supplements.length > 0
        ? [
            "",
            "用户在执行中补充的要求（验收时请一并核查）：",
            ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
          ]
        : []),
      "",
      hasChecks
        ? "注意：成员自报字段不等于隔离检查；退出码0只表示进程退出0，不代表全部验收标准满足；依赖/运行时未包含在源码快照哈希内，请结合证据自行评估可信度。"
        : "注意：以上结果中的命令、退出码、输出与「独立验证」条目均为成员自报，Hub 并未自动执行任何检查，不可称为自动检查通过，请结合证据自行评估可信度。",
      ...(unverifiedDone.length > 0
        ? [
            `注意：以下任务没有任何独立成员复核记录（${unverifiedDone.join("、")}），其结果均来自任务执行者自报，不得声称已经过独立验证。`,
          ]
        : []),
      "",
      "请对照验收标准逐条核查以上结果是否已满足目标。",
      "不要调用任何工具，只输出一个 JSON code block，二选一：",
      '```json',
      '{"decision":"complete","reason":"为什么已经满足全部验收标准"}',
      '```',
      "或",
      '```json',
      '{"decision":"continue","reason":"尚缺什么","tasks":[{"id":"可选","to":"成员 id/名称","task":"明确返工或补充任务","dependsOn":["已有或本轮任务 id"]}]}',
      '```',
      "要求：只针对验收缺口派最少的任务，不要重复已完成的工作。",
      `可派工的成员：${this.buildMemberList(room)}。`,
    ].join("\n");
    try {
      await this.agent.prompt(room.conductorId!, prompt);
    } catch (err) {
      logError("conductor review prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家验收派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        if (flow.phase !== "reviewing") return;
        this.review(flow, room).catch((e) => logError("conductor review retry", e));
      }, this.promptRetryMs);
    }
  }

  private async handleReview(flow: Flow, room: Room, output: string): Promise<void> {
    const decision = parseReviewDecision(output, room);
    if (decision?.decision === "complete") {
      flow.reviewReason = decision.reason;
      await this.summarize(flow, room);
      return;
    }
    if (
      decision?.decision === "continue" &&
      decision.tasks.length > 0 &&
      flow.iteration < flow.maxIterations
    ) {
      flow.iteration += 1;
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
    if (flow.phase === "summarizing" && this.agent.isBusy(room.conductorId!)) return;
    flow.phase = "summarizing";
    this.emitFlow?.(flow.roomId);
    const failedTasks = [...flow.tasks.values()].filter((t) => t.status === "failed");
    const hasFailures = failedTasks.length > 0;
    // 按照 task 在 tasks Map 中的创建顺序（即指挥家给出的顺序）生成汇总
    const lines: string[] = [];
    const hashCache = new Map<string, string | undefined>();
    for (const t of flow.tasks.values()) {
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
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
            `    - @${room.members.find((m) => m.sessionId === v.by)?.name ?? v.by}：${v.verdict}${v.evidence ? `（${summarizeEvidence(v.evidence).slice(0, 300)}）` : ""}`,
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
    const promptLines: string[] = [
      `你是群聊「${room.name}」的指挥家。`,
      `原始目标：${flow.goal || "（未记录）"}`,
      `验收标准：${flow.acceptanceCriteria.length > 0 ? flow.acceptanceCriteria.join("；") : "（未提供）"}`,
      ...(flow.reviewReason ? [`验收结论：${flow.reviewReason}`] : []),
      hasFailures
        ? `你之前派发的子任务部分完成、部分失败，结果如下：`
        : `你之前派发的子任务已全部完成，结果如下：`,
      ...lines,
      ...this.clarificationQaLines(flow),
      ...(flow.supplements.length > 0
        ? [
            "",
            "用户在执行中补充的要求：",
            ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
          ]
        : []),
      hasChecks
        ? "注意：成员自报字段不等于隔离检查；退出码0只表示进程退出0，不代表全部验收标准满足；依赖/运行时未包含在源码快照哈希内，汇总时不要称为自动检查通过。"
        : "注意：以上结果中的命令、退出码、输出与「独立验证」条目均为成员自报，Hub 并未自动执行任何检查，汇总时不要称为自动检查通过。",
      ...(unverifiedDone.length > 0
        ? [
            `注意：以下任务没有任何独立成员复核记录（${unverifiedDone.join("、")}），其结果均来自任务执行者自报，汇总时不得声称已经过独立验证。`,
          ]
        : []),
      "",
    ];
    if (hasFailures) {
      const failedNames = failedTasks
        .map((t) => room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId)
        .join("、");
      promptLines.push(
        `以下子任务未能完成：${failedNames}。`,
        "请在汇总中：",
        "1. 基于已完成的子任务给出可交付的部分成果；",
        "2. 明确标注哪些部分未完成及其影响；",
        "3. 建议用户是否需要重新派发失败的部分。",
        "",
      );
    }
    promptLines.push(
      "请用简短答复交付：先给结论（完成了什么、是否满足目标），再列未解决或待确认事项（没有则写「无」），最后说明实际复核情况；逐项区分成员判断与 Hub 隔离检查，对未运行或受阻的检查如实说明，不因一项任务通过就称其他任务已验证。技术细节和完整输出留在可展开的任务证据中；若修改文件，请引用相关路径。",
    );
    const prompt = promptLines.join("\n");
    this.notice({
      roomId: flow.roomId,
      message: hasFailures ? "子任务部分完成，指挥家降级汇总中…" : "子任务全部完成，指挥家汇总中…",
    });
    try {
      await this.agent.prompt(room.conductorId!, prompt);
    } catch (err) {
      logError("conductor summarize prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家汇总派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        if (flow.phase !== "summarizing") return;
        this.summarize(flow, room).catch((e) => logError("conductor summarize retry", e));
      }, this.promptRetryMs);
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
      this.flows.delete(roomId);
      return false;
    }
    const failed = [...flow.tasks.values()].filter(
      (t) => t.status === "failed" && (!taskIds || taskIds.includes(t.id)),
    );
    if (failed.length === 0) return false;
    for (const t of failed) {
      t.status = "pending";
      delete t.failureMessage;
      t.retries = 0;
    }
    flow.phase = "working";
    this.emitFlow?.(roomId);
    const failedIds = failed.map((t) => t.id);
    this.notice({ roomId, message: `重试失败子任务：${failedIds.join(", ")}` });
    this.scheduleTasks(flow, room).catch((e) => logError("conductor retry schedule", e));
    return true;
  }

  export(): Record<string, unknown> {
    return {
      flows: [...this.flows.values()].map((flow) => ({
        roomId: flow.roomId,
        phase: flow.phase,
        goal: flow.goal,
        acceptanceCriteria: flow.acceptanceCriteria,
        iteration: flow.iteration,
        maxIterations: flow.maxIterations,
        ...(flow.reviewReason !== undefined ? { reviewReason: flow.reviewReason } : {}),
        tasks: [...flow.tasks.values()].map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          task: t.task,
          dependsOn: t.dependsOn,
          status: t.status,
          iteration: t.iteration,
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
      })),
    };
  }

  async import(state: Record<string, unknown>): Promise<void> {
    const flows = state.flows;
    if (!Array.isArray(flows)) return;
    for (const raw of flows) {
      const f = raw as Record<string, unknown>;
      const roomId = String(f.roomId ?? "");
      const room = this.rooms.get(roomId);
      if (!room || !room.conductorId) continue;
      const refsArr = Array.isArray((f.artifactContext as Record<string, unknown>)?.refs)
        ? ((f.artifactContext as Record<string, unknown>).refs as unknown[]).map((s) => String(s)).filter(Boolean)
        : [];
      const artifactContext = f.artifactContext && typeof f.artifactContext === "object" && refsArr.length > 0
        ? { refs: refsArr }
        : undefined;
      const flow: Flow = {
        roomId,
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
        if (!room.members.some((m) => m.sessionId === sessionId)) continue;
        const rawStatus = String(o.status ?? "pending");
        const status: FlowTask["status"] =
          rawStatus === "done" || rawStatus === "failed" || rawStatus === "running"
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
          ...(typeof o.failureMessage === "string" ? { failureMessage: o.failureMessage } : {}),
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
      this.flows.set(roomId, flow);
      if (flow.phase === "done") {
        this.emitFlow?.(roomId);
        continue;
      }
      this.notice({
        roomId,
        message:
          flow.phase === "awaiting-retry"
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
  return room.members.find((m) => m.name.toLowerCase().includes(to.toLowerCase()));
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
  constructor(public readonly reason: string) {
    super(reason);
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
      "/usr/bin/git",
      ["-c", "core.fsmonitor=false", "-C", realCwd, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ).trim();
    if (inside !== "true") throw new IsoAbort("snapshot_error");
    const out = execFileSync(
      "/usr/bin/git",
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
    throw new IsoAbort("snapshot_error");
  }
}

function snapshotWorkspace(srcRoot: string, dstRoot?: string): string {
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
      throw new IsoAbort("snapshot_error");
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

function gitRepoLayout(realCwd: string): { repoName: string; relCwd: string } {
  try {
    const top = execFileSync(
      "/usr/bin/git",
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
  const blocked = (reason: string) => finish("blocked", { reason });
  const trimmed = typeof command === "string" ? command.trim() : "";
  if (!trimmed || trimmed.length > ISO_COMMAND_MAX || /[\r\n]/.test(trimmed)) {
    return blocked("invalid_command");
  }
  if (isolatedCheckInFlight) return blocked("busy");
  if (process.platform !== "linux") return blocked("unavailable");
  if (!fs.existsSync("/usr/bin/systemd-run") || !fs.existsSync("/usr/bin/bwrap")) {
    return blocked("unavailable");
  }
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
      child.on("error", () => {
        clearTimeout(killTimer);
        resolve({
          spawnError: true,
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
    if (outcome.spawnError) return blocked("start_failed");
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
        return blocked("start_failed");
      }
      return finish("exited_nonzero", { ...shared, exitCode: code });
    }
    return finish("exited_zero", { ...shared, exitCode: 0 });
  } catch (e) {
    if (e instanceof IsoAbort) return blocked(e.reason);
    return blocked("snapshot_error");
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
