import spawn from "cross-spawn";
import type { ChildProcess, StdioOptions } from "node:child_process";

export type AgentDef = {
  bin: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

/**
 * 后端能力契约——渲染契约：仅约束客户端 UI 可见性与空态文案；
 * hub 行为判定（steer 排队、resume 回退、fork 降级等）永远走实例实测值，不读此处。
 * 最终一致字段：随 session.list 拉取下发，无推送通道，重连后变化以下次 pull 为准。
 * undefined=未知（宽容回退旧行为），false=实测不支持（诚实空态），true=实测支持。
 */
export type AgentCaps = {
  resume?: boolean;
  configOptions?: boolean;
  toolCall?: boolean;
  fork?: boolean;
  close?: boolean;
  steer?: boolean;
  midTurn?: boolean;
  nativeGoal?: boolean;
  quota?: boolean;
  auth?: "none" | "apiKeyEnv" | "agentAuth";
};

/**
 * 静态种子：离线/未协商期兜底，只填有实测证据的格子——
 * deepseek 的 false 组源自 README 能力契约与初始化实测；devin 的 quota/auth 源自
 * quota.ts 与 localDevinAuth 既有事实。其余类型留空（在线时 probe 值覆盖）。
 * 注意：此表是唯一会过期的部分——新后端到货或上游能力变化时只更新本表。
 */
export const STATIC_CAPS: Record<string, AgentCaps> = {
  devin: { resume: true, quota: true, auth: "agentAuth" },
  deepseek: {
    resume: false,
    configOptions: false,
    toolCall: false,
    quota: false,
    auth: "apiKeyEnv",
  },
};

export function capsForType(type: string): AgentCaps | undefined {
  return STATIC_CAPS[type];
}

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
