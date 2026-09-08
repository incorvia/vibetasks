import { describe, expect, it } from "vitest";
import { ensureLinkedProjectEmbeds, linkedNoteEntryLine, linkedNoteExcerpt, newLinkedProjectNoteContent } from "../src/linkedProjectNote";

describe("ensureLinkedProjectEmbeds", () => {
  it("creates linked-note content without repeating the filename as an H1", () => {
    const out = newLinkedProjectNoteContent("p-1");
    expect(out).not.toMatch(/^#\s/m);
    expect(out).toContain("section: header");
    expect(out).toContain("section: tasks");
  });

  it("puts the project header after the note title and tasks at the footer", () => {
    const out = ensureLinkedProjectEmbeds("# Launch\n\n## Overview\nBrief\n", "p-1");
    expect(out.indexOf("section: header")).toBeGreaterThan(out.indexOf("# Launch"));
    expect(out.indexOf("section: header")).toBeLessThan(out.indexOf("## Overview"));
    expect(out.trimEnd().endsWith("section: tasks\nid: p-1\n```")).toBe(true);
  });

  it("places the header after YAML and H1", () => {
    const original = "---\ntags: [work]\n---\n# Launch\n\nText with [[links]] and `formatting`.";
    const out = ensureLinkedProjectEmbeds(original, "p-1");
    expect(out.indexOf("section: header")).toBeGreaterThan(out.indexOf("# Launch"));
    expect(out.indexOf("section: header")).toBeLessThan(out.indexOf("Text with"));
    expect(out).toContain("tags: [work]");
    expect(out).toContain("Text with [[links]] and `formatting`.");
  });

  it("is idempotent and recognizes a pre-section project block as the task list", () => {
    const old = "# Launch\n\nText\n\n```opal_tasks\nview: project\nid: p-1\n```\n";
    const once = ensureLinkedProjectEmbeds(old, "p-1");
    expect((once.match(/section: header/g) ?? [])).toHaveLength(1);
    expect((once.match(/section: tasks/g) ?? [])).toHaveLength(0);
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
  it("lands immediately below the generated header instead of inside its source", () => {
    const content = newLinkedProjectNoteContent("p-1");
    const line = linkedNoteEntryLine(content);
    expect(content.split("\n")[line]).toBe("");
    expect(content.split("\n")[line - 1]).toBe("```");
  });

  it("keeps the destination above existing prose", () => {
    const content = ensureLinkedProjectEmbeds("# Launch\n\nProject prose starts here.\n", "p-1");
    const lines = content.split("\n");
    const line = linkedNoteEntryLine(content);
    expect(lines[line]).toBe("");
    expect(lines.slice(line).join("\n")).toContain("Project prose starts here.");
  });
});
