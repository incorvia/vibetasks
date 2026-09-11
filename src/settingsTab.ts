import { App, PluginSettingTab, Setting, AbstractInputSuggest, TFolder, normalizePath, setIcon, Notice, Platform, ColorComponent, ExtraButtonComponent } from "obsidian";
import type OpalTasksPlugin from "./main";
import { ChipId, ChipTier, ChipSurface, MetaColorKey, DEFAULT_SETTINGS } from "./types";
import { CHIPS, chipsCompact, resolveChipOrder, chipTierOf } from "./chips";
import { StartPageModal, listStartPages, startPageLabel } from "./startPagePicker";
import { renderStatusEditor } from "./statusEditor";
import { DEFAULT_CALENDAR_NAME, CalendarInfo } from "./gcalSync";
import { PlanTabId, readPlanTabs, dailyNotesEnabled, forceListLeft } from "./planTabs";
import { t } from "./i18n";
import { tip } from "./tooltip";
import { CAL_MODES, CalMode } from "./calendarModel";
import { CalendarTaskColorMode } from "./calendarTaskColor";
import { DEFAULT_TIME_MAP, type TimeMap, type TimeMapRange } from "./autoPlanner";
import { listProjectsAndAreas } from "./taskService";

const CHIP_TIERS: ChipTier[] = ["shown", "onValue", "hidden"];

type SettingsPage = "general" | "planning" | "appearance" | "data";

/** README-Abschnitt mit der Google-Kalender-Einrichtung (statt nur zur Console zu verlinken). */
const GCAL_GUIDE_URL = "https://github.com/incorvia/opal_tasks#google-calendar-sync";

/** Pointer-basiertes Ziehen einer Chip-Zeile ZWISCHEN den drei Tier-Zonen (Maus + Touch,
 *  Popout-sicher über row.ownerDocument). Beim Loslassen ruft onDrop() – der Aufrufer liest
 *  Zonen-Zugehörigkeit + Reihenfolge aus dem DOM und persistiert chipTiers/chipOrder. */
function attachChipDrag(row: HTMLElement, grip: HTMLElement, zones: HTMLElement[], onDrop: () => void): void {
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const doc = row.ownerDocument;
    row.addClass("is-dragging");
    const onMove = (me: PointerEvent) => {
      const y = me.clientY;
      // Zielzone: die, deren Rechteck den Punkt (vertikal) enthält; sonst die vertikal nächste.
      let target = zones.find((z) => { const r = z.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
      if (!target) {
        let best = Infinity;
        for (const z of zones) { const r = z.getBoundingClientRect(); const dy = y < r.top ? r.top - y : y - r.bottom; if (dy < best) { best = dy; target = z; } }
      }
      if (!target) return;
      const sibs = (Array.from(target.children) as HTMLElement[]).filter((el) => el !== row);
      let placed = false;
      for (const sib of sibs) { const r = sib.getBoundingClientRect(); if (y < r.top + r.height / 2) { target.insertBefore(row, sib); placed = true; break; } }
      if (!placed) target.appendChild(row);
    };
    const onUp = () => {
      row.removeClass("is-dragging");
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      onDrop();
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
  });
}

/** Ordner-Autovervollständigung für ein Text-Eingabefeld (Obsidian-Standard-API). */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(private appRef: App, textInputEl: HTMLInputElement, private onPick: (path: string) => void) {
    super(appRef, textInputEl);
  }
  protected getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    const out: TFolder[] = [];
    for (const f of this.appRef.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path.toLowerCase().includes(q)) { out.push(f); if (out.length >= 100) break; }
    }
    return out;
  }
  renderSuggestion(folder: TFolder, el: HTMLElement): void { el.setText(folder.path || "/"); }
  selectSuggestion(folder: TFolder): void { this.setValue(folder.path); this.onPick(folder.path); this.close(); }
}

/** Einstellungen (imperativ; funktioniert auch auf App-Versionen < 1.13.0). */
export class OpalTasksSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: OpalTasksPlugin) {
    super(app, plugin);
  }

  private gcalStatusUnsub: (() => void) | null = null;
  private activePage: SettingsPage = "general";

  hide(): void { this.gcalStatusUnsub?.(); this.gcalStatusUnsub = null; }

  /**
   * „Planungsansicht": was im rechten Bereich entsteht – und in welcher Reihenfolge.
   *
   * Die Liste ist absichtlich ein Bild der Tab-Leiste, die sie erzeugt: oben = vorn. Deshalb
   * gibt es hier auch keine Auswahl „das ist der Standard"; der erste eingeschaltete Eintrag
   * IST er (s. planTabs.ts). Erzwungen wird nur, dass einer übrig bleibt – der letzte
   * eingeschaltete Schalter ist gesperrt, statt den Nutzer hinterher auf einen Fehler zu
   * stoßen, den er in einer Einstellungsseite gar nicht erwartet.
   */
  private renderPlanTabs(containerEl: HTMLElement): void {
    const p = this.plugin;
    new Setting(containerEl).setName(t("set_plan_heading")).setDesc(t("set_plan_desc")).setHeading();
    const host = containerEl.createDiv();

    const label: Record<PlanTabId, string> = {
      calendar: t("plan_tab_calendar"), note: t("plan_tab_note"), daily: t("plan_tab_daily"),
    };
    const desc: Record<PlanTabId, string> = {
      calendar: t("plan_tab_calendar_desc"), note: t("plan_tab_note_desc"), daily: t("plan_tab_daily_desc"),
    };

    const zeichne = (): void => {
      host.empty();
      const tabs = readPlanTabs(p.settings);
      const anCount = tabs.filter((e) => e.on).length;
      const speichern = async (next: typeof tabs): Promise<void> => {
        p.settings.planTabs = next;
        await p.saveSettings();
        zeichne();
      };
      tabs.forEach((tab, i) => {
        const row = new Setting(host).setName(label[tab.id]);
        // Die Tagesnotiz hängt am Kern-Plugin. Ist es aus, bleibt der Schalter bedienbar (die
        // Wahl gehört dem Nutzer), aber die Zeile sagt, warum gerade nichts passieren würde.
        const aus = tab.id === "daily" && !dailyNotesEnabled(p.app);
        row.setDesc(aus ? t("plan_tab_daily_off") : desc[tab.id]);
        row.addExtraButton((b) => b.setIcon("chevron-up").setTooltip(t("btn_move_up"))
          .setDisabled(i === 0)
          .onClick(() => {
            const next = tabs.slice();
            [next[i - 1], next[i]] = [next[i], next[i - 1]];
            void speichern(next);
          }));
        row.addExtraButton((b) => b.setIcon("chevron-down").setTooltip(t("btn_move_down"))
          .setDisabled(i === tabs.length - 1)
          .onClick(() => {
            const next = tabs.slice();
            [next[i], next[i + 1]] = [next[i + 1], next[i]];
            void speichern(next);
          }));
        row.addToggle((tg) => {
          const letzter = tab.on && anCount === 1;
          tg.setValue(tab.on).setDisabled(letzter).setTooltip(letzter ? t("plan_tab_last") : "")
            .onChange((v) => {
              const next = tabs.map((e, k) => (k === i ? { ...e, on: v } : e));
              void speichern(next);
            });
        });
      });
    };
    zeichne();

    // Bewusst UNTER der Reiter-Liste und außerhalb von zeichne(): Der Schalter betrifft nicht die
    // rechte Hälfte, sondern die linke – er gehört nicht in das Bild der Tab-Leiste darüber und
    // soll beim Umsortieren nicht mit neu aufgebaut werden.
    new Setting(containerEl).setName(t("set_plan_forcelist")).setDesc(t("set_plan_forcelist_desc"))
      .addToggle((tg) => tg.setValue(forceListLeft(p.settings)).onChange(async (v) => {
        p.settings.planForceList = v;
        await p.saveSettings();
      }));
  }

  display(): void {
    const { containerEl } = this;
    this.gcalStatusUnsub?.(); this.gcalStatusUnsub = null;   // altes Status-Abo lösen (Re-Render)
    containerEl.empty();
    const p = this.plugin;

    // Keep the page short enough to scan: the controls are still built together so their existing
    // local redraw callbacks keep working, but only one semantic group is visible at a time.
    const pages: { id: SettingsPage; label: string; icon: string }[] = [
      { id: "general", label: t("set_general_heading"), icon: "settings-2" },
      { id: "planning", label: t("set_tab_tasks_planning"), icon: "calendar-check" },
      { id: "appearance", label: t("set_appearance_heading"), icon: "palette" },
      { id: "data", label: t("set_tab_data_sync"), icon: "database" },
    ];
    const tabBar = containerEl.createDiv({ cls: "bt-settings-tabs", attr: { role: "tablist", "aria-label": "Opal Tasks settings" } });
    const panelByPage = new Map<SettingsPage, HTMLElement>();
    const buttonByPage = new Map<SettingsPage, HTMLButtonElement>();
    for (const [index, page] of pages.entries()) {
      const button = tabBar.createEl("button", {
        cls: "bt-settings-tab",
        attr: { type: "button", role: "tab", "aria-selected": "false" },
      });
      setIcon(button.createSpan({ cls: "bt-settings-tab-icon" }), page.icon);
      button.createSpan({ text: page.label });
      buttonByPage.set(page.id, button);
      const panel = containerEl.createDiv({ cls: "bt-settings-page", attr: { role: "tabpanel" } });
      panel.setAttribute("aria-label", page.label);
      panelByPage.set(page.id, panel);
      button.onclick = () => {
        this.selectPage(page.id, panelByPage, buttonByPage);
        tabBar.scrollIntoView({ block: "start" });
      };
      button.onkeydown = (event) => {
        let next = index;
        if (event.key === "ArrowLeft") next = (index + pages.length - 1) % pages.length;
        else if (event.key === "ArrowRight") next = (index + 1) % pages.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = pages.length - 1;
        else return;
        event.preventDefault();
        buttonByPage.get(pages[next].id)?.click();
        buttonByPage.get(pages[next].id)?.focus();
      };
    }
    const generalEl = panelByPage.get("general")!;
    const planningEl = panelByPage.get("planning")!;
    const appearanceEl = panelByPage.get("appearance")!;
    const dataEl = panelByPage.get("data")!;
    this.selectPage(this.activePage, panelByPage, buttonByPage);

    // Innerhalb der Seiten bleiben die bestehenden Obsidian-Überschriften als Wegweiser erhalten.

    // ── Allgemein ──
    new Setting(generalEl).setName(t("set_general_heading")).setHeading();

    new Setting(generalEl).setName(t("set_language")).setDesc(t("set_language_desc")).addDropdown((dd) => {
      dd.addOption("auto", t("set_language_auto"));
      dd.addOption("en", "English");
      dd.addOption("de", "Deutsch");
      dd.addOption("es", "Español");
      dd.addOption("pt", "Português (Brasil)");
      dd.addOption("fr", "Français");
      dd.addOption("it", "Italiano");
      dd.addOption("tr", "Türkçe");
      dd.addOption("ru", "Русский");
      dd.addOption("zh", "简体中文");
      dd.addOption("ja", "日本語");
      dd.setValue(p.settings.locale);
      // Sofort auf die Plugin-UI anwenden; die Settings-Labels wechseln beim erneuten Öffnen.
      dd.onChange(async (v) => { p.settings.locale = v; await p.saveSettings(); p.applyLocale(); p.renderAll(); });
    });

    // Startseite: JEDE Seite ist wählbar (Eingang, Ansichten, Bereiche, Projekte, Filter, Labels).
    // Ein <select> scheidet dafür aus – bei 40 Projekten unbrauchbar und ohne Suche. Stattdessen
    // ein Knopf mit der aktuellen Wahl, der Obsidians Suchliste öffnet (Tastatur wie Strg+P).
    const startRow = new Setting(generalEl).setName(t("set_start_page")).setDesc(t("set_start_page_desc"));
    const zeichneStart = (): void => {
      const cur = startPageLabel(p, p.settings.startPage);
      startRow.setDesc(cur.missing ? t("set_start_page_missing") : t("set_start_page_desc"));
      startRow.controlEl.empty();
      const btn = startRow.controlEl.createEl("button", { cls: "bt-startpage-btn" });
      setIcon(btn.createSpan({ cls: "bt-startpage-icon" }), cur.icon);
      btn.createSpan({ text: cur.label });
      setIcon(btn.createSpan({ cls: "bt-startpage-caret" }), "chevron-down");
      btn.onclick = () => new StartPageModal(p.app, listStartPages(p), p.settings.startPage,
        (v) => { p.settings.startPage = v; void p.saveSettings(); zeichneStart(); }).open();
    };
    zeichneStart();

    new Setting(appearanceEl).setName(t("set_appearance_heading")).setHeading();

    new Setting(appearanceEl).setName(t("set_default_calendar_view")).setDesc(t("set_default_calendar_view_desc")).addDropdown((dd) => {
      for (const mode of CAL_MODES) dd.addOption(mode, t("cal_mode_" + mode));
      dd.setValue(p.settings.defaultCalendarView);
      dd.onChange(async (v) => {
        p.settings.defaultCalendarView = v as CalMode;
        await p.saveSettings();
        p.renderAll();
      });
    });

    new Setting(appearanceEl).setName(t("set_calendar_task_colors")).setDesc(t("set_calendar_task_colors_desc")).addDropdown((dd) => {
      dd.addOption("priority", t("set_calendar_task_colors_priority"));
      dd.addOption("calendar", t("set_calendar_task_colors_calendar"));
      dd.addOption("task", t("set_calendar_task_colors_task"));
      dd.setValue(p.settings.calendarTaskColorMode);
      dd.onChange(async (value) => {
        p.settings.calendarTaskColorMode = value as CalendarTaskColorMode;
        await p.saveSettings();
        p.renderAll();
      });
    });

    new Setting(planningEl).setName(t("set_tab_tasks_planning")).setHeading();

    new Setting(planningEl).setName(t("set_nl")).setDesc(t("set_nl_desc")).addToggle((tg) =>
      tg.setValue(p.settings.parseNaturalLanguage).onChange(async (v) => { p.settings.parseNaturalLanguage = v; await p.saveSettings(); }));

    new Setting(planningEl).setName(t("set_inline_convert")).setDesc(t("set_inline_convert_desc")).addToggle((tg) =>
      tg.setValue(p.settings.showInlineConvertButtons).onChange(async (v) => {
        p.settings.showInlineConvertButtons = v; await p.saveSettings(); p.app.workspace.updateOptions();
      }));

    new Setting(planningEl).setName(t("set_inline_overlays")).setDesc(t("set_inline_overlays_desc")).addToggle((tg) =>
      tg.setValue(p.settings.enableTaskLinkOverlays).onChange(async (v) => {
        p.settings.enableTaskLinkOverlays = v; await p.saveSettings(); p.app.workspace.updateOptions();
      }));

    new Setting(planningEl).setName(t("set_show_unfiled")).setDesc(t("set_show_unfiled_desc")).addToggle((tg) =>
      tg.setValue(p.settings.showUnfiledInInbox).onChange(async (v) => {
        p.settings.showUnfiledInInbox = v;
        await p.saveSettings();
        p.renderAll();   // Eingang + Zähler neu zeichnen
      }));

    // ── Planungsansicht ──
    this.renderPlanTabs(planningEl);
    this.renderTimeMaps(planningEl);

    // ── Darstellung ──
    new Setting(appearanceEl).setName(t("set_show_desc")).setDesc(t("set_show_desc_desc")).addToggle((tg) =>
      tg.setValue(p.settings.showDescriptionInList).onChange(async (v) => {
        p.settings.showDescriptionInList = v;
        await p.saveSettings();
        p.renderAll();
      }));

    new Setting(appearanceEl).setName(t("set_show_proj_desc")).setDesc(t("set_show_proj_desc_desc")).addToggle((tg) =>
      tg.setValue(p.settings.showProjectDescription).onChange(async (v) => {
        p.settings.showProjectDescription = v;
        await p.saveSettings();
        p.renderAll();
      }));

    // Register der Farb-Picker/Reset-Knöpfe – der Theme-Wechsel aktualisiert deren Zustand direkt
    // (aktiv nur bei „User", Swatch = effektive Farbe des neuen Themes), ohne this.display().
    const colorControls: { key: MetaColorKey; picker: ColorComponent; reset: ExtraButtonComponent }[] = [];
    let colorBox: HTMLElement;   // Container aller Farbzeilen – wird bei Nicht-„User" sichtbar abgedunkelt (is-locked)

    // Zu jeder Meta-Farbe ihre CSS-Variable; resolveColor liest die EFFEKTIVE (gerenderte) Farbe über ein
    // Probe-Element aus – also auch die echte Obsidian-Akzentfarbe bzw. den User-Override.
    const cssVarOf: Record<MetaColorKey, string> = {
      accent: "--bt-accent",
      overdue: "--bt-dist-overdue", today: "--bt-dist-today", d1: "--bt-dist-d1", d2: "--bt-dist-d2", week: "--bt-dist-week", far: "--bt-dist-far",
      recur: "--bt-c-recur", remind: "--bt-c-remind", sched: "--bt-c-sched", label: "--bt-c-label",
      comments: "--bt-c-comments", subs: "--bt-c-subs", parent: "--bt-c-parent", backlink: "--bt-c-backlink",
    };
    const resolveColor = (key: MetaColorKey): string => {
      const probe = document.body.createSpan();
      probe.style.color = `var(${cssVarOf[key]})`;
      const m = getComputedStyle(probe).color.match(/\d+/g);
      probe.remove();
      return m && m.length >= 3 ? "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("") : "#888888";
    };

    // Akzentfarbe – eigenständige Design-Einstellung ÜBER der Meta-Theme-Sektion (thematisch getrennt: der
    // Akzent wirkt auf das ganze Plugin – Buttons/Links/Auswahl –, nicht nur auf die Meta-Zeile). Überschreibt
    // die Obsidian-Akzentfarbe NUR innerhalb von Opal Tasks; Default/Reset = Obsidian-Akzent. Immer editierbar.
    {
      let accentPicker!: ColorComponent;
      const s = new Setting(appearanceEl).setName(t("set_color_accent")).setDesc(t("set_color_accent_desc"))
        .addColorPicker((cp) => { accentPicker = cp; cp.setValue(resolveColor("accent")).onChange(async (v) => {
          p.settings.metaColors = { ...p.settings.metaColors, accent: v };
          await p.saveSettings(); p.applyColors(); p.renderAll();
        }); })
        .addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip(t("filter_reset")).onClick(async () => {
          const nc = { ...p.settings.metaColors }; delete nc.accent;
          p.settings.metaColors = nc;
          await p.saveSettings(); p.applyColors(); p.renderAll();
          accentPicker.setValue(resolveColor("accent"));   // zurück auf Obsidian-Akzent
        }));
      const ic = createSpan({ cls: "bt-color-row-ic" });
      setIcon(ic, "palette");
      ic.style.color = `var(${cssVarOf.accent})`;   // Icon in der effektiven Akzentfarbe (Live-Vorschau)
      s.nameEl.prepend(ic);
    }

    new Setting(appearanceEl).setName(t("set_meta_theme")).setDesc(t("set_meta_theme_desc")).addDropdown((dd) => {
      dd.addOption("minimalisdo", "Minimalisdo");   // Eigennamen -> nicht übersetzt
      dd.addOption("colorado", "Colorado");
      dd.addOption("user", "User");   // eigene Farben (metaColors) – nur hier sind die Picker aktiv
      dd.setValue(p.settings.metaTheme).onChange(async (v) => {
        p.settings.metaTheme = v as "minimalisdo" | "colorado" | "user";
        await p.saveSettings();
        p.renderAll();     // setzt die Colorado-Body-Klasse
        p.applyColors();   // User-Overrides an/aus
        const isU = p.settings.metaTheme === "user";
        colorBox.toggleClass("is-locked", !isU);   // sichtbar abdunkeln, wenn nicht editierbar
        for (const c of colorControls) {
          c.picker.setDisabled(!isU); c.reset.setDisabled(!isU);
          c.picker.setValue(resolveColor(c.key));   // Swatch = effektive Farbe des neuen Themes (Preset bzw. User-Wert)
        }
      });
    });

    // Farben je Meta-Element EINZELN: Color-Picker + Reset (leert -> Theme-Default). Der Swatch zeigt die
    // aktuelle EFFEKTIVE Farbe (resolveColor, s. o.). Nur im „User"-Theme editierbar (sonst gedimmt).
    new Setting(appearanceEl).setName(t("set_colors_heading")).setDesc(t("set_colors_desc")).setHeading();
    const isUser = p.settings.metaTheme === "user";   // Farben nur im „User"-Theme änderbar
    // Icon vor jedem Farbnamen = GENAU das Symbol der Meta-Zeile (calendar/alarm-clock/… – s. heuteView),
    // damit die Zuordnung eindeutig ist (Verwechslung Haupt-/Unteraufgabe o. Ä. ausgeschlossen). Das Icon
    // trägt die effektive Farbe (CSS-Variable), ist also selbst eine kleine Live-Vorschau.
    const colorRow = (key: MetaColorKey, name: string, icon: string): void => {
      let picker!: ColorComponent; let reset!: ExtraButtonComponent;
      const s = new Setting(colorBox).setName(name)
        .addColorPicker((cp) => { picker = cp; cp.setDisabled(!isUser).setValue(resolveColor(key)).onChange(async (v) => {
          p.settings.metaColors = { ...p.settings.metaColors, [key]: v };
          await p.saveSettings(); p.applyColors(); p.renderAll();
        }); })
        .addExtraButton((b) => { reset = b; b.setIcon("rotate-ccw").setDisabled(!isUser).setTooltip(t("filter_reset")).onClick(async () => {
          const nc = { ...p.settings.metaColors }; delete nc[key];
          p.settings.metaColors = nc;
          await p.saveSettings(); p.applyColors(); p.renderAll();
          picker.setValue(resolveColor(key));   // Swatch = aktuelle effektive Farbe (jetzt der Theme-Default)
        }); });
      const ic = createSpan({ cls: "bt-color-row-ic" });
      setIcon(ic, icon);
      ic.style.color = `var(${cssVarOf[key]})`;   // Icon in der effektiven Farbe (Live-Vorschau)
      s.nameEl.prepend(ic);
      colorControls.push({ key, picker, reset });   // fürs Aktivieren/Deaktivieren beim Theme-Wechsel
    };
    colorBox = appearanceEl.createDiv({ cls: "bt-color-settings" });   // themengebundene Farbzeilen (dimmbar)
    colorRow("overdue", t("sec_overdue"), "calendar");
    colorRow("today", t("date_today"), "calendar");
    colorRow("d1", t("date_tomorrow"), "calendar");
    colorRow("d2", t("set_color_d2"), "calendar");
    colorRow("week", t("set_color_week"), "calendar");
    colorRow("far", t("set_color_far"), "calendar");
    colorRow("recur", t("set_color_recur"), "refresh-cw");
    colorRow("remind", t("set_color_remind"), "alarm-clock");
    colorRow("sched", t("filter_group_deadline"), "clock");
    colorRow("label", t("filter_group_label"), "tag");
    colorRow("comments", t("set_color_comments"), "paperclip");
    colorRow("subs", t("set_color_subs"), "list-checks");
    colorRow("parent", t("set_color_parent"), "corner-left-up");
    colorRow("backlink", t("filter_group_project"), "at-sign");
    colorBox.toggleClass("is-locked", !isUser);   // Startzustand: abgedunkelt, wenn nicht „User"

    // Auf Mobilgeraeten ist der Kompakt-Modus fest an (44px-Chips mit Text saehen dort den
    // halben Bildschirm) – der Schalter zeigt das an und ist deaktiviert, statt wirkungslos
    // umschaltbar zu sein. Der gespeicherte Wert bleibt unangetastet und gilt am Desktop weiter.
    new Setting(appearanceEl).setName(t("set_chips_iconsonly")).setDesc(t("set_chips_iconsonly_desc")).addToggle((tg) =>
      tg.setValue(chipsCompact(p.settings)).setDisabled(Platform.isMobile).onChange(async (v) => {
        p.settings.chipsIconsOnly = v;
        await p.saveSettings();
      }));

    // Textgröße: eigener Host, damit das Reset-Icon die Slider mit den neuen Werten neu zeichnen kann.
    const fontHost = appearanceEl.createDiv();
    const drawFonts = (): void => {
      fontHost.empty();
      new Setting(fontHost).setName(t("set_fontsizes_heading")).setHeading()
        .addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip(t("chip_reset_default"))
          .onClick(async () => {
            p.settings.fontTaskPct = DEFAULT_SETTINGS.fontTaskPct;
            p.settings.fontNavPct = DEFAULT_SETTINGS.fontNavPct;
            p.settings.fontHeadingPct = DEFAULT_SETTINGS.fontHeadingPct;
            p.settings.fontSectionPct = DEFAULT_SETTINGS.fontSectionPct;
            await p.saveSettings();
            p.applyFontSizes();
            drawFonts();
          }));
      fontHost.createDiv({ cls: "setting-item-description", text: t("set_fontsizes_desc") });
      const fontSlider = (name: string, get: () => number, assign: (v: number) => void): void => {
        new Setting(fontHost).setName(name).addSlider((sl) =>
          sl.setLimits(80, 130, 5).setValue(get())
            .onChange(async (v) => { assign(v); await p.saveSettings(); p.applyFontSizes(); }));
      };
      fontSlider(t("set_font_task"), () => p.settings.fontTaskPct, (v) => (p.settings.fontTaskPct = v));
      fontSlider(t("set_font_nav"), () => p.settings.fontNavPct, (v) => (p.settings.fontNavPct = v));
      fontSlider(t("set_font_heading"), () => p.settings.fontHeadingPct, (v) => (p.settings.fontHeadingPct = v));
      fontSlider(t("set_font_section"), () => p.settings.fontSectionPct, (v) => (p.settings.fontSectionPct = v));
    };
    drawFonts();

    // ── Aufgabenaktionen (Chips je Fläche ein-/ausblenden + sortieren) ──
    new Setting(planningEl).setName(t("set_chip_actions")).setHeading();
    planningEl.createDiv({ cls: "setting-item-description bt-chip-actions-desc", text: t("set_chip_actions_desc") });
    this.renderChipActions(planningEl);

    // ── Status (früher im ListManager; Custom-Status ist Konfiguration → gehört hierher) ──
    new Setting(planningEl).setName(t("tab_statuses")).setHeading();
    renderStatusEditor(planningEl.createDiv({ cls: "bt-settings-status" }), p);

    // ── Ordner ──
    new Setting(generalEl).setName(t("set_folders_heading")).setHeading();
    const folderRow = (name: string, desc: string, get: () => string, set: (v: string) => void | Promise<void>) => {
      new Setting(generalEl).setName(name).setDesc(desc).addText((text) => {
        text.setValue(get());
        const save = (raw: string) => { const v = normalizePath(raw.trim()); if (v && v !== ".") void set(v); };
        text.onChange(save);
        new FolderSuggest(this.app, text.inputEl, (path) => { text.setValue(path); save(path); });
      });
    };
    folderRow(t("set_folder_items"), t("set_folder_items_desc"), () => p.settings.itemsFolder, (v) => p.setCollectionFolder("task", v));
    folderRow(t("set_folder_projects"), t("set_folder_projects_desc"), () => p.settings.projectsFolder, (v) => p.setCollectionFolder("project", v));
    folderRow(t("set_folder_templates"), t("set_folder_templates_desc"), () => p.settings.templatesFolder, (v) => p.setCollectionFolder("template", v));
    folderRow(t("set_folder_attachments"), t("set_folder_attachments_desc"), () => p.settings.attachmentsFolder, async (v) => { p.settings.attachmentsFolder = v; await p.saveSettings(); });

    // Ausschluss-Ordner: Notizen darin gelten NIE als Aufgabe (Schutz vor fremden type:task-Notizen).
    // Ein Ordner pro Zeile. Änderung erfordert einen Index-Neuaufbau (parse-Ergebnis ändert sich).
    new Setting(generalEl).setName(t("set_exclude_folders")).setDesc(t("set_exclude_folders_desc"))
      .addTextArea((ta) => {
        ta.setValue(p.settings.excludeFolders.join("\n"));
        ta.inputEl.rows = 3;
        // Tippen speichert nur den Wert (billig). Der teure Index-Neuaufbau (Vollscan) läuft
        // erst beim Verlassen des Feldes – nicht bei jedem Tastendruck.
        ta.onChange(async (v) => {
          p.settings.excludeFolders = v.split("\n").map((s) => normalizePath(s.trim())).filter((s) => s && s !== ".");
          await p.saveSettings();
        });
        ta.inputEl.addEventListener("blur", () => { p.index.build(); p.renderAll(); });
      });

    // ── Import & Export ──
    new Setting(dataEl).setName(t("set_data_heading")).setHeading();

    new Setting(dataEl).setName(t("set_export")).setDesc(t("set_export_desc"))
      .addButton((b) => b.setButtonText(t("set_export_btn")).setCta().onClick(() => void p.exportTasksJson()));

    new Setting(dataEl).setName(t("set_import")).setDesc(t("set_import_desc"))
      .addButton((b) => b.setButtonText(t("set_import_vault_btn")).onClick(() => p.importTasksFromVault()))
      .addButton((b) => b.setButtonText(t("set_import_os_btn")).onClick(() => p.importTasksFromOs()));

    new Setting(dataEl).setName(t("set_import_tn")).setDesc(t("set_import_tn_desc"))
      .addButton((b) => b.setButtonText(t("set_import_tn_btn")).onClick(() => p.importFromTaskNotes()));

    // ── Google Kalender ── (eigener Container → Neuzeichnen ohne this.display()-Selbstaufruf)
    const gcalHost = dataEl.createDiv();
    const drawGCal = (): void => { gcalHost.empty(); this.renderGCal(gcalHost, drawGCal); };
    drawGCal();
  }

  private selectPage(
    page: SettingsPage,
    panels: Map<SettingsPage, HTMLElement>,
    buttons: Map<SettingsPage, HTMLButtonElement>,
  ): void {
    this.activePage = page;
    for (const [id, panel] of panels) {
      const active = id === page;
      panel.toggleClass("is-active", active);
      panel.hidden = !active;
      const button = buttons.get(id);
      button?.toggleClass("is-active", active);
      button?.setAttr("aria-selected", String(active));
      if (button) button.tabIndex = active ? 0 : -1;
    }
  }

  private renderTimeMaps(containerEl: HTMLElement): void {
    const p = this.plugin;
    new Setting(containerEl).setName(t("auto_excluded_labels")).setDesc(t("auto_excluded_labels_desc"));
    const excludedHost = containerEl.createDiv({ cls: "bt-auto-excluded-labels" });
    const excluded = new Set((p.settings.autoPlanExcludedLabels ?? []).map((name) => name.toLocaleLowerCase()));
    const labels = p.getLabels();
    if (!labels.length) excludedHost.createDiv({ cls: "setting-item-description", text: t("auto_no_labels") });
    for (const label of labels) {
      new Setting(excludedHost).setName(`#${label.name}`).addToggle((toggle) => toggle
        .setValue(excluded.has(label.name.toLocaleLowerCase()))
        .onChange(async (enabled) => {
          const key = label.name.toLocaleLowerCase();
          const current = p.settings.autoPlanExcludedLabels ?? [];
          p.settings.autoPlanExcludedLabels = enabled
            ? current.some((name) => name.toLocaleLowerCase() === key) ? current : [...current, label.name]
            : current.filter((name) => name.toLocaleLowerCase() !== key);
          await p.saveSettings();
        }));
    }

    new Setting(containerEl).setName(t("auto_time_maps")).setDesc(t("auto_time_maps_desc")).setHeading();
    const host = containerEl.createDiv({ cls: "bt-time-maps" });
    const cloneDefault = (): TimeMap => ({ ...DEFAULT_TIME_MAP, days: Object.fromEntries(
      Object.entries(DEFAULT_TIME_MAP.days).map(([day, ranges]) => [day, ranges?.map((r) => ({ ...r })) ?? []])) });
    const current = (): TimeMap[] => p.settings.timeMaps?.length ? p.settings.timeMaps : [cloneDefault()];
    const save = async (maps: TimeMap[]): Promise<void> => {
      p.settings.timeMaps = maps;
      if (!maps.some((m) => m.id === p.settings.defaultTimeMapId)) p.settings.defaultTimeMapId = maps[0]?.id ?? "default";
      await p.saveSettings(); p.renderAll(); draw();
    };
    const valid = (r: TimeMapRange): boolean => r.start < r.end;
    const dayNames = Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, 7 + day)));
    const draw = (): void => {
      host.empty();
      const maps = current();
      for (const [mapIndex, map] of maps.entries()) {
        const card = host.createDiv({ cls: "bt-time-map" });
        const head = card.createDiv({ cls: "bt-time-map-head" });
        const name = head.createEl("input", { cls: "bt-time-map-name", attr: { type: "text", "aria-label": t("auto_time_map_name") } });
        name.value = map.name;
        name.onchange = () => { map.name = name.value.trim() || t("auto_time_map_unnamed"); void save(maps); };
        const def = head.createEl("button", { cls: "bt-time-map-default" + ((p.settings.defaultTimeMapId ?? "default") === map.id ? " is-active" : ""), text: t("auto_default") });
        def.onclick = async () => { p.settings.defaultTimeMapId = map.id; await p.saveSettings(); draw(); };
        if (maps.length > 1) {
          const remove = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("btn_delete") } });
          setIcon(remove, "trash-2");
          remove.onclick = () => void save(maps.filter((_, i) => i !== mapIndex));
        }
        const days = card.createDiv({ cls: "bt-time-map-days" });
        for (let day = 0; day < 7; day++) {
          const col = days.createDiv({ cls: "bt-time-map-day" });
          col.createDiv({ cls: "bt-time-map-day-name", text: dayNames[day] });
          const ranges = map.days[day] ?? [];
          for (const [rangeIndex, range] of ranges.entries()) {
            const row = col.createDiv({ cls: "bt-time-map-range" });
            const start = row.createEl("input", { attr: { type: "time", "aria-label": `${dayNames[day]} ${t("auto_start")}` } });
            start.value = range.start;
            const end = row.createEl("input", { attr: { type: "time", "aria-label": `${dayNames[day]} ${t("auto_end")}` } });
            end.value = range.end;
            const commit = (): void => {
              const next = { start: start.value, end: end.value };
              row.toggleClass("is-invalid", !valid(next));
              if (valid(next)) { ranges[rangeIndex] = next; map.days[day] = ranges; void save(maps); }
            };
            start.onchange = commit; end.onchange = commit;
            const remove = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("btn_delete") } });
            setIcon(remove, "x");
            remove.onclick = () => { map.days[day] = ranges.filter((_, i) => i !== rangeIndex); void save(maps); };
          }
          const add = col.createEl("button", { cls: "bt-time-map-add", text: t("auto_add_hours") });
          add.onclick = () => { map.days[day] = [...ranges, { start: "09:00", end: "17:00" }]; void save(maps); };
        }
      }
      const addMap = host.createEl("button", { text: t("auto_add_map") });
      addMap.onclick = () => void save([...maps, { id: `map-${Date.now().toString(36)}`, name: t("auto_time_map_unnamed"), days: {} }]);

      const areas = listProjectsAndAreas(p.app).bereiche;
      if (areas.length) {
        new Setting(host).setName(t("auto_area_maps")).setHeading();
        for (const area of areas) new Setting(host).setName(area.name).addDropdown((dd) => {
          dd.addOption("", t("auto_use_default"));
          for (const map of maps) dd.addOption(map.id, map.name);
          dd.setValue(area.timeMapId && maps.some((m) => m.id === area.timeMapId) ? area.timeMapId : "");
          dd.onChange((value) => void p.assignAreaTimeMap(area.path, value || null));
        });
      }
    };
    draw();
  }

  /** Google-Kalender-Sektion: vor dem Verbinden ein schlanker Setup-Assistent, danach der
   *  Verbunden-Zustand mit Status, Ziel-Kalender und Optionen (Feinkorn unter „Erweitert").
   *  Progressive Offenlegung – Optionen erscheinen erst nach erfolgreicher Verbindung.
   *  `redraw` zeichnet nur diese Sektion neu (kein this.display() → keine no-deprecated-Warnung). */
  private renderGCal(containerEl: HTMLElement, redraw: () => void): void {
    const p = this.plugin;
    const g = p.settings.gcal!;
    this.gcalStatusUnsub?.(); this.gcalStatusUnsub = null;   // Abo vor Neuaufbau lösen
    new Setting(containerEl).setName(t("set_gcal_heading")).setHeading();

    // ── Nicht verbunden: Assistent ──
    if (!p.gcalAuth.isConnected()) {
      containerEl.createDiv({ cls: "setting-item-description", text: t("gcal_setup_desc") });
      new Setting(containerEl).addButton((b) => b.setButtonText(t("gcal_help_btn"))
        .onClick(() => window.open(GCAL_GUIDE_URL)));
      // „Verbinden" muss reaktiv (de)aktiviert werden, sobald beide Felder gefüllt sind –
      // sonst bliebe der Button vom leeren Erst-Render dauerhaft deaktiviert.
      let connectBtn: import("obsidian").ButtonComponent | null = null;
      const refreshConnect = (): void => { connectBtn?.setDisabled(!g.clientId || !g.clientSecret); };
      new Setting(containerEl).setName(t("gcal_client_id")).addText((txt) =>
        txt.setValue(g.clientId).onChange((v) => { g.clientId = v.trim(); void p.saveSettings(); refreshConnect(); }));
      new Setting(containerEl).setName(t("gcal_client_secret")).addText((txt) => {
        txt.inputEl.type = "password";
        txt.setValue(g.clientSecret).onChange((v) => { g.clientSecret = v.trim(); void p.saveSettings(); refreshConnect(); });
      });
      containerEl.createDiv({ cls: "setting-item-description bt-gcal-hint", text: t("gcal_setup_hint") });
      new Setting(containerEl).addButton((b) => {
        connectBtn = b;
        b.setButtonText(t("gcal_connect_btn")).setCta().setDisabled(!g.clientId || !g.clientSecret)
          .onClick(async () => {
            b.setButtonText(t("gcal_connecting")).setDisabled(true);
            try {
              await p.gcalConnect((dp) => new Notice(t("gcal_device_prompt", dp.verificationUrl, dp.userCode), 0));
            } catch (e) {
              new Notice(t("gcal_connect_failed", e instanceof Error ? e.message : String(e)));
            }
            redraw();
          });
      });
      // Der Token liegt geräte-lokal (s. main.ts, GCAL_TOKEN_KEY) – das muss vor dem Verbinden
      // dastehen, sonst wundern sich Nutzer, warum das zweite Gerät nicht mitkommt.
      containerEl.createDiv({ cls: "setting-item-description bt-gcal-hint", text: t("gcal_device_only") });
      return;
    }

    // ── Verbunden: Kopf mit Status ──
    const head = new Setting(containerEl).setName(t("gcal_connected_as", p.gcalAuth.account() ?? "—"))
      .addButton((b) => b.setButtonText(t("gcal_disconnect_btn"))
        .onClick(async () => { await p.gcalDisconnect(); redraw(); }));
    head.nameEl.prepend(createSpan({ cls: "bt-gcal-dot" }));

    // Kein Ziel-Kalender (z. B. Auto-Anlage fehlgeschlagen) → deutlich führen statt still nichts tun.
    if (!g.calendarId) containerEl.createDiv({ cls: "bt-gcal-warn", text: t("gcal_no_calendar_warn") });

    const statusSetting = new Setting(containerEl)
      .addButton((b) => b.setButtonText(t("gcal_sync_now_btn")).onClick(() => void p.gcalSync.syncNow()));
    const renderStatus = (i: import("./gcalSync").GCalStatusInfo): void => {
      const txt = i.status === "syncing" ? t("gcal_syncing")
        : i.status === "error" ? t("gcal_sync_error", i.lastError ?? "")
        : t("gcal_last_synced", i.lastSyncedAt ? new Date(i.lastSyncedAt).toLocaleString() : t("gcal_never"));
      statusSetting.setName(txt);
    };
    this.gcalStatusUnsub = p.gcalSync.onStatus(renderStatus);   // ruft cb sofort mit aktuellem Stand

    // Ziel-Kalender + (nur wenn in Google noch KEIN „Opal Tasks"-Kalender existiert) eine Tipp-Zeile
    // zum Anlegen. Kalenderliste EINMAL laden und den ganzen Abschnitt daraus aufbauen.
    const calHost = containerEl.createDiv();
    void (async () => {
      let cals: CalendarInfo[] = [];
      let ok = false;
      try { cals = await p.gcalCalendars(); ok = true; } catch { /* offline → Fallback unten */ }
      new Setting(calHost).setName(t("gcal_target_calendar")).setDesc(t("gcal_target_calendar_desc"))
        .addDropdown((dd) => {
          if (cals.length) for (const c of cals) dd.addOption(c.id, c.summary);
          else if (g.calendarId) dd.addOption(g.calendarId, g.calendarId);   // offline: aktuelle Wahl zeigen
          dd.setValue(g.calendarId);
          dd.onChange((v) => { g.calendarId = v; void p.saveSettings(); void p.gcalSync.syncNow(); });
        });
      // Tipp/Anlegen nur, wenn geprüft UND noch kein eigener Opal Tasks-Kalender existiert.
      if (ok && !cals.some((c) => c.summary === DEFAULT_CALENDAR_NAME)) {
        new Setting(calHost).setName(t("gcal_tip_create")).setDesc(t("gcal_tip_create_desc"))
          .addButton((b) => b.setButtonText(t("gcal_create_calendar_btn")).setCta()
            .onClick(async () => {
              try { await p.gcalCreateDefaultCalendar(); }
              catch (e) { new Notice(t("gcal_create_calendar_failed", e instanceof Error ? e.message : String(e))); }
              redraw();
            }));
      }
    })();

    new Setting(containerEl).setName(t("gcal_enabled")).setDesc(t("gcal_enabled_desc"))
      .addToggle((tg) => tg.setValue(g.enabled).onChange((v) => { g.enabled = v; void p.saveSettings(); if (v) void p.gcalSync.syncNow(); }));
    new Setting(containerEl).setName(t("gcal_autosync")).setDesc(t("gcal_autosync_desc"))
      .addToggle((tg) => tg.setValue(g.autoSync).onChange((v) => { g.autoSync = v; void p.saveSettings(); }));

    // ── Termine anzeigen (read-only Feed, getrennt vom Sync) ──
    this.renderGCalFeed(containerEl, redraw);

    // ── Erweitert (zugeklappt) ──
    const adv = containerEl.createEl("details", { cls: "bt-gcal-advanced" });
    adv.createEl("summary", { text: t("gcal_advanced") });
    const av = adv.createDiv();
    const boolRow = (key: string, get: () => boolean, set: (v: boolean) => void): void => {
      new Setting(av).setName(t(key)).addToggle((tg) => tg.setValue(get()).onChange((v) => { set(v); void p.saveSettings(); }));
    };
    boolRow("gcal_on_create", () => g.syncOnCreate, (v) => (g.syncOnCreate = v));
    boolRow("gcal_on_update", () => g.syncOnUpdate, (v) => (g.syncOnUpdate = v));
    boolRow("gcal_on_delete", () => g.syncOnDelete, (v) => (g.syncOnDelete = v));
    boolRow("gcal_remove_on_complete", () => g.removeEventOnComplete, (v) => (g.removeEventOnComplete = v));
    new Setting(av).setName(t("gcal_timezone")).addText((txt) =>
      txt.setValue(g.timezone).onChange((v) => { g.timezone = v.trim() || g.timezone; void p.saveSettings(); }));
    new Setting(av).setName(t("gcal_statusbar")).addToggle((tg) =>
      tg.setValue(g.showStatusBar).onChange((v) => { g.showStatusBar = v; void p.saveSettings(); p.refreshGCalStatusBar(); }));
    boolRow("gcal_notify_conflicts", () => g.notifyConflicts, (v) => (g.notifyConflicts = v));
  }

  /**
   * „Termine anzeigen" (read-only). Getrennt vom Sync-Schalter: „nur anzeigen, nichts schreiben" ist
   * ein vollwertiger Zustand. Kalenderliste – Farbpunkt links, Auge rechts (statt
   * Häkchen). Der eigene Opal Tasks-Sync-Kalender taucht gar nicht erst auf (gcalFeed filtert ihn).
   */
  private renderGCalFeed(containerEl: HTMLElement, redraw: () => void): void {
    const p = this.plugin;
    const gf = p.settings.gcalFeed!;
    const feed = p.gcalFeed;

    new Setting(containerEl).setName(t("gcalfeed_show")).setDesc(t("gcalfeed_show_desc")).setHeading()
      .addToggle((tg) => tg.setValue(gf.enabled).onChange(async (v) => {
        gf.enabled = v;
        await p.saveSettings();
        if (v) {
          await feed.initDefaults();        // erstes Einschalten: primären Kalender vorwählen
          // Und gleich holen. `renderMain()` allein reicht NICHT: Die Ansichten haben ihre Monate
          // schon gemeldet, als der Feed noch aus war (setRange läuft unabhängig davon), und
          // setRange stößt nur bei NEUEN Monaten einen Abruf an. Ohne diese Zeile bliebe der
          // Kalender bis zum nächsten Poll leer – bis zu fünf Minuten nach dem Einschalten.
          void feed.refresh();
        } else await feed.clear();          // aus: Speicher + Snapshot leeren
        p.renderMain();
        redraw();                           // Abschnitt neu zeichnen (Kalenderliste ein-/ausblenden)
      }));

    if (!gf.enabled) return;

    // Kalenderliste (async). Farbpunkt links + Auge rechts (statt Häkchen); Klick blendet ein/aus.
    const listHost = containerEl.createDiv({ cls: "bt-gcalfeed-list" });
    void (async () => {
      let cals: CalendarInfo[] = [];
      try { cals = await feed.calendarList(); }
      catch { listHost.createDiv({ cls: "setting-item-description", text: t("gcalfeed_offline") }); return; }
      for (const c of cals) {
        const row = new Setting(listHost).setName(c.summary);
        const dot = createSpan({ cls: "bt-gcalfeed-dot" });
        if (c.backgroundColor) dot.style.backgroundColor = c.backgroundColor;
        row.nameEl.prepend(dot);
        row.addExtraButton((b) => {
          const paint = (): void => { b.setIcon(gf.calendars[c.id] ? "eye" : "eye-off")
            .setTooltip(gf.calendars[c.id] ? t("gcalfeed_hide_cal") : t("gcalfeed_show_cal")); };
          paint();
          b.onClick(async () => {
            await feed.setCalendarVisible(c.id, !gf.calendars[c.id]);
            paint();
            p.renderMain();
          });
        });
      }
    })();

    new Setting(containerEl).setName(t("gcalfeed_hide_declined"))
      .addToggle((tg) => tg.setValue(gf.hideDeclined).onChange(async (v) => {
        gf.hideDeclined = v; await p.saveSettings(); await feed.refresh(); p.renderMain();
      }));

    const hidden = feed.hiddenEventCount();
    if (hidden) new Setting(containerEl)
      .setName(t("gcalfeed_hidden_events", hidden))
      .setDesc(t("gcalfeed_hidden_events_desc"))
      .addButton((button) => button.setButtonText(t("gcalfeed_restore_hidden")).onClick(async () => {
        await feed.restoreHiddenEvents(); p.renderMain(); redraw();
      }));

    // Vorschau-Horizont für „Demnächst". Kein feed.refresh() nötig: „Demnächst" meldet dem Feed
    // beim Zeichnen selbst den neuen Zeitraum (setRange) und lädt fehlende Monate nach.
    // Den Zahlenwert zeigt Obsidian von sich aus neben dem Regler (setDynamicTooltip ist veraltet).
    new Setting(containerEl).setName(t("gcalfeed_horizon")).setDesc(t("gcalfeed_horizon_desc"))
      .addSlider((sl) => sl.setLimits(1, 12, 1).setValue(gf.upcomingMonths)
        .onChange(async (v) => { gf.upcomingMonths = v; await p.saveSettings(); p.renderMain(); }));

    containerEl.createDiv({ cls: "setting-item-description bt-gcal-hint", text: t("gcalfeed_privacy_hint") });
  }

  /** Fläche wählen (Normale Eingabe · Schnelleingabe) und darunter deren drei Tier-Zonen zeichnen.
   *  Beide Flächen haben getrennte Profile (chipProfiles). */
  private renderChipActions(containerEl: HTMLElement): void {
    const p = this.plugin;
    const SURFACES: ChipSurface[] = ["editor", "quickAdd"];
    let surface: ChipSurface = "editor";
    // Kopfzeile: Flächen-Tabs links, „Auf Standard zurücksetzen" (aktuelle Fläche) rechts.
    const bar = containerEl.createDiv({ cls: "bt-chip-surface-bar" });
    const tabs = bar.createDiv({ cls: "bt-chip-surface-tabs" });
    // Reset als Icon (rotate-ccw), einheitlich zu den anderen Reset-Buttons.
    const reset = bar.createEl("button", { cls: "bt-chip-reset clickable-icon" });
    tip(reset, t("chip_reset_default"));
    setIcon(reset, "rotate-ccw");
    const zonesHost = containerEl.createDiv();
    const drawTabs = (): void => {
      tabs.empty();
      for (const s of SURFACES) {
        const b = tabs.createEl("button", { cls: "bt-chip-surface-tab" + (s === surface ? " is-active" : ""), text: t(s === "editor" ? "chip_surface_editor" : "chip_surface_quickadd") });
        b.onclick = () => { if (s === surface) return; surface = s; drawTabs(); this.renderChipZones(zonesHost, surface); };
      }
    };
    // Zurücksetzen: gespeichertes Profil der AKTUELLEN Fläche entfernen -> Ersteinrichtungs-Default greift.
    reset.onclick = async () => {
      if (p.settings.chipProfiles) delete p.settings.chipProfiles[surface];
      await p.saveSettings();
      this.renderChipZones(zonesHost, surface);
    };
    drawTabs();
    this.renderChipZones(zonesHost, surface);
  }

  /** Drei Tier-Zonen (Immer anzeigen · Bei Wert anzeigen · Immer im +-Menü) für EINE Fläche. Jede
   *  Chip-Zeile lässt sich per Griff zwischen den Zonen ziehen; Ablegen persistiert das Profil. */
  private renderChipZones(containerEl: HTMLElement, surface: ChipSurface): void {
    const p = this.plugin;
    containerEl.empty();   // beim Flächen-Wechsel neu aufbauen
    const wrap = containerEl.createDiv({ cls: "bt-chip-zones" });
    const zones: HTMLElement[] = [];

    // Speichert die aktuelle DOM-Verteilung ins Profil der Fläche (Zone = Tier, Reihenfolge = order).
    const persist = (): void => {
      const order: ChipId[] = [];
      const tiers: Partial<Record<ChipId, ChipTier>> = {};
      for (const z of zones) {
        const tier = z.getAttr("data-tier") as ChipTier;
        for (const r of Array.from(z.children) as HTMLElement[]) {
          const id = r.getAttr("data-id") as ChipId | null;
          if (!id) continue;
          order.push(id); tiers[id] = tier;
        }
      }
      const profiles = p.settings.chipProfiles ?? {};
      profiles[surface] = { order, tiers };
      p.settings.chipProfiles = profiles;
      void p.saveSettings();
    };

    for (const tier of CHIP_TIERS) {
      const block = wrap.createDiv({ cls: "bt-chip-zone-block" });
      block.createDiv({ cls: "bt-chip-zone-title", text: t("chip_tier_" + tier) });
      const zone = block.createDiv({ cls: "bt-chip-zone", attr: { "data-tier": tier } });
      zones.push(zone);
    }

    for (const id of resolveChipOrder(p.settings, surface)) {
      const c = CHIPS[id];
      const zone = zones[CHIP_TIERS.indexOf(chipTierOf(p.settings, surface, id))];
      const row = zone.createDiv({ cls: "bt-chip-row", attr: { "data-id": id } });
      const grip = row.createSpan({ cls: "bt-chip-grip" });
      tip(grip, t("menu_reorder"));
      setIcon(grip, "grip-vertical");
      setIcon(row.createSpan({ cls: "bt-chip-row-ic" }), c.icon);
      row.createSpan({ cls: "bt-chip-row-lbl", text: t(c.nameKey) });
      attachChipDrag(row, grip, zones, persist);
    }
  }
}
