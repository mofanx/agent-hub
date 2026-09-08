import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, FlaskConical, Play, RefreshCw, ShieldCheck, X, XCircle, FileText } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { QualityRun, QualityCheck, QualityFinding, QualityStage, QualityIncident, QualityRule } from "../hub/types";

const STAGE_LABELS: Record<QualityStage, string> = {
  queued: "排队中",
  preflight: "预检",
  implementing: "实现中",
  collecting: "收集变更",
  "quick-verifying": "快速验证",
  reviewing: "审查中",
  fixing: "修复中",
  "full-verifying": "完整验证",
  "awaiting-approval": "等待审批",
  accepted: "已通过",
  failed: "失败",
  cancelled: "已取消",
  quarantined: "已隔离",
};

const TERMINAL: QualityStage[] = ["accepted", "failed", "cancelled", "quarantined"];

function stageColor(stage: QualityStage): string {
  if (stage === "accepted") return "var(--success)";
  if (stage === "failed" || stage === "quarantined") return "var(--danger, #e53e3e)";
  if (stage === "cancelled") return "var(--text-dim)";
  if (stage === "awaiting-approval") return "var(--warn)";
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
  const run = store.qualityRuns.find((r) => r.id === store.qualityRunId) ?? null;

  useEffect(() => {
    void store.loadQualityProjects();
    void store.loadQualityRuns(store.qualityProjectId ?? undefined);
  }, []);

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
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <FlaskConical size={16} />
              <strong style={{ flex: 1 }}>项目</strong>
            </div>
            {store.qualityProjects.length === 0 ? (
              <p style={{ color: "var(--text-dim)", margin: 0 }}>暂无已注册的质量项目。</p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {store.qualityProjects.map((p) => (
                  <button
                    key={p.id}
                    className={store.qualityProjectId === p.id ? "" : "secondary"}
                    onClick={() => void store.selectQualityProject(p.id)}
                    title={p.root}
                  >
                    {p.displayName || p.root}
                  </button>
                ))}
              </div>
            )}
            {store.qualityPolicy && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
                策略：{store.qualityPolicy.source === "file" ? ".devin/quality.json" : "默认（未配置）"}
                {" · "}autonomy={store.qualityPolicy.policy.autonomy}
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
          </div>

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ flex: 1 }}>运行记录</strong>
              {store.qualityProjectId && (
                <button className="icon-btn" title="发起质量运行" onClick={() => void store.startQualityRun(store.qualityProjectId!)}>
                  <Play size={14} />
                </button>
              )}
            </div>
            {store.qualityRuns.length === 0 ? (
              <p style={{ color: "var(--text-dim)", margin: 0 }}>暂无质量运行。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {store.qualityRuns.map((r) => (
                  <RunRow
                    key={r.id}
                    run={r}
                    selected={r.id === store.qualityRunId}
                    onClick={() => void store.loadQualityRun(r.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {run && (
            <div className="card">
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
                <div>判定：{run.verdict ?? "—"}{run.failureCode ? ` · ${run.failureCode}` : ""}</div>
                <div>创建：{fmt(run.createdAt)} · 更新：{fmt(run.updatedAt)}{run.completedAt ? ` · 完成：${fmt(run.completedAt)}` : ""}</div>
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
                {!TERMINAL.includes(run.stage) && (
                  <button className="secondary" onClick={() => void store.qualityRunAction(run.id, "cancel")}>
                    取消
                  </button>
                )}
                {TERMINAL.includes(run.stage) && run.stage !== "accepted" && (
                  <button className="secondary" onClick={() => void store.qualityRunAction(run.id, "retry")}>
                    重试
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
            </div>
          )}

          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <strong style={{ flex: 1 }}>Incident 列表</strong>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{store.qualityIncidents.length}</span>
            </div>
            {store.qualityIncidents.length === 0 ? (
              <p style={{ color: "var(--text-dim)", fontSize: 12, margin: 0 }}>暂无 incident。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {store.qualityRules.map((r) => (
                  <RuleCard key={r.id} rule={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunRow({ run, selected, onClick }: { run: QualityRun; selected: boolean; onClick: () => void }) {
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
