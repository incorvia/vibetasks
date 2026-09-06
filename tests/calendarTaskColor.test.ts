import { describe, expect, it } from "vitest";
import { calendarTaskColor, stableTaskColor } from "../src/calendarTaskColor";

describe("calendar task colors", () => {
  it("maps meaningful priorities and falls back to the calendar accent", () => {
    expect(calendarTaskColor("priority", { id: "t1", priority: "highest" })).toBe("#ef4444");
    expect(calendarTaskColor("priority", { id: "t1", priority: "normal" })).toBe("var(--interactive-accent)");
    expect(calendarTaskColor("calendar", { id: "t1", priority: "highest" })).toBe("var(--interactive-accent)");
  });

  it("gives a task a stable palette color", () => {
    expect(stableTaskColor("01TASK")).toBe(stableTaskColor("01TASK"));
    expect(calendarTaskColor("task", { id: "01TASK", priority: "normal" })).toMatch(/^#[0-9a-f]{6}$/);
  });
});
