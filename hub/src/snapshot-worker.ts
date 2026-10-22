import { parentPort } from "node:worker_threads";
import { snapshotWorkspace, workspaceFingerprint } from "./conductor.js";

interface SnapshotJob {
  id: number;
  cwd: string;
}

parentPort?.on("message", (job: SnapshotJob) => {
  let hash: string | undefined;
  try {
    hash = snapshotWorkspace(job.cwd);
  } catch {
    hash = undefined;
  }
  let fp: Map<string, string> | undefined;
  try {
    fp = workspaceFingerprint(job.cwd);
  } catch {
    fp = undefined;
  }
  parentPort?.postMessage({ id: job.id, hash, fp });
});
