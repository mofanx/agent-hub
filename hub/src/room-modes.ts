import { randomUUID } from "node:crypto";
import type { ArtifactKind, Room, RoomManager, RoomMode } from "./room.js";
import { ConductorOrchestrator, extractTaskResult, parseTasks, resolveMemberByString } from "./conductor.js";
import { logError, logWarn } from "./logger.js";

export type PromptContent = Array<Record<string, unknown>>;

export interface AgentOps {
  prompt(sessionId: string, content: string | PromptContent): Promise<void>;
  isBusy(sessionId: string): boolean;
  cancel(sessionId: string): Promise<void>;
}

type ConductorNotice = { roomId: string; message: string };
type ModeSelectedEvent = {
  roomId: string;
  mode: RuntimeMode;
  activeSpeaker?: string | undefined;
  reason?: string | undefined;
};

export type ModeResult = {
  sent: string[];
  mentioned: string[];
  skipped: string[];
};

type PromptOptions = {
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  content?: PromptContent | undefined;
  sessionNote?: ((sessionId: string) => string | undefined) | undefined;
  params?: Record<string, unknown> | undefined;
  artifactContext?: { taskId?: string; dependsOn?: string[]; refs?: string[] } | undefined;
};

export function parseTaskCommand(
  text: string,
): { to: string; task: string; id: string; dependsOn: string[] }[] | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/task")) return undefined;
  const after = trimmed.slice("/task".length).trimStart();
  if (!after) return [];
  const segments = after.split(/[;；\n]+/);
  const tasks: { to: string; task: string; id: string; dependsOn: string[] }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!.trim();
    if (!seg) continue;
    const match = seg.match(/^@([^\s;；\n]+)\s+([\s\S]*)/);
    if (!match) continue;
    const to = match[1]!.trim();
    let raw = match[2]!.trim();
    const depends: string[] = [];
    const depMatch = raw.match(/\((?:depends|dependsOn):\s*([^)]+)\)/i);
    if (depMatch) {
      const depIds = depMatch[1]!
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      depends.push(...depIds);
      raw = raw.replace(depMatch[0], "").trim();
    }
    tasks.push({ to, task: raw, id: `t${i + 1}`, dependsOn: depends });
  }
  return tasks.length > 0 ? tasks : [];
}

type AutoDecisionContext = PromptOptions & {
  roomId: string;
  text: string;
};

/** 运行时的模式（含 self 和 deciding，这两种不持久化到 Room.mode） */
type RuntimeMode = RoomMode | "self" | "deciding";

/** 主持人决策可输出的模式（不能再次选 auto，也不能输出 deciding） */
type AutoDecisionMode = Exclude<RuntimeMode, "auto" | "deciding">;

type AutoDecision = {
  mode: AutoDecisionMode;
  reason: string;
  params?: Record<string, unknown>;
};

type ParallelFlow = {
  pending: Set<string>;
  results: Map<string, string>;
  summarizer?: string | undefined;
  topic: string;
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  content?: PromptContent | undefined;
  artifactContext?: PromptOptions["artifactContext"];
};

type PipelineFlow = {
  order: string[];
  stage: number;
  outputs: string[];
  topic: string;
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  content?: PromptContent | undefined;
  artifactContext?: PromptOptions["artifactContext"];
};

type DebateOutput = {
  round: number;
  side: number;
  text: string;
};

type DebateFlow = {
  sides: [string, string];
  judge: string;
  rounds: number;
  currentRound: number;
  sideIndex: number;
  topic: string;
  outputs: DebateOutput[];
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  content?: PromptContent | undefined;
  artifactContext?: PromptOptions["artifactContext"];
};

const MODE_LABELS: Record<RuntimeMode, string> = {
  mention: "点名应答",
  conductor: "指挥家编排",
  roundrobin: "轮询",
  parallel: "并行/集思广益",
  pipeline: "流水线",
  debate: "辩论/评审",
  auto: "自动",
  self: "主持人独立作答",
  deciding: "决策中",
};

export class RoomModeManager {
  private conductor: ConductorOrchestrator;
  private autoDecisions = new Map<string, AutoDecisionContext>();
  private parallelFlows = new Map<string, ParallelFlow>();
  private pipelineFlows = new Map<string, PipelineFlow>();
  private debateFlows = new Map<string, DebateFlow>();
  private roomSubMode = new Map<string, { mode: RuntimeMode; activeSpeaker?: string | undefined; reason?: string | undefined }>();
  private promptRooms = new Map<string, string>();
  private autoHistory = new Map<string, { at: number; mode: string; reason: string; accepted?: boolean }[]>();
  private lastAuto = new Map<string, { at: number }>();

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly broadcast: (method: string, params: Record<string, unknown>) => void,
  ) {
    this.conductor = new ConductorOrchestrator(agent, rooms, (n) => this.notice(n));
  }

  exportRuntime(): Record<string, unknown> {
    return {
      conductor: this.conductor.export(),
      subModes: Object.fromEntries(this.roomSubMode),
    };
  }

  async importRuntime(state: Record<string, unknown> | undefined): Promise<void> {
    if (!state) return;
    const conductorState = typeof state.conductor === "object" && state.conductor !== null
      ? (state.conductor as Record<string, unknown>)
      : undefined;
    if (conductorState) await this.conductor.import(conductorState);
    const subModes = typeof state.subModes === "object" && state.subModes !== null
      ? (state.subModes as Record<string, { mode: RuntimeMode; activeSpeaker?: string; reason?: string }>)
      : undefined;
    if (subModes) {
      for (const [roomId, sm] of Object.entries(subModes)) {
        this.roomSubMode.set(roomId, { mode: sm.mode, activeSpeaker: sm.activeSpeaker, reason: sm.reason });
      }
    }
  }

  private notice(n: ConductorNotice): void {
    this.broadcast("room.notice", n as unknown as Record<string, unknown>);
  }

  private sendPrompt(roomId: string, sessionId: string, content: string | PromptContent): Promise<void> {
    this.promptRooms.set(sessionId, roomId);
    return this.agent.prompt(sessionId, content);
  }

  private captureArtifacts(sessionId: string, output: string, taskId?: string): void {
    const roomId = this.promptRooms.get(sessionId);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.promptRooms.delete(sessionId);
      return;
    }
    const name = room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
    const result = extractTaskResult(output);
    for (const a of result.artifacts) {
      this.rooms.addArtifact(roomId, {
        kind: a.type as ArtifactKind,
        action: a.action,
        author: name,
        summary: a.summary,
        path: a.path,
        content: a.content,
        taskId,
      });
    }
    this.promptRooms.delete(sessionId);
  }

  private emitModeSelected(e: ModeSelectedEvent): void {
    this.broadcast("room.modeSelected", e as unknown as Record<string, unknown>);
  }

  private emitFlowUpdate(roomId: string): void {
    const flow = this.getFlow(roomId);
    this.broadcast("room.flowUpdate", { roomId, flow });
  }

  getFlow(roomId: string): Record<string, unknown> | undefined {
    return this.conductor.getFlow(roomId) ?? this.parallelFlowView(roomId) ?? this.pipelineFlowView(roomId) ?? this.debateFlowView(roomId);
  }

  private parallelFlowView(roomId: string): Record<string, unknown> | undefined {
    const flow = this.parallelFlows.get(roomId);
    if (!flow) return undefined;
    const room = this.rooms.get(roomId);
    const tasks = [...flow.pending].map((sid) => ({
      id: sid,
      sessionId: sid,
      name: room?.members.find((m) => m.sessionId === sid)?.name ?? sid,
      status: flow.results.has(sid) ? "done" : this.agent.isBusy(sid) ? "running" : "pending",
      task: flow.topic,
      dependsOn: [] as string[],
      artifacts: [] as { type: string; path?: string; summary: string }[],
    }));
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    return {
      roomId,
      phase: running > 0 ? "working" : done === tasks.length ? "summarizing" : "working",
      progress: { done, running, pending, failed: 0, total: tasks.length },
      tasks,
    };
  }

  private pipelineFlowView(roomId: string): Record<string, unknown> | undefined {
    const flow = this.pipelineFlows.get(roomId);
    if (!flow) return undefined;
    const room = this.rooms.get(roomId);
    const tasks = flow.order.map((sid, i) => {
      const isDone = i < flow.stage;
      const isCurrent = i === flow.stage;
      return {
        id: `p${i + 1}`,
        sessionId: sid,
        name: room?.members.find((m) => m.sessionId === sid)?.name ?? sid,
        status: isDone ? "done" : isCurrent ? (this.agent.isBusy(sid) ? "running" : "pending") : "pending",
        task: isCurrent ? flow.topic : (isDone ? `已完成：${flow.outputs[i]?.slice(0, 80) ?? ""}` : `等待前序完成`),
        dependsOn: i > 0 ? [`p${i}`] : [],
        artifacts: [] as { type: string; path?: string; summary: string }[],
      };
    });
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    return {
      roomId,
      phase: flow.stage >= flow.order.length ? "summarizing" : "working",
      progress: { done, running, pending, failed: 0, total: tasks.length },
      tasks,
    };
  }

  private debateFlowView(roomId: string): Record<string, unknown> | undefined {
    const flow = this.debateFlows.get(roomId);
    if (!flow) return undefined;
    const room = this.rooms.get(roomId);
    const total = flow.rounds * flow.sides.length;
    const completed = flow.outputs.length;
    const tasks: Record<string, unknown>[] = [];
    for (let i = 0; i < total; i++) {
      const round = Math.floor(i / 2) + 1;
      const side = i % 2;
      const sid = flow.sides[side];
      if (!sid) continue;
      const output = flow.outputs.find((o) => o.round === round && o.side === side);
      const isCurrent = i === completed;
      tasks.push({
        id: `r${round}s${side + 1}`,
        sessionId: sid,
        name: room?.members.find((m) => m.sessionId === sid)?.name ?? sid,
        status: output ? "done" : isCurrent ? (this.agent.isBusy(sid) ? "running" : "pending") : "pending",
        task: `${flow.topic}（第 ${round}/${flow.rounds} 轮 · ${side === 0 ? "正方" : "反方"}）`,
        dependsOn: [] as string[],
        artifacts: [] as { type: string; path?: string; summary: string }[],
      });
    }
    tasks.push({
      id: "judge",
      sessionId: flow.judge,
      name: room?.members.find((m) => m.sessionId === flow.judge)?.name ?? flow.judge,
      status: completed >= total ? (this.agent.isBusy(flow.judge) ? "running" : "pending") : "pending",
      task: `裁判总结：${flow.topic}`,
      dependsOn: flow.sides.map((_, i) => `r${flow.rounds}s${i + 1}`),
      artifacts: [] as { type: string; path?: string; summary: string }[],
    });
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    return {
      roomId,
      phase: completed >= total ? "summarizing" : "working",
      progress: { done, running, pending, failed: 0, total: tasks.length },
      tasks,
    };
  }

  /** 当前房间是否有进行中的编排流 */
  hasActiveFlow(roomId: string): boolean {
    if (this.conductor.hasActiveFlow(roomId)) return true;
    if (this.parallelFlows.has(roomId)) return true;
    if (this.pipelineFlows.has(roomId)) return true;
    if (this.debateFlows.has(roomId)) return true;
    if (this.autoDecisions.has(this.hostFor(roomId))) return true;
    return false;
  }

  /** 取消当前房间的所有活动流 */
  async cancelActive(roomId: string, reason?: string): Promise<void> {
    const room = this.rooms.get(roomId);
    const toCancel = new Set<string>();
    const touched = this.conductor.cancel(roomId, reason);
    for (const sid of touched) toCancel.add(sid);
    const pFlow = this.parallelFlows.get(roomId);
    if (pFlow) for (const sid of pFlow.pending) toCancel.add(sid);
    const pipe = this.pipelineFlows.get(roomId);
    if (pipe) toCancel.add(pipe.order[pipe.stage]!);
    const debate = this.debateFlows.get(roomId);
    if (debate) {
      toCancel.add(debate.sides[debate.sideIndex]!);
      toCancel.add(debate.judge);
    }
    this.parallelFlows.delete(roomId);
    this.pipelineFlows.delete(roomId);
    this.debateFlows.delete(roomId);
    this.roomSubMode.delete(roomId);
    const host = this.hostFor(roomId);
    if (this.autoDecisions.has(host)) {
      this.autoDecisions.delete(host);
      toCancel.add(host);
    }
    if (room?.conductorId && (touched.length > 0 || this.agent.isBusy(room.conductorId))) {
      toCancel.add(room.conductorId);
    }
    for (const sid of toCancel) {
      if (this.agent.isBusy(sid)) {
        try {
          await this.agent.cancel(sid);
        } catch {
          /* ignore */
        }
      }
    }
    this.emitFlowUpdate(roomId);
  }

  /** 处理一条新的房间消息 */
  async handle(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    await this.cancelActive(room.roomId, "收到新消息，当前流程已取消");

    const last = this.lastAuto.get(room.roomId);
    if (last) {
      this.lastAuto.delete(room.roomId);
      const accepted = room.mode === "auto";
      const entries = this.autoHistory.get(room.roomId);
      const entry = entries?.find((e) => e.at === last.at);
      if (entry) entry.accepted = accepted;
    }

    const refs = this.rooms.parseArtifactRefs(room.roomId, text);
    const artifactContext = refs.length > 0
      ? { ...(options?.artifactContext ?? {}), refs: [...new Set([...(options?.artifactContext?.refs ?? []), ...refs])] }
      : options?.artifactContext;
    const mergedOptions: PromptOptions = { ...options, artifactContext };

    if (room.mode === "auto") {
      const result = await this.handleAuto(room, text, mergedOptions);
      this.emitFlowUpdate(room.roomId);
      return result;
    }

    this.setSubMode(room.roomId, room.mode, undefined, undefined);
    const result = await this.executeMode(room, room.mode, text, mergedOptions);
    this.emitFlowUpdate(room.roomId);
    return result;
  }

  /** prompt 完成时的回调 */
  async onPromptDone(sessionId: string, output: string): Promise<boolean> {
    // auto 决策完成
    const autoCtx = this.autoDecisions.get(sessionId);
    if (autoCtx) {
      this.autoDecisions.delete(sessionId);
      this.promptRooms.delete(sessionId);
      const room = this.rooms.get(autoCtx.roomId);
      if (!room) {
        logWarn("room-modes auto", `auto 决策完成但房间不存在：${autoCtx.roomId}`);
        return true;
      }
      const decision = this.parseAutoDecision(output);
      const at = Date.now();
      const list = this.autoHistory.get(room.roomId) ?? [];
      list.push({ at, mode: decision.mode, reason: decision.reason });
      if (list.length > 50) list.shift();
      this.autoHistory.set(room.roomId, list);
      this.lastAuto.set(room.roomId, { at });
      const label = MODE_LABELS[decision.mode] ?? decision.mode;
      logWarn("room-modes auto", `解析决策：mode=${decision.mode}，reason=${decision.reason}`);
      this.setSubMode(room.roomId, decision.mode, this.activeSpeakerFor(room, decision.mode, decision.params), decision.reason);
      this.notice({
        roomId: room.roomId,
        message: `🎛️ 本轮自动选择：${label}${decision.reason ? ` —— ${decision.reason}` : ""}`,
      });
      const result = await this.executeMode(room, decision.mode, autoCtx.text, {
        note: autoCtx.note,
        quote: autoCtx.quote,
        content: autoCtx.content,
        sessionNote: autoCtx.sessionNote,
        params: decision.params,
        artifactContext: autoCtx.artifactContext,
      });
      logWarn("room-modes auto", `executeMode 完成：sent=[${result.sent.join(", ")}]，skipped=[${result.skipped.join(", ")}]`);
      this.emitFlowUpdate(room.roomId);
      return true;
    }

    // conductor 编排
    const conductorRoom = await this.conductor.onPromptDone(sessionId, output);
    if (conductorRoom) {
      this.emitFlowUpdate(conductorRoom);
      return true;
    }

    // 其他流程
    const parallelRoom = this.onParallelDone(sessionId, output);
    if (parallelRoom) {
      this.emitFlowUpdate(parallelRoom);
      return true;
    }
    const pipelineRoom = this.onPipelineDone(sessionId, output);
    if (pipelineRoom) {
      this.emitFlowUpdate(pipelineRoom);
      return true;
    }
    const debateRoom = this.onDebateDone(sessionId, output);
    if (debateRoom) {
      this.emitFlowUpdate(debateRoom);
      return true;
    }

    // mention / 普通点名 / 汇总者等：统一提取 artifact 写入房间 registry
    this.captureArtifacts(sessionId, output);
    return false;
  }

  /** prompt 异常/取消时的回调 */
  onPromptError(sessionId: string): boolean {
    const autoCtx = this.autoDecisions.get(sessionId);
    if (autoCtx) {
      this.autoDecisions.delete(sessionId);
      this.promptRooms.delete(sessionId);
      const room = this.rooms.get(autoCtx.roomId);
      if (room) {
        this.notice({ roomId: room.roomId, message: "🎛️ 主持人决策失败，已兜底为点名应答" });
        this.setSubMode(room.roomId, "mention", undefined, undefined);
        void this.executeMode(room, "mention", autoCtx.text, {
          note: autoCtx.note,
          quote: autoCtx.quote,
          content: autoCtx.content,
          sessionNote: autoCtx.sessionNote,
          artifactContext: autoCtx.artifactContext,
        });
      }
      this.emitFlowUpdate(autoCtx.roomId);
      return true;
    }

    const conductorRoom = this.conductor.onPromptError(sessionId);
    if (conductorRoom) {
      this.emitFlowUpdate(conductorRoom);
      return true;
    }

    for (const [roomId, flow] of this.parallelFlows) {
      if (flow.pending.has(sessionId)) {
        flow.pending.delete(sessionId);
        this.notice({
          roomId,
          message: `@${this.nameFor(roomId, sessionId)} 并行回答中断`,
        });
        if (flow.pending.size === 0) this.summarizeParallel(roomId, flow);
        this.emitFlowUpdate(roomId);
        return true;
      }
    }

    for (const [roomId, flow] of this.pipelineFlows) {
      if (flow.order[flow.stage] === sessionId) {
        this.pipelineFlows.delete(roomId);
        this.setSubMode(roomId, "pipeline", undefined, undefined);
        this.notice({ roomId, message: `流水线第 ${flow.stage + 1} 阶段中断` });
        this.emitFlowUpdate(roomId);
        return true;
      }
    }

    for (const [roomId, flow] of this.debateFlows) {
      if (flow.sides.includes(sessionId) || flow.judge === sessionId) {
        this.debateFlows.delete(roomId);
        this.setSubMode(roomId, "debate", undefined, undefined);
        this.notice({ roomId, message: "辩论流程中断" });
        this.emitFlowUpdate(roomId);
        return true;
      }
    }

    this.promptRooms.delete(sessionId);
    return false;
  }

  /** 用于 onTurnEnd：某 session 的输出是否需要写入房间历史 */
  isHiddenTurn(sessionId: string, roomId: string): boolean {
    const sub = this.roomSubMode.get(roomId);
    if (sub?.mode === "deciding" && sub.activeSpeaker === sessionId) return true;
    const flow = this.conductor.getFlowForSession(sessionId);
    if (flow && flow.roomId === roomId) {
      if (flow.role === "worker") return true;
      if (flow.role === "conductor" && flow.phase !== "summarizing") return true;
    }
    return false;
  }

  /** 用于 prompt.done 跳过广播：是否是内部工作输出 */
  isHiddenSession(sessionId: string): boolean {
    if (this.autoDecisions.has(sessionId)) return true;
    const flow = this.conductor.getFlowForSession(sessionId);
    if (flow) {
      if (flow.role === "worker") return true;
      if (flow.role === "conductor" && flow.phase !== "summarizing") return true;
    }
    return false;
  }

  /** 用于 room.list 返回当前房间的子模式和当前发言人 */
  subModeFor(roomId: string): { mode: RuntimeMode; activeSpeaker?: string | undefined; reason?: string | undefined } | undefined {
    return this.roomSubMode.get(roomId);
  }

  private setSubMode(
    roomId: string,
    mode: RuntimeMode,
    activeSpeaker?: string | undefined,
    reason?: string | undefined,
  ): void {
    this.roomSubMode.set(roomId, { mode, activeSpeaker, reason });
    this.emitModeSelected({ roomId, mode, activeSpeaker, reason });
  }

  private hostFor(roomId: string): string {
    return this.rooms.get(roomId)?.conductorId ?? "";
  }

  private activeSpeakerFor(
    room: Room,
    mode: RuntimeMode,
    params?: Record<string, unknown>,
  ): string | undefined {
    switch (mode) {
      case "conductor":
      case "self":
        return room.conductorId;
      case "roundrobin":
        return typeof params?.speaker === "string" ? (params.speaker as string) : undefined;
      case "parallel":
        return typeof params?.summarizer === "string"
          ? (params.summarizer as string)
          : room.parallelSummarizerId ?? room.conductorId;
      case "pipeline":
        return this.pipelineOrder(room, params)[0] ?? room.members[0]?.sessionId;
      case "debate":
        return this.debateSides(room, params)[0] ?? room.members[0]?.sessionId;
      case "mention":
      default:
        return undefined;
    }
  }

  private async executeMode(
    room: Room,
    mode: RuntimeMode,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    switch (mode) {
      case "mention":
        return this.handleMention(room, text, options);
      case "conductor":
        return this.handleConductor(room, text, options);
      case "roundrobin":
        return this.handleRoundRobin(room, text, options);
      case "parallel":
        return this.handleParallel(room, text, options);
      case "pipeline":
        return this.handlePipeline(room, text, options);
      case "debate":
        return this.handleDebate(room, text, options);
      case "self":
        return this.handleSelf(room, text, options);
      default:
        return this.handleMention(room, text, options);
    }
  }

  private splitMentionTasks(room: Room, text: string, targets: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const sid of targets) {
      const name = room.members.find((m) => m.sessionId === sid)?.name;
      if (!name) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`@${escaped}(?![\\w-])`);
      const match = re.exec(text);
      if (!match) continue;
      const start = match.index + match[0].length;
      const rest = text.slice(start);
      const end = rest.search(/[@；;\n]|$/);
      const task = rest.slice(0, end).trim();
      if (task) result[sid] = task;
    }
    return result;
  }

  private async handleMention(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    const paramsTargets = Array.isArray(options?.params?.targets)
      ? (options.params.targets as unknown[]).map((s) => String(s)).filter((sid) =>
          room.members.some((m) => m.sessionId === sid)
        )
      : [];
    const { targets, mentioned } = paramsTargets.length > 0
      ? { targets: paramsTargets, mentioned: [] }
      : this.rooms.route(room.roomId, text);
    const segments = this.splitMentionTasks(room, text, targets);
    const sent: string[] = [];
    const skipped: string[] = [];
    for (const sid of targets) {
      if (this.agent.isBusy(sid)) {
        skipped.push(sid);
        continue;
      }
      const prompt = this.buildPromptContent(room, segments[sid] ?? text, sid, options);
      this.sendPrompt(room.roomId, sid, prompt).catch((err) => {
        logError("room-modes mention prompt", err);
      });
      sent.push(sid);
    }
    return { sent, mentioned, skipped };
  }

  private async handleConductor(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    if (!room.conductorId) {
      this.notice({ roomId: room.roomId, message: "指挥家模式未指定主持人，已兜底为点名应答" });
      return this.handleMention(room, text, options);
    }
    if (this.agent.isBusy(room.conductorId)) {
      this.notice({ roomId: room.roomId, message: `主持人 @${this.nameFor(room.roomId, room.conductorId)} 忙碌中` });
      return { sent: [], mentioned: [], skipped: [room.conductorId] };
    }
    this.setSubMode(room.roomId, "conductor", room.conductorId, undefined);

    const paramTasks = Array.isArray(options?.params?.tasks)
      ? (options.params.tasks as unknown[])
          .map((t) => {
            const o = t as Record<string, unknown>;
            if (typeof o.to !== "string" || typeof o.task !== "string") return null;
            const result: { to: string; task: string; id?: string; dependsOn?: string[] } = {
              to: o.to,
              task: o.task,
            };
            if (typeof o.id === "string") result.id = o.id;
            if (Array.isArray(o.dependsOn)) {
              result.dependsOn = o.dependsOn.map((s) => String(s)).filter(Boolean);
            }
            return result;
          })
          .filter((t) => t !== null) as { to: string; task: string; id?: string; dependsOn?: string[] }[]
      : undefined;

    const jsonTasks = parseTasks(text, room) ?? [];
    const commandTasks = parseTaskCommand(text) ?? [];
    const initialTasks =
      paramTasks?.length ? paramTasks : jsonTasks.length ? jsonTasks : (commandTasks.length ? commandTasks : undefined);

    let task = text;
    if (options?.note) task = `${options.note}\n\n${task}`;
    if (options?.quote) {
      task = `${task}\n（用户引用了 ${options.quote.author} 的消息："${options.quote.text}"）`;
    }

    if (initialTasks && initialTasks.length > 0) {
      const sent = new Set<string>();
      const skipped: string[] = [];
      for (const t of initialTasks) {
        const m = resolveMemberByString(room, t.to);
        if (m) sent.add(m.sessionId);
        else skipped.push(t.to);
      }
      this.conductor.start(room, task, initialTasks, options?.artifactContext).catch((err) => {
        logError("room-modes conductor start", err);
      });
      return { sent: [...sent], mentioned: [], skipped };
    }

    this.conductor.start(room, task, undefined, options?.artifactContext).catch((err) => {
      logError("room-modes conductor start", err);
    });
    return { sent: [room.conductorId], mentioned: [], skipped: [] };
  }


  private async handleRoundRobin(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    const members = room.members;
    if (members.length === 0) return { sent: [], mentioned: [], skipped: [] };
    const preferred = typeof options?.params?.speaker === "string" ? (options.params.speaker as string) : undefined;
    let idx = room.roundRobinIndex ?? 0;
    let target: string | undefined;
    const skipped: string[] = [];
    if (preferred && members.some((m) => m.sessionId === preferred) && !this.agent.isBusy(preferred)) {
      target = preferred;
      const pos = members.findIndex((m) => m.sessionId === preferred);
      if (pos >= 0) idx = (pos + 1) % members.length;
    } else {
      for (let i = 0; i < members.length; i++) {
        const j = (idx + i) % members.length;
        const sid = members[j]!.sessionId;
        if (this.agent.isBusy(sid)) {
          skipped.push(sid);
          continue;
        }
        target = sid;
        idx = (j + 1) % members.length;
        break;
      }
    }
    if (!target) {
      this.notice({ roomId: room.roomId, message: "轮询模式：所有成员均忙碌" });
      return { sent: [], mentioned: [], skipped: members.map((m) => m.sessionId) };
    }
    room.roundRobinIndex = idx;
    this.setSubMode(room.roomId, "roundrobin", target, undefined);
    this.notice({ roomId: room.roomId, message: `🔄 轮询模式：由 @${this.nameFor(room.roomId, target)} 作答` });
    const prompt = this.buildPromptContent(room, text, target, options);
    this.sendPrompt(room.roomId, target, prompt).catch((err) => {
      logError("room-modes roundrobin prompt", err);
    });
    return { sent: [target], mentioned: [], skipped };
  }

  private async handleParallel(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    const rawTargets = Array.isArray(options?.params?.targets)
      ? (options.params.targets as unknown[]).map((s) => String(s))
      : [];
    const members = rawTargets.length > 0
      ? room.members.filter((m) => rawTargets.includes(m.sessionId))
      : room.members;
    const summarizer =
      (typeof options?.params?.summarizer === "string" ? (options.params.summarizer as string) : undefined) ??
      room.parallelSummarizerId ??
      room.conductorId;
    const sent: string[] = [];
    const skipped: string[] = [];
    const pending = new Set<string>();
    for (const m of members) {
      if (this.agent.isBusy(m.sessionId)) {
        skipped.push(m.sessionId);
      } else {
        pending.add(m.sessionId);
        sent.push(m.sessionId);
      }
    }
    if (pending.size === 0) {
      this.notice({ roomId: room.roomId, message: "并行模式：所有成员均忙碌" });
      return { sent, mentioned: [], skipped };
    }
    const flow: ParallelFlow = {
      pending,
      results: new Map(),
      summarizer,
      topic: text,
      note: options?.note,
      quote: options?.quote,
      content: options?.content,
      artifactContext: options?.artifactContext,
    };
    this.parallelFlows.set(room.roomId, flow);
    this.setSubMode(room.roomId, "parallel", summarizer, undefined);
    for (const sid of sent) {
      const prompt = this.buildPromptContent(room, text, sid, options);
      this.sendPrompt(room.roomId, sid, prompt).catch((err) => {
        logError("room-modes parallel prompt", err);
        const f = this.parallelFlows.get(room.roomId);
        if (!f) return;
        f.pending.delete(sid);
        if (f.pending.size === 0) this.summarizeParallel(room.roomId, f);
      });
    }
    const names = members.map((m) => `@${m.name}`).join("、");
    const sName = summarizer ? this.nameFor(room.roomId, summarizer) : "无";
    this.notice({ roomId: room.roomId, message: `⚡ 并行模式：已询问 ${names}，汇总者 @${sName}` });
    return { sent, mentioned: [], skipped };
  }

  private onParallelDone(sessionId: string, output: string): string | undefined {
    for (const [roomId, flow] of this.parallelFlows) {
      if (!flow.pending.has(sessionId)) continue;
      flow.pending.delete(sessionId);
      flow.results.set(sessionId, output);
      this.captureArtifacts(sessionId, output);
      if (flow.pending.size === 0) {
        this.summarizeParallel(roomId, flow);
      }
      return roomId;
    }
    return undefined;
  }

  private summarizeParallel(roomId: string, flow: ParallelFlow): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.parallelFlows.delete(roomId);
      return;
    }
    this.setSubMode(roomId, "parallel", flow.summarizer, undefined);
    if (!flow.summarizer || !room.members.some((m) => m.sessionId === flow.summarizer)) {
      this.parallelFlows.delete(roomId);
      this.notice({ roomId, message: "并行模式：所有成员已完成回答" });
      return;
    }
    const lines = [...flow.results.entries()].map(([sid, out]) => {
      return `- @${this.nameFor(roomId, sid)}: ${out.trim().replace(/\s+/g, " ").slice(0, 400)}`;
    });
    const promptText = `你是群聊「${room.name}」的汇总者。多位成员就同一问题给出了独立回答：\n${lines.join("\n")}\n\n请综合以上观点，给用户一个清晰、全面的最终回答。`;
    const prompt = this.buildPromptContent(room, promptText, flow.summarizer, { artifactContext: flow.artifactContext });
    this.parallelFlows.delete(roomId);
    this.notice({ roomId, message: "并行回答完成，汇总者正在整理…" });
    this.sendPrompt(room.roomId, flow.summarizer, prompt).catch((err) => {
      logError("room-modes parallel summarize", err);
    });
  }

  private async handlePipeline(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    const order = this.pipelineOrder(room, options?.params);
    if (order.length === 0) {
      this.notice({ roomId: room.roomId, message: "流水线模式：没有可执行的成员" });
      return { sent: [], mentioned: [], skipped: [] };
    }
    const first = order[0]!;
    if (this.agent.isBusy(first)) {
      this.notice({ roomId: room.roomId, message: `流水线模式：首阶段 @${this.nameFor(room.roomId, first)} 忙碌` });
      return { sent: [], mentioned: [], skipped: [first] };
    }
    const flow: PipelineFlow = {
      order,
      stage: 0,
      outputs: [],
      topic: text,
      note: options?.note,
      quote: options?.quote,
      content: options?.content,
      artifactContext: options?.artifactContext,
    };
    this.pipelineFlows.set(room.roomId, flow);
    this.setSubMode(room.roomId, "pipeline", first, undefined);
    const path = order.map((sid) => `@${this.nameFor(room.roomId, sid)}`).join(" → ");
    this.notice({ roomId: room.roomId, message: `🔄 流水线模式：${path}` });
    const prompt = this.buildPipelinePrompt(room, flow, 0);
    this.sendPrompt(room.roomId, first, prompt).catch((err) => {
      logError("room-modes pipeline prompt", err);
    });
    return { sent: [first], mentioned: [], skipped: [] };
  }

  private onPipelineDone(sessionId: string, output: string): string | undefined {
    for (const [roomId, flow] of this.pipelineFlows) {
      if (flow.order[flow.stage] !== sessionId) continue;
      const room = this.rooms.get(roomId);
      if (!room) {
        this.pipelineFlows.delete(roomId);
        return roomId;
      }
      flow.outputs.push(output);
      this.captureArtifacts(sessionId, output);
      const nextStage = flow.stage + 1;
      if (nextStage >= flow.order.length) {
        this.pipelineFlows.delete(roomId);
        this.setSubMode(roomId, "pipeline", undefined, undefined);
        this.notice({ roomId, message: "流水线模式：全部阶段完成" });
        return roomId;
      }
      const prevName = this.nameFor(roomId, flow.order[flow.stage]!);
      flow.stage = nextStage;
      const nextSid = flow.order[nextStage]!;
      this.setSubMode(roomId, "pipeline", nextSid, undefined);
      this.notice({ roomId, message: `流水线第 ${nextStage + 1} 阶段 → @${this.nameFor(roomId, nextSid)}` });
      const prompt = this.buildPipelinePrompt(room, flow, nextStage, prevName, output);
      this.sendPrompt(room.roomId, nextSid, prompt).catch((err) => {
        logError("room-modes pipeline next stage", err);
      });
      return roomId;
    }
    return undefined;
  }

  private buildPipelinePrompt(
    room: Room,
    flow: PipelineFlow,
    stage: number,
    prevName?: string,
    prevOutput?: string,
  ): string | PromptContent {
    let task = flow.topic;
    if (flow.note && stage === 0) task = `${flow.note}\n\n${task}`;
    let quote = flow.quote;
    if (prevName && prevOutput !== undefined) {
      quote = { author: prevName, text: prevOutput };
      task = `请继续下一阶段处理原始任务：${task}`;
    }
    return this.buildPromptContent(room, task, flow.order[stage]!, { quote, content: flow.content, artifactContext: flow.artifactContext });
  }

  private async handleDebate(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    const [sideA, sideB] = this.debateSides(room, options?.params);
    const judge =
      (typeof options?.params?.judge === "string" ? (options.params.judge as string) : undefined) ??
      room.debateJudge ??
      room.conductorId ??
      room.members[0]?.sessionId;
    const rounds = Math.max(
      1,
      Math.min(
        5,
        typeof options?.params?.rounds === "number"
          ? (options.params.rounds as number)
          : room.debateRounds ?? 2,
      ),
    );
    if (!sideA || !sideB) {
      this.notice({ roomId: room.roomId, message: "辩论模式：成员不足，无法分配正反方" });
      return { sent: [], mentioned: [], skipped: [] };
    }
    if (this.agent.isBusy(sideA)) {
      this.notice({ roomId: room.roomId, message: `辩论模式：正方 @${this.nameFor(room.roomId, sideA)} 忙碌中` });
      return { sent: [], mentioned: [], skipped: [sideA] };
    }
    const flow: DebateFlow = {
      sides: [sideA, sideB],
      judge: judge ?? sideA,
      rounds,
      currentRound: 1,
      sideIndex: 0,
      topic: text,
      outputs: [],
      note: options?.note,
      quote: options?.quote,
      content: options?.content,
      artifactContext: options?.artifactContext,
    };
    this.debateFlows.set(room.roomId, flow);
    this.setSubMode(room.roomId, "debate", sideA, undefined);
    this.notice({
      roomId: room.roomId,
      message: `⚔️ 辩论模式：正方 @${this.nameFor(room.roomId, sideA)} vs 反方 @${this.nameFor(
        room.roomId,
        sideB,
      )}，裁判 @${this.nameFor(room.roomId, flow.judge)}，共 ${rounds} 轮`,
    });
    const prompt = this.buildDebatePrompt(room, flow, 0, undefined);
    this.sendPrompt(room.roomId, sideA, prompt).catch((err) => {
      logError("room-modes debate prompt", err);
    });
    return { sent: [sideA], mentioned: [], skipped: [] };
  }

  private onDebateDone(sessionId: string, output: string): string | undefined {
    for (const [roomId, flow] of this.debateFlows) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.debateFlows.delete(roomId);
        return roomId;
      }
      const currentSid = flow.sides[flow.sideIndex]!;
      if (sessionId !== currentSid) continue;
      flow.outputs.push({ round: flow.currentRound, side: flow.sideIndex, text: output });
      this.captureArtifacts(sessionId, output);

      if (flow.sideIndex === 0) {
        flow.sideIndex = 1;
        const nextSid = flow.sides[1]!;
        this.setSubMode(roomId, "debate", nextSid, undefined);
        const prompt = this.buildDebatePrompt(room, flow, 1, output);
        this.sendPrompt(room.roomId, nextSid, prompt).catch((err) => {
          logError("room-modes debate next side", err);
        });
        return roomId;
      }

      if (flow.currentRound < flow.rounds) {
        flow.currentRound++;
        flow.sideIndex = 0;
        const nextSid = flow.sides[0]!;
        this.setSubMode(roomId, "debate", nextSid, undefined);
        const prompt = this.buildDebatePrompt(room, flow, 0, output);
        this.sendPrompt(room.roomId, nextSid, prompt).catch((err) => {
          logError("room-modes debate next round", err);
        });
        return roomId;
      }

      // 辩论结束，裁判总结
      this.debateFlows.delete(roomId);
      this.setSubMode(roomId, "debate", flow.judge, undefined);
      this.notice({ roomId, message: "辩论结束，裁判总结中…" });
      const judgePrompt = this.buildJudgePrompt(room, flow);
      this.sendPrompt(room.roomId, flow.judge, judgePrompt).catch((err) => {
        logError("room-modes judge prompt", err);
      });
      return roomId;
    }
    return undefined;
  }

  private buildDebatePrompt(
    room: Room,
    flow: DebateFlow,
    sideIndex: number,
    opponentOutput?: string,
  ): string | PromptContent {
    const position = sideIndex === 0 ? "正方" : "反方";
    const author = this.nameFor(room.roomId, flow.sides[sideIndex ^ 1]!);
    const quote = opponentOutput ? { author, text: opponentOutput } : flow.quote;
    const text = `这是辩论第 ${flow.currentRound}/${flow.rounds} 轮，你是${position}。请就辩题继续阐述观点${
      opponentOutput ? "并回应对方" : ""
    }。`;
    let task = `${text}\n\n辩题：${flow.topic}`;
    if (flow.note) task = `${flow.note}\n\n${task}`;
    return this.buildPromptContent(room, task, flow.sides[sideIndex]!, { quote, content: flow.content, artifactContext: flow.artifactContext });
  }

  private buildJudgePrompt(room: Room, flow: DebateFlow): string | PromptContent {
    const lines = flow.outputs.map((o) => {
      const side = o.side === 0 ? "正方" : "反方";
      return `- 第 ${o.round} 轮 ${side}：${o.text.trim().replace(/\s+/g, " ").slice(0, 400)}`;
    });
    const text = `你是辩论裁判。辩题：${flow.topic}\n\n辩论记录：\n${lines.join("\n")}\n\n请做出公正总结，指出共识与分歧，给出最终判断。`;
    return this.buildPromptContent(room, text, flow.judge, { artifactContext: flow.artifactContext });
  }

  private async handleSelf(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    if (!room.conductorId) {
      this.notice({ roomId: room.roomId, message: "自动模式未指定主持人，已兜底为点名应答" });
      return this.handleMention(room, text, options);
    }
    if (this.agent.isBusy(room.conductorId)) {
      this.notice({ roomId: room.roomId, message: `主持人 @${this.nameFor(room.roomId, room.conductorId)} 忙碌中` });
      return { sent: [], mentioned: [], skipped: [room.conductorId] };
    }
    this.setSubMode(room.roomId, "self", room.conductorId, undefined);
    this.notice({ roomId: room.roomId, message: `🎙️ 自动选择：主持人独立作答` });
    const selfNote = "本轮由你直接作答，请直接回复用户消息，不要输出任何 JSON 或模式选择。";
    const promptOptions: PromptOptions = {
      ...options,
      note: options?.note ? `${options.note}\n\n${selfNote}` : selfNote,
    };
    const prompt = this.buildPromptContent(room, text, room.conductorId, promptOptions);
    logWarn("room-modes self", `正在向主持人 ${room.conductorId} 发送 self 应答 prompt`);
    this.sendPrompt(room.roomId, room.conductorId, prompt).then(() => {
      logWarn("room-modes self", `主持人 ${room.conductorId} self 应答 prompt 已完成`);
    }).catch((err) => {
      logError("room-modes self prompt", err);
      this.notice({ roomId: room.roomId, message: `主持人独立作答启动失败：${err instanceof Error ? err.message : String(err)}` });
    });
    return { sent: [room.conductorId], mentioned: [], skipped: [] };
  }

  private async handleAuto(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    if (!room.conductorId) {
      this.notice({ roomId: room.roomId, message: "自动模式未指定主持人，已兜底为点名应答" });
      return this.handleMention(room, text, options);
    }
    if (this.agent.isBusy(room.conductorId)) {
      this.notice({ roomId: room.roomId, message: `主持人 @${this.nameFor(room.roomId, room.conductorId)} 忙碌中` });
      return { sent: [], mentioned: [], skipped: [room.conductorId] };
    }
    this.setSubMode(room.roomId, "deciding", room.conductorId, undefined);
    this.autoDecisions.set(room.conductorId, {
      roomId: room.roomId,
      text,
      note: options?.note,
      quote: options?.quote,
      content: options?.content,
      sessionNote: options?.sessionNote,
      artifactContext: options?.artifactContext,
    });
    const prompt = this.buildAutoPrompt(room, text, options);
    this.notice({ roomId: room.roomId, message: "🎛️ 自动模式：主持人正在决策…" });
    this.sendPrompt(room.roomId, room.conductorId, prompt).catch((err) => {
      logError("room-modes auto decision", err);
    });
    return { sent: [room.conductorId], mentioned: [], skipped: [] };
  }

  private formatAutoHistory(roomId: string): string {
    const list = this.autoHistory.get(roomId) ?? [];
    if (list.length === 0) return "";
    const decided = list.filter((e) => e.accepted !== undefined);
    const accepted = decided.filter((e) => e.accepted).length;
    const total = decided.length;
    const recent = list.slice(-5).map((e) => {
      const mark = e.accepted === true ? "✓" : e.accepted === false ? "✗" : "?";
      return `- ${mark} ${e.mode}: ${e.reason}`;
    }).join("\n");
    return `\n最近 auto 决策反馈：共 ${total} 条，被接受 ${accepted} 条，被覆盖 ${total - accepted} 条。\n${recent}\n`;
  }

  private buildAutoPrompt(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): string {
    const members = room.members.map((m) => `${m.name} (id: ${m.sessionId})`).join("、");
    const recent = this.rooms.getBlackboard(room.roomId);
    const boardText =
      recent.length > 0
        ? recent
            .slice(-5)
            .map((e) => `- ${e.from}: ${e.text}`)
            .join("\n")
        : "（暂无）";
    const quoteText = options?.quote
      ? `用户引用了 ${options.quote.author} 的消息："${options.quote.text}"\n`
      : "";
    const noteText = options?.note ? `注意：${options.note}\n` : "";
    const sessionNote = options?.sessionNote?.(room.conductorId!);
    const sessionNoteText = sessionNote ? `注意：${sessionNote}\n` : "";
    return [
      `你是群聊「${room.name}」的主持人。请根据用户消息和成员信息，选择本轮最合适的协作模式。`,
      `成员：${members}`,
      "",
      "可用模式及含义：",
      "- mention：用户明确@某人，或问题简单直接，应指定/全部成员独立回答",
      "- conductor：任务复杂，需要拆解成子任务并派工给不同成员",
      "- roundrobin：适合轮流发言、按顺序补充，每个问题一人作答",
      "- parallel：需要多个成员独立给出观点后汇总，适合集思广益",
      "- pipeline：任务需要按固定顺序串行处理，例如 编码 → 审查 → 测试",
      "- debate：需要对某一观点进行正反方辩论，最后由裁判总结",
      "- self：你自己就能直接回答，不需要其他成员",
      "",
      "输出要求：",
      "- 仅输出一个 JSON 对象，不要有任何解释文字、markdown 标题或代码块外的内容",
      "- 不要调用任何工具，仅做选择",
      "- JSON 格式（params 可省略）：",
      "```json",
      '{ "mode": "conductor", "reason": "任务复杂，需要拆解成子任务" }',
      "```",
      "",
      "params 说明（可选）：",
      '- mention: { "targets": ["sessionId", ...] }',
      '- roundrobin: { "speaker": "sessionId" }',
      '- parallel: { "summarizer": "sessionId" }',
      '- pipeline: { "order": ["sessionId", ...] }',
      '- debate: { "sides": ["sessionId", "sessionId"], "judge": "sessionId", "rounds": 2 }',
      '- conductor: { "tasks": [{"to":"成员名或id","task":"具体子任务","id":"t1","dependsOn":[]}] }',
      '- self: { }',
      "",
      "conductor 模式 params 使用约束：",
      "- `tasks` 中的 `to` 必须是除主持人（你自己）之外的成员 id 或名字；",
      "- 不要写\"提交\"、\"汇总\"等主持人动作作为 worker task，这些由主持人自动完成；",
      "- `dependsOn` 只能引用同一 `tasks` 列表里、且排在前面的任务 `id`，不要自引用或引用未定义的任务。",
      "",
      "最近上下文：",
      boardText,
      this.formatAutoHistory(room.roomId),
      `${quoteText}用户消息：${text}`,
      noteText,
      sessionNoteText,
      "",
      "注意：你必须且只能输出一个上面格式的 JSON code block，不要加任何解释、前缀或后缀。",
    ].join("\n");
  }

  private parseAutoDecision(output: string): AutoDecision {
    const fallback: AutoDecision = { mode: "mention", reason: "决策输出无法解析，兜底为点名应答" };
    const text = output.trim();
    if (!text) {
      logWarn("room-modes auto", "决策输出为空");
      return { ...fallback, reason: "决策输出为空" };
    }

    const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!.trim()).filter(Boolean);
    for (let i = fences.length - 1; i >= 0; i--) {
      const parsed = this.tryParseAutoJson(fences[i]!, `code fence #${i + 1}`);
      if (parsed) return parsed;
    }

    const objects = this.extractJsonObjects(text);
    for (let i = objects.length - 1; i >= 0; i--) {
      const parsed = this.tryParseAutoJson(objects[i]!, `raw json object #${i + 1}`);
      if (parsed) return parsed;
    }

    const loose = this.extractModeFromText(text);
    if (loose) {
      logWarn("room-modes auto", `决策未输出严格 JSON，通过文本识别 mode：${loose.mode}`);
      return loose;
    }

    logWarn("room-modes auto", `决策输出无法解析，原始内容：\n${text.slice(0, 800)}`);
    return fallback;
  }

  private tryParseAutoJson(raw: string, source: string): AutoDecision | null {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const mode = String(obj.mode ?? "").toLowerCase() as RoomMode;
      if (!mode || mode === "auto" || !this.isValidMode(mode)) {
        logWarn("room-modes auto", `决策 JSON mode 无效或不可选（${source}）：mode=${mode}`);
        return null;
      }
      const params =
        typeof obj.params === "object" && obj.params !== null ? (obj.params as Record<string, unknown>) : {};
      return { mode, reason: String(obj.reason ?? ""), params };
    } catch (err) {
      logWarn("room-modes auto", `决策 JSON 解析失败（${source}）：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private extractModeFromText(text: string): AutoDecision | null {
    const enMatch = text.match(/(?:"|')?mode(?:"|')?\s*[:=]\s*(?:"|')?(mention|conductor|roundrobin|parallel|pipeline|debate|self)(?:"|')?/i);
    if (enMatch) return { mode: enMatch[1]!.toLowerCase() as AutoDecisionMode, reason: "从非 JSON 文本中识别到 mode 字段" };
    const aliases: Record<string, AutoDecisionMode> = {
      mention: "mention",
      点名: "mention",
      点名应答: "mention",
      全部成员: "mention",
      conductor: "conductor",
      指挥家: "conductor",
      指挥家编排: "conductor",
      roundrobin: "roundrobin",
      轮询: "roundrobin",
      parallel: "parallel",
      并行: "parallel",
      集思广益: "parallel",
      并行集思广益: "parallel",
      pipeline: "pipeline",
      流水线: "pipeline",
      debate: "debate",
      辩论: "debate",
      辩论评审: "debate",
      self: "self",
      自己: "self",
      主持人独立作答: "self",
    };
    const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
    const pattern = new RegExp(`(?:选择|模式|mode)[是为：:\\s]*(${keys.join("|")})`, "i");
    const match = text.match(pattern);
    if (match?.[1]) {
      const mode = aliases[match[1]!]!;
      return { mode, reason: "从中文回答中识别到模式名称" };
    }
    return null;
  }

  private extractJsonObjects(text: string): string[] {
    const objects: string[] = [];
    for (let start = 0; start < text.length; start++) {
      start = text.indexOf("{", start);
      if (start < 0) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
        } else {
          if (ch === '"') {
            inString = true;
          } else if (ch === "{") {
            depth++;
          } else if (ch === "}") {
            depth--;
            if (depth === 0) {
              objects.push(text.slice(start, i + 1));
              start = i;
              break;
            }
          }
        }
      }
    }
    return objects;
  }

  private isValidMode(mode: string): mode is RuntimeMode {
    return [
      "mention",
      "conductor",
      "roundrobin",
      "parallel",
      "pipeline",
      "debate",
      "self",
    ].includes(mode);
  }

  private buildPromptContent(
    room: Room,
    text: string,
    sessionId: string,
    options?: PromptOptions,
  ): string | PromptContent {
    let baseText = text;
    const note = options?.note ?? options?.sessionNote?.(sessionId);
    if (note) baseText = `${note}\n\n${baseText}`;
    const refs = this.rooms.parseArtifactRefs(room.roomId, baseText);
    const extraRefs = Array.isArray(options?.params?.artifacts)
      ? (options.params.artifacts as unknown[]).map((s) => String(s)).filter(Boolean)
      : [];
    if (extraRefs.length > 0) refs.push(...extraRefs);
    if (options?.artifactContext?.refs?.length) refs.push(...options.artifactContext.refs);
    const uniqueRefs = [...new Set(refs)];
    const artifactContext = uniqueRefs.length > 0
      ? { ...(options?.artifactContext ?? {}), refs: uniqueRefs }
      : options?.artifactContext;
    const persona = room.memberRoles?.[sessionId];
    const promptText = this.rooms.buildPrompt(room.roomId, baseText, sessionId, options?.quote, persona, artifactContext);
    const content = options?.content;
    if (!content) return promptText;
    const imageBlocks = content.filter((b) => b.type !== "text");
    if (imageBlocks.length === 0) return promptText;
    return [{ type: "text", text: promptText }, ...imageBlocks];
  }

  private pipelineOrder(
    room: Room,
    params?: Record<string, unknown> | undefined,
  ): string[] {
    const fromParams = Array.isArray(params?.order) ? (params.order as unknown[]) : [];
    const custom = fromParams.length > 0
      ? fromParams
          .map((s) => String(s))
          .filter((sid) => room.members.some((m) => m.sessionId === sid))
      : (room.pipelineOrder ?? []);
    const all = room.members.map((m) => m.sessionId);
    const ordered = custom.length > 0 ? custom.filter((sid) => all.includes(sid)) : all;
    // 把剩下的补到末尾
    const set = new Set(ordered);
    for (const sid of all) if (!set.has(sid)) ordered.push(sid);
    return ordered;
  }

  private debateSides(
    room: Room,
    params?: Record<string, unknown> | undefined,
  ): [string | undefined, string | undefined] {
    const fromParams = Array.isArray(params?.sides) ? (params.sides as unknown[]) : [];
    const raw = fromParams.length >= 2
      ? [String(fromParams[0]), String(fromParams[1])]
      : room.debateSides ?? [room.members[0]?.sessionId, room.members[1]?.sessionId];
    const valid = raw
      .filter((sid): sid is string => !!sid)
      .filter((sid) => room.members.some((m) => m.sessionId === sid));
    return [valid[0], valid[1]];
  }

  private nameFor(roomId: string, sessionId?: string): string {
    if (!sessionId) return "未知";
    const room = this.rooms.get(roomId);
    return room?.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId.slice(-4);
  }
}
