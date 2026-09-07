import type { CheckDefinition, CheckRun, ProjectScope } from "./types.js";

/**
 * ExecutionProvider 统一接口（设计文档 §4.1 / §8）。
 * 实现负责在指定机器上以 shell:false 执行 check.argv，并返回 CheckRun。
 */
export interface ExecutionProvider {
  run(project: ProjectScope, check: CheckDefinition, runId: string): Promise<CheckRun>;
  cancel(runId: string, checkId?: string): Promise<void>;
}

/** 生成 CheckRun 的稳定 id：`<runId>:<checkId>:<attempt>`。 */
export function checkRunId(runId: string, checkId: string, attempt: number): string {
  return `${runId}:${checkId}:${attempt}`;
}

/** 默认输出摘要截断长度。 */
export const SUMMARY_LIMIT = 4096;

/** 默认环境变量白名单（不继承秘密值到日志）。 */
export const DEFAULT_ENV_WHITELIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "npm_config_cache",
  "NODE_OPTIONS",
];
