import { describe, expect, it, vi } from "vitest";
import { NOW_RUN_KEY, NowController } from "../src/nowController";
import { addDays } from "../src/calendarModel";
import { localDay } from "../src/autoPlanner";
import type { CalEvent, Task, TimeBlock } from "../src/types";

const event = (id: string, start: string, end: string): CalEvent => ({
  id, calendarId: "calendar", title: id, start, end, allDay: false, color: "#888", htmlLink: "",
});

describe("Opal Now queue", () => {
  it("treats a restored active timer as running and resumes the same focus after a real pause", async () => {
    const now = new Date(), day = localDay(now);
    const task: Task = {
      id: "active", path: "active.md", title: "Active", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 120, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: day, completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "block", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: new Date(now.getTime() - 60 * 60_000).toISOString(), duration: 120,
      mode: "focus", selector: "manual", status: "planned", source: "auto",
    };
    let active: { session_id: string; task_id: string; started_at: string; block_id: string } | null = {
      session_id: "session", task_id: task.id, started_at: block.start, block_id: block.id,
    };
    const stop = vi.fn(async () => { active = null; });
    const startTask = vi.fn(async (taskId: string, blockId?: string) => {
      active = { session_id: "resumed", task_id: taskId, started_at: new Date().toISOString(), block_id: blockId ?? "" };
    });
    const plugin = {
      app: {
        loadLocalStorage: (key: string) => key === NOW_RUN_KEY ? { date: day, status: "running", skipped: [] } : null,
        saveLocalStorage: () => undefined,
      },
      timeStore: { blocksIn: () => [block], block: () => block, isMeetingComplete: () => false },
      index: { getById: () => task }, workTimer: { active: () => active, stop, startTask },
      gcalFeed: { eventsIn: () => [] },
    };
    const controller = new NowController(plugin as never);

    expect(controller.snapshot(now).status).toBe("running");
    await controller.pause();
    expect(controller.snapshot(now).status).toBe("paused");
    expect(controller.snapshot(now).current?.title).toBe("Active");

    await controller.resume();
    expect(startTask).toHaveBeenCalledWith(task.id, block.id);
    expect(controller.snapshot(now).status).toBe("running");
  });

  it("keeps elapsed calendar events out of Up next", () => {
    const day = localDay(new Date());
    const events = [
      event("past", `${day}T08:00:00`, `${day}T09:00:00`),
      event("current", `${day}T09:30:00`, `${day}T10:30:00`),
      event("future", `${day}T11:00:00`, `${day}T11:30:00`),
    ];
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [], isMeetingComplete: () => false },
      index: { getById: () => undefined }, workTimer: { active: () => null },
      gcalFeed: { eventsIn: () => events },
    };
    const controller = new NowController(plugin as never);
    const snapshot = controller.snapshot(new Date(`${day}T10:00:00`));
    expect(snapshot.current?.title).toBe("current");
    expect(snapshot.upcoming.map((item) => item.title)).toEqual(["future"]);
    expect(snapshot.pastEvents.map((item) => item.title)).toEqual(["past"]);
  });

  it("omits an all-day event on its exclusive end date", () => {
    const day = localDay(new Date());
    const ended: CalEvent = {
      ...event("ended", addDays(day, -2), day), allDay: true,
    };
    const active: CalEvent = {
      ...event("active", addDays(day, -1), addDays(day, 1)), allDay: true,
    };
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [], isMeetingComplete: () => false },
      index: { getById: () => undefined }, workTimer: { active: () => null },
      gcalFeed: { eventsIn: () => [ended, active] },
    };

    const snapshot = new NowController(plugin as never).snapshot();

    expect(snapshot.allDay).toEqual([active]);
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
