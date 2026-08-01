import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Room } from "./room.js";

export type SessionMeta = {
  sessionId: string;
  cwd: string;
  name: string;
  agent: string;
  archived?: boolean;
};

export type HistoryEntry = {
  at: number;
  kind: "user" | "assistant" | "system";
  author: string;
  text: string;
};

export type Role = {
  id: string;
  name: string;
  agent?: string | undefined;
  cwd?: string | undefined;
  persona: string;
  builtin?: boolean;
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

type State = { sessions: SessionMeta[]; rooms: Room[] };

const HISTORY_LIMIT = 200;

export class Store {
  readonly dir: string;
  private db: Database.Database;

  constructor(dir?: string) {
    this.dir =
      dir ??
      process.env.HUB_DATA_DIR ??
      path.resolve(new URL("..", import.meta.url).pathname, "data");
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
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent TEXT,
        cwd TEXT,
        persona TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.seedRoles();
    this.migrateLegacy();
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
      console.warn("[store] legacy migration failed:", err);
    }
  }

  private seedRoles(): void {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number };
    if (count.c > 0) return;
    const insert = this.db.prepare(
      "INSERT INTO roles(id, name, agent, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of BUILTIN_ROLES) {
      insert.run(r.id, r.name, r.agent ?? null, r.cwd ?? null, r.persona, 1);
    }
    console.log(`[store] seeded ${BUILTIN_ROLES.length} builtin roles`);
  }

  listRoles(): Role[] {
    const rows = this.db
      .prepare("SELECT id, name, agent, cwd, persona, builtin FROM roles ORDER BY builtin DESC, rowid")
      .all() as { id: string; name: string; agent: string | null; cwd: string | null; persona: string; builtin: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      agent: r.agent ?? undefined,
      cwd: r.cwd ?? undefined,
      persona: r.persona,
      builtin: r.builtin === 1,
    }));
  }

  addRole(role: Role): void {
    this.db
      .prepare("INSERT INTO roles(id, name, agent, cwd, persona, builtin) VALUES (?, ?, ?, ?, ?, 0)")
      .run(role.id, role.name, role.agent ?? null, role.cwd ?? null, role.persona);
  }

  /** 只能删除非内置角色 */
  deleteRole(id: string): boolean {
    const res = this.db.prepare("DELETE FROM roles WHERE id = ? AND builtin = 0").run(id);
    return res.changes > 0;
  }

  load(): State {
    try {
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'state'")
        .get() as { value: string } | undefined;
      if (!row) return { sessions: [], rooms: [] };
      const obj = JSON.parse(row.value);
      return { sessions: obj.sessions ?? [], rooms: obj.rooms ?? [] };
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
      console.warn("[store] append failed:", err);
    }
  }

  read(scope: "session" | "room", id: string, limit = HISTORY_LIMIT): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT at, kind, author, text FROM history
         WHERE scope = ? AND scope_id = ?
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(scope, id, limit) as HistoryEntry[];
    return rows.reverse();
  }

  deleteHistory(scope: "session" | "room", id: string): void {
    this.db.prepare("DELETE FROM history WHERE scope = ? AND scope_id = ?").run(scope, id);
  }

  search(
    query: string,
    limit = 50,
  ): (HistoryEntry & { scope: string; scopeId: string })[] {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.db
      .prepare(
        `SELECT scope, scope_id AS scopeId, at, kind, author, text FROM history
         WHERE text LIKE ? ESCAPE '\\'
         ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as (HistoryEntry & {
      scope: string;
      scopeId: string;
    })[];
  }
}
