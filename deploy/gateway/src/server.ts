import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { randomBytes } from 'node:crypto';

interface HubState {
  agent: WebSocket;
  publicToken: string;
  clients: Set<WebSocket>;
  workers: Set<WebSocket>;
  /** ch -> 公网侧连接（client 与 worker 通道共用编号空间） */
  channels: Map<number, WebSocket>;
  nextCh: number;
  /** 协议握手完成标记：control 首帧必须是 {v:1,type:'hello'} */
  hello: boolean;
  since: string;
}

interface RateLimit {
  failures: number;
  lastFailure: number;
  connections: number;
  lastReset: number;
}

const HUB_ID_RE = /^[a-zA-Z0-9_-]{16,64}$/;
const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/;
/** 通道化信封协议版本：server/agent 必须一致，否则控制帧被拒 */
const PROTO_V = 1;

const envelope = (msg: Record<string, unknown>) => JSON.stringify({ v: PROTO_V, ...msg });

export function startServer(options: {
  port: number;
  host: string;
  gatewayToken: string;
  adminToken: string;
  maxClientsPerHub: number;
}) {
  const { port, host, gatewayToken, adminToken, maxClientsPerHub } = options;
  const hubs = new Map<string, HubState>();
  const limits = new Map<string, RateLimit>();

  const httpServer = createServer((req, res) => {
    const parsed = parse(req.url || '/', true);
    const parts = (parsed.pathname || '').split('/').filter(Boolean);
    const token = getBearer(req.headers.authorization);

    if (parts[0] === 'admin' && parts[1] === 'hubs') {
      if (!token || token !== adminToken) {
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        const list = Array.from(hubs.entries()).map(([id, state]) => ({
          hubId: id,
          connected: state.agent.readyState === WebSocket.OPEN,
          clients: state.clients.size,
          workers: state.workers.size,
          publicToken: state.publicToken,
          since: state.since,
        }));
        res.end(JSON.stringify({ hubs: list }));
        return;
      }
      if (req.method === 'DELETE' && parts[2]) {
        const hubId = parts[2];
        const state = hubs.get(hubId);
        if (state) {
          for (const ws of state.channels.values()) ws.close();
          state.agent.close();
          hubs.delete(hubId);
          res.statusCode = 204;
          res.end();
        } else {
          res.statusCode = 404;
          res.end('Not found');
        }
        return;
      }
      res.statusCode = 405;
      res.end('Method not allowed');
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: httpServer });

  /** 公网侧连接（client/worker 共用）：验 publicToken → 建 ch → 发 open 帧 */
  const handlePublic = (
    ws: WebSocket,
    state: HubState,
    kind: 'client' | 'worker',
    path: string,
    ip: string,
  ): void => {
    const set = kind === 'client' ? state.clients : state.workers;
    if (set.size >= maxClientsPerHub) {
      ws.close(1008, `Too many ${kind}s`);
      return;
    }
    const ch = state.nextCh++;
    set.add(ws);
    state.channels.set(ch, ws);
    console.log(`[gateway] ${kind} connected: ch=${ch}`);
    state.agent.send(envelope({ type: 'open', ch, path }));

    ws.on('message', (data) => {
      // agent 隧道不可用时不静默吞消息：断开让对端走重连/失败路径
      if (state.agent.readyState === WebSocket.OPEN) {
        state.agent.send(envelope({ type: 'data', ch, payload: toText(data) }));
      } else {
        ws.close(1013, 'Hub reconnecting');
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      state.channels.delete(ch);
      if (state.agent.readyState === WebSocket.OPEN) {
        state.agent.send(envelope({ type: 'close', ch }));
      }
    });
    ws.on('error', () => {});
    void ip;
  };

  wss.on('connection', (ws, req) => {
    const ip = getIp(req);
    const parsed = parse(req.url || '/', true);
    const parts = (parsed.pathname || '').split('/').filter(Boolean);
    const gatewayAuth = getBearer(req.headers.authorization);
    const publicTokenHeader = String(req.headers['x-public-token'] || '');
    const publicTokenQuery = String(parsed.query.public_token || '');
    const providedPublicToken = publicTokenHeader || publicTokenQuery;

    if (checkRateLimit(ip, limits, false)) {
      ws.close(1008, 'Rate limited');
      return;
    }

    if (parts[0] === 'control' && parts[1]) {
      const hubId = parts[1];
      if (!HUB_ID_RE.test(hubId)) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid hubId');
        return;
      }
      if (!gatewayAuth || gatewayAuth !== gatewayToken) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid gateway token');
        return;
      }
      if (providedPublicToken && !TOKEN_RE.test(providedPublicToken)) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid public token format');
        return;
      }

      const existing = hubs.get(hubId);
      if (existing) existing.agent.close();
      const publicToken = providedPublicToken || generateToken();
      const state: HubState = {
        agent: ws,
        publicToken,
        clients: new Set(),
        workers: new Set(),
        channels: new Map(),
        nextCh: 1,
        hello: false,
        since: new Date().toISOString(),
      };
      hubs.set(hubId, state);
      console.log(`[gateway] hub registered: ${hubId}`);

      const proto = String(req.headers['x-forwarded-proto'] || 'https');
      const host = req.headers.host || 'gateway.example.com';
      const scheme = proto === 'https' ? 'wss' : 'ws';
      const publicUrl = `${scheme}://${host}/hub/${hubId}`;
      ws.send(
        JSON.stringify({
          type: 'registered',
          hubId,
          publicToken,
          publicUrl,
          proto: PROTO_V,
        }),
      );

      ws.on('message', (data) => {
        const text = toText(data);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          ws.close(1008, 'Protocol mismatch: agent upgrade required');
          return;
        }
        // 协议握手：旧版 agent 直接转发客户端原文（非信封），明确拒绝并提示升级
        if (!state.hello) {
          if (msg.v === PROTO_V && msg.type === 'hello') {
            state.hello = true;
            return;
          }
          ws.close(1008, 'Protocol mismatch: agent upgrade required');
          return;
        }
        if (msg.v !== PROTO_V) {
          ws.close(1008, 'Protocol mismatch: agent upgrade required');
          return;
        }
        const ch = typeof msg.ch === 'number' ? msg.ch : -1;
        const target = state.channels.get(ch);
        if (msg.type === 'data' && typeof msg.payload === 'string') {
          if (target && target.readyState === WebSocket.OPEN) target.send(msg.payload);
        } else if (msg.type === 'close') {
          if (target) {
            state.channels.delete(ch);
            state.clients.delete(target);
            state.workers.delete(target);
            target.close();
          }
        }
      });
      ws.on('close', () => {
        for (const client of state.channels.values()) client.close();
        // 仅当槽位仍是本连接时删除并记日志，避免误删/误报重注册后的新 state
        if (hubs.get(hubId) !== state) return;
        hubs.delete(hubId);
        console.log(`[gateway] hub disconnected: ${hubId}`);
      });
      ws.on('error', () => {});
      return;
    }

    if (parts[0] === 'hub' && parts[1]) {
      const hubId = parts[1];
      const isWorker = parts[2] === 'worker';
      if (!HUB_ID_RE.test(hubId) || (parts[2] !== undefined && !isWorker)) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid path');
        return;
      }
      const state = hubs.get(hubId);
      if (!state) {
        ws.close(1011, 'Hub not connected');
        return;
      }
      // 握手门控：agent 未完成 v:1 hello 前不放行公网连接，
      // 避免 open/data 信封被旧版 agent 当作客户端原文泄进本地 Hub
      if (!state.hello) {
        ws.close(1013, 'Agent handshake pending');
        return;
      }
      if (providedPublicToken !== state.publicToken) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid public token');
        return;
      }
      if (isWorker) {
        // 远程后端：X-Public-Token 验网关层；CONNECTION_TOKEN 不透给网关判断，原样透传到 hub 校验
        const connToken = String(parsed.query.token || '');
        if (!connToken || connToken.length > 256) {
          ws.close(1008, 'Invalid connection token');
          return;
        }
        const q = new URLSearchParams();
        q.set('token', connToken);
        const multiplex = String(parsed.query.multiplex || '');
        if (multiplex === '1' || multiplex === 'true') q.set('multiplex', '1');
        const agentName = String(parsed.query.agent || '');
        if (agentName && /^[a-zA-Z0-9_-]{1,64}$/.test(agentName)) q.set('agent', agentName);
        handlePublic(ws, state, 'worker', `/worker?${q.toString()}`, ip);
        return;
      }
      handlePublic(ws, state, 'client', '/', ip);
      return;
    }

    checkRateLimit(ip, limits, true);
    ws.close(1002, 'Invalid path');
  });

  httpServer.listen(port, host, () => {
    console.log(`[gateway] listening on ${host}:${port}`);
  });
}

function getBearer(auth?: string): string | undefined {
  if (!auth) return undefined;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}

function getIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded?.[0]) || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip: string, limits: Map<string, RateLimit>, failure: boolean): boolean {
  const now = Date.now();
  let r = limits.get(ip);
  if (!r) {
    r = { failures: 0, lastFailure: 0, connections: 0, lastReset: now };
    limits.set(ip, r);
  }
  if (now - r.lastReset > 60_000) {
    r.failures = 0;
    r.connections = 0;
    r.lastReset = now;
  }
  if (failure) {
    r.failures++;
    r.lastFailure = now;
  } else {
    r.connections++;
  }
  return r.failures > 5 || r.connections > 20;
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
