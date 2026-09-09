import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  newIncidentId,
  incidentFingerprint,
  isValidIncidentStatus,
  canTransitionIncidentStatus,
  createIncident,
} from "./incident.js";

describe("incident helpers (Q3-01)", () => {
  it("newIncidentId 以 inc- 前缀", () => {
    const id = newIncidentId();
    assert.match(id, /^inc-[0-9a-f]{12}$/);
  });

  it("incidentFingerprint 同输入产生同指纹，不同 description 产生不同指纹", () => {
    const fp1 = incidentFingerprint("p1", "desc");
    const fp2 = incidentFingerprint("p1", "desc");
    const fp3 = incidentFingerprint("p1", "other");
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fp3);
    assert.equal(fp1.length, 16);
  });

  it("incidentFingerprint 不含 sourceRunId，跨 run 稳定", () => {
    const fp1 = incidentFingerprint("p1", "desc");
    const fp2 = incidentFingerprint("p1", "desc");
    assert.equal(fp1, fp2);
  });

  it("isValidIncidentStatus", () => {
    assert.equal(isValidIncidentStatus("open"), true);
    assert.equal(isValidIncidentStatus("covered"), true);
    assert.equal(isValidIncidentStatus("accepted-risk"), true);
    assert.equal(isValidIncidentStatus("closed"), false);
  });

  it("canTransitionIncidentStatus: open → covered/accepted-risk", () => {
    assert.equal(canTransitionIncidentStatus("open", "covered"), true);
    assert.equal(canTransitionIncidentStatus("open", "accepted-risk"), true);
    assert.equal(canTransitionIncidentStatus("open", "open"), true);
  });

  it("canTransitionIncidentStatus: covered → open/accepted-risk", () => {
    assert.equal(canTransitionIncidentStatus("covered", "open"), true);
    assert.equal(canTransitionIncidentStatus("covered", "accepted-risk"), true);
  });

  it("canTransitionIncidentStatus: accepted-risk → open", () => {
    assert.equal(canTransitionIncidentStatus("accepted-risk", "open"), true);
    assert.equal(canTransitionIncidentStatus("accepted-risk", "covered"), false);
  });

  it("createIncident 生成完整对象", () => {
    const inc = createIncident({
      projectId: "p1",
      description: "内存泄漏",
      severity: "major",
      sourceRunId: "run-1",
      reproduction: "运行 1000 次",
    });
    assert.equal(inc.projectId, "p1");
    assert.equal(inc.description, "内存泄漏");
    assert.equal(inc.severity, "major");
    assert.equal(inc.sourceRunId, "run-1");
    assert.equal(inc.status, "open");
    assert.ok(inc.fingerprint.length > 0);
    assert.match(inc.id, /^inc-/);
  });

  it("createIncident 无可选字段时不含 undefined", () => {
    const inc = createIncident({
      projectId: "p1",
      description: "x",
      severity: "low",
    });
    assert.equal(inc.sourceRunId, undefined);
    assert.equal("sourceRunId" in inc, false);
    assert.equal("reproduction" in inc, false);
    assert.equal("regressionTest" in inc, false);
  });

  it("createIncident 支持自定义 fingerprint", () => {
    const inc = createIncident({
      projectId: "p1",
      description: "x",
      severity: "low",
      fingerprint: "custom-fp",
    });
    assert.equal(inc.fingerprint, "custom-fp");
  });
});
