import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchLocalDevinQuota } from './quota.js';

const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/;
const HUB_ID_RE = /^[a-zA-Z0-9_-]{16,64}$/;
/** 通道化信封协议版本，须与 gateway server 一致 */
const PROTO_V = 1;

const envelope = (msg: Record<string, unknown>) => JSON.stringify({ v: PROTO_V, ...msg });

/** 日志脱敏：startAgent 注册密钥后，本模块所有日志出口统一替换为 <redacted>。
 *  单点防护——后续新增日志点天然带上，优于逐点脱敏。 */
let SECRETS: string[] = [];
const redact = (v: unknown): unknown =>
  typeof v === 'string' ? SECRETS.reduce((s, t) => (t ? s.split(t).join('<redacted>') : s), v) : v;
const log = (...a: unknown[]) => console.log(...a.map(redact));
const warn = (...a: unknown[]) => console.warn(...a.map(redact));

export function startAgent(options: {
  hubId: string;
  gatewayUrl: string;
  gatewayToken: string;
  publicToken?: string;
  localHubUrl: string;
  hubToken: string;
}) {
  const { hubId, gatewayUrl, gatewayToken, localHubUrl, hubToken } = options;
  // 本地先行校验：非法 hubId 必然被 server 1008，提前 fail 比连上再被拒更清晰，
  // 也避免 sanitize 后不同 hubId 共用 token 文件
  if (!HUB_ID_RE.test(hubId)) throw new Error(`invalid hubId: ${hubId}`);
  const base = gatewayUrl.replace(/\/$/, '');
  const controlUrl = `${base}/control/${encodeURIComponent(hubId)}`;
  const publicToken = resolvePublicToken(hubId, options.publicToken);
  SECRETS = [gatewayToken, publicToken, hubToken].filter((t) => t.length >= 8);
  const localBase = localHubUrl.replace(/\/$/, '');

  let remote: WebSocket | null = null;
  /** ch -> 本地 hub 连接：客户端开 /?token=hubToken，远程后端开 /worker?...（透传 query） */
  const localConns = new Map<number, WebSocket>();
  /** ch -> 本地连接就绪前缓冲的下行帧（有界） */
  const pending = new Map<number, string[]>();

  /**
   * 本地 hub 上报通道：一条常驻客户端连接复用 gatewayAnnounce + 周期 quotaReport。
   * hub 重启会丢内存态（gatewayInfo / 配额表），断线重连后需重放 announce。
   */
  let hubWs: WebSocket | null = null;
  let announceParams: { publicUrl: string; publicToken: string } | null = null;
  /** quotaReport 归附的 connectionId：env 覆盖 > connection.list 解析 > 兜底 local-devin */
  let quotaConnectionId: string | null =
    process.env.HUB_QUOTA_CONNECTION_ID?.trim() || null;
  let hubRpcSeq = 0;

  const hubSend = (msg: Record<string, unknown>) => {
    if (hubWs && hubWs.readyState === WebSocket.OPEN) {
      hubWs.send(JSON.stringify(msg));
    }
  };

  const pendingHubRpc = new Map<string, (v: unknown) => void>();

  /** 简单 RPC：只认 {id, result} 响应，5s 超时 */
  const hubCall = (method: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = `gw-rpc-${++hubRpcSeq}`;
      const timer = setTimeout(() => {
        pendingHubRpc.delete(id);
        reject(new Error(`${method} timeout`));
      }, 5000);
      pendingHubRpc.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      hubSend({ id, method });
    });

  const resolveQuotaConnectionId = async (): Promise<string> => {
    if (quotaConnectionId) return quotaConnectionId;
    try {
      const res = (await hubCall('connection.list')) as {
        connections?: { id?: string; agent?: string; local?: boolean }[];
      };
      const conns = res.connections ?? [];
      quotaConnectionId =
        conns.find((c) => c.id === 'local-devin')?.id ??
        conns.find((c) => c.local && c.agent === 'devin')?.id ??
        null;
    } catch (err) {
      warn(`[agent] connection.list failed: ${String(err)}`);
    }
    // 解析不到时兜底标准种子 id：挂在不存在的连接上仅是不匹配，无副作用
    return quotaConnectionId ?? 'local-devin';
  };

  const reportQuota = async () => {
    const quota = await fetchLocalDevinQuota();
    const connectionId = await resolveQuotaConnectionId();
    hubSend({
      id: `gw-quota-${Date.now()}`,
      method: 'hub.quotaReport',
      params: { scope: 'connection', connectionId, quota },
    });
  };

  const ensureHubConn = () => {
    if (hubWs && hubWs.readyState !== WebSocket.CLOSED) return;
    const ws = new WebSocket(`${localBase}/?token=${encodeURIComponent(hubToken)}`);
    hubWs = ws;
    ws.on('open', () => {
      if (announceParams) {
        hubSend({ id: 'gw-announce', method: 'hub.gatewayAnnounce', params: announceParams });
      }
      reportQuota().catch(() => {});
    });
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(toText(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const resolve = typeof msg.id === 'string' ? pendingHubRpc.get(msg.id) : undefined;
      if (resolve) {
        pendingHubRpc.delete(msg.id as string);
        resolve(msg.result);
      }
      // 其余为 hub 事件广播，忽略
    });
    ws.on('close', () => {
      if (hubWs === ws) hubWs = null;
      setTimeout(ensureHubConn, 5000);
    });
    ws.on('error', (err) => {
      warn(`[agent] local hub conn error: ${err.message}`);
    });
  };

  const announceToHub = (params: { publicUrl: string; publicToken: string }) => {
    announceParams = params;
    ensureHubConn();
    hubSend({ id: 'gw-announce', method: 'hub.gatewayAnnounce', params });
  };

  // 启动即建本地 hub 连接并周期上报本机 devin 配额（默认 60s，HUB_QUOTA_INTERVAL_MS 可调）
  ensureHubConn();
  setInterval(
    () => reportQuota().catch(() => {}),
    Number(process.env.HUB_QUOTA_INTERVAL_MS ?? 60_000),
  );

  /** open 帧 → 建立对应的本地 hub 连接 */
  const openLocal = (ch: number, path: string) => {
    const isWorker = path.startsWith('/worker');
    // via 参数标记中继来源：客户端通道 via=gateway，worker 通道 via=gateway-worker
    const localUrl = isWorker
      ? `${localBase}${path}${path.includes('?') ? '&' : '?'}via=gateway-worker`
      : `${localBase}/?token=${encodeURIComponent(hubToken)}&via=gateway`;
    const conn = new WebSocket(localUrl);
    localConns.set(ch, conn);
    pending.set(ch, []);

    conn.on('open', () => {
      const buf = pending.get(ch) ?? [];
      pending.delete(ch);
      for (const m of buf) conn.send(m);
    });
    conn.on('message', (data) => {
      if (remote && remote.readyState === WebSocket.OPEN) {
        remote.send(envelope({ type: 'data', ch, payload: toText(data) }));
      }
    });
    const cleanup = () => {
      if (localConns.get(ch) !== conn) return;
      localConns.delete(ch);
      pending.delete(ch);
      if (remote && remote.readyState === WebSocket.OPEN) {
        remote.send(envelope({ type: 'close', ch }));
      }
    };
    conn.on('close', cleanup);
    conn.on('error', (err) => {
      warn(`[agent] local conn ch=${ch} error: ${err.message}`);
      conn.close();
    });
  };

  const closeLocal = (ch: number) => {
    const conn = localConns.get(ch);
    localConns.delete(ch);
    pending.delete(ch);
    conn?.close();
  };

  /** 致命 code：认证/策略/协议类——重连无意义，exit 让 PM2 兜底 */
  const FATAL_CODES = new Set([1000, 1008, 4001, 4003, 4403]);
  /** 重连指标：重连风暴不能无声——结构化字段随重连日志输出 */
  const stats = { reconnects: 0, lastCloseCode: -1, lastDisconnectAt: '' };
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
  remote = new WebSocket(controlUrl, {
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'X-Public-Token': publicToken,
    },
  });

  // 控制通道心跳：Cloudflare ~100s 空闲超时掐断 remote，25s ping 保活；
  // isAlive 死连接检测：上轮 pong 未回（TCP 半开/僵尸连接）→ terminate 走进程级重连，
  // 比等内核 tcp_retries2 (~15-30min) 恢复快；readyState 先判 OPEN——非 OPEN 态 ping 会同步 throw
  const HEARTBEAT_MS = 25_000;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let remoteAlive = false;

  remote.on('open', () => {
    log(`[agent] connected to gateway as ${hubId}`);
    reconnectAttempts = 0;
    // 协议握手：server 要求 control 首帧为 hello，否则按旧版拒绝
    remote?.send(envelope({ type: 'hello', proto: PROTO_V }));
    remoteAlive = true;
    heartbeat = setInterval(() => {
      if (!remoteAlive) {
        warn('[agent] heartbeat pong timeout, terminating');
        remote?.terminate();
        return;
      }
      remoteAlive = false;
      if (remote?.readyState === WebSocket.OPEN) remote.ping();
    }, HEARTBEAT_MS);
  });

  remote.on('pong', () => {
    remoteAlive = true;
  });

  remote.on('message', (data) => {
    const text = toText(data);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      warn('[agent] protocol mismatch: non-JSON control frame (gateway upgrade required)');
      remote?.close(1008, 'protocol mismatch');
      return;
    }
    if (msg.type === 'registered') {
      log(`[agent] public url: ${msg.publicUrl}`);
      log('[agent] public token: <redacted>');
      if (typeof msg.publicUrl === 'string' && typeof msg.publicToken === 'string') {
        announceToHub({ publicUrl: msg.publicUrl, publicToken: msg.publicToken });
      }
      return;
    }
    // 信封帧：v:1 + open/data/close
    if (msg.v !== PROTO_V) {
      warn('[agent] protocol mismatch: non-envelope frame (gateway upgrade required)');
      remote?.close(1008, 'protocol mismatch');
      return;
    }
    const ch = typeof msg.ch === 'number' ? msg.ch : -1;
    if (msg.type === 'open' && typeof msg.path === 'string') {
      openLocal(ch, msg.path);
      return;
    }
    if (msg.type === 'data' && typeof msg.payload === 'string') {
      const conn = localConns.get(ch);
      if (conn && conn.readyState === WebSocket.OPEN) {
        conn.send(msg.payload);
      } else if (conn && conn.readyState === WebSocket.CONNECTING) {
        const buf = pending.get(ch);
        if (buf && buf.length < 500) buf.push(msg.payload);
      }
      // 本地连接已不存在/正在关闭：丢弃并回 close，让 server 侧释放该通道
      else if (!conn) {
        remote?.send(envelope({ type: 'close', ch }));
      }
      return;
    }
    if (msg.type === 'close') {
      closeLocal(ch);
      return;
    }
  });

  remote.on('close', (code, reason) => {
    const reasonText = reason?.toString() ?? '';
    log(`[agent] gateway disconnected (code ${code}${reasonText ? `, reason: ${reasonText}` : ''})`);
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    for (const conn of localConns.values()) conn.close();
    localConns.clear();
    pending.clear();
    stats.lastCloseCode = code;
    stats.lastDisconnectAt = new Date().toISOString();
    if (FATAL_CODES.has(code)) {
      process.exit(code === 1000 ? 0 : 1);
      return;
    }
    // 瞬态断连：进程内指数退避重连（1s ×2 封顶 30s + ±30% jitter）；
    // 不设硬上限（长驻中继保活优于重启），连败 ≥10 次升 error 告警防静默
    const attempt = reconnectAttempts++;
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    stats.reconnects++;
    const meta = `attempt=${attempt + 1} delay=${delay}ms reconnects=${stats.reconnects} lastClose=${stats.lastCloseCode}`;
    if (attempt + 1 >= 10) {
      warn(`[agent] gateway reconnect backoff ${meta} lastDisconnectAt=${stats.lastDisconnectAt}`);
    } else {
      warn(`[agent] gateway reconnect backoff ${meta}`);
    }
    reconnectTimer = setTimeout(connect, delay);
  });

  remote.on('error', (err) => {
    // error→close 必然随后触发：只记日志，由 close 单点驱动重连/退出，防双计时器竞态
    warn('[agent] gateway error:', err.message);
  });
  };

  connect();
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function tokenPath(hubId: string): string {
  const isRoot = process.getuid?.() === 0;
  const dir = isRoot ? '/etc/hub-gateway' : `${process.env.HOME}/.config/hub-gateway`;
  const safeId = hubId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  return join(dir, `agent-${safeId}.token`);
}

// 未显式配置时生成一次并持久化：agent 进程重启必须复用同一 token，
// 否则客户端持旧 token 会被 server 1008 拒绝并永久重连失败
function resolvePublicToken(hubId: string, configured?: string): string {
  if (configured && TOKEN_RE.test(configured)) return configured;
  const file = tokenPath(hubId);
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(saved)) return saved;
  } catch {
    // 文件不存在或不可读，走生成路径
  }
  const fresh = generateToken();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, fresh, { mode: 0o600 });
    log(`[agent] public token generated and persisted: ${file}`);
  } catch (err) {
    warn(`[agent] failed to persist public token (${file}); clients will lose access on restart:`, err);
  }
  return fresh;
}

function toText(data: WebSocket.Data): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}
