import { useMemo, useState } from "react";
import { Archive, ArrowRight, Bot, Plus, Users } from "lucide-react";
import { useHubStore } from "../hub/store";
import { stringsFor, type Strings } from "../hub/strings";
import { modeLabel, truncatePath } from "./session-shared";
import { SessionDialog } from "./dialogs/SessionDialog";
import { RoomDialog } from "./dialogs/RoomDialog";
import { MissionPanel } from "./MissionPanel";

function greeting(S: Strings): string {
  const h = new Date().getHours();
  if (h < 5) return S.greetingLate;
  if (h < 12) return S.greetingMorning;
  if (h < 18) return S.greetingAfternoon;
  return S.greetingEvening;
}

export function HomeScreen() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [dialog, setDialog] = useState<"session" | "room" | null>(null);

  const recentSessions = useMemo(
    () =>
      store.sessions
        .filter((s) => !s.archived)
        .sort((a, b) => {
          const pa = store.pinnedIds.includes(a.sessionId) ? 1 : 0;
          const pb = store.pinnedIds.includes(b.sessionId) ? 1 : 0;
          if (pa !== pb) return pb - pa;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 4),
    [store.sessions, store.pinnedIds],
  );
  const recentRooms = useMemo(() => store.rooms.filter((r) => !r.archived).slice(0, 2), [store.rooms]);
  const archivedItems = useMemo(
    () => [
      ...store.sessions.filter((s) => s.archived).map((s) => ({ kind: "session" as const, s })),
      ...store.rooms.filter((r) => r.archived).map((r) => ({ kind: "room" as const, r })),
    ],
    [store.sessions, store.rooms],
  );
  const [showArchived, setShowArchived] = useState(false);

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <img src="/logo.svg" alt="Agent Hub" />
          <h1>{greeting(S)}</h1>
          <p>
            {store.currentProfile
              ? S.connectedToFmt.replace("%s", store.currentProfile.name).replace("%s", store.agentStatus)
              : S.homePickHint}
          </p>
        </div>

        <div className="home-actions">
          <button className="home-action" onClick={() => setDialog("session")}>
            <span className="action-icon">
              <Plus size={16} />
            </span>
            <span>
              <span className="action-title">{S.newSessionTitle}</span>
              <div className="action-desc">{S.newSessionDesc}</div>
            </span>
          </button>
          <button className="home-action" onClick={() => setDialog("room")}>
            <span className="action-icon">
              <Users size={16} />
            </span>
            <span>
              <span className="action-title">{S.newRoomTitle}</span>
              <div className="action-desc">{S.newRoomDesc}</div>
            </span>
          </button>
          <button className="home-action" onClick={() => useHubStore.setState({ screen: "settings" })}>
            <span className="action-icon">
              <Bot size={16} />
            </span>
            <span>
              <span className="action-title">{S.agentSources}</span>
              <div className="action-desc">{S.agentSourcesDesc}</div>
            </span>
          </button>
          <button className="home-action" onClick={() => void store.refreshAll()}>
            <span className="action-icon">
              <ArrowRight size={16} />
            </span>
            <span>
              <span className="action-title">{S.refreshStatus}</span>
              <div className="action-desc">{S.refreshStatusDesc}</div>
            </span>
          </button>
        </div>

        {(recentSessions.length > 0 || recentRooms.length > 0) && (
          <>
            <div className="home-section-title">{S.recentSessions}</div>
            <div className="home-recent">
              {recentSessions.map((s) => (
                <div key={s.sessionId} className="home-recent-item" onClick={() => store.openChat(s)}>
                  <span
                    className="dot"
                    style={{ background: s.busy ? "var(--warn)" : s.offline ? "var(--muted)" : "var(--success)" }}
                  />
                  <div className="nav-text">
                    <span className="nav-title">{store.displayName(s)}</span>
                    <span className="nav-sub">
                      {truncatePath(s.cwd, 40)} · {s.agent}
                    </span>
                  </div>
                  <ArrowRight size={13} style={{ color: "var(--muted)" }} />
                </div>
              ))}
              {recentRooms.map((r) => (
                <div key={r.roomId} className="home-recent-item" onClick={() => store.openRoom(r)}>
                  <Users size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                  <div className="nav-text">
                    <span className="nav-title">{r.name}</span>
                    <span className="nav-sub">
                      {modeLabel(S, r.mode)} · {r.members.map((m) => m[1]).join("、")}
                    </span>
                  </div>
                  <ArrowRight size={13} style={{ color: "var(--muted)" }} />
                </div>
              ))}
            </div>
          </>
        )}

        <MissionPanel onCreateRoom={() => setDialog("room")} />

        {archivedItems.length > 0 && (
          <>
            <button
              className="home-section-title archived-toggle"
              onClick={() => setShowArchived(!showArchived)}
            >
              {S.archivedGroupFmt.replace("%s", String(archivedItems.length))}
            </button>
            {showArchived && (
              <div className="home-recent archived">
                {archivedItems.map((it) =>
                  it.kind === "session" ? (
                    <div
                      key={it.s.sessionId}
                      className="home-recent-item archived"
                      onClick={() => store.openChat(it.s)}
                    >
                      <div className="nav-text">
                        <span className="nav-title">{store.displayName(it.s)}</span>
                        <span className="nav-sub">
                          {truncatePath(it.s.cwd, 40)} · {it.s.agent}
                        </span>
                      </div>
                      <button
                        className="icon-btn"
                        title={S.unarchiveTitle}
                        onClick={(e) => {
                          e.stopPropagation();
                          void store.archiveSession(it.s, false);
                        }}
                      >
                        <Archive size={13} />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={it.r.roomId}
                      className="home-recent-item archived"
                      onClick={() => store.openRoom(it.r)}
                    >
                      <Users size={13} style={{ color: "var(--muted)", flexShrink: 0 }} />
                      <div className="nav-text">
                        <span className="nav-title">{it.r.name}</span>
                        <span className="nav-sub">{modeLabel(S, it.r.mode)}</span>
                      </div>
                      <button
                        className="icon-btn"
                        title={S.unarchiveTitle}
                        onClick={(e) => {
                          e.stopPropagation();
                          void store.archiveRoom(it.r, false);
                        }}
                      >
                        <Archive size={13} />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
          </>
        )}

        <div className="home-kbd-row">
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>K</kbd> {S.shortcutSearch}
          </span>
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>N</kbd> {S.shortcutNewSession}
          </span>
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>F</kbd> {S.shortcutChatSearch}
          </span>
          <span className="kbd-item">
            <kbd>Esc</kbd> {S.shortcutBackHome}
          </span>
        </div>
      </div>

      {dialog === "session" && <SessionDialog onClose={() => setDialog(null)} />}
      {dialog === "room" && <RoomDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
