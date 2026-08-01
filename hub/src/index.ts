import { WebSocketServer, WebSocket } from "ws";
import { networkInterfaces } from "node:os";
import { AcpAgent, type HubEvent } from "./agent.js";
import { RoomManager } from "./room.js";
import { ConductorOrchestrator, type AgentOps } from "./conductor.js";
import { Store, type SessionMeta } from "./store.js";
import { startTunnel } from "./tunnel.js";

const PORT = Number(process.env.HUB_PORT ?? 8787);
const TOKEN = process.env.HUB_TOKEN ?? "dev-token";

if (TOKEN === "dev-token") {
  console.warn("[hub] WARNING: using default token, set HUB_TOKEN in production");
}

const AGENT_DEFS: Record<string, { bin: string; args: string[] }> = {
  devin: { bin: process.env.DEVIN_BIN ?? "devin", args: ["acp"] },
  claude: {
    bin: process.env.CLAUDE_ACP_BIN ?? "npx",
    args: process.env.CLAUDE_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@zed-industries/claude-code-acp",
    ],
  },
  codex: {
    bin: process.env.CODEX_ACP_BIN ?? "npx",
    args: process.env.CODEX_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@zed-industries/codex-acp",
    ],
  },
  opencode: {
    bin: process.env.OPENCODE_BIN ?? "opencode",
    args: process.env.OPENCODE_ARGS?.split(" ") ?? ["acp"],
  },
};

const clients = new Set<WebSocket>();
const rooms = new RoomManager();
const agents = new Map<string, AcpAgent>();
const owners = new Map<string, string>();
const store = new Store();
const savedState = store.load();
const sessionMetas = new Map<string, SessionMeta>(
  savedState.sessions.map((s) => [s.sessionId, s]),
);
for (const room of savedState.rooms) rooms.import(room);

function persistState(): void {
  store.save({ sessions: [...sessionMetas.values()], rooms: rooms.list() });
}

const agentOps: AgentOps = {
  prompt: (sessionId, text) => ownerOf(sessionId).prompt(sessionId, text),
  isBusy: (sessionId) => ownerOf(sessionId).isBusy(sessionId),
};
const conductor = new ConductorOrchestrator(agentOps, rooms, (n) =>
  broadcast({ method: "room.notice", params: n }),
);

function getAgent(key: string): AcpAgent {
  let a = agents.get(key);
  if (!a) {
    const def = AGENT_DEFS[key];
    if (!def) throw new Error(`unknown agent type: ${key}`);
    a = new AcpAgent(def.bin, def.args, onAgentEvent);
    agents.set(key, a);
  }
  return a;
}

function ownerOf(sessionId: string): AcpAgent {
  const key = owners.get(sessionId);
  if (!key) throw new Error(`unknown session: ${sessionId}`);
  return agents.get(key)!;
}

function listAllSessions(): {
  sessionId: string;
  cwd: string;
  name: string;
  busy: boolean;
  agent: string;
  offline: boolean;
  archived: boolean;
}[] {
  const online = [...agents.entries()].flatMap(([key, a]) =>
    a.listSessions().map((s) => ({
      ...s,
      agent: key,
      offline: false,
      archived: sessionMetas.get(s.sessionId)?.archived ?? false,
    })),
  );
  const onlineIds = new Set(online.map((s) => s.sessionId));
  const offline = [...sessionMetas.values()]
    .filter((m) => !onlineIds.has(m.sessionId))
    .map((m) => ({ ...m, busy: false, offline: true, archived: m.archived ?? false }));
  return [...online, ...offline];
}

function onAgentEvent(event: HubEvent): void {
  if (event.method === "prompt.done") {
    const { sessionId, output } = event.params;
    const name =
      listAllSessions().find((s) => s.sessionId === sessionId)?.name ?? sessionId;
    rooms.recordOutput(sessionId, name, output);
    if (output.trim()) {
      store.append("session", sessionId, {
        at: Date.now(),
        kind: "assistant",
        author: name,
        text: output,
      });
      for (const room of rooms.roomsFor(sessionId)) {
        store.append("room", room.roomId, {
          at: Date.now(),
          kind: "assistant",
          author: name,
          text: output,
        });
      }
    }
    void conductor.onPromptDone(sessionId, output).catch((err) => {
      console.error("[conductor] error:", err);
    });
  } else if (event.method === "room.notice") {
    store.append("room", event.params.roomId, {
      at: Date.now(),
      kind: "system",
      author: "",
      text: event.params.message,
    });
  }
  broadcast(event);
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
      const agentKey = String(req.params?.agent ?? role?.agent ?? "devin");
      const cwd = String(req.params?.cwd ?? role?.cwd ?? "");
      const name = req.params?.name ? String(req.params.name) : role?.name;
      const s = await getAgent(agentKey).createSession(cwd, name);
      sessionMetas.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd,
        name: s.name,
        agent: agentKey,
      });
      owners.set(s.sessionId, agentKey);
      persistState();
      if (role) {
        const personaPrompt =
          `${role.persona}\n\n（以上是角色设定，请只回复一句话确认已就绪）`;
        agentOps
          .prompt(s.sessionId, personaPrompt)
          .catch((err) => console.warn("[role] persona inject failed:", String(err)));
      }
      return s;
    }
    case "role.list":
      return { roles: store.listRoles() };
    case "role.create": {
      const name = String(req.params?.name ?? "").trim();
      const persona = String(req.params?.persona ?? "").trim();
      if (!name || !persona) throw new Error("name and persona required");
      const id = `custom-${Date.now().toString(36)}`;
      store.addRole({
        id,
        name,
        persona,
        agent: req.params?.agent ? String(req.params.agent) : undefined,
        cwd: req.params?.cwd ? String(req.params.cwd) : undefined,
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
      const ok = await getAgent(meta.agent).resumeSession(
        meta.sessionId,
        meta.cwd,
        meta.name,
      );
      if (ok) owners.set(sessionId, meta.agent);
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
      const ownerKey = owners.get(sessionId);
      if (ownerKey) agents.get(ownerKey)?.dropSession(sessionId);
      owners.delete(sessionId);
      sessionMetas.delete(sessionId);
      store.deleteHistory("session", sessionId);
      const dissolved = rooms.removeMember(sessionId);
      for (const roomId of dissolved) store.deleteHistory("room", roomId);
      persistState();
      return { deleted: true, dissolvedRooms: dissolved };
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
    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
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
  }
  if (process.env.HUB_TUNNEL === "1") {
    startTunnel(PORT, TOKEN);
  }
});
