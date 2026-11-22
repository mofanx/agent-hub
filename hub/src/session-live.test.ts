import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnsureSessionLive, prewarmTargets, type SessionLiveDeps } from "./session-live.js";

function make(over: Partial<SessionLiveDeps> = {}) {
  const d: SessionLiveDeps = {
    hasOwner: () => false,
    hasMeta: () => true,
    resumeSession: async () => ({ resumed: true }),
    ...over,
  };
  return { ensure: createEnsureSessionLive(d), d };
}

test("owned session: no resume", async () => {
  let resumed = 0;
  const { ensure } = make({ hasOwner: () => true, resumeSession: async () => { resumed++; return {}; } });
  await ensure("s1");
  assert.equal(resumed, 0);
});

test("no meta: no resume", async () => {
  let resumed = 0;
  const { ensure } = make({ hasMeta: () => false, resumeSession: async () => { resumed++; return {}; } });
  await ensure("s1");
  assert.equal(resumed, 0);
});

test("offline+meta: resume once even with 2 concurrent callers", async () => {
  let resumed = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { ensure } = make({
    resumeSession: async () => { resumed++; await gate; return { resumed: true }; },
  });
  const p1 = ensure("s1");
  const p2 = ensure("s1");
  release();
  await Promise.all([p1, p2]);
  assert.equal(resumed, 1);
});

test("recreated id: throws session recreated", async () => {
  const { ensure } = make({ resumeSession: async () => ({ resumed: true, sessionId: "s2" }) });
  await assert.rejects(ensure("s1"), /session recreated as s2/);
});

test("same id resume: ok", async () => {
  const { ensure } = make({ resumeSession: async () => ({ resumed: true, sessionId: "s1" }) });
  await ensure("s1");
});

test("prewarmTargets: only local devin connections owning restored sessions", () => {
  const conns = [
    { id: "d1", name: "devin", agent: "devin", token: "t1", local: true },
    { id: "d2", name: "devin2", agent: "devin", token: "t2", local: true },
    { id: "r1", name: "remote", agent: "devin", token: "t3", local: false },
    { id: "c1", name: "claude", agent: "claude", token: "t4", local: true },
  ];
  const metas = [
    { connectionId: "d1" },
    { connectionId: "r1" },
    { connectionId: "c1" },
    { connectionId: undefined },
  ];
  assert.deepEqual(prewarmTargets(conns, metas).map((c) => c.id), ["d1"]);
  assert.deepEqual(prewarmTargets(conns, []), []);
});
