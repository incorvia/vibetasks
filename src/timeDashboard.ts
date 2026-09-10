import { ItemView, Notice, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { WorkSession } from "./types";
import { addDays, formatDuration, localDateTime, todayStr } from "./format";
import { dashboardReport, sessionDay, sessionSeconds } from "./timeDashboardModel";
import { TaskPickerModal } from "./searchModal";
import { TimeRecordModal } from "./timeRecordModal";
import { TimerConflictModal } from "./timerConflictModal";

const duration = (seconds: number) => seconds > 0 && seconds < 60 ? "< 1 min" : formatDuration(Math.round(seconds / 60));
type Range = "day" | "week" | "month" | "custom";
export const VIEW_TIME_DASHBOARD = "opal-tasks-time-dashboard";

/** A persistent workspace tab for reporting and correcting tracked time. */
export class TimeDashboardView extends ItemView {
  private from = addDays(todayStr(), -((new Date().getDay() + 6) % 7));
  private to = addDays(this.from, 6);
  private range: Range = "week";
  private tab: "overview" | "records" = "overview";
  private search = "";
  private currentHierarchy = false;
  private page = 0;
  private expandedGroups = new Map<string, boolean>();
  private unsubscribes: (() => void)[] = [];
  private interval?: number;
  private reportEl!: HTMLElement;
  private timerEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: OpalTasksPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TIME_DASHBOARD; }
  getDisplayText(): string { return "Time dashboard"; }
  getIcon(): string { return "clock"; }
  getState(): Record<string, unknown> { return { from: this.from, to: this.to, range: this.range, tab: this.tab }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const value = state && typeof state === "object" ? state as Record<string, unknown> : {};
    const from = typeof value.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.from) ? value.from : null;
    const to = typeof value.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.to) ? value.to : null;
    if (from && to && from <= to) { this.from = from; this.to = to; }
    if (value.range === "day" || value.range === "week" || value.range === "month" || value.range === "custom") this.range = value.range;
    if (value.tab === "overview" || value.tab === "records") this.tab = value.tab;
    result.history = false;
    if (this.reportEl) this.draw();
  }
  async onOpen(): Promise<void> {
    this.draw();
    this.unsubscribes = [this.plugin.timeStore.subscribe(() => this.refresh()), this.plugin.workTimer.subscribe(() => this.refresh())];
    this.interval = window.setInterval(() => {
      // Leave focused controls in place while the user interacts with them.
      if (!this.contentEl.contains(this.contentEl.doc.activeElement)) this.refresh();
    }, 15_000);
  }
  async onClose(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    window.clearInterval(this.interval); this.contentEl.empty();
  }

  private pickTask(manual: boolean): void {
    const tasks = manual ? this.plugin.index.all() : this.plugin.index.open();
    if (!tasks.length) { new Notice("Create a task first to track time against it."); return; }
    new TaskPickerModal(this.app, tasks, manual ? "Choose a task to log time…" : "Choose a task to start timing…", (task) => {
      if (manual) new TimeRecordModal(this.plugin, task).open();
      else void this.plugin.startTaskTimer(task);
    }).open();
  }

  private setRange(kind: Exclude<Range, "custom">, anchor = todayStr()): void {
    this.range = kind;
    const date = new Date(`${anchor}T12:00:00`);
    if (kind === "day") { this.from = anchor; this.to = anchor; }
    if (kind === "week") { this.from = addDays(anchor, -((date.getDay() + 6) % 7)); this.to = addDays(this.from, 6); }
    if (kind === "month") {
      this.from = `${anchor.slice(0, 7)}-01`;
      date.setMonth(date.getMonth() + 1, 0); this.to = localDateTime(date.toISOString()).slice(0, 10);
    }
    this.page = 0; this.saveAndDraw();
  }

  private shift(direction: number): void {
    if (this.range === "month") {
      const date = new Date(`${this.from}T12:00:00`); date.setMonth(date.getMonth() + direction);
      this.setRange("month", localDateTime(date.toISOString()).slice(0, 10));
    } else if (this.range !== "custom") this.setRange(this.range, addDays(this.from, direction * (this.range === "week" ? 7 : 1)));
    else {
      const count = Math.round((Date.parse(`${this.to}T12:00:00Z`) - Date.parse(`${this.from}T12:00:00Z`)) / 86400000) + 1;
      this.from = addDays(this.from, direction * count); this.to = addDays(this.to, direction * count); this.page = 0; this.saveAndDraw();
    }
  }

  private saveAndDraw(): void {
    this.plugin.app.workspace.requestSaveLayout();
    this.draw();
  }

  private draw(): void {
    const el = this.contentEl; el.empty(); el.addClass("bt-time-dashboard");
    const header = el.createDiv({ cls: "bt-time-dashboard-header" });
    const heading = header.createDiv(); heading.createEl("h2", { text: "Time dashboard" });
    heading.createEl("p", { cls: "bt-time-dashboard-muted", text: "See where your time goes, and keep your records accurate." });
    const log = header.createEl("button", { text: "Log time" }); log.onclick = () => this.pickTask(true);
    this.timerEl = el.createDiv({ cls: "bt-time-dashboard-timer" });
    const ranges = el.createDiv({ cls: "bt-time-dashboard-toolbar" });
    for (const [kind, label] of [["day", "Day"], ["week", "Week"], ["month", "Month"]] as const) {
      const button = ranges.createEl("button", { text: label, cls: this.range === kind ? "mod-cta" : "", attr: { "aria-pressed": String(this.range === kind) } });
      button.onclick = () => this.setRange(kind);
    }
    const previous = ranges.createEl("button", { text: "‹", attr: { "aria-label": "Previous period" } }); previous.onclick = () => this.shift(-1);
    const today = ranges.createEl("button", { text: "Today" }); today.onclick = () => this.setRange(this.range === "custom" ? "day" : this.range);
    const next = ranges.createEl("button", { text: "›", attr: { "aria-label": "Next period" } }); next.onclick = () => this.shift(1);
    const custom = el.createDiv({ cls: "bt-time-dashboard-range" });
    const field = (label: string, value: string) => {
      const wrapper = custom.createEl("label"); wrapper.createSpan({ text: label });
      const input = wrapper.createEl("input", { type: "date", attr: { "aria-label": label } }); input.value = value; return input;
    };
    const from = field("From", this.from), to = field("To", this.to);
    from.max = this.to; to.min = this.from;
    const change = () => {
      if (!from.value || !to.value || from.value > to.value || !from.checkValidity() || !to.checkValidity()) {
        new Notice("Choose a valid date range with the end on or after the start."); return;
      }
      this.from = from.value; this.to = to.value; this.range = "custom"; this.page = 0; this.saveAndDraw();
    };
    from.onchange = to.onchange = change;
    const tabs = el.createDiv({ cls: "bt-time-dashboard-tabs" });
    for (const [value, label] of [["overview", "Overview"], ["records", "Time records"]] as const) {
      const button = tabs.createEl("button", { text: label, cls: this.tab === value ? "is-active" : "", attr: { "aria-pressed": String(this.tab === value) } });
      button.onclick = () => { this.tab = value; this.saveAndDraw(); };
    }
    if (this.tab === "records") {
      const search = el.createEl("input", { cls: "bt-time-dashboard-search", type: "search", attr: { placeholder: "Find a task, project, or area…", "aria-label": "Search time records" } });
      search.value = this.search;
      search.oninput = () => { this.search = search.value; this.page = 0; this.drawReport(); };
    } else {
      const label = el.createEl("label", { cls: "bt-time-dashboard-hierarchy" });
      const toggle = label.createEl("input", { type: "checkbox" }); toggle.checked = this.currentHierarchy;
      label.appendText(" Use current project and area assignments");
      toggle.onchange = () => { this.currentHierarchy = toggle.checked; this.drawReport(); };
    }
    this.reportEl = el.createDiv(); this.refresh();
  }

  private refresh(): void { this.drawTimer(); this.drawReport(); }

  private drawTimer(): void {
    const el = this.timerEl; el.empty();
    const active = this.plugin.workTimer.active();
    if (this.plugin.workTimer.needsResolution()) {
      el.createSpan({ text: "Timer records need attention." });
      const resolve = el.createEl("button", { text: "Resolve timers" }); resolve.onclick = () => new TimerConflictModal(this.plugin).open();
    } else if (active) {
      const session = this.plugin.timeStore.session(active.session_id);
      const info = el.createDiv(); info.createSpan({ cls: "bt-time-dashboard-live", text: "● Tracking" });
      info.createEl("strong", { text: session?.task_title_snapshot ?? this.plugin.index.getById(active.task_id)?.title ?? "Task" });
      el.createEl("strong", { text: duration(Math.max(0, (Date.now() - Date.parse(active.started_at)) / 1000)) });
      const stop = el.createEl("button", { text: "Stop timer", cls: "mod-cta" });
      stop.onclick = async () => {
        stop.disabled = true;
        try { await this.plugin.stopTaskTimer(); } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); stop.disabled = false; }
      };
    } else {
      const info = el.createDiv(); info.createEl("strong", { text: "Ready when you are" });
      info.createDiv({ cls: "bt-time-dashboard-muted", text: "Start a task timer or log time you’ve already worked." });
      const start = el.createEl("button", { text: "Start timer", cls: "mod-cta" }); start.onclick = () => this.pickTask(false);
    }
  }

  private drawReport(): void {
    const el = this.reportEl; el.empty();
    const report = dashboardReport(this.plugin.timeStore.sessions(), this.plugin.timeStore.blocks(), this.from, this.to);
    const stats = el.createDiv({ cls: "bt-time-dashboard-stats" });
    const difference = report.actual - report.planned;
    for (const [label, value, detail] of [
      ["Tracked time", duration(report.actual), "Includes running sessions"],
      ["Planned time", duration(report.planned), "Timed blocks in this period"],
      ["Against plan", duration(Math.abs(difference)), difference > 0 ? "Over planned time" : difference < 0 ? "Under planned time" : "Matches planned time"],
      ["Tasks worked on", String(new Set(report.sessions.map((session) => session.task_id)).size), `${report.sessions.length} time records`],
    ]) {
      const card = stats.createDiv({ cls: "bt-time-dashboard-stat" }); card.createDiv({ text: label });
      card.createEl("strong", { text: value }); card.createDiv({ cls: "bt-time-dashboard-muted", text: detail });
    }
    if (this.tab === "records") { this.drawRecords(el, report.sessions); return; }
    el.createEl("h3", { text: "Daily activity" });
    el.createEl("p", { cls: "bt-time-dashboard-muted", text: "Tracked / planned · Entries count on their local start date. All-day schedules have no planned duration." });
    if (!report.days.length) {
      const empty = el.createDiv({ cls: "bt-time-dashboard-empty" });
      empty.createEl("strong", { text: "Your time story starts here" });
      empty.createEl("p", { text: "Start a timer or log a past session to see your activity and project breakdown." });
    } else {
      const chart = el.createDiv({ cls: "bt-time-dashboard-chart" });
      const max = Math.max(1, ...report.days.map(([, value]) => Math.max(value.actual, value.planned)));
      for (const [date, value] of report.days) {
        const row = chart.createDiv({ cls: "bt-time-dashboard-day" });
        row.createSpan({ text: new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) });
        const bars = row.createDiv({ cls: "bt-time-dashboard-bars" });
        for (const [label, seconds] of [["Tracked", value.actual], ["Planned", value.planned]] as const) {
          const bar = bars.createEl("progress", { cls: label === "Planned" ? "is-planned" : "", attr: { "aria-label": `${date}: ${label} ${duration(seconds)}`, title: `${label}: ${duration(seconds)}` } });
          bar.max = max; bar.value = seconds;
        }
        row.createSpan({ cls: "bt-time-dashboard-day-total", text: `${duration(value.actual)} / ${duration(value.planned)}` });
      }
    }
    if (report.sessions.length) this.drawGroups(el, report.sessions);
  }

  private drawRecords(el: HTMLElement, sessions: WorkSession[]): void {
    const query = this.search.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) => [session.task_title_snapshot, session.project_title_snapshot, session.area_title_snapshot].filter(Boolean).join(" ").toLocaleLowerCase().includes(query));
    el.createEl("h3", { text: `Time records · ${filtered.length}` });
    el.createEl("p", { cls: "bt-time-dashboard-muted", text: "Edit a finished record to correct its start and end. Stop a running timer before editing it." });
    if (!filtered.length) { el.createDiv({ cls: "bt-time-dashboard-empty", text: query ? "No matching records. Try another search." : "No time recorded in this period. Use Start timer or Log time to add your first entry." }); return; }
    const pageSize = 25; this.page = Math.min(this.page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
    const wrapper = el.createDiv({ cls: "bt-time-dashboard-table-wrap" });
    const table = wrapper.createEl("table", { cls: "bt-time-dashboard-table" });
    const header = table.createEl("thead").createEl("tr");
    for (const label of ["Task / project", "Started", "Ended", "Duration", "Action"]) header.createEl("th", { text: label, attr: { scope: "col" } });
    const body = table.createEl("tbody");
    for (const session of filtered.slice(this.page * pageSize, (this.page + 1) * pageSize)) {
      const row = body.createEl("tr"), taskCell = row.createEl("td");
      const task = this.plugin.index.getById(session.task_id);
      if (task) {
        const link = taskCell.createEl("button", { cls: "bt-time-dashboard-task", text: session.task_title_snapshot });
        link.onclick = () => { void this.app.workspace.openLinkText(task.path, "", false); };
      } else taskCell.createEl("strong", { text: session.task_title_snapshot });
      taskCell.createDiv({ cls: "bt-time-dashboard-muted", text: [session.area_title_snapshot, session.project_title_snapshot].filter(Boolean).join(" / ") || "Unassigned" });
      row.createEl("td", { text: new Date(session.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
      row.createEl("td", { text: session.ended_at ? new Date(session.ended_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Running", cls: session.ended_at ? "" : "bt-time-dashboard-live" });
      row.createEl("td", { text: duration(sessionSeconds(session)) });
      const edit = row.createEl("td").createEl("button", { text: "Edit", attr: { "aria-label": `Edit time for ${session.task_title_snapshot}` } });
      edit.disabled = !session.ended_at; edit.onclick = () => new TimeRecordModal(this.plugin, task, { ...session }).open();
    }
    if (filtered.length > pageSize) {
      const pagination = el.createDiv({ cls: "bt-time-dashboard-toolbar" });
      const previous = pagination.createEl("button", { text: "Previous" }); previous.disabled = this.page === 0;
      previous.onclick = () => { this.page--; this.drawReport(); };
      pagination.createSpan({ text: `Page ${this.page + 1} of ${Math.ceil(filtered.length / pageSize)}` });
      const next = pagination.createEl("button", { text: "Next" }); next.disabled = (this.page + 1) * pageSize >= filtered.length;
      next.onclick = () => { this.page++; this.drawReport(); };
    }
  }

  private drawGroups(el: HTMLElement, sessions: WorkSession[]): void {
    el.createEl("h3", { text: "By area and project" });
    el.createEl("p", { cls: "bt-time-dashboard-muted", text: this.currentHierarchy ? "Using current task assignments." : "Using project and area names saved when time was recorded." });
    const groups = new Map<string, Map<string, WorkSession[]>>();
    for (const session of sessions) {
      const task = this.plugin.index.getById(session.task_id);
      let area = session.area_title_snapshot ?? "Unassigned area", project = session.project_title_snapshot ?? "Unassigned project";
      if (this.currentHierarchy && task) {
        area = "Unassigned area"; project = "Unassigned project";
        const file = task.project ? this.app.vault.getAbstractFileByPath(task.project) : null;
        const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
        const title = typeof fm?.title === "string" ? fm.title : file instanceof TFile ? file.basename : task.project;
        if (fm?.type === "area") { area = title ?? area; project = "Direct tasks"; }
        else if (title) {
          project = title;
          if (typeof fm?.opal_area_id === "string") {
            const areaFile = this.app.vault.getMarkdownFiles().find((candidate) => this.app.metadataCache.getFileCache(candidate)?.frontmatter?.id === fm.opal_area_id);
            const areaFm = areaFile ? this.app.metadataCache.getFileCache(areaFile)?.frontmatter : null;
            area = typeof areaFm?.title === "string" ? areaFm.title : areaFile?.basename ?? "Unassigned area";
          } else if (typeof fm?.area === "string") area = fm.area.replace(/^\[\[|\]\]$/g, "").split("|")[0];
        }
      }
      const projects = groups.get(area) ?? new Map<string, WorkSession[]>();
      const list = projects.get(project) ?? []; list.push(session); projects.set(project, list); groups.set(area, projects);
    }
    for (const [areaName, projects] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const areaKey = JSON.stringify([this.currentHierarchy, areaName]);
      const area = el.createEl("details", { cls: "bt-time-dashboard-group" }); area.open = this.expandedGroups.get(areaKey) ?? true;
      area.ontoggle = () => { if (area.isConnected) this.expandedGroups.set(areaKey, area.open); };
      area.createEl("summary", { text: `${areaName} · ${duration([...projects.values()].flat().reduce((n, session) => n + sessionSeconds(session), 0))}` });
      for (const [projectName, list] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
        const project = area.createEl("details");
        const projectKey = JSON.stringify([this.currentHierarchy, areaName, projectName]);
        project.open = this.expandedGroups.get(projectKey) ?? false;
        project.ontoggle = () => { if (project.isConnected) this.expandedGroups.set(projectKey, project.open); };
        project.createEl("summary", { text: `${projectName} · ${duration(list.reduce((n, session) => n + sessionSeconds(session), 0))}` });
        for (const session of list) project.createDiv({ cls: "bt-time-dashboard-group-entry", text: `${session.task_title_snapshot} · ${sessionDay(session)} · ${duration(sessionSeconds(session))}` });
      }
    }
  }
}
