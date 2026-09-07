import { describe, it, expect } from "vitest";
import { isUnderFolder } from "../src/taskService";

describe("isUnderFolder – Ordner-Zugehörigkeit (Ausschluss-Ordner + Herkunft der Titel-Migration)", () => {
  it("erkennt Notizen im Ordner und in Unterordnern", () => {
    expect(isUnderFolder("Opal Tasks/Items/Blogpost.md", "Opal Tasks/Items")).toBe(true);
    expect(isUnderFolder("Opal Tasks/Items/2026/Blogpost.md", "Opal Tasks/Items")).toBe(true);
  });

  it("greift NICHT bei einem nur namensgleichen Anfang", () => {
    expect(isUnderFolder("Opal Tasks/ItemsAlt/Blogpost.md", "Opal Tasks/Items")).toBe(false);
    expect(isUnderFolder("Andere/Opal Tasks/Items/Blogpost.md", "Opal Tasks/Items")).toBe(false);
  });

  it("erkennt Notizen außerhalb – die hat Opal Tasks nicht angelegt", () => {
    expect(isUnderFolder("Projekte/Meeting.md", "Opal Tasks/Items")).toBe(false);
    expect(isUnderFolder("Blogpost.md", "Opal Tasks/Items")).toBe(false);
  });

  it("verträgt Schrägstrich am Ende und Leerraum", () => {
    expect(isUnderFolder("Opal Tasks/Items/A.md", "Opal Tasks/Items/")).toBe(true);
    expect(isUnderFolder("Opal Tasks/Items/A.md", "  Opal Tasks/Items  ")).toBe(true);
  });

  it("ein leerer oder wurzelnaher Ordner trifft NIE – sonst gälte der halbe Vault als eigen", () => {
    expect(isUnderFolder("Opal Tasks/Items/A.md", "")).toBe(false);
    expect(isUnderFolder("Opal Tasks/Items/A.md", "   ")).toBe(false);
    expect(isUnderFolder("Opal Tasks/Items/A.md", ".")).toBe(false);
    expect(isUnderFolder("Opal Tasks/Items/A.md", "/")).toBe(false);
  });

  it("der Ordner selbst zählt mit (für die Ausschluss-Prüfung)", () => {
    expect(isUnderFolder("Archiv", "Archiv")).toBe(true);
  });
});
