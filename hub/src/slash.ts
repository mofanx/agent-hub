import type { Room } from "./room.js";
import type { ModelBackend } from "./model.js";

export type SlashCmd = { command: string; mentions: string[]; args: string[] };

export function parseSlash(text: string): SlashCmd | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  if (!head) return null;
  const mentions = rest
    .filter((p) => p.startsWith("@"))
    .map((p) => p.slice(1));
  const args = rest.filter((p) => !p.startsWith("@"));
  return { command: head.toLowerCase(), mentions, args };
}

export const SESSION_MODES = new Set(["accept-edits", "ask", "plan", "bypass", "smart", "autonomous"]);

/** dispatch 白名单：这些 /命令 由 hub 侧 handler 处理；其余 /x 透传给 agent（兼容 agent skill） */
export const HUB_SLASH_COMMANDS = new Set(["stop", "mode", "bypass"]);

/** /mode、/bypass 处理所需的外部依赖，由 index.ts 注入（测试可替身） */
export type ModeSlashDeps = {
  applySessionMode(sessionId: string, mode: string): Promise<void>;
  sessionBackend(sessionId: string): ModelBackend | undefined;
  /** 成员后端类型（meta.agent/connection.agent 经 backendTypeOf 解析），供 backend 定向过滤 */
  memberBackendType(sessionId: string): ModelBackend;
  /** 成员展示名（name·type·origin），mention 匹配兼容全显示名写法 */
  memberDisplayName(member: { sessionId: string; name: string }): string;
  findByBackend(backend: ModelBackend): unknown[];
  setBackendConfig(backend: ModelBackend, configId: string, value: string): void;
};

const MODE_USAGE = `usage: /mode <${[...SESSION_MODES].join("|")}|bypass [off]> [@成员|backend] [--global|-g]`;

/** /mode 取 args[0] 为 mode 词；/bypass 维持既有映射 off→accept-edits、其他→bypass */
function resolveModeSlash(
  slash: SlashCmd,
  deps: ModeSlashDeps,
): { mode: string; namedBackend?: ModelBackend | undefined; globalFlag: boolean } {
  const mode =
    slash.command === "mode"
      ? slash.args[0] ?? ""
      : slash.args[0] === "off"
        ? "accept-edits"
        : "bypass";
  if (!mode) throw new Error(MODE_USAGE);
  const namedBackend = slash.args.find(
    (a) => a !== mode && deps.findByBackend(a as ModelBackend).length > 0,
  ) as ModelBackend | undefined;
  const globalFlag = slash.args.includes("--global") || slash.args.includes("-g");
  return { mode, namedBackend, globalFlag };
}

export async function handleSessionModeSlash(
  sessionId: string,
  slash: SlashCmd,
  deps: ModeSlashDeps,
): Promise<unknown> {
  const { mode, namedBackend, globalFlag } = resolveModeSlash(slash, deps);
  await deps.applySessionMode(sessionId, mode);
  const backend = namedBackend ?? (globalFlag ? deps.sessionBackend(sessionId) : undefined);
  if (backend) {
    deps.setBackendConfig(backend, "mode", mode);
    return { sessionId, mode, backendDefault: true };
  }
  return { sessionId, mode, backendDefault: false };
}

export async function handleRoomModeSlash(
  room: Room,
  slash: SlashCmd,
  deps: ModeSlashDeps,
): Promise<unknown> {
  const { mode, namedBackend, globalFlag } = resolveModeSlash(slash, deps);
  // 未识别参数不得静默忽略：args[0] 为 mode 词/开关词，其后仅允许 backend 名与 --global/-g
  for (const [i, a] of slash.args.entries()) {
    if (i === 0 || a === namedBackend || a === "--global" || a === "-g") continue;
    throw new Error(`unrecognized argument: ${a}; ${MODE_USAGE}`);
  }

  let targets = room.members;
  if (slash.mentions.length > 0) {
    targets = targets.filter(
      (m) =>
        slash.mentions.includes(m.name) ||
        slash.mentions.includes(deps.memberDisplayName(m)),
    );
  }
  if (namedBackend) {
    targets = targets.filter(
      (m) => deps.memberBackendType(m.sessionId) === namedBackend,
    );
  }

  const applied: string[] = [];
  const failed: string[] = [];
  for (const m of targets) {
    try {
      await deps.applySessionMode(m.sessionId, mode);
      applied.push(m.sessionId);
    } catch {
      failed.push(m.sessionId);
    }
  }

  // 具名 backend：写该后端默认；--global 无具名时按各目标会话自身 backend 分别写默认
  const backends = namedBackend
    ? [namedBackend]
    : globalFlag
      ? [...new Set(targets.map((m) => deps.memberBackendType(m.sessionId)))]
      : [];
  for (const b of backends) deps.setBackendConfig(b, "mode", mode);

  return { mode, applied, failed, backendDefault: backends.length > 0 };
}
