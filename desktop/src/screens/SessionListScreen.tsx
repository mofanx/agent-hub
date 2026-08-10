import { useEffect, useMemo, useState } from "react";
import { useHubStore } from "../hub/store";
import type { RoomInfo, RoomModeConfig, SessionInfo } from "../hub/types";

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

  const visibleRooms = useMemo(
    () => store.rooms.filter((r) => (showArchived ? true : !r.archived)),
    [store.rooms, showArchived],
  );

  const archivedRooms = useMemo(
    () => store.rooms.filter((r) => r.archived),
    [store.rooms],
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
            <h2>
              群聊 ({visibleRooms.length})
              {archivedRooms.length > 0 && (
                <button
                  className="secondary archived-toggle"
                  onClick={() => setShowArchived(!showArchived)}
                >
                  {showArchived ? "隐藏归档" : `归档 (${archivedRooms.length})`}
                </button>
              )}
            </h2>
            <div className="list">
              {visibleRooms.map((r) => (
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

const MODE_LABELS: Record<string, string> = {
  mention: "普通群",
  conductor: "指挥家",
  roundrobin: "轮询",
  parallel: "并行",
  pipeline: "流水线",
  debate: "辩论",
  auto: "自动",
};

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
                    <span className="pipeline-name">{i + 1}. {s.name}</span>
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
