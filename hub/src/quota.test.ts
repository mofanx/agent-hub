import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchDevinQuota,
  normalizeUserStatus,
  parseTomlStrings,
  validateQuotaReport,
  validateReportedQuota,
  recordQuotaReport,
  quotaFor,
  clearQuotaReports,
  resetQuotaReports,
  QUOTA_REPORT_STALE_MS,
} from "./quota.js";

const API_RESPONSE = {
  userStatus: {
    teamsTier: "TEAMS_TIER_DEVIN_PRO",
    planStatus: {
      planInfo: {
        planName: "Pro",
        billingStrategy: "BILLING_STRATEGY_QUOTA",
      },
      dailyQuotaRemainingPercent: 100,
      weeklyQuotaRemainingPercent: 50,
      dailyQuotaResetAtUnix: "1789718400",
      weeklyQuotaResetAtUnix: "1789891200",
      overageBalanceMicros: "-1200958",
    },
  },
};

describe("normalizeUserStatus", () => {
  it("把剩余百分比换算为已用百分比", () => {
    const q = normalizeUserStatus(API_RESPONSE);
    assert.equal(q.available, true);
    assert.equal(q.planName, "Pro");
    assert.equal(q.daily?.remainingPercent, 100);
    assert.equal(q.daily?.usedPercent, 0);
    assert.equal(q.weekly?.remainingPercent, 50);
    assert.equal(q.weekly?.usedPercent, 50);
    assert.equal(q.daily?.resetAtUnix, 1789718400);
    assert.equal(q.weekly?.resetAtUnix, 1789891200);
  });

  it("hideDailyQuota 时省略 daily", () => {
    const q = normalizeUserStatus({
      userStatus: {
        planStatus: {
          planInfo: { planName: "Max", hideDailyQuota: true },
          dailyQuotaRemainingPercent: 100,
          weeklyQuotaRemainingPercent: 80,
        },
      },
    });
    assert.equal(q.daily, undefined);
    assert.equal(q.weekly?.usedPercent, 20);
    assert.equal(q.available, true);
  });

  it("无 quota 字段时 available=false", () => {
    const q = normalizeUserStatus({ userStatus: { planStatus: { planInfo: { planName: "Free" } } } });
    assert.equal(q.available, false);
    assert.equal(q.planName, "Free");
  });

  it("非法百分比被忽略而不是崩溃", () => {
    const q = normalizeUserStatus({
      userStatus: { planStatus: { dailyQuotaRemainingPercent: "abc", weeklyQuotaRemainingPercent: 250 } },
    });
    assert.equal(q.daily, undefined);
    assert.equal(q.weekly?.remainingPercent, 100);
    assert.equal(q.weekly?.usedPercent, 0);
  });
});

describe("parseTomlStrings", () => {
  it("提取顶层字符串键值", () => {
    const v = parseTomlStrings(
      'windsurf_api_key = "devin-session-token$abc"\napi_server_url = "https://server.codeium.com"\n# comment\nnum = 3',
    );
    assert.equal(v.windsurf_api_key, "devin-session-token$abc");
    assert.equal(v.api_server_url, "https://server.codeium.com");
    assert.equal(v.num, undefined);
  });
});

describe("fetchDevinQuota", () => {
  it("用凭据调用 GetUserStatus 并规范化结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"));
    const credFile = join(dir, "credentials.toml");
    writeFileSync(credFile, 'windsurf_api_key = "tok-123"\napi_server_url = "https://api.example.com"\n');

    let calledUrl = "";
    let calledBody = "";
    const fakeFetch: typeof fetch = async (input, init) => {
      calledUrl = String(input);
      calledBody = String(init?.body ?? "");
      return new Response(JSON.stringify(API_RESPONSE), { status: 200 });
    };

    const q = await fetchDevinQuota({ credentialsFile: credFile, fetchImpl: fakeFetch });
    assert.equal(q.available, true);
    assert.equal(q.weekly?.usedPercent, 50);
    assert.match(calledUrl, /api\.example\.com\/exa\.seat_management_pb\.SeatManagementService\/GetUserStatus$/);
    const meta = (JSON.parse(calledBody) as { metadata: Record<string, string> }).metadata;
    assert.equal(meta.apiKey, "tok-123");
  });

  it("凭据缺失或请求失败时返回 available=false 而非抛错", async () => {
    const q = await fetchDevinQuota({ credentialsFile: "/nonexistent/credentials.toml" });
    assert.equal(q.available, false);
    assert.ok(q.error);

    const failingFetch: typeof fetch = async () => new Response("boom", { status: 500 });
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"));
    const credFile = join(dir, "credentials.toml");
    writeFileSync(credFile, 'windsurf_api_key = "tok"\n');
    const q2 = await fetchDevinQuota({ credentialsFile: credFile, fetchImpl: failingFetch });
    assert.equal(q2.available, false);
    assert.match(q2.error ?? "", /GetUserStatus 500/);
  });
});

describe("validateQuotaReport", () => {
  it("接受合法 connection/session 上报并按 id 推断 scope", () => {
    const conn = validateQuotaReport({
      connectionId: "conn-1",
      quota: { available: true, daily: { usedPercent: 40, resetAt: 1789718400 } },
    });
    assert.equal(conn.scope, "connection");
    assert.equal(conn.connectionId, "conn-1");
    assert.equal(conn.quota.daily?.usedPercent, 40);
    assert.equal(conn.quota.daily?.resetAt, 1789718400);

    const sess = validateQuotaReport({
      scope: "session",
      sessionId: "s-1",
      quota: { available: true, weekly: { usedPercent: 55.6 } },
    });
    assert.equal(sess.scope, "session");
    assert.equal(sess.sessionId, "s-1");
    assert.equal(sess.quota.weekly?.usedPercent, 56);
  });

  it("拒绝缺 id / 非法 scope / 非法 quota 形状", () => {
    assert.throws(() => validateQuotaReport({ quota: { available: true } }), /connectionId required/);
    assert.throws(
      () => validateQuotaReport({ scope: "session", connectionId: "c", quota: { available: true } }),
      /sessionId required/,
    );
    assert.throws(
      () => validateQuotaReport({ scope: "room", connectionId: "c", quota: { available: true } }),
      /invalid scope/,
    );
    assert.throws(() => validateQuotaReport({ connectionId: "c" }), /quota required/);
    assert.throws(
      () => validateQuotaReport({ connectionId: "c", quota: { daily: { usedPercent: "abc" } } }),
      /usedPercent/,
    );
    assert.throws(
      () => validateQuotaReport({ connectionId: "c", quota: { available: "yes" } }),
      /available/,
    );
  });

  it("容忍附加字段与缺省窗口，available=false 也可上报", () => {
    const q = validateQuotaReport({
      connectionId: "c",
      quota: { available: false, error: "auth expired", extra: 1 },
    });
    assert.equal(q.quota.available, false);
    assert.equal(q.quota.error, "auth expired");
    assert.equal(q.quota.daily, undefined);
  });
});

describe("远端配额表 record/quotaFor/clear", () => {
  it("connection 级上报可被 session 视角读取，session 级优先", () => {
    resetQuotaReports();
    recordQuotaReport(
      validateQuotaReport({ connectionId: "conn-9", quota: { available: true, daily: { usedPercent: 10 } } }),
      1000,
    );
    const viaConn = quotaFor({ sessionId: "s-any", connectionId: "conn-9" }, 2000);
    assert.equal(viaConn?.available, true);
    assert.equal(viaConn?.daily?.usedPercent, 10);
    assert.equal(viaConn?.updatedAt, 1000);

    recordQuotaReport(
      validateQuotaReport({ scope: "session", sessionId: "s-any", quota: { available: true, daily: { usedPercent: 80 } } }),
      3000,
    );
    const viaSess = quotaFor({ sessionId: "s-any", connectionId: "conn-9" }, 4000);
    assert.equal(viaSess?.daily?.usedPercent, 80);
    assert.equal(viaSess?.updatedAt, 3000);
    // 其他会话仍读到 connection 级
    assert.equal(quotaFor({ sessionId: "s-other", connectionId: "conn-9" }, 4000)?.daily?.usedPercent, 10);
  });

  it("未上报的成员返回 null", () => {
    resetQuotaReports();
    assert.equal(quotaFor({ sessionId: "none", connectionId: "none" }), null);
    assert.equal(quotaFor({}), null);
  });

  it("超过 QUOTA_REPORT_STALE_MS 未刷新视为过期并惰性清除", () => {
    resetQuotaReports();
    recordQuotaReport(
      validateQuotaReport({ connectionId: "conn-old", quota: { available: true } }),
      10_000,
    );
    assert.equal(quotaFor({ connectionId: "conn-old" }, 10_000 + QUOTA_REPORT_STALE_MS)?.available, true);
    assert.equal(quotaFor({ connectionId: "conn-old" }, 10_000 + QUOTA_REPORT_STALE_MS + 1), null);
  });

  it("clearQuotaReports 清除 connection 与其名下 session 条目", () => {
    resetQuotaReports();
    recordQuotaReport(validateQuotaReport({ connectionId: "c1", quota: { available: true } }));
    recordQuotaReport(validateQuotaReport({ scope: "session", sessionId: "s1", quota: { available: true } }));
    clearQuotaReports("c1", ["s1"]);
    assert.equal(quotaFor({ connectionId: "c1" }), null);
    assert.equal(quotaFor({ sessionId: "s1" }), null);
  });
});

describe("quotaReport 上报方契约", () => {
  it("gateway agent 与 multiplex worker 走 hub.quotaReport / quotaReport 控制帧", () => {
    const agentSrc = readFileSync(
      new URL("../../deploy/gateway/src/agent.ts", import.meta.url),
      "utf8",
    );
    assert.ok(agentSrc.includes("'hub.quotaReport'"));
    const muxSrc = readFileSync(new URL("./multiplex-worker.ts", import.meta.url), "utf8");
    assert.ok(muxSrc.includes('method: "quotaReport"'));
  });
});
