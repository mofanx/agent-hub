import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, Room, RoomEvent } from "./room.js";
import { logWarn } from "./logger.js";

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

type HistoryItem = HistoryEntry & { id: number; at: number };

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

  appendRoomEvent(
    roomId: string,
    type: string,
    payload: Record<string, unknown>,
  ): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM room_events WHERE room_id = ?")
      .get(roomId) as { m: number };
    const seq = (row?.m ?? 0) + 1;
    this.db
      .prepare(
        "INSERT INTO room_events(room_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(roomId, seq, Date.now(), type, JSON.stringify(payload));
    return seq;
  }

  getRoomEvents(
    roomId: string,
    since = 0,
  ): { seq: number; at: number; type: string; payload: Record<string, unknown> }[] {
    const rows = this.db
      .prepare(
        "SELECT seq, at, type, payload FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq",
      )
      .all(roomId, since) as { seq: number; at: number; type: string; payload: string }[];
    return rows.map((r) => ({ seq: r.seq, at: r.at, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  }

  saveFlowSnapshot(roomId: string, seq: number, snapshot: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO flow_snapshots(room_id, seq, at, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET seq = excluded.seq, at = excluded.at, snapshot = excluded.snapshot",
      )
      .run(roomId, seq, Date.now(), JSON.stringify(snapshot));
  }

  getMaxRoomSeq(roomId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM room_events WHERE room_id = ?")
      .get(roomId) as { m: number } | undefined;
    return row?.m ?? 0;
  }

  loadFlowSnapshot(roomId: string): { seq: number; snapshot: Record<string, unknown> } | undefined {
    const row = this.db
      .prepare("SELECT seq, snapshot FROM flow_snapshots WHERE room_id = ?")
      .get(roomId) as { seq: number; snapshot: string } | undefined;
    return row ? { seq: row.seq, snapshot: JSON.parse(row.snapshot) as Record<string, unknown> } : undefined;
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
    `);
    this.migrateSchema();
    this.seedRoles();
    this.migrateLegacy();
    this.prune();
  }

  /** 表只增不删会无限膨胀；启动时把每组历史/每房事件裁剪到最近 N 条（保留 seq 最新的尾部） */
  private prune(): void {
    try {
      this.db.transaction(() => {
        const h = this.db
          .prepare(
            `DELETE FROM history WHERE id IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY scope, scope_id ORDER BY id DESC) AS rn
                FROM history
              ) WHERE rn > ?)`,
          )
          .run(HISTORY_PRUNE_KEEP);
        const e = this.db
          .prepare(
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
      const count = this.db
        .prepare("SELECT COUNT(*) AS c FROM history")
        .get() as { c: number };
      const hasState = this.db
        .prepare("SELECT value FROM meta WHERE key = 'state'")
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
      const insert = this.db.prepare(
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
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number };
    if (count.c > 0) return;
    const insert = this.db.prepare(
      "INSERT INTO roles(id, name, agent, address, connectionId, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of BUILTIN_ROLES) {
      insert.run(r.id, r.name, r.agent ?? null, r.address ?? null, r.connectionId ?? null, r.cwd ?? null, r.persona, 1);
    }
    console.log(`[store] seeded ${BUILTIN_ROLES.length} builtin roles`);
  }

  listConnections(): Connection[] {
    const rows = this.db
      .prepare("SELECT id, name, agent, token, address, cwd, local, lastSeen FROM connections ORDER BY rowid")
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
    this.db
      .prepare("INSERT INTO connections(id, name, agent, token, address, cwd, local) VALUES (?, ?, ?, ?, ?, ?, ?)")
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
    this.db.prepare(`UPDATE connections SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  deleteConnection(id: string): boolean {
    const res = this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    return res.changes > 0;
  }

  listRoles(): Role[] {
    const rows = this.db
      .prepare("SELECT id, name, agent, address, connectionId, cwd, persona, builtin FROM roles ORDER BY builtin DESC, rowid")
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
    this.db
      .prepare("INSERT INTO roles(id, name, agent, address, connectionId, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run(role.id, role.name, role.agent ?? null, role.address ?? null, role.connectionId ?? null, role.cwd ?? null, role.persona);
  }

  /** 只能删除非内置角色 */
  deleteRole(id: string): boolean {
    const res = this.db.prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").run(id);
    return res.changes > 0;
  }

  getMeta(key: string): string | undefined {
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** 已落库的 state 拆行行快照（key→json），save 时按行 diff 只写脏项 */
  private savedRows = new Map<string, string>();

  load(): State {
    try {
      const rows = this.db
        .prepare("SELECT key, value FROM meta WHERE key LIKE 'state:%'")
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
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'state'")
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
      const up = this.db.prepare(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      for (const [k, v] of changed) up.run(k, v);
      const del = this.db.prepare("DELETE FROM meta WHERE key = ?");
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
      const r = this.db
        .prepare(
          "INSERT INTO history(scope, scope_id, at, kind, author, text) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(scope, id, entry.at, entry.kind, entry.author, entry.text);
      return Number(r.lastInsertRowid);
    } catch (err) {
      logWarn("store", `append failed: ${String(err)}`);
      return -1;
    }
  }

  beginReplyDraft(scope: "session" | "room", id: string, entry: HistoryEntry): number {
    try {
      const r = this.db
        .prepare(
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
      this.db
        .prepare("UPDATE history SET text = ? WHERE id = ? AND draft = 1")
        .run(text, rowId);
    } catch (err) {
      logWarn("store", `updateReplyDraft failed: ${String(err)}`);
    }
  }

  completeReplyDraft(rowId: number, text: string): void {
    try {
      this.db
        .prepare("UPDATE history SET text = ?, draft = 0, at = ? WHERE id = ? AND draft = 1")
        .run(text, Date.now(), rowId);
    } catch (err) {
      logWarn("store", `completeReplyDraft failed: ${String(err)}`);
    }
  }

  interruptReplyDraft(rowId: number): void {
    try {
      this.db
        .prepare(
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
        const rows = this.db
          .prepare("SELECT id, scope, scope_id AS scopeId, text FROM history WHERE draft = 1")
          .all() as { id: number; scope: "session" | "room"; scopeId: string; text: string }[];
        const finalize = this.db.prepare(
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
      const rows = this.db
        .prepare(
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
      const rows = this.db
        .prepare(
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
      this.db.prepare("UPDATE history SET text = ? WHERE id = ?").run(text, rowId);
    } catch (err) {
      logWarn("store", `updateEntry failed: ${String(err)}`);
    }
  }

  copyHistory(scope: "session" | "room", sourceId: string, targetId: string): void {
    try {
      this.db
        .prepare(
          "INSERT INTO history(scope, scope_id, at, kind, author, text) SELECT scope, ?, at, kind, author, text FROM history WHERE scope = ? AND scope_id = ? ORDER BY id",
        )
        .run(targetId, scope, sourceId);
    } catch (err) {
      logWarn("store", `copyHistory failed: ${String(err)}`);
    }
  }

  read(scope: "session" | "room", id: string, limit = HISTORY_LIMIT): HistoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, limit) as HistoryItem[];
    return rows.reverse();
  }

  readAround(
    scope: "session" | "room",
    id: string,
    at: number,
    limit = 50,
  ): HistoryItem[] {
    const before = this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND at <= ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[];
    const after = this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND at >= ?
         ORDER BY at ASC, id ASC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[];
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
    const rows = this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND (at < ? OR (at = ? AND id < ?))
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, at, at, beforeId ?? -1, limit) as HistoryItem[];
    return rows.reverse();
  }

  readAfter(
    scope: "session" | "room",
    id: string,
    at: number,
    limit = 200,
  ): HistoryItem[] {
    return this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND at >= ?
         ORDER BY at ASC, id ASC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[];
  }

  /** 最后一条已提交（非草稿）用户条目 id；不存在返回 0。turn 游标校验用 */
  lastUserEntryId(scope: "session" | "room", id: string): number {
    const row = this.db
      .prepare(
        `SELECT id FROM history
         WHERE scope = ? AND scope_id = ? AND kind = 'user' AND draft = 0
         ORDER BY id DESC LIMIT 1`,
      )
      .get(scope, id) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  hasMoreBefore(scope: "session" | "room", id: string, at: number, beforeId?: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM history
         WHERE scope = ? AND scope_id = ? AND (at < ? OR (at = ? AND id < ?))
         LIMIT 1`,
      )
      .get(scope, id, at, at, beforeId ?? -1);
    return row != null;
  }

  deleteRoomEvents(roomId: string): void {
    this.db.prepare("DELETE FROM room_events WHERE room_id = ?").run(roomId);
  }

  deleteHistory(scope: "session" | "room", id: string): void {
    this.db.prepare("DELETE FROM history WHERE scope = ? AND scope_id = ?").run(scope, id);
  }

  renameHistory(scope: "session" | "room", oldId: string, newId: string): void {
    this.db
      .prepare("UPDATE history SET scope_id = ? WHERE scope = ? AND scope_id = ?")
      .run(newId, scope, oldId);
  }

  search(
    query: string,
    limit = 50,
  ): (HistoryItem & { scope: string; scopeId: string })[] {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.db
      .prepare(
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
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.db
      .prepare(
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
    const groups = this.db
      .prepare(
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
    return groups.map((g) => {
      const previews = this.db
        .prepare(
          `SELECT id, scope, scope_id AS scopeId, at, kind, author, text FROM history
           WHERE scope = ? AND scope_id = ? AND text LIKE ? ESCAPE '\\'
           ORDER BY at DESC, id DESC
           LIMIT ?`,
        )
        .all(g.scope, g.scopeId, `%${escaped}%`, previewLimit) as (HistoryItem & {
        scope: string;
        scopeId: string;
      })[];
      return { scope: g.scope, scopeId: g.scopeId, count: g.count, previews };
    });
  }

}
