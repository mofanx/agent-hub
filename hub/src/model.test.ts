import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfigOptionsModels } from "./model.js";

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
