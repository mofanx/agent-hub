import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
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
import { RoomManager, dedupeName, remapRoomModeConfig, normalizePersonaValue, parseAliasesParam, parseMemberRolesParam, serializePersonaCard, type Room, type RoomMode, type RoomModeConfig, type EventAction } from "./room.js";
import { helpAnswerIntent, RoomModeManager } from "./room-modes.js";
import type { AgentOps } from "./room-modes.js";
import { Store, lostReplyAction, type SessionMeta, type Connection } from "./store.js";
import { SessionLedger } from "./session-ledger.js";
import { extractTaskResult, parseIsolatedChecks, runIsolatedCheck } from "./conductor.js";
import { startTunnel } from "./tunnel.js";
import { webSocketStream, multiplexWebSocketStream, isControlFrame, isAnnounceFrame, type ControlFrame } from "./stream.js";
import { startPerfMonitor } from "./monitor.js";
import { AGENT_DEFS, spawnAgentProcess } from "./agent-defs.js";
import { ModelManager, type ModelInfo, type BackendConfig, type ModelBackend } from "./model.js";
import {
  getDevinQuota,
  validateQuotaReport,
  validateReportedQuota,
  recordQuotaReport,
  quotaFor,
  clearQuotaReports,
  type ReportedQuota,
} from "./quota.js";
import { logError, logWarn } from "./logger.js";
import { discoverSkills } from "./skills.js";
import {
  parseSlash,
  SESSION_MODES,
  HUB_SLASH_COMMANDS,
  handleSessionModeSlash,
  handleRoomModeSlash,
  type SlashCmd,
  type ModeSlashDeps,
} from "./slash.js";
import { Scheduler, parseSchedule, type ScheduledTask, type TaskLog } from "./scheduler.js";
import { buildProcessMeta, newProcessId, TurnProcessRecorder, type ProcessCardMeta } from "./process-log.js";
import { OperationLedger, dedupInflight } from "./op-ledger.js";
import { runClientMessage, clientMessageStatus, clientMessageFlowState } from "./client-messages.js";
import { DecisionCenter, sweepPendingDecisions, inferOptionScope, isRejectOption, type DecisionScope, type DecisionRequestParams } from "./decision.js";
import { RelevanceFilter } from "./filter.js";
import { presenceEvents, type PresenceStatus } from "./presence.js";
import { makeFlowCardSync, sweepOrphanFlowCards as sweepOrphanFlowCardsImpl } from "./flow-card.js";
import { MissionManager } from "./mission.js";
import { missionTemplateFrom, runMissionTask, parseEventTrigger, EventWakeBook, SilentReproBook, buildSilentReproPrompt } from "./mission-schedule.js";
import { shouldDeliver, type ClientSub } from "./subscribe.js";
import { NtfyPusher, ntfyConfigFromEnv, type NtfyKind } from "./ntfy.js";
import { wakeGateAllows, WakeGateStats } from "./wake-gate.js";
import {
  ifcCheckRoomRead,
  ifcCheckSensitiveWrite,
  parseSensitivity,
  type IfcRule,
} from "./ifc.js";
import { buildConnectUri, buildConnectInfo, lanIps, setGatewayInfo, getGatewayInfo, validateGatewayAnnounce, workerJoinCommand } from "./connect.js";

const PORT = Number(process.env.HUB_PORT ?? 8787);
const TOKEN = process.env.HUB_TOKEN ?? "dev-token";
if (!TOKEN.trim() || TOKEN !== TOKEN.trim() || /^(?:CHANGE_ME(?:_|$)|replace[-_ ]me(?:_|$))/i.test(TOKEN)) {
  throw new Error("Set HUB_TOKEN to a non-placeholder secret before starting the Hub");
}
const LOCAL_ONLY = TOKEN === "dev-token";
if (LOCAL_ONLY && (process.env.NODE_ENV === "production" || process.env.HUB_TUNNEL === "1")) {
  throw new Error("Set a private HUB_TOKEN for production or tunnel access");
}
const WORKER_PATH = "/worker";

function setSessionModel(
  agent: AcpAgent,
  _backend: ModelBackend,
  sessionId: string,
  model: string,
): Promise<void> {
  return agent.setConfigOption(sessionId, "model", model);
}

const DEVIN_DEFAULT_CONFIG: Record<string, string> = { mode: "bypass" };

/** resume/clone 后重新应用保存的非模型 config 偏好（thought_level/mode 等）；devin 缺省 mode=bypass，会话级偏好优先 */
async function syncSessionConfigPrefs(agent: AcpAgent, sessionId: string, backend?: ModelBackend): Promise<void> {
  const defaults = backend === "devin" ? DEVIN_DEFAULT_CONFIG : {};
  const backendPrefs = backend ? modelManager.backendConfig(backend) : {};
  const prefs = { ...defaults, ...backendPrefs, ...modelManager.sessionConfig(sessionId) };
  for (const [configId, value] of Object.entries(prefs)) {
    await agent
      .setConfigOption(sessionId, configId, value)
      .catch((err) => logWarn("session.config", `sync ${configId} failed: ${String(err)}`));
  }
}

if (TOKEN === "dev-token") {
  logWarn("config", "development token: loopback only; set a private HUB_TOKEN for remote access");
}

const clients = new Set<WebSocket>();
const rooms = new RoomManager();
const agents = new Map<string, AcpAgent>();
const owners = new Map<string, string>();
const localStarts = new Map<string, Promise<void>>();
/** session.resume 按 sessionId 去重：并发/重试调用复用同一 Promise，防重复创建幽灵会话 */
const sessionResumes = new Map<string, Promise<unknown>>();
const localAgentErrors = new Map<string, string>();
const store = new Store();
let hubId = store.getMeta("hubIdentity");
if (!hubId) {
  hubId = randomBytes(16).toString("hex");
  store.setMeta("hubIdentity", hubId);
}
const modelManager = new ModelManager();




rooms.setRoleResolver((roleId) => store.listRoles().find((r) => r.id === roleId)?.persona);
rooms.setStore(store);
ensureDefaultLocalConnections();
const savedState = store.load();
const savedRuntime = savedState.runtime;
const sessionMetas = new Map<string, SessionMeta>(
  savedState.sessions.map((s) => [s.sessionId, s]),
);
const sessionLedger = new SessionLedger();
sessionLedger.importFromMeta(savedState.sessions);
rooms.setCwdResolver((sessionId) => sessionMetas.get(sessionId)?.cwd);
// 成员通道判定：connection.local → local；非本地 connection / 带 address 的远端会话 → remote；其余默认 local
rooms.setMemberChannelResolver((sessionId) => {
  const meta = sessionMetas.get(sessionId);
  const connection = getConnectionById(meta?.connectionId ?? undefined);
  return {
    agent: meta?.agent ?? connection?.agent,
    origin: connection
      ? connection.local
        ? "local"
        : "remote"
      : meta?.address
        ? "remote"
        : "local",
  };
});
for (const room of savedState.rooms) rooms.import(room);

const LOST_REPLY_PLACEHOLDER = "[Hub 重启导致上条回复未完整保存]";
const LOST_REPLY_NOTE = "上一条用户消息已处理，但回复因 Hub 重启未保存。请直接回答以下新消息，不要重复处理上一条：";

function sessionLostReplyNote(sessionId: string): string | undefined {
  const meta = sessionMetas.get(sessionId);
  const baseName = meta?.name ?? sessionId;
  const origin = originFor(meta);
  const displayName = origin ? `${baseName} (${origin})` : baseName;
  const entries = store.read("session", sessionId);
  const action = lostReplyAction(entries[entries.length - 1], LOST_REPLY_PLACEHOLDER, false);
  if (action === "append") {
    store.append("session", sessionId, {
      at: Date.now(),
      kind: "assistant",
      author: displayName,
      text: LOST_REPLY_PLACEHOLDER,
    });
    return LOST_REPLY_NOTE;
  }
  if (action === "repeat") return LOST_REPLY_NOTE;
  return undefined;
}

function roomLostReplyNote(roomId: string): string | undefined {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  const entries = store.read("room", roomId);
  const action = lostReplyAction(
    entries[entries.length - 1],
    LOST_REPLY_PLACEHOLDER,
    roomModeManager.hasActiveFlow(roomId),
  );
  if (action === "append") {
    store.append("room", roomId, {
      at: Date.now(),
      kind: "assistant",
      author: room.name,
      text: LOST_REPLY_PLACEHOLDER,
    });
    return LOST_REPLY_NOTE;
  }
  if (action === "repeat") return LOST_REPLY_NOTE;
  return undefined;
}

function repairHistoryAtStartup(): void {
  const interrupted = new Set(
    store.interruptReplyDrafts().map((s) => `${s.scope}:${s.id}`),
  );
  for (const [sessionId, meta] of sessionMetas) {
    if (interrupted.has(`session:${sessionId}`)) continue;
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
  // 重启前有未完成编排的房间会在运行时恢复后继续产出回复，跳过占位符以免误报
  const liveFlowRooms = new Set(
    (
      ((savedRuntime?.conductor as Record<string, unknown> | undefined)?.flows as
        | Record<string, unknown>[]
        | undefined) ?? []
    )
      .filter((f) => f.phase !== "done")
      .map((f) => String(f.roomId ?? "")),
  );
  for (const room of rooms.list()) {
    if (liveFlowRooms.has(room.roomId)) continue;
    if (interrupted.has(`room:${room.roomId}`)) continue;
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

function parseEventAction(raw: unknown): EventAction {
  const actions: EventAction[] = ["add", "modify", "delete", "rename", "command", "test", "decision", "filter"];
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
  if (params?.maxRounds != null) {
    const n = Number(params.maxRounds);
    if (Number.isFinite(n) && n > 0) config.maxRounds = Math.max(1, Math.min(64, Math.floor(n)));
  }
  const rf = params?.relevanceFilter;
  if (rf != null) {
    const on = !(rf === false || rf === "false" || rf === "off" || rf === "0" || rf === 0);
    config.relevanceFilter = on;
  }
  const roles = parseMemberRolesParam(params?.memberRoles, all);
  if (roles) config.memberRoles = roles;
  const aliases = parseAliasesParam(params?.aliases, all);
  if (aliases) config.aliases = aliases;
  return config;
}

function memberStatusOf(sessionId: string): PresenceStatus {
  const cid = owners.get(sessionId);
  const a = cid ? agents.get(cid) : undefined;
  if (!a || !a.isReady) return "offline";
  return a.isBusy(sessionId) ? "generating" : "online";
}

function emitMemberStatus(sessionId: string, status: PresenceStatus): void {
  const roomIds = rooms.roomsFor(sessionId).map((r) => r.roomId);
  for (const params of presenceEvents(sessionId, status, roomIds)) {
    broadcast({ method: "member.status", params } as HubEvent);
  }
}

function enrichRoom(room: Room): Record<string, unknown> {
  const sub = roomModeManager.subModeFor(room.roomId);
  return {
    ...room,
    members: room.members.map((m) => ({
      ...m,
      status: memberStatusOf(m.sessionId),
      quota: quotaFor({
        sessionId: m.sessionId,
        connectionId: sessionMetas.get(m.sessionId)?.connectionId,
      }),
    })),
    subMode: sub?.mode,
    sensitivity: store.ifcGet(room.roomId).sensitivity,
    activeSpeaker: sub?.activeSpeaker,
    reason: sub?.reason,
  };
}

const PERSIST_DEBOUNCE_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistStateNow(): void {
  store.save({
    sessions: sessionLedger.attachTo([...sessionMetas.values()]),
    rooms: rooms.list(),
    runtime: roomModeManager.exportRuntime(),
  });
}

/** 防抖合并持久化：高频路径（tool_call/file write/decision）500ms 内合并为一次全量写 */
function persistState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // 延迟写盘脱离请求调用栈：DB 错误在此抛出即 uncaughtException，必须就地收敛
    try {
      persistStateNow();
    } catch (err) {
      logError("persistState (deferred)", err);
    }
  }, PERSIST_DEBOUNCE_MS);
}

function flushPersistState(): void {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  try {
    persistStateNow();
  } catch (err) {
    logError("persistState (flush)", err);
  }
}

process.on("exit", flushPersistState);
process.on("SIGINT", () => {
  flushPersistState();
  process.exit(130);
});
process.on("SIGTERM", () => {
  flushPersistState();
  process.exit(143);
});

function isSessionNameTaken(name: string, excludeSessionId?: string): boolean {
  for (const meta of sessionMetas.values()) {
    if (meta.sessionId === excludeSessionId) continue;
    if (meta.archived) continue;
    if (meta.name === name) return true;
  }
  return false;
}

function isRoomNameTaken(name: string, excludeRoomId?: string): boolean {
  return rooms.nameTaken(name, excludeRoomId);
}

const dedupeSessionName = (name: string, excludeSessionId?: string) =>
  dedupeName(name, (n) => isSessionNameTaken(n, excludeSessionId));
const dedupeRoomName = (name: string, excludeRoomId?: string) =>
  dedupeName(name, (n) => isRoomNameTaken(n, excludeRoomId));

async function cloneSessionWithName(
  source: SessionMeta,
  targetName: string,
  opts?: { fresh?: boolean },
): Promise<{ sessionId: string; name: string }> {
  const connectionId = source.connectionId;
  if (!connectionId) throw new Error("source session has no connection");
  const connection = getConnectionById(connectionId);
  if (!connection) throw new Error(`unknown connection: ${connectionId}`);
  if (connection.local) await ensureLocalAgent(connection);
  const agent = agents.get(connection.id);
  if (!agent) throw new Error("agent 未连接");

  // 始终 createSession 新建（不走 cloneSession/session.fork——fork 会把旧上下文搬进新会话）
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
  emitMemberStatus(s.sessionId, "online");
  persistState();

  // fresh（群聊重置）：继承模型偏好与非模型 config（thought_level/mode 等），不继承对话内容
  if (opts?.fresh && connection.agent) {
    const backend = connection.agent as ModelBackend;
    modelManager.copySessionPreference(source.sessionId, s.sessionId);
    modelManager.copySessionConfig(source.sessionId, s.sessionId);
    const current = modelManager.current(backend, source.sessionId);
    await setSessionModel(agent, backend, s.sessionId, current.uid).catch((err) =>
      logWarn("room.clone", `sync model failed: ${String(err)}`),
    );
    await syncSessionConfigPrefs(agent, s.sessionId, backend);
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
  return s;
}

function ensureDefaultLocalConnections(): void {
  const existing = store.listConnections();
  let created = false;
  for (const agent of Object.keys(AGENT_DEFS)) {
    const id = `local-${agent}`;
    const conn = existing.find((c) => c.id === id);
    if (conn) {
      // 迁移旧命名："本地 x" 前缀与客户端 local 徽章重复
      if (conn.local && conn.name === `本地 ${agent}`) {
        store.updateConnection(id, { name: agent });
      }
      continue;
    }
    store.addConnection({
      id,
      name: agent,
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
    if (cid === connectionId) {
      owners.delete(sid);
      emitMemberStatus(sid, "offline");
    }
  }
}

async function startLocalAgent(connection: Connection): Promise<void> {
  const def = AGENT_DEFS[connection.agent];
  if (!def) throw new Error(`unknown agent type: ${connection.agent}`);
  localAgentErrors.delete(connection.id);

  const proc = spawnAgentProcess(def);
  // 只留尾部 ~8KB 供退出诊断：agent stderr（如 devin INFO 日志）长期累积会撑爆堆
  const STDERR_TAIL_BYTES = 8 * 1024;
  const stderrTail: Buffer[] = [];
  let stderrTailLen = 0;
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk);
    stderrTailLen += chunk.length;
    while (stderrTailLen > STDERR_TAIL_BYTES && stderrTail.length > 1) {
      stderrTailLen -= stderrTail[0]!.length;
      stderrTail.shift();
    }
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
    connection.agent === "devin",
    onTurnProgress,
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
        const lastErr = Buffer.concat(stderrTail)
          .toString("utf-8")
          .slice(-STDERR_TAIL_BYTES)
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

async function resumeSessionById(sessionId: string) {
  const meta = sessionMetas.get(sessionId);
  if (!meta) throw new Error(`unknown session: ${sessionId}`);
  const ownerAgent = agents.get(owners.get(sessionId) ?? "");
  if (ownerAgent?.listSessions().some((s) => s.sessionId === sessionId)) {
    return { resumed: true, already: true };
  }
  owners.delete(sessionId);
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

    // 重建 session 时继承旧会话的模型与 config 偏好
    modelManager.copySessionPreference(sessionId, s.sessionId);
    modelManager.copySessionConfig(sessionId, s.sessionId);
    if (connection?.agent) {
      const backend = connection.agent as ModelBackend;
      const current = modelManager.current(backend, s.sessionId);
      await setSessionModel(agent, backend, s.sessionId, current.uid)
        .catch((err) => logWarn("session.resume", `sync model failed: ${String(err)}`));
      await syncSessionConfigPrefs(agent, s.sessionId, backend);
    }

    if (hasHistory) {
      store.renameHistory("session", sessionId, s.sessionId);
    }
    sessionMetas.delete(sessionId);
    owners.delete(sessionId);
    const newMeta = { ...meta, sessionId: s.sessionId, name: s.name };
    sessionMetas.set(s.sessionId, newMeta);
    owners.set(s.sessionId, connectionId);
    emitMemberStatus(s.sessionId, "online");
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
  emitMemberStatus(sessionId, "online");

  // 恢复 session 时同步对应后端的当前模型与 config 偏好
  if (connection?.agent) {
    const backend = connection.agent as ModelBackend;
    const current = modelManager.current(backend, sessionId);
    setSessionModel(agent, backend, sessionId, current.uid)
      .catch((err) => logWarn("session.resume", `sync model failed: ${String(err)}`));
    syncSessionConfigPrefs(agent, sessionId, backend)
      .catch((err) => logWarn("session.resume", `sync config failed: ${String(err)}`));
  }

  return { resumed: true };
}

const agentOps: AgentOps = {
  prompt: async (sessionId, content) => {
    // async 包装：ownerOf 的同步 throw（agent 未连接）转为 rejected promise，
    // 使 sendPrompt/.catch 兜底可挂——否则同步逃逸导致 autoDecisions/turnGuards 悬挂
    const agent = ownerOf(sessionId);
    if (typeof content === "string") return agent.prompt(sessionId, content);
    return agent.promptContent(sessionId, content);
  },
  isBusy: (sessionId) => {
    try {
      return ownerOf(sessionId).isBusy(sessionId);
    } catch {
      return false; // 会话已被删除或 owner 未连接：视为不忙
    }
  },
  has: (sessionId) => sessionMetas.has(sessionId),
  cancel: (sessionId) => ownerOf(sessionId).cancel(sessionId),
  cwd: (sessionId) => sessionMetas.get(sessionId)?.cwd,
  runIsolatedCheck,
};
const roomModeManager = new RoomModeManager(
  agentOps,
  rooms,
  (method, params) => {
    const p = params as Record<string, unknown>;
    if (method === "room.notice") {
      broadcastRoomNotice(String(p.roomId ?? ""), String(p.message ?? ""), p.meta);
      return;
    }
    broadcast({ method, params } as HubEvent);
  },
  undefined,
  parseIsolatedChecks(process.env.HUB_ISOLATED_CHECKS),
);
roomModeManager.setStore(store);

const missionManager = new MissionManager({
  store,
  getRoom: (roomId) => rooms.get(roomId),
  getFlow: (roomId) => roomModeManager.getFlow(roomId),
  hasActiveFlow: (roomId) => roomModeManager.hasActiveFlow(roomId),
  isBusy: (sessionId) => agentOps.isBusy(sessionId),
  isAvailable: (sessionId) =>
    agentForSession(sessionId)?.listSessions().some((s) => s.sessionId === sessionId) ?? false,
  roomIdForTurn: (sessionId) => roomModeManager.roomIdForTurn(sessionId),
  dispatch: async (room, text, options) => {
    if (options?.note) {
      store.append("room", room.roomId, {
        at: Date.now(),
        kind: "user",
        author: "我",
        text,
      });
    }
    return roomModeManager.handle(room, text, { ...options, bypassFilter: true });
  },
  cancelActive: (roomId, reason) => roomModeManager.cancelActive(roomId, reason),
  cancel: (sessionId) => agentOps.cancel(sessionId),
  retryFailedTasks: (roomId, taskIds) => roomModeManager.retryFailedTasks(roomId, taskIds),
  supplementActive: (room, text, missionId) => roomModeManager.supplementActive(room, text, missionId),
  broadcast: (method, params) => {
    broadcast({ method, params } as HubEvent);
    // mission 进入终态 → "task.done" 事件唤醒（roomId 取自 mission 快照）
    if (method === "mission.update") {
      const m = (params as { mission?: { roomId?: string; status?: string } }).mission;
      if (m?.roomId && (m.status === "accepted" || m.status === "stopped" || m.status === "failed")) {
        fireEventTasks(m.roomId, "task.done", { status: m.status });
        if (m.status === "accepted") notifyOffline(m.roomId, "task.done");
      }
    }
  },
});
missionManager.beginRestore();

// 编排卡：flowUpdate 离散点同步房史 kind:"flow" 条目（append → hash 脏检查覆写 → 终态定稿），
// 广播复用 room.process 信封，客户端按 historyId/flowId 配对原位更新
const baseFlowCardSync = makeFlowCardSync({
  store,
  rooms,
  broadcast: (method, params) => broadcast({ method, params } as HubEvent),
  cardRowId: (roomId) => roomModeManager.flowCardRowId(roomId),
  setCardRowId: (roomId, rowId) => roomModeManager.setFlowCardRowId(roomId, rowId),
});
roomModeManager.onFlowCard = (roomId, flow) => {
  baseFlowCardSync(roomId, flow);
  missionManager.syncFlow(roomId, flow);
  // flow waitingFor 转移（求助/澄清/交还）→ 唤醒订阅了该事件的任务
  const waiting = (flow as Record<string, unknown> | null | undefined)?.waitingFor;
  if (typeof waiting === "string" && waiting) {
    fireEventTasks(roomId, "flow.waitingFor", { waitingFor: waiting });
    notifyOffline(roomId, "attention");
  }
};

// 决策卡中心：permission/elicitation 统一为 kind:"decision" 房史条目 + 原位更新广播 + 审计
const maxPendingDecisions = (() => {
  const n = Number(process.env.HUB_MAX_PENDING_DECISIONS ?? "");
  return Number.isInteger(n) && n > 0 ? n : 200;
})();
const decisionCenter = new DecisionCenter({
  store,
  maxPending: maxPendingDecisions,
  broadcast: (method, params) => broadcast({ method, params } as HubEvent),
  audit: (scope, scopeId, ev) => {
    if (scope === "room") {
      rooms.addEvent(scopeId, { author: ev.author, action: "decision", summary: ev.summary });
    } else {
      sessionLedger.addEvent(scopeId, { author: ev.author, action: "decision", summary: ev.summary });
    }
  },
});
/** permission.respond 显式指定的授权粒度（once/task/always），decision.resolve 时消费 */
const pendingDecisionScope = new Map<string, DecisionScope>();
/** 超时兜底：agent 断连/不回包致 decision.resolve 永不触发时，条目不再无限驻留（到期删除并记录） */
const PENDING_DECISION_SCOPE_TTL_MS = 30_000;
const pendingDecisionScopeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function trackPendingDecisionScope(requestId: string, scope: DecisionScope): void {
  pendingDecisionScope.set(requestId, scope);
  clearTimeout(pendingDecisionScopeTimers.get(requestId));
  const t = setTimeout(() => {
    pendingDecisionScope.delete(requestId);
    pendingDecisionScopeTimers.delete(requestId);
    logWarn("decision", `pending decision scope expired after ${PENDING_DECISION_SCOPE_TTL_MS}ms: ${requestId}`);
  }, PENDING_DECISION_SCOPE_TTL_MS);
  t.unref();
  pendingDecisionScopeTimers.set(requestId, t);
}

function clearPendingDecisionScope(requestId: string): void {
  clearTimeout(pendingDecisionScopeTimers.get(requestId));
  pendingDecisionScopeTimers.delete(requestId);
  pendingDecisionScope.delete(requestId);
}

// nano 相关性过滤：默认开启（HUB_RELEVANCE_FILTER=0/false/off 关闭），房间级 relevanceFilter 可覆盖；
// 规则判定不确定时若配置 HUB_FILTER_MODEL 走轻量模型档，未配置则放行
const relevanceFilter = new RelevanceFilter({
  enabled: !/^(0|false|off)$/i.test(process.env.HUB_RELEVANCE_FILTER ?? ""),
  model: process.env.HUB_FILTER_MODEL || undefined,
  baseUrl: process.env.HUB_FILTER_BASE_URL || undefined,
  apiKey: process.env.HUB_FILTER_API_KEY || undefined,
});
roomModeManager.setRelevanceFilter(async (room, text, note) => {
  const enabled = room.relevanceFilter ?? relevanceFilter.enabled;
  if (!enabled) return true;
  const r = await relevanceFilter.isRelevant(text, note);
  if (!r.relevant) {
    logWarn("filter", `room ${room.roomId} filtered via ${r.via}: ${r.reason} :: ${text.slice(0, 60)}`);
  }
  return r.relevant;
});

// 孤儿编排卡收尾：重启后非终态 kind:"flow" 卡对应的 flow 已不存在
// （parallel/pipeline/debate 不持久化，或 conductor 快照缺失）→ 定稿为已中断并重播条目
function sweepOrphanFlowCards(): void {
  sweepOrphanFlowCardsImpl({
    store,
    liveFlowId: (roomId) => {
      const live = roomModeManager.getFlow(roomId);
      return typeof live?.flowId === "string" ? live.flowId : undefined;
    },
    broadcast: (method, params) => broadcast({ method, params } as HubEvent),
  });
}

// 恢复运行时编排状态（必须在 roomModeManager 创建后，但 agents 可能尚未连接）
const restoreRuntime = savedRuntime
  ? roomModeManager.importRuntime(savedRuntime)
  : Promise.resolve();
restoreRuntime
  .catch((err) => logError("import runtime", err))
  .then(() => {
    // 两个 sweep 独立收尾：任一抛错不得连锁跳过另一个
    try {
      sweepOrphanFlowCards();
    } catch (err) {
      logError("post-restore flow-card sweep", err);
    }
    try {
      sweepPendingDecisions({
        store,
        broadcast: (method, params) => broadcast({ method, params } as HubEvent),
      });
    } catch (err) {
      logError("post-restore decision sweep", err);
    }
    try {
      missionManager.reconcile();
      persistState();
    } catch (err) {
      logError("post-restore reconcile", err);
    }
  });

const scheduler = new Scheduler(
  store,
  () => scheduler.persistTo(store),
  (tasks) => broadcast({ method: "task.update", params: { tasks } } as HubEvent),
  async (task) => {
    if (task.missionTemplate) {
      await runMissionTask(task, {
        getRoom: (id) => rooms.get(id),
        hasActiveFlow: (id) => roomModeManager.hasActiveFlow(id),
        isMemberBusy: (sid) => agentOps.isBusy(sid),
        isAvailable: (sid) =>
          agentForSession(sid)?.listSessions().some((x) => x.sessionId === sid) === true,
        activeMissions: (id) => missionManager.list(id),
        createMission: (input) => missionManager.create(input),
        startMission: (id) => missionManager.start(id),
      });
      persistState();
      return;
    }
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

/** Loop 事件唤醒：房内事件命中任务 eventTrigger 白名单 → 去抖/上限后复用触发管线。
 * 仅显式配置 eventTrigger 的任务参与匹配，普通对话不会触发任何任务。 */
const eventWakeBook = new EventWakeBook();
/** 自激抑制：事件唤醒后的一段时间内，同一任务不再被任何事件触发——
 *  否则任务自身派发产生的 prompt.done/task.done/decision/flow.waitingFor
 *  会把自己再次唤醒，在上限内永续自激。窗口内对同一任务的合法唤醒漏一次，
 *  属保守取舍（去抖+小时上限仍兜底）；超长 flow 的自激残留由小时上限收敛。 */
const WAKE_SELF_SUPPRESS_MS = 10 * 60_000;
const wakeSelfSuppress = new Map<string, number>();

/** ntfy 触达兜底：仅客户端全部离线时推（有客户端时走 WS 已可达）。
 *  正文只含房名+事件类型；NTFY_TOPIC 未配置时恒不推。 */
const ntfyPusher = new NtfyPusher(ntfyConfigFromEnv());
function notifyOffline(roomId: string | undefined, kind: NtfyKind): void {
  if (!roomId) return;
  const room = rooms.get(roomId);
  void ntfyPusher
    .notifyIfOffline(roomId, room?.name ?? roomId, kind, clients.size)
    .catch((e) => logError(`ntfy ${kind}`, e));
}

/** 廉价决策层拦截计数（观测：被谓词省掉的唤醒次数，auto 路由复用同一 wakeGateAllows） */
const wakeGateStats = new WakeGateStats();
/** 静默复现每房轮次账本（默认 24h 内 2 轮），防同房多 silent 任务叠加打扰 */
const silentReproBook = new SilentReproBook();
function fireEventTasks(
  roomId: string | undefined,
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  if (!roomId) return;
  const now = Date.now();
  const wakeCtx = { kind: event, ...ctx };
  for (const task of scheduler.list()) {
    const et = task.eventTrigger;
    if (!et || !task.enabled || task.targetType !== "room" || task.targetId !== roomId) continue;
    if (!et.events.includes(event)) continue;
    if (!wakeGateAllows(et.filter, wakeCtx)) {
      wakeGateStats.skip(task.id);
      continue;
    }
    if (now < (wakeSelfSuppress.get(task.id) ?? 0)) continue;
    if (!eventWakeBook.admit(task.id, et.debounceMs ?? 30_000, et.maxPerHour ?? 6)) continue;
    // silent-repro 额外受每房 24h 轮次上限约束（不打扰策略的一部分）
    if (et.silentRepro && !silentReproBook.admit(roomId)) continue;
    wakeSelfSuppress.set(task.id, now + WAKE_SELF_SUPPRESS_MS);
    const promise = et.silentRepro
      ? scheduler.fireEvent(task, buildSilentReproPrompt(task.message, String(ctx.text ?? "")))
      : scheduler.fireEvent(task);
    promise.catch((e) => logError("event wake task", e));
  }
}

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
  status: PresenceStatus;
  quota: (ReportedQuota & { updatedAt: number }) | null;
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
        backendType: modelManager.backendTypeOf(c?.agent ?? meta?.agent ?? "devin"),
        connectionId,
        roleId: meta?.roleId,
        origin: originFor(meta) ?? c?.name,
        offline: false,
        archived: meta?.archived ?? false,
        status: (s.busy ? "generating" : "online") as PresenceStatus,
        quota: quotaFor({ sessionId: s.sessionId, connectionId }),
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
      backendType: modelManager.backendTypeOf(m.agent ?? "devin"),
      offline: true,
      archived: m.archived ?? false,
      origin: originFor(m),
      status: "offline" as PresenceStatus,
      quota: quotaFor({ sessionId: m.sessionId, connectionId: m.connectionId }),
    }));
  return [...online, ...offline];
}

type TurnDraft = {
  sessionDraftId?: number | undefined;
  roomDraftId?: number | undefined;
  /** 最近一次进度回调的全文（节流期间暂存，flush/中断收尾时补写尾部增量） */
  lastText?: string | undefined;
  lastWriteAt?: number | undefined;
  lastWriteLen?: number | undefined;
  flushTimer?: ReturnType<typeof setTimeout> | undefined;
};
const turnDrafts = new Map<string, TurnDraft>();
/** 流式草稿落库节流：避免每个 chunk 同步 UPDATE 全量文本（O(n²) 写放大阻塞主线程） */
const DRAFT_FLUSH_MS = 300;
const DRAFT_FLUSH_CHARS = 4096;

function clearDraftFlush(draft: TurnDraft): void {
  if (draft.flushTimer) {
    clearTimeout(draft.flushTimer);
    draft.flushTimer = undefined;
  }
}

function dropTurnDraft(sessionId: string): void {
  const draft = turnDrafts.get(sessionId);
  if (draft) clearDraftFlush(draft);
  turnDrafts.delete(sessionId);
}
const turnProcess = new TurnProcessRecorder();
const opLedger = new OperationLedger();
const stableFingerprint = (v: unknown): string => {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as Record<string, unknown>)
              .sort()
              .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
          )
        : x;
  return createHash("sha256").update(JSON.stringify(norm(v))).digest("hex");
};
/** 每会话当前 turn 起始时刻（首个 turn 事件记录，turn 结束清除），operation ledger 的 opId 限定符 */
const turnStarts = new Map<string, number>();
const markTurnStart = (sessionId: string): void => {
  if (!turnStarts.has(sessionId)) turnStarts.set(sessionId, Date.now());
};

function flushTurnProcess(sessionId: string, status: "done" | "failed" | "interrupted" = "done"): void {
  const buf = turnProcess.take(sessionId);
  if (buf.length === 0) return;
  const roomId = roomModeManager.roomIdForTurn(sessionId);
  for (const item of buf) {
    store.append("session", sessionId, {
      at: item.at,
      kind: item.kind,
      author: item.author,
      text: item.text,
    });
  }
  if (!roomId) return;
  // 自动决策回合的过程卡与 assistant 草稿同等隐藏：host 内部模式思考落房史即成孤儿卡
  if (roomModeManager.isDecidingTurn(sessionId, roomId)) return;
  // 房间历史只写一条聚合过程卡（不逐条散装），meta 供客户端钻取/展开
  const turnStartAt = buf[0]!.at;
  const turnEndAt = buf[buf.length - 1]!.at;
  const taskId = roomModeManager.taskIdForTurn(sessionId, roomId, turnStartAt, turnEndAt);
  const meta = buildProcessMeta(
    roomId,
    sessionId,
    buf,
    taskId,
    status,
    roomModeManager.flowIdForRoom(roomId),
  );
  if (!opLedger.commit(`process:${roomId}:${meta.processId}`, "process")) return;
  // 卡锚定最后一条过程事件的时刻而非落库时刻：结论条目以完成时刻落库必然在其后；
  // 延迟 flush（僵尸/取消/异常收尾）也不会把卡钉到时间线末尾
  const at = buf[buf.length - 1]!.at;
  const text = JSON.stringify(meta);
  const author = displayNameFor(sessionId);
  const id = store.append("room", roomId, { at, kind: "process", author, text });
  if (id < 0) return;
  broadcast({
    method: "room.process",
    params: { roomId, entry: { id, at, kind: "process", author, text } },
  } as HubEvent);
}

function displayNameFor(sessionId: string): string {
  const meta = sessionMetas.get(sessionId);
  const baseName = meta?.name ?? sessionId;
  const origin = originFor(meta);
  return origin ? `${baseName} (${origin})` : baseName;
}

function writeTurnDraft(sessionId: string, draft: TurnDraft): void {
  const displayName = displayNameFor(sessionId);
  const text = draft.lastText ?? "";
  if (draft.sessionDraftId === undefined) {
    const id = store.beginReplyDraft("session", sessionId, {
      at: Date.now(),
      kind: "assistant",
      author: displayName,
      text,
    });
    if (id > 0) draft.sessionDraftId = id;
  } else {
    store.updateReplyDraft(draft.sessionDraftId, text);
  }
  const roomId = roomModeManager.roomIdForTurn(sessionId);
  if (roomId && !roomModeManager.isHiddenTurn(sessionId, roomId)) {
    if (draft.roomDraftId === undefined) {
      const id = store.beginReplyDraft("room", roomId, {
        at: Date.now(),
        kind: "assistant",
        author: displayName,
        text,
      });
      if (id > 0) draft.roomDraftId = id;
    } else {
      store.updateReplyDraft(draft.roomDraftId, text);
    }
  }
  draft.lastWriteAt = Date.now();
  draft.lastWriteLen = text.length;
}

function onTurnProgress(sessionId: string, fullText: string): void {
  if (!fullText.trim()) return;
  markTurnStart(sessionId);
  let draft = turnDrafts.get(sessionId);
  if (!draft) {
    draft = {};
    turnDrafts.set(sessionId, draft);
  }
  draft.lastText = fullText;
  // 首个 chunk 立即落行建立草稿；之后按 300ms/4KB 节流写库
  if (draft.sessionDraftId === undefined) {
    writeTurnDraft(sessionId, draft);
    return;
  }
  const elapsed = Date.now() - (draft.lastWriteAt ?? 0);
  const grown = fullText.length - (draft.lastWriteLen ?? 0);
  if (elapsed >= DRAFT_FLUSH_MS || grown >= DRAFT_FLUSH_CHARS) {
    clearDraftFlush(draft);
    writeTurnDraft(sessionId, draft);
    return;
  }
  if (!draft.flushTimer) {
    draft.flushTimer = setTimeout(() => {
      draft.flushTimer = undefined;
      if (turnDrafts.get(sessionId) === draft) writeTurnDraft(sessionId, draft);
    }, DRAFT_FLUSH_MS - elapsed);
  }
}

function interruptTurnDrafts(sessionId: string): void {
  turnStarts.delete(sessionId);
  flushTurnProcess(sessionId, "interrupted");
  const draft = turnDrafts.get(sessionId);
  if (!draft) return;
  dropTurnDraft(sessionId);
  // 中断收尾前补写节流期内未落库的尾部增量，保留最新片段
  if (draft.lastText) writeTurnDraft(sessionId, draft);
  if (draft.sessionDraftId !== undefined) {
    store.interruptReplyDraft(draft.sessionDraftId);
  }
  if (draft.roomDraftId !== undefined) {
    store.interruptReplyDraft(draft.roomDraftId);
  }
}

function onTurnEnd(
  sessionId: string,
  text: string,
  status: "done" | "interrupted" = "done",
): void {
  const displayName = displayNameFor(sessionId);
  const t0 = turnStarts.get(sessionId) ?? Date.now();
  turnStarts.delete(sessionId);
  flushTurnProcess(sessionId, status);
  const draft = turnDrafts.get(sessionId);
  dropTurnDraft(sessionId);
  if (status === "interrupted") {
    // 取消/中断回合：过程卡标 interrupted，流式草稿保留已出文本但标记中断；
    // 收尾前先补写节流期内未落库的尾部增量
    if (draft?.lastText) writeTurnDraft(sessionId, draft);
    if (draft?.sessionDraftId !== undefined) {
      store.interruptReplyDraft(draft.sessionDraftId);
    }
    if (draft?.roomDraftId !== undefined) {
      store.interruptReplyDraft(draft.roomDraftId);
    }
    return;
  }
  if (text.trim()) {
    if (draft?.sessionDraftId !== undefined) {
      store.completeReplyDraft(draft.sessionDraftId, text);
    } else if (opLedger.commit(`reply:${sessionId}:${t0}:session`, "assistant")) {
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "assistant",
        author: displayName,
        text,
      });
    }
    // 只有群聊回合才写入 room 历史，单聊回复不泄漏到群聊
    const roomId = roomModeManager.roomIdForTurn(sessionId);
    if (roomId && !roomModeManager.isHiddenTurn(sessionId, roomId)) {
      // turn 提交不变量：游标推进的过期回复不落房史（将被作废重跑）
      if (roomModeManager.isStaleTurnCommit(sessionId, roomId)) {
        if (draft?.roomDraftId !== undefined) {
          store.interruptReplyDraft(draft.roomDraftId);
        }
      } else if (draft?.roomDraftId !== undefined) {
        store.completeReplyDraft(draft.roomDraftId, text);
      } else if (opLedger.commit(`reply:${sessionId}:${t0}:room:${roomId}`, "assistant")) {
        store.append("room", roomId, {
          at: Date.now(),
          kind: "assistant",
          author: displayName,
          text,
        });
      }
    }
  } else {
    if (draft?.sessionDraftId !== undefined) {
      store.interruptReplyDraft(draft.sessionDraftId);
    }
    if (draft?.roomDraftId !== undefined) {
      store.interruptReplyDraft(draft.roomDraftId);
    }
  }
}

function onFileWrite(sessionId: string, relPath: string, existed: boolean, content?: string): void {
  const meta = sessionMetas.get(sessionId);
  if (!meta) return;
  markTurnStart(sessionId);
  // operation ledger：同内容重复写入（断连重放/重试命中）跳过副作用；内容变化是新 op
  const fp = createHash("sha1").update(`${relPath}::${content ?? ""}`).digest("hex");
  if (!opLedger.commit(`file:${sessionId}:${fp}`, "file")) return;
  const author = meta.name;
  const summary = existed ? "修改" : "新增";

  sessionLedger.addFile(sessionId, { author, summary, path: relPath });
  // fs 通道掌握准确的 existed 信息，由它修正/产生 add/modify 事件（与 tool_call edit 去重）
  sessionLedger.addFileEvent(sessionId, { author, action: existed ? "modify" : "add", summary, path: relPath });

  // 只有群聊回合才同步产物/事件到 room，单聊操作不泄漏到群聊
  // 房间侧 author 统一为成员展示名（成员名·agentType·origin），查不到成员回退 meta.name
  const roomId = roomModeManager.roomIdForTurn(sessionId);
  if (roomId) {
    const roomAuthor = rooms.displayNameForId(roomId, sessionId, author);
    rooms.addFile?.(roomId, { author: roomAuthor, summary, path: relPath, content });
    rooms.addFileEvent?.(roomId, { author: roomAuthor, action: existed ? "modify" : "add", summary, path: relPath });
  }

  persistState();
  broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
  if (roomId) {
    broadcast({ method: "room.artifact", params: { roomId } } as HubEvent);
  }
}

function onToolCall(sessionId: string, kind: string, title: string, paths: string[]): void {
  const meta = sessionMetas.get(sessionId);
  if (!meta) return;
  markTurnStart(sessionId);

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

  for (const relPath of paths) {
    const summary = title;
    sessionLedger.addEvent(sessionId, { author: meta.name, action, summary, path: relPath });

    // 只有群聊回合才同步事件到 room，单聊操作不泄漏到群聊
    const roomId = roomModeManager.roomIdForTurn(sessionId);
    if (roomId) {
      rooms.addEvent?.(roomId, { author: rooms.displayNameForId(roomId, sessionId, meta.name), action, summary, path: relPath });
    }
  }

  persistState();
  broadcast({ method: "session.artifact", params: { sessionId } } as HubEvent);
  const artifactRoomId = roomModeManager.roomIdForTurn(sessionId);
  if (artifactRoomId) {
    broadcast({ method: "room.artifact", params: { roomId: artifactRoomId } } as HubEvent);
  }
}

function onAgentEvent(event: HubEvent): void {
  const sessionId = (event.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
  let skipBroadcast =
    sessionId != null &&
    roomModeManager.isHiddenSession(sessionId) &&
    event.method !== "permission.request" &&
    event.method !== "elicitation.request";
  if (event.method === "session.generating" && sessionId) {
    // presence：busy 起止 → generating / online 状态迁移（房间作用域同步广播）
    emitMemberStatus(sessionId, event.params.stoppable ? "generating" : "online");
  }
  if (event.method === "decision.request" && sessionId) {
    // 决策卡叠加层：房间回合写房间历史，否则写会话历史；旧客户端不认识 decision.* 即丢弃
    const p = event.params as DecisionRequestParams;
    const roomId = roomModeManager.roomIdForTurn(sessionId) ?? rooms.roomsFor(sessionId)[0]?.roomId;
    const missionId = roomId ? missionManager.missionIdForTurn(sessionId, roomId) : undefined;
    decisionCenter.open(p, {
      scope: roomId ? "room" : "session",
      scopeId: roomId ?? sessionId,
      requestedBy: displayNameFor(sessionId),
      ...(missionId ? { missionId } : {}),
    });
    fireEventTasks(roomId, "decision", {
      scope: roomId ? "room" : "session",
      decisionId: String((event.params as Record<string, unknown>).decisionId ?? ""),
    });
    notifyOffline(roomId, "attention");
    return;
  }
  if (event.method === "decision.resolve") {
    const p = event.params as {
      requestId: string;
      outcome: "answered" | "expired" | "revoked";
      optionId?: string;
      action?: string;
    };
    const requestedScope = pendingDecisionScope.get(p.requestId);
    clearPendingDecisionScope(p.requestId);
    const tracked = decisionCenter.getByRequest(p.requestId);
    const option = tracked?.meta.options.find((o) => o.id === p.optionId);
    let scope: DecisionScope | undefined;
    if (p.outcome === "answered" && tracked?.meta.type === "permission") {
      scope = requestedScope ?? inferOptionScope(option);
      // 授权粒度生效：allow 类选项 + scope≠once → 登记会话级授权（task 随回合清除）
      if (scope !== "once" && !isRejectOption(option) && tracked.meta.grantKey) {
        agentForSession(tracked.meta.sessionId)?.grantPermission(
          tracked.meta.sessionId,
          tracked.meta.grantKey,
          scope,
        );
      }
    }
    decisionCenter.resolveByRequest(p.requestId, p.outcome, {
      ...(p.optionId !== undefined ? { optionId: p.optionId } : {}),
      ...(p.action !== undefined ? { action: p.action } : {}),
      ...(scope !== undefined ? { scope } : {}),
    });
    persistState();
    return;
  }
  if (event.method === "prompt.done") {
    const { output } = event.params;
    const internalOutput = promptDoneInternalOutput(event.params);
    const meta = sessionMetas.get(sessionId!);
    const baseName = meta?.name ?? sessionId!;
    const origin = originFor(meta);
    const displayName = origin ? `${baseName} (${origin})` : baseName;
    const turnRoomId = roomModeManager.roomIdForTurn(sessionId!);
    if (!roomModeManager.isHiddenSession(sessionId!) && turnRoomId) {
      if (rooms.recordOutput(turnRoomId, sessionId!, displayName, output)) {
        broadcast({
          method: "room.blackboardUpdate",
          params: { roomId: turnRoomId, blackboard: rooms.getBlackboard(turnRoomId) },
        } as HubEvent);
      }
    }
    if (!roomModeManager.isRoomTurn(sessionId!)) {
      sessionLedger.captureOutput(sessionId!, extractTaskResult(internalOutput).artifacts);
      broadcast({ method: "session.artifact", params: { sessionId: sessionId! } });
    }
    void roomModeManager
      .onPromptDone(sessionId!, internalOutput)
      .then(() => {
        missionManager.onTurnDone(sessionId!, turnRoomId, internalOutput);
        fireEventTasks(turnRoomId, "prompt.done");
        persistState();
      })
      .catch((err) => {
        logError("room-modes", err);
      });
  } else if (event.method === "prompt.error") {
    if (sessionId) {
      flushTurnProcess(sessionId, "failed");
      const errorRoomId = roomModeManager.roomIdForTurn(sessionId);
      const turnContext = missionManager.captureTurnContext(sessionId, errorRoomId);
      interruptTurnDrafts(sessionId);
      const message = String(event.params.message ?? "").trim() || "turn error";
      const author = displayNameFor(sessionId);
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "error",
        author,
        text: message,
      });
      if (errorRoomId && !roomModeManager.isHiddenSession(sessionId)) {
        store.append("room", errorRoomId, {
          at: Date.now(),
          kind: "error",
          author,
          text: message,
        });
      }
      roomModeManager.onPromptError(sessionId, message);
      missionManager.onTurnError(sessionId, errorRoomId, message, turnContext);
      persistState();
    }
  } else if (event.method === "room.notice") {
    store.append("room", event.params.roomId, {
      at: Date.now(),
      kind: "system",
      author: "",
      text: event.params.message,
    });
  } else if (event.method === "session.update" && sessionId) {
    const update = (event.params as Record<string, unknown> | undefined)?.update;
    if (update !== undefined) {
      markTurnStart(sessionId);
      turnProcess.record(sessionId, update as Record<string, unknown>, displayNameFor(sessionId));
      roomModeManager.observeToolUpdate(sessionId, update);
    }
  }
  if (!skipBroadcast) broadcast(toPublicHubEvent(event));
}


function broadcastRoomNotice(roomId: string, message: string, meta?: unknown): void {
  if (!roomId || !message) return;
  // 恢复 flow 会重放派工等通知；与最后一条历史相同时跳过写入，避免重启后重复。
  // 派工类通知会在 system 条目后再落一张 process 卡，尾部为 [system, process] 对时同样视为已写入
  const tail = store.read("room", roomId, 2);
  const last = tail.at(-1);
  const wrote = !(
    (last?.kind === "system" && last.text === message) ||
    (last?.kind === "process" && tail.at(-2)?.kind === "system" && tail.at(-2)?.text === message)
  );
  if (wrote) {
    store.append("room", roomId, {
      at: Date.now(),
      kind: "system",
      author: "",
      text: message,
    });
  }
  broadcast({ method: "room.notice", params: { roomId, message } });
  // 结构化通知（如派工清单）：系统文本之外再落一条 process 卡并广播，恢复重放去重时不重复落卡
  const m = meta as { type?: unknown; sessionId?: unknown; tasks?: unknown } | undefined;
  if (wrote && m?.type === "dispatch" && Array.isArray(m.tasks)) {
    const sessionId = typeof m.sessionId === "string" ? m.sessionId : "";
    const tasks = m.tasks
      .map((t) => {
        const o = t as Record<string, unknown>;
        return {
          id: typeof o.id === "string" ? o.id : undefined,
          to: typeof o.to === "string" ? o.to : undefined,
          task: typeof o.task === "string" ? o.task : undefined,
        };
      })
      .filter((t) => t.task !== undefined);
    const at = Date.now();
    const cardMeta: ProcessCardMeta = {
      processId: newProcessId(
        roomId,
        `dispatch:${sessionId || roomId}:${tasks.map((t) => t.id ?? "?").join("+")}`,
        at,
      ),
      sessionId,
      turnStartAt: at,
      turnEndAt: at,
      steps: [],
      status: "done",
      type: "dispatch",
      count: tasks.length,
      tasks,
    };
    const text = JSON.stringify(cardMeta);
    const author = sessionId ? displayNameFor(sessionId) : "";
    const id = store.append("room", roomId, { at, kind: "process", author, text });
    if (id < 0) return;
    broadcast({
      method: "room.process",
      params: { roomId, entry: { id, at, kind: "process", author, text } },
    } as HubEvent);
  }
}

/** 单客户端发送缓冲上限：超过即认为对端消费跟不上，丢高频可丢事件防队列无限堆积 */
const WS_BUFFER_LIMIT = 8 * 1024 * 1024;
/** 可丢事件：丢一帧不影响终态（done/卡片/历史条目仍可靠送达） */
const DROPPABLE_METHODS = new Set<string>([
  "session.update",
  "session.usage",
  "member.status",
]);
let lastDropWarnAt = 0;

function warnBufferThrottled(ws: WebSocket, detail: string): void {
  const now = Date.now();
  if (now - lastDropWarnAt <= 5000) return;
  lastDropWarnAt = now;
  logWarn(
    "ws",
    `client send buffer ${(ws.bufferedAmount / 1048576).toFixed(1)}MB; ${detail}`,
  );
}

/** 订阅分层：client.subscribe 声明 tier；未声明按 detail 全量（兼容旧客户端） */
const clientSubs = new Map<WebSocket, ClientSub>();

function broadcast(event: HubEvent): void {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!shouldDeliver(clientSubs.get(ws), event)) continue;
    // 硬上限：积压 4 倍于软上限说明对端实质卡死（可丢事件也已无意义），
    // 直接 terminate 回收内存——否则非可丢事件仍会无限排队
    if (ws.bufferedAmount > WS_BUFFER_LIMIT * 4) {
      warnBufferThrottled(ws, "bufferedAmount 4x limit; terminating stuck client");
      ws.terminate();
      continue;
    }
    if (ws.bufferedAmount > WS_BUFFER_LIMIT && DROPPABLE_METHODS.has(event.method)) {
      warnBufferThrottled(ws, `dropping ${event.method}`);
      continue;
    }
    ws.send(data);
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  // 响应不可丢，但记录异常积压便于排查慢客户端
  if (ws.bufferedAmount > WS_BUFFER_LIMIT) {
    warnBufferThrottled(ws, "response still queued");
  }
  ws.send(JSON.stringify(msg));
}

function sessionBackend(sessionId: string): ModelBackend | undefined {
  return (sessionMetas.get(sessionId)?.agent ?? undefined) as ModelBackend | undefined;
}

async function applySessionMode(sessionId: string, mode: string): Promise<void> {
  if (!SESSION_MODES.has(mode)) throw new Error(`unknown mode: ${mode}`);
  const agent = agentForSession(sessionId);
  if (!agent) throw new Error("agent 未连接");
  await agent.setConfigOption(sessionId, "mode", mode);
  modelManager.setSessionConfigForSession(sessionId, "mode", mode);
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

/** 成员后端类型：meta.agent / connection.agent 经 backendTypeOf 解析（自定义后端归并到注册 type） */
function memberBackendType(sessionId: string): ModelBackend {
  const meta = sessionMetas.get(sessionId);
  const agent = meta?.agent ?? getConnectionById(meta?.connectionId ?? undefined)?.agent;
  return modelManager.backendTypeOf(agent ?? "devin");
}

const modeSlashDeps: ModeSlashDeps = {
  applySessionMode,
  sessionBackend,
  memberBackendType,
  memberDisplayName: (m) => rooms.displayNameFor(m),
  findByBackend: (b) => modelManager.findByBackend(b),
  setBackendConfig: (b, k, v) => modelManager.setBackendConfig(b, k, v),
};

async function handleSessionSlash(sessionId: string, slash: SlashCmd): Promise<unknown> {
  if (slash.command === "bypass" || slash.command === "mode") {
    return handleSessionModeSlash(sessionId, slash, modeSlashDeps);
  }
  if (slash.command !== "stop") {
    throw new Error(`unknown command: /${slash.command}`);
  }
  const agent = agentForSession(sessionId);
  if (!agent || !agent.isStoppable(sessionId)) {
    throw new Error("session not generating");
  }
  await agent.cancel(sessionId);
  roomModeManager.onSessionCancelled(sessionId);
  return { stopped: [sessionId] };
}

async function handleRoomSlash(
  room: Room,
  slash: SlashCmd,
  rawText: string,
  quote?: { author: string; text: string },
): Promise<unknown> {
  // 记录用户的 slash 指令本身（mode/bypass/stop 均记入房史）
  store.append("room", room.roomId, {
    at: Date.now(),
    kind: "user",
    author: "我",
    text: quote
      ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${rawText}`
      : rawText,
  });

  if (slash.command === "bypass" || slash.command === "mode") {
    return handleRoomModeSlash(room, slash, modeSlashDeps);
  }
  if (slash.command !== "stop") {
    throw new Error(`unknown command: /${slash.command}`);
  }

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

  // 中断当前房间所有编排流（含 auto、pipeline、debate 等）。
  // 先于逐会话收敛执行：onSessionCancelled 会经 scheduleTasks 重派其他成员的空闲任务，
  // 若在批量取消循环内调用会产生"派发→立即取消"的抖动
  const hadFlow = roomModeManager.hasActiveFlow(room.roomId);
  if (hadFlow) {
    await roomModeManager.cancelActive(room.roomId, "用户停止");
  }
  persistState();
  for (const sid of stopped) roomModeManager.onSessionCancelled(sid);

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

  broadcastRoomNotice(room.roomId, notice);
  return { stopped, skipped, errors, notice };
}

type RequestMessage = {
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
};

async function handleRequest(req: RequestMessage, relayed = false): Promise<unknown> {
  switch (req.method) {
    case "agent.info":
      return {
        agents: Object.keys(AGENT_DEFS),
        sessions: listAllSessions(),
        deliveryProtocol: 1,
        maxReplayAgeMs: 24 * 3600_000,
        hubId,
        ntfy: ntfyPusher.config.enabled
          ? { url: ntfyPusher.config.url, topic: ntfyPusher.config.topic }
          : null,
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
      const name = req.params?.name ? dedupeSessionName(String(req.params.name)) : role?.name;
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
      emitMemberStatus(s.sessionId, "online");
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
        await syncSessionConfigPrefs(agent, s.sessionId, backend);
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
      const newName = dedupeSessionName(`${baseName} (2)`);

      // fresh=true：不 fork 上下文，仅新建会话并继承模型/config/persona（与 room.clone fresh 同语义）
      if (req.params?.fresh === true) {
        const s = await cloneSessionWithName(source, newName, { fresh: true });
        // /new 断点条目：客户端据此渲染边界，携带来源会话引用
        store.append("session", s.sessionId, {
          at: Date.now(),
          kind: "system",
          author: "",
          text: `已开启新会话（来源：${source.name} · ${source.sessionId}）`,
        });
        return {
          ...s,
          agent: connection.agent,
          connectionId: connection.id,
          roleId: source.roleId,
        };
      }

      const s = await agent.cloneSession(sourceSessionId, source.cwd, newName);
      sessionMetas.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd: source.cwd,
        name: s.name,
        agent: connection.agent,
        connectionId: connection.id,
        roleId: source.roleId,
      });
      owners.set(s.sessionId, connection.id);
      emitMemberStatus(s.sessionId, "online");
      if (s.contextCloned) {
        store.copyHistory("session", sourceSessionId, s.sessionId);
        sessionLedger.clone(sourceSessionId, s.sessionId);
      } else {
        modelManager.copySessionPreference(sourceSessionId, s.sessionId);
        modelManager.copySessionConfig(sourceSessionId, s.sessionId);
        if (connection.agent) {
          const backend = connection.agent as ModelBackend;
          const current = modelManager.current(backend, sourceSessionId);
          await setSessionModel(agent, backend, s.sessionId, current.uid)
            .catch((err) => logWarn("session.clone", `sync model failed: ${String(err)}`));
          await syncSessionConfigPrefs(agent, s.sessionId, backend);
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
      }
      persistState();
      return {
        ...s,
        agent: connection.agent,
        connectionId: connection.id,
        roleId: source.roleId,
      };
    }
    case "session.configOptions": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      const agent = agentForSession(sessionId);
      if (!agent) throw new Error("agent 未连接");
      return { sessionId, configOptions: agent.getConfigOptions(sessionId) ?? [] };
    }
    case "session.setConfigOption": {
      const sessionId = String(req.params?.sessionId ?? "");
      const configId = String(req.params?.configId ?? "");
      const value = req.params?.value;
      if (!sessionId || !configId) throw new Error("sessionId and configId required");
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new Error("value must be string or boolean");
      }
      const agent = ownerOf(sessionId);
      await agent.setConfigOption(sessionId, configId, String(value));
      if (configId === "model") {
        await modelManager.setForSession(String(value), sessionId)
          .catch((err) => logWarn("session.config", `persist model pref failed: ${String(err)}`));
      } else {
        modelManager.setSessionConfigForSession(sessionId, configId, String(value));
      }
      return { set: true, configOptions: agent.getConfigOptions(sessionId) ?? [] };
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
      const rawPersona = req.params?.persona;
      const parsed = rawPersona === undefined || rawPersona === null || rawPersona === ""
        ? ""
        : normalizePersonaValue(rawPersona);
      const persona = typeof parsed === "string" ? parsed : serializePersonaCard(parsed);
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
      return dedupInflight(sessionResumes, sessionId, () => resumeSessionById(sessionId));
    }
    case "session.rename": {
      const sessionId = String(req.params?.sessionId ?? "");
      const name = String(req.params?.name ?? "").trim();
      const meta = sessionMetas.get(sessionId);
      if (!meta) throw new Error(`unknown session: ${sessionId}`);
      if (!name) throw new Error("name required");
      if (name.includes("·")) throw new Error("name cannot contain '·'");
      const finalName = dedupeSessionName(name, sessionId);
      meta.name = finalName;
      agentForSession(sessionId)?.renameSession(sessionId, finalName);
      const roomIds = rooms.updateMemberName(sessionId, finalName);
      persistState();
      return { renamed: true, name: finalName, roomIds };
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
      dropTurnDraft(sessionId);
      turnStarts.delete(sessionId);
      turnProcess.clear(sessionId);
      modelManager.clearSessionConfig(sessionId);
      store.deleteHistory("session", sessionId);
      const dissolved = rooms.removeMember(sessionId);
      for (const roomId of dissolved) {
        roomModeManager.onRoomRemoved(roomId);
        store.deleteHistory("room", roomId);
      }
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
        dropTurnDraft(sessionId);
        turnStarts.delete(sessionId);
        turnProcess.clear(sessionId);
        modelManager.clearSessionConfig(sessionId);
        store.deleteHistory("session", sessionId);
        dissolved.push(...rooms.removeMember(sessionId));
      }
      for (const roomId of new Set(dissolved)) {
        roomModeManager.onRoomRemoved(roomId);
        store.deleteHistory("room", roomId);
      }
      persistState();
      return { deleted: true, count: uniqueIds.length, dissolvedRooms: [...new Set(dissolved)] };
    }
    case "room.delete": {
      const roomId = String(req.params?.roomId ?? "");
      if (!rooms.get(roomId)) throw new Error(`unknown room: ${roomId}`);
      rooms.delete(roomId);
      roomModeManager.onRoomRemoved(roomId);
      store.deleteHistory("room", roomId);
      store.deleteRoomEvents(roomId);
      store.deleteMemory(roomId);
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
        roomModeManager.onRoomRemoved(roomId);
        store.deleteHistory("room", roomId);
        store.deleteRoomEvents(roomId);
        store.deleteMemory(roomId);
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
      rooms.rename(roomId, dedupeRoomName(name, roomId));
      persistState();
      return { room: enrichRoom(rooms.get(roomId)!) };
    }
    case "room.archive": {
      const roomId = String(req.params?.roomId ?? "");
      const archived = req.params?.archived === true;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      rooms.archive(roomId, archived);
      persistState();
      return { room: enrichRoom(rooms.get(roomId)!) };
    }
    case "room.update": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const name = dedupeRoomName(String(req.params?.name ?? "").trim() || room.name, roomId);
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
      const source = rooms.get(roomId);
      if (!source) throw new Error(`unknown room: ${roomId}`);
      const newName = dedupeRoomName(String(req.params?.newName ?? "").trim() || `${source.name} (2)`);

      const fresh = req.params?.fresh === true;
      const idMap = new Map<string, string>();
      const newMembers: { sessionId: string; name: string }[] = [];
      for (const m of source.members) {
        const meta = sessionMetas.get(m.sessionId);
        if (!meta) throw new Error(`unknown session: ${m.sessionId}`);
        const sessionName = dedupeSessionName(`${newName}-${meta.name}`);
        const s = await cloneSessionWithName(meta, sessionName, { fresh });
        idMap.set(m.sessionId, s.sessionId);
        newMembers.push({ sessionId: s.sessionId, name: m.name });
      }

      const config = remapRoomModeConfig(source, idMap);
      const room = rooms.create(newName, newMembers, source.mode, config);
      // IFC：克隆继承源房敏感度——private 房克隆产物不降级为 shared（防内容经克隆逃逸）
      if ((store.ifcGet(roomId) as IfcRule).sensitivity === "private") {
        store.ifcSet(room.roomId, "private");
      }
      // 群聊 /new（fresh）断点条目：标注来源房间，供客户端渲染会话边界
      if (fresh) {
        store.append("room", room.roomId, {
          at: Date.now(),
          kind: "system",
          author: "",
          text: `已开启新会话（来源：${source.name} · ${source.roomId}）`,
        });
      }
      persistState();
      return { room: enrichRoom(room) };
    }
    case "connection.list":
      return {
        connections: store.listConnections().map((c) => ({
          ...c,
          online: agents.has(c.id),
          local: c.local ?? false,
          error: localAgentErrors.get(c.id),
          quota: quotaFor({ connectionId: c.id }),
        })),
      };
    case "hub.connectInfo": {
      // 连接信息下发：仅认证连接可达此分支；relayed（via=gateway）客户端
      // 不回传 HUB_TOKEN 与 LAN 明文卡，只保留 gateway 卡
      return buildConnectInfo({ port: PORT, token: TOKEN, relayed, localOnly: LOCAL_ONLY });
    }
    case "hub.gatewayAnnounce": {
      // gateway agent 上报公网接入点；仅认证 WS 可达（/worker 通道走独立处理器）
      const info = validateGatewayAnnounce(req.params);
      setGatewayInfo(info);
      console.log(`[hub] gateway announced: ${info.publicUrl}`);
      return { ok: true };
    }
    case "hub.quotaReport": {
      // 远端 devin 配额上报：gateway agent / 远端代理由认证客户端连接上报；
      // multiplex worker 走 __control__ 控制帧（见 handleMultiplexWorker）。
      const report = validateQuotaReport(req.params);
      const updatedAt = recordQuotaReport(report);
      broadcast({
        method: "member.quota",
        params: {
          scope: report.scope,
          connectionId: report.connectionId,
          sessionId: report.sessionId,
          quota: report.quota,
          updatedAt,
        },
      });
      return { ok: true, updatedAt };
    }
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
      // 远程后端接入命令：LAN 直连 + gateway 通道（若已上报）
      const gw = getGatewayInfo();
      const join = {
        lan: (LOCAL_ONLY ? ["127.0.0.1"] : lanIps()).map((ip) =>
          workerJoinCommand({ url: `ws://${ip}:${PORT}${WORKER_PATH}`, connToken: token }),
        ),
        gateway: gw
          ? workerJoinCommand({
              url: `${gw.publicUrl.replace(/\/+$/, "")}${WORKER_PATH}`,
              connToken: token,
              publicToken: gw.publicToken,
            })
          : undefined,
      };
      return { id, token, name, agent, address, cwd, local, join };
    }
    case "connection.delete": {
      const id = String(req.params?.id ?? "");
      const existing = agents.get(id);
      if (existing) {
        existing.close();
        agents.delete(id);
      }
      const removedSids: string[] = [];
      for (const [sid, cid] of [...owners.entries()]) {
        if (cid === id) {
          owners.delete(sid);
          removedSids.push(sid);
          emitMemberStatus(sid, "offline");
        }
      }
      localAgentErrors.delete(id);
      clearQuotaReports(id, removedSids);
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
    case "session.process": {
      const sessionId = String(req.params?.sessionId ?? "");
      return { items: turnProcess.peek(sessionId) };
    }
    case "session.history": {
      const sessionId = String(req.params?.sessionId ?? "");
      const entryIds = req.params?.entryIds;
      if (entryIds !== undefined) {
        if (!Array.isArray(entryIds) || entryIds.length > 200 ||
            entryIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
          throw new Error("invalid_history_ids");
        }
        return { entries: store.readEntries("session", sessionId, [...new Set(entryIds)]), hasMore: false };
      }
      const limit = Number(req.params?.limit ?? 200);
      const afterId = req.params?.afterId;
      const afterIdNum =
        typeof afterId === "number" && Number.isFinite(afterId) ? afterId : undefined;
      if (afterIdNum !== undefined) {
        const inc = store.readAfterId("session", sessionId, afterIdNum, limit);
        // 满页=可能还有后续增量，客户端应以最后一条 id 继续翻页
        return { entries: inc.entries, hasMore: inc.entries.length === limit, truncated: inc.truncated };
      }
      const anchorAt = req.params?.anchorAt;
      const beforeAt = req.params?.before;
      const afterAt = req.params?.after;
      const beforeId = req.params?.beforeId;
      const boundaryId =
        typeof beforeId === "number" && Number.isFinite(beforeId) ? beforeId : undefined;
      const afterBound = typeof afterAt === "number" && Number.isFinite(afterAt) ? afterAt : undefined;
      let entries;
      if (typeof beforeAt === "number" && Number.isFinite(beforeAt)) {
        entries = store.readBefore("session", sessionId, beforeAt, limit, boundaryId);
      } else if (typeof anchorAt === "number" && Number.isFinite(anchorAt)) {
        entries = store.readAround("session", sessionId, anchorAt, limit);
      } else if (afterBound !== undefined) {
        entries = store.readAfter("session", sessionId, afterBound, limit);
      } else {
        entries = store.read("session", sessionId, limit);
      }
      if (afterBound !== undefined && entries.length > 0 && entries[0]!.at < afterBound) {
        entries = entries.filter((e) => e.at >= afterBound);
      }
      const hasMore = entries.length > 0 ? store.hasMoreBefore("session", sessionId, entries[0]!.at, entries[0]!.id) : false;
      return { entries, hasMore };
    }
    case "room.history": {
      const roomId = String(req.params?.roomId ?? "");
      // IFC：private 房历史拉取须授权标记或白名单请求房
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
      const entryIds = req.params?.entryIds;
      if (entryIds !== undefined) {
        if (!Array.isArray(entryIds) || entryIds.length > 200 ||
            entryIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
          throw new Error("invalid_history_ids");
        }
        return { entries: store.readEntries("room", roomId, [...new Set(entryIds)]), hasMore: false };
      }
      const limit = Number(req.params?.limit ?? 200);
      const afterId = req.params?.afterId;
      const afterIdNum =
        typeof afterId === "number" && Number.isFinite(afterId) ? afterId : undefined;
      if (afterIdNum !== undefined) {
        const inc = store.readAfterId("room", roomId, afterIdNum, limit);
        return { entries: inc.entries, hasMore: inc.entries.length === limit, truncated: inc.truncated };
      }
      const anchorAt = req.params?.anchorAt;
      const beforeAt = req.params?.before;
      const afterAt = req.params?.after;
      const beforeId = req.params?.beforeId;
      const boundaryId =
        typeof beforeId === "number" && Number.isFinite(beforeId) ? beforeId : undefined;
      const afterBound = typeof afterAt === "number" && Number.isFinite(afterAt) ? afterAt : undefined;
      let entries;
      if (typeof beforeAt === "number" && Number.isFinite(beforeAt)) {
        entries = store.readBefore("room", roomId, beforeAt, limit, boundaryId);
      } else if (typeof anchorAt === "number" && Number.isFinite(anchorAt)) {
        entries = store.readAround("room", roomId, anchorAt, limit);
      } else if (afterBound !== undefined) {
        entries = store.readAfter("room", roomId, afterBound, limit);
      } else {
        entries = store.read("room", roomId, limit);
      }
      if (afterBound !== undefined && entries.length > 0 && entries[0]!.at < afterBound) {
        entries = entries.filter((e) => e.at >= afterBound);
      }
      const hasMore = entries.length > 0 ? store.hasMoreBefore("room", roomId, entries[0]!.at, entries[0]!.id) : false;
      return { entries, hasMore };
    }
    case "room.history.search": {
      // 检索式调取旧记录：关键词/作者/时间窗过滤+id 游标分页，IFC 读门控同 room.history
      const roomId = String(req.params?.roomId ?? "");
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
      const query = req.params?.query === undefined ? undefined : String(req.params.query).slice(0, 100);
      const author = req.params?.author === undefined ? undefined : String(req.params.author).slice(0, 64);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const limit = Math.max(1, Math.min(num(req.params?.limit) ?? 20, 50));
      const items = store.searchHistory("room", roomId, {
        query, author, fromAt: num(req.params?.fromAt), toAt: num(req.params?.toAt),
        beforeId: num(req.params?.beforeId), limit,
      });
      return { entries: items, hasMore: items.length === limit };
    }
    case "room.create": {
      const name = dedupeRoomName(String(req.params?.name ?? "群聊").trim() || "群聊");
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
      // IFC 豁免：仅成员元数据（模型 id/角色），不含房内容正文，v1 不门控
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
          backendType: modelManager.backendTypeOf(backend),
          model: current.uid,
          quota: quotaFor({ sessionId: m.sessionId, connectionId: meta?.connectionId }),
        };
      });
      return { members };
    }
    case "room.blackboard": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
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
    case "room.topic.open": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const text = String(req.params?.text ?? "").trim();
      if (!text) throw new Error("text required");
      const owner =
        typeof req.params?.owner === "string" && req.params.owner.trim()
          ? req.params.owner.trim()
          : undefined;
      const topic = rooms.openTopic(roomId, text, owner);
      if (!topic) throw new Error("open topic failed");
      broadcast({
        method: "room.blackboardUpdate",
        params: { roomId, blackboard: rooms.getBlackboard(roomId) },
      } as HubEvent);
      persistState();
      return { topic };
    }
    case "room.topic.resolve": {
      const roomId = String(req.params?.roomId ?? "");
      const id = String(req.params?.id ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const resolved = rooms.resolveTopic(roomId, id);
      broadcast({
        method: "room.blackboardUpdate",
        params: { roomId, blackboard: rooms.getBlackboard(roomId) },
      } as HubEvent);
      if (resolved) persistState();
      return { resolved };
    }
    case "room.flow": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      // IFC：flow 编排卡含任务正文，private 房须授权/白名单
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
      return { flow: roomModeManager.getFlow(roomId) ?? null };
    }
    case "client.message.status": {
      const method = String(req.params?.method ?? "");
      if (method !== "room.message" && method !== "prompt.send") {
        throw new Error("method must be room.message or prompt.send");
      }
      const scopeId = String(
        (method === "room.message" ? req.params?.roomId : req.params?.sessionId) ?? "",
      );
      if (!scopeId) throw new Error("scope id required");
      const cmId = req.params?.clientMessageId;
      if (typeof cmId !== "string" || !cmId || cmId.length > 200) {
        throw new Error("clientMessageId must be a non-empty string, max 200");
      }
      return clientMessageStatus(store, `${method}:${scopeId}:${cmId}`);
    }
    case "room.sync": {
      // 增量恢复校准快照：卡原位更新 id 不变，只给全量快照不给增量
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
      const sub = roomModeManager.subModeFor(roomId);
      const rawIds = req.params?.knownCardIds;
      const knownCardIds = rawIds === undefined
        ? undefined
        : Array.isArray(rawIds)
          ? rawIds
          : null;
      if (knownCardIds === null) throw new Error("knownCardIds must be an array");
      if (knownCardIds !== undefined && knownCardIds.length > 200) {
        throw new Error("knownCardIds must be positive integers, max 200");
      }
      const dedup = knownCardIds === undefined
        ? undefined
        : [...new Set(
            knownCardIds.map((v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null)),
          )];
      if (dedup && dedup.some((v) => v === null)) {
        throw new Error("knownCardIds must be positive integers, max 200");
      }
      const ids = (dedup ?? []) as number[];
      return {
        mode: room.mode,
        flow: roomModeManager.getFlow(roomId) ?? null,
        blackboard: rooms.getBlackboard(roomId),
        subMode: sub?.mode ?? null,
        activeSpeaker: sub?.activeSpeaker ?? null,
        ...(knownCardIds !== undefined ? { cards: store.readRoomCards(roomId, ids) } : {}),
      };
    }
    case "room.memory": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      // IFC：private 房数据拉取须授权标记或白名单请求房
      const rule = store.ifcGet(roomId) as IfcRule;
      ifcCheckRoomRead(rule, roomId, req.params);
      return { memories: store.memoryList(roomId, Date.now()) };
    }
    case "room.memory.delete": {
      const roomId = String(req.params?.roomId ?? "");
      const id = Number(req.params?.id ?? 0);
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      if (!Number.isInteger(id) || id <= 0) throw new Error("id required");
      // IFC：敏感写操作统一要求显式授权标记
      ifcCheckSensitiveWrite(req.params);
      return { removed: store.memoryRemove(roomId, id) };
    }
    case "room.sensitivity": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      const s = parseSensitivity(req.params?.sensitivity);
      store.ifcSet(roomId, s);
      return { sensitivity: s };
    }
    case "room.ifc.grant": {
      const roomId = String(req.params?.roomId ?? "");
      const allowRoomId = String(req.params?.allowRoomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error("unknown room");
      if (!allowRoomId) throw new Error("allowRoomId required");
      const allowed = req.params?.allowed !== false;
      store.ifcAllow(roomId, allowRoomId, allowed);
      return { granted: allowed, rule: store.ifcGet(roomId) };
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
    case "mission.create": {
      const mission = missionManager.create({
        roomId: req.params?.roomId,
        goal: req.params?.goal,
        acceptanceCriteria: req.params?.acceptanceCriteria,
        scope: req.params?.scope,
        constraints: req.params?.constraints,
        ownerSessionId: req.params?.ownerSessionId,
        maxAutoRetries: req.params?.maxAutoRetries,
      });
      persistState();
      return { mission };
    }
    case "mission.list": {
      const roomId =
        typeof req.params?.roomId === "string" && req.params.roomId.trim()
          ? req.params.roomId.trim()
          : undefined;
      return { missions: missionManager.list(roomId) };
    }
    case "mission.get": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.get(id);
      if (!mission) throw new Error(`unknown mission: ${id}`);
      return { mission };
    }
    case "mission.start": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = await missionManager.start(id);
      persistState();
      return { mission };
    }
    case "mission.stop": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const reason =
        typeof req.params?.reason === "string" ? req.params.reason : undefined;
      const mission = await missionManager.stop(id, reason);
      persistState();
      return { mission };
    }
    case "mission.review": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.review(id, {
        index: req.params?.index,
        verdict: req.params?.verdict,
        taskIds: req.params?.taskIds,
        note: req.params?.note,
      });
      persistState();
      return { mission };
    }
    case "mission.accept": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.accept(id, req.params?.note);
      persistState();
      return { mission };
    }
    case "mission.rework": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.rework(id, req.params?.note);
      persistState();
      return { mission };
    }
    case "mission.updateContract": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.updateContract(id, {
        goal: req.params?.goal,
        acceptanceCriteria: req.params?.acceptanceCriteria,
        scope: req.params?.scope,
        constraints: req.params?.constraints,
        ownerSessionId: req.params?.ownerSessionId,
        maxAutoRetries: req.params?.maxAutoRetries,
      });
      persistState();
      return { mission };
    }
    case "mission.supplement": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = await missionManager.supplement(id, req.params?.text);
      persistState();
      return { mission };
    }
    case "decision.list": {
      // 可选过滤：roomId/sessionId/missionId 命中任一即收窄；均不传返回全部 pending
      const str = (k: string) => {
        const v = req.params?.[k];
        return typeof v === "string" && v ? v : undefined;
      };
      return {
        decisions: decisionCenter.listPending({
          roomId: str("roomId"),
          sessionId: str("sessionId"),
          missionId: str("missionId"),
        }),
      };
    }
    case "mission.retry": {
      const id = String(req.params?.id ?? req.params?.missionId ?? "");
      const mission = missionManager.retry(id);
      persistState();
      return { mission };
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
    case "session.contextUsage": {
      const sessionId = String(req.params?.sessionId ?? "");
      if (!sessionId) throw new Error("sessionId required");
      return { usage: ownerOf(sessionId).getContextUsage(sessionId) ?? null };
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
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
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
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
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
      // IFC：文件树属房内容，private 房须授权/白名单
      ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
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
        // IFC：文件内容出房，private 房须授权/白名单
        ifcCheckRoomRead(store.ifcGet(roomId) as IfcRule, roomId, req.params);
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

      const clientMsgId = String(req.params?.clientMessageId ?? "");
      if (clientMsgId.length > 200) throw new Error("client_message_invalid");
      const slash = parseSlash(text);
      if (slash && HUB_SLASH_COMMANDS.has(slash.command)) {
        if (clientMsgId) throw new Error("client_message_control");
        return handleRoomSlash(room, slash, text, quote);
      }

      const roomNote = roomLostReplyNote(roomId);

      // 幂等重放白名单：仅普通派发记账；重试指令为控制面旁路，不进入幂等重放域
      const retryMatch = parseRetryCommand(historyText);
      const isRetryCmd = !!retryMatch && roomModeManager.hasAwaitingRetry(roomId);
      const isCancelWord = /^(?:停止|取消|终止|中断|停下|别做了|stop|cancel|abort)$/i.test(historyText.trim());
      const isHelpAnswer = !!helpAnswerIntent(historyText, req.params as Record<string, unknown>);
      if (clientMsgId && (retryMatch || (isCancelWord && !isHelpAnswer))) {
        throw new Error("client_message_control");
      }

      const dispatch = async () => {
        store.append("room", roomId, {
          at: Date.now(),
          kind: "user",
          author: "我",
          text: quote
            ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${historyText}`
            : historyText,
        });
        // silent-repro 等文本监听任务的唤醒源：仅真实用户消息到达这里，
        // 任务产出不经此路径，room.message 事件天然不会自激；
        // 已 @ 成员的消息走正常派发，不再触发静默复现（防同一份报障双重执行）
        const mentionedMember = rooms.route(roomId, historyText).mentioned.length > 0;
        if (!mentionedMember) fireEventTasks(roomId, "room.message", { text: historyText });
        if (isRetryCmd) {
          const retried = roomModeManager.retryFailedTasks(roomId, retryMatch!.taskIds);
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
      };
      if (!clientMsgId || isRetryCmd) return dispatch();

      const expectedFlowId = req.params?.expectedFlowId;
      const expectedMissionId = req.params?.expectedMissionId;
      const expectedFlowState = req.params?.expectedFlowState;
      const expectedRoomMode = req.params?.expectedRoomMode;
      const expectedReplyTo = req.params?.replyTo;
      if (
        (expectedFlowId !== undefined && expectedFlowId !== null && typeof expectedFlowId !== "string") ||
        (expectedMissionId !== undefined && expectedMissionId !== null && typeof expectedMissionId !== "string") ||
        (expectedFlowState !== undefined && (typeof expectedFlowState !== "string" ||
          !["none", "active", "terminal", "restart", "deciding"].includes(expectedFlowState))) ||
        (expectedRoomMode !== undefined && typeof expectedRoomMode !== "string") ||
        (expectedReplyTo !== undefined && expectedReplyTo !== null && typeof expectedReplyTo !== "string")
      ) {
        throw new Error("client_message_context_changed");
      }
      const fingerprint = stableFingerprint({ ...(req.params as Record<string, unknown>), clientMessageId: undefined });
      return runClientMessage(
        store,
        {
          key: `room.message:${roomId}:${clientMsgId}`,
          fingerprint,
          scope: "room",
          scopeId: roomId,
          entry: {
            clientMessageId: clientMsgId,
            at: Date.now(),
            kind: "user",
            author: "我",
            text: quote
              ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${historyText}`
              : historyText,
          },
          validateNew: () => {
            const answer = helpAnswerIntent(historyText, req.params as Record<string, unknown>);
            if (answer && !answer.helpId) throw new Error("client_message_context_changed");
            if (expectedFlowId === undefined && expectedMissionId === undefined &&
                expectedFlowState === undefined && expectedRoomMode === undefined && !expectedReplyTo) return;
            const flow = roomModeManager.getFlow(roomId);
            if (typeof expectedReplyTo === "string" &&
                (!flow || flow.phase === "done" || flow.phase === "cancelled" ||
                  (flow.clarificationId !== expectedReplyTo &&
                    !(Array.isArray(flow.tasks) && flow.tasks.some((task) =>
                      task?.waitingFor === "user" && task.waitingHelpId === expectedReplyTo))))) {
              throw new Error("client_message_context_changed");
            }
            if ((expectedFlowState !== undefined &&
                clientMessageFlowState(flow, roomModeManager.subModeFor(roomId)?.mode) !== expectedFlowState) ||
                (expectedRoomMode !== undefined && room.mode !== expectedRoomMode)) {
              throw new Error("client_message_context_changed");
            }
            if (expectedFlowId !== undefined) {
              const actualFlowId = (flow?.flowId as string | undefined) ?? null;
              if (actualFlowId !== expectedFlowId) {
                throw new Error("client_message_context_changed");
              }
            }
            if (expectedMissionId !== undefined) {
              const actualMissionId = (flow?.missionId as string | undefined) ?? null;
              if (actualMissionId !== expectedMissionId) {
                throw new Error("client_message_context_changed");
              }
            }
          },
        },
        async () => {
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
          return result as unknown as Record<string, unknown>;
        },
      );
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
      const clientMsgId = String(req.params?.clientMessageId ?? "");
      if (clientMsgId.length > 200) throw new Error("client_message_invalid");
      const slash = parseSlash(slashText);
      if (slash && HUB_SLASH_COMMANDS.has(slash.command)) {
        if (clientMsgId) throw new Error("client_message_control");
        return handleSessionSlash(sessionId, slash);
      }
      const historyText = promptContent
        .map((b) => (b.type === "text" ? String(b.text ?? "") : "[图片]"))
        .join("") || "（图片）";

      const note = sessionLostReplyNote(sessionId);

      const promptIsCancel = /^(?:停止|取消|终止|中断|停下|别做了|stop|cancel|abort)$/i.test(historyText.trim());
      const promptIsHelp = !!helpAnswerIntent(historyText, req.params as Record<string, unknown>);
      if (clientMsgId && promptIsCancel && !promptIsHelp) {
        throw new Error("client_message_control");
      }

      const dispatchBody = async () => {
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
      };

      if (!clientMsgId) {
        store.append("session", sessionId, {
          at: Date.now(),
          kind: "user",
          author: "我",
          text: historyText,
        });
        return dispatchBody();
      }

      const fingerprint = stableFingerprint({ ...(req.params as Record<string, unknown>), clientMessageId: undefined });
      return runClientMessage(
        store,
        {
          key: `prompt.send:${sessionId}:${clientMsgId}`,
          fingerprint,
          scope: "session",
          scopeId: sessionId,
          entry: { at: Date.now(), kind: "user", author: "我", text: historyText, clientMessageId: clientMsgId },
        },
        dispatchBody,
      );
    }
    case "session.cancel": {
      const sid = String(req.params?.sessionId ?? "");
      const agent = ownerOf(sid);
      // 仅在确有在途回合被中断时才做编排收敛，避免空闲/不可停会话把 running 任务误标 failed
      const interrupted = agent.isStoppable(sid);
      await agent.cancel(sid);
      if (interrupted) roomModeManager.onSessionCancelled(sid);
      return { cancelled: true };
    }
    case "permission.respond": {
      const requestId = String(req.params?.requestId ?? "");
      const optionId = String(req.params?.optionId ?? "");
      const rawScope = String(req.params?.scope ?? "").toLowerCase();
      if (rawScope === "once" || rawScope === "task" || rawScope === "always") {
        trackPendingDecisionScope(requestId, rawScope);
      }
      const ok = [...agents.values()].some((a) =>
        a.respondPermission(requestId, optionId),
      );
      if (!ok) {
        clearPendingDecisionScope(requestId);
        throw new Error("unknown, expired, or invalid option for permission request");
      }
      return { responded: true };
    }
    case "decision.revoke": {
      const decisionId = String(req.params?.decisionId ?? "");
      const tracked = decisionCenter.get(decisionId);
      if (!tracked) throw new Error(`unknown decision: ${decisionId}`);
      const meta = tracked.meta;
      const agent = agentForSession(meta.sessionId);
      if (meta.status === "pending") {
        // 挂起中的决策：终止底层请求（permission 空选收尾 / elicitation cancel）
        if (meta.type === "permission") agent?.revokePermission(meta.requestId);
        else agent?.revokeElicitation(meta.requestId);
      }
      // always/task 授权撤销 → 恢复逐次询问
      if (meta.scope !== "once" && meta.grantKey) {
        agent?.revokePermissionGrant(meta.sessionId, meta.grantKey);
      }
      decisionCenter.revoke(decisionId);
      persistState();
      return { revoked: true, decisionId };
    }
    case "member.status": {
      const roomId = String(req.params?.roomId ?? "");
      const sessionId = String(req.params?.sessionId ?? "");
      if (roomId) {
        const room = rooms.get(roomId);
        if (!room) throw new Error(`unknown room: ${roomId}`);
        return {
          members: room.members.map((m) => ({
            sessionId: m.sessionId,
            name: m.name,
            status: memberStatusOf(m.sessionId),
          })),
        };
      }
      if (sessionId) {
        return { sessionId, status: memberStatusOf(sessionId) };
      }
      return { members: listAllSessions().map((s) => ({ sessionId: s.sessionId, status: s.status })) };
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
    case "model.usage": {
      const backend = String(req.params?.backend ?? "devin");
      if (backend !== "devin") return { backend, available: false };
      return getDevinQuota(req.params?.refresh === true);
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
      return {
        tasks: scheduler.list().map((t) => ({
          ...t,
          wakeSkips: wakeGateStats.count(t.id),
        })),
      };
    case "task.create": {
      const name = String(req.params?.name ?? "");
      const targetType = req.params?.targetType === "room" ? "room" : "session";
      const targetId = String(req.params?.targetId ?? "");
      const targetName = String(req.params?.targetName ?? "");
      const enabled = req.params?.enabled !== false;
      if (!name || !targetId || req.params?.schedule === undefined || req.params?.schedule === null)
        throw new Error("name, targetId, schedule required");
      const schedule = parseSchedule(req.params.schedule);
      const missionId = req.params?.missionId;
      let message = String(req.params?.message ?? "");
      let missionTemplate: import("./scheduler.js").MissionTemplate | undefined;
      let missionAutoStart = false;
      if (missionId !== undefined && missionId !== null) {
        if (targetType !== "room") throw new Error("mission schedule requires room target");
        const m = missionManager.get(String(missionId));
        if (!m) throw new Error(`unknown mission: ${String(missionId)}`);
        missionTemplate = missionTemplateFrom(m, targetType, targetId);
        missionAutoStart = req.params?.missionAutoStart === true;
        if (!message) message = `定时生成待确认目标：${m.goal.slice(0, 80)}`;
      } else if (req.params?.missionAutoStart !== undefined) {
        throw new Error("missionAutoStart requires missionId");
      }
      if (!message) throw new Error("message required");
      const eventTrigger = parseEventTrigger(req.params?.eventTrigger, targetType);
      const task = scheduler.create({
        name, targetType, targetId, targetName, message, schedule, enabled,
        ...(missionTemplate ? { missionTemplate, missionAutoStart } : {}),
        ...(eventTrigger ? { eventTrigger } : {}),
      });
      return { task };
    }
    case "task.update": {
      const id = String(req.params?.id ?? "");
      if (req.params?.missionTemplate !== undefined || req.params?.missionId !== undefined)
        throw new Error("mission template cannot be changed; recreate the task");
      const existing = scheduler.list().find((t) => t.id === id);
      if (!existing) throw new Error(`unknown task: ${id}`);
      const patch: Partial<Omit<ScheduledTask, "id" | "createdAt">> = {};
      if (typeof req.params?.name === "string") patch.name = req.params.name;
      if (req.params?.targetType === "room" || req.params?.targetType === "session")
        patch.targetType = req.params.targetType;
      if (typeof req.params?.targetId === "string") patch.targetId = req.params.targetId;
      if (existing.missionTemplate) {
        if (patch.targetType !== undefined && patch.targetType !== existing.targetType)
          throw new Error("mission template target is frozen; recreate the task");
        if (patch.targetId !== undefined && patch.targetId !== existing.targetId)
          throw new Error("mission template target is frozen; recreate the task");
        if (typeof req.params?.message === "string" && req.params.message !== existing.message)
          throw new Error("mission template message is frozen; recreate the task");
      }
      if (!existing.missionTemplate && req.params?.missionAutoStart !== undefined)
        throw new Error("missionAutoStart requires a mission template");
      if (typeof req.params?.targetName === "string") patch.targetName = req.params.targetName;
      if (typeof req.params?.message === "string") patch.message = req.params.message;
      // 与 task.create 同样校验：只要传了 schedule 字段就必须合法（null/0/"" 等
      // falsy 值显式拒绝，不得静默忽略）
      if (req.params?.schedule !== undefined) patch.schedule = parseSchedule(req.params.schedule);
      if (typeof req.params?.enabled === "boolean") patch.enabled = req.params.enabled;
      if (req.params?.missionAutoStart !== undefined)
        patch.missionAutoStart = req.params.missionAutoStart === true;
      if (req.params?.eventTrigger !== undefined) {
        // null 表示清除唤醒配置；对象按白名单校验（targetType 可能随本 patch 变更）
        patch.eventTrigger =
          req.params.eventTrigger === null
            ? undefined
            : parseEventTrigger(req.params.eventTrigger, patch.targetType ?? existing.targetType);
      }
      const task = scheduler.update(id, patch);
      if (!task) throw new Error(`unknown task: ${id}`);
      return { task };
    }
    case "task.delete": {
      const id = String(req.params?.id ?? "");
      if (!scheduler.delete(id)) throw new Error(`unknown task: ${id}`);
      eventWakeBook.drop(id);
      wakeSelfSuppress.delete(id);
      wakeGateStats.remove(id);
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
  store.updateConnection(connection.id, { lastSeen: Date.now() });
  ws.on("close", () =>
    store.updateConnection(connection.id, { lastSeen: Date.now() }),
  );

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
  const a = new AcpAgent(connection.name, stream, onAgentEvent, undefined, undefined, onTurnEnd, onFileWrite, onToolCall, false, onTurnProgress);
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
    const removedSids: string[] = [];
    for (const [sid, cid] of [...owners.entries()]) {
      if (cid === connectionId) {
        owners.delete(sid);
        removedSids.push(sid);
        emitMemberStatus(sid, "offline");
      }
    }
    clearQuotaReports(connectionId, removedSids);
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
      // 其他控制帧在 announce 之前到达，忽略
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

    // 创建子通道 Stream（注册新的 message listener）；
    // onControl 承接 announce 之后的控制帧——quotaReport 把 worker 本机配额
    // 归到 base connection 与其全部虚拟通道（同一台机共享同一份配额）。
    multiplexed = multiplexWebSocketStream(ws, channelIds, (frame) => {
      if (frame.method !== "quotaReport") return;
      try {
        const quota = validateReportedQuota(frame.quota);
        const ids = [baseConnection.id, ...channelIds.map((id) => `${baseConnection.id}::${id}`)];
        const updatedAt = Date.now();
        for (const id of ids) {
          recordQuotaReport({ scope: "connection", connectionId: id, quota }, updatedAt);
        }
        broadcast({
          method: "member.quota",
          params: { scope: "connection", connectionIds: ids, quota, updatedAt },
        });
      } catch (err) {
        logWarn("worker", `quotaReport rejected: ${String(err)}`);
      }
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
        false,
        onTurnProgress,
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
      const removedSids: string[] = [];
      for (const [sid, cid] of [...owners.entries()]) {
        if (cid === connId) {
          owners.delete(sid);
          removedSids.push(sid);
          emitMemberStatus(sid, "offline");
        }
      }
      clearQuotaReports(connId, removedSids);
    }
    virtualAgents.clear();
    clearQuotaReports(baseConnection.id);
  });
}

// env 门控性能采样：ELD/RSS/在线量 30s 一行，供低配机卡顿定位与回归对比
startPerfMonitor(() => ({
  clients: clients.size,
  agents: agents.size,
  rooms: rooms.list().length,
  maxBuffered: Math.max(0, ...[...clients].map((w) => w.bufferedAmount)),
}));

// 健康探针：/healthz 进程存活（恒 200）；/readyz 链路可用（无 agent 在线 → 503）。
// 供 Uptime Kuma/systemd 探测，WS 握手路径不受影响
const healthServer = createServer((req, res) => {
  const route = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && (route === "/healthz" || route === "/readyz")) {
    const onlineAgents = [...agents.values()].filter((agent) => agent.isReady).length;
    const ready = onlineAgents > 0;
    res.setHeader("Content-Type", "application/json");
    res.statusCode = route === "/readyz" && !ready ? 503 : 200;
    res.end(
      JSON.stringify({
        status: route === "/readyz" && !ready ? "not_ready" : "ok",
        agents: onlineAgents,
        clients: clients.size,
        uptimeSec: Math.round(process.uptime()),
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

const wss = new WebSocketServer({
  server: healthServer,
  // permessage-deflate：process 卡/历史回包/合帧批量消息体量不小，低配链路收益直接；
  // 1KB 阈值以下不压（小消息压缩反而费 CPU 且可能变大），两端 ws/OkHttp 均标准支持
  perMessageDeflate: { threshold: 1024 },
});
healthServer.listen(PORT, LOCAL_ONLY ? "127.0.0.1" : "0.0.0.0");
/** 经 gateway 中继的客户端连接（via=gateway）：connectInfo 不下发明文凭据 */
const relayedClients = new Set<WebSocket>();
type LiveSocket = WebSocket & { isAlive?: boolean };
/** 服务端心跳：NAT/休眠断连后让 close 尽快触发，释放 owners/agents 等关联状态 */
const WS_PING_INTERVAL_MS = 30_000;

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const s = ws as LiveSocket;
    if (s.isAlive === false) {
      ws.terminate();
      continue;
    }
    s.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, WS_PING_INTERVAL_MS);
heartbeat.unref();

wss.on("connection", (ws, req) => {
  const live = ws as LiveSocket;
  live.isAlive = true;
  ws.on("pong", () => {
    live.isAlive = true;
  });
  // 无 error 监听时 ws 会把 socket 错误抛成 uncaughtException 直接打崩进程；
  // 挂在 connection 入口，同时覆盖 client 连接与 worker announce 前的窗口期
  ws.on("error", (err) => logWarn("ws", `socket error: ${String(err)}`));
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === WORKER_PATH) {
    handleWorker(ws, req);
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    ws.close(4001, "unauthorized");
    return;
  }
  if (url.searchParams.get("via") === "gateway") relayedClients.add(ws);
  clients.add(ws);
  console.log(`[hub] client connected (${clients.size} total)`);
  ws.on("close", () => {
    clients.delete(ws);
    relayedClients.delete(ws);
    clientSubs.delete(ws);
  });
  ws.on("message", async (raw) => {
    let req2: RequestMessage;
    try {
      req2 = JSON.parse(String(raw));
    } catch {
      send(ws, { id: null, error: "invalid json" });
      return;
    }
    try {
      // 订阅分层声明：global=低频状态白名单 / detail=全量；
      // 切 detail 且带 roomId 时回包内嵌 room.sync 快照，防订阅窗口漏事件
      if (req2.method === "client.subscribe") {
        const tier = req2.params?.tier === "global" ? "global" : "detail";
        const roomId =
          typeof req2.params?.roomId === "string" && req2.params.roomId
            ? req2.params.roomId
            : undefined;
        const sessionId =
          typeof req2.params?.sessionId === "string" && req2.params.sessionId
            ? req2.params.sessionId
            : undefined;
        const taskIds = Array.isArray(req2.params?.taskIds)
          ? new Set(
              (req2.params.taskIds as unknown[])
                .map((x) => String(x))
                .filter((x) => x.length > 0)
                .slice(0, 500),
            )
          : undefined;
        clientSubs.set(ws, { tier, roomId, sessionId, ...(taskIds ? { taskIds } : {}) });
        let snapshot: Record<string, unknown> | undefined;
        if (tier === "detail" && roomId) {
          const room = rooms.get(roomId);
          if (!room) throw new Error(`unknown room: ${roomId}`);
          const sub = roomModeManager.subModeFor(roomId);
          snapshot = {
            flow: roomModeManager.getFlow(roomId),
            blackboard: rooms.getBlackboard(roomId),
            subMode: sub?.mode ?? null,
            activeSpeaker: sub?.activeSpeaker ?? null,
          };
        }
        send(ws, {
          id: req2.id,
          result: { subscribed: true, tier, ...(snapshot ? { snapshot } : {}) },
        });
        return;
      }
      const result = await handleRequest(req2, relayedClients.has(ws));
      send(ws, { id: req2.id, result });
    } catch (err) {
      logError(`request ${req2.method}`, err);
      send(ws, { id: req2.id, error: String(err) });
    }
  });
});

wss.on("listening", () => {
  const addrs = LOCAL_ONLY ? ["127.0.0.1"] : lanIps();
  console.log(`[hub] ws listening on port ${PORT}`);
  console.log(`[hub] agent types: ${Object.keys(AGENT_DEFS).join(", ")}`);
  console.log(`[hub] data dir: ${store.dir}`);
  console.log(
    `[hub] restored: ${sessionMetas.size} sessions, ${rooms.list().length} rooms`,
  );
  for (const addr of addrs) {
    console.log(`[hub] ${LOCAL_ONLY ? "local" : "phone"} connect: ws://${addr}:${PORT}/?token=${TOKEN}`);
    console.log(`[hub] worker connect: ws://${addr}:${PORT}${WORKER_PATH}?token=<CONNECTION_TOKEN>`);
  }
  // --qr 或 HUB_QR=1：终端打印 LAN 接入二维码 + 统一 URI
  if (process.argv.includes("--qr") || process.env.HUB_QR === "1") {
    for (const addr of addrs) {
      const uri = buildConnectUri({
        url: `ws://${addr}:${PORT}`,
        token: TOKEN,
        mode: "lan",
      });
      console.log(`[hub] scan to connect: ${uri}`);
      qrcode.generate(uri, { small: true }, (qr) => console.log(qr));
    }
  }
  if (process.env.HUB_TUNNEL === "1") {
    startTunnel(PORT, TOKEN);
  }
});
