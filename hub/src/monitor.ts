import { monitorEventLoopDelay } from "node:perf_hooks";

const INTERVAL_MS = 30_000;

/**
 * env 门控性能采样（HUB_PERF_MONITOR=1）：事件循环延迟是本类同步阻塞
 * （better-sqlite3/JSON.stringify/目录遍历）最敏感的探针；30s 一行 JSON
 * 到 stdout，由 pm2 out.log + logrotate 收集。extras 由宿主注入在线量
 * （clients/agents/bufferedAmount 等），避免本模块反向依赖 index。
 */
export function startPerfMonitor(extras?: () => Record<string, number>): void {
  if (process.env.HUB_PERF_MONITOR !== "1") return;
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  const timer = setInterval(() => {
    try {
      const m = process.memoryUsage();
      console.log(
        `[perf] ${JSON.stringify({
          rss: m.rss,
          heapUsed: m.heapUsed,
          external: m.external,
          eldP50Ms: ms(eld.percentile(50)),
          eldP99Ms: ms(eld.percentile(99)),
          eldMaxMs: ms(eld.max),
          ...extras?.(),
        })}`,
      );
    } catch {
      // 采样异常（如 extras 抛错）不得中断监控或打崩宿主进程
    }
    eld.reset();
  }, INTERVAL_MS);
  timer.unref();
}
