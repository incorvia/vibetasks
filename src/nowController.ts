import { Component } from "obsidian";
import type OpalTasksPlugin from "./main";
import { collectAutoPlanInput } from "./autoPlanModal";
import { localDay } from "./autoPlanner";
import { buildPullForward, meetingOccurrenceKey } from "./pullForward";
import { blockKind } from "./timeService";
import { isAllDaySchedule, type CalEvent, type Priority, type Task, type TimeBlock } from "./types";
import { isDone } from "./statuses";
import { bucketEvents } from "./calendarModel";

export const NOW_RUN_KEY = "opal_tasks-now-run";
export const NOW_UNDO_KEY = "opal_tasks-now-undo";
export type NowRunStatus = "stopped" | "running" | "paused" | "waiting" | "recovery";
type StoredRun = { date: string; status: NowRunStatus; skipped: string[]; blitz?: boolean; fixedKey?: string; pausedTaskId?: string; pausedBlockId?: string; error?: string };
type UndoMove = { id: string; before: string; after: string };
type StoredUndo = { date: string; moves: UndoMove[] };
export type NowItem =
  | { kind: "task"; key: string; start: string; end: string; title: string; task: Task; block: TimeBlock }
  | { kind: "allocation"; key: string; start: string; end: string; title: string; block: TimeBlock }
  | { kind: "meeting"; key: string; start: string; end: string; title: string; event: CalEvent };
export interface NowSnapshot {
  status: NowRunStatus; current: NowItem | null; upcoming: NowItem[]; completed: NowItem[];
  allDay: (Task | CalEvent)[]; skipped: NowItem[]; pastEvents: NowItem[]; error?: string; canUndo: boolean; conflicts: NowItem[]; blitz: boolean;
}

const timedEnd = (start: string, minutes: number): string => new Date(Date.parse(start) + minutes * 60_000).toISOString();
const PRIORITIES: Priority[] = ["highest", "high", "medium", "normal", "low", "lowest"];
const futureDay = (days: number): string => { const date = new Date(); date.setDate(date.getDate() + Math.max(1, Math.round(days))); return localDay(date); };

/** Plugin-level state machine. It keeps running even when no sidebar leaf is open. */
export class NowController extends Component {
  private run: StoredRun;
  private listeners = new Set<() => void>();
  private transition: Promise<void> = Promise.resolve();
  private timer: number | null = null;
  private lastDay: string;

  constructor(private plugin: OpalTasksPlugin) {
    super();
    const today = localDay(new Date());
    const saved = plugin.app.loadLocalStorage(NOW_RUN_KEY) as StoredRun | null;
    this.run = saved?.date === today
      ? { ...saved, blitz: saved.blitz ?? true, status: saved.status === "stopped" ? "stopped" : "recovery" }
      : { date: today, status: "stopped", skipped: [], blitz: saved?.blitz ?? true };
    this.lastDay = today;
    this.persist();
  }

  onload(): void {
    this.timer = window.setInterval(() => void this.tick(), 1000);
    this.register(() => { if (this.timer) window.clearInterval(this.timer); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); listener(); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private persist(): void { this.plugin.app.saveLocalStorage(NOW_RUN_KEY, this.run); this.emit(); }
  private serial(work: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(work, work).catch((error) => {
      this.run.status = "recovery"; this.run.error = error instanceof Error ? error.message : String(error); this.persist();
    });
    return this.transition;
  }

  private effectiveStatus(): NowRunStatus {
    // The work timer is authoritative. After an Obsidian restart the guide deliberately enters
    // recovery, but TimerService may successfully restore a still-running session afterward.
    return this.plugin.workTimer.active() ? "running" : this.run.status;
  }
  status(): NowRunStatus { return this.effectiveStatus(); }
  isRunning(): boolean { const status = this.effectiveStatus(); return status === "running" || status === "waiting"; }
  blitzEnabled(): boolean { return this.run.blitz ?? true; }
  setBlitzEnabled(enabled: boolean): void { this.run.blitz = enabled; this.persist(); }

  private items(): { timed: NowItem[]; allDay: (Task | CalEvent)[] } {
    const day = this.run.date, tasks: NowItem[] = [], allDay: (Task | CalEvent)[] = [];
    for (const block of this.plugin.timeStore.blocksIn(day, day)) {
      if (block.status === "cancelled") continue;
      if (isAllDaySchedule(block)) { const task = this.plugin.index.getById(block.scope.id); if (task && block.status === "planned" && !isDone(task.status)) allDay.push(task); continue; }
      const end = timedEnd(block.start, block.duration);
      if (blockKind(block) === "task_schedule" && block.scope.type === "task") {
        const task = this.plugin.index.getById(block.scope.id); if (!task) continue;
        tasks.push({ kind: "task", key: `task:${block.id}`, start: block.start, end, title: task.title, task, block });
      } else tasks.push({ kind: "allocation", key: `block:${block.id}`, start: block.start, end, title: block.scope.title_snapshot, block });
    }
    for (const { event } of bucketEvents(this.plugin.gcalFeed.eventsIn(day, day), [day]).get(day) ?? []) {
      if (event.allDay) { allDay.push(event); continue; }
      tasks.push({ kind: "meeting", key: `event:${meetingOccurrenceKey(event)}`, start: event.start, end: event.end, title: event.title, event });
    }
    tasks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.kind.localeCompare(b.kind));
    return { timed: tasks, allDay };
  }
  private done(item: NowItem): boolean {
    if (item.kind === "task") return item.block.status === "completed" || isDone(item.task.status);
    if (item.kind === "allocation") return item.block.status === "completed";
    return this.plugin.timeStore.isMeetingComplete(item.event);
  }
  snapshot(now = new Date()): NowSnapshot {
    const { timed, allDay } = this.items(), skippedIds = new Set(this.run.skipped);
    const completed = timed.filter((item) => this.done(item));
    const parked = (item: NowItem): boolean => item.kind === "task"
      && (skippedIds.has(item.task.id) || !!item.task.deferUntil && item.task.deferUntil > this.run.date);
    const skipped = timed.filter((item) => parked(item) && !this.done(item));
    const open = timed.filter((item) => !this.done(item) && !parked(item));
    const active = this.plugin.workTimer.active();
    let current = active ? open.find((item) => item.kind === "task" && item.task.id === active.task_id) ?? null : null;
    if (active?.block_id && !current) current = open.find((item) => item.kind === "allocation" && item.block.id === active.block_id) ?? null;
    if (active && !current) {
      const task = this.plugin.index.getById(active.task_id), stored = active.block_id ? this.plugin.timeStore.block(active.block_id) : null;
      if (task) {
        const block: TimeBlock = stored ?? { id: `active:${active.session_id}`, kind: "task_schedule", scope: { type: "task", id: task.id, title_snapshot: task.title },
          start: active.started_at, duration: task.estimate ?? 60, mode: "focus", selector: "manual", status: "planned", source: "manual" };
        if (!isAllDaySchedule(block)) current = { kind: "task", key: `task:${block.id}`, start: block.start, end: timedEnd(block.start, block.duration), title: task.title, task, block };
      }
    }
    const time = now.getTime();
    if (!current && this.run.fixedKey) current = open.find((item) => item.key === this.run.fixedKey && Date.parse(item.end) > time) ?? null;
    const overlapping = open.filter((item) => item.kind !== "task" && Date.parse(item.start) <= time && Date.parse(item.end) > time);
    if (!current && overlapping.length === 1) current = overlapping[0];
    // A scheduled task owns the Now card for its whole time block, even before Focus or Blitz has
    // been started. This makes the card an invitation to begin the current block and also removes
    // that task from Up next instead of incorrectly presenting the interval as free time.
    if (!current) current = open.find((item) => item.kind === "task" && Date.parse(item.start) <= time && Date.parse(item.end) > time) ?? null;
    const pastEvents = open.filter((item) => item !== current && item.kind === "meeting" && Date.parse(item.end) <= time);
    // Missed work remains visible for review; elapsed calendar events move out of the action queue.
    const upcoming = open.filter((item) => item !== current && !pastEvents.includes(item));
    return { status: this.effectiveStatus(), current, upcoming, completed, allDay, skipped, pastEvents, error: this.run.error,
      canUndo: !!this.undo(), conflicts: overlapping.length > 1 && !this.run.fixedKey ? overlapping : [], blitz: this.blitzEnabled() };
  }

  start(blitz = this.blitzEnabled()): Promise<void> { return this.serial(async () => {
    if (this.plugin.workTimer.needsResolution()) throw new Error("Resolve timer conflicts before starting the day.");
    this.run = { date: localDay(new Date()), status: "running", skipped: this.run.date === localDay(new Date()) ? this.run.skipped : [], blitz };
    this.persist();
    if (blitz) await this.replanRemaining();
    await this.advance();
  }); }
  pause(): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current, active = this.plugin.workTimer.active();
    if (current) this.run.fixedKey = current.key;
    if (active) { this.run.pausedTaskId = active.task_id; this.run.pausedBlockId = active.block_id; }
    await this.plugin.workTimer.stop(); this.run.status = "paused"; this.persist();
  }); }
  resume(): Promise<void> { return this.serial(async () => {
    const taskId = this.run.pausedTaskId, blockId = this.run.pausedBlockId;
    this.run.status = "running"; delete this.run.error; delete this.run.pausedTaskId; delete this.run.pausedBlockId; this.persist();
    if (taskId) { await this.plugin.workTimer.startTask(taskId, blockId); this.persist(); return; }
    await this.advance();
  }); }
  stop(): Promise<void> { return this.serial(async () => { await this.plugin.workTimer.stop(); this.run = { date: localDay(new Date()), status: "stopped", skipped: [], blitz: this.blitzEnabled() }; this.persist(); }); }
  parkCurrent(): Promise<void> { return this.deferCurrent(1); }
  skipCurrent(): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current; if (!current || current.kind !== "task") return;
    const automate = this.isRunning() && this.blitzEnabled();
    await this.plugin.workTimer.stop();
    if (!this.run.skipped.includes(current.task.id)) this.run.skipped.push(current.task.id);
    delete this.run.fixedKey; delete this.run.pausedTaskId; delete this.run.pausedBlockId;
    if (automate) this.run.status = "running";
    this.persist();
    if (automate) { await this.replanRemaining(); await this.advance(); }
    else this.emit();
  }); }
  deferCurrent(days: number): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current; if (!current || current.kind !== "task") return;
    const automate = this.isRunning() && this.blitzEnabled();
    await this.plugin.workTimer.stop();
    await this.plugin.setTaskDeferUntil(current.task, futureDay(days));
    if (!this.run.skipped.includes(current.task.id)) this.run.skipped.push(current.task.id);
    delete this.run.fixedKey; delete this.run.pausedTaskId; delete this.run.pausedBlockId;
    if (automate) this.run.status = "running";
    this.persist();
    if (automate) { await this.replanRemaining(); await this.advance(); }
    else this.emit();
  }); }
  returnTo(taskId: string): Promise<void> { return this.serial(async () => {
    const task = this.plugin.index.getById(taskId); if (task) await this.plugin.setTaskDeferUntil(task, null);
    this.run.skipped = this.run.skipped.filter((id) => id !== taskId); this.run.status = "running"; this.persist(); await this.advance();
  }); }
  demoteAndSkipCurrent(): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current; if (!current || current.kind !== "task") return;
    const automate = this.isRunning() && this.blitzEnabled();
    const index = PRIORITIES.indexOf(current.task.priority), next = PRIORITIES[Math.min(PRIORITIES.length - 1, index + 1)];
    await this.plugin.workTimer.stop();
    await this.plugin.setTaskDeferUntil(current.task, futureDay(1));
    if (next !== current.task.priority) await this.plugin.setTaskPriority(current.task, next);
    if (!this.run.skipped.includes(current.task.id)) this.run.skipped.push(current.task.id);
    delete this.run.fixedKey; delete this.run.pausedTaskId; delete this.run.pausedBlockId;
    if (automate) this.run.status = "running";
    this.persist();
    if (automate) { await this.replanRemaining(); await this.advance(); }
    else this.emit();
  }); }
  chooseCommitment(key: string): Promise<void> { return this.serial(async () => {
    const choice = this.snapshot().conflicts.find((item) => item.key === key); if (!choice) return;
    await this.plugin.workTimer.stop(); this.run.fixedKey = choice.key; this.run.status = "running"; delete this.run.error; this.persist();
  }); }
  extendCurrent(minutes = 5): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current;
    if (!current || current.kind === "meeting") return;
    const previousDuration = Math.max(1, Math.round((Date.parse(current.end) - Date.parse(current.start)) / 60_000));
    await this.plugin.repository.ensureAutoPlanSchema();
    await this.plugin.scheduling.resizeBlock(current.block.id, previousDuration + minutes);
    try {
      // A duration change invalidates the accepted queue, but it must not reprioritize it or pull
      // unrelated backlog into the day. Reflow only the remaining auto-planned blocks.
      if (this.blitzEnabled()) await this.replanRemaining();
    } catch (error) {
      await this.plugin.scheduling.resizeBlock(current.block.id, previousDuration);
      throw error;
    }
    delete this.run.error; this.persist();
  }); }
  completeCurrent(): Promise<void> { return this.serial(async () => {
    const current = this.snapshot().current; if (!current) return;
    const automate = this.isRunning() && this.blitzEnabled();
    if (current.kind === "task") await this.plugin.workTimer.completeTask(current.task.id);
    else if (current.kind === "meeting") await this.plugin.timeStore.completeMeeting(current.event);
    else { await this.plugin.workTimer.stop(); await this.plugin.timeStore.completeBlock(current.block.id); }
    delete this.run.fixedKey;
    if (automate) { await this.replanRemaining(); await this.advance(); } else this.emit();
  }); }
  completeMeeting(event: CalEvent): Promise<void> { return this.serial(async () => {
    await this.plugin.timeStore.completeMeeting(event);
    if (this.run.fixedKey === `event:${meetingOccurrenceKey(event)}`) delete this.run.fixedKey;
    if (this.isRunning() && this.blitzEnabled()) { await this.replanRemaining(); await this.advance(); } else this.emit();
  }); }
  /** Called after completion from any other Opal Tasks surface. */
  taskCompleted(taskId: string): void {
    if (!this.isRunning() || !this.blitzEnabled()) return;
    void this.serial(async () => {
      if (this.plugin.workTimer.active()?.task_id === taskId) await this.plugin.workTimer.stop();
      if (this.snapshot().current?.kind === "allocation") { this.emit(); return; }
      await this.replanRemaining(); await this.advance();
    });
  }

  private async advance(): Promise<void> {
    if (!this.isRunning() || this.plugin.workTimer.needsResolution()) return;
    const now = new Date(), snap = this.snapshot(now);
    if (snap.conflicts.length) { this.run.status = "recovery"; this.run.error = "Overlapping commitments need your attention."; this.persist(); return; }
    const running = this.plugin.workTimer.active();
    if (running && snap.current?.kind === "allocation" && running.block_id === snap.current.block.id) {
      this.run.fixedKey = snap.current.key; this.run.status = "running"; this.persist(); return;
    }
    const fixed = snap.current && snap.current.kind !== "task" ? snap.current
      : snap.upcoming.find((item) => item.kind !== "task" && Date.parse(item.start) <= now.getTime() && Date.parse(item.end) > now.getTime());
    if (fixed) {
      await this.plugin.workTimer.stop(); this.run.fixedKey = fixed.key; this.run.status = "running"; this.persist(); return;
    }
    const active = this.plugin.workTimer.active(); if (active) { this.run.status = "running"; this.persist(); return; }
    const current = snap.current;
    if (current?.kind === "task") { await this.plugin.workTimer.startTask(current.task.id, current.block.id); this.run.status = "running"; this.persist(); return; }
    this.run.status = "waiting"; this.persist();
  }

  private completedEventKeys(): string[] {
    return this.plugin.timeStore.meetingCompletions(this.run.date).map((item) => `${item.calendar_id}\u0000${item.event_id}\u0000${item.occurrence_start}`);
  }
  private async replanRemaining(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = new Date(), snap = this.snapshot(now);
      // Belt-and-suspenders guard for the execution path: an ongoing meeting/allocation visible in
      // Today is an absolute floor even if the feed changes while the plan is being calculated.
      // Completing that commitment removes it from the snapshot first, deliberately releasing it.
      const ongoingFixed = [snap.current, ...snap.upcoming].filter((item): item is Exclude<NowItem, { kind: "task" }> =>
        !!item && item.kind !== "task" && Date.parse(item.start) <= now.getTime() && Date.parse(item.end) > now.getTime());
      const floor = ongoingFixed.reduce((value, item) => Math.max(value, Date.parse(item.end)), now.getTime());
      const input = collectAutoPlanInput(this.plugin, now, 1);
      const preview = buildPullForward({ ...input, now: new Date(floor), day: this.run.date, skippedTaskIds: this.run.skipped,
        completedEventKeys: this.completedEventKeys() });
      if (!preview.moves.length) return;
      try {
        await this.plugin.timeStore.updateBlocks(this.run.date, preview.moves.map((move) => ({ id: move.id, expectedStart: move.from, patch: { start: move.to } })));
        const undo: StoredUndo = { date: this.run.date, moves: preview.moves.map((move) => ({ id: move.id, before: move.from, after: move.to })) };
        this.plugin.app.saveLocalStorage(NOW_UNDO_KEY, undo); this.emit(); return;
      } catch (error) { if (attempt) throw error; }
    }
  }
  private undo(): StoredUndo | null {
    const value = this.plugin.app.loadLocalStorage(NOW_UNDO_KEY) as StoredUndo | null;
    return value?.date === this.run.date && value.moves.length ? value : null;
  }
  undoSchedule(): Promise<void> { return this.serial(async () => {
    const undo = this.undo(); if (!undo) return;
    await this.plugin.workTimer.stop();
    await this.plugin.timeStore.updateBlocks(undo.date, undo.moves.map((move) => ({ id: move.id, expectedStart: move.after, patch: { start: move.before } })));
    this.plugin.app.saveLocalStorage(NOW_UNDO_KEY, null); this.run.status = "paused"; this.persist();
  }); }

  private async tick(): Promise<void> {
    const day = localDay(new Date());
    if (day !== this.lastDay) {
      this.lastDay = day;
      if (this.isRunning()) await this.stop();
      this.run = { date: day, status: "stopped", skipped: [], blitz: this.blitzEnabled() }; this.persist(); return;
    }
    if (!this.isRunning()) { this.emit(); return; }
    const snap = this.snapshot(), active = this.plugin.workTimer.active();
    const dueFixed = snap.upcoming.some((item) => item.kind !== "task" && Date.parse(item.start) <= Date.now() && Date.parse(item.end) > Date.now());
    const dueTask = this.blitzEnabled() && !active && snap.current?.kind === "task";
    if (dueFixed || dueTask) void this.serial(() => this.advance()); else this.emit();
  }
}
