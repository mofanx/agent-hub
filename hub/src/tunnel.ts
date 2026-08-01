import { spawn } from "node:child_process";

/** cloudflared 快速隧道：把本地 WS 暴露为公网 wss 地址（无需账号） */
export function startTunnel(port: number, token: string): void {
  const bin = process.env.CLOUDFLARED_BIN ?? "cloudflared";
  const proc = spawn(
    bin,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--protocol", "http2"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let announced = false;
  const onData = (chunk: Buffer) => {
    if (announced) return;
    const m = /https:\/\/[\w-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (m) {
      announced = true;
      const host = m[0].replace("https://", "");
      console.log(`[tunnel] remote connect: wss://${host}/?token=${token}`);
      console.log("[tunnel] 手机上把 Hub 地址填为上面的完整 wss 地址即可");
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", (code) => {
    console.warn(`[tunnel] cloudflared exited code=${code}`);
  });
  proc.on("error", (err) => {
    console.warn(`[tunnel] failed to start cloudflared: ${String(err)}`);
  });
}
