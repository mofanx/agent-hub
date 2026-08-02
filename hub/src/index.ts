import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, getPermissionBypass, setPermissionBypass, type HubEvent } from "./agent.js";
import { RoomManager, type Room } from "./room.js";
import { ConductorOrchestrator, type AgentOps } from "./conductor.js";
import { Store, type SessionMeta, type Connection } from "./store.js";
import { startTunnel } from "./tunnel.js";
import { webSocketStream } from "./stream.js";
import { AGENT_DEFS } from "./agent-defs.js";

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
ensureDefaultLocalConnections();
const savedState = store.load();
const sessionMetas = new Map<string, SessionMeta>(
  savedState.sessions.map((s) => [s.sessionId, s]),
);
for (const room of savedState.rooms) rooms.import(room);

function persistState(): void {
  store.save({ sessions: [...sessionMetas.values()], rooms: rooms.list() });
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
    },
    proc,
  );

  agents.set(connection.id, a);

  a.ensureStarted().catch((err) => {
    console.warn(`[hub] local agent ${connection.id} failed:`, err);
    agents.delete(connection.id);
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
  prompt: (sessionId, text) => ownerOf(sessionId).prompt(sessionId, text),
  isBusy: (sessionId) => ownerOf(sessionId).isBusy(sessionId),
};
const conductor = new ConductorOrchestrator(agentOps, rooms, (n) =>
  broadcast({ method: "room.notice", params: n }),
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

function isConductorMemberSession(sessionId: string): boolean {
  const roomsFor = rooms.roomsFor(sessionId);
  const isConductor = roomsFor.some(
    (r) => r.mode === "conductor" && r.conductorId === sessionId,
  );
  const isMember = roomsFor.some(
    (r) => r.mode === "conductor" && r.conductorId !== sessionId,
  );
  return isMember && !isConductor;
}

function onAgentEvent(event: HubEvent): void {
  let skipBroadcast = false;
  if (event.method === "prompt.done") {
    const { sessionId, output } = event.params;
    const meta = sessionMetas.get(sessionId);
    const baseName = meta?.name ?? sessionId;
    const origin = originFor(meta);
    const displayName = origin ? `${baseName} (${origin})` : baseName;
    rooms.recordOutput(sessionId, displayName, output);
    if (output.trim()) {
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "assistant",
        author: displayName,
        text: output,
      });
      for (const room of rooms.roomsFor(sessionId)) {
        if (room.mode === "conductor" && room.conductorId !== sessionId) continue;
        store.append("room", room.roomId, {
          at: Date.now(),
          kind: "assistant",
          author: displayName,
          text: output,
        });
      }
      skipBroadcast = isConductorMemberSession(sessionId);
    }
    void conductor.onPromptDone(sessionId, output).catch((err) => {
      console.error("[conductor] error:", err);
    });
  } else if (event.method === "prompt.error") {
    const { sessionId } = event.params;
    if (sessionId) {
      conductor.onPromptError(sessionId);
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

  // 如果是指挥家群，中断当前编排流
  const flowCancelled =
    room.mode === "conductor" && conductor.cancel(room.roomId);

  const stoppedNames = stopped.map(
    (sid) => room.members.find((m) => m.sessionId === sid)?.name ?? sid,
  );

  let notice: string;
  if (stopped.length > 0) {
    notice = `已停止: ${stoppedNames.join(", ")}`;
    if (flowCancelled) notice += "；指挥编排已中断";
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
      const s = await agent.createSession(cwd, name);
      sessionMetas.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd,
        name: s.name,
        agent: connection.agent,
        connectionId: connection.id,
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
      return { ...s, agent: connection.agent, connectionId: connection.id };
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
      const ok = await agent.resumeSession(meta.sessionId, meta.cwd, meta.name);
      if (ok) owners.set(sessionId, connectionId);
      return { resumed: ok };
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
      const name = String(req.params?.name ?? "群聊");
      const ids = (req.params?.sessionIds as string[]) ?? [];
      const mode = req.params?.mode === "conductor" ? "conductor" : "mention";
      const conductorId =
        req.params?.conductorId != null ? String(req.params.conductorId) : undefined;
      const all = listAllSessions();
      const members = ids.map((id) => {
        const s = all.find((x) => x.sessionId === id);
        if (!s) throw new Error(`unknown session: ${id}`);
        return { sessionId: s.sessionId, name: s.name };
      });
      if (members.length < 2) throw new Error("room needs at least 2 sessions");
      if (mode === "conductor") {
        if (!conductorId || !members.some((m) => m.sessionId === conductorId)) {
          throw new Error("conductor room needs a valid conductorId");
        }
      }
      const room = rooms.create(name, members, mode, conductorId);
      persistState();
      return { room };
    }
    case "room.list":
      return { rooms: rooms.list() };
    case "room.message": {
      const roomId = String(req.params?.roomId ?? "");
      const text = String(req.params?.text ?? "");
      const quote = req.params?.quote as
        | { author: string; text: string }
        | undefined;
      const room = rooms.get(roomId);
      if (!room) throw new Error(`unknown room: ${roomId}`);

      const slash = parseSlash(text);
      if (slash?.command === "stop") {
        return handleRoomSlash(room, slash, text, quote);
      }

      store.append("room", roomId, {
        at: Date.now(),
        kind: "user",
        author: "我",
        text: quote ? `（引用 ${quote.author}: ${quote.text.slice(0, 100)}）${text}` : text,
      });
      const { targets, mentioned } = rooms.route(roomId, text);
      if (room.mode === "conductor" && mentioned.length === 0) {
        if (conductor.hasActiveFlow(roomId)) {
          throw new Error("指挥家正在编排中，请等本轮完成");
        }
        await conductor.start(room, quote
          ? `${text}\n（用户引用了 ${quote.author} 的消息："${quote.text}"）`
          : text);
        return { sent: [room.conductorId], mentioned: [], skipped: [] };
      }
      const sent: string[] = [];
      const skipped: string[] = [];
      for (const sid of targets) {
        if (agentOps.isBusy(sid)) {
          skipped.push(sid);
          continue;
        }
        const prompt = rooms.buildPrompt(roomId, text, sid, quote);
        await agentOps.prompt(sid, prompt);
        sent.push(sid);
      }
      if (skipped.length > 0) {
        broadcast({
          method: "prompt.error",
          params: {
            sessionId: skipped[0] ?? "",
            message: `跳过忙碌会话: ${skipped.join(", ")}`,
          },
        });
      }
      return { sent, mentioned, skipped };
    }
    case "prompt.send": {
      const sessionId = String(req.params?.sessionId ?? "");
      const text = String(req.params?.text ?? "");
      const slash = parseSlash(text);
      if (slash?.command === "stop") {
        return handleSessionSlash(sessionId, slash);
      }
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "user",
        author: "我",
        text,
      });
      await agentOps.prompt(sessionId, text);
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
  const a = new AcpAgent(connection.name, stream, onAgentEvent);
  agents.set(connectionId, a);
  a.ensureStarted().catch((err) => {
    console.warn(`[hub] worker ${connectionId} start failed:`, String(err));
    agents.delete(connectionId);
    ws.close();
  });
  ws.on("close", () => {
    console.log(`[hub] worker disconnected ${connectionId}`);
    if (agents.get(connectionId) === a) agents.delete(connectionId);
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
