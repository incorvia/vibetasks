import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection } from "@callumalpass/mdbase";
import { RECORD_TYPES, mdbaseConfigDocument, typeDocument } from "../src/mdbaseResources";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundled mdbase v0.3 resources", () => {
  it("open and validate with the pinned upstream implementation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibetask-mdbase-"));
    roots.push(root);
    await mkdir(join(root, "_types"));
    await writeFile(join(root, "mdbase.yaml"), mdbaseConfigDocument());
    for (const type of RECORD_TYPES) await writeFile(join(root, "_types", `${type}.md`), typeDocument(type));

    const opened = await Collection.open(root);
    expect(opened.error).toBeUndefined();
    expect(opened.collection).toBeDefined();
    const validation = await opened.collection!.v03Operations().validate({});
    expect(validation.valid, JSON.stringify(validation.diagnostics)).toBe(true);
    const created = await opened.collection!.v03Operations().create({
      type: "task",
      frontmatter: {
        type: "task", id: "01K4D9HQ2B32F6B8QKM4E9N6J5", title: "Pinned validator task",
        status: "todo", created: "2026-09-05T12:00:00Z", modified: "2026-09-05T12:00:00Z",
      },
    });
    expect(created.valid, JSON.stringify(created.diagnostics)).toBe(true);
    expect(created.result.path).toBe("tasks/Pinned validator task.md");
    const base = { created: "2026-09-05T12:00:00Z", modified: "2026-09-05T12:00:00Z" };
    const records = [
      { type: "area", path: "projects/Work.md", frontmatter: { ...base, type: "area", id: "01K4D9HQ2B32F6B8QKM4E9N6J6", title: "Work", status: "active", linked_note: "[[Notes/Work overview]]" } },
      { type: "project", path: "projects/Launch.md", frontmatter: { ...base, type: "project", id: "01K4D9HQ2B32F6B8QKM4E9N6J7", title: "Launch", status: "active", area: "[[Work]]", linked_note: "[[Notes/Launch brief]]" } },
      { type: "task", path: "tasks/Area task.md", frontmatter: { ...base, type: "task", id: "01K4D9HQ2B32F6B8QKM4E9N6J8", title: "Area task", status: "todo", project: "[[Work]]" } },
      { type: "task", path: "tasks/Project task.md", frontmatter: { ...base, type: "task", id: "01K4D9HQ2B32F6B8QKM4E9N6J9", title: "Project task", status: "todo", project: "[[Launch]]", parent: "[[Area task]]" } },
      { type: "filter", path: "filters/Open.md", frontmatter: { ...base, type: "filter", id: "01K4D9HQ2B32F6B8QKM4E9N6JA", title: "Open", statuses: ["todo"] } },
      { type: "template", path: "templates/Routine/Routine.md", frontmatter: { ...base, type: "template", id: "01K4D9HQ2B32F6B8QKM4E9N6JB", title: "Routine", status: "todo", template_of: "task" } },
    ];
    for (const record of records) {
      const result = await opened.collection!.v03Operations().create(record);
      expect(result.valid, JSON.stringify(result.diagnostics)).toBe(true);
    }
    const withRecord = await opened.collection!.v03Operations().validate({});
    expect(withRecord.valid, JSON.stringify(withRecord.diagnostics)).toBe(true);
    await opened.collection!.close();
  });
});
