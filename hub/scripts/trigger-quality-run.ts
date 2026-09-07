import * as path from "node:path";
import * as fs from "node:fs";
import { Store } from "../src/store.js";
import { QualityService } from "../src/quality/service.js";
import { GateEngine } from "../src/quality/gate.js";
import { LocalExecutionProvider } from "../src/quality/execution-local.js";
import { collectBaseline, collectChangeSet } from "../src/quality/change-set.js";
import { registerProject } from "../src/quality/project.js";
import { ReviewOrchestrator, type ReviewerSessionRunner } from "../src/quality/review-orchestrator.js";
import { FixerOrchestrator, type FixerSessionRunner } from "../src/quality/fixer-orchestrator.js";
import { RunPermissionManager } from "../src/quality/permissions.js";
import type { ProjectScope, QualityRun, ReviewFinding } from "../src/quality/types.js";

const PROJECT_ROOT = process.env.QUALITY_PROJECT_ROOT ?? "/home/yan/.openclaw/workspace-devin/agent-hub";
const DB_DIR = process.env.QUALITY_DB_DIR ?? path.resolve(path.join(PROJECT_ROOT, "hub", "data-sandbox"));
const ARTIFACT_DIR = path.resolve(DB_DIR, "quality");
const TIMEOUT_MS = 10 * 60 * 1000;
const CANARY_FILE = "hub/scripts/trigger-quality-run.ts";
const CANARY_TEST = "hub/src/sandbox-canary.test.ts";
const CANARY_TARGET_VALUE = 1;

/** 沙盒 canary 常量 — 用于验证 quality gate 检测能力。 */
export const SANDBOX_CANARY_VERSION = 2;

const TERMINAL = new Set(["accepted", "failed", "cancelled", "quarantined"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function elapsed(startTime: number): number {
  return Math.round((Date.now() - startTime) / 1000);
}

function readCanaryValue(projectRoot: string): number {
  const filePath = path.join(projectRoot, CANARY_FILE);
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/export const SANDBOX_CANARY_VERSION = (\d+);/);
  return match ? parseInt(match[1]!, 10) : -1;
}

/** 模拟 reviewer — 读取文件实际检查 canary 状态。 */
function makeFakeReviewer(projectRoot: string): ReviewerSessionRunner {
  let sessionCounter = 0;
  return {
    async ensureSession() {
      sessionCounter++;
      return `fake-reviewer-${sessionCounter}`;
    },
    async promptOnce(sessionId: string, _prompt: string) {
      console.log(`[trigger] fake reviewer ${sessionId} analyzing code...`);
      await sleep(500);
      const version = readCanaryValue(projectRoot);

      if (version === CANARY_TARGET_VALUE) {
        console.log(`[trigger] reviewer: SANDBOX_CANARY_VERSION=${version}, canary OK, verdict=pass`);
        return {
          output: JSON.stringify({ verdict: "pass", findings: [] }),
          stopReason: "end_turn",
        };
      }

      console.log(`[trigger] reviewer: SANDBOX_CANARY_VERSION=${version}, canary broken, verdict=needs-fix`);
      return {
        output: JSON.stringify({
          verdict: "needs-fix",
          findings: [
            {
              severity: "major",
              confidence: 0.95,
              category: "correctness",
              file: CANARY_FILE,
              line: 21,
              claim: `SANDBOX_CANARY_VERSION=${version} 但 ${CANARY_TEST} 断言应为 ${CANARY_TARGET_VALUE}，full gate 测试会失败`,
              evidence: `export const SANDBOX_CANARY_VERSION = ${version}; 与 assert.equal(SANDBOX_CANARY_VERSION, ${CANARY_TARGET_VALUE}) 不匹配`,
              reproduction: `cd hub && npm test → sandbox canary test fails: ${version} !== ${CANARY_TARGET_VALUE}`,
              suggestion: `将 SANDBOX_CANARY_VERSION 从 ${version} 改为 ${CANARY_TARGET_VALUE}`,
            },
          ],
        }),
        stopReason: "end_turn",
      };
    },
  };
}

/** 模拟 fixer — 实际编辑文件修复 canary。 */
function makeFakeFixer(projectRoot: string): FixerSessionRunner {
  let sessionCounter = 0;
  return {
    async ensureSession() {
      sessionCounter++;
      return `fake-fixer-${sessionCounter}`;
    },
    async promptOnce(sessionId: string, _prompt: string) {
      console.log(`[trigger] fake fixer ${sessionId} applying fix...`);
      await sleep(500);
      const filePath = path.join(projectRoot, CANARY_FILE);
      const current = readCanaryValue(projectRoot);
      if (current === CANARY_TARGET_VALUE) {
        console.log(`[trigger] fixer: canary already fixed (value=${current}), no change needed`);
        return { output: "canary already fixed", stopReason: "end_turn" };
      }
      let content = fs.readFileSync(filePath, "utf8");
      content = content.replace(
        `export const SANDBOX_CANARY_VERSION = ${current};`,
        `export const SANDBOX_CANARY_VERSION = ${CANARY_TARGET_VALUE};`,
      );
      fs.writeFileSync(filePath, content, "utf8");
      console.log(`[trigger] fixer applied: SANDBOX_CANARY_VERSION ${current} → ${CANARY_TARGET_VALUE}`);
      return { output: `fixed SANDBOX_CANARY_VERSION = ${CANARY_TARGET_VALUE}`, stopReason: "end_turn" };
    },
  };
}

async function main(): Promise<void> {
  console.log(`[trigger] project_root=${PROJECT_ROOT}`);
  console.log(`[trigger] db_dir=${DB_DIR}`);
  console.log(`[trigger] timeout=${TIMEOUT_MS / 1000}s`);

  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const store = new Store(DB_DIR);
  const emit = () => {};
  const service = new QualityService(store, emit as never);

  // 1. 确认/注册项目
  let project: ProjectScope | undefined = service.listProjects().find(
    (p) => p.root === PROJECT_ROOT || p.displayName === "agent-hub",
  );
  if (!project) {
    const scope = registerProject({
      connectionId: "sandbox-trigger",
      root: PROJECT_ROOT,
      displayName: "agent-hub-sandbox",
    });
    store.upsertQualityProject(scope);
    project = scope;
    console.log(`[trigger] registered project: ${project.id}`);
  } else {
    console.log(`[trigger] project already registered: ${project.id}`);
  }

  const { policy, source } = service.getPolicy(project.id);
  console.log(`[trigger] policy source=${source}, checks=${policy.checks.length}, review.enabled=${policy.review.enabled}, autonomy=${policy.autonomy}`);
  for (const c of policy.checks) {
    console.log(`  - ${c.id} (${c.tier}): ${c.argv.join(" ")}`);
  }

  const canaryPath = path.join(PROJECT_ROOT, CANARY_TEST);
  const canaryExists = fs.existsSync(canaryPath);
  const canaryVal = canaryExists ? readCanaryValue(PROJECT_ROOT) : -1;
  console.log(`[trigger] canary: exists=${canaryExists}, SANDBOX_CANARY_VERSION=${canaryVal} (target=${CANARY_TARGET_VALUE})`);

  // 2. 触发运行
  const run = service.startRun({
    projectId: project.id,
    trigger: "interactive",
    risk: "low",
    policyVersion: String(policy.version),
    budget: { maxFixRounds: policy.review.maxFixRounds ?? 2, timeoutMs: 60000 },
  });
  console.log(`[trigger] run started: id=${run.id}, stage=${run.stage}`);

  const startTime = Date.now();
  const deadline = startTime + TIMEOUT_MS;
  let current = run;
  let fixerFixed = false;

  const exec = new LocalExecutionProvider({ artifactRoot: ARTIFACT_DIR });
  const gate = new GateEngine(exec, { onSaveCheck: (check) => service.saveCheck(check) });
  const permMgr = new RunPermissionManager();
  const reviewer = new ReviewOrchestrator(service, permMgr, makeFakeReviewer(PROJECT_ROOT), { artifactDir: ARTIFACT_DIR });
  const fixer = new FixerOrchestrator(service, permMgr, makeFakeFixer(PROJECT_ROOT), gate, { artifactDir: ARTIFACT_DIR });

  try {
    // queued → preflight → implementing → collecting
    current = service.advance(run.id, "preflight");
    console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
    current = service.advance(run.id, "implementing");
    console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
    current = service.advance(run.id, "collecting");
    console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);

    // 收集 ChangeSet
    const baseline = collectBaseline(project);
    let changeSet = collectChangeSet(
      run.id, project, baseline,
      { protectedPaths: policy.protectedPaths, riskRules: policy.riskRules },
      ARTIFACT_DIR,
    );
    console.log(`[trigger] changeSet: ${changeSet.files.length} files, patchHash=${changeSet.patchHash.slice(0, 16)}...`);
    for (const f of changeSet.files) console.log(`  - [${f.status}] ${f.path}`);
    service.saveRun({ ...current, patchHash: changeSet.patchHash });

    // collecting → quick-verifying
    current = service.advance(run.id, "quick-verifying");
    console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);

    // quick gate
    console.log(`[trigger] running quick gate...`);
    const quickResult = await gate.runGate(project, policy, "quick", run.id, changeSet, 1);
    console.log(`[trigger] quick gate: passed=${quickResult.passed}, codeFailed=${quickResult.codeFailed}, infraFailed=${quickResult.infraFailed}`);
    for (const c of quickResult.checks) {
      console.log(`  - ${c.checkId}: ${c.status} (exit=${c.exitCode ?? "n/a"}, ${c.durationMs ?? 0}ms)`);
    }

    if (!quickResult.passed) {
      current = service.advance(run.id, "failed");
      console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage} (quick gate failed)`);
      throw new Error("quick gate failed");
    }

    // quick-verifying → reviewing
    current = service.advance(run.id, "reviewing");
    console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);

    // reviewing → fixing → reviewing 循环（review.enabled 时走 reviewer；否则跳过到 full-verifying）
    let fixRound = 0;
    while (current.stage === "reviewing" || current.stage === "fixing") {
      if (Date.now() >= deadline) {
        console.log(`[trigger] timeout, cancelling...`);
        current = service.cancelRun(run.id);
        break;
      }

      if (current.stage === "reviewing") {
        if (policy.review.enabled && canaryExists) {
          console.log(`[trigger] running reviewer...`);
          const reviewResult = await reviewer.runReview(run.id);
          console.log(`[trigger] review: verdict=${reviewResult.verdict}, findings=${reviewResult.findings.length}, nextStage=${reviewResult.nextStage}`);
          for (const f of reviewResult.findings) {
            console.log(`  - [${f.severity}] ${f.claim} (blocking=${f.blocking})`);
            if (f.suggestion) console.log(`    suggestion: ${f.suggestion}`);
          }
        } else {
          // observe 模式或无 canary：跳过 review，直接到 full-verifying
          console.log(`[trigger] review disabled or no canary, skipping to full-verifying`);
          current = service.advance(run.id, "full-verifying");
          console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
          break;
        }
        current = service.getRun(run.id)!;
        console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
      }

      if (current.stage === "fixing") {
        fixRound++;
        console.log(`[trigger] running fixer (round ${fixRound})...`);
        const fixResult = await fixer.runFix(run.id);
        console.log(`[trigger] fixer: fixed=${fixResult.fixed}, nextStage=${fixResult.nextStage}`);
        fixerFixed = fixerFixed || fixResult.fixed;
        current = service.getRun(run.id)!;
        console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
      }

      if (TERMINAL.has(current.stage)) break;
    }

    // full-verifying
    if (current.stage === "full-verifying") {
      const freshBaseline = collectBaseline(project);
      changeSet = collectChangeSet(
        run.id, project, freshBaseline,
        { protectedPaths: policy.protectedPaths, riskRules: policy.riskRules },
        ARTIFACT_DIR,
      );
      service.saveRun({ ...current, patchHash: changeSet.patchHash });

      console.log(`[trigger] running full gate...`);
      const fullResult = await gate.runGate(project, policy, "full", run.id, changeSet, current.fixRound + 1);
      console.log(`[trigger] full gate: passed=${fullResult.passed}, codeFailed=${fullResult.codeFailed}, infraFailed=${fullResult.infraFailed}`);
      for (const c of fullResult.checks) {
        console.log(`  - ${c.checkId}: ${c.status} (exit=${c.exitCode ?? "n/a"}, ${c.durationMs ?? 0}ms)`);
        if (c.summary) console.log(`    summary: ${c.summary.slice(0, 200)}`);
      }

      if (fullResult.passed) {
        current = service.advance(run.id, "accepted");
      } else {
        current = service.advance(run.id, "failed");
      }
      console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
    }

    if (current.stage === "awaiting-approval") {
      console.log(`[trigger] auto-approving (sandbox)...`);
      current = service.approveRun(run.id);
      console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
    }

    if (!TERMINAL.has(current.stage) && Date.now() >= deadline) {
      console.log(`[trigger] timeout, cancelling...`);
      current = service.cancelRun(run.id);
      console.log(`[trigger] ${elapsed(startTime)}s stage: ${current.stage}`);
    }

  } catch (err) {
    console.error(`[trigger] error: ${String(err)}`);
    if (!TERMINAL.has(service.getRun(run.id)!.stage)) {
      try { current = service.cancelRun(run.id); } catch { /* */ }
    }
  }

  // 最终报告
  const finalRun = service.getRun(run.id)!;
  const checks = service.listChecks(run.id);
  const findings: ReviewFinding[] = service.listFindings(run.id);

  console.log("\n=== 最终报告 ===");
  console.log(`runId: ${run.id}`);
  console.log(`stage: ${finalRun.stage}`);
  console.log(`verdict: ${finalRun.verdict ?? "none"}`);
  console.log(`fixRound: ${finalRun.fixRound}`);
  console.log(`patchHash: ${finalRun.patchHash ?? "none"}`);
  console.log(`fixer fixed: ${fixerFixed ? "yes" : "no"}`);
  console.log(`checks: ${checks.length}`);
  for (const c of checks) {
    console.log(`  - ${c.checkId} (attempt ${c.attempt}): ${c.status} (exit=${c.exitCode ?? "n/a"}, ${c.durationMs ?? 0}ms)`);
  }
  console.log(`findings: ${findings.length}`);
  for (const f of findings) {
    console.log(`  - [${f.severity}] ${f.claim} (blocking=${f.blocking}, status=${f.status})`);
  }
  console.log(`file modifications: ${finalRun.patchHash ? "yes" : "no"}`);
  console.log(`duration: ${elapsed(startTime)}s`);

  reviewer.cleanupRun(run.id);
  fixer.cleanupRun(run.id);
  store.close();
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("trigger-quality-run.ts");
if (isMain) {
  main().catch((err) => {
    console.error(`[trigger] fatal: ${String(err)}`);
    process.exit(1);
  });
}
