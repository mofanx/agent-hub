# 远程接入部署指南

Hub 是纯 WebSocket 服务（无 TLS），远程接入的本质都是「给 8787 端口加一条公网可达的加密通道」。三种方式任选：

| 方式 | 前提 | 优点 | 缺点 |
|------|------|------|------|
| **cloudflared 快速隧道** | 无 | 零配置，`HUB_TUNNEL=1` 即可 | 地址每次重启变化、无 SLA |
| **自建 VPS + 域名** | VPS、域名 | 固定地址、完全自控 | 需维护 VPS |
| **Tailscale** | PC/手机装 Tailscale | 零暴露、端到端加密 | 手机需装客户端 |

## 方式一：cloudflared 快速隧道

```bash
cd hub
HUB_TUNNEL=1 npx tsx src/index.ts
# [tunnel] remote connect: wss://xxx.trycloudflare.com/?token=...
```

手机 App 地址栏粘贴完整 wss 地址。已有 Cloudflare 账号可改用命名隧道拿固定域名（`cloudflared tunnel create`）。

## 方式二：自建 VPS + 域名（推荐生产用）

架构：手机 → `wss://hub.你的域名` → VPS(Caddy 或 Nginx 终结 TLS) → SSH 反向隧道 → 家里 PC(Hub:8787)

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

```bash
sudo cp deploy/agent-hub.service /etc/systemd/system/
# 编辑 unit 文件：替换用户名/项目路径/HUB_TOKEN（务必改成强随机串）
sudo systemctl enable --now agent-hub
```

### 4. 手机连接

App 地址栏填 `wss://hub.你的域名`，Token 填 `HUB_TOKEN` 的值。

**安全提醒**：token 是唯一鉴权手段，公网部署务必：
- 设置强随机 `HUB_TOKEN`（如 `openssl rand -hex 24`）
- 不要用默认 `dev-token`
- Caddy 可再加一层 basicauth，Nginx 可用 `auth_basic` 或仅放行指定 IP

## 方式三：Tailscale（最省心）

PC 和手机都装 Tailscale 并登录同一账号，手机 App 直接填 PC 的 Tailscale IP（100.x.x.x）+ 端口 8787。流量端到端加密，Hub 无需任何改动。
