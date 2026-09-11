import { localDay, type AutoPlanInput, type AutoPlanPreview } from "./autoPlanner";
import { isAllDaySchedule, type CalEvent, type TimeBlock } from "./types";

const MINUTE = 60_000;

export type AutoPlanComparisonKind = "task" | "allocation" | "event";
export type AutoPlanComparisonChange = "unchanged" | "new" | "moved" | "moving" | "removed";

export interface AutoPlanComparisonItem {
  id: string;
  title: string;
  kind: AutoPlanComparisonKind;
  change: AutoPlanComparisonChange;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  pinned?: boolean;
  completed?: boolean;
  afterDeadline?: boolean;
  color?: string;
}

export interface AutoPlanAllDayItem {
  id: string;
  title: string;
  kind: AutoPlanComparisonKind;
  change: AutoPlanComparisonChange;
  pinned?: boolean;
  completed?: boolean;
  color?: string;
}

export interface AutoPlanDayComparison {
  current: AutoPlanComparisonItem[];
  proposed: AutoPlanComparisonItem[];
  currentAllDay: AutoPlanAllDayItem[];
  proposedAllDay: AutoPlanAllDayItem[];
}

const dayStart = (day: string): Date => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 0, 0, 0, 0);
};

const minutesIntoDay = (value: Date, day: string): number => {
  const valueDay = localDay(value);
  if (valueDay < day) return 0;
  if (valueDay > day) return 1440;
  const minutes = value.getHours() * 60 + value.getMinutes() + value.getSeconds() / 60;
  return Math.max(0, Math.min(1440, Math.round(minutes)));
};

const timedItem = (values: Omit<AutoPlanComparisonItem, "startMin" | "endMin">, day: string): AutoPlanComparisonItem | null => {
  const start = new Date(values.start), end = new Date(values.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const startOfDay = dayStart(day), endOfDay = new Date(startOfDay); endOfDay.setDate(endOfDay.getDate() + 1);
  if (start >= endOfDay || end <= startOfDay) return null;
  const startMin = minutesIntoDay(start, day), endMin = minutesIntoDay(end, day);
  return endMin > startMin ? { ...values, startMin, endMin } : null;
};

const blockChange = (block: TimeBlock, candidateIds: Set<string>, movedIds: Set<string>): AutoPlanComparisonChange => {
  if (block.kind !== "task_schedule" || block.scope.type !== "task" || !candidateIds.has(block.scope.id)) return "unchanged";
  return movedIds.has(block.scope.id) ? "moving" : "removed";
};

const blockAllDay = (block: TimeBlock, change: AutoPlanComparisonChange): AutoPlanAllDayItem => ({
  id: block.id, title: block.scope.title_snapshot,
  kind: block.kind === "allocation" ? "allocation" : "task", change,
  ...(block.pinned ? { pinned: true } : {}), ...(block.status === "completed" ? { completed: true } : {}),
});

const eventOccursAllDay = (event: CalEvent, day: string): boolean => event.allDay && event.start <= day && event.end > day;

/** Build the two calendar columns from exactly the input used to create the preview. */
export function buildAutoPlanDayComparison(input: AutoPlanInput, preview: AutoPlanPreview, day: string): AutoPlanDayComparison {
  const candidateIds = new Set(preview.candidateTaskIds);
  const movedIds = new Set(preview.placements.filter((placement) => placement.kind === "moved").map((placement) => placement.taskId));
  const current: AutoPlanComparisonItem[] = [], proposed: AutoPlanComparisonItem[] = [];
  const currentAllDay: AutoPlanAllDayItem[] = [], proposedAllDay: AutoPlanAllDayItem[] = [];

  for (const block of input.blocks) {
    if (block.status === "cancelled") continue;
    const change = blockChange(block, candidateIds, movedIds);
    const isCandidateSchedule = change === "moving" || change === "removed";
    if (isAllDaySchedule(block)) {
      if (block.date !== day) continue;
      currentAllDay.push(blockAllDay(block, change));
      if (!isCandidateSchedule) proposedAllDay.push(blockAllDay(block, "unchanged"));
      continue;
    }
    const startMs = Date.parse(block.start);
    if (!Number.isFinite(startMs)) continue;
    const plannedEndMs = startMs + block.duration * MINUTE;
    const end = new Date(plannedEndMs).toISOString();
    const item = timedItem({
      id: block.id, title: block.scope.title_snapshot,
      kind: block.kind === "allocation" ? "allocation" : "task", change,
      start: block.start, end,
      ...(block.pinned ? { pinned: true } : {}), ...(block.status === "completed" ? { completed: true } : {}),
    }, day);
    if (!item) continue;
    current.push(item);
    if (!isCandidateSchedule) {
      const completedMs = block.status === "completed" && block.completed_at ? Date.parse(block.completed_at) : plannedEndMs;
      const proposedEndMs = Number.isFinite(completedMs) ? Math.max(startMs, Math.min(plannedEndMs, completedMs)) : plannedEndMs;
      const proposedItem = timedItem({ ...item, change: "unchanged", start: block.start, end: new Date(proposedEndMs).toISOString() }, day);
      if (proposedItem) proposed.push(proposedItem);
    }
  }

  for (const event of input.events) {
    if (eventOccursAllDay(event, day)) {
      const item: AutoPlanAllDayItem = { id: `event:${event.calendarId}:${event.id}`, title: event.title, kind: "event", change: "unchanged", color: event.color };
      currentAllDay.push(item); proposedAllDay.push({ ...item });
      continue;
    }
    if (event.allDay) continue;
    const item = timedItem({
      id: `event:${event.calendarId}:${event.id}`, title: event.title, kind: "event", change: "unchanged",
      start: event.start, end: event.end, color: event.color,
    }, day);
    if (item) { current.push(item); proposed.push({ ...item }); }
  }

  for (const placement of preview.placements) {
    const end = new Date(Date.parse(placement.start) + placement.duration * MINUTE).toISOString();
    const item = timedItem({
      id: `proposal:${placement.taskId}`, title: placement.title, kind: "task", change: placement.kind,
      start: placement.start, end, ...(placement.afterDeadline ? { afterDeadline: true } : {}),
    }, day);
    if (item) proposed.push(item);
  }

  const order = (a: AutoPlanComparisonItem, b: AutoPlanComparisonItem): number => a.startMin - b.startMin || a.endMin - b.endMin || a.title.localeCompare(b.title);
  const allDayOrder = (a: AutoPlanAllDayItem, b: AutoPlanAllDayItem): number => a.title.localeCompare(b.title);
  current.sort(order); proposed.sort(order); currentAllDay.sort(allDayOrder); proposedAllDay.sort(allDayOrder);
  return { current, proposed, currentAllDay, proposedAllDay };
}
