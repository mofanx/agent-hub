import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { useHubStore } from "../hub/store";
import type { ChatItem, FlowInfo, FlowTask } from "../hub/types";

const safeRenderer = {
  html(text: string) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};

marked.use({ renderer: safeRenderer as Record<string, unknown> });

export function ChatScreen() {
  const store = useHubStore();
  const [input, setInput] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [showThought, setShowThought] = useState<Record<number, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isRoom = !!store.currentRoom;
  const title = store.currentRoom?.name || store.currentSession?.name || "聊天";
  const subtitle = store.currentRoom
    ? store.currentRoom.members.map((m) => `@${m[1]}`).join("  ")
    : store.currentSession
      ? store.displayName(store.currentSession)
      : "";

  useEffect(() => {
    store.refreshBusy();
  }, [store.currentRoom?.roomId, store.currentSession?.sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [store.chatItems.length, store.chatItems[store.chatItems.length - 1]?.kind]);

  const mention = useMemo(() => {
    const at = input.lastIndexOf("@");
    if (at < 0 || !store.currentRoom) return null;
    const q = input.slice(at + 1).split(/\s/)[0];
    if (!q) return null;
    const matches = store.currentRoom.members.filter((m) =>
      m[1].toLowerCase().startsWith(q.toLowerCase()),
    );
    return matches.length ? { at, matches } : null;
  }, [input, store.currentRoom]);

  const slash = useMemo(() => {
    if (!input.startsWith("/") || /\s/.test(input)) return null;
    const q = input.slice(1).toLowerCase();
    return store.slashCommands.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [input, store.slashCommands]);

  const insertMention = (name: string) => {
    if (!mention) return;
    const before = input.slice(0, mention.at);
    setInput(`${before}@${name} `);
    inputRef.current?.focus();
  };

  const insertSlash = (name: string) => {
    setInput(`/${name} `);
    inputRef.current?.focus();
  };

  const insertCommand = (text: string) => {
    setInput(text);
    setCmdOpen(false);
    inputRef.current?.focus();
  };

  const send = () => {
    const text = input.trim();
    if (!text) return;
    if (isRoom) store.sendRoomMessage(text);
    else store.sendPrompt(text);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") {
      setCmdOpen(false);
    }
  };

  return (
    <div className="chat-screen">
      <div className="chat-header">
        <button className="secondary" onClick={store.backToList}>
          返回
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="chat-title">{title}</div>
          {subtitle && <div className="chat-subtitle">{subtitle}</div>}
        </div>
        {store.isGenerating() && (
          <button className="danger" onClick={store.stopCurrent}>
            停止
          </button>
        )}
      </div>

      {isRoom && store.currentRoom && ["conductor", "parallel", "pipeline", "debate", "auto"].includes(store.currentRoom.mode) && (
        <FlowPanel flow={store.flow} roomMode={store.currentRoom.mode} />
      )}

      <div className="chat-messages">
        {store.chatItems.map((item, i) => (
          <ChatMessage
            key={i}
            item={item}
            showAuthor={isRoom}
            expanded={showThought[i] ?? false}
            onToggleThought={() =>
              setShowThought({ ...showThought, [i]: !showThought[i] })
            }
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {store.quote && (
        <div className="quote-bar">
          <span className="subtitle">
            引用 @{store.quote[0]}: {store.quote[1].slice(0, 80)}
          </span>
          <button className="secondary" onClick={() => store.setQuote(null)}>
            取消
          </button>
        </div>
      )}

      {store.isGenerating() && (
        <div className="generating-bar">
          <span>执行中…</span>
          <button className="danger" onClick={store.stopCurrent}>
            停止
          </button>
        </div>
      )}

      <div className="compose">
        <div className="compose-row">
          <div className="cmd-wrap">
            <button
              className="secondary"
              onClick={() => setCmdOpen(!cmdOpen)}
              title="快捷指令"
            >
              ⚡
            </button>
            {cmdOpen && (
              <div className="dropdown-menu">
                {store.defaultCommands.map((c) => (
                  <div key={c} className="dropdown-item" onClick={() => insertCommand(c)}>
                    {c}
                  </div>
                ))}
                {store.customCommands.map((c) => (
                  <div key={c} className="dropdown-item with-del">
                    <span onClick={() => insertCommand(c)}>{c}</span>
                    <button
                      className="danger tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        store.removeCommand(c);
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <div
                  className="dropdown-item"
                  onClick={() => {
                    if (input.trim()) {
                      store.addCommand(input.trim());
                      setCmdOpen(false);
                    }
                  }}
                >
                  ＋ 保存当前输入为指令
                </div>
              </div>
            )}
          </div>

          <div className="input-wrap">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder={isRoom ? "群聊消息，@名字 指定成员" : "给 AI 下指令…"}
              rows={2}
            />

            {mention && (
              <div className="suggest-popup">
                {mention.matches.map(([sid, name]) => (
                  <div key={sid} className="suggest-item" onClick={() => insertMention(name)}>
                    @{store.sessionName(sid)}
                  </div>
                ))}
              </div>
            )}

            {slash && slash.length > 0 && (
              <div className="suggest-popup">
                {slash.map((c) => (
                  <div key={c.name} className="suggest-item" onClick={() => insertSlash(c.name)}>
                    /{c.name} — {c.description}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={send} disabled={!input.trim() || store.isGenerating()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({
  item,
  showAuthor,
  expanded,
  onToggleThought,
}: {
  item: ChatItem;
  showAuthor: boolean;
  expanded: boolean;
  onToggleThought: () => void;
}) {
  const store = useHubStore();
  const setQuote = () => {
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "thought") {
      store.setQuote([item.author || "我", item.text]);
    }
  };

  switch (item.kind) {
    case "system":
      return (
        <div className="message system">
          <div className="text">{item.text}</div>
        </div>
      );

    case "user":
      return (
        <div className="message user">
          <div className="text">
            {item.quoteAuthor && (
              <div className="quote-preview">
                引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
              </div>
            )}
            {item.text}
          </div>
          <button className="msg-action" onClick={setQuote}>
            引用
          </button>
        </div>
      );

    case "assistant":
      return (
        <div className="message assistant">
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
          <button className="msg-action" onClick={setQuote}>
            引用
          </button>
        </div>
      );

    case "thought":
      return (
        <div className="message thought">
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <button className="thought-toggle" onClick={onToggleThought}>
            {expanded ? "▾ " : "▸ "}思考过程
          </button>
          {expanded && (
            <div className="text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
          )}
        </div>
      );

    case "tool":
      return (
        <div className="message tool">
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="tool-row">
            <span>🔧 {item.title}</span>
            <span className="subtitle">{item.status}</span>
          </div>
        </div>
      );

    case "plan":
      return (
        <div className="message plan">
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="text" style={{ fontWeight: 600 }}>计划</div>
          {item.entries.map((e, i) => (
            <div key={i} className="text">
              {e}
            </div>
          ))}
        </div>
      );

    case "error":
      return (
        <div className="message error">
          <div className="text">
            {item.author ? `[${item.author}] ` : ""}错误: {item.text}
          </div>
        </div>
      );

    case "permission":
      return (
        <div className="message permission">
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="text">
            审批请求: {item.title}
            {item.answered ? (
              <div className="subtitle">已选择: {item.answered}</div>
            ) : (
              <div className="permission-actions">
                {item.options.map(([id, name]) => (
                  <button
                    key={id}
                    onClick={() => store.answerPermission(item.requestId, id, name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      );

    default:
      return null;
  }
}

function FlowPanel({ flow, roomMode }: { flow: FlowInfo | null; roomMode: string }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("flowPanelCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("flowPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  if (!flow) return null;
  const { progress, tasks } = flow;
  if (tasks.length === 0) return null;
  const title = roomMode === "conductor" ? "指挥编排" : "编排进度";
  return (
    <div className="flow-panel">
      <div className="flow-header" onClick={() => setCollapsed(!collapsed)} title="点击折叠/展开">
        <span className="flow-title">
          {collapsed ? "▸ " : "▾ "}{title}
        </span>
        <span className="flow-progress">
          {progress.done}/{progress.total} 完成 · {progress.running} 进行中 · {progress.pending} 待执行
        </span>
      </div>
      {!collapsed && (
        <div className="flow-tasks">
          {tasks.map((t) => (
            <FlowTaskItem key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { gfm: true }) as string;
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
  }
}

function FlowTaskItem({ task }: { task: FlowTask }) {
  const statusIcon = task.status === "done" ? "✓" : task.status === "running" ? "▶" : "○";
  return (
    <div className={`flow-task flow-task-${task.status}`}>
      <span className={`flow-task-status flow-status-${task.status}`}>{statusIcon}</span>
      <div className="flow-task-body">
        <div className="flow-task-line">
          <span className="flow-task-name">@{task.name}</span>
          <span className="flow-task-desc" title={task.task}>{task.task}</span>
        </div>
        {task.artifacts.length > 0 && (
          <div className="flow-artifacts">
            {task.artifacts.map((a, i) => (
              <span key={i} className="flow-artifact">
                [{a.type}] {a.path ? `${a.path} · ` : ""}{a.summary.slice(0, 80)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
