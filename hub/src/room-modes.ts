import { randomUUID } from "node:crypto";
import type { Room, RoomManager, RoomMode } from "./room.js";
import { ConductorOrchestrator } from "./conductor.js";

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
};

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
};

type PipelineFlow = {
  order: string[];
  stage: number;
  outputs: string[];
  topic: string;
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  content?: PromptContent | undefined;
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
  private roundRobinIndices = new Map<string, number>();
  private parallelFlows = new Map<string, ParallelFlow>();
  private pipelineFlows = new Map<string, PipelineFlow>();
  private debateFlows = new Map<string, DebateFlow>();
  private roomSubMode = new Map<string, { mode: RuntimeMode; activeSpeaker?: string | undefined; reason?: string | undefined }>();

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly broadcast: (method: string, params: Record<string, unknown>) => void,
  ) {
    this.conductor = new ConductorOrchestrator(agent, rooms, (n) => this.notice(n));
  }

  private notice(n: ConductorNotice): void {
    this.broadcast("room.notice", n as unknown as Record<string, unknown>);
  }

  private emitModeSelected(e: ModeSelectedEvent): void {
    this.broadcast("room.modeSelected", e as unknown as Record<string, unknown>);
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
  }

  /** 处理一条新的房间消息 */
  async handle(
    room: Room,
    text: string,
    options?: PromptOptions,
  ): Promise<ModeResult> {
    await this.cancelActive(room.roomId, "收到新消息，当前流程已取消");

    if (room.mode === "auto") {
      return this.handleAuto(room, text, options);
    }

    this.setSubMode(room.roomId, room.mode, undefined, undefined);
    return this.executeMode(room, room.mode, text, options);
  }

  /** prompt 完成时的回调 */
  async onPromptDone(sessionId: string, output: string): Promise<boolean> {
    // auto 决策完成
    const autoCtx = this.autoDecisions.get(sessionId);
    if (autoCtx) {
      this.autoDecisions.delete(sessionId);
      const room = this.rooms.get(autoCtx.roomId);
      if (!room) return true;
      const decision = this.parseAutoDecision(output);
      const label = MODE_LABELS[decision.mode] ?? decision.mode;
      this.setSubMode(room.roomId, decision.mode, this.activeSpeakerFor(room, decision.mode, decision.params), decision.reason);
      this.notice({
        roomId: room.roomId,
        message: `🎛️ 本轮自动选择：${label}${decision.reason ? ` —— ${decision.reason}` : ""}`,
      });
      await this.executeMode(room, decision.mode, autoCtx.text, {
        note: autoCtx.note,
        quote: autoCtx.quote,
        content: autoCtx.content,
        sessionNote: autoCtx.sessionNote,
        params: decision.params,
      });
      return true;
    }

    // conductor 编排
    if (await this.conductor.onPromptDone(sessionId, output)) return true;

    // 其他流程
    if (this.onParallelDone(sessionId, output)) return true;
    if (this.onPipelineDone(sessionId, output)) return true;
    if (this.onDebateDone(sessionId, output)) return true;

    return false;
  }

  /** prompt 异常/取消时的回调 */
  onPromptError(sessionId: string): boolean {
    const autoCtx = this.autoDecisions.get(sessionId);
    if (autoCtx) {
      this.autoDecisions.delete(sessionId);
      const room = this.rooms.get(autoCtx.roomId);
      if (room) {
        this.notice({ roomId: room.roomId, message: "🎛️ 主持人决策失败，已兜底为点名应答" });
        this.setSubMode(room.roomId, "mention", undefined, undefined);
        void this.executeMode(room, "mention", autoCtx.text, {
          note: autoCtx.note,
          quote: autoCtx.quote,
          content: autoCtx.content,
          sessionNote: autoCtx.sessionNote,
        });
      }
      return true;
    }

    if (this.conductor.onPromptError(sessionId)) return true;

    for (const [roomId, flow] of this.parallelFlows) {
      if (flow.pending.has(sessionId)) {
        flow.pending.delete(sessionId);
        this.notice({
          roomId,
          message: `@${this.nameFor(roomId, sessionId)} 并行回答中断`,
        });
        if (flow.pending.size === 0) this.summarizeParallel(roomId, flow);
        return true;
      }
    }

    for (const [roomId, flow] of this.pipelineFlows) {
      if (flow.order[flow.stage] === sessionId) {
        this.pipelineFlows.delete(roomId);
        this.setSubMode(roomId, "pipeline", undefined, undefined);
        this.notice({ roomId, message: `流水线第 ${flow.stage + 1} 阶段中断` });
        return true;
      }
    }

    for (const [roomId, flow] of this.debateFlows) {
      if (flow.sides.includes(sessionId) || flow.judge === sessionId) {
        this.debateFlows.delete(roomId);
        this.setSubMode(roomId, "debate", undefined, undefined);
        this.notice({ roomId, message: "辩论流程中断" });
        return true;
      }
    }

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
    const sent: string[] = [];
    const skipped: string[] = [];
    for (const sid of targets) {
      if (this.agent.isBusy(sid)) {
        skipped.push(sid);
        continue;
      }
      const prompt = this.buildPromptContent(room, text, sid, options);
      this.agent.prompt(sid, prompt).catch((err) => {
        console.error("[room-modes] mention prompt failed:", sid, err);
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
    let task = text;
    if (options?.note) task = `${options.note}\n\n${task}`;
    if (options?.quote) {
      task = `${task}\n（用户引用了 ${options.quote.author} 的消息："${options.quote.text}"）`;
    }
    this.conductor.start(room, task).catch((err) => {
      console.error("[room-modes] conductor start failed:", room.conductorId, err);
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
    let idx = this.roundRobinIndices.get(room.roomId) ?? 0;
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
    this.roundRobinIndices.set(room.roomId, idx);
    this.setSubMode(room.roomId, "roundrobin", target, undefined);
    this.notice({ roomId: room.roomId, message: `🔄 轮询模式：由 @${this.nameFor(room.roomId, target)} 作答` });
    const prompt = this.buildPromptContent(room, text, target, options);
    this.agent.prompt(target, prompt).catch((err) => {
      console.error("[room-modes] roundrobin prompt failed:", target, err);
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
    };
    this.parallelFlows.set(room.roomId, flow);
    this.setSubMode(room.roomId, "parallel", summarizer, undefined);
    for (const sid of sent) {
      const prompt = this.buildPromptContent(room, text, sid, options);
      this.agent.prompt(sid, prompt).catch((err) => {
        console.error("[room-modes] parallel prompt failed:", sid, err);
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

  private onParallelDone(sessionId: string, output: string): boolean {
    for (const [roomId, flow] of this.parallelFlows) {
      if (!flow.pending.has(sessionId)) continue;
      flow.pending.delete(sessionId);
      flow.results.set(sessionId, output);
      if (flow.pending.size === 0) {
        this.summarizeParallel(roomId, flow);
      }
      return true;
    }
    return false;
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
    const prompt = `你是群聊「${room.name}」的汇总者。多位成员就同一问题给出了独立回答：\n${lines.join("\n")}\n\n请综合以上观点，给用户一个清晰、全面的最终回答。`;
    this.parallelFlows.delete(roomId);
    this.notice({ roomId, message: "并行回答完成，汇总者正在整理…" });
    this.agent.prompt(flow.summarizer, prompt).catch((err) => {
      console.error("[room-modes] parallel summarize failed:", err);
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
    };
    this.pipelineFlows.set(room.roomId, flow);
    this.setSubMode(room.roomId, "pipeline", first, undefined);
    const path = order.map((sid) => `@${this.nameFor(room.roomId, sid)}`).join(" → ");
    this.notice({ roomId: room.roomId, message: `🔄 流水线模式：${path}` });
    const prompt = this.buildPipelinePrompt(room, flow, 0);
    this.agent.prompt(first, prompt).catch((err) => {
      console.error("[room-modes] pipeline prompt failed:", first, err);
    });
    return { sent: [first], mentioned: [], skipped: [] };
  }

  private onPipelineDone(sessionId: string, output: string): boolean {
    for (const [roomId, flow] of this.pipelineFlows) {
      if (flow.order[flow.stage] !== sessionId) continue;
      const room = this.rooms.get(roomId);
      if (!room) {
        this.pipelineFlows.delete(roomId);
        return true;
      }
      flow.outputs.push(output);
      const nextStage = flow.stage + 1;
      if (nextStage >= flow.order.length) {
        this.pipelineFlows.delete(roomId);
        this.setSubMode(roomId, "pipeline", undefined, undefined);
        this.notice({ roomId, message: "流水线模式：全部阶段完成" });
        return true;
      }
      const prevName = this.nameFor(roomId, flow.order[flow.stage]!);
      flow.stage = nextStage;
      const nextSid = flow.order[nextStage]!;
      this.setSubMode(roomId, "pipeline", nextSid, undefined);
      this.notice({ roomId, message: `流水线第 ${nextStage + 1} 阶段 → @${this.nameFor(roomId, nextSid)}` });
      const prompt = this.buildPipelinePrompt(room, flow, nextStage, prevName, output);
      this.agent.prompt(nextSid, prompt).catch((err) => {
        console.error("[room-modes] pipeline next stage failed:", nextSid, err);
      });
      return true;
    }
    return false;
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
    return this.buildPromptContent(room, task, flow.order[stage]!, { quote, content: flow.content });
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
    this.agent.prompt(sideA, prompt).catch((err) => {
      console.error("[room-modes] debate prompt failed:", sideA, err);
    });
    return { sent: [sideA], mentioned: [], skipped: [] };
  }

  private onDebateDone(sessionId: string, output: string): boolean {
    for (const [roomId, flow] of this.debateFlows) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.debateFlows.delete(roomId);
        return true;
      }
      const currentSid = flow.sides[flow.sideIndex]!;
      if (sessionId !== currentSid) continue;
      flow.outputs.push({ round: flow.currentRound, side: flow.sideIndex, text: output });

      if (flow.sideIndex === 0) {
        flow.sideIndex = 1;
        const nextSid = flow.sides[1]!;
        this.setSubMode(roomId, "debate", nextSid, undefined);
        const prompt = this.buildDebatePrompt(room, flow, 1, output);
        this.agent.prompt(nextSid, prompt).catch((err) => {
          console.error("[room-modes] debate next side failed:", nextSid, err);
        });
        return true;
      }

      if (flow.currentRound < flow.rounds) {
        flow.currentRound++;
        flow.sideIndex = 0;
        const nextSid = flow.sides[0]!;
        this.setSubMode(roomId, "debate", nextSid, undefined);
        const prompt = this.buildDebatePrompt(room, flow, 0, output);
        this.agent.prompt(nextSid, prompt).catch((err) => {
          console.error("[room-modes] debate next round failed:", nextSid, err);
        });
        return true;
      }

      // 辩论结束，裁判总结
      this.debateFlows.delete(roomId);
      this.setSubMode(roomId, "debate", flow.judge, undefined);
      this.notice({ roomId, message: "辩论结束，裁判总结中…" });
      const judgePrompt = this.buildJudgePrompt(room, flow);
      this.agent.prompt(flow.judge, judgePrompt).catch((err) => {
        console.error("[room-modes] judge prompt failed:", flow.judge, err);
      });
      return true;
    }
    return false;
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
    return this.buildPromptContent(room, task, flow.sides[sideIndex]!, { quote, content: flow.content });
  }

  private buildJudgePrompt(room: Room, flow: DebateFlow): string {
    const lines = flow.outputs.map((o) => {
      const side = o.side === 0 ? "正方" : "反方";
      return `- 第 ${o.round} 轮 ${side}：${o.text.trim().replace(/\s+/g, " ").slice(0, 400)}`;
    });
    return `你是辩论裁判。辩题：${flow.topic}\n\n辩论记录：\n${lines.join("\n")}\n\n请做出公正总结，指出共识与分歧，给出最终判断。`;
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
    const prompt = this.buildPromptContent(room, text, room.conductorId, options);
    this.agent.prompt(room.conductorId, prompt).catch((err) => {
      console.error("[room-modes] self prompt failed:", room.conductorId, err);
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
    });
    const prompt = this.buildAutoPrompt(room, text, options);
    this.notice({ roomId: room.roomId, message: "🎛️ 自动模式：主持人正在决策…" });
    this.agent.prompt(room.conductorId, prompt).catch((err) => {
      console.error("[room-modes] auto decision failed:", room.conductorId, err);
    });
    return { sent: [room.conductorId], mentioned: [], skipped: [] };
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
      "- 仅输出一个 JSON code block，不要有任何解释文字",
      "- 不要调用任何工具，仅做选择",
      "- JSON 格式：",
      "```json",
      '{ "mode": "conductor", "reason": "任务需要拆解派工", "params": { } }',
      "```",
      "",
      "params 说明：",
      '- mention: { "targets": ["sessionId", ...] }，未指定则发给全部',
      '- roundrobin: { }',
      '- parallel: { "summarizer": "sessionId" }，默认使用主持人',
      '- pipeline: { "order": ["sessionId", ...] }，默认按成员顺序',
      '- debate: { "sides": ["sessionId", "sessionId"], "judge": "sessionId", "rounds": 2 }，默认前两位成员作正反方、主持人作裁判',
      '- self: { }',
      "",
      "最近上下文：",
      boardText,
      "",
      `${quoteText}用户消息：${text}`,
      noteText,
      sessionNoteText,
    ].join("\n");
  }

  private parseAutoDecision(output: string): AutoDecision {
    const fallback: AutoDecision = { mode: "mention", reason: "决策输出无法解析，兜底为点名应答" };
    const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    let raw = fence?.[1]?.trim() ?? output.trim();
    if (!raw) return fallback;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const mode = String(obj.mode ?? "").toLowerCase() as RoomMode;
      if (!mode || mode === "auto" || !this.isValidMode(mode)) return fallback;
      return {
        mode,
        reason: String(obj.reason ?? ""),
        params: (obj.params as Record<string, unknown>) ?? {},
      };
    } catch {
      return fallback;
    }
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
    const promptText = this.rooms.buildPrompt(room.roomId, baseText, sessionId, options?.quote);
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
