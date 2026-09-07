import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../store.js";
import { QualityService } from "./service.js";
import { incidentFingerprint, autoPromoteRuleText, AUTO_PROMOTE_THRESHOLD } from "./incident.js";
import { ruleFingerprint } from "./rule.js";
import type { ProjectScope, RuleCandidate } from "./types.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "incident-promote-"));
}

function makeProject(root: string): ProjectScope {
  return {
    id: "p-promote",
    connectionId: "conn-1",
    root,
    gitRoot: undefined,
    displayName: "test",
    capabilities: { git: false, localExec: true, remoteExec: false, isolatedWorktree: false },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("incident auto-promote (P4)", () => {
  let dir: string;
  let store: Store;
  let service: QualityService;
  let project: ProjectScope;

  beforeEach(() => {
    dir = makeTempDir();
    store = new Store(path.join(dir, "test.db"));
    service = new QualityService(store, () => {});
    project = makeProject(dir);
    store.upsertQualityProject(project);
  });

  describe("AUTO_PROMOTE_THRESHOLD", () => {
    it("阈值为 3", () => {
      assert.equal(AUTO_PROMOTE_THRESHOLD, 3);
    });
  });

  describe("autoPromoteRuleText", () => {
    it("从 description 生成规则文本", () => {
      assert.equal(autoPromoteRuleText("null pointer in foo"), "auto: null pointer in foo");
    });
  });

  describe("createIncident 自动沉淀", () => {
    it("复发 < 3 次不自动沉淀", () => {
      service.createIncident({ projectId: project.id, description: "bug A", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug A", severity: "major" });
      const rules = service.listRules(project.id);
      assert.equal(rules.length, 0);
    });

    it("复发 = 3 次自动生成 rule candidate", () => {
      const inc1 = service.createIncident({ projectId: project.id, description: "bug B", severity: "major" });
      const inc2 = service.createIncident({ projectId: project.id, description: "bug B", severity: "major" });
      const inc3 = service.createIncident({ projectId: project.id, description: "bug B", severity: "major" });

      const rules = service.listRules(project.id);
      assert.equal(rules.length, 1);
      const rule = rules[0]!;
      assert.equal(rule.status, "candidate");
      assert.equal(rule.recurrence, 3);
      assert.ok(rule.evidenceIncidentIds.includes(inc1.id));
      assert.ok(rule.evidenceIncidentIds.includes(inc2.id));
      assert.ok(rule.evidenceIncidentIds.includes(inc3.id));
      assert.equal(rule.rule, autoPromoteRuleText("bug B"));
    });

    it("第 4 次复发追加 evidence 而非创建新 candidate", () => {
      service.createIncident({ projectId: project.id, description: "bug C", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug C", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug C", severity: "major" });
      const rulesAfter3 = service.listRules(project.id);
      assert.equal(rulesAfter3.length, 1);

      const inc4 = service.createIncident({ projectId: project.id, description: "bug C", severity: "major" });
      const rulesAfter4 = service.listRules(project.id);
      assert.equal(rulesAfter4.length, 1);
      assert.equal(rulesAfter4[0]!.recurrence, 4);
      assert.ok(rulesAfter4[0]!.evidenceIncidentIds.includes(inc4.id));
    });

    it("不同 fingerprint 的 incident 不互相影响", () => {
      service.createIncident({ projectId: project.id, description: "bug X", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug X", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug Y", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug Y", severity: "major" });

      const rules = service.listRules(project.id);
      assert.equal(rules.length, 0);
    });

    it("自动生成的 candidate 不自动激活（status=candidate）", () => {
      service.createIncident({ projectId: project.id, description: "bug D", severity: "critical" });
      service.createIncident({ projectId: project.id, description: "bug D", severity: "critical" });
      service.createIncident({ projectId: project.id, description: "bug D", severity: "critical" });

      const rules = service.listRules(project.id);
      assert.equal(rules[0]!.status, "candidate");
    });

    it("sourceRunId 不同但 description 相同 → 不同 fingerprint", () => {
      // incidentFingerprint 包含 sourceRunId，所以不同 run 的同描述是不同 fingerprint
      service.createIncident({ projectId: project.id, description: "bug E", severity: "major", sourceRunId: "r1" });
      service.createIncident({ projectId: project.id, description: "bug E", severity: "major", sourceRunId: "r2" });
      service.createIncident({ projectId: project.id, description: "bug E", severity: "major", sourceRunId: "r3" });

      const rules = service.listRules(project.id);
      // 3 个不同 fingerprint，各只有 1 条，不触发自动沉淀
      assert.equal(rules.length, 0);
    });

    it("自动沉淀的 candidate fingerprint = ruleFingerprint(projectId, autoPromoteRuleText(desc))", () => {
      service.createIncident({ projectId: project.id, description: "bug F", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug F", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug F", severity: "major" });

      const rule = service.listRules(project.id)[0]!;
      const expectedFp = ruleFingerprint(project.id, autoPromoteRuleText("bug F"));
      assert.equal(rule.fingerprint, expectedFp);
    });

    it("measuredImpact 包含复发次数和 severity", () => {
      service.createIncident({ projectId: project.id, description: "bug G", severity: "critical" });
      service.createIncident({ projectId: project.id, description: "bug G", severity: "critical" });
      service.createIncident({ projectId: project.id, description: "bug G", severity: "critical" });

      const rule = service.listRules(project.id)[0]!;
      assert.ok(rule.measuredImpact !== undefined);
      assert.ok(rule.measuredImpact!.includes("3"));
      assert.ok(rule.measuredImpact!.includes("critical"));
    });
  });

  describe("promoteIncidentToRule 手动沉淀", () => {
    it("手动沉淀关联所有同 fingerprint 的 incident", () => {
      const inc1 = service.createIncident({ projectId: project.id, description: "bug H", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug H", severity: "major" });
      const inc3 = service.createIncident({ projectId: project.id, description: "bug H", severity: "major" });

      const rule = service.promoteIncidentToRule(inc1.id, "manual rule for H");
      assert.equal(rule.evidenceIncidentIds.length, 3);
      assert.ok(rule.evidenceIncidentIds.includes(inc1.id));
      assert.ok(rule.evidenceIncidentIds.includes(inc3.id));
      assert.equal(rule.recurrence, 3);
    });

    it("手动沉淀后再次 promote 同 rule → 追加 evidence", () => {
      const inc1 = service.createIncident({ projectId: project.id, description: "bug I", severity: "major" });
      const inc2 = service.createIncident({ projectId: project.id, description: "bug I", severity: "major" });

      const rule1 = service.promoteIncidentToRule(inc1.id, "rule for I");
      assert.equal(rule1.evidenceIncidentIds.length, 2);

      const rule2 = service.promoteIncidentToRule(inc2.id, "rule for I");
      assert.equal(rule2.evidenceIncidentIds.length, 2); // 已包含全部，不重复
      assert.equal(rule2.id, rule1.id);
    });

    it("不存在的 incident 抛错", () => {
      assert.throws(
        () => service.promoteIncidentToRule("nonexistent", "rule"),
        /unknown incident/,
      );
    });

    it("手动沉淀的 rule 与自动沉淀的 rule 不冲突（不同 rule text → 不同 fingerprint）", () => {
      // 先手动沉淀
      const inc1 = service.createIncident({ projectId: project.id, description: "bug J", severity: "major" });
      const manualRule = service.promoteIncidentToRule(inc1.id, "manual rule J");
      // 再触发自动沉淀（达到 3 次）
      service.createIncident({ projectId: project.id, description: "bug J", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug J", severity: "major" });

      const rules = service.listRules(project.id);
      // 手动 rule + 自动 rule = 2
      assert.equal(rules.length, 2);
      const autoRule = rules.find((r) => r.id !== manualRule.id)!;
      assert.equal(autoRule.rule, autoPromoteRuleText("bug J"));
      assert.equal(autoRule.recurrence, 3);
    });
  });

  describe("Store.listQualityIncidentsByFingerprint", () => {
    it("按 project + fingerprint 查询", () => {
      const inc1 = service.createIncident({ projectId: project.id, description: "bug K", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug L", severity: "major" });

      const fp = incidentFingerprint(project.id, "bug K");
      const same = store.listQualityIncidentsByFingerprint(project.id, fp);
      assert.equal(same.length, 1);
      assert.equal(same[0]!.id, inc1.id);
    });

    it("不存在的 fingerprint 返回空数组", () => {
      const result = store.listQualityIncidentsByFingerprint(project.id, "nonexistent");
      assert.equal(result.length, 0);
    });
  });

  describe("自动沉淀后 rule candidate 生命周期", () => {
    it("自动沉淀的 candidate 可被 approve → active", () => {
      service.createIncident({ projectId: project.id, description: "bug M", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug M", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug M", severity: "major" });

      const rule = service.listRules(project.id)[0]!;
      assert.equal(rule.status, "candidate");

      const approved = service.resolveRule(rule.id, "approved");
      assert.equal(approved.status, "approved");

      const active = service.resolveRule(rule.id, "active");
      assert.equal(active.status, "active");
    });

    it("自动沉淀的 candidate 可被 reject", () => {
      service.createIncident({ projectId: project.id, description: "bug N", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug N", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug N", severity: "major" });

      const rule = service.listRules(project.id)[0]!;
      const rejected = service.resolveRule(rule.id, "rejected");
      assert.equal(rejected.status, "rejected");
    });
  });

  describe("跨项目隔离", () => {
    it("不同项目的同 description 不互相触发自动沉淀", () => {
      const project2: ProjectScope = {
        ...project,
        id: "p-promote-2",
        root: path.join(dir, "p2"),
      };
      store.upsertQualityProject(project2);

      service.createIncident({ projectId: project.id, description: "bug O", severity: "major" });
      service.createIncident({ projectId: project2.id, description: "bug O", severity: "major" });
      service.createIncident({ projectId: project.id, description: "bug O", severity: "major" });

      // project 1 有 2 条，project 2 有 1 条，都不够 3
      assert.equal(service.listRules(project.id).length, 0);
      assert.equal(service.listRules(project2.id).length, 0);

      // project 1 再加 1 条 → 3 条 → 自动沉淀
      service.createIncident({ projectId: project.id, description: "bug O", severity: "major" });
      assert.equal(service.listRules(project.id).length, 1);
      assert.equal(service.listRules(project2.id).length, 0);
    });
  });
});
