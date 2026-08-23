import { useState } from "react";
import { X } from "lucide-react";
import {
  FilterChip,
  GROUP_BY_LABELS,
  MODE_LABELS,
  SESSION_STATUS_LABELS,
  toggleSet,
  truncatePath,
  type RoomGroupBy,
  type RoomListFilter,
  type SessionGroupBy,
  type SessionListFilter,
  type SessionStatus,
} from "../session-shared";

export function FilterSheet({
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
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={15} />
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
