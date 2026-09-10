import { describe, expect, it, vi } from "vitest";
import { dashboardReport, sessionDay, sessionSeconds } from "../src/timeDashboardModel";
import { WorkTimerService } from "../src/workTimerService";
import type { TimerService, TimeStore } from "../src/timeService";
import type { Task, TimeBlock, WorkSession } from "../src/types";

const session = (overrides: Partial<WorkSession> = {}): WorkSession => ({
  id: "s1", task_id: "t1", task_title_snapshot: "Draft", device_id: "d1",
  started_at: "2026-01-06T10:00:00", ended_at: "2026-01-06T10:30:00", elapsed: 1800,
  ...overrides,
});

describe("time dashboard reporting", () => {
  it("uses the local date for UTC sessions near midnight", () => {
    const started = new Date(2026, 0, 6, 23, 45).toISOString();
    const item = session({ started_at: started });
    expect(sessionDay(item)).toBe("2026-01-06");
    expect(dashboardReport([item], [], "2026-01-06", "2026-01-06").sessions).toHaveLength(1);
    expect(dashboardReport([item], [], "2026-01-07", "2026-01-07").sessions).toHaveLength(0);
  });

  it("aggregates seconds before rounding and includes live sessions", () => {
    const now = Date.parse("2026-01-06T10:02:00");
    const result = dashboardReport([
      session({ elapsed: 20 }), session({ id: "s2", elapsed: 20 }),
      session({ id: "s3", ended_at: undefined, elapsed: undefined }),
    ], [], "2026-01-06", "2026-01-06", now);
    expect(result.actual).toBe(160);
    expect(result.days[0][1].actual).toBe(160);
    expect(sessionSeconds(session({ elapsed: undefined }))).toBe(1800);
    expect(sessionSeconds(session({ started_at: "invalid", ended_at: undefined }))).toBe(0);
  });

  it("counts cross-midnight work on its start day and ignores cancelled/all-day plans", () => {
    const base = { id: "b1", kind: "task_schedule", scope: { type: "task", id: "t1", title_snapshot: "Draft" }, mode: "focus", selector: "manual", status: "planned", source: "manual" } as const;
    const blocks: TimeBlock[] = [
      { ...base, start: "2026-01-06T23:30:00", duration: 90 },
      { ...base, id: "b2", allDay: true, date: "2026-01-06" },
      { ...base, id: "b3", start: "2026-01-06T12:00:00", duration: 30, status: "cancelled" },
    ];
    const work = session({ started_at: "2026-01-06T23:30:00", ended_at: "2026-01-07T01:00:00", elapsed: 5400 });
    expect(dashboardReport([work], blocks, "2026-01-06", "2026-01-06")).toMatchObject({ actual: 5400, planned: 5400 });
    expect(dashboardReport([work], blocks, "2026-01-07", "2026-01-07")).toMatchObject({ actual: 0, planned: 0 });
  });

  it("sorts records by instant despite different offsets", () => {
    const first = session({ id: "first", started_at: "2026-01-06T10:00:00-05:00" });
    const second = session({ id: "second", started_at: "2026-01-06T11:00:00+01:00" });
    expect(dashboardReport([second, first], [], "2026-01-01", "2026-01-31").sessions.map((item) => item.id)).toEqual(["first", "second"]);
  });
});

function fixture(item = session(), active = false) {
  const store = { session: () => item, addSession: vi.fn(async () => undefined), updateSession: vi.fn(async () => undefined) };
  const timers = { active: () => active ? { session_id: item.id } : null };
  const service = new WorkTimerService(timers as unknown as TimerService, store as unknown as TimeStore, {
    taskById: (id) => id === "t1" ? { id, title: "Draft" } as Task : undefined,
    tasksForScope: async () => [], snapshotsForTask: async () => ({ project_id_snapshot: "p1", project_title_snapshot: "Project" }),
    markTaskComplete: async () => undefined, notify: () => undefined,
  });
  return { service, store };
}

describe("recording and correcting work", () => {
  const input = { started_at: "2026-01-06T10:00:30Z", ended_at: "2026-01-06T10:45:45Z" };
  it("creates manual time with snapshots without starting a timer", async () => {
    const { service, store } = fixture();
    await service.recordTime("t1", input);
    expect(store.addSession).toHaveBeenCalledWith(expect.objectContaining({ task_id: "t1", device_id: "manual", elapsed: 2715, project_id_snapshot: "p1" }));
    await expect(service.recordTime("missing", input)).rejects.toThrow("no longer exists");
  });

  it("recalculates elapsed seconds on edit", async () => {
    const { service, store } = fixture();
    await service.editRecordedTime("s1", input);
    expect(store.updateSession).toHaveBeenCalledWith("s1", { started_at: "2026-01-06T10:00:30.000Z", ended_at: "2026-01-06T10:45:45.000Z", elapsed: 2715 });
  });

  it("rejects open sessions, stale edits, and invalid intervals before writing", async () => {
    await expect(fixture(session({ ended_at: undefined })).service.editRecordedTime("s1", input)).rejects.toThrow("Stop the timer");
    await expect(fixture(session(), true).service.editRecordedTime("s1", input)).rejects.toThrow("Stop the timer");
    const { service, store } = fixture();
    await expect(service.editRecordedTime("s1", input, input)).rejects.toThrow("changed while");
    for (const invalid of [
      { ...input, started_at: "invalid" }, { ...input, ended_at: input.started_at },
      { ...input, ended_at: "2026-01-05T10:00:00Z" }, { ...input, ended_at: "2099-01-01T10:00:00Z" },
    ]) await expect(service.editRecordedTime("s1", invalid)).rejects.toThrow();
    expect(store.updateSession).not.toHaveBeenCalled();
  });
});
