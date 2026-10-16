import { createHash } from "node:crypto";
import type { RoomManager } from "./room.js";
import type { Store } from "./store.js";

const TASK_TEXT_MAX = 300;
const TASK_OUTPUT_MAX = 1000;
const EVIDENCE_MAX = 300;
const GENERIC_MAX = 300;

const clip = (v: unknown, max = GENERIC_MAX): string | undefined =>
  typeof v === "string" && v ? v.slice(0, max) : undefined;

const strList = (v: unknown, max = GENERIC_MAX): string[] | undefined =>
  Array.isArray(v)
    ? v.map((s) => String(s).slice(0, max)).filter(Boolean)
    : undefined;

/**
 * 编排卡快照：从 getFlow 视图提取白名单字段并截断，剔除
 * baseline/diff/reproSteps/verifyStdout/verifyStderr/backendRuns 等大体积字段。
 */
export function toCardSnapshot(
  flow: Record<string, unknown>,
  mode: string,
): Record<string, unknown> {
  const tasks = Array.isArray(flow.tasks)
    ? flow.tasks.map((t) => {
        const o = t as Record<string, unknown>;
        const ac =
          typeof o.automaticCheck === "object" && o.automaticCheck !== null
            ? (o.automaticCheck as Record<string, unknown>)
            : undefined;
        return {
          id: String(o.id ?? ""),
          sessionId: String(o.sessionId ?? ""),
          name: String(o.name ?? ""),
          status: String(o.status ?? ""),
          task: String(o.task ?? "").slice(0, TASK_TEXT_MAX),
          ...(strList(o.dependsOn, 64)?.length
            ? { dependsOn: strList(o.dependsOn, 64) }
            : {}),
          ...(typeof o.dispatchedAt === "number" ? { dispatchedAt: o.dispatchedAt } : {}),
          ...(typeof o.finishedAt === "number" ? { finishedAt: o.finishedAt } : {}),
          ...(clip(o.waitingFor) ? { waitingFor: clip(o.waitingFor, 64) } : {}),
          ...(clip(o.waitingQuestion)
            ? { waitingQuestion: clip(o.waitingQuestion) }
            : {}),
          ...(clip(o.waitingHelpId, 64) ? { waitingHelpId: clip(o.waitingHelpId, 64) } : {}),
          ...(clip(o.failureMessage)
            ? { failureMessage: clip(o.failureMessage) }
            : {}),
          ...(typeof o.retries === "number" && o.retries > 0
            ? { retries: o.retries }
            : {}),
          ...(clip(o.verificationStatus, 32)
            ? { verificationStatus: clip(o.verificationStatus, 32) }
            : {}),
          ...(clip(o.output, TASK_OUTPUT_MAX)
            ? { output: clip(o.output, TASK_OUTPUT_MAX) }
            : {}),
          ...(Array.isArray(o.verifications) && o.verifications.length
            ? {
                verifications: o.verifications
                  .map((v) => {
                    const vo = v as Record<string, unknown>;
                    return {
                      by: String(vo.by ?? ""),
                      verdict: String(vo.verdict ?? ""),
                      evidence: String(vo.evidence ?? "").slice(0, EVIDENCE_MAX),
                      ...(clip(vo.backendToolCallId, 128)
                        ? { backendToolCallId: clip(vo.backendToolCallId, 128) }
                        : {}),
                    };
                  })
                  .filter((v) => v.by),
              }
            : {}),
          ...(Array.isArray(o.artifacts) && o.artifacts.length
            ? { artifacts: o.artifacts }
            : {}),
          ...(ac
            ? {
                automaticCheck: {
                  ...(clip(ac.status, 32) ? { status: clip(ac.status, 32) } : {}),
                  ...(typeof ac.exitCode === "number" ? { exitCode: ac.exitCode } : {}),
                  ...(typeof ac.snapshotCurrent === "boolean"
                    ? { snapshotCurrent: ac.snapshotCurrent }
                    : {}),
                  ...(clip(ac.reason, 64) ? { reason: clip(ac.reason, 64) } : {}),
                },
              }
            : {}),
          ...(clip(o.verifyCommand)
            ? {
                verifyCommand: clip(o.verifyCommand),
                ...(typeof o.verifyExitCode === "number"
                  ? { verifyExitCode: o.verifyExitCode }
                  : {}),
              }
            : {}),
          ...(clip(o.verifyCheckId, 64)
            ? { verifyCheckId: clip(o.verifyCheckId, 64) }
            : {}),
        };
      })
    : [];
  const finishedAt = Math.max(
    0,
    ...tasks.map((t) => (typeof t.finishedAt === "number" ? (t.finishedAt as number) : 0)),
  );
  const phase = String(flow.phase ?? "");
  return {
    v: 1,
    flowId: String(flow.flowId ?? ""),
    phase,
    goal: String(flow.goal ?? "").slice(0, GENERIC_MAX),
    mode,
    startedAt: Number(flow.startedAt ?? 0),
    ...(clip(flow.waitingFor, 32) ? { waitingFor: clip(flow.waitingFor, 32) } : {}),
    ...(typeof flow.rounds === "number" ? { rounds: flow.rounds } : {}),
    ...(typeof flow.maxRounds === "number" ? { maxRounds: flow.maxRounds } : {}),
    ...((phase === "done" || phase === "awaiting-retry") && finishedAt > 0
      ? { finishedAt }
      : {}),
    progress:
      typeof flow.progress === "object" && flow.progress !== null
        ? flow.progress
        : { done: 0, running: 0, pending: 0, failed: 0, total: tasks.length },
    ...(strList(flow.acceptanceCriteria)?.length
      ? { acceptanceCriteria: strList(flow.acceptanceCriteria) }
      : {}),
    tasks,
    ...(strList(flow.supplements)?.length
      ? { supplements: strList(flow.supplements) }
      : {}),
    ...(clip(flow.clarificationId, 64)
      ? {
          clarificationId: clip(flow.clarificationId, 64),
          ...(strList(flow.clarificationQuestions)?.length
            ? { clarificationQuestions: strList(flow.clarificationQuestions) }
            : {}),
        }
      : {}),
  };
}

/**
 * 孤儿编排卡收尾：重启后非终态 kind:"flow" 卡对应的 flow 已不存在
 * （parallel/pipeline/debate 不持久化，或 conductor 快照缺失）→ 定稿 cancelled 并重播条目。
 * liveFlowId 返回该房间当前活跃 flow 的 id；与卡 meta.flowId 一致则跳过，绝不误杀活跃卡。
 */
export function sweepOrphanFlowCards(deps: {
  store: Store;
  liveFlowId: (roomId: string) => string | undefined;
  broadcast: (method: string, params: Record<string, unknown>) => void;
}): void {
  for (const row of deps.store.findUnfinishedFlowCards()) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const liveId = deps.liveFlowId(row.scopeId) ?? "";
    if (liveId && liveId === meta.flowId) continue;
    meta.phase = "cancelled";
    meta.finishedAt = Date.now();
    const text = JSON.stringify(meta);
    deps.store.updateEntry(row.id, text);
    deps.broadcast("room.process", {
      roomId: row.scopeId,
      entry: { id: row.id, at: row.at, kind: "flow", author: "", text },
    });
  }
}

export type FlowCardSyncDeps = {
  store: Store;
  rooms: RoomManager;
  broadcast: (method: string, params: Record<string, unknown>) => void;
  /** 该房间当前 flow 已记录的卡条目 rowId（重启恢复路径） */
  cardRowId: (roomId: string) => number | undefined;
  setCardRowId: (roomId: string, rowId: number) => void;
};

type TrackedCard = { flowId: string; rowId: number; hash: string; at: number; text: string };

/**
 * 编排卡同步器：挂在 emitFlow 离散点。
 * - flow 首次出现 → append 一条 kind:"flow" 房史条目并广播 room.process 信封；
 * - 后续更新 → 序列化 hash 脏检查后 updateEntry 原位覆写（at/id 不变）并复用信封重播；
 * - flow 被移除（done 清理/取消）→ 定稿终态快照；
 * - 同房间新一轮编排（flowId 变更）→ 旧卡定稿、新卡另起一条。
 */
export function makeFlowCardSync(
  deps: FlowCardSyncDeps,
): (roomId: string, flow: Record<string, unknown> | undefined) => void {
  const cards = new Map<string, TrackedCard>();

  const emit = (roomId: string, c: { rowId: number; at: number }, text: string) => {
    deps.broadcast("room.process", {
      roomId,
      entry: { id: c.rowId, at: c.at, kind: "flow", author: "", text },
    });
  };

  const finalize = (roomId: string, c: TrackedCard): void => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(c.text) as Record<string, unknown>;
    } catch {
      /* keep */
    }
    meta.phase = meta.phase === "done" ? "done" : "cancelled";
    meta.finishedAt = Date.now();
    const text = JSON.stringify(meta);
    if (text !== c.text) {
      deps.store.updateEntry(c.rowId, text);
      emit(roomId, c, text);
    }
    cards.delete(roomId);
  };

  return (roomId, flow) => {
    const tracked = cards.get(roomId);
    const flowId = typeof flow?.flowId === "string" ? flow.flowId : "";

    if (!flow || !flowId) {
      if (tracked) finalize(roomId, tracked);
      return;
    }
    // 新一轮编排覆盖：旧卡先定稿再另起
    if (tracked && tracked.flowId !== flowId) finalize(roomId, tracked);

    const room = deps.rooms.get(roomId);
    const text = JSON.stringify(toCardSnapshot(flow, room?.mode ?? ""));
    const hash = createHash("sha1").update(text, "utf8").digest("hex");
    const at =
      typeof flow.startedAt === "number" && flow.startedAt > 0
        ? flow.startedAt
        : Date.now();

    const afterFinalize = cards.get(roomId);
    if (afterFinalize && afterFinalize.flowId === flowId) {
      if (hash === afterFinalize.hash) return;
      deps.store.updateEntry(afterFinalize.rowId, text);
      cards.set(roomId, { ...afterFinalize, hash, text });
      emit(roomId, afterFinalize, text);
      return;
    }

    // 重启恢复：Flow 已带 cardRowId → 原位覆写；否则新建条目
    const restored = deps.cardRowId(roomId);
    if (restored !== undefined) {
      deps.store.updateEntry(restored, text);
      cards.set(roomId, { flowId, rowId: restored, hash, at, text });
      emit(roomId, { rowId: restored, at }, text);
      return;
    }
    const rowId = deps.store.append("room", roomId, {
      at,
      kind: "flow",
      author: "",
      text,
    });
    if (rowId < 0) return;
    deps.setCardRowId(roomId, rowId);
    cards.set(roomId, { flowId, rowId, hash, at, text });
    emit(roomId, { rowId, at }, text);
  };
}
