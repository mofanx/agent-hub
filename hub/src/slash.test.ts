import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoomManager } from "./room.js";
import type { ModelBackend } from "./model.js";
import {
  parseSlash,
  SESSION_MODES,
  HUB_SLASH_COMMANDS,
  handleSessionModeSlash,
  handleRoomModeSlash,
  type ModeSlashDeps,
} from "./slash.js";

/** 按现有测试风格搭建：真实 RoomManager + 替身 deps（fake AcpAgent 行为收敛进 applySessionMode 记录） */
function makeHarness(
  members: { sessionId: string; name: string; backend: ModelBackend }[],
  opts: { knownBackends?: ModelBackend[]; deadSessions?: Set<string> } = {},
) {
  const backendOf = new Map(members.map((m) => [m.sessionId, m.backend]));
  const rooms = new RoomManager();
  rooms.setMemberChannelResolver((sid) => ({
    agent: backendOf.get(sid),
    origin: "local",
  }));
  const room = rooms.create(
    "slash-room",
    members.map((m) => ({ sessionId: m.sessionId, name: m.name })),
    "mention",
  );
  const known = new Set(opts.knownBackends ?? ["devin", "claude"]);
  const modes: Record<string, string> = {};
  const backendConfigs: [ModelBackend, string, string][] = [];
  const deps: ModeSlashDeps = {
    applySessionMode: async (sid, mode) => {
      if (!SESSION_MODES.has(mode)) throw new Error(`unknown mode: ${mode}`);
      if (opts.deadSessions?.has(sid)) throw new Error("agent 未连接");
      modes[sid] = mode;
    },
    sessionBackend: (sid) => backendOf.get(sid),
    memberBackendType: (sid) => backendOf.get(sid) ?? "devin",
    memberDisplayName: (m) => rooms.displayNameFor(m),
    findByBackend: (b) => (known.has(b) ? [{}] : []),
    setBackendConfig: (b, k, v) => backendConfigs.push([b, k, v]),
  };
  return { room, rooms, deps, modes, backendConfigs };
}

const slash = (text: string) => {
  const s = parseSlash(text);
  assert.ok(s, `parseSlash failed for ${text}`);
  return s;
};

describe("slash dispatch 白名单", () => {
  it("stop/mode/bypass 进 handler；其余未知 /x 透传（agent skill 兼容）", () => {
    for (const cmd of ["stop", "mode", "bypass"]) {
      assert.equal(HUB_SLASH_COMMANDS.has(cmd), true, `${cmd} 应进 handler`);
    }
    // /model、/review 等不在白名单 → dispatch 落到普通消息路径，透传给 agent
    for (const cmd of ["model", "review", "skill-foo"]) {
      const s = slash(`/${cmd} arg1`);
      assert.equal(s.command, cmd);
      assert.equal(HUB_SLASH_COMMANDS.has(s.command), false, `/${cmd} 应透传`);
    }
  });
});

describe("session /mode、/bypass", () => {
  it("/mode plan 进 handler 生效并返回 mode", async () => {
    const h = makeHarness([{ sessionId: "s1", name: "a", backend: "devin" }]);
    const r = (await handleSessionModeSlash("s1", slash("/mode plan"), h.deps)) as {
      mode: string;
      backendDefault: boolean;
    };
    assert.equal(r.mode, "plan");
    assert.equal(r.backendDefault, false);
    assert.equal(h.modes.s1, "plan");
  });

  it("/bypass → bypass、/bypass off → accept-edits（维持既有映射）", async () => {
    const h = makeHarness([{ sessionId: "s1", name: "a", backend: "devin" }]);
    await handleSessionModeSlash("s1", slash("/bypass"), h.deps);
    assert.equal(h.modes.s1, "bypass");
    await handleSessionModeSlash("s1", slash("/bypass off"), h.deps);
    assert.equal(h.modes.s1, "accept-edits");
  });

  it("/mode plan --global 按会话自身 backend 写默认", async () => {
    const h = makeHarness([{ sessionId: "s1", name: "a", backend: "claude" }]);
    const r = (await handleSessionModeSlash("s1", slash("/mode plan --global"), h.deps)) as {
      backendDefault: boolean;
    };
    assert.equal(r.backendDefault, true);
    assert.deepEqual(h.backendConfigs, [["claude", "mode", "plan"]]);
  });
});

describe("room /mode、/bypass", () => {
  const members = () => [
    { sessionId: "s1", name: "coder", backend: "claude" as ModelBackend },
    { sessionId: "s2", name: "tester", backend: "devin" as ModelBackend },
    { sessionId: "s3", name: "ops", backend: "claude" as ModelBackend },
  ];

  it("无定向时应用到全体成员", async () => {
    const h = makeHarness(members());
    const r = (await handleRoomModeSlash(h.room, slash("/mode ask"), h.deps)) as {
      mode: string;
      applied: string[];
      failed: string[];
    };
    assert.equal(r.mode, "ask");
    assert.deepEqual(r.applied.sort(), ["s1", "s2", "s3"]);
    assert.deepEqual(r.failed, []);
  });

  it("@成员名定向只应用到被点名成员", async () => {
    const h = makeHarness(members());
    const r = (await handleRoomModeSlash(h.room, slash("/mode ask @coder"), h.deps)) as {
      applied: string[];
    };
    assert.deepEqual(r.applied, ["s1"]);
    assert.equal(h.modes.s1, "ask");
    assert.equal(h.modes.s2, undefined);
  });

  it("@展示名（name·type·origin 整体）定向等价于成员名", async () => {
    const h = makeHarness(members());
    const display = h.rooms.displayNameFor({ sessionId: "s1", name: "coder" });
    assert.equal(display, "coder·claude·local");
    const r = (await handleRoomModeSlash(
      h.room,
      slash(`/mode ask @${display}`),
      h.deps,
    )) as { applied: string[] };
    assert.deepEqual(r.applied, ["s1"]);
  });

  it("backend 名定向：按 member backendType 过滤并写 setBackendConfig", async () => {
    const h = makeHarness(members());
    const r = (await handleRoomModeSlash(h.room, slash("/mode plan claude"), h.deps)) as {
      applied: string[];
      backendDefault: boolean;
    };
    assert.deepEqual(r.applied.sort(), ["s1", "s3"]);
    assert.equal(r.backendDefault, true);
    assert.deepEqual(h.backendConfigs, [["claude", "mode", "plan"]]);
  });

  it("--global 无具名 backend 时按各目标会话自身 backend 分别写默认", async () => {
    const h = makeHarness(members());
    const r = (await handleRoomModeSlash(h.room, slash("/mode ask -g"), h.deps)) as {
      backendDefault: boolean;
    };
    assert.equal(r.backendDefault, true);
    assert.deepEqual(h.backendConfigs.sort(), [
      ["claude", "mode", "ask"],
      ["devin", "mode", "ask"],
    ]);
  });

  it("@成员 + backend 交集定向", async () => {
    const h = makeHarness(members());
    const r = (await handleRoomModeSlash(
      h.room,
      slash("/mode plan @coder @tester claude"),
      h.deps,
    )) as { applied: string[] };
    assert.deepEqual(r.applied, ["s1"], "tester 是 devin，backend 过滤后只剩 coder");
  });

  it("未识别参数必须报错，不得静默忽略", async () => {
    const h = makeHarness(members());
    await assert.rejects(
      () => handleRoomModeSlash(h.room, slash("/mode plan bogus"), h.deps),
      /unrecognized argument: bogus/,
    );
    await assert.rejects(
      () => handleRoomModeSlash(h.room, slash("/bypass off junk"), h.deps),
      /unrecognized argument: junk/,
    );
    assert.equal(Object.keys(h.modes).length, 0, "报错后不应有部分应用");
  });

  it("缺 mode 词报 usage；agent 未连接的成员计入 failed", async () => {
    const h = makeHarness(members(), { deadSessions: new Set(["s2"]) });
    await assert.rejects(
      () => handleRoomModeSlash(h.room, slash("/mode"), h.deps),
      /usage: \/mode/,
    );
    const r = (await handleRoomModeSlash(h.room, slash("/bypass"), h.deps)) as {
      mode: string;
      applied: string[];
      failed: string[];
    };
    assert.equal(r.mode, "bypass");
    assert.deepEqual(r.applied.sort(), ["s1", "s3"]);
    assert.deepEqual(r.failed, ["s2"]);
  });
});
