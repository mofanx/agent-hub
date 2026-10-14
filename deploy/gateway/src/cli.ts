import { randomBytes } from 'node:crypto';
import { startServer } from './server.js';
import { startAgent } from './agent.js';
import { installService, uninstallService, showStatus, listHubs } from './daemon.js';
import { generatePm2 } from './pm2.js';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少 ${name}，可通过 --${name.toLowerCase().replace(/_/g, '-')} 或环境变量传入`);
    process.exit(1);
  }
  return v;
}

function requireToken(flag: string, env: string, label: string): string {
  const v = getArg(flag) || process.env[env];
  if (!v) {
    console.error(`缺少 ${label}，可通过 ${flag} 或 ${env} 环境变量传入`);
    process.exit(1);
  }
  return v;
}

function printHelp() {
  console.log(`用法: hub-gateway <command> [options]

命令:
  server [--port <port>] [--host <host>] [--gateway-token <token>] [--admin-token <token>] [--max-clients <n>]
  up <hubId> [--to <gatewayUrl>] [--gateway-token <token>] [--public-token <token>] [--local <hubUrl>]
  list [--to <gatewayUrl>] [--admin-token <token>]
  down <server|hubId>
  status
  pm2
  install server [--port <port>] [--host <host>] [--gateway-token <token>] [--admin-token <token>]
  install up <hubId> [--to <gatewayUrl>] [--gateway-token <token>] [--hub-token <token>] [--public-token <token>] [--local <hubUrl>]

环境变量:
  GATEWAY_TOKEN      Agent/Gateway 认证（server/up 用）
  ADMIN_TOKEN        管理接口认证（list 用），未设置时 fallback 到 GATEWAY_TOKEN
  HUB_TOKEN          本地 Hub 认证（up 用）
  HUB_ID             up 的 hubId（可替代位置参数）
  GATEWAY_URL        up/list 的网关地址
  GATEWAY_PORT       server 监听端口（默认 8788）
  GATEWAY_HOST       server 绑定地址（默认 127.0.0.1）
  LOCAL_HUB_URL      本地 Hub 地址（默认 ws://127.0.0.1:8787）
  MAX_CLIENTS        每个 hubId 最大公网并发数（默认 5）
  PUBLIC_TOKEN       指定公网客户端 token（up 用；未指定时自动生成并持久化到 agent-<hubId>.token）
`);
}

async function main() {
  const command = args[0];

  if (command === 'server') {
    const gatewayToken = getArg('--gateway-token') || process.env.GATEWAY_TOKEN || generateToken();
    const adminToken = getArg('--admin-token') || process.env.ADMIN_TOKEN || gatewayToken;
    const port = Number(getArg('--port') || process.env.GATEWAY_PORT || '8788');
    const host = getArg('--host') || process.env.GATEWAY_HOST || '127.0.0.1';
    const maxClients = Number(getArg('--max-clients') || process.env.MAX_CLIENTS || '5');
    if (!getArg('--gateway-token') && !process.env.GATEWAY_TOKEN) {
      console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${gatewayToken}`);
    }
    if (hasFlag('--daemon')) {
      await installService({ mode: 'server', gatewayToken, adminToken, port, host, maxClients });
      return;
    }
    startServer({ port, host, gatewayToken, adminToken, maxClientsPerHub: maxClients });
    return;
  }

  if (command === 'up') {
    const hubId = args[1] || process.env.HUB_ID;
    if (!hubId) {
      console.error('缺少 hubId，可通过位置参数或 HUB_ID 环境变量传入');
      process.exit(1);
    }
    const to = getArg('--to') || process.env.GATEWAY_URL;
    const gatewayToken = requireToken('--gateway-token', 'GATEWAY_TOKEN', 'GATEWAY_TOKEN');
    const hubToken = requireEnv('HUB_TOKEN');
    const publicToken = getArg('--public-token') || process.env.PUBLIC_TOKEN;
    const local = getArg('--local') || process.env.LOCAL_HUB_URL || 'ws://127.0.0.1:8787';
    if (!to) {
      console.error('缺少 --to 或 GATEWAY_URL');
      process.exit(1);
    }
    if (hasFlag('--daemon')) {
      await installService({ mode: 'up', hubId, to, gatewayToken, hubToken, publicToken, local });
      return;
    }
    startAgent({ hubId, gatewayUrl: to, gatewayToken, publicToken, localHubUrl: local, hubToken });
    return;
  }

  if (command === 'list') {
    const to = getArg('--to') || process.env.GATEWAY_URL;
    const adminToken = getArg('--admin-token') || process.env.ADMIN_TOKEN || process.env.GATEWAY_TOKEN;
    if (!to || !adminToken) {
      console.error('缺少 --to 或 GATEWAY_URL/GATEWAY_TOKEN');
      process.exit(1);
    }
    await listHubs(to, adminToken);
    return;
  }

  if (command === 'down') {
    const target = args[1];
    if (!target) {
      console.error('缺少 server 或 hubId');
      process.exit(1);
    }
    await uninstallService(target);
    return;
  }

  if (command === 'status') {
    await showStatus();
    return;
  }

  if (command === 'pm2') {
    generatePm2();
    return;
  }

  if (command === 'install') {
    const sub = args[1];
    if (sub === 'server') {
      const gatewayToken = getArg('--gateway-token') || process.env.GATEWAY_TOKEN || generateToken();
      const adminToken = getArg('--admin-token') || process.env.ADMIN_TOKEN || gatewayToken;
      const port = Number(getArg('--port') || process.env.GATEWAY_PORT || '8788');
      const host = getArg('--host') || process.env.GATEWAY_HOST || '127.0.0.1';
      const maxClients = Number(getArg('--max-clients') || process.env.MAX_CLIENTS || '5');
      if (!getArg('--gateway-token') && !process.env.GATEWAY_TOKEN) {
        console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${gatewayToken}`);
      }
      await installService({ mode: 'server', gatewayToken, adminToken, port, host, maxClients });
      return;
    }
    if (sub === 'up') {
      const hubId = args[2] || process.env.HUB_ID;
      if (!hubId) {
        console.error('缺少 hubId');
        process.exit(1);
      }
      const to = getArg('--to') || process.env.GATEWAY_URL;
      const gatewayToken = getArg('--gateway-token') || process.env.GATEWAY_TOKEN || generateToken();
      const hubToken = getArg('--hub-token') || process.env.HUB_TOKEN;
      if (!hubToken) {
        console.error('缺少 --hub-token 或 HUB_TOKEN');
        process.exit(1);
      }
      const publicToken = getArg('--public-token') || process.env.PUBLIC_TOKEN;
      const local = getArg('--local') || process.env.LOCAL_HUB_URL || 'ws://127.0.0.1:8787';
      if (!to) {
        console.error('缺少 --to 或 GATEWAY_URL');
        process.exit(1);
      }
      if (!getArg('--gateway-token') && !process.env.GATEWAY_TOKEN) {
        console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${gatewayToken}`);
      }
      await installService({ mode: 'up', hubId, to, gatewayToken, hubToken, publicToken, local });
      return;
    }
    console.error('未知 install 子命令');
    process.exit(1);
  }

  printHelp();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
