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

export type HubEvent =
  | { method: "session.update"; params: { sessionId: string; update: unknown } }
  | { method: "session.generating"; params: { sessionId: string; stoppable: boolean } }
  | { method: "session.usage"; params: { sessionId: string; usage: ContextUsage } }
  | {
      method: "prompt.done";
      params: { sessionId: string; stopReason: string; output: string; usage?: TokenUsage };
    }
  | { method: "prompt.error"; params: { sessionId: string; message: string } }
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
const OUTPUT_CAPTURE_LEN = 800;
let permissionBypass = process.env.HUB_PERMISSION_BYPASS === "1";

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
  private pendingPermissions = new Map<string, (optionId: string) => void>();
  private starting: Promise<void> | null = null;
  private ready = false;
  private cachedConfigOptions: unknown[] | null = null;

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
      },
      clientInfo: { name: "agent-hub", version: "0.3.0" },
    });
    console.log(`[agent] ${this.name} initialized:`, JSON.stringify(init));
    this.ready = true;
    this.emit({
      method: "agent.status",
      params: { status: "ready", detail: `protocol v${init.protocolVersion}` },
    });
  }

  private onDisconnected(): void {
    this.ctx = null;
    this.conn = null;
    if (!this.ready && this.onClose) {
      this.onClose();
      return;
    }
    this.emit({
      method: "agent.status",
      params: { status: this.ready ? "exited" : "error" },
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
    };
    if (u.sessionUpdate === "usage_update") {
      this.emit({
        method: "session.usage",
        params: {
          sessionId: params.sessionId,
          usage: {
            used: u.used ?? 0,
            size: u.size ?? 0,
            cost: u.cost ?? null,
          },
        },
      });
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
    const doneParams: { sessionId: string; stopReason: string; output: string; usage?: TokenUsage } =
      { sessionId, stopReason, output: fullText.slice(-OUTPUT_CAPTURE_LEN) };
    if (usage) doneParams.usage = usage;
    this.emit({ method: "prompt.done", params: doneParams });
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

  private handleReadTextFile(params: { sessionId: string; path: string }): { content: string } {
    const target = this.resolveSessionPath(params.sessionId, params.path);
    const content = fs.readFileSync(target, "utf-8");
    return { content };
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

  /** 返回最近一次 session.new 的 configOptions（含模型列表等） */
  getConfigOptions(): unknown[] | null {
    return this.cachedConfigOptions;
  }

  /** 恢复历史会话：优先 session/resume，回退 session/load */
  async resumeSession(sessionId: string, cwd: string, name: string): Promise<boolean> {
    await this.ensureStarted();
    try {
      await this.ctx!.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      });
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
        await this.ctx!.request(acp.methods.agent.session.load, {
          sessionId,
          cwd,
          mcpServers: [],
        });
        console.log(`[agent] resumed ${sessionId} via session/load`);
      } catch (err) {
        this.sessions.delete(sessionId);
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
    for (const block of prompt) {
      if (block.type === "text") {
        entry.turnText += (block.text as string) ?? "";
      } else if (block.type === "image") {
        entry.turnText += "[图片]";
      }
    }
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
        entry.busy = false;
        entry.stoppable = false;
        this.emit({
          method: "session.generating",
          params: { sessionId, stoppable: false },
        });
        this.emit({
          method: "prompt.error",
          params: { sessionId, message: String(err) },
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
    await this.ctx!.request(acp.methods.agent.session.setConfigOption, params as never);
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
