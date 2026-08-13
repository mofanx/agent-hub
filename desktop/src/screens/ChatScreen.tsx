import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import { useHubStore } from "../hub/store";
import { stringsFor } from "../hub/strings";
import type { ArtifactInfo, ChatItem, FlowArtifact, FlowInfo, FlowTask, TokenUsage, ContextUsage } from "../hub/types";

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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTokenUsage(u: TokenUsage): string {
  const parts = [`输入 ${formatNumber(u.inputTokens)} · 输出 ${formatNumber(u.outputTokens)}`];
  if (u.cachedReadTokens) parts.push(`缓存 ${formatNumber(u.cachedReadTokens)}`);
  if (u.cachedWriteTokens) parts.push(`写缓存 ${formatNumber(u.cachedWriteTokens)}`);
  if (u.thoughtTokens) parts.push(`思考 ${formatNumber(u.thoughtTokens)}`);
  parts.push(`总计 ${formatNumber(u.totalTokens)}`);
  return parts.join(" · ");
}

function formatContextUsage(u: ContextUsage): string {
  const parts = [`上下文 ${formatNumber(u.used)} / ${formatNumber(u.size)}`];
  if (u.costAmount != null && u.costCurrency) {
    parts.push(`${u.costCurrency} ${u.costAmount.toFixed(4)}`);
  }
  return parts.join(" · ");
}

function costTierClass(tier: string): string {
  if (tier === "Free") return "tier-free";
  if (tier === "Low cost") return "tier-low";
  if (tier === "Med cost") return "tier-med";
  if (tier === "High cost") return "tier-high";
  return "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const q = escapeRegExp(query);
  const re = new RegExp(`(${q})`, "gi");
  const parts = text.split(re);
  const ql = query.toLowerCase();
  return parts.map((part, i) =>
    i % 2 === 1 && part.toLowerCase() === ql ? (
      <span key={i} className="search-highlight">{part}</span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function highlightHtml(html: string, query: string): string {
  if (!query) return html;
  const q = escapeRegExp(query);
  const re = new RegExp(`(${q})`, "gi");
  const tagRe = /<[^>]+>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    out += html.slice(last, m.index).replace(re, '<mark class="search-highlight">$&</mark>');
    out += m[0];
    last = tagRe.lastIndex;
  }
  out += html.slice(last).replace(re, '<mark class="search-highlight">$&</mark>');
  return out;
}

export function ChatScreen() {
  const store = useHubStore();
  const [input, setInput] = useState("");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [showThought, setShowThought] = useState<Record<number, boolean>>({});
  const [inChatSearchQuery, setInChatSearchQuery] = useState("");
  const [chatSearchMatchIndex, setChatSearchMatchIndex] = useState(-1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [suggestOpen, setSuggestOpen] = useState(true);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [lightbox, setLightbox] = useState<{ src: string; name?: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const isRoom = !!store.currentRoom;
  const title = store.currentRoom?.name || store.currentSession?.name || "聊天";
  const modeLabel = store.currentRoom
    ? { mention: "普通群", conductor: "指挥家", roundrobin: "轮询", parallel: "并行", pipeline: "流水线", debate: "辩论", auto: "自动" }[store.currentRoom.mode]
    : undefined;
  const subtitle = store.currentRoom
    ? `${modeLabel ?? store.currentRoom.mode} · ${store.currentRoom.members.map((m) => `@${m[1]}`).join("  ")}`
    : store.currentSession
      ? store.displayName(store.currentSession)
      : "";
  const activeSessionId = store.currentRoom?.activeSpeaker || store.currentSession?.sessionId || "";
  const contextUsage = activeSessionId ? store.sessionUsage[activeSessionId] : undefined;

  const searchQuery = inChatSearchQuery.trim();
  const matchPositions = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    return store.chatItems
      .map((item, i) => (getItemText(item).toLowerCase().includes(q) ? i : -1))
      .filter((i) => i >= 0);
  }, [searchQuery, store.chatItems]);
  const chatSearchMatchCount = matchPositions.length;
  const currentMatchIndex = chatSearchMatchIndex >= 0 ? matchPositions[chatSearchMatchIndex] : -1;

  const nextMatch = () =>
    setChatSearchMatchIndex((prev) =>
      matchPositions.length > 0 ? (prev + 1) % matchPositions.length : -1
    );
  const prevMatch = () =>
    setChatSearchMatchIndex((prev) =>
      matchPositions.length > 0 ? (prev - 1 + matchPositions.length) % matchPositions.length : -1
    );

  useEffect(() => {
    setChatSearchMatchIndex((prev) => {
      if (matchPositions.length === 0) return -1;
      if (prev < 0 || prev >= matchPositions.length) return 0;
      return prev;
    });
  }, [matchPositions]);

  useEffect(() => {
    store.refreshBusy();
  }, [store.currentRoom?.roomId, store.currentSession?.sessionId]);

  useEffect(() => {
    if (inChatSearchQuery || !isAtBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [store.chatItems.length, store.chatItems[store.chatItems.length - 1]?.kind, inChatSearchQuery, isAtBottom]);

  useEffect(() => {
    if (chatSearchMatchIndex < 0) return;
    const el = document.querySelector(".chat-messages .message.current-match");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [chatSearchMatchIndex, matchPositions, inChatSearchQuery]);

  useEffect(() => {
    if (store.jumpToAt == null || store.chatItems.length === 0) return;
    const idx = store.chatItems.findIndex((item) => item.at === store.jumpToAt);
    if (idx < 0) return;
    const q = store.jumpQuery.trim().toLowerCase();
    if (q) {
      const positions = store.chatItems
        .map((item, i) => (getItemText(item).toLowerCase().includes(q) ? i : -1))
        .filter((i) => i >= 0);
      setInChatSearchQuery(store.jumpQuery);
      setChatSearchMatchIndex(positions.indexOf(idx));
      setSearchOpen(true);
    }
    const container = messagesRef.current;
    if (!container) return;
    const offset = store.historyLoading ? 1 : 0;
    const el = container.children[idx + offset];
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    store.clearJumpToAt();
  }, [store.jumpToAt, store.chatItems.length, store.historyLoading]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (searchOpen) {
          e.preventDefault();
          setSearchOpen(false);
          setInChatSearchQuery("");
          setChatSearchMatchIndex(-1);
        } else if (suggestOpen) {
          e.preventDefault();
          setSuggestOpen(false);
        } else if (cmdOpen) {
          e.preventDefault();
          setCmdOpen(false);
        } else {
          e.preventDefault();
          store.backToList();
        }
      }
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [searchOpen, suggestOpen, cmdOpen, store]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    setIsAtBottom(true);
  };

  const onMessagesScroll = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const el = messagesRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop <= 60;
        setIsAtBottom(atBottom);
        if (!store.historyHasMore || store.historyLoading) return;
        if (el.scrollTop <= 40) {
          const method = store.currentRoom ? "room.history" : "session.history";
          const idKey = store.currentRoom ? "roomId" : "sessionId";
          const id = store.currentRoom?.roomId ?? store.currentSession?.sessionId;
          if (id) store.loadMoreHistory(method, idKey, id);
        }
      }, 200);
    };
  }, [store.historyHasMore, store.historyLoading, store.currentRoom, store.currentSession]);

  const mention = useMemo(() => {
    const at = input.lastIndexOf("@");
    if (at < 0 || !store.currentRoom) return null;
    const q = input.slice(at + 1).split(/\s/)[0];
    if (!q) return null;
    const members = store.currentRoom.members.filter((m) =>
      m[1].toLowerCase().startsWith(q.toLowerCase()),
    );
    if (members.length) return { at, kind: "member" as const, members };
    const artifacts = (store.currentArtifacts ?? []).filter((a) =>
      a.id.toLowerCase().startsWith(q.toLowerCase()) ||
      (a.alias && a.alias.toLowerCase().startsWith(q.toLowerCase())) ||
      (a.path && a.path.toLowerCase().includes(q.toLowerCase())) ||
      a.summary.toLowerCase().includes(q.toLowerCase()),
    );
    return artifacts.length ? { at, kind: "artifact" as const, artifacts } : null;
  }, [input, store.currentRoom, store.currentArtifacts]);

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

  const insertArtifactMention = (artifact: ArtifactInfo) => {
    if (!mention || mention.kind !== "artifact") return;
    const before = input.slice(0, mention.at);
    setInput(`${before}@${artifact.alias ?? artifact.id} `);
    inputRef.current?.focus();
  };

  const insertSlash = (name: string) => {
    setInput(`/${name} `);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (mention || (slash && slash.length > 0)) {
      setSuggestOpen(true);
      setSuggestIndex(0);
    }
  }, [mention, slash]);

  const insertCommand = (text: string) => {
    setInput(text);
    setCmdOpen(false);
    inputRef.current?.focus();
  };

  const send = () => {
    const text = input.trim();
    if (!text && !store.pendingAttachments.length) return;
    if (isRoom) store.sendRoomMessage(text);
    else store.sendPrompt(text);
    setInput("");
  };

  const onPickImage = () => fileInputRef.current?.click();

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result ?? "").split(",")[1] ?? "";
        if (base64) store.addAttachment({ mimeType: f.type, base64, name: f.name });
      };
      reader.readAsDataURL(f);
    }
    e.target.value = "";
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const active = mention || (slash && slash.length > 0);
    if (active && suggestOpen) {
      const items = mention
        ? (mention.kind === "member" ? mention.members : mention.artifacts)
        : slash || [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (mention) {
          if (mention.kind === "member") {
            insertMention(mention.members[suggestIndex]?.[1] ?? mention.members[0][1]);
          } else {
            insertArtifactMention(mention.artifacts[suggestIndex] ?? mention.artifacts[0]);
          }
        } else if (slash) {
          insertSlash(slash[suggestIndex]?.name ?? slash[0].name);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestOpen(false);
        return;
      }
    }
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
        <button className="secondary icon" onClick={store.backToList}>
          ←
        </button>
        {!searchOpen ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="chat-title">{title}</div>
            {subtitle && <div className="chat-subtitle">{subtitle}</div>}
            {contextUsage && <div className="chat-usage">{formatContextUsage(contextUsage)}</div>}
          </div>
        ) : (
          <div className="chat-search-bar" style={{ flex: 1 }}>
            <input
              ref={searchInputRef}
              value={inChatSearchQuery}
              onChange={(e) => setInChatSearchQuery(e.currentTarget.value)}
              placeholder="搜索聊天内容…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  prevMatch();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  nextMatch();
                }
                if (e.key === "Escape") {
                  setSearchOpen(false);
                  setInChatSearchQuery("");
                  setChatSearchMatchIndex(-1);
                }
              }}
            />
            <span className="chat-search-count">
              {chatSearchMatchCount > 0 ? `${chatSearchMatchIndex + 1} / ${chatSearchMatchCount}` : "0"}
            </span>
            <button className="secondary" onClick={prevMatch} disabled={chatSearchMatchCount === 0} title="上一个 (Shift+Enter)">
              ▲
            </button>
            <button className="secondary" onClick={nextMatch} disabled={chatSearchMatchCount === 0} title="下一个 (Enter)">
              ▼
            </button>
            <button
              className="secondary"
              onClick={() => {
                setSearchOpen(false);
                setInChatSearchQuery("");
                setChatSearchMatchIndex(-1);
              }}
              title="关闭 (Esc)"
            >
              ✕
            </button>
          </div>
        )}
        {!searchOpen && (
          <button className="secondary" onClick={() => setSearchOpen(true)} title="搜索 (Ctrl+F)">
            搜索
          </button>
        )}
        <button className="secondary" onClick={() => void store.showModelPickerDialog()}>
          模型
        </button>
        {store.isGenerating() && (
          <button className="danger" onClick={store.stopCurrent}>
            停止
          </button>
        )}
      </div>

      {isRoom && store.currentRoom && ["conductor", "parallel", "pipeline", "debate", "auto"].includes(store.currentRoom.mode) && (
        <FlowPanel flow={store.flow} roomMode={store.currentRoom.mode} />
      )}

      {isRoom && store.currentArtifacts && store.currentArtifacts.length > 0 && (
        <ArtifactPanel artifacts={store.currentArtifacts} />
      )}

      <div ref={messagesRef} className="chat-messages" onScroll={onMessagesScroll}>
        {store.historyLoading && (
          <div className="history-loading">加载更多历史…</div>
        )}
        {store.chatItems.map((item, i) => {
          const isQuoted = store.quote
            ? store.quote[0] === (item.author || "我") &&
              "text" in item &&
              item.text.startsWith(store.quote[1])
            : false;
          return (
            <ChatMessage
              key={i}
              item={item}
              showAuthor={isRoom}
              expanded={showThought[i] ?? false}
              isQuoted={isQuoted}
              onToggleThought={() =>
                setShowThought({ ...showThought, [i]: !showThought[i] })
              }
              highlight={inChatSearchQuery}
              isCurrentMatch={currentMatchIndex === i}
              onImageClick={(src, name) => setLightbox({ src, name })}
            />
          );
        })}
        <div ref={bottomRef} />
        {!isAtBottom && (
          <button
            className="scroll-to-bottom"
            onClick={scrollToBottom}
            title="回到底部"
            type="button"
          >
            ↓
          </button>
        )}
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

      {contextUsage && (
        <div className="usage-bar">
          <span className="pill">{formatContextUsage(contextUsage)}</span>
        </div>
      )}

      <div className="compose">
        {store.pendingAttachments.length > 0 && (
          <div className="attachments-bar">
            {store.pendingAttachments.map((a, i) => (
              <span key={i} className="attachment-chip">
                <img
                    src={`data:${a.mimeType};base64,${a.base64}`}
                    alt=""
                    onClick={() => setLightbox({ src: `data:${a.mimeType};base64,${a.base64}`, name: a.name })}
                  />
                {a.name}
                <button className="tiny secondary" onClick={() => store.removeAttachment(a)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="compose-toolbar">
          <button className="secondary" onClick={() => setCmdOpen(!cmdOpen)} title="快捷指令">
            指令
          </button>
          <button className="secondary" onClick={onPickImage} title="添加图片">
            图片
          </button>
          <button className="secondary" onClick={() => store.showModelPickerDialog()} title="切换模型">
            模型 {store.modelCurrent}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>

        {cmdOpen && (
          <div className="dropdown-menu" style={{ position: "relative", bottom: "auto", top: "0.25rem" }}>
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

        <div className="compose-row">
          <div className="input-wrap">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder={isRoom ? "群聊消息，@名字 指定成员" : "给 AI 下指令…"}
            />

            {suggestOpen && mention && (
              <div className="suggest-popup">
                {mention.kind === "member"
                  ? mention.members.map(([sid, name], i) => (
                      <div
                        key={sid}
                        className={`suggest-item ${i === suggestIndex ? "active" : ""}`}
                        onClick={() => insertMention(name)}
                        onMouseEnter={() => setSuggestIndex(i)}
                      >
                        @{store.sessionName(sid)}
                      </div>
                    ))
                  : mention.artifacts.map((a, i) => (
                      <div
                        key={a.id}
                        className={`suggest-item ${i === suggestIndex ? "active" : ""}`}
                        onClick={() => insertArtifactMention(a)}
                        onMouseEnter={() => setSuggestIndex(i)}
                      >
                        {a.path ? `${a.path} · ` : ""}{a.summary.slice(0, 80)} · @{a.author}
                      </div>
                    ))}
              </div>
            )}

            {suggestOpen && slash && slash.length > 0 && (
              <div className="suggest-popup">
                {slash.map((c, i) => (
                  <div
                    key={c.name}
                    className={`suggest-item ${i === suggestIndex ? "active" : ""}`}
                    onClick={() => insertSlash(c.name)}
                    onMouseEnter={() => setSuggestIndex(i)}
                  >
                    /{c.name} — {c.description}
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={send} disabled={(!input.trim() && !store.pendingAttachments.length) || store.isGenerating()}>
            发送
          </button>
        </div>
      </div>

      {store.showModelPicker && <ModelPicker />}

      {lightbox && (
        <div className="image-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.name} onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function getItemText(item: ChatItem): string {
  if ("text" in item) return item.text;
  if (item.kind === "plan") return item.entries.join("\n");
  if (item.kind === "tool") return `[${item.title}] ${item.status}`;
  if (item.kind === "permission") return `审批请求: ${item.title}`;
  return "";
}

function ChatMessage({
  item,
  showAuthor,
  expanded,
  isQuoted,
  onToggleThought,
  highlight,
  isCurrentMatch,
  onImageClick,
}: {
  item: ChatItem;
  showAuthor: boolean;
  expanded: boolean;
  isQuoted: boolean;
  onToggleThought: () => void;
  highlight?: string;
  isCurrentMatch?: boolean;
  onImageClick?: (src: string, name?: string) => void;
}) {
  const store = useHubStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const currentMatchClass = isCurrentMatch ? "current-match" : "";

  const canQuote = item.kind === "user" || item.kind === "assistant" || item.kind === "thought";

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const doCopy = () => {
    navigator.clipboard.writeText(getItemText(item)).catch(() => {});
    setMenu(null);
  };

  const doSelect = () => {
    setSelectOpen(true);
    setMenu(null);
  };

  const doQuote = () => {
    if (canQuote) store.setQuote([item.author || "我", getItemText(item)]);
    setMenu(null);
  };

  const menuEl = menu ? (
    <div
      className="message-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="message-menu-item" onClick={doCopy}>
        复制
      </div>
      <div className="message-menu-item" onClick={doSelect}>
        选取
      </div>
      {canQuote && (
        <div className="message-menu-item" onClick={doQuote}>
          引用
        </div>
      )}
    </div>
  ) : null;

  const selectModal = selectOpen ? (
    <div className="dialog-backdrop" onClick={() => setSelectOpen(false)}>
      <div className="dialog selection-modal" onClick={(e) => e.stopPropagation()}>
        <h4>选取文字</h4>
        <pre>{getItemText(item)}</pre>
        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => setSelectOpen(false)}>关闭</button>
        </div>
      </div>
    </div>
  ) : null;

  const usageText =
    item.kind === "assistant" && item.usage ? (
      <div className="usage-bar" style={{ padding: 0 }}>
        <span className="pill">{formatTokenUsage(item.usage)}</span>
      </div>
    ) : null;

  const attachmentsEl =
    item.kind === "user" && item.attachments?.length ? (
      <div className="message-attachments">
        {item.attachments.map((a, i) => (
          <img
            key={i}
            className="message-image"
            src={`data:${a.mimeType};base64,${a.base64}`}
            alt={a.name}
            onClick={() => onImageClick?.(`data:${a.mimeType};base64,${a.base64}`, a.name)}
          />
        ))}
      </div>
    ) : null;

  switch (item.kind) {
    case "system":
      return (
        <div className={`message system ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="text">{highlight ? highlightText(item.text, highlight) : item.text}</div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "user":
      return (
        <div className={`message user ${isQuoted ? "quoted" : ""} ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="text">
            {item.quoteAuthor && (
              <div className="quote-preview">
                引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
              </div>
            )}
            {highlight ? highlightText(item.text, highlight) : item.text}
          </div>
          {attachmentsEl}
          {menuEl}
          {selectModal}
        </div>
      );

    case "assistant":
      return (
        <div className={`message assistant ${isQuoted ? "quoted" : ""} ${currentMatchClass}`} onContextMenu={onContextMenu}>
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          {item.quoteAuthor && (
            <div className="quote-preview">
              引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
            </div>
          )}
          <div
            className="text"
            dangerouslySetInnerHTML={{ __html: highlight ? highlightHtml(renderMarkdown(item.text), highlight) : renderMarkdown(item.text) }}
          />
          {usageText}
          {menuEl}
          {selectModal}
        </div>
      );

    case "thought":
      return (
        <div className={`message thought ${isQuoted ? "quoted" : ""} ${currentMatchClass}`} onContextMenu={onContextMenu}>
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          {item.quoteAuthor && (
            <div className="quote-preview">
              引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
            </div>
          )}
          <button className="thought-toggle" onClick={onToggleThought}>
            {expanded ? "▾ " : "▸ "}思考过程
          </button>
          {expanded && (
            <div
              className="text"
              dangerouslySetInnerHTML={{ __html: highlight ? highlightHtml(renderMarkdown(item.text), highlight) : renderMarkdown(item.text) }}
            />
          )}
          {menuEl}
          {selectModal}
        </div>
      );

    case "tool":
      return (
        <div className={`message tool ${currentMatchClass}`} onContextMenu={onContextMenu}>
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="tool-row">
            <span>{highlight ? highlightText(`🔧 ${item.title}`, highlight) : `🔧 ${item.title}`}</span>
            <span className="subtitle">{item.status}</span>
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "plan":
      return (
        <div className={`message plan ${currentMatchClass}`} onContextMenu={onContextMenu}>
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="text" style={{ fontWeight: 600 }}>计划</div>
          {item.entries.map((e, i) => (
            <div key={i} className="text">
              {highlight ? highlightText(e, highlight) : e}
            </div>
          ))}
          {menuEl}
          {selectModal}
        </div>
      );

    case "error":
      return (
        <div className={`message error ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="text">
            {item.author ? `[${item.author}] ` : ""}错误: {highlight ? highlightText(item.text, highlight) : item.text}
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "permission":
      return (
        <div className={`message permission ${currentMatchClass}`} onContextMenu={onContextMenu}>
          {showAuthor && item.author && <div className="author">{item.author}</div>}
          <div className="text">
            审批请求: {highlight ? highlightText(item.title, highlight) : item.title}
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
          {menuEl}
          {selectModal}
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
          {progress.failed > 0 ? ` · ${progress.failed} 失败` : ""}
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

function ArtifactPanel({ artifacts }: { artifacts: ArtifactInfo[] }) {
  const store = useHubStore();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("artifactPanelCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("artifactPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  const groups = useMemo(() => {
    const g: Record<string, ArtifactInfo[]> = {};
    for (const a of artifacts) {
      (g[a.kind] ??= []).push(a);
    }
    return g;
  }, [artifacts]);
  return (
    <div className="artifact-panel">
      <div className="artifact-header" onClick={() => setCollapsed(!collapsed)} title="点击折叠/展开">
        <span className="artifact-title">{collapsed ? "▸ " : "▾ "}作品/结果</span>
        <span className="artifact-count">{artifacts.length} 条</span>
      </div>
      {!collapsed && (
        <div className="artifact-list">
          {Object.entries(groups).map(([kind, list]) => (
            <div key={kind} className="artifact-group">
              <div className="artifact-group-title">{kindLabel(kind)}</div>
              {list.map((a) => (
                <button
                  key={a.id}
                  className="artifact-item"
                  onClick={() => store.sendArtifactMessage(a)}
                  title={a.path ? `${a.path}\n${a.summary}` : a.summary}
                >
                  <span className="artifact-author">@{a.author}</span>
                  <span className="artifact-summary">{a.path ? `${a.path} · ` : ""}{a.summary}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function kindLabel(kind: string): string {
  if (kind === "file") return "文件";
  if (kind === "command") return "命令";
  if (kind === "test") return "测试";
  return "笔记";
}

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { gfm: true }) as string;
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
  }
}

function FlowTaskItem({ task }: { task: FlowTask }) {
  const statusIcon =
    task.status === "done" ? "✓" : task.status === "running" ? "▶" : task.status === "failed" ? "✗" : "○";
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
              <button
                key={i}
                className="flow-artifact"
                onClick={() => copyArtifact(a)}
                title={a.path ? `点击复制路径：${a.path}` : "点击复制摘要"}
              >
                [{a.type}] {a.path ? `${a.path} · ` : ""}{a.summary.slice(0, 80)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function copyArtifact(a: FlowArtifact) {
  const text = a.path ? `${a.path}\n${a.summary}` : a.summary;
  navigator.clipboard
    .writeText(text)
    .then(() => alert(`已复制：${a.path || a.summary.slice(0, 40)}`))
    .catch(() => {});
}

function ModelPicker() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [filter, setFilter] = useState(store.modelFilter);

  useEffect(() => {
    setFilter(store.modelFilter);
  }, [store.modelFilter]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return store.modelList;
    return store.modelList.filter(
      (m) =>
        m.uid.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        m.family.toLowerCase().includes(q) ||
        m.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }, [filter, store.modelList]);

  return (
    <div className="model-picker-backdrop" onClick={store.closeModelPicker}>
      <div className="model-picker" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header">
          {S.modelListTitle} · {store.modelCurrent}
        </div>
        <div className="model-picker-search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            placeholder={S.modelFilterHint}
          />
        </div>
        <div className="model-picker-list">
          {filtered.length === 0 && <div className="empty">{S.modelNoResults}</div>}
          {filtered.map((m) => (
            <div
              key={m.uid}
              className={`model-option ${m.isCurrent ? "active" : ""}`}
              onClick={() => store.switchModel(m)}
            >
              <div className="model-option-title">
                <span>
                  {m.label || m.uid} {m.isCurrent ? ` · ${S.modelCurrentLabel}` : ""}
                </span>
                <span className={`subtitle ${costTierClass(m.costTier)}`}>{m.costTier}</span>
              </div>
              <div className="model-option-subtitle">
                {m.uid} · {m.family} · {m.aliases.join(", ")}
              </div>
              {m.costSummary && <div className="model-option-subtitle">{m.costSummary}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
