import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logWarn } from "./logger.js";

export type TokenUsage = {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
};

export type ContextUsage = {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
};

export type PromptDoneParams = {
  sessionId: string;
  stopReason: string;
  output: string;
  internalOutput?: string;
  usage?: TokenUsage;
};

export type ElicitationValue = string | number | boolean | string[];

export type ElicitationField = {
  name: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  description?: string;
  options?: { value: string; label: string }[];
  defaultValue?: ElicitationValue;
};

export type HubEvent =
  | { method: "session.update"; params: { sessionId: string; update: unknown } }
  | { method: "session.generating"; params: { sessionId: string; stoppable: boolean } }
  | { method: "session.usage"; params: { sessionId: string; usage: ContextUsage } }
  | {
      method: "prompt.done";
      params: PromptDoneParams;
    }
  | { method: "prompt.error"; params: { sessionId: string; message: string } }
  | {
      method: "elicitation.request";
      params: {
        requestId: string;
        sessionId: string;
        message: string;
        fields: ElicitationField[];
      };
    }
  | {
      method: "permission.request";
      params: {
        requestId: string;
        sessionId: string;
        toolCall: unknown;
        options: { optionId: string; name: string; kind: string }[];
      };
    }
  | { method: "room.notice"; params: { roomId: string; message: string } }
  | { method: "room.artifact"; params: { roomId: string; artifact?: unknown } }
  | { method: "session.artifact"; params: { sessionId: string } }
  | { method: "room.blackboardUpdate"; params: { roomId: string; blackboard: { id: string; from: string; text: string; detail: string; at: number }[] } }
  | { method: "file.update"; params: { roomId?: string; sessionId?: string; path: string; op: "delete" | "rename"; from?: string; to?: string } }
  | { method: "agent.status"; params: { status: string; detail?: string } }
  | { method: "task.update"; params: { tasks: unknown[] } };

type PermissionOption = { optionId: string; name: string; kind: string };

type SessionEntry = {
  cwd: string;
  name: string;
  busy: boolean;
  stoppable: boolean;
  turnText: string;
  loading?: boolean;
};

const PERMISSION_TIMEOUT_MS = 120_000;
const ELICITATION_TIMEOUT_MS = 600_000;
const OUTPUT_CAPTURE_LEN = 800;
let permissionBypass = process.env.HUB_PERMISSION_BYPASS === "1";

export function sliceTextFile(
  content: string,
  line?: number | null,
  limit?: number | null,
): string {
  if (line == null && limit == null) return content;
  const start = Math.max(1, Math.floor(line ?? 1)) - 1;
  const lines = content.split("\n");
  const count = limit == null ? lines.length : Math.max(0, Math.floor(limit));
  return lines.slice(start, start + count).join("\n");
}

function enumOptions(list: unknown): { value: string; label: string }[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const opts = list
    .filter((v): v is string => typeof v === "string")
    .map((v) => ({ value: v, label: v }));
  return opts.length ? opts : undefined;
}

function titledOptions(list: unknown): { value: string; label: string }[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const opts: { value: string; label: string }[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.const !== "string") continue;
    opts.push({
      value: o.const,
      label: typeof o.title === "string" && o.title ? o.title : o.const,
    });
  }
  return opts.length ? opts : undefined;
}

export function normalizeElicitationFields(schema: acp.ElicitationSchema): ElicitationField[] {
  const required = new Set(schema.required ?? []);
  const fields: ElicitationField[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const p = prop as Record<string, unknown>;
    const type = p.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") continue;
    const field: ElicitationField = {
      name,
      label: typeof p.title === "string" && p.title ? p.title : name,
      type,
      required: required.has(name),
    };
    if (typeof p.description === "string" && p.description) field.description = p.description;
    if (type === "string") {
      const opts = titledOptions(p.oneOf) ?? enumOptions(p.enum);
      if (opts) field.options = opts;
      if (typeof p.default === "string") field.defaultValue = p.default;
    } else if (type === "number" || type === "integer") {
      if (typeof p.default === "number") field.defaultValue = p.default;
    } else if (type === "boolean") {
      if (typeof p.default === "boolean") field.defaultValue = p.default;
    } else {
      const items = (p.items ?? {}) as Record<string, unknown>;
      const opts =
        titledOptions(items.anyOf) ?? titledOptions(items.oneOf) ?? enumOptions(items.enum);
      if (opts) field.options = opts;
      if (Array.isArray(p.default) && p.default.every((v) => typeof v === "string")) {
        field.defaultValue = p.default as string[];
      }
    }
    fields.push(field);
  }
  return fields;
}

export function createPromptDoneParams(
  sessionId: string,
  stopReason: string,
  internalOutput: string,
  usage?: TokenUsage,
): PromptDoneParams {
  const params: PromptDoneParams = {
    sessionId,
    stopReason,
    output: internalOutput.slice(-OUTPUT_CAPTURE_LEN),
    internalOutput,
  };
  if (usage) params.usage = usage;
  return params;
}

export function promptDoneInternalOutput(params: PromptDoneParams): string {
  return params.internalOutput ?? params.output;
}

export function toPublicHubEvent(event: HubEvent): HubEvent {
  if (event.method !== "prompt.done" || event.params.internalOutput === undefined) return event;
  const { internalOutput: _internalOutput, ...params } = event.params;
  return { method: "prompt.done", params };
}

export function getPermissionBypass(): boolean {
  return permissionBypass;
}

export function setPermissionBypass(v: boolean): void {
  permissionBypass = v;
}

function findAutoAllowOption(options: PermissionOption[]): PermissionOption | undefined {
  // 优先“始终允许”，让 agent 自己下次不再询问
  const always = options.find(
    (o) => /always/i.test(o.name) || /always/i.test(o.kind),
  );
  if (always) return always;
  // 退而求其次选择任意“允许”选项
  const allow = options.find(
    (o) => /allow/i.test(o.name) || /allow/i.test(o.kind),
  );
  if (allow) return allow;
  // 最后兜底：选择第一个非 reject/deny/block 的选项
  return options.find(
    (o) =>
      !/reject|deny|denied|block/i.test(o.kind) &&
      !/reject|deny|denied|block/i.test(o.name),
  );
}

export class AcpAgent {
  private conn: acp.ClientConnection | null = null;
  private ctx: acp.ClientContext | null = null;
  private sessions = new Map<string, SessionEntry>();
  private readonly contextUsage = new Map<string, ContextUsage>();

  getContextUsage(sessionId: string): ContextUsage | undefined {
    const usage = this.contextUsage.get(sessionId);
    return usage ? { ...usage, ...(usage.cost ? { cost: { ...usage.cost } } : {}) } : undefined;
  }
  private pendingPermissions = new Map<string, (optionId: string) => void>();
  private pendingElicitations = new Map<string, (resp: acp.CreateElicitationResponse) => void>();
  private starting: Promise<void> | null = null;
  private ready = false;
  private cachedConfigOptions: unknown[] | null = null;
  private supportsSessionFork = false;
  private promptOnceWaiters = new Map<
    string,
    {
      resolve: (v: { output: string; stopReason: string }) => void;
      reject: (e: Error) => void;
    }
  >();

  constructor(
    private readonly name: string,
    private readonly stream: Stream,
    private readonly emit: (event: HubEvent) => void,
    private readonly onClose?: () => void,
    private readonly process?: ChildProcess,
    private readonly onTurnEnd?: (sessionId: string, text: string) => void,
    private readonly onFileWrite?: (sessionId: string, relPath: string, existed: boolean, content?: string) => void,
    private readonly onToolCall?: (sessionId: string, kind: string, title: string, paths: string[]) => void,
  ) {}

  get isReady(): boolean {
    return this.ctx !== null;
  }

  close(): void {
    this.conn?.close();
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.ctx) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    this.emit({ method: "agent.status", params: { status: "starting" } });

    const app = acp
      .client({ name: "agent-hub" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        this.handleReadTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        this.handleWriteTextFile(ctx.params),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        this.handleElicitation(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.routeUpdate(ctx.params),
      );

    this.conn = app.connect(this.stream);
    this.ctx = this.conn.agent;

    this.conn.closed
      .then(() => this.onDisconnected())
      .catch(() => this.onDisconnected());

    const init = await this.ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        session: { configOptions: { boolean: {} } },
        elicitation: { form: {} },
      },
      clientInfo: { name: "agent-hub", version: "0.9.0" },
    });
    console.log(`[agent] ${this.name} initialized:`, JSON.stringify(init));
    this.supportsSessionFork = init.agentCapabilities?.sessionCapabilities?.fork != null;

    const authMethods = init.authMethods ?? [];
    if (authMethods.length > 0) {
      const method =
        authMethods.find((c) => ((c as { type?: string }).type ?? "agent") === "agent") ??
        authMethods[0]!;
      const methodType: string = "type" in method ? method.type : "agent";
      if (methodType === "terminal") {
        throw new Error(`本地 Agent ${this.name} 需要终端认证，当前环境无法交互`);
      }
      if (methodType === "env_var") {
        const vars = (method as { vars?: { name: string; optional?: boolean }[] }).vars ?? [];
        const missing = vars.filter((v) => !v.optional && !process.env[v.name]);
        if (missing.length > 0) {
          throw new Error(`本地 Agent ${this.name} 缺少认证环境变量: ${missing.map((v) => v.name).join(", ")}`);
        }
      }
      this.emit({ method: "agent.status", params: { status: "authenticating", detail: method.name } });
      const apiKey = process.env.DEVIN_API_KEY ?? process.env.ACP_API_KEY;
      await this.ctx.request(acp.methods.agent.authenticate, {
        methodId: method.id,
        ...(apiKey ? { _meta: { api_key: apiKey } } : {}),
      });
    }

    this.ready = true;
    this.emit({
      method: "agent.status",
      params: { status: "ready", detail: `protocol v${init.protocolVersion}` },
    });
  }

  private onDisconnected(): void {
    const wasReady = this.ready;
    this.ready = false;
    this.supportsSessionFork = false;
    this.ctx = null;
    this.conn = null;
    for (const [sessionId, entry] of this.sessions) {
      if (!entry.busy && !entry.stoppable) continue;
      entry.busy = false;
      entry.stoppable = false;
      this.emit({
        method: "session.generating",
        params: { sessionId, stoppable: false },
      });
      this.emit({
        method: "prompt.error",
        params: {
          sessionId,
          message: `agent ${this.name} disconnected while generating`,
        },
      });
    }
    for (const waiter of this.promptOnceWaiters.values()) {
      waiter.reject(new Error(`agent ${this.name} disconnected`));
    }
    this.promptOnceWaiters.clear();
    for (const resolve of this.pendingElicitations.values()) {
      resolve({ action: "cancel" });
    }
    this.pendingElicitations.clear();
    for (const respond of this.pendingPermissions.values()) {
      respond("");
    }
    this.pendingPermissions.clear();
    if (!wasReady && this.onClose) {
      this.onClose();
      return;
    }
    this.emit({
      method: "agent.status",
      params: { status: wasReady ? "exited" : "error" },
    });
    this.onClose?.();
  }

  private routeUpdate(params: { sessionId: string; update: unknown }): void {
    const entry = this.sessions.get(params.sessionId);
    if (!entry || entry.loading) return;
    const u = params.update as {
      sessionUpdate?: string;
      content?: { type: string; text?: string };
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string };
      configOptions?: unknown[];
    };
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      this.cachedConfigOptions = u.configOptions;
    }
    if (u.sessionUpdate === "usage_update") {
      const used = typeof u.used === "number" && Number.isFinite(u.used) && u.used >= 0 ? u.used : undefined;
      const size = typeof u.size === "number" && Number.isFinite(u.size) && u.size >= 0 ? u.size : undefined;
      if (used !== undefined && size !== undefined) {
        const usage: ContextUsage = { used, size, cost: (u.cost as ContextUsage["cost"]) ?? null };
        this.contextUsage.set(params.sessionId, usage);
        this.emit({
          method: "session.usage",
          params: { sessionId: params.sessionId, usage },
        });
      }
    } else if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      entry.turnText += u.content.text ?? "";
    } else if (u.sessionUpdate === "agent_message" && u.content?.type === "text") {
      entry.turnText = u.content.text ?? "";
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      this.handleToolCall(params.sessionId, u as Record<string, unknown>);
    }
    this.emit({
      method: "session.update",
      params: { sessionId: params.sessionId, update: params.update },
    });
  }

  private finishTurn(
    sessionId: string,
    stopReason: string,
    usage?: TokenUsage,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const fullText = entry.turnText;
    this.onTurnEnd?.(sessionId, fullText);
    entry.busy = false;
    entry.stoppable = false;
    this.emit({
      method: "session.generating",
      params: { sessionId, stoppable: false },
    });
    this.emit({
      method: "prompt.done",
      params: createPromptDoneParams(sessionId, stopReason, fullText, usage),
    });
    // 解析 promptOnce 等待者
    const waiter = this.promptOnceWaiters.get(sessionId);
    if (waiter) {
      this.promptOnceWaiters.delete(sessionId);
      waiter.resolve({ output: fullText, stopReason });
    }
    entry.turnText = "";
  }

  private handlePermission(params: {
    sessionId: string;
    toolCall: unknown;
    options: PermissionOption[];
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } }> {
    const requestId = randomUUID();

    if (permissionBypass) {
      const chosen =
        findAutoAllowOption(params.options) ??
        params.options[params.options.length - 1];
      const optionId = chosen?.optionId ?? "";
      const toolName =
        typeof params.toolCall === "object" &&
        params.toolCall != null &&
        "name" in params.toolCall
          ? String(params.toolCall.name)
          : "?";
      logWarn(
        "permission",
        `bypass=${permissionBypass}, auto-selecting "${chosen?.name ?? optionId}" for ${toolName} in session ${params.sessionId}`,
      );
      return Promise.resolve({
        outcome: { outcome: "selected", optionId },
      });
    }

    this.emit({
      method: "permission.request",
      params: {
        requestId,
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(requestId);
        const fallback =
          params.options.find((o) => o.kind.startsWith("reject")) ??
          params.options[params.options.length - 1];
        if (!fallback) {
          resolve({ outcome: { outcome: "selected", optionId: "" } });
          return;
        }
        logWarn("agent", `permission ${requestId} timed out -> ${fallback.optionId}`);
        resolve({ outcome: { outcome: "selected", optionId: fallback.optionId } });
      }, PERMISSION_TIMEOUT_MS);
      this.pendingPermissions.set(requestId, (optionId) => {
        clearTimeout(timer);
        this.pendingPermissions.delete(requestId);
        resolve({ outcome: { outcome: "selected", optionId } });
      });
    });
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    resolve(optionId);
    return true;
  }

  private handleElicitation(
    params: acp.CreateElicitationRequest,
  ): Promise<acp.CreateElicitationResponse> {
    const sessionId =
      "sessionId" in params && typeof params.sessionId === "string"
        ? params.sessionId
        : undefined;
    const schema = (params as { requestedSchema?: acp.ElicitationSchema }).requestedSchema;
    if (params.mode !== "form" || !sessionId || !schema) {
      return Promise.resolve({ action: "decline" });
    }
    const requestId = randomUUID();
    this.emit({
      method: "elicitation.request",
      params: {
        requestId,
        sessionId,
        message: params.message,
        fields: normalizeElicitationFields(schema),
      },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingElicitations.delete(requestId);
        resolve({ action: "cancel" });
      }, ELICITATION_TIMEOUT_MS);
      this.pendingElicitations.set(requestId, (resp) => {
        clearTimeout(timer);
        this.pendingElicitations.delete(requestId);
        resolve(resp);
      });
    });
  }

  respondElicitation(
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, ElicitationValue>,
  ): boolean {
    const resolve = this.pendingElicitations.get(requestId);
    if (!resolve) return false;
    if (action === "accept") {
      resolve({ action: "accept", content: content ?? {} });
    } else {
      resolve({ action });
    }
    return true;
  }

  private resolveSessionPath(sessionId: string, filePath: string): string {
    const entry = this.sessions.get(sessionId);
    const base = entry?.cwd ?? process.cwd();
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(base, filePath);
  }

  private handleToolCall(sessionId: string, u: Record<string, unknown>): void {
    const status = String(u.status ?? "");
    if (status && status !== "completed" && status !== "in_progress") return;

    const kind = String(u.kind ?? "other");
    const title = String(u.title ?? kind);

    const locations = Array.isArray(u.locations) ? u.locations : [];
    const paths = locations
      .filter((loc) => typeof loc === "object" && loc != null && "path" in loc)
      .map((loc) => String((loc as { path: string }).path));

    if (!paths.length && typeof u.rawInput === "object" && u.rawInput != null) {
      const raw = u.rawInput as Record<string, unknown>;
      if (raw.path) paths.push(String(raw.path));
      if (raw.file_path) paths.push(String(raw.file_path));
      if (raw.notebook_path) paths.push(String(raw.notebook_path));
      if (raw.from) paths.push(String(raw.from));
      if (raw.to) paths.push(String(raw.to));
      if (raw.old_path) paths.push(String(raw.old_path));
      if (raw.new_path) paths.push(String(raw.new_path));
      if (raw.source) paths.push(String(raw.source));
      if (raw.destination) paths.push(String(raw.destination));
    }

    // content 中的 diff 块也携带 path（Devin CLI 等不上报 locations 时兜底）
    if (!paths.length && Array.isArray(u.content)) {
      for (const c of u.content) {
        if (typeof c === "object" && c != null && "path" in c) {
          paths.push(String((c as { path: string }).path));
        }
      }
    }

    if (paths.length) {
      const entry = this.sessions.get(sessionId);
      const relPaths = entry
        ? paths.map((p) => (path.isAbsolute(p) ? path.relative(entry.cwd, p) : p))
        : paths;
      // title 中的绝对路径替换为相对路径，避免摘要冗长
      let relTitle = title;
      if (entry) {
        for (let i = 0; i < paths.length; i++) {
          if (paths[i] !== relPaths[i]) relTitle = relTitle.split(paths[i]!).join(relPaths[i]!);
        }
      }
      this.onToolCall?.(sessionId, kind, relTitle, relPaths);
    }
  }

  private handleReadTextFile(params: {
    sessionId: string;
    path: string;
    line?: number | null;
    limit?: number | null;
  }): { content: string } {
    const target = this.resolveSessionPath(params.sessionId, params.path);
    const content = fs.readFileSync(target, "utf-8");
    return { content: sliceTextFile(content, params.line, params.limit) };
  }

  private handleWriteTextFile(params: {
    sessionId: string;
    path: string;
    content: string;
  }): Record<string, never> {
    const target = this.resolveSessionPath(params.sessionId, params.path);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existed = fs.existsSync(target);
    fs.writeFileSync(target, params.content, "utf-8");

    const entry = this.sessions.get(params.sessionId);
    if (entry) {
      const relPath = path.isAbsolute(params.path)
        ? path.relative(entry.cwd, target)
        : params.path;
      this.onFileWrite?.(params.sessionId, relPath, existed, params.content);
    }

    return {};
  }

  async createSession(
    cwd: string,
    name?: string,
  ): Promise<{ sessionId: string; name: string }> {
    await this.ensureStarted();
    const resp = await this.ctx!.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    if (Array.isArray(resp.configOptions)) {
      this.cachedConfigOptions = resp.configOptions;
    }
    const sessionName = name?.trim() || resp.sessionId;
    this.sessions.set(resp.sessionId, {
      cwd,
      name: sessionName,
      busy: false,
      stoppable: false,
      turnText: "",
    });
    return { sessionId: resp.sessionId, name: sessionName };
  }

  async cloneSession(sessionId: string, cwd: string, name: string): Promise<{ sessionId: string; name: string; contextCloned: boolean }> {
    await this.ensureStarted();
    if (!this.supportsSessionFork) {
      const created = await this.createSession(cwd, name);
      return { ...created, contextCloned: false };
    }
    const resp = await this.ctx!.request(acp.methods.agent.session.fork, {
      sessionId,
      cwd,
      mcpServers: [],
    });
    if (Array.isArray(resp.configOptions)) {
      this.cachedConfigOptions = resp.configOptions;
    }
    const sessionName = name.trim() || resp.sessionId;
    this.sessions.set(resp.sessionId, {
      cwd,
      name: sessionName,
      busy: false,
      stoppable: false,
      turnText: "",
    });
    return { sessionId: resp.sessionId, name: sessionName, contextCloned: true };
  }

  /** 返回最近一次 session.new 的 configOptions（含模型列表等） */
  getConfigOptions(): unknown[] | null {
    return this.cachedConfigOptions;
  }

  /** 恢复历史会话：优先 session/resume，回退 session/load */
  async resumeSession(sessionId: string, cwd: string, name: string): Promise<boolean> {
    await this.ensureStarted();
    try {
      const resp = await this.ctx!.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      const opts = (resp as { configOptions?: unknown }).configOptions;
      if (Array.isArray(opts)) this.cachedConfigOptions = opts;
    } catch {
      try {
        this.sessions.set(sessionId, {
          cwd,
          name,
          busy: false,
          stoppable: false,
          turnText: "",
          loading: true,
        });
        const resp = await this.ctx!.request(acp.methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers: [],
        });
        const opts = (resp as { configOptions?: unknown } | undefined)?.configOptions;
        if (Array.isArray(opts)) this.cachedConfigOptions = opts;
        console.log(`[agent] resumed ${sessionId} via session/load`);
      } catch (err) {
        this.sessions.delete(sessionId);
        this.contextUsage.delete(sessionId);
        logWarn("agent", `resume ${sessionId} failed: ${String(err)}`);
        return false;
      }
    }
    this.sessions.set(sessionId, { cwd, name, busy: false, stoppable: false, turnText: "" });
    return true;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.promptContent(sessionId, [{ type: "text", text }]);
  }

  async promptContent(
    sessionId: string,
    prompt: Array<Record<string, unknown>>,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`unknown session: ${sessionId}`);
    if (entry.busy) throw new Error(`session busy: ${entry.name}`);
    entry.busy = true;
    entry.stoppable = true;
    entry.turnText = "";
    this.emit({
      method: "session.generating",
      params: { sessionId, stoppable: true },
    });
    this.ctx!.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    })
      .then((resp) => {
        this.finishTurn(
          sessionId,
          (resp as { stopReason?: unknown }).stopReason as string,
          (resp as { usage?: unknown }).usage as TokenUsage | undefined,
        );
      })
      .catch((err: unknown) => {
        const wasActive = entry.busy || entry.stoppable;
        entry.busy = false;
        entry.stoppable = false;
        if (wasActive) {
          this.emit({
            method: "session.generating",
            params: { sessionId, stoppable: false },
          });
          this.emit({
            method: "prompt.error",
            params: { sessionId, message: String(err) },
          });
        }
        // promptOnce 等待者在错误时也需要被 reject
        const waiter = this.promptOnceWaiters.get(sessionId);
        if (waiter) {
          this.promptOnceWaiters.delete(sessionId);
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
  }

  /**
   * 发送 prompt 并等待完整 internalOutput（不截断）。
   * 返回 { output, stopReason }，output 为完整 turnText。
   */
  async promptOnce(
    sessionId: string,
    text: string,
    timeoutMs = 300_000,
  ): Promise<{ output: string; stopReason: string }> {
    if (this.promptOnceWaiters.has(sessionId)) {
      throw new Error(`promptOnce already pending for session: ${sessionId}`);
    }
    return new Promise<{ output: string; stopReason: string }>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.promptOnceWaiters.delete(sessionId);
        reject(new Error(`promptOnce timeout after ${timeoutMs}ms`));
      }, timeoutMs) : null;
      this.promptOnceWaiters.set(sessionId, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.promptContent(sessionId, [{ type: "text", text }]).catch((err) => {
        const waiter = this.promptOnceWaiters.get(sessionId);
        if (waiter) {
          this.promptOnceWaiters.delete(sessionId);
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`unknown session: ${sessionId}`);
    if (!this.ctx) throw new Error("agent not started");
    if (!entry.stoppable) return;
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    entry.stoppable = false;
    this.emit({
      method: "session.generating",
      params: { sessionId, stoppable: false },
    });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    await this.ensureStarted();
    const params: { sessionId: string; configId: string; value: string | boolean } = {
      sessionId,
      configId,
      value,
    };
    const resp = await this.ctx!.request(acp.methods.agent.session.setConfigOption, params as never);
    const opts = (resp as { configOptions?: unknown } | undefined)?.configOptions;
    if (Array.isArray(opts)) this.cachedConfigOptions = opts;
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  isStoppable(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stoppable ?? false;
  }

  /** 本地摘除会话（不通知 agent，用于删除） */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.contextUsage.delete(sessionId);
  }

  renameSession(sessionId: string, name: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.name = name;
  }

  listSessions(): {
    sessionId: string;
    cwd: string;
    name: string;
    busy: boolean;
    stoppable: boolean;
  }[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      cwd: s.cwd,
      name: s.name,
      busy: s.busy,
      stoppable: s.stoppable,
    }));
  }

}
