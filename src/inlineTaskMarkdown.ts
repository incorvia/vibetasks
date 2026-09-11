/** Pure Markdown helpers for inline task conversion and task-link overlays. */
const WIKI_LINK = /(?<!!)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g;
const ONLY_INTERNAL_LINK = /^(?:\[\[[^\]]+\]\]|\[[^\]]*\]\((?:<[^>]+>|[^)]+)\))$/;

export interface InlineLine {
  prefix: string;
  title: string;
  completed: boolean;
}

export interface LinkRange {
  from: number;
  to: number;
  target: string;
  alias: string | null;
}

/** Parse the TaskNotes-compatible single-line forms while retaining the Markdown container. */
export function parseInlineTaskLine(line: string): InlineLine | null {
  if (!line.trim() || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) return null;
  let rest = line;
  let prefix = "";
  const indent = rest.match(/^\s*/)?.[0] ?? "";
  prefix += indent;
  rest = rest.slice(indent.length);

  while (rest.startsWith(">")) {
    const marker = rest.match(/^>\s*/)?.[0] ?? ">";
    prefix += marker;
    rest = rest.slice(marker.length);
  }

  const heading = rest.match(/^#{1,6}\s+/);
  if (heading) {
    prefix += heading[0];
    rest = rest.slice(heading[0].length);
  } else {
    const list = rest.match(/^(?:[-+*]|\d+[.)])\s+/);
    if (list) {
      prefix += list[0];
      rest = rest.slice(list[0].length);
    }
  }

  const checkbox = rest.match(/^\[([ xX])\]\s+/);
  const completed = checkbox?.[1].toLowerCase() === "x";
  if (checkbox) rest = rest.slice(checkbox[0].length);

  const title = rest.trim();
  if (!title || ONLY_INTERNAL_LINK.test(title)) return null;
  return { prefix, title, completed };
}

/** Transaction guard shared by editor adapters: stale text never receives a task link. */
export function inlineLineReplacement(original: string, current: string, link: string): string | null {
  if (current !== original) return null;
  const parsed = parseInlineTaskLine(original);
  return parsed ? parsed.prefix + link : null;
}

export type InlineReconcileDisposition = "ignore" | "move" | "unchanged" | "trashed";

/** Pure ownership gate: both provenance and a still-present link are required. */
export function inlineReconcileDisposition(task: {
  path: string; sourceNoteId?: string | null; projectId?: string | null;
}, linkedPaths: ReadonlySet<string>, noteId: string, projectId: string, trashed: boolean): InlineReconcileDisposition {
  if (task.sourceNoteId !== noteId || !linkedPaths.has(task.path)) return "ignore";
  if (trashed) return "trashed";
  return task.projectId === projectId ? "unchanged" : "move";
}

/** Lines excluded from commands/buttons: frontmatter and every fenced code block. */
export function excludedInlineLines(content: string): Set<number> {
  const lines = content.split("\n");
  const excluded = new Set<number>();
  let frontmatter = lines[0]?.trim() === "---";
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart().replace(/^(?:>\s*)+/, "");
    if (frontmatter) {
      excluded.add(i);
      if (i > 0 && trimmed.trim() === "---") frontmatter = false;
      continue;
    }
    const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1] ?? null;
    if (fence) {
      excluded.add(i);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) { fence = marker; excluded.add(i); }
  }
  return excluded;
}

export function inlineLinkRanges(text: string, offset = 0): LinkRange[] {
  const ranges: LinkRange[] = [];
  WIKI_LINK.lastIndex = 0;
  for (const match of text.matchAll(WIKI_LINK)) {
    ranges.push({ from: offset + match.index, to: offset + match.index + match[0].length,
      target: match[1].trim(), alias: match[2]?.trim() || null });
  }
  MARKDOWN_LINK.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    ranges.push({ from: offset + match.index, to: offset + match.index + match[0].length,
      target: decodeLinkTarget(match[2] ?? match[3]), alias: match[1]?.trim() || null });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** Whether an editor selection/cursor intersects a replaceable half-open link range. */
export function selectionTouchesInlineRange(selections: readonly { from: number; to: number }[], from: number, to: number): boolean {
  return selections.some((range) => range.from === range.to
    ? range.from >= from && range.from < to
    : range.from < to && range.to > from);
}

function decodeLinkTarget(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
