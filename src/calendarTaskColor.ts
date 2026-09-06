import type { Priority } from "./types";

export type CalendarTaskColorMode = "priority" | "calendar" | "task";

const PRIORITY_COLORS: Partial<Record<Priority, string>> = {
  highest: "#ef4444",
  high: "#f59e0b",
  medium: "#3b82f6",
};

// Deliberately mid-saturation: these remain legible as borders in both light and dark themes.
const TASK_COLORS = [
  "#ef4444", "#f97316", "#d97706", "#65a30d", "#059669", "#0d9488",
  "#0891b2", "#2563eb", "#4f46e5", "#7c3aed", "#a855f7", "#db2777",
] as const;

/** Stable rather than truly random: the same task keeps its color on every device and render. */
export function stableTaskColor(taskId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < taskId.length; i++) {
    hash ^= taskId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return TASK_COLORS[(hash >>> 0) % TASK_COLORS.length];
}

export function calendarTaskColor(mode: CalendarTaskColorMode, task: { id: string; priority: Priority }): string {
  if (mode === "task") return stableTaskColor(task.id);
  if (mode === "priority") return PRIORITY_COLORS[task.priority] ?? "var(--interactive-accent)";
  return "var(--interactive-accent)";
}
