import { describe, expect, it } from "vitest";
import { Priority, Task, TaskStatus } from "../src/types";
import { compareProjectPriority, ProjItem, priorityBucket, projectAreaName, projectsInArea, taskMatchesProjectCell, tasksInArea } from "../src/taskService";

const item = (name: string, type: "project" | "area", extra: Partial<ProjItem> = {}): ProjItem => ({
  id: name, name, path: `_opal_tasks/projects/${name}.md`, icon: type === "area" ? "circle-small" : "list-checks",
  color: null, type, hidden: false, archived: false, workflowStatus: "todo", completed: null, priority: "normal",
  description: "", ...extra,
});

const task = (id: string, project: string | null, status: TaskStatus = "todo", priority: Priority = "normal"): Task => ({
  id, path: `_opal_tasks/tasks/${id}.md`, title: id, titleInFm: true, status, priority,
  due: null, dueTime: null, scheduled: null, scheduledTime: null, duration: null, start: null,
  project, parent: null, labels: [], description: "", recurrence: null, recurBasis: "due", reminders: [],
  sortOrder: null, created: "", completed: null, cancelled: null, externalId: null,
});

describe("Area hierarchy", () => {
  it("normalizes wiki links and path-qualified Area links", () => {
    expect(projectAreaName("[[Work]]")).toBe("Work");
    expect(projectAreaName("[[Folder/Work|Job]]")).toBe("Work");
    expect(projectAreaName(null)).toBeNull();
  });

  it("returns only active projects assigned to the Area", () => {
    const area = item("Work area", "area", { path: "_opal_tasks/projects/Work.md" });
    const child = item("Launch", "project", { area: "[[Work]]" });
    const orphan = item("Home", "project", { area: "[[Missing]]" });
    const archived = item("Old", "project", { area: "[[Work]]", archived: true });
    expect(projectsInArea(area, [child, orphan, archived]).map((p) => p.name)).toEqual(["Launch"]);
  });

  it("uses the canonical Area ID when grouping projects", () => {
    const area = item("Personal", "area", { id: "PERSONAL-ID" });
    const child = item("Household", "project", { areaId: "PERSONAL-ID" });
    const other = item("Work", "project", { areaId: "WORK-ID" });
    expect(projectsInArea(area, [child, other]).map((p) => p.name)).toEqual(["Household"]);
  });

  it("sorts projects by priority, highest first, with names as the tie-breaker", () => {
    const projects = [
      item("Zulu", "project", { priority: "normal" }),
      item("Bravo", "project", { priority: "highest" }),
      item("Alpha", "project", { priority: "highest" }),
      item("Later", "project", { priority: "low" }),
    ];
    expect(projects.sort(compareProjectPriority).map((project) => project.name))
      .toEqual(["Alpha", "Bravo", "Zulu", "Later"]);
  });

  it("rolls direct Area tasks together with child-project tasks", () => {
    const area = item("Work", "area");
    const child = item("Launch", "project", { area: "[[Work]]" });
    const tasks = [task("direct", area.path), task("child", child.path), task("other", "_opal_tasks/projects/Home.md")];
    expect(tasksInArea(tasks, area, [child]).map((t) => t.id)).toEqual(["direct", "child"]);
  });

  it("nests only tasks in the same status and displayed priority cell", () => {
    const project = item("Launch", "project", { workflowStatus: "doing", priority: "normal" });
    expect(taskMatchesProjectCell(task("same", project.path, "doing", "low"), project)).toBe(true);
    expect(taskMatchesProjectCell(task("status-exception", project.path, "todo"), project)).toBe(false);
    expect(taskMatchesProjectCell(task("priority-exception", project.path, "doing", "high"), project)).toBe(false);
    expect(priorityBucket("lowest")).toBe("normal");
  });
});
