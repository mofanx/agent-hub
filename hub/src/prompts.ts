/** 编排模式的提示词模板集中地：conductor 派工/验收/汇总、auto 决策、parallel 汇总、pipeline、debate、求助往返。
 *  运行时数据（成员列表、flow 状态、artifacts、话题）一律以参数注入，函数体只做插值拼装。 */

export const PLAN_FORMAT_FIX_PROMPT =
  "上一次规划无法解析为任务计划，尚未派工。请只输出一个 JSON code block，顶层包含 goal（字符串）、acceptanceCriteria（字符串数组）和 tasks（数组）；每项任务的 to 必须是现有成员且 task 非空。若确实需要用户先决定，请输出 questions（最多 4 条）并将 tasks 设为 []。不要解释或调用工具。";

export const SELF_MODE_NOTE =
  "本轮由你直接作答，请直接回复用户消息，不要输出任何 JSON 或模式选择。";

/** 成员列表渲染：排除 conductor，"name (id: sessionId)" 顿号连接 */
export function conductorMemberList(
  members: { sessionId: string; name: string }[],
  conductorId?: string,
): string {
  return (
    members
      .filter((m) => m.sessionId !== conductorId)
      .map((m) => `${m.name} (id: ${m.sessionId})`)
      .join("、") || "（无）"
  );
}

/** 规划 prompt 的 JSON 示例：取前两名非 conductor 成员做占位 */
export function planExample(
  members: { sessionId: string; name: string }[],
  conductorId?: string,
): string {
  const others = members.filter((m) => m.sessionId !== conductorId);
  if (others.length === 0) {
    return '{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[]}';
  }
  const sample = others.slice(0, 2).map((m, i) =>
    JSON.stringify({ to: m.sessionId, task: i === 0 ? "先处理第一个子任务" : "再处理第二个子任务" })
  );
  return `{"goal":"用一句话重述最终目标","acceptanceCriteria":["可验证标准1"],"tasks":[${sample.join(",")}]}`;
}

/** 未结话题注入条目：ownerName 由调用方按房间成员表预解析 */
export type OpenTopicInput = { ownerName?: string | undefined; text: string };

/** 「未结话题」段：open 状态 topic 列表，每条 ≤120 字符、最多 10 条；无话题返回空数组 */
export function openTopicsSection(topics: readonly OpenTopicInput[] | undefined): string[] {
  if (!topics || topics.length === 0) return [];
  return [
    "",
    "未结话题（跟踪这些已开启未结项，答复/验收/汇总时确认是否已覆盖）：",
    ...topics.slice(0, 10).map(
      (t) => `- ${t.ownerName ? `${t.ownerName}：` : ""}${t.text.replace(/\s+/g, " ").slice(0, 120)}`,
    ),
  ];
}

/** conductor 规划（拆解剖/派工）prompt */
export function conductorPlanningPrompt(args: {
  roomName: string;
  memberList: string;
  task: string;
  example: string;
  qa?: { questions: string[]; answer: string; criteria: string[]; supplements: string[] } | undefined;
  artifactLines?: string[] | undefined;
  openTopics?: OpenTopicInput[] | undefined;
}): string {
  const { roomName, memberList, task, example, qa, artifactLines } = args;
  const prompt = [
    `你是群聊「${roomName}」的指挥家（Conductor）。`,
    `可派工的成员：${memberList}。`,
    "",
    `用户任务：${task}`,
    "",
    "请把任务拆解并派发给成员。",
    "协作边界：成员可能本身运行 Devin Fusion 或内部子代理。Agent Hub 只按独立责任边界、不同专长或明确依赖拆分；不要把单个成员能端到端完成的工作切成多个重复/微小任务，也不要让多个写任务修改同一文件。",
    "",
    "输出格式要求（必须严格遵守）：",
    "1. 必须输出一个 JSON code block；tasks 非空时 JSON 外不要有文字。",
    "2. JSON 顶层字段必须包含 `goal`（用一句话重述最终目标）、`acceptanceCriteria`（数组，每条是可验证的验收标准）和 `tasks`（数组）。",
    "3. 每个任务对象包含 `to`（接收成员）、`task`（具体子任务描述），可选 `id`（任务标识）和 `dependsOn`（依赖的 id 数组）。",
    "4. `to` 可以是：成员 ID（括号里的 `id:...`）、`@成员名` 或成员名。",
    "5. `task` 必须具体、可执行，不要写占位符。",
    "6. 如果任务有依赖关系，请用 `dependsOn` 指定前置任务 `id`。",
    "7. `acceptanceCriteria` 每条都必须是可验证的标准，用于任务完成后验收是否达标。",
    "8. 如果任务简单、无需分工，tasks 输出 `[]`；tasks 为空时允许在 code block 之前直接写出你的最终回答。",
    "9. 仅当缺少必须由用户决定的关键信息、完全无法给出合理计划时，可同时输出 `questions` 数组（1-4 条、每条不超过 200 字、只问不可或缺的问题），此时 `tasks` 必须为 `[]`；Hub 会把问题转给用户，答复后会再请你规划一次，届时不得再次提问。可自主判断的细节不要提问，也不要请求用户批准执行任意命令。",
    "",
    "正确示例（请用实际成员 ID 替换）：",
    "```json",
    example,
    "```",
    "",
    "错误示例（不要这样做）：",
    '- to: "成员A"（不存在该成员）',
    '- task: "处理一下"（不够具体）',
    '- 输出多个 code block 或在 JSON 外加解释文字',
  ];
  if (qa) {
    prompt.push(
      "",
      "你此前就本任务向用户提问，答复如下：",
      ...qa.questions.map((q, i) => `${i + 1}. ${q}`),
      `用户答复：${qa.answer.slice(0, 2000)}`,
      ...(qa.criteria.length > 0
        ? ["", "验收标准：", ...qa.criteria.map((c, i) => `${i + 1}. ${c}`)]
        : []),
      ...(qa.supplements.length > 0
        ? [
            "",
            "用户在等待答复期间补充的要求（请一并纳入拆解与验收）：",
            ...qa.supplements.map((s) => `- ${s.slice(0, 400)}`),
          ]
        : []),
      "",
      "已收集所需信息：请直接输出最终计划（tasks）或最终回答，不要再输出 questions。",
    );
  }
  if (artifactLines?.length) {
    prompt.push("", "用户明确引用了以下产物，请把它们作为上下文：", ...artifactLines);
  }
  prompt.push(...openTopicsSection(args.openTopics));
  return prompt.join("\n");
}

/** worker 子任务派发正文（经 rooms.buildPrompt 再包一层房间上下文） */
export function workerTaskPrompt(args: {
  taskId: string;
  task: string;
  upstreamLines?: string[] | undefined;
  qaLines?: string[] | undefined;
  supplements?: string[] | undefined;
}): string {
  return [
    ...(args.upstreamLines && args.upstreamLines.length > 0
      ? [
          "前置任务结果（这是你的直接输入，请在此基础上继续）：",
          ...args.upstreamLines,
          "",
        ]
      : []),
    `指挥家派发给你的子任务（id: ${args.taskId}）：${args.task}`,
    ...(args.qaLines ?? []),
    ...(args.supplements && args.supplements.length > 0
      ? [
          "",
          "用户在执行中补充了要求（请遵循）：",
          ...args.supplements.map((s) => `- ${s.slice(0, 400)}`),
        ]
      : []),
    "",
    "你拥有该子任务的端到端责任；若当前 Agent 支持 Fusion 或内部子代理，可用于本任务内的探索、实现和验证，但不要把工作再次分派给群聊中的其他成员。",
    "",
    "协作约定：",
    "- 如遇阻塞需要他人关键信息，在输出末尾附一个求助块并结束本轮，Hub 会把回复转回给你后继续；",
    '  ```json',
    '  {"help":{"to":"成员名/id 或 \\"user\\"（求助用户）","question":"具体问题"}}',
    '  ```',
    "- 若你的产出是对其他成员任务的独立验证，请在报告 JSON 中附加 verify 数组；evidence 必须基于被验证任务提交的 baseline/diff/verifyCommand 进行实际复核；command/exitCode/stdout 仅在你确实运行了命令且有工具输出反馈时填写，不要编造——该结论属于成员判断，不代表 Hub 自动执行了检查：",
    '  ```json',
    '  {"verify":[{"task":"tX","verdict":"pass|fail|partial","evidence":{"summary":"结论","baseline":"修改前代码","diff":"..."}}]}',
    '  ```',
    "",
    "完成子任务后，请在自由文本总结后附带一个 JSON code block 报告你产生的 artifact（修改的文件、执行的命令、测试结果、以及用于他人复核的证据）：",
    '```json',
    '{"text":"你的总结","artifacts":[{"type":"file","path":"/path/to/file","summary":"改动摘要"},{"type":"command","summary":"运行的命令和结果"},{"type":"test","summary":"测试结果"}]}',
    '```',
    "",
    "若子任务涉及代码修改，强烈建议在 JSON 中附加可验证字段：baseline（修改前代码/状态）、diff（实际修改）、reproSteps（复现步骤）、verifyCommand（验证命令）。这些会直接进入验收证据，供其他成员或用户复查。",
    "若报告 verifyCommand，Hub 只会在命令与管理员已预设的检查完全匹配时尝试隔离运行；未提供 verifyCheckId 时还需文件产物。若知道预设 ID，可附加 verifyCheckId；ID 未获批准或与命令不一致不会回退为自动匹配。未获批准的命令仅保留成员自报，绝不自动运行。",
    "如果没有 artifact，可以只输出文本，不必输出 JSON。",
  ].join("\n");
}

/** worker 向成员求助时转发给目标的求助 prompt */
export function helpRequestPrompt(args: {
  roomName: string;
  fromName: string;
  task: string;
  question: string;
  context?: string | undefined;
}): string {
  return [
    `群聊「${args.roomName}」成员 @${args.fromName} 在执行子任务「${args.task.slice(0, 200)}」时向你求助：`,
    "",
    args.question,
    ...(args.context ? ["", `相关上下文：${args.context}`] : []),
    "",
    "请直接给出结论与依据；这不是派工，无需执行完整任务。",
  ].join("\n");
}

/** 求助获得答复后唤醒原 worker 的续跑 prompt */
export function helpResumePrompt(args: {
  taskId: string;
  task: string;
  fromLabel: string;
  question: string;
  answer?: string | undefined;
  remaining: number;
}): string {
  return [
    `你此前在执行子任务（id: ${args.taskId}）时向 ${args.fromLabel} 求助。`,
    `你的问题：${args.question}`,
    `${args.fromLabel} 的回复：${(args.answer ?? "（未获得回复）").slice(0, 2000)}`,
    "",
    `请据此继续完成子任务：${args.task}`,
    args.remaining > 0
      ? `若仍有关键阻塞可再次求助（剩余 ${args.remaining} 次）；否则完成任务并输出 artifact 报告 JSON。`
      : "请基于现有信息完成任务并输出 artifact 报告 JSON。",
  ].join("\n");
}

/** 独立复核（质疑性验证）任务的任务描述 */
export function peerReviewTaskDescription(doneIds: string[]): string {
  return `独立复核（质疑性验证）：请逐项审查已完成任务 ${doneIds.join("、")} 的交付内容与自报验证证据，主动挑战其假设、寻找遗漏的边界与负面用例；对每个被复核任务在报告 JSON 中输出结构化 verify 条目，evidence 必须基于该任务提交的 baseline/diff/verifyCommand 实际复核，仅当你确实运行过命令且有工具输出反馈时才填写 command/exitCode/stdout，不得编造执行记录或正向结论。`;
}

/** 隔离检查结果的一行描述（注入验收/汇总 prompt） */
export function describeAutomaticCheck(
  c: {
    status: string;
    exitCode?: number | undefined;
    snapshotHash?: string | undefined;
    detail?: string | undefined;
  },
  snapshotCurrent?: boolean,
): string {
  const detail = c.detail ? `,detail=${c.detail.slice(0, 200)}` : "";
  return `隔离检查：${c.status},exitCode=${c.exitCode ?? "unknown"},snapshotHash=${c.snapshotHash?.slice(0, 12) ?? "none"}${detail}${snapshotCurrent === false ? "，当前工作区已变化或无法核对，旧隔离检查仅对应历史快照，不得据此宣称当前版本通过。" : ""}`;
}

/** conductor 验收（review）prompt */
export function conductorReviewPrompt(args: {
  roomName: string;
  goal: string;
  criteria: string[];
  iteration: number;
  maxIterations: number;
  resultLines: string[];
  qaLines?: string[] | undefined;
  supplements?: string[] | undefined;
  hasChecks: boolean;
  unverifiedDone: string[];
  memberList: string;
  openTopics?: OpenTopicInput[] | undefined;
}): string {
  const criteria = args.criteria.length > 0
    ? args.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "（未提供，按用户目标自行判断）";
  return [
    `你是群聊「${args.roomName}」的指挥家。`,
    "",
    `原始目标：${args.goal || "（未记录）"}`,
    "",
    "验收标准：",
    criteria,
    "",
    `第 ${args.iteration}/${args.maxIterations} 轮子任务已全部完成，结果如下：`,
    ...args.resultLines,
    ...(args.qaLines ?? []),
    ...(args.supplements && args.supplements.length > 0
      ? [
          "",
          "用户在执行中补充的要求（验收时请一并核查）：",
          ...args.supplements.map((s) => `- ${s.slice(0, 400)}`),
        ]
      : []),
    "",
    args.hasChecks
      ? "注意：成员自报字段不等于隔离检查；退出码0只表示进程退出0，不代表全部验收标准满足；依赖/运行时未包含在源码快照哈希内，请结合证据自行评估可信度。"
      : "注意：以上结果中的命令、退出码、输出与「独立验证」条目均为成员自报，Hub 并未自动执行任何检查，不可称为自动检查通过，请结合证据自行评估可信度。",
    ...(args.unverifiedDone.length > 0
      ? [
          `注意：以下任务没有任何独立成员复核记录（${args.unverifiedDone.join("、")}），其结果均来自任务执行者自报，不得声称已经过独立验证。`,
        ]
      : []),
    ...openTopicsSection(args.openTopics),
    "",
    "请对照验收标准逐条核查以上结果是否已满足目标。",
    "不要调用任何工具，只输出一个 JSON code block，二选一：",
    '```json',
    '{"decision":"complete","reason":"为什么已经满足全部验收标准"}',
    '```',
    "或",
    '```json',
    '{"decision":"continue","reason":"尚缺什么","tasks":[{"id":"可选","to":"成员 id/名称","task":"明确返工或补充任务","dependsOn":["已有或本轮任务 id"]}]}',
    '```',
    "要求：只针对验收缺口派最少的任务，不要重复已完成的工作。",
    `可派工的成员：${args.memberList}。`,
  ].join("\n");
}

/** conductor 汇总（summarize）prompt */
export function conductorSummarizePrompt(args: {
  roomName: string;
  goal: string;
  criteria: string[];
  reviewReason?: string | undefined;
  hasFailures: boolean;
  resultLines: string[];
  qaLines?: string[] | undefined;
  supplements?: string[] | undefined;
  hasChecks: boolean;
  unverifiedDone: string[];
  failedNames?: string | undefined;
  openTopics?: OpenTopicInput[] | undefined;
}): string {
  const promptLines: string[] = [
    `你是群聊「${args.roomName}」的指挥家。`,
    `原始目标：${args.goal || "（未记录）"}`,
    `验收标准：${args.criteria.length > 0 ? args.criteria.join("；") : "（未提供）"}`,
    ...(args.reviewReason ? [`验收结论：${args.reviewReason}`] : []),
    args.hasFailures
      ? `你之前派发的子任务部分完成、部分失败，结果如下：`
      : `你之前派发的子任务已全部完成，结果如下：`,
    ...args.resultLines,
    ...(args.qaLines ?? []),
    ...(args.supplements && args.supplements.length > 0
      ? [
          "",
          "用户在执行中补充的要求：",
          ...args.supplements.map((s) => `- ${s.slice(0, 400)}`),
        ]
      : []),
    args.hasChecks
      ? "注意：成员自报字段不等于隔离检查；退出码0只表示进程退出0，不代表全部验收标准满足；依赖/运行时未包含在源码快照哈希内，汇总时不要称为自动检查通过。"
      : "注意：以上结果中的命令、退出码、输出与「独立验证」条目均为成员自报，Hub 并未自动执行任何检查，汇总时不要称为自动检查通过。",
    ...(args.unverifiedDone.length > 0
      ? [
          `注意：以下任务没有任何独立成员复核记录（${args.unverifiedDone.join("、")}），其结果均来自任务执行者自报，汇总时不得声称已经过独立验证。`,
        ]
      : []),
    ...openTopicsSection(args.openTopics),
    "",
  ];
  if (args.hasFailures) {
    promptLines.push(
      `以下子任务未能完成：${args.failedNames ?? ""}。`,
      "请在汇总中：",
      "1. 基于已完成的子任务给出可交付的部分成果；",
      "2. 明确标注哪些部分未完成及其影响；",
      "3. 建议用户是否需要重新派发失败的部分。",
      "",
    );
  }
  promptLines.push(
    "请用简短答复交付：先给结论（完成了什么、是否满足目标），再逐条列出每项验收标准、对应任务 id 及证据来源（成员自报／独立成员复核／Hub 隔离检查），没有明确对应证据时写「未覆盖」；再列未解决或待确认事项（没有则写「无」），最后说明实际复核情况。成员判断与 Hub 隔离检查必须分开表述，对未运行或受阻的检查如实说明；快照过期时也不得称当前版本通过。退出码0只说明该检查进程退出0，不代表该标准或整体目标达标，不得用任务完成数代替验收结论。技术细节和完整输出留在可展开的任务证据中；若修改文件，请引用相关路径。",
  );
  return promptLines.join("\n");
}

/** auto 决策反馈历史段 */
export function autoHistorySection(
  list: readonly { at: number; mode: string; reason: string; accepted?: boolean | undefined }[],
): string {
  if (list.length === 0) return "";
  const decided = list.filter((e) => e.accepted !== undefined);
  const accepted = decided.filter((e) => e.accepted).length;
  const total = decided.length;
  const recent = list.slice(-5).map((e) => {
    const mark = e.accepted === true ? "✓" : e.accepted === false ? "✗" : "?";
    return `- ${mark} ${e.mode}: ${e.reason}`;
  }).join("\n");
  return `\n最近 auto 决策反馈：共 ${total} 条，被接受 ${accepted} 条，被覆盖 ${total - accepted} 条。\n${recent}\n`;
}

/** auto 模式主持人决策 prompt */
export function autoDecisionPrompt(args: {
  roomName: string;
  members: string;
  boardText: string;
  historyText: string;
  text: string;
  quoteText?: string | undefined;
  noteText?: string | undefined;
  sessionNoteText?: string | undefined;
  openTopics?: OpenTopicInput[] | undefined;
}): string {
  return [
    `你是群聊「${args.roomName}」的主持人。请根据用户消息和成员信息，选择本轮最合适的协作模式。`,
    `成员：${args.members}`,
    "",
    "可用模式及含义：",
    "- mention：用户明确@某人，或问题简单直接，应指定/全部成员独立回答",
    "- conductor：任务复杂，需要拆解成子任务并派工给不同成员",
    "- roundrobin：适合轮流发言、按顺序补充，每个问题一人作答",
    "- parallel：需要多个成员独立给出观点后汇总，适合集思广益",
    "- pipeline：任务需要按固定顺序串行处理，例如 编码 → 审查 → 测试",
    "- debate：需要对某一观点进行正反方辩论，最后由裁判总结",
    "- self：你自己就能直接回答，不需要其他成员",
    "",
    "选择原则：成员可能本身具备 Devin Fusion 或内部子代理。仅在需要跨成员独立责任、不同专长、真正并行观点或顺序交接时使用 Hub 多成员模式；单个成员可端到端完成时优先 self/mention，避免双重编排和重复成本。",
    "",
    "可拆分性判断（重要）：任务量大不是拆分的理由，子任务可独立执行才是。",
    "- 可拆分 → parallel/conductor：子任务落在互不共享的文件/模块上、结果可独立验证；",
    "- 不可拆 → 量大也 self/mention：共享文件/共享类型定义/统一词汇表是收敛点，并行只会产生合并冲突；",
    "- 不确定 → 保守取 self/mention，并在 reason 中说明理由。",
    "",
    "⚠️ 输出要求（极其重要，违反将导致系统故障）：",
    "1. 只能输出一个 JSON 代码块，不能有任何其他文字",
    "2. 不要调用任何工具",
    "3. 不要输出思考过程、解释、前言、总结",
    "4. JSON 必须包含 mode 字段，值为上述七种模式之一",
    "",
    "示例（直接输出，不要模仿思考过程）：",
    "简单问候 → ```json\n{ \"mode\": \"self\", \"reason\": \"简单对话，主持人直接回答\" }\n```",
    "复杂编码任务 → ```json\n{ \"mode\": \"conductor\", \"reason\": \"需要拆解为编码和测试子任务\", \"params\": { \"tasks\": [{\"to\":\"成员名\",\"task\":\"具体任务\",\"id\":\"t1\",\"dependsOn\":[]}] } }\n```",
    "征求意见 → ```json\n{ \"mode\": \"parallel\", \"reason\": \"需要多人独立给出方案后汇总\" }\n```",
    "",
    "params 说明（可选，不确定时可省略）：",
    '- mention: { "targets": ["sessionId", ...] }',
    '- roundrobin: { "speaker": "sessionId" }',
    '- parallel: { "summarizer": "sessionId" }',
    '- pipeline: { "order": ["sessionId", ...] }',
    '- debate: { "sides": ["sessionId", "sessionId"], "judge": "sessionId", "rounds": 2 }',
    '- conductor: { "tasks": [{"to":"成员名或id","task":"具体子任务","id":"t1","dependsOn":[],"files":["预计修改的文件，可选"]}] }',
    '- self: { }',
    "",
    "conductor 模式 params 使用约束：",
    "- `tasks` 中的 `to` 必须是除主持人（你自己）之外的成员 id 或名字；",
    "- 不要写\"提交\"、\"汇总\"等主持人动作作为 worker task，这些由主持人自动完成；",
    "- `dependsOn` 只能引用同一 `tasks` 列表里、且排在前面的任务 `id`，不要自引用或引用未定义的任务；",
    "- 各任务之间应尽量文件级排他，可用 `files` 声明预计修改文件；若两个任务声明了相同文件，系统会自动合并为一个任务。",
    "",
    "最近上下文：",
    args.boardText,
    args.historyText,
    ...openTopicsSection(args.openTopics),
    `${args.quoteText ?? ""}用户消息：${args.text}`,
    args.noteText ?? "",
    args.sessionNoteText ?? "",
    "",
    "现在请直接输出 JSON 代码块，不要有任何其他内容：",
  ].join("\n");
}

/** 用户补充要求块：parallel 汇总 / pipeline / debate 共用片段 */
export function extrasBlock(extras: readonly string[] | undefined): string {
  return extras && extras.length > 0
    ? `\n\n用户补充要求：\n${extras.map((e) => `- ${e.slice(0, 300)}`).join("\n")}`
    : "";
}

/** parallel 汇总者 prompt */
export function parallelSummarizerPrompt(args: {
  roomName: string;
  lines: string[];
  extras?: readonly string[] | undefined;
}): string {
  return `你是群聊「${args.roomName}」的汇总者。多位成员就同一问题给出了独立回答：\n${args.lines.join("\n")}${extrasBlock(args.extras)}\n\n请综合以上观点，给用户一个清晰、全面的最终回答。`;
}

/** pipeline 阶段任务正文与引用（首阶段带 note，后续阶段引用上一阶段输出） */
export function pipelineStage(args: {
  topic: string;
  stage: number;
  note?: string | undefined;
  quote?: { author: string; text: string } | undefined;
  prevName?: string | undefined;
  prevOutput?: string | undefined;
  extras?: readonly string[] | undefined;
}): { task: string; quote: { author: string; text: string } | undefined } {
  let task = args.topic;
  if (args.note && args.stage === 0) task = `${args.note}\n\n${task}`;
  let quote = args.quote;
  if (args.prevName && args.prevOutput !== undefined) {
    quote = { author: args.prevName, text: args.prevOutput };
    task = `请继续下一阶段处理原始任务：${task}`;
  }
  if (args.extras?.length) task = `${task}${extrasBlock(args.extras)}`;
  return { task, quote };
}

/** debate 正方/反方发言任务正文 */
export function debateTurnTask(args: {
  topic: string;
  round: number;
  rounds: number;
  sideIndex: number;
  hasOpponentOutput: boolean;
  note?: string | undefined;
  extras?: readonly string[] | undefined;
}): string {
  const position = args.sideIndex === 0 ? "正方" : "反方";
  const text = `这是辩论第 ${args.round}/${args.rounds} 轮，你是${position}。请就辩题继续阐述观点${
    args.hasOpponentOutput ? "并回应对方" : ""
  }。`;
  let task = `${text}\n\n辩题：${args.topic}`;
  if (args.note) task = `${args.note}\n\n${task}`;
  if (args.extras?.length) task = `${task}${extrasBlock(args.extras)}`;
  return task;
}

/** debate 裁判总结 prompt 正文 */
export function debateJudgePrompt(args: {
  topic: string;
  lines: string[];
  extras?: readonly string[] | undefined;
}): string {
  return `你是辩论裁判。辩题：${args.topic}\n\n辩论记录：\n${args.lines.join("\n")}${extrasBlock(args.extras)}\n\n请做出公正总结，指出共识与分歧，给出最终判断。`;
}
