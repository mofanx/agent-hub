import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, Room, RoomEvent } from "./room.js";
import { logWarn } from "./logger.js";
import type {
  ProjectScope,
  QualityRun,
  CheckRun,
  ReviewFinding,
  QualityIncident,
  RuleCandidate,
  ReviewerDecision,
  ReviewerDecisionOutcome,
  QualityBenchmark,
  BenchmarkRun,
} from "./quality/types.js";

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
  artifacts?: Artifact[] | undefined;
  events?: RoomEvent[] | undefined;
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
      CREATE TABLE IF NOT EXISTS quality_projects (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        root TEXT NOT NULL,
        git_root TEXT,
        display_name TEXT NOT NULL,
        cap_git INTEGER NOT NULL DEFAULT 0,
        cap_local_exec INTEGER NOT NULL DEFAULT 0,
        cap_remote_exec INTEGER NOT NULL DEFAULT 0,
        cap_isolated_worktree INTEGER NOT NULL DEFAULT 0,
        policy_version TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quality_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        room_id TEXT,
        task_id TEXT,
        implementer_session_id TEXT,
        reviewer_session_id TEXT,
        trigger TEXT NOT NULL,
        stage TEXT NOT NULL,
        risk TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        base_revision TEXT,
        dirty_baseline_hash TEXT,
        patch_hash TEXT,
        fix_round INTEGER NOT NULL DEFAULT 0,
        max_fix_rounds INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        verdict TEXT,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_runs_project
        ON quality_runs(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_runs_stage
        ON quality_runs(stage, updated_at);
      CREATE TABLE IF NOT EXISTS quality_checks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms INTEGER,
        summary TEXT,
        stdout_artifact TEXT,
        stderr_artifact TEXT,
        started_at INTEGER,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_checks_run
        ON quality_checks(run_id, check_id, attempt);
      CREATE TABLE IF NOT EXISTS quality_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        confidence REAL NOT NULL,
        category TEXT NOT NULL,
        file TEXT,
        line INTEGER,
        claim TEXT NOT NULL,
        evidence TEXT NOT NULL,
        reproduction TEXT,
        suggestion TEXT,
        blocking INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        resolution_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quality_findings_run
        ON quality_findings(run_id, status, severity);
      CREATE TABLE IF NOT EXISTS quality_incidents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_run_id TEXT,
        description TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL,
        reproduction TEXT,
        regression_test TEXT,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS idx_quality_incidents_project
        ON quality_incidents(project_id, fingerprint);
      CREATE TABLE IF NOT EXISTS quality_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        rule TEXT NOT NULL,
        evidence_incident_ids TEXT NOT NULL DEFAULT '[]',
        recurrence INTEGER NOT NULL DEFAULT 0,
        measured_impact TEXT,
        status TEXT NOT NULL DEFAULT 'candidate'
      );
      CREATE INDEX IF NOT EXISTS idx_quality_rules_project
        ON quality_rules(project_id, fingerprint, status);
      CREATE TABLE IF NOT EXISTS quality_review_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        finding_count INTEGER NOT NULL DEFAULT 0,
        blocking_count INTEGER NOT NULL DEFAULT 0,
        parse_error TEXT,
        reviewer_session_id TEXT,
        reviewed_at INTEGER NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending',
        resolved_at INTEGER,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quality_review_decisions_project
        ON quality_review_decisions(project_id, reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_quality_review_decisions_outcome
        ON quality_review_decisions(outcome);
      CREATE TABLE IF NOT EXISTS quality_benchmarks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        task_set TEXT NOT NULL,
        agents TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_benchmarks_project
        ON quality_benchmarks(project_id, created_at);
      CREATE TABLE IF NOT EXISTS quality_benchmark_runs (
        id TEXT PRIMARY KEY,
        benchmark_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        quality_run_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        passed_checks INTEGER NOT NULL DEFAULT 0,
        failed_checks INTEGER NOT NULL DEFAULT 0,
        finding_count INTEGER NOT NULL DEFAULT 0,
        blocking_count INTEGER NOT NULL DEFAULT 0,
        fix_rounds INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_benchmark_runs_benchmark
        ON quality_benchmark_runs(benchmark_id, agent);
    `);
    this.migrateSchema();
    this.seedRoles();
    this.migrateLegacy();
  }

  private migrateSchema(): void {
    const columns: { table: string; column: string; def: string }[] = [
      { table: "connections", column: "address", def: "TEXT" },
      { table: "connections", column: "cwd", def: "TEXT" },
      { table: "connections", column: "token", def: "TEXT" },
      { table: "connections", column: "local", def: "INTEGER NOT NULL DEFAULT 0" },
      { table: "roles", column: "agent", def: "TEXT" },
      { table: "roles", column: "address", def: "TEXT" },
      { table: "roles", column: "connectionId", def: "TEXT" },
      { table: "roles", column: "cwd", def: "TEXT" },
      { table: "roles", column: "persona", def: "TEXT NOT NULL DEFAULT ''" },
      { table: "roles", column: "builtin", def: "INTEGER NOT NULL DEFAULT 0" },
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

  updateConnection(id: string, patch: Partial<Omit<Connection, "id">>): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); vals.push(patch.name); }
    if (patch.agent !== undefined) { sets.push("agent = ?"); vals.push(patch.agent); }
    if (patch.token !== undefined) { sets.push("token = ?"); vals.push(patch.token); }
    if (patch.address !== undefined) { sets.push("address = ?"); vals.push(patch.address ?? null); }
    if (patch.cwd !== undefined) { sets.push("cwd = ?"); vals.push(patch.cwd ?? null); }
    if (patch.local !== undefined) { sets.push("local = ?"); vals.push(patch.local ? 1 : 0); }
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

  // ── quality: projects ──────────────────────────────────────────────

  upsertQualityProject(p: ProjectScope): void {
    this.db
      .prepare(
        `INSERT INTO quality_projects(id, connection_id, root, git_root, display_name,
           cap_git, cap_local_exec, cap_remote_exec, cap_isolated_worktree,
           policy_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           connection_id = excluded.connection_id,
           root = excluded.root,
           git_root = excluded.git_root,
           display_name = excluded.display_name,
           cap_git = excluded.cap_git,
           cap_local_exec = excluded.cap_local_exec,
           cap_remote_exec = excluded.cap_remote_exec,
           cap_isolated_worktree = excluded.cap_isolated_worktree,
           policy_version = excluded.policy_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        p.id, p.connectionId, p.root, p.gitRoot ?? null, p.displayName,
        p.capabilities.git ? 1 : 0, p.capabilities.localExec ? 1 : 0,
        p.capabilities.remoteExec ? 1 : 0, p.capabilities.isolatedWorktree ? 1 : 0,
        p.policyVersion ?? null, p.createdAt, p.updatedAt,
      );
  }

  getQualityProject(id: string): ProjectScope | undefined {
    const r = this.db
      .prepare("SELECT * FROM quality_projects WHERE id = ?")
      .get(id) as QualityProjectRow | undefined;
    return r ? rowToProject(r) : undefined;
  }

  listQualityProjects(): ProjectScope[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_projects ORDER BY updated_at DESC")
      .all() as QualityProjectRow[];
    return rows.map(rowToProject);
  }

  deleteQualityProject(id: string): boolean {
    return this.db.prepare("DELETE FROM quality_projects WHERE id = ?").run(id).changes > 0;
  }

  // ── quality: runs ──────────────────────────────────────────────────

  saveQualityRun(run: QualityRun): void {
    this.db
      .prepare(
        `INSERT INTO quality_runs(id, project_id, room_id, task_id, implementer_session_id,
           reviewer_session_id, trigger, stage, risk, policy_version, base_revision,
           dirty_baseline_hash, patch_hash, fix_round, max_fix_rounds, timeout_ms,
           verdict, failure_code, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           room_id = excluded.room_id,
           task_id = excluded.task_id,
           implementer_session_id = excluded.implementer_session_id,
           reviewer_session_id = excluded.reviewer_session_id,
           trigger = excluded.trigger,
           stage = excluded.stage,
           risk = excluded.risk,
           policy_version = excluded.policy_version,
           base_revision = excluded.base_revision,
           dirty_baseline_hash = excluded.dirty_baseline_hash,
           patch_hash = excluded.patch_hash,
           fix_round = excluded.fix_round,
           max_fix_rounds = excluded.max_fix_rounds,
           timeout_ms = excluded.timeout_ms,
           verdict = excluded.verdict,
           failure_code = excluded.failure_code,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        run.id, run.projectId, run.roomId ?? null, run.taskId ?? null,
        run.implementerSessionId ?? null, run.reviewerSessionId ?? null,
        run.trigger, run.stage, run.risk, run.policyVersion,
        run.baseRevision ?? null, run.dirtyBaselineHash ?? null, run.patchHash ?? null,
        run.fixRound, run.budget.maxFixRounds, run.budget.timeoutMs,
        run.verdict ?? null, run.failureCode ?? null,
        run.createdAt, run.updatedAt, run.completedAt ?? null,
      );
  }

  getQualityRun(id: string): QualityRun | undefined {
    const r = this.db
      .prepare("SELECT * FROM quality_runs WHERE id = ?")
      .get(id) as QualityRunRow | undefined;
    return r ? rowToRun(r) : undefined;
  }

  listQualityRuns(projectId?: string, limit = 100): QualityRun[] {
    const sql = projectId
      ? "SELECT * FROM quality_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM quality_runs ORDER BY created_at DESC LIMIT ?";
    const rows = (projectId
      ? this.db.prepare(sql).all(projectId, limit)
      : this.db.prepare(sql).all(limit)) as QualityRunRow[];
    return rows.map(rowToRun);
  }

  listQualityRunsByStage(stage: string, limit = 100): QualityRun[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_runs WHERE stage = ? ORDER BY updated_at DESC LIMIT ?")
      .all(stage, limit) as QualityRunRow[];
    return rows.map(rowToRun);
  }

  deleteQualityRun(id: string): boolean {
    return this.db.prepare("DELETE FROM quality_runs WHERE id = ?").run(id).changes > 0;
  }

  // ── quality: checks ────────────────────────────────────────────────

  saveQualityCheck(c: CheckRun): void {
    this.db
      .prepare(
        `INSERT INTO quality_checks(id, run_id, check_id, attempt, status, exit_code,
           duration_ms, summary, stdout_artifact, stderr_artifact, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           duration_ms = excluded.duration_ms,
           summary = excluded.summary,
           stdout_artifact = excluded.stdout_artifact,
           stderr_artifact = excluded.stderr_artifact,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        c.id, c.runId, c.checkId, c.attempt, c.status,
        c.exitCode ?? null, c.durationMs ?? null, c.summary ?? null,
        c.stdoutArtifact ?? null, c.stderrArtifact ?? null,
        c.startedAt ?? null, c.completedAt ?? null,
      );
  }

  listQualityChecks(runId: string): CheckRun[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_checks WHERE run_id = ? ORDER BY attempt, check_id")
      .all(runId) as QualityCheckRow[];
    return rows.map(rowToCheck);
  }

  // ── quality: findings ──────────────────────────────────────────────

  saveQualityFinding(f: ReviewFinding): void {
    this.db
      .prepare(
        `INSERT INTO quality_findings(id, run_id, severity, confidence, category, file, line,
           claim, evidence, reproduction, suggestion, blocking, status, resolution_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           severity = excluded.severity,
           confidence = excluded.confidence,
           category = excluded.category,
           file = excluded.file,
           line = excluded.line,
           claim = excluded.claim,
           evidence = excluded.evidence,
           reproduction = excluded.reproduction,
           suggestion = excluded.suggestion,
           blocking = excluded.blocking,
           status = excluded.status,
           resolution_note = excluded.resolution_note`,
      )
      .run(
        f.id, f.runId, f.severity, f.confidence, f.category,
        f.file ?? null, f.line ?? null, f.claim, f.evidence,
        f.reproduction ?? null, f.suggestion ?? null, f.blocking ? 1 : 0,
        f.status, f.resolutionNote ?? null,
      );
  }

  listQualityFindings(runId: string): ReviewFinding[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_findings WHERE run_id = ? ORDER BY severity, confidence DESC")
      .all(runId) as QualityFindingRow[];
    return rows.map(rowToFinding);
  }

  getQualityFinding(id: string): ReviewFinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM quality_findings WHERE id = ?")
      .get(id) as QualityFindingRow | undefined;
    return row ? rowToFinding(row) : undefined;
  }

  /** 更新 finding 状态和 resolutionNote（Q2-03）。 */
  updateQualityFindingStatus(id: string, status: ReviewFinding["status"], resolutionNote?: string): boolean {
    const existing = this.getQualityFinding(id);
    if (!existing) return false;
    this.db
      .prepare("UPDATE quality_findings SET status = ?, resolution_note = ? WHERE id = ?")
      .run(status, resolutionNote ?? existing.resolutionNote ?? null, id);
    return true;
  }

  // ── quality: incidents ─────────────────────────────────────────────

  saveQualityIncident(i: QualityIncident): void {
    this.db
      .prepare(
        `INSERT INTO quality_incidents(id, project_id, source_run_id, description, fingerprint,
           severity, reproduction, regression_test, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           fingerprint = excluded.fingerprint,
           severity = excluded.severity,
           reproduction = excluded.reproduction,
           regression_test = excluded.regression_test,
           status = excluded.status`,
      )
      .run(
        i.id, i.projectId, i.sourceRunId ?? null, i.description,
        i.fingerprint, i.severity, i.reproduction ?? null,
        i.regressionTest ?? null, i.status,
      );
  }

  listQualityIncidents(projectId?: string): QualityIncident[] {
    const rows = (projectId
      ? this.db.prepare("SELECT * FROM quality_incidents WHERE project_id = ? ORDER BY rowid DESC").all(projectId)
      : this.db.prepare("SELECT * FROM quality_incidents ORDER BY rowid DESC").all()) as QualityIncidentRow[];
    return rows.map(rowToIncident);
  }

  getQualityIncident(id: string): QualityIncident | undefined {
    const row = this.db.prepare("SELECT * FROM quality_incidents WHERE id = ?").get(id) as QualityIncidentRow | undefined;
    return row ? rowToIncident(row) : undefined;
  }

  /** 按 project + fingerprint 查询同源 incident（P4 自动沉淀用）。 */
  listQualityIncidentsByFingerprint(projectId: string, fingerprint: string): QualityIncident[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_incidents WHERE project_id = ? AND fingerprint = ? ORDER BY rowid ASC")
      .all(projectId, fingerprint) as QualityIncidentRow[];
    return rows.map(rowToIncident);
  }

  deleteQualityIncident(id: string): boolean {
    const info = this.db.prepare("DELETE FROM quality_incidents WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // ── quality: rules ─────────────────────────────────────────────────

  saveQualityRule(r: RuleCandidate): void {
    this.db
      .prepare(
        `INSERT INTO quality_rules(id, project_id, fingerprint, rule, evidence_incident_ids,
           recurrence, measured_impact, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           rule = excluded.rule,
           evidence_incident_ids = excluded.evidence_incident_ids,
           recurrence = excluded.recurrence,
           measured_impact = excluded.measured_impact,
           status = excluded.status`,
      )
      .run(
        r.id, r.projectId, r.fingerprint, r.rule,
        JSON.stringify(r.evidenceIncidentIds), r.recurrence,
        r.measuredImpact ?? null, r.status,
      );
  }

  listQualityRules(projectId?: string): RuleCandidate[] {
    const rows = (projectId
      ? this.db.prepare("SELECT * FROM quality_rules WHERE project_id = ? ORDER BY rowid DESC").all(projectId)
      : this.db.prepare("SELECT * FROM quality_rules ORDER BY rowid DESC").all()) as QualityRuleRow[];
    return rows.map(rowToRule);
  }

  getQualityRule(id: string): RuleCandidate | undefined {
    const row = this.db.prepare("SELECT * FROM quality_rules WHERE id = ?").get(id) as QualityRuleRow | undefined;
    return row ? rowToRule(row) : undefined;
  }

  deleteQualityRule(id: string): boolean {
    const info = this.db.prepare("DELETE FROM quality_rules WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // ── quality: benchmarks (P4) ───────────────────────────────────────

  saveQualityBenchmark(b: QualityBenchmark): QualityBenchmark {
    this.db
      .prepare(
        `INSERT INTO quality_benchmarks(id, project_id, name, task_set, agents,
           status, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           task_set = excluded.task_set,
           agents = excluded.agents,
           status = excluded.status,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        b.id, b.projectId, b.name, b.taskSet,
        JSON.stringify(b.agents), b.status,
        b.createdAt, b.updatedAt, b.completedAt ?? null,
      );
    for (const run of b.runs) {
      this.saveQualityBenchmarkRun(run);
    }
    return b;
  }

  saveQualityBenchmarkRun(r: BenchmarkRun): void {
    this.db
      .prepare(
        `INSERT INTO quality_benchmark_runs(id, benchmark_id, agent, quality_run_id,
           status, passed_checks, failed_checks, finding_count, blocking_count,
           fix_rounds, duration_ms, failure_reason, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           quality_run_id = excluded.quality_run_id,
           status = excluded.status,
           passed_checks = excluded.passed_checks,
           failed_checks = excluded.failed_checks,
           finding_count = excluded.finding_count,
           blocking_count = excluded.blocking_count,
           fix_rounds = excluded.fix_rounds,
           duration_ms = excluded.duration_ms,
           failure_reason = excluded.failure_reason,
           updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        r.id, r.benchmarkId, r.agent, r.qualityRunId ?? null,
        r.status, r.passedChecks, r.failedChecks, r.findingCount,
        r.blockingCount, r.fixRounds, r.durationMs, r.failureReason ?? null,
        r.createdAt, r.updatedAt, r.completedAt ?? null,
      );
  }

  listQualityBenchmarks(projectId?: string): QualityBenchmark[] {
    const rows = (projectId
      ? this.db.prepare("SELECT * FROM quality_benchmarks WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
      : this.db.prepare("SELECT * FROM quality_benchmarks ORDER BY created_at DESC").all()) as QualityBenchmarkRow[];
    return rows.map((r) => rowToBenchmark(r, this.listQualityBenchmarkRuns(r.id)));
  }

  getQualityBenchmark(id: string): QualityBenchmark | undefined {
    const row = this.db.prepare("SELECT * FROM quality_benchmarks WHERE id = ?").get(id) as QualityBenchmarkRow | undefined;
    if (!row) return undefined;
    return rowToBenchmark(row, this.listQualityBenchmarkRuns(id));
  }

  listQualityBenchmarkRuns(benchmarkId: string): BenchmarkRun[] {
    const rows = this.db
      .prepare("SELECT * FROM quality_benchmark_runs WHERE benchmark_id = ? ORDER BY created_at ASC")
      .all(benchmarkId) as QualityBenchmarkRunRow[];
    return rows.map(rowToBenchmarkRun);
  }

  deleteQualityBenchmark(id: string): boolean {
    this.db.prepare("DELETE FROM quality_benchmark_runs WHERE benchmark_id = ?").run(id);
    const info = this.db.prepare("DELETE FROM quality_benchmarks WHERE id = ?").run(id);
    return info.changes > 0;
  }

  // ── quality: review decisions (Q2-07) ──────────────────────────────

  saveQualityReviewDecision(d: ReviewerDecision): void {
    this.db
      .prepare(
        `INSERT INTO quality_review_decisions(id, run_id, project_id, verdict,
           finding_count, blocking_count, parse_error, reviewer_session_id,
           reviewed_at, outcome, resolved_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           verdict = excluded.verdict,
           finding_count = excluded.finding_count,
           blocking_count = excluded.blocking_count,
           parse_error = excluded.parse_error,
           reviewer_session_id = excluded.reviewer_session_id,
           outcome = excluded.outcome,
           resolved_at = excluded.resolved_at,
           note = excluded.note`,
      )
      .run(
        d.id, d.runId, d.projectId, d.verdict,
        d.findingCount, d.blockingCount,
        d.parseError ?? null, d.reviewerSessionId ?? null,
        d.reviewedAt, d.outcome, d.resolvedAt ?? null, d.note ?? null,
      );
  }

  getQualityReviewDecision(id: string): ReviewerDecision | undefined {
    const row = this.db
      .prepare("SELECT * FROM quality_review_decisions WHERE id = ?")
      .get(id) as QualityReviewDecisionRow | undefined;
    return row ? rowToReviewDecision(row) : undefined;
  }

  getQualityReviewDecisionByRun(runId: string): ReviewerDecision | undefined {
    const row = this.db
      .prepare("SELECT * FROM quality_review_decisions WHERE run_id = ? ORDER BY reviewed_at DESC LIMIT 1")
      .get(runId) as QualityReviewDecisionRow | undefined;
    return row ? rowToReviewDecision(row) : undefined;
  }

  listQualityReviewDecisions(projectId?: string, limit?: number): ReviewerDecision[] {
    const sql = projectId
      ? "SELECT * FROM quality_review_decisions WHERE project_id = ? ORDER BY reviewed_at DESC LIMIT ?"
      : "SELECT * FROM quality_review_decisions ORDER BY reviewed_at DESC LIMIT ?";
    const rows = (projectId
      ? this.db.prepare(sql).all(projectId, limit ?? 1000)
      : this.db.prepare(sql).all(limit ?? 1000)) as QualityReviewDecisionRow[];
    return rows.map(rowToReviewDecision);
  }

  /** 更新 decision 的 outcome（finding 被 resolve 时调用）。 */
  updateQualityReviewDecisionOutcome(
    id: string,
    outcome: ReviewerDecisionOutcome,
    note?: string,
  ): boolean {
    const existing = this.getQualityReviewDecision(id);
    if (!existing) return false;
    this.db
      .prepare("UPDATE quality_review_decisions SET outcome = ?, resolved_at = ?, note = ? WHERE id = ?")
      .run(outcome, Date.now(), note ?? existing.note ?? null, id);
    return true;
  }
}

// ── row mappers ───────────────────────────────────────────────────────

type QualityProjectRow = {
  id: string; connection_id: string; root: string; git_root: string | null;
  display_name: string; cap_git: number; cap_local_exec: number;
  cap_remote_exec: number; cap_isolated_worktree: number;
  policy_version: string | null; created_at: number; updated_at: number;
};

function rowToProject(r: QualityProjectRow): ProjectScope {
  return {
    id: r.id,
    connectionId: r.connection_id,
    root: r.root,
    gitRoot: r.git_root ?? undefined,
    displayName: r.display_name,
    capabilities: {
      git: r.cap_git === 1,
      localExec: r.cap_local_exec === 1,
      remoteExec: r.cap_remote_exec === 1,
      isolatedWorktree: r.cap_isolated_worktree === 1,
    },
    policyVersion: r.policy_version ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type QualityRunRow = {
  id: string; project_id: string; room_id: string | null; task_id: string | null;
  implementer_session_id: string | null; reviewer_session_id: string | null;
  trigger: string; stage: string; risk: string; policy_version: string;
  base_revision: string | null; dirty_baseline_hash: string | null;
  patch_hash: string | null; fix_round: number; max_fix_rounds: number;
  timeout_ms: number; verdict: string | null; failure_code: string | null;
  created_at: number; updated_at: number; completed_at: number | null;
};

function rowToRun(r: QualityRunRow): QualityRun {
  return {
    id: r.id,
    projectId: r.project_id,
    roomId: r.room_id ?? undefined,
    taskId: r.task_id ?? undefined,
    implementerSessionId: r.implementer_session_id ?? undefined,
    reviewerSessionId: r.reviewer_session_id ?? undefined,
    trigger: r.trigger as QualityRun["trigger"],
    stage: r.stage as QualityRun["stage"],
    risk: r.risk as QualityRun["risk"],
    policyVersion: r.policy_version,
    baseRevision: r.base_revision ?? undefined,
    dirtyBaselineHash: r.dirty_baseline_hash ?? undefined,
    patchHash: r.patch_hash ?? undefined,
    fixRound: r.fix_round,
    budget: { maxFixRounds: r.max_fix_rounds, timeoutMs: r.timeout_ms },
    verdict: (r.verdict as QualityRun["verdict"]) ?? undefined,
    failureCode: r.failure_code ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? undefined,
  };
}

type QualityCheckRow = {
  id: string; run_id: string; check_id: string; attempt: number;
  status: string; exit_code: number | null; duration_ms: number | null;
  summary: string | null; stdout_artifact: string | null;
  stderr_artifact: string | null; started_at: number | null;
  completed_at: number | null;
};

function rowToCheck(r: QualityCheckRow): CheckRun {
  return {
    id: r.id,
    runId: r.run_id,
    checkId: r.check_id,
    attempt: r.attempt,
    status: r.status as CheckRun["status"],
    exitCode: r.exit_code ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    summary: r.summary ?? undefined,
    stdoutArtifact: r.stdout_artifact ?? undefined,
    stderrArtifact: r.stderr_artifact ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
  };
}

type QualityFindingRow = {
  id: string; run_id: string; severity: string; confidence: number;
  category: string; file: string | null; line: number | null;
  claim: string; evidence: string; reproduction: string | null;
  suggestion: string | null; blocking: number; status: string;
  resolution_note: string | null;
};

function rowToFinding(r: QualityFindingRow): ReviewFinding {
  return {
    id: r.id,
    runId: r.run_id,
    severity: r.severity as ReviewFinding["severity"],
    confidence: r.confidence,
    category: r.category as ReviewFinding["category"],
    file: r.file ?? undefined,
    line: r.line ?? undefined,
    claim: r.claim,
    evidence: r.evidence,
    reproduction: r.reproduction ?? undefined,
    suggestion: r.suggestion ?? undefined,
    blocking: r.blocking === 1,
    status: r.status as ReviewFinding["status"],
    resolutionNote: r.resolution_note ?? undefined,
  };
}

type QualityIncidentRow = {
  id: string; project_id: string; source_run_id: string | null;
  description: string; fingerprint: string; severity: string;
  reproduction: string | null; regression_test: string | null; status: string;
};

function rowToIncident(r: QualityIncidentRow): QualityIncident {
  return {
    id: r.id,
    projectId: r.project_id,
    sourceRunId: r.source_run_id ?? undefined,
    description: r.description,
    fingerprint: r.fingerprint,
    severity: r.severity,
    reproduction: r.reproduction ?? undefined,
    regressionTest: r.regression_test ?? undefined,
    status: r.status as QualityIncident["status"],
  };
}

type QualityRuleRow = {
  id: string; project_id: string; fingerprint: string; rule: string;
  evidence_incident_ids: string; recurrence: number;
  measured_impact: string | null; status: string;
};

function rowToRule(r: QualityRuleRow): RuleCandidate {
  let ids: string[] = [];
  try { ids = JSON.parse(r.evidence_incident_ids) as string[]; } catch { /* keep empty */ }
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprint: r.fingerprint,
    rule: r.rule,
    evidenceIncidentIds: ids,
    recurrence: r.recurrence,
    measuredImpact: r.measured_impact ?? undefined,
    status: r.status as RuleCandidate["status"],
  };
}

type QualityReviewDecisionRow = {
  id: string; run_id: string; project_id: string; verdict: string;
  finding_count: number; blocking_count: number; parse_error: string | null;
  reviewer_session_id: string | null; reviewed_at: number;
  outcome: string; resolved_at: number | null; note: string | null;
};

function rowToReviewDecision(r: QualityReviewDecisionRow): ReviewerDecision {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    verdict: r.verdict as ReviewerDecision["verdict"],
    findingCount: r.finding_count,
    blockingCount: r.blocking_count,
    ...(r.parse_error !== null ? { parseError: r.parse_error } : {}),
    ...(r.reviewer_session_id !== null ? { reviewerSessionId: r.reviewer_session_id } : {}),
    reviewedAt: r.reviewed_at,
    outcome: r.outcome as ReviewerDecisionOutcome,
    ...(r.resolved_at !== null ? { resolvedAt: r.resolved_at } : {}),
    ...(r.note !== null ? { note: r.note } : {}),
  };
}

type QualityBenchmarkRow = {
  id: string; project_id: string; name: string; task_set: string;
  agents: string; status: string; created_at: number; updated_at: number;
  completed_at: number | null;
};

function rowToBenchmark(r: QualityBenchmarkRow, runs: BenchmarkRun[]): QualityBenchmark {
  let agents: string[] = [];
  try { agents = JSON.parse(r.agents) as string[]; } catch { /* keep empty */ }
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    taskSet: r.task_set,
    agents,
    runs,
    status: r.status as QualityBenchmark["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
  };
}

type QualityBenchmarkRunRow = {
  id: string; benchmark_id: string; agent: string; quality_run_id: string | null;
  status: string; passed_checks: number; failed_checks: number;
  finding_count: number; blocking_count: number; fix_rounds: number;
  duration_ms: number; failure_reason: string | null;
  created_at: number; updated_at: number; completed_at: number | null;
};

function rowToBenchmarkRun(r: QualityBenchmarkRunRow): BenchmarkRun {
  return {
    id: r.id,
    benchmarkId: r.benchmark_id,
    agent: r.agent,
    ...(r.quality_run_id !== null ? { qualityRunId: r.quality_run_id } : {}),
    status: r.status as BenchmarkRun["status"],
    passedChecks: r.passed_checks,
    failedChecks: r.failed_checks,
    findingCount: r.finding_count,
    blockingCount: r.blocking_count,
    fixRounds: r.fix_rounds,
    durationMs: r.duration_ms,
    ...(r.failure_reason !== null ? { failureReason: r.failure_reason } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
  };
}
