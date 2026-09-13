import { describe, expect, it } from "vitest";
import { projectDisplayColor } from "../src/projectColor";
import type { ProjItem } from "../src/taskService";

const item = (values: Partial<ProjItem>): ProjItem => ({
  id: "project-1", name: "Project", path: "projects/Project.md", icon: "list-checks",
  color: "#123456", type: "project", hidden: false, archived: false,
  workflowStatus: "todo", completed: null, priority: "high", description: "",
  ...values,
});

const areas = [item({ id: "area-1", name: "Home", type: "area", color: "#abcdef", priority: "normal" })];

describe("projectDisplayColor", () => {
  it("uses the project's own color in custom mode", () => {
    expect(projectDisplayColor(item({}), areas, "custom")).toBe("#123456");
  });

  it("uses the owning area's color, preferring its stable id", () => {
    expect(projectDisplayColor(item({ areaId: "area-1", area: "Wrong name" }), areas, "area")).toBe("#abcdef");
  });

  it("does not fall back to a legacy name when a stable area id is present", () => {
    expect(projectDisplayColor(item({ areaId: "missing-area", area: "Home" }), areas, "area")).toBeNull();
  });

  it("uses the owning area's default tint when it has no custom color", () => {
    expect(projectDisplayColor(item({ area: "[[Home]]" }), [item({ ...areas[0], color: null })], "area"))
      .toBe("var(--bt-nav-area)");
  });

  it("leaves unassigned projects neutral in area mode", () => {
    expect(projectDisplayColor(item({ area: null, areaId: null }), areas, "area")).toBeNull();
  });

  it("maps project priority to the shared priority palette", () => {
    expect(projectDisplayColor(item({ priority: "highest" }), areas, "priority")).toBe("var(--bt-prio-1)");
    expect(projectDisplayColor(item({ priority: "normal" }), areas, "priority")).toBe("var(--text-muted)");
  });

  it("does not recolor area records", () => {
    expect(projectDisplayColor(areas[0], areas, "priority")).toBe("#abcdef");
  });
});
