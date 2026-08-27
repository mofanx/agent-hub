import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Cpu,
  FileCode,
  FolderTree,
  ImagePlus,
  ListTodo,
  Loader2,
  NotebookText,
  Package,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  SlashSquare,
  Square,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useHubStore } from "../hub/store";
import { stringsFor } from "../hub/strings";
import type { ArtifactInfo, BlackboardInfo, ChatItem, EventInfo, FileTreeNode, FileTreeRoot, FlowArtifact, FlowInfo, FlowTask, TokenUsage, ContextUsage, ModelInfo } from "../hub/types";
import { FileTreePanel } from "./FileTreePanel";
import { Avatar, agentColorClass } from "../components/Avatar";
import { FilePicker } from "../components/FilePicker";

type SidePanelKind = "files" | "flow" | "blackboard" | "artifact" | "event" | null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const safeRenderer = {
  html(text: string) {
    return escapeHtml(text);
  },
};

const fileRefExt = {
  name: "fileRef",
  level: "inline" as const,
  start(src: string) {
    const m = src.match(/(?:^|[\s（(，,;；:：])#(?=[^#\s])/);
    return m ? (m.index ?? 0) + m[0].length - 1 : -1;
  },
  tokenizer(src: string) {
    const rule = /^#([^#\s][^\s，,;；。!！?？\)\]\n]*)/;
    const match = rule.exec(src);
    if (match) {
      return { type: "fileRef", raw: match[0], path: match[1].replace(/\/+$/, "") };
    }
    return undefined;
  },
  renderer(token: { raw: string; path: string }) {
    return `<span class="file-pill" data-path="${escapeHtml(token.path)}">${escapeHtml(token.raw)}</span>`;
  },
};

marked.use({ renderer: safeRenderer as Record<string, unknown>, gfm: true, extensions: [fileRefExt as never] });

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatArtifactTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  return `${date} ${time}`;
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
  const [sidePanel, setSidePanel] = useState<SidePanelKind>(null);
  const [fileTreeInitialPath, setFileTreeInitialPath] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; text?: string; data?: string; mime?: string } | null>(null);
  const [fileRef, setFileRef] = useState<{
    query: { at: number; q: string; dir: string; filter: string };
    candidates: (FileTreeRoot | FileTreeNode)[];
    loading: boolean;
  } | null>(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialScrolledRef = useRef(false);

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
    initialScrolledRef.current = false;
  }, [store.currentRoom?.roomId, store.currentSession?.sessionId]);

  useEffect(() => {
    if (store.chatItems.length === 0) return;
    if (initialScrolledRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
    initialScrolledRef.current = true;
  }, [store.chatItems.length]);

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
    if (!store.fileRefToInsert) return;
    setInput((prev) => `${prev}${store.fileRefToInsert}`);
    store.clearFileRef();
    inputRef.current?.focus();
  }, [store.fileRefToInsert, store, inputRef]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const onDocKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSidePanel((p) => (p === "files" ? null : "files"));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === "Escape") {
        if (lightbox) {
          e.preventDefault();
          setLightbox(null);
        } else if (sidePanel) {
          e.preventDefault();
          setSidePanel(null);
        } else if (searchOpen) {
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
  }, [searchOpen, suggestOpen, cmdOpen, lightbox, sidePanel, store]);

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

  const fileRefQuery = useMemo(() => {
    const hash = input.lastIndexOf("#");
    if (hash < 0) return null;
    const after = input.slice(hash + 1);
    const stopRe = /[\s，,;；。!！?？\)\]\n]/;
    const stop = after.search(stopRe);
    const q = stop >= 0 ? after.slice(0, stop) : after;
    if (!q) return { at: hash, q: "", dir: "", filter: "" };
    const slash = q.lastIndexOf("/");
    if (slash < 0) return { at: hash, q, dir: "", filter: q };
    if (q.endsWith("/")) return { at: hash, q, dir: q, filter: "" };
    return { at: hash, q, dir: q.slice(0, slash + 1), filter: q.slice(slash + 1) };
  }, [input]);

  useEffect(() => {
    if (!fileRefQuery) {
      setFileRef(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const client = store.client;
      const room = store.currentRoom;
      const session = store.currentSession;
      const contextId = room?.roomId ?? session?.sessionId;
      if (!client || !contextId) {
        if (!cancelled) setFileRef({ query: fileRefQuery, candidates: [], loading: false });
        return;
      }
      const isSession = !room;
      const { dir, filter } = fileRefQuery;
      const listDir = dir.replace(/\/$/, "");
      if (!cancelled) setFileRef({ query: fileRefQuery, candidates: [], loading: true });
      try {
        let candidates: (FileTreeRoot | FileTreeNode)[] = [];
        if (listDir) {
          const method = isSession ? "session.file.list" : "room.file.list";
          const params = isSession ? { sessionId: contextId, path: listDir } : { roomId: contextId, path: listDir };
          const result = (await client.call(method, params)) as { nodes?: FileTreeNode[] };
          candidates = result.nodes ?? [];
        } else {
          const method = isSession ? "session.file.roots" : "room.file.roots";
          const params = isSession ? { sessionId: contextId } : { roomId: contextId };
          const result = (await client.call(method, params)) as { roots?: FileTreeRoot[] };
          candidates = result.roots ?? [];
        }
        const f = filter.toLowerCase();
        const filtered = f
          ? candidates.filter((n) => n.name.toLowerCase().startsWith(f) || n.name.toLowerCase().includes(f))
          : candidates;
        if (!cancelled) setFileRef({ query: fileRefQuery, candidates: filtered, loading: false });
      } catch {
        if (!cancelled) setFileRef({ query: fileRefQuery, candidates: [], loading: false });
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fileRefQuery, store.client, store.currentRoom, store.currentSession]);

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

  const insertFileRef = (candidate: FileTreeRoot | FileTreeNode) => {
    if (!fileRef?.query) return;
    const { at, q } = fileRef.query;
    const before = input.slice(0, at);
    const after = input.slice(at + 1 + q.length);
    const isDir = (candidate as FileTreeNode).kind === "dir";
    const path = candidate.path + (isDir ? "/" : "");
    if (isDir) {
      setInput(`${before}#${path}${after}`);
      setSuggestOpen(true);
    } else {
      setInput(`${before}#${path} ${after}`);
      setSuggestOpen(false);
    }
    inputRef.current?.focus();
  };

  const saveBlob = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveText = (name: string, text: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    saveBlob(name, blob);
  };

  const handleFilePillClick = async (ref: string) => {
    const client = store.client;
    const room = store.currentRoom;
    const session = store.currentSession;
    const contextId = room?.roomId ?? session?.sessionId;
    if (!client || !contextId) return;
    const isSession = !room;
    try {
      const params = isSession ? { sessionId: contextId, path: ref } : { roomId: contextId, path: ref };
      const result = (await client.call("file.get", params)) as { text?: string; data?: string; name?: string; mime?: string };
      const name = result.name ?? ref.split("/").pop() ?? "download";
      if (typeof result.text === "string") {
        setFilePreview({ name, text: result.text, mime: result.mime ?? "text/plain" });
      } else if (typeof result.data === "string") {
        const bytes = new Uint8Array(
          atob(result.data)
            .split("")
            .map((c) => c.charCodeAt(0)),
        );
        const blob = new Blob([bytes], { type: result.mime ?? "application/octet-stream" });
        saveBlob(name, blob);
      }
      const parent = ref.split("/").slice(0, -1).join("/") || null;
      setFileTreeInitialPath(parent);
      setSidePanel("files");
    } catch {
      try {
        const method = isSession ? "session.file.list" : "room.file.list";
        const params = isSession ? { sessionId: contextId, path: ref } : { roomId: contextId, path: ref };
        await client.call(method, params);
        setFileTreeInitialPath(ref);
        setSidePanel("files");
      } catch {}
    }
  };

  useEffect(() => {
    if (mention || (slash && slash.length > 0) || (fileRef && fileRef.candidates.length > 0)) {
      setSuggestOpen(true);
      setSuggestIndex(0);
    }
  }, [mention, slash, fileRef]);

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

  const handleFileSelect = (path: string) => {
    setInput(prev => `${prev}#${path} `);
    inputRef.current?.focus();
  };

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
    const active = mention || (slash && slash.length > 0) || (fileRef && fileRef.candidates.length > 0);
    if (active && suggestOpen) {
      const items = mention
        ? (mention.kind === "member" ? mention.members : mention.artifacts)
        : slash && slash.length > 0
          ? slash
          : fileRef?.candidates ?? [];
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
        } else if (slash && slash.length > 0) {
          insertSlash(slash[suggestIndex]?.name ?? slash[0].name);
        } else if (fileRef && fileRef.candidates.length > 0) {
          insertFileRef(fileRef.candidates[suggestIndex] ?? fileRef.candidates[0]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSuggestOpen(false);
        return;
      }
      // 文件引用：→ 进入子目录，← 退出子目录
      if (fileRef && fileRef.candidates.length > 0) {
        const el = e.currentTarget;
        const atEnd = el.selectionStart === el.selectionEnd && el.selectionStart === fileRef.query.at + 1 + fileRef.query.q.length;
        if (atEnd) {
          if (e.key === "ArrowRight") {
            const selected = fileRef.candidates[suggestIndex] ?? fileRef.candidates[0];
            if ((selected as FileTreeNode).kind === "dir") {
              e.preventDefault();
              insertFileRef(selected);
              return;
            }
          }
          if (e.key === "ArrowLeft" && fileRef.query.dir) {
            e.preventDefault();
            const dir = fileRef.query.dir.replace(/\/+$/, "");
            const parent = dir.slice(0, dir.lastIndexOf("/") + 1);
            const before = input.slice(0, fileRef.query.at);
            setInput(`${before}#${parent}`);
            setSuggestOpen(true);
            return;
          }
        }
      }
    }
    const { sendKey } = useHubStore.getState();
    if (sendKey === "ctrl-enter") {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
    } else {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    }
    if (e.key === "Escape") {
      setCmdOpen(false);
    }
  };

  const artifactCount = store.currentArtifacts?.length ?? 0;
  const eventCount = store.currentEvents?.length ?? 0;
  const flowCount = store.flow?.tasks?.length ?? 0;
  const blackboardCount = store.blackboard?.length ?? 0;
  const isContextPanel =
    sidePanel === "flow" || sidePanel === "blackboard" || sidePanel === "artifact" || sidePanel === "event";

  const openContextPanel = () => {
    if (isContextPanel) {
      setSidePanel(null);
      return;
    }
    if (isRoom && flowCount > 0) setSidePanel("flow");
    else if (artifactCount > 0) {
      store.clearNewArtifacts();
      setSidePanel("artifact");
    } else if (eventCount > 0) setSidePanel("event");
    else if (isRoom && blackboardCount > 0) setSidePanel("blackboard");
    else setSidePanel("artifact");
  };

  return (
    <div className="chat-screen">
      <div className="chat-header">
        {!searchOpen ? (
          <div className="title-block">
            <div className="chat-title">{title}</div>
            {subtitle && <div className="chat-subtitle">{subtitle}</div>}
            {contextUsage && <div className="chat-usage">{formatContextUsage(contextUsage)}</div>}
          </div>
        ) : (
          <div className="chat-search-bar">
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
            <button className="icon-btn" onClick={prevMatch} disabled={chatSearchMatchCount === 0} title="上一个 (Shift+Enter)">
              <ChevronUp size={14} />
            </button>
            <button className="icon-btn" onClick={nextMatch} disabled={chatSearchMatchCount === 0} title="下一个 (Enter)">
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setSearchOpen(false);
                setInChatSearchQuery("");
                setChatSearchMatchIndex(-1);
              }}
              title="关闭 (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!searchOpen && (
          <>
            <button className="icon-btn" onClick={() => setSearchOpen(true)} title="搜索聊天内容 (Ctrl+F)">
              <Search size={15} />
            </button>
            <button
              className={`icon-btn ${sidePanel === "files" ? "active" : ""}`}
              onClick={() => setSidePanel(sidePanel === "files" ? null : "files")}
              title="项目文件 (Ctrl+Shift+F)"
            >
              <FolderTree size={15} />
            </button>
            <button
              className={`icon-btn ${isContextPanel ? "active" : ""}`}
              onClick={openContextPanel}
              title="任务 / 产物 / 事件面板"
            >
              <Activity size={15} />
              {store.hasNewArtifacts && sidePanel !== "artifact" && <span className="new-dot" />}
            </button>
            <button className="secondary model-btn" onClick={() => void store.showModelPickerDialog()} title="切换模型">
              <Cpu size={13} />
              <span>{store.modelCurrent || "模型"}</span>
            </button>
          </>
        )}
      </div>

      <div className="chat-body">
        <div className="chat-main">
          <div ref={messagesRef} className="chat-messages" onScroll={onMessagesScroll}>
            <div className="chat-column">
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
                    onFilePillClick={handleFilePillClick}
                  />
                );
              })}
              <div ref={bottomRef} />
            </div>
            {!isAtBottom && (
              <button
                className="scroll-to-bottom"
                onClick={scrollToBottom}
                title="回到底部"
                type="button"
              >
                <ArrowDown size={15} />
              </button>
            )}
          </div>

          <div className="compose-wrap">
            {store.quote && (
              <div className="quote-bar">
                <span className="subtitle">
                  引用 @{store.quote[0]}: {store.quote[1].slice(0, 80)}
                </span>
                <button className="icon-btn" onClick={() => store.setQuote(null)} title="取消引用">
                  <X size={13} />
                </button>
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
                      <button className="icon-btn" style={{ width: "1.3rem", height: "1.3rem" }} onClick={() => store.removeAttachment(a)}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
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
                        {a.path ? `${a.path} · ` : ""}{a.summary.slice(0, 80)} · @{store.sessionName(a.author)}
                      </div>
                    ))}
              </div>
            )}

            {suggestOpen && slash && slash.length > 0 && (
              <div className="suggest-popup slash-popup">
                {(() => {
                  const skillNames = new Set(store.skills.map((s) => s.name));
                  const local = slash.filter((c) => !skillNames.has(c.name));
                  const skills = slash.filter((c) => skillNames.has(c.name));
                  let idx = 0;
                  return (
                    <>
                      {local.length > 0 && (
                        <>
                          <div className="slash-group">命令</div>
                          {local.map((c) => {
                            const i = idx++;
                            return (
                              <div
                                key={c.name}
                                className={`suggest-item slash-item ${i === suggestIndex ? "active" : ""}`}
                                onClick={() => insertSlash(c.name)}
                                onMouseEnter={() => setSuggestIndex(i)}
                              >
                                <span className="slash-cmd">/{c.name}</span>
                                <span className="slash-desc"> — {c.description}</span>
                              </div>
                            );
                          })}
                        </>
                      )}
                      {skills.length > 0 && (
                        <>
                          {local.length > 0 && <div className="slash-divider" />}
                          <div className="slash-group">Skill</div>
                          {skills.map((c) => {
                            const i = idx++;
                            return (
                              <div
                                key={c.name}
                                className={`suggest-item slash-item ${i === suggestIndex ? "active" : ""}`}
                                onClick={() => insertSlash(c.name)}
                                onMouseEnter={() => setSuggestIndex(i)}
                              >
                                <span className="slash-cmd">/{c.name}</span>
                                <span className="slash-tag">skill</span>
                                <span className="slash-desc"> — {c.description}</span>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {suggestOpen && fileRef && fileRef.candidates.length > 0 && (
              <div className="suggest-popup file-ref-popup">
                {fileRef.loading && <div className="suggest-loading">加载中…</div>}
                {fileRef.candidates.map((c, i) => {
                  const isDir = (c as FileTreeNode).kind === "dir";
                  return (
                    <div
                      key={c.path}
                      className={`suggest-item ${i === suggestIndex ? "active" : ""}`}
                      onClick={() => insertFileRef(c)}
                      onMouseEnter={() => setSuggestIndex(i)}
                    >
                      <span className="suggest-icon">{isDir ? <FolderTree size={12} /> : <FileCode size={12} />}</span>
                      <span className="suggest-name">{c.name}</span>
                      <span className="suggest-meta" title={c.path}>{c.path}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

              {store.isGenerating() ? (
                <button
                  className="send-btn danger"
                  onClick={store.stopCurrent}
                  title="停止生成"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  disabled={!input.trim() && !store.pendingAttachments.length}
                  title={`发送 (${store.sendKey === "ctrl-enter" ? "Ctrl+Enter" : "Enter"})`}
                >
                  <ArrowUp size={16} />
                </button>
              )}
              </div>

              {cmdOpen && (
                <div className="dropdown-menu">
                  {store.defaultCommands.map((c) => (
                    <div key={c} className="dropdown-item" onClick={() => insertCommand(c)}>
                      {c}
                    </div>
                  ))}
                  {store.customCommands.map((c) => (
                    <div key={c} className="dropdown-item">
                      <span onClick={() => insertCommand(c)} style={{ flex: 1 }}>{c}</span>
                      <button
                        className="icon-btn danger"
                        style={{ width: "1.4rem", height: "1.4rem" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          store.removeCommand(c);
                        }}
                      >
                        <Trash2 size={11} />
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
                    <Plus size={12} style={{ color: "var(--muted)" }} /> 保存当前输入为指令
                  </div>
                </div>
              )}

              <div className="compose-toolbar">
                <button className={`icon-btn ${cmdOpen ? "active" : ""}`} onClick={() => setCmdOpen(!cmdOpen)} title="快捷指令">
                  <SlashSquare size={14} />
                </button>
                <button className="icon-btn" onClick={() => setFilePickerOpen(true)} title="选择文件引用 (#)">
                  <FileCode size={14} />
                </button>
                <button className="icon-btn" onClick={onPickImage} title="添加图片">
                  <ImagePlus size={14} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={onFileChange}
                />
                <span className="spacer" />
              </div>
            </div>
          </div>
        </div>

        {sidePanel && (
          <aside className="chat-side">
            <div className="chat-side-tabs">
              <button
                className={`icon-btn ${sidePanel === "files" ? "active" : ""}`}
                title="项目文件"
                onClick={() => setSidePanel("files")}
              >
                <FolderTree size={14} />
              </button>
              {isRoom && (
                <>
                  <button
                    className={`icon-btn ${sidePanel === "flow" ? "active" : ""}`}
                    title={`任务编排 · ${flowCount} 项`}
                    disabled={flowCount === 0 && sidePanel !== "flow"}
                    onClick={() => setSidePanel("flow")}
                  >
                    <ListTodo size={14} />
                  </button>
                  <button
                    className={`icon-btn ${sidePanel === "blackboard" ? "active" : ""}`}
                    title={`共享黑板 · ${blackboardCount} 条`}
                    disabled={blackboardCount === 0 && sidePanel !== "blackboard"}
                    onClick={() => setSidePanel("blackboard")}
                  >
                    <NotebookText size={14} />
                  </button>
                </>
              )}
              <button
                className={`icon-btn ${sidePanel === "artifact" ? "active" : ""}`}
                title={`产物 · ${artifactCount} 条`}
                disabled={artifactCount === 0 && sidePanel !== "artifact"}
                onClick={() => {
                  store.clearNewArtifacts();
                  setSidePanel("artifact");
                }}
              >
                <Package size={14} />
                {store.hasNewArtifacts && sidePanel !== "artifact" && <span className="new-dot" />}
              </button>
              <button
                className={`icon-btn ${sidePanel === "event" ? "active" : ""}`}
                title={`事件 · ${eventCount} 条`}
                disabled={eventCount === 0 && sidePanel !== "event"}
                onClick={() => setSidePanel("event")}
              >
                <Zap size={14} />
              </button>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setSidePanel(null)} title="关闭面板 (Esc)">
                <X size={14} />
              </button>
            </div>
            <div className="chat-side-body">
              {sidePanel === "files" && store.currentRoom && (
                <FileTreePanel
                  contextId={store.currentRoom.roomId}
                  isSession={false}
                  onClose={() => setSidePanel(null)}
                  initialPath={fileTreeInitialPath}
                  onQuote={(filePath) => {
                    setSidePanel(null);
                    setInput((prev) => `${prev}#${filePath.endsWith("/") ? filePath.slice(0, -1) : filePath} `);
                    inputRef.current?.focus();
                  }}
                  onPreview={(file) => setFilePreview(file)}
                />
              )}
              {sidePanel === "files" && !store.currentRoom && store.currentSession && (
                <FileTreePanel
                  contextId={store.currentSession.sessionId}
                  isSession
                  onClose={() => setSidePanel(null)}
                  initialPath={fileTreeInitialPath}
                  onQuote={(filePath) => {
                    setSidePanel(null);
                    setInput((prev) => `${prev}#${filePath.endsWith("/") ? filePath.slice(0, -1) : filePath} `);
                    inputRef.current?.focus();
                  }}
                  onPreview={(file) => setFilePreview(file)}
                />
              )}
              {sidePanel === "flow" && (
                <FlowPanel flow={store.flow} roomMode={store.currentRoom?.mode ?? ""} minimal />
              )}
              {sidePanel === "blackboard" && <BlackboardPanel blackboard={store.blackboard} />}
              {sidePanel === "artifact" && <ArtifactPanel artifacts={store.currentArtifacts ?? []} minimal />}
              {sidePanel === "event" && <EventPanel events={store.currentEvents ?? []} minimal />}
            </div>
          </aside>
        )}
      </div>

      {filePreview && (
        <div className="dialog-backdrop" onClick={() => setFilePreview(null)}>
          <div className="dialog file-preview" onClick={(e) => e.stopPropagation()}>
            <h4>{filePreview.name}</h4>
            {filePreview.text != null ? (
              <pre>{filePreview.text}</pre>
            ) : filePreview.data && filePreview.mime?.startsWith("image/") ? (
              <img
                src={`data:${filePreview.mime};base64,${filePreview.data}`}
                alt={filePreview.name}
                style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
              />
            ) : (
              <div className="subtitle">二进制文件</div>
            )}
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setFilePreview(null)}>关闭</button>
              {filePreview.text != null && (
                <button onClick={() => navigator.clipboard.writeText(filePreview.text ?? "").catch(() => {})}>复制</button>
              )}
              <button
                onClick={() => {
                  if (filePreview.data) {
                    const bytes = new Uint8Array(
                      atob(filePreview.data)
                        .split("")
                        .map((c) => c.charCodeAt(0)),
                    );
                    const blob = new Blob([bytes], { type: filePreview.mime ?? "application/octet-stream" });
                    saveBlob(filePreview.name, blob);
                  } else if (filePreview.text != null) {
                    saveText(filePreview.name, filePreview.text);
                  }
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {store.showModelPicker && <ModelPicker />}

      <FilePicker
        open={filePickerOpen}
        onClose={() => setFilePickerOpen(false)}
        onSelect={handleFileSelect}
      />

      {lightbox && (
        <div className="image-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.name} onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)}>
            <X size={16} />
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
  onFilePillClick,
}: {
  item: ChatItem;
  showAuthor: boolean;
  expanded: boolean;
  isQuoted: boolean;
  onToggleThought: () => void;
  highlight?: string;
  isCurrentMatch?: boolean;
  onImageClick?: (src: string, name?: string) => void;
  onFilePillClick?: (path: string) => void;
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
      <div>
        <span className="usage-pill">{formatTokenUsage(item.usage)}</span>
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

  const onTextClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const pill = target.closest(".file-pill") as HTMLElement | null;
    if (pill && onFilePillClick) {
      e.preventDefault();
      const path = pill.getAttribute("data-path");
      if (path) onFilePillClick(path);
    }
  };

  const markdownHtml = (text: string) => (highlight ? highlightHtml(renderMarkdown(text), highlight) : renderMarkdown(text));

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
            <div className="text" onClick={onTextClick} dangerouslySetInnerHTML={{ __html: markdownHtml(item.text) }} />
          </div>
          {attachmentsEl}
          {menuEl}
          {selectModal}
        </div>
      );

    case "assistant":
      return (
        <div className={`message assistant ${agentColorClass(item.author || "AI")} ${isQuoted ? "quoted" : ""} ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <Avatar name={item.author || "AI"} />
          <div className="msg-body">
            {item.author && <div className="author">{item.author}</div>}
            {item.quoteAuthor && (
              <div className="quote-preview">
                引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
              </div>
            )}
            <div className="text" onClick={onTextClick} dangerouslySetInnerHTML={{ __html: markdownHtml(item.text) }} />
            {usageText}
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "thought":
      return (
        <div className={`message thought ${agentColorClass(item.author || "AI")} ${isQuoted ? "quoted" : ""} ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="msg-body">
            {showAuthor && item.author && <div className="author">{item.author}</div>}
            {item.quoteAuthor && (
              <div className="quote-preview">
                引用 @{item.quoteAuthor}: {item.quoteText?.slice(0, 80)}
              </div>
            )}
            <button className="thought-toggle" onClick={onToggleThought}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 思考过程
            </button>
            {expanded && (
              <div className="text" onClick={onTextClick} dangerouslySetInnerHTML={{ __html: markdownHtml(item.text) }} />
            )}
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "tool":
      return (
        <div className={`message tool ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="msg-body">
            {showAuthor && item.author && <div className="author">{item.author}</div>}
            <div className="tool-row">
              <span className="tool-icon">
                <Wrench size={12} />
              </span>
              <span>{highlight ? highlightText(item.title, highlight) : item.title}</span>
              <span className="tool-status">{item.status}</span>
            </div>
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "plan":
      return (
        <div className={`message plan ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="msg-body">
            {showAuthor && item.author && <div className="author">{item.author}</div>}
            <div className="plan-head">
              <ListTodo size={12} /> 计划
            </div>
            {item.entries.map((e, i) => (
              <div key={i} className="text">
                {highlight ? highlightText(e, highlight) : e}
              </div>
            ))}
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "error":
      return (
        <div className={`message error ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="msg-body">
            <div className="text">
              {item.author ? `[${item.author}] ` : ""}错误: {highlight ? highlightText(item.text, highlight) : item.text}
            </div>
          </div>
          {menuEl}
          {selectModal}
        </div>
      );

    case "permission":
      return (
        <div className={`message permission ${currentMatchClass}`} onContextMenu={onContextMenu}>
          <div className="msg-body">
            <div className="permission-head">
              <ShieldAlert size={14} />
              {showAuthor && item.author ? `${item.author} · ` : ""}审批请求
            </div>
            <div className="text">
              {highlight ? highlightText(item.title, highlight) : item.title}
            </div>
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

function BlackboardPanel({ blackboard }: { blackboard: BlackboardInfo[] | null }) {
  const store = useHubStore();
  const roomId = store.currentRoom?.roomId;
  const [detail, setDetail] = useState<BlackboardInfo | null>(null);
  if (!blackboard || blackboard.length === 0) {
    return <div className="context-empty">暂无黑板摘要</div>;
  }
  const onClear = async () => {
    if (!roomId) return;
    if (!window.confirm("确认清空全部黑板摘要？")) return;
    await store.clearBlackboard(roomId);
  };
  const onRemove = async () => {
    if (!roomId || !detail) return;
    if (!window.confirm("确认删除这条黑板摘要？")) return;
    await store.removeBlackboard(roomId, detail.id);
    setDetail(null);
  };
  return (
    <div className="context-content blackboard-list">
      <div className="context-content-header">
        <span className="context-content-title">黑板</span>
        <button className="context-action danger" onClick={onClear}>清空</button>
      </div>
      {blackboard
        .slice()
        .reverse()
        .map((e) => (
          <div key={e.id} className="blackboard-item" onClick={() => setDetail(e)}>
            <div className="blackboard-line">
              <span className="blackboard-from">@{e.from}</span>
              <span className="blackboard-time">{formatArtifactTime(e.at)}</span>
            </div>
            <div className="blackboard-text">{e.text}</div>
          </div>
        ))}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog blackboard-detail" onClick={(ev) => ev.stopPropagation()}>
            <h4>黑板摘要</h4>
            <div className="blackboard-line">
              <span className="blackboard-from">@{detail.from}</span>
              <span className="blackboard-time">{formatArtifactTime(detail.at)}</span>
            </div>
            <pre>{detail.detail}</pre>
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setDetail(null)}>关闭</button>
              <button className="danger" onClick={onRemove}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlowPanel({ flow, roomMode, minimal = false }: { flow: FlowInfo | null; roomMode: string; minimal?: boolean }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("flowPanelCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("flowPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  if (!flow) return null;
  const { progress, tasks } = flow;
  if (tasks.length === 0) return null;
  const title = roomMode === "conductor" ? "指挥编排" : "编排进度";
  const content = (
    <div className="flow-tasks">
      {tasks.map((t) => (
        <FlowTaskItem key={t.id} task={t} />
      ))}
    </div>
  );
  if (minimal) {
    return <div className="context-content">{content}</div>;
  }
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
      {!collapsed && content}
    </div>
  );
}

type FileGetResult = {
  text?: string;
  data?: string;
  name?: string;
  mime?: string;
};

function ArtifactPanel({ artifacts, minimal = false }: { artifacts: ArtifactInfo[]; minimal?: boolean }) {
  const store = useHubStore();
  const roomId = store.currentRoom?.roomId;
  const sessionId = store.currentSession?.sessionId;
  const contextId = roomId ?? sessionId;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("artifactPanelCollapsed") === "1");
  const [preview, setPreview] = useState<(FileGetResult & { name: string }) | null>(null);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = activeId ? artifacts.find((a) => a.id === activeId) ?? null : null;
  useEffect(() => {
    localStorage.setItem("artifactPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  const fetchFile = async (artifact: ArtifactInfo): Promise<FileGetResult | null> => {
    const client = store.client;
    if (!client || !contextId) return null;
    const params = roomId
      ? { roomId, artifactId: artifact.id }
      : { sessionId: contextId, path: artifact.path ?? artifact.id };
    return (await client.call("file.get", params)) as FileGetResult;
  };

  const saveBlob = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveText = (name: string, text: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    saveBlob(name, blob);
  };

  const handlePreview = async (a: ArtifactInfo) => {
    try {
      const res = await fetchFile(a);
      if (!res) return;
      setPreview({ ...res, name: String(res.name ?? a.path ?? "preview") });
    } catch (e) {
      alert(`预览失败：${e}`);
    }
  };

  const handleDownload = async (a: ArtifactInfo) => {
    try {
      const res = await fetchFile(a);
      if (!res) return;
      const name = String(res.name ?? a.path ?? "download");
      if (typeof res.text === "string") {
        saveText(name, res.text);
      } else if (typeof res.data === "string") {
        const bytes = new Uint8Array(atob(res.data).split("").map((c) => c.charCodeAt(0)));
        const blob = new Blob([bytes], { type: res.mime ?? "application/octet-stream" });
        saveBlob(name, blob);
      }
    } catch (e) {
      alert(`下载失败：${e}`);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onDeleteSelected = async () => {
    if (!contextId || selected.size === 0) return;
    const list = Array.from(selected);
    const names = list
      .map((id) => {
        const a = artifacts.find((x) => x.id === id);
        return a ? (a.alias ?? a.id) : id;
      })
      .join(", ");
    if (!window.confirm(`确认删除选中的 ${list.length} 个产物？\n${names}`)) return;
    await Promise.all(list.map((id) => store.removeArtifact(contextId, id)));
    setSelected(new Set());
    setManaging(false);
  };

  const onClearAll = async () => {
    if (!contextId) return;
    if (!window.confirm("确认清空全部产物？")) return;
    await store.clearArtifacts(contextId);
    setSelected(new Set());
    setManaging(false);
    setActiveId(null);
  };

  const onRemoveActive = async () => {
    if (!contextId || !active) return;
    if (!window.confirm(`确认删除产物 ${active.path ?? active.alias ?? active.id}？`)) return;
    await store.removeArtifact(contextId, active.id);
    setActiveId(null);
  };

  const onQuote = () => active && store.quoteArtifact(active);
  const onPreview = () => active && handlePreview(active);
  const onDownload = () => active && handleDownload(active);

  const manageActions = (
    <div className="artifact-header-actions" onClick={(e) => e.stopPropagation()}>
      {!managing ? (
        <button className="context-action" onClick={() => { setManaging(true); setActiveId(null); }}>管理</button>
      ) : (
        <>
          <button className="context-action danger" onClick={onClearAll}>清空</button>
          <button className="context-action danger" onClick={onDeleteSelected} disabled={selected.size === 0}>
            删除选中{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button
            className="context-action"
            onClick={() => {
              setManaging(false);
              setSelected(new Set());
            }}
          >
            完成
          </button>
        </>
      )}
    </div>
  );

  const activeToolbar = active ? (
    <div className="artifact-active-toolbar" onClick={(e) => e.stopPropagation()}>
      <span className="artifact-active-name" title={active.summary}>
        {active.path ?? active.alias ?? active.id}
      </span>
      <button className="artifact-action" title="引用" onClick={onQuote}>引</button>
      <button className="artifact-action" title="预览" onClick={onPreview}>看</button>
      <button className="artifact-action" title="下载" onClick={onDownload}>↓</button>
      <button className="artifact-action danger" title="删除" onClick={onRemoveActive}>删</button>
    </div>
  ) : null;

  const list = (
    <div className="artifact-list">
      {artifacts.map((a) => (
        <div
          key={a.id}
          onClick={() => {
            if (managing) toggleSelected(a.id);
            else setActiveId(a.id === activeId ? null : a.id);
          }}
          className={`artifact-item artifact-kind-file ${managing ? "managing" : ""} ${managing && selected.has(a.id) ? "selected" : ""} ${!managing && a.id === activeId ? "active" : ""}`}
          title={a.path ? `${a.path}\n${a.summary}` : a.summary}
        >
          {managing && (
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  return next;
                });
              }}
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <div className="artifact-info">
            <span className="artifact-kind-badge">{kindIcon("file")}</span>
            <span className="artifact-path">{a.path ?? a.alias ?? a.id}</span>
            <span className="artifact-author">@{store.sessionName(a.author)}</span>
            <span className="artifact-time">{formatArtifactTime(a.at)}</span>
            <span className="artifact-summary">{a.summary}</span>
          </div>
        </div>
      ))}
    </div>
  );

  const countText = `${artifacts.length} 条`;
  const listContent = artifacts.length > 0 ? list : <div className="context-empty">没有产物</div>;

  return (
    <>
      {minimal ? (
        <div className="context-content">
          <div className="context-content-header">
            <span className="context-content-title">产物</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {activeToolbar}
          {listContent}
        </div>
      ) : (
        <div className="artifact-panel">
          <div className="artifact-header" onClick={() => setCollapsed(!collapsed)} title="点击折叠/展开">
            <span className="artifact-title">{collapsed ? "▸ " : "▾ "}产物</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {!collapsed && (
            <>
              {activeToolbar}
              {listContent}
            </>
          )}
        </div>
      )}

      {preview && (
        <div className="dialog-backdrop" onClick={() => setPreview(null)}>
          <div className="dialog file-preview" onClick={(e) => e.stopPropagation()}>
            <h4>{preview.name}</h4>
            {preview.text != null ? (
              <pre>{preview.text}</pre>
            ) : preview.data && preview.mime?.startsWith("image/") ? (
              <img
                src={`data:${preview.mime};base64,${preview.data}`}
                alt={preview.name}
                style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
              />
            ) : (
              <div className="subtitle">二进制文件</div>
            )}
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setPreview(null)}>关闭</button>
              {preview.text != null && (
                <button onClick={() => navigator.clipboard.writeText(preview.text ?? "").catch(() => {})}>复制</button>
              )}
              {preview.text != null ? (
                <button onClick={() => saveText(preview.name, preview.text ?? "")}>保存</button>
              ) : preview.data ? (
                <button
                  onClick={() => {
                    const bytes = new Uint8Array(
                      atob(preview.data!)
                        .split("")
                        .map((c) => c.charCodeAt(0)),
                    );
                    const blob = new Blob([bytes], { type: preview.mime ?? "application/octet-stream" });
                    saveBlob(preview.name, blob);
                  }}
                >
                  保存
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function EventPanel({ events, minimal = false }: { events: EventInfo[]; minimal?: boolean }) {
  const store = useHubStore();
  const roomId = store.currentRoom?.roomId;
  const sessionId = store.currentSession?.sessionId;
  const contextId = roomId ?? sessionId;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("eventPanelCollapsed") === "1");
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [clearAction, setClearAction] = useState<string | null>(null);
  const active = activeId ? events.find((e) => e.id === activeId) ?? null : null;
  useEffect(() => {
    localStorage.setItem("eventPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  const actionOptions = useMemo(
    () => events.map((e) => e.action).filter((v, i, a) => a.indexOf(v) === i).sort(),
    [events],
  );

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onDeleteSelected = async () => {
    if (!contextId || selected.size === 0) return;
    const list = Array.from(selected);
    if (!window.confirm(`确认删除选中的 ${list.length} 条事件？`)) return;
    await Promise.all(list.map((id) => store.removeEvent(contextId, id)));
    setSelected(new Set());
    setManaging(false);
  };

  const onClear = async () => {
    if (!contextId) return;
    const label = clearAction ? `「${eventLabel(clearAction)}」` : "全部";
    if (!window.confirm(`确认清空 ${label} 事件？`)) return;
    await store.clearEvents(contextId, clearAction ?? undefined);
    setSelected(new Set());
    setManaging(false);
    setActiveId(null);
  };

  const onRemoveActive = async () => {
    if (!contextId || !active) return;
    if (!window.confirm(`确认删除该事件？\n${active.summary}`)) return;
    await store.removeEvent(contextId, active.id);
    setActiveId(null);
  };

  const onQuote = () => active && store.quoteEvent(active);

  const clearMenu = (
    <select
      className="context-action event-clear-select"
      value={clearAction ?? ""}
      onChange={(e) => setClearAction(e.target.value || null)}
      onClick={(e) => e.stopPropagation()}
      title="选择要清空的事件类型"
    >
      <option value="">清空全部</option>
      {actionOptions.map((a) => (
        <option key={a} value={a}>仅清空「{eventLabel(a)}」</option>
      ))}
    </select>
  );

  const manageActions = (
    <div className="artifact-header-actions" onClick={(e) => e.stopPropagation()}>
      {!managing ? (
        <>
          {clearMenu}
          <button className="context-action" onClick={onClear}>清空</button>
          <button className="context-action" onClick={() => { setManaging(true); setActiveId(null); }}>管理</button>
        </>
      ) : (
        <>
          <button className="context-action danger" onClick={onDeleteSelected} disabled={selected.size === 0}>
            删除选中{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button
            className="context-action"
            onClick={() => {
              setManaging(false);
              setSelected(new Set());
            }}
          >
            完成
          </button>
        </>
      )}
    </div>
  );

  const activeToolbar = active ? (
    <div className="artifact-active-toolbar" onClick={(e) => e.stopPropagation()}>
      <span className="artifact-active-name" title={active.summary}>
        {active.path || active.summary}
      </span>
      <button className="artifact-action" title="引用" onClick={onQuote}>引</button>
      <button className="artifact-action danger" title="删除" onClick={onRemoveActive}>删</button>
    </div>
  ) : null;

  const list = (
    <div className="artifact-list event-list">
      {events.map((e) => (
        <div
          key={e.id}
          onClick={() => {
            if (managing) toggleSelected(e.id);
            else setActiveId(e.id === activeId ? null : e.id);
          }}
          className={`artifact-item artifact-kind-event ${managing ? "managing" : ""} ${managing && selected.has(e.id) ? "selected" : ""} ${!managing && e.id === activeId ? "active" : ""}`}
          title={e.summary}
        >
          {managing && (
            <input
              type="checkbox"
              checked={selected.has(e.id)}
              onChange={(ev) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (ev.target.checked) next.add(e.id);
                  else next.delete(e.id);
                  return next;
                });
              }}
              onClick={(ev) => ev.stopPropagation()}
            />
          )}
          <div className="artifact-info">
            <span className="artifact-kind-badge">{eventIcon(e.action)}</span>
            <span className="artifact-author">@{store.sessionName(e.author)}</span>
            <span className="artifact-time">{formatArtifactTime(e.at)}</span>
            <span className="artifact-summary">
              {eventLabel(e.action)} · {e.oldPath ? `${e.oldPath} → ` : ""}
              {e.path ? `${e.path} · ` : ""}{e.summary}
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  const countText = `${events.length} 条`;
  const listContent = events.length > 0 ? list : <div className="context-empty">没有事件</div>;

  return (
    <>
      {minimal ? (
        <div className="context-content">
          <div className="context-content-header">
            <span className="context-content-title">事件</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {activeToolbar}
          {listContent}
        </div>
      ) : (
        <div className="artifact-panel">
          <div className="artifact-header" onClick={() => setCollapsed(!collapsed)} title="点击折叠/展开">
            <span className="artifact-title">{collapsed ? "▸ " : "▾ "}事件</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {!collapsed && (
            <>
              {activeToolbar}
              {listContent}
            </>
          )}
        </div>
      )}
    </>
  );
}

function kindIcon(kind: string): ReactNode {
  if (kind === "file") return <FileCode size={13} />;
  return <Pencil size={13} />;
}

function eventIcon(action?: string): ReactNode {
  if (action === "delete") return <Trash2 size={12} />;
  if (action === "rename") return <Pencil size={12} />;
  if (action === "command") return <Zap size={12} />;
  if (action === "test") return <Check size={12} />;
  if (action === "add") return <Plus size={12} />;
  if (action === "modify") return <Pencil size={12} />;
  return <Pencil size={12} />;
}

function eventLabel(action?: string): string {
  if (action === "delete") return "删除";
  if (action === "rename") return "重命名";
  if (action === "command") return "命令";
  if (action === "test") return "测试";
  if (action === "add") return "新增";
  if (action === "modify") return "修改";
  return "事件";
}

function renderMarkdown(text: string): string {
  try {
    const html = marked.parse(text, { gfm: true }) as string;
    const withScrollableTables = html
      .replace(/<table([^>]*)>/g, '<div class="table-wrap"><table$1>')
      .replace(/<\/table>/g, "</table></div>");
    return withScrollableTables
      .replace(
        /<pre><code/g,
        '<div class="code-block"><button class="copy-code" title="复制" onclick=\'const n=this.nextElementSibling;if(n){navigator.clipboard.writeText(n.textContent).catch(()=>{});this.textContent="已复制";setTimeout(()=>this.textContent="复制",1500)}\'>复制</button><pre><code',
      )
      .replace(/<\/code><\/pre>/g, "</code></pre></div>");
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
  }
}

function FlowTaskItem({ task }: { task: FlowTask }) {
  const statusIcon =
    task.status === "done" ? (
      <Check size={12} />
    ) : task.status === "running" ? (
      <Loader2 size={12} className="spin" />
    ) : task.status === "failed" ? (
      <X size={12} />
    ) : (
      <Circle size={11} />
    );
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
  const [selectedBackend, setSelectedBackend] = useState<string>("all");

  useEffect(() => {
    setFilter(store.modelFilter);
  }, [store.modelFilter]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let models = store.modelList;
    
    // 按后端过滤
    if (selectedBackend !== "all") {
      models = models.filter(m => m.backend === selectedBackend);
    }
    
    // 按搜索词过滤
    if (q) {
      models = models.filter(
        (m) =>
          m.uid.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q) ||
          m.family.toLowerCase().includes(q) ||
          m.aliases.some((a) => a.toLowerCase().includes(q)),
      );
    }
    
    return models;
  }, [filter, store.modelList, selectedBackend]);

  // 按后端分组
  const groupedByBackend = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    filtered.forEach(m => {
      const backend = m.backend || "devin";
      if (!groups[backend]) groups[backend] = [];
      groups[backend].push(m);
    });
    return groups;
  }, [filtered]);

  const backendNames: Record<string, string> = {
    devin: "Devin",
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    custom: "自定义",
  };

  return (
    <div className="model-picker-backdrop" onClick={store.closeModelPicker}>
      <div className="model-picker" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{S.modelListTitle} · {store.modelCurrent}</span>
          <button className="icon-btn" onClick={store.closeModelPicker} title="关闭">
            <X size={15} />
          </button>
        </div>
        <div className="model-picker-search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            placeholder={S.modelFilterHint}
          />
        </div>
        <div className="model-picker-backends">
          <button
            className={selectedBackend === "all" ? "active" : ""}
            onClick={() => setSelectedBackend("all")}
          >
            全部
          </button>
          {Object.entries(backendNames).map(([key, name]) => (
            <button
              key={key}
              className={selectedBackend === key ? "active" : ""}
              onClick={() => setSelectedBackend(key)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="model-picker-list">
          {filtered.length === 0 && <div className="empty">{S.modelNoResults}</div>}
          {Object.entries(groupedByBackend).map(([backend, models]) => (
            <div key={backend} className="model-backend-group">
              <div className="model-backend-name">{backendNames[backend] || backend}</div>
              {models.map((m) => (
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
          ))}
        </div>
      </div>
    </div>
  );
}
