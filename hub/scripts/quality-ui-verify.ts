import WebSocket from "ws";

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
      } catch {
        // ignore
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStage(runId: string, stage: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { run } = await call<{ run: { stage: string } }>("quality.run.get", { id: runId });
    console.log(`run ${runId} stage: ${run.stage}`);
    if (run.stage === stage) return;
    await sleep(500);
  }
  throw new Error(`run ${runId} did not reach ${stage} in ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  // 1. 注册一个无 quality.json 的临时项目（使用 defaultObservePolicy: checks=[], autonomy=observe）
  const { project } = await call<{ project: { id: string; root: string } }>(
    "quality.project.register",
    {
      connectionId: "manual",
      root: "/tmp/quality-ui-test",
      displayName: "quality-ui-test",
      localExec: true,
    },
  );
  console.log("registered project:", project.id, project.root);

  // 2. 创建 interactive run 并推进到 quick-verifying
  const { run } = await call<{ run: { id: string; stage: string } }>(
    "quality.run.start",
    {
      projectId: project.id,
      trigger: "interactive",
      risk: "low",
      policyVersion: "1",
      budget: { maxFixRounds: 2, timeoutMs: 60000 },
    },
  );
  console.log("started run:", run.id, run.stage);

  for (const to of ["preflight", "implementing", "collecting", "quick-verifying"] as const) {
    await call("quality.run.advance", { id: run.id, to });
  }

  await waitForStage(run.id, "awaiting-approval");
  console.log("run reached awaiting-approval:", run.id);

  // 3. 测试 approve
  const { run: approved } = await call<{ run: { id: string; stage: string } }>(
    "quality.run.approve",
    { id: run.id },
  );
  console.log("after approve:", approved.id, approved.stage);
  if (approved.stage !== "accepted") throw new Error("approve failed");

  // 4. 测试 reject：retry 生成新 run，推进到 awaiting-approval 后 reject
  const { run: retryRun } = await call<{ run: { id: string; stage: string } }>(
    "quality.run.retry",
    { id: run.id },
  );
  console.log("retry created run:", retryRun.id, retryRun.stage);
  for (const to of ["preflight", "implementing", "collecting", "quick-verifying"] as const) {
    await call("quality.run.advance", { id: retryRun.id, to });
  }
  await waitForStage(retryRun.id, "awaiting-approval");
  const { run: rejected } = await call<{ run: { id: string; stage: string } }>(
    "quality.run.reject",
    { id: retryRun.id },
  );
  console.log("after reject:", rejected.id, rejected.stage);
  if (rejected.stage !== "failed") throw new Error("reject failed");

  console.log("OK: quality UI backend path verified");
}

ws.on("open", () => {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  }).finally(() => {
    ws.close();
  });
});

ws.on("error", (err) => {
  console.error("ws error", err);
  process.exitCode = 1;
});
