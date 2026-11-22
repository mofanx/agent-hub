import { dedupInflight } from "./op-ledger.js";
import type { Connection } from "./store.js";

export interface SessionLiveDeps {
  hasOwner(sessionId: string): boolean;
  hasMeta(sessionId: string): boolean;
  resumeSession(sessionId: string): Promise<unknown>;
}

export function createEnsureSessionLive(deps: SessionLiveDeps) {
  const resumes = new Map<string, Promise<unknown>>();
  return async function ensureSessionLive(sessionId: string): Promise<void> {
    if (deps.hasOwner(sessionId) || !deps.hasMeta(sessionId)) return;
    const r = await dedupInflight(resumes, sessionId, () => deps.resumeSession(sessionId));
    const newId = (r as { sessionId?: unknown } | null | undefined)?.sessionId;
    if (typeof newId === "string" && newId && newId !== sessionId) {
      throw new Error(`session recreated as ${newId}`);
    }
  };
}

export function prewarmTargets<C extends Pick<Connection, "id" | "agent" | "local">>(
  connections: Iterable<C>,
  metas: Iterable<{ connectionId?: string | undefined }>,
): C[] {
  const owned = new Set<string>();
  for (const m of metas) if (m.connectionId) owned.add(m.connectionId);
  return [...connections].filter((c) => c.local === true && c.agent === "devin" && owned.has(c.id));
}
