import { create } from "zustand";
import type {
  AppConfig,
  ArtifactInfo,
  BackendConfig,
  BlackboardInfo,
  ChatItem,
  ConnProfile,
  ConnectionInfo,
  ContextUsage,
  ElicitationField,
  ElicitationValue,
  EventInfo,
  FlowArtifact,
  FlowCardSnapshot,
  FlowInfo,
  ModelInfo,
  ModelBackend,
  BackendQuota,
  Attachment,
  RoomInfo,
  RoomModeConfig,
  RoleInfo,
  ScheduledTask,
  Screen,
  SearchGroup,
  SearchHit,
  SessionConfigOption,
  SessionInfo,
  SkillInfo,
  SlashCommand,
  TaskLog,
} from "./types";
import { KNOWN_AGENT_TYPES } from "./types";
import { HubClient } from "./client";
import {
  loadConfig,
  saveConfig,
  setTrayTooltip,
  setTrayMenu,
  showNotification,
  requestNotificationPermission,
  isNotificationPermissionGranted,
} from "./commands";
import { stringsFor, type Strings } from "./strings";

type SelectedIds = { sessions: string[]; rooms: string[] };

type ScopeSeen = {
  artifacts?: Set<string>;
  events?: Set<string>;
  board?: Set<string>;
  counts?: { artifact: number; event: number; blackboard: number };
};

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
  sendKey: "enter" | "ctrl-enter";
  connecting: boolean;
  connectError: string | null;
  agentStatus: string;
  sessions: SessionInfo[];
  rooms: RoomInfo[];
  roles: RoleInfo[];
  skills: SkillInfo[];
  connections: ConnectionInfo[];
  agentTypes: string[];
  currentSession: SessionInfo | null;
  currentRoom: RoomInfo | null;
  currentArtifacts: ArtifactInfo[] | null;
  currentEvents: EventInfo[] | null;
  blackboard: BlackboardInfo[] | null;
  chatItems: ChatItem[];
  busyIds: string[];
  quote: [string, string] | null;
  fileRefToInsert: string | null;
  /** 各类新增内容计数（打开对应面板时清零） */
  newCounts: { artifact: number; event: number; blackboard: number };
  searchQuery: string;
  searchResults: SearchHit[];
  searchGroups: SearchGroup[];
  jumpToAt: number | null;
  jumpQuery: string;
  selectedIds: SelectedIds;
  itemSeq: number;
  drawerOpen: boolean;
  currentProfile: ConnProfile | null;
  flow: FlowInfo | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  historySearchContext: boolean;
  sessionUsage: Record<string, ContextUsage>;
  modelList: ModelInfo[];
  modelCurrent: string;
  modelFilter: string;
  showModelPicker: boolean;
  /** 当前选中会话的非模型 ACP 配置项（mode/thought_level 等） */
  sessionConfigOptions: SessionConfigOption[];
  backendQuota: BackendQuota | null;
  editRoomTarget: RoomInfo | null;
  /** 群聊模式：成员模型信息（sessionId -> { name, backend, model }） */
  roomMemberModels: Record<string, { name: string; backend: string; model: string }>;
  /** 群聊模式：当前选中的成员标签 sessionId */
  selectedMemberSession: string | null;
  backends: BackendConfig[];
  pendingAttachments: Attachment[];
  historyCache: Record<string, ChatItem[]>;
  historyCacheKeys: string[];
  seenCache: Record<string, ScopeSeen>;
  fileUpdateAt: number;
  scheduledTasks: ScheduledTask[];
  taskLogs: TaskLog[];
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
  updateSendKey(key: "enter" | "ctrl-enter"): void;

  connect(address: string, token: string, name?: string): void;
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
  updateRoom(
    room: RoomInfo,
    name: string,
    memberIds: string[],
    mode: string,
    config?: RoomModeConfig,
    memberRoles?: Record<string, string>,
  ): Promise<void>;

  openChat(session: SessionInfo, anchorAt?: number): void;
  openRoom(room: RoomInfo, anchorAt?: number): Promise<void>;
  clearJumpToAt(): void;
  resumeSession(session: SessionInfo, autoOpen?: boolean): Promise<void>;
  resumeOne(session: SessionInfo): Promise<SessionInfo | null>;
  archiveSession(session: SessionInfo, archived: boolean): Promise<void>;
  archiveRoom(room: RoomInfo, archived: boolean): Promise<void>;
  deleteSession(session: SessionInfo): Promise<void>;
  deleteSessions(sessionIds: string[]): Promise<void>;
  deleteRooms(roomIds: string[]): Promise<void>;
  batchDelete(sessionIds: string[], roomIds: string[]): Promise<void>;
  renameSession(session: SessionInfo, name: string): Promise<void>;
  cloneSession(session: SessionInfo): Promise<SessionInfo | null>;
  renameRoom(room: RoomInfo, name: string): Promise<void>;
  cloneRoom(room: RoomInfo, newName: string): Promise<RoomInfo | null>;
  newChat(): void;

  sendPrompt(text: string): void;
  sendRoomMessage(text: string, opts?: { replyTo?: string }): void;
  stopCurrent(): void;
  cancelFlow(): Promise<void>;
  answerPermission(requestId: string, optionId: string, optionName: string): void;
  answerElicitation(
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, ElicitationValue>,
  ): void;

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
  loadHistory(method: string, idKey: string, id: string, anchorAt?: number): Promise<void>;
  loadMoreHistory(method: string, idKey: string, id: string): Promise<void>;
  /** 过程钻取：running 走 session.process（内存 buf），完成态走 session.history 时间窗；失败/不支持返回 null */
  fetchProcessItems(
    sessionId: string,
    opts?: { running?: boolean; from?: number; to?: number },
  ): Promise<ChatItem[] | null>;
  syncBusyIdsFromList(list: SessionInfo[]): void;
  syncBusyIds(): Promise<void>;
  handleSlashCommand(text: string): boolean;
  saveProfileAndConnect(address: string, token: string, name?: string): void;
  restoreCurrentScreen(): Promise<void>;
  refreshFlow(roomId: string): Promise<void>;
  setFlow(flow: FlowInfo | null): void;
  refreshArtifacts(scope: { roomId: string } | { sessionId: string }): Promise<void>;
  refreshSessionUsage(sessionId: string): Promise<void>;
  removeBlackboard(roomId: string, id: string): Promise<void>;
  clearBlackboard(roomId: string): Promise<void>;
  removeArtifact(roomId: string, artifactId: string): Promise<void>;
  clearArtifacts(roomId: string, kind?: "file" | "event"): Promise<void>;
  removeEvent(contextId: string, eventId: string): Promise<void>;
  clearEvents(contextId: string, action?: string): Promise<void>;
  quoteArtifact(artifact: ArtifactInfo): void;
  quoteEvent(event: EventInfo): void;
  quoteBlackboard(entry: BlackboardInfo): void;
  clearFileRef(): void;
  clearNewCounts(kind?: "artifact" | "event" | "blackboard"): void;
  deleteFile(contextId: string, isSession: boolean, path: string): Promise<void>;
  renameFile(contextId: string, isSession: boolean, from: string, to: string): Promise<void>;

  showModelPickerDialog(): Promise<void>;
  refreshModelList(): Promise<void>;
  refreshSessionConfigOptions(sessionId: string): Promise<void>;
  setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  refreshBackendQuota(force?: boolean): Promise<void>;
  refreshRoomMemberModels(): Promise<void>;
  refreshModelListForMember(sessionId: string): Promise<void>;
  switchModel(model: ModelInfo): Promise<void>;
  switchModelForMember(sessionId: string, model: ModelInfo): Promise<void>;
  selectMemberForModel(sessionId: string | null): void;
  closeModelPicker(): void;
  openEditRoomDialog(room: RoomInfo): void;
  closeEditRoomDialog(): void;
  listBackends(): Promise<void>;
  addBackend(backend: BackendConfig): Promise<void>;
  removeBackend(id: string): Promise<void>;
  toggleBackend(id: string): Promise<void>;

  addAttachment(attachment: Attachment): void;
  removeAttachment(attachment: Attachment): void;
  clearAttachments(): void;
  loadScheduledTasks(): Promise<void>;
  createScheduledTask(input: Omit<ScheduledTask, "id" | "lastRunAt" | "nextRunAt" | "createdAt">): Promise<ScheduledTask>;
  updateScheduledTask(id: string, patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>): Promise<ScheduledTask>;
  deleteScheduledTask(id: string): Promise<void>;
  toggleScheduledTask(id: string): Promise<ScheduledTask>;
  loadTaskLogs(): Promise<void>;
  clearTaskLogs(): Promise<void>;

}

let artifactRefreshGeneration = 0;
let usageRefreshGeneration = 0;
const flowCache = new Map<string, FlowInfo | null>();
const panelsCache = new Map<
  string,
  { artifacts: ArtifactInfo[]; events: EventInfo[]; blackboard: BlackboardInfo[] }
>();

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
  return p.address;
}

function buildWsUrl(address: string, token: string): string {
  const hasScheme = address.startsWith("ws://") || address.startsWith("wss://");
  if (hasScheme) {
    return `${address}${address.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  }
  const host = address.includes(":") ? address : `${address}:8787`;
  return `ws://${host}/?token=${encodeURIComponent(token)}`;
}

function migrateAddress(address: string, port?: string): string {
  if (!port || address.includes(":")) return address;
  return `${address}:${port}`;
}

function migrateProfile(p: unknown): ConnProfile {
  const o = p as Record<string, unknown>;
  const address = migrateAddress(String(o.address ?? ""), o.port as string | undefined);
  return {
    name: String(o.name ?? ""),
    address,
    token: String(o.token ?? ""),
  };
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

  const syncTrayMenu = () => {
    const S = stringsFor(get().lang);
    setTrayMenu(S.trayShow, S.trayHide, S.trayQuit).catch(() => {});
  };

  const persist = async () => {
    const { profiles, pinnedIds, recentCwds, customCommands, themeMode, lang, sendKey } = get();
    const cfg: AppConfig = {
      profiles,
      pinned: pinnedIds,
      cwds: recentCwds,
      commands: customCommands,
      theme: themeMode,
      lang,
      sendKey,
      last: defaultConfig.last,
    };
    try {
      await saveConfig(JSON.stringify(cfg));
    } catch {}
  };

  const MAX_HISTORY_CACHE = 20;

  const historyCacheKey = (scope: "session" | "room", id: string) => `${scope}:${id}`;

  const getHistoryCache = (scope: "session" | "room", id: string) => {
    return get().historyCache[historyCacheKey(scope, id)];
  };

  const entryToChatItem = (o: Record<string, unknown>): ChatItem | null => {
    const kind = String(o.kind ?? "");
    const author = String(o.author ?? "");
    const text = String(o.text ?? "");
    const at = typeof o.at === "number" ? o.at : undefined;
    const historyId = typeof o.id === "number" ? o.id : undefined;
    const usage = (o as Record<string, unknown>).usage as Record<string, unknown> | undefined;
    const attachments = ((o as Record<string, unknown>).attachments as unknown[] | undefined)
      ?.map((it) => parseAttachment(it as Record<string, unknown>));
    switch (kind) {
      case "user":
        return { kind: "user", at, historyId, text, author, attachments };
      case "assistant":
        return { kind: "assistant", at, historyId, id: 0, text, author, usage: usage ? parseTokenUsage(usage) : undefined };
      case "system":
        return { kind: "system", at, historyId, text, author };
      case "error":
        return { kind: "error", at, historyId, text, author };
      case "thought":
        return { kind: "thought", at, historyId, id: 0, text, author };
      case "tool": {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* keep */ }
        return {
          kind: "tool",
          at,
          historyId,
          toolCallId: String(data.toolCallId ?? ""),
          title: String(data.title ?? "tool"),
          status: String(data.status ?? "completed"),
          author,
        };
      }
      case "plan": {
        let data: { entries?: string[] } = {};
        try { data = JSON.parse(text) as { entries?: string[] }; } catch { /* keep */ }
        return { kind: "plan", at, historyId, entries: data.entries ?? [], author };
      }
      case "process": {
        let m: Record<string, unknown> = {};
        try { m = JSON.parse(text) as Record<string, unknown>; } catch { /* keep */ }
        return processMetaToItem(m, { at, historyId, author });
      }
      case "flow": {
        // 编排卡条目：text 为 toCardSnapshot 白名单快照 JSON，数组字段兜底归一化
        let m: Record<string, unknown> = {};
        try { m = JSON.parse(text) as Record<string, unknown>; } catch { /* keep */ }
        const flowId = String(m.flowId ?? "");
        if (!flowId) return null;
        const tasks = Array.isArray(m.tasks)
          ? m.tasks.map((t) => ({
              dependsOn: [] as string[],
              artifacts: [] as FlowArtifact[],
              ...(t as Record<string, unknown>),
            }))
          : [];
        const snapshot = { ...m, flowId, tasks } as unknown as FlowCardSnapshot;
        return { kind: "flow", at, historyId, author, flowId, snapshot };
      }
      default:
        return null;
    }
  };

  /** 房史 process 条目的 JSON meta → ChatItem；meta 内嵌 dispatch 列表时转派发卡 */
  const processMetaToItem = (
    m: Record<string, unknown>,
    base: { at?: number; historyId?: number; author: string },
  ): ChatItem => {
    const tasks = Array.isArray(m.tasks)
      ? (m.tasks as unknown[]).map((t) => {
          const o = t as Record<string, unknown>;
          return {
            id: o.id != null ? String(o.id) : undefined,
            to: o.to != null ? String(o.to) : undefined,
            task: o.task != null ? String(o.task) : undefined,
          };
        })
      : undefined;
    return {
      kind: "process",
      at: base.at,
      historyId: base.historyId,
      author: base.author,
      processId: String(m.processId ?? ""),
      sessionId: String(m.sessionId ?? ""),
      turnStartAt: typeof m.turnStartAt === "number" ? m.turnStartAt : undefined,
      turnEndAt: typeof m.turnEndAt === "number" ? m.turnEndAt : undefined,
      steps: Array.isArray(m.steps)
        ? m.steps.length
        : typeof m.steps === "number"
          ? m.steps
          : 0,
      taskId: typeof m.taskId === "string" ? m.taskId : undefined,
      status: String(m.status ?? "done"),
      dispatchCount:
        m.type === "dispatch" || m.card === "dispatch" || typeof m.count === "number"
          ? typeof m.count === "number"
            ? m.count
            : (tasks?.length ?? 0)
          : undefined,
      dispatchTasks: tasks,
    };
  };

  const liveKeyOf = (it: ChatItem): string => {
    switch (it.kind) {
      case "tool":
        return `tool|${it.toolCallId}`;
      case "process":
        // 空 processId 不配对：退回 at+author，避免不同过程卡互吞
        return it.processId
          ? `process|${it.processId}`
          : `process|${it.author}|${it.sessionId}|${it.at ?? ""}`;
      case "permission":
        return `perm|${it.requestId}`;
      case "elicitation":
        return `elicit|${it.requestId}`;
      case "plan":
        return `plan|${it.author}|${it.entries.join("\n")}`;
      case "flow":
        return `flow|${it.flowId}`;
      case "assistant":
      case "thought":
        return `${it.kind}|id:${it.id}`;
      default:
        return `${it.kind}|${it.author}|${"text" in it ? it.text : ""}`;
    }
  };

  // 持久化 author 为 "名字 (来源)"，live 项用房内成员名，两者视为同一作者
  const sameAuthor = (h: ChatItem, it: ChatItem): boolean =>
    h.author === it.author ||
    (h.author ?? "").startsWith(`${it.author} (`) ||
    (it.author ?? "").startsWith(`${h.author} (`);

  const isCoveredByHistory = (it: ChatItem, hist: ChatItem[]): boolean => {
    const near = hist.filter(
      (h) => h.at == null || it.at == null || Math.abs(h.at - it.at) <= 300_000,
    );
    switch (it.kind) {
      case "user":
        return near.some(
          (h) => h.kind === "user" && (h.text === it.text || h.text.endsWith(it.text)),
        );
      case "system":
        return near.some((h) => h.kind === "system" && h.text === it.text);
      case "assistant":
        return near.some(
          (h) =>
            h.kind === "assistant" &&
            sameAuthor(h, it) &&
            (h.text === it.text || h.text.startsWith(it.text) || it.text.startsWith(h.text)),
        );
      case "thought":
        return near.some(
          (h) =>
            h.kind === "thought" &&
            sameAuthor(h, it) &&
            (h.text === it.text || h.text.startsWith(it.text)),
        );
      case "tool":
        return near.some(
          (h) =>
            h.kind === "tool" && !!it.toolCallId && h.toolCallId === it.toolCallId,
        );
      case "plan":
        return near.some(
          (h) =>
            h.kind === "plan" &&
            sameAuthor(h, it) &&
            h.entries.join("\n") === it.entries.join("\n"),
        );
      case "error":
        return near.some((h) => h.kind === "error" && h.text === it.text);
      case "process":
        // 仅非空 processId 配对；空 id 的历史卡不吞 live 卡
        return near.some(
          (h) => h.kind === "process" && !!it.processId && h.processId === it.processId,
        );
      case "flow":
        return near.some((h) => h.kind === "flow" && h.flowId === it.flowId);
      default:
        return false;
    }
  };

  const mergeHistoryItems = (a: ChatItem[], b: ChatItem[]): ChatItem[] => {
    const byId = new Map<number, ChatItem>();
    const live = new Map<string, ChatItem>();
    for (const it of [...a, ...b]) {
      if (it.historyId != null) {
        const existing = byId.get(it.historyId);
        if (!existing || (it.at ?? 0) > (existing.at ?? 0)) {
          byId.set(it.historyId, it);
        }
      } else {
        const k = liveKeyOf(it);
        const existing = live.get(k);
        if (!existing || (it.at ?? 0) >= (existing.at ?? 0)) live.set(k, it);
      }
    }
    const hist = [...byId.values()];
    const result = [...hist];
    for (const it of live.values()) {
      if (!isCoveredByHistory(it, hist)) result.push(it);
    }
    result.sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));
    return result;
  };

  /**
   * 编排卡兜底：flowUpdate/flow 拉取到 flow 但时间线里还没有对应卡片时
   * （旧 Hub 无 flowId、历史条目尚未广播/加载），尾部补一张 live 合成卡。
   * "__live" 占位卡在拿到真实 flowId 后就地升级为正式卡，随后由房史条目接管。
   */
  const ensureFlowCard = (flow: FlowInfo | null) => {
    if (!flow) return;
    const flowId = flow.flowId || "__live";
    const items = get().chatItems;
    if (items.some((it) => it.kind === "flow" && it.flowId === flowId)) return;
    const snapshot = { ...flow, flowId } as FlowCardSnapshot;
    const liveIdx = flow.flowId
      ? items.findIndex((it) => it.kind === "flow" && it.flowId === "__live")
      : -1;
    if (liveIdx >= 0) {
      const next = [...items];
      next[liveIdx] = {
        kind: "flow",
        at: flow.startedAt ?? items[liveIdx]!.at,
        flowId,
        snapshot,
        author: "",
      };
      set({ chatItems: next });
      return;
    }
    set({
      chatItems: [
        ...items,
        { kind: "flow", at: flow.startedAt ?? Date.now(), flowId, snapshot, author: "" },
      ],
    });
  };

  const setHistoryCache = (scope: "session" | "room", id: string, items: ChatItem[]) => {
    const key = historyCacheKey(scope, id);
    const { historyCache, historyCacheKeys } = get();
    const cached = historyCache[key] ?? [];
    const merged = mergeHistoryItems(cached, items);
    const next: Record<string, ChatItem[]> = { ...historyCache, [key]: merged };
    const nextKeys = [key, ...historyCacheKeys.filter((k) => k !== key)];
    while (nextKeys.length > MAX_HISTORY_CACHE) {
      const removed = nextKeys.pop();
      if (removed) delete next[removed];
    }
    set({ historyCache: next, historyCacheKeys: nextKeys });
  };

  const saveCurrentHistoryCache = () => {
    const { currentSession, currentRoom, chatItems, historySearchContext } = get();
    if (historySearchContext) return;
    if (currentSession) setHistoryCache("session", currentSession.sessionId, chatItems);
    if (currentRoom) setHistoryCache("room", currentRoom.roomId, chatItems);
  };

  const scopeKeyNow = (): string | null => {
    const r = get().currentRoom;
    if (r) return `room:${r.roomId}`;
    const s = get().currentSession;
    return s ? `session:${s.sessionId}` : null;
  };

  const saveCurrentScopeCounts = () => {
    const key = scopeKeyNow();
    if (!key) return;
    const { currentArtifacts, currentEvents, blackboard } = get();
    panelsCache.set(key, {
      artifacts: currentArtifacts ?? [],
      events: currentEvents ?? [],
      blackboard: blackboard ?? [],
    });
    const prev = get().seenCache[key] ?? {};
    set({
      seenCache: {
        ...get().seenCache,
        [key]: { ...prev, counts: { ...get().newCounts } },
      },
    });
  };

  const restoredCounts = (scope: "session" | "room", id: string) => {
    const counts = get().seenCache[`${scope}:${id}`]?.counts;
    return counts ? { ...counts } : { artifact: 0, event: 0, blackboard: 0 };
  };

  const dropScopeCache = (scope: "session" | "room", id: string) => {
    const key = historyCacheKey(scope, id);
    const historyCache = { ...get().historyCache };
    delete historyCache[key];
    const seenCache = { ...get().seenCache };
    delete seenCache[key];
    if (scope === "room") flowCache.delete(id);
    panelsCache.delete(key);
    set({
      historyCache,
      historyCacheKeys: get().historyCacheKeys.filter((k) => k !== key),
      seenCache,
    });
  };

  const saveLastProfile = async (address: string, token: string) => {
    const cfg: AppConfig = {
      ...defaultConfig,
      profiles: get().profiles,
      pinned: get().pinnedIds,
      cwds: get().recentCwds,
      commands: get().customCommands,
      theme: get().themeMode,
      lang: get().lang,
      last: { address, token },
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
        if (get().sessions.find((s) => s.sessionId === sid)?.agent === "devin") {
          void get().refreshBackendQuota();
        }
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
          const next: ChatItem = { kind: "error", at: Date.now(), text: msg, author };
          set({ chatItems: [...get().chatItems, next] });
        }
        break;
      }
      case "room.notice": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          const msg = String(params.message ?? "");
          const next: ChatItem = { kind: "system", at: Date.now(), text: msg, author: "" };
          set({ chatItems: [...get().chatItems, next] });
        }
        break;
      }
      case "room.flowUpdate": {
        const roomId = String(params.roomId ?? "");
        const flow = (params.flow as FlowInfo | undefined) ?? null;
        flowCache.set(roomId, flow);
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          set({ flow });
          ensureFlowCard(flow);
          get().refreshArtifacts({ roomId });
        }
        break;
      }
      case "room.blackboardUpdate": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          const blackboard = ((params.blackboard as unknown[]) ?? []).map((it) => {
            const e = it as Record<string, unknown>;
            return {
              id: String(e.id ?? ""),
              from: String(e.from ?? ""),
              text: String(e.text ?? ""),
              detail: String(e.detail ?? ""),
              at: typeof e.at === "number" ? e.at : 0,
            } as BlackboardInfo;
          });
          const key = `room:${roomId}`;
          const seenMap = { ...get().seenCache };
          const seen: ScopeSeen = { ...(seenMap[key] ?? {}) };
          let boardCount = get().newCounts.blackboard;
          if (seen.board) {
            boardCount = blackboard.filter((b) => !seen.board!.has(b.id)).length;
          } else {
            seen.board = new Set(blackboard.map((b) => b.id));
          }
          seenMap[key] = seen;
          set({
            blackboard,
            newCounts: { ...get().newCounts, blackboard: boardCount },
            seenCache: seenMap,
          });
        }
        break;
      }
      case "room.modeSelected": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (room && room.roomId === roomId) {
          const activeSpeaker = typeof params.activeSpeaker === "string" ? params.activeSpeaker : null;
          const subMode = typeof params.mode === "string" ? params.mode : undefined;
          const reason = typeof params.reason === "string" ? params.reason : undefined;
          const updated = { ...room, activeSpeaker, subMode, reason };
          set({
            currentRoom: updated,
            rooms: get().rooms.map((r) => (r.roomId === roomId ? { ...r, activeSpeaker, subMode, reason } : r)),
          });
          if (activeSpeaker) void get().refreshSessionUsage(activeSpeaker);
        }
        break;
      }
      case "room.process": {
        const roomId = String(params.roomId ?? "");
        const room = get().currentRoom;
        if (!room || room.roomId !== roomId) break;
        // Hub 广播 {roomId, entry:{id,at,kind,author,text}}，meta JSON 在 entry.text
        const item = entryToChatItem((params.entry ?? params) as Record<string, unknown>);
        if (!item || (item.kind !== "process" && item.kind !== "flow")) break;
        const items = [...get().chatItems];
        const idx =
          item.kind === "process" && item.processId
            ? items.findIndex((it) => it.kind === "process" && it.processId === item.processId)
            : item.kind === "flow"
              ? items.findIndex((it) => it.kind === "flow" && it.flowId === item.flowId)
              : -1;
        if (idx >= 0) items[idx] = { ...item, at: items[idx]!.at ?? item.at };
        else items.push(item);
        set({ chatItems: items });
        break;
      }
      case "room.artifact": {
        const roomId = String(params.roomId ?? "");
        if (roomId && get().currentRoom?.roomId === roomId) {
          get().refreshArtifacts({ roomId });
        }
        break;
      }
      case "session.artifact": {
        const sessionId = String(params.sessionId ?? "");
        if (sessionId && get().currentSession?.sessionId === sessionId) {
          get().refreshArtifacts({ sessionId });
        }
        break;
      }
      case "file.update": {
        const roomId = String(params.roomId ?? "");
        const sessionId = String(params.sessionId ?? "");
        const currentRoom = get().currentRoom;
        const currentSession = get().currentSession;
        if ((roomId && currentRoom?.roomId === roomId) || (sessionId && currentSession?.sessionId === sessionId)) {
          set({ fileUpdateAt: Date.now() });
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
          at: Date.now(),
          requestId,
          title,
          options,
          answered: null,
          author: get().sessionName(sid),
        };
        set({ chatItems: [...get().chatItems, next] });
        ensurePermission().then(() => {
          showNotification(stringsFor(get().lang).approvalNotificationFmt.replace("%s", get().sessionName(sid)), title).catch(() => {});
        });
        break;
      }
      case "elicitation.request": {
        const sid = String(params.sessionId ?? "");
        if (!get().inScope(sid)) return;
        if (!get().busyIds.includes(sid)) {
          set({ busyIds: [...get().busyIds, sid] });
        }
        const fields = ((params.fields as unknown[] | undefined) ?? [])
          .map((it) => it as ElicitationField)
          .filter((f) => f && typeof f.name === "string");
        const next: ChatItem = {
          kind: "elicitation",
          at: Date.now(),
          requestId: String(params.requestId ?? ""),
          message: String(params.message ?? ""),
          fields,
          answered: null,
          author: get().sessionName(sid),
        };
        set({ chatItems: [...get().chatItems, next] });
        ensurePermission().then(() => {
          showNotification(stringsFor(get().lang).elicitationNotificationFmt.replace("%s", get().sessionName(sid)), String(params.message ?? "")).catch(() => {});
        });
        break;
      }
      case "task.update": {
        const tasks = (params.tasks as unknown[] | undefined) ?? [];
        set({ scheduledTasks: tasks as ScheduledTask[] });
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
    lastSeen: typeof o.lastSeen === "number" ? o.lastSeen : undefined,
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
      subMode: stringOrNull(o.subMode),
      reason: stringOrNull(o.reason),
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
    vendor: String(o.familyUid ?? o.vendor ?? ""),
    slug: String(o.slug ?? ""),
    aliases: ((o.aliases as unknown[] | undefined) ?? []).map((it) => String(it)).filter(Boolean),
    costTier: String(o.costTier ?? ""),
    costSummary: typeof o.costSummary === "string" ? o.costSummary : undefined,
    isCurrent: o.isCurrent === true,
    backend: (o.backend as ModelBackend | undefined) ?? "devin",
  });

  // 过滤出非模型的 select 型会话配置项（mode/thought_level 等）
  const parseSessionConfigOptions = (raw: unknown): SessionConfigOption[] =>
    ((raw as unknown[] | undefined) ?? [])
      .map((it) => it as SessionConfigOption)
      .filter(
        (o) =>
          o &&
          typeof o.id === "string" &&
          o.id !== "model" &&
          Array.isArray(o.options) &&
          o.options.length > 0,
      );

  const store: State & Actions = {
    client: null,
    profiles: [],
    pinnedIds: [],
    recentCwds: [],
    customCommands: [],
    defaultCommands: (() => {
      const S = stringsFor("zh");
      return [S.cmdContinue, S.cmdSummarize, S.cmdRunTests];
    })(),
    screen: "connect",
    themeMode: "system",
    lang: "zh",
    sendKey: "enter",
    connecting: false,
    connectError: null,
    agentStatus: stringsFor("zh").notConnected,
    sessions: [],
    rooms: [],
    roles: [],
    skills: [],
    connections: [],
    agentTypes: KNOWN_AGENT_TYPES,
    currentSession: null,
    currentRoom: null,
    currentArtifacts: null,
    currentEvents: null,
    blackboard: null,
    chatItems: [],
    busyIds: [],
    quote: null,
    fileRefToInsert: null,
    newCounts: { artifact: 0, event: 0, blackboard: 0 },
    searchQuery: "",
    searchResults: [],
    searchGroups: [],
    jumpToAt: null,
    jumpQuery: "",
    selectedIds: { sessions: [], rooms: [] },
    itemSeq: 0,
    drawerOpen: false,
    currentProfile: null,
    flow: null,
    historyHasMore: false,
    historyLoading: false,
    historySearchContext: false,
    sessionUsage: {},
    modelList: [],
    modelCurrent: "",
    modelFilter: "",
    showModelPicker: false,
    sessionConfigOptions: [],
    backendQuota: null,
    editRoomTarget: null,
    roomMemberModels: {},
    selectedMemberSession: null,
    backends: [],
    pendingAttachments: [],
    historyCache: {},
    historyCacheKeys: [],
    seenCache: {},
    fileUpdateAt: 0,
    scheduledTasks: [],
    taskLogs: [],

    init: async () => {
      await get().loadConfigFromDisk();
      ensurePermission().catch(() => {});
      updateTray();
      syncTrayMenu();
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
        const cfg: Partial<AppConfig> & { profiles?: unknown[]; last?: { address?: string; port?: string; token?: string } | null } = raw
          ? (JSON.parse(raw) as Partial<AppConfig>)
          : {};
        const S = stringsFor(cfg.lang ?? "zh");
        const profiles = (cfg.profiles ?? []).map(migrateProfile);
        if (cfg.last?.port && cfg.last.address && !cfg.last.address.includes(":")) {
          cfg.last.address = `${cfg.last.address}:${cfg.last.port}`;
        }
        set({
          profiles,
          pinnedIds: cfg.pinned ?? [],
          recentCwds: cfg.cwds ?? [],
          customCommands: cfg.commands ?? [],
          themeMode: cfg.theme ?? "system",
          lang: cfg.lang ?? "zh",
          sendKey: cfg.sendKey ?? "enter",
          agentStatus: S.notConnected,
          defaultCommands: [S.cmdContinue, S.cmdSummarize, S.cmdRunTests],
        });
      } catch {
        set({ agentStatus: stringsFor(get().lang).notConnected });
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
      const S = stringsFor(lang);
      const prev = get().agentStatus;
      const remap: [keyof Strings, string][] = (["zh", "en"] as const).flatMap((l) => {
        const t = stringsFor(l);
        return [
          ["connected", t.connected],
          ["notConnected", t.notConnected],
          ["agentDisconnected", t.agentDisconnected],
        ];
      });
      const key = remap.find(([, v]) => v === prev)?.[0];
      set({
        lang,
        defaultCommands: [S.cmdContinue, S.cmdSummarize, S.cmdRunTests],
        ...(key ? { agentStatus: S[key] } : {}),
      });
      updateTray();
      syncTrayMenu();
      persist();
    },

    updateSendKey: (key: "enter" | "ctrl-enter") => {
      set({ sendKey: key });
      persist();
    },

    connect: (address: string, token: string, name?: string) => {
      get().disconnect();
      set({ connecting: true, connectError: null });
      const url = buildWsUrl(address, token);

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
          set({ connecting: false, connectError: null, agentStatus: stringsFor(get().lang).connected });
          get().saveProfileAndConnect(address, token, name);
        },
        (msg) => {
          set({ connecting: false, connectError: msg });
        },
      );
    },

    disconnect: () => {
      flowCache.clear();
      panelsCache.clear();
      get().client?.disconnect();
      set({
        client: null,
        sessions: [],
        rooms: [],
        roles: [],
        skills: [],
        connections: [],
        agentTypes: KNOWN_AGENT_TYPES,
        currentSession: null,
        currentRoom: null,
        currentArtifacts: null,
        currentEvents: null,
        blackboard: null,
        chatItems: [],
        busyIds: [],
        quote: null,
    fileRefToInsert: null,
    newCounts: { artifact: 0, event: 0, blackboard: 0 },
        searchQuery: "",
        searchResults: [],
        searchGroups: [],
        jumpToAt: null,
        jumpQuery: "",
        connecting: false,
        connectError: null,
        agentStatus: stringsFor(get().lang).notConnected,
        selectedIds: { sessions: [], rooms: [] },
        historyCache: {},
        historyCacheKeys: [],
        seenCache: {},
        historySearchContext: false,
        currentProfile: null,
        flow: null,
        sessionUsage: {},
        modelList: [],
        modelCurrent: "",
        modelFilter: "",
        showModelPicker: false,
        sessionConfigOptions: [],
        backendQuota: null,
        roomMemberModels: {},
        selectedMemberSession: null,
        pendingAttachments: [],
        fileUpdateAt: 0,
      });
      updateTray();
    },

    toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),

    closeDrawer: () => set({ drawerOpen: false }),

    switchProfile: (p: ConnProfile) => {
      const current = get().currentProfile;
      if (current && profileKey(current) === profileKey(p)) return;
      get().connect(p.address, p.token, p.name);
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
        const curS = get().currentSession;
        set({
          sessions: list,
          ...(curS
            ? { currentSession: list.find((s) => s.sessionId === curS.sessionId) ?? curS }
            : {}),
        });
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
        const info = (await client.call("agent.info")) as Record<string, unknown>;
        const reported = ((info.agents as unknown[] | undefined) ?? [])
          .map((a) => String(a))
          .filter(Boolean);
        set({ agentTypes: [...new Set([...KNOWN_AGENT_TYPES, ...reported])] });
      } catch {}

      try {
        const conns = get().connections;
        const connId = conns.length ? conns[0].id : undefined;
        const sList = (await client.call("skill.list", connId ? { connectionId: connId } : {})) as Record<string, unknown>;
        const skills = ((sList.skills as unknown[] | undefined) ?? []).map((it) => {
          const s = it as Record<string, unknown>;
          return {
            name: String(s.name ?? ""),
            description: String(s.description ?? ""),
            location: String(s.location ?? ""),
            scope: (s.scope === "project" ? "project" : "user") as "project" | "user",
          } as SkillInfo;
        });
        set({ skills });
      } catch {}

      try {
        const rmList = (await client.call("room.list")) as Record<string, unknown>;
        const list = ((rmList.rooms as unknown[] | undefined) ?? []).map((it) =>
          parseRoom(it as Record<string, unknown>),
        );
        const cur = get().currentRoom;
        set({
          rooms: list,
          ...(cur ? { currentRoom: list.find((r) => r.roomId === cur.roomId) ?? cur } : {}),
        });
      } catch {}

      try {
        const tList = (await client.call("task.list")) as Record<string, unknown>;
        const tasks = ((tList.tasks as unknown[] | undefined) ?? []) as ScheduledTask[];
        set({ scheduledTasks: tasks });
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

    updateRoom: async (room, name, memberIds, mode, config, memberRoles) => {
      try {
        const params: Record<string, unknown> = {
          roomId: room.roomId,
          name,
          sessionIds: memberIds,
          mode,
        };
        if (config?.conductorId) params.conductorId = config.conductorId;
        if (config?.parallelSummarizerId) params.parallelSummarizerId = config.parallelSummarizerId;
        if (config?.pipelineOrder?.length) params.pipelineOrder = config.pipelineOrder;
        if (config?.debateSides?.length === 2) params.debateSides = config.debateSides;
        if (config?.debateJudge) params.debateJudge = config.debateJudge;
        if (config?.debateRounds != null) params.debateRounds = config.debateRounds;
        if (memberRoles && Object.keys(memberRoles).length > 0) params.memberRoles = memberRoles;
        const result = await getOrCall<Record<string, unknown>>("room.update", params);
        const updated = parseRoom((result.room as Record<string, unknown>) ?? {});
        if (updated.roomId) {
          set({ rooms: get().rooms.map((r) => (r.roomId === updated.roomId ? updated : r)) });
        }
        await get().refreshAll();
        if (updated.roomId && get().currentRoom?.roomId === updated.roomId) {
          set({ currentRoom: updated });
          void get().refreshRoomMemberModels();
        }
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    openChat: (session: SessionInfo, anchorAt?: number) => {
      saveCurrentHistoryCache();
      saveCurrentScopeCounts();
      const cached = getHistoryCache("session", session.sessionId);
      const panels = panelsCache.get(`session:${session.sessionId}`);
      set({
        currentSession: session,
        currentRoom: null,
        currentArtifacts: panels?.artifacts ?? null,
        currentEvents: panels?.events ?? null,
        blackboard: panels?.blackboard ?? null,
        flow: null,
        chatItems: cached ?? [],
        quote: null,
        fileRefToInsert: null,
        newCounts: restoredCounts("session", session.sessionId),
        screen: "chat",
        historyHasMore: false,
        historyLoading: false,
        historySearchContext: anchorAt != null,
      });
      get().loadHistory("session.history", "sessionId", session.sessionId, anchorAt);
      get().refreshArtifacts({ sessionId: session.sessionId });
      void get().refreshSessionUsage(session.sessionId);
      if (session.agent === "devin") void get().refreshBackendQuota();
    },

    openRoom: async (room: RoomInfo, anchorAt?: number) => {
      await get().refreshAll();
      const latestRoom = get().rooms.find((r) => r.roomId === room.roomId) ?? room;
      const toResume = latestRoom.members
        .map(([sid]) => get().sessions.find((s) => s.sessionId === sid && s.offline))
        .filter((s): s is SessionInfo => s != null);
      for (const s of toResume) {
        try { await get().resumeOne(s); } catch {}
      }
      if (toResume.length > 0) await get().refreshAll();
      const updatedRoom = get().rooms.find((r) => r.roomId === room.roomId) ?? latestRoom;

      saveCurrentHistoryCache();
      saveCurrentScopeCounts();
      const cached = getHistoryCache("room", updatedRoom.roomId);
      const panels = panelsCache.get(`room:${updatedRoom.roomId}`);
      set({
        currentRoom: updatedRoom,
        currentSession: null,
        currentArtifacts: panels?.artifacts ?? null,
        currentEvents: panels?.events ?? null,
        blackboard: panels?.blackboard ?? null,
        chatItems: cached ?? [],
        quote: null,
        fileRefToInsert: null,
        newCounts: restoredCounts("room", updatedRoom.roomId),
        screen: "room",
        flow: flowCache.get(updatedRoom.roomId) ?? null,
        historyHasMore: false,
        historyLoading: false,
        historySearchContext: anchorAt != null,
      });
      get().loadHistory("room.history", "roomId", updatedRoom.roomId, anchorAt);
      get().syncBusyIdsFromList(get().sessions);
      get().refreshFlow(updatedRoom.roomId);
      get().refreshArtifacts({ roomId: updatedRoom.roomId });
      if (updatedRoom.activeSpeaker) void get().refreshSessionUsage(updatedRoom.activeSpeaker);
      void get().refreshRoomMemberModels();
    },

    clearJumpToAt: () => {
      set({ jumpToAt: null, jumpQuery: "" });
    },

    resumeSession: async (session: SessionInfo, autoOpen = true) => {
      try {
        const updated = await get().resumeOne(session);
        if (updated && autoOpen) {
          get().openChat(updated);
        } else if (!updated) {
          set({ connectError: stringsFor(get().lang).resumeFailed });
        }
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    resumeOne: async (session: SessionInfo): Promise<SessionInfo | null> => {
      const result = (await getOrCall("session.resume", { sessionId: session.sessionId })) as Record<
        string,
        unknown
      >;
      if (result.resumed !== true) return null;
      const newSessionId = result.sessionId ? String(result.sessionId) : null;
      if (newSessionId && newSessionId !== session.sessionId) {
        const newSession: SessionInfo = { ...session, sessionId: newSessionId, offline: false };
        set({
          sessions: [
            newSession,
            ...get().sessions.filter((s) => s.sessionId !== session.sessionId),
          ],
        });
        return newSession;
      }
      set({
        sessions: get().sessions.map((s) =>
          s.sessionId === session.sessionId ? { ...s, offline: false } : s,
        ),
      });
      return { ...session, offline: false };
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
        dropScopeCache("session", session.sessionId);
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteSessions: async (sessionIds) => {
      try {
        await getOrCall("session.deleteBatch", { sessionIds });
        sessionIds.forEach((id) => dropScopeCache("session", id));
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    deleteRooms: async (roomIds) => {
      try {
        await getOrCall("room.deleteBatch", { roomIds });
        roomIds.forEach((id) => dropScopeCache("room", id));
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    renameSession: async (session, name) => {
      try {
        await getOrCall("session.rename", { sessionId: session.sessionId, name });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    cloneSession: async (session) => {
      set({ connectError: null });
      try {
        const result = await getOrCall<SessionInfo>("session.clone", { sessionId: session.sessionId });
        await get().refreshAll();
        const cloned = get().sessions.find((s) => s.sessionId === result.sessionId) ?? result;
        get().openChat(cloned);
        return cloned;
      } catch (e) {
        set({ connectError: String(e) });
        return null;
      }
    },

    renameRoom: async (room, name) => {
      try {
        await getOrCall("room.rename", { roomId: room.roomId, name });
        await get().refreshAll();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    cloneRoom: async (room, newName) => {
      try {
        // hub 返回 { room: {...} }，需解包（此前误标 RoomInfo，调用方未用返回值故无影响）
        const result = await getOrCall<Record<string, unknown>>("room.clone", {
          roomId: room.roomId,
          newName,
        });
        await get().refreshAll();
        return parseRoom((result.room ?? result) as Record<string, unknown>);
      } catch (e) {
        set({ connectError: String(e) });
        return null;
      }
    },

    newChat: () => {
      const S = stringsFor(get().lang);
      const room = get().currentRoom;
      const session = get().currentSession;
      const notice = (kind: "system" | "error", text: string) =>
        set({ chatItems: [...get().chatItems, { kind, text, author: "" }] });
      void (async () => {
        try {
          if (room) {
            // 先停在途回合：flow.cancel 收敛编排并取消忙成员，再补刀非编排的忙成员
            const busyMembers = room.members
              .map((m) => m[0])
              .filter((id) => get().busyIds.includes(id));
            if (busyMembers.length > 0 || get().flow) {
              await getOrCall("room.flow.cancel", { roomId: room.roomId }).catch(() => {});
              for (const sid of busyMembers) {
                await getOrCall("session.cancel", { sessionId: sid }).catch(() => {});
              }
            }
            const stem = room.name.replace(/\s*\(\d+\)\s*$/, "");
            const taken = new Set(get().rooms.map((r) => r.name));
            let n = 2;
            let newName = `${stem} (${n})`;
            while (taken.has(newName)) newName = `${stem} (${++n})`;
            const res = await getOrCall<Record<string, unknown>>("room.clone", {
              roomId: room.roomId,
              newName,
              fresh: true,
            });
            const newRoom = parseRoom((res.room ?? res) as Record<string, unknown>);
            await get().openRoom(newRoom);
            try {
              await getOrCall("room.archive", { roomId: room.roomId, archived: true });
            } catch {}
            await get().refreshAll();
            notice("system", S.newChatDoneFmt.replace("%s", newRoom.name));
          } else if (session) {
            if (get().busyIds.includes(session.sessionId)) {
              await getOrCall("session.cancel", { sessionId: session.sessionId }).catch(() => {});
            }
            const res = await getOrCall<Record<string, unknown>>("session.clone", {
              sessionId: session.sessionId,
              fresh: true,
            });
            const newSession: SessionInfo = {
              sessionId: String(res.sessionId ?? ""),
              cwd: session.cwd,
              name: String(res.name ?? session.name),
              busy: false,
              agent: String(res.agent ?? session.agent),
              address: String(res.address ?? session.address),
              connectionId: res.connectionId ? String(res.connectionId) : session.connectionId,
              offline: false,
              archived: false,
            };
            get().openChat(newSession);
            try {
              await getOrCall("session.archive", { sessionId: session.sessionId, archived: true });
            } catch {}
            await get().refreshAll();
            notice("system", S.newChatDoneFmt.replace("%s", newSession.name));
          }
        } catch (e) {
          notice("error", String((e as Error).message ?? e));
        }
      })();
    },

    batchDelete: async (sessionIds, roomIds) => {
      try {
        if (sessionIds.length) await getOrCall("session.deleteBatch", { sessionIds });
        if (roomIds.length) await getOrCall("room.deleteBatch", { roomIds });
        sessionIds.forEach((id) => dropScopeCache("session", id));
        roomIds.forEach((id) => dropScopeCache("room", id));
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
      const now = Date.now();
      const userItem: ChatItem = {
        kind: "user",
        at: now,
        text,
        author: "我",
        attachments: atts.length ? atts : undefined,
        quoteAuthor: q?.[0],
        quoteText: q?.[1],
      };
      set({ chatItems: [...get().chatItems, userItem], quote: null, pendingAttachments: [] });
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text: q ? `${stringsFor(get().lang).quoteHeaderFmt.replace("%s", q[0]).replace("%s", q[1].slice(0, 300))}\n${text}` : text });
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
          chatItems: [...get().chatItems, { kind: "error", at: Date.now(), text: String(e), author: "" }],
        });
      });
    },

    sendRoomMessage: (text: string, opts?: { replyTo?: string }) => {
      const room = get().currentRoom;
      if (!room) return;
      if (get().handleSlashCommand(text)) return;
      const q = get().quote;
      const atts = get().pendingAttachments;
      const now = Date.now();
      const userItem: ChatItem = {
        kind: "user",
        at: now,
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

      const params: Record<string, unknown> = { roomId: room.roomId, text: text || stringsFor(get().lang).imageMessage, content };
      if (q) {
        params.quote = { author: q[0], text: q[1] };
      }
      if (opts?.replyTo) {
        params.replyTo = opts.replyTo;
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
            chatItems: [...get().chatItems, { kind: "error", at: Date.now(), text: String(e), author: "" }],
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

    cancelFlow: async () => {
      const roomId = get().currentRoom?.roomId;
      if (!roomId) return;
      try {
        await getOrCall("room.flow.cancel", { roomId });
        set({ flow: null });
      } catch {}
    },

    answerPermission: (requestId, optionId, optionName) => {
      getOrCall("permission.respond", { requestId, optionId })
        .then(() => {
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
        })
        .catch((e) => {
          set({
            chatItems: [
              ...get().chatItems,
              { kind: "error", at: Date.now(), text: String(e), author: "" },
            ],
          });
        });
    },

    answerElicitation: (requestId, action, content) => {
      const idx = findLastIndex(
        get().chatItems,
        (it) => it.kind === "elicitation" && it.requestId === requestId,
      );
      if (idx >= 0) {
        const items = [...get().chatItems];
        const p = items[idx];
        if (p.kind === "elicitation") {
          const answered =
            action === "accept" ? "accepted" : action === "decline" ? "declined" : "cancelled";
          items[idx] = { ...p, answered };
          set({ chatItems: items });
        }
      }
      getOrCall("elicitation.respond", {
        requestId,
        action,
        ...(content !== undefined ? { content } : {}),
      }).catch(() => {});
    },

    search: async (query) => {
      try {
        const result = (await getOrCall("history.searchGroups", { query, limit: 20, previewLimit: 3 })) as Record<
          string,
          unknown
        >;
        const list = ((result.groups as unknown[] | undefined) ?? []).map((it) => {
          const o = it as Record<string, unknown>;
          const previews = ((o.previews as unknown[] | undefined) ?? []).map((p) => {
            const po = p as Record<string, unknown>;
            return {
              scope: String(po.scope ?? ""),
              scopeId: String(po.scopeId ?? ""),
              author: String(po.author ?? ""),
              text: String(po.text ?? ""),
              at: typeof po.at === "number" ? po.at : undefined,
              id: typeof po.id === "number" ? po.id : undefined,
            } as SearchHit;
          });
          return {
            scope: String(o.scope ?? ""),
            scopeId: String(o.scopeId ?? ""),
            count: typeof o.count === "number" ? o.count : 0,
            previews,
          } as SearchGroup;
        });
        set({ searchQuery: query, searchGroups: list });
      } catch {}
    },

    openSearchHit: (hit) => {
      const anchorAt = hit.at != null && Number.isFinite(hit.at) ? hit.at : undefined;
      const q = anchorAt != null ? get().searchQuery : "";
      if (anchorAt != null) {
        set({ jumpToAt: anchorAt, jumpQuery: q });
      }
      if (hit.scope === "session") {
        const s = get().sessions.find((it) => it.sessionId === hit.scopeId);
        if (s) get().openChat(s, anchorAt);
      } else {
        const r = get().rooms.find((it) => it.roomId === hit.scopeId);
        if (r) get().openRoom(r, anchorAt);
      }
    },

    backToList: () => {
      saveCurrentHistoryCache();
      saveCurrentScopeCounts();
      set({
        currentSession: null,
        currentRoom: null,
        currentArtifacts: null,
        currentEvents: null,
        blackboard: null,
        jumpToAt: null,
        jumpQuery: "",
        historySearchContext: false,
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
      if (room) {
        if (room.members.some((m) => get().busyIds.includes(m[0]))) return true;
        const flow = get().flow;
        if (flow && flow.phase !== "done") return true;
        return false;
      }
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
      return room.members.some((m) => m[0] === sessionId);
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
              chatItems: [...items, { kind: "assistant", at: Date.now(), id: seq + 1, text, author }],
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
              chatItems: [...items, { kind: "thought", at: Date.now(), id: seq + 1, text, author }],
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
                at: Date.now(),
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
            chatItems: [...items, { kind: "plan", at: Date.now(), entries, author }],
          });
          break;
        }
      }
    },

    loadHistory: async (method, idKey, id, anchorAt) => {
      try {
        const params: Record<string, unknown> = { [idKey]: id };
        if (anchorAt != null && Number.isFinite(anchorAt)) params.anchorAt = anchorAt;
        const result = (await getOrCall(method, params)) as Record<string, unknown>;
        const entries = (result.entries as unknown[] | undefined) ?? [];
        const chat = entries
          .map((it) => entryToChatItem(it as Record<string, unknown>))
          .filter((it): it is ChatItem => it !== null);
        const scope = method.startsWith("session") ? "session" : "room";
        const currentId =
          scope === "session" ? get().currentSession?.sessionId : get().currentRoom?.roomId;
        const merged = mergeHistoryItems(chat, currentId === id ? get().chatItems : []);
        const maxLiveId = merged.reduce(
          (m, it) => ("id" in it && typeof it.id === "number" ? Math.max(m, it.id) : m),
          0,
        );
        if (currentId === id) {
          set({
            chatItems: merged,
            itemSeq: Math.max(chat.length, maxLiveId),
            historyHasMore: result.hasMore === true,
            historySearchContext: anchorAt != null,
          });
        }
        if (anchorAt == null) {
          setHistoryCache(scope, id, merged);
        }
        get().syncBusyIds().catch(() => {});
      } catch {}
    },

    fetchProcessItems: async (sessionId, opts) => {
      try {
        if (opts?.running) {
          const res = (await getOrCall("session.process", { sessionId })) as Record<string, unknown>;
          const list =
            ((res.entries ?? res.items ?? res.steps) as unknown[] | undefined) ?? [];
          return list
            .map((it) => entryToChatItem(it as Record<string, unknown>))
            .filter((it): it is ChatItem => it !== null);
        }
        const params: Record<string, unknown> = { sessionId, limit: 200 };
        if (opts?.from != null) params.after = opts.from;
        if (opts?.to != null) params.before = opts.to + 1;
        const res = (await getOrCall("session.history", params)) as Record<string, unknown>;
        const list = ((res.entries ?? res.items) as unknown[] | undefined) ?? [];
        return list
          .map((it) => entryToChatItem(it as Record<string, unknown>))
          .filter((it): it is ChatItem => it !== null)
          .filter(
            (it) =>
              (opts?.from == null || it.at == null || it.at >= opts.from) &&
              (opts?.to == null || it.at == null || it.at <= opts.to),
          );
      } catch {
        return null;
      }
    },

    loadMoreHistory: async (method, idKey, id) => {
      if (get().historyLoading || !get().historyHasMore) return;
      const items = get().chatItems;
      const oldest = items.find((it) => it.historyId != null);
      if (oldest?.at == null) return;
      set({ historyLoading: true });
      try {
        const result = (await getOrCall(method, { [idKey]: id, before: oldest.at, beforeId: oldest.historyId, limit: 50 })) as Record<string, unknown>;
        const entries = (result.entries as unknown[] | undefined) ?? [];
        const more = entries
          .map((it) => entryToChatItem(it as Record<string, unknown>))
          .filter((it): it is ChatItem => it !== null);
        const scope = method.startsWith("session") ? "session" : "room";
        const currentId =
          scope === "session" ? get().currentSession?.sessionId : get().currentRoom?.roomId;
        const existingIds = new Set(items.map((it) => it.historyId).filter((x) => x != null));
        const deduped = more.filter((it) => it.historyId == null || !existingIds.has(it.historyId));
        const nextItems = [...deduped, ...items];
        if (currentId === id) {
          set({ chatItems: nextItems, historyHasMore: result.hasMore === true, historyLoading: false });
        }
        if (!get().historySearchContext) {
          setHistoryCache(scope, id, nextItems);
        }
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
      const arg = parts.slice(1).join(" ") || undefined;
      const S = stringsFor(get().lang);
      switch (command) {
        case "help": {
          const msg = `${S.slashHelpTitle}\n${S.slashHelpHelp}\n${S.slashHelpStop}\n${S.slashHelpBypass}\n${S.slashHelpModel}\n${S.slashHelpNew}`;
          set({ chatItems: [...get().chatItems, { kind: "system", text: msg, author: "" }] });
          return true;
        }
        case "bypass":
          get().toggleBypass(arg);
          return true;
        case "stop":
          get().stopCurrent();
          return true;
        case "new":
          get().newChat();
          return true;
        case "fusion":
          void get().showModelPickerDialog().then(() => set({ modelFilter: "fusion" }));
          return true;
        case "model":
        case "models": {
          const room = get().currentRoom;
          if (room && arg) {
            // 群聊模式：需要 @成员名 前缀
            const mentionMatch = arg.match(/^@(\S+)\s+(.+)$/);
            if (!mentionMatch) {
              set({ chatItems: [...get().chatItems, { kind: "error", text: S.roomModelHint, author: "" }] });
              return true;
            }
            const memberName = mentionMatch[1];
            const modelName = mentionMatch[2];
            const member = room.members.find((m) => m[1] === memberName);
            if (!member) {
              set({ chatItems: [...get().chatItems, { kind: "error", text: S.memberNotFoundFmt.replace("%s", memberName), author: "" }] });
              return true;
            }
            void getOrCall("model.set", { model: modelName, sessionId: member[0] })
              .then((res) => {
                const model = (res as Record<string, unknown>).model as Record<string, unknown> | undefined;
                if (model) {
                  const uid = String(model.uid ?? modelName);
                  const label = String(model.label ?? "");
                  set({ chatItems: [...get().chatItems, { kind: "system", text: S.modelSwitchedForFmt.replace("%s", memberName).replace("%s", label || uid), author: "" }] });
                  void get().refreshRoomMemberModels();
                } else {
                  set({ chatItems: [...get().chatItems, { kind: "error", text: S.modelUnknown.replace("%s", modelName), author: "" }] });
                }
              })
              .catch((e) => {
                set({ chatItems: [...get().chatItems, { kind: "error", text: S.modelListError.replace("%s", String(e.message ?? e)), author: "" }] });
              });
          } else if (arg) {
            // 单聊模式：直接切
            void getOrCall("model.set", { model: arg })
              .then((res) => {
                const model = (res as Record<string, unknown>).model as Record<string, unknown> | undefined;
                if (model) {
                  const uid = String(model.uid ?? arg);
                  const label = String(model.label ?? "");
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
        }
        default: {
          // 不匹配本地命令，透传给 agent（可能是 agent skill 如 /snap2md）
          return false;
        }
      }
    },

    refreshFlow: async (roomId: string) => {
      const client = get().client;
      if (!client) return;
      try {
        const result = (await client.call("room.flow", { roomId })) as Record<string, unknown>;
        const flow = (result.flow as FlowInfo | undefined) ?? null;
        flowCache.set(roomId, flow);
        if (get().currentRoom?.roomId === roomId) {
          set({ flow });
          ensureFlowCard(flow);
        }
      } catch {
        /* ignore */
      }
    },

    setFlow: (flow: FlowInfo | null) => {
      set({ flow });
    },

    refreshArtifacts: async (scope: { roomId: string } | { sessionId: string }) => {
      const client = get().client;
      if (!client) return;
      const generation = ++artifactRefreshGeneration;
      const isRoom = "roomId" in scope;
      if (isRoom && get().currentRoom?.roomId !== scope.roomId) return;
      if (!isRoom && get().currentSession?.sessionId !== scope.sessionId) return;
      try {
        const result = (await client.call(
          isRoom ? "room.artifacts" : "session.artifacts",
          isRoom ? { roomId: scope.roomId } : { sessionId: scope.sessionId },
        )) as Record<string, unknown>;
        const artifacts = ((result.artifacts as unknown[]) ?? []).map((it) => {
          const a = it as Record<string, unknown>;
          return {
            id: String(a.id ?? ""),
            alias: typeof a.alias === "string" ? a.alias : undefined,
            author: String(a.author ?? ""),
            at: typeof a.at === "number" ? a.at : 0,
            summary: String(a.summary ?? ""),
            path: typeof a.path === "string" ? a.path : undefined,
            taskId: typeof a.taskId === "string" ? a.taskId : undefined,
          } as ArtifactInfo;
        });
        const events = ((result.events as unknown[]) ?? []).map((it) => {
          const e = it as Record<string, unknown>;
          const action = String(e.action ?? "");
          return {
            id: String(e.id ?? ""),
            author: String(e.author ?? ""),
            at: typeof e.at === "number" ? e.at : 0,
            action: ["add", "modify", "delete", "rename", "command", "test"].includes(action)
              ? (action as EventInfo["action"])
              : "command",
            summary: String(e.summary ?? ""),
            path: typeof e.path === "string" ? e.path : undefined,
            oldPath: typeof e.oldPath === "string" ? e.oldPath : undefined,
            taskId: typeof e.taskId === "string" ? e.taskId : undefined,
          } as EventInfo;
        });
        if (generation !== artifactRefreshGeneration) return;
        if (isRoom && get().currentRoom?.roomId !== scope.roomId) return;
        if (!isRoom && get().currentSession?.sessionId !== scope.sessionId) return;
        const blackboard = isRoom
          ? ((result.blackboard as unknown[]) ?? []).map((it) => {
              const e = it as Record<string, unknown>;
              return {
                id: String(e.id ?? ""),
                from: String(e.from ?? ""),
                text: String(e.text ?? ""),
                detail: String(e.detail ?? ""),
                at: typeof e.at === "number" ? e.at : 0,
              } as BlackboardInfo;
            })
          : get().blackboard;
        const board = isRoom ? (blackboard ?? []) : [];
        const key = isRoom ? `room:${scope.roomId}` : `session:${scope.sessionId}`;
        const seenMap = { ...get().seenCache };
        const seen: ScopeSeen = { ...(seenMap[key] ?? {}) };
        const counts = { ...get().newCounts };
        if (seen.artifacts) {
          counts.artifact = artifacts.filter((a) => !seen.artifacts!.has(a.id)).length;
        } else {
          seen.artifacts = new Set(artifacts.map((a) => a.id));
        }
        if (seen.events) {
          counts.event = events.filter((e) => !seen.events!.has(e.id)).length;
        } else {
          seen.events = new Set(events.map((e) => e.id));
        }
        if (isRoom) {
          if (seen.board) {
            counts.blackboard = board.filter((b) => !seen.board!.has(b.id)).length;
          } else {
            seen.board = new Set(board.map((b) => b.id));
          }
        }
        seenMap[key] = seen;
        set({
          currentArtifacts: artifacts,
          currentEvents: events,
          ...(isRoom ? { blackboard } : {}),
          newCounts: counts,
          seenCache: seenMap,
        });
      } catch {
        /* ignore */
      }
    },

    refreshSessionUsage: async (sessionId: string) => {
      const client = get().client;
      if (!client) return;
      const generation = ++usageRefreshGeneration;
      try {
        const result = (await client.call("session.contextUsage", { sessionId })) as {
          usage?: Record<string, unknown> | null;
        };
        if (generation !== usageRefreshGeneration) return;
        const stillCurrent =
          get().currentSession?.sessionId === sessionId ||
          get().currentRoom?.activeSpeaker === sessionId;
        if (!stillCurrent) return;
        const next = { ...get().sessionUsage };
        if (result.usage) next[sessionId] = parseContextUsage(result.usage);
        else delete next[sessionId];
        set({ sessionUsage: next });
      } catch {
        /* ignore */
      }
    },

    removeBlackboard: async (roomId: string, id: string) => {
      const client = get().client;
      if (!client) return;
      try {
        await client.call("room.blackboard.remove", { roomId, id });
      } catch (err) {
        alert(stringsFor(get().lang).deleteFailedFmt.replace("%s", String(err)));
      }
    },

    clearBlackboard: async (roomId: string) => {
      const client = get().client;
      if (!client) return;
      try {
        await client.call("room.blackboard.clear", { roomId });
      } catch (err) {
        alert(stringsFor(get().lang).clearFailedFmt.replace("%s", String(err)));
      }
    },

    removeArtifact: async (contextId: string, artifactId: string) => {
      const client = get().client;
      if (!client) return;
      const isSession = !get().currentRoom && !!get().currentSession;
      try {
        await client.call(
          isSession ? "session.removeArtifact" : "room.removeArtifact",
          isSession ? { sessionId: contextId, artifactId } : { roomId: contextId, artifactId },
        );
      } catch (err) {
        alert(stringsFor(get().lang).deleteFailedFmt.replace("%s", String(err)));
      }
    },

    clearArtifacts: async (contextId: string, kind?: "file" | "event") => {
      const client = get().client;
      if (!client) return;
      const isSession = !get().currentRoom && !!get().currentSession;
      try {
        const method = isSession
          ? kind === "event" ? "session.clearEvents" : "session.clearArtifacts"
          : kind === "event" ? "room.clearEvents" : "room.clearArtifacts";
        await client.call(method, isSession ? { sessionId: contextId } : { roomId: contextId, kind });
      } catch (err) {
        alert(stringsFor(get().lang).clearFailedFmt.replace("%s", String(err)));
      }
    },

    removeEvent: async (contextId: string, eventId: string) => {
      const client = get().client;
      if (!client) return;
      const isSession = !get().currentRoom && !!get().currentSession;
      try {
        await client.call(
          isSession ? "session.removeEvent" : "room.removeEvent",
          isSession ? { sessionId: contextId, eventId } : { roomId: contextId, eventId },
        );
      } catch (err) {
        alert(stringsFor(get().lang).deleteFailedFmt.replace("%s", String(err)));
      }
    },

    clearEvents: async (contextId: string, action?: string) => {
      const client = get().client;
      if (!client) return;
      const isSession = !get().currentRoom && !!get().currentSession;
      try {
        const method = isSession ? "session.clearEvents" : "room.clearEvents";
        const params = isSession ? { sessionId: contextId } : { roomId: contextId };
        if (action) (params as Record<string, unknown>)["action"] = action;
        await client.call(method, params);
      } catch (err) {
        alert(stringsFor(get().lang).clearFailedFmt.replace("%s", String(err)));
      }
    },

    deleteFile: async (contextId: string, isSession: boolean, filePath: string) => {
      const client = get().client;
      if (!client) return;
      try {
        const params = isSession ? { sessionId: contextId, path: filePath } : { roomId: contextId, path: filePath };
        await client.call("file.delete", params);
      } catch (err) {
        alert(stringsFor(get().lang).deleteFailedFmt.replace("%s", String(err)));
      }
    },

    renameFile: async (contextId: string, isSession: boolean, from: string, to: string) => {
      const client = get().client;
      if (!client) return;
      try {
        const params = isSession
          ? { sessionId: contextId, from, to }
          : { roomId: contextId, from, to };
        await client.call("file.rename", params);
      } catch (err) {
        alert(stringsFor(get().lang).renameFailedFmt.replace("%s", String(err)));
      }
    },

    quoteArtifact: (artifact: ArtifactInfo) => {
      const ref = artifact.path ? `#${artifact.path}` : `@${artifact.alias ?? artifact.id}`;
      set({ fileRefToInsert: `${ref} `, quote: [get().sessionName(artifact.author), artifact.summary] });
    },
    quoteEvent: (event: EventInfo) => {
      set({ quote: [get().sessionName(event.author), `[${event.action}] ${event.summary}`] });
    },
    quoteBlackboard: (entry: BlackboardInfo) => {
      set({ quote: [get().sessionName(entry.from), entry.text] });
    },
    clearFileRef: () => set({ fileRefToInsert: null }),
    clearNewCounts: (kind?: "artifact" | "event" | "blackboard") => {
      const prev = get().newCounts;
      const key = scopeKeyNow();
      const seenMap = { ...get().seenCache };
      const seen: ScopeSeen | null = key ? { ...(seenMap[key] ?? {}) } : null;
      const next = { ...prev };
      if (!kind || kind === "artifact") {
        next.artifact = 0;
        if (seen) seen.artifacts = new Set((get().currentArtifacts ?? []).map((a) => a.id));
      }
      if (!kind || kind === "event") {
        next.event = 0;
        if (seen) seen.events = new Set((get().currentEvents ?? []).map((e) => e.id));
      }
      if (!kind || kind === "blackboard") {
        next.blackboard = 0;
        if (seen) seen.board = new Set((get().blackboard ?? []).map((b) => b.id));
      }
      if (seen && key) {
        seen.counts = { ...next };
        seenMap[key] = seen;
      }
      set({ newCounts: next, seenCache: seenMap });
    },

    saveProfileAndConnect: (address: string, token: string, name?: string) => {
      const derived = address
        .replace(/^wss?:\/\//, "")
      .split(/[\/\?:]/)[0];
      const profileName = name?.trim() || derived;
      let profiles = get().profiles.filter((p) => p.address !== address);
      const profile: ConnProfile = { name: profileName, address, token };
      profiles = [...profiles, profile];
      set({ profiles, currentProfile: profile, drawerOpen: false });
      persist();
      saveLastProfile(address, token).catch(() => {});
      set({ screen: "sessions" });
      get().refreshAll().then(() => get().restoreCurrentScreen());
    },

    restoreCurrentScreen: async () => {
      const room = get().currentRoom;
      if (room) {
        const latest = get().rooms.find((r) => r.roomId === room.roomId);
        if (latest) get().openRoom(latest);
        return;
      }
      const session = get().currentSession;
      if (session) {
        const latest = get().sessions.find((s) => s.sessionId === session.sessionId) ?? session;
        if (latest.offline) {
          await get().resumeSession(latest, true);
        } else {
          get().openChat(latest);
        }
      }
    },

    showModelPickerDialog: async () => {
      const room = get().currentRoom;
      if (room) {
        // 群聊模式：加载成员模型信息，默认选中第一个成员
        await get().refreshRoomMemberModels();
        const first = get().roomMemberModels;
        const firstSid = Object.keys(first)[0] ?? null;
        set({ showModelPicker: true, selectedMemberSession: firstSid });
        if (firstSid) await get().refreshModelListForMember(firstSid);
      } else {
        await get().refreshModelList();
        set({ showModelPicker: true, selectedMemberSession: null });
        void get().refreshBackendQuota();
      }
    },

    refreshModelList: async () => {
      try {
        const backend = get().currentSession?.agent ?? "devin";
        const sessionId = get().currentSession?.sessionId;
        const result = await getOrCall<Record<string, unknown>>("model.list", { backend, ...(sessionId ? { sessionId } : {}) });
        const current = String(result.current ?? "");
        const list = ((result.models as unknown[] | undefined) ?? []).map((it) =>
          parseModelInfo({ ...(it as Record<string, unknown>), isCurrent: (it as Record<string, unknown>).uid === current }),
        );
        set({ modelList: list, modelCurrent: current, modelFilter: "" });
        await get().listBackends();
        if (sessionId) void get().refreshSessionConfigOptions(sessionId);
        else set({ sessionConfigOptions: [] });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    refreshSessionConfigOptions: async (sessionId: string) => {
      try {
        const result = await getOrCall<Record<string, unknown>>("session.configOptions", { sessionId });
        set({ sessionConfigOptions: parseSessionConfigOptions(result.configOptions) });
      } catch {
        set({ sessionConfigOptions: [] });
      }
    },

    setSessionConfigOption: async (sessionId: string, configId: string, value: string) => {
      try {
        const result = await getOrCall<Record<string, unknown>>("session.setConfigOption", { sessionId, configId, value });
        set({ sessionConfigOptions: parseSessionConfigOptions(result.configOptions) });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    refreshBackendQuota: async (force = false) => {
      try {
        const q = await getOrCall<BackendQuota>("model.usage", { backend: "devin", ...(force ? { refresh: true } : {}) });
        set({ backendQuota: q });
      } catch {
        // 拉取失败保留旧数据，避免界面闪烁
      }
    },

    refreshRoomMemberModels: async () => {
      const room = get().currentRoom;
      if (!room) { set({ roomMemberModels: {} }); return; }
      try {
        const result = await getOrCall<Record<string, unknown>>("room.memberModels", { roomId: room.roomId });
        if (get().currentRoom?.roomId !== room.roomId) return;
        const members = (result.members as Array<{ sessionId: string; name: string; backend: string; model: string }>) ?? [];
        const map: Record<string, { name: string; backend: string; model: string }> = {};
        for (const m of members) map[m.sessionId] = { name: m.name, backend: m.backend, model: m.model };
        set({ roomMemberModels: map });
        if (Object.values(map).some((m) => m.backend === "devin")) void get().refreshBackendQuota();
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    refreshModelListForMember: async (sessionId: string) => {
      const info = get().roomMemberModels[sessionId];
      if (!info) return;
      try {
        const result = await getOrCall<Record<string, unknown>>("model.list", { backend: info.backend, sessionId });
        const current = String(result.current ?? "");
        const list = ((result.models as unknown[] | undefined) ?? []).map((it) =>
          parseModelInfo({ ...(it as Record<string, unknown>), isCurrent: (it as Record<string, unknown>).uid === current }),
        );
        set({ modelList: list, modelCurrent: current, modelFilter: "" });
        void get().refreshSessionConfigOptions(sessionId);
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    selectMemberForModel: (sessionId: string | null) => {
      set({ selectedMemberSession: sessionId, modelFilter: "" });
      if (sessionId) void get().refreshModelListForMember(sessionId);
    },

    switchModel: async (model: ModelInfo) => {
      try {
        const sessionId = get().currentSession?.sessionId;
        await getOrCall("model.set", { model: model.uid, ...(sessionId ? { sessionId } : {}) });
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

    switchModelForMember: async (sessionId: string, model: ModelInfo) => {
      try {
        await getOrCall("model.set", { model: model.uid, sessionId });
        const info = get().roomMemberModels[sessionId];
        const memberName = info?.name ?? sessionId;
        // 更新成员模型信息
        set({
          roomMemberModels: { ...get().roomMemberModels, [sessionId]: { ...info!, model: model.uid } },
          modelCurrent: model.uid,
          modelList: get().modelList.map((m) => ({ ...m, isCurrent: m.uid === model.uid })),
        });
        set({ chatItems: [...get().chatItems, { kind: "system", text: stringsFor(get().lang).modelSwitchedForFmt.replace("%s", memberName).replace("%s", model.label || model.uid), author: "" }] });
      } catch (e) {
        set({ connectError: String(e) });
      }
    },

    closeModelPicker: () => set({ showModelPicker: false, modelFilter: "", selectedMemberSession: null }),

    openEditRoomDialog: (room) => set({ editRoomTarget: room }),
    closeEditRoomDialog: () => set({ editRoomTarget: null }),

    listBackends: async () => {
      const client = get().client;
      if (!client) return;
      try {
        const result = await client.call("model.backends.list", {});
        const backends = (result as { backends?: BackendConfig[] }).backends ?? [];
        set({ backends });
      } catch (e) {
        console.error("Failed to list backends:", e);
      }
    },

    addBackend: async (backend: BackendConfig) => {
      const client = get().client;
      if (!client) return;
      try {
        await client.call("model.backends.add", { backend });
        await get().listBackends();
      } catch (e) {
        console.error("Failed to add backend:", e);
        throw e;
      }
    },

    removeBackend: async (id: string) => {
      const client = get().client;
      if (!client) return;
      try {
        await client.call("model.backends.remove", { id });
        await get().listBackends();
      } catch (e) {
        console.error("Failed to remove backend:", e);
        throw e;
      }
    },

    toggleBackend: async (id: string) => {
      const client = get().client;
      if (!client) return;
      try {
        await client.call("model.backends.toggle", { id });
        await get().listBackends();
      } catch (e) {
        console.error("Failed to toggle backend:", e);
        throw e;
      }
    },

    addAttachment: (attachment: Attachment) => {
      set({ pendingAttachments: [...get().pendingAttachments, attachment] });
    },

    removeAttachment: (attachment: Attachment) => {
      set({ pendingAttachments: get().pendingAttachments.filter((a) => a.base64 !== attachment.base64) });
    },

    clearAttachments: () => set({ pendingAttachments: [] }),

    loadScheduledTasks: async () => {
      try {
        const tList = (await getOrCall<Record<string, unknown>>("task.list")) as Record<string, unknown>;
        const tasks = ((tList.tasks as unknown[] | undefined) ?? []) as ScheduledTask[];
        set({ scheduledTasks: tasks });
      } catch {}
    },

    createScheduledTask: async (input: Omit<ScheduledTask, "id" | "lastRunAt" | "nextRunAt" | "createdAt">) => {
      const resp = await getOrCall<Record<string, unknown>>("task.create", input as unknown as Record<string, unknown>);
      const task = resp.task as ScheduledTask;
      set({ scheduledTasks: [...get().scheduledTasks, task] });
      return task;
    },

    updateScheduledTask: async (id: string, patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>) => {
      const resp = await getOrCall<Record<string, unknown>>("task.update", { id, ...patch } as unknown as Record<string, unknown>);
      const task = resp.task as ScheduledTask;
      set({ scheduledTasks: get().scheduledTasks.map((t) => (t.id === id ? task : t)) });
      return task;
    },

    deleteScheduledTask: async (id: string) => {
      await getOrCall("task.delete", { id });
      set({ scheduledTasks: get().scheduledTasks.filter((t) => t.id !== id) });
    },

    toggleScheduledTask: async (id: string) => {
      const resp = await getOrCall<Record<string, unknown>>("task.toggle", { id });
      const task = resp.task as ScheduledTask;
      set({ scheduledTasks: get().scheduledTasks.map((t) => (t.id === id ? task : t)) });
      return task;
    },

    loadTaskLogs: async () => {
      try {
        const resp = await getOrCall<Record<string, unknown>>("task.logs", { limit: 200 });
        const logs = ((resp.logs as unknown[] | undefined) ?? []) as TaskLog[];
        set({ taskLogs: logs });
      } catch {}
    },

    clearTaskLogs: async () => {
      try {
        await getOrCall("task.clearLogs");
        set({ taskLogs: [] });
      } catch {}
    },

  };

  // derived slashCommands after store is created
  Object.defineProperty(store, "slashCommands", {
    get: () => {
      const S = stringsFor(get().lang);
      const local = [
        { name: "help", description: S.slashHelpHelp },
        { name: "stop", description: S.slashHelpStop },
        { name: "bypass", description: S.slashHelpBypass },
        { name: "model", description: S.slashHelpModel },
        { name: "new", description: S.slashHelpNew },
      ];
      const skills = get().skills.map((s) => ({ name: s.name, description: s.description }));
      return [...local, ...skills];
    },
  });

  return store;
});
