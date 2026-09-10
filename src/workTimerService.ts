import { isAllDaySchedule, type Task, type TimeBlock, type TimeScope, type WorkSession } from "./types";
import { ActiveTimer, TimerService, TimeStore } from "./timeService";
import { newUlid } from "./mdbaseRepository";

export interface RecordedTimeInput { started_at: string; ended_at: string }

function recordedTime(input: RecordedTimeInput): Required<Pick<WorkSession, "started_at" | "ended_at" | "elapsed">> {
  const start = Date.parse(input.started_at), end = Date.parse(input.ended_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Choose valid start and end times.");
  if (end <= start) throw new Error("End time must be after start time.");
  if (end > Date.now()) throw new Error("Recorded time cannot end in the future.");
  return { started_at: new Date(start).toISOString(), ended_at: new Date(end).toISOString(), elapsed: Math.round((end - start) / 1000) };
}

export interface WorkTimerHost {
  taskById(id: string): Task | undefined;
  tasksForScope(scope: TimeScope): Promise<Task[]>;
  snapshotsForTask(task: Task): Promise<Partial<WorkSession>>;
  markTaskComplete(task: Task): Promise<void>;
  notify(message: string): void;
}
export type StartBlockResult = { status: "started"; taskId: string } | { status: "selection_required"; taskIds: string[] } | { status: "empty" };

/** Intent-level timer API shared by rows, menus, editor, blocks, CLI, and future AI callers. */
export class WorkTimerService {
  constructor(private sessions: TimerService, private store: TimeStore, private host: WorkTimerHost) {}

  subscribe(listener: () => void): () => void { return this.sessions.subscribe(listener); }
  active(): ActiveTimer | null { return this.sessions.active(); }
  conflicts(): WorkSession[] { return this.sessions.conflicts(); }
  needsResolution(): boolean { return this.sessions.needsResolution(); }
  recover(): Promise<void> { return this.sessions.recover(); }
  resolveConflicts(keepId: string | null): Promise<void> { return this.sessions.resolveConflicts(keepId); }
  discardConflict(id: string): Promise<void> { return this.sessions.discardConflict(id); }

  async startTask(taskId: string, blockId?: string): Promise<WorkSession> {
    const task = this.host.taskById(taskId);
    if (!task) throw new Error(`No task with id ${taskId}.`);
    const block = blockId ? this.store.block(blockId) ?? undefined : undefined;
    return this.sessions.start(task, block, await this.host.snapshotsForTask(task));
  }

  async startBlock(blockId: string, selectedTaskId?: string): Promise<StartBlockResult> {
    const block = this.store.block(blockId); if (!block || block.status === "cancelled") return { status: "empty" };
    const tasks = await this.host.tasksForScope(block.scope);
    if (!tasks.length) return { status: "empty" };
    if (selectedTaskId) {
      if (!tasks.some((task) => task.id === selectedTaskId)) throw new Error("The selected task is not eligible for this block.");
      await this.startTask(selectedTaskId, block.id); return { status: "started", taskId: selectedTaskId };
    }
    if (block.mode !== "blitz" && block.scope.type !== "task") return { status: "selection_required", taskIds: tasks.map((task) => task.id) };
    await this.startTask(tasks[0].id, block.id); return { status: "started", taskId: tasks[0].id };
  }

  stop(): Promise<WorkSession | null> { return this.sessions.stop(); }
  pause(): Promise<WorkSession | null> { return this.stop(); }

  async recordTime(taskId: string, input: RecordedTimeInput): Promise<void> {
    const timing = recordedTime(input);
    const task = this.host.taskById(taskId);
    if (!task) throw new Error("This task no longer exists.");
    await this.store.addSession({
      ...await this.host.snapshotsForTask(task), id: newUlid(), task_id: task.id,
      task_title_snapshot: task.title, device_id: "manual", ...timing,
    });
  }

  async editRecordedTime(id: string, input: RecordedTimeInput, expected?: RecordedTimeInput): Promise<void> {
    const session = this.store.session(id);
    if (!session) throw new Error("This time record no longer exists.");
    if (!session.ended_at || this.active()?.session_id === id) throw new Error("Stop the timer before editing this record.");
    if (expected && (session.started_at !== expected.started_at || session.ended_at !== expected.ended_at)) {
      throw new Error("This record changed while you were editing. Reopen it to load the latest version.");
    }
    await this.store.updateSession(id, recordedTime(input));
  }

  async resume(taskId: string, blockId?: string): Promise<WorkSession> { return this.startTask(taskId, blockId); }

  async skip(): Promise<void> {
    const active = this.active(); if (!active) return;
    const block = active.block_id ? this.store.block(active.block_id) : null;
    await this.sessions.stop();
    if (block?.mode === "blitz") await this.advanceBlitz(block, active.task_id);
  }

  async completeActive(): Promise<void> {
    const active = this.active();
    if (!active) return;
    await this.completeTask(active.task_id);
  }

  async completeTask(taskId: string): Promise<void> {
    const task = this.host.taskById(taskId); if (!task) { if (this.active()?.task_id === taskId) await this.sessions.stop(); return; }
    const active = this.active();
    const block = active?.task_id === taskId && active.block_id ? this.store.block(active.block_id) : null;
    if (active?.task_id === taskId) await this.sessions.stop();
    await this.host.markTaskComplete(task);
    if (block?.mode === "blitz") await this.advanceBlitz(block, task.id);
  }

  private async advanceBlitz(block: TimeBlock, previousTaskId: string): Promise<void> {
    if (isAllDaySchedule(block)) return;
    if (Date.now() >= Date.parse(block.start) + block.duration * 60_000) {
      this.host.notify("Blitz block ended. No next task was started."); return;
    }
    const alreadyWorked = new Set(this.store.sessionsFor("block", block.id).map((session) => session.task_id));
    alreadyWorked.add(previousTaskId);
    const next = (await this.host.tasksForScope(block.scope)).find((candidate) => !alreadyWorked.has(candidate.id));
    if (next) await this.startTask(next.id, block.id);
    else this.host.notify("Blitz complete: no eligible tasks remain.");
  }
}
