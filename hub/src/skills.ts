import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type SkillInfo = {
  name: string;
  description: string;
  location: string;
  scope: "project" | "user";
};

const MAX_DEPTH = 4;

/** 解析 SKILL.md frontmatter，提取 name + description */
function parseSkillMd(filePath: string): { name: string; description: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || !m[1]) return null;
  const fm = m[1];

  // name: 简单单行
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  let name = nameMatch?.[1] ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : "";

  // description: 支持单行、引号、block scalar (> 或 |)
  let description = "";
  const blockMatch = fm.match(/^description:\s*([>|])(-?\+?)\s*\r?\n([\s\S]*?)(?=\r?\n\S|\r?\n?$)/m);
  if (blockMatch?.[3]) {
    const raw = blockMatch[3];
    if (blockMatch[1] === ">") {
      description = raw.replace(/\r?\n\s*/g, " ").trim();
    } else {
      description = raw.replace(/\r?\n$/, "").trim();
    }
  } else {
    const simpleDesc = fm.match(/^description:\s*(.+)$/m);
    if (simpleDesc?.[1]) {
      description = simpleDesc[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  if (!name) {
    name = path.basename(path.dirname(filePath));
  }
  if (!description) return null;
  return { name, description };
}

/** 递归扫描目录下的 skill */
function scanDir(root: string, scope: "project" | "user", results: SkillInfo[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const skillMd = path.join(root, entry.name, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      const parsed = parseSkillMd(skillMd);
      if (parsed) {
        results.push({
          name: parsed.name,
          description: parsed.description,
          location: skillMd,
          scope,
        });
      }
      continue;
    }
    const subDir = path.join(root, entry.name);
    const depth = subDir.split(path.sep).length - root.split(path.sep).length;
    if (depth < MAX_DEPTH) scanDir(subDir, scope, results);
  }
}

/**
 * 发现可用 skill。
 * cwd 是当前会话的工作目录，用于扫描项目级 skill。
 * agentType 用于确定客户端特有路径（devin/claude/codex/opencode）。
 */
export function discoverSkills(cwd?: string, agentType?: string): SkillInfo[] {
  const home = os.homedir();
  const results: SkillInfo[] = [];

  const projectDirs: string[] = [];
  const userDirs: string[] = [];

  // 跨客户端通用路径
  if (cwd) projectDirs.push(path.join(cwd, ".agents", "skills"));
  userDirs.push(path.join(home, ".agents", "skills"));

  // 客户端特有路径
  const clientMap: Record<string, [string[], string[]]> = {
    devin: [
      cwd ? [path.join(cwd, ".devin", "skills"), path.join(cwd, ".claude", "skills")] : [],
      [path.join(home, ".config", "devin", "skills"), path.join(home, ".claude", "skills")],
    ],
    claude: [
      cwd ? [path.join(cwd, ".claude", "skills")] : [],
      [path.join(home, ".claude", "skills")],
    ],
    codex: [
      cwd ? [path.join(cwd, ".codex", "skills"), path.join(cwd, ".agents", "skills"), path.join(cwd, ".claude", "skills")] : [],
      [path.join(home, ".codex", "skills"), path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills")],
    ],
    opencode: [
      cwd ? [path.join(cwd, ".opencode", "skills"), path.join(cwd, ".claude", "skills")] : [],
      [path.join(home, ".config", "opencode", "skills"), path.join(home, ".claude", "skills")],
    ],
    openclaw: [
      cwd ? [path.join(cwd, "skills"), path.join(cwd, ".agents", "skills")] : [],
      [path.join(home, ".openclaw", "skills"), path.join(home, ".agents", "skills")],
    ],
  };

  if (agentType && clientMap[agentType]) {
    projectDirs.push(...clientMap[agentType][0]);
    userDirs.push(...clientMap[agentType][1]);
  } else {
    // 未知 agent 类型：扫描所有客户端路径，去重时自动合并
    for (const [, [p, u]] of Object.entries(clientMap)) {
      projectDirs.push(...p);
      userDirs.push(...u);
    }
  }

  // 扫描项目级
  for (const dir of projectDirs) scanDir(dir, "project", results);
  // 扫描用户级
  for (const dir of userDirs) scanDir(dir, "user", results);

  // 去重：同名 skill 项目级覆盖用户级
  const seen = new Map<string, SkillInfo>();
  for (const s of results) {
    const existing = seen.get(s.name);
    if (!existing || (s.scope === "project" && existing.scope === "user")) {
      seen.set(s.name, s);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
