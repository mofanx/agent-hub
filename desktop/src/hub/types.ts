export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = Record<string, JsonValue>;

export interface ConnProfile {
  name: string;
  address: string;
  port: string;
  token: string;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  agent: string;
  token: string;
  address: string;
  cwd: string;
  online: boolean;
  local: boolean;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  name: string;
  busy: boolean;
  agent: string;
  address: string;
  connectionId: string | null;
  offline: boolean;
  archived: boolean;
}

export interface RoomModeConfig {
  conductorId?: string | null;
  parallelSummarizerId?: string | null;
  pipelineOrder?: string[] | null;
  debateSides?: [string, string] | null;
  debateJudge?: string | null;
  debateRounds?: number | null;
}

export interface FlowArtifact {
  type: "file" | "command" | "test";
  path?: string;
  summary: string;
}

export interface FlowTask {
  id: string;
  sessionId: string;
  name: string;
  status: "pending" | "running" | "done" | "failed";
  task: string;
  dependsOn: string[];
  artifacts: FlowArtifact[];
}

export interface FlowInfo {
  roomId: string;
  phase: string;
  progress: { done: number; running: number; pending: number; failed: number; total: number };
  tasks: FlowTask[];
}

export interface RoomInfo {
  roomId: string;
  name: string;
  mode: string;
  conductorId: string | null;
  members: [string, string][];
  archived: boolean;
  /** 成员角色卡：sessionId -> persona */
  memberRoles?: Record<string, string> | null;
  /** 并行/集思广益：汇总者 sessionId */
  parallelSummarizerId?: string | null;
  /** 流水线：成员执行顺序 */
  pipelineOrder?: string[] | null;
  /** 辩论：正方/反方 sessionId */
  debateSides?: [string, string] | null;
  /** 辩论：裁判 sessionId */
  debateJudge?: string | null;
  /** 辩论：轮数 */
  debateRounds?: number | null;
}

export interface RoleInfo {
  id: string;
  name: string;
  persona: string;
  cwd: string | null;
  agent: string | null;
  address: string | null;
  connectionId: string | null;
  builtin: boolean;
}

export interface SearchHit {
  scope: string;
  scopeId: string;
  author: string;
  text: string;
}

export type ChatItem =
  | { kind: "user"; at?: number; text: string; author: string; quoteAuthor?: string; quoteText?: string }
  | { kind: "system"; at?: number; text: string; author: string }
  | { kind: "assistant"; at?: number; id: number; text: string; author: string }
  | { kind: "thought"; at?: number; id: number; text: string; author: string }
  | { kind: "tool"; at?: number; toolCallId: string; title: string; status: string; author: string }
  | { kind: "plan"; at?: number; entries: string[]; author: string }
  | { kind: "error"; at?: number; text: string; author: string }
  | {
      kind: "permission";
      at?: number;
      requestId: string;
      title: string;
      options: [string, string][];
      answered: string | null;
      author: string;
    };

export type Screen = "connect" | "sessions" | "chat" | "room" | "settings";

export interface SlashCommand {
  name: string;
  description: string;
}

export interface AppConfig {
  profiles: ConnProfile[];
  pinned: string[];
  cwds: string[];
  commands: string[];
  theme: string;
  lang: string;
  last: { address: string; port: string; token: string } | null;
}
