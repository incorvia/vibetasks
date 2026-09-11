import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { NowItem, NowSnapshot } from "./nowController";
import { AutoPlanModal } from "./autoPlanModal";
import { baseName } from "./taskService";
import { t } from "./i18n";
import { openPopover, popRow } from "./popover";
import { tip, tipWhenClipped } from "./tooltip";

export const VIEW_NOW = "opal-tasks-now";

type DayPart = "morning" | "afternoon" | "evening";
const UP_NEXT_LIMIT = 3;

const clock = (seconds: number): string => {
  const absolute = Math.abs(Math.round(seconds)), hours = Math.floor(absolute / 3600);
  const value = `${hours ? String(hours).padStart(2, "0") + ":" : ""}${String(Math.floor(absolute / 60) % 60).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return seconds < 0 ? `+${value}` : value;
};
const time = (stamp: string): string => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
const duration = (item: NowItem): string => `${Math.max(1, Math.round((Date.parse(item.end) - Date.parse(item.start)) / 60000))}m`;
const dayPart = (item: NowItem): DayPart => {
  const hour = new Date(item.start).getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
};
const itemType = (item: NowItem): string => t(item.kind === "meeting" ? "now_meeting" : "now_focus");

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
  private button(parent: HTMLElement, label: string, action: () => void, primary = false, icon?: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: `bt-now-btn${primary ? " mod-cta" : ""}` });
    if (icon) setIcon(button.createSpan({ cls: "bt-now-btn-icon" }), icon);
    button.createSpan({ text: label }); button.onclick = action; return button;
  }
  private iconButton(parent: HTMLElement, label: string, icon: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "bt-now-icon-btn" });
    tip(button, label); setIcon(button, icon); button.onclick = action; return button;
  }
  private taskMenu(parent: HTMLElement, item: Extract<NowItem, { kind: "task" }>): void {
    const more = this.iconButton(parent, t("more_actions"), "ellipsis", (event) => {
      event.stopPropagation();
      openPopover(more, (pop, close) => {
        popRow(pop, "file-text", t("now_open_note"), () => { void this.plugin.openTaskInEditor(item.task); close(); });
        if (item.task.priority !== "lowest") popRow(pop, "arrow-down", t("now_demote"), () => { void this.plugin.nowController.demoteAndSkipCurrent(); close(); });
        popRow(pop, "calendar-clock", t("now_defer_one"), () => { void this.plugin.nowController.deferCurrent(1); close(); });
        for (const days of [2, 3]) popRow(pop, "calendar-clock", t("now_defer_days", days), () => { void this.plugin.nowController.deferCurrent(days); close(); });
      });
    });
  }
  draw(): void {
    const root = this.contentEl; root.empty();
    const snap = this.plugin.nowController.snapshot(), now = Date.now();
    const header = root.createDiv({ cls: "bt-now-head" });
    header.createDiv({ cls: "bt-now-heading", text: t("view_today") });
    const replan = header.createEl("button", { cls: "bt-now-replan" });
    replan.createSpan({ text: t("now_replan") });
    replan.onclick = () => new AutoPlanModal(this.plugin).open();

    if (snap.error) root.createDiv({ cls: "bt-now-error", text: snap.error });
    if (snap.conflicts.length) this.renderConflicts(root, snap);

    const card = root.createDiv({ cls: "bt-now-current" });
    if (!snap.current) this.renderEmpty(card, snap, now);
    else this.renderCurrent(card, snap.current, snap, now);
    this.renderControls(root, snap);

    const immediate = snap.upcoming.slice(0, UP_NEXT_LIMIT);
    const later = snap.upcoming.slice(UP_NEXT_LIMIT);
    this.renderList(root, t("now_up_next"), immediate, false, snap.upcoming.length);
    this.renderDayParts(root, later);
    if (snap.allDay.length) this.renderAllDay(root, snap);
    if (snap.skipped.length) this.renderDisclosure(root, t("now_parked_today"), snap.skipped, true);
    if (snap.pastEvents.length) this.renderDisclosure(root, t("now_past_events"), snap.pastEvents);
    if (snap.completed.length) this.renderDisclosure(root, t("now_completed_today", snap.completed.length), snap.completed, false, true);
  }
  private renderConflicts(root: HTMLElement, snap: NowSnapshot): void {
    root.createDiv({ cls: "bt-now-error", text: t("now_overlap") });
    const choices = this.section(root, t("now_now"), String(snap.conflicts.length));
    for (const item of snap.conflicts) {
      const row = choices.createDiv({ cls: "bt-now-row" });
      row.createDiv({ cls: "bt-now-row-body", text: item.title });
      this.button(row, t("now_now"), () => void this.plugin.nowController.chooseCommitment(item.key));
    }
  }
  private renderEmpty(card: HTMLElement, snap: NowSnapshot, now: number): void {
    const next = snap.upcoming.find((item) => Date.parse(item.start) > now);
    card.createDiv({ cls: "bt-now-eyebrow", text: t(snap.status === "waiting" ? "now_waiting" : "now_now").toLocaleUpperCase() });
    card.createDiv({ cls: "bt-now-title", text: next ? t("now_free_until", time(next.start)) : t("now_clear") });
    if (next) card.createDiv({ cls: "bt-now-context", text: next.title });
    else if (!snap.upcoming.length) this.button(card, t("now_auto_plan_today"), () => new AutoPlanModal(this.plugin).open(), true, "wand-sparkles");
  }
  private renderCurrent(card: HTMLElement, item: NowItem, snap: NowSnapshot, now: number): void {
    const remaining = Math.ceil((Date.parse(item.end) - now) / 60000);
    const state = snap.status === "paused" || snap.status === "recovery" ? t("now_paused")
      : t(item.kind === "meeting" ? "now_meeting" : item.kind === "allocation" ? "now_work_block" : "now_now");
    const amount = t(remaining < 0 ? "now_minutes_over" : "now_minutes_left", Math.abs(remaining));
    card.createDiv({ cls: `bt-now-eyebrow${remaining < 0 ? " is-overtime" : ""}`, text: `${state} · ${amount}`.toLocaleUpperCase() });
    const title = card.createDiv({ cls: "bt-now-title", text: item.title });
    tipWhenClipped(title, title, item.title);

    const nextFixed = snap.upcoming.find((candidate) => candidate.kind !== "task" && Date.parse(candidate.start) >= now);
    let context = `${time(item.start)}–${time(item.end)}`;
    if (item.kind === "task" && nextFixed) context = t("now_focus_until", time(nextFixed.start));
    else if (item.kind === "task" && item.task.project) context = baseName(item.task.project);
    else if (item.kind === "allocation") {
      const active = this.plugin.workTimer.active();
      const task = active?.block_id === item.block.id ? this.plugin.index.getById(active.task_id) : null;
      if (task) context = task.title;
    }
    card.createDiv({ cls: "bt-now-context", text: context });

    const span = Math.max(1, Date.parse(item.end) - Date.parse(item.start));
    const progress = Math.min(1, Math.max(0, (now - Date.parse(item.start)) / span));
    const track = card.createDiv({ cls: `bt-now-progress${remaining < 0 ? " is-overtime" : ""}`, attr: { role: "progressbar", "aria-label": item.title, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(progress * 100)) } });
    track.createDiv({ cls: "bt-now-progress-value" }).style.width = `${progress * 100}%`;
    const active = this.plugin.workTimer.active();
    if (item.kind === "task" && active?.task_id === item.task.id) {
      card.createDiv({ cls: "bt-now-elapsed", text: t("now_focused_session", clock((now - Date.parse(active.started_at)) / 1000)) });
    }
  }
  private renderControls(root: HTMLElement, snap: NowSnapshot): void {
    const controls = root.createDiv({ cls: "bt-now-controls" });
    if (snap.status === "stopped") this.button(controls, t("now_start_day"), () => void this.plugin.nowController.start(), true);
    else if (snap.status === "paused" || snap.status === "recovery") this.button(controls, t(snap.current && snap.current.kind !== "meeting" ? "now_resume_focus" : "now_resume_day"), () => void this.plugin.nowController.resume(), true);
    else this.button(controls, t("now_pause"), () => void this.plugin.nowController.pause(), true);

    if (snap.current) {
      const done = snap.current.kind === "meeting"
        ? t(Date.now() < Date.parse(snap.current.end) ? "now_end_early" : "now_finished")
        : t(snap.current.kind === "allocation" ? "now_finish_block" : "now_done");
      this.button(controls, done, () => void this.plugin.nowController.completeCurrent());
      if (snap.current.kind !== "meeting") this.button(controls, t("now_add_five"), () => void this.plugin.nowController.extendCurrent());
      if (snap.current.kind === "task") this.taskMenu(controls, snap.current);
    }

    if (snap.status !== "stopped" || snap.canUndo) {
      const secondary = root.createDiv({ cls: "bt-now-secondary-controls" });
      if (snap.status !== "stopped") this.button(secondary, t("now_stop_day"), () => void this.plugin.nowController.stop(), false, "square");
      if (snap.canUndo) this.button(secondary, t("now_undo_schedule"), () => void this.plugin.nowController.undoSchedule(), false, "undo-2");
    }
  }
  private section(root: HTMLElement, title: string, meta?: string): HTMLElement {
    const wrap = root.createDiv({ cls: "bt-now-section" });
    const head = wrap.createDiv({ cls: "bt-now-section-head" }); head.createSpan({ text: title });
    if (meta) head.createSpan({ text: meta });
    return wrap;
  }
  private renderList(root: HTMLElement, title: string, items: NowItem[], skipped = false, total = items.length): void {
    if (!items.length) return;
    const section = this.section(root, title, String(total));
    for (const item of items) this.renderRow(section, item, skipped, !skipped);
  }
  private renderDayParts(root: HTMLElement, items: NowItem[]): void {
    for (const part of ["morning", "afternoon", "evening"] as const) {
      const matches = items.filter((item) => dayPart(item) === part);
      if (matches.length) this.renderDisclosure(root, t(`now_${part}`), matches);
    }
  }
  private renderAllDay(root: HTMLElement, snap: NowSnapshot): void {
    const details = root.createEl("details", { cls: "bt-now-disclosure" });
    const summary = details.createEl("summary"); summary.createSpan({ text: t("now_all_day") }); summary.createSpan({ text: String(snap.allDay.length) });
    const body = details.createDiv({ cls: "bt-now-disclosure-body" });
    for (const item of snap.allDay) body.createDiv({ cls: "bt-now-context", text: "title" in item ? item.title : t("now_all_day") });
  }
  private renderDisclosure(root: HTMLElement, title: string, items: NowItem[], skipped = false, completed = false): void {
    const details = root.createEl("details", { cls: `bt-now-disclosure${completed ? " is-completed" : ""}` });
    const summary = details.createEl("summary"); summary.createSpan({ text: title }); summary.createSpan({ text: String(items.length) });
    const body = details.createDiv({ cls: "bt-now-disclosure-body" });
    for (const item of items) this.renderRow(body, item, skipped);
  }
  private renderRow(parent: HTMLElement, item: NowItem, skipped = false, markMissed = false): void {
    const missed = markMissed && Date.parse(item.end) <= Date.now();
    const row = parent.createDiv({ cls: `bt-now-row${missed ? " is-missed" : ""}` });
    const when = row.createDiv({ cls: "bt-now-row-time", text: time(item.start) });
    if (item.kind !== "task") { when.addClass("is-fixed"); setIcon(when.createSpan(), item.kind === "meeting" ? "video" : "lock"); }
    if (missed) { const warning = when.createSpan(); tip(warning, t("now_waiting")); setIcon(warning, "triangle-alert"); }
    const body = row.createDiv({ cls: "bt-now-row-body" });
    const title = body.createDiv({ cls: "bt-now-row-title", text: item.title });
    tipWhenClipped(row, title, item.title);
    body.createDiv({ cls: "bt-now-row-meta", text: `${duration(item)} · ${itemType(item)}` });
    if (skipped && item.kind === "task") this.iconButton(row, t("now_return"), "rotate-ccw", () => void this.plugin.nowController.returnTo(item.task.id));
  }
}
