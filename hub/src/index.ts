// dogfood test: L0-L4 全链路验证注释 — 2026-09-09
import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import spawn from "cross-spawn";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpAgent,
  getPermissionBypass,
  promptDoneInternalOutput,
  setPermissionBypass,
  toPublicHubEvent,
  type ElicitationValue,
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
import { recoverInterruptedRuns, FAILURE_HUB_RESTART } from "./quality/recovery.js";
import { isTerminal } from "./quality/run.js";
import { RunPermissionManager } from "./quality/permissions.js";
import { ReviewOrchestrator, type ReviewerSessionRunner } from "./quality/review-orchestrator.js";
import { FixerOrchestrator, type FixerSessionRunner } from "./quality/fixer-orchestrator.js";
import { GateEngine, type GateResult } from "./quality/gate.js";
import type { ExecutionProvider } from "./quality/execution.js";
import { LocalExecutionProvider } from "./quality/execution-local.js";
import { RoutingExecutionProvider } from "./quality/execution.js";
import { collectChangeSet, collectBaseline, type Baseline } from "./quality/change-set.js";
import { defaultObservePolicy, getPolicyEnforcement, getPolicyMaxFixRounds, hashPolicy, isPolicyReviewEnabled, readPolicySnapshot, shouldTriggerReview, writePolicySnapshot, writePolicyV2, validatePolicyV2 } from "./quality/policy.js";
import { classifyChangeSet } from "./quality/risk.js";
import type { ChangeSet, CheckTier, ProjectScope, QualityPolicy, QualityPolicyV2, QualityRisk, QualityRun, QualityTrigger, WorkItem } from "./quality/types.js";
import type { QualityIntegration } from "./conductor.js";
import { WriterLeaseManager } from "./quality/lease.js";
import { RunContextRegistry } from "./quality/run-context.js";
import { DirtyTracker } from "./quality/dirty-tracker.js";

const PORT = Number(process.env.HUB_PORT ?? 8787);
const TOKEN = process.env.HUB_TOKEN ?? "dev-token";
const WORKER_PATH = "/worker";

function setSessionModel(
  agent: AcpAgent,
  _backend: ModelBackend,
  sessionId: string,
  model: string,
): Promise<void> {
  return agent.setConfigOption(sessionId, "model", model);
}

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
const routingExecProvider = new RoutingExecutionProvider(localExecProvider, workerExecProviders);
const store = new Store();
const modelManager = new ModelManager();
const qualityRunCallbacks = new Map<string, (accepted: boolean) => void>();
const runPermissionManager = new RunPermissionManager();
const writerLeaseManager = new WriterLeaseManager();
const runContextRegistry = new RunContextRegistry();
const dirtyTracker = new DirtyTracker();
// require 模式下被挂起的原始消息，澄清完成后恢复派发。键为 requestId。
const suspendedPrompts = new Map<string, {
  source: "room" | "session";
  roomId?: string;
  sessionId?: string;
  mode?: string;
  text: string;
  content?: Array<Record<string, unknown>>;
  quote?: { author: string; text: string };
}>();
const qualityEmit: Emit = (event: QualityEvent) => {
  broadcast(event as HubEvent);
  if (event.method === "quality.review.prompt") {
    const { roomId, kind } = event.params;
    const message = kind === "add-reviewer"
      ? "当前群聊即将进入 AI 审查阶段，是否拉入一名审查 AI？"
      : "当前代码改动即将进入 AI 审查，是否创建审查群聊并在群内协作？";
    if (roomId) {
      roomModeManager.broadcastRoomNotice(roomId, message);
    }
    return;
  }
  if (event.method === "quality.reviewed") {
    const { runId, roomId, findings, verdict } = event.params;
    if (roomId) {
      const lines: string[] = [`📋 Review 完成 · run ${runId} · 结论: ${verdict}`];
      if (findings.length === 0) {
        lines.push("（无问题发现）");
      } else {
        for (const f of findings) {
          const loc = f.file ? `${f.file}${f.line !== undefined ? `:${f.line}` : ""}` : "未知位置";
          const sev = `[${f.severity}]`;
          const blk = f.blocking ? " ⛔阻断" : "";
          lines.push(`${sev}${blk} ${loc} — ${f.claim}`);
          if (f.evidence) lines.push(`  证据: ${f.evidence}`);
          if (f.suggestion) lines.push(`  建议: ${f.suggestion}`);
        }
      }
      roomModeManager.broadcastRoomNotice(roomId, lines.join("\n"));
    }
    return;
  }
  if (event.method !== "quality.runUpdate") return;
  const { runId, run } = event.params;
  if (isTerminal(run.stage)) {
    runPermissionManager.unbindRun(runId);
    writerLeaseManager.releaseByRunId(runId);
    for (const sessionId of runContextRegistry.unbindRun(runId)) dirtyTracker.clearDirty(sessionId);
    if (run.workItemId) {
      qualityService.updateWorkItemStatus(run.workItemId, run.stage === "cancelled" ? "cancelled" : "completed", run.id, run.generation);
    }
    // L4 自动回流：run 终态 failed/inconclusive 时自动创建 Observation
    if (run.stage === "failed" || run.stage === "inconclusive") {
      const isInfra = run.failureCode === FAILURE_HUB_RESTART;
      let attribution: "candidate" | "infrastructure" | "unknown";
      let kind: "check-failure" | "infra-failure" | "verification-gap";
      if (isInfra) {
        attribution = "infrastructure";
        kind = "infra-failure";
      } else if (run.stage === "inconclusive") {
        // inconclusive 且非 hub-restart：区分无检查/无 patch vs 真实代码失败
        const checks = qualityService.listChecks(runId);
        const hasPatch = run.patchHash !== undefined && run.patchHash !== "";
        if (checks.length === 0 || !hasPatch) {
          // 无检查或无 patch → 无法归因到候选变更，标记为 unknown
          attribution = "unknown";
          kind = "verification-gap";
        } else {
          attribution = "candidate";
          kind = "check-failure";
        }
      } else {
        attribution = "candidate";
        kind = "check-failure";
      }
      qualityService.createObservation({
        projectId: run.projectId,
        kind,
        attribution,
        runId: run.id,
        ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
        evidenceRefs: [],
      });
    }
    broadcast({
      method: "quality.approvalResolved",
      params: { requestId: `quality-approval-${runId}`, outcome: run.stage },
    });
    const cb = qualityRunCallbacks.get(runId);
    if (cb) {
      qualityRunCallbacks.delete(runId);
      cb(run.stage === "accepted" || run.stage === "waived");
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

    const targetModel = (opts.model ?? "").trim();
    if (targetModel) {
      try {
        await modelManager.list();
        const modelInfo = modelManager.find(targetModel);
        if (modelInfo) {
          // 找到匹配后端且在线的 agent
          const connections = store.listConnections().filter((c) => c.agent === modelInfo.backend);
          for (const conn of connections) {
            const agent = agents.get(conn.id);
            if (agent?.isReady) {
              const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
              owners.set(sessionId, conn.id);
              // 保持 session 级模型偏好与 agent 配置一致
              await modelManager.setForSession(modelInfo.uid, sessionId).catch((err) =>
                logWarn("review", `set session model preference failed: ${String(err)}`)
              );
              await setSessionModel(agent, modelInfo.backend, sessionId, modelInfo.uid).catch((err) =>
                logWarn("review", `set agent model failed: ${String(err)}`)
              );
              sessionMetas.set(sessionId, {
                sessionId,
                cwd: opts.project.root,
                name: "reviewer",
                agent: conn.agent,
                connectionId: conn.id,
              });
              persistState();
              return sessionId;
            }
          }
          logWarn("review", `no ready agent for model ${targetModel} (backend ${modelInfo.backend}), falling back`);
        } else {
          logWarn("review", `model ${targetModel} not found, falling back`);
        }
      } catch (err) {
        logWarn("review", `model resolution failed for ${targetModel}: ${String(err)}`);
      }
    }

    // 回退：找一个可用的 agent 创建新 session
    const agent = [...agents.values()].find((a) => a.isReady);
    if (!agent) throw new Error("no agent available for reviewer session");
    const { sessionId } = await agent.createSession(opts.project.root, "reviewer");
    owners.set(sessionId, [...agents.entries()].find(([, a]) => a === agent)![0]);
    return sessionId;
  },
  async promptOnce(sessionId, text) {
    const agent = agentForSession(sessionId);
    if (!agent) throw new Error(`agent not found for reviewer session ${sessionId}`);
    return agent.promptOnce(sessionId, text, 0);
  },
};

let reviewOrchestrator: ReviewOrchestrator | undefined;
const reviewPromptFallbacks = new Map<string, ReturnType<typeof setTimeout>>();

function ensureReviewOrchestrator(): ReviewOrchestrator {
  if (!reviewOrchestrator) {
    reviewOrchestrator = new ReviewOrchestrator(
      qualityService,
      runPermissionManager,
      reviewerSessionRunner,
      { artifactDir: qualityArtifactDir },
    );
  }
  return reviewOrchestrator;
}

/** reviewRunner 回调：当 run 进入 reviewing 阶段时触发 ReviewOrchestrator。 */
const reviewRunner = (run: QualityRun) => {
  if (run.stage !== "reviewing") return;

  // 首次进入 reviewing 时先向用户弹出协作方式确认
  if (!run.reviewPromptedAt) {
    const kind = run.roomId ? "add-reviewer" : "create-review-room";
    qualityService.emitReviewPrompt(run.id, run.projectId, run.roomId, run.implementerSessionId, kind);
    const now = Date.now();
    qualityService.saveRun({ ...run, reviewPromptedAt: now, reviewPromptAction: "pending" });
    // 60 秒内用户未响应，则默认沿用旧行为继续 review（兼容旧客户端）
    const timer = setTimeout(() => {
      reviewPromptFallbacks.delete(run.id);
      const current = qualityService.getRun(run.id);
      if (!current || current.stage !== "reviewing" || current.reviewPromptAction !== "pending") return;
      qualityService.saveRun({ ...current, reviewPromptAction: "proceed" });
      ensureReviewOrchestrator().runReview(run.id).catch((err) => {
        logError("review-orchestrator", err);
        try { qualityService.advance(run.id, "failed", "review-error"); } catch { /* */ }
      });
    }, 60000);
    reviewPromptFallbacks.set(run.id, timer);
    return;
  }

  // 用户尚未决策时保持等待
  if (run.reviewPromptAction === "pending") return;

  // 用户已决策或默认继续时执行 review
  ensureReviewOrchestrator().runReview(run.id).catch((err) => {
    logError("review-orchestrator", err);
    // 安全失败：推进到 failed
    try {
      qualityService.advance(run.id, "failed", "review-error");
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

/** GateEngine 使用的 ExecutionProvider：RoutingExecutionProvider 按 project.connectionId 路由。 */
function resolveGateExecProvider(): ExecutionProvider {
  return routingExecProvider;
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
      qualityService.advance(run.id, "failed", "fixer-error");
    } catch { /* run 可能已终态 */ }
  });
};

function policyForRun(run: QualityRun, project: NonNullable<ReturnType<QualityService["getProject"]>>): QualityPolicy | QualityPolicyV2 | undefined {
  if (run.policySnapshotRef) {
    const snapshot = readPolicySnapshot(run.policySnapshotRef, project);
    if (snapshot && (!run.policyHash || hashPolicy(snapshot) === run.policyHash)) return snapshot;
    logWarn("gate-runner", `invalid policy snapshot for run ${run.id}`);
    return undefined;
  }
  const loaded = qualityService.loadPolicyWithVersion(project.id);
  return loaded.policy ? qualityService.loadActiveControlsIntoPolicy(loaded.policy, project.id) : undefined;
}

function baselineForRun(run: QualityRun, project: NonNullable<ReturnType<QualityService["getProject"]>>): Baseline {
  if (run.baseRevision !== undefined || run.dirtyBaselineHash !== undefined) {
    return {
      revision: run.baseRevision ?? "",
      dirtyHash: run.dirtyBaselineHash ?? null,
      isGit: project.capabilities.git,
    };
  }
  return collectBaseline(project);
}

function higherRisk(a: QualityRisk, b: QualityRisk): QualityRisk {
  const order: QualityRisk[] = ["low", "medium", "high", "critical"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

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
      try { qualityService.advance(runId, "inconclusive", "infra-no-project"); } catch { /* */ }
      return;
    }
    const policy = policyForRun(current, project);
    if (!policy) {
      try { qualityService.advance(runId, "inconclusive", "infra-no-policy"); } catch { /* */ }
      return;
    }
    const baseline = baselineForRun(current, project);
    let changeSet: ChangeSet | undefined;
    let runForAdvance = current;
    try {
      changeSet = collectChangeSet(runId, project, baseline, {
        protectedPaths: policy.protectedPaths,
        riskRules: policy.riskRules,
      }, qualityArtifactDir);
      const classified = classifyChangeSet(changeSet.files, policy);
      runForAdvance = {
        ...current,
        patchHash: changeSet.patchHash,
        changeSetId: changeSet.patchHash,
        risk: higherRisk(current.risk, classified.risk),
      };
      qualityService.saveRun(runForAdvance);
    } catch (err) {
      logWarn("gate-runner", `changeSet collection failed for run ${runId}: ${String(err)}`);
    }
    const gate = new GateEngine(resolveGateExecProvider(), {
      onSaveCheck: (check) => qualityService.saveCheck(check),
    });
    const attempt = current.fixRound + 1;
    gate.runGate(project, policy, tier, runId, changeSet, attempt).then((result) => {
      advanceAfterGate(runId, result, qualityService.getRun(runId) ?? runForAdvance, policy, tier, changeSet);
    }).catch((err) => {
      logError("gate-runner", err);
      try { qualityService.advance(runId, "inconclusive", "l1-infra-failed"); } catch { /* */ }
    });
  };
}

function requiresRiskApproval(policy: QualityPolicy | QualityPolicyV2, risk: QualityRisk): boolean {
  if (getPolicyEnforcement(policy) !== "require-approval") return false;
  if (policy.version === 1) return true;
  const order: QualityRisk[] = ["low", "medium", "high", "critical"];
  return order.indexOf(risk) >= order.indexOf(policy.enforcement.approvalRisk);
}

function advanceAfterGate(
  runId: string,
  gate: GateResult,
  run: QualityRun,
  policy: QualityPolicy | QualityPolicyV2,
  tier: CheckTier,
  changeSet?: ChangeSet | undefined,
): void {
  if (gate.passed) {
    if (tier === "quick") {
      console.log(`[hub] gate-runner: quick gate passed, advancing to full-verifying for run ${runId}`);
      const reviewEnabled = isPolicyReviewEnabled(policy);
      const shouldReview = reviewEnabled && policy.version === 2 && changeSet
        ? shouldTriggerReview(changeSet, policy.review)
        : reviewEnabled;
      qualityService.advance(runId, shouldReview ? "reviewing" : "full-verifying");
      return;
    }
    const checks = qualityService.listChecks(runId);
    console.log(`[hub] gate-runner: full gate passed for run ${runId}, checks=${checks.length}, patchHash=${run.patchHash ?? "none"}, workItemId=${run.workItemId ?? "none"}`);
    if (!checks.some((check) => check.status === "passed")) {
      qualityService.advance(runId, "inconclusive", "l1-no-passed-checks");
    } else if (!run.patchHash) {
      qualityService.advance(runId, "inconclusive", "no-patch");
    } else {
      // L3 接入：full-verifying 通过后，若有 spec 且 verification 模式非 off，进入 requirement-verifying
      const hasSpec = run.workItemId !== undefined && qualityService.getWorkItem(run.workItemId)?.specId !== undefined;
      const verificationMode = "verification" in policy ? policy.verification.mode : "off";
      console.log(`[hub] gate-runner: L3 check for run ${runId}: hasSpec=${hasSpec}, verificationMode=${verificationMode}, workItemId=${run.workItemId ?? "none"}`);
      if (hasSpec && verificationMode !== "off") {
        try { qualityService.advance(runId, "requirement-verifying"); console.log(`[hub] gate-runner: advanced to requirement-verifying for run ${runId}`); return; } catch (err) { console.log(`[hub] gate-runner: advance to requirement-verifying failed: ${String(err)}`); }
      }
      if (requiresRiskApproval(policy, run.risk)) {
        console.log(`[hub] gate-runner: advancing to awaiting-approval for run ${runId}`);
        qualityService.advance(runId, "awaiting-approval");
      } else {
        console.log(`[hub] gate-runner: advancing to accepted for run ${runId}`);
        qualityService.advance(runId, "accepted");
      }
    }
    return;
  }
  if (gate.inconclusive || (!gate.codeFailed && gate.infraFailed)) {
    logWarn("gate-runner", `run ${runId} ${tier} gate inconclusive`);
    console.log(`[hub] gate-runner: ${tier} gate inconclusive for run ${runId}, gate=${JSON.stringify({ passed: gate.passed, inconclusive: gate.inconclusive, codeFailed: gate.codeFailed, infraFailed: gate.infraFailed })}`);
    try { qualityService.advance(runId, "inconclusive", "l1-inconclusive"); } catch { /* */ }
    return;
  }
  if (gate.codeFailed && run.fixRound < run.budget.maxFixRounds) {
    try { qualityService.advance(runId, "fixing"); } catch { /* */ }
    return;
  }
  console.log(`[hub] gate-runner: ${tier} gate fallback to ${gate.codeFailed ? "failed" : "inconclusive"} for run ${runId}, gate=${JSON.stringify({ passed: gate.passed, codeFailed: gate.codeFailed, infraFailed: gate.infraFailed })}`);
  try { qualityService.advance(runId, gate.codeFailed ? "failed" : "inconclusive", gate.codeFailed ? "l1-check-failed" : "l1-inconclusive"); } catch { /* */ }
}

const quickRunner = makeGateRunner("quick");
const fullRunner = makeGateRunner("full");

const qualityService = new QualityService(store, qualityEmit, {
  reviewRunner,
  fixerRunner,
  quickRunner,
  fullRunner,
  onAwaitingApproval: (run) => {
    if (run.roomId) {
      roomModeManager.notifyAwaitingApproval(run.id);
      roomModeManager.broadcastRoomNotice(run.roomId, `质量运行 ${run.id} 等待审批 · 风险: ${run.risk} · 修复轮次: ${run.fixRound}/${run.budget.maxFixRounds}，请在质量面板中批准或拒绝`);
    }
    broadcast({ method: "quality.awaitingApproval", params: { runId: run.id, projectId: run.projectId, roomId: run.roomId ?? null } });
    broadcast({
      method: "quality.approvalRequest",
      params: {
        requestId: `quality-approval-${run.id}`,
        runId: run.id,
        projectId: run.projectId,
        roomId: run.roomId ?? null,
        title: `质量审批 · ${run.id} · 风险: ${run.risk} · 修复轮次: ${run.fixRound}/${run.budget.maxFixRounds}`,
        options: [
          { optionId: "approve", name: "批准" },
          { optionId: "reject", name: "拒绝" },
        ],
      },
    });
  },
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

function resolveProjectRoot(connection: Connection): string | undefined {
  if (connection.cwd) return connection.cwd;
  const def = AGENT_DEFS[connection.agent];
  if (def?.cwd) return def.cwd;
  if (connection.local) return process.cwd();
  return undefined;
}

function autoRegisterProject(connection: Connection): void {
  const root = resolveProjectRoot(connection);
  if (!root) return;
  try {
    if (!fs.existsSync(root)) return;
  } catch {
    return;
  }
  const existing = qualityService.listProjects().find((p) => p.root === root);
  if (existing) return;
  const project = qualityService.registerProject({ connectionId: connection.id, root });
  console.log(`[hub] auto-registered quality project: ${project.id} (root=${root}, connection=${connection.id})`);
}

function autoRegisterAllProjects(): void {
  for (const conn of store.listConnections()) {
    autoRegisterProject(conn);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function findProjectForPaths(
  projects: ReturnType<QualityService["listProjects"]>,
  filePaths: string[],
): ReturnType<QualityService["getProject"]> | undefined {
  const matches = projects.filter((project) => {
    const root = project.gitRoot ?? project.root;
    return filePaths.length > 0 && filePaths.every((filePath) => isInside(root, path.resolve(filePath)));
  });
  return matches.sort((a, b) => (b.gitRoot ?? b.root).length - (a.gitRoot ?? a.root).length)[0];
}

function findProjectForSession(sessionId: string, filePaths: string[] = []): ProjectScope | undefined {
  const projects = qualityService.listProjects();
  const meta = sessionMetas.get(sessionId);
  const cwd = meta?.cwd ? path.resolve(meta.cwd) : undefined;
  const resolvedPaths = filePaths.map((filePath) => path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(cwd ?? process.cwd(), filePath));
  if (resolvedPaths.length > 0) {
    const byPaths = findProjectForPaths(projects, resolvedPaths);
    if (byPaths) return byPaths;
  }
  if (!cwd) return undefined;
  const owner = owners.get(sessionId);
  const matches = projects
    .filter((project) => isInside(project.gitRoot ?? project.root, cwd))
    .sort((a, b) => {
      const specificity = (b.gitRoot ?? b.root).length - (a.gitRoot ?? a.root).length;
      if (specificity !== 0) return specificity;
      return Number(b.connectionId === owner) - Number(a.connectionId === owner);
    });
  return matches[0];
}

type PreparedQualityRun = { run: QualityRun; workItem: WorkItem; project: ProjectScope };

/**
 * L0 横切评估：在消息派发给 agent 之前运行意图分类 + 需求评估。
 * 读取 policy.requirements.mode：off 跳过；suggest 仅广播；require 挂起等待澄清。
 * 仅 code-change 意图触发完整评估；有 clarification 时广播 clarificationRequired 事件。
 * 返回 { proceed }：require 模式下需要澄清时 proceed=false，调用方应停止派发。
 */
function resolveProjectForL0(params: { source: "room" | "session"; roomId?: string; sessionId?: string }): ProjectScope | undefined {
  if (params.sessionId) {
    const project = findProjectForSession(params.sessionId);
    if (project) return project;
  }
  if (params.roomId) {
    const room = rooms.get(params.roomId);
    if (room) {
      const candidates = [room.conductorId, ...room.members.map((m) => m.sessionId)].filter((s): s is string => !!s);
      for (const sid of candidates) {
        const project = findProjectForSession(sid);
        if (project) return project;
      }
    }
  }
  return undefined;
}

async function runL0Intercept(params: {
  text: string;
  source: "room" | "session";
  correlationId: string;
  mode?: string;
  roomId?: string;
  sessionId?: string;
  content?: Array<Record<string, unknown>>;
  quote?: { author: string; text: string };
}): Promise<{ proceed: boolean }> {
  try {
    const intent = qualityService.classifyRequestIntent(params.text);
    if (intent !== "code-change") return { proceed: true };

    const project = resolveProjectForL0(params);
    const projectId = project?.id;
    let mode: QualityPolicyV2["requirements"]["mode"] = "off";
    if (projectId) {
      const policy = qualityService.getProjectPolicy(projectId);
      if (policy) mode = policy.requirements.mode;
    }
    if (mode === "off") return { proceed: true };

    const l0Mode = mode === "require" || mode === "require-high-risk" ? "require" : "suggest";
    const result = await qualityService.handleL0Request({
      text: params.text,
      source: params.source,
      correlationId: params.correlationId,
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      l0Mode,
    });

    if (result.clarificationRequest) {
      broadcast({
        method: "requirement.clarificationRequired",
        params: {
          requestId: result.request.id,
          clarificationRequestId: result.clarificationRequest.id,
          specId: result.clarificationRequest.specId,
          specVersion: result.clarificationRequest.specVersion,
          questions: result.clarificationRequest.questions,
          canSkip: result.clarificationRequest.canSkip,
          expiresAt: result.clarificationRequest.expiresAt ?? null,
        },
      } as HubEvent);
    }

    // require 模式下有澄清问题 → 挂起原消息，等待澄清完成后恢复
    if (l0Mode === "require" && result.clarificationRequest) {
      suspendedPrompts.set(result.request.id, {
        source: params.source,
        ...(params.roomId !== undefined ? { roomId: params.roomId } : {}),
        ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        ...(params.mode !== undefined ? { mode: params.mode } : {}),
        text: params.text,
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.quote !== undefined ? { quote: params.quote } : {}),
      });
      return { proceed: false };
    }
    return { proceed: true };
  } catch (err) {
    // L0 评估失败 → 安全降级，不阻断消息
    logError("L0 intercept", String(err));
    return { proceed: true };
  }
}

/** require 模式澄清完成后恢复被挂起的原始消息派发。 */
function resumeSuspendedPrompt(requestId: string): void {
  const suspended = suspendedPrompts.get(requestId);
  if (!suspended) return;
  suspendedPrompts.delete(requestId);
  const spec = qualityService.findCurrentSpec({
    ...(suspended.roomId !== undefined ? { roomId: suspended.roomId } : {}),
    ...(suspended.sessionId !== undefined ? { sessionId: suspended.sessionId } : {}),
  })?.spec;
  const ctx = spec ? qualityService.buildSpecPromptContext(spec) : undefined;
  const prefix = ctx ? `${ctx}\n\n` : "";
  if (suspended.source === "session" && suspended.sessionId) {
    const content = suspended.content ?? [{ type: "text", text: suspended.text }];
    const enriched = content.map((b) => b.type === "text" ? { ...b, text: `${prefix}${String(b.text ?? "")}` } : b);
    agentOps.prompt(suspended.sessionId, enriched).catch((err: unknown) => logError("resume suspended prompt", String(err)));
  } else if (suspended.source === "room" && suspended.roomId) {
    const room = rooms.get(suspended.roomId);
    if (room) {
      const text = `${prefix}${suspended.text}`;
      void roomModeManager.handle(room, text, {
        ...(suspended.quote !== undefined ? { quote: suspended.quote } : {}),
        content: suspended.content ?? [{ type: "text", text }],
        params: {},
        sessionNote: (sid: string) => sessionLostReplyNote(sid),
      }).catch((err: unknown) => logError("resume suspended room prompt", String(err)));
    }
  }
}

function prepareQualityRun(opts: {
  sessionId: string;
  trigger: QualityTrigger;
  risk: QualityRisk;
  mode: string;
  roomId?: string;
  taskId?: string;
  filePaths?: string[];
  requestId?: string;
  specId?: string;
  specVersion?: number;
  reviewerSessionId?: string;
}): PreparedQualityRun | undefined {
  const project = findProjectForSession(opts.sessionId, opts.filePaths);
  if (!project) return undefined;
  const loaded = qualityService.loadPolicyWithVersion(project.id);
  const fallback = qualityService.getPolicy(project.id).policy;
  const policy = qualityService.loadActiveControlsIntoPolicy(loaded.policy ?? fallback, project.id);
  const request = opts.requestId
    ? qualityService.getWorkRequest(opts.requestId)
    : qualityService.createWorkRequest({
        source: opts.roomId ? "room" : "session",
        intent: "code-change",
        correlationId: `${opts.roomId ?? opts.sessionId}:${opts.taskId ?? Date.now()}`,
        mode: opts.mode,
        ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
        sessionId: opts.sessionId,
      });
  if (!request) return undefined;
  qualityService.updateWorkRequestStatus(request.id, "dispatched");
  // 自动绑定 specId/specVersion：优先用调用方传入，否则按 roomId/sessionId 持久化查找
  let specId = opts.specId;
  let specVersion = opts.specVersion;
  if (specId === undefined) {
    const current = qualityService.findCurrentSpec({
      ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
      sessionId: opts.sessionId,
    });
    if (current) {
      specId = current.spec.id;
      specVersion = current.spec.version;
    }
  }
  const workItem = qualityService.createWorkItem({
    requestId: request.id,
    projectId: project.id,
    mode: opts.mode,
    sessionId: opts.sessionId,
    ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(specId !== undefined ? { specId } : {}),
    ...(specVersion !== undefined ? { specVersion } : {}),
  });
  const baseline = collectBaseline(project);
  const policyHash = hashPolicy(policy);
  let run = qualityService.startRun({
    projectId: project.id,
    trigger: opts.trigger,
    risk: opts.risk,
    implementerSessionId: opts.sessionId,
    ...(opts.reviewerSessionId !== undefined ? { reviewerSessionId: opts.reviewerSessionId } : {}),
    policyVersion: String(policy.version),
    policyHash,
    workItemId: workItem.id,
    generation: 1,
    ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(baseline.revision ? { baseRevision: baseline.revision } : {}),
    ...(baseline.dirtyHash !== null ? { dirtyBaselineHash: baseline.dirtyHash } : {}),
    budget: { maxFixRounds: getPolicyMaxFixRounds(policy), timeoutMs: 60000 },
  });
  const snapshot = writePolicySnapshot(policy, qualityArtifactDir, run.id);
  run = { ...run, policyHash: snapshot.hash, policySnapshotRef: snapshot.ref };
  qualityService.saveRun(run);
  qualityService.updateWorkItemStatus(workItem.id, "active", run.id, 1);
  qualityService.advance(run.id, "preflight");
  const lease = writerLeaseManager.acquire(project.id, opts.sessionId, run.id);
  if (!lease.ok) {
    qualityService.advance(run.id, "inconclusive", "lease-failed");
    return { run: qualityService.getRun(run.id)!, workItem, project };
  }
  runPermissionManager.bindSession(opts.sessionId, run.id, "implementer");
  if (opts.reviewerSessionId) {
    runPermissionManager.bindSession(opts.reviewerSessionId, run.id, "reviewer");
  }
  runContextRegistry.bind(opts.sessionId, {
    runId: run.id,
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    role: "implementer",
  }, opts.roomId);
  // 进入 implementing 前把 spec.goal + 澄清答案拼入 implementer 上下文（广播到 room 使编程端可见）
  if (workItem.specId) {
    const spec = qualityService.getRequirementSpec(workItem.specId);
    if (spec && opts.roomId) {
      const ctx = qualityService.buildSpecPromptContext(spec);
      if (ctx) roomModeManager.broadcastRoomNotice(opts.roomId, `【需求上下文】\n${ctx}`);
    }
  }
  qualityService.advance(run.id, "implementing");
  return { run: qualityService.getRun(run.id)!, workItem, project };
}

function completeQualityRun(runId: string): QualityRun | undefined {
  const run = qualityService.getRun(runId);
  if (!run || isTerminal(run.stage)) return run;
  if (run.stage !== "implementing") return run;
  qualityService.advance(runId, "collecting");
  return qualityService.advance(runId, "quick-verifying");
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
    if (!opts.sessionId) return undefined;
    const prepared = prepareQualityRun({
      sessionId: opts.sessionId,
      trigger: "conductor",
      risk: "medium",
      mode: "conductor",
      ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      filePaths,
      ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
    });
    if (!prepared) return undefined;
    // Conductor 任务派发后 agent 尚未实现，run 停留在 implementing
    return prepared.run.id;
  },
  completeRunForTask(runId, _output, _artifacts) {
    completeQualityRun(runId);
  },
  cancelRunForTask(runId) {
    const run = qualityService.getRun(runId);
    if (run && !isTerminal(run.stage)) {
      qualityService.cancelRun(runId);
    }
  },
  onRunTerminal(runId, cb) {
    const run = qualityService.getRun(runId);
    if (run && isTerminal(run.stage)) {
      cb(run.stage === "accepted" || run.stage === "waived");
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
      cb(run.stage === "accepted" || run.stage === "waived");
      return;
    }
    qualityRunCallbacks.set(runId, cb);
  },
  getRunEnforcement(runId) {
    const run = qualityService.getRun(runId);
    if (!run) return undefined;
    const project = qualityService.getProject(run.projectId);
    if (!project) return undefined;
    const policy = policyForRun(run, project);
    if (!policy) return "require-pass";
    return getPolicyEnforcement(policy);
  },
  getRunSummary(runId) {
    const run = qualityService.getRun(runId);
    if (!run) return undefined;
    const checks = qualityService.listChecks(runId);
    const findings = qualityService.listFindings(runId);
    const project = qualityService.getProject(run.projectId);
    const policy = project ? policyForRun(run, project) : undefined;
    const enforcement = policy ? getPolicyEnforcement(policy) : "require-pass";
    return {
      runId,
      stage: run.stage,
      enforcement,
      fixRound: run.fixRound,
      maxFixRounds: run.budget.maxFixRounds,
      passedChecks: checks.filter((c) => c.status === "passed").length,
      failedChecks: checks.filter((c) => c.status === "failed").length,
      findings: findings.length,
      blockingFindings: findings.filter((f) => f.blocking).length,
      ...(run.verdict !== undefined ? { verdict: run.verdict } : {}),
      ...(run.failureCode !== undefined ? { failureCode: run.failureCode } : {}),
      awaitingApproval: run.stage === "awaiting-approval",
    };
  },
  getSpecPromptContext(roomId) {
    const current = qualityService.findCurrentSpec({ roomId });
    if (!current) return undefined;
    return qualityService.buildSpecPromptContext(current.spec);
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
  const env = { ...process.env, ...def.env };
  if (!def.env?.ACP_BACKEND) delete env.ACP_BACKEND;
  return spawn(def.bin, def.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: def.cwd,
    env,
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
          autoRegisterProject(connection);
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

function onFileWrite(sessionId: string, relPath: string, existed: boolean, content?: string): void {
  const meta = sessionMetas.get(sessionId);
  if (!meta) return;
  const author = meta.name;
  const summary = existed ? "修改" : "新增";
  dirtyTracker.markDirty(sessionId, "file", [relPath]);

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
    dirtyTracker.markDirty(sessionId, "tool", paths);
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
    event.method !== "permission.request" &&
    event.method !== "elicitation.request";
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
        if (!handled && dirtyTracker.isDirty(sessionId!)) {
          triggerGateForSession(sessionId!, internalOutput);
        }
        dirtyTracker.clearDirty(sessionId!);
      })
      .catch((err) => {
        logError("room-modes", err);
        dirtyTracker.clearDirty(sessionId!);
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
  const dirtyPaths = dirtyTracker.collectPaths(sessionId);
  const allPaths = [...new Set([...filePaths, ...ledgerFiles, ...dirtyPaths])];
  const project = findProjectForPaths(projects, allPaths);
  if (!project) return;
  const { policy } = qualityService.getPolicy(project.id);
  const reviewerSessionId = policy.review.reviewerSessionId;
  // 通过持久化查找复用 L0 创建的 WorkRequest/RequirementSpec，打通 L0-L3 链路
  const current = qualityService.findCurrentSpec({ sessionId });
  const prepared = prepareQualityRun({
    sessionId,
    trigger: "interactive",
    risk: "medium",
    mode: "session",
    filePaths: allPaths,
    ...(reviewerSessionId !== undefined ? { reviewerSessionId } : {}),
    ...(current ? { requestId: current.request.id, specId: current.spec.id, specVersion: current.spec.version } : {}),
  });
  if (!prepared) return;
  // agent 已完成实现，直接推进到 quick-verifying
  completeQualityRun(prepared.run.id);
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

function parseRetryCommand(text: string): { taskIds?: string[] } | null {
  const t = text.trim().toLowerCase();
  if (t === "重试" || t === "retry") return {};
  const m = t.match(/^(?:重试|retry)\s+(.+)$/);
  if (!m) return null;
  const ids = m[1]!.split(/\s+/).filter(Boolean);
  return ids.length > 0 ? { taskIds: ids } : {};
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
        await setSessionModel(agent, backend, s.sessionId, current.uid)
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
        const backend = connection.agent as ModelBackend;
        const current = modelManager.current(backend, s.sessionId);
        await setSessionModel(agent, backend, s.sessionId, current.uid)
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
          const backend = connection.agent as ModelBackend;
          const current = modelManager.current(backend, s.sessionId);
          await setSessionModel(agent, backend, s.sessionId, current.uid)
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
        const backend = connection.agent as ModelBackend;
        const current = modelManager.current(backend, sessionId);
        setSessionModel(agent, backend, sessionId, current.uid)
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
    case "room.flow.cancel": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      await roomModeManager.cancelActive(roomId, "用户取消编排");
      persistState();
      return { cancelled: true };
    }
    case "room.retryTasks": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const rawIds = req.params?.taskIds;
      const taskIds = Array.isArray(rawIds)
        ? (rawIds as unknown[]).map((s) => String(s)).filter(Boolean)
        : undefined;
      const retried = roomModeManager.retryFailedTasks(roomId, taskIds);
      persistState();
      return { retried };
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
      // L0 横切：按 policy.requirements.mode 决定是否阻断
      const l0 = await runL0Intercept({
        text: historyText,
        source: "room",
        correlationId: `room-${roomId}-${Date.now()}`,
        mode: room.mode,
        roomId,
        content,
        ...(quote !== undefined ? { quote } : {}),
      });
      if (!l0.proceed) return { sent: [], skipped: [] };
      // 重试指令拦截：awaiting-retry 的 flow 优先处理，不进入 cancelActive
      const retryMatch = parseRetryCommand(historyText);
      if (retryMatch && roomModeManager.hasAwaitingRetry(roomId)) {
        const retried = roomModeManager.retryFailedTasks(roomId, retryMatch.taskIds);
        if (retried) {
          persistState();
          return { sent: [], skipped: [] };
        }
      }
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

      // L0 横切：按 policy.requirements.mode 决定是否阻断
      const l0 = await runL0Intercept({
        text: historyText,
        source: "session",
        correlationId: `session-${sessionId}-${Date.now()}`,
        sessionId,
        content: promptContent,
      });
      if (!l0.proceed) return { accepted: true };

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
    case "elicitation.respond": {
      const requestId = String(req.params?.requestId ?? "");
      const action = String(req.params?.action ?? "");
      if (action !== "accept" && action !== "decline" && action !== "cancel") {
        throw new Error(`invalid elicitation action: ${action}`);
      }
      const content =
        req.params?.content && typeof req.params.content === "object"
          ? (req.params.content as Record<string, ElicitationValue>)
          : undefined;
      const ok = [...agents.values()].some((a) =>
        a.respondElicitation(requestId, action, content),
      );
      if (!ok) throw new Error("unknown or expired elicitation request");
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
          await setSessionModel(agent, model.backend, targetSessionId, model.uid);
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
          setSessionModel(agent, model.backend, sessionId, model.uid).catch((err) => {
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
    case "quality.project.delete": {
      const id = String(req.params?.id ?? "");
      const deleted = qualityService.deleteProject(id);
      return { deleted };
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
      const project = qualityService.getProject(id);
      if (!project) throw new Error(`unknown project: ${id}`);
      const loaded = qualityService.loadPolicyWithVersion(id);
      return {
        policy: loaded.policy ?? defaultObservePolicy(),
        version: loaded.version,
        source: loaded.source,
        errors: loaded.errors,
      };
    }
    case "quality.policy.ensure": {
      const id = String(req.params?.projectId ?? "");
      return qualityService.ensurePolicy(id);
    }
    case "quality.policy.update": {
      const id = String(req.params?.projectId ?? "");
      const project = qualityService.getProject(id);
      if (!project) throw new Error(`unknown project: ${id}`);
      const policy = req.params?.policy as QualityPolicyV2;
      if (!policy || policy.version !== 2) throw new Error("policy must be a v2 object");
      const errors = validatePolicyV2(policy, project);
      if (errors.length > 0) throw new Error(`policy validation failed:\n  - ${errors.join("\n  - ")}`);
      const filePath = writePolicyV2(project, policy);
      return { path: filePath, policy };
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
        ...(p.workItemId !== undefined ? { workItemId: String(p.workItemId) } : {}),
        ...(p.generation !== undefined ? { generation: Number(p.generation) } : {}),
        budget: {
          maxFixRounds: Number(p.maxFixRounds ?? 2),
          timeoutMs: Number(p.timeoutMs ?? 60000),
        },
      });
      try {
        qualityService.advance(run.id, "preflight");
        qualityService.advance(run.id, "implementing");
        qualityService.advance(run.id, "collecting");
        qualityService.advance(run.id, "quick-verifying");
      } catch (err) {
        logError("quality.run.start auto-advance", `run ${run.id} failed: ${String(err)}`);
      }
      return { run };
    }
    case "quality.run.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { runs: qualityService.listRuns(projectId, limit) };
    }
    case "quality.run.listBySession": {
      const sessionId = String(req.params?.sessionId ?? "");
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { runs: qualityService.listRunsBySession(sessionId, limit) };
    }
    case "quality.run.get": {
      const id = String(req.params?.id ?? "");
      const run = qualityService.getRun(id);
      if (!run) throw new Error(`unknown run: ${id}`);
      const checks = qualityService.listChecks(id);
      const findings = qualityService.listFindings(id);
      const verifications = qualityService.listVerifications(id);
      return { run, checks, findings, verifications };
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
    case "quality.run.delete": {
      const id = String(req.params?.id ?? "");
      const deleted = qualityService.deleteRun(id);
      return { deleted };
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
    // ── Phase 3 L0：需求质量门 RPC ────────────────────────────────────
    case "requirement.classify": {
      const text = String(req.params?.text ?? "");
      const intent = qualityService.classifyRequestIntent(text);
      return { intent };
    }
    case "requirement.evaluate": {
      const text = String(req.params?.text ?? "");
      const source = String(req.params?.source ?? "room") as "room" | "session" | "scheduler" | "incident" | "manual";
      const correlationId = String(req.params?.correlationId ?? `corr-${Date.now()}`);
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const roomId = req.params?.roomId !== undefined ? String(req.params.roomId) : undefined;
      const sessionId = req.params?.sessionId !== undefined ? String(req.params.sessionId) : undefined;
      const l0Mode = (req.params?.l0Mode as "shadow" | "suggest" | "require" | undefined) ?? "shadow";
      const result = await qualityService.handleL0Request({
        text, source, correlationId,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(roomId !== undefined ? { roomId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        l0Mode,
      });
      if (result.clarificationRequest) {
        broadcast({
          method: "requirement.clarificationRequired",
          params: {
            requestId: result.request.id,
            clarificationRequestId: result.clarificationRequest.id,
            specId: result.clarificationRequest.specId,
            specVersion: result.clarificationRequest.specVersion,
            questions: result.clarificationRequest.questions,
            canSkip: result.clarificationRequest.canSkip,
            expiresAt: result.clarificationRequest.expiresAt ?? null,
          },
        } as HubEvent);
      }
      return result;
    }
    case "requirement.clarificationAnswer": {
      const clarificationRequestId = String(req.params?.clarificationRequestId ?? "");
      const answers = (req.params?.answers as Array<{ questionId: string; answer: string }>) ?? [];
      const result = qualityService.answerClarification({ clarificationRequestId, answers });
      if (!result) throw new Error("clarification not found, already resolved, or expired");
      broadcast({
        method: "requirement.clarificationAnswer",
        params: { clarificationRequestId, specId: result.spec.id, specVersion: result.spec.version },
      } as HubEvent);
      broadcast({
        method: "requirement.specUpdate",
        params: { requestId: result.request.id, specId: result.spec.id, specVersion: result.spec.version, status: result.spec.status },
      } as HubEvent);
      resumeSuspendedPrompt(result.request.id);
      return { spec: result.spec, request: result.request };
    }
    case "requirement.clarificationSkip": {
      const clarificationRequestId = String(req.params?.clarificationRequestId ?? "");
      const result = qualityService.skipClarification(clarificationRequestId);
      if (!result) throw new Error("clarification not found or already resolved");
      broadcast({
        method: "requirement.clarificationSkip",
        params: { clarificationRequestId, specId: result.spec.id, specVersion: result.spec.version },
      } as HubEvent);
      broadcast({
        method: "requirement.specUpdate",
        params: { requestId: result.request.id, specId: result.spec.id, specVersion: result.spec.version, status: result.spec.status },
      } as HubEvent);
      resumeSuspendedPrompt(result.request.id);
      return { spec: result.spec, request: result.request };
    }
    case "requirement.clarificationCancel": {
      const clarificationRequestId = String(req.params?.clarificationRequestId ?? "");
      const result = qualityService.cancelClarification(clarificationRequestId);
      if (!result) throw new Error("clarification not found");
      broadcast({
        method: "requirement.specUpdate",
        params: { requestId: result.request.id, specId: result.spec.id, specVersion: result.spec.version, status: result.spec.status },
      } as HubEvent);
      return { spec: result.spec, request: result.request };
    }
    case "requirement.clarificationList": {
      const requestId = req.params?.requestId !== undefined ? String(req.params.requestId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { clarifications: qualityService.listClarificationRequests(requestId, limit) };
    }
    case "requirement.specList": {
      const requestId = String(req.params?.requestId ?? "");
      return { specs: qualityService.listRequirementSpecs(requestId) };
    }
    case "requirement.specGet": {
      const id = String(req.params?.id ?? "");
      const spec = qualityService.getRequirementSpec(id);
      if (!spec) throw new Error(`unknown spec: ${id}`);
      return { spec };
    }
    case "requirement.specUpdate": {
      const id = String(req.params?.id ?? "");
      const patch = req.params ?? {};
      const goalChanged = patch.goal !== undefined;
      const criteriaSupplied = patch.acceptanceCriteria !== undefined;
      // 解析 spec 所属项目，用于 goal 变更时自动重新生成 acceptanceCriteria
      let projectId: string | undefined;
      if (goalChanged && !criteriaSupplied) {
        const spec = qualityService.getRequirementSpec(id);
        if (spec) {
          const request = qualityService.getWorkRequest(spec.requestId);
          const scope = request ? resolveProjectForL0({
            source: "room",
            ...(request.roomId !== undefined ? { roomId: request.roomId } : {}),
            ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
          }) : undefined;
          projectId = scope?.id;
        }
      }
      const updated = qualityService.updateRequirementSpec(id, {
        ...(patch.goal !== undefined ? { goal: String(patch.goal) } : {}),
        ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: patch.acceptanceCriteria as any } : {}),
        ...(patch.constraints !== undefined ? { constraints: patch.constraints as string[] } : {}),
        ...(patch.status !== undefined ? { status: String(patch.status) as any } : {}),
      }, { regenerateCriteria: goalChanged && !criteriaSupplied, ...(projectId !== undefined ? { projectId } : {}) });
      if (!updated) throw new Error(`unknown spec: ${id}`);
      broadcast({ method: "requirement.specUpdate", params: { specId: updated.id, specVersion: updated.version, status: updated.status } } as HubEvent);
      return { spec: updated };
    }
    case "requirement.workRequestList": {
      const roomId = req.params?.roomId !== undefined ? String(req.params.roomId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { requests: qualityService.listWorkRequests(roomId, limit) };
    }
    case "quality.work.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { items: qualityService.listWorkItems(projectId, limit) };
    }
    case "quality.work.create": {
      const requestId = String(req.params?.requestId ?? "");
      const projectId = String(req.params?.projectId ?? "");
      const mode = String(req.params?.mode ?? "mention");
      const kind = req.params?.kind !== undefined ? String(req.params.kind) : undefined;
      const specId = req.params?.specId !== undefined ? String(req.params.specId) : undefined;
      const specVersion = req.params?.specVersion !== undefined ? Number(req.params.specVersion) : undefined;
      const roomId = req.params?.roomId !== undefined ? String(req.params.roomId) : undefined;
      const taskId = req.params?.taskId !== undefined ? String(req.params.taskId) : undefined;
      const sessionId = req.params?.sessionId !== undefined ? String(req.params.sessionId) : undefined;
      const item = qualityService.createWorkItem({
        requestId, projectId, mode,
        ...(kind !== undefined ? { kind: kind as "implementation" | "verification-only" | "remediation" } : {}),
        ...(specId !== undefined ? { specId } : {}),
        ...(specVersion !== undefined ? { specVersion } : {}),
        ...(roomId !== undefined ? { roomId } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return { workItem: item };
    }
    // ── Phase 4 L3：需求验证门 RPC ────────────────────────────────────
    case "quality.verification.run": {
      const runId = String(req.params?.runId ?? "");
      const specId = String(req.params?.specId ?? "");
      const runtimeEvidence = req.params?.runtimeEvidence as { description: string; artifactRef?: string }[] | undefined;
      const manualEvidence = req.params?.manualEvidence as { instruction: string; verifier: string; artifactRef?: string }[] | undefined;
      const aiInference = req.params?.aiInference as { verifier: string; confidence: number; reasoning: string; expectationId: string }[] | undefined;
      const waivers = req.params?.waivers as { criterionId: string; reason: string }[] | undefined;
      const result = qualityService.runVerification({
        runId, specId,
        ...(runtimeEvidence !== undefined ? { runtimeEvidence } : {}),
        ...(manualEvidence !== undefined ? { manualEvidence } : {}),
        ...(aiInference !== undefined ? { aiInference } : {}),
        ...(waivers !== undefined ? { waivers } : {}),
      });
      if (!result) throw new Error(`verification failed: run ${runId} or spec ${specId} not found`);
      return result;
    }
    case "quality.verification.list": {
      const runId = String(req.params?.runId ?? "");
      return { verifications: qualityService.listVerifications(runId) };
    }
    case "quality.verification.waive": {
      const runId = String(req.params?.runId ?? "");
      const criterionId = String(req.params?.criterionId ?? "");
      const reason = String(req.params?.reason ?? "");
      const result = qualityService.waiveCriterion(runId, criterionId, reason);
      if (!result) throw new Error(`criterion ${criterionId} not found for run ${runId}`);
      return { verification: result };
    }
    // ── Phase 5 L4：受控学习 RPC ─────────────────────────────────────
    case "quality.observation.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { observations: qualityService.listObservations(projectId, limit) };
    }
    case "quality.metric.list": {
      const projectId = String(req.params?.projectId ?? "");
      const kind = req.params?.kind !== undefined ? String(req.params.kind) : undefined;
      const limit = req.params?.limit !== undefined ? Number(req.params.limit) : undefined;
      return { metrics: qualityService.listMetrics(projectId, kind, limit) };
    }
    case "quality.observation.create": {
      const projectId = String(req.params?.projectId ?? "");
      const kind = String(req.params?.kind ?? "") as "check-failure" | "infra-failure" | "finding" | "verification-gap" | "user-feedback" | "contamination";
      const attribution = String(req.params?.attribution ?? "unknown") as "candidate" | "baseline" | "infrastructure" | "unknown";
      const runId = req.params?.runId !== undefined ? String(req.params.runId) : undefined;
      const workItemId = req.params?.workItemId !== undefined ? String(req.params.workItemId) : undefined;
      const fingerprint = req.params?.fingerprint !== undefined ? String(req.params.fingerprint) : undefined;
      const evidenceRefs = (req.params?.evidenceRefs as string[]) ?? [];
      const obs = qualityService.createObservation({
        projectId, kind, attribution,
        ...(runId !== undefined ? { runId } : {}),
        ...(workItemId !== undefined ? { workItemId } : {}),
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        evidenceRefs,
      });
      return { observation: obs };
    }
    case "quality.observation.confirm": {
      const id = String(req.params?.id ?? "");
      const result = qualityService.confirmObservation(id);
      if (!result) throw new Error(`observation ${id} not found`);
      return { observation: result };
    }
    case "quality.observation.confirmToIncident": {
      const id = String(req.params?.id ?? "");
      const confirmedBy = String(req.params?.confirmedBy ?? "user");
      const result = qualityService.confirmObservationToIncident(id, confirmedBy);
      if (!result) throw new Error(`observation ${id} not found or not candidate`);
      return result;
    }
    case "quality.observation.dismiss": {
      const id = String(req.params?.id ?? "");
      const result = qualityService.dismissObservation(id);
      if (!result) throw new Error(`observation ${id} not found`);
      return { observation: result };
    }
    case "quality.rule.createTyped": {
      const projectId = String(req.params?.projectId ?? "");
      const ruleType = String(req.params?.ruleType ?? "") as "check" | "risk" | "requirement" | "verification";
      const ruleDefinition = req.params?.ruleDefinition as unknown;
      const evidenceIncidentIds = (req.params?.evidenceIncidentIds as string[]) ?? [];
      const measuredImpact = req.params?.measuredImpact !== undefined ? String(req.params.measuredImpact) : undefined;
      const candidate = qualityService.createTypedRule({
        projectId, ruleType, ruleDefinition: ruleDefinition as never,
        evidenceIncidentIds,
        ...(measuredImpact !== undefined ? { measuredImpact } : {}),
      });
      return { rule: candidate };
    }
    case "quality.rule.approve": {
      const id = String(req.params?.id ?? "");
      const approvedBy = String(req.params?.approvedBy ?? "user");
      const result = qualityService.approveRule(id, approvedBy);
      return { rule: result };
    }
    case "quality.rule.activateShadow": {
      const id = String(req.params?.id ?? "");
      const activatedBy = String(req.params?.activatedBy ?? "user");
      const control = qualityService.activateRuleAsShadow(id, activatedBy);
      return { control };
    }
    case "quality.control.promote": {
      const controlId = String(req.params?.controlId ?? "");
      const activatedBy = String(req.params?.activatedBy ?? "user");
      const result = qualityService.promoteShadowControl(controlId, activatedBy);
      if (!result) throw new Error(`control ${controlId} not found`);
      return { control: result };
    }
    case "quality.control.retire": {
      const controlId = String(req.params?.controlId ?? "");
      const retiredBy = String(req.params?.retiredBy ?? "user");
      const reason = String(req.params?.reason ?? "");
      const result = qualityService.retireControl(controlId, retiredBy, reason);
      if (!result) throw new Error(`control ${controlId} not found`);
      return { control: result };
    }
    case "quality.control.list": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      const includeShadow = req.params?.includeShadow === true;
      return { controls: qualityService.listActiveControls(projectId, includeShadow) };
    }
    case "quality.control.listShadow": {
      const projectId = req.params?.projectId !== undefined ? String(req.params.projectId) : undefined;
      return { controls: qualityService.listShadowControls(projectId) };
    }
    case "quality.policy.exportPatch": {
      const projectId = String(req.params?.projectId ?? "");
      const ruleCandidateId = String(req.params?.ruleCandidateId ?? "");
      const ruleType = String(req.params?.ruleType ?? "") as "check" | "risk" | "requirement" | "verification";
      const ruleDefinition = req.params?.ruleDefinition as unknown;
      const exportedBy = String(req.params?.exportedBy ?? "user");
      const patch = qualityService.generateExportPatch({
        projectId, ruleCandidateId, ruleType,
        rule: ruleDefinition as never,
        exportedBy,
      });
      return { patch };
    }
    case "quality.policy.verifyPatch": {
      const patch = req.params?.patch as unknown;
      const projectId = String(req.params?.projectId ?? "");
      const result = qualityService.verifyExportPatch(patch as never, projectId);
      return result;
    }
    case "quality.rule.evaluateSandbox": {
      const ruleCandidateId = String(req.params?.ruleCandidateId ?? "");
      const passed = req.params?.passed === true;
      const checksTotal = Number(req.params?.checksTotal ?? 0);
      const checksPassed = Number(req.params?.checksPassed ?? 0);
      const checksFailed = Number(req.params?.checksFailed ?? 0);
      const checkSummaries = (req.params?.checkSummaries as string[]) ?? [];
      const falsePositiveRate = req.params?.falsePositiveRate !== undefined ? Number(req.params.falsePositiveRate) : undefined;
      const reason = String(req.params?.reason ?? "");
      const result = qualityService.evaluateRuleInSandbox({
        ruleCandidateId, passed, checksTotal, checksPassed, checksFailed,
        checkSummaries,
        ...(falsePositiveRate !== undefined ? { falsePositiveRate } : {}),
        reason,
      });
      return { evaluation: result };
    }
    case "quality.rule.recordSandbox": {
      const ruleId = String(req.params?.ruleId ?? "");
      const result = req.params?.result as unknown;
      const updated = qualityService.recordSandboxEvaluation(ruleId, result as never);
      if (!updated) throw new Error(`rule ${ruleId} not found`);
      return { rule: updated };
    }
    case "quality.policy.migrate": {
      const projectId = String(req.params?.projectId ?? "");
      const expectedOldHash = req.params?.expectedOldHash !== undefined ? String(req.params.expectedOldHash) : undefined;
      const result = qualityService.migratePolicyToV2(projectId, expectedOldHash);
      if (!result.ok) throw new Error(`migration failed: ${result.errors.join(", ")}`);
      return result;
    }
    // ── Phase 6：review 协作提示 RPC ─────────────────────────────────
    case "quality.review.promptResponse": {
      const runId = String(req.params?.runId ?? "");
      const action = String(req.params?.action ?? "");
      const timer = reviewPromptFallbacks.get(runId);
      if (timer) {
        clearTimeout(timer);
        reviewPromptFallbacks.delete(runId);
      }
      const run = qualityService.getRun(runId);
      if (!run) throw new Error(`unknown run: ${runId}`);
      if (run.stage !== "reviewing") throw new Error(`run ${runId} not in reviewing stage`);
      if (!run.reviewPromptedAt || run.reviewPromptAction !== "pending") {
        throw new Error(`run ${runId} has no pending review prompt`);
      }

      if (action === "skip") {
        const next = qualityService.advance(runId, "full-verifying");
        return { run: next };
      }

      if (action === "create-review-room") {
        if (!run.implementerSessionId) throw new Error(`run ${runId} has no implementerSessionId`);
        const project = qualityService.getProject(run.projectId);
        if (!project) throw new Error(`unknown project: ${run.projectId}`);

        // 创建 reviewer session
        const reviewerSessionId = await reviewerSessionRunner.ensureSession({ project, run });

        // 构建 room 成员
        const implementerMeta = sessionMetas.get(run.implementerSessionId);
        const members: { sessionId: string; name: string }[] = [
          { sessionId: run.implementerSessionId, name: implementerMeta?.name ?? "implementer" },
          { sessionId: reviewerSessionId, name: "reviewer" },
        ];

        // 可选：把用户的 client session 也加入
        const userSessionId = typeof req.params?.userSessionId === "string" ? req.params.userSessionId : undefined;
        if (userSessionId && userSessionId !== run.implementerSessionId) {
          const userMeta = sessionMetas.get(userSessionId);
          members.push({ sessionId: userSessionId, name: userMeta?.name ?? "我" });
        }

        const roomName = `🔍 审查: ${path.basename(project.root)} #${run.id.slice(0, 6)}`;
        const room = rooms.create(roomName, members, "roundrobin");
        persistState();

        const updated: QualityRun = {
          ...run,
          roomId: room.roomId,
          reviewRoomId: room.roomId,
          reviewerSessionId,
          reviewPromptAction: "proceed",
        };
        qualityService.saveRun(updated);

        await ensureReviewOrchestrator().runReview(runId);
        return { run: qualityService.getRun(runId), room: enrichRoom(room) };
      }

      if (action === "add-reviewer") {
        if (!run.roomId) throw new Error(`run ${runId} has no roomId`);
        if (!run.implementerSessionId) throw new Error(`run ${runId} has no implementerSessionId`);
        const project = qualityService.getProject(run.projectId);
        if (!project) throw new Error(`unknown project: ${run.projectId}`);

        const reviewerSessionId = await reviewerSessionRunner.ensureSession({ project, run });
        rooms.addMember(run.roomId, reviewerSessionId, "reviewer");
        persistState();

        const updated: QualityRun = {
          ...run,
          reviewerSessionId,
          reviewPromptAction: "proceed",
        };
        qualityService.saveRun(updated);

        await ensureReviewOrchestrator().runReview(runId);
        return { run: qualityService.getRun(runId) };
      }

      // use-session / no-reviewer / proceed：直接在当前上下文继续 review
      if (["use-session", "no-reviewer", "proceed"].includes(action)) {
        const updated: QualityRun = { ...run, reviewPromptAction: "proceed" };
        qualityService.saveRun(updated);
        await ensureReviewOrchestrator().runReview(runId);
        return { run: qualityService.getRun(runId) };
      }

      throw new Error(`unknown review prompt action: ${action}`);
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
    autoRegisterProject(connection);
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
    const announceCwd = typeof (msg as Record<string, unknown>).cwd === "string" ? (msg as Record<string, unknown>).cwd as string : undefined;
    console.log(`[hub] multiplex announce: ${channels.map(c => `${c.id}(${c.agent})`).join(", ")} from ${hostname}${announceCwd ? ` cwd=${announceCwd}` : ""}`);

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
          ...(announceCwd ? { cwd: announceCwd } : {}),
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
        autoRegisterProject(virtualConn);
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
  autoRegisterAllProjects();
  for (const addr of addrs) {
    console.log(`[hub] phone connect: ws://${addr}:${PORT}/?token=${TOKEN}`);
    console.log(`[hub] worker connect: ws://${addr}:${PORT}${WORKER_PATH}?token=<CONNECTION_TOKEN>`);
  }
  if (process.env.HUB_TUNNEL === "1") {
    startTunnel(PORT, TOKEN);
  }
});
