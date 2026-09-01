import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

export type ScheduleMode = "simple" | "cron";

export type SimpleSchedule = {
  mode: "simple";
  // daily: 每天固定时间 "HH:MM"
  // interval: 每隔 N 分钟
  // once: 一次性，指定 timestamp
  kind: "daily" | "interval" | "once";
  time?: string; // "HH:MM" for daily
  intervalMinutes?: number; // for interval
  at?: number; // timestamp for once
};

export type CronSchedule = {
  mode: "cron";
  expr: string; // 5 段式: 分 时 日 月 周
};

export type Schedule = SimpleSchedule | CronSchedule;

export type ScheduledTask = {
  id: string;
  name: string;
  targetType: "session" | "room";
  targetId: string;
  targetName: string;
  message: string;
  schedule: Schedule;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
};

export type TaskLog = {
  id: string;
  taskId: string;
  taskName: string;
  targetType: "session" | "room";
  targetId: string;
  targetName: string;
  message: string;
  at: number;
  success: boolean;
  error: string | null;
};

export type TaskTriggerFn = (
  task: ScheduledTask,
) => Promise<void>;

const TICK_MS = 60_000;
const META_KEY = "scheduledTasks";
const LOG_META_KEY = "taskLogs";
const MAX_LOGS = 500;

/** 简单 cron 解析：5 段式（分 时 日 月 周），支持 * / 数字 / 逗号 / 横线 */
function parseCronField(field: string, min: number, max: number): number[] | null {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^\*\/(\d+)$/);
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      for (let v = min; v <= max; v += step) result.add(v);
    } else if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      const step = rangeMatch[3] ? Number(rangeMatch[3]) : 1;
      if (lo < min || hi > max) return null;
      for (let v = lo; v <= hi; v += step) result.add(v);
    } else {
      const v = Number(part);
      if (Number.isNaN(v) || v < min || v > max) return null;
      result.add(v);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function cronNextRun(expr: string, from: Date): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, dayF, monthF, dowF] = parts as [string, string, string, string, string];
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const days = parseCronField(dayF, 1, 31);
  const months = parseCronField(monthF, 1, 12);
  const dows = parseCronField(dowF, 0, 6);
  if (!minutes || !hours || !days || !months || !dows) return null;

  // 从下一分钟开始搜索，最多扫描 366 天
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 527040; i++) {
    if (
      months.includes(t.getMonth() + 1) &&
      days.includes(t.getDate()) &&
      dows.includes(t.getDay()) &&
      hours.includes(t.getHours()) &&
      minutes.includes(t.getMinutes())
    ) {
      return t.getTime();
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

function simpleNextRun(schedule: SimpleSchedule, from: Date, lastRunAt: number | null): number | null {
  const now = from.getTime();
  if (schedule.kind === "once") {
    return schedule.at ?? null;
  }
  if (schedule.kind === "interval") {
    const mins = schedule.intervalMinutes ?? 0;
    if (mins <= 0) return null;
    const base = lastRunAt ?? now;
    let next = base + mins * 60_000;
    while (next <= now) next += mins * 60_000;
    return next;
  }
  if (schedule.kind === "daily") {
    const time = schedule.time ?? "09:00";
    const [h, m] = (time.split(":") as [string, string]).map(Number) as [number, number];
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    const next = new Date(from);
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  return null;
}

export function computeNextRun(task: ScheduledTask, from: Date = new Date()): number | null {
  if (!task.enabled) return null;
  if (task.schedule.mode === "cron") {
    return cronNextRun(task.schedule.expr, from);
  }
  return simpleNextRun(task.schedule, from, task.lastRunAt);
}

export class Scheduler {
  private store: Store;
  private tasks = new Map<string, ScheduledTask>();
  private logs: TaskLog[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private persist: () => void;
  private broadcast: (tasks: ScheduledTask[]) => void;
  private trigger: TaskTriggerFn;

  constructor(
    store: Store,
    persist: () => void,
    broadcast: (tasks: ScheduledTask[]) => void,
    trigger: TaskTriggerFn,
  ) {
    this.store = store;
    this.persist = persist;
    this.broadcast = broadcast;
    this.trigger = trigger;
    this.load(store);
    this.loadLogs(store);
  }

  private load(store: Store): void {
    const raw = store.getMeta(META_KEY);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw) as ScheduledTask[];
      for (const t of arr) {
        t.nextRunAt = computeNextRun(t);
        this.tasks.set(t.id, t);
      }
    } catch { /* ignore corrupt data */ }
  }

  private loadLogs(store: Store): void {
    const raw = store.getMeta(LOG_META_KEY);
    if (!raw) return;
    try {
      this.logs = JSON.parse(raw) as TaskLog[];
    } catch { /* ignore */ }
  }

  private persistLogs(store: Store): void {
    store.setMeta(LOG_META_KEY, JSON.stringify(this.logs));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (!task.enabled || task.nextRunAt == null) continue;
      if (task.nextRunAt > now) continue;
      let success = true;
      let error: string | null = null;
      try {
        await this.trigger(task);
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
      }
      task.lastRunAt = now;
      this.addLog({
        id: randomUUID(),
        taskId: task.id,
        taskName: task.name,
        targetType: task.targetType,
        targetId: task.targetId,
        targetName: task.targetName,
        message: task.message,
        at: now,
        success,
        error,
      });
      // 一次性任务执行后自动禁用
      if (task.schedule.mode === "simple" && task.schedule.kind === "once") {
        task.enabled = false;
        task.nextRunAt = null;
      } else {
        task.nextRunAt = computeNextRun(task, new Date(now + 1000));
      }
      this.persist();
      this.persistLogs(this.store);
      this.broadcast(this.list());
    }
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
  }

  create(input: Omit<ScheduledTask, "id" | "lastRunAt" | "nextRunAt" | "createdAt">): ScheduledTask {
    const task: ScheduledTask = {
      ...input,
      id: randomUUID(),
      lastRunAt: null,
      nextRunAt: null,
      createdAt: Date.now(),
    };
    task.nextRunAt = computeNextRun(task);
    this.tasks.set(task.id, task);
    this.persist();
    this.broadcast(this.list());
    return task;
  }

  update(id: string, patch: Partial<Omit<ScheduledTask, "id" | "createdAt">>): ScheduledTask | null {
    const existing = this.tasks.get(id);
    if (!existing) return null;
    const updated: ScheduledTask = { ...existing, ...patch, id: existing.id, createdAt: existing.createdAt };
    updated.nextRunAt = computeNextRun(updated);
    this.tasks.set(id, updated);
    this.persist();
    this.broadcast(this.list());
    return updated;
  }

  delete(id: string): boolean {
    const existed = this.tasks.delete(id);
    if (existed) {
      this.persist();
      this.broadcast(this.list());
    }
    return existed;
  }

  toggle(id: string): ScheduledTask | null {
    const existing = this.tasks.get(id);
    if (!existing) return null;
    return this.update(id, { enabled: !existing.enabled });
  }

  persistTo(store: Store): void {
    store.setMeta(META_KEY, JSON.stringify(this.list()));
  }

  private addLog(log: TaskLog): void {
    this.logs.unshift(log);
    if (this.logs.length > MAX_LOGS) this.logs = this.logs.slice(0, MAX_LOGS);
  }

  listLogs(limit = 100): TaskLog[] {
    return this.logs.slice(0, limit);
  }

  clearLogs(): void {
    this.logs = [];
    this.persistLogs(this.store);
  }
}
