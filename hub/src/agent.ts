import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";

export type HubEvent =
  | { method: "session.update"; params: { sessionId: string; update: unknown } }
  | {
      method: "prompt.done";
      params: { sessionId: string; stopReason: string; output: string };
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
  turnText: string;
  loading?: boolean;
};

const PERMISSION_TIMEOUT_MS = 120_000;
const OUTPUT_CAPTURE_LEN = 800;

export class AcpAgent {
  private proc: ChildProcess | null = null;
  private ctx: acp.ClientContext | null = null;
  private sessions = new Map<string, SessionEntry>();
  private pendingPermissions = new Map<string, (optionId: string) => void>();
  private starting: Promise<void> | null = null;

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    private readonly emit: (event: HubEvent) => void,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.ctx) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    this.emit({ method: "agent.status", params: { status: "starting" } });
    this.proc = spawn(this.bin, this.args, {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc.on("exit", (code: number | null) => {
      this.ctx = null;
      this.proc = null;
      this.emit({
        method: "agent.status",
        params: { status: "exited", detail: `code=${code}` },
      });
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.proc.stdout!) as ReadableStream<Uint8Array>,
    );

    const app = acp
      .client({ name: "agent-hub" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) =>
        this.routeUpdate(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
        content: await fs.readFile(ctx.params.path, "utf8"),
      }))
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        await fs.writeFile(ctx.params.path, ctx.params.content, "utf8");
        return {};
      });

    const conn = app.connect(stream);
    this.ctx = conn.agent;

    const init = await this.ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: "agent-hub", version: "0.1.0" },
    });
    console.log("[agent] initialized:", JSON.stringify(init));
    this.emit({
      method: "agent.status",
      params: { status: "ready", detail: `protocol v${init.protocolVersion}` },
    });
  }

  private routeUpdate(params: { sessionId: string; update: unknown }): void {
    const entry = this.sessions.get(params.sessionId);
    if (!entry || entry.loading) return;
    const u = params.update as {
      sessionUpdate?: string;
      content?: { type: string; text?: string };
    };
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      entry.turnText += u.content.text ?? "";
    }
    this.emit({
      method: "session.update",
      params: { sessionId: params.sessionId, update: params.update },
    });
  }

  private finishTurn(sessionId: string, stopReason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.busy = false;
    this.emit({
      method: "prompt.done",
      params: {
        sessionId,
        stopReason,
        output: entry.turnText.slice(-OUTPUT_CAPTURE_LEN),
      },
    });
    entry.turnText = "";
  }

  private handlePermission(params: {
    sessionId: string;
    toolCall: unknown;
    options: PermissionOption[];
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } }> {
    const requestId = randomUUID();
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
        console.warn(`[agent] permission ${requestId} timed out -> ${fallback.optionId}`);
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
        console.warn(`[agent] resume ${sessionId} failed:`, String(err));
        return false;
      }
    }
    this.sessions.set(sessionId, { cwd, name, busy: false, turnText: "" });
    return true;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`unknown session: ${sessionId}`);
    if (entry.busy) throw new Error(`session busy: ${entry.name}`);
    entry.busy = true;
    entry.turnText = "";
    this.ctx!.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    })
      .then((resp) => this.finishTurn(sessionId, resp.stopReason))
      .catch((err: unknown) => {
        entry.busy = false;
        this.emit({
          method: "prompt.error",
          params: { sessionId, message: String(err) },
        });
      });
  }

  async cancel(sessionId: string): Promise<void> {
    if (!this.ctx) throw new Error("agent not started");
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  /** 本地摘除会话（不通知 agent，用于删除） */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listSessions(): {
    sessionId: string;
    cwd: string;
    name: string;
    busy: boolean;
  }[] {
    return [...this.sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      cwd: s.cwd,
      name: s.name,
      busy: s.busy,
    }));
  }
}
