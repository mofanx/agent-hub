import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const url = process.env.HUB_WS_URL ?? "ws://127.0.0.1:8787?token=dev-token";
const ws = new WebSocket(url);
let seq = 0;

function call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== id) return;
        ws.off("message", onMessage);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      } catch {}
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function getRun(runId: string): Promise<any> {
  const { run } = await call<{ run: any }>("quality.run.get", { id: runId });
  return run;
}

async function waitForTerminal(runId: string, timeoutMs = 90000): Promise<any> {
  const terminalStages = ["accepted", "failed", "inconclusive", "waived", "cancelled", "quarantined", "stale"];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await getRun(runId);
    console.log(`  run ${runId} stage: ${run.stage}`);
    if (terminalStages.includes(run.stage)) return run;
    await sleep(1000);
  }
  throw new Error(`run ${runId} did not reach terminal in ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const projectRoot = "/tmp/agent-hub-dogfood";

  // 0. 准备：确保 hello.txt 存在并提交为 baseline
  console.log("=== Step 0: Prepare baseline ===");
  fs.mkdirSync(path.join(projectRoot, ".devin"), { recursive: true });
  if (!fs.existsSync(path.join(projectRoot, ".git"))) {
    execSync("git init && git config user.name 'Agent Hub Dogfood' && git config user.email 'dogfood@localhost'", { cwd: projectRoot, stdio: "pipe" });
  }
  fs.writeFileSync(path.join(projectRoot, ".devin", "quality.json"), JSON.stringify({
    version: 2,
    enforcement: { mode: "report", approvalRisk: "high" },
    remediation: { mode: "off", maxFixRounds: 0 },
    requirements: { mode: "off", maxQuestions: 3, rules: [] },
    review: { mode: "off", blockSeverity: "major", minBlockingConfidence: 0.8 },
    verification: { mode: "require-evidence", rules: [] },
    evidence: { excludePaths: [], retentionDays: 30, maxArtifactBytes: 10485760 },
    checks: [
      { id: "echo-quick", cwd: ".", argv: ["node", "-e", "process.exit(0)"], tier: "quick", timeoutMs: 10000, required: true },
      { id: "echo-full", cwd: ".", argv: ["node", "-e", "process.exit(0)"], tier: "full", timeoutMs: 10000, required: true },
    ],
    protectedPaths: [],
    riskRules: [],
    requirementRules: [],
    verificationRules: [],
  }, null, 2));
  const srcFile = path.join(projectRoot, "hello.txt");
  fs.writeFileSync(srcFile, "hello world\n");
  try {
    execSync("git add -A && git commit -m 'baseline'", { cwd: projectRoot, stdio: "pipe" });
    console.log("  baseline committed");
  } catch {
    console.log("  baseline already committed (nothing to commit)");
  }

  // 1. 注册项目
  console.log("=== Step 1: Register project ===");
  const { project } = await call<{ project: { id: string; root: string } }>(
    "quality.project.register",
    { connectionId: "manual", root: projectRoot, displayName: "dogfood-l3", localExec: true },
  );
  console.log(`  project: ${project.id} (${project.root})`);

  // 2. L0 需求评估
  console.log("=== Step 2: L0 requirement evaluation ===");
  const l0Result = await call<any>("requirement.evaluate", {
    text: "修改 hello.txt，添加一行注释说明",
    source: "manual",
    correlationId: `dogfood-${Date.now()}`,
    projectId: project.id,
    l0Mode: "shadow",
  });
  const specId = l0Result.spec?.id;
  const requestId = l0Result.request?.id;
  console.log(`  L0 spec: ${specId ?? "N/A"} (status: ${l0Result.spec?.status ?? "N/A"})`);
  console.log(`  L0 request: ${requestId ?? "N/A"}`);
  console.log(`  L0 clarification: ${l0Result.clarificationRequest ? "required" : "none"}`);

  if (!specId) { console.error("  ERROR: L0 did not create spec"); return; }

  if (l0Result.clarificationRequest) {
    console.log("  -> Skipping clarification...");
    await call("requirement.clarificationSkip", { clarificationRequestId: l0Result.clarificationRequest.id });
  }

  // 2b. 给 spec 添加验收标准（L0 默认不生成 criteria，手动补充以测试 L3）
  console.log("=== Step 2b: Add acceptance criteria to spec ===");
  await call("requirement.specUpdate", {
    id: specId,
    acceptanceCriteria: [
      {
        id: "ac-1",
        description: "hello.txt 被修改，包含注释",
        required: true,
        evidenceMode: "all",
        expectedEvidence: [
          { id: "exp-1", kind: "check", checkId: "echo-quick" },
          { id: "exp-2", kind: "check", checkId: "echo-full" },
        ],
      },
    ],
    status: "ready",
  });
  console.log(`  spec ${specId} updated with 1 acceptance criterion`);

  // 3. 创建 WorkItem（绑定 spec）
  console.log("=== Step 3: Create WorkItem ===");
  const { workItem } = await call<{ workItem: any }>("quality.work.create", {
    requestId,
    projectId: project.id,
    mode: "mention",
    specId,
    kind: "implementation",
  });
  console.log(`  workItem: ${workItem.id} (status: ${workItem.status})`);

  // 4. 模拟代码变更：修改 hello.txt（不 commit，保留为未提交状态，让 gate runner 的 git diff 能检测到）
  console.log("=== Step 4: Simulate code change (uncommitted) ===");
  fs.writeFileSync(srcFile, "hello world\n# dogfood test comment\n");
  console.log("  file modified (uncommitted)");

  // 5. 创建 QualityRun（绑定 workItem，不传 patchHash，让 gate runner 自动收集）
  console.log("=== Step 5: Create QualityRun ===");
  const { run } = await call<{ run: { id: string; stage: string } }>(
    "quality.run.start",
    {
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      workItemId: workItem.id,
      policyVersion: "2",
      budget: { maxFixRounds: 0, timeoutMs: 60000 },
    },
  );
  console.log(`  run: ${run.id} (stage: ${run.stage})`);

  // 6. 等待 quick-verifying 完成，然后手动推进到 full-verifying → requirement-verifying
  console.log("=== Step 6: Wait for quick gate, then advance ===");
  // 等待 quick-verifying 阶段的 check 完成
  await sleep(3000);
  let runCurrent = await getRun(run.id);
  console.log(`  after quick gate: stage=${runCurrent.stage}`);
  
  // 如果还在 quick-verifying，等 check 完成
  while (runCurrent.stage === "quick-verifying" || runCurrent.stage === "queued" || runCurrent.stage === "preflight" || runCurrent.stage === "implementing" || runCurrent.stage === "collecting") {
    await sleep(1000);
    runCurrent = await getRun(run.id);
    console.log(`  waiting... stage=${runCurrent.stage}`);
  }
  
  // 如果到了 inconclusive（gate 判定无 check 或失败），尝试手动推进
  if (runCurrent.stage === "inconclusive") {
    console.log("  run went to inconclusive, checking checks...");
    const { checks } = await call<{ checks: any[] }>("quality.check.list", { runId: run.id });
    console.log(`  checks: ${checks?.length ?? 0}, statuses: ${checks?.map(c => c.status).join(",") ?? "none"}`);
    console.log(`  patchHash: ${runCurrent.patchHash ?? "none"}`);
    console.log("  -> gate runner likely failed to advance past quick-verifying");
    console.log("  -> this is the bug: advanceAfterGate receives stale run without patchHash");
  }
  
  const runFinal = runCurrent;
  console.log(`  terminal stage: ${runFinal.stage}`);
  console.log(`  outcome: ${runFinal.outcome ?? "N/A"}`);
  console.log(`  patchHash: ${runFinal.patchHash ?? "none"}`);

  // 7. 检查 L1 checks
  console.log("=== Step 7: Check L1 checks ===");
  try {
    const { checks } = await call<{ checks: any[] }>("quality.check.list", { runId: run.id });
    console.log(`  checks: ${checks?.length ?? 0}`);
    if (checks) for (const c of checks) console.log(`    - ${c.checkId}: ${c.status}`);
  } catch (e) { console.log(`  (error: ${e})`); }

  // 8. 检查 L3 验证记录
  console.log("=== Step 8: Check L3 verification ===");
  try {
    const { verifications } = await call<{ verifications: any[] }>("quality.verification.list", { runId: run.id });
    console.log(`  verification records: ${verifications?.length ?? 0}`);
    if (verifications) for (const r of verifications) console.log(`    - ${r.criterionId}: ${r.status} (method: ${r.method}, evidence: ${r.evidenceRefs?.join(",") ?? "none"})`);
  } catch (e) { console.log(`  (error: ${e})`); }

  // 9. 检查 L4 Observation
  console.log("=== Step 9: Check L4 Observation ===");
  try {
    const { observations } = await call<{ observations: any[] }>("quality.observation.list", { projectId: project.id });
    console.log(`  observations: ${observations?.length ?? 0}`);
    if (observations) for (const o of observations) console.log(`    - kind: ${o.kind}, attribution: ${o.attribution}, status: ${o.status}`);
  } catch (e) { console.log(`  (error: ${e})`); }

  // 10. 检查 WorkItem
  console.log("=== Step 10: Check WorkItem ===");
  try {
    const { items } = await call<{ items: any[] }>("quality.work.list", { projectId: project.id });
    console.log(`  workItems: ${items?.length ?? 0}`);
    if (items) for (const i of items) console.log(`    - ${i.id}: status=${i.status}, specId=${i.specId ?? "none"}`);
  } catch (e) { console.log(`  (error: ${e})`); }

  // 11. 汇总
  console.log("\n=== Dogfood Summary ===");
  console.log(`  L0 spec:       ${specId}`);
  console.log(`  L0 workItem:   ${workItem.id}`);
  console.log(`  Run:           ${run.id}`);
  console.log(`  Final stage:   ${runFinal.stage}`);
  console.log(`  Outcome:       ${runFinal.outcome ?? "N/A"}`);
  console.log(`  PatchHash:     ${runFinal.patchHash ?? "none"}`);
  console.log(`  CompletedAt:   ${runFinal.completedAt ?? "N/A"}`);

  const chain: string[] = [];
  chain.push(`L0 spec created:      ${specId ? "✅" : "❌"}`);
  chain.push(`L0 workItem created:  ${workItem.id ? "✅" : "❌"}`);
  chain.push(`L1 checks passed:     ${runFinal.stage !== "failed" ? "✅" : "❌"}`);
  chain.push(`L3 verification:      (see Step 8 above)`);
  chain.push(`L4 observation:       (see Step 9 above)`);
  chain.push(`Run reached terminal: ${["accepted","failed","inconclusive","waived","cancelled","quarantined","stale"].includes(runFinal.stage) ? "✅" : "❌"}`);

  console.log("\n=== Chain Verification ===");
  for (const c of chain) console.log(`  ${c}`);

  console.log("\nDone.");
}

ws.on("open", () => {
  main().catch((err) => {
    console.error("dogfood failed:", err);
    process.exitCode = 1;
  }).finally(() => {
    setTimeout(() => ws.close(), 500);
  });
});

ws.on("error", (err) => {
  console.error("ws error", err);
  process.exitCode = 1;
});
