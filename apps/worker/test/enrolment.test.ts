import { beforeAll, describe, expect, it } from "vitest";

import { apiRequest, cookieJarFrom, errorCode, testEnv } from "./support";

/**
 * Enrolment must be completable in one pass (§3).
 *
 * The bug this guards against is not cosmetic: enrolment is only finished once the
 * client has uploaded the wrapped DEK and the ten recovery wrappings, and that
 * upload is an authenticated operation. When `POST /auth/setup` returned no
 * session, the wizard died right there — after the account already existed — so a
 * user could end up with an account whose key material could never be stored and
 * whose one-time recovery codes were shown for nothing.
 *
 * This file has its own database (storage is isolated per test file), so the
 * account it creates is genuinely the first one.
 */

beforeAll(() => {
  // Nothing to prepare: the point is that enrolment starts from zero state.
});

describe("enrolment (§3)", () => {
  it("returns a session that can provision the key material", async () => {
    const setup = await apiRequest<{
      ok: true;
      data: {
        userId: string;
        totpSecret: string;
        totpUri: string;
        recoveryCodes: Array<{ code: string; salt: string }>;
        csrfToken: string;
        keyMaterialPresent: boolean;
      };
    }>("/auth/setup", { method: "POST", body: { username: "first-run" } });

    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.data.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.data.recoveryCodes).toHaveLength(10);
    expect(setup.body.data.keyMaterialPresent).toBe(false);

    const sessionCookie = setup.setCookies.find((entry) => entry.startsWith("session=")) ?? "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Strict");

    const jar = cookieJarFrom(setup.setCookies, setup.body.data.csrfToken);

    // The exact call that used to fail with 401 and break the wizard.
    const nonce = await apiRequest<{ ok: true; data: { nonce: string } }>(
      "/security/operation-nonce",
      {
        method: "POST",
        body: { operation: "key-material-upload" },
        cookie: jar.header,
        headers: { "x-csrf-token": jar.csrf },
      },
    );

    expect(nonce.status, JSON.stringify(nonce.body)).toBe(200);
    expect(nonce.body.data.nonce).toMatch(/^[A-Za-z0-9_-]+$/);

    // And the upload itself is authorised, not rejected for authentication.
    const upload = await apiRequest("/key-material", {
      method: "POST",
      body: {
        nonce: nonce.body.data.nonce,
        keyVersion: 1,
        wrappedDek: {
          crypto_version: 1,
          key_version: 1,
          alg: "AES-256-GCM",
          iv: "AAAAAAAAAAAAAAAA",
          ciphertext: "Zm9vYmFyYmF6cXV4",
        },
        recoveryWrappings: [],
      },
      cookie: jar.header,
      headers: { "x-csrf-token": jar.csrf },
    });

    // 401 would mean the regression is back; an empty wrapping set is merely
    // incomplete (400) because a partial recovery path is refused.
    expect(upload.status, JSON.stringify(upload.body)).not.toBe(401);
    expect([400, 412]).toContain(upload.status);
  });

  it("refuses a second enrolment", async () => {
    const again = await apiRequest("/auth/setup", { method: "POST", body: { username: "second" } });

    expect(again.status).toBe(412);
    expect(errorCode(again.body)).toBe("PRECONDITION_FAILED");
    // And it must not hand out a session for an account it did not create.
    expect(again.setCookies).toHaveLength(0);
  });

  it("audits the first session as created by enrolment", async () => {
    const rows = await testEnv.DB.prepare(
      "SELECT event_type AS t, detail_ciphertext AS d FROM audit_logs WHERE category = 'session' ORDER BY created_at",
    ).all<{ t: string; d: string | null }>();

    const created = rows.results.find((row) => row.t === "session_created");
    expect(created).toBeTruthy();
    // The detail is encrypted, so the reason must not be readable here — what is
    // asserted is that the event exists and was encrypted.
    expect(created!.d).not.toContain("enrolment");
  });
});
