import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function getBinPath(): string {
  const current = fileURLToPath(import.meta.url);
  const isDist = current.includes('/dist/');
  const base = dirname(current);
  const binPath = isDist
    ? join(dirname(base), 'bin', 'hub-gateway.js')
    : join(base, '..', 'bin', 'hub-gateway.js');
  return resolve(binPath);
}

function getServiceDir(): string {
  const isRoot = process.getuid?.() === 0;
  return isRoot ? '/etc/systemd/system' : `${process.env.HOME}/.config/systemd/user`;
}

function getConfigDir(): string {
  const isRoot = process.getuid?.() === 0;
  return isRoot ? '/etc/hub-gateway' : `${process.env.HOME}/.config/hub-gateway`;
}

function getUserArgs(): string[] {
  const isRoot = process.getuid?.() === 0;
  return isRoot ? [] : ['--user'];
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit' });
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

function writeEnvFile(path: string, env: Record<string, string>) {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path, content + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function installService(options: {
  mode: 'server' | 'up';
  hubId?: string;
  gatewayToken: string;
  adminToken?: string;
  hubToken?: string;
  port?: number;
  host?: string;
  to?: string;
  local?: string;
  publicToken?: string;
  maxClients?: number;
}) {
  const bin = getBinPath();
  if (!existsSync(bin)) {
    throw new Error(`bin not found: ${bin}`);
  }
  const serviceDir = getServiceDir();
  const configDir = getConfigDir();
  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const unitName = options.mode === 'server' ? 'hub-gateway-server' : `hub-gateway-up-${options.hubId}`;
  const envPath = `${configDir}/${unitName}.env`;

  let execStart: string;
  if (options.mode === 'server') {
    writeEnvFile(envPath, {
      GATEWAY_TOKEN: options.gatewayToken,
      ADMIN_TOKEN: options.adminToken || options.gatewayToken,
      GATEWAY_PORT: String(options.port ?? 8788),
      GATEWAY_HOST: options.host ?? '127.0.0.1',
      MAX_CLIENTS: String(options.maxClients ?? 5),
    });
    execStart = `${bin} server`;
  } else {
    if (!options.hubId || !options.to || !options.hubToken) {
      throw new Error('install up requires hubId, --to, and --hub-token');
    }
    const env: Record<string, string> = {
      GATEWAY_TOKEN: options.gatewayToken,
      HUB_TOKEN: options.hubToken,
      GATEWAY_URL: options.to,
      HUB_ID: options.hubId,
      LOCAL_HUB_URL: options.local ?? 'ws://127.0.0.1:8787',
    };
    if (options.publicToken) env.PUBLIC_TOKEN = options.publicToken;
    writeEnvFile(envPath, env);
    execStart = `${bin} up`;
  }

  const unit = `[Unit]
Description=Agent Hub Gateway ${options.mode === 'server' ? 'Server' : `Agent ${options.hubId}`}
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${envPath}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

  const unitPath = `${serviceDir}/${unitName}.service`;
  writeFileSync(unitPath, unit);
  console.log(`已生成 systemd service: ${unitPath}`);
  console.log(`已生成环境文件（权限 600）: ${envPath}`);

  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'daemon-reload']);
  await run('systemctl', [...userArgs, 'enable', '--now', unitName]);
}

export async function uninstallService(target: string) {
  const unitName = target === 'server' ? 'hub-gateway-server' : `hub-gateway-up-${target}`;
  const serviceDir = getServiceDir();
  const configDir = getConfigDir();
  const unitPath = `${serviceDir}/${unitName}.service`;
  const envPath = `${configDir}/${unitName}.env`;
  if (!existsSync(unitPath)) {
    console.log(`service not found: ${unitName}`);
    return;
  }
  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'stop', unitName]);
  await run('systemctl', [...userArgs, 'disable', unitName]);
  rmSync(unitPath);
  if (existsSync(envPath)) rmSync(envPath);
  await run('systemctl', [...userArgs, 'daemon-reload']);
  console.log(`已移除 service: ${unitName}`);
}

export async function showStatus() {
  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'list-units', '--all', '--no-pager', '--no-legend', 'hub-gateway-*']);
}

export async function listHubs(gatewayUrl: string, adminToken: string) {
  const adminUrl =
    gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') + '/admin/hubs';
  const res = await fetch(adminUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
