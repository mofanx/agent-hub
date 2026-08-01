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

架构：手机 → `wss://hub.你的域名` → VPS(Caddy 终结 TLS) → SSH 反向隧道 → 家里 PC(Hub:8787)

### 1. VPS 上：装 Caddy

```bash
sudo apt install -y caddy   # Debian/Ubuntu
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# 编辑 /etc/caddy/Caddyfile 把 hub.example.com 换成你的域名
sudo systemctl reload caddy
```

域名 DNS 需先解析到 VPS IP。Caddy 自动申请/续期 HTTPS 证书，并透传 WebSocket。

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
- 可再加一层 Caddy basicauth 或仅放行指定 IP

## 方式三：Tailscale（最省心）

PC 和手机都装 Tailscale 并登录同一账号，手机 App 直接填 PC 的 Tailscale IP（100.x.x.x）+ 端口 8787。流量端到端加密，Hub 无需任何改动。
