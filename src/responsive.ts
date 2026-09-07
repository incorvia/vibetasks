import { Platform } from "obsidian";

/**
 * Responsive contract shared by runtime decisions and mirrored in styles.css.
 *
 * - 700px: compact page shell, mobile board projection and compact task editor.
 * - 820px: touch fallback and the calendar toolbar's component-level reflow.
 * - 1100px: tablet board projection (one swimlane across all status columns).
 * - 500px / 390px: presentation-only refinements for small and very small phones.
 *
 * CSS cannot consume TypeScript constants, so the stylesheet documents the same values beside
 * its responsive rules. Runtime layout branches must go through this helper rather than inventing
 * another viewport/device test.
 */
export const RESPONSIVE = {
  compactPane: 700,
  compactTouch: 820,
  boardTablet: 1100,
  smallPhone: 500,
  microPhone: 390,
} as const;

export type BoardProjection = "desktop" | "tablet" | "mobile";

function elementWidth(el?: HTMLElement | null): number {
  const view = el?.closest<HTMLElement>(".bt-view") ?? el;
  return view?.getBoundingClientRect().width
    || (typeof window !== "undefined" ? window.innerWidth : Number.POSITIVE_INFINITY);
}

export function isCompactPane(el?: HTMLElement | null): boolean {
  const width = elementWidth(el);
  const noHover = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(hover: none)").matches;
  return Platform.isMobile
    || width <= RESPONSIVE.compactPane
    || (noHover && width <= RESPONSIVE.compactTouch);
}

/** Board density is a component decision based on the pane, not the device viewport. Native
 * Obsidian mobile is always the one-column projection because it can report a desktop-sized CSS
 * viewport. The pure width helper is exported so the boundary contract stays unit-testable. */
export function boardProjectionForWidth(width: number, nativeMobile = false): BoardProjection {
  if (nativeMobile || width <= RESPONSIVE.compactPane) return "mobile";
  if (width <= RESPONSIVE.boardTablet) return "tablet";
  return "desktop";
}

export function boardProjection(el?: HTMLElement | null): BoardProjection {
  if (isCompactPane(el)) return "mobile";
  return boardProjectionForWidth(elementWidth(el));
}
