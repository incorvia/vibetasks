import { isAllDaySchedule, type CalEvent, type Task, type TimeBlock } from "./types";
import { blockKind } from "./timeService";
import type { TimeMap } from "./autoPlanner";

const MIN = 60_000;
type Interval = { start: number; end: number };
export interface PullForwardTask { task: Task; timeMapId?: string | null }
export interface PullForwardInput {
  now: Date; day: string; tasks: PullForwardTask[]; blocks: TimeBlock[]; events: CalEvent[];
  maps: TimeMap[]; defaultMapId: string; skippedTaskIds?: Iterable<string>; activeTaskId?: string | null;
  completedEventKeys?: Iterable<string>; excludedLabels?: string[];
}
export interface PullForwardMove { id: string; taskId: string; from: string; to: string; duration: number }
export interface PullForwardPreview { day: string; createdAt: string; moves: PullForwardMove[] }

export const meetingOccurrenceKey = (event: Pick<CalEvent, "calendarId" | "id" | "start">): string =>
  `${event.calendarId}\u0000${event.id}\u0000${event.start}`;

const dayAt = (day: string, hhmm: string): number => {
  const [year, month, date] = day.split("-").map(Number), [hour, minute] = hhmm.split(":").map(Number);
  return new Date(year, month - 1, date, hour, minute).getTime();
};
const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Reflow accepted auto-planned work after a Blitz transition.
 *
 * The accepted order is stable, but its remaining blocks may move in either direction: finishing
 * early closes the new gap, while finishing late pushes the queue forward. The active task and
 * every manual, pinned, or excluded block remain fixed.
 */
export function buildPullForward(input: PullForwardInput): PullForwardPreview {
  const skipped = new Set(input.skippedTaskIds ?? []), completedEvents = new Set(input.completedEventKeys ?? []);
  const excludedLabels = new Set((input.excludedLabels ?? []).map((label) => label.toLocaleLowerCase()));
  const taskById = new Map(input.tasks.map((item) => [item.task.id, item]));
  const mapById = new Map(input.maps.map((map) => [map.id, map]));
  const fallback = mapById.get(input.defaultMapId) ?? input.maps[0];
  const startOfDay = dayAt(input.day, "00:00"), endOfDay = dayAt(input.day, "24:00");
  // Use the transition instant rather than a future grid line: Blitz should be able to start the
  // next task immediately after Done/Skip, including when the click has non-zero seconds.
  const floor = input.now.getTime();
  const releasedTaskIds = new Set([...skipped]);
  for (const item of input.tasks) if (item.task.deferUntil && item.task.deferUntil > input.day) releasedTaskIds.add(item.task.id);
  const candidates = input.blocks.filter((block) => !isAllDaySchedule(block)
    && blockKind(block) === "task_schedule" && block.scope.type === "task"
    && block.status === "planned" && block.source === "auto" && !block.pinned
    && !skipped.has(block.scope.id) && block.scope.id !== input.activeTaskId
    && Date.parse(block.start) >= startOfDay && Date.parse(block.start) < endOfDay
    && taskById.has(block.scope.id)
    && (!taskById.get(block.scope.id)!.task.deferUntil || taskById.get(block.scope.id)!.task.deferUntil! <= input.day)
    && !taskById.get(block.scope.id)!.task.labels.some((label) => excludedLabels.has(label.toLocaleLowerCase())))
    .sort((a, b) => Date.parse((a as Extract<TimeBlock, { start: string }>).start) - Date.parse((b as Extract<TimeBlock, { start: string }>).start));
  const candidateIds = new Set(candidates.map((block) => block.id));
  const busy: Interval[] = [];
  for (const block of input.blocks) {
    if (isAllDaySchedule(block) || block.status !== "planned" || candidateIds.has(block.id)) continue;
    // A task explicitly skipped/deferred by the transition relinquishes its old schedule slot.
    if (blockKind(block) === "task_schedule" && block.scope.type === "task" && releasedTaskIds.has(block.scope.id)) continue;
    const start = Date.parse(block.start), end = start + block.duration * MIN;
    if (end > floor && start < endOfDay) busy.push({ start, end });
  }
  for (const event of input.events) {
    if (event.allDay || completedEvents.has(meetingOccurrenceKey(event))) continue;
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > floor && start < endOfDay) busy.push({ start, end });
  }

  const moves: PullForwardMove[] = [];
  let cursor = Math.max(floor, startOfDay);
  for (const block of candidates) {
    if (isAllDaySchedule(block)) continue;
    const original = Date.parse(block.start), duration = block.duration * MIN;
    const task = taskById.get(block.scope.id)!;
    const map = mapById.get(task.timeMapId ?? "") ?? fallback;
    const ranges = (map?.days[new Date(startOfDay + 12 * 60 * MIN).getDay()] ?? [])
      .map((range) => ({ start: dayAt(input.day, range.start), end: dayAt(input.day, range.end) }))
      .filter((range) => range.end > range.start);
    let found: number | null = null;
    for (const range of ranges) {
      let probe = Math.max(cursor, floor, range.start);
      while (probe + duration <= range.end) {
        const hit = busy.filter((slot) => overlaps({ start: probe, end: probe + duration }, slot)).sort((a, b) => a.end - b.end)[0];
        if (!hit) { found = probe; break; }
        probe = Math.max(probe + MIN, hit.end);
      }
      if (found !== null) break;
    }
    const placed = found ?? original;
    busy.push({ start: placed, end: placed + duration });
    cursor = placed + duration;
    if (placed !== original) moves.push({ id: block.id, taskId: block.scope.id, from: block.start, to: new Date(placed).toISOString(), duration: block.duration });
  }
  return { day: input.day, createdAt: input.now.toISOString(), moves };
}
