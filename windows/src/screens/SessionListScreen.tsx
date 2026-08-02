import { useEffect, useMemo, useState } from "react";
import { useHubStore } from "../hub/store";
import type { RoomInfo, SessionInfo } from "../hub/types";

type Dialog =
  | { type: "session" }
  | { type: "room" }
  | { type: "room-members"; name: string; mode: string; conductorId?: string }
  | null;

export function SessionListScreen() {
  const store = useHubStore();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [batch, setBatch] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    if (query.trim()) {
      const t = setTimeout(() => void store.search(query.trim()), 200);
      return () => clearTimeout(t);
    } else {
      store.search("");
    }
  }, [query]);

  useEffect(() => {
    if (!batch) store.clearSelection();
  }, [batch]);

  const visibleSessions = useMemo(() => {
    const pinned = new Set(store.pinnedIds);
    const list = store.sessions.filter((s) => (showArchived ? true : !s.archived));
    return list.sort((a, b) => {
      const pa = pinned.has(a.sessionId) ? 1 : 0;
      const pb = pinned.has(b.sessionId) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.name.localeCompare(b.name);
    });
  }, [store.sessions, store.pinnedIds, showArchived]);

  const archived = useMemo(
    () => store.sessions.filter((s) => s.archived),
    [store.sessions],
  );

  const inSearch = query.trim() !== "";

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
    if (
      !confirm(`确认删除选中的 ${sessions.length} 个会话和 ${rooms.length} 个群？此操作不可撤销。`)
    )
      return;
    void store.batchDelete(sessions, rooms);
  };

  return (
    <div className="session-list">
      <div className="session-toolbar">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="搜索历史消息…"
        />
        <button onClick={() => void store.refreshAll()}>刷新</button>
        <button onClick={() => setBatch(!batch)}>{batch ? "退出批量" : "批量"}</button>
        <button onClick={() => setDialog({ type: "session" })}>＋会话</button>
        <button onClick={() => setDialog({ type: "room" })}>＋群聊</button>
        <button onClick={() => useHubStore.setState({ screen: "settings" })}>设置</button>
      </div>

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
        <SearchResults />
      ) : (
        <>
          <section>
            <h2>
              会话 ({visibleSessions.length})
              {archived.length > 0 && (
                <button
                  className="secondary archived-toggle"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  {showArchived ? "隐藏归档" : `归档 (${archived.length})`}
                </button>
              )}
            </h2>
            <div className="list">
              {visibleSessions.map((s) => (
                <SessionCard key={s.sessionId} s={s} batch={batch} />
              ))}
            </div>
          </section>

          <section>
            <h2>群聊 ({store.rooms.length})</h2>
            <div className="list">
              {store.rooms.map((r) => (
                <RoomCard key={r.roomId} r={r} batch={batch} />
              ))}
            </div>
          </section>
        </>
      )}

      {dialog?.type === "session" && <SessionDialog onClose={() => setDialog(null)} />}
      {dialog?.type === "room" && <RoomDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function SearchResults() {
  const store = useHubStore();
  if (!store.searchResults.length) {
    return <div className="empty">无结果</div>;
  }
  return (
    <div className="list">
      {store.searchResults.map((h, i) => (
        <div
          key={i}
          className="list-item"
          onClick={() => {
            store.openSearchHit(h);
          }}
        >
          <span className="title">
            {h.author || "系统"} · {h.scope === "room" ? "群聊" : "单聊"}
          </span>
          <span className="subtitle">{h.text.slice(0, 120)}</span>
        </div>
      ))}
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
          {r.name} {r.mode === "conductor" ? "· 指挥家" : ""}
        </span>
        <span className="subtitle">{r.members.map((m) => m[1]).join("、")}</span>
      </div>
      {!batch && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
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
          <input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.currentTarget.value })}
          />
        </FormRow>
        <FormRow label="名称">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </FormRow>
        <FormRow label="连接">
          <select
            value={form.connectionId}
            onChange={(e) => setForm({ ...form, connectionId: e.currentTarget.value })}
          >
            <option value="">请选择</option>
            {store.connections
              .filter((c) => c.online || c.local)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.agent}) {c.local ? "本机" : ""}
                </option>
              ))}
          </select>
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
          <button
            onClick={submit}
            disabled={!form.cwd || !form.name || !form.connectionId || !selectedConn}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomDialog({ onClose }: { onClose: () => void }) {
  const store = useHubStore();
  const [form, setForm] = useState({
    name: "",
    mode: "mention",
    conductorId: "",
    selected: [] as string[],
  });

  const toggle = (id: string) => {
    setForm({
      ...form,
      selected: form.selected.includes(id)
        ? form.selected.filter((x) => x !== id)
        : [...form.selected, id],
    });
  };

  const submit = () => {
    if (form.selected.length < 2 || !form.name) return;
    if (form.mode === "conductor" && !form.conductorId) return;
    void store.createRoom(form.name, form.selected, form.mode, form.conductorId || undefined);
    onClose();
  };

  const available = store.sessions.filter((s) => !s.archived);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建群聊</h3>
        <FormRow label="名称">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </FormRow>
        <FormRow label="模式">
          <select
            value={form.mode}
            onChange={(e) => setForm({ ...form, mode: e.currentTarget.value, conductorId: "" })}
          >
            <option value="mention">普通群 (@mention / 广播)</option>
            <option value="conductor">指挥家</option>
          </select>
        </FormRow>

        {form.mode === "conductor" && (
          <FormRow label="指挥家">
            <select
              value={form.conductorId}
              onChange={(e) => setForm({ ...form, conductorId: e.currentTarget.value })}
            >
              <option value="">请选择</option>
              {form.selected.map((id) => {
                const s = store.sessions.find((x) => x.sessionId === id);
                if (!s) return null;
                return (
                  <option key={id} value={id}>
                    {s.name}
                  </option>
                );
              })}
            </select>
          </FormRow>
        )}

        <div className="card" style={{ maxHeight: 200, overflow: "auto" }}>
          <h4>选择成员</h4>
          {available.map((s) => (
            <label key={s.sessionId} className="member-check">
              <input
                type="checkbox"
                checked={form.selected.includes(s.sessionId)}
                onChange={() => toggle(s.sessionId)}
              />
              {store.displayName(s)}
            </label>
          ))}
        </div>

        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            onClick={submit}
            disabled={
              form.selected.length < 2 ||
              !form.name ||
              (form.mode === "conductor" && !form.conductorId)
            }
          >
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
