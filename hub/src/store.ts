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
  RuleDefinition,
  ReviewerDecision,
  ReviewerDecisionOutcome,
  QualityBenchmark,
  BenchmarkRun,
  WorkRequest,
  RequirementSpec,
  WorkItem,
  RequirementVerification,
  QualityObservation,
  ActiveControl,
  ClarificationRequest,
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
      CREATE TABLE IF NOT EXISTS quality_work_requests (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        mode TEXT,
        room_id TEXT,
        session_id TEXT,
        correlation_id TEXT NOT NULL,
        turn_id TEXT,
        raw_input_ref TEXT,
        intent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quality_work_requests_room
        ON quality_work_requests(room_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_work_requests_session
        ON quality_work_requests(session_id, created_at);
      CREATE TABLE IF NOT EXISTS quality_requirement_specs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version INTEGER,
        goal TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '{}',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        constraints TEXT NOT NULL DEFAULT '[]',
        risks TEXT NOT NULL DEFAULT '[]',
        clarifications TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quality_requirement_specs_request
        ON quality_requirement_specs(request_id, version);
      CREATE TABLE IF NOT EXISTS quality_work_items (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        spec_id TEXT,
        spec_version INTEGER,
        project_id TEXT NOT NULL,
        room_id TEXT,
        task_id TEXT,
        session_id TEXT,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'implementation',
        status TEXT NOT NULL DEFAULT 'planned',
        current_run_id TEXT,
        current_generation INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quality_work_items_project
        ON quality_work_items(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_quality_work_items_request
        ON quality_work_items(request_id);
      CREATE TABLE IF NOT EXISTS quality_requirement_verifications (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL,
        criterion_id TEXT NOT NULL,
        expectation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        method TEXT NOT NULL,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        verifier TEXT NOT NULL,
        confidence REAL,
        waiver_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quality_requirement_verifications_run
        ON quality_requirement_verifications(run_id);
      CREATE TABLE IF NOT EXISTS quality_observations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT,
        work_item_id TEXT,
        kind TEXT NOT NULL,
        attribution TEXT NOT NULL DEFAULT 'unknown',
        fingerprint TEXT,
        fingerprint_version INTEGER,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quality_observations_project
        ON quality_observations(project_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_quality_observations_fingerprint
        ON quality_observations(project_id, fingerprint);
      CREATE TABLE IF NOT EXISTS quality_active_controls (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        rule_candidate_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        activated_at INTEGER NOT NULL,
        activated_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        retired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_active_controls_project
        ON quality_active_controls(project_id, status);
      CREATE TABLE IF NOT EXISTS quality_clarification_requests (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL,
        questions TEXT NOT NULL DEFAULT '[]',
        can_skip INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quality_clarification_requests_request
        ON quality_clarification_requests(request_id, status);
      CREATE TABLE IF NOT EXISTS quality_metrics (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT,
        work_item_id TEXT,
        kind TEXT NOT NULL,
        stage TEXT,
        outcome TEXT,
        duration_ms INTEGER,
        check_count INTEGER,
        check_passed INTEGER,
        check_failed INTEGER,
        check_infra_failed INTEGER,
        has_patch INTEGER,
        fix_rounds INTEGER,
        cost_tokens INTEGER,
        cost_model_calls INTEGER,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quality_metrics_project
        ON quality_metrics(project_id, kind, timestamp);
      CREATE INDEX IF NOT EXISTS idx_quality_metrics_run
        ON quality_metrics(run_id);
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
      // Phase 0（v3.0 §8.2）：quality_runs 扩展列
      { table: "quality_runs", column: "work_item_id", def: "TEXT" },
      { table: "quality_runs", column: "generation", def: "INTEGER" },
      { table: "quality_runs", column: "policy_hash", def: "TEXT" },
      { table: "quality_runs", column: "policy_snapshot_ref", def: "TEXT" },
      { table: "quality_runs", column: "change_set_id", def: "TEXT" },
      { table: "quality_runs", column: "outcome", def: "TEXT" },
      // Phase 0（v3.0 §8.3）：quality_incidents 扩展列
      { table: "quality_incidents", column: "type", def: "TEXT" },
      { table: "quality_incidents", column: "fingerprint_version", def: "INTEGER" },
      { table: "quality_incidents", column: "source_observation_ids", def: "TEXT NOT NULL DEFAULT '[]'" },
      // Phase 5（v3.0 §12）：受控学习扩展列
      { table: "quality_incidents", column: "confirmed_at", def: "INTEGER" },
      { table: "quality_incidents", column: "confirmed_by", def: "TEXT" },
      { table: "quality_rules", column: "rule_type", def: "TEXT" },
      { table: "quality_rules", column: "rule_definition", def: "TEXT" },
      { table: "quality_rules", column: "fingerprint_version", def: "INTEGER" },
      { table: "quality_rules", column: "sandbox_passed", def: "INTEGER" },
      { table: "quality_rules", column: "approved_by", def: "TEXT" },
      { table: "quality_rules", column: "approved_at", def: "INTEGER" },
      { table: "quality_observations", column: "confirmed_at", def: "INTEGER" },
      { table: "quality_observations", column: "confirmed_by", def: "TEXT" },
      { table: "quality_observations", column: "attribution_reason", def: "TEXT" },
      { table: "quality_observations", column: "description", def: "TEXT" },
      { table: "quality_observations", column: "severity", def: "TEXT" },
      { table: "quality_active_controls", column: "retired_by", def: "TEXT" },
      { table: "quality_active_controls", column: "retire_reason", def: "TEXT" },
      { table: "quality_active_controls", column: "rule_type", def: "TEXT" },
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
           verdict, failure_code, created_at, updated_at, completed_at,
           work_item_id, generation, policy_hash, policy_snapshot_ref, change_set_id, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           completed_at = excluded.completed_at,
           work_item_id = excluded.work_item_id,
           generation = excluded.generation,
           policy_hash = excluded.policy_hash,
           policy_snapshot_ref = excluded.policy_snapshot_ref,
           change_set_id = excluded.change_set_id,
           outcome = excluded.outcome`,
      )
      .run(
        run.id, run.projectId, run.roomId ?? null, run.taskId ?? null,
        run.implementerSessionId ?? null, run.reviewerSessionId ?? null,
        run.trigger, run.stage, run.risk, run.policyVersion,
        run.baseRevision ?? null, run.dirtyBaselineHash ?? null, run.patchHash ?? null,
        run.fixRound, run.budget.maxFixRounds, run.budget.timeoutMs,
        run.verdict ?? null, run.failureCode ?? null,
        run.createdAt, run.updatedAt, run.completedAt ?? null,
        run.workItemId ?? null, run.generation ?? null, run.policyHash ?? null,
        run.policySnapshotRef ?? null, run.changeSetId ?? null, run.outcome ?? null,
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

  /** 清除 run 的所有旧 check 结果（修复后复验前调用）。 */
  clearQualityChecks(runId: string): number {
    return this.db.prepare("DELETE FROM quality_checks WHERE run_id = ?").run(runId).changes;
  }

  /** 清除 run 的所有旧 finding（修复后复验前调用）。 */
  clearQualityFindings(runId: string): number {
    return this.db.prepare("DELETE FROM quality_findings WHERE run_id = ?").run(runId).changes;
  }

  /** 清除 run 的所有旧 review decision（修复后复验前调用）。 */
  clearReviewDecisions(runId: string): number {
    return this.db.prepare("DELETE FROM quality_review_decisions WHERE run_id = ?").run(runId).changes;
  }

  /** 清除 run 的所有旧 requirement verification（修复后复验前调用）。 */
  clearRequirementVerifications(runId: string): number {
    return this.db.prepare("DELETE FROM quality_requirement_verifications WHERE run_id = ?").run(runId).changes;
  }

  /** 清除 run 的所有旧证据（check + finding + review decision + requirement verification）。 */
  clearRunEvidence(runId: string): { checks: number; findings: number; decisions: number; verifications: number } {
    const checks = this.clearQualityChecks(runId);
    const findings = this.clearQualityFindings(runId);
    const decisions = this.clearReviewDecisions(runId);
    const verifications = this.clearRequirementVerifications(runId);
    return { checks, findings, decisions, verifications };
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
           severity, reproduction, regression_test, status, type, fingerprint_version, source_observation_ids,
           confirmed_at, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           fingerprint = excluded.fingerprint,
           severity = excluded.severity,
           reproduction = excluded.reproduction,
           regression_test = excluded.regression_test,
           status = excluded.status,
           type = excluded.type,
           fingerprint_version = excluded.fingerprint_version,
           source_observation_ids = excluded.source_observation_ids,
           confirmed_at = excluded.confirmed_at,
           confirmed_by = excluded.confirmed_by`,
      )
      .run(
        i.id, i.projectId, i.sourceRunId ?? null, i.description,
        i.fingerprint, i.severity, i.reproduction ?? null,
        i.regressionTest ?? null, i.status,
        i.type ?? null, i.fingerprintVersion ?? null,
        JSON.stringify(i.sourceObservationIds ?? []),
        i.confirmedAt ?? null, i.confirmedBy ?? null,
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
           recurrence, measured_impact, status, rule_type, rule_definition,
           fingerprint_version, sandbox_passed, approved_by, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           rule = excluded.rule,
           evidence_incident_ids = excluded.evidence_incident_ids,
           recurrence = excluded.recurrence,
           measured_impact = excluded.measured_impact,
           status = excluded.status,
           rule_type = excluded.rule_type,
           rule_definition = excluded.rule_definition,
           fingerprint_version = excluded.fingerprint_version,
           sandbox_passed = excluded.sandbox_passed,
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at`,
      )
      .run(
        r.id, r.projectId, r.fingerprint, r.rule,
        JSON.stringify(r.evidenceIncidentIds), r.recurrence,
        r.measuredImpact ?? null, r.status,
        r.ruleType ?? null,
        r.ruleDefinition ? JSON.stringify(r.ruleDefinition) : null,
        r.fingerprintVersion ?? null,
        r.sandboxPassed !== undefined ? (r.sandboxPassed ? 1 : 0) : null,
        r.approvedBy ?? null,
        r.approvedAt ?? null,
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

  // ── Phase 0（v3.0 §8）：WorkRequest / WorkItem / RequirementSpec / Observation CRUD ──

  saveWorkRequest(r: WorkRequest): void {
    this.db.prepare(`INSERT INTO quality_work_requests
      (id, source, mode, room_id, session_id, correlation_id, turn_id, raw_input_ref, intent, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source=excluded.source, mode=excluded.mode, room_id=excluded.room_id, session_id=excluded.session_id,
        correlation_id=excluded.correlation_id, turn_id=excluded.turn_id, raw_input_ref=excluded.raw_input_ref,
        intent=excluded.intent, status=excluded.status, updated_at=excluded.updated_at`).run(
      r.id, r.source, r.mode ?? null, r.roomId ?? null, r.sessionId ?? null, r.correlationId,
      r.turnId ?? null, r.rawInputRef ?? null, r.intent, r.status, r.createdAt, r.updatedAt,
    );
  }

  getWorkRequest(id: string): WorkRequest | undefined {
    const row = this.db.prepare("SELECT * FROM quality_work_requests WHERE id = ?").get(id) as QualityWorkRequestRow | undefined;
    return row ? rowToWorkRequest(row) : undefined;
  }

  listWorkRequests(roomId?: string, limit = 100): WorkRequest[] {
    const sql = roomId
      ? "SELECT * FROM quality_work_requests WHERE room_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM quality_work_requests ORDER BY created_at DESC LIMIT ?";
    const rows = (roomId
      ? this.db.prepare(sql).all(roomId, limit)
      : this.db.prepare(sql).all(limit)) as QualityWorkRequestRow[];
    return rows.map(rowToWorkRequest);
  }

  saveRequirementSpec(s: RequirementSpec): void {
    this.db.prepare(`INSERT INTO quality_requirement_specs
      (id, request_id, version, parent_version, goal, scope, acceptance_criteria, constraints, risks, clarifications, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        goal=excluded.goal, scope=excluded.scope, acceptance_criteria=excluded.acceptance_criteria,
        constraints=excluded.constraints, risks=excluded.risks, clarifications=excluded.clarifications,
        status=excluded.status, updated_at=excluded.updated_at`).run(
      s.id, s.requestId, s.version, s.parentVersion ?? null, s.goal,
      JSON.stringify(s.scope), JSON.stringify(s.acceptanceCriteria), JSON.stringify(s.constraints),
      JSON.stringify(s.risks), JSON.stringify(s.clarifications), s.status, s.createdAt, s.updatedAt,
    );
  }

  getRequirementSpec(id: string): RequirementSpec | undefined {
    const row = this.db.prepare("SELECT * FROM quality_requirement_specs WHERE id = ?").get(id) as QualityRequirementSpecRow | undefined;
    return row ? rowToRequirementSpec(row) : undefined;
  }

  listRequirementSpecs(requestId: string): RequirementSpec[] {
    const rows = this.db.prepare("SELECT * FROM quality_requirement_specs WHERE request_id = ? ORDER BY version ASC").all(requestId) as QualityRequirementSpecRow[];
    return rows.map(rowToRequirementSpec);
  }

  saveWorkItem(w: WorkItem): void {
    this.db.prepare(`INSERT INTO quality_work_items
      (id, request_id, spec_id, spec_version, project_id, room_id, task_id, session_id, mode, kind, status, current_run_id, current_generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        spec_id=excluded.spec_id, spec_version=excluded.spec_version, status=excluded.status,
        current_run_id=excluded.current_run_id, current_generation=excluded.current_generation, updated_at=excluded.updated_at`).run(
      w.id, w.requestId, w.specId ?? null, w.specVersion ?? null, w.projectId, w.roomId ?? null,
      w.taskId ?? null, w.sessionId ?? null, w.mode, w.kind, w.status, w.currentRunId ?? null,
      w.currentGeneration, w.createdAt, w.updatedAt,
    );
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.db.prepare("SELECT * FROM quality_work_items WHERE id = ?").get(id) as QualityWorkItemRow | undefined;
    return row ? rowToWorkItem(row) : undefined;
  }

  listWorkItems(projectId?: string, limit = 100): WorkItem[] {
    const sql = projectId
      ? "SELECT * FROM quality_work_items WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM quality_work_items ORDER BY created_at DESC LIMIT ?";
    const rows = (projectId
      ? this.db.prepare(sql).all(projectId, limit)
      : this.db.prepare(sql).all(limit)) as QualityWorkItemRow[];
    return rows.map(rowToWorkItem);
  }

  saveRequirementVerification(v: RequirementVerification): void {
    this.db.prepare(`INSERT INTO quality_requirement_verifications
      (id, run_id, spec_id, spec_version, criterion_id, expectation_id, status, method, evidence_refs, verifier, confidence, waiver_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, evidence_refs=excluded.evidence_refs, confidence=excluded.confidence,
        waiver_reason=excluded.waiver_reason`).run(
      v.id, v.runId, v.specId, v.specVersion, v.criterionId, v.expectationId, v.status, v.method,
      JSON.stringify(v.evidenceRefs), v.verifier, v.confidence ?? null, v.waiverReason ?? null,
    );
  }

  listRequirementVerifications(runId: string): RequirementVerification[] {
    const rows = this.db.prepare("SELECT * FROM quality_requirement_verifications WHERE run_id = ?").all(runId) as QualityRequirementVerificationRow[];
    return rows.map(rowToRequirementVerification);
  }

  saveObservation(o: QualityObservation): void {
    this.db.prepare(`INSERT INTO quality_observations
      (id, project_id, run_id, work_item_id, kind, attribution, fingerprint, fingerprint_version,
       evidence_refs, status, created_at, confirmed_at, confirmed_by, attribution_reason, description, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        attribution=excluded.attribution, fingerprint=excluded.fingerprint, status=excluded.status,
        confirmed_at=excluded.confirmed_at, confirmed_by=excluded.confirmed_by,
        attribution_reason=excluded.attribution_reason, description=excluded.description,
        severity=excluded.severity`).run(
      o.id, o.projectId, o.runId ?? null, o.workItemId ?? null, o.kind, o.attribution,
      o.fingerprint ?? null, o.fingerprintVersion ?? null, JSON.stringify(o.evidenceRefs),
      o.status, o.createdAt,
      o.confirmedAt ?? null, o.confirmedBy ?? null,
      o.attributionReason ?? null, o.description ?? null, o.severity ?? null,
    );
  }

  listObservations(projectId?: string, limit = 100): QualityObservation[] {
    const sql = projectId
      ? "SELECT * FROM quality_observations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM quality_observations ORDER BY created_at DESC LIMIT ?";
    const rows = (projectId
      ? this.db.prepare(sql).all(projectId, limit)
      : this.db.prepare(sql).all(limit)) as QualityObservationRow[];
    return rows.map(rowToObservation);
  }

  saveActiveControl(c: ActiveControl): void {
    this.db.prepare(`INSERT INTO quality_active_controls
      (id, project_id, rule_candidate_id, rule, activated_at, activated_by, status, retired_at,
       retired_by, retire_reason, rule_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, retired_at=excluded.retired_at,
        retired_by=excluded.retired_by, retire_reason=excluded.retire_reason,
        rule_type=excluded.rule_type`).run(
      c.id, c.projectId, c.ruleCandidateId, JSON.stringify(c.rule), c.activatedAt,
      c.activatedBy, c.status, c.retiredAt ?? null,
      c.retiredBy ?? null, c.retireReason ?? null, c.ruleType ?? null,
    );
  }

  listActiveControls(projectId?: string, includeShadow = false): ActiveControl[] {
    const statusFilter = includeShadow ? "status IN ('active', 'shadow')" : "status = 'active'";
    const sql = projectId
      ? `SELECT * FROM quality_active_controls WHERE project_id = ? AND ${statusFilter} ORDER BY activated_at DESC`
      : `SELECT * FROM quality_active_controls WHERE ${statusFilter} ORDER BY activated_at DESC`;
    const rows = (projectId
      ? this.db.prepare(sql).all(projectId)
      : this.db.prepare(sql).all()) as QualityActiveControlRow[];
    return rows.map(rowToActiveControl);
  }

  // ── Phase 3 L0（v3.0 §6.3）：ClarificationRequest CRUD ──────────────

  saveClarificationRequest(r: ClarificationRequest): void {
    this.db.prepare(`INSERT INTO quality_clarification_requests
      (id, request_id, spec_id, spec_version, questions, can_skip, expires_at, status, created_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        questions=excluded.questions, can_skip=excluded.can_skip,
        expires_at=excluded.expires_at, status=excluded.status, answered_at=excluded.answered_at`).run(
      r.id, r.requestId, r.specId, r.specVersion, JSON.stringify(r.questions),
      r.canSkip ? 1 : 0, r.expiresAt ?? null, r.status, r.createdAt, r.answeredAt ?? null,
    );
  }

  getClarificationRequest(id: string): ClarificationRequest | undefined {
    const row = this.db.prepare("SELECT * FROM quality_clarification_requests WHERE id = ?").get(id) as QualityClarificationRequestRow | undefined;
    return row ? rowToClarificationRequest(row) : undefined;
  }

  getPendingClarificationRequest(requestId: string): ClarificationRequest | undefined {
    const row = this.db.prepare("SELECT * FROM quality_clarification_requests WHERE request_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(requestId) as QualityClarificationRequestRow | undefined;
    return row ? rowToClarificationRequest(row) : undefined;
  }

  listClarificationRequests(requestId?: string, limit = 50): ClarificationRequest[] {
    const sql = requestId
      ? "SELECT * FROM quality_clarification_requests WHERE request_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM quality_clarification_requests ORDER BY created_at DESC LIMIT ?";
    const rows = (requestId
      ? this.db.prepare(sql).all(requestId, limit)
      : this.db.prepare(sql).all(limit)) as QualityClarificationRequestRow[];
    return rows.map(rowToClarificationRequest);
  }

  // ── 度量收集（§12）─────────────────────────────────────────────────

  saveQualityMetric(m: QualityMetricRow): void {
    this.db
      .prepare(
        `INSERT INTO quality_metrics(id, project_id, run_id, work_item_id, kind,
           stage, outcome, duration_ms, check_count, check_passed, check_failed,
           check_infra_failed, has_patch, fix_rounds, cost_tokens, cost_model_calls, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage = excluded.stage,
           outcome = excluded.outcome,
           duration_ms = excluded.duration_ms,
           check_count = excluded.check_count,
           check_passed = excluded.check_passed,
           check_failed = excluded.check_failed,
           check_infra_failed = excluded.check_infra_failed,
           has_patch = excluded.has_patch,
           fix_rounds = excluded.fix_rounds,
           cost_tokens = excluded.cost_tokens,
           cost_model_calls = excluded.cost_model_calls`,
      )
      .run(
        m.id, m.projectId, m.runId ?? null, m.workItemId ?? null, m.kind,
        m.stage ?? null, m.outcome ?? null, m.durationMs ?? null,
        m.checkCount ?? null, m.checkPassed ?? null, m.checkFailed ?? null,
        m.checkInfraFailed ?? null,
        m.hasPatch === undefined ? null : (m.hasPatch ? 1 : 0),
        m.fixRounds ?? null,
        m.costTokens ?? null, m.costModelCalls ?? null, m.timestamp,
      );
  }

  listQualityMetrics(projectId: string, kind?: string, limit = 100): QualityMetricRow[] {
    const sql = kind
      ? "SELECT * FROM quality_metrics WHERE project_id = ? AND kind = ? ORDER BY timestamp DESC LIMIT ?"
      : "SELECT * FROM quality_metrics WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?";
    const rows = (kind
      ? this.db.prepare(sql).all(projectId, kind, limit)
      : this.db.prepare(sql).all(projectId, limit)) as QualityMetricDbRow[];
    return rows.map(rowToMetric);
  }
}

export type QualityMetricRow = {
  id: string;
  projectId: string;
  runId?: string;
  workItemId?: string;
  kind: string;
  stage?: string;
  outcome?: string;
  durationMs?: number;
  checkCount?: number;
  checkPassed?: number;
  checkFailed?: number;
  checkInfraFailed?: number;
  hasPatch?: boolean;
  fixRounds?: number;
  costTokens?: number;
  costModelCalls?: number;
  timestamp: number;
};

type QualityMetricDbRow = {
  id: string; project_id: string; run_id: string | null; work_item_id: string | null;
  kind: string; stage: string | null; outcome: string | null; duration_ms: number | null;
  check_count: number | null; check_passed: number | null; check_failed: number | null;
  check_infra_failed: number | null; has_patch: number | null; fix_rounds: number | null;
  cost_tokens: number | null; cost_model_calls: number | null; timestamp: number;
};

function rowToMetric(r: QualityMetricDbRow): QualityMetricRow {
  return {
    id: r.id,
    projectId: r.project_id,
    ...(r.run_id !== null ? { runId: r.run_id } : {}),
    ...(r.work_item_id !== null ? { workItemId: r.work_item_id } : {}),
    kind: r.kind,
    ...(r.stage !== null ? { stage: r.stage } : {}),
    ...(r.outcome !== null ? { outcome: r.outcome } : {}),
    ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
    ...(r.check_count !== null ? { checkCount: r.check_count } : {}),
    ...(r.check_passed !== null ? { checkPassed: r.check_passed } : {}),
    ...(r.check_failed !== null ? { checkFailed: r.check_failed } : {}),
    ...(r.check_infra_failed !== null ? { checkInfraFailed: r.check_infra_failed } : {}),
    ...(r.has_patch !== null ? { hasPatch: r.has_patch === 1 } : {}),
    ...(r.fix_rounds !== null ? { fixRounds: r.fix_rounds } : {}),
    ...(r.cost_tokens !== null ? { costTokens: r.cost_tokens } : {}),
    ...(r.cost_model_calls !== null ? { costModelCalls: r.cost_model_calls } : {}),
    timestamp: r.timestamp,
  };
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
  work_item_id: string | null; generation: number | null; policy_hash: string | null;
  policy_snapshot_ref: string | null; change_set_id: string | null; outcome: string | null;
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
    ...(r.work_item_id !== null && r.work_item_id !== undefined ? { workItemId: r.work_item_id } : {}),
    ...(r.generation !== null && r.generation !== undefined ? { generation: r.generation } : {}),
    ...(r.policy_hash !== null && r.policy_hash !== undefined ? { policyHash: r.policy_hash } : {}),
    ...(r.policy_snapshot_ref !== null && r.policy_snapshot_ref !== undefined ? { policySnapshotRef: r.policy_snapshot_ref } : {}),
    ...(r.change_set_id !== null && r.change_set_id !== undefined ? { changeSetId: r.change_set_id } : {}),
    ...(r.outcome !== null && r.outcome !== undefined ? { outcome: r.outcome as QualityRun["outcome"] } : {}),
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
  type: string | null; fingerprint_version: number | null; source_observation_ids: string | null;
  confirmed_at: number | null; confirmed_by: string | null;
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
    ...(r.type !== null ? { type: r.type as QualityIncident["type"] } : {}),
    ...(r.fingerprint_version !== null ? { fingerprintVersion: r.fingerprint_version } : {}),
    ...(r.source_observation_ids !== null ? { sourceObservationIds: JSON.parse(r.source_observation_ids) as string[] } : {}),
    ...(r.confirmed_at !== null ? { confirmedAt: r.confirmed_at } : {}),
    ...(r.confirmed_by !== null ? { confirmedBy: r.confirmed_by } : {}),
  };
}

type QualityRuleRow = {
  id: string; project_id: string; fingerprint: string; rule: string;
  evidence_incident_ids: string; recurrence: number;
  measured_impact: string | null; status: string;
  rule_type: string | null; rule_definition: string | null;
  fingerprint_version: number | null; sandbox_passed: number | null;
  approved_by: string | null; approved_at: number | null;
};

function rowToRule(r: QualityRuleRow): RuleCandidate {
  let ids: string[] = [];
  try { ids = JSON.parse(r.evidence_incident_ids) as string[]; } catch { /* keep empty */ }
  let ruleDefinition: RuleDefinition | undefined;
  try {
    if (r.rule_definition) ruleDefinition = JSON.parse(r.rule_definition) as RuleDefinition;
  } catch { /* keep undefined */ }
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprint: r.fingerprint,
    rule: r.rule,
    evidenceIncidentIds: ids,
    recurrence: r.recurrence,
    measuredImpact: r.measured_impact ?? undefined,
    status: r.status as RuleCandidate["status"],
    ...(r.rule_type !== null ? { ruleType: r.rule_type as RuleCandidate["ruleType"] } : {}),
    ...(ruleDefinition !== undefined ? { ruleDefinition } : {}),
    ...(r.fingerprint_version !== null ? { fingerprintVersion: r.fingerprint_version } : {}),
    ...(r.sandbox_passed !== null ? { sandboxPassed: r.sandbox_passed === 1 } : {}),
    ...(r.approved_by !== null ? { approvedBy: r.approved_by } : {}),
    ...(r.approved_at !== null ? { approvedAt: r.approved_at } : {}),
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

// ── Phase 0 row mappers ──────────────────────────────────────────────

type QualityWorkRequestRow = {
  id: string; source: string; mode: string | null; room_id: string | null;
  session_id: string | null; correlation_id: string; turn_id: string | null;
  raw_input_ref: string | null; intent: string; status: string;
  created_at: number; updated_at: number;
};

function rowToWorkRequest(r: QualityWorkRequestRow): WorkRequest {
  return {
    id: r.id,
    source: r.source as WorkRequest["source"],
    ...(r.mode !== null ? { mode: r.mode } : {}),
    ...(r.room_id !== null ? { roomId: r.room_id } : {}),
    ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
    correlationId: r.correlation_id,
    ...(r.turn_id !== null ? { turnId: r.turn_id } : {}),
    ...(r.raw_input_ref !== null ? { rawInputRef: r.raw_input_ref } : {}),
    intent: r.intent as WorkRequest["intent"],
    status: r.status as WorkRequest["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type QualityRequirementSpecRow = {
  id: string; request_id: string; version: number; parent_version: number | null;
  goal: string; scope: string; acceptance_criteria: string; constraints: string;
  risks: string; clarifications: string; status: string;
  created_at: number; updated_at: number;
};

function rowToRequirementSpec(r: QualityRequirementSpecRow): RequirementSpec {
  return {
    id: r.id,
    requestId: r.request_id,
    version: r.version,
    ...(r.parent_version !== null ? { parentVersion: r.parent_version } : {}),
    goal: r.goal,
    scope: JSON.parse(r.scope) as RequirementSpec["scope"],
    acceptanceCriteria: JSON.parse(r.acceptance_criteria) as RequirementSpec["acceptanceCriteria"],
    constraints: JSON.parse(r.constraints) as string[],
    risks: JSON.parse(r.risks) as string[],
    clarifications: JSON.parse(r.clarifications) as RequirementSpec["clarifications"],
    status: r.status as RequirementSpec["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type QualityWorkItemRow = {
  id: string; request_id: string; spec_id: string | null; spec_version: number | null;
  project_id: string; room_id: string | null; task_id: string | null; session_id: string | null;
  mode: string; kind: string; status: string; current_run_id: string | null;
  current_generation: number; created_at: number; updated_at: number;
};

function rowToWorkItem(r: QualityWorkItemRow): WorkItem {
  return {
    id: r.id,
    requestId: r.request_id,
    ...(r.spec_id !== null ? { specId: r.spec_id } : {}),
    ...(r.spec_version !== null ? { specVersion: r.spec_version } : {}),
    projectId: r.project_id,
    ...(r.room_id !== null ? { roomId: r.room_id } : {}),
    ...(r.task_id !== null ? { taskId: r.task_id } : {}),
    ...(r.session_id !== null ? { sessionId: r.session_id } : {}),
    mode: r.mode,
    kind: r.kind as WorkItem["kind"],
    status: r.status as WorkItem["status"],
    ...(r.current_run_id !== null ? { currentRunId: r.current_run_id } : {}),
    currentGeneration: r.current_generation,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

type QualityRequirementVerificationRow = {
  id: string; run_id: string; spec_id: string; spec_version: number;
  criterion_id: string; expectation_id: string; status: string; method: string;
  evidence_refs: string; verifier: string; confidence: number | null; waiver_reason: string | null;
};

function rowToRequirementVerification(r: QualityRequirementVerificationRow): RequirementVerification {
  return {
    id: r.id,
    runId: r.run_id,
    specId: r.spec_id,
    specVersion: r.spec_version,
    criterionId: r.criterion_id,
    expectationId: r.expectation_id,
    status: r.status as RequirementVerification["status"],
    method: r.method as RequirementVerification["method"],
    evidenceRefs: JSON.parse(r.evidence_refs) as string[],
    verifier: r.verifier,
    ...(r.confidence !== null ? { confidence: r.confidence } : {}),
    ...(r.waiver_reason !== null ? { waiverReason: r.waiver_reason } : {}),
  };
}

type QualityObservationRow = {
  id: string; project_id: string; run_id: string | null; work_item_id: string | null;
  kind: string; attribution: string; fingerprint: string | null; fingerprint_version: number | null;
  evidence_refs: string; status: string; created_at: number;
  confirmed_at: number | null; confirmed_by: string | null;
  attribution_reason: string | null; description: string | null; severity: string | null;
};

function rowToObservation(r: QualityObservationRow): QualityObservation {
  return {
    id: r.id,
    projectId: r.project_id,
    ...(r.run_id !== null ? { runId: r.run_id } : {}),
    ...(r.work_item_id !== null ? { workItemId: r.work_item_id } : {}),
    kind: r.kind as QualityObservation["kind"],
    attribution: r.attribution as QualityObservation["attribution"],
    ...(r.fingerprint !== null ? { fingerprint: r.fingerprint } : {}),
    ...(r.fingerprint_version !== null ? { fingerprintVersion: r.fingerprint_version } : {}),
    evidenceRefs: JSON.parse(r.evidence_refs) as string[],
    status: r.status as QualityObservation["status"],
    createdAt: r.created_at,
    ...(r.confirmed_at !== null ? { confirmedAt: r.confirmed_at } : {}),
    ...(r.confirmed_by !== null ? { confirmedBy: r.confirmed_by } : {}),
    ...(r.attribution_reason !== null ? { attributionReason: r.attribution_reason } : {}),
    ...(r.description !== null ? { description: r.description } : {}),
    ...(r.severity !== null ? { severity: r.severity } : {}),
  };
}

type QualityActiveControlRow = {
  id: string; project_id: string; rule_candidate_id: string; rule: string;
  activated_at: number; activated_by: string; status: string; retired_at: number | null;
  retired_by: string | null; retire_reason: string | null; rule_type: string | null;
};

function rowToActiveControl(r: QualityActiveControlRow): ActiveControl {
  return {
    id: r.id,
    projectId: r.project_id,
    ruleCandidateId: r.rule_candidate_id,
    rule: JSON.parse(r.rule) as ActiveControl["rule"],
    activatedAt: r.activated_at,
    activatedBy: r.activated_by,
    status: r.status as ActiveControl["status"],
    ...(r.retired_at !== null ? { retiredAt: r.retired_at } : {}),
    ...(r.retired_by !== null ? { retiredBy: r.retired_by } : {}),
    ...(r.retire_reason !== null ? { retireReason: r.retire_reason } : {}),
    ...(r.rule_type !== null ? { ruleType: r.rule_type as ActiveControl["ruleType"] } : {}),
  };
}

type QualityClarificationRequestRow = {
  id: string; request_id: string; spec_id: string; spec_version: number;
  questions: string; can_skip: number; expires_at: number | null;
  status: string; created_at: number; answered_at: number | null;
};

function rowToClarificationRequest(r: QualityClarificationRequestRow): ClarificationRequest {
  return {
    id: r.id,
    requestId: r.request_id,
    specId: r.spec_id,
    specVersion: r.spec_version,
    questions: JSON.parse(r.questions) as ClarificationRequest["questions"],
    canSkip: r.can_skip === 1,
    ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
    status: r.status as ClarificationRequest["status"],
    createdAt: r.created_at,
    ...(r.answered_at !== null ? { answeredAt: r.answered_at } : {}),
  };
}
