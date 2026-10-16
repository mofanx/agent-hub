import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectInfo,
  buildConnectUri,
  getGatewayInfo,
  lanIps,
  setGatewayInfo,
  validateGatewayAnnounce,
  workerJoinCommand,
} from "./connect.js";

test("buildConnectUri: 参数 encodeURIComponent，可被 URLSearchParams 还原", () => {
  const uri = buildConnectUri({
    url: "wss://gw.example.com/hub/abc-123_?x=1",
    token: "tok+/=weird 字符",
    mode: "gateway",
  });
  assert.ok(uri.startsWith("agenthub://connect?"));
  const q = new URLSearchParams(uri.slice("agenthub://connect?".length));
  assert.equal(q.get("u"), "wss://gw.example.com/hub/abc-123_?x=1");
  assert.equal(q.get("t"), "tok+/=weird 字符");
  assert.equal(q.get("mode"), "gateway");
});

test("lanIps: 只返回非内环 IPv4", () => {
  for (const ip of lanIps()) {
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!ip.startsWith("127."));
    assert.ok(!ip.startsWith("169.254."));
  }
});

test("workerJoinCommand: gateway 带 PUBLIC_TOKEN，LAN 不带", () => {
  const lan = workerJoinCommand({ url: "ws://1.2.3.4:8787/worker", connToken: "ct" });
  assert.ok(lan.includes("HUB_URL=ws://1.2.3.4:8787/worker"));
  assert.ok(lan.includes("CONNECTION_TOKEN=ct"));
  assert.ok(!lan.includes("PUBLIC_TOKEN"));
  const gw = workerJoinCommand({
    url: "wss://gw/hub/h/worker",
    connToken: "ct",
    publicToken: "pub",
  });
  assert.ok(gw.includes("PUBLIC_TOKEN=pub"));
});

test("validateGatewayAnnounce: 合法通过，非法拒绝", () => {
  const ok = validateGatewayAnnounce({
    publicUrl: "wss://gw.example.com/hub/abcd1234abcd1234",
    publicToken: "pub-0123456789abcdef0123456789abcdef",
  });
  assert.equal(ok.publicUrl, "wss://gw.example.com/hub/abcd1234abcd1234");
  assert.throws(() => validateGatewayAnnounce({ publicUrl: "not a url", publicToken: "pub-0123456789abcdef0123456789abcdef" }));
  assert.throws(() => validateGatewayAnnounce({ publicUrl: "wss://x/hub/h", publicToken: "短" }));
  assert.throws(() => validateGatewayAnnounce(null));
});

test("setGatewayInfo/getGatewayInfo 存取", () => {
  setGatewayInfo({ publicUrl: "wss://g/hub/h", publicToken: "pub-0123456789abcdef0123456789abcdef" });
  assert.equal(getGatewayInfo()?.publicUrl, "wss://g/hub/h");
});

test("buildConnectInfo: relayed 连接拿不到 HUB_TOKEN 与 LAN 卡，本机直连不受影响", () => {
  setGatewayInfo({
    publicUrl: "wss://gw.example.com/hub/abcd1234abcd1234",
    publicToken: "pub-0123456789abcdef0123456789abcdef",
  });
  const direct = buildConnectInfo({ port: 8787, token: "SECRET_TOKEN", relayed: false });
  assert.equal(direct.token, "SECRET_TOKEN");
  const relayed = buildConnectInfo({ port: 8787, token: "SECRET_TOKEN", relayed: true });
  assert.equal(relayed.token, "");
  assert.deepEqual(relayed.lanIps, []);
  const uris = relayed.uris as { lan: string[]; gateway?: string };
  assert.deepEqual(uris.lan, []);
  assert.ok(uris.gateway?.includes("mode=gateway"));
  assert.ok(uris.gateway?.includes(encodeURIComponent("pub-0123456789abcdef0123456789abcdef")));
});
