import { App, Notice, TFile, normalizePath, stringifyYaml } from "obsidian";
import { OpalTasksSettings, Priority, Task, TaskStatus } from "./types";
import type { ShiftedDates } from "./templatePlan";
import { combineDT } from "./format";
import { firstOpenStatus, isDone, isKnownStatus, isTrashed } from "./statuses";
import { findH1Line, renameHeadingLine, newTaskBody } from "./taskTitle";
import { fieldKey } from "./fieldNames";
import { ScanCache } from "./scanCache";
import { t } from "./i18n";
import { newUlid, repositoryFor, rfc3339Now, updateRecord } from "./mdbaseRepository";
import { isCollectionPath } from "./mdbaseResources";
import { entityIcon } from "./entityPresentation";
export { OPAL_PROJECT_ID, OPAL_PARENT_ID, OPAL_AREA_ID, OPAL_PROJECT_IDS, OPAL_PROJECT_IDS_NOT, OPAL_NOTE_ID, OPAL_SOURCE_NOTE_ID } from "./stableRelationships";
import { OPAL_PROJECT_ID, OPAL_PARENT_ID, OPAL_AREA_ID, OPAL_SOURCE_NOTE_ID } from "./stableRelationships";

export const slugify = (s: string): string =>
  s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Task";

/** Label-Normalisierung wie bei der Erfassung (klein, ohne #, Leerzeichen→Bindestrich). */
export const normalizeLabel = (s: string): string =>
  slugify(s).toLowerCase().replace(/^#/, "").replace(/\s+/g, "-");

/** Labels introduced by the current edit, preserving input order. Existing labels are excluded so
 *  assigning a label that the user deliberately hid does not silently pin it again. */
export function newlyIntroducedLabels(labels: readonly string[], known: readonly string[]): string[] {
  const seen = new Set(known);
  const added: string[] = [];
  for (const label of labels) {
    if (!label || seen.has(label)) continue;
    seen.add(label);
    added.push(label);
  }
  return added;
}

/** Basename (ohne Ordner und `.md`) for display and legacy backward reads only. */
export const baseName = (path: string): string => path.split("/").pop()!.replace(/\.md$/, "");

export const newId = (_p: string): string =>
  newUlid();

// Lokales Datum (YYYY-MM-DD), NICHT UTC: toISOString() würde nachts (lokal 00:00 bis
// UTC-Offset) noch „gestern" liefern. Identisch zur iso()-Logik im Datepicker.
export const todayIso = (): string => {
  const d = new Date();
  const z = (n: number): string => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
};

/** Fehlende Kanon-Felder (`id`, `created`) einer Aufgaben-Notiz nachtragen – idempotent.
 *  Für handgeschriebene `type: task`-Notizen, sobald sie erstmals über die App bearbeitet werden:
 *  hält die Identität über Umbenennen und GCal-Sync stabil. `status`/`project` bleiben unberührt. */
export function ensureCanonicalFm(fm: Record<string, unknown>): void {
  if (fm.id == null || fm.id === "") fm.id = newUlid();
  if (typeof fm.created !== "string" || !fm.created) fm.created = rfc3339Now();
  if (typeof fm.modified !== "string" || !fm.modified) fm.modified = rfc3339Now();
}

/** Frontmatter-Block – nur gesetzte Felder. */
export function buildFrontmatter(obj: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    clean[k] = v;
  }
  return "---\n" + stringifyYaml(clean) + "---\n";
}

/** Liegt `path` in diesem Ordner (oder IST er es)? Leerer/ungültiger Ordner = nein. Die EINE
 *  Quelle für Ordner-Zugehörigkeit: genutzt von den Ausschluss-Ordnern (taskIndex) und von der
 *  Herkunftsfrage der Titel-Migration (main). Rein – ohne App, damit testbar. */
export function isUnderFolder(path: string, folder: string): boolean {
  return isUnderPrefix(path, folderPrefix(folder));
}

/**
 * Eine Ordnerangabe auf ihre Vergleichsform bringen: normalisiert, ohne Schlusstrich. `""` heisst
 * „keine brauchbare Angabe" und vergleicht sich später mit nichts.
 *
 * Getrennt vom Vergleich, weil beide Hälften unterschiedlich oft laufen: Der ORDNER ändert sich
 * fast nie, der PFAD bei jeder Notiz. Wer über zehntausend Dateien vergleicht, bereitet den Ordner
 * einmal auf und ruft danach nur noch `isUnderPrefix` – `normalizePath` samt Regex und `trim` je
 * Notiz wäre in `TaskIndex.parse`, der heissesten Schleife des Plugins, reine Verschwendung.
 */
export function folderPrefix(folder: string | null | undefined): string {
  const dir = normalizePath(folder ?? "").replace(/\/+$/, "").trim();
  return !dir || dir === "." ? "" : dir;
}

/** Liegt `path` unter einem BEREITS aufbereiteten Ordner (s. folderPrefix)? Zwei
 *  String-Vergleiche, keine Allokation – für die heissen Pfade. */
export const isUnderPrefix = (path: string, prefix: string): boolean =>
  !!prefix && (path === prefix || path.startsWith(prefix + "/"));

export async function ensureFolder(app: App, path: string): Promise<void> {
  const p = normalizePath(path);
  if (!app.vault.getAbstractFileByPath(p)) {
    try { await app.vault.createFolder(p); } catch { /* existiert evtl. schon */ }
  }
}

export interface TaskFields {
  id?: string;                       // optional preallocated identity for create + schedule workflows
  title: string;
  titleInFrontmatter?: boolean;  // Titel ins Frontmatter (Default) statt in eine „# Überschrift".
                                 // Explizit false setzen die Kopier-Wege, wenn das Original seinen
                                 // Titel im Text führt – die Kopie hält es dann genauso.
  description?: string | null;  // freier Markdown-Text (Body, zwischen Titel und Log)
  status?: TaskStatus;
  due?: string | null;          // Datums-Teil (YYYY-MM-DD)
  dueTime?: string | null;      // "HH:mm" -> wird in due eingebettet (YYYY-MM-DDTHH:mm)
  estimate?: number | null;     // erwarteter Gesamtaufwand in Minuten
  priority?: Priority;
  project?: string | null;   // Projekt-Basename (nicht Pfad)
  projectId?: string | null; // stabile ID; schlägt `project`
  labels?: string[];
  recurrence?: string | null;
  recurBasis?: "due" | "done";
  parent?: string | null;    // Basename der Eltern-Aufgabe
  parentId?: string | null;  // stabile ID; schlägt `parent`
  reminders?: string[];      // rohe Erinnerungs-Strings (siehe reminders.ts)
  sortOrder?: number | null; // manuelle Position (sort_order). Normalfall: weglassen -> lazy, kein
                             // Feld. Nur gesetzt, wenn eine Reihenfolge bewusst materialisiert wird
                             // (z. B. beim Duplizieren eines Unterbaums), s. filterEngine.planReorder.
  sourceNoteId?: string | null; // provenance for a line converted inside an ordinary note
}

/**
 * Zeitstempel für eine NEU angelegte Aufgabe. Wird sie gleich als erledigt oder abgebrochen
 * angelegt, gehört der Stempel dazu — sonst fehlt er für immer, denn gesetzt wird er sonst nur
 * beim WECHSEL des Status (setTaskStatus).
 *
 * Das wiegt schwerer, als es aussieht: „Erledigt" und der Papierkorb sortieren absteigend nach
 * diesem Feld, und ein fehlender Wert wird zur leeren Zeichenkette — kleiner als jedes Datum. Die
 * Aufgabe rutschte damit ans ENDE einer womöglich hunderte Einträge langen Liste und galt für den
 * Nutzer als verschwunden. „Heute" zeigt Erledigtes ohnehin nur mit passendem Stempel.
 *
 * Genommen wird der Moment des Anlegens — der einzige Zeitpunkt, den wir kennen, und derselbe,
 * den das Abhaken schreiben würde.
 *
 * `cancelled` ist über die Oberfläche derzeit NICHT erreichbar: Die Statusauswahl beim Anlegen
 * zeigt nur `boardStatuses()`, und die filtert abgebrochene Status heraus (so gewollt — der
 * Papierkorb ist kein Zustand, in dem man etwas anlegt). Der Zweig bleibt trotzdem, weil
 * `createTaskNote` jeden Status entgegennimmt: Käme ein abgebrochener je von woanders (Import,
 * künftiger Aufrufer), stünde ohne ihn derselbe Fehler wieder da — unauffindbar am Ende des
 * Papierkorbs.
 */
export function creationStamps(status: TaskStatus, now: string): { completed: string | null; cancelled: string | null } {
  return {
    completed: isDone(status) ? now : null,
    cancelled: isTrashed(status) ? now : null,
  };
}

/**
 * Zeitstempel bei einem Status WECHSEL. Gegenstück zu `creationStamps`, dieselbe Regel:
 * Ein Stempel gehört zu SEINEM Zustand — er kommt beim Eintritt und geht beim Austritt.
 *
 * Zurückgegeben wird ein Patch: Ein Feld fehlt, wenn es unberührt bleiben soll. `null` heißt
 * ausdrücklich „leeren". So kann der Aufrufer den Unterschied zwischen „nicht anfassen" und
 * „entfernen" nicht versehentlich verlieren.
 *
 * Warum das zählt: Beide Listen (Erledigt, Papierkorb) sortieren absteigend nach ihrem Stempel,
 * und ein fehlender Wert ist die leere Zeichenkette — kleiner als jedes Datum. Eine Aufgabe ohne
 * Stempel steht damit am ENDE ihrer Liste und gilt für den Nutzer als verschwunden.
 */
export function transitionStamps(from: TaskStatus, to: TaskStatus, now: string): { completed?: string | null; cancelled?: string | null } {
  const patch: { completed?: string | null; cancelled?: string | null } = {};
  if (isDone(to) && !isDone(from)) patch.completed = now;
  else if (isDone(from) && !isDone(to)) patch.completed = null;
  if (isTrashed(to) && !isTrashed(from)) patch.cancelled = now;
  else if (isTrashed(from) && !isTrashed(to)) patch.cancelled = null;
  return patch;
}

/**
 * Wohin eine neue Notiz geschrieben wird und unter welchem `type` sie steht.
 *
 * Vorgabe ist die Aufgabe des Vaults (`itemsFolder` + `type: task`). Vorlagen geben hier ihren
 * eigenen Ordner und Typwert mit – dadurch legt DIESELBE Funktion Aufgaben wie Vorlagen an, und
 * es gibt keinen zweiten Schreibweg, der irgendwann auseinanderläuft (s. templateService.ts).
 */
export interface NoteTarget { folder: string; type: string; }

/** Nur der Teil eines Index, den der Kopierer braucht. Strukturell statt `TaskIndex` importiert,
 *  damit taskService keine Abhängigkeit auf den Index bekommt – und damit derselbe Kopierer aus
 *  dem Aufgaben- wie aus dem Vorlagen-Index lesen kann. */
export interface ChildSource { children(path: string): Task[]; }

/** Was der Editor von einem Index braucht (Unteraufgaben-Sektion: zeichnen und nachziehen). */
export interface TaskSource extends ChildSource {
  subscribe(cb: () => void): () => void;
  commentsOf(path: string): number;
  descendants(path: string): Task[];
  all(): Task[];
}

/**
 * In welchem Bestand arbeitet der Editor gerade – in den Aufgaben des Vaults oder in einer
 * Vorlage? Genau zwei Dinge unterscheiden die beiden Fälle:
 *
 *   `index`   – woraus die Unteraufgaben gelesen werden
 *   `target`  – wohin neue Notizen geschrieben werden und unter welchem `type`
 *
 * Alles Übrige (Chips, Titel-Kaskade, Kommentar-Log, Speichern) ist identisch: Eine Vorlage IST
 * ein Aufgabenbaum. Diese zwei Angaben durchzureichen genügt deshalb, um denselben Editor auf
 * Vorlagen laufen zu lassen – es braucht keine zweite Maske.
 *
 * Fehlt `target`, wird in die Aufgaben geschrieben (`itemsFolder` + `type: task`).
 */
export interface EditScope { index: TaskSource; target?: NoteTarget; }

/**
 * Was ein Kopiervorgang (`duplicateSubtree`) über das blosse Duplizieren hinaus tun soll.
 * Alles optional – ohne Angabe verhält er sich wie bisher: gleicher Ordner, gleicher Typ,
 * gleiche Daten, gleiches Projekt.
 */
export interface DuplicateOpts {
  /** Zielordner + Typwert. Gesetzt beim Speichern ALS Vorlage. */
  target?: NoteTarget;
  /** Verschobene Daten je Quellpfad. Gesetzt beim ANWENDEN einer Vorlage (s. templatePlan.ts). */
  dates?: Map<string, ShiftedDates>;
  /** Zielprojekt für ALLE Kopien. `undefined` = das des Originals behalten, `null` = Eingang. */
  project?: string | null;
  /** Stable companion to `project`; supplied when the target was just created. */
  projectId?: string | null;
  /** Woraus gelesen wird. Vorgabe ist der Aufgaben-Index; Vorlagen liegen im zweiten. */
  from?: ChildSource;
  /**
   * Womit die ERSTE Ebene gefüllt wird, statt mit den Kindern von `srcParentPath`.
   *
   * Für Projektvorlagen: Die Aufgaben eines Projekts sind keine Kinder der Projektnotiz – sie
   * verweisen mit `project` auf sie. Ohne diese Angabe fände der Kopierer nichts.
   */
  roots?: Task[];
  /**
   * Für Projektvorlagen beim ANWENDEN: Die direkten Kinder der Wurzel bekommen KEINEN `parent`,
   * sondern werden Aufgaben des Zielprojekts. Tiefere Ebenen bleiben Unteraufgaben.
   *
   * Das ist die Umkehrung von `roots`: Beim Speichern hängen wir die Projektaufgaben unter die
   * Vorlagen-Wurzel (nur so bilden sie einen Baum, den `descendants` findet), beim Anwenden
   * lösen wir sie wieder von ihr.
   */
  detachTop?: boolean;
  /** Stable ID of `newParentBase`; internal handoff for a record created in the same tick. */
  newParentId?: string | null;
  /** Intern: bereits besuchte Pfade (Kreis-Schutz). Nicht von aussen setzen. */
  seen?: Set<string>;
}

/** Resolve a UI/path value to the immutable mdbase id stored in relationship fields. */
export function relationshipId(app: App, value: string | null | undefined, targetTypes: readonly string[]): string | null {
  if (!value) return null;
  const raw = (value.match(/\[\[([^\]|#]+)/)?.[1] ?? value).trim().replace(/\.md$/i, "");
  const key = raw.toLowerCase();
  const exactId: string[] = [], exactPath: string[] = [], exactBase: string[] = [], exactTitle: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !targetTypes.includes(String(fm[fieldKey("type")]))) continue;
    if (isProjectType(fm[fieldKey("type")]) && !isCollectionPath(file.path)) continue;
    const id = typeof fm.id === "string" && fm.id ? fm.id : null;
    if (!id) continue;
    const title = typeof fm.title === "string" ? fm.title.trim().toLowerCase() : "";
    const path = file.path.replace(/\.md$/i, "").toLowerCase();
    if (id === raw) exactId.push(id);
    if (path === key) exactPath.push(id);
    if (file.basename.toLowerCase() === key.split("/").pop()) exactBase.push(id);
    if (title && title === key) exactTitle.push(id);
  }
  for (const matches of [exactId, exactPath, exactBase, exactTitle]) {
    const unique = [...new Set(matches)];
    if (unique.length) return unique.length === 1 ? unique[0] : null;
  }
  return null;
}

/** Resolve an editor's cached ID, then its visible/path fallback. Never persist an unchecked
 *  value in a canonical relationship field: older collection records without `id` used to put
 *  their path there, which made the task disappear from both its list and the Inbox. */
export function canonicalRelationshipId(app: App, candidateId: string | null | undefined,
  fallback: string | null | undefined, targetTypes: readonly string[]): string | null {
  return relationshipId(app, candidateId, targetTypes) ?? relationshipId(app, fallback, targetTypes);
}

/** Backward-compatible relationship value used only when the target has no stable ID yet. */
export function legacyRelationshipLink(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = (value.match(/\[\[([^\]|#]+)/)?.[1] ?? value).trim().replace(/\.md$/i, "");
  return raw ? `[[${raw}]]` : null;
}

/** Neue Aufgaben-Notiz anlegen (kollisionssicherer Dateiname). */
export async function createTaskNote(app: App, settings: OpalTasksSettings, f: TaskFields, target?: NoteTarget): Promise<TFile> {
  const folder = target?.folder ?? settings.itemsFolder;
  await ensureFolder(app, folder);
  const slug = slugify(f.title);
  let dest = normalizePath(folder + "/" + slug + ".md");
  let n = 2;
  while (app.vault.getAbstractFileByPath(dest)) {
    dest = normalizePath(folder + "/" + slug + " " + n + ".md"); n++;
    if (n > 200) break;
  }
  const status = f.status ?? firstOpenStatus();
  const jetzt = rfc3339Now();
  const stamps = creationStamps(status, jetzt);
  const recordType = (target?.type ?? "task") as "task" | "template";
  const projectId = canonicalRelationshipId(app, f.projectId, f.project, ["project", "area"]);
  const parentId = canonicalRelationshipId(app, f.parentId, f.parent, [recordType]);
  const frontmatter: Record<string, unknown> = {
    type: recordType,
    id: f.id ?? newUlid(),
    // Regelfall: der Titel steht hier. Nur wenn er ausdrücklich in den Text soll, bleibt das
    // Feld leer (null wird von buildFrontmatter verworfen) und newTaskBody schreibt die H1.
    title: f.title,
    status,
    completed: stamps.completed,   // null -> von buildFrontmatter verworfen
    cancelled: stamps.cancelled,
    priority: f.priority && f.priority !== "normal" ? f.priority : undefined,
    due: f.due ? combineDT(f.due, f.dueTime) : null,
    estimate: f.estimate ?? null,
    [OPAL_PROJECT_ID]: projectId,
    [OPAL_PARENT_ID]: parentId,
    [OPAL_SOURCE_NOTE_ID]: f.sourceNoteId,
    // If an old target has not received an ID yet, retain a resolvable legacy link. The repair
    // migration will replace it after assigning the target an ID.
    project: projectId ? null : legacyRelationshipLink(f.project),
    parent: parentId ? null : legacyRelationshipLink(f.parent),
    [fieldKey("labels")]: f.labels ?? [],
    recurrence: f.recurrence ?? null,
    recur_basis: f.recurrence && f.recurBasis === "done" ? "done" : null,
    reminders: f.reminders ?? [],
    sort_order: f.sortOrder ?? null,   // null -> von buildFrontmatter verworfen (lazy, kein Feld)
    // Mit Uhrzeit (wie `completed`): sonst sind alle Aufgaben eines Tages beim Sortieren nach
    // „Erstellt" gleichwertig und die Richtung bleibt ohne sichtbare Wirkung. Ältere Notizen
    // behalten ihr reines Datum – der Vergleich in sortTasks kommt mit beidem zurecht.
    created: jetzt,
    description: (f.description ?? "").trim() || null,   // Beschreibung im Frontmatter, nicht im Body
    modified: jetzt,
    template_of: recordType === "template" ? "task" : undefined,
  };
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    clean[key] = value;
  }
  return repositoryFor(app).create({ type: recordType, path: dest, frontmatter: clean, body: newTaskBody(f.title, true) });
}

/** Titel einer bestehenden Aufgaben-Notiz setzen – nach der Kaskade aus taskTitle.ts.
 *
 *  Der Reihenfolge liegt eine Zusage zugrunde: Steht der Titel im Frontmatter, wird der Body
 *  NICHT angefasst. Ob `title:` existiert, entscheidet deshalb processFrontMatter (die lebende
 *  Quelle) und nicht der metadataCache – ein veralteter Cache dürfte diese Zusage nie brechen.
 *  Die H1 dagegen wird auf dem frischen Dateiinhalt INNERHALB von process() gesucht, kann also
 *  nicht veralten; passt die Zeile wider Erwarten nicht mehr, landet der Titel im Frontmatter,
 *  statt blind irgendwohin geschrieben zu werden. Der Dateiname bleibt unberührt (Slug/Identität). */
export async function setTaskTitle(app: App, file: TFile, title: string): Promise<void> {
  await repositoryFor(app).update(file.path, { title });
}

/** Erste H1 einer Notiz umschreiben – für Notizen, deren Name aus dem DATEINAMEN kommt (Projekte,
 *  Bereiche, gespeicherte Filter). Dort ist die Überschrift reine Kosmetik. Angefasst wird sie nur,
 *  wenn sie noch den ALTEN Namen trägt: Neue Notizen bekommen gar keine mehr, und wer in einer
 *  bestehenden seine eigene Struktur angelegt hat, behält sie. Zeilengenau statt per Regex über den
 *  ganzen Text – sonst träfe es auch ein „# …" in einem Code-Block. */
export async function retitleHeading(app: App, file: TFile, oldTitle: string, newTitle: string): Promise<void> {
  await app.vault.process(file, (c) => renameHeadingLine(c, findH1Line(c), oldTitle, newTitle));
}

/** Obsidian-Deeplink (obsidian://) zur Aufgabe in die Zwischenablage kopieren –
 *  genutzt vom Task-Modal („+"-Menü) UND vom Zeilen-Kontextmenü. */
export function copyTaskLink(app: App, path: string): void {
  const vault = encodeURIComponent(app.vault.getName());
  const file = encodeURIComponent(path.replace(/\.md$/, ""));
  navigator.clipboard.writeText(`obsidian://open?vault=${vault}&file=${file}`)
    .then(() => new Notice(t("msg_link_copied")))
    .catch((err) => { console.error("Opal Tasks: copy link failed", err); new Notice(t("msg_link_copy_failed")); });
}

/**
 * Die Notiz einer Aufgabe im Editor öffnen.
 *
 * `where` wird unverändert an `getLeaf()` durchgereicht und stammt idealerweise aus
 * `Keymap.isModEvent(e)`: Das liefert genau den Wert, den Obsidian erwartet, und folgt damit
 * der Plattform (Cmd auf macOS, Ctrl sonst) und der Einstellung des Nutzers. Eine eigene
 * Auslegung von ctrlKey/shiftKey wiche irgendwann davon ab – und wäre auf macOS schlicht
 * falsch, wo Ctrl+Klick der Rechtsklick ist.
 *
 * Existiert die Notiz nicht mehr (Index noch nicht nachgezogen), passiert bewusst nichts:
 * Ein Fehlklick auf eine gerade gelöschte Zeile soll nicht mit einer Meldung antworten.
 */
export function openTaskNote(app: App, path: string, where: "tab" | "split" | "window" | boolean = "tab"): void {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) void app.workspace.getLeaf(where).openFile(f);
}

/** Vorhandene Projekte (Basename, alphabetisch) für den Picker. */
export function listProjects(app: App): string[] {
  return app.vault.getMarkdownFiles()
    .filter((file) => isCollectionPath(file.path) && app.metadataCache.getFileCache(file)?.frontmatter?.[fieldKey("type")] === "project")
    .map((file) => file.basename)
    .sort((a, b) => a.localeCompare(b, "de"));
}

export interface ProjItem {
  id: string; name: string; path: string; icon: string; color: string | null;
  type: "project" | "area"; hidden: boolean; archived: boolean;
  workflowStatus: TaskStatus;
  /** Moment the project entered a done workflow status. Areas never carry this value. */
  completed: string | null;
  priority: Priority;
  area?: string | null;
  areaId?: string | null;
  description: string;   // kurze Beschreibung aus dem Frontmatter (Body bleibt dem Nutzer)
}

const byName = (a: ProjItem, b: ProjItem) => a.name.localeCompare(b.name, "de");
const isInbox = (p: ProjItem) => p.name.toLowerCase() === "inbox" || p.name.toLowerCase() === "eingang";

/** Reservierter Routing-Key des Eingangs (eingebaute Ansicht, KEINE Notiz). Der Doppelpunkt ist
 *  in Datei-Pfaden unzulässig – der Key kann daher nie mit einem echten Projekt-Pfad kollidieren. */
export const INBOX_KEY = "bt:inbox";

/** Pfad einer evtl. noch vorhandenen (alten) Inbox-Projekt-Notiz – nur für die Migration. */
export function inboxNotePath(app: App): string | null {
  return allProjItems(app).find(isInbox)?.path ?? null;
}

/** Ist dieser Projekt-NAME der reservierte Eingang? („Inbox"/„Eingang"). */
export const isInboxName = (name: string | null | undefined): boolean => !!name && /^(inbox|eingang)$/i.test(name);

/** Frontmatter-`type`-Werte, die eine Notiz zu einer verweisbaren Liste machen (Projekt ODER
 *  Bereich). Die EINE Wahrheit – nur ein solches Ziel darf ein Aufgaben-`project`-Link auflösen;
 *  ein Verweis auf irgendeine andere Notiz (z. B. ein altes Fremd-Dashboard) zählt nicht. */
export const isProjectType = (type: unknown): boolean => type === "project" || type === "area";

/** Projekt-Verweis (`[[Name]]`) über den BASENAMEN gegen die Karte echter Projekt-/Bereichs-Notizen
 *  auflösen – wie byProject und die ganze basename-zentrierte Projektlogik, NICHT über
 *  getFirstLinkpathDest: bei gleichnamigen Fremd-Notizen (alte Tasks-Plugin-Dashboards `Tasks/Name.md`
 *  mit `view: project`) träfe das den falschen Namensvetter. Kein echtes Projekt mit dem Basenamen
 *  -> null (Aufgabe im Eingang). `projectPaths` ist lowercase-Basename -> Pfad. Rein/ohne App:
 *  vollständig unit-testbar. */
export function resolveProjectPath(linkText: unknown, projectPaths: Map<string, string>): string | null {
  const m = typeof linkText === "string" ? linkText.match(/\[\[([^\]|#]+)/) : null;
  if (!m) return null;
  const base = m[1].trim().split("/").pop()!.toLowerCase();   // Basename, auch bei [[Ordner/Name]]
  return projectPaths.get(base) ?? null;
}

/** „Nicht einsortiert" = im Eingang: kein Projekt ODER Verweis auf die reservierte Inbox-Notiz.
 *  `project` ist ein aufgelöster Pfad (Task.project) ODER ein Basisname (Editor-Feld). */
export const isInboxLink = (project: string | null | undefined): boolean =>
  !project || isInboxName(project.split("/").pop()!.replace(/\.md$/, ""));

/** Alle Projekt-/Bereich-Notizen mit Meta (Typ, Icon, Farbe, Sichtbarkeit, Archiv).
 *
 *  Der Durchlauf ist gemerkt (s. ScanCache): Er geht über JEDE Notiz des Vaults, liefert aber
 *  solange dasselbe, bis sich eine Projekt-/Bereichsnotiz ändert. Die Seitenleiste fragt ihn
 *  bei jeder Index-Meldung – bei jedem Häkchen also, wo sich hier nichts geändert haben kann. */
const projScan = new ScanCache<ProjItem>(isProjectType, (app) =>
  app.vault.getMarkdownFiles().flatMap((f) => {
    if (!isCollectionPath(f.path)) return [];
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const ty: unknown = fm?.[fieldKey("type")];
    const type: "project" | "area" | null = ty === "area" ? "area" : ty === "project" ? "project" : null;
    if (!type) return [];
    return [{
      // A path is not an ID. Callers may use an empty ID temporarily; task persistence then keeps
      // a legacy wikilink until the repair migration assigns this record a stable identity.
      id: typeof fm?.id === "string" && fm.id ? fm.id : "",
      name: typeof fm?.title === "string" && fm.title.trim() ? fm.title : f.basename, path: f.path, type,
      // Entity presentation is shared by the sidebar, embeds, pickers, and full-page headers.
      // An old explicit `folder` remains a calculated default rather than a custom project icon.
      icon: entityIcon(type, fm?.icon),
      color: typeof fm?.color === "string" ? fm.color : null,
      description: typeof fm?.description === "string" ? fm.description : "",
      area: typeof fm?.area === "string" ? fm.area : null,
      areaId: typeof fm?.[OPAL_AREA_ID] === "string" ? fm[OPAL_AREA_ID] : null,
      workflowStatus: typeof fm?.workflow_status === "string" && isKnownStatus(fm.workflow_status) ? fm.workflow_status : firstOpenStatus(),
      completed: typeof fm?.completed === "string" ? fm.completed : null,
      priority: (["highest", "high", "medium", "normal", "low", "lowest"] as string[]).includes(String(fm?.priority)) ? fm!.priority as Priority : "normal",
      hidden: !!fm?.nav_hidden, archived: fm?.status === "archived",
    }];
  }));

function allProjItems(app: App): ProjItem[] { return projScan.get(app); }

/** Eingang + Bereiche + Projekte (ohne Archivierte) für Picker/Nav. „hidden" bleibt drin;
 *  die Nav filtert es selbst, der Aufgaben-Picker zeigt es weiterhin. */
/** Basenamen (lowercase) aller archivierten Projekte/Bereiche – zum Ausblenden ihrer
 *  Aufgaben aus Sammelansichten (Heute, Demnächst, Labels, Projekt-Boards …). */
export function archivedProjectNames(app: App): Set<string> {
  return new Set(allProjItems(app).filter((p) => p.archived).map((p) => p.name.toLowerCase()));
}

/** Ergebnis von listProjectsAndAreas – benannt, weil es als Ganzes durchgereicht wird
 *  (Signatur und Zähler der Seitenleiste teilen sich EINEN Durchlauf, s. tryPatchNav). */
export interface ProjLists { bereiche: ProjItem[]; projekte: ProjItem[] }

export function listProjectsAndAreas(app: App): ProjLists {
  const all = allProjItems(app).filter((p) => !p.archived);
  const bereiche = all.filter((p) => p.type === "area").sort(byName);
  // Eine evtl. noch vorhandene (alte) Inbox-Notiz NIE als Projekt anbieten – der Eingang ist
  // eine eingebaute Ansicht ohne Notiz. Die Migration räumt die Notiz ohnehin weg.
  const projekte = all.filter((p) => p.type === "project" && !isInbox(p)).sort(byName);
  return { bereiche, projekte };
}

/** Benutzerwert eines `area`-Links auf seinen Basenamen normalisieren. */
export function projectAreaName(area: string | null | undefined): string | null {
  if (typeof area !== "string") return null;
  const raw = area.match(/\[\[([^\]|#]+)/)?.[1] ?? area;
  const name = raw.trim().split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return name || null;
}

/** Aktive Kindprojekte einer Area. Verwaiste Links werden bewusst nicht zugeordnet. */
export function projectsInArea(area: ProjItem, projects: ProjItem[]): ProjItem[] {
  const legacyKey = baseName(area.path).toLowerCase();
  return projects.filter((p) => p.type === "project" && !p.archived
    && (p.areaId === area.id || (!p.areaId && projectAreaName(p.area)?.toLowerCase() === legacyKey)));
}

/** Direkte Area-Aufgaben plus Aufgaben ihrer aktiven Kindprojekte. */
export function tasksInArea(tasks: Task[], area: ProjItem, projects: ProjItem[]): Task[] {
  const paths = new Set([area.path, ...projectsInArea(area, projects).map((p) => p.path)]);
  return tasks.filter((task) => !!task.project && paths.has(task.project));
}

export const priorityBucket = (priority: Priority): Priority =>
  priority === "low" || priority === "lowest" ? "normal" : priority;

/** A project task is visually absorbed only when it occupies the same board cell. */
export function taskMatchesProjectCell(task: Task, project: ProjItem): boolean {
  return task.project === project.path && task.status === project.workflowStatus
    && priorityBucket(task.priority) === priorityBucket(project.priority);
}

/** Bekannte Projekt- und Bereichsnamen – die Liste, gegen die `@Projekt` in der Texterkennung
 *  aufgelöst wird. Bewusst nur BESTEHENDE: Ein Tippfehler soll kein Projekt anlegen, sondern
 *  Text bleiben (s. parseQuickEntry). Beide Eingabe-Masken benutzen dieselbe Liste, damit
 *  dieselbe Eingabe überall dasselbe bedeutet. */
export function knownProjectNames(app: App): string[] {
  const { bereiche, projekte } = listProjectsAndAreas(app);
  return [...bereiche, ...projekte].map((p) => p.name);
}

/** Verwaltung: aktive (Bereiche + Projekte, ohne Eingang) und archivierte Einträge. */
export function listManaged(app: App): { active: ProjItem[]; archived: ProjItem[] } {
  const all = allProjItems(app).filter((p) => !isInbox(p));
  const active = all.filter((p) => !p.archived)
    .sort((a, b) => (a.type === b.type ? byName(a, b) : a.type === "area" ? -1 : 1));   // Bereiche zuerst
  const archived = all.filter((p) => p.archived).sort(byName);
  return { active, archived };
}

/** Completed projects remain visible in the sidebar for this grace period before archiving. */
export const PROJECT_COMPLETION_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Parse a persisted completion stamp without letting malformed user frontmatter expire a project. */
export function projectCompletedAt(project: Pick<ProjItem, "completed">): number | null {
  if (!project.completed) return null;
  const value = Date.parse(project.completed);
  return Number.isFinite(value) ? value : null;
}

/** A done project with no valid stamp is recent until the lifecycle reconciler backfills one. */
export function isRecentlyCompletedProject(project: Pick<ProjItem, "type" | "workflowStatus" | "completed">, now = Date.now()): boolean {
  if (project.type !== "project" || !isDone(project.workflowStatus)) return false;
  const completed = projectCompletedAt(project);
  return completed === null || now - completed < PROJECT_COMPLETION_GRACE_MS;
}

/** Only a valid, elapsed completion stamp is safe to archive automatically. */
export function shouldAutoArchiveProject(project: Pick<ProjItem, "type" | "workflowStatus" | "completed" | "archived">, now = Date.now()): boolean {
  if (project.archived || project.type !== "project" || !isDone(project.workflowStatus)) return false;
  const completed = projectCompletedAt(project);
  return completed !== null && now - completed >= PROJECT_COMPLETION_GRACE_MS;
}

export interface CreatedProjectRecord { name: string; id: string; path: string }

/** Create a project/area and return both its presentation name and immutable identity. */
export async function createProjectRecord(app: App, settings: OpalTasksSettings, name: string, asArea = false, color: string | null = null, hidden = false, description = "", area: string | null = null, workflowStatus: TaskStatus = firstOpenStatus(), priority: Priority = "normal"): Promise<CreatedProjectRecord> {
  const folder = settings.projectsFolder;
  await ensureFolder(app, folder);
  const base = slugify(name);
  let dest = normalizePath(folder + "/" + base + ".md");
  let n = 2;
  while (app.vault.getAbstractFileByPath(dest)) { dest = normalizePath(folder + "/" + base + " " + n + ".md"); n++; if (n > 200) break; }
  const type = asArea ? "area" : "project";
  const now = rfc3339Now();
  const id = newUlid();
  const areaId = !asArea ? relationshipId(app, area, ["area"]) : null;
  const fm: Record<string, unknown> = { type, id, title: name.trim(), status: "active", workflow_status: !asArea ? workflowStatus : undefined, completed: !asArea && isDone(workflowStatus) ? now : undefined, priority: !asArea && priority !== "normal" ? priority : undefined, [OPAL_AREA_ID]: areaId, area: !asArea && !areaId ? legacyRelationshipLink(area) : undefined, color: color ?? undefined, description: description.trim() || undefined, nav_hidden: hidden ? true : undefined, created: now, modified: now };
  // Kein „# Name" mehr im Body: Der Name kommt aus dem Dateinamen, die Überschrift wäre redundant –
  // und der Body gehört ab hier vollständig dem Nutzer (s. „Projektnotiz öffnen").
  await repositoryFor(app).create({ type, path: dest, frontmatter: fm, body: "\n" });
  return { name: name.trim(), id, path: dest };
}

/** Backward-compatible UI helper returning the display name. */
export async function createProjectNote(app: App, settings: OpalTasksSettings, name: string, asArea = false, color: string | null = null, hidden = false, description = "", area: string | null = null, workflowStatus: TaskStatus = firstOpenStatus(), priority: Priority = "normal"): Promise<string> {
  return (await createProjectRecord(app, settings, name, asArea, color, hidden, description, area, workflowStatus, priority)).name;
}

export async function setProjectArea(app: App, path: string, area: string | null): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => {
    const id = relationshipId(app, area, ["area"]);
    if (id) fm[OPAL_AREA_ID] = id; else delete fm[OPAL_AREA_ID];
    if (id) delete fm.area;
    else {
      const legacy = legacyRelationshipLink(area);
      if (legacy) fm.area = legacy; else delete fm.area;
    }
  });
}

export async function setProjectWorkflow(app: App, path: string, workflowStatus: TaskStatus, priority: Priority): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => {
    const previous = typeof fm.workflow_status === "string" && isKnownStatus(fm.workflow_status)
      ? fm.workflow_status : firstOpenStatus();
    fm.workflow_status = workflowStatus;
    // Like task completion stamps, this belongs to the done state: set on entry, retain while
    // moving between done statuses, and remove when the project is reopened.
    if (isDone(workflowStatus) && (!isDone(previous) || typeof fm.completed !== "string" || !Number.isFinite(Date.parse(fm.completed)))) {
      fm.completed = rfc3339Now();
    } else if (!isDone(workflowStatus) && isDone(previous)) {
      delete fm.completed;
    }
    if (priority === "normal") delete fm.priority; else fm.priority = priority;
  });
}

/** Backfill/repair the completion clock independently of the project's visible workflow status. */
export async function setProjectCompleted(app: App, path: string, completed: string | null): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => {
    if (completed) fm.completed = completed; else delete fm.completed;
  });
}

/** Ist die Notiz an diesem Pfad ein Bereich (type: area)? */
export function isAreaPath(app: App, path: string): boolean {
  if (!isCollectionPath(path)) return false;
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm?.[fieldKey("type")] === "area";
}

/** Projekt archivieren/wiederherstellen (status: archived|active). */
export async function setProjectArchived(app: App, path: string, archived: boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => {
    fm.status = archived ? "archived" : "active";
    // Restoring a completed project is an explicit decision to make it visible again. Restart
    // its grace period so the next lifecycle sweep cannot immediately put it back in Archive.
    if (!archived && typeof fm.workflow_status === "string" && isDone(fm.workflow_status)) {
      fm.completed = rfc3339Now();
    }
  });
}

/** Sichtbarkeit in der Nav umschalten (nav_hidden gesetzt = ausgeblendet). */
export async function setNavHidden(app: App, path: string, hidden: boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => {
    if (hidden) fm.nav_hidden = true; else delete fm.nav_hidden;
  });
}

/** Icon-Farbe eines Projekts/Bereichs setzen (Frontmatter `color`; null = entfernen). */
export async function setProjectColor(app: App, path: string, color: string | null): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await updateRecord(app, file, (fm) => { if (color) fm.color = color; else delete fm.color; });
}

/** Kurzbeschreibung eines Projekts/Bereichs setzen (Frontmatter `description`; leer = entfernen).
 *  Bewusst im Frontmatter und nicht im Body – der gehört dem Nutzer (s. „Notiz öffnen"). */
export async function setProjectDescription(app: App, path: string, description: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const text = description.trim();
  await updateRecord(app, file, (fm) => {
    if (text) fm.description = text; else delete fm.description;
  });
}

/** Project titles are presentation; record path and id stay stable. */
export async function renameProjectNote(app: App, path: string, newName: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const title = newName.trim();
  if (!title) return null;
  await updateRecord(app, file, (fm) => { fm.title = title; });
  return title;
}

/** Projekt in den Obsidian-Papierkorb verschieben (reversibel). */
export async function deleteProjectNote(app: App, path: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) await repositoryFor(app).trash(file.path);
}
