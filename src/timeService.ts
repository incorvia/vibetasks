import { App, Component, TFile, normalizePath } from "obsidian";
import { MdbaseRepository, repositoryFor, rfc3339Now, newUlid, updateRecord } from "./mdbaseRepository";
import { collectionPath } from "./mdbaseResources";
import { isAllDaySchedule, type NewTimeBlock, type Task, type TimeBlock, type TimeBlockPatch, type TimeLog, type TimeScope, type WorkSession } from "./types";
import { isDone, isTrashed } from "./statuses";

const localDate = (value: Date | string): string => {
  const d = typeof value === "string" ? new Date(value) : value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const asArray = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
export const blockKind = (block: TimeBlock): TimeBlock["kind"] => {
  const legacy: { kind?: TimeBlock["kind"] } = block;
  return legacy.kind ?? (block.source === "drag" && block.scope.type === "task" ? "task_schedule" : "allocation");
};
type MutableBlockShape = TimeBlock & { allDay?: boolean; date?: string; start?: string; duration?: number };
const normalizeBlock = (block: TimeBlock): TimeBlock => {
  const value = { ...block, kind: blockKind(block) } as MutableBlockShape;
  if (isAllDaySchedule(value)) { delete value.start; delete value.duration; }
  else { delete value.date; delete value.allDay; }
  return value;
};
export const timeBlockDate = (block: TimeBlock): string => isAllDaySchedule(block) ? block.date : localDate(block.start);
export const timeLogPath = (date: string): string => collectionPath(`time/${date.slice(0, 4)}/${date}.md`);
export const TIMER_STATE_PATH = collectionPath("time/active.md");

export interface TimeTotals { planned: number; actual: number }
/** Future compaction seam. `hot_from: null` means every canonical daily log is indexed. */
export interface TimeIndexBoundary { hot_from: string | null }
export interface TimeRollup {
  from: string; to: string; planned_minutes: number; actual_seconds: number;
  by_task: Record<string, number>; by_project: Record<string, number>; by_area: Record<string, number>;
}
export interface TaskSelector {
  id: "manual" | "next" | "ai";
  select(scope: TimeScope, tasks: Task[]): string[];
}

/** Canonical daily-log persistence plus a cheap rebuildable in-memory index. */
export class TimeStore extends Component {
  private readonly boundary: TimeIndexBoundary = { hot_from: null };
  private logsByDate = new Map<string, TimeLog>();
  private blocksById = new Map<string, TimeBlock>();
  private blocksByScope = new Map<string, TimeBlock[]>();
  private sessionsById = new Map<string, WorkSession>();
  private sessionsByTask = new Map<string, WorkSession[]>();
  private sessionsByProject = new Map<string, WorkSession[]>();
  private sessionsByArea = new Map<string, WorkSession[]>();
  private sessionsByBlock = new Map<string, WorkSession[]>();
  private listeners = new Set<() => void>();
  private repository: MdbaseRepository;

  constructor(private app: App) { super(); this.repository = repositoryFor(app); }

  onload(): void {
    this.rebuild();
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path.startsWith(collectionPath("time/") + "/")) { this.rebuild(); this.emit(); }
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.path.startsWith(collectionPath("time/") + "/")) { this.rebuild(); this.emit(); }
    }));
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const fn of this.listeners) fn(); }

  rebuild(): void {
    this.logsByDate.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.type !== "time_log" || typeof fm.date !== "string") continue;
      this.logsByDate.set(fm.date, { path: file.path, id: String(fm.id ?? ""), date: fm.date, blocks: asArray<TimeBlock>(fm.blocks).map(normalizeBlock), sessions: asArray<WorkSession>(fm.sessions) });
    }
    this.rebuildIndexes();
  }

  /** Rebuild disposable lookup maps from the canonical daily records already in memory. */
  private rebuildIndexes(): void {
    this.blocksById.clear(); this.blocksByScope.clear(); this.sessionsById.clear(); this.sessionsByTask.clear();
    this.sessionsByProject.clear(); this.sessionsByArea.clear(); this.sessionsByBlock.clear();
    const add = (index: Map<string, WorkSession[]>, key: string | undefined, session: WorkSession): void => {
      if (!key) return; const list = index.get(key) ?? []; list.push(session); index.set(key, list);
    };
    for (const log of this.logsByDate.values()) {
      for (const block of log.blocks) {
        this.blocksById.set(block.id, block);
        const key = `${block.scope.type}:${block.scope.id}`, scoped = this.blocksByScope.get(key) ?? [];
        scoped.push(block); this.blocksByScope.set(key, scoped);
      }
      for (const session of log.sessions) {
        this.sessionsById.set(session.id, session);
        add(this.sessionsByTask, session.task_id, session);
        add(this.sessionsByProject, session.project_id_snapshot, session);
        add(this.sessionsByArea, session.area_id_snapshot, session);
        add(this.sessionsByBlock, session.block_id, session);
      }
    }
  }

  logs(): TimeLog[] { return [...this.logsByDate.values()].sort((a, b) => a.date.localeCompare(b.date)); }
  indexBoundary(): TimeIndexBoundary { return { ...this.boundary }; }
  rollups(): TimeRollup[] { return []; }
  blocks(): TimeBlock[] { return this.logs().flatMap((log) => log.blocks); }
  blocksFor(scope: TimeScope): TimeBlock[] { return [...(this.blocksByScope.get(`${scope.type}:${scope.id}`) ?? [])]; }
  sessions(): WorkSession[] { return [...this.sessionsById.values()]; }
  sessionsFor(key: "task" | "project" | "area" | "block", id: string): WorkSession[] {
    const index = key === "task" ? this.sessionsByTask : key === "project" ? this.sessionsByProject : key === "area" ? this.sessionsByArea : this.sessionsByBlock;
    return [...(index.get(id) ?? [])];
  }
  blocksIn(from: string, to: string): TimeBlock[] {
    return this.blocks().filter((b) => {
      if (isAllDaySchedule(b)) return b.date >= from && b.date <= to && b.status !== "cancelled";
      const start = localDate(b.start), end = localDate(new Date(new Date(b.start).getTime() + b.duration * 60000));
      return start <= to && end >= from && b.status !== "cancelled";
    });
  }
  openSessions(): WorkSession[] { return this.sessions().filter((s) => !s.ended_at); }
  session(id: string): WorkSession | null { return this.sessionsById.get(id) ?? null; }
  block(id: string): TimeBlock | null { return this.blocksById.get(id) ?? null; }

  totals(from?: string, to?: string): TimeTotals {
    const inRange = (iso: string) => (!from || localDate(iso) >= from) && (!to || localDate(iso) <= to);
    return {
      planned: this.blocks().reduce((n, b) => n + (!isAllDaySchedule(b) && b.status !== "cancelled" && inRange(b.start) ? b.duration : 0), 0),
      actual: Math.round(this.sessions().filter((s) => inRange(s.started_at)).reduce((n, s) => n + (s.elapsed ?? (s.ended_at ? Math.max(0, (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000) : 0)), 0) / 60),
    };
  }

  private async ensureLog(date: string): Promise<TFile> {
    const path = timeLogPath(date);
    const current = this.app.vault.getAbstractFileByPath(path);
    if (current instanceof TFile) return current;
    const folder = path.slice(0, path.lastIndexOf("/"));
    const parts = folder.split("/"); let built = "";
    for (const part of parts) {
      built = normalizePath(built ? `${built}/${part}` : part);
      if (!this.app.vault.getAbstractFileByPath(built)) await this.app.vault.createFolder(built);
    }
    return this.repository.create({ type: "time_log", path, frontmatter: {
      title: `Time log ${date}`, date, blocks: [], sessions: [],
    }, body: "" });
  }

  private async mutate(date: string, change: (blocks: TimeBlock[], sessions: WorkSession[]) => void): Promise<void> {
    const file = await this.ensureLog(date);
    const record = await updateRecord(this.app, file, (fm) => {
      const blocks = asArray<TimeBlock>(fm.blocks).map((x) => ({ ...x }));
      const sessions = asArray<WorkSession>(fm.sessions).map((x) => ({ ...x }));
      change(blocks, sessions); fm.blocks = blocks; fm.sessions = sessions;
    });
    // Do not immediately reread metadataCache here: Obsidian updates it asynchronously after
    // processFrontMatter. The repository result is the just-written canonical record.
    const fm = record.frontmatter;
    this.logsByDate.set(date, {
      path: record.path, id: typeof fm.id === "string" ? fm.id : "", date,
      blocks: asArray<TimeBlock>(fm.blocks).map(normalizeBlock), sessions: asArray<WorkSession>(fm.sessions),
    });
    this.rebuildIndexes(); this.emit();
  }

  async addBlock(input: NewTimeBlock): Promise<TimeBlock> {
    const block = normalizeBlock({ ...input, id: newUlid(), status: "planned" });
    await this.mutate(timeBlockDate(block), (blocks) => blocks.push(block)); return block;
  }
  async updateBlock(id: string, patch: TimeBlockPatch): Promise<void> {
    const log = this.logs().find((x) => x.blocks.some((b) => b.id === id)); if (!log) return;
    const original = log.blocks.find((b) => b.id === id); if (!original) return;
    const updated = normalizeBlock({ ...original, ...patch } as TimeBlock);
    const destination = timeBlockDate(updated);
    if (destination !== log.date) {
      await this.mutate(log.date, (blocks) => { const i = blocks.findIndex((b) => b.id === id); if (i >= 0) blocks.splice(i, 1); });
      await this.mutate(destination, (blocks) => blocks.push(updated));
      return;
    }
    await this.mutate(log.date, (blocks) => { const i = blocks.findIndex((b) => b.id === id); if (i >= 0) blocks[i] = updated; });
  }
  async cancelFutureBlocks(scopeId: string, now = Date.now()): Promise<void> {
    const today = localDate(new Date(now));
    for (const log of this.logs()) await this.mutate(log.date, (blocks) => {
      for (const b of blocks) if (b.scope.id === scopeId
        && (isAllDaySchedule(b) ? b.date > today : Date.parse(b.start) > now)
        && b.status === "planned") b.status = "cancelled";
    });
  }
  async addSession(session: WorkSession): Promise<void> { await this.mutate(localDate(session.started_at), (_b, sessions) => sessions.push(session)); }
  async updateSession(id: string, patch: Pick<WorkSession, "started_at" | "ended_at" | "elapsed">): Promise<void> {
    const log = this.logs().find((entry) => entry.sessions.some((session) => session.id === id));
    if (!log) throw new Error("This time record no longer exists.");
    const original = log.sessions.find((session) => session.id === id)!;
    const updated = { ...original, ...patch };
    const destination = localDate(updated.started_at);
    if (destination === log.date) {
      await this.mutate(log.date, (_blocks, sessions) => {
        const index = sessions.findIndex((session) => session.id === id);
        if (index < 0) throw new Error("This time record no longer exists.");
        sessions[index] = { ...sessions[index], ...patch };
      });
      return;
    }
    // Write the destination first so a failed write cannot lose the original record.
    await this.mutate(destination, (_blocks, sessions) => { sessions.push(updated); });
    try {
      await this.mutate(log.date, (_blocks, sessions) => {
        const index = sessions.findIndex((session) => session.id === id);
        if (index >= 0) sessions.splice(index, 1);
      });
    } catch (error) {
      await this.mutate(destination, (_blocks, sessions) => {
        const index = sessions.findIndex((session) => session.id === id);
        if (index >= 0) sessions.splice(index, 1);
      });
      throw error;
    }
  }
  async mergeLog(log: Pick<TimeLog, "date" | "blocks" | "sessions">): Promise<void> {
    await this.mutate(log.date, (blocks, sessions) => {
      const blockIds = new Set(blocks.map((b) => b.id)), sessionIds = new Set(sessions.map((s) => s.id));
      blocks.push(...log.blocks.filter((b) => !blockIds.has(b.id)));
      sessions.push(...log.sessions.filter((s) => !sessionIds.has(s.id)));
    });
  }
  async closeSession(id: string, endedAt = rfc3339Now()): Promise<WorkSession | null> {
    const log = this.logs().find((x) => x.sessions.some((s) => s.id === id)); if (!log) return null;
    let closed: WorkSession | null = null;
    await this.mutate(log.date, (_b, sessions) => { const i = sessions.findIndex((s) => s.id === id); if (i < 0) return;
      closed = { ...sessions[i], ended_at: endedAt, elapsed: Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(sessions[i].started_at)) / 1000)) }; sessions[i] = closed;
    });
    return closed;
  }
  async discardSession(id: string): Promise<void> {
    const log = this.logs().find((x) => x.sessions.some((s) => s.id === id)); if (!log) return;
    await this.mutate(log.date, (_blocks, sessions) => {
      const index = sessions.findIndex((session) => session.id === id); if (index >= 0) sessions.splice(index, 1);
    });
  }
}

export const nextSelector: TaskSelector = {
  id: "next",
  select(scope, tasks) {
    return tasks.filter((task) => !isDone(task.status) && !isTrashed(task.status) && (
      scope.type === "task" ? task.id === scope.id : task.project === scope.id || task.path === scope.id
    )).map((task) => task.id);
  },
};

export interface ActiveTimer { session_id: string; log_date: string; task_id: string; block_id?: string; device_id: string; started_at: string }

export class TimerService extends Component {
  private deviceId: string;
  private activeCache: ActiveTimer | null = null;
  private listeners = new Set<() => void>();
  constructor(private app: App, private store: TimeStore) {
    super();
    const storedDevice: unknown = app.loadLocalStorage("opal_tasks-timer-device");
    this.deviceId = typeof storedDevice === "string" ? storedDevice : newUlid();
    app.saveLocalStorage("opal_tasks-timer-device", this.deviceId);
  }
  onload(): void {
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path !== TIMER_STATE_PATH) return;
      const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.active;
      this.activeCache = value && typeof value === "object" ? value as ActiveTimer : null; this.emit();
    }));
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const fn of this.listeners) fn(); }
  active(): ActiveTimer | null {
    if (this.activeCache) return this.activeCache;
    const file = this.app.vault.getAbstractFileByPath(TIMER_STATE_PATH);
    const value: unknown = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.active : null;
    return value && typeof value === "object" ? value as ActiveTimer : null;
  }
  conflicts(): WorkSession[] { return this.store.openSessions(); }
  needsResolution(): boolean {
    const open = this.store.openSessions(), active = this.active();
    return open.length > 1 || (open.length === 1 && active?.session_id !== open[0].id);
  }
  async recover(): Promise<void> {
    const open = this.store.openSessions();
    if (open.length === 1 && !this.active()) await this.resolveConflicts(open[0].id);
  }
  private async stateFile(): Promise<TFile> {
    const current = this.app.vault.getAbstractFileByPath(TIMER_STATE_PATH); if (current instanceof TFile) return current;
    const folder = TIMER_STATE_PATH.slice(0, TIMER_STATE_PATH.lastIndexOf("/"));
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    return repositoryFor(this.app).create({ type: "timer_state", path: TIMER_STATE_PATH, frontmatter: { title: "Active timer" }, body: "" });
  }
  async start(task: Task, block?: TimeBlock, snapshots: Partial<WorkSession> = {}): Promise<WorkSession> {
    if (this.active() || this.store.openSessions().length) throw new Error("A timer is already running in this vault.");
    const started = rfc3339Now(); const session: WorkSession = {
      id: newUlid(), task_id: task.id, task_title_snapshot: task.title, block_id: block?.id,
      ...snapshots, started_at: started, device_id: this.deviceId,
    };
    await this.store.addSession(session);
    const state: ActiveTimer = { session_id: session.id, log_date: localDate(started), task_id: task.id, block_id: block?.id, device_id: this.deviceId, started_at: started };
    const file = await this.stateFile(); await updateRecord(this.app, file, (fm) => { fm.active = state; }); this.activeCache = state; this.emit(); return session;
  }
  async stop(): Promise<WorkSession | null> {
    const active = this.active(); if (!active) return null;
    const closed = await this.store.closeSession(active.session_id);
    const file = await this.stateFile(); await updateRecord(this.app, file, (fm) => { delete fm.active; }); this.activeCache = null; this.emit(); return closed;
  }
  async resolveConflicts(keepId: string | null): Promise<void> {
    const open = this.store.openSessions(), ended = rfc3339Now();
    for (const session of open) if (session.id !== keepId) await this.store.closeSession(session.id, ended);
    const kept = keepId ? this.store.session(keepId) : null; const file = await this.stateFile();
    if (kept && !kept.ended_at) {
      const state: ActiveTimer = { session_id: kept.id, log_date: localDate(kept.started_at), task_id: kept.task_id, block_id: kept.block_id, device_id: kept.device_id, started_at: kept.started_at };
      await updateRecord(this.app, file, (fm) => { fm.active = state; }); this.activeCache = state;
    } else { await updateRecord(this.app, file, (fm) => { delete fm.active; }); this.activeCache = null; }
    this.emit();
  }
  async discardConflict(id: string): Promise<void> {
    const wasActive = this.active()?.session_id === id;
    await this.store.discardSession(id);
    if (wasActive) {
      const file = await this.stateFile(); await updateRecord(this.app, file, (fm) => { delete fm.active; }); this.activeCache = null;
    }
    await this.recover(); this.emit();
  }
}
