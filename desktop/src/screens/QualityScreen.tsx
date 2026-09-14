import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FlaskConical, Play, RefreshCw, ShieldCheck, X, XCircle, FileText } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { QualityRun, QualityCheck, QualityFinding, QualityStage, QualityIncident, QualityRule, QualityPolicyInfo, QualityPolicyV2, RequirementVerification, ReviewConfigV2, ReviewTier, ReviewTriggerConfig, QualityRisk } from "../hub/types";
import { STAGE_LABELS, TERMINAL_STAGES as TERMINAL, qualityStageLabel } from "../hub/quality-labels";

function policyAutonomy(policy: QualityPolicyInfo["policy"]): string {
  if (policy.version === 2) {
    const e = policy.enforcement.mode;
    const r = policy.remediation.mode;
    if (e === "report" && r === "off") return "observe";
    if (e === "require-approval" && r === "propose") return "propose";
    if (e === "require-pass" && r === "isolated-fix") return "isolated-fix";
    if (e === "require-pass" && r === "apply-low-risk") return "apply-low-risk";
    return "observe";
  }
  return policy.autonomy;
}

const OUTCOME_LABELS: Record<string, string> = {
  verified: "已验证",
  failed: "未通过",
  inconclusive: "无法判定",
  waived: "已豁免",
};

function stageColor(stage: QualityStage): string {
  if (stage === "accepted") return "var(--success)";
  if (stage === "failed" || stage === "quarantined") return "var(--danger, #e53e3e)";
  if (stage === "cancelled" || stage === "stale") return "var(--text-dim)";
  if (stage === "inconclusive" || stage === "waived") return "var(--warn)";
  if (stage === "awaiting-approval" || stage === "reviewed") return "var(--warn)";
  return "var(--accent)";
}

function checkColor(status: QualityCheck["status"]): string {
  if (status === "passed") return "var(--success)";
  if (status === "failed" || status === "timeout" || status === "infra-failed") return "var(--danger, #e53e3e)";
  if (status === "cancelled") return "var(--text-dim)";
  return "var(--warn)";
}

function severityColor(sev: QualityFinding["severity"]): string {
  if (sev === "critical") return "var(--danger, #e53e3e)";
  if (sev === "major") return "var(--warn)";
  return "var(--text-dim)";
}

function fmt(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

export function QualityScreen() {
  const store = useHubStore();
  const [runFilter, setRunFilter] = useState<"all" | "active" | "approval" | "reviewed" | "accepted" | "failed">("all");
  const run = store.qualityRuns.find((r) => r.id === store.qualityRunId) ?? null;

  useEffect(() => {
    void store.loadQualityProjects();
    void store.loadQualityRuns(store.qualityProjectId ?? undefined);
  }, []);

  // 从聊天跳转时自动加载 run 详情
  useEffect(() => {
    if (store.qualityRunId) {
      void store.loadQualityRun(store.qualityRunId);
    }
  }, [store.qualityRunId]);

  const filteredRuns = store.qualityRuns.filter((r) => {
    if (runFilter === "all") return true;
    if (runFilter === "active") return !TERMINAL.has(r.stage);
    if (runFilter === "approval") return r.stage === "awaiting-approval";
    if (runFilter === "reviewed") return r.stage === "reviewed";
    if (runFilter === "accepted") return r.stage === "accepted";
    if (runFilter === "failed") return r.stage === "failed" || r.stage === "inconclusive";
    return true;
  });

  return (
    <div className="settings-screen">
      <nav className="settings-nav">
        <div className="nav-heading"><ShieldCheck size={15} style={{ marginRight: 6, verticalAlign: -2 }} />质量</div>
        <span className="spacer" />
        <button className="icon-btn" title="刷新" onClick={() => void store.openQuality()}>
          <RefreshCw size={15} />
        </button>
        <button onClick={() => useHubStore.setState({ screen: "sessions" })}>
          <X size={15} /> 返回
        </button>
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          <ContextBar />
          {store.qualityError && (
            <div className="card" style={{ borderColor: "var(--danger, #e53e3e)", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={15} style={{ color: "var(--danger, #e53e3e)", flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13, color: "var(--danger, #e53e3e)" }}>{store.qualityError}</span>
                <button className="icon-btn" title="清除" onClick={() => store.clearQualityError()}>
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <FlaskConical size={16} />
              <strong style={{ flex: 1 }}>项目</strong>
            </div>
            {store.qualityProjects.length === 0 ? (
              <p style={{ color: "var(--text-dim)", margin: 0 }}>暂无已注册的质量项目。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {store.qualityProjects.map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                    <button
                      className={store.qualityProjectId === p.id ? "" : "secondary"}
                      onClick={() => void store.selectQualityProject(p.id)}
                      title={p.root}
                    >
                      {p.displayName || p.root}
                    </button>
                    <button
                      className="icon-btn"
                      title="删除项目及所有关联数据"
                      onClick={() => {
                        if (confirm(`确认删除项目「${p.displayName || p.root}」及其所有运行记录？此操作不可撤销。`)) {
                          void store.deleteQualityProject(p.id);
                        }
                      }}
                    >
                      <X size={12} />
                    </button>
                    <code style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 4, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.root}
                    </code>
                  </div>
                ))}
              </div>
            )}
            {store.qualityPolicy && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
                策略：{store.qualityPolicy.source === "file" ? ".devin/quality.json" : "默认（未配置）"}
                {" · "}autonomy={policyAutonomy(store.qualityPolicy.policy)}
                {" · "}checks={store.qualityPolicy.policy.checks.length}
                {" · "}protectedPaths={store.qualityPolicy.policy.protectedPaths.length}
                {store.qualityPolicy.source === "default" && store.qualityProjectId && (
                  <div style={{ marginTop: 6 }}>
                    <button onClick={() => void store.ensureQualityPolicy(store.qualityProjectId!)}>
                      <FileText size={14} /> 初始化质量策略
                    </button>
                  </div>
                )}
                {store.qualityPolicy.errors.length > 0 && (
                  <div style={{ color: "var(--danger, #e53e3e)" }}>
                    {store.qualityPolicy.errors.map((e) => (
                      <div key={e}>⚠ {e}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {store.qualityPolicy && store.qualityPolicy.version === 2 && (
              <ReviewTierConfigForm
                projectId={store.qualityProjectId!}
                review={(store.qualityPolicy.policy as QualityPolicyV2).review}
                onSave={async (review) => {
                  const v2 = store.qualityPolicy!.policy as QualityPolicyV2;
                  await store.saveQualityPolicy(store.qualityProjectId!, { ...v2, review });
                }}
              />
            )}
            {store.qualityPolicy && store.qualityPolicy.version === 2 && (
              <RequirementsConfigForm
                policy={store.qualityPolicy.policy as QualityPolicyV2}
                onSave={async (v2) => {
                  await store.saveQualityPolicy(store.qualityProjectId!, v2);
                }}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {/* 左栏：run 列表 */}
            <div className="card" style={{ width: 280, flexShrink: 0, maxHeight: "70vh", overflowY: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong style={{ flex: 1 }}>运行记录</strong>
                {store.qualityProjectId && (
                  <button className="icon-btn" title="发起质量运行" onClick={() => void store.startQualityRun(store.qualityProjectId!)}>
                    <Play size={14} />
                  </button>
                )}
              </div>
              {/* 阶段筛选 */}
              <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                {([
                  ["all", "全部"],
                  ["active", "进行中"],
                  ["approval", "待审批"],
                  ["reviewed", "待处理"],
                  ["accepted", "已通过"],
                  ["failed", "未通过"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    className={runFilter === key ? "" : "secondary"}
                    style={{ fontSize: 11, padding: "2px 6px" }}
                    onClick={() => setRunFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {filteredRuns.length === 0 ? (
                <p style={{ color: "var(--text-dim)", margin: 0, fontSize: 12 }}>无匹配的运行记录。</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {filteredRuns.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      selected={r.id === store.qualityRunId}
                      onClick={() => void store.loadQualityRun(r.id)}
                      onDelete={() => {
                        if (confirm(`确认删除运行 ${r.id}？此操作不可撤销。`)) {
                          void store.deleteQualityRun(r.id);
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 右栏：run 详情 */}
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              {run ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ flex: 1 }}>
                      运行详情 <code style={{ fontSize: 12 }}>{run.id}</code>
                    </strong>
                    <span style={{ color: stageColor(run.stage), fontSize: 12 }}>
                      {STAGE_LABELS[run.stage] ?? run.stage}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}>
                    <div>风险：{run.risk} · 触发：{run.trigger} · 修复轮次：{run.fixRound}/{run.budget.maxFixRounds}</div>
                    <div>判定：{run.verdict ?? "—"}{run.failureCode ? ` · ${run.failureCode}` : ""}{run.outcome ? ` · 结果：${OUTCOME_LABELS[run.outcome] ?? run.outcome}` : ""}</div>
                    <div>创建：{fmt(run.createdAt)} · 更新：{fmt(run.updatedAt)}{run.completedAt ? ` · 完成：${fmt(run.completedAt)}` : ""}</div>
                    {run.workItemId && <div>WorkItem：<code style={{ fontSize: 11 }}>{run.workItemId}</code>{run.generation ? ` · 第 ${run.generation} 代` : ""}</div>}
                    {run.patchHash && <div>patchHash：<code style={{ fontSize: 11 }}>{run.patchHash}</code></div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    {run.stage === "awaiting-approval" && (
                      <>
                        <button onClick={() => void store.qualityRunAction(run.id, "approve")}>
                          <CheckCircle2 size={14} /> 批准
                        </button>
                        <button className="secondary" onClick={() => void store.qualityRunAction(run.id, "reject")}>
                          <XCircle size={14} /> 拒绝
                        </button>
                      </>
                    )}
                    {run.stage === "reviewed" && (
                      <>
                        <button onClick={() => void store.advanceQualityRun(run.id, "full-verifying")}>
                          <CheckCircle2 size={14} /> 继续验证
                        </button>
                        <button onClick={() => void store.advanceQualityRun(run.id, "fixing")}>
                          <Play size={14} /> 开始修复
                        </button>
                        <button className="secondary" onClick={() => void store.advanceQualityRun(run.id, "cancelled")}>
                          <XCircle size={14} /> 取消
                        </button>
                      </>
                    )}
                    {!TERMINAL.has(run.stage) && run.stage !== "reviewed" && (
                      <button className="secondary" onClick={() => void store.qualityRunAction(run.id, "cancel")}>
                        取消
                      </button>
                    )}
                    {TERMINAL.has(run.stage) && run.stage !== "accepted" && (
                      <button className="secondary" title="仅重新执行质量检查，不会重新派发 AI 实现" onClick={() => void store.qualityRunAction(run.id, "retry")}>
                        重跑检查
                      </button>
                    )}
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <strong style={{ fontSize: 13 }}>检查（{store.qualityChecks.length}）</strong>
                    {store.qualityChecks.length === 0 ? (
                      <p style={{ color: "var(--text-dim)", fontSize: 12 }}>暂无检查记录。</p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        {store.qualityChecks.map((c) => (
                          <CheckCard key={c.id} check={c} />
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <strong style={{ fontSize: 13 }}>审查发现（{store.qualityFindings.length}）</strong>
                    {store.qualityFindings.length === 0 ? (
                      <p style={{ color: "var(--text-dim)", fontSize: 12 }}>暂无审查发现。</p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                        {store.qualityFindings.map((f) => (
                          <FindingCard key={f.id} finding={f} />
                        ))}
                      </div>
                    )}
                  </div>

                  {store.qualityVerifications.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <strong style={{ fontSize: 13 }}>L3 需求验证（{store.qualityVerifications.length}）</strong>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                        {store.qualityVerifications.map((v) => (
                          <VerificationRow key={v.id} v={v} />
                        ))}
                      </div>
                    </div>
                  )}

                  <AcceptanceCriteriaPanel />
                </>
              ) : (
                <p style={{ color: "var(--text-dim)", margin: 0, textAlign: "center", padding: "40px 0" }}>
                  选择左侧的运行查看详情
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ flex: 1 }}>Incident 列表</strong>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{store.qualityIncidents.length}</span>
            </div>
            {store.qualityIncidents.length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: 12, margin: 0 }}>暂无 incident。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
                {store.qualityIncidents.map((i) => (
                  <IncidentCard key={i.id} incident={i} />
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ flex: 1 }}>规则候选</strong>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{store.qualityRules.length}</span>
            </div>
            {store.qualityRules.length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: 12, margin: 0 }}>暂无规则候选。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
                {store.qualityRules.map((r) => (
                  <RuleCard key={r.id} rule={r} />
                ))}
              </div>
            )}
          </div>

          {store.qualityWorkItems.length > 0 && (
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong style={{ flex: 1 }}>WorkItem</strong>
                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{store.qualityWorkItems.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 300, overflowY: "auto" }}>
                {store.qualityWorkItems.map((w) => (
                  <div key={w.id} style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <code style={{ fontSize: 11 }}>{w.id}</code>
                      <span style={{ flex: 1 }}>{w.kind}</span>
                      <span style={{ color: "var(--text-dim)" }}>{w.status}</span>
                      <span style={{ color: "var(--text-dim)" }}>第 {w.currentGeneration} 代</span>
                    </div>
                    {w.currentRunId && (
                      <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
                        当前 run：<code style={{ fontSize: 11 }}>{w.currentRunId}</code>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ContextBar() {
  const store = useHubStore();
  const session = store.currentSession;
  const room = store.currentRoom;
  const sq = store.sessionQuality;
  const verifyingTasks = store.flow?.tasks.filter((t) => t.status === "verifying") ?? [];
  if (!session && !room) return null;
  return (
    <div className="card" style={{ marginBottom: 8, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ShieldCheck size={14} />
        <strong style={{ flex: 1 }}>
          {session ? `当前会话：${session.name || session.sessionId}` : `当前群聊：${room?.name ?? room?.roomId}`}
        </strong>
        <button className="secondary" onClick={() => useHubStore.setState({ screen: session ? "chat" : "room" })}>
          返回
        </button>
      </div>
      {session && sq && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          最新质量运行：{qualityStageLabel(sq.stage)} · L1 {sq.passedChecks}/{sq.passedChecks + sq.failedChecks}
          {sq.failureCode && ` · ${sq.failureCode}`}
          <button className="tiny" style={{ marginLeft: 8 }} onClick={() => void store.loadQualityRun(sq.runId)}>
            查看完整证据
          </button>
        </div>
      )}
      {room && verifyingTasks.length > 0 && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          正在验证：{verifyingTasks.map((t) => t.name).join(", ")}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, selected, onClick, onDelete }: { run: QualityRun; selected: boolean; onClick: () => void; onDelete: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        background: selected ? "var(--surface-hover, rgba(128,128,128,0.12))" : "transparent",
        border: "1px solid var(--border)",
        fontSize: 13,
      }}
    >
      <span style={{ color: stageColor(run.stage), flexShrink: 0 }}>{STAGE_LABELS[run.stage] ?? run.stage}</span>
      <code style={{ fontSize: 12, color: "var(--text-dim)" }}>{run.id}</code>
      <span style={{ flex: 1 }} />
      <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{run.risk}</span>
      <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{fmt(run.createdAt)}</span>
      <button
        className="icon-btn"
        title="删除此运行记录"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        <X size={12} />
      </button>
      <ChevronRight size={13} style={{ color: "var(--text-dim)" }} />
    </div>
  );
}

function CheckCard({ check: c }: { check: QualityCheck }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(c.summary || c.stdoutArtifact || c.stderrArtifact);
  return (
    <div
      style={{
        padding: "6px 8px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", cursor: hasDetail ? "pointer" : "default" }}
        onClick={() => hasDetail && setOpen(!open)}
      >
        <span style={{ color: checkColor(c.status) }}>{c.status}</span>
        <code style={{ flex: 1 }}>{c.checkId}</code>
        <span style={{ color: "var(--text-dim)" }}>
          第{c.attempt}次
          {c.exitCode !== undefined ? ` · exit=${c.exitCode}` : ""}
          {c.durationMs !== undefined ? ` · ${(c.durationMs / 1000).toFixed(1)}s` : ""}
        </span>
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </div>
      {open && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          {c.summary && <div>{c.summary}</div>}
          {c.stdoutArtifact && (
            <div>
              stdout：<code style={{ fontSize: 11 }}>{c.stdoutArtifact}</code>
            </div>
          )}
          {c.stderrArtifact && (
            <div>
              stderr：<code style={{ fontSize: 11 }}>{c.stderrArtifact}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FINDING_ACTIONS: { key: QualityFinding["status"]; label: string }[] = [
  { key: "fixed", label: "标记已修复" },
  { key: "dismissed", label: "忽略" },
  { key: "accepted-risk", label: "接受风险" },
];

const VERIF_STATUS_ICON: Record<RequirementVerification["status"], string> = {
  passed: "✓",
  failed: "✗",
  inconclusive: "⚠",
  waived: "—",
};

function VerificationRow({ v }: { v: RequirementVerification }) {
  const color = v.status === "passed" ? "var(--success)" : v.status === "failed" ? "var(--danger, #e53e3e)" : "var(--warn)";
  return (
    <div style={{ padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ color, fontWeight: 600, flexShrink: 0 }}>{VERIF_STATUS_ICON[v.status]}</span>
      <code style={{ fontSize: 11 }}>{v.criterionId}</code>
      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{v.method}</span>
      {v.confidence !== undefined && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>置信度 {Math.round(v.confidence * 100)}%</span>}
      {v.waiverReason && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>豁免原因：{v.waiverReason}</span>}
      {v.evidenceRefs.length > 0 && (
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>证据：{v.evidenceRefs.join(", ")}</span>
      )}
    </div>
  );
}

function AcceptanceCriteriaPanel() {
  const store = useHubStore();
  const firstSpecId = store.qualityVerifications.find((v) => v.specId)?.specId ?? "";
  useEffect(() => {
    if (firstSpecId) void store.loadRequirementSpec(firstSpecId);
  }, [firstSpecId]);
  const spec = store.currentSpec;
  if (!spec || spec.id !== firstSpecId) return null;
  const STATUS_LABEL: Record<string, string> = { draft: "草稿", clarifying: "澄清中", accepted: "已接受", superseded: "已废弃", cancelled: "已取消" };
  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <strong style={{ fontSize: 13 }}>验收标准（spec {spec.id.slice(0, 8)} v{spec.version}）</strong>
      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--text-dim)" }}>{STATUS_LABEL[spec.status] ?? spec.status}</span>
      <div style={{ marginTop: 6, fontSize: 12 }}>
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>目标</div>
        <div>{spec.goal || "（未设置）"}</div>
      </div>
      {spec.acceptanceCriteria.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>验收标准（{spec.acceptanceCriteria.length} 条）</div>
          <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 12 }}>
            {spec.acceptanceCriteria.map((c) => (
              <li key={c.id}>
                {c.required ? "★ " : "○ "}{c.description}
                <span style={{ color: "var(--text-dim)" }}> · {c.evidenceMode} · {c.expectedEvidence.length} 证据</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {spec.constraints.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>约束</div>
          <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 12 }}>
            {spec.constraints.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}
      {spec.risks.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "var(--text-dim)", fontSize: 11 }}>风险</div>
          <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 12 }}>
            {spec.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding: f }: { finding: QualityFinding }) {
  const store = useHubStore();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const hasDetail = !!(f.evidence || f.reproduction || f.suggestion);
  const onAction = (status: QualityFinding["status"], label: string) => {
    setNote(`${label} 处理中…`);
    void store.resolveQualityFinding(f.id, status, `by user: ${label}`).then(() => {
      setNote(`${label} 已生效`);
    });
  };
  return (
    <div
      style={{
        padding: "8px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      <div
        style={{ display: "flex", gap: 8, alignItems: "center", cursor: hasDetail ? "pointer" : "default" }}
        onClick={() => hasDetail && setOpen(!open)}
      >
        <span style={{ color: severityColor(f.severity), fontWeight: 600 }}>{f.severity}</span>
        <span style={{ flex: 1 }}>{f.claim}</span>
        {f.blocking && <span style={{ color: "var(--danger, #e53e3e)" }}>阻断</span>}
        <span style={{ color: "var(--text-dim)" }}>{f.status}</span>
        {hasDetail && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </div>
      {f.file && (
        <div style={{ color: "var(--text-dim)", marginTop: 4 }}>
          <code>{f.file}{f.line ? `:${f.line}` : ""}</code>
          <span style={{ marginLeft: 6 }}>置信度 {Math.round(f.confidence * 100)}%</span>
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          {f.evidence && <div>证据：{f.evidence}</div>}
          {f.reproduction && <div>复现：{f.reproduction}</div>}
          {f.suggestion && <div>建议：{f.suggestion}</div>}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {FINDING_ACTIONS.map((a) => (
              <button
                key={a.key}
                className="tiny secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction(a.key, a.label);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
          {note && <div style={{ marginTop: 4, color: "var(--warn)" }}>{note}</div>}
        </div>
      )}
    </div>
  );
}

function IncidentCard({ incident: i }: { incident: QualityIncident }) {
  const store = useHubStore();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <span style={{ color: severityColor(i.severity as QualityFinding["severity"]), fontWeight: 600 }}>{i.severity}</span>
        <span style={{ flex: 1 }}>{i.description}</span>
        <span style={{ color: "var(--text-dim)" }}>{i.status}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </div>
      {open && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          {i.sourceRunId && <div>来源 run：<code style={{ fontSize: 11 }}>{i.sourceRunId}</code></div>}
          {i.reproduction && <div>复现：{i.reproduction}</div>}
          {i.regressionTest && <div>回归测试：{i.regressionTest}</div>}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {i.status !== "covered" && (
              <button className="tiny secondary" onClick={() => void store.resolveQualityIncident(i.id, "covered")}>
                标记为已覆盖
              </button>
            )}
            {i.status !== "accepted-risk" && (
              <button className="tiny secondary" onClick={() => void store.resolveQualityIncident(i.id, "accepted-risk")}>
                接受风险
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RuleCard({ rule: r }: { rule: QualityRule }) {
  const store = useHubStore();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <span style={{ flex: 1 }}>{r.rule}</span>
        <span style={{ color: "var(--text-dim)" }}>{r.status}</span>
        <span style={{ color: "var(--text-dim)" }}>复发{r.recurrence}次</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </div>
      {open && (
        <div style={{ marginTop: 6, color: "var(--text-dim)" }}>
          <div>证据 incidents：<code style={{ fontSize: 11 }}>{r.evidenceIncidentIds.join(", ")}</code></div>
          {r.measuredImpact && <div>影响：{r.measuredImpact}</div>}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {r.status !== "approved" && (
              <button className="tiny secondary" onClick={() => void store.resolveQualityRule(r.id, "approved")}>
                批准
              </button>
            )}
            {r.status !== "active" && (
              <button className="tiny secondary" onClick={() => void store.resolveQualityRule(r.id, "active")}>
                激活
              </button>
            )}
            {r.status !== "rejected" && (
              <button className="tiny secondary" onClick={() => void store.resolveQualityRule(r.id, "rejected")}>
                拒绝
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// t1: 在最近修改的文件末尾追加此注释，标记子任务 t1 已完成
// t2: 在 t1 确定的文件末尾追加此注释，标记子任务 t2 已完成

const REVIEW_TIERS: ReviewTier[] = ["light", "standard", "deep"];
const RISKS: QualityRisk[] = ["low", "medium", "high", "critical"];
const TIER_LABELS: Record<ReviewTier, string> = { light: "轻量", standard: "标准", deep: "深度" };
const RISK_LABELS: Record<QualityRisk, string> = { low: "低", medium: "中", high: "高", critical: "关键" };

function ReviewTierConfigForm({
  review,
  onSave,
}: {
  projectId: string;
  review: ReviewConfigV2;
  onSave: (review: ReviewConfigV2) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ReviewConfigV2>(review);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const modelList = useHubStore((s) => s.modelList);
  const refreshModelList = useHubStore((s) => s.refreshModelList);

  useEffect(() => { setDraft(review); }, [review]);
  useEffect(() => { void refreshModelList(); }, [refreshModelList]);

  const updateTrigger = (patch: Partial<ReviewTriggerConfig>) =>
    setDraft((d) => ({ ...d, trigger: { ...d.trigger, ...patch } }));

  const updateTierMappingByRisk = (risk: QualityRisk, tier: ReviewTier) =>
    setDraft((d) => ({ ...d, tierMapping: { ...d.tierMapping, byRisk: { ...d.tierMapping.byRisk, [risk]: tier } } }));

  const inputStyle: React.CSSProperties = { padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg, #1e1e1e)", color: "var(--text)" };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginBottom: 2 };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <button className="secondary" style={{ fontSize: 12 }} onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Review Tier 配置
      </button>
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
          <div>
            <div style={labelStyle}>Review 模式</div>
            <select style={inputStyle} value={draft.mode} onChange={(e) => setDraft((d) => ({ ...d, mode: e.target.value as ReviewConfigV2["mode"] }))}>
              <option value="off">关闭</option>
              <option value="advisory">建议</option>
              <option value="blocking">阻塞</option>
            </select>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={labelStyle}>阻塞严重度</div>
              <select style={inputStyle} value={draft.blockSeverity} onChange={(e) => setDraft((d) => ({ ...d, blockSeverity: e.target.value as "critical" | "major" }))}>
                <option value="critical">critical</option>
                <option value="major">major</option>
              </select>
            </div>
            <div>
              <div style={labelStyle}>最小阻塞置信度 [0-1]</div>
              <input type="number" min={0} max={1} step={0.05} style={inputStyle} value={draft.minBlockingConfidence}
                onChange={(e) => setDraft((d) => ({ ...d, minBlockingConfidence: Number(e.target.value) }))} />
            </div>
          </div>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={labelStyle}>触发条件</legend>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={labelStyle}>最小 diff 行数</div>
                <input type="number" min={0} style={inputStyle} value={draft.trigger.minDiffLines}
                  onChange={(e) => updateTrigger({ minDiffLines: Number(e.target.value) })} />
              </div>
            </div>
            <div style={{ marginTop: 6 }}>
              <div style={labelStyle}>跳过模式（逗号分隔 glob）</div>
              <input style={{ ...inputStyle, width: "100%" }} value={draft.trigger.skipPatterns.join(", ")}
                onChange={(e) => updateTrigger({ skipPatterns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
            </div>
          </fieldset>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={labelStyle}>风险 → Tier 映射</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div>
                <div style={labelStyle}>默认 tier</div>
                <select style={inputStyle} value={draft.tierMapping.default}
                  onChange={(e) => setDraft((d) => ({ ...d, tierMapping: { ...d.tierMapping, default: e.target.value as ReviewTier } }))}>
                  {REVIEW_TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                </select>
              </div>
              {RISKS.map((r) => (
                <div key={r}>
                  <div style={labelStyle}>{RISK_LABELS[r]}</div>
                  <select style={inputStyle} value={draft.tierMapping.byRisk[r] ?? ""}
                    onChange={(e) => updateTierMappingByRisk(r, e.target.value as ReviewTier)}>
                    <option value="">（继承默认）</option>
                    {REVIEW_TIERS.map((t) => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </fieldset>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={labelStyle}>Reviewer 模型（留空用 agent 默认）</div>
              <select style={inputStyle} value={draft.model}
                onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}>
                <option value="">（继承默认）</option>
                {modelList.map((m) => (
                  <option key={m.uid} value={m.uid}>{m.label}（{m.backend}）</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <button
              disabled={saving || JSON.stringify(draft) === JSON.stringify(review)}
              onClick={async () => {
                setSaving(true);
                try { await onSave(draft); } finally { setSaving(false); }
              }}
            >
              {saving ? "保存中..." : "保存 Review 配置"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RequirementsConfigForm({
  policy,
  onSave,
}: {
  policy: QualityPolicyV2;
  onSave: (policy: QualityPolicyV2) => Promise<void>;
}) {
  const store = useHubStore();
  const [draft, setDraft] = useState<QualityPolicyV2>(policy);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [specRequestId, setSpecRequestId] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");

  useEffect(() => { setDraft(policy); }, [policy]);

  const inputStyle: React.CSSProperties = { padding: "4px 6px", fontSize: 12, borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg, #1e1e1e)", color: "var(--text)" };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginBottom: 2 };
  const dirty = JSON.stringify(draft) !== JSON.stringify(policy);

  const loadSpecs = async () => {
    if (!specRequestId.trim()) return;
    await store.listRequirementSpecs(specRequestId.trim());
  };

  const currentSpec = store.currentSpec;
  const STATUS_LABEL: Record<string, string> = { draft: "草稿", clarifying: "澄清中", accepted: "已接受", superseded: "已废弃", cancelled: "已取消" };

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
      <button className="secondary" style={{ fontSize: 12 }} onClick={() => setExpanded((v) => !v)}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 需求与验收配置
      </button>
      {expanded && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={labelStyle}>需求模式（requirements.mode）</legend>
            <select style={inputStyle} value={draft.requirements.mode}
              onChange={(e) => setDraft((d) => ({ ...d, requirements: { ...d.requirements, mode: e.target.value as QualityPolicyV2["requirements"]["mode"] } }))}>
              <option value="off">关闭</option>
              <option value="suggest">建议</option>
              <option value="require">强制</option>
              <option value="require-high-risk">仅高风险强制</option>
            </select>
            <div style={{ marginTop: 6 }}>
              <div style={labelStyle}>最大提问数</div>
              <input type="number" min={0} style={inputStyle} value={draft.requirements.maxQuestions}
                onChange={(e) => setDraft((d) => ({ ...d, requirements: { ...d.requirements, maxQuestions: Number(e.target.value) } }))} />
            </div>
          </fieldset>

          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={labelStyle}>验证模式（verification.mode）</legend>
            <select style={inputStyle} value={draft.verification.mode}
              onChange={(e) => setDraft((d) => ({ ...d, verification: { ...d.verification, mode: e.target.value as QualityPolicyV2["verification"]["mode"] } }))}>
              <option value="off">关闭</option>
              <option value="suggest">建议</option>
              <option value="require-evidence">要求证据</option>
            </select>
          </fieldset>

          <div>
            <button disabled={saving || !dirty} onClick={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}>
              {saving ? "保存中..." : "保存需求配置"}
            </button>
          </div>

          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={labelStyle}>验收标准（acceptanceCriteria）</legend>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="WorkRequest ID" value={specRequestId}
                onChange={(e) => setSpecRequestId(e.target.value)} />
              <button className="secondary" onClick={() => void loadSpecs()}>加载</button>
            </div>
            {store.requirementSpecs.length === 0 && (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>输入 WorkRequest ID 加载关联的 RequirementSpec</div>
            )}
            {store.requirementSpecs.map((spec) => (
              <div key={spec.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 11 }}>spec {spec.id.slice(0, 8)} v{spec.version}</strong>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{STATUS_LABEL[spec.status] ?? spec.status}</span>
                </div>
                <div style={{ marginTop: 4 }}>
                  <div style={labelStyle}>目标（goal）</div>
                  {editingGoal && currentSpec?.id === spec.id ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <textarea style={{ ...inputStyle, flex: 1, minHeight: 40 }} value={goalDraft}
                        onChange={(e) => setGoalDraft(e.target.value)} />
                      <button onClick={async () => { await store.updateRequirementSpec(spec.id, { goal: goalDraft }); setEditingGoal(false); }}>保存</button>
                      <button className="secondary" onClick={() => setEditingGoal(false)}>取消</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                      <span style={{ flex: 1 }}>{spec.goal || "（未设置）"}</span>
                      <button className="secondary" style={{ fontSize: 11 }} onClick={() => { void store.loadRequirementSpec(spec.id); setGoalDraft(spec.goal); setEditingGoal(true); }}>编辑</button>
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 6 }}>
                  <div style={labelStyle}>验收标准（{spec.acceptanceCriteria.length} 条）</div>
                  <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 11 }}>
                    {spec.acceptanceCriteria.map((c) => (
                      <li key={c.id}>
                        {c.required ? "★ " : "○ "}{c.description}
                        <span style={{ color: "var(--text-dim)" }}> · {c.evidenceMode} · {c.expectedEvidence.length} 证据</span>
                      </li>
                    ))}
                    {spec.acceptanceCriteria.length === 0 && <li style={{ color: "var(--text-dim)" }}>（无）</li>}
                  </ul>
                </div>
                {spec.constraints.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div style={labelStyle}>约束</div>
                    <ul style={{ margin: "4px 0 0 16px", padding: 0, fontSize: 11 }}>
                      {spec.constraints.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
