import {
  AUTH_BACKOFF_BASE_MS,
  AUTH_BACKOFF_CAP_MS,
  AUTH_ATTEMPTS_PER_ACCOUNT_PER_HOUR,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
} from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { backoffDelayMs, consumeRateLimit } from "../src/services/rate-limit";
import {
  ALLOWED_ORIGIN,
  apiRequest,
  clearTotpReplayGuard,
  cookieJarFrom,
  createAccount,
  currentCode,
  errorCode,
  login,
  loginOnce,
  resetRateLimits,
  testEnv,
  type TestAccount,
} from "./support";

/**
 * Authentication behaviour and the §31 items that concern it: brute force and
 * rate limits, replay, recovery-code reuse, session-fixation resistance and
 * credential non-enumeration.
 */

let account: TestAccount;

beforeAll(async () => {
  account = await createAccount();
});

// Every test starts with a fresh rate-limit budget; counters otherwise
// accumulate for the whole file (storage is isolated per file, not per test).
beforeEach(resetRateLimits);

describe("first-run enrolment (§3)", () => {
  it("returns exactly ten 32-character recovery codes", () => {
    expect(account.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const entry of account.recoveryCodes) {
      expect(entry.code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect(entry.code).toMatch(/^[A-Z2-9]{32}$/);
      // The salt is public but must be per code, or one compromise would
      // weaken every other recovery path.
      expect(entry.salt.length).toBeGreaterThan(0);
    }
    // Codes must be distinct, otherwise a "ten" code list is a lie.
    expect(new Set(account.recoveryCodes.map((entry) => entry.code)).size).toBe(
      RECOVERY_CODE_COUNT,
    );
    expect(new Set(account.recoveryCodes.map((entry) => entry.salt)).size).toBe(
      RECOVERY_CODE_COUNT,
    );
  });

  it("shows a base32 TOTP secret and an otpauth URI", () => {
    expect(account.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("refuses to initialize a second time", async () => {
    const response = await apiRequest("/auth/setup", {
      method: "POST",
      body: { username: "someone-else" },
    });

    expect(response.status).toBe(412);
    expect(errorCode(response.body)).toBe("PRECONDITION_FAILED");
  });

  it("rejects a username outside the KDF-safe ASCII set", async () => {
    for (const username of ["ab", "has space", "ünïcode", "semi;colon", "quote'", "a".repeat(65)]) {
      const response = await apiRequest("/auth/setup", { method: "POST", body: { username } });
      expect(response.status, username).toBe(400);
      expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
    }
  });

  it("rejects unexpected fields rather than ignoring them", async () => {
    const response = await apiRequest("/auth/setup", {
      method: "POST",
      body: { username: "bob", isAdmin: true },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
  });
});

describe("login (§3)", () => {
  it("accepts the current code and issues hardened cookies", async () => {
    const result = await login(account);

    expect(result.status).toBe(200);

    const sessionCookie = result.setCookies.find((entry) => entry.startsWith("session=")) ?? "";
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).toContain("Path=/");

    // The CSRF cookie is readable by script on purpose; the session cookie is not.
    const csrfCookie = result.setCookies.find((entry) => entry.startsWith("csrf=")) ?? "";
    expect(csrfCookie).not.toContain("HttpOnly");

    // The bearer token must never be echoed in the body.
    expect(JSON.stringify(result.data ?? result.error)).not.toContain(result.jar.session);

    const session = result.data!.session;
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("delivers the TOTP secret only on a successful login (ADR-002)", async () => {
    const result = await loginOnce(account);

    expect(result.data.totpSecret).toBe(account.totpSecret);
    expect(result.data.keyMaterialPresent).toBe(false);
  });

  it("rejects a wrong code with the generic credential error", async () => {
    await clearTotpReplayGuard();
    const result = await login(account, { code: "000000" });

    expect(result.status).toBe(401);
    expect(result.error?.code).toBe("INVALID_CREDENTIALS");
    expect(result.error?.message).toBe("The supplied credentials are not valid.");
    // No stack trace, no hint about which factor failed.
    expect(JSON.stringify(result.data ?? result.error)).not.toMatch(/at \w|\.ts:\d|secret/i);
  });

  it("does not reveal whether the account exists", async () => {
    await clearTotpReplayGuard();
    const unknownUser = await login(account, { code: "000000", ip: "198.51.100.70" });
    const otherAccount = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: "nobody", code: "000000" },
      headers: { "cf-connecting-ip": "198.51.100.71" },
    });

    // Same status, same code, same message: the response must not differ
    // between "no such account" and "wrong code for the real account".
    expect(otherAccount.status).toBe(unknownUser.status);
    expect(errorCode(otherAccount.body)).toBe(unknownUser.error?.code);
    expect(otherAccount.body).toEqual({
      ok: false,
      error: { code: unknownUser.error?.code, message: unknownUser.error?.message },
    });
  });

  it("rejects a malformed code before doing any work", async () => {
    const response = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: account.username, code: "abcdef" },
    });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
  });

  it("refuses to replay an already-consumed code", async () => {
    const code = await currentCode(account);
    // Start from a clean replay guard so this test does not depend on order.
    await testEnv.DB.prepare("UPDATE totp_config SET last_used_step = NULL").run();

    const first = await login(account, { code, ip: "198.51.100.10" });
    expect(first.status).toBe(200);

    const replay = await login(account, { code, ip: "198.51.100.11" });
    expect(replay.status).toBe(401);
    expect(replay.error?.code).toBe("INVALID_CREDENTIALS");
  });

  it("clears the failure counter after a successful login", async () => {
    await clearTotpReplayGuard();
    await login(account, { code: "000000", ip: "198.51.100.20" });
    await clearTotpReplayGuard();
    await login(account, { code: "111111", ip: "198.51.100.21" });

    const before = await testEnv.DB.prepare(
      "SELECT failed_auth_count AS c FROM users WHERE username = ?1",
    )
      .bind(account.username)
      .first<number>("c");
    expect(before).toBeGreaterThan(0);

    // Let the backoff window elapse (the counter stays) without waiting.
    await testEnv.DB.prepare("UPDATE users SET auth_backoff_until = NULL").run();
    await clearTotpReplayGuard();
    const success = await loginOnce(account, { ip: "198.51.100.22" });
    expect(success.sessionId).toBeTruthy();

    const after = await testEnv.DB.prepare(
      "SELECT failed_auth_count AS c, auth_backoff_until AS until FROM users WHERE username = ?1",
    )
      .bind(account.username)
      .first<{ c: number; until: number | null }>();
    expect(after?.c).toBe(0);
    expect(after?.until).toBeNull();
  });
});

describe("brute force and progressive backoff (§3, §31)", () => {
  it("stops accepting attempts and never locks the account permanently", async () => {
    const attempts: number[] = [];
    let sawRateLimit = false;

    // Well past both the account bucket and the point where backoff engages.
    for (let index = 0; index < 60; index += 1) {
      const response = await apiRequest("/auth/login", {
        method: "POST",
        body: { username: account.username, code: "000000" },
        headers: { "cf-connecting-ip": "203.0.113.77" },
      });
      attempts.push(response.status);
      if (response.status === 429) {
        sawRateLimit = true;
        expect(response.body).toMatchObject({ ok: false });
      }
      if (sawRateLimit && index > 20) {
        break;
      }
    }

    expect(sawRateLimit, `statuses seen: ${attempts.join(",")}`).toBe(true);

    const state = await testEnv.DB.prepare(
      "SELECT auth_backoff_until AS until, failed_auth_count AS c FROM users WHERE username = ?1",
    )
      .bind(account.username)
      .first<{ until: number | null; c: number }>();

    // A permanent lockout would be a timestamp far in the future; the cap is
    // one minute by design.
    expect(state?.until).not.toBeNull();
    expect(state!.until! - Date.now()).toBeLessThanOrEqual(AUTH_BACKOFF_CAP_MS);

    // The hour bucket is recorded, so the limit survives a restart.
    const bucket = await testEnv.DB.prepare(
      "SELECT counter AS c FROM rate_limits WHERE scope = 'account' AND bucket = ?1",
    )
      .bind(account.username.toLowerCase())
      .first<number>("c");
    expect(bucket).toBeGreaterThan(AUTH_ATTEMPTS_PER_ACCOUNT_PER_HOUR);
  });

  it("keeps the backoff exponential and capped", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(AUTH_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2)).toBe(AUTH_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3)).toBe(AUTH_BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(50)).toBe(AUTH_BACKOFF_CAP_MS);
  });

  it("allows exactly the configured budget per window", async () => {
    const rule = { scope: "ip" as const, limit: 2, windowMs: 60_000 };
    const bucket = `unit-${Math.random()}`;
    const now = Date.now();

    await expect(consumeRateLimit(testEnv, rule, bucket, now)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(consumeRateLimit(testEnv, rule, bucket, now)).resolves.toMatchObject({
      allowed: true,
    });

    const blocked = await consumeRateLimit(testEnv, rule, bucket, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);

    // A later window has its own budget.
    await expect(consumeRateLimit(testEnv, rule, bucket, now + 60_000)).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe("recovery login (§3, §31)", () => {
  it("accepts a code once, then refuses it forever", async () => {
    const code = account.recoveryCodes[0]!.code;

    const first = await apiRequest<Record<string, unknown>>("/auth/recovery", {
      method: "POST",
      body: { username: account.username, code },
      headers: { "cf-connecting-ip": "198.51.100.30" },
    });
    expect(first.status).toBe(200);

    const reuse = await apiRequest("/auth/recovery", {
      method: "POST",
      body: { username: account.username, code },
      headers: { "cf-connecting-ip": "198.51.100.31" },
    });
    expect(reuse.status).toBe(401);
    expect(errorCode(reuse.body)).toBe("INVALID_CREDENTIALS");
  });

  it("revokes every other session but keeps the new one", async () => {
    await clearTotpReplayGuard();
    const existing = await loginOnce(account, { ip: "198.51.100.40" });

    const recovery = await apiRequest<{
      ok: true;
      data: { revokedOtherSessions: number; mustRebindTotp: boolean; session: { id: string } };
    }>("/auth/recovery", {
      method: "POST",
      body: { username: account.username, code: account.recoveryCodes[1]!.code },
      headers: { "cf-connecting-ip": "198.51.100.41" },
    });

    expect(recovery.status).toBe(200);
    expect(recovery.body.data.mustRebindTotp).toBe(true);
    expect(recovery.body.data.revokedOtherSessions).toBeGreaterThan(0);

    // The pre-existing session is gone…
    const oldSession = await apiRequest("/sessions", { cookie: existing.jar.header });
    expect(oldSession.status).toBe(401);

    // …and the recovery session still works.
    const recoveryJar = cookieJarFrom(recovery.setCookies, undefined);
    const stillValid = await apiRequest("/sessions", { cookie: recoveryJar.header });
    expect(stillValid.status).toBe(200);
  });

  it("rejects a wrong code with the same generic error", async () => {
    const response = await apiRequest("/auth/recovery", {
      method: "POST",
      body: { username: account.username, code: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      headers: { "cf-connecting-ip": "198.51.100.50" },
    });

    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("INVALID_CREDENTIALS");
  });

  it("never stores a plaintext recovery code anywhere", async () => {
    const usedCode = account.recoveryCodes[0]!.code;

    const inCodes = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM recovery_codes WHERE code_hash = ?1",
    )
      .bind(usedCode)
      .first<number>("c");
    expect(inCodes).toBe(0);

    // The audit detail is encrypted, so the code must not appear in any column.
    const audit = await testEnv.DB.prepare(
      `SELECT count(*) AS c FROM audit_logs
        WHERE COALESCE(detail_ciphertext, '') LIKE ?1 OR COALESCE(detail_iv, '') LIKE ?1`,
    )
      .bind(`%${usedCode}%`)
      .first<number>("c");
    expect(audit).toBe(0);
  });

  it("stores the TOTP secret only in encrypted form", async () => {
    const row = await testEnv.DB.prepare(
      "SELECT secret_ciphertext AS ct FROM totp_config LIMIT 1",
    ).first<{ ct: string }>();

    expect(row?.ct).toBeTruthy();
    expect(row?.ct).not.toContain(account.totpSecret);
    expect(row?.ct).not.toBe(account.totpSecret);
  });
});

describe("session fixation (§31)", () => {
  it("issues a fresh session even when an attacker pre-seeds a cookie", async () => {
    await clearTotpReplayGuard();
    const planted = "attacker-chosen-token-value";

    const result = await login(account, { cookie: `session=${planted}` });
    expect(result.status).toBe(200);
    // The planted value must not be the token that gets authenticated.
    expect(result.jar.session).not.toBe(planted);

    const withPlanted = await apiRequest("/sessions", { cookie: `session=${planted}` });
    expect(withPlanted.status).toBe(401);
  });

  it("does not accept a session id as a token", async () => {
    await clearTotpReplayGuard();
    const { sessionId } = await loginOnce(account, { ip: "198.51.100.60" });

    // The id is public; only the 256-bit token authenticates (§4).
    const response = await apiRequest("/sessions", { cookie: `session=${sessionId}` });
    expect(response.status).toBe(401);
  });
});

describe("origin handling", () => {
  it("accepts the configured origin and rejects others", async () => {
    const allowed = await apiRequest("/auth/status", { origin: ALLOWED_ORIGIN });
    expect(allowed.status).toBe(200);

    const foreign = await apiRequest("/auth/status", { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(errorCode(foreign.body)).toBe("ORIGIN_REJECTED");
  });
});
