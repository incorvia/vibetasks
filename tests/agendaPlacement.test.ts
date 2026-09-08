import { describe, it, expect } from "vitest";
import { Task, agendaDate } from "../src/types";
import { isOverdueTask, isTodayTask, isUpcomingTask, mergeTodayTaskBuckets } from "../src/filterEngine";

/**
 * Die task-eigene Agenda-Regel:
 *   `due` ist die einzige Zeitachse AUF DER AUFGABE. Planung lebt in separaten Zeitblöcken
 *   und wird erst beim Aufbau der Heute-Ansicht als zweites Signal dazugenommen.
 *
 * Wichtigste Zusicherung der due-Prädikate: Jede Aufgabe fällt in HÖCHSTENS EINEN ihrer drei
 * Töpfe. mergeTodayTaskBuckets dedupliziert danach die zusätzliche Planung innerhalb von Heute.
 */

const TODAY = "2026-07-29";
const GESTERN = "2026-07-28", MORGEN = "2026-07-30", NAECHSTE_WOCHE = "2026-08-05";

function mk(o: Partial<Task> = {}): Task {
  return {
    id: "t", path: "Items/t.md", title: "t", status: "todo", priority: "normal",
    due: null, dueTime: null, scheduled: null, scheduledTime: null, duration: null, start: null,
    sortOrder: null, project: null, parent: null, labels: [], description: "", recurrence: null,
    recurBasis: "due", reminders: [], created: TODAY, completed: null, cancelled: null,
    externalId: null, ...o,
  };
}

/** In welchem Topf landet die Aufgabe? */
const bucket = (t: Task): string =>
  [isOverdueTask(t, TODAY) && "überfällig", isTodayTask(t, TODAY) && "heute", isUpcomingTask(t, TODAY) && "demnächst"]
    .filter(Boolean).join("+") || "nirgends";

describe("Zeit-Ansichten: Platzierung", () => {
  it("alte scheduled-Werte werden nach der Migration nicht mehr als Agenda-Datum gelesen", () => {
    expect(agendaDate(mk({ scheduled: MORGEN }))).toBeNull();
    expect(bucket(mk({ scheduled: TODAY }))).toBe("nirgends");
  });

  it("mit Fälligkeit entscheidet die Fälligkeit – die Deadline verschiebt nichts", () => {
    expect(agendaDate(mk({ due: MORGEN, scheduled: NAECHSTE_WOCHE }))).toBe(MORGEN);
    expect(bucket(mk({ due: TODAY, scheduled: NAECHSTE_WOCHE }))).toBe("heute");
    expect(bucket(mk({ due: MORGEN, scheduled: TODAY }))).toBe("demnächst");   // Frist heute, Plan morgen
  });

  it("alte scheduled-Werte ändern eine due-basierte Platzierung nicht", () => {
    expect(bucket(mk({ due: MORGEN, scheduled: GESTERN }))).toBe("demnächst");
    expect(bucket(mk({ due: NAECHSTE_WOCHE, scheduled: GESTERN }))).toBe("demnächst");
  });

  it("… aber NICHT, wenn die Aufgabe heute ohnehin dran ist", () => {
    // Sonst stünde der halbe Heute-Abschnitt unter „Überfällig" – mit grünem „Heute" darunter.
    // Dass die Frist gerissen ist, sagt der rote Deadline-Chip in der Zeile.
    expect(bucket(mk({ due: TODAY, scheduled: GESTERN }))).toBe("heute");
    expect(bucket(mk({ due: TODAY, scheduled: "2026-07-21" }))).toBe("heute");
  });

  it("ohne beides steht die Aufgabe in keiner Zeit-Ansicht", () => {
    expect(agendaDate(mk())).toBeNull();
    expect(bucket(mk())).toBe("nirgends");
  });

  it("jede Konstellation landet in HÖCHSTENS EINEM Topf", () => {
    const daten = [null, GESTERN, TODAY, MORGEN, NAECHSTE_WOCHE];
    for (const due of daten) {
      for (const scheduled of daten) {
        const t = mk({ due, scheduled });
        const treffer = [isOverdueTask(t, TODAY), isTodayTask(t, TODAY), isUpcomingTask(t, TODAY)].filter(Boolean).length;
        expect(treffer, `due=${due} scheduled=${scheduled}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("jede Aufgabe mit due landet in GENAU EINEM Topf", () => {
    const daten = [GESTERN, TODAY, MORGEN, NAECHSTE_WOCHE];
    for (const due of [null, ...daten]) {
      for (const scheduled of [null, ...daten]) {
        if (!due) continue;
        expect(bucket(mk({ due, scheduled })), `due=${due} scheduled=${scheduled}`).not.toBe("nirgends");
      }
    }
  });

  it("nimmt extern geplante Arbeit in Heute auf, ohne Fälligkeiten oder Überfällige zu duplizieren", () => {
    const overdue = mk({ id: "late", due: GESTERN });
    const dueToday = mk({ id: "due", due: TODAY });
    const scheduledOnly = mk({ id: "planned" });
    const futureDueScheduledToday = mk({ id: "future", due: MORGEN });

    const result = mergeTodayTaskBuckets(
      [overdue],
      [dueToday],
      [scheduledOnly, futureDueScheduledToday, dueToday, overdue],
    );

    expect(result.overdue.map((task) => task.id)).toEqual(["late"]);
    expect(result.today.map((task) => task.id)).toEqual(["due", "planned", "future"]);
  });
});
