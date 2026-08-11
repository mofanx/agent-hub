import { RoomManager } from "../src/room.js";
import { RoomModeManager } from "../src/room-modes.js";
import type { AgentOps } from "../src/room-modes.js";

const rooms = new RoomManager();
const room = rooms.create("测试群", [
  { sessionId: "s1", name: "主持人" },
  { sessionId: "s2", name: "阿明" },
], "auto", { conductorId: "s1" });

const outputs: string[] = [];

const agentOps: AgentOps = {
  prompt: async (sessionId, content) => {
    if (typeof content === "string") {
      outputs.push(`[prompt to ${sessionId}] ${content.slice(0, 300)}`);
    } else {
      outputs.push(`[prompt to ${sessionId}] (content blocks)`);
    }
  },
  isBusy: () => false,
  cancel: async () => {},
};

const broadcast = (method: string, params: Record<string, unknown>) => {
  outputs.push(`[broadcast] ${method} ${JSON.stringify(params).slice(0, 200)}`);
};

const manager = new RoomModeManager(agentOps, rooms, broadcast);

async function testWith(output: string) {
  outputs.length = 0;
  console.log(`\n--- 模拟模型输出 ---\n${output}\n---`);
  const result = await manager.handle(room, "我们该怎么办？");
  console.log("handle result:", result);

  // 模拟模型返回
  await manager.onPromptDone("s1", output);

  console.log("--- 输出日志 ---");
  for (const line of outputs) console.log(line);
  const runtime = manager.exportRuntime()[room.roomId] as { mode?: string } | undefined;
  console.log(`--- room sub mode: ${runtime?.mode ?? "无"} ---`);
}

(async () => {
  await testWith(`\`\`\`json\n{ "mode": "mention", "reason": "没有复杂任务" }\n\`\`\``);
  await testWith(`我认为应该选择 mention 模式，这个问题很简单。`);
  await testWith(`{ "mode": "conductor", "reason": "任务需要拆解" }`);
  await testWith(`<thinking> 选 conductor </thinking> { "mode": "conductor", "reason": "拆解" }`);
  await testWith(`r", "reason": "任务需要拆解派工", "params": { "tasks": [{"to":"成员名或id","task":"具体子任务","id":"t1"}] } }\n\`\`\`\n\nparams 说明：\n- mention: { "targets": ["sessionId", ...] }，未指定则发给全部\n- roundrobin: { "speaker": "sessionId" }，可指定起始发言人，默认按成员顺序\n- parallel: { "summarizer": "sessionId" }，默认使用主持人\n- pipeline: { "order": ["sessionId", ...] }，默认按成员顺序\n- debate: { "sides": ["sessionId", "sessionId"], "judge": "sessionId", "rounds": 2 }，默认前两位成员作正反方、主持人作裁判\n- conductor: { "tasks": [{"to":"成员名或id","task":"具体子任务","id":"t1","dependsOn":["t1"]}] }，可选初始派工单，如无需则 omit\n- self: { }\n\n最近上下文：\n（暂无）\n\n用户消息：继续打磨的细节，比如会话列表的 filter chips、聊天内搜索、或者更细腻的交互动画？\n\n\n\n注意：你必须且只能输出一个上面格式的 JSON code block，不要加任何解释、前缀或后缀。\`\`\`json\n{\n"mode": "parallel",\n"reason": "用户在多个桌面端打磨方向中征求意见，适合各成员独立给出优先级判断和理由，再由主持人汇总",\n"params": {\n"summarizer": "5"\n}\n}\n\`\`\``);
  await testWith(`sorry I cannot decide`);
})().catch((err) => {
  console.error("auto check failed:", err);
  process.exit(1);
});
