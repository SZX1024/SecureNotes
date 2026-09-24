import { utf8 } from "@securenotes/shared";
import { describe, expect, it } from "vitest";

import { classifyClient, truncateIp } from "../src/lib/client-meta";
import {
  base64ToBytes,
  bytesToBase64,
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  uuidv7,
} from "../src/lib/crypto";
import { openSecret, sealSecret } from "../src/lib/secret-box";

const WRAP_KEY = "dGVzdC1zZWNyZXQtd3JhcC1rZXktMzItYnl0ZXMhISE=";

describe("crypto helpers", () => {
  it("hashes to the known SHA-256 hex digest", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("round-trips base64", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(37));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("produces URL-safe tokens of the requested entropy", () => {
    const token = randomToken(32);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url, unpadded.
    expect(token).toHaveLength(43);
    expect(randomToken(32)).not.toBe(token);
  });

  it("compares digests without an early exit", () => {
    const digest = "a".repeat(64);
    expect(timingSafeEqualHex(digest, digest)).toBe(true);
    expect(timingSafeEqualHex(digest, `${"a".repeat(63)}b`)).toBe(false);
    expect(timingSafeEqualHex(digest, "a".repeat(63))).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});

describe("uuidv7", () => {
  it("encodes the timestamp, version and variant", () => {
    const id = uuidv7(1_760_000_000_000, crypto.getRandomValues(new Uint8Array(10)));

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The 48-bit prefix is the millisecond timestamp.
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(1_760_000_000_000);
  });

  it("sorts lexicographically by creation time", () => {
    const ids = [1_000, 2_000, 3_000].map((ms) =>
      uuidv7(ms, crypto.getRandomValues(new Uint8Array(10))),
    );

    expect([...ids].sort()).toEqual(ids);
  });

  it("is unguessable for the same millisecond", () => {
    const first = uuidv7(1_760_000_000_000, crypto.getRandomValues(new Uint8Array(10)));
    const second = uuidv7(1_760_000_000_000, crypto.getRandomValues(new Uint8Array(10)));

    expect(first).not.toBe(second);
    // Identical timestamps must still differ in the random tail.
    expect(first.slice(13)).not.toBe(second.slice(13));
  });

  it("refuses too little randomness", () => {
    expect(() => uuidv7(0, new Uint8Array(9))).toThrow(RangeError);
  });
});

describe("secret box", () => {
  it("round-trips a secret", async () => {
    const plaintext = utf8("JBSWY3DPEHPK3PXP");
    const sealed = await sealSecret(WRAP_KEY, "totp-secret", plaintext);

    expect(sealed.iv).not.toBe("");
    expect(new TextDecoder().decode(await openSecret(WRAP_KEY, "totp-secret", sealed))).toBe(
      "JBSWY3DPEHPK3PXP",
    );
  });

  it("uses a fresh IV per sealing", async () => {
    const plaintext = utf8("same plaintext");

    const first = await sealSecret(WRAP_KEY, "totp-secret", plaintext);
    const second = await sealSecret(WRAP_KEY, "totp-secret", plaintext);

    // Reusing an IV under the same key would be a catastrophic AES-GCM failure.
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("keeps purposes separated under one root key", async () => {
    const sealed = await sealSecret(WRAP_KEY, "totp-secret", utf8("secret"));

    // A different purpose derives a different key, so the blob cannot be
    // reinterpreted as a different kind of secret.
    await expect(openSecret(WRAP_KEY, "audit-detail", sealed)).rejects.toThrow();
  });

  it("fails closed on tampering or a wrong key", async () => {
    const sealed = await sealSecret(WRAP_KEY, "totp-secret", utf8("secret"));

    const tamperedBytes = base64ToBytes(sealed.ciphertext);
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0x01;
    const tampered = { iv: sealed.iv, ciphertext: bytesToBase64(tamperedBytes) };

    // A different but equally valid 256-bit root: proves the key is what
    // authenticates the ciphertext, not just the shape of the input.
    const otherKeyBytes = base64ToBytes(WRAP_KEY);
    otherKeyBytes[31] = (otherKeyBytes[31] ?? 0) ^ 0xff;

    await expect(openSecret(WRAP_KEY, "totp-secret", tampered)).rejects.toThrow();
    await expect(openSecret(bytesToBase64(otherKeyBytes), "totp-secret", sealed)).rejects.toThrow();
  });

  it("rejects a malformed IV length", async () => {
    const sealed = await sealSecret(WRAP_KEY, "totp-secret", utf8("secret"));

    await expect(openSecret(WRAP_KEY, "totp-secret", { ...sealed, iv: "AAAA" })).rejects.toThrow(
      RangeError,
    );
  });

  it("rejects a root key that is not 256-bit", async () => {
    await expect(
      sealSecret(bytesToBase64(new Uint8Array(16)), "totp-secret", new Uint8Array(1)),
    ).rejects.toThrow(RangeError);
  });
});

describe("client metadata", () => {
  it("truncates IPv4 to /24 and IPv6 to /48", () => {
    expect(truncateIp("203.0.113.42")).toBe("203.0.113.0/24");
    expect(truncateIp("2001:db8:1234:5678:9abc:def0:1234:5678")).toBe("2001:db8:1234::/48");
    expect(truncateIp("2001:db8:1234::1")).toBe("2001:db8:1234::/48");
  });

  it("never stores the full address, and drops the zone index", () => {
    const full = "2001:db8:1234:5678:9abc:def0:1234:5678";
    expect(truncateIp(full)).not.toContain("5678");
    expect(truncateIp("2001:db8:1234::1%eth0")).not.toContain("eth0");
    expect(truncateIp("203.0.113.42")).not.toContain("42");
  });

  it("stores nothing for missing or malformed addresses", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "not-an-ip",
      "1.2.3",
      "1.2.3.4.5",
      "999.1.1.1.x",
    ]) {
      expect(truncateIp(value), String(value)).toBeNull();
    }
  });

  it("classifies browsers and platforms without keeping the raw agent", () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
    expect(classifyClient(chrome)).toBe("Chrome on Windows");
    expect(classifyClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605.1")).toBe(
      "Safari on iOS",
    );

    // Unknown or absent agents must not echo the raw string back.
    expect(classifyClient(null)).toBe("Unknown");
    expect(classifyClient("<script>alert(1)</script>")).toBe("Unknown on Unknown");
    expect(classifyClient("<script>alert(1)</script>")).not.toContain("script");
  });
});
