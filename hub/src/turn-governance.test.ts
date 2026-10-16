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
