import { Component, MarkdownRenderChild, setIcon } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { PageCtx, PageRef } from "./pageCtx";
import { filterTasks, hasCriteria } from "./filterEngine";
import { todayStr } from "./format";
import { closeInlineTaskEditor, dropViewState, inlineTaskEditorOpen, renderProjectBoardInto } from "./heuteView";
import { installCheckDelegation } from "./taskCheck";
import { installTaskMenuDelegation } from "./taskMenu";
import { listManaged, priorityBucket, projectAreaName } from "./taskService";
import { boardStatuses, isDone, isTrashed, statusIcon, statusLabel } from "./statuses";
import { projectDisplayName, t } from "./i18n";
import { PRIO_KEY } from "./chips";
import { renderProjectIdentity } from "./entityPresentation";

let nextEmbedId = 1;

/** A live project board rendered inside an ordinary Markdown note. */
export class ProjectEmbed extends MarkdownRenderChild {
  private readonly id = `project-embed-${nextEmbedId++}`;
  private doneTab: "done" | "trash" = "done";
  private manageTab: "active" | "archive" = "active";
  private doneCollapsed = true;
  private unsubscribe: (() => void) | null = null;
  private renderComponent: Component | null = null;

  constructor(containerEl: HTMLElement, private plugin: OpalTasksPlugin, private projectPath: string) {
    super(containerEl);
  }

  onload(): void {
    installCheckDelegation(this.containerEl, this.plugin);
    installTaskMenuDelegation(this.containerEl, () => this.context());
    this.unsubscribe = this.plugin.index.subscribe(() => this.draw());
    this.draw();
  }

  onunload(): void {
    closeInlineTaskEditor(this.id, false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    dropViewState(this.id);
  }

  private context(): PageCtx {
    const page: PageRef = { kind: "project", key: this.projectPath };
    const criteria = this.plugin.pageCriteria(page);
    const currentDoneTab = () => this.doneTab;
    const currentManageTab = () => this.manageTab;
    const currentDoneCollapsed = () => this.doneCollapsed;
    return {
      plugin: this.plugin,
      id: this.id,
      page,
      pageKey: this.projectPath,
      embedded: true,
      opts: this.plugin.pageOptions(page),
      crit: criteria,
      filter: (tasks) => hasCriteria(criteria) ? filterTasks(tasks, criteria, todayStr()) : tasks,
      titleComp: this.renderComponent,
      get doneTab() { return currentDoneTab(); },
      get manageTab() { return currentManageTab(); },
      get doneCollapsed() { return currentDoneCollapsed(); },
      setDoneTab: (value) => { this.doneTab = value; },
      setManageTab: (value) => { this.manageTab = value; },
      setDoneCollapsed: (value) => { this.doneCollapsed = value; },
      redraw: () => this.draw(),
      open: (target) => void this.plugin.openPage(target),
      setOption: (patch) => { void this.plugin.setPageOption(page, patch).then(() => this.draw()); },
      setCriteria: (patch) => { void this.plugin.setPageCriteria(page, patch).then(() => this.draw()); },
      setLayout: (layout) => { void this.plugin.setPageOption(page, { layout }).then(() => this.draw()); },
      setCalPanel: (calPanel) => { void this.plugin.setPageOption(page, { calPanel }).then(() => this.draw()); },
      resetOptions: () => { void this.plugin.resetPageOptions(page).then(() => this.draw()); },
    };
  }

  draw(): void {
    if (inlineTaskEditorOpen(this.id)) return;
    if (this.renderComponent) this.removeChild(this.renderComponent);
    this.renderComponent = this.addChild(new Component());
    renderProjectBoardInto(this.containerEl, this.context(), this.projectPath);
  }
}

/** Compact project identity for the top of a linked note; the task embed can remain at its footer. */
export class ProjectHeaderEmbed extends MarkdownRenderChild {
  private unsubscribe: (() => void) | null = null;

  constructor(containerEl: HTMLElement, private plugin: OpalTasksPlugin, private projectPath: string) {
    super(containerEl);
  }

  onload(): void {
    this.unsubscribe = this.plugin.index.subscribe(() => this.draw());
    this.draw();
  }

  onunload(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private draw(): void {
    const { active, archived } = listManaged(this.plugin.app);
    const project = [...active, ...archived].find((candidate) => candidate.path === this.projectPath);
    this.containerEl.empty();
    this.containerEl.addClass("bt-project-note-header");
    if (!project) return;

    const card = this.containerEl.createDiv({ cls: "bt-project-note-card" });
    card.style.setProperty("--bt-project-context", project.color || "var(--text-faint)");
    const identity = renderProjectIdentity(card, project, () => void this.plugin.openOrActivatePage({ kind: "project", key: project.path }));
    const description = project.description.trim();
    if (description) identity.createDiv({ cls: "bt-project-note-description", text: description });
    const detail = identity.createDiv({ cls: "bt-project-note-detail" });
    const area = project.areaId ? [...active, ...archived].find((candidate) => candidate.id === project.areaId)?.name ?? null
      : projectAreaName(project.area);
    if (area) detail.createSpan({ text: `@${projectDisplayName(area)}` });
    const tasks = this.plugin.index.all().filter((task) => task.project === project.path && !isTrashed(task.status));
    if (tasks.length) detail.createSpan({ text: t("subtasks_progress", tasks.filter((task) => isDone(task.status)).length, tasks.length) });

    if (project.type === "project") {
      const controls = card.createDiv({ cls: "bt-project-note-controls" });
      const select = controls.createEl("select", { cls: "bt-project-note-status" });
      for (const status of boardStatuses()) {
        const option = select.createEl("option", { value: status.id, text: statusLabel(status.id) });
        if (status.id === project.workflowStatus) option.selected = true;
      }
      select.onchange = () => void this.plugin.updateProjectWorkflow(project.path, select.value, project.priority);
      setIcon(controls.createSpan({ cls: "bt-project-note-status-icon" }), statusIcon(project.workflowStatus));

      const priority = priorityBucket(project.priority);
      if (priority !== "normal") {
        controls.createSpan({ cls: "bt-project-note-priority", text: t(PRIO_KEY[priority]) });
      }
    }
  }
}
