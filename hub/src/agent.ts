import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  | {
      /** 决策卡协议：permission/elicitation 发起（hub 内部消费，不直接广播客户端） */
      method: "decision.request";
      params: {
        requestId: string;
        sessionId: string;
        type: "permission" | "elicitation";
        title: string;
        options: { id: string; label: string; kind?: string }[];
        toolCall?: unknown;
        fields?: unknown;
        message?: string;
        grantKey?: string;
        grantScope?: "task" | "always";
        auto?: boolean;
        autoOptionId?: string;
      };
    }
  | {
      method: "decision.resolve";
      params: {
        requestId: string;
        outcome: "answered" | "expired" | "revoked";
        optionId?: string;
        action?: string;
      };
    }
  | {
      method: "member.status";
      params: {
        scope: "room" | "session";
        id: string;
        member: string;
        status: "online" | "generating" | "offline";
      };
    }
  | {
      /** 远端配额上报扩散：hub.quotaReport / worker 控制帧被接受后广播 */
      method: "member.quota";
      params: {
        scope: "connection" | "session";
        connectionId?: string | undefined;
        connectionIds?: string[] | undefined;
        sessionId?: string | undefined;
        quota: unknown;
        updatedAt: number;
      };
    }
  | { method: "room.notice"; params: { roomId: string; message: string } }
  | { method: "room.process"; params: { roomId: string; entry: { id: number; at: number; kind: string; author: string; text: string } } }
  | { method: "room.artifact"; params: { roomId: string; artifact?: unknown } }
  | { method: "session.artifact"; params: { sessionId: string } }
  | { method: "room.blackboardUpdate"; params: { roomId: string; blackboard: { id: string; from: string; text: string; detail: string; at: number }[] } }
  | { method: "file.update"; params: { roomId?: string; sessionId?: string; path: string; op: "delete" | "rename"; from?: string; to?: string } }
  | { method: "agent.status"; params: { status: string; detail?: string } }
  | { method: "task.update"; params: { tasks: unknown[] } };

type PermissionOption = { optionId: string; name: string; kind: string };

export type PermissionRequestParams = {
  sessionId: string;
  toolCall: unknown;
  options: PermissionOption[];
};

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * session/request_permission 的宽容解析：替代 SDK zod 严格校验（kind 限定
 * 四值字面量，任何结构偏差都会被 invalidParams 直接打回，决策卡永远到不了
 * 客户端）。接受 optionId/id、name/label、kind/type 字段别名，过滤无
 * optionId 的选项；输出恒为安全结构（options 可为空数组，由 handler 兜底）。
 */
export function normalizePermissionParams(raw: unknown): PermissionRequestParams {
  const p =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rawOptions = Array.isArray(p.options) ? p.options : [];
  const options: PermissionOption[] = [];
  for (const item of rawOptions) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const optionId = firstString(o.optionId, o.id);
    if (!optionId) continue;
    options.push({
      optionId,
      name: firstString(o.name, o.label) ?? optionId,
      kind: firstString(o.kind, o.type) ?? "",
    });
  }
  if (rawOptions.length > 0 && options.length === 0) {
    logWarn(
      "permission",
      `normalizePermissionParams: all ${rawOptions.length} options dropped (missing optionId)`,
    );
  }
  const sessionId = firstString(p.sessionId) ?? "";
  if (!sessionId) {
    logWarn("permission", "normalizePermissionParams: empty sessionId");
  }
  return {
    sessionId,
    toolCall: p.toolCall,
    options,
  };
}

/** 拒绝类选项：词边界匹配 reject/deny/decline/block/cancel（含 ed/d/led/ing/s 与 _once 类 kind 后缀），un- 前缀（unblock）不误选 */
const REJECT_OPTION_RE = /(?<![\w-])(?:reject|deny|denied|decline|block|cancel)(?:ed|d|led|ing|s|[_-]\w+)?(?![\w-])/i;

/** 优先选明确的拒绝类选项（kind/name 正则），无则由调用方决定兜底 */
function rejectOptionOf(options: PermissionOption[]): PermissionOption | undefined {
  return options.find(
    (o) => REJECT_OPTION_RE.test(o.kind) || REJECT_OPTION_RE.test(o.name),
  );
}

type SessionEntry = {
  cwd: string;
  name: string;
  busy: boolean;
  stoppable: boolean;
  turnText: string;
  loading?: boolean;
  turnGotUpdate?: boolean;
  watchdog?: ReturnType<typeof setTimeout> | undefined;
  /**
   * prompt.done 宽限窗内待执行的定稿：ACP 响应已到但尾包 session/update
   * 可能仍在路上（dsh-acp whenIdle 结算不等待通知写盘），期间 busy 保持
   * true 继续累积 turnText，宽限到期或新操作到来时按已累积文本定稿。
   */
  pendingSettle?: {
    timer: ReturnType<typeof setTimeout>;
    stopReason: string;
    usage?: TokenUsage | undefined;
  } | undefined;
  /** 回合代际：每 prompt/cancel 递增，过期 settle 一律丢弃 */
  turnEpoch?: number;
};

export function stripLoneSurrogates(s: string): string {
  return s.replace(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
    (m) => (m.length === 2 ? m : "\uFFFD"),
  );
}

// 默认收紧为 60s：超时路径 fail-closed（只选明确 reject 否则 cancelled），慢响应会话用 HUB_PERMISSION_TIMEOUT_MS 调大
let permissionTimeoutMs = Number(process.env.HUB_PERMISSION_TIMEOUT_MS ?? 60_000);

export function setPermissionTimeoutMs(v: number): void {
  permissionTimeoutMs = v;
}

export function getPermissionTimeoutMs(): number {
  return permissionTimeoutMs;
}
let promptAckTimeoutMs = Number(process.env.HUB_PROMPT_ACK_TIMEOUT_MS ?? 180_000);

export function setPromptAckTimeoutMs(v: number): void {
  promptAckTimeoutMs = v;
}
/** prompt.done 定稿宽限窗（ms）：<=0 关闭；env HUB_TURN_SETTLE_GRACE_MS 覆盖 */
let turnSettleGraceMs = Number(process.env.HUB_TURN_SETTLE_GRACE_MS ?? 100);

export function setTurnSettleGraceMs(v: number): void {
  turnSettleGraceMs = v;
}
const ELICITATION_TIMEOUT_MS = 600_000;
const TURN_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_message",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);
const OUTPUT_CAPTURE_LEN = 800;
const AUTH_REQUIRED_CODE = acp.RequestError.authRequired().code;
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

const FILE_READ_CHUNK_BYTES = 64 * 1024;

/**
 * 有界区间读取：line/limit 与 sliceTextFile 语义一致，但只按需扫描文件：
 * limit 已知时收集够行数即停止，不再读文件尾部；峰值内存与返回内容同级，
 * 而非整文件 + 全行数组。
 */
export function readTextFileRange(
  target: string,
  line?: number | null,
  limit?: number | null,
): string {
  const start = Math.max(1, Math.floor(line ?? 1));
  const count = limit == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(limit));
  if (count <= 0) return "";
  const fd = fs.openSync(target, "r");
  try {
    const decoder = new StringDecoder("utf-8");
    const buf = Buffer.alloc(FILE_READ_CHUNK_BYTES);
    const out: string[] = [];
    let curLine = 1;
    let carry = "";
    let done = false;
    while (!done) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      const text = n > 0 ? carry + decoder.write(buf.subarray(0, n)) : carry + decoder.end();
      const lines = text.split("\n");
      if (n === 0) {
        for (const l of lines) {
          if (curLine >= start) out.push(l);
          curLine++;
          if (out.length >= count) break;
        }
        break;
      }
      carry = lines.pop() ?? "";
      for (const l of lines) {
        if (curLine >= start) out.push(l);
        curLine++;
        if (out.length >= count) {
          done = true;
          break;
        }
      }
    }
    return out.join("\n");
  } finally {
    fs.closeSync(fd);
  }
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

/**
 * permission 授权键：toolCall 的 kind + name/title 首行。
 * 同类请求（同 kind 同工具名）命中 always/task 授权时自动放行。
 */
export function permissionKeyOf(toolCall: unknown): string {
  const o =
    typeof toolCall === "object" && toolCall !== null
      ? (toolCall as Record<string, unknown>)
      : {};
  const kind = typeof o.kind === "string" && o.kind ? o.kind : "other";
  const name =
    typeof o.name === "string" && o.name
      ? o.name
      : typeof o.title === "string" && o.title
        ? o.title.split("\n")[0]!.slice(0, 80)
        : "";
  return name ? `${kind}:${name}` : kind;
}

export function permissionTitleOf(toolCall: unknown): string {
  const o =
    typeof toolCall === "object" && toolCall !== null
      ? (toolCall as Record<string, unknown>)
      : {};
  if (typeof o.title === "string" && o.title) return o.title;
  if (typeof o.name === "string" && o.name) return o.name;
  if (typeof o.kind === "string" && o.kind) return o.kind;
  return "permission";
}

export type PermissionGrantScope = "task" | "always";

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
    (o) => !REJECT_OPTION_RE.test(o.kind) && !REJECT_OPTION_RE.test(o.name),
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
  private pendingPermissions = new Map<
    string,
    { optionIds: Set<string>; respond: (optionId: string, outcome?: "answered" | "expired" | "revoked") => void }
  >();
  private pendingElicitations = new Map<
    string,
    (resp: acp.CreateElicitationResponse, outcome?: "answered" | "expired" | "revoked") => void
  >();
  /** 决策卡授权登记：sessionId → grantKey → scope（always 持久，task 随回合结束清除） */
  private permissionGrants = new Map<string, Map<string, PermissionGrantScope>>();
  private starting: Promise<void> | null = null;
  private ready = false;
  private authMethods: acp.AuthMethod[] = [];
  private authInFlight: Promise<void> | null = null;
  private authEpoch = 0;
  private authFailedError: { epoch: number; err: unknown } | null = null;
  private startError: Error | null = null;
  private readonly authHandledErrors = new WeakSet<object>();
  private cachedConfigOptions: unknown[] | null = null;
  private sessionConfigOptions = new Map<string, unknown[]>();
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
    private readonly onTurnEnd?: (
      sessionId: string,
      text: string,
      status: "done" | "interrupted",
    ) => void,
    private readonly onFileWrite?: (sessionId: string, relPath: string, existed: boolean, content?: string) => void,
    private readonly onToolCall?: (sessionId: string, kind: string, title: string, paths: string[]) => void,
    private readonly localDevinAuth = false,
    private readonly onTurnProgress?: (sessionId: string, fullText: string) => void,
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  close(): void {
    this.conn?.close();
    if (this.process && this.process.exitCode === null) {
      this.process.kill();
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.ready) return;
    if (this.startError) throw this.startError;
    if (!this.starting) {
      this.starting = this.start()
        .catch((e) => {
          this.startError = e instanceof Error ? e : new Error(String(e));
          throw this.startError;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    this.emit({ method: "agent.status", params: { status: "starting" } });

    const app = acp
      .client({ name: "agent-hub" })
      // 自定义宽容 parser 替代 SDK zod 校验：dsh 等 agent 发送非标准
      // options/kind 结构时不再被 invalidParams 打回（决策卡缺席的假死）
      .onRequest(
        acp.methods.client.session.requestPermission,
        normalizePermissionParams,
        (ctx) => this.handlePermission(ctx.params),
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
    this.authMethods = init.authMethods ?? [];

    this.ready = true;
    this.emit({
      method: "agent.status",
      params: { status: "ready", detail: `protocol v${init.protocolVersion}` },
    });
  }

  private isAuthRequired(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === AUTH_REQUIRED_CODE
    );
  }

  private markAuthHandled<T>(err: T): T {
    if (typeof err === "object" && err !== null) {
      this.authHandledErrors.add(err as object);
    }
    return err;
  }

  private wasAuthHandled(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      this.authHandledErrors.has(err as object)
    );
  }

  private async requestWithAuth<T>(send: () => Promise<T>): Promise<T> {
    const epoch = this.authEpoch;
    try {
      return await send();
    } catch (err) {
      if (!this.isAuthRequired(err)) throw err;
      if (this.authEpoch === epoch) {
        try {
          await this.ensureAuthenticated();
        } catch (authErr) {
          throw this.markAuthHandled(authErr);
        }
      } else if (this.authFailedError?.epoch === this.authEpoch) {
        throw this.markAuthHandled(this.authFailedError.err);
      }
      try {
        return await send();
      } catch (retryErr) {
        if (this.isAuthRequired(retryErr)) throw this.markAuthHandled(retryErr);
        throw retryErr;
      }
    }
  }

  private ensureAuthenticated(): Promise<void> {
    this.authInFlight ??= this.authenticateOnDemand()
      .then(() => {
        this.authEpoch++;
      })
      .catch((err) => {
        this.authEpoch++;
        this.authFailedError = { epoch: this.authEpoch, err };
        throw err;
      })
      .finally(() => {
        this.authInFlight = null;
      });
    return this.authInFlight;
  }

  private async authenticateOnDemand(): Promise<void> {
    const method = this.authMethods.find(
      (m) => ((m as { type?: string }).type ?? "agent") === "agent",
    );
    if (!method) {
      for (const m of this.authMethods) {
        const t = (m as { type?: string }).type ?? "agent";
        if (t === "terminal") {
          throw new Error(`本地 Agent ${this.name} 需要终端认证，当前环境无法交互`);
        }
        if (t === "env_var") {
          const vars = (m as { vars?: { name: string; optional?: boolean }[] }).vars ?? [];
          const missing = vars.filter((v) => !v.optional && !process.env[v.name]);
          if (missing.length > 0) {
            throw new Error(`本地 Agent ${this.name} 缺少认证环境变量: ${missing.map((v) => v.name).join(", ")}`);
          }
        }
      }
      throw new Error(`本地 Agent ${this.name} 需要认证，但没有可用的认证方式`);
    }
    this.emit({
      method: "agent.status",
      params: { status: "authenticating", detail: method.name },
    });
    const apiKey =
      (this.localDevinAuth ? process.env.DEVIN_API_KEY : undefined) ??
      process.env.ACP_API_KEY;
    try {
      await this.ctx!.request(acp.methods.agent.authenticate, {
        methodId: method.id,
        ...(apiKey ? { _meta: { api_key: apiKey } } : {}),
      });
    } catch (err) {
      if (this.ctx) {
        this.emit({ method: "agent.status", params: { status: "auth-required" } });
      }
      throw err;
    }
    if (this.ctx) {
      this.emit({ method: "agent.status", params: { status: "ready" } });
    }
  }

  private onDisconnected(): void {
    const wasReady = this.ready;
    this.ready = false;
    this.supportsSessionFork = false;
    this.ctx = null;
    this.conn = null;
    this.sessionConfigOptions.clear();
    for (const [sessionId, entry] of this.sessions) {
      // 宽限窗内断连：响应已收到的回合按 done 定稿，不虚报 prompt.error
      this.flushPendingSettle(sessionId, entry);
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
      resolve({ action: "cancel" }, "revoked");
    }
    this.pendingElicitations.clear();
    for (const pending of this.pendingPermissions.values()) {
      pending.respond("", "revoked");
    }
    this.pendingPermissions.clear();
    this.permissionGrants.clear();
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
    // 非在途时的内容型 update 视为僵尸流量丢弃（cancel/watchdog 后迟到的回合残片）；
    // usage/config_option 属会话级更新，不受回合约束放行。
    // 已知边界：新回合已启动后旧回合迟到的 update 无法区分——ACP session/update 不携带回合标识。
    if (!entry.busy && u.sessionUpdate && TURN_UPDATE_KINDS.has(u.sessionUpdate)) return;
    if (entry.busy) entry.turnGotUpdate = true;
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
      this.recordConfigOptions(params.sessionId, u.configOptions);
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
      this.onTurnProgress?.(params.sessionId, entry.turnText);
    } else if (u.sessionUpdate === "agent_message" && u.content?.type === "text") {
      entry.turnText = u.content.text ?? "";
      this.onTurnProgress?.(params.sessionId, entry.turnText);
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      this.handleToolCall(params.sessionId, u as Record<string, unknown>);
    }
    this.emit({
      method: "session.update",
      params: { sessionId: params.sessionId, update: params.update },
    });
  }

  /**
   * 宽限窗内新操作（prompt/cancel 之外的调用方亦可能触发）到来：
   * 立即按已累积文本定稿 pendingSettle，不得阻塞或吞掉后续操作。
   */
  private flushPendingSettle(sessionId: string, entry: SessionEntry): void {
    const pending = entry.pendingSettle;
    if (!pending) return;
    clearTimeout(pending.timer);
    entry.pendingSettle = undefined;
    this.finishTurn(sessionId, pending.stopReason, pending.usage);
  }

  /** 丢弃待定 finish（cancel 收尾语义优先，不再补发 prompt.done） */
  private dropPendingSettle(entry: SessionEntry): void {
    if (!entry.pendingSettle) return;
    clearTimeout(entry.pendingSettle.timer);
    entry.pendingSettle = undefined;
  }

  private finishTurn(
    sessionId: string,
    stopReason: string,
    usage?: TokenUsage,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.clearTaskGrants(sessionId);
    const fullText = entry.turnText;
    this.onTurnEnd?.(sessionId, fullText, "done");
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

  /** agent→hub 请求同样证明存活：permission/elicitation/fs 期间不得误判为无输出 */
  private markTurnAlive(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.turnGotUpdate = true;
  }

  private handlePermission(
    params: PermissionRequestParams,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID();
    this.markTurnAlive(params.sessionId);
    const grantKey = permissionKeyOf(params.toolCall);
    const title = permissionTitleOf(params.toolCall);

    // 无可答选项：卡片永远无解，不发卡，立即 fail-closed 收尾（cancelled
    // 是 ACP 标准 outcome，dsh 映射为 'cancelled'，其余 agent 按拒绝处理）
    if (params.options.length === 0) {
      logWarn(
        "permission",
        `no usable options for ${title} in session ${params.sessionId}; answering cancelled`,
      );
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }

    const decisionOptions = params.options.map((o) => ({
      id: o.optionId,
      label: o.name,
      kind: o.kind,
    }));
    const emitDecisionRequest = (extra?: {
      grantScope?: PermissionGrantScope;
      auto?: boolean;
      autoOptionId?: string;
    }) =>
      this.emit({
        method: "decision.request",
        params: {
          requestId,
          sessionId: params.sessionId,
          type: "permission",
          title,
          options: decisionOptions,
          toolCall: params.toolCall,
          grantKey,
          ...extra,
        },
      });

    if (permissionBypass) {
      const chosen =
        findAutoAllowOption(params.options) ??
        params.options[params.options.length - 1];
      const optionId = chosen?.optionId ?? "";
      logWarn(
        "permission",
        `bypass=${permissionBypass}, auto-selecting "${chosen?.name ?? optionId}" for ${title} in session ${params.sessionId}`,
      );
      return Promise.resolve({
        outcome: { outcome: "selected", optionId },
      });
    }

    // 决策卡 scope=always/task 授权命中：存在可自动放行的 allow 类选项才
    // 自动应答（落一张已答卡留痕）；找不到时降级为人工决策卡，不得为
    // "always" 授权盲选一个 reject/任意选项
    const grantScope = this.permissionGrants.get(params.sessionId)?.get(grantKey);
    if (grantScope) {
      const chosen = findAutoAllowOption(params.options);
      if (chosen) {
        emitDecisionRequest({ grantScope, auto: true, autoOptionId: chosen.optionId });
        logWarn(
          "permission",
          `grant(scope=${grantScope}) hit for ${grantKey} in session ${params.sessionId} -> "${chosen.name}"`,
        );
        return Promise.resolve({
          outcome: { outcome: "selected", optionId: chosen.optionId },
        });
      }
      logWarn(
        "permission",
        `grant(scope=${grantScope}) hit for ${grantKey} in session ${params.sessionId} but no allow option; falling back to interactive card`,
      );
    }

    emitDecisionRequest();
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
        // 超时兜底只选明确的拒绝类选项；没有 reject 选项时回 cancelled，
        // 绝不盲选列表末位（可能是 allow）导致超时静默放行
        const fallback = rejectOptionOf(params.options);
        this.emit({
          method: "decision.resolve",
          params: {
            requestId,
            outcome: "expired",
            ...(fallback ? { optionId: fallback.optionId } : {}),
          },
        });
        if (fallback) {
          logWarn("agent", `permission ${requestId} timed out -> ${fallback.optionId}`);
          resolve({ outcome: { outcome: "selected", optionId: fallback.optionId } });
        } else {
          logWarn("agent", `permission ${requestId} timed out with no reject option -> cancelled`);
          resolve({ outcome: { outcome: "cancelled" } });
        }
      }, permissionTimeoutMs);
      this.pendingPermissions.set(requestId, {
        optionIds: new Set(params.options.map((o) => o.optionId)),
        respond: (optionId, outcome = "answered") => {
          clearTimeout(timer);
          this.pendingPermissions.delete(requestId);
          this.emit({
            method: "decision.resolve",
            params: { requestId, outcome, ...(optionId ? { optionId } : {}) },
          });
          // 空 optionId（revoke/断连收尾）按 ACP 标准 cancelled 语义回报，
          // 而非伪造一个 selected 空选
          if (!optionId) {
            logWarn(
              "permission",
              `permission ${requestId} ${outcome} in session ${params.sessionId}: no option -> cancelled`,
            );
          }
          resolve(
            optionId
              ? { outcome: { outcome: "selected", optionId } }
              : { outcome: { outcome: "cancelled" } },
          );
        },
      });
    });
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || !optionId.trim() || !pending.optionIds.has(optionId)) return false;
    pending.respond(optionId);
    return true;
  }

  /** decision.revoke：终止挂起的 permission 请求（以空 optionId 取消语义收尾） */
  revokePermission(requestId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    pending.respond("", "revoked");
    return true;
  }

  /** 登记会话级授权：scope=always 持久，scope=task 随当前回合结束清除 */
  grantPermission(sessionId: string, grantKey: string, scope: PermissionGrantScope): void {
    let m = this.permissionGrants.get(sessionId);
    if (!m) {
      m = new Map();
      this.permissionGrants.set(sessionId, m);
    }
    m.set(grantKey, scope);
  }

  /** 撤销授权（key 省略时撤销该会话全部授权），返回是否有授权被移除 */
  revokePermissionGrant(sessionId: string, grantKey?: string): boolean {
    const m = this.permissionGrants.get(sessionId);
    if (!m) return false;
    if (grantKey === undefined) {
      const n = m.size;
      this.permissionGrants.delete(sessionId);
      return n > 0;
    }
    const ok = m.delete(grantKey);
    if (m.size === 0) this.permissionGrants.delete(sessionId);
    return ok;
  }

  private clearTaskGrants(sessionId: string): void {
    const m = this.permissionGrants.get(sessionId);
    if (!m) return;
    for (const [k, v] of m) if (v === "task") m.delete(k);
    if (m.size === 0) this.permissionGrants.delete(sessionId);
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
    this.markTurnAlive(sessionId);
    const requestId = randomUUID();
    const fields = normalizeElicitationFields(schema);
    this.emit({
      method: "decision.request",
      params: {
        requestId,
        sessionId,
        type: "elicitation",
        title: String(params.message ?? "").slice(0, 300) || "elicitation",
        options: [
          { id: "accept", label: "accept" },
          { id: "decline", label: "decline" },
          { id: "cancel", label: "cancel" },
        ],
        fields,
        message: params.message,
      },
    });
    this.emit({
      method: "elicitation.request",
      params: {
        requestId,
        sessionId,
        message: params.message,
        fields,
      },
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingElicitations.delete(requestId);
        this.emit({
          method: "decision.resolve",
          params: { requestId, outcome: "expired", action: "cancel" },
        });
        logWarn("agent", `elicitation ${requestId} timed out in session ${sessionId} -> cancel`);
        resolve({ action: "cancel" });
      }, ELICITATION_TIMEOUT_MS);
      this.pendingElicitations.set(requestId, (resp, outcome = "answered") => {
        clearTimeout(timer);
        this.pendingElicitations.delete(requestId);
        this.emit({
          method: "decision.resolve",
          params: { requestId, outcome, action: resp.action },
        });
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

  /** decision.revoke：终止挂起的 elicitation（cancel 语义收尾） */
  revokeElicitation(requestId: string): boolean {
    const resolve = this.pendingElicitations.get(requestId);
    if (!resolve) return false;
    resolve({ action: "cancel" }, "revoked");
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
    this.markTurnAlive(params.sessionId);
    const target = this.resolveSessionPath(params.sessionId, params.path);
    // 未给区间时保持整文件语义；有 line/limit 时有界读取，不再整文件进内存
    const content =
      params.line == null && params.limit == null
        ? fs.readFileSync(target, "utf-8")
        : readTextFileRange(target, params.line, params.limit);
    return { content };
  }

  private handleWriteTextFile(params: {
    sessionId: string;
    path: string;
    content: string;
  }): Record<string, never> {
    this.markTurnAlive(params.sessionId);
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

  private recordConfigOptions(sessionId: string | undefined, opts: unknown): void {
    if (!Array.isArray(opts)) return;
    this.cachedConfigOptions = opts;
    if (sessionId) this.sessionConfigOptions.set(sessionId, opts);
  }

  async createSession(
    cwd: string,
    name?: string,
  ): Promise<{ sessionId: string; name: string }> {
    await this.ensureStarted();
    const resp = await this.requestWithAuth(() =>
      this.ctx!.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      }),
    );
    this.recordConfigOptions(resp.sessionId, resp.configOptions);
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
    const resp = await this.requestWithAuth(() =>
      this.ctx!.request(acp.methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: [],
      }),
    );
    this.recordConfigOptions(resp.sessionId, resp.configOptions);
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

  /** 返回 configOptions（含模型/思考强度/模式列表等），优先 session 级 */
  getConfigOptions(sessionId?: string): unknown[] | null {
    if (sessionId) {
      const sessionOpts = this.sessionConfigOptions.get(sessionId);
      if (sessionOpts) return sessionOpts;
    }
    return this.cachedConfigOptions;
  }

  /** 恢复历史会话：优先 session/resume，回退 session/load */
  async resumeSession(sessionId: string, cwd: string, name: string): Promise<boolean> {
    await this.ensureStarted();
    try {
      const resp = await this.requestWithAuth(() =>
        this.ctx!.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers: [],
        }),
      );
      this.recordConfigOptions(sessionId, (resp as { configOptions?: unknown }).configOptions);
    } catch (err) {
      if (this.wasAuthHandled(err) || this.isAuthRequired(err)) {
        logWarn("agent", `resume ${sessionId} auth failed: ${String(err)}`);
        throw err;
      }
      try {
        this.sessions.set(sessionId, {
          cwd,
          name,
          busy: false,
          stoppable: false,
          turnText: "",
          loading: true,
        });
        const resp = await this.requestWithAuth(() =>
          this.ctx!.request(acp.methods.agent.session.load, {
            sessionId,
            cwd,
            mcpServers: [],
          }),
        );
        this.recordConfigOptions(sessionId, (resp as { configOptions?: unknown } | undefined)?.configOptions);
        console.log(`[agent] resumed ${sessionId} via session/load`);
      } catch (err) {
        this.sessions.delete(sessionId);
        this.contextUsage.delete(sessionId);
        logWarn("agent", `resume ${sessionId} failed: ${String(err)}`);
        if (this.wasAuthHandled(err) || this.isAuthRequired(err)) throw err;
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
    // 宽限窗内新 prompt：先按已累积文本定稿旧回合（同步发 prompt.done），再开新回合
    this.flushPendingSettle(sessionId, entry);
    if (entry.busy) throw new Error(`session busy: ${entry.name}`);
    entry.busy = true;
    entry.stoppable = true;
    entry.turnText = "";
    entry.turnGotUpdate = false;
    const epoch = (entry.turnEpoch ?? 0) + 1;
    entry.turnEpoch = epoch;
    const isCurrentTurn = () =>
      this.sessions.get(sessionId) === entry && entry.turnEpoch === epoch;
    prompt = prompt.map((p) =>
      typeof p.text === "string" ? { ...p, text: stripLoneSurrogates(p.text) } : p,
    );
    this.emit({
      method: "session.generating",
      params: { sessionId, stoppable: true },
    });
    clearTimeout(entry.watchdog);
    entry.watchdog = setTimeout(() => {
      if (!isCurrentTurn()) return;
      entry.watchdog = undefined;
      if (!entry.busy || entry.turnGotUpdate) return;
      // 先以超时语义广播+拒 waiter，再做取消清理——cancel 会以 cancelled 语义收尾剩余 waiter
      const err = new Error(
        `agent ${this.name} produced no output within ${promptAckTimeoutMs / 1000}s — request may have been rejected at transport level`,
      );
      this.emit({
        method: "prompt.error",
        params: { sessionId, message: String(err) },
      });
      const waiter = this.promptOnceWaiters.get(sessionId);
      if (waiter) {
        this.promptOnceWaiters.delete(sessionId);
        waiter.reject(err);
      }
      // 尽力取消僵尸回合（内部清 busy/stoppable、换代、onTurnEnd 收尾），避免重派叠 prompt
      this.cancel(sessionId).catch(() => {});
    }, promptAckTimeoutMs);
    entry.watchdog.unref?.();
    this.ctx!.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt,
    })
      .then((resp) => {
        if (!isCurrentTurn()) return;
        clearTimeout(entry.watchdog);
        entry.watchdog = undefined;
        const stopReason = (resp as { stopReason?: unknown }).stopReason as string;
        const usage = (resp as { usage?: unknown }).usage as TokenUsage | undefined;
        if (turnSettleGraceMs <= 0) {
          this.finishTurn(sessionId, stopReason, usage);
          return;
        }
        // 宽限窗：响应先到、尾部 session/update 在路上时 busy 保持 true，
        // routeUpdate 继续累积 turnText；到期仍按同一代际校验后定稿。
        // timer 是定稿主路径，不可 unref（否则事件循环空置时 finish 不触发）
        entry.pendingSettle = {
          stopReason,
          usage,
          timer: setTimeout(() => {
            entry.pendingSettle = undefined;
            if (!isCurrentTurn()) return;
            this.finishTurn(sessionId, stopReason, usage);
          }, turnSettleGraceMs),
        };
      })
      .catch((err: unknown) => {
        if (!isCurrentTurn()) return;
        clearTimeout(entry.watchdog);
        entry.watchdog = undefined;
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
    // 宽限窗内 cancel：待定 finish 作废，回合按 interrupted 原路径收尾
    this.dropPendingSettle(entry);
    // 本地收尾：已流出的部分文本与过程缓冲照常落库（watchdog 场景 buf 为空，无过程卡）
    entry.stoppable = false;
    entry.busy = false;
    this.clearTaskGrants(sessionId);
    this.onTurnEnd?.(sessionId, entry.turnText, "interrupted");
    entry.turnText = "";
    // 换代：取消后迟到的 settle 不得触碰新回合/复活本回合任务
    entry.turnEpoch = (entry.turnEpoch ?? 0) + 1;
    clearTimeout(entry.watchdog);
    entry.watchdog = undefined;
    const waiter = this.promptOnceWaiters.get(sessionId);
    if (waiter) {
      this.promptOnceWaiters.delete(sessionId);
      waiter.reject(new Error("cancelled"));
    }
    try {
      await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    } finally {
      this.emit({
        method: "session.generating",
        params: { sessionId, stoppable: false },
      });
    }
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
    const resp = await this.requestWithAuth(() =>
      this.ctx!.request(acp.methods.agent.session.setConfigOption, params as never),
    );
    this.recordConfigOptions(sessionId, (resp as { configOptions?: unknown } | undefined)?.configOptions);
  }

  isBusy(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    // 宽限窗内的会话可立即接受新回合（promptContent 会先定稿旧回合）
    return (entry?.busy && !entry.pendingSettle) ?? false;
  }

  isStoppable(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.stoppable ?? false;
  }

  /** 本地摘除会话（不通知 agent，用于删除） */
  dropSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) this.dropPendingSettle(entry);
    this.sessions.delete(sessionId);
    this.permissionGrants.delete(sessionId);
    this.contextUsage.delete(sessionId);
    this.sessionConfigOptions.delete(sessionId);
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
