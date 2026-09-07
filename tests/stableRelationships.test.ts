import { describe, expect, it } from "vitest";
import { planStableRelationships, relationshipBackup, RelationshipRecord } from "../src/stableRelationships";
import { upgradedRelationshipTypeDocument } from "../src/mdbaseRepository";

const record = (path: string, type: string, id: string, title: string,
  frontmatter: Record<string, unknown> = {}): RelationshipRecord => ({
  path, type, id, title, frontmatter: { type, id, title, ...frontmatter },
});

describe("stable relationship migration", () => {
  it("migrates task, template, parent, and project-area links to unchanged IDs", () => {
    const records = [
      record("_opal_tasks/Areas/Home.md", "area", "01AREA", "Home"),
      record("_opal_tasks/Projects/Garden.md", "project", "01PROJECT", "Garden", { area: "[[Home]]" }),
      record("_opal_tasks/Items/Parent.md", "task", "01PARENT", "Parent", { project: "[[Garden]]" }),
      record("_opal_tasks/Items/Child.md", "task", "01CHILD", "Child", { project: "[[Garden]]", parent: "[[Parent]]" }),
      record("_opal_tasks/Templates/T/Root.md", "template", "01TROOT", "Root"),
      record("_opal_tasks/Templates/T/Kid.md", "template", "01TKID", "Kid", { parent: "[[Root]]", project: "[[Garden]]" }),
    ];
    const plan = planStableRelationships(records);
    expect(plan.changes.get(records[1].path)).toMatchObject({ opal_area_id: "01AREA" });
    expect(plan.changes.get(records[3].path)).toMatchObject({ opal_project_id: "01PROJECT", opal_parent_id: "01PARENT" });
    expect(plan.changes.get(records[5].path)).toMatchObject({ opal_project_id: "01PROJECT", opal_parent_id: "01TROOT" });
    expect(plan.changes.get(records[3].path)).not.toHaveProperty("project");
    expect(plan.changes.get(records[3].path)).not.toHaveProperty("parent");
  });

  it("never guesses between duplicate titles and preserves the legacy value", () => {
    const task = record("_opal_tasks/Items/T.md", "task", "T", "Task", { project: "Same" });
    const plan = planStableRelationships([
      record("_opal_tasks/Projects/A.md", "project", "A", "Same"),
      record("_opal_tasks/Projects/B.md", "project", "B", "Same"), task,
    ]);
    expect(plan.changes.has(task.path)).toBe(false);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ path: task.path, field: "project", reason: "ambiguous", candidates: expect.arrayContaining([
      "_opal_tasks/Projects/A.md", "_opal_tasks/Projects/B.md",
    ]) })]);
  });

  it("records unresolved values without dropping them", () => {
    const task = record("_opal_tasks/Items/T.md", "task", "T", "Task", { parent: "[[Missing]]" });
    const plan = planStableRelationships([task]);
    expect(plan.changes.has(task.path)).toBe(false);
    expect(plan.diagnostics[0]).toMatchObject({ field: "parent", value: "[[Missing]]", reason: "unresolved" });
  });

  it("splits Inbox flags from resolved filter IDs and retains unresolved diagnostics", () => {
    const filter = record("_opal_tasks/Filters/F.md", "filter", "F", "F", {
      projects: ["Inbox", "Garden", "Missing"], projects_not: ["Eingang"],
    });
    const plan = planStableRelationships([
      record("_opal_tasks/Projects/Garden.md", "project", "P", "Garden"), filter,
    ]);
    expect(plan.changes.get(filter.path)).toMatchObject({
      opal_project_ids: ["P"], opal_include_inbox: true, opal_exclude_inbox: true, projects: ["Missing"],
    });
  });

  it("moves a unique companion marker to the note and is idempotent", () => {
    const project = record("_opal_tasks/Projects/P.md", "project", "P", "Project", { linked_note: "[[Notes/Project]]" });
    const note = record("Notes/Project.md", "note", "", "Project");
    const first = planStableRelationships([project, note]);
    expect(first.changes.get(project.path)).not.toHaveProperty("linked_note");
    expect(first.changes.get(note.path)).toMatchObject({ opal_project_id: "P" });
    const migrated = [
      { ...project, frontmatter: first.changes.get(project.path)! },
      { ...note, frontmatter: first.changes.get(note.path)! },
    ];
    expect(planStableRelationships(migrated).changes.size).toBe(0);
  });

  it("does not rewrite canonical relationships when titles change", () => {
    const task = record("_opal_tasks/Items/T.md", "task", "T", "Task", { opal_project_id: "P", opal_parent_id: "ROOT" });
    const plan = planStableRelationships([
      record("_opal_tasks/Projects/P.md", "project", "P", "Renamed project"),
      record("_opal_tasks/Items/Root.md", "task", "ROOT", "Renamed parent"), task,
    ]);
    expect(plan.changes.size).toBe(0);
  });

  it("assigns a missing collection ID before migrating links to that record", () => {
    const project = record("_opal_tasks/Projects/Personal.md", "project", "", "Personal");
    const task = record("_opal_tasks/Items/Trash.md", "task", "TASK", "Take out the trash", { project: "[[Personal]]" });
    const plan = planStableRelationships([project, task], () => "GENERATED-PERSONAL-ID");
    expect(plan.changes.get(project.path)).toMatchObject({ id: "GENERATED-PERSONAL-ID" });
    expect(plan.changes.get(task.path)).toMatchObject({ opal_project_id: "GENERATED-PERSONAL-ID" });
    expect(plan.changes.get(task.path)).not.toHaveProperty("project");
  });

  it("normalizes a path accidentally stored as a canonical project ID", () => {
    const project = record("_opal_tasks/Projects/Personal.md", "project", "PERSONAL-ID", "Personal");
    const task = record("_opal_tasks/Items/Trash.md", "task", "TASK", "Take out the trash", {
      opal_project_id: "_opal_tasks/Projects/Personal.md",
    });
    const plan = planStableRelationships([project, task]);
    expect(plan.changes.get(task.path)).toMatchObject({ opal_project_id: "PERSONAL-ID" });
  });

  it("repairs the exact missing-ID plus path-as-ID migration failure in one pass", () => {
    const project = record("_opal_tasks/Projects/Personal.md", "area", "", "Personal");
    const task = record("_opal_tasks/Items/Trash.md", "task", "TASK", "Take out the trash", {
      opal_project_id: "_opal_tasks/Projects/Personal.md",
    });
    const plan = planStableRelationships([project, task], () => "GENERATED-PERSONAL-ID");
    expect(plan.changes.get(project.path)).toMatchObject({ id: "GENERATED-PERSONAL-ID" });
    expect(plan.changes.get(task.path)).toMatchObject({ opal_project_id: "GENERATED-PERSONAL-ID" });
    expect(plan.diagnostics).toEqual([]);
  });

  it("uses a valid legacy link to repair an invalid canonical ID", () => {
    const project = record("_opal_tasks/Projects/Personal.md", "project", "PERSONAL-ID", "Personal");
    const task = record("_opal_tasks/Items/Trash.md", "task", "TASK", "Take out the trash", {
      opal_project_id: "BROKEN-ID", project: "[[Personal]]",
    });
    const plan = planStableRelationships([project, task]);
    expect(plan.changes.get(task.path)).toMatchObject({ opal_project_id: "PERSONAL-ID" });
    expect(plan.changes.get(task.path)).not.toHaveProperty("project");
  });

  it("preserves an unresolvable canonical ID and reports it", () => {
    const task = record("_opal_tasks/Items/Trash.md", "task", "TASK", "Take out the trash", { opal_project_id: "BROKEN-ID" });
    const plan = planStableRelationships([task]);
    expect(plan.changes.size).toBe(0);
    expect(plan.diagnostics).toEqual([expect.objectContaining({
      path: task.path, field: "opal_project_id", value: "BROKEN-ID", reason: "unresolved",
    })]);
  });

  it("backs up exact original contents, including whitespace and line endings", () => {
    const content = "---\r\ntype: task\r\nproject: '[[P]]'\r\n---\r\nBody  \r\n";
    const raw = relationshipBackup([{ path: "_opal_tasks/tasks/T.md", content }], [], "2026-09-07T12:00:00.000Z");
    expect(JSON.parse(raw).files[0].content).toBe(content);
  });

  it("upgrades type relationships idempotently without dropping custom schema or paths", () => {
    const source = `---
kind: "mdbase.type"
name: "task"
version: 1
schema: {"dialect":"json-schema-2020-12","value":{"properties":{"project":{"type":"string"},"custom_field":{"type":"number"}}}}
collection: {"path":{"pattern":"custom/tasks/{id}.md"},"links":{"project":{"format":"wikilink"}}}
x-opal_tasks: {"statuses":[{"id":"waiting","kind":"open"}]}
---
body
`;
    const first = upgradedRelationshipTypeDocument(source, "task");
    expect(first).toContain("custom_field");
    expect(first).toContain("custom/tasks/{id}.md");
    expect(first).toContain("waiting");
    expect(first).toContain("opal_project_id");
    expect(first).not.toContain('"properties":{"project"');
    expect(upgradedRelationshipTypeDocument(first, "task")).toBe(first);
  });
});
