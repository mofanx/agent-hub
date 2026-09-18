import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDevinQuota, normalizeUserStatus, parseTomlStrings } from "./quota.js";

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
