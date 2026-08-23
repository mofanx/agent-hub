import { useMemo, useState } from "react";
import { ArrowRight, Bot, Plus, Users } from "lucide-react";
import { useHubStore } from "../hub/store";
import { MODE_LABELS, truncatePath } from "./session-shared";
import { SessionDialog } from "./dialogs/SessionDialog";
import { RoomDialog } from "./dialogs/RoomDialog";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function HomeScreen() {
  const store = useHubStore();
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

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <img src="/logo.svg" alt="Agent Hub" />
          <h1>{greeting()}</h1>
          <p>
            {store.currentProfile ? `已连接到 ${store.currentProfile.name} · ${store.agentStatus}` : "选择一个会话开始工作，或创建新的协作"}
          </p>
        </div>

        <div className="home-actions">
          <button className="home-action" onClick={() => setDialog("session")}>
            <span className="action-icon">
              <Plus size={16} />
            </span>
            <span>
              <span className="action-title">新建会话</span>
              <div className="action-desc">与单个 Agent 开始一对一任务</div>
            </span>
          </button>
          <button className="home-action" onClick={() => setDialog("room")}>
            <span className="action-icon">
              <Users size={16} />
            </span>
            <span>
              <span className="action-title">新建群聊</span>
              <div className="action-desc">多个 Agent 协作：指挥家 / 辩论 / 流水线…</div>
            </span>
          </button>
          <button className="home-action" onClick={() => useHubStore.setState({ screen: "settings" })}>
            <span className="action-icon">
              <Bot size={16} />
            </span>
            <span>
              <span className="action-title">Agent 来源</span>
              <div className="action-desc">管理本地与远程 Agent 连接</div>
            </span>
          </button>
          <button className="home-action" onClick={() => void store.refreshAll()}>
            <span className="action-icon">
              <ArrowRight size={16} />
            </span>
            <span>
              <span className="action-title">刷新状态</span>
              <div className="action-desc">同步会话、群聊与 Agent 最新状态</div>
            </span>
          </button>
        </div>

        {(recentSessions.length > 0 || recentRooms.length > 0) && (
          <>
            <div className="home-section-title">最近会话</div>
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
                      {MODE_LABELS[r.mode] ?? r.mode} · {r.members.map((m) => m[1]).join("、")}
                    </span>
                  </div>
                  <ArrowRight size={13} style={{ color: "var(--muted)" }} />
                </div>
              ))}
            </div>
          </>
        )}

        <div className="home-kbd-row">
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>K</kbd> 搜索
          </span>
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>N</kbd> 新建会话
          </span>
          <span className="kbd-item">
            <kbd>Ctrl</kbd>+<kbd>F</kbd> 聊天内搜索
          </span>
          <span className="kbd-item">
            <kbd>Esc</kbd> 返回首页
          </span>
        </div>
      </div>

      {dialog === "session" && <SessionDialog onClose={() => setDialog(null)} />}
      {dialog === "room" && <RoomDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
