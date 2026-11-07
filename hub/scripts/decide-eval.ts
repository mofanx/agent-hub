/**
 * decide-eval：decision-model 一期回放评测骨架。
 * 用法：npx tsx scripts/decide-eval.ts <decisions.ndjson> [labels.jsonl]
 * - 无 labels：统计 shadow 判决分布（tier/via/mode、直执候选率）
 * - 有 labels（jsonl: {"stateHash":"...","expected":"mention"}）：按 stateHash
 *   或 outcome 对里的 hostMode 计算 shadow↔expected 一致率与混淆矩阵
 */
import fs from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: tsx decide-eval.ts <decisions.ndjson> [labels.jsonl]");
  process.exit(1);
}
const rows = fs
  .readFileSync(logPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return null;
    }
  })
  .filter((r): r is Record<string, unknown> => r !== null);

const decides = rows.filter((r) => r.kind === "decide");
const outcomes = rows.filter((r) => r.kind === "outcome");

const tally = <K extends string>(f: (r: Record<string, unknown>) => K | undefined) => {
  const m = new Map<string, number>();
  for (const r of decides) {
    const k = f(r);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};
const print = (title: string, m: Map<string, number>) =>
  console.log(`${title}: ${[...m.entries()].map(([k, v]) => `${k}=${v}`).join(" ") || "（空）"}`);

console.log(`decisions=${decides.length} outcomes=${outcomes.length}`);
print("tier", tally((r) => String((r.verdict as Record<string, unknown>)?.tier ?? "")));
print("via", tally((r) => String((r.verdict as Record<string, unknown>)?.via ?? "")));
print("mode", tally((r) => String((r.verdict as Record<string, unknown>)?.mode ?? "")));
print("action", tally((r) => String((r.verdict as Record<string, unknown>)?.action ?? "")));

const directRate =
  decides.length === 0
    ? 0
    : decides.filter((r) => (r.verdict as Record<string, unknown>)?.action === "direct").length / decides.length;
console.log(`direct-candidate rate: ${(directRate * 100).toFixed(1)}%`);

// shadow↔host 一致率（outcome 对自带 hostMode）
const paired = outcomes.filter((r) => r.shadow != null && r.shadow !== null);
const agree = paired.filter((r) => r.agree === true).length;
console.log(`shadow↔host pairs=${paired.length} agree=${agree} (${paired.length ? ((agree / paired.length) * 100).toFixed(1) : "n/a"}%)`);

// labels.jsonl 评测（可选）
const labelsPath = process.argv[3];
if (labelsPath) {
  const labels = new Map<string, string>();
  for (const l of fs.readFileSync(labelsPath, "utf8").split("\n").filter(Boolean)) {
    try {
      const o = JSON.parse(l) as { stateHash?: string; expected?: string };
      if (o.stateHash && o.expected) labels.set(o.stateHash, o.expected);
    } catch { /* skip */ }
  }
  let n = 0;
  let hit = 0;
  const confusion = new Map<string, number>();
  for (const r of decides) {
    const exp = labels.get(String(r.stateHash ?? ""));
    if (!exp) continue;
    const got = String((r.verdict as Record<string, unknown>)?.mode ?? "none");
    n++;
    if (got === exp) hit++;
    const key = `${exp}->${got}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  console.log(`labeled=${n} accuracy=${n ? ((hit / n) * 100).toFixed(1) : "n/a"}%`);
  print("confusion", confusion);
}
