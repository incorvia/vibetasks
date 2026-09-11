import { describe, expect, it } from "vitest";
import { buildAutoPlanDayComparison } from "../src/autoPlanComparison";
import type { AutoPlanInput, AutoPlanPreview } from "../src/autoPlanner";
import type { TimeBlock } from "../src/types";

const block = (id: string, taskId: string, hour: number, values: Partial<TimeBlock> = {}): TimeBlock => ({
  id, kind: "task_schedule", scope: { type: "task", id: taskId, title_snapshot: taskId },
  start: new Date(2026, 8, 11, hour).toISOString(), duration: 30, mode: "focus", selector: "manual",
  status: "planned", source: "manual", ...values,
} as TimeBlock);

const input = (blocks: TimeBlock[]): AutoPlanInput => ({
  tasks: [], blocks, events: [], maps: [], defaultMapId: "default", now: new Date(2026, 8, 11, 8), days: 2,
});

const preview = (values: Partial<AutoPlanPreview> = {}): AutoPlanPreview => ({
  createdAt: new Date(2026, 8, 11, 8).toISOString(), from: "2026-09-11", to: "2026-09-12", days: 2,
  placements: [], preserved: [], unscheduled: [], candidateTaskIds: [], expectedSchedules: {}, ...values,
});

describe("auto-plan before/after comparison", () => {
  it("sorts both calendar columns chronologically", () => {
    const result = buildAutoPlanDayComparison(input([
      block("late", "late", 20), block("early", "early", 14), block("middle", "middle", 15),
    ]), preview(), "2026-09-11");
    expect(result.current.map((item) => item.title)).toEqual(["early", "middle", "late"]);
    expect(result.proposed.map((item) => item.title)).toEqual(["early", "middle", "late"]);
  });

  it("shows candidate schedules on the current side and placements on the proposed side", () => {
    const result = buildAutoPlanDayComparison(input([block("old", "task", 9)]), preview({
      candidateTaskIds: ["task"],
      placements: [{ taskId: "task", title: "task", start: new Date(2026, 8, 11, 13).toISOString(), duration: 30, kind: "moved", previousStart: new Date(2026, 8, 11, 9).toISOString(), afterDeadline: true, blockId: "old" }],
    }), "2026-09-11");
    expect(result.current.map((item) => [item.title, item.change, item.startMin])).toEqual([["task", "moving", 9 * 60]]);
    expect(result.proposed.map((item) => [item.title, item.change, item.startMin, item.afterDeadline])).toEqual([["task", "moved", 13 * 60, true]]);
  });

  it("keeps commitments on both sides and omits an unscheduled candidate from the proposal", () => {
    const commitment = block("pinned", "pinned", 10, { pinned: true });
    const candidate = block("candidate", "candidate", 11);
    const result = buildAutoPlanDayComparison(input([commitment, candidate]), preview({ candidateTaskIds: ["candidate"] }), "2026-09-11");
    expect(result.current.map((item) => item.title)).toEqual(["pinned", "candidate"]);
    expect(result.proposed.map((item) => item.title)).toEqual(["pinned"]);
  });

  it("opens the unused tail of an early-completed block in the proposed calendar", () => {
    const completed = block("done", "done", 9, {
      duration: 60, status: "completed", completed_at: new Date(2026, 8, 11, 9, 15).toISOString(), pinned: true,
    });
    const result = buildAutoPlanDayComparison(input([completed]), preview(), "2026-09-11");
    expect(result.current[0]).toMatchObject({ startMin: 9 * 60, endMin: 10 * 60, completed: true, pinned: true });
    expect(result.proposed[0]).toMatchObject({ startMin: 9 * 60, endMin: 9 * 60 + 15, completed: true, pinned: true });
  });
});
