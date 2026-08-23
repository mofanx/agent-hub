import { useMemo, type ReactNode } from "react";
import { useHubStore } from "../hub/store";
import type { SearchGroup, SessionInfo } from "../hub/types";

export type SessionStatus = "online" | "offline" | "busy" | "pinned" | "archived";
export type SessionGroupBy = "none" | "agent" | "cwd";
export type RoomGroupBy = "none" | "mode";

export interface SessionListFilter {
  query: string;
  agents: Set<string>;
  cwds: Set<string>;
  statuses: Set<SessionStatus>;
  groupBy: SessionGroupBy;
}

export interface RoomListFilter {
  query: string;
  modes: Set<string>;
  groupBy: RoomGroupBy;
  showArchived: boolean;
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  online: "在线",
  offline: "离线",
  busy: "忙碌",
  pinned: "置顶",
  archived: "归档",
};

export const GROUP_BY_LABELS: Record<SessionGroupBy | RoomGroupBy, string> = {
  none: "不分组",
  agent: "按 Agent",
  cwd: "按目录",
  mode: "按模式",
};

export const MODE_LABELS: Record<string, string> = {
  mention: "普通群",
  conductor: "指挥家",
  roundrobin: "轮询",
  parallel: "并行",
  pipeline: "流水线",
  debate: "辩论",
  auto: "自动",
};

export function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const tail = path.slice(-(maxLen - 3));
  const idx = tail.indexOf("/");
  return idx > 0 ? `...${tail.slice(idx)}` : `...${tail}`;
}

export function toggleSet<T extends string>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function sessionStatuses(s: SessionInfo, pinnedIds: string[]): SessionStatus[] {
  const st: SessionStatus[] = [];
  if (s.archived) st.push("archived");
  if (s.offline) st.push("offline");
  else if (s.busy) st.push("busy");
  else if (!s.archived) st.push("online");
  if (pinnedIds.includes(s.sessionId)) st.push("pinned");
  return st;
}

export function isSessionStatus(s: string): s is SessionStatus {
  return ["online", "offline", "busy", "pinned", "archived"].includes(s);
}

export interface ActiveChip {
  kind: "session" | "room";
  key: string;
  label: string;
}

export function buildActiveSessionChips(filter: SessionListFilter, agents: string[], cwds: string[]): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filter.query.trim()) chips.push({ kind: "session", key: "query", label: `搜索: ${filter.query.trim()}` });
  if (filter.groupBy !== "none") chips.push({ kind: "session", key: "groupBy", label: `分组: ${GROUP_BY_LABELS[filter.groupBy]}` });
  for (const a of agents) if (filter.agents.has(a)) chips.push({ kind: "session", key: a, label: a });
  for (const c of cwds) if (filter.cwds.has(c)) chips.push({ kind: "session", key: c, label: truncatePath(c) });
  for (const st of Array.from(filter.statuses)) chips.push({ kind: "session", key: st, label: SESSION_STATUS_LABELS[st] });
  return chips;
}

export function buildActiveRoomChips(filter: RoomListFilter, modes: string[], archivedCount: number): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filter.query.trim()) chips.push({ kind: "room", key: "query", label: `搜索: ${filter.query.trim()}` });
  if (filter.groupBy !== "none") chips.push({ kind: "room", key: "groupBy", label: `分组: ${GROUP_BY_LABELS[filter.groupBy]}` });
  if (filter.showArchived && archivedCount > 0) chips.push({ kind: "room", key: "showArchived", label: `归档 (${archivedCount})` });
  for (const m of modes) if (filter.modes.has(m)) chips.push({ kind: "room", key: m, label: MODE_LABELS[m] ?? m });
  return chips;
}

export function highlightText(text: string, q: string): React.ReactNode {
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

export function FilterChip({
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

export function SearchGroupCard({ group, query }: { group: SearchGroup; query: string }) {
  const store = useHubStore();
  const q = query.trim().toLowerCase();
  const name = useMemo(() => {
    if (group.scope === "room") {
      return store.rooms.find((r) => r.roomId === group.scopeId)?.name ?? group.scopeId;
    }
    return store.sessions.find((s) => s.sessionId === group.scopeId)?.name ?? group.scopeId;
  }, [group, store.sessions, store.rooms]);
  return (
    <div className="search-group-card">
      <div className="search-group-title">{name} · 共 {group.count} 条</div>
      {group.previews.map((hit, i) => (
        <div key={i} className="search-preview" onClick={() => store.openSearchHit(hit)}>
          <span className="search-author">{hit.author || "系统"} · </span>
          {highlightText((hit.text || "").slice(0, 120), q)}
        </div>
      ))}
    </div>
  );
}
