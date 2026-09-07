import { App, TFile, normalizePath, stringifyYaml } from "obsidian";
import { OpalTasksSettings, TaskStatus, Priority } from "./types";
import { todayIso } from "./taskService";
import { titleKey } from "./taskTitle";
import { fieldKey } from "./fieldNames";
import { migratedDeadline } from "./timingMigration";
import { newUlid, rfc3339Now } from "./mdbaseRepository";
import { OPAL_PROJECT_ID } from "./stableRelationships";

const PRIO_MAP: Record<string, Priority> = {
  "🔺": "highest", "⏫": "high", "🔼": "medium", "🔽": "low", "⏬": "lowest",
};
const STATUS_MAP: Record<string, TaskStatus> = {
  " ": "todo", "/": "doing", "x": "done", "X": "done", "-": "cancelled",
};

interface ParsedLine {
  status: TaskStatus; title: string; priority: Priority;
  due: string | null; scheduled: string | null; recurrence: string | null;
  completed: string | null; cancelled: string | null; labels: string[];
  detailsBase: string | null;
}

/** Eine Opal Tasks-Aufgabenzeile zerlegen (Spiegel von parseTaskLine). Exportiert für Tests. */
export function parseLine(line: string): ParsedLine | null {
  const cb = line.match(/^\s*- \[(.)\]\s?/);
  if (!cb) return null;
  const status = STATUS_MAP[cb[1]] ?? "todo";
  let body = line.replace(/^\s*- \[.\]\s*/, "");

  let detailsBase: string | null = null;
  body = body.replace(/\s*\[\[([^\]|]+)\|Details\]\]/, (_m: string, b: string) => { detailsBase = b.trim(); return " "; });
  body = body.replace(/(^|\s)#task(?=\s|$)/, " ");          // globaler Filter raus

  // Wort-Grenze ohne Lookbehind (iOS-kompatibel); nicht-fangend → m[1] bleibt das Label.
  const labels = [...new Set([...body.matchAll(/(?:^|[^"\w/-])#([A-Za-zÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß/_-]*)/g)].map((m) => m[1]))];
  body = body.replace(/(?:^|[^"\w/-])#([A-Za-zÄÖÜäöüß][A-Za-z0-9ÄÖÜäöüß/_-]*)/g, " ");

  let due: string | null = null, scheduled: string | null = null;
  body = body.replace(/📅\s*(\d{4}-\d{2}-\d{2})/, (_m: string, d: string) => { due = d; return " "; });
  body = body.replace(/⏳\s*(\d{4}-\d{2}-\d{2})/, (_m: string, d: string) => { scheduled = d; return " "; });

  let priority: Priority = "normal";
  body = body.replace(/(🔺|⏫|🔼|🔽|⏬|⬆️?)/, (m) => { priority = PRIO_MAP[m] ?? (m.startsWith("⬆") ? "high" : "normal"); return " "; });

  let completed: string | null = null, cancelled: string | null = null;
  body = body.replace(/✅\s*(\d{4}-\d{2}-\d{2})/, (_m: string, d: string) => { completed = d; return " "; });
  body = body.replace(/❌\s*(\d{4}-\d{2}-\d{2})/, (_m: string, d: string) => { cancelled = d; return " "; });

  let recurrence: string | null = null;
  body = body.replace(/🔁\s*([^\n]*)$/, (_m: string, r: string) => { recurrence = r.trim(); return " "; });

  const title = body.replace(/\s{2,}/g, " ").trim();
  return { status, title, priority, due, scheduled, recurrence, completed, cancelled, labels, detailsBase };
}

const slugify = (s: string) =>
  s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Aufgabe";

async function ensureFolder(app: App, path: string) {
  const p = normalizePath(path);
  if (!app.vault.getAbstractFileByPath(p)) {
    try { await app.vault.createFolder(p); } catch { /* existiert evtl. schon */ }
  }
}

/** Frontmatter-Block bauen – nur gesetzte Felder, Reihenfolge stabil. */
function frontmatter(obj: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === "") continue;
    clean[k] = v;
  }
  return "---\n" + stringifyYaml(clean) + "---\n";
}

/** Detail-Notiz-Body lesen (alles nach Frontmatter + erster H1). */
async function detailBody(app: App, base: string): Promise<string> {
  const f = app.vault.getAbstractFileByPath(normalizePath("Tasks/Details/" + base + ".md"));
  if (!(f instanceof TFile)) return "";
  let txt = await app.vault.read(f);
  txt = txt.replace(/^---\n[\s\S]*?\n---\n?/, "");           // Frontmatter weg
  txt = txt.replace(/^#\s.*\n?/, "");                        // Auto-H1 weg
  return txt.trim();
}

/** Importiert alle Aufgaben aus Tasks/Lists/ in Frontmatter-Notizen. Idempotent
 *  (existiert die Zieldatei schon, wird sie übersprungen). Liefert die Anzahl neu
 *  angelegter Aufgaben. */
export async function runMigration(app: App, settings: OpalTasksSettings): Promise<number> {
  await ensureFolder(app, settings.itemsFolder);
  await ensureFolder(app, settings.projectsFolder);

  const lists = app.vault.getMarkdownFiles()
    .filter((f) => f.path.startsWith("Tasks/Lists/") && f.path.indexOf("/", "Tasks/Lists/".length) === -1
      && f.basename !== "+ New Project");

  const today = todayIso();   // lokales Datum (nicht UTC), siehe taskService.todayIso
  let created = 0;

  for (const list of lists) {
    const projectName = list.basename;
    // Projekt-Notiz anlegen, falls fehlt.
    const projPath = normalizePath(settings.projectsFolder + "/" + slugify(projectName) + ".md");
    const existingProject = app.vault.getAbstractFileByPath(projPath);
    let projectId = existingProject instanceof TFile
      ? app.metadataCache.getFileCache(existingProject)?.frontmatter?.id as string | undefined
      : undefined;
    if (!projectId) projectId = newUlid();
    if (!existingProject) {
      const now = rfc3339Now();
      await app.vault.create(projPath, frontmatter({ [fieldKey("type")]: "project", id: projectId, title: projectName,
        status: "active", icon: "list-checks", created: now, modified: now }) + "\n");
    } else if (existingProject instanceof TFile) {
      await app.fileManager.processFrontMatter(existingProject, (fm: Record<string, unknown>) => { if (!fm.id) fm.id = projectId; });
    }

    const lines = (await app.vault.read(list)).split("\n");
    for (const line of lines) {
      if (!/^\s*- \[.\]/.test(line)) continue;
      const p = parseLine(line);
      if (!p || !p.title) continue;

      let slug = slugify(p.title);
      let dest = normalizePath(settings.itemsFolder + "/" + slug + ".md");
      let n = 2;
      while (app.vault.getAbstractFileByPath(dest)) {            // Kollision/Idempotenz
        // gleicher Titel im selben Projekt? -> als bereits importiert überspringen.
        dest = normalizePath(settings.itemsFolder + "/" + slug + " " + n + ".md"); n++;
        if (n > 50) break;
      }
      if (app.vault.getAbstractFileByPath(dest)) continue;

      const fm = frontmatter({
        [fieldKey("type")]: "task",
        id: newUlid(),
        [titleKey()]: p.title,
        status: p.status,
        priority: p.priority === "normal" ? undefined : p.priority,
        due: migratedDeadline(p.due, p.scheduled),
        [OPAL_PROJECT_ID]: projectId,
        labels: p.labels,
        recurrence: p.recurrence,
        created: today,
        completed: p.completed,
        cancelled: p.cancelled,
      });
      let body = "";
      if (p.detailsBase) {
        const db = await detailBody(app, p.detailsBase);
        if (db) body += "\n" + db + "\n";
      }
      await app.vault.create(dest, fm + "\n" + body);
      created++;
    }
  }
  return created;
}
