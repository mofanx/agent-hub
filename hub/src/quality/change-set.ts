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
  return filePath === pattern || filePath.startsWith(pattern + "/");
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
        parts.push(`${filePath}:${stat.size}`);
      } catch {
        parts.push(`${filePath}:unreadable`);
      }
    }
  }
  return parts.join("\n");
}

export function collectChangeSet(
  runId: string,
  project: ProjectScope,
  baseline: Baseline,
  options: ChangeSetCollectorOptions = {},
  artifactDir: string,
): ChangeSet {
  const root = project.gitRoot ?? project.root;

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
