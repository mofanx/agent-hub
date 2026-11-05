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

/** 归一化：小写+剥标点/空白/截断省略号，把"同一事实的措辞变体"收敛到可比对形态 */
const normMemory = (s: string): string =>
  s.toLowerCase().replace(/[\s，。、：:；;,.!?！？·…\-—_（）()\[\]{}"'"'<>《》/\\]+/g, "");

/** 近重复判定：归一化后全等 / 互为前缀（截断或扩写变体）/ 长公共前缀覆盖 ≥80%。
 *  短文本（归一化 <20 字）只认全等与前缀，避免"修复A"/"修复B"级误合并 */
export function isMemoryNearDup(a: string, b: string): boolean {
  const na = normMemory(a);
  const nb = normMemory(b);
  if (!na || !nb) return false;
  if (na === nb || na.startsWith(nb) || nb.startsWith(na)) return true;
  const shorter = Math.min(na.length, nb.length);
  if (shorter < 20) return false;
  let i = 0;
  while (i < shorter && na[i] === nb[i]) i++;
  // ≥80% 公共前缀 且 分叉尾部够短——防模板/脚手架前缀放大误并两条不同内容
  const maxLen = Math.max(na.length, nb.length);
  return i / maxLen >= 0.8 && maxLen - i <= 25;
}

/** newer 是否为 older 的信息扩展（归一化后 older 是 newer 的前缀且更长） */
export function memoryExtends(newer: string, older: string): boolean {
  const nn = normMemory(newer);
  const no = normMemory(older);
  return nn.length > no.length && no.length > 0 && nn.startsWith(no);
}
