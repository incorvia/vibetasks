export type ProjectEmbedSection = "header" | "tasks";

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

/** Put the project identity immediately after frontmatter/title and keep its task list at the end. */
export function ensureLinkedProjectEmbeds(content: string, id: string): string {
  let next = content;
  if (!hasProjectSection(next, id, "header")) {
    const header = projectEmbedBlock(id, "header");
    const lines = next.split("\n");
    let at = 0;
    if (lines[0]?.trim() === "---") {
      const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
      if (end >= 0) at = end + 1;
    }
    while (at < lines.length && lines[at].trim() === "") at++;
    if (/^#\s+/.test(lines[at] ?? "")) at++;
    lines.splice(at, 0, "", header, "");
    next = lines.join("\n").replace(/^\n+/, content.startsWith("\n") ? "\n" : "");
  }
  if (!hasProjectSection(next, id, "tasks")) {
    const gap = next.length === 0 || next.endsWith("\n\n") ? "" : next.endsWith("\n") ? "\n" : "\n\n";
    next = `${next}${gap}${projectEmbedBlock(id, "tasks")}\n`;
  }
  return next;
}

/** Initial content for a companion note. Its filename is already rendered as the note title. */
export function newLinkedProjectNoteContent(id: string): string {
  return ensureLinkedProjectEmbeds("", id);
}
