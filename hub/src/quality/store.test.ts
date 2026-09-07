import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../store.js";
import { createRun, transition } from "./run.js";
import type {
  ProjectScope,
  QualityRun,
  CheckRun,
  ReviewFinding,
  QualityIncident,
  RuleCandidate,
} from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quality-store-"));
}

function makeProject(id: string): ProjectScope {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    root: "/repo/agent-hub",
    gitRoot: "/repo/agent-hub",
    displayName: "agent-hub",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    policyVersion: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(projectId: string, id = "run-1"): QualityRun {
  return {
    ...createRun({
      id,
      projectId,
      trigger: "interactive",
      risk: "low",
      policyVersion: "v1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    }),
    roomId: undefined,
    taskId: undefined,
    implementerSessionId: undefined,
    reviewerSessionId: undefined,
    baseRevision: undefined,
    dirtyBaselineHash: undefined,
    patchHash: undefined,
    verdict: undefined,
    failureCode: undefined,
    completedAt: undefined,
  };
}

function makeCheck(runId: string, id = "chk-1"): CheckRun {
  return {
    id,
    runId,
    checkId: "hub-typecheck",
    attempt: 1,
    status: "passed",
    exitCode: 0,
    durationMs: 1234,
    summary: "no errors",
    startedAt: 1000,
    completedAt: 2234,
  };
}

function makeFinding(runId: string, id = "find-1"): ReviewFinding {
  return {
    id,
    runId,
    severity: "major",
    confidence: 0.9,
    category: "correctness",
    file: "hub/src/example.ts",
    line: 42,
    claim: "null deref",
    evidence: "foo.bar() without null check",
    reproduction: "call foo when undefined",
    suggestion: "add guard",
    blocking: true,
    status: "open",
  };
}

function makeIncident(projectId: string, id = "inc-1"): QualityIncident {
  return {
    id,
    projectId,
    sourceRunId: "run-1",
    description: "conductor marked failed dep as done",
    fingerprint: "fp-abc",
    severity: "major",
    reproduction: "t1 failed, t2 dependsOn t1",
    status: "open",
  };
}

function makeRule(projectId: string, id = "rule-1"): RuleCandidate {
  return {
    id,
    projectId,
    fingerprint: "fp-abc",
    rule: "failed dependency must not unlock downstream",
    evidenceIncidentIds: ["inc-1", "inc-2"],
    recurrence: 3,
    measuredImpact: "reduced false-done by 80%",
    status: "candidate",
  };
}

describe("quality store", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("projects", () => {
    it("upsert 后能取回，capabilities 布尔往返", () => {
      const p = makeProject("p1");
      store.upsertQualityProject(p);
      const got = store.getQualityProject("p1");
      assert.deepEqual(got, p);
    });

    it("upsert 同 id 覆盖而非插入", () => {
      store.upsertQualityProject(makeProject("p1"));
      const updated = { ...makeProject("p1"), displayName: "renamed", updatedAt: 9999 };
      store.upsertQualityProject(updated);
      const all = store.listQualityProjects();
      assert.equal(all.length, 1);
      assert.equal(all[0]!.displayName, "renamed");
      assert.equal(all[0]!.updatedAt, 9999);
    });

    it("list 按 updated_at 倒序", () => {
      store.upsertQualityProject({ ...makeProject("p1"), updatedAt: 100 });
      store.upsertQualityProject({ ...makeProject("p2"), updatedAt: 200 });
      const all = store.listQualityProjects();
      assert.equal(all[0]!.id, "p2");
      assert.equal(all[1]!.id, "p1");
    });

    it("delete 返回 true/false", () => {
      store.upsertQualityProject(makeProject("p1"));
      assert.equal(store.deleteQualityProject("p1"), true);
      assert.equal(store.deleteQualityProject("p1"), false);
      assert.equal(store.getQualityProject("p1"), undefined);
    });
  });

  describe("runs", () => {
    it("save 后能取回，budget 字段往返", () => {
      store.upsertQualityProject(makeProject("p1"));
      const run = makeRun("p1");
      store.saveQualityRun(run);
      const got = store.getQualityRun(run.id);
      assert.deepEqual(got, run);
    });

    it("save 同 id 覆盖（状态推进后持久化）", () => {
      store.upsertQualityProject(makeProject("p1"));
      let run = makeRun("p1");
      store.saveQualityRun(run);
      run = transition(run, "preflight");
      run.patchHash = "hash-1";
      store.saveQualityRun(run);
      const got = store.getQualityRun(run.id);
      assert.equal(got!.stage, "preflight");
      assert.equal(got!.patchHash, "hash-1");
    });

    it("list 按 project 过滤、created_at 倒序", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.upsertQualityProject(makeProject("p2"));
      store.saveQualityRun({ ...makeRun("p1", "r1"), createdAt: 100 });
      store.saveQualityRun({ ...makeRun("p1", "r2"), createdAt: 200 });
      store.saveQualityRun({ ...makeRun("p2", "r3"), createdAt: 150 });
      const p1Runs = store.listQualityRuns("p1");
      assert.equal(p1Runs.length, 2);
      assert.equal(p1Runs[0]!.id, "r2");
      assert.equal(p1Runs[1]!.id, "r1");
      const all = store.listQualityRuns();
      assert.equal(all.length, 3);
    });

    it("listByStage 过滤", () => {
      store.upsertQualityProject(makeProject("p1"));
      const r1 = makeRun("p1", "r1");
      store.saveQualityRun(r1);
      const r2 = makeRun("p1", "r2");
      store.saveQualityRun(transition(r2, "preflight"));
      const queued = store.listQualityRunsByStage("queued");
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.id, "r1");
      const preflight = store.listQualityRunsByStage("preflight");
      assert.equal(preflight.length, 1);
      assert.equal(preflight[0]!.id, "r2");
    });

    it("verdict 和 completedAt 往返", () => {
      store.upsertQualityProject(makeProject("p1"));
      let run = makeRun("p1");
      run = transition(run, "preflight");
      run = transition(run, "failed");
      store.saveQualityRun(run);
      const got = store.getQualityRun(run.id);
      assert.equal(got!.verdict, "fail");
      assert.ok(got!.completedAt !== undefined);
    });

    it("delete 级联清理可选（当前只删 run 行）", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRun(makeRun("p1"));
      assert.equal(store.deleteQualityRun("run-1"), true);
      assert.equal(store.getQualityRun("run-1"), undefined);
    });
  });

  describe("checks", () => {
    it("save 后能按 runId 列出", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRun(makeRun("p1"));
      store.saveQualityCheck(makeCheck("run-1", "c1"));
      store.saveQualityCheck({ ...makeCheck("run-1", "c2"), checkId: "hub-tests", attempt: 1 });
      const checks = store.listQualityChecks("run-1");
      assert.equal(checks.length, 2);
    });

    it("同 id upsert 覆盖", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRun(makeRun("p1"));
      store.saveQualityCheck(makeCheck("run-1"));
      store.saveQualityCheck({ ...makeCheck("run-1"), status: "failed", exitCode: 1 });
      const checks = store.listQualityChecks("run-1");
      assert.equal(checks.length, 1);
      assert.equal(checks[0]!.status, "failed");
      assert.equal(checks[0]!.exitCode, 1);
    });
  });

  describe("findings", () => {
    it("save 后能按 runId 列出", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRun(makeRun("p1"));
      store.saveQualityFinding(makeFinding("run-1", "f1"));
      store.saveQualityFinding({ ...makeFinding("run-1", "f2"), severity: "minor", blocking: false });
      const findings = store.listQualityFindings("run-1");
      assert.equal(findings.length, 2);
    });

    it("blocking 布尔和 confidence 往返", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRun(makeRun("p1"));
      store.saveQualityFinding(makeFinding("run-1"));
      const f = store.listQualityFindings("run-1")[0]!;
      assert.equal(f.blocking, true);
      assert.equal(f.confidence, 0.9);
    });
  });

  describe("incidents", () => {
    it("save 后能列出，可按 project 过滤", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.upsertQualityProject(makeProject("p2"));
      store.saveQualityIncident(makeIncident("p1", "i1"));
      store.saveQualityIncident({ ...makeIncident("p2", "i2"), projectId: "p2" });
      const p1Inc = store.listQualityIncidents("p1");
      assert.equal(p1Inc.length, 1);
      assert.equal(p1Inc[0]!.id, "i1");
      const all = store.listQualityIncidents();
      assert.equal(all.length, 2);
    });
  });

  describe("rules", () => {
    it("save 后 evidenceIncidentIds JSON 往返", () => {
      store.upsertQualityProject(makeProject("p1"));
      store.saveQualityRule(makeRule("p1"));
      const rules = store.listQualityRules("p1");
      assert.equal(rules.length, 1);
      assert.deepEqual(rules[0]!.evidenceIncidentIds, ["inc-1", "inc-2"]);
      assert.equal(rules[0]!.recurrence, 3);
    });

    it("损坏的 JSON 不崩溃，返回空数组", () => {
      store.upsertQualityProject(makeProject("p1"));
      const r = makeRule("p1");
      store.saveQualityRule(r);
      // 直接写坏 JSON
      (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
        .db.prepare("UPDATE quality_rules SET evidence_incident_ids = ? WHERE id = ?")
        .run("{broken", r.id);
      const rules = store.listQualityRules("p1");
      assert.deepEqual(rules[0]!.evidenceIncidentIds, []);
    });
  });

  describe("兼容性", () => {
    it("旧 DB（无质量表）启动后自动建表且原有功能正常", () => {
      // 模拟旧 DB：先创建一个只有 meta/history 的库
      const oldDbPath = path.join(dir, "hub.db");
      store.close();
      fs.rmSync(oldDbPath);
      // 手动建旧 schema
      const oldDb = new Database(oldDbPath);
      oldDb.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL, scope_id TEXT NOT NULL,
          at INTEGER NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL
        );
        INSERT INTO meta(key, value) VALUES ('state', '{"sessions":[],"rooms":[]}');
      `);
      oldDb.close();
      // 用 Store 打开，应自动补建质量表
      const reopened = new Store(dir);
      const p = makeProject("p1");
      reopened.upsertQualityProject(p);
      assert.deepEqual(reopened.getQualityProject("p1"), p);
      // 原有 meta 仍可用
      assert.equal(reopened.getMeta("state"), '{"sessions":[],"rooms":[]}');
      reopened.close();
    });

    it("质量表为空时不影响 listConnections/listRoles", () => {
      assert.equal(store.listConnections().length, 0);
      assert.ok(store.listRoles().length > 0); // builtin roles seeded
      assert.equal(store.listQualityRuns().length, 0);
      assert.equal(store.listQualityProjects().length, 0);
    });
  });
});
