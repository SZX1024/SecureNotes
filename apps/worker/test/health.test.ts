import { API_PREFIX, type HealthResponse } from "@securenotes/shared";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const HEALTH_URL = `https://example.com${API_PREFIX}/health`;

describe("GET /api/v1/health", () => {
  it("returns the shared success envelope", async () => {
    const response = await SELF.fetch(HEALTH_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    if (!body.ok) throw new Error("expected a success envelope");
    expect(body.data.status).toBe("ok");
    expect(body.data.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.data.environment).toBe("development");
  });

  it("exposes no account, key or binding information", async () => {
    const response = await SELF.fetch(HEALTH_URL);
    const text = await response.text();
    for (const forbidden of ["DB", "ATTACHMENTS", "database", "bucket", "secret", "key"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("rejects other methods with 405 instead of silently 404ing", async () => {
    const response = await SELF.fetch(HEALTH_URL, { method: "POST" });
    expect(response.status).toBe(405);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("unknown routes", () => {
  it("returns a JSON error for unknown API paths", async () => {
    const response = await SELF.fetch(`https://example.com${API_PREFIX}/does-not-exist`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body).toEqual({ ok: false, error: { code: "NOT_FOUND", message: expect.any(String) } });
  });

  it("returns a JSON error for non-API paths in P0", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
