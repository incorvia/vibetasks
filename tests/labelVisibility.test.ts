import { describe, expect, it } from "vitest";
import { newlyIntroducedLabels } from "../src/taskService";

describe("newlyIntroducedLabels", () => {
  it("returns new labels once and in task order", () => {
    expect(newlyIntroducedLabels(["work", "urgent", "urgent", "later"], ["work"]))
      .toEqual(["urgent", "later"]);
  });

  it("does not treat a known hidden label as newly introduced", () => {
    expect(newlyIntroducedLabels(["hidden"], ["hidden"]))
      .toEqual([]);
  });
});
