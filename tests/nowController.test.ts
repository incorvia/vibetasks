import { describe, expect, it, vi } from "vitest";
import { NowController } from "../src/nowController";
import type { CalEvent, Task, TimeBlock } from "../src/types";

const event = (id: string, start: string, end: string): CalEvent => ({
  id, calendarId: "calendar", title: id, start, end, allDay: false, color: "#888", htmlLink: "",
});

describe("Opal Now queue", () => {
  it("keeps elapsed calendar events out of Up next", () => {
    const events = [
      event("past", "2026-09-10T08:00:00", "2026-09-10T09:00:00"),
      event("current", "2026-09-10T09:30:00", "2026-09-10T10:30:00"),
      event("future", "2026-09-10T11:00:00", "2026-09-10T11:30:00"),
    ];
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [], isMeetingComplete: () => false },
      index: { getById: () => undefined }, workTimer: { active: () => null },
      gcalFeed: { eventsIn: () => events },
    };
    const controller = new NowController(plugin as never);
    const snapshot = controller.snapshot(new Date("2026-09-10T10:00:00"));
    expect(snapshot.current?.title).toBe("current");
    expect(snapshot.upcoming.map((item) => item.title)).toEqual(["future"]);
    expect(snapshot.pastEvents.map((item) => item.title)).toEqual(["past"]);
  });

  it("keeps a task deferred beyond today in Parked today even without local run state", () => {
    const task: Task = {
      id: "parked", path: "parked.md", title: "Parked", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 30, deferUntil: "9999-12-31", project: null, parent: null, labels: [],
      description: "", recurrence: null, recurBasis: "due", reminders: [], sortOrder: null, created: "2026-09-10",
      completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "block", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: "2026-09-10T11:00:00", duration: 30, mode: "focus", selector: "manual", status: "planned", source: "auto",
    };
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [block], isMeetingComplete: () => false },
      index: { getById: () => task }, workTimer: { active: () => null },
      gcalFeed: { eventsIn: () => [] },
    };
    const controller = new NowController(plugin as never);
    const snapshot = controller.snapshot(new Date("2026-09-10T10:00:00"));
    expect(snapshot.upcoming).toEqual([]);
    expect(snapshot.skipped.map((item) => item.title)).toEqual(["Parked"]);
  });

  it("parks the current task until tomorrow and stops its timer", async () => {
    const task: Task = {
      id: "active", path: "active.md", title: "Active", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 30, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: "2026-09-10", completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "block", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: "2026-09-10T11:00:00", duration: 30, mode: "focus", selector: "manual", status: "planned", source: "auto",
    };
    let active: { session_id: string; task_id: string; started_at: string; block_id: string } | null = {
      session_id: "session", task_id: task.id, started_at: "2026-09-10T11:00:00", block_id: block.id,
    };
    const stop = vi.fn(async () => { active = null; });
    const setTaskDeferUntil = vi.fn(async () => undefined);
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [block], isMeetingComplete: () => false },
      index: { getById: () => task }, workTimer: { active: () => active, stop },
      gcalFeed: { eventsIn: () => [] }, setTaskDeferUntil,
    };
    const expected = new Date(); expected.setDate(expected.getDate() + 1);
    const expectedDay = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, "0")}-${String(expected.getDate()).padStart(2, "0")}`;
    const controller = new NowController(plugin as never);

    await controller.parkCurrent();

    expect(stop).toHaveBeenCalledOnce();
    expect(setTaskDeferUntil).toHaveBeenCalledWith(task, expectedDay);
    expect(controller.snapshot().skipped.map((item) => item.title)).toEqual(["Active"]);
  });
});
