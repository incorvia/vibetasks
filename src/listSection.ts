import { setIcon } from "obsidian";

export interface ListSectionOptions {
  title: string;
  count?: number;
  icon?: string;
  bare?: boolean;
  className?: string;
  headerClassName?: string;
  listClassName?: string;
  onTitleClick?: (event: MouseEvent) => void;
  renderMeta?: (parent: HTMLElement) => void;
  add?: { label: string; onClick: (button: HTMLButtonElement) => void };
  collapsible?: { collapsed: boolean; onChange: (collapsed: boolean) => void };
}

export interface ListSection {
  section: HTMLElement;
  header: HTMLElement;
  list: HTMLElement;
  count: HTMLElement | null;
  setCollapsed(collapsed: boolean): void;
}

/**
 * Shared shell for every heading + divided-list surface.
 *
 * Content renderers own their rows; this component owns the visual hierarchy and the controls
 * that should behave identically wherever a list is shown.
 */
export function createListSection(parent: HTMLElement, options: ListSectionOptions): ListSection {
  const section = parent.createDiv({
    cls: ["bt-section", "bt-content-group", options.bare ? "bt-section-bare" : "", options.className ?? ""]
      .filter(Boolean).join(" "),
  });
  const header = section.createEl("h6", {
    cls: ["bt-section-title", options.headerClassName ?? ""].filter(Boolean).join(" "),
  });

  let chevron: HTMLElement | null = null;
  if (options.collapsible) {
    section.addClass("bt-collapsible");
    header.addClass("bt-section-toggle");
    header.setAttr("role", "button");
    header.setAttr("tabindex", "0");
    chevron = header.createSpan({ cls: "bt-section-chevron" });
  }

  if (options.icon) {
    const icon = header.createSpan({ cls: "bt-section-icon" });
    setIcon(icon, options.icon);
  }

  const label = header.createSpan({ cls: "bt-section-lbl", text: options.title });
  if (options.onTitleClick) {
    label.addClass("is-clickable");
    label.onclick = (event) => {
      event.stopPropagation();
      options.onTitleClick?.(event);
    };
  }
  const count = options.count === undefined
    ? null
    : header.createSpan({ cls: "bt-section-count", text: String(options.count) });

  if (options.renderMeta) {
    const meta = header.createSpan({ cls: "bt-section-meta" });
    options.renderMeta(meta);
    if (!meta.childElementCount) meta.remove();
  }

  if (options.add) {
    const add = header.createEl("button", {
      cls: "bt-section-add",
      attr: { type: "button", "aria-label": options.add.label, title: options.add.label },
    });
    setIcon(add, "plus");
    add.onclick = (event) => {
      event.stopPropagation();
      options.add?.onClick(add);
    };
  }

  const list = section.createDiv({
    cls: ["bt-list", options.listClassName ?? ""].filter(Boolean).join(" "),
  });

  const setCollapsed = (collapsed: boolean): void => {
    section.toggleClass("is-collapsed", collapsed);
    header.setAttr("aria-expanded", String(!collapsed));
    if (chevron) {
      chevron.empty();
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
    }
  };

  if (options.collapsible) {
    let collapsed = options.collapsible.collapsed;
    const toggle = (): void => {
      collapsed = !collapsed;
      setCollapsed(collapsed);
      options.collapsible?.onChange(collapsed);
    };
    setCollapsed(collapsed);
    header.onclick = toggle;
    header.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    };
  }

  return { section, header, list, count, setCollapsed };
}
