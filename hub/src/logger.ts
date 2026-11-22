import { StringDecoder } from "node:string_decoder";

export function logError(context: string, err: unknown): void {
  console.error(`[hub] error in ${context}:`, err instanceof Error ? err.stack ?? err.message : String(err));
}

export function logWarn(context: string, message: string): void {
  console.warn(`[hub] ${context}: ${message}`);
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const TRACING_INFO_RE = /^\S+Z\s+(INFO|DEBUG|TRACE)\s/;

export function createStderrForwarder(
  write: (s: string) => void,
  all = process.env.HUB_AGENT_STDERR === "all",
): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emitLine = (line: string) => {
    if (!all && TRACING_INFO_RE.test(line.replace(ANSI_RE, ""))) return;
    write(line + "\n");
  };
  const drain = (text: string) => {
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
  };
  return {
    push(chunk: Buffer | string) {
      drain(typeof chunk === "string" ? chunk : decoder.write(chunk));
    },
    end() {
      drain(decoder.end());
      if (pending) {
        const line = pending;
        pending = "";
        emitLine(line);
      }
    },
  };
}
