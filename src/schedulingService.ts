import type { Task, TimeBlock, TimeBlockMode, TimeBlockSelector, TimeScope } from "./types";
import { blockKind, TimeStore } from "./timeService";

export type ScheduleSource = TimeBlock["source"];
export interface AllocationInput {
  scope: TimeScope; start: string | Date; duration: number;
  mode?: TimeBlockMode; selector?: TimeBlockSelector; source?: ScheduleSource;
}
export interface AllocationChanges {
  scope?: TimeScope; start?: string | Date; duration?: number;
  mode?: TimeBlockMode; selector?: TimeBlockSelector;
}

export class SchedulingError extends Error {
  constructor(public readonly code: "task_not_found" | "block_not_found" | "wrong_block_kind" | "invalid_start" | "invalid_duration", message: string) {
    super(message); this.name = "SchedulingError";
  }
}

const startValue = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new SchedulingError("invalid_start", "A valid schedule start is required.");
  return date.toISOString();
};
const durationValue = (value: number): number => {
  const minutes = Math.round(value);
  if (!Number.isFinite(minutes) || minutes < 1) throw new SchedulingError("invalid_duration", "Duration must be at least one minute.");
  return minutes;
};

/** The sole mutation API for task schedules and explicit time allocations. */
export class SchedulingService {
  constructor(private store: TimeStore, private taskById: (id: string) => Task | undefined) {}

  getTaskSchedule(taskOrId: Task | string): TimeBlock | null {
    const id = typeof taskOrId === "string" ? taskOrId : taskOrId.id;
    return this.store.blocksFor({ type: "task", id, title_snapshot: "" })
      .filter((block) => blockKind(block) === "task_schedule" && block.status !== "cancelled")
      .sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;
  }

  async scheduleTask(taskId: string, input: { start: string | Date; duration?: number; source?: ScheduleSource }): Promise<TimeBlock> {
    const task = this.taskById(taskId);
    if (!task) throw new SchedulingError("task_not_found", `No task with id ${taskId}.`);
    const existing = this.getTaskSchedule(taskId);
    const values = {
      start: startValue(input.start), duration: durationValue(input.duration ?? task.estimate ?? 60), kind: "task_schedule" as const,
      scope: { type: "task" as const, id: task.id, title_snapshot: task.title }, mode: "focus" as const, selector: "manual" as const,
    };
    if (existing) {
      const updated = { ...values, status: "planned" as const };
      await this.store.updateBlock(existing.id, updated); return { ...existing, ...updated };
    }
    return this.store.addBlock({ ...values, source: input.source ?? "manual" });
  }

  async unscheduleTask(taskId: string): Promise<void> {
    const schedule = this.getTaskSchedule(taskId); if (schedule) await this.store.updateBlock(schedule.id, { status: "cancelled" });
  }

  async createAllocation(input: AllocationInput): Promise<TimeBlock> {
    const mode = input.mode ?? "focus";
    return this.store.addBlock({
      kind: "allocation", scope: input.scope, start: startValue(input.start), duration: durationValue(input.duration), mode,
      selector: input.selector ?? (mode === "blitz" ? "next" : "manual"), source: input.source ?? "manual",
    });
  }

  async updateAllocation(id: string, changes: AllocationChanges): Promise<void> {
    const block = this.requireBlock(id);
    if (blockKind(block) !== "allocation") throw new SchedulingError("wrong_block_kind", "Task schedules must be changed through scheduleTask().");
    await this.store.updateBlock(id, this.normalizedChanges(changes));
  }

  async moveBlock(id: string, start: string | Date): Promise<void> { this.requireBlock(id); await this.store.updateBlock(id, { start: startValue(start) }); }
  async resizeBlock(id: string, duration: number): Promise<void> { this.requireBlock(id); await this.store.updateBlock(id, { duration: durationValue(duration) }); }
  async cancelBlock(id: string): Promise<void> { this.requireBlock(id); await this.store.updateBlock(id, { status: "cancelled" }); }
  async updateFromCalendar(id: string, start: string | Date, duration: number): Promise<void> {
    this.requireBlock(id); await this.store.updateBlock(id, { start: startValue(start), duration: durationValue(duration) });
  }
  async setCalendarLink(id: string, eventId: string | null, calendarId: string | null): Promise<void> {
    this.requireBlock(id);
    await this.store.updateBlock(id, {
      gcal_event_id: eventId ?? undefined,
      gcal_calendar_id: calendarId ?? undefined,
    });
  }
  async cancelFutureForTask(taskId: string): Promise<void> { await this.store.cancelFutureBlocks(taskId); }
  /** Preserve the primary placement as calendar history; only other future allocations disappear. */
  async completeTask(taskId: string): Promise<void> {
    const schedule = this.getTaskSchedule(taskId);
    if (schedule?.status === "planned") await this.store.updateBlock(schedule.id, { status: "completed" });
    await this.store.cancelFutureBlocks(taskId);
  }
  async reopenTask(taskId: string): Promise<void> {
    const schedule = this.getTaskSchedule(taskId);
    if (schedule?.status === "completed") await this.store.updateBlock(schedule.id, { status: "planned" });
  }

  private requireBlock(id: string): TimeBlock {
    const block = this.store.block(id); if (!block) throw new SchedulingError("block_not_found", `No time block with id ${id}.`); return block;
  }
  private normalizedChanges(changes: AllocationChanges): Partial<TimeBlock> {
    return {
      ...(changes.scope ? { scope: changes.scope } : {}), ...(changes.start ? { start: startValue(changes.start) } : {}),
      ...(changes.duration !== undefined ? { duration: durationValue(changes.duration) } : {}),
      ...(changes.mode ? { mode: changes.mode } : {}), ...(changes.selector ? { selector: changes.selector } : {}),
    };
  }
}
