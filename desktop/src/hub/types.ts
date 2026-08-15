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
  error?: string;
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
  type: "file" | "event";
  action?: string;
  path?: string;
  summary: string;
}

export interface BlackboardInfo {
  id: string;
  from: string;
  text: string;
  detail: string;
  at: number;
}

export interface FileTreeRoot {
  name: string;
  path: string;
  kind: string;
  sessionId?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: string;
  at: number;
  size?: number;
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

export interface ArtifactInfo {
  id: string;
  alias?: string;
  kind: "file" | "event";
  /** 事件动作类型 */
  action?: string;
  author: string;
  at: number;
  summary: string;
  path?: string;
  /** 重命名事件中的原路径 */
  oldPath?: string;
  command?: string;
  taskId?: string;
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
  /** 当前房间中正在发言的 sessionId */
  activeSpeaker?: string | null;
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
  at?: number;
  id?: number;
}

export interface SearchGroup {
  scope: string;
  scopeId: string;
  count: number;
  previews: SearchHit[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface ContextUsage {
  used: number;
  size: number;
  costAmount?: number;
  costCurrency?: string;
}

export interface Attachment {
  mimeType: string;
  base64: string;
  name: string;
}

export interface ModelInfo {
  uid: string;
  label: string;
  family: string;
  vendor: string;
  slug: string;
  aliases: string[];
  costTier: string;
  costSummary?: string;
  isCurrent?: boolean;
}

export type ChatItem =
  | { kind: "user"; at?: number; historyId?: number; text: string; author: string; attachments?: Attachment[]; quoteAuthor?: string; quoteText?: string }
  | { kind: "system"; at?: number; historyId?: number; text: string; author: string }
  | { kind: "assistant"; at?: number; historyId?: number; id: number; text: string; author: string; usage?: TokenUsage; quoteAuthor?: string; quoteText?: string }
  | { kind: "thought"; at?: number; historyId?: number; id: number; text: string; author: string; quoteAuthor?: string; quoteText?: string }
  | { kind: "tool"; at?: number; historyId?: number; toolCallId: string; title: string; status: string; author: string }
  | { kind: "plan"; at?: number; historyId?: number; entries: string[]; author: string }
  | { kind: "error"; at?: number; historyId?: number; text: string; author: string }
  | {
      kind: "permission";
      at?: number;
      historyId?: number;
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
