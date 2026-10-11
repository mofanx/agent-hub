import WebSocket from 'ws';

export function startAgent(options: {
  hubId: string;
  gatewayUrl: string;
  token: string;
  localHubUrl: string;
}) {
  const { hubId, gatewayUrl, token, localHubUrl } = options;
  const base = gatewayUrl.replace(/\/$/, '');
  const controlUrl = `${base}/control/${encodeURIComponent(hubId)}?token=${encodeURIComponent(token)}`;
  const publicUrl = `${base}/hub/${encodeURIComponent(hubId)}`;

  let remote: WebSocket | null = null;
  let local: WebSocket | null = null;

  const connectRemote = () => {
    remote = new WebSocket(controlUrl);

    remote.on('open', () => {
      console.log(`[agent] connected to gateway as ${hubId}`);
      console.log(`[agent] public url: ${publicUrl}`);
      connectLocal();
    });

    remote.on('message', (data) => {
      if (local && local.readyState === WebSocket.OPEN) {
        local.send(data);
      }
    });

    remote.on('close', () => {
      console.log('[agent] gateway disconnected');
      if (local) local.close();
      process.exit(0);
    });

    remote.on('error', (err) => {
      console.error('[agent] gateway error:', err.message);
      process.exit(1);
    });
  };

  const connectLocal = () => {
    local = new WebSocket(localHubUrl);

    local.on('open', () => {
      console.log(`[agent] connected to local Hub ${localHubUrl}`);
    });

    local.on('message', (data) => {
      if (remote && remote.readyState === WebSocket.OPEN) {
        remote.send(data);
      }
    });

    local.on('close', () => {
      console.log('[agent] local Hub disconnected');
      if (remote) remote.close();
    });

    local.on('error', (err) => {
      console.error('[agent] local Hub error:', err.message);
    });
  };

  connectRemote();
}
