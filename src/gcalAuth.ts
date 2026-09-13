import { Platform, requestUrl } from "obsidian";

/**
 * Google-OAuth für den Kalender-Sync. Bewusst **UI- und Plugin-agnostisch**:
 * Zugangsdaten und Token-Persistenz kommen über den Konstruktor herein (Callbacks),
 * damit dieses Modul nur „Tokens besorgen/erneuern/widerrufen" kann und sonst nichts.
 * Settings-UI und Sync-Engine sind dünne Konsumenten (Prinzip wie reminders.ts).
 *
 * Desktop authorisiert über einen Loopback + PKCE. Google unterstützt Calendar-Berechtigungen
 * nicht im Device-Code-Flow; Mobilgeräte übernehmen deshalb eine lokal verschlüsselte
 * Desktop-Verbindung (gcalPairing.ts) und legen sie in Obsidian SecretStorage ab.
 *
 * Kein Client-Secret im Plugin — der Nutzer legt einen eigenen OAuth-Client an
 * (Anleitung im Setup-Assistenten). „Desktop-App"-Clients liefern zwar ein Secret,
 * das ist bei installierten Apps aber nicht vertraulich (Google-Doku).
 *
 * Alle HTTP-Calls über requestUrl (nicht fetch → keine CORS/Origin-Probleme).
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

/** calendar.events = Events schreiben; calendar.readonly = Kalenderliste/Anzeige;
 *  calendar.app.created = eigenen „Opal Tasks"-Sekundärkalender anlegen/verwalten (schmales Recht,
 *  kein Zugriff auf fremde Kalender-Verwaltung). */
export const GCAL_SCOPE =
  "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.app.created";

/** Access-Token 60 s vor Ablauf als „abgelaufen" behandeln (Uhr-Drift/Latenz-Puffer). */
const EXPIRY_SKEW_MS = 60_000;
/** Loopback-Login abbrechen, wenn der Nutzer nicht binnen dieser Zeit zustimmt. */
const LOOPBACK_TIMEOUT_MS = 180_000;

/**
 * Minimal-Typen für Node-`http` – nur die Fläche, die der Loopback-Server nutzt.
 * Bewusst selbst-enthalten (nicht `typeof import("http")`), damit auch ein Linter
 * OHNE installierte `@types/node` (Store-Review) keine `any`-Werte sieht.
 */
interface LoopbackHttp {
  createServer(handler: (req: { url?: string }, res: LoopbackResponse) => void): LoopbackServer;
}
interface LoopbackResponse {
  writeHead(status: number, headers?: Record<string, string>): LoopbackResponse;
  end(body?: string): void;
}
interface LoopbackServer {
  listen(port: number, host: string, cb: () => void): void;
  close(): void;
  on(event: "error", cb: (e: Error) => void): void;
  address(): { port: number } | string | null;
}

export interface GCalCredentials {
  clientId: string;
  clientSecret?: string;   // Desktop-Client; bei installierten Apps kein vertrauliches Secret
}

export interface GCalTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // Epoch-ms, wann accessToken abläuft
  scope?: string;
  account?: string;        // Anzeige-E-Mail (füllt die Sync-Engine via primary-Kalender)
}

/** Einmalige Umstellung von data.json auf den geräte-lokalen Speicher (Aufrufer: main.ts).
 *  Entscheidet NUR, was zu übernehmen ist – Löschen und Speichern bleiben beim Aufrufer, damit
 *  diese Regel für sich prüfbar ist. Rückgabe `null` heißt: nichts zu übernehmen.
 *
 *  Ein bereits vorhandener lokaler Token gewinnt immer: Er wurde auf DIESEM Gerät erneuert und
 *  ist damit aktueller als der (womöglich längst überholte) Stand aus der synchronisierten Datei. */
export function planTokenMigration(
  legacyTokens: GCalTokens | null | undefined,
  legacyAccount: string | null | undefined,
  hasLocalToken: boolean,
): GCalTokens | null {
  if (hasLocalToken) return null;
  if (!legacyTokens?.refreshToken) return null;   // ohne Refresh-Token ist nichts zu retten
  const account = legacyTokens.account ?? legacyAccount ?? undefined;
  return account ? { ...legacyTokens, account } : { ...legacyTokens };
}

/** Persistenz-Brücke: die Engine reicht Laden/Speichern der Tokens durch (data.json). */
export interface TokenStore {
  load(): GCalTokens | null;
  save(tokens: GCalTokens | null): Promise<void>;
}

export class GCalAuthError extends Error {}

// ── PKCE / Zufall (Web-Crypto, funktioniert auf Desktop UND Mobile) ──────────
function base64url(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);   // 43 Zeichen, unreserved
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

// ── HTTP-Helfer ──────────────────────────────────────────────────────────────
function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

async function postForm(url: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await requestUrl({
    url,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form(params),
    throw: false,
  });
  let json: Record<string, unknown> = {};
  try { json = res.json as Record<string, unknown>; } catch { /* nicht-JSON unten behandelt */ }
  if (res.status >= 400) {
    const err = (json.error_description as string) || (json.error as string) || `HTTP ${res.status}`;
    throw new GCalAuthError(String(err));
  }
  return json;
}

/** Token-Antwort von Google in unsere Struktur überführen (refreshToken ggf. vom Vorlauf). */
function toTokens(json: Record<string, unknown>, prevRefresh?: string): GCalTokens {
  const access = json.access_token as string | undefined;
  const refresh = (json.refresh_token as string | undefined) ?? prevRefresh;
  const expiresIn = (json.expires_in as number | undefined) ?? 3600;
  if (!access || !refresh) throw new GCalAuthError("Incomplete token response from Google.");
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: json.scope as string | undefined,
  };
}

// ── Auth-Kern ─────────────────────────────────────────────────────────────────
export class GCalAuth {
  constructor(
    private readonly getCredentials: () => GCalCredentials | null,
    private readonly store: TokenStore,
  ) {}

  isConnected(): boolean {
    const t = this.store.load();
    return !!t?.refreshToken;
  }

  account(): string | null {
    return this.store.load()?.account ?? null;
  }

  /** Gültiges Access-Token liefern; bei Bedarf transparent per Refresh-Token erneuern. */
  async getAccessToken(): Promise<string> {
    const t = this.store.load();
    if (!t?.refreshToken) throw new GCalAuthError("Not connected to Google.");
    if (t.accessToken && Date.now() < t.expiresAt - EXPIRY_SKEW_MS) return t.accessToken;
    return this.refresh(t);
  }

  private async refresh(t: GCalTokens): Promise<string> {
    const creds = this.requireCredentials();
    const json = await postForm(TOKEN_ENDPOINT, {
      client_id: creds.clientId,
      ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
      refresh_token: t.refreshToken,
      grant_type: "refresh_token",
    });
    const next = toTokens(json, t.refreshToken);
    next.account = t.account;   // Anzeige-E-Mail über Refreshs hinweg behalten
    await this.store.save(next);
    return next.accessToken;
  }

  /** Google erlaubt den Loopback-Flow nur auf Desktop; Mobile wird per Pairing importiert. */
  async connect(): Promise<GCalTokens> {
    if (!Platform.isDesktopApp) {
      throw new GCalAuthError("Connect on desktop, then unlock the synced connection on this device.");
    }
    const tokens = await this.connectLoopback();
    await this.store.save(tokens);
    return tokens;
  }

  /** Anzeige-E-Mail nachtragen. Sie steht erst nach dem Verbinden fest (ein API-Aufruf) und
   *  gehört zum Token, nicht in die Einstellungen: Sie beschreibt DIESE Geräteverbindung. */
  async setAccount(email: string | null): Promise<void> {
    const t = this.store.load();
    if (!t) return;
    await this.store.save({ ...t, account: email ?? undefined });
  }

  /** Ein fehlgeschlagener Widerruf bleibt sichtbar und löscht lokal nichts. */
  async revoke(): Promise<void> {
    const t = this.store.load();
    if (t?.refreshToken) await postForm(REVOKE_ENDPOINT, { token: t.refreshToken });
    await this.store.save(null);
  }

  private requireCredentials(): GCalCredentials {
    const creds = this.getCredentials();
    if (!creds?.clientId) throw new GCalAuthError("Google credentials have not been configured.");
    return creds;
  }

  // ── Desktop: Loopback-Server + PKCE ──
  private async connectLoopback(): Promise<GCalTokens> {
    const creds = this.requireCredentials();
    const { verifier, challenge } = await pkcePair();
    const state = randomToken(16);

    // Node-http nur auf dem Desktop (Electron); als externes Builtin nicht gebündelt.
    // Zugriff über window.require, damit ESLint es nicht als Node-Import erkennt.
    const http = (window as unknown as { require: (id: "http") => LoopbackHttp }).require("http");

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>(
      (resolve, reject) => {
        const server = http.createServer((req, res) => {
          try {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
              res.writeHead(204).end();   // Favicon o. Ä. ignorieren
              return;
            }
            const ok = url.searchParams.get("state") === state && url.searchParams.has("code");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(loopbackPage(ok));
            server.close();
            window.clearTimeout(timer);
            if (url.searchParams.get("error")) return reject(new GCalAuthError(url.searchParams.get("error")!));
            if (!ok) return reject(new GCalAuthError("Invalid response (OAuth state did not match)."));
            resolve({ code: url.searchParams.get("code")!, redirectUri: base });
          } catch (e) {
            reject(e instanceof Error ? e : new GCalAuthError(String(e)));
          }
        });
        let base = "";
        const timer = window.setTimeout(() => {
          server.close();
          reject(new GCalAuthError("Google sign-in timed out."));
        }, LOOPBACK_TIMEOUT_MS);
        server.on("error", (e: Error) => { window.clearTimeout(timer); reject(e); });
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          base = `http://127.0.0.1:${port}`;
          const authUrl = AUTH_ENDPOINT + "?" + form({
            client_id: creds.clientId,
            redirect_uri: base,
            response_type: "code",
            scope: GCAL_SCOPE,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            access_type: "offline",
            prompt: "consent",   // erzwingt refresh_token auch bei erneutem Login
            hl: "en",            // keep Google's OAuth UI consistent with the default Opal Tasks UI
          });
          window.open(authUrl);
        });
      },
    );

    const json = await postForm(TOKEN_ENDPOINT, {
      client_id: creds.clientId,
      ...(creds.clientSecret ? { client_secret: creds.clientSecret } : {}),
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
    return toTokens(json);
  }

}

/** Schlichte Abschluss-Seite im Browser nach dem Loopback-Redirect. */
function loopbackPage(ok: boolean): string {
  const msg = ok
    ? "✅ Opal Tasks is now connected to Google Calendar."
    : "⚠️ Sign-in failed. Please try again in Obsidian.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Opal Tasks</title><style>
body{font-family:system-ui,sans-serif;background:#1e1e1e;color:#eee;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}
div{max-width:28rem;text-align:center;line-height:1.5;padding:2rem}
</style></head><body><div><p>${msg}</p><p>You can close this window.</p></div></body></html>`;
}
