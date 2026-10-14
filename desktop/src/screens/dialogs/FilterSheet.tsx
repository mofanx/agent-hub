import { useState } from "react";
import { X } from "lucide-react";
import { useHubStore } from "../../hub/store";
import { stringsFor } from "../../hub/strings";
import {
  FilterChip,
  groupByLabel,
  modeLabel,
  sessionStatusLabel,
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
  const S = stringsFor(useHubStore().lang);
  const [tab, setTab] = useState<"session" | "room">("session");
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet-tabs">
          <button className={tab === "session" ? "active" : ""} onClick={() => setTab("session")}>
            {S.sessionsLabel}
          </button>
          <button className={tab === "room" ? "active" : ""} onClick={() => setTab("room")}>
            {S.roomsLabel}
          </button>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title={S.close}>
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
  const S = stringsFor(useHubStore().lang);
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
        placeholder={S.sessionFilterPlaceholder}
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.currentTarget.value })}
      />

      <div className="filter-section">
        <span className="chip-label">{S.groupBySection}</span>
        <div className="chips">
          {(["none", "agent", "cwd"] as SessionGroupBy[]).map((g) => (
            <FilterChip
              key={g}
              label={groupByLabel(S, g)}
              selected={filter.groupBy === g}
              onClick={() => onChange({ ...filter, groupBy: g })}
            />
          ))}
        </div>
      </div>

      <div className="filter-section">
        <span className="chip-label">{S.statusSectionLabel}</span>
        <div className="chips">
          {(["online", "offline", "busy", "pinned", "archived"] as SessionStatus[]).map((st) => (
            <FilterChip
              key={st}
              label={sessionStatusLabel(S, st)}
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
          <span className="chip-label">{S.cwdSection}</span>
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
            {S.resetLabel}
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
  const S = stringsFor(useHubStore().lang);
  const isFiltered =
    filter.query.trim() ||
    filter.groupBy !== "none" ||
    filter.modes.size > 0 ||
    filter.showArchived;

  return (
    <div className="filter-sheet-body">
      <input
        className="filter-query"
        placeholder={S.roomFilterPlaceholder}
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.currentTarget.value })}
      />

      <div className="filter-section">
        <span className="chip-label">{S.groupBySection}</span>
        <div className="chips">
          {(["none", "mode"] as RoomGroupBy[]).map((g) => (
            <FilterChip
              key={g}
              label={groupByLabel(S, g)}
              selected={filter.groupBy === g}
              onClick={() => onChange({ ...filter, groupBy: g })}
            />
          ))}
        </div>
      </div>

      {archivedCount > 0 && (
        <div className="filter-section">
          <FilterChip
            label={S.archivedChipFmt.replace("%s", String(archivedCount))}
            selected={filter.showArchived}
            onClick={() => onChange({ ...filter, showArchived: !filter.showArchived })}
          />
        </div>
      )}

      {modes.length > 0 && (
        <div className="filter-section">
          <span className="chip-label">{S.modeSection}</span>
          <div className="chips">
            {modes.map((m) => (
              <FilterChip
                key={m}
                label={modeLabel(S, m)}
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
            {S.resetLabel}
          </button>
        </div>
      )}
    </div>
  );
}
