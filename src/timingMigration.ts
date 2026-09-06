/** Pure timing migration helpers, kept outside the plugin so every precedence edge is testable. */
export interface LegacyTiming {
  due?: unknown; scheduled?: unknown; start?: unknown; duration?: unknown; estimate?: unknown;
  gcal_event_id?: unknown; gcal_calendar_id?: unknown;
}

const scalar = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return null;
};
const deadlineMs = (raw: string): number => {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999` : raw;
  const ms = new Date(iso).getTime(); return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/** Earliest legacy date wins; exact ties deliberately retain the old `due`. */
export function migratedDeadline(due: unknown, scheduled: unknown): string | null {
  const a = scalar(due), b = scalar(scheduled);
  if (!a) return b; if (!b) return a;
  return deadlineMs(a) <= deadlineMs(b) ? a : b;
}

export function migrateTimingFields(fm: Record<string, unknown>): { changed: boolean; before: LegacyTiming } {
  const timingKeys = ["due", "scheduled", "start", "duration", "estimate", "gcal_event_id", "gcal_calendar_id"] as const;
  const signature = (): string => JSON.stringify(timingKeys.map((key) => [key in fm, fm[key]]));
  const beforeSignature = signature();
  const before: LegacyTiming = {};
  for (const key of timingKeys) {
    if (key in fm) before[key] = fm[key];
  }
  const deadline = migratedDeadline(fm.due, fm.scheduled);
  const legacyEstimate = typeof fm.duration === "number" && Number.isFinite(fm.duration) && fm.duration > 0 ? Math.round(fm.duration) : null;
  const currentEstimate = typeof fm.estimate === "number" && Number.isFinite(fm.estimate) && fm.estimate > 0 ? Math.round(fm.estimate) : null;
  if (deadline) fm.due = deadline; else delete fm.due;
  if (currentEstimate ?? legacyEstimate) fm.estimate = currentEstimate ?? legacyEstimate!; else delete fm.estimate;
  delete fm.scheduled; delete fm.start; delete fm.duration;
  delete fm.gcal_event_id; delete fm.gcal_calendar_id;
  return { changed: beforeSignature !== signature(), before };
}
