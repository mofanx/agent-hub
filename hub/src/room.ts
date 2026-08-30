import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RoomMode =
  | "mention"
  | "conductor"
  | "roundrobin"
  | "parallel"
  | "pipeline"
  | "debate"
  | "auto";

export type Room = {
  roomId: string;
  name: string;
  mode: RoomMode;
  conductorId?: string | undefined;
  members: { sessionId: string; name: string }[];
  /** 成员角色卡：sessionId -> roleId 或自定义 persona */
  memberRoles?: Record<string, string> | undefined;
  /** 轮询模式：当前轮到第几个成员 */
  roundRobinIndex?: number | undefined;
  /** 流水线模式：成员执行顺序，未设置则按 members 顺序 */
  pipelineOrder?: string[] | undefined;
  /** 辩论模式：正方/反方 sessionId */
  debateSides?: [string, string] | undefined;
  /** 辩论模式：裁判 sessionId */
  debateJudge?: string | undefined;
  /** 辩论模式：轮数 */
  debateRounds?: number | undefined;
  /** 并发模式：汇总者 sessionId */
  parallelSummarizerId?: string | undefined;
  archived?: boolean | undefined;
  /** 房间共享黑板 */
  blackboard?: BlackboardEntry[] | undefined;
  /** 房间文件产物登记处 */
  artifacts?: Artifact[] | undefined;
  /** 房间事件时间轴 */
  events?: RoomEvent[] | undefined;
};

export type RoomModeConfig = {
  conductorId?: string | undefined;
  parallelSummarizerId?: string | undefined;
  pipelineOrder?: string[] | undefined;
  debateSides?: [string, string] | undefined;
  debateJudge?: string | undefined;
  debateRounds?: number | undefined;
  memberRoles?: Record<string, string> | undefined;
};

export type BlackboardEntry = { id: string; from: string; text: string; detail: string; at: number };

const BLACKBOARD_LIMIT = 10;
const BLACKBOARD_OUTPUT_LEN = 400;

export type EventAction = "add" | "modify" | "delete" | "rename" | "command" | "test";

export type RoomEvent = {
  id: string;
  author: string;
  at: number;
  action: EventAction;
  summary: string;
  path?: string | undefined;
  oldPath?: string | undefined;
  taskId?: string | undefined;
};

export type Artifact = {
  id: string;
  alias?: string | undefined;
  author: string;
  at: number;
  summary: string;
  path?: string | undefined;
  taskId?: string | undefined;
};

/** 兼容旧 persistence 的混合条目，导入时拆分 */
type LegacyArtifact = Artifact & {
  kind?: "file" | "event";
  action?: string;
  oldPath?: string;
  command?: string;
  dependsOn?: string[];
};

const ARTIFACT_LIMIT = 50;
const ARTIFACT_PROMPT_LIMIT = 10;
const ARTIFACT_SUMMARY_LEN = 240;
const EVENT_LIMIT = 200;

const FILE_REF_LIMIT = 5;
const FILE_REF_CHAR_LIMIT = 10000;
const FILE_REF_TOTAL_LIMIT = 50000;

export function isEventAction(action: string | undefined): action is EventAction {
  return !!action && ["add", "modify", "delete", "rename", "command", "test"].includes(action);
}

const BASE_DIR = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const FILES_DIR = path.resolve(BASE_DIR, "../data/files");
const PROJECT_ROOT = path.resolve(BASE_DIR, "../..");
const WORKSPACE_ROOT = path.resolve(PROJECT_ROOT, "..");

const TEXT_EXTS = new Set([
  ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".toml",
  ".css", ".html", ".htm", ".xml", ".csv", ".log", ".sh", ".bash", ".zsh", ".fish",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".c", ".cpp", ".h",
  ".hpp", ".cs", ".php", ".pl", ".lua", ".sql", ".vim", ".cfg", ".ini", ".conf",
]);

function isWithin(parent: string, target: string): boolean {
  const rel = path.relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".txt": "text/plain", ".md": "text/markdown", ".ts": "text/x-typescript", ".tsx": "text/x-typescript",
    ".js": "text/javascript", ".jsx": "text/javascript", ".json": "application/json",
    ".yaml": "application/yaml", ".yml": "application/yaml", ".css": "text/css",
    ".html": "text/html", ".htm": "text/html", ".csv": "text/csv", ".xml": "application/xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

function isTextBuffer(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return false;
  }
  const decoded = buf.toString("utf-8");
  return !decoded.includes("\uFFFD");
}

export type FileResult =
  | { text: string; name: string; mime: string }
  | { data: string; name: string; mime: string };

function fileResultFromBuf(buf: Buffer, real: string): FileResult {
  const name = path.basename(real);
  const ext = path.extname(real);
  const mime = mimeFromExt(ext);
  if (TEXT_EXTS.has(ext) || isTextBuffer(buf)) {
    return { text: buf.toString("utf-8"), name, mime };
  }
  return { data: buf.toString("base64"), name, mime };
}

export type FileTreeRoot = {
  name: string;
  path: string;
  kind: "project" | "workspace" | "cwd";
  sessionId?: string;
};

export type FileTreeNode = {
  name: string;
  path: string;
  kind: "file" | "dir";
  at: number;
  size?: number;
};

const SKIP_NAMES = new Set([
  "node_modules", ".git", "__pycache__", "dist", "build", ".gradle", ".idea",
  ".next", "out", "coverage", ".nuxt", "target", "Debug", "Release", "bin", "obj",
]);

function shouldSkipFile(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIP_NAMES.has(name);
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private aliasSeqs = new Map<string, number>();
  private getPersona?: (roleId: string) => string | undefined;
  private getCwd?: (sessionId: string) => string | undefined;

  setRoleResolver(getPersona: (roleId: string) => string | undefined): void {
    this.getPersona = getPersona;
  }

  setCwdResolver(getCwd: (sessionId: string) => string | undefined): void {
    this.getCwd = getCwd;
  }

  create(
    name: string,
    members: { sessionId: string; name: string }[],
    mode: RoomMode = "mention",
    config?: RoomModeConfig,
  ): Room {
    const conductorId = config?.conductorId;
    if (mode === "conductor" || mode === "auto") {
      if (!conductorId || !members.some((m) => m.sessionId === conductorId)) {
        throw new Error(`${mode} room needs a valid conductorId`);
      }
    }
    if (conductorId && !members.some((m) => m.sessionId === conductorId)) {
      throw new Error("conductorId must be a member of the room");
    }
    const room: Room = {
      roomId: randomUUID().slice(0, 8),
      name,
      mode,
      conductorId,
      members,
      memberRoles: config?.memberRoles,
      roundRobinIndex: 0,
      parallelSummarizerId: config?.parallelSummarizerId,
      pipelineOrder: config?.pipelineOrder,
      debateSides: config?.debateSides,
      debateJudge: config?.debateJudge,
      debateRounds: config?.debateRounds,
      blackboard: [],
      artifacts: [],
      events: [],
    };
    this.rooms.set(room.roomId, room);
    this.aliasSeqs.set(room.roomId, 0);
    this.dedupMemberNames(room.roomId);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** 从持久化状态恢复：拆分旧 artifact、初始化黑板 */
  import(room: Room): void {
    const legacy: LegacyArtifact[] = (room.artifacts ?? []) as LegacyArtifact[];
    const artifacts: Artifact[] = [];
    const events: RoomEvent[] = [];
    for (const a of legacy) {
      if (a.kind === "file" || (!a.kind && a.path)) {
        artifacts.push({
          id: a.id,
          alias: a.alias,
          author: a.author,
          at: a.at,
          summary: a.summary,
          path: a.path,
          taskId: a.taskId,
        });
      } else if (a.kind === "event") {
        const action = a.action as EventAction;
        events.push({
          id: a.id,
          author: a.author,
          at: a.at,
          action: ["add", "modify", "delete", "rename", "command", "test"].includes(action) ? action : "command",
          summary: a.summary,
          path: a.path,
          oldPath: a.oldPath,
          taskId: a.taskId,
        });
      }
    }
    const resolveAuthor = (author: string) =>
      room.members.find((m) => m.sessionId === author || m.name === author)?.sessionId ?? author;
    for (const a of artifacts) a.author = resolveAuthor(a.author);
    for (const e of events) e.author = resolveAuthor(e.author);
    if (room.events) {
      for (const e of room.events) e.author = resolveAuthor(e.author);
    }
    room.artifacts = artifacts;
    room.events = room.events ?? events ?? [];
    room.blackboard = room.blackboard ?? [];
    for (let i = 0; i < room.artifacts.length; i++) {
      if (!room.artifacts[i]!.alias) {
        room.artifacts[i]!.alias = `a${i + 1}`;
      }
    }
    this.rooms.set(room.roomId, room);
    this.aliasSeqs.set(room.roomId, room.artifacts.length);
  }

  roomsFor(sessionId: string): Room[] {
    return [...this.rooms.values()].filter((r) =>
      r.members.some((m) => m.sessionId === sessionId),
    );
  }

  /** 从所有群移除该成员；指挥家被移除或成员不足 2 人时解散群。返回解散的 roomId */
  removeMember(sessionId: string): string[] {
    const dissolved: string[] = [];
    for (const room of [...this.rooms.values()]) {
      if (!room.members.some((m) => m.sessionId === sessionId)) continue;
      if ((room.mode === "conductor" || room.mode === "auto") && room.conductorId === sessionId) {
        this.rooms.delete(room.roomId);
        dissolved.push(room.roomId);
        continue;
      }
      room.members = room.members.filter((m) => m.sessionId !== sessionId);
      if (room.conductorId === sessionId) {
        room.conductorId = room.members[0]?.sessionId;
      }
      if (room.members.length < 2) {
        this.rooms.delete(room.roomId);
        dissolved.push(room.roomId);
      }
    }
    return dissolved;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  delete(roomId: string): boolean {
    return this.rooms.delete(roomId);
  }

  rename(roomId: string, name: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    room.name = name;
    return room;
  }

  archive(roomId: string, archived: boolean): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    room.archived = archived;
    return room;
  }

  update(
    roomId: string,
    name: string,
    members: { sessionId: string; name: string }[],
    mode: RoomMode,
    config?: RoomModeConfig,
  ): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    if (members.length === 0) throw new Error("room needs at least 1 member");
    const conductorId = config?.conductorId;
    if (mode === "conductor" || mode === "auto") {
      if (!conductorId || !members.some((m) => m.sessionId === conductorId)) {
        throw new Error(`${mode} room needs a valid conductorId`);
      }
    }
    if (conductorId && !members.some((m) => m.sessionId === conductorId)) {
      throw new Error("conductorId must be a member of the room");
    }
    room.name = name;
    room.mode = mode;
    room.members = members;
    room.memberRoles = config?.memberRoles;
    room.conductorId = conductorId;
    room.parallelSummarizerId = config?.parallelSummarizerId;
    room.pipelineOrder = config?.pipelineOrder;
    room.debateSides = config?.debateSides;
    room.debateJudge = config?.debateJudge;
    room.debateRounds = config?.debateRounds;
    this.dedupMemberNames(room.roomId);
    return room;
  }

  private dedupMemberNames(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const used = new Set<string>();
    for (const m of room.members) {
      let name = m.name;
      let attempt = 1;
      while (used.has(name)) {
        attempt++;
        const shortId = m.sessionId.slice(-4);
        name = `${m.name} (${shortId}${attempt > 2 ? `-${attempt}` : ""})`;
      }
      used.add(name);
      m.name = name;
    }
  }

  /** 解析 @mention，返回目标 sessionId 列表；无 mention 时返回全部成员 */
  route(roomId: string, text: string): { targets: string[]; mentioned: string[] } {
    const room = this.rooms.get(roomId);
    if (!room) return { targets: [], mentioned: [] };
    const mentioned = room.members
      .filter((m) => new RegExp(`@${m.name}(?![\\w-])`).test(text))
      .map((m) => m.sessionId);
    return {
      targets: mentioned.length > 0 ? mentioned : room.members.map((m) => m.sessionId),
      mentioned,
    };
  }

  /** 获取房间共享黑板 */
  getBlackboard(roomId: string): BlackboardEntry[] {
    const room = this.rooms.get(roomId);
    return [...(room?.blackboard ?? [])];
  }

  private nextAlias(roomId: string): string {
    const seq = (this.aliasSeqs.get(roomId) ?? 0) + 1;
    this.aliasSeqs.set(roomId, seq);
    return `a${seq}`;
  }

  memberName(roomId: string, sessionId: string): string {
    const room = this.rooms.get(roomId);
    return room?.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
  }

  private resolveMember(room: Room, author?: string): { sessionId: string; name: string } | undefined {
    if (!author) return undefined;
    return room.members.find((m) => m.sessionId === author || m.name === author);
  }

  /** 添加一个文件产物；同房间同 path 时更新已有条目 */
  addFile(
    roomId: string,
    file: Omit<Artifact, "id" | "at" | "alias"> & { content?: string | undefined },
  ): Artifact | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const list = (room.artifacts ??= []);
    const author = this.resolveMember(room, file.author)?.sessionId ?? file.author;
    if (file.path) {
      const existing = list.find((a) => a.path === file.path);
      if (existing) {
        existing.author = author;
        existing.summary = file.summary;
        existing.at = Date.now();
        if (file.taskId) existing.taskId = file.taskId;
        if (file.content && existing.path) {
          const fileName = path.basename(existing.path);
          const destDir = path.join(FILES_DIR, roomId, existing.id);
          try {
            fs.mkdirSync(destDir, { recursive: true });
            fs.writeFileSync(path.join(destDir, fileName), file.content, "utf-8");
          } catch {
            // 缓存写入失败不阻塞 artifact 更新
          }
        }
        // 移到末尾，保持数组顺序与时间顺序一致（getArtifacts 倒序后最新在前）
        list.splice(list.indexOf(existing), 1);
        list.push(existing);
        return existing;
      }
    }
    const item: Artifact = {
      ...file,
      author,
      id: randomUUID().slice(0, 8),
      alias: this.nextAlias(roomId),
      at: Date.now(),
    };
    if (file.content && item.path) {
      const fileName = path.basename(item.path);
      const destDir = path.join(FILES_DIR, roomId, item.id);
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(destDir, fileName), file.content, "utf-8");
      } catch {
        // 缓存写入失败不阻塞 artifact 注册
      }
    }
    list.push(item);
    if (list.length > ARTIFACT_LIMIT) list.shift();
    return item;
  }

  /** 添加一个事件到时间轴 */
  addEvent(roomId: string, event: Omit<RoomEvent, "id" | "at">): RoomEvent | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const list = (room.events ??= []);
    const author = this.resolveMember(room, event.author)?.sessionId ?? event.author;
    // 去重：同 (action, path, author) 的最后一条在 5 秒内则合并更新
    if (event.path) {
      const last = list.at(-1);
      if (last && last.action === event.action && last.path === event.path && last.author === author && Date.now() - last.at < 5000) {
        last.summary = event.summary;
        last.at = Date.now();
        return last;
      }
    }
    const item: RoomEvent = {
      ...event,
      author,
      id: randomUUID().slice(0, 8),
      at: Date.now(),
    };
    list.push(item);
    if (list.length > EVENT_LIMIT) list.shift();
    return item;
  }

  /** fs 写入事件：5 秒窗口内同路径的 modify 事件（tool_call edit 先到）被修正为准确 action，避免重复 */
  addFileEvent(roomId: string, event: Omit<RoomEvent, "id" | "at">): RoomEvent | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const list = (room.events ??= []);
    const author = this.resolveMember(room, event.author)?.sessionId ?? event.author;
    if (event.path) {
      const last = list.at(-1);
      if (last && last.action === "modify" && last.path === event.path && last.author === author && Date.now() - last.at < 5000) {
        last.action = event.action;
        last.summary = event.summary;
        last.at = Date.now();
        return last;
      }
    }
    return this.addEvent(roomId, event);
  }

  /** 兼容旧 API：根据 kind 分发到 addFile / addEvent */
  addArtifact(
    roomId: string,
    artifact: {
      kind: "file" | "event";
      author: string;
      summary: string;
      path?: string | undefined;
      oldPath?: string | undefined;
      taskId?: string | undefined;
      action?: string | undefined;
      content?: string | undefined;
      alias?: string | undefined;
    },
  ): Artifact | RoomEvent | undefined {
    if (artifact.kind === "file") {
      return this.addFile(roomId, {
        author: artifact.author,
        summary: artifact.summary,
        path: artifact.path,
        taskId: artifact.taskId,
        content: artifact.content,
      });
    }
    return this.addEvent(roomId, {
      author: artifact.author,
      action: isEventAction(artifact.action) ? artifact.action : "command",
      summary: artifact.summary,
      path: artifact.path,
      oldPath: artifact.oldPath,
      taskId: artifact.taskId,
    });
  }

  /** 获取房间文件产物列表（按时间倒序） */
  getArtifacts(roomId: string, limit = ARTIFACT_PROMPT_LIMIT): Artifact[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...(room.artifacts ?? [])].reverse().slice(0, limit);
  }

  /** 获取房间事件时间轴（按时间倒序） */
  getEvents(roomId: string, limit = EVENT_LIMIT): RoomEvent[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...(room.events ?? [])].reverse().slice(0, limit);
  }

  /** 从登记处移除某个产物（不删除磁盘文件） */
  removeArtifact(roomId: string, artifactId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.artifacts) return false;
    const before = room.artifacts.length;
    room.artifacts = room.artifacts.filter((a) => a.id !== artifactId);
    return room.artifacts.length < before;
  }

  /** 清空房间的产物登记处 */
  clearArtifacts(roomId: string): number {
    const room = this.rooms.get(roomId);
    if (!room || !room.artifacts) return 0;
    const before = room.artifacts.length;
    room.artifacts = [];
    return before;
  }

  /** 删除房间时间轴中的单个事件 */
  removeEvent(roomId: string, eventId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.events) return false;
    const before = room.events.length;
    room.events = room.events.filter((e) => e.id !== eventId);
    return room.events.length < before;
  }

  /** 清空房间的事件时间轴；可指定 action 只清空某一类 */
  clearEvents(roomId: string, action?: string): number {
    const room = this.rooms.get(roomId);
    if (!room || !room.events) return 0;
    if (!action) {
      const before = room.events.length;
      room.events = [];
      return before;
    }
    const before = room.events.length;
    room.events = room.events.filter((e) => e.action !== action);
    return before - room.events.length;
  }

  private resolveAllowedRoots(roomId: string, author?: string): { path: string; kind: "project" | "workspace" | "cwd"; sessionId?: string }[] {
    const room = this.rooms.get(roomId);
    const roots: { path: string; kind: "project" | "workspace" | "cwd"; sessionId?: string }[] = [];
    if (this.getCwd && room) {
      if (author) {
        const member = this.resolveMember(room, author);
        if (member) {
          const cwd = this.getCwd(member.sessionId);
          if (cwd) roots.push({ path: cwd, kind: "cwd", sessionId: member.sessionId });
        }
      } else {
        for (const member of room.members) {
          const cwd = this.getCwd(member.sessionId);
          if (cwd) roots.push({ path: cwd, kind: "cwd", sessionId: member.sessionId });
        }
      }
    }
    roots.push({ path: PROJECT_ROOT, kind: "project" });
    roots.push({ path: WORKSPACE_ROOT, kind: "workspace" });
    return roots;
  }

  private resolveEntry(input: string, roots: string[], kind?: "file" | "dir"): { real: string; root: string } | undefined {
    for (const root of roots) {
      const loc = path.resolve(root, input);
      try {
        const real = fs.realpathSync(loc);
        if (!isWithin(root, real)) continue;
        const stat = fs.statSync(real);
        if (kind === "file" && !stat.isFile()) continue;
        if (kind === "dir" && !stat.isDirectory()) continue;
        return { real, root };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private resolveEntryPath(
    roomId: string,
    input: string,
    author?: string,
    kind?: "file" | "dir",
  ): { real: string; root: string } | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const roots = this.resolveAllowedRoots(roomId, author).map((r) => r.path);
    return this.resolveEntry(input, roots, kind);
  }

  private resolveTargetPath(
    roomId: string,
    input: string,
    author?: string,
  ): { real: string; root: string } | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const roots = this.resolveAllowedRoots(roomId, author).map((r) => r.path);
    return this.resolveTarget(input, roots);
  }

  private resolveSessionTargetPath(sessionId: string, input: string): { real: string; root: string } | undefined {
    const roots = this.sessionFileRoots(sessionId).map((r) => r.path);
    return this.resolveTarget(input, roots);
  }

  private resolveTarget(input: string, roots: string[]): { real: string; root: string } | undefined {
    for (const root of roots) {
      const parent = path.resolve(root, path.dirname(input));
      try {
        const realParent = fs.realpathSync(parent);
        if (!isWithin(root, realParent)) continue;
        const real = path.join(realParent, path.basename(input));
        if (!isWithin(root, real)) continue;
        return { real, root };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /** 在允许根目录下按相对路径尾缀查找文件，解决 agent 在子目录运行产出的路径偏移 */
  private findFileByRelPath(
    roots: string[],
    relPath: string,
  ): { real: string; root: string } | undefined {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) return undefined;
    const joined = parts.join("/");
    for (const root of roots) {
      const queue: string[] = [root];
      while (queue.length) {
        const dir = queue.shift()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const child = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_NAMES.has(e.name)) continue;
            queue.push(child);
          } else if (e.isFile()) {
            try {
              const real = fs.realpathSync(child);
              if (!isWithin(root, real)) continue;
              const tail = path
                .relative(root, real)
                .replace(/\\/g, "/")
                .split("/")
                .filter(Boolean)
                .slice(-parts.length)
                .join("/");
              if (tail === joined) {
                return { real, root };
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    return undefined;
  }

  /** 将项目内文件复制到 Hub 缓存，并生成/更新 file artifact */
  sendFile(roomId: string, filePath: string, author?: string, summary?: string): Artifact | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const found = this.resolveEntryPath(roomId, filePath, author, "file");
    if (!found) throw new Error("path outside project root");
    const { real, root } = found;
    const rel = path.relative(root, real);
    const existing = room.artifacts?.find((a) => a.path === rel);
    if (existing) {
      existing.summary = summary ?? rel;
      existing.author = author ?? existing.author;
      existing.at = Date.now();
    }
    const artifact = existing ?? this.addFile(roomId, {
      author: author ?? "我",
      summary: summary ?? rel,
      path: rel,
    });
    if (!artifact) return undefined;
    const destDir = path.join(FILES_DIR, roomId, artifact.id);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(real));
    fs.copyFileSync(real, dest);
    this.addEvent(roomId, {
      action: existing ? "modify" : "add",
      author: author ?? "系统",
      summary: existing ? `修改 ${rel}` : `新增 ${rel}`,
      path: rel,
    });
    return artifact;
  }

  /** 根据 artifact id / alias / path 读取缓存或原始文件内容 */
  getFile(roomId: string, ref: string): FileResult {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("unknown room");
    const lowerRef = ref.toLowerCase();
    const all = room.artifacts ?? [];
    const a = all.find((x) =>
      x.id.toLowerCase() === lowerRef ||
      (x.alias?.toLowerCase() === lowerRef) ||
      (x.path?.toLowerCase() === lowerRef) ||
      (x.path && path.basename(x.path).toLowerCase() === lowerRef)
    );

    if (a?.path) {
      const fileName = path.basename(a.path);
      const cachePath = path.join(FILES_DIR, roomId, a.id, fileName);
      const roots = this.resolveAllowedRoots(roomId, a.author).map((r) => r.path);

      const seen = new Set<string>();
      const candidates: { root: string; loc: string }[] = [];
      const add = (root: string, loc: string) => {
        if (seen.has(loc)) return;
        seen.add(loc);
        candidates.push({ root, loc });
      };
      add(FILES_DIR, cachePath);
      for (const root of roots) {
        add(root, path.resolve(root, a.path));
      }

      for (const { root, loc } of candidates) {
        try {
          const resolved = fs.realpathSync(loc);
          if (!isWithin(root, resolved)) continue;
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) continue;
          return fileResultFromBuf(fs.readFileSync(resolved), resolved);
        } catch {
          /* try next */
        }
      }

      // diff artifact 优先展示 diff 摘要，避免子目录搜索到当前文件版本
      if (a.summary.startsWith("diff --git")) {
        return { text: a.summary, name: fileName, mime: "text/plain" };
      }

      // 文件可能在子目录中（例如 agent 在子项目运行 diff，路径只含 src/...）
      const found = this.findFileByRelPath(roots, a.path);
      if (found) {
        try {
          return fileResultFromBuf(fs.readFileSync(found.real), found.real);
        } catch {
          /* 继续 fallback */
        }
      }
    }

    // 文件树直接路径读取：ref 不是 artifact 时，按允许路径直接读取
    if (ref.includes("/") || path.isAbsolute(ref)) {
      const found = this.resolveEntryPath(roomId, ref, undefined, "file");
      if (found) {
        return fileResultFromBuf(fs.readFileSync(found.real), found.real);
      }
    }

    if (!a) throw new Error("file not found");
    throw new Error("file not readable");
  }

  /** 删除房间允许路径内的文件，并生成 delete 事件 */
  deleteFile(roomId: string, filePath: string, author?: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("unknown room");
    const found = this.resolveEntryPath(roomId, filePath, author, "file");
    if (!found) {
      const target = this.resolveTargetPath(roomId, filePath, author);
      if (!target) throw new Error("path outside project root");
      throw new Error("file not found");
    }
    const { real, root } = found;
    if (!fs.existsSync(real)) throw new Error("file not found");
    fs.unlinkSync(real);
    const rel = path.relative(root, real);
    room.artifacts = (room.artifacts ?? []).filter((a) => a.path !== rel);
    this.addEvent(roomId, {
      action: "delete",
      author: author ?? "系统",
      summary: "删除",
      path: rel,
    });
    return true;
  }

  /** 重命名房间允许路径内的文件，并生成 rename 事件 */
  renameFile(roomId: string, from: string, to: string, author?: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("unknown room");
    const fromFound = this.resolveEntryPath(roomId, from, author, "file");
    if (!fromFound) throw new Error("source path outside project root");
    const toFound = this.resolveTarget(to, [fromFound.root]);
    if (!toFound) throw new Error("target path outside project root");
    const { real: fromReal, root: fromRoot } = fromFound;
    if (!fs.existsSync(fromReal)) throw new Error("source file not found");
    if (fs.existsSync(toFound.real)) throw new Error("target file already exists");
    fs.renameSync(fromReal, toFound.real);
    const oldRel = path.relative(fromRoot, fromReal);
    const newRel = path.relative(toFound.root, toFound.real);
    for (const a of room.artifacts ?? []) {
      if (a.path === oldRel) a.path = newRel;
    }
    this.addEvent(roomId, {
      action: "rename",
      author: author ?? "系统",
      summary: "重命名",
      path: newRel,
      oldPath: oldRel,
    });
    return true;
  }

  /** 获取房间可用的文件树根目录 */
  fileRoots(roomId: string): FileTreeRoot[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const roots = new Map<string, FileTreeRoot>();
    if (this.getCwd) {
      for (const member of room.members) {
        const cwd = this.getCwd(member.sessionId);
        if (cwd && !roots.has(cwd)) {
          roots.set(cwd, { name: `@${member.name}`, path: cwd, kind: "cwd", sessionId: member.sessionId });
        }
      }
    }
    return [...roots.values()];
  }

  private buildFileTreeNodes(real: string, root: string): FileTreeNode[] {
    const entries = fs.readdirSync(real, { withFileTypes: true });
    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      if (shouldSkipFile(entry.name)) continue;
      const full = path.join(real, entry.name);
      const stat = fs.statSync(full);
      nodes.push({
        name: entry.name,
        path: full,
        kind: entry.isDirectory() ? "dir" : "file",
        at: stat.mtimeMs,
        ...(stat.isFile() ? { size: stat.size } : {}),
      });
    }
    // 文件夹排在前面，其次按修改时间倒序
    return nodes.sort((a, b) => {
      if (a.kind === "dir" && b.kind !== "dir") return -1;
      if (a.kind !== "dir" && b.kind === "dir") return 1;
      return b.at - a.at;
    });
  }

  /** 列出指定目录下的文件与文件夹（仅一层，已过滤隐藏/构建目录） */
  listFiles(roomId: string, dirPath: string, author?: string): FileTreeNode[] {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("unknown room");
    const found = this.resolveEntryPath(roomId, dirPath, author, "dir");
    if (!found) throw new Error("dir not found");
    return this.buildFileTreeNodes(found.real, found.root);
  }

  /** 获取指定 session 可用的文件树根目录（只显示会话 cwd，不暴露项目/工作区根目录） */
  sessionFileRoots(sessionId: string): FileTreeRoot[] {
    const roots = new Map<string, FileTreeRoot>();
    if (this.getCwd) {
      const cwd = this.getCwd(sessionId);
      if (cwd) roots.set(cwd, { name: "当前工作目录", path: cwd, kind: "cwd", sessionId });
    }
    return [...roots.values()];
  }

  /** 列出指定 session 目录下的文件与文件夹（仅一层，已过滤隐藏/构建目录） */
  sessionListFiles(sessionId: string, dirPath: string): FileTreeNode[] {
    const roots = this.sessionFileRoots(sessionId).map((r) => r.path);
    const found = this.resolveEntry(dirPath, roots, "dir");
    if (!found) throw new Error("dir not found");
    return this.buildFileTreeNodes(found.real, found.root);
  }

  /** 读取指定 session 的文件内容 */
  sessionGetFile(sessionId: string, ref: string): FileResult {
    // session 没有 artifact 注册表，只支持绝对路径或直接路径
    if (!ref.includes("/") && !path.isAbsolute(ref)) throw new Error("file not found");
    const roots = this.sessionFileRoots(sessionId).map((r) => r.path);
    const found = this.resolveEntry(ref, roots, "file");
    if (!found) throw new Error("file not found");
    const { real } = found;
    const buf = fs.readFileSync(real);
    const ext = path.extname(real);
    const mime = mimeFromExt(ext);
    const fileName = path.basename(real);
    if (TEXT_EXTS.has(ext) || isTextBuffer(buf)) {
      return { text: buf.toString("utf-8"), name: fileName, mime };
    }
    return { data: buf.toString("base64"), name: fileName, mime };
  }

  /** 删除指定 session 允许路径内的文件 */
  sessionDeleteFile(sessionId: string, filePath: string): { deleted: boolean; rel: string } {
    const roots = this.sessionFileRoots(sessionId).map((r) => r.path);
    const found = this.resolveEntry(filePath, roots, "file");
    if (!found) {
      const target = this.resolveSessionTargetPath(sessionId, filePath);
      if (!target) throw new Error("path outside project root");
      throw new Error("file not found");
    }
    if (!fs.existsSync(found.real)) throw new Error("file not found");
    fs.unlinkSync(found.real);
    return { deleted: true, rel: path.relative(found.root, found.real) };
  }

  /** 重命名指定 session 允许路径内的文件 */
  sessionRenameFile(sessionId: string, from: string, to: string): { renamed: boolean; fromRel: string; toRel: string } {
    const roots = this.sessionFileRoots(sessionId).map((r) => r.path);
    const fromFound = this.resolveEntry(from, roots, "file");
    if (!fromFound) throw new Error("source path outside project root");
    const toFound = this.resolveTarget(to, [fromFound.root]);
    if (!toFound) throw new Error("target path outside project root");
    if (!fs.existsSync(fromFound.real)) throw new Error("source file not found");
    if (fs.existsSync(toFound.real)) throw new Error("target file already exists");
    fs.renameSync(fromFound.real, toFound.real);
    return {
      renamed: true,
      fromRel: path.relative(fromFound.root, fromFound.real),
      toRel: path.relative(toFound.root, toFound.real),
    };
  }

  /** 解析文本中显式引用的 artifact alias / id / path */
  parseArtifactRefs(roomId: string, text: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room || !room.artifacts) return [];
    const aliasToId = new Map<string, string>();
    const idSet = new Set<string>();
    for (const a of room.artifacts) {
      idSet.add(a.id);
      if (a.alias) aliasToId.set(a.alias, a.id);
      if (a.alias) aliasToId.set(a.alias.toLowerCase(), a.id);
      idSet.add(a.id.toLowerCase());
    }
    const refs = new Set<string>();

    // artifact:xxx / artifact[xxx] / [xxx]
    const bracketRe = /\[([a-zA-Z0-9_-]{1,32})\]/g;
    const explicitRe = /(?:^|[\s@，,;；:：])\[?artifact[:：]\/??\s*([a-zA-Z0-9_-]{1,32})\]?/gi;
    const wordRe = /(?:^|[\s（(，,;；:："'"'‘’“”])([a-zA-Z0-9_-]{2,32})(?=[\s）)，,;；。!！?？"'"'‘’“”\]\n]|$)/g;

    const checkAndAdd = (token: string) => {
      const lower = token.toLowerCase();
      const id = idSet.has(token) ? token : idSet.has(lower) ? lower : undefined;
      if (id) refs.add(id);
      const byAlias = aliasToId.get(token) ?? aliasToId.get(lower);
      if (byAlias) refs.add(byAlias);
    };

    for (const m of text.matchAll(bracketRe)) checkAndAdd(m[1]!);
    for (const m of text.matchAll(explicitRe)) checkAndAdd(m[1]!);
    for (const m of text.matchAll(wordRe)) checkAndAdd(m[1]!);

    // 也匹配路径：artifact.path 在文本中完整出现
    for (const a of room.artifacts) {
      if (a.path && this.containsPath(text, a.path)) {
        refs.add(a.id);
      }
    }
    return [...refs];
  }

  private containsPath(text: string, path: string): boolean {
    const re = new RegExp(`(?:^|[\\s"'“”‘’（(])${this.escapeRegExp(path)}(?=[\\s"'“”‘’）)。,;；，!！?？]|$)`);
    return re.test(text);
  }

  private escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 解析文本中的 #path 引用 */
  parseFileRefs(text: string): string[] {
    const refs = new Set<string>();
    const re = /(?:^|[\s（(，,;；:：])#([^#\s][^\s，,;；。!！?？\)\]\n]*)/g;
    for (const m of text.matchAll(re)) {
      const ref = m[1]!.replace(/\/+$/g, "");
      if (ref) refs.add(ref);
    }
    return [...refs];
  }

  private readFileRef(
    roomId: string,
    ref: string,
  ): { name: string; text?: string; error?: string } {
    const fileFound = this.resolveEntryPath(roomId, ref, undefined, "file");
    if (fileFound) {
      const { real } = fileFound;
      const name = path.basename(real);
      try {
        const buf = fs.readFileSync(real);
        const ext = path.extname(real);
        if (TEXT_EXTS.has(ext) || isTextBuffer(buf)) {
          return { name, text: buf.toString("utf-8") };
        }
        return { name, text: "[二进制文件，已省略内容]" };
      } catch {
        return { name, error: "无法读取文件" };
      }
    }
    const dirFound = this.resolveEntryPath(roomId, ref, undefined, "dir");
    if (dirFound) {
      const { real, root } = dirFound;
      const nodes = this.buildFileTreeNodes(real, root);
      const listing =
        nodes.map((n) => `${n.name}${n.kind === "dir" ? "/" : ""}`).join("\n") ||
        "（空文件夹）";
      return { name: path.basename(real), text: listing };
    }
    return { name: ref, error: "未找到文件或文件夹" };
  }

  /** 获取与当前任务相关的 artifact */
  getArtifactsForPrompt(
    roomId: string,
    excludeSessionId: string,
    context?: { taskId?: string; dependsOn?: string[]; refs?: string[] },
  ): Artifact[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const all = room.artifacts ?? [];
    const refs = context?.refs;
    if (refs && refs.length > 0) {
      const refSet = new Set(refs.map((r) => r.toLowerCase()));
      const matched = [...all].filter(
        (a) =>
          refSet.has(a.id.toLowerCase()) ||
          (a.alias && refSet.has(a.alias.toLowerCase())) ||
          (a.path && refSet.has(a.path.toLowerCase())) ||
          (a.taskId && refSet.has(a.taskId.toLowerCase())),
      );
      // 显式引用时不过滤作者，因为用户指定
      return matched.reverse().slice(0, ARTIFACT_PROMPT_LIMIT);
    }
    const deps = context?.dependsOn;
    if (deps && deps.length > 0) {
      const set = new Set(deps);
      return [...all]
        .filter((a) => set.has(a.taskId ?? "") && a.author !== excludeSessionId)
        .reverse()
        .slice(0, ARTIFACT_PROMPT_LIMIT);
    }
    return this.getArtifacts(roomId)
      .filter((a) => a.author !== excludeSessionId)
      .slice(0, ARTIFACT_PROMPT_LIMIT);
  }

  /** 构造发给某个成员的最终 prompt：注入房间上下文、共享黑板与 artifact 登记处 */
  buildPrompt(
    roomId: string,
    text: string,
    excludeSessionId: string,
    quote?: { author: string; text: string },
    persona?: string,
    artifactContext?: { taskId?: string; dependsOn?: string[]; refs?: string[] },
  ): string {
    const room = this.rooms.get(roomId)!;
    const roleId = room.memberRoles?.[excludeSessionId];
    const resolved = persona ?? (roleId ? this.getPersona?.(roleId) : undefined) ?? roleId;
    const board = (room.blackboard ?? [])
      .filter((e) => e.from !== excludeSessionId)
      .slice(-BLACKBOARD_LIMIT);
    const artifacts = this.getArtifactsForPrompt(roomId, excludeSessionId, artifactContext);
    const others = room.members
      .filter((m) => m.sessionId !== excludeSessionId)
      .map((m) => `@${m.name}`)
      .join(" ");
    const lines = [
      `[群聊「${room.name}」| 其他成员: ${others || "无"}]`,
    ];
    if (resolved) {
      lines.push(`你的角色设定：${resolved}`);
    } else {
      lines.push("你在一个多 agent 协作群聊中。用户和其他 agent 的最近结论如下：");
    }
    if (board.length === 0) {
      lines.push("（暂无）");
    } else {
      for (const e of board) lines.push(`- ${e.from}: ${e.text}`);
    }
    if (artifacts.length > 0) {
      lines.push("", "最近产物（文件）：");
      for (const a of artifacts) {
        const parts = [a.alias ? `[${a.alias}]` : `[${a.id}]`, `@${this.memberName(roomId, a.author)}`];
        if (a.path) parts.push(a.path);
        parts.push(a.summary.slice(0, ARTIFACT_SUMMARY_LEN));
        lines.push(`- ${parts.join(" ")}`);
      }
    }
    const fileRefs = this.parseFileRefs(text).slice(0, FILE_REF_LIMIT);
    if (fileRefs.length > 0) {
      lines.push("", "相关文件：");
      let total = 0;
      for (const [i, ref] of fileRefs.entries()) {
        if (total >= FILE_REF_TOTAL_LIMIT) {
          lines.push(`- ... 还有 ${fileRefs.length - i} 个文件未加载（超出总大小限制）`);
          break;
        }
        const result = this.readFileRef(roomId, ref);
        if (result.error) {
          lines.push(`- #${ref}：${result.error}`);
          continue;
        }
        let content = result.text ?? "";
        if (content.length > FILE_REF_CHAR_LIMIT) {
          content = `${content.slice(0, FILE_REF_CHAR_LIMIT)}\n（已截断，原始大小 ${content.length} 字符）`;
        }
        if (total + content.length > FILE_REF_TOTAL_LIMIT) {
          lines.push(`- ... 还有 ${fileRefs.length - i} 个文件未加载（超出总大小限制）`);
          break;
        }
        total += content.length;
        const body = content
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        lines.push(`- #${ref}（${result.name}）：\n${body}`);
      }
    }
    if (quote) {
      lines.push("", `用户引用了 ${quote.author} 的消息："${quote.text}"`);
    }
    lines.push("", `用户消息：${text}`);
    return lines.join("\n");
  }

  /** 同步更新所有包含该 session 的群中成员显示名 */
  updateMemberName(sessionId: string, name: string): string[] {
    const touched: string[] = [];
    for (const room of this.rooms.values()) {
      const member = room.members.find((m) => m.sessionId === sessionId);
      if (member) {
        member.name = name;
        this.dedupMemberNames(room.roomId);
        touched.push(room.roomId);
      }
    }
    return touched;
  }

  /** 把某个成员的 sessionId 替换为新的 sessionId，用于空会话重建 */
  updateMemberSessionId(oldSessionId: string, newSessionId: string): string[] {
    const touched: string[] = [];
    for (const room of this.rooms.values()) {
      const member = room.members.find((m) => m.sessionId === oldSessionId);
      if (member) {
        member.sessionId = newSessionId;
        if (room.conductorId === oldSessionId) room.conductorId = newSessionId;
        if (room.parallelSummarizerId === oldSessionId) room.parallelSummarizerId = newSessionId;
        if (room.debateJudge === oldSessionId) room.debateJudge = newSessionId;
        if (room.debateSides) {
          room.debateSides = room.debateSides.map((s) =>
            s === oldSessionId ? newSessionId : s,
          ) as [string, string];
        }
        if (room.pipelineOrder) {
          room.pipelineOrder = room.pipelineOrder.map((s) =>
            s === oldSessionId ? newSessionId : s,
          );
        }
        touched.push(room.roomId);
      }
    }
    return touched;
  }

  /** 删除黑板上的某条摘要 */
  removeBlackboard(roomId: string, id: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.blackboard) return false;
    const before = room.blackboard.length;
    const idx = room.blackboard.findIndex((e) => e.id === id);
    if (idx >= 0) room.blackboard.splice(idx, 1);
    return room.blackboard.length < before;
  }

  /** 清空房间黑板 */
  clearBlackboard(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.blackboard || room.blackboard.length === 0) return false;
    room.blackboard.length = 0;
    return true;
  }

  /** 某个 session 一轮结束后，把输出摘要写上黑板（供其他成员参考） */
  recordOutput(sessionId: string, sessionName: string, output: string): string[] {
    const touched: string[] = [];
    const detail = output.trim();
    const text = detail.replace(/\s+/g, " ").slice(0, BLACKBOARD_OUTPUT_LEN);
    if (!text) return touched;
    const id = randomUUID();
    for (const room of this.rooms.values()) {
      if (!room.members.some((m) => m.sessionId === sessionId)) continue;
      const board = (room.blackboard ??= []);
      board.push({ id, from: sessionName, text, detail, at: Date.now() });
      if (board.length > BLACKBOARD_LIMIT) board.shift();
      touched.push(room.roomId);
    }
    return touched;
  }
}
