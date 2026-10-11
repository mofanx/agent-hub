import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

export async function installService(options: {
  mode: 'server' | 'up';
  hubId?: string;
  token: string;
  port?: number;
  to?: string;
  local?: string;
}) {
  const bin = getBinPath();
  if (!existsSync(bin)) {
    throw new Error(`bin not found: ${bin}`);
  }
  const serviceDir = getServiceDir();
  mkdirSync(serviceDir, { recursive: true });

  const unitName = options.mode === 'server' ? 'hub-gateway-server' : `hub-gateway-up-${options.hubId}`;
  let execStart: string;
  if (options.mode === 'server') {
    execStart = `${bin} server --port ${options.port ?? 8788} --token ${options.token}`;
  } else {
    if (!options.hubId || !options.to) {
      throw new Error('install up requires --hubId and --to');
    }
    execStart = `${bin} up ${options.hubId} --to ${options.to} --token ${options.token} --local ${options.local ?? 'ws://127.0.0.1:8787'}`;
  }

  const unit = `[Unit]
Description=Agent Hub Gateway ${options.mode === 'server' ? 'Server' : `Agent ${options.hubId}`}
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

  const unitPath = `${serviceDir}/${unitName}.service`;
  writeFileSync(unitPath, unit);
  console.log(`已生成 systemd service: ${unitPath}`);

  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'daemon-reload']);
  await run('systemctl', [...userArgs, 'enable', '--now', unitName]);
}

export async function uninstallService(target: string) {
  const unitName = target === 'server' ? 'hub-gateway-server' : `hub-gateway-up-${target}`;
  const serviceDir = getServiceDir();
  const unitPath = `${serviceDir}/${unitName}.service`;
  if (!existsSync(unitPath)) {
    console.log(`service not found: ${unitName}`);
    return;
  }
  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'stop', unitName]);
  await run('systemctl', [...userArgs, 'disable', unitName]);
  rmSync(unitPath);
  await run('systemctl', [...userArgs, 'daemon-reload']);
  console.log(`已移除 service: ${unitName}`);
}

export async function showStatus() {
  const userArgs = getUserArgs();
  await run('systemctl', [...userArgs, 'list-units', '--all', '--no-pager', '--no-legend', 'hub-gateway-*']);
}

export async function listHubs(gatewayUrl: string, token: string) {
  const adminUrl =
    gatewayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') +
    '/admin/hubs?token=' +
    encodeURIComponent(token);
  const res = await fetch(adminUrl);
  if (!res.ok) {
    throw new Error(`list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
