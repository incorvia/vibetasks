import { describe, expect, it, vi } from "vitest";
import { SchedulingError, SchedulingService } from "../src/schedulingService";
import { scheduleFingerprint } from "../src/autoPlanner";
import { WorkTimerService } from "../src/workTimerService";
import type { TimerService, TimeStore } from "../src/timeService";
import { isAllDaySchedule, type Task, type TimeBlock, type WorkSession } from "../src/types";

const task = (id: string, estimate = 45): Task => ({ id, title: `Task ${id}`, estimate, status: "open" } as Task);

function schedulingFixture() {
  const blocks = new Map<string, TimeBlock>();
  let nextId = 1;
  const store = {
    blocksFor: (scope: { id: string }) => [...blocks.values()].filter((block) => block.scope.id === scope.id),
    block: (id: string) => blocks.get(id) ?? null,
    addBlock: async (input: Omit<TimeBlock, "id" | "status">) => {
      const value = { ...input, id: `b${nextId++}`, status: "planned" as const };
      blocks.set(value.id, value); return value;
    },
    updateBlock: async (id: string, patch: Partial<TimeBlock>) => {
      const current = blocks.get(id); if (!current) return;
      const updated = { ...current, ...patch } as TimeBlock & { date?: string; start?: string; duration?: number; allDay?: boolean };
      if (isAllDaySchedule(updated)) { delete updated.start; delete updated.duration; }
      else { delete updated.date; delete updated.allDay; }
      blocks.set(id, updated);
    },
    cancelFutureBlocks: vi.fn(async () => undefined),
  };
  const tasks = new Map([["t1", task("t1")]]);
  return { blocks, store, service: new SchedulingService(store as unknown as TimeStore, (id) => tasks.get(id)) };
}

describe("SchedulingService contract", () => {
  it("keeps one primary task schedule and uses the task estimate as its default duration", async () => {
    const { blocks, service } = schedulingFixture();
    const first = await service.scheduleTask("t1", { start: "2026-09-06T09:00:00-05:00", source: "drag" });
    const moved = await service.scheduleTask("t1", { start: "2026-09-07T10:00:00-05:00", duration: 30 });

    expect(first).toMatchObject({ kind: "task_schedule", duration: 45, source: "drag" });
    expect(moved.id).toBe(first.id);
    expect(blocks.size).toBe(1);
    expect(service.getTaskSchedule("t1")).toMatchObject({ id: first.id, duration: 30 });
  });

  it("schedules a newly created task from an explicit snapshot before the task index sees it", async () => {
    const { service } = schedulingFixture();
    const schedule = await service.scheduleTask({ id: "new", title: "Just created", estimate: 75 }, {
      start: "2026-09-08T09:00:00-05:00",
    });

    expect(schedule).toMatchObject({
      duration: 75,
      scope: { type: "task", id: "new", title_snapshot: "Just created" },
    });
  });

  it("stores a date-only schedule without an artificial start or duration", async () => {
    const { blocks, service } = schedulingFixture();
    const allDay = await service.scheduleTask("t1", { allDay: true, date: "2026-09-08" });

    expect(allDay).toMatchObject({ allDay: true, date: "2026-09-08", kind: "task_schedule" });
    expect(allDay).not.toHaveProperty("start");
    expect(allDay).not.toHaveProperty("duration");

    const timed = await service.scheduleTask("t1", { start: "2026-09-08T09:00:00-05:00", duration: 30 });
    expect(timed.id).toBe(allDay.id);
    expect(blocks.get(allDay.id)).toMatchObject({ start: "2026-09-08T14:00:00.000Z", duration: 30 });
    expect(blocks.get(allDay.id)).not.toHaveProperty("date");
    expect(blocks.get(allDay.id)).not.toHaveProperty("allDay");
  });

  it("rejects impossible date-only schedules", async () => {
    const { service } = schedulingFixture();
    await expect(service.scheduleTask("t1", { allDay: true, date: "2026-02-30" }))
      .rejects.toMatchObject<Partial<SchedulingError>>({ code: "invalid_start" });
  });

  it("keeps allocations distinct from task schedules", async () => {
    const { service } = schedulingFixture();
    const allocation = await service.createAllocation({
      scope: { type: "project", id: "p1", title_snapshot: "Project" },
      start: "2026-09-06T09:00:00-05:00", duration: 30,
    });

    expect(allocation.kind).toBe("allocation");
    await expect(service.updateAllocation(allocation.id, { duration: 60 })).resolves.toBeUndefined();
    const schedule = await service.scheduleTask("t1", { start: "2026-09-06T11:00:00-05:00" });
    await expect(service.updateAllocation(schedule.id, { duration: 60 })).rejects.toMatchObject<Partial<SchedulingError>>({ code: "wrong_block_kind" });
  });

  it("preserves a completed task schedule as calendar history and restores it on reopen", async () => {
    const { blocks, store, service } = schedulingFixture();
    const schedule = await service.scheduleTask("t1", { start: "2026-09-07T10:00:00-05:00" });

    await service.completeTask("t1");
    expect(blocks.get(schedule.id)?.status).toBe("completed");
    expect(service.getTaskSchedule("t1")?.id).toBe(schedule.id);
    expect(store.cancelFutureBlocks).toHaveBeenCalledWith("t1");

    await service.reopenTask("t1");
    expect(blocks.get(schedule.id)?.status).toBe("planned");
  });

  it("pins task schedules and applies then undoes an auto-plan without changing block identity", async () => {
    const { blocks, service } = schedulingFixture();
    const original = await service.scheduleTask("t1", { start: "2026-09-07T10:00:00-05:00", duration: 45 });
    await service.setPinned(original.id, true);
    expect(blocks.get(original.id)?.pinned).toBe(true);
    await service.setPinned(original.id, false);

    const preview = {
      createdAt: "2026-09-06T12:00:00.000Z", from: "2026-09-06", to: "2026-09-06", days: 1 as const,
      placements: [{ taskId: "t1", title: "Task t1", start: "2099-09-06T15:00:00.000Z", duration: 30, kind: "moved" as const, previousStart: original.start, afterDeadline: false, blockId: original.id }],
      preserved: [], unscheduled: [], candidateTaskIds: ["t1"],
      expectedSchedules: { t1: scheduleFingerprint(original) },
    };
    await service.applyAutoPlan(preview);
    expect(service.getTaskSchedule("t1")).toMatchObject({ id: original.id, duration: 30 });
    expect(service.canUndoAutoPlan()).toBe(true);
    await service.undoAutoPlan();
    expect(service.getTaskSchedule("t1")).toMatchObject({ id: original.id, start: original.start, duration: 45 });
  });

  it("refuses to apply a preview after its schedule changed", async () => {
    const { service } = schedulingFixture();
    await service.scheduleTask("t1", { start: "2026-09-07T10:00:00-05:00" });
    await expect(service.applyAutoPlan({
      createdAt: new Date().toISOString(), from: "2026-09-07", to: "2026-09-07", days: 1,
      placements: [], preserved: [], unscheduled: [], candidateTaskIds: ["t1"], expectedSchedules: { t1: null },
    })).rejects.toMatchObject<Partial<SchedulingError>>({ code: "stale_plan" });
  });

  it("refuses undo after a subsequent manual edit", async () => {
    const { service } = schedulingFixture();
    const original = await service.scheduleTask("t1", { start: "2026-09-07T10:00:00-05:00" });
    const expected = scheduleFingerprint(original);
    await service.applyAutoPlan({
      createdAt: "2026-09-06T12:00:00.000Z", from: "2026-09-06", to: "2026-09-06", days: 1,
      placements: [{ taskId: "t1", title: "Task t1", start: "2099-09-06T15:00:00.000Z", duration: 30, kind: "moved", previousStart: original.start, afterDeadline: false }],
      preserved: [], unscheduled: [], candidateTaskIds: ["t1"], expectedSchedules: { t1: expected },
    });
    await service.moveBlock(original.id, "2099-09-06T16:00:00.000Z");
    await expect(service.undoAutoPlan()).rejects.toMatchObject<Partial<SchedulingError>>({ code: "undo_conflict" });
  });

  it("restores earlier writes when a later auto-plan write fails", async () => {
    const first = scheduleBlock("b1", "t1", "2099-09-06T14:00:00.000Z");
    const second = scheduleBlock("b2", "t2", "2099-09-06T15:00:00.000Z");
    const blocks = new Map([[first.id, first], [second.id, second]]);
    const store = {
      blocksFor: (scope: { id: string }) => [...blocks.values()].filter((block) => block.scope.id === scope.id),
      block: (id: string) => blocks.get(id) ?? null,
      addBlock: vi.fn(), cancelFutureBlocks: vi.fn(),
      updateBlock: async (id: string, patch: Partial<TimeBlock>) => {
        if (id === "b2" && patch.duration === 30) throw new Error("write failed");
        const updated = { ...blocks.get(id)!, ...patch } as TimeBlock & { allDay?: boolean; date?: string };
        if (updated.allDay !== true) { delete updated.allDay; delete updated.date; }
        blocks.set(id, updated);
      },
    };
    const tasks = new Map([["t1", task("t1")], ["t2", task("t2")]]);
    const service = new SchedulingService(store as unknown as TimeStore, (id) => tasks.get(id));
    await expect(service.applyAutoPlan({
      createdAt: "2026-09-06T12:00:00.000Z", from: "2026-09-06", to: "2026-09-06", days: 1,
      placements: [
        { taskId: "t1", title: "Task t1", start: "2099-09-06T16:00:00.000Z", duration: 30, kind: "moved", afterDeadline: false },
        { taskId: "t2", title: "Task t2", start: "2099-09-06T17:00:00.000Z", duration: 30, kind: "moved", afterDeadline: false },
      ], preserved: [], unscheduled: [], candidateTaskIds: ["t1", "t2"],
      expectedSchedules: { t1: scheduleFingerprint(first), t2: scheduleFingerprint(second) },
    })).rejects.toThrow("write failed");
    expect(blocks.get("b1")).toEqual(first);
  });

  it("recovers a persisted apply journal after restart", async () => {
    const created = { ...scheduleBlock("auto", "t1", "2099-09-06T14:00:00.000Z"), source: "auto" as const };
    const blocks = new Map([[created.id, created as TimeBlock]]);
    let persisted: import("../src/schedulingService").AutoPlanJournal | null = {
      state: "pending", changes: [{ taskId: "t1", before: null, afterId: created.id, after: scheduleFingerprint(created as TimeBlock) }],
    };
    const store = {
      blocksFor: (scope: { id: string }) => [...blocks.values()].filter((block) => block.scope.id === scope.id),
      block: (id: string) => blocks.get(id) ?? null,
      updateBlock: async (id: string, patch: Partial<TimeBlock>) => blocks.set(id, { ...blocks.get(id)!, ...patch } as TimeBlock),
    };
    const service = new SchedulingService(store as unknown as TimeStore, () => task("t1"), {
      load: () => persisted,
      save: (value) => { persisted = value; },
    });
    await service.recoverInterruptedAutoPlan();
    expect(blocks.get(created.id)?.status).toBe("cancelled");
    expect(persisted).toBeNull();
  });
});

const scheduleBlock = (id: string, taskId: string, start: string): TimeBlock => ({
  id, kind: "task_schedule", scope: { type: "task", id: taskId, title_snapshot: `Task ${taskId}` },
  start, duration: 45, mode: "focus", selector: "manual", status: "planned", source: "manual",
});

describe("WorkTimerService contract", () => {
  it("requires a task choice for a project allocation and starts only an eligible choice", async () => {
    const t1 = task("t1"), t2 = task("t2");
    const block: TimeBlock = {
      id: "b1", kind: "allocation", start: "2026-09-06T09:00:00-05:00", duration: 30,
      scope: { type: "project", id: "p1", title_snapshot: "Project" }, mode: "focus", selector: "manual", status: "planned", source: "manual",
    };
    const start = vi.fn(async (selected: Task, selectedBlock?: TimeBlock): Promise<WorkSession> => ({
      id: "s1", task_id: selected.id, task_title_snapshot: selected.title, block_id: selectedBlock?.id,
      started_at: new Date().toISOString(), elapsed: 0, device_id: "device",
    }));
    const sessions = { subscribe: () => () => undefined, active: () => null, conflicts: () => [], needsResolution: () => false,
      recover: async () => undefined, resolveConflicts: async () => undefined, discardConflict: async () => undefined,
      start, stop: async () => null } as unknown as TimerService;
    const store = { block: (id: string) => id === block.id ? block : null, sessionsFor: () => [] } as unknown as TimeStore;
    const service = new WorkTimerService(sessions, store, {
      taskById: (id) => [t1, t2].find((candidate) => candidate.id === id), tasksForScope: async () => [t1, t2],
      snapshotsForTask: async () => ({}), markTaskComplete: async () => undefined, notify: () => undefined,
    });

    await expect(service.startBlock("b1")).resolves.toEqual({ status: "selection_required", taskIds: ["t1", "t2"] });
    await expect(service.startBlock("b1", "t2")).resolves.toEqual({ status: "started", taskId: "t2" });
    expect(start).toHaveBeenCalledWith(t2, block, {});
    await expect(service.startBlock("b1", "missing")).rejects.toThrow("not eligible");
  });
});
