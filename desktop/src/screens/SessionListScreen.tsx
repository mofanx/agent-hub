import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHubStore } from "../hub/store";
import type { RoomInfo, RoomModeConfig, SearchGroup, SessionInfo } from "../hub/types";

type Dialog =
  | { type: "session" }
  | { type: "room" }
  | { type: "room-members"; name: string; mode: string; conductorId?: string }
  | null;

type SessionStatus = "online" | "offline" | "busy" | "pinned" | "archived";
type SessionGroupBy = "none" | "agent" | "cwd";
type RoomGroupBy = "none" | "mode";

interface SessionListFilter {
  query: string;
  agents: Set<string>;
  cwds: Set<string>;
  statuses: Set<SessionStatus>;
  groupBy: SessionGroupBy;
}

interface RoomListFilter {
  query: string;
  modes: Set<string>;
  groupBy: RoomGroupBy;
  showArchived: boolean;
}

const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  online: "在线",
  offline: "离线",
  busy: "忙碌",
  pinned: "置顶",
  archived: "归档",
};

const GROUP_BY_LABELS: Record<SessionGroupBy | RoomGroupBy, string> = {
  none: "不分组",
  agent: "按 Agent",
  cwd: "按目录",
  mode: "按模式",
};

const MODE_LABELS: Record<string, string> = {
  mention: "普通群",
  conductor: "指挥家",
  roundrobin: "轮询",
  parallel: "并行",
  pipeline: "流水线",
  debate: "辩论",
  auto: "自动",
};

function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const tail = path.slice(-(maxLen - 3));
  const idx = tail.indexOf("/");
  return idx > 0 ? `...${tail.slice(idx)}` : `...${tail}`;
}

function toggleSet<T extends string>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function sessionStatuses(s: SessionInfo, pinnedIds: string[]): SessionStatus[] {
  const st: SessionStatus[] = [];
  if (s.archived) st.push("archived");
  if (s.offline) st.push("offline");
  else if (s.busy) st.push("busy");
  else if (!s.archived) st.push("online");
  if (pinnedIds.includes(s.sessionId)) st.push("pinned");
  return st;
}

function isSessionStatus(s: string): s is SessionStatus {
  return ["online", "offline", "busy", "pinned", "archived"].includes(s);
}

interface ActiveChip {
  kind: "session" | "room";
  key: string;
  label: string;
}

function buildActiveSessionChips(filter: SessionListFilter, agents: string[], cwds: string[]): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filter.query.trim()) chips.push({ kind: "session", key: "query", label: `搜索: ${filter.query.trim()}` });
  if (filter.groupBy !== "none") chips.push({ kind: "session", key: "groupBy", label: `分组: ${GROUP_BY_LABELS[filter.groupBy]}` });
  for (const a of agents) if (filter.agents.has(a)) chips.push({ kind: "session", key: a, label: a });
  for (const c of cwds) if (filter.cwds.has(c)) chips.push({ kind: "session", key: c, label: truncatePath(c) });
  for (const st of Array.from(filter.statuses)) chips.push({ kind: "session", key: st, label: SESSION_STATUS_LABELS[st] });
  return chips;
}

function buildActiveRoomChips(filter: RoomListFilter, modes: string[], archivedCount: number): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filter.query.trim()) chips.push({ kind: "room", key: "query", label: `搜索: ${filter.query.trim()}` });
  if (filter.groupBy !== "none") chips.push({ kind: "room", key: "groupBy", label: `分组: ${GROUP_BY_LABELS[filter.groupBy]}` });
  if (filter.showArchived && archivedCount > 0) chips.push({ kind: "room", key: "showArchived", label: `归档 (${archivedCount})` });
  for (const m of modes) if (filter.modes.has(m)) chips.push({ kind: "room", key: m, label: MODE_LABELS[m] ?? m });
  return chips;
}

export function SessionListScreen() {
  const store = useHubStore();
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionListFilter>({
    query: "",
    agents: new Set(),
    cwds: new Set(),
    statuses: new Set(),
    groupBy: "none",
  });
  const [roomFilter, setRoomFilter] = useState<RoomListFilter>({
    query: "",
    modes: new Set(),
    groupBy: "none",
    showArchived: false,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.trim()) {
      const t = setTimeout(() => void store.search(query.trim()), 200);
      return () => clearTimeout(t);
    } else {
      store.search("");
    }
  }, [query, store]);

  useEffect(() => {
    if (!batch) store.clearSelection();
  }, [batch, store]);

  const availableAgents = useMemo(() => {
    const set = new Set<string>();
    for (const s of store.sessions) if (s.agent) set.add(s.agent);
    return Array.from(set).sort();
  }, [store.sessions]);

  const availableCwds = useMemo(() => {
    const set = new Set<string>();
    for (const s of store.sessions) if (s.cwd) set.add(s.cwd);
    return Array.from(set).sort();
  }, [store.sessions]);

  const availableModes = useMemo(() => {
    const set = new Set<string>();
    for (const r of store.rooms) if (r.mode) set.add(r.mode);
    return Array.from(set).sort();
  }, [store.rooms]);

  const sessionGroups = useMemo(() => {
    const q = sessionFilter.query.trim().toLowerCase();
    const list = store.sessions
      .filter((s) => {
        if (sessionFilter.agents.size && !sessionFilter.agents.has(s.agent)) return false;
        if (sessionFilter.cwds.size && !sessionFilter.cwds.has(s.cwd)) return false;
        const st = sessionStatuses(s, store.pinnedIds);
        if (sessionFilter.statuses.size && !Array.from(sessionFilter.statuses).some((status) => st.includes(status))) return false;
        if (q) {
          const hay = `${s.name} ${s.cwd} ${s.agent} ${store.sessionOrigin(s)}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        const pa = store.pinnedIds.includes(a.sessionId) ? 1 : 0;
        const pb = store.pinnedIds.includes(b.sessionId) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return a.name.localeCompare(b.name);
      });
    if (sessionFilter.groupBy === "none") return [{ title: "", sessions: list }];
    const map = new Map<string, SessionInfo[]>();
    for (const s of list) {
      const key = sessionFilter.groupBy === "agent" ? s.agent : s.cwd;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, sessions]) => ({ title, sessions }));
  }, [store.sessions, store.pinnedIds, store.connections, sessionFilter, store.sessionOrigin]);

  const roomGroups = useMemo(() => {
    const q = roomFilter.query.trim().toLowerCase();
    const list = store.rooms
      .filter((r) => {
        if (r.archived && !roomFilter.showArchived) return false;
        if (roomFilter.modes.size && !roomFilter.modes.has(r.mode)) return false;
        if (q) {
          const members = r.members.map((m) => m[1]).join(" ").toLowerCase();
          const modeLabel = r.mode.toLowerCase();
          const hay = `${r.name} ${modeLabel} ${members}`;
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (roomFilter.groupBy === "none") return [{ title: "", rooms: list }];
    const map = new Map<string, RoomInfo[]>();
    for (const r of list) {
      const key = r.mode;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, rooms]) => ({ title, rooms }));
  }, [store.rooms, roomFilter]);

  const inSearch = query.trim() !== "";
  const archivedRoomCount = useMemo(() => store.rooms.filter((r) => r.archived).length, [store.rooms]);
  const [showFilter, setShowFilter] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setDialog({ type: "session" });
      }
      if (e.key === "Escape" && (query || showFilter)) {
        if (showFilter) setShowFilter(false);
        setQuery("");
        setSessionFilter({ query: "", agents: new Set(), cwds: new Set(), statuses: new Set(), groupBy: "none" });
        setRoomFilter({ query: "", modes: new Set(), groupBy: "none", showArchived: false });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [query, showFilter]);

  const activeSessionChips = useMemo(
    () => buildActiveSessionChips(sessionFilter, availableAgents, availableCwds),
    [sessionFilter, availableAgents, availableCwds],
  );
  const activeRoomChips = useMemo(
    () => buildActiveRoomChips(roomFilter, availableModes, archivedRoomCount),
    [roomFilter, availableModes, archivedRoomCount],
  );
  const activeChips = [...activeSessionChips, ...activeRoomChips];

  const listAnimKey = JSON.stringify({
    batch,
    sf: { ...sessionFilter, agents: [...sessionFilter.agents], cwds: [...sessionFilter.cwds], statuses: [...sessionFilter.statuses] },
    rf: { ...roomFilter, modes: [...roomFilter.modes] },
  });

  const onRemoveChip = (kind: "session" | "room", key: string) => {
    if (kind === "session") {
      const f = sessionFilter;
      if (key === "query") setSessionFilter({ ...f, query: "" });
      else if (key === "groupBy") setSessionFilter({ ...f, groupBy: "none" });
      else if (f.agents.has(key)) setSessionFilter({ ...f, agents: toggleSet(f.agents, key) });
      else if (f.cwds.has(key)) setSessionFilter({ ...f, cwds: toggleSet(f.cwds, key) });
      else if (isSessionStatus(key)) setSessionFilter({ ...f, statuses: toggleSet(f.statuses, key) });
    } else {
      const f = roomFilter;
      if (key === "query") setRoomFilter({ ...f, query: "" });
      else if (key === "groupBy") setRoomFilter({ ...f, groupBy: "none" });
      else if (key === "showArchived") setRoomFilter({ ...f, showArchived: false });
      else if (f.modes.has(key)) setRoomFilter({ ...f, modes: toggleSet(f.modes, key) });
    }
  };

  const selectAll = () => {
    const allS = store.sessions.map((s) => s.sessionId);
    const allR = store.rooms.map((r) => r.roomId);
    const allSelected =
      store.selectedIds.sessions.length === allS.length &&
      store.selectedIds.rooms.length === allR.length;
    if (allSelected) {
      store.clearSelection();
    } else {
      allS.forEach((id) => store.selectSession(id));
      allR.forEach((id) => store.selectRoom(id));
    }
  };

  const invertSelection = () => {
    const allS = new Set(store.sessions.map((s) => s.sessionId));
    const allR = new Set(store.rooms.map((r) => r.roomId));
    const nextS = [...allS].filter((id) => !store.selectedIds.sessions.includes(id));
    const nextR = [...allR].filter((id) => !store.selectedIds.rooms.includes(id));
    store.clearSelection();
    nextS.forEach((id) => store.selectSession(id));
    nextR.forEach((id) => store.selectRoom(id));
  };

  const onBatchDelete = () => {
    const { sessions, rooms } = store.selectedIds;
    if (!sessions.length && !rooms.length) return;
    if (!confirm(`确认删除选中的 ${sessions.length} 个会话和 ${rooms.length} 个群？此操作不可撤销。`)) return;
    void store.batchDelete(sessions, rooms);
  };

  return (
    <div className="session-list">
      <div className="session-toolbar">
        <input
          ref={searchInputRef}
          className="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="搜索会话、群聊或历史消息… (Ctrl+K)"
        />
        <button onClick={() => void store.refreshAll()}>刷新</button>
        <button onClick={() => setBatch(!batch)}>{batch ? "退出批量" : "批量"}</button>
        <button onClick={() => setDialog({ type: "session" })}>＋会话</button>
        <button onClick={() => setDialog({ type: "room" })}>＋群聊</button>
        <button onClick={() => setShowFilter(true)}>筛选</button>
        <button onClick={() => useHubStore.setState({ screen: "settings" })}>设置</button>
      </div>

      {activeChips.length > 0 && (
        <div className="active-filters">
          {activeChips.map((c) => (
            <FilterChip
              key={c.kind + c.key}
              selected
              onClick={() => onRemoveChip(c.kind, c.key)}
              label={
                <>
                  {c.label} <span className="close">×</span>
                </>
              }
            />
          ))}
        </div>
      )}

      {batch && (
        <div className="batch-bar">
          <button className="secondary" onClick={selectAll}>
            全选
          </button>
          <button className="secondary" onClick={invertSelection}>
            反选
          </button>
          <span className="subtitle">
            已选 {store.selectedIds.sessions.length + store.selectedIds.rooms.length} 项
          </span>
          <button className="danger" onClick={onBatchDelete}>
            删除
          </button>
        </div>
      )}

      {inSearch ? (
        <SearchResults query={query} />
      ) : (
        <>
          <section key={`s-${listAnimKey}`}>
            <h2>
              会话 ({sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0)})
            </h2>
            <div className="list">
              {sessionGroups.map((g) => (
                <div key={g.title || "_"}>
                  {g.title && (
                    <div className="group-header">
                      {sessionFilter.groupBy === "cwd" ? truncatePath(g.title) : g.title} ({g.sessions.length})
                    </div>
                  )}
                  {g.sessions.map((s) => (
                    <SessionCard key={s.sessionId} s={s} batch={batch} />
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section key={`r-${listAnimKey}`}>
            <h2>
              群聊 ({roomGroups.reduce((sum, g) => sum + g.rooms.length, 0)})
            </h2>
            <div className="list">
              {roomGroups.map((g) => (
                <div key={g.title || "_"}>
                  {g.title && (
                    <div className="group-header">
                      {MODE_LABELS[g.title] ?? g.title} ({g.rooms.length})
                    </div>
                  )}
                  {g.rooms.map((r) => (
                    <RoomCard key={r.roomId} r={r} batch={batch} />
                  ))}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {dialog?.type === "session" && <SessionDialog onClose={() => setDialog(null)} />}
      {dialog?.type === "room" && <RoomDialog onClose={() => setDialog(null)} />}
      {showFilter && (
        <FilterSheet
          sessionFilter={sessionFilter}
          roomFilter={roomFilter}
          onSessionChange={setSessionFilter}
          onRoomChange={setRoomFilter}
          agents={availableAgents}
          cwds={availableCwds}
          modes={availableModes}
          archivedRoomCount={archivedRoomCount}
          onClose={() => setShowFilter(false)}
        />
      )}
    </div>
  );
}

function highlightText(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="search-highlight">{text.slice(i, i + q.length)}</span>
      {highlightText(text.slice(i + q.length), q)}
    </>
  );
}

function SearchResults({ query }: { query: string }) {
  const store = useHubStore();
  const q = query.trim().toLowerCase();

  const sessionMatches = useMemo(() => {
    if (!q) return [];
    return store.sessions
      .filter((s) => {
        const hay = `${s.name} ${s.cwd} ${s.agent} ${store.sessionOrigin(s)}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        const pa = store.pinnedIds.includes(a.sessionId) ? 1 : 0;
        const pb = store.pinnedIds.includes(b.sessionId) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);
  }, [q, store.sessions, store.pinnedIds, store.connections, store.sessionOrigin]);

  const roomMatches = useMemo(() => {
    if (!q) return [];
    return store.rooms
      .filter((r) => {
        if (r.archived) return false;
        const members = r.members.map((m) => m[1]).join(" ").toLowerCase();
        const hay = `${r.name} ${r.mode} ${members}`;
        return hay.includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 5);
  }, [q, store.rooms]);

  const hasAny = sessionMatches.length > 0 || roomMatches.length > 0 || store.searchGroups.length > 0;
  if (!hasAny) return <div className="empty">无结果</div>;

  return (
    <div className="list search-results">
      {sessionMatches.length > 0 && (
        <>
          <div className="group-header">会话 ({sessionMatches.length})</div>
          {sessionMatches.map((s) => (
            <SessionCard key={s.sessionId} s={s} batch={false} />
          ))}
        </>
      )}
      {roomMatches.length > 0 && (
        <>
          <div className="group-header">群聊 ({roomMatches.length})</div>
          {roomMatches.map((r) => (
            <RoomCard key={r.roomId} r={r} batch={false} />
          ))}
        </>
      )}
      {store.searchGroups.length > 0 && (
        <>
          <div className="group-header">
            历史消息 ({store.searchGroups.reduce((sum, g) => sum + g.count, 0)})
          </div>
          {store.searchGroups.map((g, i) => (
            <SearchGroupCard key={i} group={g} query={query} />
          ))}
        </>
      )}
    </div>
  );
}

function SearchGroupCard({ group, query }: { group: SearchGroup; query: string }) {
  const store = useHubStore();
  const q = query.trim().toLowerCase();
  const name = useMemo(() => {
    if (group.scope === "room") {
      return store.rooms.find((r) => r.roomId === group.scopeId)?.name ?? group.scopeId;
    }
    return store.sessions.find((s) => s.sessionId === group.scopeId)?.name ?? group.scopeId;
  }, [group, store.sessions, store.rooms]);
  return (
    <div className="list-item search-group">
      <div className="title-wrap">
        <span className="title">{name} · 共 {group.count} 条</span>
        {group.previews.map((hit, i) => (
          <div
            key={i}
            className="subtitle search-preview"
            onClick={() => store.openSearchHit(hit)}
          >
            <span className="search-author">{hit.author || "系统"} · </span>
            {highlightText((hit.text || "").slice(0, 120), q)}
          </div>
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  selected,
  onClick,
  title,
}: {
  label: ReactNode;
  selected: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button className={`chip ${selected ? "active" : ""}`} onClick={onClick} title={title} type="button">
      {label}
    </button>
  );
}

function FilterSheet({
  sessionFilter,
  roomFilter,
  onSessionChange,
  onRoomChange,
  agents,
  cwds,
  modes,
  archivedRoomCount,
  onClose,
}: {
  sessionFilter: SessionListFilter;
  roomFilter: RoomListFilter;
  onSessionChange: (f: SessionListFilter) => void;
  onRoomChange: (f: RoomListFilter) => void;
  agents: string[];
  cwds: string[];
  modes: string[];
  archivedRoomCount: number;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"session" | "room">("session");
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet-tabs">
          <button className={tab === "session" ? "active" : ""} onClick={() => setTab("session")}>
            会话
          </button>
          <button className={tab === "room" ? "active" : ""} onClick={() => setTab("room")}>
            群聊
          </button>
          <button className="secondary" onClick={onClose} style={{ marginLeft: "auto" }}>
            关闭
          </button>
        </div>

        {tab === "session" ? (
          <FilterSheetSession
            filter={sessionFilter}
            onChange={onSessionChange}
            agents={agents}
            cwds={cwds}
          />
        ) : (
          <FilterSheetRoom
            filter={roomFilter}
            onChange={onRoomChange}
            modes={modes}
            archivedCount={archivedRoomCount}
          />
        )}
      </div>
    </div>
  );
}

function FilterSheetSession({
  filter,
  onChange,
  agents,
  cwds,
}: {
  filter: SessionListFilter;
  onChange: (f: SessionListFilter) => void;
  agents: string[];
  cwds: string[];
}) {
  const isFiltered =
    filter.query.trim() ||
    filter.groupBy !== "none" ||
    filter.statuses.size > 0 ||
    filter.agents.size > 0 ||
    filter.cwds.size > 0;

  return (
    <div className="filter-sheet-body">
      <input
        className="filter-query"
        placeholder="按名称、目录或 Agent 过滤…"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.currentTarget.value })}
      />

      <div className="filter-section">
        <span className="chip-label">分组</span>
        <div className="chips">
          {(["none", "agent", "cwd"] as SessionGroupBy[]).map((g) => (
            <FilterChip
              key={g}
              label={GROUP_BY_LABELS[g]}
              selected={filter.groupBy === g}
              onClick={() => onChange({ ...filter, groupBy: g })}
            />
          ))}
        </div>
      </div>

      <div className="filter-section">
        <span className="chip-label">状态</span>
        <div className="chips">
          {(["online", "offline", "busy", "pinned", "archived"] as SessionStatus[]).map((st) => (
            <FilterChip
              key={st}
              label={SESSION_STATUS_LABELS[st]}
              selected={filter.statuses.has(st)}
              onClick={() => onChange({ ...filter, statuses: toggleSet(filter.statuses, st) })}
            />
          ))}
        </div>
      </div>

      {agents.length > 0 && (
        <div className="filter-section">
          <span className="chip-label">Agent</span>
          <div className="chips">
            {agents.map((a) => (
              <FilterChip
                key={a}
                label={a}
                selected={filter.agents.has(a)}
                onClick={() => onChange({ ...filter, agents: toggleSet(filter.agents, a) })}
              />
            ))}
          </div>
        </div>
      )}

      {cwds.length > 0 && (
        <div className="filter-section">
          <span className="chip-label">工作目录</span>
          <div className="chips">
            {cwds.map((c) => (
              <FilterChip
                key={c}
                label={truncatePath(c)}
                title={c}
                selected={filter.cwds.has(c)}
                onClick={() => onChange({ ...filter, cwds: toggleSet(filter.cwds, c) })}
              />
            ))}
          </div>
        </div>
      )}

      {isFiltered && (
        <div className="filter-section">
          <button
            className="secondary tiny"
            onClick={() =>
              onChange({
                ...filter,
                query: "",
                agents: new Set(),
                cwds: new Set(),
                statuses: new Set(),
                groupBy: "none",
              })
            }
          >
            重置
          </button>
        </div>
      )}
    </div>
  );
}

function FilterSheetRoom({
  filter,
  onChange,
  modes,
  archivedCount,
}: {
  filter: RoomListFilter;
  onChange: (f: RoomListFilter) => void;
  modes: string[];
  archivedCount: number;
}) {
  const isFiltered =
    filter.query.trim() ||
    filter.groupBy !== "none" ||
    filter.modes.size > 0 ||
    filter.showArchived;

  return (
    <div className="filter-sheet-body">
      <input
        className="filter-query"
        placeholder="按名称、成员或模式过滤…"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.currentTarget.value })}
      />

      <div className="filter-section">
        <span className="chip-label">分组</span>
        <div className="chips">
          {(["none", "mode"] as RoomGroupBy[]).map((g) => (
            <FilterChip
              key={g}
              label={GROUP_BY_LABELS[g]}
              selected={filter.groupBy === g}
              onClick={() => onChange({ ...filter, groupBy: g })}
            />
          ))}
        </div>
      </div>

      {archivedCount > 0 && (
        <div className="filter-section">
          <FilterChip
            label={`归档 (${archivedCount})`}
            selected={filter.showArchived}
            onClick={() => onChange({ ...filter, showArchived: !filter.showArchived })}
          />
        </div>
      )}

      {modes.length > 0 && (
        <div className="filter-section">
          <span className="chip-label">模式</span>
          <div className="chips">
            {modes.map((m) => (
              <FilterChip
                key={m}
                label={MODE_LABELS[m] ?? m}
                selected={filter.modes.has(m)}
                onClick={() => onChange({ ...filter, modes: toggleSet(filter.modes, m) })}
              />
            ))}
          </div>
        </div>
      )}

      {isFiltered && (
        <div className="filter-section">
          <button
            className="secondary tiny"
            onClick={() =>
              onChange({
                ...filter,
                query: "",
                modes: new Set(),
                groupBy: "none",
                showArchived: false,
              })
            }
          >
            重置
          </button>
        </div>
      )}
    </div>
  );
}

function SessionCard({ s, batch }: { s: SessionInfo; batch: boolean }) {
  const store = useHubStore();
  const selected = store.selectedIds.sessions.includes(s.sessionId);

  const onClick = () => {
    if (batch) {
      store.selectSession(s.sessionId);
    } else {
      store.openChat(s);
    }
  };

  return (
    <div className={`list-item ${selected ? "selected" : ""}`} onClick={onClick}>
      {batch && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => store.selectSession(s.sessionId)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="dot" style={{ color: s.busy ? "#f1c40f" : s.offline ? "#999" : "#2ecc71" }}>
        ●
      </div>
      <div className="title-wrap">
        <span className="title">
          {store.pinnedIds.includes(s.sessionId) ? "📌 " : ""}
          {store.displayName(s)} {s.busy ? "· 执行中" : ""} {s.offline ? "· 离线" : ""}
        </span>
        <span className="subtitle">
          {s.cwd} · {s.agent}
        </span>
      </div>
      {!batch && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => store.togglePin(s.sessionId)}>
            {store.pinnedIds.includes(s.sessionId) ? "取消置顶" : "置顶"}
          </button>
          <button onClick={() => void store.archiveSession(s, !s.archived)}>
            {s.archived ? "取消归档" : "归档"}
          </button>
          {s.offline && <button onClick={() => void store.resumeSession(s)}>恢复</button>}
          <button className="danger" onClick={() => void store.deleteSession(s)}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function RoomCard({ r, batch }: { r: RoomInfo; batch: boolean }) {
  const store = useHubStore();
  const selected = store.selectedIds.rooms.includes(r.roomId);

  const onClick = () => {
    if (batch) {
      store.selectRoom(r.roomId);
    } else {
      store.openRoom(r);
    }
  };

  return (
    <div className={`list-item ${selected ? "selected" : ""}`} onClick={onClick}>
      {batch && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => store.selectRoom(r.roomId)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <div className="title-wrap">
        <span className="title">
          {r.name} · {MODE_LABELS[r.mode] ?? r.mode}
        </span>
        <span className="subtitle">{r.members.map((m) => m[1]).join("、")}</span>
      </div>
      {!batch && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => void store.archiveRoom(r, !r.archived)}>
            {r.archived ? "取消归档" : "归档"}
          </button>
          <button className="danger" onClick={() => void store.deleteRooms([r.roomId])}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function SessionDialog({ onClose }: { onClose: () => void }) {
  const store = useHubStore();
  const [form, setForm] = useState({
    cwd: "",
    name: "",
    connectionId: "",
    roleId: "",
  });

  const selectedConn = store.connections.find((c) => c.id === form.connectionId);

  const submit = () => {
    if (!form.cwd || !form.name || !form.connectionId) return;
    const conn = store.connections.find((c) => c.id === form.connectionId);
    if (!conn) return;
    void store.createSession(form.cwd, form.name, form.connectionId, form.roleId || undefined);
    onClose();
  };

  const selectRole = (roleId: string) => {
    const role = store.roles.find((r) => r.id === roleId);
    if (!role) {
      setForm({ ...form, roleId: "" });
      return;
    }
    setForm({
      ...form,
      roleId,
      name: role.name,
      cwd: role.cwd || form.cwd,
      connectionId: role.connectionId || form.connectionId,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        <FormRow label="工作目录">
          <input value={form.cwd} onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })} />
        </FormRow>
        <FormRow label="名称">
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
        </FormRow>
        <FormRow label="连接">
          <select value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}>
            <option value="">请选择</option>
            {store.connections
              .filter((c) => c.online || c.local)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.agent}) {c.local ? "本机" : ""}
                </option>
              ))}
          </select>
          {selectedConn?.error && <div className="error" style={{ marginTop: "0.25rem" }}>{selectedConn.error}</div>}
        </FormRow>
        <FormRow label="角色">
          <select value={form.roleId} onChange={(e) => selectRole(e.currentTarget.value)}>
            <option value="">可选</option>
            {store.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} {r.builtin ? "(内置)" : ""}
              </option>
            ))}
          </select>
        </FormRow>
        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button onClick={submit} disabled={!form.cwd || !form.name || !form.connectionId || !selectedConn}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

type RoomModeOption = { value: string; label: string; description: string; suggestWhen?: string };

const MODES: RoomModeOption[] = [
  {
    value: "mention",
    label: "普通群 (@mention / 广播)",
    description: "成员自由发言，@某个成员时该成员单独回答。适合闲聊、快速提问。",
    suggestWhen: "闲聊、单点提问",
  },
  {
    value: "conductor",
    label: "指挥家（拆解派工汇总）",
    description: "指挥家自动拆解任务，派发给不同成员并行执行，最后汇总结果。适合复杂任务。",
    suggestWhen: "复杂任务、需要分工",
  },
  {
    value: "roundrobin",
    label: "轮询（轮流作答）",
    description: "每个问题按顺序由一个成员回答，可设置起始发言人。适合多角色依次表态。",
    suggestWhen: "依次表态、轮流负责",
  },
  {
    value: "parallel",
    label: "并行（集思广益 + 汇总）",
    description: "所有成员同时回答同一个问题，最后由汇总者综合出一致结论。适合头脑风暴。",
    suggestWhen: "头脑风暴、收集多观点",
  },
  {
    value: "pipeline",
    label: "流水线（按成员顺序串行）",
    description: "成员按指定顺序串行处理，后一个成员基于前一个的结果继续。适合多步骤流程。",
    suggestWhen: "多步骤、前后依赖",
  },
  {
    value: "debate",
    label: "辩论（正反方 + 裁判）",
    description: "正方与反方交替辩论若干轮，最后由裁判给出公正总结。适合观点碰撞。",
    suggestWhen: "观点辩论、利弊分析",
  },
  {
    value: "auto",
    label: "自动（由主持人选择模式）",
    description: "主持人根据任务内容自动选择最合适的协作模式。不确定选哪个时可用。",
    suggestWhen: "不确定适合哪种模式",
  },
];

function recommendMode(name: string): string | null {
  const n = name.toLowerCase();
  if (/bug|fix|测试|test|review|审查|重构|refactor|实现|implement|添加功能|feature|任务|分工|拆解/.test(n)) return "conductor";
  if (/brainstorm|头脑风暴|想法|方案|收集|调研|优缺点|分析|集思广益|多观点/.test(n)) return "parallel";
  if (/辩论|debate|正反|利弊|争论|对比|vs|观点碰撞/.test(n)) return "debate";
  if (/流程|流水线|pipeline|步骤|step|顺序|sequence|链路|串联|串行/.test(n)) return "pipeline";
  if (/轮流|轮询|round|依次|每人|顺序发言/.test(n)) return "roundrobin";
  if (/闲聊|讨论|提问|@|广播|通知/.test(n)) return "mention";
  return null;
}

function RoomDialog({ onClose }: { onClose: () => void }) {
  const store = useHubStore();
  const [form, setForm] = useState({
    name: "",
    mode: "mention",
    selected: [] as string[],
    specialId: "",
    pipelineOrder: [] as string[],
    debateSides: ["", ""] as [string, string],
    debateJudge: "",
    debateRounds: 2,
    memberRoles: {} as Record<string, string>,
  });
  const [modeManuallyChanged, setModeManuallyChanged] = useState(false);

  const available = store.sessions.filter((s) => !s.archived);

  const selectedSessions = form.selected
    .map((id) => store.sessions.find((s) => s.sessionId === id))
    .filter((s): s is SessionInfo => !!s);

  const selectedOptions = selectedSessions.map((s) => (
    <option key={s.sessionId} value={s.sessionId}>
      {s.name}
    </option>
  ));

  const ensureDebateDefaults = (selected: string[]) => {
    const sides: [string, string] = [...form.debateSides];
    if (!sides[0] && selected[0]) sides[0] = selected[0];
    if (!sides[1] && selected[1]) sides[1] = selected[1];
    return sides;
  };

  const toggle = (id: string) => {
    const next = form.selected.includes(id)
      ? form.selected.filter((x) => x !== id)
      : [...form.selected, id];
    const nextOrder = form.pipelineOrder.filter((sid) => next.includes(sid));
    for (const sid of next) {
      if (!nextOrder.includes(sid)) nextOrder.push(sid);
    }
    const nextRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([sid]) => next.includes(sid)),
    );
    setForm({
      ...form,
      selected: next,
      specialId: next.includes(form.specialId) ? form.specialId : "",
      pipelineOrder: nextOrder,
      debateSides: ensureDebateDefaults(next),
      debateJudge: next.includes(form.debateJudge) ? form.debateJudge : "",
      memberRoles: nextRoles,
    });
  };

  const movePipeline = (index: number, dir: -1 | 1) => {
    const order = [...form.pipelineOrder];
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setForm({ ...form, pipelineOrder: order });
  };

  const isValid = (): boolean => {
    if (form.selected.length < 2 || !form.name.trim()) return false;
    switch (form.mode) {
      case "conductor":
      case "auto":
      case "roundrobin":
      case "parallel":
      case "debate":
        return !!form.specialId;
      case "pipeline":
        return form.pipelineOrder.length > 0;
      default:
        return true;
    }
  };

  const submit = () => {
    if (!isValid()) return;
    const config: RoomModeConfig = {};
    if (form.specialId) {
      if (form.mode === "conductor" || form.mode === "auto" || form.mode === "roundrobin") {
        config.conductorId = form.specialId;
      } else if (form.mode === "parallel") {
        config.parallelSummarizerId = form.specialId;
      } else if (form.mode === "debate") {
        config.debateJudge = form.specialId;
      }
    }
    if (form.mode === "pipeline" && form.pipelineOrder.length > 0) {
      config.pipelineOrder = form.pipelineOrder;
    }
    if (form.mode === "debate") {
      if (form.debateSides[0] && form.debateSides[1]) {
        config.debateSides = form.debateSides;
      }
      config.debateRounds = Math.max(1, Math.min(5, form.debateRounds));
    }
    const memberRoles = Object.fromEntries(
      Object.entries(form.memberRoles).filter(([, v]) => v.trim()),
    );
    void store.createRoom(form.name, form.selected, form.mode, config, memberRoles);
    onClose();
  };

  const onModeChange = (mode: string) => {
    setModeManuallyChanged(true);
    setForm({
      ...form,
      mode,
      specialId: "",
      debateSides: ensureDebateDefaults(form.selected),
    });
  };

  const renderConfig = () => {
    switch (form.mode) {
      case "conductor":
      case "auto":
      case "roundrobin":
      case "parallel":
      case "debate":
        const label =
          form.mode === "conductor"
            ? "指挥家"
            : form.mode === "auto"
              ? "主持人"
              : form.mode === "roundrobin"
                ? "起始发言人"
                : form.mode === "parallel"
                  ? "汇总者"
                  : "裁判";
        return (
          <FormRow label={label}>
            <select
              value={form.specialId}
              onChange={(e) => setForm({ ...form, specialId: e.currentTarget.value })}
            >
              <option value="">请选择</option>
              {selectedOptions}
            </select>
          </FormRow>
        );
      case "pipeline":
        return (
          <FormRow label="执行顺序">
            <div className="pipeline-order">
              {form.pipelineOrder.map((sid, i) => {
                const s = store.sessions.find((x) => x.sessionId === sid);
                if (!s) return null;
                return (
                  <div key={sid} className="pipeline-item">
                    <span className="pipeline-name">
                      {i + 1}. {s.name}
                    </span>
                    <div className="pipeline-actions">
                      <button
                        className="secondary tiny"
                        disabled={i === 0}
                        onClick={() => movePipeline(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="secondary tiny"
                        disabled={i === form.pipelineOrder.length - 1}
                        onClick={() => movePipeline(i, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </FormRow>
        );
      default:
        return null;
    }
  };

  const renderDebateConfig = () => {
    if (form.mode !== "debate") return null;
    return (
      <>
        <FormRow label="正方">
          <select
            value={form.debateSides[0]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [e.currentTarget.value, form.debateSides[1]] as [string, string],
              })
            }
          >
            <option value="">请选择</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label="反方">
          <select
            value={form.debateSides[1]}
            onChange={(e) =>
              setForm({
                ...form,
                debateSides: [form.debateSides[0], e.currentTarget.value] as [string, string],
              })
            }
          >
            <option value="">请选择</option>
            {selectedOptions}
          </select>
        </FormRow>
        <FormRow label="轮数">
          <input
            type="number"
            min={1}
            max={5}
            value={form.debateRounds}
            onChange={(e) =>
              setForm({ ...form, debateRounds: Math.max(1, Math.min(5, Number(e.currentTarget.value) || 1)) })
            }
          />
        </FormRow>
      </>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建群聊</h3>
        <FormRow label="名称">
          <input
            value={form.name}
            onChange={(e) => {
              const name = e.currentTarget.value;
              const next: typeof form = { ...form, name };
              if (!modeManuallyChanged) {
                const recommended = recommendMode(name);
                if (recommended && recommended !== form.mode) {
                  next.mode = recommended;
                  next.specialId = "";
                }
              }
              setForm(next);
            }}
          />
        </FormRow>
        <FormRow label="模式">
          <select value={form.mode} onChange={(e) => onModeChange(e.currentTarget.value)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </FormRow>
        {(() => {
          const modeInfo = MODES.find((m) => m.value === form.mode);
          if (!modeInfo) return null;
          return (
            <div className="form-row mode-description">
              <span className="subtitle">{modeInfo.description}</span>
            </div>
          );
        })()}

        {renderConfig()}
        {renderDebateConfig()}

        <div className="card" style={{ maxHeight: 280, overflow: "auto" }}>
          <h4>选择成员与角色</h4>
          {available.map((s) => (
            <div key={s.sessionId} className="member-row">
              <label className="member-check">
                <input
                  type="checkbox"
                  checked={form.selected.includes(s.sessionId)}
                  onChange={() => toggle(s.sessionId)}
                />
                {store.displayName(s)}
              </label>
              {form.selected.includes(s.sessionId) && (
                <select
                  className="role-select"
                  value={form.memberRoles[s.sessionId] ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      memberRoles: {
                        ...form.memberRoles,
                        [s.sessionId]: e.currentTarget.value,
                      },
                    })
                  }
                >
                  <option value="">默认（无角色卡）</option>
                  {store.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </div>

        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button onClick={submit} disabled={!isValid()}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      {children}
    </div>
  );
}
