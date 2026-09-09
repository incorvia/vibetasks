import { describe, expect, it } from "vitest";
import { DEFAULT_CHIP_PROFILES, KANBAN_PRIOS, PRIOS, chipTierOf, defaultScheduleDuration, resolveChipOrder } from "../src/chips";
import type { OpalTasksSettings } from "../src/types";

const settings = (value: Partial<OpalTasksSettings> = {}): OpalTasksSettings => value as OpalTasksSettings;

describe("When and Deadline chip profiles", () => {
  it("shows When and moves an unset Deadline to overflow by default on both editors", () => {
    for (const surface of ["editor", "quickAdd"] as const) {
      expect(DEFAULT_CHIP_PROFILES[surface].order?.[0]).toBe("when");
      expect(chipTierOf(settings(), surface, "when")).toBe("shown");
      expect(chipTierOf(settings(), surface, "due")).toBe("onValue");
    }
  });

  it("preserves a customized profile and appends the new chip without rewriting it", () => {
    const custom = settings({ chipProfiles: { editor: {
      order: ["due", "priority"], tiers: { due: "hidden", priority: "shown" },
    } } });

    expect(resolveChipOrder(custom, "editor").slice(0, 2)).toEqual(["due", "priority"]);
    expect(resolveChipOrder(custom, "editor")).toContain("when");
    expect(chipTierOf(custom, "editor", "due")).toBe("hidden");
  });

  it("uses the selected duration, then the estimate, then 30 minutes", () => {
    expect(defaultScheduleDuration({ start: "2026-09-08T14:00:00Z", duration: 45 }, 90)).toBe(45);
    expect(defaultScheduleDuration(null, 90)).toBe(90);
    expect(defaultScheduleDuration(null, null)).toBe(30);
  });
});

describe("priority presentation order", () => {
  it("keeps pickers highest-first but grouped Kanban columns lowest-first", () => {
    expect(PRIOS.map((priority) => priority.value)).toEqual(["highest", "high", "medium", "normal"]);
    expect(KANBAN_PRIOS.map((priority) => priority.value)).toEqual(["normal", "medium", "high", "highest"]);
  });
});
