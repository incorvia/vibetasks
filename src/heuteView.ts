import { ItemView, WorkspaceLeaf, setIcon, MarkdownRenderer, Component, Keymap, Menu, TFile, ViewStateResult } from "obsidian";
import type OpalTasksPlugin from "./main";
import { PageCtx, PageRef, pageInfo, samePage, manageTitleKey, supportsPrioritySwimlanes } from "./pageCtx";
import { dragTask, dragFromCol, startTaskDrag, endTaskDrag, applyDropPage } from "./taskDrag";
import { sectionSig, SigLookup } from "./rowSignature";
import { rowPlan, NO_PROJECT } from "./rowPlan";
import { takeFromBudget, repaintCount, rowsForScroll, columnFirstPaint, placeholderPx } from "./chunkPlan";
import { Task, TaskStatus, NavSection, Priority } from "./types";
import { todayStr, combineDT, dateOf, groupLabel } from "./format";
import { openDatePicker } from "./datePicker";
import { listProjectsAndAreas, listManaged, projectsInArea, tasksInArea, projectAreaName, priorityBucket, taskMatchesProjectCell, isAreaPath, isInboxLink, isRecentlyCompletedProject, baseName, openTaskNote, INBOX_KEY, ProjLists, ProjItem } from "./taskService";
import { listFilters, readFilter, FilterItem } from "./filterService";
import { applyFilter, countFilter, filterTasks, hasCriteria, sortTasks, groupTasks, dateColumnKeys, visibleRows, planDiff, agendaOwnRow, effectiveSubtasks, sortSubtasks, mergeTodayTaskBuckets, DEFAULT_CRITERIA, FilterGroup, FilterSort, PageLayout, LAYOUTS, SortDir, SubtaskDisplay, ViewOptions } from "./filterEngine";
import { FilterModal } from "./filterModal";
import { NewItemModal } from "./newItemModal";
import { buildItemMenu, showHiddenSubmenu, addGcalSyncItem, addOpenItems, openEdit, buildCreateSubmenu, addCreateItems, buildTemplateMenu, NavMenuItem } from "./navMenu";
import { anzeigeButton, openViewPanel } from "./viewPanel";
import { renderManageInto, iconBtn, confirmInline, attachRowDrag } from "./manageView";
import { listTemplates, TemplateInfo } from "./templateService";
import { ApplyTemplateModal, promptNewTemplate } from "./templateModal";
import { ConfirmModal } from "./confirmModal";
import { parseRecurrence } from "./recurrence";
import { describeRecurrence } from "./recurrenceText";
import { renderCalendar, calendarDayAnchor, tryPatchCalendar, activateEventOpen, dropCalendarAnchors, resetCalendarToToday } from "./calendarView";
import { AutoPlanModal } from "./autoPlanModal";
import { DayEvent, bucketEvents, addDays, addMonths } from "./calendarModel";
import { renderCheck, installCheckDelegation } from "./taskCheck";
import { installTaskMenuDelegation, menuHoldPath, openBoardMoveMenu } from "./taskMenu";
import { TaskModal } from "./taskModal";
import { KANBAN_PRIOS, PRIOS } from "./chips";
import { isOpen, isDone, isTrashed, boardStatuses, statusLabel, statusTint, firstOpenStatus, StatusKind } from "./statuses";
import { t, getLocale, projectDisplayName } from "./i18n";
import { tip, tipWhenClipped } from "./tooltip";
import { entityIcon, renderProjectIdentity } from "./entityPresentation";
import { boardProjection, BoardProjection, isCompactPane } from "./responsive";
import { boardStatusAxes, visibleBoardAxes } from "./boardAxes";
import { linkedNoteExcerpt } from "./linkedProjectNote";
import { blockKind } from "./timeService";
import type { ProjectTaskProgress } from "./taskIndex";
import { createListSection } from "./listSection";
import { projectDisplayColor } from "./projectColor";

/**
 * ── Transienter Anzeige-Zustand: IMMER mit dem Tab schlüsseln ─────────────────────────────────
 * Diese Maps überleben ein Neuzeichnen (das ist ihr Zweck), sind aber Modul-Zustand: ohne die
 * Tab-Kennung im Schlüssel (ctx.id, s. viewKey) teilen sich zwei Tabs DERSELBEN Seite einen
 * Eintrag – Tab 2 spränge dann beim Zeichnen auf die Scrollposition von Tab 1, und ein dort
 * aufgeklapptes Unteraufgaben-Badge klappte hier mit auf.
 */
const viewKey = (ctx: PageCtx, rest: string): string => ctx.id + "|" + rest;

/** Pro Dashboard-Tab genau ein Things-artig aufgeklappter Aufgaben-Editor. Er bleibt während
 *  Index-Meldungen stehen; beim Schließen wird die inzwischen geänderte Liste nachgezogen. */
interface InlineTaskEditor {
  modal: TaskModal;
  path: string;
  row: HTMLElement;
  slot: HTMLElement;
  suppressRedraw: boolean;
}
const inlineTaskEditors = new Map<string, InlineTaskEditor>();

export function inlineTaskEditorOpen(id: string): boolean {
  const active = inlineTaskEditors.get(id);
  return !!active?.slot.isConnected;
}

export function closeInlineTaskEditor(id: string, redraw = true): void {
  const active = inlineTaskEditors.get(id);
  if (!active) return;
  active.suppressRedraw = !redraw;
  active.modal.close();
}

function openInlineTaskEditor(ctx: PageCtx, task: Task, row: HTMLElement): void {
  const current = inlineTaskEditors.get(ctx.id);
  if (current?.path === task.path && current.slot.isConnected) { current.modal.focusTitle(); return; }
  // Beim Wechsel nicht zwischen altem Schließen und neuem Einhängen neu zeichnen: `row` gehört
  // noch zur aktuellen Zeichnung und bliebe nach einem Redraw ein toter Anker.
  if (current) closeInlineTaskEditor(ctx.id, false);

  const slot = row.parentElement!.createDiv({ cls: "bt-inline-editor-slot" });
  // Keep the editor and its title together. The title input replaces the title in `row`, so
  // hoisting only the editor body above a Kanban board split one form across two distant places:
  // a seemingly titleless panel above the board and a lone input inside the selected card.
  // A board card now expands in its own column just like a list row; the narrow-column layout is
  // handled by the board-specific editor styles rather than by moving half of the editor.
  if (row.closest(".bt-kanban")) slot.addClass("bt-inline-board-card");
  row.insertAdjacentElement("afterend", slot);
  row.addClass("is-editing");
  row.setAttr("draggable", "false");
  const modal = new TaskModal(ctx.plugin, task);
  const active: InlineTaskEditor = { modal, path: task.path, row, slot, suppressRedraw: false };
  inlineTaskEditors.set(ctx.id, active);
  modal.openInline(slot, () => {
    if (inlineTaskEditors.get(ctx.id) === active) inlineTaskEditors.delete(ctx.id);
    row.removeClass("is-editing");
    row.setAttr("draggable", "true");
    slot.remove();
    if (!active.suppressRedraw) ctx.redraw();
  }, row);
}

/** Die normale „+ Aufgabe"-Zeile ist ebenfalls ein Inline-Composer. Das globale Quick Add bleibt
 *  ein Modal, weil es absichtlich ohne sichtbaren Seitenkontext von überall erreichbar ist. */
function openInlineNewTask(ctx: PageCtx, anchor: HTMLElement, project?: string, label?: string,
  today = false, status?: TaskStatus, due?: string | null, scheduled?: string | null,
  insert?: { side: "before" | "after"; task: Task; beforePath: string | null },
  mount?: { inside: HTMLElement; onClose?: () => void }, priority?: Priority,
  projectId?: string | null): void {
  const current = inlineTaskEditors.get(ctx.id);
  if (current?.path === "\0new" && current.slot.isConnected) { current.modal.focusTitle(); return; }
  if (current) closeInlineTaskEditor(ctx.id, false);

  const slotParent = mount?.inside ?? anchor.parentElement!;
  const slot = slotParent.createDiv({ cls: "bt-sizer bt-inline-editor-slot bt-inline-new" });
  // Page-level adders mount after the sticky header; list adders mount after their own compact
  // bar. Treating the inner `.bt-add` as the mount point would put a 100%-wide editor inside a
  // flex row, which is what made project creation look like a full-page form.
  const top = anchor.closest<HTMLElement>(".bt-page-top, .bt-board-bar, .bt-section-title") ?? anchor;
  const taskRow = insert ? anchor.closest<HTMLElement>(".bt-task") : null;
  if (mount) mount.inside.prepend(slot);
  else (taskRow ?? top).insertAdjacentElement(insert?.side === "before" ? "beforebegin" : "afterend", slot);
  // A relative new-task composer is a sibling of the existing row, not its editor. Reusing the
  // editing class joined both cards and left the clicked + floating on their shared boundary.
  anchor.addClass(insert ? "is-adding-task" : "is-editing");
  const modal = new TaskModal(ctx.plugin, undefined, project, {
    defaultLabel: label, defaultToday: today, defaultStatus: status,
    seed: (due || scheduled || priority || projectId) ? { due: due ?? scheduled ?? undefined, priority, projectId } : undefined,
    hideProjekt: !!insert?.task.parent,
    parent: insert?.task.parent ? baseName(insert.task.parent) : undefined,
    insertBefore: insert ? { parentPath: insert.task.parent, beforePath: insert.beforePath } : undefined,
  });
  const active: InlineTaskEditor = { modal, path: "\0new", row: anchor, slot, suppressRedraw: false };
  inlineTaskEditors.set(ctx.id, active);
  modal.openInline(slot, () => {
    if (inlineTaskEditors.get(ctx.id) === active) inlineTaskEditors.delete(ctx.id);
    anchor.removeClass(insert ? "is-adding-task" : "is-editing");
    slot.remove();
    mount?.onClose?.();
    if (!active.suppressRedraw) ctx.redraw();
  });
}

/** The page header is the universal creation trigger. In list layout, give its editor a native
 *  list subframe instead of leaving a modal-shaped card floating between header and content. */
function openHeaderNewTask(ctx: PageCtx, root: HTMLElement, anchor: HTMLElement, project?: string,
  label?: string, today = false, due?: string | null, status?: TaskStatus, priority?: Priority,
  projectId?: string | null): void {
  if (ctx.opts.layout !== "list") {
    openInlineNewTask(ctx, anchor, project, label, today, status, due, undefined, undefined, undefined, priority, projectId);
    return;
  }

  // Automatic sorting owns the final position. Manual sorting does not: because this composer is
  // shown at the top, materialize an insertion before the first visible top-level task so saving
  // does not contradict the place where the user added it.
  const firstManualTask = ctx.opts.sort === "manual"
    ? Array.from(root.querySelectorAll<HTMLElement>(".bt-task"))
      .map((row) => row.dataset.path ? ctx.plugin.index.get(row.dataset.path) : undefined)
      .find((task) => task && !task.parent)
    : undefined;
  const insert = firstManualTask
    ? { side: "before" as const, task: firstManualTask, beforePath: firstManualTask.path }
    : undefined;

  const sections = Array.from(root.querySelectorAll<HTMLElement>(":scope > .bt-section"));
  const existing = sections.find((sec) =>
    sec.querySelector<HTMLElement>(":scope > .bt-section-title > .bt-section-lbl")?.textContent === t("sec_tasks"));
  if (existing) {
    const list = existing.querySelector<HTMLElement>(":scope > .bt-list");
    if (list) { openInlineNewTask(ctx, anchor, project, label, today, status, due, undefined, insert, { inside: list }, priority, projectId); return; }
  }

  const wasEmpty = root.hasClass("is-empty");
  const empty = root.querySelector<HTMLElement>(":scope > .bt-empty");
  root.removeClass("is-empty");
  empty?.addClass("bt-hidden");
  const group = createListSection(root, { title: t("sec_tasks"), className: "bt-task-compose-section" });
  const sec = group.section;
  root.prepend(sec);
  const list = group.list;
  openInlineNewTask(ctx, anchor, project, label, today, status, due, undefined, insert, {
    inside: list,
    onClose: () => {
      sec.remove();
      empty?.removeClass("bt-hidden");
      if (wasEmpty) root.addClass("is-empty");
    },
  }, priority, projectId);
}
/** Alle Einträge eines Tabs verwerfen (beim Schließen bzw. beim Seitenwechsel des Tabs). */
function dropViewKeys(id: string): void {
  const prefix = id + "|";
  for (const map of [boardScroll, colScroll, boardColumnSelection, boardLaneSelection, listScroll, subtaskToggle] as Map<string, unknown>[]) {
    for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
  }
  for (const k of [...gcalExpanded]) if (k.startsWith(prefix)) gcalExpanded.delete(k);
  dropCalendarAnchors(id);   // der angezeigte Zeitraum des Kalenders liegt drüben (calendarView)
}
export const dropViewState = (id: string): void => dropViewKeys(id);
// Horizontale Board-Scrollposition je Board-Identität – überlebt Re-Renders (z. B. nach Karten-Drop).
const boardScroll = new Map<string, number>();
// Senkrechte Position INNERHALB einer Spalte (Schlüssel: Board-Identität + Spalten-ID).
// Nötig, weil `.bt-kanban-list` bei jeder Zeichnung neu entsteht – ein frisches Element startet
// zwangsläufig bei 0. In der Listenansicht stellt sich die Frage nicht: dort ist der Scroller
// contentEl selbst, das Element überlebt und wird nur geleert und wieder gefüllt.
const colScroll = new Map<string, number>();
// Tablet/mobile boards show a slice of the same model. The selected status/priority belongs to
// this tab just like scroll position; changing it must not mutate the page or another open tab.
const boardColumnSelection = new Map<string, string>();
const boardLaneSelection = new Map<string, string>();
// Senkrechte Position der LISTE (Schlüssel: Tab). Der Scroller ist hier contentEl selbst, das
// Element überlebt also – aber sein Inhalt nicht: Beim Neuaufbau ist die Seite kurzzeitig leer,
// und sobald in diesem Moment irgendwo Layout gelesen wird, klemmt der Browser scrollTop auf 0.
// Dann springt die Seite bei JEDER Änderung nach oben, und wer weiter unten mehrere Aufgaben
// abhaken will, muss nach jeder einzelnen erneut hinunterscrollen – dieselbe Not wie bei den
// Board-Spalten, nur eine Ebene höher.
const listScroll = new Map<string, number>();
// Klappzustand der verschachtelten Unteraufgaben je Hauptaufgabe: EXPLIZITE Nutzer-Klicks aufs
// Badge. Der Default hängt am Anzeige-Modus – „Eingerückt" ist offen, sonst zu –, ein Klick
// überschreibt ihn pro Aufgabe. Modul-Zustand wie gcalExpanded: überlebt renderMain(), ein
// Reload startet wieder beim Modus-Default.
const subtaskToggle = new Map<string, boolean>();
function subsExpanded(ctx: PageCtx, path: string, mode: SubtaskDisplay): boolean {
  return subtaskToggle.get(viewKey(ctx, path)) ?? (mode === "indented");
}
/**
 * Die Einzel-Klick-Zustände DIESES Tabs verwerfen – ruft das Anzeige-Panel beim MODUSWECHSEL auf.
 * Ohne das überstimmte ein früherer Badge-Klick („zu") den frisch gewählten Modus dauerhaft:
 * „Eingerückt" rückte dann genau die Aufgaben nicht ein, deren Badge man beim Ausprobieren
 * angeklickt hatte – je Ansicht andere, was wie ein Ansichts-Fehler aussah. Der Moduswechsel
 * ist die ausdrückliche neue Ansage „alle auf/zu" und setzt deshalb alle Overrides zurück.
 */
export function resetSubtaskToggles(ctx: PageCtx): void {
  const prefix = ctx.id + "|";
  for (const k of [...subtaskToggle.keys()]) if (k.startsWith(prefix)) subtaskToggle.delete(k);
}

export const VIEW_PREFIX = "opal_tasks-";
export type ViewId = "heute" | "demnaechst" | "wiederkehrend" | "erledigt";
export const VIEW_IDS: ViewId[] = ["heute", "demnaechst", "wiederkehrend", "erledigt"];
export const VIEW_MAIN = VIEW_PREFIX + "main";             // Dashboard-Leaf; beliebig oft offen (je Tab eine Seite)
export const VIEW_NAV = VIEW_PREFIX + "nav";
export const OLD_VIEW_TYPES = [
  ...VIEW_IDS.map((v) => VIEW_PREFIX + v),
];   // Aufräumen alter, ansichtsspezifischer Tabs aus früheren Versionen
export const VIEW_ICON: Record<ViewId, string> = {
  heute: "calendar-days", demnaechst: "calendar-1", wiederkehrend: "refresh-ccw", erledigt: "check-circle",
};
const TITLE_KEY: Record<ViewId, string> = { heute: "view_today", demnaechst: "view_upcoming", wiederkehrend: "view_recurring", erledigt: "view_done" };
/**
 * Die Anzeige-Optionen, die ein TAB für sich überschreiben darf. Beide beschreiben den BLICK,
 * nicht den Inhalt: welches Layout gerade davorsteht und ob die Seitenspalte des Kalenders offen
 * ist. Sortieren, Gruppieren, Erledigte und der Kalendermodus gehören dagegen zur Seite – sie
 * beantworten „was steht da?" und sollen in allen Tabs derselben Seite gleich beantwortet sein.
 */
type LocalOptions = Pick<ViewOptions, "layout" | "calPanel">;

/** Tab-Icon je Layout (s. MainView.getIcon). Bewusst nur lange etablierte Lucide-Namen –
 *  ein Icon, das die minAppVersion noch nicht kennt, bliebe leer. */
const LAYOUT_ICON: Record<PageLayout, string> = { list: "list", board: "layout-grid", calendar: "calendar-days" };
export const viewTitle = (id: ViewId): string => t(TITLE_KEY[id]);

/** Datum, auf das „+ Aufgabe hinzufügen" vorbelegt: in der Kalender-TAGESANSICHT der gerade
 *  angezeigte Tag, sonst null (dann greift wie bisher „heute" bzw. gar kein Datum). Projekt/Label
 *  kommen unverändert von der Seite – der Knopf verhält sich also wie in der Liste, nur mit dem
 *  Tag, den man gerade ansieht. */
function addDue(ctx: PageCtx): string | null {
  return calendarDayAnchor(ctx, ctx.opts);
}

/** Aufgabenmenge für das Kalender-Layout der System-Views (Heute/Demnächst).
 *  Diese Views schneiden ihre Menge bewusst zeitlich zu (nur heute bzw. nur Zukunft) – im Kalender
 *  wäre damit fast jede Zelle leer und Zurückblättern sinnlos. Der Kalender zeigt dort deshalb ALLE
 *  datierten Aufgaben; das Datum ist ja bereits seine Achse. Projekt-/Label-/Filterseiten behalten
 *  dagegen ihre Menge (dort ist die Einschränkung die Aussage der Seite).
 *
 *  Der Ansichtsfilter gilt trotzdem: Genau WEIL dieser Weg die Menge der Seite umgeht, muss er
 *  hier ausdrücklich stehen – sonst stellt man „nur Priorität 1" ein und der Kalender bleibt voll. */
function calendarTasks(ctx: PageCtx, opts: ViewOptions): Task[] {
  const idx = ctx.plugin.index;
  const open = idx.open();
  return ctx.filter(opts.showDone ? [...open, ...idx.done()] : open);
}

/** Open tasks whose primary work placement touches this day. The task remains independent from
 *  its deadline; this is the scheduling half of the Today view's combined source set. */
function scheduledOpenTasksOn(plugin: OpalTasksPlugin, day: string): Task[] {
  const ids = new Set(plugin.timeStore.blocksIn(day, day)
    .filter((block) => block.status === "planned" && blockKind(block) === "task_schedule" && block.scope.type === "task")
    .map((block) => block.scope.id));
  return plugin.index.open().filter((task) => ids.has(task.id));
}

function todayBuckets(plugin: OpalTasksPlugin, day: string): { overdue: Task[]; today: Task[] } {
  return mergeTodayTaskBuckets(plugin.index.overdue(day), plugin.index.dueToday(day), scheduledOpenTasksOn(plugin, day));
}

/**
 * Kopf-Block einer Seite (Titel + „Anzeige" + „+ Aufgabe"). Bleibt beim Scrollen oben stehen (CSS).
 * Die Gruppen-Überschriften scrollen bewusst mit – deshalb braucht hier auch niemand die Kopfhöhe
 * zu kennen (kein ResizeObserver, keine CSS-Variable).
 *
 * (Das Ruckeln, das mich diesen Block einmal wieder ausbauen ließ, kam nachweislich woanders her:
 * aus dem dreifachen Neuzeichnen pro Änderung – siehe tryPatchCalendar/tryPatchNav.)
 */
function pageTop(c: HTMLElement, layout: PageLayout): HTMLElement {
  // Der Block spannt die VOLLE Pane-Breite (nur so kann „Anzeige" rechts an der Pane-Kante andocken).
  // Der innere Sizer folgt dem Layout des Bodys darunter: Liste = Lesebreite, Board/Kalender =
  // volle Breite. Sonst stünde der Titel im Kalender zentriert, während sein Raster links beginnt.
  const bar = c.createDiv({ cls: "bt-page-top" });
  c.prepend(bar);   // IMMER als erstes Element – der Listen-Sizer ist teils schon erzeugt
  const wide = layout !== "list";
  return bar.createDiv({ cls: "bt-sizer bt-page-top-in" + (wide ? " bt-sizer-board" : "") });
}

/** Rendert eine Dashboard-Ansicht in ein angehängtes DOM-Element (Deferred-sicher). */
export function renderViewInto(c: HTMLElement, ctx: PageCtx, view: ViewId): void {
  markIndexReady(ctx);
  const plugin = ctx.plugin;
  const today = todayStr();
  c.empty();
  c.addClass("bt-view");
  applyReadableWidth(c, plugin);
  const root = c.createDiv({ cls: "bt-sizer bt-page-body" });
  // Every task page uses the same shell. Pages whose PageInfo tier is "none" simply omit the
  // display control; pageHeader decides that centrally instead of requiring a second header DOM.
  if (view !== "erledigt") {
    const top = pageTop(c, view === "wiederkehrend" ? "list" : ctx.opts.layout);
    pageHeader(top, ctx, top.createEl("h1", { text: viewTitle(view) }), view === "heute" || view === "demnaechst" ? {
      onAdd: (add) => openHeaderNewTask(ctx, root, add, undefined, undefined, view === "heute", addDue(ctx)),
    } : {});
  }

  const idx = plugin.index;
  if (view === "heute") {
    const opts = ctx.opts;
    // Heute kombiniert zwei unabhängige Aussagen: Fälligkeit auf der Aufgabe und geplante Arbeit
    // im TimeStore. Eine Planung wird dabei nie zur Fälligkeit; mergeTodayTaskBuckets hält die
    // Gruppen disjunkt und lässt Überfällig gewinnen.
    const rawToday = todayBuckets(plugin, today);
    const overdue = ctx.filter(rawToday.overdue), todayTasks = ctx.filter(rawToday.today);
    const doneToday = ctx.filter(idx.done().filter((tk) => dateOf(tk.completed ?? "") === today));   // completed = Zeitstempel -> Datums-Teil vergleichen
    const open = [...overdue, ...todayTasks];
    // Termine des Tages (read-only) zählen mit: sonst behauptete „Nichts für heute" leeren Tag,
    // obwohl der Kalender voller Meetings steckt. setRange meldet dem Feed den Zeitraum (Listen-Layout
    // hat sonst nichts, was ihn anstößt – das macht sonst nur der Kalender).
    plugin.gcalFeed?.setRange(today, today);
    // Bei aktivem Ansichtsfilter bleiben die Termine weg: Ein Termin hat weder Priorität noch
    // Label noch Projekt, kann also kein Kriterium erfüllen – er stünde als einziges Element in
    // einer Ansicht, die ausdrücklich etwas anderes sehen will.
    const todayEv = hasCriteria(ctx.crit) ? [] : dayEvents(plugin, today);
    if (!open.length && !(opts.showDone && doneToday.length) && !todayEv.length) {
      if (hasCriteria(ctx.crit)) filterEmptyState(root, ctx);
      else emptyState(root, VIEW_ICON.heute, "empty_nothing_today");
    } else if (opts.layout === "calendar") {
      renderCalendar(root, ctx, () => calendarTasks(ctx, opts), today, opts, () => ctx.redraw());
    } else if (opts.layout === "board") {
      // Board folgt der Gruppierung (Status/Label/Priorität/Projekt) – wie die vollen Seiten.
      // Termine haben hier keine Spalte (kein Tages-Board) → sie erscheinen im Listen-/Kalender-Layout.
      renderKanbanBoard(root, ctx, opts.showDone ? [...open, ...doneToday] : open, today, opts, { today: true });
    } else {
      // Wie in renderPageBody: jede Sektion bestimmt ihre Wirte aus ihrer eigenen Menge, sonst
      // fallen Unteraufgaben zwischen offen und erledigt hindurch (s. dort).
      const subs = effectiveSubtasks(opts);
      const present = nestingHosts(plugin, open, subs);
      const doneHosts = nestingHosts(plugin, doneToday, subs);
      // Heute-Liste-Default = „Datum": „Keine"(none) und „Datum" liefern denselben Überfällig/Heute-Split,
      // deshalb ist „Keine" hier ausgeblendet (s. viewPanel) und beide Werte laufen über DIESEN einen Pfad.
      const group = opts.group === "none" ? "date" : opts.group;
      // „Das eigene Datum gewinnt" (s. agendaOwnRow): bei Datums-/Deadline-Sektionen steht eine
      // Unteraufgabe mit eigenem Wert in IHRER Sektion – sonst fehlte das Kind mit Fälligkeit
      // heute in „Heute", wenn sein Parent in „Überfällig" sitzt.
      const ownRow = agendaOwnRow(group);
      if (group === "date") {
        // Default: die semantischen Sektionen Überfällig/Heute (nach opts.sort sortiert).
        // Die Termine des Tages hängen an „Heute" (Überfällig ist vergangen, dort ergäben sie keinen Sinn).
        // „Heute"-Kopf im Datumsstil „18. Jul · Heute · Samstag" (wie in „Demnächst").
        // Leere Sektionen weglassen – wie der Datums-Zweig (filterGroups(...).filter(tasks.length)):
        // kein „Überfällig · 0" und kein leeres „Heute". „Heute" bleibt aber, wenn Termine dranhängen
        // (die zählen mit, auch ohne Aufgabe für heute).
        if (visibleRows(overdue, present, ownRow).length) {
          const overdueHead = section(root, ctx, t("sec_overdue"), sortTasks(overdue, opts.sort, opts.sortDir, orderKey(plugin)), today, false, false, present, [], "", ownRow);
          rescheduleButton(overdueHead, plugin, overdue);   // verschiebt ALLE überfälligen, auch die verschachtelten
        }
        if (visibleRows(todayTasks, present, ownRow).length || todayEv.length) {
          section(root, ctx, groupLabel(today, today), sortTasks(todayTasks, opts.sort, opts.sortDir, orderKey(plugin)), today, false, false, present, todayEv, today, ownRow);
        }
      } else {
        // Aktive Gruppierung ersetzt den Überfällig/Heute-Split. Die Termine gehören zu „Heute":
        // in die Heute-Gruppe hinein, sonst als eigene „Heute"-Box direkt NACH „Überfällig"
        // (nie oben über allem schwebend).
        const todayHead = groupLabel(today, today);   // „18. Jul · Heute · Samstag" (Titel der Heute-Gruppe)
        const gs = groupTasks(sortTasks(open, opts.sort, opts.sortDir, orderKey(plugin)), opts.group, today, opts, labelOrderOf(plugin, open, opts.group))
          .filter((g) => visibleRows(g.tasks, present, ownRow).length);
        const hasToday = gs.some((g) => g.title === todayHead);
        const overdueIdx = gs.findIndex((g) => g.title === t("sec_overdue"));
        const eventsSection = (): void => { section(root, ctx, todayHead, [], today, false, false, present, todayEv, today, ownRow); };
        if (todayEv.length && !hasToday && overdueIdx === -1) eventsSection();   // nichts davor → oben
        gs.forEach((g, i) => {
          const isToday = g.title === todayHead;
          section(root, ctx, g.title, g.tasks, today, false, false, present, isToday ? todayEv : [], isToday ? today : "", ownRow);
          // Kein Sammel-„Verschieben" hier: „Datum" läuft über den Split-Zweig oben (dort trägt Überfällig
          // seinen Knopf). Bei „Deadline" stammt die gleichnamige Gruppe aus `scheduled` – eine Deadline
          // verhandelt man einzeln, nicht per Sammelklick; „Priorität"/„Label"/„Projekt" ohnehin fachfremd.
          if (todayEv.length && !hasToday && i === overdueIdx) eventsSection();   // direkt nach „Überfällig"
        });
      }
      if (opts.showDone && visibleRows(doneToday, doneHosts).length) section(root, ctx, t("sec_done"), doneToday, today, true, false, doneHosts);
    }
  } else if (view === "demnaechst") {
    // „Demnächst" ist eine reine, datierte Zukunfts-Agenda: KEINE undatierten (die gehören in
    // Eingang/Projekt bzw. später „Irgendwann") und KEINE erledigten (gehören in „Erledigt").
    const opts = ctx.opts;
    // Der Ansichtsfilter greift PRO TAG; Tage, von denen nichts übrig bleibt, verschwinden ganz
    // (sonst stünden leere Datums-Überschriften in der Agenda).
    const groups = idx.upcomingByDate(today)
      .map((g) => ({ ...g, tasks: ctx.filter(g.tasks) })).filter((g) => g.tasks.length);
    // Termine des Vorschauzeitraums (read-only). Der Feed lädt diesen Bereich nach (Listen-Layout
    // stößt ihn sonst nicht an). Ein Tag MIT Terminen, aber OHNE Aufgabe, bekommt so trotzdem seine
    // Gruppe – „Demnächst" wird so zur ehrlichen Wochenplanungs-Fläche.
    const eventEnd = upcomingEventEnd(plugin, today);
    plugin.gcalFeed?.setRange(today, eventEnd);   // LADEN ab heute – „Heute" braucht denselben Feed
    // ANZEIGEN erst ab morgen: „Demnächst" beginnt bei morgen, und das muss für Termine genauso
    // gelten wie für Aufgaben. Sonst entstand allein wegen eines heutigen Termins eine „Heute"-
    // Gruppe in einer Ansicht, die Heutiges gar nicht zeigt – doppelt zur Heute-Liste.
    // Wie in „Heute": bei aktivem Ansichtsfilter keine Termine (sie können kein Kriterium erfüllen).
    const evByDate = hasCriteria(ctx.crit) ? new Map<string, DayEvent[]>() : feedEventsByDate(plugin, addDays(today, 1), eventEnd);
    if (!groups.length && !evByDate.size) {
      if (hasCriteria(ctx.crit)) filterEmptyState(root, ctx);
      else emptyState(root, VIEW_ICON.demnaechst, "empty_nothing_scheduled");
    } else if (opts.layout === "calendar") {
      renderCalendar(root, ctx, () => calendarTasks(ctx, opts), today, opts, () => ctx.redraw());
    } else if (opts.layout === "board") {
      // Demnächst gruppiert wie Heute – Default Datum: ein gespeichertes „none" wird zu „date"
      // (Spalte je Datum), jede andere Wahl (Label/Priorität/Projekt/Deadline) gilt wie sonst.
      renderKanbanBoard(root, ctx, groups.flatMap((g) => g.tasks), today, { ...opts, group: opts.group === "none" ? "date" : opts.group }, {});
    } else {
      // Gruppierung wie Heute – Default Datum. „date"/„none": die chronologische Datums-Agenda (mit
      // Terminen). Jede andere Wahl (Label/Priorität/Projekt/Deadline) gruppiert die Aufgaben wie auf
      // den vollen Seiten; Termine haben dort keine Gruppe und entfallen (wie im Board).
      const flat = groups.flatMap((g) => g.tasks);
      const present = nestingHosts(plugin, flat, effectiveSubtasks(opts));
      const group = opts.group === "none" ? "date" : opts.group;
      // „Das eigene Datum gewinnt" (s. agendaOwnRow): das Kind mit Fälligkeit übermorgen steht
      // bei ÜBERMORGEN als eigene Zeile (nicht NUR unter seinem Parent am Morgen-Tag).
      const ownRow = agendaOwnRow(group);
      if (group === "date") {
        const tasksByDate = new Map(groups.map((g) => [g.date, g.tasks]));
        // Datums-Vereinigung: alle Aufgaben-Tage PLUS alle Tage mit Terminen, chronologisch.
        const dates = [...new Set([...tasksByDate.keys(), ...evByDate.keys()])].sort();
        for (const date of dates) {
          // Innerhalb eines Tages nach der gewählten Sortierung ordnen (wie „Heute" seine Sektionen) –
          // die Tages-REIHENFOLGE bleibt chronologisch (Agenda).
          const dayTasks = sortTasks(tasksByDate.get(date) ?? [], opts.sort, opts.sortDir, orderKey(plugin));
          const dayEv = evByDate.get(date) ?? [];
          // Ein Tag, dessen Aufgaben allesamt unter ihren Eltern hängen, hätte sonst einen Kopf
          // mit „· 0" – siehe sectionRows. Tage mit Terminen bleiben auch ohne Aufgabe stehen.
          if (visibleRows(dayTasks, present, ownRow).length || dayEv.length)
            section(root, ctx, groupLabel(date, today), dayTasks, today, false, false, present, dayEv, date, ownRow);
        }
      } else {
        const gs = groupTasks(sortTasks(flat, opts.sort, opts.sortDir, orderKey(plugin)), group, today, opts, labelOrderOf(plugin, flat, group))
          .filter((g) => visibleRows(g.tasks, present, ownRow).length);
        for (const g of gs) section(root, ctx, g.title, g.tasks, today, false, false, present, [], "", ownRow);
      }
    }
  } else if (view === "wiederkehrend") {
    renderRecurring(root, ctx, today);
  } else {
    // „Erledigt" uses the normal page shell, with its tabs supplied as header actions.
    const redraw = () => ctx.redraw();
    const top = pageTop(c, "list");
    pageHeader(top, ctx, top.createEl("h1", { text: ctx.doneTab === "trash" ? t("nav_trash") : viewTitle(view) }), {
      actions: (headActions) => {
        // Papierkorb-Aktionen im Kebab (nur im Papierkorb-Tab und nur wenn etwas drin ist).
        if (ctx.doneTab === "trash" && idx.cancelled().length) {
          const kebab = headActions.createEl("button", { cls: "bt-manage-btn" });
          tip(kebab, t("more_actions"));
          setIcon(kebab.createSpan(), "more-horizontal");
          kebab.onclick = (e) => {
            e.stopPropagation();
            const m = new Menu();
            m.addItem((mi) => mi.setTitle(t("trash_restore_all")).setIcon("archive-restore").onClick(() => void plugin.restoreAllCancelled()));
            m.addItem((mi) => mi.setTitle(t("trash_empty")).setIcon("trash-2").setWarning(true).onClick(() =>
              new ConfirmModal(plugin.app, { title: t("confirm_empty_trash_q"), confirmText: t("trash_empty") }, () => void plugin.emptyTrash()).open()));
            m.showAtMouseEvent(e);
          };
        }
        const tabs = headActions.createDiv({ cls: "bt-tabs" });
        const mkTab = (id: "done" | "trash", label: string): void => {
          const b = tabs.createEl("button", { cls: "bt-tab" + (ctx.doneTab === id ? " is-active" : ""), text: label });
          b.onclick = () => { ctx.setDoneTab(id); redraw(); };
        };
        mkTab("done", t("view_done"));
        mkTab("trash", t("nav_trash"));
      },
    });

    if (ctx.doneTab === "trash") {
      const items = idx.cancelled();
      if (!items.length) { emptyState(root, "trash-2", "empty_trash"); return; }
      // Liste identisch zur Erledigt-Liste (dieselben Task-Zeilen), nur im Papierkorb-Modus.
      section(root, ctx, t("nav_trash"), items, today, false, true);
    } else {
      const done = idx.done();
      // `present` mitgeben: sonst nimmt die Liste an, JEDE Unteraufgabe hänge schon unter ihrer
      // Hauptaufgabe – und lässt sie weg. Ist die Hauptaufgabe noch offen, steht sie hier aber
      // gar nicht, und die abgehakte Unteraufgabe war nirgends auffindbar. Mit `present` bekommt
      // sie eine eigene Zeile; nur wenn ihre Hauptaufgabe ebenfalls hier steht, bleibt sie unter
      // ihr eingeklappt (erreichbar über deren Fortschritts-Badge).
      const present = nestingHosts(plugin, done, effectiveSubtasks(ctx.opts));
      if (!visibleRows(done, present).length) emptyState(root, VIEW_ICON.erledigt, "empty_nothing_done");
      else section(root, ctx, t("sec_done"), done, today, false, false, present);
    }
  }
}

/** Offene wiederkehrende Aufgaben, gruppiert nach Intervall (Überschrift = Täglich/Wöchentlich/…). */
const RECUR_ORDER = ["recur_daily", "recur_weekly", "recur_monthly", "recur_quarterly", "recur_yearly"];
function recurKey(recurrence: string): string {
  const r = parseRecurrence(recurrence);
  if (r && r.unit === "day" && r.n === 1) return "recur_daily";
  if (r && r.unit === "week" && r.n === 1) return "recur_weekly";
  if (r && r.unit === "month" && r.n === 1) return "recur_monthly";
  if (r && r.unit === "month" && r.n === 3) return "recur_quarterly";
  if (r && r.unit === "year" && r.n === 1) return "recur_yearly";
  return "raw:" + recurrence;   // Sonderintervalle: eigene Gruppe mit dem Rohtext als Titel
}
function renderRecurring(root: HTMLElement, ctx: PageCtx, today: string): void {
  const plugin = ctx.plugin;
  const recs = plugin.index.open().filter((tk) => tk.recurrence);   // open() blendet archivierte Projekte aus
  if (!recs.length) { emptyState(root, VIEW_ICON.wiederkehrend, "empty_nothing_recurring"); return; }
  const groups = new Map<string, Task[]>();
  for (const tk of recs) {
    const key = recurKey(tk.recurrence ?? "");
    const arr = groups.get(key); if (arr) arr.push(tk); else groups.set(key, [tk]);
  }
  // Wie in der Erledigt-Ansicht: ohne `present` fiele jede wiederkehrende Unteraufgabe heraus,
  // deren Hauptaufgabe nicht selbst wiederkehrend ist (sie steht dann nicht in dieser Liste).
  const present = nestingHosts(plugin, recs, effectiveSubtasks(ctx.opts));
  const recurSection = (title: string, items: Task[]): void => {
    if (visibleRows(items, present).length) section(root, ctx, title, items.sort(byDue), today, false, false, present);
  };
  for (const key of RECUR_ORDER) {
    const items = groups.get(key);
    if (items) recurSection(t(key), items);
  }
  for (const [key, items] of groups) {
    // Klartext statt Rohregel – dieselbe Formulierung wie im Chip (recurrence.describeRecurrence).
    if (key.startsWith("raw:")) recurSection(describeRecurrence(key.slice(4)), items);
  }
}

/** Obsidians „Lesbare Zeilenlänge" respektieren (wie Markdown-Ansichten): Breite +
 *  Zentrierung über --file-line-width, wenn die Einstellung aktiv ist. */
function applyReadableWidth(c: HTMLElement, plugin: OpalTasksPlugin): void {
  const cfg = (plugin.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("readableLineLength");
  c.toggleClass("is-readable-line-width", cfg !== false);   // Standard in Obsidian = an
}

const byDue = (a: Task, b: Task) => (a.due ?? "").localeCompare(b.due ?? "");

/**
 * „Noch nicht nachgesehen" ist nicht „nichts da".
 *
 * Der Aufgaben-Index entsteht erst in `onLayoutReady`; die Ansichten zeichnen davor schon einmal.
 * Ohne diese Auskunft behauptete der Leerzustand beim Start eine halbe Sekunde lang „Nichts für
 * heute", bevor die Aufgaben erschienen – eine Aussage, die schlicht falsch war.
 *
 * Dieselbe Lehre wie bei den Labels in der Seitenleiste (1.39.1); dort wurde sie nur an EINER
 * Stelle gezogen. Der Wert wird zu Beginn jedes Aufbaus gesetzt, damit `emptyState` ihn nicht
 * durch zwölf Aufrufstellen gereicht bekommen muss.
 */
let indexReady = true;
const markIndexReady = (ctx: PageCtx): void => { indexReady = ctx.plugin.index.ready; };

/** Einheitlicher Leerzustand für alle Boards: zentriert im Restraum, Icon + Text (Akzentfarbe).
 *  Struktur/Position/Style sind bewusst identisch – die Optik steuert `.bt-empty` in styles.css.
 *  `action` hängt einen Knopf darunter (derzeit „Filter zurücksetzen"). */
function emptyState(root: HTMLElement, icon: string, key: string, action?: { label: string; onClick: () => void }): void {
  if (!indexReady) return;   // lieber gar nichts als eine falsche Auskunft
  root.addClass("is-empty");   // zentriert den Leerzustand (ersetzt :has(> .bt-empty))
  const box = root.createDiv({ cls: "bt-empty" });
  setIcon(box.createDiv({ cls: "bt-empty-ic" }), icon);
  box.createDiv({ cls: "bt-empty-text", text: t(key) });
  if (action) box.createEl("button", { cls: "bt-empty-btn", text: action.label }).onclick = action.onClick;
}

/**
 * Leerzustand einer Seite, deren Aufgaben der ANSICHTSFILTER verbirgt.
 *
 * Ohne ihn behauptete die Projektseite „Noch keine Aufgaben in diesem Projekt" – falsch und
 * erschreckend, und der einzige Weg zurück (das Anzeige-Panel) wäre nirgends erwähnt. Deshalb
 * benennt der Text die Ursache und der Knopf beseitigt sie an Ort und Stelle.
 */
function filterEmptyState(root: HTMLElement, ctx: PageCtx): void {
  emptyState(root, "filter", "empty_no_filter_match",
    { label: t("filter_clear"), onClick: () => ctx.setCriteria({ ...DEFAULT_CRITERIA }) });
}

/** The linked note's only generated surface is its footer board. Keep the project-level state and
 *  progress beside that board's backlink so the note itself can start directly with user prose. */
function embeddedProjectMeta(parent: HTMLElement, plugin: OpalTasksPlugin, project: ProjItem): void {
  const meta = parent.createDiv({ cls: "bt-project-embed-meta" });
  if (project.type === "project") {
    const select = meta.createEl("select", {
      cls: "bt-project-embed-status",
      attr: { "aria-label": t("chip_status"), title: t("chip_status") },
    });
    for (const status of boardStatuses()) {
      const option = select.createEl("option", { value: status.id, text: statusLabel(status.id) });
      if (status.id === project.workflowStatus) option.selected = true;
    }
    select.onchange = () => void plugin.updateProjectWorkflow(project.path, select.value, project.priority);

    const priority = priorityBucket(project.priority);
    if (priority !== "normal") {
      const priorityIndex = PRIOS.findIndex((candidate) => candidate.value === priority);
      if (priorityIndex >= 0) {
        const priorityEl = meta.createSpan({
          cls: "bt-project-embed-priority",
          text: `P${priorityIndex + 1}`,
          attr: { title: t(PRIOS[priorityIndex].key) },
        });
        priorityEl.dataset.priority = priority;
      }
    }
    const progress = plugin.index.projectProgress(project.path);
    const progressGroup = meta.createSpan({ cls: "bt-project-embed-progress" });
    createProjectProgress(progressGroup, progress,
      projectDisplayColor(project, listProjectsAndAreas(plugin.app).bereiche, plugin.settings.projectColorMode),
      "bt-project-embed-progress-ring");
    if (progress.total) progressGroup.createSpan({ cls: "bt-project-embed-progress-label", text: `${progress.done}/${progress.total}` });
  }
  if (!meta.childElementCount) meta.remove();
}

/** Projekt-Board: alle Aufgaben eines Projekts, nach Status/Datum gruppiert. */
export function renderProjectBoardInto(c: HTMLElement, ctx: PageCtx, projectPath: string): void {
  markIndexReady(ctx);
  const plugin = ctx.plugin;
  const today = todayStr();
  c.empty();
  c.addClass("bt-view");
  if (ctx.embedded) c.addClass("bt-project-embed"); else c.removeClass("bt-project-embed");
  applyReadableWidth(c, plugin);
  const root = c.createDiv({ cls: "bt-sizer bt-page-body bt-project-root" });
  const isInbox = projectPath === INBOX_KEY;   // eingebaute Eingang-Ansicht (keine Notiz)
  // The path is the stable relationship key; the frontmatter title is the user-facing name.
  // Renaming a project/area deliberately changes only that title, so never use the basename for
  // presentation when the record still exists.
  const name = isInbox ? "" : baseName(projectPath);
  // Kopf: Kebab-Menü (wie Sidebar-Rechtsklick); Eingang ist eine Systemansicht → kein Menü.
  const isArea = !isInbox && isAreaPath(plugin.app, projectPath);
  // ALLE (aktiv UND archiviert) durchsuchen: archivierte fehlen in listProjectsAndAreas, hätten also
  // kein Kebab -> man käme aus einer archivierten Projektseite nicht mehr heraus.
  const meta = isInbox ? null
    : (() => { const { active, archived } = listManaged(plugin.app); return [...active, ...archived].find((p) => p.path === projectPath) ?? null; })();
  const top = pageTop(c, ctx.opts.layout);
  const projItem: NavMenuItem | null = meta
    ? { sec: meta.type === "area" ? "areas" : "projects", key: meta.path, name: meta.name, hidden: meta.hidden, color: meta.color, type: meta.type, archived: meta.archived }
    : null;
  const projectLists = listProjectsAndAreas(plugin.app);
  const childProjects = meta?.type === "area" ? projectsInArea(meta, projectLists.projekte) : [];
  const displayColor = meta ? projectDisplayColor(meta, projectLists.bereiche, plugin.settings.projectColorMode) : null;
  const openTask = (add: HTMLElement): void => {
    if (meta?.type === "area") {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(t("btn_add_task")).setIcon("circle-plus")
        .onClick(() => openHeaderNewTask(ctx, root, add, baseName(meta.path), undefined, false, addDue(ctx), undefined, undefined, meta.id)));
      menu.addItem((item) => item.setTitle(t("create_project")).setIcon("list-checks")
        .onClick(() => new NewItemModal(plugin, "project", undefined, "name", { area: baseName(meta.path) }).open()));
      const rect = add.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
      return;
    }
    // A project's own workflow state describes the project, not the first state of a task created
    // inside it. In particular, an in-progress project must still create a to-do task here.
    openHeaderNewTask(ctx, root, add, isInbox ? undefined : name, undefined, false, addDue(ctx), firstOpenStatus(), meta?.priority, meta?.id);
  };
  const heading = ctx.embedded && meta
    ? top.createDiv({ cls: "bt-project-embed-identity" })
    : top.createEl("h1", { cls: !isInbox && !ctx.embedded ? "bt-record-heading" : "" });
  if (ctx.embedded && meta) {
    c.style.setProperty("--bt-project-context", displayColor || "var(--text-faint)");
    renderProjectIdentity(heading, { ...meta, color: displayColor }, () => void plugin.openOrActivatePage({ kind: "project", key: meta.path }));
    embeddedProjectMeta(heading, plugin, meta);
  } else if (!isInbox && !ctx.embedded) {
    const recordLabel = `Opal Tasks · ${t(meta?.type === "area" ? "context_area_record" : "context_project_record")}`;
    const recordIcon = heading.createSpan({
      cls: "bt-record-icon",
      attr: { "aria-label": recordLabel, title: recordLabel },
    });
    setIcon(recordIcon, entityIcon(meta?.type ?? "project", meta?.icon));
    heading.createSpan({ cls: "bt-record-title", text: projectDisplayName(meta?.name ?? name) });
  } else {
    heading.setText(isInbox ? t("nav_inbox") : projectDisplayName(name));
  }
  pageHeader(top, ctx, heading,
    { ...(projItem ? { menu: projItem } : {}), hideTitle: ctx.embedded && !meta, onAdd: openTask });
  if (!ctx.embedded) pageDesc(top, plugin, meta?.description, projItem);
  // Keep the companion-note bridge part of the list presentation only. Boards need their full
  // width for columns, and a positive mode rule prevents future layouts from inheriting it.
  if (!ctx.embedded && meta && ctx.opts.layout === "list") projectNotePreview(root, plugin, meta.path);

  // Eingang = alle „nicht einsortierten" Aufgaben (kein Projekt ODER Verweis auf Inbox).
  // ctx.filter davor: der Ansichtsfilter der Seite (Anzeige-Panel), siehe PageCtx.filter.
  const source = (): Task[] => ctx.filter(isInbox
    ? plugin.index.inbox()
    : meta?.type === "area"
      ? tasksInArea(plugin.index.all(), meta, childProjects)
      : plugin.index.all().filter((t) => t.project != null && baseName(t.project) === name));
  const tasks = source();
  const visibleTasks = tasks.filter((task) => isOpen(task.status) || (ctx.opts.showDone && isDone(task.status)));
  if (!visibleTasks.length && !(meta?.type === "area" && childProjects.length)) {
    if (hasCriteria(ctx.crit)) filterEmptyState(root, ctx);
    else if (isInbox) emptyState(root, "inbox", "empty_no_inbox_tasks");
    else if (isArea) emptyState(root, entityIcon("area"), "empty_no_area_tasks");
    else emptyState(root, entityIcon("project"), "empty_no_project_tasks");
    return;
  }
  if (meta?.type === "area" && ctx.opts.layout === "list") renderAreaList(root, ctx, meta, childProjects, source(), today);
  // The Area dashboard is richer than an ordinary task board, so keep it for the default
  // status grouping. As soon as the user chooses another grouping, use the ordinary board:
  // that choice must remain the horizontal axis even when priority swimlanes are enabled.
  else if (meta?.type === "area" && ctx.opts.layout === "board" && ctx.opts.group === "none") {
    renderAreaKanban(root, ctx, meta, childProjects, source(), today);
  }
  else renderPageBody(root, ctx, source, ctx.opts, today, isInbox ? { project: null } : { project: name, projectId: meta?.id, status: meta?.workflowStatus, priority: meta?.priority },
      () => noteHeadSig(plugin, isInbox ? null : projectPath));
}

/** The project dashboard remains the primary surface; this compact bridge opens (or creates) the
 *  ordinary companion note. Its prose is loaded lazily so the synchronous task render never waits
 *  on a vault read. If the page has already redrawn by then, the detached card is left untouched. */
function projectNotePreview(root: HTMLElement, plugin: OpalTasksPlugin, projectPath: string): void {
  const linked = plugin.linkedCollectionNote(projectPath);
  const card = root.createEl("button", {
    cls: "bt-project-note-preview" + (linked ? "" : " is-empty"),
    attr: { type: "button", "aria-label": t(linked ? "menu_open_linked_note" : "menu_create_linked_note") },
  });
  const icon = card.createSpan({ cls: "bt-project-note-preview-icon" });
  setIcon(icon, linked ? "file-text" : "file-plus-2");
  const copy = card.createSpan({ cls: "bt-project-note-preview-copy" });
  copy.createSpan({ cls: "bt-project-note-preview-title", text: t(linked ? "project_notes" : "project_notes_add") });
  const arrow = card.createSpan({ cls: "bt-project-note-preview-arrow" });
  setIcon(arrow, "chevron-right");
  card.onclick = () => void plugin.openOrCreateCollectionNote(projectPath);

  if (!linked) return;
  void plugin.app.vault.cachedRead(linked).then((content) => {
    if (!card.isConnected) return;
    const excerpt = linkedNoteExcerpt(content);
    if (!excerpt) return;
    const preview = copy.createSpan({ cls: "bt-project-note-preview-excerpt", text: excerpt });
    preview.setAttr("title", excerpt);
  }).catch(() => undefined);
}

let draggedAreaProject: string | null = null;

function shownAreaTasks(tasks: Task[], showDone: boolean): Task[] {
  return tasks.filter((task) => isOpen(task.status) || (showDone && isDone(task.status)));
}

/** Area containers keep their project context, but task history should retain the same reading
 *  order as ordinary pages: actionable work first, then most recently completed work. */
function sortAreaTasks(tasks: Task[], ctx: PageCtx): Task[] {
  const open = sortTasks(tasks.filter((task) => isOpen(task.status)), ctx.opts.sort, ctx.opts.sortDir, orderKey(ctx.plugin));
  const done = tasks.filter((task) => isDone(task.status))
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  return [...open, ...done];
}

function projectMatchesAreaFilter(project: ProjItem, ctx: PageCtx): boolean {
  const c = ctx.crit;
  if (c.statuses.length && !c.statuses.includes(project.workflowStatus)) return false;
  if (c.statusesNot.includes(project.workflowStatus)) return false;
  const priority = priorityBucket(project.priority);
  if (c.priorities.length && !c.priorities.some((p) => priorityBucket(p) === priority)) return false;
  if (c.prioritiesNot.some((p) => priorityBucket(p) === priority)) return false;
  if (c.search && !(project.name + " " + project.description).toLowerCase().includes(c.search.toLowerCase())) return false;
  return true;
}

function hasTaskOnlyAreaCriteria(ctx: PageCtx): boolean {
  const c = ctx.crit;
  return c.range !== "any" || c.deadlineRange !== "any" || !!c.labels.length || !!c.labelsAll.length
    || !!c.labelsNot.length || !!c.projects.length || !!c.projectsNot.length || c.subtaskMode !== "any";
}

function renderAreaProjectHead(parent: HTMLElement, ctx: PageCtx, project: ProjItem, allTasks: Task[], body?: HTMLElement): void {
  const plugin = ctx.plugin;
  const head = parent.createDiv({ cls: "bt-area-project-head", attr: { role: "button", tabindex: "0" } });
  const collapsed = plugin.isProjectCollapsed(project.id);
  const chev = head.createSpan({ cls: "bt-area-project-chevron" });
  setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
  const projectIcon = head.createSpan({ cls: "bt-area-project-icon" });
  setIcon(projectIcon, project.icon);
  const projectColor = projectDisplayColor(project, listProjectsAndAreas(plugin.app).bereiche, plugin.settings.projectColorMode);
  if (projectColor) projectIcon.style.color = projectColor;
  const title = head.createSpan({ cls: "bt-area-project-title", text: project.name });
  title.onclick = (e) => { e.stopPropagation(); ctx.open({ kind: "project", key: project.path }); };
  // These values describe the project rather than forming part of its identity. Keeping them in
  // one group lets compact layouts move the whole group below the title instead of successively
  // squeezing the name as status, priority and progress are added.
  const meta = head.createSpan({ cls: "bt-area-project-meta" });
  meta.createSpan({ cls: "bt-area-project-status", text: statusLabel(project.workflowStatus) });
  if (priorityBucket(project.priority) !== "normal") meta.createSpan({ cls: "bt-area-project-priority", text: t(PRIOS.find((p) => p.value === priorityBucket(project.priority))?.key ?? "prio_4") });
  const progress = allTasks.filter((task) => task.project === project.path && !isTrashed(task.status));
  if (progress.length) meta.createSpan({ cls: "bt-area-project-progress", text: `${progress.filter((task) => isDone(task.status)).length}/${progress.length}` });
  const add = head.createEl("button", { cls: "bt-area-project-add", attr: { "aria-label": t("btn_add_task") } });
  setIcon(add, "plus");
  add.onclick = (e) => { e.stopPropagation(); plugin.openNewTask(baseName(project.path), undefined, false, project.workflowStatus, undefined, undefined, project.priority, project.id); };
  const toggle = (): void => {
    const next = !plugin.isProjectCollapsed(project.id);
    // Inline editors intentionally suppress full view redraws. Apply this interaction to the
    // mounted section immediately as well, so collapsing still works while a task is being edited.
    if (body) body.toggleClass("bt-hidden", next);
    chev.empty();
    setIcon(chev, next ? "chevron-right" : "chevron-down");
    plugin.setProjectCollapsed(project.id, next);
  };
  head.onclick = toggle;
  head.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  if (body) body.toggleClass("bt-hidden", collapsed);
  if (body) head.insertAdjacentElement("afterend", body);
}

function renderAreaList(root: HTMLElement, ctx: PageCtx, area: ProjItem, projects: ProjItem[], filtered: Task[], today: string): void {
  const plugin = ctx.plugin;
  const visible = shownAreaTasks(filtered, ctx.opts.showDone);
  const projectPaths = new Set(projects.map((p) => p.path));
  const direct = visible.filter((task) => task.project === area.path);
  const invisibleProjectTasks: Task[] = [];
  for (const project of plugin.sortProjItems("projects", projects)) {
    const projectVisible = isOpen(project.workflowStatus) || (ctx.opts.showDone && isDone(project.workflowStatus));
    const tasks = visible.filter((task) => task.project === project.path);
    if (!projectVisible) { invisibleProjectTasks.push(...tasks); continue; }
    if (!projectMatchesAreaFilter(project, ctx) || (hasTaskOnlyAreaCriteria(ctx) && !tasks.length)) {
      invisibleProjectTasks.push(...tasks);
      continue;
    }
    const progress = plugin.index.projectProgress(project.path);
    const priority = priorityBucket(project.priority);
    const priorityIndex = PRIOS.findIndex((candidate) => candidate.value === priority);
    const group = createListSection(root, {
      title: project.name,
      className: "bt-area-project-section",
      headerClassName: "bt-area-project-head",
      listClassName: "bt-area-project-tasks",
      renderLeading: (leading) => {
        createProjectProgress(leading, progress,
          projectDisplayColor(project, [area], plugin.settings.projectColorMode),
          "bt-area-project-progress-ring");
      },
      onTitleClick: () => ctx.open({ kind: "project", key: project.path }),
      renderMeta: (meta) => {
        if (priority !== "normal" && priorityIndex >= 0) {
          const priorityEl = meta.createSpan({
            cls: "bt-area-project-priority",
            text: `P${priorityIndex + 1}`,
            attr: { title: t(PRIOS[priorityIndex].key) },
          });
          priorityEl.dataset.priority = priority;
        }
        meta.createSpan({
          cls: "bt-area-project-progress",
          text: isDone(project.workflowStatus) ? statusLabel(project.workflowStatus)
            : progress.total ? `${progress.done}/${progress.total}` : statusLabel(project.workflowStatus),
        });
      },
      add: {
        label: t("btn_add_task"),
        onClick: () => plugin.openNewTask(baseName(project.path), undefined, false, project.workflowStatus, undefined, undefined, project.priority, project.id),
      },
      collapsible: {
        collapsed: plugin.isProjectCollapsed(project.id),
        onChange: (collapsed) => plugin.setProjectCollapsed(project.id, collapsed),
      },
    });
    const list = group.list;
    const hosts = nestingHosts(plugin, tasks, effectiveSubtasks(ctx.opts));
    for (const task of sortAreaTasks(visibleRows(tasks, hosts), ctx)) {
      // The containing project section supplies the hierarchy. Keep task depth at zero so project
      // membership never masquerades as a task parent link; genuine subtasks still recurse below.
      renderTask(list, ctx, task, today, 0, false, {
        subs: effectiveSubtasks(ctx.opts), manual: ctx.opts.sort === "manual", showDone: ctx.opts.showDone,
        hideProject: project.name, listTail: true,
      });
    }
    annotateSubtaskTree(list);
  }
  const loose = [...direct, ...invisibleProjectTasks, ...visible.filter((task) => task.project && !projectPaths.has(task.project) && task.project !== area.path)];
  if (loose.length) section(root, ctx, t("sec_tasks"), sortAreaTasks(loose, ctx), today,
    false, false, nestingHosts(plugin, loose, effectiveSubtasks(ctx.opts)), [], "", undefined, false,
    { className: "bt-area-loose-task-section", listClassName: "bt-area-project-tasks", listTail: true });
}

function attachAreaCellDnd(cell: HTMLElement, ctx: PageCtx, area: ProjItem, status: TaskStatus, priority?: Priority): void {
  cell.addEventListener("dragover", (e) => {
    if (!dragTask() && !draggedAreaProject) return;
    e.preventDefault();
    cell.addClass("is-drop");
  });
  cell.addEventListener("dragleave", (e) => { if (!cell.contains(e.relatedTarget as Node | null)) cell.removeClass("is-drop"); });
  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    cell.removeClass("is-drop");
    const projectPath = draggedAreaProject;
    draggedAreaProject = null;
    if (projectPath) {
      const project = listManaged(ctx.plugin.app).active.find((p) => p.path === projectPath);
      if (project) void ctx.plugin.updateProjectWorkflow(project.path, status, priority ?? project.priority);
      return;
    }
    const path = e.dataTransfer?.getData("text/plain") || dragTask();
    const task = path ? ctx.plugin.index.get(path) : undefined;
    endTaskDrag();
    if (!task) return;
    void (async () => {
      const children = projectsInArea(area, listProjectsAndAreas(ctx.plugin.app).projekte);
      const belongs = task.project === area.path || children.some((p) => p.path === task.project);
      if (!belongs) await ctx.plugin.setTaskProject(task, baseName(area.path));
      if (task.status !== status) await ctx.plugin.setTaskStatus(task, status);
      if (priority && priorityBucket(task.priority) !== priority) await ctx.plugin.setTaskPriority(task, priority);
    })();
  });
}

function renderAreaProjectCard(parent: HTMLElement, ctx: PageCtx, project: ProjItem, nested: Task[], allTasks: Task[], today: string,
  projection: BoardProjection): void {
  const draggable = projection !== "mobile";
  const card = parent.createDiv({ cls: "bt-area-project-card", attr: { draggable: String(draggable) } });
  const body = card.createDiv({ cls: "bt-area-project-card-tasks" });
  renderAreaProjectHead(card, ctx, project, allTasks, body);
  if (draggable) {
    card.addEventListener("dragstart", (e) => {
      if ((e.target as HTMLElement).closest(".bt-task")) return;
      draggedAreaProject = project.path;
      e.dataTransfer?.setData("application/x-opal_tasks-project", project.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => { draggedAreaProject = null; card.removeClass("is-dragging"); });
  }
  for (const task of nested) renderTask(body, ctx, task, today, 1, false, {
    flat: true, colId: project.workflowStatus, subs: effectiveSubtasks(ctx.opts), showDone: ctx.opts.showDone,
    draggable, boardMove: projection === "mobile",
  });
}

function renderAreaKanban(root: HTMLElement, ctx: PageCtx, area: ProjItem, projects: ProjItem[], filtered: Task[], today: string): void {
  const plugin = ctx.plugin;
  const swimlanes = ctx.opts.prioritySwimlanes !== false;
  const tasks = shownAreaTasks(filtered, ctx.opts.showDone);
  const hosts = nestingHosts(plugin, tasks, effectiveSubtasks(ctx.opts));
  const cards = visibleRows(tasks, hosts);
  const statuses = boardStatusAxes(boardStatuses(), ctx.opts.showDone, ctx.opts.showEmptyBoardAxes);
  const visibleProjects = plugin.sortProjItems("projects", projects).filter((project) =>
    statuses.some((s) => s.id === project.workflowStatus)
    && (isOpen(project.workflowStatus) || (ctx.opts.showDone && isDone(project.workflowStatus)))
    && projectMatchesAreaFilter(project, ctx)
    && (!hasTaskOnlyAreaCriteria(ctx) || filtered.some((task) => task.project === project.path)));
  const cellItems = (status: string, priority?: Priority): { projectsHere: ProjItem[]; standalone: Task[] } => {
    const projectsHere = visibleProjects.filter((p) => p.workflowStatus === status
      && (!priority || priorityBucket(p.priority) === priority));
    const nestedPaths = new Set<string>();
    for (const project of projectsHere) {
      cards.filter((task) => priority ? taskMatchesProjectCell(task, project)
        : task.project === project.path && task.status === project.workflowStatus)
        .forEach((task) => nestedPaths.add(task.path));
    }
    return {
      projectsHere,
      standalone: cards.filter((task) => task.status === status
        && (!priority || priorityBucket(task.priority) === priority) && !nestedPaths.has(task.path)),
    };
  };
  const columns: UnifiedBoardColumn[] = statuses.map((status) => ({
    id: status.id, title: statusLabel(status.id), tint: statusTint(status.id),
    count: (lane) => {
      const items = cellItems(status.id, lane?.id as Priority | undefined);
      return items.projectsHere.length + items.standalone.length;
    },
  }));
  const lanes: UnifiedBoardLane[] | undefined = swimlanes
    ? PRIOS.map((priority, index) => ({ id: priority.value, label: t(priority.key), shortLabel: `P${index + 1}` }))
    : undefined;
  renderUnifiedBoard(root, ctx, {
    key: "area|" + area.path,
    columns,
    lanes,
    setupCell: (cell, column, lane, projection) => {
      if (projection !== "mobile") attachAreaCellDnd(cell, ctx, area, column.id, lane?.id as Priority | undefined);
    },
    renderCell: (cell, column, lane, projection) => {
      const priority = lane?.id as Priority | undefined;
      const { projectsHere, standalone } = cellItems(column.id, priority);
      for (const project of projectsHere) {
        const nested = cards.filter((task) => priority
          ? taskMatchesProjectCell(task, project)
          : task.project === project.path && task.status === project.workflowStatus);
        renderAreaProjectCard(cell, ctx, project, nested, plugin.index.all(), today, projection);
      }
      for (const task of standalone) renderTask(cell, ctx, task, today, 0, false, {
        flat: true, colId: column.id, subs: effectiveSubtasks(ctx.opts), showDone: ctx.opts.showDone,
        draggable: projection !== "mobile", boardMove: projection === "mobile",
      });
    },
    onAdd: (column, lane) => plugin.openNewTask(baseName(area.path), undefined, false,
      column.id, undefined, undefined, (lane?.id as Priority | undefined) ?? "normal", area.id),
  });
}

/** Label-Board: alle Aufgaben mit einem Label, nach Status/Datum gruppiert (wie Projekt-Board). */
export function renderLabelBoardInto(c: HTMLElement, ctx: PageCtx, label: string): void {
  markIndexReady(ctx);
  const plugin = ctx.plugin;
  const today = todayStr();
  c.empty();
  c.addClass("bt-view");
  applyReadableWidth(c, plugin);
  const root = c.createDiv({ cls: "bt-sizer bt-page-body" });
  const top = pageTop(c, ctx.opts.layout);
  pageHeader(top, ctx, top.createEl("h1", { cls: "bt-label-title", text: "#" + label }), {
    menu: { sec: "labels", key: label, name: label, hidden: !plugin.isLabelVisible(label), color: plugin.getLabelColor(label) },
    onAdd: (add) => openHeaderNewTask(ctx, root, add, undefined, label, false, addDue(ctx)),
  });

  const source = (): Task[] => ctx.filter(
    plugin.index.all().filter((tk) => tk.labels.includes(label) && !plugin.index.isProjectArchived(tk.project)));
  const tasks = source();
  if (!tasks.some((task) => isOpen(task.status) || (ctx.opts.showDone && isDone(task.status)))) {
    if (hasCriteria(ctx.crit)) filterEmptyState(root, ctx);
    else emptyState(root, "hash", "empty_no_label_tasks");
    return;
  }
  renderPageBody(root, ctx, source, ctx.opts, today, { label },
    () => [label, plugin.getLabelColor(label) ?? "", plugin.isLabelVisible(label)].join("~"));
}

/** Reihenfolge der Label-Gruppen = die der Seitenleiste (Name · Anzahl · manuell), damit Liste
 *  und Board dieselbe Ordnung zeigen. Vorher sortierte die Liste stur alphabetisch, das Board
 *  dagegen über plugin.sortLabels – eine manuell sortierte Label-Leiste schlug sich also nur
 *  im Board nieder. Berücksichtigt nur Labels, die in dieser Menge überhaupt vorkommen. */
function labelOrderOf(plugin: OpalTasksPlugin, tasks: Task[], group: FilterGroup): string[] | undefined {
  if (group !== "label") return undefined;
  const names = [...new Set(tasks.flatMap((tk) => tk.labels))];
  return plugin.sortLabels(names.map((name) => ({ name }))).map((x) => x.name);
}

/** Generischer Seiten-Body (Boards): honoriert Layout · Sortieren · Gruppieren · Erledigte.
 *  `source` liefert die Aufgaben der Seite – als Funktion, damit der Kalender sie beim
 *  inkrementellen Nachzeichnen frisch holen kann, ohne die Seiten-Logik zu kennen. */
function renderPageBody(root: HTMLElement, ctx: PageCtx, source: () => Task[], opts: ViewOptions, today: string,
  add: BoardAdd, headSig: () => string): void {
  const plugin = ctx.plugin;
  const tasks = source();
  const open = tasks.filter((t) => isOpen(t.status));
  const done = tasks.filter((t) => isDone(t.status)).sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  if (opts.layout === "board") {
    renderKanbanBoard(root, ctx, opts.showDone ? [...open, ...done] : open, today, opts, add);
    return;
  }
  if (opts.layout === "calendar") {
    // Der Kalender bekommt die QUELLE (nicht die Liste): so kann er bei einer reinen Datenänderung
    // nur seine Aufgaben-Elemente nachziehen, statt die Seite neu aufzubauen (s. tryPatchCalendar).
    const calSource = (): Task[] => {
      const all = source();
      const o = all.filter((t) => isOpen(t.status));
      return opts.showDone ? [...o, ...all.filter((t) => isDone(t.status))] : o;
    };
    // Der Redraw hier ist für die Navigation nötig (Blättern ändert nur den transienten Anker).
    renderCalendar(root, ctx, calSource, today, opts, () => ctx.redraw(), add, headSig);
    return;
  }
  const subs = effectiveSubtasks(opts);
  // Bei Gruppierung „Datum"/„Deadline" gewinnt das eigene Datum der Unteraufgabe (agendaOwnRow) –
  // sie steht in IHRER Tages-Sektion, nicht nur verschachtelt beim Parent in dessen Sektion.
  const ownRow = agendaOwnRow(opts.group);
  /**
   * Welche Sektionen die Seite zeigt – reine Herleitung, zeichnet nichts. EINE Stelle, von der
   * sowohl die erste Zeichnung als auch der Abgleich (tryPatchList) leben; zwei Herleitungen
   * würden über kurz oder lang auseinanderlaufen und der Patch-Pfad zeigte etwas anderes als
   * der Neuaufbau.
   */
  const plan = (): { title: string; tasks: Task[]; hosts: Set<string>; ownRow?: (t: Task) => boolean; collapsible: boolean }[] => {
    const all = source();
    const offen = all.filter((tk) => isOpen(tk.status));
    const fertig = all.filter((tk) => isDone(tk.status)).sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
    const sorted = sortTasks(offen, opts.sort, opts.sortDir, orderKey(plugin));
    // JEDE Sektion bestimmt ihre Wirte aus IHRER eigenen Menge. Eine gemeinsame Menge liess beide
    // Richtungen verschwinden: eine erledigte Unteraufgabe mit offenem Parent fiel aus „Erledigt"
    // (der Parent galt als Wirt, stand aber in einer anderen Sektion), und umgekehrt rutschte eine
    // offene Unteraufgabe mit erledigtem Parent in die eingeklappte Erledigt-Sektion hinein.
    // Die Erledigt-ANSICHT macht es seit 1.20.3 schon so – hier war es uebersehen.
    const openHosts = nestingHosts(plugin, offen, subs);
    const doneHosts = nestingHosts(plugin, fertig, subs);
    const out: { title: string; tasks: Task[]; hosts: Set<string>; ownRow?: (tk: Task) => boolean; collapsible: boolean }[] = [];
    for (const g of groupTasks(sorted, opts.group, today, opts, labelOrderOf(plugin, sorted, opts.group))) {
      if (visibleRows(g.tasks, openHosts, ownRow).length) out.push({ title: g.title, tasks: g.tasks, hosts: openHosts, ownRow, collapsible: false });
    }
    if (opts.showDone && visibleRows(fertig, doneHosts).length) out.push({ title: t("sec_done"), tasks: fertig, hosts: doneHosts, collapsible: true });
    return out;
  };

  // Zeichnen und dabei aufzeichnen (s. `recording` bei tryPatchList).
  const rec: SectionRec[] = [];
  const outer = recording;
  recording = rec;
  try {
    for (const s of plan()) section(root, ctx, s.title, s.tasks, today, s.collapsible, false, s.hosts, [], "", s.ownRow,
      opts.group === "none" && !s.collapsible);
  } finally {
    recording = outer;
  }

  /** Nachziehen statt neu bauen: gleiche Sektionen in gleicher Reihenfolge -> nur die füllen,
   *  deren Signatur sich geändert hat. Jede strukturelle Abweichung -> false (voll neu bauen). */
  let patches = 0;
  const repaint = (): boolean => {
    // Der Patch-Pfad kehrt VOR dem Wechsel der Render-Component zurück (s. MainView.draw), lässt
    // also dieselbe stehen. Gerenderte Markdown-Titel hängen ihre Kindkomponenten dort ein und
    // werden beim Entfernen der Zeile nicht abgemeldet – nach vielen Patches summiert sich das.
    // Alle PATCH_LIMIT Durchgänge deshalb einmal regulär neu bauen; das räumt sie mit ab.
    if (++patches > PATCH_LIMIT) return false;
    const jetzt = plan();
    const dran = planDiff(rec, jetzt.map((s) => ({ title: s.title, sig: sectionSig(s.tasks, sigLookup(ctx), { present: s.hosts, ownRow: s.ownRow }) })));
    if (!dran) return false;
    for (const i of dran) {
      const s = jetzt[i];
      rec[i].paintRows(visibleRows(s.tasks, s.hosts, s.ownRow));
      rec[i].sig = sectionSig(s.tasks, sigLookup(ctx), { present: s.hosts, ownRow: s.ownRow });
    }
    return true;
  };
  const host = root.parentElement;
  if (host) listMounts.set(host, { headSig, sig: frameSig(ctx, opts, headSig()), root, sections: rec, repaint });
}

/** Filter-Board: die Treffer eines gespeicherten Filters, sortiert/gruppiert nach seinen
 *  Optionen. Layout (Liste/Kanban) folgt – wie Projekte – dem globalen Umschalter. */
export function renderFilterBoardInto(c: HTMLElement, ctx: PageCtx, filterPath: string): void {
  markIndexReady(ctx);
  const plugin = ctx.plugin;
  const today = todayStr();
  c.empty();
  c.addClass("bt-view");
  applyReadableWidth(c, plugin);
  const root = c.createDiv({ cls: "bt-sizer bt-page-body" });
  const filter = readFilter(plugin.app, filterPath);
  if (!filter) { emptyState(root, "tag", "empty_no_filter"); return; }

  // Kopf: Titel + [Stift Kriterien-Editor] [Link „Filter"] [Anzeige].
  // ctx.opts statt filter.options: identisch bis auf das Layout, und DAS kann dieser Tab
  // überschreiben (s. MainView.setLayout) – filter.options kennt nur den Seiten-Standard.
  const opts = ctx.opts;
  const top = pageTop(c, opts.layout);
  const filterItem: NavMenuItem = { sec: "filters", key: filterPath, name: filter.name, hidden: filter.hidden, color: filter.color };
  pageHeader(top, ctx, top.createEl("h1", { text: filter.name }), {
    menu: filterItem,
    onAdd: (add) => openHeaderNewTask(ctx, root, add, undefined, undefined, false, addDue(ctx)),
  });
  pageDesc(top, plugin, filter.description, filterItem);

  // Kriterien filtern die Menge; renderPageBody übernimmt Layout/Sortieren/Gruppieren/Erledigte.
  const tasks = applyFilter(plugin.index, filter.criteria, opts, today);
  if (!tasks.some((task) => isOpen(task.status) || (opts.showDone && isDone(task.status)))) {
    emptyState(root, filter.icon, "empty_no_filter_tasks"); return;
  }
  renderPageBody(root, ctx, () => applyFilter(plugin.index, filter.criteria, opts, today), opts, today, {},
    () => JSON.stringify(readFilter(plugin.app, filterPath) ?? ""));
}

// ── Seiten-Kopf: Titel links, rechts eine Aktionsgruppe (Variante 02) ──
interface HeaderOpts {
  menu?: NavMenuItem;     // Kebab: Item-Kontextmenü (Board-Variante); fehlt → kein Kebab (z. B. Eingang)
  hideTitle?: boolean;
  onAdd?: (anchor: HTMLElement) => void;
  actions?: (root: HTMLElement) => void;
}
/** Shared page header: primary action, view options, then entity-specific overflow. Linked-note
 *  actions deliberately live in that overflow instead of claiming another permanent button. */
function pageHeader(root: HTMLElement, ctx: PageCtx, titleEl: HTMLElement, opts: HeaderOpts = {}): void {
  const plugin = ctx.plugin;
  const compact = isCompactPane(root);
  root.closest<HTMLElement>(".bt-view")?.toggleClass("bt-mobile", compact);
  const head = root.createDiv({ cls: "bt-board-head" });

  // On compact task pages the header is an app bar, not a second desktop toolbar squeezed into a
  // phone. The drawer owns secondary choices and the full identity; the bar keeps only navigation,
  // current context, Today and creation.
  if (compact && !ctx.embedded && pageInfo(ctx.page).tier !== "none" && !opts.actions) {
    head.addClass("bt-mobile-app-head");
    const fullTitle = titleEl.textContent ?? "";
    const menuBtn = head.createEl("button", { cls: "bt-mobile-head-menu", attr: { "aria-label": t("more_actions") } });
    setIcon(menuBtn, "menu");

    const identity = head.createDiv({ cls: "bt-mobile-head-identity" });
    if (opts.hideTitle) titleEl.remove(); else identity.appendChild(titleEl);
    const effectiveCalMode = ctx.opts.calMode === "week" ? "day" : ctx.opts.calMode;
    identity.createDiv({
      cls: "bt-mobile-head-status",
      text: ctx.opts.layout === "calendar"
        ? `${t("layout_calendar")} · ${t("cal_mode_" + effectiveCalMode)}`
        : t("layout_" + ctx.opts.layout),
    });

    const actions = head.createDiv({ cls: "bt-head-actions bt-mobile-head-actions" });
    // Projects and areas are already selected through the mobile sidebar. Their calendar shortcut
    // unexpectedly left that context for Today (and duplicated the calendar's own Today control).
    if (pageInfo(ctx.page).kind !== "project") {
      const today = actions.createEl("button", { cls: "bt-mobile-head-today", attr: { "aria-label": t("cal_today") } });
      setIcon(today, "calendar-check");
      tip(today, t("cal_today"));
      today.onclick = (event) => {
        event.stopPropagation();
        if (ctx.opts.layout === "calendar") resetCalendarToToday(ctx);
        else ctx.open({ kind: "view", key: "heute" });
      };
    }
    if (opts.onAdd) {
      const add = actions.createEl("button", { cls: "bt-page-add" });
      add.setAttr("aria-label", t("btn_add_task"));
      setIcon(add.createSpan({ cls: "bt-page-add-ic" }), "plus");
      add.onclick = (event) => { event.stopPropagation(); opts.onAdd?.(add); };
    }

    menuBtn.onclick = (event) => {
      event.stopPropagation();
      openViewPanel(menuBtn, ctx, {
        title: fullTitle,
        description: () => root.querySelector<HTMLElement>(".bt-page-desc:not(.is-empty)")?.textContent ?? "",
        ...(ctx.pageKey === "heute" && ctx.opts.layout === "calendar" ? { onAutoPlan: () => new AutoPlanModal(plugin).open() } : {}),
        ...(opts.menu ? { onMore: (anchor: HTMLElement) => {
          const menu = new Menu();
          buildItemMenu(menu, plugin, opts.menu!, "board");
          const rect = anchor.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        } } : {}),
      });
    };
    return;
  }

  if (opts.hideTitle) titleEl.remove();
  else head.appendChild(titleEl);
  const actions = head.createDiv({ cls: "bt-head-actions" });
  if (opts.onAdd) {
    const add = actions.createEl("button", { cls: "bt-page-add" });
    add.setAttr("aria-label", t("btn_add_task"));
    setIcon(add.createSpan({ cls: "bt-page-add-ic" }), "plus");
    add.createSpan({ cls: "bt-page-add-lbl", text: t("btn_add_task") });
    add.onclick = (e) => { e.stopPropagation(); opts.onAdd?.(add); };
  }
  if (pageInfo(ctx.page).tier !== "none") anzeigeButton(actions, ctx);
  if (opts.menu) {
    const it = opts.menu;
    const kebab = actions.createEl("button", { cls: "bt-manage-btn" });
    tip(kebab, t("more_actions"));
    setIcon(kebab.createSpan(), "more-horizontal");
    kebab.onclick = (e) => { e.stopPropagation(); const m = new Menu(); buildItemMenu(m, plugin, it, "board"); m.showAtMouseEvent(e); };
  }
  opts.actions?.(actions);
}

/** Kurzbeschreibung unter dem Seitentitel – die eine Zeile aus dem Frontmatter der Projekt-,
 *  Bereichs- oder Filternotiz. Ist sie leer, steht dort ein blasser Platzhalter, der in denselben
 *  Bearbeiten-Dialog führt, in dem das Feld liegt – so ist das Feld auffindbar, ohne dass man das
 *  Kontextmenü kennt. Ohne Eintrag (Eingang, eingebaute Ansichten) entsteht gar nichts. */
function pageDesc(root: HTMLElement, plugin: OpalTasksPlugin, text: string | undefined, item: NavMenuItem | null): void {
  // When disabled, render no placeholder either: the page shell then naturally closes around the
  // title. Content spacing is independent of this decision and lives on bt-content-group.
  if (!plugin.settings.showProjectDescription) return;
  const t2 = (text ?? "").trim();
  if (!t2 && !item) return;
  const el = root.createDiv({ cls: "bt-page-desc" + (t2 ? "" : " is-empty"), text: t2 || t("desc_add") });
  if (!item) return;   // ohne Eintrag kein Ziel – dann bleibt es reiner Text
  // Auch die gefüllte Beschreibung führt in den Dialog: Wer sie ändern will, klickt sie an,
  // statt den Umweg über das Kontextmenü zu suchen.
  el.setAttr("role", "button");
  el.setAttr("tabindex", "0");
  // Der Tooltip zeigt den VOLLEN Text – die Zeile ist auf eine Zeile begrenzt, Längeres wäre
  // sonst nur in der Notiz zu lesen. Beim Platzhalter gibt es nichts zu zeigen, dort nennt er
  // stattdessen das Ziel des Klicks.
  tip(el, t2 || t("menu_edit"));
  // „description": Wer die Beschreibung anklickt, will sie ändern – der Cursor gehört dorthin
  // und nicht in den Namen (s. NewItemModal.focusField).
  el.onclick = () => openEdit(plugin, item, "description");
  el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEdit(plugin, item, "description"); } };
}

/** Positionsketten-Schlüssel für die Sortierung „Manuell". Liegt im Index, weil er den Elter
 *  braucht – der in der zu sortierenden Liste gar nicht vorkommen muss. Wird an JEDEN
 *  sortTasks-Aufruf gereicht, damit „Manuell" in Liste und Board dieselbe Ordnung ergibt. */
const orderKey = (plugin: OpalTasksPlugin) => (t: Task): number[] => plugin.index.orderKey(t);

// ── Kanban-Board (Spalten = Status, Karten per Drag-and-Drop verschiebbar) ──
/**
 * Innerhalb einer Spalte sortieren – nach derselben Wahl wie die Liste (Anzeige-Panel).
 * Vorher war das hier fest auf „Datum, dann Titel" verdrahtet: die Spalten stammen aus 1.2.0,
 * die Sortierrichtung kam erst mit 1.13.0 dazu und wurde nie nachgezogen. Sortieren/Richtung
 * standen im Board also im Panel, ohne etwas zu bewirken.
 *
 * Ausnahme bleibt die „erledigt"-Spalte: zuletzt Abgehaktes oben – wie die „Erledigt"-Sektion
 * der Liste. Eine Spalte aus fertigen Aufgaben beantwortet „was ist zuletzt passiert?", nicht
 * „was kommt als Nächstes?"; eine Sortierung nach Fälligkeit hilft dort niemandem.
 */
function sortColumn(list: Task[], kind: StatusKind, sort: FilterSort, dir: SortDir,
  key: (t: Task) => number[]): Task[] {
  if (kind === "done") return [...list].sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  return sortTasks(list, sort, dir, key);
}

// ── Generisches Spalten-Modell: das Board folgt der Gruppierung ──
// Fundament für Status, Label, Priorität, Projekt und Datumsachsen.
/** Basis-Kontext fürs „+ Aufgabe" einer Spalte (die Spalten-Dimension setzt die Spalte selbst). */
interface BoardAdd { project?: string | null; projectId?: string | null; label?: string; today?: boolean; status?: TaskStatus; priority?: Priority; }
interface BoardColumn {
  id: string;                                   // stabile Spalten-ID (Status-ID bzw. Label-Name / NO_LABEL)
  title: string;
  tint: string;                                 // Kopf-Punkt-Farbe
  kind: StatusKind;                             // steuert sortColumn (Nicht-Status = "open")
  has: (tk: Task) => boolean;                   // gehört die Aufgabe in diese Spalte?
  onDrop?: (tk: Task, fromColId: string) => void | Promise<void>; // Loslassen aus Spalte fromColId; fehlt = kein Drop-Ziel
  onAdd?: (priority?: Priority) => void;         // „+ Aufgabe" in dieser Spalte; fehlt = kein „+" (z. B. „Überfällig")
}

/** One Kanban system, projected according to available pane width. Page-specific adapters only
 * provide axes and card contents; this renderer owns columns, headers, surfaces, selection and
 * responsive shape for Today, projects, Areas and priority swimlanes alike. */
interface UnifiedBoardLane { id: string; label: string; shortLabel?: string; }
interface UnifiedBoardColumn {
  id: string;
  title: string;
  tint: string;
  count(lane?: UnifiedBoardLane): number;
}
interface UnifiedBoardModel {
  key: string;
  columns: UnifiedBoardColumn[];
  lanes?: UnifiedBoardLane[];
  setupCell?(shell: HTMLElement, column: UnifiedBoardColumn, lane: UnifiedBoardLane | undefined,
    projection: BoardProjection): void;
  renderCell(list: HTMLElement, column: UnifiedBoardColumn, lane: UnifiedBoardLane | undefined,
    projection: BoardProjection): void;
  canAdd?(column: UnifiedBoardColumn, lane?: UnifiedBoardLane): boolean;
  onAdd?(column: UnifiedBoardColumn, lane?: UnifiedBoardLane): void;
  decorateHeader?(shell: HTMLElement, head: HTMLElement, column: UnifiedBoardColumn,
    columnsHost: HTMLElement, drive: (clientX: number | null) => void): void;
  pinned?(column: UnifiedBoardColumn): boolean;
  scrollKey?: string;
  columnAxisLabel?: string;
}

function selectedBoardValue(store: Map<string, string>, key: string, choices: readonly string[]): string {
  const saved = store.get(key);
  if (saved && choices.includes(saved)) return saved;
  const fallback = choices[0] ?? "";
  if (fallback) store.set(key, fallback);
  return fallback;
}

function renderBoardTabs(parent: HTMLElement, items: { id: string; label: string; count?: number }[],
  selected: string, choose: (id: string) => void, label: string): void {
  const tabs = parent.createDiv({ cls: "bt-board-axis-tabs", attr: { role: "tablist", "aria-label": label } });
  for (const item of items) {
    const button = tabs.createEl("button", {
      cls: "bt-board-axis-tab" + (item.id === selected ? " is-active" : ""),
      attr: { role: "tab", "aria-selected": String(item.id === selected), type: "button" },
    });
    button.createSpan({ text: item.label });
    if (item.count !== undefined) button.createSpan({ cls: "bt-board-axis-count", text: String(item.count) });
    button.onclick = () => choose(item.id);
  }
}

function renderUnifiedBoard(root: HTMLElement, ctx: PageCtx, model: UnifiedBoardModel): void {
  root.addClass("bt-sizer-board");
  const projection = boardProjection(root);
  const view = root.closest<HTMLElement>(".bt-view");
  if (view) view.dataset.boardProjection = projection;
  const allLanes = model.lanes?.length ? model.lanes : undefined;
  const { columns: visibleColumns, lanes } = visibleBoardAxes(model.columns, allLanes, ctx.opts.showEmptyBoardAxes);
  const board = root.createDiv({
    cls: `bt-kanban bt-unified-board is-${projection}${lanes ? " has-swimlanes" : ""}`,
  });
  board.style.setProperty("--bt-board-cols", String(Math.max(1, visibleColumns.length)));
  if (!visibleColumns.length) return;

  const selectionKey = viewKey(ctx, "board-axis|" + model.key);
  const addButton = (parent: HTMLElement, column: UnifiedBoardColumn, lane?: UnifiedBoardLane): void => {
    if (!model.onAdd || model.canAdd?.(column, lane) === false) return;
    const add = parent.createEl("button", { cls: "bt-kanban-add", attr: { type: "button" } });
    add.createSpan({ cls: "bt-add-icon" });
    add.createSpan({ text: t("btn_add_task") });
    add.onclick = () => model.onAdd?.(column, lane);
  };
  const header = (parent: HTMLElement, column: UnifiedBoardColumn, lane: UnifiedBoardLane | undefined,
    shell?: HTMLElement, columnsHost?: HTMLElement, drive?: (clientX: number | null) => void): HTMLElement => {
    const head = parent.createDiv({ cls: "bt-kanban-head bt-board-column-head" });
    head.createSpan({ cls: "bt-kanban-dot" }).style.background = column.tint;
    head.createSpan({ cls: "bt-kanban-title", text: column.title });
    head.createSpan({ cls: "bt-kanban-count", text: String(column.count(lane)) });
    if (shell && columnsHost && drive) model.decorateHeader?.(shell, head, column, columnsHost, drive);
    return head;
  };
  const cellBody = (shell: HTMLElement, column: UnifiedBoardColumn, lane?: UnifiedBoardLane): HTMLElement => {
    model.setupCell?.(shell, column, lane, projection);
    const list = shell.createDiv({ cls: "bt-kanban-list bt-board-cell-content" });
    model.renderCell(list, column, lane, projection);
    return list;
  };
  const renderColumn = (parent: HTMLElement, column: UnifiedBoardColumn, lane: UnifiedBoardLane | undefined,
    columnsHost: HTMLElement, drive: (clientX: number | null) => void, showHeader = true): void => {
    const shell = parent.createDiv({ cls: "bt-kanban-col bt-board-column" });
    shell.dataset.col = column.id;
    if (model.pinned?.(column)) shell.dataset.pin = "1";
    if (showHeader) header(shell, column, lane, shell, columnsHost, drive);
    cellBody(shell, column, lane);
    addButton(shell, column, lane);
  };
  const renderColumns = (lane?: UnifiedBoardLane): void => {
    const columns = board.createDiv({ cls: "bt-board-columns" });
    columns.style.setProperty("--bt-board-cols", String(Math.max(1, visibleColumns.length)));
    const drive = attachEdgeAutoscroll(columns);
    if (model.scrollKey) {
      columns.addEventListener("scroll", () => boardScroll.set(model.scrollKey!, columns.scrollLeft));
    }
    for (const column of visibleColumns) renderColumn(columns, column, lane, columns, drive);
    const saved = model.scrollKey ? boardScroll.get(model.scrollKey) : undefined;
    if (saved) columns.scrollLeft = saved;
  };

  if (projection === "desktop" && lanes) {
    const matrix = board.createDiv({ cls: "bt-board-matrix" });
    matrix.style.setProperty("--bt-board-cols", String(visibleColumns.length));
    matrix.createDiv({ cls: "bt-board-matrix-corner" });
    for (const column of visibleColumns) header(matrix, column, undefined);
    for (const lane of lanes) {
      const laneHead = matrix.createDiv({ cls: "bt-board-lane-head" });
      laneHead.createDiv({ cls: "bt-board-lane-title", text: lane.label });
      const laneCount = visibleColumns.reduce((n, col) => n + col.count(lane), 0);
      laneHead.createDiv({
        cls: "bt-board-lane-count",
        text: t(laneCount === 1 ? "count_task" : "count_tasks", laneCount),
      });
      for (const column of visibleColumns) {
        const shell = matrix.createDiv({ cls: "bt-board-cell" });
        cellBody(shell, column, lane);
        addButton(shell, column, lane);
      }
    }
    return;
  }

  if (projection === "tablet" && lanes) {
    const laneId = selectedBoardValue(boardLaneSelection, selectionKey, lanes.map((lane) => lane.id));
    const lane = lanes.find((item) => item.id === laneId) ?? lanes[0];
    renderBoardTabs(board, lanes.map((item) => ({ id: item.id, label: item.shortLabel ?? item.label })),
      lane.id, (id) => { boardLaneSelection.set(selectionKey, id); ctx.redraw(); }, t("chip_priority"));
    renderColumns(lane);
    return;
  }

  if (projection === "mobile") {
    const columnId = selectedBoardValue(boardColumnSelection, selectionKey, visibleColumns.map((column) => column.id));
    const column = visibleColumns.find((item) => item.id === columnId) ?? visibleColumns[0];
    renderBoardTabs(board, visibleColumns.map((item) => ({
      id: item.id, label: item.title,
      count: lanes ? lanes.reduce((n, lane) => n + item.count(lane), 0) : item.count(),
    })), column.id, (id) => { boardColumnSelection.set(selectionKey, id); ctx.redraw(); }, model.columnAxisLabel ?? t("chip_status"));
    if (lanes) {
      const stack = board.createDiv({ cls: "bt-board-mobile-lanes" });
      // Empty matrix rows add enormous vertical dead space on a phone, so the compact default
      // keeps only priorities that contain cards in the selected status. The explicit empty-axis
      // setting overrides that projection and exposes every configured lane here as well.
      for (const lane of lanes.filter((item) => ctx.opts.showEmptyBoardAxes || column.count(item) > 0)) {
        const section = stack.createDiv({ cls: "bt-board-mobile-lane" });
        const laneHead = section.createDiv({ cls: "bt-board-mobile-lane-head" });
        laneHead.createSpan({ text: lane.label });
        laneHead.createSpan({ cls: "bt-board-axis-count", text: String(column.count(lane)) });
        const shell = section.createDiv({ cls: "bt-board-cell" });
        cellBody(shell, column, lane);
      }
      addButton(board, column);
    } else {
      const columns = board.createDiv({ cls: "bt-board-columns" });
      const drive = attachEdgeAutoscroll(columns);
      renderColumn(columns, column, undefined, columns, drive, false);
    }
    return;
  }

  renderColumns();
}

const NO_LABEL = "\u0000nolabel";   // Sentinel-ID der „Ohne Label"-Spalte (kein gültiger Label-Name)

/** Status-Spalten (Standard-Kanban): Ziehen setzt den Status. */
function statusColumns(plugin: OpalTasksPlugin, add: BoardAdd): BoardColumn[] {
  return boardStatuses().map((col) => ({
    id: col.id, title: statusLabel(col.id), tint: statusTint(col.id), kind: col.kind,
    has: (tk: Task) => tk.status === col.id,
    onDrop: (tk: Task) => tk.status !== col.id ? plugin.setTaskStatus(tk, col.id) : undefined,
    onAdd: (priority) => plugin.openNewTask(add.project ?? undefined, add.label, add.today ?? false, col.id, undefined, undefined, priority ?? add.priority, add.projectId),
  }));
}

/** Label-Spalten (Gruppierung = Label): Ziehen TAUSCHT das Label (Quell-Spalten-Label raus,
 *  Ziel-Label rein) – andere Labels der Aufgabe bleiben. Spalten = die in der Ansicht VORKOMMENDEN
 *  Labels (in Seitenleisten-Reihenfolge), plus „Ohne Label" bei Bedarf. */
function labelColumns(plugin: OpalTasksPlugin, tasks: Task[], add: BoardAdd): BoardColumn[] {
  const present = tasks.flatMap((t) => t.labels);
  const names = plugin.sortLabels([...new Set(present)].map((name) => ({ name }))).map((x) => x.name);
  const cols: BoardColumn[] = names.map((name) => ({
    id: name, title: "#" + name, tint: plugin.getLabelColor(name) ?? "var(--bt-label)", kind: "open",
    has: (tk: Task) => tk.labels.includes(name),
    onDrop: (tk: Task, fromColId: string) => plugin.swapTaskLabel(tk, fromColId === NO_LABEL ? null : fromColId, name),
    onAdd: (priority) => plugin.openNewTask(add.project ?? undefined, name, add.today ?? false, add.status ?? firstOpenStatus(), undefined, undefined, priority ?? add.priority, add.projectId),
  }));
  if (tasks.some((t) => t.labels.length === 0)) {
    cols.push({
      id: NO_LABEL, title: t("no_label"), tint: "var(--text-muted)", kind: "open",
      has: (tk: Task) => tk.labels.length === 0,
      onDrop: (tk: Task, fromColId: string) => plugin.swapTaskLabel(tk, fromColId === NO_LABEL ? null : fromColId, null),
      onAdd: (priority) => plugin.openNewTask(add.project ?? undefined, undefined, add.today ?? false, add.status ?? firstOpenStatus(), undefined, undefined, priority ?? add.priority, add.projectId),
    });
  }
  return cols;
}


/** Prioritäts-Spalten (Gruppierung = Priorität): niedrigste links (P4→P1); Ziehen setzt die
 *  Priorität. low/lowest fallen unter „normal" (P4). */
function priorityColumns(plugin: OpalTasksPlugin, add: BoardAdd): BoardColumn[] {
  const eff = (p: Priority): Priority => (p === "low" || p === "lowest") ? "normal" : p;
  return KANBAN_PRIOS.map((p) => ({
    id: p.value, title: t(p.key), tint: p.color, kind: "open",
    has: (tk: Task) => eff(tk.priority) === p.value,
    onDrop: (tk: Task) => eff(tk.priority) !== p.value ? plugin.setTaskPriority(tk, p.value) : undefined,
    onAdd: () => plugin.openNewTask(add.project ?? undefined, add.label, add.today ?? false, add.status, undefined, undefined, p.value, add.projectId),
  }));
}

/** Projekt-Spalten (Gruppierung = Projekt): eine Spalte je vorkommendem Projekt/Bereich (+ „Kein
 *  Projekt"); Ziehen verschiebt die Aufgabe (Label/Status bleiben). */
function projectColumns(plugin: OpalTasksPlugin, tasks: Task[], add: BoardAdd): BoardColumn[] {
  const { bereiche, projekte } = listProjectsAndAreas(plugin.app);
  const byProjectName = new Map([...bereiche, ...projekte].map((p) => [p.name, p] as const));
  const colorOf = new Map(([...bereiche, ...projekte]).map((p) => [
    p.name, projectDisplayColor(p, bereiche, plugin.settings.projectColorMode),
  ] as const));
  // Nur ECHTE Projekte werden Spalten – „nicht einsortierte" (kein Projekt ODER Inbox-Verweis)
  // landen alle im einen Eingang-Bucket (unten), nie in einer eigenen Inbox-Spalte.
  const present = new Set(tasks.filter((t) => t.project && !isInboxLink(t.project)).map((t) => baseName(t.project!)));
  const ordered = [
    ...plugin.sortProjItems("areas", bereiche.filter((p) => present.has(p.name))),
    ...plugin.sortProjItems("projects", projekte.filter((p) => present.has(p.name))),
  ];
  const names = ordered.map((p) => p.name);
  for (const n of present) if (!names.includes(n)) names.push(n);   // Sicherheitsnetz (z. B. archivierte Liste)
  const cols: BoardColumn[] = names.map((name) => ({
    id: name, title: projectDisplayName(name), tint: colorOf.get(name) ?? "var(--bt-nav-project)", kind: "open",
    has: (tk: Task) => !!tk.project && baseName(tk.project) === name,
    onDrop: (tk: Task) => !tk.project || baseName(tk.project) !== name ? plugin.setTaskProject(tk, name) : undefined,
    onAdd: (priority) => {
      const project = byProjectName.get(name);
      plugin.openNewTask(name, add.label, add.today ?? false, project?.workflowStatus ?? add.status, undefined, undefined, priority ?? project?.priority ?? add.priority, project?.id);
    },
  }));
  if (tasks.some((t) => isInboxLink(t.project))) {
    cols.push({
      id: NO_PROJECT, title: t("nav_inbox"), tint: "var(--text-muted)", kind: "open",
      has: (tk: Task) => isInboxLink(tk.project),
      onDrop: (tk: Task) => !isInboxLink(tk.project) ? plugin.setTaskProject(tk, null) : undefined,   // in den Eingang = Projekt leeren
      onAdd: (priority) => plugin.openNewTask(undefined, add.label, add.today ?? false, add.status, undefined, undefined, priority ?? add.priority),
    });
  }
  return cols;
}

/** Datums-Spalten (Gruppierung „date" = due · „deadline" = scheduled): eine Spalte je exaktem Datum,
 *  spiegelt die Listen-Datumsgruppierung (dateColumnKeys). „Überfällig" ist ein berechneter Sammel-
 *  Bucket ohne setzbares Datum -> KEIN Drop-/„+"-Ziel (onDrop/onAdd weggelassen). „Ohne Datum" und die
 *  konkreten Datumsspalten sind Drop-Ziele: Ziehen setzt bzw. löscht das Datum (setTaskDate). */
function dateColumns(plugin: OpalTasksPlugin, cards: Task[], today: string, field: "due" | "scheduled", add: BoardAdd): BoardColumn[] {
  const dateOfTask = (tk: Task): string | null => tk.due;
  return dateColumnKeys(cards, today, field).map((key): BoardColumn => {
    if (key === "overdue") return {
      id: "overdue", title: t("sec_overdue"), tint: "var(--bt-overdue)", kind: "open",
      has: (tk: Task) => { const d = dateOfTask(tk); return !!d && d < today; },
      // kein onDrop/onAdd: „Überfällig" ist berechnet, hat kein einzelnes Zieldatum.
    };
    if (key === "nodate") return {
      id: "nodate", title: t("sec_no_date"), tint: "var(--text-muted)", kind: "open",
      has: (tk: Task) => !dateOfTask(tk),
      onDrop: (tk: Task) => dateOfTask(tk) ? plugin.setTaskDate(tk, field, "") : undefined,   // Datum löschen
      onAdd: (priority) => plugin.openNewTask(add.project ?? undefined, add.label, add.today ?? false, add.status, undefined, undefined, priority ?? add.priority, add.projectId),
    };
    const d = key.slice(2);   // "d:2026-07-15" -> "2026-07-15"
    return {
      id: key, title: groupLabel(d, today), tint: "var(--text-muted)", kind: "open",
      has: (tk: Task) => dateOfTask(tk) === d,
      onDrop: (tk: Task) => dateOfTask(tk) !== d ? plugin.setTaskDate(tk, field, d) : undefined,
      onAdd: (priority) => plugin.openNewTask(add.project ?? undefined, add.label, add.today ?? false,
        add.status, d, undefined, priority ?? add.priority, add.projectId),
    };
  });
}

/** Horizontales Edge-Autoscroll beim Karten-Drag (natives HTML5-DnD scrollt eigene Container in
 *  Chromium NICHT): Kommt der Cursor an den linken/rechten Rand des Boards, scrollt es fortlaufend –
 *  auch beim Stillhalten am Rand (die rAF-Schleife läuft mit der zuletzt gemeldeten Position weiter).
 *  Nur für eigene Karten (s. taskDrag.ts). Popout-sicher (reiner Element-Scroll). Selbst-Stopp, sobald die
 *  Zone verlassen ist, beim Drag-Ende ODER wenn das Board neu gerendert/entfernt wurde (`isConnected`).
 *  KEIN vertikales Autoscroll: Spalten scrollen intern und Drops sind positionsunabhängig – man muss
 *  beim Ziehen nie eine Spalte intern scrollen. */
/** Rand-Autoscroll fürs Board. Gibt `drive(clientX)` zurück, um dieselbe Mechanik von außen zu
 *  füttern (`null` stoppt) – Karten ziehen per HTML5-Drag, da feuert `dragover` von selbst; Spalten
 *  ziehen per Pointer-Events, da feuert `dragover` NIE. Ohne diese Ansteuerung stünde das Board beim
 *  Spalten-Ziehen still, und man käme mit der rechten Spalte nie an den linken Rand. */
function attachEdgeAutoscroll(board: HTMLElement): (clientX: number | null) => void {
  const EDGE = 56;   // Randzone (px)
  const MAX = 18;    // Höchstgeschwindigkeit (px/Frame)
  let hSpeed = 0, rafId = 0;
  const ramp = (dist: number): number => Math.min(MAX, Math.max(1, Math.ceil(((EDGE - dist) / EDGE) * MAX)));
  const tick = (): void => {
    if (!board.isConnected || !hSpeed) { rafId = 0; return; }
    board.scrollLeft += hSpeed;
    rafId = window.requestAnimationFrame(tick);
  };
  const stop = (): void => { hSpeed = 0; if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; } };
  const drive = (clientX: number | null): void => {
    if (clientX === null) { stop(); return; }
    const r = board.getBoundingClientRect();
    hSpeed = clientX < r.left + EDGE ? -ramp(clientX - r.left) : clientX > r.right - EDGE ? ramp(r.right - clientX) : 0;
    if (hSpeed && !rafId) rafId = window.requestAnimationFrame(tick);
  };
  board.addEventListener("dragover", (e) => { if (dragTask()) drive(e.clientX); });   // nur eigene Karten, kein Vault-/Text-Drag
  board.addEventListener("dragend", stop);
  board.addEventListener("drop", stop);
  return drive;
}

/** Sentinel-Spalten („Ohne Label"/„Kein Projekt") – bleiben immer hinten, nicht umsortierbar. */
const isSentinelCol = (id: string): boolean => id === NO_LABEL || id === NO_PROJECT;

/** Board-eigene Spalten-Reihenfolge anwenden (Option B, entkoppelt von der Sidebar): gespeicherte
 *  IDs zuerst in ihrer Reihenfolge, unbekannte (neue) Spalten behalten ihre Default-Position dahinter,
 *  Sentinel immer ganz hinten. Stabile Sortierung (JS Array.sort). */
function applyColumnOrder(cols: BoardColumn[], saved: string[] | undefined): BoardColumn[] {
  if (!saved?.length) return cols;
  const rank = new Map(saved.map((id, i) => [id, i] as const));
  return [...cols].sort((a, b) => {
    const pa = isSentinelCol(a.id) ? 1 : 0, pb = isSentinelCol(b.id) ? 1 : 0;
    if (pa !== pb) return pa - pb;                                   // Sentinel ans Ende
    return (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity);
  });
}

/** Kanban-Spalte horizontal umsortieren – der ganze Spaltenkopf ist der Ziehgriff (Pointer-basiert,
 *  Maus + Touch, Popout-sicher). Persistiert die neue ID-Reihenfolge (ohne Sentinel) je Gruppierung,
 *  aber nur wenn sich die Reihenfolge tatsächlich geändert hat (bloßer Klick = No-Op). */
/** `drive` = Rand-Autoscroll des Boards (aus attachEdgeAutoscroll). Karten bekommen ihn beim Ziehen
 *  von selbst über `dragover`; ein Pointer-Drag kennt dieses Ereignis nicht, also fütterte ihn die
 *  Spalte hier direkt – damit sie sich beim Anfahren des linken/rechten Randes genauso verhält. */
function attachColumnDrag(colEl: HTMLElement, handle: HTMLElement, board: HTMLElement, groupKey: string,
                          plugin: OpalTasksPlugin, drive: (clientX: number | null) => void): void {
  const cols = (): HTMLElement[] => Array.from(board.children).filter((el): el is HTMLElement => el.instanceOf(HTMLElement) && el.hasClass("bt-kanban-col"));
  const orderIds = (): string[] => cols().filter((el) => el.dataset.pin !== "1").map((el) => el.dataset.col).filter((c): c is string => !!c);
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;   // nur Primärtaste/Touch
    ev.preventDefault();
    const doc = board.ownerDocument;
    const before = orderIds().join(",");
    let lastX = ev.clientX;
    const place = (x: number): void => {
      let placed = false;
      for (const sib of cols()) {
        if (sib === colEl || sib.dataset.pin === "1") continue;   // Sentinel bleibt hinten, nie verdrängen
        const r = sib.getBoundingClientRect();
        if (x < r.left + r.width / 2) { board.insertBefore(colEl, sib); placed = true; break; }
      }
      if (!placed) { const pin = cols().find((el) => el.dataset.pin === "1"); if (pin) board.insertBefore(colEl, pin); else board.appendChild(colEl); }
    };
    const onMove = (me: PointerEvent): void => {
      colEl.addClass("is-col-dragging");   // Drag-Optik erst bei echter Bewegung (Klick = kein Aufblinken)
      lastX = me.clientX;
      drive(lastX);      // Rand-Autoscroll wie beim Karten-Ziehen – Pointer-Drag feuert kein dragover
      place(lastX);
    };
    // Während der Autoscroll läuft, feuert bei ruhendem Zeiger kein pointermove – die Nachbarn
    // wandern aber unter ihm durch. Deshalb die Platzierung mit dem letzten X nachziehen, sonst
    // scrollt das Board zwar nach links, die Spalte bliebe aber hinten einsortiert.
    const onBoardScroll = (): void => place(lastX);
    const onUp = (): void => {
      colEl.removeClass("is-col-dragging");
      drive(null);       // Autoscroll anhalten
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      board.removeEventListener("scroll", onBoardScroll);
      const ids = orderIds();
      if (ids.join(",") !== before) void plugin.setBoardColumnOrder(groupKey, ids);   // nur bei echter Änderung
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
    board.addEventListener("scroll", onBoardScroll);
  });
}

/** Alle Zieh-Markierungen einer Liste entfernen (Einfügekante und Ausgrauen). */
function clearDropTarget(list: HTMLElement): void {
  for (const el of Array.from(list.querySelectorAll<HTMLElement>(".bt-task"))) {
    el.removeClass("is-drop-before"); el.removeClass("is-drop-after"); el.removeClass("is-drop-inert");
  }
}

/**
 * Vor WELCHE Zeile würde auf Höhe `y` losgelassen? Markiert die Stelle und gibt den Pfad zurück,
 * vor dem eingefügt wird – null für „ans Ende", undefined für „hier ist nichts einzusortieren".
 *
 * Es zählen nur GESCHWISTER der gezogenen Aufgabe: eine Position gilt unter Geschwistern, also
 * sind die Kanten dazwischen die einzigen sinnvollen Einfügestellen. Eine Unteraufgabe lässt sich
 * damit nicht zwischen fremde Aufgaben ziehen – sie bliebe ohnehin im Slot ihres Elters.
 *
 * Damit das SICHTBAR ist, werden alle übrigen Zeilen währenddessen ausgegraut. Ohne das sieht eine
 * gemischte Spalte gleichförmig aus, und die Markierung springt scheinbar grundlos über Karten
 * hinweg – das wirkt wie eine Sperre statt wie „gehört nicht zu dieser Ordnung". Der Fall tritt
 * real auf: Unteraufgaben einer ERLEDIGTEN Hauptaufgabe stehen als eigene Karten in der Spalte,
 * sortieren aber an der Position ihres unsichtbaren Elters.
 *
 * Dieselbe Funktion für Board und Liste. In beiden ist `list` der Container der Zeilen/Karten;
 * berechnen und markieren gehören zusammen, weil beides dieselbe Geschwister-Auswahl braucht.
 */
function showDropTarget(list: HTMLElement, dragged: Task, plugin: OpalTasksPlugin, y: number): string | null | undefined {
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".bt-task"));
  for (const el of rows) { el.removeClass("is-drop-before"); el.removeClass("is-drop-after"); }
  /** Gehört diese Zeile zur selben Geschwistergruppe? (Die gezogene selbst zählt dazu – sie soll
   *  nicht ausgegraut werden, sie trägt bereits `is-dragging`.) */
  const related = (el: HTMLElement): boolean => {
    const tk = el.dataset.path ? plugin.index.get(el.dataset.path) : undefined;
    return !!tk && tk.parent === dragged.parent;
  };
  for (const el of rows) el.toggleClass("is-drop-inert", !related(el));
  const siblings = rows.filter((el) => related(el) && el.dataset.path !== dragged.path);
  if (!siblings.length) return undefined;   // nichts einzusortieren – alles andere ist bereits grau
  for (const el of siblings) {
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) { el.addClass("is-drop-before"); return el.dataset.path ?? null; }
  }
  siblings[siblings.length - 1].addClass("is-drop-after");
  return null;   // unterhalb aller Geschwister -> ans Ende
}

/**
 * Zeile in der LISTE von Hand einsortieren – per Griff, nur bei Sortierung „Manuell".
 *
 * Bewusst NICHT attachRowDrag (ListManager): das ordnet das DOM live um und kennt keine
 * Hierarchie. In „Eingerückt" bliebe der Teilbaum einer gezogenen Hauptaufgabe zurück, und jede
 * Zeile wäre ein Ziel – auch eine, die kein Geschwister ist, worauf die Zeile nach dem Loslassen
 * zurückspränge. Hier bewegt sich stattdessen nur eine Markierung, wie im Board; die Zeile selbst
 * wandert erst beim Neuzeichnen. Damit stellt sich die Frage nach dem Teilbaum gar nicht.
 */
function attachTaskReorder(row: HTMLElement, grip: HTMLElement, list: HTMLElement, task: Task, plugin: OpalTasksPlugin): void {
  grip.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();          // nicht die Zeile anklicken (öffnet sonst das Modal)
    const doc = list.ownerDocument;   // Ziel-Fenster einmal festhalten (Popout-sicher)
    row.addClass("is-dragging");
    let before: string | null | undefined;
    const onMove = (me: PointerEvent): void => { before = showDropTarget(list, task, plugin, me.clientY); };
    const onUp = (): void => {
      row.removeClass("is-dragging");
      clearDropTarget(list);
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      if (before === undefined) return;   // kein Geschwister getroffen -> nichts tun
      void plugin.moveTaskBefore(task, before ? plugin.index.get(before) ?? null : null);
    };
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
  });
}

/**
 * Eine Spalte als Drop-Ziel verdrahten: Loslassen ruft die spaltenspezifische Mutation.
 * Bei Sortierung „Manuell" kommt die Einfügeposition dazu – dann bestimmt der Zug nicht nur die
 * Spalte, sondern auch den Platz darin. Bei jeder anderen Sortierung wäre das sinnlos: die
 * nächste Neuzeichnung würde die Handarbeit sofort wieder überschreiben.
 */
function setupColumnDnd(colEl: HTMLElement, col: BoardColumn, plugin: OpalTasksPlugin, manual: boolean,
  page: BoardAdd, lanePriority?: Priority): void {
  const listEl = (): HTMLElement | null => colEl.querySelector<HTMLElement>(".bt-kanban-list");
  const dragged = (): Task | undefined => { const p = dragTask(); return p ? plugin.index.get(p) : undefined; };
  colEl.addEventListener("dragover", (e) => {
    if (!dragTask()) return;                       // nur eigene Karten (kein Vault-Drag)
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    colEl.addClass("is-drop");
    const tk = manual ? dragged() : undefined;
    const l = listEl();
    if (l) { if (tk) showDropTarget(l, tk, plugin, e.clientY); else clearDropTarget(l); }
  });
  colEl.addEventListener("dragleave", (e) => {
    if (!colEl.contains(e.relatedTarget as Node | null)) {
      colEl.removeClass("is-drop");
      const l = listEl(); if (l) clearDropTarget(l);
    }
  });
  colEl.addEventListener("drop", (e) => {
    e.preventDefault();
    colEl.removeClass("is-drop");
    const path = e.dataTransfer?.getData("text/plain") || dragTask();
    const fromCol = dragFromCol();
    const task = path ? plugin.index.get(path) : undefined;
    const l = listEl();
    const before = manual && task && l ? showDropTarget(l, task, plugin, e.clientY) : undefined;
    if (l) clearDropTarget(l);
    endTaskDrag();
    if (!task) return;
    // Seite zuerst: Kommt die Karte aus einem ANDEREN Projekt (Planungs-Split), gehört sie durch
    // den Abwurf hierher – sonst bekäme sie zwar den Status dieser Spalte, bliebe aber drüben und
    // wäre auf diesem Board nicht zu sehen (s. applyDropPage).
    // Alles nacheinander und abgewartet: zwei processFrontMatter auf dieselbe Datei dürfen sich
    // nicht überholen, sonst geht einer der beiden Schreibvorgänge verloren.
    void applyDropPage(plugin, task, page).then(async () => {
      if (before !== undefined) {
        await plugin.moveTaskBefore(task, before ? plugin.index.get(before) ?? null : null);
      }
      await col.onDrop?.(task, fromCol ?? "");
      // Swimlanes are an independent second axis. Apply them after the column mutation so two
      // frontmatter writes cannot race and accidentally restore the old grouping value.
      if (lanePriority && priorityBucket(task.priority) !== lanePriority) {
        await plugin.setTaskPriority(task, lanePriority);
      }
    });
  });
}

/** Kanban-Board zeichnen: Spalten folgen immer der Gruppierung; aktivierte Prioritäts-Swimlanes
 *  kommen als unabhängige vertikale Achse hinzu. Ziehen/„+ Aufgabe" setzen beide Dimensionen. */
function renderKanbanBoard(root: HTMLElement, ctx: PageCtx, tasks: Task[], today: string,
  opts: ViewOptions, add: BoardAdd): void {
  const plugin = ctx.plugin;
  root.addClass("bt-sizer-board");   // Kanban nutzt volle Pane-Breite statt Lesebreite
  // Unteraufgaben: „Kompakt" nimmt ihre Karten heraus, die Hauptaufgabe trägt stattdessen das
  // Fortschritts-Badge. „Einzeln" (Vorgabe, bisheriges Verhalten) lässt jede als eigene Karte
  // stehen – nur so lässt sie sich einzeln in eine andere Status-Spalte ziehen.
  // Hat eine Unteraufgabe keine Hauptaufgabe auf diesem Board, bleibt sie auch im kompakten
  // Modus als Karte stehen (nestingHosts/visibleRows) – sonst wäre sie hier unerreichbar.
  const subs = effectiveSubtasks(opts);   // im Board-Layout schliesst das boardSubtasks() ein
  // Datums-/Deadline-Spalten: „das eigene Datum gewinnt" auch hier – eine datierte Unteraufgabe
  // bekommt ihre Karte in IHRER Tages-Spalte, auch wenn der Parent als Karte auf dem Board steht.
  // Karten sind flach (keine Verschachtelung) -> kein skip nötig, Doppelung kann nicht entstehen.
  const cards = visibleRows(tasks, nestingHosts(plugin, tasks, subs), agendaOwnRow(opts.group));
  // Gruppierungs-Schlüssel (stabil) für die board-eigene Spalten-Reihenfolge. Status follows the
  // canonical order from Settings; otherwise desktop drag order could disagree with the tablet
  // and mobile projections of the same board.
  const groupKey = opts.group === "label" ? "label" : opts.group === "priority" ? "priority" : opts.group === "project" ? "project"
    : opts.group === "date" || opts.group === "deadline" ? opts.group : "status";
  // Only labels and projects have a board-local order. Status is configured centrally; priority
  // is fixed lowest-to-highest (P4→P1) and dates are chronological.
  const reorderable = groupKey === "label" || groupKey === "project";
  // Spalten aus den SICHTBAREN Karten ableiten: sonst entstünde eine Label-/Projekt-Spalte für
  // eine Unteraufgabe, die im kompakten Modus gar keine Karte hat – eine leere Spalte ohne Grund.
  const baseCols = opts.group === "label" ? labelColumns(plugin, cards, add)
    : opts.group === "priority" ? priorityColumns(plugin, add)
      : opts.group === "project" ? projectColumns(plugin, cards, add)
        : opts.group === "date" ? dateColumns(plugin, cards, today, "due", add)
          : opts.group === "deadline" ? dateColumns(plugin, cards, today, "due", add)
            : statusColumns(plugin, add);
  const cols = reorderable ? applyColumnOrder(baseCols, plugin.settings.boardColumnOrder?.[groupKey]) : baseCols;
  // Scroll-Position über Re-Renders halten: nach einem Karten-Drop rendert die ganze View neu –
  // ohne das spränge das Board zurück nach links. Schlüssel = aktuelle Board-Identität (+ Gruppierung).
  const scrollKey = viewKey(ctx, ctx.pageKey + "|" + (opts.group ?? ""));
  const columnById = new Map(cols.map((column) => [column.id, column] as const));
  const tasksByColumn = new Map(cols.map((column) => [column.id,
    sortColumn(cards.filter((task) => column.has(task)), column.kind, opts.sort, opts.sortDir, orderKey(plugin))] as const));
  const isArea = ctx.page.kind === "project" && isAreaPath(plugin.app, ctx.page.key);
  const swimlanesEnabled = supportsPrioritySwimlanes(ctx.page)
    && (isArea ? opts.prioritySwimlanes !== false : opts.prioritySwimlanes === true);
  const lanes: UnifiedBoardLane[] | undefined = swimlanesEnabled
    ? PRIOS.map((priority, index) => ({ id: priority.value, label: t(priority.key), shortLabel: `P${index + 1}` }))
    : undefined;
  const tasksInCell = (columnId: string, lane?: UnifiedBoardLane): Task[] => {
    const columnTasks = tasksByColumn.get(columnId) ?? [];
    return lane ? columnTasks.filter((task) => priorityBucket(task.priority) === lane.id) : columnTasks;
  };
  const columns: UnifiedBoardColumn[] = cols.map((column) => ({
    id: column.id, title: column.title, tint: column.tint,
    count: (lane) => tasksInCell(column.id, lane).length,
  }));
  renderUnifiedBoard(root, ctx, {
    key: "kanban|" + ctx.pageKey + "|" + groupKey,
    columns,
    lanes,
    columnAxisLabel: t("filter_group_" + groupKey),
    scrollKey,
    pinned: (column) => isSentinelCol(column.id),
    decorateHeader: (shell, head, column, columnsHost, drive) => {
      if (!reorderable || isSentinelCol(column.id)) return;
      head.addClass("bt-col-draggable");
      setIcon(head.createSpan({ cls: "bt-kanban-grip" }), "grip-vertical");
      attachColumnDrag(shell, head, columnsHost, groupKey, plugin, drive);
    },
    setupCell: (shell, column, lane, projection) => {
      const source = columnById.get(column.id);
      // Grouping by priority while swimlanes are on intentionally keeps the selected grouping
      // as columns. Since both axes then describe the same field, only diagonal cells are valid.
      if (groupKey === "priority" && lane && lane.id !== column.id) return;
      if (projection !== "mobile" && source?.onDrop) {
        setupColumnDnd(shell, source, plugin, opts.sort === "manual", add,
          groupKey === "priority" ? undefined : lane?.id as Priority | undefined);
      }
    },
    renderCell: (listEl, column, lane, projection) => {
      const col = columnById.get(column.id)!;
      const colTasks = tasksInCell(column.id, lane);
    // Abhaken schreibt die Notiz -> der Index meldet -> MainView.draw() baut alles neu. Ohne das
    // Folgende spränge die Spalte dabei nach oben, und wer unten mehrere Karten abhaken will,
    // müsste nach jeder einzelnen erneut hinunterscrollen.
    const colKey = scrollKey + "|" + col.id;
    listEl.addEventListener("scroll", () => colScroll.set(colKey, listEl.scrollTop));
    // Bei Datums-Gruppierung ist die Spalte das Fälligkeitsdatum -> Datums-Chip in der Karte redundant
    // (Kompakt-Thema blendet ihn dann aus, außer Uhrzeit). „Überfällig"/„ohne Datum" bleiben unberührt.
    const dateImplied = groupKey === "date";
    const deadlineImplied = groupKey === "deadline";   // Spalte = Deadline-Datum -> Deadline-Chip in Karte redundant
    // Bei Projekt-Gruppierung ist die Spalte das Projekt (col.id = Name bzw. NO_PROJECT) -> @Projekt weglassen.
    const hideProject = groupKey === "project" ? col.id : undefined;
    // Datums-Spalten heißen „d:<ISO>" (s. dateColumns); „Überfällig"/„ohne Datum" tragen kein
    // einzelnes Datum und blenden deshalb nichts aus.
    const impliedDate = dateImplied && col.id.startsWith("d:") ? col.id.slice(2) : undefined;
    // Karten stückweise, wie die Zeilen einer Sektion (s. section): Ein Board zeichnete bisher
    // ALLE Karten ALLER Spalten auf einen Schlag – auch die der Spalten, die waagerecht weit
    // rechts außerhalb des Bildes liegen. Die Spalten teilen sich dasselbe Seiten-Budget.
    let gezeigt = 0;
    let kartePx = 0;                       // an DIESER Spalte gemessene Kartenhöhe
    let colSentinel: HTMLElement | null = null;
    const zeichne = (bis: number): void => {
      for (const tk of colTasks.slice(gezeigt, bis)) renderTask(listEl, ctx, tk, today, 0, false, {
        flat: true, colId: col.id, subs, impliedDate, deadlineImplied, hideProject,
        draggable: projection !== "mobile", boardMove: projection === "mobile",
      });
      gezeigt = bis;
    };
    /** Platzhalter für die noch fehlenden Karten – hält die Spaltenhöhe, damit die gemerkte
     *  Scrollposition unten weiterhin trifft und nur nachlädt, was ins Bild kommt. */
    const platzhalter = (): void => {
      if (gezeigt >= colTasks.length) { colSentinel?.remove(); colSentinel = null; return; }
      // Einmal messen, solange NUR Karten in der Liste stehen (der Wächter käme sonst mit hinein).
      if (!kartePx && gezeigt > 0) kartePx = listEl.scrollHeight / gezeigt;
      if (!colSentinel) colSentinel = listEl.createDiv({ cls: "bt-lazy-sentinel" });
      else listEl.appendChild(colSentinel);
      setLazyHeight(colSentinel, placeholderPx(colTasks.length, gezeigt, kartePx || CARD_PX));
      observeSentinel(colSentinel, () => {
        zeichne(Math.min(colTasks.length, gezeigt + CHUNK_ROWS));
        platzhalter();
        return gezeigt < colTasks.length;
      });
    };
    // Erste Füllung: so viele Karten, wie in DIESE Spalte passen, plus etwas Reserve.
    //
    // Ein Anteil am Seiten-Budget taugt hier nicht – das war der Fehler: Das Budget wird von
    // links nach rechts vergeben, die Spalten stehen aber NEBENeinander. Die vierte ist genauso
    // sichtbar wie die erste, bekam aber nichts mehr ab, startete leer und füllte sich erst,
    // wenn der Wächter zuschlug. Beim Abhaken in Spalte 1 blinzelten deshalb die Spalten
    // daneben. Waagerecht weit rechts stehende Spalten bleiben trotzdem billig: Ihr Wächter
    // schneidet nicht, weil der Beobachter die Beschneidung durch den Board-Scroller mitrechnet.
    zeichne(Math.min(colTasks.length, MESS_KARTEN));       // erst wenige – nur, um messen zu können
    if (gezeigt) kartePx = listEl.scrollHeight / gezeigt;  // noch ohne Wächter in der Liste
    const sicht = listEl.clientHeight || 600;              // 0, falls das Board noch kein Layout hat
    zeichne(Math.max(gezeigt, columnFirstPaint({ total: colTasks.length, viewportPx: sicht, itemPx: kartePx, fallbackPx: CARD_PX, reserve: 4 })));
    // War die Spalte gescrollt, wird BIS DAHIN gezeichnet, bevor die Position gesetzt wird.
    //
    // Ein Platzhalter allein genügt hier nicht: Solange die Spalte keine einzige Karte gezeichnet
    // hat (Budget aufgebraucht, etwa weil sie weit rechts steht), gibt es keine gemessene
    // Kartenhöhe – der Platzhalter beruht dann auf CARD_PX. Ist die echte Karte höher, ist die
    // Spalte zu kurz, der Browser klemmt die gemerkte Position auf sein Maximum, und man landet
    // wieder oben. Genau das passierte beim Verschieben einer Spalte, in der man weit unten war.
    //
    // Teuer ist das nicht: gezeichnet wird nur, was der Nutzer ohnehin schon durchgescrollt hat.
    const savedTop = colScroll.get(colKey);
    if (savedTop) {
      zeichne(Math.max(gezeigt, rowsForScroll({ savedTop, viewportPx: sicht, itemPx: kartePx || CARD_PX, chunk: CHUNK_ROWS, total: colTasks.length })));
    }
    platzhalter();
    // Erst nach den Karten: vorher hat die Liste keine Höhe und scrollTop würde auf 0 geklemmt.
    // Ist die Spalte inzwischen kürzer (Karte ist rausgefallen), klemmt der Browser auf das neue
    // Maximum – das Scroll-Ereignis schreibt den geklemmten Wert dann selbst zurück.
    if (savedTop) listEl.scrollTop = savedTop;
    },
    canAdd: (column, lane) => !!columnById.get(column.id)?.onAdd
      && !(groupKey === "priority" && lane && lane.id !== column.id),
    onAdd: (column, lane) => columnById.get(column.id)?.onAdd?.(lane?.id as Priority | undefined),
  });
}


/** Alle Pfade, die in dieser Ansicht real gerendert werden: die Anker-Aufgaben plus ihre
 *  (nicht abgebrochenen) Nachfahren, die renderTask verschachtelt zeichnet. Basis für
 *  Variante A – eine Unteraufgabe gilt als „im Parent aufgehoben", wenn ihr Parent hier
 *  gerendert wird; ist er es nicht, wird die Unteraufgabe eigenständig angezeigt. */
/**
 * Die Menge, unter der verschachtelt gezeichnet wird – EINZIGE Stelle, an der die gewählte
 * Unteraufgaben-Darstellung über die Verschachtelung entscheidet.
 *
 * Bei „standalone" (Board: „Einblenden"; in der Liste kommt der Wert nicht mehr an, s.
 * listSubtasks) ist sie bewusst LEER: dann gilt keine Hauptaufgabe als Wirt, also hängt keine
 * Unteraufgabe an ihr und jede bekommt ihre eigene Karte – in ihrer eigenen Spalte/Gruppe.
 * Wichtig ist die leere Menge statt `undefined`: `undefined` bedeutet in visibleRows das
 * GEGENTEIL (alle Unteraufgaben weglassen, s. Papierkorb).
 */
function nestingHosts(plugin: OpalTasksPlugin, anchors: Task[], mode: SubtaskDisplay): Set<string> {
  return mode === "standalone" ? new Set<string>() : renderedPaths(plugin, anchors);
}

// Die Datums-Ausnahme („das eigene Datum gewinnt", agendaOwnRow) kennt bewusst KEINE
// Anti-Doppelungs-Sperre beim Verschachteln: Aufklappen (per „Eingerückt" oder Badge-Klick)
// zeigt IMMER ALLE Kinder unterm Parent – auch die, die zusätzlich an ihrem eigenen Datum
// stehen. Das ist der Sinn des Aufklappens: die Aufgabe komplett durchgehen. Eine Sperre
// machte „Eingerückt" in reinen Datums-Agenden (Demnächst: alles datiert) zum toten Schalter.

function renderedPaths(plugin: OpalTasksPlugin, anchors: Task[]): Set<string> {
  const present = new Set<string>();
  const walk = (tk: Task): void => {
    if (present.has(tk.path)) return;
    present.add(tk.path);
    for (const kid of plugin.index.children(tk.path)) if (!isTrashed(kid.status)) walk(kid);
  };
  for (const a of anchors) walk(a);
  return present;
}

// ── Google-Termine als Bänder in der Liste (read-only) ─────────────────────────
/** Wie weit „Demnächst" Termine zeigt – einstellbar (`upcomingMonths`, Vorgabe 1 Monat).
 *  Geklemmt auf 1–12: schützt gegen eine von Hand verbogene data.json und hält den Wert
 *  innerhalb dessen, was MAX_MONTHS/MAX_STORE im Feed tatsächlich laden und halten können. */
function upcomingEventEnd(plugin: OpalTasksPlugin, today: string): string {
  const months = Math.min(12, Math.max(1, plugin.settings.gcalFeed?.upcomingMonths ?? 1));
  return addMonths(today, months);
}

/** Die Termine EINES Tages aus dem Feed, tagegenau zugeschnitten. Leer, wenn der Feed aus/leer ist. */
function dayEvents(plugin: OpalTasksPlugin, day: string): DayEvent[] {
  const feed = plugin.gcalFeed;
  if (!feed?.isActive()) return [];
  return bucketEvents(feed.eventsIn(day, day), [day]).get(day) ?? [];
}

/** Termine eines Zeitraums nach Tag gebündelt (für „Demnächst": auch Tage ohne Aufgabe). */
function feedEventsByDate(plugin: OpalTasksPlugin, from: string, to: string): Map<string, DayEvent[]> {
  const feed = plugin.gcalFeed;
  if (!feed?.isActive()) return new Map();
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return bucketEvents(feed.eventsIn(from, to), days);
}
const z2 = (n: number): string => String(n).padStart(2, "0");
const bandTime = (min: number): string => z2(Math.floor(min / 60)) + ":" + z2(min % 60);

/** Wie viele Termine ein Tag zeigt, bevor der Rest hinter „+N weitere" klappt. */
const GCAL_BAND_LIMIT = 5;
/** Aufgeklappte Tage (Schlüssel = Tag). Modul-Zustand, damit die Wahl ein Neuzeichnen übersteht –
 *  wie boardScroll/anchors; ein Reload startet wieder eingeklappt. */
const gcalExpanded = new Set<string>();

/**
 * Ein Termin als schmales Band – bewusst KEINE Aufgabenzeile (kein Abhak-Kreis, keine Meta-Zeile):
 * ein Farbbalken links, Uhrzeit vor dem Titel, Klick öffnet die Aktionen (Google öffnen / in Opal
 * ausblenden). Die
 * Bänder stehen oben in der Tagesgruppe (Ganztägig zuerst, dann nach Uhrzeit): eine Zeitmarke,
 * kein Listeneintrag, der um die Sortierung konkurriert. Ab `GCAL_BAND_LIMIT` klappt der Rest ein.
 */
function renderEventBands(list: HTMLElement, ctx: PageCtx, events: DayEvent[], dayKey: string): void {
  const key = viewKey(ctx, dayKey);
  const sorted = [...events].sort((a, b) => (a.startMin ?? -1) - (b.startMin ?? -1) || a.event.title.localeCompare(b.event.title));
  const expanded = gcalExpanded.has(key);
  const visible = expanded ? sorted : sorted.slice(0, GCAL_BAND_LIMIT);
  for (const de of visible) {
    const ev = de.event;
    const row = list.createDiv({ cls: "bt-gcal-band" });
    row.style.setProperty("--bt-ev-color", ev.color);
    // Schlanker, runder Farbbalken in EIGENER Spalte (Google-Kalenderfarbe) statt getönter Zeile –
    // so trägt allein der Balken die Farbe und die Zeile bleibt ruhig.
    row.createSpan({ cls: "bt-gcal-band-bar", attr: { "aria-hidden": "true" } });
    if (de.startMin !== null) {
      const time = de.endMin !== null ? bandTime(de.startMin) + "–" + bandTime(de.endMin) : bandTime(de.startMin);
      row.createSpan({ cls: "bt-gcal-band-time", text: time });
    }
    row.createSpan({ cls: "bt-gcal-band-title", text: ev.title });
    setIcon(row.createSpan({ cls: "bt-gcal-band-open", attr: { "aria-hidden": "true" } }), "ellipsis");
    tip(row, t("more_actions"));
    activateEventOpen(row, ev, ctx.plugin);
  }
  if (sorted.length > GCAL_BAND_LIMIT) {
    const hidden = sorted.length - GCAL_BAND_LIMIT;
    const more = list.createDiv({ cls: "bt-gcal-more", attr: { role: "button", tabindex: "0" } });
    setIcon(more.createSpan({ cls: "bt-gcal-more-ic" }), expanded ? "chevron-up" : "chevron-down");
    more.createSpan({ text: expanded ? t("gcalfeed_show_less") : t("gcalfeed_more", hidden) });
    const toggle = (): void => { if (expanded) gcalExpanded.delete(key); else gcalExpanded.add(key); ctx.redraw(); };
    more.onclick = toggle;
    more.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  }
}

/** Zeichnet eine Sektion und gibt ihren Überschriften-Kopf zurück – daran hängen Aufrufer
 *  optionale Kopf-Aktionen (z. B. „Verschieben" bei „Überfällig"), ohne dass section() sie
 *  kennen muss. Wer den Rückgabewert nicht braucht, ignoriert ihn wie bisher. */
function section(parent: HTMLElement, ctx: PageCtx, title: string, tasks: Task[], today: string, collapsible = false, trash = false, present?: Set<string>, events: DayEvent[] = [], eventKey = "", ownRow?: (t: Task) => boolean, bare = false,
  shell?: { className?: string; listClassName?: string; listTail?: boolean }): HTMLElement {
  const top = trash ? tasks : visibleRows(tasks, present, ownRow);
  const group = createListSection(parent, {
    title,
    count: top.length,
    bare,
    className: shell?.className,
    listClassName: shell?.listClassName,
    ...(collapsible ? {
      collapsible: {
        collapsed: ctx.doneCollapsed,
        onChange: (collapsed: boolean) => ctx.setDoneCollapsed(collapsed),
      },
    } : {}),
  });
  const { section: sec, header: head, list } = group;
  const countEl = group.count!;
  // Termine des Tages (read-only) gebündelt in einer dezenten Box oben, vor den Aufgaben.
  if (events.length) renderEventBands(list.createDiv({ cls: "bt-gcal-daybox" }), ctx, events, eventKey);
  // EINMAL pro Section lesen (statt pro Zeile) und an renderTask durchreichen.
  const o = ctx.opts;
  const subs = effectiveSubtasks(o);
  const manual = o.sort === "manual";
  // „Kompakt"-Thema: ist die Ansicht nach Datum gruppiert, tragen die Sektionsüberschriften das Datum
  // -> der per-Aufgabe-Datums-Chip ist redundant (renderTask blendet ihn dann aus, außer Uhrzeit).
  // Heute/Demnächst zeigen Datums-Sektionen schon im Default (group „none"), volle Seiten (Projekt/
  // Bereich/Label/Filter/Eingang) nur bei ausdrücklichem group „date". Einmal je Sektion bestimmt.
  const key = ctx.pageKey;
  const dateImplied = (key === "heute" || key === "demnaechst") ? (o.group === "none" || o.group === "date") : (o.group === "date");
  const deadlineImplied = o.group === "deadline";   // Sektionen = Deadline-Datum -> Deadline-Chip redundant
  // Bei Projekt-Gruppierung: alle Zeilen der Sektion haben dasselbe Projekt (bzw. Eingang) -> aus der ersten
  // ableiten und den @Projekt-/@Eingang-Backlink weglassen (Sektionsüberschrift zeigt es schon). Labels
  // dagegen zeigen wir bei Label-Gruppierung ALLE (auch das Gruppen-Label), s. renderTask.
  const hideProject = o.group === "project" && top.length
    ? (isInboxLink(top[0].project) ? NO_PROJECT : baseName(top[0].project!)) : undefined;
  // Das Datum, das DIESE Sektion in ihrer Überschrift trägt (leer bei „Überfällig" – ein Sammel-
  // Bucket ohne einzelnes Datum – und bei nicht-datierten Gruppierungen).
  const impliedDate = dateImplied && eventKey ? eventKey : undefined;
  // Die Zeilen einer Sektion füllen – als Closure, damit der Abgleich (tryPatchList) sie später
  // mit GENAU denselben Parametern neu zeichnen kann, ohne sie ein zweites Mal herzuleiten.
  // Dasselbe Mittel wie `paint` bei tryPatchCalendar.
  //
  // Gezeichnet wird stückweise: erst ein Schub, der Rest sobald das Ende der Sektion in die Nähe
  // des Sichtfelds kommt. Bei 1411 Zeilen entstehen so beim Öffnen ~60 statt 1411 – die Arbeit
  // verschwindet nicht, sie verteilt sich auf das, was man wirklich ansieht. `shown` merkt sich,
  // wie weit die Sektion schon aufgebaut ist; ein Abgleich (paintRows) baut genau so weit wieder
  // auf, sonst schrumpfte die Liste unter einem weit heruntergescrollten Nutzer weg.
  // Anteil dieser Sektion am Budget der Seite. Ist es aufgebraucht, startet sie leer und füllt
  // sich erst, wenn man in ihre Nähe scrollt.
  const startRows = takeFromBudget(pageBudget, top.length);
  pageBudget -= startRows;
  let first = true;
  let shown = 0;
  let rowsNow: Task[] = [];
  let recycled = false;      // Zeilen ausgehängt, nur der Platzhalter steht (s. recycle)
  let pxProRow = 0;          // an DIESER Sektion gemessene Zeilenhöhe (0 = noch nie gemessen)
  const drawSlice = (von: number, bis: number): void => {
    for (const task of rowsNow.slice(von, bis)) renderTask(list, ctx, task, today, 0, trash,
      { subs, manual, showDone: o.showDone, impliedDate, deadlineImplied, hideProject, listTail: shell?.listTail });
    annotateSubtaskTree(list);
  };
  /** Nächsten Schub anhängen; gibt zurück, ob danach noch etwas fehlt. */
  const grow = (): boolean => {
    const bis = Math.min(rowsNow.length, shown + CHUNK_ROWS);
    drawSlice(shown, bis);
    shown = bis;
    recycled = false;
    return shown < rowsNow.length;
  };
  /** Rückruf des Wächters – EINE Fassung, die sowohl das Nachladen als auch das
   *  Wieder-Auffüllen nach dem Aushängen bedient. */
  const sentinelGrow = (): boolean => {
    const rest = grow();
    if (sentinel) list.appendChild(sentinel);   // Wächter bleibt das letzte Element
    return rest;
  };
  const paintRows = (rows: Task[]): void => {
    // Beim Nachfüllen fallen die Zeilen kurz weg. Wer tief gescrollt ist, dem klemmt der Browser
    // die Scrollposition an die geschrumpfte Höhe – und nach dem Wiederaufbau stünde er woanders.
    // Deshalb merken und zurücksetzen; die Höhe ist danach praktisch dieselbe.
    const scroller = list.closest<HTMLElement>(".bt-view");
    const oben = scroller?.scrollTop ?? 0;
    // Nur die Zeilen, nicht den ganzen Container: davor kann die Termin-Box des Tages stehen
    // (renderEventBands), und die gehört nicht zu den Aufgaben.
    list.querySelectorAll(":scope > .bt-task").forEach((el) => el.remove());
    rowsNow = rows;
    const bisher = shown;
    shown = 0;
    // Erster Anstrich: der Anteil am Seiten-Budget (oft 0). Später (Abgleich): mindestens ein
    // Schub, höchstens so weit wie vorher – nie über das Ende hinaus.
    // Ausnahme: Steht ein Sprung aus der Suche an, wird die Sektion GANZ gezeichnet. Aufblitzen
    // und Ins-Bild-Scrollen hängen daran, dass es die Zeile gibt – und sie kann überall stehen.
    const mindest = first ? startRows : CHUNK_ROWS;
    first = false;
    // Ausgehängte Sektion (weit außerhalb des Sichtfelds) bleibt ausgehängt: nur Zahl und
    // Platzhalter nachziehen. Sie zu zeichnen wäre Arbeit für etwas, das niemand ansieht.
    const ziel = repaintCount({ total: rows.length, shown: bisher, minimum: mindest, recycled, flash: !!ctx.plugin.flashPath });
    drawSlice(0, ziel);
    shown = ziel;
    countEl.setText(String(rows.length));   // die Überschrift zählt IMMER alle, nicht die gezeichneten
    armSentinel();
    if (scroller && oben && scroller.scrollTop !== oben) scroller.scrollTop = oben;
  };
  // Der Wächter am Ende der Sektion: kommt er ins Bild, kommt der nächste Schub.
  let sentinel: HTMLElement | null = null;
  const armSentinel = (): void => {
    if (shown >= rowsNow.length) { sentinel?.remove(); sentinel = null; return; }
    if (!sentinel) sentinel = list.createDiv({ cls: "bt-lazy-sentinel" });
    else list.appendChild(sentinel);   // ans Ende nachziehen
    // Platzhalter-Höhe für das, was noch fehlt. Ohne sie wären ALLE ungezeichneten Sektionen
    // gleichzeitig im Sichtfeld (sie wären ja 0 hoch) und würden sich sofort alle füllen.
    setLazyHeight(sentinel, placeholderPx(rowsNow.length, shown, pxProRow || rowPxEst));
    observeSentinel(sentinel, sentinelGrow);
  };
  /**
   * Die Zeilen einer weit abgescrollten Sektion wieder AUSHÄNGEN und ihre Höhe durch einen
   * Platzhalter ersetzen. Damit wächst der Baum nicht mehr mit dem, was man schon gesehen hat:
   * im DOM steht ungefähr das, was auf den Bildschirm passt, und nicht die ganze Liste.
   *
   * Die Höhe wird GEMESSEN, nicht geschätzt (Differenz vor/nach dem Aushängen). Ein geschätzter
   * Platzhalter verschöbe alles darunter und risse dem Nutzer die Zeile unter dem Finger weg.
   */
  const recycle = (): void => {
    if (shown === 0) return;
    const vorher = list.getBoundingClientRect().height;
    const raus = shown;
    list.querySelectorAll(":scope > .bt-task").forEach((el) => el.remove());
    shown = 0;
    if (!sentinel) sentinel = list.createDiv({ cls: "bt-lazy-sentinel" });
    else list.appendChild(sentinel);
    setLazyHeight(sentinel, 0);
    const nachher = list.getBoundingClientRect().height;
    const hoehe = Math.max(0, vorher - nachher);
    setLazyHeight(sentinel, hoehe);
    recycled = true;
    // Was wir dabei über die echte Zeilenhöhe gelernt haben, kommt allen zugute: Sektionen, die
    // noch nie gezeichnet wurden, schätzen damit besser (und der Rollbalken springt weniger).
    //
    // NUR bei vollständig gezeichneten Sektionen: War noch ein Platzhalter für den Rest da,
    // steckt DESSEN geschätzte Höhe mit in der Messung – daraus eine Zeilenhöhe zu rechnen hiesse,
    // die eigene Schätzung für eine Messung zu halten. Für den Platzhalter oben ist `hoehe`
    // trotzdem richtig: sie ist genau das, was die Sektion vorher eingenommen hat.
    if (raus === rowsNow.length && hoehe > 0) { pxProRow = hoehe / raus; rowPxEst = rowPxEst * 0.7 + pxProRow * 0.3; }
    observeSentinel(sentinel, sentinelGrow);
  };
  // Auslösen erst deutlich weiter draußen als das Nachladen (900 px) – sonst geriete eine Sektion
  // am Rand in ein Füllen/Aushängen-Pendel.
  const armRecycler = (): void => {
    const win = sec.ownerDocument.defaultView;
    if (!win) return;
    const io = new win.IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) recycle();
    }, { rootMargin: "1800px 0px" });
    io.observe(sec);   // hält nur diese Sektion; fällt sie weg, fällt der Beobachter mit
  };

  paintRows(top);
  // Termin-Bänder zeichnet paintRows nicht mit -> solche Sektionen nehmen am Abgleich nicht teil.
  if (recording && !events.length) recording.push({ title, sig: sectionSig(tasks, sigLookup(ctx), { present, ownRow, trash }), paintRows });
  // Das Aushängen dagegen betrifft nur die Zeilen; ein Termin-Band bleibt stehen und stört nicht.
  if (budgeted) armRecycler();

  return head;
}

/** „Verschieben" rechts im Kopf der Überfällig-Sektion (Sammel-Aktion auf ALLE Aufgaben der
 *  Sektion). Der Picker startet bewusst OHNE Vorbelegung: 15 überfällige Aufgaben haben 15
 *  verschiedene Daten – ein vorausgewählter Tag müsste eines davon erfinden und würde
 *  suggerieren, es passiere ohnehin gleich. Klick daneben schließt folgenlos (openDatePicker
 *  meldet nur bei ausdrücklicher Auswahl). */
function rescheduleButton(head: HTMLElement, plugin: OpalTasksPlugin, tasks: Task[]): void {
  head.addClass("bt-has-action");
  // Bewusst KEIN <button>: darauf greifen Obsidians App-Styles mit Rahmen, Schatten und
  // eigener Textfarbe zu, die man einzeln wieder abräumen müsste (und die je nach Theme
  // trotzdem gewinnen). Span mit role/tabindex wie bei .bt-gcal-more – reiner Text, der
  // Schrift und Größe der Überschrift erbt und nur über die Akzentfarbe hervorsticht.
  const btn = head.createSpan({ cls: "bt-sec-action", text: t("sec_reschedule"), attr: { role: "button", tabindex: "0" } });
  const open = (e: Event): void => {
    e.stopPropagation();   // ein einklappbarer Kopf (head.onclick) darf nicht mitschalten
    openDatePicker(btn, "", (v) => void plugin.rescheduleTasks(tasks, v));
  };
  btn.onclick = open;
  btn.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } };
}

/** Subtask-Baum-Marker in EINEM Durchlauf setzen (statt Nachbar-`:has` in CSS, das breite
 *  Invalidierung auslöst): pro Liste die Zeilen durchgehen und
 *  - `bt-has-sub`  auf eine Hauptaufgabe, direkt gefolgt von einer Unteraufgabe (Rail + keine Trennlinie),
 *  - `bt-last-sub` auf eine Unteraufgabe, der KEINE weitere folgt (└-Ecke + Abschlusslinie). */
function annotateSubtaskTree(list: HTMLElement): void {
  const rows = Array.from(list.children) as HTMLElement[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.hasClass("bt-task")) continue;
    const next = rows[i + 1];
    const nextIsSub = !!next && next.hasClass("bt-task") && next.hasClass("bt-subtask");
    if (row.hasClass("bt-subtask")) row.toggleClass("bt-last-sub", !nextIsSub);
    else row.toggleClass("bt-has-sub", nextIsSub);
  }
}

/* ══ Inkrementelles Nachzeichnen der Liste (tryPatchList) ═══════════════════════════════════
 *
 * Jede Index-Meldung liess die Seite bisher `c.empty()` machen und ALLE Zeilen neu bauen – bei
 * 2000 Aufgaben rund 50.000 Elemente und ~4.000 SVG-Icons, und das schon beim Abhaken einer
 * einzigen Aufgabe. Kalender und Seitenleiste haben dafür längst einen Weg (tryPatchCalendar,
 * tryPatchNav); die Liste war die letzte Fläche ohne.
 *
 * Das Verfahren ist dasselbe: Beim Zeichnen merkt sich die Seite ihre Sektionen samt einer
 * Signatur und einer `paintRows`-Closure. Meldet der Index etwas, werden die Daten mit GENAU
 * demselben Code neu hergeleitet (die `repaint`-Closure ruft die Zeilen von oben nochmal auf,
 * es gibt keine zweite Herleitung) und nur die Sektionen neu gefüllt, deren Signatur sich
 * geändert hat. Der Rest des DOM bleibt unangetastet.
 *
 * Sicherheitsnetz, wie beim Kalender: Bei der KLEINSTEN strukturellen Abweichung – anderer
 * Rahmen, andere Sektionen, andere Reihenfolge der Sektionen – liefert der Abgleich false und
 * der Aufrufer baut vollständig neu. Die Signaturen dürfen dabei gern zu viel abdecken: ein
 * überflüssiger Neuaufbau kostet Zeit, eine übersehene Änderung zeigt veraltete Daten.
 */
interface SectionRec {
  title: string;
  sig: string;
  paintRows: (rows: Task[]) => void;   // füllt NUR die Zeilen dieser Sektion (s. section)
}
interface ListMount {
  headSig: () => string;            // Kopf der Seite – frisch gelesen, s. frameSig
  sig: string;                      // Rahmen-Signatur (s. frameSig)
  root: HTMLElement;                // Wurzel der gezeichneten Liste (isConnected-Prüfung)
  sections: SectionRec[];
  repaint: () => boolean;           // false = Struktur geändert, bitte voll neu bauen
}
const listMounts = new WeakMap<HTMLElement, ListMount>();
/** Läuft gerade eine aufzeichnende Zeichnung? Dann trägt sich jede Sektion hier ein. */
let recording: SectionRec[] | null = null;
/** Läuft gerade eine Seiten-Zeichnung mit Budget? Dann hängen Sektionen ausserhalb des
 *  Sichtfelds ihre Zeilen wieder aus (s. recycle). */
let budgeted = false;
/** So viele Patches am Stück, dann einmal regulär neu bauen (s. repaint). */
const PATCH_LIMIT = 200;
/** Zeilen je Schub. Grob ein Bildschirm plus Reserve – klein genug, dass das Öffnen nicht mehr
 *  wartet, groß genug, dass Scrollen nicht ständig nachladen muss. */
const CHUNK_ROWS = 60;
/**
 * Zeilen, die eine SEITE beim Öffnen insgesamt zeichnet – über alle Sektionen zusammen.
 *
 * Das Budget muss der Seite gehören und nicht der Sektion: Eine nach Datum gruppierte Filterseite
 * mit 1411 Aufgaben zerfällt in ~200 Tages-Sektionen, von denen fast jede unter einem Schub
 * liegt. Je Sektion gedeckelt hätte also praktisch jede voll gezeichnet und in Summe wären
 * dieselben ~800 Zeilen entstanden wie vorher – gemessen an einem echten Vault.
 */
const FIRST_PAINT_ROWS = 80;
/** Geschätzte Zeilenhöhe für den Platzhalter ungezeichneter Zeilen. Betrifft NUR die Länge des
 *  Rollbalkens, nie den Inhalt: zu klein geschätzt heisst, der Balken wächst beim Scrollen. */
const ROW_PX = 34;
/** Dasselbe für eine Board-KARTE (höher als eine Listenzeile). Nur Rückfall: sobald eine Spalte
 *  Karten gezeichnet hat, misst sie ihre eigene Höhe. */
const CARD_PX = 64;
/** So viele Karten zeichnet eine Board-Spalte, bevor sie ihre echte Kartenhöhe misst. Klein
 *  halten: Die Zahl fällt für JEDE Spalte an, auch für die waagerecht nicht sichtbaren. */
const MESS_KARTEN = 6;
/** Laufender Schätzwert der Zeilenhöhe, aus echten Messungen nachgeführt (s. recycle). */
let rowPxEst = ROW_PX;

/** Verbleibendes Zeichen-Budget der laufenden Seite (Infinity = keine Deckelung, z. B.
 *  Heute/Demnächst – dort ist die Zeilenzahl klein). */
let pageBudget = Number.POSITIVE_INFINITY;

/** Höhe des Platzhalters. Über eine CSS-Variable statt `style.height`, wie `--bt-depth` an der
 *  Aufgaben-Zeile – die Gestaltung bleibt damit in styles.css (s. obsidianmd-Lint-Regel). */
function setLazyHeight(el: HTMLElement, px: number): void {
  el.style.setProperty("--bt-lazy-h", Math.round(px) + "px");
}

const sentinelObservers = new WeakMap<Element, IntersectionObserver>();
/**
 * Den Wächter am Ende einer Sektion bewachen: kommt er ins Bild, zeichnet `grow` den nächsten
 * Schub und meldet, ob danach noch etwas fehlt.
 *
 * Ein Beobachter je Wächter statt einem globalen: Wird die Sektion verworfen (voller Neuaufbau),
 * hält niemand mehr den Beobachter, und er verschwindet mitsamt seinem Ziel. Ein gemeinsamer
 * Beobachter müsste jeden abgehängten Wächter einzeln abmelden – und übersähe man einen, hielte
 * er dessen ganzen Teilbaum am Leben.
 *
 * `el.ownerDocument.defaultView` statt `window`: In einem ausgeklappten Fenster gehört der
 * Beobachter in JENES Fenster, sonst misst er gegen das falsche Sichtfeld.
 */
function observeSentinel(el: HTMLElement, grow: () => boolean): void {
  if (sentinelObservers.has(el)) return;   // steht schon unter Beobachtung
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  const io = new win.IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    if (grow()) {
      // IntersectionObserver meldet nur ÜBERGÄNGE. Steht der Wächter nach dem Schub weiter im
      // Bild (hohes Fenster, kurzer Schub), käme nie wieder ein Rückruf – erneutes Anmelden
      // stößt ihn mit dem AKTUELLEN Zustand neu an.
      io.unobserve(el); io.observe(el);
    } else {
      io.disconnect();
      sentinelObservers.delete(el);
      el.remove();
    }
  }, { rootMargin: "200px 0px 900px 0px" });
  sentinelObservers.set(el, io);
  io.observe(el);
}


/** Der Zugang der Signatur zu Index und Klappzustand (s. rowSignature.ts). */
function sigLookup(ctx: PageCtx): SigLookup {
  const idx = ctx.plugin.index;
  const subs = effectiveSubtasks(ctx.opts);
  return {
    title: (p) => idx.get(p)?.title,
    comments: (p) => idx.commentsOf(p),
    children: (p) => idx.children(p),
    expanded: (p) => subsExpanded(ctx, p, subs),
  };
}

/** Der Rahmen: alles, was NICHT die Zeilen selbst sind. Weicht davon etwas ab, ist der
 *  Patch-Pfad ungültig – auch bei Dingen, die weit oben auf der Seite stehen (Kopf, Filter-
 *  Kriterien), denn die zeichnet der Abgleich nicht mit. */
function frameSig(ctx: PageCtx, opts: ViewOptions, headSig: string): string {
  const o = opts;
  return [
    ctx.pageKey, headSig, o.layout, o.sort, o.sortDir, o.group, o.showDone, o.subtasks ?? "", o.prioritySwimlanes ?? "",
    o.showEmptyBoardAxes,
    ctx.plugin.projectCollapseSignature(),
    effectiveSubtasks(o), todayStr(), JSON.stringify(ctx.crit), ctx.doneCollapsed, menuHoldPath() ?? "",
    // Aus der Suche angesprungen: das Hervorheben UND das Scrollen passieren beim Bauen der
    // Zeile (applyFlash). Steht ein Sprung an, muss also gebaut werden, nicht gepatcht.
    ctx.plugin.flashPath ?? "",
    settingsSig(ctx.plugin),
  ].join("|");
}
/** Kopf-Signatur einer Seite, die an einer NOTIZ hängt (Projekt/Bereich): alles, was der
 *  Seitenkopf daraus zeigt. Frisch aus dem Metadaten-Cache gelesen – ein reiner Map-Zugriff,
 *  kein Vault-Scan. `null` = Systemansicht ohne Notiz (Eingang). */
function noteHeadSig(plugin: OpalTasksPlugin, path: string | null): string {
  if (!path) return "";
  const f = plugin.app.vault.getAbstractFileByPath(path);
  const fm = f instanceof TFile ? plugin.app.metadataCache.getFileCache(f)?.frontmatter : null;
  return [path, fm?.title ?? "", fm?.description ?? "", fm?.color ?? "", fm?.status ?? "", fm?.workflow_status ?? "",
    fm?.priority ?? "", fm?.area ?? "", fm?.priority_swimlanes ?? "", fm?.nav_hidden ?? ""].join("~");
}

/** Einstellungen, die in JEDER Zeile stecken (und beim Patchen nicht neu gelesen würden). */
function settingsSig(plugin: OpalTasksPlugin): string {
  const s = plugin.settings;
  return [s.showDescriptionInList, s.metaTheme, s.chipsIconsOnly, s.locale].join(",");
}

/** Versucht, die bereits gezeichnete Liste in `c` nur nachzufüllen. true = erledigt,
 *  der Aufrufer darf das Neuzeichnen überspringen. */
export function tryPatchList(c: HTMLElement, ctx: PageCtx): boolean {
  const m = listMounts.get(c);
  if (!m || !m.root.isConnected) return false;
  if (m.sig !== frameSig(ctx, ctx.opts, m.headSig())) return false;
  return m.repaint();
}

// Marker, die einen Link andeuten – nur dann als Markdown rendern (Performance-Guard).
const LINK_MARKERS = /\[\[|]\(|https?:\/\/|obsidian:\/\//;

/** Text in die Zeile schreiben. Enthält er Link-Marker, als (inline) Markdown rendern –
 *  klickbare Wikilinks/URLs/obsidian-Links; sonst schneller Plaintext-Pfad. Genutzt für
 *  Aufgabentitel UND Beschreibungs-Vorschau. */
function renderLinkedText(el: HTMLElement, ctx: PageCtx, text: string, sourcePath: string): void {
  const plugin = ctx.plugin;
  if (!LINK_MARKERS.test(text) || !ctx.titleComp) { el.setText(text); return; }
  el.addClass("bt-md-inline");
  void MarkdownRenderer.render(plugin.app, text, el, sourcePath, ctx.titleComp)
    .catch(() => { el.empty(); el.setText(text); });   // Fallback: Plaintext
  // Klick auf einen Link öffnet den Link (statt das Edit-Modal der Zeile).
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a.classList.contains("internal-link")) {
      const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
      void plugin.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(e));
    } else {
      const href = a.getAttribute("href");
      if (href) window.open(href);
    }
  });
}

/**
 * Eigenes Zugbild statt des Browser-Abzugs der Zeile.
 *
 * Der Abzug erbt zwei Dinge, die ihn unbrauchbar machen: die halbe Deckkraft von `is-dragging`
 * (der Browser zieht sein Bild ERST NACH dem Start-Ereignis, die Klasse sitzt dann schon) und den
 * fehlenden Hintergrund der Zeile – über der Seitenleiste blieb dadurch schwebender Text übrig,
 * der sich mit deren Einträgen überlagerte.
 *
 * Stattdessen eine undurchsichtige Karte mit demselben Inhalt: eine KOPIE der Zeile, damit Checkbox,
 * Titel, Meta-Zeile und Projekt-Verweis genau so aussehen wie in der Liste. Die Hülle trägt die
 * Klasse `bt-view`, weil ein Teil der Zeilen-Gestaltung darunter gescopet ist (Chip-Farben) und die
 * Icon-Masken als Variablen dort hängen – am nackten `body` wären die Meta-Chips farb- und symbollos.
 *
 * Die Karte wird außerhalb des Sichtfelds erzeugt (der Browser braucht sie gerendert im Dokument)
 * und sofort danach wieder entfernt: Das Bild ist zu diesem Zeitpunkt längst gezogen.
 */
function attachDragGhost(e: DragEvent, row: HTMLElement): void {
  if (!e.dataTransfer) return;
  // Zwei Ebenen: eine DURCHSICHTIGE Hülle mit Rand, darin die eigentliche Karte. Der Abzug endet an
  // der Hüllenkante – und dort liegt jetzt nur noch Nichts. Läge die Umrandung selbst auf dieser
  // Kante, verschwände sie bei jeder Bewegung neu: Das Bild wird auf einer skalierten Anzeige an
  // gebrochenen Gerätepixeln abgesetzt, und die äußerste Pixelreihe fällt dann mal weg, mal nicht.
  const ghost = row.ownerDocument.body.createDiv({ cls: "bt-view bt-drag-ghost" });
  const card = ghost.createDiv({ cls: "bt-drag-ghost-card" });
  card.style.width = row.offsetWidth + "px";
  const clone = row.cloneNode(true) as HTMLElement;
  clone.removeClass("is-focus");   // ein Suchtreffer-Rahmen gehört nicht ans Zugbild
  card.appendChild(clone);
  // Greifpunkt beibehalten: Die Karte hängt dort am Zeiger, wo man die Zeile angefasst hat – plus
  // den Rand der Hülle. GERUNDET, damit das Bild auf ganzen Pixeln sitzt und nicht bei jeder
  // Bewegung neu verrechnet wird (dieselbe Rundung wie bei den Popovers).
  const r = row.getBoundingClientRect();
  e.dataTransfer.setDragImage(ghost, Math.round(e.clientX - r.left) + GHOST_PAD, Math.round(e.clientY - r.top) + GHOST_PAD);
  window.setTimeout(() => ghost.remove(), 0);
}
/** Durchsichtiger Rand der Zughülle – muss zum `padding` von `.bt-drag-ghost` passen. */
const GHOST_PAD = 4;

/** The next rendered sibling is the visual “below” target; hidden rows stay out of the way. */
function nextVisibleSiblingPath(row: HTMLElement, task: Task, plugin: OpalTasksPlugin): string | null {
  const rows = Array.from(row.parentElement?.querySelectorAll<HTMLElement>(":scope > .bt-task") ?? []);
  for (let i = rows.indexOf(row) + 1; i < rows.length; i++) {
    const path = rows[i].dataset.path;
    const candidate = path ? plugin.index.get(path) : undefined;
    if (candidate?.parent === task.parent) return candidate.path;
  }
  return null;
}

/** Manual-order insertion controls. They deliberately do not exist in automatic sort modes. */
function renderTaskInsertControls(row: HTMLElement, ctx: PageCtx, task: Task): void {
  const page = pageInfo(ctx.page);
  const project = task.project ? baseName(task.project) : undefined;
  const label = page.kind === "label" ? page.key : undefined;
  const onToday = page.kind === "view" && page.key === "heute";
  const add = (side: "before" | "after"): void => {
    const beforePath = side === "before" ? task.path : nextVisibleSiblingPath(row, task, ctx.plugin);
    openInlineNewTask(ctx, row, project, label, onToday, undefined, addDue(ctx), undefined,
      { side, task, beforePath }, undefined, undefined, task.projectId);
  };
  for (const side of ["before", "after"] as const) {
    const labelKey = side === "before" ? "task_add_above" : "task_add_below";
    const button = row.createEl("button", {
      cls: "bt-row-insert bt-row-insert-" + side,
      attr: { "aria-label": t(labelKey), type: "button" },
    });
    setIcon(button, "plus");
    tip(button, t(labelKey));
    button.onclick = (e) => { e.preventDefault(); e.stopPropagation(); add(side); };
  }
}

function renderTask(list: HTMLElement, ctx: PageCtx, task: Task, today: string, depth: number, trash = false,
  opts: { flat?: boolean; colId?: string; subs?: SubtaskDisplay; manual?: boolean; showDone?: boolean; impliedDate?: string;
    deadlineImplied?: boolean; hideProject?: string; draggable?: boolean; boardMove?: boolean; listTail?: boolean } = {}): void {
  const plugin = ctx.plugin;
  // Unteraufgaben-Darstellung: vom Aufrufer (section) EINMAL pro Section gereicht statt hier pro
  // Zeile ctx.opts zu lesen (bei Projektseiten ein metadataCache-Zugriff je Aufgabe).
  const subs = opts.subs ?? "compact";   // Aufrufer reichen ihn immer durch; Rueckfall nur der Form halber
  // WAS die Zeile zeigt, entscheidet rowPlan – rein und geprüft (s. rowPlan.ts). Hier wird nur
  // noch gezeichnet und verdrahtet.
  const kids = plugin.index.children(task.path).filter((k) => !isTrashed(k.status));
  const plan = rowPlan({
    task, today, depth, trash, flat: opts.flat,
    // An Area page can contain several projects. Suppress the backlink only when the page itself
    // identifies one concrete project/inbox; Area groups pass hideProject for their own context.
    onProjectPage: ctx.page.kind === "project"
      && (ctx.page.key === INBOX_KEY || !isAreaPath(plugin.app, ctx.page.key)),
    showDescription: plugin.settings.showDescriptionInList,
    impliedDate: opts.impliedDate, deadlineImplied: opts.deadlineImplied, hideProject: opts.hideProject,
    parentTitle: task.parent ? plugin.index.get(task.parent)?.title : undefined,
    comments: plugin.index.commentsOf(task.path),
    kids, expanded: subsExpanded(ctx, task.path, subs),
  });
  const row = list.createDiv({ cls: plan.classes.join(" ") });
  if (opts.boardMove) row.addClass("has-board-move");
  if (depth) row.style.setProperty("--bt-depth", String(depth));
  row.dataset.path = task.path;
  if (task.path === menuHoldPath()) row.addClass("bt-menu-hold");   // offenes Kontextmenü hält das Hover
  plugin.applyFlash(row, task.path);   // aus der Suche angesprungen? -> hervorheben + ins Bild scrollen

  // Griff zum Einsortieren – nur bei Sortierung „Manuell" und nur in der Liste (die Karte im Board
  // wird per HTML5-Drag bewegt, der Papierkorb kennt keine Reihenfolge). Eigener Griff statt
  // Ganzzeilen-Drag, weil ein Klick auf die Zeile das Aufgaben-Modal öffnet.
  if (opts.manual && !opts.flat && !trash) {
    const grip = row.createSpan({ cls: "bt-row-grip" });
    tip(grip, t("sort_manual"));
    setIcon(grip, "grip-vertical");
    attachTaskReorder(row, grip, list, task, plugin);
  }
  if (opts.manual && !opts.flat && !trash && isOpen(task.status)) renderTaskInsertControls(row, ctx, task);

  // Per HTML5-Drag verschiebbar (Desktop): auf dem Board zwischen den Spalten, in der LISTE auf
  // einen Eintrag der Seitenleiste (Projekt/Bereich/Eingang – s. navItem/onDropTask). Beides
  // derselbe Zug, deshalb dieselbe Verdrahtung; die Papierkorb-Ansicht bleibt außen vor.
  //
  // Der Zieh-Griff der Handsortierung kommt sich damit nicht ins Gehege: Er ruft in `pointerdown`
  // `preventDefault()`, und das unterbindet den nativen Zug, bevor er beginnt.
  if (!trash && opts.draggable !== false) {
    row.setAttr("draggable", "true");
    row.addEventListener("dragstart", (e) => {
      startTaskDrag(task.path, opts.colId ?? null);   // Quell-Spalte (Status-ID bzw. Label) für die Drop-Semantik
      attachDragGhost(e, row);            // VOR is-dragging: sonst zöge die Karte dessen Dimmung mit
      row.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", task.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    // Auch aufräumen, wenn der Zug ohne Drop endet (Escape, Loslassen außerhalb des Boards) –
    // sonst bliebe die Spalte ausgegraut, bis sie das nächste Mal neu gezeichnet wird.
    row.addEventListener("dragend", () => {
      endTaskDrag();
      row.removeClass("is-dragging");
      clearDropTarget(list);
      // Abbruch per Escape über einem Abwurfziel liefert dort kein `dragleave` – die Hervorhebung
      // bliebe sonst stehen. `dragend` ist der eine Punkt, der jedes Ende sicher sieht. Seit die
      // Liste im Planungs-Split neben dem Kalender steht, gilt das auch für dessen Zellen
      // (`.is-drop`), nicht mehr nur für die Seitenleiste (`.is-drop-task`).
      row.ownerDocument.querySelectorAll(".is-drop-task, .is-drop").forEach((el) => el.removeClasses(["is-drop-task", "is-drop"]));
    });
  }

  renderCheck(row, plugin, task, { trash });

  const body = row.createDiv({ cls: "bt-body" });
  renderLinkedText(body.createDiv({ cls: "bt-title" }), ctx, task.title, task.path);

  // A one-column mobile projection has no adjacent drop target. Keep status movement explicit and
  // discoverable instead of making long-press on the checkbox the only way to reach it.
  if (opts.boardMove) {
    const move = row.createEl("button", {
      cls: "bt-board-move", attr: { type: "button", "aria-label": t("chip_status") },
    });
    setIcon(move, "arrow-right-left");
    tip(move, t("chip_status"));
    move.onclick = (event) => {
      event.preventDefault(); event.stopPropagation();
      openBoardMoveMenu(plugin, task, move);
    };
  }

  // Beschreibungs-Vorschau (einzeilig, gekürzt) – aus dem Frontmatter (`description`), optional
  // per Einstellung. Bild-/Embed-Syntax wird entfernt, damit die Zeile nie zu einem Block aufgeht.
  if (plan.description) renderLinkedText(body.createDiv({ cls: "bt-desc" }), ctx, plan.description, task.path);

  const meta = body.createDiv({ cls: "bt-meta" });
  // Hauptaufgaben-Link ganz vorn als normales Meta-Icon: an jeder Unteraufgabe, die hier auf
  // Top-Level steht (datiert in Heute, fremdes Projekt, erledigter Parent) – in der LISTE wie
  // auf der KARTE (Board „Einblenden": ohne das Icon wäre einer Unterkarte nicht anzusehen,
  // dass sie eine ist). Grau, ohne Hover-Hintergrund, Tooltip = Titel, Klick öffnet die
  // Hauptaufgabe – konsistent zu den übrigen Meta-Icons.
  if (plan.parentLink) {
    const parent = plugin.index.get(task.parent!);
    if (parent) {
      const link = meta.createSpan({ cls: "bt-parent-link",
        attr: { role: "button", tabindex: "0" } });
      tip(link, t("menu_goto_parent") + ": " + parent.title);
      setIcon(link.createSpan({ cls: "bt-parent-link-ic" }), "corner-left-up");
      const openParent = (e: Event): void => {
        e.stopPropagation();
        const parentRow = row.closest<HTMLElement>(".bt-view")
          ?.querySelector<HTMLElement>(`.bt-task[data-path="${CSS.escape(parent.path)}"]`);
        if (parentRow) openInlineTaskEditor(ctx, parent, parentRow); else plugin.openEditTask(parent);
      };
      link.onclick = openParent;
      link.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openParent(e); } };
    }
  }
  if (task.due) {
    // „Kompakt"-Thema (nur Top-Level): das Datum weglassen, wo die Sektionsüberschrift bzw. der
    // Spaltenkopf GENAU DIESES Datum schon zeigt (opts.impliedDate, EINMAL je Sektion/Spalte
    // bestimmt; ohne Datums-Gruppierung gar nicht gesetzt). Ohne Uhrzeit gar kein Chip (Icon UND
    // Wort weg); mit Uhrzeit nur die Uhrzeit (Kalendericon bleibt), eingefärbt nach Tages-Distanz.
    //
    // Verglichen wird das Datum, NICHT bloß „liegt in der Zukunft": In „Heute" stehen seit der
    // Deadline-Aufnahme auch Aufgaben, die erst später fällig sind. Deren Fälligkeit ist alles
    // andere als redundant – sie ist der Grund, warum ihre Zeile dort überhaupt erklärbar ist.
    if (plan.due) {
      const chip = meta.createSpan({ cls: "bt-chip bt-due" });
      chip.createSpan({ cls: "bt-meta-txt", text: plan.due.text });   // eigener Span -> unabhängig vom Icon justierbar
      chip.dataset.when = plan.due.when;
      // Datum nach Tages-Distanz einfärben (heute/morgen/übermorgen/bis Tag 7) – IMMER, wenn der
      // Chip überhaupt gezeichnet wird. Früher hing das an einer Bedingung, die „Datum sichtbar"
      // bloß annäherte (nicht datumsgruppiert ODER nur-Uhrzeit-Chip); seit in datierten Sektionen
      // auch abweichende Fälligkeiten stehen können, hätte deren Datum sonst keine Distanzfarbe.
      // Welche Distanzstufe gilt (und ob überhaupt eine), entscheidet rowPlan.
      if (plan.due.dist) chip.dataset.dist = plan.due.dist;
      chip.onclick = (e) => {
        e.stopPropagation();
        openDatePicker(chip, combineDT(task.due!, task.dueTime), (v) => void plugin.setTaskDate(task, "due", v));
      };
    }
  }
  if (plan.estimate && !opts.listTail) meta.createSpan({ cls: "bt-chip bt-estimate" }).createSpan({ cls: "bt-meta-txt", text: plan.estimate });
  if (plan.recur) meta.createSpan({ cls: "bt-chip bt-recur" });
  // Erinnerungs-Indikator: nur Icon (alarm-clock, wie der Reminder-Chip im Editor), Details im Tooltip.
  if (plan.reminders.length) {
    const rem = meta.createSpan({ cls: "bt-remind" });
    tip(rem, plan.reminders.join(" · "));
    setIcon(rem, "alarm-clock");
  }
  // Text im eigenen Span (.bt-meta-txt), damit er sich unabhängig vom Icon vertikal feinjustieren lässt.
  // ALLE Labels der Aufgabe werden gezeigt – auch auf einer #Label-Seite bzw. bei Gruppierung nach Label
  // das gleichnamige. Selektives Ausblenden verwirrt, sobald eine Aufgabe mehrere Labels hat (anders als
  // beim @Projekt-Backlink, wo eine Aufgabe genau ein Projekt hat).
  for (const l of plan.labels) meta.createSpan({ cls: "bt-chip bt-label" }).createSpan({ cls: "bt-meta-txt", text: l });
  // Kommentare/Anhänge: Büroklammer + dezente Anzahl. Klick öffnet die Aufgabe.
  if (plan.comments) {
    const chip = meta.createSpan({ cls: "bt-comments" });
    const ic = chip.createSpan({ cls: "bt-comments-ic" }); setIcon(ic, "paperclip");
    chip.createSpan({ cls: "bt-comments-n", text: String(plan.comments) });
  }
  // Unteraufgaben-Badge: an JEDER Hauptaufgabe mit (nicht-abgebrochenen) Kindern, in ALLEN Modi
  // (list-checks + „erledigt/gesamt"). Klick klappt DIESE eine Aufgabe auf/zu – der Default kommt
  // vom Modus (subsExpanded): „Eingerückt" offen, „Kompakt" zu. Auf einer Karte (flat) ist es
  // reine ANZEIGE: aufklappen ginge nicht (eine Karte nimmt keine verschachtelten Zeilen auf),
  // daher ohne role/Klick.
  if (plan.subs) {
    {
      const { done, total, open } = plan.subs;
      // Rolle/Fokus nur, wo das Badge auch etwas tut. Die Tooltip-RICHTUNG hing hier früher am
      // selben `if` und war deshalb je nach Modus verschieden: auf der Karte oben, in der Liste
      // unten – direkt neben dem Eltern-Link, der immer oben aufklappte. Sie kommt jetzt aus
      // tooltip.ts und ist überall gleich.
      const attr: Record<string, string> = {};
      if (!opts.flat) { attr.role = "button"; attr.tabindex = "0"; }
      const badge = meta.createSpan({ cls: "bt-subs" + (open ? " is-open" : "") + (opts.flat ? " is-static" : ""), attr });
      tip(badge, t("subtasks_progress", done, total));
      setIcon(badge.createSpan({ cls: "bt-subs-ic" }), "list-checks");
      badge.createSpan({ cls: "bt-subs-n", text: done + "/" + total });
      if (!opts.flat) {
        const toggle = (e: Event): void => {
          e.stopPropagation();   // nicht das Aufgaben-Modal öffnen
          subtaskToggle.set(viewKey(ctx, task.path), !subsExpanded(ctx, task.path, subs));
          ctx.redraw();
        };
        badge.onclick = toggle;
        badge.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); } };
      }
    }
  }

  if (trash) {
    // Papierkorb: rechts zwei Icons – Wiederherstellen + Endgültig löschen (mit Bestätigung).
    const acts = row.createDiv({ cls: "bt-task-actions" });
    iconBtn(acts, "archive-restore", t("btn_restore"), () => void plugin.restoreTask(task));
    iconBtn(acts, "trash-2", t("btn_delete_forever"),
      () => confirmInline(acts, t("confirm_delete_forever_q"), () => void plugin.deleteTaskForever(task.path), () => plugin.renderAll()));
  } else if (plan.backlink) {
    // Project context is metadata too, so it participates in the same wrapping flow as dates,
    // estimates, labels and the timer instead of competing with the title for row width.
    const bl = meta.createEl("a", { cls: "bt-backlink", text: "@" + (plan.backlink.inbox ? t("nav_inbox") : plan.backlink.text) });
    const ziel: PageRef = plan.backlink.inbox ? { kind: "project", key: INBOX_KEY } : { kind: "project", key: task.project! };
    bl.onclick = (e) => { e.stopPropagation(); ctx.open(ziel); };
  }
  if (!meta.childElementCount) meta.remove();
  if (plan.estimate && opts.listTail) {
    const estimate = row.createSpan({ cls: "bt-chip bt-estimate bt-task-tail" });
    estimate.createSpan({ cls: "bt-meta-txt", text: plan.estimate });
  }
  // Klick auf die Zeile öffnet die Aufgabe (kein separater Stift – wäre redundant).
  // MIT Modifier stattdessen die NOTIZ – dieselbe Geste, die in der Seitenleiste (navItem) und
  // in Aufgaben-Links (renderLinkedText) schon „woanders öffnen" bedeutet. Über Keymap.isModEvent
  // statt selbst abgefragter Tasten: plattformrichtig (Cmd auf macOS, Ctrl sonst) und mit Shift
  // von allein im geteilten Fenster. Ohne Modifier bleibt alles wie bisher.
  // Links im Titel fangen ihren Klick vorher ab (stopPropagation) – Mod+Klick dort öffnet
  // weiterhin das Linkziel, nicht die Aufgabennotiz.
  row.onclick = (e) => {
    const mod = Keymap.isModEvent(e);
    if (mod) openTaskNote(plugin.app, task.path, mod); else openInlineTaskEditor(ctx, task, row);
  };
  // Mittelklick öffnet die Notiz in einem neuen Tab (die Geste, die im Browser und in Obsidians
  // Dateiliste dasselbe tut). `onauxclick`, weil die mittlere Taste gar kein `click` auslöst;
  // preventDefault unterdrückt den Autoscroll-Modus, den Chromium sonst startet.
  row.onauxclick = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openTaskNote(plugin.app, task.path, "tab");
  };

  // Unteraufgaben verschachtelt darunter (eingerückt nach Tiefe) – nicht im Papierkorb
  // und nicht im flachen Kanban-Kartenmodus. Bei „Unteraufgaben verstecken" nur zeichnen,
  // wenn das Badge (per Modus-Default oder Klick) aufgeklappt ist – siehe subsExpanded.
  // „Eingerückt" Default auf · „Kompakt" Default zu; ein Klick überschreibt pro Aufgabe.
  const showKids = !trash && !opts.flat && subsExpanded(ctx, task.path, subs);
  if (showKids) for (const kid of sortSubtasks(plugin.index.children(task.path))) {
    if (isTrashed(kid.status)) continue;
    // Erledigte Unteraufgaben an denselben Schalter koppeln wie die Erledigt-Sektion: „Erledigte
    // anzeigen" aus -> auch hier verschachtelt weg. Ausnahme: ist der Parent SELBST erledigt (Erledigt-
    // Ansicht/-Sektion), bleiben sie sichtbar – sonst verschwänden dort die einzigen Zeilen fälschlich.
    if (isDone(kid.status) && !opts.showDone && !isDone(task.status)) continue;
    // Griff auch an verschachtelten Zeilen: ihre Geschwister stehen direkt darunter, also lassen
    // sie sich untereinander genauso einsortieren wie Hauptaufgaben.
    // Unteraufgaben zeigen IMMER ihr eigenes Datum distanz-gefärbt (nie ausgeblendet): die Sektions-/
    // Spaltenüberschrift trägt das Datum der HAUPTaufgabe, nicht das der Unteraufgabe – ein weggelassenes
    // „Heute" an einer Unteraufgabe sähe sonst aus, als hätte sie gar kein Datum. impliedDate wird bewusst
    // NICHT durchgereicht (zusätzlich schützt die Tiefen-Prüfung in rowPlan).
    renderTask(list, ctx, kid, today, depth + 1, false, { subs, manual: opts.manual, showDone: opts.showDone });
  }
}

// ── Linke Navigation ─────────────────────────────────────────────
interface NavItemOpts {
  cls?: string; icon: string; iconColor?: string | null; label: string; count?: number; countKey?: string;
  progress?: ProjectTaskProgress; progressKey?: string;
  suffix?: string;
  active?: boolean; onClick: () => void; onContext?: (e: MouseEvent) => void; onDropTask?: (task: Task) => void;
  /** Wohin der Eintrag führt. Nur dafür da, Strg-/Mittelklick zu bedienen – der normale Klick
   *  läuft weiter über onClick (Einträge wie „Suchen" haben gar keine Seite und lassen es weg). */
  page?: PageRef;
  depth?: number;
  toggle?: { collapsed: boolean; onToggle: () => void };
}

/** Paint/update a project completion pie without replacing sidebar DOM. */
function paintProjectProgress(el: HTMLElement, progress: ProjectTaskProgress): void {
  const percentage = progress.total ? (progress.done / progress.total) * 100 : 0;
  el.style.setProperty("--bt-nav-progress", `${percentage}%`);
  el.classList.toggle("is-empty", progress.total === 0);
  el.classList.toggle("is-complete", progress.total > 0 && progress.done === progress.total);
  el.setAttr("role", "progressbar");
  el.setAttr("aria-valuemin", "0");
  el.setAttr("aria-valuemax", "100");
  el.setAttr("aria-valuenow", String(Math.round(percentage)));
  tip(el, t("subtasks_progress", progress.done, progress.total));
}

/** The project completion pie is one visual primitive in navigation, Area lists and embeds. */
function createProjectProgress(parent: HTMLElement, progress: ProjectTaskProgress,
  color?: string | null, className?: string): HTMLElement {
  const el = parent.createSpan({
    cls: ["bt-project-progress", className ?? ""].filter(Boolean).join(" "),
  });
  if (color) el.style.setProperty("--bt-nav-progress-color", color);
  paintProjectProgress(el, progress);
  return el;
}

/** Div klick- UND tastaturbedienbar machen (role=button/tabindex kommen vom Aufrufer):
 *  Klick + Enter/Space lösen dieselbe Aktion aus. So bleibt die Optik 1:1 wie zuvor. */
function activate(el: HTMLElement, handler: () => void): void {
  el.onclick = handler;
  el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } };
}

/** Ein Nav-Eintrag (Div wie bisher, aber per role=button/tabindex tastaturbedienbar). */
function navItem(c: HTMLElement, plugin: OpalTasksPlugin, o: NavItemOpts): void {
  const item = c.createDiv({ cls: "bt-nav-item" + (o.active ? " is-active" : "") + (o.cls ? " " + o.cls : ""), attr: { role: "button", tabindex: "0" } });
  if (o.depth) item.style.setProperty("--bt-nav-depth", String(o.depth));
  if (o.progress) {
    const progress = createProjectProgress(item, o.progress, o.iconColor, "bt-nav-progress");
    if (o.progressKey) navProgresses?.set(o.progressKey, progress);
  } else {
    const ic = item.createSpan({
      cls: "bt-nav-ic" + (o.toggle ? " bt-nav-tree-toggle" : ""),
      ...(o.toggle ? { attr: { role: "button", tabindex: "0", "aria-expanded": String(!o.toggle.collapsed) } } : {}),
    });
    setIcon(ic, o.icon);
    if (o.iconColor) ic.setCssStyles({ color: o.iconColor });
    if (o.toggle) {
      tip(ic, t("nav_toggle_section"));
      const run = (e: Event): void => { e.preventDefault(); e.stopPropagation(); o.toggle?.onToggle(); };
      ic.onclick = run;
      ic.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") run(e); };
    }
  }
  const lbl = item.createSpan({ cls: "bt-nav-lbl", text: o.label });
  // Langer Name in schmaler Leiste: Tooltip zeigt ihn ganz, statt den Nutzer die Leiste
  // aufziehen zu lassen. Er hängt am Label, nicht an der Zeile – das Label ist das, was
  // abgeschnitten wird, es füllt per flex:1 ohnehin die freie Breite, und ein aria-label an
  // der Zeile würde für Screenreader den Zähler daneben verschlucken („Reisen" statt „Reisen 22").
  tipWhenClipped(lbl, lbl, o.label);
  if (o.suffix) item.createSpan({ cls: "bt-nav-suffix", text: o.suffix });
  // Zähler-Span IMMER anlegen (auch bei 0 – dann leer): nur so kann ihn der Badge-Füller später
  // beschreiben, ohne die Seitenleiste neu zu bauen. o.countKey registriert ihn dafür.
  if (o.countKey || o.count) {
    const badge = item.createSpan({ cls: "bt-nav-count", text: o.count ? String(o.count) : "" });
    if (o.countKey) navBadges?.set(o.countKey, badge);
  }
  // Mit Modifier öffnet der Eintrag einen NEUEN Tab statt im aktuellen zu wechseln. WELCHER
  // Modifier was bedeutet, beantwortet bewusst Keymap.isModEvent: es liefert genau den Wert,
  // den workspace.getLeaf() erwartet, und folgt damit der Vorgabe des Nutzers und der Plattform –
  // eine eigene Auslegung wiche irgendwann von Obsidian ab. Ohne Modifier bleibt alles wie bisher.
  if (o.page) {
    const page = o.page;
    item.onclick = (e) => {
      const mod = Keymap.isModEvent(e);
      if (mod) void plugin.openPage(page, mod); else o.onClick();
    };
    item.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.onClick(); } };
    // Mittelklick = neuer Tab (Browser-Gewohnheit). Gehandelt wird auf `auxclick` (erst dort steht
    // fest, dass Drücken und Loslassen zusammengehören); das preventDefault gehört dagegen an
    // `mousedown` – nur dort lässt sich Chromiums Autoscroll-Kreuz noch verhindern.
    item.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    item.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      void plugin.openPage(page, "tab");
    });
  } else {
    activate(item, o.onClick);
  }
  if (o.onContext) item.oncontextmenu = (e) => { e.preventDefault(); o.onContext!(e); };   // Rechtsklick = Kontextmenü
  if (o.onDropTask) attachTaskDrop(item, plugin, o.onDropTask);
}

/**
 * Einen Seitenleisten-Eintrag als Ablage für Aufgaben verdrahten: Eine Aufgabe aus der Liste (oder
 * vom Board) hierher zu ziehen wendet die Bedeutung des Ziels auf sie an.
 *
 * WAS geschieht, entscheidet die Aufrufstelle, nicht diese Funktion: Projekt, Bereich und Eingang
 * VERSCHIEBEN die Aufgabe (sie hat genau eine Liste), ein Label ERGÄNZT sie (sie kann mehrere
 * tragen und bleibt, wo sie ist). Filter bleiben außen vor – sie sind Suchanfragen und haben kein
 * Feld, das sich setzen ließe.
 *
 * Die Aufgabe kommt aus dem gemeinsamen Zug-Zustand (s. taskDrag.ts – denselben benutzen Liste,
 * Board und Kalender);
 * `dataTransfer` trägt sie zusätzlich, weil ein Zug ohne Nutzlast in manchen Umgebungen gar nicht
 * erst startet. Gelesen wird der Modul-Zustand – er überlebt auch Züge über View-Grenzen hinweg.
 */
function attachTaskDrop(el: HTMLElement, plugin: OpalTasksPlugin, onDrop: (task: Task) => void): void {
  const clear = (): void => el.removeClass("is-drop-task");
  el.addEventListener("dragover", (e) => {
    if (!dragTask()) return;                  // fremder Zug (Datei aus dem Vault o. Ä.) -> nicht anfassen
    e.preventDefault();                     // ohne das lehnt der Browser den Drop ab
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    el.addClass("is-drop-task");
  });
  // Beim Wechsel auf ein KIND des Eintrags (Symbol, Beschriftung, Zähler) feuert ebenfalls
  // `dragleave` – ohne diese Prüfung flackerte die Hervorhebung, während man über dem Eintrag steht.
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget as Node | null)) clear(); });
  el.addEventListener("drop", (e) => {
    clear();
    if (!dragTask()) return;
    e.preventDefault();
    const task = plugin.index.get(dragTask()!);
    if (task) onDrop(task);
  });
}

/** Ein-/ausklappbare Abschnittsüberschrift: Chevron-Toggle (Zustand persistent) + „+",
 *  das nur beim Hover/Fokus der Zeile erscheint. Gibt zurück, ob der Abschnitt eingeklappt ist. */
function navHead(c: HTMLElement, plugin: OpalTasksPlugin, id: string, title: string,
  addTip: string, placeholder: string, redraw: () => void, submit: (v: string) => Promise<unknown>,
  onAddClick?: () => void): boolean {
  const collapsed = plugin.isNavCollapsed(id);
  const head = c.createDiv({ cls: "bt-nav-head" });

  // Label links (füllt die Zeile): Klick/Enter führt in die jeweilige ListManager-Übersicht.
  // (Das Auf-/Zuklappen liegt jetzt beim Chevron rechts.)
  const manageSec = (id === "projects" || id === "areas" || id === "labels" || id === "filters" || id === "templates") ? id : null;
  const toggle = head.createDiv({ cls: "bt-nav-head-toggle", attr: { role: "button", tabindex: "0" } });
  toggle.createSpan({ cls: "bt-nav-head-lbl", text: title });
  activate(toggle, () => manageSec ? void plugin.activateManage(manageSec) : void plugin.toggleNavSection(id));

  // „+" (nur bei Hover/Fokus) direkt links vom Chevron.
  const add = head.createDiv({ cls: "bt-nav-head-add", attr: { role: "button", tabindex: "0" } });
  tip(add, addTip);
  setIcon(add, "plus");
  activate(add, () => {
    if (onAddClick) { onAddClick(); return; }   // Sektionen mit eigenem Editor (z. B. Filter) öffnen ein Modal statt Inline-Eingabe
    const input = createEl("input", { type: "text", cls: "bt-nav-add-input", attr: { placeholder } });
    head.insertAdjacentElement("afterend", input);
    const close = () => { input.onblur = null; redraw(); };
    const commit = () => void (async () => {
      input.onblur = null;
      const v = input.value.trim();
      if (v) {
        await submit(v);
        plugin.revealNavSection(id);   // neu Angelegtes soll sichtbar sein
      }
      redraw();
    })();
    input.onkeydown = (e2) => {
      if (e2.key === "Enter") { e2.preventDefault(); commit(); }
      else if (e2.key === "Escape") { e2.preventDefault(); close(); }
    };
    input.onblur = close;
    window.setTimeout(() => input.focus(), 0);
  });

  // Chevron rechts: vollwertiger, tastaturbedienbarer Klapp-Button (auf/zu) mit aria-expanded.
  const chev = head.createDiv({ cls: "bt-nav-head-chevron", attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) } });
  tip(chev, t("nav_toggle_section"));
  setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
  activate(chev, () => void plugin.toggleNavSection(id));

  // Rechtsklick auf den Sektionskopf: „Ausgeblendete einblenden ▸" (nur wenn es welche gibt)
  // und „Neu erstellen ▸". Letzteres steht IMMER da – sonst hinge das Verhalten des Rechtsklicks
  // davon ab, ob gerade etwas ausgeblendet ist, und derselbe Griff täte mal etwas und mal nichts.
  head.oncontextmenu = (e) => {
    const menu = new Menu();
    if (id === "projects" || id === "areas" || id === "labels" || id === "filters" || id === "templates") {
      showHiddenSubmenu(menu, plugin, id);
    }
    buildCreateSubmenu(menu, plugin);
    e.preventDefault();
    menu.showAtMouseEvent(e);
  };

  return collapsed;
}

/** Compact collapsible heading for generated groups that have no create/manage action. */
function navGroupHead(c: HTMLElement, plugin: OpalTasksPlugin, id: string, title: string): boolean {
  const collapsed = plugin.isNavCollapsed(id);
  const head = c.createDiv({ cls: "bt-nav-head bt-nav-group-head" });
  const toggle = head.createDiv({ cls: "bt-nav-head-toggle", attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) } });
  toggle.createSpan({ cls: "bt-nav-head-lbl", text: title });
  const chev = head.createSpan({ cls: "bt-nav-head-chevron", attr: { role: "button", tabindex: "0", "aria-expanded": String(!collapsed) } });
  setIcon(chev, collapsed ? "chevron-right" : "chevron-down");
  activate(toggle, () => void plugin.toggleNavSection(id));
  activate(chev, () => void plugin.toggleNavSection(id));
  return collapsed;
}

interface ReorderEntry {
  key: string; name: string; icon: string; color: string | null;
  progress?: ProjectTaskProgress; progressKey?: string;
}

/** Sidebar-Sortiermodus für EINE Sektion: „Fertig"-Leiste + per Griff ziehbare Zeilen.
 *  Bewegt NUR die sichtbaren Einträge; persistiert am Drop über plugin.reorderVisible –
 *  ausgeblendete behalten ihre Position (eigener Mechanismus, getrennt von der Übersicht). */
function renderReorderList(c: HTMLElement, plugin: OpalTasksPlugin, sec: NavSection, entries: ReorderEntry[]): void {
  const bar = c.createDiv({ cls: "bt-reorder-bar" });
  bar.createSpan({ cls: "bt-reorder-lbl", text: t("reorder_active") });
  const done = bar.createEl("button", { cls: "bt-reorder-done mod-cta", text: t("reorder_done") });
  done.onclick = () => plugin.endReorder();

  const list = c.createDiv({ cls: "bt-reorder-list" });
  for (const e of entries) {
    const row = list.createDiv({ cls: "bt-reorder-row", attr: { "data-key": e.key } });
    const grip = row.createSpan({ cls: "bt-nav-grip", attr: { role: "button", tabindex: "0" } });
    tip(grip, t("menu_reorder"));
    setIcon(grip, "grip-vertical");
    if (e.progress) {
      const progress = createProjectProgress(row, e.progress, e.color, "bt-nav-progress");
      if (e.progressKey) navProgresses?.set(e.progressKey, progress);
    } else {
      const ic = row.createSpan({ cls: "bt-nav-ic" }); setIcon(ic, e.icon);
      if (e.color) ic.setCssStyles({ color: e.color });
    }
    const lbl = row.createSpan({ cls: "bt-nav-lbl", text: e.name });
    tipWhenClipped(lbl, lbl, e.name);   // im Sortiermodus genauso lang wie sonst
    grip.onkeydown = (ev) => {
      if (ev.key === "ArrowUp") { ev.preventDefault(); void plugin.moveNavItemVisible(sec, e.key, -1); }
      else if (ev.key === "ArrowDown") { ev.preventDefault(); void plugin.moveNavItemVisible(sec, e.key, 1); }
    };
    attachRowDrag(row, grip, list, (keys) => void plugin.reorderVisible(sec, keys));
  }
}

/**
 * ── Seitenleiste: Struktur vs. Zahlen ────────────────────────────────────────────────────────
 * Bei jeder Änderung wurde die komplette Navigation weggeworfen und neu gebaut – 29 Einträge mit
 * Icons, Farben und Handlern, nur weil sich eine Zahl geändert hat.
 *
 * Jetzt getrennt:
 *  • Die ZAHLEN werden bei jeder Meldung neu geschrieben (kein Skip, keine Signatur) – sie können
 *    also nicht veralten. Es wird nur Text ersetzt, kein DOM erzeugt.
 *  • Die STRUKTUR (welche Einträge, Namen, Farben, aktiver Eintrag, eingeklappte Abschnitte) wird
 *    per Signatur geprüft. Ändert sie sich, läuft der vollständige Neuaufbau wie bisher.
 */
interface NavMount { sig: string; badges: Map<string, HTMLElement>; progresses: Map<string, HTMLElement> }
const navMounts = new WeakMap<HTMLElement, NavMount>();
let navBadges: Map<string, HTMLElement> | null = null;   // aktive Sammlung während renderNavInto
let navProgresses: Map<string, HTMLElement> | null = null; // aktive Projekt-Fortschrittskreise

/** Alle Zähler der Seitenleiste – dieselben Werte, die renderNavInto einsetzt. */
/** Sidebar-Badge eines Filters: nur OFFENE Treffer – wie Eingang/Projekte/Labels, die alle offene
 *  zählen. Der `showDone`-Schalter ist eine ANZEIGE-Option der Filterseite, kein Zähl-Kriterium;
 *  ohne dieses Überschreiben zählte der Badge bei „Erledigte anzeigen" die Erledigten mit. Filter mit
 *  ausdrücklichem Status-Kriterium zählen weiter ihre Treffer (applyFilter -> byStatus ignoriert
 *  showDone ohnehin, s. filterEngine). */
function filterBadgeCount(plugin: OpalTasksPlugin, fl: FilterItem, today: string): number {
  return countFilter(plugin.index, fl.criteria, { ...fl.options, showDone: false }, today);
}

function navCounts(plugin: OpalTasksPlugin, tpls: TemplateInfo[], pa: ProjLists, flts: FilterItem[]): Map<string, number> {
  const m = new Map<string, number>();
  const { bereiche, projekte } = pa;
  m.set("p:" + INBOX_KEY, plugin.index.inboxOpen().length);   // eingebauter Eingang
  for (const id of VIEW_IDS) m.set("v:" + id, navCount(plugin, id));
  for (const p of bereiche) m.set("p:" + p.path, tasksInArea(plugin.index.open(), p, projekte).length);
  for (const p of projekte) m.set("p:" + p.path, plugin.index.byProject(p.path).length);
  const today = todayStr();
  for (const fl of flts) m.set("f:" + fl.path, filterBadgeCount(plugin, fl, today));
  for (const name of plugin.getVisibleLabels()) m.set("l:" + name, plugin.index.byLabel(name).length);
  // Ohne diese Zeile stünde für jede Vorlage KEIN Eintrag in der Karte, und tryPatchNav setzte
  // ihren Zähler beim nächsten Nachziehen auf leer (`counts.get(key) ?? 0`).
  for (const tpl of tpls) m.set("t:" + tpl.root.path, tpl.size);
  return m;
}

/** Struktur-Signatur OHNE Zahlen: gleich = dieselben Einträge in derselben Form. */
function navSignature(plugin: OpalTasksPlugin, tpls: TemplateInfo[], pa: ProjLists, flts: FilterItem[], archivedProjects: ProjItem[]): string {
  const { bereiche, projekte } = pa;
  const proj = (p: ProjItem): string =>
    // `areaId` is structural: changing it moves a project between the top-level section and an
    // Area. Omitting it made tryPatchNav treat that edit as a badge-only change, leaving the old
    // hierarchy mounted until some unrelated full redraw occurred.
    [p.path, p.name, p.icon, p.color, p.hidden, p.areaId, projectAreaName(p.area), p.workflowStatus, p.completed, p.priority].join("~");
  return JSON.stringify({
    areas: plugin.sortProjItems("areas", bereiche).map(proj),
    projects: plugin.sortProjItems("projects", projekte).map(proj),
    archivedProjects: archivedProjects.map((p) => p.path),
    filters: plugin.sortFilters(flts).map((f) => [f.path, f.name, f.icon, f.color, f.hidden].join("~")),
    labels: plugin.getVisibleLabels().map((n) => n + "~" + plugin.getLabelColor(n)),
    // Nicht die ANZAHL der Labels, sondern OB die Hinweiszeile steht. Die Zahl springt beim Start
    // von 0 auf N und erzwang damit einen vollständigen Neuaufbau der Seitenleiste, der am Bild
    // nichts änderte. `ready` steht daneben, weil es auch die Zeilen bei Projekten/Bereichen/
    // Filtern steuert – deren Listen sind oben schon in der Signatur.
    ready: plugin.index.ready,
    // OB es überhaupt Labels gibt – nicht nur die angehefteten. Der Abschnitt erscheint, sobald
    // irgendeines existiert (auch ein ausgeblendetes), `labels` oben führt aber nur die
    // sichtbaren. Ohne diese Zeile änderte ein neu getipptes, noch nicht eingeblendetes Label
    // die Signatur nicht – der Abschnitt bliebe weg, bis zufällig etwas anderes einen Neuaufbau
    // auslöst. Die übrigen Abschnitte brauchen das nicht: Ihre Listen oben enthalten die
    // ausgeblendeten Einträge bereits.
    hasLabels: plugin.getLabels().length > 0,
    // Vorlagen: Pfad, Name, Art und Sichtbarkeit je Wurzel – bewusst OHNE ihre Grösse. Die Grösse
    // ist der Zähler-Badge und wird von tryPatchNav nachgezogen; stünde sie hier, erzwänge jede
    // neue Unteraufgabe einer Vorlage einen vollständigen Neuaufbau der Seitenleiste.
    //
    // Die Liste kommt von aussen und wird NICHT hier berechnet: Signatur und Zähler laufen beide
    // bei jedem Nachziehen, und `listTemplates` kostet je Wurzel einen Cache-Zugriff, einen
    // Baum-Durchlauf und am Ende ein `localeCompare`-Sortieren. Einmal je Zeichnung genügt.
    //
    // Dasselbe gilt für `pa` und `flts` weiter oben: Beide waren bis dahin je zweimal berechnet –
    // hier und in navCounts –, und beide gehen dafür über JEDE Notiz des Vaults. Vier volle
    // Durchläufe pro Nachziehen, bei jedem Häkchen. Jetzt einer je Zeichnung, und der ist
    // seinerseits gemerkt (s. scanCache).
    templates: tpls.map((x) => [x.root.path, x.name, x.kind, x.hidden].join("~")),
    tplReady: plugin.templates.ready,
    active: JSON.stringify(plugin.activePage()),   // markiert wird die Seite des AKTIVEN Tabs
    collapsed: ["filters", "labels", "areas", "projects", "templates", ...bereiche.map((a) => "area:" + a.id)].map((id) => plugin.isNavCollapsed(id)),
    reorder: plugin.reorderSec,
    preview: plugin.colorPreview,
    locale: getLocale(),
  });
}

/** Versucht, nur die Zähler der Seitenleiste nachzuziehen. true = erledigt (kein Neuaufbau nötig). */
export function tryPatchNav(c: HTMLElement, plugin: OpalTasksPlugin): boolean {
  const m = navMounts.get(c);
  if (!m) return false;   // nichts montiert -> gar nicht erst rechnen
  // Die drei Listen EINMAL – Signatur und Zähler bekommen dieselben (s. navSignature).
  const tpls = plugin.sortTemplates(listTemplates(plugin));
  const pa = listProjectsAndAreas(plugin.app);
  const flts = listFilters(plugin.app);
  const archivedProjects = listManaged(plugin.app).archived.filter((p) => p.type === "project");
  if (m.sig !== navSignature(plugin, tpls, pa, flts, archivedProjects)) return false;
  const counts = navCounts(plugin, tpls, pa, flts);
  for (const [key, el] of m.badges) {
    const n = counts.get(key) ?? 0;
    el.setText(n ? String(n) : "");
  }
  for (const [path, el] of m.progresses) paintProjectProgress(el, plugin.index.projectProgress(path));
  return true;
}

export function renderNavInto(c: HTMLElement, plugin: OpalTasksPlugin): void {
  c.empty();
  c.addClass("bt-nav");
  const redraw = () => renderNavInto(c, plugin);
  // Rechtsklick auf den leeren Bereich der Seitenleiste. `defaultPrevented` ist die Weiche: Zeilen
  // und Sektionsköpfe rufen in ihrem eigenen Handler preventDefault(), und der läuft beim
  // Hochblubbern VOR diesem. So braucht es keine Prüfung auf Klassennamen, die beim nächsten
  // Umbau still falsch würde.
  c.oncontextmenu = (e) => {
    if (e.defaultPrevented) return;
    const m = new Menu();
    buildCreateSubmenu(m, plugin);
    e.preventDefault();
    m.showAtMouseEvent(e);
  };
  // Die Markierung folgt dem AKTIVEN Dashboard-Tab. Seit es mehrere geben kann, gibt es keine
  // „offene Seite" mehr, die das Plugin für sich kennen könnte – nur die des Tabs im Vordergrund.
  const act = plugin.activePage();
  const isActive = (kind: PageRef["kind"], key: string): boolean => !!act && act.kind === kind && act.key === key;
  const badges = new Map<string, HTMLElement>();
  const progresses = new Map<string, HTMLElement>();
  navBadges = badges;   // navItem trägt seine Zähler-Spans hier ein
  navProgresses = progresses;
  // EINMAL je Zeichnung berechnet: unten für die Zeilen der jeweiligen Sektion, ganz zum Schluss
  // für die Signatur. `listTemplates` kostet je Wurzel einen Cache-Zugriff, einen Baum-Durchlauf
  // und am Ende ein `localeCompare`-Sortieren, `listProjectsAndAreas`/`listFilters` je einen
  // Durchlauf über alle Notizen des Vaults – das gehört nicht mehrfach in eine Zeichnung.
  const pa = listProjectsAndAreas(plugin.app);
  const { bereiche, projekte } = pa;
  const archivedProjects = listManaged(plugin.app).archived.filter((p) => p.type === "project");
  const flts = listFilters(plugin.app);
  const tpls = plugin.sortTemplates(listTemplates(plugin));
  // Live-Vorschau der Icon-Farbe (Farb-Picker): überschreibt für EINEN Eintrag die gespeicherte Farbe.
  const navColor = (path: string, stored: string | null): string | null =>
    plugin.colorPreview?.key === path ? plugin.colorPreview.color : stored;
  const colorAreas = bereiche.map((area) => plugin.colorPreview?.key === area.path
    ? { ...area, color: plugin.colorPreview.color }
    : area);
  const projectNavColor = (item: ProjItem): string | null => {
    if ((item.type === "area" || plugin.settings.projectColorMode === "custom") && plugin.colorPreview?.key === item.path) {
      return plugin.colorPreview.color;
    }
    return projectDisplayColor(item, colorAreas, plugin.settings.projectColorMode);
  };

  // Fester App-Kopf: Globale Erstellung hat einen eindeutigen Ort und hängt nicht am Menü eines
  // Projekts. „Neue Aufgabe" nutzt weiterhin den aktiven Seitenkontext als hilfreichen Default.
  const appHead = c.createDiv({ cls: "bt-nav-app-head" });
  appHead.createSpan({ cls: "bt-nav-brand", text: "Opal Tasks" });
  const create = appHead.createEl("button", {
    cls: "bt-nav-new",
    attr: { type: "button", "aria-haspopup": "menu", "aria-label": t("menu_create_new") },
  });
  setIcon(create.createSpan({ cls: "bt-nav-new-icon" }), "plus");
  create.createSpan({ cls: "bt-nav-new-label", text: t("menu_create_new") });
  setIcon(create.createSpan({ cls: "bt-nav-new-chevron" }), "chevron-down");
  create.onclick = (e) => {
    e.stopPropagation();
    const menu = new Menu();
    addCreateItems(menu, plugin, true);
    menu.showAtMouseEvent(e);
  };

  // „Suchen" darunter: öffnet die Aufgaben-Suche (Command-Palette-Stil).
  navItem(c, plugin, { cls: "bt-nav-search", icon: "search", label: t("nav_search"), onClick: () => plugin.openSearch() });

  // Eingang ganz oben, OHNE Abschnittsüberschrift (über den Ansichten). Eingebaute Systemansicht
  // (keine Notiz) – KEIN volles Menü, nur der Kalender-Sync-Ein/Ausschalter (falls mit Google verbunden).
  navItem(c, plugin, {
    cls: "bt-nav-inbox", icon: "inbox", label: t("nav_inbox"),
    count: plugin.index.inboxOpen().length, countKey: "p:" + INBOX_KEY, active: isActive("project", INBOX_KEY),
    page: { kind: "project", key: INBOX_KEY },
    onClick: () => void plugin.activateProject(INBOX_KEY),
    // Der Eingang hat kein volles Item-Menü (Systemansicht ohne Notiz) – aber öffnen lässt er
    // sich wie jede andere Seite, und der Sync-Schalter kommt wie bisher dazu.
    onContext: (e) => {
      const m = new Menu();
      addOpenItems(m, plugin, { kind: "project", key: INBOX_KEY });
      addGcalSyncItem(m, plugin, INBOX_KEY);
      buildCreateSubmenu(m, plugin);
      m.showAtMouseEvent(e);
    },
    // Hierher gezogen = aus dem Projekt herausnehmen; „kein Projekt" IST der Eingang.
    onDropTask: (task) => { if (task.project) void plugin.setTaskProject(task, null); },
  });

  for (const id of VIEW_IDS) {
    const active = isActive("view", id);
    // Klasse pro Board (bt-nav-heute …) für einzeln themebare Icon-Farben.
    const page: PageRef = { kind: "view", key: id };
    navItem(c, plugin, {
      cls: "bt-nav-" + id, icon: VIEW_ICON[id], label: viewTitle(id), count: navCount(plugin, id), countKey: "v:" + id,
      active, page, onClick: () => void plugin.activateView(id),
      // Die eingebauten Ansichten haben nichts zu bearbeiten – ihr Menü besteht genau aus den
      // Öffnen-Einträgen. Ohne sie käme man an „Heute in einem zweiten Tab" nur per Modifier-Klick.
      // Eingang und die vier Ansichten verschwinden NIE. Sie tragen „Neu erstellen" deshalb
      // mit – auf einem Vault ohne Projekte, Labels, Filter und Vorlagen sind sie die einzigen
      // Zeilen, an denen ein Rechtsklick überhaupt etwas findet.
      onContext: (e) => { const m = new Menu(); addOpenItems(m, plugin, page); buildCreateSubmenu(m, plugin); m.showAtMouseEvent(e); },
    });
  }

  // cls = Kategorie-Klasse (bt-nav-area / bt-nav-project) für eine gemeinsame Icon-Farbe je Gruppe.
  // Rechtsklick auf einen Eintrag öffnet das Kontextmenü (Bearbeiten, Ausblenden, Sortieren, …).
  const projItems = (items: ProjItem[], cls: string, kind: "project" | "area", depth = 0,
    toggleFor?: (p: ProjItem) => NavItemOpts["toggle"]) => {
    const sec: NavSection = kind === "area" ? "areas" : "projects";
    const visible = items.filter((x) => !x.hidden);   // in der Verwaltung ausgeblendete weglassen
    if (plugin.reorderSec === sec) {
      renderReorderList(c, plugin, sec, visible.map((p) => ({
        key: p.path, name: p.name, icon: p.icon, color: projectNavColor(p),
        ...(kind === "project" ? { progress: plugin.index.projectProgress(p.path), progressKey: p.path } : {}),
      })));
      return;
    }
    for (const p of visible) {
      navItem(c, plugin, {
        cls, depth, toggle: toggleFor?.(p), icon: p.icon, iconColor: projectNavColor(p), label: p.name,
        ...(kind === "project" ? { progress: plugin.index.projectProgress(p.path), progressKey: p.path } : {}),
        count: kind === "area" ? tasksInArea(plugin.index.open(), p, projekte).length : plugin.index.byProject(p.path).length, countKey: "p:" + p.path,
        active: isActive("project", p.path), page: { kind: "project", key: p.path }, onClick: () => void plugin.activateProject(p.path),
        onContext: (e) => { const m = new Menu(); buildItemMenu(m, plugin, { sec, key: p.path, name: p.name, hidden: p.hidden, color: p.color, type: kind }); m.showAtMouseEvent(e); },
        // Verweise laufen über den Basename (s. setTaskProject); liegt die Aufgabe schon hier,
        // bleibt der Zug folgenlos statt die Notiz unnötig neu zu schreiben.
        onDropTask: (task) => { if (task.project !== p.path) void plugin.setTaskProject(task, baseName(p.path)); },
      });
    }
  };

  // ── Ab hier: Abschnitte, die es nur gibt, wenn es ihre Einträge gibt ──────────────────────
  //
  // Gefragt wird nach der EXISTENZ, nicht nach der Sichtbarkeit. Ein Abschnitt, dessen Einträge
  // alle ausgeblendet sind, behält seine Kopfzeile: Sie trägt den Rechtsklick „Ausgeblendete
  // einblenden" UND den Weg zur Übersichtsseite. Verschwände sie, käme man an beides nicht mehr
  // heran – die Einträge wären aus der Oberfläche heraus nicht mehr erreichbar.
  //
  // Umgekehrt braucht ein Abschnitt ohne einen einzigen Eintrag auch keine Übersichtsseite: Dort
  // gäbe es nichts zu verwalten. Angelegt wird über „Neu erstellen" im Kontextmenü – und Projekt,
  // Bereich und Label entstehen ohnehin beim Anlegen einer Aufgabe.

  // Filter-Sektion: „+" öffnet den Filter-Editor. Rechtsklick = bearbeiten.
  const today = todayStr();
  const filters = plugin.sortFilters(flts);
  if (filters.length) {
    const filtersCollapsed = navHead(c, plugin, "filters", t("nav_filters"), t("filter_add"), "", redraw,
      async () => undefined, () => new FilterModal(plugin).open());
    if (plugin.reorderSec === "filters") {
      renderReorderList(c, plugin, "filters", filters.filter((f) => !f.hidden).map((f) => ({ key: f.path, name: f.name, icon: f.icon, color: f.color })));
    } else if (!filtersCollapsed) {
      for (const fl of filters) {
        if (fl.hidden) continue;   // im ListManager ausgeblendete Filter nicht in der Nav zeigen
        navItem(c, plugin, {
          cls: "bt-nav-filter", icon: fl.icon, iconColor: navColor(fl.path, fl.color), label: fl.name,
          count: filterBadgeCount(plugin, fl, today), countKey: "f:" + fl.path,
          active: isActive("filter", fl.path), page: { kind: "filter", key: fl.path }, onClick: () => void plugin.activateFilter(fl.path),
          onContext: (e) => { const m = new Menu(); buildItemMenu(m, plugin, { sec: "filters", key: fl.path, name: fl.name, hidden: fl.hidden, color: fl.color }); m.showAtMouseEvent(e); },
        });
      }
    }
  }

  // Completed projects leave their normal Area/Project position immediately. They remain
  // reachable in a distinct, subdued group for three days; the lifecycle reconciler archives
  // them after that window.
  const activeProjects = projekte.filter((p) => !isDone(p.workflowStatus));
  const recentlyCompleted = projekte.filter((p) => isRecentlyCompletedProject(p))
    .sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  const visibleRecentlyCompleted = recentlyCompleted.filter((project) => !project.hidden);

  // Bereiche: „+" öffnet das Neu-Modal (Name + Farbe), legt als type:area an.
  if (bereiche.length) {
    const areasCollapsed = navHead(c, plugin, "areas", t("group_area"), t("pick_new_area"), "", redraw,
      async () => undefined, () => new NewItemModal(plugin, "area").open());
    const orderedAreas = plugin.sortProjItems("areas", bereiche);
    if (plugin.reorderSec === "areas") projItems(orderedAreas, "bt-nav-area", "area");
    else if (!areasCollapsed) {
      for (const area of orderedAreas.filter((x) => !x.hidden)) {
        const children = plugin.sortProjItems("projects", projectsInArea(area, activeProjects));
        const visibleChildren = children.filter((project) => !project.hidden);
        const collapseKey = "area:" + area.id;
        const collapsed = plugin.isNavCollapsed(collapseKey);
        projItems([area], "bt-nav-area", "area", 0, visibleChildren.length ? () => ({
          collapsed,
          onToggle: () => void plugin.toggleNavSection(collapseKey),
        }) : undefined);
        if (!collapsed) projItems(children, "bt-nav-project bt-nav-child", "project", 1);
      }
    }
  }

  // Nur Projekte ohne gültige aktive Area bleiben im eigenen Abschnitt. Zugeordnete Projekte
  // erscheinen ausschließlich eingerückt unter ihrer Area.
  const activeAreas = new Set(bereiche.map((a) => baseName(a.path).toLowerCase()));
  const activeAreaIds = new Set(bereiche.map((a) => a.id));
  const unassigned = activeProjects.filter((p) => {
    const area = projectAreaName(p.area);
    return p.areaId ? !activeAreaIds.has(p.areaId) : !area || !activeAreas.has(area.toLowerCase());
  });
  if (unassigned.length) {
    const projCollapsed = navHead(c, plugin, "projects", t("group_project"), t("pick_new_project"), "", redraw,
      async () => undefined, () => new NewItemModal(plugin, "project").open());
    if (!projCollapsed || plugin.reorderSec === "projects") projItems(plugin.sortProjItems("projects", unassigned), "bt-nav-project", "project");
  }

  if (visibleRecentlyCompleted.length) {
    const collapsed = navGroupHead(c, plugin, "recently-completed", t("nav_recently_completed"));
    if (!collapsed) {
      for (const p of visibleRecentlyCompleted) {
        navItem(c, plugin, {
          cls: "bt-nav-project bt-nav-project-completed", icon: "check-circle", iconColor: projectNavColor(p),
          progress: plugin.index.projectProgress(p.path), progressKey: p.path,
          label: p.name, suffix: t("status_done"), active: isActive("project", p.path),
          page: { kind: "project", key: p.path }, onClick: () => void plugin.activateProject(p.path),
          onContext: (e) => { const m = new Menu(); buildItemMenu(m, plugin, { sec: "projects", key: p.path, name: p.name, hidden: p.hidden, color: p.color, type: "project" }); m.showAtMouseEvent(e); },
        });
      }
    }
  }

  // A permanent route back to auto-archived projects. This also fixes the otherwise awkward
  // all-projects-archived case, where the normal Projects heading no longer exists.
  if (archivedProjects.length) {
    navItem(c, plugin, {
      cls: "bt-nav-archive", icon: "archive", label: t("tab_archive"), count: archivedProjects.length,
      active: isActive("manage", "projects"), page: { kind: "manage", key: "projects" },
      onClick: () => void plugin.activateManage("projects", "archive"),
    });
  }

  // Labels folgen auf die vollständige Bereichs-/Projekt-Hierarchie: „+" öffnet das Neu-Modal,
  // Rechtsklick = bearbeiten.
  //
  // `getLabels()` zählt die Labels der AUFGABEN mit, hängt also am Index – beim Start ist der noch
  // leer. Das ist hier trotzdem der richtige Test, denn getLabels() nimmt `knownLabels` und
  // `visibleLabels` IMMER mit auf (beide aus den Einstellungen, sofort da). Wer Labels angeheftet
  // oder im Register hat, sieht den Abschnitt also ohne Verzögerung; nur ein Vault, dessen Labels
  // ausschliesslich auf Aufgaben leben, bekommt ihn eine Wimper später. Die andere Richtung –
  // erst zeigen, dann verschwinden – kann so nicht auftreten, und genau die war 1.39.1.
  if (plugin.getLabels().length) {
    const labelsCollapsed = navHead(c, plugin, "labels", t("tab_labels"), t("add_label"), "", redraw,
      async () => undefined, () => new NewItemModal(plugin, "label").open());
    if (plugin.reorderSec === "labels") {
      renderReorderList(c, plugin, "labels", plugin.getVisibleLabels().map((n) => ({ key: n, name: n, icon: "hash", color: plugin.getLabelColor(n) })));
    } else if (!labelsCollapsed) {
      for (const name of plugin.getVisibleLabels()) {
        const count = plugin.index.byLabel(name).length;   // byLabel nutzt open() → ohne archivierte Projekte
        navItem(c, plugin, {
          cls: "bt-nav-label", icon: "hash", iconColor: navColor(name, plugin.getLabelColor(name)), label: name, count, countKey: "l:" + name,
          active: isActive("label", name), page: { kind: "label", key: name }, onClick: () => void plugin.activateLabel(name),
          onContext: (e) => { const m = new Menu(); buildItemMenu(m, plugin, { sec: "labels", key: name, name, hidden: !plugin.isLabelVisible(name), color: plugin.getLabelColor(name) }); m.showAtMouseEvent(e); },
          // Anders als bei Projekt/Bereich/Eingang wird hier nichts VERSCHOBEN, sondern ERGÄNZT:
          // Die Aufgabe bleibt, wo sie ist, und bekommt das Label dazu. Sichtbar wird das sofort am
          // neuen Chip in ihrer Meta-Zeile. Trägt sie es schon, bleibt der Zug folgenlos.
          onDropTask: (task) => { if (!task.labels.includes(name)) void plugin.swapTaskLabel(task, null, name); },
        });
      }
    }
  }

  // Vorlagen ganz unten: „+" legt eine leere an. Ein KLICK wendet an – nicht „öffnet", wie bei den
  // Abschnitten darüber. Das ist Absicht: Anwenden ist die Handlung, die man vielfach häufiger
  // ausführt als Bearbeiten, und eine Vorlagen-SEITE gibt es (noch) nicht. Bearbeiten liegt
  // deshalb im Rechtsklick-Menü.
  //
  // Der Abschnitt hängt am ZWEITEN Index (plugin.templates) – der Aufgaben-Index kennt Vorlagen
  // nicht und soll sie auch nie kennen (s. IndexScope in taskIndex.ts).
  if (tpls.length) {
    const tplCollapsed = navHead(c, plugin, "templates", t("nav_templates"), t("create_template"), "", redraw,
      async () => undefined, () => promptNewTemplate(plugin));
    if (plugin.reorderSec === "templates") {
      renderReorderList(c, plugin, "templates", tpls.filter((x) => !x.hidden).map((x) => ({ key: x.root.path, name: x.name, icon: x.kind === "project" ? "folder-plus" : "clipboard-list", color: null })));
    } else if (!tplCollapsed) {
      for (const tpl of tpls) {
        if (tpl.hidden) continue;   // in der Übersicht ausgeblendete Vorlagen nicht in der Nav zeigen
        navItem(c, plugin, {
          cls: "bt-nav-template", icon: tpl.kind === "project" ? "folder-plus" : "clipboard-list", label: tpl.name,
          count: tpl.size, countKey: "t:" + tpl.root.path,
          onClick: () => new ApplyTemplateModal(plugin, tpl, plugin.addContext().project ?? null).open(),
          onContext: (e) => { buildTemplateMenu(plugin, tpl).showAtMouseEvent(e); },
        });
      }
    }
  }

  navBadges = null;
  navProgresses = null;
  navMounts.set(c, { sig: navSignature(plugin, tpls, pa, flts, archivedProjects), badges, progresses });
}

function navCount(plugin: OpalTasksPlugin, id: ViewId): number {
  const today = todayStr();
  if (id === "heute") {
    const buckets = todayBuckets(plugin, today);
    return buckets.overdue.length + buckets.today.length;
  }
  if (id === "demnaechst") return plugin.index.upcoming(today).length;
  if (id === "wiederkehrend") return plugin.index.open().filter((tk) => tk.recurrence).length;
  return 0;
}

/** Fortlaufende Nummer für die Tab-Kennung (s. MainView.id). Bewusst KEIN Pfad/Seitenname:
 *  die Kennung muss den Seitenwechsel eines Tabs überleben und zwei Tabs derselben Seite
 *  auseinanderhalten – beides kann nur eine Identität des Leafs selbst. */
let viewSeq = 0;

/** Erlaubte Werte aus einem gespeicherten Zustand herausfiltern (Workspace-Datei ist fremder Input). */
const oneOfState = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/** Wie oneOfState, nur für MainView.planMates: aus der Workspace-Datei kommt fremder Input,
 *  also wird jeder Pfad einzeln geprüft. Ohne brauchbaren Eintrag: null (= nichts gemerkt). */
function readPlanMates(v: unknown): Partial<Record<"note" | "daily", string>> | null {
  if (!v || typeof v !== "object") return null;
  const src = v as Record<string, unknown>;
  const out: Partial<Record<"note" | "daily", string>> = {};
  for (const k of ["note", "daily"] as const) {
    const p = src[k];
    if (typeof p === "string" && p) out[k] = p;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ein Dashboard-Tab. Er BESITZT seine Seite (this.page) – bis 1.33 stand die auf der Plugin-
 * Instanz, weshalb es per Konstruktion nur einen sinnvollen Tab geben konnte. Über getState/
 * setState hängt die Seite jetzt an der Leaf: Obsidian stellt sie beim Neustart wieder her,
 * „In neuem Tab öffnen" ergibt zwei UNTERSCHIEDLICHE Ansichten, und jeder Tab behält seine
 * Scrollpositionen, Klappzustände und sein Layout (s. setLayout).
 */
export class MainView extends ItemView {
  private unsub: (() => void) | null = null;
  private unsubTpl: (() => void) | null = null;
  private renderComp: Component | null = null;
  /** Zeichnung steht aus, weil der Tab gerade verdeckt ist (s. draw/drawIfDirty). */
  private dirty = false;
  /** Stabile Kennung DIESES Tabs – Bestandteil jedes Schlüssels für transienten Zustand (viewKey). */
  readonly id = "v" + (++viewSeq);
  /** Die Seite, die dieser Tab zeigt. */
  page: PageRef;
  /** Die Wahl DIESES Tabs; was hier fehlt, kommt vom Seiten-Standard (s. setLocal/useLocal). */
  private local: Partial<LocalOptions> = {};
  /**
   * Rolle dieses Tabs im Planungs-Split, sonst null. Ohne diese Merkung legte jeder Aufruf von
   * „Planen" eine WEITERE Anordnung an: Der Befehl übernahm irgendeinen Tab und spaltete einen
   * neuen ab, während die Hälften des vorigen Splits stehen blieben – nach zwei Aufrufen standen
   * drei Ansichten nebeneinander. Mit der Rolle findet der Befehl seine eigenen Tabs wieder und
   * schickt sie beide auf die neue Seite. Wandert in getState: die Paarung übersteht den Neustart.
   */
  planRole: "list" | "calendar" | null = null;
  /**
   * Nur am LISTEN-Tab: welche Dateien er in der rechten Hälfte abgelegt hat (je Rolle ein Pfad).
   *
   * Warum das nötig ist: Die rechte Gruppe wird bisher über `planRole` des Kalender-Tabs
   * wiedergefunden. Seit der Kalender abschaltbar ist (s. planTabs.ts), kann dort aber
   * ausschließlich ein Markdown-Tab stehen – und ein MarkdownView kann keine Rolle tragen.
   * Ohne diese Merkung fände „Planen" seine eigene Anordnung nicht wieder und spaltete bei
   * jedem Aufruf eine weitere ab: genau die Regression, die `planRole` schon einmal behoben hat.
   *
   * Wandert in getState und übersteht damit den Neustart – die Markdown-Tabs stellt Obsidian
   * selbst wieder her, gefunden werden sie danach über ihren Pfad.
   */
  planMates: Partial<Record<"note" | "daily", string>> | null = null;
  /**
   * Kam die Layout-Wahl dieses Tabs vom Planen-Befehl – und darf beim Auflösen der Anordnung
   * deshalb wieder zurückgenommen werden?
   *
   * Ohne diese Unterscheidung ginge beim Aufräumen auch verloren, was der Nutzer im Split von
   * Hand eingestellt hat. `useLocal` selbst kann das nicht wissen: Ihm sieht man nicht an, ob
   * der Befehl oder ein Mensch dahintersteckt. Die Merkung verfällt, sobald jemand den
   * Layout-Umschalter benutzt (s. setLocal) oder der Tab die Seite wechselt.
   */
  planForced = false;
  /** Umschaltbarer Unterzustand der Seite. Bewusst ein eigenes OBJEKT: der Kontext hält eine
   *  Referenz darauf und liest per Getter mit – ein Abzug wäre veraltet, sobald ein Umschalter
   *  ihn setzt und mit demselben Kontext neu zeichnet (Verwaltungs-Tabs machen genau das). */
  private tab = { doneTab: "done" as "done" | "trash", manageTab: "active" as "active" | "archive", doneCollapsed: true };

  constructor(leaf: WorkspaceLeaf, private plugin: OpalTasksPlugin) {
    super(leaf);
    this.page = plugin.newTabStartPage();
  }
  getViewType(): string { return VIEW_MAIN; }

  /**
   * Tab- und Pane-Titel = der NAME DER SEITE, nicht der Programmname. Solange es genau eine
   * Dashboard-Leaf gab, war „Opal Tasks" eine brauchbare Beschriftung; bei drei offenen Tabs
   * sähen alle drei gleich aus. Projekt- und Bereichsseiten tragen zusätzlich ihre Art, damit
   * ihr Dashboard-Tab nicht genauso heißt wie die daneben geöffnete Markdown-Notiz.
   *
   * Bewusst OHNE Unterzustand: „Erledigt" bleibt „Erledigt", auch wenn gerade der Papierkorb-Tab
   * innerhalb der Seite aktiv ist – der Tab-Titel benennt die Seite, nicht die Stelle darin.
   */
  getDisplayText(): string {
    const p = this.page;
    if (p.kind === "manage") return t(manageTitleKey(p.key));
    if (p.kind === "filter") return readFilter(this.plugin.app, p.key)?.name ?? baseName(p.key);
    if (p.kind === "label") return "#" + p.key;
    if (p.kind === "project") {
      if (p.key === INBOX_KEY) return t("nav_inbox");
      const { active, archived } = listManaged(this.plugin.app);
      const record = [...active, ...archived].find((item) => item.path === p.key);
      const name = projectDisplayName(record?.name ?? baseName(p.key));
      const kind = t((record?.type === "area" || (!record && isAreaPath(this.plugin.app, p.key))) ? "kind_area" : "kind_project");
      return `${name} (${kind})`;
    }
    return viewTitle(p.key as ViewId);
  }

  /**
   * Icon = das LAYOUT (Liste · Board · Kalender). Genau das unterscheidet zwei Tabs derselben
   * Seite – ihre Titel sind ja identisch, und für „Liste links, Kalender rechts" ist das die
   * einzige Angabe, die zählt. Seiten ohne Layout-Wahl (Wiederkehrend, Erledigt, Verwaltung)
   * behalten ihr eigenes Ansichts-Icon.
   *
   * ══ Reiter-Icons gibt es im Plugin auf ZWEI Wegen – dies ist der eine ══════════
   * Gerendert wird beides gleich: updateHeader() ruft leaf.getIcon() -> view.getIcon().
   * Auseinander gehen die Wege davor und danach:
   *
   *   HIER (eigene View): Wir besitzen die Klasse, also überschreiben wir getIcon() und
   *   BERECHNEN das Zeichen bei jeder Zeichnung neu. Es kann per Konstruktion nicht veralten,
   *   und weil unser View-Typ nicht "markdown" ist, greift Obsidians Ausblende-Regel nicht –
   *   es braucht keine Zeile CSS.
   *
   *   DORT (fremde View, s. main.setLeafIcon): Ein Markdown-Tab gehört Obsidian; eine Methode
   *   lässt sich dort nicht überschreiben. Stattdessen wird die Eigenschaft `view.icon`
   *   GESTEMPELT, die die Basis-getIcon() zurückgibt. Ein Stempel kann veralten (der Nutzer
   *   folgt einem Link) – deshalb gibt es dort eine Aufräumpflicht (clearStalePlanTabs), die
   *   es hier nicht braucht. Und weil `data-type` dort "markdown" ist, muss die Sichtbarkeit
   *   per Klasse `bt-plan-tab` erkämpft werden (s. styles.css).
   *
   * Wer an einem der beiden Wege etwas ändert, sollte den anderen kennen.
   * ═══════════════════════════════════════════════════════════════════════════════
   */
  getIcon(): string {
    const p = this.page;
    if (p.kind === "manage") return "list-plus";
    if (pageInfo(p).tier === "none") return VIEW_ICON[p.key as ViewId] ?? "check-circle";
    return LAYOUT_ICON[this.local.layout ?? this.plugin.pageOptions(p).layout];
  }

  /** Zustand, den Obsidian in die Workspace-Datei schreibt: die Seite dieses Tabs plus das,
   *  was man beim Neustart erwartet, wieder vorzufinden. */
  getState(): Record<string, unknown> {
    return {
      kind: this.page.kind, key: this.page.key,
      layout: this.local.layout ?? null, calPanel: this.local.calPanel ?? null,
      doneTab: this.tab.doneTab, manageTab: this.tab.manageTab, planRole: this.planRole,
      planMates: this.planMates, planForced: this.planForced,
    };
  }

  /**
   * Der EINZIGE Weg, diesen Tab auf eine andere Seite zu schicken – von der Workspace-
   * Wiederherstellung, von plugin.openPage() und von ctx.open() gleichermaßen benutzt.
   * `history` bleibt bewusst false: MainView ist keine navigierbare Datei-Ansicht, ein
   * Eintrag in Obsidians Zurück/Vorwärts-Kette wäre hier irreführend.
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as Record<string, unknown>;
    const kind = oneOfState<PageRef["kind"]>(s.kind, ["view", "project", "label", "filter", "manage"]);
    const key = typeof s.key === "string" ? s.key : "";
    const page: PageRef = kind && key ? { kind, key } : this.page;
    const changed = !samePage(page, this.page);
    if (changed) {
      closeInlineTaskEditor(this.id, false);
      // Transienten Zustand der ALTEN Seite wegwerfen: Scrollposition und aufgeklappte Badges
      // gehören zu ihr, nicht zum Tab – sonst erbte die neue Seite eine fremde Position.
      dropViewKeys(this.id);
      this.local = {};              // neue Seite startet bei IHREN Standards
      this.planForced = false;      // die erzwungene Wahl galt der ALTEN Seite
      this.tab.doneTab = "done";
      this.tab.doneCollapsed = true;
    }
    this.page = page;
    // Beim Wiederherstellen kommen die gemerkten Werte mit; bei einem Seitenwechsel gibt es sie nicht.
    const layout = oneOfState<PageLayout>(s.layout, LAYOUTS);
    if (layout) this.local.layout = layout;
    if (typeof s.calPanel === "boolean") this.local.calPanel = s.calPanel;
    // Die Rolle hängt am TAB, nicht an der Seite: Ein Seitenwechsel im Planungs-Split lässt ihn
    // ein Planungs-Split bleiben. Deshalb wird sie NUR übernommen, wenn der Zustand wirklich eine
    // mitbringt (Wiederherstellung aus der Workspace-Datei) – eine gewöhnliche Navigation reicht
    // nur {kind, key} herein und darf die Rolle nicht stillschweigend löschen. Genau das tat sie:
    // Nach einem Klick in der Seitenleiste fand „Planen" seine Hälften nicht mehr wieder und
    // spaltete eine dritte Ansicht ab.
    const role = oneOfState<"list" | "calendar">(s.planRole, ["list", "calendar"]);
    if (role) this.planRole = role;
    // Aus demselben Grund wie die Rolle nur übernehmen, wenn der Zustand wirklich etwas mitbringt:
    // Eine gewöhnliche Navigation reicht nur {kind, key} herein und darf die Paarung nicht löschen.
    const mates = readPlanMates(s.planMates);
    if (mates) this.planMates = mates;
    if (typeof s.planForced === "boolean") this.planForced = s.planForced;
    const done = oneOfState<"done" | "trash">(s.doneTab, ["done", "trash"]);
    if (done) this.tab.doneTab = done;
    const mtab = oneOfState<"active" | "archive">(s.manageTab, ["active", "archive"]);
    if (mtab) this.tab.manageTab = mtab;
    result.history = false;
    this.draw();
  }

  /** Diesen Tab auf eine andere Seite schicken (Backlink, „Zum Projekt", Verwaltungs-Liste, Nav). */
  openPage(page: PageRef): void {
    void this.setState({ kind: page.kind, key: page.key }, { history: false });
    this.plugin.app.workspace.requestSaveLayout();   // Seite des Tabs übersteht den Neustart
    this.plugin.renderNav();                         // Markierung folgt dem aktiven Tab
  }

  /**
   * Layout umstellen. Das Layout gehört dem TAB: Wer die Liste in einem und den Kalender in
   * einem zweiten Tab offen hat, darf beim Umschalten hier nicht den anderen mitreißen – dafür
   * gibt es den zweiten Tab ja gerade. Deshalb bekommt jeder ANDERE Tab derselben Seite, der
   * bisher nur dem Seiten-Standard folgte, vorher ausdrücklich den ALTEN Wert: er bleibt damit
   * stehen, wo er war. Der neue Wert wird zusätzlich als Seiten-Standard gespeichert (wie
   * bisher) – die nächste Zeichnung dieser Seite beginnt also dort.
   */
  /**
   * Nur für diesen Tab setzen – ohne den Seiten-Standard anzufassen. Das ist der Unterschied zu
   * setLocal: Der Planungs-Split ordnet dieselbe Seite für JETZT als Liste und Kalender an; er
   * sagt nichts darüber, wie sie beim nächsten Öffnen aussehen soll.
   * Weil es nur den eigenen Tab betrifft, braucht es hier auch kein Einfrieren der Nachbarn.
   */
  useLocal(patch: Partial<LocalOptions>, planRole: "list" | "calendar" | null = this.planRole): void {
    Object.assign(this.local, patch);
    this.planRole = planRole;
    this.plugin.app.workspace.requestSaveLayout();   // die Anordnung übersteht den Neustart
    this.draw();
  }

  /**
   * Die Planungsanordnung ist vorbei – diesen Tab wieder zu einem gewöhnlichen machen.
   *
   * Zurückgenommen wird NUR, was der Befehl selbst erzwungen hat (planForced). Der Tab fällt
   * damit auf den Seiten-Standard zurück: Wer sein Projekt normalerweise als Board sieht, sieht
   * es danach wieder als Board. Ohne das blieb die Liste stehen, bis der Tab zufällig die Seite
   * wechselte – dann räumt setState `local` ohnehin ab, und genau deshalb kam das Board zurück,
   * sobald man in der Seitenleiste weg und wieder hin klickte.
   *
   * `planRole` bleibt bewusst erhalten: Sie sagt, WOZU dieser Tab gehört, und sorgt dafür, dass
   * ein späteres „Planen" wieder ihn als Liste nimmt statt einen dritten aufzumachen.
   */
  /** Nur die vom Befehl erzwungene Layout-Wahl zurücknehmen – ohne die Anordnung zu beenden.
   *  Gebraucht auch beim Aufbau, wenn „Liste links erzwingen" inzwischen ausgeschaltet wurde:
   *  Der Tab trüge sonst noch die Liste aus einem früheren Aufruf. */
  dropForcedLayout(): void {
    if (!this.planForced) return;
    this.planForced = false;
    delete this.local.layout;
    delete this.local.calPanel;
  }

  endPlanArrangement(): void {
    const hatteMates = this.planMates !== null;
    if (!hatteMates && !this.planForced) return;   // nichts aufzuräumen
    this.planMates = null;
    this.dropForcedLayout();
    this.plugin.app.workspace.requestSaveLayout();
    this.draw();
  }

  setLocal(patch: Partial<LocalOptions>): void {
    const before = this.plugin.pageOptions(this.page);
    for (const other of this.plugin.mainViews()) {
      if (other === this || !samePage(other.page, this.page)) continue;
      // Nur je Schlüssel einfrieren, und nur wo der Nachbar bisher dem Seiten-Standard folgte:
      // Ein Tab, der sein Layout schon selbst gewählt hat, wird von einer Panel-Änderung hier
      // nicht angefasst und umgekehrt.
      for (const k of Object.keys(patch) as (keyof LocalOptions)[]) {
        if (other.local[k] === undefined) Object.assign(other.local, { [k]: before[k] });
      }
    }
    // Wer den Umschalter selbst benutzt, entscheidet selbst: Ab hier gilt die Wahl als seine,
    // und das Auflösen der Anordnung nimmt sie nicht mehr zurück (s. planForced).
    if (patch.layout !== undefined) this.planForced = false;
    Object.assign(this.local, patch);
    void this.plugin.setPageOption(this.page, patch);
    // Sofort zeichnen statt auf den Speicher zu warten: auf einer PROJEKT-Seite landet der neue
    // Wert im Frontmatter und käme erst mit dem metadataCache-Ereignis zurück. Der eingefrorene
    // Nachbar-Tab (oben) soll aber im selben Moment sichtbar stehen bleiben, nicht erst gleich.
    this.plugin.renderMain();
  }

  /**
   * Der Kontext, den die Zeichen-Funktionen bekommen – siehe pageCtx.ts.
   *
   * `opts` und `titleComp` sind bewusst MOMENTAUFNAHMEN (sie gelten für genau diese Zeichnung).
   * Der umschaltbare Unterzustand dagegen kommt über Getter aus der View: Aufrufer wie die
   * Verwaltungs-Tabs setzen ihn und zeichnen mit DEMSELBEN ctx neu – ein eingefrorener Wert
   * hätte dort weiter den alten Stand gezeigt und den Umschalter tot wirken lassen.
   */
  ctx(): PageCtx {
    const info = pageInfo(this.page);
    const stored = this.plugin.pageOptions(this.page);
    const crit = this.plugin.pageCriteria(this.page);
    const st = this.tab;   // DASSELBE Objekt, keine Kopie – nur so sehen die Getter jede Änderung
    return {
      plugin: this.plugin,
      id: this.id,
      page: this.page,
      pageKey: info.key,
      opts: { ...stored, ...this.local },
      crit,
      // Ohne Kriterien dieselbe Liste zurückgeben statt einer Kopie: der Ansichtsfilter ist der
      // Ausnahmefall, und jede Seite geht durch diese Funktion.
      filter: (list) => (hasCriteria(crit) ? filterTasks(list, crit, todayStr()) : list),
      titleComp: this.renderComp,
      get doneTab() { return st.doneTab; },
      get manageTab() { return st.manageTab; },
      get doneCollapsed() { return st.doneCollapsed; },
      setDoneTab: (v) => { st.doneTab = v; },
      setManageTab: (v) => { st.manageTab = v; },
      setDoneCollapsed: (v) => { st.doneCollapsed = v; },
      redraw: () => this.draw(),
      open: (p) => this.openPage(p),
      setOption: (patch) => void this.plugin.setPageOption(this.page, patch),
      setCriteria: (patch) => void this.plugin.setPageCriteria(this.page, patch),
      setLayout: (l) => this.setLocal({ layout: l }),
      setCalPanel: (open) => this.setLocal({ calPanel: open }),
      resetOptions: () => { this.local = {}; void this.plugin.resetPageOptions(this.page); },
    };
  }

  async onOpen(): Promise<void> {
    // Checkbox-Aktionen EINMAL delegiert (nicht je Zeichnung je Checkbox – s. taskCheck.ts).
    installCheckDelegation(this.contentEl, this.plugin);
    // Zeilen-Kontextmenü (Rechtsklick/Long-Press) genauso: EIN Satz Listener für alle Zeilen.
    // Der Kontext wird als Funktion gereicht, nicht als Wert: die Delegation lebt so lange wie
    // der Tab, der Kontext dagegen wird je Zeichnung neu gebaut.
    installTaskMenuDelegation(this.contentEl, () => this.ctx());
    // Scrollposition der Liste mitschreiben (s. listScroll). Wie bei den Board-Spalten schreibt
    // das Ereignis auch einen vom Browser geklemmten Wert zurück – die Erinnerung korrigiert
    // sich damit selbst, wenn die Seite kürzer geworden ist.
    this.registerDomEvent(this.contentEl, "scroll", () => listScroll.set(this.scrollKey(), this.contentEl.scrollTop));
    if (!this.unsub) this.unsub = this.plugin.index.subscribe(() => this.draw());
    // Zweites Abo auf den Vorlagen-Index: Die Vorlagen-Übersicht liest aus ihm, und er meldet
    // getrennt. Ohne das bliebe die Seite nach Umbenennen, Löschen oder einer im Editor
    // hinzugefügten Unteraufgabe auf dem alten Stand, bis sich zufällig eine Aufgabe ändert.
    if (!this.unsubTpl) this.unsubTpl = this.plugin.templates.subscribe(() => this.draw());
    this.draw();
  }
  async onClose(): Promise<void> {
    closeInlineTaskEditor(this.id, false);
    this.unsub?.(); this.unsub = null;
    this.unsubTpl?.(); this.unsubTpl = null;
    dropViewKeys(this.id);   // sonst wüchsen die Modul-Maps mit jedem geschlossenen Tab weiter
  }
  /** Schlüssel der gemerkten Scrollposition. Nur die Tab-Kennung: Beim Seitenwechsel wirft
   *  dropViewKeys den Eintrag ohnehin weg, die neue Seite startet also oben. */
  private scrollKey(): string { return this.id + "|scroll"; }
  /** Beim Sichtbarwerden nachziehen, falls in der Zwischenzeit vorgemerkt (s. draw). */
  drawIfDirty(): void { if (this.dirty) this.draw(); }
  onResize(): void {
    // Headers and responsive board projections have intentionally different DOM. Rebuild only
    // when one of those contracts changes; ordinary resizes remain free. An active inline editor
    // is never torn out from under the user's cursor—the next normal draw adopts the new density.
    const shellCrossed = isCompactPane(this.contentEl) !== this.contentEl.hasClass("bt-mobile");
    const renderedBoard = this.contentEl.dataset.boardProjection as BoardProjection | undefined;
    const boardCrossed = !!renderedBoard && boardProjection(this.contentEl) !== renderedBoard;
    const crossed = shellCrossed || boardCrossed;
    if (crossed && !inlineTaskEditorOpen(this.id)) {
      this.contentEl.empty();   // invalidates the fast-patch mounts and guarantees a full shell draw
      this.draw();
      return;
    }
    this.drawIfDirty();
  }

  draw(): void {
    if (!this.contentEl) return;
    // Titel und Icon IMMER nachziehen – auch verdeckt und auch auf dem Schnellpfad unten. Sie
    // hängen am REITER, nicht am Inhalt: Ein Tab im Hintergrund ist zwar unsichtbar, seine
    // Beschriftung in der Tab-Leiste ist es nicht. Lag das hinter der Sichtbarkeitsprüfung,
    // trug ein Hintergrund-Tab nach einem Seitenwechsel weiter den alten Namen – bis man ihn
    // anklickte und er sich dabei zeichnete. Zu sehen im Planungs-Split: „Planen" auf einem
    // zweiten Projekt schickte den verdeckten Kalender-Tab auf die neue Seite, beschriftet
    // blieb er mit der alten. Kostet zwei setText – kein Grund, es aufzuschieben.
    this.syncTitle();
    // Mirror the linked-note card's project colour at the very top of the whole Opal Tasks pane.
    // This runs before the fast-patch returns as well, so recolouring updates the rail without
    // requiring a full page rebuild. Inbox and non-project pages deliberately have no rail.
    const contextRecord = this.page.kind === "project" && this.page.key !== INBOX_KEY
      ? (() => {
          const { active, archived } = listManaged(this.plugin.app);
          return [...active, ...archived].find((item) => item.path === this.page.key) ?? null;
        })()
      : null;
    this.contentEl.toggleClass("bt-project-record", contextRecord !== null);
    if (contextRecord) {
      const areas = listProjectsAndAreas(this.plugin.app).bereiche;
      const color = projectDisplayColor(contextRecord, areas, this.plugin.settings.projectColorMode);
      this.contentEl.style.setProperty("--bt-project-context", color || "var(--text-faint)");
    }
    else this.contentEl.style.removeProperty("--bt-project-context");
    // Ein Inline-Editor ist selbst die aktuelle Arbeitsfläche. Index-Meldungen (etwa ein im
    // Editor geänderter Status) dürfen seinen DOM nicht unter dem Cursor wegzeichnen.
    if (inlineTaskEditorOpen(this.id)) return;
    // Ein VERDECKTER Tab (anderer Tab derselben Gruppe) wird nur vorgemerkt. Solange es genau
    // eine Dashboard-Leaf gab, war das kein Thema; mit drei offenen Tabs zahlte man den vollen
    // Aufbau (gemessen ~110 ms) bei JEDER Aufgabenänderung dreifach – zweimal davon für Seiten,
    // die niemand ansieht. Nachgezogen wird beim Sichtbarwerden (onResize bzw. der
    // active-leaf-change-Zweig in main.ts).
    if (!this.containerEl.isShown()) { this.dirty = true; return; }
    this.dirty = false;
    // Kalender: Ist der Rahmen unverändert (gleiche Seite, gleicher Modus, gleicher Zeitraum), reicht
    // es, die Aufgaben-Elemente nachzuziehen – ein Dutzend statt ~1800 Elemente. Der komplette
    // Neuaufbau unten kostete gemessen ~80 ms Style + Layout + Paint bei JEDER Änderung.
    // tryPatchCalendar lehnt bei der kleinsten Abweichung ab; dann läuft der normale Pfad.
    if (this.page.kind !== "manage" && tryPatchCalendar(this.contentEl, this.ctx())) return;
    // Dasselbe für die LISTE: gleicher Rahmen -> nur die Sektionen nachfüllen, deren Inhalt sich
    // geändert hat (s. tryPatchList). Der Kopf der Seite steckt über headSig in der Signatur,
    // deshalb hängt der Versuch an derselben Herleitung wie die Zeichnung selbst.
    if (this.page.kind !== "manage" && tryPatchList(this.contentEl, this.ctx())) return;
    // Frische Render-Component pro Zeichnung: Markdown-Titel (Links) sauber auf-/abbauen,
    // damit sich Hover-/Embed-Kindkomponenten nicht über Redraws hinweg ansammeln. Sie hängt an
    // DIESER View (früher an der Plugin-Instanz): bei zwei zeichnenden Tabs überschrieb der
    // zweite die Referenz des ersten – dessen Kindkomponenten wurden dann nie sauber abgeräumt.
    if (this.renderComp) this.removeChild(this.renderComp);
    this.renderComp = this.addChild(new Component());
    const ctx = this.ctx();
    this.contentEl.removeClass("bt-view-calendar");   // setzt renderCalendar bei Bedarf wieder
    delete this.contentEl.dataset.boardProjection;   // renderUnifiedBoard setzt es bei Board-Layouts neu
    // Das Zeilen-Budget gilt für JEDE Seite, nicht nur für die vollen Seiten (s. section).
    // „Demnächst" zeigt ALLE künftig datierten Aufgaben – gedeckelt ist dort nur, wie weit die
    // Termine reichen (upcomingMonths), nicht die Aufgaben. Gemessen an einem echten Vault
    // zeichnete es 589 Zeilen auf einen Schlag, während die dreimal so grosse Filterseite
    // längst mit 80 startete.
    pageBudget = FIRST_PAINT_ROWS;
    budgeted = true;
    try {
      if (this.page.kind === "manage") renderManageInto(this.contentEl, ctx);
      else if (this.page.kind === "filter") renderFilterBoardInto(this.contentEl, ctx, this.page.key);
      else if (this.page.kind === "label") renderLabelBoardInto(this.contentEl, ctx, this.page.key);
      else if (this.page.kind === "project") renderProjectBoardInto(this.contentEl, ctx, this.page.key);
      else renderViewInto(this.contentEl, ctx, this.page.key as ViewId);
    } finally {
      budgeted = false;
      pageBudget = Number.POSITIVE_INFINITY;
    }
    // Erst NACH dem Zeichnen: vorher hat die Seite keine Höhe und der Wert würde auf 0 geklemmt
    // (dieselbe Reihenfolge wie bei den Board-Spalten). Die Platzhalter der noch ungezeichneten
    // Sektionen liefern die Höhe bereits mit, die Position trifft also auch dann, wenn erst ein
    // Bruchteil der Zeilen steht – nachgefüllt wird, was dadurch ins Bild kommt.
    // Bei einem Sprung aus der Suche NICHT: dort scrollt applyFlash absichtlich woandershin.
    // Genau EINMAL setzen, synchron. Ein zweiter Versuch im nächsten Bild ist verlockend (die
    // Seite ist dann länger, weil sich Sektionen gefüllt haben) – aber genau der ist sichtbar:
    // Die Zeilen springen kurz, weil zwischen beiden Setzungen ein Bild gezeichnet wird. Beim
    // Abhaken, also ständig. Eine unsichtbar richtige Position ist mehr wert als eine sichtbar
    // korrigierte; ein Restversatz bleibt notfalls stehen, statt zu ruckeln.
    const gemerkt = listScroll.get(this.scrollKey());
    if (gemerkt && !this.plugin.flashPath && this.contentEl.scrollTop !== gemerkt) this.contentEl.scrollTop = gemerkt;
  }

  /** Tab UND Pane-Header (zwei getrennte Elemente) auf die aktuelle Seite bringen –
   *  sonst bleibt der Titel beim zuerst geöffneten View hängen. Seit Titel und Icon der Seite
   *  folgen, gilt das für beide: das Icon wechselt schon beim bloßen Layout-Umschalten. */
  private syncTitle(): void {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();   // Tab
    const titleEl = this.containerEl.querySelector<HTMLElement>(".view-header-title");
    if (titleEl) titleEl.setText(this.getDisplayText());                              // Pane-Header
    const iconEl = this.containerEl.querySelector<HTMLElement>(".view-header-icon");
    if (iconEl) setIcon(iconEl, this.getIcon());
  }
}

export class NavView extends ItemView {
  private unsub: (() => void) | null = null;
  private unsubTpl: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: OpalTasksPlugin) { super(leaf); }
  getViewType(): string { return VIEW_NAV; }
  getDisplayText(): string { return "Opal Tasks"; }
  getIcon(): string { return "check-circle"; }
  async onOpen(): Promise<void> {
    if (!this.unsub) this.unsub = this.plugin.index.subscribe(() => this.draw());
    // ZWEITES Abo auf den Vorlagen-Index: Die Vorlagen-Sektion liest aus ihm, und er meldet
    // getrennt. Ohne das bliebe die Sektion stehen, bis zufällig eine AUFGABE sich ändert –
    // eine gerade gespeicherte Vorlage erschiene also erst irgendwann später.
    if (!this.unsubTpl) this.unsubTpl = this.plugin.templates.subscribe(() => this.draw());
    this.draw();
  }
  async onClose(): Promise<void> { this.unsub?.(); this.unsub = null; this.unsubTpl?.(); this.unsubTpl = null; }
  draw(): void {
    if (!this.contentEl) return;
    // Nur die Zahlen haben sich geändert? Dann bleibt die Seitenleiste stehen (s. tryPatchNav).
    if (tryPatchNav(this.contentEl, this.plugin)) return;
    renderNavInto(this.contentEl, this.plugin);
  }
}
