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
  await testWith(`sorry I cannot decide`);
})().catch((err) => {
  console.error("auto check failed:", err);
  process.exit(1);
});
