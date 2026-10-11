import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { parse } from 'node:url';
import { randomBytes } from 'node:crypto';

interface HubState {
  agent: WebSocket;
  publicToken: string;
  clients: Set<WebSocket>;
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
          for (const client of state.clients) client.close();
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
        since: new Date().toISOString(),
      };
      hubs.set(hubId, state);
      console.log(`[gateway] hub registered: ${hubId}`);

      ws.send(
        JSON.stringify({
          type: 'registered',
          hubId,
          publicToken,
          publicUrl: `wss://gateway.example.com/hub/${hubId}`,
        }),
      );

      ws.on('message', (data) => {
        for (const client of state.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(data);
        }
      });
      ws.on('close', () => {
        for (const client of state.clients) client.close();
        hubs.delete(hubId);
        console.log(`[gateway] hub disconnected: ${hubId}`);
      });
      ws.on('error', () => {});
      return;
    }

    if (parts[0] === 'hub' && parts[1]) {
      const hubId = parts[1];
      if (!HUB_ID_RE.test(hubId)) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid hubId');
        return;
      }
      const state = hubs.get(hubId);
      if (!state) {
        ws.close(1011, 'Hub not connected');
        return;
      }
      if (providedPublicToken !== state.publicToken) {
        checkRateLimit(ip, limits, true);
        ws.close(1008, 'Invalid public token');
        return;
      }
      if (state.clients.size >= maxClientsPerHub) {
        ws.close(1008, 'Too many clients');
        return;
      }
      state.clients.add(ws);
      console.log(`[gateway] public client connected to ${hubId}`);

      ws.on('message', (data) => {
        if (state.agent.readyState === WebSocket.OPEN) state.agent.send(data);
      });
      ws.on('close', () => state.clients.delete(ws));
      ws.on('error', () => {});
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
