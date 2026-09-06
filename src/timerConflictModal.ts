import { Modal } from "obsidian";
import type VibeTaskPlugin from "./main";

export class TimerConflictModal extends Modal {
  constructor(private plugin: VibeTaskPlugin) { super(plugin.app); }
  onOpen(): void { this.draw(); }
  private draw(): void {
    const el = this.contentEl; el.empty(); el.createEl("h2", { text: "Resolve timer conflict" });
    el.createDiv({ text: "Multiple devices started timers before the vault synchronized. Keep one session running; the others will be closed now." });
    for (const session of this.plugin.workTimer.conflicts()) {
      const row = el.createDiv({ cls: "bt-actions" });
      const button = row.createEl("button", { text: `Keep ${session.task_title_snapshot} · ${new Date(session.started_at).toLocaleString()}` });
      button.onclick = () => { void this.plugin.workTimer.resolveConflicts(session.id).then(() => this.close()); };
      const discard = row.createEl("button", { text: "Discard" });
      discard.onclick = () => { void this.plugin.workTimer.discardConflict(session.id).then(() => this.plugin.workTimer.needsResolution() ? this.draw() : this.close()); };
    }
    const stop = el.createEl("button", { text: "Stop all timers" }); stop.onclick = () => { void this.plugin.workTimer.resolveConflicts(null).then(() => this.close()); };
  }
  onClose(): void { this.contentEl.empty(); }
}
