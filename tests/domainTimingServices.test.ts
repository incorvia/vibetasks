import { describe, expect, it, vi } from "vitest";
import { SchedulingError, SchedulingService } from "../src/schedulingService";
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
