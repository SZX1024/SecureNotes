import { describe, expect, it } from "vitest";

import {
  AAD_PREFIX,
  CRYPTO_VERSION,
  OBJECT_TYPES,
  buildAad,
  canonicalAad,
  isObjectType,
  isValidObjectId,
} from "../src/crypto/format";

const base = {
  objectType: "note" as const,
  objectId: "018f2a6e-7c31-7a4d-9c1e-9b3f5a2d7e10",
  revision: 1,
  keyVersion: 1,
};

describe("crypto format constants", () => {
  it("freezes AES-256-GCM parameters", () => {
    expect(CRYPTO_VERSION).toBe(1);
    expect(AAD_PREFIX).toBe("SecureNotes/v1");
  });

  it("keeps object types unique", () => {
    expect(new Set(OBJECT_TYPES).size).toBe(OBJECT_TYPES.length);
    for (const type of OBJECT_TYPES) {
      expect(isObjectType(type)).toBe(true);
    }
    expect(isObjectType("nope")).toBe(false);
    expect(isObjectType(1)).toBe(false);
  });
});

describe("canonicalAad", () => {
  it("is deterministic and includes the default crypto version", () => {
    expect(canonicalAad(base)).toBe(
      `SecureNotes/v1|note|018f2a6e-7c31-7a4d-9c1e-9b3f5a2d7e10|1|1|${CRYPTO_VERSION}`,
    );
    expect(canonicalAad(base)).toBe(canonicalAad({ ...base }));
  });

  it("changes whenever a bound field changes", () => {
    const variants = [
      canonicalAad({ ...base, objectType: "folder" }),
      canonicalAad({ ...base, objectId: "other-id" }),
      canonicalAad({ ...base, revision: 2 }),
      canonicalAad({ ...base, keyVersion: 2 }),
      canonicalAad({ ...base, cryptoVersion: 2 }),
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(canonicalAad(base));
    }
    expect(new Set([canonicalAad(base), ...variants]).size).toBe(variants.length + 1);
  });

  it("cannot be made ambiguous through field separators in an id", () => {
    // "a|b" would let a crafted id shift the revision field; the charset check
    // rejects it before assembly.
    for (const hostile of ["a|b", "note|1", "a b", "", "a".repeat(65), "a\nb", "a|1|1|1"]) {
      expect(isValidObjectId(hostile)).toBe(false);
      expect(() => canonicalAad({ ...base, objectId: hostile })).toThrow(RangeError);
    }
  });

  it("rejects non-integer revisions, versions and unknown object types", () => {
    expect(() => canonicalAad({ ...base, revision: -1 })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base, revision: 1.5 })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base, keyVersion: 0 })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base, keyVersion: Number.NaN })).toThrow(RangeError);
    expect(() => canonicalAad({ ...base, cryptoVersion: 0 })).toThrow(RangeError);
    expect(() =>
      canonicalAad({ ...base, objectType: "script" as unknown as typeof base.objectType }),
    ).toThrow(RangeError);
  });

  it("produces UTF-8 AAD bytes identical to the canonical string", () => {
    const bytes = buildAad(base);
    expect(new TextDecoder().decode(bytes)).toBe(canonicalAad(base));
    expect(bytes.length).toBe(new TextEncoder().encode(canonicalAad(base)).length);
  });
});
