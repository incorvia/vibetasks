import { Modal } from "obsidian";
import type OpalTasksPlugin from "./main";
import { formatDuration, localDateTime } from "./format";
import type { Task, WorkSession } from "./types";

export class TimeRecordModal extends Modal {
  constructor(private plugin: OpalTasksPlugin, private task: Task | undefined, private session?: WorkSession) { super(plugin.app); }

  onOpen(): void {
    const el = this.contentEl; el.addClass("bt-time-record-modal");
    el.createEl("h2", { text: this.session ? "Edit time record" : "Log time" });
    el.createEl("p", { text: this.session?.task_title_snapshot ?? this.task?.title ?? "Task" });
    const end = new Date(); end.setSeconds(0, 0);
    const initialStart = this.session?.started_at ?? new Date(end.getTime() - 30 * 60_000).toISOString();
    const initialEnd = this.session?.ended_at ?? end.toISOString();
    const field = (label: string, value: string) => {
      const wrapper = el.createEl("label", { cls: "bt-time-record-field" });
      wrapper.createSpan({ text: label });
      const input = wrapper.createEl("input", { type: "datetime-local", attr: { step: "1", required: "true" } });
      const date = new Date(value);
      input.value = `${localDateTime(value)}:${String(date.getSeconds()).padStart(2, "0")}`;
      return input;
    };
    const start = field("Started", initialStart), finish = field("Ended", initialEnd);
    const startValue = start.value, endValue = finish.value;
    const preview = el.createDiv({ cls: "bt-time-record-preview" });
    const updatePreview = () => {
      const minutes = (Date.parse(finish.value) - Date.parse(start.value)) / 60_000;
      preview.setText(Number.isFinite(minutes) && minutes > 0 ? `Duration · ${formatDuration(Math.round(minutes))}` : "End time must be after start time.");
    };
    start.oninput = finish.oninput = updatePreview; updatePreview();
    el.createEl("p", { cls: "bt-time-dashboard-muted", text: "Times use your local timezone. The record belongs to the day it started." });
    const error = el.createDiv({ cls: "bt-time-record-error", attr: { role: "alert" } });
    const actions = el.createDiv({ cls: "bt-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" }); cancel.onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mod-cta", text: "Save time" });
    save.onclick = async () => {
      save.disabled = true; cancel.disabled = true; error.empty();
      try {
        const input = { started_at: start.value === startValue ? initialStart : start.value, ended_at: finish.value === endValue ? initialEnd : finish.value };
        if (this.session) await this.plugin.workTimer.editRecordedTime(this.session.id, input, { started_at: initialStart, ended_at: initialEnd });
        else if (this.task) await this.plugin.workTimer.recordTime(this.task.id, input);
        this.close();
      } catch (cause) {
        error.setText(cause instanceof Error ? cause.message : "Could not save time. Please try again.");
        save.disabled = false; cancel.disabled = false;
      }
    };
  }
  onClose(): void { this.contentEl.empty(); }
}
