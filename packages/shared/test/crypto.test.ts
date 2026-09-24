import { describe, expect, it } from "vitest";

import { base32Decode, base32Encode } from "../src/crypto/base32";
import { bytesToBase64, randomBytes, utf8, wipe } from "../src/crypto/bytes";
import {
  EnvelopeError,
  decryptJson,
  decryptObject,
  encryptJson,
  encryptObject,
  parseEnvelope,
} from "../src/crypto/envelope";
import { AES_GCM_IV_BYTES, CRYPTO_VERSION, KEY_VERSION_INITIAL } from "../src/crypto/format";
import {
  buildRecoveryWrappings,
  deriveKek,
  deriveRecoveryKek,
  generateDekRaw,
  importDek,
  normalizeRecoveryCode,
  unwrapDek,
  wrapDek,
} from "../src/crypto/keys";

/**
 * The cryptographic core of requirements §6.
 *
 * These are the tests that matter most in the repository: everything else
 * protects ciphertext, but these decide whether the ciphertext is actually
 * confidential and whether it can be recovered at all.
 */

const USER_ID = "0192f0aa-1111-7000-8000-000000000001";
const KDF_SALT = bytesToBase64(randomBytes(16));
/** A valid 160-bit base32 secret, as the server generates at enrolment. */
const TOTP_SECRET = base32Encode(randomBytes(20));

function account() {
  return { username: "alice", totpSecretBase32: TOTP_SECRET, kdfSaltBase64: KDF_SALT };
}

const noteAad = {
  objectType: "note" as const,
  objectId: "0192f0aa-2222-7000-8000-000000000002",
  revision: 1,
  keyVersion: KEY_VERSION_INITIAL,
};

describe("object envelopes (§6)", () => {
  it("round-trips a payload", async () => {
    const dek = await importDek(generateDekRaw());
    const plaintext = utf8('{"title":"Groceries","body":"milk"}');

    const envelope = await encryptObject(dek, noteAad, plaintext);
    const decrypted = await decryptObject(dek, noteAad, envelope);

    expect(new TextDecoder().decode(decrypted)).toBe('{"title":"Groceries","body":"milk"}');
    expect(envelope.alg).toBe("AES-256-GCM");
    expect(envelope.crypto_version).toBe(CRYPTO_VERSION);
    expect(envelope.key_version).toBe(KEY_VERSION_INITIAL);
    expect(base32Encode(base32Decode(TOTP_SECRET))).toBe(TOTP_SECRET);
  });

  it("uses a fresh 96-bit IV for every encryption (§6)", async () => {
    const dek = await importDek(generateDekRaw());
    const ivs = new Set<string>();
    const ciphertexts = new Set<string>();
    const plaintext = utf8("identical plaintext");

    for (let index = 0; index < 50; index += 1) {
      const envelope = await encryptObject(dek, noteAad, plaintext);
      expect(ivs.has(envelope.iv), "IV was reused").toBe(false);
      expect(ciphertexts.has(envelope.ciphertext), "ciphertext repeated").toBe(false);
      ivs.add(envelope.iv);
      ciphertexts.add(envelope.ciphertext);
    }
    expect(ivs.size).toBe(50);
  });

  it("binds the object type, id, revision and key version through the AAD", async () => {
    const dek = await importDek(generateDekRaw());
    const envelope = await encryptObject(dek, noteAad, utf8("secret"));

    const mismatches = [
      { ...noteAad, objectType: "folder" as const },
      { ...noteAad, objectId: "0192f0aa-3333-7000-8000-000000000003" },
      { ...noteAad, revision: 2 },
      { ...noteAad, keyVersion: 2 },
    ];

    for (const aad of mismatches) {
      await expect(decryptObject(dek, aad, envelope)).rejects.toThrow(EnvelopeError);
    }
    // The original identity still decrypts, proving the failures were the AAD.
    await expect(decryptObject(dek, noteAad, envelope)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("fails closed on a tampered ciphertext or a wrong key", async () => {
    const dek = await importDek(generateDekRaw());
    const otherDek = await importDek(generateDekRaw());
    const envelope = await encryptObject(dek, noteAad, utf8("secret"));

    const raw = Uint8Array.from(atob(envelope.ciphertext), (character) => character.charCodeAt(0));
    raw[0] = (raw[0] ?? 0) ^ 0x01;
    const tampered = { ...envelope, ciphertext: btoa(String.fromCharCode(...raw)) };

    await expect(decryptObject(dek, noteAad, tampered)).rejects.toThrow(EnvelopeError);
    await expect(decryptObject(otherDek, noteAad, envelope)).rejects.toThrow(EnvelopeError);
  });

  it("round-trips JSON payloads", async () => {
    const dek = await importDek(generateDekRaw());
    const value = { title: "ünïcode ✓", tags: ["a", "b"], nested: { n: 1 } };

    const envelope = await encryptJson(dek, noteAad, value);
    await expect(decryptJson(dek, noteAad, envelope)).resolves.toEqual(value);
  });

  it("rejects envelopes from an unknown crypto version", async () => {
    const dek = await importDek(generateDekRaw());
    const envelope = await encryptObject(dek, noteAad, utf8("secret"));

    await expect(
      decryptObject(dek, noteAad, { ...envelope, crypto_version: CRYPTO_VERSION + 1 }),
    ).rejects.toThrow(/crypto_version/);
  });
});

describe("envelope validation", () => {
  it("accepts a well-formed envelope", () => {
    const envelope = {
      crypto_version: CRYPTO_VERSION,
      key_version: 1,
      alg: "AES-256-GCM",
      iv: bytesToBase64(randomBytes(AES_GCM_IV_BYTES)),
      ciphertext: bytesToBase64(randomBytes(32)),
    };

    expect(parseEnvelope(envelope)).toEqual(envelope);
  });

  it("rejects malformed input the worker may receive", () => {
    const valid = {
      crypto_version: CRYPTO_VERSION,
      key_version: 1,
      alg: "AES-256-GCM",
      iv: bytesToBase64(randomBytes(AES_GCM_IV_BYTES)),
      ciphertext: bytesToBase64(randomBytes(32)),
    };

    const invalid: unknown[] = [
      null,
      "string",
      {},
      { ...valid, alg: "AES-128-GCM" },
      { ...valid, crypto_version: 0 },
      { ...valid, crypto_version: 1.5 },
      { ...valid, key_version: "1" },
      { ...valid, iv: "AAAA" },
      { ...valid, iv: "not base64!!" },
      { ...valid, ciphertext: "AAAA" },
      { ...valid, ciphertext: 42 },
    ];

    for (const value of invalid) {
      expect(() => parseEnvelope(value), JSON.stringify(value)).toThrow(EnvelopeError);
    }
  });
});

describe("key hierarchy (§6)", () => {
  it("derives a deterministic KEK from the account credentials", async () => {
    const first = await deriveKek(account());
    const second = await deriveKek(account());

    // A different DEK wrapping by each derivation must still be interchangeable.
    const raw = generateDekRaw();
    const wrapped = await wrapDek(first, raw, { userId: USER_ID });
    await expect(unwrapDek(second, wrapped, { userId: USER_ID })).resolves.toEqual(raw);
  });

  it("derives a different KEK when any input changes", async () => {
    const baseline = await deriveKek(account());
    const raw = generateDekRaw();
    const wrapped = await wrapDek(baseline, raw, { userId: USER_ID });

    const variants = [
      { ...account(), username: "alicf" },
      { ...account(), totpSecretBase32: base32Encode(randomBytes(20)) },
      { ...account(), kdfSaltBase64: bytesToBase64(randomBytes(16)) },
    ];

    for (const variant of variants) {
      const kek = await deriveKek(variant);
      await expect(unwrapDek(kek, wrapped, { userId: USER_ID })).rejects.toThrow(EnvelopeError);
    }
  });

  it("imports the DEK as a non-extractable key (§7)", async () => {
    const dek = await importDek(generateDekRaw());

    expect(dek.extractable).toBe(false);
    expect(dek.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(dek.usages).toEqual(["encrypt", "decrypt"]);
    await expect(crypto.subtle.exportKey("raw", dek)).rejects.toThrow();
  });

  it("rejects a DEK of the wrong length", async () => {
    await expect(importDek(randomBytes(16))).rejects.toThrow(EnvelopeError);
    await expect(
      wrapDek(await deriveKek(account()), randomBytes(16), { userId: USER_ID }),
    ).rejects.toThrow(EnvelopeError);
  });

  it("tracks the key version in the AAD and the envelope", async () => {
    const kek = await deriveKek(account());
    const raw = generateDekRaw();

    const wrapped = await wrapDek(kek, raw, { userId: USER_ID, keyVersion: 2 });
    expect(wrapped.key_version).toBe(2);
    await expect(unwrapDek(kek, wrapped, { userId: USER_ID, keyVersion: 2 })).resolves.toEqual(raw);

    // A wrapping from another generation must not unwrap as this one.
    await expect(unwrapDek(kek, wrapped, { userId: USER_ID, keyVersion: 3 })).rejects.toThrow(
      EnvelopeError,
    );
    // Nor may it be mistaken for another account's material.
    await expect(
      unwrapDek(kek, wrapped, { userId: "0192f0aa-9999-7000-8000-000000000009", keyVersion: 2 }),
    ).rejects.toThrow(EnvelopeError);
  });
});

describe("recovery path (§6)", () => {
  const codes = Array.from({ length: 10 }, () => ({
    code: base32Encode(randomBytes(20)).slice(0, 32),
    salt: bytesToBase64(randomBytes(16)),
  }));

  it("recovers the same DEK through each of the ten codes", async () => {
    const rawDek = generateDekRaw();
    const wrappings = await buildRecoveryWrappings(rawDek, codes, { userId: USER_ID });

    expect(wrappings).toHaveLength(10);

    for (const [index, entry] of codes.entries()) {
      const recoveryKek = await deriveRecoveryKek(entry.code, entry.salt);
      const recovered = await unwrapDek(recoveryKek, wrappings[index]!, { userId: USER_ID });
      expect(recovered, `code ${index}`).toEqual(rawDek);
    }
  });

  it("gives each code an independent wrapping", async () => {
    const rawDek = generateDekRaw();
    const wrappings = await buildRecoveryWrappings(rawDek, codes, { userId: USER_ID });

    // Identical IVs or ciphertexts would mean the codes are not independent.
    expect(new Set(wrappings.map((w) => w.iv)).size).toBe(10);
    expect(new Set(wrappings.map((w) => w.ciphertext)).size).toBe(10);
  });

  it("fails for a wrong code or a wrong salt", async () => {
    const rawDek = generateDekRaw();
    const wrappings = await buildRecoveryWrappings(rawDek, codes, { userId: USER_ID });
    const target = codes[0]!;

    const wrongCode = await deriveRecoveryKek(
      base32Encode(randomBytes(20)).slice(0, 32),
      target.salt,
    );
    await expect(unwrapDek(wrongCode, wrappings[0]!, { userId: USER_ID })).rejects.toThrow(
      EnvelopeError,
    );

    const wrongSalt = await deriveRecoveryKek(target.code, bytesToBase64(randomBytes(16)));
    await expect(unwrapDek(wrongSalt, wrappings[0]!, { userId: USER_ID })).rejects.toThrow(
      EnvelopeError,
    );
  });

  it("is not interchangeable with the account KEK path", async () => {
    const rawDek = generateDekRaw();
    const kekWrapped = await wrapDek(await deriveKek(account()), rawDek, { userId: USER_ID });
    const recoveryKek = await deriveRecoveryKek(codes[0]!.code, codes[0]!.salt);

    await expect(unwrapDek(recoveryKek, kekWrapped, { userId: USER_ID })).rejects.toThrow(
      EnvelopeError,
    );
  });

  it("normalises how a code may be typed", async () => {
    const rawDek = generateDekRaw();
    const entry = {
      code: "ABCD2345EFGH6789JKLM2345NPQR6789",
      salt: bytesToBase64(randomBytes(16)),
    };
    const wrapping = (await buildRecoveryWrappings(rawDek, [entry], { userId: USER_ID }))[0]!;

    for (const typed of [
      "ABCD2345EFGH6789JKLM2345NPQR6789",
      "abcd2345efgh6789jklm2345npqr6789",
      "  ABCD2345 EFGH6789 JKLM2345 NPQR6789  ",
      "ABCD2345-EFGH6789-JKLM2345-NPQR6789",
    ]) {
      const kek = await deriveRecoveryKek(typed, entry.salt);
      await expect(unwrapDek(kek, wrapping, { userId: USER_ID }), typed).resolves.toEqual(rawDek);
    }
    expect(normalizeRecoveryCode("  ab-cd  ")).toBe("ABCD");
  });
});

describe("key material hygiene", () => {
  it("wipes a buffer and leaves it unusable", () => {
    const secret = generateDekRaw();
    expect(secret.some((byte) => byte !== 0)).toBe(true);

    wipe(secret);
    expect(secret.every((byte) => byte === 0)).toBe(true);
    wipe(null);
    wipe(undefined);
  });

  it("never returns the DEK in an envelope field", async () => {
    const rawDek = generateDekRaw();
    const wrapping = await wrapDek(await deriveKek(account()), rawDek, { userId: USER_ID });
    const serialized = JSON.stringify(wrapping);

    expect(serialized).not.toContain(bytesToBase64(rawDek));
    expect(Object.keys(wrapping).sort()).toEqual([
      "alg",
      "ciphertext",
      "crypto_version",
      "iv",
      "key_version",
    ]);
  });
});
