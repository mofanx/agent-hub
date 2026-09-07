import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import spawn from "cross-spawn";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpAgent,
  getPermissionBypass,
  promptDoneInternalOutput,
  setPermissionBypass,
  toPublicHubEvent,
  type HubEvent,
} from "./agent.js";
import { RoomManager, type Room, type RoomMode, type RoomModeConfig, type EventAction } from "./room.js";
import { RoomModeManager } from "./room-modes.js";
import type { AgentOps } from "./room-modes.js";
import { Store, type SessionMeta, type Connection } from "./store.js";
import { SessionLedger } from "./session-ledger.js";
import { extractTaskResult } from "./conductor.js";
import { startTunnel } from "./tunnel.js";
import { webSocketStream, multiplexWebSocketStream, isControlFrame, isAnnounceFrame, type ControlFrame } from "./stream.js";
import { AGENT_DEFS, type AgentDef } from "./agent-defs.js";
import { ModelManager, type ModelInfo, type BackendConfig, type ModelBackend } from "./model.js";
import { logError, logWarn } from "./logger.js";
import { discoverSkills } from "./skills.js";
import { Scheduler, type ScheduledTask, type TaskLog } from "./scheduler.js";
import { WorkerExecutionProvider, isQualityControlFrame, type QualityControlFrame } from "./quality/execution-worker.js";
import { QualityService, type Emit, type QualityEvent } from "./quality/service.js";
import { recoverInterruptedRuns } from "./quality/recovery.js";
import { isTerminal } from "./quality/run.js";
import { RunPermissionManager } from "./quality/permissions.js";
import { ReviewOrchestrator, type ReviewerSessionRunner } from "./quality/review-orchestrator.js";
import { FixerOrchestrator, type FixerSessionRunner } from "./quality/fixer-orchestrator.js";
import { GateEngine, type GateResult } from "./quality/gate.js";
import type { ExecutionProvider } from "./quality/execution.js";
import { LocalExecutionProvider } from "./quality/execution-local.js";
import { collectChangeSet, collectBaseline } from "./quality/change-set.js";
import type { ChangeSet, CheckTier, QualityPolicy, QualityRisk, QualityRun, QualityTrigger } from "./quality/types.js";
import type { QualityIntegration } from "./conductor.js";

const PORT = Number(process.env.HUB_PORT ?? 8787);
const TOKEN = process.env.HUB_TOKEN ?? "dev-token";
const WORKER_PATH = "/worker";

if (TOKEN === "dev-token") {
  logWarn("config", "using default token, set HUB_TOKEN in production");
}

const clients = new Set<WebSocket>();
const rooms = new RoomManager();
const agents = new Map<string, AcpAgent>();
const owners = new Map<string, string>();
const localStarts = new Map<string, Promise<void>>();
const localAgentErrors = new Map<string, string>();
const workerExecProviders = new Map<string, WorkerExecutionProvider>();
const localExecProvider = new LocalExecutionProvider();
const store = new Store();
const modelManager = new ModelManager();
const qualityRunCallbacks = new Map<string, (accepted: boolean) => void>();
const runPermissionManager = new RunPermissionManager();
const qualityEmit: Emit = (event: QualityEvent) => {
  broadcast(event as HubEvent);
  const { runId, run } = event.params;
  if (isTerminal(run.stage)) {
    runPermissionManager.unbindRun(runId);
    const cb = qualityRunCallbacks.get(runId);
    if (cb) {
      qualityRunCallbacks.delete(runId);
      cb(run.stage === "accepted");
    }
  }
};
const qualityArtifactDir = path.resolve(process.cwd(), "data", "quality");

/**
 * ReviewerSessionRunner 实现：使用第一个可用 agent 创建/复用 reviewer session。
 * 在 reviewRunner 回调被触发时，agent 可能已连接。
 */
const reviewerSessionRunner: ReviewerSessionRunner = {
  async ensureSession(opts) {
    // 复用已有 reviewerSessionId
    if (opts.existingSessionId) return opts.existingSessionId;
    // 找一个可用的 agent 创建新 session
    const agent = [...agents.values()].find((a) => a.isReady);
    if (!agent) throw new Error("no agent available for reviewer session");
    const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
    owners.set(sessionId, [...agents.entries()].find(([, a]) => a === agent)![0]);
    return sessionId;
  },
  async promptOnce(sessionId, text, timeoutMs) {
    const agent = agentForSession(sessionId);
    if (!agent) throw new Error(`agent not found for reviewer session ${sessionId}`);
    return agent.promptOnce(sessionId, text, timeoutMs);
  },
};

let reviewOrchestrator: ReviewOrchestrator | undefined;

/** reviewRunner 回调：当 run 进入 reviewing 阶段时触发 ReviewOrchestrator。 */
const reviewRunner = (run: { id: string; stage: string }) => {
  if (run.stage !== "reviewing") return;
  if (!reviewOrchestrator) {
    reviewOrchestrator = new ReviewOrchestrator(
      qualityService,
      runPermissionManager,
      reviewerSessionRunner,
      { artifactDir: qualityArtifactDir },
    );
  }
  reviewOrchestrator.runReview(run.id).catch((err) => {
    logError("review-orchestrator", err);
    // 安全失败：推进到 failed
    try {
      qualityService.advance(run.id, "failed");
    } catch { /* run 可能已终态 */ }
  });
};

/**
 * FixerSessionRunner 实现：复用 implementer session 或创建新 session。
 */
const fixerSessionRunner: FixerSessionRunner = {
  async ensureSession(opts) {
    if (opts.existingSessionId) return opts.existingSessionId;
    const agent = [...agents.values()].find((a) => a.isReady);
    if (!agent) throw new Error("no agent available for fixer session");
    const { sessionId } = await agent.createSession(opts.project.root, "fixer");
    owners.set(sessionId, [...agents.entries()].find(([, a]) => a === agent)![0]);
    return sessionId;
  },
  async promptOnce(sessionId, text, timeoutMs) {
    const agent = agentForSession(sessionId);
    if (!agent) throw new Error(`agent not found for fixer session ${sessionId}`);
    return agent.promptOnce(sessionId, text, timeoutMs);
  },
};

/** GateEngine 使用的 ExecutionProvider：优先用 workerExecProviders，否则 LocalExecutionProvider。 */
function resolveGateExecProvider(): ExecutionProvider {
  for (const provider of workerExecProviders.values()) {
    return provider;
  }
  return localExecProvider;
}

let fixerOrchestrator: FixerOrchestrator | undefined;

/** fixerRunner 回调：当 run 进入 fixing 阶段时触发 FixerOrchestrator。 */
const fixerRunner = (run: { id: string; stage: string }) => {
  if (run.stage !== "fixing") return;
  if (!fixerOrchestrator) {
    const gateEngine = new GateEngine(resolveGateExecProvider(), {
      onSaveCheck: (check) => qualityService.saveCheck(check),
    });
    fixerOrchestrator = new FixerOrchestrator(
      qualityService,
      runPermissionManager,
      fixerSessionRunner,
      gateEngine,
      { artifactDir: qualityArtifactDir },
    );
  }
  fixerOrchestrator.runFix(run.id).catch((err) => {
    logError("fixer-orchestrator", err);
    try {
      qualityService.advance(run.id, "failed");
    } catch { /* run 可能已终态 */ }
  });
};

/**
 * 通用 gate runner 工厂：在 quick-verifying / full-verifying 阶段执行 gate 检查并按结果自动推进。
 *
 * 推进规则：
 * - passed → quick: review.enabled ? reviewing : full-verifying；full: autonomy=observe ? awaiting-approval : accepted
 * - codeFailed → 有 fix 预算 ? fixing : failed
 * - infraFailed/cancelled → failed
 */
function makeGateRunner(tier: CheckTier): (run: { id: string; stage: string }) => void {
  return (run) => {
    const stage = tier === "quick" ? "quick-verifying" : "full-verifying";
    if (run.stage !== stage) return;
    const runId = run.id;
    const current = qualityService.getRun(runId);
    if (!current || current.stage !== stage) return;
    const project = qualityService.getProject(current.projectId);
    if (!project) {
      logWarn("gate-runner", `unknown project ${current.projectId} for run ${runId}`);
      try { qualityService.advance(runId, "failed"); } catch { /* */ }
      return;
    }
    const { policy } = qualityService.getPolicy(current.projectId);
    const baseline = collectBaseline(project);
    let changeSet: ChangeSet | undefined;
    try {
      changeSet = collectChangeSet(runId, project, baseline, {
        protectedPaths: policy.protectedPaths,
        riskRules: policy.riskRules,
      }, qualityArtifactDir);
      qualityService.saveRun({ ...current, patchHash: changeSet.patchHash });
    } catch (err) {
      logWarn("gate-runner", `changeSet collection failed for run ${runId}: ${String(err)}`);
      changeSet = undefined;
    }
    const gate = new GateEngine(resolveGateExecProvider(), {
      onSaveCheck: (check) => qualityService.saveCheck(check),
    });
    const attempt = current.fixRound + 1;
    gate.runGate(project, policy, tier, runId, changeSet, attempt).then((result) => {
      advanceAfterGate(runId, result, current, policy, tier);
    }).catch((err) => {
      logError("gate-runner", err);
      try { qualityService.advance(runId, "failed"); } catch { /* */ }
    });
  };
}

/**
 * gate 完成后按结果推进 run 状态。
 * - quick passed → review.enabled ? reviewing : full-verifying
 * - full passed → autonomy=observe ? awaiting-approval : accepted（需 patchHash）
 * - codeFailed → 有 fix 预算 ? fixing : failed
 * - infraFailed/cancelled → failed
 */
function advanceAfterGate(
  runId: string,
  gate: GateResult,
  run: QualityRun,
  policy: QualityPolicy,
  tier: CheckTier,
): void {
  if (gate.passed) {
    if (tier === "quick") {
      if (policy.review.enabled) {
        qualityService.advance(runId, "reviewing");
      } else {
        qualityService.advance(runId, "full-verifying");
      }
    } else {
      // full gate 通过
      if (policy.autonomy === "observe") {
        qualityService.advance(runId, "awaiting-approval");
      } else {
        // autonomy=auto-apply 需要 patchHash 才能 accepted
        if (run.patchHash) {
          qualityService.advance(runId, "accepted");
        } else {
          qualityService.advance(runId, "awaiting-approval");
        }
      }
    }
    return;
  }
  if (gate.infraFailed || gate.cancelled) {
    logWarn("gate-runner", `run ${runId} ${tier} gate infra-failed/cancelled, failing`);
    try { qualityService.advance(runId, "failed"); } catch { /* */ }
    return;
  }
  // codeFailed：检查 fix 预算
  if (run.fixRound >= run.budget.maxFixRounds) {
    logWarn("gate-runner", `run ${runId} exceeded maxFixRounds (${run.fixRound}/${run.budget.maxFixRounds}), failing after ${tier} gate`);
    try { qualityService.advance(runId, "failed"); } catch { /* */ }
    return;
  }
  try { qualityService.advance(runId, "fixing"); } catch { /* */ }
}

const quickRunner = makeGateRunner("quick");
const fullRunner = makeGateRunner("full");

const qualityService = new QualityService(store, qualityEmit, {
  reviewRunner,
  fixerRunner,
  quickRunner,
  fullRunner,
  sandboxRunner: async (opts) => {
    const project = qualityService.getProject(opts.projectId);
    if (!project) return { passed: false, checkSummaries: [], checksTotal: 0, checksPassed: 0, checksFailed: 1 };
    const gate = new GateEngine(resolveGateExecProvider(), {
      onSaveCheck: (check) => qualityService.saveCheck(check),
    });
    const sandboxRunId = `sandbox-${randomBytes(4).toString("hex")}`;
    const result = await gate.runGate(project, opts.sandboxPolicy, "quick", sandboxRunId, undefined);
    const summaries = result.checks.map((c) => `[${c.status}] ${c.checkId}: ${c.summary ?? ""}`);
    const checksPassed = result.checks.filter((c) => c.status === "passed").length;
    const checksFailed = result.checks.filter((c) => c.status !== "passed").length;
    return {
      passed: result.passed,
      checkSummaries: summaries,
      checksTotal: result.checks.length,
      checksPassed,
      checksFailed,
    };
  },
});

function findProjectForPaths(
  projects: ReturnType<QualityService["listProjects"]>,
  filePaths: string[],
): ReturnType<QualityService["getProject"]> | undefined {
  for (const p of projects) {
    const root = p.root.endsWith("/") ? p.root : p.root + "/";
    if (filePaths.some((fp) => fp.startsWith(root) || fp === p.root)) return p;
  }
  return projects[0];
}

const qualityIntegration: QualityIntegration = {
  startRunForTask(opts) {
    const projects = qualityService.listProjects();
    if (projects.length === 0) return undefined;
    const filePaths = opts.artifacts
      .filter((a) => a.type === "file" && a.path)
      .map((a) => a.path!);
    const project = findProjectForPaths(projects, filePaths);
    if (!project) return undefined;
    const { policy } = qualityService.getPolicy(project.id);
    const reviewerSessionId = policy.review.reviewerSessionId;
    const run = qualityService.startRun({
      projectId: project.id,
      trigger: "conductor",
      ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      ...(opts.sessionId !== undefined ? { implementerSessionId: opts.sessionId } : {}),
      ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
      risk: "medium",
      policyVersion: String(policy.version),
      budget: { maxFixRounds: policy.review.maxFixRounds ?? 2, timeoutMs: 60000 },
    });
    if (opts.sessionId) {
      runPermissionManager.bindSession(opts.sessionId, run.id, "implementer");
    }
    if (reviewerSessionId) {
      runPermissionManager.bindSession(reviewerSessionId, run.id, "reviewer");
    }
    // 状态机自驱：Conductor 创建 run 后立即把它从 queued 推到 quick-verifying，触发 gate runner
    try {
      qualityService.advance(run.id, "preflight");
      qualityService.advance(run.id, "implementing");
      qualityService.advance(run.id, "collecting");
      qualityService.advance(run.id, "quick-verifying");
    } catch (err) {
      logError("quality auto-advance", `run ${run.id} failed to advance: ${String(err)}`);
    }
    return run.id;
  },
  onRunTerminal(runId, cb) {
    const run = qualityService.getRun(runId);
    if (run && isTerminal(run.stage)) {
      cb(run.stage === "accepted");
    } else {
      qualityRunCallbacks.set(runId, cb);
    }
  },
  recoverRun(runId, cb) {
    const run = qualityService.getRun(runId);
    if (!run) {
      cb(false);
      return;
    }
    if (isTerminal(run.stage)) {
      cb(run.stage === "accepted");
      return;
    }
    qualityRunCallbacks.set(runId, cb);
  },
};

rooms.setRoleResolver((roleId) => store.listRoles().find((r) => r.id === roleId)?.persona);
ensureDefaultLocalConnections();
const savedState = store.load();
const savedRuntime = savedState.runtime;
const sessionMetas = new Map<string, SessionMeta>(
  savedState.sessions.map((s) => [s.sessionId, s]),
);
const sessionLedger = new SessionLedger();
sessionLedger.importFromMeta(savedState.sessions);
rooms.setCwdResolver((sessionId) => sessionMetas.get(sessionId)?.cwd);
for (const room of savedState.rooms) rooms.import(room);

const LOST_REPLY_PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]";
const LOST_REPLY_NOTE = "上一条用户消息已处理，但回复因 Hub 重启未保存。请直接回答以下新消息，不要重复处理上一条：";

function sessionLostReplyNote(sessionId: string): string | undefined {
  const meta = sessionMetas.get(sessionId);
  const baseName = meta?.name ?? sessionId;
  const origin = originFor(meta);
  const displayName = origin ? `${baseName} (${origin})` : baseName;
  const entries = store.read("session", sessionId);
  const last = entries[entries.length - 1];
  if (!last) return undefined;
  if (last.kind === "user") {
    store.append("session", sessionId, {
      at: Date.now(),
      kind: "assistant",
      author: displayName,
      text: LOST_REPLY_PLACEHOLDER,
    });
    return LOST_REPLY_NOTE;
  }
  if (last.kind === "assistant" && last.text === LOST_REPLY_PLACEHOLDER) {
    return LOST_REPLY_NOTE;
  }
  return undefined;
}

function roomLostReplyNote(roomId: string): string | undefined {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  const entries = store.read("room", roomId);
  const last = entries[entries.length - 1];
  if (!last) return undefined;
  if (last.kind === "user") {
    store.append("room", roomId, {
      at: Date.now(),
      kind: "assistant",
      author: room.name,
      text: LOST_REPLY_PLACEHOLDER,
    });
    return LOST_REPLY_NOTE;
  }
  if (last.kind === "assistant" && last.text === LOST_REPLY_PLACEHOLDER) {
    return LOST_REPLY_NOTE;
  }
  return undefined;
}

function repairHistoryAtStartup(): void {
  for (const [sessionId, meta] of sessionMetas) {
    const entries = store.read("session", sessionId);
    const last = entries[entries.length - 1];
    if (last && last.kind === "user") {
      const baseName = meta.name ?? sessionId;
      const origin = originFor(meta);
      const displayName = origin ? `${baseName} (${origin})` : baseName;
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "assistant",
        author: displayName,
        text: LOST_REPLY_PLACEHOLDER,
      });
    }
  }
  for (const room of rooms.list()) {
    const entries = store.read("room", room.roomId);
    const last = entries[entries.length - 1];
    if (last && last.kind === "user") {
      store.append("room", room.roomId, {
        at: Date.now(),
        kind: "assistant",
        author: room.name,
        text: LOST_REPLY_PLACEHOLDER,
      });
    }
  }
}

repairHistoryAtStartup();
const qualityRecovery = recoverInterruptedRuns(store);
if (qualityRecovery.runs.length > 0) {
  console.log(`[hub] quality recovery: ${qualityRecovery.runs.length} runs, ${qualityRecovery.checks.length} checks resumed to terminal state`);
}

function parseEventAction(raw: unknown): EventAction {
  const actions: EventAction[] = ["add", "modify", "delete", "rename", "command", "test"];
  const a = String(raw ?? "").toLowerCase();
  return actions.includes(a as EventAction) ? (a as EventAction) : "command";
}

function parseRoomMode(raw: unknown): RoomMode {
  const modes: RoomMode[] = [
    "mention",
    "conductor",
    "roundrobin",
    "parallel",
    "pipeline",
    "debate",
    "auto",
  ];
  const m = String(raw ?? "").toLowerCase();
  if (modes.includes(m as RoomMode)) return m as RoomMode;
  return "mention";
}

function parseRoomModeConfig(
  params: Record<string, unknown> | undefined,
  members: { sessionId: string; name: string }[],
): RoomModeConfig {
  const all = new Set(members.map((m) => m.sessionId));
  const config: RoomModeConfig = {};
  if (params?.conductorId != null) config.conductorId = String(params.conductorId);
  if (params?.parallelSummarizerId != null) {
    const s = String(params.parallelSummarizerId);
    if (all.has(s)) config.parallelSummarizerId = s;
  }
  if (Array.isArray(params?.pipelineOrder)) {
    config.pipelineOrder = (params.pipelineOrder as unknown[])
      .map((s) => String(s))
      .filter((sid) => all.has(sid));
  }
  if (Array.isArray(params?.debateSides) && (params.debateSides as unknown[]).length >= 2) {
    const raw = (params.debateSides as unknown[])
      .map((s) => String(s))
      .filter((sid) => all.has(sid));
    if (raw.length >= 2) config.debateSides = [raw[0], raw[1]] as [string, string];
  }
  if (params?.debateJudge != null) {
    const s = String(params.debateJudge);
    if (all.has(s)) config.debateJudge = s;
  }
  if (params?.debateRounds != null) {
    const n = Number(params.debateRounds);
    if (Number.isFinite(n) && n > 0) config.debateRounds = Math.max(1, Math.min(5, Math.floor(n)));
  }
  if (params?.memberRoles != null && typeof params.memberRoles === "object") {
    const roles: Record<string, string> = {};
    for (const [sid, v] of Object.entries(params.memberRoles as Record<string, unknown>)) {
      if (all.has(sid) && typeof v === "string" && v.trim()) {
        roles[sid] = v.trim();
      }
    }
    if (Object.keys(roles).length > 0) config.memberRoles = roles;
  }
  return config;
}

function enrichRoom(room: Room): Record<string, unknown> {
  const sub = roomModeManager.subModeFor(room.roomId);
  return { ...room, subMode: sub?.mode, activeSpeaker: sub?.activeSpeaker, reason: sub?.reason };
}

function persistState(): void {
  store.save({
    sessions: sessionLedger.attachTo([...sessionMetas.values()]),
    rooms: rooms.list(),
    runtime: roomModeManager.exportRuntime(),
  });
}

function isSessionNameTaken(name: string, excludeSessionId?: string): boolean {
  for (const meta of sessionMetas.values()) {
    if (meta.sessionId === excludeSessionId) continue;
    if (meta.name === name) return true;
  }
  return false;
}

function isRoomNameTaken(name: string, excludeRoomId?: string): boolean {
  for (const room of rooms.list()) {
    if (room.roomId === excludeRoomId) continue;
    if (room.name === name) return true;
  }
  return false;
}

async function cloneSessionWithName(
  source: SessionMeta,
  targetName: string,
): Promise<{ sessionId: string; name: string }> {
  const connectionId = source.connectionId;
  if (!connectionId) throw new Error("source session has no connection");
  const connection = getConnectionById(connectionId);
  if (!connection) throw new Error(`unknown connection: ${connectionId}`);
  if (connection.local) await ensureLocalAgent(connection);
  const agent = agents.get(connection.id);
  if (!agent) throw new Error("agent 未连接");

  const s = await agent.createSession(source.cwd, targetName);
  sessionMetas.set(s.sessionId, {
    sessionId: s.sessionId,
    cwd: source.cwd,
    name: s.name,
    agent: connection.agent,
    connectionId: connection.id,
    roleId: source.roleId,
  });
  owners.set(s.sessionId, connection.id);
  persistState();

  if (source.roleId) {
    const role = store.listRoles().find((r) => r.id === source.roleId);
    if (role) {
      const personaPrompt =
        `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
      agentOps
        .prompt(s.sessionId, personaPrompt)
        .catch((err) => logWarn("persona", `inject failed: ${String(err)}`));
    }
  }
  return s;
}

function ensureDefaultLocalConnections(): void {
  const existing = store.listConnections();
  let created = false;
  for (const agent of Object.keys(AGENT_DEFS)) {
    const id = `local-${agent}`;
    if (existing.some((c) => c.id === id)) continue;
    store.addConnection({
      id,
      name: `本地 ${agent}`,
      agent,
      token: randomBytes(16).toString("hex"),
      local: true,
    });
    console.log(`[hub] created default local connection: ${id}`);
    created = true;
  }
  if (created) store.setMeta("default-connections-seeded", "1");
}

function cleanupLocalAgent(connectionId: string): void {
  agents.delete(connectionId);
  for (const [sid, cid] of [...owners.entries()]) {
    if (cid === connectionId) owners.delete(sid);
  }
}

function spawnAgent(def: AgentDef): ChildProcess {
  return spawn(def.bin, def.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: def.cwd,
    env: { ...process.env, ...def.env },
    windowsHide: true,
  });
}

async function startLocalAgent(connection: Connection): Promise<void> {
  const def = AGENT_DEFS[connection.agent];
  if (!def) throw new Error(`unknown agent type: ${connection.agent}`);
  localAgentErrors.delete(connection.id);

  const proc = spawnAgent(def);
  const stderrChunks: Buffer[] = [];
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    process.stderr.write(chunk);
  });

  const localStream = acp.ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  const a = new AcpAgent(
    connection.name,
    localStream,
    onAgentEvent,
    () => {
      console.log(`[hub] local agent ${connection.id} removed`);
      cleanupLocalAgent(connection.id);
    },
    proc,
    onTurnEnd,
    onFileWrite,
    onToolCall,
    runPermissionManager,
  );

  agents.set(connection.id, a);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const fail = (reason: string) => {
      settle(() => {
        try {
          proc.kill();
        } catch {}
        cleanupLocalAgent(connection.id);
        localAgentErrors.set(connection.id, reason);
        logWarn("local agent", `${connection.id} failed: ${reason}`);
        broadcast({ method: "agent.status", params: { status: "error", detail: reason } });
        reject(new Error(reason));
      });
    };

    proc.on("error", (err) =>
      fail(
        `无法启动本地 Agent 进程: ${err.message}。请检查 PATH 是否包含 Node/npm，或在环境变量中设置 CLAUDE_ACP_BIN/CODEX_ACP_BIN 为完整可执行文件路径。`,
      ),
    );

    proc.on("close", (code, signal) => {
      if (!settled) {
        const lastErr = Buffer.concat(stderrChunks)
          .toString("utf-8")
          .trim()
          .split(/\r?\n/)
          .pop();
        let detail = `本地 Agent 进程意外退出 (code=${code ?? "?"}, signal=${signal ?? "?"})`;
        if (lastErr) detail += `；${lastErr}`;
        if (process.platform === "win32") {
          detail +=
            "。Windows 下请确认 PATH 中包含 node/npm，若使用 pm2 启动 Hub 请设置完整路径的 CLAUDE_ACP_BIN。";
        }
        fail(detail);
      }
    });

    a.ensureStarted()
      .then(() => {
        settle(() => {
          localAgentErrors.delete(connection.id);
          console.log(`[hub] local agent ${connection.id} started`);
          roomModeManager.resumeFlows();
          resolve();
        });
      })
      .catch((err) => fail(`本地 Agent 初始化失败: ${String(err)}`));
  });
}

async function ensureLocalAgent(connection: Connection): Promise<void> {
  if (agents.has(connection.id)) return;
  const existing = localStarts.get(connection.id);
  if (existing) {
    await existing;
    return;
  }
  const startPromise = startLocalAgent(connection);
  localStarts.set(connection.id, startPromise);
  try {
    await startPromise;
  } finally {
    localStarts.delete(connection.id);
  }
}

const agentOps: AgentOps = {
  prompt: (sessionId, content) => {
    const agent = ownerOf(sessionId);
    if (typeof content === "string") return agent.prompt(sessionId, content);
    return agent.promptContent(sessionId, content);
  },
  isBusy: (sessionId) => ownerOf(sessionId).isBusy(sessionId),
  cancel: (sessionId) => ownerOf(sessionId).cancel(sessionId),
};
const roomModeManager = new RoomModeManager(
  agentOps,
  rooms,
  (method, params) => broadcast({ method, params } as HubEvent),
  qualityIntegration,
);

// 恢复运行时编排状态（必须在 roomModeManager 创建后，但 agents 可能尚未连接）
if (savedRuntime) {
  roomModeManager
    .importRuntime(savedRuntime)
    .then(() => persistState())
    .catch((err) => logError("import runtime", err));
}

const scheduler = new Scheduler(
  store,
  () => scheduler.persistTo(store),
  (tasks) => broadcast({ method: "task.update", params: { tasks } } as HubEvent),
  async (task) => {
    if (task.targetType === "room") {
      const room = rooms.get(task.targetId);
      if (!room) throw new Error(`unknown room: ${task.targetId}`);
      store.append("room", room.roomId, {
        at: Date.now(),
        kind: "user",
        author: "定时任务",
        text: `[${task.name}] ${task.message}`,
      });
      await roomModeManager.handle(room, task.message, {});
      persistState();
    } else {
      store.append("session", task.targetId, {
        at: Date.now(),
        kind: "user",
        author: "定时任务",
        text: task.message,
      });
      await agentOps.prompt(task.targetId, [{ type: "text", text: task.message }]);
    }
  },
);
scheduler.start();

function ownerOf(sessionId: string): AcpAgent {
  const connectionId = owners.get(sessionId);
  if (!connectionId) throw new Error(`unknown session: ${sessionId}`);
  const a = agents.get(connectionId);
  if (!a) throw new Error("agent 未连接");
  return a;
}

function getConnectionById(id?: string): Connection | undefined {
  if (!id) return undefined;
  return store.listConnections().find((c) => c.id === id);
}

function originFor(meta: SessionMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const c = getConnectionById(meta.connectionId);
  if (c) return c.name;
  return meta.address;
}

function listAllSessions(): {
  sessionId: string;
  cwd: string;
  name: string;
  busy: boolean;
  stoppable: boolean;
  agent: string;
  address?: string | undefined;
  connectionId?: string | undefined;
  roleId?: string | undefined;
  origin?: string | undefined;
  offline: boolean;
  archived: boolean;
}[] {
  const connectionsById = new Map<string, Connection>(
    store.listConnections().map((c) => [c.id, c]),
  );
  const online = [...agents.entries()].flatMap(([connectionId, a]) => {
    const c = connectionsById.get(connectionId);
    return a.listSessions().map((s) => {
      const meta = sessionMetas.get(s.sessionId);
      return {
        ...s,
        agent: c?.agent ?? meta?.agent ?? "devin",
        connectionId,
        roleId: meta?.roleId,
        origin: originFor(meta) ?? c?.name,
        offline: false,
        archived: meta?.archived ?? false,
      };
    });
  });
  const onlineIds = new Set(online.map((s) => s.sessionId));
  const offline = [...sessionMetas.values()]
    .filter((m) => !onlineIds.has(m.sessionId))
    .map((m) => ({
      ...m,
      busy: false,
      stoppable: false,
      offline: true,
      archived: m.archived ?? false,
      origin: originFor(m),
    }));
  return [...online, ...offline];
}

function onTurnEnd(sessionId: string, text: string): void {
  const meta = sessionMetas.get(sessionId);
  const baseName = meta?.name ?? sessionId;
  const origin = originFor(meta);
  const displayName = origin ? `${baseName} (${origin})` : baseName;
  if (text.trim()) {
    store.append("session", sessionId, {
      at: Date.now(),
      kind: "assistant",
      author: displayName,
      text,
    });
    // 只有群聊回合才写入 room 历史，单聊回复不泄漏到群聊
    if (roomModeManager.isRoomTurn(sessionId)) {
      for (const room of rooms.roomsFor(sessionId)) {
        if (roomModeManager.isHiddenTurn(sessionId, room.roomId)) continue;
        store.append("room", room.roomId, {
          at: Date.now(),
          kind: "assistant",
          author: displayName,
          text,
        });
      }
    }
  }
}

const sessionsWithFileChanges = new Set<string>();

function onFileWrite(sessionId: string, relPath: string, existed: boolean, content?: string): void {
  const meta = sessionMetas.get(sessionId);
  if (!meta) return;
  const author = meta.name;
  const summary = existed ? "修改" : "新增";
  sessionsWithFileChanges.add(sessionId);

  sessionLedger.addFile(sessionId, { author, summary, path: relPath });
  // fs 通道掌握准确的 existed 信息，由它修正/产生 add/modify 事件（与 tool_call edit 去重）
  sessionLedger.addFileEvent(sessionId, { author, action: existed ? "modify" : "add", summary, path: relPath });

  // 只有群聊回合才同步产物/事件到 room，单聊操作不泄漏到群聊
  if (roomModeManager.isRoomTurn(sessionId)) {
    for (const room of rooms.roomsFor(sessionId)) {
      rooms.addFile?.(room.roomId, { author, summary, path: relPath, content });
      rooms.addFileEvent?.(room.roomId, { author, action: existed ? "modify" : "add", summary, path: relPath });
    }
  }

  persistState();
  broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
  if (roomModeManager.isRoomTurn(sessionId)) {
    for (const room of rooms.roomsFor(sessionId)) {
      broadcast({ method: "room.artifact", params: { roomId: room.roomId } } as HubEvent);
    }
  }
}

function onToolCall(sessionId: string, kind: string, title: string, paths: string[]): void {
  const meta = sessionMetas.get(sessionId);
  if (!meta) return;

  // 读文件、搜索、获取网页、思考等工具调用不产生有价值的事件
  const ignored = new Set(["read", "search", "fetch", "think", "switch_mode", "other"]);
  if (ignored.has(kind)) return;

  const actionMap: Record<string, EventAction> = {
    edit: "modify",
    delete: "delete",
    move: "rename",
    execute: "command",
  };
  const action = actionMap[kind] ?? "command";
  if (kind === "edit" || kind === "delete" || kind === "move") {
    sessionsWithFileChanges.add(sessionId);
  }

  for (const relPath of paths) {
    const summary = title;
    sessionLedger.addEvent(sessionId, { author: meta.name, action, summary, path: relPath });

    // 只有群聊回合才同步事件到 room，单聊操作不泄漏到群聊
    if (roomModeManager.isRoomTurn(sessionId)) {
      for (const room of rooms.roomsFor(sessionId)) {
        rooms.addEvent?.(room.roomId, { author: meta.name, action, summary, path: relPath });
      }
    }
  }

  persistState();
  broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
  if (roomModeManager.isRoomTurn(sessionId)) {
    for (const room of rooms.roomsFor(sessionId)) {
      broadcast({ method: "room.artifact", params: { roomId: room.roomId } } as HubEvent);
    }
  }
}

function onAgentEvent(event: HubEvent): void {
  const sessionId = (event.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
  let skipBroadcast =
    sessionId != null &&
    roomModeManager.isHiddenSession(sessionId) &&
    event.method !== "permission.request";
  if (event.method === "prompt.done") {
    const { output } = event.params;
    const internalOutput = promptDoneInternalOutput(event.params);
    const meta = sessionMetas.get(sessionId!);
    const baseName = meta?.name ?? sessionId!;
    const origin = originFor(meta);
    const displayName = origin ? `${baseName} (${origin})` : baseName;
    if (!roomModeManager.isHiddenSession(sessionId!) && roomModeManager.isRoomTurn(sessionId!)) {
      const touched = rooms.recordOutput(sessionId!, displayName, output);
      for (const roomId of touched) {
        broadcast({
          method: "room.blackboardUpdate",
          params: { roomId, blackboard: rooms.getBlackboard(roomId) },
        } as HubEvent);
      }
    }
    if (!roomModeManager.isRoomTurn(sessionId!)) {
      sessionLedger.captureOutput(sessionId!, extractTaskResult(internalOutput).artifacts);
      broadcast({ method: "session.artifact", params: { sessionId: sessionId! } });
    }
    void roomModeManager
      .onPromptDone(sessionId!, internalOutput)
      .then((handled) => {
        persistState();
        if (!handled && sessionsWithFileChanges.has(sessionId!)) {
          triggerGateForSession(sessionId!, internalOutput);
        }
        sessionsWithFileChanges.delete(sessionId!);
      })
      .catch((err) => {
        logError("room-modes", err);
        sessionsWithFileChanges.delete(sessionId!);
      });
  } else if (event.method === "prompt.error") {
    if (sessionId) {
      roomModeManager.onPromptError(sessionId);
      persistState();
    }
  } else if (event.method === "room.notice") {
    store.append("room", event.params.roomId, {
      at: Date.now(),
      kind: "system",
      author: "",
      text: event.params.message,
    });
  }
  if (!skipBroadcast) broadcast(toPublicHubEvent(event));
}

function triggerGateForSession(sessionId: string, output: string): void {
  const projects = qualityService.listProjects();
  if (projects.length === 0) return;
  const artifacts = extractTaskResult(output).artifacts;
  const filePaths = artifacts
    .filter((a) => a.type === "file" && a.path)
    .map((a) => a.path!);
  const ledgerFiles = sessionLedger.getArtifacts(sessionId)
    .filter((a) => a.path)
    .map((a) => a.path!);
  const allPaths = [...new Set([...filePaths, ...ledgerFiles])];
  const project = findProjectForPaths(projects, allPaths);
  if (!project) return;
  const { policy } = qualityService.getPolicy(project.id);
  const reviewerSessionId = policy.review.reviewerSessionId;
  const run = qualityService.startRun({
    projectId: project.id,
    trigger: "interactive",
    implementerSessionId: sessionId,
    ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
    risk: "medium",
    policyVersion: String(policy.version),
    budget: { maxFixRounds: policy.review.maxFixRounds ?? 2, timeoutMs: 60000 },
  });
  runPermissionManager.bindSession(sessionId, run.id, "implementer");
  if (reviewerSessionId) {
    runPermissionManager.bindSession(reviewerSessionId, run.id, "reviewer");
  }
}

function broadcast(event: HubEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

type SlashCmd = { command: string; mentions: string[] };

function parseSlash(text: string): SlashCmd | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  if (!head) return null;
  const mentions = rest
    .filter((p) => p.startsWith("@"))
    .map((p) => p.slice(1));
  return { command: head.toLowerCase(), mentions };
}

function agentForSession(sessionId: string): AcpAgent | undefined {
  const key = owners.get(sessionId);
  return key ? agents.get(key) : undefined;
}

async function handleSessionSlash(sessionId: string, slash: SlashCmd): Promise<unknown> {
  if (slash.command !== "stop") {
    throw new Error(`unknown command: /${slash.command}`);
  }
  const agent = agentForSession(sessionId);
  if (!agent || !agent.isStoppable(sessionId)) {
    throw new Error("session not generating");
  }
  await agent.cancel(sessionId);
  return { stopped: [sessionId] };
}

async function handleRoomSlash(
  room: Room,
  slash: SlashCmd,
  rawText: string,
  quote?: { author: string; text: string },
): Promise<unknown> {
  if (slash.command !== "stop") {
    throw new Error(`unknown command: /${slash.command}`);
  }

  // 记录用户的 slash 指令本身
  store.append("room", room.roomId, {
    at: Date.now(),
    kind: "user",
    author: "我",
    text: quote
      ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${rawText}`
      : rawText,
  });

  const targetIds =
    slash.mentions.length > 0
      ? room.members
          .filter((m) => slash.mentions.includes(m.name))
          .map((m) => m.sessionId)
      : room.members.map((m) => m.sessionId);

  const stopped: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const sid of targetIds) {
    const agent = agentForSession(sid);
    if (!agent || !agent.isStoppable(sid)) {
      skipped.push(sid);
      continue;
    }
    try {
      await agent.cancel(sid);
      stopped.push(sid);
    } catch (err) {
      errors.push(String(err));
    }
  }

  // 中断当前房间所有编排流（含 auto、pipeline、debate 等）
  const hadFlow = roomModeManager.hasActiveFlow(room.roomId);
  if (hadFlow) {
    await roomModeManager.cancelActive(room.roomId, "用户停止");
  }
  persistState();

  const stoppedNames = stopped.map(
    (sid) => room.members.find((m) => m.sessionId === sid)?.name ?? sid,
  );

  let notice: string;
  if (stopped.length > 0) {
    notice = `已停止: ${stoppedNames.join(", ")}`;
    if (hadFlow) notice += "；编排已中断";
  } else if (errors.length > 0) {
    notice = `停止失败: ${errors.join("; ")}`;
  } else {
    notice = "没有可停止的会话";
  }

  broadcast({ method: "room.notice", params: { roomId: room.roomId, message: notice } });
  return { stopped, skipped, errors, notice };
}

type RequestMessage = {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

async function handleRequest(req: RequestMessage): Promise<unknown> {
  switch (req.method) {
    case "agent.info":
      return {
        agents: Object.keys(AGENT_DEFS),
        sessions: listAllSessions(),
      };
    case "session.list":
      return { sessions: listAllSessions() };
    case "session.create": {
      const roleId = req.params?.roleId ? String(req.params.roleId) : null;
      const role = roleId
        ? store.listRoles().find((r) => r.id === roleId)
        : undefined;
      const connectionId = req.params?.connectionId
        ? String(req.params.connectionId)
        : (role?.connectionId ?? undefined);
      if (!connectionId) throw new Error("connection required");
      const connection = getConnectionById(connectionId);
      if (!connection) throw new Error(`unknown connection: ${connectionId}`);
      if (connection.local) await ensureLocalAgent(connection);
      const agent = agents.get(connection.id);
      if (!agent) throw new Error("agent 未连接");
      const cwd = String(req.params?.cwd ?? connection.cwd ?? role?.cwd ?? "");
      const name = req.params?.name ? String(req.params.name) : role?.name;
      if (name && isSessionNameTaken(name)) throw new Error("session name already exists");
      const s = await agent.createSession(cwd, name);
      const finalRoleId = role?.id ?? roleId ?? undefined;
      sessionMetas.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd,
        name: s.name,
        agent: connection.agent,
        connectionId: connection.id,
        roleId: finalRoleId,
      });
      owners.set(s.sessionId, connection.id);
      persistState();

      // 新建 session 时同步对应后端的当前模型
      if (connection.agent) {
        const backend = connection.agent as ModelBackend;
        const configOptions = agent.getConfigOptions();
        if (configOptions) {
          modelManager.injectConfigOptions(backend, configOptions);
        }
        const current = modelManager.current(backend, s.sessionId);
        await agent
          .setConfigOption(s.sessionId, "model", current.uid)
          .catch((err) => logWarn("session.create", `sync model failed: ${String(err)}`));
      }

      if (role) {
        const personaPrompt =
          `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
        agentOps
          .prompt(s.sessionId, personaPrompt)
          .catch((err) => logWarn("persona", `inject failed: ${String(err)}`));
      }
      return { ...s, agent: connection.agent, connectionId: connection.id, roleId: finalRoleId };
    }
    case "session.clone": {
      const sourceSessionId = String(req.params?.sessionId ?? "");
      const source = sessionMetas.get(sourceSessionId);
      if (!source) throw new Error(`unknown session: ${sourceSessionId}`);
      const connectionId = source.connectionId;
      if (!connectionId) throw new Error("source session has no connection");
      const connection = getConnectionById(connectionId);
      if (!connection) throw new Error(`unknown connection: ${connectionId}`);
      if (connection.local) await ensureLocalAgent(connection);
      const agent = agents.get(connection.id);
      if (!agent) throw new Error("agent 未连接");

      const baseName = source.name;
      const existingNames = new Set(
        [...sessionMetas.values()].map((m) => m.name),
      );
      let newName = `${baseName} (2)`;
      let counter = 2;
      while (existingNames.has(newName)) {
        counter++;
        newName = `${baseName} (${counter})`;
      }

      const s = await agent.createSession(source.cwd, newName);
      sessionMetas.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd: source.cwd,
        name: s.name,
        agent: connection.agent,
        connectionId: connection.id,
        roleId: source.roleId,
      });
      owners.set(s.sessionId, connection.id);
      persistState();

      // 新建 session 时同步对应后端的当前模型
      if (connection.agent) {
        const current = modelManager.current(connection.agent as ModelBackend, s.sessionId);
        await agent
          .setConfigOption(s.sessionId, "model", current.uid)
          .catch((err) => logWarn("session.clone", `sync model failed: ${String(err)}`));
      }

      if (source.roleId) {
        const role = store.listRoles().find((r) => r.id === source.roleId);
        if (role) {
          const personaPrompt =
            `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
          agentOps
            .prompt(s.sessionId, personaPrompt)
            .catch((err) => logWarn("persona", `inject failed: ${String(err)}`));
        }
      }
      return {
        ...s,
        agent: connection.agent,
        connectionId: connection.id,
        roleId: source.roleId,
      };
    }
    case "role.list":
      return { roles: store.listRoles() };
    case "skill.list": {
      const sessionId = typeof req.params?.sessionId === "string" ? req.params.sessionId : undefined;
      const connectionId = typeof req.params?.connectionId === "string" ? req.params.connectionId : undefined;
      const meta = sessionId ? sessionMetas.get(sessionId) : undefined;
      const connId = connectionId ?? meta?.connectionId;
      const connection = connId ? getConnectionById(connId) : undefined;
      const cwd = meta?.cwd;
      const agentType = connection?.agent;
      return { skills: discoverSkills(cwd, agentType) };
    }
    case "role.create": {
      const name = String(req.params?.name ?? "").trim();
      const persona = String(req.params?.persona ?? "").trim();
      if (!name || !persona) throw new Error("name and persona required");
      const id = `custom-${Date.now().toString(36)}`;
      const connectionId = req.params?.connectionId
        ? String(req.params.connectionId)
        : undefined;
      if (connectionId && !getConnectionById(connectionId)) {
        throw new Error(`unknown connection: ${connectionId}`);
      }
      const connection = getConnectionById(connectionId);
      store.addRole({
        id,
        name,
        persona,
        agent: connection?.agent,
        address: connection?.address,
        connectionId,
        cwd: req.params?.cwd ? String(req.params.cwd) : connection?.cwd,
      });
      return { id };
    }
    case "role.delete": {
      const ok = store.deleteRole(String(req.params?.id ?? ""));
      if (!ok) throw new Error("role not found or builtin");
      return { deleted: true };
    }
    case "session.resume": {
      const sessionId = String(req.params?.sessionId ?? "");
      const meta = sessionMetas.get(sessionId);
      if (!meta) throw new Error(`unknown session: ${sessionId}`);
      if (owners.has(sessionId)) return { resumed: true, already: true };
      const connectionId = meta.connectionId;
      if (!connectionId) throw new Error("session has no connection");
      const connection = getConnectionById(connectionId);
      if (connection?.local) await ensureLocalAgent(connection);
      const agent = agents.get(connectionId);
      if (!agent) throw new Error("agent 未连接");
      let ok = await agent.resumeSession(meta.sessionId, meta.cwd, meta.name);

      if (!ok) {
        const hasHistory = store.read("session", sessionId).length > 0;
        // 无论是否有历史，agent 已无法恢复该 session，直接用同名/cwd 重建
        const s = await agent.createSession(meta.cwd, meta.name);

        // 重建 session 时同步对应后端的当前模型
        if (connection?.agent) {
          const current = modelManager.current(connection.agent as ModelBackend, s.sessionId);
          await agent
            .setConfigOption(s.sessionId, "model", current.uid)
            .catch((err) => logWarn("session.resume", `sync model failed: ${String(err)}`));
        }

        if (hasHistory) {
          store.renameHistory("session", sessionId, s.sessionId);
        }
        sessionMetas.delete(sessionId);
        owners.delete(sessionId);
        const newMeta = { ...meta, sessionId: s.sessionId, name: s.name };
        sessionMetas.set(s.sessionId, newMeta);
        owners.set(s.sessionId, connectionId);
        rooms.updateMemberSessionId(sessionId, s.sessionId);
        persistState();
        console.log(
          `[hub] recreated session ${sessionId} -> ${s.sessionId} (${s.name})${
            hasHistory ? " with history" : ""
          }`,
        );
        return { resumed: true, sessionId: s.sessionId };
      }
      owners.set(sessionId, connectionId);

      // 恢复 session 时同步对应后端的当前模型
      if (connection?.agent) {
        const current = modelManager.current(connection.agent as ModelBackend, sessionId);
        agent
          .setConfigOption(sessionId, "model", current.uid)
          .catch((err) => logWarn("session.resume", `sync model failed: ${String(err)}`));
      }

      return { resumed: true };
    }
    case "session.rename": {
      const sessionId = String(req.params?.sessionId ?? "");
      const name = String(req.params?.name ?? "").trim();
      const meta = sessionMetas.get(sessionId);
      if (!meta) throw new Error(`unknown session: ${sessionId}`);
      if (!name) throw new Error("name required");
      if (isSessionNameTaken(name, sessionId)) throw new Error("session name already exists");
      meta.name = name;
      agentForSession(sessionId)?.renameSession(sessionId, name);
      const roomIds = rooms.updateMemberName(sessionId, name);
      persistState();
      return { renamed: true, name, roomIds };
    }
    case "session.archive": {
      const sessionId = String(req.params?.sessionId ?? "");
      const meta = sessionMetas.get(sessionId);
      if (!meta) throw new Error(`unknown session: ${sessionId}`);
      meta.archived = req.params?.archived !== false;
      persistState();
      return { archived: meta.archived };
    }
    case "session.delete": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionMetas.has(sessionId) && !owners.has(sessionId)) {
        throw new Error(`unknown session: ${sessionId}`);
      }
      if (owners.has(sessionId) && agentOps.isBusy(sessionId)) {
        throw new Error("session busy, cancel first");
      }
      const ownerConnectionId = owners.get(sessionId);
      if (ownerConnectionId) agents.get(ownerConnectionId)?.dropSession(sessionId);
      owners.delete(sessionId);
      sessionMetas.delete(sessionId);
      sessionLedger.drop(sessionId);
      store.deleteHistory("session", sessionId);
      const dissolved = rooms.removeMember(sessionId);
      for (const roomId of dissolved) store.deleteHistory("room", roomId);
      persistState();
      return { deleted: true, dissolvedRooms: dissolved };
    }
    case "session.deleteBatch": {
      const sessionIds = Array.isArray(req.params?.sessionIds)
        ? (req.params?.sessionIds as string[])
        : [];
      const uniqueIds = [...new Set(sessionIds)];
      for (const sessionId of uniqueIds) {
        if (!sessionMetas.has(sessionId) && !owners.has(sessionId)) {
          throw new Error(`unknown session: ${sessionId}`);
        }
        if (owners.has(sessionId) && agentOps.isBusy(sessionId)) {
          throw new Error(`session busy, cancel first: ${sessionId}`);
        }
      }
      const dissolved: string[] = [];
      for (const sessionId of uniqueIds) {
        const ownerConnectionId = owners.get(sessionId);
        if (ownerConnectionId) agents.get(ownerConnectionId)?.dropSession(sessionId);
        owners.delete(sessionId);
        sessionMetas.delete(sessionId);
        sessionLedger.drop(sessionId);
        store.deleteHistory("session", sessionId);
        dissolved.push(...rooms.removeMember(sessionId));
      }
      for (const roomId of new Set(dissolved)) store.deleteHistory("room", roomId);
      persistState();
      return { deleted: true, count: uniqueIds.length, dissolvedRooms: [...new Set(dissolved)] };
    }
    case "room.delete": {
      const roomId = String(req.params?.roomId ?? "");
      if (!rooms.get(roomId)) throw new Error(`unknown room: ${roomId}`);
      rooms.delete(roomId);
      store.deleteHistory("room", roomId);
      persistState();
      return { deleted: true };
    }
    case "room.deleteBatch": {
      const roomIds = Array.isArray(req.params?.roomIds)
        ? (req.params?.roomIds as string[])
        : [];
      const uniqueIds = [...new Set(roomIds)];
      for (const roomId of uniqueIds) {
        if (!rooms.get(roomId)) throw new Error(`unknown room: ${roomId}`);
      }
      for (const roomId of uniqueIds) {
        rooms.delete(roomId);
        store.deleteHistory("room", roomId);
      }
      persistState();
      return { deleted: true, count: uniqueIds.length };
    }
    case "room.rename": {
      const roomId = String(req.params?.roomId ?? "");
      const name = String(req.params?.name ?? "").trim();
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      if (!name) throw new Error("name required");
      if (isRoomNameTaken(name, roomId)) throw new Error("room name already exists");
      rooms.rename(roomId, name);
      persistState();
      return { room };
    }
    case "room.archive": {
      const roomId = String(req.params?.roomId ?? "");
      const archived = req.params?.archived === true;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      rooms.archive(roomId, archived);
      persistState();
      return { room };
    }
    case "room.update": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const name = String(req.params?.name ?? "").trim() || room.name;
      const ids = (req.params?.sessionIds as string[]) ?? [];
      const mode = parseRoomMode(req.params?.mode);
      const all = listAllSessions();
      const members = ids.map((id) => {
        const s = all.find((x) => x.sessionId === id);
        if (!s) throw new Error(`unknown session: ${id}`);
        return { sessionId: s.sessionId, name: s.name };
      });
      const config = parseRoomModeConfig(req.params, members);
      rooms.update(roomId, name, members, mode, config);
      persistState();
      return { room: enrichRoom(rooms.get(roomId)!) };
    }
    case "room.clone": {
      const roomId = String(req.params?.roomId ?? "");
      const newName = String(req.params?.newName ?? "").trim();
      const source = rooms.get(roomId);
      if (!source) throw new Error(`unknown room: ${roomId}`);
      if (!newName) throw new Error("name required");
      if (isRoomNameTaken(newName)) throw new Error("room name already exists");

      const idMap = new Map<string, string>();
      const newMembers: { sessionId: string; name: string }[] = [];
      for (const m of source.members) {
        const meta = sessionMetas.get(m.sessionId);
        if (!meta) throw new Error(`unknown session: ${m.sessionId}`);
        const sessionName = `${newName}-${meta.name}`;
        const s = await cloneSessionWithName(meta, sessionName);
        idMap.set(m.sessionId, s.sessionId);
        newMembers.push({ sessionId: s.sessionId, name: m.name });
      }

      const remap = (sid?: string) => (sid ? idMap.get(sid) : undefined);
      const config: RoomModeConfig = {
        conductorId: remap(source.conductorId),
        parallelSummarizerId: remap(source.parallelSummarizerId),
        pipelineOrder: source.pipelineOrder
          ?.map(remap)
          .filter((sid): sid is string => !!sid),
        debateSides: source.debateSides
          ? (source.debateSides.map(remap).filter((sid): sid is string => !!sid) as [string, string])
          : undefined,
        debateJudge: remap(source.debateJudge),
        debateRounds: source.debateRounds,
        memberRoles: source.memberRoles
          ? Object.fromEntries(
              Object.entries(source.memberRoles)
                .map(([sid, persona]) => [idMap.get(sid), persona])
                .filter(([sid]) => !!sid),
            )
          : undefined,
      };
      const room = rooms.create(newName, newMembers, source.mode, config);
      persistState();
      return { room };
    }
    case "connection.list":
      return {
        connections: store.listConnections().map((c) => ({
          ...c,
          online: agents.has(c.id),
          local: c.local ?? false,
          error: localAgentErrors.get(c.id),
        })),
      };
    case "connection.create": {
      const name = String(req.params?.name ?? "").trim();
      const agent = String(req.params?.agent ?? "devin").trim();
      const address = String(req.params?.address ?? "").trim() || undefined;
      const cwd = String(req.params?.cwd ?? "").trim() || undefined;
      if (!name || !agent) throw new Error("connection name and agent required");
      if (!AGENT_DEFS[agent]) throw new Error(`unknown agent type: ${agent}`);
      const id = `conn-${Date.now().toString(36)}`;
      const providedToken = String(req.params?.token ?? "").trim();
      const token = providedToken || randomBytes(16).toString("hex");
      const rawLocal = req.params?.local;
      const local =
        rawLocal === true ||
        rawLocal === "true" ||
        rawLocal === "on" ||
        rawLocal === "1" ||
        rawLocal === 1;
      store.addConnection({ id, name, agent, token, address, cwd, local });
      return { id, token, name, agent, address, cwd, local };
    }
    case "connection.delete": {
      const id = String(req.params?.id ?? "");
      const existing = agents.get(id);
      if (existing) {
        existing.close();
        agents.delete(id);
      }
      localAgentErrors.delete(id);
      const ok = store.deleteConnection(id);
      if (!ok) throw new Error("connection not found");
      return { deleted: true };
    }
    case "history.search": {
      const query = String(req.params?.query ?? "").trim();
      if (!query) return { results: [] };
      const scope = req.params?.scope;
      const scopeId = req.params?.scopeId;
      const limit = Number(req.params?.limit ?? 50);
      if (typeof scope === "string" && typeof scopeId === "string" && (scope === "session" || scope === "room")) {
        return { results: store.searchByScope(query, scope, scopeId, limit) };
      }
      return { results: store.search(query, limit) };
    }
    case "history.searchGroups": {
      const query = String(req.params?.query ?? "").trim();
      if (!query) return { groups: [] };
      return {
        groups: store.searchGroups(
          query,
          Number(req.params?.limit ?? 20),
          Number(req.params?.previewLimit ?? 1),
        ),
      };
    }
    case "session.history": {
      const sessionId = String(req.params?.sessionId ?? "");
      const limit = Number(req.params?.limit ?? 200);
      const anchorAt = req.params?.anchorAt;
      const beforeAt = req.params?.before;
      let entries;
      if (typeof beforeAt === "number" && Number.isFinite(beforeAt)) {
        entries = store.readBefore("session", sessionId, beforeAt, limit);
      } else if (typeof anchorAt === "number" && Number.isFinite(anchorAt)) {
        entries = store.readAround("session", sessionId, anchorAt, limit);
      } else {
        entries = store.read("session", sessionId, limit);
      }
      const hasMore = entries.length > 0 ? store.hasMoreBefore("session", sessionId, entries[0]!.at) : false;
      return { entries, hasMore };
    }
    case "room.history": {
      const roomId = String(req.params?.roomId ?? "");
      const limit = Number(req.params?.limit ?? 200);
      const anchorAt = req.params?.anchorAt;
      const beforeAt = req.params?.before;
      let entries;
      if (typeof beforeAt === "number" && Number.isFinite(beforeAt)) {
        entries = store.readBefore("room", roomId, beforeAt, limit);
      } else if (typeof anchorAt === "number" && Number.isFinite(anchorAt)) {
        entries = store.readAround("room", roomId, anchorAt, limit);
      } else {
        entries = store.read("room", roomId, limit);
      }
      const hasMore = entries.length > 0 ? store.hasMoreBefore("room", roomId, entries[0]!.at) : false;
      return { entries, hasMore };
    }
    case "room.create": {
      const name = String(req.params?.name ?? "群聊").trim() || "群聊";
      if (isRoomNameTaken(name)) throw new Error("room name already exists");
      const ids = (req.params?.sessionIds as string[]) ?? [];
      const mode = parseRoomMode(req.params?.mode);
      const all = listAllSessions();
      const members = ids.map((id) => {
        const s = all.find((x) => x.sessionId === id);
        if (!s) throw new Error(`unknown session: ${id}`);
        return { sessionId: s.sessionId, name: s.name };
      });
      const config = parseRoomModeConfig(req.params, members);
      const room = rooms.create(name, members, mode, config);
      persistState();
      return { room: enrichRoom(room) };
    }
    case "room.list":
      return { rooms: rooms.list().map(enrichRoom) };
    case "room.memberModels": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const members = room.members.map((m) => {
        const meta = sessionMetas.get(m.sessionId);
        const backend = (meta?.agent ?? "devin") as ModelBackend;
        const current = modelManager.current(backend, m.sessionId);
        return {
          sessionId: m.sessionId,
          name: m.name,
          backend,
          model: current.uid,
        };
      });
      return { members };
    }
    case "room.blackboard": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      return { blackboard: rooms.getBlackboard(roomId) };
    }
    case "room.blackboard.remove": {
      const roomId = String(req.params?.roomId ?? "");
      const id = String(req.params?.id ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const removed = rooms.removeBlackboard(roomId, id);
      broadcast({
        method: "room.blackboardUpdate",
        params: { roomId, blackboard: rooms.getBlackboard(roomId) },
      } as HubEvent);
      return { removed };
    }
    case "room.blackboard.clear": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const cleared = rooms.clearBlackboard(roomId);
      broadcast({
        method: "room.blackboardUpdate",
        params: { roomId, blackboard: rooms.getBlackboard(roomId) },
      } as HubEvent);
      return { cleared };
    }
    case "room.flow": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      return { flow: roomModeManager.getFlow(roomId) };
    }
    case "session.artifacts": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!sessionMetas.has(sessionId) && !owners.has(sessionId)) {
        throw new Error(`unknown session: ${sessionId}`);
      }
      return {
        artifacts: sessionLedger.getArtifacts(sessionId, 100),
        events: sessionLedger.getEvents(sessionId, 100),
      };
    }
    case "session.events": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!sessionMetas.has(sessionId) && !owners.has(sessionId)) {
        throw new Error(`unknown session: ${sessionId}`);
      }
      return { events: sessionLedger.getEvents(sessionId, 100) };
    }
    case "session.removeArtifact": {
      const sessionId = String(req.params?.sessionId ?? "");
      const artifactId = String(req.params?.artifactId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      const removed = sessionLedger.removeArtifact(sessionId, artifactId);
      if (removed) {
        persistState();
        broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      }
      return { removed };
    }
    case "session.clearArtifacts": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      const count = sessionLedger.clearArtifacts(sessionId);
      if (count > 0) {
        persistState();
        broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      }
      return { count };
    }
    case "session.removeEvent": {
      const sessionId = String(req.params?.sessionId ?? "");
      const eventId = String(req.params?.eventId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!eventId) throw new Error("eventId required");
      const removed = sessionLedger.removeEvent(sessionId, eventId);
      if (removed) {
        persistState();
        broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      }
      return { removed };
    }
    case "session.clearEvents": {
      const sessionId = String(req.params?.sessionId ?? "");
      const action = String(req.params?.action ?? "");
      if (!sessionId) throw new Error("sessionId required");
      const count = sessionLedger.clearEvents(sessionId, action || undefined);
      if (count > 0) {
        persistState();
        broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      }
      return { count };
    }
    case "room.artifacts": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      return {
        artifacts: rooms.getArtifacts(roomId, 100),
        events: rooms.getEvents(roomId, 100),
        blackboard: rooms.getBlackboard(roomId),
      };
    }
    case "room.events": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      return { events: rooms.getEvents(roomId, 100) };
    }
    case "room.appendArtifact": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const kind = String(req.params?.kind ?? "file").toLowerCase();
      const author = String(req.params?.author ?? "");
      const summary = String(req.params?.summary ?? "");
      const path = typeof req.params?.path === "string" ? req.params.path : undefined;
      const taskId = typeof req.params?.taskId === "string" ? req.params.taskId : undefined;
      const artifact =
        kind === "file"
          ? rooms.addFile(roomId, { author, summary, path, taskId })
          : rooms.addEvent(roomId, {
              author,
              action: parseEventAction(req.params?.action),
              summary,
              path,
              taskId,
            });
      if (!artifact) throw new Error("add artifact failed");
      persistState();
      return { artifact };
    }
    case "room.removeArtifact": {
      const roomId = String(req.params?.roomId ?? "");
      const artifactId = String(req.params?.artifactId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const removed = rooms.removeArtifact(roomId, artifactId);
      if (removed) {
        persistState();
        broadcast({ method: "room.artifact", params: { roomId } } as HubEvent);
      }
      return { removed };
    }
    case "room.clearArtifacts": {
      const roomId = String(req.params?.roomId ?? "");
      const kind = String(req.params?.kind ?? "").toLowerCase();
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const count = kind === "event" ? rooms.clearEvents(roomId) : rooms.clearArtifacts(roomId);
      if (count > 0) {
        persistState();
        broadcast({ method: "room.artifact", params: { roomId } } as HubEvent);
      }
      return { count };
    }
    case "room.removeEvent": {
      const roomId = String(req.params?.roomId ?? "");
      const eventId = String(req.params?.eventId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      if (!eventId) throw new Error("eventId required");
      const removed = rooms.removeEvent(roomId, eventId);
      if (removed) {
        persistState();
        broadcast({ method: "room.artifact", params: { roomId } } as HubEvent);
      }
      return { removed };
    }
    case "room.clearEvents": {
      const roomId = String(req.params?.roomId ?? "");
      const action = String(req.params?.action ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const count = rooms.clearEvents(roomId, action || undefined);
      if (count > 0) {
        persistState();
        broadcast({ method: "room.artifact", params: { roomId } } as HubEvent);
      }
      return { count };
    }
    case "room.file.send": {
      const roomId = String(req.params?.roomId ?? "");
      const filePath = String(req.params?.path ?? "");
      const author = typeof req.params?.author === "string" ? req.params.author : undefined;
      const summary = typeof req.params?.summary === "string" ? req.params.summary : undefined;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      if (!filePath) throw new Error("file path required");
      const artifact = rooms.sendFile(roomId, filePath, author, summary);
      if (!artifact) throw new Error("send file failed");
      persistState();
      broadcast({ method: "room.artifact", params: { roomId, artifact } } as HubEvent);
      return { artifact };
    }
    case "room.file.roots": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      return { roots: rooms.fileRoots(roomId) };
    }
    case "room.file.list": {
      const roomId = String(req.params?.roomId ?? "");
      const dirPath = String(req.params?.path ?? "");
      const author = typeof req.params?.author === "string" ? req.params.author : undefined;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      if (!dirPath) throw new Error("dir path required");
      return { nodes: rooms.listFiles(roomId, dirPath, author) };
    }
    case "session.file.roots": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      return { roots: rooms.sessionFileRoots(sessionId) };
    }
    case "session.file.list": {
      const sessionId = String(req.params?.sessionId ?? "");
      const dirPath = String(req.params?.path ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!dirPath) throw new Error("dir path required");
      return { nodes: rooms.sessionListFiles(sessionId, dirPath) };
    }
    case "file.get": {
      const roomId = String(req.params?.roomId ?? "");
      const sessionId = String(req.params?.sessionId ?? "");
      const ref = String(req.params?.path ?? req.params?.artifactId ?? "");
      if (!roomId && !sessionId) throw new Error("roomId or sessionId required");
      if (!ref) throw new Error("file path or artifactId required");
      if (roomId) {
        const room = rooms.get(roomId);
        if (!room) throw new Error(`unknown room: ${roomId}`);
        return rooms.getFile(roomId, ref);
      }
      return rooms.sessionGetFile(sessionId, ref);
    }
    case "file.delete": {
      const roomId = String(req.params?.roomId ?? "");
      const sessionId = String(req.params?.sessionId ?? "");
      const filePath = String(req.params?.path ?? "");
      if (!roomId && !sessionId) throw new Error("roomId or sessionId required");
      if (!filePath) throw new Error("file path required");
      if (roomId) {
        const room = rooms.get(roomId);
        if (!room) throw new Error(`unknown room: ${roomId}`);
        const ok = rooms.deleteFile(roomId, filePath, String(req.params?.author ?? ""));
        broadcast({ method: "file.update", params: { roomId, path: filePath, op: "delete" } } as HubEvent);
        return { deleted: ok };
      }
      const result = rooms.sessionDeleteFile(sessionId, filePath);
      sessionLedger.recordDelete(sessionId, result.rel);
      persistState();
      broadcast({ method: "file.update", params: { sessionId, path: filePath, op: "delete" } } as HubEvent);
      broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      return { deleted: result.deleted };
    }
    case "file.rename": {
      const roomId = String(req.params?.roomId ?? "");
      const sessionId = String(req.params?.sessionId ?? "");
      const from = String(req.params?.from ?? "");
      const to = String(req.params?.to ?? "");
      if (!roomId && !sessionId) throw new Error("roomId or sessionId required");
      if (!from || !to) throw new Error("from and to paths required");
      if (roomId) {
        const room = rooms.get(roomId);
        if (!room) throw new Error(`unknown room: ${roomId}`);
        const ok = rooms.renameFile(roomId, from, to, String(req.params?.author ?? ""));
        broadcast({ method: "file.update", params: { roomId, path: from, op: "rename", from, to } } as HubEvent);
        return { renamed: ok };
      }
      const result = rooms.sessionRenameFile(sessionId, from, to);
      sessionLedger.recordRename(sessionId, result.fromRel, result.toRel);
      persistState();
      broadcast({ method: "file.update", params: { sessionId, path: from, op: "rename", from, to } } as HubEvent);
      broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      return { renamed: result.renamed };
    }
    case "session.file.delete": {
      const sessionId = String(req.params?.sessionId ?? "");
      const filePath = String(req.params?.path ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!filePath) throw new Error("file path required");
      const result = rooms.sessionDeleteFile(sessionId, filePath);
      sessionLedger.recordDelete(sessionId, result.rel);
      persistState();
      broadcast({ method: "file.update", params: { sessionId, path: filePath, op: "delete" } } as HubEvent);
      broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      return { deleted: result.deleted };
    }
    case "session.file.rename": {
      const sessionId = String(req.params?.sessionId ?? "");
      const from = String(req.params?.from ?? "");
      const to = String(req.params?.to ?? "");
      if (!sessionId) throw new Error("sessionId required");
      if (!from || !to) throw new Error("from and to paths required");
      const result = rooms.sessionRenameFile(sessionId, from, to);
      sessionLedger.recordRename(sessionId, result.fromRel, result.toRel);
      persistState();
      broadcast({ method: "file.update", params: { sessionId, path: from, op: "rename", from, to } } as HubEvent);
      broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
      return { renamed: result.renamed };
    }
    case "room.message": {
      const roomId = String(req.params?.roomId ?? "");
      const text = String(req.params?.text ?? "");
      const quote = req.params?.quote as
        | { author: string; text: string }
        | undefined;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);

      const rawContent = req.params?.content;
      const content: Array<Record<string, unknown>> = Array.isArray(rawContent)
        ? (rawContent as Array<Record<string, unknown>>)
        : text
        ? [{ type: "text", text }]
        : [];
      const imageBlocks = content.filter((b) => b.type !== "text");
      const historyText = content
        .map((b) => (b.type === "text" ? String(b.text ?? "") : "[图片]"))
        .join("") || "（图片）";

      const slash = parseSlash(text);
      if (slash?.command === "stop") {
        return handleRoomSlash(room, slash, text, quote);
      }

      const roomNote = roomLostReplyNote(roomId);

      store.append("room", roomId, {
        at: Date.now(),
        kind: "user",
        author: "我",
        text: quote
          ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${historyText}`
          : historyText,
      });
      const result = await roomModeManager.handle(room, historyText, {
        note: roomNote,
        quote,
        content,
        params: req.params as Record<string, unknown>,
        sessionNote: (sid) => sessionLostReplyNote(sid),
      });
      persistState();
      if (result.skipped.length > 0) {
        broadcast({
          method: "prompt.error",
          params: {
            sessionId: result.skipped[0] ?? "",
            message: `跳过忙碌会话: ${result.skipped.join(", ")}`,
          },
        });
      }
      return result;
    }
    case "prompt.send": {
      const sessionId = String(req.params?.sessionId ?? "");
      const text = String(req.params?.text ?? "");
      const rawContent = req.params?.content;
      let promptContent: Array<Record<string, unknown>>;
      if (Array.isArray(rawContent)) {
        promptContent = rawContent as Array<Record<string, unknown>>;
      } else if (text) {
        promptContent = [{ type: "text", text }];
      } else {
        throw new Error("prompt content or text required");
      }
      const slashText = text || promptContent
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const slash = parseSlash(slashText);
      if (slash?.command === "stop") {
        return handleSessionSlash(sessionId, slash);
      }
      const historyText = promptContent
        .map((b) => (b.type === "text" ? String(b.text ?? "") : "[图片]"))
        .join("") || "（图片）";

      const note = sessionLostReplyNote(sessionId);

      store.append("session", sessionId, {
        at: Date.now(),
        kind: "user",
        author: "我",
        text: historyText,
      });

      if (note) {
        const first = promptContent[0];
        if (first?.type === "text") {
          (first as Record<string, unknown>).text = `${note}\n\n${String(first.text ?? "")}`;
        } else {
          promptContent.unshift({ type: "text", text: note });
        }
      }

      await agentOps.prompt(sessionId, promptContent);
      return { accepted: true };
    }
    case "session.cancel":
      await ownerOf(String(req.params?.sessionId ?? "")).cancel(
        String(req.params?.sessionId ?? ""),
      );
      return { cancelled: true };
    case "permission.respond": {
      const requestId = String(req.params?.requestId ?? "");
      const optionId = String(req.params?.optionId ?? "");
      const ok = [...agents.values()].some((a) =>
        a.respondPermission(requestId, optionId),
      );
      if (!ok) throw new Error("unknown or expired permission request");
      return { responded: true };
    }
    case "permission.bypass": {
      const raw = req.params?.enabled;
      let enabled: boolean;
      if (raw == null) {
        enabled = !getPermissionBypass();
      } else {
        enabled =
          raw === true ||
          raw === "true" ||
          raw === "on" ||
          raw === "1" ||
          raw === 1;
      }
      setPermissionBypass(enabled);
      logWarn("config", `permission bypass set to ${enabled}`);
      return { bypass: enabled };
    }
    case "model.list": {
      const backend = String(req.params?.backend ?? "") as ModelBackend;
      const sessionId = String(req.params?.sessionId ?? "").trim() || undefined;
      const models = await modelManager.list();
      const filtered = backend ? models.filter(m => m.backend === backend) : models;
      const current = modelManager.current(backend || "devin", sessionId);
      return { current: current.uid, models: filtered };
    }
    case "model.current": {
      const backend = String(req.params?.backend ?? "devin") as ModelBackend;
      const sessionId = String(req.params?.sessionId ?? "").trim() || undefined;
      return modelManager.current(backend, sessionId);
    }
    case "model.refresh": {
      const backend = String(req.params?.backend ?? "") as ModelBackend;
      const sessionId = String(req.params?.sessionId ?? "").trim() || undefined;
      const models = await modelManager.refresh();
      const filtered = backend ? models.filter(m => m.backend === backend) : models;
      const current = modelManager.current(backend || "devin", sessionId);
      return { current: current.uid, models: filtered };
    }
    case "model.set": {
      const name = String(req.params?.model ?? "").trim();
      if (!name) throw new Error("model name required");
      const targetSessionId = String(req.params?.sessionId ?? "").trim() || undefined;

      // 指定 sessionId：只切该 session（per-session 模型）
      if (targetSessionId) {
        const model = await modelManager.setForSession(name, targetSessionId);
        const connectionId = owners.get(targetSessionId);
        const agent = connectionId ? agents.get(connectionId) : undefined;
        if (!agent) {
          return { set: true, model, syncErrors: [], sessionScoped: true };
        }
        const syncErrors: { sessionId: string; error: string }[] = [];
        try {
          await agent.setConfigOption(targetSessionId, "model", model.uid);
          console.log(`[model] session ${targetSessionId} switched to ${model.uid}`);
        } catch (err) {
          const msg = String(err);
          logWarn("model.set", `sync to ${targetSessionId} failed: ${msg}`);
          syncErrors.push({ sessionId: targetSessionId, error: msg });
        }
        return { set: true, model, syncErrors, sessionScoped: true };
      }

      // 未指定 sessionId：保持原有批量行为（后端级全局切换）
      const model = await modelManager.set(name);
      const syncErrors: { sessionId: string; error: string }[] = [];
      const syncTasks: Promise<void>[] = [];
      for (const [sessionId, connectionId] of owners.entries()) {
        const meta = sessionMetas.get(sessionId);
        if (meta?.agent !== model.backend) continue;
        const agent = agents.get(connectionId);
        if (!agent) continue;
        syncTasks.push(
          agent.setConfigOption(sessionId, "model", model.uid).catch((err) => {
            const msg = String(err);
            logWarn("model.set", `sync to ${sessionId} failed: ${msg}`);
            syncErrors.push({ sessionId, error: msg });
          }),
        );
      }
      await Promise.all(syncTasks);

      return { set: true, model, syncErrors };
    }
    case "model.backends.list": {
      const backends = await modelManager.listBackends();
      return { backends };
    }
    case "model.backends.add": {
      const backend = req.params?.backend as Record<string, unknown>;
      if (!backend || !backend.id || !backend.name || !backend.type) {
        throw new Error("backend config missing required fields (id, name, type)");
      }
      modelManager.addBackend(backend as BackendConfig);
      return { added: true };
    }
    case "model.backends.remove": {
      const id = String(req.params?.id ?? "");
      if (!id) throw new Error("backend id required");
      modelManager.removeBackend(id);
      return { removed: true };
    }
    case "model.backends.toggle": {
      const id = String(req.params?.id ?? "");
      if (!id) throw new Error("backend id required");
      modelManager.toggleBackend(id);
      return { toggled: true };
    }
    case "task.list":
      return { tasks: scheduler.list() };
    case "task.create": {
      const name = String(req.params?.name ?? "");
      const targetType = req.params?.targetType === "room" ? "room" : "session";
      const targetId = String(req.params?.targetId ?? "");
      const targetName = String(req.params?.targetName ?? "");
      const message = String(req.params?.message ?? "");
      const schedule = req.params?.schedule as ScheduledTask["schedule"];
      const enabled = req.params?.enabled !== false;
      if (!name || !targetId || !message || !schedule)
        throw new Error("name, targetId, message, schedule required");
      const task = scheduler.create({ name, targetType, targetId, targetName, message, schedule, enabled });
      return { task };
    }
    case "task.update": {
      const id = String(req.params?.id ?? "");
      const patch: Partial<Omit<ScheduledTask, "id" | "createdAt">> = {};
      if (typeof req.params?.name === "string") patch.name = req.params.name;
      if (req.params?.targetType === "room" || req.params?.targetType === "session")
        patch.targetType = req.params.targetType;
      if (typeof req.params?.targetId === "string") patch.targetId = req.params.targetId;
      if (typeof req.params?.targetName === "string") patch.targetName = req.params.targetName;
      if (typeof req.params?.message === "string") patch.message = req.params.message;
      if (req.params?.schedule) patch.schedule = req.params.schedule as ScheduledTask["schedule"];
      if (typeof req.params?.enabled === "boolean") patch.enabled = req.params.enabled;
      const task = scheduler.update(id, patch);
      if (!task) throw new Error(`unknown task: ${id}`);
      return { task };
    }
    case "task.delete": {
      const id = String(req.params?.id ?? "");
      if (!scheduler.delete(id)) throw new Error(`unknown task: ${id}`);
      return { deleted: true };
    }
    case "task.toggle": {
      const id = String(req.params?.id ?? "");
      const task = scheduler.toggle(id);
      if (!task) throw new Error(`unknown task: ${id}`);
      return { task };
    }
    case "task.logs": {
      const limit = Number(req.params?.limit ?? 100);
      return { logs: scheduler.listLogs(limit) };
    }
    case "task.clearLogs": {
      scheduler.clearLogs();
      return { cleared: true };
    }
    // ── quality: projects ──────────────────────────────────────────────
    case "quality.project.list":
      return { projects: qualityService.listProjects() };
    case "quality.project.get": {
      const id = String(req.params?.id ?? "");
      const project = qualityService.getProject(id);
      if (!project) throw new Error(`unknown project: ${id}`);
      return { project };
    }
    case "quality.project.register": {
      const p = req.params ?? {};
      const project = qualityService.registerProject({
        connectionId: String(p.connectionId ?? "manual"),
        root: String(p.root ?? ""),
        ...(p.displayName !== undefined ? { displayName: String(p.displayName) } : {}),
        ...(p.localExec !== undefined ? { localExec: Boolean(p.localExec) } : {}),
        ...(p.remoteExec !== undefined ? { remoteExec: Boolean(p.remoteExec) } : {}),
      });
      return { project };
    }
    case "quality.policy.detect": {
      const id = String(req.params?.projectId ?? "");
      return qualityService.detectPolicy(id);
    }
    case "quality.policy.validate": {
      const id = String(req.params?.projectId ?? "");
      const policy = req.params?.policy;
      return qualityService.validatePolicy(id, policy);
    }
    case "quality.policy.get": {
      const id = String(req.params?.projectId ?? "");
      return qualityService.getPolicy(id);
    }
    // ── quality: runs ──────────────────────────────────────────────────
    case "quality.run.start": {
      const p = req.params ?? {};
      const run = qualityService.startRun({
        projectId: String(p.projectId ?? ""),
        trigger: String(p.trigger ?? "interactive") as QualityTrigger,
        ...(p.roomId !== undefined ? { roomId: String(p.roomId) } : {}),
        ...(p.taskId !== undefined ? { taskId: String(p.taskId) } : {}),
        ...(p.implementerSessionId !== undefined ? { implementerSessionId: String(p.implementerSessionId) } : {}),
        ...(p.reviewerSessionId !== undefined ? { reviewerSessionId: String(p.reviewerSessionId) } : {}),
        risk: String(p.risk ?? "low") as QualityRisk,
        policyVersion: String(p.policyVersion ?? ""),
        ...(p.baseRevision !== undefined ? { baseRevision: String(p.baseRevision) } : {}),
        ...(p.dirtyBaselineHash !== undefined ? { dirtyBaselineHash: String(p.dirtyBaselineHash) } : {}),
        ...(p.patchHash !== undefined ? { patchHash: String(p.patchHash) } : {}),
        budget: {
          maxFixRounds: Number(p.maxFixRounds ?? 2),
          timeoutMs: Number(p.timeoutMs ?? 60000),
        },
      });
      return { run };
    }
    case "quality.run.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { runs: qualityService.listRuns(projectId, limit) };
    }
    case "quality.run.get": {
      const id = String(req.params?.id ?? "");
      const run = qualityService.getRun(id);
      if (!run) throw new Error(`unknown run: ${id}`);
      const checks = qualityService.listChecks(id);
      const findings = qualityService.listFindings(id);
      return { run, checks, findings };
    }
    case "quality.run.cancel": {
      const id = String(req.params?.id ?? "");
      return { run: qualityService.cancelRun(id) };
    }
    case "quality.run.approve": {
      const id = String(req.params?.id ?? "");
      return { run: qualityService.approveRun(id) };
    }
    case "quality.run.reject": {
      const id = String(req.params?.id ?? "");
      return { run: qualityService.rejectRun(id) };
    }
    case "quality.run.retry": {
      const id = String(req.params?.id ?? "");
      return { run: qualityService.retryRun(id) };
    }
    case "quality.run.advance": {
      const id = String(req.params?.id ?? "");
      const to = String(req.params?.to ?? "");
      return { run: qualityService.advance(id, to as never) };
    }
    case "quality.check.list": {
      const runId = String(req.params?.runId ?? "");
      return { checks: qualityService.listChecks(runId) };
    }
    case "quality.finding.list": {
      const runId = String(req.params?.runId ?? "");
      return { findings: qualityService.listFindings(runId) };
    }
    case "quality.finding.get": {
      const id = String(req.params?.id ?? "");
      const finding = qualityService.getFinding(id);
      if (!finding) throw new Error(`unknown finding: ${id}`);
      return { finding };
    }
    case "quality.finding.resolve": {
      const id = String(req.params?.id ?? "");
      const status = String(req.params?.status ?? "");
      const note = req.params?.resolutionNote !== undefined ? String(req.params.resolutionNote) : undefined;
      const finding = qualityService.resolveFinding(id, status as never, note);
      return { finding };
    }
    // ── quality: review decisions & metrics (Q2-07) ───────────────────
    case "quality.review.decision.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { decisions: qualityService.listReviewDecisions(projectId, limit) };
    }
    case "quality.review.metrics": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      return { metrics: qualityService.getReviewerMetrics(projectId) };
    }
    // ── quality: incidents (Q3-01) ────────────────────────────────────
    case "quality.incident.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      return { incidents: qualityService.listIncidents(projectId) };
    }
    case "quality.incident.get": {
      const id = String(req.params?.id ?? "");
      const incident = qualityService.getIncident(id);
      if (!incident) throw new Error(`unknown incident: ${id}`);
      return { incident };
    }
    case "quality.incident.create": {
      const p = req.params ?? {};
      const incident = qualityService.createIncident({
        projectId: String(p.projectId ?? ""),
        description: String(p.description ?? ""),
        severity: String(p.severity ?? "major"),
        ...(p.sourceRunId !== undefined ? { sourceRunId: String(p.sourceRunId) } : {}),
        ...(p.reproduction !== undefined ? { reproduction: String(p.reproduction) } : {}),
        ...(p.regressionTest !== undefined ? { regressionTest: String(p.regressionTest) } : {}),
      });
      return { incident };
    }
    case "quality.incident.resolve": {
      const id = String(req.params?.id ?? "");
      const status = String(req.params?.status ?? "");
      const regressionTest = req.params?.regressionTest !== undefined ? String(req.params.regressionTest) : undefined;
      const incident = qualityService.resolveIncident(id, status as never, regressionTest);
      return { incident };
    }
    case "quality.incident.delete": {
      const id = String(req.params?.id ?? "");
      const ok = qualityService.deleteIncident(id);
      if (!ok) throw new Error(`unknown incident: ${id}`);
      return { ok: true };
    }
    // ── quality: rule candidates (Q3-04) ──────────────────────────────
    case "quality.rule.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      return { rules: qualityService.listRules(projectId) };
    }
    case "quality.rule.get": {
      const id = String(req.params?.id ?? "");
      const rule = qualityService.getRule(id);
      if (!rule) throw new Error(`unknown rule: ${id}`);
      return { rule };
    }
    case "quality.rule.create": {
      const p = req.params ?? {};
      const rule = qualityService.createRule({
        projectId: String(p.projectId ?? ""),
        rule: String(p.rule ?? ""),
        evidenceIncidentIds: Array.isArray(p.evidenceIncidentIds)
          ? p.evidenceIncidentIds.map((s: unknown) => String(s))
          : [],
        ...(p.measuredImpact !== undefined ? { measuredImpact: String(p.measuredImpact) } : {}),
      });
      return { rule };
    }
    case "quality.rule.promote": {
      const incidentId = String(req.params?.incidentId ?? "");
      const ruleText = String(req.params?.rule ?? "");
      const rule = qualityService.promoteIncidentToRule(incidentId, ruleText);
      return { rule };
    }
    case "quality.rule.resolve": {
      const id = String(req.params?.id ?? "");
      const status = String(req.params?.status ?? "");
      const rule = qualityService.resolveRule(id, status as never);
      return { rule };
    }
    case "quality.rule.delete": {
      const id = String(req.params?.id ?? "");
      const ok = qualityService.deleteRule(id);
      if (!ok) throw new Error(`unknown rule: ${id}`);
      return { ok: true };
    }
    case "quality.rule.sandbox": {
      const id = String(req.params?.id ?? "");
      const result = await qualityService.sandboxRule(id);
      return { result };
    }
    // ── quality: benchmarks (P4 评测基线) ─────────────────────────────
    case "quality.benchmark.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      return { benchmarks: qualityService.listBenchmarks(projectId) };
    }
    case "quality.benchmark.get": {
      const id = String(req.params?.id ?? "");
      const benchmark = qualityService.getBenchmark(id);
      if (!benchmark) throw new Error(`unknown benchmark: ${id}`);
      return { benchmark };
    }
    case "quality.benchmark.start": {
      const p = req.params ?? {};
      const benchmark = qualityService.startBenchmark({
        projectId: String(p.projectId ?? ""),
        name: String(p.name ?? ""),
        taskSet: String(p.taskSet ?? ""),
        agents: Array.isArray(p.agents) ? p.agents.map((s: unknown) => String(s)) : [],
      });
      return { benchmark };
    }
    case "quality.benchmark.collect": {
      const p = req.params ?? {};
      const benchmark = qualityService.collectBenchmarkResult({
        benchmarkId: String(p.benchmarkId ?? ""),
        agent: String(p.agent ?? ""),
        qualityRunId: String(p.qualityRunId ?? ""),
        passedChecks: Number(p.passedChecks ?? 0),
        failedChecks: Number(p.failedChecks ?? 0),
        findingCount: Number(p.findingCount ?? 0),
        blockingCount: Number(p.blockingCount ?? 0),
        fixRounds: Number(p.fixRounds ?? 0),
        durationMs: Number(p.durationMs ?? 0),
        ...(p.status !== undefined ? { status: String(p.status) as never } : {}),
        ...(p.failureReason !== undefined ? { failureReason: String(p.failureReason) } : {}),
      });
      return { benchmark };
    }
    case "quality.benchmark.cancel": {
      const id = String(req.params?.id ?? "");
      const benchmark = qualityService.cancelBenchmark(id);
      return { benchmark };
    }
    case "quality.benchmark.delete": {
      const id = String(req.params?.id ?? "");
      const ok = qualityService.deleteBenchmark(id);
      if (!ok) throw new Error(`unknown benchmark: ${id}`);
      return { ok: true };
    }
    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}

function getConnectionByToken(token: string): Connection | undefined {
  return store.listConnections().find((c) => c.token === token);
}

function handleWorker(ws: WebSocket, req: import("http").IncomingMessage): void {
  const url = new URL(req.url ?? WORKER_PATH, "http://localhost");
  const token = url.searchParams.get("token") ?? "";
  const multiplex = url.searchParams.get("multiplex") === "1";
  const connection = getConnectionByToken(token);
  if (!connection) {
    logWarn("worker", "rejected: unknown token");
    ws.close(4001, "unauthorized");
    return;
  }

  if (multiplex) {
    handleMultiplexWorker(ws, connection);
    return;
  }

  const reportedAgent = url.searchParams.get("agent") ?? undefined;
  if (reportedAgent && reportedAgent !== connection.agent) {
    logWarn(
      "worker",
      `token=${token} reported agent=${reportedAgent} but expected ${connection.agent}`,
    );
  }
  const connectionId = connection.id;
  const old = agents.get(connectionId);
  if (old) {
    old.close();
    agents.delete(connectionId);
  }
  console.log(`[hub] worker connected for ${connection.name} (${connectionId})`);
  const stream = webSocketStream(ws);
  const a = new AcpAgent(connection.name, stream, onAgentEvent, undefined, undefined, onTurnEnd, onFileWrite, onToolCall, runPermissionManager);
  agents.set(connectionId, a);
  a.ensureStarted().then(() => {
    roomModeManager.resumeFlows();
  }).catch((err) => {
    logWarn("worker", `${connectionId} start failed: ${String(err)}`);
    agents.delete(connectionId);
    ws.close();
  });
  ws.on("close", () => {
    console.log(`[hub] worker disconnected ${connectionId}`);
    if (agents.get(connectionId) === a) agents.delete(connectionId);
    for (const [sid, cid] of [...owners.entries()]) {
      if (cid === connectionId) owners.delete(sid);
    }
  });
}

/**
 * 处理 multiplex worker：一个 WebSocket 连接复用多个后端 agent。
 *
 * 协议：
 * 1. worker 连接后发送 announce 控制帧声明可用通道
 * 2. Hub 为每个通道创建/复用虚拟 connection + AcpAgent
 * 3. 后续消息按 channel 路由
 */
function handleMultiplexWorker(ws: WebSocket, baseConnection: Connection): void {
  console.log(`[hub] multiplex worker connected for ${baseConnection.name} (${baseConnection.id})`);

  const virtualAgents: Map<string, AcpAgent> = new Map();

  // 先用单 listener 等待 announce，收到后切换到 multiplex 模式
  let multiplexed: Map<string, import("@agentclientprotocol/sdk").Stream> | null = null;

  const pendingHandler = (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (multiplexed) return; // 已切换，忽略
    const text = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isControlFrame(msg)) {
      logWarn("worker", "multiplex: expected announce frame first, got " + text.slice(0, 100));
      return;
    }
    if (!isAnnounceFrame(msg)) {
      // quality.* 等控制帧在 announce 之前到达，忽略
      return;
    }

    ws.off("message", pendingHandler);

    const channels = msg.channels;
    const hostname = String(msg.hostname ?? baseConnection.name);
    console.log(`[hub] multiplex announce: ${channels.map(c => `${c.id}(${c.agent})`).join(", ")} from ${hostname}`);

    // 为每个通道创建虚拟 connection（如不存在）
    const channelIds: string[] = [];
    for (const ch of channels) {
      const virtualId = `${baseConnection.id}::${ch.id}`;
      channelIds.push(ch.id);
      const virtualName = ch.name ?? `${ch.agent} · ${hostname}`;

      let virtualConn = store.listConnections().find(c => c.id === virtualId);
      if (!virtualConn) {
        store.addConnection({
          id: virtualId,
          name: virtualName,
          agent: ch.agent,
          token: baseConnection.token,
          local: false,
        });
        console.log(`[hub] created virtual connection: ${virtualId} (agent=${ch.agent})`);
      } else if (virtualConn.name !== virtualName) {
        store.updateConnection(virtualId, { name: virtualName });
      }
    }

    // 创建子通道 Stream（注册新的 message listener）
    // quality.* 控制帧通过 onControl 路由到 WorkerExecutionProvider
    const workerExec = new WorkerExecutionProvider((frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    });
    workerExecProviders.set(baseConnection.id, workerExec);
    multiplexed = multiplexWebSocketStream(ws, channelIds, (frame) => {
      if (isQualityControlFrame(frame)) workerExec.dispatch(frame as QualityControlFrame);
    });

    // 为每个通道创建 AcpAgent
    for (const ch of channels) {
      const virtualId = `${baseConnection.id}::${ch.id}`;
      const stream = multiplexed.get(ch.id);
      if (!stream) continue;

      const old = agents.get(virtualId);
      if (old) {
        old.close();
        agents.delete(virtualId);
      }

      const virtualConn = store.listConnections().find(c => c.id === virtualId)!;
      const a = new AcpAgent(
        virtualConn.name,
        stream,
        onAgentEvent,
        undefined,
        undefined,
        onTurnEnd,
        onFileWrite,
        onToolCall,
        runPermissionManager,
      );
      agents.set(virtualId, a);
      virtualAgents.set(ch.id, a);

      a.ensureStarted().then(() => {
        roomModeManager.resumeFlows();
      }).catch((err) => {
        logWarn("worker", `multiplex channel ${ch.id} start failed: ${String(err)}`);
        agents.delete(virtualId);
        virtualAgents.delete(ch.id);
      });
    }
  };

  ws.on("message", pendingHandler);
  ws.on("close", () => {
    console.log(`[hub] multiplex worker disconnected ${baseConnection.id}`);
    for (const [ch, a] of virtualAgents) {
      a.close();
      const connId = `${baseConnection.id}::${ch}`;
      agents.delete(connId);
      for (const [sid, cid] of [...owners.entries()]) {
        if (cid === connId) owners.delete(sid);
      }
    }
    virtualAgents.clear();
    const removedWorkerExec = workerExecProviders.get(baseConnection.id);
    workerExecProviders.delete(baseConnection.id);
    removedWorkerExec?.onDisconnect();
  });
}

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === WORKER_PATH) {
    handleWorker(ws, req);
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    ws.close(4001, "unauthorized");
    return;
  }
  clients.add(ws);
  console.log(`[hub] client connected (${clients.size} total)`);
  ws.on("close", () => clients.delete(ws));
  ws.on("message", async (raw) => {
    let req2: RequestMessage;
    try {
      req2 = JSON.parse(String(raw));
    } catch {
      send(ws, { id: null, error: "invalid json" });
      return;
    }
    try {
      const result = await handleRequest(req2);
      send(ws, { id: req2.id, result });
    } catch (err) {
      logError(`request ${req2.method}`, err);
      send(ws, { id: req2.id, error: String(err) });
    }
  });
});

wss.on("listening", () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
  console.log(`[hub] ws listening on port ${PORT}`);
  console.log(`[hub] agent types: ${Object.keys(AGENT_DEFS).join(", ")}`);
  console.log(`[hub] data dir: ${store.dir}`);
  console.log(
    `[hub] restored: ${sessionMetas.size} sessions, ${rooms.list().length} rooms`,
  );
  for (const addr of addrs) {
    console.log(`[hub] phone connect: ws://${addr}:${PORT}/?token=${TOKEN}`);
    console.log(`[hub] worker connect: ws://${addr}:${PORT}${WORKER_PATH}?token=<CONNECTION_TOKEN>`);
  }
  if (process.env.HUB_TUNNEL === "1") {
    startTunnel(PORT, TOKEN);
  }
});
