import type { GCalCredentials, GCalTokens, TokenStore } from "./gcalAuth";

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export const GCAL_CREDENTIALS_SECRET = "opal-tasks-google-credentials";
export const GCAL_TOKENS_SECRET = "opal-tasks-google-tokens";
export const GCAL_PAIRING_KEY_SECRET = "opal-tasks-google-pairing-key";

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Thin typed wrapper around Obsidian's OS-protected, per-device SecretStorage. */
export class GCalSecretStore implements TokenStore {
  constructor(private readonly storage: SecretStorageLike) {}

  credentials(): GCalCredentials | null {
    const value = parseObject(this.storage.getSecret(GCAL_CREDENTIALS_SECRET));
    if (!value || typeof value.clientId !== "string" || !value.clientId) return null;
    return {
      clientId: value.clientId,
      clientSecret: typeof value.clientSecret === "string" ? value.clientSecret : undefined,
    };
  }

  saveCredentials(credentials: GCalCredentials | null): void {
    this.storage.setSecret(GCAL_CREDENTIALS_SECRET, credentials ? JSON.stringify(credentials) : "");
  }

  pairingKey(): string | null {
    return this.storage.getSecret(GCAL_PAIRING_KEY_SECRET) || null;
  }

  savePairingKey(recoveryKey: string | null): void {
    this.storage.setSecret(GCAL_PAIRING_KEY_SECRET, recoveryKey ?? "");
  }

  load(): GCalTokens | null {
    const value = parseObject(this.storage.getSecret(GCAL_TOKENS_SECRET));
    if (!value || typeof value.refreshToken !== "string" || !value.refreshToken) return null;
    return {
      accessToken: typeof value.accessToken === "string" ? value.accessToken : "",
      refreshToken: value.refreshToken,
      expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : 0,
      scope: typeof value.scope === "string" ? value.scope : undefined,
      account: typeof value.account === "string" ? value.account : undefined,
    };
  }

  save(tokens: GCalTokens | null): Promise<void> {
    this.storage.setSecret(GCAL_TOKENS_SECRET, tokens ? JSON.stringify(tokens) : "");
    return Promise.resolve();
  }
}
