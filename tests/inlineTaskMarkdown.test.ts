import { describe, expect, it } from "vitest";
import { excludedInlineLines, inlineLineReplacement, inlineLinkRanges, inlineReconcileDisposition, parseInlineTaskLine, selectionTouchesInlineRange } from "../src/inlineTaskMarkdown";

describe("parseInlineTaskLine", () => {
  it.each([
    ["- [ ] Report tomorrow", "- ", "Report tomorrow", false],
    ["- [x] Shipped", "- ", "Shipped", true],
    ["  * Nested", "  * ", "Nested", false],
    ["> 1. Report", "> 1. ", "Report", false],
    ["> > - [X] Deep", "> > - ", "Deep", true],
    ["## Heading task", "## ", "Heading task", false],
    ["Ordinary prose", "", "Ordinary prose", false],
  ])("parses %s", (line, prefix, title, completed) => {
    expect(parseInlineTaskLine(line)).toEqual({ prefix, title, completed });
  });

  it.each(["", "   ", "---", "- [ ]   ", "[[Task]]", "- [[Task|Alias]]", "[Alias](Task.md)"])
    ("rejects %j", (line) => expect(parseInlineTaskLine(line)).toBeNull());
});

describe("excludedInlineLines", () => {
  it("excludes frontmatter and fenced blocks, including generated opal_tasks blocks", () => {
    const content = [
      "---", "title: Note", "---", "Convertible", "```js", "not convertible", "```",
      "After", "```opal_tasks", "view: project", "```", "End",
    ].join("\n");
    expect([...excludedInlineLines(content)]).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
  });
});

describe("inlineLineReplacement", () => {
  it("preserves the prefix only when the source line is unchanged", () => {
    expect(inlineLineReplacement("> - [ ] Report", "> - [ ] Report", "[[Task|Report]]"))
      .toBe("> - [[Task|Report]]");
    expect(inlineLineReplacement("Report", "Report edited", "[[Task|Report]]")).toBeNull();
  });
});

describe("inlineReconcileDisposition", () => {
  const links = new Set(["Tasks/Origin.md", "Tasks/Manual.md"]);
  const base = { path: "Tasks/Origin.md", sourceNoteId: "note-1", projectId: "old-project" };
  it("moves originating linked tasks even from another project", () => {
    expect(inlineReconcileDisposition(base, links, "note-1", "new-project", false)).toBe("move");
  });
  it("is idempotent and leaves trash classified separately", () => {
    expect(inlineReconcileDisposition({ ...base, projectId: "new-project" }, links, "note-1", "new-project", false)).toBe("unchanged");
    expect(inlineReconcileDisposition(base, links, "note-1", "new-project", true)).toBe("trashed");
  });
  it("ignores removed, manually linked, and copied-note cases", () => {
    expect(inlineReconcileDisposition({ ...base, path: "Tasks/Removed.md" }, links, "note-1", "new-project", false)).toBe("ignore");
    expect(inlineReconcileDisposition({ path: "Tasks/Manual.md", sourceNoteId: null }, links, "note-1", "new-project", false)).toBe("ignore");
    expect(inlineReconcileDisposition(base, links, "copied-note-id", "new-project", false)).toBe("ignore");
  });
});

describe("inlineLinkRanges", () => {
  it("finds wiki and Markdown links with aliases and decoded relative paths", () => {
    const ranges = inlineLinkRanges("See [[Tasks/One|First]] and [Second](../Tasks/Task%20Two.md).", 10);
    expect(ranges).toMatchObject([
      { from: 14, target: "Tasks/One", alias: "First" },
      { target: "../Tasks/Task Two.md", alias: "Second" },
    ]);
  });

  it("does not treat an image as an inline link", () => {
    expect(inlineLinkRanges("![x](image.png)")).toEqual([]);
    expect(inlineLinkRanges("![[image.png]]")).toEqual([]);
  });
});

describe("selectionTouchesInlineRange", () => {
  it("reveals a link only while the cursor is inside its half-open range", () => {
    expect(selectionTouchesInlineRange([{ from: 12, to: 12 }], 10, 20)).toBe(true);
    expect(selectionTouchesInlineRange([{ from: 10, to: 10 }], 10, 20)).toBe(true);
    expect(selectionTouchesInlineRange([{ from: 20, to: 20 }], 10, 20)).toBe(false);
    expect(selectionTouchesInlineRange([{ from: 9, to: 9 }], 10, 20)).toBe(false);
  });

  it("uses half-open overlap semantics for non-empty selections", () => {
    expect(selectionTouchesInlineRange([{ from: 5, to: 10 }], 10, 20)).toBe(false);
    expect(selectionTouchesInlineRange([{ from: 5, to: 11 }], 10, 20)).toBe(true);
    expect(selectionTouchesInlineRange([{ from: 19, to: 25 }], 10, 20)).toBe(true);
    expect(selectionTouchesInlineRange([{ from: 20, to: 25 }], 10, 20)).toBe(false);
  });
});
