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
  /** 房间级作品/artifact 登记处 */
  artifacts?: Artifact[] | undefined;
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

type BlackboardEntry = { from: string; text: string; at: number };

const BLACKBOARD_LIMIT = 10;
const BLACKBOARD_OUTPUT_LEN = 400;

export type ArtifactKind = "file" | "command" | "test" | "note";

export type Artifact = {
  id: string;
  alias?: string | undefined;
  kind: ArtifactKind;
  author: string;
  at: number;
  summary: string;
  path?: string | undefined;
  command?: string | undefined;
  taskId?: string | undefined;
  dependsOn?: string[] | undefined;
};

const ARTIFACT_LIMIT = 50;
const ARTIFACT_PROMPT_LIMIT = 10;
const ARTIFACT_SUMMARY_LEN = 240;

const BASE_DIR = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const FILES_DIR = path.resolve(BASE_DIR, "../data/files");
const PROJECT_ROOT = path.resolve(BASE_DIR, "../..");

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

export class RoomManager {
  private rooms = new Map<string, Room>();
  private blackboards = new Map<string, BlackboardEntry[]>();
  private aliasSeqs = new Map<string, number>();
  private getPersona?: (roleId: string) => string | undefined;

  setRoleResolver(getPersona: (roleId: string) => string | undefined): void {
    this.getPersona = getPersona;
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
      artifacts: [],
    };
    this.rooms.set(room.roomId, room);
    this.blackboards.set(room.roomId, []);
    this.aliasSeqs.set(room.roomId, 0);
    this.dedupMemberNames(room.roomId);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** 从持久化状态恢复（不覆盖黑板已有记录） */
  import(room: Room): void {
    room.artifacts = room.artifacts ?? [];
    for (let i = 0; i < room.artifacts.length; i++) {
      if (!room.artifacts[i]!.alias) {
        room.artifacts[i]!.alias = `a${i + 1}`;
      }
    }
    this.rooms.set(room.roomId, room);
    this.blackboards.set(room.roomId, []);
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
        this.blackboards.delete(room.roomId);
        dissolved.push(room.roomId);
        continue;
      }
      room.members = room.members.filter((m) => m.sessionId !== sessionId);
      if (room.conductorId === sessionId) {
        room.conductorId = room.members[0]?.sessionId;
      }
      if (room.members.length < 2) {
        this.rooms.delete(room.roomId);
        this.blackboards.delete(room.roomId);
        dissolved.push(room.roomId);
      }
    }
    return dissolved;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  delete(roomId: string): boolean {
    const ok = this.rooms.delete(roomId);
    this.blackboards.delete(roomId);
    return ok;
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
    return [...(this.blackboards.get(roomId) ?? [])];
  }

  /** 添加一个 artifact 到房间登记处 */
  addArtifact(
    roomId: string,
    artifact: Omit<Artifact, "id" | "at" | "alias">,
  ): Artifact | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const list = (room.artifacts ??= []);
    const seq = (this.aliasSeqs.get(roomId) ?? 0) + 1;
    this.aliasSeqs.set(roomId, seq);
    const item: Artifact = {
      ...artifact,
      id: randomUUID().slice(0, 8),
      alias: `a${seq}`,
      at: Date.now(),
    };
    list.push(item);
    if (list.length > ARTIFACT_LIMIT) list.shift();
    return item;
  }

  /** 获取房间 artifact 列表（按时间倒序） */
  getArtifacts(roomId: string, limit = ARTIFACT_PROMPT_LIMIT): Artifact[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...(room.artifacts ?? [])].reverse().slice(0, limit);
  }

  /** 删除某个 artifact */
  removeArtifact(roomId: string, artifactId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.artifacts) return false;
    const before = room.artifacts.length;
    room.artifacts = room.artifacts.filter((a) => a.id !== artifactId);
    return room.artifacts.length < before;
  }

  private resolveProjectPath(input: string): string {
    const resolved = path.isAbsolute(input) ? path.normalize(input) : path.resolve(PROJECT_ROOT, input);
    const real = fs.realpathSync(resolved);
    if (!isWithin(PROJECT_ROOT, real)) throw new Error("path outside project root");
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error("not a file");
    return real;
  }

  /** 将项目内文件复制到 Hub 缓存，并生成 file artifact */
  sendFile(roomId: string, filePath: string, author?: string, summary?: string): Artifact | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    const src = this.resolveProjectPath(filePath);
    const rel = path.relative(PROJECT_ROOT, src);
    const artifact = this.addArtifact(roomId, {
      kind: "file",
      author: author ?? "我",
      summary: summary ?? rel,
      path: rel,
    });
    if (!artifact) return undefined;
    const destDir = path.join(FILES_DIR, roomId, artifact.id);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, dest);
    return artifact;
  }

  /** 根据 artifact id / alias / path 读取缓存或原始文件内容 */
  getFile(roomId: string, ref: string): FileResult {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error("unknown room");
    const lowerRef = ref.toLowerCase();
    const all = room.artifacts ?? [];
    const a = all.find((x) =>
      x.kind === "file" &&
      (x.id.toLowerCase() === lowerRef ||
        (x.alias?.toLowerCase() === lowerRef) ||
        (x.path?.toLowerCase() === lowerRef) ||
        (x.path && path.basename(x.path).toLowerCase() === lowerRef))
    );
    if (!a || !a.path) throw new Error("file not found");

    const fileName = path.basename(a.path);
    const cachePath = path.join(FILES_DIR, roomId, a.id, fileName);
    const locations = [cachePath, path.resolve(PROJECT_ROOT, a.path)];
    let real: string | undefined;
    for (const loc of locations) {
      try {
        const resolved = fs.realpathSync(loc);
        if (isWithin(FILES_DIR, resolved) || isWithin(PROJECT_ROOT, resolved)) {
          const stat = fs.statSync(resolved);
          if (stat.isFile()) {
            real = resolved;
            break;
          }
        }
      } catch {
        /* try next */
      }
    }
    if (!real) throw new Error("file not readable");

    const buf = fs.readFileSync(real);
    const ext = path.extname(real);
    const mime = mimeFromExt(ext);
    if (TEXT_EXTS.has(ext) || isTextBuffer(buf)) {
      return { text: buf.toString("utf-8"), name: fileName, mime };
    }
    return { data: buf.toString("base64"), name: fileName, mime };
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
    const board = (this.blackboards.get(roomId) ?? [])
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
      lines.push("", "最近产生的作品/结果：");
      for (const a of artifacts) {
        const parts = [a.alias ? `[${a.alias}]` : `[${a.id}]`, `@${a.author}`, `[${a.kind}]`];
        if (a.path) parts.push(a.path);
        if (a.command) parts.push(a.command);
        parts.push(a.summary.slice(0, ARTIFACT_SUMMARY_LEN));
        lines.push(`- ${parts.join(" ")}`);
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

  /** 某个 session 一轮结束后，把输出摘要写上黑板（供其他成员参考） */
  recordOutput(sessionId: string, sessionName: string, output: string): string[] {
    const touched: string[] = [];
    const text = output.trim().replace(/\s+/g, " ").slice(0, BLACKBOARD_OUTPUT_LEN);
    if (!text) return touched;
    for (const room of this.rooms.values()) {
      if (!room.members.some((m) => m.sessionId === sessionId)) continue;
      const board = this.blackboards.get(room.roomId)!;
      board.push({ from: sessionName, text, at: Date.now() });
      if (board.length > BLACKBOARD_LIMIT) board.shift();
      touched.push(room.roomId);
    }
    return touched;
  }
}
