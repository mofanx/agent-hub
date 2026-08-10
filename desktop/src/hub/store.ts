import { create } from "zustand";
import type {
  AppConfig,
  ChatItem,
  ConnProfile,
  ConnectionInfo,
  ContextUsage,
  FlowInfo,
  ModelInfo,
  Attachment,
  RoomInfo,
  RoomModeConfig,
  RoleInfo,
  Screen,
  SearchHit,
  SessionInfo,
  SlashCommand,
} from "./types";
import { HubClient } from "./client";
import {
  loadConfig,
  saveConfig,
  setTrayTooltip,
  showNotification,
  requestNotificationPermission,
  isNotificationPermissionGranted,
} from "./commands";
import { stringsFor } from "./strings";

type SelectedIds = { sessions: string[]; rooms: string[] };

interface State {
  client: HubClient | null;
  profiles: ConnProfile[];
  pinnedIds: string[];
  recentCwds: string[];
  customCommands: string[];
  defaultCommands: string[];
  screen: Screen;
  themeMode: string;
  lang: string;
  connecting: boolean;
  connectError: string | null;
  agentStatus: string;
  sessions: SessionInfo[];
  rooms: RoomInfo[];
  roles: RoleInfo[];
  connections: ConnectionInfo[];
  currentSession: SessionInfo | null;
  currentRoom: RoomInfo | null;
  chatItems: ChatItem[];
  busyIds: string[];
  quote: [string, string] | null;
  searchResults: SearchHit[];
  selectedIds: SelectedIds;
  itemSeq: number;
  drawerOpen: boolean;
  currentProfile: ConnProfile | null;
  flow: FlowInfo | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  sessionUsage: Record<string, ContextUsage>;
  modelList: ModelInfo[];
  modelCurrent: string;
  modelFilter: string;
  showModelPicker: boolean;
  pendingAttachments: Attachment[];
}

interface Actions {
  init(): Promise<void>;
  loadConfigFromDisk(): Promise<void>;
  persistConfig(): Promise<void>;

  togglePin(sessionId: string): void;
  noteCwd(cwd: string): void;
  removeCwd(cwd: string): void;
  addCommand(text: string): void;
  removeCommand(text: string): void;
  deleteProfile(p: ConnProfile): void;
  updateThemeMode(mode: string): void;
  updateLang(lang: string): void;

  connect(host: string, port: string, token: string, name?: string): void;
  disconnect(): void;
  toggleDrawer(): void;
  closeDrawer(): void;
  switchProfile(p: ConnProfile): void;
  refreshAll(): Promise<void>;
  refreshBusy(): void;

  createSession(
    cwd: string,
    name: string,
    connectionId: string,
    roleId?: string,
  ): Promise<void>;
  createRole(
    name: string,
    persona: string,
    cwd: string,
    connectionId?: string,
  ): Promise<void>;
  createConnection(
    name: string,
    agent: string,
    address: string,
    cwd: string,
    token?: string,
    local?: boolean,
  ): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  deleteRole(id: string): Promise<void>;
  createRoom(
    name: string,
    memberIds: string[],
    mode: string,
    config?: RoomModeConfig,
    memberRoles?: Record<string, string>,
  ): Promise<void>;

  openChat(session: SessionInfo): void;
  openRoom(room: RoomInfo): void;
  resumeSession(session: SessionInfo): Promise<void>;
  archiveSession(session: SessionInfo, archived: boolean): Promise<void>;
  archiveRoom(room: RoomInfo, archived: boolean): Promise<void>;
  deleteSession(session: SessionInfo): Promise<void>;
  deleteSessions(sessionIds: string[]): Promise<void>;
  deleteRooms(roomIds: string[]): Promise<void>;
  batchDelete(sessionIds: string[], roomIds: string[]): Promise<void>;

  sendPrompt(text: string): void;
  sendRoomMessage(text: string): void;
  stopCurrent(): void;
  answerPermission(requestId: string, optionId: string, optionName: string): void;

  search(query: string): Promise<void>;
  openSearchHit(hit: SearchHit): void;
  backToList(): void;

  toggleBypass(arg?: string): void;
  setQuote(quote: [string, string] | null): void;

  selectSession(id: string): void;
  selectRoom(id: string): void;
  clearSelection(): void;

  sessionName(sessionId: string): string;
  sessionOrigin(s: SessionInfo): string;
  displayName(s: SessionInfo): string;
  slashCommands: SlashCommand[];
  isGenerating(): boolean;

  inScope(sessionId: string): boolean;
  shouldShowInRoom(sessionId: string): boolean;
  applyUpdate(sessionId: string, u: Record<string, unknown>): void;
  loadHistory(method: string, idKey: string, id: string): Promise<void>;
  loadMoreHistory(method: string, idKey: string, id: string): Promise<void>;
  syncBusyIdsFromList(list: SessionInfo[]): void;
  syncBusyIds(): Promise<void>;
  handleSlashCommand(text: string): boolean;
  saveProfileAndConnect(address: string, port: string, token: string, name?: string): void;
  refreshFlow(roomId: string): Promise<void>;
  setFlow(flow: FlowInfo | null): void;

  showModelPickerDialog(): Promise<void>;
  refreshModelList(): Promise<void>;
  switchModel(model: ModelInfo): Promise<void>;
  closeModelPicker(): void;

  addAttachment(attachment: Attachment): void;
  removeAttachment(attachment: Attachment): void;
  clearAttachments(): void;
}

const defaultConfig: AppConfig = {
  profiles: [],
  pinned: [],
  cwds: [],
  commands: [],
  theme: "system",
  lang: "zh",
  last: null,
};

function profileKey(p: ConnProfile): string {
  return `${p.address}\u0001${p.port}`;
}

function findLastIndex<T>(arr: T[], pred: (it: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

export const useHubStore = create<State & Actions>((set, get) => {
  const ensurePermission = async () => {
    try {
      const granted = await isNotificationPermissionGranted();
      if (!granted) await requestNotificationPermission();
    } catch {}
  };

  const updateTray = () => {
    const status = get().agentStatus;
    setTrayTooltip(`Agent Hub - ${status}`).catch(() => {});
  };

  const persist = async () => {
    const { profiles, pinnedIds, recentCwds, customCommands, themeMode, lang } = get();
    const cfg: AppConfig = {
      profiles,
      pinned: pinnedIds,
      cwds: recentCwds,
      commands: customCommands,
      theme: themeMode,
      lang,
      last: defaultConfig.last,
    };
    try {
      await saveConfig(JSON.stringify(cfg));
    } catch {}
  };

  const saveLastProfile = async (address: string, port: string, token: string) => {
    const cfg: AppConfig = {
      ...defaultConfig,
      profiles: get().profiles,
      pinned: get().pinnedIds,
      cwds: get().recentCwds,
      commands: get().customCommands,
      theme: get().themeMode,
      lang: get().lang,
      last: { address, port, token },
    };
    try {
      await saveConfig(JSON.stringify(cfg));
    } catch {}
  };

  const handleEvent = (obj: Record<string, unknown>) => {
    const method = typeof obj.method === "string" ? obj.method : "";
    const params = (obj.params as Record<string, unknown> | undefined) ?? {};

    switch (method) {
      case "agent.status": {
        const status = String(params.status ?? "");
        const detail = params.detail ? ` (${params.detail})` : "";
        set({ agentStatus: `${status}${detail}` });
        updateTray();
        get().refreshAll();
        break;
      }
      case "session.generating": {
        const sid = String(params.sessionId ?? "");
        const stoppable = params.stoppable === true;
        if (!get().inScope(sid)) return;
        if (stoppable) {
          if (!get().busyIds.includes(sid)) {
            set({ busyIds: [...get().busyIds, sid] });
          }
        } else {
          set({ busyIds: get().busyIds.filter((id) => id !== sid) });
          get().refreshAll();
        }
        break;
      }
      case "session.update": {
        const sid = String(params.sessionId ?? "");
        if (!get().inScope(sid) || !get().shouldShowInRoom(sid)) return;
        const update = (params.update as Record<string, unknown> | undefined) ?? {};
        get().applyUpdate(sid, update);
        break;
      }
      case "prompt.done": {
        const sid = String(params.sessionId ?? "");
        set({ busyIds: get().busyIds.filter((id) => id !== sid) });
        get().refreshAll();
        if (params.usage) {
          const usage = params.usage as Record<string, unknown>;
          const items = [...get().chatItems];
          for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (it.kind === "assistant" && it.author === get().sessionName(sid)) {
              items[i] = { ...it, usage: parseTokenUsage(usage) };
              break;
            }
          }
          set({ chatItems: items });
        }
        if (params.output) {
          const title = get().sessionName(sid);
          const body = String(params.output).slice(0, 300);
          showNotification(title, body).catch(() => {});
        }
        break;
      }
      case "session.usage": {
        const sid = String(params.sessionId ?? "");
        const raw = params.usage as Record<string, unknown> | undefined;
        if (raw) {
          set({
            sessionUsage: { ...get().sessionUsage, [sid]: parseContextUsage(raw) },
          });
        }
        break;
      }
      case "prompt.error": {
        const sid = String(params.sessionId ?? "");
        set({ busyIds: get().busyIds.filter((id) => id !== sid) });
        if ((get().inScope(sid) || !sid) && get().shouldShowInRoom(sid)) {
          const msg = String(params.message ?? "error");
          const author = get().sessionName(sid);
          const next: ChatItem = { kind: "error", text: msg, author };
          set({ chatItems: [...get().chatItems, next] });
        }
        break;
      }
      case "room.notice": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          const msg = String(params.message ?? "");
          const next: ChatItem = { kind: "system", text: msg, author: "" };
          set({ chatItems: [...get().chatItems, next] });
        }
        break;
      }
      case "room.flowUpdate": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          set({ flow: (params.flow as FlowInfo) ?? null });
        }
        break;
      }
      case "permission.request": {
        const sid = String(params.sessionId ?? "");
        if (!get().inScope(sid)) return;
        if (!get().busyIds.includes(sid)) {
          set({ busyIds: [...get().busyIds, sid] });
        }
        const toolCall = (params.toolCall as Record<string, unknown> | undefined) ?? {};
        const title = String(toolCall.title ?? stringsFor(get().lang).permissionRequest);
        const options = ((params.options as unknown[] | undefined) ?? []).map((it) => {
          const o = it as Record<string, unknown>;
          return [String(o.optionId ?? ""), String(o.name ?? "")] as [string, string];
        });
        const requestId = String(params.requestId ?? "");
        const next: ChatItem = {
          kind: "permission",
          requestId,
          title,
          options,
          answered: null,
          author: get().sessionName(sid),
        };
        set({ chatItems: [...get().chatItems, next] });
        ensurePermission().then(() => {
          showNotification(`审批请求 · ${get().sessionName(sid)}`, title).catch(() => {});
        });
        break;
      }
    }
  };

  const getOrCall = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    const client = get().client;
    if (!client || !client.isConnected) throw new Error("not connected");
    const resp = await client.call(method, params);
    return resp as T;
  };

  const parseConnection = (o: Record<string, unknown>): ConnectionInfo => ({
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    agent: String(o.agent ?? ""),
    token: String(o.token ?? ""),
    address: String(o.address ?? ""),
    cwd: String(o.cwd ?? ""),
    online: o.online === true,
    local: o.local === true,
    error: o.error ? String(o.error) : undefined,
  });

  const parseSession = (o: Record<string, unknown>): SessionInfo => ({
    sessionId: String(o.sessionId ?? ""),
    cwd: String(o.cwd ?? ""),
    name: String(o.name ?? ""),
    busy: o.busy === true,
    agent: String(o.agent ?? "devin"),
    address: String(o.address ?? ""),
    connectionId: o.connectionId ? String(o.connectionId) : null,
    offline: o.offline === true,
    archived: o.archived === true,
  });

  const parseRoom = (o: Record<string, unknown>): RoomInfo => {
    const members = ((o.members as unknown[] | undefined) ?? []).map((it) => {
      const m = it as Record<string, unknown>;
      return [String(m.sessionId ?? ""), String(m.name ?? "")] as [string, string];
    });
    const stringOrNull = (v: unknown) => (v ? String(v) : null);
    const numberOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const parsePipelineOrder = (v: unknown): string[] | null => {
      if (!Array.isArray(v)) return null;
      return v.map((s) => String(s)).filter(Boolean);
    };
    const parseDebateSides = (v: unknown): [string, string] | null => {
      if (!Array.isArray(v) || v.length < 2) return null;
      return [String(v[0]), String(v[1])] as [string, string];
    };
    const parseMemberRoles = (v: unknown): Record<string, string> | null => {
      if (typeof v !== "object" || !v) return null;
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && val.trim()) out[k] = val.trim();
      }
      return Object.keys(out).length > 0 ? out : null;
    };
    return {
      roomId: String(o.roomId ?? ""),
      name: String(o.name ?? ""),
      mode: String(o.mode ?? "mention"),
      activeSpeaker: stringOrNull(o.activeSpeaker),
      conductorId: stringOrNull(o.conductorId),
      members,
      archived: o.archived === true,
      memberRoles: parseMemberRoles(o.memberRoles),
      parallelSummarizerId: stringOrNull(o.parallelSummarizerId),
      pipelineOrder: parsePipelineOrder(o.pipelineOrder),
      debateSides: parseDebateSides(o.debateSides),
      debateJudge: stringOrNull(o.debateJudge),
      debateRounds: numberOrNull(o.debateRounds),
    };
  };

  const parseRole = (o: Record<string, unknown>): RoleInfo => ({
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    persona: String(o.persona ?? ""),
    cwd: o.cwd ? String(o.cwd) : null,
    agent: o.agent ? String(o.agent) : null,
    address: o.address ? String(o.address) : null,
    connectionId: o.connectionId ? String(o.connectionId) : null,
    builtin: o.builtin === true,
  });

  const numberOrZero = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const parseTokenUsage = (u: Record<string, unknown>) => ({
    inputTokens: numberOrZero(u.inputTokens),
    outputTokens: numberOrZero(u.outputTokens),
    totalTokens: numberOrZero(u.totalTokens),
    cachedReadTokens: typeof u.cachedReadTokens === "number" ? u.cachedReadTokens : undefined,
    cachedWriteTokens: typeof u.cachedWriteTokens === "number" ? u.cachedWriteTokens : undefined,
    thoughtTokens: typeof u.thoughtTokens === "number" ? u.thoughtTokens : undefined,
  });

  const parseContextUsage = (u: Record<string, unknown>): ContextUsage => {
    const cost =
      u.cost && typeof u.cost === "object" ? (u.cost as Record<string, unknown>) : undefined;
    return {
      used: numberOrZero(u.used),
      size: numberOrZero(u.size),
      costAmount: typeof cost?.amount === "number" ? cost.amount : undefined,
      costCurrency: typeof cost?.currency === "string" ? cost.currency : undefined,
    };
  };

  const parseAttachment = (o: Record<string, unknown>): Attachment => ({
    mimeType: String(o.mimeType ?? "image/png"),
    base64: String(o.base64 ?? ""),
    name: String(o.name ?? ""),
  });

  const parseModelInfo = (o: Record<string, unknown>): ModelInfo => ({
    uid: String(o.uid ?? ""),
    label: String(o.label ?? ""),
    family: String(o.family ?? ""),
    vendor: String(o.vendor ?? ""),
    slug: String(o.slug ?? ""),
    aliases: ((o.aliases as unknown[] | undefined) ?? []).map((it) => String(it)).filter(Boolean),
    costTier: String(o.costTier ?? ""),
    costSummary: typeof o.costSummary === "string" ? o.costSummary : undefined,
    isCurrent: o.isCurrent === true,
  });

  const store: State & Actions = {
    client: null,
    profiles: [],
    pinnedIds: [],
    recentCwds: [],
    customCommands: [],
    defaultCommands: [
      "继续",
      "总结目前的进展，列出下一步计划",
      "运行项目的测试并修复所有失败",
    ],
    screen: "connect",
    themeMode: "system",
    lang: "zh",
    connecting: false,
    connectError: null,
    agentStatus: stringsFor("zh").notConnected,
    sessions: [],
    rooms: [],
    roles: [],
    connections: [],
    currentSession: null,
    currentRoom: null,
    chatItems: [],
    busyIds: [],
    quote: null,
    searchResults: [],
    selectedIds: { sessions: [], rooms: [] },
    itemSeq: 0,
    drawerOpen: false,
    currentProfile: null,
    flow: null,
    historyHasMore: false,
    historyLoading: false,
    sessionUsage: {},
    modelList: [],
    modelCurrent: "",
    modelFilter: "",
    showModelPicker: false,
    pendingAttachments: [],

    init: async () => {
      await get().loadConfigFromDisk();
      ensurePermission().catch(() => {});
      const { profiles } = get();
      if (profiles.length > 0) {
        const last = profiles[profiles.length - 1];
        // 不自动连接，仅回填最后一次使用的配置由界面处理
        void last;
      }
    },

    loadConfigFromDisk: async () => {
      try {
        const raw = await loadConfig();
        const cfg: Partial<AppConfig> = raw ? (JSON.parse(raw) as Partial<AppConfig>) : {};
        const S = stringsFor(cfg.lang ?? "zh");
        set({
          profiles: cfg.profiles ?? [],
          pinnedIds: cfg.pinned ?? [],
          recentCwds: cfg.cwds ?? [],
          customCommands: cfg.commands ?? [],
          themeMode: cfg.theme ?? "system",
          lang: cfg.lang ?? "zh",
          agentStatus: S.notConnected,
        });
      } catch {
        set({ agentStatus: stringsFor("zh").notConnected });
      }
    },

    persistConfig: persist,

    togglePin: (sessionId: string) => {
      const { pinnedIds } = get();
      const next = pinnedIds.includes(sessionId)
        ? pinnedIds.filter((id) => id !== sessionId)
        : [...pinnedIds, sessionId];
      set({ pinnedIds: next });
      persist();
    },

    noteCwd: (cwd: string) => {
      if (!cwd) return;
      const list = get().recentCwds.filter((c) => c !== cwd);
      list.unshift(cwd);
      while (list.length > 10) list.pop();
      set({ recentCwds: list });
      persist();
    },

    removeCwd: (cwd: string) => {
      set({ recentCwds: get().recentCwds.filter((c) => c !== cwd) });
      persist();
    },

    addCommand: (text: string) => {
      if (!text || get().customCommands.includes(text)) return;
      set({ customCommands: [...get().customCommands, text] });
      persist();
    },

    removeCommand: (text: string) => {
      set({ customCommands: get().customCommands.filter((c) => c !== text) });
      persist();
    },

    deleteProfile: (p: ConnProfile) => {
      const current = get().currentProfile;
      if (current && profileKey(current) === profileKey(p)) {
        get().disconnect();
      }
      set({ profiles: get().profiles.filter((it) => profileKey(it) !== profileKey(p)) });
      persist();
    },

    updateThemeMode: (mode: string) => {
      set({ themeMode: mode });
      persist();
    },

    updateLang: (lang: string) => {
      set({ lang });
      persist();
    },

    connect: (host: string, port: string, token: string, name?: string) => {
      get().disconnect();
      set({ connecting: true, connectError: null });
      const url =
        host.startsWith("ws://") || host.startsWith("wss://")
          ? `${host}${host.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
          : `ws://${host}:${port}/?token=${encodeURIComponent(token)}`;

      const client = new HubClient({ heartbeatIntervalMs: 20000, maxReconnectDelayMs: 60000 });
      set({ client });

      client.addEventListener("event", (obj) => handleEvent(obj));
      client.addEventListener("close", () => {
        set({ agentStatus: stringsFor(get().lang).agentDisconnected });
        updateTray();
      });
      client.addEventListener("error", (msg) => {
        if (get().connecting) set({ connectError: msg, connecting: false });
      });

      client.connect(
        url,
        () => {
          set({ connecting: false, connectError: null });
          get().saveProfileAndConnect(host, port, token, name);
        },
        (msg) => {
          set({ connecting: false, connectError: msg });
        },
      );
    },

    disconnect: () => {
      get().client?.disconnect();
      set({
        client: null,
        sessions: [],
        rooms: [],
        roles: [],
        connections: [],
        currentSession: null,
        currentRoom: null,
        chatItems: [],
        busyIds: [],
        quote: null,
        connecting: false,
        connectError: null,
        agentStatus: stringsFor(get().lang).notConnected,
        selectedIds: { sessions: [], rooms: [] },
        currentProfile: null,
        flow: null,
        sessionUsage: {},
        modelList: [],
        modelCurrent: "",
        modelFilter: "",
        showModelPicker: false,
        pendingAttachments: [],
      });
      updateTray();
    },

    toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),

    closeDrawer: () => set({ drawerOpen: false }),

    switchProfile: (p: ConnProfile) => {
      const current = get().currentProfile;
      if (current && profileKey(current) === profileKey(p)) return;
      get().connect(p.address, p.port, p.token, p.name);
    },

    refreshAll: async () => {
      const client = get().client;
      if (!client || !client.isConnected) return;

      try {
        const cList = (await client.call("connection.list")) as Record<string, unknown>;
        const conns = ((cList.connections as unknown[] | undefined) ?? []).map((it) =>
          parseConnection(it as Record<string, unknown>),
        );
        set({ connections: conns });
      } catch {}

      try {
        const sList = (await client.call("session.list")) as Record<string, unknown>;
        const list = ((sList.sessions as unknown[] | undefined) ?? []).map((it) =>
          parseSession(it as Record<string, unknown>),
        );
        set({ sessions: list });
        get().syncBusyIdsFromList(list);
      } catch {}

      try {
        const rList = (await client.call("role.list")) as Record<string, unknown>;
        const list = ((rList.roles as unknown[] | undefined) ?? []).map((it) =>
          parseRole(it as Record<string, unknown>),
        );
        set({ roles: list });
      } catch {}

      try {
        const rmList = (await client.call("room.list")) as Record<string, unknown>;
        const list = ((rmList.rooms as unknown[] | undefined) ?? []).map((it) =>
          parseRoom(it as Record<string, unknown>),
        );
        set({ rooms: list });
      } catch {}
    },

    refreshBusy: () => {
      const client = get().client;
      if (!client || !client.isConnected) return;
      get().syncBusyIds().catch(() => {});
    },

    createSession: async (cwd, name, connectionId, roleId) => {
      try {
        const result = await getOrCall<Record<string, unknown>>("session.create", {
          cwd,
          name,
          connectionId,
          ...(roleId ? { roleId } : {}),
        });
        const session: SessionInfo = {
          sessionId: String(result.sessionId ?? ""),
          cwd,
          name: String(result.name ?? name),
          busy: false,
          agent: String(result.agent ?? "devin"),
          address: String(result.address ?? ""),
          connectionId: result.connectionId ? String(result.connectionId) : null,
          offline: false,
          archived: false,
        };
        get().noteCwd(cwd);
        set({ sessions: [...get().sessions, session] });
        get().openChat(session);
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    createRole: async (name, persona, cwd, connectionId) => {
      try {
        await getOrCall("role.create", {
          name,
          persona,
          ...(cwd ? { cwd } : {}),
          ...(connectionId ? { connectionId } : {}),
        });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    createConnection: async (name, agent, address, cwd, token = "", local = false) => {
      try {
        await getOrCall("connection.create", {
          name,
          agent,
          ...(address ? { address } : {}),
          ...(cwd ? { cwd } : {}),
          ...(token ? { token } : {}),
          ...(local ? { local: true } : {}),
        });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteConnection: async (id: string) => {
      try {
        await getOrCall("connection.delete", { id });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteRole: async (id: string) => {
      try {
        await getOrCall("role.delete", { id });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    createRoom: async (name, memberIds, mode, config, memberRoles) => {
      try {
        const params: Record<string, unknown> = { name, sessionIds: memberIds, mode };
        if (config?.conductorId) params.conductorId = config.conductorId;
        if (config?.parallelSummarizerId) params.parallelSummarizerId = config.parallelSummarizerId;
        if (config?.pipelineOrder?.length) params.pipelineOrder = config.pipelineOrder;
        if (config?.debateSides?.length === 2) params.debateSides = config.debateSides;
        if (config?.debateJudge) params.debateJudge = config.debateJudge;
        if (config?.debateRounds != null) params.debateRounds = config.debateRounds;
        if (memberRoles && Object.keys(memberRoles).length > 0) params.memberRoles = memberRoles;
        const result = (await getOrCall("room.create", params)) as Record<string, unknown>;
        const room = parseRoom((result.room as Record<string, unknown>) ?? {});
        set({ rooms: [...get().rooms, room] });
        get().openRoom(room);
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    openChat: (session: SessionInfo) => {
      set({
        currentSession: session,
        currentRoom: null,
        chatItems: [],
        quote: null,
        screen: "chat",
        historyHasMore: false,
        historyLoading: false,
      });
      get().loadHistory("session.history", "sessionId", session.sessionId);
    },

    openRoom: (room: RoomInfo) => {
      set({
        currentRoom: room,
        currentSession: null,
        chatItems: [],
        quote: null,
        screen: "room",
        flow: null,
        historyHasMore: false,
        historyLoading: false,
      });
      get().loadHistory("room.history", "roomId", room.roomId);
      get().refreshFlow(room.roomId);
    },

    resumeSession: async (session: SessionInfo) => {
      try {
        const result = (await getOrCall("session.resume", { sessionId: session.sessionId })) as Record<
          string,
          unknown
        >;
        if (result.resumed === true) {
          set({
            sessions: get().sessions.map((s) =>
              s.sessionId === session.sessionId ? { ...s, offline: false } : s,
            ),
          });
          get().openChat({ ...session, offline: false });
        } else {
          set({ connectError: "恢复失败：agent 不支持或会话已失效" });
        }
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    archiveSession: async (session, archived) => {
      try {
        await getOrCall("session.archive", { sessionId: session.sessionId, archived });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    archiveRoom: async (room, archived) => {
      try {
        await getOrCall("room.archive", { roomId: room.roomId, archived });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteSession: async (session) => {
      try {
        await getOrCall("session.delete", { sessionId: session.sessionId });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteSessions: async (sessionIds) => {
      try {
        await getOrCall("session.deleteBatch", { sessionIds });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteRooms: async (roomIds) => {
      try {
        await getOrCall("room.deleteBatch", { roomIds });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    batchDelete: async (sessionIds, roomIds) => {
      try {
        if (sessionIds.length) await getOrCall("session.deleteBatch", { sessionIds });
        if (roomIds.length) await getOrCall("room.deleteBatch", { roomIds });
        await get().refreshAll();
        set({ selectedIds: { sessions: [], rooms: [] } });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    sendPrompt: (text: string) => {
      const session = get().currentSession;
      if (!session) return;
      if (get().handleSlashCommand(text)) return;
      const q = get().quote;
      const atts = get().pendingAttachments;
      const userItem: ChatItem = {
        kind: "user",
        text,
        author: "我",
        attachments: atts.length ? atts : undefined,
        quoteAuthor: q?.[0],
        quoteText: q?.[1],
      };
      set({ chatItems: [...get().chatItems, userItem], quote: null, pendingAttachments: [] });
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text: q ? `（引用 ${q[0]} 的消息："${q[1].slice(0, 300)}"）\n${text}` : text });
      for (const a of atts) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: a.mimeType, data: a.base64 },
        });
      }
      if (!content.length) return;
      set({ busyIds: [...get().busyIds, session.sessionId] });

      getOrCall("prompt.send", { sessionId: session.sessionId, content }).catch((e) => {
        set({
          busyIds: get().busyIds.filter((id) => id !== session.sessionId),
          chatItems: [...get().chatItems, { kind: "error", text: String(e), author: "" }],
        });
      });
    },

    sendRoomMessage: (text: string) => {
      const room = get().currentRoom;
      if (!room) return;
      if (get().handleSlashCommand(text)) return;
      const q = get().quote;
      const atts = get().pendingAttachments;
      const userItem: ChatItem = {
        kind: "user",
        text,
        author: "我",
        attachments: atts.length ? atts : undefined,
        quoteAuthor: q?.[0],
        quoteText: q?.[1],
      };
      set({ chatItems: [...get().chatItems, userItem], quote: null, pendingAttachments: [] });

      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text });
      for (const a of atts) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: a.mimeType, data: a.base64 },
        });
      }

      const params: Record<string, unknown> = { roomId: room.roomId, text: text || "（图片）", content };
      if (q) {
        params.quote = { author: q[0], text: q[1] };
      }

      getOrCall("room.message", params)
        .then((result) => {
          const sent = (result as Record<string, unknown>).sent as string[] | undefined;
          if (sent) {
            const busy = new Set(get().busyIds);
            sent.forEach((id) => busy.add(id));
            set({ busyIds: Array.from(busy) });
          }
        })
        .catch((e) => {
          set({
            chatItems: [...get().chatItems, { kind: "error", text: String(e), author: "" }],
          });
        });
    },

    stopCurrent: () => {
      const room = get().currentRoom;
      const session = get().currentSession;
      const targets =
        room?.members
          .map((m) => m[0])
          .filter((id) => get().busyIds.includes(id)) ??
        (session && get().busyIds.includes(session.sessionId) ? [session.sessionId] : []);
      targets.forEach((sid) => {
        getOrCall("session.cancel", { sessionId: sid }).catch(() => {});
      });
    },

    answerPermission: (requestId, optionId, optionName) => {
      const idx = findLastIndex(
        get().chatItems,
        (it) => it.kind === "permission" && it.requestId === requestId,
      );
      if (idx >= 0) {
        const items = [...get().chatItems];
        const p = items[idx];
        if (p.kind === "permission") {
          items[idx] = { ...p, answered: optionName };
          set({ chatItems: items });
        }
      }
      getOrCall("permission.respond", { requestId, optionId }).catch(() => {});
    },

    search: async (query) => {
      try {
        const result = (await getOrCall("history.search", { query })) as Record<string, unknown>;
        const list = ((result.results as unknown[] | undefined) ?? []).map((it) => {
          const o = it as Record<string, unknown>;
          return {
            scope: String(o.scope ?? ""),
            scopeId: String(o.scopeId ?? ""),
            author: String(o.author ?? ""),
            text: String(o.text ?? ""),
          } as SearchHit;
        });
        set({ searchResults: list });
      } catch {}
    },

    openSearchHit: (hit) => {
      if (hit.scope === "session") {
        const s = get().sessions.find((it) => it.sessionId === hit.scopeId);
        if (s) get().openChat(s);
      } else {
        const r = get().rooms.find((it) => it.roomId === hit.scopeId);
        if (r) get().openRoom(r);
      }
    },

    backToList: () => {
      set({
        currentSession: null,
        currentRoom: null,
        screen: "sessions",
      });
      get().refreshAll();
    },

    toggleBypass: (arg) => {
      const client = get().client;
      if (!client || !client.isConnected) return;
      const enabled =
        arg === undefined
          ? undefined
          : ["on", "true", "1"].includes(arg.toLowerCase())
            ? true
            : ["off", "false", "0"].includes(arg.toLowerCase())
              ? false
              : undefined;
      client
        .call("permission.bypass", enabled === undefined ? {} : { enabled })
        .then((result) => {
          const bypass = result.bypass === true;
          const S = stringsFor(get().lang);
          set({
            chatItems: [...get().chatItems, { kind: "system", text: bypass ? S.bypassEnabled : S.bypassDisabled, author: "" }],
          });
        })
        .catch((e) => {
          set({
            chatItems: [...get().chatItems, { kind: "error", text: String(e), author: "" }],
          });
        });
    },

    setQuote: (quote: [string, string] | null) => set({ quote }),

    selectSession: (id: string) => {
      const { selectedIds } = get();
      const sessions = selectedIds.sessions.includes(id)
        ? selectedIds.sessions.filter((it) => it !== id)
        : [...selectedIds.sessions, id];
      set({ selectedIds: { ...selectedIds, sessions } });
    },

    selectRoom: (id: string) => {
      const { selectedIds } = get();
      const rooms = selectedIds.rooms.includes(id)
        ? selectedIds.rooms.filter((it) => it !== id)
        : [...selectedIds.rooms, id];
      set({ selectedIds: { ...selectedIds, rooms } });
    },

    clearSelection: () => set({ selectedIds: { sessions: [], rooms: [] } }),

    sessionName: (sessionId: string) => {
      const s = get().sessions.find((it) => it.sessionId === sessionId);
      if (s) return get().displayName(s);
      const r = get().currentRoom;
      if (r) {
        const m = r.members.find((it) => it[0] === sessionId);
        if (m) return m[1];
      }
      return sessionId;
    },

    sessionOrigin: (s) => {
      if (s.connectionId) {
        const c = get().connections.find((it) => it.id === s.connectionId);
        if (c) return c.name;
      }
      return s.address;
    },

    displayName: (s) => {
      const origin = get().sessionOrigin(s);
      return origin ? `${s.name} (${origin})` : s.name;
    },

    slashCommands: [],

    isGenerating: () => {
      const room = get().currentRoom;
      if (room) return room.members.some((m) => get().busyIds.includes(m[0]));
      const s = get().currentSession;
      return s ? get().busyIds.includes(s.sessionId) : false;
    },

    // internal helpers exposed for event handling
    inScope: (sessionId: string) => {
      const room = get().currentRoom;
      if (room) return room.members.some((m) => m[0] === sessionId);
      return get().currentSession?.sessionId === sessionId;
    },

    shouldShowInRoom: (sessionId: string) => {
      const room = get().currentRoom;
      if (!room) return true;
      if (room.mode !== "conductor") return true;
      return sessionId === room.conductorId;
    },

    applyUpdate: (sessionId: string, u: Record<string, unknown>) => {
      const author = get().sessionName(sessionId);
      const updateType = String(u.sessionUpdate ?? "");
      const items = [...get().chatItems];
      const seq = get().itemSeq;

      switch (updateType) {
        case "agent_message_chunk": {
          const text = String((u.content as Record<string, unknown> | undefined)?.text ?? "");
          if (!text) return;
          const last = items[items.length - 1];
          if (last?.kind === "assistant" && last.author === author) {
            items[items.length - 1] = { ...last, text: last.text + text };
            set({ chatItems: items });
          } else {
            set({
              chatItems: [...items, { kind: "assistant", id: seq + 1, text, author }],
              itemSeq: seq + 1,
            });
          }
          break;
        }
        case "agent_thought_chunk": {
          const text = String((u.content as Record<string, unknown> | undefined)?.text ?? "");
          if (!text) return;
          const last = items[items.length - 1];
          if (last?.kind === "thought" && last.author === author) {
            items[items.length - 1] = { ...last, text: last.text + text };
            set({ chatItems: items });
          } else {
            set({
              chatItems: [...items, { kind: "thought", id: seq + 1, text, author }],
              itemSeq: seq + 1,
            });
          }
          break;
        }
        case "tool_call": {
          set({
            chatItems: [
              ...items,
              {
                kind: "tool",
                toolCallId: String(u.toolCallId ?? ""),
                title: String(u.title ?? "tool"),
                status: String(u.status ?? "pending"),
                author,
              },
            ],
          });
          break;
        }
        case "tool_call_update": {
          const id = String(u.toolCallId ?? "");
          const idx = findLastIndex(items, (it) => it.kind === "tool" && it.toolCallId === id);
          if (idx >= 0) {
            const t = items[idx];
            if (t.kind === "tool") {
              items[idx] = {
                ...t,
                title: String(u.title ?? t.title),
                status: String(u.status ?? t.status),
              };
              set({ chatItems: items });
            }
          }
          break;
        }
        case "plan": {
          const entries = ((u.entries as unknown[] | undefined) ?? []).map((it) => {
            const e = it as Record<string, unknown>;
            const status = String(e.status ?? "");
            const content = String(e.content ?? "");
            return `[${status}] ${content}`;
          });
          set({
            chatItems: [...items, { kind: "plan", entries, author }],
          });
          break;
        }
      }
    },

    loadHistory: async (method, idKey, id) => {
      try {
        const result = (await getOrCall(method, { [idKey]: id })) as Record<string, unknown>;
        const entries = ((result.entries as unknown[] | undefined) ?? []).map((it) => {
          const o = it as Record<string, unknown>;
          return {
            kind: String(o.kind ?? ""),
            author: String(o.author ?? ""),
            text: String(o.text ?? ""),
            at: typeof o.at === "number" ? o.at : undefined,
          };
        });
        const chat: ChatItem[] = [];
        for (const e of entries) {
          const attachments = ((e as Record<string, unknown>).attachments as unknown[] | undefined)
            ?.map((it) => parseAttachment(it as Record<string, unknown>));
          switch (e.kind) {
            case "user":
              chat.push({ kind: "user", at: e.at, text: e.text, author: e.author, attachments });
              break;
            case "assistant": {
              const usage = (e as Record<string, unknown>).usage as Record<string, unknown> | undefined;
              chat.push({ kind: "assistant", at: e.at, id: 0, text: e.text, author: e.author, usage: usage ? parseTokenUsage(usage) : undefined });
              break;
            }
            case "system":
              chat.push({ kind: "system", at: e.at, text: e.text, author: e.author });
              break;
          }
        }
        set({ chatItems: chat, itemSeq: chat.length, historyHasMore: result.hasMore === true });
        get().syncBusyIds().catch(() => {});
      } catch {}
    },

    loadMoreHistory: async (method, idKey, id) => {
      if (get().historyLoading || !get().historyHasMore) return;
      const items = get().chatItems;
      const oldestAt = items[0]?.at;
      if (oldestAt == null) return;
      set({ historyLoading: true });
      try {
        const result = (await getOrCall(method, { [idKey]: id, before: oldestAt, limit: 50 })) as Record<string, unknown>;
        const entries = ((result.entries as unknown[] | undefined) ?? []).map((it) => {
          const o = it as Record<string, unknown>;
          return {
            kind: String(o.kind ?? ""),
            author: String(o.author ?? ""),
            text: String(o.text ?? ""),
            at: typeof o.at === "number" ? o.at : undefined,
          };
        });
        const more: ChatItem[] = [];
        for (const e of entries) {
          const attachments = ((e as Record<string, unknown>).attachments as unknown[] | undefined)
            ?.map((it) => parseAttachment(it as Record<string, unknown>));
          switch (e.kind) {
            case "user":
              more.push({ kind: "user", at: e.at, text: e.text, author: e.author, attachments });
              break;
            case "assistant": {
              const usage = (e as Record<string, unknown>).usage as Record<string, unknown> | undefined;
              more.push({ kind: "assistant", at: e.at, id: 0, text: e.text, author: e.author, usage: usage ? parseTokenUsage(usage) : undefined });
              break;
            }
            case "system":
              more.push({ kind: "system", at: e.at, text: e.text, author: e.author });
              break;
          }
        }
        set({ chatItems: [...more, ...items], historyHasMore: result.hasMore === true, historyLoading: false });
      } catch {
        set({ historyLoading: false });
      }
    },

    syncBusyIdsFromList: (list: SessionInfo[]) => {
      const room = get().currentRoom;
      const currentIds =
        room?.members.map((m) => m[0]) ??
        (get().currentSession ? [get().currentSession!.sessionId] : []);
      if (!currentIds.length) return;
      const busy = new Set(list.filter((s) => s.busy && currentIds.includes(s.sessionId)).map((s) => s.sessionId));
      set({ busyIds: get().busyIds.filter((id) => currentIds.includes(id) && busy.has(id) || !currentIds.includes(id)) });
    },

    syncBusyIds: async () => {
      const client = get().client;
      if (!client || !client.isConnected) return;
      try {
        const result = (await client.call("session.list")) as Record<string, unknown>;
        const list = ((result.sessions as unknown[] | undefined) ?? []).map((it) =>
          parseSession(it as Record<string, unknown>),
        );
        get().syncBusyIdsFromList(list);
      } catch {}
    },

    handleSlashCommand: (text: string) => {
      if (!text.startsWith("/")) return false;
      const parts = text
        .slice(1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const command = parts[0];
      const arg = parts[1];
      const S = stringsFor(get().lang);
      switch (command) {
        case "help": {
          const msg = `${S.slashHelpTitle}\n${S.slashHelpHelp}\n${S.slashHelpStop}\n${S.slashHelpBypass}\n${S.slashHelpModel}`;
          set({ chatItems: [...get().chatItems, { kind: "system", text: msg, author: "" }] });
          return true;
        }
        case "bypass":
          get().toggleBypass(arg);
          return true;
        case "stop":
          get().stopCurrent();
          return true;
        case "model":
        case "models":
          if (arg) {
            void getOrCall("model.set", { model: arg })
              .then((res) => {
                const model = (res as Record<string, unknown>).model as Record<string, unknown> | undefined;
                if (model) {
                  const uid = String(model.uid ?? arg);
                  const label = String(model.label ?? "");
                  const S = stringsFor(get().lang);
                  const costTier = String(model.costTier ?? "");
                  const costSummary = typeof model.costSummary === "string" ? model.costSummary : "";
                  const cost = [costTier, costSummary].filter(Boolean).join(" · ");
                  set({
                    chatItems: [...get().chatItems, { kind: "system", text: S.modelSwitched.replace("%s", uid).replace("%s", `${label} ${cost}`.trim()), author: "" }],
                    modelCurrent: uid,
                  });
                } else {
                  set({ chatItems: [...get().chatItems, { kind: "error", text: S.modelUnknown.replace("%s", arg), author: "" }] });
                }
              })
              .catch((e) => {
                set({ chatItems: [...get().chatItems, { kind: "error", text: S.modelListError.replace("%s", String(e.message ?? e)), author: "" }] });
              });
          } else {
            void get().showModelPickerDialog();
          }
          return true;
        default: {
          set({
            chatItems: [
              ...get().chatItems,
              { kind: "error", text: `/${command}\n${S.unknownCommandHint}`, author: "" },
            ],
          });
          return true;
        }
      }
    },

    refreshFlow: async (roomId: string) => {
      const client = get().client;
      if (!client) return;
      try {
        const result = (await client.call("room.flow", { roomId })) as Record<string, unknown>;
        const flow = result.flow as FlowInfo | undefined;
        set({ flow: flow ?? null });
      } catch {
        /* ignore */
      }
    },

    setFlow: (flow: FlowInfo | null) => {
      set({ flow });
    },

    saveProfileAndConnect: (address: string, port: string, token: string, name?: string) => {
      const derived = address
        .replace(/^wss?:\/\//, "")
      .split(/[\/\?:]/)[0];
      const profileName = name?.trim() || derived;
      let profiles = get().profiles.filter((p) => !(p.address === address && p.port === port));
      const profile: ConnProfile = { name: profileName, address, port, token };
      profiles = [...profiles, profile];
      set({ profiles, currentProfile: profile, drawerOpen: false });
      persist();
      saveLastProfile(address, port, token).catch(() => {});
      set({ screen: "sessions" });
      get().refreshAll();
    },

    showModelPickerDialog: async () => {
      await get().refreshModelList();
      set({ showModelPicker: true });
    },

    refreshModelList: async () => {
      try {
        const result = await getOrCall<Record<string, unknown>>("model.list");
        const current = String(result.current ?? "");
        const list = ((result.models as unknown[] | undefined) ?? []).map((it) =>
          parseModelInfo({ ...(it as Record<string, unknown>), isCurrent: (it as Record<string, unknown>).uid === current }),
        );
        set({ modelList: list, modelCurrent: current, modelFilter: "" });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    switchModel: async (model: ModelInfo) => {
      try {
        await getOrCall("model.set", { model: model.uid });
        set({
          showModelPicker: false,
          modelCurrent: model.uid,
          modelList: get().modelList.map((m) => ({ ...m, isCurrent: m.uid === model.uid })),
        });
        const S = stringsFor(get().lang);
        set({ chatItems: [...get().chatItems, { kind: "system", text: S.modelSwitched.replace("%s", model.label).replace("%s", model.uid), author: "" }] });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    closeModelPicker: () => set({ showModelPicker: false, modelFilter: "" }),

    addAttachment: (attachment: Attachment) => {
      set({ pendingAttachments: [...get().pendingAttachments, attachment] });
    },

    removeAttachment: (attachment: Attachment) => {
      set({ pendingAttachments: get().pendingAttachments.filter((a) => a.base64 !== attachment.base64) });
    },

    clearAttachments: () => set({ pendingAttachments: [] }),
  };

  // derived slashCommands after store is created
  Object.defineProperty(store, "slashCommands", {
    get: () => {
      const S = stringsFor(get().lang);
      return [
        { name: "help", description: S.slashHelpHelp },
        { name: "stop", description: S.slashHelpStop },
        { name: "bypass", description: S.slashHelpBypass },
        { name: "model", description: S.slashHelpModel },
      ];
    },
  });

  return store;
});
