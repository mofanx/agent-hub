import { useEffect, useState } from "react";
import { useHubStore } from "../hub/store";

type FileTreeRoot = {
  name: string;
  path: string;
  kind: string;
  sessionId?: string;
};

type FileTreeNode = {
  name: string;
  path: string;
  kind: string;
  at: number;
  size?: number;
};

type FileGetResult = {
  text?: string;
  data?: string;
  name?: string;
  mime?: string;
};

export function FileTreePanel({
  contextId,
  isSession,
  onClose,
}: {
  contextId: string;
  isSession: boolean;
  onClose: () => void;
}) {
  const store = useHubStore();
  const [roots, setRoots] = useState<FileTreeRoot[]>([]);
  const [nodes, setNodes] = useState<FileTreeNode[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [rootName, setRootName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    load();
  }, [contextId, isSession, store.client]);

  const openFile = async (filePath: string) => {
    const client = store.client;
    if (!client) return;
    try {
      const params: Record<string, unknown> = { path: filePath };
      if (isSession) params.sessionId = contextId;
      else params.roomId = contextId;
      const result = (await client.call("file.get", params)) as FileGetResult;
      const name = result.name ?? filePath.split("/").pop() ?? "download";
      if (typeof result.text === "string") {
        const blob = new Blob([result.text], { type: result.mime ?? "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      } else if (typeof result.data === "string") {
        const bytes = new Uint8Array(
          atob(result.data)
            .split("")
            .map((c) => c.charCodeAt(0)),
        );
        const blob = new Blob([bytes], { type: result.mime ?? "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      alert(`下载失败：${e}`);
    }
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

  return (
    <div className="file-tree-panel">
      <div className="file-tree-header">
        <h4 title={rootName ?? undefined}>{rootName ?? "项目文件"}</h4>
        <div className="file-tree-actions">
          <button
            className="secondary tiny"
            onClick={() => load(currentPath ?? undefined)}
            disabled={loading}
          >
            刷新
          </button>
          <button className="secondary tiny" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      {currentPath && (
        <div className="file-tree-up" onClick={up}>
          ↑ 返回上级
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
            >
              <span className="file-tree-icon">📁</span>
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
              className="file-tree-item"
              onClick={() => (n.kind === "dir" ? load(n.path) : openFile(n.path))}
            >
              <span className="file-tree-icon">{n.kind === "dir" ? "📁" : "🗎"}</span>
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
    </div>
  );
}
