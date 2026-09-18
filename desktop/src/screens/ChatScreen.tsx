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
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  SlashSquare,
  Square,
  Trash2,
  Wrench,
  X,
  HelpCircle,
  Zap,
} from "lucide-react";
import { useHubStore } from "../hub/store";
import { stringsFor } from "../hub/strings";
import type { ArtifactInfo, BlackboardInfo, ChatItem, ElicitationField, ElicitationValue, EventInfo, FileTreeNode, FileTreeRoot, FlowArtifact, FlowInfo, FlowTask, QualitySummary, QualityCheck, QualityFinding, QualityPolicyInfo, QualityPolicyV2, RequirementSpec, RequirementVerification, TokenUsage, ContextUsage, ModelInfo } from "../hub/types";
import { qualityStageLabel, qualityFailureLabel, actionGuide, compactQualityProgress, TERMINAL_STAGES } from "../hub/quality-labels";
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
  const quota = store.backendQuota;
  const quotaSummary =
    !isRoom && store.currentSession?.agent === "devin" && quota?.available
      ? `Devin ${[
          quota.daily ? `日已用 ${quota.daily.usedPercent}%` : "",
          quota.weekly ? `周已用 ${quota.weekly.usedPercent}%` : "",
        ].filter(Boolean).join(" · ")}`
      : "";

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
  const newTotal = store.newCounts.artifact + store.newCounts.event + store.newCounts.blackboard;
  const isContextPanel =
    sidePanel === "flow" || sidePanel === "blackboard" || sidePanel === "artifact" || sidePanel === "event";

  const openContextPanel = () => {
    if (isContextPanel) {
      setSidePanel(null);
      return;
    }
    if (isRoom && flowCount > 0) setSidePanel("flow");
    else if (artifactCount > 0) {
      store.clearNewCounts("artifact");
      setSidePanel("artifact");
    } else if (eventCount > 0) {
      store.clearNewCounts("event");
      setSidePanel("event");
    } else if (isRoom && blackboardCount > 0) {
      store.clearNewCounts("blackboard");
      setSidePanel("blackboard");
    } else setSidePanel("artifact");
  };

  return (
    <div className="chat-screen">
      <div className="chat-header">
        {!searchOpen ? (
          <div className="title-block">
            <div className="chat-title">{title}</div>
            {subtitle && <div className="chat-subtitle">{subtitle}</div>}
            {contextUsage && <div className="chat-usage">{formatContextUsage(contextUsage)}</div>}
            {quotaSummary && <div className="chat-usage">{quotaSummary}</div>}
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
              {newTotal > 0 && !isContextPanel && <span className="new-badge">{newTotal > 99 ? "99+" : newTotal}</span>}
            </button>
            <button className="secondary model-btn" onClick={() => void store.showModelPickerDialog()} title="切换模型">
              <Cpu size={13} />
              <span>{isRoom ? "成员模型" : (store.modelCurrent || "模型")}</span>
            </button>
          </>
        )}
      </div>

      {store.sessionQuality && !isRoom && (
        <QualityStatusBar quality={store.sessionQuality} store={store} />
      )}

      {store.currentSpec && store.sessionQuality && store.shownSpecRunIds.has(store.sessionQuality.runId) && !isRoom && (
        <SpecSummaryCard spec={store.currentSpec} runId={store.sessionQuality.runId} stage={store.sessionQuality.stage} />
      )}

      {store.currentSpec && isRoom && store.flow && (() => {
        const task = store.flow!.tasks.find((t) => t.qualityRunId && store.shownSpecRunIds.has(t.qualityRunId));
        return task ? <SpecSummaryCard spec={store.currentSpec!} runId={task.qualityRunId!} stage={task.quality?.stage ?? ""} /> : null;
      })()}

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
                    onClick={() => {
                      store.clearNewCounts("blackboard");
                      setSidePanel("blackboard");
                    }}
                  >
                    <NotebookText size={14} />
                    {store.newCounts.blackboard > 0 && sidePanel !== "blackboard" && (
                      <span className="new-badge">{store.newCounts.blackboard > 99 ? "99+" : store.newCounts.blackboard}</span>
                    )}
                  </button>
                </>
              )}
              <button
                className={`icon-btn ${sidePanel === "artifact" ? "active" : ""}`}
                title={`产物 · ${artifactCount} 条`}
                disabled={artifactCount === 0 && sidePanel !== "artifact"}
                onClick={() => {
                  store.clearNewCounts("artifact");
                  setSidePanel("artifact");
                }}
              >
                <Package size={14} />
                {store.newCounts.artifact > 0 && sidePanel !== "artifact" && (
                  <span className="new-badge">{store.newCounts.artifact > 99 ? "99+" : store.newCounts.artifact}</span>
                )}
              </button>
              <button
                className={`icon-btn ${sidePanel === "event" ? "active" : ""}`}
                title={`事件 · ${eventCount} 条`}
                disabled={eventCount === 0 && sidePanel !== "event"}
                onClick={() => {
                  store.clearNewCounts("event");
                  setSidePanel("event");
                }}
              >
                <Zap size={14} />
                {store.newCounts.event > 0 && sidePanel !== "event" && (
                  <span className="new-badge">{store.newCounts.event > 99 ? "99+" : store.newCounts.event}</span>
                )}
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
  if (item.kind === "elicitation") return `输入请求: ${item.message}`;
  if (item.kind === "clarification") return `需求澄清: ${item.questions.length} 个问题`;
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

    case "elicitation":
      return (
        <ElicitationCard
          item={item}
          showAuthor={showAuthor}
          onContextMenu={onContextMenu}
          menuEl={menuEl}
          selectModal={selectModal}
          currentMatchClass={currentMatchClass}
        />
      );

    case "clarification":
      return (
        <ClarificationCard
          item={item}
          showAuthor={showAuthor}
          onContextMenu={onContextMenu}
          menuEl={menuEl}
          selectModal={selectModal}
          currentMatchClass={currentMatchClass}
        />
      );

    default:
      return null;
  }
}

function ClarificationCard({
  item,
  showAuthor,
  onContextMenu,
  menuEl,
  selectModal,
  currentMatchClass,
}: {
  item: Extract<ChatItem, { kind: "clarification" }>;
  showAuthor: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  menuEl: ReactNode;
  selectModal: ReactNode;
  currentMatchClass: string;
}) {
  const store = useHubStore();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const resolved = item.answered !== null;
  const expired = item.expiresAt !== undefined && item.expiresAt < Date.now();
  const spec = store.requirementSpecs.find((s) => s.id === item.specId) ?? store.currentSpec;
  const specStatus = spec && spec.id === item.specId ? spec.status : undefined;
  const STATUS_LABEL: Record<string, string> = { draft: "草稿", clarifying: "澄清中", accepted: "已接受", superseded: "已废弃", cancelled: "已取消" };

  const submit = async () => {
    const payload = item.questions
      .map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" }))
      .filter((a) => a.answer.trim().length > 0);
    if (payload.length === 0) return;
    setSubmitting(true);
    try { await store.answerClarification(item.clarificationRequestId, payload); } finally { setSubmitting(false); }
  };

  return (
    <div className={`message permission ${currentMatchClass}`} onContextMenu={onContextMenu}>
      <div className="msg-body">
        <div className="permission-head">
          <HelpCircle size={14} />
          {showAuthor && item.author ? `${item.author} · ` : ""}需求澄清
          <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>
            spec v{item.specVersion}
          </span>
          {specStatus && (
            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-dim)" }}>
              · {STATUS_LABEL[specStatus] ?? specStatus}
            </span>
          )}
        </div>
        {resolved ? (
          <div className="subtitle">已处理：{item.answered === "answered" ? "已回答" : item.answered === "skipped" ? "已跳过" : "已取消"}</div>
        ) : expired ? (
          <div className="subtitle">已过期</div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {item.questions.map((q, i) => (
                <div key={q.id} style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined, paddingTop: i > 0 ? 6 : 0 }}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>
                    [{q.dimension}] 问题 {i + 1}
                  </div>
                  <div className="text" style={{ marginBottom: 4 }}>{q.text}</div>
                  <textarea
                    style={{ width: "100%", minHeight: 48, padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg, #1e1e1e)", color: "var(--text)", resize: "vertical" }}
                    placeholder="输入回答…"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="permission-actions" style={{ marginTop: 8 }}>
              <button disabled={submitting} onClick={() => void submit()}>
                {submitting ? "提交中…" : "提交回答"}
              </button>
              {item.canSkip && (
                <button
                  className="secondary"
                  disabled={submitting}
                  onClick={async () => { setSubmitting(true); try { await store.skipClarification(item.clarificationRequestId); } finally { setSubmitting(false); } }}
                >
                  跳过
                </button>
              )}
              <button
                className="secondary"
                disabled={submitting}
                onClick={async () => { setSubmitting(true); try { await store.cancelClarification(item.clarificationRequestId); } finally { setSubmitting(false); } }}
              >
                取消
              </button>
            </div>
          </>
        )}
      </div>
      {menuEl}
      {selectModal}
    </div>
  );
}

function ElicitationCard({
  item,
  showAuthor,
  onContextMenu,
  menuEl,
  selectModal,
  currentMatchClass,
}: {
  item: Extract<ChatItem, { kind: "elicitation" }>;
  showAuthor: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  menuEl: ReactNode;
  selectModal: ReactNode;
  currentMatchClass: string;
}) {
  const store = useHubStore();
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() => {
    const init: Record<string, ElicitationValue> = {};
    for (const f of item.fields) {
      if (f.defaultValue !== undefined) init[f.name] = f.defaultValue;
      else if (f.type === "boolean") init[f.name] = false;
      else if (f.type === "array") init[f.name] = [];
      else init[f.name] = "";
    }
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const resolved = item.answered !== null;

  const satisfied = (f: ElicitationField): boolean => {
    const v = values[f.name];
    switch (f.type) {
      case "boolean":
        return typeof v === "boolean";
      case "array":
        return Array.isArray(v) && v.length > 0;
      case "number":
        return v !== "" && v !== undefined && !Number.isNaN(Number(v));
      case "integer":
        return v !== "" && v !== undefined && Number.isInteger(Number(v));
      default:
        return typeof v === "string" && v.trim().length > 0;
    }
  };
  const canSubmit = item.fields.every((f) => !f.required || satisfied(f));

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "4px 6px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid var(--border)",
    background: "var(--bg, #1e1e1e)",
    color: "var(--text)",
  };

  const setValue = (name: string, v: ElicitationValue) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  const submit = async () => {
    if (!canSubmit) return;
    const content: Record<string, ElicitationValue> = {};
    for (const f of item.fields) {
      const v = values[f.name];
      if (v === undefined || v === "") continue;
      if (f.type === "integer") {
        const n = Number(v);
        if (Number.isInteger(n)) content[f.name] = n;
      } else if (f.type === "number") {
        const n = Number(v);
        if (!Number.isNaN(n)) content[f.name] = n;
      } else {
        content[f.name] = v;
      }
    }
    setSubmitting(true);
    try { store.answerElicitation(item.requestId, "accept", content); } finally { setSubmitting(false); }
  };

  const renderField = (f: ElicitationField) => {
    const v = values[f.name];
    if (f.type === "boolean") {
      return (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={v === true}
            onChange={(e) => setValue(f.name, e.target.checked)}
          />
          {f.label}
        </label>
      );
    }
    if (f.type === "array") {
      const selected = Array.isArray(v) ? v : [];
      if (!f.options?.length) {
        return (
          <input
            style={inputStyle}
            value={selected.join(",")}
            placeholder="逗号分隔多个值"
            onChange={(e) => setValue(f.name, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
          />
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {f.options.map((o) => (
            <label key={o.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={(e) =>
                  setValue(
                    f.name,
                    e.target.checked
                      ? [...selected, o.value]
                      : selected.filter((s) => s !== o.value),
                  )
                }
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    if (f.type === "number" || f.type === "integer") {
      return (
        <input
          type="number"
          step={f.type === "integer" ? 1 : "any"}
          style={inputStyle}
          value={typeof v === "number" ? String(v) : String(v ?? "")}
          onChange={(e) => setValue(f.name, e.target.value)}
        />
      );
    }
    if (f.options?.length) {
      return (
        <select
          style={inputStyle}
          value={typeof v === "string" ? v : ""}
          onChange={(e) => setValue(f.name, e.target.value)}
        >
          <option value="">（请选择）</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        style={inputStyle}
        value={typeof v === "string" ? v : ""}
        onChange={(e) => setValue(f.name, e.target.value)}
      />
    );
  };

  return (
    <div className={`message permission ${currentMatchClass}`} onContextMenu={onContextMenu}>
      <div className="msg-body">
        <div className="permission-head">
          <NotebookText size={14} />
          {showAuthor && item.author ? `${item.author} · ` : ""}输入请求
        </div>
        <div className="text">{item.message}</div>
        {resolved ? (
          <div className="subtitle">
            {item.answered === "accepted" ? "已提交" : item.answered === "declined" ? "已拒绝" : "已取消"}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {item.fields.map((f) => (
                <div key={f.name}>
                  {f.type !== "boolean" && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>
                      {f.label}
                      {f.required ? " *" : ""}
                    </div>
                  )}
                  {f.description && (
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>
                      {f.description}
                    </div>
                  )}
                  {renderField(f)}
                </div>
              ))}
            </div>
            <div className="permission-actions" style={{ marginTop: 8 }}>
              <button disabled={submitting || !canSubmit} onClick={() => void submit()}>
                {submitting ? "提交中…" : "提交"}
              </button>
              <button
                className="secondary"
                disabled={submitting}
                onClick={() => store.answerElicitation(item.requestId, "decline")}
              >
                拒绝
              </button>
            </div>
          </>
        )}
      </div>
      {menuEl}
      {selectModal}
    </div>
  );
}

function BlackboardPanel({ blackboard }: { blackboard: BlackboardInfo[] | null }) {
  const store = useHubStore();
  const roomId = store.currentRoom?.roomId;
  const [detail, setDetail] = useState<BlackboardInfo | null>(null);
  const [copied, setCopied] = useState(false);
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
              <span className="blackboard-from">@{store.sessionName(e.from)}</span>
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
              <span className="blackboard-from">@{store.sessionName(detail.from)}</span>
              <span className="blackboard-time">{formatArtifactTime(detail.at)}</span>
            </div>
            <pre>{detail.detail}</pre>
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  store.quoteBlackboard(detail);
                  setDetail(null);
                }}
              >
                引用
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(detail.detail || detail.text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "已复制" : "复制"}
              </button>
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
  const { progress, tasks, phase } = flow;
  if (tasks.length === 0) return null;
  const title = roomMode === "conductor" ? "指挥编排" : "编排进度";
  const phaseLabel: Record<string, string> = {
    planning: "规划中",
    working: "执行中",
    summarizing: "汇总中",
    "awaiting-retry": "等待重试",
    done: "已完成",
  };
  const phaseTag = phaseLabel[phase] ?? "";
  const showRetry = phase === "awaiting-retry";
  const content = (
    <div className="flow-tasks">
      {tasks.map((t) => (
        <FlowTaskItem key={t.id} task={t} showRetry={showRetry} />
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
          {phaseTag && <span className="flow-phase-tag">{phaseTag}</span>}
        </span>
        <span className="flow-progress">
          {progress.done}/{progress.total} 完成 · {progress.running} 进行中 · {progress.pending} 待执行
          {progress.failed > 0 ? ` · ${progress.failed} 失败` : ""}
          {progress.verifying ? ` · ${progress.verifying} 验证中` : ""}
        </span>
        {phase !== "done" && phase !== "summarizing" && (
          <button
            className="flow-cancel-btn"
            title="中断当前编排"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("确认中断当前编排？所有进行中的任务将被取消。")) {
                void useHubStore.getState().cancelFlow();
              }
            }}
          >
            <X size={12} /> 中断
          </button>
        )}
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
            <span className="artifact-author">@{store.sessionName(a.author)}</span>
            <span className="artifact-time">{formatArtifactTime(a.at)}</span>
            <span className="artifact-path" title={a.path ?? a.alias ?? a.id}>{a.path ?? a.alias ?? a.id}</span>
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
              {e.path ?? ""}{e.summary && (!e.path || !e.summary.includes(e.path)) ? ` · ${e.summary}` : ""}
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

function QualitySummaryView({ q, onApprove, onReject, isRoom }: { q: QualitySummary; onApprove?: () => void; onReject?: () => void; isRoom?: boolean }) {
  const label = qualityStageLabel(q.stage);
  const fixInfo = q.stage === "fixing" ? ` (${q.fixRound}/${q.maxFixRounds})` : "";
  const checkInfo = q.passedChecks + q.failedChecks > 0 ? ` · L1 ${q.passedChecks}通过 ${q.failedChecks}失败` : "";
  const findingInfo = q.findings > 0 ? ` · ${q.findings} findings${q.blockingFindings > 0 ? ` (${q.blockingFindings} blocking)` : ""}` : "";
  const failLabel = qualityFailureLabel(q.failureCode);
  const guide = actionGuide(q.stage, q.failureCode, isRoom);
  return (
    <div className="quality-summary">
      <div className="quality-summary-line">
        <Shield size={11} /> {label}{fixInfo}{checkInfo}{findingInfo}
        {q.enforcement !== "require-pass" && <span className="quality-enforcement-tag">{q.enforcement}</span>}
      </div>
      {failLabel && <div className="quality-summary-fail">{failLabel}</div>}
      {guide && <div className="quality-summary-guide">💡 {guide}</div>}
      {q.awaitingApproval && onApprove && onReject && (
        <div className="quality-approval-buttons">
          <button onClick={onApprove}><Check size={11} /> 批准</button>
          <button className="secondary" onClick={onReject}><X size={11} /> 拒绝</button>
        </div>
      )}
    </div>
  );
}

function QualityRunDetail({ runId, onApprove, onReject }: { runId: string; onApprove: () => void; onReject: () => void }) {
  const [data, setData] = useState<{ checks: QualityCheck[]; findings: QualityFinding[]; verifications: RequirementVerification[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const client = useHubStore((s) => s.client);
  useEffect(() => {
    if (!runId || !client) return;
    setLoading(true);
    (async () => {
      try {
        const resp = await client.call("quality.run.get", { id: runId }) as Record<string, unknown>;
        setData({
          checks: ((resp.checks as unknown[] | undefined) ?? []) as QualityCheck[],
          findings: ((resp.findings as unknown[] | undefined) ?? []) as QualityFinding[],
          verifications: ((resp.verifications as unknown[] | undefined) ?? []) as RequirementVerification[],
        });
      } catch { /* ignore */ } finally { setLoading(false); }
    })();
  }, [runId, client]);
  void onApprove; void onReject;
  if (loading) return <div className="quality-detail-loading">加载中…</div>;
  if (!data) return null;
  const failedChecks = data.checks.filter((c) => c.status !== "passed");
  const blockingFindings = data.findings.filter((f) => f.blocking);
  return (
    <div className="quality-run-detail">
      {failedChecks.length > 0 && (
        <div className="quality-detail-section">
          <div className="quality-detail-section-title">失败检查（{failedChecks.length}）</div>
          {failedChecks.map((c) => (
            <div key={c.id} className="quality-detail-check">
              <span className="quality-detail-check-status">✗</span>
              <code className="quality-detail-check-id">{c.checkId}</code>
              {c.summary && <div className="quality-detail-check-summary">{c.summary.slice(0, 200)}</div>}
            </div>
          ))}
        </div>
      )}
      {blockingFindings.length > 0 && (
        <div className="quality-detail-section">
          <div className="quality-detail-section-title">阻断发现（{blockingFindings.length}）</div>
          {blockingFindings.map((f) => (
            <div key={f.id} className="quality-detail-finding">
              <span className="quality-detail-finding-sev">[{f.severity}]</span>
              <span className="quality-detail-finding-claim">{f.claim}</span>
              {f.file && <code className="quality-detail-finding-loc">{f.file}{f.line ? `:${f.line}` : ""}</code>}
            </div>
          ))}
        </div>
      )}
      {data.verifications.length > 0 && (
        <div className="quality-detail-section">
          <div className="quality-detail-section-title">L3 需求验证（{data.verifications.length}）</div>
          {data.verifications.map((v) => (
            <div key={v.id} className="quality-detail-verif">
              <span className={`quality-detail-verif-status quality-detail-verif-${v.status}`}>{v.status === "passed" ? "✓" : v.status === "failed" ? "✗" : "⚠"}</span>
              <code className="quality-detail-verif-id">{v.criterionId}</code>
              <span className="quality-detail-verif-method">{v.method}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QualityStatusBar({ quality, store }: { quality: QualitySummary; store: { qualityRunAction: (id: string, action: "cancel" | "approve" | "reject" | "retry") => Promise<void>; saveRequirementVerificationPolicy: (projectId: string, patch: { requirements?: { mode?: "off" | "suggest" | "require" | "require-high-risk"; maxQuestions?: number }; verification?: { mode?: "off" | "suggest" | "require-evidence" } }) => Promise<void>; sessionProjectId: string | null; sessionPolicy: QualityPolicyInfo | null; loadSessionProjectPolicy: () => Promise<void> } }) {
  const [expanded, setExpanded] = useState(false);
  const isTerminal = TERMINAL_STAGES.has(quality.stage);
  const label = qualityStageLabel(quality.stage);
  const fixInfo = quality.stage === "fixing" ? ` (${quality.fixRound}/${quality.maxFixRounds})` : "";
  const checkInfo = quality.passedChecks + quality.failedChecks > 0
    ? ` · L1 ${quality.passedChecks}/${quality.passedChecks + quality.failedChecks}`
    : "";
  const failLabel = qualityFailureLabel(quality.failureCode);
  const guide = actionGuide(quality.stage, quality.failureCode);
  const icon = quality.stage === "accepted" ? <Check size={13} />
    : quality.stage === "failed" ? <ShieldAlert size={13} />
    : quality.stage === "inconclusive" ? <ShieldAlert size={13} />
    : quality.awaitingApproval ? <ShieldAlert size={13} />
    : <Shield size={13} />;
  const handleApprove = async () => { try { await store.qualityRunAction(quality.runId, "approve"); } catch { /* ignore */ } };
  const handleReject = async () => { try { await store.qualityRunAction(quality.runId, "reject"); } catch { /* ignore */ } };
  const handleViewEvidence = () => {
    useHubStore.setState({ qualityRunId: quality.runId, screen: "quality" });
  };
  return (
    <div className="quality-status-bar" onClick={() => setExpanded(!expanded)} style={{ cursor: "pointer" }}>
      <div className="quality-status-bar-main">
        {icon}
        <span>{label}{fixInfo}{checkInfo}</span>
        {failLabel && <span className="quality-status-fail">{failLabel}</span>}
        {quality.awaitingApproval && (
          <span className="quality-approval-inline" onClick={(e) => e.stopPropagation()}>
            <button onClick={handleApprove}><Check size={11} /> 批准</button>
            <button className="secondary" onClick={handleReject}><X size={11} /> 拒绝</button>
          </span>
        )}
        {!isTerminal && !quality.awaitingApproval && <span className="quality-status-hint">点击查看详情</span>}
      </div>
      {expanded && (
        <div className="quality-status-detail" onClick={(e) => e.stopPropagation()}>
          <QualitySummaryView q={quality} onApprove={handleApprove} onReject={handleReject} />
          <QualityRunDetail runId={quality.runId} onApprove={handleApprove} onReject={handleReject} />
          <RequirementQuickToggle store={store} />
          {guide && <div className="quality-status-guide">💡 {guide}</div>}
          <button className="quality-status-evidence-link" onClick={handleViewEvidence}>查看完整证据 →</button>
          <div className="quality-status-runid">run: {quality.runId}</div>
        </div>
      )}
    </div>
  );
}

function RequirementQuickToggle({ store }: { store: { saveRequirementVerificationPolicy: (projectId: string, patch: { requirements?: { mode?: "off" | "suggest" | "require" | "require-high-risk"; maxQuestions?: number }; verification?: { mode?: "off" | "suggest" | "require-evidence" } }) => Promise<void>; sessionProjectId: string | null; sessionPolicy: QualityPolicyInfo | null; loadSessionProjectPolicy: () => Promise<void> } }) {
  const projectId = store.sessionProjectId;
  const policy = store.sessionPolicy;
  const [reqMode, setReqMode] = useState(policy?.version === 2 ? (policy.policy as QualityPolicyV2).requirements.mode : "off");
  const [verMode, setVerMode] = useState(policy?.version === 2 ? (policy.policy as QualityPolicyV2).verification.mode : "off");
  const [maxQ, setMaxQ] = useState(policy?.version === 2 ? (policy.policy as QualityPolicyV2).requirements.maxQuestions : 3);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (projectId && !policy) void store.loadSessionProjectPolicy();
  }, [projectId, policy]);
  useEffect(() => {
    if (policy?.version === 2) {
      const v2 = policy.policy as QualityPolicyV2;
      setReqMode(v2.requirements.mode);
      setVerMode(v2.verification.mode);
      setMaxQ(v2.requirements.maxQuestions);
    }
  }, [policy]);
  if (!projectId || !policy || policy.version !== 2) return null;
  const v2 = policy.policy as QualityPolicyV2;
  const inputStyle: React.CSSProperties = { padding: "2px 4px", fontSize: 11, borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg, #1e1e1e)", color: "var(--text)" };
  const labelStyle: React.CSSProperties = { fontSize: 10, color: "var(--text-dim)", marginBottom: 2 };
  const dirty = reqMode !== v2.requirements.mode || verMode !== v2.verification.mode || maxQ !== v2.requirements.maxQuestions;
  const save = async () => {
    setSaving(true);
    try {
      await store.saveRequirementVerificationPolicy(projectId, {
        requirements: { mode: reqMode, maxQuestions: maxQ },
        verification: { mode: verMode },
      });
    } finally { setSaving(false); }
  };
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6, fontSize: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>需求/验证快捷配置</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div>
          <div style={labelStyle}>需求模式</div>
          <select style={inputStyle} value={reqMode} onChange={(e) => setReqMode(e.target.value as "off" | "suggest" | "require" | "require-high-risk")}>
            <option value="off">关闭</option>
            <option value="suggest">建议</option>
            <option value="require">强制</option>
            <option value="require-high-risk">仅高风险</option>
          </select>
        </div>
        <div>
          <div style={labelStyle}>验证模式</div>
          <select style={inputStyle} value={verMode} onChange={(e) => setVerMode(e.target.value as "off" | "suggest" | "require-evidence")}>
            <option value="off">关闭</option>
            <option value="suggest">建议</option>
            <option value="require-evidence">要求证据</option>
          </select>
        </div>
        <div>
          <div style={labelStyle}>最大提问数</div>
          <input type="number" min={0} style={inputStyle} value={maxQ} onChange={(e) => setMaxQ(Number(e.target.value))} />
        </div>
      </div>
      {dirty && (
        <button style={{ marginTop: 4, fontSize: 11 }} disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
      )}
    </div>
  );
}

function SpecSummaryCard({ spec, runId, stage }: { spec: RequirementSpec; runId: string; stage: string }) {
  const [expanded, setExpanded] = useState(true);
  const STATUS_LABEL: Record<string, string> = { draft: "草稿", clarifying: "澄清中", accepted: "已接受", superseded: "已废弃", cancelled: "已取消" };
  const isTerminal = TERMINAL_STAGES.has(stage as QualitySummary["stage"]);
  const stageLabel = stage ? qualityStageLabel(stage as QualitySummary["stage"]) : "";
  return (
    <div className="quality-status-bar" style={{ cursor: "pointer", background: "var(--bg-elevated, #1a1a2e)" }} onClick={() => setExpanded(!expanded)}>
      <div className="quality-status-bar-main">
        <NotebookText size={13} />
        <span>需求规格 · spec {spec.id.slice(0, 8)} v{spec.version}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{STATUS_LABEL[spec.status] ?? spec.status}</span>
        {stageLabel && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>· {stageLabel}{isTerminal ? "（终态）" : ""}</span>}
        <span className="quality-status-hint">{expanded ? "收起" : "展开"}</span>
      </div>
      {expanded && (
        <div className="quality-status-detail" onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 12 }}>
            <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>目标</div>
            <div>{spec.goal || "（未设置）"}</div>
          </div>
          {spec.acceptanceCriteria.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>验收标准（{spec.acceptanceCriteria.length} 条）</div>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {spec.acceptanceCriteria.map((c) => (
                  <li key={c.id}>
                    {c.required ? "★ " : "○ "}{c.description}
                    <span style={{ color: "var(--text-dim)" }}> · {c.evidenceMode} · {c.expectedEvidence.length} 证据</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {spec.constraints.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>约束</div>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {spec.constraints.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {spec.risks.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <div style={{ color: "var(--text-dim)", fontSize: 11, marginBottom: 2 }}>风险</div>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {spec.risks.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
          {runId && <div className="quality-status-runid" style={{ marginTop: 6 }}>run: {runId}</div>}
        </div>
      )}
    </div>
  );
}

function FlowTaskItem({ task, showRetry }: { task: FlowTask; showRetry: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const store = useHubStore();
  const statusIcon =
    task.status === "done" ? (
      <Check size={12} />
    ) : task.status === "running" ? (
      <Loader2 size={12} className="spin" />
    ) : task.status === "verifying" ? (
      <Shield size={12} />
    ) : task.status === "failed" ? (
      <X size={12} />
    ) : (
      <Circle size={11} />
    );
  const hasDetail = task.output || task.failureMessage || task.dependsOn.length > 0 || task.retries || task.quality;
  const handleRetry = async () => {
    const client = store.client;
    const roomId = store.currentRoom?.roomId;
    if (!client || !roomId) return;
    try {
      await client.call("room.retryTasks", { roomId, taskIds: [task.id] });
    } catch { /* ignore */ }
  };
  const handleApprove = async () => {
    if (!task.qualityRunId) return;
    try { await store.qualityRunAction(task.qualityRunId, "approve"); } catch { /* ignore */ }
  };
  const handleReject = async () => {
    if (!task.qualityRunId) return;
    try { await store.qualityRunAction(task.qualityRunId, "reject"); } catch { /* ignore */ }
  };
  const isFixing = task.quality?.stage === "fixing";
  const showRetryBtn = showRetry && task.status === "failed" && !isFixing;
  return (
    <div className={`flow-task flow-task-${task.status}`}>
      <span className={`flow-task-status flow-status-${task.status}`}>{statusIcon}</span>
      <div className="flow-task-body">
        <div className="flow-task-line" onClick={() => hasDetail && setExpanded(!expanded)} style={hasDetail ? { cursor: "pointer" } : undefined}>
          <span className="flow-task-name">@{task.name}</span>
          <span className="flow-task-desc" title={task.task}>{task.task}</span>
          {task.status === "verifying" && task.qualityRunId && (
            <span className="flow-task-badge">
              {task.quality
                ? compactQualityProgress(task.quality.stage, task.quality.fixRound, task.quality.maxFixRounds, task.quality.passedChecks, task.quality.failedChecks, task.quality.awaitingApproval) ?? "验证中"
                : "验证中"}
            </span>
          )}
          {task.retries && task.retries > 0 && (
            <span className="flow-task-badge">重试 {task.retries}</span>
          )}
          {hasDetail && (
            <span className="flow-task-expand">{expanded ? "▾" : "▸"}</span>
          )}
        </div>
        {expanded && hasDetail && (
          <div className="flow-task-detail">
            {task.dependsOn.length > 0 && (
              <div className="flow-task-meta">依赖: {task.dependsOn.join(", ")}</div>
            )}
            {task.output && (
              <div className="flow-task-output">{task.output}</div>
            )}
            {task.failureMessage && (
              <div className="flow-task-error">{task.failureMessage}</div>
            )}
            {task.quality && (
              <div className="flow-task-quality">
                <QualitySummaryView q={task.quality} onApprove={handleApprove} onReject={handleReject} isRoom />
                {task.qualityRunId && (
                  <button
                    className="quality-status-evidence-link"
                    onClick={() => useHubStore.setState({ qualityRunId: task.qualityRunId, screen: "quality" })}
                  >
                    查看完整证据 →
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {showRetryBtn && (
          <button className="flow-task-retry-btn" onClick={handleRetry}>
            <RotateCcw size={11} /> 重试
          </button>
        )}
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

function formatQuotaReset(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const [selectedTiers, setSelectedTiers] = useState<string[]>([]);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);

  const isRoom = !!store.currentRoom;
  const memberModels = store.roomMemberModels;
  const selectedMember = store.selectedMemberSession;

  useEffect(() => {
    setFilter(store.modelFilter);
  }, [store.modelFilter]);

  // 群聊模式切换成员时清空 tier/vendor 筛选（模型列表已换为成员后端）
  useEffect(() => {
    if (isRoom) {
      setSelectedTiers([]);
      setSelectedVendors([]);
    }
  }, [selectedMember, isRoom]);

  const costOrder = ["Free", "Low cost", "Med cost", "High cost"];
  const availableVendors = useMemo(
    () => [...new Set(store.modelList.map((m) => m.vendor).filter(Boolean))].sort(),
    [store.modelList],
  );
  const availableTiers = useMemo(
    () =>
      [...new Set(store.modelList.map((m) => m.costTier).filter(Boolean))].sort(
        (a, b) => costOrder.indexOf(a) - costOrder.indexOf(b),
      ),
    [store.modelList],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let models = store.modelList;

    // 按后端过滤（仅单聊模式，群聊已按成员后端加载）
    if (!isRoom && selectedBackend !== "all") {
      models = models.filter(m => m.backend === selectedBackend);
    }
    // 按费用层级过滤（多选，单聊/群聊通用）
    if (selectedTiers.length > 0) {
      models = models.filter((m) => selectedTiers.includes(m.costTier));
    }
    // 按供应商过滤（多选，单聊/群聊通用）
    if (selectedVendors.length > 0) {
      models = models.filter((m) => selectedVendors.includes(m.vendor));
    }

    // 按搜索词过滤
    if (q) {
      models = models.filter(
        (m) =>
          m.uid.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q) ||
          m.family.toLowerCase().includes(q) ||
          m.vendor.toLowerCase().includes(q) ||
          m.aliases.some((a) => a.toLowerCase().includes(q)),
      );
    }

    return models;
  }, [filter, store.modelList, selectedBackend, selectedTiers, selectedVendors, isRoom]);

  const hasFilters =
    filter.trim() !== "" || selectedBackend !== "all" || selectedTiers.length > 0 || selectedVendors.length > 0;
  const clearFilters = () => {
    setFilter("");
    setSelectedBackend("all");
    setSelectedTiers([]);
    setSelectedVendors([]);
  };
  const toggleIn = (list: string[], v: string, setList: (next: string[]) => void) =>
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  // 按后端分组（仅单聊模式）
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
    openclaw: "OpenClaw",
    custom: "自定义",
  };

  const handleSwitch = (m: ModelInfo) => {
    if (isRoom && selectedMember) {
      void store.switchModelForMember(selectedMember, m);
    } else {
      void store.switchModel(m);
    }
  };

  return (
    <div className="model-picker-backdrop" onClick={store.closeModelPicker}>
      <div className="model-picker" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{S.modelListTitle} · {store.modelCurrent}</span>
          <span style={{ display: "flex", gap: "0.25rem" }}>
            <button
              className="icon-btn"
              onClick={() => {
                if (isRoom && selectedMember) void store.refreshModelListForMember(selectedMember);
                else void store.refreshModelList();
                void store.refreshBackendQuota(true);
              }}
              title="刷新"
            >
              <RotateCcw size={14} />
            </button>
            <button className="icon-btn" onClick={store.closeModelPicker} title="关闭">
              <X size={15} />
            </button>
          </span>
        </div>
        <div className="model-picker-search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            placeholder={S.modelFilterHint}
          />
        </div>
        {isRoom ? (
          // 群聊模式：成员标签栏
          <div className="model-picker-backends">
            {Object.entries(memberModels).map(([sid, info]) => (
              <button
                key={sid}
                className={selectedMember === sid ? "active" : ""}
                onClick={() => store.selectMemberForModel(sid)}
                title={info.backend}
              >
                @{info.name}
              </button>
            ))}
          </div>
        ) : (
          // 单聊模式：后端标签栏
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
        )}
        {(() => {
          const q = store.backendQuota;
          const pickerBackend = isRoom
            ? memberModels[selectedMember ?? ""]?.backend
            : store.currentSession?.agent;
          if (pickerBackend !== "devin" || !q?.available) return null;
          const windows = [
            ["今日已用", q.daily],
            ["本周已用", q.weekly],
          ] as const;
          return (
            <div className="quota-card">
              <div className="quota-card-title">
                Devin 用量{q.planName ? ` · ${q.planName}` : ""}
              </div>
              {windows.map(([label, w]) => w && (
                <div className="quota-row" key={label}>
                  <span className="quota-label">{label}</span>
                  <span className="quota-bar"><span style={{ width: `${w.usedPercent}%` }} /></span>
                  <span className="quota-pct">{w.usedPercent}%</span>
                  {w.resetAtUnix && <span className="quota-reset">重置 {formatQuotaReset(w.resetAtUnix)}</span>}
                </div>
              ))}
            </div>
          );
        })()}
        {(availableTiers.length > 1 || availableVendors.length > 1) && (
          <div className="model-picker-filters">
            {availableTiers.length > 1 && (
              <div className="model-picker-chip-row">
                {availableTiers.map((tier) => (
                  <button
                    key={tier}
                    className={`model-chip ${selectedTiers.includes(tier) ? "active" : ""}`}
                    onClick={() => toggleIn(selectedTiers, tier, setSelectedTiers)}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            )}
            {availableVendors.length > 1 && (
              <div className="model-picker-chip-row">
                {availableVendors.map((vendor) => (
                  <button
                    key={vendor}
                    className={`model-chip ${selectedVendors.includes(vendor) ? "active" : ""}`}
                    onClick={() => toggleIn(selectedVendors, vendor, setSelectedVendors)}
                  >
                    {vendor}
                  </button>
                ))}
              </div>
            )}
            {hasFilters && (
              <button className="model-picker-clear" onClick={clearFilters}>
                {S.modelClearFilters}
              </button>
            )}
          </div>
        )}
        <div className="model-picker-list">
          {filtered.length === 0 && <div className="empty">{S.modelNoResults}</div>}
          {isRoom ? (
            // 群聊模式：直接列表（已按成员后端过滤）
            filtered.map((m) => (
              <div
                key={m.uid}
                className={`model-option ${m.isCurrent ? "active" : ""}`}
                onClick={() => handleSwitch(m)}
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
            ))
          ) : (
            // 单聊模式：按后端分组
            Object.entries(groupedByBackend).map(([backend, models]) => (
              <div key={backend} className="model-backend-group">
                <div className="model-backend-name">{backendNames[backend] || backend}</div>
                {models.map((m) => (
                  <div
                    key={m.uid}
                    className={`model-option ${m.isCurrent ? "active" : ""}`}
                    onClick={() => handleSwitch(m)}
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
            ))
          )}
        </div>
      </div>
    </div>
  );
}
