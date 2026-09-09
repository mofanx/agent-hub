import type { ProjectScope, QualityPolicy, QualityPolicyV2, QualityRun, QualityRisk, QualityTrigger } from "./quality/types.js";
import type { Store } from "./store.js";
import { WriterLeaseManager, acquireOrThrow, type Lease } from "./quality/lease.js";
import { RunContextRegistry, type RunContext } from "./quality/run-context.js";
import { snapshotBaseline, type BaselineSnapshot } from "./quality/change-set.js";
import { hashPolicy, writePolicySnapshot } from "./quality/policy.js";
import type { QualityService } from "./quality/service.js";

/**
 * DispatchPlan：将 roomModeManager 的"决策"与"实际 dispatch"分离。
 *
 * 决策阶段：roomModeManager 决定要派发给哪些 session、内容是什么。
 * 预绑定阶段：在 prompt 发出之前，完成项目解析、writer lease、baseline snapshot、
 *            policy snapshot、run-context 绑定，确保 agent 写文件时 run 已就绪。
 * dispatch 阶段：实际发出 prompt。
 *
 * 这样文件/tool/git 信号只需 markDirty，prompt/task 完成后才 collect，
 * 避免 race condition（agent 还在写，gate 就开始收集）。
 */

export type DispatchTarget = {
  sessionId: string;
  content: string | Array<Record<string, unknown>>;
  taskId?: string | undefined;
};

export type DispatchPlan = {
  roomId?: string | undefined;
  targets: DispatchTarget[];
  trigger: QualityTrigger;
  risk: QualityRisk;
};

export type PreBindResult = {
  plan: DispatchPlan;
  bindings: SessionBinding[];
};

export type SessionBinding = {
  sessionId: string;
  taskId?: string | undefined;
  project: ProjectScope;
  policy: QualityPolicy | QualityPolicyV2;
  policyHash: string;
  policySnapshotRef: string;
  baselineSnapshot: BaselineSnapshot;
  lease: Lease;
  run: QualityRun;
  runContext: RunContext;
};

export type PreBindDeps = {
  qualityService: QualityService;
  store: Store;
  leaseManager: WriterLeaseManager;
  runContextRegistry: RunContextRegistry;
  qualityArtifactDir: string;
  resolveProject: (sessionPaths: string[]) => ProjectScope | undefined;
  sessionPathsOf?: (sessionId: string) => string[];
};

/**
 * 为 DispatchPlan 的每个 target 执行预绑定：
 * 1. 项目解析（通过 session 的 cwd / artifact 路径）
 * 2. writer lease（同项目同时只有一个 writer）
 * 3. baseline snapshot（git base + dirty + untracked hash）
 * 4. 创建 QualityRun（stage=queued，generation=0）
 * 5. policy snapshot（hash + 写盘，确保 run 期间 policy 不变）
 * 6. 绑定 run-context（sessionId → runId + taskId + role=implementer）
 *
 * 如果项目解析失败（无项目匹配），跳过该 target 的预绑定，
 * 仍然允许 dispatch（只是不会有 quality run）。
 */
export function preBindDispatch(plan: DispatchPlan, deps: PreBindDeps): PreBindResult {
  const bindings: SessionBinding[] = [];
  for (const target of plan.targets) {
    const paths = deps.sessionPathsOf ? deps.sessionPathsOf(target.sessionId) : [];
    const project = deps.resolveProject(paths);
    if (!project) continue;

    let lease: Lease;
    try {
      lease = acquireOrThrow(deps.leaseManager, project, target.sessionId, "");
    } catch {
      continue;
    }

    const policyLoad = deps.qualityService.loadPolicyWithVersion(project.id);
    const policy = policyLoad.policy ?? ({} as QualityPolicy);
    const policyHash = hashPolicy(policy);
    const baselineSnapshot = snapshotBaseline(project);

    const run = deps.qualityService.startRun({
      projectId: project.id,
      trigger: plan.trigger,
      ...(plan.roomId !== undefined ? { roomId: plan.roomId } : {}),
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      implementerSessionId: target.sessionId,
      risk: plan.risk,
      policyVersion: String((policy as { version: number }).version),
      policyHash,
      budget: {
        maxFixRounds: (policy as { review?: { maxFixRounds?: number } }).review?.maxFixRounds ?? 0,
        timeoutMs: 60000,
      },
    });

    const snap = writePolicySnapshot(policy, deps.qualityArtifactDir, run.id);
    deps.leaseManager.acquire(project.id, target.sessionId, run.id);

    const runContext: RunContext = {
      runId: run.id,
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      role: "implementer" as const,
    };
    deps.runContextRegistry.bind(target.sessionId, runContext, plan.roomId);

    bindings.push({
      sessionId: target.sessionId,
      ...(target.taskId !== undefined ? { taskId: target.taskId } : {}),
      project,
      policy,
      policyHash,
      policySnapshotRef: snap.ref,
      baselineSnapshot,
      lease,
      run,
      runContext,
    });
  }
  return { plan, bindings };
}

/**
 * 释放预绑定资源（dispatch 失败或取消时）。
 */
export function releaseBindings(bindings: SessionBinding[], deps: PreBindDeps): void {
  for (const b of bindings) {
    deps.leaseManager.release(b.project.id, b.sessionId);
    deps.runContextRegistry.unbind(b.sessionId);
    try {
      deps.qualityService.cancelRun(b.run.id);
    } catch { /* run 可能已被推进 */ }
  }
}
