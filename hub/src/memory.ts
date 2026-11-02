/** 常驻 Router 长记忆：每房持久化的蒸馏条目（事实/偏好/决策），
 *  conductor 总结回合时写入，buildPrompt 时按容量+TTL 注入。
 *  事实源复用黑板管线——本层只做"蒸馏后的长期条目"持久化与注入，
 *  客户端可见部分仍以黑板条目承载（type="memory"），不另造事件源。 */

export type MemoryKind = "fact" | "preference" | "decision";

export interface MemoryEntry {
  id: number;
  roomId: string;
  kind: MemoryKind;
  text: string;
  source: string;
  at: number;
  expiresAt: number | null;
}

export const MEMORY_LIMIT = 50;
export const MEMORY_TTL_MS = 30 * 24 * 3600_000;
export const MEMORY_TEXT_LIMIT = 300;
export const MEMORY_PROMPT_LIMIT = 10;

/** 无信息量的行开头：markdown 标题/围栏/JSON/表格行，蒸馏时跳过（列表行可能含有效内容，不跳） */
const NOISE_PREFIX = /^([#`]|\{|\[|\|)/;

/** 从 LLM 输出中取第一条"人话"行做蒸馏文本（跳过标题/代码围栏/JSON/表格等噪声行），超长截断 */
export function distillMemoryText(text: string, limit = MEMORY_TEXT_LIMIT): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !NOISE_PREFIX.test(l)) ?? text.trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
