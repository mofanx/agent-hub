import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelManager, parseConfigOptionsModels } from "./model.js";

function modelSetup() {
  const manager = new ModelManager();
  const prefs: Record<string, string> = { s1: "gemini-4-argon-high", s2: "swe-2-high" };
  const catalog = parseConfigOptionsModels([{
    id: "model",
    options: [
      { value: "swe-2-high", name: "SWE-2" },
      { value: "gemini-4-argon-high", name: "Gemini High" },
      { value: "gemini-4-argon-medium", name: "Gemini Medium", costTier: "paid" },
    ],
  }], "devin");
  Object.assign(manager, {
    list: async () => catalog,
    loadSessionPreferences: () => prefs,
    writeSessionPreference: (id: string, uid: string) => { prefs[id] = uid; },
  });
  let current = "swe-2-high";
  const agent = {
    getConfigOptions: (_id: string) => [{
      id: "llm", category: "model", currentValue: current,
      options: [
        { value: "swe-2-high", name: "SWE-2" },
        { value: "gemini-4-argon-medium", name: "Gemini 4 Argon" },
        { value: "agent-only", name: "Agent Only" },
      ],
    }],
    setConfigOption: async (id: string, configId: string, value: string) => {
      assert.equal(id, "s1");
      assert.equal(configId, "llm");
      assert.equal(prefs.s1, "gemini-4-argon-high");
      current = value;
    },
  };
  return { manager, prefs, agent };
}

describe("session model switching", () => {
  it("uses live options and preserves exact-match pricing", async () => {
    const { manager, agent } = modelSetup();
    const models = await manager.listForSession("devin", agent.getConfigOptions("s1"));
    assert.deepEqual(models.map(m => m.uid), ["swe-2-high", "gemini-4-argon-medium", "agent-only"]);
    assert.equal(models[1]!.costTier, "paid");
    assert.equal(models[1]!.label, "Gemini 4 Argon");
    assert.equal(models[2]!.costTier, "unknown");
    assert.deepEqual(await manager.listForSession("devin", [{ id: "model", options: [] }]), []);
    assert.equal((await manager.listForSession("devin", null)).length, 3);
  });

  it("reports the actual model ahead of a stale saved preference", () => {
    const { manager, agent } = modelSetup();
    assert.equal(manager.current("devin", "s1", agent.getConfigOptions("s1")).uid, "swe-2-high");
    assert.equal(manager.current("devin", "s1").uid, "gemini-4-argon-high");
  });

  it("rejects unsupported variants before calling ACP or saving", async () => {
    const { manager, prefs, agent } = modelSetup();
    agent.setConfigOption = async () => { assert.fail("unsupported model must not reach ACP"); };
    await assert.rejects(manager.setForSession("gemini-4-argon-high", "s1", agent), /unknown model/);
    assert.equal(prefs.s1, "gemini-4-argon-high");
  });

  it("persists only after ACP succeeds and leaves other sessions alone", async () => {
    const { manager, prefs, agent } = modelSetup();
    const result = await manager.setForSession("gemini-4-argon-medium", "s1", agent);
    assert.equal(result.uid, "gemini-4-argon-medium");
    assert.deepEqual(prefs, { s1: "gemini-4-argon-medium", s2: "swe-2-high" });
  });

  it("does not persist when ACP rejects the request", async () => {
    const { manager, prefs, agent } = modelSetup();
    agent.setConfigOption = async () => { throw new Error("Invalid params"); };
    await assert.rejects(manager.setForSession("gemini-4-argon-medium", "s1", agent), /Invalid params/);
    assert.equal(prefs.s1, "gemini-4-argon-high");
  });

  it("does not report success when the acknowledged current value is unchanged", async () => {
    const { manager, prefs, agent } = modelSetup();
    agent.setConfigOption = async () => {};
    await assert.rejects(manager.setForSession("gemini-4-argon-medium", "s1", agent), /not applied/);
    assert.equal(prefs.s1, "gemini-4-argon-high");
  });

  it("accepts a model supplied only by the session", async () => {
    const { manager, prefs, agent } = modelSetup();
    await manager.setForSession("agent-only", "s1", agent);
    assert.equal(prefs.s1, "agent-only");
  });

  it("does not allow a different backend's catalog as fallback", async () => {
    const { manager, prefs, agent } = modelSetup();
    const noOptionsAgent = { ...agent, getConfigOptions: () => null };
    await assert.rejects(manager.setForSession("swe-2-high", "s1", noOptionsAgent, "claude"), /unknown model/);
    assert.equal(prefs.s1, "gemini-4-argon-high");
  });
});

describe("parseConfigOptionsModels", () => {
  it("id === \"model\" 即可识别，无需 category", () => {
    const models = parseConfigOptionsModels(
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "a",
          options: [{ value: "a", name: "Model A" }],
        },
      ],
      "devin",
    );
    assert.equal(models.length, 1);
    assert.equal(models[0]!.uid, "a");
    assert.equal(models[0]!.label, "Model A");
    assert.equal(models[0]!.family, "devin");
    assert.equal(models[0]!.backend, "devin");
  });

  it("category === \"model\" 也可识别", () => {
    const models = parseConfigOptionsModels(
      [
        {
          id: "llm",
          category: "model",
          options: [{ value: "b", name: "Model B", description: "$1/1M" }],
        },
      ],
      "claude",
    );
    assert.equal(models.length, 1);
    assert.equal(models[0]!.uid, "b");
    assert.equal(models[0]!.costSummary, "$1/1M");
    assert.equal(models[0]!.costTier, "unknown");
  });

  it("支持分组 options，family 取 group.name", () => {
    const models = parseConfigOptionsModels(
      [
        {
          id: "model",
          options: [
            {
              group: "g1",
              name: "Anthropic",
              options: [
                { value: "opus", name: "Opus" },
                { value: "sonnet", name: "Sonnet", _meta: { costTier: "paid" } },
              ],
            },
            { group: "g2", options: [{ value: "solo", name: "Solo" }] },
          ],
        },
      ],
      "devin",
    );
    assert.equal(models.length, 3);
    assert.equal(models[0]!.family, "Anthropic");
    assert.equal(models[1]!.family, "Anthropic");
    assert.equal(models[1]!.costTier, "paid");
    assert.equal(models[2]!.family, "devin");
  });

  it("按 uid 去重", () => {
    const models = parseConfigOptionsModels(
      [
        {
          id: "model",
          options: [
            { value: "x", name: "X" },
            { value: "x", name: "X again" },
            { value: "y", name: "Y" },
          ],
        },
      ],
      "devin",
    );
    assert.equal(models.length, 2);
    assert.equal(models[0]!.label, "X");
  });

  it("非 model 选项被忽略", () => {
    const models = parseConfigOptionsModels(
      [
        { id: "mode", category: "mode", options: [{ value: "m", name: "M" }] },
        { id: "thought", options: [{ value: "t", name: "T" }] },
      ],
      "devin",
    );
    assert.equal(models.length, 0);
  });
});
