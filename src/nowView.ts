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
  private openDisclosures = new Set<string>();
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
  private currentMenu(parent: HTMLElement, item: Exclude<NowItem, { kind: "meeting" }>): void {
    const more = this.iconButton(parent, t("more_actions"), "ellipsis", (event) => {
      event.stopPropagation();
      openPopover(more, (pop, close) => {
        if (item.kind === "task") popRow(pop, "file-text", t("now_open_note"), () => { void this.plugin.openTaskInEditor(item.task); close(); });
        popRow(pop, "plus", t("now_add_five"), () => { void this.plugin.nowController.extendCurrent(); close(); });
        if (item.kind !== "task") return;
        popRow(pop, "calendar-clock", t("now_defer_one"), () => { void this.plugin.nowController.deferCurrent(1); close(); });
        for (const days of [2, 3]) popRow(pop, "calendar-clock", t("now_defer_days", days), () => { void this.plugin.nowController.deferCurrent(days); close(); });
        popRow(pop, "skip-forward", t("now_skip"), () => { void this.plugin.nowController.skipCurrent(); close(); });
        if (item.task.priority !== "lowest") popRow(pop, "arrow-down", t("now_demote"), () => { void this.plugin.nowController.demoteAndSkipCurrent(); close(); });
      });
    });
  }
  draw(): void {
    const root = this.contentEl;
    // The controller redraws this view every second. Remember the native disclosure state before
    // replacing the DOM so an expanded section does not immediately collapse on the next tick.
    root.querySelectorAll<HTMLDetailsElement>("details[data-disclosure-key]").forEach((details) => {
      const key = details.dataset.disclosureKey;
      if (!key) return;
      if (details.open) this.openDisclosures.add(key);
      else this.openDisclosures.delete(key);
    });
    root.empty();
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
    if (snap.skipped.length) this.renderDisclosure(root, "parked", t("now_parked_today"), snap.skipped, true);
    if (snap.pastEvents.length) this.renderDisclosure(root, "past-events", t("now_past_events"), snap.pastEvents);
    if (snap.completed.length) this.renderDisclosure(root, "completed", t("now_completed_today", snap.completed.length), snap.completed, false, true);
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
    const queued = snap.status === "stopped" && item.kind === "task";
    const state = queued ? t("now_queued")
      : snap.status === "paused" || snap.status === "recovery" ? t("now_paused")
      : t(item.kind === "meeting" ? "now_meeting" : item.kind === "allocation" ? "now_work_block" : "now_now");
    const amount = t(remaining < 0 ? "now_minutes_over" : "now_minutes_left", Math.abs(remaining));
    card.createDiv({ cls: `bt-now-eyebrow${!queued && remaining < 0 ? " is-overtime" : ""}`,
      text: `${state} · ${queued ? duration(item) : amount}`.toLocaleUpperCase() });
    const title = card.createDiv({ cls: "bt-now-title", text: item.title });
    tipWhenClipped(title, title, item.title);

    const nextFixed = snap.upcoming.find((candidate) => candidate.kind !== "task" && Date.parse(candidate.start) >= now);
    let context = `${time(item.start)}–${time(item.end)}`;
    if (queued && item.task.project) context += ` · ${baseName(item.task.project)}`;
    else if (item.kind === "task" && nextFixed) context = t("now_focus_until", time(nextFixed.start));
    else if (item.kind === "task" && item.task.project) context = baseName(item.task.project);
    else if (item.kind === "allocation") {
      const active = this.plugin.workTimer.active();
      const task = active?.block_id === item.block.id ? this.plugin.index.getById(active.task_id) : null;
      if (task) context = task.title;
    }
    card.createDiv({ cls: "bt-now-context", text: context });

    // A queued block is only a suggestion until Focus or Blitz starts its timer. Avoid showing
    // time-based progress here, since that makes scheduled-but-idle work look active.
    if (queued) return;

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
    if (snap.status === "stopped") {
      this.button(controls, t("now_focus"), () => void this.plugin.nowController.start(false), true, "timer");
      this.button(controls, t("now_blitz"), () => void this.plugin.nowController.start(true), true, "zap");
      return;
    }
    this.button(controls, t(snap.blitz ? "now_stop_blitz" : "now_stop_focus"), () => void this.plugin.nowController.stop(), false, "square");
    if (!snap.current) return;
    const done = snap.current.kind === "meeting"
      ? t(Date.now() < Date.parse(snap.current.end) ? "now_end_early" : "now_finished")
      : t(snap.current.kind === "allocation" ? "now_finish_block" : "now_done");
    this.button(controls, done, () => void this.plugin.nowController.completeCurrent(), true, "check");
    if (snap.current.kind !== "meeting") this.currentMenu(controls, snap.current);
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
      if (matches.length) this.renderDisclosure(root, `day-part:${part}`, t(`now_${part}`), matches);
    }
  }
  private renderAllDay(root: HTMLElement, snap: NowSnapshot): void {
    const details = root.createEl("details", { cls: "bt-now-disclosure", attr: { "data-disclosure-key": "all-day" } });
    details.open = this.openDisclosures.has("all-day");
    const summary = details.createEl("summary"); summary.createSpan({ text: t("now_all_day") }); summary.createSpan({ text: String(snap.allDay.length) });
    const body = details.createDiv({ cls: "bt-now-disclosure-body" });
    for (const item of snap.allDay) body.createDiv({ cls: "bt-now-context", text: "title" in item ? item.title : t("now_all_day") });
  }
  private renderDisclosure(root: HTMLElement, key: string, title: string, items: NowItem[], skipped = false, completed = false): void {
    const details = root.createEl("details", { cls: `bt-now-disclosure${completed ? " is-completed" : ""}`, attr: { "data-disclosure-key": key } });
    details.open = this.openDisclosures.has(key);
    const summary = details.createEl("summary"); summary.createSpan({ text: title }); summary.createSpan({ text: String(items.length) });
    const body = details.createDiv({ cls: "bt-now-disclosure-body" });
    for (const item of items) this.renderRow(body, item, skipped);
  }
  private renderRow(parent: HTMLElement, item: NowItem, skipped = false, markMissed = false): void {
    const now = Date.now(), missed = markMissed && Date.parse(item.end) <= now;
    const row = parent.createDiv({ cls: `bt-now-row${missed ? " is-missed" : ""}` });
    const when = row.createDiv({ cls: "bt-now-row-time" });
    const timeLabel = when.createSpan({ cls: "bt-now-row-time-label", text: time(item.start) });
    if (item.kind !== "task") { when.addClass("is-fixed"); setIcon(timeLabel.createSpan(), item.kind === "meeting" ? "video" : "lock"); }
    if (missed) { const warning = timeLabel.createSpan(); tip(warning, t("now_waiting")); setIcon(warning, "triangle-alert"); }
    if (!skipped && Date.parse(item.start) > now) {
      when.addClass("has-start-action");
      const start = when.createEl("button", { cls: "bt-now-row-start", text: t(item.kind === "task" ? "now_focus" : "now_start") });
      start.onclick = (event) => {
        event.stopPropagation();
        if (item.kind === "allocation") void this.plugin.startTimeBlock(item.block);
        else void this.plugin.nowController.startEarly(item.key);
      };
    }
    const body = row.createDiv({ cls: "bt-now-row-body" });
    const title = body.createDiv({ cls: "bt-now-row-title", text: item.title });
    tipWhenClipped(row, title, item.title);
    body.createDiv({ cls: "bt-now-row-meta", text: `${duration(item)} · ${itemType(item)}` });
    if (skipped && item.kind === "task") this.iconButton(row, t("now_return"), "rotate-ccw", () => void this.plugin.nowController.returnTo(item.task.id));
  }
}
