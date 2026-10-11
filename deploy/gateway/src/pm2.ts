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
  const gatewayToken = process.env.GATEWAY_TOKEN || randomBytes(32).toString('hex');
  const publicToken = process.env.PUBLIC_TOKEN || randomBytes(32).toString('hex');

  if (!process.env.GATEWAY_TOKEN) {
    console.log(`GATEWAY_TOKEN 未指定，已自动生成: ${gatewayToken}`);
  }

  const envContent = `# Gateway 管理/Agent 注册 token（强随机串）
GATEWAY_TOKEN=${gatewayToken}

# 本地 Hub 的 HUB_TOKEN，请改成实际值
HUB_TOKEN=CHANGE_ME

# 网关公网地址
GATEWAY_URL=wss://gateway.yourdomain.com

# hubId，只接受 16~64 位 a-zA-Z0-9_- 随机串
HUB_ID=CHANGE_ME

# 每个 hubId 最大公网并发数
MAX_CLIENTS=5

# 公网客户端 token，默认已自动生成；分享给授权用户时同时给 URL 和这个 token
PUBLIC_TOKEN=${publicToken}

# 本地 Hub 地址
LOCAL_HUB_URL=ws://127.0.0.1:8787
`;
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
      args: 'server',
      env,
      autorestart: true,
    },
    {
      name: 'gateway-agent',
      script: '${bin}',
      args: 'up',
      env,
      autorestart: true,
    },
  ],
};
`;

  writeFileSync('ecosystem.config.cjs', config);
  console.log('已生成 .env 和 ecosystem.config.cjs');
  console.log('请先编辑 .env 中的 HUB_TOKEN、GATEWAY_URL、HUB_ID，再运行 pm2 start ecosystem.config.cjs');
  console.log('.env 已加入 .gitignore，不要提交到仓库。');
}
