import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, Room, RoomEvent } from "./room.js";
import { logWarn } from "./logger.js";
import { MEMORY_LIMIT, type MemoryEntry } from "./memory.js";

export type Connection = {
  id: string;
  name: string;
  agent: string;
  token: string;
  address?: string | undefined;
  cwd?: string | undefined;
  local?: boolean | undefined;
  /** 远端 worker 最近一次接入/断开时刻（毫秒时间戳） */
  lastSeen?: number | undefined;
};

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  name: string;
  agent: string;
  address?: string | undefined;
  connectionId?: string | undefined;
  roleId?: string | undefined;
  archived?: boolean | undefined;
  artifacts?: Artifact[] | undefined;
  events?: RoomEvent[] | undefined;
};

export type HistoryEntry = {
  at: number;
  kind: "user" | "assistant" | "system" | "thought" | "tool" | "plan" | "error" | "process" | "flow" | "decision";
  author: string;
  text: string;
  clientMessageId?: string | undefined;
  /** 工单派发产生的条目归属 mission id（真人输入为空，可区分来源） */
  missionId?: string | undefined;
};

/**
 * 判定是否需要"回复丢失"占位符/提示。
 * replyStillOpen 为 true（活跃编排尚未产出最终回复）时一律不误报。
 * 返回 "append"（需写入占位符并提示）/ "repeat"（占位符已在末尾，只提示）/ undefined。
 */
export function lostReplyAction(
  last: Pick<HistoryEntry, "kind" | "text"> | undefined,
  placeholder: string,
  replyStillOpen: boolean,
): "append" | "repeat" | undefined {
  if (!last || replyStillOpen) return undefined;
  if (last.kind === "user") return "append";
  if (last.kind === "assistant" && last.text === placeholder) return "repeat";
  return undefined;
}

type HistoryItem = HistoryEntry & { id: number; at: number; draft?: number };

/** SQLite NULL → undefined：可选字段契约是 undefined 而非 null */
function normalizeItems<T extends HistoryItem>(rows: T[]): T[] {
  for (const r of rows) {
    const rr = r as { missionId?: unknown; clientMessageId?: unknown };
    if (rr.missionId === null) r.missionId = undefined;
    if (rr.clientMessageId === null) r.clientMessageId = undefined;
  }
  return rows;
}

export type Role = {
  id: string;
  name: string;
  agent?: string | undefined;
  address?: string | undefined;
  connectionId?: string | undefined;
  cwd?: string | undefined;
  persona: string;
  builtin?: boolean | undefined;
};

const BUILTIN_ROLES: Role[] = [
  {
    id: "general",
    name: "通用助手",
    persona:
      "你是一个全能的通用技术助手。回答问题直接、准确，代码给出可运行的完整版本。不确定时明确说明，不要编造。",
    builtin: true,
  },
  {
    id: "backend",
    name: "后端工程师",
    persona:
      "你是资深后端工程师，专注 API 设计、数据库建模、性能优化与系统可靠性。回答时优先考虑边界条件、幂等性和线上风险，给出可直接落地的实现。",
    builtin: true,
  },
  {
    id: "frontend",
    name: "前端工程师",
    persona:
      "你是资深前端工程师，熟悉现代框架、状态管理与无障碍实践。回答时兼顾用户体验细节与工程可维护性，代码遵循项目现有风格。",
    builtin: true,
  },
  {
    id: "reviewer",
    name: "代码审查员",
    persona:
      "你是严格的代码审查员。审查时按严重程度列出问题（安全 > 正确性 > 性能 > 风格），每条给出具体位置与修改建议；没有问题时直接说明，不强行挑刺。",
    builtin: true,
  },
  {
    id: "pm",
    name: "产品经理",
    persona:
      "你是经验丰富的产品经理，擅长需求澄清、用户故事拆解与优先级排序。输出以用户价值为中心，用结构化列表给出验收标准，避免技术实现细节。",
    builtin: true,
  },
  {
    id: "qa",
    name: "测试工程师",
    persona:
      "你是资深测试工程师。针对需求或代码给出测试用例矩阵（正常/边界/异常路径），优先覆盖高风险路径，用例描述具体到输入与预期输出。",
    builtin: true,
  },
];

type State = { sessions: SessionMeta[]; rooms: Room[]; runtime?: Record<string, unknown> | undefined };

const HISTORY_LIMIT = 200;
/** 启动清理：每个 (scope, scope_id) 保留的最新 history 条数 / 每个房间保留的最新 room_events 条数 */
const HISTORY_PRUNE_KEEP = 5000;
const ROOM_EVENTS_PRUNE_KEEP = 2000;
/** 启动时孤儿卡/未决卡收尾的回溯扫描上限：非终态卡必然在近期尾部，更早的按遗弃处理 */
const ORPHAN_CARD_SCAN_LIMIT = 500;
const RESTART_INTERRUPTED_MARKER = "[Hub 重启中断了此回复；以上为已保存片段，未自动重试]";
const INTERRUPTED_REPLY_MARKER = "[回复中断；以上为已保存片段，未自动重试]";

export class Store {
  readonly dir: string;
  private db: Database.Database;
  /** 热路径语句缓存：better-sqlite3 每次 prepare 都重新编译，固定 SQL 复用同一 Statement */
  private stmtCache = new Map<string, Database.Statement>();

  private prep(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      // 上限防动态拼接 SQL（如 UPDATE connections SET ...）无界堆积
      if (this.stmtCache.size >= 500) this.stmtCache.clear();
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  appendRoomEvent(
    roomId: string,
    type: string,
    payload: Record<string, unknown>,
  ): number {
    const row = this.prep("SELECT COALESCE(MAX(seq), 0) AS m FROM room_events WHERE room_id = ?")
      .get(roomId) as { m: number };
    const seq = (row?.m ?? 0) + 1;
    this.prep(
        "INSERT INTO room_events(room_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(roomId, seq, Date.now(), type, JSON.stringify(payload));
    return seq;
  }

  getRoomEvents(
    roomId: string,
    since = 0,
  ): { seq: number; at: number; type: string; payload: Record<string, unknown> }[] {
    const rows = this.prep(
        "SELECT seq, at, type, payload FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq",
      )
      .all(roomId, since) as { seq: number; at: number; type: string; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  saveFlowSnapshot(roomId: string, seq: number, snapshot: Record<string, unknown>): void {
    this.prep(
        "INSERT INTO flow_snapshots(room_id, seq, at, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET seq = excluded.seq, at = excluded.at, snapshot = excluded.snapshot",
      )
      .run(roomId, seq, Date.now(), JSON.stringify(snapshot));
  }

  getMaxRoomSeq(roomId: string): number {
    const row = this.prep("SELECT COALESCE(MAX(seq), 0) AS m FROM room_events WHERE room_id = ?")
      .get(roomId) as { m: number } | undefined;
    return row?.m ?? 0;
  }

  loadFlowSnapshot(roomId: string): { seq: number; snapshot: Record<string, unknown> } | undefined {
    const row = this.prep("SELECT seq, snapshot FROM flow_snapshots WHERE room_id = ?")
      .get(roomId) as { seq: number; snapshot: string } | undefined;
    if (!row) return undefined;
    try {
      return { seq: row.seq, snapshot: JSON.parse(row.snapshot) as Record<string, unknown> };
    } catch {
      // 快照是可重放缓存：单房损坏丢弃该行即可重建，不走 quarantine 也不拖垮整体恢复
      this.prep("DELETE FROM flow_snapshots WHERE room_id = ?").run(roomId);
      return undefined;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  constructor(dir?: string) {
    this.dir =
      dir ??
      process.env.HUB_DATA_DIR ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new Database(path.join(this.dir, "hub.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        draft INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_history_scope
        ON history(scope, scope_id, at);
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent TEXT NOT NULL,
        token TEXT NOT NULL,
        address TEXT,
        cwd TEXT,
        local INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent TEXT,
        address TEXT,
        connectionId TEXT,
        cwd TEXT,
        persona TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS room_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(room_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_room_events_room_seq
        ON room_events(room_id, seq);
      CREATE TABLE IF NOT EXISTS flow_snapshots (
        room_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_msgs (
        key TEXT PRIMARY KEY,
        result TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_ifc (
        room_id TEXT PRIMARY KEY,
        sensitivity TEXT NOT NULL DEFAULT 'shared',
        allow TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_room ON memory(room_id, at);
      -- tool_call 外发迹：到达即落库（不依赖回合定稿），供重启对账 hadOutward 判定
      CREATE TABLE IF NOT EXISTS tool_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT,
        title TEXT,
        status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_actions_sid_at
        ON tool_actions(session_id, at);
    `);
    // 历史检索 FTS5：外部内容表+触发器同步，search 系方法 MATCH 加速；
    // CJK 等无 token 词命中为空时调用侧回退 LIKE 保语义。FTS5 不可用则静默降级
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='history', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS history_fts_ai AFTER INSERT ON history BEGIN
          INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS history_fts_ad AFTER DELETE ON history BEGIN
          INSERT INTO history_fts(history_fts, rowid, text) VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS history_fts_au AFTER UPDATE OF text ON history BEGIN
          INSERT INTO history_fts(history_fts, rowid, text) VALUES ('delete', old.id, old.text);
          INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text);
        END;
      `);
      // 增量回填：只补 fts 缺失的尾部行（幂等，老库升级可用）
      this.db.exec(
        "INSERT INTO history_fts(rowid, text) SELECT id, text FROM history WHERE id > COALESCE((SELECT MAX(rowid) FROM history_fts), 0)",
      );
      this.hasFts = true;
    } catch {
      this.hasFts = false;
    }
    this.migrateSchema();
    this.seedRoles();
    this.migrateLegacy();
    this.prune();
  }

  /** 表只增不删会无限膨胀；启动时把每组历史/每房事件裁剪到最近 N 条（保留 seq 最新的尾部） */
  private prune(): void {
    try {
      this.db.transaction(() => {
        const h = this.prep(
            `DELETE FROM history WHERE id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY scope, scope_id ORDER BY id DESC) AS rn
                FROM history
              ) WHERE rn > ?)`,
          )
          .run(HISTORY_PRUNE_KEEP);
        const e = this.prep(
            `DELETE FROM room_events WHERE id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY id DESC) AS rn
                FROM room_events
              ) WHERE rn > ?)`,
          )
          .run(ROOM_EVENTS_PRUNE_KEEP);
        if (h.changes > 0 || e.changes > 0) {
          console.log(`[store] pruned ${h.changes} history, ${e.changes} room_events rows`);
        }
      })();
    } catch (err) {
      logWarn("store", `prune failed: ${String(err)}`);
    }
  }

  private migrateSchema(): void {
    const columns: { table: string; column: string; def: string }[] = [
      { table: "connections", column: "address", def: "TEXT" },
      { table: "connections", column: "cwd", def: "TEXT" },
      { table: "connections", column: "token", def: "TEXT" },
      { table: "connections", column: "local", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "connections", column: "lastSeen", def: "INTEGER" },
      { table: "roles", column: "agent", def: "TEXT" },
      { table: "roles", column: "address", def: "TEXT" },
      { table: "roles", column: "connectionId", def: "TEXT" },
      { table: "roles", column: "cwd", def: "TEXT" },
      { table: "roles", column: "persona", def: "TEXT NOT NULL DEFAULT ''" },
      { table: "roles", column: "builtin", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "history", column: "draft", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "history", column: "client_message_id", def: "TEXT" },
      { table: "history", column: "mission_id", def: "TEXT" },
    ];
    for (const { table, column, def } of columns) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      } catch {
        // already exists or incompatible; ignore
      }
    }
  }

  /** 旧版 JSONL/state.json 数据迁移（只在数据库为空时执行一次） */
  private migrateLegacy(): void {
    try {
      const count = this.prep("SELECT COUNT(*) AS c FROM history")
        .get() as { c: number };
      const hasState = this.prep("SELECT value FROM meta WHERE key = 'state'")
        .get();
      if (count.c > 0 || hasState) return;

      const stateFile = path.join(this.dir, "state.json");
      if (fs.existsSync(stateFile)) {
        const obj = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        this.save({ sessions: obj.sessions ?? [], rooms: obj.rooms ?? [] });
        console.log("[store] migrated state.json");
      }

      const historyDir = path.join(this.dir, "history");
      if (!fs.existsSync(historyDir)) return;
      const insert = this.prep(
        "INSERT INTO history(scope, scope_id, at, kind, author, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      let imported = 0;
      for (const file of fs.readdirSync(historyDir)) {
        const m = /^(session|room)-(.+)\.jsonl$/.exec(file);
        if (!m) continue;
        const lines = fs
          .readFileSync(path.join(historyDir, file), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as HistoryEntry;
            insert.run(m[1], m[2], e.at, e.kind, e.author, e.text);
            imported++;
          } catch {
            /* skip bad line */
          }
        }
      }
      if (imported > 0) {
        console.log(`[store] migrated ${imported} legacy history entries`);
      }
    } catch (err) {
      logWarn("store", `legacy migration failed: ${String(err)}`);
    }
  }

  private seedRoles(): void {
    const count = this.prep("SELECT COUNT(*) AS c FROM roles").get() as { c: number };
    if (count.c > 0) return;
    const insert = this.prep(
      "INSERT INTO roles(id, name, agent, address, connectionId, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of BUILTIN_ROLES) {
      insert.run(r.id, r.name, r.agent ?? null, r.address ?? null, r.connectionId ?? null, r.cwd ?? null, r.persona, 1);
    }
    console.log(`[store] seeded ${BUILTIN_ROLES.length} builtin roles`);
  }

  listConnections(): Connection[] {
    const rows = this.prep("SELECT id, name, agent, token, address, cwd, local, lastSeen FROM connections ORDER BY rowid")
      .all() as { id: string; name: string; agent: string; token: string; address: string | null; cwd: string | null; local: number; lastSeen: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      agent: r.agent,
      token: r.token,
      address: r.address ?? undefined,
      cwd: r.cwd ?? undefined,
      local: r.local === 1,
      lastSeen: r.lastSeen ?? undefined,
    }));
  }

  addConnection(c: Connection): void {
    this.prep("INSERT INTO connections(id, name, agent, token, address, cwd, local) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.name, c.agent, c.token, c.address ?? null, c.cwd ?? null, c.local ? 1 : 0);
  }

  updateConnection(id: string, patch: Partial<Omit<Connection, "id">>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); vals.push(patch.name); }
    if (patch.agent !== undefined) { sets.push("agent = ?"); vals.push(patch.agent); }
    if (patch.token !== undefined) { sets.push("token = ?"); vals.push(patch.token); }
    if (patch.address !== undefined) { sets.push("address = ?"); vals.push(patch.address ?? null); }
    if (patch.cwd !== undefined) { sets.push("cwd = ?"); vals.push(patch.cwd ?? null); }
    if (patch.local !== undefined) { sets.push("local = ?"); vals.push(patch.local ? 1 : 0); }
    if (patch.lastSeen !== undefined) { sets.push("lastSeen = ?"); vals.push(patch.lastSeen ?? null); }
    if (sets.length === 0) return;
    vals.push(id);
    this.prep(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteConnection(id: string): boolean {
    const res = this.prep("DELETE FROM connections WHERE id = ?").run(id);
    return res.changes > 0;
  }

  listRoles(): Role[] {
    const rows = this.prep("SELECT id, name, agent, address, connectionId, cwd, persona, builtin FROM roles ORDER BY builtin DESC, rowid")
      .all() as { id: string; name: string; agent: string | null; address: string | null; connectionId: string | null; cwd: string | null; persona: string; builtin: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      agent: r.agent ?? undefined,
      address: r.address ?? undefined,
      connectionId: r.connectionId ?? undefined,
      cwd: r.cwd ?? undefined,
      persona: r.persona,
      builtin: r.builtin === 1,
    }));
  }

  addRole(role: Role): void {
    this.prep("INSERT INTO roles(id, name, agent, address, connectionId, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(role.id, role.name, role.agent ?? null, role.address ?? null, role.connectionId ?? null, role.cwd ?? null, role.persona);
  }

  /** 只能删除非内置角色 */
  deleteRole(id: string): boolean {
    const res = this.prep("DELETE FROM roles WHERE id = ? AND builtin = 0").run(id);
    return res.changes > 0;
  }

  getMeta(key: string): string | undefined {
    try {
      const row = this.prep("SELECT value FROM meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  }

  setMeta(key: string, value: string): void {
    this.prep(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** 已落库的 state 拆行行快照（key→json），save 时按行 diff 只写脏项 */
  private savedRows = new Map<string, string>();

  load(): State {
    try {
      const rows = this.prep("SELECT key, value FROM meta WHERE key LIKE 'state:%'")
        .all() as { key: string; value: string }[];
      if (rows.length > 0) {
        const state: State = { sessions: [], rooms: [] };
        for (const r of rows) {
          this.savedRows.set(r.key, r.value);
          if (r.key.startsWith("state:session:")) {
            state.sessions.push(JSON.parse(r.value) as SessionMeta);
          } else if (r.key.startsWith("state:room:")) {
            state.rooms.push(JSON.parse(r.value) as Room);
          } else if (r.key === "state:runtime") {
            state.runtime = JSON.parse(r.value) as Record<string, unknown>;
          }
        }
        return state;
      }
      const row = this.prep("SELECT value FROM meta WHERE key = 'state'")
        .get() as { value: string } | undefined;
      if (!row) return { sessions: [], rooms: [] };
      const obj = JSON.parse(row.value);
      const state: State = {
        sessions: obj.sessions ?? [],
        rooms: obj.rooms ?? [],
        runtime: typeof obj.runtime === "object" ? obj.runtime : undefined,
      };
      // 一次性迁移：旧版单 blob 拆为 per-scope 行并删除 'state' 键
      this.save(state);
      return state;
    } catch {
      return { sessions: [], rooms: [] };
    }
  }

  save(state: State): void {
    const wanted = new Map<string, string>();
    for (const s of state.sessions) {
      wanted.set(`state:session:${s.sessionId}`, JSON.stringify(s));
    }
    for (const r of state.rooms) {
      wanted.set(`state:room:${r.roomId}`, JSON.stringify(r));
    }
    if (state.runtime !== undefined) {
      wanted.set("state:runtime", JSON.stringify(state.runtime));
    }
    const changed: [string, string][] = [];
    for (const [k, v] of wanted) {
      if (this.savedRows.get(k) !== v) changed.push([k, v]);
    }
    const stale: string[] = [];
    for (const k of this.savedRows.keys()) {
      if (!wanted.has(k)) stale.push(k);
    }
    this.db.transaction(() => {
      const up = this.prep(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      for (const [k, v] of changed) up.run(k, v);
      const del = this.prep("DELETE FROM meta WHERE key = ?");
      for (const k of stale) del.run(k);
      del.run("state");
    })();
    // 事务成功后才同步内存镜像：若事务抛错（回滚），savedRows 不超前于 DB，
    // 否则下次 save 会因误判"未脏"而永久跳过该行写入
    for (const [k, v] of changed) this.savedRows.set(k, v);
    for (const k of stale) this.savedRows.delete(k);
  }

  append(scope: "session" | "room", id: string, entry: HistoryEntry): number {
    try {
      const r = this.prep(
          "INSERT INTO history(scope, scope_id, at, kind, author, text, client_message_id, mission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(scope, id, entry.at, entry.kind, entry.author, entry.text, entry.clientMessageId ?? null, entry.missionId ?? null);
      return Number(r.lastInsertRowid);
    } catch (err) {
      logWarn("store", `append failed: ${String(err)}`);
      return -1;
    }
  }

  beginReplyDraft(scope: "session" | "room", id: string, entry: HistoryEntry): number {
    try {
      const r = this.prep(
          "INSERT INTO history(scope, scope_id, at, kind, author, text, draft) VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .run(scope, id, entry.at, entry.kind, entry.author, entry.text);
      return Number(r.lastInsertRowid);
    } catch (err) {
      logWarn("store", `beginReplyDraft failed: ${String(err)}`);
      return -1;
    }
  }

  updateReplyDraft(rowId: number, text: string): void {
    try {
      this.prep("UPDATE history SET text = ? WHERE id = ? AND draft = 1")
        .run(text, rowId);
    } catch (err) {
      logWarn("store", `updateReplyDraft failed: ${String(err)}`);
    }
  }

  completeReplyDraft(rowId: number, text: string): void {
    try {
      this.prep("UPDATE history SET text = ?, draft = 0, at = ? WHERE id = ? AND draft = 1")
        .run(text, Date.now(), rowId);
    } catch (err) {
      logWarn("store", `completeReplyDraft failed: ${String(err)}`);
    }
  }

  interruptReplyDraft(rowId: number): void {
    try {
      this.prep(
          "UPDATE history SET text = CASE WHEN trim(text) = '' THEN ? ELSE text || ? END, draft = 0, at = ? WHERE id = ? AND draft = 1",
        )
        .run(INTERRUPTED_REPLY_MARKER, `\n\n${INTERRUPTED_REPLY_MARKER}`, Date.now(), rowId);
    } catch (err) {
      logWarn("store", `interruptReplyDraft failed: ${String(err)}`);
    }
  }

  interruptReplyDrafts(): { scope: "session" | "room"; id: string }[] {
    try {
      return this.db.transaction(() => {
        const rows = this.prep("SELECT id, scope, scope_id AS scopeId, text FROM history WHERE draft = 1")
          .all() as { id: number; scope: "session" | "room"; scopeId: string; text: string }[];
        const finalize = this.prep(
          "UPDATE history SET text = ?, draft = 0, at = ? WHERE id = ? AND draft = 1",
        );
        const affected = new Map<string, { scope: "session" | "room"; id: string }>();
        for (const r of rows) {
          finalize.run(
            r.text.trim()
              ? `${r.text}\n\n${RESTART_INTERRUPTED_MARKER}`
              : RESTART_INTERRUPTED_MARKER,
            Date.now(),
            r.id,
          );
          affected.set(`${r.scope}:${r.scopeId}`, { scope: r.scope, id: r.scopeId });
        }
        return [...affected.values()];
      })();
    } catch (err) {
      logWarn("store", `interruptReplyDrafts failed: ${String(err)}`);
      return [];
    }
  }

  /** 非终态编排卡条目（phase 非 done/cancelled），供启动时的孤儿卡收尾；只扫最近若干条避免全表加载 */
  findUnfinishedFlowCards(): { id: number; scopeId: string; at: number; text: string }[] {
    try {
      const rows = this.prep(
          "SELECT id, scope_id AS scopeId, at, text FROM history WHERE scope = 'room' AND kind = 'flow' ORDER BY id DESC LIMIT ?",
        )
        .all(ORPHAN_CARD_SCAN_LIMIT) as { id: number; scopeId: string; at: number; text: string }[];
      return rows.filter((r) => {
        try {
          const phase = String((JSON.parse(r.text) as Record<string, unknown>).phase ?? "");
          return phase !== "done" && phase !== "cancelled";
        } catch {
          return false;
        }
      });
    } catch (err) {
      logWarn("store", `findUnfinishedFlowCards failed: ${String(err)}`);
      return [];
    }
  }

  /** 未决决策卡条目（kind='decision' 且 meta.status='pending'），供启动时的过期收尾；只扫最近若干条避免全表加载 */
  findPendingDecisionCards(): { id: number; scope: "session" | "room"; scopeId: string; at: number; text: string }[] {
    try {
      const rows = this.prep(
          "SELECT id, scope, scope_id AS scopeId, at, text FROM history WHERE kind = 'decision' ORDER BY id DESC LIMIT ?",
        )
        .all(ORPHAN_CARD_SCAN_LIMIT) as { id: number; scope: "session" | "room"; scopeId: string; at: number; text: string }[];
      return rows.filter((r) => {
        try {
          return String((JSON.parse(r.text) as Record<string, unknown>).status ?? "") === "pending";
        } catch {
          return false;
        }
      });
    } catch (err) {
      logWarn("store", `findPendingDecisionCards failed: ${String(err)}`);
      return [];
    }
  }

  /** 原位覆写已有历史条目（编排卡等长期存活条目）：只改 text，不动 at/id/draft */
  updateEntry(rowId: number, text: string): void {
    try {
      this.prep("UPDATE history SET text = ? WHERE id = ?").run(text, rowId);
    } catch (err) {
      logWarn("store", `updateEntry failed: ${String(err)}`);
    }
  }

  copyHistory(scope: "session" | "room", sourceId: string, targetId: string): void {
    try {
      this.prep(
          "INSERT INTO history(scope, scope_id, at, kind, author, text, client_message_id, mission_id) SELECT scope, ?, at, kind, author, text, client_message_id, mission_id FROM history WHERE scope = ? AND scope_id = ? ORDER BY id",
        )
        .run(targetId, scope, sourceId);
    } catch (err) {
      logWarn("store", `copyHistory failed: ${String(err)}`);
    }
  }

  /** 检索式调取旧记录：scope 内按关键词/作者/时间窗过滤，at 倒序分页 */
  searchHistory(
    scope: "session" | "room",
    id: string,
    opts: { query?: string | undefined; author?: string | undefined; missionId?: string | undefined; fromAt?: number | undefined; toAt?: number | undefined; limit?: number | undefined; beforeId?: number | undefined } = {},
  ): HistoryItem[] {
    const conds = ["h.scope = ?", "h.scope_id = ?", "h.draft = 0"];
    const args: unknown[] = [scope, id];
    if (opts.author) { conds.push("h.author = ?"); args.push(opts.author); }
    if (opts.missionId) { conds.push("h.mission_id = ?"); args.push(opts.missionId); }
    if (opts.fromAt !== undefined) { conds.push("h.at >= ?"); args.push(opts.fromAt); }
    if (opts.toAt !== undefined) { conds.push("h.at <= ?"); args.push(opts.toAt); }
    if (opts.beforeId !== undefined) { conds.push("h.id < ?"); args.push(opts.beforeId); }
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
    if (opts.query && this.hasFts) {
      const expr = this.ftsExpr(opts.query);
      if (expr) {
        const rows = this.prep(
            `SELECT h.id, h.at, h.kind, h.author, h.text, h.draft,
                    h.client_message_id AS clientMessageId, h.mission_id AS missionId
             FROM history_fts JOIN history h ON h.id = history_fts.rowid
             WHERE history_fts MATCH ? AND ${conds.join(" AND ")}
             ORDER BY h.at DESC, h.id DESC LIMIT ?`,
          )
          .all(expr, ...args, limit) as HistoryItem[];
        if (rows.length) return normalizeItems(rows);
      }
    }
    if (opts.query) { conds.push("LOWER(h.text) LIKE ?"); args.push(`%${opts.query.toLowerCase()}%`); }
    return normalizeItems(this.prep(
        `SELECT h.id, h.at, h.kind, h.author, h.text, h.draft, h.client_message_id AS clientMessageId, h.mission_id AS missionId FROM history h
         WHERE ${conds.join(" AND ")} ORDER BY h.at DESC, h.id DESC LIMIT ?`,
      )
      .all(...args, limit) as HistoryItem[]);
  }

  private toolActionWrites = 0;
  private hasFts = false;
  /** client_msgs 过期回执周期清扫时点（构造即起算，首次写入在 1h 内不触发全表 DELETE） */
  private clientMsgSweepAt = Date.now();

  /** FTS5 MATCH 表达式：空白拆词逐词加引号组短语（与 LIKE 连续子串语义对齐）；不可拆词返回 null */
  private ftsExpr(query: string): string | null {
    const toks = query
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/"/g, ""))
      .filter(Boolean);
    return toks.length ? toks.map((t) => `"${t}"`).join(" ") : null;
  }

  /** FTS 快路径：MATCH 命中返回排序结果；零命中（CJK/非常规子串无 token）返回 null 由调用侧回退 LIKE */
  private ftsRows(
    query: string,
    condSql: string,
    condArgs: unknown[],
    limit: number,
  ): (HistoryItem & { scope: string; scopeId: string })[] | null {
    if (!this.hasFts) return null;
    const expr = this.ftsExpr(query);
    if (!expr) return null;
    const rows = this.prep(
        `SELECT h.id, h.scope, h.scope_id AS scopeId, h.at, h.kind, h.author, h.text
         FROM history_fts JOIN history h ON h.id = history_fts.rowid
         WHERE history_fts MATCH ? ${condSql}
         ORDER BY h.at DESC, h.id DESC LIMIT ?`,
      )
      .all(expr, ...condArgs, limit) as (HistoryItem & { scope: string; scopeId: string })[];
    return rows.length ? rows : null;
  }

  /** tool_call 外发迹落库：at 为到达时刻（恒 >= 任务 dispatchedAt），供重启 hadOutward 精确按 sessionId 判定 */
  addToolAction(
    sessionId: string,
    a: { at: number; kind?: string | undefined; title?: string | undefined; status?: string | undefined },
  ): void {
    this.prep(
        "INSERT INTO tool_actions (at, session_id, kind, title, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(a.at, sessionId, a.kind ?? null, a.title ?? null, a.status ?? null);
    // 惰性清理：约每 200 次写入删 14 天前旧行（外发迹只需覆盖一次重启对账窗口）
    if (++this.toolActionWrites % 200 === 0) {
      this.prep("DELETE FROM tool_actions WHERE at < ?")
        .run(Date.now() - 14 * 86_400_000);
    }
  }

  /** sessionId 在 sinceAt 之后是否存在 tool_call 外发迹（重启对账信号，精确归属不依赖 author 形态） */
  hasToolAction(sessionId: string, sinceAt: number): boolean {
    return (
      this.prep(
          "SELECT 1 AS x FROM tool_actions WHERE session_id = ? AND at >= ? LIMIT 1",
        )
        .get(sessionId, sinceAt) !== undefined
    );
  }

  read(scope: "session" | "room", id: string, limit = HISTORY_LIMIT): HistoryItem[] {
    const rows = normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, limit) as HistoryItem[]);
    return rows.reverse();
  }

  readAround(
    scope: "session" | "room",
    id: string,
    at: number,
    limit = 50,
  ): HistoryItem[] {
    const before = normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND at <= ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[]);
    const after = normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND at >= ?
         ORDER BY at ASC, id ASC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[]);
    const seen = new Set<number>();
    const merged: HistoryItem[] = [];
    for (const row of [...before, ...after]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    merged.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      return a.id - b.id;
    });
    return merged;
  }

  readBefore(
    scope: "session" | "room",
    id: string,
    at: number,
    limit = 50,
    beforeId?: number,
  ): HistoryItem[] {
    const rows = normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND (at < ? OR (at = ? AND id < ?))
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, at, at, beforeId ?? -1, limit) as HistoryItem[]);
    return rows.reverse();
  }

  readAfter(
    scope: "session" | "room",
    id: string,
    at: number,
    limit = 200,
  ): HistoryItem[] {
    return normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND at >= ?
         ORDER BY at ASC, id ASC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[]);
  }

  /**
   * 游标式增量读：返回 id > afterId 的条目。
   * truncated=true 表示游标行已被清理/不存在（超出保留范围），调用方应回退全量重载。
   */
  readAfterId(
    scope: "session" | "room",
    id: string,
    afterId: number,
    limit = 200,
  ): { entries: HistoryItem[]; truncated: boolean } {
    const exists = this.prep(
        "SELECT 1 FROM history WHERE scope = ? AND scope_id = ? AND id = ? LIMIT 1",
      )
      .get(scope, id, afterId);
    if (afterId !== 0 && !exists) return { entries: [], truncated: true };
    const entries = normalizeItems(this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(scope, id, afterId, limit) as HistoryItem[]);
    return { entries, truncated: false };
  }

  clientMsgReceipt(key: string):
    | { state: "dispatching" | "accepted" | "uncertain"; fingerprint?: string; historyId?: number; result?: unknown; legacy?: boolean }
    | undefined {
    const row = this.prep("SELECT result FROM client_msgs WHERE key = ?")
      .get(key) as { result: string } | undefined;
    if (!row) return undefined;
    try {
      const v = JSON.parse(row.result) as Record<string, unknown>;
      if (v && typeof v === "object" && v.v === 1 && typeof v.fingerprint === "string") {
        return {
          state: v.state as "dispatching" | "accepted" | "uncertain",
          fingerprint: v.fingerprint as string,
          ...(typeof v.historyId === "number" ? { historyId: v.historyId } : {}),
          ...(v.result !== undefined ? { result: v.result } : {}),
        };
      }
      return { state: "accepted", result: v, legacy: true };
    } catch {
      return undefined;
    }
  }

  clientMsgBegin(
    key: string,
    fingerprint: string,
    scope: "room" | "session",
    scopeId: string,
    entry: HistoryEntry,
  ):
    | { created: boolean; state: "dispatching"; historyId: number }
    | { created: boolean; state: "accepted" | "uncertain"; historyId?: number; result?: unknown; legacy?: boolean } {
    return this.db.transaction(() => {
      const existing = this.clientMsgReceipt(key);
      if (existing) {
        if (existing.legacy) return { created: false, state: "accepted" as const, result: existing.result, legacy: true };
        if (existing.fingerprint !== fingerprint) throw new Error("client_message_conflict");
        if (existing.state === "accepted") {
          return {
            created: false,
            state: "accepted" as const,
            ...(existing.historyId !== undefined ? { historyId: existing.historyId } : {}),
            ...(existing.result !== undefined ? { result: existing.result } : {}),
          };
        }
        return { created: false, state: existing.state, ...(existing.historyId !== undefined ? { historyId: existing.historyId } : {}) };
      }
      const now = Date.now();
      const cap = 10000;
      let count = (this.prep("SELECT COUNT(*) AS c FROM client_msgs").get() as { c: number }).c;
      // 惰性清理：仅容量阈值或周期（1h）到点才扫过期回执，常态写入不做全表 DELETE
      const sweepDue = now - this.clientMsgSweepAt >= 3600_000;
      if (count >= cap || sweepDue) {
        this.clientMsgSweepAt = now;
        this.prep("DELETE FROM client_msgs WHERE at < ?")
          .run(now - 48 * 3600_000);
        if (count >= cap) {
          count = (this.prep("SELECT COUNT(*) AS c FROM client_msgs").get() as { c: number }).c;
          if (count >= cap) throw new Error("client_message_capacity");
        }
      }
      const r = this.prep(
          "INSERT INTO history(scope, scope_id, at, kind, author, text, client_message_id, mission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(scope, scopeId, entry.at, entry.kind, entry.author, entry.text, entry.clientMessageId ?? null, entry.missionId ?? null);
      const historyId = Number(r.lastInsertRowid);
      if (!(historyId > 0)) throw new Error("client_message_history");
      const receipt = {
        v: 1, fingerprint, historyId, state: "dispatching",
      };
      this.prep("INSERT INTO client_msgs (key, result, at) VALUES (?, ?, ?)")
        .run(key, JSON.stringify(receipt), Date.now());
      return { created: true, state: "dispatching" as const, historyId };
    })() as
      | { created: boolean; state: "dispatching"; historyId: number }
      | { created: boolean; state: "accepted" | "uncertain"; historyId?: number; result?: unknown; legacy?: boolean };
  }

  clientMsgFinish(key: string, state: "accepted" | "uncertain", result?: unknown): void {
    this.db.transaction(() => {
      const cur = this.clientMsgReceipt(key);
      if (!cur || cur.legacy) return;
      const receipt = {
        v: 1,
        fingerprint: cur.fingerprint,
        historyId: cur.historyId,
        state,
        ...(state === "accepted" && result !== undefined ? { result } : {}),
      };
      this.prep("UPDATE client_msgs SET result = ? WHERE key = ?")
        .run(JSON.stringify(receipt), key);
    })();
  }

  readEntries(scope: "room" | "session", scopeId: string, ids: number[]): HistoryItem[] {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return normalizeItems(this.prep(
      `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
       WHERE scope = ? AND scope_id = ? AND id IN (${marks}) ORDER BY id ASC`,
    ).all(scope, scopeId, ...ids) as HistoryItem[]);
  }

  readRoomCards(roomId: string, ids: number[]): HistoryItem[] {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    return this.prep(
        `SELECT id, at, kind, author, text, draft FROM history
         WHERE scope = 'room' AND scope_id = ? AND draft = 0
           AND kind IN ('flow', 'decision') AND id IN (${marks})
         ORDER BY id ASC`,
      )
      .all(roomId, ...ids) as HistoryItem[];
  }

  /** 客户端消息幂等记录：重复提交返回缓存的原结果 */
  clientMsgGet(key: string): unknown | undefined {
    const row = this.prep("SELECT result FROM client_msgs WHERE key = ?")
      .get(key) as { result: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.result) as unknown;
    } catch {
      return undefined;
    }
  }

  clientMsgSet(key: string, result: unknown, cap = 5000): void {
    this.prep("INSERT OR REPLACE INTO client_msgs (key, result, at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(result), Date.now());
    this.prep(
        `DELETE FROM client_msgs WHERE key NOT IN (
           SELECT key FROM client_msgs ORDER BY at DESC, rowid DESC LIMIT ?)`,
      )
      .run(cap);
  }

  /** scope 内最后一条已提交（非草稿）历史条目；不存在返回 undefined */
  lastEntry(scope: "session" | "room", id: string): HistoryItem | undefined {
    const row = this.prep(
        `SELECT id, at, kind, author, text, draft, client_message_id AS clientMessageId, mission_id AS missionId FROM history
         WHERE scope = ? AND scope_id = ? AND draft = 0
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(scope, id) as HistoryItem | undefined;
    return row ? normalizeItems([row])[0] : undefined;
  }

  /** 最后一条已提交（非草稿）用户条目 id；不存在返回 0。turn 游标校验用 */
  lastUserEntryId(scope: "session" | "room", id: string): number {
    const row = this.prep(
        `SELECT id FROM history
         WHERE scope = ? AND scope_id = ? AND kind = 'user' AND draft = 0
         ORDER BY id DESC LIMIT 1`,
      )
      .get(scope, id) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  hasMoreBefore(scope: "session" | "room", id: string, at: number, beforeId?: number): boolean {
    const row = this.prep(
        `SELECT 1 FROM history
         WHERE scope = ? AND scope_id = ? AND (at < ? OR (at = ? AND id < ?))
         LIMIT 1`,
      )
      .get(scope, id, at, at, beforeId ?? -1);
    return row != null;
  }

  deleteRoomEvents(roomId: string): void {
    this.prep("DELETE FROM room_events WHERE room_id = ?").run(roomId);
  }

  memoryAdd(roomId: string, kind: string, text: string, source: string, at: number, expiresAt: number | null): void {
    // 同 room+kind+text 蒸馏重复写入 → 原位刷新时间戳而非堆积副本
    const dup = this.prep("SELECT id FROM memory WHERE room_id = ? AND kind = ? AND text = ? LIMIT 1")
      .get(roomId, kind, text) as { id: number } | undefined;
    if (dup) {
      this.prep("UPDATE memory SET at = ?, expires_at = ?, source = ? WHERE id = ?")
        .run(at, expiresAt, source, dup.id);
      return;
    }
    this.prep(
        "INSERT INTO memory(room_id, kind, text, source, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(roomId, kind, text, source, at, expiresAt);
    this.prep("DELETE FROM memory WHERE room_id = ? AND expires_at IS NOT NULL AND expires_at <= ?")
      .run(roomId, at);
    const over = this.prep("SELECT id FROM memory WHERE room_id = ? ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?")
      .all(roomId, MEMORY_LIMIT) as { id: number }[];
    if (over.length > 0) {
      this.prep(`DELETE FROM memory WHERE id IN (${over.map(() => "?").join(",")})`)
        .run(...over.map((r) => r.id));
    }
  }

  memoryList(roomId: string, now: number, limit = MEMORY_LIMIT): MemoryEntry[] {
    return this.prep(
        "SELECT id, room_id AS roomId, kind, text, source, at, expires_at AS expiresAt FROM memory WHERE room_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(roomId, now, limit) as MemoryEntry[];
  }

  deleteMemory(roomId: string): void {
    this.prep("DELETE FROM memory WHERE room_id = ?").run(roomId);
  }

  /** IFC：房级 sensitivity 标签 + 跨房白名单（默认 shared 兼容） */
  ifcGet(roomId: string): { sensitivity: string; allow: string[] } {
    const row = this.prep("SELECT sensitivity, allow FROM room_ifc WHERE room_id = ?")
      .get(roomId) as { sensitivity: string; allow: string } | undefined;
    if (!row) return { sensitivity: "shared", allow: [] };
    let allow: string[] = [];
    try {
      const a = JSON.parse(row.allow);
      if (Array.isArray(a)) allow = a.map(String);
    } catch {}
    return { sensitivity: row.sensitivity, allow };
  }

  ifcSet(roomId: string, sensitivity: string): void {
    this.prep(
        "INSERT INTO room_ifc(room_id, sensitivity, allow) VALUES (?, ?, '[]') ON CONFLICT(room_id) DO UPDATE SET sensitivity = excluded.sensitivity",
      )
      .run(roomId, sensitivity);
  }

  ifcAllow(roomId: string, allowRoomId: string, allowed: boolean): void {
    const cur = this.ifcGet(roomId);
    const set = new Set(cur.allow);
    if (allowed) set.add(allowRoomId);
    else set.delete(allowRoomId);
    this.prep(
        "INSERT INTO room_ifc(room_id, sensitivity, allow) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET allow = excluded.allow",
      )
      .run(roomId, cur.sensitivity, JSON.stringify([...set]));
  }

  /** 单条删除（房作用域限定，防跨房误删） */
  memoryRemove(roomId: string, id: number): boolean {
    return (
      this.prep("DELETE FROM memory WHERE room_id = ? AND id = ?").run(roomId, id)
        .changes > 0
    );
  }

  deleteHistory(scope: "session" | "room", id: string): void {
    this.prep("DELETE FROM history WHERE scope = ? AND scope_id = ?").run(scope, id);
  }

  renameHistory(scope: "session" | "room", oldId: string, newId: string): void {
    this.prep("UPDATE history SET scope_id = ? WHERE scope = ? AND scope_id = ?")
      .run(newId, scope, oldId);
  }

  search(
    query: string,
    limit = 50,
  ): (HistoryItem & { scope: string; scopeId: string })[] {
    const fts = this.ftsRows(query, "", [], limit);
    if (fts) return fts;
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.prep(
        `SELECT id, scope, scope_id AS scopeId, at, kind, author, text FROM history
         WHERE text LIKE ? ESCAPE '\\'
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as (HistoryItem & {
      scope: string;
      scopeId: string;
    })[];
  }

  searchByScope(
    query: string,
    scope: "session" | "room",
    scopeId: string,
    limit = 200,
  ): (HistoryItem & { scope: string; scopeId: string })[] {
    const fts = this.ftsRows(query, "AND h.scope = ? AND h.scope_id = ?", [scope, scopeId], limit);
    if (fts) return fts;
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.prep(
        `SELECT id, scope, scope_id AS scopeId, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND text LIKE ? ESCAPE '\\'
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, scopeId, `%${escaped}%`, limit) as (HistoryItem & {
      scope: string;
      scopeId: string;
    })[];
  }

  searchGroups(
    query: string,
    groupLimit = 20,
    previewLimit = 1,
  ): {
    scope: string;
    scopeId: string;
    count: number;
    previews: (HistoryItem & { scope: string; scopeId: string })[];
  }[] {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const expr = this.hasFts ? this.ftsExpr(query) : null;
    let groups = expr
      ? (this.prep(
            `SELECT h.scope, h.scope_id AS scopeId, COUNT(*) AS count, MAX(h.at) AS latestAt
             FROM history_fts JOIN history h ON h.id = history_fts.rowid
             WHERE history_fts MATCH ?
             GROUP BY h.scope, h.scope_id
             ORDER BY latestAt DESC
             LIMIT ?`,
          )
          .all(expr, groupLimit) as {
          scope: "session" | "room";
          scopeId: string;
          count: number;
          latestAt: number;
        }[])
      : [];
    if (!groups.length) {
      groups = this.prep(
          `SELECT scope, scope_id AS scopeId, COUNT(*) AS count, MAX(at) AS latestAt
           FROM history
           WHERE text LIKE ? ESCAPE '\\'
           GROUP BY scope, scope_id
           ORDER BY latestAt DESC
           LIMIT ?`,
        )
        .all(`%${escaped}%`, groupLimit) as {
        scope: "session" | "room";
        scopeId: string;
        count: number;
        latestAt: number;
      }[];
    }
    return groups.map((g) => {
      const previews =
        this.ftsRows(query, "AND h.scope = ? AND h.scope_id = ?", [g.scope, g.scopeId], previewLimit) ??
        (this.prep(
            `SELECT id, scope, scope_id AS scopeId, at, kind, author, text FROM history
             WHERE scope = ? AND scope_id = ? AND text LIKE ? ESCAPE '\\'
             ORDER BY at DESC, id DESC
             LIMIT ?`,
          )
          .all(g.scope, g.scopeId, `%${escaped}%`, previewLimit) as (HistoryItem & {
          scope: string;
          scopeId: string;
        })[]);
      return { scope: g.scope, scopeId: g.scopeId, count: g.count, previews };
    });
  }

}
