import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  type Bytes,
} from "@securenotes/shared";

import { base32Encode } from "./base32";
import { hmac, randomBytes } from "./crypto";

/**
 * RFC 6238 TOTP over the secret generated at enrolment (§3).
 *
 * Only the long-lived secret is ever a KDF input — never a 6-digit code (§6) —
 * so a code that leaks in transit cannot be turned into a key.
 */

/** A fresh 160-bit secret, shown once as a QR code. */
export function generateTotpSecret(): { bytes: Bytes; base32: string } {
  const bytes = randomBytes(TOTP_SECRET_BYTES);
  return { bytes, base32: base32Encode(bytes) };
}

/** Time-step index for an epoch-millisecond instant. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export async function generateTotpCode(secret: Bytes, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let remaining = step;
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  const digest = await hmac("SHA-1", secret, counter);
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Checks a submitted code and returns the time-step it matched, or null.
 *
 * `lastUsedStep` implements the anti-replay rule: a code whose step has already
 * been accepted is rejected even inside its validity window (RFC 6238 §5.2).
 * Comparing the digits with a constant-time helper would be pointless — the
 * code has only a million values and is rate limited — but the step check is
 * what makes replay impossible rather than merely expensive.
 */
export async function verifyTotpCode(
  secret: Bytes,
  submittedCode: string,
  nowMs: number,
  options: { lastUsedStep?: number | null; windowSteps?: number } = {},
): Promise<number | null> {
  const normalized = submittedCode.trim();
  if (!new RegExp(`^[0-9]{${TOTP_DIGITS}}$`).test(normalized)) {
    return null;
  }

  const windowSteps = options.windowSteps ?? 1;
  const currentStep = totpStep(nowMs);
  const lastUsedStep = options.lastUsedStep ?? null;

  for (let offset = -windowSteps; offset <= windowSteps; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) {
      continue;
    }
    if (lastUsedStep !== null && step <= lastUsedStep) {
      continue;
    }
    const expected = await generateTotpCode(secret, step);
    if (timingSafeDigitsEqual(expected, normalized)) {
      return step;
    }
  }
  return null;
}

function timingSafeDigitsEqual(a: string, b: string): boolean {
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
 * The `otpauth://` URI the client renders as a QR code. Kept on the server so
 * the label and issuer stay consistent across devices.
 */
export function buildTotpUri(
  secretBase32: string,
  username: string,
  issuer = "SecureNotes",
): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
