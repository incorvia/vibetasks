import { describe, expect, it } from "vitest";
import { bucketBlocks } from "../src/calendarView";
import { timeLogPath } from "../src/timeService";
import type { TimeBlock } from "../src/types";

const block = (over: Partial<TimeBlock> = {}): TimeBlock => ({
  id: "01BLOCK", start: "2026-09-06T23:30:00", duration: 90,
  kind: "allocation",
  scope: { type: "project", id: "p1", title_snapshot: "Project" },
  mode: "focus", selector: "manual", status: "planned", source: "manual", ...over,
});

describe("time model", () => {
  it("uses year-partitioned canonical daily paths", () => {
    expect(timeLogPath("2026-09-06")).toBe("_opal_tasks/time/2026/2026-09-06.md");
  });

  it("renders a cross-midnight block on both days without splitting its identity", () => {
    const result = bucketBlocks([block()], ["2026-09-06", "2026-09-07"]);
    expect(result.get("2026-09-06")?.[0]).toMatchObject({ startMin: 1410, endMin: 1440 });
    expect(result.get("2026-09-07")?.[0]).toMatchObject({ startMin: 0, endMin: 60 });
    expect(result.get("2026-09-06")?.[0].block).toBe(result.get("2026-09-07")?.[0].block);
  });

  it("does not render cancelled blocks", () => {
    expect(bucketBlocks([block({ status: "cancelled" })], ["2026-09-06"]).get("2026-09-06")).toEqual([]);
  });

  it("places a date-only task schedule in the all-day bucket", () => {
    const allDay: TimeBlock = {
      id: "01ALLDAY", kind: "task_schedule", allDay: true, date: "2026-09-07",
      scope: { type: "task", id: "t1", title_snapshot: "Write report" },
      mode: "focus", selector: "manual", status: "planned", source: "manual",
    };
    const result = bucketBlocks([allDay], ["2026-09-06", "2026-09-07"]);
    expect(result.get("2026-09-06")).toEqual([]);
    expect(result.get("2026-09-07")?.[0]).toMatchObject({ block: allDay, startMin: null, endMin: null });
  });
});
