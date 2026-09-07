import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BenchmarkService,
  startBenchmark,
  newBenchmarkId,
  newBenchmarkRunId,
} from "./eval.js";
import { Store } from "../store.js";
import type { ProjectScope, QualityBenchmark } from "./types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eval-bench-"));
}

function makeProject(id: string, root: string): ProjectScope {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    root,
    gitRoot: root,
    displayName: "agent-hub",
    capabilities: { git: true, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: now,
    updatedAt: now,
  };
}

/** 创建 benchmark 并持久化，返回持久化后的完整对象。 */
function createAndSave(
  service: BenchmarkService,
  store: Store,
  opts: { projectId: string; name: string; taskSet: string; agents: string[] },
): QualityBenchmark {
  const benchmark = startBenchmark(opts);
  store.saveQualityBenchmark(benchmark);
  return service.getBenchmark(benchmark.id)!;
}

describe("BenchmarkService", () => {
  let dir: string;
  let store: Store;
  let service: BenchmarkService;
  let project: ProjectScope;

  beforeEach(() => {
    dir = tmpDir();
    store = new Store(path.join(dir, "test.db"));
    service = new BenchmarkService(store);
    project = makeProject("p-test", dir);
    store.upsertQualityProject(project);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("startBenchmark", () => {
    it("创建 benchmark 并为每个 agent 初始化 pending run", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "baseline-v1",
        taskSet: "fix 3 bugs",
        agents: ["devin-cli", "claude", "codex"],
      });

      assert.equal(benchmark.projectId, project.id);
      assert.equal(benchmark.name, "baseline-v1");
      assert.equal(benchmark.taskSet, "fix 3 bugs");
      assert.deepEqual(benchmark.agents, ["devin-cli", "claude", "codex"]);
      assert.equal(benchmark.runs.length, 3);
      assert.equal(benchmark.status, "running");
      for (const run of benchmark.runs) {
        assert.equal(run.status, "pending");
        assert.equal(run.passedChecks, 0);
        assert.equal(run.failedChecks, 0);
        assert.equal(run.findingCount, 0);
        assert.equal(run.blockingCount, 0);
        assert.equal(run.fixRounds, 0);
        assert.equal(run.durationMs, 0);
      }
    });

    it("每个 agent 的 run 有唯一 id 和正确 benchmarkId", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "test",
        taskSet: "task",
        agents: ["a", "b"],
      });
      const ids = benchmark.runs.map((r) => r.id);
      assert.equal(new Set(ids).size, 2);
      for (const run of benchmark.runs) {
        assert.equal(run.benchmarkId, benchmark.id);
      }
    });
  });

  describe("listBenchmarks", () => {
    it("按 projectId 过滤", () => {
      createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli"],
      });
      createAndSave(service, store, {
        projectId: "other-project",
        name: "b2",
        taskSet: "t2",
        agents: ["claude"],
      });

      const all = service.listBenchmarks();
      assert.equal(all.length, 2);

      const filtered = service.listBenchmarks(project.id);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0]!.name, "b1");
    });

    it("无 benchmark 时返回空数组", () => {
      assert.deepEqual(service.listBenchmarks(), []);
    });
  });

  describe("getBenchmark", () => {
    it("返回含 runs 的完整 benchmark", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });
      const fetched = service.getBenchmark(benchmark.id);
      assert.ok(fetched !== undefined);
      assert.equal(fetched!.id, benchmark.id);
      assert.equal(fetched!.runs.length, 2);
    });

    it("不存在的 id 返回 undefined", () => {
      assert.equal(service.getBenchmark("nonexistent"), undefined);
    });
  });

  describe("collectResult", () => {
    it("收集 agent 结果后更新 run 状态", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      const updated = service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-run-1",
        passedChecks: 5,
        failedChecks: 1,
        findingCount: 2,
        blockingCount: 1,
        fixRounds: 1,
        durationMs: 30000,
      });

      const devinRun = updated.runs.find((r) => r.agent === "devin-cli")!;
      assert.equal(devinRun.status, "completed");
      assert.equal(devinRun.qualityRunId, "q-run-1");
      assert.equal(devinRun.passedChecks, 5);
      assert.equal(devinRun.failedChecks, 1);
      assert.equal(devinRun.findingCount, 2);
      assert.equal(devinRun.blockingCount, 1);
      assert.equal(devinRun.fixRounds, 1);
      assert.equal(devinRun.durationMs, 30000);
      assert.ok(devinRun.completedAt !== undefined);
    });

    it("部分 agent 完成时 benchmark 仍为 running", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-1",
        passedChecks: 3,
        failedChecks: 0,
        findingCount: 0,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 10000,
      });

      const updated = service.getBenchmark(benchmark.id)!;
      assert.equal(updated.status, "running");
      assert.ok(updated.completedAt === undefined);
    });

    it("所有 agent 完成后 benchmark 推进到 completed", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-1",
        passedChecks: 3,
        failedChecks: 0,
        findingCount: 0,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 10000,
      });

      const updated = service.collectResult({
        benchmarkId: benchmark.id,
        agent: "claude",
        qualityRunId: "q-2",
        passedChecks: 2,
        failedChecks: 1,
        findingCount: 1,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 15000,
      });

      assert.equal(updated.status, "completed");
      assert.ok(updated.completedAt !== undefined);
    });

    it("agent 失败时记录 failureReason", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli"],
      });

      const updated = service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-1",
        passedChecks: 0,
        failedChecks: 3,
        findingCount: 0,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 5000,
        status: "failed",
        failureReason: "all checks failed",
      });

      const run = updated.runs[0]!;
      assert.equal(run.status, "failed");
      assert.equal(run.failureReason, "all checks failed");
      assert.ok(run.completedAt !== undefined);
    });

    it("不存在的 benchmark 抛错", () => {
      assert.throws(
        () => service.collectResult({
          benchmarkId: "nonexistent",
          agent: "devin-cli",
          qualityRunId: "q-1",
          passedChecks: 0,
          failedChecks: 0,
          findingCount: 0,
          blockingCount: 0,
          fixRounds: 0,
          durationMs: 0,
        }),
        /unknown benchmark/,
      );
    });

    it("不存在的 agent 抛错", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli"],
      });

      assert.throws(
        () => service.collectResult({
          benchmarkId: benchmark.id,
          agent: "unknown-agent",
          qualityRunId: "q-1",
          passedChecks: 0,
          failedChecks: 0,
          findingCount: 0,
          blockingCount: 0,
          fixRounds: 0,
          durationMs: 0,
        }),
        /not in benchmark/,
      );
    });
  });

  describe("cancelBenchmark", () => {
    it("取消时所有 pending run 标记为 cancelled", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      const cancelled = service.cancelBenchmark(benchmark.id);
      assert.equal(cancelled.status, "cancelled");
      assert.ok(cancelled.completedAt !== undefined);
      for (const run of cancelled.runs) {
        assert.equal(run.status, "cancelled");
      }
    });

    it("已完成的 run 不被改变", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-1",
        passedChecks: 3,
        failedChecks: 0,
        findingCount: 0,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 10000,
      });

      const cancelled = service.cancelBenchmark(benchmark.id);
      const devinRun = cancelled.runs.find((r) => r.agent === "devin-cli")!;
      assert.equal(devinRun.status, "completed");
      const claudeRun = cancelled.runs.find((r) => r.agent === "claude")!;
      assert.equal(claudeRun.status, "cancelled");
    });
  });

  describe("deleteBenchmark", () => {
    it("删除 benchmark 及其 runs", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "b1",
        taskSet: "t1",
        agents: ["devin-cli"],
      });

      const ok = service.deleteBenchmark(benchmark.id);
      assert.equal(ok, true);
      assert.equal(service.getBenchmark(benchmark.id), undefined);
    });

    it("不存在的 id 返回 false", () => {
      assert.equal(service.deleteBenchmark("nonexistent"), false);
    });
  });

  describe("native agent 基线对比", () => {
    it("支持多个 native agent 对比", () => {
      const agents = ["devin-cli", "claude", "codex", "opencode"];
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "native-baseline",
        taskSet: "implement 5 features",
        agents,
      });

      assert.equal(benchmark.runs.length, 4);

      for (let i = 0; i < agents.length; i++) {
        const updated = service.collectResult({
          benchmarkId: benchmark.id,
          agent: agents[i]!,
          qualityRunId: `q-${i}`,
          passedChecks: 5 - i,
          failedChecks: i,
          findingCount: i,
          blockingCount: Math.max(0, i - 1),
          fixRounds: i,
          durationMs: 10000 * (i + 1),
        });
        if (i < agents.length - 1) {
          assert.equal(updated.status, "running");
        } else {
          assert.equal(updated.status, "completed");
        }
      }

      const finalBenchmark = service.getBenchmark(benchmark.id)!;
      assert.equal(finalBenchmark.status, "completed");
      assert.equal(finalBenchmark.runs.length, 4);

      const devin = finalBenchmark.runs.find((r) => r.agent === "devin-cli")!;
      assert.equal(devin.passedChecks, 5);
      assert.equal(devin.failedChecks, 0);

      const codex = finalBenchmark.runs.find((r) => r.agent === "codex")!;
      assert.equal(codex.passedChecks, 3);
      assert.equal(codex.failedChecks, 2);
    });
  });

  describe("持久化", () => {
    it("benchmark 持久化后重启可恢复", () => {
      const benchmark = createAndSave(service, store, {
        projectId: project.id,
        name: "persist-test",
        taskSet: "t1",
        agents: ["devin-cli", "claude"],
      });

      service.collectResult({
        benchmarkId: benchmark.id,
        agent: "devin-cli",
        qualityRunId: "q-1",
        passedChecks: 3,
        failedChecks: 0,
        findingCount: 0,
        blockingCount: 0,
        fixRounds: 0,
        durationMs: 10000,
      });

      store.close();
      const store2 = new Store(path.join(dir, "test.db"));
      const service2 = new BenchmarkService(store2);
      const restored = service2.getBenchmark(benchmark.id)!;

      assert.equal(restored.name, "persist-test");
      assert.equal(restored.runs.length, 2);
      const devinRun = restored.runs.find((r) => r.agent === "devin-cli")!;
      assert.equal(devinRun.status, "completed");
      assert.equal(devinRun.passedChecks, 3);
      assert.equal(restored.status, "running");

      store2.close();
    });
  });
});

describe("startBenchmark (pure function)", () => {
  it("缺少 projectId 时抛错", () => {
    assert.throws(
      () => startBenchmark({ projectId: "", name: "n", taskSet: "t", agents: ["a"] }),
      /projectId is required/,
    );
  });

  it("缺少 name 时抛错", () => {
    assert.throws(
      () => startBenchmark({ projectId: "p", name: "", taskSet: "t", agents: ["a"] }),
      /name is required/,
    );
  });

  it("缺少 taskSet 时抛错", () => {
    assert.throws(
      () => startBenchmark({ projectId: "p", name: "n", taskSet: "", agents: ["a"] }),
      /taskSet is required/,
    );
  });

  it("无 agent 时抛错", () => {
    assert.throws(
      () => startBenchmark({ projectId: "p", name: "n", taskSet: "t", agents: [] }),
      /at least one agent/,
    );
  });

  it("返回的 benchmark 不含 completedAt", () => {
    const benchmark = startBenchmark({
      projectId: "p",
      name: "n",
      taskSet: "t",
      agents: ["a"],
    });
    assert.ok(benchmark.completedAt === undefined);
    assert.equal(benchmark.status, "running");
  });
});

describe("id generators", () => {
  it("newBenchmarkId 生成 b- 前缀 id", () => {
    const id = newBenchmarkId();
    assert.ok(id.startsWith("b-"));
    assert.ok(id.length > 2);
  });

  it("newBenchmarkRunId 生成 br- 前缀 id", () => {
    const id = newBenchmarkRunId();
    assert.ok(id.startsWith("br-"));
    assert.ok(id.length > 3);
  });

  it("id 唯一性", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newBenchmarkId());
      ids.add(newBenchmarkRunId());
    }
    assert.equal(ids.size, 200);
  });
});
