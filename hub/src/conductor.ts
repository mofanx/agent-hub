import { randomUUID } from "node:crypto";
import { isEventAction, type Room, type RoomManager } from "./room.js";
import { logError } from "./logger.js";

export type PromptContent = Array<Record<string, unknown>>;

export interface AgentOps {
  prompt(sessionId: string, content: string | PromptContent): Promise<void>;
  isBusy(sessionId: string): boolean;
}

type TaskArtifact = {
  type: "file" | "event";
  /** 事件动作，如 command / test / note / delete / rename */
  action?: string | undefined;
  path?: string | undefined;
  summary: string;
  /** 完整文本内容，仅用于 diff/file 这类需要预览时回显的场景 */
  content?: string | undefined;
};

type TaskResult = {
  text: string;
  artifacts: TaskArtifact[];
  /** 对其他任务的独立验证声明（verify 字段） */
  verifications?: { taskId: string; verdict: string; evidence: string }[];
};

type FlowPhase = "planning" | "working" | "reviewing" | "summarizing" | "awaiting-retry" | "done";

type ParsedTask = { id?: string; to: string; task: string; dependsOn?: string[] };
type ConductorPlan = { goal?: string | undefined; acceptanceCriteria: string[]; tasks: ParsedTask[] };
type ReviewDecision =
  | { decision: "complete"; reason: string }
  | { decision: "continue"; reason: string; tasks: ParsedTask[] };

/** 其他成员对某个任务的独立验证记录 */
export type TaskVerification = {
  by: string;
  verdict: string;
  evidence: string;
  at: number;
};

/** 任务执行中的定向求助交换：worker 提问 → 目标成员/用户回复 → 唤醒原 worker 继续 */
type HelpExchange = {
  id: string;
  taskId: string;
  from: string;
  /** 成员 sessionId，或 "user" 表示向用户求助 */
  to: string;
  question: string;
  /** 求助发起时的输出摘录，随求助一起转发给目标 */
  context?: string;
  answer?: string;
  status: "pending" | "answered";
  /** 是否已向目标成员发出求助 prompt */
  dispatched: boolean;
};

type Supplement = { text: string; at: number };

type FlowTask = {
  id: string;
  sessionId: string;
  task: string;
  dependsOn: string[];
  status: "pending" | "running" | "done" | "failed";
  iteration: number;
  failureMessage?: string;
  retries?: number;
  /** 已发起的求助轮数（上限 MAX_HELP_ROUNDS） */
  helpRounds?: number;
  /** 等待中的求助交换 id */
  waitingForHelp?: string;
  /** 其他成员对本任务的独立验证记录 */
  verifications?: TaskVerification[];
};

type Flow = {
  roomId: string;
  phase: FlowPhase;
  goal: string;
  acceptanceCriteria: string[];
  iteration: number;
  maxIterations: number;
  /** 任务以 taskId 为 key */
  tasks: Map<string, FlowTask>;
  /** 结果以 taskId 为 key */
  results: Map<string, TaskResult>;
  artifactContext?: { refs?: string[] } | undefined;
  reviewReason?: string;
  /** 用户在流程执行中补充的信息，并入后续派发/验收/汇总 prompt */
  supplements: Supplement[];
  /** 任务执行中的定向求助交换 */
  help: Map<string, HelpExchange>;
  /** 是否已有求助派发重试定时器在跑 */
  helpRetrying?: boolean;
};

export type ConductorNotice = { roomId: string; message: string };

const PLAN_RESULT_LEN = 4000;
const MAX_ITERATIONS = 3;
const MAX_HELP_ROUNDS = 2;
const DEFAULT_ACCEPTANCE_CRITERIA = ["交付结果满足用户目标，并包含必要的实现与验证证据"];
const BUSY_RETRY_MS = 5000;

const PROMPT_RETRY_MS = 5000;
const SUMMARIZE_RETRY_MS = 5000;

export class ConductorOrchestrator {
  private flows = new Map<string, Flow>();
  private readonly promptRetryMs: number;
  private readonly emitFlow: ((roomId: string) => void) | undefined;

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly notice: (n: ConductorNotice) => void,
    emitFlow?: (roomId: string) => void,
    promptRetryMs?: number,
  ) {
    this.emitFlow = emitFlow;
    this.promptRetryMs = promptRetryMs ?? PROMPT_RETRY_MS;
  }

  hasActiveFlow(roomId: string): boolean {
    return this.flows.has(roomId);
  }

  /** 强制中断某个房间的指挥编排 */
  cancel(roomId: string, reason?: string): string[] {
    const flow = this.flows.get(roomId);
    if (!flow) return [];
    const touched = new Set<string>();
    for (const t of flow.tasks.values()) {
      if (t.status === "pending" || t.status === "running") {
        touched.add(t.sessionId);
      }
    }
    this.flows.delete(roomId);
    this.emitFlow?.(roomId);
    if (reason) this.notice({ roomId, message: reason });
    return [...touched];
  }

  /** 获取可用于前端展示的 flow 状态 */
  getFlow(roomId: string): Record<string, unknown> | undefined {
    const flow = this.flows.get(roomId);
    if (!flow) return undefined;
    const room = this.rooms.get(roomId);
    const tasks = [...flow.tasks.values()].map((t) => {
      const result = flow.results.get(t.id);
      const waiting = t.waitingForHelp ? flow.help.get(t.waitingForHelp) : undefined;
      return {
        id: t.id,
        sessionId: t.sessionId,
        name: room?.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId,
        status: t.status,
        task: t.task,
        dependsOn: t.dependsOn,
        iteration: t.iteration,
        artifacts: result?.artifacts ?? [],
        ...(waiting
          ? {
              waitingFor:
                waiting.to === "user"
                  ? "user"
                  : room?.members.find((m) => m.sessionId === waiting.to)?.name ?? waiting.to,
              waitingQuestion: waiting.question.slice(0, 200),
            }
          : {}),
        ...(t.verifications?.length
          ? {
              verifications: t.verifications.map((v) => ({
                by: room?.members.find((m) => m.sessionId === v.by)?.name ?? v.by,
                verdict: v.verdict,
                evidence: v.evidence.slice(0, 500),
              })),
            }
          : {}),
        ...(t.failureMessage !== undefined ? { failureMessage: t.failureMessage } : {}),
        ...(result?.text ? { output: result.text.slice(0, 2000) } : {}),
        ...(t.retries !== undefined && t.retries > 0 ? { retries: t.retries } : {}),
      };
    });
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    return {
      roomId: flow.roomId,
      phase: flow.phase,
      goal: flow.goal,
      acceptanceCriteria: flow.acceptanceCriteria,
      iteration: flow.iteration,
      maxIterations: flow.maxIterations,
      progress: { done, running, pending, failed, total: tasks.length },
      tasks,
      ...(flow.supplements.length > 0
        ? { supplements: flow.supplements.map((s) => s.text.slice(0, 300)) }
        : {}),
    };
  }

  /** 判断某 session 是否是指挥家且正在指挥编排中 */
  isConductorSession(sessionId: string): boolean {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (room && room.conductorId === sessionId) return true;
    }
    return false;
  }

  /** 获取某 session 在当前编排中的角色与阶段 */
  getFlowForSession(
    sessionId: string,
  ):
    | { roomId: string; role: "conductor" | "worker"; phase: Flow["phase"] }
    | undefined {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) continue;
      if (room.conductorId === sessionId) {
        return { roomId: flow.roomId, role: "conductor", phase: flow.phase };
      }
      if (flow.phase === "working") {
        const hasTask = [...flow.tasks.values()].some(
          (t) => t.sessionId === sessionId && (t.status === "pending" || t.status === "running"),
        );
        if (hasTask) {
          return { roomId: flow.roomId, role: "worker", phase: flow.phase };
        }
      }
    }
    return undefined;
  }

  /** prompt 异常（含取消）时清理该会话在编排中的状态 */
  onPromptError(sessionId: string): string | undefined {
    for (const [roomId, flow] of [...this.flows]) {
      const room = this.rooms.get(roomId);
      if (!room) {
        this.flows.delete(roomId);
        continue;
      }
      if (sessionId === room.conductorId) {
        this.flows.delete(roomId);
        this.notice({ roomId, message: "指挥家中断，本轮编排已取消" });
        return roomId;
      }
      if (flow.phase === "working") {
        // 求助对象出错/中断：视为无响应，继续唤醒原任务
        const pendingReply = [...flow.help.values()].find(
          (e) => e.status === "pending" && e.dispatched && e.to === sessionId,
        );
        if (pendingReply) {
          pendingReply.status = "answered";
          pendingReply.answer = "（对方出错或中断，未能提供回复）";
          this.repromptAsker(flow, room, pendingReply);
          return roomId;
        }
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          running.status = "pending";
          delete running.waitingForHelp;
          const pendingCount = [...flow.tasks.values()].filter((t) => t.status === "pending").length;
          this.notice({
            roomId,
            message: `@${
              room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId
            } 子任务中断（剩 ${pendingCount} 项待派发）`,
          });
          void this.scheduleTasks(flow, room).catch((err) => {
            logError("conductor schedule after error", err);
          });
          return roomId;
        }
      }
    }
    return undefined;
  }

  private buildMemberList(room: Room): string {
    return room.members
      .filter((m) => m.sessionId !== room.conductorId)
      .map((m) => `${m.name} (id: ${m.sessionId})`)
      .join("、") || "（无）";
  }

  private buildExample(room: Room): string {
    const others = room.members.filter((m) => m.sessionId !== room.conductorId);
    if (others.length === 0) {
      return '{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[]}';
    }
    const sample = others.slice(0, 2).map((m, i) =>
      JSON.stringify({ to: m.sessionId, task: i === 0 ? "先处理第一个子任务" : "再处理第二个子任务" })
    );
    return `{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[${sample.join(",")}]}`;
  }

  private newFlow(roomId: string, goal: string, artifactContext?: { refs?: string[] }): Flow {
    return {
      roomId,
      phase: "planning",
      goal,
      acceptanceCriteria: [...DEFAULT_ACCEPTANCE_CRITERIA],
      iteration: 1,
      maxIterations: MAX_ITERATIONS,
      tasks: new Map(),
      results: new Map(),
      artifactContext,
      supplements: [],
      help: new Map(),
    };
  }

  async start(
    room: Room,
    text: string,
    initialTasks?: { to: string; task: string; id?: string; dependsOn?: string[] }[],
    artifactContext?: { refs?: string[] },
  ): Promise<void> {
    if (!room.conductorId) throw new Error("room has no conductor");
    if (initialTasks && initialTasks.length > 0) {
      // 由 auto 模式推荐的初始派工单，直接 dispatch
      this.flows.set(room.roomId, this.newFlow(room.roomId, text, artifactContext));
      const flow = this.flows.get(room.roomId)!;
      await this.dispatchFromTasks(flow, room, initialTasks, text);
      return;
    }
    const example = this.buildExample(room);
    const prompt = [
      `你是群聊「${room.name}」的指挥家（Conductor）。`,
      `可派工的成员：${this.buildMemberList(room)}。`,
      "",
      `用户任务：${text}`,
      "",
      "请把任务拆解并派发给成员。",
      "协作边界：成员可能本身运行 Devin Fusion 或内部子代理。Agent Hub 只按独立责任边界、不同专长或明确依赖拆分；不要把单个成员能端到端完成的工作切成多个重复/微小任务，也不要让多个写任务修改同一文件。",
      "",
      "输出格式要求（必须严格遵守）：",
      "1. 必须输出一个 JSON code block；tasks 非空时 JSON 外不要有文字。",
      "2. JSON 顶层字段必须包含 `goal`（用一句话重述最终目标）、`acceptanceCriteria`（数组，每条是可验证的验收标准）和 `tasks`（数组）。",
      "3. 每个任务对象包含 `to`（接收成员）、`task`（具体子任务描述），可选 `id`（任务标识）和 `dependsOn`（依赖的 id 数组）。",
      "4. `to` 可以是：成员 ID（括号里的 `id:...`）、`@成员名` 或成员名。",
      "5. `task` 必须具体、可执行，不要写占位符。",
      "6. 如果任务有依赖关系，请用 `dependsOn` 指定前置任务 `id`。",
      "7. `acceptanceCriteria` 每条都必须是可验证的标准，用于任务完成后验收是否达标。",
      "8. 如果任务简单、无需分工，tasks 输出 `[]`；tasks 为空时允许在 code block 之前直接写出你的最终回答。",
      "",
      "正确示例（请用实际成员 ID 替换）：",
      "```json",
      example,
      "```",
      "",
      "错误示例（不要这样做）：",
      '- to: "成员A"（不存在该成员）',
      '- task: "处理一下"（不够具体）',
      '- 输出多个 code block 或在 JSON 外加解释文字',
    ];
    if (artifactContext?.refs?.length) {
      const artifacts = this.rooms.getArtifactsForPrompt(room.roomId, room.conductorId!, artifactContext);
      if (artifacts.length > 0) {
        prompt.push("", "用户明确引用了以下产物，请把它们作为上下文：");
        for (const a of artifacts) {
          const parts = [`@${this.rooms.memberName(room.roomId, a.author)}`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          prompt.push(`- ${parts.join(" ")}`);
        }
      }
    }
    const promptText = prompt.join("\n");
    this.flows.set(room.roomId, this.newFlow(room.roomId, text, artifactContext));
    this.notice({ roomId: room.roomId, message: "指挥家拆解任务中…" });
    await this.agent.prompt(room.conductorId, promptText);
  }

  /** 每轮 prompt.done 时调用；返回 flow roomId 表示该事件属于某个编排流 */
  async onPromptDone(sessionId: string, output: string): Promise<string | undefined> {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) {
        this.flows.delete(flow.roomId);
        continue;
      }
      if (sessionId === room.conductorId) {
        if (flow.phase === "planning") {
          await this.dispatch(flow, room, output);
          return flow.roomId;
        }
        if (flow.phase === "reviewing") {
          await this.handleReview(flow, room, output);
          return flow.roomId;
        }
        if (flow.phase === "summarizing") {
          const roomId = flow.roomId;
          const result = extractTaskResult(output);
          for (const a of result.artifacts) {
            this.commitArtifact(roomId, a, sessionId);
          }
          const hasFailed = [...flow.tasks.values()].some((t) => t.status === "failed");
          if (hasFailed) {
            flow.phase = "awaiting-retry";
            this.emitFlow?.(roomId);
            const failedIds = [...flow.tasks.values()]
              .filter((t) => t.status === "failed")
              .map((t) => t.id);
            this.notice({
              roomId,
              message: `部分子任务失败（${failedIds.join(", ")}），发送"重试"重新派发失败任务，或发送新消息继续`,
            });
          } else {
            flow.phase = "done";
            this.emitFlow?.(roomId);
            this.flows.delete(roomId);
          }
          return roomId;
        }
      }
      if (flow.phase === "working") {
        // 定向求助回复：helper 的输出被消费为答案，唤醒原任务继续
        const reply = [...flow.help.values()].find(
          (e) => e.status === "pending" && e.dispatched && e.to === sessionId,
        );
        if (reply) {
          reply.status = "answered";
          reply.answer = output;
          const toName = room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
          const fromName = room.members.find((m) => m.sessionId === reply.from)?.name ?? reply.from;
          this.notice({
            roomId: flow.roomId,
            message: `@${toName} 已回复 @${fromName} 的求助（任务 ${reply.taskId}），任务继续`,
          });
          this.repromptAsker(flow, room, reply);
          this.emitFlow?.(flow.roomId);
          return flow.roomId;
        }
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          const name =
            room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
          // 定向求助：命中则挂起任务等待回复，而不是按结果收尾
          const helpReq = extractHelpRequest(output);
          if (helpReq && this.handleHelpRequest(flow, room, running, helpReq, output)) {
            return flow.roomId;
          }
          const result = extractTaskResult(output);
          flow.results.set(running.id, result);
          this.recordVerifications(flow, room, sessionId, result.verifications ?? []);
          for (const a of result.artifacts) {
            this.commitArtifact(flow.roomId, a, sessionId, running.id);
          }
          const artifactCount = result.artifacts.length;
          const extra = artifactCount > 0 ? `，发现 ${artifactCount} 个 artifact` : "";
          const pendingCount = [...flow.tasks.values()].filter((t) => t.status === "pending").length;

          running.status = "done";
          this.notice({
            roomId: flow.roomId,
            message: `@${name} 已完成子任务 ${running.id}（剩 ${pendingCount} 项）${extra}`,
          });
          await this.scheduleTasks(flow, room);
          return flow.roomId;
        }
      }
    }
    return undefined;
  }

  private commitArtifact(
    roomId: string,
    a: TaskArtifact,
    author: string,
    taskId?: string,
  ): void {
    if (a.type === "file") {
      this.rooms.addFile(roomId, {
        author,
        summary: a.summary,
        path: a.path,
        taskId,
        content: a.content,
      });
      return;
    }
    const action = isEventAction(a.action) ? a.action : undefined;
    if (!action) return;
    this.rooms.addEvent(roomId, {
      author,
      action,
      summary: a.summary,
      path: a.path,
      taskId,
    });
  }

  /** 用户补充信息并入活跃流程（不取消任务）；返回 false 表示当前阶段不吸收 */
  addSupplement(roomId: string, text: string): boolean {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase === "awaiting-retry" || flow.phase === "done") return false;
    flow.supplements.push({ text, at: Date.now() });
    this.emitFlow?.(roomId);
    return true;
  }

  /** 用户消息答复指向 "user" 的求助；返回被重新唤醒的成员 sessionId 列表 */
  answerUserHelp(roomId: string, text: string): string[] {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "working") return [];
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const answered: string[] = [];
    for (const e of flow.help.values()) {
      if (e.status !== "pending" || e.to !== "user") continue;
      e.status = "answered";
      e.answer = text;
      this.repromptAsker(flow, room, e);
      answered.push(e.from);
    }
    if (answered.length > 0) this.emitFlow?.(roomId);
    return answered;
  }

  /** worker 输出命中求助块：挂起任务并转达目标成员或用户；返回 false 表示按普通完成处理 */
  private handleHelpRequest(
    flow: Flow,
    room: Room,
    task: FlowTask,
    req: { to: string; question: string },
    output: string,
  ): boolean {
    const rounds = task.helpRounds ?? 0;
    if (rounds >= MAX_HELP_ROUNDS) {
      this.notice({
        roomId: flow.roomId,
        message: `@${room.members.find((m) => m.sessionId === task.sessionId)?.name ?? task.sessionId} 求助次数已达上限（${MAX_HELP_ROUNDS}），按当前输出收尾`,
      });
      return false;
    }
    const toRaw = req.to.trim();
    const toUser = toRaw === "" || /^(user|用户|我)$/i.test(toRaw);
    const target = toUser ? undefined : resolveMemberByString(room, toRaw);
    if (!toUser && (!target || target.sessionId === task.sessionId)) {
      this.notice({
        roomId: flow.roomId,
        message: `求助目标「${req.to}」无法解析，按当前输出继续`,
      });
      return false;
    }
    task.helpRounds = rounds + 1;
    const exchange: HelpExchange = {
      id: randomUUID().slice(0, 8),
      taskId: task.id,
      from: task.sessionId,
      to: toUser ? "user" : target!.sessionId,
      question: req.question,
      context: output.trim().slice(0, 800),
      status: "pending",
      dispatched: false,
    };
    flow.help.set(exchange.id, exchange);
    task.waitingForHelp = exchange.id;
    const fromName = room.members.find((m) => m.sessionId === task.sessionId)?.name ?? task.sessionId;
    if (toUser) {
      this.notice({
        roomId: flow.roomId,
        message: `🆘 @${fromName} 在任务 ${task.id} 向你求助：${req.question.slice(0, 300)}（回复任意消息即可答复）`,
      });
      this.emitFlow?.(flow.roomId);
      return true;
    }
    this.notice({
      roomId: flow.roomId,
      message: `🆘 @${fromName} 在任务 ${task.id} 向 @${target!.name} 求助：${req.question.slice(0, 160)}`,
    });
    this.dispatchPendingHelp(flow, room);
    this.ensureHelpDispatch(flow, room);
    this.emitFlow?.(flow.roomId);
    return true;
  }

  /** 把可派发的成员求助送出去；目标忙碌或有自己在跑的任务时留待下次调度 */
  private dispatchPendingHelp(flow: Flow, room: Room): void {
    for (const e of flow.help.values()) {
      if (e.status !== "pending" || e.dispatched) continue;
      const task = flow.tasks.get(e.taskId);
      if (!task || task.waitingForHelp !== e.id) {
        // 任务已被重新调度/结束，清理陈旧求助
        e.status = "answered";
        e.answer = "（任务已变更，求助未送出）";
        continue;
      }
      if (e.to === "user") continue;
      // 对方自己还有未完成任务时，先等它空闲
      const ownActive = [...flow.tasks.values()].some(
        (t) =>
          t.sessionId === e.to &&
          (t.status === "pending" || (t.status === "running" && !t.waitingForHelp)),
      );
      if (ownActive || this.agent.isBusy(e.to)) continue;
      e.dispatched = true;
      const fromName = room.members.find((m) => m.sessionId === e.from)?.name ?? e.from;
      const toName = room.members.find((m) => m.sessionId === e.to)?.name ?? e.to;
      const body = [
        `群聊「${room.name}」成员 @${fromName} 在执行子任务「${task.task.slice(0, 200)}」时向你求助：`,
        "",
        e.question,
        ...(e.context ? ["", `相关上下文：${e.context}`] : []),
        "",
        "请直接给出结论与依据；这不是派工，无需执行完整任务。",
      ].join("\n");
      const prompt = this.rooms.buildPrompt(room.roomId, body, e.to, undefined, undefined, {
        taskId: e.taskId,
      });
      this.agent.prompt(e.to, prompt).catch((err: unknown) => {
        e.dispatched = false;
        logError("conductor help dispatch", err);
        this.notice({
          roomId: flow.roomId,
          message: `向 @${toName} 转达求助失败，稍后重试`,
        });
        this.ensureHelpDispatch(flow, room);
      });
    }
  }

  /** 存在未派发的成员求助时，启动退避重试直到派发成功或流程结束 */
  private ensureHelpDispatch(flow: Flow, room: Room): void {
    if (flow.helpRetrying) return;
    const hasPending = [...flow.help.values()].some(
      (e) => e.status === "pending" && !e.dispatched && e.to !== "user",
    );
    if (!hasPending) return;
    flow.helpRetrying = true;
    setTimeout(() => {
      flow.helpRetrying = false;
      const f = this.flows.get(flow.roomId);
      if (!f || f.phase !== "working") return;
      this.dispatchPendingHelp(f, room);
      this.ensureHelpDispatch(f, room);
    }, this.promptRetryMs);
  }

  /** 求助获得答复后唤醒原 worker，把答案注入并让其继续完成任务 */
  private repromptAsker(flow: Flow, room: Room, e: HelpExchange): void {
    const task = flow.tasks.get(e.taskId);
    if (!task || task.status !== "running" || task.waitingForHelp !== e.id) return;
    delete task.waitingForHelp;
    const fromLabel =
      e.to === "user"
        ? "用户"
        : `@${room.members.find((m) => m.sessionId === e.to)?.name ?? e.to}`;
    const remaining = MAX_HELP_ROUNDS - (task.helpRounds ?? 0);
    const taskBody = [
      `你此前在执行子任务（id: ${task.id}）时向 ${fromLabel} 求助。`,
      `你的问题：${e.question}`,
      `${fromLabel} 的回复：${(e.answer ?? "（未获得回复）").slice(0, 2000)}`,
      "",
      `请据此继续完成子任务：${task.task}`,
      remaining > 0
        ? `若仍有关键阻塞可再次求助（剩余 ${remaining} 次）；否则完成任务并输出 artifact 报告 JSON。`
        : "请基于现有信息完成任务并输出 artifact 报告 JSON。",
    ].join("\n");
    const prompt = this.rooms.buildPrompt(room.roomId, taskBody, task.sessionId, undefined, undefined, {
      taskId: task.id,
      dependsOn: task.dependsOn,
    });
    this.agent.prompt(task.sessionId, prompt).catch((err: unknown) => {
      task.retries = (task.retries ?? 0) + 1;
      const msg = String(err);
      if (task.retries >= 3) {
        task.status = "failed";
        task.failureMessage = msg;
        this.emitFlow?.(flow.roomId);
        this.scheduleTasks(flow, room).catch((e2) =>
          logError("conductor schedule after help fail", e2),
        );
        return;
      }
      // 恢复等待标记后重试唤醒
      task.waitingForHelp = e.id;
      setTimeout(() => {
        const f = this.flows.get(flow.roomId);
        if (f) this.repromptAsker(f, room, e);
      }, this.promptRetryMs);
    });
    this.emitFlow?.(flow.roomId);
  }

  /** 把跨成员的 verify 声明记录到被验证任务上，并落一条 test 事件关联 taskId */
  private recordVerifications(
    flow: Flow,
    room: Room,
    verifierId: string,
    verifs: { taskId: string; verdict: string; evidence: string }[],
  ): void {
    const verifierName =
      room.members.find((m) => m.sessionId === verifierId)?.name ?? verifierId;
    for (const v of verifs) {
      const target = flow.tasks.get(v.taskId);
      // 只记录跨成员的独立验证，自我验证走正常 artifact
      if (!target || target.sessionId === verifierId) continue;
      (target.verifications ??= []).push({
        by: verifierId,
        verdict: v.verdict,
        evidence: v.evidence,
        at: Date.now(),
      });
      this.rooms.addEvent(flow.roomId, {
        author: verifierId,
        action: "test",
        summary: `验证任务 ${v.taskId}：${v.verdict}${v.evidence ? ` — ${v.evidence.slice(0, 160)}` : ""}`,
        taskId: v.taskId,
      });
      this.notice({
        roomId: flow.roomId,
        message: `🧪 @${verifierName} 对任务 ${v.taskId} 的独立验证：${v.verdict}`,
      });
    }
  }

  private resolveMember(
    room: Room,
    rawTo: string,
  ): { sessionId: string; name: string } | undefined {
    return resolveMemberByString(room, rawTo);
  }

  private async dispatch(flow: Flow, room: Room, conductorOutput: string): Promise<void> {
    const plan = parsePlan(conductorOutput, room);
    if (plan === null) {
      this.flows.delete(flow.roomId);
      this.notice({
        roomId: flow.roomId,
        message: "指挥家输出无法解析为任务计划，本轮编排已取消，请重试",
      });
      return;
    }
    if (typeof plan.goal === "string" && plan.goal.trim()) {
      flow.goal = plan.goal.trim();
    }
    if (plan.acceptanceCriteria.length > 0) {
      flow.acceptanceCriteria = plan.acceptanceCriteria;
    }
    const tasks = plan.tasks;
    if (tasks.length === 0) {
      this.flows.delete(flow.roomId);
      const answer = conductorOutput.replace(/```(?:json)?\s*[\s\S]*?```/gi, "").trim();
      this.notice({
        roomId: flow.roomId,
        message: answer || "指挥家判断本次任务无需派工",
      });
      return;
    }
    await this.dispatchFromTasks(flow, room, tasks);
  }

  private async dispatchFromTasks(
    flow: Flow,
    room: Room,
    tasks: ParsedTask[],
    originalText?: string,
  ): Promise<void> {
    if (tasks.length === 0) {
      this.flows.delete(flow.roomId);
      return;
    }
    flow.phase = "working";

    const idMap = new Map<string, string>();
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      if (!t.task.trim()) continue;
      const member = this.resolveMember(room, t.to);
      if (!member) {
        this.notice({ roomId: flow.roomId, message: `派工跳过：未知成员 ${t.to}` });
        continue;
      }
      const taskId = t.id?.trim() || `t${i + 1}`;
      const dependsOn = this.normalizeDependsOn(t.dependsOn, tasks, i, idMap, room);
      flow.tasks.set(taskId, {
        id: taskId,
        sessionId: member.sessionId,
        task: t.task.trim(),
        dependsOn,
        status: "pending",
        iteration: flow.iteration,
      });
      idMap.set(String(i), taskId);
    }

    if (flow.tasks.size === 0) {
      this.flows.delete(flow.roomId);
      return;
    }

    if (originalText) {
      this.notice({
        roomId: flow.roomId,
        message: `指挥家根据推荐直接派工：${originalText.slice(0, 80)}`,
      });
    }

    await this.scheduleTasks(flow, room);
  }

  private normalizeDependsOn(
    raw: string[] | undefined,
    tasks: { id?: string; to: string }[],
    currentIndex: number,
    idMap: Map<string, string>,
    room: Room,
  ): string[] {
    if (!raw || raw.length === 0) return [];
    const result = new Set<string>();
    for (const d of raw) {
      const dep = d.trim();
      if (!dep) continue;
      // 1. 直接是某个 task 的 id
      const byId = tasks.find((t, idx) => (t.id?.trim() || `t${idx + 1}`) === dep);
      if (byId) {
        result.add(dep);
        continue;
      }
      // 2. 通过索引引用，如 "t1" 或 "1"（历史索引）
      const prevIdx = Number(dep);
      if (!Number.isNaN(prevIdx) && prevIdx > 0 && prevIdx <= tasks.length) {
        const mapped = idMap.get(String(prevIdx - 1)) ?? `t${prevIdx}`;
        result.add(mapped);
        continue;
      }
      // 3. 按成员名/id 引用
      const member = resolveMemberByString(room, dep.replace(/^@/, ""));
      if (member) {
        // 找到分配给该成员的前一个任务
        const prev = tasks.findIndex((t, idx) => {
          const m = resolveMemberByString(room, t.to);
          return m?.sessionId === member.sessionId && idx < currentIndex;
        });
        if (prev >= 0) {
          result.add(idMap.get(String(prev)) ?? `t${prev + 1}`);
        }
      }
    }
    return [...result];
  }

  private runnableTasks(flow: Flow): FlowTask[] {
    const doneIds = new Set<string>();
    for (const [id, t] of flow.tasks) {
      if (t.status === "done") doneIds.add(id);
    }
    const runningSessions = new Set<string>();
    for (const t of flow.tasks.values()) {
      if (t.status === "running") runningSessions.add(t.sessionId);
    }
    const out: FlowTask[] = [];
    for (const t of flow.tasks.values()) {
      if (t.status !== "pending") continue;
      const depsDone = t.dependsOn.every((d) => doneIds.has(d));
      if (!depsDone) continue;
      if (runningSessions.has(t.sessionId)) continue;
      out.push(t);
    }
    return out;
  }

  private async scheduleTasks(flow: Flow, room: Room): Promise<void> {
    if (!this.flows.has(flow.roomId)) return;

    // 先把可派发的求助送出去（目标空闲且无自己在跑的任务）
    this.dispatchPendingHelp(flow, room);
    this.ensureHelpDispatch(flow, room);

    // 依赖失败传播：任何 failed task 的下游 pending task 标记为 failed
    const failedIds = new Set<string>();
    for (const [id, t] of flow.tasks) {
      if (t.status === "failed") failedIds.add(id);
    }
    if (failedIds.size > 0) {
      let propagated = false;
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, t] of flow.tasks) {
          if (t.status !== "pending") continue;
          if (t.dependsOn.some((d) => failedIds.has(d))) {
            t.status = "failed";
            t.failureMessage = "前置依赖任务失败";
            failedIds.add(id);
            changed = true;
            propagated = true;
          }
        }
      }
      if (propagated) this.emitFlow?.(flow.roomId);
    }

    const tasks = this.runnableTasks(flow);
    if (tasks.length === 0) {
      const values = [...flow.tasks.values()];
      const hasActive = values.some((t) => t.status === "running");
      if (hasActive) return;
      const doneCount = values.filter((t) => t.status === "done").length;
      const failedCount = values.filter((t) => t.status === "failed").length;
      if (doneCount > 0) {
        if (failedCount === 0) {
          await this.review(flow, room);
        } else {
          await this.summarize(flow, room);
        }
      } else {
        const failedTasks = values.filter((t) => t.status === "failed");
        const names = failedTasks.map((t) => room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId);
        this.notice({
          roomId: flow.roomId,
          message: `所有子任务均失败（${names.join("、")}），无法汇总`,
        });
        flow.phase = "done";
        this.emitFlow?.(flow.roomId);
        this.flows.delete(flow.roomId);
      }
      return;
    }

    const assignments: string[] = [];
    let skippedBusy = false;
    for (const t of tasks) {
      if (this.agent.isBusy(t.sessionId)) {
        skippedBusy = true;
        continue;
      }
      t.status = "running";
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
      assignments.push(`@${name}：${t.task}`);
      const taskRefs = this.rooms.parseArtifactRefs(room.roomId, t.task);
      const refs =
        taskRefs.length > 0
          ? [...new Set([...(flow.artifactContext?.refs ?? []), ...taskRefs])]
          : flow.artifactContext?.refs;
      const artifactContext = refs && refs.length > 0
        ? { taskId: t.id, dependsOn: t.dependsOn, ...(flow.artifactContext ?? {}), refs }
        : { taskId: t.id, dependsOn: t.dependsOn, ...(flow.artifactContext ?? {}) };
      const upstreamLines: string[] = [];
      for (const depId of t.dependsOn) {
        const depResult = flow.results.get(depId);
        if (!depResult) continue;
        const depTask = flow.tasks.get(depId);
        const depName = depTask
          ? room.members.find((m) => m.sessionId === depTask.sessionId)?.name ?? depTask.sessionId
          : depId;
        upstreamLines.push(`- [${depId}] @${depName}：${depResult.text.slice(0, PLAN_RESULT_LEN)}`);
        for (const a of depResult.artifacts) {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          upstreamLines.push(`  artifacts: ${parts.join(" ")}`);
        }
      }
      const taskBody = [
        ...(upstreamLines.length > 0
          ? [
              "前置任务结果（这是你的直接输入，请在此基础上继续）：",
              ...upstreamLines,
              "",
            ]
          : []),
        `指挥家派发给你的子任务（id: ${t.id}）：${t.task}`,
        ...(flow.supplements.length > 0
          ? [
              "",
              "用户在执行中补充了要求（请遵循）：",
              ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
            ]
          : []),
        "",
        "你拥有该子任务的端到端责任；若当前 Agent 支持 Fusion 或内部子代理，可用于本任务内的探索、实现和验证，但不要把工作再次分派给群聊中的其他成员。",
        "",
        "协作约定：",
        "- 如遇阻塞需要他人关键信息，在输出末尾附一个求助块并结束本轮，Hub 会把回复转回给你后继续；",
        '  ```json',
        '  {"help":{"to":"成员名/id 或 \\"user\\"（求助用户）","question":"具体问题"}}',
        '  ```',
        '- 若你的产出是对其他成员任务的独立验证，请在报告 JSON 中附加 verify 数组：{"verify":[{"task":"tX","verdict":"pass|fail|partial","evidence":"证据"}]}',
        "",
        "完成子任务后，请在自由文本总结后附带一个 JSON code block 报告你产生的 artifact（修改的文件、执行的命令、测试等）：",
        '```json',
        '{"text":"你的总结","artifacts":[{"type":"file","path":"/path/to/file","summary":"改动摘要"},{"type":"command","summary":"运行的命令和结果"},{"type":"test","summary":"测试结果"}]}',
        '```',
        "",
        "如果没有 artifact，可以只输出文本，不必输出 JSON。",
      ].join("\n");
      const prompt = this.rooms.buildPrompt(
        room.roomId,
        taskBody,
        t.sessionId,
        undefined,
        undefined,
        artifactContext,
      );
      this.agent.prompt(t.sessionId, prompt).catch((err: unknown) => {
        t.retries = (t.retries ?? 0) + 1;
        const msg = String(err);
        if (t.retries >= 3) {
          t.status = "failed";
          t.failureMessage = msg;
        } else {
          t.status = "pending";
        }
        this.notice({
          roomId: flow.roomId,
          message: `子任务派发失败（重试 ${t.retries}/3）：${msg}`,
        });
        setTimeout(() => {
          if (!this.flows.has(flow.roomId)) return;
          this.scheduleTasks(flow, room).catch((e) => {
            logError("conductor schedule after fail", e);
          });
        }, this.promptRetryMs);
      });
    }

    if (assignments.length > 0) {
      this.notice({ roomId: flow.roomId, message: `指挥家派工：${assignments.join("；")}` });
    }

    // Bug 4: 有 runnable task 因 isBusy 被跳过时，定时轮询重试
    if (skippedBusy) {
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        this.scheduleTasks(flow, room).catch((e) =>
          logError("conductor busy retry reschedule", e),
        );
      }, BUSY_RETRY_MS);
    }

    this.emitFlow?.(flow.roomId);
  }

  private appendTasks(flow: Flow, room: Room, tasks: ParsedTask[]): number {
    let added = 0;
    const assigned = new Set<string>();
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]!;
      if (!t.task.trim()) continue;
      const member = this.resolveMember(room, t.to);
      if (!member) continue;
      let taskId = t.id?.trim() || `r${flow.iteration}t${i + 1}`;
      if (flow.tasks.has(taskId) || assigned.has(taskId)) {
        taskId = `r${flow.iteration}t${i + 1}`;
      }
      while (flow.tasks.has(taskId) || assigned.has(taskId)) taskId = `${taskId}x`;
      const dependsOn = [...new Set(
        (t.dependsOn ?? [])
          .map((d) => d.trim())
          .filter((d) => d && d !== taskId && (flow.tasks.has(d) || assigned.has(d))),
      )];
      flow.tasks.set(taskId, {
        id: taskId,
        sessionId: member.sessionId,
        task: t.task.trim(),
        dependsOn,
        status: "pending",
        iteration: flow.iteration,
      });
      assigned.add(taskId);
      added++;
    }
    return added;
  }

  private async review(flow: Flow, room: Room): Promise<void> {
    if (flow.phase !== "working" && flow.phase !== "reviewing") return;
    if (flow.phase === "reviewing" && this.agent.isBusy(room.conductorId!)) return;
    flow.phase = "reviewing";
    this.emitFlow?.(flow.roomId);
    this.notice({
      roomId: flow.roomId,
      message: `第 ${flow.iteration}/${flow.maxIterations} 轮任务完成，指挥家验收中…`,
    });
    const lines: string[] = [];
    for (const t of flow.tasks.values()) {
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
      const result = flow.results.get(t.id);
      if (!result) continue;
      const artifacts = result.artifacts
        .map((a) => {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary.slice(0, 1000));
          return `    - ${parts.join(" ")}`;
        })
        .join("\n");
      const verifs = (t.verifications ?? [])
        .map(
          (v) =>
            `    - @${room.members.find((m) => m.sessionId === v.by)?.name ?? v.by}：${v.verdict}${v.evidence ? `（${v.evidence.slice(0, 300)}）` : ""}`,
        )
        .join("\n");
      lines.push([
        `- [${t.id}] @${name}: ${result.text.slice(0, PLAN_RESULT_LEN)}`,
        ...(result.artifacts.length > 0 ? ["  artifacts:", artifacts] : []),
        ...(verifs ? ["  独立验证:", verifs] : []),
      ].join("\n"));
    }
    const criteria = flow.acceptanceCriteria.length > 0
      ? flow.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "（未提供，按用户目标自行判断）";
    const prompt = [
      `你是群聊「${room.name}」的指挥家。`,
      "",
      `原始目标：${flow.goal || "（未记录）"}`,
      "",
      "验收标准：",
      criteria,
      "",
      `第 ${flow.iteration}/${flow.maxIterations} 轮子任务已全部完成，结果如下：`,
      ...lines,
      ...(flow.supplements.length > 0
        ? [
            "",
            "用户在执行中补充的要求（验收时请一并核查）：",
            ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
          ]
        : []),
      "",
      "请对照验收标准逐条核查以上结果是否已满足目标。",
      "不要调用任何工具，只输出一个 JSON code block，二选一：",
      '```json',
      '{"decision":"complete","reason":"为什么已经满足全部验收标准"}',
      '```',
      "或",
      '```json',
      '{"decision":"continue","reason":"尚缺什么","tasks":[{"id":"可选","to":"成员 id/名称","task":"明确返工或补充任务","dependsOn":["已有或本轮任务 id"]}]}',
      '```',
      "要求：只针对验收缺口派最少的任务，不要重复已完成的工作。",
      `可派工的成员：${this.buildMemberList(room)}。`,
    ].join("\n");
    try {
      await this.agent.prompt(room.conductorId!, prompt);
    } catch (err) {
      logError("conductor review prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家验收派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        if (flow.phase !== "reviewing") return;
        this.review(flow, room).catch((e) => logError("conductor review retry", e));
      }, this.promptRetryMs);
    }
  }

  private async handleReview(flow: Flow, room: Room, output: string): Promise<void> {
    const decision = parseReviewDecision(output, room);
    if (decision?.decision === "complete") {
      flow.reviewReason = decision.reason;
      await this.summarize(flow, room);
      return;
    }
    if (
      decision?.decision === "continue" &&
      decision.tasks.length > 0 &&
      flow.iteration < flow.maxIterations
    ) {
      flow.iteration += 1;
      flow.reviewReason = decision.reason;
      const added = this.appendTasks(flow, room, decision.tasks);
      if (added > 0) {
        flow.phase = "working";
        this.emitFlow?.(flow.roomId);
        this.notice({
          roomId: flow.roomId,
          message: `验收未通过：${decision.reason}。新增 ${added} 项任务，进入第 ${flow.iteration}/${flow.maxIterations} 轮`,
        });
        await this.scheduleTasks(flow, room);
        return;
      }
    }
    if (decision) flow.reviewReason = decision.reason;
    const hitLimit = flow.iteration >= flow.maxIterations;
    this.notice({
      roomId: flow.roomId,
      message: hitLimit
        ? `达到迭代上限（${flow.maxIterations} 轮），指挥家汇总当前成果`
        : "验收决策无法执行，指挥家汇总当前成果",
    });
    await this.summarize(flow, room);
  }

  private async summarize(flow: Flow, room: Room): Promise<void> {
    if (flow.phase !== "working" && flow.phase !== "reviewing" && flow.phase !== "summarizing") return;
    if (flow.phase === "summarizing" && this.agent.isBusy(room.conductorId!)) return;
    flow.phase = "summarizing";
    this.emitFlow?.(flow.roomId);
    const failedTasks = [...flow.tasks.values()].filter((t) => t.status === "failed");
    const hasFailures = failedTasks.length > 0;
    // 按照 task 在 tasks Map 中的创建顺序（即指挥家给出的顺序）生成汇总
    const lines: string[] = [];
    for (const t of flow.tasks.values()) {
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
      if (t.status === "failed") {
        lines.push(`- [${t.id}] @${name}: 失败（${t.failureMessage ?? "未知原因"}）`);
        continue;
      }
      const result = flow.results.get(t.id);
      if (!result) continue;
      const artifacts = result.artifacts
        .map((a) => {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary.slice(0, 1000));
          return `    - ${parts.join(" ")}`;
        })
        .join("\n");
      const verifs = (t.verifications ?? [])
        .map(
          (v) =>
            `    - @${room.members.find((m) => m.sessionId === v.by)?.name ?? v.by}：${v.verdict}${v.evidence ? `（${v.evidence.slice(0, 300)}）` : ""}`,
        )
        .join("\n");
      lines.push([
        `- [${t.id}] @${name}: ${result.text.slice(0, PLAN_RESULT_LEN)}`,
        ...(result.artifacts.length > 0 ? ["  artifacts:", artifacts] : []),
        ...(verifs ? ["  独立验证:", verifs] : []),
      ].join("\n"));
    }
    const promptLines: string[] = [
      `你是群聊「${room.name}」的指挥家。`,
      `原始目标：${flow.goal || "（未记录）"}`,
      `验收标准：${flow.acceptanceCriteria.length > 0 ? flow.acceptanceCriteria.join("；") : "（未提供）"}`,
      ...(flow.reviewReason ? [`验收结论：${flow.reviewReason}`] : []),
      hasFailures
        ? `你之前派发的子任务部分完成、部分失败，结果如下：`
        : `你之前派发的子任务已全部完成，结果如下：`,
      ...lines,
      ...(flow.supplements.length > 0
        ? [
            "",
            "用户在执行中补充的要求：",
            ...flow.supplements.map((s) => `- ${s.text.slice(0, 400)}`),
          ]
        : []),
      "",
    ];
    if (hasFailures) {
      const failedNames = failedTasks
        .map((t) => room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId)
        .join("、");
      promptLines.push(
        `以下子任务未能完成：${failedNames}。`,
        "请在汇总中：",
        "1. 基于已完成的子任务给出可交付的部分成果；",
        "2. 明确标注哪些部分未完成及其影响；",
        "3. 建议用户是否需要重新派发失败的部分。",
        "",
      );
    }
    promptLines.push(
      "请根据各成员返回的结果和 artifact 汇总，向用户给出最终答复：明确说明完成了什么、有哪些验证证据、以及尚未满足的验收缺口。如果涉及文件修改，请引用文件路径。",
    );
    const prompt = promptLines.join("\n");
    this.notice({
      roomId: flow.roomId,
      message: hasFailures ? "子任务部分完成，指挥家降级汇总中…" : "子任务全部完成，指挥家汇总中…",
    });
    try {
      await this.agent.prompt(room.conductorId!, prompt);
    } catch (err) {
      logError("conductor summarize prompt", err);
      this.notice({ roomId: flow.roomId, message: `指挥家汇总派发失败，${this.promptRetryMs / 1000}s 后重试：${String(err)}` });
      setTimeout(() => {
        if (!this.flows.has(flow.roomId)) return;
        if (flow.phase !== "summarizing") return;
        this.summarize(flow, room).catch((e) => logError("conductor summarize retry", e));
      }, this.promptRetryMs);
    }
  }

  /** agent 连接后恢复所有活跃 flow 的调度（Fix C）。 */
  resumeFlows(): void {
    for (const flow of this.flows.values()) {
      const room = this.rooms.get(flow.roomId);
      if (!room) continue;
      if (flow.phase === "summarizing") {
        this.summarize(flow, room).catch((e) => logError("conductor resume summarize", e));
      } else if (flow.phase === "reviewing") {
        this.review(flow, room).catch((e) => logError("conductor resume review", e));
      } else if (flow.phase === "working") {
        this.scheduleTasks(flow, room).catch((e) => logError("conductor resume schedule", e));
      }
    }
  }

  /** 检查房间是否有等待重试的 flow */
  hasAwaitingRetry(roomId: string): boolean {
    const flow = this.flows.get(roomId);
    return flow?.phase === "awaiting-retry";
  }

  /** 重试失败的子任务：把 failed 任务回退为 pending 并重新调度 */
  retryFailedTasks(roomId: string, taskIds?: string[]): boolean {
    const flow = this.flows.get(roomId);
    if (!flow || flow.phase !== "awaiting-retry") return false;
    const room = this.rooms.get(roomId);
    if (!room) {
      this.flows.delete(roomId);
      return false;
    }
    const failed = [...flow.tasks.values()].filter(
      (t) => t.status === "failed" && (!taskIds || taskIds.includes(t.id)),
    );
    if (failed.length === 0) return false;
    for (const t of failed) {
      t.status = "pending";
      delete t.failureMessage;
      t.retries = 0;
    }
    flow.phase = "working";
    this.emitFlow?.(roomId);
    const failedIds = failed.map((t) => t.id);
    this.notice({ roomId, message: `重试失败子任务：${failedIds.join(", ")}` });
    this.scheduleTasks(flow, room).catch((e) => logError("conductor retry schedule", e));
    return true;
  }

  export(): Record<string, unknown> {
    return {
      flows: [...this.flows.values()].map((flow) => ({
        roomId: flow.roomId,
        phase: flow.phase,
        goal: flow.goal,
        acceptanceCriteria: flow.acceptanceCriteria,
        iteration: flow.iteration,
        maxIterations: flow.maxIterations,
        ...(flow.reviewReason !== undefined ? { reviewReason: flow.reviewReason } : {}),
        tasks: [...flow.tasks.values()].map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          task: t.task,
          dependsOn: t.dependsOn,
          status: t.status,
          iteration: t.iteration,
          ...(t.failureMessage !== undefined ? { failureMessage: t.failureMessage } : {}),
          ...(t.retries !== undefined ? { retries: t.retries } : {}),
          ...(t.helpRounds !== undefined ? { helpRounds: t.helpRounds } : {}),
          ...(t.waitingForHelp !== undefined ? { waitingForHelp: t.waitingForHelp } : {}),
          ...(t.verifications !== undefined ? { verifications: t.verifications } : {}),
        })),
        supplements: flow.supplements,
        help: [...flow.help.values()],
        results: Object.fromEntries(
          [...flow.results.entries()].map(([id, r]) => [id, { text: r.text, artifacts: r.artifacts }]),
        ),
        artifactContext: flow.artifactContext,
      })),
    };
  }

  async import(state: Record<string, unknown>): Promise<void> {
    const flows = state.flows;
    if (!Array.isArray(flows)) return;
    for (const raw of flows) {
      const f = raw as Record<string, unknown>;
      const roomId = String(f.roomId ?? "");
      const room = this.rooms.get(roomId);
      if (!room || !room.conductorId) continue;
      const refsArr = Array.isArray((f.artifactContext as Record<string, unknown>)?.refs)
        ? ((f.artifactContext as Record<string, unknown>).refs as unknown[]).map((s) => String(s)).filter(Boolean)
        : [];
      const artifactContext = f.artifactContext && typeof f.artifactContext === "object" && refsArr.length > 0
        ? { refs: refsArr }
        : undefined;
      const flow: Flow = {
        roomId,
        phase: (f.phase as Flow["phase"]) ?? "working",
        goal: typeof f.goal === "string" ? f.goal : "",
        acceptanceCriteria: Array.isArray(f.acceptanceCriteria)
          ? f.acceptanceCriteria.map((s) => String(s)).filter(Boolean)
          : [...DEFAULT_ACCEPTANCE_CRITERIA],
        iteration: typeof f.iteration === "number" && f.iteration > 0 ? f.iteration : 1,
        maxIterations:
          typeof f.maxIterations === "number" && f.maxIterations > 0
            ? f.maxIterations
            : MAX_ITERATIONS,
        tasks: new Map(),
        results: new Map(),
        artifactContext,
        supplements: Array.isArray(f.supplements)
          ? f.supplements
              .map((s) => ({ text: String((s as Record<string, unknown>)?.text ?? ""), at: Number((s as Record<string, unknown>)?.at ?? 0) }))
              .filter((s) => s.text)
          : [],
        help: new Map(),
        ...(typeof f.reviewReason === "string" ? { reviewReason: f.reviewReason } : {}),
      };
      for (const t of (f.tasks as unknown[]) ?? []) {
        const o = t as Record<string, unknown>;
        const taskId = String(o.id ?? "");
        if (!taskId) continue;
        const sessionId = String(o.sessionId ?? "");
        if (!room.members.some((m) => m.sessionId === sessionId)) continue;
        const rawStatus = String(o.status ?? "pending");
        const status: FlowTask["status"] =
          rawStatus === "done" || rawStatus === "failed" ? rawStatus : "pending";
        flow.tasks.set(taskId, {
          id: taskId,
          sessionId,
          task: String(o.task ?? ""),
          dependsOn: Array.isArray(o.dependsOn)
            ? o.dependsOn.map((s) => String(s)).filter(Boolean)
            : [],
          status,
          iteration: typeof o.iteration === "number" && o.iteration > 0 ? o.iteration : 1,
          ...(typeof o.failureMessage === "string" ? { failureMessage: o.failureMessage } : {}),
          ...(typeof o.retries === "number" ? { retries: o.retries } : {}),
          ...(typeof o.helpRounds === "number" ? { helpRounds: o.helpRounds } : {}),
          ...(Array.isArray(o.verifications)
            ? {
                verifications: o.verifications
                  .map((v) => {
                    const vo = v as Record<string, unknown>;
                    return {
                      by: String(vo.by ?? ""),
                      verdict: String(vo.verdict ?? ""),
                      evidence: String(vo.evidence ?? ""),
                      at: Number(vo.at ?? 0),
                    };
                  })
                  .filter((v) => v.by && v.verdict),
              }
            : {}),
        });
      }
      // 恢复求助交换：成员求助重新标记为未派发，等 scheduleTasks 重新送出
      for (const rawHelp of (f.help as unknown[]) ?? []) {
        const h = rawHelp as Record<string, unknown>;
        const taskId = String(h.taskId ?? "");
        const from = String(h.from ?? "");
        const to = String(h.to ?? "");
        const question = String(h.question ?? "");
        if (!taskId || !from || !to || !question) continue;
        const status = h.status === "answered" ? "answered" : "pending";
        const id = String(h.id ?? randomUUID().slice(0, 8));
        flow.help.set(id, {
          id,
          taskId,
          from,
          to,
          question,
          ...(typeof h.context === "string" ? { context: h.context } : {}),
          ...(typeof h.answer === "string" ? { answer: h.answer } : {}),
          status,
          dispatched: false,
        });
        // 等待中的任务恢复为 running 挂起，避免被重新派发丢失求助上下文
        const waitingTask = flow.tasks.get(taskId);
        if (status === "pending" && waitingTask && waitingTask.status === "pending" && waitingTask.sessionId === from) {
          waitingTask.status = "running";
          waitingTask.waitingForHelp = id;
        }
      }
      const results = f.results as Record<string, { text: string; artifacts: TaskArtifact[] }> | undefined;
      if (results) {
        for (const [id, r] of Object.entries(results)) {
          if (typeof r.text !== "string") continue;
          flow.results.set(id, {
            text: r.text,
            artifacts: Array.isArray(r.artifacts)
              ? r.artifacts
                  .map((a) => {
                    const o = a as Record<string, unknown>;
                    const rawType = String(o.type ?? "");
                    let type: TaskArtifact["type"];
                    if (rawType === "file") type = "file";
                    else if (rawType === "event" || rawType === "command" || rawType === "test") type = "event";
                    else return null;
                    const action = isEventAction(String(o.action ?? "")) ? String(o.action) : undefined;
                    return { type, action, path: typeof o.path === "string" ? o.path : undefined, summary: String(o.summary ?? "") };
                  })
                  .filter((a) => a !== null) as TaskArtifact[]
              : [],
          });
        }
      }
      this.flows.set(roomId, flow);
      this.notice({ roomId, message: "🔄 已恢复指挥编排，继续执行待派发任务" });
      if (flow.phase === "reviewing") {
        await this.review(flow, room).catch((err) => logError("conductor import review", err));
      } else if (flow.phase === "summarizing") {
        await this.summarize(flow, room).catch((err) => logError("conductor import summarize", err));
      } else {
        await this.scheduleTasks(flow, room).catch((err) => {
          logError("conductor import schedule", err);
        });
      }
      this.emitFlow?.(roomId);
    }
  }
}

function extractTaskResult(output: string): TaskResult {
  // 1. 尝试提取 `text` 与 `artifacts` JSON code fence
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const text = typeof obj.text === "string" ? obj.text.trim() : "";
      const artifacts: TaskArtifact[] = [];
      if (Array.isArray(obj.artifacts)) {
        for (const a of obj.artifacts) {
          const o = a as Record<string, unknown>;
          let type = String(o.type ?? "");
          if (type !== "file" && type !== "event") {
            // 兼容旧 kind：command / test / note 转为 event
            if (type === "command" || type === "test" || type === "note") type = "event";
            else continue;
          }
          const path = typeof o.path === "string" ? o.path : undefined;
          const summary = typeof o.summary === "string" ? o.summary : "";
          if (path || summary) {
            artifacts.push({
              type: type as TaskArtifact["type"],
              action: type === "event" ? (typeof o.action === "string" ? o.action : undefined) : undefined,
              path,
              summary,
            });
          }
        }
      }
      const verifications: NonNullable<TaskResult["verifications"]> = [];
      const rawVerify = obj.verify ?? obj.verifications;
      const vList = Array.isArray(rawVerify) ? rawVerify : rawVerify ? [rawVerify] : [];
      for (const v of vList) {
        const vo = v as Record<string, unknown>;
        const taskId = String(vo.task ?? vo.taskId ?? vo.id ?? "").trim();
        const verdict = String(vo.verdict ?? vo.result ?? "").trim() || "pass";
        const evidence = String(vo.evidence ?? vo.summary ?? vo.detail ?? "").trim();
        if (taskId) verifications.push({ taskId, verdict, evidence });
      }
      if (text || artifacts.length > 0 || verifications.length > 0) {
        // 去掉 JSON code fence 后的内容作为额外文本
        const plain = output.replace(fenceRe, "").trim().replace(/\s+/g, " ");
        return {
          text: text || plain.slice(0, PLAN_RESULT_LEN),
          artifacts,
          ...(verifications.length > 0 ? { verifications } : {}),
        };
      }
    } catch {
      // 继续尝试下一个候选
    }
  }

  // 2. 没有合法 artifact JSON 时，自动扫描 diff 和命令
  const autoArtifacts: TaskArtifact[] = [];

  // 2.1 扫描 ```bash / ```shell 代码块作为 command 事件
  const shellRe = /```(?:bash|shell|sh)\s*([\s\S]*?)```/g;
  let sm: RegExpExecArray | null;
  while ((sm = shellRe.exec(output)) !== null) {
    const cmd = sm[1]?.trim();
    if (cmd) {
      autoArtifacts.push({ type: "event", action: "command", summary: cmd.slice(0, 200) });
    }
  }

  // 2.2 扫描 diff 输出块
  const diffRe = /(diff --git[\s\S]*?(?=\n```|\n\n\n|$))/g;
  let dm: RegExpExecArray | null;
  while ((dm = diffRe.exec(output)) !== null) {
    const diff = dm[1]?.trim();
    if (diff && diff.length > 20) {
      const path = extractDiffPath(diff);
      if (path && !isNoisePath(path)) {
        autoArtifacts.push({ type: "file", path, summary: diff.slice(0, 10000), content: diff });
      }
    }
  }

  // 2.3 扫描测试相关结果
  const testResultRe = /(\d+)\s*(passed|failed|skipped|pending)/gi;
  let tm: RegExpExecArray | null;
  const testResults: string[] = [];
  while ((tm = testResultRe.exec(output)) !== null) {
    if (tm[1] && tm[2]) testResults.push(`${tm[1]} ${tm[2].toLowerCase()}`);
  }
  if (testResults.length > 0) {
    autoArtifacts.push({ type: "event", action: "test", summary: testResults.slice(0, 5).join(", ") });
  }
  const testPathRe = /\b(?:test|tests|__tests__)\/([A-Za-z0-9_\-/.]+\.[a-zA-Z0-9]+)\b/g;
  const testPaths = new Set<string>();
  while ((tm = testPathRe.exec(output)) !== null) {
    const p = tm[0];
    if (!isNoisePath(p)) testPaths.add(p);
  }
  for (const p of [...testPaths].slice(0, 5)) {
    autoArtifacts.push({ type: "event", action: "test", path: p, summary: "测试文件" });
  }

  const artifacts: TaskArtifact[] = autoArtifacts.slice(0, 10);

  // 3. 兜底：返回截断文本
  return {
    text: output.trim().replace(/\s+/g, " ").slice(0, PLAN_RESULT_LEN),
    artifacts,
  };
}

function extractDiffPath(diff: string): string | undefined {
  const m = diff.match(/diff --git a\/(\S+)/);
  return m?.[1];
}

function isNoisePath(path: string): boolean {
  return /(?:^|\/)(node_modules|\.gradle|\.git|build|dist)(?:\/|$)/i.test(path);
}

function jsonCandidates(output: string, marker: string): string[] {
  const candidates: string[] = [];

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  if (candidates.length === 0) {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < output.length; i++) {
      const ch = output[i];
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && start >= 0) {
          const raw = output.slice(start, i + 1);
          if (raw.includes(marker)) candidates.push(raw);
          start = -1;
        }
      }
    }
  }
  return candidates;
}

function resolveParsedTasks(raw: unknown, room: Room): ParsedTask[] | null {
  if (!Array.isArray(raw)) return null;
  const tasks = raw
    .map((t: unknown) => {
      const o = t as Record<string, unknown>;
      if (typeof o?.to !== "string" || typeof o?.task !== "string") return null;
      const toRaw = o.to.replace(/^@/, "").trim();
      const taskRaw = String(o.task).trim();
      if (!taskRaw) return null;
      // 允许 to 使用成员名、name (id: xxx) 或 sessionId
      const member = resolveMemberByString(room, toRaw);
      if (!member) return null;
      const id = typeof o.id === "string" ? o.id : undefined;
      const dependsOn = Array.isArray(o.dependsOn)
        ? o.dependsOn.map((s) => String(s)).filter(Boolean)
        : undefined;
      return { id, to: member.sessionId, task: taskRaw, dependsOn };
    })
    .filter((t) => t !== null);
  return tasks as ParsedTask[];
}

function parsePlan(output: string, room: Room): ConductorPlan | null {
  for (const raw of jsonCandidates(output, '"tasks"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const tasks = resolveParsedTasks(obj.tasks, room);
      if (tasks === null) continue;
      const goal = typeof obj.goal === "string" ? obj.goal : undefined;
      const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
        ? obj.acceptanceCriteria
            .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
            .map((s) => s.trim())
        : [];
      return { goal, acceptanceCriteria, tasks };
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function parseReviewDecision(output: string, room: Room): ReviewDecision | null {
  for (const raw of jsonCandidates(output, '"decision"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const decision = obj.decision;
      const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
      if (decision === "complete") {
        return { decision: "complete", reason };
      }
      if (decision === "continue") {
        return { decision: "continue", reason, tasks: resolveParsedTasks(obj.tasks, room) ?? [] };
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function parseTasks(output: string, room: Room): ParsedTask[] | null {
  return parsePlan(output, room)?.tasks ?? null;
}

export function resolveMemberByString(
  room: Room,
  raw: string,
): { sessionId: string; name: string } | undefined {
  const to = raw.replace(/^@/, "").trim();
  if (!to) return undefined;
  // 优先从 "name (id: xxx)" 中提取 id
  const idMatch = to.match(/id:\s*([^\s)]+)/);
  if (idMatch) {
    const member = room.members.find((m) => m.sessionId === idMatch[1]);
    if (member) return member;
  }
  // 精确 sessionId
  const byId = room.members.find((m) => m.sessionId === to);
  if (byId) return byId;
  // 精确名字（去重后）
  const byName = room.members.find((m) => m.name === to);
  if (byName) return byName;
  // 前缀/子串匹配，用于 agent 只写了名字一部分的场景
  const byPrefix = room.members.find(
    (m) => m.name.toLowerCase().startsWith(to.toLowerCase()),
  );
  if (byPrefix) return byPrefix;
  return room.members.find((m) => m.name.toLowerCase().includes(to.toLowerCase()));
}

/** 从 worker 输出中提取定向求助块：{"help":{"to":"成员|user","question":"..."}} */
export function extractHelpRequest(
  output: string,
): { to: string; question: string } | undefined {
  for (const raw of jsonCandidates(output, '"help"')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const help =
        typeof obj.help === "object" && obj.help !== null
          ? (obj.help as Record<string, unknown>)
          : obj.type === "help"
            ? obj
            : undefined;
      if (!help) continue;
      const question = String(help.question ?? help.q ?? "").trim();
      if (!question) continue;
      return { to: String(help.to ?? "").trim(), question };
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

export { parseTasks, extractTaskResult };
export type { TaskArtifact, TaskResult };
// conductor-dispatch: verified by agent-hub
// t2: 在 t1 确定的文件末尾追加此注释，标记子任务 t2 已完成
