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
