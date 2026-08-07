import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, getPermissionBypass, setPermissionBypass, type HubEvent } from "./agent.js";
import { RoomManager, type Room, type RoomMode } from "./room.js";
import { RoomModeManager } from "./room-modes.js";
import type { AgentOps } from "./room-modes.js";
import { Store, type SessionMeta, type Connection } from "./store.js";
import { startTunnel } from "./tunnel.js";
import { webSocketStream } from "./stream.js";
import { AGENT_DEFS } from "./agent-defs.js";
import { ModelManager } from "./model.js";

const PORT = Number(process.env.HUB_PORT ?? 8787);
const TOKEN = process.env.HUB_TOKEN ?? "dev-token";
const WORKER_PATH = "/worker";

if (TOKEN === "dev-token") {
  console.warn("[hub] WARNING: using default token, set HUB_TOKEN in production");
}

const clients = new Set<WebSocket>();
const rooms = new RoomManager();
const agents = new Map<string, AcpAgent>();
const owners = new Map<string, string>();
const localStarts = new Map<string, Promise<void>>();
const store = new Store();
const modelManager = new ModelManager();
ensureDefaultLocalConnections();
const savedState = store.load();
const sessionMetas = new Map<string, SessionMeta>(
  savedState.sessions.map((s) => [s.sessionId, s]),
);
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

function enrichRoom(room: Room): Record<string, unknown> {
  const sub = roomModeManager.subModeFor(room.roomId);
  return { ...room, subMode: sub?.mode, activeSpeaker: sub?.activeSpeaker, reason: sub?.reason };
}

function persistState(): void {
  store.save({ sessions: [...sessionMetas.values()], rooms: rooms.list() });
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
        .catch((err) => console.warn("[role] persona inject failed:", String(err)));
    }
  }
  return s;
}

function ensureDefaultLocalConnections(): void {
  if (store.getMeta("default-connections-seeded") === "1") return;
  for (const agent of Object.keys(AGENT_DEFS)) {
    const id = `local-${agent}`;
    if (store.listConnections().some((c) => c.id === id)) continue;
    store.addConnection({
      id,
      name: `本地 ${agent}`,
      agent,
      token: randomBytes(16).toString("hex"),
      local: true,
    });
    console.log(`[hub] created default local connection: ${id}`);
  }
  store.setMeta("default-connections-seeded", "1");
}

async function startLocalAgent(connection: Connection): Promise<void> {
  const def = AGENT_DEFS[connection.agent];
  if (!def) throw new Error(`unknown agent type: ${connection.agent}`);

  const proc = spawn(def.bin, def.args, { stdio: ["pipe", "pipe", "inherit"] });
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
      agents.delete(connection.id);
      for (const [sid, cid] of [...owners.entries()]) {
        if (cid === connection.id) owners.delete(sid);
      }
    },
    proc,
    onTurnEnd,
  );

  agents.set(connection.id, a);

  a.ensureStarted().catch((err) => {
    console.warn(`[hub] local agent ${connection.id} failed:`, err);
    agents.delete(connection.id);
    for (const [sid, cid] of [...owners.entries()]) {
      if (cid === connection.id) owners.delete(sid);
    }
    try {
      proc.kill();
    } catch {}
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
const roomModeManager = new RoomModeManager(agentOps, rooms, (method, params) =>
  broadcast({ method, params } as HubEvent),
);

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

function onAgentEvent(event: HubEvent): void {
  const sessionId = (event.params as Record<string, unknown> | undefined)?.sessionId as string | undefined;
  let skipBroadcast =
    sessionId != null &&
    roomModeManager.isHiddenSession(sessionId) &&
    event.method !== "permission.request";
  if (event.method === "prompt.done") {
    const { output } = event.params;
    const meta = sessionMetas.get(sessionId!);
    const baseName = meta?.name ?? sessionId!;
    const origin = originFor(meta);
    const displayName = origin ? `${baseName} (${origin})` : baseName;
    if (!roomModeManager.isHiddenSession(sessionId!)) {
      rooms.recordOutput(sessionId!, displayName, output);
    }
    void roomModeManager.onPromptDone(sessionId!, output).catch((err) => {
      console.error("[room-modes] error:", err);
    });
  } else if (event.method === "prompt.error") {
    if (sessionId) {
      roomModeManager.onPromptError(sessionId);
    }
  } else if (event.method === "room.notice") {
    store.append("room", event.params.roomId, {
      at: Date.now(),
      kind: "system",
      author: "",
      text: event.params.message,
    });
  }
  if (!skipBroadcast) broadcast(event);
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
      if (role) {
        const personaPrompt =
          `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
        agentOps
          .prompt(s.sessionId, personaPrompt)
          .catch((err) => console.warn("[role] persona inject failed:", String(err)));
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

      if (source.roleId) {
        const role = store.listRoles().find((r) => r.id === source.roleId);
        if (role) {
          const personaPrompt =
            `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
          agentOps
            .prompt(s.sessionId, personaPrompt)
            .catch((err) => console.warn("[role] persona inject failed:", String(err)));
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
    case "room.update": {
      const roomId = String(req.params?.roomId ?? "");
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);
      const name = String(req.params?.name ?? "").trim() || room.name;
      const ids = (req.params?.sessionIds as string[]) ?? [];
      const mode = parseRoomMode(req.params?.mode);
      const conductorId =
        req.params?.conductorId != null ? String(req.params.conductorId) : undefined;
      const all = listAllSessions();
      const members = ids.map((id) => {
        const s = all.find((x) => x.sessionId === id);
        if (!s) throw new Error(`unknown session: ${id}`);
        return { sessionId: s.sessionId, name: s.name };
      });
      rooms.update(roomId, name, members, mode, conductorId);
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

      const newConductorId = source.conductorId
        ? idMap.get(source.conductorId)
        : undefined;
      const room = rooms.create(
        newName,
        newMembers,
        source.mode,
        newConductorId,
      );
      persistState();
      return { room };
    }
    case "connection.list":
      return {
        connections: store.listConnections().map((c) => ({
          ...c,
          online: agents.has(c.id),
          local: c.local ?? false,
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
      const ok = store.deleteConnection(id);
      if (!ok) throw new Error("connection not found");
      return { deleted: true };
    }
    case "history.search": {
      const query = String(req.params?.query ?? "").trim();
      if (!query) return { results: [] };
      return {
        results: store.search(query, Number(req.params?.limit ?? 50)),
      };
    }
    case "session.history":
      return {
        entries: store.read(
          "session",
          String(req.params?.sessionId ?? ""),
          Number(req.params?.limit ?? 200),
        ),
      };
    case "room.history":
      return {
        entries: store.read(
          "room",
          String(req.params?.roomId ?? ""),
          Number(req.params?.limit ?? 200),
        ),
      };
    case "room.create": {
      const name = String(req.params?.name ?? "群聊").trim() || "群聊";
      if (isRoomNameTaken(name)) throw new Error("room name already exists");
      const ids = (req.params?.sessionIds as string[]) ?? [];
      const mode = parseRoomMode(req.params?.mode);
      const conductorId =
        req.params?.conductorId != null ? String(req.params.conductorId) : undefined;
      const all = listAllSessions();
      const members = ids.map((id) => {
        const s = all.find((x) => x.sessionId === id);
        if (!s) throw new Error(`unknown session: ${id}`);
        return { sessionId: s.sessionId, name: s.name };
      });
      const room = rooms.create(name, members, mode, conductorId);
      persistState();
      return { room: enrichRoom(room) };
    }
    case "room.list":
      return { rooms: rooms.list().map(enrichRoom) };
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
        sessionNote: (sid) => sessionLostReplyNote(sid),
      });
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
      console.warn(`[hub] permission bypass set to ${enabled}`);
      return { bypass: enabled };
    }
    case "model.list": {
      const models = await modelManager.list();
      const current = modelManager.current();
      return { current: current.uid, models };
    }
    case "model.current": {
      return modelManager.current();
    }
    case "model.refresh": {
      const models = await modelManager.refresh();
      return { current: modelManager.current().uid, models };
    }
    case "model.set": {
      const name = String(req.params?.model ?? "").trim();
      if (!name) throw new Error("model name required");
      const model = await modelManager.set(name);
      return { set: true, model };
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
  const reportedAgent = url.searchParams.get("agent") ?? undefined;
  const connection = getConnectionByToken(token);
  if (!connection) {
    console.warn("[hub] worker rejected: unknown token");
    ws.close(4001, "unauthorized");
    return;
  }
  if (reportedAgent && reportedAgent !== connection.agent) {
    console.warn(
      `[hub] worker token=${token} reported agent=${reportedAgent} but expected ${connection.agent}`,
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
  const a = new AcpAgent(connection.name, stream, onAgentEvent, undefined, undefined, onTurnEnd);
  agents.set(connectionId, a);
  a.ensureStarted().catch((err) => {
    console.warn(`[hub] worker ${connectionId} start failed:`, String(err));
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
