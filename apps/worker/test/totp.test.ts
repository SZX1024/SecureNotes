import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode } from "../src/lib/base32";
import {
  buildTotpUri,
  generateTotpCode,
  generateTotpSecret,
  totpStep,
  verifyTotpCode,
} from "../src/lib/totp";

/**
 * The RFC 6238 appendix B seed: the ASCII string "12345678901234567890".
 * Its base32 form is the canonical 32-character TOTP secret.
 */
const RFC_SECRET = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");

/** RFC 6238 §B SHA-1 vectors, truncated to the 6 digits this app uses. */
const RFC_VECTORS: ReadonlyArray<readonly [number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

describe("TOTP generation", () => {
  it("reproduces the RFC 6238 SHA-1 vectors", async () => {
    for (const [epochSeconds, expected] of RFC_VECTORS) {
      const step = totpStep(epochSeconds * 1000);
      await expect(generateTotpCode(RFC_SECRET, step), `T=${epochSeconds}`).resolves.toBe(expected);
    }
  });

  it("changes the code exactly on the period boundary", async () => {
    const before = await generateTotpCode(RFC_SECRET, totpStep(29_999));
    const after = await generateTotpCode(RFC_SECRET, totpStep(30_000));

    expect(before).not.toBe(after);
    expect(before).toHaveLength(6);
  });

  it("generates a 160-bit secret in base32", () => {
    const { bytes, base32 } = generateTotpSecret();

    expect(bytes).toHaveLength(20);
    expect(base32).toHaveLength(32);
    expect(base32).toMatch(/^[A-Z2-7]{32}$/);
    // Two enrolments must never share a secret.
    expect(generateTotpSecret().base32).not.toBe(base32);
  });

  it("builds an otpauth URI the client can render", () => {
    const uri = buildTotpUri("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "alice");

    expect(uri).toMatch(/^otpauth:\/\/totp\/SecureNotes%3Aalice\?/);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("TOTP verification", () => {
  const now = 1_111_111_111_000;
  const currentStep = totpStep(now);

  it("accepts the current code and reports its step", async () => {
    const code = await generateTotpCode(RFC_SECRET, currentStep);

    await expect(verifyTotpCode(RFC_SECRET, code, now)).resolves.toBe(currentStep);
  });

  it("accepts one step of clock drift either side", async () => {
    const previous = await generateTotpCode(RFC_SECRET, currentStep - 1);
    const next = await generateTotpCode(RFC_SECRET, currentStep + 1);

    await expect(verifyTotpCode(RFC_SECRET, previous, now)).resolves.toBe(currentStep - 1);
    await expect(verifyTotpCode(RFC_SECRET, next, now)).resolves.toBe(currentStep + 1);
  });

  it("rejects codes beyond the drift window", async () => {
    const tooOld = await generateTotpCode(RFC_SECRET, currentStep - 2);
    const tooNew = await generateTotpCode(RFC_SECRET, currentStep + 2);

    await expect(verifyTotpCode(RFC_SECRET, tooOld, now)).resolves.toBeNull();
    await expect(verifyTotpCode(RFC_SECRET, tooNew, now)).resolves.toBeNull();
  });

  it("rejects a code from a different secret", async () => {
    const otherSecret = base32Decode(base32Encode(generateTotpSecret().bytes));
    const code = await generateTotpCode(otherSecret, currentStep);

    await expect(verifyTotpCode(RFC_SECRET, code, now)).resolves.toBeNull();
  });

  it("rejects malformed input without throwing", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12345 ", " 123456"]) {
      await expect(verifyTotpCode(RFC_SECRET, bad, now), JSON.stringify(bad)).resolves.toBeNull();
    }
    // A well-formed code is accepted even with surrounding whitespace.
    const code = await generateTotpCode(RFC_SECRET, currentStep);
    await expect(verifyTotpCode(RFC_SECRET, ` ${code} `, now)).resolves.toBe(currentStep);
  });

  it("refuses to replay an already-consumed time-step", async () => {
    const code = await generateTotpCode(RFC_SECRET, currentStep);

    await expect(
      verifyTotpCode(RFC_SECRET, code, now, { lastUsedStep: currentStep }),
    ).resolves.toBeNull();
    // A code from an older step is also spent once a newer step was used.
    const older = await generateTotpCode(RFC_SECRET, currentStep - 1);
    await expect(
      verifyTotpCode(RFC_SECRET, older, now, { lastUsedStep: currentStep }),
    ).resolves.toBeNull();
  });
});
