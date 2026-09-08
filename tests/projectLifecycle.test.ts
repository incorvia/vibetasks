import { describe, expect, it } from "vitest";
import {
  PROJECT_COMPLETION_GRACE_MS,
  isRecentlyCompletedProject,
  shouldAutoArchiveProject,
} from "../src/taskService";

const completedProject = (completed: string | null, workflowStatus = "done") => ({
  type: "project" as const,
  workflowStatus,
  completed,
  archived: false,
});

describe("completed project sidebar lifecycle", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");

  it("keeps a newly completed project in the recent group", () => {
    const project = completedProject(new Date(now - PROJECT_COMPLETION_GRACE_MS + 1).toISOString());
    expect(isRecentlyCompletedProject(project, now)).toBe(true);
    expect(shouldAutoArchiveProject(project, now)).toBe(false);
  });

  it("expires and archives at three days", () => {
    const project = completedProject(new Date(now - PROJECT_COMPLETION_GRACE_MS).toISOString());
    expect(isRecentlyCompletedProject(project, now)).toBe(false);
    expect(shouldAutoArchiveProject(project, now)).toBe(true);
  });

  it("treats a legacy or malformed missing stamp as recent until it is backfilled", () => {
    expect(isRecentlyCompletedProject(completedProject(null), now)).toBe(true);
    expect(shouldAutoArchiveProject(completedProject(null), now)).toBe(false);
    expect(isRecentlyCompletedProject(completedProject("not-a-date"), now)).toBe(true);
  });

  it("never applies the completion lifecycle to open projects, areas, or archived records", () => {
    const old = new Date(now - PROJECT_COMPLETION_GRACE_MS * 2).toISOString();
    expect(isRecentlyCompletedProject(completedProject(old, "todo"), now)).toBe(false);
    expect(shouldAutoArchiveProject({ ...completedProject(old), type: "area" }, now)).toBe(false);
    expect(shouldAutoArchiveProject({ ...completedProject(old), archived: true }, now)).toBe(false);
  });
});
