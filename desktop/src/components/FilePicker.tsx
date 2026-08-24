import { useEffect, useRef, useState } from "react";
import { FileCode, FolderTree, Search, X } from "lucide-react";
import type { FileTreeRoot, FileTreeNode } from "../hub/types";
import { useHubStore } from "../hub/store";

interface FilePickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}

interface FileNode extends FileTreeRoot, FileTreeNode {
  children?: FileNode[];
  expanded?: boolean;
}

export function FilePicker({ open, onClose, onSelect }: FilePickerProps) {
  const store = useHubStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isRoom = !!store.currentRoom;
  const contextId = store.currentRoom?.roomId ?? store.currentSession?.sessionId;

  // 加载文件列表
  const loadFiles = async (path: string) => {
    const client = store.client;
    if (!client || !contextId) return;

    setLoading(true);
    try {
      let nodes: FileNode[] = [];
      if (path) {
        const method = isRoom ? "room.file.list" : "session.file.list";
        const params = isRoom ? { roomId: contextId, path } : { sessionId: contextId, path };
        const result = await client.call(method, params) as { nodes?: FileTreeNode[] };
        nodes = (result.nodes ?? []).map(n => ({ ...n, kind: n.kind ?? "file" } as FileNode));
      } else {
        const method = isRoom ? "room.file.roots" : "session.file.roots";
        const params = isRoom ? { roomId: contextId } : { sessionId: contextId };
        const result = await client.call(method, params) as { roots?: FileTreeRoot[] };
        nodes = (result.roots ?? []).map(n => ({ ...n, kind: "dir" } as FileNode));
      }
      setFiles(nodes);
      setSelectedIndex(0);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setCurrentPath("");
      setSearchQuery("");
      loadFiles("");
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    loadFiles(currentPath);
  }, [currentPath]);

  // 过滤文件
  const filteredFiles = searchQuery
    ? files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  // 面包屑路径
  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const breadcrumbPaths = breadcrumbs.map((_, i) => breadcrumbs.slice(0, i + 1).join("/"));

  // 键盘导航
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % filteredFiles.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + filteredFiles.length) % filteredFiles.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredFiles[selectedIndex];
      if (selected) handleSelect(selected);
    } else if (e.key === "Escape") {
      onClose();
    } else if (e.key === "Backspace" && !searchQuery) {
      e.preventDefault();
      if (currentPath) {
        const parentPath = currentPath.split("/").slice(0, -1).join("/");
        setCurrentPath(parentPath);
      }
    }
  };

  const handleSelect = (file: FileNode) => {
    const isDir = file.kind === "dir";
    const newPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    if (isDir) {
      setCurrentPath(newPath);
      setSearchQuery("");
    } else {
      onSelect(file.path);
      onClose();
    }
  };

  const handleBreadcrumbClick = (path: string) => {
    setCurrentPath(path);
    setSearchQuery("");
  };

  // 滚动到选中项
  useEffect(() => {
    const selectedEl = listRef.current?.children[selectedIndex] as HTMLElement;
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  return (
    <div className="file-picker-backdrop" onClick={onClose}>
      <div className="file-picker" onClick={e => e.stopPropagation()} onKeyDown={onKeyDown} tabIndex={0}>
        <div className="file-picker-header">
          <div className="file-picker-title">选择文件</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="file-picker-search">
          <Search size={16} className="search-icon" />
          <input
            ref={searchRef}
            type="text"
            placeholder="搜索文件..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="file-picker-breadcrumbs">
          <button
            className={!currentPath ? "breadcrumb active" : "breadcrumb"}
            onClick={() => handleBreadcrumbClick("")}
          >
            根目录
          </button>
          {breadcrumbs.map((crumb, i) => (
            <button
              key={i}
              className={breadcrumbPaths[i] === currentPath ? "breadcrumb active" : "breadcrumb"}
              onClick={() => handleBreadcrumbClick(breadcrumbPaths[i])}
            >
              {crumb}
            </button>
          ))}
        </div>

        <div className="file-picker-body" ref={listRef}>
          {loading ? (
            <div className="file-picker-loading">加载中...</div>
          ) : filteredFiles.length === 0 ? (
            <div className="file-picker-empty">
              {searchQuery ? "未找到匹配的文件" : "此目录为空"}
            </div>
          ) : (
            filteredFiles.map((file, i) => {
              const isDir = file.kind === "dir";
              return (
                <div
                  key={file.path}
                  className={`file-picker-item ${i === selectedIndex ? "selected" : ""}`}
                  onClick={() => handleSelect(file)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <span className="file-icon">
                    {isDir ? <FolderTree size={16} /> : <FileCode size={16} />}
                  </span>
                  <span className="file-name">{file.name}</span>
                  {isDir && <span className="file-arrow">›</span>}
                </div>
              );
            })
          )}
        </div>

        <div className="file-picker-footer">
          <div className="shortcut-hint">
            <span>↑↓ 选择</span>
            <span>Enter 确认</span>
            <span>Esc 关闭</span>
            <span>Backspace 返回</span>
          </div>
        </div>
      </div>
    </div>
  );
}