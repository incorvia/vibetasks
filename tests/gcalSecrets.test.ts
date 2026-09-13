import { describe, expect, it } from "vitest";
import { GCAL_CREDENTIALS_SECRET, GCAL_PAIRING_KEY_SECRET, GCAL_TOKENS_SECRET, GCalSecretStore } from "../src/gcalSecrets";

class MemorySecrets {
  values = new Map<string, string>();
  getSecret(id: string): string | null { return this.values.get(id) ?? null; }
  setSecret(id: string, value: string): void { this.values.set(id, value); }
}

describe("Google Calendar SecretStorage adapter", () => {
  it("stores credentials and tokens under separate stable IDs", async () => {
    const memory = new MemorySecrets();
    const store = new GCalSecretStore(memory);
    store.saveCredentials({ clientId: "client", clientSecret: "secret" });
    store.savePairingKey("opal1.key");
    await store.save({ accessToken: "access", refreshToken: "refresh", expiresAt: 123 });

    expect(memory.values.has(GCAL_CREDENTIALS_SECRET)).toBe(true);
    expect(memory.values.has(GCAL_TOKENS_SECRET)).toBe(true);
    expect(memory.values.has(GCAL_PAIRING_KEY_SECRET)).toBe(true);
    expect(store.credentials()).toEqual({ clientId: "client", clientSecret: "secret" });
    expect(store.pairingKey()).toBe("opal1.key");
    expect(store.load()).toEqual({
      accessToken: "access", refreshToken: "refresh", expiresAt: 123,
      scope: undefined, account: undefined,
    });
  });

  it("clears secrets without leaving parseable credentials", async () => {
    const memory = new MemorySecrets();
    const store = new GCalSecretStore(memory);
    store.saveCredentials({ clientId: "client" });
    await store.save({ accessToken: "", refreshToken: "refresh", expiresAt: 0 });
    store.saveCredentials(null);
    store.savePairingKey(null);
    await store.save(null);
    expect(store.credentials()).toBeNull();
    expect(store.pairingKey()).toBeNull();
    expect(store.load()).toBeNull();
  });
});
