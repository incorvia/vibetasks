import { Component, MarkdownRenderChild } from "obsidian";
import type OpalTasksPlugin from "./main";
import type { PageCtx, PageRef } from "./pageCtx";
import { filterTasks, hasCriteria } from "./filterEngine";
import { todayStr } from "./format";
import { closeInlineTaskEditor, dropViewState, inlineTaskEditorOpen, renderProjectBoardInto } from "./heuteView";
import { installCheckDelegation } from "./taskCheck";
import { installTaskMenuDelegation } from "./taskMenu";

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
