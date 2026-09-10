import { localDateTime } from "./format";
import { isAllDaySchedule, type TimeBlock, type WorkSession } from "./types";

export const sessionDay = (session: WorkSession): string => localDateTime(session.started_at).slice(0, 10);
export function sessionSeconds(session: WorkSession, now = Date.now()): number {
  const seconds = session.ended_at
    ? session.elapsed ?? (Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000
    : (now - Date.parse(session.started_at)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/** Attribute a whole entry to its local start date, matching the canonical daily logs. */
export function dashboardReport(allSessions: WorkSession[], blocks: TimeBlock[], from: string, to: string, now = Date.now()) {
  const sessions = allSessions.filter((session) => {
    const date = sessionDay(session);
    return date >= from && date <= to;
  }).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const days = new Map<string, { actual: number; planned: number }>();
  const bucket = (date: string) => {
    let value = days.get(date);
    if (!value) { value = { actual: 0, planned: 0 }; days.set(date, value); }
    return value;
  };
  let actual = 0, planned = 0;
  for (const session of sessions) {
    const seconds = sessionSeconds(session, now);
    actual += seconds; bucket(sessionDay(session)).actual += seconds;
  }
  for (const block of blocks) {
    if (isAllDaySchedule(block) || block.status === "cancelled") continue;
    const date = localDateTime(block.start).slice(0, 10);
    if (date < from || date > to) continue;
    planned += block.duration * 60; bucket(date).planned += block.duration * 60;
  }
  return { sessions, actual, planned, days: [...days].sort(([a], [b]) => a.localeCompare(b)) };
}
