import { describe, it, expect } from "vitest";
import { isUnderFolder } from "../src/taskService";

describe("isUnderFolder – Ordner-Zugehörigkeit (Ausschluss-Ordner + Herkunft der Titel-Migration)", () => {
  it("erkennt Notizen im Ordner und in Unterordnern", () => {
    expect(isUnderFolder("VibeTask/Items/Blogpost.md", "VibeTask/Items")).toBe(true);
    expect(isUnderFolder("VibeTask/Items/2026/Blogpost.md", "VibeTask/Items")).toBe(true);
  });

  it("greift NICHT bei einem nur namensgleichen Anfang", () => {
    expect(isUnderFolder("VibeTask/ItemsAlt/Blogpost.md", "VibeTask/Items")).toBe(false);
    expect(isUnderFolder("Andere/VibeTask/Items/Blogpost.md", "VibeTask/Items")).toBe(false);
  });

  it("erkennt Notizen außerhalb – die hat VibeTask nicht angelegt", () => {
    expect(isUnderFolder("Projekte/Meeting.md", "VibeTask/Items")).toBe(false);
    expect(isUnderFolder("Blogpost.md", "VibeTask/Items")).toBe(false);
  });

  it("verträgt Schrägstrich am Ende und Leerraum", () => {
    expect(isUnderFolder("VibeTask/Items/A.md", "VibeTask/Items/")).toBe(true);
    expect(isUnderFolder("VibeTask/Items/A.md", "  VibeTask/Items  ")).toBe(true);
  });

  it("ein leerer oder wurzelnaher Ordner trifft NIE – sonst gälte der halbe Vault als eigen", () => {
    expect(isUnderFolder("VibeTask/Items/A.md", "")).toBe(false);
    expect(isUnderFolder("VibeTask/Items/A.md", "   ")).toBe(false);
    expect(isUnderFolder("VibeTask/Items/A.md", ".")).toBe(false);
    expect(isUnderFolder("VibeTask/Items/A.md", "/")).toBe(false);
  });

  it("der Ordner selbst zählt mit (für die Ausschluss-Prüfung)", () => {
    expect(isUnderFolder("Archiv", "Archiv")).toBe(true);
  });
});
