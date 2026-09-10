import { isAllDaySchedule, type CalEvent, type Priority, type Task, type TimeBlock } from "./types";

export interface TimeMapRange { start: string; end: string }
export interface TimeMap {
  id: string;
  name: string;
  /** Sunday = 0, matching Date.getDay(). */
  days: Partial<Record<number, TimeMapRange[]>>;
}

export const DEFAULT_TIME_MAP: TimeMap = {
  id: "default",
  name: "Default work hours",
  days: {
    1: [{ start: "09:00", end: "17:00" }], 2: [{ start: "09:00", end: "17:00" }],
    3: [{ start: "09:00", end: "17:00" }], 4: [{ start: "09:00", end: "17:00" }],
    5: [{ start: "09:00", end: "17:00" }],
  },
};

export interface AutoPlanTask {
  task: Task;
  /** Missing and stale map IDs deliberately fall back to the default map. */
  timeMapId?: string | null;
}

export interface AutoPlanInput {
  tasks: AutoPlanTask[];
  blocks: TimeBlock[];
  events: CalEvent[];
  maps: TimeMap[];
  defaultMapId: string;
  excludedLabels?: string[];
  activeTaskId?: string | null;
  now: Date;
  days: 1 | 2 | 3;
}

export type AutoPlanPlacementKind = "new" | "moved";
export interface AutoPlanPlacement {
  taskId: string; title: string; start: string; duration: number;
  kind: AutoPlanPlacementKind; previousStart?: string; afterDeadline: boolean;
  blockId?: string;
}
export interface AutoPlanPreserved { taskId?: string; title: string; reason: "pinned" | "active" | "commitment" | "outside_horizon" | "excluded_label" | "deferred" }
export interface AutoPlanUnscheduled { taskId: string; title: string; reason: "no_time" | "invalid_duration" }
export interface AutoPlanPreview {
  createdAt: string;
  from: string;
  to: string;
  days: 1 | 2 | 3;
  placements: AutoPlanPlacement[];
  preserved: AutoPlanPreserved[];
  unscheduled: AutoPlanUnscheduled[];
  /** Every candidate is either placed or cancelled when the preview is applied. */
  candidateTaskIds: string[];
  /** Fingerprints make applying and undoing refuse to overwrite intervening edits. */
  expectedSchedules: Record<string, string | null>;
}

interface Interval { start: number; end: number }
const MINUTE = 60_000;
const kindOf = (block: TimeBlock): TimeBlock["kind"] => {
  const explicit = (block as unknown as { kind?: TimeBlock["kind"] }).kind;
  return explicit ?? (block.source === "drag" && block.scope.type === "task" ? "task_schedule" : "allocation");
};
const priorityRank: Record<Priority, number> = { highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 };
const pad = (n: number): string => String(n).padStart(2, "0");
export const localDay = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayAt = (day: string, hhmm: string): Date => {
  const [y, m, d] = day.split("-").map(Number), [h, min] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
};
const addLocalDays = (day: string, amount: number): string => {
  const d = dayAt(day, "00:00"); d.setDate(d.getDate() + amount); return localDay(d);
};
const validRange = (r: TimeMapRange): boolean => /^\d\d:\d\d$/.test(r.start) && /^\d\d:\d\d$/.test(r.end)
  && dayAt("2024-01-01", r.end).getTime() > dayAt("2024-01-01", r.start).getTime();
const merge = (list: Interval[]): Interval[] => {
  const sorted = list.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const item of sorted) {
    const last = out[out.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else out.push({ ...item });
  }
  return out;
};
const subtract = (available: Interval[], busy: Interval[]): Interval[] => {
  let out = merge(available);
  for (const used of merge(busy)) {
    out = out.flatMap((slot) => used.end <= slot.start || used.start >= slot.end ? [slot] : [
      ...(used.start > slot.start ? [{ start: slot.start, end: used.start }] : []),
      ...(used.end < slot.end ? [{ start: used.end, end: slot.end }] : []),
    ]);
  }
  return out;
};
export const scheduleFingerprint = (block: TimeBlock | null | undefined): string | null => block ? JSON.stringify({
  id: block.id, kind: kindOf(block), scope: block.scope, mode: block.mode, selector: block.selector,
  status: block.status, source: block.source, pinned: !!block.pinned,
  gcal_event_id: block.gcal_event_id ?? null, gcal_calendar_id: block.gcal_calendar_id ?? null,
  ...(isAllDaySchedule(block) ? { allDay: true, date: block.date } : { start: block.start, duration: block.duration }),
}) : null;

function latestSchedules(blocks: TimeBlock[]): Map<string, TimeBlock> {
  const out = new Map<string, TimeBlock>();
  for (const block of blocks) {
    if (block.status === "cancelled" || kindOf(block) !== "task_schedule" || block.scope.type !== "task") continue;
    const key = isAllDaySchedule(block) ? block.date : block.start;
    const old = out.get(block.scope.id), oldKey = old && (isAllDaySchedule(old) ? old.date : old.start);
    if (!old || key > oldKey!) out.set(block.scope.id, block);
  }
  return out;
}

/** Pure, deterministic first-fit planner. It never mutates its inputs. */
export function buildAutoPlan(input: AutoPlanInput): AutoPlanPreview {
  const now = new Date(input.now), from = localDay(now), to = addLocalDays(from, input.days - 1);
  const rangeStart = dayAt(from, "00:00").getTime(), rangeEnd = dayAt(addLocalDays(to, 1), "00:00").getTime();
  const roundedNow = new Date(Math.ceil(now.getTime() / (5 * MINUTE)) * 5 * MINUTE).getTime();
  const schedules = latestSchedules(input.blocks), taskIds = new Set(input.tasks.map((x) => x.task.id));
  const excludedLabels = new Set((input.excludedLabels ?? []).map((label) => label.toLocaleLowerCase()));
  const maps = new Map(input.maps.map((x) => [x.id, x]));
  const fallback = maps.get(input.defaultMapId) ?? DEFAULT_TIME_MAP;
  const preserved: AutoPlanPreserved[] = [], candidates: AutoPlanTask[] = [], expectedSchedules: Record<string, string | null> = {};

  for (const item of input.tasks) {
    const schedule = schedules.get(item.task.id), timed = schedule && !isAllDaySchedule(schedule) ? schedule : null;
    const starts = timed ? Date.parse(timed.start) : null;
    const ends = timed ? starts! + timed.duration * MINUTE : null;
    if (item.task.deferUntil && item.task.deferUntil > to) {
      preserved.push({ taskId: item.task.id, title: item.task.title, reason: "deferred" });
    } else if (item.task.labels.some((label) => excludedLabels.has(label.toLocaleLowerCase()))) {
      preserved.push({ taskId: item.task.id, title: item.task.title, reason: "excluded_label" });
    } else if (schedule?.pinned) preserved.push({ taskId: item.task.id, title: item.task.title, reason: "pinned" });
    else if (input.activeTaskId === item.task.id || (starts !== null && starts <= now.getTime() && ends! > now.getTime())) {
      preserved.push({ taskId: item.task.id, title: item.task.title, reason: "active" });
    } else if ((starts !== null && starts >= rangeEnd) || (schedule && isAllDaySchedule(schedule) && schedule.date > to)) {
      preserved.push({ taskId: item.task.id, title: item.task.title, reason: "outside_horizon" });
    } else candidates.push(item);
  }
  for (const item of candidates) expectedSchedules[item.task.id] = scheduleFingerprint(schedules.get(item.task.id));

  // Everything not being replanned is an occupied commitment, including allocations, completed
  // history, pinned work, archived-task blocks, active work, and schedules beyond the horizon.
  const candidateIds = new Set(candidates.map((x) => x.task.id));
  const busy: Interval[] = [];
  for (const block of input.blocks) {
    if (block.status === "cancelled" || isAllDaySchedule(block)) continue;
    const isCandidateSchedule = kindOf(block) === "task_schedule" && block.scope.type === "task" && candidateIds.has(block.scope.id);
    if (isCandidateSchedule) continue;
    const start = Date.parse(block.start);
    if (Number.isFinite(start)) {
      const plannedEnd = start + block.duration * MINUTE;
      const actualEnd = block.status === "completed" && block.completed_at ? Date.parse(block.completed_at) : plannedEnd;
      const end = Number.isFinite(actualEnd) ? Math.max(start, Math.min(plannedEnd, actualEnd)) : plannedEnd;
      if (end > start) busy.push({ start, end });
      if (start < rangeEnd && end > rangeStart
        && (kindOf(block) === "allocation" || !taskIds.has(block.scope.id))) {
        preserved.push({ title: block.scope.title_snapshot, reason: "commitment" });
      }
    }
  }
  for (const event of input.events) {
    if (event.allDay) continue;
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      busy.push({ start, end });
      if (start < rangeEnd && end > rangeStart) preserved.push({ title: event.title, reason: "commitment" });
    }
  }

  candidates.sort((a, b) => {
    const ad = a.task.due ? `${a.task.due}T${a.task.dueTime ?? "23:59"}` : null;
    const bd = b.task.due ? `${b.task.due}T${b.task.dueTime ?? "23:59"}` : null;
    if (ad !== bd) return ad === null ? 1 : bd === null ? -1 : ad.localeCompare(bd);
    const pr = priorityRank[a.task.priority] - priorityRank[b.task.priority];
    return pr || a.task.created.localeCompare(b.task.created) || a.task.id.localeCompare(b.task.id);
  });

  const placements: AutoPlanPlacement[] = [], unscheduled: AutoPlanUnscheduled[] = [];
  for (const item of candidates) {
    const old = schedules.get(item.task.id);
    const oldTimed = old && !isAllDaySchedule(old) ? old : null;
    const duration = oldTimed?.duration ?? (Number.isFinite(item.task.estimate) && item.task.estimate! > 0 ? Math.round(item.task.estimate!) : 30);
    if (duration < 1) { unscheduled.push({ taskId: item.task.id, title: item.task.title, reason: "invalid_duration" }); continue; }
    const map = maps.get(item.timeMapId ?? "") ?? fallback;
    let placed: Interval | null = null;
    for (let offset = 0; offset < input.days && !placed; offset++) {
      const day = addLocalDays(from, offset), date = dayAt(day, "12:00");
      if (item.task.deferUntil && day < item.task.deferUntil) continue;
      const hours = (map.days[date.getDay()] ?? []).filter(validRange).map((r) => ({ start: dayAt(day, r.start).getTime(), end: dayAt(day, r.end).getTime() }));
      const floor = offset === 0 ? roundedNow : rangeStart;
      const free = subtract(hours.map((x) => ({ start: Math.max(x.start, floor), end: x.end })), busy);
      const slot = free.find((x) => x.end - x.start >= duration * MINUTE);
      if (slot) placed = { start: slot.start, end: slot.start + duration * MINUTE };
    }
    if (!placed) { unscheduled.push({ taskId: item.task.id, title: item.task.title, reason: "no_time" }); continue; }
    busy.push(placed);
    const deadline = item.task.due ? dayAt(item.task.due, item.task.dueTime ?? "23:59").getTime() : null;
    placements.push({
      taskId: item.task.id, title: item.task.title, start: new Date(placed.start).toISOString(), duration,
      kind: old ? "moved" : "new", ...(oldTimed ? { previousStart: oldTimed.start } : {}),
      afterDeadline: deadline !== null && placed.end > deadline, ...(old ? { blockId: old.id } : {}),
    });
  }
  return { createdAt: now.toISOString(), from, to, days: input.days, placements, preserved, unscheduled,
    candidateTaskIds: candidates.map((x) => x.task.id), expectedSchedules };
}
