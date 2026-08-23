import { useEffect, useState } from "react";
import { ArrowUp, FileText, Folder, RefreshCw, X } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { FileTreeRoot, FileTreeNode } from "../hub/types";

type FileGetResult = {
  text?: string;
  data?: string;
  name?: string;
  mime?: string;
};

const BINARY_EXTS = new Set([
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz",
  "exe", "dll", "so", "dylib", "app", "dmg", "apk", "ipa", "deb", "rpm", "pkg",
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "aac", "ogg",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
]);

const MAX_PREVIEW_SIZE = 5 * 1024 * 1024;

export function FileTreePanel({
  contextId,
  isSession,
  onClose,
  initialPath,
  onQuote,
  onPreview,
}: {
  contextId: string;
  isSession: boolean;
  onClose: () => void;
  initialPath?: string | null;
  onQuote?: (path: string) => void;
  onPreview?: (file: FileGetResult & { name: string }) => void;
}) {
  const store = useHubStore();
  const [roots, setRoots] = useState<FileTreeRoot[]>([]);
  const [nodes, setNodes] = useState<FileTreeNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [rootName, setRootName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileTreeRoot | FileTreeNode;
  } | null>(null);

  const load = async (path?: string) => {
    const client = store.client;
    if (!client) return;
    setLoading(true);
    try {
      if (path == null) {
        const method = isSession ? "session.file.roots" : "room.file.roots";
        const params = isSession ? { sessionId: contextId } : { roomId: contextId };
        const result = (await client.call(method, params)) as { roots?: FileTreeRoot[] };
        setRoots(result.roots ?? []);
        setNodes([]);
        setCurrentPath(null);
        setRootName(null);
        setRootPath(null);
      } else {
        const method = isSession ? "session.file.list" : "room.file.list";
        const params = isSession ? { sessionId: contextId, path } : { roomId: contextId, path };
        const result = (await client.call(method, params)) as { nodes?: FileTreeNode[] };
        setNodes(result.nodes ?? []);
        setCurrentPath(path);
      }
    } catch (e) {
      alert(`加载失败：${e}`);
    } finally {
      setLoading(false);
    }
  };

  const setRootFromPath = (path: string) => {
    const root = roots.find((r) => path === r.path || path.startsWith(r.path + "/"));
    if (root) {
      setRootName(root.name);
      setRootPath(root.path);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenu) setContextMenu(null);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, contextMenu]);

  useEffect(() => {
    load();
  }, [contextId, isSession, store.client]);

  useEffect(() => {
    if (initialPath && roots.length > 0) {
      setRootFromPath(initialPath);
      load(initialPath);
    }
  }, [initialPath, roots]);

  useEffect(() => {
    if (store.fileUpdateAt) {
      load(currentPath ?? undefined);
    }
  }, [store.fileUpdateAt]);

  const fetchFile = async (filePath: string): Promise<FileGetResult | null> => {
    const client = store.client;
    if (!client) return null;
    try {
      const params: Record<string, unknown> = { path: filePath };
      if (isSession) params.sessionId = contextId;
      else params.roomId = contextId;
      return (await client.call("file.get", params)) as FileGetResult;
    } catch (e) {
      alert(`读取失败：${e}`);
      return null;
    }
  };

  const saveBlob = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

  const canPreview = (node: FileTreeNode) => {
    if (node.size != null && node.size > MAX_PREVIEW_SIZE) return false;
    return !BINARY_EXTS.has(extOf(node.name));
  };

  const downloadFile = async (node: FileTreeNode) => {
    const res = await fetchFile(node.path);
    if (!res) return;
    const name = res.name ?? node.name;
    if (typeof res.text === "string") {
      const blob = new Blob([res.text], { type: res.mime ?? "text/plain;charset=utf-8" });
      saveBlob(name, blob);
    } else if (typeof res.data === "string") {
      const bytes = new Uint8Array(
        atob(res.data)
          .split("")
          .map((c) => c.charCodeAt(0)),
      );
      const blob = new Blob([bytes], { type: res.mime ?? "application/octet-stream" });
      saveBlob(name, blob);
    }
  };

  const previewFile = async (node: FileTreeNode) => {
    const res = await fetchFile(node.path);
    if (!res) return;
    const name = res.name ?? node.name;
    if (typeof res.text === "string") {
      onPreview?.({ ...res, name });
      return;
    }
    if (typeof res.data === "string" && res.mime?.startsWith("image/")) {
      onPreview?.({ ...res, name });
      return;
    }
    downloadFile(node);
  };

  const handleClick = (item: FileTreeRoot | FileTreeNode) => {
    setContextMenu(null);
    if (isFileNode(item)) {
      if (canPreview(item)) {
        previewFile(item);
      } else {
        downloadFile(item);
      }
    } else {
      load(item.path);
    }
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    item: FileTreeRoot | FileTreeNode,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  };

  const quote = (item: FileTreeRoot | FileTreeNode) => {
    onQuote?.(item.path + ("kind" in item && item.kind === "dir" ? "/" : ""));
    setContextMenu(null);
  };

  const remove = async (node: FileTreeNode) => {
    if (!window.confirm(`确认删除文件？\n${node.path}`)) return;
    await store.deleteFile(contextId, isSession, node.path);
    setContextMenu(null);
    load(currentPath ?? undefined);
  };

  const rename = async (node: FileTreeNode) => {
    const newName = window.prompt("重命名为", node.name);
    if (!newName || newName.trim() === node.name) return;
    const trimmed = newName.trim();
    const lastSep = Math.max(node.path.lastIndexOf("/"), node.path.lastIndexOf("\\"));
    const dir = lastSep >= 0 ? node.path.slice(0, lastSep) : "";
    const to = dir ? `${dir}/${trimmed}` : trimmed;
    await store.renameFile(contextId, isSession, node.path, to);
    setContextMenu(null);
    load(currentPath ?? undefined);
  };

  const up = () => {
    if (!currentPath) return;
    const parts = currentPath.split("/");
    if (parts.length <= 1 || currentPath === rootPath) {
      load(undefined);
      return;
    }
    const parent = parts.slice(0, -1).join("/");
    if (rootPath && parent.startsWith(rootPath)) load(parent);
    else load(undefined);
  };

  const formatSize = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
    return `${n} B`;
  };

  const formatTime = (at: number) => {
    const d = new Date(at);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    return isToday
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  };

  function isFileNode(item: FileTreeRoot | FileTreeNode): item is FileTreeNode & { kind: "file" } {
    return "kind" in item && item.kind === "file" && "at" in item;
  }

  function isDirNode(item: FileTreeRoot | FileTreeNode): item is FileTreeNode & { kind: "dir" } {
    return "kind" in item && item.kind === "dir" && "at" in item;
  }

  const menuFile = contextMenu && isFileNode(contextMenu.item) ? contextMenu.item : null;
  const menuDir = contextMenu && isDirNode(contextMenu.item) ? contextMenu.item : null;

  return (
    <div className="file-tree-panel" onClick={() => setContextMenu(null)}>
      <div className="file-tree-header">
        <h4 title={rootName ?? undefined}>{rootName ?? "项目文件"}</h4>
        <div className="file-tree-actions">
          <button
            className="icon-btn"
            onClick={() => load(currentPath ?? undefined)}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
      {currentPath && (
        <div className="file-tree-up" onClick={up}>
          <ArrowUp size={12} /> 返回上级
        </div>
      )}
      <div className="file-tree-list">
        {loading && <div className="file-tree-loading">加载中…</div>}
        {currentPath == null &&
          roots.map((r) => (
            <div
              key={`root:${r.path}`}
              className="file-tree-item"
              onClick={() => {
                setRootName(r.name);
                setRootPath(r.path);
                load(r.path);
              }}
              onContextMenu={(e) => handleContextMenu(e, r)}
            >
              <span className="file-tree-icon">
                <Folder size={14} />
              </span>
              <span className="file-tree-name" title={r.name}>
                {r.name}
              </span>
              <span className="file-tree-meta" title={r.path}>
                {r.path}
              </span>
            </div>
          ))}
        {currentPath != null &&
          nodes.map((n) => (
            <div
              key={`node:${n.path}`}
              className={`file-tree-item ${n.kind === "file" ? "file" : ""}`}
              onClick={() => handleClick(n)}
              onContextMenu={(e) => handleContextMenu(e, n)}
            >
              <span className="file-tree-icon">{n.kind === "dir" ? <Folder size={14} /> : <FileText size={14} />}</span>
              <span className="file-tree-name" title={n.name}>
                {n.name}
              </span>
              {n.size != null && (
                <span className="file-tree-meta">
                  {formatSize(n.size)} · {formatTime(n.at)}
                </span>
              )}
            </div>
          ))}
      </div>

      {contextMenu && (
        <div
          className="file-tree-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuDir && (
            <button onClick={() => { load(menuDir.path); setContextMenu(null); }}>
              进入
            </button>
          )}
          {menuFile && (
            <>
              <button onClick={() => { previewFile(menuFile); setContextMenu(null); }}>
                预览
              </button>
              <button onClick={() => { downloadFile(menuFile); setContextMenu(null); }}>
                下载
              </button>
              <button onClick={() => rename(menuFile)}>
                重命名
              </button>
              <button className="danger" onClick={() => remove(menuFile)}>
                删除
              </button>
            </>
          )}
          <button onClick={() => quote(contextMenu.item)}>
            引用到输入框
          </button>
          <button onClick={() => setContextMenu(null)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
