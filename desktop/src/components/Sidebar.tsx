import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  ChevronsUpDown,
  Copy,
  ListFilter,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Sun,
  Trash2,
  Unplug,
  Users,
  X,
} from "lucide-react";
import { useHubStore } from "../hub/store";
import type { ConnProfile, RoomInfo, SessionInfo } from "../hub/types";
import {
  MODE_LABELS,
  buildActiveRoomChips,
  buildActiveSessionChips,
  isSessionStatus,
  sessionStatuses,
  toggleSet,
  truncatePath,
  FilterChip,
  SearchGroupCard,
  type RoomListFilter,
  type SessionListFilter,
} from "../screens/session-shared";
import { SessionDialog } from "../screens/dialogs/SessionDialog";
import { RoomDialog } from "../screens/dialogs/RoomDialog";
import { FilterSheet } from "../screens/dialogs/FilterSheet";

type Dialog = { type: "session" } | { type: "room" } | null;

const EMPTY_SESSION_FILTER: SessionListFilter = {
  query: "",
  agents: new Set(),
  cwds: new Set(),
  statuses: new Set(),
  groupBy: "none",
};

const EMPTY_ROOM_FILTER: RoomListFilter = {
  query: "",
  modes: new Set(),
  groupBy: "none",
  showArchived: false,
};

export function Sidebar() {
  const store = useHubStore();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebarCollapsed") === "1");
  const [query, setQuery] = useState("");
  const [batch, setBatch] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [showFilter, setShowFilter] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<SessionListFilter>(EMPTY_SESSION_FILTER);
  const [roomFilter, setRoomFilter] = useState<RoomListFilter>(EMPTY_ROOM_FILTER);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem("sidebarCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (query.trim()) {
      const t = setTimeout(() => void store.search(query.trim()), 200);
      return () => clearTimeout(t);
    }
    useHubStore.setState({ searchQuery: "", searchGroups: [] });
  }, [query]);

  useEffect(() => {
    if (!batch) store.clearSelection();
  }, [batch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (collapsed) setCollapsed(false);
        searchInputRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setDialog({ type: "session" });
      }
      if (e.key === "Escape" && (query || showFilter)) {
        if (showFilter) setShowFilter(false);
        setQuery("");
        setSessionFilter(EMPTY_SESSION_FILTER);
        setRoomFilter(EMPTY_ROOM_FILTER);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [query, showFilter, collapsed]);

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

  const archivedRoomCount = useMemo(() => store.rooms.filter((r) => r.archived).length, [store.rooms]);

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
          const hay = `${r.name} ${r.mode.toLowerCase()} ${members}`;
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (roomFilter.groupBy === "none") return [{ title: "", rooms: list }];
    const map = new Map<string, RoomInfo[]>();
    for (const r of list) {
      if (!map.has(r.mode)) map.set(r.mode, []);
      map.get(r.mode)!.push(r);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, rooms]) => ({ title, rooms }));
  }, [store.rooms, roomFilter]);

  const activeChips = useMemo(
    () => [
      ...buildActiveSessionChips(sessionFilter, availableAgents, availableCwds),
      ...buildActiveRoomChips(roomFilter, availableModes, archivedRoomCount),
    ],
    [sessionFilter, roomFilter, availableAgents, availableCwds, availableModes, archivedRoomCount],
  );

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
    if (allSelected) store.clearSelection();
    else {
      allS.forEach((id) => store.selectSession(id));
      allR.forEach((id) => store.selectRoom(id));
    }
  };

  const invertSelection = () => {
    const nextS = store.sessions.map((s) => s.sessionId).filter((id) => !store.selectedIds.sessions.includes(id));
    const nextR = store.rooms.map((r) => r.roomId).filter((id) => !store.selectedIds.rooms.includes(id));
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

  const cycleTheme = () => {
    const order = ["system", "light", "dark"];
    const next = order[(order.indexOf(store.themeMode) + 1) % order.length];
    store.updateThemeMode(next);
  };

  const inSearch = query.trim() !== "";
  const sessionCount = sessionGroups.reduce((sum, g) => sum + g.sessions.length, 0);
  const roomCount = roomGroups.reduce((sum, g) => sum + g.rooms.length, 0);
  const batchCount = store.selectedIds.sessions.length + store.selectedIds.rooms.length;

  const themeIcon =
    store.themeMode === "dark" ? <Moon size={15} /> : store.themeMode === "light" ? <Sun size={15} /> : <Monitor size={15} />;

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <img src="/logo.svg" alt="Agent Hub" />
        <span
          className="dot rail-status"
          title={store.agentStatus}
          style={{ background: store.client?.isConnected ? "var(--success)" : "var(--warn)" }}
        />
        <div className="rail-list">
          {store.sessions.filter((s) => !s.archived).slice(0, 12).map((s) => (
            <button
              key={s.sessionId}
              className={`icon-btn ${store.currentSession?.sessionId === s.sessionId ? "active" : ""}`}
              title={store.displayName(s)}
              onClick={() => store.openChat(s)}
            >
              <span className="dot" style={{ background: s.busy ? "var(--warn)" : s.offline ? "var(--muted)" : "var(--success)" }} />
            </button>
          ))}
        </div>
        <button className="icon-btn" title="展开侧栏" onClick={() => setCollapsed(false)}>
          <PanelLeftOpen size={16} />
        </button>
        <button className="icon-btn" title="设置" onClick={() => useHubStore.setState({ screen: "settings" })}>
          <Settings size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand" style={{ cursor: "pointer" }} title="返回首页" onClick={() => store.backToList()}>
        <img src="/logo.svg" alt="Agent Hub" />
        <span className="brand-name">Agent Hub</span>
        <button className="icon-btn" title="收起侧栏" onClick={(e) => { e.stopPropagation(); setCollapsed(true); }}>
          <PanelLeftClose size={15} />
        </button>
      </div>

      <HubCard />

      <div className="sidebar-search">
        <span className="search-icon">
          <Search size={13} />
        </span>
        <input
          ref={searchInputRef}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="搜索会话、群聊、消息…"
          title="Ctrl+K"
        />
      </div>

      {activeChips.length > 0 && (
        <div className="sidebar-chips">
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
          <button className="tiny secondary" onClick={selectAll}>
            全选
          </button>
          <button className="tiny secondary" onClick={invertSelection}>
            反选
          </button>
          <span className="count">已选 {batchCount}</span>
          <button className="tiny danger" onClick={onBatchDelete} disabled={batchCount === 0}>
            <Trash2 size={12} /> 删除
          </button>
          <button className="tiny secondary" onClick={() => setBatch(false)}>
            退出
          </button>
        </div>
      )}

      <div className="sidebar-scroll">
        {inSearch ? (
          <SidebarSearchResults query={query} />
        ) : (
          <>
            <div className="sidebar-section">
              <span className="section-label">
                会话 <span>{sessionCount}</span>
              </span>
              <span className="section-actions">
                <button
                  className={`icon-btn ${activeChips.length > 0 ? "active" : ""}`}
                  title="筛选"
                  onClick={() => setShowFilter(true)}
                >
                  <ListFilter size={13} />
                </button>
                <button className="icon-btn" title="新建会话 (Ctrl+N)" onClick={() => setDialog({ type: "session" })}>
                  <Plus size={14} />
                </button>
              </span>
            </div>
            {sessionGroups.map((g) => (
              <div key={g.title || "_"}>
                {g.title && (
                  <div className="nav-group-header">
                    {sessionFilter.groupBy === "cwd" ? truncatePath(g.title, 28) : g.title} ({g.sessions.length})
                  </div>
                )}
                {g.sessions.map((s) => (
                  <SessionNavItem key={s.sessionId} s={s} batch={batch} />
                ))}
              </div>
            ))}
            {sessionCount === 0 && <div className="empty">暂无会话</div>}

            <div className="sidebar-section">
              <span className="section-label">
                群聊 <span>{roomCount}</span>
              </span>
              <span className="section-actions">
                <button className="icon-btn" title="新建群聊" onClick={() => setDialog({ type: "room" })}>
                  <Plus size={14} />
                </button>
              </span>
            </div>
            {roomGroups.map((g) => (
              <div key={g.title || "_"}>
                {g.title && (
                  <div className="nav-group-header">
                    {MODE_LABELS[g.title] ?? g.title} ({g.rooms.length})
                  </div>
                )}
                {g.rooms.map((r) => (
                  <RoomNavItem key={r.roomId} r={r} batch={batch} />
                ))}
              </div>
            ))}
            {roomCount === 0 && <div className="empty">暂无群聊</div>}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          className={`icon-btn ${batch ? "active" : ""}`}
          title={batch ? "退出批量管理" : "批量管理"}
          onClick={() => setBatch(!batch)}
        >
          {batch ? <X size={15} /> : <CheckSquare size={15} />}
        </button>
        <button className="icon-btn" title="刷新" onClick={() => void store.refreshAll()}>
          <RefreshCw size={15} />
        </button>
        <span className="spacer" />
        <button
          className="icon-btn"
          title={`主题：${store.themeMode === "system" ? "跟随系统" : store.themeMode === "light" ? "浅色" : "深色"}（点击切换）`}
          onClick={cycleTheme}
        >
          {themeIcon}
        </button>
        <button
          className={`icon-btn ${store.screen === "settings" ? "active" : ""}`}
          title="设置"
          onClick={() => useHubStore.setState({ screen: "settings" })}
        >
          <Settings size={15} />
        </button>
      </div>

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
    </aside>
  );
}

function HubCard() {
  const store = useHubStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const connected = !!store.client?.isConnected;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onSelect = (p: ConnProfile) => {
    setOpen(false);
    store.switchProfile(p);
  };

  return (
    <div className="hub-popover-wrap" ref={wrapRef}>
      <div className="hub-card" onClick={() => setOpen(!open)}>
        <span className="dot" style={{ background: connected ? "var(--success)" : "var(--warn)" }} />
        <div className="title-wrap">
          <span className="hub-name">{store.currentProfile?.name ?? "未连接"}</span>
          <span className="hub-addr">{store.currentProfile?.address ?? "点击配置 Hub"}</span>
        </div>
        <ChevronsUpDown size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
      </div>
      {open && (
        <div className="hub-popover">
          {store.profiles.length === 0 && <div className="empty">暂无保存的 Hub</div>}
          {store.profiles.map((p) => {
            const active = store.currentProfile?.address === p.address;
            return (
              <div key={p.address} className={`hub-popover-item ${active ? "active" : ""}`} onClick={() => onSelect(p)}>
                <span
                  className="dot"
                  style={{ background: active ? (connected ? "var(--success)" : "var(--warn)") : "var(--border-strong)" }}
                />
                <div className="title-wrap">
                  <span className="title">{p.name}</span>
                  <span className="subtitle">{p.address}</span>
                </div>
              </div>
            );
          })}
          <div className="hub-popover-sep" />
          <div
            className="hub-popover-item"
            onClick={() => {
              setOpen(false);
              useHubStore.setState({ screen: "connect" });
            }}
          >
            <Plus size={14} style={{ color: "var(--muted)" }} />
            <span className="title">添加 / 管理 Hub</span>
          </div>
          {store.client && (
            <div
              className="hub-popover-item"
              onClick={() => {
                setOpen(false);
                store.disconnect();
              }}
            >
              <Unplug size={14} style={{ color: "var(--danger)" }} />
              <span className="title" style={{ color: "var(--danger)" }}>
                断开当前连接
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionNavItem({ s, batch }: { s: SessionInfo; batch: boolean }) {
  const store = useHubStore();
  const selected = store.selectedIds.sessions.includes(s.sessionId);
  const active = store.currentSession?.sessionId === s.sessionId;
  const pinned = store.pinnedIds.includes(s.sessionId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);

  return (
    <div
      className={`nav-item ${active ? "active" : ""} ${batch && selected ? "selected" : ""}`}
      onClick={() => (batch ? store.selectSession(s.sessionId) : store.openChat(s))}
    >
      {batch && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => store.selectSession(s.sessionId)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span
        className="dot"
        style={{ background: s.busy ? "var(--warn)" : s.offline ? "var(--muted)" : "var(--success)" }}
      />
      <div className="nav-text">
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void store.renameSession(s, name.trim() || s.name);
                setRenaming(false);
              } else if (e.key === "Escape") {
                setName(s.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <span className="nav-title">
              {pinned && (
                <span className="pin-mark">
                  <Pin size={10} />
                </span>
              )}
              {store.displayName(s)}
              {s.busy && <span className="busy-tag">执行中</span>}
              {s.offline && <span className="offline-tag">离线</span>}
            </span>
            <span className="nav-sub">{truncatePath(s.cwd, 34)}</span>
          </>
        )}
      </div>
      {!batch && !renaming && (
        <div className="nav-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title={pinned ? "取消置顶" : "置顶"} onClick={() => store.togglePin(s.sessionId)}>
            <Pin size={12} />
          </button>
          <button className="icon-btn" title="重命名" onClick={() => { setName(s.name); setRenaming(true); }}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn" title="克隆" onClick={() => void store.cloneSession(s)}>
            <Copy size={12} />
          </button>
          <button
            className="icon-btn"
            title={s.archived ? "取消归档" : "归档"}
            onClick={() => void store.archiveSession(s, !s.archived)}
          >
            {s.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
          {s.offline && (
            <button className="icon-btn" title="恢复" onClick={() => void store.resumeSession(s)}>
              <RotateCw size={12} />
            </button>
          )}
          <button className="icon-btn danger" title="删除" onClick={() => void store.deleteSession(s)}>
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function RoomNavItem({ r, batch }: { r: RoomInfo; batch: boolean }) {
  const store = useHubStore();
  const selected = store.selectedIds.rooms.includes(r.roomId);
  const active = store.currentRoom?.roomId === r.roomId;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(r.name);

  return (
    <div
      className={`nav-item ${active ? "active" : ""} ${batch && selected ? "selected" : ""}`}
      onClick={() => (batch ? store.selectRoom(r.roomId) : store.openRoom(r))}
    >
      {batch && (
        <input
          type="checkbox"
          checked={selected}
          onChange={() => store.selectRoom(r.roomId)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <Users size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
      <div className="nav-text">
        {renaming ? (
          <input
            className="rename-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void store.renameRoom(r, name.trim() || r.name);
                setRenaming(false);
              } else if (e.key === "Escape") {
                setName(r.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <>
            <span className="nav-title">
              {r.name}
              {r.archived && <span className="offline-tag">已归档</span>}
            </span>
            <span className="nav-sub">
              {MODE_LABELS[r.mode] ?? r.mode} · {r.members.map((m) => m[1]).join("、")}
            </span>
          </>
        )}
      </div>
      {!batch && !renaming && (
        <div className="nav-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="重命名" onClick={() => { setName(r.name); setRenaming(true); }}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn" title="克隆" onClick={() => void store.cloneRoom(r, `${r.name} (副本)`)}>
            <Copy size={12} />
          </button>
          <button
            className="icon-btn"
            title={r.archived ? "取消归档" : "归档"}
            onClick={() => void store.archiveRoom(r, !r.archived)}
          >
            {r.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
          <button className="icon-btn danger" title="删除" onClick={() => void store.deleteRooms([r.roomId])}>
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarSearchResults({ query }: { query: string }) {
  const store = useHubStore();
  const q = query.trim().toLowerCase();

  const sessionMatches = useMemo(() => {
    if (!q) return [];
    return store.sessions
      .filter((s) => `${s.name} ${s.cwd} ${s.agent} ${store.sessionOrigin(s)}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        const pa = store.pinnedIds.includes(a.sessionId) ? 1 : 0;
        const pb = store.pinnedIds.includes(b.sessionId) ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);
  }, [q, store.sessions, store.pinnedIds, store.sessionOrigin]);

  const roomMatches = useMemo(() => {
    if (!q) return [];
    return store.rooms
      .filter((r) => {
        if (r.archived) return false;
        const members = r.members.map((m) => m[1]).join(" ").toLowerCase();
        return `${r.name} ${r.mode} ${members}`.toLowerCase().includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 5);
  }, [q, store.rooms]);

  const hasAny = sessionMatches.length > 0 || roomMatches.length > 0 || store.searchGroups.length > 0;
  if (!hasAny) return <div className="empty">无结果</div>;

  return (
    <div>
      {sessionMatches.length > 0 && (
        <>
          <div className="nav-group-header">会话 ({sessionMatches.length})</div>
          {sessionMatches.map((s) => (
            <SessionNavItem key={s.sessionId} s={s} batch={false} />
          ))}
        </>
      )}
      {roomMatches.length > 0 && (
        <>
          <div className="nav-group-header">群聊 ({roomMatches.length})</div>
          {roomMatches.map((r) => (
            <RoomNavItem key={r.roomId} r={r} batch={false} />
          ))}
        </>
      )}
      {store.searchGroups.length > 0 && (
        <>
          <div className="nav-group-header">
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
