/**
 * 外发副作用台账：同一 opId 重复提交（断连重放、重试重发命中）直接跳过。
 * opId 必须携带回合/内容限定符：重跑同一 turn 产生新 opId（不跳过），
 * 只有"同一 op 重复到达"才去重。内存有界 LRU，不落库（history 本身是事实源）。
 */
export class OperationLedger {
  private ops = new Map<string, { kind: string; at: number }>();

  constructor(private readonly limit = 5000) {}

  /** 首次提交返回 true 并记账；同 opId 再次提交返回 false */
  commit(opId: string, kind: string, at = Date.now()): boolean {
    if (this.ops.has(opId)) return false;
    if (this.ops.size >= this.limit) {
      const oldest = this.ops.keys().next().value;
      if (oldest !== undefined) this.ops.delete(oldest);
    }
    this.ops.set(opId, { kind, at });
    return true;
  }

  has(opId: string): boolean {
    return this.ops.has(opId);
  }

  get size(): number {
    return this.ops.size;
  }
}
