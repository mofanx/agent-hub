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
  return randomBytes(24).toString('hex');
}

function printHelp() {
  console.log(`用法: hub-gateway <command> [options]

命令:
  server [--port <port>] [--token <token>] [--daemon]
  up <hubId> [--to <gatewayUrl>] [--token <token>] [--local <hubUrl>] [--daemon]
  list [--to <gatewayUrl>] [--token <token>]
  down <server|hubId>
  status
  pm2
  install server [--port <port>] [--token <token>]
  install up <hubId> [--to <gatewayUrl>] [--token <token>] [--local <hubUrl>]

环境变量:
  GATEWAY_TOKEN   网关 token
  GATEWAY_URL     网关地址 (用于 up/list)
  GATEWAY_PORT    网关监听端口 (默认 8788)
  LOCAL_HUB_URL   本地 Hub 地址 (默认 ws://127.0.0.1:8787)
`);
}

async function main() {
  const command = args[0];

  if (command === 'server') {
    const token = getArg('--token') || process.env.GATEWAY_TOKEN || generateToken();
    const port = Number(getArg('--port') || process.env.GATEWAY_PORT || '8788');
    if (!getArg('--token') && !process.env.GATEWAY_TOKEN) {
      console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${token}`);
      console.log('如需复用，请通过 --token 或 GATEWAY_TOKEN 环境变量传入');
    }
    if (hasFlag('--daemon')) {
      await installService({ mode: 'server', token, port });
      return;
    }
    startServer({ port, token });
    return;
  }

  if (command === 'up') {
    const hubId = args[1];
    if (!hubId) {
      console.error('缺少 hubId');
      process.exit(1);
    }
    const to = getArg('--to') || process.env.GATEWAY_URL;
    const token = getArg('--token') || process.env.GATEWAY_TOKEN;
    const local = getArg('--local') || process.env.LOCAL_HUB_URL || 'ws://127.0.0.1:8787';
    if (!to) {
      console.error('缺少 --to 或 GATEWAY_URL');
      process.exit(1);
    }
    if (!token) {
      console.error('缺少 --token 或 GATEWAY_TOKEN');
      process.exit(1);
    }
    if (hasFlag('--daemon')) {
      await installService({ mode: 'up', hubId, to, token, local });
      return;
    }
    startAgent({ hubId, gatewayUrl: to, token, localHubUrl: local });
    return;
  }

  if (command === 'list') {
    const to = getArg('--to') || process.env.GATEWAY_URL;
    const token = getArg('--token') || process.env.GATEWAY_TOKEN;
    if (!to || !token) {
      console.error('缺少 --to/--token 或 GATEWAY_URL/GATEWAY_TOKEN');
      process.exit(1);
    }
    await listHubs(to, token);
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
      const token = getArg('--token') || process.env.GATEWAY_TOKEN || generateToken();
      const port = Number(getArg('--port') || process.env.GATEWAY_PORT || '8788');
      if (!getArg('--token') && !process.env.GATEWAY_TOKEN) {
        console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${token}`);
      }
      await installService({ mode: 'server', token, port });
      return;
    }
    if (sub === 'up') {
      const hubId = args[2];
      if (!hubId) {
        console.error('缺少 hubId');
        process.exit(1);
      }
      const to = getArg('--to') || process.env.GATEWAY_URL;
      const token = getArg('--token') || process.env.GATEWAY_TOKEN;
      const local = getArg('--local') || process.env.LOCAL_HUB_URL || 'ws://127.0.0.1:8787';
      if (!to || !token) {
        console.error('缺少 --to/--token 或 GATEWAY_URL/GATEWAY_TOKEN');
        process.exit(1);
      }
      await installService({ mode: 'up', hubId, to, token, local });
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
