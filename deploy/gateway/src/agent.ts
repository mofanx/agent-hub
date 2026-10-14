import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/;
const HUB_ID_RE = /^[a-zA-Z0-9_-]{16,64}$/;

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

  let remote: WebSocket | null = null;
  let local: WebSocket | null = null;
  const localPending: string[] = [];

  const connectLocal = () => {
    const sep = localHubUrl.includes('?') ? '&' : '?';
    const localUrl = `${localHubUrl}${sep}token=${encodeURIComponent(hubToken)}`;
    local = new WebSocket(localUrl);
    localPending.length = 0;

    local.on('open', () => {
      console.log(`[agent] connected to local Hub`);
      const sock = local;
      for (const m of localPending.splice(0)) sock?.send(m);
    });

    local.on('message', (data) => {
      if (remote && remote.readyState === WebSocket.OPEN) remote.send(toText(data));
    });

    local.on('close', () => {
      console.log('[agent] local Hub disconnected');
      if (remote) remote.close();
    });

    local.on('error', (err) => {
      console.error('[agent] local Hub error:', err.message);
    });
  };

  remote = new WebSocket(controlUrl, {
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'X-Public-Token': publicToken,
    },
  });

  remote.on('open', () => {
    console.log(`[agent] connected to gateway as ${hubId}`);
    connectLocal();
  });

  remote.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'registered') {
        console.log(`[agent] public url: ${msg.publicUrl}`);
        console.log(`[agent] public token: ${msg.publicToken}`);
        return;
      }
    } catch {
      // not JSON, forward to local
    }
    // 本地 Hub socket 尚在握手时缓冲（有界），避免静默吞掉客户端请求
    if (local && local.readyState === WebSocket.OPEN) {
      local.send(toText(data));
    } else if (!local || local.readyState === WebSocket.CONNECTING) {
      if (localPending.length < 500) {
        localPending.push(toText(data));
      } else {
        remote?.close(1011, 'local hub unavailable');
      }
    } else {
      // local 正在关闭/已关闭：不吞消息，立即断隧道走进程重启
      remote?.close(1011, 'local hub closing');
    }
  });

  remote.on('close', (code) => {
    console.log(`[agent] gateway disconnected (code ${code})`);
    if (local) local.close();
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
