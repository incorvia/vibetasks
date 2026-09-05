import { App, TFile, normalizePath } from "obsidian";
import { VibeTaskSettings } from "./types";
import { ensureFolder, slugify } from "./taskService";
import { fieldKey } from "./fieldNames";
import { ScanCache } from "./scanCache";
import { FilterCriteria, ViewOptions } from "./filterEngine";
import { CalMode } from "./calendarModel";
import { readViewOptions, writeViewOptions, readCriteria, writeCriteria } from "./pageOptions";
import { newUlid, repositoryFor, rfc3339Now, updateRecord } from "./mdbaseRepository";
import { isCollectionPath } from "./mdbaseResources";

/** Ein gespeicherter Filter (`type: filter`-Notiz im Vault). */
export interface FilterItem {
  name: string; path: string; icon: string; color: string | null; hidden: boolean;
  description: string;   // kurze Beschreibung aus dem Frontmatter
  criteria: FilterCriteria; options: ViewOptions;
}

function readOptions(fm: Record<string, unknown>, defaultCalMode?: CalMode): ViewOptions {
  return readViewOptions(fm, defaultCalMode);
}

function toItem(f: TFile, fm: Record<string, unknown>, defaultCalMode?: CalMode): FilterItem {
  return {
    name: typeof fm.title === "string" && fm.title.trim() ? fm.title : f.basename, path: f.path,
    icon: "tag",   // fest (noch kein Icon-Picker) – gilt auch für Alt-Filter mit gespeichertem icon
    color: typeof fm.color === "string" ? fm.color : null,
    description: typeof fm.description === "string" ? fm.description : "",
    hidden: !!fm.nav_hidden,
    criteria: readCriteria(fm), options: readOptions(fm, defaultCalMode),
  };
}

/** Scan über den metadataCache (wie bei den Projekten) – Filter ändern sich selten, daher NICHT
 *  im TaskIndex geführt. Gemerkt (s. ScanCache), weil die Seitenleiste ihn bei jeder
 *  Index-Meldung braucht und je Filter zusätzlich die Kriterien parst. */
const filterScan = new ScanCache<FilterItem>((ty) => ty === "filter", (app) =>
  app.vault.getMarkdownFiles().flatMap((f) => {
    if (!isCollectionPath(f.path)) return [];
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    return fm?.[fieldKey("type")] === "filter" ? [toItem(f, fm)] : [];
  }).sort((a, b) => a.name.localeCompare(b.name, "de")));

/** Alle gespeicherten Filter (alphabetisch). Bewusst eine KOPIE der gemerkten Liste: Die
 *  Aufrufer geben sie weiter an sortFilters, in Menüs und in den Export – eine davon irgendwann
 *  an Ort und Stelle zu sortieren, würde sonst die gemerkte Reihenfolge für alle anderen
 *  umstellen (dieselbe Falle wie bei den per Verweis herausgegebenen Standard-Sammlungen). */
export function listFilters(app: App): FilterItem[] {
  return [...filterScan.get(app)];
}

/** Einen Filter per Pfad lesen (null, wenn keine Filter-Notiz mehr). */
export function readFilter(app: App, path: string, defaultCalMode?: CalMode): FilterItem | null {
  if (!isCollectionPath(path)) return null;
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return null;
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  return fm?.[fieldKey("type")] === "filter" ? toItem(f, fm, defaultCalMode) : null;
}

/** Kriterien + Optionen (+ Farbe) als Frontmatter-Felder schreiben (nur nicht-leere).
 *  Die Kriterien stehen hier FLACH: In einer Filternotiz sind sie die Notiz, kein Beiwerk
 *  (eine gewöhnliche Seite trägt ihren Ansichtsfilter dagegen unter einem Schlüssel). */
function applyToFrontmatter(fm: Record<string, unknown>, c: FilterCriteria, o: ViewOptions, color: string | null,
  defaultCalMode: CalMode): void {
  writeCriteria(fm, c);
  writeViewOptions(fm, o, defaultCalMode);   // layout/sort/group/showDone (Defaults werden entfernt)
  if (color == null) delete fm.color; else fm.color = color;
}

/** Neue Filter-Notiz anlegen; gibt den Basenamen zurück. */
export async function createFilterNote(
  app: App, settings: VibeTaskSettings, name: string, criteria: FilterCriteria, options: ViewOptions, color: string | null = null, hidden = false, description = "",
): Promise<string> {
  const folder = settings.filtersFolder;
  await ensureFolder(app, folder);
  const base = slugify(name);
  let dest = normalizePath(folder + "/" + base + ".md");
  let n = 2;
  while (app.vault.getAbstractFileByPath(dest)) { dest = normalizePath(folder + "/" + base + " " + n + ".md"); n++; if (n > 200) break; }
  const now = rfc3339Now();
  const fm: Record<string, unknown> = { type: "filter", id: newUlid(), title: base, created: now, modified: now };
  if (hidden) fm.nav_hidden = true;
  if (description.trim()) fm.description = description.trim();
  applyToFrontmatter(fm, criteria, options, color, settings.defaultCalendarView);
  // Kein „# Name" im Body: Der Name kommt aus dem Dateinamen; der Body gehört dem Nutzer.
  await repositoryFor(app).create({ type: "filter", path: dest, frontmatter: fm, body: "\n" });
  return base;
}

/** Kriterien/Optionen/Farbe einer bestehenden Filter-Notiz aktualisieren. */
export async function updateFilterNote(app: App, path: string, criteria: FilterCriteria, options: ViewOptions, color: string | null,
  defaultCalMode: CalMode = "3day"): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return;
  await updateRecord(app, f, (fm) => applyToFrontmatter(fm, criteria, options, color, defaultCalMode));
}

/** Filter-Notiz umbenennen (Datei + „# Überschrift"). Gibt neuen Basenamen zurück oder null. */
export async function renameFilterNote(app: App, path: string, newName: string): Promise<string | null> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return null;
  const base = slugify(newName);
  const folder = f.parent?.path ?? "";
  const dest = normalizePath((folder ? folder + "/" : "") + base + ".md");
  if (dest !== path && app.vault.getAbstractFileByPath(dest)) return null;   // Kollision
  await repositoryFor(app).rename(f.path, dest, base);
  return base;
}

/** Icon-Farbe eines Filters setzen (Frontmatter `color`; null = entfernen). */
export async function setFilterColor(app: App, path: string, color: string | null): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return;
  await updateRecord(app, f, (fm) => { if (color) fm.color = color; else delete fm.color; });
}

/** Filter in der Seitenleiste ein-/ausblenden (Frontmatter `nav_hidden`). */
export async function setFilterNavHidden(app: App, path: string, hidden: boolean): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return;
  await updateRecord(app, f, (fm) => { if (hidden) fm.nav_hidden = true; else delete fm.nav_hidden; });
}

/** Filter-Notiz löschen (in Obsidians Papierkorb). */
export async function deleteFilterNote(app: App, path: string): Promise<void> {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) await repositoryFor(app).trash(f.path);
}
