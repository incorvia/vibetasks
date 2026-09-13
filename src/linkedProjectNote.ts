import { isCollectionPath } from "./mdbaseResources";

export type ProjectEmbedSection = "header" | "tasks";

const OPAL_ENTITY_TYPES = new Set(["task", "project", "area", "filter", "template", "time_log", "timer_state"]);

export interface LinkedCollectionRef { id: string; path: string }
export type NoteProjectAction = { kind: "convert" } | { kind: "open"; path: string } | null;

export interface LinkedProjectIdentity { id: string; path: string | null }

/** A companion marker may coexist with the user's own `type` taxonomy. Only an `id` makes a
 *  marked file an Opal record (for example, a task assigned to this project) rather than the
 *  user-facing companion note. */
export function isLinkedCollectionNote(
  projectId: string,
  collectionPath: string,
  filePath: string,
  frontmatter: Record<string, unknown> | undefined,
): boolean {
  return filePath !== collectionPath
    && frontmatter?.opal_project_id === projectId
    && typeof frontmatter.id !== "string";
}

/** Cursor destination when a dashboard opens its companion note. Keep the caret in the writing
 *  space after frontmatter/title and above the generated task board at the footer. */
export function linkedNoteEntryLine(content: string): number {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let line = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((candidate, index) => index > 0 && candidate.trim() === "---");
    if (end >= 0) line = end + 1;
  }
  let firstContent = line;
  while (firstContent < lines.length && !lines[firstContent].trim()) firstContent++;
  if (/^#\s+/.test(lines[firstContent] ?? "")) line = firstContent + 1;
  return Math.min(line, Math.max(0, lines.length - 1));
}

/**
 * A note preview should describe the note, not expose its scaffolding. Return the first prose
 * paragraph or list item after ignoring frontmatter, headings, comments and fenced blocks (the
 * latter includes Opal Tasks' own header/task embeds). An empty result is intentional: callers can
 * still offer a dependable “Notes” affordance without showing a misleading `# Notes` excerpt.
 */
export function linkedNoteExcerpt(content: string, maxLength = 240): string | null {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end >= 0) start = end + 1;
  }

  const visible: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  for (const source of lines.slice(start)) {
    let line = source;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    while (line.includes("<!--")) {
      const begin = line.indexOf("<!--");
      const end = line.indexOf("-->", begin + 4);
      if (end >= 0) line = line.slice(0, begin) + line.slice(end + 3);
      else { line = line.slice(0, begin); inComment = true; break; }
    }

    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
      continue;
    }
    if (!fence) visible.push(line);
  }

  const plain = (value: string): string => value
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, "")
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
      (_match, target: string, alias: string | undefined) => alias ?? target.split("/").pop() ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const shorten = (value: string): string => {
    if (value.length <= maxLength) return value;
    const clipped = value.slice(0, Math.max(1, maxLength - 1));
    const boundary = clipped.lastIndexOf(" ");
    return `${clipped.slice(0, boundary > maxLength * 0.6 ? boundary : clipped.length).trimEnd()}…`;
  };

  for (let index = 0; index < visible.length; index++) {
    const raw = visible[index];
    const stripped = raw.replace(/^\s*>\s?/, "");
    if (!stripped.trim()) continue;
    if (/^\s{0,3}#{1,6}(?:\s+|$)/.test(stripped)) continue;
    // Setext heading: skip both its text and underline.
    if (/^\s*(?:=+|-+)\s*$/.test(visible[index + 1] ?? "")) { index++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(stripped)) continue;
    if (/^\s*!\[\[[^\]]+\]\]\s*$/.test(stripped)) continue;

    const listItem = /^\s*(?:[-+*]|\d+[.)])\s+/.test(stripped);
    if (listItem) {
      const excerpt = plain(stripped);
      if (excerpt) return shorten(excerpt);
      continue;
    }

    const paragraph = [stripped];
    for (let next = index + 1; next < visible.length; next++) {
      const candidate = visible[next].replace(/^\s*>\s?/, "");
      if (!candidate.trim() || /^\s{0,3}#{1,6}(?:\s+|$)/.test(candidate)
        || /^\s*(?:[-+*]|\d+[.)])\s+/.test(candidate)) break;
      paragraph.push(candidate);
    }
    const excerpt = plain(paragraph.join(" "));
    if (excerpt) return shorten(excerpt);
  }
  return null;
}

/** Reuse both valid and stale markers; only a note without a marker receives a fresh identity. */
export function linkedProjectIdentity(
  projectId: unknown,
  collections: readonly LinkedCollectionRef[],
  createId: () => string,
): LinkedProjectIdentity {
  const markedId = typeof projectId === "string" && projectId ? projectId : null;
  const existing = markedId ? collections.find((record) => record.id === markedId) : undefined;
  return { id: existing?.id ?? markedId ?? createId(), path: existing?.path ?? null };
}

/** Decide which project action belongs in a Markdown note's file menu. */
export function noteProjectAction(
  path: string,
  extension: string,
  type: unknown,
  projectId: unknown,
  collections: readonly LinkedCollectionRef[],
): NoteProjectAction {
  if (extension !== "md" || isCollectionPath(path) || OPAL_ENTITY_TYPES.has(String(type))) return null;
  if (typeof projectId === "string" && projectId) {
    const linked = collections.find((record) => record.id === projectId);
    if (linked) return { kind: "open", path: linked.path };
  }
  return { kind: "convert" };
}

/** A collision may change the internal filename, never the title the user chose in their note. */
export function projectTitleFromNote(frontmatterTitle: string | null, firstHeading: string | null, basename: string): string {
  return frontmatterTitle ?? (firstHeading?.trim() || basename);
}

/** The code block stays intentionally tiny: the stable record id survives either note being renamed. */
export function projectEmbedBlock(id: string, section: ProjectEmbedSection): string {
  return `\`\`\`opal_tasks\nview: project\nsection: ${section}\nid: ${id}\n\`\`\``;
}

function hasProjectSection(content: string, id: string, section: ProjectEmbedSection): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = content.match(/```opal_tasks\s*\n[\s\S]*?```/g) ?? [];
  return blocks.some((block) => {
    if (!new RegExp(`^id:\\s*${escaped}\\s*$`, "m").test(block)) return false;
    if (!/^view:\s*project\s*$/m.test(block)) return false;
    // Pre-section linked notes contained one project block at the footer. Keep treating that
    // legacy shape as the tasks section so running the command again never duplicates the list.
    const found = block.match(/^section:\s*(header|tasks)\s*$/m)?.[1];
    return found ? found === section : section === "tasks";
  });
}

/** Remove the generated top card introduced by older linked notes, including one surrounding blank
 *  line on each side. User-authored blocks and blocks for another project remain untouched. */
function withoutProjectHeader(content: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blocks = [...content.matchAll(/^[ \t]*```opal_tasks[ \t]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm)]
    .filter((match) => /^view:\s*project\s*$/m.test(match[0])
      && /^section:\s*header\s*$/m.test(match[0])
      && new RegExp(`^id:\\s*${escaped}\\s*$`, "m").test(match[0]));
  let next = content;
  for (const match of blocks.reverse()) {
    let start = match.index;
    let end = start + match[0].length;
    if (next.slice(0, start).endsWith("\n\n")) start--;
    if (next.slice(end).startsWith("\n\n")) end++;
    next = next.slice(0, start) + next.slice(end);
  }
  return next;
}

/** Keep the note's writing surface clear and its live task board at the footer. */
export function ensureLinkedProjectEmbeds(content: string, id: string): string {
  let next = withoutProjectHeader(content, id);
  if (!hasProjectSection(next, id, "tasks")) {
    const gap = next.length === 0 || next.endsWith("\n\n") ? "" : next.endsWith("\n") ? "\n" : "\n\n";
    next = `${next}${gap}${projectEmbedBlock(id, "tasks")}\n`;
  }
  return next;
}

/** Initial content for a companion note. Its filename is already rendered as the note title. */
export function newLinkedProjectNoteContent(id: string): string {
  return ensureLinkedProjectEmbeds(`---\nopal_project_id: ${id}\n---\n`, id);
}
