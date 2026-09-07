import { setIcon } from "obsidian";
import { projectDisplayName, t } from "./i18n";

export type EntityKind = "area" | "project" | "task";

/** One icon vocabulary for navigation, embeds, pickers, creation, and entity headers. */
export const ENTITY_ICON: Record<EntityKind, string> = {
  area: "layers",
  project: "list-checks",
  task: "circle",
};

/** Projects may have a chosen icon; Areas and Tasks keep stable type silhouettes. */
export function entityIcon(kind: EntityKind, configured?: unknown): string {
  if (kind === "project" && typeof configured === "string" && configured && configured !== "folder") return configured;
  return ENTITY_ICON[kind];
}

export interface ProjectIdentity {
  type: "project" | "area";
  name: string;
  icon: string;
  color?: string | null;
}

/** Shared identity used wherever a linked note points back into the Opal Tasks representation. */
export function renderProjectIdentity(
  parent: HTMLElement,
  project: ProjectIdentity,
  onOpen: () => void,
): HTMLElement {
  const kind = t(project.type === "area" ? "kind_area" : "kind_project");
  const icon = parent.createSpan({
    cls: "bt-project-note-icon",
    attr: { role: "img", "aria-label": kind, title: kind },
  });
  setIcon(icon, entityIcon(project.type, project.icon));
  if (project.color) icon.style.color = project.color;

  const identity = parent.createDiv({ cls: "bt-project-note-identity" });
  const title = identity.createSpan({
    cls: "bt-project-note-title",
    text: projectDisplayName(project.name),
    attr: { role: "button", tabindex: "0", "aria-label": t("ribbon_open"), title: t("ribbon_open") },
  });
  title.onclick = onOpen;
  title.onkeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  return identity;
}
