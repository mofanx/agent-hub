export type AgentDef = {
  bin: string;
  args: string[];
};

export const AGENT_DEFS: Record<string, AgentDef> = {
  devin: { bin: process.env.DEVIN_BIN ?? "devin", args: ["acp"] },
  claude: {
    bin: process.env.CLAUDE_ACP_BIN ?? "npx",
    args: process.env.CLAUDE_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@zed-industries/claude-code-acp",
    ],
  },
  codex: {
    bin: process.env.CODEX_ACP_BIN ?? "npx",
    args: process.env.CODEX_ACP_ARGS?.split(" ") ?? [
      "-y",
      "@zed-industries/codex-acp",
    ],
  },
  opencode: {
    bin: process.env.OPENCODE_BIN ?? "opencode",
    args: process.env.OPENCODE_ARGS?.split(" ") ?? ["acp"],
  },
};

export function getAgentDef(agent: string): AgentDef | undefined {
  return AGENT_DEFS[agent];
}
