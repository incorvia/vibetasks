// Minimaler "obsidian"-Stub – nur die von den puren Helfern importierten Exporte,
// damit die Module unter vitest auflösbar sind. Keine echte Logik nötig (die Tests
// rufen nur reine Funktionen, nicht die App/TFile-abhängigen Pfade).

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export function stringifyYaml(obj: Record<string, unknown>): string {
  return Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
}

export function parseYaml(source: string): unknown {
  const out: Record<string, unknown> = {};
  for (const line of source.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key) continue;
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
}

export class App {}
export class TFile {}
/** Nur so viel Component, wie TaskIndex braucht: Abos einsammeln. `registerEvent` zählt
 *  bewusst NICHT selbst mit – wie oft ein Kanal belegt ist, weiß der Fake-App-Stub im Test
 *  (sonst prüfte der Test seine eigene Buchhaltung statt der von TaskIndex). */
export class Component {
  private refs: unknown[] = [];
  registerEvent(ref: unknown): void { this.refs.push(ref); }
  addChild<T>(child: T): T { return child; }
}
export class FuzzySuggestModal {}
export class Modal {}
export class Setting {}
export class Notice {}
export const Platform = { isMobile: false };
export function setIcon(): void { /* no-op im Test */ }
