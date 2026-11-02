import test from "node:test";
import assert from "node:assert/strict";
import { NtfyPusher, NtfyRateLimiter, ntfyConfigFromEnv } from "./ntfy.js";

const okFetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

test("ntfyConfigFromEnv: 无 topic 默认关闭，配置齐全启用", () => {
  assert.equal(ntfyConfigFromEnv({} as NodeJS.ProcessEnv).enabled, false);
  const cfg = ntfyConfigFromEnv({
    NTFY_TOPIC: "hub-alerts",
    NTFY_URL: "http://ntfy.local",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.url, "http://ntfy.local");
  assert.equal(cfg.topic, "hub-alerts");
  assert.equal(cfg.maxPerHour, 6);
});

test("NtfyRateLimiter: 小时窗上限内放行、超限拦、窗外重置", () => {
  const l = new NtfyRateLimiter();
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) assert.equal(l.admit("r1", 3, t0 + i * 1000), true);
  assert.equal(l.admit("r1", 3, t0 + 4000), false, "超限拦");
  assert.equal(l.admit("r2", 3, t0 + 4000), true, "不跨房共享");
  assert.equal(l.admit("r1", 3, t0 + 3600_001), true, "滑出窗重置");
});

test("notifyIfOffline: 客户端在线不推、未配置不推、离线限频内推送", async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const spy = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const pusher = new NtfyPusher(
    { enabled: true, url: "http://n.local", topic: "t", token: "k", maxPerHour: 2 },
    spy,
  );
  // 在线不推
  assert.equal(await pusher.notifyIfOffline("r1", "房甲", "attention", 3), false);
  // 离线推，正文只含房名+类型（无敏感内容）
  assert.equal(await pusher.notifyIfOffline("r1", "房甲", "attention", 0), true);
  assert.equal(calls[0]!.url, "http://n.local/t");
  assert.equal(calls[0]!.body, "房甲：有待你处理事项");
  assert.equal(calls[0]!.headers.Authorization, "Bearer k");
  // 限频：cap=2，第三次拦
  await pusher.notifyIfOffline("r1", "房甲", "attention", 0);
  assert.equal(await pusher.notifyIfOffline("r1", "房甲", "attention", 0), false);
  // 未配置不推
  const off = new NtfyPusher({ enabled: false, url: "", topic: "", maxPerHour: 6 }, okFetch);
  assert.equal(await off.notifyIfOffline("r1", "房甲", "attention", 0), false);
});

test("notifyIfOffline: fetch 异常吞掉不炸 hub", async () => {
  const bad = (async () => { throw new Error("net down"); }) as typeof fetch;
  const pusher = new NtfyPusher(
    { enabled: true, url: "http://n.local", topic: "t", maxPerHour: 6 },
    bad,
  );
  assert.equal(await pusher.notifyIfOffline("r1", "房甲", "task.done", 0), false);
});
