import { networkInterfaces } from "node:os";

export const CONNECT_SCHEME = "agenthub://connect";
export type ConnectMode = "lan" | "gateway";

/**
 * 统一接入链接：agenthub://connect?u=<url>&t=<token>&mode=lan|gateway
 * 参数一律 URLSearchParams 编码（生成端 encodeURIComponent 要求）。
 * mode=lan 时 t 为 HUB_TOKEN；mode=gateway 时 t 为网关 PUBLIC_TOKEN。
 */
export function buildConnectUri(opts: {
  url: string;
  token: string;
  mode: ConnectMode;
}): string {
  const q = new URLSearchParams();
  q.set("u", opts.url);
  q.set("t", opts.token);
  q.set("mode", opts.mode);
  return `${CONNECT_SCHEME}?${q.toString()}`;
}

/** IPv4 内网地址枚举（排除 loopback/link-local） */
export function lanIps(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (a): a is NonNullable<typeof a> =>
        !!a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."),
    )
    .map((a) => a.address);
}

/**
 * 远程后端接入命令：LAN 直连只需要 HUB_URL+CONNECTION_TOKEN；
 * 走 gateway 时额外带 PUBLIC_TOKEN（worker 发 X-Public-Token 头过网关层校验，
 * CONNECTION_TOKEN 经 ?token= 透传至 Hub 校验）。
 */
export function workerJoinCommand(opts: {
  url: string;
  connToken: string;
  publicToken?: string;
}): string {
  const pub = opts.publicToken ? ` PUBLIC_TOKEN=${opts.publicToken}` : "";
  return `HUB_URL=${opts.url}${pub} CONNECTION_TOKEN=${opts.connToken} npx tsx src/multiplex-worker.ts`;
}

type GatewayAnnounce = { publicUrl: string; publicToken: string };

/** gateway agent 上报的公网接入点（内存态，重启由 agent 重连后重新上报） */
let gatewayInfo: GatewayAnnounce | undefined;

export function setGatewayInfo(a: GatewayAnnounce): void {
  gatewayInfo = a;
}

export function getGatewayInfo(): GatewayAnnounce | undefined {
  return gatewayInfo;
}

/**
 * hub.connectInfo 组装。relayed（经 gateway 中继、via=gateway）的连接
 * 不回传 HUB_TOKEN 与 LAN 明文卡——只保留 gateway 卡所需字段。
 */
export function buildConnectInfo(opts: {
  port: number;
  token: string;
  relayed: boolean;
}): Record<string, unknown> {
  const gateway = getGatewayInfo();
  const ips = opts.relayed ? [] : lanIps();
  return {
    lanIps: ips,
    port: opts.port,
    token: opts.relayed ? "" : opts.token,
    gateway,
    uris: {
      lan: ips.map((ip) =>
        buildConnectUri({ url: `ws://${ip}:${opts.port}`, token: opts.token, mode: "lan" }),
      ),
      gateway: gateway
        ? buildConnectUri({
            url: gateway.publicUrl,
            token: gateway.publicToken,
            mode: "gateway",
          })
        : undefined,
    },
  };
}

const SAFE_URL_RE = /^wss?:\/\/[\w.\-:]+(\/\S*)?$/;
const SAFE_TOKEN_RE = /^[a-zA-Z0-9_\-]{16,256}$/;

/** gatewayAnnounce 参数校验：限制形状，拒绝把任意外部输入存进 connectInfo */
export function validateGatewayAnnounce(raw: unknown): GatewayAnnounce {
  const p = (raw ?? {}) as Record<string, unknown>;
  const publicUrl = String(p.publicUrl ?? "").trim();
  const publicToken = String(p.publicToken ?? "").trim();
  if (!SAFE_URL_RE.test(publicUrl)) throw new Error("invalid publicUrl");
  if (!SAFE_TOKEN_RE.test(publicToken)) throw new Error("invalid publicToken");
  return { publicUrl, publicToken };
}
