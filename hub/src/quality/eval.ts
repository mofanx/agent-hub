import * as crypto from "node:crypto";
import type {
  BenchmarkRun,
  BenchmarkStatus,
  QualityBenchmark,
} from "./types.js";
import type { Store } from "../store.js";

/**
 * BenchmarkService（设计文档 §14 / P4 评测基线）。
 *
 * 职责：
 * - 创建/列出/查询 benchmark（同一 projectId + taskSet 下多 agent 对比）；
 * - 为每个 agent 创建 BenchmarkRun（初始 pending）；
 * - 从关联的 QualityRun 收集指标（check/finding/fix 数据）；
 * - 支持 native agent 基线对比（devin-cli / claude / codex 等）；
 * - 不直接执行 agent，由调用方驱动 QualityRun 后回调 collectResult。
 *
 * 评测指标来自真实 QualityRun 数据（§14.2），不采信 agent 自报告。
 */

export type StartBenchmarkParams = {
  projectId: string;
  name: string;
  taskSet: string;
  agents: string[];
};

export type CollectResultParams = {
  benchmarkId: string;
  agent: string;
  qualityRunId: string;
  passedChecks: number;
  failedChecks: number;
  findingCount: number;
  blockingCount: number;
  fixRounds: number;
  durationMs: number;
  status?: BenchmarkStatus;
  failureReason?: string;
};

/** 生成 benchmark id。 */
export function newBenchmarkId(): string {
  return `b-${crypto.randomBytes(8).toString("hex")}`;
}

/** 生成 benchmark run id。 */
export function newBenchmarkRunId(): string {
  return `br-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 创建 benchmark 并为每个 agent 初始化一个 pending 的 BenchmarkRun（不持久化，由调用方写入 store）。
 * 返回完整的 QualityBenchmark（含 runs）。
 */
export function startBenchmark(params: StartBenchmarkParams): QualityBenchmark {
  if (!params.projectId) throw new Error("projectId is required");
  if (!params.name) throw new Error("name is required");
  if (!params.taskSet) throw new Error("taskSet is required");
  if (params.agents.length === 0) throw new Error("at least one agent is required");

  const now = Date.now();
  const benchmarkId = newBenchmarkId();
  const runs: BenchmarkRun[] = params.agents.map((agent) => ({
    id: newBenchmarkRunId(),
    benchmarkId,
    agent,
    status: "pending",
    passedChecks: 0,
    failedChecks: 0,
    findingCount: 0,
    blockingCount: 0,
    fixRounds: 0,
    durationMs: 0,
    createdAt: now,
    updatedAt: now,
  }));

  return {
    id: benchmarkId,
    projectId: params.projectId,
    name: params.name,
    taskSet: params.taskSet,
    agents: params.agents,
    runs,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

export class BenchmarkService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 列出 benchmark（可按 projectId 过滤）。 */
  listBenchmarks(projectId?: string): QualityBenchmark[] {
    return this.store.listQualityBenchmarks(projectId);
  }

  /** 获取单个 benchmark（含 runs）。 */
  getBenchmark(id: string): QualityBenchmark | undefined {
    return this.store.getQualityBenchmark(id);
  }

  /**
   * 收集某个 agent 的运行结果（从 QualityRun 指标回填）。
   * 更新 BenchmarkRun 状态并检查 benchmark 是否全部完成。
   */
  collectResult(params: CollectResultParams): QualityBenchmark {
    const benchmark = this.store.getQualityBenchmark(params.benchmarkId);
    if (!benchmark) throw new Error(`unknown benchmark: ${params.benchmarkId}`);

    const run = benchmark.runs.find((r) => r.agent === params.agent);
    if (!run) throw new Error(`agent ${params.agent} not in benchmark ${params.benchmarkId}`);

    const now = Date.now();
    const status = params.status ?? "completed";
    const updatedRun: BenchmarkRun = {
      ...run,
      qualityRunId: params.qualityRunId,
      status,
      passedChecks: params.passedChecks,
      failedChecks: params.failedChecks,
      findingCount: params.findingCount,
      blockingCount: params.blockingCount,
      fixRounds: params.fixRounds,
      durationMs: params.durationMs,
      ...(params.failureReason !== undefined ? { failureReason: params.failureReason } : {}),
      updatedAt: now,
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { completedAt: now }
        : {}),
    };

    this.store.saveQualityBenchmarkRun(updatedRun);

    const allRuns = this.store.listQualityBenchmarkRuns(params.benchmarkId);
    const allDone = allRuns.every(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "cancelled",
    );

    const updatedBenchmark: QualityBenchmark = {
      ...benchmark,
      runs: allRuns,
      status: allDone ? "completed" : "running",
      updatedAt: now,
      ...(allDone ? { completedAt: now } : {}),
    };
    this.store.saveQualityBenchmark(updatedBenchmark);

    return updatedBenchmark;
  }

  /** 取消 benchmark（所有未完成的 run 标记为 cancelled）。 */
  cancelBenchmark(id: string): QualityBenchmark {
    const benchmark = this.store.getQualityBenchmark(id);
    if (!benchmark) throw new Error(`unknown benchmark: ${id}`);
    const now = Date.now();

    for (const run of benchmark.runs) {
      if (run.status === "pending" || run.status === "running") {
        this.store.saveQualityBenchmarkRun({
          ...run,
          status: "cancelled",
          updatedAt: now,
          completedAt: now,
        });
      }
    }

    const allRuns = this.store.listQualityBenchmarkRuns(id);
    const updated: QualityBenchmark = {
      ...benchmark,
      runs: allRuns,
      status: "cancelled",
      updatedAt: now,
      completedAt: now,
    };
    this.store.saveQualityBenchmark(updated);
    return updated;
  }

  /** 删除 benchmark。 */
  deleteBenchmark(id: string): boolean {
    return this.store.deleteQualityBenchmark(id);
  }
}
