import { describe, expect, it } from "vitest";
import { TFile, parseYaml, stringifyYaml } from "obsidian";
import { MdbaseRepository, MdbaseRepositoryError } from "../src/mdbaseRepository";

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
  it("initializes idempotently and performs lossless, revision-checked CRUD", async () => {
    const fake = fakeApp();
    const repository = new MdbaseRepository(fake.app);
    const first = await repository.initialize();
    expect(first.ready).toBe(true);
    expect(first.created).toHaveLength(6);
    expect((await repository.initialize()).created).toEqual([]);

    await repository.create({
      type: "task", path: "_vibetasks/tasks/One.md", body: "User markdown\n",
      frontmatter: { title: "One", status: "todo", custom: { keep: true } },
    });
    const before = await repository.read("_vibetasks/tasks/One.md");
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

    await repository.rename(after!.path, "_vibetasks/tasks/Renamed.md");
    expect(await repository.read("_vibetasks/tasks/Renamed.md")).not.toBeNull();
    await repository.trash("_vibetasks/tasks/Renamed.md");
    expect(await repository.read("_vibetasks/tasks/Renamed.md")).toBeNull();
  });

  it("blocks incompatible type definitions without overwriting them", async () => {
    const fake = fakeApp();
    await fake.vault.createFolder("_vibetasks");
    fake.put("_vibetasks/mdbase.yaml", 'spec_version: "0.3.0"\nsettings: {"types_folder":"_types","validation":"warn","explicit_type_keys":["type"],"include_subfolders":true}\n');
    await fake.vault.createFolder("_vibetasks/_types");
    fake.put("_vibetasks/_types/task.md", "---\nkind: \"mdbase.type\"\nname: \"task\"\nschema: {\"dialect\":\"json-schema-2020-12\",\"value\":{\"type\":\"object\"}}\n---\nmanual body\n");
    const original = fake.contents.get("_vibetasks/_types/task.md");
    const repository = new MdbaseRepository(fake.app);
    const result = await repository.initialize();
    expect(result.ready).toBe(false);
    expect(result.issues.some((issue) => issue.code === "type.canonical_fields")).toBe(true);
    expect(fake.contents.get("_vibetasks/_types/task.md")).toBe(original);
    await expect(repository.create({ type: "task", path: "x.md", frontmatter: { title: "x", status: "todo" } }))
      .rejects.toBeInstanceOf(MdbaseRepositoryError);
  });

  it("reports initialization failures instead of taking down the plugin", async () => {
    const fake = fakeApp();
    await fake.vault.createFolder("_vibetasks");
    fake.put("_vibetasks/mdbase.yaml", 'spec_version: "0.3.0"\n');
    const read = fake.vault.read;
    fake.vault.read = async (file: FakeFile) => {
      if (file.path === "_vibetasks/mdbase.yaml") throw new Error("Cannot read collection config");
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
      if (path === "_vibetasks") throw new Error("Folder already exists.");
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

  it("treats notes outside _vibetasks as unrelated to the collection", async () => {
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
      type: "area", path: "_vibetasks/projects/Nested.md",
      frontmatter: { title: "Nested", status: "active", area: "[[Other]]" },
    })).rejects.toMatchObject({ code: "validation_failed" });
  });
});
