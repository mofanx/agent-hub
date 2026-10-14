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
  Download,
  Ellipsis,
  Eye,
  FileCode,
  FolderTree,
  ImagePlus,
  LifeBuoy,
  ListTodo,
  Loader2,
  NotebookText,
  Package,
  Pencil,
  Plus,
  Quote,
  RotateCcw,
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
import { stringsFor, type Strings } from "../hub/strings";
import type { ArtifactInfo, BlackboardInfo, ChatItem, ElicitationField, ElicitationValue, EventInfo, FileTreeNode, FileTreeRoot, FlowArtifact, FlowInfo, FlowTask, TokenUsage, ContextUsage, ModelInfo } from "../hub/types";
import { FileTreePanel } from "./FileTreePanel";
import { Avatar, agentColorClass } from "../components/Avatar";
import { FilePicker } from "../components/FilePicker";
import { modeLabel } from "./session-shared";

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

function formatTokenUsage(u: TokenUsage, S: Strings): string {
  const parts = [`${S.tokenInput} ${formatNumber(u.inputTokens)} · ${S.tokenOutput} ${formatNumber(u.outputTokens)}`];
  if (u.cachedReadTokens) parts.push(`${S.tokenCached} ${formatNumber(u.cachedReadTokens)}`);
  if (u.cachedWriteTokens) parts.push(`${S.tokenCachedWrite} ${formatNumber(u.cachedWriteTokens)}`);
  if (u.thoughtTokens) parts.push(`${S.tokenThought} ${formatNumber(u.thoughtTokens)}`);
  parts.push(`${S.tokenTotal} ${formatNumber(u.totalTokens)}`);
  return parts.join(" · ");
}

function formatContextUsage(u: ContextUsage, S: Strings): string {
  const max = u.size > 0 ? ` / ${S.contextMax} ${formatNumber(u.size)}` : "";
  const parts = [`${S.context} ${formatNumber(u.used)}${max}`];
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
  const S = stringsFor(store.lang);
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
  const [replyHelp, setReplyHelp] = useState<{ helpId: string; name: string; taskId: string; question: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialScrolledRef = useRef(false);

  const isRoom = !!store.currentRoom;
  const title = store.currentRoom?.name || store.currentSession?.name || S.chatFallback;
  const roomModeLabel = store.currentRoom ? modeLabel(S, store.currentRoom.mode) : undefined;
  const subModeLabel =
    store.currentRoom?.subMode && store.currentRoom.subMode !== store.currentRoom.mode
      ? modeLabel(S, store.currentRoom.subMode)
      : undefined;
  const subtitle = store.currentRoom
    ? (roomModeLabel ?? store.currentRoom.mode)
    : store.currentSession
      ? store.displayName(store.currentSession)
      : "";
  const activeSessionId = store.currentRoom?.activeSpeaker || store.currentSession?.sessionId || "";
  const contextUsage = activeSessionId ? store.sessionUsage[activeSessionId] : undefined;
  const quota = store.backendQuota;
  const hasDevinMember = store.currentRoom
    ? store.currentRoom.members.some(([sid]) => store.roomMemberModels[sid]?.backend === "devin")
    : store.currentSession?.agent === "devin";
  const quotaParts = quota?.available
    ? [
        quota.daily ? S.quotaDaily.replace("%s", String(quota.daily.usedPercent)) : "",
        quota.weekly ? S.quotaWeekly.replace("%s", String(quota.weekly.usedPercent)) : "",
      ].filter(Boolean)
    : [];
  const quotaSummary = hasDevinMember && quotaParts.length > 0 ? `Devin ${quotaParts.join(" · ")}` : "";

  const searchQuery = inChatSearchQuery.trim();
  const matchPositions = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    return store.chatItems
      .map((item, i) => (getItemText(item, S).toLowerCase().includes(q) ? i : -1))
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
        .map((item, i) => (getItemText(item, S).toLowerCase().includes(q) ? i : -1))
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
    if (isRoom) {
      store.sendRoomMessage(text, replyHelp ? { replyTo: replyHelp.helpId } : undefined);
      setReplyHelp(null);
    } else store.sendPrompt(text);
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
  const flowActive = isRoom && !!store.flow &&
    store.flow.phase !== "done" && store.flow.phase !== "awaiting-retry";
  const flowTaskCount = store.flow?.tasks?.length ?? 0;
  const flowCount = flowTaskCount > 0 ? flowTaskCount : (flowActive ? 1 : 0);
  const pendingUserHelps = flowActive
    ? (store.flow?.tasks.filter((t) => t.waitingFor === "user") ?? [])
    : [];

  useEffect(() => {
    if (
      replyHelp &&
      !store.flow?.tasks.some(
        (t) => t.waitingFor === "user" && t.waitingHelpId === replyHelp.helpId,
      ) &&
      !(
        store.flow?.phase === "awaiting-input" &&
        store.flow.clarificationId === replyHelp.helpId
      )
    ) {
      setReplyHelp(null);
    }
  }, [store.flow, replyHelp]);
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
            <div className="chat-title">
              <span className="chat-title-name">{title}</span>
              {isRoom && <span className="chat-title-count"> ({store.currentRoom?.members.length})</span>}
            </div>
            {isRoom ? (
              <>
                <div className="chat-meta">
                  {subtitle && <div className="chat-subtitle">{subtitle}</div>}
                  {subModeLabel && (
                    <div className="chat-usage chat-current-mode">
                      {S.modeCurrent.replace("%s", subModeLabel)}
                    </div>
                  )}
                  {quotaSummary && <div className="chat-usage chat-quota">{quotaSummary}</div>}
                </div>
                {contextUsage && <div className="chat-usage">{formatContextUsage(contextUsage, S)}</div>}
              </>
            ) : (
              <>
                {subtitle && <div className="chat-subtitle">{subtitle}</div>}
                {contextUsage && <div className="chat-usage">{formatContextUsage(contextUsage, S)}</div>}
                {quotaSummary && <div className="chat-usage">{quotaSummary}</div>}
              </>
            )}
          </div>
        ) : (
          <div className="chat-search-bar">
            <input
              ref={searchInputRef}
              value={inChatSearchQuery}
              onChange={(e) => setInChatSearchQuery(e.currentTarget.value)}
              placeholder={S.searchPlaceholder}
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
            <button className="icon-btn" onClick={prevMatch} disabled={chatSearchMatchCount === 0} title={S.prevMatchTitle}>
              <ChevronUp size={14} />
            </button>
            <button className="icon-btn" onClick={nextMatch} disabled={chatSearchMatchCount === 0} title={S.nextMatchTitle}>
              <ChevronDown size={14} />
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setSearchOpen(false);
                setInChatSearchQuery("");
                setChatSearchMatchIndex(-1);
              }}
              title={S.closeEscTitle}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {!searchOpen && (
          <>
            <button className="icon-btn" onClick={() => setSearchOpen(true)} title={S.searchChatTitle}>
              <Search size={15} />
            </button>
            <button
              className={`icon-btn ${sidePanel === "files" ? "active" : ""}`}
              onClick={() => setSidePanel(sidePanel === "files" ? null : "files")}
              title={S.filesPanelTitle}
            >
              <FolderTree size={15} />
            </button>
            <button
              className={`icon-btn ${isContextPanel ? "active" : ""}`}
              onClick={openContextPanel}
              title={S.contextPanelTitle}
            >
              <Activity size={15} />
              {newTotal > 0 && !isContextPanel && <span className="new-badge">{newTotal > 99 ? "99+" : newTotal}</span>}
            </button>
            <button className="secondary model-btn" onClick={() => void store.showModelPickerDialog()} title={S.switchModelTitle}>
              <Cpu size={13} />
              <span>{isRoom ? S.memberModelsLabel : (store.modelCurrent || S.modelFallback)}</span>
            </button>
            {store.currentRoom && (
              <button
                className="icon-btn"
                title={S.editRoomTitle}
                aria-label={S.editRoomTitle}
                onClick={() => store.openEditRoomDialog(store.currentRoom!)}
              >
                <Ellipsis size={15} />
              </button>
            )}
          </>
        )}
      </div>

      <div className="chat-body">
        <div className="chat-main">
          <div ref={messagesRef} className="chat-messages" onScroll={onMessagesScroll}>
            <div className="chat-column">
              {store.historyLoading && (
                <div className="history-loading">{S.loadMoreHistory}</div>
              )}
              {store.chatItems.map((item, i) => {
                const isQuoted = store.quote
                  ? (store.quote[0] === (item.author || S.meLabel) || store.quote[0] === "我") &&
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
                title={S.backToBottom}
                type="button"
              >
                <ArrowDown size={15} />
              </button>
            )}
          </div>

          <div className="compose-wrap">
            {pendingUserHelps.map((t) => (
              <div key={t.id} className="help-banner">
                <LifeBuoy size={13} />
                <span className="help-banner-text">
                  {S.helpAskFmt.replace("%s", t.name).replace("%s", t.id)}
                  {t.waitingQuestion ?? S.helpNeededFallback}
                </span>
                <span className="help-banner-hint">{S.helpBannerHint}</span>
                <button
                  className="help-banner-btn"
                  onClick={() => {
                    if (!t.waitingHelpId) return;
                    setReplyHelp({
                      helpId: t.waitingHelpId,
                      name: t.name,
                      taskId: t.id,
                      question: t.waitingQuestion ?? "",
                    });
                    inputRef.current?.focus();
                  }}
                >
                  {S.answerLabel}
                </button>
              </div>
            ))}
            {store.flow?.phase === "awaiting-input" &&
              store.flow.clarificationId &&
              (store.flow.clarificationQuestions?.length ?? 0) > 0 && (
                <div className="help-banner">
                  <LifeBuoy size={13} />
                  <div className="clarification-banner-text">
                    <div>{S.clarificationPending}</div>
                    {store.flow.clarificationQuestions!.map((q, i) => (
                      <div key={i}>{`${i + 1}. ${q}`}</div>
                    ))}
                  </div>
                  <span className="help-banner-hint">{S.clarificationSupplementHint}</span>
                  <button
                    className="help-banner-btn"
                    onClick={() => {
                      setReplyHelp({
                        helpId: store.flow!.clarificationId!,
                        name: "",
                        taskId: "",
                        question: store.flow!.clarificationQuestions!.join("；"),
                      });
                      inputRef.current?.focus();
                    }}
                  >
                    {S.clarificationReply}
                  </button>
                </div>
              )}
            {replyHelp && (
              <div className="quote-bar">
                <span className="subtitle">
                  {replyHelp.taskId
                    ? S.replyHelpFmt.replace("%s", replyHelp.name).replace("%s", replyHelp.taskId)
                    : `${S.clarificationReplying}：`}
                  {replyHelp.question.slice(0, 80)}
                </span>
                <button
                  className="icon-btn"
                  onClick={() => setReplyHelp(null)}
                  title={S.cancelReplyTitle}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            {store.quote && (
              <div className="quote-bar">
                <span className="subtitle">
                  {S.quoteLineFmt.replace("%s", store.quote[0]).replace("%s", store.quote[1].slice(0, 80))}
                </span>
                <button className="icon-btn" onClick={() => store.setQuote(null)} title={S.cancelQuoteTitle}>
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
              placeholder={
                isRoom ? (flowActive ? S.roomFlowPlaceholder : S.roomPlaceholder) : S.chatPlaceholder
              }
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
                          <div className="slash-group">{S.commandsGroupLabel}</div>
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
                {fileRef.loading && <div className="suggest-loading">{S.loadingDots}</div>}
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
                <>
                  {flowActive && (
                    <button
                      className="send-btn"
                      onClick={send}
                      disabled={!input.trim() && !store.pendingAttachments.length}
                      title={S.sendMergeTitleFmt.replace("%s", store.sendKey === "ctrl-enter" ? "Ctrl+Enter" : "Enter")}
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                  <button
                    className="send-btn danger"
                    onClick={store.stopCurrent}
                    title={S.stopGenerateTitle}
                  >
                    <Square size={14} />
                  </button>
                </>
              ) : (
                <button
                  className="send-btn"
                  onClick={send}
                  disabled={!input.trim() && !store.pendingAttachments.length}
                  title={S.sendTitleFmt.replace("%s", store.sendKey === "ctrl-enter" ? "Ctrl+Enter" : "Enter")}
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
                    <Plus size={12} style={{ color: "var(--muted)" }} /> {S.saveAsCommand}
                  </div>
                </div>
              )}

              <div className="compose-toolbar">
                <button className={`icon-btn ${cmdOpen ? "active" : ""}`} onClick={() => setCmdOpen(!cmdOpen)} title={S.quickCommandsTitle}>
                  <SlashSquare size={14} />
                </button>
                <button className="icon-btn" onClick={() => setFilePickerOpen(true)} title={S.pickFileRefTitle}>
                  <FileCode size={14} />
                </button>
                <button className="icon-btn" onClick={onPickImage} title={S.addImageTitle}>
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
                title={S.projectFiles}
                onClick={() => setSidePanel("files")}
              >
                <FolderTree size={14} />
              </button>
              {isRoom && (
                <>
                  <button
                    className={`icon-btn ${sidePanel === "flow" ? "active" : ""}`}
                    title={S.flowCountFmt.replace("%s", String(flowCount))}
                    disabled={flowCount === 0 && sidePanel !== "flow"}
                    onClick={() => setSidePanel("flow")}
                  >
                    <ListTodo size={14} />
                  </button>
                  <button
                    className={`icon-btn ${sidePanel === "blackboard" ? "active" : ""}`}
                    title={S.blackboardCountFmt.replace("%s", String(blackboardCount))}
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
                title={S.artifactCountFmt.replace("%s", String(artifactCount))}
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
                title={S.eventCountFmt.replace("%s", String(eventCount))}
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
              <button className="icon-btn" onClick={() => setSidePanel(null)} title={S.closePanelTitle}>
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
              <div className="subtitle">{S.binaryFileLabel}</div>
            )}
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setFilePreview(null)}>{S.close}</button>
              {filePreview.text != null && (
                <button onClick={() => navigator.clipboard.writeText(filePreview.text ?? "").catch(() => {})}>{S.copy}</button>
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
                {S.saveLabel}
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

function getItemText(item: ChatItem, S: Strings): string {
  if ("text" in item) return item.text;
  if (item.kind === "plan") return item.entries.join("\n");
  if (item.kind === "tool") return `[${item.title}] ${item.status}`;
  if (item.kind === "permission") return `${S.permissionRequestLabel}: ${item.title}`;
  if (item.kind === "elicitation") return `${S.elicitationRequestLabel}: ${item.message}`;
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
  const S = stringsFor(store.lang);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);
  const currentMatchClass = isCurrentMatch ? "current-match" : "";

  const canQuote = item.kind === "user" || item.kind === "assistant" || item.kind === "thought";

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const doCopy = () => {
    navigator.clipboard.writeText(getItemText(item, S)).catch(() => {});
    setMenu(null);
  };

  const doSelect = () => {
    setSelectOpen(true);
    setMenu(null);
  };

  const doQuote = () => {
    if (canQuote) store.setQuote([item.author || S.meLabel, getItemText(item, S)]);
    setMenu(null);
  };

  const menuEl = menu ? (
    <div
      className="message-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="message-menu-item" onClick={doCopy}>
        {S.copy}
      </div>
      <div className="message-menu-item" onClick={doSelect}>
        {S.selectText}
      </div>
      {canQuote && (
        <div className="message-menu-item" onClick={doQuote}>
          {S.quoting}
        </div>
      )}
    </div>
  ) : null;

  const selectModal = selectOpen ? (
    <div className="dialog-backdrop" onClick={() => setSelectOpen(false)}>
      <div className="dialog selection-modal" onClick={(e) => e.stopPropagation()}>
        <h4>{S.selectText}</h4>
        <pre>{getItemText(item, S)}</pre>
        <div className="form-row" style={{ justifyContent: "flex-end" }}>
          <button onClick={() => setSelectOpen(false)}>{S.close}</button>
        </div>
      </div>
    </div>
  ) : null;

  const usageText =
    item.kind === "assistant" && item.usage ? (
      <div>
        <span className="usage-pill">{formatTokenUsage(item.usage, S)}</span>
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

  const markdownHtml = (text: string) => (highlight ? highlightHtml(renderMarkdown(text, S), highlight) : renderMarkdown(text, S));

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
                {S.quoteLineFmt.replace("%s", item.quoteAuthor).replace("%s", item.quoteText?.slice(0, 80) ?? "")}
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
                {S.quoteLineFmt.replace("%s", item.quoteAuthor).replace("%s", item.quoteText?.slice(0, 80) ?? "")}
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
                {S.quoteLineFmt.replace("%s", item.quoteAuthor).replace("%s", item.quoteText?.slice(0, 80) ?? "")}
              </div>
            )}
            <button className="thought-toggle" onClick={onToggleThought}>
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {S.thoughtProcess}
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
              <ListTodo size={12} /> {S.plan}
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
              {item.author ? `[${item.author}] ` : ""}{S.errorLabel}: {highlight ? highlightText(item.text, highlight) : item.text}
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
              {showAuthor && item.author ? `${item.author} · ` : ""}{S.permissionRequestLabel}
            </div>
            <div className="text">
              {highlight ? highlightText(item.title, highlight) : item.title}
            </div>
            {item.answered ? (
              <div className="subtitle">{S.answeredFmt.replace("%s", item.answered)}</div>
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

    default:
      return null;
  }
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
  const S = stringsFor(store.lang);
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
            placeholder={S.multiValuePlaceholder}
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
          <option value="">{S.selectOptionParen}</option>
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
          {showAuthor && item.author ? `${item.author} · ` : ""}{S.elicitationRequestLabel}
        </div>
        <div className="text">{item.message}</div>
        {resolved ? (
          <div className="subtitle">
            {item.answered === "accepted" ? S.submittedLabel : item.answered === "declined" ? S.declinedStatus : S.cancelledStatus}
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
                {submitting ? S.submittingLabel : S.submitLabel}
              </button>
              <button
                className="secondary"
                disabled={submitting}
                onClick={() => store.answerElicitation(item.requestId, "decline")}
              >
                {S.declineLabel}
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
  const S = stringsFor(store.lang);
  const roomId = store.currentRoom?.roomId;
  const [detail, setDetail] = useState<BlackboardInfo | null>(null);
  const [copied, setCopied] = useState(false);
  if (!blackboard || blackboard.length === 0) {
    return <div className="context-empty">{S.noBoardEntries}</div>;
  }
  const onClear = async () => {
    if (!roomId) return;
    if (!window.confirm(S.confirmClearBoard)) return;
    await store.clearBlackboard(roomId);
  };
  const onRemove = async () => {
    if (!roomId || !detail) return;
    if (!window.confirm(S.confirmDeleteBoard)) return;
    await store.removeBlackboard(roomId, detail.id);
    setDetail(null);
  };
  return (
    <div className="context-content blackboard-list">
      <div className="context-content-header">
        <span className="context-content-title">{S.blackboardLabel}</span>
        <button className="context-action danger" onClick={onClear}>{S.clearLabel}</button>
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
            <h4>{S.boardSummaryTitle}</h4>
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
                {S.quoteLabel}
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(detail.detail || detail.text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? S.copied : S.copy}
              </button>
              <button onClick={() => setDetail(null)}>{S.close}</button>
              <button className="danger" onClick={onRemove}>{S.deleteLabel}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FlowPanel({ flow, roomMode, minimal = false }: { flow: FlowInfo | null; roomMode: string; minimal?: boolean }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("flowPanelCollapsed") === "1");
  useEffect(() => {
    localStorage.setItem("flowPanelCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);
  if (!flow) return null;
  const { progress, tasks, phase } = flow;
  if (tasks.length === 0 && phase === "done") return null;
  const title = roomMode === "conductor" ? S.flowTitleConductor : S.flowTitleDefault;
  const phaseLabel: Record<string, string> = {
    planning: S.phasePlanning,
    "awaiting-input": S.flowAwaitingInput,
    working: S.phaseWorking,
    reviewing: S.phaseReviewing,
    summarizing: S.phaseSummarizing,
    "awaiting-retry": S.phaseAwaitingRetry,
    done: S.phaseDone,
  };
  const phaseTag = phaseLabel[phase] ?? "";
  const showRetry = phase === "awaiting-retry";
  const content = (
    <>
      {flow.acceptanceCriteria && flow.acceptanceCriteria.length > 0 && (
        <div className="flow-acceptance">
          <div className="flow-acceptance-title">{S.flowAcceptanceTitle}</div>
          <div className="flow-acceptance-caution">{S.flowAcceptanceCaution}</div>
          <ol className="flow-acceptance-list">
            {flow.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </div>
      )}
      {phase === "done" && (
        <div className="flow-summary-card">
          <div className="flow-summary-title">{S.finalSummary}</div>
          <div className="flow-summary-line">{S.summaryCompleted.replace("%s", String(progress.done)).replace("%s", String(progress.total))}</div>
          {flow.supplements && flow.supplements.length > 0 && (
            <div className="flow-summary-line">{S.summaryAdopted.replace("%s", String(flow.supplements.length))}</div>
          )}
          <div className="flow-summary-line">
            {S.summaryVerified.replace("%s", String(tasks.reduce((n, t) => n + (t.verifications?.length ?? 0), 0)))}
          </div>
        </div>
      )}
      <div className="flow-tasks">
        {tasks.map((t) => (
          <FlowTaskItem key={t.id} task={t} showRetry={showRetry} />
        ))}
      </div>
      {flow.supplements && flow.supplements.length > 0 && (
        <div className="flow-supplements">
          {flow.supplements.map((s, i) => (
            <div key={i} className="flow-supplement" title={s}>
              📝 {S.supplementLabel}: {s}
            </div>
          ))}
        </div>
      )}
    </>
  );
  if (minimal) {
    return <div className="context-content">{content}</div>;
  }
  return (
    <div className="flow-panel">
      <div className="flow-header" onClick={() => setCollapsed(!collapsed)} title={S.collapseToggleTitle}>
        <span className="flow-title">
          {collapsed ? "▸ " : "▾ "}{title}
          {phaseTag && <span className="flow-phase-tag">{phaseTag}</span>}
        </span>
        {tasks.length > 0 && (
          <span className="flow-progress">
            {S.progressFmt.replace("%s", String(progress.done)).replace("%s", String(progress.total)).replace("%s", String(progress.running)).replace("%s", String(progress.pending))}
            {progress.failed > 0 ? S.failedSuffixFmt.replace("%s", String(progress.failed)) : ""}
          </span>
        )}
        {phase !== "done" && phase !== "summarizing" && phase !== "reviewing" && (
          <button
            className="flow-cancel-btn"
            title={S.abortFlowTitle}
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(S.confirmAbortFlow)) {
                void useHubStore.getState().cancelFlow();
              }
            }}
          >
            <X size={12} /> {S.abortLabel}
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
  const S = stringsFor(store.lang);
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
      alert(S.previewFailedFmt.replace("%s", String(e)));
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
      alert(S.downloadFailedFmt.replace("%s", String(e)));
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
    if (!window.confirm(S.confirmDeleteArtifactsFmt.replace("%s", String(list.length)).replace("%s", names))) return;
    await Promise.all(list.map((id) => store.removeArtifact(contextId, id)));
    setSelected(new Set());
    setManaging(false);
  };

  const onClearAll = async () => {
    if (!contextId) return;
    if (!window.confirm(S.confirmClearArtifacts)) return;
    await store.clearArtifacts(contextId);
    setSelected(new Set());
    setManaging(false);
    setActiveId(null);
  };

  const onRemoveActive = async () => {
    if (!contextId || !active) return;
    if (!window.confirm(S.confirmDeleteArtifactFmt.replace("%s", active.path ?? active.alias ?? active.id))) return;
    await store.removeArtifact(contextId, active.id);
    setActiveId(null);
  };

  const onQuote = () => active && store.quoteArtifact(active);
  const onPreview = () => active && handlePreview(active);
  const onDownload = () => active && handleDownload(active);

  const manageActions = (
    <div className="artifact-header-actions" onClick={(e) => e.stopPropagation()}>
      {!managing ? (
        <button className="context-action" onClick={() => { setManaging(true); setActiveId(null); }}>{S.manageLabel}</button>
      ) : (
        <>
          <button className="context-action danger" onClick={onClearAll}>{S.clearLabel}</button>
          <button className="context-action danger" onClick={onDeleteSelected} disabled={selected.size === 0}>
            {S.deleteSelected}{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button
            className="context-action"
            onClick={() => {
              setManaging(false);
              setSelected(new Set());
            }}
          >
            {S.doneLabel}
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
      <button className="artifact-action" title={S.quoteLabel} onClick={onQuote}><Quote size={12} /></button>
      <button className="artifact-action" title={S.previewLabel} onClick={onPreview}><Eye size={12} /></button>
      <button className="artifact-action" title={S.downloadLabel} onClick={onDownload}><Download size={12} /></button>
      <button className="artifact-action danger" title={S.deleteLabel} onClick={onRemoveActive}><Trash2 size={12} /></button>
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

  const countText = S.itemsCountFmt.replace("%s", String(artifacts.length));
  const listContent = artifacts.length > 0 ? list : <div className="context-empty">{S.noArtifacts}</div>;

  return (
    <>
      {minimal ? (
        <div className="context-content">
          <div className="context-content-header">
            <span className="context-content-title">{S.artifactsLabel}</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {activeToolbar}
          {listContent}
        </div>
      ) : (
        <div className="artifact-panel">
          <div className="artifact-header" onClick={() => setCollapsed(!collapsed)} title={S.collapseToggleTitle}>
            <span className="artifact-title">{collapsed ? "▸ " : "▾ "}{S.artifactsLabel}</span>
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
              <div className="subtitle">{S.binaryFileLabel}</div>
            )}
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => setPreview(null)}>{S.close}</button>
              {preview.text != null && (
                <button onClick={() => navigator.clipboard.writeText(preview.text ?? "").catch(() => {})}>{S.copy}</button>
              )}
              {preview.text != null ? (
                <button onClick={() => saveText(preview.name, preview.text ?? "")}>{S.saveLabel}</button>
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
                  {S.saveLabel}
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
  const S = stringsFor(store.lang);
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
    if (!window.confirm(S.confirmDeleteEventsFmt.replace("%s", String(list.length)))) return;
    await Promise.all(list.map((id) => store.removeEvent(contextId, id)));
    setSelected(new Set());
    setManaging(false);
  };

  const onClear = async () => {
    if (!contextId) return;
    const label = clearAction ? S.bracketNameFmt.replace("%s", eventLabel(S, clearAction)) : S.allLabel;
    if (!window.confirm(S.confirmClearEventsFmt.replace("%s", label))) return;
    await store.clearEvents(contextId, clearAction ?? undefined);
    setSelected(new Set());
    setManaging(false);
    setActiveId(null);
  };

  const onRemoveActive = async () => {
    if (!contextId || !active) return;
    if (!window.confirm(S.confirmDeleteEventFmt.replace("%s", active.summary))) return;
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
      title={S.clearEventTypeTitle}
    >
      <option value="">{S.clearAllEvents}</option>
      {actionOptions.map((a) => (
        <option key={a} value={a}>{S.clearOnlyFmt.replace("%s", eventLabel(S, a))}</option>
      ))}
    </select>
  );

  const manageActions = (
    <div className="artifact-header-actions" onClick={(e) => e.stopPropagation()}>
      {!managing ? (
        <>
          {clearMenu}
          <button className="context-action" onClick={onClear}>{S.clearLabel}</button>
          <button className="context-action" onClick={() => { setManaging(true); setActiveId(null); }}>{S.manageLabel}</button>
        </>
      ) : (
        <>
          <button className="context-action danger" onClick={onDeleteSelected} disabled={selected.size === 0}>
            {S.deleteSelected}{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
          <button
            className="context-action"
            onClick={() => {
              setManaging(false);
              setSelected(new Set());
            }}
          >
            {S.doneLabel}
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
      <button className="artifact-action" title={S.quoteLabel} onClick={onQuote}><Quote size={12} /></button>
      <button className="artifact-action danger" title={S.deleteLabel} onClick={onRemoveActive}><Trash2 size={12} /></button>
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
              {eventLabel(S, e.action)} · {e.oldPath ? `${e.oldPath} → ` : ""}
              {e.path ?? ""}{e.summary && (!e.path || !e.summary.includes(e.path)) ? ` · ${e.summary}` : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  const countText = S.itemsCountFmt.replace("%s", String(events.length));
  const listContent = events.length > 0 ? list : <div className="context-empty">{S.noEvents}</div>;

  return (
    <>
      {minimal ? (
        <div className="context-content">
          <div className="context-content-header">
            <span className="context-content-title">{S.eventsLabel}</span>
            <span className="artifact-count">{countText}</span>
            {manageActions}
          </div>
          {activeToolbar}
          {listContent}
        </div>
      ) : (
        <div className="artifact-panel">
          <div className="artifact-header" onClick={() => setCollapsed(!collapsed)} title={S.collapseToggleTitle}>
            <span className="artifact-title">{collapsed ? "▸ " : "▾ "}{S.eventsLabel}</span>
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

function eventLabel(S: Strings, action?: string): string {
  if (action === "delete") return S.eventActionDelete;
  if (action === "rename") return S.eventActionRename;
  if (action === "command") return S.eventActionCommand;
  if (action === "test") return S.eventActionTest;
  if (action === "add") return S.eventActionAdd;
  if (action === "modify") return S.eventActionModify;
  return S.eventActionDefault;
}

function renderMarkdown(text: string, S: Strings): string {
  try {
    const html = marked.parse(text, { gfm: true }) as string;
    const withScrollableTables = html
      .replace(/<table([^>]*)>/g, '<div class="table-wrap"><table$1>')
      .replace(/<\/table>/g, "</table></div>");
    return withScrollableTables
      .replace(
        /<pre><code/g,
        `<div class="code-block"><button class="copy-code" title="${S.copy}" onclick='const n=this.nextElementSibling;if(n){navigator.clipboard.writeText(n.textContent).catch(()=>{});this.textContent="${S.copied}";setTimeout(()=>this.textContent="${S.copy}",1500)}'>${S.copy}</button><pre><code`,
      )
      .replace(/<\/code><\/pre>/g, "</code></pre></div>");
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
  }
}

function FlowTaskItem({ task, showRetry }: { task: FlowTask; showRetry: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const store = useHubStore();
  const S = stringsFor(store.lang);
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
  const hasDetail =
    task.status === "done" ||
    task.output ||
    task.failureMessage ||
    task.dependsOn.length > 0 ||
    task.retries ||
    task.waitingQuestion ||
    (task.verifications?.length ?? 0) > 0 ||
    (task.backendRuns?.length ?? 0) > 0;
  const verdicts = (task.verifications ?? []).map((v) => v.verdict.trim().toLowerCase());
  const derivedStatus =
    verdicts.length === 0 ? "unverified" : verdicts.some((v) => v !== "pass") ? "member_nonpass" : "member_pass";
  const verificationStatus =
    task.verificationStatus === "unverified" ||
    task.verificationStatus === "member_pass" ||
    task.verificationStatus === "member_nonpass"
      ? task.verificationStatus
      : derivedStatus;
  const verificationText =
    verificationStatus === "member_pass"
      ? S.verificationStatusMemberPass
      : verificationStatus === "member_nonpass"
        ? S.verificationStatusMemberNonpass
        : S.verificationStatusUnverified;
  const ac = task.automaticCheck;
  const blockedDetail =
    ac?.reason === "check_unapproved"
      ? S.checkUnapproved
      : ac?.reason === "command_mismatch"
        ? S.checkCommandMismatch
        : ac?.reason && /^[a-z_]+$/.test(ac.reason)
          ? ac.reason
          : undefined;
  const automaticCheckText =
    ac?.status === "exited_zero"
      ? S.automaticCheckExitedZero
      : ac?.status === "exited_nonzero"
        ? ac.exitCode !== undefined
          ? S.automaticCheckExitedNonzero.replace("%s", String(ac.exitCode))
          : S.automaticCheckBlocked
        : ac?.status === "blocked"
          ? S.automaticCheckBlocked + (blockedDetail ? `（${blockedDetail}）` : "")
          : ac?.status === "timed_out"
            ? S.automaticCheckTimedOut
            : S.automaticCheckNotRun;
  const automaticCheckExtra = [
    ac?.snapshotHash && /^[0-9a-f]{64}$/.test(ac.snapshotHash)
      ? S.automaticCheckSnapshot.replace("%s", ac.snapshotHash.slice(0, 12))
      : null,
    ac?.snapshotCurrent === true ? S.snapshotCurrentTrue : null,
    ac?.stdoutTruncated || ac?.stderrTruncated ? S.automaticCheckTruncated : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const backendStatusText =
    task.backendClaimStatus === "matched"
      ? S.backendClaimMatchLabel
      : task.backendClaimStatus === "missing_member_command"
        ? S.backendStatusMissingCommand
        : task.backendClaimStatus === "missing_member_exit_code"
          ? S.backendStatusMissingExit
          : task.backendClaimStatus === "no_completed_backend_run"
            ? S.backendStatusNoRun
            : task.backendClaimStatus === "backend_exit_unknown"
              ? S.backendStatusUnknownExit
              : task.backendClaimStatus === "backend_mismatch"
                ? S.backendStatusMismatch
                : undefined;
  const handleRetry = async () => {
    const client = store.client;
    const roomId = store.currentRoom?.roomId;
    if (!client || !roomId) return;
    try {
      await client.call("room.retryTasks", { roomId, taskIds: [task.id] });
    } catch { /* ignore */ }
  };
  const showRetryBtn = showRetry && task.status === "failed";
  return (
    <div className={`flow-task flow-task-${task.status}`}>
      <span className={`flow-task-status flow-status-${task.status}`}>{statusIcon}</span>
      <div className="flow-task-body">
        <div className="flow-task-line" onClick={() => hasDetail && setExpanded(!expanded)} style={hasDetail ? { cursor: "pointer" } : undefined}>
          <span className="flow-task-name">@{task.name}</span>
          <span className="flow-task-desc" title={task.task}>{task.task}</span>
          {task.retries && task.retries > 0 && (
            <span className="flow-task-badge">{S.retryBadge.replace("%s", String(task.retries))}</span>
          )}
          {task.waitingFor && (
            <span
              className="flow-task-badge flow-badge-help"
              title={task.waitingQuestion ?? S.waitingHelpHint}
            >
              🆘 {task.waitingFor === "user" ? S.helpBadgeUser : S.helpBadgeMember.replace("%s", task.waitingFor)}
            </span>
          )}
          {hasDetail && (
            <span className="flow-task-expand">{expanded ? "▾" : "▸"}</span>
          )}
        </div>
        {expanded && hasDetail && (
          <div className="flow-task-detail">
            {task.status === "done" && (
              <>
                <div className="flow-task-meta">{S.verificationStatusLabel}{verificationText}</div>
                <div className="flow-task-meta">{S.automaticCheckLabel}{automaticCheckText}</div>
                {automaticCheckExtra && (
                  <div className="flow-task-meta">{automaticCheckExtra}</div>
                )}
                {ac?.snapshotCurrent === false && (
                  <div className="flow-task-error">{S.snapshotCurrentFalse}</div>
                )}
              </>
            )}
            {task.dependsOn.length > 0 && (
              <div className="flow-task-meta">{S.dependsOnLabel}{task.dependsOn.join(", ")}</div>
            )}
            {task.output && (
              <div className="flow-task-output">{task.output}</div>
            )}
            {(task.baseline || task.diff || task.reproSteps || task.verifyCommand || task.verifyCheckId) && (
              <details className="flow-task-deliverable">
                <summary className="flow-task-meta">{S.deliverableEvidence}</summary>
                {task.baseline && <pre className="flow-verify-output">{S.evidenceBaselineLabel}{task.baseline}</pre>}
                {task.diff && <pre className="flow-verify-output">{S.evidenceDiffLabel}{task.diff}</pre>}
                {task.reproSteps && task.reproSteps.length > 0 && (
                  <>
                    <div className="flow-verify-line">{S.evidenceReproStepsLabel}</div>
                    <ol className="flow-verify-steps">
                      {task.reproSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </>
                )}
                {(task.verifyCommand || task.verifyStdout || task.verifyStderr) && (
                  <div className="flow-verify-line">{S.memberReportedLabel}</div>
                )}
                {task.verifyCommand && (
                  <div className="flow-verify-line">
                    {S.verificationCommandLabel}{task.verifyCommand}
                    {task.verifyExitCode !== undefined ? S.verificationExitCodeSuffix.replace("%s", String(task.verifyExitCode)) : ""}
                  </div>
                )}
                {task.verifyStdout && <pre className="flow-verify-output">{`${S.evidenceStdoutLabel}\n${task.verifyStdout}`}</pre>}
                {task.verifyStderr && <pre className="flow-verify-output">{S.evidenceStderrLabel}{task.verifyStderr}</pre>}
                {task.verifyCheckId && (
                  <div className="flow-verify-line">{S.presetCheckRequested.replace("%s", task.verifyCheckId)}</div>
                )}
              </details>
            )}
            {task.waitingQuestion && (
              <div className="flow-task-help">
                {task.waitingFor === "user" ? S.helpRequestUser : S.helpRequestMember.replace("%s", task.waitingFor ?? "")}{task.waitingQuestion}
              </div>
            )}
            {task.verifications?.map((v, i) => (
              <details key={i} className="flow-task-verify">
                <summary className="flow-task-meta">
                  {S.verificationBy.replace("%s", v.by)}<span className="flow-verdict">{v.verdict}</span>
                  {v.evidence ? <span className="flow-verify-summary"> — {v.evidence}</span> : null}
                </summary>
                {v.backendToolCallId && (
                  <div className="flow-verify-line">{S.backendVerificationCall.replace("%s", v.backendToolCallId)}</div>
                )}
                {v.evidenceDetail && (
                  <div className="flow-verify-detail">
                    {v.evidenceDetail.summary && <div className="flow-verify-line">{S.evidenceSummaryLabel}{v.evidenceDetail.summary}</div>}
                    {(v.evidenceDetail.command || v.evidenceDetail.exitCode !== undefined || v.evidenceDetail.stdout || v.evidenceDetail.stderr) && (
                      <div className="flow-verify-line">{S.memberReportedLabel}</div>
                    )}
                    {v.evidenceDetail.command && (
                      <div className="flow-verify-line">{S.evidenceCommandLabel}{v.evidenceDetail.command}</div>
                    )}
                    {v.evidenceDetail.exitCode !== undefined && (
                      <div className="flow-verify-line">{S.evidenceExitCodeLabel}{v.evidenceDetail.exitCode}</div>
                    )}
                    {v.evidenceDetail.stdout && (
                      <pre className="flow-verify-output">{`${S.evidenceStdoutLabel}\n${v.evidenceDetail.stdout}`}</pre>
                    )}
                    {v.evidenceDetail.stderr && (
                      <pre className="flow-verify-output">{S.evidenceStderrLabel}{v.evidenceDetail.stderr}</pre>
                    )}
                    {v.evidenceDetail.baseline && (
                      <pre className="flow-verify-output">{S.evidenceBaselineLabel}{v.evidenceDetail.baseline}</pre>
                    )}
                    {v.evidenceDetail.diff && (
                      <pre className="flow-verify-output">{S.evidenceDiffLabel}{v.evidenceDetail.diff}</pre>
                    )}
                    {v.evidenceDetail.reproSteps && v.evidenceDetail.reproSteps.length > 0 && (
                      <>
                        <div className="flow-verify-line">{S.evidenceReproStepsLabel}</div>
                        <ol className="flow-verify-steps">
                          {v.evidenceDetail.reproSteps.map((s, j) => (
                            <li key={j}>{s}</li>
                          ))}
                        </ol>
                      </>
                    )}
                  </div>
                )}
              </details>
            ))}
            {((task.backendRuns?.length ?? 0) > 0 ||
              (task.verifyCommand !== undefined && backendStatusText !== undefined)) && (
              <div className="flow-verify-detail">
                <div className="flow-task-meta">{S.backendRunsLabel}</div>
                {(task.backendRuns ?? []).map((r, i) => (
                  <div key={i} className="flow-verify-line">
                    {r.toolCallId} ·{" "}
                    {r.status === "completed" ? S.backendRunCompleted : r.status === "failed" ? S.backendRunFailed : r.status}
                    {" · "}
                    {r.exitCode !== undefined ? `${S.evidenceExitCodeLabel}${r.exitCode}` : S.backendExitUnknown}
                  </div>
                ))}
                {backendStatusText !== undefined ? (
                  <div className="flow-verify-line">{backendStatusText}</div>
                ) : (
                  task.backendClaimMatch && (
                    <div className="flow-verify-line">{S.backendClaimMatchLabel}</div>
                  )
                )}
              </div>
            )}
            {task.failureMessage && (
              <div className="flow-task-error">{task.failureMessage}</div>
            )}
          </div>
        )}
        {showRetryBtn && (
          <button className="flow-task-retry-btn" onClick={handleRetry}>
            <RotateCcw size={11} /> {S.retryAction}
          </button>
        )}
        {task.artifacts.length > 0 && (
          <div className="flow-artifacts">
            {task.artifacts.map((a, i) => (
              <button
                key={i}
                className="flow-artifact"
                onClick={() => copyArtifact(S, a)}
                title={a.path ? S.copyPathHint.replace("%s", a.path) : S.copySummaryHint}
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

function copyArtifact(S: Strings, a: FlowArtifact) {
  const text = a.path ? `${a.path}\n${a.summary}` : a.summary;
  navigator.clipboard
    .writeText(text)
    .then(() => alert(S.copiedPathFmt.replace("%s", a.path || a.summary.slice(0, 40))))
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
    custom: S.customOpt,
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
              title={S.refreshTitle}
            >
              <RotateCcw size={14} />
            </button>
            <button className="icon-btn" onClick={store.closeModelPicker} title={S.close}>
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
              {S.allLabel}
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
            [S.quotaToday, q.daily],
            [S.quotaWeek, q.weekly],
          ] as const;
          return (
            <div className="quota-card">
              <div className="quota-card-title">
                {S.devinQuotaLabel}{q.planName ? ` · ${q.planName}` : ""}
              </div>
              {windows.map(([label, w]) => w && (
                <div className="quota-row" key={label}>
                  <span className="quota-label">{label}</span>
                  <span className="quota-bar"><span style={{ width: `${w.usedPercent}%` }} /></span>
                  <span className="quota-pct">{w.usedPercent}%</span>
                  {w.resetAtUnix && <span className="quota-reset">{S.quotaResetFmt.replace("%s", formatQuotaReset(w.resetAtUnix))}</span>}
                </div>
              ))}
            </div>
          );
        })()}
        {(() => {
          const targetSid = isRoom ? selectedMember : store.currentSession?.sessionId;
          const opts = store.sessionConfigOptions;
          if (!targetSid || opts.length === 0) return null;
          return (
            <div className="model-picker-filters">
              {opts.map((opt) => (
                <div className="model-picker-chip-row" key={opt.id} style={{ alignItems: "center" }}>
                  <span style={{ opacity: 0.6, fontSize: "0.8rem", marginRight: "0.25rem" }}>{opt.name}</span>
                  {(opt.options ?? []).map((o) => (
                    <button
                      key={o.value}
                      className={`model-chip ${opt.currentValue === o.value ? "active" : ""}`}
                      title={o.description ?? o.value}
                      onClick={() => void store.setSessionConfigOption(targetSid, opt.id, o.value)}
                    >
                      {o.name}
                    </button>
                  ))}
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
