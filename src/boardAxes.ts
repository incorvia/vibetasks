/** A board axis is empty only when it has no content anywhere on the other axis. Keeping this
 * decision independent of the active responsive slice prevents columns and lanes from appearing
 * or disappearing merely because a different tablet/mobile tab was selected. */
export interface CountedBoardColumn<Lane> {
  count(lane?: Lane): number;
}

/** Completed cards and completed-status drop targets are separate display decisions. An empty
 * completed column remains available when empty axes are requested, even if its cards are hidden. */
export function boardStatusAxes<Status extends { kind: string }>(
  statuses: readonly Status[], showDoneCards: boolean, showEmptyAxes: boolean,
): Status[] {
  return statuses.filter((status) => status.kind === "open" || showDoneCards || showEmptyAxes);
}

export function visibleBoardAxes<Column extends CountedBoardColumn<Lane>, Lane>(
  columns: readonly Column[], lanes: readonly Lane[] | undefined, showEmpty: boolean,
): { columns: Column[]; lanes: Lane[] | undefined } {
  if (showEmpty) return { columns: [...columns], lanes: lanes ? [...lanes] : undefined };
  return {
    columns: columns.filter((column) => lanes?.length
      ? lanes.some((lane) => column.count(lane) > 0)
      : column.count() > 0),
    lanes: lanes?.filter((lane) => columns.some((column) => column.count(lane) > 0)),
  };
}
