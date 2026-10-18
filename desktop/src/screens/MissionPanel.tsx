import React, { useMemo, useState } from "react";
import { MissionEvidence } from "./MissionEvidence";
import { ExternalLink, Play, Square, Target } from "lucide-react";
import { useHubStore } from "../hub/store";
import { missionEventKindLabel, missionStatusLabel, missionTaskStatusLabel, stringsFor, type Strings } from "../hub/strings";
import { FormRow } from "../components/FormRow";
import type { DecisionInfo, MissionCriterionReview, MissionInfo, RoomInfo } from "../hub/types";

function ownerName(room: RoomInfo | undefined, sessionId: string): string {
  return room?.members.find((m) => m[0] === sessionId)?.[1] ?? sessionId;
}

function contextSummary(d: DecisionInfo): string {
  const c = d.context;
  if (!c) return "";
  if (c.redacted === true) return "redacted";
  const parts: string[] = [];
  for (const k of ["command", "path", "url", "kind", "name"]) {
    const v = c[k];
    if (typeof v === "string" && v) parts.push(v.slice(0, 80));
  }
  return parts.join(" · ");
}

function DecisionSection() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [busyId, setBusyId] = useState<string | null>(null);
  const list = store.pendingDecisions;
  if (list.length === 0) return null;
  const ago = (at: number) => Math.max(0, Math.floor((Date.now() - at) / 60000));
  const respond = async (d: DecisionInfo, optionId: string) => {
    if (busyId) return;
    setBusyId(d.requestId + optionId);
    try {
      await store.respondToDecision(d, optionId);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <>
      <div className="home-section-title">{S.decisionSection} ({list.length})</div>
      <div className="home-recent">
        {list.map((d) => {
          const summary = contextSummary(d);
          return (
            <div key={d.decisionId} className="home-recent-item mission-item">
              <div className="nav-text" style={{ flex: 1 }}>
                <span className="nav-title">{d.title}</span>
                <span className="nav-sub">
                  {S.decisionFrom} {d.requestedBy}
                  {d.roomId
                    ? ` · ${store.rooms.find((r) => r.roomId === d.roomId)?.name ?? d.roomId}`
                    : ` · ${d.sessionId.slice(0, 8)}`} ·{" "}
                  {S.decisionWaitingFmt.replace("%s", String(ago(d.at)))}
                </span>
                {summary && (
                  <span className="nav-sub">
                    {summary === "redacted" ? S.decisionRedacted : summary}
                  </span>
                )}
              </div>
              {d.type === "permission" ? (
                <div className="permission-options">{d.options.map((o) => (
                  <button
                    key={o.id}
                    className="secondary"
                    disabled={busyId !== null}
                    onClick={() => void respond(d, o.id)}
                  >
                    {o.label}
                  </button>
                ))}</div>
              ) : (
                <button
                  className="secondary"
                  onClick={() => {
                    const r = d.roomId ? store.rooms.find((x) => x.roomId === d.roomId) : undefined;
                    if (r) { void store.openRoom(r); return; }
                    const s = store.sessions.find((x) => x.sessionId === d.sessionId);
                    if (s) store.openChat(s);
                  }}
                >
                  {S.decisionLocate}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function taskSummary(t: Record<string, unknown>, S: Strings): string {
  const bits: string[] = [];
  if (typeof t.status === "string") bits.push(missionTaskStatusLabel(S, String(t.status)));
  if (typeof t.output === "string" && t.output) bits.push(t.output.slice(0, 100));
  return bits.join(" · ");
}

function ReviewBlock({ mission, onReview }: {
  mission: MissionInfo;
  onReview: (index: number, verdict: MissionCriterionReview["verdict"], taskIds: string[], note: string) => Promise<boolean>;
}) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const tasks = Array.isArray(mission.flow?.tasks)
    ? (mission.flow.tasks as Record<string, unknown>[])
    : [];
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<MissionCriterionReview["verdict"]>("unverified");
  const [note, setNote] = useState("");
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  if (mission.status !== "awaiting-acceptance") return null;
  return (
    <div className="mission-review">
      {mission.acceptanceCriteria.map((c, i) => {
        const rv = mission.reviews.find((r) => r.index === i);
        const editing = editIdx === i;
        return (
          <div key={i} className="mission-review-row">
            <span className="nav-title">
              {i + 1}. {c}{" "}
              <span className={`mission-status mission-status-${rv?.verdict === "pass" ? "accepted" : rv?.verdict === "fail" ? "failed" : "draft"}`}>
                {rv?.verdict === "pass" ? S.missionReviewPass : rv?.verdict === "fail" ? S.missionReviewFail : S.missionReviewUnverified}
              </span>
            </span>
            {rv && (rv.note || rv.taskIds.length > 0) && (
              <span className="nav-sub">
                {rv.note}
                {rv.taskIds.length > 0 ? ` · ${S.missionReviewTasks}: ${rv.taskIds.join(",")}` : ""}
              </span>
            )}
            {editing ? (
              <div className="mission-review-edit">
                <select value={verdict} onChange={(e) => setVerdict(e.target.value as MissionCriterionReview["verdict"])}>
                  <option value="unverified">{S.missionReviewUnverified}</option>
                  <option value="pass">{S.missionReviewPass}</option>
                  <option value="fail">{S.missionReviewFail}</option>
                </select>
                <input
                  placeholder={S.missionReviewNote}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {tasks.length > 0 && (
                  <div className="mission-task-ids">
                    {tasks.map((t) => {
                      const id = String(t.id ?? "");
                      const checked = taskIds.includes(id);
                      return (
                        <label key={id} className="nav-sub">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setTaskIds(checked ? taskIds.filter((x) => x !== id) : [...taskIds, id])
                            }
                          />
                          {id} {taskSummary(t, S)}
                        </label>
                      );
                    })}
                  </div>
                )}
                <button
                  className="primary"
                  disabled={reviewBusy || (verdict === "pass" && !note.trim())}
                  onClick={() => {
                    setReviewBusy(true);
                    void onReview(i, verdict, taskIds, note)
                      .then((ok) => { if (ok) setEditIdx(null); })
                      .finally(() => setReviewBusy(false));
                  }}
                >
                  {S.missionReview}
                </button>
              </div>
            ) : (
              <button
                className="secondary"
                onClick={() => {
                  setEditIdx(i);
                  setVerdict(rv?.verdict ?? "unverified");
                  setNote(rv?.note ?? "");
                  setTaskIds(rv?.taskIds ?? []);
                }}
              >
                {S.missionReview}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}


type FilterKey = "all" | "active" | "waiting" | "risk" | "acceptance" | "closed";

const FILTERS: { key: FilterKey; label: (S: Strings) => string; match: (m: MissionInfo) => boolean }[] = [
  { key: "all", label: (S) => S.missionFilterAll, match: () => true },
  { key: "active", label: (S) => S.missionFilterActive, match: (m) => m.status === "running" },
  { key: "waiting", label: (S) => S.missionFilterWaiting, match: (m) => m.status === "waiting-user" },
  { key: "risk", label: (S) => S.missionFilterRisk, match: (m) => m.status === "failed" || !!m.error },
  { key: "acceptance", label: (S) => S.missionFilterAcceptance, match: (m) => m.status === "awaiting-acceptance" },
  { key: "closed", label: (S) => S.missionFilterClosed, match: (m) => ["accepted", "stopped", "failed"].includes(m.status) },
];

export function MissionPanel({ onCreateRoom }: { onCreateRoom: () => void }) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const rooms = useMemo(() => store.rooms.filter((r) => !r.archived), [store.rooms]);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [showForm, setShowForm] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [scope, setScope] = useState("");
  const [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState(false);
  const [suppId, setSuppId] = useState<string | null>(null);
  const [suppText, setSuppText] = useState("");
  const [reworkId, setReworkId] = useState<string | null>(null);
  const [reworkNote, setReworkNote] = useState("");
  const [acceptNoteMap, setAcceptNoteMap] = useState<Record<string, string>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const room = editId
    ? store.rooms.find((r) => r.roomId === roomId)
    : rooms.find((r) => r.roomId === roomId) ?? rooms[0];
  const [maxAutoRetries, setMaxAutoRetries] = useState(0);
  const [schedId, setSchedId] = useState<string | null>(null);
  const [schedTime, setSchedTime] = useState("09:00");
  const [schedAuto, setSchedAuto] = useState(false);
  const client = store.client;
  React.useEffect(() => {
    setShowForm(false); setEditId(null); setSchedId(null);
    setGoal(""); setCriteria(""); setScope(""); setConstraints("");
    setOwnerId(""); setRoomId(""); setSuppId(null); setSuppText("");
    setReworkId(null); setReworkNote(""); setAcceptNoteMap({});
    setMaxAutoRetries(0); setSchedTime("09:00"); setSchedAuto(false); setBusy(false);
  }, [client]);

  const missions = useMemo(
    () => store.missions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [store.missions],
  );
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, active: 0, waiting: 0, risk: 0, acceptance: 0, closed: 0 };
    for (const f of FILTERS) c[f.key] = missions.filter(f.match).length;
    return c;
  }, [missions]);
  const filtered = useMemo(() => missions.filter(FILTERS.find((f) => f.key === filter)!.match), [missions, filter]);

  if (!store.missionSupported) return <DecisionSection />;
  const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  const canStart = (m: MissionInfo) => m.status === "draft";
  const canStop = (m: MissionInfo) => ["running", "waiting-user", "awaiting-acceptance"].includes(m.status);
  const allPassed = (m: MissionInfo) =>
    m.acceptanceCriteria.every((_, i) => m.reviews.find((r) => r.index === i)?.verdict === "pass");

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  const saveDraft = () => run(async () => {
    const ac = lines(criteria);
    if (!room || !goal.trim() || ac.length === 0) return;
    const input = {
      roomId: room.roomId, goal: goal.trim(), acceptanceCriteria: ac,
      scope: scope.trim(), constraints: lines(constraints), maxAutoRetries,
      ...(ownerId ? { ownerSessionId: ownerId } : {}),
    };
    const created = editId
      ? await store.updateMissionContract(editId, input)
      : await store.createMission(input);
    if (created !== null) {
      setGoal(""); setCriteria(""); setScope(""); setConstraints(""); setEditId(null); setShowForm(false);
      setRoomId(""); setOwnerId(""); setMaxAutoRetries(0);
    }
  });

  return (
    <>
      <DecisionSection />
    <section className="mission-panel">
      <div className="home-section-title">
        <Target size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        {S.missionSection} ({missions.length})
        <button className="secondary" style={{ marginLeft: 8 }} onClick={() => setShowForm(!showForm)}>
          {S.missionNew}
        </button>
      </div>
      <div className="nav-sub mission-hint">{S.missionRiskNotice}</div>
      {store.missionError && <div className="nav-sub mission-error">{store.missionError}</div>}
      <div className="mission-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "primary" : "secondary"}
            onClick={() => setFilter(f.key)}
          >
            {f.label(S)} {counts[f.key]}
          </button>
        ))}
      </div>
      {showForm && (
        rooms.length === 0 ? (
          <div className="home-recent">
            <div className="home-recent-item">
              <div className="nav-text" style={{ flex: 1 }}>
                <span className="nav-sub">{S.missionNoRoom}</span>
              </div>
              <button className="secondary" onClick={onCreateRoom}>{S.missionCreateRoom}</button>
            </div>
          </div>
        ) : (
          <div className="home-recent mission-form">
            <FormRow label={S.missionRoom}>
              <select value={room?.roomId ?? ""} disabled={!!editId} onChange={(e) => { setRoomId(e.target.value); setOwnerId(""); }}>
                {(editId && room ? [room] : rooms).map((r) => <option key={r.roomId} value={r.roomId}>{r.name}</option>)}
              </select>
            </FormRow>
            <FormRow label={S.missionOwner}>
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">{S.missionOwnerAuto}</option>
                {(room?.members ?? []).map(([sid, name]) => <option key={sid} value={sid}>{name}</option>)}
              </select>
            </FormRow>
            <FormRow label={S.missionGoal}><input value={goal} onChange={(e) => setGoal(e.target.value)} /></FormRow>
            <FormRow label={S.missionCriteria}><textarea rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} /></FormRow>
            <FormRow label={S.missionScope}><input value={scope} onChange={(e) => setScope(e.target.value)} /></FormRow>
            <FormRow label={S.missionConstraints}><textarea rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} /></FormRow>
            <FormRow label={S.missionAutoRetries}>
              <select value={maxAutoRetries} onChange={(e) => setMaxAutoRetries(Number(e.target.value))}>
                {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </FormRow>
            <div className="nav-sub mission-hint">{S.missionAutoRetriesHint}</div>
            <div className="form-actions" style={{ marginTop: 4 }}>
              <button className="primary" disabled={busy || !goal.trim() || lines(criteria).length === 0} onClick={() => void saveDraft()}>
                {editId ? S.missionEditContract : S.missionSaveDraft}
              </button>
            </div>
          </div>
        )
      )}
      {filtered.length === 0 ? (
        <div className="nav-sub mission-empty">{S.missionEmpty}</div>
      ) : (
        <div className="home-recent">
          {filtered.map((m) => {
            const rm = rooms.find((r) => r.roomId === m.roomId);
            const canAccept = m.status === "awaiting-acceptance" && allPassed(m);
            return (
              <div key={m.id} className="home-recent-item mission-item">
                <div className="nav-text" style={{ flex: 1 }}>
                  <span className="nav-title">
                    <span className={`mission-status mission-status-${m.status}`}>
                      {missionStatusLabel(S, m.status)}
                    </span>{" "}
                    {m.goal}
                  </span>
                  <span className="nav-sub">
                    {rm?.name ?? m.roomId} · {S.missionOwner}: {ownerName(rm, m.ownerSessionId)}
                    {m.scope ? ` · ${S.missionScope}: ${m.scope}` : ""}
                    {m.constraints.length > 0 ? ` · ${m.constraints.join("；")}` : ""}
                  </span>
                  <span className="nav-sub">{S.missionCriteriaShort}: {m.acceptanceCriteria.join("；")}</span>
                  {m.reworkReason && <span className="nav-sub">{S.missionReworkReason}: {m.reworkReason}</span>}
                  {(m.maxAutoRetries > 0 || m.autoRetryCount > 0) && (
                    <span className="nav-sub">{S.missionAutoRetryCount.replace("%s", String(m.autoRetryCount)).replace("%s", String(m.maxAutoRetries))}</span>
                  )}
                  {m.supplements.length > 0 && (
                    <span className="nav-sub">
                      {S.missionSupplement}: {m.supplements.map((s) => `${s.text}(${s.delivered ? S.missionDelivered : S.missionRecordedOnly})`).join("；")}
                    </span>
                  )}
                  {m.status === "awaiting-acceptance" && <span className="nav-sub mission-hint">{S.missionAwaitingHint}</span>}
                  {m.error && <span className="nav-sub mission-error">{m.error}</span>}
                  <MissionEvidence mission={m} />
                  {m.events.length > 0 && (
                    <details className="nav-sub">
                      <summary>{S.missionEventsDetail} ({m.events.length})</summary>
                      {m.events.map((e) => (
                        <div key={e.id}>
                          [{missionEventKindLabel(S, e.kind)}] {e.text}
                        </div>
                      ))}
                    </details>
                  )}
                  {["accepted", "failed", "stopped"].includes(m.status) && (
                    <div className="mission-review">
                      {m.acceptanceCriteria.map((c, i) => {
                        const rv = m.reviews.find((r) => r.index === i);
                        return (
                          <div key={i} className="nav-sub">
                            {i + 1}. {c} — {rv?.verdict === "pass" ? S.missionReviewPass : rv?.verdict === "fail" ? S.missionReviewFail : S.missionReviewUnverified}
                            {rv?.note ? ` · ${rv.note}` : ""}
                          </div>
                        );
                      })}
                      {m.acceptance && <span className="nav-sub">{S.missionAcceptedNote}: {m.acceptance.note}</span>}
                    </div>
                  )}
                  <ReviewBlock mission={m} onReview={(i, v, t, n) => store.reviewMission(m.id, i, v, t, n)} />
                  {m.status === "awaiting-acceptance" && (
                    <div className="mission-review-edit">
                      <input placeholder={S.missionReviewNote} value={acceptNoteMap[m.id] ?? ""} onChange={(e) => setAcceptNoteMap((p) => ({ ...p, [m.id]: e.target.value }))} />
                      <button className="primary" disabled={!canAccept || busy} onClick={() => void run(async () => { const ok = await store.acceptMission(m.id, acceptNoteMap[m.id] ?? ""); if (ok) setAcceptNoteMap((p) => ({ ...p, [m.id]: "" })); })}>
                        {S.missionAccept}
                      </button>
                    </div>
                  )}
                  {(m.status === "running" || m.status === "waiting-user") && (
                    suppId === m.id ? (
                      <div className="mission-review-edit">
                        <input value={suppText} onChange={(e) => setSuppText(e.target.value)} />
                        <button className="secondary" disabled={busy || !suppText.trim()} onClick={() => { void run(async () => { const ok = await store.supplementMission(m.id, suppText); if (ok) { setSuppId(null); setSuppText(""); } }); }}>
                          {S.missionSupplement}
                        </button>
                        <span className="nav-sub mission-hint">{S.missionSupplementHint}</span>
                      </div>
                    ) : (
                      <button className="secondary" onClick={() => { setSuppId(m.id); setSuppText(""); }}>{S.missionSupplement}</button>
                    )
                  )}
                  {["awaiting-acceptance", "failed", "stopped"].includes(m.status) && (
                    reworkId === m.id ? (
                      <div className="mission-review-edit">
                        <input placeholder={S.missionReworkNote} value={reworkNote} onChange={(e) => setReworkNote(e.target.value)} />
                        <button className="secondary" disabled={!reworkNote.trim() || busy} onClick={() => { void run(async () => { const ok = await store.reworkMission(m.id, reworkNote); if (ok) { setReworkId(null); setReworkNote(""); } }); }}>
                          {S.missionRework}
                        </button>
                      </div>
                    ) : (
                      <button className="secondary" onClick={() => { setReworkId(m.id); setReworkNote(""); }}>{S.missionRework}</button>
                    )
                  )}
                  {m.status === "draft" && (
                    <button className="secondary" onClick={() => {
                      setEditId(m.id); setShowForm(true);
                      setRoomId(m.roomId);
                      setOwnerId(m.ownerSessionId);
                      setGoal(m.goal);
                      setCriteria(m.acceptanceCriteria.join("\n"));
                      setScope(m.scope);
                      setConstraints(m.constraints.join("\n"));
                      setMaxAutoRetries(m.maxAutoRetries);
                    }}>{S.missionEditContract}</button>
                  )}
                </div>
                {canStart(m) && (
                  <button className="icon-btn" title={S.missionStart} disabled={busy}
                    onClick={() => { if (confirm(`${S.missionStartConfirm}\n\n${m.goal}\n${S.missionRiskNotice}`)) void run(() => store.startMission(m.id)); }}>
                    <Play size={14} />
                  </button>
                )}
                {canStop(m) && (
                  <button className="icon-btn" title={S.missionStop} disabled={busy}
                    onClick={() => { if (confirm(S.missionStopConfirm)) void run(() => store.stopMission(m.id)); }}>
                    <Square size={14} />
                  </button>
                )}
                {schedId === m.id ? (
                  <div className="mission-review-edit">
                    <span className="nav-sub">{S.missionFrozenContract}: {m.goal}</span>
                    {m.scope && <span className="nav-sub">{S.missionScope}: {m.scope}</span>}
                    {m.constraints.length > 0 && <span className="nav-sub">{m.constraints.join("；")}</span>}
                    <span className="nav-sub">{S.missionScheduleDraftOnly}</span>
                    <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} />
                    <label className="nav-sub">
                      <input type="checkbox" checked={schedAuto} onChange={(e) => setSchedAuto(e.target.checked)} />
                      {S.missionAutoStart}
                    </label>
                    <button className="secondary" disabled={busy} onClick={() => {
                      if (schedAuto && !confirm(S.missionAutoStartConfirm)) return;
                      void run(async () => {
                        const t = await store.createMissionSchedule({
                          name: m.goal.slice(0, 40), targetType: "room", targetId: m.roomId,
                          targetName: rm?.name ?? m.roomId, message: `${S.missionSchedule}: ${m.goal.slice(0, 80)}`,
                          schedule: { mode: "simple", kind: "daily", time: schedTime },
                          enabled: true, missionId: m.id, missionAutoStart: schedAuto,
                        });
                        if (t) setSchedId(null);
                      });
                    }}>{S.missionScheduleSave}</button>
                  </div>
                ) : (
                  <button className="secondary" onClick={() => { setSchedId(m.id); setSchedAuto(false); }}>{S.missionSchedule}</button>
                )}
                {m.status === "draft" && (
                  <button className="secondary" disabled={busy} onClick={() => void run(() => store.stopMission(m.id))}>{S.missionDraftClose}</button>
                )}
                {(m.status === "waiting-user" || m.status === "running") && String((m.flow as Record<string, unknown> | undefined)?.phase ?? "") === "awaiting-retry" && (
                  <button className="secondary" disabled={busy} onClick={() => void run(() => store.retryMission(m.id))}>{S.missionRetry}</button>
                )}
                {rm && (
                  <button className="icon-btn" title={S.missionViewRoom} onClick={() => void store.openRoom(rm)}>
                    <ExternalLink size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
    </>
  );
}
