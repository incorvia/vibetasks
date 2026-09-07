import { describe, expect, it } from "vitest";
import { linkedProjectIdentity, noteProjectAction, projectTitleFromNote } from "../src/linkedProjectNote";

const collections = [
  { id: "project-1", path: "_opal_tasks/projects/Launch.md" },
  { id: "area-1", path: "_opal_tasks/projects/Work.md" },
];

describe("noteProjectAction", () => {
  it("offers conversion for a regular Markdown note", () => {
    expect(noteProjectAction("Inbox/Idea.md", "md", undefined, undefined, collections))
      .toEqual({ kind: "convert" });
  });

  it("does not offer conversion for non-Markdown files, collection files, or Opal entities", () => {
    expect(noteProjectAction("Inbox/Idea.pdf", "pdf", undefined, undefined, collections)).toBeNull();
    expect(noteProjectAction("_opal_tasks/notes/Idea.md", "md", undefined, undefined, collections)).toBeNull();
    for (const type of ["task", "project", "area", "filter", "template", "time_log", "timer_state"]) {
      expect(noteProjectAction("Inbox/Idea.md", "md", type, undefined, collections), type).toBeNull();
    }
  });

  it("opens the existing project or area for an already-linked companion note", () => {
    expect(noteProjectAction("Notes/Launch.md", "md", undefined, "project-1", collections))
      .toEqual({ kind: "open", path: "_opal_tasks/projects/Launch.md" });
    expect(noteProjectAction("Notes/Work.md", "md", undefined, "area-1", collections))
      .toEqual({ kind: "open", path: "_opal_tasks/projects/Work.md" });
  });

  it("offers repair when a stored project id no longer resolves", () => {
    expect(noteProjectAction("Notes/Launch.md", "md", undefined, "missing", collections))
      .toEqual({ kind: "convert" });
  });
});

describe("projectTitleFromNote", () => {
  it("prefers frontmatter title, then the first H1, then the filename", () => {
    expect(projectTitleFromNote("Frontmatter title", "Heading", "Filename")).toBe("Frontmatter title");
    expect(projectTitleFromNote(null, "  Heading  ", "Filename")).toBe("Heading");
    expect(projectTitleFromNote(null, "   ", "Filename")).toBe("Filename");
  });
});

describe("linkedProjectIdentity", () => {
  it("reuses valid and stale ids and creates an id only for a new link", () => {
    let created = 0;
    const createId = (): string => `new-${++created}`;

    expect(linkedProjectIdentity("project-1", collections, createId))
      .toEqual({ id: "project-1", path: "_opal_tasks/projects/Launch.md" });
    expect(linkedProjectIdentity("missing", collections, createId))
      .toEqual({ id: "missing", path: null });
    expect(created).toBe(0);
    expect(linkedProjectIdentity(undefined, collections, createId))
      .toEqual({ id: "new-1", path: null });
  });
});
