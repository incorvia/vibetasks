import { Modal, TFile, Notice, setIcon, Platform, HoverPopover } from "obsidian";
import type OpalTasksPlugin from "./main";
import { Task, TaskStatus } from "./types";
import { createTaskNote, listProjectsAndAreas, knownProjectNames, createProjectRecord, todayIso, ensureCanonicalFm, isInboxLink, copyTaskLink, TaskFields, baseName, EditScope, newlyIntroducedLabels, relationshipId, canonicalRelationshipId, legacyRelationshipLink, OPAL_PROJECT_ID, OPAL_PARENT_ID } from "./taskService";
import { formatDateTime, combineDT } from "./format";
import { openPopover, popRow } from "./popover";
import { applyQuickEntry, emptyQuickEntryState, escapeTriggers, QuickEntryState } from "./quickEntry";
import { readLog } from "./detailLog";
import { DetailLogView } from "./detailLogView";
import { SubtaskList } from "./subtaskList";
import { ConfirmModal } from "./confirmModal";
import { firstOpenStatus } from "./statuses";
import { labelKey } from "./fieldNames";
import { updateRecord } from "./mdbaseRepository";
import { CHIPS, ChipHost, ChipFields, chipsCompact, resolveChipOrder, isInline, plusHasSetHidden, renderPlusChips, renderStatusChip, renderValueChip, openChipSettings, PRIOS, PRIO_KEY } from "./chips";
import { t, projectDisplayName } from "./i18n";
import { tip } from "./tooltip";
import { attachLinkSuggest } from "./linkSuggest";
import { TimeBlockModal } from "./timeBlockModal";
import { isCompactPane } from "./responsive";

// PRIOS/PRIO_KEY leben jetzt in chips.ts (gemeinsam mit der Schnelleingabe); hier re-exportiert,
// damit bestehende Importe (filterModal, quickAddModal) unverändert bleiben.
export { PRIOS, PRIO_KEY };


/** Wie viele Aufgaben-Modale gerade offen sind. Seit Unteraufgaben SICH ÜBER ihr Elternmodal
 *  legen (statt es zu schließen), können es mehrere sein – dann darf das oberste beim Schließen
 *  die body-Klasse nicht dem darunterliegenden wegnehmen. Ein Zähler statt eines Schalters. */
let openModals = 0;
/** Mobile Obsidian can mount modal chrome outside both exposed modal elements. A body-level state
 *  is therefore the only reliable CSS scope for suppressing its redundant close control. */

/** Aufgaben-Modal (randloser Titel, Chip-Reihe, Projekt-Picker, CTA).
 *  Erfasst neu oder bearbeitet/verschiebt eine bestehende Aufgabe. */
export class TaskModal extends Modal {
  private f: TaskFields & { recurrence?: string | null; reminders: string[] };
  private chipBar!: HTMLElement;
  private descInput: HTMLTextAreaElement | null = null;
  private projektBtn!: HTMLButtonElement;
  private projectOpenBtn!: HTMLButtonElement;
  private titleInput!: HTMLInputElement;   // fuer unparseDue: Auslöser im Titel escapen
  private detailsWrap!: HTMLElement;
  hoverPopover: HoverPopover | null = null;   // macht das Modal zum HoverParent (native „Seitenvorschau")
  private logWrap!: HTMLElement;
  private detailsChip?: HTMLElement;   // Büroklammer-Chip, der die Detail-Sektion toggelt
  private log!: DetailLogView;         // Kommentar-Log (gemeinsame Komponente)
  private subs!: SubtaskList;          // Unteraufgaben-Sektion (über dem Kommentar-Log)
  private subsWrap!: HTMLElement;
  private duePinned = false;          // true sobald Datum manuell gesetzt -> NL überschreibt nicht mehr
  private cleanTitle = "";            // Titel ohne erkannte Datum-/Label-Token
  private nl: QuickEntryState = emptyQuickEntryState();  // aus dem Titel Erkanntes (trennt es von Manuellem)
  /** Aufgaben des Vaults oder eine Vorlage (s. EditScope). Wird an JEDES Kindmodal und an die
   *  Unteraufgaben-Sektion weitergereicht – wer eine Vorlage bearbeitet, bleibt beim Aufklappen
   *  einer Unteraufgabe in der Vorlage. */
  private editScopeCache?: EditScope;
  /** Der Geltungsbereich ist über die Lebensdauer des Modals konstant. Als reiner Getter legte er
   *  bei JEDEM Zugriff ein neues Objekt an – die Unteraufgaben-Sektion fragt ihn sechsmal, davon
   *  einmal in `signature()`, das bei jeder Index-Meldung läuft. */
  private get editScope(): EditScope { return (this.editScopeCache ??= this.opts.scope ?? { index: this.plugin.index }); }
  private discarding = false;          // true = bewusst verwerfen („Cancel") -> kein Auto-Speichern
  private persisted = false;           // true sobald geschrieben -> kein Doppel-Speichern
  /** In Dashboard-Listen lebt derselbe Editor direkt unter der angeklickten Zeile. Der Modal-
   *  Unterbau bleibt dabei absichtlich derselbe, damit Chips, Unteraufgaben und Kommentare nicht
   *  in einer zweiten, langsam auseinanderlaufenden Editor-Implementierung landen. */
  private inline = false;
  private inlineClosed = false;
  private inlineDone: (() => void) | null = null;
  private inlineKeydown: ((e: KeyboardEvent) => void) | null = null;
  private inlineOriginalTitle: HTMLElement | null = null;
  private inlineHost: HTMLElement | null = null;
  private inlineTitleRow: HTMLElement | null = null;
  private inlineOutside: ((e: PointerEvent) => void) | null = null;
  /** Keep the phone editor's keyboard affordance attached to the visual viewport (just above the
   *  software keyboard), even though the expanded editor itself remains inside the task list. */
  private mobileViewportCleanup: (() => void) | null = null;
  private compact = false;

  /** opts.hideProjekt blendet das Projekt-Chip aus (Unteraufgaben-Modus – die
   *  Unteraufgabe erbt Projekt der Hauptaufgabe). opts.parent = Eltern-Basename. */
  constructor(private plugin: OpalTasksPlugin, private existing?: Task, private defaultProject?: string,
              private opts: { hideProjekt?: boolean; parent?: string; parentId?: string; defaultLabel?: string; defaultToday?: boolean; defaultTitle?: string; defaultStatus?: TaskStatus; seed?: Partial<ChipFields> & { description?: string; projectId?: string | null }; openDetails?: boolean; duePinned?: boolean; stacked?: boolean; scope?: EditScope; insertBefore?: { parentPath: string | null; beforePath: string | null } } = {}) {
    super(plugin.app);
    const seed = opts.seed;
    this.f = existing
      ? {
          title: existing.title, status: existing.status, due: existing.due, dueTime: existing.dueTime,
          estimate: existing.estimate,
          priority: existing.priority, recurrence: existing.recurrence, recurBasis: existing.recurBasis,
          project: existing.project ? baseName(existing.project) : null,
          projectId: existing.projectId,
          parent: existing.parent ? baseName(existing.parent) : null,
          parentId: existing.parentId,
          labels: [...existing.labels],
          reminders: [...(existing.reminders ?? [])],
          description: existing.description,   // aus dem Frontmatter (kein Body-Read mehr nötig)
        }
      // Neu: Basis + optionaler Seed (z. B. aus der Schnelleingabe, ⤢ „Voller Editor" – übernimmt
      // alle bereits gesetzten Chips). Explizit, damit reminders sicher string[] bleibt.
      : {
          title: opts.defaultTitle ?? "",
          status: seed?.status ?? opts.defaultStatus,
          priority: seed?.priority ?? "normal",
          labels: seed?.labels ? [...seed.labels] : (opts.defaultLabel ? [opts.defaultLabel] : []),
          reminders: seed?.reminders ? [...seed.reminders] : [],
          due: seed?.due ?? (opts.defaultToday ? todayIso() : null),
          dueTime: seed?.dueTime ?? null, estimate: seed?.estimate ?? null,
          recurrence: seed?.recurrence ?? null, recurBasis: seed?.recurBasis ?? "due",
          parent: seed?.parent ?? opts.parent ?? null, parentId: seed?.parentId ?? opts.parentId ?? null, description: seed?.description,
          project: defaultProject ?? null, projectId: seed?.projectId ?? relationshipId(this.app, defaultProject, ["project", "area"]),
        };
    if (opts.duePinned) this.duePinned = true;   // aus der Schnelleingabe übernommen (⤢)
  }

  /** Den vollwertigen Editor ohne Overlay in einen Listen-/Karten-Slot einhängen. Quick Add und
   *  Aufrufe ohne sichtbare Zeile benutzen weiterhin Modal.open(). */
  openInline(host: HTMLElement, done: () => void, titleRow?: HTMLElement): void {
    if (this.inline || this.inlineClosed) return;
    this.inline = true;
    this.inlineDone = done;
    this.inlineHost = host;
    this.inlineTitleRow = titleRow ?? null;
    this.shouldRestoreSelection = false;
    // Erst den gemeinsamen Editor-Inhalt aufbauen, dann NUR `.modal-content` in die Liste
    // verschieben. Der native Modal-Rahmen bleibt unverbunden; damit können dessen Schließer,
    // Positionierung und Theme-Chrome nicht in der Inline-Fläche auftauchen.
    this.onOpen();
    host.addClasses(["bt-task-modal", "bt-inline-editor"]);
    host.toggleClass("bt-inline-mobile", this.compact);
    host.toggleClass("bt-chips-icons-only", chipsCompact(this.plugin.settings));
    host.appendChild(this.contentEl);
    // Beim Bearbeiten wird nicht eine zweite Titelzeile unter die Aufgabe gesetzt: Das sichtbare
    // Listentitel-Element selbst wird durch das echte Eingabefeld ersetzt. So wird aus der Zeile
    // der Kopf des Editors, statt dass darunter ein Dialog-Duplikat aufspringt.
    const shownTitle = titleRow?.querySelector<HTMLElement>(":scope > .bt-body > .bt-title");
    if (shownTitle) {
      this.inlineOriginalTitle = shownTitle;
      this.titleInput.addClass("bt-inline-row-title");
      this.titleInput.onclick = (e) => e.stopPropagation();
      shownTitle.replaceWith(this.titleInput);
    }
    this.inlineKeydown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault(); e.stopPropagation(); this.close();
    };
    this.contentEl.addEventListener("keydown", this.inlineKeydown);
    // Wie Things: Außerhalb weiterarbeiten klappt den Editor zu und speichert über denselben
    // onClose-Weg wie Escape. Schwebende Bedienflächen des Editors zählen semantisch als innen,
    // obwohl Obsidian sie am Dokument-Body statt im Editor-DOM einhängt.
    this.inlineOutside = (e: PointerEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target || this.inlineHost?.contains(target) || this.inlineTitleRow?.contains(target)) return;
      if (target.closest(".bt-pop, .menu, .suggestion-container, .modal-container, .popover")) return;
      this.close();
    };
    // Erst nach der auslösenden Klick-Geste registrieren; sonst würde genau der Klick, der den
    // Editor öffnet, ihn im selben Durchlauf wieder schließen.
    window.setTimeout(() => {
      if (!this.inlineClosed && this.inlineOutside) host.ownerDocument.addEventListener("pointerdown", this.inlineOutside, true);
    }, 0);
  }

  /** Erneuter Klick auf die bereits offene Zeile setzt den Cursor wieder in den Titel. Auf dem
   *  Telefon verhindern wir dabei das verfruehte Browser-Scrolling gegen den noch geschlossenen
   *  Tastatur-Viewport; `watchMobileViewport` setzt die Zeile nach dessen Resize an die richtige
   *  Stelle. */
  focusTitle(): void {
    if (!this.titleInput) return;
    this.titleInput.focus({ preventScroll: this.inline && this.compact });
    if (this.inline && this.compact) window.requestAnimationFrame(() => this.anchorTitleInViewport());
  }

  close(): void {
    if (!this.inline) { super.close(); return; }
    if (this.inlineClosed) return;
    this.inlineClosed = true;
    if (this.inlineKeydown) this.contentEl.removeEventListener("keydown", this.inlineKeydown);
    if (this.inlineOutside) this.inlineHost?.ownerDocument.removeEventListener("pointerdown", this.inlineOutside, true);
    this.inlineOutside = null;
    if (this.inlineOriginalTitle && this.titleInput.isConnected) this.titleInput.replaceWith(this.inlineOriginalTitle);
    this.onClose();
    this.modalEl.remove();
    const done = this.inlineDone; this.inlineDone = null; done?.();
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("bt-task-modal");
    const compact = isCompactPane(document.documentElement);
    this.compact = compact;
    modalEl.toggleClass("bt-mobile", compact);
    // Klasse auf <body>, solange dieses Modal offen ist: hebt die native „Seitenvorschau" per CSS
    // über das Modal (sonst erschiene sie dahinter). Bewusst eine feste Klasse statt body:has(...) –
    // die :has-Auswertung kann einen Frame nachhinken, wodurch die Vorschau beim Hovern kurz
    // hinter dem Modal aufblitzt und dann nach vorne springt (das gemeldete Ruckeln).
    if (!this.inline) {
      openModals++;
      document.body.addClass("bt-task-modal-open");
    }
    modalEl.toggleClass("bt-chips-icons-only", chipsCompact(this.plugin.settings));   // nur Chip-Icons (auf Mobile immer)
    contentEl.empty();

    // Gegenrichtung zur Unteraufgaben-Sektion: Wer eine Unteraufgabe öffnet, sieht ganz oben,
    // zu welcher Hauptaufgabe sie gehört – und kommt mit einem Klick dorthin.
    this.renderParentCrumb(contentEl);

    const placeholder = this.opts.parent ? t("placeholder_subtask") : t("placeholder_taskname");
    const title = contentEl.createEl("input", { type: "text", cls: "bt-titel", attr: { placeholder } });
    this.titleInput = title;
    title.value = this.f.title;
    title.oninput = () => {
      this.f.title = title.value;
      this.applyParse();
      this.renderChips();
      // Der Projekt-Wähler unten links gehört mit nachgezogen: @Projekt setzt das Feld,
      // und eine Änderung, die man nicht sieht, wäre schlimmer als gar keine Erkennung.
      if (!this.opts.hideProjekt) this.renderProjekt();
    };
    title.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void this.save(); } };
    if (compact) {
      const dismissKeyboard = (this.inlineHost ?? modalEl).createEl("button", {
        cls: "bt-keyboard-dismiss",
        attr: { type: "button", "aria-label": "Dismiss keyboard" },
      });
      setIcon(dismissKeyboard.createSpan({ cls: "bt-keyboard-dismiss-key" }), "keyboard");
      setIcon(dismissKeyboard.createSpan({ cls: "bt-keyboard-dismiss-arrow" }), "chevron-down");
      dismissKeyboard.onclick = (e) => {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
      };
      this.watchMobileViewport(dismissKeyboard);
    }
    window.setTimeout(() => this.focusTitle(), 0);

    // Beschreibung: kurzer Zusatztext im FRONTMATTER (`description`) – die einzeilige Vorschau
    // auf der Karte. Der Notiz-Body ist etwas anderes und hängt weiter unten als „Notizen".
    const desc = contentEl.createEl("textarea", { cls: "bt-beschr", attr: { placeholder: t("placeholder_description"), rows: "1" } });
    desc.value = this.f.description ?? "";
    desc.oninput = () => { this.f.description = desc.value; this.growDesc(); };
    // „[[" schlaegt Notizen vor. Der Quellpfad kommt aus derselben Quelle wie beim Kommentar-Log:
    // eine neue Aufgabe hat noch keine Notiz, logSrc() liefert dann einen Platzhalter.
    attachLinkSuggest(desc, this.plugin, () => this.logSrc());
    this.descInput = desc;
    window.setTimeout(() => this.growDesc(), 0);

    this.chipBar = contentEl.createDiv({ cls: "bt-chips" });

    // Details = Kommentar-Log (Timeline), einklappbar. Öffnen/Schließen jetzt über den
    // Büroklammer-Chip in der Chip-Leiste (statt der früheren "+ Details"-Zeile). Der Log
    // lebt im Body der Aufgaben-Notiz. Vor renderChips() anlegen, damit der Details-Chip
    // seinen Offen/Zu-Zustand aus logWrap lesen kann.
    // Unteraufgaben sind STRUKTUR der Aufgabe, keine Beilage: eigene Sektion auf Titel-Ebene,
    // immer sichtbar, NICHT hinter dem Details-Chip. Die Büroklammer bedeutet im ganzen Plugin
    // „Kommentare/Anhänge" (siehe die Zeilen-Indikatoren in heuteView) – sie darf nicht zugleich
    // der einzige Weg zu den Unteraufgaben sein.
    this.subsWrap = contentEl.createDiv({ cls: "bt-st" });
    // Detailbereich = Kommentare + Notiz-Link. Das ist es, was der Details-Chip schaltet.
    this.detailsWrap = contentEl.createDiv({ cls: "bt-details" });

    this.logWrap = this.detailsWrap.createDiv({ cls: "bt-log bt-hidden" });
    this.log = new DetailLogView(this.app, this.plugin, {
      srcPath: () => this.logSrc(),
      file: () => this.existingFile(),
      reveal: () => { this.logWrap.removeClass("bt-hidden"); this.syncDetails(); },
      close: () => this.close(),
      headAction: (head) => this.renderNotesLink(head),
    });

    this.subs = new SubtaskList(this.plugin, {
      parent: () => this.existing ?? null,
      projectBase: () => this.f.project ?? null,
      // Elternmodal bleibt bewusst OFFEN: Das Kind legt sich darüber, und wer es schließt
      // (Speichern, Abbrechen, Esc), landet wieder hier statt in der Liste. Die Sektion hängt
      // am Index und zeigt die Änderung sofort.
      openTask: (task) => new TaskModal(this.plugin, task, undefined, { stacked: true, scope: this.opts.scope }).open(),
      openFullEditor: (title) => this.openSubtaskEditor(title),
      scope: () => this.editScope,
    });

    this.applyParse();
    this.renderChips();
    this.subs.mount(this.subsWrap);
    this.log.mount(this.logWrap);
    this.syncDetails();
    // Bestehende Aufgabe: Log aus dem Notiz-Body laden, bei Inhalt direkt aufgeklappt.
    // (Die Beschreibung kommt bereits aus dem Frontmatter über this.f.description.)
    if (this.existing) {
      const file = this.app.vault.getAbstractFileByPath(this.existing.path);
      if (file instanceof TFile) {
        void readLog(this.app, file).then((entries) => {
          this.log.setEntries(entries);
          if (entries.length) this.logWrap.removeClass("bt-hidden");
          this.log.render();
          this.syncDetails();
        });
      }
    }
    // Aus der Schnelleingabe über den Details-Chip geöffnet: Detailbereich direkt aufklappen.
    if (this.opts.openDetails) {
      this.logWrap.removeClass("bt-hidden");
      this.syncDetails();
      window.setTimeout(() => this.log.focusComposer(), 0);
    }

    // Fußzeile: Projekt-Picker links, Buttons rechts. Im Unteraufgaben-Modus
    // (hideProjekt) entfällt der Projekt-Picker – das Projekt erbt die Hauptaufgabe.
    const foot = contentEl.createDiv({ cls: "bt-foot" });
    if (!this.opts.hideProjekt) {
      const projectActions = foot.createDiv({ cls: "bt-project-actions" });
      this.projektBtn = projectActions.createEl("button", { cls: "bt-projekt" });
      this.projektBtn.onclick = (e) => this.openProject(e.currentTarget as HTMLElement);
      this.projectOpenBtn = projectActions.createEl("button", { cls: "bt-project-open" });
      tip(this.projectOpenBtn, t("open_assigned_project"));
      setIcon(this.projectOpenBtn, "arrow-up-right");
      this.projectOpenBtn.onclick = () => {
        const selected = this.selectedProject();
        if (!selected) return;
        this.close();
        void this.plugin.activateProject(selected.path);
      };
      this.renderProjekt();
    } else {
      foot.createDiv();   // Platzhalter links, damit die Buttons rechts bleiben
    }

    const actions = foot.createDiv({ cls: "bt-actions" });
    if (this.existing) {
      const schedule = this.plugin.scheduling.getTaskSchedule(this.existing.id);
      const scheduleButton = actions.createEl("button", { attr: { "aria-label": schedule ? "Edit task schedule" : "Schedule task" } });
      setIcon(scheduleButton, "calendar-clock");
      tip(scheduleButton, schedule ? `Scheduled ${new Date(schedule.start).toLocaleString()} · ${schedule.duration}m` : "Schedule task");
      scheduleButton.onclick = () => new TimeBlockModal(this.plugin, schedule ? new Date(schedule.start) : new Date(),
        { type: "task", id: this.existing!.id, title_snapshot: this.existing!.title }, schedule ?? undefined, "task_schedule").open();
      const timer = actions.createEl("button", { attr: { "aria-label": "Start timer" } });
      const active = this.plugin.workTimer.active(); setIcon(timer, active?.task_id === this.existing.id ? "square" : "play");
      timer.onclick = () => active?.task_id === this.existing!.id
        ? void this.plugin.stopTaskTimer()
        : void this.plugin.startTaskTimer(this.existing!);
    }
    const cancel = actions.createEl("button", { text: t("btn_cancel") });
    cancel.onclick = () => { this.discarding = true; this.close(); };
    const submit = actions.createEl("button", { cls: "mod-cta", text: this.existing ? t("btn_save") : t("btn_add_task") });
    submit.onclick = () => void this.save();
  }

  onClose(): void {
    this.mobileViewportCleanup?.();
    this.mobileViewportCleanup = null;
    // Auto-Speichern beim Wegklicken / Esc / X (nur mit Titel). „Cancel" verwirft bewusst.
    // persist() ist gegen Doppel-Schreiben geschützt (this.persisted) und braucht kein DOM.
    if (!this.discarding) {
      // Nicht bestätigte Entwürfe ZUERST: Wer eine Unteraufgabe oder einen Kommentar tippt und
      // dann „Speichern" drückt statt Enter, erwartet nicht, dass sein Text verschwindet. Vor
      // persist(), damit eine noch nicht angelegte Aufgabe den Kommentar beim Anlegen mitschreibt.
      this.subs?.flushDraft();
      this.log?.flushDraft();
      void this.persist();
    }
    this.subs?.unload();
    this.log?.unload();
    // Erst wenn das LETZTE Aufgaben-Modal weg ist – sonst verlöre ein noch offenes
    // Elternmodal die Klasse und seine Seitenvorschau erschiene wieder hinter dem Modal.
    if (!this.inline && --openModals <= 0) { openModals = 0; document.body.removeClass("bt-task-modal-open"); }
    this.contentEl.empty();
  }

  /** Follow iOS/Android's visual viewport while a text field is active. CSS fixed positioning is
   *  relative to the layout viewport in some WebViews, so the measured keyboard inset is exposed
   *  as a custom property and moves the dismiss control to the keyboard's upper edge. */
  private watchMobileViewport(button: HTMLElement): void {
    const viewport = window.visualViewport;
    // Inline lebt der Knopf nicht im (abgehaengten) modalEl, sondern im Listen-Slot. Die Variable
    // muss deshalb auf genau dem Element liegen, von dem der Knopf sie auch erben kann.
    const viewportHost = this.inlineHost ?? this.modalEl;
    let frame = 0;
    let settleTimer = 0;
    const update = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        const textFocused = !!active?.matches("input, textarea, [contenteditable='true']");
        const keyboardInset = viewport
          ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
          : 0;
        viewportHost.style.setProperty("--bt-keyboard-inset", `${keyboardInset}px`);
        viewportHost.toggleClass("bt-keyboard-open", textFocused);
        button.toggleClass("is-visible", textFocused);
        // Autofocus runs before iOS/Android has finished opening the software keyboard. Its later
        // visualViewport resize can leave the inline title above the newly visible area. Re-anchor
        // only while the title itself owns focus, so scrolling through the rest of the form remains
        // entirely under the user's control.
        if (active === this.titleInput) {
          this.anchorTitleInViewport();
          // Mobile WebViews may apply one last native focus-scroll *after* reporting the keyboard's
          // final viewport size. Correct that late movement once the animation/events go quiet.
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => {
            if (document.activeElement === this.titleInput) this.anchorTitleInViewport();
          }, 180);
        }
      });
    };
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    this.mobileViewportCleanup = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      viewportHost.removeClass("bt-keyboard-open");
      viewportHost.style.removeProperty("--bt-keyboard-inset");
    };
  }

  /** Put the inline editor's top border directly below the sticky page header inside the *current
   *  visual* viewport. Anchoring the input itself is subtly wrong: the card begins a few pixels
   *  above it, and mobile focus scrolling can consequently leave that edge clipped. */
  private anchorTitleInViewport(): void {
    if (!this.inline || !this.compact || !this.titleInput?.isConnected) return;
    // WebKit can retain/apply a small scroll offset on the transplanted modal-content itself
    // during a repeated focus cycle. It is not meant to scroll in inline mode; letting that offset
    // survive clips the first input while the outer card remains correctly positioned.
    this.contentEl.scrollTop = 0;
    const scroller = this.titleInput.closest<HTMLElement>(".bt-view");
    const anchor = this.inlineTitleRow ?? this.inlineHost ?? this.titleInput;
    if (!scroller) { anchor.scrollIntoView({ block: "start", inline: "nearest" }); return; }

    const visualTop = window.visualViewport?.offsetTop ?? 0;
    const stickyHeader = scroller.querySelector<HTMLElement>(":scope > .bt-page-top");
    const headerBottom = stickyHeader?.getBoundingClientRect().bottom ?? visualTop;
    const desiredTop = Math.max(visualTop, headerBottom) + 12;
    const delta = anchor.getBoundingClientRect().top - desiredTop;
    if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior: "auto" });
  }

  /** Beschreibungs-Textarea an ihren Inhalt anpassen (Auto-Grow, gedeckelt). */
  private growDesc(): void {
    const el = this.descInput; if (!el) return;
    el.setCssStyles({ height: "auto" });
    el.setCssStyles({ height: Math.min(el.scrollHeight, 200) + "px" });
  }

  /** Breadcrumb über dem Titel: „↰ Hauptaufgabe". Nur bei einer Unteraufgabe, deren Eltern-
   *  Aufgabe noch existiert. Klick wechselt in deren Modal – der aktuelle Stand wird dabei
   *  wie beim normalen Schließen gespeichert. */
  private renderParentCrumb(contentEl: HTMLElement): void {
    const parent = this.existing ? this.parentTask() : null;
    if (!parent) return;
    const crumb = contentEl.createDiv({ cls: "bt-parent-crumb", attr: { role: "button", tabindex: "0" } });
    tip(crumb, t("menu_goto_parent") + ": " + parent.title);
    setIcon(crumb.createSpan({ cls: "bt-parent-ic" }), "corner-left-up");
    crumb.createSpan({ cls: "bt-parent-lbl", text: parent.title });
    const open = (): void => {
      this.close();
      // Gestapelt liegt das Elternmodal bereits darunter und kommt durchs Schließen von selbst
      // zum Vorschein – es erneut zu öffnen ergäbe zwei Modale derselben Aufgabe.
      if (!this.opts.stacked) this.plugin.openEditTask(parent);
    };
    crumb.onclick = open;
    crumb.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  }

  /** „Aufgabennotiz bearbeiten" – rechts in der Kommentar-Kopfzeile, an derselben Stelle und
   *  im selben Stil (.bt-sec-act) wie „Erledigte ausblenden" bei den Unteraufgaben. Hover zeigt
   *  Obsidians native „Seitenvorschau" der Notiz, Klick/Tab öffnet sie voll im Editor. Das Modal
   *  ist dabei der HoverParent (hoverPopover-Feld). Bearbeitet wird ausschließlich dort – kein
   *  eigenes Feld. `targetEl` ist bewusst der kompakte Button (nicht die ganze Zeile): Obsidian
   *  richtet die Vorschau daran aus, sonst landet sie am linken Rand weit weg davon.
   *  Nur bei bestehenden Aufgaben – eine neue Notiz existiert beim Erfassen noch nicht. */
  private renderNotesLink(head: HTMLElement): void {
    const file = this.existing && this.app.vault.getAbstractFileByPath(this.existing.path);
    if (!(file instanceof TFile)) return;
    const btn = head.createSpan({ cls: "bt-sec-act bt-notes-edit", attr: { role: "button", tabindex: "0" } });
    setIcon(btn.createSpan({ cls: "bt-notes-edit-ic" }), "chevron-down");   // links vor dem Text
    btn.createSpan({ cls: "bt-notes-edit-lbl", text: t("notes_edit") });
    // mouseENTER, nicht mouseover: mouseover feuert bei jedem Wechsel über die Kind-Spans
    // (Icon/Label) und beim Wiedereintritt erneut -> jeder Aufruf baut die Vorschau neu auf
    // (das Ruckeln). mouseenter feuert genau EINMAL beim Betreten und ignoriert die Kinder.
    btn.addEventListener("mouseenter", (e) => {
      this.app.workspace.trigger("hover-link", {
        event: e, source: "opal_tasks", hoverParent: this, targetEl: btn, linktext: file.path, sourcePath: file.path,
      });
    });
    const open = (): void => { void this.app.workspace.getLeaf("tab").openFile(file); this.close(); };
    btn.onclick = open;
    btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  }

  /** Natural-Language: Datum, #Labels und @Projekt aus dem Titel erkennen und übernehmen.
   *  Datum nur, solange nicht manuell gesetzt; Labels werden ergänzt. */
  private applyParse(): void {
    const previousProject = this.f.project;
    const r = applyQuickEntry(this.f.title, {
      due: this.f.due ?? null, dueTime: this.f.dueTime ?? null, priority: this.f.priority ?? "normal",
      labels: this.f.labels ?? [], project: this.f.project ?? null,
      recurrence: this.f.recurrence ?? null,
    }, this.nl, {
      enabled: this.plugin.settings.parseNaturalLanguage,
      // Bestehende Aufgabe: der gespeicherte Titel ist Text, kein Befehl. Er wurde bei der Erfassung
      // bereits geparst – ein zweiter Lauf läse „heute" erneut als Datum und löschte das Wort aus
      // dem Titel (beim Schließen wird automatisch gespeichert). Betrifft jeden Titel mit
      // Auslöserwort: per `\heute` geschützt, importiert oder von Hand geschrieben.
      frozen: !!this.existing,
      duePinned: this.duePinned,
      today: todayIso(),
      // @Projekt erkennen wie in der Schnelleingabe. Dass es hier auch einen Projekt-Wähler gibt,
      // war lange der Grund, es NICHT zu tun – die Asymmetrie war aber teurer als die Redundanz:
      // Dieselbe Eingabe tat im einen Dialog etwas und blieb im anderen als Text stehen, die
      // Aufgabe hieß danach wörtlich „@familie" und lag im Eingang.
      //
      // NICHT im Unteraufgaben-Modus: Dort ist der Wähler bewusst verborgen, weil die
      // Unteraufgabe das Projekt der Hauptaufgabe erbt – ein @Projekt verstellte etwas,
      // das man gar nicht sieht.
      //
      // Bestehende Aufgaben sind ohnehin außen vor (frozen, s. oben): Ein alter Titel mit „@"
      // ist Text, kein Befehl.
      projects: this.opts.hideProjekt ? [] : knownProjectNames(this.app),
      // Fällt das @-Wort wieder aus dem Titel, gilt wieder das Projekt der Seite, aus der dieser
      // Dialog geöffnet wurde (nicht stur „Eingang").
      defaultProject: this.defaultProject ?? null,
    });
    this.cleanTitle = r.title;
    Object.assign(this.f, r.fields);
    if (this.f.project !== previousProject) this.f.projectId = relationshipId(this.app, this.f.project, ["project", "area"]);
    this.nl = r.state;
  }

  /** ✕ am Datums-Chip: den erkannten Auslöser im Titel escapen („morgen" -> „\morgen"), damit
   *  das Wort Text bleibt. false = nichts zu escapen (manuell gesetzt, bestehende Aufgabe oder
   *  Auslöser nicht auffindbar), dann leert der Chip wie bisher. */
  /** ✕ am Wiederholungs-Chip: erkannten Ausloeser im Titel escapen. Siehe unparseDue(). */
  private unparseRecur(): boolean {
    const next = escapeTriggers(this.f.title, [this.nl.recurSrc]);
    if (next === this.f.title) return false;
    this.f.title = next;
    this.titleInput.value = next;
    this.f.recurrence = null;
    this.applyParse();
    return true;
  }

  private unparseDue(): boolean {
    const next = escapeTriggers(this.f.title, [this.nl.dueSrc, this.nl.timeSrc]);
    if (next === this.f.title) return false;
    this.f.title = next;
    this.titleInput.value = next;
    // Der Wert kam aus dem Titel – escapen heisst: er ist weg. Erst leeren, dann neu parsen
    // (der escapte Text setzt nichts mehr). KEIN pinDue: das Escape im Titel IST der Zustand,
    // ein spaeter getipptes „uebermorgen" soll wieder erkannt werden.
    this.f.due = null; this.f.dueTime = null;
    this.applyParse();
    return true;
  }

  private unparseEstimate(): boolean {
    const next = escapeTriggers(this.f.title, [this.nl.estimateSrc]);
    if (next === this.f.title) return false;
    this.f.title = next; this.titleInput.value = next; this.f.estimate = null;
    this.applyParse(); return true;
  }

  // ── Chips ──
  /** Brücke Modal ⇄ Chip-Registry: Feldzustand + host-spezifische Callbacks. */
  private chipHost(): ChipHost {
    return {
      plugin: this.plugin,
      app: this.app,
      f: this.f,
      surface: "editor",
      rerender: () => this.renderChips(),
      compactLabels: false,
      iconsOnly: chipsCompact(this.plugin.settings),
      applyStatus: (s) => void this.applyStatus(s),
      // Manuell gesetzt/geleert: der Titel besitzt das Datum ab jetzt nicht mehr.
      pinDue: () => { this.duePinned = true; this.nl.dueSrc = ""; this.nl.timeSrc = ""; },
      unparseDue: () => this.unparseDue(),
      unparseEstimate: () => this.unparseEstimate(),
      unparseRecur: () => this.unparseRecur(),
      existingPath: this.existing?.path,
      onParentPicked: () => { if (!this.opts.hideProjekt) this.renderProjekt(); },
      toggleDetails: () => this.toggleDetails(),
      detailsOpen: () => !this.logWrap.hasClass("bt-hidden"),
      // Elternaufgaben-Chip im festen „+ Subtask"-Modus (opts.parent) ausblenden – Parent steht fest.
      chipEnabled: (id) => id === "parent" ? !this.opts.parent : true,
    };
  }

  private renderChips(): void {
    const bar = this.chipBar; bar.empty();
    const host = this.chipHost();
    const settings = this.plugin.settings;
    // Reihenfolge + Sichtbarkeit aus den Einstellungen (chipOrder/chipTiers): shown = immer,
    // onValue = nur mit Wert, hidden = nie (nur über „+"). Gesetzte Werte bleiben immer sichtbar.
    for (const id of resolveChipOrder(settings, host.surface)) {
      const c = CHIPS[id];
      if (host.chipEnabled && !host.chipEnabled(id)) continue;
      const set = c.isSet(this.f, host);
      if (!isInline(settings, host.surface, id, set)) continue;
      if (c.kind === "status") renderStatusChip(bar, host, c);
      else if (c.kind === "details") this.renderDetailsChip(bar);
      else renderValueChip(bar, host, c, set);
    }
    // „+"-Chip ganz rechts: „Weitere Aktionen" (ausgeblendete Chips) + (Edit) Aufgabenaktionen +
    // „Aufgabenaktionen bearbeiten". Immer sichtbar; has-set = Badge, wenn Ausgeblendete Werte tragen.
    const acts = bar.createEl("button", { cls: "bt-chip bt-chip-actions" + (plusHasSetHidden(host) ? " has-set" : "") });
    tip(acts, t("task_actions"));
    setIcon(acts.createSpan({ cls: "bt-chip-ic" }), "plus");
    acts.onclick = (e) => { e.stopPropagation(); this.openPlusMenu(acts); };
  }

  /** Details-Chip (Büroklammer): toggelt die Kommentar-/Detail-Sektion (is-open statt is-set). */
  private renderDetailsChip(bar: HTMLElement): void {
    const open = !this.logWrap.hasClass("bt-hidden");
    const chip = bar.createEl("button", { cls: "bt-chip bt-chip-details" + (open ? " is-open" : "") });
    if (chipsCompact(this.plugin.settings)) tip(chip, t("details"));
    const dIc = chip.createSpan({ cls: "bt-chip-ic" }); setIcon(dIc, "paperclip");
    chip.createSpan({ cls: "bt-chip-lbl", text: t("details") });
    // Bewusst KEIN Zähler am Chip: Der Detailbereich enthält nur noch Kommentare, und deren
    // Anzahl steht in der Sektionsüberschrift. Die Chip-Leiste ist die dichteste Zone des
    // Modals – eine Zahl, die zwei Zeilen tiefer nochmal steht, verdient dort keinen Platz.
    chip.onclick = (e) => { e.stopPropagation(); this.toggleDetails(); };
    this.detailsChip = chip;
  }

  /** „+"-Popover: „Weitere Aktionen" (ausgeblendete Chips, mit Umrandung + Wert-Vorschau),
   *  im Edit-Modus zusätzlich die Aufgabenaktionen; unten immer „Aufgabenaktionen bearbeiten". */
  private openPlusMenu(anchor: HTMLElement): void {
    const host = this.chipHost();
    openPopover(anchor, (pop, close) => {
      pop.addClass("bt-plus");
      const row = (icon: string, label: string, fn: () => void, danger = false): void => {
        const r = popRow(pop, icon, label, () => { close(); fn(); });
        if (danger) r.addClass("bt-row-danger");
      };
      let any = renderPlusChips(pop, host, anchor, close);
      if (this.existing) {
        if (any) pop.createDiv({ cls: "bt-plus-sep" });
        // Bewusst derselbe Schlüssel wie die Erfassungszeile (sub_add): Der Menüpunkt IST der
        // Weg zu genau dieser Zeile – zwei getrennte Strings würden über zehn Sprachen hinweg
        // frueher oder spaeter auseinanderlaufen.
        row("corner-down-right", t("sub_add"), () => this.addSubtask());
        // „Zur Elternaufgabe" springt in die LISTE und hebt die Zeile hervor. Vorlagen stehen in
      // keiner Liste – der Sprung liefe ins Leere, deshalb gibt es den Eintrag dort nicht.
      if (!this.opts.scope && this.parentTask()) row("corner-left-up", t("menu_goto_parent"), () => this.showParent());
        row("copy", t("menu_duplicate"), () => void this.duplicate());
        pop.createDiv({ cls: "bt-plus-sep" });
        row("link", t("menu_copy_link"), () => this.copyLink());
        row("file-text", t("menu_open_task_note"), () => this.openInObsidian());
        if (!Platform.isMobile) row("external-link", t("menu_open_editor"), () => this.openInEditor());
        if (!Platform.isMobile) { pop.createDiv({ cls: "bt-plus-sep" }); row("printer", t("menu_print"), () => this.printTask()); }
        pop.createDiv({ cls: "bt-plus-sep" });
        row("trash-2", t("btn_delete"), () => this.remove(), true);
        any = true;
      }
      if (any) pop.createDiv({ cls: "bt-plus-sep" });
      popRow(pop, "sliders-horizontal", t("edit_task_actions"), () => { close(); openChipSettings(this.app); });
    });
  }

  /** Aufgabe duplizieren: aktuellen Stand sichern und als neue Aufgabe („(Kopie)") anlegen.
   *  Der ganze Unterbaum kommt mit – jede Ebene re-parentet auf die frisch erzeugte Kopie. */
  private async duplicate(): Promise<void> {
    const title = this.titleValue();
    if (!title) { new Notice(t("err_enter_taskname")); return; }
    await this.persist();   // laufende Bearbeitung sichern, bevor kopiert wird
    const file = await createTaskNote(this.app, this.plugin.settings, {
      ...this.f, title: title + " " + t("copy_suffix"), status: firstOpenStatus(),
      titleInFrontmatter: this.existing?.titleInFm,   // Kopie hält es wie das Original
      parent: this.f.parent ?? this.opts.parent ?? null,
    }, this.editScope.target);
    await this.log.flush(file);
    // Unteraufgaben (rekursiv) mitkopieren, verankert an der neuen Hauptkopie –
    // die Rekursion lebt in main.ts (gemeinsam mit dem Zeilen-Kontextmenü).
    if (this.existing) {
      const rootId = (await this.plugin.repository.read(file.path))?.id ?? null;
      await this.plugin.duplicateSubtree(this.existing.path, file.basename, {
        target: this.editScope.target, from: this.editScope.index, newParentId: rootId,
      });
    }
    new Notice(t("msg_duplicated"));
    this.close();
  }

  /** Obsidian-Deeplink zur Aufgabe kopieren (gemeinsame Implementierung in taskService). */
  private copyLink(): void {
    if (this.existing) copyTaskLink(this.app, this.existing.path);
  }

  /** Aufgaben-Notiz in einem neuen Obsidian-Tab öffnen. */
  private openInObsidian(): void {
    if (!this.existing) return;
    const file = this.app.vault.getAbstractFileByPath(this.existing.path);
    if (file instanceof TFile) { void this.app.workspace.getLeaf("tab").openFile(file); this.close(); }
  }

  /** Aufgaben-Notiz im System-Standardeditor (externe App) öffnen. */
  private openInEditor(): void {
    if (!this.existing) return;
    (this.app as unknown as { openWithDefaultApp?: (p: string) => void }).openWithDefaultApp?.(this.existing.path);
    this.close();
  }

  /** Aufgabe drucken: Titel + Meta + Beschreibung in ein verstecktes iframe rendern und drucken.
   *  DOM-basiert (createElement/textContent) – kein document.write, kein Inline-Style. */
  private printTask(): void {
    const doc = activeDocument;
    const title = this.titleValue() || t("placeholder_taskname");
    const meta: string[] = [];
    if (this.f.due) meta.push(t("chip_date") + ": " + formatDateTime(combineDT(this.f.due, this.f.dueTime)));
    if (this.f.priority && this.f.priority !== "normal") meta.push(t("chip_priority") + ": " + t(PRIO_KEY[this.f.priority]));
    if (this.f.labels?.length) meta.push(t("chip_label") + ": " + this.f.labels.map((l) => "#" + l).join(", "));
    if (this.f.project) meta.push(t("group_project") + ": " + projectDisplayName(this.f.project));
    const desc = (this.f.description ?? "").trim();

    // Das iframe-Element selbst gehoert dem App-Realm -> Obsidian-Helfer: anlegen, klassifizieren
    // und anhaengen in einem Zug.
    const iframe = doc.body.createEl("iframe", { cls: "bt-print-frame", attr: { "aria-hidden": "true" } });
    // Inhalt liegt im iframe-Realm → nur Standard-DOM (kein Obsidian-createEl/addClass).
    //
    // Die fünf `obsidianmd/prefer-create-el`-Warnungen unten sind hier FEHLALARME und bleiben
    // bewusst stehen: Die Regel schlägt `idoc.win.createEl(…)` vor. Obsidian erweitert damit aber
    // die Prototypen SEINES Fensters; das iframe hat einen eigenen Realm mit eigenem
    // `Document.prototype`, in dem weder `win` noch `createEl` existieren – der Vorschlag ließe
    // sich übersetzen und schlüge zur Laufzeit fehl. Abschalten per eslint-disable verbietet die
    // Projektkonfiguration (no-restricted-disable), also stehen die Warnungen mit dieser Begründung.
    const idoc = iframe.contentDocument, win = iframe.contentWindow;
    if (!idoc || !win) { iframe.remove(); return; }
    idoc.title = title;
    idoc.body.className = "bt-print";
    const style = idoc.createElement("style");
    style.textContent = ".bt-print{font-family:sans-serif;margin:2cm;color:#111}.bt-print h1{font-size:20pt;margin:0 0 12pt}"
      + ".bt-print ul{padding-left:1.2em;color:#333;font-size:11pt}.bt-print li{margin:2pt 0}"
      + ".bt-print pre{white-space:pre-wrap;font:inherit;font-size:11pt;margin-top:12pt}";
    idoc.head.appendChild(style);
    const h1 = idoc.createElement("h1"); h1.textContent = title; idoc.body.appendChild(h1);
    if (meta.length) {
      const ul = idoc.createElement("ul");
      for (const m of meta) { const li = idoc.createElement("li"); li.textContent = m; ul.appendChild(li); }
      idoc.body.appendChild(ul);
    }
    if (desc) { const pre = idoc.createElement("pre"); pre.textContent = desc; idoc.body.appendChild(pre); }
    win.focus();
    win.print();
    window.setTimeout(() => iframe.remove(), 1000);
  }

  /** Detail-Sektion (Kommentar-Log) auf-/zuklappen – vom Büroklammer-Chip ausgelöst. */
  private toggleDetails(): void {
    const willOpen = this.logWrap.hasClass("bt-hidden");
    this.logWrap.toggleClass("bt-hidden", !willOpen);
    if (willOpen) window.setTimeout(() => this.log.focusComposer(), 0);
    this.syncDetails();
  }

  /** Chip-Zustand + Sichtbarkeit des Detail-Bereichs angleichen: Der Wrapper (und damit sein
   *  Leerraum) verschwindet, wenn die Kommentar-Sektion zu ist – so kein leeres Band unter
   *  den Chips. */
  private syncDetails(): void {
    const logOpen = !this.logWrap.hasClass("bt-hidden");
    this.detailsChip?.toggleClass("is-open", logOpen);
    this.detailsWrap.toggleClass("bt-hidden", !logOpen);
  }

  /** Die aktuell gewählte Elternaufgabe aus dem Index (oder null, wenn keine/nicht gefunden).
   *  Gesucht wird im Bestand DIESES Editors: Die Elternaufgabe einer Vorlagen-Unteraufgabe steht
   *  im Vorlagen-Index, und im Aufgaben-Index fände man sie nie – die Brotkrume fehlte dann. */
  private parentTask(): Task | null {
    if (!this.f.parent && !this.f.parentId) return null;
    return this.editScope.index.all().find((tk) => this.f.parentId ? tk.id === this.f.parentId : baseName(tk.path) === this.f.parent) ?? null;
  }

  /** Elternaufgabe in ihrer Liste anzeigen (wie die Lupe in der Suche: hinspringen + kurz
   *  hervorheben). Modal schließen, damit die hervorgehobene Zeile sichtbar wird. */
  private showParent(): void {
    const parent = this.parentTask();
    if (!parent) { new Notice(t("err_parent_not_found")); return; }
    this.close();
    void this.plugin.revealTask(parent);
  }

  /** Status übernehmen. Bei bestehender Aufgabe live schreiben (setTaskStatus kümmert sich
   *  um Zeitstempel/Wiederholung); bei neuer Aufgabe fließt f.status beim Anlegen ein. */
  private async applyStatus(status: TaskStatus): Promise<void> {
    this.f.status = status;
    if (this.existing) { await this.plugin.setTaskStatus(this.existing, status); this.existing.status = status; }
    this.renderChips();
  }

  /** Prefer the stable ID, but fall back to the resolved display name/path when repairing a task
   *  whose old migration wrote a path into the ID field. */
  private selectedProject() {
    const { bereiche, projekte } = listProjectsAndAreas(this.app);
    return [...bereiche, ...projekte].find((project) =>
      (!!this.f.projectId && project.id === this.f.projectId)
      || (!!this.f.project && (project.name === this.f.project || baseName(project.path) === this.f.project)));
  }

  private renderProjekt(): void {
    this.projektBtn.empty();
    const sel = this.selectedProject();
    const inbox = !sel && isInboxLink(this.f.project);
    this.projectOpenBtn.toggleClass("bt-hidden", !sel);
    const ic = this.projektBtn.createSpan({ cls: "bt-projekt-ic" });
    setIcon(ic, inbox ? "inbox" : (sel?.icon ?? "list-checks"));
    if (sel?.color) ic.setCssStyles({ color: sel.color });
    this.projektBtn.createSpan({ cls: "bt-projekt-lbl", text: inbox ? t("nav_inbox") : (sel?.name ?? projectDisplayName(this.f.project ?? this.f.projectId)) });
    const car = this.projektBtn.createSpan({ cls: "bt-projekt-car" }); setIcon(car, "chevron-down");
  }

  private openProject(anchor: HTMLElement): void {
    openPopover(anchor, (pop, close) => {
      pop.addClass("bt-picker");
      // Projekt ODER Bereich direkt anlegen – gleicher Weg wie im ListManager.
      popRow(pop, "plus", t("pick_new_project"), () => this.startNewProject(pop, close, false)).addClass("bt-row-action");
      popRow(pop, "plus", t("pick_new_area"), () => this.startNewProject(pop, close, true)).addClass("bt-row-action");

      const { bereiche, projekte } = listProjectsAndAreas(this.app);
      const pick = (name: string | null, id: string | null = null) => { this.f.project = name; this.f.projectId = id; this.renderProjekt(); close(); };
      // Eingang = kein Projekt (Auswahl leert das Projekt-Feld).
      popRow(pop, "inbox", t("nav_inbox"), () => pick(null), !this.f.projectId && isInboxLink(this.f.project));
      const group = (title: string, items: { id: string; name: string; icon: string; color: string | null }[]) => {
        if (!items.length) return;
        pop.createDiv({ cls: "bt-pop-head", text: title });
        for (const it of items) popRow(pop, it.icon, it.name, () => pick(it.name, it.id), (!!it.id && this.f.projectId === it.id) || (!this.f.projectId && this.f.project === it.name), it.color ?? undefined);
      };
      group(t("group_area"), bereiche);
      group(t("group_project"), projekte);
    });
  }

  private startNewProject(pop: HTMLElement, close: () => void, asArea: boolean): void {
    pop.empty();
    const inp = pop.createEl("input", { type: "text", cls: "bt-pop-input", attr: { placeholder: asArea ? t("placeholder_area_name") : t("placeholder_project_name") } });
    inp.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = inp.value.trim();
      if (!name) return;
      const created = await createProjectRecord(this.app, this.plugin.settings, name, asArea);
      this.f.project = created.name;
      this.f.projectId = created.id;
      this.renderProjekt();
      close();
    };
    window.setTimeout(() => inp.focus(), 0);
  }

  // ── Unteraufgabe ──
  /** „Unteraufgabe erstellen": klappt den Detailbereich auf und setzt den Cursor in die
   *  Inline-Erfassung der Unteraufgaben-Sektion. Früher wurde dafür dieses Modal geschlossen
   *  und ein zweites geöffnet – der Kontext (Hauptaufgabe) ging dabei verloren. */
  private addSubtask(): void {
    if (!this.existing) return;
    this.subs.focusComposer();   // blendet die Sektion ein (falls leer) und setzt den Cursor
  }

  /** ⤢ aus der Inline-Erfassung: den getippten Titel im vollen Editor weiterbearbeiten.
   *  Projekt-Chip ausgeblendet (die Unteraufgabe erbt das Projekt der Hauptaufgabe), der
   *  Eltern-Link läuft über den Basename (Dateiname) – der Titel kann davon abweichen und
   *  würde als Wikilink nicht auflösen. */
  private openSubtaskEditor(title: string): void {
    if (!this.existing) return;
    const parent = this.existing;
    const parentProject = parent.project ? baseName(parent.project) : undefined;
    const parentBase = baseName(parent.path);
    // Elternmodal bleibt offen (stacked): nach dem Anlegen steht man wieder in der Hauptaufgabe,
    // und deren Liste zeigt die neue Unteraufgabe sofort.
    new TaskModal(this.plugin, undefined, parentProject, { hideProjekt: true, parent: parentBase, parentId: parent.id,
      defaultTitle: title, stacked: true, scope: this.opts.scope, seed: { projectId: parent.projectId } }).open();
  }

  // ── Details: Kommentar-Log (gemeinsame Komponente DetailLogView) ──
  private logSrc(): string { return this.existing?.path ?? this.plugin.settings.itemsFolder + "/_.md"; }

  /** Ziel-Datei des Logs (nur bei bestehender Aufgabe) – null = neue Aufgabe (Puffer im Speicher). */
  private existingFile(): TFile | null {
    if (!this.existing) return null;
    const f = this.app.vault.getAbstractFileByPath(this.existing.path);
    return f instanceof TFile ? f : null;
  }

  // ── Speichern / Löschen ──
  /** Aktueller (bereinigter) Titel. */
  private titleValue(): string { return (this.cleanTitle || this.f.title).trim(); }

  /** Explizites Speichern (Button/Enter): bei leerem Titel Hinweis + offen bleiben. */
  private async save(): Promise<void> {
    if (!this.titleValue()) { new Notice(t("err_enter_taskname")); return; }
    // Entwürfe VOR persist(): Bei einer neuen Aufgabe schreibt persist() den Kommentar-Puffer
    // in die frisch angelegte Notiz. Käme der Entwurf erst über onClose dazu, wäre dieser
    // Zug bereits gefahren und der Text verloren. Beide flushDraft() sind mehrfach aufrufbar
    // (sie leeren ihr Feld), der zweite Aufruf aus onClose läuft also ins Leere.
    this.subs?.flushDraft();
    this.log?.flushDraft();
    await this.persist();
    this.close();
  }

  /** Schreibt die Aufgabe (neu anlegen oder Frontmatter aktualisieren). Ohne Titel passiert
   *  nichts (stilles Verwerfen beim Auto-Speichern); nur EINMAL (Schutz gegen Doppel-Schreiben). */
  private async persist(): Promise<void> {
    const title = this.titleValue();
    if (!title || this.persisted) return;
    this.persisted = true;
    // Labels created directly on a real task should appear in the sidebar just like labels made
    // through the dedicated New Label modal. Snapshot before writing: after the metadata-cache
    // update they are no longer distinguishable from deliberately hidden existing labels.
    const newLabels = this.editScope.target && this.editScope.target.type !== "task" ? []
      : newlyIntroducedLabels(this.f.labels ?? [], this.plugin.getLabels().map((label) => label.name));
    if (this.existing) {
      const file = this.app.vault.getAbstractFileByPath(this.existing.path);
      if (file instanceof TFile) {
        await updateRecord(this.app, file, (fm) => {
          ensureCanonicalFm(fm);   // handgeschriebene Notiz beim ersten Editieren kanonisieren
          const set = (k: string, v: unknown) => {
            if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete fm[k]; else fm[k] = v;
          };
          set("title", title);
          set("priority", this.f.priority && this.f.priority !== "normal" ? this.f.priority : null);
          set("due", this.f.due ? combineDT(this.f.due, this.f.dueTime) : null);
          set("estimate", this.f.estimate ?? null);
          set("recurrence", this.f.recurrence);
          set("recur_basis", this.f.recurrence && this.f.recurBasis === "done" ? "done" : null);
          const recordType = this.editScope.target?.type ?? "task";
          const projectId = canonicalRelationshipId(this.app, this.f.projectId, this.f.project, ["project", "area"]);
          const parentId = canonicalRelationshipId(this.app, this.f.parentId, this.f.parent, [recordType]);
          set(OPAL_PROJECT_ID, projectId);
          set(OPAL_PARENT_ID, parentId);
          set("project", projectId ? null : legacyRelationshipLink(this.f.project));
          set("parent", parentId ? null : legacyRelationshipLink(this.f.parent));
          set(labelKey(), this.f.labels);   // Feldname konfigurierbar (s. fieldNames.ts)
          set("reminders", this.f.reminders);
          set("description", (this.f.description ?? "").trim() || null);   // leer => Feld entfernen
        });
      }
    } else {
      const sortOrder = this.opts.insertBefore
        ? await this.plugin.prepareTaskInsert(this.opts.insertBefore.parentPath, this.opts.insertBefore.beforePath)
        : undefined;
      const file = await createTaskNote(this.app, this.plugin.settings, { ...this.f, title,
        parent: this.f.parent ?? this.opts.parent ?? null, parentId: this.f.parentId ?? this.opts.parentId ?? null, sortOrder }, this.editScope.target);
      await this.log.flush(file);
    }
    await this.plugin.showNewTaskLabels(newLabels);
  }

  /** Löschen = Aufgabe UND alle Unteraufgaben in den Papierkorb (sonst verwaisen Kinder).
   *  Weil die Kaskade mehr trifft als die eine sichtbare Aufgabe, fragt das Modal vorher nach –
   *  ohne die Kinder aufzuzählen, aber mit dem Hinweis, dass sie mitgehen und wiederherstellbar
   *  sind. Bestätigt wird immer, auch ohne Unteraufgaben: dieselbe Rückfrage an derselben
   *  Stelle ist verlässlicher als eine, die je nach Aufgabe erscheint oder nicht. */
  private remove(): void {
    const task = this.existing;
    if (!task) return;
    new ConfirmModal(this.app, {
      title: t("confirm_delete_title", task.title),
      message: t("confirm_delete_cascade"),
    }, () => {
      this.discarding = true;   // Löschen ist kein Bearbeiten -> onClose darf nicht auto-speichern
      void this.plugin.cancelTask(task);
      this.close();
    }).open();
  }
}
