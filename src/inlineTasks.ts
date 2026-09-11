/**
 * Inline task conversion and link overlays.
 *
 * The visible-range decoration/widget architecture is adapted from TaskNotes' editor modules
 * (MIT, Copyright 2025 Callum Alpass). See THIRD_PARTY_NOTICES.md for the pinned revision and
 * exact upstream source paths. All persistence, parsing, indexing, actions and UI below are Opal.
 */
import {
  App, Editor, getFrontMatterInfo, Keymap, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, parseYaml, setIcon, TFile,
  editorInfoField, editorLivePreviewField,
} from "obsidian";
import { Extension, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import type OpalTasksPlugin from "./main";
import type { ScheduleDraft, Task } from "./types";
import { createTaskNote, listProjectsAndAreas, newId, openTaskNote } from "./taskService";
import { emptyQuickEntryState, applyQuickEntry } from "./quickEntry";
import { combineDT, formatDateTime, todayStr } from "./format";
import { firstDoneStatus, firstOpenStatus, isDone, isTrashed } from "./statuses";
import { renderCheck, showStatusMenu } from "./taskCheck";
import { showInlineTaskMenu } from "./taskMenu";
import { OPAL_NOTE_ID, OPAL_PROJECT_ID } from "./stableRelationships";
import { newUlid, updateRecord } from "./mdbaseRepository";
import { excludedInlineLines, inlineLineReplacement, inlineLinkRanges, inlineReconcileDisposition, parseInlineTaskLine, selectionTouchesInlineRange } from "./inlineTaskMarkdown";
import { fieldKey } from "./fieldNames";
import { isCollectionPath } from "./mdbaseResources";
import { t } from "./i18n";
export { excludedInlineLines, inlineLineReplacement, inlineLinkRanges, inlineReconcileDisposition, parseInlineTaskLine, selectionTouchesInlineRange } from "./inlineTaskMarkdown";

export interface ReconcileResult {
  moved: number;
  unchanged: number;
  trashed: number;
  failed: number;
}

const refreshInlineWidgets = StateEffect.define<null>();

export function resolveInlineTask(app: App, plugin: Pick<OpalTasksPlugin, "index">,
  target: string, sourcePath: string): Task | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const withoutSubpath = target.split("#", 1)[0].trim();
  const file = app.metadataCache.getFirstLinkpathDest(withoutSubpath, sourcePath);
  return file ? plugin.index.get(file.path) ?? null : null;
}

function ordinarySource(plugin: OpalTasksPlugin, file: TFile): boolean {
  const type: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[fieldKey("type")];
  if (type === "task" || type === "template") return false;
  return !isCollectionPath(file.path);
}

/** Assign a stable identity to this note, replacing a copied duplicate when it is first used. */
export async function ensureInlineNoteId(app: App, note: TFile): Promise<string> {
  // Read the note itself first. metadataCache can lag immediately after processFrontMatter, which
  // otherwise makes a second click look like a copied-note collision and assigns another ID.
  const current: unknown = (await readInlineNoteFrontmatter(app, note))[OPAL_NOTE_ID];
  const owners = typeof current === "string" && current.trim()
    ? app.vault.getMarkdownFiles().filter((file) =>
      app.metadataCache.getFileCache(file)?.frontmatter?.[OPAL_NOTE_ID] === current)
      .sort((a, b) => a.stat.ctime - b.stat.ctime || a.path.localeCompare(b.path))
    : [];
  // The oldest copy retains the identity and therefore its existing originating tasks. A copied
  // note receives a fresh identity the first time inline/project functionality touches it. Read
  // the value again inside processFrontMatter so two near-simultaneous conversions share one ID.
  let id = "";
  await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
    const actual = fm[OPAL_NOTE_ID];
    const concurrentAssignment = typeof actual === "string" && actual.trim() && actual !== current;
    const ownsCurrent = typeof actual === "string" && actual.trim()
      && (owners.length <= 1 || owners[0]?.path === note.path);
    id = concurrentAssignment || ownsCurrent ? actual : newUlid();
    if (actual !== id) fm[OPAL_NOTE_ID] = id;
  });
  return id;
}

function editorLineEligible(editor: Editor, line: number): boolean {
  if (line < 0 || line > editor.lastLine()) return false;
  if (excludedInlineLines(editor.getValue()).has(line)) return false;
  return parseInlineTaskLine(editor.getLine(line)) !== null;
}

export function canConvertEditorLine(plugin: OpalTasksPlugin, editor: Editor, file: TFile | null, line: number): boolean {
  return !!file && ordinarySource(plugin, file) && editorLineEligible(editor, line);
}

/** Read frontmatter from the file rather than relying on Obsidian's eventually updated cache. */
export async function readInlineNoteFrontmatter(app: App, note: TFile): Promise<Record<string, unknown>> {
  const info = getFrontMatterInfo(await app.vault.read(note));
  if (!info.exists) return {};
  const parsed: unknown = parseYaml(info.frontmatter);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function editorFrontmatterValue(editor: Editor, key: string): unknown {
  try {
    const info = getFrontMatterInfo(editor.getValue());
    if (!info.exists) return undefined;
    const parsed: unknown = parseYaml(info.frontmatter);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)[key]
      : undefined;
  } catch {
    // The editor can briefly expose the YAML half-written while Obsidian applies the vault event.
    return undefined;
  }
}

/** Wait for processFrontMatter's vault edit to reach the open CodeMirror document. */
async function waitForEditorFrontmatter(editor: Editor, key: string, value: string, win: Window): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (editorFrontmatterValue(editor, key) !== value) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => win.setTimeout(resolve, 16));
  }
  return true;
}

/** Create the canonical record first, then atomically replace the still-unchanged editor line. */
export async function convertEditorLine(plugin: OpalTasksPlugin, editor: Editor, note: TFile, line: number,
  win: Window = window): Promise<boolean> {
  if (!canConvertEditorLine(plugin, editor, note, line)) return false;
  const original = editor.getLine(line);
  const parsedLine = parseInlineTaskLine(original);
  if (!parsedLine) return false;

  const previousLastLine = editor.lastLine();
  const noteId = await ensureInlineNoteId(plugin.app, note);
  // processFrontMatter updates the file first and the active editor on a later frame. Continuing
  // in between those events used to make the first click add only opal_note_id; the source line
  // then shifted underneath the conversion while createTaskNote was running.
  if (!await waitForEditorFrontmatter(editor, OPAL_NOTE_ID, noteId, win)) {
    new Notice(t("notice_inline_line_changed"));
    return false;
  }
  // Adding the first frontmatter block shifts every body line. Obsidian keeps the editor in sync,
  // so adjust by the exact line-count delta before applying the normal stale-line guard.
  const targetLine = line + (editor.lastLine() - previousLastLine);
  if (targetLine < 0 || targetLine > editor.lastLine() || editor.getLine(targetLine) !== original) {
    new Notice(t("notice_inline_line_changed"));
    return false;
  }
  const noteFm = await readInlineNoteFrontmatter(plugin.app, note);
  const lists = listProjectsAndAreas(plugin.app);
  const allLists = [...lists.bereiche, ...lists.projekte];
  const linkedProjectId = typeof noteFm?.[OPAL_PROJECT_ID] === "string" ? noteFm[OPAL_PROJECT_ID] : null;
  const projectNames = linkedProjectId ? [] : allLists.map((item) => item.name);
  const quick = applyQuickEntry(parsedLine.title, {
    due: null, dueTime: null, priority: "normal", labels: [], project: null,
    estimate: null, recurrence: null,
  }, emptyQuickEntryState(), {
    enabled: plugin.settings.parseNaturalLanguage, frozen: false, duePinned: false,
    today: todayStr(), projects: projectNames, scheduleEnabled: true,
  });
  if (!quick.title.trim()) { new Notice(t("err_enter_taskname")); return false; }

  const id = newId("");
  let taskFile: TFile | null = null;
  let replacement: string | null = null;
  let sourceFailure = false;
  try {
    taskFile = await createTaskNote(plugin.app, plugin.settings, {
      id, title: quick.title.trim(), status: parsedLine.completed ? firstDoneStatus() : firstOpenStatus(),
      due: quick.fields.due, dueTime: quick.fields.dueTime, priority: quick.fields.priority,
      estimate: quick.fields.estimate, labels: quick.fields.labels, recurrence: quick.fields.recurrence,
      project: linkedProjectId ? null : quick.fields.project, projectId: linkedProjectId,
      sourceNoteId: noteId,
    });
    // A just-created companion project may not be visible in metadataCache yet. The marker is
    // canonical, so write it authoritatively before exposing the link.
    if (linkedProjectId) await updateRecord(plugin.app, taskFile.path, (fm) => {
      fm[OPAL_PROJECT_ID] = linkedProjectId;
      delete fm.project;
    });
    const link = plugin.app.fileManager.generateMarkdownLink(taskFile, note.path, undefined, quick.title.trim());
    replacement = inlineLineReplacement(original, editor.getLine(targetLine), link);
    if (replacement === null) { sourceFailure = true; throw new Error("source line changed before replacement"); }
    editor.replaceRange(replacement, { line: targetLine, ch: 0 }, { line: targetLine, ch: original.length });
    if (editor.getLine(targetLine) !== replacement) { sourceFailure = true; throw new Error("editor did not apply inline task replacement"); }
  } catch (error) {
    // Restore only our own attempted replacement. Never overwrite a concurrent user edit.
    if (replacement !== null && targetLine <= editor.lastLine() && editor.getLine(targetLine) === replacement) {
      try { editor.replaceRange(original, { line: targetLine, ch: 0 }, { line: targetLine, ch: replacement.length }); }
      catch (restoreError) { console.error("Opal Tasks: inline source restoration failed", restoreError); }
    }
    if (taskFile) {
      try { await plugin.app.fileManager.trashFile(taskFile); }
      catch (trashError) { console.error("Opal Tasks: inline conversion rollback failed", trashError); }
    }
    console.error("Opal Tasks: inline conversion aborted", error);
    new Notice(t(sourceFailure ? "notice_inline_line_changed" : "notice_inline_create_failed"));
    return false;
  }

  // Mirror TaskNotes' post-conversion sequencing: warm the new file's metadata, then force one
  // editor rebuild after the replacement transaction and TaskIndex's debounced upsert have run.
  if (taskFile) await refreshConvertedInlineTask(plugin, editor, taskFile, win);

  if (quick.schedule) {
    try { await scheduleInlineTask(plugin, { id, title: quick.title.trim(), estimate: quick.fields.estimate }, quick.schedule); }
    catch (error) {
      console.error("Opal Tasks: inline task scheduling failed", error);
      new Notice(t("notice_inline_schedule_failed"));
    }
  }
  return true;
}

function scheduleInlineTask(plugin: OpalTasksPlugin, task: { id: string; title: string; estimate?: number | null }, schedule: ScheduleDraft): Promise<unknown> {
  return plugin.scheduling.scheduleTask(task, schedule.allDay
    ? { allDay: true, date: schedule.date, source: "manual" }
    : { start: schedule.start, duration: schedule.duration, source: "manual" });
}

/** Warm Obsidian's cache, then rebuild after the new task and replacement link can resolve. */
async function refreshConvertedInlineTask(plugin: OpalTasksPlugin, editor: Editor, taskFile: TFile,
  win: Window): Promise<void> {
  try { await plugin.app.vault.cachedRead(taskFile); }
  catch { /* The index event remains a fallback if the cache warm-up fails. */ }
  win.setTimeout(() => {
    const view = (editor as Editor & { cm?: EditorView }).cm;
    if (view) view.dispatch({ effects: refreshInlineWidgets.of(null) });
  }, 100);
}

function priorityNumber(task: Task): string | null {
  return task.priority === "highest" ? "P1" : task.priority === "high" ? "P2" : task.priority === "medium" ? "P3" : null;
}

/** Shared DOM for Live Preview and Reading mode. */
export function createInlineTaskElement(plugin: OpalTasksPlugin, task: Task, doc: Document): HTMLElement {
  // ownerDocument is deliberate: widgets can live in an Obsidian popout window.
  const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  root.className = "bt-inline-task" + (isDone(task.status) ? " is-done" : "");
  root.dataset.path = task.path;
  const check = renderCheck(root, plugin, task, { compact: true });
  check.removeAttribute("data-check");
  check.setAttribute("role", "button");
  check.tabIndex = 0;
  let statusLongFired = false;
  const toggle = (event: Event): void => {
    event.preventDefault(); event.stopPropagation();
    if (statusLongFired) { statusLongFired = false; return; }
    void plugin.toggleDone(task);
  };
  check.addEventListener("click", toggle);
  check.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") toggle(event); });
  check.addEventListener("contextmenu", (event) => {
    event.preventDefault(); event.stopPropagation(); showStatusMenu(plugin, task, event.clientX, event.clientY, doc);
  });
  let statusLongPress: number | null = null;
  const clearStatusLongPress = (): void => {
    if (statusLongPress !== null) { doc.defaultView?.clearTimeout(statusLongPress); statusLongPress = null; }
  };
  check.addEventListener("touchstart", (event) => {
    const point = event.touches[0];
    clearStatusLongPress(); statusLongFired = false;
    statusLongPress = doc.defaultView?.setTimeout(() => {
      statusLongPress = null; statusLongFired = true;
      showStatusMenu(plugin, task, point.clientX, point.clientY, doc);
    }, 500) ?? null;
  }, { passive: true });
  check.addEventListener("touchend", clearStatusLongPress);
  check.addEventListener("touchmove", clearStatusLongPress);
  check.addEventListener("touchcancel", clearStatusLongPress);

  const priority = priorityNumber(task);
  if (priority) root.createSpan({ cls: "bt-inline-priority", text: priority });
  const title = root.createEl("button", { cls: "bt-inline-title", text: task.title });
  title.onclick = (event) => {
    event.preventDefault(); event.stopPropagation();
    const where = Keymap.isModEvent(event);
    if (where) openTaskNote(plugin.app, task.path, where); else plugin.openEditTask(task);
  };
  if (task.due) root.createSpan({ cls: "bt-inline-due", text: formatDateTime(combineDT(task.due, task.dueTime)) });
  if (task.recurrence) { const recur = root.createSpan({ cls: "bt-inline-recur" }); setIcon(recur, "refresh-cw"); }

  root.addEventListener("contextmenu", (event) => {
    event.preventDefault(); event.stopPropagation(); showInlineTaskMenu(plugin, task, event.clientX, event.clientY, doc);
  });
  let longPress: number | null = null;
  let menuLongFired = false;
  const clear = (): void => { if (longPress !== null) { doc.defaultView?.clearTimeout(longPress); longPress = null; } };
  root.addEventListener("touchstart", (event) => {
    if ((event.target as HTMLElement | null)?.closest(".bt-check")) return;
    const point = event.touches[0];
    clear(); menuLongFired = false;
    longPress = doc.defaultView?.setTimeout(() => {
      longPress = null; menuLongFired = true;
      showInlineTaskMenu(plugin, task, point.clientX, point.clientY, doc);
    }, 500) ?? null;
  }, { passive: true });
  root.addEventListener("touchend", clear); root.addEventListener("touchmove", clear); root.addEventListener("touchcancel", clear);
  root.addEventListener("click", (event) => {
    if (!menuLongFired) return;
    menuLongFired = false; event.preventDefault(); event.stopPropagation();
  }, true);
  return root;
}

class TaskLinkWidget extends WidgetType {
  constructor(private plugin: OpalTasksPlugin, private task: Task) { super(); }
  eq(other: TaskLinkWidget): boolean {
    return other.task.path === this.task.path && other.task.status === this.task.status
      && other.task.title === this.task.title && other.task.priority === this.task.priority
      && other.task.due === this.task.due && other.task.dueTime === this.task.dueTime
      && other.task.recurrence === this.task.recurrence;
  }
  toDOM(view: EditorView): HTMLElement { return createInlineTaskElement(this.plugin, this.task, view.dom.ownerDocument); }
  ignoreEvent(): boolean { return true; }
}

class ConvertLineWidget extends WidgetType {
  constructor(private plugin: OpalTasksPlugin, private line: number) { super(); }
  eq(other: ConvertLineWidget): boolean { return other.line === this.line; }
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.className = "bt-inline-convert";
    button.setAttribute("aria-label", t("cmd_convert_inline_task"));
    setIcon(button, "circle-plus");
    const activate = (event: Event): void => {
      event.preventDefault(); event.stopPropagation();
      const info = view.state.field(editorInfoField, false);
      if (info?.editor && info.file) {
        const win = view.dom.ownerDocument.defaultView ?? window;
        void convertEditorLine(this.plugin, info.editor, info.file, this.line, win);
      }
    };
    const win = view.dom.ownerDocument.defaultView;
    button.addEventListener(win && "PointerEvent" in win ? "pointerdown" : "mousedown", activate);
    return button;
  }
  ignoreEvent(): boolean { return true; }
}

function cursorTouches(view: EditorView, from: number, to: number): boolean {
  return selectionTouchesInlineRange(view.state.selection.ranges, from, to);
}

function buildDecorations(view: EditorView, plugin: OpalTasksPlugin): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const info = view.state.field(editorInfoField, false);
  const live = view.state.field(editorLivePreviewField, false);
  if (!info?.file) return builder.finish();
  const sourcePath = info.file.path;
  const excluded = excludedInlineLines(view.state.doc.toString());
  const pending: { from: number; to: number; deco: Decoration }[] = [];
  const visitedLines = new Set<number>();

  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (line.from <= range.to) {
      if (!visitedLines.has(line.number) && !excluded.has(line.number - 1)) {
        visitedLines.add(line.number);
        if (live && plugin.settings.enableTaskLinkOverlays) {
          for (const link of inlineLinkRanges(line.text, line.from)) {
            const task = resolveInlineTask(plugin.app, plugin, link.target, sourcePath);
            if (task && !cursorTouches(view, link.from, link.to)) {
              pending.push({ from: link.from, to: link.to, deco: Decoration.replace({ widget: new TaskLinkWidget(plugin, task) }) });
            }
          }
        }
        if (plugin.settings.showInlineConvertButtons && ordinarySource(plugin, info.file) && parseInlineTaskLine(line.text)) {
          pending.push({ from: line.to, to: line.to, deco: Decoration.widget({ widget: new ConvertLineWidget(plugin, line.number - 1), side: 1 }) });
        }
      }
      if (line.to >= range.to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  pending.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const item of pending) builder.add(item.from, item.to, item.deco);
  return builder.finish();
}

export function inlineTaskEditorExtensions(plugin: OpalTasksPlugin): Extension[] {
  const views = new Set<EditorView>();
  const extension = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(readonly view: EditorView) { views.add(view); this.decorations = buildDecorations(view, plugin); }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet
        || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshInlineWidgets)))) {
        this.decorations = buildDecorations(update.view, plugin);
      }
    }
    destroy(): void { views.delete(this.view); }
  }, { decorations: (value) => value.decorations });
  const unsubscribe = plugin.index.subscribe(() => {
    for (const view of views) view.dispatch({ effects: refreshInlineWidgets.of(null) });
  });
  plugin.register(unsubscribe);
  return [extension];
}

class ReadingTaskLink extends MarkdownRenderChild {
  private unsubscribe: (() => void) | null = null;
  constructor(private mount: HTMLElement, private original: HTMLAnchorElement,
    private plugin: OpalTasksPlugin, private path: string) { super(mount); }
  onload(): void {
    this.render();
    this.unsubscribe = this.plugin.index.subscribe(() => this.render());
    this.register(() => this.unsubscribe?.());
  }
  private render(): void {
    if (!this.mount.isConnected) return;
    const task = this.plugin.index.get(this.path);
    if (!task) { this.mount.replaceWith(this.original.cloneNode(true)); return; }
    this.mount.replaceChildren(createInlineTaskElement(this.plugin, task, this.mount.ownerDocument));
  }
}

export function processReadingModeTaskLinks(plugin: OpalTasksPlugin, el: HTMLElement,
  context: MarkdownPostProcessorContext): void {
  if (!plugin.settings.enableTaskLinkOverlays) return;
  for (const anchor of Array.from(el.querySelectorAll<HTMLAnchorElement>("a.internal-link"))) {
    if (anchor.closest(".bt-inline-task")) continue;
    const target = anchor.dataset.href || anchor.getAttribute("href") || "";
    const task = resolveInlineTask(plugin.app, plugin, target, context.sourcePath);
    if (!task) continue;
    const mount = anchor.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
    mount.className = "bt-inline-task-mount";
    const original = anchor.cloneNode(true) as HTMLAnchorElement;
    anchor.replaceWith(mount);
    context.addChild(new ReadingTaskLink(mount, original, plugin, task.path));
  }
}

/** Task paths linked from the source note, used to avoid claiming copied/manual references. */
export function linkedTaskPaths(app: App, plugin: Pick<OpalTasksPlugin, "index">, content: string,
  sourcePath: string, knownTaskPaths?: ReadonlySet<string>): Set<string> {
  const paths = new Set<string>();
  const excluded = excludedInlineLines(content);
  content.split("\n").forEach((line, number) => {
    if (excluded.has(number)) return;
    for (const link of inlineLinkRanges(line)) {
      if (knownTaskPaths) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(link.target)) continue;
        const file = app.metadataCache.getFirstLinkpathDest(link.target.split("#", 1)[0].trim(), sourcePath);
        if (file && knownTaskPaths.has(file.path)) paths.add(file.path);
      } else {
        const task = resolveInlineTask(app, plugin, link.target, sourcePath);
        if (task) paths.add(task.path);
      }
    }
  });
  return paths;
}

/** Idempotently claim only tasks both originating in this note and still linked from it. */
export async function reconcileInlineTasks(plugin: OpalTasksPlugin, note: TFile,
  noteId: string, projectId: string): Promise<ReconcileResult> {
  // Read the canonical records directly. This makes reconciliation correct even if the user runs
  // the project command in the short metadata-cache window immediately after converting a line.
  const records = await plugin.repository.list("task");
  const taskPaths = new Set(records.map((record) => record.path));
  const links = linkedTaskPaths(plugin.app, plugin, await plugin.app.vault.read(note), note.path, taskPaths);
  const result: ReconcileResult = { moved: 0, unchanged: 0, trashed: 0, failed: 0 };
  for (const record of records) {
    const fm = record.frontmatter;
    const task = {
      path: record.path,
      sourceNoteId: typeof fm.opal_source_note_id === "string" ? fm.opal_source_note_id : null,
      projectId: typeof fm[OPAL_PROJECT_ID] === "string" ? fm[OPAL_PROJECT_ID] : null,
    };
    const disposition = inlineReconcileDisposition(task, links, noteId, projectId,
      typeof fm.status === "string" && isTrashed(fm.status));
    if (disposition === "ignore") continue;
    if (disposition === "trashed") { result.trashed++; continue; }
    if (disposition === "unchanged") { result.unchanged++; continue; }
    try {
      await updateRecord(plugin.app, task.path, (frontmatter) => {
        frontmatter[OPAL_PROJECT_ID] = projectId;
        delete frontmatter.project;
      });
      result.moved++;
    } catch (error) {
      result.failed++;
      console.error(`Opal Tasks: failed to reconcile inline task ${task.path}`, error);
    }
  }
  return result;
}
