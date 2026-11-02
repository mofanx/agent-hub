import type { Store, HistoryEntry } from "./store.js";

export type ClientMessageFlowState = "none" | "active" | "terminal" | "restart" | "deciding";

export function clientMessageFlowState(
  flow: { phase?: unknown; mode?: unknown } | null | undefined,
  subMode?: unknown,
): ClientMessageFlowState {
  if (subMode === "deciding") return "deciding";
  if (!flow) return "none";
  if (flow.phase === "done" || flow.phase === "cancelled") return "terminal";
  if (flow.phase === "awaiting-retry" ||
      ((flow.mode === "parallel" || flow.mode === "debate") && flow.phase === "summarizing")) return "restart";
  return "active";
}

export type ClientMessageRequest = {
  key: string;
  fingerprint: string;
  scope: "room" | "session";
  scopeId: string;
  entry: HistoryEntry;
  validateNew?: () => void;
};

type Inflight = { fingerprint: string; promise: Promise<Record<string, unknown>> };
const inflight = new WeakMap<Store, Map<string, Inflight>>();

const replyOf = (r: {
  state: string;
  historyId?: number;
  result?: unknown;
}): Record<string, unknown> => {
  if (r.state === "accepted") {
    return {
      ...(typeof r.result === "object" && r.result !== null ? (r.result as Record<string, unknown>) : {}),
      deliveryStatus: "accepted",
      ...(r.historyId !== undefined ? { historyId: r.historyId } : {}),
      deduped: true,
    };
  }
  return {
    deliveryStatus: "uncertain",
    ...(r.historyId !== undefined ? { historyId: r.historyId } : {}),
    deduped: true,
  };
};

export function clientMessageStatus(store: Store, key: string): Record<string, unknown> {
  const r = store.clientMsgReceipt(key);
  if (!r) return { deliveryStatus: "not_found" };
  return replyOf(r);
}

export async function runClientMessage(
  store: Store,
  request: ClientMessageRequest,
  dispatch: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let map = inflight.get(store);
  if (!map) {
    map = new Map();
    inflight.set(store, map);
  }
  const prev = map.get(request.key);
  if (prev) {
    if (prev.fingerprint !== request.fingerprint) throw new Error("client_message_conflict");
    return prev.promise;
  }
  const promise = (async (): Promise<Record<string, unknown>> => {
    const existing = store.clientMsgReceipt(request.key);
    if (existing) {
      if (!existing.legacy && existing.fingerprint !== request.fingerprint) {
        throw new Error("client_message_conflict");
      }
      return replyOf(existing);
    }
    request.validateNew?.();
    const began = store.clientMsgBegin(
      request.key,
      request.fingerprint,
      request.scope,
      request.scopeId,
      request.entry,
    );
    if (!began.created) return replyOf(began);
    const historyId = began.historyId;
    try {
      const result = await dispatch();
      try {
        store.clientMsgFinish(request.key, "accepted", result);
      } catch {
        try { store.clientMsgFinish(request.key, "uncertain"); } catch {}
        return { deliveryStatus: "uncertain", historyId };
      }
      return { ...result, deliveryStatus: "accepted", historyId };
    } catch {
      try { store.clientMsgFinish(request.key, "uncertain"); } catch {}
      return { deliveryStatus: "uncertain", historyId };
    }
  })();
  map.set(request.key, { fingerprint: request.fingerprint, promise });
  try {
    return await promise;
  } finally {
    map.delete(request.key);
  }
}
