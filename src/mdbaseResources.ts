import { stringifyYaml } from "obsidian";
import type { StoredStatus } from "./types";

export const MDBASE_SPEC_VERSION = "0.3.0";
export const MDBASE_COLLECTION_ROOT = "_opal_tasks";
export const MDBASE_TYPES_FOLDER = "_types";
export const RECORD_TYPES = ["task", "project", "area", "filter", "template", "time_log", "timer_state"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const DEFAULT_MDBASE_STATUSES: StoredStatus[] = [
  { id: "todo", labelKey: "status_todo", kind: "open", icon: "circle" },
  { id: "doing", labelKey: "status_doing", kind: "open", icon: "contrast" },
  { id: "done", labelKey: "status_done", kind: "done", icon: "check-circle" },
  { id: "cancelled", labelKey: "status_cancelled", kind: "cancelled", icon: "x-circle" },
];

export const DEFAULT_PRIORITIES = ["highest", "high", "medium", "normal", "low", "lowest"] as const;

type Schema = Record<string, unknown>;

const dateOrDateTime: Schema = {
  anyOf: [
    { type: "string", format: "date" },
    { type: "string", format: "date-time" },
    { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?$" },
  ],
};

const common = (type: RecordType): Schema => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
  required: ["type", "id", "title", "created", "modified"],
  properties: {
    type: { const: type },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    created: { type: "string", format: "date-time" },
    modified: { type: "string", format: "date-time" },
    description: { type: "string" },
    color: { type: "string" },
    nav_hidden: { type: "boolean" },
  },
});

function extend(base: Schema, properties: Record<string, unknown>, required: string[] = []): Schema {
  const original = base.properties as Record<string, unknown>;
  return {
    ...base,
    required: [...(base.required as string[]), ...required],
    properties: { ...original, ...properties },
  };
}

export const DEFAULT_SCHEMAS: Record<RecordType, Schema> = {
  task: extend(common("task"), {
    status: { enum: DEFAULT_MDBASE_STATUSES.map((s) => s.id) },
    priority: { enum: [...DEFAULT_PRIORITIES] },
    due: dateOrDateTime,
    estimate: { type: "integer", minimum: 1 },
    opal_project_id: { type: "string", minLength: 1 },
    opal_parent_id: { type: "string", minLength: 1 },
    labels: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    recurrence: { type: "string", minLength: 1 },
    recur_basis: { enum: ["due", "done"] },
    reminders: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    sort_order: { type: "number" },
    completed: { type: "string", format: "date-time" },
    cancelled: { type: "string", format: "date-time" },
    external_id: { type: "string" },
    gcal_event_id: { type: "string" },
    gcal_calendar_id: { type: "string" },
  }, ["status"]),
  project: extend(common("project"), {
    status: { enum: ["active", "archived"] },
    workflow_status: { enum: DEFAULT_MDBASE_STATUSES.map((s) => s.id) },
    completed: { type: "string", format: "date-time" },
    priority: { enum: [...DEFAULT_PRIORITIES] },
    priority_swimlanes: { type: "boolean" },
    icon: { type: "string" },
    opal_area_id: { type: "string", minLength: 1 },
    gcal_sync: { type: "boolean" },
  }, ["status"]),
  area: extend(common("area"), {
    status: { enum: ["active", "archived"] },
    priority_swimlanes: { type: "boolean" },
    gcal_sync: { type: "boolean" },
  }, ["status"]),
  filter: extend(common("filter"), {
    layout: { enum: ["list", "board", "calendar"] },
    sort: { type: "string" },
    group: { type: "string" },
    showDone: { type: "boolean" },
    subtasks: { enum: ["compact", "indented", "standalone"] },
    sortDir: { enum: ["asc", "desc"] },
    calMode: { enum: ["year", "month", "week", "3day", "day"] },
    calPanel: { type: "boolean" },
    range: { type: "string" },
    deadline_range: { type: "string" },
    statuses: { type: "array", items: { type: "string" } },
    statuses_not: { type: "array", items: { type: "string" } },
    priorities: { type: "array", items: { type: "string" } },
    priorities_not: { type: "array", items: { type: "string" } },
    labels: { type: "array", items: { type: "string" } },
    labels_all: { type: "array", items: { type: "string" } },
    labels_not: { type: "array", items: { type: "string" } },
    opal_project_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    opal_project_ids_not: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    opal_include_inbox: { type: "boolean" },
    opal_exclude_inbox: { type: "boolean" },
    subtask_mode: { type: "string" },
    search: { type: "string" },
  }),
  template: extend(common("template"), {
    template_of: { enum: ["task", "project"] },
    status: { enum: DEFAULT_MDBASE_STATUSES.map((s) => s.id) },
    priority: { enum: [...DEFAULT_PRIORITIES] },
    due: dateOrDateTime,
    estimate: { type: "integer", minimum: 1 },
    opal_project_id: { type: "string", minLength: 1 },
    opal_parent_id: { type: "string", minLength: 1 },
    labels: { type: "array", items: { type: "string", minLength: 1 } },
    recurrence: { type: "string" },
    recur_basis: { enum: ["due", "done"] },
    reminders: { type: "array", items: { type: "string" } },
    sort_order: { type: "number" },
    completed: { type: "string", format: "date-time" },
    cancelled: { type: "string", format: "date-time" },
    external_id: { type: "string" },
    gcal_event_id: { type: "string" },
    gcal_calendar_id: { type: "string" },
  }, ["status", "template_of"]),
  time_log: extend(common("time_log"), {
    date: { type: "string", format: "date" },
    blocks: {
      type: "array", items: { type: "object", additionalProperties: true,
        required: ["id", "start", "duration", "scope", "mode", "selector", "status", "source"],
        properties: {
          id: { type: "string", minLength: 1 }, start: { type: "string", format: "date-time" },
          duration: { type: "integer", minimum: 1 },
          kind: { enum: ["task_schedule", "allocation"] },
          scope: { type: "object", additionalProperties: false, required: ["type", "id", "title_snapshot"], properties: {
            type: { enum: ["task", "project", "area"] }, id: { type: "string", minLength: 1 }, title_snapshot: { type: "string" },
          } },
          mode: { enum: ["focus", "blitz"] }, selector: { enum: ["manual", "next", "ai"] },
          status: { enum: ["planned", "completed", "cancelled"] }, source: { enum: ["manual", "drag", "ai", "import"] },
          gcal_event_id: { type: "string" }, gcal_calendar_id: { type: "string" },
        } },
    },
    sessions: {
      type: "array", items: { type: "object", additionalProperties: true,
        required: ["id", "task_id", "task_title_snapshot", "started_at", "device_id"],
        properties: {
          id: { type: "string", minLength: 1 }, task_id: { type: "string", minLength: 1 }, task_title_snapshot: { type: "string" },
          block_id: { type: "string" }, started_at: { type: "string", format: "date-time" }, ended_at: { type: "string", format: "date-time" },
          elapsed: { type: "integer", minimum: 0 }, device_id: { type: "string", minLength: 1 },
          project_id_snapshot: { type: "string" }, project_title_snapshot: { type: "string" }, area_id_snapshot: { type: "string" }, area_title_snapshot: { type: "string" },
        } },
    },
  }, ["date", "blocks", "sessions"]),
  timer_state: extend(common("timer_state"), {
    active: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: true,
      required: ["session_id", "log_date", "task_id", "device_id", "started_at"],
      properties: { session_id: { type: "string" }, log_date: { type: "string", format: "date" }, task_id: { type: "string" }, block_id: { type: "string" }, device_id: { type: "string" }, started_at: { type: "string", format: "date-time" } },
    }] },
  }),
};

export const DEFAULT_PATHS: Record<RecordType, string> = {
  task: "tasks/{title}.md",
  project: "projects/{title}.md",
  area: "projects/{title}.md",
  filter: "filters/{title}.md",
  template: "templates/{title}/{title}.md",
  time_log: "time/{year}/{date}.md",
  timer_state: "time/active.md",
};

export function collectionPath(relativePath: string): string {
  return `${MDBASE_COLLECTION_ROOT}/${relativePath}`;
}

export function isCollectionPath(path: string): boolean {
  return path === MDBASE_COLLECTION_ROOT || path.startsWith(`${MDBASE_COLLECTION_ROOT}/`);
}

export function mdbaseConfigDocument(): string {
  return stringifyYaml({
    spec_version: MDBASE_SPEC_VERSION,
    name: "Opal Tasks",
    description: "Local-first task and project collection managed by Opal Tasks",
    settings: {
      types_folder: MDBASE_TYPES_FOLDER,
      validation: "warn",
      explicit_type_keys: ["type"],
      include_subfolders: true,
      id_field: "id",
    },
  });
}

export function typeDocument(type: RecordType): string {
  const links: Record<string, unknown> = {};
  if (type === "task" || type === "template") {
    links.opal_project_id = { target_type: ["project", "area"], validate_exists: true, format: "any" };
    links.opal_parent_id = { target_type: type === "template" ? "template" : "task", validate_exists: true, format: "any" };
  } else if (type === "project") {
    links.opal_area_id = { target_type: "area", validate_exists: true, format: "any" };
  }
  const extension = type === "task" || type === "template" || type === "project" ? {
    statuses: DEFAULT_MDBASE_STATUSES,
    priorities: [...DEFAULT_PRIORITIES],
  } : {};
  const frontmatter = {
    kind: "mdbase.type",
    name: type,
    version: 2,
    description: `Opal Tasks ${type} record`,
    match: { where: { type } },
    schema: { dialect: "json-schema-2020-12", value: DEFAULT_SCHEMAS[type] },
    collection: {
      display: { name_field: "title", description_field: "description", color_field: "color" },
      ...(type === "task" || type === "template" ? { read_defaults: { status: "todo", priority: "normal" } }
        : type === "project" ? { read_defaults: { workflow_status: "todo", priority: "normal" } } : {}),
      ...(Object.keys(links).length ? { links } : {}),
      path: { pattern: DEFAULT_PATHS[type] },
      unique: [{ field: "id", scope: "collection" }],
    },
    lifecycle: {
      on_create: { set: { id: { ulid: true }, created: { now: true }, modified: { now: true } } },
      on_update: { set: { modified: { now: true } } },
    },
    "x-opal_tasks": extension,
  };
  return `---\n${stringifyYaml(frontmatter)}---\n`;
}

export function typeResourcePath(type: RecordType): string {
  return collectionPath(`${MDBASE_TYPES_FOLDER}/${type}.md`);
}

export function isRecordType(value: unknown): value is RecordType {
  return typeof value === "string" && (RECORD_TYPES as readonly string[]).includes(value);
}
