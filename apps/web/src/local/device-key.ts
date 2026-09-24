import { unwrapDek, wrapDek, type Bytes, type CryptoEnvelope } from "@securenotes/shared";

import type { SecureNotesDatabase } from "./schema";

/**
 * The device key (§7).
 *
 * Offline unlock must work with no network and no TOTP, so the DEK is also
 * wrapped by a key that never leaves this device. That key is generated here as a
 * **non-extractable** AES-GCM `CryptoKey`: it can encrypt and decrypt, but
 * `crypto.subtle.exportKey` refuses to read it, so script — including injected
 * script — cannot exfiltrate it as bytes.
 *
 * The device key protects the local copy of the DEK, not the account: signing in
 * still requires TOTP, and a revoked session destroys this key (see
 * `forgetDeviceKey`).
 */

const DEVICE_KEY_ID = "device" as const;

export async function getOrCreateDeviceKey(db: SecureNotesDatabase): Promise<CryptoKey> {
  const existing = await db.deviceKeys.get(DEVICE_KEY_ID);
  if (existing) {
    return existing.key;
  }

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);

  await db.deviceKeys.put({ id: DEVICE_KEY_ID, key, createdAt: Date.now() });
  return key;
}

/**
 * Wraps the DEK with the device key.
 *
 * `wrapDek` from the shared crypto is reused unchanged: the device key is simply
 * another key-encrypting key, so the wrapped form has the same envelope shape and
 * the same AAD binding as the KEK and recovery wrappings.
 */
export async function wrapDekForDevice(
  deviceKey: CryptoKey,
  rawDek: Bytes,
  identity: { userId: string; keyVersion: number },
): Promise<CryptoEnvelope> {
  return wrapDek(deviceKey, rawDek, identity);
}

export async function unwrapDekForDevice(
  deviceKey: CryptoKey,
  envelope: CryptoEnvelope,
  identity: { userId: string; keyVersion: number },
): Promise<Bytes> {
  return unwrapDek(deviceKey, envelope, identity);
}

/**
 * Destroys the local key material.
 *
 * A device that learns its session was revoked must delete its cached data and
 * wrapped key and return to authentication (§4), and the device key is exactly
 * what would otherwise let it keep reading local ciphertext offline.
 */
export async function forgetDeviceKey(db: SecureNotesDatabase): Promise<void> {
  await db.deviceKeys.delete(DEVICE_KEY_ID);
  await db.keyMaterial.delete("account");
}
