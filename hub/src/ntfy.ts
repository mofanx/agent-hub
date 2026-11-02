/** ntfy 推送：自托管无 FCM 的触达兜底。
 *  客户端离线（连接数=0）时对 waitingFor/求助/任务完成类事件发 ntfy 通知，
 *  点通知拉起 app 自同步。默认关闭（无 topic 不打扰），环境变量开启。
 *
 *  配置：NTFY_URL（默认 https://ntfy.sh）+ NTFY_TOPIC（必填才启用）
 *  可选：NTFY_TOKEN（Bearer）、NTFY_MAX_PER_HOUR（默认 6/房）
 *  隐私：正文只含房名+事件类型，不带任何消息内容。 */

export type NtfyKind = "attention" | "task.done";

export interface NtfyConfig {
  enabled: boolean;
  url: string;
  topic: string;
  token?: string | undefined;
  maxPerHour: number;
}

export function ntfyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NtfyConfig {
  const topic = (env.NTFY_TOPIC ?? "").trim();
  return {
    enabled: topic.length > 0,
    url: (env.NTFY_URL ?? "https://ntfy.sh").replace(/\/+$/, ""),
    topic,
    token: env.NTFY_TOKEN?.trim() || undefined,
    maxPerHour: Math.max(1, Number(env.NTFY_MAX_PER_HOUR ?? 6) || 6),
  };
}

const KIND_LABEL: Record<NtfyKind, string> = {
  attention: "有待你处理事项",
  "task.done": "任务已完成",
};

/** 滑动小时窗限频：每房每小时 maxPerHour 条 */
export class NtfyRateLimiter {
  private windows = new Map<string, number[]>();
  admit(key: string, cap: number, now = Date.now()): boolean {
    const cutoff = now - 3600_000;
    const hits = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= cap) {
      this.windows.set(key, hits);
      return false;
    }
    hits.push(now);
    this.windows.set(key, hits);
    return true;
  }
  remove(key: string): void {
    this.windows.delete(key);
  }
}

export class NtfyPusher {
  readonly limiter = new NtfyRateLimiter();
  constructor(
    public config: NtfyConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** 客户端离线时调用：限频内发送 ntfy。返回是否实际发出（测试可断言） */
  async notifyIfOffline(
    roomId: string,
    roomName: string,
    kind: NtfyKind,
    clientCount: number,
  ): Promise<boolean> {
    if (!this.config.enabled || clientCount > 0) return false;
    if (!this.limiter.admit(roomId, this.config.maxPerHour)) return false;
    const label = KIND_LABEL[kind];
    try {
      const res = await this.fetchFn(`${this.config.url}/${this.config.topic}`, {
        method: "POST",
        headers: {
          Title: `[agent-hub] ${label}`,
          Priority: "4",
          Tags: kind === "attention" ? "bell" : "white_check_mark",
          Click: `agenthub://attention?roomId=${encodeURIComponent(roomId)}`,
          ...(this.config.token
            ? { Authorization: `Bearer ${this.config.token}` }
            : {}),
        },
        body: `${roomName || roomId}：${label}`,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
