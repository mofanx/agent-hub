import { useEffect, useState } from "react";
import { CalendarClock, Info, Pencil, Plus, ScrollText, Trash2, Power, X } from "lucide-react";
import { useHubStore } from "../hub/store";
import { stringsFor, type Strings } from "../hub/strings";
import type { ScheduledTask, Schedule, SimpleSchedule, CronSchedule, TaskLog } from "../hub/types";
import { FormRow } from "../components/FormRow";

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function describeSchedule(S: Strings, s: Schedule): string {
  if (s.mode === "cron") return `Cron: ${s.expr}`;
  if (s.kind === "daily") return S.schedDailyFmt.replace("%s", s.time ?? "09:00");
  if (s.kind === "interval") return S.schedIntervalFmt.replace("%s", String(s.intervalMinutes ?? 0));
  if (s.kind === "once") return S.schedOnceFmt.replace("%s", formatTime(s.at ?? null));
  return "—";
}

function cronExamples(S: Strings) {
  return [
    { expr: "0 9 * * *", desc: S.cronExDaily9 },
    { expr: "0 9 * * 1-5", desc: S.cronExWeekday9 },
    { expr: "*/30 * * * *", desc: S.cronExEvery30m },
    { expr: "0 */2 * * *", desc: S.cronExEvery2h },
    { expr: "0 9,18 * * *", desc: S.cronExDaily9And18 },
    { expr: "0 0 * * 0", desc: S.cronExSunday0 },
    { expr: "0 0 1 * *", desc: S.cronExMonthly1st },
    { expr: "0 9 1-7 * 1", desc: S.cronExFirstMonday },
  ];
}

export function ScheduleScreen() {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    void store.loadScheduledTasks();
  }, [store.loadScheduledTasks]);

  return (
    <div className="settings-screen">
      <nav className="settings-nav">
        <div className="nav-heading">{S.scheduledTasksTitle}</div>
        <span className="spacer" />
        <button onClick={() => void store.loadTaskLogs().then(() => setShowLogs(true))}>
          <ScrollText size={15} /> {S.taskLogsTitle}
        </button>
        <button onClick={() => useHubStore.setState({ screen: "sessions" })}>
          <X size={15} /> {S.backLabel}
        </button>
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          {store.scheduledTasks.length === 0 && !showCreate && (
            <div className="card">
              <p style={{ color: "var(--text-dim)", margin: 0 }}>
                {S.noTasksHint}
              </p>
            </div>
          )}

          {store.scheduledTasks.map((task) => (
            <div key={task.id} className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <CalendarClock size={16} />
                <strong style={{ flex: 1 }}>{task.name}</strong>
                <span
                  style={{
                    fontSize: 12,
                    color: task.enabled ? "var(--accent)" : "var(--text-dim)",
                  }}
                >
                  {task.enabled ? S.enabledLabel : S.disabledLabel}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}>
                <div>{S.targetRowFmt.replace("%s", task.targetType === "room" ? S.roomsLabel : S.sessionsLabel).replace("%s", task.targetName)}</div>
                <div>{S.scheduleRowFmt.replace("%s", describeSchedule(S, task.schedule))}</div>
                <div>{S.messageRowFmt.replace("%s", task.message.slice(0, 80) + (task.message.length > 80 ? "…" : ""))}</div>
                {task.missionTemplate && (
                  <>
                    <div className="nav-sub">
                      {S.missionFrozenContract}: {task.missionTemplate.goal}
                      {task.missionTemplate.scope && ` · ${S.missionScope}: ${task.missionTemplate.scope}`}
                      {task.missionTemplate.constraints.length > 0 && ` · ${task.missionTemplate.constraints.join("；")}`}
                      {task.missionAutoStart ? ` · ${S.missionAutoStart}` : ` · ${S.taskTemplateDraftOnly}`}
                    </div>
                    <div className="nav-sub">{S.taskTemplateRebuild}</div>
                  </>
                )}
                <div>{S.nextRunFmt.replace("%s", formatTime(task.nextRunAt))}</div>
                <div>{S.lastRunFmt.replace("%s", formatTime(task.lastRunAt))}</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="icon-btn"
                  title={task.enabled ? S.disabledLabel : S.enabledLabel}
                  onClick={() => void store.toggleScheduledTask(task.id)}
                >
                  <Power size={14} />
                </button>
                <button className="icon-btn" title={S.editTitle} onClick={() => setEditing(task)}>
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  title={S.deleteLabel}
                  onClick={() => void store.deleteScheduledTask(task.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          {!showCreate && !editing && (
            <button style={{ alignSelf: "flex-start" }} onClick={() => setShowCreate(true)}>
              <Plus size={15} /> {S.createTask}
            </button>
          )}

          {showCreate && (
            <TaskEditor
              onCancel={() => setShowCreate(false)}
              onSave={async (input) => {
                await store.createScheduledTask(input);
                setShowCreate(false);
              }}
            />
          )}

          {editing && (
            <TaskEditor
              task={editing}
              onCancel={() => setEditing(null)}
              onSave={async (input) => {
                await store.updateScheduledTask(editing.id, input);
                setEditing(null);
              }}
            />
          )}

          {showLogs && <LogsPanel logs={store.taskLogs} onClose={() => setShowLogs(false)} onClear={() => void store.clearTaskLogs()} />}
        </div>
      </div>
    </div>
  );
}

function LogsPanel({ logs, onClose, onClear }: { logs: TaskLog[]; onClose: () => void; onClear: () => void }) {
  const S = stringsFor(useHubStore().lang);
  return (
    <div className="card" style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <ScrollText size={16} />
        <strong style={{ flex: 1 }}>{S.taskLogsTitle}</strong>
        <button className="icon-btn" title={S.clearLogsTitle} onClick={onClear}>
          <Trash2 size={14} />
        </button>
        <button className="icon-btn" title={S.close} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {logs.length === 0 ? (
        <p style={{ color: "var(--text-dim)", margin: 0 }}>{S.noLogs}</p>
      ) : (
        <div style={{ maxHeight: 400, overflowY: "auto", fontSize: 13 }}>
          {logs.map((log) => (
            <div
              key={log.id}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  color: log.success ? "var(--accent)" : "var(--danger, #e53e3e)",
                  fontSize: 12,
                  marginTop: 2,
                }}
              >
                {log.success ? "✓" : "✗"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{log.taskName}</div>
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {formatTime(log.at)} → {log.targetType === "room" ? S.roomsLabel : S.sessionsLabel} · {log.targetName}
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  {S.messageRowFmt.replace("%s", log.message.slice(0, 60) + (log.message.length > 60 ? "…" : ""))}
                </div>
                {log.error && (
                  <div style={{ color: "var(--danger, #e53e3e)", fontSize: 12 }}>{S.errorRowFmt.replace("%s", log.error)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type EditorInput = Omit<ScheduledTask, "id" | "lastRunAt" | "nextRunAt" | "createdAt">;

function TaskEditor({
  task,
  onSave,
  onCancel,
}: {
  task?: ScheduledTask;
  onSave: (input: EditorInput) => Promise<void>;
  onCancel: () => void;
}) {
  const store = useHubStore();
  const S = stringsFor(store.lang);
  const [name, setName] = useState(task?.name ?? "");
  const [targetType, setTargetType] = useState<"session" | "room">(task?.targetType ?? "session");
  const [targetId, setTargetId] = useState(task?.targetId ?? "");
  const [message, setMessage] = useState(task?.message ?? "");
  const [mode, setMode] = useState<"simple" | "cron">(
    task?.schedule.mode === "cron" ? "cron" : "simple",
  );
  const [kind, setKind] = useState<"daily" | "interval" | "once">(
    task?.schedule.mode === "simple" ? task.schedule.kind : "daily",
  );
  const [time, setTime] = useState(
    task?.schedule.mode === "simple" && task.schedule.kind === "daily" ? task.schedule.time ?? "09:00" : "09:00",
  );
  const [intervalMinutes, setIntervalMinutes] = useState(
    task?.schedule.mode === "simple" && task.schedule.kind === "interval" ? task.schedule.intervalMinutes ?? 60 : 60,
  );
  const [at, setAt] = useState(
    task?.schedule.mode === "simple" && task.schedule.kind === "once" && task.schedule.at
      ? new Date(task.schedule.at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "",
  );
  const [cronExpr, setCronExpr] = useState(
    task?.schedule.mode === "cron" ? task.schedule.expr : "0 9 * * *",
  );
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [showCronHelp, setShowCronHelp] = useState(false);

  const targets =
    targetType === "room"
      ? store.rooms.map((r) => ({ id: r.roomId, name: r.name }))
      : store.sessions.map((s) => ({ id: s.sessionId, name: s.name }));

  const submit = async () => {
    if (!name || !targetId || !message) return;
    let schedule: Schedule;
    if (mode === "cron") {
      schedule = { mode: "cron", expr: cronExpr } as CronSchedule;
    } else {
      schedule = {
        mode: "simple",
        kind,
        ...(kind === "daily" ? { time } : {}),
        ...(kind === "interval" ? { intervalMinutes } : {}),
        ...(kind === "once" ? { at: at ? new Date(at).getTime() : undefined } : {}),
      } as SimpleSchedule;
    }
    const target = targets.find((t) => t.id === targetId);
    await onSave({
      name,
      targetType,
      targetId,
      targetName: target?.name ?? "",
      message,
      schedule,
      enabled,
    });
  };

  return (
    <div className="card">
      <h3>{task ? S.editTask : S.createTask}</h3>
      <FormRow label={S.nameLabel}>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder={S.taskNamePlaceholder} />
      </FormRow>
      {task?.missionTemplate && <div className="nav-sub">{S.taskTemplateLocked}</div>}
      <FormRow label={S.targetTypeLabel}>
        <select value={targetType} disabled={!!task?.missionTemplate} onChange={(e) => { setTargetType(e.currentTarget.value as "session" | "room"); setTargetId(""); }}>
          <option value="session">{S.sessionSingleLabel}</option>
          <option value="room">{S.roomsLabel}</option>
        </select>
      </FormRow>
      <FormRow label={S.targetLabel}>
        <select value={targetId} disabled={!!task?.missionTemplate} onChange={(e) => setTargetId(e.currentTarget.value)}>
          <option value="">{S.pleaseSelect}</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </FormRow>
      <FormRow label={S.messageContentLabel}>
        {task?.missionTemplate && <div className="nav-sub">{S.taskTemplateLocked}</div>}
        <textarea
          value={message}
          disabled={!!task?.missionTemplate}
          onChange={(e) => setMessage(e.currentTarget.value)}
          placeholder={S.messagePlaceholder}
          rows={3}
          style={{ width: "100%", resize: "vertical" }}
        />
      </FormRow>
      <FormRow label={S.scheduleModeLabel}>
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as "simple" | "cron")}>
          <option value="simple">{S.simpleModeLabel}</option>
          <option value="cron">{S.cronModeLabel}</option>
        </select>
      </FormRow>
      {mode === "simple" ? (
        <>
          <FormRow label={S.repeatLabel}>
            <select value={kind} onChange={(e) => setKind(e.currentTarget.value as "daily" | "interval" | "once")}>
              <option value="daily">{S.dailyOpt}</option>
              <option value="interval">{S.intervalOpt}</option>
              <option value="once">{S.onceOpt}</option>
            </select>
          </FormRow>
          {kind === "daily" && (
            <FormRow label={S.timeLabel}>
              <input type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
            </FormRow>
          )}
          {kind === "interval" && (
            <FormRow label={S.intervalMinLabel}>
              <input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.currentTarget.value))}
              />
            </FormRow>
          )}
          {kind === "once" && (
            <FormRow label={S.runAtLabel}>
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} />
            </FormRow>
          )}
        </>
      ) : (
        <>
          <FormRow label={S.cronExprLabel}>
            <div style={{ display: "flex", gap: 4, alignItems: "center", width: "100%" }}>
              <input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.currentTarget.value)}
                placeholder={S.cronPlaceholder}
                style={{ fontFamily: "monospace", flex: 1 }}
              />
              <button
                className="icon-btn"
                title={S.cronSyntaxTitle}
                onClick={() => setShowCronHelp(true)}
                style={{ flexShrink: 0 }}
              >
                <Info size={16} />
              </button>
            </div>
          </FormRow>
          {showCronHelp && <CronHelpDialog onClose={() => setShowCronHelp(false)} onPick={(expr) => { setCronExpr(expr); setShowCronHelp(false); }} />}
        </>
      )}
      <FormRow label={S.enabledLabel}>
        <select value={enabled ? "true" : "false"} onChange={(e) => setEnabled(e.currentTarget.value === "true")}>
          <option value="true">{S.yesLabel}</option>
          <option value="false">{S.noLabel}</option>
        </select>
      </FormRow>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => void submit()}>{S.saveLabel}</button>
        <button onClick={onCancel}>{S.cancelLabel}</button>
      </div>
    </div>
  );
}

function CronHelpDialog({ onClose, onPick }: { onClose: () => void; onPick: (expr: string) => void }) {
  const S = stringsFor(useHubStore().lang);
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Info size={16} />
        <strong style={{ flex: 1 }}>{S.cronHelpTitle}</strong>
        <button className="icon-btn" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8, marginBottom: 12 }}>
        <div>{S.cronFormatLine}<code style={{ fontFamily: "monospace" }}>{S.cronFieldMin} {S.cronFieldHour} {S.cronFieldDay} {S.cronFieldMonth} {S.cronFieldWeek}</code></div>
        <div>· {S.cronFieldMin}: 0-59</div>
        <div>· {S.cronFieldHour}: 0-23</div>
        <div>· {S.cronFieldDay}: 1-31</div>
        <div>· {S.cronFieldMonth}: 1-12</div>
        <div>· {S.cronFieldWeek}: 0-6 (0={S.cronSundayLabel})</div>
        <div style={{ marginTop: 4 }}>
          {S.cronSupportPrefix} <code>*</code>（{S.cronAny}）、<code>*/N</code>（{S.cronStep}）、<code>1-5</code>（{S.cronRange}）、<code>1,3,5</code>（{S.cronList}）
        </div>
      </div>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>{S.cronExamplesTitle}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {cronExamples(S).map((ex) => (
          <button
            key={ex.expr}
            onClick={() => onPick(ex.expr)}
            style={{ textAlign: "left", display: "flex", gap: 12, alignItems: "center" }}
          >
            <code style={{ fontFamily: "monospace", flexShrink: 0 }}>{ex.expr}</code>
            <span style={{ color: "var(--text-dim)" }}>{ex.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
