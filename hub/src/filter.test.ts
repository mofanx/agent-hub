import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyUtterance, RelevanceFilter } from "./filter.js";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { RoomManager } from "./room.js";
import { Store } from "./store.js";

describe("classifyUtterance 规则层", () => {
  it("纯表情/寒暄/过短无信号 → chatter", () => {
    for (const t of ["👍😄", "你好", "hi", "在吗", "谢谢", "好的", "嗯嗯", "  "]) {
      assert.equal(classifyUtterance(t), "chatter", t);
    }
  });

  it("任务词/问号/命令/长文本 → relevant", () => {
    for (const t of [
      "帮我看下这个报错",
      "这个函数怎么改？",
      "/task @a 干活",
      "review this diff please",
      "大家看看",
      "这是一个超过三十二个字符但没有明显任务语义的陈述句句子啊啊啊啊啊啊啊",
    ]) {
      assert.equal(classifyUtterance(t), "relevant", t);
    }
  });

  it("8~31 字符无信号 → uncertain", () => {
    assert.equal(classifyUtterance("今天天气挺不错的吧"), "uncertain");
  });
});

describe("RelevanceFilter", () => {
  it("关闭时全放行（via=off）", async () => {
    const f = new RelevanceFilter({ enabled: false });
    const r = await f.isRelevant("嗯");
    assert.equal(r.relevant, true);
    assert.equal(r.via, "off");
  });

  it("规则 chatter 拦截；uncertain 无模型档放行；有模型档走 model", async () => {
    const f = new RelevanceFilter({ enabled: true });
    assert.equal((await f.isRelevant("你好")).relevant, false);
    assert.equal((await f.isRelevant("改一下 room.ts")).relevant, true);
    const u = await f.isRelevant("今天天气挺不错的吧");
    assert.equal(u.relevant, true);
    assert.equal(u.reason, "uncertain-pass");
    // 配置了模型但端点不可达 → fail-open 放行
    const fm = new RelevanceFilter({
      enabled: true,
      model: "nano",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    const r = await fm.isRelevant("今天天气挺不错的吧");
    assert.equal(r.relevant, true);
    assert.equal(r.reason, "model-error");
  });
});

describe("编排唤起过滤（RoomModeManager 集成）", () => {
  const setup = (mode: "auto" | "mention") => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "hub-filter-")));
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create(
      "team",
      [
        { sessionId: "host", name: "leader" },
        { sessionId: "s1", name: "coder" },
      ],
      mode,
      { conductorId: "host" },
    );
    const prompted: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => {
        prompted.push(sid);
      },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    manager.setStore(store);
    const filter = new RelevanceFilter({ enabled: true });
    manager.setRelevanceFilter(async (_room, text) => (await filter.isRelevant(text)).relevant);
    return { store, rooms, room, prompted, manager };
  };

  it("auto 模式：闲聊不唤起主持人决策，任务消息照常派发", async () => {
    const { room, prompted, manager, rooms } = setup("auto");
    const r1 = await manager.handle(room, "你好", {});
    assert.deepEqual(r1.sent, []);
    assert.equal(prompted.length, 0, "闲聊不得唤起 auto 决策");
    assert.ok(
      rooms.getEvents(room.roomId).some((e) => e.action === "filter"),
      "命中过滤应写 room events 审计",
    );

    await manager.handle(room, "帮我实现一个排序函数", {});
    assert.deepEqual(prompted, ["host"], "任务消息照常唤起 auto 决策");
  });

  it("mention 模式：无 @ 闲聊被过滤，@ 点名直通", async () => {
    const { room, prompted, manager } = setup("mention");
    const r1 = await manager.handle(room, "你好", {});
    assert.deepEqual(r1.sent, []);
    assert.equal(prompted.length, 0);

    const r2 = await manager.handle(room, "@coder 你好", {});
    assert.deepEqual(r2.sent, ["s1"], "@ 点名不受过滤影响");
    assert.deepEqual(prompted, ["s1"]);
  });

  it("开关关闭（房间级 relevanceFilter=false / 全局 disabled）时全放行", async () => {
    const { room, prompted, manager } = setup("mention");
    // 复刻 index.ts 接线语义：房间级覆盖 > 全局开关
    const filter = new RelevanceFilter({ enabled: true });
    manager.setRelevanceFilter(async (r, text) => {
      const enabled = r.relevanceFilter ?? filter.enabled;
      if (!enabled) return true;
      return (await filter.isRelevant(text)).relevant;
    });
    room.relevanceFilter = false;
    const r = await manager.handle(room, "你好", {});
    assert.deepEqual(r.sent.sort(), ["host", "s1"], "房间级关闭时无 @ 广播照常派发");
    assert.equal(prompted.length, 2);
  });
});
