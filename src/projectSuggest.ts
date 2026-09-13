import { prepareFuzzySearch, renderMatches, setIcon, sortSearchResults } from "obsidian";
import type { SearchResult } from "obsidian";
import type OpalTasksPlugin from "./main";
import { listProjectsAndAreas, type ProjItem } from "./taskService";
import { openPopover } from "./popover";
import { t } from "./i18n";
import { projectDisplayColor } from "./projectColor";

/** Keep the menu useful without turning a one-line capture field into a project browser. */
const MAX_ROWS = 8;

export interface ProjectQuery {
  /** Index of the @ which starts the token being completed. */
  start: number;
  /** Text typed between @ and the caret. Multi-word prefixes are allowed. */
  query: string;
}

/**
 * Return the open @project token at the caret.
 *
 * @ must start a word, matching quickEntry's syntax. The token may contain spaces so a user can
 * narrow "@home s" to "Home Server"; a new syntax marker or line ends the token.
 */
export function findProjectQuery(text: string, caret: number): ProjectQuery | null {
  const left = text.slice(0, caret);
  for (let start = left.lastIndexOf("@"); start >= 0; start = left.lastIndexOf("@", start - 1)) {
    if (start > 0 && !/\s/u.test(left[start - 1])) continue;
    const query = left.slice(start + 1);
    if (/[\r\n@#]/u.test(query)) return null;
    return { start, query };
  }
  return null;
}

/** Replace only the unfinished @ token, preserving text on either side. */
export function applyProject(text: string, q: ProjectQuery, caret: number, project: string):
  { text: string; caret: number } {
  const needsSpace = caret === text.length || !/\s/u.test(text[caret]);
  const insert = "@" + project + (needsSpace ? " " : "");
  return { text: text.slice(0, q.start) + insert + text.slice(caret), caret: q.start + insert.length };
}

interface Hit { item: ProjItem; match: SearchResult | null }

/** Attach fuzzy @project completion to a natural-language task-title input. */
export function attachProjectSuggest(input: HTMLInputElement, plugin: OpalTasksPlugin): () => void {
  let pop: HTMLElement | null = null;
  let close: (() => void) | null = null;
  let hits: Hit[] = [];
  let active = 0;

  input.setAttribute("aria-autocomplete", "list");

  const hide = (): void => {
    close?.();
    pop = null; close = null;
    input.setAttribute("aria-expanded", "false");
  };

  const items = (): ProjItem[] => {
    const { bereiche, projekte } = listProjectsAndAreas(plugin.app);
    return [...bereiche, ...projekte];
  };

  const rank = (query: string, projects: ProjItem[]): Hit[] => {
    const needle = query.trim();
    if (!needle) return projects.slice(0, MAX_ROWS).map((item) => ({ item, match: null }));
    const fuzzy = prepareFuzzySearch(needle);
    const found: { item: ProjItem; match: SearchResult }[] = [];
    for (const item of projects) {
      const match = fuzzy(item.name);
      if (match) found.push({ item, match });
    }
    sortSearchResults(found);
    return found.slice(0, MAX_ROWS);
  };

  const draw = (): void => {
    if (!pop) return;
    pop.empty();
    const areas = listProjectsAndAreas(plugin.app).bereiche;
    hits.forEach((hit, i) => {
      const row = pop!.createDiv({
        cls: "bt-row" + (i === active ? " is-active" : ""),
        attr: { role: "option", "aria-selected": i === active ? "true" : "false" },
      });
      const icon = row.createSpan({ cls: "bt-row-ic" });
      setIcon(icon, hit.item.icon);
      const color = projectDisplayColor(hit.item, areas, plugin.settings.projectColorMode);
      if (color) icon.setCssStyles({ color });
      const label = row.createSpan({ cls: "bt-row-lbl" });
      if (hit.match) renderMatches(label, hit.item.name, hit.match.matches);
      else label.setText(hit.item.name);
      row.createSpan({ cls: "bt-suggest-kind", text: t(hit.item.type === "area" ? "group_area" : "group_project") });
      // Keep the caret in the input until choose() has replaced the token.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.onclick = () => choose(i);
    });
  };

  const choose = (i: number): void => {
    const hit = hits[i];
    if (!hit) return;
    const caret = input.selectionStart ?? input.value.length;
    const q = findProjectQuery(input.value, caret);
    if (!q) { hide(); return; }
    const next = applyProject(input.value, q, caret, hit.item.name);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    hide();
    // The host's normal NLP input handler performs the exact project assignment and redraws its chip.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };

  const refresh = (): void => {
    if (!input.isConnected) { hide(); return; }
    const caret = input.selectionStart ?? input.value.length;
    const q = findProjectQuery(input.value, caret);
    if (!q) { hide(); return; }
    const projects = items();
    const needle = q.query.trim().toLowerCase();
    // Once the full name is present, quickEntry has everything it needs; Enter should submit.
    if (projects.some((item) => item.name.toLowerCase() === needle)) { hide(); return; }
    hits = rank(q.query, projects);
    active = 0;
    if (!hits.length) { hide(); return; }
    if (pop) { draw(); return; }
    openPopover(input, (p, c) => {
      pop = p; close = c;
      p.addClasses(["bt-projectsuggest", "bt-linksuggest"]);
      p.setAttribute("role", "listbox");
      input.setAttribute("aria-expanded", "true");
      draw();
    }, () => {
      pop = null; close = null;
      input.setAttribute("aria-expanded", "false");
    });
  };

  const onKeyup = (e: KeyboardEvent): void => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) refresh();
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (!pop) return;
    if (e.key === "ArrowDown") { active = (active + 1) % hits.length; draw(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + hits.length) % hits.length; draw(); }
    else if (e.key === "Enter" || e.key === "Tab") { choose(active); }
    else if (e.key === "Escape") { hide(); }
    else return;
    e.preventDefault();
    // Capture phase is intentional: task-title inputs otherwise submit on Enter before completion.
    e.stopImmediatePropagation();
  };

  input.addEventListener("input", refresh);
  input.addEventListener("click", refresh);
  input.addEventListener("keyup", onKeyup);
  input.addEventListener("keydown", onKeydown, true);
  input.addEventListener("blur", hide);

  return () => {
    hide();
    input.removeEventListener("input", refresh);
    input.removeEventListener("click", refresh);
    input.removeEventListener("keyup", onKeyup);
    input.removeEventListener("keydown", onKeydown, true);
    input.removeEventListener("blur", hide);
  };
}
