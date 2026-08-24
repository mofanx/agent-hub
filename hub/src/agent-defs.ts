export type AgentDef = {
  bin: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

function getDeepseekDef(): AgentDef | undefined {
  if (process.env.DSH_ACP_BIN) {
    const def: AgentDef = { bin: process.env.DSH_ACP_BIN, args: process.env.DSH_ACP_ARGS?.split(" ") ?? [] };
    if (process.env.DSH_ROOT) def.cwd = process.env.DSH_ROOT;
    return def;
  }
  if (process.env.DSH_ROOT) {
    return {
      bin: "node",
      args: [
        `${process.env.DSH_ROOT}/packages/examples/acp-demo/lib/bin.js`,
        "--config",
        `${process.env.DSH_ROOT}/examples/acp-agent/cordis.yml`,
      ],
      cwd: process.env.DSH_ROOT,
    };
  }
  return undefined;
}

export const AGENT_DEFS: Record<string, AgentDef> = {
  devin: { bin: process.env.DEVIN_BIN ?? "devin", args: ["acp"] },
  claude: {
    bin: process.env.CLAUDE_ACP_BIN ?? "npx",
    args: process.env.CLAUDE_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@agentclientprotocol/claude-agent-acp",
    ],
  },
  codex: {
    bin: process.env.CODEX_ACP_BIN ?? "npx",
    args: process.env.CODEX_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@agentclientprotocol/codex-acp",
    ],
  },
  opencode: {
    bin: process.env.OPENCODE_BIN ?? "opencode",
    args: process.env.OPENCODE_ARGS?.split(" ") ?? ["acp"],
  },
  ...(process.env.DSH_ACP_BIN || process.env.DSH_ROOT ? { deepseek: getDeepseekDef()! } : {}),
};

export function getAgentDef(agent: string): AgentDef | undefined {
  return AGENT_DEFS[agent];
}
