import { describe, expect, it } from "vitest";
import { boardProjectionForWidth, RESPONSIVE } from "../src/responsive";

describe("responsive board projection", () => {
  it("uses the full matrix above the tablet boundary", () => {
    expect(boardProjectionForWidth(RESPONSIVE.boardTablet + 1)).toBe("desktop");
  });

  it("uses a priority slice between tablet and compact boundaries", () => {
    expect(boardProjectionForWidth(RESPONSIVE.boardTablet)).toBe("tablet");
    expect(boardProjectionForWidth(RESPONSIVE.compactPane + 1)).toBe("tablet");
  });

  it("uses a status slice for compact panes and native mobile", () => {
    expect(boardProjectionForWidth(RESPONSIVE.compactPane)).toBe("mobile");
    expect(boardProjectionForWidth(1600, true)).toBe("mobile");
  });
});
