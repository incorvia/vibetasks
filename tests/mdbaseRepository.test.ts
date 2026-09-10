import { describe, expect, it } from "vitest";
import { TFile, parseYaml, stringifyYaml } from "obsidian";
import { bindRepository, MdbaseRepository, MdbaseRepositoryError, upgradedAllDayScheduleTypeDocument } from "../src/mdbaseRepository";
import { TimeStore, timeLogPath } from "../src/timeService";
import { createTaskNote } from "../src/taskService";
import type { OpalTasksSettings } from "../src/types";

type FakeFile = TFile & { path: string; basename: string; extension: string; stat: { mtime: number; size: number } };

function fakeApp() {
  const contents = new Map<string, string>();
  const files = new Map<string, FakeFile>();
  const folders = new Set<string>();
  let clock = 1;
  const put = (path: string, content: string): FakeFile => {
    let file = files.get(path);
    if (!file) {
      file = Object.assign(new TFile(), {
        path, basename: path.split("/").pop()!.replace(/\.md$/, ""), extension: path.split(".").pop() ?? "",
        stat: { mtime: clock++, size: content.length },
      }) as FakeFile;
      files.set(path, file);
    }
    contents.set(path, content);
    file.stat = { mtime: clock++, size: content.length };
    return file;
  };
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
    createFolder: async (path: string) => { folders.add(path); files.set(path, { path } as FakeFile); },
    create: async (path: string, content: string) => put(path, content),
    read: async (file: FakeFile) => contents.get(file.path)!,
    modify: async (file: FakeFile, content: string) => { put(file.path, content); },
    on: () => ({}),
    adapter: {
      stat: async (path: string) => folders.has(path) ? { type: "folder" } : files.has(path) ? { type: "file" } : null,
      read: async (path: string) => contents.get(path)!,
    },
  };
  const document = (content: string) => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
    return { frontmatter: (match ? parseYaml(match[1]) : {}) as Record<string, unknown>, body: match ? content.slice(match[0].length) : content };
  };
  const fileManager = {
    processFrontMatter: async (file: FakeFile, change: (fm: Record<string, unknown>) => void) => {
      const parsed = document(contents.get(file.path)!);
      change(parsed.frontmatter);
      put(file.path, `---\n${stringifyYaml(parsed.frontmatter)}---\n${parsed.body}`);
    },
    renameFile: async (file: FakeFile, target: string) => {
      const content = contents.get(file.path)!;
      contents.delete(file.path); files.delete(file.path);
      put(target, content);
    },
    trashFile: async (file: FakeFile) => { contents.delete(file.path); files.delete(file.path); },
  };
  return { app: { vault, fileManager, metadataCache: { on: () => ({}), getFileCache: () => null } } as never, vault, contents, files, put };
}

describe("MdbaseRepository", () => {
  it("moves edited work to the correct daily log while preserving identity and snapshots", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize(); bindRepository(fake.app, repository);
    const store = new TimeStore(fake.app);
    const session = { id: "s1", task_id: "t1", task_title_snapshot: "Original title", device_id: "d1", block_id: "b1",
      project_id_snapshot: "p1", started_at: "2026-01-06T10:00:00Z", ended_at: "2026-01-06T10:30:00Z", elapsed: 1800 };
    await store.addSession(session);
    await store.addSession({ ...session, id: "s2" });
    await store.updateSession("s1", { started_at: "2026-01-07T11:00:00Z", ended_at: "2026-01-07T12:00:00Z", elapsed: 3600 });
    expect(store.session("s1")).toMatchObject({ ...session, started_at: "2026-01-07T11:00:00Z", ended_at: "2026-01-07T12:00:00Z", elapsed: 3600 });
    expect(store.logs().find((log) => log.date === "2026-01-06")?.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(store.sessionsFor("project", "p1")).toHaveLength(2);
    expect((await repository.read(timeLogPath("2026-01-07")))?.frontmatter.sessions).toEqual([store.session("s1")]);
    await store.updateSession("s1", { started_at: "2026-01-07T11:00:00Z", ended_at: "2026-01-07T11:15:00Z", elapsed: 900 });
    expect(store.sessions()).toHaveLength(2);
    expect(store.totals("2026-01-07", "2026-01-07").actual).toBe(15);
  });

  it("retains the original time record if writing a new date fails", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize(); bindRepository(fake.app, repository);
    const store = new TimeStore(fake.app);
    const session = { id: "s1", task_id: "t1", task_title_snapshot: "Draft", device_id: "d1",
      started_at: "2026-01-06T10:00:00Z", ended_at: "2026-01-06T10:30:00Z", elapsed: 1800 };
    await store.addSession(session);
    fake.vault.create = async () => { throw new Error("Disk unavailable"); };
    await expect(store.updateSession("s1", { started_at: "2026-01-07T11:00:00Z", ended_at: "2026-01-07T12:00:00Z", elapsed: 3600 })).rejects.toThrow("Disk unavailable");
    expect(store.session("s1")).toEqual(session);
    expect((await repository.read(timeLogPath("2026-01-06")))?.frontmatter.sessions).toEqual([session]);
  });

  it("keeps a preallocated task identity for create-and-schedule workflows", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize(); bindRepository(fake.app, repository);

    const id = "01K4Y6J7M8N9P0Q1R2S3T4V5W6";
    const file = await createTaskNote(fake.app, { itemsFolder: "_opal_tasks/tasks" } as OpalTasksSettings, { id, title: "Scheduled on creation" });

    expect((await repository.read(file.path))?.id).toBe(id);
  });

  it("makes a newly dragged time block visible without waiting for metadataCache", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize(); bindRepository(fake.app, repository);
    const store = new TimeStore(fake.app);
    const block = await store.addBlock({
      start: "2026-09-06T14:30:00-05:00", duration: 45,
      kind: "task_schedule",
      scope: { type: "task", id: "task-1", title_snapshot: "Dragged task" },
      mode: "focus", selector: "manual", source: "drag",
    });
    expect(store.block(block.id)).toMatchObject({ start: "2026-09-06T14:30:00-05:00", duration: 45 });
    expect(store.blocksIn("2026-09-06", "2026-09-06")).toHaveLength(1);
  });

  it("persists a date-only task schedule without start or duration", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize(); bindRepository(fake.app, repository);
    const store = new TimeStore(fake.app);
    const block = await store.addBlock({
      allDay: true, date: "2026-09-08", kind: "task_schedule",
      scope: { type: "task", id: "task-1", title_snapshot: "Write report" },
      mode: "focus", selector: "manual", source: "manual",
    });

    expect(store.block(block.id)).toMatchObject({ allDay: true, date: "2026-09-08" });
    expect(store.block(block.id)).not.toHaveProperty("start");
    expect(store.block(block.id)).not.toHaveProperty("duration");
    expect(store.blocksIn("2026-09-08", "2026-09-08")).toHaveLength(1);
  });

  it("upgrades an existing time-log schema without discarding custom block fields", () => {
    const original = `---\n${stringifyYaml({
      kind: "mdbase.type", name: "time_log", version: 2,
      schema: { dialect: "json-schema-2020-12", value: { type: "object", properties: {
        blocks: { type: "array", items: { type: "object", required: ["id", "start", "duration"], properties: {
          id: { type: "string" }, custom: { type: "string" },
        } } },
      } } },
    })}---\nnotes\n`;
    const upgraded = upgradedAllDayScheduleTypeDocument(original);
    const yaml = upgraded.match(/^---\n([\s\S]*?)\n---/)![1];
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    const schema = parsed.schema as { value: { properties: { blocks: { items: { required: string[]; properties: Record<string, unknown> } } } } };
    const items = schema.value.properties.blocks.items;

    expect(parsed.version).toBe(3);
    expect(items.properties).toHaveProperty("custom");
    expect(items.properties).toHaveProperty("allDay");
    expect(items.properties).toHaveProperty("date");
    expect(items.required).toEqual(["id"]);
    expect(upgradedAllDayScheduleTypeDocument(upgraded)).toBe(upgraded);
  });

  it("initializes idempotently and performs lossless, revision-checked CRUD", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    const first = await repository.initialize();
    expect(first.ready).toBe(true);
    expect(first.created).toHaveLength(8);
    expect((await repository.initialize()).created).toEqual([]);

    await repository.create({
      type: "task", path: "_opal_tasks/tasks/One.md", body: "User markdown\n",
      frontmatter: { title: "One", status: "todo", custom: { keep: true } },
    });
    const before = await repository.read("_opal_tasks/tasks/One.md");
    expect(before?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await repository.update(before!.path, { priority: "high" }, { ifRevision: before!.revision });
    const after = await repository.read(before!.path);
    expect(after?.frontmatter.custom).toEqual({ keep: true });
    expect(after?.body).toBe("User markdown\n");
    await expect(repository.update(after!.path, { priority: "low" }, { ifRevision: before!.revision }))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await expect(repository.update(after!.path, { title: "" }))
      .rejects.toMatchObject({ code: "validation_failed" });

    await repository.update(after!.path, { project: "[[Missing]]" });
    expect((await repository.scanIssues()).some((issue) => issue.code === "link.unresolved" && issue.severity === "warn")).toBe(true);
    const external = fake.contents.get(after!.path)!.replace('title: "One"', 'title: ""');
    fake.put(after!.path, external);
    expect((await repository.scanIssues()).some((issue) => issue.code === "schema.minLength")).toBe(true);
    expect(fake.contents.get(after!.path)).toBe(external);

    await repository.rename(after!.path, "_opal_tasks/tasks/Renamed.md");
    expect(await repository.read("_opal_tasks/tasks/Renamed.md")).not.toBeNull();
    await repository.trash("_opal_tasks/tasks/Renamed.md");
    expect(await repository.read("_opal_tasks/tasks/Renamed.md")).toBeNull();
  });

  it("blocks incompatible type definitions without overwriting them", async () => {
    const fake = fakeApp();
    await fake.vault.createFolder("_opal_tasks");
    fake.put("_opal_tasks/mdbase.yaml", 'spec_version: "0.3.0"\nsettings: {"types_folder":"_types","validation":"warn","explicit_type_keys":["type"],"include_subfolders":true}\n');
    await fake.vault.createFolder("_opal_tasks/_types");
    fake.put("_opal_tasks/_types/task.md", "---\nkind: \"mdbase.type\"\nname: \"task\"\nschema: {\"dialect\":\"json-schema-2020-12\",\"value\":{\"type\":\"object\"}}\n---\nmanual body\n");
    const original = fake.contents.get("_opal_tasks/_types/task.md");
    const repository = new MdbaseRepository(fake.app);
    const result = await repository.initialize();
    expect(result.ready).toBe(false);
    expect(result.issues.some((issue) => issue.code === "type.canonical_fields")).toBe(true);
    expect(fake.contents.get("_opal_tasks/_types/task.md")).toBe(original);
    await expect(repository.create({ type: "task", path: "x.md", frontmatter: { title: "x", status: "todo" } }))
      .rejects.toBeInstanceOf(MdbaseRepositoryError);
  });

  it("reports initialization failures instead of taking down the plugin", async () => {
    const fake = fakeApp();
    await fake.vault.createFolder("_opal_tasks");
    fake.put("_opal_tasks/mdbase.yaml", 'spec_version: "0.3.0"\n');
    const read = fake.vault.read;
    fake.vault.read = async (file: FakeFile) => {
      if (file.path === "_opal_tasks/mdbase.yaml") throw new Error("Cannot read collection config");
      return read(file);
    };

    const repository = new MdbaseRepository(fake.app);
    const result = await repository.initialize();

    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "collection.initialize",
      message: "Cannot read collection config",
    }));
  });

  it("tolerates Obsidian's folder-already-exists startup race", async () => {
    const fake = fakeApp();
    const createFolder = fake.vault.createFolder;
    fake.vault.createFolder = async (path: string) => {
      if (path === "_opal_tasks") throw new Error("Folder already exists.");
      await createFolder(path);
    };

    const result = await new MdbaseRepository(fake.app).initialize();

    expect(result.ready).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("reads existing collection files when Obsidian's index is still cold", async () => {
    const fake = fakeApp();
    await new MdbaseRepository(fake.app).initialize();
    const lookup = fake.vault.getAbstractFileByPath;
    fake.vault.getAbstractFileByPath = (path: string) => path.endsWith(".md") || path.endsWith(".yaml") ? null : lookup(path);

    const result = await new MdbaseRepository(fake.app).initialize();

    expect(result.ready).toBe(true);
    expect(result.created).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("treats notes outside _opal_tasks as unrelated to the collection", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize();
    fake.put("Notes/Someone else's project.md", `---\ntype: project\nid: external\ntitle: Someone else's project\nstatus: active\ncreated: 2026-09-05T12:00:00Z\nmodified: 2026-09-05T12:00:00Z\n---\n`);

    expect(await repository.read("Notes/Someone else's project.md")).toBeNull();
    expect(await repository.list("project")).toEqual([]);
    expect(await repository.scanIssues()).toEqual([]);
    await expect(repository.create({
      type: "project",
      path: "Notes/New project.md",
      frontmatter: { title: "New project", status: "active" },
    })).rejects.toMatchObject({ code: "path_outside_collection" });
  });

  it("enforces the Things-style hierarchy", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    await repository.initialize();
    await expect(repository.create({
      type: "area", path: "_opal_tasks/projects/Nested.md",
      frontmatter: { title: "Nested", status: "active", area: "[[Other]]" },
    })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
