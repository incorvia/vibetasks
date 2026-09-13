import { describe, expect, it } from "vitest";
import { ensureLinkedProjectEmbeds, isLinkedCollectionNote, linkedNoteEntryLine, linkedNoteExcerpt, newLinkedProjectNoteContent } from "../src/linkedProjectNote";

describe("isLinkedCollectionNote", () => {
  const projectId = "project-1";
  const recordPath = "_opal_tasks/projects/Launch.md";

  it("accepts a marked companion note even when the user's taxonomy says type: project", () => {
    expect(isLinkedCollectionNote(projectId, recordPath, "Notes/Launch.md", {
      type: "project",
      opal_project_id: projectId,
    })).toBe(true);
  });

  it("rejects Opal records assigned to the project", () => {
    expect(isLinkedCollectionNote(projectId, recordPath, "Tasks/Plan launch.md", {
      type: "task",
      id: "task-1",
      opal_project_id: projectId,
    })).toBe(false);
  });

  it("rejects the collection record itself and unrelated markers", () => {
    expect(isLinkedCollectionNote(projectId, recordPath, recordPath, {
      opal_project_id: projectId,
    })).toBe(false);
    expect(isLinkedCollectionNote(projectId, recordPath, "Notes/Other.md", {
      opal_project_id: "project-2",
    })).toBe(false);
  });
});

describe("ensureLinkedProjectEmbeds", () => {
  it("creates linked-note content without repeating the filename as an H1", () => {
    const out = newLinkedProjectNoteContent("p-1");
    expect(out).not.toMatch(/^#\s/m);
    expect(out).not.toContain("section: header");
    expect(out).toContain("section: tasks");
  });

  it("keeps the writing surface clear and puts tasks at the footer", () => {
    const out = ensureLinkedProjectEmbeds("# Launch\n\n## Overview\nBrief\n", "p-1");
    expect(out).not.toContain("section: header");
    expect(out).toContain("## Overview\nBrief");
    expect(out.trimEnd().endsWith("section: tasks\nid: p-1\n```")).toBe(true);
  });

  it("preserves YAML, title, and prose without inserting a header", () => {
    const original = "---\ntags: [work]\n---\n# Launch\n\nText with [[links]] and `formatting`.";
    const out = ensureLinkedProjectEmbeds(original, "p-1");
    expect(out).not.toContain("section: header");
    expect(out).toContain("tags: [work]");
    expect(out).toContain("Text with [[links]] and `formatting`.");
  });

  it("removes a legacy header and recognizes a pre-section project block as the task list", () => {
    const old = "# Launch\n\n```opal_tasks\nview: project\nsection: header\nid: p-1\n```\n\nText\n\n```opal_tasks\nview: project\nid: p-1\n```\n";
    const once = ensureLinkedProjectEmbeds(old, "p-1");
    expect((once.match(/section: header/g) ?? [])).toHaveLength(0);
    expect((once.match(/section: tasks/g) ?? [])).toHaveLength(0);
    expect(once).toContain("# Launch\n\nText");
    expect(ensureLinkedProjectEmbeds(once, "p-1")).toBe(once);
  });
});

describe("linkedNoteExcerpt", () => {
  it("skips note scaffolding and returns the first prose paragraph", () => {
    const content = `---\nopal_project_id: p-1\n---\n# Launch\n\n\`\`\`opal_tasks\nview: project\nsection: header\nid: p-1\n\`\`\`\n\n## Notes\n\nThe launch brief starts here.\nIt continues on the next line.\n`;
    expect(linkedNoteExcerpt(content)).toBe("The launch brief starts here. It continues on the next line.");
  });

  it("uses a list item but never a heading as the preview", () => {
    expect(linkedNoteExcerpt("# Notes\n\n- Confirm scope\n- Invite the team\n"))
      .toBe("Confirm scope");
  });

  it("turns common Markdown links into readable text", () => {
    expect(linkedNoteExcerpt("## Context\n\nReview [[Plans/Launch|the launch plan]] with [Avni](people/avni.md)."))
      .toBe("Review the launch plan with Avni.");
  });

  it("returns no excerpt when the note contains only generated structure", () => {
    expect(linkedNoteExcerpt("# Notes\n\n\`\`\`opal_tasks\nview: project\nsection: tasks\nid: p-1\n\`\`\`\n"))
      .toBeNull();
  });
});

describe("linkedNoteEntryLine", () => {
  it("lands in the writing space between frontmatter and the footer embed", () => {
    const content = newLinkedProjectNoteContent("p-1");
    const line = linkedNoteEntryLine(content);
    expect(content.split("\n")[line]).toBe("");
    expect(content.split("\n")[line - 1]).toBe("---");
    expect(content.split("\n")[line + 1]).toBe("```opal_tasks");
  });

  it("keeps the destination below an existing title and above prose", () => {
    const content = ensureLinkedProjectEmbeds("# Launch\n\nProject prose starts here.\n", "p-1");
    const lines = content.split("\n");
    const line = linkedNoteEntryLine(content);
    expect(lines[line]).toBe("");
    expect(lines[line - 1]).toBe("# Launch");
    expect(lines.slice(line).join("\n")).toContain("Project prose starts here.");
  });
});
