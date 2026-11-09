import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModeDecider, DIRECT_MODES, DECIDE_CONFIDENCE_MIN, resolveDecideConfig } from "./decide.js";

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

describe("resolveDecideConfig", () => {
  it("provider:model 预设取 baseUrl/apiKey，配置模型默认 enforce", () => {
    const c = resolveDecideConfig({ HUB_DECIDE_MODEL: "deepseek:deepseek-chat", DEEPSEEK_API_KEY: "k" });
    assert.deepEqual(c, { model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", enforce: true });
  });
  it("显式 BASE_URL 优先；shadow 退回只记录；未配置不 enforce", () => {
    const c = resolveDecideConfig({ HUB_DECIDE_MODEL: "openai:m", HUB_DECIDE_BASE_URL: "http://x/v1", HUB_DECIDE_MODE: "shadow" });
    assert.equal(c.baseUrl, "http://x/v1");
    assert.equal(c.enforce, false);
    assert.equal(resolveDecideConfig({}).enforce, false);
  });
  it("explicitMention 仅规则命中", () => {
    const d = new ModeDecider();
    assert.equal(d.explicitMention(input)?.mode, "mention");
    assert.equal(d.explicitMention({ ...input, text: "帮我看看这个报错" }), undefined);
  });
  it("明确群聊讨论意图直接扇出，不交主持人", () => {
    const d = new ModeDecider();
    const m4 = [1, 2, 3, 4].map((i) => ({ sessionId: `s${i}`, name: `w${i}` }));
    assert.equal(d.explicitMention({ roomId: "r", text: "请拉上群友一起讨论一下这个方案", members: m4 })?.mode, "parallel");
    assert.equal(d.explicitMention({ roomId: "r", text: "大家一起讨论下", members: m4 })?.mode, "parallel");
    assert.equal(d.explicitMention({ roomId: "r", text: "有些问题请拉上群友讨论", members: m4.slice(0, 2) })?.mode, "mention");
    // 裸「讨论」也算拉群讨论——auto 房用户语义即群讨论（用户已三次实证此期望）
    assert.equal(d.explicitMention({ roomId: "r", text: "帮我讨论下这个报错", members: m4 })?.mode, "parallel");
    assert.equal(d.explicitMention({ roomId: "r", text: "帮我看看这个报错", members: m4 }), undefined);
    // 群词+非讨论动词也算扇出：『大家分头评估』『各位分别看下』
    assert.equal(d.explicitMention({ roomId: "r", text: "大家分头评估一下这个方案", members: m4 })?.mode, "parallel");
    // 『交叉复核/互相复核』显式扇出（词在句中也命中；词表含裸『复核』）
    assert.equal(d.explicitMention({ roomId: "r", text: "建议交叉复核一下这批改动", members: m4 })?.mode, "parallel");
    assert.equal(d.explicitMention({ roomId: "r", text: "帮我复核下这个函数", members: m4 })?.mode, "parallel");
  });
});

describe("fastRoute", () => {
  const m4 = [1, 2, 3, 4].map((i) => ({ sessionId: `s${i}`, name: `w${i}` }));
  const d = new ModeDecider();
  it("真平凡短消息直出 self；中长度无信号交 LLM", () => {
    assert.equal(d.fastRoute({ roomId: "r", text: "早上好呀", members: m4 }, false)?.mode, "self");
    // ≥10字无信号不再 fast:self——漏词降级为多走一次 LLM 而非独立作答
    assert.equal(d.fastRoute({ roomId: "r", text: "这个函数为什么返回 undefined？", members: m4 }, false), undefined);
    assert.equal(d.fastRoute({ roomId: "r", text: "帮我完成交叉复核", members: m4 }, false), undefined);
  });
  it("有信号/过长/过短/待答/关闭 → 交回主持人", () => {
    const f = (text: string, aw = false) => d.fastRoute({ roomId: "r", text, members: m4 }, aw);
    assert.equal(f("大家分别给个方案"), undefined);
    assert.equal(f("x".repeat(200)), undefined);
    assert.equal(f("好"), undefined);
    assert.equal(f("早上好呀", true), undefined);
    assert.equal(new ModeDecider({ fastPath: false }).fastRoute({ roomId: "r", text: "你好呀今天", members: m4 }, false), undefined);
  });
  it("仅主持人+1 成员恒 self", () => {
    assert.equal(d.fastRoute({ roomId: "r", text: "大家分别给个方案", members: m4.slice(0, 2) }, false)?.mode, "self");
  });
});

describe("explicit 全模式意图表", () => {
  const d = new ModeDecider({});
  const members = [
    { sessionId: "h", name: "host" },
    { sessionId: "a", name: "a" },
    { sessionId: "b", name: "b" },
  ];
  const cases: [string, string][] = [
    ["拆成三个子任务分别派工", "conductor"],
    ["按工单编排执行这个需求", "conductor"],
    ["先让A写再交给B审查", "pipeline"],
    ["依次逐个完成这三步", "pipeline"],
    ["大家轮流发言说说看法", "roundrobin"],
    ["正反方辩论一下这个方案", "debate"],
    ["帮我讨论一下这个问题", "parallel"],
  ];
  for (const [text, want] of cases) {
    it(`${text} → ${want}`, () => {
      const v = d.explicitMention({ roomId: "r", text, members });
      assert.equal(v?.mode, want, `via=${v?.reason}`);
    });
  }
  it("不误伤：先想想再给你答复（裸给不算 pipeline）", () => {
    const v = d.explicitMention({
      roomId: "r",
      text: "先等等再给你答复",
      members,
    });
    assert.notEqual(v?.mode, "pipeline");
  });
  it("交叉复核/评审 → parallel", () => {
    for (const text of ["帮我完成复核", "交叉复核一下这批改动", "评审这个方案"]) {
      const v = d.explicitMention({ roomId: "r", text, members });
      assert.equal(v?.mode, "parallel", `${text} via=${v?.reason}`);
    }
  });
  it("冲突时 conductor 优先于 parallel（编排词+讨论词）", () => {
    const v = d.explicitMention({
      roomId: "r",
      text: "把这个需求编排成工单讨论",
      members,
    });
    assert.equal(v?.mode, "conductor");
  });
});
