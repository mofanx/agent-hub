/**
 * 本机 devin 配额读取：hub/src/quota.ts 的精简复制版。
 * gateway 是独立部署包、不引用 hub 源码，故重复实现而非共享；
 * 输出形状对齐 hub.quotaReport 的 quota 字段（resetAt 为 unix 秒）。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ReportedQuotaWindow {
  usedPercent: number;
  remainingPercent?: number;
  resetAt?: number;
}

export interface ReportedQuota {
  available: boolean;
  planName?: string;
  billingStrategy?: string;
  daily?: ReportedQuotaWindow;
  weekly?: ReportedQuotaWindow;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 8_000;

function credentialsPath(): string {
  return (
    process.env.DEVIN_CREDENTIALS_FILE ??
    join(homedir(), '.local', 'share', 'devin', 'credentials.toml')
  );
}

function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (m?.[1]) out[m[1]] = (m[2] ?? '').replace(/\\(["\\])/g, '$1');
  }
  return out;
}

function clampPercent(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function unixSeconds(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function normalizeUserStatus(data: unknown): ReportedQuota {
  const root = (data ?? {}) as Record<string, unknown>;
  const userStatus = (root.userStatus ?? {}) as Record<string, unknown>;
  const plan = (userStatus.planStatus ?? {}) as Record<string, unknown>;
  const planInfo = (plan.planInfo ?? root.planInfo ?? {}) as Record<string, unknown>;

  const quota: ReportedQuota = { available: false };
  if (planInfo.planName) quota.planName = String(planInfo.planName);
  if (planInfo.billingStrategy) quota.billingStrategy = String(planInfo.billingStrategy);

  const win = (remaining: number, resetAt: unknown): ReportedQuotaWindow => {
    const w: ReportedQuotaWindow = { usedPercent: 100 - remaining, remainingPercent: remaining };
    const reset = unixSeconds(resetAt);
    if (reset !== undefined) w.resetAt = reset;
    return w;
  };

  const dailyRemaining = clampPercent(plan.dailyQuotaRemainingPercent);
  const weeklyRemaining = clampPercent(plan.weeklyQuotaRemainingPercent);
  if (planInfo.hideDailyQuota !== true && dailyRemaining !== undefined) {
    quota.daily = win(dailyRemaining, plan.dailyQuotaResetAtUnix);
  }
  if (weeklyRemaining !== undefined) {
    quota.weekly = win(weeklyRemaining, plan.weeklyQuotaResetAtUnix);
  }
  quota.available = quota.daily !== undefined || quota.weekly !== undefined;
  return quota;
}

/** 读本机 credentials.toml → GetUserStatus；失败返回 available:false + error，不抛。 */
export async function fetchLocalDevinQuota(): Promise<ReportedQuota> {
  try {
    const values = parseTomlStrings(await readFile(credentialsPath(), 'utf8'));
    const apiKey = values.windsurf_api_key;
    if (!apiKey) throw new Error('no Devin API key in credentials.toml');
    const server = (values.api_server_url || 'https://server.codeium.com').replace(/\/+$/, '');
    const resp = await fetch(
      `${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
        body: JSON.stringify({
          metadata: {
            apiKey,
            ideName: 'devin',
            ideVersion: process.env.DEVIN_CLI_VERSION ?? '0.0.0',
            extensionName: 'devin',
            extensionVersion: process.env.DEVIN_CLI_VERSION ?? '0.0.0',
            locale: 'en',
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!resp.ok) throw new Error(`GetUserStatus ${resp.status}`);
    return normalizeUserStatus(await resp.json());
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}
