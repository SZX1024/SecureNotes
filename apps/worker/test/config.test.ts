import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { findConfigProblem } from "../src/lib/config";
import { ALLOWED_ORIGIN, apiUrl, testEnv } from "./support";
import type { Env } from "../src/env";

/**
 * Misconfiguration handling.
 *
 * Secrets are injected out of band, so a deployment can be missing one without
 * failing to build. The requirement is that the first request produces a
 * precise, actionable error instead of an incomprehensible crash inside a
 * crypto call.
 */

function envWith(overrides: Partial<Env>): Env {
  return { ...testEnv, ...overrides };
}

describe("configuration validation", () => {
  it("accepts the configured test environment", () => {
    expect(findConfigProblem(testEnv)).toBeNull();
  });

  it("names the missing secret", () => {
    expect(findConfigProblem(envWith({ SECRET_WRAP_KEY: "" }))).toBe(
      "SECRET_WRAP_KEY is not configured",
    );
    expect(findConfigProblem(envWith({ CSRF_SIGNING_KEY: "" }))).toBe(
      "CSRF_SIGNING_KEY is not configured",
    );
    expect(findConfigProblem(envWith({ ALLOWED_ORIGINS: "" }))).toBe(
      "ALLOWED_ORIGINS is not configured",
    );
  });

  it("rejects a secret of the wrong length or encoding", () => {
    expect(findConfigProblem(envWith({ SECRET_WRAP_KEY: "AAAA" }))).toContain("32 bytes");
    expect(findConfigProblem(envWith({ CSRF_SIGNING_KEY: "not base64!!" }))).toContain(
      "not valid base64",
    );
  });

  it("fails the request with a diagnostic instead of crashing", async () => {
    const app = createApp();

    const response = await app.fetch(
      new Request(apiUrl("/auth/status"), { headers: { origin: ALLOWED_ORIGIN } }),
      envWith({ SECRET_WRAP_KEY: "" }),
    );
    const body = (await response.json()) as { error: { code: string; diagnostic?: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    // Development only, and it names the binding rather than leaking a value.
    expect(body.error.diagnostic).toContain("SECRET_WRAP_KEY");
  });

  it("never exposes a secret value in the diagnostic", async () => {
    const app = createApp();
    const secret = "c2hvcnQ=";

    const response = await app.fetch(
      new Request(apiUrl("/auth/status"), { headers: { origin: ALLOWED_ORIGIN } }),
      envWith({ SECRET_WRAP_KEY: secret }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(secret);
  });
});
