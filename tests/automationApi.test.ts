import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_API_VERSION,
  AutomationApiHost,
  AutomationTaskCreate,
  OpalTasksAutomationApi,
  PlanMutation,
  ScheduleInput,
} from "../src/automationApi";
import type { CalEvent, Task, TimeBlock, WorkSession } from "../src/types";

const day = "2026-09-08";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, path: `_opal_tasks/tasks/${id}.md`, title: `Task ${id}`, titleInFm: true,
    status: "todo", priority: "normal", due: null, dueTime: null, estimate: 30,
    project: null, projectId: null, parent: null, parentId: null, labels: [], description: "",
    recurrence: null, recurBasis: "due", reminders: [], sortOrder: null,
    created: "2026-09-01T12:00:00Z", completed: null, cancelled: null, externalId: null,
    ...over,
  };
}

function fixture(options: { events?: CalEvent[]; blocks?: TimeBlock[]; sessions?: WorkSession[] } = {}) {
  const tasks = [task("t1"), task("t2", { status: "done", completed: "2026-09-08T16:00:00Z" })];
  const blocks = [...(options.blocks ?? [])];
  const sessions = [...(options.sessions ?? [])];
  const events = [...(options.events ?? [])];
  const taskListeners = new Set<() => void>(), timeListeners = new Set<() => void>(), calendarListeners = new Set<() => void>();
  let next = 1;
  const scheduleTask = vi.fn(async (candidate: Task | string, schedule: ScheduleInput): Promise<TimeBlock> => {
    const id = typeof candidate === "string" ? candidate : candidate.id;
    const found = tasks.find((value) => value.id === id) ?? (typeof candidate === "string" ? undefined : candidate);
    if (!found) throw new Error("missing task");
    const common = { id: `b${next++}`, kind: "task_schedule" as const, scope: { type: "task" as const, id: found.id, title_snapshot: found.title },
      mode: "focus" as const, selector: "manual" as const, status: "planned" as const, source: "ai" as const };
    const block: TimeBlock = schedule.allDay
      ? { ...common, allDay: true, date: schedule.date }
      : { ...common, allDay: false, start: new Date(schedule.start).toISOString(), duration: schedule.duration ?? found.estimate ?? 60 };
    blocks.push(block); return block;
  });
  const createTask = vi.fn(async (input: AutomationTaskCreate) => {
    const created = task(`new-${next++}`, { title: input.title, estimate: input.estimate ?? null, priority: input.priority ?? "normal", labels: input.labels ?? [] });
    tasks.push(created); return created;
  });
  const host: AutomationApiHost = {
    tasks: () => tasks,
    blocksIn: () => blocks,
    sessions: () => sessions,
    statuses: () => [
      { id: "todo", kind: "open", label: "To-do" },
      { id: "done", kind: "done", label: "Done" },
      { id: "cancelled", kind: "cancelled", label: "Cancelled" },
    ],
    calendarStatus: () => ({ active: true, loading: false, error: null, lastLoadedAt: 123 }),
    calendarEvents: vi.fn(async () => events),
    scheduleTask,
    unscheduleTask: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    setTaskStatus: vi.fn(async () => undefined),
    createTask,
    subscribeTasks: (cb) => { taskListeners.add(cb); return () => taskListeners.delete(cb); },
    subscribeTime: (cb) => { timeListeners.add(cb); return () => timeListeners.delete(cb); },
    subscribeCalendar: (cb) => { calendarListeners.add(cb); return () => calendarListeners.delete(cb); },
  };
  return { api: new OpalTasksAutomationApi(host), host, tasks, blocks, scheduleTask, createTask, taskListeners };
}

describe("OpalTasksAutomationApi", () => {
  it("advertises a stable v1 surface and returns a normalized day snapshot", async () => {
    const work: WorkSession = { id: "s1", task_id: "t2", task_title_snapshot: "Task t2", started_at: "2026-09-08T15:00:00-05:00", ended_at: "2026-09-08T15:30:00-05:00", device_id: "d" };
    const { api } = fixture({ sessions: [work] });

    expect(api.v1).toBe(api);
    expect(api.capabilities()).toMatchObject({ apiVersion: AUTOMATION_API_VERSION, features: { dayContext: true, atomicPlanWrites: false } });
    const context = await api.getDayContext({ date: day });

    expect(context.tasks.map((value) => [value.id, value.statusKind])).toEqual([["t1", "open"], ["t2", "done"]]);
    expect(context.sessions).toEqual([work]);
    expect(context.revision).toMatch(/^fnv1a-/);
    expect((await api.getDayContext({ date: day })).revision).toBe(context.revision);
  });

  it("detects occupied calendar time and permits an explicit conflict override", async () => {
    const event: CalEvent = {
      id: "event", calendarId: "cal", title: "Standup", start: "2026-09-08T09:00", end: "2026-09-08T09:30",
      allDay: false, color: "#fff", htmlLink: "",
    };
    const { api } = fixture({ events: [event] });
    const mutation: PlanMutation = { date: day, operations: [{ type: "schedule-task", taskId: "t1", schedule: { start: "2026-09-08T09:15", duration: 30 } }] };

    const rejected = await api.validatePlan(mutation);
    expect(rejected.ok).toBe(false);
    expect(rejected.issues).toContainEqual(expect.objectContaining({ code: "conflict", operationIndex: 0 }));

    const allowed = await api.validatePlan({ ...mutation, allowConflicts: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.issues).toContainEqual(expect.objectContaining({ code: "conflict", severity: "warning" }));
  });

  it("rejects a plan when its snapshot revision is stale", async () => {
    const { api, tasks } = fixture();
    const context = await api.getDayContext({ date: day });
    tasks[0].title = "Changed after drafting";

    const validation = await api.validatePlan({ date: day, expectedRevision: context.revision, operations: [] });

    expect(validation.ok).toBe(false);
    expect(validation.issues).toContainEqual(expect.objectContaining({ code: "stale-revision" }));
  });

  it("supports date-only task placement without inventing a 24-hour timed block", async () => {
    const event: CalEvent = {
      id: "busy", calendarId: "primary", title: "Busy", start: "2026-09-08T09:00:00-05:00", end: "2026-09-08T10:00:00-05:00",
      allDay: false, color: "#fff", htmlLink: "",
    };
    const { api, scheduleTask } = fixture({ events: [event] });
    const result = await api.applyPlan({
      date: day,
      operations: [{ type: "schedule-task", taskId: "t1", schedule: { allDay: true, date: day } }],
    });

    expect(result.applied).toBe(true);
    expect(scheduleTask).toHaveBeenCalledWith("t1", { allDay: true, date: day });
    expect(result.validation.issues).not.toContainEqual(expect.objectContaining({ code: "conflict" }));
  });

  it("applies task creation and scheduling through the host and replays an idempotency key", async () => {
    const { api, createTask, scheduleTask } = fixture();
    const mutation: PlanMutation = {
      date: day, idempotencyKey: "day-plan:2026-09-08:v1",
      operations: [{ type: "create-task", task: { title: "Lunch", estimate: 45 }, schedule: { start: "2026-09-08T12:00:00-05:00", duration: 45 } }],
    };

    const first = await api.applyPlan(mutation);
    const second = await api.applyPlan(mutation);

    expect(first.applied).toBe(true);
    expect(first.operations[0]).toMatchObject({ status: "applied", taskId: expect.stringMatching(/^new-/), blockId: expect.stringMatching(/^b/) });
    expect(second.replayed).toBe(true);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(scheduleTask).toHaveBeenCalledTimes(1);

    const mismatch = await api.applyPlan({ ...mutation, operations: [] });
    expect(mismatch.validation.issues).toContainEqual(expect.objectContaining({ code: "invalid-operation" }));
  });

  it("emits coarse change hooks and removes them on dispose", () => {
    const { api, taskListeners } = fixture();
    const listener = vi.fn();
    api.subscribe(listener);
    [...taskListeners][0]();
    expect(listener).toHaveBeenCalledWith("tasks-changed");

    api.dispose();
    expect(taskListeners.size).toBe(0);
  });
});
