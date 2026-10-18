import type { Room } from "./room.js";
import type { MissionSnapshot } from "./mission.js";
import type { MissionTemplate, ScheduledTask } from "./scheduler.js";

export type MissionTaskDeps = {
  getRoom(roomId: string): Room | undefined;
  hasActiveFlow(roomId: string): boolean;
  isMemberBusy(sessionId: string): boolean;
  isAvailable(sessionId: string): boolean;
  activeMissions(roomId: string): MissionSnapshot[];
  createMission(input: {
    roomId: string;
    goal: string;
    acceptanceCriteria: string[];
    scope: string;
    constraints: string[];
    ownerSessionId: string;
    maxAutoRetries: number;
  }): MissionSnapshot;
  startMission(id: string): Promise<MissionSnapshot>;
};

export function missionTemplateFrom(
  mission: MissionSnapshot,
  targetType: string,
  targetId: string,
): MissionTemplate {
  if (targetType !== "room") throw new Error("mission schedule requires room target");
  if (mission.roomId !== targetId) throw new Error("mission room does not match task target");
  return {
    sourceMissionId: mission.id,
    roomId: mission.roomId,
    goal: mission.goal,
    acceptanceCriteria: [...mission.acceptanceCriteria],
    scope: mission.scope,
    constraints: [...mission.constraints],
    ownerSessionId: mission.ownerSessionId,
    maxAutoRetries: mission.maxAutoRetries,
  };
}

export async function runMissionTask(
  task: ScheduledTask,
  deps: MissionTaskDeps,
): Promise<"draft" | "started"> {
  const tpl = task.missionTemplate;
  if (!tpl) throw new Error("not a mission task");
  if (task.targetType !== "room" || task.targetId !== tpl.roomId)
    throw new Error("mission template target mismatch");
  const room = deps.getRoom(tpl.roomId);
  if (!room) throw new Error(`unknown room: ${tpl.roomId}`);
  if (task.missionAutoStart && !room.members.every((mem) => deps.isAvailable(mem.sessionId)))
    throw new Error(`room ${room.roomId} has unavailable members; auto start skipped`);
  const occupied =
    deps.hasActiveFlow(room.roomId) ||
    room.members.some((mem) => deps.isMemberBusy(mem.sessionId)) ||
    deps.activeMissions(room.roomId).some((x) =>
      ["running", "waiting-user", "awaiting-acceptance"].includes(x.status),
    );
  if (occupied) throw new Error(`room ${room.roomId} occupied; mission task skipped`);
  const draft = deps.createMission({
    roomId: room.roomId,
    goal: tpl.goal,
    acceptanceCriteria: tpl.acceptanceCriteria,
    scope: tpl.scope,
    constraints: tpl.constraints,
    ownerSessionId: tpl.ownerSessionId,
    maxAutoRetries: tpl.maxAutoRetries,
  });
  if (task.missionAutoStart) {
    await deps.startMission(draft.id);
    return "started";
  }
  return "draft";
}
