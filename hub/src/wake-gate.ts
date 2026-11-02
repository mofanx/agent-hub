/** Loop 廉价决策层：事件到达 EventWakeBook 前先过谓词判定"值得叫醒吗"，
 *  不值得直接计数跳过——不烧主模型。规则随 eventTrigger.filter 配置，
 *  默认放行兼容现有行为；auto 路由可复用 wakeGateAllows 同一判定接口。 */

/** 白名单谓词：fields 为"点路径 → 期望值"的 AND 匹配，全部命中才放行；
 *  contains 为关键词白名单（OR），事件上下文 text 命中任一子串才放行——
 *  用于 room.message 类文本事件的报障识别（silent-repro）。 */
export type WakeFilter = {
  fields?: Record<string, string> | undefined;
  contains?: string[] | undefined;
};

/** 事件上下文：kind + 调用方随事件附带的负载字段（waitingFor/status/scope…） */
export type WakeCtx = Record<string, unknown>;

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 判定：无 filter/无谓词恒放行；fields 内全部键值相等（转字符串比较）且
 *  contains（如配置）至少一个关键词出现在 ctx.text 中才放行 */
export function wakeGateAllows(filter: WakeFilter | undefined, ctx: WakeCtx): boolean {
  const fields = filter?.fields;
  if (fields) {
    for (const [k, want] of Object.entries(fields)) {
      if (String(getPath(ctx, k) ?? "") !== want) return false;
    }
  }
  const contains = filter?.contains;
  if (contains && contains.length > 0) {
    const text = String(ctx.text ?? "").toLowerCase();
    if (!contains.some((kw) => text.includes(kw.toLowerCase()))) return false;
  }
  return true;
}

/** 谓词拦截计数（观测用：被门控省掉的唤醒次数，按任务聚合） */
export class WakeGateStats {
  private skips = new Map<string, number>();
  skip(taskId: string): void {
    this.skips.set(taskId, (this.skips.get(taskId) ?? 0) + 1);
  }
  count(taskId: string): number {
    return this.skips.get(taskId) ?? 0;
  }
  remove(taskId: string): void {
    this.skips.delete(taskId);
  }
}

/** 校验 filter 形状（parseEventTrigger 调用）：fields 非空对象、值为字符串/数字/布尔 */
export function parseWakeFilter(raw: unknown): WakeFilter | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error("eventTrigger.filter must be an object");
  const fields = (raw as Record<string, unknown>).fields;
  if (fields !== undefined) {
    if (typeof fields !== "object" || fields === null || Array.isArray(fields))
      throw new Error("eventTrigger.filter.fields must be an object");
    for (const [k, v] of Object.entries(fields)) {
      if (!k) throw new Error("eventTrigger.filter.fields key required");
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
        throw new Error(`eventTrigger.filter.fields.${k} must be string/number/boolean`);
      (fields as Record<string, unknown>)[k] = String(v);
    }
  }
  const contains = (raw as Record<string, unknown>).contains;
  if (contains !== undefined) {
    if (!Array.isArray(contains) || contains.length === 0 ||
        contains.some((x) => typeof x !== "string" || !x.trim()))
      throw new Error("eventTrigger.filter.contains must be non-empty string array");
  }
  const out: WakeFilter = {};
  if (fields !== undefined) out.fields = fields as Record<string, string>;
  if (contains !== undefined) out.contains = (contains as string[]).map((x) => x.trim());
  return out;
}
