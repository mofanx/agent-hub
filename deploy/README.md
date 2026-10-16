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

## 方式四：hub-gateway 中继网关（生产安全版）

架构：外部客户端 → `wss://gateway.你的域名/hub/<hubId>` → VPS (`hub-gateway server`) → 内网 Agent (`hub-gateway up <hubId>`) → 本地 Hub (`ws://127.0.0.1:8787`)

外部用户**无需安装任何软件**，但需要同时掌握 **URL + PUBLIC_TOKEN** 才能连接。`HUB_TOKEN` 只在 Agent 与本地 Hub 之间使用，不会暴露给公网客户端。

### 安全模型

| 凭证 | 作用 | 传递方式 | 泄露风险 |
|---|---|---|---|
| `GATEWAY_TOKEN` | Agent 注册 / 管理 | `Authorization: Bearer` Header | 不进 URL/日志 |
| `PUBLIC_TOKEN` | 授权公网客户端接入 | `X-Public-Token: <token>` Header | 不进 URL/日志 |
| `HUB_TOKEN` | Agent → 本地 Hub | systemd `EnvironmentFile` | 不在命令行 |
| `ADMIN_TOKEN` | 管理 `list`/`DELETE` | `Authorization: Bearer` Header | 不默认暴露 |

- Gateway 默认只监听 `127.0.0.1`，流量必须经 Nginx/Caddy TLS。
- `hubId` 强制 `16~64` 位随机串（`a-zA-Z0-9_-`），禁止 `home-pc` 等人可读名字。
- 每个 IP 有连接/失败次数限流。
- 同一 hubId 有最大公网并发数限制（默认 5）。

### 1. 安装

```bash
cd deploy/gateway
npm install
npm run build
npm i -g .
```

### 2. VPS 上启动 Gateway

前台：

```bash
hub-gateway server --gateway-token <GATEWAY_TOKEN>
```

常驻 systemd（自动生成 `/etc/hub-gateway/server.env`，权限 600）：

```bash
hub-gateway install server --gateway-token <GATEWAY_TOKEN>
```

### 3. 内网机器上接入 Hub

`HUB_TOKEN` 从环境变量读取，不进入命令行：

```bash
export HUB_TOKEN=<本地 Hub 的 HUB_TOKEN>
export GATEWAY_TOKEN=<GATEWAY_TOKEN>

hub-gateway up <random-hub-id> \
  --to wss://gateway.yourdomain.com \
  --daemon
```

`hubId` 用随机串，例如 `openssl rand -hex 8`。

接入成功后终端会打印：

```text
[agent] public url: wss://gateway.yourdomain.com/hub/<hubId>
[agent] public token: <PUBLIC_TOKEN>
```

把 **URL + PUBLIC_TOKEN** 一起给授权用户。

### 4. TLS 反向代理

任选 Caddy 或 Nginx 一种：

```bash
# Caddy
sudo cp deploy/gateway/Caddyfile /etc/caddy/Caddyfile
# 把 gateway.yourdomain.com 换成你的域名
sudo systemctl reload caddy

# Nginx
sudo cp deploy/gateway/nginx.conf /etc/nginx/sites-available/agent-hub-gateway
# 编辑域名、证书路径，以及 Gateway 端口（默认 8788）
sudo ln -s /etc/nginx/sites-available/agent-hub-gateway /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. 管理命令

```bash
# 查看在线 hub（含 PUBLIC_TOKEN）
hub-gateway list --to wss://gateway.yourdomain.com --admin-token <GATEWAY_TOKEN>

# 强制断开某个 hub
hub-gateway list 后拿到 hubId，再 curl：
curl -H "Authorization: Bearer <GATEWAY_TOKEN>" \
  https://gateway.yourdomain.com/admin/hubs/<hubId> -X DELETE

# 停止本地 systemd 服务
hub-gateway down <hubId>

# 查看 systemd 状态
hub-gateway status

# 生成 PM2 配置（自动创建 .env 和 ecosystem.config.cjs）
hub-gateway pm2
```

### 6. 客户端连接

桌面端或 Android 端连接地址：

```text
wss://gateway.yourdomain.com/hub/<hubId>
```

连接时必须带 Header：

```http
X-Public-Token: <PUBLIC_TOKEN>
```

> 如果客户端无法设置自定义 Header，可临时降级为 query `?public_token=<PUBLIC_TOKEN>`，但会被 Nginx/Cloudflare 日志记录，不建议生产使用。

之后按正常 Hub 流程发送 `HUB_TOKEN` 鉴权消息。

### 7. 安全提醒

- `GATEWAY_TOKEN` 和 `PUBLIC_TOKEN` 不要写进命令行历史；生产部署用 systemd `EnvironmentFile` 或 PM2 `env`。
- `.env`、`ecosystem.config.cjs`、systemd `.env` 文件已加入 `.gitignore`，权限设为 `600`。
- 如需更高安全，可在 Nginx `/admin/` 上加 IP 白名单，或把 Gateway 管理端口拆分到独立内网接口。

## 扫码快速接入（agenthub://connect）

推荐路径：不在客户端手填地址/Token，而是用统一接入链接 `agenthub://connect?u=<url>&t=<token>&mode=lan|gateway` 一码连接。

### 出码方式

| 端 | 操作 |
|---|---|
| Hub 终端 | `npx tsx src/index.ts --qr` 或 `HUB_QR=1` 启动时打印局域网接入二维码 |
| Desktop | 设置 → 连接页签 → 「分享连接」卡：局域网 / Gateway 各一张 QR + 一键复制链接 |
| Gateway 远端 | `hub-gateway up` 成功后在终端打印 public url/token；Desktop 分享卡同步展示 gateway URI |

### 手机接入

Android：连接卡片右上角「扫码」→ 相机对准 QR（CameraX + ML Kit，首次弹 CAMERA 权限，拒绝后可退回手动粘贴）；也可直接粘贴 `agenthub://connect?...` 链接自动预填地址与 Token。扫码/粘贴后自动直连；应用也注册了 `agenthub://` deep link，可从任意二维码 App 拉起。

### relayed 连接的安全边界

经 gateway 中继接入的客户端（`via=gateway`）调用 `hub.connectInfo` 时，Hub 自动脱敏：不回传 `HUB_TOKEN`，LAN 卡显示「仅本机可见」。公网客户端只能拿到 gateway 卡，不会把内网地址和管理 token 扩散出去。

## 远程后端经 Gateway 接入

远程机器上的 agent（devin/claude/codex…）不再要求直连 Hub 的 8787 端口，可走 gateway 的 `/worker` 通道回连——一个 Hub 可挂多台远端机器的后端。

### 生成接入命令

Desktop：设置 → 连接页签 → 「远程后端接入」→ 选名字与 agent 类型 → 「生成接入命令」。Hub 会创建一条 connection 记录并返回 `CONNECTION_TOKEN`，页面展示：

- **LAN 直连命令**（同网段时）：`HUB_URL=ws://<hub-ip>:8787/worker CONNECTION_TOKEN=<token> npx tsx src/multiplex-worker.ts`
- **Gateway 命令**（已上报接入点时）：`HUB_URL=wss://gw域名/hub/<hubId>/worker PUBLIC_TOKEN=<PUBLIC_TOKEN> CONNECTION_TOKEN=<token> npx tsx src/multiplex-worker.ts`

命令串本身也编码为 QR，远端管理员可截图带走。

### 远端执行

在远程机器上（需已 clone 仓库或拷贝 hub/ 目录）执行生成的命令即可；`multiplex-worker` 一条连接可承载该机器上多个 agent 通道。连接状态回显在 Desktop 连接列表：online 徽标 + 「最近在线 <时间>」（Hub 在 worker 接入/断开时写入 `lastSeen`）。

### 鉴权与边界

- `PUBLIC_TOKEN` 走 `X-Public-Token` 头过网关校验；`CONNECTION_TOKEN` 经 `?token=` 透传至 Hub 校验——两层各自独立。
- Gateway 不会话复用：每条 `/worker` 连接独立鉴权、独立 channel 集合；同一 hubId 下多后端互不可见。
- 如需吊销某个远端后端：Desktop 连接列表删除该 connection 即可（token 随之失效）。
