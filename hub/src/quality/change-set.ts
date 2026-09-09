import spawn from "cross-spawn";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeSet, ChangeSetFile, ProjectScope, RiskRule } from "./types.js";

export type Baseline = {
  revision: string;
  dirtyHash: string | null;
  isGit: boolean;
};

export type ChangeSetCollectorOptions = {
  protectedPaths?: string[];
  riskRules?: RiskRule[];
};

type GitResult = { stdout: string; status: number };

function gitSync(gitRoot: string, args: string[]): GitResult {
  const res = spawn.sync("git", args, { cwd: gitRoot, encoding: "utf-8" });
  return { stdout: (res.stdout as string).trim(), status: res.status ?? -1 };
}

function git(gitRoot: string, args: string[]): string {
  const { stdout, status } = gitSync(gitRoot, args);
  if (status !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${status})`);
  return stdout;
}

export function isGitRepo(root: string): boolean {
  const { stdout, status } = gitSync(root, ["rev-parse", "--is-inside-work-tree"]);
  return status === 0 && stdout === "true";
}

export function getHeadRevision(gitRoot: string): string {
  return git(gitRoot, ["rev-parse", "HEAD"]);
}

export function getDirtyHash(gitRoot: string): string | null {
  const diff = git(gitRoot, ["diff", "--no-ext-diff"]);
  const diffCached = git(gitRoot, ["diff", "--cached", "--no-ext-diff"]);
  const untracked = git(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const untrackedContent = hashUntrackedContent(gitRoot, untracked);
  const combined = diff + diffCached + untracked + untrackedContent;
  if (!combined.trim()) return null;
  return crypto.createHash("sha256").update(combined).digest("hex");
}

export function collectBaseline(project: ProjectScope): Baseline {
  const root = project.gitRoot ?? project.root;
  if (!project.capabilities.git || !isGitRepo(root)) {
    return { revision: "", dirtyHash: null, isGit: false };
  }
  return {
    revision: getHeadRevision(root),
    dirtyHash: getDirtyHash(root),
    isGit: true,
  };
}

function parseNumstat(numstat: string): ChangeSetFile[] {
  const files: ChangeSetFile[] = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0]!;
    const deletions = parts[1]!;
    const filePath = parts.slice(2).join("\t")!;
    if (additions === "-" || deletions === "-") {
      files.push({ path: filePath, status: "add" });
    } else {
      files.push({
        path: filePath,
        status: "modify",
        additions: parseInt(additions, 10) || 0,
        deletions: parseInt(deletions, 10) || 0,
      });
    }
  }
  return files;
}

function detectRenames(gitRoot: string): ChangeSetFile[] {
  const status = git(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const renamed: ChangeSetFile[] = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith("R") && !line.startsWith("C")) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow < 0) continue;
    const newPath = rest.slice(arrow + 4).replace(/^"|"$/g, "");
    renamed.push({ path: newPath, status: "rename" });
  }
  return renamed;
}

function detectDeletes(gitRoot: string): ChangeSetFile[] {
  const status = git(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const deleted: ChangeSetFile[] = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith(" D") && !line.startsWith("D ")) continue;
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    deleted.push({ path: filePath, status: "delete" });
  }
  return deleted;
}

function detectUntracked(gitRoot: string): ChangeSetFile[] {
  const status = git(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const untracked: ChangeSetFile[] = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    untracked.push({ path: filePath, status: "add" });
  }
  return untracked;
}

function mergeFiles(...lists: ChangeSetFile[][]): ChangeSetFile[] {
  const map = new Map<string, ChangeSetFile>();
  for (const list of lists) {
    for (const f of list) {
      const existing = map.get(f.path);
      if (!existing || (existing.status === "modify" && f.status !== "modify")) {
        map.set(f.path, f);
      }
    }
  }
  return [...map.values()];
}

function matchPath(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return regex.test(filePath);
  }
  return filePath === pattern || filePath.startsWith(pattern.endsWith("/") ? pattern : pattern + "/");
}

function classifyRisk(files: ChangeSetFile[], options: ChangeSetCollectorOptions): string[] {
  const reasons: string[] = [];
  for (const f of files) {
    for (const pp of options.protectedPaths ?? []) {
      if (matchPath(f.path, pp)) {
        reasons.push(`protected path: ${f.path} matches ${pp}`);
        break;
      }
    }
    for (const rule of options.riskRules ?? []) {
      if (matchPath(f.path, rule.pattern)) {
        reasons.push(`risk rule (${rule.risk}): ${f.path} — ${rule.reason}`);
        break;
      }
    }
  }
  return reasons;
}

function hashDiff(diff: string): string {
  return crypto.createHash("sha256").update(diff).digest("hex");
}

/** 计算 untracked 文件内容的 hash（用于区分同路径不同内容的新文件） */
function hashUntrackedContent(gitRoot: string, status: string): string {
  const parts: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    const full = path.join(gitRoot, filePath);
    try {
      const content = fs.readFileSync(full, "utf-8");
      parts.push(`${filePath}:${content.length}:${content.slice(0, 1024)}`);
    } catch {
      // binary or unreadable, use stat
      try {
        const stat = fs.statSync(full);
        parts.push(`${filePath}:binary:${stat.size}`);
      } catch {
        parts.push(`${filePath}:unreadable`);
      }
    }
  }
  return parts.join("\n");
}

/** 计算文件的 sha256 hash（用于 untracked/binary 文件内容指纹）。 */
export function hashFileContent(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    try {
      const buf = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      return "unreadable";
    }
  }
}

/** 收集 untracked 文件的完整内容 hash 列表（含 binary）。 */
export function collectUntrackedHashes(gitRoot: string): { path: string; hash: string; size: number }[] {
  const status = git(gitRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const result: { path: string; hash: string; size: number }[] = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    const full = path.join(gitRoot, filePath);
    try {
      const stat = fs.statSync(full);
      result.push({ path: filePath, hash: hashFileContent(full), size: stat.size });
    } catch {
      result.push({ path: filePath, hash: "unreadable", size: 0 });
    }
  }
  return result;
}

export function collectChangeSet(
  runId: string,
  project: ProjectScope,
  baseline: Baseline,
  options: ChangeSetCollectorOptions = {},
  artifactDir: string,
  worktreePath?: string,
): ChangeSet {
  const root = worktreePath ?? project.gitRoot ?? project.root;

  if (!baseline.isGit) {
    return {
      runId,
      baseRevision: undefined,
      patchArtifact: "",
      patchHash: "",
      files: [],
      preexistingDirty: true,
      contaminated: false,
      riskReasons: [],
    };
  }

  const diff = git(root, ["diff", "--binary", "--no-ext-diff"]);
  const diffCached = git(root, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  const untrackedContent = hashUntrackedContent(root, status);
  const fullDiff = diff + diffCached + status + untrackedContent;
  const patchHash = hashDiff(fullDiff);

  const numstat = git(root, ["diff", "--numstat", "HEAD"]);
  const numstatCached = git(root, ["diff", "--cached", "--numstat", "HEAD"]);
  const modifiedFiles = parseNumstat(numstat + "\n" + numstatCached);
  const renamedFiles = detectRenames(root);
  const deletedFiles = detectDeletes(root);
  const untrackedFiles = detectUntracked(root);
  const files = mergeFiles(modifiedFiles, renamedFiles, deletedFiles, untrackedFiles);

  const riskReasons = classifyRisk(files, options);
  const patchArtifact = path.join(artifactDir, runId, "patch.diff");

  // 实际写入 patch artifact 文件（含 tracked diff + untracked 文件内容）
  fs.mkdirSync(path.dirname(patchArtifact), { recursive: true });
  let patchContent = diff + diffCached;
  // 追加 untracked 文件内容作为 patch 的一部分
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const filePath = line.slice(3).replace(/^"|"$/g, "");
    const full = path.join(root, filePath);
    try {
      const content = fs.readFileSync(full, "utf-8");
      patchContent += `\n--- /dev/null\n+++ b/${filePath}\n${content.split("\n").map((l) => "+" + l).join("\n")}\n`;
    } catch {
      // binary file, 记录为 binary marker
      try {
        const stat = fs.statSync(full);
        patchContent += `\n--- /dev/null\n+++ b/${filePath}\nBinary file: ${stat.size} bytes\n`;
      } catch {
        patchContent += `\n--- /dev/null\n+++ b/${filePath}\nUnreadable\n`;
      }
    }
  }
  fs.writeFileSync(patchArtifact, patchContent, "utf-8");

  return {
    runId,
    baseRevision: baseline.revision,
    patchArtifact,
    patchHash,
    files,
    preexistingDirty: baseline.dirtyHash !== null,
    contaminated: false,
    riskReasons,
  };
}

/**
 * 检测运行外修改（contamination）：
 * 比较当前 dirty hash 与上次记录时的 dirty hash。
 * 如果 baseline 本来就有未归属修改（preexistingDirty），且 dirty hash 在 patchHash 不变的情况下变了，
 * 说明有运行外写入。
 * 如果 baseline 干净，则所有变更都归因于当前 run，不算污染。
 */
export function detectContamination(
  project: ProjectScope,
  baseline: Baseline,
  currentPatchHash: string,
  lastPatchHash: string,
): boolean {
  if (!baseline.isGit) return false;
  if (baseline.dirtyHash === null) return false;
  const root = project.gitRoot ?? project.root;
  const currentDirty = getDirtyHash(root);
  if (currentDirty === null) return false;
  if (baseline.dirtyHash !== currentDirty && currentPatchHash === lastPatchHash) return true;
  return false;
}

// ── Baseline / 污染检测增强 API（v3.0 §8.5）───────────────────────────

/** Baseline 快照：记录 run 开始时的仓库状态，用于事后对比。 */
export type BaselineSnapshot = {
  revision: string;
  dirtyHash: string | null;
  untrackedFiles: { path: string; hash: string; size: number }[];
  timestamp: number;
};

/** 采集完整 baseline 快照（含 untracked 文件 hash 列表）。 */
export function snapshotBaseline(project: ProjectScope): BaselineSnapshot {
  const root = project.gitRoot ?? project.root;
  if (!project.capabilities.git || !isGitRepo(root)) {
    return { revision: "", dirtyHash: null, untrackedFiles: [], timestamp: Date.now() };
  }
  return {
    revision: getHeadRevision(root),
    dirtyHash: getDirtyHash(root),
    untrackedFiles: collectUntrackedHashes(root),
    timestamp: Date.now(),
  };
}

/** 比较两个 baseline 快照，返回差异描述列表。 */
export function diffBaselines(a: BaselineSnapshot, b: BaselineSnapshot): string[] {
  const diffs: string[] = [];
  if (a.revision !== b.revision) diffs.push(`revision: ${a.revision} → ${b.revision}`);
  if (a.dirtyHash !== b.dirtyHash) diffs.push(`dirtyHash: ${a.dirtyHash ?? "null"} → ${b.dirtyHash ?? "null"}`);
  const aPaths = new Set(a.untrackedFiles.map((f) => f.path));
  const bPaths = new Set(b.untrackedFiles.map((f) => f.path));
  for (const f of a.untrackedFiles) {
    if (!bPaths.has(f.path)) diffs.push(`untracked removed: ${f.path}`);
  }
  for (const f of b.untrackedFiles) {
    if (!aPaths.has(f.path)) diffs.push(`untracked added: ${f.path}`);
  }
  for (const f of a.untrackedFiles) {
    const bFile = b.untrackedFiles.find((g) => g.path === f.path);
    if (bFile && bFile.hash !== f.hash) diffs.push(`untracked modified: ${f.path}`);
  }
  return diffs;
}

/** 检测 run 执行期间是否有外部写入（基于 baseline 快照对比）。 */
export function detectContaminationFromSnapshot(
  project: ProjectScope,
  baseline: BaselineSnapshot,
): { contaminated: boolean; diffs: string[] } {
  if (!baseline.dirtyHash) return { contaminated: false, diffs: [] };
  const current = snapshotBaseline(project);
  const diffs = diffBaselines(baseline, current);
  return { contaminated: diffs.length > 0, diffs };
}
