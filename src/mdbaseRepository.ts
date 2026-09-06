import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { App, Component, TFile, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import {
  DEFAULT_SCHEMAS,
  MDBASE_COLLECTION_ROOT,
  MDBASE_SPEC_VERSION,
  MDBASE_TYPES_FOLDER,
  RECORD_TYPES,
  collectionPath,
  isCollectionPath,
  isRecordType,
  mdbaseConfigDocument,
  type RecordType,
  typeDocument,
  typeResourcePath,
} from "./mdbaseResources";
import type { StoredStatus, VibeTaskSettings } from "./types";

export type ValidationSeverity = "error" | "warn";
export interface ValidationIssue {
  path: string;
  type?: RecordType;
  severity: ValidationSeverity;
  code: string;
  field?: string;
  message: string;
}

export interface CollectionRecord<T extends Record<string, unknown> = Record<string, unknown>> {
  path: string;
  type: RecordType;
  id: string;
  frontmatter: T;
  body?: string;
  revision: string;
}

export interface CreateRecordInput {
  type: RecordType;
  path: string;
  frontmatter: Record<string, unknown>;
  body?: string;
}

export interface UpdateRecordOptions {
  ifRevision?: string;
}

export interface CollectionInitResult {
  ready: boolean;
  created: string[];
  issues: ValidationIssue[];
}

export interface MdbaseDomainConfiguration {
  statuses?: StoredStatus[];
  priorities?: string[];
  paths: Partial<Record<RecordType, string>>;
}

export class MdbaseRepositoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly issues: ValidationIssue[] = []) {
    super(message);
    this.name = "MdbaseRepositoryError";
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function parseDocument(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(FRONTMATTER);
  if (!match) return { frontmatter: {}, body: content };
  const parsed: unknown = parseYaml(match[1]);
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { frontmatter, body: content.slice(match[0].length) };
}

function serializeDocument(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

function revisionOf(file: TFile): string {
  return `${file.stat.mtime}:${file.stat.size}`;
}

export function rfc3339Now(): string {
  return new Date().toISOString();
}

/** ULID without a Node dependency; Web Crypto is available on desktop and mobile. */
export function newUlid(now = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(10);
  if (typeof crypto !== "undefined") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bits = 0, value = 0, tail = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      tail += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return head + tail.slice(0, 16).padEnd(16, "0");
}

function errorsToIssues(path: string, type: RecordType, errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path,
    type,
    severity: "error",
    code: `schema.${error.keyword}`,
    field: error.instancePath.replace(/^\//, "").replace(/\//g, ".") || undefined,
    message: error.message ?? "Schema validation failed",
  }));
}

function cleanPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete target[key];
    else target[key] = value;
  }
}

function cleanRecord(source: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  // Creation must preserve explicitly supplied empty collections. Some record types (notably
  // time_log) require canonical `blocks: []` and `sessions: []` fields before their first entry.
  // Patch semantics stay unchanged: assigning [] to an existing optional field still clears it.
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined || value === "") continue;
    target[key] = value;
  }
  return target;
}

export class MdbaseRepository extends Component {
  private validators = new Map<RecordType, ValidateFunction>();
  private initResult: CollectionInitResult = { ready: false, created: [], issues: [] };
  private subscribers = new Set<() => void>();
  private issueMap = new Map<string, ValidationIssue[]>();
  private typeDocuments = new Map<RecordType, Record<string, unknown>>();

  constructor(public readonly app: App) {
    super();
    this.compileDefaults();
  }

  onload(): void {
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (!isCollectionPath(file.path)) return;
      if (!isRecordType(this.app.metadataCache.getFileCache(file)?.frontmatter?.type)) return;
      void this.refreshIssues(file);
      this.emit();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (!isCollectionPath(file.path)) return;
      this.issueMap.delete(file.path);
      this.emit();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (isCollectionPath(file.path) || isCollectionPath(oldPath)) this.emit();
    }));
  }

  private compileDefaults(): void {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat("date", (value: string) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
    ajv.addFormat("date-time", (value: string) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)));
    this.validators.clear();
    for (const type of RECORD_TYPES) this.validators.set(type, ajv.compile(DEFAULT_SCHEMAS[type]));
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (existing instanceof TFile) throw new MdbaseRepositoryError("folder_is_file", `${path} must be a folder`);
      return;
    }
    const diskEntry = await this.app.vault.adapter.stat(path);
    if (diskEntry) {
      if (diskEntry.type !== "folder") throw new MdbaseRepositoryError("folder_is_file", `${path} must be a folder`);
      return;
    }
    try {
      await this.app.vault.createFolder(path);
    } catch (error) {
      // During startup Obsidian's vault index can lag behind the filesystem:
      // getAbstractFileByPath() says "missing", while createFolder() sees the
      // directory on disk. Treat only that known idempotency race as success.
      const after = this.app.vault.getAbstractFileByPath(path);
      if ((after && !(after instanceof TFile)) || /folder already exists/i.test(error instanceof Error ? error.message : String(error))) return;
      throw error;
    }
  }

  /** Read through the Vault when indexed, falling back to its mobile-safe adapter during startup. */
  private async existingFile(path: string): Promise<{ exists: false } | { exists: true; file: true; content: string } | { exists: true; file: false }> {
    const indexed = this.app.vault.getAbstractFileByPath(path);
    if (indexed instanceof TFile) return { exists: true, file: true, content: await this.app.vault.read(indexed) };
    if (indexed) return { exists: true, file: false };
    const diskEntry = await this.app.vault.adapter.stat(path);
    if (!diskEntry) return { exists: false };
    if (diskEntry.type !== "file") return { exists: true, file: false };
    return { exists: true, file: true, content: await this.app.vault.adapter.read(path) };
  }

  private configIssues(frontmatter: Record<string, unknown>, path: string): ValidationIssue[] {
    const version = frontmatter.spec_version;
    const settings = frontmatter.settings as Record<string, unknown> | undefined;
    const keys = settings?.explicit_type_keys;
    const typesFolder = settings?.types_folder;
    const out: ValidationIssue[] = [];
    if (version !== MDBASE_SPEC_VERSION) out.push({ path, severity: "error", code: "config.spec_version", message: `Expected mdbase ${MDBASE_SPEC_VERSION}` });
    if (!Array.isArray(keys) || !keys.includes("type")) out.push({ path, severity: "error", code: "config.type_key", message: "explicit_type_keys must include type" });
    if (settings?.validation !== "warn") out.push({ path, severity: "error", code: "config.validation", message: "validation must be warn" });
    if (typesFolder !== undefined && typesFolder !== MDBASE_TYPES_FOLDER) out.push({ path, severity: "error", code: "config.types_folder", message: `types_folder must be ${MDBASE_TYPES_FOLDER}` });
    return out;
  }

  private typeIssues(frontmatter: Record<string, unknown>, type: RecordType, path: string): ValidationIssue[] {
    const schema = frontmatter.schema as Record<string, unknown> | undefined;
    const value = schema?.value;
    const out: ValidationIssue[] = [];
    if (frontmatter.kind !== "mdbase.type" || frontmatter.name !== type) out.push({ path, type, severity: "error", code: "type.identity", message: `Expected mdbase.type named ${type}` });
    if (schema?.dialect !== "json-schema-2020-12" || !value || typeof value !== "object" || Array.isArray(value)) out.push({ path, type, severity: "error", code: "type.schema", message: "A JSON Schema 2020-12 schema.value mapping is required" });
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const definition = value as Record<string, unknown>;
      const required = Array.isArray(definition.required) ? definition.required : [];
      const properties = definition.properties as Record<string, unknown> | undefined;
      for (const field of ["type", "id", "title", "created", "modified"]) {
        if (!required.includes(field) || !properties?.[field]) out.push({ path, type, severity: "error", code: "type.canonical_fields", field, message: `${type} must require canonical field ${field}` });
      }
      const rule = properties?.type as Record<string, unknown> | undefined;
      if (rule?.const !== type) out.push({ path, type, severity: "error", code: "type.discriminator", field: "type", message: `type must be constrained to ${type}` });
      if (definition.additionalProperties !== true) out.push({ path, type, severity: "error", code: "type.additional_properties", message: `${type} must allow additional user properties` });
    }
    return out;
  }

  async initialize(): Promise<CollectionInitResult> {
    try {
      return await this.initializeCollection();
    } catch (error) {
      // Collection setup must never take the whole Obsidian plugin down. In
      // particular, keep the command palette (including diagnostics) available
      // when a user-edited YAML file is malformed or a vault operation fails.
      this.validators.clear();
      this.initResult = {
        ready: false,
        created: [],
        issues: [{
          path: collectionPath("mdbase.yaml"),
          severity: "error",
          code: "collection.initialize",
          message: error instanceof Error ? error.message : String(error),
        }],
      };
      console.error("VibeTask: mdbase initialization failed", error);
      return this.status();
    }
  }

  private async initializeCollection(): Promise<CollectionInitResult> {
    const created: string[] = [];
    const issues: ValidationIssue[] = [];
    await this.ensureFolder(MDBASE_COLLECTION_ROOT);
    const configPath = collectionPath("mdbase.yaml");
    const existingConfig = await this.existingFile(configPath);
    if (!existingConfig.exists) {
      await this.app.vault.create(configPath, mdbaseConfigDocument());
      created.push(configPath);
    } else if (existingConfig.file) {
      const config: unknown = parseYaml(existingConfig.content);
      issues.push(...this.configIssues(config && typeof config === "object" ? config as Record<string, unknown> : {}, configPath));
    } else {
      issues.push({ path: configPath, severity: "error", code: "config.not_file", message: "mdbase.yaml must be a file" });
    }

    await this.ensureFolder(collectionPath(MDBASE_TYPES_FOLDER));
    const schemas = new Map<RecordType, Record<string, unknown>>();
    for (const type of RECORD_TYPES) {
      const path = typeResourcePath(type);
      const existing = await this.existingFile(path);
      if (!existing.exists) {
        await this.app.vault.create(path, typeDocument(type));
        created.push(path);
        schemas.set(type, DEFAULT_SCHEMAS[type]);
        continue;
      }
      if (!existing.file) {
        issues.push({ path, type, severity: "error", code: "type.not_file", message: `${path} must be a file` });
        continue;
      }
      const parsed = parseDocument(existing.content).frontmatter;
      const found = this.typeIssues(parsed, type, path);
      issues.push(...found);
      const value = (parsed.schema as Record<string, unknown> | undefined)?.value;
      if (!found.length && value && typeof value === "object" && !Array.isArray(value)) {
        schemas.set(type, value as Record<string, unknown>);
        this.typeDocuments.set(type, parsed);
      }
    }

    for (const type of RECORD_TYPES) {
      if (!this.typeDocuments.has(type)) this.typeDocuments.set(type, parseDocument(typeDocument(type)).frontmatter);
    }

    if (!issues.some((issue) => issue.severity === "error")) {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      ajv.addFormat("date", (value: string) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
      ajv.addFormat("date-time", (value: string) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)));
      try {
        this.validators = new Map([...schemas].map(([type, schema]) => [type, ajv.compile(schema)]));
      } catch (error) {
        issues.push({ path: collectionPath(MDBASE_TYPES_FOLDER), severity: "error", code: "type.compile", message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.initResult = { ready: !issues.some((issue) => issue.severity === "error"), created, issues };
    return this.initResult;
  }

  status(): CollectionInitResult {
    return { ...this.initResult, created: [...this.initResult.created], issues: [...this.initResult.issues] };
  }

  domainConfiguration(): MdbaseDomainConfiguration {
    const task = this.typeDocuments.get("task");
    const extension = task?.["x-vibetask"] as Record<string, unknown> | undefined;
    const statuses = Array.isArray(extension?.statuses)
      ? extension.statuses.filter((entry): entry is StoredStatus => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
          const item = entry as Partial<StoredStatus>;
          return typeof item.id === "string" && ["open", "done", "cancelled"].includes(String(item.kind));
        }).map((entry) => ({ ...entry }))
      : undefined;
    const priorities = Array.isArray(extension?.priorities)
      ? extension.priorities.filter((value): value is string => typeof value === "string")
      : undefined;
    const paths: Partial<Record<RecordType, string>> = {};
    for (const type of RECORD_TYPES) {
      const collection = this.typeDocuments.get(type)?.collection as Record<string, unknown> | undefined;
      const path = collection?.path as Record<string, unknown> | undefined;
      if (typeof path?.pattern === "string") paths[type] = collectionPath(path.pattern);
    }
    return { statuses, priorities, paths };
  }

  applyDomainConfiguration(settings: VibeTaskSettings): void {
    const config = this.domainConfiguration();
    const folder = (pattern: string | undefined): string | null => {
      if (!pattern) return null;
      const normalized = normalizePath(pattern);
      const marker = normalized.indexOf("/{");
      return marker > 0 ? normalized.slice(0, marker) : null;
    };
    settings.itemsFolder = folder(config.paths.task) ?? settings.itemsFolder;
    settings.projectsFolder = folder(config.paths.project) ?? settings.projectsFolder;
    settings.filtersFolder = folder(config.paths.filter) ?? settings.filtersFolder;
    settings.templatesFolder = folder(config.paths.template) ?? settings.templatesFolder;
    if (config.statuses?.length) settings.statuses = config.statuses;
  }

  async updateStatuses(statuses: StoredStatus[]): Promise<void> {
    this.assertReady();
    for (const type of ["task", "template", "project"] as const) {
      const path = typeResourcePath(type);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new MdbaseRepositoryError("type_missing", `Missing ${path}`);
      const parsed = parseDocument(await this.app.vault.read(file));
      const schema = parsed.frontmatter.schema as Record<string, unknown>;
      const value = schema.value as Record<string, unknown>;
      const properties = value.properties as Record<string, unknown>;
      properties[type === "project" ? "workflow_status" : "status"] = { enum: statuses.map((status) => status.id) };
      const extension = (parsed.frontmatter["x-vibetask"] as Record<string, unknown> | undefined) ?? {};
      extension.statuses = statuses.map((status) => ({ ...status }));
      parsed.frontmatter["x-vibetask"] = extension;
      await this.app.vault.modify(file, serializeDocument(parsed.frontmatter, parsed.body));
      this.typeDocuments.set(type, parsed.frontmatter);
    }
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addFormat("date", (value: string) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
    ajv.addFormat("date-time", (value: string) => DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)));
    for (const type of RECORD_TYPES) {
      const schema = (this.typeDocuments.get(type)?.schema as Record<string, unknown> | undefined)?.value;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) this.validators.set(type, ajv.compile(schema));
    }
  }

  async updatePath(type: RecordType, folder: string): Promise<void> {
    this.assertReady();
    const normalizedFolder = normalizePath(folder);
    if (!normalizedFolder.startsWith(`${MDBASE_COLLECTION_ROOT}/`)) {
      throw new MdbaseRepositoryError("path_outside_collection", `Record folders must be inside ${MDBASE_COLLECTION_ROOT}`);
    }
    const relativeFolder = normalizedFolder.slice(MDBASE_COLLECTION_ROOT.length + 1);
    const types: RecordType[] = type === "project" || type === "area" ? ["project", "area"] : [type];
    for (const current of types) {
      const path = typeResourcePath(current);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new MdbaseRepositoryError("type_missing", `Missing ${path}`);
      const parsed = parseDocument(await this.app.vault.read(file));
      const collection = parsed.frontmatter.collection as Record<string, unknown>;
      const suffix = current === "template" ? "/{title}/{title}.md" : "/{title}.md";
      collection.path = { pattern: `${relativeFolder}${suffix}` };
      await this.app.vault.modify(file, serializeDocument(parsed.frontmatter, parsed.body));
      this.typeDocuments.set(current, parsed.frontmatter);
    }
  }

  private assertReady(): void {
    if (!this.initResult.ready) throw new MdbaseRepositoryError("collection_not_ready", "VibeTask's mdbase collection is not ready", this.initResult.issues);
  }

  async read(path: string): Promise<CollectionRecord | null> {
    const normalizedPath = normalizePath(path);
    if (!isCollectionPath(normalizedPath)) return null;
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(file instanceof TFile)) return null;
    const parsed = parseDocument(await this.app.vault.read(file));
    if (!isRecordType(parsed.frontmatter.type)) return null;
    return {
      path: file.path,
      type: parsed.frontmatter.type,
      id: typeof parsed.frontmatter.id === "string" ? parsed.frontmatter.id : "",
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      revision: revisionOf(file),
    };
  }

  async list(type: RecordType): Promise<CollectionRecord[]> {
    const records = await Promise.all(this.app.vault.getMarkdownFiles().filter((file) => isCollectionPath(file.path)).map((file) => this.read(file.path)));
    return records.filter((record): record is CollectionRecord => record?.type === type);
  }

  validate(record: Pick<CollectionRecord, "path" | "type" | "frontmatter">): ValidationIssue[] {
    const validator = this.validators.get(record.type);
    if (!validator) return [{ path: record.path, type: record.type, severity: "error", code: "schema.missing", message: `No schema loaded for ${record.type}` }];
    const issues = validator(record.frontmatter) ? [] : errorsToIssues(record.path, record.type, validator.errors);
    return [...issues, ...this.validateHierarchy(record)];
  }

  private validateHierarchy(record: Pick<CollectionRecord, "path" | "type" | "frontmatter">): ValidationIssue[] {
    if (record.type === "area" && record.frontmatter.area !== undefined) {
      return [{ path: record.path, type: record.type, severity: "error", code: "hierarchy.area_parent", field: "area", message: "Areas cannot belong to another area or project" }];
    }
    const links: Array<{ field: string; targets: RecordType[] }> = record.type === "task"
      ? [{ field: "project", targets: ["project", "area"] }, { field: "parent", targets: ["task"] }]
      : record.type === "project" ? [{ field: "area", targets: ["area"] }] : [];
    const out: ValidationIssue[] = [];
    for (const link of links) {
      const value = record.frontmatter[link.field];
      if (value === undefined) continue;
      const raw = typeof value === "string" ? value.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/)?.[1] : undefined;
      const wanted = raw?.replace(/\.md$/i, "").split("/").pop()?.toLowerCase();
      const target = wanted ? this.app.vault.getMarkdownFiles().find((file) => isCollectionPath(file.path) && file.basename.toLowerCase() === wanted) : undefined;
      const cache = target ? this.app.metadataCache.getFileCache(target) : null;
      const targetType: unknown = cache?.frontmatter?.type;
      if (!target || !link.targets.includes(targetType as RecordType)) {
        out.push({ path: record.path, type: record.type, severity: "warn", code: "link.unresolved", field: link.field, message: `${link.field} must link to ${link.targets.join(" or ")}` });
      }
    }
    return out;
  }

  async create(input: CreateRecordInput): Promise<TFile> {
    this.assertReady();
    const path = normalizePath(input.path);
    if (!isCollectionPath(path)) throw new MdbaseRepositoryError("path_outside_collection", `Records must be inside ${MDBASE_COLLECTION_ROOT}`);
    if (this.app.vault.getAbstractFileByPath(path)) throw new MdbaseRepositoryError("path_exists", `A file already exists at ${path}`);
    const now = rfc3339Now();
    const frontmatter = cleanRecord({ ...input.frontmatter, type: input.type });
    if (typeof frontmatter.id !== "string" || !frontmatter.id) frontmatter.id = newUlid();
    if (typeof frontmatter.created !== "string" || !frontmatter.created) frontmatter.created = now;
    frontmatter.modified = now;
    const issues = this.validate({ path, type: input.type, frontmatter });
    if (issues.some((issue) => issue.severity === "error")) throw new MdbaseRepositoryError("validation_failed", `Invalid ${input.type} record`, issues);
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(path.slice(0, slash));
    return this.app.vault.create(path, serializeDocument(frontmatter, input.body ?? ""));
  }

  /** Add canonical VibeTask metadata to an existing Markdown file without touching its body. */
  async adopt(path: string, type: RecordType, patch: Record<string, unknown>): Promise<CollectionRecord> {
    this.assertReady();
    const normalizedPath = normalizePath(path);
    if (!isCollectionPath(normalizedPath)) throw new MdbaseRepositoryError("path_outside_collection", `Records must be inside ${MDBASE_COLLECTION_ROOT}`);
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(file instanceof TFile)) throw new MdbaseRepositoryError("record_not_found", `No file at ${path}`);
    const parsed = parseDocument(await this.app.vault.read(file));
    const now = rfc3339Now();
    const candidate = cleanRecord({ ...parsed.frontmatter, ...patch, type });
    if (typeof candidate.id !== "string" || !candidate.id) candidate.id = newUlid();
    if (typeof candidate.created !== "string" || !candidate.created) candidate.created = now;
    candidate.modified = now;
    const issues = this.validate({ path: file.path, type, frontmatter: candidate });
    if (issues.some((issue) => issue.severity === "error")) throw new MdbaseRepositoryError("validation_failed", `Invalid ${type} record`, issues);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => Object.assign(frontmatter, candidate));
    return (await this.read(file.path))!;
  }

  async update(path: string, patch: Record<string, unknown>, options: UpdateRecordOptions = {}): Promise<CollectionRecord> {
    return this.mutate(path, (frontmatter) => cleanPatch(frontmatter, patch), options);
  }

  async mutate(path: string, change: (frontmatter: Record<string, unknown>) => void, options: UpdateRecordOptions = {}): Promise<CollectionRecord> {
    this.assertReady();
    const before = await this.read(path);
    if (!before) throw new MdbaseRepositoryError("record_not_found", `No VibeTask record at ${path}`);
    if (options.ifRevision && before.revision !== options.ifRevision) throw new MdbaseRepositoryError("revision_conflict", `${path} changed since it was read`);
    const candidate = { ...before.frontmatter };
    change(candidate);
    candidate.modified = rfc3339Now();
    const type = isRecordType(candidate.type) ? candidate.type : before.type;
    const issues = this.validate({ path: before.path, type, frontmatter: candidate });
    if (issues.some((issue) => issue.severity === "error")) throw new MdbaseRepositoryError("validation_failed", `Invalid ${type} record`, issues);
    const file = this.app.vault.getAbstractFileByPath(before.path);
    if (!(file instanceof TFile)) throw new MdbaseRepositoryError("record_not_found", `No file at ${before.path}`);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      for (const key of Object.keys(frontmatter)) if (!(key in candidate)) delete frontmatter[key];
      Object.assign(frontmatter, candidate);
    });
    return (await this.read(before.path))!;
  }

  async rename(from: string, to: string, title?: string): Promise<CollectionRecord> {
    this.assertReady();
    const sourcePath = normalizePath(from);
    if (!isCollectionPath(sourcePath)) throw new MdbaseRepositoryError("path_outside_collection", `Records must be inside ${MDBASE_COLLECTION_ROOT}`);
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) throw new MdbaseRepositoryError("record_not_found", `No file at ${from}`);
    const target = normalizePath(to);
    if (!isCollectionPath(target)) throw new MdbaseRepositoryError("path_outside_collection", `Records must stay inside ${MDBASE_COLLECTION_ROOT}`);
    if (target !== source.path && this.app.vault.getAbstractFileByPath(target)) throw new MdbaseRepositoryError("path_exists", `A file already exists at ${target}`);
    await this.app.fileManager.renameFile(source, target);
    if (title) return this.update(target, { title });
    const record = await this.read(target);
    if (!record) throw new MdbaseRepositoryError("record_not_found", `Renamed record missing at ${target}`);
    return record;
  }

  async trash(path: string): Promise<void> {
    this.assertReady();
    const normalizedPath = normalizePath(path);
    if (!isCollectionPath(normalizedPath)) throw new MdbaseRepositoryError("path_outside_collection", `Records must be inside ${MDBASE_COLLECTION_ROOT}`);
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  issues(path?: string): ValidationIssue[] {
    if (path) return [...(this.issueMap.get(path) ?? [])];
    return [...this.issueMap.values()].flat();
  }

  async scanIssues(): Promise<ValidationIssue[]> {
    this.issueMap.clear();
    for (const file of this.app.vault.getMarkdownFiles()) if (isCollectionPath(file.path)) await this.refreshIssues(file);
    return this.issues();
  }

  private emit(): void {
    for (const listener of this.subscribers) listener();
  }

  private async refreshIssues(file: TFile): Promise<void> {
    const record = await this.read(file.path);
    if (!record) { this.issueMap.delete(file.path); return; }
    this.issueMap.set(file.path, this.validate(record));
  }
}

const REPOSITORIES = new WeakMap<App, MdbaseRepository>();

export function bindRepository(app: App, repository: MdbaseRepository): void {
  REPOSITORIES.set(app, repository);
}

export function repositoryFor(app: App): MdbaseRepository {
  const repository = REPOSITORIES.get(app);
  if (!repository) throw new MdbaseRepositoryError("repository_unbound", "VibeTask repository is not initialized");
  return repository;
}

export function updateRecord(app: App, fileOrPath: TFile | string, change: (frontmatter: Record<string, unknown>) => void): Promise<CollectionRecord> {
  return repositoryFor(app).mutate(typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path, change);
}
