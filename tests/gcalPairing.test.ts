import { describe, expect, it } from "vitest";
import { openGCalConnection, sealGCalConnection } from "../src/gcalPairing";

const credentials = { clientId: "client.apps.googleusercontent.com", clientSecret: "secret" };
const tokens = {
  accessToken: "short-lived-access-token",
  refreshToken: "long-lived-refresh-token",
  expiresAt: Date.now() + 3600_000,
  scope: "calendar",
  account: "person@example.com",
};

describe("Google Calendar device pairing", () => {
  it("round-trips the reusable connection without copying the access token", async () => {
    const sealed = await sealGCalConnection(credentials, tokens);
    const opened = await openGCalConnection(sealed.bundle, sealed.recoveryKey);

    expect(opened.credentials).toEqual(credentials);
    expect(opened.refreshToken).toBe(tokens.refreshToken);
    expect(opened.account).toBe(tokens.account);
    expect(JSON.stringify(sealed.bundle)).not.toContain(tokens.refreshToken);
    expect(JSON.stringify(sealed.bundle)).not.toContain(tokens.accessToken);
  });

  it("uses a new key and nonce for every package", async () => {
    const first = await sealGCalConnection(credentials, tokens);
    const second = await sealGCalConnection(credentials, tokens);
    expect(first.recoveryKey).not.toBe(second.recoveryKey);
    expect(first.bundle.nonce).not.toBe(second.bundle.nonce);
    expect(first.bundle.ciphertext).not.toBe(second.bundle.ciphertext);
  });

  it("rejects a wrong recovery key", async () => {
    const first = await sealGCalConnection(credentials, tokens);
    const second = await sealGCalConnection(credentials, tokens);
    await expect(openGCalConnection(first.bundle, second.recoveryKey)).rejects.toThrow(/incorrect|damaged/i);
  });

  it("rejects modified ciphertext", async () => {
    const sealed = await sealGCalConnection(credentials, tokens);
    const last = sealed.bundle.ciphertext.slice(-1);
    const damaged = {
      ...sealed.bundle,
      ciphertext: sealed.bundle.ciphertext.slice(0, -1) + (last === "A" ? "B" : "A"),
    };
    await expect(openGCalConnection(damaged, sealed.recoveryKey)).rejects.toThrow(/incorrect|damaged/i);
  });
});

