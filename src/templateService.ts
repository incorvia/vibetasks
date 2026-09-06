import { App, TFile, normalizePath } from "obsidian";
import type VibeTaskPlugin from "./main";
import { Task } from "./types";
import { AnchorMode, planTemplateDates } from "./templatePlan";
import { baseName, createProjectNote, createTaskNote, EditScope, ensureFolder, NoteTarget, slugify } from "./taskService";
import { firstOpenStatus, isTrashed } from "./statuses";
import { updateRecord } from "./mdbaseRepository";

/**
 * Vorlagen: speichern und anwenden.
 *
 * Beide Richtungen laufen über DENSELBEN Kopierer wie das Duplizieren (`duplicateSubtree`), nur
 * mit anderen Vorgaben (s. DuplicateOpts in taskService.ts):
 *
 *   Aufgabe → Vorlage:  anderer Zielordner, anderer Typwert
 *   Vorlage → Aufgabe:  anderer Quell-Index, verschobene Daten, erzwungenes Zielprojekt
 *
 * Ein zweiter Schreibweg hätte über kurz oder lang ein Feld vergessen, das der erste kennt –
 * die Rekursion, der Kreis-Schutz und die frischen `sort_order`-Lücken gibt es deshalb nur einmal.
 */

/** Frontmatter-Feld an der WURZEL einer Vorlage: was beim Anwenden entsteht. Die Kinder tragen es
 *  nicht – sie sind schon durch ihren `parent` eindeutig einer Wurzel zugeordnet. */
export const TEMPLATE_OF = "template_of";
export type TemplateKind = "task" | "project";

/** Der Typwert, an dem der Vorlagen-Index seine Notizen erkennt (s. TEMPLATE_SCOPE). */
export const TEMPLATE_TYPE = "template";

/** Eine Vorlage, wie die Seitenleiste und die Auswahl sie brauchen. */
export interface TemplateInfo {
  root: Task;
  name: string;
  kind: TemplateKind;
  /** Wie viele Aufgaben beim Anwenden entstehen (Wurzel eingeschlossen). */
  size: number;
  /** In der Seitenleiste ausgeblendet (`nav_hidden` an der Wurzel) – wie bei Projekten. */
  hidden: boolean;
}

/** Ordner einer Vorlage: `<templatesFolder>/<Name>`. Je Vorlage einer – siehe templates-plan.md,
 *  Abschnitt „Vault-Layout": flach in einem Topf verwechselten sich gleichnamige Schritte zweier
 *  Vorlagen über den Basenamen. */
function templateFolder(plugin: VibeTaskPlugin, name: string): string {
  return normalizePath(plugin.settings.templatesFolder + "/" + slugify(name));
}

/** Freien Ordnernamen finden (`Urlaub`, `Urlaub 2`, …) – wie createTaskNote es für Dateien tut. */
function freeFolder(app: App, base: string): string {
  let dest = base;
  let n = 2;
  while (app.vault.getAbstractFileByPath(dest)) { dest = base + " " + n; n++; if (n > 200) break; }
  return dest;
}

/** Ist diese Notiz die WURZEL einer Vorlage? Wurzeln haben keinen `parent` innerhalb der Vorlage.
 *  Gelöschte bleiben aussen vor – Löschen setzt wie überall den Papierkorb-Status, statt die Notiz
 *  wegzuwerfen, und eine gelöschte Vorlage soll nicht weiter in der Seitenleiste stehen. */
const isRoot = (t: Task): boolean => !t.parent && !isTrashed(t.status);

/**
 * Alle Vorlagen mit ihrer Grösse, alphabetisch. Liest ausschliesslich aus dem Vorlagen-Index –
 * der Aufgaben-Index weiss von Vorlagen nichts und soll es auch nicht.
 */
export function listTemplates(plugin: VibeTaskPlugin): TemplateInfo[] {
  return plugin.templates.all()
    .filter(isRoot)
    .map((root) => {
      const { kind, hidden } = rootMeta(plugin.app, root.path);
      // Zahl = wie viele AUFGABEN entstehen. Bei einer Projektvorlage wird die Wurzel zum
      // Projekt und zählt deshalb nicht mit.
      const size = plugin.templates.descendants(root.path).length + (kind === "project" ? 0 : 1);
      return { root, name: root.title, kind, size, hidden };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** `template_of` der Wurzel lesen. Fehlt es (von Hand angelegte Notiz), gilt „Aufgabe" – das ist
 *  die harmlosere Annahme: Sie legt EINE Aufgabe an, statt ungefragt ein Projekt zu erzeugen. */
export function templateKind(app: App, path: string): TemplateKind {
  return rootMeta(app, path).kind;
}

/** In der Seitenleiste ausgeblendet? Liegt als `nav_hidden` an der Wurzel – derselbe Schlüssel wie
 *  bei Projekten und Bereichen (s. setNavHidden in taskService), damit „ausgeblendet" im ganzen
 *  Vault dasselbe Feld bedeutet. Kein Teil von `Task`, deshalb direkt aus dem Frontmatter. */
export function templateHidden(app: App, path: string): boolean {
  return rootMeta(app, path).hidden;
}

/** Art und Sichtbarkeit einer Wurzel in EINEM Zugriff. `templateKind` und `templateHidden` lasen
 *  beide dieselbe Datei; in `listTemplates` lief das je Wurzel zweimal – und listTemplates hängt
 *  am Zeichnen der Seitenleiste. */
function rootMeta(app: App, path: string): { kind: TemplateKind; hidden: boolean } {
  const f = app.vault.getAbstractFileByPath(path);
  const fm = f instanceof TFile ? app.metadataCache.getFileCache(f)?.frontmatter : undefined;
  return { kind: fm?.[TEMPLATE_OF] === "project" ? "project" : "task", hidden: !!fm?.nav_hidden };
}

/** Vorlage in der Seitenleiste ein-/ausblenden. */
export async function setTemplateHidden(app: App, path: string, hidden: boolean): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return;
  await updateRecord(app, f, (fm) => {
    if (hidden) fm.nav_hidden = true; else delete fm.nav_hidden;
  });
}

/**
 * Eine Aufgabe samt Unterbaum als Vorlage ablegen. Gibt den Pfad der Vorlagen-Wurzel zurück.
 *
 * Die Vorlage übernimmt die Daten UNVERÄNDERT – sie sind der Rhythmus, den sie sich merkt. Erst
 * beim Anwenden werden sie auf einen neuen Anker gerechnet (templatePlan.ts).
 */
export async function saveAsTemplate(plugin: VibeTaskPlugin, task: Task, kind: TemplateKind = "task"): Promise<string> {
  const folder = freeFolder(plugin.app, templateFolder(plugin, task.title));
  await ensureFolder(plugin.app, folder);
  const target: NoteTarget = { folder, type: TEMPLATE_TYPE };

  const root = await createTaskNote(plugin.app, plugin.settings, {
    title: task.title,
    titleInFrontmatter: task.titleInFm,
    description: task.description,
    status: firstOpenStatus(),
    due: task.due, dueTime: task.dueTime,
    estimate: task.estimate,
    priority: task.priority,
    // Das Projekt der Quelle wandert MIT – als Vorschlag, nicht als Bindung. Eine Vorlage wie
    // „Wäsche machen" gehört immer in dasselbe Projekt; sie jedes Mal neu suchen zu lassen ist
    // die Arbeit, die eine Vorlage gerade abnehmen soll. Der Anwenden-Dialog zeigt den Vorschlag
    // sichtbar im Feld „Ziel" und lässt ihn mit einem Klick ändern.
    //
    // Zeigt der Verweis später ins Leere (Projekt umbenannt oder gelöscht), löst ihn schon der
    // Index nicht mehr auf (resolveProjectPath) – der Dialog fällt dann auf die Seite zurück, von
    // der aus er geöffnet wurde. Ein toter Verweis kann hier also nichts anrichten.
    project: task.project ? baseName(task.project) : null,
    labels: [...task.labels],
    recurrence: task.recurrence, recurBasis: task.recurBasis,
    reminders: [...task.reminders],
  }, target);

  await updateRecord(plugin.app, root, (fm) => { fm[TEMPLATE_OF] = kind; });
  await plugin.duplicateSubtree(task.path, root.basename, { target, project: null });
  return root.path;
}

/**
 * Ein ganzes Projekt als Vorlage ablegen. Gibt den Pfad der Vorlagen-Wurzel zurück.
 *
 * Die Wurzel ist eine Vorlagen-Notiz mit `template_of: project`; darunter hängen die Aufgaben des
 * Projekts mit ihren eigenen Unterbäumen.
 *
 * ── Warum die Projektaufgaben `parent` bekommen ──────────────────────────────
 * Im Vault gehört eine Aufgabe über `project: [[Name]]` zu ihrem Projekt, nicht über `parent`.
 * In der Vorlage wäre das eine Sackgasse: `descendants()` läuft über `parent`, und ohne diese
 * Kette fände weder die Grössenangabe noch das Anwenden auch nur eine einzige Aufgabe. Innerhalb
 * der Vorlage bilden sie deshalb einen Baum unter der Wurzel – und beim Anwenden löst
 * `detachTop` sie wieder von ihr (s. applyTemplate).
 */
export async function saveProjectAsTemplate(plugin: VibeTaskPlugin, projectPath: string, name: string, description = ""): Promise<string> {
  const folder = freeFolder(plugin.app, templateFolder(plugin, name));
  await ensureFolder(plugin.app, folder);
  const target: NoteTarget = { folder, type: TEMPLATE_TYPE };

  const root = await createTaskNote(plugin.app, plugin.settings, {
    title: name, description, status: firstOpenStatus(), project: null,
  }, target);
  await updateRecord(plugin.app, root, (fm) => { fm[TEMPLATE_OF] = "project"; });

  // Die Aufgaben DES Projekts, die keine Unteraufgabe sind – alles Tiefere holt die Rekursion.
  // Papierkorb bleibt aussen vor (subtasksToDuplicate filtert ihn ohnehin, aber schon hier
  // gefiltert bleibt die Absicht sichtbar).
  const roots = plugin.index.all().filter((t) => t.project === projectPath && !t.parent && !isTrashed(t.status));
  await plugin.duplicateSubtree(projectPath, root.basename, { target, project: null, roots });
  return root.path;
}

/**
 * Der Bearbeitungs-Bereich einer Vorlage: gelesen wird aus dem Vorlagen-Index, geschrieben in
 * ihren EIGENEN Ordner. Damit läuft der normale Aufgaben-Editor unverändert auf einer Vorlage –
 * inklusive Unteraufgaben-Sektion, Chips und Kommentaren.
 *
 * Der Ordner kommt aus dem Pfad der Wurzel und nicht aus dem Namen: Bei einer Namenskollision
 * heisst der Ordner „Urlaub 2", und eine neue Unteraufgabe muss dort landen, nicht in „Urlaub".
 */
export function templateEditScope(plugin: VibeTaskPlugin, rootPath: string): EditScope {
  return {
    index: plugin.templates,
    target: { folder: rootPath.split("/").slice(0, -1).join("/"), type: TEMPLATE_TYPE },
  };
}

export interface ApplyOptions {
  /** Zielprojekt (Basename) oder `null` für den Eingang. Bei einer Projektvorlage: das
   *  BESTEHENDE Projekt, in das gegossen wird – ohne Wirkung, wenn `newProject` gesetzt ist. */
  project: string | null;
  /** Nur Projektvorlagen: Name eines NEU anzulegenden Projekts. Gesetzt = neues Projekt. */
  newProject?: string | null;
  /** Ankerdatum „YYYY-MM-DD"; `null` = ohne Datum anwenden (die Vorlage behält ihre eigenen). */
  anchor: string | null;
  mode: AnchorMode;
}

/**
 * Eine Vorlage anwenden. Gibt zurück, wie viele Aufgaben entstanden sind.
 *
 * Der Datums-Plan wird über den GANZEN Baum gerechnet, bevor die erste Notiz entsteht: Die
 * Verschiebung ergibt sich aus der Spanne aller Aufgaben, nicht aus der zuerst angefassten.
 * Stückweise gerechnet bekäme jede Aufgabe ihren eigenen Anker und die Abstände wären dahin.
 *
 * Zwei Ausgänge, ein Rechenweg: Eine Aufgabenvorlage wird zu EINER Aufgabe samt Unterbaum, eine
 * Projektvorlage zu einem Projekt mit seinen Aufgaben. Der Unterschied steckt allein darin, was
 * aus der WURZEL wird – der Datums-Plan und die Rekursion sind für beide dieselben.
 */
export async function applyTemplate(plugin: VibeTaskPlugin, rootPath: string, opts: ApplyOptions): Promise<number> {
  const root = plugin.templates.get(rootPath);
  if (!root) return 0;
  const items = [root, ...plugin.templates.descendants(rootPath)];
  const dates = planTemplateDates(items, opts.anchor, opts.mode);
  const d = dates.get(rootPath);

  if (templateKind(plugin.app, rootPath) === "project") {
    // Die Wurzel wird zum Projekt (oder es gibt schon eines) – nicht zu einer Aufgabe. Ihre
    // direkten Kinder lösen sich deshalb von ihr und werden Aufgaben des Projekts (detachTop).
    const target = opts.newProject
      ? await createProjectNote(plugin.app, plugin.settings, opts.newProject, false, null, false, root.description)
      : opts.project;
    await plugin.duplicateSubtree(rootPath, "", {
      from: plugin.templates, dates, project: target, detachTop: true,
    });
    return items.length - 1;   // die Wurzel wurde ein Projekt, keine Aufgabe
  }

  const created = await createTaskNote(plugin.app, plugin.settings, {
    title: root.title,
    titleInFrontmatter: root.titleInFm,
    description: root.description,
    status: firstOpenStatus(),
    due: d ? d.due : root.due, dueTime: root.dueTime,
    estimate: root.estimate,
    priority: root.priority,
    project: opts.project,
    labels: [...root.labels],
    recurrence: root.recurrence, recurBasis: root.recurBasis,
    reminders: d ? [...d.reminders] : [...root.reminders],
  });

  await plugin.duplicateSubtree(rootPath, created.basename, {
    from: plugin.templates,
    dates,
    project: opts.project,
  });
  return items.length;
}

/**
 * Eine leere Vorlage anlegen. Gibt den Pfad der Wurzel zurück.
 *
 * Der übliche Weg zu einer Vorlage ist „Aufgabe als Vorlage speichern" – man hat die Sache ja
 * schon einmal gemacht. Von Null anzufangen bleibt trotzdem nötig, sonst müsste man erst eine
 * Wegwerf-Aufgabe bauen, um sie sofort wieder zu löschen.
 */
export async function createEmptyTemplate(plugin: VibeTaskPlugin, name: string, kind: TemplateKind = "task"): Promise<string> {
  const folder = freeFolder(plugin.app, templateFolder(plugin, name));
  await ensureFolder(plugin.app, folder);
  const root = await createTaskNote(plugin.app, plugin.settings, {
    title: name, status: firstOpenStatus(), project: null,
  }, { folder, type: TEMPLATE_TYPE });
  await updateRecord(plugin.app, root, (fm) => { fm[TEMPLATE_OF] = kind; });
  return root.path;
}

/**
 * Eine Vorlage umbenennen.
 *
 * Geändert werden der angezeigte Name (Frontmatter-`title` der Wurzel) und der Ordnername. Die
 * DATEI der Wurzel behält ihren Namen: Die Kinder verweisen mit `parent: [[Basename]]` auf sie,
 * und ein Umbenennen zöge das Umschreiben jedes Kindes nach sich – für etwas, das niemand sieht.
 * Dieselbe Trennung wie bei Projekten (Name = Referenz, Anzeige = Wert).
 */
export async function renameTemplate(plugin: VibeTaskPlugin, rootPath: string, newName: string): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(rootPath);
  if (!(file instanceof TFile)) return;
  const folder = file.parent;
  const title = newName.trim();
  if (!title) return;
  const base = slugify(title);
  const rootDest = normalizePath(`${folder?.path ? folder.path + "/" : ""}${base}.md`);
  await plugin.repository.rename(file.path, rootDest, title);
  if (!folder || folder.path === plugin.settings.templatesFolder) return;
  const dest = freeFolder(plugin.app, templateFolder(plugin, newName));
  if (dest !== folder.path) await plugin.app.fileManager.renameFile(folder, dest);
}

/** Eine Vorlage samt ihres Ordners in den Obsidian-Papierkorb (reversibel, wie bei Projekten). */
export async function deleteTemplate(plugin: VibeTaskPlugin, rootPath: string): Promise<void> {
  const folder = plugin.app.vault.getAbstractFileByPath(rootPath.split("/").slice(0, -1).join("/"));
  // Der Ordner gehört der Vorlage allein – ihn als Ganzes zu entfernen nimmt auch die Kinder mit,
  // ohne sie einzeln aufsammeln zu müssen. Fehlt er wider Erwarten, bleibt die Wurzel-Notiz.
  if (folder) {
    const prefix = folder.path + "/";
    for (const record of await plugin.repository.list("template")) if (record.path.startsWith(prefix)) await plugin.repository.trash(record.path);
    const empty = plugin.app.vault.getAbstractFileByPath(folder.path);
    if (empty) await plugin.app.fileManager.trashFile(empty); // folder cleanup; record deletes went through the repository
    return;
  }
  const f = plugin.app.vault.getAbstractFileByPath(rootPath);
  if (f instanceof TFile) await plugin.repository.trash(f.path);
}

/** Für Anzeigezwecke: der Name der Vorlage, zu der eine Notiz gehört (= ihr Ordnername). */
export const templateNameOf = (path: string): string => baseName(path.split("/").slice(0, -1).join("/"));

/**
 * Nach jeder Vorlagen-Operation den Vorlagen-Index neu aufbauen – und NICHT auf die Datei-Events
 * vertrauen.
 *
 * Umbenennen und Löschen einer Vorlage fassen einen ORDNER an. Obsidian meldet dafür kein
 * verlässliches `delete`/`rename` je enthaltener Datei, der Index behielte also Einträge unter
 * Pfaden, die es nicht mehr gibt – die gelöschte Vorlage stünde weiter in der Seitenleiste.
 * Ein Neuaufbau ist hier billig: Der Vorlagen-Index ist auf seinen Ordner beschränkt.
 *
 * Der kurze Verzug wartet auf den Metadaten-Cache; `build()` meldet anschliessend von selbst,
 * und die NavView zeichnet über ihr Abo neu.
 */
export function refreshTemplates(plugin: VibeTaskPlugin): void {
  window.setTimeout(() => plugin.templates.build(), 150);
}
