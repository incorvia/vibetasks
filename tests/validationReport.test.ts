import { describe, expect, it } from "vitest";
import { DEFAULT_VALIDATION_REPORT_PATH, validationReportMarkdown, validationReportPath } from "../src/validationReport";

describe("validation report", () => {
  it("normalizes a configurable note path and supplies its extension", () => {
    expect(validationReportPath(" Reports/Opal validation ")).toBe("Reports/Opal validation.md");
    expect(validationReportPath("Reports/Opal.md")).toBe("Reports/Opal.md");
    expect(validationReportPath(" ")).toBe(DEFAULT_VALIDATION_REPORT_PATH);
  });

  it("surfaces the exact file, field, code, and message", () => {
    const report = validationReportMarkdown([{
      path: "_opal_tasks/tasks/Broken.md", type: "task", severity: "error",
      code: "schema.minLength", field: "title", message: "must NOT have fewer than 1 characters",
    }], new Date("2026-09-12T12:00:00.000Z"), "1.2.3");

    expect(report).toContain("[[_opal_tasks/tasks/Broken|_opal_tasks/tasks/Broken.md]]");
    expect(report).toContain("`schema.minLength`");
    expect(report).toContain("field `title`");
    expect(report).toContain("must NOT have fewer than 1 characters");
  });

  it("writes a clear success state when no issues remain", () => {
    expect(validationReportMarkdown([], new Date(0), "1.2.3")).toContain("Collection is valid");
  });
});
