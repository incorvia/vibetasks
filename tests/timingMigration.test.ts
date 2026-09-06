import { describe, expect, it } from "vitest";
import { migrateTimingFields, migratedDeadline } from "../src/timingMigration";

describe("timing migration", () => {
  it("chooses the earlier deadline and compares date-only values at local end-of-day", () => {
    expect(migratedDeadline("2026-09-10", "2026-09-09T23:00:00")).toBe("2026-09-09T23:00:00");
    expect(migratedDeadline("2026-09-10", "2026-09-10T23:59:59.999")).toBe("2026-09-10");
    expect(migratedDeadline("2026-09-10", null)).toBe("2026-09-10");
  });

  it("moves duration to estimate, removes legacy timing and Google links, and preserves unknown fields", () => {
    const fm: Record<string, unknown> = {
      due: "2026-09-12", scheduled: "2026-09-11", start: "2026-09-01", duration: 45,
      gcal_event_id: "event", gcal_calendar_id: "calendar", custom: { keep: true },
    };
    const result = migrateTimingFields(fm);
    expect(result.changed).toBe(true);
    expect(result.before).toMatchObject({ duration: 45, gcal_event_id: "event" });
    expect(fm).toEqual({ due: "2026-09-11", estimate: 45, custom: { keep: true } });
  });

  it("keeps an existing valid estimate over duration and is idempotent", () => {
    const fm: Record<string, unknown> = { due: "2026-09-12", duration: 30, estimate: 90 };
    migrateTimingFields(fm);
    expect(fm).toEqual({ due: "2026-09-12", estimate: 90 });
    expect(migrateTimingFields(fm).changed).toBe(false);
  });
});
