import { describe, it, expect } from "vitest";
import { setLocale, t, pickLocale } from "../src/i18n";

// Fehlt ein Schlüssel in einer Sprache, fällt t() still auf Englisch zurück – im Test-Vault des
// Entwicklers sieht das niemand, im spanischen Menü steht dann eine englische Zeile. Deshalb sind
// die Texte, die einen ZWEITEN Tab bzw. den Planungs-Split öffnen, hier je Sprache festgenagelt.

const LOCALES = ["en", "de", "es", "pt", "fr", "tr", "zh", "ru", "ja", "it"];
const KEYS = ["menu_open_new_tab", "menu_open_right", "menu_open_window", "plan_open"];
const PROJECT_NOTE_KEYS = [
  "cmd_project_from_note", "menu_project_from_note", "menu_open_opal_project",
  "notice_project_from_note", "notice_project_from_note_reconciled", "notice_project_from_note_failed",
  "notice_project_note_required", "notice_project_record_already", "project_notes", "project_notes_add",
];
const PROJECT_LIFECYCLE_KEYS = ["nav_recently_completed", "project_completed_notice"];
const BOARD_DISPLAY_KEYS = ["panel_show_empty_board_axes"];
const INLINE_TASK_KEYS = [
  "cmd_convert_inline_task", "set_inline_convert", "set_inline_convert_desc",
  "set_inline_overlays", "set_inline_overlays_desc", "notice_inline_line_changed",
  "notice_inline_create_failed", "notice_inline_schedule_failed",
];
const SETTINGS_TAB_KEYS = ["set_tab_tasks_planning", "set_tab_data_sync"];
const GCAL_HIDE_KEYS = [
  "gcalfeed_hide_event", "gcalfeed_hidden_events", "gcalfeed_hidden_events_desc", "gcalfeed_restore_hidden",
];
const NOW_MODE_KEYS = ["now_blitz", "now_stop_focus", "now_stop_blitz", "now_queued"];

describe("Öffnen-Menü: in jeder Sprache übersetzt", () => {
  it("kennt alle zehn Sprachen", () => {
    for (const loc of LOCALES) expect(pickLocale(loc)).toBe(loc);
  });

  it("liefert je Sprache einen eigenen Text (kein stiller Rückfall auf Englisch)", () => {
    setLocale("en");
    const en = KEYS.map((k) => t(k));
    expect(en).toEqual([
      "Open in new tab", "Open to the right", "Open in new window", "Open planning view",
    ]);

    for (const loc of LOCALES.filter((l) => l !== "en")) {
      setLocale(loc);
      for (const [i, key] of KEYS.entries()) {
        const s = t(key);
        expect(s, `${loc}/${key} fehlt`).not.toBe(key);      // kein Rückfall auf den Schlüssel
        expect(s, `${loc}/${key} ist englisch`).not.toBe(en[i]);
      }
    }
    setLocale("en");
  });

  it("deutsch im abgestimmten Wortlaut", () => {
    // Die ersten drei bewusst wie in Obsidians Datei-Explorer – wer sein Vault kennt, kennt sie schon.
    setLocale("de");
    expect(t("menu_open_new_tab")).toBe("In neuem Tab öffnen");
    expect(t("menu_open_right")).toBe("Rechts daneben öffnen");
    expect(t("menu_open_window")).toBe("In neuem Fenster öffnen");
    expect(t("plan_open")).toBe("Planungsansicht öffnen");
    setLocale("en");
  });

  it("Befehl und Menüeintrag teilen sich EINEN Schlüssel", () => {
    // Sie sollen wortgleich sein (ausdrücklich so entschieden). Zwei Schlüssel mit demselben Text
    // in zehn Sprachen wären eine Einladung, dass einer davon irgendwann nachgezogen wird und der
    // andere nicht – deshalb gibt es „plan_open" nur einmal.
    for (const loc of LOCALES) {
      setLocale(loc);
      expect(t("plan_open"), loc).not.toBe("plan_open");
    }
    setLocale("en");
  });
});

describe("Notiz-zu-Projekt: in jeder Sprache übersetzt", () => {
  it("fällt für keinen neuen Text still auf Englisch zurück", () => {
    setLocale("en");
    const en = PROJECT_NOTE_KEYS.map((key) => t(key));
    for (const loc of LOCALES.filter((locale) => locale !== "en")) {
      setLocale(loc);
      for (const [i, key] of PROJECT_NOTE_KEYS.entries()) {
        expect(t(key), `${loc}/${key} fehlt`).not.toBe(key);
        expect(t(key), `${loc}/${key} ist englisch`).not.toBe(en[i]);
      }
    }
    setLocale("en");
  });
});

describe("Completed-project lifecycle: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = PROJECT_LIFECYCLE_KEYS.map((key) => t(key, "Project"));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of PROJECT_LIFECYCLE_KEYS.entries()) {
        expect(t(key, "Project"), `${locale}/${key} fehlt`).not.toBe(key);
        expect(t(key, "Project"), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});

describe("Board display options: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = BOARD_DISPLAY_KEYS.map((key) => t(key));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of BOARD_DISPLAY_KEYS.entries()) {
        expect(t(key), `${locale}/${key} fehlt`).not.toBe(key);
        expect(t(key), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});

describe("Inline tasks: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = INLINE_TASK_KEYS.map((key) => t(key));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of INLINE_TASK_KEYS.entries()) {
        expect(t(key), `${locale}/${key} fehlt`).not.toBe(key);
        expect(t(key), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});

describe("Settings tabs: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = SETTINGS_TAB_KEYS.map((key) => t(key));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of SETTINGS_TAB_KEYS.entries()) {
        expect(t(key), `${locale}/${key} fehlt`).not.toBe(key);
        expect(t(key), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});

describe("Hidden calendar events: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = GCAL_HIDE_KEYS.map((key) => t(key, 2));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of GCAL_HIDE_KEYS.entries()) {
        expect(t(key, 2), `${locale}/${key} fehlt`).not.toBe(key);
        expect(t(key, 2), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});

describe("Focus and Blitz controls: translated in every locale", () => {
  it("does not silently fall back to English", () => {
    setLocale("en");
    const en = NOW_MODE_KEYS.map((key) => t(key));
    for (const locale of LOCALES.filter((value) => value !== "en")) {
      setLocale(locale);
      for (const [index, key] of NOW_MODE_KEYS.entries()) {
        expect(t(key), `${locale}/${key} fehlt`).not.toBe(key);
        if (key !== "now_blitz") expect(t(key), `${locale}/${key} ist englisch`).not.toBe(en[index]);
      }
    }
    setLocale("en");
  });
});
