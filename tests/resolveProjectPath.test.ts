import { describe, it, expect } from "vitest";
import { resolveProjectPath, isProjectType } from "../src/taskService";

// Karte echter Projekt-/Bereichs-Notizen: lowercase Basename -> Pfad. GENAU wie sie der Index baut.
const map = new Map<string, string>([
  ["vibetask", "VibeTask/Projects/VibeTask.md"],
  ["abos", "VibeTask/Projects/Abos.md"],
  ["smart home2", "VibeTask/Projects/Smart Home2.md"],
]);

describe("resolveProjectPath – Projekt-Verweis über Basename gegen echte Projekte", () => {
  it("löst einen gültigen Projekt-Verweis auf seinen Pfad auf", () => {
    expect(resolveProjectPath("[[VibeTask]]", map)).toBe("VibeTask/Projects/VibeTask.md");
  });

  it("ignoriert gleichnamige Fremd-Notizen: kein echtes Projekt mit dem Basenamen -> null (Eingang)", () => {
    // Regression 1.23.x: [[Smart Home]] hat KEIN type:project-Pendant (nur Smart Home2 + alte
    // Tasks-Dashboards) -> darf NICHT auf einen Namensvetter zeigen, sondern null (Eingang).
    expect(resolveProjectPath("[[Smart Home]]", map)).toBeNull();
  });

  it("ist case-insensitiv", () => {
    expect(resolveProjectPath("[[vibeTASK]]", map)).toBe("VibeTask/Projects/VibeTask.md");
  });

  it("nimmt bei [[Ordner/Name]] den Basenamen", () => {
    expect(resolveProjectPath("[[Irgendwo/Abos]]", map)).toBe("VibeTask/Projects/Abos.md");
  });

  it("ignoriert Alias und Heading-Anker", () => {
    expect(resolveProjectPath("[[VibeTask|Anzeigename]]", map)).toBe("VibeTask/Projects/VibeTask.md");
    expect(resolveProjectPath("[[VibeTask#Abschnitt]]", map)).toBe("VibeTask/Projects/VibeTask.md");
  });

  it("leer / kein Wikilink / kein String -> null", () => {
    expect(resolveProjectPath(null, map)).toBeNull();
    expect(resolveProjectPath("", map)).toBeNull();
    expect(resolveProjectPath("nur Text", map)).toBeNull();
    expect(resolveProjectPath(42, map)).toBeNull();
  });
});

describe("isProjectType – was als Projekt-/Bereichs-Verweisziel zählt", () => {
  it("akzeptiert project/area, lehnt Fremd-Schemata und Leeres ab", () => {
    expect(isProjectType("project")).toBe(true);
    expect(isProjectType("area")).toBe(true);
    expect(isProjectType("view")).toBe(false);   // altes Tasks-Plugin-Dashboard
    expect(isProjectType("task")).toBe(false);
    expect(isProjectType(undefined)).toBe(false);
    expect(isProjectType(null)).toBe(false);
  });
});
