import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { parse } from 'node:url';

interface HubState {
  agent: WebSocket;
  clients: Set<WebSocket>;
  since: string;
}

export function startServer(options: { port: number; token: string }) {
  const { port, token } = options;
  const hubs = new Map<string, HubState>();

  const httpServer = createServer((req, res) => {
    const parsed = parse(req.url || '/', true);
    const parts = (parsed.pathname || '').split('/').filter(Boolean);

    if (parts[0] === 'admin' && parts[1] === 'hubs') {
      const query = parsed.query;
      if (query.token !== token) {
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
          since: state.since,
        }));
        res.end(JSON.stringify({ hubs: list }));
        return;
      }
      if (req.method === 'DELETE' && parts[2]) {
        const hubId = parts[2];
        const state = hubs.get(hubId);
        if (state) {
          for (const client of state.clients) {
            client.close();
          }
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
    const parsed = parse(req.url || '/', true);
    const parts = (parsed.pathname || '').split('/').filter(Boolean);
    const query = parsed.query;

    if (parts[0] === 'control' && parts[1]) {
      const hubId = parts[1];
      if (query.token !== token) {
        ws.close(1008, 'Invalid gateway token');
        return;
      }
      const existing = hubs.get(hubId);
      if (existing) {
        existing.agent.close();
      }
      const state: HubState = { agent: ws, clients: new Set(), since: new Date().toISOString() };
      hubs.set(hubId, state);
      console.log(`[gateway] hub registered: ${hubId}`);

      ws.on('message', (data) => {
        for (const client of state.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        }
      });
      ws.on('close', () => {
        for (const client of state.clients) {
          client.close();
        }
        hubs.delete(hubId);
        console.log(`[gateway] hub disconnected: ${hubId}`);
      });
      ws.on('error', () => {});
      return;
    }

    if (parts[0] === 'hub' && parts[1]) {
      const hubId = parts[1];
      const state = hubs.get(hubId);
      if (!state) {
        ws.close(1011, 'Hub not connected');
        return;
      }
      state.clients.add(ws);
      console.log(`[gateway] public client connected to ${hubId}`);

      ws.on('message', (data) => {
        if (state.agent.readyState === WebSocket.OPEN) {
          state.agent.send(data);
        }
      });
      ws.on('close', () => {
        state.clients.delete(ws);
      });
      ws.on('error', () => {});
      return;
    }

    ws.close(1002, 'Invalid path');
  });

  httpServer.listen(port, () => {
    console.log(`[gateway] listening on port ${port}`);
  });
}
