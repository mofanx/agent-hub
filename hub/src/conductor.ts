import type { Room, RoomManager } from "./room.js";
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
};

type FlowTask = {
  id: string;
  sessionId: string;
  task: string;
  dependsOn: string[];
  status: "pending" | "running" | "done" | "failed";
  failureMessage?: string;
  retries?: number;
};

type Flow = {
  roomId: string;
  phase: "planning" | "working" | "summarizing" | "done";
  /** 任务以 taskId 为 key */
  tasks: Map<string, FlowTask>;
  /** 结果以 taskId 为 key */
  results: Map<string, TaskResult>;
  artifactContext?: { refs?: string[] } | undefined;
};

export type ConductorNotice = { roomId: string; message: string };

const PLAN_RESULT_LEN = 4000;

export class ConductorOrchestrator {
  private flows = new Map<string, Flow>();

  constructor(
    private readonly agent: AgentOps,
    private readonly rooms: RoomManager,
    private readonly notice: (n: ConductorNotice) => void,
  ) {}

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
      return {
        id: t.id,
        sessionId: t.sessionId,
        name: room?.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId,
        status: t.status,
        task: t.task,
        dependsOn: t.dependsOn,
        artifacts: result?.artifacts ?? [],
      };
    });
    const done = tasks.filter((t) => t.status === "done").length;
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    const failed = tasks.filter((t) => t.status === "failed").length;
    return {
      roomId: flow.roomId,
      phase: flow.phase,
      progress: { done, running, pending, failed, total: tasks.length },
      tasks,
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
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          running.status = "pending";
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
    if (others.length === 0) return '{"tasks":[]}';
    const sample = others.slice(0, 2).map((m, i) =>
      JSON.stringify({ to: m.sessionId, task: i === 0 ? "先处理第一个子任务" : "再处理第二个子任务" })
    );
    return `{"tasks":[${sample.join(",")}]}`;
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
      this.flows.set(room.roomId, {
        roomId: room.roomId,
        phase: "planning",
        tasks: new Map(),
        results: new Map(),
        artifactContext,
      });
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
      "",
      "输出格式要求（必须严格遵守）：",
      "1. 仅输出一个 JSON code block，不要有任何解释、前言、总结或 markdown 列表。",
      "2. JSON 顶层字段必须是 `tasks`，值为数组。",
      "3. 每个任务对象包含 `to`（接收成员）、`task`（具体子任务描述），可选 `id`（任务标识）和 `dependsOn`（依赖的 id 数组）。",
      "4. `to` 可以是：成员 ID（括号里的 `id:...`）、`@成员名` 或成员名。",
      "5. `task` 必须具体、可执行，不要写占位符。",
      "6. 如果任务有依赖关系，请用 `dependsOn` 指定前置任务 `id`。",
      "7. 如果任务简单、无需分工，输出 `{\"tasks\":[]}` 并在 code block 之前直接写出你的最终回答。",
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
          const parts = [`@${a.author}`, `[${a.kind}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          prompt.push(`- ${parts.join(" ")}`);
        }
      }
    }
    const promptText = prompt.join("\n");
    this.flows.set(room.roomId, {
      roomId: room.roomId,
      phase: "planning",
      tasks: new Map(),
      results: new Map(),
      artifactContext,
    });
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
        if (flow.phase === "summarizing") {
          const roomId = flow.roomId;
          const name =
            room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
          const result = extractTaskResult(output);
          for (const a of result.artifacts) {
            this.rooms.addArtifact(roomId, {
              kind: a.type,
              action: a.action,
              author: name,
              summary: a.summary,
              path: a.path,
              content: a.content,
            });
          }
          if (result.artifacts.length === 0 && result.text) {
            this.rooms.addArtifact(roomId, {
              kind: "event",
              action: "note",
              author: name,
              summary: result.text.slice(0, 400),
            });
          }
          this.flows.delete(roomId);
          return roomId;
        }
      }
      if (flow.phase === "working") {
        const running = [...flow.tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === "running",
        );
        if (running) {
          const name =
            room.members.find((m) => m.sessionId === sessionId)?.name ?? sessionId;
          running.status = "done";
          const result = extractTaskResult(output);
          flow.results.set(running.id, result);
          for (const a of result.artifacts) {
            this.rooms.addArtifact(flow.roomId, {
              kind: a.type,
              action: a.action,
              author: name,
              summary: a.summary,
              path: a.path,
              content: a.content,
              taskId: running.id,
            });
          }
          const artifactCount = result.artifacts.length;
          const extra = artifactCount > 0 ? `，发现 ${artifactCount} 个 artifact` : "";
          const pendingCount = [...flow.tasks.values()].filter((t) => t.status === "pending").length;
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

  private resolveMember(
    room: Room,
    rawTo: string,
  ): { sessionId: string; name: string } | undefined {
    return resolveMemberByString(room, rawTo);
  }

  private async dispatch(flow: Flow, room: Room, conductorOutput: string): Promise<void> {
    const tasks = parseTasks(conductorOutput, room);
    if (tasks === null) {
      this.flows.delete(flow.roomId);
      return;
    }
    await this.dispatchFromTasks(flow, room, tasks);
  }

  private async dispatchFromTasks(
    flow: Flow,
    room: Room,
    tasks: { id?: string; to: string; task: string; dependsOn?: string[] }[],
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
      idMap.set(String(i), taskId);
      flow.tasks.set(taskId, {
        id: taskId,
        sessionId: member.sessionId,
        task: t.task.trim(),
        dependsOn: this.normalizeDependsOn(t.dependsOn, tasks, i, idMap, room),
        status: "pending",
      });
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
      if (t.status === "done" || t.status === "failed") doneIds.add(id);
    }
    const runningSessions = new Set<string>();
    for (const t of flow.tasks.values()) {
      if (t.status === "running") runningSessions.add(t.sessionId);
    }
    const out: FlowTask[] = [];
    for (const t of flow.tasks.values()) {
      if (t.status !== "pending") continue;
      const depsDone = t.dependsOn.every((d) => doneIds.has(d) || !flow.tasks.has(d));
      if (!depsDone) continue;
      if (runningSessions.has(t.sessionId)) continue;
      out.push(t);
    }
    return out;
  }

  private async scheduleTasks(flow: Flow, room: Room): Promise<void> {
    const tasks = this.runnableTasks(flow);
    if (tasks.length === 0) {
      const values = [...flow.tasks.values()];
      const allDone = values.every((t) => t.status === "done");
      const hasFailed = values.some((t) => t.status === "failed");
      if (allDone) {
        await this.summarize(flow, room);
      } else if (hasFailed) {
        const failedTasks = values.filter((t) => t.status === "failed");
        const names = failedTasks.map((t) => room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId);
        this.notice({
          roomId: flow.roomId,
          message: `以下子任务执行失败：${names.join("、")}，指挥家无法进行汇总`,
        });
      }
      return;
    }

    const assignments: string[] = [];
    for (const t of tasks) {
      if (this.agent.isBusy(t.sessionId)) continue;
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
      const prompt = this.rooms.buildPrompt(
        room.roomId,
        [
          `指挥家派发给你的子任务（id: ${t.id}）：${t.task}`,
          "",
          "完成子任务后，请在自由文本总结后附带一个 JSON code block 报告你产生的 artifact（修改的文件、执行的命令、测试等）：",
          '```json',
          '{"text":"你的总结","artifacts":[{"type":"file","path":"/path/to/file","summary":"改动摘要"},{"type":"command","summary":"运行的命令和结果"},{"type":"test","summary":"测试结果"}]}',
          '```',
          "",
          "如果没有 artifact，可以只输出文本，不必输出 JSON。",
        ].join("\n"),
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
      });
    }

    if (assignments.length > 0) {
      this.notice({ roomId: flow.roomId, message: `指挥家派工：${assignments.join("；")}` });
    }
  }

  private async summarize(flow: Flow, room: Room): Promise<void> {
    flow.phase = "summarizing";
    // 按照 task 在 tasks Map 中的创建顺序（即指挥家给出的顺序）生成汇总
    const lines: string[] = [];
    for (const t of flow.tasks.values()) {
      const result = flow.results.get(t.id);
      if (!result) continue;
      const name = room.members.find((m) => m.sessionId === t.sessionId)?.name ?? t.sessionId;
      const artifacts = result.artifacts
        .map((a) => {
          const parts = [`[${a.type}]`];
          if (a.path) parts.push(a.path);
          parts.push(a.summary);
          return `    - ${parts.join(" ")}`;
        })
        .join("\n");
      lines.push([
        `- [${t.id}] @${name}: ${result.text}`,
        ...(result.artifacts.length > 0 ? ["  artifacts:", artifacts] : []),
      ].join("\n"));
    }
    const prompt = [
      `你是群聊「${room.name}」的指挥家。你之前派发的子任务已全部完成，结果如下：`,
      ...lines,
      "",
      "请根据各成员返回的结果和 artifact 汇总，向用户给出最终答复。如果涉及文件修改，请引用文件路径。",
    ].join("\n");
    this.notice({ roomId: flow.roomId, message: "子任务全部完成，指挥家汇总中…" });
    await this.agent.prompt(room.conductorId!, prompt);
  }

  export(): Record<string, unknown> {
    return {
      flows: [...this.flows.values()].map((flow) => ({
        roomId: flow.roomId,
        phase: flow.phase,
        tasks: [...flow.tasks.values()].map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          task: t.task,
          dependsOn: t.dependsOn,
          status: t.status,
        })),
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
        tasks: new Map(),
        results: new Map(),
        artifactContext,
      };
      for (const t of (f.tasks as unknown[]) ?? []) {
        const o = t as Record<string, unknown>;
        const taskId = String(o.id ?? "");
        if (!taskId) continue;
        const sessionId = String(o.sessionId ?? "");
        if (!room.members.some((m) => m.sessionId === sessionId)) continue;
        flow.tasks.set(taskId, {
          id: taskId,
          sessionId,
          task: String(o.task ?? ""),
          dependsOn: Array.isArray(o.dependsOn)
            ? o.dependsOn.map((s) => String(s)).filter(Boolean)
            : [],
          status: (o.status as FlowTask["status"]) === "running" ? "pending" : (o.status as FlowTask["status"]) ?? "pending",
        });
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
                    const type = String(o.type ?? "");
                    if (type !== "file" && type !== "command" && type !== "test") return null;
                    return { type, path: typeof o.path === "string" ? o.path : undefined, summary: String(o.summary ?? "") };
                  })
                  .filter((a) => a !== null) as TaskArtifact[]
              : [],
          });
        }
      }
      this.flows.set(roomId, flow);
      this.notice({ roomId, message: "🔄 已恢复指挥编排，继续执行待派发任务" });
      await this.scheduleTasks(flow, room).catch((err) => {
        logError("conductor import schedule", err);
      });
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
      if (text || artifacts.length > 0) {
        // 去掉 JSON code fence 后的内容作为额外文本
        const plain = output.replace(fenceRe, "").trim().replace(/\s+/g, " ");
        return { text: text || plain.slice(0, PLAN_RESULT_LEN), artifacts };
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

function parseTasks(output: string, room: Room): { id?: string; to: string; task: string; dependsOn?: string[] }[] | null {
  const candidates: string[] = [];

  // 1. 提取所有 ```json / ``` code fence 里的内容
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[1]) candidates.push(m[1].trim());
  }

  // 2. 没有 code fence 时，尝试扫描所有平衡的 JSON 对象
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
          if (raw.includes('"tasks"')) candidates.push(raw);
          start = -1;
        }
      }
    }
  }

  // 3. 逐个尝试解析，找包含 tasks 数组的那个
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (!Array.isArray(obj.tasks)) continue;
      const tasks = obj.tasks
        .map((t: unknown) => {
          const o = t as Record<string, unknown>;
          if (typeof o?.to !== "string" || typeof o?.task !== "string") return null;
          const toRaw = o.to.replace(/^@/, "").trim();
          const taskRaw = String(o.task).trim();
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
      return tasks as { id?: string; to: string; task: string; dependsOn?: string[] }[];
    } catch {
      // 继续尝试下一个候选
    }
  }

  return null;
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

export { parseTasks, extractTaskResult };
export type { TaskArtifact, TaskResult };
