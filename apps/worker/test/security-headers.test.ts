import { API_PREFIX, REQUEST_ID_HEADER } from "@securenotes/shared";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { Env } from "../src/env";

const HEALTH_URL = `https://example.com${API_PREFIX}/health`;

describe("baseline security headers", () => {
  it("is applied to API responses", async () => {
    const response = await SELF.fetch(HEALTH_URL);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  it("locks the API content security policy down to nothing", async () => {
    const response = await SELF.fetch(HEALTH_URL);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("sandbox");
    // The API must never be given a script-capable policy.
    expect(csp).not.toMatch(/script-src|unsafe-inline|unsafe-eval|'self'/);
  });

  it("marks API responses as non-cacheable", async () => {
    const response = await SELF.fetch(HEALTH_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("echoes a correlation id", async () => {
    const response = await SELF.fetch(HEALTH_URL);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("emits HSTS only in production", async () => {
    const app = createApp();
    app.get(`${API_PREFIX}/__headers`, (c) => c.json({ ok: true }));

    const devResponse = await app.fetch(new Request(`https://example.com${API_PREFIX}/__headers`), {
      ...env,
    } as Env);
    expect(devResponse.headers.get("strict-transport-security")).toBeNull();

    const prodResponse = await app.fetch(
      new Request(`https://example.com${API_PREFIX}/__headers`),
      productionEnv(),
    );
    expect(prodResponse.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

describe("error responses", () => {
  it("never leak diagnostics in production", async () => {
    const app = createApp();
    app.get(`${API_PREFIX}/__boom`, () => {
      throw new Error("simulated failure: cannot read note body");
    });

    const response = await app.fetch(
      new Request(`https://example.com${API_PREFIX}/__boom`),
      productionEnv(),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: expect.any(String) },
    });
    // No stack trace, no driver detail, no echoed message.
    expect(text).not.toContain("simulated failure");
    expect(text).not.toContain("note body");
    expect(text).not.toMatch(/at \w|\.ts:\d|\.js:\d/);
  });

  it("exposes diagnostics in development only", async () => {
    const app = createApp();
    app.get(`${API_PREFIX}/__boom`, () => {
      throw new Error("simulated failure");
    });

    const response = await app.fetch(new Request(`https://example.com${API_PREFIX}/__boom`), {
      ...env,
    } as Env);
    const body = (await response.json()) as { error: { code: string; diagnostic?: string } };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.diagnostic).toBe("simulated failure");
  });
});

function productionEnv(): Env {
  // Built explicitly rather than by spreading: binding objects carry their
  // behaviour on the prototype. Secrets come from the test pool's bindings.
  const testBindings = env as unknown as Env;
  return {
    ENVIRONMENT: "production",
    DB: testBindings.DB,
    ATTACHMENTS: testBindings.ATTACHMENTS,
    ASSETS: testBindings.ASSETS,
    ALLOWED_ORIGINS: "https://notes.example.com",
    SECRET_WRAP_KEY: testBindings.SECRET_WRAP_KEY,
    CSRF_SIGNING_KEY: testBindings.CSRF_SIGNING_KEY,
  };
}

describe("application shell policy (§13)", () => {
  it("allows the app's own script and never inline or eval", async () => {
    const { SHELL_CSP } = await import("../src/middleware/security-headers");

    expect(SHELL_CSP).toContain("script-src 'self'");
    // §13: CSP must never be weakened to permit arbitrary script execution.
    expect(SHELL_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(SHELL_CSP).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(SHELL_CSP).toContain("object-src 'none'");
    expect(SHELL_CSP).toContain("frame-ancestors 'none'");
    expect(SHELL_CSP).toContain("base-uri 'none'");
  });

  it("accommodates the features §12 requires", async () => {
    const { SHELL_CSP } = await import("../src/middleware/security-headers");

    // External HTTPS images and arbitrary HTTPS embeds are product requirements.
    expect(SHELL_CSP).toContain("img-src 'self' https: data:");
    expect(SHELL_CSP).toContain("frame-src https:");
    // KaTeX and Mermaid emit inline styles, which cannot execute script.
    expect(SHELL_CSP).toContain("style-src 'self' 'unsafe-inline'");
    // Same-origin only, so CORS stays disabled (§14).
    expect(SHELL_CSP).toContain("connect-src 'self'");
  });

  it("sends the shell policy for HTML and the API policy for the API", async () => {
    const { createApp } = await import("../src/app");
    const { SHELL_CSP } = await import("../src/middleware/security-headers");
    const app = createApp();

    // A route that returns HTML stands in for the asset binding, so this test does
    // not depend on whether the client has been built.
    app.get(
      "/shell-probe",
      () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    );

    const html = await app.fetch(new Request("https://example.com/shell-probe"), env as never);
    expect(html.headers.get("content-security-policy")).toBe(SHELL_CSP);

    const api = await SELF.fetch(HEALTH_URL);
    expect(api.headers.get("content-security-policy")).toContain("default-src 'none'");
    // The API policy is unchanged by this addition.
    expect(api.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  });

  it("does not apply the shell policy to JSON served outside /api", async () => {
    const { createApp } = await import("../src/app");
    const app = createApp();
    app.get(
      "/json-probe",
      () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );

    const response = await app.fetch(new Request("https://example.com/json-probe"), env as never);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});
