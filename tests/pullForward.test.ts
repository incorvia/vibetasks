import { describe, expect, it } from "vitest";
import { buildPullForward, meetingOccurrenceKey } from "../src/pullForward";
import type { CalEvent, Task, TimeBlock } from "../src/types";
import type { TimeMap } from "../src/autoPlanner";

const map: TimeMap = { id: "default", name: "Work", days: Object.fromEntries(
  Array.from({ length: 7 }, (_, day) => [day, [{ start: "09:00", end: "17:00" }]]),
) };
const task = (id: string, values: Partial<Task> = {}): Task => ({ id, path: `${id}.md`, title: id, titleInFm: true, status: "todo", priority: "normal",
  due: null, dueTime: null, estimate: 30, project: null, parent: null, labels: [], description: "", recurrence: null,
  recurBasis: "due", reminders: [], sortOrder: null, created: "2026-09-10", completed: null, cancelled: null, externalId: null,
  ...values });
const block = (id: string, taskId: string, hour: number, values: Partial<TimeBlock> = {}): TimeBlock => ({
  id, kind: "task_schedule", scope: { type: "task", id: taskId, title_snapshot: taskId },
  start: new Date(2026, 8, 10, hour).toISOString(), duration: 30, mode: "focus", selector: "manual",
  status: "planned", source: "auto", ...values,
} as TimeBlock);
const event: CalEvent = { id: "meet", calendarId: "cal", title: "Meeting", start: "2026-09-10T10:00:00",
  end: "2026-09-10T10:30:00", allDay: false, color: "#888", htmlLink: "" };

describe("pull-forward planner", () => {
  it("closes gaps in accepted order around a fixed meeting", () => {
    const tasks = [task("a"), task("b"), task("c")];
    const result = buildPullForward({ now: new Date(2026, 8, 10, 9, 15), day: "2026-09-10",
      tasks: tasks.map((task) => ({ task })), blocks: [block("a", "a", 10), block("b", "b", 11), block("c", "c", 12)],
      events: [event], maps: [map], defaultMapId: "default" });
    expect(result.moves.map((move) => [move.taskId, new Date(move.to).getHours(), new Date(move.to).getMinutes()]))
      .toEqual([["a", 9, 15], ["b", 10, 30], ["c", 11, 0]]);
  });

  it("preserves manual, pinned, skipped and duration values", () => {
    const tasks = [task("manual"), task("pinned"), task("skipped"), task("free")];
    const blocks = [
      block("manual", "manual", 9, { source: "manual" }), block("pinned", "pinned", 10, { pinned: true }),
      block("skipped", "skipped", 11), block("free", "free", 12, { duration: 45 }),
    ];
    const result = buildPullForward({ now: new Date(2026, 8, 10, 9), day: "2026-09-10", tasks: tasks.map((task) => ({ task })),
      blocks, events: [], maps: [map], defaultMapId: "default", skippedTaskIds: ["skipped"] });
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({ taskId: "free", duration: 45 });
    expect(new Date(result.moves[0].to).getHours()).toBe(10);
    expect(new Date(result.moves[0].to).getMinutes()).toBe(30);
  });

  it("releases a locally completed meeting occurrence", () => {
    const result = buildPullForward({ now: new Date(2026, 8, 10, 10), day: "2026-09-10", tasks: [{ task: task("a") }],
      blocks: [block("a", "a", 11)], events: [event], maps: [map], defaultMapId: "default",
      completedEventKeys: [meetingOccurrenceKey(event)] });
    expect(new Date(result.moves[0].to).getHours()).toBe(10);
  });

  it("does not pull a task forward before its defer date", () => {
    const deferred = task("later", { deferUntil: "2026-09-11" });
    const result = buildPullForward({ now: new Date(2026, 8, 10, 9), day: "2026-09-10", tasks: [{ task: deferred }],
      blocks: [block("later", "later", 11)], events: [], maps: [map], defaultMapId: "default" });
    expect(result.moves).toEqual([]);
  });

  it("pushes accepted work later after a late Blitz transition", () => {
    const tasks = [task("a"), task("b")];
    const result = buildPullForward({ now: new Date(2026, 8, 10, 10, 20), day: "2026-09-10",
      tasks: tasks.map((task) => ({ task })), blocks: [block("a", "a", 10), block("b", "b", 11)],
      events: [], maps: [map], defaultMapId: "default" });

    expect(result.moves.map((move) => [move.taskId, new Date(move.to).getHours(), new Date(move.to).getMinutes()]))
      .toEqual([["a", 10, 20], ["b", 10, 50]]);
  });

  it("keeps an on-time queue steady", () => {
    const tasks = [task("a"), task("b")];
    const result = buildPullForward({ now: new Date(2026, 8, 10, 10), day: "2026-09-10",
      tasks: tasks.map((task) => ({ task })), blocks: [block("a", "a", 10), block("b", "b", 10, {
        start: new Date(2026, 8, 10, 10, 30).toISOString(),
      })],
      events: [], maps: [map], defaultMapId: "default" });

    expect(result.moves).toEqual([]);
  });

  it("releases the skipped task slot before reflowing the next task", () => {
    const tasks = [task("skip"), task("next")];
    const result = buildPullForward({ now: new Date(2026, 8, 10, 10, 15), day: "2026-09-10",
      tasks: tasks.map((task) => ({ task })), blocks: [block("skip", "skip", 10), block("next", "next", 11)],
      events: [], maps: [map], defaultMapId: "default", skippedTaskIds: ["skip"] });

    expect(result.moves).toHaveLength(1);
    expect(result.moves[0].taskId).toBe("next");
    expect(new Date(result.moves[0].to).getTime()).toBe(new Date(2026, 8, 10, 10, 15).getTime());
  });

  it("never moves the active task while reflowing around its remaining estimate", () => {
    const tasks = [task("active"), task("next")];
    const active = block("active", "active", 10, { duration: 60 });
    const result = buildPullForward({ now: new Date(2026, 8, 10, 10, 20), day: "2026-09-10",
      tasks: tasks.map((task) => ({ task })), blocks: [active, block("next", "next", 12)],
      events: [], maps: [map], defaultMapId: "default", activeTaskId: "active" });

    expect(result.moves.map((move) => move.taskId)).toEqual(["next"]);
    expect(new Date(result.moves[0].to).getHours()).toBe(11);
  });

  it("never reflows work into an ongoing calendar event", () => {
    const lunch: CalEvent = { ...event, id: "lunch", title: "Lunch", start: "2026-09-10T13:00:00", end: "2026-09-10T13:30:00" };
    const result = buildPullForward({ now: new Date(2026, 8, 10, 13, 20), day: "2026-09-10",
      tasks: [{ task: task("next") }], blocks: [block("next", "next", 14)], events: [lunch],
      maps: [map], defaultMapId: "default" });

    expect(new Date(result.moves[0].to).getTime()).toBe(new Date(2026, 8, 10, 13, 30).getTime());
  });
});
