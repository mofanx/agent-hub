/**
 * safety-floor：自动放行路径（HUB_PERMISSION_BYPASS / grant always·task）之上的
 * 词法黑名单地板。命中危险命令 → 强制落交互决策卡；shell/execute 类请求提取
 * 不到命令串 → 同样落卡（"读不到行尾永不 clear"保守默认）。只拦自动放行，
 * 人工卡照常走，不新造审批级。
 *
 * 设计边界：黑名单保持极简（设备覆写/删根与 home/炸机/关机类不可恢复操作），
 * 词法匹配宁漏勿误杀；不做完整 shell 解析——那是对抗面，不是地板。
 */

export type SafetyFloorVerdict =
  | { action: "allow" }
  | { action: "interactive"; reason: string };

const SHELL_KINDS = new Set([
  "execute", "exec", "command", "shell", "bash", "terminal", "run",
]);

function isShellKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return SHELL_KINDS.has(k) || k.includes("shell") || k.includes("exec") || k.includes("command");
}

/** 从 toolCall 提取候选命令串：rawInput 常见字段 → title 首行兜底 */
export function extractCommand(toolCall: unknown): string | undefined {
  if (typeof toolCall !== "object" || toolCall === null) return undefined;
  const o = toolCall as Record<string, unknown>;
  const raw =
    typeof o.rawInput === "object" && o.rawInput !== null
      ? (o.rawInput as Record<string, unknown>)
      : {};
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v.join(" ");
  }
  for (const key of ["command", "cmd", "text"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

/** 归一化：剥离 quote/转义噪音、展开 $HOME/~、压空白，供词法匹配 */
function normalize(cmd: string): string {
  return cmd
    .replace(/\$\{?HOME\}?/g, "~")
    .replace(/\\/g, "")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const RULES: { id: string; re: RegExp }[] = [
  // 删根/home/上级目录（路径须恰为 /、~、..、/*——/tmp/x 不误拦）
  { id: "rm-root", re: /\brm\s+-[a-z]*[rf][a-z]*(\s+-[a-z]+)*\s+(\/|~|\.\.)\s*\/?\s*$/ },
  { id: "rm-glob-root", re: /\brm\s+-[a-z]*[rf][a-z]*(\s+-[a-z]+)*\s+\/\*\s*$/ },
  // 设备覆写：dd of=、重定向写裸设备、mkfs、wipefs/shred
  { id: "dd-disk", re: /\bdd\b[^\n]*\bof=\/dev\// },
  { id: "redirect-disk", re: />\s*\/dev\/(sd|nvme|hd|xvd|mmcblk|vd)/ },
  { id: "mkfs", re: /\bmkfs(?:\.[a-z0-9]+)?\s+\S*\/dev\// },
  { id: "wipe-disk", re: /\b(wipefs|shred|sgdisk\s+--zap|fdisk\s+--wipe)\b[^\n]*\/dev\// },
  // fork bomb（含常见变体）
  { id: "fork-bomb", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;?\s*:/ },
  // 关机/重启类（init 0/6、shutdown、poweroff、reboot、systemctl poweroff）
  { id: "poweroff", re: /\b(shutdown|poweroff|reboot|halt)\b|\binit\s+[06]\b|\bsystemctl\s+(poweroff|reboot|halt)\b/ },
  // 清扇区/零填充磁盘
  { id: "zero-disk", re: /\b(cat\s+\/dev\/zero|dd\b[^\n]*if=\/dev\/(zero|random|urandom))[^\n]*\/dev\// },
];

const SAFE_PREFIXES = [
  /^rm\s+[^\n]*\.(sh|ts|js|log|tmp|bak|cache)\b/, // 显式文件后缀删除
];

export function safetyFloorVerdict(toolCall: unknown): SafetyFloorVerdict {
  if (typeof toolCall !== "object" || toolCall === null) return { action: "allow" };
  const o = toolCall as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  // 词法检查只针对 shell/execute 类 kind；文本/编辑类 kind 提取到的 code 字段不做命令黑名单
  if (kind && !isShellKind(kind)) return { action: "allow" };
  const cmd = extractCommand(toolCall);
  if (!cmd) {
    return isShellKind(kind)
      ? { action: "interactive", reason: "shell command unparseable" }
      : { action: "allow" };
  }
  const n = normalize(cmd);
  for (const r of RULES) {
    if (r.re.test(n) && !SAFE_PREFIXES.some((s) => s.test(n))) {
      return { action: "interactive", reason: r.id };
    }
  }
  return { action: "allow" };
}
