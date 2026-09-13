import { describe, expect, it, vi } from "vitest";
import { NOW_RUN_KEY, NowController } from "../src/nowController";
import { addDays } from "../src/calendarModel";
import { localDay, type TimeMap } from "../src/autoPlanner";
import { meetingOccurrenceKey } from "../src/pullForward";
import type { CalEvent, Task, TimeBlock } from "../src/types";

const event = (id: string, start: string, end: string): CalEvent => ({
  id, calendarId: "calendar", title: id, start, end, allDay: false, color: "#888", htmlLink: "",
});

describe("Opal Now queue", () => {
  it("defaults Blitz on and persists an explicit opt-out", () => {
    const saveLocalStorage = vi.fn();
    const controller = new NowController({ app: { loadLocalStorage: () => null, saveLocalStorage } } as never);

    expect(controller.blitzEnabled()).toBe(true);
    saveLocalStorage.mockClear();
    controller.setBlitzEnabled(false);

    expect(controller.blitzEnabled()).toBe(false);
    expect(saveLocalStorage).toHaveBeenCalledWith(NOW_RUN_KEY, expect.objectContaining({ blitz: false }));
  });

  it("treats a task timer started outside Opal Now as Focus", async () => {
    const now = new Date(), day = localDay(now);
    const task: Task = {
      id: "direct", path: "direct.md", title: "Direct timer", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 60, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: day, completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "scheduled", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: new Date(now.getTime() - 10 * 60_000).toISOString(), duration: 60,
      mode: "focus", selector: "manual", status: "planned", source: "manual",
    };
    let active: { session_id: string; task_id: string; started_at: string } | null = {
      session_id: "direct-session", task_id: task.id, started_at: now.toISOString(),
    };
    const completeTask = vi.fn(async () => { active = null; task.status = "done"; });
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [block], block: () => block, isMeetingComplete: () => false },
      index: { getById: () => task }, workTimer: { active: () => active, completeTask },
      gcalFeed: { eventsIn: () => [] },
    };
    const controller = new NowController(plugin as never);

    expect(controller.blitzEnabled()).toBe(true);
    expect(controller.snapshot(now)).toMatchObject({ status: "running", blitz: false });

    await controller.completeCurrent();
    expect(completeTask).toHaveBeenCalledWith(task.id);
    expect(controller.snapshot(now).status).toBe("stopped");
  });

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

  it("features an ongoing scheduled task while stopped and starts it with Focus", async () => {
    const now = new Date(), day = localDay(now);
    const task: Task = {
      id: "current", path: "current.md", title: "Current task", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 30, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: day, completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "current-block", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: new Date(now.getTime() - 10 * 60_000).toISOString(), duration: 30,
      mode: "focus", selector: "manual", status: "planned", source: "auto",
    };
    const startTask = vi.fn(async () => undefined);
    const plugin = {
      app: { loadLocalStorage: () => null, saveLocalStorage: () => undefined },
      timeStore: { blocksIn: () => [block], block: () => block, isMeetingComplete: () => false },
      index: { getById: () => task },
      workTimer: { active: () => null, startTask, needsResolution: () => false },
      gcalFeed: { eventsIn: () => [] },
    };
    const controller = new NowController(plugin as never);

    const snapshot = controller.snapshot(now);
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.current?.title).toBe("Current task");
    expect(snapshot.upcoming).toEqual([]);

    await controller.start(false);
    expect(startTask).toHaveBeenCalledWith(task.id, block.id);
  });

  it("releases a fixed calendar event when its end time passes", () => {
    const day = localDay(new Date());
    const lunch = event("lunch", `${day}T12:00:00`, `${day}T13:00:00`);
    const plugin = {
      app: {
        loadLocalStorage: (key: string) => key === NOW_RUN_KEY
          ? { date: day, status: "running", skipped: [], fixedKey: `event:${meetingOccurrenceKey(lunch)}` }
          : null,
        saveLocalStorage: () => undefined,
      },
      timeStore: { blocksIn: () => [], isMeetingComplete: () => false },
      index: { getById: () => undefined }, workTimer: { active: () => null },
      gcalFeed: { eventsIn: () => [lunch] },
    };

    const snapshot = new NowController(plugin as never).snapshot(new Date(`${day}T13:01:00`));

    expect(snapshot.current).toBeNull();
    expect(snapshot.pastEvents.map((item) => item.title)).toEqual(["lunch"]);
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

  it("reflows once and starts the next task after a Blitz skip", async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 10, 10, 15);
    vi.setSystemTime(now);
    const day = localDay(now);
    const makeTask = (id: string): Task => ({
      id, path: `${id}.md`, title: id, titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 30, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: day, completed: null, cancelled: null, externalId: null,
    });
    const current = makeTask("current"), next = makeTask("next");
    const makeBlock = (id: string, task: Task, hour: number): TimeBlock => ({
      id, kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: new Date(2026, 8, 10, hour).toISOString(), duration: 30, mode: "focus", selector: "manual",
      status: "planned", source: "auto",
    });
    const currentBlock = makeBlock("current-block", current, 10), nextBlock = makeBlock("next-block", next, 11);
    const blocks = [currentBlock, nextBlock];
    let active: { session_id: string; task_id: string; started_at: string; block_id: string } | null = {
      session_id: "session", task_id: current.id, started_at: currentBlock.start, block_id: currentBlock.id,
    };
    const storage = new Map<string, unknown>([[NOW_RUN_KEY, { date: day, status: "running", skipped: [] }]]);
    const map: TimeMap = { id: "default", name: "Work", days: { 4: [{ start: "09:00", end: "17:00" }] } };
    const updateBlocks = vi.fn(async (_date: string, changes: { id: string; patch: { start?: string } }[]) => {
      for (const change of changes) {
        const found = blocks.find((block) => block.id === change.id);
        if (found && !found.allDay && change.patch.start) found.start = change.patch.start;
      }
    });
    const startTask = vi.fn(async (taskId: string, blockId?: string) => {
      active = { session_id: "next-session", task_id: taskId, started_at: new Date().toISOString(), block_id: blockId ?? "" };
    });
    const plugin = {
      app: {
        loadLocalStorage: (key: string) => storage.get(key) ?? null,
        saveLocalStorage: (key: string, value: unknown) => { storage.set(key, value); },
        vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null },
      },
      settings: { timeMaps: [map], defaultTimeMapId: "default", autoPlanExcludedLabels: [] },
      timeStore: {
        blocksIn: () => blocks, blocks: () => blocks, block: (id: string) => blocks.find((block) => block.id === id) ?? null,
        isMeetingComplete: () => false, meetingCompletions: () => [], updateBlocks,
      },
      index: { getById: (id: string) => [current, next].find((task) => task.id === id), all: () => [current, next] },
      workTimer: { active: () => active, stop: vi.fn(async () => { active = null; }), startTask, needsResolution: () => false },
      gcalFeed: { eventsIn: () => [] }, setTaskDeferUntil: vi.fn(async () => undefined),
    };

    try {
      const controller = new NowController(plugin as never);
      await controller.skipCurrent();

      expect(updateBlocks).toHaveBeenCalledOnce();
      expect(updateBlocks.mock.calls[0][1]).toHaveLength(1);
      expect(new Date(nextBlock.start).getTime()).toBe(now.getTime());
      expect(startTask).toHaveBeenCalledWith(next.id, nextBlock.id);
      expect(plugin.setTaskDeferUntil).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replans an already half-elapsed block before starting Blitz", async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 10, 10, 15);
    vi.setSystemTime(now);
    const day = localDay(now);
    const task: Task = {
      id: "current", path: "current.md", title: "Current", titleInFm: true, status: "todo", priority: "normal",
      due: null, dueTime: null, estimate: 30, project: null, parent: null, labels: [], description: "", recurrence: null,
      recurBasis: "due", reminders: [], sortOrder: null, created: day, completed: null, cancelled: null, externalId: null,
    };
    const block: TimeBlock = {
      id: "block", kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
      start: new Date(2026, 8, 10, 10).toISOString(), duration: 30, mode: "focus", selector: "manual",
      status: "planned", source: "auto",
    };
    let active: { session_id: string; task_id: string; started_at: string; block_id: string } | null = null;
    const updateBlocks = vi.fn(async (_date: string, changes: { id: string; patch: { start?: string } }[]) => {
      if (changes[0]?.patch.start) block.start = changes[0].patch.start;
    });
    const startTask = vi.fn(async (taskId: string, blockId?: string) => {
      active = { session_id: "session", task_id: taskId, started_at: new Date().toISOString(), block_id: blockId ?? "" };
    });
    const plugin = {
      app: {
        loadLocalStorage: () => null, saveLocalStorage: () => undefined,
        vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null },
      },
      settings: { timeMaps: [{ id: "default", name: "Work", days: { 4: [{ start: "09:00", end: "17:00" }] } }], defaultTimeMapId: "default", autoPlanExcludedLabels: [] },
      timeStore: {
        blocksIn: () => [block], blocks: () => [block], block: () => block, isMeetingComplete: () => false,
        meetingCompletions: () => [], updateBlocks,
      },
      index: { getById: () => task, all: () => [task] },
      workTimer: { active: () => active, stop: vi.fn(), startTask, needsResolution: () => false },
      gcalFeed: { eventsIn: () => [] },
    };

    try {
      const controller = new NowController(plugin as never);
      await controller.start(true);

      expect(updateBlocks).toHaveBeenCalledOnce();
      expect(new Date(block.start).getTime()).toBe(now.getTime());
      expect(startTask).toHaveBeenCalledWith(task.id, block.id);
    } finally {
      vi.useRealTimers();
    }
  });
});
