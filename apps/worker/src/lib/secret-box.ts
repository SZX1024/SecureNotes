import { utf8, type Bytes } from "@securenotes/shared";

import {
  base64ToBytes,
  bytesToBase64,
  deriveWorkerKey,
  importAesGcmKey,
  randomBytes,
} from "./crypto";

/**
 * AES-256-GCM wrapping for worker-side secrets that must be recoverable — today
 * the TOTP secret, which has to be re-delivered to the client after
 * authentication to derive the KEK (ADR-002, requirements §25), and the
 * encrypted detail column of the audit log (§5).
 *
 * The key is derived per purpose from the `SECRET_WRAP_KEY` Worker secret and
 * never from the database, so D1 alone yields no recoverable secret.
 */

/** Every purpose that may seal data. Adding one is a deliberate act. */
export const SEAL_PURPOSES = ["totp-secret", "audit-detail"] as const;
export type SealPurpose = (typeof SEAL_PURPOSES)[number];

export interface SealedSecret {
  iv: string;
  ciphertext: string;
}

const IV_BYTES = 12;

export async function sealSecret(
  rootKeyBase64: string,
  purpose: SealPurpose,
  plaintext: Bytes,
): Promise<SealedSecret> {
  const key = await importAesGcmKey(await deriveWorkerKey(rootKeyBase64, purpose));
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Fails closed: any tampering, a wrong root key, a wrong purpose, or malformed
 * base64 raises, and the caller must treat that as "no valid secret" rather
 * than as an empty one.
 */
export async function openSecret(
  rootKeyBase64: string,
  purpose: SealPurpose,
  sealed: SealedSecret,
): Promise<Bytes> {
  const key = await importAesGcmKey(await deriveWorkerKey(rootKeyBase64, purpose));
  const iv = base64ToBytes(sealed.iv);
  if (iv.length !== IV_BYTES) {
    throw new RangeError("sealed secret has an invalid IV length");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBytes(sealed.ciphertext),
  );
  return new Uint8Array(plaintext);
}

export async function sealText(
  rootKeyBase64: string,
  purpose: SealPurpose,
  plaintext: string,
): Promise<SealedSecret> {
  return sealSecret(rootKeyBase64, purpose, utf8(plaintext));
}

export async function openText(
  rootKeyBase64: string,
  purpose: SealPurpose,
  sealed: SealedSecret,
): Promise<string> {
  return new TextDecoder().decode(await openSecret(rootKeyBase64, purpose, sealed));
}
