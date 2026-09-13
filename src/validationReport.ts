import { normalizePath } from "obsidian";
import type { ValidationIssue } from "./mdbaseRepository";

export const DEFAULT_VALIDATION_REPORT_PATH = "_opal_tasks/Validation report.md";
export const VALIDATION_REPORT_MARKER = "<!-- opal-tasks-validation-report -->";

/** Keep the setting convenient: users may enter either a note name or a full Markdown path. */
export function validationReportPath(raw: string | null | undefined): string {
  const normalized = normalizePath((raw ?? "").trim());
  if (!normalized || normalized === ".") return DEFAULT_VALIDATION_REPORT_PATH;
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

const inline = (value: string): string => value.replace(/`/g, "ˋ").replace(/[\r\n]+/g, " ");
const text = (value: string): string => value.replace(/[\r\n]+/g, " ");

/** A fresh report is more useful than an append-only log: fixed issues disappear on the next run. */
export function validationReportMarkdown(
  issues: readonly ValidationIssue[],
  generatedAt: Date,
  pluginVersion: string,
): string {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.length - errors;
  const lines = [
    VALIDATION_REPORT_MARKER,
    "",
    "# Opal Tasks validation report",
    "",
    `Generated: ${generatedAt.toISOString()}`,
    `Opal Tasks: ${pluginVersion}`,
    "",
  ];

  if (!issues.length) {
    lines.push("> [!success] Collection is valid", "> No validation issues were found.", "");
    return lines.join("\n");
  }

  lines.push(
    `> [!warning] ${issues.length} validation issue${issues.length === 1 ? "" : "s"}`,
    `> ${errors} error${errors === 1 ? "" : "s"}; ${warnings} warning${warnings === 1 ? "" : "s"}. Opal Tasks left the source files unchanged.`,
    "",
  );

  const byPath = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const group = byPath.get(issue.path) ?? [];
    group.push(issue);
    byPath.set(issue.path, group);
  }
  for (const [path, pathIssues] of byPath) {
    const markdownPath = path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : null;
    lines.push(`## ${markdownPath ? `[[${markdownPath}|${text(path)}]]` : `\`${inline(path)}\``}`, "");
    for (const issue of pathIssues) {
      const field = issue.field ? ` · field \`${inline(issue.field)}\`` : "";
      lines.push(`- **${issue.severity === "error" ? "Error" : "Warning"}** · \`${inline(issue.code)}\`${field} — ${text(issue.message)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
