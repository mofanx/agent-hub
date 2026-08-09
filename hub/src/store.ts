import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Room } from "./room.js";
import { logWarn } from "./logger.js";

export type Connection = {
  id: string;
  name: string;
  agent: string;
  token: string;
  address?: string | undefined;
  cwd?: string | undefined;
  local?: boolean | undefined;
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
};

export type HistoryEntry = {
  at: number;
  kind: "user" | "assistant" | "system";
  author: string;
  text: string;
};

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

export class Store {
  readonly dir: string;
  private db: Database.Database;

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
        text TEXT NOT NULL
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
    `);
    this.seedRoles();
    this.migrateSchema();
    this.migrateLegacy();
  }

  private migrateSchema(): void {
    try {
      this.db.exec("ALTER TABLE connections ADD COLUMN token TEXT");
    } catch {
      // already exists
    }
    try {
      this.db.exec("ALTER TABLE connections ADD COLUMN local INTEGER NOT NULL DEFAULT 0");
    } catch {
      // already exists
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
      .prepare("SELECT id, name, agent, token, address, cwd, local FROM connections ORDER BY rowid")
      .all() as { id: string; name: string; agent: string; token: string; address: string | null; cwd: string | null; local: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      agent: r.agent,
      token: r.token,
      address: r.address ?? undefined,
      cwd: r.cwd ?? undefined,
      local: r.local === 1,
    }));
  }

  addConnection(c: Connection): void {
    this.db
      .prepare("INSERT INTO connections(id, name, agent, token, address, cwd, local) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.name, c.agent, c.token, c.address ?? null, c.cwd ?? null, c.local ? 1 : 0);
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

  load(): State {
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'state'")
        .get() as { value: string } | undefined;
      if (!row) return { sessions: [], rooms: [] };
      const obj = JSON.parse(row.value);
      return {
        sessions: obj.sessions ?? [],
        rooms: obj.rooms ?? [],
        runtime: typeof obj.runtime === "object" ? obj.runtime : undefined,
      };
    } catch {
      return { sessions: [], rooms: [] };
    }
  }

  save(state: State): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(state));
  }

  append(scope: "session" | "room", id: string, entry: HistoryEntry): void {
    try {
      this.db
        .prepare(
          "INSERT INTO history(scope, scope_id, at, kind, author, text) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(scope, id, entry.at, entry.kind, entry.author, entry.text);
    } catch (err) {
      logWarn("store", `append failed: ${String(err)}`);
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
  ): HistoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ? AND at < ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, at, limit) as HistoryItem[];
    return rows.reverse();
  }

  hasMoreBefore(scope: "session" | "room", id: string, at: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM history
         WHERE scope = ? AND scope_id = ? AND at < ?
         LIMIT 1`,
      )
      .get(scope, id, at);
    return row != null;
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
