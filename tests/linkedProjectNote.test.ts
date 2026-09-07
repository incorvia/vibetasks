import { describe, expect, it } from "vitest";
import { ensureLinkedProjectEmbeds, newLinkedProjectNoteContent } from "../src/linkedProjectNote";

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
