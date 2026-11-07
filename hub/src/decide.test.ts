import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModeDecider, DIRECT_MODES, DECIDE_CONFIDENCE_MIN } from "./decide.js";

const input = {
  roomId: "r1",
  text: "@w1 帮我看看这个报错",
  members: [
    { sessionId: "s1", name: "w1" },
    { sessionId: "s2", name: "w2" },
  ],
};

describe("ModeDecider", () => {
  it("规则层：@成员 → explicit mention，未 enforce 降级 host", async () => {
    const d = new ModeDecider({});
    const v = await d.decide(input);
    assert.equal(v.tier, "explicit");
    assert.equal(v.mode, "mention");
    // shadow 默认：可直执判决被闸门降级为 host（行为零变化）
    assert.equal(v.action, "host");
  });

  it("enforce 时 @mention 直执行", async () => {
    const d = new ModeDecider({ enforce: true });
    const v = await d.decide(input);
    assert.equal(v.action, "direct");
    assert.equal(v.mode, "mention");
  });

  it("未配置模型 + 无规则命中 → skip/off，不打扰", async () => {
    const d = new ModeDecider({});
    const v = await d.decide({ ...input, text: "帮我重构这个模块大概需要多久" });
    assert.equal(v.action, "skip");
    assert.equal(v.via, "off");
  });

  it("模型返回非法 verdict → fail-open host", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"mode":"nonsense","confidence":0.9}' } }] }), { status: 200 });
    const d = new ModeDecider({ model: "m", enforce: true, fetchImpl: fetchImpl as never });
    const v = await d.decide({ ...input, text: "大家怎么看这个设计" });
    assert.equal(v.action, "host");
  });

  it("模型高置信裁决恒 inferred——explicit 仅留给规则命中", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"mode":"self","confidence":0.99}' } }] }), { status: 200 });
    const d = new ModeDecider({ model: "m", enforce: true, fetchImpl: fetchImpl as never });
    const v = await d.decide({ ...input, text: "这个报错是什么原因" });
    assert.equal(v.tier, "inferred");
    assert.equal(v.action, "direct");
    assert.equal(v.mode, "self");
  });

  it("模型高置信 conductor → 不交 direct（conductor 仍需主持人）", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"mode":"conductor","confidence":0.95}' } }] }), { status: 200 });
    const d = new ModeDecider({ model: "m", enforce: true, fetchImpl: fetchImpl as never });
    const v = await d.decide({ ...input, text: "把任务拆成三步并行做" });
    assert.equal(v.mode, "conductor");
    assert.equal(v.action, "host");
    assert.ok(!DIRECT_MODES.has("conductor"));
    assert.ok(DECIDE_CONFIDENCE_MIN > 0);
  });

  it("模型超时/异常 → fail-open host 不抛出", async () => {
    const fetchImpl = async () => {
      throw new Error("boom");
    };
    const d = new ModeDecider({ model: "m", enforce: true, fetchImpl: fetchImpl as never });
    const v = await d.decide({ ...input, text: "评估一下这个方案" });
    assert.equal(v.action, "host");
    assert.equal(v.via, "error");
  });

  it("stateHash 稳定且不含原文", () => {
    const h1 = ModeDecider.stateHash(input);
    const h2 = ModeDecider.stateHash(input);
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.ok(!h1.includes(input.text));
  });
});
