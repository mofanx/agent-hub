import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/;
const HUB_ID_RE = /^[a-zA-Z0-9_-]{16,64}$/;
/** 通道化信封协议版本，须与 gateway server 一致 */
const PROTO_V = 1;

const envelope = (msg: Record<string, unknown>) => JSON.stringify({ v: PROTO_V, ...msg });

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
  const localBase = localHubUrl.replace(/\/$/, '');

  let remote: WebSocket | null = null;
  /** ch -> 本地 hub 连接：客户端开 /?token=hubToken，远程后端开 /worker?...（透传 query） */
  const localConns = new Map<number, WebSocket>();
  /** ch -> 本地连接就绪前缓冲的下行帧（有界） */
  const pending = new Map<number, string[]>();

  /** 注册成功后向本地 hub 上报 gatewayAnnounce（配合 hub 侧 connectInfo；t2 提供方法） */
  const announceToHub = (params: { publicUrl: string; publicToken: string }) => {
    const url = `${localBase}/?token=${encodeURIComponent(hubToken)}`;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => ws.close(), 5000);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 'gw-announce',
          method: 'gatewayAnnounce',
          params,
        }),
      );
    });
    ws.on('message', () => {
      clearTimeout(timer);
      ws.close();
    });
    ws.on('close', () => clearTimeout(timer));
    ws.on('error', (err) => {
      clearTimeout(timer);
      console.warn(`[agent] gatewayAnnounce failed: ${err.message}`);
    });
  };

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
      console.warn(`[agent] local conn ch=${ch} error: ${err.message}`);
      conn.close();
    });
  };

  const closeLocal = (ch: number) => {
    const conn = localConns.get(ch);
    localConns.delete(ch);
    pending.delete(ch);
    conn?.close();
  };

  remote = new WebSocket(controlUrl, {
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'X-Public-Token': publicToken,
    },
  });

  remote.on('open', () => {
    console.log(`[agent] connected to gateway as ${hubId}`);
    // 协议握手：server 要求 control 首帧为 hello，否则按旧版拒绝
    remote?.send(envelope({ type: 'hello', proto: PROTO_V }));
  });

  remote.on('message', (data) => {
    const text = toText(data);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.warn('[agent] protocol mismatch: non-JSON control frame (gateway upgrade required)');
      remote?.close(1008, 'protocol mismatch');
      return;
    }
    if (msg.type === 'registered') {
      console.log(`[agent] public url: ${msg.publicUrl}`);
      console.log(`[agent] public token: ${msg.publicToken}`);
      if (typeof msg.publicUrl === 'string' && typeof msg.publicToken === 'string') {
        announceToHub({ publicUrl: msg.publicUrl, publicToken: msg.publicToken });
      }
      return;
    }
    // 信封帧：v:1 + open/data/close
    if (msg.v !== PROTO_V) {
      console.warn('[agent] protocol mismatch: non-envelope frame (gateway upgrade required)');
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

  remote.on('close', (code) => {
    console.log(`[agent] gateway disconnected (code ${code})`);
    for (const conn of localConns.values()) conn.close();
    localConns.clear();
    pending.clear();
    process.exit(code === 1000 ? 0 : 1);
  });

  remote.on('error', (err) => {
    console.error('[agent] gateway error:', err.message);
    process.exit(1);
  });
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
    console.log(`[agent] public token generated and persisted: ${file}`);
  } catch (err) {
    console.error(`[agent] failed to persist public token (${file}); clients will lose access on restart:`, err);
  }
  return fresh;
}

function toText(data: WebSocket.Data): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}
