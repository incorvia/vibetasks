import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { NowItem } from "./nowController";
import { AutoPlanModal } from "./autoPlanModal";
import { baseName } from "./taskService";
import { t } from "./i18n";
import { openPopover, popRow } from "./popover";

export const VIEW_NOW = "opal-tasks-now";

const clock = (seconds: number): string => {
  const absolute = Math.abs(Math.round(seconds)), hours = Math.floor(absolute / 3600);
  const value = `${hours ? String(hours).padStart(2, "0") + ":" : ""}${String(Math.floor(absolute / 60) % 60).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return seconds < 0 ? `+${value}` : value;
};
const time = (stamp: string): string => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
const duration = (item: NowItem): string => `${Math.max(1, Math.round((Date.parse(item.end) - Date.parse(item.start)) / 60000))}m`;

export class NowView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: OpalTasksPlugin) { super(leaf); }
  getViewType(): string { return VIEW_NOW; }
  getDisplayText(): string { return t("now_title"); }
  getIcon(): string { return "timer"; }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("bt-now-view");
    this.unsubscribe = this.plugin.nowController.subscribe(() => this.draw());
    this.plugin.gcalFeed.setRange(this.today(), this.today());
  }
  async onClose(): Promise<void> { this.unsubscribe?.(); this.unsubscribe = null; }
  private today(): string { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  private button(parent: HTMLElement, label: string, icon: string, action: () => void, primary = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: `bt-now-btn${primary ? " mod-cta" : ""}` });
    setIcon(button.createSpan(), icon); button.createSpan({ text: label }); button.onclick = action; return button;
  }
  private taskAction(parent: HTMLElement, item: Extract<NowItem, { kind: "task" }>): void {
    const split = parent.createDiv({ cls: "bt-now-split" });
    const done = this.button(split, t("now_done"), "check", () => void this.plugin.nowController.completeCurrent(), true);
    done.addClass("bt-now-split-main");
    const more = split.createEl("button", { cls: "bt-now-btn mod-cta bt-now-split-more", attr: { "aria-label": t("more_actions") } });
    setIcon(more, "chevron-down");
    more.onclick = (event) => {
      event.stopPropagation();
      openPopover(more, (pop, close) => {
        if (item.task.priority !== "lowest") popRow(pop, "arrow-down", t("now_demote"), () => { void this.plugin.nowController.demoteAndSkipCurrent(); close(); });
        popRow(pop, "archive", t("now_park_today"), () => { void this.plugin.nowController.parkCurrent(); close(); });
      });
    };
  }
  draw(): void {
    const root = this.contentEl; root.empty();
    const snap = this.plugin.nowController.snapshot(), now = Date.now();
    const header = root.createDiv({ cls: "bt-now-head" });
    header.createDiv({ cls: "bt-now-heading", text: t("view_today") });
    const replan = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("now_replan") } });
    setIcon(replan, "wand-sparkles"); replan.onclick = () => new AutoPlanModal(this.plugin).open();

    if (snap.error) root.createDiv({ cls: "bt-now-error", text: snap.error });
    if (snap.conflicts.length) {
      root.createDiv({ cls: "bt-now-error", text: t("now_overlap") });
      const choices = this.section(root, t("now_now"), snap.conflicts.length);
      for (const item of snap.conflicts) {
        const row = choices.createDiv({ cls: "bt-now-row" });
        row.createDiv({ cls: "bt-now-row-body", text: item.title });
        this.button(row, t("now_now"), "arrow-right", () => void this.plugin.nowController.chooseCommitment(item.key));
      }
    }

    const card = root.createDiv({ cls: "bt-now-current" });
    if (!snap.current) {
      const next = snap.upcoming.find((item) => Date.parse(item.start) > now);
      card.createDiv({ cls: "bt-now-eyebrow", text: t(snap.status === "waiting" ? "now_waiting" : "now_now").toLocaleUpperCase() });
      card.createDiv({ cls: "bt-now-title", text: next ? t("now_free_until", time(next.start)) : t("now_clear") });
      if (!snap.upcoming.length) this.button(card, t("now_auto_plan_today"), "wand-sparkles", () => new AutoPlanModal(this.plugin).open(), true);
    } else this.renderCurrent(card, snap.current, now);

    const controls = root.createDiv({ cls: "bt-now-day-controls" });
    if (snap.status === "stopped") this.button(controls, t("now_start_day"), "play", () => void this.plugin.nowController.start(), true);
    else if (snap.status === "paused" || snap.status === "recovery") this.button(controls, t("now_resume_day"), "play", () => void this.plugin.nowController.resume(), true);
    else this.button(controls, t("now_pause"), "pause", () => void this.plugin.nowController.pause());
    if (snap.status !== "stopped") this.button(controls, t("now_stop_day"), "square", () => void this.plugin.nowController.stop());
    if (snap.canUndo) this.button(controls, t("now_undo_schedule"), "undo-2", () => void this.plugin.nowController.undoSchedule());

    if (snap.allDay.length) {
      const section = this.section(root, t("now_all_day"), snap.allDay.length);
      for (const item of snap.allDay) section.createDiv({ cls: "bt-now-context", text: "title" in item ? item.title : "All-day item" });
    }
    this.renderList(root, t("now_up_next"), snap.upcoming);
    if (snap.skipped.length) this.renderList(root, t("now_parked_today"), snap.skipped, true);
    if (snap.pastEvents.length) {
      const details = root.createEl("details", { cls: "bt-now-completed bt-now-past-events" });
      details.createEl("summary", { text: `${t("now_past_events")} · ${snap.pastEvents.length}` });
      for (const item of snap.pastEvents) this.renderRow(details, item);
    }
    if (snap.completed.length) {
      const details = root.createEl("details", { cls: "bt-now-completed" });
      details.createEl("summary", { text: t("now_completed_today", snap.completed.length) });
      for (const item of snap.completed) this.renderRow(details, item);
    }
  }
  private renderCurrent(card: HTMLElement, item: NowItem, now: number): void {
    card.createDiv({ cls: "bt-now-eyebrow", text: t(item.kind === "meeting" ? "now_meeting" : item.kind === "allocation" ? "now_work_block" : "now_now").toLocaleUpperCase() });
    card.createDiv({ cls: "bt-now-title", text: item.title });
    if (item.kind === "task" && item.task.project) card.createDiv({ cls: "bt-now-project", text: baseName(item.task.project) });
    const active = this.plugin.workTimer.active();
    if (item.kind === "allocation" && active?.block_id === item.block.id) {
      const task = this.plugin.index.getById(active.task_id); if (task) card.createDiv({ cls: "bt-now-project", text: task.title });
    }
    card.createDiv({ cls: `bt-now-clock${now > Date.parse(item.end) ? " is-overtime" : ""}`, text: clock((Date.parse(item.end) - now) / 1000) });
    if (item.kind === "task" && active?.task_id === item.task.id) {
      card.createDiv({ cls: "bt-now-elapsed", text: t("now_focused_session", clock((now - Date.parse(active.started_at)) / 1000)) });
    }
    const actions = card.createDiv({ cls: "bt-now-actions" });
    if (item.kind === "task") {
      this.taskAction(actions, item);
      this.button(actions, t("now_open_note"), "file-text", () => void this.plugin.openTaskInEditor(item.task));
    } else {
      this.button(actions, item.kind === "meeting" ? t(now < Date.parse(item.end) ? "now_end_early" : "now_finished") : t("now_finish_block"), "check", () => void this.plugin.nowController.completeCurrent(), true);
      if (item.kind === "allocation" && !this.plugin.workTimer.active()) this.button(actions, t("now_start_block"), "play", () => void this.plugin.startTimeBlock(item.block));
    }
  }
  private section(root: HTMLElement, title: string, count: number): HTMLElement {
    const wrap = root.createDiv({ cls: "bt-now-section" });
    const head = wrap.createDiv({ cls: "bt-now-section-head" }); head.createSpan({ text: title }); head.createSpan({ text: String(count) });
    return wrap;
  }
  private renderList(root: HTMLElement, title: string, items: NowItem[], skipped = false): void {
    if (!items.length) return;
    const section = this.section(root, title, items.length);
    for (const item of items) this.renderRow(section, item, skipped, !skipped);
  }
  private renderRow(parent: HTMLElement, item: NowItem, skipped = false, markMissed = false): void {
    const missed = markMissed && Date.parse(item.end) <= Date.now();
    const row = parent.createDiv({ cls: `bt-now-row${missed ? " is-missed" : ""}` });
    const when = row.createDiv({ cls: "bt-now-row-time", text: time(item.start) });
    if (item.kind !== "task") { when.addClass("is-fixed"); setIcon(when.createSpan(), item.kind === "meeting" ? "video" : "lock"); }
    if (missed) { const warning = when.createSpan({ attr: { "aria-label": t("now_waiting") } }); setIcon(warning, "triangle-alert"); }
    const body = row.createDiv({ cls: "bt-now-row-body" }); body.createDiv({ cls: "bt-now-row-title", text: item.title }); body.createDiv({ cls: "bt-now-row-meta", text: duration(item) });
    if (skipped && item.kind === "task") this.button(row, t("now_return"), "rotate-ccw", () => void this.plugin.nowController.returnTo(item.task.id));
  }
}
