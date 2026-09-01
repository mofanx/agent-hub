import { useEffect, useState } from "react";
import { CalendarClock, Info, Pencil, Plus, ScrollText, Trash2, Power, X } from "lucide-react";
import { useHubStore } from "../hub/store";
import type { ScheduledTask, Schedule, SimpleSchedule, CronSchedule, TaskLog } from "../hub/types";
import { FormRow } from "../components/FormRow";

function formatTime(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function describeSchedule(s: Schedule): string {
  if (s.mode === "cron") return `Cron: ${s.expr}`;
  if (s.kind === "daily") return `每天 ${s.time ?? "09:00"}`;
  if (s.kind === "interval") return `每 ${s.intervalMinutes ?? 0} 分钟`;
  if (s.kind === "once") return `一次性 ${formatTime(s.at ?? null)}`;
  return "—";
}

const CRON_EXAMPLES = [
  { expr: "0 9 * * *", desc: "每天 9:00" },
  { expr: "0 9 * * 1-5", desc: "工作日 9:00" },
  { expr: "*/30 * * * *", desc: "每 30 分钟" },
  { expr: "0 */2 * * *", desc: "每 2 小时" },
  { expr: "0 9,18 * * *", desc: "每天 9:00 和 18:00" },
  { expr: "0 0 * * 0", desc: "每周日 0:00" },
  { expr: "0 0 1 * *", desc: "每月 1 号 0:00" },
  { expr: "0 9 1-7 * 1", desc: "每月第一个周一 9:00" },
];

export function ScheduleScreen() {
  const store = useHubStore();
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  useEffect(() => {
    void store.loadScheduledTasks();
  }, [store.loadScheduledTasks]);

  return (
    <div className="settings-screen">
      <nav className="settings-nav">
        <div className="nav-heading">定时任务</div>
        <span className="spacer" />
        <button onClick={() => void store.loadTaskLogs().then(() => setShowLogs(true))}>
          <ScrollText size={15} /> 执行日志
        </button>
        <button onClick={() => useHubStore.setState({ screen: "sessions" })}>
          <X size={15} /> 返回
        </button>
      </nav>
      <div className="settings-content">
        <div className="settings-inner">
          {store.scheduledTasks.length === 0 && !showCreate && (
            <div className="card">
              <p style={{ color: "var(--text-dim)", margin: 0 }}>
                暂无定时任务。点击下方按钮创建一个，例如"每天 9 点发送最新天气"。
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
                  {task.enabled ? "启用" : "禁用"}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8 }}>
                <div>目标：{task.targetType === "room" ? "群聊" : "会话"} · {task.targetName}</div>
                <div>调度：{describeSchedule(task.schedule)}</div>
                <div>消息：{task.message.slice(0, 80)}{task.message.length > 80 ? "…" : ""}</div>
                <div>下次执行：{formatTime(task.nextRunAt)}</div>
                <div>上次执行：{formatTime(task.lastRunAt)}</div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  className="icon-btn"
                  title={task.enabled ? "禁用" : "启用"}
                  onClick={() => void store.toggleScheduledTask(task.id)}
                >
                  <Power size={14} />
                </button>
                <button className="icon-btn" title="编辑" onClick={() => setEditing(task)}>
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn danger"
                  title="删除"
                  onClick={() => void store.deleteScheduledTask(task.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          {!showCreate && !editing && (
            <button style={{ alignSelf: "flex-start" }} onClick={() => setShowCreate(true)}>
              <Plus size={15} /> 创建定时任务
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
  return (
    <div className="card" style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <ScrollText size={16} />
        <strong style={{ flex: 1 }}>执行日志</strong>
        <button className="icon-btn" title="清空日志" onClick={onClear}>
          <Trash2 size={14} />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      {logs.length === 0 ? (
        <p style={{ color: "var(--text-dim)", margin: 0 }}>暂无执行记录。</p>
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
                  {formatTime(log.at)} → {log.targetType === "room" ? "群聊" : "会话"} · {log.targetName}
                </div>
                <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  消息：{log.message.slice(0, 60)}{log.message.length > 60 ? "…" : ""}
                </div>
                {log.error && (
                  <div style={{ color: "var(--danger, #e53e3e)", fontSize: 12 }}>错误：{log.error}</div>
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
      <h3>{task ? "编辑定时任务" : "创建定时任务"}</h3>
      <FormRow label="名称">
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="如：每日天气" />
      </FormRow>
      <FormRow label="目标类型">
        <select value={targetType} onChange={(e) => { setTargetType(e.currentTarget.value as "session" | "room"); setTargetId(""); }}>
          <option value="session">会话（单聊）</option>
          <option value="room">群聊</option>
        </select>
      </FormRow>
      <FormRow label="目标">
        <select value={targetId} onChange={(e) => setTargetId(e.currentTarget.value)}>
          <option value="">请选择…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </FormRow>
      <FormRow label="消息内容">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          placeholder="如：给我发送最新天气"
          rows={3}
          style={{ width: "100%", resize: "vertical" }}
        />
      </FormRow>
      <FormRow label="调度模式">
        <select value={mode} onChange={(e) => setMode(e.currentTarget.value as "simple" | "cron")}>
          <option value="simple">简易模式</option>
          <option value="cron">高级模式（Cron）</option>
        </select>
      </FormRow>
      {mode === "simple" ? (
        <>
          <FormRow label="重复方式">
            <select value={kind} onChange={(e) => setKind(e.currentTarget.value as "daily" | "interval" | "once")}>
              <option value="daily">每天</option>
              <option value="interval">间隔</option>
              <option value="once">一次性</option>
            </select>
          </FormRow>
          {kind === "daily" && (
            <FormRow label="时间">
              <input type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
            </FormRow>
          )}
          {kind === "interval" && (
            <FormRow label="间隔（分钟）">
              <input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.currentTarget.value))}
              />
            </FormRow>
          )}
          {kind === "once" && (
            <FormRow label="执行时间">
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.currentTarget.value)} />
            </FormRow>
          )}
        </>
      ) : (
        <>
          <FormRow label="Cron 表达式">
            <div style={{ display: "flex", gap: 4, alignItems: "center", width: "100%" }}>
              <input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.currentTarget.value)}
                placeholder="分 时 日 月 周，如 0 9 * * *"
                style={{ fontFamily: "monospace", flex: 1 }}
              />
              <button
                className="icon-btn"
                title="Cron 语法说明"
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
      <FormRow label="启用">
        <select value={enabled ? "true" : "false"} onChange={(e) => setEnabled(e.currentTarget.value === "true")}>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      </FormRow>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={() => void submit()}>保存</button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

function CronHelpDialog({ onClose, onPick }: { onClose: () => void; onPick: (expr: string) => void }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Info size={16} />
        <strong style={{ flex: 1 }}>Cron 表达式说明</strong>
        <button className="icon-btn" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.8, marginBottom: 12 }}>
        <div>格式：<code style={{ fontFamily: "monospace" }}>分 时 日 月 周</code></div>
        <div>· 分：0-59</div>
        <div>· 时：0-23</div>
        <div>· 日：1-31</div>
        <div>· 月：1-12</div>
        <div>· 周：0-6（0=周日）</div>
        <div style={{ marginTop: 4 }}>支持 <code>*</code>（任意）、<code>*/N</code>（步长）、<code>1-5</code>（范围）、<code>1,3,5</code>（列表）</div>
      </div>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>常用示例（点击使用）：</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {CRON_EXAMPLES.map((ex) => (
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
