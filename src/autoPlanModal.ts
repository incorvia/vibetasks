import { Modal, Notice, setIcon } from "obsidian";
import type OpalTasksPlugin from "./main";
import { DEFAULT_TIME_MAP, localDay, type AutoPlanInput, type AutoPlanPreview } from "./autoPlanner";
import { addDays, layoutSlots } from "./calendarModel";
import { buildAutoPlanDayComparison, type AutoPlanAllDayItem, type AutoPlanComparisonItem } from "./autoPlanComparison";
import { t, getLocale } from "./i18n";
import { isOpen } from "./statuses";
import { listManaged, projectAreaName } from "./taskService";
import { MdbaseRepositoryError } from "./mdbaseRepository";

const previewShape = (preview: AutoPlanPreview): string => JSON.stringify({
  placements: preview.placements, preserved: preview.preserved, unscheduled: preview.unscheduled,
  candidateTaskIds: preview.candidateTaskIds, expectedSchedules: preview.expectedSchedules,
});
const dayLabel = (day: string): string => new Intl.DateTimeFormat(getLocale(), {
  weekday: "long", month: "short", day: "numeric",
}).format(new Date(`${day}T12:00:00`));
const clockLabel = (iso: string): string => new Intl.DateTimeFormat(getLocale(), {
  hour: "numeric", minute: "2-digit",
}).format(new Date(iso));
const AUTO_PLAN_DAYS = 2 as const;
const HOUR_PX = 48;

/** Shared source of truth for auto-plan and the running-day sidebar. */
export function collectAutoPlanInput(plugin: OpalTasksPlugin, now: Date, days: 1 | 2 | 3 = 1): AutoPlanInput {
  const managed = listManaged(plugin.app), all = [...managed.active, ...managed.archived];
  const archivedAreas = new Set(managed.archived.filter((x) => x.type === "area").map((x) => x.id));
  const archivedAreaNames = new Set(managed.archived.filter((x) => x.type === "area").map((x) => x.name.toLowerCase()));
  const excludedPaths = new Set(managed.archived.map((x) => x.path));
  for (const project of managed.active.filter((x) => x.type === "project")) {
    if ((project.areaId && archivedAreas.has(project.areaId)) || (!project.areaId && archivedAreaNames.has(projectAreaName(project.area)?.toLowerCase() ?? ""))) excludedPaths.add(project.path);
  }
  const areas = all.filter((x) => x.type === "area");
  const areaForProject = (path: string | null) => {
    if (!path) return undefined;
    const item = all.find((x) => x.path === path); if (!item) return undefined;
    if (item.type === "area") return item;
    return areas.find((area) => item.areaId ? area.id === item.areaId : area.name.toLowerCase() === (projectAreaName(item.area)?.toLowerCase() ?? ""));
  };
  const tasks = plugin.index.all().filter((task) => isOpen(task.status) && (!task.project || !excludedPaths.has(task.project)))
    .map((task) => ({ task, timeMapId: areaForProject(task.project)?.timeMapId }));
  const from = localDay(now), to = addDays(from, days - 1);
  return { tasks, blocks: plugin.timeStore.blocks(), events: (plugin.gcalFeed?.eventsIn(from, to) ?? []).filter((event) => !plugin.timeStore.isMeetingComplete(event)),
    maps: plugin.settings.timeMaps?.length ? plugin.settings.timeMaps : [DEFAULT_TIME_MAP],
    defaultMapId: plugin.settings.defaultTimeMapId ?? "default", excludedLabels: plugin.settings.autoPlanExcludedLabels ?? [],
    activeTaskId: plugin.workTimer?.active()?.task_id, now, days };
}

export class AutoPlanModal extends Modal {
  private selectedDay = 0;
  private mobileView: "current" | "proposed" = "proposed";
  private preview: AutoPlanPreview | null = null;
  private previewInput: AutoPlanInput | null = null;
  private allowCached = false;
  private loading = false;

  constructor(private plugin: OpalTasksPlugin) { super(plugin.app); }

  onOpen(): void {
    this.modalEl.addClass("bt-auto-plan-modal");
    this.render();
    void this.refresh();
  }
  onClose(): void { this.contentEl.empty(); }

  private input(now = new Date()): AutoPlanInput {
    return collectAutoPlanInput(this.plugin, now, AUTO_PLAN_DAYS);
  }

  private async refresh(): Promise<void> {
    this.loading = true; this.preview = null; this.render();
    const now = new Date(), from = localDay(now), to = addDays(from, AUTO_PLAN_DAYS - 1);
    if (this.plugin.gcalFeed?.isActive()) {
      this.plugin.gcalFeed.setRange(from, to);
      await this.plugin.gcalFeed.refresh();
      if (this.plugin.gcalFeed.getStatus().error && !this.allowCached) {
        this.loading = false; this.render(); return;
      }
    }
    this.previewInput = this.input(now);
    this.preview = this.plugin.scheduling.previewAutoPlan(this.previewInput);
    this.loading = false; this.render();
  }

  private render(): void {
    const root = this.contentEl; root.empty();
    const title = root.createDiv({ cls: "bt-auto-title" });
    setIcon(title.createSpan(), "wand-sparkles");
    title.createEl("h3", { text: t("auto_plan_title") });
    root.createDiv({ cls: "bt-auto-desc", text: t("auto_plan_desc") });
    const feedError = this.plugin.gcalFeed?.isActive() && this.plugin.gcalFeed.getStatus().error;
    if (feedError && !this.allowCached) {
      const warning = root.createDiv({ cls: "bt-auto-warning" });
      warning.createDiv({ text: this.plugin.gcalFeed.getStatus().error ?? "" });
      const cached = warning.createEl("button", { text: t("auto_use_cached") });
      cached.onclick = () => { this.allowCached = true; void this.refresh(); };
    } else if (this.loading) root.createDiv({ cls: "bt-auto-loading", text: t("auto_loading") });
    else if (this.preview && this.previewInput) this.renderPreview(root, this.preview, this.previewInput);

    const foot = root.createDiv({ cls: "bt-foot bt-auto-foot" });
    const left = foot.createDiv({ cls: "bt-actions" });
    if (this.plugin.scheduling.canUndoAutoPlan()) left.createEl("button", { text: t("auto_undo") }).onclick = async () => {
      try { await this.plugin.scheduling.undoAutoPlan(); new Notice(t("auto_undone")); this.plugin.renderAll(); this.close(); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    };
    const actions = foot.createDiv({ cls: "bt-actions" });
    actions.createEl("button", { text: t("btn_cancel") }).onclick = () => this.close();
    const apply = actions.createEl("button", { cls: "mod-cta", text: t("auto_apply") });
    apply.disabled = !this.preview || this.loading;
    apply.onclick = () => void this.apply();
  }

  private renderPreview(root: HTMLElement, preview: AutoPlanPreview, input: AutoPlanInput): void {
    const body = root.createDiv({ cls: "bt-auto-preview" });
    const day = addDays(preview.from, this.selectedDay);
    const nav = body.createDiv({ cls: "bt-auto-day-nav" });
    const previous = nav.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("cal_prev") } });
    setIcon(previous, "chevron-left"); previous.disabled = this.selectedDay === 0;
    previous.onclick = () => { this.selectedDay = 0; this.render(); };
    const dayTitle = nav.createDiv({ cls: "bt-auto-day-title" });
    dayTitle.createDiv({ cls: "bt-auto-day-relative", text: this.selectedDay === 0 ? t("date_today") : t("date_tomorrow") });
    dayTitle.createDiv({ cls: "bt-auto-day-date", text: dayLabel(day) });
    const next = nav.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("cal_next") } });
    setIcon(next, "chevron-right"); next.disabled = this.selectedDay === AUTO_PLAN_DAYS - 1;
    next.onclick = () => { this.selectedDay = 1; this.render(); };

    const viewTabs = body.createDiv({ cls: "bt-tabs bt-auto-view-tabs", attr: { role: "tablist" } });
    for (const view of ["current", "proposed"] as const) {
      const button = viewTabs.createEl("button", { cls: "bt-tab" + (this.mobileView === view ? " is-active" : ""), text: t(`auto_${view}`) });
      button.setAttr("role", "tab"); button.setAttr("aria-selected", String(this.mobileView === view));
      button.onclick = () => { this.mobileView = view; this.render(); };
    }

    const comparison = buildAutoPlanDayComparison(input, preview, day);
    const calendar = body.createDiv({ cls: "bt-auto-calendars", attr: { "data-mobile-view": this.mobileView } });
    const head = calendar.createDiv({ cls: "bt-auto-calendar-head" });
    head.createDiv({ cls: "bt-auto-time-gutter" });
    head.createDiv({ cls: "bt-auto-column-title is-current", text: t("auto_current") });
    head.createDiv({ cls: "bt-auto-column-title is-proposed", text: t("auto_proposed") });
    this.renderAllDay(calendar, comparison.currentAllDay, comparison.proposedAllDay);
    const scroll = calendar.createDiv({ cls: "bt-auto-calendar-scroll" });
    const grid = scroll.createDiv({ cls: "bt-auto-calendar-grid" });
    grid.style.setProperty("--bt-auto-hour", `${HOUR_PX}px`);
    const hours = grid.createDiv({ cls: "bt-auto-time-gutter bt-auto-hours" });
    for (let hour = 0; hour < 24; hour++) {
      const row = hours.createDiv({ cls: "bt-auto-hour" }); row.style.height = `${HOUR_PX}px`;
      if (hour) row.createSpan({ text: `${String(hour).padStart(2, "0")}:00` });
    }
    this.renderTimeline(grid, comparison.current, "current", day);
    this.renderTimeline(grid, comparison.proposed, "proposed", day);
    const earliest = Math.min(...comparison.current.map((item) => item.startMin), ...comparison.proposed.map((item) => item.startMin), 8 * 60);
    window.setTimeout(() => { if (scroll.isConnected) scroll.scrollTop = Math.max(0, earliest / 60 * HOUR_PX - HOUR_PX); }, 0);

    const list = (title: string, rows: { title: string; reason: string }[]) => {
      if (!rows.length) return;
      const section = body.createDiv({ cls: "bt-auto-list" }); section.createEl("h4", { text: title });
      for (const row of rows) {
        const el = section.createDiv({ cls: "bt-auto-list-row" });
        el.createSpan({ text: row.title }); el.createSpan({ cls: "bt-auto-reason", text: row.reason });
      }
    };
    list(t("auto_not_scheduled"), preview.unscheduled.map((x) => ({ title: x.title, reason: t(x.reason === "no_time" ? "auto_no_time" : "auto_invalid_duration") })));
  }

  private renderAllDay(root: HTMLElement, current: AutoPlanAllDayItem[], proposed: AutoPlanAllDayItem[]): void {
    if (!current.length && !proposed.length) return;
    const row = root.createDiv({ cls: "bt-auto-all-day" });
    row.createDiv({ cls: "bt-auto-time-gutter", text: t("cal_allday") });
    this.renderAllDayColumn(row, current, "current");
    this.renderAllDayColumn(row, proposed, "proposed");
  }

  private renderAllDayColumn(root: HTMLElement, items: AutoPlanAllDayItem[], side: "current" | "proposed"): void {
    const column = root.createDiv({ cls: `bt-auto-all-day-column is-${side}` });
    for (const item of items) this.renderItem(column, item);
  }

  private renderTimeline(root: HTMLElement, items: AutoPlanComparisonItem[], side: "current" | "proposed", day: string): void {
    const column = root.createDiv({ cls: `bt-auto-timeline is-${side}` });
    column.style.height = `${24 * HOUR_PX}px`;
    if (day === localDay(new Date())) {
      const now = new Date(), line = column.createDiv({ cls: "bt-auto-now" });
      line.style.top = `${(now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_PX}px`;
    }
    for (const item of layoutSlots(items, (a, b) => a.title.localeCompare(b.title))) {
      const el = this.renderItem(column, item);
      el.style.top = `${item.startMin / 60 * HOUR_PX}px`;
      el.style.height = `${Math.max(20, (item.endMin - item.startMin) / 60 * HOUR_PX - 2)}px`;
      el.style.left = `calc(${item.col / item.cols * 100}% + 3px)`;
      el.style.width = `calc(${1 / item.cols * 100}% - 6px)`;
      el.setAttr("title", `${clockLabel(item.start)}–${clockLabel(item.end)} · ${item.title}`);
      if (item.endMin - item.startMin >= 45) el.createDiv({ cls: "bt-auto-calendar-time", text: `${clockLabel(item.start)}–${clockLabel(item.end)}` });
    }
  }

  private renderItem(root: HTMLElement, item: AutoPlanAllDayItem | AutoPlanComparisonItem): HTMLElement {
    const el = root.createDiv({ cls: `bt-auto-calendar-item is-${item.kind} is-${item.change}` });
    if (item.color) el.style.setProperty("--bt-auto-item-color", item.color);
    if (item.pinned) el.addClass("is-pinned");
    if (item.completed) el.addClass("is-completed");
    if ("afterDeadline" in item && item.afterDeadline) {
      el.addClass("is-late"); el.setAttr("aria-label", `${item.title}: ${t("auto_after_deadline")}`);
    }
    el.createDiv({ cls: "bt-auto-calendar-task", text: item.title });
    return el;
  }

  private async apply(): Promise<void> {
    if (!this.preview) return;
    const freshInput = this.input(new Date());
    const fresh = this.plugin.scheduling.previewAutoPlan(freshInput);
    if (previewShape(fresh) !== previewShape(this.preview)) {
      this.previewInput = freshInput; this.preview = fresh; this.render(); new Notice(t("auto_stale")); return;
    }
    try {
      await this.plugin.repository.ensureAutoPlanSchema();
      await this.plugin.scheduling.applyAutoPlan(this.preview);
      new Notice(t("auto_applied")); this.plugin.renderAll(); this.close();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && (error as { code?: unknown }).code === "stale_plan") {
        this.previewInput = this.input(new Date());
        this.preview = this.plugin.scheduling.previewAutoPlan(this.previewInput); this.render(); new Notice(t("auto_stale"));
      } else {
        console.error("Opal Tasks: auto-plan apply failed", error);
        if (error instanceof MdbaseRepositoryError && error.issues.length) {
          const details = error.issues.slice(0, 3).map((issue) => `${issue.field ? issue.field + ": " : ""}${issue.message}`).join("; ");
          new Notice(`${error.message}: ${details}`, 12000);
        } else new Notice(error instanceof Error ? error.message : String(error), 12000);
      }
    }
  }
}
