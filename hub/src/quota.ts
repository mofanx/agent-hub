import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface QuotaWindow {
  remainingPercent: number;
  usedPercent: number;
  resetAtUnix?: number;
}

export interface DevinQuota {
  backend: "devin";
  available: boolean;
  planName?: string;
  billingStrategy?: string;
  daily?: QuotaWindow;
  weekly?: QuotaWindow;
  updatedAt: number;
  error?: string;
}

interface Credentials {
  apiKey: string;
  apiServerUrl: string;
}

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

let cache: { at: number; quota: DevinQuota } | null = null;
let inflight: Promise<DevinQuota> | null = null;

export function credentialsPath(): string {
  return process.env.DEVIN_CREDENTIALS_FILE
    ?? join(homedir(), ".local", "share", "devin", "credentials.toml");
}

export function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/\\(["\\])/g, "$1");
  }
  return out;
}

export async function loadDevinCredentials(path = credentialsPath()): Promise<Credentials> {
  const text = await readFile(path, "utf8");
  const values = parseTomlStrings(text);
  const apiKey = values.windsurf_api_key;
  if (!apiKey) throw new Error("no Devin API key in credentials.toml");
  return {
    apiKey,
    apiServerUrl: (values.api_server_url || "https://server.codeium.com").replace(/\/+$/, ""),
  };
}

function clampPercent(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function unixSeconds(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function normalizeUserStatus(data: unknown): DevinQuota {
  const root = (data ?? {}) as Record<string, unknown>;
  const userStatus = (root.userStatus ?? {}) as Record<string, unknown>;
  const plan = (userStatus.planStatus ?? {}) as Record<string, unknown>;
  const planInfo = (plan.planInfo ?? root.planInfo ?? {}) as Record<string, unknown>;

  const quota: DevinQuota = {
    backend: "devin",
    available: false,
    updatedAt: Date.now(),
  };
  if (planInfo.planName) quota.planName = String(planInfo.planName);
  if (planInfo.billingStrategy) quota.billingStrategy = String(planInfo.billingStrategy);

  const dailyRemaining = clampPercent(plan.dailyQuotaRemainingPercent);
  const weeklyRemaining = clampPercent(plan.weeklyQuotaRemainingPercent);
  const hideDaily = planInfo.hideDailyQuota === true;

  const window = (remaining: number, resetAt: unknown): QuotaWindow => {
    const w: QuotaWindow = { remainingPercent: remaining, usedPercent: 100 - remaining };
    const reset = unixSeconds(resetAt);
    if (reset !== undefined) w.resetAtUnix = reset;
    return w;
  };

  if (!hideDaily && dailyRemaining !== undefined) {
    quota.daily = window(dailyRemaining, plan.dailyQuotaResetAtUnix);
  }
  if (weeklyRemaining !== undefined) {
    quota.weekly = window(weeklyRemaining, plan.weeklyQuotaResetAtUnix);
  }
  quota.available = quota.daily !== undefined || quota.weekly !== undefined;
  return quota;
}

export async function fetchDevinQuota(opts: {
  credentialsFile?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<DevinQuota> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const creds = await loadDevinCredentials(opts.credentialsFile);
    const resp = await doFetch(
      `${creds.apiServerUrl}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: JSON.stringify({
          metadata: {
            apiKey: creds.apiKey,
            ideName: "devin",
            ideVersion: process.env.DEVIN_CLI_VERSION ?? "0.0.0",
            extensionName: "devin",
            extensionVersion: process.env.DEVIN_CLI_VERSION ?? "0.0.0",
            locale: "en",
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!resp.ok) throw new Error(`GetUserStatus ${resp.status}`);
    return normalizeUserStatus(await resp.json());
  } catch (err) {
    return {
      backend: "devin",
      available: false,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 远端上报的配额窗口：usedPercent 必填，remainingPercent/resetAt 可选 */
export interface ReportedQuotaWindow {
  usedPercent: number;
  remainingPercent?: number;
  resetAt?: number;
}

/** 远端上报的配额形状（对齐 DevinQuota，去掉 backend/updatedAt——updatedAt 由 hub 侧记录） */
export interface ReportedQuota {
  available: boolean;
  planName?: string;
  billingStrategy?: string;
  daily?: ReportedQuotaWindow;
  weekly?: ReportedQuotaWindow;
  error?: string;
}

/** hub.quotaReport 校验后的结果：scope 缺省按 id 推断（有 sessionId → session，否则 connection） */
export interface QuotaReport {
  scope: "connection" | "session";
  connectionId?: string | undefined;
  sessionId?: string | undefined;
  quota: ReportedQuota;
}

function reportedWindow(v: unknown, field: string): ReportedQuotaWindow | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new Error(`invalid quota.${field}`);
  const w = v as Record<string, unknown>;
  const used = clampPercent(w.usedPercent);
  if (used === undefined) throw new Error(`invalid quota.${field}.usedPercent`);
  const out: ReportedQuotaWindow = { usedPercent: used };
  const remaining = clampPercent(w.remainingPercent);
  if (remaining !== undefined) out.remainingPercent = remaining;
  const reset = unixSeconds(w.resetAt ?? w.resetAtUnix);
  if (reset !== undefined) out.resetAt = reset;
  return out;
}

/** quota 字段校验：available/daily/weekly 形状不合法即抛错，容忍附加字段 */
export function validateReportedQuota(raw: unknown): ReportedQuota {
  if (typeof raw !== "object" || raw === null) throw new Error("quota required");
  const q = raw as Record<string, unknown>;
  if (q.available !== undefined && typeof q.available !== "boolean") {
    throw new Error("invalid quota.available");
  }
  const quota: ReportedQuota = { available: q.available === true };
  if (typeof q.planName === "string" && q.planName) quota.planName = q.planName;
  if (typeof q.billingStrategy === "string" && q.billingStrategy) quota.billingStrategy = q.billingStrategy;
  if (typeof q.error === "string" && q.error) quota.error = q.error;
  const daily = reportedWindow(q.daily, "daily");
  if (daily) quota.daily = daily;
  const weekly = reportedWindow(q.weekly, "weekly");
  if (weekly) quota.weekly = weekly;
  return quota;
}

/** hub.quotaReport 参数校验：shape 对齐 validateGatewayAnnounce 的收紧风格 */
export function validateQuotaReport(raw: unknown): QuotaReport {
  const p = (raw ?? {}) as Record<string, unknown>;
  const scopeRaw = p.scope;
  if (scopeRaw !== undefined && scopeRaw !== "connection" && scopeRaw !== "session") {
    throw new Error(`invalid scope: ${String(scopeRaw)}`);
  }
  const connectionId =
    typeof p.connectionId === "string" && p.connectionId.trim()
      ? p.connectionId.trim()
      : undefined;
  const sessionId =
    typeof p.sessionId === "string" && p.sessionId.trim()
      ? p.sessionId.trim()
      : undefined;
  const scope = (scopeRaw as "connection" | "session" | undefined) ??
    (sessionId ? "session" : "connection");
  if (scope === "connection" && !connectionId) throw new Error("connectionId required");
  if (scope === "session" && !sessionId) throw new Error("sessionId required");
  return { scope, connectionId, sessionId, quota: validateReportedQuota(p.quota) };
}

/**
 * 远端配额上报表：conn:<connectionId> / sess:<sessionId> → 最近一次上报。
 * 仅内存态不持久化：上报方周期重推（60s），hub 重启后一分钟内自愈；
 * 超过 QUOTA_REPORT_STALE_MS 未刷新视为过期，读取时惰性清除并下发 null。
 */
export const QUOTA_REPORT_STALE_MS = 5 * 60_000;
const MAX_QUOTA_REPORTS = 512;

type QuotaReportEntry = { quota: ReportedQuota; updatedAt: number };
const quotaReports = new Map<string, QuotaReportEntry>();

function reportKey(scope: "connection" | "session", id: string): string {
  return `${scope === "session" ? "sess" : "conn"}:${id}`;
}

export function recordQuotaReport(report: QuotaReport, now = Date.now()): number {
  const id = report.scope === "session" ? report.sessionId : report.connectionId;
  const key = reportKey(report.scope, id!);
  if (!quotaReports.has(key) && quotaReports.size >= MAX_QUOTA_REPORTS) {
    // 淘汰最旧条目，防伪造 id 撑爆内存
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of quotaReports) {
      if (v.updatedAt < oldestAt) {
        oldestAt = v.updatedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) quotaReports.delete(oldestKey);
  }
  quotaReports.set(key, { quota: report.quota, updatedAt: now });
  return now;
}

/** 成员/会话视角查询：session 级上报优先于 connection 级；无上报或过期返回 null。 */
export function quotaFor(
  opts: { sessionId?: string | undefined; connectionId?: string | undefined },
  now = Date.now(),
): (ReportedQuota & { updatedAt: number }) | null {
  const keys = [
    opts.sessionId ? reportKey("session", opts.sessionId) : undefined,
    opts.connectionId ? reportKey("connection", opts.connectionId) : undefined,
  ];
  for (const key of keys) {
    if (!key) continue;
    const entry = quotaReports.get(key);
    if (!entry) continue;
    if (now - entry.updatedAt > QUOTA_REPORT_STALE_MS) {
      quotaReports.delete(key);
      continue;
    }
    return { ...entry.quota, updatedAt: entry.updatedAt };
  }
  return null;
}

/** worker 断连/connection 删除时清掉其配额条目（sess 级按该连接名下会话一并清） */
export function clearQuotaReports(connectionId?: string, sessionIds: string[] = []): void {
  if (connectionId) quotaReports.delete(reportKey("connection", connectionId));
  for (const sid of sessionIds) quotaReports.delete(reportKey("session", sid));
}

export function resetQuotaReports(): void {
  quotaReports.clear();
}

export function getDevinQuota(force = false): Promise<DevinQuota> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.quota);
  }
  if (!inflight) {
    inflight = fetchDevinQuota()
      .then((quota) => {
        if (quota.available) cache = { at: Date.now(), quota };
        return quota;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function resetDevinQuotaCache(): void {
  cache = null;
  inflight = null;
}
