import { describe, expect, it } from "vitest";
import { boardStatusAxes, visibleBoardAxes } from "../src/boardAxes";

type Lane = { id: string };
type Column = { id: string; count(lane?: Lane): number };

const lane = (id: string): Lane => ({ id });
const column = (id: string, counts: Record<string, number>): Column => ({
  id,
  count: (item) => item ? counts[item.id] ?? 0 : Object.values(counts).reduce((sum, n) => sum + n, 0),
});

describe("visibleBoardAxes", () => {
  it("keeps every configured axis when empty axes are shown", () => {
    const columns = [column("todo", { p1: 1 }), column("doing", {})];
    const lanes = [lane("p1"), lane("p2")];
    const visible = visibleBoardAxes(columns, lanes, true);
    expect(visible.columns.map((item) => item.id)).toEqual(["todo", "doing"]);
    expect(visible.lanes?.map((item) => item.id)).toEqual(["p1", "p2"]);
  });

  it("removes only axes that are empty across the entire opposite axis", () => {
    const columns = [column("todo", { p1: 2 }), column("doing", { p2: 1 }), column("review", {})];
    const lanes = [lane("p1"), lane("p2"), lane("p3")];
    const visible = visibleBoardAxes(columns, lanes, false);
    expect(visible.columns.map((item) => item.id)).toEqual(["todo", "doing"]);
    expect(visible.lanes?.map((item) => item.id)).toEqual(["p1", "p2"]);
  });

  it("also filters a board without lanes", () => {
    const columns = [column("todo", { all: 1 }), column("doing", {})];
    expect(visibleBoardAxes(columns, undefined, false).columns.map((item) => item.id)).toEqual(["todo"]);
  });
});

describe("boardStatusAxes", () => {
  const statuses = [
    { id: "todo", kind: "open" },
    { id: "doing", kind: "open" },
    { id: "done", kind: "done" },
  ];

  it("keeps the Done target when empty axes are shown but completed cards are hidden", () => {
    expect(boardStatusAxes(statuses, false, true).map((item) => item.id))
      .toEqual(["todo", "doing", "done"]);
  });

  it("removes completed statuses only when both display choices exclude them", () => {
    expect(boardStatusAxes(statuses, false, false).map((item) => item.id))
      .toEqual(["todo", "doing"]);
  });
});
