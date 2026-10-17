import spawn from "cross-spawn";
import type { ChildProcess, StdioOptions } from "node:child_process";

export type AgentDef = {
  bin: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

const DSH_NPM_PACKAGE = "@deepseek-ai/dsh@0.2.0-rc.2";

/**
 * 解析 env 参数串：以 `[` 开头按 JSON 数组解析（推荐，无引号歧义）；
 * 否则按 shell 风格拆分并剥离单双引号（`--x="a b"` → `--x=a b`）。
 */
export function parseArgs(raw: string | undefined, fallback: string[]): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.every((s): s is string => typeof s === "string")) {
        return arr;
      }
    } catch (e) {
      console.warn(`[agent-defs] *_ACP_ARGS 非法 JSON，回退 shell 拆分: ${e instanceof Error ? e.message : e}`);
    }
  }
  const args: string[] = [];
  for (const m of trimmed.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) {
    args.push(m[0].replace(/"([^"]*)"|'([^']*)'/g, (_q, d: string, s: string) => d ?? s));
  }
  return args;
}

/**
 * deepseek-harness 接入，三种模式按优先级：
 * 1. DSH_ACP_BIN：显式指定 ACP 入口（DSH_ROOT 可同时作为 cwd）
 * 2. DSH_ROOT：源码开发模式，tsx 直跑仓库内 apps/cli，免构建
 * 3. 默认：npx 官方 npm 包的 ACP profile（固定版本，避免漂移）
 */
function getDeepseekDef(env: NodeJS.ProcessEnv): AgentDef {
  if (env.DSH_ACP_BIN) {
    const def: AgentDef = {
      bin: env.DSH_ACP_BIN,
      args: parseArgs(env.DSH_ACP_ARGS, []),
    };
    if (env.DSH_ROOT) def.cwd = env.DSH_ROOT;
    return def;
  }
  if (env.DSH_ROOT) {
    return {
      bin: "node",
      args: parseArgs(env.DSH_ACP_ARGS, [
        "--import",
        "tsx/esm",
        "apps/cli/src/bin.ts",
        "--profile",
        "acp",
      ]),
      cwd: env.DSH_ROOT,
    };
  }
  return {
    bin: "npx",
    args: parseArgs(env.DSH_ACP_ARGS, ["-y", DSH_NPM_PACKAGE, "--profile", "acp"]),
  };
}

export function buildAgentDefs(env: NodeJS.ProcessEnv): Record<string, AgentDef> {
  return {
    devin: {
      bin: env.DEVIN_BIN ?? "devin",
      args: parseArgs(env.DEVIN_ACP_ARGS, ["acp"]),
    },
    claude: {
      bin: env.CLAUDE_ACP_BIN ?? "npx",
      args: parseArgs(env.CLAUDE_ACP_ARGS, [
        "-y",
        "@agentclientprotocol/claude-agent-acp",
      ]),
    },
    codex: {
      bin: env.CODEX_ACP_BIN ?? "npx",
      args: parseArgs(env.CODEX_ACP_ARGS, [
        "-y",
        "@agentclientprotocol/codex-acp",
      ]),
    },
    opencode: {
      bin: env.OPENCODE_BIN ?? "opencode",
      args: parseArgs(env.OPENCODE_ARGS, ["acp"]),
    },
    openclaw: {
      bin: env.OPENCLAW_BIN ?? "openclaw",
      args: parseArgs(env.OPENCLAW_ARGS, ["acp"]),
    },
    deepseek: getDeepseekDef(env),
  };
}

export const AGENT_DEFS: Record<string, AgentDef> = buildAgentDefs(process.env);

export function getAgentDef(agent: string): AgentDef | undefined {
  return AGENT_DEFS[agent];
}

/**
 * 统一 spawn：转发 def.cwd/def.env 并继承进程 env；
 * cross-spawn 兼容 Windows 下 npx/npm 等 .cmd 入口。
 */
export function spawnAgentProcess(
  def: AgentDef,
  stdio: StdioOptions = ["pipe", "pipe", "pipe"],
): ChildProcess {
  const env = { ...process.env, ...def.env };
  if (!def.env?.ACP_BACKEND) delete env.ACP_BACKEND;
  return spawn(def.bin, def.args, {
    stdio,
    cwd: def.cwd,
    env,
    windowsHide: true,
  });
}
