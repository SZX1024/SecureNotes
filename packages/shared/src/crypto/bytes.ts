/**
 * Byte-level primitives shared by the client (which performs all plaintext
 * encryption) and the worker (which only ever handles envelopes).
 *
 * Everything here is deliberately dependency-free and synchronous except the
 * digest, so the same code is used in the browser, in workerd and in tests.
 */

/**
 * A `Uint8Array` over a non-shared `ArrayBuffer`.
 *
 * WebCrypto's `BufferSource` does not accept `Uint8Array<SharedArrayBuffer>`,
 * and TypeScript's default `Uint8Array` is the union of both, so every byte
 * value that reaches a crypto call is typed through this alias.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(value: string): Bytes {
  // Copied into a fresh buffer so the result is never a SharedArrayBuffer view,
  // which WebCrypto's BufferSource rejects.
  return new Uint8Array(textEncoder.encode(value));
}

export function fromUtf8(bytes: Bytes): string {
  return textDecoder.decode(bytes);
}

export function bytesToHex(bytes: Bytes): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBase64(bytes: Bytes): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Concatenates byte strings. Used to build HKDF input material, where an
 * accidental ambiguity between two fields would derive a different key.
 */
export function concatBytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Random bytes from the platform CSPRNG. Never `Math.random`. */
export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Hex SHA-256, the storage form of every verification digest in the schema. */
export async function sha256Hex(value: string | Bytes): Promise<string> {
  return bytesToHex(await sha256(typeof value === "string" ? utf8(value) : value));
}

/**
 * Compares two hex digests without an early exit, so verification time does not
 * reveal how many leading characters were guessed correctly.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Overwrites a buffer that held key material.
 *
 * JavaScript cannot guarantee a value never reached swap or a heap snapshot, so
 * this is best-effort hygiene rather than a security boundary — but it shortens
 * the window in which a plaintext key is readable, and it makes the intent
 * explicit at the call site.
 */
export function wipe(bytes: Bytes | null | undefined): void {
  bytes?.fill(0);
}
