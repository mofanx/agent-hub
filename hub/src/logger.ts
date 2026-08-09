export function logError(context: string, err: unknown): void {
  console.error(`[hub] error in ${context}:`, err instanceof Error ? err.stack ?? err.message : String(err));
}

export function logWarn(context: string, message: string): void {
  console.warn(`[hub] ${context}: ${message}`);
}
