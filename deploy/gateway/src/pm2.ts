import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

function getBinPath(): string {
  const current = fileURLToPath(import.meta.url);
  const isDist = current.includes('/dist/');
  const base = dirname(current);
  const binPath = isDist
    ? join(dirname(base), 'bin', 'hub-gateway.js')
    : join(base, '..', 'bin', 'hub-gateway.js');
  return resolve(binPath);
}

export function generatePm2() {
  const bin = getBinPath().replace(/\\/g, '\\\\');
  const token = process.env.GATEWAY_TOKEN || randomBytes(24).toString('hex');

  if (!process.env.GATEWAY_TOKEN) {
    console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${token}`);
  }

  const envContent = `GATEWAY_TOKEN=${token}\n`;
  writeFileSync('.env', envContent);

  const config = `const fs = require('fs');
const env = {};
try {
  const text = fs.readFileSync('.env', 'utf8');
  for (const line of text.split('\\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch {}

module.exports = {
  apps: [
    {
      name: 'gateway-server',
      script: '${bin}',
      args: 'server --port 8788',
      env,
      autorestart: true,
    },
    {
      name: 'gateway-agent-home-pc',
      script: '${bin}',
      args: 'up home-pc --to wss://gateway.yourdomain.com --local ws://127.0.0.1:8787',
      env,
      autorestart: true,
    },
  ],
};
`;

  writeFileSync('ecosystem.config.cjs', config);
  console.log('已生成 .env 和 ecosystem.config.cjs');
  console.log('公网入口: wss://gateway.yourdomain.com/hub/<hubId>');
  console.log('请妥善保存 .env 文件，不要提交到 Git。');
}
