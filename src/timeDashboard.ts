import { Modal, TFile } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { WorkSession } from "./types";
import { formatDuration } from "./format";

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const sessionMinutes = (s: WorkSession) => Math.round((s.elapsed ?? (s.ended_at ? Math.max(0, (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000) : 0)) / 60);

export class TimeDashboardModal extends Modal {
  private from = day(new Date()); private to = this.from; private currentHierarchy = false;
  constructor(private plugin: OpalTasksPlugin) { super(plugin.app); }
  onOpen(): void { this.draw(); }
  onClose(): void { this.contentEl.empty(); }

  private draw(): void {
    const el = this.contentEl; el.empty(); el.addClass("bt-time-dashboard"); el.createEl("h2", { text: "Time dashboard" });
    const ranges = el.createDiv({ cls: "bt-tabs" });
    const setRange = (kind: "day" | "week" | "month") => {
      const now = new Date(); let from = new Date(now), to = new Date(now);
      if (kind === "week") { from.setDate(now.getDate() - ((now.getDay() + 6) % 7)); to = new Date(from); to.setDate(from.getDate() + 6); }
      if (kind === "month") { from = new Date(now.getFullYear(), now.getMonth(), 1); to = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
      this.from = day(from); this.to = day(to); this.draw();
    };
    for (const kind of ["day", "week", "month"] as const) { const b = ranges.createEl("button", { cls: "bt-tab", text: kind[0].toUpperCase() + kind.slice(1) }); b.onclick = () => setRange(kind); }
    const custom = el.createDiv({ cls: "bt-time-dashboard-range" });
    const from = custom.createEl("input", { type: "date" }); from.value = this.from;
    const to = custom.createEl("input", { type: "date" }); to.value = this.to;
    from.onchange = () => { this.from = from.value; this.draw(); }; to.onchange = () => { this.to = to.value; this.draw(); };
    const hierarchy = custom.createEl("label"); const toggle = hierarchy.createEl("input", { type: "checkbox" }); toggle.checked = this.currentHierarchy;
    hierarchy.appendText(" Current hierarchy"); toggle.onchange = () => { this.currentHierarchy = toggle.checked; this.draw(); };

    const totals = this.plugin.timeStore.totals(this.from, this.to);
    const sessions = this.plugin.timeStore.sessions().filter((s) => s.started_at.slice(0, 10) >= this.from && s.started_at.slice(0, 10) <= this.to);
    const taskIds = new Set(sessions.map((s) => s.task_id));
    for (const block of this.plugin.timeStore.blocksIn(this.from, this.to)) if (block.scope.type === "task") taskIds.add(block.scope.id);
    const estimate = this.plugin.index.all().filter((t) => taskIds.has(t.id)).reduce((n, t) => n + (t.estimate ?? 0), 0);
    const stats = el.createDiv({ cls: "bt-time-dashboard-stats" });
    for (const [label, value] of [["Planned", totals.planned], ["Actual", totals.actual], ["Estimate", estimate], ["Remaining", Math.max(0, estimate - totals.actual)], ["Variance", totals.actual - totals.planned]] as [string, number][]) {
      const card = stats.createDiv({ cls: "bt-time-dashboard-stat" }); card.createDiv({ text: label }); card.createEl("strong", { text: formatDuration(Math.abs(value)) + (label === "Variance" && value < 0 ? " under" : label === "Variance" && value > 0 ? " over" : "") });
    }
    const groups = new Map<string, Map<string, WorkSession[]>>();
    for (const session of sessions) {
      const task = this.plugin.index.all().find((t) => t.id === session.task_id);
      let area = session.area_title_snapshot ?? "Unassigned area";
      let project = session.project_title_snapshot ?? "Unassigned project";
      if (this.currentHierarchy && task?.project) {
        const file = this.plugin.app.vault.getAbstractFileByPath(task.project);
        const fm = file instanceof TFile ? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter : null;
        const title = typeof fm?.title === "string" ? fm.title : file instanceof TFile ? file.basename : task.project;
        if (fm?.type === "area") { area = title; project = "Direct tasks"; }
        else {
          project = title;
          if (typeof fm?.opal_area_id === "string") {
            const areaFile = this.app.vault.getMarkdownFiles().find((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.id === fm.opal_area_id);
            const areaFm = areaFile ? this.app.metadataCache.getFileCache(areaFile)?.frontmatter : null;
            area = typeof areaFm?.title === "string" ? areaFm.title : fm.opal_area_id;
          } else if (typeof fm?.area === "string") area = fm.area.replace(/^\[\[|\]\]$/g, "").split("|")[0];
          else area = "Unassigned area";
        }
      } else if (this.currentHierarchy) { area = "Unassigned area"; project = "Unassigned project"; }
      const projects = groups.get(area) ?? new Map<string, WorkSession[]>();
      const list = projects.get(project) ?? []; list.push(session); projects.set(project, list); groups.set(area, projects);
    }
    for (const [areaName, projects] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const area = el.createEl("details"); const areaMinutes = [...projects.values()].flat().reduce((n, s) => n + sessionMinutes(s), 0);
      area.createEl("summary", { text: `${areaName} · ${formatDuration(areaMinutes)}` });
      for (const [projectName, list] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
        const project = area.createEl("details"); const minutes = list.reduce((n, s) => n + sessionMinutes(s), 0);
        project.createEl("summary", { text: `${projectName} · ${formatDuration(minutes)}` });
        const tasks = new Map<string, WorkSession[]>(); for (const s of list) { const entries = tasks.get(s.task_id) ?? []; entries.push(s); tasks.set(s.task_id, entries); }
        for (const entries of tasks.values()) {
          const task = project.createEl("details"); task.createEl("summary", { text: `${entries[0].task_title_snapshot} · ${formatDuration(entries.reduce((n, s) => n + sessionMinutes(s), 0))}` });
          for (const s of entries) task.createDiv({ text: `${new Date(s.started_at).toLocaleString()} · ${formatDuration(sessionMinutes(s))}` });
        }
      }
    }
  }
}
