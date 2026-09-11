import { describe, expect, it, vi } from "vitest";
import { eventHideKey, GCalFeed, type GCalFeedHost, type GCalFeedSettings } from "../src/gcalFeed";
import type { CalEvent } from "../src/types";

const event = (id: string, recurringEventId?: string): CalEvent => ({
  id, recurringEventId, calendarId: "calendar", title: id,
  start: "2026-09-11T09:00", end: "2026-09-11T10:00", allDay: false,
  color: "#123456", htmlLink: "",
});

function setup(snapshot: CalEvent[] = [], hiddenEvents: Record<string, number> = {}) {
  const settings: GCalFeedSettings = {
    enabled: false, calendars: {}, hideDeclined: true, hiddenEvents, upcomingMonths: 1,
  };
  const saved: CalEvent[][] = [];
  const host: GCalFeedHost = {
    settings,
    snapshot: () => snapshot,
    setSnapshot: async (events) => { saved.push(events); },
    syncCalendarId: () => "opal",
    persist: vi.fn(async () => undefined),
    isVisible: () => true,
  };
  return { feed: new GCalFeed(host, {} as never), host, saved };
}

describe("Google calendar event hiding", () => {
  it("uses the series id when present and the event id otherwise", () => {
    expect(eventHideKey(event("one"))).toBe("calendar|one");
    expect(eventHideKey(event("occurrence", "series"))).toBe("calendar|series");
  });

  it("hides every cached occurrence in a recurring series without touching Google", async () => {
    const first = event("series_20260911", "series");
    const second = { ...event("series_20260918", "series"), start: "2026-09-18T09:00", end: "2026-09-18T10:00" };
    const other = event("other");
    const { feed, host, saved } = setup([first, second, other]);

    await feed.hideEvent(first);

    expect(feed.eventsIn("2026-09-01", "2026-09-30")).toEqual([other]);
    expect(host.settings.hiddenEvents["calendar|series"]).toBeTypeOf("number");
    expect(host.persist).toHaveBeenCalledOnce();
    expect(saved.at(-1)).toEqual([other]);
  });

  it("filters an already-hidden event from the offline snapshot", () => {
    const hidden = event("spam");
    const visible = event("useful");
    const { feed } = setup([hidden, visible], { [eventHideKey(hidden)]: Date.now() });
    expect(feed.eventsIn("2026-09-11", "2026-09-11")).toEqual([visible]);
  });

  it("keeps an occurrence hidden when an older snapshot did not know its series id", () => {
    const occurrence = event("series_20260911", "series");
    const { feed } = setup([occurrence], { "calendar|series_20260911": Date.now() });
    expect(feed.eventsIn("2026-09-11", "2026-09-11")).toEqual([]);
  });

  it("can restore all hidden identities", async () => {
    const { feed, host } = setup([], { "calendar|spam": Date.now() });
    await feed.restoreHiddenEvents();
    expect(host.settings.hiddenEvents).toEqual({});
    expect(host.persist).toHaveBeenCalledOnce();
  });
});
