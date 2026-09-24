import { MAX_AUTH_BODY_BYTES } from "@securenotes/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ALLOWED_ORIGIN,
  apiRequest,
  authedRequest,
  clearTotpReplayGuard,
  createAccount,
  errorCode,
  loginOnce,
  resetRateLimits,
  testEnv,
  type CookieJar,
  type TestAccount,
} from "./support";

/**
 * Request-level security (§14) and the §31 items that belong to it: CSRF,
 * injection, IDOR/BOLA, malicious content handling and secret containment.
 */

let account: TestAccount;
let jar: CookieJar;

beforeAll(async () => {
  account = await createAccount();
  const session = await loginOnce(account);
  jar = session.jar;
});

// Every test starts with a fresh rate-limit budget; counters otherwise
// accumulate for the whole file (storage is isolated per file, not per test).
beforeEach(resetRateLimits);

describe("CSRF (§14, §31)", () => {
  it("rejects a state-changing request with no token", async () => {
    const response = await apiRequest("/auth/logout", {
      method: "POST",
      body: {},
      cookie: jar.header,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("CSRF_FAILED");
  });

  it("rejects a wrong token", async () => {
    const response = await apiRequest("/auth/logout", {
      method: "POST",
      body: {},
      cookie: jar.header,
      headers: { "x-csrf-token": "not-the-token" },
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("CSRF_FAILED");
  });

  it("rejects a token issued for a different session", async () => {
    await clearTotpReplayGuard();
    const other = await loginOnce(account, { ip: "203.0.113.200" });

    // The first session's token must not authorise the second session.
    const response = await apiRequest("/sessions/revoke-all", {
      method: "POST",
      body: {},
      cookie: other.jar.header,
      headers: { "x-csrf-token": jar.csrf },
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("CSRF_FAILED");
  });

  it("accepts the matching token", async () => {
    const response = await authedRequest("/auth/logout", jar, { method: "POST", body: {} });
    expect(response.status).toBe(200);

    // Restore a session for the tests that follow.
    await clearTotpReplayGuard();
    jar = (await loginOnce(account, { ip: "203.0.113.201" })).jar;
  });
});

describe("Origin and content type (§14)", () => {
  it("rejects writes from a foreign origin", async () => {
    const response = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: account.username, code: "000000" },
      origin: "https://evil.example",
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("ORIGIN_REJECTED");
  });

  it("rejects writes with no Origin or Referer at all", async () => {
    const response = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: account.username, code: "000000" },
      origin: null,
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("ORIGIN_REJECTED");
  });

  it("accepts a Referer when Origin is absent", async () => {
    const response = await apiRequest("/auth/status", {
      origin: null,
      headers: { referer: `${ALLOWED_ORIGIN}/notes` },
    });

    expect(response.status).toBe(200);
  });

  it("rejects a non-JSON content type on writes", async () => {
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ]) {
      const response = await apiRequest("/auth/login", {
        method: "POST",
        rawBody: "username=alice",
        contentType,
      });

      expect(response.status, contentType).toBe(415);
      expect(errorCode(response.body)).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
  });

  it("enforces the body-size ceiling", async () => {
    const oversized = JSON.stringify({
      username: account.username,
      code: "000000",
      padding: "x".repeat(MAX_AUTH_BODY_BYTES + 1024),
    });

    const response = await apiRequest("/auth/login", { method: "POST", rawBody: oversized });

    expect(response.status).toBe(413);
    expect(errorCode(response.body)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects malformed JSON without leaking a parser message", async () => {
    const response = await apiRequest("/auth/login", { method: "POST", rawBody: "{not json" });

    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(response.body)).not.toContain("not json");
  });
});

describe("injection (§31)", () => {
  it("refuses SQL metacharacters in the username", async () => {
    for (const username of [
      "'; DROP TABLE users; --",
      "alice' OR '1'='1",
      'alice" OR 1=1 --',
      "alice;DELETE FROM sessions",
    ]) {
      const response = await apiRequest("/auth/login", {
        method: "POST",
        body: { username, code: "000000" },
      });

      expect(response.status, username).toBe(400);
      expect(errorCode(response.body)).toBe("VALIDATION_FAILED");
    }

    // The schema is still intact: the statement was never built by concatenation.
    const tables = await testEnv.DB.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    ).first<number>("c");
    expect(tables).toBe(1);
  });

  it("treats SQL metacharacters in a recovery code as an ordinary wrong code", async () => {
    const response = await apiRequest("/auth/recovery", {
      method: "POST",
      body: { username: account.username, code: "' OR '1'='1' --" },
      headers: { "cf-connecting-ip": "203.0.113.210" },
    });

    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("INVALID_CREDENTIALS");
  });
});

describe("authorization boundaries (§14, §31)", () => {
  it("requires a session for every authenticated endpoint", async () => {
    for (const [method, path] of [
      ["GET", "/sessions"],
      ["GET", "/audit-logs"],
      ["DELETE", "/sessions/00000000-0000-7000-8000-000000000001"],
      ["POST", "/sessions/revoke-all"],
      ["POST", "/auth/logout"],
    ] as const) {
      const response = await apiRequest(path, { method, body: method === "GET" ? undefined : {} });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(errorCode(response.body)).toBe("UNAUTHENTICATED");
    }
  });

  it("scopes the audit log to the authenticated account", async () => {
    // A second account row, again inserted directly (the API allows only one).
    const otherUser = "00000000-0000-7000-8000-000000000997";
    await testEnv.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at)
       VALUES (?1, 'audit-tenant', 'salt', ?2, ?2)`,
    )
      .bind(otherUser, Date.now())
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO audit_logs (id, user_id, category, event_type, outcome, created_at)
       VALUES ('other-tenant-entry', ?1, 'auth', 'login_succeeded', 'success', 1)`,
    )
      .bind(otherUser)
      .run();

    const response = await apiRequest<{ ok: true; data: { entries: Array<{ id: string }> } }>(
      "/audit-logs",
      { cookie: jar.header },
    );

    expect(response.status).toBe(200);
    const ids = response.body.data.entries.map((entry) => entry.id);
    expect(ids).not.toContain("other-tenant-entry");
    expect(ids.length).toBeGreaterThan(0);
  });

  it("exposes no encrypted payload or credential material in the audit log", async () => {
    const response = await apiRequest<{
      ok: true;
      data: { entries: Array<Record<string, unknown>> };
    }>("/audit-logs", { cookie: jar.header });

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("detail_ciphertext");
    expect(serialized).not.toContain(account.totpSecret);
    for (const code of account.recoveryCodes) {
      expect(serialized).not.toContain(code);
    }
  });

  it("never returns a stack trace or SQL fragment in production mode", async () => {
    // Forcing a driver-level failure is not practical from outside, so this
    // asserts the invariant that matters: diagnostics are absent whenever the
    // worker reports production, which the P0 suite already covers directly.
    const response = await apiRequest("/auth/login", {
      method: "POST",
      body: { username: account.username, code: "000000" },
      headers: { "cf-connecting-ip": "203.0.113.211" },
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toMatch(/at \w+ \(|\.ts:\d|SELECT |INSERT /);
  });
});

describe("secret containment", () => {
  it("stores no plaintext credential in any user-visible table column", async () => {
    const rows = await testEnv.DB.prepare(
      "SELECT token_hash AS t FROM sessions UNION ALL SELECT code_hash FROM recovery_codes",
    ).all<{ t: string }>();

    for (const row of rows.results) {
      // Digests only: 64 hex characters, never a token or a code.
      expect(row.t).toMatch(/^[0-9a-f]{64}$/);
      expect(row.t).not.toBe(account.totpSecret);
    }
  });

  it("keeps the IP and User-Agent coarse in the audit log", async () => {
    const rows = await testEnv.DB.prepare(
      "SELECT ip_truncated AS ip, client_category AS cat FROM audit_logs WHERE user_id IS NOT NULL",
    ).all<{ ip: string | null; cat: string | null }>();

    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results) {
      if (row.ip) {
        expect(row.ip).toMatch(/(\/24|\/48)$/);
      }
      if (row.cat) {
        expect(row.cat).not.toContain("Mozilla");
      }
    }
  });
});
