import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { Stream } from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
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
  | { method: "agent.status"; params: { status: string; detail?: string } };

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

  constructor(
    private readonly name: string,
    private readonly stream: Stream,
    private readonly emit: (event: HubEvent) => void,
    private readonly onClose?: () => void,
    private readonly process?: ChildProcess,
    private readonly onTurnEnd?: (sessionId: string, text: string) => void,
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
      clientCapabilities: {},
      clientInfo: { name: "agent-hub", version: "0.1.0" },
    });
    console.log(`[agent] ${this.name} initialized:`, JSON.stringify(init));
    this.emit({
      method: "agent.status",
      params: { status: "ready", detail: `protocol v${init.protocolVersion}` },
    });
  }

  private onDisconnected(): void {
    this.ctx = null;
    this.conn = null;
    this.emit({ method: "agent.status", params: { status: "exited" } });
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

  async createSession(
    cwd: string,
    name?: string,
  ): Promise<{ sessionId: string; name: string }> {
    await this.ensureStarted();
    const resp = await this.ctx!.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
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
