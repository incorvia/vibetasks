import { isAllDaySchedule, type ScheduleDraft, type Task, type TimeBlock, type TimeBlockMode, type TimeBlockPatch, type TimeBlockSelector, type TimeScope } from "./types";
import { blockKind, TimeStore } from "./timeService";
import { buildAutoPlan, scheduleFingerprint, type AutoPlanInput, type AutoPlanPreview } from "./autoPlanner";

export type ScheduleSource = TimeBlock["source"];
interface AutoPlanChange { taskId: string; before: TimeBlock | null; afterId: string; after: string | null }
export interface AutoPlanJournal { state: "pending" | "ready"; changes: AutoPlanChange[] }
export interface AutoPlanJournalStore {
  load(): AutoPlanJournal | null;
  save(value: AutoPlanJournal | null): void;
}
export type SchedulableTask = Pick<Task, "id" | "title" | "estimate">;
export interface AllocationInput {
  scope: TimeScope; start: string | Date; duration: number;
  mode?: TimeBlockMode; selector?: TimeBlockSelector; source?: ScheduleSource;
}
export interface AllocationChanges {
  scope?: TimeScope; start?: string | Date; duration?: number;
  mode?: TimeBlockMode; selector?: TimeBlockSelector;
}
export type ScheduleTaskInput =
  | { allDay: true; date: string; source?: ScheduleSource }
  | { allDay?: false; start: string | Date; duration?: number; source?: ScheduleSource };

export class SchedulingError extends Error {
  constructor(public readonly code: "task_not_found" | "block_not_found" | "wrong_block_kind" | "invalid_start" | "invalid_duration" | "stale_plan" | "undo_conflict" | "nothing_to_undo", message: string) {
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
const dateValue = (value: string): string => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new SchedulingError("invalid_start", "A valid schedule date is required.");
  const date = new Date(+match[1], +match[2] - 1, +match[3]);
  if (date.getFullYear() !== +match[1] || date.getMonth() !== +match[2] - 1 || date.getDate() !== +match[3]) {
    throw new SchedulingError("invalid_start", "A valid schedule date is required.");
  }
  return value;
};

/** The sole mutation API for task schedules and explicit time allocations. */
export class SchedulingService {
  private autoPlanJournal: AutoPlanJournal | null;
  constructor(private store: TimeStore, private taskById: (id: string) => Task | undefined,
    private journalStore?: AutoPlanJournalStore) {
    this.autoPlanJournal = journalStore?.load() ?? null;
  }

  /** Complete rollback of an apply interrupted by an app/device restart. */
  async recoverInterruptedAutoPlan(): Promise<void> {
    if (this.autoPlanJournal?.state !== "pending") return;
    await this.restoreChanges(this.autoPlanJournal.changes);
    this.setJournal(null);
  }

  previewAutoPlan(input: AutoPlanInput): AutoPlanPreview { return buildAutoPlan(input); }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    this.requireBlock(id);
    await this.store.updateBlock(id, { pinned: pinned || undefined });
  }

  /** Applies a fully computed preview. Every current schedule is checked before the first write. */
  async applyAutoPlan(preview: AutoPlanPreview): Promise<void> {
    for (const taskId of preview.candidateTaskIds) {
      if (scheduleFingerprint(this.getTaskSchedule(taskId)) !== preview.expectedSchedules[taskId]) {
        throw new SchedulingError("stale_plan", "Tasks or calendar blocks changed after this preview was created.");
      }
    }
    const first = preview.placements.slice().sort((a, b) => a.start.localeCompare(b.start))[0];
    if (first && Date.now() >= Date.parse(first.start)) throw new SchedulingError("stale_plan", "The available part of the day changed. Preview the plan again.");

    const byTask = new Map(preview.placements.map((x) => [x.taskId, x]));
    const previousJournal = this.autoPlanJournal?.state === "ready" ? this.autoPlanJournal : null;
    const journal: AutoPlanJournal = { state: "pending", changes: [] };
    this.setJournal(journal);
    try {
      for (const taskId of preview.candidateTaskIds) {
        const before = this.getTaskSchedule(taskId), placement = byTask.get(taskId);
        const change: AutoPlanChange = { taskId, before: before ? { ...before } : null, afterId: before?.id ?? "", after: null };
        journal.changes.push(change);
        this.setJournal(journal); // before-state reaches durable storage before its corresponding write
        if (placement) {
          const afterBlock = await this.scheduleTask(taskId, { start: placement.start, duration: placement.duration, source: "auto" });
          change.afterId = afterBlock.id; change.after = scheduleFingerprint(this.getTaskSchedule(taskId));
        } else if (before) {
          await this.unscheduleTask(taskId);
          change.after = scheduleFingerprint(this.getTaskSchedule(taskId));
        }
        this.setJournal(journal);
      }
    } catch (error) {
      try { await this.restoreChanges(journal.changes); this.setJournal(previousJournal); }
      catch (recovery) {
        throw new Error(`Auto-plan failed and recovery was incomplete: ${recovery instanceof Error ? recovery.message : String(recovery)}`);
      }
      throw error;
    }
    journal.state = "ready";
    this.setJournal(journal);
  }

  canUndoAutoPlan(): boolean { return this.autoPlanJournal?.state === "ready"; }

  async undoAutoPlan(): Promise<void> {
    const journal = this.autoPlanJournal;
    if (!journal || journal.state !== "ready") throw new SchedulingError("nothing_to_undo", "There is no auto-plan to undo.");
    for (const change of journal.changes) {
      if (scheduleFingerprint(this.getTaskSchedule(change.taskId)) !== change.after) {
        throw new SchedulingError("undo_conflict", "A task changed after auto-plan was applied, so undo was not performed.");
      }
    }
    await this.restoreChanges(journal.changes);
    this.setJournal(null);
  }

  private setJournal(value: AutoPlanJournal | null): void {
    this.autoPlanJournal = value;
    this.journalStore?.save(value);
  }

  private async restoreChanges(changes: AutoPlanChange[]): Promise<void> {
    const failures: string[] = [];
    for (const change of changes.slice().reverse()) {
      try {
        if (change.before) await this.store.updateBlock(change.before.id, change.before);
        else {
          const created = (change.afterId ? this.store.block(change.afterId) : null) ?? this.getTaskSchedule(change.taskId);
          // A missing afterId means the app stopped between creating a new auto block and updating
          // the journal. Never cancel a manual placement that may have arrived from another device.
          if (created?.source === "auto") await this.store.updateBlock(created.id, { status: "cancelled" });
        }
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    if (failures.length) throw new Error(failures.join("; "));
  }

  getTaskSchedule(taskOrId: Pick<Task, "id"> | string): TimeBlock | null {
    const id = typeof taskOrId === "string" ? taskOrId : taskOrId.id;
    return this.store.blocksFor({ type: "task", id, title_snapshot: "" })
      .filter((block) => blockKind(block) === "task_schedule" && block.status !== "cancelled")
      .sort((a, b) => (isAllDaySchedule(b) ? b.date : b.start).localeCompare(isAllDaySchedule(a) ? a.date : a.start))[0] ?? null;
  }

  async scheduleTask(taskOrId: SchedulableTask | string, input: ScheduleTaskInput): Promise<TimeBlock> {
    const task = typeof taskOrId === "string" ? this.taskById(taskOrId) : taskOrId;
    const taskId = typeof taskOrId === "string" ? taskOrId : taskOrId.id;
    if (!task) throw new SchedulingError("task_not_found", `No task with id ${taskId}.`);
    const existing = this.getTaskSchedule(taskId);
    const common = {
      kind: "task_schedule" as const, scope: { type: "task" as const, id: task.id, title_snapshot: task.title },
      mode: "focus" as const, selector: "manual" as const,
    };
    const values = input.allDay
      ? { ...common, allDay: true as const, date: dateValue(input.date) }
      : { ...common, allDay: false as const, start: startValue(input.start), duration: durationValue(input.duration ?? task.estimate ?? 60) };
    if (existing) {
      const updated = { ...values, status: "planned" as const, ...(input.source ? { source: input.source } : {}) };
      await this.store.updateBlock(existing.id, updated);
      return { ...updated, id: existing.id, source: input.source ?? existing.source };
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

  async moveBlock(id: string, start: string | Date): Promise<void> {
    const block = this.requireBlock(id);
    const fallback = block.scope.type === "task" ? this.taskById(block.scope.id)?.estimate : null;
    await this.store.updateBlock(id, isAllDaySchedule(block)
      ? { allDay: false, start: startValue(start), duration: durationValue(fallback ?? 60) }
      : { start: startValue(start) });
  }
  async resizeBlock(id: string, duration: number): Promise<void> {
    const block = this.requireBlock(id);
    if (isAllDaySchedule(block)) throw new SchedulingError("wrong_block_kind", "All-day schedules do not have a duration.");
    await this.store.updateBlock(id, { duration: durationValue(duration) });
  }
  async cancelBlock(id: string): Promise<void> { this.requireBlock(id); await this.store.updateBlock(id, { status: "cancelled" }); }
  async updateFromCalendar(id: string, schedule: ScheduleDraft): Promise<void> {
    this.requireBlock(id);
    await this.store.updateBlock(id, isAllDaySchedule(schedule)
      ? { allDay: true, date: dateValue(schedule.date) }
      : { allDay: false, start: startValue(schedule.start), duration: durationValue(schedule.duration) });
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
    if (schedule?.status === "planned") await this.store.updateBlock(schedule.id, { status: "completed", completed_at: new Date().toISOString() });
    await this.store.cancelFutureBlocks(taskId);
  }
  async reopenTask(taskId: string): Promise<void> {
    const schedule = this.getTaskSchedule(taskId);
    if (schedule?.status === "completed") await this.store.updateBlock(schedule.id, { status: "planned", completed_at: undefined });
  }

  private requireBlock(id: string): TimeBlock {
    const block = this.store.block(id); if (!block) throw new SchedulingError("block_not_found", `No time block with id ${id}.`); return block;
  }
  private normalizedChanges(changes: AllocationChanges): TimeBlockPatch {
    return {
      ...(changes.scope ? { scope: changes.scope } : {}), ...(changes.start ? { start: startValue(changes.start) } : {}),
      ...(changes.duration !== undefined ? { duration: durationValue(changes.duration) } : {}),
      ...(changes.mode ? { mode: changes.mode } : {}), ...(changes.selector ? { selector: changes.selector } : {}),
    };
  }
}
