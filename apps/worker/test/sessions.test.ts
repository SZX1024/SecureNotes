import {
  MAX_ACTIVE_SESSIONS,
  REMEMBER_DEVICE_MAX_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  type SessionListEntry,
  type TestAccount,
} from "./support";

/**
 * Session lifecycle and device management (§4), including the §31 items for
 * session hijacking, IDOR and revocation.
 */

let account: TestAccount;
let jar: CookieJar;
let sessionId: string;

beforeAll(async () => {
  account = await createAccount();
  const first = await loginOnce(account);
  jar = first.jar;
  sessionId = first.sessionId;
});

// Every test starts with a fresh rate-limit budget; counters otherwise
// accumulate for the whole file (storage is isolated per file, not per test).
beforeEach(resetRateLimits);

describe("session policy (§4)", () => {
  it("keeps the number of concurrent sessions at the cap", async () => {
    // Six logins in a row would trip the TOTP replay guard, so it is cleared
    // between attempts: the tests simulate logins from separate time windows.
    for (let index = 0; index < MAX_ACTIVE_SESSIONS + 1; index += 1) {
      await clearTotpReplayGuard();
      const result = await login(account, { ip: `203.0.113.${index + 1}` });
      expect(result.status, `login ${index + 1}`).toBe(200);
    }

    const active = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM sessions WHERE revoked_at IS NULL AND expires_at > ?1",
    )
      .bind(Date.now())
      .first<number>("c");

    expect(active).toBeLessThanOrEqual(MAX_ACTIVE_SESSIONS);
  });

  it("evicts the least recently active session and audits the eviction (ADR-005)", async () => {
    await clearTotpReplayGuard();
    const created = await loginOnce(account, { ip: "203.0.113.90" });
    expect(created.sessionId).toBeTruthy();

    const evictions = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM audit_logs WHERE event_type = 'session_evicted'",
    ).first<number>("c");

    // Crossing the cap above must have produced at least one eviction record.
    expect(evictions).toBeGreaterThan(0);

    // And no more than the cap is ever active.
    const active = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM sessions WHERE revoked_at IS NULL AND expires_at > ?1",
    )
      .bind(Date.now())
      .first<number>("c");
    expect(active).toBeLessThanOrEqual(MAX_ACTIVE_SESSIONS);
  });

  it("expires a session after 40 minutes of inactivity", async () => {
    await clearTotpReplayGuard();
    const stale = await loginOnce(account, { ip: "203.0.113.100" });

    // Backdate the sliding window instead of waiting 40 minutes.
    await testEnv.DB.prepare("UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1")
      .bind(stale.sessionId, Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000)
      .run();

    const response = await apiRequest("/sessions", { cookie: stale.jar.header });
    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("UNAUTHENTICATED");
  });

  it("keeps a session that was active within the window", async () => {
    await clearTotpReplayGuard();
    const fresh = await loginOnce(account, { ip: "203.0.113.101" });

    await testEnv.DB.prepare("UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1")
      .bind(fresh.sessionId, Date.now() - SESSION_IDLE_TIMEOUT_MS + 5 * 60 * 1000)
      .run();

    const response = await apiRequest("/sessions", { cookie: fresh.jar.header });
    expect(response.status).toBe(200);
  });

  it("caps a remembered device at 30 days absolutely", async () => {
    await clearTotpReplayGuard();
    const remembered = await loginOnce(account, { rememberDevice: true, ip: "203.0.113.102" });

    // Idle time is irrelevant here: the absolute cap must end the session.
    await testEnv.DB.prepare("UPDATE sessions SET created_at = ?2, last_seen_at = ?3 WHERE id = ?1")
      .bind(remembered.sessionId, Date.now() - REMEMBER_DEVICE_MAX_MS - 1000, Date.now())
      .run();

    const expired = await apiRequest("/sessions", { cookie: remembered.jar.header });
    expect(expired.status).toBe(401);

    // One minute inside the cap it is still usable.
    await testEnv.DB.prepare("UPDATE sessions SET created_at = ?2, last_seen_at = ?3 WHERE id = ?1")
      .bind(remembered.sessionId, Date.now() - REMEMBER_DEVICE_MAX_MS + 60_000, Date.now())
      .run();

    const stillValid = await apiRequest("/sessions", { cookie: remembered.jar.header });
    expect(stillValid.status).toBe(200);
  });

  it("gives a remembered device a 30-day cookie and a plain session a short one", async () => {
    await clearTotpReplayGuard();
    const remembered = await login(account, { rememberDevice: true, ip: "203.0.113.103" });
    const rememberedCookie =
      remembered.setCookies.find((entry) => entry.startsWith("session=")) ?? "";
    expect(rememberedCookie).toContain("Max-Age=2592000");

    await clearTotpReplayGuard();
    const plain = await login(account, { ip: "203.0.113.104" });
    const plainCookie = plain.setCookies.find((entry) => entry.startsWith("session=")) ?? "";
    // The idle window bounds the plain cookie; closing the browser ends it.
    expect(plainCookie).toContain("Max-Age=2400");
    expect(plainCookie).not.toContain("2592000");
  });

  it("never establishes a session without a valid second factor", async () => {
    // The only ways to obtain a session are a TOTP code or a recovery code.
    const withoutCode = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: account.username },
    });
    expect(withoutCode.status).toBe(400);
    expect(withoutCode.setCookies).toHaveLength(0);

    await clearTotpReplayGuard();
    const wrongCode = await login(account, { code: "000000" });
    expect(wrongCode.status).toBe(401);
    expect(wrongCode.setCookies).toHaveLength(0);
  });
});

describe("device list and revocation (§4)", () => {
  // The cap test above revokes the least recently active session, which can be
  // the one shared by this file, so this suite establishes its own.
  beforeAll(async () => {
    // `beforeAll` runs before the enclosing `beforeEach`, so the throttling
    // state left by the previous suite is cleared explicitly here.
    await resetRateLimits();
    const fresh = await loginOnce(account, { ip: "203.0.113.130" });
    jar = fresh.jar;
    sessionId = fresh.sessionId;
  });

  it("lists sessions with coarse client metadata only", async () => {
    const response = await apiRequest<{ ok: true; data: { sessions: SessionListEntry[] } }>(
      "/sessions",
      { cookie: jar.header },
    );

    expect(response.status).toBe(200);
    const sessions = response.body.data.sessions;
    expect(sessions.length).toBeGreaterThan(0);

    for (const entry of sessions) {
      // Never the raw User-Agent or a full IP address (§4).
      expect(entry.clientCategory ?? "").not.toMatch(/Mozilla|AppleWebKit/);
      expect(entry.ipTruncated ?? "").toMatch(/(\/24|\/48|^$)/);
    }
    expect(sessions.filter((entry) => entry.current)).toHaveLength(1);
  });

  it("renames a device", async () => {
    const response = await authedRequest("/sessions/" + sessionId, jar, {
      method: "PATCH",
      body: { deviceName: "Kitchen tablet" },
    });

    expect(response.status).toBe(200);
    const stored = await testEnv.DB.prepare("SELECT device_name AS n FROM sessions WHERE id = ?1")
      .bind(sessionId)
      .first<string>("n");
    expect(stored).toBe("Kitchen tablet");
  });

  it("refuses to touch a session that belongs to another account (IDOR)", async () => {
    // A second account row cannot be created through the API (single account),
    // so it is inserted directly to model another tenant's session.
    const otherUser = "00000000-0000-7000-8000-000000000999";
    const otherSession = "00000000-0000-7000-8000-000000000998";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at)
       VALUES (?1, 'another-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?5)`,
    )
      .bind(otherSession, otherUser, "f".repeat(64), Date.now(), Date.now() + 600_000)
      .run();

    const deleteResponse = await authedRequest("/sessions/" + otherSession, jar, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(404);

    const patchResponse = await authedRequest("/sessions/" + otherSession, jar, {
      method: "PATCH",
      body: { deviceName: "hijacked" },
    });
    expect(patchResponse.status).toBe(404);

    // The other tenant's session is untouched.
    const revokedAt = await testEnv.DB.prepare("SELECT revoked_at AS r FROM sessions WHERE id = ?1")
      .bind(otherSession)
      .first<number | null>("r");
    expect(revokedAt).toBeNull();
  });

  it("revokes an individual session and logs the user out when it is the current one", async () => {
    await clearTotpReplayGuard();
    const target = await loginOnce(account, { ip: "203.0.113.120" });

    const response = await authedRequest<{ ok: true; data: { loggedOut: boolean } }>(
      "/sessions/" + target.sessionId,
      target.jar,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.loggedOut).toBe(true);
    // The cookie is cleared (§4: revoking the current session logs you out).
    expect(response.setCookies.some((entry) => entry.startsWith("session=;"))).toBe(true);

    const after = await apiRequest("/sessions", { cookie: target.jar.header });
    expect(after.status).toBe(401);
  });

  it("revoke-all includes the current session", async () => {
    await clearTotpReplayGuard();
    const target = await loginOnce(account, { ip: "203.0.113.121" });

    const response = await authedRequest<{
      ok: true;
      data: { revoked: number; loggedOut: boolean };
    }>("/sessions/revoke-all", target.jar, { method: "POST", body: {} });

    expect(response.status).toBe(200);
    expect(response.body.data.loggedOut).toBe(true);
    expect(response.body.data.revoked).toBeGreaterThan(0);

    const after = await apiRequest("/sessions", { cookie: target.jar.header });
    expect(after.status).toBe(401);
  });

  it("rejects a malformed session id instead of touching rows", async () => {
    // The previous test revoked every session, so this one needs its own.
    const target = await loginOnce(account, { ip: "203.0.113.140" });

    const response = await authedRequest("/sessions/not-a-uuid", target.jar, { method: "DELETE" });
    expect(response.status).toBe(404);
  });
});
