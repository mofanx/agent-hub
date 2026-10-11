import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/;

export function startAgent(options: {
  hubId: string;
  gatewayUrl: string;
  gatewayToken: string;
  publicToken?: string;
  localHubUrl: string;
  hubToken: string;
}) {
  const { hubId, gatewayUrl, gatewayToken, localHubUrl, hubToken } = options;
  const base = gatewayUrl.replace(/\/$/, '');
  const controlUrl = `${base}/control/${encodeURIComponent(hubId)}`;
  const publicToken = options.publicToken && TOKEN_RE.test(options.publicToken) ? options.publicToken : generateToken();

  let remote: WebSocket | null = null;
  let local: WebSocket | null = null;

  const connectLocal = () => {
    const sep = localHubUrl.includes('?') ? '&' : '?';
    const localUrl = `${localHubUrl}${sep}token=${encodeURIComponent(hubToken)}`;
    local = new WebSocket(localUrl);

    local.on('open', () => {
      console.log(`[agent] connected to local Hub`);
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
    if (local && local.readyState === WebSocket.OPEN) local.send(toText(data));
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

function toText(data: WebSocket.Data): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}
