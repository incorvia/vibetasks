import { Modal, Notice } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { TimeBlock, TimeBlockKind, TimeBlockMode, TimeBlockSelector, TimeScope, TimeScopeType } from "./types";
import { parseDuration } from "./datePicker";
import { formatDuration } from "./format";

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export class TimeBlockModal extends Modal {
  constructor(private plugin: OpalTasksPlugin, private initialStart: Date, private initialScope?: TimeScope, private existing?: TimeBlock,
    private kind: TimeBlockKind = existing?.kind ?? "allocation") { super(plugin.app); }

  onOpen(): void {
    const { contentEl } = this; contentEl.empty(); contentEl.addClass("bt-time-block-modal");
    const schedule = this.kind === "task_schedule";
    contentEl.createEl("h2", { text: this.existing ? (schedule ? "Edit task schedule" : "Edit time block") : (schedule ? "Schedule task" : "New time block") });
    const start = contentEl.createEl("input", { type: "datetime-local" }); start.value = localInput(this.initialStart);
    const duration = contentEl.createEl("input", { type: "text", attr: { placeholder: "30m · 1h · 3h" } }); duration.value = this.existing ? formatDuration(this.existing.duration) : "30m";
    const scopeType = contentEl.createEl("select");
    for (const type of ["task", "project", "area"] as TimeScopeType[]) scopeType.createEl("option", { value: type, text: type[0].toUpperCase() + type.slice(1) });
    const scopeId = contentEl.createEl("select");
    const mode = contentEl.createEl("select"); mode.createEl("option", { value: "focus", text: "Focus" }); mode.createEl("option", { value: "blitz", text: "Blitz" }); mode.value = this.existing?.mode ?? "focus";
    if (schedule) { scopeType.disabled = true; mode.disabled = true; }
    const renderScopes = async () => {
      scopeId.empty(); const type = scopeType.value as TimeScopeType;
      if (type === "task") for (const task of this.plugin.index.open()) scopeId.createEl("option", { value: task.id, text: task.title });
      else for (const record of await this.plugin.repository.list(type)) scopeId.createEl("option", {
        value: record.id,
        text: typeof record.frontmatter.title === "string" ? record.frontmatter.title : record.id,
      });
      if (this.initialScope?.type === type) scopeId.value = this.initialScope.id;
    };
    scopeType.value = this.initialScope?.type ?? "task"; scopeType.onchange = () => void renderScopes(); void renderScopes();
    const actions = contentEl.createDiv({ cls: "bt-actions" });
    if (this.existing) {
      const remove = actions.createEl("button", { text: schedule ? "Unschedule" : "Cancel block" });
      remove.onclick = () => {
        const operation = schedule
          ? this.plugin.scheduling.unscheduleTask(this.existing!.scope.id)
          : this.plugin.scheduling.cancelBlock(this.existing!.id);
        void operation.then(() => this.close());
      };
    }
    const cancel = actions.createEl("button", { text: "Cancel" }); cancel.onclick = () => this.close();
    const save = actions.createEl("button", { cls: "mod-cta", text: this.existing ? "Save" : (schedule ? "Schedule task" : "Create block") });
    save.onclick = async () => {
      const mins = parseDuration(duration.value), date = new Date(start.value);
      if (!mins || Number.isNaN(date.getTime()) || !scopeId.value) { new Notice("Choose a start, duration, and scope."); return; }
      const option = scopeId.selectedOptions[0]; const scope: TimeScope = { type: scopeType.value as TimeScopeType, id: scopeId.value, title_snapshot: option?.text ?? scopeId.value };
      const blockMode = schedule ? "focus" : mode.value as TimeBlockMode; const selector: TimeBlockSelector = blockMode === "blitz" ? "next" : "manual";
      if (schedule && scope.type === "task") {
        const task = this.plugin.index.getById(scope.id);
        if (!task) { new Notice("The task no longer exists."); return; }
        await this.plugin.scheduling.scheduleTask(task.id, { start: date, duration: mins, source: "manual" });
      } else if (this.existing) await this.plugin.scheduling.updateAllocation(this.existing.id, { start: date, duration: mins, scope, mode: blockMode, selector });
      else await this.plugin.scheduling.createAllocation({ start: date, duration: mins, scope, mode: blockMode, selector, source: "manual" });
      this.close();
    };
  }
  onClose(): void { this.contentEl.empty(); }
}
