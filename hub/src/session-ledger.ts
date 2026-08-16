import { randomUUID } from "node:crypto";
import {
  isEventAction,
  type Artifact,
  type EventAction,
  type RoomEvent,
} from "./room.js";
import type { SessionMeta } from "./store.js";

const ARTIFACT_LIMIT = 50;
const EVENT_LIMIT = 200;

export type SessionLedgerState = {
  artifacts: Artifact[];
  events: RoomEvent[];
};

export class SessionLedger {
  private artifacts = new Map<string, Artifact[]>();
  private events = new Map<string, RoomEvent[]>();
  private aliasSeqs = new Map<string, number>();

  importFromMeta(sessions: SessionMeta[]): void {
    for (const s of sessions) {
      this.import(s.sessionId, {
        artifacts: s.artifacts ?? [],
        events: s.events ?? [],
      });
    }
  }

  import(sessionId: string, state: SessionLedgerState): void {
    const artifacts = [...(state.artifacts ?? [])];
    const events = [...(state.events ?? [])];
    for (let i = 0; i < artifacts.length; i++) {
      if (!artifacts[i]!.alias) artifacts[i]!.alias = `s${i + 1}`;
    }
    this.artifacts.set(sessionId, artifacts);
    this.events.set(sessionId, events);
    this.aliasSeqs.set(sessionId, artifacts.length);
  }

  attachTo(sessions: SessionMeta[]): SessionMeta[] {
    return sessions.map((s) => ({
      ...s,
      artifacts: this.getArtifacts(s.sessionId, ARTIFACT_LIMIT),
      events: this.getEvents(s.sessionId, EVENT_LIMIT),
    }));
  }

  drop(sessionId: string): void {
    this.artifacts.delete(sessionId);
    this.events.delete(sessionId);
    this.aliasSeqs.delete(sessionId);
  }

  private nextAlias(sessionId: string): string {
    const seq = (this.aliasSeqs.get(sessionId) ?? 0) + 1;
    this.aliasSeqs.set(sessionId, seq);
    return `s${seq}`;
  }

  addFile(
    sessionId: string,
    file: Omit<Artifact, "id" | "at" | "alias">,
  ): Artifact {
    const list = this.artifacts.get(sessionId) ?? [];
    this.artifacts.set(sessionId, list);
    if (file.path) {
      const existing = list.find((a) => a.path === file.path);
      if (existing) {
        existing.author = file.author;
        existing.summary = file.summary;
        existing.at = Date.now();
        if (file.taskId) existing.taskId = file.taskId;
        return existing;
      }
    }
    const item: Artifact = {
      ...file,
      id: randomUUID().slice(0, 8),
      alias: this.nextAlias(sessionId),
      at: Date.now(),
    };
    list.push(item);
    if (list.length > ARTIFACT_LIMIT) list.shift();
    return item;
  }

  addEvent(sessionId: string, event: Omit<RoomEvent, "id" | "at">): RoomEvent {
    const list = this.events.get(sessionId) ?? [];
    this.events.set(sessionId, list);
    const item: RoomEvent = {
      ...event,
      action: isEventAction(event.action) ? event.action : "command",
      id: randomUUID().slice(0, 8),
      at: Date.now(),
    };
    list.push(item);
    if (list.length > EVENT_LIMIT) list.shift();
    return item;
  }

  getArtifacts(sessionId: string, limit = ARTIFACT_LIMIT): Artifact[] {
    return [...(this.artifacts.get(sessionId) ?? [])].reverse().slice(0, limit);
  }

  getEvents(sessionId: string, limit = EVENT_LIMIT): RoomEvent[] {
    return [...(this.events.get(sessionId) ?? [])].reverse().slice(0, limit);
  }

  removeArtifact(sessionId: string, artifactId: string): boolean {
    const list = this.artifacts.get(sessionId);
    if (!list) return false;
    const next = list.filter((a) => a.id !== artifactId);
    if (next.length === list.length) return false;
    this.artifacts.set(sessionId, next);
    return true;
  }

  clearArtifacts(sessionId: string): number {
    const list = this.artifacts.get(sessionId);
    const n = list?.length ?? 0;
    this.artifacts.set(sessionId, []);
    return n;
  }

  removeEvent(sessionId: string, eventId: string): boolean {
    const list = this.events.get(sessionId);
    if (!list) return false;
    const next = list.filter((e) => e.id !== eventId);
    if (next.length === list.length) return false;
    this.events.set(sessionId, next);
    return true;
  }

  clearEvents(sessionId: string, action?: string): number {
    const list = this.events.get(sessionId);
    if (!list) return 0;
    if (!action) {
      const n = list.length;
      this.events.set(sessionId, []);
      return n;
    }
    const before = list.length;
    const next = list.filter((e) => e.action !== action);
    this.events.set(sessionId, next);
    return before - next.length;
  }

  captureOutput(
    sessionId: string,
    artifacts: Array<{
      type: "file" | "event";
      action?: string | undefined;
      path?: string | undefined;
      summary: string;
    }>,
  ): void {
    for (const a of artifacts) {
      if (a.type === "file") {
        this.addFile(sessionId, {
          author: sessionId,
          summary: a.summary,
          path: a.path,
        });
      } else if (isEventAction(a.action)) {
        this.addEvent(sessionId, {
          author: sessionId,
          action: a.action as EventAction,
          summary: a.summary,
          path: a.path,
        });
      }
    }
  }

  recordDelete(sessionId: string, rel: string): void {
    const list = this.artifacts.get(sessionId);
    if (list) this.artifacts.set(sessionId, list.filter((a) => a.path !== rel));
    this.addEvent(sessionId, {
      author: sessionId,
      action: "delete",
      summary: `删除 ${rel}`,
      path: rel,
    });
  }

  recordRename(sessionId: string, fromRel: string, toRel: string): void {
    const list = this.artifacts.get(sessionId);
    if (list) {
      for (const a of list) {
        if (a.path === fromRel) a.path = toRel;
      }
    }
    this.addEvent(sessionId, {
      author: sessionId,
      action: "rename",
      summary: `${fromRel} → ${toRel}`,
      path: toRel,
      oldPath: fromRel,
    });
  }
}
