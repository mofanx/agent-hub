import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoomModeManager, type AgentOps } from "./room-modes.js";
import { ConductorOrchestrator } from "./conductor.js";
import { RoomManager, type Room } from "./room.js";
import { Store } from "./store.js";
import { OperationLedger } from "./op-ledger.js";
import { buildProcessMeta, type TurnProcessItem } from "./process-log.js";

function tmpStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-gov-"));
  return new Store(dir);
}

function appendUser(store: Store, roomId: string, text: string): void {
  store.append("room", roomId, { at: Date.now(), kind: "user", author: "我", text });
}

describe("turn 提交不变量（stale check）", () => {
  const setup = () => {
    const store = tmpStore();
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const prompts: { sessionId: string; content: unknown }[] = [];
    const agent: AgentOps = {
      prompt: async (sessionId, content) => {
        prompts.push({ sessionId, content });
      },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    manager.setStore(store);
    return { store, rooms, room, prompts, manager };
  };

  it("回合期间有新用户消息：输出作废并按原 prompt 重跑一次，重跑结果仍接受", async () => {
    const { store, room, prompts, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    assert.equal(prompts.length, 1);

    // 新用户消息在回合中到达 → 游标推进 → 作废重跑
    appendUser(store, room.roomId, "补充要求 A");
    const dropped = await manager.onPromptDone("s1", "基于旧上下文的回答");
    assert.equal(dropped, true);
    assert.equal(prompts.length, 2, "应重发一次同 prompt");

    // 重跑期间再有新消息 → 已重跑过，强制接受避免死循环
    appendUser(store, room.roomId, "补充要求 B");
    const accepted = await manager.onPromptDone("s1", "重跑的回答");
    assert.equal(accepted, false);
    assert.equal(prompts.length, 2, "重试上限 1 次");
  });

  it("游标未推进：正常消费，不重跑", async () => {
    const { store, room, prompts, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    const r = await manager.onPromptDone("s1", "正常回答");
    assert.equal(r, false);
    assert.equal(prompts.length, 1);
  });

  it("被 cancel 的 turn 不重跑", async () => {
    const { store, room, prompts, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    manager.onSessionCancelled("s1");
    // 取消后即使游标推进、输出迟到，也不消费不重跑
    appendUser(store, room.roomId, "又一条消息");
    const r = await manager.onPromptDone("s1", "迟到的输出");
    assert.equal(prompts.length, 1);
    assert.equal(r, false);
  });

  it("isStaleTurnCommit：仅未重跑且游标推进时为 true", async () => {
    const { store, room, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    assert.equal(manager.isStaleTurnCommit("s1", room.roomId), false);
    appendUser(store, room.roomId, "补充");
    assert.equal(manager.isStaleTurnCommit("s1", room.roomId), true);
    await manager.onPromptDone("s1", "作废");
    // 重跑后：即使还有新消息也不再标 stale（已重跑）
    appendUser(store, room.roomId, "再补充");
    assert.equal(manager.isStaleTurnCommit("s1", room.roomId), false);
  });
});

describe("Operation ledger 副作用去重", () => {
  it("同 opId 二次提交跳过，重跑产生新 opId 不受影响", () => {
    const ledger = new OperationLedger(5000);
    assert.equal(ledger.commit("reply:s1:100:room:r1", "assistant"), true);
    assert.equal(ledger.commit("reply:s1:100:room:r1", "assistant"), false);
    // 重跑是新 op（turnStartAt 不同）
    assert.equal(ledger.commit("reply:s1:200:room:r1", "assistant"), true);
    // 不同 kind/opId 互不影响
    assert.equal(ledger.commit("file:s1:hash1", "file"), true);
    assert.equal(ledger.commit("file:s1:hash1", "file"), false);
    assert.equal(ledger.commit("file:s1:hash2", "file"), true);
  });

  it("容量有界：超限淘汰最旧条目", () => {
    const ledger = new OperationLedger(3);
    ledger.commit("a", "x");
    ledger.commit("b", "x");
    ledger.commit("c", "x");
    ledger.commit("d", "x");
    assert.equal(ledger.size, 3);
    assert.equal(ledger.has("a"), false);
    assert.equal(ledger.has("d"), true);
  });
});

describe("mention 模式 SILENT 语义", () => {
  it("未被 @ 的成员不派发、不发言", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
      { sessionId: "s3", name: "pm" },
    ]);
    const prompted: string[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid) => {
          prompted.push(sid);
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    const res = await manager.handle(room, "@coder 看一下这个", {});
    assert.deepEqual(res.sent, ["s1"]);
    assert.deepEqual(prompted, ["s1"], "未被点名的成员不派发（SILENT）");
    assert.equal(manager.isRoomTurn("s2"), false);
    assert.equal(manager.isRoomTurn("s3"), false);
  });

  it("无 @ 时回退为全体成员（既有兜底语义）", async () => {
    const rooms = new RoomManager();
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const prompted: string[] = [];
    const manager = new RoomModeManager(
      {
        prompt: async (sid) => {
          prompted.push(sid);
        },
        isBusy: () => false,
        cancel: async () => {},
      },
      rooms,
      () => {},
    );
    const res = await manager.handle(room, "大家看看", {});
    assert.deepEqual(res.sent.sort(), ["s1", "s2"]);
  });
});

describe("conductor maxRounds 轮次预算", () => {
  it("跟进轮次超限 → awaiting-retry + waitingFor=user + system 提示", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor", maxRounds: 1 },
    );
    const prompts: string[] = [];
    const notices: string[] = [];
    const orch = new ConductorOrchestrator(
      {
        prompt: async (sid) => {
          prompts.push(sid);
        },
        isBusy: () => false,
      },
      rooms,
      (n) => notices.push(n.message),
    );
    await orch.start(room, "做个东西");
    await orch.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"to":"coder","task":"实现"}]}\n```',
    );
    let flow = orch.getFlow(room.roomId) as Record<string, unknown>;
    assert.equal(flow.rounds, 1, "初始派工计一轮");

    await orch.onPromptDone("worker", "done");
    await orch.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"还缺","tasks":[{"to":"coder","task":"补充"}]}\n```',
    );
    flow = orch.getFlow(room.roomId) as Record<string, unknown>;
    assert.equal(flow.phase, "awaiting-retry");
    assert.equal(flow.waitingFor, "user");
    assert.equal(orch.hasAwaitingRetry(room.roomId), true);
    assert.ok(
      notices.some((m) => m.includes("轮次") && m.includes("上限")),
      "应提示用户接手",
    );
  });

  it("默认 maxRounds=8，未超限时 continue 正常加轮", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const prompts: string[] = [];
    const orch = new ConductorOrchestrator(
      {
        prompt: async (sid) => {
          prompts.push(sid);
        },
        isBusy: () => false,
      },
      rooms,
      () => {},
    );
    await orch.start(room, "做个东西");
    await orch.onPromptDone(
      "conductor",
      '```json\n{"tasks":[{"to":"coder","task":"实现"}]}\n```',
    );
    let flow = orch.getFlow(room.roomId) as Record<string, unknown>;
    assert.equal(flow.maxRounds, 8);

    await orch.onPromptDone("worker", "done");
    await orch.onPromptDone(
      "conductor",
      '```json\n{"decision":"continue","reason":"还缺","tasks":[{"to":"coder","task":"补充"}]}\n```',
    );
    flow = orch.getFlow(room.roomId) as Record<string, unknown>;
    assert.equal(flow.phase, "working");
    assert.equal(flow.rounds, 2);
  });
});

describe("turnGuards 生命周期", () => {
  const guardsOf = (m: RoomModeManager) =>
    (m as unknown as { turnGuards: Map<string, unknown> }).turnGuards;

  const setup = () => {
    const store = tmpStore();
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create("team", [
      { sessionId: "s1", name: "coder" },
      { sessionId: "s2", name: "tester" },
    ]);
    const prompts: string[] = [];
    const agent: AgentOps = {
      prompt: async (sid) => {
        prompts.push(sid);
      },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    manager.setStore(store);
    return { store, rooms, room, prompts, agent, manager };
  };

  it("正常完成轮后 turnGuards 无残留", async () => {
    const { store, room, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    assert.equal(guardsOf(manager).size, 1);
    await manager.onPromptDone("s1", "正常回答");
    assert.equal(guardsOf(manager).size, 0, "正常消费后不得残留游标");
    // stale → 重跑 → 强制接受的终态同样清零
    appendUser(store, room.roomId, "@coder 再来");
    await manager.handle(room, "@coder 再来", {});
    appendUser(store, room.roomId, "补充");
    await manager.onPromptDone("s1", "作废");
    assert.equal(guardsOf(manager).size, 1, "重跑期间保留游标");
    await manager.onPromptDone("s1", "重跑回答");
    assert.equal(guardsOf(manager).size, 0);
  });

  it("prompt 发送即失败：turnGuards/promptRooms 登记即时回收", async () => {
    const { store, room, agent, manager } = setup();
    agent.prompt = async () => {
      throw new Error("session busy");
    };
    appendUser(store, room.roomId, "@coder 干活");
    await manager.handle(room, "@coder 干活", {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(guardsOf(manager).size, 0, "发送失败不得留下游标");
    assert.equal(manager.isRoomTurn("s1"), false, "发送失败不得留下在途房间归属");
  });

  it("steer-queue：busy 入队不登记 turnGuard，不覆盖在跑 turn 的游标", async () => {
    const { store, room, agent, manager, prompts } = setup();
    let busy = false;
    agent.isBusy = () => busy;
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    assert.equal(guardsOf(manager).size, 1, "在跑 turn 已登记游标");
    const guard = [...guardsOf(manager).values()][0] as { content: unknown };

    busy = true;
    await manager.handle(room, "@coder 排队消息", {});
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 1, "busy 消息未外发");
    assert.equal(guardsOf(manager).size, 1, "入队不得覆盖在跑 turn 的 guard");
    assert.equal(
      [...guardsOf(manager).values()][0] === guard,
      true,
      "在跑 turn 的 guard 未被入队内容替换",
    );
  });

  it("steer-queue：turn 完成后 drain 合并走 sendPrompt 正常登记 guard", async () => {
    const { store, room, agent, manager, prompts } = setup();
    let busy = false;
    agent.isBusy = () => busy;
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});

    busy = true;
    await manager.handle(room, "@coder 补充A", {});
    await manager.handle(room, "@coder 补充B", {});
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 1);

    busy = false;
    await manager.onPromptDone("s1", "完成");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 2, "drain 后合并 prompt 外发");
    assert.equal(guardsOf(manager).size, 1, "drain 出的 prompt 正常登记 guard");
  });

  it("steer-queue：在跑 turn 输出不误判 stale（入队消息不推进游标覆盖）", async () => {
    const { store, room, agent, manager } = setup();
    const contents: unknown[] = [];
    agent.prompt = async (sid, content) => {
      contents.push(content);
    };
    let busy = false;
    agent.isBusy = () => busy;
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    const firstPrompt = contents[0];

    busy = true;
    // 入队消息不经过 appendUser → 房史游标不推进 → 在跑 turn 不算 stale
    await manager.handle(room, "@coder 排队", {});
    busy = false;
    await manager.onPromptDone("s1", "正常输出");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // stale 重跑会用原 prompt 内容重发；这里第 2 次外发是 drain 的排队内容
    assert.equal(contents.length, 2, "输出消费后 drain 排队消息");
    assert.notEqual(contents[1], firstPrompt, "drain 外发的是排队内容，非 stale 重跑原 prompt");
  });

  it("队列上限 5：第 6 条丢弃", async () => {
    const store = tmpStore();
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create("team", [{ sessionId: "s1", name: "coder" }]);
    const overflowAgent: AgentOps = {
      prompt: async () => {},
      isBusy: () => true,
      cancel: async () => {},
    };
    const notices: string[] = [];
    const manager = new RoomModeManager(overflowAgent, rooms, (_method, params) => {
      notices.push(String((params as { message?: unknown }).message ?? ""));
    });
    manager.setStore(store);
    for (let i = 0; i < 7; i++) {
      await manager.handle(room, `@coder 第${i}条`, {});
    }
    const q = (manager as unknown as { followUps: Map<string, unknown[]> }).followUps.get("s1");
    assert.equal(q?.length, 5, "队列封顶 5 条，溢出丢弃");
    assert.equal(
      notices.filter((m) => m.includes("已丢弃")).length,
      2,
      "溢出丢弃回执用户而非静默",
    );
  });

  it("steer-queue：重启恢复后队列保留，成员 idle 即 drain", async () => {
    const store = tmpStore();
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create("team", [{ sessionId: "s1", name: "coder" }]);
    let busy = true;
    const prompts: string[] = [];
    const agent: AgentOps = {
      prompt: async (_sid, content) => {
        prompts.push(typeof content === "string" ? content : JSON.stringify(content));
      },
      isBusy: () => busy,
      has: () => true,
      cancel: async () => {},
    };
    const m1 = new RoomModeManager(agent, rooms, () => {});
    m1.setStore(store);
    await m1.handle(room, "@coder 排一", {});
    await m1.handle(room, "@coder 排二", {});
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 0, "busy 期间全入队");

    // 重启：新实例 import 持久化 runtime
    const runtime = m1.exportRuntime();
    const m2 = new RoomModeManager(agent, rooms, () => {});
    m2.setStore(store);
    await m2.importRuntime(runtime);
    const q = (m2 as unknown as { followUps: Map<string, unknown[]> }).followUps.get("s1");
    assert.equal(q?.length, 2, "恢复后队列保留 2 条");

    busy = false; // 成员已 idle
    m2.resumeFlows();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(prompts.length, 1, "idle 后 drain 合并为单 prompt");
    assert.ok(prompts[0]!.includes("排一") && prompts[0]!.includes("排二"));
    assert.equal(
      (m2 as unknown as { followUps: Map<string, unknown[]> }).followUps.size, 0,
    );
  });

  it("stale 重跑发送失败：走 prompt.error 终态收敛", async () => {
    const { store, room, agent, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    appendUser(store, room.roomId, "补充");
    agent.prompt = async () => {
      throw new Error("session gone");
    };
    const dropped = await manager.onPromptDone("s1", "旧输出");
    assert.equal(dropped, true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(guardsOf(manager).size, 0, "重跑发送失败应清理游标");
    assert.equal(manager.isRoomTurn("s1"), false);
  });

  it("onRoomRemoved：清掉该房间的游标/在途登记/flow", async () => {
    const { store, room, manager } = setup();
    appendUser(store, room.roomId, "@coder 问题");
    await manager.handle(room, "@coder 问题", {});
    assert.equal(guardsOf(manager).size, 1);
    assert.equal(manager.isRoomTurn("s1"), true);
    manager.onRoomRemoved(room.roomId);
    assert.equal(guardsOf(manager).size, 0);
    assert.equal(manager.isRoomTurn("s1"), false);
    assert.equal(manager.getFlow(room.roomId), undefined);
  });

  it("onRoomRemoved：conductor flow 一并回收", async () => {
    const { rooms, manager } = setup();
    const croom = rooms.create(
      "cond-team",
      [
        { sessionId: "host", name: "leader" },
        { sessionId: "w1", name: "coder" },
      ],
      "conductor",
      { conductorId: "host" },
    );
    await manager.handle(croom, "/task @coder 干活", {});
    assert.ok(manager.getFlow(croom.roomId), "conductor flow 应已建立");
    assert.ok(guardsOf(manager).has("w1"), "派工 prompt 已登记游标");
    manager.onRoomRemoved(croom.roomId);
    assert.equal(manager.getFlow(croom.roomId), undefined);
    assert.equal(guardsOf(manager).has("w1"), false);
  });

  it("agent 未连接：auto 决策启动失败不悬挂 autoDecisions/promptRooms/turnGuards/subMode", async () => {
    const store = tmpStore();
    const rooms = new RoomManager();
    rooms.setStore(store);
    const room = rooms.create(
      "auto-team",
      [{ sessionId: "s1", name: "coder" }],
      "conductor",
      { conductorId: "s1" },
    );
    room.mode = "auto";
    const agent: AgentOps = {
      // 同步 throw（旧 ownerOf 形态）：经 sendPrompt async 包装转 rejection，
      // 不该同步逃逸绕过 .catch 清理
      prompt: () => { throw new Error("agent 未连接"); },
      isBusy: () => false,
      cancel: async () => {},
    };
    const manager = new RoomModeManager(agent, rooms, () => {});
    manager.setStore(store);
    appendUser(store, room.roomId, "做个任务");
    await manager.handle(room, "做个任务", {});
    await new Promise((r) => setTimeout(r, 0)); // 让 sendPrompt.catch 微任务跑完
    const m = manager as unknown as {
      autoDecisions: Map<string, unknown>;
      promptRooms: Map<string, unknown>;
    };
    assert.equal(m.autoDecisions.size, 0, "悬挂决策必须清理");
    assert.equal(m.promptRooms.size, 0, "promptRooms 不得残留");
    assert.equal(guardsOf(manager).size, 0, "turnGuards 不得残留");
    assert.equal(
      manager.subModeFor(room.roomId),
      undefined,
      "deciding 子态必须释放",
    );
  });
});

describe("worker 过程输出归卡", () => {
  it("buildProcessMeta 携带 flowId/taskId，供客户端把过程卡归入 flow 卡", () => {
    const buf: TurnProcessItem[] = [
      { at: 100, kind: "thought", author: "coder", text: "思考中" },
      { at: 101, kind: "tool", author: "coder", text: '{"title":"edit","status":"completed"}' },
    ];
    const meta = buildProcessMeta("r1", "s1", buf, "t1", "done", "fl-1-1");
    assert.equal(meta.taskId, "t1");
    assert.equal(meta.flowId, "fl-1-1");
    assert.equal(meta.steps.length, 2);
    const noFlow = buildProcessMeta("r1", "s1", buf, undefined, "done");
    assert.equal(noFlow.flowId, undefined);
    assert.equal(noFlow.taskId, undefined);
  });

  it("flowIdForRoom 返回活跃编排 id，无 flow 时 undefined", async () => {
    const rooms = new RoomManager();
    const room = rooms.create(
      "team",
      [
        { sessionId: "conductor", name: "leader" },
        { sessionId: "worker", name: "coder" },
      ],
      "conductor",
      { conductorId: "conductor" },
    );
    const manager = new RoomModeManager(
      { prompt: async () => {}, isBusy: () => false, cancel: async () => {} },
      rooms,
      () => {},
    );
    assert.equal(manager.flowIdForRoom(room.roomId), undefined);
    await manager.handle(room, "/task @worker 干活");
    const flow = manager.getFlow(room.roomId) as { flowId?: string } | undefined;
    assert.ok(flow?.flowId);
    assert.equal(manager.flowIdForRoom(room.roomId), flow!.flowId);
  });
});
