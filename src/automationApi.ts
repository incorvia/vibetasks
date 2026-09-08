import { isAllDaySchedule, type CalEvent, type Priority, type StatusKind, type StoredStatus, type Task, type TaskStatus, type TimeBlock, type WorkSession } from "./types";

export const AUTOMATION_API_VERSION = "1.0";

export type AutomationEvent = "tasks-changed" | "time-changed" | "calendar-changed";

export interface AutomationCapabilities {
  apiVersion: string;
  transport: "obsidian-eval";
  features: {
    dayContext: true;
    planValidation: true;
    planApplication: true;
    taskCreation: true;
    taskUpdates: readonly ["due", "estimate", "priority", "status"];
    scheduling: readonly ["schedule-task", "unschedule-task"];
    calendarEvents: "read-only";
    workSessions: "read-only";
    subscriptions: readonly AutomationEvent[];
    atomicPlanWrites: false;
    idempotency: "plugin-session";
  };
}

export interface AutomationTask {
  id: string;
  path: string;
  title: string;
  status: TaskStatus;
  statusKind: StatusKind | "unknown";
  priority: Priority;
  due: string | null;
  dueTime: string | null;
  estimate: number | null;
  project: string | null;
  projectId: string | null;
  parent: string | null;
  parentId: string | null;
  labels: string[];
  recurrence: string | null;
  completed: string | null;
  cancelled: string | null;
}

export interface CalendarAutomationStatus {
  active: boolean;
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

export interface DayContext {
  apiVersion: string;
  date: string;
  generatedAt: string;
  timeZone: string;
  revision: string;
  statuses: StoredStatus[];
  tasks: AutomationTask[];
  blocks: TimeBlock[];
  sessions: WorkSession[];
  events: CalEvent[];
  calendar: CalendarAutomationStatus;
}

export type ScheduleInput =
  | { allDay: true; date: string }
  | { allDay?: false; start: string; duration?: number };

export interface AutomationTaskPatch {
  due?: string | null;
  estimate?: number | null;
  priority?: Priority;
}

export interface AutomationTaskCreate {
  title: string;
  description?: string;
  due?: string | null;
  estimate?: number | null;
  priority?: Priority;
  labels?: string[];
  projectId?: string | null;
}

export type PlanOperation =
  | { type: "schedule-task"; taskId: string; schedule: ScheduleInput }
  | { type: "unschedule-task"; taskId: string }
  | { type: "update-task"; taskId: string; patch: AutomationTaskPatch }
  | { type: "set-task-status"; taskId: string; status: string }
  | { type: "create-task"; task: AutomationTaskCreate; schedule?: ScheduleInput };

export interface PlanMutation {
  date: string;
  expectedRevision?: string;
  idempotencyKey?: string;
  allowConflicts?: boolean;
  operations: PlanOperation[];
}

export type PlanIssueCode =
  | "invalid-date" | "invalid-operation" | "invalid-start" | "invalid-duration"
  | "invalid-due" | "invalid-estimate" | "invalid-priority" | "invalid-status"
  | "task-not-found" | "task-not-open" | "outside-plan-date" | "conflict" | "stale-revision";

export interface PlanIssue {
  severity: "error" | "warning";
  code: PlanIssueCode;
  message: string;
  operationIndex?: number;
  conflictsWith?: string;
}

export interface PlanValidationResult {
  ok: boolean;
  revision: string;
  issues: PlanIssue[];
}

export interface AppliedOperation {
  operationIndex: number;
  type: PlanOperation["type"];
  status: "applied" | "failed";
  taskId?: string;
  taskPath?: string;
  blockId?: string;
  error?: string;
}

export interface PlanApplyResult {
  applied: boolean;
  replayed: boolean;
  validation: PlanValidationResult;
  operations: AppliedOperation[];
}

export interface AutomationApiHost {
  tasks(): Task[];
  blocksIn(from: string, to: string): TimeBlock[];
  sessions(): WorkSession[];
  statuses(): StoredStatus[];
  calendarStatus(): CalendarAutomationStatus;
  calendarEvents(date: string, refresh: boolean): Promise<CalEvent[]>;
  scheduleTask(task: Task | string, schedule: ScheduleInput): Promise<TimeBlock>;
  unscheduleTask(taskId: string): Promise<void>;
  updateTask(task: Task, patch: AutomationTaskPatch): Promise<void>;
  setTaskStatus(task: Task, status: string): Promise<void>;
  createTask(input: AutomationTaskCreate): Promise<Task>;
  subscribeTasks(cb: () => void): () => void;
  subscribeTime(cb: () => void): () => void;
  subscribeCalendar(cb: () => void): () => void;
}

interface Interval { start: number; end: number; label: string; taskId?: string }

const PRIORITIES: Priority[] = ["highest", "high", "medium", "normal", "low", "lowest"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && localDay(parsed) === value;
}

function localDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function validDue(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !DUE.test(value)) return false;
  return value.length === 10 ? validDay(value) : !Number.isNaN(Date.parse(value));
}

function validMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.round(value) === value && value >= 1;
}

function stableHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function interval(start: string, duration: number, label: string, taskId?: string): Interval | null {
  const from = Date.parse(start);
  if (!Number.isFinite(from) || !validMinutes(duration)) return null;
  return { start: from, end: from + duration * 60_000, label, taskId };
}

function eventInterval(event: CalEvent): Interval | null {
  if (event.allDay) {
    const start = Date.parse(`${event.start.slice(0, 10)}T00:00:00`);
    const end = Date.parse(`${event.end.slice(0, 10)}T00:00:00`);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? { start, end, label: `calendar event: ${event.title}` }
      : null;
  }
  const start = Date.parse(event.start), end = Date.parse(event.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? { start, end, label: `calendar event: ${event.title}` }
    : null;
}

function blockInterval(block: TimeBlock): Interval | null {
  if (isAllDaySchedule(block)) return null;
  return interval(block.start, block.duration, `time block: ${block.scope.title_snapshot}`, block.scope.type === "task" ? block.scope.id : undefined);
}

const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

export class OpalTasksAutomationApi {
  readonly v1 = this;
  private listeners = new Set<(event: AutomationEvent) => void>();
  private unsubs: (() => void)[];
  private replay = new Map<string, { request: string; result: PlanApplyResult }>();

  constructor(private host: AutomationApiHost) {
    this.unsubs = [
      host.subscribeTasks(() => this.emit("tasks-changed")),
      host.subscribeTime(() => this.emit("time-changed")),
      host.subscribeCalendar(() => this.emit("calendar-changed")),
    ];
  }

  capabilities(): AutomationCapabilities {
    return {
      apiVersion: AUTOMATION_API_VERSION,
      transport: "obsidian-eval",
      features: {
        dayContext: true,
        planValidation: true,
        planApplication: true,
        taskCreation: true,
        taskUpdates: ["due", "estimate", "priority", "status"],
        scheduling: ["schedule-task", "unschedule-task"],
        calendarEvents: "read-only",
        workSessions: "read-only",
        subscriptions: ["tasks-changed", "time-changed", "calendar-changed"],
        atomicPlanWrites: false,
        idempotency: "plugin-session",
      },
    };
  }

  subscribe(listener: (event: AutomationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const unsub of this.unsubs.splice(0)) unsub();
    this.listeners.clear();
    this.replay.clear();
  }

  async getDayContext(input: { date: string; refreshCalendar?: boolean }): Promise<DayContext> {
    if (!validDay(input?.date)) throw new Error("date must be a real local date in YYYY-MM-DD format");
    const events = await this.host.calendarEvents(input.date, input.refreshCalendar === true);
    return this.context(input.date, events);
  }

  async validatePlan(input: PlanMutation): Promise<PlanValidationResult> {
    const date = input?.date;
    if (!validDay(date)) return { ok: false, revision: "", issues: [{ severity: "error", code: "invalid-date", message: "date must be a real local date in YYYY-MM-DD format" }] };
    const context = this.context(date, await this.host.calendarEvents(date, false));
    const issues: PlanIssue[] = [];
    if (input.expectedRevision && input.expectedRevision !== context.revision) {
      issues.push({ severity: "error", code: "stale-revision", message: "Tasks, calendar events, or occupied time changed after the plan was drafted." });
    }
    if (!Array.isArray(input.operations)) {
      issues.push({ severity: "error", code: "invalid-operation", message: "operations must be an array" });
      return { ok: false, revision: context.revision, issues };
    }

    const byId = new Map(this.host.tasks().map((task) => [task.id, task]));
    const statuses = new Map(this.host.statuses().map((status) => [status.id, status.kind]));
    const scheduledIds = new Set(input.operations.filter((op): op is Extract<PlanOperation, { type: "schedule-task" }> => op?.type === "schedule-task").map((op) => op.taskId));
    const occupied: Interval[] = context.blocks
      .filter((block) => block.status !== "cancelled" && !(block.kind === "task_schedule" && scheduledIds.has(block.scope.id)))
      .map(blockInterval)
      .filter((value): value is Interval => value !== null);
    occupied.push(...context.events.map(eventInterval).filter((value): value is Interval => value !== null));

    const proposed: { value: Interval; operationIndex: number }[] = [];
    input.operations.forEach((operation, operationIndex) => {
      const problem = (code: PlanIssueCode, message: string): void => { issues.push({ severity: "error", code, message, operationIndex }); };
      if (!operation || typeof operation !== "object" || typeof operation.type !== "string") { problem("invalid-operation", "Operation must be an object with a supported type."); return; }
      if (operation.type === "schedule-task" || operation.type === "unschedule-task" || operation.type === "update-task" || operation.type === "set-task-status") {
        const task = typeof operation.taskId === "string" ? byId.get(operation.taskId) : undefined;
        if (!task) { problem("task-not-found", `No task with id ${String(operation.taskId)}.`); return; }
        if (operation.type === "schedule-task" && statuses.get(task.status) !== "open") problem("task-not-open", `Task ${task.id} is not open.`);
        if (operation.type === "set-task-status" && !statuses.has(operation.status)) problem("invalid-status", `Unknown status ${String(operation.status)}.`);
        if (operation.type === "update-task") this.validatePatch(operation.patch, problem);
        if (operation.type === "schedule-task") this.validateSchedule(operation.schedule, date, task.title, task.id, operationIndex, proposed, problem);
        return;
      }
      if (operation.type === "create-task") {
        if (!operation.task || typeof operation.task.title !== "string" || !operation.task.title.trim()) problem("invalid-operation", "A created task needs a non-empty title.");
        else {
          this.validatePatch(operation.task, problem);
          if (operation.task.labels !== undefined && (!Array.isArray(operation.task.labels) || operation.task.labels.some((label) => typeof label !== "string" || !label.trim())))
            problem("invalid-operation", "task.labels must be an array of non-empty strings.");
          if (operation.task.description !== undefined && typeof operation.task.description !== "string") problem("invalid-operation", "task.description must be a string.");
          if (operation.task.projectId !== undefined && operation.task.projectId !== null && typeof operation.task.projectId !== "string") problem("invalid-operation", "task.projectId must be a string or null.");
          if (operation.schedule) this.validateSchedule(operation.schedule, date, operation.task.title, undefined, operationIndex, proposed, problem);
        }
        return;
      }
      problem("invalid-operation", `Unsupported operation type ${String((operation as { type?: unknown }).type)}.`);
    });

    for (let i = 0; i < proposed.length; i++) {
      const candidate = proposed[i];
      for (const existing of occupied) if (overlaps(candidate.value, existing)) {
        issues.push({ severity: input.allowConflicts ? "warning" : "error", code: "conflict", operationIndex: candidate.operationIndex,
          conflictsWith: existing.label, message: `${candidate.value.label} overlaps ${existing.label}.` });
      }
      for (let j = 0; j < i; j++) if (overlaps(candidate.value, proposed[j].value)) {
        issues.push({ severity: input.allowConflicts ? "warning" : "error", code: "conflict", operationIndex: candidate.operationIndex,
          conflictsWith: proposed[j].value.label, message: `${candidate.value.label} overlaps ${proposed[j].value.label}.` });
      }
    }
    return { ok: !issues.some((issue) => issue.severity === "error"), revision: context.revision, issues };
  }

  async applyPlan(input: PlanMutation): Promise<PlanApplyResult> {
    const request = stableHash({ date: input?.date, expectedRevision: input?.expectedRevision, allowConflicts: input?.allowConflicts, operations: input?.operations });
    const previous = input?.idempotencyKey ? this.replay.get(input.idempotencyKey) : undefined;
    if (previous) {
      if (previous.request === request) return { ...previous.result, replayed: true };
      return {
        applied: false, replayed: false, operations: [],
        validation: { ok: false, revision: previous.result.validation.revision, issues: [{
          severity: "error", code: "invalid-operation", message: "This idempotency key was already used for a different plan payload.",
        }] },
      };
    }
    const validation = await this.validatePlan(input);
    if (!validation.ok) return { applied: false, replayed: false, validation, operations: [] };
    const results: AppliedOperation[] = [];
    for (let operationIndex = 0; operationIndex < input.operations.length; operationIndex++) {
      const operation = input.operations[operationIndex];
      try {
        const tasks = new Map(this.host.tasks().map((task) => [task.id, task]));
        if (operation.type === "schedule-task") {
          const block = await this.host.scheduleTask(operation.taskId, operation.schedule);
          results.push({ operationIndex, type: operation.type, status: "applied", taskId: operation.taskId, blockId: block.id });
        } else if (operation.type === "unschedule-task") {
          await this.host.unscheduleTask(operation.taskId);
          results.push({ operationIndex, type: operation.type, status: "applied", taskId: operation.taskId });
        } else if (operation.type === "update-task") {
          const task = tasks.get(operation.taskId)!;
          await this.host.updateTask(task, operation.patch);
          results.push({ operationIndex, type: operation.type, status: "applied", taskId: task.id, taskPath: task.path });
        } else if (operation.type === "set-task-status") {
          const task = tasks.get(operation.taskId)!;
          await this.host.setTaskStatus(task, operation.status);
          results.push({ operationIndex, type: operation.type, status: "applied", taskId: task.id, taskPath: task.path });
        } else {
          const task = await this.host.createTask(operation.task);
          try {
            const block = operation.schedule ? await this.host.scheduleTask(task, operation.schedule) : null;
            results.push({ operationIndex, type: operation.type, status: "applied", taskId: task.id, taskPath: task.path, blockId: block?.id });
          } catch (error) {
            // Creation and scheduling touch different Markdown records. Preserve the created task
            // identity in the failure report so a caller can recover without creating a duplicate.
            results.push({ operationIndex, type: operation.type, status: "failed", taskId: task.id, taskPath: task.path,
              error: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        results.push({ operationIndex, type: operation.type, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const result: PlanApplyResult = { applied: results.every((item) => item.status === "applied"), replayed: false, validation, operations: results };
    if (input.idempotencyKey) this.replay.set(input.idempotencyKey, { request, result });
    return result;
  }

  async updateTask(input: { taskId: string; patch: AutomationTaskPatch }): Promise<AppliedOperation> {
    const result = await this.applyPlan({ date: localDay(new Date()), allowConflicts: true, operations: [{ type: "update-task", ...input }] });
    return result.operations[0] ?? { operationIndex: 0, type: "update-task", status: "failed", error: result.validation.issues.map((issue) => issue.message).join("; ") };
  }

  async setTaskStatus(input: { taskId: string; status: string }): Promise<AppliedOperation> {
    const result = await this.applyPlan({ date: localDay(new Date()), allowConflicts: true, operations: [{ type: "set-task-status", ...input }] });
    return result.operations[0] ?? { operationIndex: 0, type: "set-task-status", status: "failed", error: result.validation.issues.map((issue) => issue.message).join("; ") };
  }

  private context(date: string, events: CalEvent[]): DayContext {
    const blocks = this.host.blocksIn(date, date).map((block) => ({ ...block, scope: { ...block.scope } }));
    const sessions = this.host.sessions().filter((session) => localDay(session.started_at) === date).map((session) => ({ ...session }));
    const relevantIds = new Set([
      ...blocks.filter((block) => block.scope.type === "task").map((block) => block.scope.id),
      ...sessions.map((session) => session.task_id),
    ]);
    const statuses = this.host.statuses().map((status) => ({ ...status }));
    const statusKinds = new Map(statuses.map((status) => [status.id, status.kind]));
    const tasks = this.host.tasks()
      .filter((task) => statusKinds.get(task.status) === "open" || relevantIds.has(task.id))
      .map((task): AutomationTask => ({
        id: task.id, path: task.path, title: task.title, status: task.status,
        statusKind: statusKinds.get(task.status) ?? "unknown", priority: task.priority,
        due: task.due, dueTime: task.dueTime, estimate: task.estimate ?? null,
        project: task.project, projectId: task.projectId ?? null, parent: task.parent, parentId: task.parentId ?? null,
        labels: [...task.labels], recurrence: task.recurrence, completed: task.completed, cancelled: task.cancelled,
      }));
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    blocks.sort((a, b) => {
      const aStart = isAllDaySchedule(a) ? a.date : a.start;
      const bStart = isAllDaySchedule(b) ? b.date : b.start;
      return aStart.localeCompare(bStart) || a.id.localeCompare(b.id);
    });
    sessions.sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
    const sortedEvents = events.map((event) => ({ ...event })).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    const revision = stableHash({ tasks, blocks, sessions, events: sortedEvents, statuses });
    return {
      apiVersion: AUTOMATION_API_VERSION, date, generatedAt: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", revision, statuses,
      tasks, blocks, sessions, events: sortedEvents, calendar: { ...this.host.calendarStatus() },
    };
  }

  private validatePatch(patch: AutomationTaskPatch | AutomationTaskCreate | undefined, problem: (code: PlanIssueCode, message: string) => void): void {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) { problem("invalid-operation", "A task patch must be an object."); return; }
    if ("due" in patch && !validDue(patch.due)) problem("invalid-due", "due must be null, YYYY-MM-DD, or a valid local/offset date-time.");
    if ("estimate" in patch && patch.estimate !== null && patch.estimate !== undefined && !validMinutes(patch.estimate)) problem("invalid-estimate", "estimate must be null or a positive whole number of minutes.");
    if ("priority" in patch && patch.priority !== undefined && !PRIORITIES.includes(patch.priority)) problem("invalid-priority", `priority must be one of ${PRIORITIES.join(", ")}.`);
  }

  private validateSchedule(schedule: ScheduleInput, date: string, title: string, taskId: string | undefined, operationIndex: number,
    proposed: { value: Interval; operationIndex: number }[], problem: (code: PlanIssueCode, message: string) => void): void {
    if (!schedule || typeof schedule !== "object") { problem("invalid-start", "schedule must be a timed or all-day placement."); return; }
    if (schedule.allDay === true) {
      if (!validDay(schedule.date)) { problem("invalid-start", "An all-day schedule needs a real YYYY-MM-DD date."); return; }
      if (schedule.date !== date) problem("outside-plan-date", `Scheduled date must be ${date}.`);
      return;
    }
    if (typeof schedule.start !== "string" || Number.isNaN(Date.parse(schedule.start))) { problem("invalid-start", "schedule.start must be a valid date-time."); return; }
    if (localDay(schedule.start) !== date) problem("outside-plan-date", `Scheduled start must fall on ${date} in the local timezone.`);
    const duration = schedule.duration;
    if (duration !== undefined && !validMinutes(duration)) { problem("invalid-duration", "schedule.duration must be a positive whole number of minutes."); return; }
    const task = taskId ? this.host.tasks().find((candidate) => candidate.id === taskId) : undefined;
    const value = interval(schedule.start, duration ?? task?.estimate ?? 60, `proposed task: ${title}`, taskId);
    if (value) proposed.push({ value, operationIndex });
  }

  private emit(event: AutomationEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
