import type { Priority } from "./types";
import { projectAreaName, type ProjItem } from "./taskService";

/** Which piece of project metadata supplies its presentation color. */
export type ProjectColorMode = "area" | "priority" | "custom";

const PRIORITY_COLOR: Record<Priority, string> = {
  highest: "var(--bt-prio-1)",
  high: "var(--bt-prio-2)",
  medium: "var(--bt-prio-3)",
  normal: "var(--text-muted)",
  low: "var(--text-muted)",
  lowest: "var(--text-muted)",
};

/**
 * Resolve a project/area color once, then use that result in every presentation surface.
 * Areas always retain their own chosen color. In Area mode, an unassigned project stays neutral.
 */
export function projectDisplayColor(
  item: Pick<ProjItem, "type" | "color" | "priority" | "area" | "areaId">,
  areas: readonly Pick<ProjItem, "id" | "name" | "color">[],
  mode: ProjectColorMode,
): string | null {
  if (item.type === "area") return item.color;
  if (mode === "custom") return item.color;
  if (mode === "priority") return PRIORITY_COLOR[item.priority];

  const areaName = (projectAreaName(item.area) ?? "").toLowerCase();
  const area = areas.find((candidate) => item.areaId
    ? candidate.id === item.areaId
    : !!areaName && candidate.name.toLowerCase() === areaName);
  return area ? (area.color ?? "var(--bt-nav-area)") : null;
}
