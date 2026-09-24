import { utf8 } from "@securenotes/shared";
import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode } from "../src/lib/base32";

/** RFC 4648 §10 vectors, with the padding stripped (TOTP secrets are unpadded). */
const RFC_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ["", ""],
  ["f", "MY"],
  ["fo", "MZXQ"],
  ["foo", "MZXW6"],
  ["foob", "MZXW6YQ"],
  ["fooba", "MZXW6YTB"],
  ["foobar", "MZXW6YTBOI"],
];

describe("base32", () => {
  it("matches the RFC 4648 vectors when encoding", () => {
    for (const [plain, encoded] of RFC_VECTORS) {
      expect(base32Encode(utf8(plain)), `encode(${plain})`).toBe(encoded);
    }
  });

  it("matches the RFC 4648 vectors when decoding", () => {
    // The empty vector is excluded: a zero-length secret is never valid here and
    // `base32Decode` rejects it on purpose (see the last case below).
    for (const [plain, encoded] of RFC_VECTORS.filter(([, encoded]) => encoded !== "")) {
      expect(new TextDecoder().decode(base32Decode(encoded)), `decode(${encoded})`).toBe(plain);
    }
  });

  it("round-trips random byte strings of every length residue", () => {
    for (let length = 1; length <= 40; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it("accepts lowercase and padded input", () => {
    expect(new TextDecoder().decode(base32Decode("mzxw6ytboi======"))).toBe("foobar");
  });

  it("rejects characters outside the alphabet instead of guessing", () => {
    // 0, 1, 8 and 9 are not in the base32 alphabet; a permissive decoder would
    // silently produce a different secret and therefore different keys.
    for (const invalid of ["MZXW0", "MZXW1", "MZXW8", "MZXW9", "MZXW!", "MZXW "]) {
      expect(() => base32Decode(invalid), invalid).toThrow(RangeError);
    }
  });

  it("rejects trailing bits that are not zero padding", () => {
    // "MZ" would decode to a whole byte only if the leftover bits were zero.
    expect(() => base32Decode("MZ")).toThrow(RangeError);
  });

  it("rejects empty input", () => {
    expect(() => base32Decode("")).toThrow(RangeError);
    expect(() => base32Decode("====")).toThrow(RangeError);
  });
});
