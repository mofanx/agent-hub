/** 轻量 IFC：房级数据隔离与敏感操作授权。
 *  标签：private/shared（默认 shared 兼容现有行为）；room_ifc 表持久化标签+白名单。
 *  隔离：private 房的数据拉取类 RPC 须 ifcAuthorized 或请求房在白名单内。
 *  蒸馏/黑板：标签随条目记录，跨房引用时按此层判定（本层为判定规则，接入点各自过滤）。
 *  v1 豁免：memberModels 仅成员元数据（模型 id/角色，无房正文）不门控；
 *  事件广播属房内订阅语义（客户端已入房订阅）不门控。 */

export type Sensitivity = "shared" | "private";

export function parseSensitivity(v: unknown): Sensitivity {
  if (v === undefined || v === "shared") return "shared";
  if (v === "private") return "private";
  throw new Error("sensitivity must be shared|private");
}

/** 判定专用错误：客户端可按 message 前缀识别"待批准"而非失败 */
export class IfcAuthError extends Error {
  readonly code = "ifc:authorization_required";
  constructor(what: string) {
    super(`ifc:authorization_required: ${what}`);
  }
}

export interface IfcRule {
  sensitivity: Sensitivity;
  /** 白名单：允许这些 roomId 读取本 private 房数据（跨房引用须显式开） */
  allow: string[];
}

/**
 * 房作用域数据拉取的门控：目标房 private 时——
 *  params.ifcAuthorized===true 放行（显式授权标记）；
 *  params.fromRoomId 在白名单内放行；否则抛 IfcAuthError（待批准）。
 *  目标房 shared/未标 → 恒放行（兼容）。
 */
export function ifcCheckRoomRead(
  rule: IfcRule | undefined,
  roomId: string,
  params: Record<string, unknown> | undefined,
): void {
  if (!rule || rule.sensitivity !== "private") return;
  if (params?.ifcAuthorized === true) return;
  const from = typeof params?.fromRoomId === "string" ? params.fromRoomId : "";
  if (from && rule.allow.includes(from)) return;
  throw new IfcAuthError(`room ${roomId} is private`);
}

/** 敏感写操作（memory.delete 等）：private 房或显式标记时才须授权；
 *  统一策略——始终要求 ifcAuthorized（数据写不可逆，比读更严）。 */
export function ifcCheckSensitiveWrite(
  params: Record<string, unknown> | undefined,
): void {
  if (params?.ifcAuthorized === true) return;
  throw new IfcAuthError("sensitive write requires ifcAuthorized");
}
