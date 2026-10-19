import { randomUUID } from "node:crypto";
import { logWarn } from "./logger.js";
import type { Store } from "./store.js";

export type DecisionType = "permission" | "elicitation";
export type DecisionStatus = "pending" | "answered" | "revoked" | "expired";
export type DecisionScope = "once" | "task" | "always";
export type DecisionOption = { id: string; label: string; kind?: string | undefined };

export type DecisionMeta = {
  v: 1;
  decisionId: string;
  requestId: string;
  type: DecisionType;
  title: string;
  options: DecisionOption[];
  context?: Record<string, unknown> | undefined;
  requestedBy: string;
  sessionId: string;
  roomId?: string | undefined;
  /** 决策归属的 mission（如有），decision.list 过滤用 */
  missionId?: string | undefined;
  status: DecisionStatus;
  scope: DecisionScope;
  answer?: { optionId?: string | undefined; label?: string | undefined; action?: string | undefined } | undefined;
  grantKey?: string | undefined;
  auto?: boolean | undefined;
  at: number;
};

/** agent → hub 的决策请求事件载荷（permission/elicitation 统一） */
export type DecisionRequestParams = {
  requestId: string;
  sessionId: string;
  type: DecisionType;
  title: string;
  options: DecisionOption[];
  toolCall?: unknown;
  fields?: unknown;
  message?: string;
  grantKey?: string;
  grantScope?: DecisionScope;
  auto?: boolean;
  autoOptionId?: string;
};

export type DecisionResolveParams = {
  requestId: string;
  outcome: "answered" | "expired" | "revoked";
  optionId?: string;
  action?: string;
};

type Tracked = {
  meta: DecisionMeta;
  rowId: number;
  scope: "room" | "session";
  scopeId: string;
};

const CLIP = 300;
const CARD_LIMIT = 500;
const DEFAULT_MAX_PENDING = 200;

const clipStr = (v: unknown, max = CLIP): string | undefined =>
  typeof v === "string" && v ? v.slice(0, max) : undefined;

/** 递归检查对象上是否带敏感标记（_meta.sensitive / sensitive / redacted / secret） */
function isSensitive(o: Record<string, unknown>, depth = 0): boolean {
  if (depth > 2) return false;
  for (const k of ["sensitive", "redacted", "secret"]) {
    if (o[k] === true || o[k] === "true") return true;
  }
  for (const k of ["_meta", "meta"]) {
    const m = o[k];
    if (typeof m === "object" && m !== null && isSensitive(m as Record<string, unknown>, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * permission toolCall → 决策卡 context：只取白名单字段（title/kind/name/status、
 * locations.path、rawInput 里的 command/path/url 等短摘要），全部 ≤300 字符；
 * 客户端/agent 标注 sensitive 时只落 {redacted:true}，不落明文。
 */
export function permissionContext(toolCall: unknown): Record<string, unknown> {
  const o =
    typeof toolCall === "object" && toolCall !== null
      ? (toolCall as Record<string, unknown>)
      : {};
  if (isSensitive(o)) return { redacted: true };
  const ctx: Record<string, unknown> = {};
  for (const k of ["title", "kind", "name", "status"]) {
    const v = clipStr(o[k]);
    if (v) ctx[k] = v;
  }
  if (Array.isArray(o.locations)) {
    const paths = o.locations
      .map((l) =>
        typeof l === "object" && l !== null
          ? clipStr((l as Record<string, unknown>).path)
          : undefined,
      )
      .filter((p): p is string => !!p)
      .slice(0, 10);
    if (paths.length) ctx.paths = paths;
  }
  const raw =
    typeof o.rawInput === "object" && o.rawInput !== null
      ? (o.rawInput as Record<string, unknown>)
      : undefined;
  if (raw) {
    if (isSensitive(raw)) {
      ctx.rawInput = "[redacted]";
    } else {
      for (const k of ["command", "path", "file_path", "notebook_path", "url", "query"]) {
        const v = clipStr(raw[k]);
        if (v) ctx[k] = v;
      }
      if (Array.isArray(raw.args)) {
        const args = raw.args.map((a) => String(a)).join(" ");
        if (args) ctx.args = args.slice(0, CLIP);
      }
    }
  }
  return ctx;
}

/** elicitation → 决策卡 context：message 截断 + 字段清单（不含值） */
export function elicitationContext(req: {
  message?: string;
  fields?: unknown;
}): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  const msg = clipStr(req.message);
  if (msg) ctx.message = msg;
  if (Array.isArray(req.fields)) {
    const fields = req.fields
      .map((f) => {
        const o = typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {};
        return {
          name: clipStr(o.name, 64),
          label: clipStr(o.label, 128),
          type: clipStr(o.type, 16),
          required: o.required === true,
        };
      })
      .filter((f) => !!f.name)
      .slice(0, 20);
    if (fields.length) ctx.fields = fields;
  }
  return ctx;
}

/** 从所选选项推断授权粒度：kind/name 含 always → always，否则 once（task 只能由调用方显式指定） */
export function inferOptionScope(
  option?: { label?: string | undefined; kind?: string | undefined },
): DecisionScope {
  return /always/i.test(`${option?.kind ?? ""} ${option?.label ?? ""}`) ? "always" : "once";
}

/** 拒绝类选项：词边界匹配 reject/deny/decline/block/cancel（含 ed/d/led/ing/s 与 _once 类 kind 后缀），un- 前缀不误伤 */
export const REJECT_OPTION_RE = /(?<![\w-])(?:reject|deny|denied|decline|block|cancel)(?:ed|d|led|ing|s|[_-]\w+)?(?![\w-])/i;

export function isRejectOption(option?: { label?: string | undefined; kind?: string | undefined }): boolean {
  return REJECT_OPTION_RE.test(`${option?.kind ?? ""} ${option?.label ?? ""}`);
}

function verdictWord(t: Tracked): string {
  if (t.meta.status === "expired") return "超时";
  if (t.meta.status === "revoked") return "撤销";
  if (t.meta.type === "permission") {
    return isRejectOption(t.meta.options.find((o) => o.id === t.meta.answer?.optionId))
      ? "拒绝"
      : "批准";
  }
  const a = t.meta.answer?.action;
  if (a === "accept") return "答复";
  if (a === "decline") return "拒绝";
  return "取消";
}

/**
 * 决策卡登记处：permission/elicitation 统一为房史 kind:"decision" 条目。
 * open → append + 广播；resolve/revoke → updateEntry 原位覆写并重播
 * （房间作用域复用 room.process 信封，与 kind:"flow" 原位更新机制一致；
 * 会话作用域走 decision.update 事件）。
 */
export class DecisionCenter {
  private byId = new Map<string, Tracked>();
  private byRequest = new Map<string, string>();

  constructor(
    private readonly deps: {
      store: Store;
      broadcast: (method: string, params: Record<string, unknown>) => void;
      audit?: (
        scope: "room" | "session",
        scopeId: string,
        ev: { author: string; summary: string },
      ) => void;
      /** 待决决策硬上限：超限丢弃最旧 pending（默认 200，HUB_MAX_PENDING_DECISIONS 覆盖） */
      maxPending?: number;
    },
  ) {}

  open(
    req: DecisionRequestParams,
    placement: {
      scope: "room" | "session";
      scopeId: string;
      requestedBy: string;
      /** 发起该决策的回合归属的 mission（如有），decision.list 过滤用 */
      missionId?: string;
    },
  ): DecisionMeta | undefined {
    const meta: DecisionMeta = {
      v: 1,
      decisionId: `d-${randomUUID().slice(0, 8)}`,
      requestId: req.requestId,
      type: req.type,
      title: String(req.title ?? "").slice(0, CLIP),
      options: req.options
        .map((o) => ({
          id: o.id,
          label: String(o.label ?? o.id).slice(0, 120),
          ...(o.kind ? { kind: String(o.kind).slice(0, 32) } : {}),
        }))
        .slice(0, 10),
      requestedBy: placement.requestedBy,
      sessionId: req.sessionId,
      ...(placement.scope === "room" ? { roomId: placement.scopeId } : {}),
      ...(placement.missionId ? { missionId: placement.missionId } : {}),
      status: req.auto ? "answered" : "pending",
      scope: req.grantScope ?? "once",
      at: Date.now(),
    };
    const ctx =
      req.type === "permission"
        ? permissionContext(req.toolCall)
        : elicitationContext(req);
    if (Object.keys(ctx).length) meta.context = ctx;
    if (req.grantKey) meta.grantKey = req.grantKey;
    if (req.auto) {
      meta.auto = true;
      const opt = meta.options.find((o) => o.id === req.autoOptionId);
      meta.answer = {
        ...(req.autoOptionId ? { optionId: req.autoOptionId } : {}),
        ...(opt?.label ? { label: opt.label } : {}),
      };
    }
    const text = JSON.stringify(meta);
    const rowId = this.deps.store.append(placement.scope, placement.scopeId, {
      at: meta.at,
      kind: "decision",
      author: placement.requestedBy,
      text,
    });
    if (rowId < 0) return undefined;
    const t: Tracked = { meta, rowId, scope: placement.scope, scopeId: placement.scopeId };
    this.byId.set(meta.decisionId, t);
    this.byRequest.set(req.requestId, meta.decisionId);
    this.capPending();
    this.cap();
    this.push(t);
    this.audit(
      t,
      req.auto ? `自动放行「${meta.title}」(scope=${meta.scope})` : `发起决策「${meta.title}」`,
    );
    return meta;
  }

  /** request 侧 settle（回答/超时/吊销）→ 原位更新条目 */
  resolveByRequest(
    requestId: string,
    outcome: "answered" | "expired" | "revoked",
    opts?: { optionId?: string; action?: string; scope?: DecisionScope },
  ): Tracked | undefined {
    const id = this.byRequest.get(requestId);
    if (!id) return undefined;
    this.byRequest.delete(requestId);
    const t = this.byId.get(id);
    if (!t || t.meta.status === "revoked") return t;
    t.meta.status = outcome;
    const opt = t.meta.options.find((o) => o.id === opts?.optionId);
    t.meta.answer = {
      ...(opts?.optionId ? { optionId: opts.optionId } : {}),
      ...(opt?.label ? { label: opt.label } : {}),
      ...(opts?.action ? { action: opts.action } : {}),
    };
    if (opts?.scope) t.meta.scope = opts.scope;
    this.commit(t);
    this.audit(t, `${verdictWord(t)}「${t.meta.title}」(scope=${t.meta.scope})`);
    return t;
  }

  /** decision.revoke：原位更新为 revoked；已由 resolve 落地的 revoked 不重复审计 */
  revoke(decisionId: string): Tracked | undefined {
    const t = this.byId.get(decisionId);
    if (!t) return undefined;
    this.byRequest.delete(t.meta.requestId);
    if (t.meta.status === "revoked") return t;
    t.meta.status = "revoked";
    this.commit(t);
    this.audit(t, `撤销「${t.meta.title}」(scope=${t.meta.scope})`);
    return t;
  }

  get(decisionId: string): Tracked | undefined {
    return this.byId.get(decisionId);
  }

  /**
   * 当前待处理决策（仅活跃 pending；重启后请求已消失的不在此列，由 sweep 收敛）。
   * filter 命中任一字段即收窄（OR 语义）；不传 filter 返回全部 pending。
   */
  listPending(filter?: {
    roomId?: string | undefined;
    sessionId?: string | undefined;
    missionId?: string | undefined;
  }): DecisionMeta[] {
    const hasFilter =
      filter?.roomId !== undefined ||
      filter?.sessionId !== undefined ||
      filter?.missionId !== undefined;
    return [...this.byId.values()]
      .filter((t) => t.meta.status === "pending")
      .filter(
        (t) =>
          !hasFilter ||
          (filter?.roomId !== undefined && t.meta.roomId === filter.roomId) ||
          (filter?.sessionId !== undefined && t.meta.sessionId === filter.sessionId) ||
          (filter?.missionId !== undefined &&
            (t.meta.missionId === filter.missionId || t.meta.context?.missionId === filter.missionId)),
      )
      .sort((a, b) => a.meta.at - b.meta.at)
      .map((t) => JSON.parse(JSON.stringify(t.meta)) as DecisionMeta);
  }

  getByRequest(requestId: string): Tracked | undefined {
    const id = this.byRequest.get(requestId);
    return id ? this.byId.get(id) : undefined;
  }

  private commit(t: Tracked): void {
    this.deps.store.updateEntry(t.rowId, JSON.stringify(t.meta));
    this.push(t);
  }

  private push(t: Tracked): void {
    const entry = {
      id: t.rowId,
      at: t.meta.at,
      kind: "decision",
      author: t.meta.requestedBy,
      text: JSON.stringify(t.meta),
    };
    this.deps.broadcast("decision.update", { scope: t.scope, id: t.scopeId, entry });
    if (t.scope === "room") {
      this.deps.broadcast("room.process", { roomId: t.scopeId, entry });
    }
  }

  private audit(t: Tracked, summary: string): void {
    this.deps.audit?.(t.scope, t.scopeId, { author: t.meta.requestedBy, summary });
  }

  /** pending 硬上限：超限按时间淘汰最旧 pending（原位定稿为 revoked 并留痕） */
  private capPending(): void {
    const max = this.deps.maxPending ?? DEFAULT_MAX_PENDING;
    const pending = [...this.byId.values()]
      .filter((t) => t.meta.status === "pending")
      .sort((a, b) => a.meta.at - b.meta.at);
    for (const t of pending.slice(0, Math.max(0, pending.length - max))) {
      t.meta.status = "revoked";
      this.byRequest.delete(t.meta.requestId);
      this.commit(t);
      logWarn(
        "decision",
        `pending decisions over limit ${max}; dropped oldest ${t.meta.decisionId}「${t.meta.title}」`,
      );
      this.audit(t, `超出待决上限（${max}），自动撤销最旧决策「${t.meta.title}」`);
    }
  }

  private cap(): void {
    if (this.byId.size <= CARD_LIMIT) return;
    for (const [id, t] of this.byId) {
      if (t.meta.status === "pending") continue;
      this.byRequest.delete(t.meta.requestId);
      this.byId.delete(id);
      if (this.byId.size <= CARD_LIMIT) break;
    }
  }
}

/**
 * 启动收尾：重启前仍为 pending 的决策卡对应的 pending 请求已随进程消失，
 * 统一定稿为 expired 并重播更新。
 */
export function sweepPendingDecisions(deps: {
  store: Store;
  broadcast: (method: string, params: Record<string, unknown>) => void;
}): number {
  let swept = 0;
  for (const row of deps.store.findPendingDecisionCards()) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.text) as Record<string, unknown>;
    } catch {
      continue;
    }
    meta.status = "expired";
    const text = JSON.stringify(meta);
    deps.store.updateEntry(row.id, text);
    const entry = {
      id: row.id,
      at: row.at,
      kind: "decision",
      author: String(meta.requestedBy ?? ""),
      text,
    };
    deps.broadcast("decision.update", { scope: row.scope, id: row.scopeId, entry });
    if (row.scope === "room") {
      deps.broadcast("room.process", { roomId: row.scopeId, entry });
    }
    swept++;
  }
  return swept;
}
