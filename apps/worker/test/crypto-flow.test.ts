import {
  KEY_VERSION_INITIAL,
  buildRecoveryWrappings,
  bytesToBase64,
  deriveKek,
  deriveRecoveryKek,
  generateDekRaw,
  unwrapDek,
  wrapDek,
  type Bytes,
  type CryptoEnvelope,
} from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { base32Decode } from "../src/lib/base32";
import { generateTotpCode, totpStep } from "../src/lib/totp";
import {
  apiRequest,
  authedRequest,
  clearTotpReplayGuard,
  createAccount,
  errorCode,
  login,
  loginOnce,
  resetRateLimits,
  testEnv,
  type CookieJar,
  type TestAccount,
} from "./support";

/**
 * The key-material and TOTP rebind flows, driven with the **real client
 * cryptography** from `@securenotes/shared`.
 *
 * This is the strongest test in the repository: it runs the exact code the
 * browser will run, against the real worker and a real database, and it checks
 * the two claims that matter most in requirements §32 — that recovery can
 * recover the DEK, and that a TOTP change preserves the data.
 */

let account: TestAccount;
let jar: CookieJar;
let userId: string;
let kdfSalt: string;
/** The account's data key, held only for the lifetime of this test file. */
let rawDek: Bytes;

/** Fetches a one-time nonce for a sensitive operation. */
async function nonce(operation: string, session: CookieJar = jar): Promise<string> {
  const response = await authedRequest<{ ok: true; data: { nonce: string } }>(
    "/security/operation-nonce",
    session,
    { method: "POST", body: { operation } },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.nonce;
}

/** Derives the KEK exactly as the browser would, from the delivered material. */
async function kekFor(totpSecret: string) {
  return deriveKek({
    username: account.username,
    totpSecretBase32: totpSecret,
    kdfSaltBase64: kdfSalt,
  });
}

async function totpFor(secretBase32: string): Promise<string> {
  return generateTotpCode(base32Decode(secretBase32), totpStep(Date.now()));
}

/** The payload a client uploads once it has generated and wrapped a DEK. */
async function buildUpload(dek: Bytes, totpSecret: string, keyVersion: number, nonceValue: string) {
  return {
    nonce: nonceValue,
    keyVersion,
    wrappedDek: await wrapDek(await kekFor(totpSecret), dek, { userId, keyVersion }),
    recoveryWrappings: (
      await buildRecoveryWrappings(dek, account.recoveryCodes, { userId, keyVersion })
    ).map((envelope, index) => ({ salt: account.recoveryCodes[index]!.salt, envelope })),
  };
}

/** Reads the account's wrapped DEK through the API. */
async function currentWrappedDek(session: CookieJar = jar) {
  const response = await authedRequest<{
    ok: true;
    data: { wrappedDek: CryptoEnvelope; keyVersion: number; keyMaterialPresent: boolean };
  }>("/key-material", session);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

beforeAll(async () => {
  account = await createAccount();
  const session = await loginOnce(account);
  jar = session.jar;
  userId = session.data.userId;
  kdfSalt = session.data.kdfSalt;
  rawDek = generateDekRaw();
});

beforeEach(resetRateLimits);

describe("account key material (§6)", () => {
  it("accepts a client-wrapped DEK, stores it opaquely and gives it back", async () => {
    const upload = await buildUpload(
      rawDek,
      account.totpSecret,
      KEY_VERSION_INITIAL,
      await nonce("key-material-upload"),
    );

    const response = await authedRequest<{ ok: true; data: { keyMaterialPresent: boolean } }>(
      "/key-material",
      jar,
      { method: "POST", body: upload },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.keyMaterialPresent).toBe(true);

    // Only opaque wrappings are stored: no column holds the raw DEK.
    const row = await testEnv.DB.prepare(
      "SELECT wrapped_dek_iv AS iv, wrapped_dek_ciphertext AS ct FROM users LIMIT 1",
    ).first<{ iv: string; ct: string }>();
    expect(row?.ct).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(bytesToBase64(rawDek));

    // Every recovery code now carries its own wrapping.
    const wrapped = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM recovery_codes WHERE wrapped_dek_ciphertext IS NOT NULL",
    ).first<number>("c");
    expect(wrapped).toBe(account.recoveryCodes.length);

    // Round trip through the API with the real KEK: the client can unlock.
    const fetched = await currentWrappedDek();
    const recovered = await unwrapDek(await kekFor(account.totpSecret), fetched.wrappedDek, {
      userId,
      keyVersion: fetched.keyVersion,
    });
    expect(recovered).toEqual(rawDek);
  });

  it("rejects a malformed envelope", async () => {
    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      KEY_VERSION_INITIAL,
      await nonce("key-material-upload"),
    );

    const response = await authedRequest("/key-material", jar, {
      method: "POST",
      body: { ...upload, wrappedDek: { ...upload.wrappedDek, iv: "AAAA" } },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
  });

  it("rejects a key version that disagrees with the envelopes", async () => {
    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      KEY_VERSION_INITIAL,
      await nonce("key-material-upload"),
    );

    const response = await authedRequest("/key-material", jar, {
      method: "POST",
      body: { ...upload, keyVersion: 7 },
    });
    expect(response.status).toBe(400);
  });

  it("refuses a partial set of recovery wrappings", async () => {
    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      KEY_VERSION_INITIAL,
      await nonce("key-material-upload"),
    );

    const response = await authedRequest("/key-material", jar, {
      method: "POST",
      body: { ...upload, recoveryWrappings: upload.recoveryWrappings.slice(0, 3) },
    });

    // A partially wrapped set is a recovery path that silently does not work.
    expect(response.status).toBe(400);
  });

  it("refuses a wrapping for a salt the account does not have", async () => {
    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      KEY_VERSION_INITIAL,
      await nonce("key-material-upload"),
    );
    const wrappings = [...upload.recoveryWrappings];
    wrappings[0] = { ...wrappings[0]!, salt: bytesToBase64(new Uint8Array(16)) };

    const response = await authedRequest("/key-material", jar, {
      method: "POST",
      body: { ...upload, recoveryWrappings: wrappings },
    });
    expect(response.status).toBe(400);
  });
});

describe("one-time nonces (§26)", () => {
  it("requires a nonce for a sensitive operation", async () => {
    const response = await authedRequest("/key-material", jar, {
      method: "POST",
      body: { keyVersion: 1, wrappedDek: {}, recoveryWrappings: [] },
    });
    expect(response.status).toBe(400);
  });

  it("refuses to spend the same nonce twice", async () => {
    const value = await nonce("key-material-upload");
    const upload = await buildUpload(rawDek, account.totpSecret, KEY_VERSION_INITIAL, value);

    const first = await authedRequest("/key-material", jar, { method: "POST", body: upload });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const replay = await authedRequest("/key-material", jar, { method: "POST", body: upload });
    expect(replay.status).toBe(412);
    expect(errorCode(replay.body)).toBe("PRECONDITION_FAILED");
  });

  it("refuses a nonce issued for a different operation", async () => {
    const value = await nonce("totp-change-start");
    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      KEY_VERSION_INITIAL,
      value,
    );

    const response = await authedRequest("/key-material", jar, { method: "POST", body: upload });
    expect(response.status).toBe(412);
  });

  it("refuses a nonce issued to another session", async () => {
    await clearTotpReplayGuard();
    const other = await loginOnce(account, { ip: "203.0.113.240" });
    const value = await nonce("key-material-upload");

    // The nonce was issued to `jar`; spending it from another session must fail.
    const upload = await buildUpload(rawDek, account.totpSecret, KEY_VERSION_INITIAL, value);
    const response = await authedRequest("/key-material", other.jar, {
      method: "POST",
      body: upload,
    });
    expect(response.status).toBe(412);
  });
});

describe("TOTP rebind: interruption and rollback (§3)", () => {
  it("refuses to complete a rebind that was never verified", async () => {
    await authedRequest("/security/totp/change/start", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-start") },
    });

    const upload = await buildUpload(
      generateDekRaw(),
      account.totpSecret,
      (await currentWrappedDek()).keyVersion + 1,
      await nonce("totp-change-complete"),
    );
    const response = await authedRequest("/security/totp/change/complete", jar, {
      method: "POST",
      body: upload,
    });
    expect(response.status).toBe(412);

    await authedRequest("/security/totp/change/rollback", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-rollback") },
    });
  });

  it("rejects a wrong code against the pending secret", async () => {
    await authedRequest("/security/totp/change/start", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-start") },
    });

    const response = await authedRequest("/security/totp/change/verify", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-verify"), code: "000000" },
    });
    expect(response.status).toBe(401);

    await authedRequest("/security/totp/change/rollback", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-rollback") },
    });
  });

  it("rolls back cleanly, leaving the stored wrapping untouched", async () => {
    const before = await currentWrappedDek();

    const started = await authedRequest<{ ok: true; data: { keyVersion: number } }>(
      "/security/totp/change/start",
      jar,
      { method: "POST", body: { nonce: await nonce("totp-change-start") } },
    );
    expect(started.status).toBe(200);

    const rolledBack = await authedRequest("/security/totp/change/rollback", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-rollback") },
    });
    expect(rolledBack.status).toBe(200);

    const state = await testEnv.DB.prepare(
      "SELECT rebind_state AS s, pending_secret_ciphertext AS p FROM totp_config LIMIT 1",
    ).first<{ s: string; p: string | null }>();
    expect(state?.s).toBe("idle");
    expect(state?.p).toBeNull();

    // Nothing about the stored key material changed, so the account still works.
    const after = await currentWrappedDek();
    expect(after.wrappedDek.ciphertext).toBe(before.wrappedDek.ciphertext);
    expect(after.keyVersion).toBe(before.keyVersion);
  });

  it("can be resumed after an interruption, before any wrapping changed", async () => {
    const started = await authedRequest<{ ok: true; data: { totpSecretBase32: string } }>(
      "/security/totp/change/start",
      jar,
      { method: "POST", body: { nonce: await nonce("totp-change-start") } },
    );
    const pendingSecret = started.body.data.totpSecretBase32;

    const verified = await authedRequest("/security/totp/change/verify", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-verify"), code: await totpFor(pendingSecret) },
    });
    expect(verified.status).toBe(200);

    // The client "crashes" here. Because the old secret is still active, a new
    // login succeeds and reports everything needed to finish the migration.
    await clearTotpReplayGuard();
    const resumed = await loginOnce(account, { ip: "203.0.113.253" });

    expect(resumed.data.rebindState).toBe("rewrapping");
    expect(resumed.data.pendingTotpSecret).toBe(pendingSecret);
    expect(resumed.data.keyMaterialPresent).toBe(true);

    // The stored wrapping is still the old one, so the interrupted migration
    // has changed nothing and can be abandoned safely.
    const state = await testEnv.DB.prepare(
      "SELECT rebind_state AS s FROM totp_config LIMIT 1",
    ).first<string>("s");
    expect(state).toBe("rewrapping");

    const rolledBack = await authedRequest("/security/totp/change/rollback", resumed.jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-rollback", resumed.jar) },
    });
    expect(rolledBack.status).toBe(200);
  });

  it("discards a pending rebind that was abandoned", async () => {
    await authedRequest("/security/totp/change/start", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-start") },
    });

    // Model an abandoned rebind by expiring it rather than waiting 15 minutes.
    await testEnv.DB.prepare(
      "UPDATE totp_config SET rebind_started_at = ?1 WHERE rebind_started_at IS NOT NULL",
    )
      .bind(Date.now() - 60 * 60 * 1000)
      .run();

    const response = await authedRequest("/security/totp/change/verify", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-verify"), code: "000000" },
    });
    // A stale rebind is refused and cleared rather than left usable.
    expect(response.status).toBe(412);

    const state = await testEnv.DB.prepare(
      "SELECT rebind_state AS s FROM totp_config LIMIT 1",
    ).first<string>("s");
    expect(state).toBe("idle");
  });
});

/**
 * Runs last: it commits a rebind, which revokes every session and changes the
 * account's TOTP secret, so any test after it would need to re-authenticate.
 */
describe("TOTP rebind: commit (§3, ADR-004)", () => {
  it("migrates the DEK to the new key version and preserves the data", async () => {
    const originalDek = rawDek;

    const started = await authedRequest<{
      ok: true;
      data: { totpSecretBase32: string; keyVersion: number; state: string };
    }>("/security/totp/change/start", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-start") },
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const newSecret = started.body.data.totpSecretBase32;
    const newKeyVersion = started.body.data.keyVersion;
    expect(newKeyVersion).toBe(KEY_VERSION_INITIAL + 1);

    // The old secret remains the active one until the rebind commits.
    const duringRebind = await testEnv.DB.prepare(
      "SELECT rebind_state AS s FROM totp_config LIMIT 1",
    ).first<string>("s");
    expect(duringRebind).toBe("awaiting_verification");

    const verified = await authedRequest<{
      ok: true;
      data: { totpSecret: string; previousTotpSecret: string; keyVersion: number };
    }>("/security/totp/change/verify", jar, {
      method: "POST",
      body: { nonce: await nonce("totp-change-verify"), code: await totpFor(newSecret) },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.data.previousTotpSecret).toBe(account.totpSecret);

    // Unwrap with the OLD key and re-wrap under the NEW one. Note ciphertext is
    // never re-encrypted, which is exactly what ADR-004 approved.
    const recoveredFromOld = await unwrapDek(
      await kekFor(verified.body.data.previousTotpSecret),
      (await currentWrappedDek()).wrappedDek,
      { userId, keyVersion: KEY_VERSION_INITIAL },
    );
    expect(recoveredFromOld).toEqual(originalDek);

    const upload = await buildUpload(
      recoveredFromOld,
      newSecret,
      newKeyVersion,
      await nonce("totp-change-complete"),
    );
    const completed = await authedRequest<{
      ok: true;
      data: { keyVersion: number; revokedSessions: number; loggedOut: boolean };
    }>("/security/totp/change/complete", jar, { method: "POST", body: upload });

    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.data.keyVersion).toBe(newKeyVersion);
    expect(completed.body.data.loggedOut).toBe(true);

    // §3: every session is revoked, including the one that performed the rebind.
    const after = await apiRequest("/sessions", { cookie: jar.header });
    expect(after.status).toBe(401);

    // The account and every recovery code moved to the new key version.
    const accountVersion = await testEnv.DB.prepare(
      "SELECT key_version AS v FROM users LIMIT 1",
    ).first<number>("v");
    expect(accountVersion).toBe(newKeyVersion);
    const codeVersions = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM recovery_codes WHERE key_version = ?1",
    )
      .bind(newKeyVersion)
      .first<number>("c");
    expect(codeVersions).toBe(account.recoveryCodes.length);

    // The old secret no longer authenticates; the new one does.
    account = { ...account, totpSecret: newSecret };
    await clearTotpReplayGuard();
    const rejected = await login(
      { ...account, totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
      { ip: "203.0.113.251" },
    );
    expect(rejected.status).toBe(401);

    // The rejected attempt above armed the progressive backoff; let that window
    // elapse rather than waiting, the same way a user would simply retry later.
    await testEnv.DB.prepare("UPDATE users SET auth_backoff_until = NULL").run();
    await clearTotpReplayGuard();
    const relogin = await loginOnce(account, { ip: "203.0.113.252" });
    jar = relogin.jar;

    // Data preservation, claim one: the DEK is recoverable through the new KEK.
    const wrappedAfter = await currentWrappedDek();
    expect(wrappedAfter.keyVersion).toBe(newKeyVersion);
    const recoveredAfter = await unwrapDek(await kekFor(newSecret), wrappedAfter.wrappedDek, {
      userId,
      keyVersion: newKeyVersion,
    });
    expect(recoveredAfter).toEqual(originalDek);

    // Data preservation, claim two: a recovery code still recovers the same DEK,
    // which is the §32 acceptance criterion for the recovery path.
    const entry = account.recoveryCodes[2]!;
    const stored = await testEnv.DB.prepare(
      `SELECT wrapped_dek_iv AS iv, wrapped_dek_ciphertext AS ct,
              crypto_version AS cv, key_version AS kv
         FROM recovery_codes WHERE kdf_salt = ?1`,
    )
      .bind(entry.salt)
      .first<{ iv: string; ct: string; cv: number; kv: number }>();
    const recoveredViaCode = await unwrapDek(
      await deriveRecoveryKek(entry.code, entry.salt),
      {
        iv: stored!.iv,
        ciphertext: stored!.ct,
        crypto_version: stored!.cv,
        key_version: stored!.kv,
        alg: "AES-256-GCM",
      },
      { userId, keyVersion: newKeyVersion },
    );
    expect(recoveredViaCode).toEqual(originalDek);
  });
});
