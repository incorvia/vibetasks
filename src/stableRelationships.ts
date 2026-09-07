import { App, TFile, normalizePath, parseYaml } from "obsidian";
import { isCollectionPath, RECORD_TYPES } from "./mdbaseResources";
import { newUlid, rfc3339Now, upgradedRelationshipTypeDocument } from "./mdbaseRepository";
import { fieldKey } from "./fieldNames";
import { titleKey } from "./taskTitle";

export const OPAL_PROJECT_ID = "opal_project_id";
export const OPAL_PARENT_ID = "opal_parent_id";
export const OPAL_AREA_ID = "opal_area_id";
export const OPAL_PROJECT_IDS = "opal_project_ids";
export const OPAL_PROJECT_IDS_NOT = "opal_project_ids_not";
export const OPAL_INCLUDE_INBOX = "opal_include_inbox";
export const OPAL_EXCLUDE_INBOX = "opal_exclude_inbox";

export interface RelationshipRecord {
  path: string;
  type: string;
  id: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

export interface MigrationDiagnostic {
  path: string;
  field: string;
  value: unknown;
  reason: "unresolved" | "ambiguous";
  candidates: string[];
}

export interface RelationshipPlan {
  changes: Map<string, Record<string, unknown>>;
  diagnostics: MigrationDiagnostic[];
}

export function relationshipBackup(files: { path: string; content: string }[], diagnostics: MigrationDiagnostic[], migratedAt: string): string {
  return JSON.stringify({ version: 1, migrated_at: migratedAt, files, diagnostics }, null, 2);
}

const key = (value: string): string => value.trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
const reference = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.match(/\[\[([^\]|#]+)/)?.[1] ?? value;
  return raw.trim() || null;
};
const basename = (path: string): string => key(path).split("/").pop() ?? "";
const isInbox = (value: string): boolean => ["inbox", "eingang"].includes(basename(value));

class Lookup {
  private byId = new Map<string, RelationshipRecord[]>();
  private byPath = new Map<string, RelationshipRecord[]>();
  private byBase = new Map<string, RelationshipRecord[]>();
  private byTitle = new Map<string, RelationshipRecord[]>();

  constructor(records: RelationshipRecord[]) {
    for (const record of records) {
      this.add(this.byId, record.id, record);
      this.add(this.byPath, key(record.path), record);
      this.add(this.byBase, basename(record.path), record);
      if (record.title.trim()) this.add(this.byTitle, key(record.title), record);
    }
  }

  private add(map: Map<string, RelationshipRecord[]>, value: string, record: RelationshipRecord): void {
    if (!value) return;
    const found = map.get(value);
    if (found) found.push(record); else map.set(value, [record]);
  }

  resolve(value: unknown, types?: readonly string[]): { record?: RelationshipRecord; candidates: RelationshipRecord[] } {
    const raw = reference(value);
    if (!raw) return { candidates: [] };
    const accept = (items: RelationshipRecord[] | undefined): RelationshipRecord[] =>
      [...new Map((items ?? []).filter((item) => !types || types.includes(item.type)).map((item) => [item.path, item])).values()];
    // A precise identity/path match wins over a coincidental duplicate basename or title.
    for (const items of [this.byId.get(raw), this.byPath.get(key(raw)), this.byBase.get(basename(raw)), this.byTitle.get(key(raw))]) {
      const matches = accept(items);
      if (matches.length) return matches.length === 1 ? { record: matches[0], candidates: matches } : { candidates: matches };
    }
    return { candidates: [] };
  }
}

function migrateOne(fm: Record<string, unknown>, legacy: string, canonical: string, lookup: Lookup,
  types: readonly string[], path: string, diagnostics: MigrationDiagnostic[]): void {
  if (typeof fm[canonical] === "string" && fm[canonical]) {
    const current = lookup.resolve(fm[canonical], types);
    if (current.record?.id) {
      fm[canonical] = current.record.id;
      delete fm[legacy];
      return;
    }
    // A recoverable legacy link takes precedence over an invalid canonical value. This repairs
    // the first stable-ID migration, which could write a file path as though it were an ID.
    if (!(legacy in fm)) {
      diagnostics.push({ path, field: canonical, value: fm[canonical],
        reason: current.candidates.length > 1 ? "ambiguous" : "unresolved",
        candidates: current.candidates.map((candidate) => candidate.path) });
      return;
    }
  }
  if (!(legacy in fm)) return;
  const value = fm[legacy];
  const result = lookup.resolve(value, types);
  if (result.record) {
    fm[canonical] = result.record.id;
    delete fm[legacy];
  } else {
    diagnostics.push({ path, field: legacy, value,
      reason: result.candidates.length > 1 ? "ambiguous" : "unresolved",
      candidates: result.candidates.map((candidate) => candidate.path) });
  }
}

function migrateFilterList(fm: Record<string, unknown>, legacy: string, canonical: string, inboxFlag: string,
  lookup: Lookup, path: string, diagnostics: MigrationDiagnostic[]): void {
  if (!Array.isArray(fm[legacy])) return;
  const resolved = Array.isArray(fm[canonical]) ? (fm[canonical] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const unresolved: unknown[] = [];
  for (const value of fm[legacy] as unknown[]) {
    const raw = reference(value);
    if (raw && isInbox(raw)) { fm[inboxFlag] = true; continue; }
    const found = lookup.resolve(value, ["project", "area"]);
    if (found.record) resolved.push(found.record.id);
    else {
      unresolved.push(value);
      diagnostics.push({ path, field: legacy, value,
        reason: found.candidates.length > 1 ? "ambiguous" : "unresolved",
        candidates: found.candidates.map((candidate) => candidate.path) });
    }
  }
  if (resolved.length) fm[canonical] = [...new Set(resolved)];
  if (unresolved.length) fm[legacy] = unresolved; else delete fm[legacy];
}

/** Pure migration planner. Inputs are cloned; unresolved legacy fields are deliberately retained.
 *  Identity is repaired first so every relationship written in the same plan has a real target. */
export function planStableRelationships(records: RelationshipRecord[], createId: () => string = newUlid): RelationshipPlan {
  const originals = new Map(records.map((record) => [record.path, record]));
  const prepared = records.map((record): RelationshipRecord => {
    if (record.id || !isCollectionPath(record.path) || !(RECORD_TYPES as readonly string[]).includes(record.type)) return record;
    const id = createId();
    return { ...record, id, frontmatter: { ...record.frontmatter, id } };
  });
  const lookup = new Lookup(prepared);
  const changes = new Map<string, Record<string, unknown>>();
  const diagnostics: MigrationDiagnostic[] = [];

  const changed = (record: RelationshipRecord, fm: Record<string, unknown>): void => {
    const original = originals.get(record.path);
    if (!original || JSON.stringify(fm) !== JSON.stringify(original.frontmatter)) changes.set(record.path, fm);
  };

  for (const record of prepared) {
    const fm = { ...record.frontmatter };
    if (record.type === "task" || record.type === "template") {
      migrateOne(fm, "project", OPAL_PROJECT_ID, lookup, ["project", "area"], record.path, diagnostics);
      migrateOne(fm, "parent", OPAL_PARENT_ID, lookup, [record.type], record.path, diagnostics);
    } else if (record.type === "project") {
      migrateOne(fm, "area", OPAL_AREA_ID, lookup, ["area"], record.path, diagnostics);
    }
    if (record.type === "filter") {
      migrateFilterList(fm, "projects", OPAL_PROJECT_IDS, OPAL_INCLUDE_INBOX, lookup, record.path, diagnostics);
      migrateFilterList(fm, "projects_not", OPAL_PROJECT_IDS_NOT, OPAL_EXCLUDE_INBOX, lookup, record.path, diagnostics);
    }
    const nested = fm.view_filter;
    if ((record.type === "project" || record.type === "area") && nested && typeof nested === "object" && !Array.isArray(nested)) {
      const view = { ...(nested as Record<string, unknown>) };
      migrateFilterList(view, "projects", OPAL_PROJECT_IDS, OPAL_INCLUDE_INBOX, lookup, record.path, diagnostics);
      migrateFilterList(view, "projects_not", OPAL_PROJECT_IDS_NOT, OPAL_EXCLUDE_INBOX, lookup, record.path, diagnostics);
      fm.view_filter = view;
    }

    // Move the ownership marker to the companion note. A precise link is required; a duplicate
    // basename/title remains untouched and appears in the report.
    if ((record.type === "project" || record.type === "area") && "linked_note" in fm) {
      const found = lookup.resolve(fm.linked_note);
      const recordTypes = ["task", "template", "project", "area", "filter", "time_log", "timer_state"];
      const target = found.record && !recordTypes.includes(found.record.type) ? found.record : undefined;
      if (target) {
        const companion = { ...(changes.get(target.path) ?? target.frontmatter), [OPAL_PROJECT_ID]: record.id };
        changes.set(target.path, companion);
        delete fm.linked_note;
      } else {
        diagnostics.push({ path: record.path, field: "linked_note", value: fm.linked_note,
          reason: found.candidates.length > 1 ? "ambiguous" : "unresolved",
          candidates: found.candidates.map((candidate) => candidate.path) });
      }
    }
    changed(record, fm);
  }

  // A companion change may have been staged before its own record was visited; preserve it.
  for (const [path, fm] of [...changes]) {
    const original = originals.get(path);
    if (original && JSON.stringify(fm) === JSON.stringify(original.frontmatter)) changes.delete(path);
  }
  return { changes, diagnostics };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Execute the plan with an exact-content backup created before the first data-file write. */
export async function migrateStableRelationships(app: App): Promise<{ backupPath: string | null; diagnostics: MigrationDiagnostic[]; changed: string[] }> {
  const contents = new Map<string, string>();
  const records: RelationshipRecord[] = [];
  const schemaBackups: string[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    let content: string;
    try { content = await app.vault.read(file); } catch { continue; }
    contents.set(file.path, content);
    const match = content.match(FRONTMATTER);
    let parsed: unknown = {};
    try { parsed = match ? parseYaml(match[1]) : {}; } catch { parsed = {}; }
    const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    if (fm.kind === "mdbase.type" && ["task", "template", "project", "area", "filter"].includes(String(fm.name))) {
      const type = fm.name as "task" | "template" | "project" | "area" | "filter";
      if (upgradedRelationshipTypeDocument(content, type) !== content) schemaBackups.push(file.path);
    }
    const storedType = fm[fieldKey("type")];
    const type = typeof storedType === "string" ? storedType : "note";
    const id = typeof fm.id === "string" ? fm.id : "";
    const storedTitle = fm[titleKey()];
    const title = typeof storedTitle === "string" ? storedTitle : file.basename;
    records.push({ path: file.path, type, id, title, frontmatter: fm });
  }
  const plan = planStableRelationships(records);
  if (!plan.changes.size && !schemaBackups.length) return { backupPath: null, diagnostics: plan.diagnostics, changed: [] };

  const folder = "_opal_tasks/migrations";
  if (!app.vault.getAbstractFileByPath("_opal_tasks")) await app.vault.createFolder("_opal_tasks");
  if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = normalizePath(`${folder}/relationships-${stamp}.json`);
  const changed = [...plan.changes.keys()].sort();
  const backedUp = [...new Set([...changed, ...schemaBackups])].sort();
  await app.vault.create(backupPath, relationshipBackup(
    backedUp.map((path) => ({ path, content: contents.get(path) ?? "" })),
    plan.diagnostics,
    new Date().toISOString(),
  ));

  for (const path of changed) {
    const file = app.vault.getAbstractFileByPath(path);
    const next = plan.changes.get(path);
    if (!(file instanceof TFile) || !next) continue;
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const field of Object.keys(fm)) if (!(field in next)) delete fm[field];
      Object.assign(fm, next);
      if (isCollectionPath(path)) fm.modified = rfc3339Now();
    });
  }
  return { backupPath, diagnostics: plan.diagnostics, changed };
}
