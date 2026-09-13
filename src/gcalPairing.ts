import type { GCalCredentials, GCalTokens } from "./gcalAuth";

/**
 * A Google connection encrypted for transport through the vault. The recovery key is deliberately
 * not part of this object: data.json may be synced, backed up, and retained in version history.
 */
export interface SealedGCalConnection {
  version: 1;
  algorithm: "AES-GCM";
  nonce: string;
  ciphertext: string;
}

export interface PortableGCalConnection {
  version: 1;
  credentials: GCalCredentials;
  refreshToken: string;
  account?: string;
  scope?: string;
  createdAt: number;
}

export interface GCalPairingResult {
  bundle: SealedGCalConnection;
  recoveryKey: string;
}

export class GCalPairingError extends Error {}

const KEY_PREFIX = "opal1.";
const AAD = new TextEncoder().encode("opal-tasks:google-calendar-pairing:v1");

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new GCalPairingError("Invalid recovery key.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new GCalPairingError("Invalid recovery key.");
  }
}

function recoveryKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const trimmed = value.trim();
  if (!trimmed.startsWith(KEY_PREFIX)) throw new GCalPairingError("Invalid recovery key.");
  const bytes = fromBase64url(trimmed.slice(KEY_PREFIX.length));
  if (bytes.byteLength !== 32) throw new GCalPairingError("Invalid recovery key.");
  return bytes;
}

function portable(credentials: GCalCredentials, tokens: GCalTokens): PortableGCalConnection {
  if (!credentials.clientId || !tokens.refreshToken) {
    throw new GCalPairingError("The Google connection is incomplete.");
  }
  return {
    version: 1,
    credentials: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    refreshToken: tokens.refreshToken,
    account: tokens.account,
    scope: tokens.scope,
    createdAt: Date.now(),
  };
}

/** Encrypt a connected account for a one-time transfer to another Obsidian device. */
export async function sealGCalConnection(
  credentials: GCalCredentials,
  tokens: GCalTokens,
): Promise<GCalPairingResult> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(portable(credentials, tokens)));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: AAD },
    key,
    plaintext,
  );
  return {
    bundle: {
      version: 1,
      algorithm: "AES-GCM",
      nonce: base64url(nonce),
      ciphertext: base64url(new Uint8Array(encrypted)),
    },
    recoveryKey: KEY_PREFIX + base64url(rawKey),
  };
}

/** Decrypt and validate a synced connection package. AES-GCM also detects tampering/wrong keys. */
export async function openGCalConnection(
  bundle: SealedGCalConnection,
  recoveryKey: string,
): Promise<PortableGCalConnection> {
  if (bundle?.version !== 1 || bundle.algorithm !== "AES-GCM") {
    throw new GCalPairingError("Unsupported Google connection package.");
  }
  try {
    const rawKey = recoveryKeyBytes(recoveryKey);
    const nonce = fromBase64url(bundle.nonce);
    if (nonce.byteLength !== 12) throw new GCalPairingError("Invalid Google connection package.");
    const ciphertext = fromBase64url(bundle.ciphertext);
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: AAD },
      key,
      ciphertext,
    );
    const value = JSON.parse(new TextDecoder().decode(clear)) as Partial<PortableGCalConnection>;
    if (value.version !== 1 || !value.credentials?.clientId || !value.refreshToken) {
      throw new GCalPairingError("Invalid Google connection package.");
    }
    return {
      version: 1,
      credentials: {
        clientId: value.credentials.clientId,
        clientSecret: value.credentials.clientSecret,
      },
      refreshToken: value.refreshToken,
      account: value.account,
      scope: value.scope,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    };
  } catch (error) {
    if (error instanceof GCalPairingError) throw error;
    throw new GCalPairingError("The recovery key is incorrect or the synced connection is damaged.");
  }
}
