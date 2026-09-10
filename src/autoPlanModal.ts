import { Modal, Notice, setIcon } from "obsidian";
import type OpalTasksPlugin from "./main";
import { DEFAULT_TIME_MAP, localDay, type AutoPlanInput, type AutoPlanPreview } from "./autoPlanner";
import { addDays } from "./calendarModel";
import { t, getLocale } from "./i18n";
import { isOpen } from "./statuses";
import { listManaged, projectAreaName } from "./taskService";
import { MdbaseRepositoryError } from "./mdbaseRepository";

const previewShape = (preview: AutoPlanPreview): string => JSON.stringify({
  placements: preview.placements, preserved: preview.preserved, unscheduled: preview.unscheduled,
  candidateTaskIds: preview.candidateTaskIds, expectedSchedules: preview.expectedSchedules,
});
const timeLabel = (iso: string): string => new Intl.DateTimeFormat(getLocale(), {
  weekday: "short", hour: "numeric", minute: "2-digit",
}).format(new Date(iso));
const dayLabel = (day: string): string => new Intl.DateTimeFormat(getLocale(), {
  weekday: "long", month: "short", day: "numeric",
}).format(new Date(`${day}T12:00:00`));

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
  private days: 1 | 2 | 3 = 1;
  private preview: AutoPlanPreview | null = null;
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
    return collectAutoPlanInput(this.plugin, now, this.days);
  }

  private async refresh(): Promise<void> {
    this.loading = true; this.preview = null; this.render();
    const now = new Date(), from = localDay(now), to = addDays(from, this.days - 1);
    if (this.plugin.gcalFeed?.isActive()) {
      this.plugin.gcalFeed.setRange(from, to);
      await this.plugin.gcalFeed.refresh();
      if (this.plugin.gcalFeed.getStatus().error && !this.allowCached) {
        this.loading = false; this.render(); return;
      }
    }
    this.preview = this.plugin.scheduling.previewAutoPlan(this.input(now));
    this.loading = false; this.render();
  }

  private render(): void {
    const root = this.contentEl; root.empty();
    const title = root.createDiv({ cls: "bt-auto-title" });
    setIcon(title.createSpan(), "wand-sparkles");
    title.createEl("h3", { text: t("auto_plan_title") });
    root.createDiv({ cls: "bt-auto-desc", text: t("auto_plan_desc") });
    const horizons = root.createDiv({ cls: "bt-tabs bt-auto-horizon", attr: { role: "tablist" } });
    for (const days of [1, 2, 3] as const) {
      const b = horizons.createEl("button", { cls: "bt-tab" + (this.days === days ? " is-active" : ""), text: days === 1 ? t("auto_today") : t("auto_days", days) });
      b.setAttr("role", "tab"); b.setAttr("aria-selected", String(this.days === days));
      b.onclick = () => { this.days = days; this.allowCached = false; void this.refresh(); };
    }
    const feedError = this.plugin.gcalFeed?.isActive() && this.plugin.gcalFeed.getStatus().error;
    if (feedError && !this.allowCached) {
      const warning = root.createDiv({ cls: "bt-auto-warning" });
      warning.createDiv({ text: this.plugin.gcalFeed.getStatus().error ?? "" });
      const cached = warning.createEl("button", { text: t("auto_use_cached") });
      cached.onclick = () => { this.allowCached = true; void this.refresh(); };
    } else if (this.loading) root.createDiv({ cls: "bt-auto-loading", text: t("auto_loading") });
    else if (this.preview) this.renderPreview(root, this.preview);

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

  private renderPreview(root: HTMLElement, preview: AutoPlanPreview): void {
    const body = root.createDiv({ cls: "bt-auto-preview" });
    for (let offset = 0; offset < preview.days; offset++) {
      const day = addDays(preview.from, offset), rows = preview.placements.filter((x) => localDay(new Date(x.start)) === day);
      const section = body.createDiv({ cls: "bt-auto-day" });
      section.createEl("h4", { text: dayLabel(day) });
      if (!rows.length) section.createDiv({ cls: "bt-auto-empty", text: t("auto_no_time") });
      for (const row of rows) {
        const el = section.createDiv({ cls: "bt-auto-row" });
        el.createSpan({ cls: `bt-auto-kind is-${row.kind}`, text: t("auto_" + row.kind) });
        const main = el.createDiv({ cls: "bt-auto-row-main" });
        main.createDiv({ cls: "bt-auto-task", text: row.title });
        main.createDiv({ cls: "bt-auto-time", text: `${timeLabel(row.start)} · ${row.duration}m${row.previousStart ? ` · ${t("auto_from", timeLabel(row.previousStart))}` : ""}` });
        if (row.afterDeadline) main.createDiv({ cls: "bt-auto-late", text: t("auto_after_deadline") });
      }
    }
    const list = (title: string, rows: { title: string; reason: string }[]) => {
      if (!rows.length) return;
      const section = body.createDiv({ cls: "bt-auto-list" }); section.createEl("h4", { text: title });
      for (const row of rows) {
        const el = section.createDiv({ cls: "bt-auto-list-row" });
        el.createSpan({ text: row.title }); el.createSpan({ cls: "bt-auto-reason", text: row.reason });
      }
    };
    list(t("auto_preserved"), preview.preserved.map((x) => ({ title: x.title, reason: t(`auto_${x.reason}`) })));
    list(t("auto_not_scheduled"), preview.unscheduled.map((x) => ({ title: x.title, reason: t(x.reason === "no_time" ? "auto_no_time" : "auto_invalid_duration") })));
  }

  private async apply(): Promise<void> {
    if (!this.preview) return;
    const fresh = this.plugin.scheduling.previewAutoPlan(this.input(new Date()));
    if (previewShape(fresh) !== previewShape(this.preview)) {
      this.preview = fresh; this.render(); new Notice(t("auto_stale")); return;
    }
    try {
      await this.plugin.repository.ensureAutoPlanSchema();
      await this.plugin.scheduling.applyAutoPlan(this.preview);
      new Notice(t("auto_applied")); this.plugin.renderAll(); this.close();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && (error as { code?: unknown }).code === "stale_plan") {
        this.preview = this.plugin.scheduling.previewAutoPlan(this.input(new Date())); this.render(); new Notice(t("auto_stale"));
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
