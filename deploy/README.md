# 远程接入部署指南

Hub 是纯 WebSocket 服务（无 TLS），远程接入的本质都是「给 8787 端口加一条公网可达的加密通道」。三种方式任选：

| 方式 | 前提 | 优点 | 缺点 |
|------|------|------|------|
| **cloudflared 快速隧道** | 无 | 零配置，`HUB_TUNNEL=1` 即可 | 地址每次重启变化、无 SLA |
| **自建 VPS + 域名** | VPS、域名 | 固定地址、完全自控 | 需维护 VPS |
| **Tailscale** | PC/客户端装 Tailscale | 零暴露、端到端加密 | 客户端需装 Tailscale |
| **hub-gateway 中继网关** | VPS、域名 | 外部用户零安装、hubId 管理 | 需部署 Gateway + Agent |

## 方式一：cloudflared 快速隧道

```bash
cd hub
HUB_TUNNEL=1 npx tsx src/index.ts
# [tunnel] remote connect: wss://xxx.trycloudflare.com/?token=...
```

客户端地址栏粘贴完整 wss 地址（Android App 或 Desktop App）。已有 Cloudflare 账号可改用命名隧道拿固定域名（`cloudflared tunnel create`）。

## 方式二：自建 VPS + 域名（推荐生产用）

架构：客户端（Android / Desktop）→ `wss://hub.你的域名` → VPS(Caddy 或 Nginx 终结 TLS) → SSH 反向隧道 → 家里 PC(Hub:8787)

VPS 上**任选 Caddy 或 Nginx 一种**即可。

### 1. VPS 上：选择 Caddy（自动 HTTPS，推荐新手）

```bash
sudo apt install -y caddy   # Debian/Ubuntu
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# 编辑 /etc/caddy/Caddyfile 把 hub.example.com 换成你的域名
sudo systemctl reload caddy
```

域名 DNS 需先解析到 VPS IP。Caddy 自动申请/续期 HTTPS 证书，并透传 WebSocket。

### 或：选择 Nginx + certbot

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-site.conf /etc/nginx/sites-available/agent-hub
# 编辑 /etc/nginx/sites-available/agent-hub：把 hub.example.com 换成你的域名

# 申请证书；certbot 安装后会自带 systemd timer，到期自动续期
sudo certbot certonly --nginx -d hub.example.com --deploy-hook "systemctl reload nginx"

# 证书生成后再启用配置，避免 nginx -t 因证书路径不存在而失败
sudo ln -s /etc/nginx/sites-available/agent-hub /etc/nginx/sites-enabled/agent-hub
sudo nginx -t
sudo systemctl reload nginx
```

`deploy/nginx-site.conf` 已包含 WebSocket 升级、反向代理到 `127.0.0.1:8787`、SSL 证书路径占位符和安全响应头。

续期测试：

```bash
sudo certbot renew --dry-run
```

### 2. 家里 PC 上：SSH 反向隧道

```bash
sudo apt install -y autossh
# 配置免密登录 VPS：ssh-copy-id user@<VPS_IP>
sudo cp deploy/hub-relay.service /etc/systemd/system/
# 编辑 unit 文件：替换 user@<VPS_IP>
sudo systemctl enable --now hub-relay
```

这会把 VPS 的 `127.0.0.1:8787` 转发到 PC 的 `127.0.0.1:8787`。

### 3. 家里 PC 上：Hub 常驻

推荐使用 PM2 托管（统一用 `pm2 restart/reload` 重启，详见根目录 `README.md`）：

```bash
npm i -g pm2
cp ecosystem.config.cjs.example ecosystem.config.cjs
# 编辑 ecosystem.config.cjs 替换 HUB_TOKEN
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

如更习惯 systemd，也可用 `deploy/agent-hub.service`：

```bash
sudo cp deploy/agent-hub.service /etc/systemd/system/
# 编辑 unit 文件：替换用户名/项目路径/HUB_TOKEN（务必改成强随机串）
sudo systemctl enable --now agent-hub
```

### 4. 客户端连接

Android App 或 Desktop App 地址栏填 `wss://hub.你的域名`，Token 填 `HUB_TOKEN` 的值。

**安全提醒**：token 是唯一鉴权手段，公网部署务必：
- 设置强随机 `HUB_TOKEN`（如 `openssl rand -hex 24`）
- 不要用默认 `dev-token`
- Caddy 可再加一层 basicauth，Nginx 可用 `auth_basic` 或仅放行指定 IP

## 方式三：Tailscale（最省心）

PC 和客户端都装 Tailscale 并登录同一账号，Android App 或 Desktop App 直接填 PC 的 Tailscale IP（100.x.x.x）+ 端口 8787。流量端到端加密，Hub 无需任何改动。

## 方式四：hub-gateway 中继网关

架构：外部客户端 → `wss://gateway.你的域名/hub/<hubId>` → VPS (`hub-gateway server`) → 内网 Agent (`hub-gateway up <hubId>`) → 本地 Hub (`ws://127.0.0.1:8787`)

外部用户**无需安装任何软件**，只需要一个 URL 和 `HUB_TOKEN` 即可连接。

### 1. 安装

```bash
cd deploy/gateway
npm install
npm run build
npm i -g .
```

### 2. VPS 上启动 Gateway

```bash
hub-gateway server --token <GATEWAY_TOKEN>
```

常驻 systemd：

```bash
hub-gateway server --token <GATEWAY_TOKEN> --daemon
```

### 3. 内网机器上接入 Hub

```bash
hub-gateway up home-pc \
  --to wss://gateway.yourdomain.com \
  --token <GATEWAY_TOKEN> \
  --daemon
```

`home-pc` 是任意 hubId，不同机器用不同 id。公网地址就是：

```text
wss://gateway.yourdomain.com/hub/home-pc
```

### 4. TLS 反向代理

任选 Caddy 或 Nginx 一种：

```bash
# Caddy
sudo cp deploy/gateway/Caddyfile /etc/caddy/Caddyfile
# 把 gateway.yourdomain.com 换成你的域名
sudo systemctl reload caddy

# Nginx
sudo cp deploy/gateway/nginx.conf /etc/nginx/sites-available/agent-hub-gateway
# 编辑域名和证书路径
sudo ln -s /etc/nginx/sites-available/agent-hub-gateway /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. 管理命令

```bash
# 查看在线 hub
hub-gateway list --to wss://gateway.yourdomain.com --token <GATEWAY_TOKEN>

# 停止某个 hub 接入
hub-gateway down home-pc

# 查看 systemd 状态
hub-gateway status

# 生成 PM2 配置（自动创建 .env 和 ecosystem.config.cjs）
hub-gateway pm2
```

### 安全

- `GATEWAY_TOKEN`：只有你能注册/管理 hubId，不要暴露。
- `HUB_TOKEN`：外部用户连入 Hub 后仍需通过 Hub 自身鉴权，Gateway 不干预。
- `.env` 和 `ecosystem.config.cjs` 已加入 `.gitignore`，不要提交到仓库。
