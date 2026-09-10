import { describe, expect, it } from "vitest";
import { buildAutoPlan, type TimeMap } from "../src/autoPlanner";
import type { CalEvent, Task, TimeBlock } from "../src/types";

const map: TimeMap = { id: "default", name: "Work", days: {
  0: [{ start: "09:00", end: "12:00" }], 1: [{ start: "09:00", end: "12:00" }],
  2: [{ start: "09:00", end: "12:00" }], 3: [{ start: "09:00", end: "12:00" }],
  4: [{ start: "09:00", end: "12:00" }], 5: [{ start: "09:00", end: "12:00" }],
  6: [{ start: "09:00", end: "12:00" }],
} };
const task = (id: string, values: Partial<Task> = {}): Task => ({
  id, path: `${id}.md`, title: id, titleInFm: true, status: "todo", priority: "normal", due: null,
  dueTime: null, estimate: null, project: null, parent: null, labels: [], description: "", recurrence: null,
  recurBasis: "due", reminders: [], sortOrder: null, created: `2026-01-0${id.length}`, completed: null,
  cancelled: null, externalId: null, ...values,
});
const schedule = (id: string, taskId: string, start: string, values: Partial<TimeBlock> = {}): TimeBlock => ({
  id, kind: "task_schedule", scope: { type: "task", id: taskId, title_snapshot: taskId }, start,
  duration: 30, mode: "focus", selector: "manual", status: "planned", source: "manual", ...values,
} as TimeBlock);
const plan = (tasks: Task[], blocks: TimeBlock[] = [], events: CalEvent[] = [], days: 1 | 2 | 3 = 1) => buildAutoPlan({
  tasks: tasks.map((task) => ({ task })), blocks, events, maps: [map], defaultMapId: "default",
  now: new Date(2026, 8, 10, 8, 2), days,
});

describe("auto planner", () => {
  it("orders due dates before priority and uses stable priority ties", () => {
    const result = plan([
      task("high", { priority: "highest" }),
      task("due-low", { due: "2026-09-10", priority: "low" }),
      task("due-high", { due: "2026-09-10", priority: "high" }),
    ]);
    expect(result.placements.map((x) => x.taskId)).toEqual(["due-high", "due-low", "high"]);
    expect(result.placements.map((x) => new Date(x.start).getHours())).toEqual([9, 9, 10]);
  });

  it("uses existing duration, then estimate, then a 30 minute fallback", () => {
    const old = schedule("b1", "old", new Date(2026, 8, 9, 10).toISOString(), { duration: 50 });
    const result = plan([task("old", { estimate: 10 }), task("estimated", { estimate: 40 }), task("fallback")], [old]);
    expect(Object.fromEntries(result.placements.map((x) => [x.taskId, x.duration])))
      .toEqual({ old: 50, estimated: 40, fallback: 30 });
  });

  it("subtracts timed events, ignores all-day events, and leaves whole-task overflow unplanned", () => {
    const events: CalEvent[] = [
      { id: "timed", calendarId: "c", title: "Call", start: "2026-09-10T09:30", end: "2026-09-10T11:30", allDay: false, color: "#000", htmlLink: "" },
      { id: "day", calendarId: "c", title: "Reminder", start: "2026-09-10", end: "2026-09-11", allDay: true, color: "#000", htmlLink: "" },
    ];
    const result = plan([task("fits", { estimate: 30 }), task("too-big", { estimate: 60 })], [], events);
    expect(result.placements).toHaveLength(1);
    expect(new Date(result.placements[0].start).getHours()).toBe(9);
    expect(result.unscheduled).toEqual([{ taskId: "too-big", title: "too-big", reason: "no_time" }]);
  });

  it("releases the unused tail of an early-completed block", () => {
    const completed = schedule("history", "finished", new Date(2026, 8, 10, 9).toISOString(), {
      status: "completed", duration: 60, completed_at: new Date(2026, 8, 10, 9, 15).toISOString(),
    });
    const result = plan([task("ready", { estimate: 30 })], [completed]);
    expect(new Date(result.placements[0].start).getHours()).toBe(9);
    expect(new Date(result.placements[0].start).getMinutes()).toBe(15);
  });

  it("preserves pinned and active blocks while recovering missed work", () => {
    const pinned = schedule("pin", "pinned", new Date(2026, 8, 10, 9).toISOString(), { pinned: true, duration: 60 });
    const active = schedule("active", "active", new Date(2026, 8, 10, 8).toISOString(), { duration: 90 });
    const missed = schedule("missed", "missed", new Date(2026, 8, 9, 9).toISOString());
    const result = plan([task("pinned"), task("active"), task("missed")], [pinned, active, missed]);
    expect(result.preserved.map((x) => [x.taskId, x.reason])).toEqual(expect.arrayContaining([["pinned", "pinned"], ["active", "active"]]));
    expect(result.placements.find((x) => x.taskId === "missed")?.kind).toBe("moved");
  });

  it("leaves excluded-label tasks untouched and reserves their scheduled time", () => {
    const waiting = schedule("waiting-block", "waiting", new Date(2026, 8, 10, 9).toISOString(), { duration: 60 });
    const result = buildAutoPlan({
      tasks: [
        { task: task("waiting", { labels: ["Waiting"] }) },
        { task: task("on-hold", { labels: ["on-hold"] }) },
        { task: task("ready") },
      ], blocks: [waiting], events: [], maps: [map], defaultMapId: "default", excludedLabels: ["waiting", "on-hold"],
      now: new Date(2026, 8, 10, 8, 2), days: 1,
    });
    expect(result.preserved).toContainEqual({ taskId: "waiting", title: "waiting", reason: "excluded_label" });
    expect(result.preserved).toContainEqual({ taskId: "on-hold", title: "on-hold", reason: "excluded_label" });
    expect(result.placements.map((placement) => placement.taskId)).toEqual(["ready"]);
    expect(new Date(result.placements[0].start).getHours()).toBe(10);
    expect(result.expectedSchedules).not.toHaveProperty("waiting");
    expect(result.expectedSchedules).not.toHaveProperty("on-hold");
  });

  it("keeps schedules beyond the selected horizon and uses area-specific maps", () => {
    const evening: TimeMap = { id: "evening", name: "Evening", days: { 4: [{ start: "18:00", end: "19:00" }] } };
    const future = schedule("future", "future", new Date(2026, 8, 12, 9).toISOString());
    const result = buildAutoPlan({
      tasks: [{ task: task("future") }, { task: task("personal"), timeMapId: "evening" }], blocks: [future], events: [],
      maps: [map, evening], defaultMapId: "default", now: new Date(2026, 8, 10, 8), days: 1,
    });
    expect(result.preserved).toContainEqual({ taskId: "future", title: "future", reason: "outside_horizon" });
    expect(new Date(result.placements[0].start).getHours()).toBe(18);
  });

  it("preserves deferred tasks for today and makes them eligible on their defer date", () => {
    const deferred = task("later", { estimate: 30, deferUntil: "2026-09-11" });
    const today = plan([deferred]);
    expect(today.placements).toEqual([]);
    expect(today.preserved).toContainEqual({ taskId: "later", title: "later", reason: "deferred" });

    const multiDay = plan([deferred], [], [], 3);
    expect(multiDay.placements).toHaveLength(1);
    expect(new Date(multiDay.placements[0].start).getDate()).toBe(11);
  });

  it("merges overlapping availability and keeps local wall-clock hours across days", () => {
    const overlap: TimeMap = { id: "overlap", name: "Overlap", days: {
      0: [{ start: "09:00", end: "10:00" }, { start: "09:30", end: "11:00" }],
      1: [{ start: "09:00", end: "10:00" }],
    } };
    const result = buildAutoPlan({
      tasks: [{ task: task("a", { estimate: 60 }) }, { task: task("b", { estimate: 60 }) }, { task: task("c", { estimate: 60 }) }],
      blocks: [], events: [], maps: [overlap], defaultMapId: "overlap", now: new Date(2026, 2, 8, 8), days: 2,
    });
    expect(result.placements.map((x) => [localHour(x.start), localDayOfMonth(x.start)]))
      .toEqual([[9, 8], [10, 8], [9, 9]]);
  });
});

const localHour = (iso: string): number => new Date(iso).getHours();
const localDayOfMonth = (iso: string): number => new Date(iso).getDate();
